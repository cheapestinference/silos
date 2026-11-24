import { existsSync, readFileSync } from 'node:fs'
import { atomicWriteJson } from './json-store.js'
import type { Agent } from './types.js'
import type { HarnessId } from './harnesses/contract.js'
import { fallbackHarness } from './harnesses/registry.js'
import { stripTrailingSlash as strip, territoriesOf } from './territory.js'
import { OUTPUT_STYLE_ID_RE } from './cockpit.js'
import { normalizeStoredMission, parseMission, sameMission, type Mission } from './mission.js'
import {
  defaultHeartbeat,
  exemptToday,
  heartbeatOf,
  localYmd,
  ownTurnsPerDayOf,
  spendPerDayOf,
  storedProactive,
  type Control,
  type Cut,
  type Heartbeat,
  type Proactive,
} from './control.js'
import { endPass } from './pass.js'
import { ControlError } from './control.js'
import { auditProjectFolders, checkProjectFolder, realFolder, type FolderOffence, type FolderPlaces, type FolderVerdict } from './project-folder.js'

export const MASTER_ID = 'master'
const SLUG = /^[a-z0-9][a-z0-9-]{0,31}$/
// Every agent falls back to these (see Agent.framework/provider in types.ts):
// the fallback harness (Claude Code) and its default provider. A function, not
// a const: the registry is filled after this module is evaluated.
const defaultFramework = (): HarnessId => fallbackHarness().id
const DEFAULT_PROVIDER = 'default'

export function mungePath(p: string): string {
  return p.replace(/[/.]/g, '-')
}

// Cross-session link: HONEST resolver from a message's sender in another
// session (the "third voice", see interSessionOf in harnesses/claude-code/parser.ts) to a known
// agent. The message doesn't carry the source session_id — you can't jump
// to the exact conversation; what you CAN do is recognize the sender's NAME
// and link to their agent dossier. Rule (case-insensitive):
//   1. EXACT and UNIQUE match against a known agent's id / name / name-slug;
//   2. if not, strip ONE short session suffix from the sender (e.g.
//      "acme-e8" → "acme") and retry the exact
//      unique match. Suffix = "-" + 1..4 alphanumerics (the socket tags the
//      harness adds: -e8, -c6…). No link if the match is ambiguous (two
//      different agents match) or if the sender is a socket (uds:/…, with
//      '/') or the 'peer' placeholder. Archived agents don't enter (the
//      caller passes the non-archived list) → no link, honest.
const norm = (s: string): string => s.trim().toLowerCase()
const slug = (s: string): string => norm(s).replace(/\s+/g, '-')

function uniqueMatch(candidate: string, agents: Agent[]): string | null {
  const hits = agents.filter((a) => norm(a.id) === candidate || norm(a.name) === candidate || slug(a.name) === candidate)
  const ids = new Set(hits.map((a) => a.id))
  return ids.size === 1 ? (ids.values().next().value as string) : null
}

export function resolveSenderAgentId(from: unknown, agents: Agent[]): string | null {
  if (typeof from !== 'string') return null
  const raw = norm(from)
  if (raw === '' || raw === 'peer' || raw.startsWith('uds:') || raw.includes('/')) return null
  const exact = uniqueMatch(raw, agents)
  if (exact) return exact
  const base = raw.replace(/-[a-z0-9]{1,4}$/, '')
  if (base !== raw && base !== '') return uniqueMatch(base, agents)
  return null
}

// Validation shared between create() and update(): a patch with odd shapes
// (e.g. skills: "oops") must never get persisted — classify() would blow up
// on every /api/overview until agents.json was hand-repaired.
function validateOptionalFields(input: {
  skills?: unknown
  emoji?: unknown
  model?: unknown
  provider?: unknown
  fallback?: unknown
  outputStyle?: unknown
}): void {
  if (input.skills !== undefined && (!Array.isArray(input.skills) || !input.skills.every((s) => typeof s === 'string'))) {
    throw new Error('skills must be an array of strings')
  }
  // Only the SHAPE is checked here (nothing odd reaches agents.json); the
  // ids' existence against ProvidersStore is validated by server.ts on the
  // write routes (the registry deliberately doesn't know about the store).
  if (input.fallback !== undefined && (!Array.isArray(input.fallback) || !input.fallback.every((s) => typeof s === 'string'))) {
    throw new Error('fallback must be an array of provider ids')
  }
  for (const field of ['emoji', 'model', 'provider', 'outputStyle'] as const) {
    if (input[field] !== undefined && typeof input[field] !== 'string') throw new Error('invalid field')
  }
  // a style is a name, never a path ('' = clear it); whether the engine
  // offers it is the route's check (server.ts outputStyleError)
  if (typeof input.outputStyle === 'string' && input.outputStyle.trim() !== '' && !OUTPUT_STYLE_ID_RE.test(input.outputStyle.trim())) {
    throw new Error('outputStyle must be a style name')
  }
}

// The invariants of the control fields, re-validated on every READ of
// agents.json: the file is also written
// by hand (and, without a fence, by anything running as the same user) —
// a stale exemption is dropped, a knob out of range goes back to its
// default (said in the server log), a missing control/heartbeat gets its
// default. `own` without fence or mission is NOT rewritten: controlOf()
// derives `told` while it lasts, the field intact (G5-r7). Returns whether
// anything changed.
function revalidateControl(a: Agent, now: number): boolean {
  let changed = false
  if (a.control !== 'told' && a.control !== 'own') {
    a.control = 'told'
    changed = true
  }
  const hb = heartbeatOf(a)
  if (JSON.stringify(hb) !== JSON.stringify(a.heartbeat)) {
    a.heartbeat = hb
    changed = true
  }
  if (a.ownExemptDay !== undefined && !exemptToday(a, now)) {
    delete a.ownExemptDay
    changed = true
  }
  if (a.ownTurnsPerDay !== undefined && ownTurnsPerDayOf(a) !== a.ownTurnsPerDay) {
    console.warn(`agents.json: ${a.id}'s ownTurnsPerDay (${String(a.ownTurnsPerDay)}) is out of range — back to the default`)
    delete a.ownTurnsPerDay
    changed = true
  }
  // a proactive Silos does not recognise is no proactive:
  // dropped on the safe side — a hand edit never starts rounds
  if (a.proactive !== undefined && storedProactive(a) === null) {
    console.warn(`agents.json: ${a.id}'s proactive is not one Silos reads — dropped`)
    delete a.proactive
    changed = true
  }
  if (a.unattendedSpendPerDay !== undefined && spendPerDayOf(a) !== a.unattendedSpendPerDay) {
    console.warn(`agents.json: ${a.id}'s unattendedSpendPerDay (${String(a.unattendedSpendPerDay)}) is out of range — back to the default`)
    delete a.unattendedSpendPerDay
    changed = true
  }
  return changed
}

// Extra territories (Agent.folders): absolute paths, at most 16, none equal
// to the primary folder, no duplicates — compared after stripping trailing
// slashes, which is also the stored form. Returns the normalised list.
export const MAX_FOLDERS = 16
function normalizeFolders(folders: unknown, primary: string | null): string[] {
  if (!Array.isArray(folders) || !folders.every((f) => typeof f === 'string')) {
    throw new Error('folders must be an array of absolute paths')
  }
  // Master (folder null) catches orphans everywhere; it has no territory to
  // extend. An empty list is accepted so a generic form save stays harmless.
  if (primary === null && folders.length > 0) throw new Error('master has no folders')
  if (folders.length > MAX_FOLDERS) throw new Error(`folders: at most ${MAX_FOLDERS} entries`)
  const main = primary === null ? null : strip(primary)
  const out: string[] = []
  for (const raw of folders as string[]) {
    if (!raw.startsWith('/')) throw new Error(`folders must be absolute paths: ${raw}`)
    const f = strip(raw)
    // `/` would claim every cwd on the machine (and inside('/') never matches).
    if (f === '/') throw new Error('folders: / cannot be a territory')
    if (f === main) throw new Error(`folders: ${raw} is already the agent's folder`)
    if (out.includes(f)) throw new Error(`folders: duplicate entry ${raw}`)
    out.push(f)
  }
  return out
}

function masterAgent(): Agent {
  return {
    id: MASTER_ID,
    name: 'Master',
    emoji: '🎛️',
    folder: null,
    skills: [],
    default: true,
    framework: defaultFramework(),
    provider: DEFAULT_PROVIDER,
  }
}

export class AgentRegistry {
  private agents: Agent[] = []
  /** `folderCheck`: the places the project folder check judges against
   *  (project-folder.ts) — the server always builds its registry with them,
   *  so every door that writes a folder goes through the check; a registry
   *  built without them (another module's test) checks nothing. */
  constructor(
    private file: string,
    private opts: { folderCheck?: FolderPlaces } = {},
  ) {}

  load(): void {
    if (existsSync(this.file)) {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as { agents?: Agent[] }
      this.agents = Array.isArray(raw.agents) ? raw.agents : []
    }
    if (!this.agents.some((a) => a.id === MASTER_ID)) {
      this.agents.unshift(masterAgent())
      this.save()
    }
    // A hand-edited agents.json could leave master archived or with a
    // folder — that's silently corrected so it always catches orphans in
    // the overview.
    const master = this.get(MASTER_ID) as Agent
    master.archived = false
    master.folder = null
    let changed = false
    for (const a of this.agents) {
      // a hand-written mission (no `never`, untrimmed, a stray shape) is
      // normalized in memory — never a crash in a turn or on a screen; the
      // file is left as the owner wrote it
      if ('mission' in a) {
        const m = normalizeStoredMission((a as { mission?: unknown }).mission)
        if (m) a.mission = m
        else {
          delete a.mission
          console.warn(`agents.json: ${a.id}'s mission has no text — ignored`)
        }
      }
      if (revalidateControl(a, Date.now())) changed = true
    }
    if (changed) this.save()
  }

  // The same invariants, re-checked on a live process (the resident's tick:
  // an exemption ends at local midnight). Saves only when something moved.
  revalidate(now = Date.now()): void {
    let changed = false
    for (const a of this.agents) if (revalidateControl(a, now)) changed = true
    if (changed) this.save()
  }

  /** The project folder check for `folder` given to agent `selfId` (none =
   *  a new agent): against every other in-play agent's folders. Without a
   *  configured check, every absolute folder is fine as written. */
  checkFolder(folder: string, selfId?: string): FolderVerdict {
    if (!this.opts.folderCheck)
      return typeof folder === 'string' && folder.startsWith('/')
        ? { ok: true, path: strip(folder) }
        : { ok: false, reason: 'the folder must be an absolute path', conflict: false }
    return checkProjectFolder(folder, this.opts.folderCheck, this.projectFoldersBut(selfId))
  }

  /** The boot audit: every in-play agent's folder that breaks the rule
   *  today, said, never fixed. Empty without a configured check. */
  auditFolders(): FolderOffence[] {
    return this.opts.folderCheck ? auditProjectFolders(this.agents, this.opts.folderCheck) : []
  }

  private projectFoldersBut(selfId: string | undefined): string[] {
    return this.agents.filter((a) => !a.archived && a.id !== selfId).flatMap((a) => territoriesOf(a))
  }

  // The territories an agent ends up with, judged: each one not already
  // among `kept` (what it has now) goes through the check — against the
  // other agents' projects and its own other folders — and is stored by its
  // real path. A refusal throws before anything is written.
  private claimFolders(selfId: string, territories: string[], kept: readonly string[]): string[] {
    if (!this.opts.folderCheck) return territories
    const out: string[] = []
    for (const t of territories) {
      if (kept.includes(strip(t))) {
        out.push(t)
        continue
      }
      const own = territories.filter((x) => x !== t)
      const v = checkProjectFolder(t, this.opts.folderCheck, [...this.projectFoldersBut(selfId), ...own])
      if (!v.ok) throw new ControlError(v.conflict ? 409 : 400, v.reason)
      if (own.some((x) => realFolder(x) === v.path)) throw new ControlError(400, `${t} is already one of the agent's folders`)
      out.push(v.path)
    }
    return out
  }

  list(includeArchived = false): Agent[] {
    return this.agents.filter((a) => includeArchived || !a.archived)
  }

  get(id: string): Agent | null {
    return this.agents.find((a) => a.id === id) ?? null
  }

  // Cross-session link: third-voice sender → known (non-archived) agent id,
  // or null. See resolveSenderAgentId for the full rule.
  resolveSender(from: unknown): string | null {
    return resolveSenderAgentId(from, this.list())
  }

  // `mission`: the API's { text, never? } — validated and stamped here
  // (mission.ts parseMission), the same as update(). `control`: what the
  // creator decided (the route: own with a mission and a fence) —
  // absent = told; the heartbeat is always born with its default (staggered
  // minute).
  create(input: {
    id: string
    name: string
    emoji?: string
    folder: string
    folders?: string[]
    skills?: string[]
    model?: string
    mission?: unknown
    default?: boolean
    framework?: HarnessId
    provider?: string
    fallback?: string[]
    outputStyle?: string
    control?: Control
  }): Agent {
    if (!SLUG.test(input.id)) throw new Error('invalid id (lowercase/digits/hyphens slug, max 32)')
    if (this.get(input.id)) throw new Error('duplicate id')
    if (!input.name?.trim()) throw new Error('name required')
    if (!input.folder?.startsWith('/')) throw new Error('folder must be an absolute path')
    validateOptionalFields(input)
    const asked = input.folders === undefined ? [] : normalizeFolders(input.folders, input.folder)
    const [folder, ...folders] = this.claimFolders(input.id, [input.folder, ...asked], []) as [string, ...string[]]
    const mission = input.mission === undefined ? null : parseMission(input.mission)
    const agent: Agent = {
      id: input.id,
      name: input.name.trim(),
      emoji: input.emoji ?? '🤖',
      folder,
      skills: input.skills ?? [],
      ...(folders.length > 0 ? { folders } : {}),
      framework: input.framework ?? defaultFramework(),
      provider: input.provider ?? DEFAULT_PROVIDER,
      ...(input.fallback && input.fallback.length > 0 ? { fallback: input.fallback } : {}),
      ...(input.model ? { model: input.model } : {}),
      ...(input.outputStyle?.trim() ? { outputStyle: input.outputStyle.trim() } : {}),
      ...(mission ? { mission } : {}),
      ...(input.default ? { default: true } : {}),
      control: input.control === 'own' && mission ? 'own' : 'told',
      // the server stamps its period's phase when it writes it
      heartbeat: { period: { ...defaultHeartbeat(input.id).period!, since: localYmd(Date.now()) } },
    }
    this.agents.push(agent)
    this.save()
    return agent
  }

  // `mission`: { text, never? } validated and stamped (a changed text or
  // Never list gets a fresh updatedAt), or null to clear it. The control
  // fields arrive already validated (control.ts parseControlPatch, the
  // route's): `heartbeat` is PARTIAL (merged over the current one), and a
  // null knob/exemption/cut means «back to the default / clear».
  update(
    id: string,
    patch: Partial<Omit<Agent, 'id' | 'mission' | 'heartbeat' | 'ownTurnsPerDay' | 'unattendedSpendPerDay' | 'ownExemptDay' | 'cut' | 'proactive'>> & {
      mission?: unknown
      heartbeat?: Partial<Heartbeat>
      ownTurnsPerDay?: number | null
      unattendedSpendPerDay?: number | null
      ownExemptDay?: string | null
      cut?: Cut | null
      proactive?: Proactive | null
    },
  ): Agent {
    const a = this.get(id)
    if (!a) throw new Error('agent not found')
    if (id === MASTER_ID && patch.archived) throw new Error('master cannot be archived')
    if (patch.folder !== undefined && id !== MASTER_ID && (patch.folder === null || !patch.folder.startsWith('/'))) {
      throw new Error('folder must be an absolute path')
    }
    if (patch.name !== undefined && !patch.name?.trim()) throw new Error('name required')
    if (patch.archived !== undefined && typeof patch.archived !== 'boolean') {
      throw new Error('archived must be a boolean')
    }
    validateOptionalFields(patch)
    const mission: Mission | null | undefined = patch.mission === undefined ? undefined : parseMission(patch.mission)
    // Validated against the EFFECTIVE folder: a folder change can collide
    // with an existing extra territory just as a folders change can.
    let folders: string[] | undefined
    let folder: string | undefined
    // an archived agent brought back puts its folders in play again: judged
    // as new, like a birth
    const reviving = patch.archived === false && a.archived === true
    if (patch.folders !== undefined || patch.folder !== undefined || reviving) {
      const effFolder = id === MASTER_ID ? null : patch.folder !== undefined ? patch.folder : a.folder
      const effFolders = patch.folders !== undefined ? patch.folders : (a.folders ?? [])
      folders = normalizeFolders(effFolders, effFolder)
      if (effFolder !== null) {
        const claimed = this.claimFolders(id, [effFolder, ...folders], reviving ? [] : territoriesOf(a))
        folder = claimed[0] as string
        folders = claimed.slice(1)
      }
    }
    const { mission: _mission, heartbeat: hbPatch, ownTurnsPerDay, unattendedSpendPerDay, ownExemptDay, cut, proactive, ...rest } = patch
    Object.assign(a, rest, { id: a.id, ...(id === MASTER_ID ? { folder: null } : folder !== undefined ? { folder } : {}) })
    if (hbPatch !== undefined) a.heartbeat = heartbeatOf({ id: a.id, heartbeat: { ...heartbeatOf(a), ...hbPatch } })
    const knob = <K extends 'ownTurnsPerDay' | 'unattendedSpendPerDay' | 'ownExemptDay' | 'cut' | 'proactive'>(k: K, v: Agent[K] | null | undefined): void => {
      if (v === undefined) return
      if (v === null) delete a[k]
      else a[k] = v
    }
    knob('ownTurnsPerDay', ownTurnsPerDay)
    knob('unattendedSpendPerDay', unattendedSpendPerDay)
    knob('ownExemptDay', ownExemptDay)
    knob('cut', cut)
    knob('proactive', proactive)
    // «Only when told» CLEARS proactive, in the same
    // write, whoever writes it: it never comes back without the owner
    // choosing it again
    if (patch.control === 'told') delete a.proactive
    if (mission === null) delete a.mission
    // the stamp moves only when the mission says something new
    else if (mission !== undefined && !sameMission(a.mission, mission)) a.mission = mission
    if (folders !== undefined) {
      if (folders.length > 0) a.folders = folders
      else delete a.folders
    }
    // Free text, so a stray empty patch (the field cleared in the UI) must
    // remove the property rather than persist '' — an empty string reads as
    // "no responsibility set" everywhere else that checks presence.
    // the same for the style: '' (the editor's "not set") removes it
    if (patch.outputStyle !== undefined) {
      const trimmed = patch.outputStyle.trim()
      if (trimmed === '') delete a.outputStyle
      else a.outputStyle = trimmed
    }
    this.save()
    return a
  }

  archive(id: string): Agent {
    if (id === MASTER_ID) throw new Error('master cannot be archived')
    return this.update(id, { archived: true })
  }

  unarchive(id: string): Agent {
    return this.update(id, { archived: false })
  }

  classify(meta: { cwd: string | null; folder: string; skills: string[] }): Agent {
    return this.classifyWithRule(meta).agent
  }

  // Same answer as classify(), plus WHICH rule gave it: a primary folder
  // (or the munged exact match with no cwd), a secondary territory
  // (folders[]), or the master fallback. session-owner.ts needs it: a
  // secondary match must never override a chain that already has an owner.
  classifyWithRule(meta: { cwd: string | null; folder: string; skills: string[] }): { agent: Agent; via: 'primary' | 'secondary' | 'master' } {
    const active = this.agents.filter((a) => !a.archived && a.folder !== null)
    let candidates: Agent[] = []
    if (meta.cwd !== null) {
      const cwd = meta.cwd
      const inside = (f: string): boolean => cwd === f || cwd.startsWith(f + '/')
      let best = -1
      for (const a of active) {
        const f = a.folder as string
        if (inside(f)) {
          if (f.length > best) {
            best = f.length
            candidates = [a]
          } else if (f.length === best) candidates.push(a)
        }
      }
      // No primary folder holds the cwd: a secondary territory (folders[])
      // of exactly ONE agent claims it. Ambiguous → today's behaviour.
      if (candidates.length === 0) {
        const owners = active.filter((a) => territoriesOf(a).slice(1).some(inside))
        if (owners.length === 1) return { agent: owners[0] as Agent, via: 'secondary' }
      }
    } else {
      candidates = active.filter((a) => mungePath(a.folder as string) === meta.folder)
    }
    if (candidates.length === 0) return { agent: this.get(MASTER_ID) as Agent, via: 'master' }
    const agent = candidates.find((a) => a.skills.some((s) => meta.skills.includes(s))) ?? candidates.find((a) => a.default) ?? (candidates[0] as Agent)
    return { agent, via: 'primary' }
  }

  // atomic (tmp + rename); under the seal (seals.ts) the seal
  // writes it in its contract order
  private save(): void {
    // who wakes and who can start change with the agents (pass.ts)
    endPass()
    atomicWriteJson(this.file, { agents: this.agents })
  }
}
