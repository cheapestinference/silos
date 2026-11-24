// harnesses/claude-code/loads/places.ts — «Where it loads» for Claude Code
// (spec scopes §2, §3, §7): the places a choice about loading a thing can be
// kept at, and, per row, one line per place and per fact, each with its own
// entry, what it follows, the result there and what locks it.
//
// The engine's order, broadest first: managed settings (a fact, above
// everything) › the thing's own default (a fact, beneath every entry) ›
// this machine (the user file, `~/.claude/settings.json`) › the repository's
// checked-in `.claude/settings.json` (a fact) › the engine's per-project
// toggle in `~/.claude.json` (a fact) › this project (the local file) ›
// each agent and one conversation (the flag tier, carried at launch — Silos
// keeps them, loads-scopes.ts): an agent follows the project, a
// conversation follows its agent.
//
// Two families (§2): an OVERRIDE kind (plugins) — the narrowest place that
// names it decides, either way; an OFF-ONLY kind (MCP servers, connectors,
// an account origin's head) — off at any place that reaches the
// conversation is off, and every narrower line is locked under it. Managed
// settings lock every other line. A server the organization provides takes
// no entry from the project's files: its project line (and the repository's
// fact) is locked, its machine, agent and conversation lines are not.
//
// The order is MEASURED (T1 smoke, CLI 2.1.331): plugins, `<name>@synced`
// included, flag › local › project › user in both directions; a deny by
// name and `disableClaudeAiConnectors` in the user file hold.
//
// Pure: it writes nothing. A line carries its own switch where Silos writes
// that place — the machine line (machine.ts, the user file) and the project
// line (switch.ts, the local file); each agent line (switch.ts claudeLaunchSwitch, the payload Silos keeps). Names are data —
// every lookup is by own property or by value, never through a prototype.
import type { LoadsCarried, LoadsExpect, LoadsLine, LoadsScope, LoadsScopeId } from '../../contract.js'
import { CONNECTORS_URL } from './sign-in.js'
import { entryOf, type HeadKey, type LaunchKey } from './launch-entries.js'

/** Claude Code's places, broadest first (HarnessLoads.scopes). */
export const CLAUDE_SCOPES: readonly LoadsScope[] = [
  { id: 'account', carrier: 'door', keptIn: 'claude.ai' },
  { id: 'machine', carrier: 'file', keptIn: '~/.claude/settings.json' },
  { id: 'project', carrier: 'file', keptIn: '.claude/settings.local.json' },
  { id: 'agent', carrier: 'launch' },
  { id: 'conversation', carrier: 'launch' },
]
const KEPT: Partial<Record<LoadsScopeId, string>> = Object.fromEntries(CLAUDE_SCOPES.filter((s) => s.keptIn).map((s) => [s.id, s.keptIn!]))

export const FACT_FILE = { managed: 'managed settings', repository: '.claude/settings.json', claudeJson: '~/.claude.json' } as const

type Entry = 'on' | 'off'

/** One tier's say about a row: its own entry, and whether a removal key
 *  (an off-only kind's entry, an account origin's head) takes it out there. */
export interface TierSay {
  /** an override kind's entry (on/off) — an off-only kind's is `removes` */
  entry?: Entry
  /** an off-only key at this tier takes it out (the key, said on a fact) */
  removes?: string
}

/** What the engine's files say about one row, tier by tier. */
export interface RowTiers {
  family: 'override' | 'off-only'
  /** the key an entry is written under — named on a fact line */
  key: string
  managed?: TierSay
  /** the thing's own default, when it starts off (a plugin's manifest) */
  defaultOff?: { file: string; key: string }
  user?: TierSay
  repository?: TierSay
  /** the engine's per-project toggle (`~/.claude.json` disabledMcpServers) */
  engineOff?: true
  local?: TierSay
  /** the machine can hold it: a line even with no entry (a server of ONE
   *  project has none — §3) */
  machine: boolean
  /** the organization provides it: an entry in the project's files does not apply */
  provided?: true
  /** an account row: its login, and the door's page where it is confirmed */
  account?: { login: string | null; url?: string }
  /** the machine line's switch: the exact names a click writes in the user
   *  file, or why there is none (an engine older than the key's confirmed
   *  version). Absent: the line says, but nothing switches there. */
  machineSwitch?: { names: string[] } | { refused: { why: 'engine'; needs: string } }
  /** how a launch place (an agent) writes it: its key and exact names, the
   *  other rows those names reach, and whether this engine takes it from
   *  the flag tier (absent: no launch line switches it — a placeholder, a
   *  copy another loads in place of, a name only its tools carry) */
  launch?: { key: LaunchKey; own: string; reaches?: string[]; switchable: boolean }
  /** an account row: the head of its origin — off at a place, it takes the
   *  row out there (a launch place's payload included); said on the line
   *  (`headOff`, a narrower line's `locked.head`) */
  head?: HeadKey
  /** a head's own lines: the machine line's sentence before its «off» */
  machineAsks?: string
}

const hasSay = (s: TierSay | undefined): boolean => s !== undefined && (s.entry !== undefined || s.removes !== undefined)

/** The lines of one row (broadest first), from its tiers and the launch
 *  places Silos carries. Pure. */
export function linesOf(t: RowTiers, carried: LoadsCarried | undefined): LoadsLine[] {
  const lines: LoadsLine[] = []
  if (t.account) {
    lines.push({
      place: 'account',
      result: 'on',
      keptIn: KEPT.account!,
      door: { word: 'Claude account', where: 'claude.ai', ...(t.account.url ? { url: t.account.url } : {}), login: t.account.login },
    })
  }

  // managed settings decide above everything
  const managedSays = hasSay(t.managed)
  const managedResult: Entry | null = !managedSays ? null : t.managed!.removes !== undefined ? 'off' : (t.managed!.entry ?? null)

  // the main chain: each line follows the one above
  let value: Entry = t.defaultOff ? 'off' : 'on'
  let offAt: LoadsScopeId | 'fact' | null = null
  let offByHead = false
  /** apply one tier's say; returns the line fields */
  const step = (say: TierSay | undefined, place: LoadsScopeId | 'fact', notApplied = false): Pick<LoadsLine, 'entry' | 'result' | 'locked' | 'headOff'> => {
    const byHead = t.head !== undefined && say?.removes === t.head
    const own: Pick<LoadsLine, 'entry' | 'headOff'> =
      say?.removes !== undefined ? { entry: 'off', ...(byHead ? { headOff: true as const } : {}) } : say?.entry ? { entry: say.entry } : {}
    if (managedResult) return { ...own, result: managedResult, locked: { why: 'organization', at: 'fact' } }
    if (offAt) return { ...own, result: 'off', locked: { why: 'wider', at: offAt, ...(offByHead ? { head: true as const } : {}) } }
    if (notApplied) return { ...own, result: value, locked: { why: 'provided' } }
    if (say?.entry && t.family === 'override') value = say.entry
    if (say?.removes !== undefined || (say?.entry === 'off' && t.family === 'off-only')) {
      offAt = place
      offByHead = byHead
    }
    return { ...own, result: offAt ? 'off' : value }
  }

  if (managedSays) {
    lines.push({
      place: 'fact',
      fact: { who: 'organization', file: FACT_FILE.managed, key: t.managed!.removes ?? t.key },
      ...(t.managed!.removes !== undefined || t.managed!.entry === 'off' ? { entry: 'off' as const } : { entry: 'on' as const }),
      result: managedResult ?? 'on',
    })
  }
  if (t.defaultOff) {
    lines.push({
      place: 'fact',
      fact: { who: 'default', file: t.defaultOff.file, key: t.defaultOff.key },
      entry: 'off',
      ...(managedResult ? { result: managedResult, locked: { why: 'organization', at: 'fact' } } : { result: 'off' }),
    })
  }
  if (t.machine || hasSay(t.user)) {
    const m: LoadsLine = { place: 'machine', keptIn: KEPT.machine!, ...step(t.user, 'machine') }
    // its switch, where nothing wider decides (managed settings)
    if (t.machine && !m.locked && t.machineSwitch) {
      if ('names' in t.machineSwitch) m.switch = { names: [...t.machineSwitch.names] }
      else m.refused = t.machineSwitch.refused
    }
    // a head's «off» for the whole machine asks first, in its own words
    if (m.switch && t.machineAsks && m.result === 'on') m.asks = t.machineAsks
    lines.push(m)
  } else step(t.user, 'machine')
  if (hasSay(t.repository)) {
    lines.push({
      place: 'fact',
      fact: { who: 'repository', file: FACT_FILE.repository, key: t.repository!.removes ?? t.key },
      ...step(t.repository, 'fact', t.provided === true),
    })
  }
  if (t.engineOff) {
    lines.push({
      place: 'fact',
      fact: { who: 'engine', file: FACT_FILE.claudeJson, key: 'disabledMcpServers' },
      ...step({ removes: 'disabledMcpServers' }, 'fact'),
    })
  }
  lines.push({ place: 'project', keptIn: KEPT.project!, ...step(t.local, 'project', t.provided === true) })

  // the launch places branch off the project: each agent follows it unless
  // the payload Silos keeps for it names the row (launch-entries.ts); a
  // conversation too. A line that can change the result carries its switch.
  //
  // A conversation follows ITS agent's line (managed › conversation › agent
  // › project, spec §2): the chain is resumed from the agent's state, so an
  // override «on» there is the conversation's to override again, and an
  // off-only thing its agent keeps off locks the conversation's line
  // (`at: 'agent'`). A conversation whose agent has no line here follows
  // the project.
  const savedValue = value,
    savedOff = offAt,
    savedByHead = offByHead
  const afterAgent = new Map<string, { value: Entry; offAt: LoadsScopeId | 'fact' | null; byHead: boolean }>()
  const sayOf = (payload: unknown): TierSay | undefined => {
    const entry = t.launch ? entryOf(payload, t.launch.key, t.launch.own) : undefined
    const itemSay: TierSay | undefined =
      entry === undefined
        ? undefined
        : t.family === 'override'
          ? { entry }
          : entry === 'off'
            ? { removes: t.launch!.key.key === 'head' ? t.launch!.key.name : t.launch!.key.key }
            : undefined
    // the place's head off takes the row out there, whatever its own entry
    return t.head && entryOf(payload, { key: 'head', name: t.head }) === 'off'
      ? { ...(itemSay?.entry ? { entry: itemSay.entry } : {}), removes: t.head }
      : itemSay
  }
  const branch = (place: 'agent' | 'conversation', extra: Partial<LoadsLine>, payload: unknown, from?: string, withSwitch = true): LoadsLine => {
    const start = from !== undefined ? afterAgent.get(from) : undefined
    value = start?.value ?? savedValue
    offAt = start ? start.offAt : savedOff
    offByHead = start ? start.byHead : savedByHead
    const line: LoadsLine = { place, ...extra, ...step(sayOf(payload), place) }
    if (withSwitch && t.launch?.switchable && !line.locked)
      line.switch = { names: namesOf(t.launch.key), ...(t.launch.reaches && t.launch.reaches.length > 0 ? { reaches: [...t.launch.reaches] } : {}) }
    return line
  }
  for (const a of carried?.agents ?? []) {
    lines.push(branch('agent', { agent: a.id }, a.payload))
    afterAgent.set(a.id, { value, offAt, byHead: offByHead })
  }
  const c = carried?.conversation
  if (c) lines.push(branch('conversation', { conversation: c.id, ...(c.agent !== undefined ? { agent: c.agent } : {}) }, c.payload, c.agent))
  // a page's facts: another conversation of the folder, only where its own
  // entry names this row — no switch (a page has no conversation)
  for (const o of carried?.conversations ?? []) {
    if (c && o.id === c.id) continue
    const line = branch('conversation', { conversation: o.id, ...(o.agent !== undefined ? { agent: o.agent } : {}) }, o.payload, o.agent, false)
    if (line.entry !== undefined) lines.push(line)
  }
  value = savedValue
  offAt = savedOff
  offByHead = savedByHead
  return lines
}

/** What each place a reading can prove expects of a row (spec scopes §7,
 *  LoadsRow.expect), from its lines: the machine where its entry is what
 *  decides for the project — never where a narrower file, a fact or the
 *  project's own entry decides instead (the narrower one turns it back on
 *  or off by right) — and each agent and conversation line holding its own
 *  entry that can change the result. The project is proven as before
 *  (heldHere). `names`: what a status reading would list if it loaded —
 *  none (a plugin with no server), no expectation. Pure. */
export function expectsOf(lines: LoadsLine[], family: 'override' | 'off-only', names: string[]): LoadsExpect[] {
  if (names.length === 0) return []
  const out: LoadsExpect[] = []
  const deciding = (l: LoadsLine): boolean => l.entry !== undefined && !l.locked && (family === 'override' || l.entry === 'off')
  const file = lines.filter((l) => l.place !== 'agent' && l.place !== 'conversation' && l.place !== 'account')
  // override: the narrowest that names it decides; off-only: the broadest «off»
  const decider = family === 'override' ? file.filter(deciding).at(-1) : file.find(deciding)
  if (decider?.place === 'machine') out.push({ scope: 'machine', to: decider.entry!, names: [...names] })
  for (const l of lines) {
    if ((l.place !== 'agent' && l.place !== 'conversation') || !deciding(l)) continue
    out.push({
      scope: l.place,
      ...(l.agent ? { agent: l.agent } : {}),
      ...(l.conversation ? { conversation: l.conversation } : {}),
      to: l.entry!,
      names: [...names],
    })
  }
  return out
}

/** The exact names a launch entry writes. */
export const namesOf = (k: LaunchKey): string[] => (k.key === 'enabledPlugins' ? [k.id] : k.key === 'deniedMcpServers' ? [...k.names] : [k.name])

/** A plugin server's lines, its plugin's counted: it comes and goes with
 *  its plugin — off where the plugin's line at the same place is off. */
export function withParent(own: LoadsLine[], parent: LoadsLine[]): LoadsLine[] {
  const same = (a: LoadsLine, b: LoadsLine): boolean => a.place === b.place && a.agent === b.agent && a.conversation === b.conversation && a.place !== 'fact'
  return own.map((l) => {
    const p = parent.find((x) => same(x, l))
    if (!p || p.result !== 'off') return l
    // it comes and goes with its plugin there: nothing to switch on its own
    const { switch: _s, ...rest } = l
    void _s
    return { ...rest, result: 'off' }
  })
}

/** The connector door's page (walked 24-11): a connector's account line links it. */
export const ACCOUNT_CONNECTORS_URL = CONNECTORS_URL
