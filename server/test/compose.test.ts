// compose.test.ts — the boot seam (compose.ts bootHarnesses) over two fake
// harnesses, on a FRESH, empty registry (vi.resetModules: the setup file's
// Claude Code and OpenCode are not in this module graph): a fallback that
// boots no reader is refused, a contest is asked only of the harness that
// owns the id, agentOfDb takes the first non-null answer, and one
// harness's onIndexReady throwing never stops the next.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Harness, HarnessBootContext, HarnessRuntime } from '../src/harnesses/contract.js'
import { FakeReader, makeFakeHarness } from './fixtures/fake-harness.js'

type Registry = typeof import('../src/harnesses/registry.js')
type Compose = typeof import('../src/compose.js')

let registry: Registry
let compose: Compose
const unregister: (() => void)[] = []

beforeEach(async () => {
  vi.resetModules()
  registry = await import('../src/harnesses/registry.js')
  compose = await import('../src/compose.js')
})
afterEach(() => {
  for (const u of unregister.splice(0)) u()
  vi.restoreAllMocks()
})

const ctx = { dataDir: '/d', home: '/h', root: '/r', port: 1, muted: [], ephemeral: null, modelCatalog: false, log: () => {} } as unknown as HarnessBootContext

// a fallback (owns every id no other claims) and a second engine owning `oth_…`
function fallback(rt: (reader: FakeReader) => HarnessRuntime): Harness {
  return { ...makeFakeHarness({ id: 'fb', label: 'Fb', prefix: 'fb_' }), fallback: true, boot: () => rt(new FakeReader('fb', 'fb_')) }
}
function other(rt: (reader: FakeReader) => HarnessRuntime): Harness {
  return { ...makeFakeHarness({ id: 'oth', label: 'Oth', prefix: 'oth_' }), boot: () => rt(new FakeReader('oth', 'oth_')) }
}
function register(...hs: Harness[]): void {
  for (const h of hs) unregister.push(registry.registerHarness(h))
}

describe('bootHarnesses', () => {
  it('starts from an empty registry (the fresh module graph)', () => {
    expect(() => registry.registeredHarnesses()).toThrow('no harness registered — import harnesses/index.js first')
  })

  it('refuses a fallback that booted no reader', () => {
    register(
      { ...fallback(() => ({})), boot: () => ({}) },
      other((reader) => ({ reader })),
    )
    expect(() => compose.bootHarnesses(ctx)).toThrow('fallback harness fb booted no reader')
  })

  it("asks isContested only of the harness that owns the id: a non-owner's contest never voids another engine's id", () => {
    register(
      // the fallback contests EVERY id it is asked about
      fallback((reader) => ({ reader, ownership: { agentOfDb: () => null, isContested: () => true } })),
      other((reader) => ({ reader, ownership: { agentOfDb: () => null, isContested: (id) => id === 'oth_disputed' } })),
    )
    const booted = compose.bootHarnesses(ctx)
    expect(booted.ownership.isContested('oth_disputed')).toBe(true)
    expect(booted.ownership.isContested('oth_clear')).toBe(false) // fb's blanket contest is not asked
    expect(booted.ownership.isContested('plain-id')).toBe(true) // the fallback's own id: its answer
  })

  it('an owner-routed id whose harness has no ownership is uncontested', () => {
    register(
      fallback((reader) => ({ reader, ownership: { agentOfDb: () => null, isContested: () => true } })),
      other((reader) => ({ reader })),
    )
    expect(compose.bootHarnesses(ctx).ownership.isContested('oth_x')).toBe(false)
  })

  it('agentOfDb is the first non-null answer, in registration order', () => {
    register(
      fallback((reader) => ({ reader, ownership: { agentOfDb: (id) => (id === 'both' ? 'from-fb' : null), isContested: () => false } })),
      other((reader) => ({ reader, ownership: { agentOfDb: (id) => (id === 'both' || id === 'only-oth' ? 'from-oth' : null), isContested: () => false } })),
    )
    const { ownership } = compose.bootHarnesses(ctx)
    expect(ownership.agentOfDb('both')).toBe('from-fb')
    expect(ownership.agentOfDb('only-oth')).toBe('from-oth')
    expect(ownership.agentOfDb('nobody')).toBeNull()
  })

  it("indexReady: one harness's onIndexReady throwing is logged and the next still runs", () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const next = vi.fn()
    register(
      fallback((reader) => ({
        reader,
        onIndexReady: () => {
          throw new Error('boom')
        },
      })),
      other((reader) => ({ reader, onIndexReady: next })),
    )
    const booted = compose.bootHarnesses(ctx)
    expect(() => booted.indexReady()).not.toThrow()
    expect(next).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith('fb: onIndexReady failed —', 'boom')
  })

  it("joins every non-fallback reader to the fallback's index", () => {
    register(
      fallback((reader) => ({ reader })),
      other(() => ({
        reader: new FakeReader('oth', 'oth_', [
          { id: 'oth_1', folder: '-p', title: 't', skills: [], cwd: '/p', mtime: 1, size: 0, turnCount: 1, harness: 'oth' },
        ]),
      })),
    )
    const { index } = compose.bootHarnesses(ctx)
    expect(index.allSessions().map((m) => m.id)).toEqual(['oth_1'])
  })
})
