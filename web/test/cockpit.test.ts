// cockpit.test.ts — pure logic for the cockpit's selectors (lib/cockpit.ts):
// the server-mirrored cascade, honest matching against the catalog, and
// the requested-vs-received echo.
import { describe, it, expect } from 'vitest'
import { applyPatch, mismatchedEchoes, permissionLabel, modelInfo, seenModels, modelName, fieldOrigin, resolveEffective } from '../src/lib/cockpit'
import type { ModelInfo } from '../src/lib/types'

const CATALOG: ModelInfo[] = [
  {
    value: 'default',
    resolvedModel: 'claude-opus-5[1m]',
    displayName: 'Default (recommended)',
    supportsEffort: true,
    supportedEffortLevels: ['low', 'high', 'max'],
    supportsFastMode: true,
  },
  {
    value: 'sonnet',
    resolvedModel: 'claude-sonnet-5',
    displayName: 'Sonnet',
    supportsEffort: true,
    supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
  },
  { value: 'haiku', resolvedModel: 'claude-haiku-4-5-20251001', displayName: 'Haiku' },
]

describe('resolveEffective — the server-mirrored cascade', () => {
  it('with nobody opining: bypass + fastMode false, model/effort absent', () => {
    expect(resolveEffective(undefined, {}, {})).toEqual({ permissionMode: 'bypassPermissions', fastMode: false })
  })

  it('agent → conversation → turn, field by field', () => {
    expect(resolveEffective('sonnet', {}, {}).model).toBe('sonnet')
    expect(resolveEffective('sonnet', { model: 'haiku' }, {}).model).toBe('haiku')
    expect(resolveEffective('sonnet', { model: 'haiku' }, { model: 'default' }).model).toBe('default')
    // a turn that only opines on effort inherits the rest
    const r = resolveEffective('sonnet', { permissionMode: 'plan' }, { effort: 'max' })
    expect(r).toEqual({ model: 'sonnet', effort: 'max', permissionMode: 'plan', fastMode: false })
  })
})

describe("fieldOrigin — which level the chip's truth comes from", () => {
  it('turn > conversation > agent', () => {
    expect(fieldOrigin('model', {}, {})).toBe('agent')
    expect(fieldOrigin('model', { model: 'x' }, {})).toBe('conversation')
    expect(fieldOrigin('model', { model: 'x' }, { model: 'y' })).toBe('turn')
  })
})

describe('modelInfo / modelName — honest matching against the catalog', () => {
  it('matches by value, by resolvedModel, and undefined falls back to the CLI default row', () => {
    expect(modelInfo(CATALOG, 'sonnet')?.displayName).toBe('Sonnet')
    expect(modelInfo(CATALOG, 'claude-sonnet-5')?.displayName).toBe('Sonnet')
    expect(modelInfo(CATALOG, undefined)?.value).toBe('default')
    expect(modelInfo(CATALOG, 'gpt-9')).toBeNull()
    expect(modelInfo([], undefined)).toBeNull()
  })

  it('modelName: displayName if known, the raw id if not (honest), Default if nobody opines', () => {
    expect(modelName(CATALOG, 'claude-sonnet-5')).toBe('Sonnet')
    expect(modelName(CATALOG, 'a-custom-model')).toBe('a-custom-model')
    expect(modelName([], undefined)).toBe('Default')
  })
})

describe("mismatchedEchoes — requested vs. the SDK's init", () => {
  it('a requested alias that init echoes back as its canonical id is NOT a mismatch', () => {
    expect(
      mismatchedEchoes({ model: 'sonnet', permissionMode: 'bypassPermissions' }, { model: 'claude-sonnet-5', permissionMode: 'bypassPermissions' }, CATALOG),
    ).toEqual([])
  })

  it('the [1m] suffix is compared bare', () => {
    expect(mismatchedEchoes({ model: 'claude-opus-5[1m]', permissionMode: 'bypassPermissions' }, { model: 'claude-opus-5' }, CATALOG)).toEqual([])
  })

  it('a genuinely different model → warns with the real model', () => {
    const w = mismatchedEchoes({ model: 'sonnet', permissionMode: 'bypassPermissions' }, { model: 'claude-haiku-4-5-20251001' }, CATALOG)
    expect(w).toHaveLength(1)
    expect(w[0]).toContain('claude-haiku-4-5-20251001')
  })

  it('a requested model of undefined (the CLI default) never claims a mismatch', () => {
    expect(mismatchedEchoes({ permissionMode: 'bypassPermissions' }, { model: 'whatever', permissionMode: 'bypassPermissions' }, CATALOG)).toEqual([])
  })

  it("a different permissionMode → warns in the cockpit's voice", () => {
    const toBypass = mismatchedEchoes({ permissionMode: 'plan' }, { permissionMode: 'bypassPermissions' }, CATALOG)
    expect(toBypass).toHaveLength(1)
    expect(toBypass[0]).toContain('bypass')
    const toPlan = mismatchedEchoes({ permissionMode: 'bypassPermissions' }, { permissionMode: 'plan' }, CATALOG)
    expect(toPlan).toHaveLength(1)
    expect(toPlan[0]).toContain('plan')
  })
})

describe('utilities', () => {
  it('permissionLabel — lowercase mono voice', () => {
    expect(permissionLabel('bypassPermissions')).toBe('bypass')
    expect(permissionLabel('plan')).toBe('plan mode')
    expect(permissionLabel('acceptEdits')).toBe('accept edits')
  })

  it("seenModels — only what's verifiable (agents + session), no duplicates or blanks", () => {
    expect(seenModels(['sonnet', undefined, 'sonnet'], 'claude-haiku-4-5-20251001')).toEqual(['sonnet', 'claude-haiku-4-5-20251001'])
    expect(seenModels([], null)).toEqual([])
  })

  it('applyPatch — null removes the field, present overwrites, absent is kept', () => {
    expect(applyPatch({ model: 'x', effort: 'low' }, { model: null, fastMode: true })).toEqual({ effort: 'low', fastMode: true })
  })
})
