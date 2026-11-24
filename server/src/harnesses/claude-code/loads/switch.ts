// harnesses/claude-code/loads/switch.ts — Harness.loads.switch for Claude
// Code: one row of the inventory turned off or on for NEW conversations in a
// folder, through the one writer (local-settings.ts) and only the keys the
// engine documents per folder (spec tools-origin §4, §7):
//
//  · a .mcp.json server      — `disabledMcpjsonServers: [<name>]`
//  · a plugin you installed  — `enabledPlugins: {"<name>@<marketplace>": false}`
//  · an account plugin       — `enabledPlugins: {"<manifest name>@synced": false}`
//  · a plugin's MCP server   — `deniedMcpServers: [{"serverName": "plugin:<plugin>:<server>"}]`,
//                              every live copy's name for an address several plugins ship
//  · a server of yours       — `deniedMcpServers: [{"serverName": "<name>"}]`
//                              (~/.claude.json is read, never written)
//  · a claude.ai connector   — `deniedMcpServers: [{"serverName": "claude.ai <Name>"}]`
//
//
// Rule 4 (spec tools-origin §2, §7): «Add» on a row whose account origin is
// off in this folder's own file removes the origin's key and writes the
// item-level «off» for every OTHER item of that origin known at the click —
// the other account plugins on disk, the other connectors of the logins'
// lists — so adding one never turns on another; what the account sends
// later loads. The added plugin comes whole: no hold is written on its
// servers. An origin's head (`claudeLoadsOriginSwitch`): «Off» writes only
// the origin's key, «On» removes only it.
//
// The row decides: no switch on the row → 409 saying what decides (another
// file, managed settings, an engine older than the switch was confirmed on,
// a home folder, a name only its tools carry). Only the engine's exact names
// are written, only what a switch owns is removed, every other key is kept;
// a second click in the same direction writes nothing.
//
// `at` (spec scopes §9): absent or `project` — the folder's local file, as
// above (a plugin the machine or the repository's file keeps off is turned
// ON here: an override kind; an off-only kind the machine keeps off is
// refused, saying where). `machine` — the user's own file (machine.ts). A
// launch place (`agent`) — the payload Silos keeps (claudeLaunchSwitch).
import {
  LoadsSwitchError,
  type LoadsBulkSet,
  type LoadsBulkSwitch,
  type LoadsCarriedSwitch,
  type LoadsInput,
  type LoadsLine,
  type LoadsOrigin,
  type LoadsOriginId,
  type LoadsRow,
  type LoadsSwitchAt,
} from '../../contract.js'
import { HEAD_OFF, keptEntries, setEntry, type HeadKey } from './launch-entries.js'
import { claudeMachineHeadSwitch, HEAD_OF, HEAD_WORDS } from './heads.js'
import { editLocalSettings, HOME_REFUSAL, isConfigHome, type Json } from '../local-settings.js'
import { claudeLoadsState } from './inventory.js'
import { claudeMachineSwitch, writeUser } from './machine.js'

const own = (o: object | null | undefined, k: string): boolean => o != null && Object.prototype.hasOwnProperty.call(o, k)
const asObject = (v: unknown): Json | null => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Json) : null)
const listOf = (s: Json, k: string): unknown[] => (own(s, k) && Array.isArray(s[k]) ? (s[k] as unknown[]) : [])
const setList = (s: Json, k: string, list: unknown[]): void => {
  if (list.length > 0) s[k] = list
  else delete s[k]
}

/** What decides a row that has no switch — the words of the 409. */
function refusal(r: LoadsRow): string {
  if (r.refused?.why === 'home') return HOME_REFUSAL
  if (r.refused?.why === 'engine') return `"${r.label}" is switched with Claude Code ${r.refused.needs} or later — update Claude Code (Settings › Engines)`
  // an off-only kind the machine keeps off: a narrower place can't bring it back
  if (r.family === 'off-only' && r.at?.find((l) => l.place === 'project')?.locked?.at === 'machine') {
    const what = r.kind === 'connector' ? 'a connector' : 'an MCP server'
    return `"${r.label}" is off for this whole machine (${r.decidedBy?.key ?? 'deniedMcpServers'} in ${r.decidedBy?.file ?? '~/.claude/settings.json'}) — ${what} can't be turned back on for one project; turn it on for this machine in «Where it loads»`
  }
  if (r.decidedBy)
    return `"${r.label}" is decided by ${r.decidedBy.key} in ${r.decidedBy.file} — change it in that file; Silos only writes this project's local settings`
  if (!r.exact) return `only the name "${r.label}"'s tools carry is known — no switch until a reading gives its exact name`
  if (r.placeholder) return `"${r.label}" is a placeholder — nothing loads, nothing to switch`
  if (r.replacedBy) return `another copy of "${r.label}" loads in its place — switch that one`
  if (r.parent) return `"${r.label}" comes and goes with its plugin — switch the plugin`
  return `"${r.label}" has no switch in this project`
}

/** A `{serverName}` entry naming exactly `name` and nothing else — the only
 *  deny entry a switch owns (a hand-written entry with more keys is kept). */
const ownedDeny = (e: unknown, name: string): boolean => {
  const o = asObject(e)
  return o !== null && Object.keys(o).length === 1 && o.serverName === name
}
const deniesName = (e: unknown, name: string): boolean => asObject(e)?.serverName === name

/** A file place's write: the one writer handed the mutation (a bulk click
 *  collects them and writes once — claudeLoadsSwitchMany). */
export type FileEdit = (mutate: (s: Json) => boolean) => void

export function claudeLoadsSwitch(input: LoadsInput, key: string, to: 'on' | 'off', at?: LoadsSwitchAt, editWith?: FileEdit): LoadsCarriedSwitch | void {
  // the user's own file — only on the click that names the machine
  if (at?.scope === 'machine') return claudeMachineSwitch(input, key, to, editWith)
  if (at && at.scope !== 'project') return claudeLaunchSwitch(input, key, to, at)
  const { folder, home } = input
  const edit: FileEdit =
    editWith ??
    ((m) => {
      editLocalSettings(folder, home, m)
    })
  if (isConfigHome(folder, home)) throw new LoadsSwitchError(HOME_REFUSAL, 409)
  const { inventory, beneath } = claudeLoadsState(input)
  const row = inventory.rows.find((r) => r.key === key)
  if (!row) throw new LoadsSwitchError(`unknown row "${key}" — not among what this folder loads`, 404)
  if (!row.switch) throw new LoadsSwitchError(refusal(row), 409)
  const names = row.switch.names
  const off = to === 'off'
  const originOff = (id: LoadsOriginId): boolean => inventory.origins?.find((o) => o.id === id)?.on === false
  // the other items of an account origin known at the click (rule 4)
  const othersOf = (kind: LoadsRow['kind']): string[] =>
    [...new Set(inventory.rows.filter((r) => r.kind === kind && r.origin.owner === 'account' && r.exact && r.name !== row.name).map((r) => r.name))].sort()

  if (row.kind === 'plugin' && row.origin.owner === 'account' && !off && originOff('plugins')) {
    const id = names[0]!
    const others = othersOf('plugin')
    const under = beneath(id)
    edit((s) => {
      const plugins: Json = { ...(asObject(own(s, 'enabledPlugins') ? s.enabledPlugins : null) ?? {}) }
      for (const o of others) plugins[o] = false
      delete plugins[id]
      if (!under.enabled) plugins[id] = true
      if (Object.keys(plugins).length > 0) s.enabledPlugins = plugins
      else delete s.enabledPlugins
      delete s[ORIGIN_KEY.plugins]
      return true
    })
    return
  }

  if (row.kind === 'connector' && !off && originOff('connectors')) {
    const name = names[0]!
    const others = othersOf('connector')
    edit((s) => {
      const list = listOf(s, 'deniedMcpServers').filter((e) => !ownedDeny(e, name))
      setList(s, 'deniedMcpServers', [...list, ...others.filter((n) => !list.some((e) => deniesName(e, n))).map((serverName) => ({ serverName }))])
      delete s[ORIGIN_KEY.connectors]
      return true
    })
    return
  }

  if (row.kind === 'plugin') {
    const id = names[0]!
    const under = beneath(id)
    edit((s) => {
      const plugins: Json = { ...(asObject(own(s, 'enabledPlugins') ? s.enabledPlugins : null) ?? {}) }
      if (off) {
        if (own(plugins, id) && plugins[id] === false) return false
        plugins[id] = false
      } else if (under.enabled) {
        // what lies beneath is on: the local entry goes, nothing is added
        if (!own(plugins, id)) return false
        delete plugins[id]
      } else {
        // its manifest starts it off and no other file switches it on
        if (own(plugins, id) && plugins[id] === true) return false
        plugins[id] = true
      }
      if (Object.keys(plugins).length > 0) s.enabledPlugins = plugins
      else delete s.enabledPlugins
      return true
    })
    return
  }

  if (row.key.startsWith('mcp:project:')) {
    const name = names[0]!
    edit((s) => {
      const list = listOf(s, 'disabledMcpjsonServers')
      const has = list.includes(name)
      if (off === has) return false
      setList(s, 'disabledMcpjsonServers', off ? [...list, name] : list.filter((n) => n !== name))
      return true
    })
    return
  }

  // a plugin's server, a server of yours, a connector: denied by name
  edit((s) => {
    const list = listOf(s, 'deniedMcpServers')
    if (off) {
      const add = names.filter((n) => !list.some((e) => deniesName(e, n)))
      if (add.length === 0) return false
      setList(s, 'deniedMcpServers', [...list, ...add.map((serverName) => ({ serverName }))])
      return true
    }
    const kept = list.filter((e) => !names.some((n) => ownedDeny(e, n)))
    if (kept.length === list.length) return false
    setList(s, 'deniedMcpServers', kept)
    return true
  })
}

/** The origins' keys and the value that turns each off (heads.ts). */
const ORIGIN_KEY: Record<LoadsOriginId, HeadKey> = HEAD_OF
const OFF_VALUE: Record<LoadsOriginId, boolean> = {
  plugins: HEAD_OFF.syncClaudeAiPlugins,
  skills: HEAD_OFF.syncClaudeAiSkills,
  connectors: HEAD_OFF.disableClaudeAiConnectors,
}
const ORIGIN_WORDS: Record<LoadsOriginId, string> = HEAD_WORDS

function originRefusal(o: LoadsOrigin): string {
  if (o.refused?.why === 'home') return HOME_REFUSAL
  if (o.refused?.why === 'engine')
    return `${ORIGIN_WORDS[o.id]} are switched with Claude Code ${o.refused.needs} or later — update Claude Code (Settings › Engines)`
  if (o.decidedBy)
    return `${ORIGIN_WORDS[o.id]} are turned off by ${o.decidedBy.key} in ${o.decidedBy.file} — change it in that file; Silos only writes this project's local settings`
  return `${ORIGIN_WORDS[o.id]} have no switch in this project`
}

/** An origin's head, for NEW conversations in the folder: «off» writes only
 *  its key, «on» removes only it (a value Silos doesn't write is kept).
 *  Idempotent. 409 a home folder, another file, an engine too old. */
export function claudeLoadsOriginSwitch(
  input: LoadsInput,
  origin: LoadsOriginId,
  to: 'on' | 'off',
  at?: LoadsSwitchAt,
  editWith?: FileEdit,
): LoadsCarriedSwitch | void {
  // the user's own file — only on the click that names the machine
  if (at?.scope === 'machine') return claudeMachineHeadSwitch(input, origin, to, at.confirmed === true, editWith)
  if (at && at.scope !== 'project') return claudeLaunchOriginSwitch(input, origin, to, at)
  const { folder, home } = input
  const edit: FileEdit =
    editWith ??
    ((m) => {
      editLocalSettings(folder, home, m)
    })
  if (isConfigHome(folder, home)) throw new LoadsSwitchError(HOME_REFUSAL, 409)
  const o = claudeLoadsState(input).inventory.origins?.find((x) => x.id === origin)
  if (!o) throw new LoadsSwitchError(`unknown origin "${origin}"`, 404)
  if (!o.switch) throw new LoadsSwitchError(originRefusal(o), 409)
  const key = ORIGIN_KEY[origin],
    value = OFF_VALUE[origin]
  edit((s) => {
    const set = own(s, key) && s[key] === value
    if (to === 'off') {
      if (set) return false
      s[key] = value
      return true
    }
    if (!set) return false
    delete s[key]
    return true
  })
}

/** An origin's head for one launch place (an agent): its key in the
 *  payload Silos keeps, «off» set, «on» removed — refused where a wider
 *  place keeps the head off (an off-only key). Writes nothing. */
function claudeLaunchOriginSwitch(input: LoadsInput, origin: LoadsOriginId, to: 'on' | 'off', at: LoadsSwitchAt): LoadsCarriedSwitch {
  if (at.scope !== 'agent' || typeof at.agent !== 'string') throw new LoadsSwitchError('only an agent’s place is switched here', 409)
  const agentId = at.agent
  if (!(input.carried?.agents ?? []).some((a) => a.id === agentId)) throw new LoadsSwitchError(`"${agentId}" is not an agent of this project`, 404)
  const payload = keptEntries(at.payload)
  const carried = { ...input.carried!, agents: input.carried!.agents.map((a) => (a.id === agentId ? { id: a.id, payload } : a)) }
  const o = claudeLoadsState({ ...input, carried }).inventory.origins?.find((x) => x.id === origin)
  if (!o) throw new LoadsSwitchError(`unknown origin "${origin}"`, 404)
  const line = o.at?.find((l) => l.place === 'agent' && l.agent === agentId)
  if (!line) throw new LoadsSwitchError(`${ORIGIN_WORDS[origin]} have no line for the agent "${agentId}"`, 409)
  const k = { key: 'head' as const, name: ORIGIN_KEY[origin] }
  if (to === 'on') {
    const r = setEntry(payload, k, null)
    // a wider place keeps the whole head off: removing the agent's own
    // entry is fine, but it can't be turned on for this agent alone
    if (!r.changed && line.locked)
      throw new LoadsSwitchError(
        `${ORIGIN_WORDS[origin]} are off ${line.locked.why === 'organization' ? 'by your organization' : line.locked.at === 'machine' ? 'for this whole machine' : 'in this project'} — they can't be turned back on for the agent "${agentId}" alone`,
        409,
      )
    return { payload: r.payload, changed: r.changed, held: false }
  }
  // a wider place keeps it off already: this agent follows it, no entry (rule 12)
  if (line.locked) {
    const r = setEntry(payload, k, null)
    return { payload: r.payload, changed: r.changed, held: false }
  }
  if (!line.switch) throw new LoadsSwitchError(`${ORIGIN_WORDS[origin]} have no switch for the agent "${agentId}"`, 409)
  const r = setEntry(payload, k, 'off')
  return { payload: r.payload, changed: r.changed, held: true }
}

/** Why a launch line can't take the click — the words of the 409. */
function launchRefusal(r: LoadsRow, l: LoadsLine, who: string): string {
  const noun = r.kind === 'connector' ? 'a connector' : r.kind === 'plugin' ? 'a plugin' : 'an MCP server'
  if (l.locked?.why === 'organization') return `"${r.label}" is decided by your organization's managed settings — no place here can change it`
  if (l.locked?.why === 'wider') {
    const where =
      l.locked.at === 'machine'
        ? 'on this machine'
        : l.locked.at === 'project'
          ? 'in this project'
          : l.locked.at === 'agent'
            ? `for the agent "${l.agent ?? 'its agent'}"`
            : 'in a file above this project'
    return `"${r.label}" is off ${where} — ${noun} can't be turned back on for ${who} alone`
  }
  if (r.replacedBy) return `another copy of "${r.label}" loads in its place — switch that one`
  if (r.placeholder) return `"${r.label}" is a placeholder — nothing loads, nothing to switch`
  if (r.parent) return `"${r.label}" comes and goes with its plugin — switch the plugin for ${who}`
  if (r.refused?.why === 'engine') return `"${r.label}" is switched with Claude Code ${r.refused.needs} or later — update Claude Code (Settings › Engines)`
  return `"${r.label}" has no switch for ${who}`
}

/** One row for one launch place — an agent, or one conversation (its
 *  thread): its entry in the payload Silos keeps for it, set where the
 *  place differs from what it follows (an agent: the project's line; a
 *  conversation: its agent's) and removed where it does not (rule 12).
 *  Writes nothing: the new payload is returned, cleaned by the allowlist. */
function claudeLaunchSwitch(input: LoadsInput, key: string, to: 'on' | 'off', at: LoadsSwitchAt): LoadsCarriedSwitch {
  // the payload as the engine takes it — the allowlist on the way in
  const payload = keptEntries(at.payload)
  let carried: NonNullable<LoadsInput['carried']>
  let who: string
  let mine: (l: LoadsLine) => boolean
  let followed: (l: LoadsLine) => boolean
  if (at.scope === 'agent') {
    if (typeof at.agent !== 'string') throw new LoadsSwitchError('an agent’s place needs its agent', 409)
    const agentId = at.agent
    if (!(input.carried?.agents ?? []).some((a) => a.id === agentId)) throw new LoadsSwitchError(`"${agentId}" is not an agent of this project`, 404)
    carried = { ...input.carried!, agents: input.carried!.agents.map((a) => (a.id === agentId ? { id: a.id, payload } : a)) }
    who = `the agent "${agentId}"`
    mine = (l) => l.place === 'agent' && l.agent === agentId
    followed = (l) => l.place === 'project'
  } else if (at.scope === 'conversation') {
    const conv = input.carried?.conversation
    if (!conv) throw new LoadsSwitchError('no conversation here to switch for', 404)
    carried = { agents: input.carried?.agents ?? [], conversation: { ...conv, payload } }
    who = 'this conversation'
    mine = (l) => l.place === 'conversation' && l.conversation === conv.id
    // its agent's line when the folder has one for it, else the project's
    const agentLine = conv.agent !== undefined && carried.agents.some((a) => a.id === conv.agent)
    followed = agentLine ? (l) => l.place === 'agent' && l.agent === conv.agent : (l) => l.place === 'project'
  } else throw new LoadsSwitchError('no such place', 409)
  const { inventory, launchOf } = claudeLoadsState({ ...input, carried })
  const row = inventory.rows.find((r) => r.key === key)
  if (!row) throw new LoadsSwitchError(`unknown row "${key}" — not among what this folder loads`, 404)
  const line = row.at?.find(mine)
  const launch = launchOf(key)
  if (!line || !launch) throw new LoadsSwitchError(refusal(row), 409)
  const follows = row.at!.find(followed)?.result ?? 'on'
  // rule 4 at this place: «on» for one account thing whose head this agent
  // keeps off removes the agent's head and writes «off» for every OTHER
  // known item of that origin, for this agent — adding one never turns on
  // another; what the account sends later loads for it
  if (to === 'on' && line.headOff && line.switch && !line.locked) {
    const head = row.kind === 'connector' ? ('connectors' as const) : ('plugins' as const)
    let step = setEntry(payload, { key: 'head', name: ORIGIN_KEY[head] }, null)
    let changed = step.changed
    for (const other of inventory.rows) {
      if (other.key === row.key || other.kind !== row.kind || other.origin.owner !== 'account' || other.parent || !other.exact) continue
      const k = launchOf(other.key)?.key
      if (!k) continue
      step = setEntry(step.payload, k, 'off')
      changed ||= step.changed
    }
    // its own entry last (a namesake's «off» above never takes it): what
    // the project's line gives it, or an override «on»
    step = setEntry(step.payload, launch.key, follows === 'on' ? null : 'on')
    changed ||= step.changed
    return { payload: step.payload, changed, held: follows !== 'on' }
  }
  // what the place follows anyway: its entry goes (none is ever redundant)
  if (to === follows) {
    const r = setEntry(payload, launch.key, null)
    return { payload: r.payload, changed: r.changed, held: false }
  }
  if (!line.switch) throw new LoadsSwitchError(launchRefusal(row, line, who), 409)
  if (row.family === 'off-only' && to === 'on')
    throw new LoadsSwitchError(launchRefusal(row, { ...line, locked: line.locked ?? { why: 'wider', at: 'project' } }, who), 409)
  const r = setEntry(payload, launch.key, to)
  return { payload: r.payload, changed: r.changed, held: true }
}

/** All / nothing (spec scopes §4, T11): the rows `set.keys` and the heads
 *  `set.origins` to `to` at ONE place, in ONE write — the project's local
 *  file or the user's own file written once with every item's change, a
 *  launch place's payload answered once (written by nobody here). Each item
 *  changes as its own switch would; one item refused refuses the click
 *  before anything is written. */
export function claudeLoadsSwitchMany(input: LoadsInput, set: LoadsBulkSet, to: 'on' | 'off', at?: LoadsSwitchAt): LoadsBulkSwitch | void {
  if (at && at.scope !== 'project' && at.scope !== 'machine') {
    let payload: unknown = at.payload ?? null
    let changed = false
    const rows: LoadsBulkSwitch['rows'] = []
    const origins: LoadsBulkSwitch['origins'] = []
    for (const key of set.keys) {
      const r = claudeLaunchSwitch(input, key, to, { ...at, payload })
      payload = r.payload
      changed ||= r.changed
      if (r.changed) rows.push({ key, held: r.held })
    }
    for (const id of set.origins) {
      const r = claudeLaunchOriginSwitch(input, id, to, { ...at, payload })
      payload = r.payload
      changed ||= r.changed
      if (r.changed) origins.push({ id, held: r.held })
    }
    return { payload, changed, held: rows.some((r) => r.held) || origins.some((o) => o.held), rows, origins }
  }
  const mutations: ((s: Json) => boolean)[] = []
  const collect: FileEdit = (m) => {
    mutations.push(m)
  }
  for (const key of set.keys) claudeLoadsSwitch(input, key, to, at, collect)
  for (const id of set.origins) claudeLoadsOriginSwitch(input, id, to, at, collect)
  if (mutations.length === 0) return
  const all = (s: Json): boolean => {
    let changed = false
    for (const m of mutations) changed = m(s) || changed
    return changed
  }
  if (at?.scope === 'machine') writeUser(input, all)
  else editLocalSettings(input.folder, input.home, all)
}
