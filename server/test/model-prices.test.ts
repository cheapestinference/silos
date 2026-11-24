import { describe, expect, it } from 'vitest'
import { modelsWithoutPrice, priceUsage, type UsageTokens } from '../src/harnesses/claude-code/model-prices.js'

const zero: UsageTokens = { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 }

describe('priceUsage — haiku-5-5 two rate cards (split at a 100K-token prompt)', () => {
  it('prices a small prompt at the base card', () => {
    // 10K in + 1K out: 10_000·0.1 + 1_000·0.5 per MTok
    const usd = priceUsage('claude-haiku-5-5', { ...zero, input: 10_000, output: 1_000 })
    expect(usd).toBeCloseTo((10_000 * 0.1 + 1_000 * 0.5) / 1e6, 12)
  })

  it('a prompt of exactly 100K tokens is still the base card («100K or fewer»)', () => {
    const usd = priceUsage('claude-haiku-5-5', { ...zero, input: 100_000, output: 1_000 })
    expect(usd).toBeCloseTo((100_000 * 0.1 + 1_000 * 0.5) / 1e6, 12)
  })

  it('a prompt over 100K prices the WHOLE request at the long card', () => {
    // 200K in + 10K out: input 0.5, output 2.5 per MTok
    const usd = priceUsage('claude-haiku-5-5', { ...zero, input: 200_000, output: 10_000 })
    expect(usd).toBeCloseTo((200_000 * 0.5 + 10_000 * 2.5) / 1e6, 12)
  })

  it('cache tokens count toward the prompt length and bill at long-card multiples', () => {
    // 1K fresh input + 150K cache read: prompt = 151K > 100K.
    // Long card: input 0.5 → cacheRead 0.05 (0.1×), write5m 0.625 (1.25×), write1h 1.0 (2×).
    const usd = priceUsage('claude-haiku-5-5', {
      input: 1_000,
      output: 500,
      cacheRead: 150_000,
      cacheWrite5m: 2_000,
      cacheWrite1h: 1_000,
    })
    expect(usd).toBeCloseTo((1_000 * 0.5 + 500 * 2.5 + 150_000 * 0.05 + 2_000 * 0.625 + 1_000 * 1.0) / 1e6, 12)
  })

  it('dated ids resolve to the same cards', () => {
    const a = priceUsage('claude-haiku-5-5-20260301', { ...zero, input: 200_000 })
    const b = priceUsage('claude-haiku-5-5', { ...zero, input: 200_000 })
    expect(a).toBe(b)
  })
})

describe('priceUsage — models without a long-prompt card', () => {
  it('opus-5-5 prices a 300K prompt at its single card', () => {
    const usd = priceUsage('claude-opus-5-5', { ...zero, input: 300_000 })
    expect(usd).toBeCloseTo((300_000 * 4) / 1e6, 12)
  })

  it('an unknown model stays null (unpriced, never invented) and is NAMED, once, among priced ones', () => {
    expect(priceUsage('claude-new-thing', { ...zero, input: 1 })).toBeNull()
    expect(modelsWithoutPrice(['claude-opus-5-5', 'claude-new-thing', 'claude-fable-5-2-20261101', 'claude-new-thing'])).toEqual(['claude-new-thing'])
  })
})
