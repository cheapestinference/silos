// harnesses/claude-code/loads/skill-places.ts — «Where it loads» for a
// Claude Code skill (spec scopes §3, §4, T9; measured on CLI 2.1.331, the
// spec's T1 appendix): one line per place and per fact, broadest first, each
// with its position as found, what loads there, the positions a click may
// pick and — for a name several copies share — which copies its entry
// reaches.
//
// One key at every place, `skillOverrides: {"<name>": "off" | "name-only" |
// "on"}`, an OVERRIDE kind: the narrowest place that names the skill
// decides, both ways — flag (an agent's launch) › local (this project's
// file) › project (the repository's checked-in file, a fact) › user (this
// machine's file), measured in both directions. Managed settings decide
// above everything (every line locked).
//
//  · a personal skill (`~/.claude/skills`) or one the account sends: the
//    machine, project and agent lines take the three positions; the
//    account's skills also have their head (`syncClaudeAiSkills: false`, an
//    off-only key): off at a place locks every narrower line — except the
//    project's own, where adding one is rule 4 (skills.ts);
//  · a skill of the project (`.claude/skills`): no machine line (it exists
//    in one project); its project line is Silos' held store; its agent
//    lines only turn it off (measured: an «off» from the flag tier hides a
//    project skill) and are locked while the copy is out of the folder;
//  · a skill the engine locks — a plugin's, a name settings can't store
//    (`__proto__`) — has inert lines: no entry changes it (measured).
//    A skill that disables model invocation is NOT locked (measured: an
//    «off» at user, local and flag tiers hides it) — ordinary lines;
//  · a name your personal skills and the account share: the project's
//    entry reaches only the personal copy, a launch entry both (measured
//    23-11); the machine's and the repository's reach of the account copy is
//    not measured, and said. A personal skill and a project skill of the
//    same name: only the personal one loads (measured) — the folder copy
//    is shadowed, and every line says its reach of it is not measured.
//
// Pure: it writes nothing. Names are data (own properties only).
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { LoadsCarried, LoadsSkillAsk, LoadsSkillCopy, LoadsSkillLine, LoadsSkillPlaces, LoadsSkillPosition, LoadsSkillsInput } from '../../contract.js'
import { isConfigHome, type Json } from '../local-settings.js'
import { cleanEntries } from './launch-entries.js'

const OVERRIDES = 'skillOverrides'
const HEAD = 'syncClaudeAiSkills'
const ALL: LoadsSkillPosition[] = ['on', 'name-only', 'off']

/** Names settings can't store (measured: an entry for `__proto__` is never
 *  read) — their lines are inert and no write is attempted. */
export const RESERVED_SKILL_NAMES: ReadonlySet<string> = new Set(['__proto__'])

const own = (o: object | null | undefined, k: string): boolean => o != null && Object.prototype.hasOwnProperty.call(o, k)
const asObject = (v: unknown): Json | null => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Json) : null)

/** The layers of one folder, by the engine's tiers (skills.ts reads them). */
export interface SkillTiers {
  managed: Json | null
  local: Json | null
  repository: Json | null
  user: Json | null
}

/** One tier's position for a name, as found (a string), or undefined. */
const entryAt = (j: Json | null, name: string): string | undefined => {
  const o = asObject(j?.[OVERRIDES] ?? null)
  if (!o || !own(o, name)) return undefined
  const v = o[name]
  return typeof v === 'string' ? v : undefined
}
const headOff = (j: Json | null): boolean => j !== null && own(j, HEAD) && j[HEAD] === false

/** The project's own skills: `<folder>/.claude/skills/<name>/SKILL.md`. */
export function projectSkillNames(folder: string): string[] {
  const root = join(folder, '.claude', 'skills')
  let names: string[]
  try {
    names = readdirSync(root)
  } catch {
    return []
  }
  return names.filter((n) => !n.startsWith('.') && existsSync(join(root, n, 'SKILL.md'))).sort()
}

export interface SkillPlacesContext {
  tiers: SkillTiers
  /** the copies of each name on disk: personal (every login dir), account
   *  (every batch), the folder's own */
  personal: ReadonlySet<string>
  account: ReadonlySet<string>
  project: ReadonlySet<string>
  /** an account skill's login, for its door (null: Silos can't say which) */
  loginOf: (name: string) => string | null
  home: boolean
  carried?: LoadsCarried
}

/** The copies a shared name has, beside the one asked about. */
function copiesOf(name: string, ctx: SkillPlacesContext): LoadsSkillCopy[] {
  const out: LoadsSkillCopy[] = []
  if (ctx.personal.has(name)) out.push('personal')
  if (ctx.account.has(name)) out.push('account')
  if (ctx.project.has(name)) out.push('project')
  return out
}

/** Which copies an entry at `tier` reaches, for a name several copies share
 *  (undefined for a name only one copy has: it reaches that one). */
function reachOf(tier: 'machine' | 'repository' | 'project' | 'agent', copies: LoadsSkillCopy[]): Pick<LoadsSkillLine, 'reaches' | 'unmeasured'> {
  if (copies.length < 2) return {}
  const shadowed = copies.includes('personal') && copies.includes('project')
  if (tier === 'project') {
    // measured 23-11: the local file's entry hides only the personal copy of
    // a name the account shares
    const reaches = copies.filter((c) => c !== 'account')
    return { reaches, ...(shadowed ? { unmeasured: ['project' as const] } : {}) }
  }
  if (tier === 'agent') return { reaches: [...copies], ...(shadowed ? { unmeasured: ['project' as const] } : {}) }
  // the machine's and the repository's reach beyond the personal copy is not measured
  return { reaches: [...copies], unmeasured: copies.filter((c) => c !== 'personal') }
}

/** Whether an entry at `tier` applies to the copy `from` (what its result
 *  counts): the project's entry skips the account copy of a shared name. */
const applies = (tier: 'machine' | 'repository' | 'project' | 'agent', from: LoadsSkillCopy, copies: LoadsSkillCopy[]): boolean =>
  !(tier === 'project' && from === 'account' && copies.includes('personal'))

/** One skill copy's lines. */
export function skillLinesOf(ask: LoadsSkillAsk, ctx: SkillPlacesContext): LoadsSkillLine[] {
  const { name } = ask
  const lines: LoadsSkillLine[] = []
  const agents = ctx.carried?.agents ?? []
  const from = ask.from
  if (from === 'account') {
    // the account's page for skills is not walked: a door that names it, no link
    lines.push({ place: 'account', result: 'on', keptIn: 'claude.ai', door: { word: 'Claude account', where: 'claude.ai', login: ctx.loginOf(name) } })
  }

  // the engine ignores every entry: inert lines, saying why
  if (from === 'plugin' || RESERVED_SKILL_NAMES.has(name)) {
    const locked = { why: 'engine' as const, reason: from === 'plugin' ? ('plugin' as const) : ('reserved' as const) }
    if (from !== 'project') lines.push({ place: 'machine', keptIn: '~/.claude/settings.json', result: 'on', locked })
    lines.push({ place: 'project', keptIn: '.claude/settings.local.json', result: 'on', locked })
    for (const a of agents) lines.push({ place: 'agent', agent: a.id, result: 'on', locked })
    const c = ctx.carried?.conversation
    if (c) lines.push({ place: 'conversation', conversation: c.id, ...(c.agent !== undefined ? { agent: c.agent } : {}), result: 'on', locked })
    return lines
  }

  const copies = copiesOf(name, ctx)
  const t = ctx.tiers
  // managed settings decide above everything
  const managed = entryAt(t.managed, name)
  const managedHead = from === 'account' && headOff(t.managed)
  const org = managedHead ? 'off' : managed
  if (managedHead) lines.push({ place: 'fact', fact: { who: 'organization', file: 'managed settings', key: HEAD }, entry: 'off', result: 'off' })
  else if (managed !== undefined)
    lines.push({ place: 'fact', fact: { who: 'organization', file: 'managed settings', key: `${OVERRIDES}.${name}` }, entry: managed, result: managed })

  let value = 'on'
  /** the place whose head keeps the account's skills off (off-only) */
  let offAt: 'machine' | 'project' | null = null
  const lockedOrg = org !== undefined ? { result: org, locked: { why: 'organization' as const, at: 'fact' as const } } : null

  // this machine — a skill of the project has no line here (it exists in one project)
  if (from !== 'project') {
    const e = entryAt(t.user, name)
    const line: LoadsSkillLine = {
      place: 'machine',
      keptIn: '~/.claude/settings.json',
      ...(e !== undefined ? { entry: e } : {}),
      result: 'on',
      ...reachOf('machine', copies),
    }
    if (lockedOrg) Object.assign(line, lockedOrg)
    else {
      if (e !== undefined && applies('machine', from, copies)) value = e
      if (from === 'account' && headOff(t.user)) {
        offAt = 'machine'
        line.result = 'off'
        line.locked = { why: 'wider', at: 'machine' }
      } else {
        line.result = value
        line.positions = [...ALL]
      }
    }
    lines.push(line)
  }

  // the repository's checked-in file: a fact, read, never written
  const repo = entryAt(t.repository, name)
  if (repo !== undefined) {
    const line: LoadsSkillLine = {
      place: 'fact',
      fact: { who: 'repository', file: '.claude/settings.json', key: `${OVERRIDES}.${name}` },
      entry: repo,
      result: value,
      ...reachOf('repository', copies),
    }
    if (lockedOrg) Object.assign(line, lockedOrg)
    else if (offAt) {
      line.result = 'off'
      line.locked = { why: 'wider', at: offAt }
    } else {
      if (applies('repository', from, copies)) value = repo
      line.result = value
    }
    lines.push(line)
  }

  // this project — its local file; a folder copy's place is Silos' held store
  const local = entryAt(t.local, name)
  const project: LoadsSkillLine = { place: 'project', keptIn: '.claude/settings.local.json', result: value, ...reachOf('project', copies) }
  if (from === 'project') {
    if (ask.held) project.entry = 'off'
    else if (local !== undefined) project.entry = local
  } else if (local !== undefined) project.entry = local
  let projectHeld = false
  if (lockedOrg) Object.assign(project, lockedOrg)
  else if (offAt) {
    project.result = 'off'
    project.locked = { why: 'wider', at: offAt }
  } else {
    if (from === 'project' && ask.held) {
      value = 'off'
      projectHeld = true
    } else if (local !== undefined && applies('project', from as LoadsSkillCopy, copies)) value = local
    if (from === 'account' && headOff(t.local)) {
      // rule 4: adding one here is the project's own click (skills.ts)
      offAt = 'project'
      project.result = 'off'
    } else project.result = value
    if (ctx.home) project.refused = { why: 'home' }
    else if (from === 'project') {
      project.positions = ['on', 'off']
      project.store = true
    } else project.positions = [...ALL]
  }
  lines.push(project)

  // each agent — the flag tier, carried at launch; it follows the project
  const agentLines = new Map<string, LoadsSkillLine>()
  for (const a of agents) {
    const flag = cleanEntries(a.payload)
    const e = flag?.skillOverrides && own(flag.skillOverrides, name) ? flag.skillOverrides[name] : undefined
    const line: LoadsSkillLine = { place: 'agent', agent: a.id, ...(e !== undefined ? { entry: e } : {}), result: value, ...reachOf('agent', copies) }
    if (lockedOrg) Object.assign(line, lockedOrg)
    else if (offAt) {
      line.result = 'off'
      line.locked = { why: 'wider', at: offAt }
    } else if (projectHeld) {
      line.result = 'off'
      line.locked = { why: 'wider', at: 'project' }
    } else if (from === 'account' && flag?.syncClaudeAiSkills === false) {
      line.result = 'off'
      line.locked = { why: 'wider', at: 'agent' }
    } else {
      line.result = e ?? value
      // a skill of the project: an agent only turns it off
      line.positions = from === 'project' ? ['on', 'off'] : [...ALL]
    }
    lines.push(line)
    agentLines.set(a.id, line)
  }

  // ONE conversation (its column) — the same flag tier, after its agent's
  // in the launch: it follows its agent's line (the project's when its
  // agent has none here), and its entry wins over its agent's both ways
  const c = ctx.carried?.conversation
  if (c) {
    const flag = cleanEntries(c.payload)
    const e = flag?.skillOverrides && own(flag.skillOverrides, name) ? flag.skillOverrides[name] : undefined
    const parent = c.agent !== undefined ? agentLines.get(c.agent) : undefined
    const above = parent?.result ?? value
    const line: LoadsSkillLine = {
      place: 'conversation',
      conversation: c.id,
      ...(c.agent !== undefined ? { agent: c.agent } : {}),
      ...(e !== undefined ? { entry: e } : {}),
      result: above,
      ...reachOf('agent', copies),
    }
    if (lockedOrg) Object.assign(line, lockedOrg)
    else if (offAt) {
      line.result = 'off'
      line.locked = { why: 'wider', at: offAt }
    } else if (projectHeld) {
      line.result = 'off'
      line.locked = { why: 'wider', at: 'project' }
    } else if (parent?.locked) {
      line.result = parent.result
      line.locked = parent.locked.why === 'wider' && parent.locked.at === 'agent' ? { why: 'wider', at: 'agent' } : parent.locked
    } else if (from === 'account' && flag?.syncClaudeAiSkills === false) {
      line.result = 'off'
      line.locked = { why: 'wider', at: 'conversation' }
    } else {
      line.result = e ?? above
      line.positions = from === 'project' ? ['on', 'off'] : [...ALL]
    }
    lines.push(line)
  }
  return lines
}

/** The context the lines are read in, for one folder (skills.ts reads the
 *  tiers, the logins' skills and the account's batches). */
export function skillPlacesContext(
  input: LoadsSkillsInput,
  read: { tiers: SkillTiers; personal: string[]; accounts: { login: string | null; skills: { name: string }[] }[] },
): SkillPlacesContext {
  const account = new Set(read.accounts.flatMap((a) => a.skills.map((s) => s.name)))
  return {
    tiers: read.tiers,
    personal: new Set(read.personal),
    account,
    project: new Set(projectSkillNames(input.folder)),
    loginOf: (name) => read.accounts.find((a) => a.skills.some((s) => s.name === name))?.login ?? null,
    home: isConfigHome(input.folder, input.home, input.configDirs ?? []),
    ...(input.carried ? { carried: input.carried } : {}),
  }
}

/** HarnessLoads.skillPlaces: every copy asked, its lines. */
export function skillPlacesOf(asks: readonly LoadsSkillAsk[], ctx: SkillPlacesContext): LoadsSkillPlaces[] {
  return asks.map((a) => ({ name: a.name, from: a.from, lines: skillLinesOf(a, ctx) }))
}
