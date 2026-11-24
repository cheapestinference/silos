// harness-registry-leaf.test.ts — the leaf registry (harnesses/registry.ts) on
// its own: a FRESH module instance (vi.resetModules) is empty, and every
// lookup on it throws loudly instead of answering a silent default;
// registerHarness refuses a malformed registry; harnessForId routes through
// ownsId with the fallback last.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Harness } from '../src/harnesses/contract.js'

type Registry = typeof import('../src/harnesses/registry.js')
let reg: Registry
beforeEach(async () => {
  vi.resetModules()
  reg = await import('../src/harnesses/registry.js')
})

const fake = (id: string, extra: Partial<Harness>): Harness => ({
  id,
  label: id,
  caps: {
    compaction: false,
    subagents: false,
    skills: false,
    thinking: false,
    costFromHarness: false,
    permissionsAsEvents: false,
    sendToConsole: false,
    outputStyles: false,
  },
  console: { idDiscovery: 'silos-chosen', command: () => [], env: () => ({}) },
  fencePermission: () => ({ read: { [`/${id}`]: 'deny' } }),
  ...extra,
})

describe('harness registry (leaf)', () => {
  it('every lookup throws on an empty registry', () => {
    const msg = /no harness registered — import harnesses\/index\.js first/
    expect(() => reg.registeredHarnesses()).toThrow(msg)
    expect(() => reg.harnessById('claude-code')).toThrow(msg)
    expect(() => reg.findHarness('claude-code')).toThrow(msg)
    expect(() => reg.fallbackHarness()).toThrow(msg)
    expect(() => reg.isHarnessId('claude-code')).toThrow(msg)
    expect(() => reg.harnessOf({})).toThrow(msg)
    expect(() => reg.harnessForId('ses_x')).toThrow(msg)
    expect(() => reg.harnessIds()).toThrow(msg)
    expect(() => reg.fencePermissionFor('claude-code', { permissions: { deny: [], additionalDirectories: [] } }, { worktree: '/p', home: '/h' })).toThrow(msg)
  })

  it('refuses a duplicate id, a second fallback and a non-fallback without ownsId', () => {
    reg.registerHarness(fake('a', { fallback: true }))
    expect(() => reg.registerHarness(fake('a', { ownsId: () => false }))).toThrow(/already registered: a/)
    expect(() => reg.registerHarness(fake('b', { fallback: true }))).toThrow(/second fallback/)
    expect(() => reg.registerHarness(fake('c', {}))).toThrow(/declares no ownsId/)
    expect(reg.harnessIds()).toEqual(['a'])
  })

  it("refuses deletion 'trash' on a non-fallback harness — only the fallback's trash route exists", () => {
    const traits = { deletion: 'trash' as const, handover: false, consolePinsModel: false, agentStateDirs: [] }
    reg.registerHarness(fake('base', { fallback: true, traits }))
    expect(() => reg.registerHarness(fake('t', { ownsId: () => false, traits }))).toThrow(
      /t declares deletion 'trash', which only the fallback harness supports — use 'hide'/,
    )
    expect(reg.registerHarness(fake('h', { ownsId: () => false, traits: { ...traits, deletion: 'hide' } }))).toBeTypeOf('function')
    expect(reg.harnessIds()).toEqual(['base', 'h'])
  })

  it('routes ids through ownsId, the fallback last; unregister restores the registry', () => {
    reg.registerHarness(fake('base', { fallback: true }))
    const off = reg.registerHarness(fake('third', { ownsId: (id) => id.startsWith('thr_') }))
    expect(reg.harnessIds()).toEqual(['base', 'third'])
    expect(reg.harnessForId('thr_1')).toBe('third')
    expect(reg.harnessForId('anything-else')).toBe('base')
    expect(reg.harnessOf({})).toBe('base')
    expect(reg.harnessOf({ framework: 'third' })).toBe('third')
    expect(() => reg.harnessOf({ framework: 'nope' })).toThrow(/unknown harness: nope/)
    expect(() => reg.harnessById('nope')).toThrow(/unknown harness: nope/)
    expect(reg.fencePermissionFor('third', { permissions: { deny: [], additionalDirectories: [] } }, { worktree: '/p', home: '/h' })).toEqual({
      read: { '/third': 'deny' },
    })
    off()
    expect(reg.harnessForId('thr_1')).toBe('base')
    expect(reg.findHarness('third')).toBeUndefined()
    expect(reg.harnesses).not.toHaveProperty('third')
  })

  it('quotedIds joins ids the way the 400 texts read', () => {
    expect(reg.quotedIds(['a'])).toBe("'a'")
    expect(reg.quotedIds(['claude-code', 'opencode'])).toBe("'claude-code' or 'opencode'")
    expect(reg.quotedIds(['a', 'b', 'c'])).toBe("'a', 'b' or 'c'")
  })
})
