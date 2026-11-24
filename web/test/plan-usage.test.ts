import { describe, it, expect } from 'vitest'
import { paceFraction, usageSentence, usageTone } from '../src/lib/plan-usage'
import type { PlanUsageWindow } from '../src/lib/types'

const NOW = Date.parse('2026-10-30T17:00:00Z')
const WEEK = 7 * 86_400_000
const w = (o: Partial<PlanUsageWindow>): PlanUsageWindow => ({
  kind: 'weekly_all',
  label: 'Week',
  percent: 90,
  resetsAt: '2026-11-01T05:00:00Z',
  windowMs: WEEK,
  severity: 'critical',
  active: false,
  ...o,
})

describe('plan usage', () => {
  it('tone: spent is out, the account’s warning/critical is warn, else calm', () => {
    expect(usageTone(w({ percent: 100 }))).toBe('out')
    expect(usageTone(w({ percent: 90 }))).toBe('warn')
    expect(usageTone(w({ percent: 3, severity: 'normal' }))).toBe('calm')
  })

  it('pace = share of the window already gone; null without length or reset', () => {
    // 36 h left of 168 → 132/168 gone
    expect(paceFraction(w({}), NOW)).toBeCloseTo(132 / 168, 5)
    expect(paceFraction(w({ windowMs: null }), NOW)).toBeNull()
    expect(paceFraction(w({ resetsAt: null }), NOW)).toBeNull()
    expect(paceFraction(w({ resetsAt: '2026-10-30T16:00:00Z' }), NOW)).toBe(1)
  })

  it('the sentence names the window, the use, the reset and the pace', () => {
    expect(usageSentence(w({}), NOW)).toMatch(/^Weekly window: 90% used · resets Sun \d\d:\d\d · 79% of the window gone$/)
    expect(usageSentence(w({ label: 'Fable', percent: 100 }), NOW)).toMatch(/^Fable weekly window: 100% used/)
    expect(usageSentence(w({ label: '5h', resetsAt: null, windowMs: null }), NOW)).toBe('5-hour window: 90% used')
  })
})

describe('reset label', () => {
  it('rounds to the minute, 24 h clock, weekday only past a day', async () => {
    const { usageResetLabel } = await import('../src/lib/plan-usage')
    const near = usageResetLabel(w({ resetsAt: '2026-10-30T18:49:59.6Z' }), NOW)
    expect(near).toMatch(/^\d\d:50$/)
    expect(usageResetLabel(w({ resetsAt: '2026-11-01T04:59:59.6Z' }), NOW)).toMatch(/^\S+ \d\d:00$/)
    expect(usageResetLabel(w({ resetsAt: null }), NOW)).toBeNull()
  })
})
