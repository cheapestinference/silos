import { describe, it, expect } from 'vitest'
import { parseCron, nextRun, isValidCron } from '../src/cron.js'

describe('parseCron', () => {
  it('accepts * in every field', () => {
    const f = parseCron('* * * * *')
    expect(f.minute.size).toBe(60)
    expect(f.hour.size).toBe(24)
    expect(f.domRestricted).toBe(false)
    expect(f.dowRestricted).toBe(false)
  })

  it('lists: "0,15,30,45" in the minute field', () => {
    const f = parseCron('0,15,30,45 * * * *')
    expect([...f.minute].sort((a, b) => a - b)).toEqual([0, 15, 30, 45])
  })

  it('ranges: "9-17" in the hour field', () => {
    const f = parseCron('0 9-17 * * *')
    expect([...f.hour].sort((a, b) => a - b)).toEqual([9, 10, 11, 12, 13, 14, 15, 16, 17])
  })

  it('steps: "*/15" in the minute field', () => {
    const f = parseCron('*/15 * * * *')
    expect([...f.minute].sort((a, b) => a - b)).toEqual([0, 15, 30, 45])
  })

  it('step over a range: "10-20/5" in the minute field', () => {
    const f = parseCron('10-20/5 * * * *')
    expect([...f.minute].sort((a, b) => a - b)).toEqual([10, 15, 20])
  })

  it('dow accepts 7 as a synonym for 0 (Sunday)', () => {
    const f = parseCron('0 0 * * 7')
    expect([...f.dow]).toEqual([0])
  })

  it('invalid cron: too many/too few fields, out of range, empty', () => {
    expect(() => parseCron('* * * *')).toThrow('invalid cron')
    expect(() => parseCron('60 * * * *')).toThrow('invalid cron')
    expect(() => parseCron('* * * 13 *')).toThrow('invalid cron')
    expect(() => parseCron('')).toThrow('invalid cron')
    expect(() => parseCron('a b c d e')).toThrow('invalid cron')
  })

  it('isValidCron: true/false without throwing', () => {
    expect(isValidCron('*/5 * * * *')).toBe(true)
    expect(isValidCron('nope')).toBe(false)
  })
})

describe('nextRun — dom/dow semantics (OR when both are restricted)', () => {
  it('with dom AND dow restricted: matches if EITHER one matches', () => {
    // "the 1st of the month OR Mondays" at 09:00
    const after = new Date(2026, 7, 19, 8, 0, 0) // Wednesday 2026-08-19
    const next = nextRun('0 9 1 * 1', after)
    // the next Monday after 2026-08-19 is 2026-08-24
    expect(next).toEqual(new Date(2026, 7, 24, 9, 0, 0))
  })

  it('with only dow restricted: the day of the week governs', () => {
    const after = new Date(2026, 7, 19, 8, 0, 0) // Wednesday
    const next = nextRun('0 9 * * 1', after) // every Monday
    expect(next).toEqual(new Date(2026, 7, 24, 9, 0, 0))
  })

  it('with only dom restricted: the day of the month governs', () => {
    const after = new Date(2026, 7, 19, 8, 0, 0)
    const next = nextRun('0 9 1 * *', after) // the 1st of every month
    expect(next).toEqual(new Date(2026, 8, 1, 9, 0, 0))
  })
})

describe('nextRun — general cases', () => {
  it('every 15 minutes, starting from an exact hour', () => {
    const after = new Date(2026, 7, 19, 10, 0, 0)
    expect(nextRun('*/15 * * * *', after)).toEqual(new Date(2026, 7, 19, 10, 15, 0))
  })

  it('strictly after: if `after` lands exactly on a matching minute, it jumps to the next one', () => {
    const after = new Date(2026, 7, 19, 10, 15, 0)
    expect(nextRun('*/15 * * * *', after)).toEqual(new Date(2026, 7, 19, 10, 30, 0))
  })

  it('daily at 9:00, after 9:00 today it jumps to tomorrow', () => {
    const after = new Date(2026, 7, 19, 9, 30, 0)
    expect(nextRun('0 9 * * *', after)).toEqual(new Date(2026, 7, 20, 9, 0, 0))
  })

  it('month boundary: January only → jumps to next year once it has passed', () => {
    const after = new Date(2026, 7, 19, 0, 0, 0) // August
    expect(nextRun('0 0 1 1 *', after)).toEqual(new Date(2027, 0, 1, 0, 0, 0))
  })

  it('month boundary: the 31st in 30-day months — never matches in those months (jumps to one that does have 31 days)', () => {
    // April 31st doesn't exist: it must jump to May
    const after = new Date(2026, 3, 1, 0, 0, 0) // April 1, 2026
    const next = nextRun('0 0 31 * *', after)
    expect(next.getMonth()).not.toBe(3) // not April
    expect(next.getDate()).toBe(31)
  })

  it('an impossible pattern (February 30th) throws once the search horizon is exhausted', () => {
    const after = new Date(2026, 7, 19, 0, 0, 0)
    expect(() => nextRun('0 0 30 2 *', after)).toThrow()
  })

  it('invalid cron in nextRun also throws "invalid cron"', () => {
    expect(() => nextRun('* * * *', new Date())).toThrow('invalid cron')
  })
})
