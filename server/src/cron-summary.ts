// cron-summary.ts — a readable summary of a 5-field cron ("weekdays
// 09:00", "daily 03:05", "weekly Mon 09:00"), falling back to the raw expr
// when it matches none of the three recognized presets — used by an
// automation's detail card (AutomationsPage.tsx, via triggerSummary in
// lib/automations.ts). Extracted from automations.ts as its own module
// with DIRECT tests (previously only tested indirectly through
// triggerSummary) — automations.ts re-exports all of this so existing
// imports (AutomationSheet.tsx, etc.) keep working.
// Lives on the server since 01-11 (automation proposals): the inbox says a
// proposed trigger in these same words, and the web re-exports this file
// (web/src/lib/cron-summary.ts) — one reading of a cron for both sides.
export type EveryPreset = 'weekdays' | 'daily' | 'weekly' | 'custom'

export interface EveryFields {
  preset: EveryPreset
  time: string // "HH:MM"
  weekday: number // 0 (Sunday) .. 6 — only relevant for 'weekly'
  custom: string // the raw expr — only relevant for 'custom'
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

// builds the 5-field cron from the sheet's readable fields.
export function cronFromEvery(f: EveryFields): string {
  if (f.preset === 'custom') return f.custom.trim()
  const [hh, mm] = f.time.split(':')
  const h = Number.parseInt(hh ?? '9', 10)
  const m = Number.parseInt(mm ?? '0', 10)
  if (f.preset === 'daily') return `${m} ${h} * * *`
  if (f.preset === 'weekdays') return `${m} ${h} * * 1-5`
  return `${m} ${h} * * ${f.weekday}` // weekly
}

// tries to recognize an already-saved cron as one of the three presets
// (for prefilling while editing); if it doesn't match any, falls back to
// 'custom' with the raw expr — this never fails, there's always a valid
// EveryFields that reconstructs the same cron via cronFromEvery.
export function everyFromCron(expr: string): EveryFields {
  const m = /^(\d{1,2}) (\d{1,2}) \* \* (\*|1-5|[0-6])$/.exec(expr.trim())
  if (m) {
    const mm = Number.parseInt(m[1] as string, 10)
    const hh = Number.parseInt(m[2] as string, 10)
    const time = `${pad(hh)}:${pad(mm)}`
    const dow = m[3] as string
    if (dow === '*') return { preset: 'daily', time, weekday: 1, custom: expr }
    if (dow === '1-5') return { preset: 'weekdays', time, weekday: 1, custom: expr }
    return { preset: 'weekly', time, weekday: Number.parseInt(dow, 10), custom: expr }
  }
  return { preset: 'custom', time: '09:00', weekday: 1, custom: expr }
}

export function defaultEveryFields(): EveryFields {
  return { preset: 'weekdays', time: '09:00', weekday: 1, custom: '0 9 * * *' }
}

// a human summary: "weekdays 09:00" · "daily 03:05" · "weekly Mon 09:00" —
// falls back to the raw expr if it matches none of the three recognized presets.
export function humanCron(expr: string): string {
  const f = everyFromCron(expr)
  if (f.preset === 'daily') return `daily ${f.time}`
  if (f.preset === 'weekdays') return `weekdays ${f.time}`
  if (f.preset === 'weekly') return `weekly ${DAYS[f.weekday] ?? ''} ${f.time}`.trim()
  // interval crons the presets don't cover — the raw expression read as
  // noise in the column ("0 */4 * * *"): say what it means instead.
  let m = /^(\d{1,2}) \*\/(\d{1,2}) \* \* \*$/.exec(expr.trim())
  if (m) return m[1] === '0' ? `every ${m[2]}h` : `every ${m[2]}h at :${m[1]!.padStart(2, '0')}`
  m = /^\*\/(\d{1,2}) \* \* \* \*$/.exec(expr.trim())
  if (m) return `every ${m[1]}min`
  // an interval over a window of hours: "58 1-23/2 * * *" → every 2h at :58, 01–23
  m = /^(\d{1,2}) (\d{1,2})-(\d{1,2})\/(\d{1,2}) \* \* \*$/.exec(expr.trim())
  if (m) return `every ${m[4]}h at :${m[1]!.padStart(2, '0')}, ${m[2]!.padStart(2, '0')}–${m[3]!.padStart(2, '0')}`
  // a day of every month: "7 6 5 * *" → monthly on the 5th, 06:07
  m = /^(\d{1,2}) (\d{1,2}) (\d{1,2}) \* \*$/.exec(expr.trim())
  if (m) return `monthly on the ${ordinal(Number.parseInt(m[3]!, 10))}, ${m[2]!.padStart(2, '0')}:${m[1]!.padStart(2, '0')}`
  // a list or range of weekdays: "0 9 * * 1,3,5" → Mon, Wed, Fri 09:00
  m = /^(\d{1,2}) (\d{1,2}) \* \* ([0-6](?:[,-][0-6])+)$/.exec(expr.trim())
  if (m) {
    const days = weekdayList(m[3]!)
    if (days) return `${days} ${m[2]!.padStart(2, '0')}:${m[1]!.padStart(2, '0')}`
  }
  // one date a year: "10 9 28 9 *" → yearly Sep 28 09:10
  m = /^(\d{1,2}) (\d{1,2}) (\d{1,2}) (\d{1,2}) \*$/.exec(expr.trim())
  if (m) {
    const month = MONTHS[Number.parseInt(m[4]!, 10) - 1]
    if (month) return `yearly ${month} ${Number.parseInt(m[3]!, 10)} ${m[2]!.padStart(2, '0')}:${m[1]!.padStart(2, '0')}`
  }
  return expr
}

function ordinal(n: number): string {
  const tens = n % 100
  if (tens >= 11 && tens <= 13) return `${n}th`
  return `${n}${['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`
}

// "1,3,5" → "Mon, Wed, Fri"; "1-3" → "Mon–Wed"; null when it isn't one
function weekdayList(field: string): string | null {
  const parts = field.split(',').map((p) => {
    const r = /^([0-6])-([0-6])$/.exec(p)
    if (r) return `${DAYS[Number(r[1])]}–${DAYS[Number(r[2])]}`
    return /^[0-6]$/.test(p) ? DAYS[Number(p)]! : null
  })
  return parts.every((p) => p !== null) ? parts.join(', ') : null
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
