// The owner's overlay over sync sources (Silo Standard step 1, Task 5): per
// field, sealed base, retires when the source catches up, a third value is a
// conflict (nobody wins in silence), a record gone is an orphan; the merged
// view is what the kernel serves.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OverlayStore, sameValue } from '../src/silos/overlay.js'
import { SiloRegistry } from '../src/silos/registry.js'
import { SiloReader } from '../src/silos/reader.js'
import { SiloKernel } from '../src/silos/kernel.js'
import { TransitionJournal } from '../src/silos/journal.js'
import { siloManifest } from './helpers/silo-manifests.js'

type Json = Record<string, any>
const ref = (id: string): Json => siloManifest(id) as Json

let base: string
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'silo-overlay-'))
})
afterEach(() => rmSync(base, { recursive: true, force: true }))

const T0 = new Date('2026-10-30T09:00:00Z')
const T1 = new Date('2026-10-30T10:00:00Z')

describe('OverlayStore', () => {
  const recs = (m: Record<string, unknown>): Map<string, unknown> => new Map(Object.entries(m))
  const all = { preserved: () => false, complete: true }

  it('an owner write seals the base; writing the base back withdraws it', () => {
    const o = new OverlayStore(base)
    expect(o.set('c', 'agent:finance/a', 'state', 'paid', 'open', T0)).toEqual({
      key: 'agent:finance/a',
      fields: { state: { value: 'paid', base: 'open', at: T0.toISOString(), by: 'owner' } },
    })
    expect(readdirSync(o.dataDir('c'))).toHaveLength(1)
    expect(o.set('c', 'agent:finance/a', 'state', 'open', 'open', T1)).toBeNull()
    expect(readdirSync(o.dataDir('c'))).toHaveLength(0)
  })

  it("pending while the source holds the base; retires by itself when the source brings the owner's value", () => {
    const o = new OverlayStore(base)
    o.set('c', 'k', 'state', 'paid', 'open', T0)
    const r1 = o.reconcile('c', { records: recs({ k: { state: 'open' } }), ...all }, T1)
    expect(r1.values.get('k')).toEqual({ state: 'paid' })
    expect(r1.conflicts).toEqual([])
    const r2 = o.reconcile('c', { records: recs({ k: { state: 'paid' } }), ...all }, T1)
    expect(r2.retired).toEqual([{ key: 'k', field: 'state' }])
    expect(r2.values.size).toBe(0)
    expect(o.list('c')).toEqual([])
  })

  it("a third value is a conflict: kept, marked, listed — the owner's value still shows, flagged", () => {
    const o = new OverlayStore(base)
    o.set('c', 'k', 'state', 'paid', 'open', T0)
    const r = o.reconcile('c', { records: recs({ k: { state: 'refunded' } }), ...all }, T1)
    expect(r.conflicts).toEqual([
      { key: 'k', field: 'state', owner: 'paid', base: 'open', source: 'refunded', seenAt: T1.toISOString(), ownerAt: T0.toISOString() },
    ])
    expect(r.values.get('k')).toEqual({ state: 'paid' })
    expect(o.get('c', 'k')!.fields.state!.conflict).toEqual({ sourceValue: 'refunded', seenAt: T1.toISOString() })
    // seen again: same conflict, same date
    expect(o.reconcile('c', { records: recs({ k: { state: 'refunded' } }), ...all }, new Date('2026-10-31T00:00:00Z')).conflicts[0]!.seenAt).toBe(
      T1.toISOString(),
    )
    // the source goes back to the base: the conflict clears, the owner's value stands
    const back = o.reconcile('c', { records: recs({ k: { state: 'open' } }), ...all }, T1)
    expect(back.conflicts).toEqual([])
    expect(o.get('c', 'k')!.fields.state!.conflict).toBeUndefined()
  })

  it('the owner settles a conflict: keep mine re-seals over the source; take the source drops the field', () => {
    const o = new OverlayStore(base)
    o.set('c', 'k', 'state', 'paid', 'open', T0)
    o.reconcile('c', { records: recs({ k: { state: 'refunded' } }), ...all }, T1)
    o.resolve('c', 'k', 'state', 'keep-mine', 'refunded', T1)
    expect(o.get('c', 'k')!.fields.state).toEqual({ value: 'paid', base: 'refunded', at: T1.toISOString(), by: 'owner' })
    expect(o.reconcile('c', { records: recs({ k: { state: 'refunded' } }), ...all }, T1).conflicts).toEqual([])
    o.resolve('c', 'k', 'state', 'take-source', 'refunded', T1)
    expect(o.get('c', 'k')).toBeNull()
  })

  it('per field: one field retires while another stands', () => {
    const o = new OverlayStore(base)
    o.set('c', 'k', 'state', 'paid', 'open', T0)
    o.set('c', 'k', 'note', 'called', undefined, T0)
    const r = o.reconcile('c', { records: recs({ k: { state: 'paid' } }), ...all }, T1)
    expect(r.retired).toEqual([{ key: 'k', field: 'state' }])
    expect(r.values.get('k')).toEqual({ note: 'called' })
  })

  it('a record gone is an orphan — unless it is there but unreadable, or the reading was truncated; it clears when the record returns', () => {
    const o = new OverlayStore(base)
    o.set('c', 'k', 'state', 'paid', 'open', T0)
    expect(o.reconcile('c', { records: recs({}), preserved: (k) => k === 'k', complete: true }, T1).orphans).toEqual([])
    expect(o.reconcile('c', { records: recs({}), preserved: () => false, complete: false }, T1).orphans).toEqual([])
    expect(o.reconcile('c', { records: recs({}), ...all }, T1).orphans).toEqual([{ key: 'k', fields: ['state'], since: T1.toISOString() }])
    expect(o.get('c', 'k')!.orphanSince).toBe(T1.toISOString())
    o.reconcile('c', { records: recs({ k: { state: 'open' } }), ...all }, T1)
    expect(o.get('c', 'k')!.orphanSince).toBeUndefined()
  })

  it('sameValue compares JSON (money objects in any key order)', () => {
    expect(sameValue({ amount: 1, currency: 'EUR' }, { currency: 'EUR', amount: 1 })).toBe(true)
    expect(sameValue(undefined, null)).toBe(false)
  })
})

describe('the kernel serves base + overlay merged', () => {
  const NOW = Date.parse('2026-10-30T12:00:00Z')
  const invoice = (over: Json = {}): Json => ({ ...ref('invoices').spec.kinds.invoice.examples[0], ...over })
  const file = (): string => join(base, 'as', 'finance', 'silos', 'invoices', 'inv-70a1.json')
  const put = (v: Json): void => {
    mkdirSync(join(file(), '..'), { recursive: true })
    writeFileSync(file(), JSON.stringify(v))
    utimesSync(file(), new Date(), new Date())
  }
  function setup(decision: 'approved' | null = 'approved', manifest = ref('invoices')) {
    const dataDir = join(base, 'data')
    mkdirSync(join(dataDir, 'silos', 'registry', manifest.metadata.id), { recursive: true })
    writeFileSync(join(dataDir, 'silos', 'registry', manifest.metadata.id, 'silo.json'), JSON.stringify(manifest))
    const registry = new SiloRegistry({ dataDir, operator: { decisionFor: () => decision, slotsOff: () => [] } })
    registry.load()
    const kernel = new SiloKernel({
      registry,
      reader: new SiloReader({ agentStates: () => [{ agentId: 'finance', dir: join(base, 'as', 'finance') }], projects: () => [] }),
      journal: new TransitionJournal(registry.conventionsDir),
      overlay: new OverlayStore(registry.conventionsDir),
      now: () => NOW,
    })
    kernel.refresh()
    return { dataDir, registry, kernel }
  }
  const KEY = 'agent:finance/inv-70a1'

  it('setOwnerField writes the overlay, never the file; the reading, the merged view and the journal see «paid»', () => {
    put(invoice())
    const { kernel, registry } = setup()
    const before = readFileSync(file(), 'utf8')
    const r = kernel.setOwnerField('invoices', KEY, 'state', 'paid')
    if (!r.ok) throw new Error(r.reason)
    expect(r.record.record.state).toBe('paid')
    expect(r.record.record.stateLabel).toEqual({ one: 'paid', many: 'paid' })
    expect(r.record.overlay).toEqual({ state: { value: 'paid', base: 'open', at: new Date(NOW).toISOString(), by: 'owner' } })
    expect(readFileSync(file(), 'utf8')).toBe(before)
    const view = kernel.mergedView('invoices')
    expect(view[0]).toMatchObject({ key: KEY, raw: { state: 'paid', contactName: 'Acme SL' } })
    const journal = readFileSync(join(registry.conventionsDir, encodeURIComponent('agent-state:silos/invoices'), 'journal.jsonl'), 'utf8')
    expect(journal).toContain('"event":"transition","key":"agent:finance/inv-70a1","kind":"invoice","from":"open","to":"paid"')
  })

  it('refuses what the owner may not write and values the manifest refuses (the active-only gate lives in the actions layer)', () => {
    put(invoice())
    const { kernel } = setup()
    expect(kernel.setOwnerField('invoices', KEY, 'total', { amount: 1, currency: 'EUR' })).toEqual({
      ok: false,
      reason: 'total is not one of the fields the owner may write (state)',
    })
    expect(kernel.setOwnerField('invoices', KEY, 'state', 'bogus')).toEqual({
      ok: false,
      reason: 'state "bogus" is not one of draft/open/partial/paid/refunded',
    })
    expect(kernel.setOwnerField('invoices', 'agent:finance/nope', 'state', 'paid')).toEqual({ ok: false, reason: 'no record "agent:finance/nope" in invoices' })
  })

  it('a curated (agent-produced) source has no overlay', () => {
    const m = ref('documents')
    m.spec.kinds.document.ownerWritable = ['state']
    const { kernel } = setup('approved', m)
    expect(kernel.setOwnerField('documents', 'x', 'state', 'filed')).toEqual({ ok: false, reason: 'documents has no owner-writable fields over a sync source' })
  })

  it('the sync catches up → retired; the sync brings a third value → a conflict with its file; the file goes → an orphan', () => {
    put(invoice())
    const { kernel, registry } = setup()
    kernel.setOwnerField('invoices', KEY, 'state', 'paid')
    put(invoice({ state: 'refunded' }))
    kernel.refresh()
    expect(kernel.overlayState('invoices').conflicts).toEqual([
      expect.objectContaining({ key: KEY, field: 'state', owner: 'paid', base: 'open', source: 'refunded', file: file() }),
    ])
    expect(kernel.reading('invoices')!.records[0]!.record.state).toBe('paid')
    put(invoice({ state: 'paid' }))
    kernel.refresh()
    expect(kernel.overlayState('invoices')).toEqual({ conflicts: [], orphans: [] })
    expect(kernel.reading('invoices')!.records[0]!.overlay).toBeUndefined()
    kernel.setOwnerField('invoices', KEY, 'state', 'partial')
    rmSync(file())
    kernel.refresh()
    expect(kernel.overlayState('invoices').orphans).toEqual([{ key: KEY, fields: ['state'], since: new Date(NOW).toISOString() }])
    // uninstall: the overlay stays with the convention
    rmSync(join(registry.registryDir, 'invoices'), { recursive: true })
    registry.load()
    kernel.refresh()
    expect(existsSync(join(registry.conventionsDir, encodeURIComponent('agent-state:silos/invoices'), 'data'))).toBe(true)
  })

  it('a conflict is settled by the owner only', () => {
    put(invoice())
    const { kernel } = setup()
    kernel.setOwnerField('invoices', KEY, 'state', 'paid')
    put(invoice({ state: 'partial' }))
    kernel.refresh()
    const r = kernel.resolveConflict('invoices', KEY, 'state', 'take-source')
    expect(r.ok && r.record.record.state).toBe('partial')
    expect(kernel.overlayState('invoices').conflicts).toEqual([])
  })
})
