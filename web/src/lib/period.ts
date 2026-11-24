// period.ts — the free period on the web: the SAME
// module the server runs (server/src/period.ts, pure), so a row's words, a
// draft's 400 and the «≈ n a day» under an editor are the ones the server
// computes — never a second reckoning on the screen. Its table test runs on
// both sides. Below, the editor's draft (PeriodEditor.tsx): what the owner
// types, and the period it saves.
import {
  PeriodError,
  cycleMinutes,
  parsePeriod,
  periodDay,
  periodErrors,
  stampPeriod,
  type Period,
  type PeriodRules,
  type PeriodUnit,
} from '../../../server/src/period'

export { periodWords, slotsPerDay, nextSlot, inWindow, cycleMinutes, intervalMinutes, stampPeriod, periodDay } from '../../../server/src/period'
export type { Period, PeriodUnit, PeriodRules } from '../../../server/src/period'

// the floors and their words — the server's (control.ts, automations-validate.ts)
export const HEARTBEAT_RULES: PeriodRules = { prefix: 'heartbeat.period.', minMinutes: 5, floorWords: 'a heartbeat runs every 5 minutes at most' }
export const AUTOMATION_RULES: PeriodRules = { prefix: 'trigger.period.', minMinutes: 1, floorWords: 'an automation runs every minute at most' }

export interface PeriodDraft {
  every: string // the input's text
  unit: PeriodUnit
  at: string // days and weeks
  day: number // weeks
  band: { from: string; to: string } | null // minutes and hours
  never: boolean // a heartbeat set to never (null)
}

export function draftOfPeriod(p: Period | null, fallback: Period = { every: 1, unit: 'weeks', day: 1, at: '09:00' }): PeriodDraft {
  const q = p ?? fallback
  return {
    every: String(q.every),
    unit: q.unit,
    at: q.at ?? fallback.at ?? '09:00',
    day: q.day ?? 1,
    band: q.between ? { ...q.between } : null,
    never: p === null,
  }
}

/** The period a draft saves (null: never). Its `at` on minutes/hours is
 *  left to the server: the agent's staggered minute from the band's
 *  start. `since` is never sent — the server stamps it. */
export function periodOfDraft(d: PeriodDraft): Period | null {
  if (d.never) return null
  const short = d.unit === 'minutes' || d.unit === 'hours'
  return {
    every: Number(d.every.trim()),
    unit: d.unit,
    ...(short ? {} : { at: d.at }),
    ...(d.unit === 'weeks' ? { day: d.day } : {}),
    ...(short && d.band ? { between: { ...d.band } } : {}),
  }
}

/** The period the server will keep for a draft (stampPeriod): on
 *  minutes/hours with no `at`, its agent's staggered minute counted from the
 *  band's start (band 08:00–20:00, minute 49 ⇒ 08:49). Throws the server's
 *  PeriodError — the same parse, the same stamp, the same «nothing falls
 *  between …». null: never. An unknown stagger (the agent not read yet):
 *  minute 0, the band's own start. */
export function stampedOfDraft(d: PeriodDraft, rules: PeriodRules, staggerMinute = 0, now = Date.now()): Period | null {
  const p = periodOfDraft(d)
  if (p === null) return null
  return stampPeriod(parsePeriod(p, rules), { today: periodDay(now), staggerMinute })
}

/** What is wrong with a draft — or null —, in screen words (screenProblem),
 *  BEFORE the click: the server's own parse and stamp, so what the editor
 *  holds is exactly what the server would refuse. */
export function periodProblem(d: PeriodDraft, rules: PeriodRules, staggerMinute?: number): string | null {
  try {
    stampedOfDraft(d, rules, staggerMinute)
    return null
  } catch (e) {
    if (e instanceof PeriodError) return screenProblem(e.message, rules, d, staggerMinute)
    throw e
  }
}

const sentence = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1)

/** A period's refusal — the editor's own, or a 400 the server sent back —
 *  in the words of the screen: no API field names, no prefix. A text this
 *  does not know is said as it came, in sentence case. */
export function screenProblem(message: string, rules: PeriodRules, d?: PeriodDraft, staggerMinute?: number): string {
  const text = message.trim()
  const e = periodErrors(rules.prefix)
  if (text === e.every) return 'How often takes a whole number, 1 or more.'
  if (text === e.unit) return 'Pick minutes, hours, days or weeks.'
  if (text === e.dayOrMore) return 'For a day or more, use days.'
  if (text === e.daysMax) return 'Days go up to 365 — for longer, use weeks.'
  if (text === e.weeksMax) return 'Weeks go up to 52.'
  if (text === e.at || text === e.atNeeded) return 'Pick the hour it runs at.'
  if (text === e.day || text === e.dayNeeded) return 'Pick the day of the week.'
  if (text === e.between) {
    const b = d?.band
    return b && b.from !== '' && b.from === b.to ? 'Pick two different hours — from and to are the same.' : 'Pick both hours of the band.'
  }
  if (text === rules.floorWords) return `${sentence(text)}.`
  const nothing = /^nothing falls between (\d\d:\d\d) and (\d\d:\d\d) — widen it$/.exec(text)
  if (nothing) {
    // why nothing falls there: an hourly period lands on its staggered minute
    const m = staggerMinute ?? 0
    const hourly = !!d && (d.unit === 'hours' || (d.unit === 'minutes' && Number(d.every) % 60 === 0))
    const lands = hourly && m > 0 ? ` — it lands at ${String(m).padStart(2, '0')} past the hour` : ''
    return `Nothing falls between ${nothing[1]} and ${nothing[2]}${lands}. Widen it.`
  }
  return sentence(text)
}

/** The draft's slots in a local day, as minutes — what the editor's day
 *  ruler draws: the period the server will stamp (the band's start
 *  plus the agent's staggered minute). A draft the server refuses draws
 *  none. */
export function draftSlots(d: PeriodDraft, staggerMinute?: number, rules: PeriodRules = AUTOMATION_RULES): number[] {
  let p: Period | null
  try {
    p = stampedOfDraft(d, rules, staggerMinute)
  } catch {
    return []
  }
  if (p === null) return []
  if (p.unit === 'days' || p.unit === 'weeks') {
    const [h, m] = (p.at ?? '00:00').split(':').map(Number) as [number, number]
    return [h * 60 + m]
  }
  return cycleMinutes(p)
}

/** How often, as the line under an editor says it: «≈ 4 runs a
 *  day» on minutes and hours (slotsPerDay over the stamped period), and the
 *  real cadence on days and weeks — «one run a day», «one run every 2 days»,
 *  «one round a week», «one run every 3 weeks» — never «≈ 1 a day» for a
 *  period that skips days. The server's slotsPerDay stays the engine's (its
 *  budget); this is the screen's wording. */
export function cadenceWords(p: Period, noun: 'run' | 'round'): string {
  const n = p.every
  if (p.unit === 'minutes' || p.unit === 'hours') {
    const k = cycleMinutes(p).length
    return `≈ ${k} ${k === 1 ? noun : `${noun}s`} a day`
  }
  if (p.unit === 'days') return n === 1 ? `one ${noun} a day` : `one ${noun} every ${n} days`
  return n === 1 ? `one ${noun} a week` : `one ${noun} every ${n} weeks`
}

/** «every 3 hours from 08:22» as a row begins it: «Every 3 hours from 08:22». */
export function capitalized(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}
