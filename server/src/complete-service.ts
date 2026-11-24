import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, relative, sep } from 'node:path'
import type { AgentRegistry } from './agent-registry.js'
import type { Agent } from './types.js'
import type { SessionIndex } from './session-index.js'
import { installedPlugins, pluginResolver } from './plugin-enablement.js'
import { sameFolder } from './folder-identity.js'
import { fallbackHarness, findHarness } from './harnesses/registry.js'
import type { LoadsSkillAsk, LoadsSkillLine, LoadsSkillPlaces, LoadsSkills } from './harnesses/contract.js'

// a folder's subdirectories, sorted — a symlink counts (the engine loads a
// linked skill directory; the caller checks what is inside); a missing or
// unreadable one is none
function listDirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() || d.isSymbolicLink())
      .map((d) => d.name)
      .sort()
  } catch {
    return []
  }
}

// Where a skill's SKILL.md lives — the same three places Claude Code loads
// skills from: the agent's own folder (<folder>/.claude/skills), the user's
// ~/.claude/skills, and every ENABLED plugin (named `<plugin>:<skill>`).
// A name with no SKILL.md anywhere (a built-in, or one only seen in a
// transcript / declared on an agent) carries no source.
// 'silos': one of Silos' own plugin skills (plugin/skills) not loaded here —
// the only thing the add route can copy into a folder.
// 'account': sent by a Claude account the folder's conversations run on
// (Harness.loads.skills — the engine's batches per login).
export type SkillSource = 'project' | 'user' | 'plugin' | 'silos' | 'account'

// The three states of a (skill, folder) — see skill-states.ts — plus what is
// merely known. The folder is the enforcement unit:
//   active    — the folder loads it (its own copy, a shadowed one whose
//               personal twin loads instead, a personal skill, an enabled
//               plugin's, or a root the engine is handed at launch);
//   held      — moved to Silos' held store, the engine no longer sees it;
//               or a personal skill the folder's local settings turn off;
//   available — what "Add" can do: one of Silos' plugin skills the folder
//               neither loads nor holds (source 'silos'); or a skill the
//               Claude account sends that this project has not added
//               (source 'account': its origin or its own position off —
//               added with its position, never copied);
//   seen      — known only by name or from somewhere this folder doesn't
//               load (`seen` says where); listed for what it is, never
//               offered as addable.
export type SkillState = 'active' | 'held' | 'available' | 'seen'

/** where a 'seen' skill was found: another agent's folder, an installed
 *  Claude Code plugin that isn't enabled here, or nowhere on disk (a name
 *  from a transcript or an agent's declaration, or a built-in) */
export type SkillSeen = 'other-folder' | 'plugin-off' | 'name-only'

export interface SkillCatalogEntry {
  name: string
  description?: string
  source?: SkillSource
  /** the agent's folder has its own copy too, which never loads: Claude
   *  Code runs the personal one (~/.claude/skills) instead */
  shadowed?: string
  state?: SkillState
  /** a plugin skill: the plugin that brings it (`<plugin>@<marketplace>`).
   *  Its state is the plugin's in this folder — the plugin, not the skill,
   *  is what turns on and off (the project's Tools piece). */
  plugin?: string
  /** state 'seen' only: where it was found */
  seen?: SkillSeen
  /** state 'held' only: the operator's personal copy of the same name
   *  (~/.claude/skills) still loads in this agent's engine — the folder copy
   *  is off, the NAME is not (Silos never turns a personal skill off:
   *  on OpenCode the launch doesn't deny such a name either) */
  stillLoads?: 'personal'
  /** a FOLDER's catalog in a mixed folder only: one plain sentence per other
   *  engine that starts there and sees this row differently («OpenCode
   *  agents here load it from Silos at launch») — the row itself is the
   *  folder copy's truth (what Claude Code loads), never averaged */
  engines?: string[]
  /** source 'account': the login whose account sends it — null when Silos
   *  can't say which; `unmatched` for a batch no recorded start matches */
  account?: { login: string | null; unmatched?: true }
  /** an account or personal skill: the position a settings layer gives it
   *  in this folder, as found — absent = on. `name-only` lists it without
   *  its description; any other value (`user-invocable-only`…) is shown
   *  and kept */
  position?: string
  /** the three positions (on · name only · off) can be written here — the
   *  folder's local file decides it */
  switches?: true
  /** what decides it instead: a file other than the folder's local one
   *  (named, no switch), or a home folder (the engine's own config) */
  decidedBy?: { file: string; key: string } | 'home'
  /** a personal skill and an account skill share this name: one position
   *  reaches both */
  sameName?: true
  /** source 'account': whether this project loads what the account sends —
   *  the origin's head; `switches` when the folder's local file decides */
  origin?: { on: boolean; switches?: true; decidedBy?: { file: string; key: string } | 'home' }
  /** «Where it loads» (spec scopes T9): one line per place — machine,
   *  project, each agent of the folder — from the engine (HarnessLoads.
   *  skillPlaces); absent where the engine declares none */
  at?: LoadsSkillLine[]
}

/** What an agent's engine reads of the skills its Claude account sends and
 *  the folder's positions (Harness.loads.skills), and whether it switches
 *  them — null for an engine without (index.ts binds it). */
export type AccountSkillsOf = (agent: Agent) => { skills: LoadsSkills; switches: boolean } | null
/** What the agent's engine answers of each skill's places in its folder
 *  (Harness.loads.skillPlaces, folder-loads.ts) — null: none. */
export type SkillPlacesOf = (agent: Agent, asks: LoadsSkillAsk[], conversation?: SkillsConversation) => LoadsSkillPlaces[] | null
/** ONE conversation asked about (its column): the thread the server
 *  resolved, its agent and the thread's sessions — its line is added */
export interface SkillsConversation {
  thread: string
  agent: string | null
  sessions: string[]
}

/** What the new-agent picker may offer (GET /api/silos-skills?folder=…):
 *  exactly what the add route will accept for that agent, and the plain
 *  reason for each Silos skill it won't. */
export interface SilosSkillOffer {
  skills: { name: string; description?: string }[]
  notOffered: { name: string; why: string }[]
}

/** Why `name` can't be added — the add route's refusal and the picker's
 *  "not offered" line, from the catalog entry (one rule, two readers).
 *  null: the entry IS available. */
export function notAddableWhy(name: string, entry: SkillCatalogEntry | undefined): string | null {
  if (entry?.state === 'available' && entry.source === 'account')
    return `"${name}" comes from your Claude account — turn it on with its position in the project's Skills; nothing is copied`
  if (entry?.state === 'available') return null
  if (entry?.state === 'held') return `"${name}" is turned off in this folder — turn it on instead of adding another copy`
  if (entry?.state === 'active') {
    if (entry.source === 'user') return `"${name}" is a personal skill (~/.claude/skills) — it already applies everywhere, there is nothing to add`
    if (entry.source === 'plugin' && entry.plugin === 'silos')
      return `"${name}" already loads — this agent's engine is handed Silos' skills at every launch, there is nothing to add`
    return `"${name}" already loads in this folder — there is nothing to add`
  }
  return `"${name}" is not one of Silos' plugin skills — only those can be copied into a folder${entry?.seen === 'other-folder' ? ' (this one lives in another agent’s folder)' : entry?.seen === 'plugin-off' ? ' (this one comes with a Claude Code plugin — turn the plugin on in the project’s Tools)' : ''}`
}

/** Why a folder copy can't be turned off — null when it can. A copy whose
 *  personal twin loads in the agent's engine changes nothing when held: on
 *  Claude Code the personal one already runs instead (shadowed); on
 *  OpenCode a hold works by denying the NAME, which would turn the
 *  operator's personal skill off too — and Silos never does that.
 *  Refused with those words instead of a gesture that changes nothing. */
export function notHoldableWhy(name: string, entry: SkillCatalogEntry | undefined): string | null {
  if (entry?.state === 'active' && entry.source === 'user' && entry.shadowed !== undefined) {
    return `"${name}" also exists as your personal skill (~/.claude/skills), which loads in every folder — turning off this folder's copy would change nothing, and Silos never turns a personal skill off`
  }
  return null
}

// Skills dimension (detail page) — full readme of a skill, read from its
// own SKILL.md wherever it lives (see locate()). Distinct from
// skillsCatalog() below (description only, for the list) — this one brings
// the body.
export interface SkillReadme {
  name: string
  description?: string
  body: string
}

// foreign: found in ANOTHER agent's folder — it lends its description,
// but this agent can't load it from there (no source on the entry).
// personal: whether the engine loads the operator's ~/.claude/skills
// (absent = yes: Claude Code always; OpenCode unless its own env switches
// say otherwise — harnesses/opencode).
export interface SkillLoad {
  claudePlugins: boolean
  personal?: boolean
  roots?: readonly { plugin: string; dir: string }[]
}

interface Located {
  file: string
  root: string
  source: SkillSource
  foreign?: true
  shadowed?: string
  plugin?: string
}

const IGNORE = new Set(['node_modules', '.git', 'dist', 'build', '.venv', '__pycache__', '.next', 'coverage'])
const MAX_VISITED = 5000
const MAX_DEPTH = 6
const TOP = 20 // autocomplete only — the catalog is never capped
const TTL_MS = 30_000

// The frontmatter of a SKILL.md, split from its body. Cheap parsing (same
// pattern as MemoryService.parseFrontmatter), no YAML dependency: only
// `description`, single-line or a `|`/`>` block of indented lines.
export function parseSkillMd(raw: string): { description?: string; body: string; hasFrontmatter: boolean } {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/)
  if (!m) return { body: raw.trim(), hasFrontmatter: false }
  const lines = m[1]!.split(/\r?\n/)
  let description: string | undefined
  for (let i = 0; i < lines.length; i++) {
    const kv = lines[i]!.match(/^description:\s*(.*)$/)
    if (!kv) continue
    let v = (kv[1] ?? '').trim()
    if (v === '' || /^[|>][-+]?$/.test(v)) {
      const block: string[] = []
      for (let j = i + 1; j < lines.length && /^\s+\S/.test(lines[j]!); j++) block.push(lines[j]!.trim())
      v = block.join(' ')
    }
    description = v.replace(/^["']|["']$/g, '') || undefined
    break
  }
  const out: { description?: string; body: string; hasFrontmatter: boolean } = { body: raw.slice(m[0].length).trim(), hasFrontmatter: true }
  if (description !== undefined) out.description = description
  return out
}

export class CompleteService {
  private cache = new Map<string, { at: number; list: string[] }>()
  constructor(
    private registry: AgentRegistry,
    private index: SessionIndex,
    // Production ALWAYS passes join(cfg.home, '.claude', 'skills') from index.ts
    // — the homedir() default is only a last resort for direct unit construction.
    // Never let the E2E-spawned server fall back to it: SILOS_HOME must reach
    // here so the harness reads its fixture home, not the machine's ~/.claude.
    // Its parent is the `.claude` dir the plugins are read from too.
    private skillsDir = join(homedir(), '.claude', 'skills'),
    // The held store's lister (skill-states.ts heldSkills, bound to the
    // dataDir in index.ts) — injected so this service stays store-agnostic.
    // Absent (direct unit construction): no held entries, states only.
    private held?: (folder: string) => { name: string; description?: string }[],
    // What the agent's ENGINE loads besides folder + personal copies
    // (Harness.traits.skillLoad, resolved in index.ts) — absent (direct unit
    // construction): the machine's Claude plugins, the long-standing shape.
    private skillLoad?: (agent: Agent) => SkillLoad,
    // Silos' own plugin skills (plugin/skills) — the ONLY source the add
    // route copies from (skill-states.ts addSkill), so the only source of
    // 'available'. Absent: nothing is addable.
    private silosSkillsDir?: string,
    // Claude Code's managed-settings directory (plugin-enablement.ts) — a
    // managed enabledPlugins entry wins over every other file. Absent: no
    // managed layer.
    private managedDir?: string,
    // What the agent's engine reads of its Claude account's skills and the
    // folder's positions (Harness.loads.skills). Absent: no account rows,
    // no positions.
    private accountSkills?: AccountSkillsOf,
    // each skill's «Where it loads» (Harness.loads.skillPlaces). Absent: no lines.
    private skillPlaces?: SkillPlacesOf,
  ) {}

  async files(agentId: string, q: string): Promise<string[]> {
    const agent = this.registry.get(agentId)
    if (!agent) throw new Error('agent not found')
    if (agent.folder === null) return []
    const all = await this.listFolder(agent.folder)
    const qq = q.toLowerCase()
    const hits = qq === '' ? all : all.filter((p) => p.toLowerCase().includes(qq))
    const score = (p: string): number => {
      const base = p.split('/').pop()!.toLowerCase()
      return (base.startsWith(qq) && qq !== '' ? 0 : 1) * 1_000_000 + p.length
    }
    return hits.sort((a, b) => score(a) - score(b)).slice(0, TOP)
  }

  // Autocomplete (`/` in the composer) — the same universe as the catalog
  // (visibleSkills), names only, filtered and capped at TOP.
  async skills(agentId: string, q: string): Promise<string[]> {
    const agent = this.registry.get(agentId)
    if (!agent) throw new Error('agent not found')
    const qq = q.toLowerCase()
    return [...(await this.visibleSkills(agent)).keys()]
      .filter((s) => s.toLowerCase().includes(qq))
      .sort()
      .slice(0, TOP)
  }

  // Skills catalog FOR DISPLAY (agent page, Settings › Skills) — EVERY skill
  // visible to the agent, never capped (the autocomplete's cap of 20 once
  // cut it at `schedule`), each with the description from its own
  // SKILL.md's frontmatter wherever it lives (project, user, plugin).
  // Each entry carries its state for the agent's primary folder (the unit
  // the engine respects — skill-states.ts): the folder's own copies are
  // 'active' (a shadowed one still loads, as the personal copy), and so are
  // the operator's personal skills (~/.claude/skills) — the engine loads
  // them in EVERY folder, so calling them anything else would be decorative
  // (they're just never Silos' to move). The folder's HELD copies (moved to
  // Silos' held store, invisible to the engine) are appended as 'held'.
  // 'available' is exactly what the add route can do: Silos' plugin skills
  // the folder neither loads nor holds. Everything else known (a transcript
  // name, another folder's copy, a disabled plugin's skill) is 'seen', with
  // where — listed for what it is, never addable.
  async skillsCatalog(agentId: string, conversation?: SkillsConversation): Promise<SkillCatalogEntry[]> {
    const agent = this.registry.get(agentId)
    if (!agent) throw new Error('agent not found')
    return this.catalogFor(agent, conversation)
  }

  // A FOLDER's catalog (the project page — the project is the
  // house of its skills): the same rule as an agent's, asked about the
  // folder itself, never through an agent whose primary folder is
  // elsewhere. The caller has already checked the folder is managed
  // (managed-folder.ts).
  //
  // Which engine's truth (fourth review round): what loads differs per
  // engine — OpenCode is handed Silos' skills at every launch, Claude Code
  // loads only the folder's copies — and the page's gestures (add, hold)
  // act on the FOLDER COPIES. So the rows are the truth of the engine that
  // reads those copies: the fallback engine (Claude Code) whenever one of
  // its agents starts here, or nobody does (the default every new agent
  // gets); a folder whose starters all run another engine is that engine's.
  // Never «the first agent in registry order» — that made an OpenCode agent
  // listed first report Silos' skills as loaded and refuse add, though the
  // Claude agent beside it loads nothing of them. Each OTHER engine that
  // starts here and sees a row differently says so on the row (`engines`).
  /** The engine whose truth a folder's catalog tells (see folderCatalog):
   *  the fallback's when one of its agents starts here or nobody does. */
  folderEngine(folder: string): string {
    const fallback = fallbackHarness().id
    const present = [
      ...new Set(
        this.registry
          .list()
          .filter((a) => a.folder === folder)
          .map((a) => a.framework ?? fallback),
      ),
    ]
    return present.length === 0 || present.includes(fallback) ? fallback : present[0]!
  }

  async folderCatalog(folder: string): Promise<SkillCatalogEntry[]> {
    const fallback = fallbackHarness().id
    const present = [
      ...new Set(
        this.registry
          .list()
          .filter((a) => a.folder === folder)
          .map((a) => a.framework ?? fallback),
      ),
    ]
    const base = this.folderEngine(folder)
    const draft = (framework: Agent['framework']): Agent => ({ id: '', name: '', emoji: '', folder, skills: [], ...(framework ? { framework } : {}) })
    const out = await this.catalogFor(draft(base))
    for (const other of present.filter((e) => e !== base)) {
      const theirs = await this.catalogFor(draft(other))
      const label = findHarness(other)?.label ?? other
      const bare = (n: string): string => (n.includes(':') ? n.slice(n.lastIndexOf(':') + 1) : n)
      for (const e of out) {
        const t = theirs.find((x) => bare(x.name) === bare(e.name) && x.state === 'active') ?? theirs.find((x) => bare(x.name) === bare(e.name))
        const loadsHere = e.state === 'active'
        const loadsThere = t?.state === 'active'
        if (loadsHere === loadsThere) continue
        const says = loadsThere
          ? t!.source === 'plugin' && t!.plugin === 'silos'
            ? `${label} agents here load it from Silos at launch`
            : `${label} agents here load it`
          : `${label} agents here don't load it`
        e.engines = [...(e.engines ?? []), says]
      }
    }
    return out
  }

  // What the new-agent picker offers BEFORE the agent exists: the catalog
  // rule run for a draft (its engine + folder) — exactly what the add route
  // will accept once it is created, never Silos' whole list. No folder:
  // nothing can be added (the route refuses an agent without one).
  async silosSkillOffer(draft: { folder: string | null; framework?: Agent['framework'] }): Promise<SilosSkillOffer> {
    if (!this.silosSkillsDir) return { skills: [], notOffered: [] }
    const names = [...this.diskSkills(this.silosSkillsDir, 'silos').keys()].sort()
    if (!draft.folder)
      return { skills: [], notOffered: names.map((name) => ({ name, why: 'pick a folder first — a skill is added as a copy in the agent’s folder' })) }
    const agent: Agent = { id: '', name: '', emoji: '', folder: draft.folder, skills: [], ...(draft.framework ? { framework: draft.framework } : {}) }
    const catalog = await this.catalogFor(agent)
    const out: SilosSkillOffer = { skills: [], notOffered: [] }
    for (const name of names) {
      // the entry the add route would look up by this name (a held copy
      // wins over the personal twin that also carries the name)
      const entry = catalog.find((e) => e.name === name && e.state === 'held') ?? catalog.find((e) => e.name === name)
      const why = notAddableWhy(name, entry)
      if (why === null) out.skills.push({ name, ...(entry?.description !== undefined ? { description: entry.description } : {}) })
      else out.notOffered.push({ name, why })
    }
    return out
  }

  private async catalogFor(agent: Agent, conversation?: SkillsConversation): Promise<SkillCatalogEntry[]> {
    const visible = await this.visibleSkills(agent)
    const folder = agent.folder ?? null
    const held = this.held && folder ? this.held(folder) : []
    const load = this.loadOf(agent)
    const personal = load.personal !== false ? this.diskSkills(this.skillsDir, 'user') : new Map<string, Located>()
    const out: SkillCatalogEntry[] = []
    for (const name of [...visible.keys()].sort()) {
      const at = visible.get(name) ?? null
      const entry: SkillCatalogEntry = { name, description: at ? this.describe(at.file) : undefined }
      // an enabled plugin's skills load in every conversation of the folder
      // exactly like its own copies (visibleSkills lists only the plugins
      // the folder really loads)
      const active = at !== null && !at.foreign && (at.source === 'project' || at.source === 'user' || at.shadowed !== undefined || at.plugin !== undefined)
      if (active) {
        entry.source = at.source
        if (at.shadowed) entry.shadowed = at.shadowed
        if (at.plugin) entry.plugin = at.plugin
        entry.state = 'active'
      } else {
        entry.state = 'seen'
        entry.seen = at === null ? 'name-only' : at.foreign ? 'other-folder' : 'plugin-off'
      }
      out.push(entry)
    }
    for (const h of held) {
      out.push({
        name: h.name,
        ...(h.description !== undefined ? { description: h.description } : {}),
        state: 'held',
        ...(personal.has(h.name) ? { stillLoads: 'personal' as const } : {}),
      })
    }
    // Silos' own skills: addable unless the folder already loads the name
    // (its copy, a personal twin, a root the engine is handed) or holds it.
    // A 'seen' entry of the same name gives way — it IS this skill.
    if (this.silosSkillsDir && folder) {
      const loaded = new Set(out.filter((e) => e.state === 'active').map((e) => e.name))
      const heldNames = new Set(held.map((h) => h.name))
      for (const [base, at] of this.diskSkills(this.silosSkillsDir, 'silos')) {
        if (loaded.has(base) || loaded.has(`silos:${base}`) || heldNames.has(base)) continue
        const i = out.findIndex((e) => e.name === base && e.state === 'seen')
        if (i >= 0) out.splice(i, 1)
        const description = this.describe(at.file)
        out.push({ name: base, ...(description !== undefined ? { description } : {}), source: 'silos', state: 'available' })
      }
    }
    if (folder) this.withAccountSkills(agent, out)
    if (folder) this.withPlaces(agent, out, conversation)
    return out
  }

  // The skills the Claude account sends (one entry per login's copy) and
  // each account or personal skill's position in the folder — what the
  // engine reads (Harness.loads.skills). An account skill is active, or
  // 'available' («could add») when its origin or its own position is off;
  // a personal skill turned off here is 'held'. A 'seen' entry that is an
  // account skill's name (bare, or as the engine lists it, `<x>:<name>`)
  // gives way: it IS that skill.
  private withAccountSkills(agent: Agent, out: SkillCatalogEntry[]): void {
    let read: ReturnType<AccountSkillsOf> = null
    try {
      read = this.accountSkills?.(agent) ?? null
    } catch {
      read = null
    }
    if (!read) return
    const { skills: ls, switches } = read
    const positions = new Map(ls.overrides.map((o) => [o.name, o]))
    const accountNames = new Set(ls.accounts.flatMap((a) => a.skills.map((s) => s.name)))
    const personal = new Set(ls.personal)
    const placeOf = (name: string): Pick<SkillCatalogEntry, 'position' | 'switches' | 'decidedBy'> => {
      const o = positions.get(name)
      const decidedBy = ls.refused ? ('home' as const) : o?.decidedBy
      return { ...(o ? { position: o.value } : {}), ...(decidedBy ? { decidedBy } : switches ? { switches: true as const } : {}) }
    }
    for (const e of out) {
      if (e.source !== 'user' || e.state !== 'active') continue
      Object.assign(e, placeOf(e.name))
      if (e.position === 'off') e.state = 'held'
      if (accountNames.has(e.name)) e.sameName = true
    }
    const originDecided = ls.refused ? ('home' as const) : ls.origin.decidedBy
    const origin: NonNullable<SkillCatalogEntry['origin']> = {
      on: ls.origin.on,
      ...(originDecided ? { decidedBy: originDecided } : switches ? { switches: true as const } : {}),
    }
    for (let i = out.length - 1; i >= 0; i--) {
      const e = out[i]!
      if (e.state === 'seen' && (accountNames.has(e.name) || (e.name.includes(':') && accountNames.has(e.name.slice(e.name.lastIndexOf(':') + 1)))))
        out.splice(i, 1)
    }
    for (const a of ls.accounts) {
      for (const sk of a.skills) {
        const place = placeOf(sk.name)
        const description = this.describe(sk.file)
        out.push({
          name: sk.name,
          ...(description !== undefined ? { description } : {}),
          source: 'account',
          account: { login: a.login, ...(a.unmatched ? { unmatched: true as const } : {}) },
          state: !ls.origin.on || place.position === 'off' ? 'available' : 'active',
          ...place,
          ...(personal.has(sk.name) ? { sameName: true as const } : {}),
          origin,
        })
      }
    }
  }

  // Each skill's «Where it loads» (spec scopes T9): a personal or account
  // skill, a folder copy (in its folder or out in the held store), a
  // plugin's — the engine answers the lines of each copy it is asked about;
  // Silos tells it what only Silos knows (held, shadowed).
  private withPlaces(agent: Agent, out: SkillCatalogEntry[], conversation?: SkillsConversation): void {
    if (!this.skillPlaces) return
    const askOf = (e: SkillCatalogEntry): LoadsSkillAsk | null => {
      if (e.source === 'user' && (e.state === 'active' || e.state === 'held'))
        return { name: e.name, from: 'personal', ...(e.shadowed ? { shadowed: true as const } : {}) }
      if (e.source === 'account') return { name: e.name, from: 'account' }
      if (e.source === 'project' && e.state === 'active') return { name: e.name, from: 'project' }
      if (e.source === undefined && e.state === 'held' && e.stillLoads === undefined) return { name: e.name, from: 'project', held: true }
      if (e.source === 'plugin' && e.state === 'active') return { name: e.name, from: 'plugin' }
      return null
    }
    const asks: LoadsSkillAsk[] = []
    const seen = new Set<string>()
    for (const e of out) {
      const a = askOf(e)
      if (!a || seen.has(`${a.from}:${a.name}`)) continue
      seen.add(`${a.from}:${a.name}`)
      asks.push(a)
    }
    let places: LoadsSkillPlaces[] | null = null
    try {
      places = this.skillPlaces(agent, asks, conversation)
    } catch {
      places = null
    }
    if (!places) return
    for (const e of out) {
      const a = askOf(e)
      const p = a ? places.find((x) => x.name === a.name && x.from === a.from) : undefined
      if (p) e.at = p.lines
    }
  }

  // Full readme of a skill found on disk (see locate(); agent-independent:
  // the agents' folders are searched after the user dir and plugins).
  // Null when no SKILL.md exists anywhere — the detail page falls back to
  // the description. Defense in depth via realpath, same criterion as the
  // subagents endpoint (server.ts): the file must stay inside its root.
  async skillReadme(name: string): Promise<SkillReadme | null> {
    const at = this.locate(name, null)
    if (!at) return null
    let real: string, realRoot: string
    try {
      real = realpathSync(at.file)
      realRoot = realpathSync(at.root)
    } catch {
      return null
    }
    if (real !== realRoot && !real.startsWith(realRoot + sep)) return null // symlink traversal
    let raw: string
    try {
      raw = readFileSync(real, 'utf8')
    } catch {
      return null
    }
    const parsed = parseSkillMd(raw)
    const out: SkillReadme = { name, body: parsed.body }
    if (parsed.description !== undefined) out.description = parsed.description
    return out
  }

  // name -> where its SKILL.md lives (null: known only by name). The one
  // definition of "a skill visible to this agent": its folder's skills,
  // the user's, the enabled plugins', plus names seen in transcripts or
  // declared on agents. A directory without SKILL.md is not a skill
  // (Claude Code wouldn't load it — e.g. ~/.claude/skills/synced).
  private loadOf(agent: Agent): SkillLoad {
    return this.skillLoad ? this.skillLoad(agent) : { claudePlugins: true }
  }

  private async visibleSkills(agent: Agent): Promise<Map<string, Located | null>> {
    const out = new Map<string, Located | null>()
    const put = (name: string, at: Located | null): void => {
      if (!out.get(name)) out.set(name, at)
    }
    // Claude Code's own precedence for one name in two places: personal
    // (~/.claude/skills) over project (<folder>/.claude/skills) — the agent
    // runs the personal copy, so that is the one listed; the folder's copy
    // is named as `shadowed` (it never loads while the personal one exists).
    // an engine that doesn't load ~/.claude/skills (load.personal false)
    // lists none of them as its own
    const load = this.loadOf(agent)
    const personal = load.personal !== false ? this.diskSkills(this.skillsDir, 'user') : new Map<string, Located>()
    for (const [n, at] of personal) put(n, at)
    if (agent.folder) {
      for (const [n, at] of this.diskSkills(join(agent.folder, '.claude', 'skills'), 'project')) {
        const p = out.get(n)
        if (p && personal.has(n)) out.set(n, { ...p, shadowed: at.file })
        else put(n, at)
      }
    }
    if (load.claudePlugins) for (const [n, at] of this.pluginSkills(true, agent.folder)) put(n, at)
    // roots the engine is handed at launch load under their bare names (a
    // folder copy of the same name is listed first and wins) — except the
    // folder's HELD names: the launch denies those (OpenCode's
    // permission.skill, harnesses/opencode/assemble.ts), so the engine
    // doesn't see them and listing them active would be the lie. (A held
    // name with a personal twin is not denied — it is already listed above,
    // as the personal skill it is.)
    const heldHere = this.held && agent.folder ? new Set(this.held(agent.folder).map((h) => h.name)) : new Set<string>()
    for (const r of load.roots ?? []) {
      for (const [n, at] of this.diskSkills(r.dir, 'plugin')) if (!heldHere.has(n)) put(n, { ...at, plugin: r.plugin })
    }
    // Skills derived from SESSIONS can carry transcript artifacts (a
    // tool_use named "Skill" whose input.skill isn't actually one, e.g.
    // "Bash") — real skills are lowercase slugs, so anything not starting
    // with [a-z] is discarded. Disk and agents are NOT filtered: the owner
    // controls what's there.
    const named = new Set<string>()
    for (const s of this.index.allSessions()) for (const sk of s.skills) if (/^[a-z]/.test(sk)) named.add(sk)
    for (const a of this.registry.list(true)) for (const sk of a.skills) named.add(sk)
    for (const n of named) if (!out.has(n)) out.set(n, this.locate(n, agent.folder))
    return out
  }

  // Where a NAME's SKILL.md lives: the agent's folder, the user's dir, any
  // installed plugin (`plugin:skill`), then every agent's folder — so a
  // skill first seen in a transcript still gets its own description.
  private locate(name: string, folder: string | null): Located | null {
    if (name === '' || name.includes('/') || name.includes('\\') || /^\.+$/.test(name)) return null
    const plugin = name.includes(':') ? this.pluginSkills(false).get(name) : undefined
    if (plugin) return plugin
    const roots: Located[] = []
    roots.push({ file: '', root: this.skillsDir, source: 'user' }) // personal wins over project, as in Claude Code
    if (folder) roots.push({ file: '', root: join(folder, '.claude', 'skills'), source: 'project' })
    for (const a of this.registry.list(true)) {
      // a symlinked folder and its target are one folder (folder-identity.ts)
      if (a.folder && !sameFolder(a.folder, folder)) roots.push({ file: '', root: join(a.folder, '.claude', 'skills'), source: 'project', foreign: true })
    }
    for (const r of roots) {
      const file = join(r.root, name, 'SKILL.md')
      if (existsSync(file)) return { ...r, file }
    }
    return null
  }

  private diskSkills(root: string, source: SkillSource): Map<string, Located> {
    const out = new Map<string, Located>()
    for (const n of listDirs(root)) {
      const file = join(root, n, 'SKILL.md')
      if (existsSync(file)) out.set(n, { file, root, source })
    }
    return out
  }

  // Plugin skills as Claude Code names them (`<plugin>:<skill>`), from the
  // LIVE install path in installed_plugins.json (the cache keeps stale
  // versions side by side). onlyEnabled: what the agent can invoke;
  // otherwise every installed one (description lookup for a name seen in
  // a transcript). With a folder, the folder's own switches count as the
  // engine reads them: <folder>/.claude/settings.local.json over
  // settings.json over the machine's ~/.claude/settings.json.
  private pluginSkills(onlyEnabled: boolean, folder?: string | null): Map<string, Located> {
    const claudeDir = dirname(this.skillsDir)
    const paths = {
      userSettingsPath: join(claudeDir, 'settings.json'),
      installedPluginsPath: join(claudeDir, 'plugins', 'installed_plugins.json'),
      ...(this.managedDir ? { managedDir: this.managedDir } : {}),
    }
    const out = new Map<string, Located>()
    // the one resolver (plugin-enablement.ts) the project's Tools piece uses
    // too: explicit entry by precedence, else the manifest's defaultEnabled,
    // else on
    const r = onlyEnabled ? pluginResolver(folder, paths) : null
    const installed = r ? r.installed : installedPlugins(paths.installedPluginsPath)
    for (const [key, dir] of installed) {
      if (r && !r.resolve(key).enabled) continue
      if (dir === null) continue
      const plugin = key.split('@')[0]!
      for (const [n, at] of this.diskSkills(join(dir, 'skills'), 'plugin')) out.set(`${plugin}:${n}`, onlyEnabled ? { ...at, plugin: key } : at)
    }
    return out
  }

  private describe(file: string): string | undefined {
    try {
      return parseSkillMd(readFileSync(file, 'utf8').slice(0, 8000)).description
    } catch {
      return undefined
    }
  }

  private async listFolder(folder: string): Promise<string[]> {
    const hit = this.cache.get(folder)
    if (hit && Date.now() - hit.at < TTL_MS) return hit.list
    const out: string[] = []
    let visited = 0
    const queue: Array<{ dir: string; depth: number }> = [{ dir: folder, depth: 0 }]
    while (queue.length > 0 && visited < MAX_VISITED) {
      const { dir, depth } = queue.shift()!
      let entries
      try {
        entries = await readdir(dir, { withFileTypes: true })
      } catch {
        continue
      }
      for (const e of entries) {
        if (++visited > MAX_VISITED) break
        if (e.name.startsWith('.') && e.name !== '.claude') continue
        if (e.isDirectory()) {
          if (!IGNORE.has(e.name) && depth < MAX_DEPTH) queue.push({ dir: join(dir, e.name), depth: depth + 1 })
        } else if (e.isFile()) {
          out.push(relative(folder, join(dir, e.name)))
        }
      }
    }
    this.cache.set(folder, { at: Date.now(), list: out })
    return out
  }
}
