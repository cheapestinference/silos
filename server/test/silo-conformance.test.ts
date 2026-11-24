// silo-conformance.test.ts — the Silo Standard v0 conformance suite
// (docs/standard/conformance.md «The conformance suite»), published with the
// standard. It runs against a kernel with the FOUR reference manifests
// INSTALLED through the real gesture (submission → the owner's approval) and
// their own `examples` as fixtures, written where each source reads:
//
//   envelope · tolerance (lift, aliases) · terminal derivations · journal ·
//   overlay · writing (CAS, writeMerge, move-item) · data honesty · uninstall
//   · installation
//
// (kernel sources are covered in silo-kernel-source.test.ts);
// plus the reference numbers on real disk (support 74 valid + 2 explained),
// read IN PLACE when that disk is present — skipped with a notice otherwise.
// The pattern is harness-conformance's: one kernel, the same assertions over
// every reference silo where they apply.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { SiloRegistry } from '../src/silos/registry.js'
import { SiloReader, exampleFileId } from '../src/silos/reader.js'
import { SiloKernel } from '../src/silos/kernel.js'
import { TransitionJournal, isCompletion } from '../src/silos/journal.js'
import { OverlayStore } from '../src/silos/overlay.js'
import { SiloOperatorStore } from '../src/silos/operator.js'
import { dimensions } from '../src/silos/native.js'
import { SiloInstaller } from '../src/silos/installer.js'
import { SiloActions, SiloAcks, SiloEvents, SiloProposals } from '../src/silos/actions.js'
import { SiloSurfaces } from '../src/silos/surfaces.js'
import { recordsPage } from '../src/silos/views.js'
import { evaluate, parse } from '../src/silos/expressions.js'
import type { SiloLocations } from '../src/silos/files-source.js'
import { siloManifest } from './helpers/silo-manifests.js'

type Json = Record<string, any>
const ref = (id: string): Json => siloManifest(id) as Json
const REFS = ['support', 'plans', 'invoices', 'documents'] as const
const AGENTS = ['finance', 'support', 'writer']
const isAgent = (v: string): boolean => AGENTS.includes(v)
const PRODUCERS: Record<string, string[]> = { support: ['support'], plans: [], invoices: ['finance'], documents: ['finance'] }

let base: string
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'silo-conformance-'))
})
afterEach(() => rmSync(base, { recursive: true, force: true }))

// where each reference silo's example i lives on disk
function fileOf(silo: string, id: string): string {
  switch (silo) {
    case 'support':
      return join(base, 'agent-state', 'support', 'support', 'cases', `${id}.json`)
    case 'invoices':
      return join(base, 'agent-state', 'finance', 'silos', 'invoices', `${id}.json`)
    case 'plans':
      return join(base, 'proj', 'plans', `${id}.plan.json`)
    default:
      return join(base, 'proj', 'context', 'documents', `${id}.json`)
  }
}
function write(file: string, v: unknown, mtime?: Date): void {
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, JSON.stringify(v, null, 2))
  const t = mtime ?? new Date()
  utimesSync(file, t, t)
}
function seedExamples(silo: string): string[] {
  const m = ref(silo)
  const [kind, spec] = Object.entries<Json>(m.spec.kinds)[0]!
  return spec.examples.map((ex: Json) => {
    const id = exampleFileId(m, kind, ex)!
    const { _file: _f, ...value } = ex
    write(fileOf(silo, id), value, new Date('2026-10-01T00:00:00Z'))
    return id
  })
}
const keyOf = (silo: string, id: string): string =>
  silo === 'support' ? `agent:support/${id}` : silo === 'invoices' ? `agent:finance/${id}` : `folder:${join(base, 'proj')}/${id}`

// a kernel with every reference silo installed by the owner's gesture
function kernel(opts: { now?: () => number; seed?: boolean } = {}) {
  const dataDir = join(base, 'data')
  const root = join(dataDir, 'silos')
  if (opts.seed !== false) for (const s of REFS) seedExamples(s)
  const operator = new SiloOperatorStore(root)
  const registry = new SiloRegistry({ dataDir, operator })
  registry.load()
  const locations: SiloLocations = {
    agentStates: () => AGENTS.map((a) => ({ agentId: a, dir: join(base, 'agent-state', a) })),
    projects: () => [join(base, 'proj')],
  }
  const journal = new TransitionJournal(registry.conventionsDir)
  const overlay = new OverlayStore(registry.conventionsDir)
  const now = opts.now ?? (() => Date.now())
  const k = new SiloKernel({ registry, reader: new SiloReader(locations), journal, overlay, isAgent, now })
  const events = new SiloEvents(root)
  const actions = new SiloActions({
    registry,
    kernel: k,
    events,
    acks: new SiloAcks(root),
    proposals: new SiloProposals(root),
    agentStateBase: join(base, 'agent-state'),
    isAgent,
    agentMayReadLocation: (a, l) => l === `agent:${a}`,
    producersOf: (id) => operator.producersOf(id),
  })
  const installer = new SiloInstaller({
    root,
    registry,
    operator,
    kernel: k,
    events,
    locations,
    agentStateBase: join(base, 'agent-state'),
    isAgent,
    hasBearer: () => true,
    territoriesOf: () => [],
    now,
    // the suite tests the reference manifests AS silos — whether this Silos still
    // serves support/plans natively (silos/native.ts) is not the standard's concern
    dimensions: dimensions([]),
  })
  const surfaces = new SiloSurfaces({
    registry,
    kernel: k,
    journal,
    isAgent,
    producersOf: (id) => operator.producersOf(id),
    uninstalledGrowth: () => installer.growth(),
  })
  for (const s of REFS) {
    const sub = installer.submit({ manifest: ref(s) }, 'owner')
    if (sub.code !== 201) throw new Error(`${s}: ${JSON.stringify(sub.body)}`)
    const ok = installer.approve(s, { producers: PRODUCERS[s] })
    if (ok.code !== 200) throw new Error(`${s}: ${JSON.stringify(ok.body)}`)
  }
  k.refresh()
  return { dataDir, root, registry, operator, kernel: k, journal, overlay, events, actions, installer, surfaces }
}

describe.each(REFS.map((s) => [s] as const))('envelope — %s', (silo) => {
  it('every example produces a valid envelope, anchored by its location', () => {
    const { kernel: k } = kernel()
    const r = k.reading(silo)!
    expect(r.unreadable).toEqual([])
    expect(r.records).toHaveLength(ref(silo).spec.kinds[Object.keys(ref(silo).spec.kinds)[0]!].examples.length)
    for (const rec of r.records) {
      expect(typeof rec.record.id).toBe('string')
      // a case with an empty summary stays blank (no fallback to intent)
      if (silo === 'support') expect(rec.record.identity).toBe(rec.record.summary)
      else expect(rec.record.identity).not.toBe('')
      expect(typeof rec.record.state).toBe('string')
      expect(rec.record.stateLabel).toBeTruthy()
      expect(rec.anchors).toEqual(
        silo === 'support' || silo === 'invoices' ? { agent: silo === 'support' ? 'support' : 'finance' } : { folder: join(base, 'proj') },
      )
    }
  })
})

describe('envelope — a fixture broken on purpose gives the EXACT error with its field', () => {
  it.each<[string, (ex: Json) => Json, string]>([
    [
      'support',
      (ex) => {
        const { customerEmail: _c, ...r } = ex
        return r
      },
      'missing customerEmail',
    ],
    ['support', (ex) => ({ ...ex, status: 'pending' }), 'status "pending" is not one of new/needs_owner/draft_ready/waiting_customer/closed'],
    ['invoices', (ex) => ({ ...ex, total: '71,00' }), 'total must be money as {amount, currency} (found "71,00")'],
    [
      'documents',
      (ex) => {
        const { attachment: _a, ...r } = ex
        return r
      },
      'missing attachment',
    ],
    [
      'plans',
      (ex) => {
        const { title: _t, ...r } = ex
        return r
      },
      'missing title',
    ],
  ])('%s → %s', (silo, broke, reason) => {
    const m = ref(silo)
    const [kind, spec] = Object.entries<Json>(m.spec.kinds)[0]!
    const ex = spec.examples[0]
    const id = exampleFileId(m, kind, ex)!
    const { _file: _f, ...value } = ex
    write(fileOf(silo, id), broke(value))
    const { kernel: k } = kernel({ seed: false })
    expect(k.reading(silo)!.unreadable.map((u) => [u.id, u.reason])).toEqual([[id, reason]])
  })
})

describe('tolerance — lift and aliases produce exactly what the manifest declares', () => {
  it('support freehand: thread_id lifted with EMPTY subject/message id, opened → openedAt, customer → customerEmail, the note string lifted', () => {
    const { kernel: k } = kernel()
    const f = k.reading('support')!.records.find((r) => r.record.id === 'freehand-case')!.record as Json
    expect(f.threads).toEqual([
      expect.objectContaining({ threadId: 'th_777', subject: '', lastMessageId: '', lastMessageAt: '2026-10-21T08:00:00Z', draftId: 'd_8' }),
    ])
    expect(f.openedAt).toBe('2026-10-20T10:00:00Z')
    expect(f.customerEmail).toBe('another@example.com')
    expect(f.notes).toEqual([expect.objectContaining({ at: '', by: 'agent', text: 'asked them for the order number' })])
  })
  it('a conditioned alias that is not the fact is named, never guessed', () => {
    const m = ref('support')
    const { case: _c, ...ex } = m.spec.kinds.case.examples[1]
    write(fileOf('support', 'freehand-case'), { ...ex, customer: { email: 'x@y.co' } })
    const { kernel: k } = kernel({ seed: false })
    expect(k.reading('support')!.unreadable[0]!.reason).toBe(
      "missing customerEmail (found `customer`, an object — which of its fields is the customer's email?)",
    )
  })
})

describe('terminal derivations', () => {
  it('pulse counts only live records; the baseline floods nothing; «arrived closed» ≠ «closed»; an observed close is Done today', () => {
    let now = Date.parse('2026-10-30T12:00:00Z')
    const s = kernel({ now: () => now })
    expect(s.surfaces.board(now).pulse.find((p) => p.silo === 'support')!.term).toBe('2 support tickets')
    // a closed case at install time is baseline: no Done today
    expect(s.surfaces.board(now).done).toEqual([])
    now += 60_000
    write(fileOf('support', 'arrived-closed'), { ...ref('support').spec.kinds.case.examples[0], id: 'arrived-closed', status: 'closed' })
    write(fileOf('support', 'canonical-case'), { ...ref('support').spec.kinds.case.examples[0], status: 'closed' })
    s.kernel.refresh()
    expect(s.surfaces.board(now).pulse.find((p) => p.silo === 'support')!.term).toBe('1 support ticket')
    expect(s.surfaces.board(now).done.map((d) => d.key)).toEqual([keyOf('support', 'canonical-case')])
  })
})

describe('journal', () => {
  it('since(state) from the observed transition; removed when the file goes; a lost journal restarts out loud', () => {
    let now = Date.parse('2026-10-30T12:00:00Z')
    const s = kernel({ now: () => now })
    now += 3_600_000
    write(fileOf('support', 'canonical-case'), { ...ref('support').spec.kinds.case.examples[0], status: 'waiting_customer' })
    s.kernel.refresh()
    const rec = s.kernel.reading('support')!.records.find((r) => r.record.id === 'canonical-case')!.record
    const ast = parse('since(waiting_customer) >= now - 1m')
    if (!ast.ok) throw new Error()
    expect(evaluate(ast.ast, rec, { now, since: s.kernel.sinceFor('support') })).toBe(true)
    rmSync(fileOf('support', 'freehand-case'))
    s.kernel.refresh()
    const dir = s.registry.get('support')!.status.conventions[0]!.dir
    expect(s.journal.history(dir, keyOf('support', 'freehand-case')).map((l) => l.event)).toEqual(['baseline', 'removed'])
    // reconstruction said
    rmSync(join(s.registry.conventionsDir, dir, 'journal.jsonl'))
    mkdirSync(join(s.registry.conventionsDir, dir, 'data'), { recursive: true })
    const fresh = new TransitionJournal(s.registry.conventionsDir)
    const lines = fresh.observe({ convention: 'agent-state:support/cases', dir, silo: 'support', entries: [], preserve: [], complete: true }, new Date(now))
    expect(lines[0]).toMatchObject({ event: 'opened', reason: 'the journal was missing — history restarts here' })
    expect(s.journal.events(dir, 0).some(isCompletion)).toBe(false)
  })
})

describe('overlay (invoices, a sync source)', () => {
  const KEY = 'agent:finance/inv-70a1'
  it('seals, retires, conflicts, orphans, per field — and survives an uninstall', () => {
    const s = kernel()
    const file = fileOf('invoices', 'inv-70a1')
    const ex = ref('invoices').spec.kinds.invoice.examples[0]
    expect(s.actions.setField('invoices', KEY, 'state', 'paid').ok).toBe(true)
    const rec = s.kernel.reading('invoices')!.records.find((r) => r.record.id === 'inv-70a1')!
    expect(rec.overlay!.state).toMatchObject({ value: 'paid', base: 'open' }) // sealed
    expect(JSON.parse(readFileSync(file, 'utf8')).state).toBe('open') // never the file
    write(file, { ...ex, state: 'partial' })
    s.kernel.refresh()
    expect(s.kernel.overlayState('invoices').conflicts).toEqual([expect.objectContaining({ key: KEY, field: 'state', owner: 'paid', source: 'partial' })])
    write(file, { ...ex, state: 'paid' })
    s.kernel.refresh()
    expect(s.kernel.overlayState('invoices').conflicts).toEqual([]) // the source caught up: retired
    expect(s.kernel.reading('invoices')!.records.find((r) => r.record.id === 'inv-70a1')!.overlay).toBeUndefined()
    s.actions.setField('invoices', KEY, 'state', 'refunded')
    rmSync(file)
    s.kernel.refresh()
    expect(s.kernel.overlayState('invoices').orphans).toEqual([expect.objectContaining({ key: KEY, fields: ['state'] })])
    expect(s.registry.get('invoices')!.status.freshness!.term).toContain('1 owner change waits on a record the sync no longer writes')
    s.installer.uninstall('invoices')
    expect(s.overlay.list(s.operator.get('invoices')!.conventions![0]!.dir)).toHaveLength(1)
  })
})

describe('writing', () => {
  it('set-field on an agent source: re-read + merge + atomic replace with CAS', () => {
    const s = kernel()
    const file = fileOf('documents', 'official-request-2026')
    const key = keyOf('documents', 'official-request-2026')
    expect(s.actions.setField('documents', key, 'state', 'filed', { version: 'stale' })).toMatchObject({ ok: false, code: 409 })
    const version = createHash('sha256').update(readFileSync(file)).digest('hex')
    expect(s.actions.setField('documents', key, 'state', 'filed', { version }).ok).toBe(true)
    expect(JSON.parse(readFileSync(file, 'utf8')).state).toBe('filed')
  })
  it('append-item respects writeMerge: the producer never erases a note it did not write', () => {
    const s = kernel()
    const ex = ref('support').spec.kinds.case.examples[0]
    const r = s.actions.agentWrite('support', 'support', 'canonical-case', { ...ex, notes: [{ at: '2026-10-31T00:00:00Z', by: 'agent', text: 'new' }] })
    expect(r.ok).toBe(true)
    expect(JSON.parse(readFileSync(fileOf('support', 'canonical-case'), 'utf8')).notes.map((n: Json) => n.text)).toEqual([ex.notes[0].text, 'new'])
  })
  it.todo(
    'move-item: destination before source, idempotent retry — the catalog fixes its semantics; the kernel verb lands with step 3 (support re-expressed as a silo)',
  )
})

describe('data honesty', () => {
  it('counts over the whole set, the page cut said, freshness in every slot once the cadence passes', () => {
    for (let i = 0; i < 7; i++)
      write(fileOf('invoices', `hd-x${i}`), { ...ref('invoices').spec.kinds.invoice.examples[0], id: `hd-x${i}` }, new Date('2026-10-01T00:00:00Z'))
    const now = Date.parse('2026-10-30T12:00:00Z')
    const s = kernel({ now: () => now })
    const page = recordsPage(
      s.registry.get('invoices')!,
      s.kernel.reading('invoices'),
      { voice: { now }, overlayKeys: new Set(), conflictKeys: new Set() },
      { limit: 4 },
    )
    if ('error' in page) throw new Error(page.error)
    expect(page).toMatchObject({ total: 9, matching: 9, said: 'showing 4 of 9' })
    expect(page.kind.facets.find((f) => f.name === 'state')!.values.reduce((n, v) => n + v.count, 0)).toBe(9)
    // past its 24h cadence the silo says so, once, in its status and descriptor (what every slot shows)
    expect(s.registry.describe().find((d) => d.id === 'invoices')!.freshness).toMatchObject({
      stale: true,
      term: 'no new invoices since Oct 2 · the Invoicing sync last wrote Oct 1, 00:00 UTC',
    })
  })
})

describe('uninstall', () => {
  it('takes away what is its own — never records, overlay or journal; lists the producers; growth becomes a Home term', () => {
    let now = Date.parse('2026-10-30T12:00:00Z')
    const s = kernel({ now: () => now })
    const r = s.installer.uninstall('invoices')
    expect(r.body).toMatchObject({ uninstalled: 'invoices', producers: ['finance'] })
    expect(s.registry.get('invoices')).toBeNull()
    expect(existsSync(fileOf('invoices', 'inv-70a1'))).toBe(true)
    expect(existsSync(join(s.registry.conventionsDir, s.operator.get('invoices')!.conventions![0]!.dir, 'journal.jsonl'))).toBe(true)
    now += 120_000
    write(fileOf('invoices', 'hd-new'), { ...ref('invoices').spec.kinds.invoice.examples[0], id: 'hd-new' }, new Date(now))
    expect(s.surfaces.board(now).growth).toEqual([expect.objectContaining({ silo: 'invoices', records: 1 })])
  })
})

describe('installation', () => {
  it("every submission lands pending — owner or agent; only the owner's approval activates; every step is a visible event", () => {
    const s = kernel()
    const next = ref('documents')
    next.metadata.version = '0.2.0'
    expect(s.installer.submit({ manifest: next }, 'finance').code).toBe(201)
    expect(s.registry.get('documents')!.status.manifest.version).toBe('0.1.0') // the running one is untouched
    expect(s.installer.submissions()[0]).toMatchObject({ id: 'documents', submittedBy: 'finance', update: true })
    const fresh = { ...ref('documents'), metadata: { ...ref('documents').metadata, id: 'contracts', name: 'Contracts' } }
    expect(s.installer.submit({ manifest: fresh }, 'owner').code).toBe(201)
    expect(s.registry.get('contracts')).toBeNull()
    expect(s.installer.approve('contracts', { producers: ['finance'] }).code).toBe(200)
    expect(s.registry.get('contracts')!.status.state).toBe('active')
    expect(s.events.list().map((e) => e.verb)).toEqual(expect.arrayContaining(['submitted', 'installed']))
  })
})
