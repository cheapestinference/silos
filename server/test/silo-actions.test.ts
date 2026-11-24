// The v0 actions (Silo Standard step 1, Task 10): set-field (overlay over a
// sync source, the file with CAS over an agent source), ack, message-agent
// from templates, agent-record-write with writeMerge, the producer's merged
// view, proposals approved or rejected — every one an event.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SiloRegistry } from '../src/silos/registry.js'
import { SiloReader } from '../src/silos/reader.js'
import { SiloKernel } from '../src/silos/kernel.js'
import { TransitionJournal } from '../src/silos/journal.js'
import { OverlayStore } from '../src/silos/overlay.js'
import { SiloSurfaces } from '../src/silos/surfaces.js'
import { SiloActions, SiloAcks, SiloEvents, SiloProposals, mergeAppendOnly } from '../src/silos/actions.js'
import { kindsOf } from '../src/silos/voice.js'
import { siloManifest } from './helpers/silo-manifests.js'

type Json = Record<string, any>
const ref = (id: string): Json => siloManifest(id) as Json
const AGENTS = ['finance', 'writer', 'support']
const isAgent = (v: string): boolean => AGENTS.includes(v)

let base: string
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'silo-actions-'))
})
afterEach(() => rmSync(base, { recursive: true, force: true }))

const as = (): string => join(base, 'agent-state')
function put(rel: string, v: unknown): string {
  const f = join(base, rel)
  mkdirSync(join(f, '..'), { recursive: true })
  writeFileSync(f, JSON.stringify(v, null, 2))
  utimesSync(f, new Date(), new Date())
  return f
}
const sha = (f: string): string => createHash('sha256').update(readFileSync(f)).digest('hex')

// the bindings the owner made at approval (operator.json) — a role is a word
// of the manifest, never an agent id: only a binding names who produces
const BOUND: Record<string, string[]> = { invoices: ['finance'], documents: ['finance'], support: ['support'] }

function setup(
  decision: 'approved' | null = 'approved',
  extra: { producers?: string[] | null; archived?: Set<string>; mayRead?: (agent: string, loc: string) => boolean } = {},
) {
  const dataDir = join(base, 'data')
  for (const id of ['invoices', 'documents', 'support', 'plans']) {
    mkdirSync(join(dataDir, 'silos', 'registry', id), { recursive: true })
    writeFileSync(join(dataDir, 'silos', 'registry', id, 'silo.json'), JSON.stringify(ref(id)))
  }
  const registry = new SiloRegistry({ dataDir, operator: { decisionFor: () => decision, slotsOff: () => [] } })
  registry.load()
  const kernel = new SiloKernel({
    registry,
    journal: new TransitionJournal(registry.conventionsDir),
    overlay: new OverlayStore(registry.conventionsDir),
    isAgent,
    reader: new SiloReader({ agentStates: () => AGENTS.map((a) => ({ agentId: a, dir: join(as(), a) })), projects: () => [join(base, 'proj')] }),
  })
  kernel.refresh()
  const sent: Array<{ from: string; to: string; text: string }> = []
  const acks = new SiloAcks(registry.root)
  const actions = new SiloActions({
    registry,
    kernel,
    events: new SiloEvents(registry.root),
    acks,
    proposals: new SiloProposals(registry.root),
    messages: {
      send: (m) => {
        sent.push(m)
        return { id: `m${sent.length}` }
      },
    },
    agentStateBase: as(),
    isAgent,
    agentMayReadLocation: extra.mayRead ?? ((agent, loc) => loc === `agent:${agent}`),
    locations: { projects: () => [join(base, 'proj')] },
    producersOf: (id: string) => (extra.producers !== undefined ? extra.producers : (BOUND[id] ?? null)),
    ...(extra.archived ? { inPlay: (v: string) => isAgent(v) && !extra.archived!.has(v) } : {}),
  })
  const surfaces = new SiloSurfaces({ registry, kernel, isAgent, acks, proposals: (id) => actions.proposalsNeedsYou(id) })
  return { registry, kernel, actions, surfaces, sent }
}

const invoice = (over: Json = {}): Json => ({ ...ref('invoices').spec.kinds.invoice.examples[0], ...over })
const INV = 'agent:finance/inv-70a1'

describe('set-field', () => {
  it('only on an active silo', () => {
    put('agent-state/finance/silos/invoices/inv-70a1.json', invoice())
    const { actions } = setup(null)
    expect(actions.setField('invoices', INV, 'state', 'paid')).toMatchObject({
      ok: false,
      code: 409,
      reason: 'invoices is not active (waiting for the owner to approve it) — actions exist only on an active silo',
    })
  })

  it('over a sync source: the overlay, never the file — and an event', () => {
    const f = put('agent-state/finance/silos/invoices/inv-70a1.json', invoice())
    const before = readFileSync(f, 'utf8')
    const { actions } = setup()
    const r = actions.setField('invoices', INV, 'state', 'paid')
    expect(r.ok && r.value.record.state).toBe('paid')
    expect(readFileSync(f, 'utf8')).toBe(before)
    expect(actions.events('invoices', INV).map((e) => e.text)).toEqual(['set-field state: open → paid (held over the sync)'])
    expect(actions.setField('invoices', INV, 'total', 1)).toMatchObject({ ok: false, code: 403, reason: 'total is not a field the owner may set on invoice' })
  })

  it('over an agent source: re-read + merge + atomic replace with CAS; the owner stamps updatedBy', () => {
    const f = put('proj/context/documents/official-request-2026.json', { ...ref('documents').spec.kinds.document.examples[0], mine: 'kept' })
    const { actions } = setup()
    const key = `folder:${join(base, 'proj')}/official-request-2026`
    expect(actions.setField('documents', key, 'state', 'filed', { version: 'stale' })).toMatchObject({
      ok: false,
      code: 409,
      reason: 'the record changed since you read it — read it again',
      detail: { version: sha(f) },
    })
    expect(JSON.parse(readFileSync(f, 'utf8')).state).toBe('action_needed')
    expect(actions.setField('documents', key, 'state', 'lost')).toMatchObject({
      ok: false,
      code: 400,
      reason: 'state "lost" is not one of received/action_needed/filed',
    })
    const r = actions.setField('documents', key, 'state', 'filed', { version: sha(f) })
    expect(r.ok && r.value.record.state).toBe('filed')
    expect(JSON.parse(readFileSync(f, 'utf8'))).toMatchObject({ state: 'filed', updatedBy: 'owner', mine: 'kept' })
  })

  it("a child of a record (a plan task) is set inside its parent's file", () => {
    const f = put('proj/plans/month-end.plan.json', ref('plans').spec.kinds.plan.examples[0])
    const { actions } = setup()
    const key = `folder:${join(base, 'proj')}/month-end/tasks/t2`
    const r = actions.setField('plans', key, 'status', 'done')
    expect(r.ok).toBe(true)
    expect(JSON.parse(readFileSync(f, 'utf8')).tasks[1]).toMatchObject({ id: 't2', status: 'done', owner: 'sam' })
  })

  it("a clearable field is cleared with null; another can't be", () => {
    const f = put('agent-state/support/support/cases/canonical-case.json', ref('support').spec.kinds.case.examples[0])
    const { actions } = setup()
    const key = 'agent:support/canonical-case'
    expect(actions.setField('support', key, 'status', null)).toMatchObject({ ok: false, code: 400, reason: "status can't be cleared" })
    expect(actions.setField('support', key, 'userId', null).ok).toBe(true)
    expect('userId' in JSON.parse(readFileSync(f, 'utf8'))).toBe(false)
  })
})

describe('ack, message-agent, resolve', () => {
  it('ack: the row leaves Needs you until the record moves', () => {
    put('agent-state/finance/silos/invoices/inv-70a1.json', invoice({ due: '2026-01-01' }))
    const { actions, surfaces, kernel } = setup()
    expect(surfaces.board(Date.now()).needsYou.map((n) => n.key)).toEqual([INV])
    expect(actions.ack('invoices', INV).ok).toBe(true)
    expect(surfaces.board(Date.now()).needsYou).toEqual([])
    put('agent-state/finance/silos/invoices/inv-70a1.json', invoice({ due: '2026-01-01', state: 'partial' }))
    kernel.refresh()
    expect(surfaces.board(Date.now()).needsYou.map((n) => n.key)).toEqual([INV])
  })

  it('message-agent: the template filled from the record, its provenance, to the producer', () => {
    put('agent-state/finance/silos/invoices/inv-70a1.json', invoice())
    const { actions, sent } = setup()
    const r = actions.messageAgent('invoices', INV, 0)
    expect(r.ok).toBe(true)
    expect(sent).toEqual([
      {
        from: 'owner',
        to: 'finance',
        text: 'Chase payment for F2026-0412 · Acme SL (€465.51)\n\n— composed from the record F2026-0412 · Acme SL (agent:finance/inv-70a1) via the silo Invoices',
      },
    ])
    expect(actions.messageAgent('invoices', INV, 7)).toMatchObject({ ok: false, code: 400, reason: 'template 7 does not exist (0–1)' })
    expect(actions.events('invoices', INV)[0]).toMatchObject({
      verb: 'message-agent',
      text: 'message to finance: Chase payment for F2026-0412 · Acme SL (€465.51)',
      detail: { messageIds: ['m1'] },
    })
  })

  // «Wake the producer now» became make-task — the
  // filled template becomes a task of the producer in its project's list
  it("make-task: the filled template becomes a task of the producer in its project's list, with the record's ref; the next one is t2", () => {
    put('agent-state/finance/silos/invoices/inv-70a1.json', invoice())
    const proj = join(base, 'proj')
    mkdirSync(proj, { recursive: true })
    const { actions, sent } = setup()
    const r = actions.makeTask('invoices', INV, 0, { folderOf: () => proj })
    expect(r).toMatchObject({
      ok: true,
      value: { to: 'finance', taskKey: `folder:${proj}/tasks/tasks/t1`, title: 'Chase payment for F2026-0412 · Acme SL (€465.51)' },
    })
    const list = JSON.parse(readFileSync(join(proj, 'plans', 'tasks.plan.json'), 'utf8'))
    expect(list.tasks[0]).toMatchObject({ id: 't1', owner: 'finance', title: 'Chase payment for F2026-0412 · Acme SL (€465.51)', status: 'pending' })
    expect(list.tasks[0].notes[0].text).toBe(
      'Chase payment for F2026-0412 · Acme SL (€465.51)\n\n— from the record F2026-0412 · Acme SL (agent:finance/inv-70a1) in the silo Invoices',
    )
    expect(sent).toEqual([]) // a task, not a message
    expect(actions.makeTask('invoices', INV, 0, { folderOf: () => proj })).toMatchObject({ ok: true, value: { taskKey: `folder:${proj}/tasks/tasks/t2` } })
    expect(
      actions
        .events('invoices', INV)
        .filter((e) => e.verb === 'make-task')
        .map((e) => (e.detail as { task: string }).task)
        .sort(),
    ).toEqual([`folder:${proj}/tasks/tasks/t1`, `folder:${proj}/tasks/tasks/t2`])
  })

  it('make-task: no folder → 409; a birth stamp that refuses writes nothing', () => {
    put('agent-state/finance/silos/invoices/inv-70a1.json', invoice())
    const proj = join(base, 'proj')
    mkdirSync(proj, { recursive: true })
    const { actions } = setup()
    expect(actions.makeTask('invoices', INV, 0, { folderOf: () => null })).toMatchObject({ ok: false, code: 409 })
    expect(actions.makeTask('invoices', INV, 9, { folderOf: () => proj })).toMatchObject({ ok: false, code: 400 })
    expect(actions.makeTask('invoices', INV, 0, { folderOf: () => proj, prepare: () => ({ ok: false, code: 403, error: 'no' }) })).toMatchObject({
      ok: false,
      code: 403,
      reason: 'no',
    })
    expect(JSON.parse(readFileSync(join(proj, 'plans', 'tasks.plan.json'), 'utf8')).tasks).toEqual([])
  })

  it("several producers: the record's message and its task go to the agent that wrote it", () => {
    put('agent-state/finance/silos/invoices/inv-70a1.json', invoice())
    const proj = join(base, 'proj')
    mkdirSync(proj, { recursive: true })
    const { actions, sent } = setup('approved', { producers: ['writer', 'finance'] })
    expect(actions.messageAgent('invoices', INV, 0).ok).toBe(true)
    expect(sent.map((m) => m.to)).toEqual(['finance'])
    expect(actions.makeTask('invoices', INV, 0, { folderOf: () => proj })).toMatchObject({ ok: true, value: { to: 'finance' } })
  })

  it('message-agent never goes to an ARCHIVED producer — bound or by role — and says why; reactivated → sent', () => {
    put('agent-state/finance/silos/invoices/inv-70a1.json', invoice())
    const archived = new Set(['finance'])
    const { actions, sent } = setup('approved', { producers: ['finance'], archived })
    expect(actions.messageAgent('invoices', INV, 0)).toMatchObject({
      ok: false,
      code: 409,
      reason: 'the producer role of invoices is bound to finance, archived — no agent in play to message',
    })
    expect(sent).toEqual([])
    // an archived producer writes nothing either
    expect(actions.agentWrite('invoices', 'finance', 'x', invoice({ id: 'x' }))).toMatchObject({ ok: false, code: 403 })
    archived.delete('finance')
    expect(actions.messageAgent('invoices', INV, 0).ok).toBe(true)
    expect(sent.map((m) => m.to)).toEqual(['finance'])
  })

  it('never bound: a role is a word of the manifest, never an agent id — even one that matches an agent produces nothing', () => {
    put('agent-state/finance/silos/invoices/inv-70a1.json', invoice())
    expect(ref('invoices').spec.producer.role).toBe('finance') // the reference's role IS an agent's id here
    const { actions } = setup('approved', { producers: null })
    expect(actions.producersOf('invoices')).toEqual([])
    expect(actions.messageAgent('invoices', INV, 0)).toMatchObject({
      ok: false,
      code: 409,
      reason: 'the producer role of invoices is not bound to an agent yet',
    })
    expect(actions.makeTask('invoices', INV, 0, { folderOf: () => '/p' })).toMatchObject({
      ok: false,
      code: 409,
      reason: 'the producer role of invoices is not bound to an agent yet',
    })
    expect(actions.agentWrite('invoices', 'finance', 'inv-70a1', invoice())).toMatchObject({
      ok: false,
      code: 403,
      reason: 'finance is not a producer of invoices',
    })
  })

  it('resolve a conflict, said as an event', () => {
    put('agent-state/finance/silos/invoices/inv-70a1.json', invoice())
    const { actions, kernel } = setup()
    actions.setField('invoices', INV, 'state', 'paid')
    put('agent-state/finance/silos/invoices/inv-70a1.json', invoice({ state: 'partial' }))
    kernel.refresh()
    const r = actions.resolveConflict('invoices', INV, 'state', 'keep-mine')
    expect(r.ok && r.value.record.state).toBe('paid')
    expect(actions.events('invoices', INV).at(-1)!.text).toBe('kept your state over the sync')
  })
})

describe('the producer: agent-record-write and the merged view', () => {
  it('a link the agent planted in its state that leads outside is neither written nor read through (contained-dir.ts)', () => {
    const { actions } = setup()
    const outside = join(base, 'outside')
    mkdirSync(outside, { recursive: true })
    writeFileSync(join(outside, 'hd-new.json'), JSON.stringify(invoice({ id: 'hd-new' })))
    mkdirSync(join(as(), 'finance', 'silos'), { recursive: true })
    symlinkSync(outside, join(as(), 'finance', 'silos', 'invoices'))
    const r = actions.agentWrite('invoices', 'finance', 'hd-new', invoice({ id: 'hd-new' }))
    expect(r).toMatchObject({ ok: false, code: 409, reason: expect.stringContaining('leads outside') })
    expect(readdirSync(outside)).toEqual(['hd-new.json'])
    // and with no directory yet, a link one level up refuses before anything is created
    rmSync(join(as(), 'finance', 'silos'), { recursive: true })
    symlinkSync(outside, join(as(), 'finance', 'silos'))
    expect(actions.agentWrite('invoices', 'finance', 'hd-2', invoice({ id: 'hd-2' }))).toMatchObject({ ok: false, code: 409 })
    expect(readdirSync(outside)).toEqual(['hd-new.json'])
  })

  it('writes its own record in its agent state, validated; never as a non-producer', () => {
    const { actions } = setup()
    const r = actions.agentWrite('invoices', 'finance', 'hd-new', invoice({ id: 'hd-new' }))
    expect(r.ok && r.value.file).toBe(join(as(), 'finance', 'silos', 'invoices', 'hd-new.json'))
    expect(r.ok && r.value.record.identity).toBe('F2026-0412 · Acme SL')
    expect(actions.agentWrite('invoices', 'finance', 'hd-bad', invoice({ id: 'hd-bad', total: '71,00' }))).toMatchObject({
      ok: false,
      code: 422,
      reason: 'total must be money as {amount, currency} (found "71,00")',
    })
    expect(existsSync(join(as(), 'finance', 'silos', 'invoices', 'hd-bad.json'))).toBe(false)
    expect(actions.agentWrite('invoices', 'writer', 'x', invoice({ id: 'x' }))).toMatchObject({
      ok: false,
      code: 403,
      reason: 'writer is not a producer of invoices',
    })
    expect(actions.agentWrite('invoices', 'finance', '../x', {})).toMatchObject({ ok: false, code: 400 })
    expect(actions.events('invoices').map((e) => e.text)).toEqual(['finance wrote hd-new'])
  })

  it('appendOnly sub-kinds merge by writeMerge: the producer never erases a note it did not write', () => {
    const canon = ref('support').spec.kinds.case.examples[0]
    put('agent-state/support/support/cases/canonical-case.json', {
      ...canon,
      notes: [...canon.notes, { at: '2026-10-29T10:00:00Z', by: 'owner', text: 'called the customer' }],
    })
    const { actions } = setup()
    const r = actions.agentWrite('support', 'support', 'canonical-case', { ...canon, notes: [{ at: '2026-10-30T09:00:00Z', by: 'agent', text: 'new' }] })
    expect(r.ok).toBe(true)
    const notes = JSON.parse(readFileSync(join(as(), 'support', 'support', 'cases', 'canonical-case.json'), 'utf8')).notes
    expect(notes.map((n: Json) => n.text)).toEqual(['Customer since March; I propose a prorated refund.', 'called the customer', 'new'])
  })

  it('mergeAppendOnly: union by the declared keys, ordered by the declared key', () => {
    const top = kindsOf(ref('support')).get('case')!
    const out = mergeAppendOnly(
      top,
      { notes: [{ at: 'b', by: 'agent', text: 'x' }] },
      {
        notes: [
          { at: 'a', by: 'owner', text: 'y' },
          { at: 'b', by: 'agent', text: 'x', extra: 1 },
        ],
      },
    )
    expect(out.notes).toEqual([
      { at: 'a', by: 'owner', text: 'y' },
      { at: 'b', by: 'agent', text: 'x' },
    ])
  })

  it("the merged view: base + the owner's overlay, only where its location reads", () => {
    put('agent-state/finance/silos/invoices/inv-70a1.json', invoice())
    put('agent-state/writer/silos/invoices/hd-writer.json', invoice({ id: 'hd-writer' }))
    const { actions } = setup()
    actions.setField('invoices', INV, 'state', 'paid')
    const r = actions.agentMerged('invoices', 'finance')
    expect(r.ok && r.value.map((x) => [x.key, x.raw.state])).toEqual([[INV, 'paid']])
    expect(actions.agentMerged('invoices', 'writer')).toMatchObject({ ok: false, code: 403 })
  })
})

describe('proposals', () => {
  it('the producer proposes; the row says the literal diff; approval runs the action; rejection stays said', () => {
    put('agent-state/finance/silos/invoices/inv-70a1.json', invoice({ due: '2026-01-01' }))
    put('agent-state/finance/silos/invoices/inv-70b2.json', invoice({ id: 'inv-70b2', documentNumber: 'F-2' }))
    const { actions, surfaces } = setup()
    const p = actions.propose('invoices', 'finance', INV, 'state', 'paid', 'the bank shows it')
    if (!p.ok) throw new Error(p.reason)
    expect(p.value).toMatchObject({ status: 'pending', from: 'open', to: 'paid', by: 'finance', note: 'the bank shows it' })
    const row = surfaces.board(Date.now()).needsYou.find((n) => n.reason === 'proposal')!
    expect(row).toMatchObject({
      urgency: 'due',
      text: 'F2026-0412 · Acme SL — set-field state: open → paid · proposed by finance',
      proposal: { id: p.value.id, by: 'finance', field: 'state', from: 'open', to: 'paid' },
    })
    expect(actions.propose('invoices', 'finance', INV, 'total', 1, null)).toMatchObject({ ok: false, code: 403 })
    expect(actions.propose('invoices', 'writer', INV, 'state', 'paid', null)).toMatchObject({ ok: false, code: 403 })

    const ok = actions.decide(p.value.id, 'approve', null)
    expect(ok.ok && ok.value.status).toBe('approved')
    expect(actions.events('invoices', INV).at(-1)!.text).toBe('set-field state: open → paid · proposed by finance · approved by owner')
    expect(surfaces.board(Date.now()).needsYou.some((n) => n.reason === 'proposal')).toBe(false)
    expect(actions.decide(p.value.id, 'approve', null)).toMatchObject({ ok: false, code: 409, reason: 'the proposal is already approved' })

    const q = actions.propose('invoices', 'finance', 'agent:finance/inv-70b2', 'state', 'refunded', null)
    if (!q.ok) throw new Error(q.reason)
    const no = actions.decide(q.value.id, 'reject', 'not yet')
    expect(no.ok && no.value).toMatchObject({ status: 'rejected', reason: 'not yet' })
    expect(actions.events('invoices', 'agent:finance/inv-70b2').at(-1)!.text).toBe(
      'set-field state: open → refunded · proposed by finance · rejected by owner: not yet',
    )
  })
  it('proposals are for owner fields over sync sources', () => {
    put('proj/context/documents/official-request-2026.json', ref('documents').spec.kinds.document.examples[0])
    const proj = `folder:${join(base, 'proj')}`
    const { actions } = setup('approved', { mayRead: (a, loc) => loc === `agent:${a}` || loc === proj })
    expect(actions.propose('documents', 'finance', `${proj}/official-request-2026`, 'state', 'filed', null)).toMatchObject({ ok: false, code: 400 })
    // a folder outside the producer's territory: refused before the lookup (bearer-scope.ts)
    expect(setup().actions.propose('documents', 'finance', `${proj}/official-request-2026`, 'state', 'filed', null)).toMatchObject({ ok: false, code: 403 })
  })
})

// support's kernelectomy: the verbs support-store did by hand
describe('append-item, move-item and the owner stamp (support)', () => {
  const canon = (over: Json = {}): Json => ({ ...ref('support').spec.kinds.case.examples[0], ...over })
  const caseFile = (agent: string, id: string): string => join(base, 'agent-state', agent, 'support', 'cases', `${id}.json`)
  const read = (f: string): Json => JSON.parse(readFileSync(f, 'utf8'))

  it("set-field stamps updatedBy AND its declared stamp (updatedAt) — the producer's reopen rule reads it", () => {
    const f = put('agent-state/support/support/cases/c1.json', canon({ id: 'c1' }))
    const { actions } = setup()
    const before = Date.now()
    expect(actions.setField('support', 'agent:support/c1', 'status', 'closed').ok).toBe(true)
    const v = read(f)
    expect(v).toMatchObject({ status: 'closed', updatedBy: 'owner' })
    expect(Date.parse(v.updatedAt)).toBeGreaterThanOrEqual(before - 1000)
    expect(v.lastActivityAt).toBe('2026-10-28T09:05:00Z') // the activity stays the producer's
  })

  it("append-item: the owner's note is appended (trimmed, at = now, by = owner), the agent's notes kept, the parent stamped", () => {
    const f = put('agent-state/support/support/cases/c1.json', canon({ id: 'c1', mine: 'kept' }))
    const { actions } = setup()
    const r = actions.appendItem('support', 'agent:support/c1', 'notes', { text: '  refund approved  ', by: 'agent', at: 'forged' })
    if (!r.ok) throw new Error(r.reason)
    const v = read(f)
    expect(v.notes).toHaveLength(2)
    expect(v.notes[0]).toEqual(canon().notes[0])
    expect(v.notes[1]).toMatchObject({ text: 'refund approved', by: 'owner' })
    expect(Date.parse(v.notes[1].at)).not.toBeNaN()
    expect(v).toMatchObject({ updatedBy: 'owner', mine: 'kept' })
    expect(actions.events('support', 'agent:support/c1').at(-1)!.text).toBe('added to notes: refund approved')
  })

  it('append-item absorbs a doubled send: same author, same fields, within two minutes — one gesture arriving from two surfaces', () => {
    const f = put('agent-state/support/support/cases/c1.json', canon({ id: 'c1' }))
    const { actions } = setup()
    expect(actions.appendItem('support', 'agent:support/c1', 'notes', { text: 'dog' }).ok).toBe(true)
    const twice = actions.appendItem('support', 'agent:support/c1', 'notes', { text: 'dog' })
    expect(twice.ok).toBe(true) // idempotent no-op, never an error in the owner's face
    expect((read(f).notes as Array<{ text: string }>).filter((n) => n.text === 'dog')).toHaveLength(1)
    // a different text is not a double
    expect(actions.appendItem('support', 'agent:support/c1', 'notes', { text: 'cat' }).ok).toBe(true)
    expect((read(f).notes as Array<{ text: string }>).map((n) => n.text)).toContain('cat')
  })

  it('an identical note OLDER than the window is a repetition, not a double — it appends', () => {
    const stale = new Date(Date.now() - 180_000).toISOString()
    const f = put(
      'agent-state/support/support/cases/c3.json',
      canon({ id: 'c3', notes: [...(canon().notes as unknown[]), { at: stale, by: 'owner', text: 'ping' }] }),
    )
    const { actions } = setup()
    expect(actions.appendItem('support', 'agent:support/c3', 'notes', { text: 'ping' }).ok).toBe(true)
    expect((read(f).notes as Array<{ text: string }>).filter((n) => n.text === 'ping')).toHaveLength(2)
  })

  it('append-item refuses what the manifest does not let: blank, too long, a sub-kind with no such verb', () => {
    put('agent-state/support/support/cases/c1.json', canon({ id: 'c1' }))
    const { actions } = setup()
    expect(actions.appendItem('support', 'agent:support/c1', 'notes', { text: '   ' })).toMatchObject({ ok: false, code: 400, reason: 'text is required' })
    expect(actions.appendItem('support', 'agent:support/c1', 'notes', { text: 'x'.repeat(2001) })).toMatchObject({
      ok: false,
      code: 400,
      reason: 'text must be 1–2000 characters',
    })
    expect(actions.appendItem('support', 'agent:support/c1', 'threads', { subject: 'x' })).toMatchObject({ ok: false, code: 403 })
  })

  it("append-item over freehand notes (a plain string) keeps it as the agent's note", () => {
    const f = put('agent-state/support/support/cases/freehand-case.json', ref('support').spec.kinds.case.examples[1])
    const { actions } = setup()
    const r = actions.appendItem('support', 'agent:support/freehand-case', 'notes', { text: 'called them' })
    if (!r.ok) throw new Error(r.reason)
    expect(read(f).notes).toEqual([
      { at: '', by: 'agent', text: 'asked them for the order number' },
      expect.objectContaining({ by: 'owner', text: 'called them' }),
    ])
  })

  it('move-item: the thread lands in the sibling first, leaves the source, both activities re-derived', () => {
    const t1 = { threadId: 'th1', subject: 'a', lastMessageId: 'm1', lastMessageAt: '2026-10-28T09:00:00Z' }
    const t2 = { threadId: 'th2', subject: 'b', lastMessageId: 'm2', lastMessageAt: '2026-10-29T10:00:00Z' }
    put('agent-state/support/support/cases/c1.json', canon({ id: 'c1', threads: [t1, t2], lastActivityAt: '2026-10-29T10:00:00Z' }))
    put('agent-state/support/support/cases/c2.json', canon({ id: 'c2', threads: [], openedAt: '2026-10-01T00:00:00Z', lastActivityAt: '2026-10-01T00:00:00Z' }))
    const { actions } = setup()
    const r = actions.moveItem('support', 'agent:support/c1/threads/th2', 'agent:support/c2')
    if (!r.ok) throw new Error(r.reason)
    const from = read(caseFile('support', 'c1'))
    const to = read(caseFile('support', 'c2'))
    expect(from.threads.map((t: Json) => t.threadId)).toEqual(['th1'])
    expect(to.threads).toEqual([t2])
    // max(threads.lastMessageAt…, openedAt) — what moveThread's latestActivity did
    expect(from.lastActivityAt).toBe('2026-10-28T09:00:00Z')
    expect(to.lastActivityAt).toBe('2026-10-29T10:00:00Z')
    expect(from.updatedBy).toBe('owner')
    expect(actions.events('support', 'agent:support/c2').at(-1)!.text).toMatch(/^received threads\/th2 from /)
  })

  // review (second round): support's thread lift (meant for a LOOSE
  // threadId on the parent) was applied to every string item of an explicit
  // threads[] list, so a move rewrote "loose-string-item" as
  // {threadId:"",subject:"",…} — the text gone. A write rewrites only the
  // children the gesture touches; an item the reader could not read is
  // written back as it was, and its remark persists.
  it('move-item: a string item of an explicit threads[] the reader cannot read survives intact, its remark kept', () => {
    const t1 = { threadId: 'th1', subject: 'a', lastMessageId: 'm1', lastMessageAt: '2026-10-28T09:00:00Z' }
    const t2 = { threadId: 'th2', subject: 'b', lastMessageId: 'm2', lastMessageAt: '2026-10-29T10:00:00Z' }
    put('agent-state/support/support/cases/c1.json', canon({ id: 'c1', threads: [t1, 'loose-string-item', t2] }))
    put('agent-state/support/support/cases/c2.json', canon({ id: 'c2', threads: ['dest-string', t1] }))
    const { actions, kernel } = setup()
    const before = kernel.reading('support')!.records.find((r) => r.record.id === 'c1')!
    expect(before.remarks.some((m) => m.startsWith('threads[1] is not read'))).toBe(true)
    const r = actions.moveItem('support', 'agent:support/c1/threads/th2', 'agent:support/c2')
    if (!r.ok) throw new Error(r.reason)
    expect(read(caseFile('support', 'c1')).threads).toEqual([t1, 'loose-string-item'])
    expect(read(caseFile('support', 'c2')).threads).toEqual(['dest-string', t1, t2])
    kernel.refresh('support')
    const after = kernel.reading('support')!.records.find((x) => x.record.id === 'c1')!
    expect(after.remarks.some((m) => m.startsWith('threads[1] is not read'))).toBe(true)
  })

  it('a freehand string NOTE (whose lift uses the string) is still read and written as a note', () => {
    const f = put('agent-state/support/support/cases/c1.json', canon({ id: 'c1', notes: ['called them'] }))
    const { actions } = setup()
    expect(actions.appendItem('support', 'agent:support/c1', 'notes', { text: 'again' }).ok).toBe(true)
    expect(read(f).notes).toEqual([{ at: '', by: 'agent', text: 'called them' }, expect.objectContaining({ text: 'again', by: 'owner' })])
  })

  it('move-item is idempotent on a retry after a crash between the two writes (the destination already holds it)', () => {
    const t2 = { threadId: 'th2', subject: 'b', lastMessageId: 'm2', lastMessageAt: '2026-10-29T10:00:00Z' }
    put('agent-state/support/support/cases/c1.json', canon({ id: 'c1', threads: [t2] }))
    put('agent-state/support/support/cases/c2.json', canon({ id: 'c2', threads: [t2] }))
    const { actions } = setup()
    expect(actions.moveItem('support', 'agent:support/c1/threads/th2', 'agent:support/c2').ok).toBe(true)
    expect(read(caseFile('support', 'c2')).threads).toEqual([t2])
    expect(read(caseFile('support', 'c1')).threads).toEqual([])
  })

  it('move-item: a lifted loose thread moves as an explicit one; only to a sibling of the same agent', () => {
    put('agent-state/support/support/cases/freehand-case.json', ref('support').spec.kinds.case.examples[1])
    put('agent-state/support/support/cases/c2.json', canon({ id: 'c2', threads: [] }))
    put('agent-state/writer/support/cases/d1.json', canon({ id: 'd1' }))
    const { actions } = setup()
    expect(actions.moveItem('support', 'agent:support/freehand-case/threads/th_777', 'agent:writer/d1')).toMatchObject({
      ok: false,
      code: 400,
      reason: 'a child moves only to a sibling record — same kind, same place',
    })
    expect(actions.moveItem('support', 'agent:support/freehand-case/threads/nope', 'agent:support/c2')).toMatchObject({ ok: false, code: 404 })
    expect(actions.moveItem('support', 'agent:support/freehand-case/threads/th_777', 'agent:support/c2').ok).toBe(true)
    expect(read(caseFile('support', 'c2')).threads).toEqual([
      { threadId: 'th_777', subject: '', lastMessageId: '', lastMessageAt: '2026-10-21T08:00:00Z', draftId: 'd_8' },
    ])
    expect(read(caseFile('support', 'freehand-case')).threads).toEqual([])
  })

  // review (defect 2): the moved thread was built from the CACHED
  // reading — the agent's newer version of it was lost
  it('move-item moves the thread the source file holds NOW, never the cached reading', () => {
    const t2 = { threadId: 'th2', subject: 'b', lastMessageId: 'm2', lastMessageAt: '2026-10-29T10:00:00Z' }
    const f1 = put('agent-state/support/support/cases/c1.json', canon({ id: 'c1', threads: [t2] }))
    put('agent-state/support/support/cases/c2.json', canon({ id: 'c2', threads: [] }))
    const { actions } = setup()
    // the agent writes a newer version of the thread after the kernel read it
    const newer = { ...t2, subject: 'b — replied', lastMessageId: 'm3', lastMessageAt: '2026-10-30T11:00:00Z', draftId: 'd9' }
    writeFileSync(f1, JSON.stringify({ ...read(f1), threads: [newer] }, null, 2))
    const r = actions.moveItem('support', 'agent:support/c1/threads/th2', 'agent:support/c2')
    if (!r.ok) throw new Error(r.reason)
    expect(read(caseFile('support', 'c2')).threads).toEqual([newer])
    expect(read(caseFile('support', 'c1')).threads).toEqual([])
  })

  it('move-item carries a CAS like append-item: a stale version (source or destination) → 409 and NOTHING is written', () => {
    const t2 = { threadId: 'th2', subject: 'b', lastMessageId: 'm2', lastMessageAt: '2026-10-29T10:00:00Z' }
    const f1 = put('agent-state/support/support/cases/c1.json', canon({ id: 'c1', threads: [t2] }))
    const f2 = put('agent-state/support/support/cases/c2.json', canon({ id: 'c2', threads: [] }))
    const { actions } = setup()
    const seen1 = sha(f1)
    const seen2 = sha(f2)
    writeFileSync(f1, JSON.stringify({ ...read(f1), summary: 'the agent wrote meanwhile' }, null, 2))
    const before1 = readFileSync(f1, 'utf8')
    const before2 = readFileSync(f2, 'utf8')
    expect(actions.moveItem('support', 'agent:support/c1/threads/th2', 'agent:support/c2', { version: seen1 })).toMatchObject({
      ok: false,
      code: 409,
      detail: { version: sha(f1) },
    })
    expect(readFileSync(f1, 'utf8')).toBe(before1)
    expect(readFileSync(f2, 'utf8')).toBe(before2)
    writeFileSync(f2, JSON.stringify({ ...read(f2), summary: 'and here' }, null, 2))
    const after2 = readFileSync(f2, 'utf8')
    expect(actions.moveItem('support', 'agent:support/c1/threads/th2', 'agent:support/c2', { version: sha(f1), toVersion: seen2 })).toMatchObject({
      ok: false,
      code: 409,
    })
    expect(readFileSync(f1, 'utf8')).toBe(before1)
    expect(readFileSync(f2, 'utf8')).toBe(after2)
    // the current versions: it moves
    expect(actions.moveItem('support', 'agent:support/c1/threads/th2', 'agent:support/c2', { version: sha(f1), toVersion: sha(f2) }).ok).toBe(true)
  })

  it('move-item: a thread gone from the source since the reading is refused, nothing written', () => {
    const t2 = { threadId: 'th2', subject: 'b', lastMessageId: 'm2', lastMessageAt: '2026-10-29T10:00:00Z' }
    const f1 = put('agent-state/support/support/cases/c1.json', canon({ id: 'c1', threads: [t2] }))
    const f2 = put('agent-state/support/support/cases/c2.json', canon({ id: 'c2', threads: [] }))
    const { actions } = setup()
    writeFileSync(f1, JSON.stringify({ ...read(f1), threads: [] }, null, 2))
    const before2 = readFileSync(f2, 'utf8')
    expect(actions.moveItem('support', 'agent:support/c1/threads/th2', 'agent:support/c2')).toMatchObject({ ok: false, code: 409 })
    expect(readFileSync(f2, 'utf8')).toBe(before2)
  })

  // review (defect 3): moving INTO a case whose thread is a loose
  // threadId wrote `threads: [moved]` and hid the case's own thread
  it('move-item into a case whose own thread is a loose threadId keeps that thread (destination side)', () => {
    const t2 = { threadId: 'th2', subject: 'b', lastMessageId: 'm2', lastMessageAt: '2026-10-29T10:00:00Z' }
    put('agent-state/support/support/cases/c1.json', canon({ id: 'c1', threads: [t2] }))
    const loose = canon({ id: 'c3', threadId: 'th_loose', updatedAt: '2026-10-25T00:00:00Z' })
    delete loose.threads
    put('agent-state/support/support/cases/c3.json', loose)
    const { actions, kernel } = setup()
    expect((kernel.reading('support')!.records.find((r) => r.record.id === 'c3')!.record.threads as Json[]).map((t) => t.id)).toEqual(['th_loose'])
    const r = actions.moveItem('support', 'agent:support/c1/threads/th2', 'agent:support/c3')
    if (!r.ok) throw new Error(r.reason)
    expect(read(caseFile('support', 'c3')).threads.map((t: Json) => t.threadId)).toEqual(['th_loose', 'th2'])
    expect((r.value.to.record.threads as Json[]).map((t) => t.id)).toEqual(['th_loose', 'th2'])
  })

  it('move-item between two cases whose threads are both loose: the moved one leaves, the other keeps its own (both sides)', () => {
    put('agent-state/support/support/cases/freehand-case.json', ref('support').spec.kinds.case.examples[1])
    const loose = canon({ id: 'c3', thread_id: 'th_loose', updatedAt: '2026-10-25T00:00:00Z' })
    delete loose.threads
    put('agent-state/support/support/cases/c3.json', loose)
    const { actions } = setup()
    const r = actions.moveItem('support', 'agent:support/freehand-case/threads/th_777', 'agent:support/c3')
    if (!r.ok) throw new Error(r.reason)
    expect(read(caseFile('support', 'c3')).threads.map((t: Json) => t.threadId)).toEqual(['th_loose', 'th_777'])
    expect(read(caseFile('support', 'freehand-case')).threads).toEqual([])
    expect(r.value.from.record.threads).toEqual([])
  })

  // review (defect 4): append-item wrote numbers, objects and lists
  // into a field the sub-kind declares as text
  it("append-item refuses a value of the wrong type BEFORE writing, in the reader's own words", () => {
    const f = put('agent-state/support/support/cases/c1.json', canon({ id: 'c1' }))
    const { actions } = setup()
    const before = readFileSync(f, 'utf8')
    expect(actions.appendItem('support', 'agent:support/c1', 'notes', { text: 42 })).toMatchObject({
      ok: false,
      code: 400,
      reason: 'text must be text (found a number)',
    })
    expect(actions.appendItem('support', 'agent:support/c1', 'notes', { text: { a: 1 } })).toMatchObject({
      ok: false,
      code: 400,
      reason: 'text must be text (found an object)',
    })
    expect(actions.appendItem('support', 'agent:support/c1', 'notes', { text: ['x'] })).toMatchObject({
      ok: false,
      code: 400,
      reason: 'text must be text (found an array)',
    })
    expect(actions.appendItem('support', 'agent:support/c1', 'notes', { text: true })).toMatchObject({
      ok: false,
      code: 400,
      reason: 'text must be text (found a boolean)',
    })
    expect(actions.appendItem('support', 'agent:support/c1', 'notes', { text: null })).toMatchObject({ ok: false, code: 400, reason: 'text is required' })
    expect(readFileSync(f, 'utf8')).toBe(before)
  })
})

// NOTE: appendItem births whole sub-kind children when the envelope maps
// id/state to fields — tested in silo-task-create.test.ts
