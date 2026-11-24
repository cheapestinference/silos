// period.ts — the free period: ONE source for its
// shape, its validity (its exact 400s), its slots and its words. Pure —
// no I/O, no node built-ins — so the web imports this same file
// (web/src/lib/period.ts) and the «≈ n a day» a screen says is the one
// slotsPerDay computes here.
//
// Every wall clock here is the server machine's local zone: slots are
// computed in local wall time; an hour that does not exist (spring forward)
// fires at the first valid minute after it, one that repeats (fall back)
// fires once.

export type PeriodUnit = 'minutes' | 'hours' | 'days' | 'weeks'
export interface Period {
  every: number
  unit: PeriodUnit
  at?: string // 'HH:MM', local wall time
  day?: number // 0–6 (0 = Sunday) — weeks only
  between?: { from: string; to: string } // minutes/hours only; both ends inclusive; from > to crosses midnight
  since?: string // 'YYYY-MM-DD' — stamped by the SERVER, never taken from a client
}

export class PeriodError extends Error {}

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/
const YMD = /^\d{4}-\d{2}-\d{2}$/
const DAY_MIN = 24 * 60
const DAY_MS = 24 * 3600_000
// a period with no `since` (never stamped: the default heartbeat) counts its
// phase from a fixed Monday — every 1 day / 1 week never depends on it
const NO_SINCE = '1970-01-05'
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

const isUnit = (u: unknown): u is PeriodUnit => u === 'minutes' || u === 'hours' || u === 'days' || u === 'weeks'
const toMin = (hhmm: string): number => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5))
const fromMin = (m: number): string => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
const isShort = (p: Pick<Period, 'unit'>): boolean => p.unit === 'minutes' || p.unit === 'hours'

/** The interval of a minutes/hours period, in minutes. */
export function intervalMinutes(p: Pick<Period, 'every' | 'unit'>): number {
  switch (p.unit) {
    case 'minutes':
      return p.every
    case 'hours':
      return p.every * 60
    case 'days':
      return p.every * DAY_MIN
    case 'weeks':
      return p.every * 7 * DAY_MIN
  }
}

// ── validity (the 400s) ──

export interface PeriodRules {
  /** 'heartbeat.period.' or 'trigger.period.' */
  prefix: string
  /** the floor in minutes (HEARTBEAT_PERIOD_MIN / AUTOMATION_PERIOD_MIN) */
  minMinutes: number
  /** its 400 words */
  floorWords: string
}

export const periodErrors = (p: string) => ({
  every: `${p}every must be a whole number, 1 or more`,
  unit: `${p}unit must be minutes, hours, days or weeks`,
  dayOrMore: 'use days for a day or more',
  // days 1–365 and weeks 1–52: bounds worded here
  daysMax: `${p}every must be 1–365 with days`,
  weeksMax: `${p}every must be 1–52 with weeks`,
  at: `${p}at must be a 24h "HH:MM" time`,
  atNeeded: `${p}at is needed with days or weeks`,
  day: `${p}day must be 0–6 (0 = Sunday)`,
  dayNeeded: `${p}day is needed with weeks`,
  between: `${p}between takes "from" and "to" as 24h "HH:MM" times, with minutes or hours only`,
})
export const nothingBetween = (from: string, to: string): string => `nothing falls between ${from} and ${to} — widen it`

/** A client's period, validated (PeriodError with the exact 400 words). Its
 *  `since` is dropped — the server stamps it (stampPeriod); a `day` on a
 *  unit other than weeks is dropped (it means nothing there). */
export function parsePeriod(v: unknown, r: PeriodRules): Period {
  const e = periodErrors(r.prefix)
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new PeriodError(e.unit)
  const o = v as Record<string, unknown>
  if (typeof o.every !== 'number' || !Number.isInteger(o.every) || o.every < 1) throw new PeriodError(e.every)
  if (!isUnit(o.unit)) throw new PeriodError(e.unit)
  const out: Period = { every: o.every, unit: o.unit }
  if (o.unit === 'minutes' && o.every >= DAY_MIN) throw new PeriodError(e.dayOrMore)
  if (o.unit === 'hours' && o.every >= 24) throw new PeriodError(e.dayOrMore)
  if (o.unit === 'days' && o.every > 365) throw new PeriodError(e.daysMax)
  if (o.unit === 'weeks' && o.every > 52) throw new PeriodError(e.weeksMax)
  if (o.at !== undefined && o.at !== null) {
    if (typeof o.at !== 'string' || !HHMM.test(o.at)) throw new PeriodError(e.at)
    out.at = o.at
  } else if (!isShort(out)) throw new PeriodError(e.atNeeded)
  if (out.unit === 'weeks') {
    if (o.day === undefined || o.day === null) throw new PeriodError(e.dayNeeded)
    if (typeof o.day !== 'number' || !Number.isInteger(o.day) || o.day < 0 || o.day > 6) throw new PeriodError(e.day)
    out.day = o.day
  }
  if (o.between !== undefined && o.between !== null) {
    const b = o.between as Record<string, unknown>
    if (
      !isShort(out) ||
      typeof b !== 'object' ||
      Array.isArray(b) ||
      typeof b.from !== 'string' ||
      !HHMM.test(b.from) ||
      typeof b.to !== 'string' ||
      !HHMM.test(b.to) ||
      b.from === b.to
    ) {
      throw new PeriodError(e.between)
    }
    out.between = { from: b.from, to: b.to }
  }
  if (intervalMinutes(out) < r.minMinutes) throw new PeriodError(r.floorWords)
  return out
}

/** What the server writes: `since` stamped when unit or every
 *  changed from `prior`, or when it is missing — a save that touches
 *  neither keeps the phase; and, on minutes/hours with no `at`, the
 *  staggered minute of its agent counted from `between.from` (or 00:00):
 *  band 08:00–20:00, minute 22 ⇒ 08:22. Then a band no slot falls in is
 *  refused (PeriodError «nothing falls between …»). */
export function stampPeriod(p: Period, o: { prior?: Period | null; today: string; staggerMinute: number }): Period {
  const out: Period = { ...p }
  delete out.since
  const prior = o.prior
  if (prior && prior.unit === p.unit && prior.every === p.every && typeof prior.since === 'string' && YMD.test(prior.since)) out.since = prior.since
  else out.since = o.today
  if (isShort(out) && out.at === undefined) {
    const base = out.between ? toMin(out.between.from) : 0
    out.at = fromMin((base + o.staggerMinute) % DAY_MIN)
  }
  if (out.between && cycleMinutes(out).length === 0) throw new PeriodError(nothingBetween(out.between.from, out.between.to))
  return out
}

/** A stored period read back (agents.json, automations.json): valid, or
 *  null — never a guess. Its server-stamped `since` is kept when well formed. */
export function storedPeriod(v: unknown, minMinutes: number): Period | null {
  try {
    const p = parsePeriod(v, { prefix: '', minMinutes, floorWords: 'floor' })
    const since = (v as { since?: unknown }).since
    if (typeof since === 'string' && YMD.test(since)) p.since = since
    if (p.between && cycleMinutes(p).length === 0) return null
    return p
  } catch {
    return null
  }
}

// ── slots ──

const inBand = (m: number, b: Period['between']): boolean => {
  if (!b) return true
  const from = toMin(b.from),
    to = toMin(b.to)
  return from <= to ? m >= from && m <= to : m >= from || m <= to
}

/** The local minutes-of-day a minutes/hours period fires at, sorted: a
 *  cycle starts every local day at `at` (absent: `between.from`, else
 *  00:00); its slots are at + k·interval while they fall before the next
 *  `at`; the last one is dropped when it lands less than half an interval
 *  before that next `at` (never two fires almost together); a slot outside
 *  the band does not exist. Every local day holds exactly these. */
export function cycleMinutes(p: Period): number[] {
  if (!isShort(p)) return []
  const step = intervalMinutes(p)
  if (!Number.isInteger(step) || step < 1) return []
  const anchor = toMin(p.at ?? p.between?.from ?? '00:00')
  const out = new Set<number>()
  for (let k = 0; k * step < DAY_MIN; k++) {
    const off = k * step
    if (k > 0 && DAY_MIN - off < step / 2) break
    const m = (anchor + off) % DAY_MIN
    if (inBand(m, p.between)) out.add(m)
  }
  return [...out].sort((a, b) => a - b)
}

// a local wall time → its instant: a minute that does not exist (spring
// forward) becomes the first valid minute after it; one that repeats is
// the first of its two instants (it fires once)
function wallMs(y: number, mo: number, d: number, minute: number): number {
  const h = Math.floor(minute / 60),
    mi = minute % 60
  let t = new Date(y, mo, d, h, mi).getTime()
  const key = (x: Date): number => ((x.getFullYear() * 12 + x.getMonth()) * 31 + x.getDate()) * DAY_MIN + x.getHours() * 60 + x.getMinutes()
  const want = ((y * 12 + mo) * 31 + d) * DAY_MIN + h * 60 + mi
  const got = new Date(t)
  if (key(got) === want) return t
  // inside a gap: the engine moved it forward by the gap — walk back to
  // the transition, the first minute that exists after the wanted one
  for (let i = 0; i < 180 && key(new Date(t - 60_000)) > want; i++) t -= 60_000
  return t
}

const ymdUtc = (s: string): number => {
  const [y, m, d] = s.split('-').map(Number) as [number, number, number]
  return Date.UTC(y, m - 1, d)
}
// calendar days from `fromUtc` (a UTC midnight) to the local day y-mo-d
const daysFrom = (fromUtc: number, y: number, mo: number, d: number): number => Math.round((Date.UTC(y, mo, d) - fromUtc) / DAY_MS)
const mod = (a: number, n: number): number => ((a % n) + n) % n

/** The first slot strictly after `afterMs`, or null (a band no slot falls
 *  in — refused at write time, so only a hand-edited file gets here). */
export function nextSlot(p: Period, afterMs: number): number | null {
  const start = new Date(afterMs)
  const y = start.getFullYear(),
    mo = start.getMonth(),
    d0 = start.getDate()
  if (isShort(p)) {
    const mins = cycleMinutes(p)
    if (mins.length === 0) return null
    for (let d = 0; d <= 3; d++) {
      for (const m of mins) {
        const t = wallMs(y, mo, d0 + d, m)
        if (t > afterMs) return t
      }
    }
    return null
  }
  const at = toMin(p.at ?? '00:00')
  const sinceUtc = ymdUtc(p.since ?? NO_SINCE)
  if (p.unit === 'days') {
    for (let d = 0; d <= p.every + 1; d++) {
      const day = new Date(y, mo, d0 + d)
      if (mod(daysFrom(sinceUtc, day.getFullYear(), day.getMonth(), day.getDate()), p.every) !== 0) continue
      const t = wallMs(day.getFullYear(), day.getMonth(), day.getDate(), at)
      if (t > afterMs) return t
    }
    return null
  }
  // weeks: counted from the week (Monday first) of `since`
  const sinceDow = new Date(sinceUtc).getUTCDay()
  const mondayUtc = sinceUtc - mod(sinceDow - 1, 7) * DAY_MS
  for (let d = 0; d <= p.every * 7 + 7; d++) {
    const day = new Date(y, mo, d0 + d)
    if (day.getDay() !== (p.day ?? 1)) continue
    const week = Math.floor(daysFrom(mondayUtc, day.getFullYear(), day.getMonth(), day.getDate()) / 7)
    if (mod(week, p.every) !== 0) continue
    const t = wallMs(day.getFullYear(), day.getMonth(), day.getDate(), at)
    if (t > afterMs) return t
  }
  return null
}

/** How many slots a local day holds at most (the «≈ n a day» every screen
 *  says, and the budget an owner's automation is born with). */
export function slotsPerDay(p: Period): number {
  return isShort(p) ? cycleMinutes(p).length : 1
}

/** Whether `ms` falls inside the period's band (no band: always). */
export function inWindow(p: Period, ms: number): boolean {
  if (!p.between) return true
  const t = new Date(ms)
  return inBand(t.getHours() * 60 + t.getMinutes(), p.between)
}

/** The local day 'YYYY-MM-DD' of an instant. */
export function periodDay(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// ── words ──

/** «every 45 minutes» · «every 3 hours from 08:22» · «every day at 09:22» ·
 *  «every Monday at 09:22» · «every 2 weeks on Monday at 09:22»; a band adds
 *  « · 08:00–20:00». */
export function periodWords(p: Period): string {
  const n = p.every
  let s: string
  switch (p.unit) {
    case 'minutes':
      s = n === 1 ? 'every minute' : `every ${n} minutes`
      break
    case 'hours':
      s = `${n === 1 ? 'every hour' : `every ${n} hours`} from ${p.at ?? p.between?.from ?? '00:00'}`
      break
    case 'days':
      s = `${n === 1 ? 'every day' : `every ${n} days`} at ${p.at ?? '00:00'}`
      break
    case 'weeks': {
      const day = DAY_NAMES[p.day ?? 1] ?? 'Monday'
      s = n === 1 ? `every ${day} at ${p.at ?? '00:00'}` : `every ${n} weeks on ${day} at ${p.at ?? '00:00'}`
      break
    }
  }
  return p.between ? `${s} · ${p.between.from}–${p.between.to}` : s
}
