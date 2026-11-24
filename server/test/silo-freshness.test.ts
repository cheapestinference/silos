// Freshness (Silo Standard step 1, Task 6): past a source's cadence, every
// slot says it in one term made of what the disk says; never-written says so.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cadenceMs, formatAgo, formatMoment, freshnessOf, pluralOf } from '../src/silos/freshness.js'
import type { SiloReading } from '../src/silos/reader.js'
import { SiloRegistry } from '../src/silos/registry.js'
import { SiloReader } from '../src/silos/reader.js'
import { SiloKernel } from '../src/silos/kernel.js'
import { OverlayStore } from '../src/silos/overlay.js'
import { siloManifest } from './helpers/silo-manifests.js'

type Json = Record<string, any>
const ref = (id: string): Json => siloManifest(id) as Json
const reading = (sources: SiloReading['sources']): SiloReading => ({ records: [], unreadable: [], lastWrite: null, sources, truncated: [], problems: [] })
const NOW = Date.parse('2026-10-30T12:00:00Z')

describe('freshnessOf', () => {
  const f = ref('invoices')
  it('fresh within the cadence: no term', () => {
    expect(freshnessOf(f, reading({ invoices: { lastWrite: '2026-10-30T08:00:00Z', newestAt: '2026-10-29' } }), [], NOW)).toEqual({
      stale: false,
      term: null,
      orphans: 0,
      sources: [{ source: 'invoices', cadence: '24h', producer: 'sync', lastWrite: '2026-10-30T08:00:00Z', newestAt: '2026-10-29', stale: false }],
    })
  })
  it("past the cadence: the newest record's moment and the last write, from the data", () => {
    const r = freshnessOf(f, reading({ invoices: { lastWrite: '2026-10-29T08:00:00Z', newestAt: '2026-10-28' } }), [], NOW)
    expect(r.stale).toBe(true)
    expect(r.term).toBe('no new invoices since Oct 28 · the Invoicing sync last wrote Oct 29, 08:00 UTC')
  })
  it('never written', () => {
    expect(freshnessOf(f, reading({}), [], NOW).term).toBe('never synced yet')
    const agentSrc = ref('support')
    agentSrc.spec.sources[0].expects.cadence = '7d'
    expect(freshnessOf(agentSrc, reading({}), [], NOW).term).toBe('nothing written yet')
    const later = freshnessOf(agentSrc, reading({ cases: { lastWrite: '2026-10-01T00:00:00Z', newestAt: '2026-10-01T00:00:00Z' } }), [], NOW)
    expect(later.term).toBe('no new cases since Oct 1, 00:00 UTC · helpdesk last wrote Oct 1, 00:00 UTC')
  })
  it('sources without a cadence are not judged', () => {
    expect(freshnessOf(ref('plans'), reading({}), [], NOW)).toEqual({ stale: false, term: null, sources: [], orphans: 0 })
  })
  it('several stale sources collapse into one term, the stalest speaking; overlay orphans join it', () => {
    const m = ref('invoices')
    m.spec.sources.push({ ...m.spec.sources[0], id: 'purchases', glob: 'silos/invoices-purchases/*.json' })
    const r = freshnessOf(
      m,
      reading({ invoices: { lastWrite: '2026-10-28T00:00:00Z', newestAt: null }, purchases: { lastWrite: '2026-10-25T00:00:00Z', newestAt: '2026-10-24' } }),
      [{ key: 'k', fields: ['state'], since: 'x' }],
      NOW,
    )
    expect(r.term).toBe(
      'no new invoices since Oct 24 · the Invoicing sync last wrote Oct 25, 00:00 UTC (and 1 more source) · 1 owner change waits on a record the sync no longer writes',
    )
  })
  it('helpers', () => {
    expect([formatAgo(16 * 60_000), formatAgo(59 * 60_000), formatAgo(60 * 60_000), formatAgo(47 * 3600_000), formatAgo(49 * 3600_000), formatAgo(-5)]).toEqual(
      ['16 min ago', '59 min ago', '1 h ago', '47 h ago', '2 d ago', '0 min ago'],
    )
    expect(cadenceMs('24h')).toBe(86_400_000)
    expect(cadenceMs('x')).toBeNull()
    expect([pluralOf('case'), pluralOf('invoice'), pluralOf('box'), pluralOf('policy'), pluralOf('day')]).toEqual([
      'cases',
      'invoices',
      'boxes',
      'policies',
      'days',
    ])
    expect(formatMoment('2026-10-02')).toBe('Oct 2')
  })
})

describe('freshness lands in status and in GET /api/silos descriptors', () => {
  let base: string
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'silo-fresh-'))
  })
  afterEach(() => rmSync(base, { recursive: true, force: true }))
  it('stale after the cadence, by the timer alone', () => {
    const dataDir = join(base, 'data')
    mkdirSync(join(dataDir, 'silos', 'registry', 'invoices'), { recursive: true })
    writeFileSync(join(dataDir, 'silos', 'registry', 'invoices', 'silo.json'), JSON.stringify(ref('invoices')))
    const file = join(base, 'as', 'finance', 'silos', 'invoices', 'inv-70a1.json')
    mkdirSync(join(file, '..'), { recursive: true })
    writeFileSync(file, JSON.stringify(ref('invoices').spec.kinds.invoice.examples[0]))
    const written = new Date('2026-10-30T08:00:00Z')
    utimesSync(file, written, written)
    const registry = new SiloRegistry({ dataDir })
    registry.load()
    let now = Date.parse('2026-10-30T09:00:00Z')
    const kernel = new SiloKernel({
      registry,
      reader: new SiloReader({ agentStates: () => [{ agentId: 'finance', dir: join(base, 'as', 'finance') }], projects: () => [] }),
      overlay: new OverlayStore(registry.conventionsDir),
      now: () => now,
    })
    kernel.refresh()
    expect(registry.describe()[0]!.freshness).toMatchObject({ stale: false, term: null })
    now = Date.parse('2026-10-31T09:00:00Z')
    kernel.refresh()
    expect(registry.describe()[0]!.freshness!.term).toBe('no new invoices since Oct 2 · the Invoicing sync last wrote Oct 30, 08:00 UTC')
    expect(JSON.parse(readFileSync(join(dataDir, 'silos', 'registry', 'invoices', 'status.json'), 'utf8')).freshness.stale).toBe(true)
  })
})
