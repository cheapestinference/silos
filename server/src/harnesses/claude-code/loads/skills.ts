// harnesses/claude-code/loads/skills.ts — the skills a claude.ai account
// sends, and the three positions Claude Code documents per folder for an
// account skill or a personal one (spec tools-origin §4, §7; measured on CLI
// 2.1.330, the spec's appendix):
//
//  · `skillOverrides: {"<name>": "on" | "name-only" | "user-invocable-only"
//    | "off"}` — "off" removes the skill, "name-only" keeps it listed
//    without its description (lighter, still callable). Silos writes three
//    positions — on (NO entry) · name-only · off — and shows, keeps and
//    never rewrites any other value it finds (`user-invocable-only`, or a
//    value a later engine adds) unless the owner picks a position on that
//    very row;
//  · `syncClaudeAiSkills: false` — the origin's head: every skill the
//    account sends is hidden for that folder (only `false`; read from
//    managed, local and user settings — not from .claude/settings.json).
//
// The account's skills sit under each login's own config dir:
// `<config dir>/skills/synced/<organizationUuid>_<accountUuid>/<name>/SKILL.md`
// — one BATCH per login, matched to its login by the account id a start
// recorded (account-batches.ts matchBatches), read by STRUCTURE only: a
// batch name that is not two ids, a dot entry, a file (manifest.json) or a
// directory without SKILL.md is skipped, never guessed at.
//
// Every write of the project's place goes through the one writer
// (local-settings.ts): the folder's local file only; the machine's place
// (spec scopes T9) through the user file's one writer (settings.ts
// editUserSettings), only on the click that names it; an agent's place is
// the payload Silos keeps (launch-entries.ts) — never the personal skills
// folder. Rule 12 (scopes §2): an entry is written only where the place
// differs from what it follows — «on» only over a wider «off» — and
// removed otherwise; a skill the engine locks (a plugin's, a reserved name)
// is refused before anything is tried (skill-places.ts).
// A switch writes or removes exactly its entry; rule 4 (§2): adding ONE
// account skill while the origin is off removes the origin key and writes
// «off» for every OTHER account skill known at the click — except a name
// your personal skills also carry (one entry would reach both).
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import {
  LoadsSwitchError,
  type LoadsBulkSwitch,
  type LoadsCarriedSwitch,
  type LoadsSkillBulkItem,
  type LoadsSkillAsk,
  type LoadsSkillLine,
  type LoadsSkillPlaces,
  type LoadsSkills,
  type LoadsSkillsInput,
  type LoadsSkillTarget,
  type LoadsSwitchAt,
} from '../../contract.js'
import { claudeManagedSettingsDir, managedFiles } from '../../../plugin-enablement.js'
import { editLocalSettings, HOME_REFUSAL, isConfigHome, type Json } from '../local-settings.js'
import { editUserSettings, UserSettingsError } from '../settings.js'
import { matchBatches } from './account-batches.js'
import { keptEntries, setSkillEntry, withLaunchEntries } from './launch-entries.js'
import { userSettingsPath } from './machine.js'
import { RESERVED_SKILL_NAMES, skillLinesOf, skillPlacesContext, skillPlacesOf, type SkillTiers } from './skill-places.js'
import { startLogins } from './start-logins.js'

/** The positions a switch writes; any other value found is kept. */
export const SKILL_POSITIONS = ['on', 'name-only', 'off'] as const
export type SkillPosition = (typeof SKILL_POSITIONS)[number]

const ORIGIN_KEY = 'syncClaudeAiSkills'
const OVERRIDES = 'skillOverrides'

const asObject = (v: unknown): Json | null => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Json) : null)
const own = (o: object | null | undefined, k: string): boolean => o != null && Object.prototype.hasOwnProperty.call(o, k)
const readJson = (path: string): Json | null => {
  try {
    return asObject(JSON.parse(readFileSync(path, 'utf8')))
  } catch {
    return null
  }
}
const isDir = (p: string): boolean => {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}
/** a name is data: set as an own property, never through a prototype setter */
const put = (o: Json, k: string, v: unknown): void => {
  Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true })
}

/** `<organizationUuid>_<accountUuid>`: two non-empty ids, no other `_`. */
const BATCH = /^([A-Za-z0-9-]+)_([A-Za-z0-9-]+)$/

export interface SkillBatch {
  dir: string
  organizationUuid: string
  accountUuid: string
  skills: { name: string; file: string }[]
}

/** The skills of one batch directory: each directory (or link) holding a SKILL.md. */
function batchSkills(dir: string): { name: string; file: string }[] {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  const out: { name: string; file: string }[] = []
  for (const n of names.sort()) {
    if (n.startsWith('.')) continue
    const file = join(dir, n, 'SKILL.md')
    if (isDir(join(dir, n)) && existsSync(file)) out.push({ name: n, file })
  }
  return out
}

/** Every skill batch under `<configDir>/skills/synced` (missing tree: none). */
export function readSkillBatches(configDir: string): SkillBatch[] {
  const root = join(configDir, 'skills', 'synced')
  let names: string[]
  try {
    names = readdirSync(root)
  } catch {
    return []
  }
  const out: SkillBatch[] = []
  for (const entry of names.sort()) {
    const m = BATCH.exec(entry)
    if (!m) continue
    const dir = join(root, entry)
    if (!isDir(dir)) continue
    out.push({ dir, organizationUuid: m[1]!, accountUuid: m[2]!, skills: batchSkills(dir) })
  }
  return out
}

/** The personal skills of a config dir: the top of `<configDir>/skills`
 *  (a directory or link with a SKILL.md; `synced` is the account's). */
export function personalSkillNames(configDir: string): string[] {
  const root = join(configDir, 'skills')
  let names: string[]
  try {
    names = readdirSync(root)
  } catch {
    return []
  }
  return names.filter((n) => n !== 'synced' && !n.startsWith('.') && existsSync(join(root, n, 'SKILL.md'))).sort()
}

/** The batch the engine loads on the login of `configDir`: the one named by
 *  the account id its `.claude.json` records (`oauthAccount.accountUuid` —
 *  `<home>/.claude.json` for the machine's login, `<configDir>/.claude.json`
 *  for a login of its own), else the only batch there; else none. */
export function loginSkillBatch(configDir: string, claudeJsonPath: string): SkillBatch | null {
  const batches = readSkillBatches(configDir)
  const id = asObject(readJson(claudeJsonPath)?.oauthAccount)?.accountUuid
  if (typeof id === 'string' && id !== '') {
    const hit = batches.find((b) => b.accountUuid === id)
    if (hit) return hit
  }
  return batches.length === 1 ? batches[0]! : null
}

// ---- the settings layers

type LayerId = 'managed' | 'flag' | 'local' | 'project' | 'user'
interface Layer {
  id: LayerId
  json: Json | null
}
const FILE: Record<Exclude<LayerId, 'local'>, string> = {
  managed: 'managed settings',
  flag: "the launch's settings",
  project: '.claude/settings.json',
  user: '~/.claude/settings.json',
}

/** The layers in the engine's precedence (managed first); `sources` drops
 *  the ones a launch does not read (an SDK turn's settingSources). */
export function skillLayers(folder: string, userSettingsPath: string, managedDir?: string, sources: readonly string[] = ['user', 'project', 'local']): Layer[] {
  const merged: Json = {}
  const overrides: Json = {}
  for (const j of managedFiles(managedDir ?? claudeManagedSettingsDir()).map(asObject)) {
    if (!j) continue
    Object.assign(merged, j)
    const o = asObject(j[OVERRIDES])
    if (o) for (const k of Object.keys(o)) put(overrides, k, o[k])
  }
  put(merged, OVERRIDES, overrides)
  const out: Layer[] = [{ id: 'managed', json: merged }]
  if (sources.includes('local')) out.push({ id: 'local', json: readJson(join(folder, '.claude', 'settings.local.json')) })
  if (sources.includes('project')) out.push({ id: 'project', json: readJson(join(folder, '.claude', 'settings.json')) })
  if (sources.includes('user')) out.push({ id: 'user', json: readJson(userSettingsPath) })
  return out
}

/** Whether the account's skills load here, and the file that turns them off. */
function originOf(layers: Layer[]): { on: boolean; by: LayerId | null; byOther: LayerId | null } {
  // the schema: only `false` means anything, and .claude/settings.json is not read
  const off = layers.filter((l) => l.id !== 'project' && l.json !== null && own(l.json, ORIGIN_KEY) && l.json[ORIGIN_KEY] === false)
  const other = off.find((l) => l.id !== 'local')?.id ?? null
  return { on: off.length === 0, by: off[0]?.id ?? null, byOther: other }
}

/** Per skill name: its value by precedence, and the file other than this
 *  folder's local one that names it (that file decides: no switch). */
function overridesOf(layers: Layer[]): Map<string, { value: string; layer: LayerId; other: LayerId | null }> {
  const out = new Map<string, { value: string; layer: LayerId; other: LayerId | null }>()
  for (const l of layers) {
    const o = asObject(l.json?.[OVERRIDES] ?? null)
    if (!o) continue
    for (const k of Object.keys(o)) {
      const v = o[k]
      if (typeof v !== 'string') continue
      const prev = out.get(k)
      if (!prev) out.set(k, { value: v, layer: l.id, other: l.id === 'local' ? null : l.id })
      else if (prev.other === null && l.id !== 'local') prev.other = l.id
    }
  }
  return out
}

/** THE skills one launch of Claude Code loads — an SDK turn or a console:
 *  the one answer the briefing's `has`, the skills note and a console's
 *  append all read (headless.ts sdkTurnSkills, server-hooks.ts
 *  consoleSkills), so the model is never pointed at a skill the engine
 *  refuses. Every source, every tier:
 *
 *  · the copies — the folder's own (`folderSkills`: `<cwd>/.claude/skills`,
 *    read when `sources` has `project`; a held copy is out of the folder),
 *    the login's personal skills and the batch its Claude account sends
 *    (when `sources` has `user`; the account's unless its head
 *    `syncClaudeAiSkills: false` is set where the engine reads it);
 *  · the tiers, by the engine's precedence — managed, then the launch's
 *    own flag tier (`flag`: the settings it carries — the files it skips,
 *    Silos' overlay, its agent's entries, its conversation's;
 *    local-holds.ts, launch-entries.ts), then the files it reads (local ›
 *    project › user). The first tier that names a skill decides, both ways:
 *    a narrower «on» restores what a wider «off» hid. `off` and
 *    `user-invocable-only` (the model can't call it) drop the name;
 *    `name-only` keeps it (still callable).
 *
 *  Measured (CLI 2.1.330/331, skill-places.ts): an entry from the LOCAL
 *  file whose name a personal skill and an account skill share hides only
 *  the personal one; from the flag tier it hides both. An entry reaches a
 *  folder copy (flag and local measured; the other files read the same
 *  key). A personal skill shadows a project copy of the same name — whether
 *  an «off» for the personal copy uncovers the folder's is not measured, so
 *  such a name is left out, never named on a guess. A name settings can't
 *  store (`__proto__`) takes no entry. A plugin's skills
 *  (`<plugin>:<name>`) take no entry either, and are not counted here.
 *  Pure reading. */
export function launchSkillNames(launch: {
  cwd: string
  sources: readonly string[]
  configDir: string
  claudeJsonPath: string
  managedDir?: string
  flag?: Json | null
  folderSkills: readonly string[]
}): string[] {
  const { cwd, sources, configDir, flag } = launch
  const read = skillLayers(cwd, join(configDir, 'settings.json'), launch.managedDir, sources)
  const layers: Layer[] = flag ? [read[0]!, { id: 'flag', json: flag }, ...read.slice(1)] : read
  const off = new Set<string>()
  const offForAccount = new Set<string>()
  const restricts = (v: string): boolean => v === 'off' || v === 'user-invocable-only'
  for (const [name, o] of overridesOf(layers)) {
    if (RESERVED_SKILL_NAMES.has(name) || !restricts(o.value)) continue
    off.add(name)
    if (o.layer !== 'local') offForAccount.add(name)
  }
  const keep = new Set<string>()
  if (sources.includes('project')) for (const n of launch.folderSkills) if (!off.has(n)) keep.add(n)
  if (sources.includes('user')) {
    const personal = personalSkillNames(configDir)
    const account = originOf(layers).on ? (loginSkillBatch(configDir, launch.claudeJsonPath)?.skills.map((s) => s.name) ?? []) : []
    for (const n of personal) if (!off.has(n)) keep.add(n)
    for (const n of account) {
      const shared = personal.includes(n)
      if (shared ? !offForAccount.has(n) : !off.has(n)) keep.add(n)
    }
  }
  return [...keep].sort()
}

// ---- the folder's reading (the skills catalog's account rows and positions)

const configDirsOf = (input: Pick<LoadsSkillsInput, 'home' | 'configDirs'>): string[] => [
  ...new Set([join(input.home, '.claude'), ...(input.configDirs ?? [])]),
]

export function claudeLoadsSkills(input: LoadsSkillsInput): LoadsSkills {
  const { folder, home } = input
  const layers = skillLayers(folder, join(home, '.claude', 'settings.json'), input.managedDir)
  const batches: SkillBatch[] = []
  for (const dir of configDirsOf(input)) for (const b of readSkillBatches(dir)) if (!batches.some((x) => x.accountUuid === b.accountUuid)) batches.push(b)
  const logins = batches.length > 0 ? startLogins(input.recentTranscripts()) : []
  const matches = matchBatches(
    batches,
    logins.map((l) => ({ key: l.accountUuid, accountUuid: l.accountUuid })),
  )
  const origin = originOf(layers)
  const home_ = isConfigHome(folder, home, input.configDirs ?? [])
  const personal = new Set(configDirsOf(input).flatMap(personalSkillNames))
  return {
    accounts: batches.map((b, i) => {
      const m = matches[i]
      return {
        login: m ? (logins.find((l) => l.accountUuid === m.login)?.email ?? null) : null,
        accountId: b.accountUuid,
        ...(m ? {} : { unmatched: true as const }),
        skills: b.skills,
      }
    }),
    origin: { on: origin.on, ...(origin.byOther ? { decidedBy: { file: FILE[origin.byOther as Exclude<LayerId, 'local'>], key: ORIGIN_KEY } } : {}) },
    // only managed settings decide over this project's file: a position the
    // machine or the repository's file gives is overridden here (scopes §6)
    overrides: [...overridesOf(layers)].map(([name, o]) => ({
      name,
      value: o.value,
      ...(o.other === 'managed' ? { decidedBy: { file: FILE.managed, key: `${OVERRIDES}.${name}` } } : {}),
    })),
    personal: [...personal].sort(),
    ...(home_ ? { refused: { why: 'home' as const } } : {}),
  }
}

/** The local file's `skillOverrides`, refused when it is not an object. */
function localOverrides(s: Json, file: string): Json {
  if (!own(s, OVERRIDES)) return {}
  const o = asObject(s[OVERRIDES])
  if (o === null) throw new LoadsSwitchError(`${OVERRIDES} in ${file} is not an object — fix it by hand; Silos won't overwrite it`, 409)
  const copy: Json = {}
  for (const k of Object.keys(o)) put(copy, k, o[k])
  return copy
}
const setOverrides = (s: Json, o: Json): void => {
  if (Object.keys(o).length > 0) s[OVERRIDES] = o
  else delete s[OVERRIDES]
}

/** The tiers of one folder, as skill-places.ts reads them. */
function tiersOf(folder: string, home: string, managedDir?: string): SkillTiers {
  const layers = skillLayers(folder, userSettingsPath(home), managedDir)
  const of = (id: LayerId): Json | null => layers.find((l) => l.id === id)?.json ?? null
  return { managed: of('managed'), local: of('local'), repository: of('project'), user: of('user') }
}

/** HarnessLoads.skillPlaces for Claude Code. */
export function claudeSkillPlaces(input: LoadsSkillsInput, asks: readonly LoadsSkillAsk[]): LoadsSkillPlaces[] {
  const state = claudeLoadsSkills(input)
  return skillPlacesOf(
    asks,
    skillPlacesContext(input, { tiers: tiersOf(input.folder, input.home, input.managedDir), personal: state.personal, accounts: state.accounts }),
  )
}

/** Why a skill line can't take a click — the words of the 409. */
function lineRefusal(name: string, l: LoadsSkillLine | undefined, where: string): string {
  if (!l) return `"${name}" has no line ${where} — a skill of the project exists in one project; switch it there`
  if (l.locked?.why === 'engine') {
    return l.locked.reason === 'plugin'
      ? `"${name}" comes with its plugin — Claude Code ignores a position for a plugin's skill; switch the plugin in Tools`
      : `"${name}" is a name settings can't store — Claude Code ignores any position for it; nothing is written`
  }
  if (l.locked?.why === 'organization') return `"${name}" is decided by your organization's managed settings — no place here can change it`
  if (l.locked?.why === 'wider') {
    if (l.locked.at === 'project' && (l.place === 'agent' || l.place === 'conversation'))
      return `"${name}" is off in this project — ${l.place === 'agent' ? 'an agent' : 'a conversation'} can't bring it back on alone`
    const at =
      l.locked.at === 'machine'
        ? 'for this whole machine'
        : l.locked.at === 'project'
          ? 'in this project'
          : l.locked.at === 'conversation'
            ? 'for this conversation'
            : `for the agent "${l.agent ?? 'its agent'}"`
    return `the skills your Claude account sends are off ${at} — "${name}" can't be turned back on below it`
  }
  if (l.refused?.why === 'home') return HOME_REFUSAL
  return `"${name}" has no such position ${where}`
}

/** What a place follows: the line above it in the chain (an agent's: the project's). */
function followsOf(lines: LoadsSkillLine[], l: LoadsSkillLine): string {
  // a conversation: its agent's line (the project's when its agent has none)
  if (l.place === 'conversation')
    return (
      lines.find((x) => x.place === 'agent' && l.agent !== undefined && x.agent === l.agent)?.result ?? lines.find((x) => x.place === 'project')?.result ?? 'on'
    )
  if (l.place === 'agent') return lines.find((x) => x.place === 'project')?.result ?? 'on'
  const i = lines.indexOf(l)
  const above = lines
    .slice(0, i)
    .reverse()
    .find((x) => x.place === 'machine' || x.place === 'fact')
  return above?.result ?? 'on'
}

const refusedShape = (): never => {
  throw new LoadsSwitchError(`${OVERRIDES} in ~/.claude/settings.json is not an object — kept as it is; change it in that file`, 409)
}

const projectHas = (folder: string, name: string): boolean => existsSync(join(folder, '.claude', 'skills', name, 'SKILL.md'))

/** One skill to a position, or the account origin on/off, for NEW
 *  conversations in the folder — at the project (its local file, the
 *  default), the machine (the user's own file) or one agent (the payload
 *  Silos keeps, returned: nothing is written). Rule 12: what the place
 *  follows anyway is no entry. Idempotent. 404 an unknown name or agent;
 *  409 a home folder, managed settings, a skill the engine locks, a line a
 *  wider head locks, a `skillOverrides` that is not an object. */
export function claudeSkillSwitch(
  input: LoadsSkillsInput,
  target: LoadsSkillTarget,
  to: string,
  at?: LoadsSwitchAt,
  collect?: SkillCollect,
): LoadsCarriedSwitch | void {
  const { folder, home } = input
  const configDirs = input.configDirs ?? []
  const scope = at?.scope ?? 'project'
  if (scope !== 'project' && scope !== 'machine' && scope !== 'agent' && scope !== 'conversation')
    throw new LoadsSwitchError(`a skill has no place "${scope}" here`, 409)
  if (target.kind === 'origin' && scope !== 'project')
    throw new LoadsSwitchError('the skills your Claude account sends switch as a whole in this project only, for now', 409)
  if (scope === 'project' && isConfigHome(folder, home, configDirs)) throw new LoadsSwitchError(HOME_REFUSAL, 409)
  const state = claudeLoadsSkills(input)
  const file = '.claude/settings.local.json'

  if (target.kind === 'origin') {
    if (to !== 'on' && to !== 'off') throw new LoadsSwitchError("to must be 'on' or 'off'", 409)
    if (state.origin.decidedBy)
      throw new LoadsSwitchError(
        `the skills your Claude account sends are turned off by ${state.origin.decidedBy.key} in ${state.origin.decidedBy.file} — change it in that file; Silos only writes this project's local settings`,
        409,
      )
    editLocalSettings(
      folder,
      home,
      (s) => {
        if (to === 'off') {
          if (own(s, ORIGIN_KEY) && s[ORIGIN_KEY] === false) return false
          s[ORIGIN_KEY] = false
          return true
        }
        // «On» removes the origin key and nothing else
        if (!(own(s, ORIGIN_KEY) && s[ORIGIN_KEY] === false)) return false
        delete s[ORIGIN_KEY]
        return true
      },
      configDirs,
    )
    return
  }

  if (!(SKILL_POSITIONS as readonly string[]).includes(to)) throw new LoadsSwitchError(`a skill's position is one of ${SKILL_POSITIONS.join(' · ')}`, 409)
  const position = to as SkillPosition
  const name = target.name
  const from = target.from
  const accountNames = new Set(state.accounts.flatMap((a) => a.skills.map((s) => s.name)))
  const known = from === 'account' ? accountNames.has(name) : from === 'personal' ? state.personal.includes(name) : projectHas(folder, name)
  if (!known)
    throw new LoadsSwitchError(
      `"${name}" is not ${from === 'account' ? 'a skill your Claude account sends' : from === 'personal' ? 'one of your personal skills' : 'a skill of this project'} here`,
      404,
    )
  if (scope === 'agent' && !(input.carried?.agents ?? []).some((a) => a.id === at?.agent))
    throw new LoadsSwitchError(`"${at?.agent ?? ''}" is not an agent of this project`, 404)
  if (scope === 'conversation' && !input.carried?.conversation) throw new LoadsSwitchError('no conversation here to switch for', 404)
  // the lines as the engine reads them now — what each place follows and
  // what locks it; a launch place's with the payload it was handed (the
  // allowlist on the way in)
  const payload = scope === 'agent' || scope === 'conversation' ? keptEntries(at?.payload) : null
  const carried =
    scope === 'agent'
      ? { ...input.carried!, agents: input.carried!.agents.map((a) => (a.id === at?.agent ? { id: a.id, payload } : a)) }
      : scope === 'conversation'
        ? { ...input.carried!, conversation: { ...input.carried!.conversation!, payload } }
        : input.carried
  const lines = skillLinesOf(
    { name, from },
    skillPlacesContext(
      { ...input, ...(carried ? { carried } : {}) },
      { tiers: tiersOf(folder, home, input.managedDir), personal: state.personal, accounts: state.accounts },
    ),
  )
  const line = scope === 'agent' ? lines.find((l) => l.place === 'agent' && l.agent === at?.agent) : lines.find((l) => l.place === scope)
  const where =
    scope === 'machine'
      ? 'for this machine'
      : scope === 'agent'
        ? `for the agent "${at?.agent ?? ''}"`
        : scope === 'conversation'
          ? 'for this conversation'
          : 'in this project'
  // a skill the engine locks: nothing is tried
  if (!line || line.locked) throw new LoadsSwitchError(lineRefusal(name, line, where), 409)
  const follows = followsOf(lines, line)

  if (scope === 'agent' || scope === 'conversation') {
    if (position === follows) {
      const r = setSkillEntry(payload, name, null)
      return { payload: r.payload, changed: r.changed, held: false }
    }
    if (!line.positions?.includes(position))
      throw new LoadsSwitchError(`"${name}" is a skill of this project — ${scope === 'agent' ? 'an agent' : 'a conversation'} can only turn it off`, 409)
    const r = setSkillEntry(payload, name, position)
    return { payload: r.payload, changed: r.changed, held: true }
  }

  if (scope === 'machine') {
    if (!line.positions?.includes(position)) throw new LoadsSwitchError(lineRefusal(name, line, where), 409)
    const editUser = (m: (s: Json) => boolean): void => {
      if (collect) collect('user', m)
      else writeUser(home, m)
    }
    {
      editUser((s) => {
        if (own(s, OVERRIDES) && asObject(s[OVERRIDES]) === null) refusedShape()
        const o: Json = {}
        const prior = asObject(own(s, OVERRIDES) ? s[OVERRIDES] : null)
        if (prior) for (const k of Object.keys(prior)) put(o, k, prior[k])
        // the broadest place follows the skill's own default: «on» is no entry
        if (position === follows) {
          if (!own(o, name)) return false
          delete o[name]
        } else {
          if (own(o, name) && o[name] === position) return false
          put(o, name, position)
        }
        if (Object.keys(o).length > 0) s[OVERRIDES] = o
        else delete s[OVERRIDES]
        return true
      })
    }
    return
  }

  // this project's local file
  if (from === 'project')
    throw new LoadsSwitchError(
      `"${name}" is this project's own copy — it is turned off and on by moving it out of the folder and back (its switch in Skills)`,
      409,
    )
  // adding one account skill while the origin is off (rule 4)
  const adding = from === 'account' && !state.origin.on && position !== 'off'
  if (adding && state.origin.decidedBy)
    throw new LoadsSwitchError(
      `the skills your Claude account sends are turned off by ${state.origin.decidedBy.key} in ${state.origin.decidedBy.file} — change it in that file; Silos only writes this project's local settings`,
      409,
    )
  const personal = new Set(state.personal)
  const editLocal = (m: (s: Json) => boolean): void => {
    if (collect) collect('local', m)
    else editLocalSettings(folder, home, m, configDirs)
  }
  editLocal((s) => {
    const o = localOverrides(s, file)
    let changed = false
    // rule 12: what the project follows anyway is no entry — «on» is
    // written only over a wider «off» (the machine's, the repository's)
    if (position === follows) {
      if (own(o, name)) {
        delete o[name]
        changed = true
      }
    } else if (!(own(o, name) && o[name] === position)) {
      put(o, name, position)
      changed = true
    }
    if (adding) {
      for (const other of [...accountNames].sort()) {
        if (other === name || own(o, other) || personal.has(other)) continue
        put(o, other, 'off')
        changed = true
      }
      if (own(s, ORIGIN_KEY) && s[ORIGIN_KEY] === false) {
        delete s[ORIGIN_KEY]
        changed = true
      }
    }
    if (!changed) return false
    setOverrides(s, o)
    return true
  })
}

/** A file place's mutation, collected by a bulk click that writes once. */
export type SkillCollect = (file: 'local' | 'user', mutate: (s: Json) => boolean) => void

/** The user's own file, through its one writer — its refusals as a 409. */
function writeUser(home: string, mutate: (s: Json) => boolean): void {
  try {
    editUserSettings(userSettingsPath(home), mutate)
  } catch (err) {
    if (err instanceof UserSettingsError) throw new LoadsSwitchError(err.message, 409)
    throw err
  }
}

/** HarnessLoads.skillSwitchMany for Claude Code (spec scopes §4): every
 *  item at ONE place in ONE write — the project's local file or the user's
 *  own file written once (the mutations each switch would make, collected),
 *  a launch place's payload answered once. An item with `to` changes as its
 *  own switch would (rule 12); one with `entry` (the undo) puts that exact
 *  entry back (null: none). One item refused refuses the whole click before
 *  anything is written. */
export function claudeSkillSwitchMany(input: LoadsSkillsInput, items: readonly LoadsSkillBulkItem[], at?: LoadsSwitchAt): LoadsBulkSwitch | void {
  const scope = at?.scope ?? 'project'
  if (scope === 'agent' || scope === 'conversation') {
    let payload: unknown = keptEntries(at?.payload)
    let changed = false
    const rows: LoadsBulkSwitch['rows'] = []
    for (const it of items) {
      let r: LoadsCarriedSwitch
      if ('to' in it) {
        const a = claudeSkillSwitch(input, { kind: 'skill', name: it.name, from: it.from }, it.to, { ...at!, payload })
        if (!a) continue
        r = a
      } else {
        const e = it.entry !== null && (SKILL_POSITIONS as readonly string[]).includes(it.entry) ? (it.entry as SkillPosition) : null
        const s = setSkillEntry(payload, it.name, e)
        r = { payload: s.payload, changed: s.changed, held: e !== null }
      }
      payload = r.payload
      changed ||= r.changed
      if (r.changed) rows.push({ key: it.name, held: r.held })
    }
    return { payload, changed, held: rows.some((r) => r.held), rows, origins: [] }
  }
  if (scope !== 'project' && scope !== 'machine') throw new LoadsSwitchError(`a skill has no place "${scope}" here`, 409)
  const mutations: ((s: Json) => boolean)[] = []
  const collect: SkillCollect = (_file, m) => {
    mutations.push(m)
  }
  for (const it of items) {
    if ('to' in it) claudeSkillSwitch(input, { kind: 'skill', name: it.name, from: it.from }, it.to, at, collect)
    else {
      if (RESERVED_SKILL_NAMES.has(it.name)) throw new LoadsSwitchError(`"${it.name}" is a name settings can't store — nothing is written`, 409)
      const entry = it.entry
      const where = scope === 'machine' ? '~/.claude/settings.json' : '.claude/settings.local.json'
      mutations.push((s) => {
        if (scope === 'machine' && own(s, OVERRIDES) && asObject(s[OVERRIDES]) === null) refusedShape()
        const o = localOverrides(s, where)
        if (entry === null) {
          if (!own(o, it.name)) return false
          delete o[it.name]
        } else {
          if (own(o, it.name) && o[it.name] === entry) return false
          put(o, it.name, entry)
        }
        setOverrides(s, o)
        return true
      })
    }
  }
  if (mutations.length === 0) return
  const all = (s: Json): boolean => {
    let changed = false
    for (const m of mutations) changed = m(s) || changed
    return changed
  }
  if (scope === 'machine') writeUser(input.home, all)
  else editLocalSettings(input.folder, input.home, all, input.configDirs ?? [])
}

/** The flag tier's skill keys a launch carries — what Silos keeps for its
 *  places, through the allowlist (a heartbeat: only what removes). */
export function carriedSkillKeys(payloads: readonly unknown[] | undefined, onlyRemoves = false): Json | null {
  if (!payloads || payloads.length === 0) return null
  const s = withLaunchEntries({}, payloads, { onlyRemoves })
  return Object.keys(s).length > 0 ? s : null
}
