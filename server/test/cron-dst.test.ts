// The server runs in Europe/Berlin; cron fields are wall-clock time there.
// Fall back: 2026-10-25 03:00 CEST → 02:00 CET (01:00Z) — 02:xx happens twice.
// Spring forward: 2026-03-29 02:00 CET → 03:00 CEST (01:00Z) — 02:xx never happens.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { nextRun, isValidTimeZone } from '../src/cron.js'

let savedTz: string | undefined
beforeAll(() => {
  savedTz = process.env.TZ
  process.env.TZ = 'Europe/Berlin'
})
afterAll(() => {
  if (savedTz === undefined) delete process.env.TZ
  else process.env.TZ = savedTz
})

const Z = (iso: string) => new Date(iso)

// Every run a scheduler would make from `from` to `to`: fire at nextRun, then
// reschedule from the fire time plus `lag` (a run takes time).
function runs(expr: string, from: string, to: string, lag = 0): string[] {
  const out: string[] = []
  let after = Z(from)
  for (;;) {
    const next = nextRun(expr, after)
    expect(next.getTime()).toBeGreaterThan(after.getTime())
    if (next.getTime() > Z(to).getTime()) return out
    out.push(next.toISOString())
    after = new Date(next.getTime() + lag)
  }
}

describe('nextRun across DST fall-back (Europe/Berlin, 2026-10-25)', () => {
  it('never returns an instant at or before `after` (the audit repros)', () => {
    expect(nextRun('58 0-22/2 * * *', Z('2026-10-25T01:58:14Z')).toISOString()).toBe('2026-10-25T03:58:00.000Z')
    expect(nextRun('30 2 * * *', Z('2026-10-25T01:31:00Z')).toISOString()).toBe('2026-10-26T01:30:00.000Z')
  })

  it('a fixed-hour job inside the repeated hour runs once, at the first 02:30', () => {
    expect(runs('30 2 * * *', '2026-10-24T12:00:00Z', '2026-10-26T12:00:00Z', 14_000)).toEqual([
      '2026-10-25T00:30:00.000Z', // 02:30 CEST
      '2026-10-26T01:30:00.000Z', // 02:30 CET, next day
    ])
  })

  it('every-2-hours at :58 runs once per wall-clock slot through the night', () => {
    expect(runs('58 0-22/2 * * *', '2026-10-24T21:00:00Z', '2026-10-25T06:00:00Z', 14_000)).toEqual([
      '2026-10-24T22:58:00.000Z', // 00:58 CEST
      '2026-10-25T00:58:00.000Z', // 02:58 CEST (the 02:58 CET repeat is skipped)
      '2026-10-25T03:58:00.000Z', // 04:58 CET
      '2026-10-25T05:58:00.000Z', // 06:58 CET
    ])
  })

  it('every-4-hours and every-3-hours keep their wall-clock slots', () => {
    expect(runs('0 */4 * * *', '2026-10-24T21:00:00Z', '2026-10-25T08:00:00Z')).toEqual([
      '2026-10-24T22:00:00.000Z', // 00:00 CEST
      '2026-10-25T03:00:00.000Z', // 04:00 CET
      '2026-10-25T07:00:00.000Z', // 08:00 CET
    ])
    expect(runs('0 */3 * * *', '2026-10-24T21:00:00Z', '2026-10-25T06:00:00Z')).toEqual([
      '2026-10-24T22:00:00.000Z', // 00:00 CEST
      '2026-10-25T02:00:00.000Z', // 03:00 CET
      '2026-10-25T05:00:00.000Z', // 06:00 CET
    ])
  })

  it('an every-minute watch never re-checks the same wall-clock minute (no busy hour)', () => {
    const seen = runs('* * * * *', '2026-10-25T00:00:00Z', '2026-10-25T02:30:00Z')
    expect(new Set(seen).size).toBe(seen.length)
    // 02:00–02:59 CEST, then the repeat 02:00–02:59 CET is skipped, then 03:00 CET on
    expect(seen).toContain('2026-10-25T00:59:00.000Z')
    expect(seen).not.toContain('2026-10-25T01:30:00.000Z')
    expect(seen).toContain('2026-10-25T02:00:00.000Z')
  })

  it('created during the repeated hour: the slot already passed once is not fired again', () => {
    // 02:10 CET — the first 02:45 (CEST, 00:45Z) is in the past
    expect(nextRun('45 2 * * *', Z('2026-10-25T01:10:00Z')).toISOString()).toBe('2026-10-26T01:45:00.000Z')
    // 02:10 CEST — the first 02:45 is still ahead
    expect(nextRun('45 2 * * *', Z('2026-10-25T00:10:00Z')).toISOString()).toBe('2026-10-25T00:45:00.000Z')
  })
})

describe('nextRun across DST spring-forward (Europe/Berlin, 2026-03-29)', () => {
  it('a job at a wall-clock time that does not exist runs once, at the first instant after the gap', () => {
    expect(runs('30 2 * * *', '2026-03-28T12:00:00Z', '2026-03-30T12:00:00Z', 14_000)).toEqual([
      '2026-03-29T01:00:00.000Z', // 03:00 CEST — 02:30 never happened
      '2026-03-30T00:30:00.000Z', // 02:30 CEST, next day
    ])
  })

  it('an every-15-minutes job collapses the swallowed hour into one run', () => {
    expect(runs('*/15 * * * *', '2026-03-29T00:20:00Z', '2026-03-29T01:20:00Z', 5_000)).toEqual([
      '2026-03-29T00:30:00.000Z', // 01:30 CET
      '2026-03-29T00:45:00.000Z', // 01:45 CET
      '2026-03-29T01:00:00.000Z', // 02:00..02:45 don't exist → 03:00 CEST, once
      '2026-03-29T01:15:00.000Z', // 03:15 CEST
    ])
  })

  it('every-2-hours keeps its slots, 02:58 lands on 03:00 once', () => {
    expect(runs('58 0-22/2 * * *', '2026-03-28T22:00:00Z', '2026-03-29T05:00:00Z', 14_000)).toEqual([
      '2026-03-28T23:58:00.000Z', // 00:58 CET
      '2026-03-29T01:00:00.000Z', // 02:58 doesn't exist → 03:00 CEST
      '2026-03-29T02:58:00.000Z', // 04:58 CEST
      '2026-03-29T04:58:00.000Z', // 06:58 CEST
    ])
  })

  it('a job right after the gap is unaffected', () => {
    expect(nextRun('0 3 * * *', Z('2026-03-28T12:00:00Z')).toISOString()).toBe('2026-03-29T01:00:00.000Z')
    expect(nextRun('59 1 * * *', Z('2026-03-28T12:00:00Z')).toISOString()).toBe('2026-03-29T00:59:00.000Z')
  })
})

// trigger.tz: the cron's wall clock read in another zone. The server stays in
// Berlin; New York falls back a week later (2026-11-01 02:00 EDT → 01:00 EST,
// 06:00Z) and springs forward on 2026-03-08 (02:00 EST → 03:00 EDT, 07:00Z).
describe('nextRun with trigger.tz', () => {
  it("a fixed hour is that hour in the given zone, not in the server's", () => {
    expect(nextRun('0 9 * * *', Z('2026-08-19T00:00:00Z'), 'America/New_York').toISOString()).toBe('2026-08-19T13:00:00.000Z') // 09:00 EDT
    expect(nextRun('0 9 * * *', Z('2026-12-01T00:00:00Z'), 'America/New_York').toISOString()).toBe('2026-12-01T14:00:00.000Z') // 09:00 EST
    expect(nextRun('0 9 * * *', Z('2026-08-19T00:00:00Z'), 'UTC').toISOString()).toBe('2026-08-19T09:00:00.000Z')
    expect(nextRun('30 5 * * *', Z('2026-08-19T00:00:00Z'), 'Asia/Kolkata').toISOString()).toBe('2026-08-20T00:00:00.000Z') // +05:30
    // tz = the server's own zone gives the same instants as no tz
    expect(nextRun('58 0-22/2 * * *', Z('2026-10-25T01:58:14Z'), 'Europe/Berlin').toISOString()).toBe('2026-10-25T03:58:00.000Z')
  })

  it('day-of-week is read in the zone too', () => {
    // 2026-08-23 is a Sunday; 23:30 Sunday in New York is already Monday in UTC
    expect(nextRun('30 23 * * 0', Z('2026-08-20T00:00:00Z'), 'America/New_York').toISOString()).toBe('2026-08-24T03:30:00.000Z')
  })

  it("the zone's own DST: fall back fires the repeated slot once, spring forward lands after the gap once", () => {
    expect(nextRun('30 1 * * *', Z('2026-11-01T00:00:00Z'), 'America/New_York').toISOString()).toBe('2026-11-01T05:30:00.000Z') // 01:30 EDT
    expect(nextRun('30 1 * * *', Z('2026-11-01T05:30:05Z'), 'America/New_York').toISOString()).toBe('2026-11-02T06:30:00.000Z') // not 01:30 EST
    expect(nextRun('30 2 * * *', Z('2026-03-08T00:00:00Z'), 'America/New_York').toISOString()).toBe('2026-03-08T07:00:00.000Z') // 03:00 EDT
    expect(nextRun('30 2 * * *', Z('2026-03-08T07:00:05Z'), 'America/New_York').toISOString()).toBe('2026-03-09T06:30:00.000Z')
  })

  it('an unknown zone throws; isValidTimeZone tells them apart', () => {
    expect(() => nextRun('0 9 * * *', Z('2026-08-19T00:00:00Z'), 'Mars/Phobos')).toThrow()
    expect(isValidTimeZone('America/New_York')).toBe(true)
    expect(isValidTimeZone('UTC')).toBe(true)
    expect(isValidTimeZone('Mars/Phobos')).toBe(false)
    expect(isValidTimeZone('')).toBe(false)
  })
})
