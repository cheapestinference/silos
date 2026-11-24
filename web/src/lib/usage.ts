// usage.ts — Usage's shapes (GET /api/usage) and the
// page's pure helpers: the words of a figure. The period's range and every
// day's name are the SERVER's (its local midnight) — the page asks for a
// named period and never computes a day itself.

export interface UsageTokens {
  in: number
  out: number
  cacheRead: number
  cacheWrite: number
}

export interface UsageRow {
  key: string
  label: string
  turns: number
  tokens: UsageTokens
  costUsd: number | null
  unpriced: number
  /** the models of the unpriced records */
  unpricedModels?: string[]
  plan: boolean
  outsideMax?: number
  notMeasured?: string[]
  /** turns whose transcript is gone: counted, not measured */
  gone?: number
  /** a conversation row: its agents */
  agents?: string[]
  /** absent on a hidden conversation (no title, no path) */
  ref?: { folder: string; id: string }
  hidden?: boolean
  /** of its turns, how many are consoles */
  consoles?: number
  /** a conversation row: the classes it ran as, the server's day of its latest record */
  classes?: SeriesClass[]
  day?: string
  children?: UsageRow[]
}

export const SERIES_CLASSES = ['with-you', 'task', 'heartbeat', 'own-automation', 'your-automation', 'unattributed', 'silos', 'before'] as const
export type SeriesClass = (typeof SERIES_CLASSES)[number]

export interface UsageReport {
  from: string
  to: string
  by: string
  agent: string | null
  rows: UsageRow[]
  /** `agents`: only read by agent over the whole fleet — the day's windowed
   *  tokens by whose window held them (what is no one's stays in `classes`) */
  series: Array<{ day: string; classes: Partial<Record<SeriesClass, number>>; agents?: Record<string, number> }>
  totals: { tokens: UsageTokens; costUsd: number | null; plan: boolean; turns: number; unpriced: number; unpricedModels?: string[]; consoles: number }
  since: string | null
  /** the register's first day, the server's local day */
  sinceDay: string | null
  /** the server's local day now */
  today: string
  priced: Array<{ provider: string; label: string; costUsd: number }>
  accounts: Array<{ account: string; label: string; weeklyPercent: number | null; fiveHourPercent: number | null }>
  notMeasured: string[]
  /** turns whose transcript is gone */
  gone: number
}

/** The words of each class (the By agent rows). */
export const CLASS_LABEL: Record<SeriesClass, string> = {
  'with-you': 'With you',
  task: 'Task starts',
  heartbeat: 'Heartbeat',
  'own-automation': 'Its automations',
  'your-automation': 'Automations you set',
  unattributed: 'Unattributed',
  silos: 'Silos itself',
  before: 'Before',
}

export const sumTokens = (t: UsageTokens): number => t.in + t.out + t.cacheRead + t.cacheWrite

/** A subagent's tokens as Usage counts a row (the census's DiskSubagent.usage
 *  holds the same records' sums, server/src/harnesses/claude-code/usage-records.ts) */
export const subagentTokens = (u: { input: number; output: number; cacheRead: number; cacheWrite: number }): number =>
  sumTokens({ in: u.input, out: u.output, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite })

/** 0 · 950 · 12.4k · 3.1M · 1.2B */
export function tokenWords(n: number): string {
  if (n < 1000) return String(Math.round(n))
  if (n < 1e6) return `${(n / 1e3).toFixed(n < 1e4 ? 1 : 0)}k`
  if (n < 1e9) return `${(n / 1e6).toFixed(n < 1e7 ? 1 : 0)}M`
  return `${(n / 1e9).toFixed(1)}B`
}

/** $0.04 · $12.40 · $1,230 */
export function dollarWords(usd: number): string {
  if (usd > 0 && usd < 0.01) return '<$0.01'
  if (usd >= 1000) return `$${Math.round(usd).toLocaleString('en-US')}`
  return `$${usd.toFixed(2)}`
}

/** What a cost that could not be priced says, everywhere (Usage, the
 *  conversation column): WHICH model has no price — «no price for
 *  claude-fable-5-2» — never a bare «unpriced». */
export function noPriceWords(models: readonly string[] | undefined): string {
  const named = [...new Set(models ?? [])]
  return named.length > 0 ? `no price for ${named.join(', ')}` : 'no price for its model'
}

/** A row's money: dollars when it priced, «on plan» when it ran on one — a
 *  turn on a plan never shows dollars; a model without a price is
 *  named. */
export function moneyWords(r: Pick<UsageRow, 'costUsd' | 'plan' | 'unpriced' | 'unpricedModels'>): string {
  const parts: string[] = []
  if (r.costUsd !== null) parts.push(dollarWords(r.costUsd))
  if (r.plan) parts.push('on plan')
  if (r.unpriced > 0) parts.push(noPriceWords(r.unpricedModels))
  return parts.join(' · ')
}

/** What a period with nothing measured says (Usage's empty state, Home's
 *  Usage tile): one wording, never a fake chart. */
export function usageEmptyWords(agentName: string | null, periodWords: string, ever: boolean): string {
  if (!ever) return 'Nothing ran yet. Usage shows here from the first turn.'
  return agentName ? `${agentName} ran nothing ${periodWords}.` : `Nothing ran ${periodWords}.`
}

/** «default — 62% of its weekly window · 5-hour window 40%» */
export function accountWords(a: UsageReport['accounts'][number]): string {
  const bits: string[] = []
  if (a.weeklyPercent !== null) bits.push(`${Math.round(a.weeklyPercent)}% of its weekly window`)
  if (a.fiveHourPercent !== null) bits.push(`5-hour window ${Math.round(a.fiveHourPercent)}%`)
  return bits.length > 0 ? `${a.label} — ${bits.join(' · ')}` : `${a.label} — its limits can't be read right now`
}

/** «12 turns» · «12 turns and a console» · «a console» — a console is
 *  never a count of turns (it lives for days). */
export function turnsWords(turns: number, consoles = 0): string {
  const t = turns - consoles
  const tw = t === 1 ? '1 turn' : `${t} turns`
  const cw = consoles === 1 ? 'a console' : `${consoles} consoles`
  if (consoles === 0) return tw
  return t === 0 ? cw : `${tw} and ${cw}`
}

/** The Turns cell: «7» · «console» · «3 + console» */
export function turnsCell(turns: number, consoles = 0): string {
  const t = turns - consoles
  if (consoles === 0) return t > 0 ? String(t) : '—'
  const c = consoles === 1 ? 'console' : `${consoles} consoles`
  return t > 0 ? `${t} + ${c}` : c
}

/** «12.4k in · 3.1k out · 1.2M cache» — what a token total is made of
 *  (cache reads usually dominate). */
export function tokenParts(t: UsageTokens): string {
  return `${tokenWords(t.in)} in · ${tokenWords(t.out)} out · ${tokenWords(t.cacheRead + t.cacheWrite)} cache`
}

/** A row's share of what the view lists: its tokens over the rows' sum (the
 *  rows always add up to the period). 0 when nothing was measured. */
export function shareOf(row: UsageRow, rows: readonly UsageRow[]): number {
  const all = rows.reduce((s, r) => s + sumTokens(r.tokens), 0)
  return all > 0 ? sumTokens(row.tokens) / all : 0
}

/** «34%» · «<1%» (some, but under a half) · «0%» */
export function shareWords(share: number): string {
  if (share <= 0) return '0%'
  if (share < 0.005) return '<1%'
  return `${Math.round(share * 100)}%`
}

/** How many agents get their own colour in the day bars; the rest share one. */
export const AGENT_SLOTS = 6

/** The By agent stack: which agents get a colour and which slot.
 *  The period's heaviest AGENT_SLOTS agents get one, placed in the
 *  REGISTRY's order (an agent no longer registered after them, by id) — so a
 *  colour follows the agent, never its rank, and the slots run 1..N without
 *  a gap (only validated neighbours ever touch in a stack). The others fold
 *  into one «rest». */
export interface AgentStack {
  colored: string[]
  rest: string[]
}
export function agentStack(series: UsageReport['series'], registryOrder: readonly string[]): AgentStack {
  const total = new Map<string, number>()
  for (const d of series) for (const [id, n] of Object.entries(d.agents ?? {})) if (n > 0) total.set(id, (total.get(id) ?? 0) + n)
  const ran = [...total.keys()]
  const heaviest = new Set([...ran].sort((a, b) => total.get(b)! - total.get(a)! || a.localeCompare(b)).slice(0, AGENT_SLOTS))
  const place = (id: string): number => {
    const i = registryOrder.indexOf(id)
    return i >= 0 ? i : registryOrder.length
  }
  const inOrder = (a: string, b: string): number => place(a) - place(b) || a.localeCompare(b)
  return { colored: ran.filter((id) => heaviest.has(id)).sort(inOrder), rest: ran.filter((id) => !heaviest.has(id)).sort(inOrder) }
}

/** A day's segments under the By agent stack, bottom up: each coloured
 *  agent, the rest folded, then what is no one's (unattributed, Silos
 *  itself, before) as the class bars say it — the same day total. */
export const NO_ONES = ['unattributed', 'silos', 'before'] as const satisfies readonly SeriesClass[]
export function agentDaySegments(day: UsageReport['series'][number], stack: AgentStack): Array<{ key: string; value: number }> {
  const a = day.agents ?? {}
  return [
    ...stack.colored.map((id) => ({ key: `agent:${id}`, value: a[id] ?? 0 })),
    { key: 'rest', value: stack.rest.reduce((s, id) => s + (a[id] ?? 0), 0) },
    ...NO_ONES.map((c) => ({ key: c, value: day.classes[c] ?? 0 })),
  ]
}

/** Home's «This week»: the same classes cut in
 *  two — what ran WITH YOU (attended) and everything else, what ran ON
 *  THEIR OWN (task starts, heartbeats, automations, and what fell in no
 *  one's window). One rule, beside the classes, so Home and Usage add up to
 *  the same day total whichever way the day is cut. */
export const ATTENDED: readonly SeriesClass[] = ['with-you']
export type Attendance = 'with-you' | 'on-their-own'
export const ATTENDANCE_LABEL: Record<Attendance, string> = { 'with-you': 'With you', 'on-their-own': 'On their own' }
export function attendanceOf(c: SeriesClass): Attendance {
  return ATTENDED.includes(c) ? 'with-you' : 'on-their-own'
}
export function attendanceDay(day: UsageReport['series'][number]): Record<Attendance, number> {
  const out: Record<Attendance, number> = { 'with-you': 0, 'on-their-own': 0 }
  for (const c of SERIES_CLASSES) out[attendanceOf(c)] += day.classes[c] ?? 0
  return out
}

/** «Wed 11» — a day bar's label. */
export function dayWords(day: string): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number]
  return `${new Date(y, m - 1, d).toLocaleDateString('en-US', { weekday: 'short' })} ${d}`
}

// ── an automation's spend: its last 30 days, said where it lives ──

/** Its spark: the days summed into weeks, counted back from today — whole
 *  weeks only (a part-week at the far end would draw a dip that never
 *  happened), oldest first, at most `max`. */
export function weeksOf(days: ReadonlyArray<{ tokens: number }>, max = 12): number[] {
  const out: number[] = []
  for (let end = days.length; end - 7 >= 0 && out.length < max; end -= 7) {
    let s = 0
    for (let i = end - 7; i < end; i++) s += days[i]!.tokens
    out.unshift(s)
  }
  return out
}

/** Its money in Usage's grammar: dollars when it priced, «on plan» when it
 *  ran on one — wholly on a plan, no «$0.00» before it — and a model
 *  without a price said. */
export function automationMoneyWords(u: { cost: number; plan: boolean; unpricedTokens: number }): string {
  return moneyWords({ costUsd: u.plan && u.cost === 0 ? null : u.cost, plan: u.plan, unpriced: u.unpricedTokens })
}

/** «187 runs · 4.1M tokens this month — $0.61» */
export function automationUsageWords(u: { tokens: number; cost: number; plan: boolean; unpricedTokens: number; runsCounted: number }): string {
  const money = automationMoneyWords(u)
  return `${u.runsCounted === 1 ? '1 run' : `${u.runsCounted} runs`} · ${tokenWords(u.tokens)} tokens this month${money ? ` — ${money}` : ''}`
}

/** How many of these runs the month's figure should hold: the finished
 *  turns (a conversation behind them) since its first day's local midnight
 *  — more than its `runsCounted`, and the figure is still being counted. */
export function runsInWindow(runs: ReadonlyArray<{ status: string; sessionKey?: string; startedAt?: string; at: string }>, firstDay: string): number {
  const [y, m, d] = firstDay.split('-').map(Number) as [number, number, number]
  const since = new Date(y, m - 1, d).getTime()
  return runs.filter((r) => (r.status === 'ok' || r.status === 'failed') && !!r.sessionKey && Date.parse(r.startedAt ?? r.at) >= since).length
}
