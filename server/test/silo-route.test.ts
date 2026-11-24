// GET /api/silos — the registry's descriptors (the /api/harnesses pattern):
// registered only with a SiloRegistry injected; owner-only like /api/vault.
import { DIMENSIONS, dimensions, type Dimensions } from '../src/silos/native.js'
import { afterEach, describe, expect, it } from 'vitest'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { claudeSessionIndex } from '../src/harnesses/claude-code/reader.js'
import { AgentRegistry } from '../src/agent-registry.js'
import { SessionStore } from '../src/session-store.js'
import { NativeStore } from '../src/native-store.js'
import { ChatService } from '../src/chat-service.js'
import { ExecService } from '../src/exec-service.js'
import { CompleteService } from '../src/complete-service.js'
import { PrefsStore } from '../src/prefs-store.js'
import { MemoryService } from '../src/memory-service.js'
import { buildServer } from '../src/server.js'
import { SiloRegistry } from '../src/silos/registry.js'
import { createSiloValidate } from '../src/silos/validator.js'
import { SiloKernel } from '../src/silos/kernel.js'
import { SiloSurfaces } from '../src/silos/surfaces.js'
import { TransitionJournal } from '../src/silos/journal.js'
import { SiloReader } from '../src/silos/reader.js'
import { OverlayStore } from '../src/silos/overlay.js'
import { SiloInstaller } from '../src/silos/installer.js'
import { SiloOperatorStore } from '../src/silos/operator.js'
import { SiloActions, SiloAcks, SiloEvents, SiloProposals } from '../src/silos/actions.js'
import { readFileSync } from 'node:fs'
import { siloFile } from './helpers/silo-manifests.js'

const TOKEN = 'testtoken'
let base: string
let app: FastifyInstance

async function build(
  withRegistry: boolean,
  active = false,
  extra: { resident?: unknown; messages?: unknown; dimensions?: Dimensions; agents?: unknown[] } = {},
): Promise<FastifyInstance> {
  base = mkdtempSync(join(tmpdir(), 'silo-route-'))
  const root = join(base, 'projects')
  const dataDir = join(base, 'data')
  mkdirSync(root, { recursive: true })
  mkdirSync(join(dataDir, 'trash'), { recursive: true })
  const index = claudeSessionIndex(root, join(dataDir, 'cache.json'))
  await index.init()
  if (extra.agents) writeFileSync(join(dataDir, 'agents.json'), JSON.stringify({ agents: extra.agents }))
  const registry = new AgentRegistry(join(dataDir, 'agents.json'))
  registry.load()
  const native = new NativeStore(join(dataDir, 'native.json'))
  const chat = new ChatService({
    registry,
    native,
    queryFn: () => ({
      async *[Symbol.asyncIterator]() {},
      async interrupt() {
        return undefined
      },
    }),
  })
  let siloRegistry: SiloRegistry | undefined
  let siloKernel: SiloKernel | undefined
  let siloSurfaces: SiloSurfaces | undefined
  let siloJournal: TransitionJournal | undefined
  let siloActions: SiloActions | undefined
  let siloInstaller: SiloInstaller | undefined
  let siloOperator: SiloOperatorStore | undefined
  if (withRegistry) {
    mkdirSync(join(dataDir, 'silos', 'registry', 'invoices'), { recursive: true })
    copyFileSync(siloFile('invoices'), join(dataDir, 'silos', 'registry', 'invoices', 'silo.json'))
    siloOperator = new SiloOperatorStore(join(dataDir, 'silos'))
    siloRegistry = new SiloRegistry({ dataDir, operator: active ? { decisionFor: () => 'approved' as const, slotsOff: () => [] } : siloOperator })
    siloRegistry.load()
    const inv = join(dataDir, 'agent-state', 'finance', 'silos', 'invoices')
    mkdirSync(inv, { recursive: true })
    writeFileSync(
      join(inv, 'a1.json'),
      JSON.stringify({ ...JSON.parse(readFileSync(siloFile('invoices'), 'utf8')).spec.kinds.invoice.examples[0], id: 'a1', due: '2026-01-01' }),
    )
    siloJournal = new TransitionJournal(siloRegistry.conventionsDir)
    siloKernel = new SiloKernel({
      registry: siloRegistry,
      journal: siloJournal,
      overlay: new OverlayStore(siloRegistry.conventionsDir),
      reader: new SiloReader({ agentStates: () => [{ agentId: 'finance', dir: join(dataDir, 'agent-state', 'finance') }], projects: () => [] }),
    })
    siloKernel.refresh()
    siloActions = new SiloActions({
      registry: siloRegistry,
      kernel: siloKernel,
      events: new SiloEvents(siloRegistry.root),
      acks: new SiloAcks(siloRegistry.root),
      proposals: new SiloProposals(siloRegistry.root),
      agentStateBase: join(dataDir, 'agent-state'),
      isAgent: (v) => v === 'finance',
      agentMayReadLocation: (a, l) => l === `agent:${a}`,
      producersOf: (id) => (active ? (({ invoices: ['finance'] } as Record<string, string[]>)[id] ?? null) : siloOperator!.producersOf(id)),
      ...(extra.messages ? { messages: extra.messages as never } : {}),
    })
    siloInstaller = new SiloInstaller({
      root: siloRegistry.root,
      registry: siloRegistry,
      operator: siloOperator,
      kernel: siloKernel,
      events: new SiloEvents(siloRegistry.root),
      locations: { agentStates: () => [{ agentId: 'finance', dir: join(dataDir, 'agent-state', 'finance') }], projects: () => [] },
      agentStateBase: join(dataDir, 'agent-state'),
      isAgent: (v) => v === 'finance',
      hasBearer: () => true,
      territoriesOf: () => [],
      ...(extra.dimensions ? { dimensions: extra.dimensions } : {}),
    })
    siloSurfaces = new SiloSurfaces({
      registry: siloRegistry,
      kernel: siloKernel,
      journal: siloJournal,
      proposals: (id) => siloActions!.proposalsNeedsYou(id),
      submissions: () => siloInstaller!.needsYou(),
    })
  }
  return buildServer({
    index,
    registry,
    store: new SessionStore(root, dataDir),
    native,
    chat,
    exec: new ExecService(registry),
    complete: new CompleteService(registry, index),
    prefs: new PrefsStore(dataDir),
    memory: new MemoryService(root, dataDir, registry),
    token: TOKEN,
    liveMs: 120_000,
    ...(extra.resident ? { resident: extra.resident as never } : {}),
    ...(siloRegistry
      ? {
          siloRegistry,
          siloKernel,
          siloSurfaces,
          siloJournal,
          siloActions,
          siloInstaller,
          siloOperator,
          siloValidate: createSiloValidate({ registry: siloRegistry, agentStateBase: join(dataDir, 'agent-state') }),
        }
      : {}),
  })
}

afterEach(async () => {
  await app?.close()
  rmSync(base, { recursive: true, force: true })
})

describe('GET /api/silos', () => {
  it('lists one descriptor per silo, painted without asking by name', async () => {
    app = await build(true)
    const res = await app.inject({ url: '/api/silos', headers: { 'x-token': TOKEN } })
    expect(res.statusCode).toBe(200)
    const { silos } = res.json() as { silos: Array<Record<string, unknown>> }
    expect(silos).toHaveLength(1)
    expect(silos[0]).toMatchObject({
      id: 'invoices',
      name: 'Invoices',
      version: '0.1.0',
      apiVersion: 'silo-standard/v0',
      state: 'pending',
      reason: 'waiting for the owner to approve it',
      conventions: [{ source: 'invoices', convention: 'agent-state:silos/invoices' }],
      wants: [],
      kinds: ['invoices/invoice'],
      producer: { role: 'finance', sync: 'Invoicing' },
      records: { parsed: 1, failed: 0 },
      slots: { requested: ['pulse', 'needs-you', 'agent-section'], granted: [], off: [] },
    })
  })
  it('POST /api/silos/validate answers the checks and the preview', async () => {
    app = await build(true)
    const manifest = JSON.parse(readFileSync(siloFile('documents'), 'utf8'))
    const ok = await app.inject({ method: 'POST', url: '/api/silos/validate', headers: { 'x-token': TOKEN }, payload: { manifest } })
    expect(ok.statusCode).toBe(200)
    expect(ok.json()).toMatchObject({ ok: true, id: 'documents', errors: [], preview: { from: 'examples' } })
    const bad = await app.inject({
      method: 'POST',
      url: '/api/silos/validate',
      headers: { 'x-token': TOKEN },
      payload: { manifest: { ...manifest, metadata: { ...manifest.metadata, id: 'invoices' } } },
    })
    // invoices is installed in this server (pending, never approved): an update, not a reserved id
    expect(bad.json().errors.filter((e: { check: number }) => e.check === 2)).toEqual([])
    expect((await app.inject({ method: 'POST', url: '/api/silos/validate', headers: { 'x-token': TOKEN }, payload: {} })).statusCode).toBe(400)
  })
  it('with no active silo, /api/board is exactly as before: no silo rows, no silos block', async () => {
    app = await build(true, false)
    const b = (await app.inject({ url: '/api/board', headers: { 'x-token': TOKEN } })).json()
    expect(b.silos).toBeUndefined()
    expect(b.needsYou.filter((n: { kind: string }) => n.kind === 'silo')).toEqual([])
  })
  it('an active silo: its rows in needsYou, its pulse in the silos block; the records routes', async () => {
    app = await build(true, true)
    const b = (await app.inject({ url: '/api/board', headers: { 'x-token': TOKEN } })).json()
    expect(b.silos.pulse).toEqual([{ silo: 'invoices', siloName: 'Invoices', term: '€465.51 outstanding' }])
    expect(b.needsYou.filter((n: { kind: string }) => n.kind === 'silo').map((n: { key: string }) => n.key)).toEqual(['agent:finance/a1'])
    const page = (await app.inject({ url: '/api/silos/invoices/records?limit=10&facet.state=open', headers: { 'x-token': TOKEN } })).json()
    expect(page).toMatchObject({ total: 1, matching: 1, said: null, records: [{ key: 'agent:finance/a1' }] })
    const rec = await app.inject({ url: `/api/silos/invoices/record?key=${encodeURIComponent('agent:finance/a1')}`, headers: { 'x-token': TOKEN } })
    expect(rec.json()).toMatchObject({ record: { id: 'a1' }, history: [{ event: 'baseline' }] })
    expect((await app.inject({ url: '/api/silos/invoices/record?key=nope', headers: { 'x-token': TOKEN } })).statusCode).toBe(404)
    expect((await app.inject({ url: '/api/silos/nope/records', headers: { 'x-token': TOKEN } })).statusCode).toBe(404)
    expect((await app.inject({ url: '/api/silos/invoices/records?folded=maybe', headers: { 'x-token': TOKEN } })).statusCode).toBe(400)
  })
  // plans phase 1 (G9): a page that knows the FILE (the column's PlanView,
  // the FileViewer) asks for its record by path — resolved against the
  // reading, never by touching the path
  it('the record by its file: ?file=<absolute path> answers like ?key=, on the record and the records routes', async () => {
    app = await build(true, true)
    const H = { 'x-token': TOKEN }
    const file = join(base, 'data', 'agent-state', 'finance', 'silos', 'invoices', 'a1.json')
    const byFile = await app.inject({ url: `/api/silos/invoices/record?file=${encodeURIComponent(file)}`, headers: H })
    expect(byFile.statusCode).toBe(200)
    expect(byFile.json()).toMatchObject({ record: { id: 'a1', key: 'agent:finance/a1', file } })
    expect((await app.inject({ url: `/api/silos/invoices/record?file=${encodeURIComponent(join(base, 'nope.json'))}`, headers: H })).statusCode).toBe(404)
    expect((await app.inject({ url: '/api/silos/invoices/record?file=relative.json', headers: H })).statusCode).toBe(400)
    expect((await app.inject({ url: '/api/silos/invoices/record', headers: H })).statusCode).toBe(400)
    // G12: a file no location holds, whose name the source's pattern names —
    // read by its path for the owner, said outside, read-only
    const elsewhere = join(base, 'elsewhere', 'z9.json')
    mkdirSync(join(base, 'elsewhere'), { recursive: true })
    writeFileSync(elsewhere, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), id: 'z9' }))
    const out = await app.inject({ url: `/api/silos/invoices/record?file=${encodeURIComponent(elsewhere)}`, headers: H })
    expect(out.statusCode).toBe(200)
    expect(out.json()).toMatchObject({
      outside: true,
      version: null,
      actions: [],
      record: { id: 'z9', key: 'outside/z9', file: elsewhere },
      value: { id: 'z9' },
    })
    writeFileSync(join(base, 'elsewhere', 'bad.json'), '{ not json')
    const bad = await app.inject({ url: `/api/silos/invoices/record?file=${encodeURIComponent(join(base, 'elsewhere', 'bad.json'))}`, headers: H })
    expect(bad.statusCode).toBe(422)
    expect(byFile.json().value).toMatchObject({ id: 'a1', state: 'open' })
    const page = (await app.inject({ url: `/api/silos/invoices/records?file=${encodeURIComponent(file)}`, headers: H })).json()
    expect(page).toMatchObject({ matching: 1, records: [{ key: 'agent:finance/a1' }] })
    expect((await app.inject({ url: `/api/silos/invoices/records?file=${encodeURIComponent('/elsewhere.json')}`, headers: H })).json()).toMatchObject({
      matching: 0,
    })
  })
  it('?values=1 carries each record as read and its journal moment; the record says who wrote its file (none here)', async () => {
    app = await build(true, true)
    const H = { 'x-token': TOKEN }
    const plain = (await app.inject({ url: '/api/silos/invoices/records', headers: H })).json()
    expect(plain.records[0].value).toBeUndefined()
    const page = (await app.inject({ url: '/api/silos/invoices/records?values=1', headers: H })).json()
    expect(page.records[0]).toMatchObject({ key: 'agent:finance/a1', value: { id: 'a1', state: 'open' } })
    expect('moved' in page.records[0]).toBe(true)
    const d = (await app.inject({ url: `/api/silos/invoices/record?key=${encodeURIComponent('agent:finance/a1')}`, headers: H })).json()
    expect(d.writtenBy).toEqual([])
  })
  it("the action routes: set-field, the record's events, proposals by the producer and the owner's decision", async () => {
    app = await build(true, true)
    const H = { 'x-token': TOKEN }
    const set = await app.inject({
      method: 'POST',
      url: '/api/silos/invoices/record/set-field',
      headers: H,
      payload: { key: 'agent:finance/a1', field: 'state', value: 'partial' },
    })
    expect(set.statusCode).toBe(200)
    expect(set.json().record.state).toBe('partial')
    const rec = (await app.inject({ url: `/api/silos/invoices/record?key=${encodeURIComponent('agent:finance/a1')}`, headers: H })).json()
    expect(rec.events.map((e: { text: string }) => e.text)).toEqual(['set-field state: open → partial (held over the sync)'])
    expect(
      (await app.inject({ method: 'POST', url: '/api/silos/invoices/record/set-field', headers: H, payload: { key: 'agent:finance/a1' } })).statusCode,
    ).toBe(400)
    const prop = await app.inject({
      method: 'POST',
      url: '/api/silos/invoices/agents/finance/proposals',
      headers: H,
      payload: { recordId: 'a1', field: 'state', value: 'paid' },
    })
    expect(prop.statusCode).toBe(201)
    const pid = prop.json().proposal.id
    expect((await app.inject({ url: '/api/silos/invoices/proposals', headers: H })).json().proposals[0]).toMatchObject({ id: pid, status: 'pending' })
    expect((await app.inject({ method: 'POST', url: `/api/silos/invoices/proposals/${pid}/approve`, headers: H })).json()).toMatchObject({ status: 'approved' })
    expect((await app.inject({ method: 'POST', url: `/api/silos/invoices/proposals/${pid}/maybe`, headers: H })).statusCode).toBe(404)
    const merged = (await app.inject({ url: '/api/silos/invoices/agents/finance/merged', headers: H })).json()
    expect(merged.records[0]).toMatchObject({ key: 'agent:finance/a1', raw: { state: 'paid' } })
  })
  it("a write stamps the speaker the request names, never the body — an agent saying who it is writes as itself; respond is the owner's only", async () => {
    app = await build(true, true, { agents: [{ id: 'finance', name: 'Finance', folder: null, createdAt: '2026-01-01T00:00:00Z' }] })
    const H = { 'x-token': TOKEN }
    const set = await app.inject({
      method: 'POST',
      url: '/api/silos/invoices/record/set-field',
      headers: { ...H, 'x-silos-agent': 'finance' },
      payload: { key: 'agent:finance/a1', field: 'state', value: 'partial', by: 'owner' },
    })
    expect(set.statusCode).toBe(200)
    const rec = (await app.inject({ url: `/api/silos/invoices/record?key=${encodeURIComponent('agent:finance/a1')}`, headers: H })).json()
    expect(rec.events.map((e: { by: string }) => e.by)).toEqual(['finance'])
    // without the header: the owner, as before
    await app.inject({
      method: 'POST',
      url: '/api/silos/invoices/record/set-field',
      headers: H,
      payload: { key: 'agent:finance/a1', field: 'state', value: 'open' },
    })
    const rec2 = (await app.inject({ url: `/api/silos/invoices/record?key=${encodeURIComponent('agent:finance/a1')}`, headers: H })).json()
    expect(rec2.events.map((e: { by: string }) => e.by)).toEqual(['finance', 'owner'])
    // an unknown name in the header is the owner (authorOf), a known agent may not answer a gate
    const respond = await app.inject({
      method: 'POST',
      url: '/api/silos/invoices/record/respond',
      headers: { ...H, 'x-silos-agent': 'finance' },
      payload: { key: 'agent:finance/a1', text: 'OK, ship it' },
    })
    expect(respond.statusCode).toBe(403)
  })
  it("the dialog's routes: submit → pending, consequences, approve → active, uninstall, the operator export", async () => {
    app = await build(true, false)
    const H = { 'x-token': TOKEN }
    const docs = JSON.parse(readFileSync(siloFile('documents'), 'utf8'))
    const sub = await app.inject({ method: 'POST', url: '/api/silos/submissions', headers: H, payload: { manifest: docs } })
    expect(sub.statusCode).toBe(201)
    expect((await app.inject({ url: '/api/silos/submissions', headers: H })).json().submissions.map((x: { id: string }) => x.id)).toEqual(['documents'])
    const c = (await app.inject({ url: '/api/silos/submissions/documents/consequences', headers: H })).json()
    // nobody named: Silos proposes nobody (a role is never an agent id) — the owner binds here
    expect(c).toMatchObject({ kind: 'install', derived: { proposedProducers: [], preview: { from: 'examples' } } })
    const ok = await app.inject({ method: 'POST', url: '/api/silos/submissions/documents/approve', headers: H, payload: { producers: ['finance'] } })
    expect(ok.statusCode).toBe(200)
    const list = (await app.inject({ url: '/api/silos', headers: H })).json().silos
    expect(list.find((d: { id: string }) => d.id === 'documents')).toMatchObject({ state: 'active', producers: ['finance'] })
    expect((await app.inject({ url: '/api/silos/operator', headers: H })).json()).toMatchObject({
      version: 1,
      silos: { documents: { decision: 'approved', producers: ['finance'] } },
    })
    expect(
      (await app.inject({ method: 'PATCH', url: '/api/silos/documents/operator', headers: H, payload: { slotsOff: ['project-machinery'] } })).statusCode,
    ).toBe(200)
    // Task mode's producers are DERIVED from each agent's control
    const tm = await app.inject({ method: 'PATCH', url: '/api/silos/task-mode/operator', headers: H, payload: { producers: ['finance'] } })
    expect(tm.statusCode).toBe(409)
    expect(tm.json().error).toBe("who moves on its own is each agent's control — set it on the agent's page")
    const un = await app.inject({ method: 'POST', url: '/api/silos/documents/uninstall', headers: H })
    expect(un.json()).toMatchObject({ uninstalled: 'documents', producers: ['finance'] })
    expect((await app.inject({ method: 'POST', url: '/api/silos/submissions/nope/approve', headers: H })).statusCode).toBe(404)
  })
  it('a pending submission rides Needs you with zero active silos — and leaves with the decision', async () => {
    app = await build(true, false)
    const H = { 'x-token': TOKEN }
    const docs = JSON.parse(readFileSync(siloFile('documents'), 'utf8'))
    await app.inject({ method: 'POST', url: '/api/silos/submissions', headers: H, payload: { manifest: docs } })
    const b = (await app.inject({ url: '/api/board', headers: H })).json()
    expect(b.needsYou.filter((n: { kind: string }) => n.kind === 'silo')).toEqual([
      expect.objectContaining({
        reason: 'submission',
        silo: 'documents',
        siloName: 'Documents',
        key: 'submission',
        text: '0.1.0 waits for your approval to install — submitted by you',
        submission: expect.objectContaining({ kind: 'install' }),
      }),
    ])
    // the silos block is present (needsYou is not empty) but carries no pulse / done of its own
    expect(b.silos).toEqual({ pulse: [], done: [] })
    expect((await app.inject({ method: 'POST', url: '/api/silos/submissions/documents/reject', headers: H, payload: { reason: 'later' } })).statusCode).toBe(
      200,
    )
    const after = (await app.inject({ url: '/api/board', headers: H })).json()
    expect(after.silos).toBeUndefined()
    expect(after.needsYou.filter((n: { kind: string }) => n.kind === 'silo')).toEqual([])
  })
  it('consequences ?producers= re-derives for the binding the owner weighs; an unknown id is 400', async () => {
    app = await build(true, false)
    const H = { 'x-token': TOKEN }
    const docs = JSON.parse(readFileSync(siloFile('documents'), 'utf8'))
    await app.inject({ method: 'POST', url: '/api/silos/submissions', headers: H, payload: { manifest: docs } })
    const none = (await app.inject({ url: '/api/silos/submissions/documents/consequences?producers=', headers: H })).json()
    expect(none.derived).toMatchObject({ proposedProducers: [], forProducers: [] })
    const finance = (await app.inject({ url: '/api/silos/submissions/documents/consequences?producers=finance', headers: H })).json()
    expect(finance.derived.forProducers).toEqual(['finance'])
    const bad = await app.inject({ url: '/api/silos/submissions/documents/consequences?producers=finance,ghost', headers: H })
    expect(bad.statusCode).toBe(400)
    expect(bad.json().error).toBe('not agents: ghost')
  })
  it('the list descriptor types its columns: money is money (the page right-aligns it)', async () => {
    app = await build(true, true)
    const page = (await app.inject({ url: '/api/silos/invoices/records', headers: { 'x-token': TOKEN } })).json()
    expect(page.kind.columns).toEqual(['identity', 'state', 'total', 'due', 'at'])
    expect(page.kind.columnTypes).toMatchObject({ total: 'money', due: 'timestamp', at: 'timestamp', state: 'state' })
  })
  // no message wakes anyone — `urgent` is a 400
  // that says why; «Wake the producer now» became make-task
  it("a silo message waits in the inbox; `urgent` is refused with its words; make-task is the owner's and needs the producer's folder", async () => {
    const sent: Array<Record<string, unknown>> = []
    const messages = {
      send: (m: Record<string, unknown>) => {
        sent.push(m)
        return { id: `m${sent.length}` }
      },
    }
    app = await build(true, true, { messages })
    const H = { 'x-token': TOKEN }
    const plain = await app.inject({ method: 'POST', url: '/api/silos/invoices/record/message', headers: H, payload: { key: 'agent:finance/a1', template: 0 } })
    expect(plain.statusCode).toBe(200)
    expect(plain.json()).not.toHaveProperty('wakes')
    expect(sent).toEqual([expect.not.objectContaining({ urgent: expect.anything() })])
    const urgent = await app.inject({
      method: 'POST',
      url: '/api/silos/invoices/record/message',
      headers: H,
      payload: { key: 'agent:finance/a1', template: 0, urgent: true },
    })
    expect(urgent.statusCode).toBe(400)
    expect(urgent.json().error).toBe(
      "messages have no urgency any more: to move work now, assign your own task (POST /api/tasks/assign) or leave it to the owner's gesture",
    )
    expect(sent).toHaveLength(1)
    // no agent «finance» in the roster: no folder to put its task in
    const task = await app.inject({
      method: 'POST',
      url: '/api/silos/invoices/record/make-task',
      headers: H,
      payload: { key: 'agent:finance/a1', template: 0 },
    })
    expect(task.statusCode).toBe(409)
    expect(task.json().error).toBe("finance has no folder — a task lives in its owner's project")
    expect(
      (await app.inject({ method: 'POST', url: '/api/silos/invoices/record/make-task', payload: { key: 'agent:finance/a1', template: 0 } })).statusCode,
    ).toBe(401)
  })
  it("Settings › Silos reads GET /api/silos: submission and automation per silo, the uninstalled ones; resubmit lands on the dialog's routes", async () => {
    app = await build(true, false)
    const H = { 'x-token': TOKEN }
    const docs = JSON.parse(readFileSync(siloFile('documents'), 'utf8'))
    await app.inject({ method: 'POST', url: '/api/silos/submissions', headers: H, payload: { manifest: docs } })
    await app.inject({ method: 'POST', url: '/api/silos/submissions/documents/approve', headers: H, payload: { producers: ['finance'] } })
    await app.inject({ method: 'POST', url: '/api/silos/documents/uninstall', headers: H })

    const body = (await app.inject({ url: '/api/silos', headers: H })).json()
    // invoices sits pending in the registry with no submission: the case Settings offers «Submit for approval…» for
    expect(body.silos).toEqual([expect.objectContaining({ id: 'invoices', state: 'pending', submission: null, automation: null, producers: null })])
    expect(body.uninstalled).toEqual([
      expect.objectContaining({
        id: 'documents',
        name: 'Documents',
        producers: ['finance'],
        grown: 0,
        submission: null,
        automation: null,
        kept: expect.objectContaining({ files: 0, conventions: ['project:context/documents'] }),
        manifest: expect.objectContaining({ version: '0.1.0' }),
      }),
    ])

    const re = await app.inject({ method: 'POST', url: '/api/silos/documents/resubmit', headers: H })
    expect(re.statusCode).toBe(201)
    expect(re.json()).toMatchObject({ submission: { id: 'documents', submittedBy: 'owner', state: 'pending' } })
    expect((await app.inject({ url: '/api/silos/submissions/documents/consequences', headers: H })).json().kind).toBe('reinstall')
    const dup = await app.inject({ method: 'POST', url: '/api/silos/documents/resubmit', headers: H })
    expect(dup.statusCode).toBe(409)
    expect(dup.json()).toMatchObject({ submission: { id: 'documents' } })
    expect((await app.inject({ url: '/api/silos', headers: H })).json().uninstalled[0].submission).toMatchObject({ submittedBy: 'owner', version: '0.1.0' })

    expect((await app.inject({ method: 'POST', url: '/api/silos/invoices/resubmit', headers: H })).statusCode).toBe(201)
    expect((await app.inject({ url: '/api/silos/submissions/invoices/consequences', headers: H })).json().kind).toBe('install')
    expect((await app.inject({ url: '/api/silos', headers: H })).json().silos[0].submission).toMatchObject({ submittedBy: 'owner' })
    expect((await app.inject({ method: 'POST', url: '/api/silos/ghost/resubmit', headers: H })).statusCode).toBe(404)
  })
  it('a dimension Silos serves natively never enters (silos/native.ts): not Available, every door answers 409 with the words, rows say it', async () => {
    // no house dimension is native any more (executions was the last):
    // a fixture table where executions still is keeps the door honest
    app = await build(true, false, { dimensions: dimensions([...DIMENSIONS, { id: 'executions', name: 'Executions', served: 'native' as const }]) })
    const H = { 'x-token': TOKEN }
    const words = 'Executions comes with Silos — it already runs natively; it becomes a silo when Silos migrates it'
    const body = (await app.inject({ url: '/api/silos', headers: H })).json()
    expect(body.available.map((a: { id: string }) => a.id)).toEqual(['heather', 'hierarchy', 'support'])
    // every descriptor says how it came and whether a door is refused
    // (invoices is a fixture: a silo of the owner's own — no lineup)
    expect(body.silos[0]).toMatchObject({ id: 'invoices', provenance: null, native: null, lineup: null, loses: null })
    const cat = await app.inject({ method: 'POST', url: '/api/silos/available/executions/submit', headers: H })
    expect(cat.statusCode).toBe(409)
    expect(cat.json()).toEqual({ error: words, native: true })
    const plans = JSON.parse(readFileSync(siloFile('plans'), 'utf8'))
    plans.metadata.id = 'executions'
    const sub = await app.inject({ method: 'POST', url: '/api/silos/submissions', headers: H, payload: { manifest: plans } })
    expect(sub.statusCode).toBe(409)
    expect(sub.json()).toEqual({ error: words, native: true })
    const re = await app.inject({ method: 'POST', url: '/api/silos/executions/resubmit', headers: H })
    expect(re.statusCode).toBe(409)
    expect(re.json()).toEqual({ error: words, native: true })
    expect((await app.inject({ url: '/api/silos/submissions', headers: H })).json().submissions).toEqual([])
  })
  it('is not registered without a registry', async () => {
    app = await build(false)
    expect((await app.inject({ url: '/api/silos', headers: { 'x-token': TOKEN } })).statusCode).toBe(404)
  })
})
