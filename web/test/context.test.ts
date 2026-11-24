// context.test.ts — windowFor/contextPct: the context % gauge. A single
// window (200k) for all models — windowFor exists so the table can grow
// without touching the call sites (StatusLine/ExternalStatus).
import { describe, expect, it } from 'vitest'
import { contextColorClass, contextPct, knownWindow, pastHalfWindow, windowFor } from '../src/lib/context'

describe('windowFor', () => {
  it('no model → 200_000 (default)', () => {
    expect(windowFor(undefined)).toBe(200_000)
  })

  it('any model known today → still 200_000 (a flat table)', () => {
    expect(windowFor('claude-sonnet-4-5')).toBe(200_000)
    expect(windowFor('claude-opus-4')).toBe(200_000)
  })
})

describe('contextPct', () => {
  it('108656 tokens out of 200k → 54', () => {
    expect(contextPct(108656)).toBe(54)
  })

  it('rounds to the nearest integer (99999/200000 → 50)', () => {
    expect(contextPct(99_999)).toBe(50)
  })

  it('clamps to 100 when tokens exceed the window', () => {
    expect(contextPct(500_000)).toBe(100)
  })

  it('clamps to 0 (defensive) if a negative value arrived', () => {
    expect(contextPct(-10)).toBe(0)
  })

  it('0 tokens → 0%', () => {
    expect(contextPct(0)).toBe(0)
  })
})

describe('contextColorClass', () => {
  it('below 80% → no semantic color class', () => {
    expect(contextColorClass(79)).toBe('')
  })

  it('80% to 94% → amber', () => {
    expect(contextColorClass(80)).toContain('amber')
    expect(contextColorClass(94)).toContain('amber')
  })

  it('95% or more → red', () => {
    expect(contextColorClass(95)).toContain('red')
    expect(contextColorClass(100)).toContain('red')
  })
})

describe('pastHalfWindow — a conversation that outgrew its work', () => {
  it('at or past half of a known window → marked; below → not', () => {
    const w = knownWindow('claude-opus-5-5', true)
    expect(w).toBe(1_000_000)
    expect(pastHalfWindow(500_000, w)).toBe(true)
    expect(pastHalfWindow(499_999, w)).toBe(false)
    expect(pastHalfWindow(120_000, knownWindow('claude-sonnet-4-5', true))).toBe(true)
  })

  it('unknown window (engine reports none, or no model yet) or unknown size → never marked', () => {
    expect(knownWindow('claude-opus-5-5', false)).toBeNull()
    expect(knownWindow(undefined, true)).toBeNull()
    expect(pastHalfWindow(900_000, null)).toBe(false)
    expect(pastHalfWindow(undefined, 200_000)).toBe(false)
  })
})
