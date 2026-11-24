// server/test/harnesses-registry.test.ts
import { describe, it, expect } from 'vitest'
import { harnessOf, isHarnessId, harnessIds } from '../src/harnesses/index.js'
import { fencePermissionFor, fenceSummary, harnessForId } from '../src/harnesses/index.js'
import { NOT_AN_ENGINE, registeredIds } from './helpers/built-ins.js'

describe('harness contract', () => {
  it('defaults an untyped agent to claude-code', () => {
    expect(harnessOf({})).toBe('claude-code')
    expect(harnessOf({ framework: undefined })).toBe('claude-code')
    expect(harnessOf({ framework: 'claude-code' })).toBe('claude-code')
    expect(harnessOf({ framework: 'opencode' })).toBe('opencode')
  })
  it('refuses an unknown framework', () => {
    expect(() => harnessOf({ framework: NOT_AN_ENGINE as never })).toThrow(/unknown harness: not-an-engine/)
    expect(isHarnessId(NOT_AN_ENGINE)).toBe(false)
    // the built-ins first, in order — exactly them while no third engine is registered
    expect(harnessIds()).toEqual(registeredIds())
  })
  it('routes ids by prefix', () => {
    expect(harnessForId('ses_2437ece29ffeCJMww1uZXqvCwI')).toBe('opencode')
    expect(harnessForId('e8d01560-f788-4cd6-9dbc-1dc32e174b91')).toBe('claude-code')
  })
})

describe('fenceSummary — the tool kinds a computed fence permission object really denies', () => {
  it('lists a kind only when one of its entries is a deny (bash only if a bash rule was emitted)', () => {
    expect(fenceSummary({ read: { '/s/**': 'deny' }, edit: { 's/**': 'deny', '/me/**': 'allow' } })).toEqual(['read', 'edit'])
    expect(fenceSummary({ read: { '/me/**': 'allow' }, edit: 'deny', bash: { 'cat /s/*': 'deny' } })).toEqual(['edit', 'bash'])
    expect(fenceSummary({})).toEqual([])
  })
  it('fencePermissionFor maps a fence the way each harness enforces it', () => {
    const fence = { permissions: { deny: ['Read(//s/**)', 'Edit(//s/**)', 'Glob(//s/**)'], additionalDirectories: [] } }
    for (const h of ['claude-code', 'opencode'] as const) {
      expect(fenceSummary(fencePermissionFor(h, fence, { worktree: '/p', home: '/h' }))).toEqual(['read', 'edit'])
    }
    const withBash = { permissions: { deny: ['Read(//s/**)', 'Bash(cat /s/*)'], additionalDirectories: [] } }
    expect(fenceSummary(fencePermissionFor('opencode', withBash, { worktree: '/p', home: '/h' }))).toEqual(['read', 'edit', 'bash']) // edit: OpenCode's own config denies
    expect(fenceSummary(fencePermissionFor('claude-code', withBash, { worktree: '/p', home: '/h' }))).toEqual(['read', 'bash'])
  })
})
