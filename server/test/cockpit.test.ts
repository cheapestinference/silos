import { describe, it, expect } from 'vitest'
import { resolveCascade, validateOverrides, validateTurnOverrides, EFFORT_LEVELS, PERMISSION_MODES } from '../src/cockpit.js'

describe('resolveCascade — agent default → conversation override → turn override', () => {
  it('nobody opining: model/effort absent (the CLI default, honestly), bypass, fastMode false', () => {
    const r = resolveCascade({}, null, undefined)
    expect(r).toEqual({ permissionMode: 'bypassPermissions', fastMode: false })
    expect(r.model).toBeUndefined()
    expect(r.effort).toBeUndefined()
  })

  it('agent level: agent.model arrives as effective', () => {
    const r = resolveCascade({ model: 'claude-sonnet-5' }, null, null)
    expect(r.model).toBe('claude-sonnet-5')
  })

  it('conversation level overrides the agent', () => {
    const r = resolveCascade({ model: 'claude-sonnet-5' }, { model: 'haiku', effort: 'low', permissionMode: 'plan', fastMode: true }, null)
    expect(r).toEqual({ model: 'haiku', effort: 'low', permissionMode: 'plan', fastMode: true })
  })

  it('turn level overrides conversation and agent', () => {
    const r = resolveCascade(
      { model: 'claude-sonnet-5' },
      { model: 'haiku', effort: 'low', permissionMode: 'plan' },
      { model: 'opus', effort: 'max', permissionMode: 'acceptEdits', fastMode: true },
    )
    expect(r).toEqual({ model: 'opus', effort: 'max', permissionMode: 'acceptEdits', fastMode: true })
  })

  it('field by field, never the whole object: a turn that only opines on effort inherits the rest', () => {
    const r = resolveCascade({ model: 'claude-sonnet-5' }, { permissionMode: 'plan' }, { effort: 'high' })
    expect(r).toEqual({ model: 'claude-sonnet-5', effort: 'high', permissionMode: 'plan', fastMode: false })
  })

  it('an explicit fastMode false from the turn wins over a conversation true', () => {
    const r = resolveCascade({}, { fastMode: true }, { fastMode: false })
    expect(r.fastMode).toBe(false)
  })
})

describe('validateOverrides — unknown values rejected', () => {
  it('accepts the full valid set', () => {
    const v = validateTurnOverrides({ model: 'sonnet', effort: 'xhigh', permissionMode: 'plan', fastMode: true })
    expect(v).toEqual({ model: 'sonnet', effort: 'xhigh', permissionMode: 'plan', fastMode: true })
  })

  it('an empty object is valid (no opinion on anything)', () => {
    expect(validateTurnOverrides({})).toEqual({})
  })

  it('non-object -> error', () => {
    expect(() => validateOverrides('x')).toThrow('overrides must be an object')
    expect(() => validateOverrides([])).toThrow('overrides must be an object')
    expect(() => validateOverrides(null)).toThrow('overrides must be an object')
  })

  it('unknown field -> error', () => {
    expect(() => validateOverrides({ thinking: 'adaptive' })).toThrow('unknown field in overrides: thinking')
  })

  it('effort outside the SDK set -> error', () => {
    expect(() => validateOverrides({ effort: 'ultra' })).toThrow(`overrides.effort must be one of: ${EFFORT_LEVELS.join(', ')}`)
  })

  it('permissionMode default/dontAsk/auto rejected (no permissions UI, closed decision)', () => {
    for (const mode of ['default', 'dontAsk', 'auto']) {
      expect(() => validateOverrides({ permissionMode: mode })).toThrow(`overrides.permissionMode must be one of: ${PERMISSION_MODES.join(', ')}`)
    }
  })

  it('empty or non-string model -> error; too long -> error', () => {
    expect(() => validateOverrides({ model: '' })).toThrow('overrides.model must be a non-empty string')
    expect(() => validateOverrides({ model: 42 })).toThrow('overrides.model must be a non-empty string')
    expect(() => validateOverrides({ model: 'x'.repeat(121) })).toThrow('overrides.model too long')
  })

  it('model gets trimmed; whitespace-only counts as empty', () => {
    expect(validateOverrides({ model: ' sonnet ' })).toEqual({ model: 'sonnet' })
    expect(() => validateOverrides({ model: '   ' })).toThrow('overrides.model must be a non-empty string')
  })

  it('non-boolean fastMode -> error', () => {
    expect(() => validateOverrides({ fastMode: 'yes' })).toThrow('overrides.fastMode must be a boolean')
  })

  it('null only with allowNull (the PATCH deletes, the turn does not)', () => {
    expect(() => validateOverrides({ model: null })).toThrow('overrides.model does not accept null')
    expect(validateOverrides({ model: null, effort: null }, { allowNull: true })).toEqual({ model: null, effort: null })
  })
})

// Providers: the fifth control of the cascade — which account or key a
// conversation (or one turn) runs on. The agent level is agent.provider.
describe('cockpit — provider as a cascade field', () => {
  it('resolveCascade: turn > conversation > agent.provider; absent when nobody opines', () => {
    expect(resolveCascade({}, null, null).provider).toBeUndefined()
    expect(resolveCascade({ provider: 'account:a' }, null, null).provider).toBe('account:a')
    expect(resolveCascade({ provider: 'account:a' }, { provider: 'ci' }, null).provider).toBe('ci')
    expect(resolveCascade({ provider: 'account:a' }, { provider: 'ci' }, { provider: 'default' }).provider).toBe('default')
    // field by field: a turn that only sets effort inherits the conversation's provider
    expect(resolveCascade({}, { provider: 'ci' }, { effort: 'low' }).provider).toBe('ci')
  })

  it('validateOverrides: provider is a trimmed id — never empty, never a path, max 80 chars; null only with allowNull', () => {
    expect(validateOverrides({ provider: ' account:work ' })).toEqual({ provider: 'account:work' })
    expect(validateOverrides({ provider: 'default' })).toEqual({ provider: 'default' })
    expect(() => validateOverrides({ provider: '' })).toThrow('overrides.provider')
    expect(() => validateOverrides({ provider: 'account:../x' })).toThrow('overrides.provider')
    expect(() => validateOverrides({ provider: 'a'.repeat(81) })).toThrow('overrides.provider')
    expect(() => validateOverrides({ provider: 3 })).toThrow('overrides.provider')
    expect(validateOverrides({ provider: null }, { allowNull: true })).toEqual({ provider: null })
    expect(() => validateTurnOverrides({ provider: null })).toThrow('does not accept null')
  })
})
