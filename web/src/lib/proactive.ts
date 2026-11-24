// proactive.ts — the words and gestures of the proactive mode on the web:
// the three positions of the control, the
// sentence under it, the «Make X proactive» sheet (its prefill, its «≈ n
// rounds a day» — always period.ts's slotsPerDay over the period the server
// will stamp, never a reckoning of the screen —, what holds it), the PATCH
// each gesture sends, the agent page's Heartbeat and Proactive rows, the
// marker of the sidebar and the Org.
// Pure: every surface paints from here, so a word is said once.
import { PROACTIVE_OPEN_MAX, PROACTIVE_PER_DAY, PROACTIVE_PER_DAY_MAX, PROACTIVE_PER_DAY_MIN } from '../../../server/src/limits'
import {
  cadenceWords,
  capitalized,
  intervalMinutes,
  periodOfDraft,
  periodWords,
  slotsPerDay,
  stampedOfDraft,
  HEARTBEAT_RULES,
  type Period,
  type PeriodDraft,
} from './period'
import type { AgentView, HeartbeatSkip, HeartbeatKind, Position, ProactiveHolds, ProactiveSetting } from './types'

export { PROACTIVE_PER_DAY, PROACTIVE_PER_DAY_MAX, PROACTIVE_PER_DAY_MIN }

/** The words of each position, in the switch's order — a ladder: each step
 *  does what the one below does, and more. */
export const POSITIONS: ReadonlyArray<{ value: Position; words: string }> = [
  { value: 'told', words: 'Only when told' },
  { value: 'own', words: 'On its own' },
  { value: 'proactive', words: 'Proactive' },
]
export const PROACTIVE_WORDS = 'Proactive'

/** The position the switch shows: the owner's choice as stored — «On its
 *  own» with a proactive setting is Proactive (never a third control).
 *  Whether it does rounds right now is said by its row (a cut agent: «Rounds
 *  are off»), and by the derived positionNow on the markers. */
export function shownPosition(a: Pick<AgentView, 'control' | 'proactive'>): Position {
  if (a.control !== 'own') return 'told'
  return a.proactive ? 'proactive' : 'own'
}

// the PATCH body a gesture sends — Parameters<typeof api.agents.update>[1]
export type ControlBody = {
  control?: 'told' | 'own'
  heartbeat?: { period: Period | null }
  proactive?: Partial<ProactiveSetting> | null
}

/** What a touch on the switch does: Proactive opens the sheet;
 *  «On its own» from Proactive sends `proactive: null`, explicit, with no
 *  sheet; «Only when told» sends the control (the server clears proactive in
 *  the same write, and today's sheet says what still runs). null: nothing. */
export function switchGesture(from: Position, to: Position): { sheet: true } | { body: ControlBody } | null {
  if (from === to) return null
  if (to === 'proactive') return { sheet: true }
  if (to === 'told') return { body: { control: 'told' } }
  return from === 'proactive' ? { body: { proactive: null } } : { body: { control: 'own' } }
}

/** The sheet's PATCH: its period, its count and its tools — and, from «Only
 *  when told», On its own in the same write (so a missing mission or
 *  territory answers own's 409s, with their doors). */
export function sheetBody(from: Position, draft: PeriodDraft, perDay: number, tools: boolean): ControlBody {
  return {
    ...(from === 'told' ? { control: 'own' as const } : {}),
    heartbeat: { period: periodOfDraft(draft) },
    proactive: { perDay, tools },
  }
}

// «every 3 hours · 08:00–20:00» — the sheet's prefill when the agent's own
// period is a day or more
export const SHEET_FALLBACK: Period = { every: 3, unit: 'hours', between: { from: '08:00', to: '20:00' } }

/** The sheet's period: the agent's own when it is less than a day
 *  (minutes or hours — the only units under a day), else every 3 hours
 *  between 08:00 and 20:00. Its `at` is left to the server (the staggered
 *  minute from the band's start). */
export function sheetPeriod(current: Period | null): Period {
  if (current && (current.unit === 'minutes' || current.unit === 'hours')) {
    const { at: _at, since: _since, ...rest } = current
    return rest
  }
  return SHEET_FALLBACK
}

/** The period the server will keep for a draft (a minutes/hours
 *  period with no `at` is anchored at the agent's staggered minute from the
 *  band's start), and so its rounds a day — slotsPerDay over THAT, never the
 *  screen. null: a draft the server would refuse (periodProblem says why) or
 *  never. */
export function roundsOfDraft(d: PeriodDraft, staggerMinute: number, now = Date.now()): { n: number; from: string; cadence: string } | null {
  if (d.never) return null
  try {
    const stamped = stampedOfDraft(d, HEARTBEAT_RULES, staggerMinute, now)
    if (!stamped) return null
    return { n: slotsPerDay(stamped), from: stamped.at ?? '00:00', cadence: cadenceWords(stamped, 'round') }
  } catch {
    return null
  }
}

/** A week or more between rounds: no round would ever happen (every beat
 *  would be a think). The sheet and the heartbeat's editor say it
 *  before the click as what to change, and Save is held — the
 *  server's 409 never has to. null: the period is short enough, or it is
 *  not a period yet (periodProblem says that). */
export function roundsWeeklyProblem(d: PeriodDraft): string | null {
  const p = d.never ? null : periodOfDraft(d)
  if (!p || !Number.isInteger(p.every) || p.every < 1) return null
  return intervalMinutes(p) >= 7 * 24 * 60 ? 'Rounds need less than a week between them — pick minutes, hours or up to 6 days.' : null
}

/** Never, chosen in Proactive's heartbeat editor: no rounds at all — so it
 *  goes back to On its own (the save sends `proactive: null` with it). */
export function neverInProactiveWords(name: string): string {
  return `Never means no rounds: ${name} goes back to On its own, and doesn't look or think on its own.`
}

/** Under the sheet's period: «≈ 4 rounds a day, from 08:22 — each one is a
 *  turn» · «one round every 2 days, at 09:00 — each one is a turn». */
export function sheetRoundsWords(r: { n: number; from: string; cadence: string }): string {
  return `${r.cadence}, ${r.cadence.startsWith('≈') ? 'from' : 'at'} ${r.from} — each one is a turn`
}

/** The period editor's consequence in proactive mode. */
export function editorRoundsWords(r: { cadence: string }): string {
  return `${capitalized(r.cadence)} — each one is a turn.`
}

/** «within its <C> starts a day». */
export function sheetIntro(name: string, ceiling: number): [string, string] {
  return [
    `On its own, ${name} starts what you give it and reacts to what arrives.`,
    `Proactive, ${name} also goes looking: on each round it checks what its mission covers, creates the tasks it finds and starts them — within its ${ceiling} starts a day.`,
  ]
}

const money = (usd: number): string => (Number.isInteger(usd) ? `$${usd}` : `$${usd.toFixed(2)}`)

/** «What holds it: …» in its variant — every limit the
 *  server enforces on a round, said before the click: the territory and the
 *  Never lines; the open tasks from its mission; the money brake of a
 *  provider that prices (rounds stop at its share of the cap), the account's
 *  margin (and its unreadable usage) on a plan, or the count of an
 *  unmeasured one; no subagents and no questions to you. */
export function holdsWords(h: ProactiveHolds | null | undefined, openMax: number = PROACTIVE_OPEN_MAX): string {
  const brake = !h
    ? null
    : h.kind === 'spend'
      ? h.spendPerDay !== null
        ? `${money(h.spendPerDay)} a day — rounds stop at ${h.sharePercent === 50 ? 'half' : `${h.sharePercent}%`} of it`
        : null
      : h.kind === 'account'
        ? `its account — rounds wait when a window passes ${h.headroomPercent}%, or when Silos can't read its usage`
        : `${h.roundsPerDay} rounds a day — Silos can't measure this provider`
  return `What holds it: its territory, its Never lines, at most ${openMax} open tasks from its mission${brake ? `, and ${brake}` : ''}. No subagents and no questions to you in a round. Everything it decides shows on its page and on Home, with Undo.`
}

/** «What doesn't hold it» (the residue the sheet says before the
 *  click): what a round with its tools can do that no lock stops. */
export function looseWords(tools: boolean): string {
  return tools
    ? "What doesn't hold it: MCP servers and connectors act with their own permissions. After reading outside it may edit its CLAUDE.md and memory. A task it creates starts with subagents and questions to you."
    : "What doesn't hold it: a task it creates starts with subagents and questions to you."
}

/** What a round with its tools will have, in the page's words
 *  — the MCP servers and plugins of its folder (the Tools tab's), and the
 *  claude.ai connectors of its account, which load too and Silos can't list
 *  (`accountToo`: the server's note — a Claude account). Never «none»
 *  alone while account connectors may load. */
export function connectorsWords(names: string[], accountToo: boolean): string {
  const listed = names.length > 0 ? names.join(', ') : 'none from its folder'
  const account = accountToo ? " — and every claude.ai connector of its account, which Silos can't list" : ''
  return `MCP servers and plugins it will have: ${listed}${account}. They act with their own permissions; its territory doesn't cover them.`
}

/** Its files only (tools: false), as strong as the mechanism and
 *  no stronger: what is removed, what stays, and what catches the rest. */
export const FILES_ONLY_WORDS = 'No web, MCP servers or connectors. Bash and skills stay; if it reads outside anyway, what it made is undone and it is cut.'

/** The sheet's title and button: making it proactive, or changing the
 *  rounds of one that already is («change» on the Proactive row). */
export function sheetTitle(name: string, already: boolean): { title: string; button: string } {
  return already ? { title: `${name}'s rounds`, button: 'Save' } : { title: `Make ${name} proactive`, button: `Make ${name} proactive` }
}

/** The count's range, said when it is not a whole number in it. */
export const PER_DAY_RANGE_WORDS = `A whole number from ${PROACTIVE_PER_DAY_MIN} to ${PROACTIVE_PER_DAY_MAX}.`

/** The sentence under the switch in Proactive: `rest` is the period
 *  editor's door (▾), at the head of its sentence. It never promises a
 *  round that won't come: asleep, it goes looking once it wakes. (Cut, it
 *  does no rounds at all — controlSentence says On its own's words.) */
export function proactiveSentence(period: Period, perDay: number, asleep = false): { lead: string; rest: string; tail: string } {
  return {
    lead: asleep ? 'Goes looking for work once it wakes.' : 'Goes looking for work.',
    rest: capitalized(periodWords(period)),
    tail: ` it does a round of what its mission covers, creates the tasks it finds — up to ${perDay} a day — and starts them. Everything On its own does, too.`,
  }
}

/** The Proactive row: «Up to 5 tasks a day from its mission» and
 *  «2 today» apart — `atMax` marks the day's count reached (drawn like
 *  «Started 10 times today · max 10»); the open tasks from its mission
 *  join only when they are at their max. */
export function proactiveRowWords(
  perDay: number,
  made: number,
  open?: { n: number; max: number },
): { head: string; today: string; atMax: boolean; open: string | null } {
  return {
    head: `Up to ${perDay} tasks a day from its mission`,
    today: made >= perDay ? `${made} today — its max` : `${made} today`,
    atMax: made >= perDay,
    open: open && open.n >= open.max ? `${open.n} open — finish or withdraw one before the next` : null,
  }
}
export function proactiveToolsWords(tools: boolean): string {
  return tools ? 'Uses its tools — what it reads outside is recorded' : 'Uses its files only'
}
export const ROUNDS_OFF_WORDS = "Rounds are off — it can't create work of its own"

/** The cut agent's row: why it was cut, from its record. */
export function cutWords(why: string | null | undefined): string {
  const w = (why ?? '').trim()
  return w ? `Cut: it ${w.replace(/^it\s+/, '')}` : 'Cut'
}

/** A local instant as the heartbeat rows say it: «14:22» today,
 *  «tomorrow 08:22», «Mon 09:00» within the week, else «Nov 20 09:00». */
export function hourWords(iso: string, now = Date.now()): string {
  const d = new Date(iso)
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  const day = (x: Date): string => `${x.getFullYear()}-${x.getMonth()}-${x.getDate()}`
  const today = new Date(now)
  const tomorrow = new Date(now + 24 * 3600_000)
  if (day(d) === day(today)) return hm
  if (day(d) === day(tomorrow)) return `tomorrow ${hm}`
  if (Math.abs(d.getTime() - now) < 6 * 24 * 3600_000) return `${SHORT_DAYS[d.getDay()]} ${hm}`
  return `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} ${hm}`
}
const SHORT_DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const

/** The one door a skip carries — by its cause: the spend cap and
 *  its half → the same «Let it continue today» / «Raise ›» as Home; the
 *  account's limit or margin → Usage; an engine Silos refuses → Settings ›
 *  Engines, where its Update is. The rest wait for their next slot. */
export type SkipDoor = 'continue' | 'usage' | 'engine' | null
export interface SkipRow {
  at: string
  text: string
  door: SkipDoor
  round: boolean
}
export interface SkipIn {
  at: string
  cause?: HeartbeatSkip | null
  kind?: HeartbeatKind | null
  reason: string
  until?: string | null
}

const DOOR_OF: Record<HeartbeatSkip, SkipDoor> = {
  spend: 'continue',
  share: 'continue',
  account: 'usage',
  headroom: 'usage',
  engine: 'engine',
  sleeping: null,
  busy: null,
  empty: null,
  quota: null,
}

/** A skipped fire as its row says it on the agent's own page: plain words
 *  about «it», no engine's raw refusal, no «— wake it on its page» on that
 *  very page, «tasks» where the server counts creations, and — when the
 *  server sends the instant apart (`until`, its words ending before the
 *  time) — that instant in the row's own hour format. */
export function skipRow(s: SkipIn, name: string, now = Date.now()): SkipRow {
  const cause = s.cause ?? null
  let text: string
  if (cause === 'engine') text = "its engine can't run"
  else if (cause === 'sleeping') text = 'it was asleep'
  else {
    text = skipRowWords(s.reason, name)
      .replace(/\bcreations\b/g, 'tasks')
      .replace(/\s+—\s+wake it on [^—]*page$/, '')
  }
  if (s.until && !Number.isNaN(Date.parse(s.until))) text = `${text.replace(/\s+$/, '')} ${hourWords(s.until, now)}`
  return { at: s.at, text, door: cause ? (DOOR_OF[cause] ?? null) : null, round: s.kind === 'round' }
}

/** The marker's title on the sidebar and the Org. */
export function proactiveMarkerWords(period: Period | null): string {
  return period ? `${PROACTIVE_WORDS} — a round ${periodWords(period)}` : PROACTIVE_WORDS
}

/** A skip's words on the agent's own page («Skipped 17:22 — its
 *  account is at 88% of its 5-hour window»): the run's reason said about the
 *  agent whose page it is — its name becomes «its»/«it» — and the brake's
 *  tail («— rounds wait …»), which the row's «Skipped» already says, left
 *  out. */
export function skipRowWords(reason: string, name: string): string {
  let s = reason.trim()
  if (name) {
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    s = s.replace(new RegExp(`(^|\\s)${esc}['’]s\\b`, 'g'), '$1its')
    s = s.replace(new RegExp(`(^|\\s)${esc}\\b`, 'g'), '$1it')
  }
  return s.replace(/\s+—\s+rounds wait\b.*$/, '')
}

/** A whole number from 1 to 50 (the server's 400 otherwise). */
export function perDayOk(v: string): number | null {
  const n = Number(v.trim())
  return v.trim() !== '' && Number.isInteger(n) && n >= PROACTIVE_PER_DAY_MIN && n <= PROACTIVE_PER_DAY_MAX ? n : null
}
