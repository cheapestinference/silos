// The catalog (silos/catalog.ts): what this Silos DISTRIBUTES — the
// standard's reference manifests, offered only while their id is held
// nowhere, and installed through the same submission as everything else.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { availableManifest, availableSilos, REFERENCE_DIR, shippedLineup } from '../src/silos/catalog.js'

let base: string
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'silo-catalog-'))
})
afterEach(() => rmSync(base, { recursive: true, force: true }))

const manifest = (id: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  apiVersion: 'silo-standard/v0',
  metadata: { id, name: id.toUpperCase(), description: `the ${id} silo`, version: '0.1.0', ...extra },
})
function put(file: string, v: unknown): void {
  writeFileSync(join(base, file), typeof v === 'string' ? v : JSON.stringify(v))
}

describe('availableSilos', () => {
  it('lists reference manifests whose id is held nowhere, sorted by file, metadata only', () => {
    mkdirSync(base, { recursive: true })
    put('b.silo.json', manifest('beta'))
    put('a.silo.json', manifest('alfa'))
    put('notes.md', 'not a manifest')
    expect(availableSilos({ dir: base, heldIds: () => new Set() })).toEqual([
      { id: 'alfa', name: 'ALFA', description: 'the alfa silo', version: '0.1.0', producerRole: null },
      { id: 'beta', name: 'BETA', description: 'the beta silo', version: '0.1.0', producerRole: null },
    ])
  })
  it('a held id is not offered — installed, pending, uninstalled or reserved all count', () => {
    put('a.silo.json', manifest('alfa'))
    put('b.silo.json', manifest('beta'))
    expect(availableSilos({ dir: base, heldIds: () => new Set(['alfa']) }).map((x) => x.id)).toEqual(['beta'])
  })
  it('an unreadable or id-less file is skipped, never a crash; duplicate ids offer once', () => {
    put('bad.silo.json', '{nope')
    put('noid.silo.json', { metadata: { name: 'x' } })
    put('a.silo.json', manifest('alfa'))
    put('z.silo.json', manifest('alfa'))
    expect(availableSilos({ dir: base, heldIds: () => new Set() }).map((x) => x.id)).toEqual(['alfa'])
  })
  it('no dir = nothing (a deploy without docs/standard — older images)', () => {
    expect(availableSilos({ dir: join(base, 'missing'), heldIds: () => new Set() })).toEqual([])
  })
  it('the shipped lineup: Plans, Task mode and System are recommended (installed at boot, never offered); Support, Hierarchy, Executions and Heather are optional', () => {
    const ids = availableSilos({ dir: REFERENCE_DIR, heldIds: () => new Set() }).map((x) => x.id)
    expect(ids).toEqual(['executions', 'heather', 'hierarchy', 'support'])
    const lineup = shippedLineup()
    expect(['plans', 'task-mode', 'system'].map(lineup)).toEqual(['recommended', 'recommended', 'recommended'])
    expect(['support', 'hierarchy', 'executions', 'heather'].map(lineup)).toEqual(['optional', 'optional', 'optional', 'optional'])
    // a silo of the owner's own, and an engine dimension, are neither
    expect(lineup('invoices')).toBeNull()
    expect(lineup('skills')).toBeNull()
  })
  it('each offer says who produces it — the first run offers only what needs no agent', () => {
    const role = (id: string) => availableSilos({ dir: REFERENCE_DIR, heldIds: () => new Set() }).find((x) => x.id === id)?.producerRole
    expect(role('hierarchy')).toBeNull()
    expect(role('executions')).toBe('kernel')
    expect(role('support')).toBe('helpdesk')
  })
})

describe('availableManifest', () => {
  it('returns the whole manifest for an offered id; a held or unknown id answers null', () => {
    put('a.silo.json', manifest('alfa'))
    expect(availableManifest({ dir: base, heldIds: () => new Set() }, 'alfa')).toMatchObject({ metadata: { id: 'alfa' } })
    expect(availableManifest({ dir: base, heldIds: () => new Set(['alfa']) }, 'alfa')).toBeNull()
    expect(availableManifest({ dir: base, heldIds: () => new Set() }, 'nope')).toBeNull()
  })
})
