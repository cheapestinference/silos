// usage.test.ts — the By agent stack and a row's share: the math
// the day bars and the rows draw, never their layout. Generic ids only.
import { describe, it, expect } from 'vitest'
import {
  AGENT_SLOTS,
  SERIES_CLASSES,
  agentDaySegments,
  agentStack,
  attendanceDay,
  automationMoneyWords,
  runsInWindow,
  shareOf,
  shareWords,
  weeksOf,
  type UsageReport,
  type UsageRow,
} from '../src/lib/usage'

const row = (key: string, n: number): UsageRow => ({
  key,
  label: key,
  turns: 1,
  tokens: { in: n, out: 0, cacheRead: 0, cacheWrite: 0 },
  costUsd: null,
  unpriced: 0,
  plan: true,
})
const day = (agents: Record<string, number>, classes: UsageReport['series'][number]['classes'] = {}): UsageReport['series'][number] => ({
  day: '2026-11-11',
  classes,
  agents,
})

describe("a row's share", () => {
  it("is its tokens over the listed rows' sum, said whole", () => {
    const rows = [row('a', 300), row('b', 100), row('unattributed', 0)]
    expect(shareOf(rows[0]!, rows)).toBe(0.75)
    expect(shareOf(rows[2]!, rows)).toBe(0)
    expect(shareOf(row('x', 0), [row('x', 0)])).toBe(0)
    expect([0.75, 0.004, 0, 0.995].map(shareWords)).toEqual(['75%', '<1%', '0%', '100%'])
  })
})

describe('the By agent stack', () => {
  it("colours the heaviest agents in the registry's order, slots without a gap; the rest fold into one", () => {
    const ids = Array.from({ length: AGENT_SLOTS + 2 }, (_, i) => `ag${i}`)
    // ag0 is the lightest: it falls to the rest though it is first in the registry
    const series = [day(Object.fromEntries(ids.map((id, i) => [id, (i + 1) * 10]))), day({ ag1: 1 })]
    const s = agentStack(series, ['zz', ...ids])
    expect(s.colored).toEqual(['ag2', 'ag3', 'ag4', 'ag5', 'ag6', 'ag7'])
    expect(s.rest).toEqual(['ag0', 'ag1'])
  })

  it('a colour follows the agent, not its rank; an agent gone from the registry comes after, by id', () => {
    const heavyFirst = agentStack([day({ b: 900, a: 1, gone: 50 })], ['a', 'b'])
    const lightFirst = agentStack([day({ b: 1, a: 900, gone: 50 })], ['a', 'b'])
    expect(heavyFirst.colored).toEqual(['a', 'b', 'gone'])
    expect(lightFirst.colored).toEqual(heavyFirst.colored)
  })

  it("a day's segments add up to the day the class bars say", () => {
    const classes = { 'with-you': 70, task: 40, unattributed: 9, silos: 3, before: 2 }
    const d = day({ a: 60, b: 30, c: 20 }, classes)
    const s = agentDaySegments(d, { colored: ['a', 'b'], rest: ['c'] })
    expect(s).toEqual([
      { key: 'agent:a', value: 60 },
      { key: 'agent:b', value: 30 },
      { key: 'rest', value: 20 },
      { key: 'unattributed', value: 9 },
      { key: 'silos', value: 3 },
      { key: 'before', value: 2 },
    ])
    expect(s.reduce((n, x) => n + x.value, 0)).toBe(Object.values(classes).reduce((n, x) => n + x, 0))
  })
})

describe("Home's week: with you / on their own", () => {
  it("cuts every class in two and loses none — the day total is the class bars' total", () => {
    const classes = Object.fromEntries(SERIES_CLASSES.map((c, i) => [c, (i + 1) * 11]))
    const a = attendanceDay(day({}, classes))
    expect(a['with-you']).toBe(classes['with-you'])
    expect(a['with-you'] + a['on-their-own']).toBe(Object.values(classes).reduce((n, x) => n + x, 0))
  })
})

describe("an automation's month", () => {
  const days = (n: number, v = 1): Array<{ tokens: number }> => Array.from({ length: n }, () => ({ tokens: v }))
  it('sums whole weeks back from today, never a part-week', () => {
    expect(weeksOf(days(30))).toEqual([7, 7, 7, 7])
    expect(weeksOf([...days(2, 100), ...days(7, 1), ...days(7, 2)])).toEqual([7, 14])
    expect(weeksOf(days(6))).toEqual([])
    expect(weeksOf(days(100))).toHaveLength(12)
  })
  it('says no dollars for what ran wholly on a plan, and says a missing price', () => {
    expect(automationMoneyWords({ cost: 0, plan: true, unpricedTokens: 0 })).toBe('on plan')
    expect(automationMoneyWords({ cost: 0.61, plan: false, unpricedTokens: 0 })).toBe('$0.61')
    expect(automationMoneyWords({ cost: 0.2, plan: true, unpricedTokens: 5 })).toMatch(/^\$0\.20 · on plan · /)
  })
  it("counts the window's finished turns — what the figure should hold", () => {
    const run = (iso: string, status = 'ok', sessionKey?: string) => ({ at: iso, startedAt: iso, status, sessionKey })
    expect(
      runsInWindow(
        [
          run('2026-11-02T10:00:00', 'ok', 'f/s'),
          run('2026-10-30T10:00:00', 'ok', 'f/s'),
          run('2026-11-03T10:00:00', 'running', 'f/s'),
          run('2026-11-04T10:00:00'),
        ],
        '2026-11-01',
      ),
    ).toBe(1)
  })
})
