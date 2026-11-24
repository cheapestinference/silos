// What the active silos add to Home (Silo Standard step 1, Task 9): pulse
// terms, needs-you rows re-evaluated with the clock, overlay conflicts, Done
// today from the journal — and the records pages the list/record views read.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SiloRegistry } from '../src/silos/registry.js'
import { SiloReader } from '../src/silos/reader.js'
import { SiloKernel } from '../src/silos/kernel.js'
import { TransitionJournal } from '../src/silos/journal.js'
import { OverlayStore } from '../src/silos/overlay.js'
import { SiloSurfaces, type SiloNeedsYou } from '../src/silos/surfaces.js'
import { recordDetail, recordsPage } from '../src/silos/views.js'
import { siloManifest } from './helpers/silo-manifests.js'

type Json = Record<string, any>
const ref = (id: string): Json => siloManifest(id) as Json
const isAgent = (v: string): boolean => ['finance', 'writer'].includes(v)

let base: string
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'silo-surfaces-'))
})
afterEach(() => rmSync(base, { recursive: true, force: true }))

const invoice = (id: string, over: Json = {}): Json => ({ ...ref('invoices').spec.kinds.invoice.examples[0], id, documentNumber: `F-${id}`, ...over })
function put(rel: string, v: unknown): void {
  const f = join(base, rel)
  mkdirSync(join(f, '..'), { recursive: true })
  writeFileSync(f, JSON.stringify(v))
  utimesSync(f, new Date(), new Date())
}

function setup(
  manifests: Json[],
  opts: {
    decision?: 'approved' | null
    off?: string[]
    audienceOff?: number[]
    producers?: string[] | null
    archived?: Set<string>
    escalatedRow?: (silo: string, entry: number, key: string) => { since: string; asked: string[] } | null
    escalations?: () => SiloNeedsYou[]
    ofLocation?: (agentId: string, location: string) => boolean
  } = {},
) {
  const dataDir = join(base, 'data')
  for (const m of manifests) {
    mkdirSync(join(dataDir, 'silos', 'registry', m.metadata.id), { recursive: true })
    writeFileSync(join(dataDir, 'silos', 'registry', m.metadata.id, 'silo.json'), JSON.stringify(m))
  }
  const registry = new SiloRegistry({
    dataDir,
    operator: { decisionFor: () => (opts.decision === undefined ? 'approved' : opts.decision), slotsOff: () => opts.off ?? [] },
  })
  registry.load()
  let now = Date.parse('2026-10-30T12:00:00Z')
  const journal = new TransitionJournal(registry.conventionsDir)
  const kernel = new SiloKernel({
    registry,
    journal,
    overlay: new OverlayStore(registry.conventionsDir),
    isAgent,
    now: () => now,
    reader: new SiloReader({ agentStates: () => [{ agentId: 'finance', dir: join(base, 'as', 'finance') }], projects: () => [join(base, 'proj')] }),
  })
  const acked = new Set<string>()
  const surfaces = new SiloSurfaces({
    registry,
    kernel,
    journal,
    isAgent,
    acks: { isAcked: (s, k) => acked.has(`${s}|${k}`) },
    ...(opts.audienceOff ? { audienceOff: () => opts.audienceOff! } : {}),
    // the owner's binding at approval (operator.json) — a role is never an agent id
    producersOf: (id: string) =>
      opts.producers !== undefined ? opts.producers : (({ invoices: ['finance'], documents: ['finance'] } as Record<string, string[]>)[id] ?? null),
    ...(opts.archived ? { inPlay: (v: string) => isAgent(v) && !opts.archived!.has(v) } : {}),
    ...(opts.escalatedRow ? { escalatedRow: opts.escalatedRow } : {}),
    ...(opts.escalations ? { escalations: opts.escalations } : {}),
    ...(opts.ofLocation ? { ofLocation: opts.ofLocation } : {}),
  })
  kernel.refresh()
  return {
    registry,
    kernel,
    journal,
    surfaces,
    acked,
    now: () => now,
    tick: (ms: number) => {
      now += ms
    },
  }
}

describe('invoices on Home', () => {
  beforeEach(() => {
    put('as/finance/silos/invoices/a1.json', invoice('a1', { due: '2026-10-28', total: { amount: 100, currency: 'EUR' } }))
    put('as/finance/silos/invoices/a2.json', invoice('a2', { due: '2026-11-10', total: { amount: 50.5, currency: 'EUR' } }))
    put('as/finance/silos/invoices/a3.json', invoice('a3', { due: '2026-10-01', state: 'paid' }))
    put('as/finance/silos/invoices/a4.json', invoice('a4', { due: '2026-10-01', kind: 'purchase', total: { amount: 9, currency: 'USD' } }))
  })

  it('the pulse sums live sales; needs-you lists the overdue one with its clears and actions', () => {
    const { surfaces, now } = setup([ref('invoices')])
    const b = surfaces.board(now())
    expect(b.pulse).toEqual([{ silo: 'invoices', siloName: 'Invoices', term: '€150.50 outstanding' }])
    expect(b.needsYou).toEqual([
      {
        kind: 'silo',
        reason: 'entry',
        silo: 'invoices',
        siloName: 'Invoices',
        key: 'agent:finance/a1',
        recordKind: 'invoice',
        urgency: 'due',
        text: 'F-a1 · Acme SL — outstanding · due Oct 28',
        at: '2026-10-02',
        agentId: 'finance',
        identity: 'F-a1 · Acme SL',
        file: join(base, 'as/finance/silos/invoices/a1.json'),
        entry: 0,
        clears: 'state in [paid, refunded]',
        actions: ['set-field', 'open', 'message-agent'],
      },
    ])
  })

  it('the clock alone moves an invoice into Needs you (re-evaluated at every read)', () => {
    const { surfaces, now, tick } = setup([ref('invoices')])
    expect(surfaces.board(now()).needsYou.map((n) => n.key)).toEqual(['agent:finance/a1'])
    const before = surfaces.signature(now())
    tick(12 * 86_400_000)
    expect(
      surfaces
        .board(now())
        .needsYou.map((n) => n.key)
        .sort(),
    ).toEqual(['agent:finance/a1', 'agent:finance/a2'])
    expect(surfaces.signature(now())).not.toBe(before)
  })

  it('an acked item leaves; an overlay conflict comes in as blocking, in plain words', () => {
    const { surfaces, kernel, acked, now } = setup([ref('invoices')])
    acked.add('invoices|agent:finance/a1')
    expect(surfaces.board(now()).needsYou).toEqual([])
    kernel.setOwnerField('invoices', 'agent:finance/a2', 'state', 'paid')
    put('as/finance/silos/invoices/a2.json', invoice('a2', { due: '2026-11-10', state: 'partial' }))
    kernel.refresh()
    const c = surfaces.board(now()).needsYou.find((n) => n.reason === 'conflict')!
    expect(c).toMatchObject({
      urgency: 'blocking',
      key: 'agent:finance/a2',
      text: 'F-a2 · Acme SL — you set state to paid; the Invoicing sync now says partially paid',
      conflict: { field: 'state', owner: 'paid', base: 'open', source: 'partial' },
    })
  })

  it('Done today: the observed transition into a terminal state — never the baseline, never «arrived closed»', () => {
    const { surfaces, kernel, now, tick } = setup([ref('invoices')])
    expect(surfaces.board(now()).done).toEqual([])
    tick(60_000)
    put('as/finance/silos/invoices/a1.json', invoice('a1', { due: '2026-10-28', state: 'paid' }))
    put('as/finance/silos/invoices/a9.json', invoice('a9', { state: 'refunded', kind: 'refund' }))
    kernel.refresh()
    expect(surfaces.board(now()).done).toEqual([
      expect.objectContaining({ key: 'agent:finance/a1', identity: 'F-a1 · Acme SL', to: 'paid', toLabel: 'paid', agentId: 'finance' }),
    ])
    expect(surfaces.board(now()).done[0]!.drop).toBeUndefined()
  })

  it("Done today: a close into the kind's OTHER terminal state is flagged drop — never painted or counted as done", () => {
    const { surfaces, kernel, now, tick } = setup([ref('invoices')])
    put('as/finance/silos/invoices/a1.json', invoice('a1', { due: '2026-10-28', state: 'open' }))
    kernel.refresh()
    tick(60_000)
    put('as/finance/silos/invoices/a1.json', invoice('a1', { due: '2026-10-28', state: 'refunded' }))
    kernel.refresh()
    expect(surfaces.board(now()).done).toEqual([expect.objectContaining({ key: 'agent:finance/a1', to: 'refunded', toLabel: 'refunded', drop: true })])
  })

  it('the digest reads completions over any window, and the Horizon from roles.due', () => {
    const { surfaces, kernel, now, tick } = setup([ref('invoices')])
    const start = now()
    tick(60_000)
    put('as/finance/silos/invoices/a1.json', invoice('a1', { due: '2026-10-28', state: 'paid' }))
    kernel.refresh()
    expect(surfaces.completions(start, now() + 1)).toEqual([expect.objectContaining({ silo: 'invoices', to: 'paid', toLabel: 'paid' })])
    expect(surfaces.completions(now() + 1, now() + 2)).toEqual([])
    // a2 is due 2026-11-10: outside 7 days from 10-30, inside from 11-05
    expect(surfaces.horizon(now())).toEqual([])
    expect(surfaces.horizon(Date.parse('2026-11-05T12:00:00Z'))).toEqual([
      { silo: 'invoices', siloName: 'Invoices', kind: 'invoice', count: 1, firstDue: '2026-11-10' },
    ])
  })

  it('no active silo declaring `due`: the Horizon is absent (null), not empty', () => {
    const { surfaces, now } = setup([ref('support')])
    expect(surfaces.horizon(now())).toBeNull()
  })

  it('a pending silo adds nothing; a slot the operator turned off adds nothing', () => {
    expect(setup([ref('invoices')], { decision: null }).surfaces.board(Date.now())).toEqual({ pulse: [], needsYou: [], done: [], growth: [], withProducer: [] })
    rmSync(join(base, 'data'), { recursive: true })
    const off = setup([ref('invoices')], { off: ['pulse', 'needs-you'] })
    expect(off.surfaces.board(off.now())).toMatchObject({ pulse: [], needsYou: [] })
  })
})

describe('plans on Home — a sub-kind pulse and needs-you over a project folder', () => {
  it('«1 task yours to do»; a gate is `due` and says so; a routine row folds when the plan is idle (0.2.0, G7)', () => {
    // t2 (the owner's) gates t3 (the Finance's) — due, never folded
    const ex = ref('plans').spec.kinds.plan.examples[0]
    put('proj/plans/month-end.plan.json', { ...ex, tasks: ex.tasks.map((t: Json) => (t.id === 't2' ? { ...t, owner: 'owner' } : t)) })
    const { surfaces, now } = setup([ref('plans')])
    const b = surfaces.board(now())
    expect(b.pulse).toEqual([{ silo: 'plans', siloName: 'Plans', term: '1 task yours to do' }])
    expect(b.needsYou).toEqual([
      expect.objectContaining({
        key: `folder:${join(base, 'proj')}/month-end/tasks/t2`,
        recordKind: 'plan/task',
        urgency: 'due',
        entry: 1,
        text: 'Confirm the figure with the accountant — pending · unblocks 1 task of finance',
        folder: join(base, 'proj'),
      }),
    ])
    expect(b.needsYou[0]!.folded).toBeUndefined()
  })
  it("another person's gate comes FIRST, said as theirs — never in your pulse (E8, F10)", () => {
    // month-end: t2 (sam) gates t3 (the Finance's) — the chase row, entry 0, with Done in your name
    put('proj/plans/month-end.plan.json', ref('plans').spec.kinds.plan.examples[0])
    const { surfaces, now } = setup([ref('plans')])
    const b = surfaces.board(now())
    expect(b.pulse).toEqual([])
    expect(b.needsYou).toEqual([
      expect.objectContaining({
        key: `folder:${join(base, 'proj')}/month-end/tasks/t2`,
        urgency: 'due',
        entry: 0,
        text: "sam's Confirm the figure with the accountant — pending · unblocks 1 task of finance",
        actions: ['open', 'set-field', 'append-item'],
      }),
    ])
  })
  it('a human task nobody waits on is routine, folded once its plan is idle a month; in progress counts as ready', () => {
    const ex = ref('plans').spec.kinds.plan.examples[0]
    put('proj/plans/solo.plan.json', {
      ...ex,
      tasks: [
        { id: 'h', title: 'Sign', owner: 'owner', status: 'in_progress', dependsOn: [] },
        { id: 's', title: 'From sam', owner: 'sam', status: 'pending', dependsOn: [] },
      ],
    })
    const { surfaces, now } = setup([ref('plans')])
    // sam's task that gates nobody is sam's — not a row of yours
    expect(surfaces.board(now()).needsYou).toEqual([
      expect.objectContaining({ key: `folder:${join(base, 'proj')}/solo/tasks/h`, urgency: 'routine', entry: 2, text: 'Sign — in progress', folded: true }),
    ])
  })
  it('an escalated task is ONE row — its escalation; the waits-on-you entry stands down', () => {
    const ex = ref('plans').spec.kinds.plan.examples[0]
    put('proj/plans/esc.plan.json', {
      ...ex,
      tasks: [
        {
          id: 'o1',
          title: 'Renew the TLS certificate',
          owner: 'writer',
          status: 'blocked',
          dependsOn: [],
          waitingOn: { owner: 'owner', action: 'unstick it' },
        },
      ],
    })
    const key = `folder:${join(base, 'proj')}/esc/tasks/o1`
    const esc: SiloNeedsYou = {
      kind: 'silo',
      reason: 'escalation',
      silo: 'plans',
      siloName: 'Plans',
      key,
      recordKind: 'plan/task',
      urgency: 'blocking',
      text: 'esc#o1 stalled since Nov 6 — asked Writer; nobody moved it',
      at: '2026-10-30T11:00:00Z',
      file: null,
    }
    const { surfaces, now } = setup([ref('plans')], { escalations: () => [esc] })
    const rows = surfaces.board(now()).needsYou.filter((n) => n.key === key)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.reason).toBe('escalation')
  })
  it("an AGENT's task waiting on the owner is `due` and says the ask — answered with a note, never a Done on someone else's task (no resolve)", () => {
    const ex = ref('plans').spec.kinds.plan.examples[0]
    put('proj/plans/wait.plan.json', {
      ...ex,
      tasks: [
        {
          id: 'w6',
          title: 'Notify the waitlist',
          owner: 'writer',
          status: 'blocked',
          dependsOn: [],
          waitingOn: { owner: 'owner', action: 'Decide: (A) resume or (B) park' },
        },
        {
          id: 'w7',
          title: 'Waits on Finance, not on the owner',
          owner: 'writer',
          status: 'blocked',
          dependsOn: [],
          waitingOn: { owner: 'finance', action: 'deploy' },
        },
      ],
    })
    const { surfaces, now } = setup([ref('plans')])
    const rows = surfaces.board(now()).needsYou
    expect(rows).toEqual([
      expect.objectContaining({
        key: `folder:${join(base, 'proj')}/wait/tasks/w6`,
        urgency: 'due',
        entry: 3,
        text: 'Notify the waitlist — blocked · waits on you: Decide: (A) resume or (B) park',
        actions: ['open', 'append-item'],
      }),
    ])
    expect(rows[0]!.resolve).toBeUndefined()
  })
})

describe('a sub-kind row carries its parent, its identity and how the owner settles it (G5)', () => {
  it("a task row names its plan (key, kind, identity, moment); Done = set-field status → done; Drop's note = notes", () => {
    put('proj/plans/month-end.plan.json', ref('plans').spec.kinds.plan.examples[0])
    const { surfaces, now } = setup([ref('plans')])
    const [row] = surfaces.board(now()).needsYou
    expect(row).toMatchObject({
      identity: 'Confirm the figure with the accountant',
      parent: { key: `folder:${join(base, 'proj')}/month-end`, kind: 'plan', identity: 'August books close', at: '2026-08-27' },
      resolve: { field: 'status', done: 'done', note: 'notes' },
    })
    // the state the reader read when it composed the row — what Done / Drop send back (F4)
    expect(row!.state).toBe('pending')
  })
  it('a top-level row has no parent and is settled on its own page (no resolve)', () => {
    put('as/finance/silos/invoices/a1.json', invoice('a1', { due: '2026-10-28' }))
    const { surfaces, now } = setup([ref('invoices')])
    const [row] = surfaces.board(now()).needsYou
    expect(row!.parent).toBeUndefined()
    expect(row!.identity).toBe('F-a1 · Acme SL')
    expect(row!.resolve).toBeUndefined()
    expect(row!.state).toBeUndefined()
  })
})

describe('plans: who is the owner (the floor the native board kept, 0.2.x)', () => {
  it("a task owned by any known agent id — archived ones included (isAgent) — is never the owner's; a human's is", () => {
    const ex = ref('plans').spec.kinds.plan.examples[0]
    put('proj/plans/two.plan.json', {
      ...ex,
      tasks: [
        { id: 'a', title: 'by the Finance', owner: 'finance', status: 'pending', dependsOn: [] },
        { id: 'h', title: 'by you', owner: 'owner', status: 'pending', dependsOn: [] },
        { id: 's', title: 'by sam', owner: 'sam', status: 'pending', dependsOn: [] },
      ],
    })
    const { surfaces, now } = setup([ref('plans')])
    // «you» is only the owner (E8): sam's task is sam's, not yours
    expect(surfaces.board(now()).needsYou.map((n) => n.identity)).toEqual(['by you'])
  })
})

describe('the records pages (what the list and record views read)', () => {
  it('server-paginated, counted over the whole set, the cut said; facets and filters', () => {
    for (let i = 0; i < 7; i++) put(`as/finance/silos/invoices/b${i}.json`, invoice(`b${i}`, { date: `2026-10-0${i + 1}`, state: i < 2 ? 'paid' : 'open' }))
    const { registry, kernel, now } = setup([ref('invoices')])
    const entry = registry.get('invoices')!
    const voice = { now: now(), isAgent }
    const page = recordsPage(entry, kernel.reading('invoices'), { voice, overlayKeys: new Set(), conflictKeys: new Set() }, { limit: 3 })
    if ('error' in page) throw new Error(page.error)
    expect(page).toMatchObject({
      total: 7,
      matching: 7,
      offset: 0,
      limit: 3,
      said: 'showing 3 of 7',
      silo: { id: 'invoices', name: 'Invoices', state: 'active' },
    })
    expect(page.kind.columns).toEqual(['identity', 'state', 'total', 'due', 'at'])
    expect(page.kind.facets.find((f) => f.name === 'state')!.values).toEqual([
      { value: 'open', label: 'outstanding', count: 5 },
      { value: 'paid', label: 'paid', count: 2 },
    ])
    expect(page.kind.facets.find((f) => f.name === 'total.currency')!.values).toEqual([{ value: 'EUR', label: 'EUR', count: 7 }])
    // newest first, folded (paid) last
    expect(page.records.map((r) => r.id)).toEqual(['b6', 'b5', 'b4'])
    expect(page.records[0]!.cells).toEqual([
      { column: 'identity', text: 'F-b6 · Acme SL' },
      { column: 'state', text: 'outstanding' },
      { column: 'total', text: '€465.51' },
      { column: 'due', text: 'Nov 1' },
      { column: 'at', text: 'Oct 7' },
    ])
    const paid = recordsPage(entry, kernel.reading('invoices'), { voice, overlayKeys: new Set(), conflictKeys: new Set() }, { facets: { state: 'paid' } })
    expect(!('error' in paid) && paid.records.map((r) => [r.id, r.folded])).toEqual([
      ['b1', true],
      ['b0', true],
    ])
    expect(!('error' in paid) && paid.said).toBeNull()
    expect(recordsPage(entry, null, { voice, overlayKeys: new Set(), conflictKeys: new Set() }, { kind: 'nope' })).toEqual({
      error: 'nope is not a kind of invoices (invoice)',
    })
  })

  it('a record with its fields, preserved extras, actions, needs-you and journal story', () => {
    put('as/finance/silos/invoices/a1.json', invoice('a1', { due: '2026-10-28', ledgerlyRaw: { x: 1 } }))
    const { registry, kernel, journal, now } = setup([ref('invoices')])
    const d = recordDetail(registry.get('invoices')!, kernel.reading('invoices'), 'agent:finance/a1', { voice: { now: now(), isAgent }, journal })!
    expect(d.record).toMatchObject({ key: 'agent:finance/a1', identity: 'F-a1 · Acme SL', stateLabel: 'outstanding' })
    expect(d.version).toMatch(/^[0-9a-f]{64}$/)
    expect(d.fields.find((f) => f.name === 'total')).toEqual({ name: 'total', type: 'money', value: { amount: 465.51, currency: 'EUR' }, text: '€465.51' })
    expect(d.extra).toEqual({ ledgerlyRaw: { x: 1 } })
    expect(d.needsYou).toEqual([{ entry: 0, urgency: 'due', clears: 'state in [paid, refunded]', actions: ['set-field', 'open', 'message-agent'] }])
    expect(d.actions.find((a) => a.verb === 'set-field')).toEqual({
      verb: 'set-field',
      fields: [{ name: 'state', values: ['draft', 'open', 'partial', 'paid', 'refunded'] }],
    })
    expect(d.history.map((l) => l.event)).toEqual(['baseline'])
    expect(recordDetail(registry.get('invoices')!, kernel.reading('invoices'), 'agent:finance/zz', { voice: { now: now() } })).toBeNull()
  })
})

describe("audience: producer-agent — the entry's rows go to the producer, counted, never listed", () => {
  const routedInvoices = (): Json => {
    const m = ref('invoices')
    m.spec.surfaces['needs-you'][0].audience = 'producer-agent'
    return m
  }
  beforeEach(() => {
    put('as/finance/silos/invoices/a1.json', invoice('a1', { due: '2026-10-28', total: { amount: 100, currency: 'EUR' } }))
    put('as/finance/silos/invoices/a2.json', invoice('a2', { due: '2026-11-10', total: { amount: 50.5, currency: 'EUR' } }))
  })

  it("the overdue row leaves the owner's inbox and lands in withProducer with count and oldest", () => {
    const { surfaces, now } = setup([routedInvoices()])
    const b = surfaces.board(now())
    expect(b.needsYou).toEqual([])
    expect(b.withProducer).toEqual([
      { silo: 'invoices', siloName: 'Invoices', agentId: 'finance', recordKind: 'invoice', entry: 0, count: 1, oldest: '2026-10-02' },
    ])
  })

  it('the clock alone grows the count, and the signature says so', () => {
    const { surfaces, now, tick } = setup([routedInvoices()])
    const before = surfaces.signature(now())
    tick(12 * 86_400_000)
    expect(surfaces.board(now()).withProducer[0]).toMatchObject({ count: 2 })
    expect(surfaces.signature(now())).not.toBe(before)
  })

  it('D7: the routed rows uncleared are what the escalation reads; one that rose comes back to the owner, said', () => {
    const { surfaces, now } = setup([routedInvoices()], {
      escalatedRow: (silo, entry, key) => (key === 'agent:finance/a1' ? { since: '2026-10-29T12:00:00.000Z', asked: ['builder'] } : null),
    })
    expect(surfaces.routedRows(now())).toMatchObject([{ silo: 'invoices', entry: 0, key: 'agent:finance/a1', producer: 'finance', recordKind: 'invoice' }])
    const b = surfaces.board(now())
    expect(b.needsYou).toMatchObject([
      { reason: 'entry', key: 'agent:finance/a1', urgency: 'due', escalated: { since: '2026-10-29T12:00:00.000Z', asked: ['builder'], with: 'finance' } },
    ])
    expect(b.withProducer).toEqual([
      { silo: 'invoices', siloName: 'Invoices', agentId: 'finance', recordKind: 'invoice', entry: 0, count: 0, oldest: '', escalated: 1 },
    ])
  })

  it('an owner ack neither hides nor counts a routed row (it is not in their inbox)', () => {
    const { surfaces, acked, now } = setup([routedInvoices()])
    acked.add('invoices|agent:finance/a1')
    expect(surfaces.board(now()).withProducer[0]).toMatchObject({ count: 1 })
  })

  it("the operator's veto (audienceOff) brings the rows back to the owner", () => {
    const { surfaces, now } = setup([routedInvoices()], { audienceOff: [0] })
    const b = surfaces.board(now())
    expect(b.withProducer).toEqual([])
    expect(b.needsYou.map((n) => n.key)).toEqual(['agent:finance/a1'])
  })

  it('no producer to take them: the rows stay with the owner — never bound, even with a role that matches an agent id', () => {
    const m = routedInvoices()
    m.spec.producer.role = 'finance' // a role is a word of the manifest, never an agent id
    const { surfaces, now } = setup([m], { producers: null })
    const b = surfaces.board(now())
    expect(b.withProducer).toEqual([])
    expect(b.needsYou.map((n) => n.key)).toEqual(['agent:finance/a1'])
  })

  it('an ARCHIVED bound producer works nothing: the rows come back to the owner, never «with Finance»; reactivated → routed again', () => {
    const archived = new Set(['finance'])
    const { surfaces, now } = setup([routedInvoices()], { producers: ['finance'], archived })
    const b = surfaces.board(now())
    expect(b.withProducer).toEqual([])
    expect(b.needsYou.map((n) => n.key)).toEqual(['agent:finance/a1'])
    // the row is not said to be with the archived agent (its anchor) either
    expect(b.needsYou[0]!.agentId).toBeUndefined()
    expect(surfaces.routing('invoices')).toBeNull()
    expect(surfaces.completions(0, now() + 1).every((d) => d.agentId !== 'finance')).toBe(true)
    archived.delete('finance')
    const again = surfaces.board(now())
    expect(again.needsYou).toEqual([])
    expect(again.withProducer).toMatchObject([{ agentId: 'finance', count: 1 }])
    expect(surfaces.routing('invoices')).toEqual({ to: ['finance'], entries: [0], of: 1 })
  })

  it('several producers: a row goes to the agent that wrote its record, not to the first bound', () => {
    const { surfaces, now } = setup([routedInvoices()], { producers: ['writer', 'finance'] })
    expect(surfaces.board(now()).withProducer).toMatchObject([{ agentId: 'finance', count: 1 }])
    expect(surfaces.routedRows(now()).map((r) => r.producer)).toEqual(['finance'])
    expect(surfaces.routing('invoices')!.to).toEqual(['writer', 'finance'])
  })

  it('a record whose writer is no longer bound falls to the first producer in play', () => {
    const { surfaces, now } = setup([routedInvoices()], { producers: ['writer'] })
    expect(surfaces.board(now()).withProducer).toMatchObject([{ agentId: 'writer', count: 1 }])
  })

  it('(R3) a record routes only to a producer of its location — writer or fallback; none there, the owner keeps it', () => {
    const ofLocation = (a: string, loc: string): boolean => loc === `agent:${a}`
    // the writer is of its own state: routed to it, as before
    const mine = setup([routedInvoices()], { producers: ['writer', 'finance'], ofLocation })
    expect(mine.surfaces.routedRows(mine.now())).toMatchObject([{ producer: 'finance', location: 'agent:finance' }])
    // finance's record, only writer bound: the fallback is not of finance's state — no route
    const other = setup([routedInvoices()], { producers: ['writer'], ofLocation })
    expect(other.surfaces.routedRows(other.now())).toEqual([])
    const b = other.surfaces.board(other.now())
    expect(b.withProducer).toEqual([])
    expect(b.needsYou.map((n) => n.key)).toEqual(['agent:finance/a1'])
  })

  it('a binding with an archived agent first routes to the next agent in play', () => {
    const { surfaces, now } = setup([routedInvoices()], { producers: ['finance', 'writer'], archived: new Set(['finance']) })
    const b = surfaces.board(now())
    expect(b.withProducer).toMatchObject([{ agentId: 'writer', count: 1 }])
  })

  it('a never-bound silo whose role names an archived agent: the owner keeps the rows', () => {
    const { surfaces, now } = setup([routedInvoices()], { archived: new Set(['finance']) })
    const b = surfaces.board(now())
    expect(b.withProducer).toEqual([])
    expect(b.needsYou.map((n) => n.key)).toEqual(['agent:finance/a1'])
  })

  it('a blocking entry never routes, whatever it declares', () => {
    const m = routedInvoices()
    m.spec.surfaces['needs-you'][0].urgency = 'blocking'
    const { surfaces, now } = setup([m])
    const b = surfaces.board(now())
    expect(b.withProducer).toEqual([])
    expect(b.needsYou.map((n) => n.urgency)).toEqual(['blocking'])
  })
})

describe("routing() — the silo page's words for an audience-routed silo", () => {
  const routedInvoices = (): Json => {
    const m = ref('invoices')
    m.spec.surfaces['needs-you'][0].audience = 'producer-agent'
    return m
  }
  beforeEach(() => {
    put('as/finance/silos/invoices/a1.json', invoice('a1', { due: '2026-10-28' }))
  })

  it('routed: who and which entries of how many; vetoed or plain owner audience: null', () => {
    expect(setup([routedInvoices()]).surfaces.routing('invoices')).toEqual({ to: ['finance'], entries: [0], of: 1 })
    rmSync(join(base, 'data'), { recursive: true })
    expect(setup([routedInvoices()], { audienceOff: [0] }).surfaces.routing('invoices')).toBeNull()
    rmSync(join(base, 'data'), { recursive: true })
    expect(setup([ref('invoices')]).surfaces.routing('invoices')).toBeNull()
    rmSync(join(base, 'data'), { recursive: true })
    expect(setup([routedInvoices()], { decision: null }).surfaces.routing('invoices')).toBeNull()
  })
})
