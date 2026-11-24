// cron-summary.test.ts — a human-readable cron summary + round-tripping
// with AutomationSheet.tsx's readable fields.
import { describe, expect, it } from 'vitest'
import { cronFromEvery, humanCron, defaultEveryFields, everyFromCron } from '../src/lib/cron-summary'

describe('humanCron', () => {
  it('a day of every month, never the raw cron («7 6 5 * *» on the list)', () => {
    expect(humanCron('7 6 5 * *')).toBe('monthly on the 5th, 06:07')
    expect(humanCron('0 9 1 * *')).toBe('monthly on the 1st, 09:00')
    expect(humanCron('0 9 22 * *')).toBe('monthly on the 22nd, 09:00')
    expect(humanCron('0 9 13 * *')).toBe('monthly on the 13th, 09:00')
  })
  it('a list or range of weekdays', () => {
    expect(humanCron('0 9 * * 1,3,5')).toBe('Mon, Wed, Fri 09:00')
    expect(humanCron('30 18 * * 6,0')).toBe('Sat, Sun 18:30')
    expect(humanCron('0 9 * * 1-3')).toBe('Mon–Wed 09:00')
    expect(humanCron('5 3 * * 1-5')).toBe('weekdays 03:05') // the preset still wins
  })
  it('daily', () => {
    expect(humanCron('0 9 * * *')).toBe('daily 09:00')
  })
  it('weekdays', () => {
    expect(humanCron('5 3 * * 1-5')).toBe('weekdays 03:05')
  })
  it('weekly with the right day', () => {
    expect(humanCron('0 9 * * 3')).toBe('weekly Wed 09:00')
  })
  it('falls back to the raw expr only when no shape matches (intervals now translate)', () => {
    expect(humanCron('*/15 * * * *')).toBe('every 15min')
    expect(humanCron('7 3 1-7 * 2')).toBe('7 3 1-7 * 2')
  })
})

describe('everyFromCron / cronFromEvery — round trip', () => {
  it('daily rebuilds the same cron', () => {
    const f = everyFromCron('0 9 * * *')
    expect(f).toEqual({ preset: 'daily', time: '09:00', weekday: 1, custom: '0 9 * * *' })
    expect(cronFromEvery(f)).toBe('0 9 * * *')
  })
  it('weekdays rebuilds the same cron', () => {
    const f = everyFromCron('5 3 * * 1-5')
    expect(f.preset).toBe('weekdays')
    expect(cronFromEvery(f)).toBe('5 3 * * 1-5')
  })
  it('weekly rebuilds the same cron with the right weekday', () => {
    const f = everyFromCron('0 9 * * 3')
    expect(f).toEqual({ preset: 'weekly', time: '09:00', weekday: 3, custom: '0 9 * * 3' })
    expect(cronFromEvery(f)).toBe('0 9 * * 3')
  })
  it('an unrecognized expr falls back to custom without losing the raw expr', () => {
    const f = everyFromCron('*/15 * * * *')
    expect(f.preset).toBe('custom')
    expect(f.custom).toBe('*/15 * * * *')
    expect(cronFromEvery(f)).toBe('*/15 * * * *')
  })
})

describe('defaultEveryFields', () => {
  it('weekdays 09:00, cron 0 9 * * *', () => {
    const f = defaultEveryFields()
    expect(f.preset).toBe('weekdays')
    expect(cronFromEvery(f)).toBe('0 9 * * 1-5')
  })
})

describe('humanCron — interval expressions', () => {
  it('says what */N means instead of leaking the raw cron', async () => {
    const { humanCron } = await import('../src/lib/cron-summary')
    expect(humanCron('0 */4 * * *')).toBe('every 4h')
    expect(humanCron('30 */2 * * *')).toBe('every 2h at :30')
    expect(humanCron('*/15 * * * *')).toBe('every 15min')
    expect(humanCron('7 3 1-7 * 2')).toBe('7 3 1-7 * 2') // unknown shapes still honest-raw
  })
})

// the inventory list showed raw expressions for two real schedules of the
// owner's — an interval over a window of hours and a yearly date. A cron
// is never shown raw when its shape is one people actually write.
describe('humanCron — windowed intervals and yearly dates', () => {
  it('reads an hour-window interval', () => {
    expect(humanCron('58 1-23/2 * * *')).toBe('every 2h at :58, 01–23')
    expect(humanCron('58 0-22/2 * * *')).toBe('every 2h at :58, 00–22')
  })
  it('reads one date a year', () => {
    expect(humanCron('10 9 28 9 *')).toBe('yearly Sep 28 09:10')
  })
  it('still falls back to the raw expression for the exotic', () => {
    expect(humanCron('5 4 1-7 * 1')).toBe('5 4 1-7 * 1')
  })
})
