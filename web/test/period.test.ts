// period.test.ts — the web side of the period's one table (periodWords
// lives in web and in server, checked by the same table test).
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { nextSlot, periodWords, slotsPerDay } from '../src/lib/period'
import { NEXT, PER_DAY, PERIOD_TZ, WORDS } from '../../server/test/period-table'

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

describe('the period table, on the web', () => {
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
