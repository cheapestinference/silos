// period-table.ts — THE table of the free period:
// words, slots a day and next slots, read by the server's test and by
// the web's (web/src/lib/period.test.ts) — one table, both sides. Wall times
// are local; the tests that read it pin TZ to a zone with DST.
import type { Period } from '../src/period.js'

export const PERIOD_TZ = 'Europe/Madrid' // DST: 2026-03-29 02:00→03:00, 2026-10-25 03:00→02:00

export const WORDS: Array<[Period, string]> = [
  [{ every: 45, unit: 'minutes', at: '00:00' }, 'every 45 minutes'],
  [{ every: 1, unit: 'minutes', at: '00:00' }, 'every minute'],
  [{ every: 3, unit: 'hours', at: '08:22' }, 'every 3 hours from 08:22'],
  [{ every: 1, unit: 'hours', at: '00:07' }, 'every hour from 00:07'],
  [{ every: 1, unit: 'days', at: '09:22' }, 'every day at 09:22'],
  [{ every: 2, unit: 'days', at: '09:22' }, 'every 2 days at 09:22'],
  [{ every: 1, unit: 'weeks', day: 1, at: '09:22' }, 'every Monday at 09:22'],
  [{ every: 2, unit: 'weeks', day: 1, at: '09:22' }, 'every 2 weeks on Monday at 09:22'],
  [{ every: 3, unit: 'hours', at: '08:22', between: { from: '08:00', to: '20:00' } }, 'every 3 hours from 08:22 · 08:00–20:00'],
]

export const PER_DAY: Array<[Period, number]> = [
  [{ every: 5, unit: 'hours', at: '08:22' }, 5], // 08:22 13:22 18:22 23:22 04:22
  [{ every: 7, unit: 'hours', at: '00:00' }, 3], // 21:00 lands 3 h before the next 00:00 (< half of 7 h): dropped
  [{ every: 45, unit: 'minutes', at: '00:00' }, 32],
  [{ every: 5, unit: 'minutes', at: '00:02' }, 288],
  [{ every: 3, unit: 'hours', at: '08:22', between: { from: '08:00', to: '20:00' } }, 4], // 20:22 is outside
  [{ every: 1, unit: 'hours', at: '22:00', between: { from: '22:00', to: '02:00' } }, 5], // across midnight, both ends inclusive
  [{ every: 1, unit: 'days', at: '09:22' }, 1],
  [{ every: 2, unit: 'weeks', day: 1, at: '09:22' }, 1],
]

// [period, after (local wall), the next slot (local wall)]
export const NEXT: Array<[string, Period, string, string]> = [
  ['the cycle', { every: 5, unit: 'hours', at: '08:22' }, '2026-11-11 08:22', '2026-11-11 13:22'],
  ['the cycle wraps past midnight', { every: 5, unit: 'hours', at: '08:22' }, '2026-11-11 23:22', '2026-11-12 04:22'],
  ['back to the anchor', { every: 5, unit: 'hours', at: '08:22' }, '2026-11-12 04:22', '2026-11-12 08:22'],
  ['the last slot dropped', { every: 7, unit: 'hours', at: '00:00' }, '2026-11-11 14:00', '2026-11-12 00:00'],
  ['the band', { every: 3, unit: 'hours', at: '08:22', between: { from: '08:00', to: '20:00' } }, '2026-11-11 17:22', '2026-11-12 08:22'],
  ['a band across midnight', { every: 1, unit: 'hours', at: '22:00', between: { from: '22:00', to: '02:00' } }, '2026-11-11 02:00', '2026-11-11 22:00'],
  ['across midnight, inside', { every: 1, unit: 'hours', at: '22:00', between: { from: '22:00', to: '02:00' } }, '2026-11-11 23:30', '2026-11-12 00:00'],
  ['days from since', { every: 2, unit: 'days', at: '09:22', since: '2026-11-10' }, '2026-11-11 08:00', '2026-11-12 09:22'],
  ['days, today still to come', { every: 2, unit: 'days', at: '09:22', since: '2026-11-10' }, '2026-11-10 09:00', '2026-11-10 09:22'],
  ['weeks from the week of since', { every: 2, unit: 'weeks', day: 1, at: '09:22', since: '2026-11-11' }, '2026-11-11 10:00', '2026-11-23 09:22'],
  ['a weekly default with no since', { every: 1, unit: 'weeks', day: 1, at: '09:22' }, '2026-11-11 10:00', '2026-11-16 09:22'],
  ['spring forward: a missing hour fires at the first minute after it', { every: 30, unit: 'minutes', at: '00:00' }, '2026-03-29 01:45', '2026-03-29 03:00'],
  ['spring forward: a daily hour inside the gap', { every: 1, unit: 'days', at: '02:30' }, '2026-03-29 00:00', '2026-03-29 03:00'],
]
