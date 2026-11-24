// period.test.ts — the free period (q1):
// the shared table (words, slots a day, next slots — band, midnight, the
// last slot, DST, since), the 400s, the stamp and the window.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PeriodError, inWindow, nextSlot, parsePeriod, periodWords, slotsPerDay, stampPeriod, storedPeriod, type Period } from '../src/period.js'
import { NEXT, PER_DAY, PERIOD_TZ, WORDS } from './period-table.js'

let savedTz: string | undefined
beforeAll(() => {
  savedTz = process.env.TZ
  process.env.TZ = PERIOD_TZ
})
afterAll(() => {
  if (savedTz === undefined) delete process.env.TZ
  else process.env.TZ = savedTz
})

const wall = (s: string): number => {
  const [d, t] = s.split(' ') as [string, string]
  const [y, mo, da] = d.split('-').map(Number) as [number, number, number]
  const [h, mi] = t.split(':').map(Number) as [number, number]
  return new Date(y, mo - 1, da, h, mi).getTime()
}
const fmt = (ms: number): string => {
  const x = new Date(ms)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${x.getFullYear()}-${p(x.getMonth() + 1)}-${p(x.getDate())} ${p(x.getHours())}:${p(x.getMinutes())}`
}

describe('the table (shared with web)', () => {
  it.each(WORDS)('periodWords %j', (p, words) => {
    expect(periodWords(p)).toBe(words)
  })
  it.each(PER_DAY)('slotsPerDay %j', (p, n) => {
    expect(slotsPerDay(p)).toBe(n)
  })
  it.each(NEXT)('nextSlot: %s', (_name, p, after, want) => {
    expect(fmt(nextSlot(p, wall(after))!)).toBe(want)
  })
})

describe('DST', () => {
  it('a repeated hour fires once: after the first 02:30 of the fall-back night, 03:00 is next', () => {
    const p: Period = { every: 30, unit: 'minutes', at: '00:00' }
    const first = new Date(2026, 9, 25, 2, 30).getTime()
    const next = nextSlot(p, first)!
    expect(fmt(next)).toBe('2026-10-25 03:00')
    expect(next - first).toBe(90 * 60_000) // the repeated 02:00–02:59 never fires again
  })
  it('a daily slot in the repeated hour fires once that day', () => {
    const p: Period = { every: 1, unit: 'days', at: '02:30' }
    const first = nextSlot(p, new Date(2026, 9, 25, 0, 0).getTime())!
    expect(fmt(nextSlot(p, first)!)).toBe('2026-10-26 02:30')
  })
  it('two slots in the missing hour are one fire', () => {
    const p: Period = { every: 30, unit: 'minutes', at: '00:00' }
    const three = nextSlot(p, wall('2026-03-29 01:45'))!
    expect(fmt(nextSlot(p, three)!)).toBe('2026-03-29 03:30')
  })
})

const HB = { prefix: 'heartbeat.period.', minMinutes: 5, floorWords: 'a heartbeat runs every 5 minutes at most' }
const AUTO = { prefix: 'trigger.period.', minMinutes: 1, floorWords: 'an automation runs every minute at most' }
const refused = (v: unknown, r = HB): string => {
  try {
    parsePeriod(v, r)
  } catch (e) {
    if (e instanceof PeriodError) return e.message
    throw e
  }
  return 'accepted'
}

describe('the 400s', () => {
  it.each([
    [{ every: 0, unit: 'hours' }, 'heartbeat.period.every must be a whole number, 1 or more'],
    [{ every: 1.5, unit: 'hours' }, 'heartbeat.period.every must be a whole number, 1 or more'],
    [{ every: 2, unit: 'months' }, 'heartbeat.period.unit must be minutes, hours, days or weeks'],
    [{ every: 24, unit: 'hours' }, 'use days for a day or more'],
    [{ every: 1440, unit: 'minutes' }, 'use days for a day or more'],
    [{ every: 1, unit: 'days', at: '9:00' }, 'heartbeat.period.at must be a 24h "HH:MM" time'],
    [{ every: 1, unit: 'days' }, 'heartbeat.period.at is needed with days or weeks'],
    [{ every: 1, unit: 'weeks', at: '09:00' }, 'heartbeat.period.day is needed with weeks'],
    [{ every: 1, unit: 'weeks', at: '09:00', day: 7 }, 'heartbeat.period.day must be 0–6 (0 = Sunday)'],
    [
      { every: 1, unit: 'days', at: '09:00', between: { from: '08:00', to: '20:00' } },
      'heartbeat.period.between takes "from" and "to" as 24h "HH:MM" times, with minutes or hours only',
    ],
    [
      { every: 1, unit: 'hours', between: { from: '08:00', to: '08:00' } },
      'heartbeat.period.between takes "from" and "to" as 24h "HH:MM" times, with minutes or hours only',
    ],
    [{ every: 4, unit: 'minutes' }, 'a heartbeat runs every 5 minutes at most'],
  ])('%j', (v, words) => {
    expect(refused(v)).toBe(words)
  })

  it('the floors: a heartbeat 5 minutes, an automation 1', () => {
    expect(refused({ every: 5, unit: 'minutes' })).toBe('accepted')
    expect(refused({ every: 1, unit: 'minutes' }, AUTO)).toBe('accepted')
    expect(refused({ every: 0, unit: 'minutes' }, AUTO)).toBe('trigger.period.every must be a whole number, 1 or more')
  })

  it('a band no slot falls in: «nothing falls between … — widen it»', () => {
    const p = parsePeriod({ every: 5, unit: 'hours', at: '01:00', between: { from: '08:00', to: '09:00' } }, HB)
    expect(() => stampPeriod(p, { today: '2026-11-11', staggerMinute: 0 })).toThrow('nothing falls between 08:00 and 09:00 — widen it')
  })
})

describe('the stamp', () => {
  it("since: the server's — a client's is ignored; kept while unit and every stay; moved when they change", () => {
    const asked = parsePeriod({ every: 2, unit: 'days', at: '09:00', since: '1999-01-01' }, HB)
    expect(asked.since).toBeUndefined()
    const first = stampPeriod(asked, { today: '2026-11-11', staggerMinute: 7 })
    expect(first.since).toBe('2026-11-11')
    const sameRhythm = stampPeriod({ ...asked, at: '10:00' }, { prior: first, today: '2026-11-20', staggerMinute: 7 })
    expect(sameRhythm.since).toBe('2026-11-11')
    expect(stampPeriod({ ...asked, every: 3 }, { prior: first, today: '2026-11-20', staggerMinute: 7 }).since).toBe('2026-11-20')
  })
  it("no `at` on minutes/hours: the staggered minute from the band's start (08:22), or from 00:00", () => {
    expect(stampPeriod({ every: 3, unit: 'hours', between: { from: '08:00', to: '20:00' } }, { today: '2026-11-11', staggerMinute: 22 }).at).toBe('08:22')
    expect(stampPeriod({ every: 3, unit: 'hours' }, { today: '2026-11-11', staggerMinute: 22 }).at).toBe('00:22')
  })
  it('a stored period read back: valid or null, never a guess', () => {
    expect(storedPeriod({ rhythm: 'week', day: 1, at: '09:00' }, 5)).toBeNull()
    expect(storedPeriod({ every: 1, unit: 'weeks', day: 1, at: '09:07', since: '2026-11-11' }, 5)).toEqual({
      every: 1,
      unit: 'weeks',
      day: 1,
      at: '09:07',
      since: '2026-11-11',
    })
  })
})

describe('inWindow', () => {
  it('inside the band, both ends inclusive; across midnight; no band is always', () => {
    const day: Period = { every: 3, unit: 'hours', at: '08:22', between: { from: '08:00', to: '20:00' } }
    expect(inWindow(day, wall('2026-11-11 20:00'))).toBe(true)
    expect(inWindow(day, wall('2026-11-11 20:01'))).toBe(false)
    expect(inWindow(day, wall('2026-11-11 00:05'))).toBe(false)
    const night: Period = { every: 1, unit: 'hours', at: '22:00', between: { from: '22:00', to: '02:00' } }
    expect(inWindow(night, wall('2026-11-11 01:00'))).toBe(true)
    expect(inWindow(night, wall('2026-11-11 12:00'))).toBe(false)
    expect(inWindow({ every: 1, unit: 'days', at: '09:00' }, wall('2026-11-11 03:00'))).toBe(true)
  })
})
