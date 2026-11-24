// schedule.ts — the automation editor's "When it runs", as sentences.
// A saved trigger is PARSED into a draft the builder can
// show as one of six sentences — "Every day at 09:00", "Weekdays at 09:00",
// "Every week on Monday at 09:00", "Every 2 hours at minute :58 (between
// 00 and 22)", "Once, on 21 Oct at 06:30", or the raw cron expression —
// and serialized back into the trigger the server stores. Parsing never
// fails and never loses anything: what the presets can't say lands in
// 'custom' with the owner's expression verbatim.
//
// Plus a small client-side "next runs" for the preview line. The server's
// DST-safe scheduler (server/src/cron.ts) is the truth; this one only
// reads the same 5 fields in a named zone well enough to show the next
// three times — it is never imported by, nor feeds, the server.
import type { CronTrigger, OnceTrigger } from './types'

export type ScheduleKind = 'daily' | 'weekdays' | 'weekly' | 'hourly' | 'once' | 'custom'

// ONE draft holds every sentence's values, so switching sentence keeps
// what was typed in the others (the time carries from "every day" to
// "weekdays" untouched).
export interface ScheduleDraft {
  kind: ScheduleKind
  time: string // "HH:MM" — daily, weekdays, weekly
  weekday: number // 0 (Sunday) … 6 — weekly
  everyHours: number // hourly: every N hours (1–23)
  minute: number // hourly: at minute :MM
  window: { from: number; to: number } | null // hourly: only between these hours
  onceDate: string // "YYYY-MM-DD" — local
  onceTime: string // "HH:MM" — local
  custom: string // the raw 5-field expression
  // the IANA zone a cron's wall clock is read in; '' = not set (the
  // server's own clock — what every automation saved before tz existed has)
  tz: string
}

export const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

const pad = (n: number): string => String(n).padStart(2, '0')

export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

export function isValidTimeZone(tz: string): boolean {
  if (!tz) return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return true
  } catch {
    return false
  }
}

// a local "YYYY-MM-DD" + "HH:MM" one hour from now, on the minute
function inAnHour(nowMs: number): { date: string; time: string } {
  const d = new Date(nowMs + 3_600_000)
  return { date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`, time: `${pad(d.getHours())}:${pad(d.getMinutes())}` }
}

export function defaultDraft(opts: { tz?: string; nowMs?: number } = {}): ScheduleDraft {
  const once = inAnHour(opts.nowMs ?? Date.now())
  return {
    kind: 'daily',
    time: '09:00',
    weekday: 1,
    everyHours: 2,
    minute: 0,
    window: null,
    onceDate: once.date,
    onceTime: once.time,
    custom: '0 9 * * *',
    tz: opts.tz ?? browserTimeZone(),
  }
}

const int = (s: string): number => Number.parseInt(s, 10)

// a 5-field cron → the sentence that says the same thing, or 'custom'
// carrying the expression untouched. Every match is range-checked: "70 9
// * * *" is not "every day at 09:70".
export function draftFromCron(expr: string, base: ScheduleDraft): ScheduleDraft {
  const e = expr.trim().replace(/\s+/g, ' ')
  const custom: ScheduleDraft = { ...base, kind: 'custom', custom: expr }
  const okM = (m: number) => m >= 0 && m <= 59
  const okH = (h: number) => h >= 0 && h <= 23

  let m = /^(\d{1,2}) (\d{1,2}) \* \* (\*|1-5|[0-7])$/.exec(e)
  if (m) {
    const mm = int(m[1]!)
    const hh = int(m[2]!)
    if (!okM(mm) || !okH(hh)) return custom
    const time = `${pad(hh)}:${pad(mm)}`
    const dow = m[3]!
    if (dow === '*') return { ...base, kind: 'daily', time }
    if (dow === '1-5') return { ...base, kind: 'weekdays', time }
    return { ...base, kind: 'weekly', time, weekday: int(dow) % 7 }
  }
  // every N hours: "58 * * * *" (N=1) · "0 */4 * * *"
  m = /^(\d{1,2}) \*(?:\/(\d{1,2}))? \* \* \*$/.exec(e)
  if (m) {
    const mm = int(m[1]!)
    const n = m[2] ? int(m[2]) : 1
    if (!okM(mm) || n < 1 || n > 23) return custom
    return { ...base, kind: 'hourly', minute: mm, everyHours: n, window: null }
  }
  // every N hours within a window: "58 0-22/2 * * *" · "0 8-18 * * *"
  m = /^(\d{1,2}) (\d{1,2})-(\d{1,2})(?:\/(\d{1,2}))? \* \* \*$/.exec(e)
  if (m) {
    const mm = int(m[1]!)
    const from = int(m[2]!)
    const to = int(m[3]!)
    const n = m[4] ? int(m[4]) : 1
    if (!okM(mm) || !okH(from) || !okH(to) || from > to || n < 1 || n > 23) return custom
    return { ...base, kind: 'hourly', minute: mm, everyHours: n, window: { from, to } }
  }
  return custom
}

function localParts(iso: string): { date: string; time: string } | null {
  const ms = Date.parse(iso)
  if (Number.isNaN(ms)) return null
  const d = new Date(ms)
  return { date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`, time: `${pad(d.getHours())}:${pad(d.getMinutes())}` }
}

// a saved once/cron trigger → the draft the builder opens with. An
// existing cron keeps ITS tz (none = '' — the server's clock); only a new
// automation starts in the browser's zone (defaultDraft).
export function draftFromTrigger(t: OnceTrigger | CronTrigger, opts: { nowMs?: number } = {}): ScheduleDraft {
  const base = defaultDraft({ tz: t.kind === 'cron' ? (t.tz ?? '') : browserTimeZone(), nowMs: opts.nowMs })
  if (t.kind === 'once') {
    const p = localParts(t.at)
    return p ? { ...base, kind: 'once', onceDate: p.date, onceTime: p.time } : base
  }
  return draftFromCron(t.expr, base)
}

// the cron a sentence draft says (null for 'once')
export function cronOfDraft(d: ScheduleDraft): string | null {
  const [hh, mm] = d.time.split(':').map((x) => int(x))
  switch (d.kind) {
    case 'daily':
      return `${mm ?? 0} ${hh ?? 9} * * *`
    case 'weekdays':
      return `${mm ?? 0} ${hh ?? 9} * * 1-5`
    case 'weekly':
      return `${mm ?? 0} ${hh ?? 9} * * ${d.weekday}`
    case 'hourly': {
      const step = d.everyHours > 1 ? `/${d.everyHours}` : ''
      if (d.window) return `${d.minute} ${d.window.from}-${d.window.to}${step} * * *`
      return `${d.minute} *${step} * * *`
    }
    case 'custom':
      return d.custom.trim().replace(/\s+/g, ' ')
    case 'once':
      return null
  }
}

// the draft → the trigger to save. A once is an instant (the local date
// and time read in the browser's zone, as the input shows them).
export function triggerOfDraft(d: ScheduleDraft): OnceTrigger | CronTrigger {
  if (d.kind === 'once') {
    const ms = Date.parse(`${d.onceDate}T${d.onceTime}`)
    return { kind: 'once', at: Number.isNaN(ms) ? '' : new Date(ms).toISOString() }
  }
  const expr = cronOfDraft(d) ?? ''
  return d.tz ? { kind: 'cron', expr, tz: d.tz } : { kind: 'cron', expr }
}

// what's wrong with the draft, in words for under the field — null = fine
export function draftProblem(d: ScheduleDraft, nowMs: number = Date.now()): string | null {
  if (d.kind === 'once') {
    const ms = Date.parse(`${d.onceDate}T${d.onceTime}`)
    if (Number.isNaN(ms)) return 'Pick a date and a time.'
    if (ms <= nowMs) return 'That moment has already passed — pick one in the future.'
    return null
  }
  if (d.kind === 'hourly') {
    if (!Number.isInteger(d.everyHours) || d.everyHours < 1 || d.everyHours > 23) return 'Every 1 to 23 hours.'
    if (!Number.isInteger(d.minute) || d.minute < 0 || d.minute > 59) return 'The minute goes from 00 to 59.'
    if (d.window && d.window.from > d.window.to) return 'The window starts before it ends — e.g. between 08 and 20.'
  }
  if (d.kind !== 'custom' && !/^\d{1,2}:\d{2}$/.test(d.time)) return 'Pick a time.'
  if (d.kind === 'custom') {
    const expr = d.custom.trim()
    if (!expr) return 'Write a cron expression: minute hour day month weekday.'
    if (!parseCron(expr)) return 'Not a cron expression the scheduler understands — five fields: minute hour day month weekday.'
  }
  if (d.tz && !isValidTimeZone(d.tz)) return `“${d.tz}” isn’t a time zone — use one like Europe/Madrid.`
  return null
}

// ---- a minimal cron reader for the preview ------------------------------

interface CronSets {
  minute: Set<number>
  hour: Set<number>
  dom: Set<number>
  month: Set<number>
  dow: Set<number>
  domR: boolean
  dowR: boolean
}

function field(raw: string, min: number, max: number, dow = false): Set<number> | null {
  const out = new Set<number>()
  for (const part of raw.split(',')) {
    const m = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part.trim())
    if (!m) return null
    const step = m[2] !== undefined ? int(m[2]) : 1
    if (step <= 0) return null
    let lo = min
    let hi = max
    if (m[1] !== '*') {
      const [a, b] = m[1]!.split('-').map(int)
      lo = a!
      hi = b ?? a!
    }
    const top = dow ? 7 : max
    if (lo > hi || lo < min || hi > top) return null
    for (let v = lo; v <= hi; v += step) out.add(dow && v === 7 ? 0 : v)
  }
  return out.size ? out : null
}

export function parseCron(expr: string): CronSets | null {
  const p = expr.trim().split(/\s+/)
  if (p.length !== 5) return null
  const minute = field(p[0]!, 0, 59)
  const hour = field(p[1]!, 0, 23)
  const dom = field(p[2]!, 1, 31)
  const month = field(p[3]!, 1, 12)
  const dow = field(p[4]!, 0, 6, true)
  if (!minute || !hour || !dom || !month || !dow) return null
  return { minute, hour, dom, month, dow, domR: p[2] !== '*', dowR: p[4] !== '*' }
}

const DOW: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }

// the next `count` instants a cron fires at, read in `tz`. Jumps a whole
// wall-clock hour when the day or the hour can't match, so even a yearly
// expression costs a few thousand steps at most.
export function nextRuns(expr: string, tz: string, afterMs: number, count = 3): number[] {
  const c = parseCron(expr)
  if (!c || !isValidTimeZone(tz)) return []
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    weekday: 'short',
  })
  const out: number[] = []
  let t = Math.floor(afterMs / 60_000) * 60_000 + 60_000
  for (let i = 0; i < 30_000 && out.length < count; i++) {
    const parts: Record<string, string> = {}
    for (const p of fmt.formatToParts(new Date(t))) parts[p.type] = p.value
    const month = int(parts.month!)
    const day = int(parts.day!)
    const hour = int(parts.hour!) % 24
    const minute = int(parts.minute!)
    const dow = DOW[parts.weekday!] ?? 0
    const dayOk = c.domR && c.dowR ? c.dom.has(day) || c.dow.has(dow) : c.dom.has(day) && c.dow.has(dow)
    if (!c.month.has(month) || !dayOk || !c.hour.has(hour)) {
      t += (60 - minute) * 60_000
      continue
    }
    if (c.minute.has(minute)) out.push(t)
    t += 60_000
  }
  return out
}

// "Tue 21 Oct 06:30 · Wed 22 · Thu 23" — the first in full, the rest only
// as much as differs: the same time on another day says the day; another
// time on the same day says the time.
export function formatNextRuns(times: number[], tz: string): string {
  if (times.length === 0) return ''
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz || undefined,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  })
  const parts = times.map((t) => {
    const o: Record<string, string> = {}
    for (const p of fmt.formatToParts(new Date(t))) o[p.type] = p.value
    return { wd: o.weekday!, day: o.day!, mon: o.month!, hm: `${o.hour}:${o.minute}` }
  })
  const first = parts[0]!
  const out = [`${first.wd} ${first.day} ${first.mon} ${first.hm}`]
  for (let i = 1; i < parts.length; i++) {
    const p = parts[i]!
    const prev = parts[i - 1]!
    const sameDay = p.day === prev.day && p.mon === prev.mon
    if (sameDay) out.push(p.hm)
    else if (p.hm === first.hm) out.push(p.mon === first.mon ? `${p.wd} ${p.day}` : `${p.wd} ${p.day} ${p.mon}`)
    else out.push(`${p.wd} ${p.day} ${p.hm}`)
  }
  return out.join(' · ')
}

// every IANA zone the browser knows, for the zone field's suggestions
export function knownTimeZones(): string[] {
  try {
    const f = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf
    return f ? f('timeZone') : []
  } catch {
    return []
  }
}
