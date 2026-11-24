// The producer contract (Silo Standard step 1, Task 12): the producer brief
// reaches only bound producers of active silos, on both engines' append; the
// automation prompt instructs the flow and the credential by NAME from the
// env; and the REHEARSAL — a minimal producer (inline below) writing a
// fixture silo's records against the REAL routes with a real bearer: the
// kernel refuses a broken record, a second pass writes nothing, the owner's
// overlay stands over the sync until the service reaches it.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
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
import { AgentTokens } from '../src/agent-tokens.js'
import { buildServer } from '../src/server.js'
import { liveTurnOf } from './helpers/live-turn.js'
import { SiloRegistry } from '../src/silos/registry.js'
import { SiloReader } from '../src/silos/reader.js'
import { SiloKernel } from '../src/silos/kernel.js'
import { TransitionJournal } from '../src/silos/journal.js'
import { OverlayStore } from '../src/silos/overlay.js'
import { SiloOperatorStore } from '../src/silos/operator.js'
import { SiloInstaller, syncPrompt } from '../src/silos/installer.js'
import { SiloActions, SiloAcks, SiloEvents, SiloProposals } from '../src/silos/actions.js'
import { credentialsLine, producerBriefFor } from '../src/silos/producer-brief.js'
import { siloManifest } from './helpers/silo-manifests.js'

type Json = Record<string, any>
const ref = (id: string): Json => siloManifest(id) as Json

let base: string
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'silo-producer-'))
})
afterEach(() => rmSync(base, { recursive: true, force: true }))

// A minimal producer: what any producer does against the kernel's routes —
// read the merged view, write only the records whose base (the file, the
// owner's overlay put back) differs from the service's value, one PUT per
// record with its bearer and the turn it runs in. The contract under test is
// the routes' answers, not a script.
type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{ ok: boolean; status: number; json: () => Promise<any> }>
const canon = (v: unknown): unknown =>
  Array.isArray(v)
    ? v.map(canon)
    : v && typeof v === 'object'
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, canon((v as Json)[k])]),
        )
      : v
function baseOf(entry: Json): Json {
  const raw: Json = { ...(entry.raw ?? {}) }
  for (const [field, o] of Object.entries((entry.overlay ?? {}) as Json)) {
    if (o && typeof o === 'object' && 'base' in o) {
      if (o.base === undefined) delete raw[field]
      else raw[field] = o.base
    }
  }
  return raw
}
async function produce(o: { records: Json[]; siloId: string; agentId: string; token: string; turn: string; fetchImpl: FetchLike }) {
  const h = { authorization: `Bearer ${o.token}`, 'content-type': 'application/json' }
  const at = `http://127.0.0.1:3210/api/silos/${o.siloId}/agents/${o.agentId}`
  const view = await (await o.fetchImpl(`${at}/merged`, { headers: h })).json()
  const byId = new Map<string, Json>(((view.records ?? []) as Json[]).map((m) => [m.id as string, m]))
  const out = { written: 0, unchanged: 0, rejected: [] as Array<{ id: string; status: number; reason: string }> }
  for (const record of o.records) {
    const cur = byId.get(record.id)
    if (cur && JSON.stringify(canon(baseOf(cur))) === JSON.stringify(canon(record))) {
      out.unchanged++
      continue
    }
    const r = await o.fetchImpl(`${at}/records/${encodeURIComponent(record.id)}`, { method: 'PUT', headers: h, body: JSON.stringify({ record, turn: o.turn }) })
    if (r.ok) out.written++
    else out.rejected.push({ id: record.id, status: r.status, reason: ((await r.json().catch(() => ({}))) as Json).error ?? '' })
  }
  return out
}
// the service's records, already normalized: every state, two currencies,
// one exported without its contact (the kernel says why)
function serviceRecords(): Json[] {
  const ex = ref('invoices').spec.kinds.invoice.examples[0] as Json
  const r = (id: string, over: Json): Json => JSON.parse(JSON.stringify({ ...ex, id, ...over })) as Json
  const out = [
    r('inv-1', { state: 'draft' }),
    r('inv-2', { state: 'open', kind: 'sale', due: '2026-10-20', dueDerived: true }),
    r('inv-3', { state: 'partial', total: { amount: 50, currency: 'USD' } }),
    r('inv-4', { state: 'paid', kind: 'purchase' }),
    r('inv-5', { state: 'refunded', kind: 'refund', documentNumber: null }),
    r('inv-6', {}),
  ]
  delete out[5]!.contactName
  return out
}

describe("the producer brief — only bound producers of active silos, on both engines' append", () => {
  function chatWith(brief: (id: string) => string | null): ChatService {
    const registry = new AgentRegistry(join(mkdtempSync(join(base, 'reg-')), 'agents.json'))
    registry.load()
    registry.create({ id: 'finance', name: 'Finance', folder: join(base, 'finance') })
    return new ChatService({
      registry,
      native: new NativeStore(join(base, 'native.json')),
      queryFn: () => ({
        async *[Symbol.asyncIterator]() {},
        async interrupt() {
          return undefined
        },
      }),
      producerBriefFor: brief,
    })
  }
  function silos(decision: 'approved' | null) {
    const dataDir = join(base, 'data')
    const operator = new SiloOperatorStore(join(dataDir, 'silos'))
    mkdirSync(join(dataDir, 'silos', 'registry', 'invoices'), { recursive: true })
    writeFileSync(join(dataDir, 'silos', 'registry', 'invoices', 'silo.json'), JSON.stringify(ref('invoices')))
    if (decision) operator.set('invoices', { decision, producers: ['finance'], slotsOff: [], decidedAt: 'x' })
    const registry = new SiloRegistry({ dataDir, operator })
    registry.load()
    return { registry, operator }
  }

  it('no active silo bound: the append is byte-identical to before', () => {
    const { registry, operator } = silos(null)
    const before = chatWith(() => null).systemAppendFor('finance', [])
    expect(producerBriefFor('finance', [], { registry, operator })).toBeNull()
    expect(chatWith((id) => producerBriefFor(id, [], { registry, operator })).systemAppendFor('finance', [])).toBe(before)
  })

  it("an ARCHIVED bound producer is briefed as no silo's producer; reactivated → briefed again", () => {
    const { registry, operator } = silos('approved')
    const archived = new Set(['finance'])
    const inPlay = (a: string): boolean => !archived.has(a)
    expect(producerBriefFor('finance', [], { registry, operator, inPlay })).toBeNull()
    archived.delete('finance')
    expect(producerBriefFor('finance', [], { registry, operator, inPlay })).toContain('# Silos')
  })

  it("a bound producer of an active silo carries the manifest's instructions, contract, stateMap, the kernel's routes and its credential by name", () => {
    const { registry, operator } = silos('approved')
    const brief = producerBriefFor('finance', [], {
      registry,
      operator,
      credentialNames: () => [
        { name: 'INVOICING_API_KEY', signed: false },
        { name: 'GITHUB_TOKEN', signed: false },
      ],
    })!
    expect(brief).toContain('## Silo you produce: Invoices (invoices)')
    expect(brief).toContain('Every day: produce the export of your invoicing service')
    expect(brief).toContain('- Idempotent: same service id → same file')
    expect(brief).toContain('State map (export → state): draft=true → draft · status=pending → open')
    expect(brief).toContain('Your records live at $SILOS_AGENT_STATE/silos/invoices/*.json — one record per file.')
    expect(brief).toContain('${SILOS_API:-http://127.0.0.1:3210}/api/silos/invoices/agents/$SILOS_AGENT_ID/merged')
    expect(brief).toContain('/api/silos/invoices/agents/$SILOS_AGENT_ID/records/<id>')
    expect(brief).toContain('/proposals')
    expect(brief).toContain(
      'Credentials: read INVOICING_API_KEY from your environment — the Vault puts it there. Never read ~/secrets or any file for them, never ask anyone for them, never write them anywhere.',
    )
    expect(brief).not.toContain('GITHUB_TOKEN')
    // the one append every engine uses (SDK chat, Claude console, OpenCode role.md + headless)
    expect(
      chatWith((id) => producerBriefFor(id, [], { registry, operator, credentialNames: () => [{ name: 'INVOICING_API_KEY', signed: false }] })).systemAppendFor(
        'finance',
        [],
      ),
    ).toContain('## Silo you produce: Invoices')
    // an agent that is not bound gets nothing
    expect(producerBriefFor('writer', [], { registry, operator })).toBeNull()
    // a disabled silo is not produced
    operator.patch('invoices', { decision: 'disabled' })
    registry.load()
    expect(producerBriefFor('finance', [], { registry, operator })).toBeNull()
  })

  it('without the credential in the Vault, it says so — never ~/secrets, never asked', () => {
    expect(credentialsLine('Invoicing', [{ name: 'OTHER', signed: false }])).toBe(
      'Credentials: whatever Invoicing needs comes from your environment (the Vault) — none is set for you yet; say so and stop rather than look in ~/secrets or ask for it.',
    )
  })

  it("an entry routed to the producer (audience: producer-agent) is named as THEIRS in the brief; the operator's veto removes it", () => {
    const dataDir = join(base, 'data-audience')
    const operator = new SiloOperatorStore(join(dataDir, 'silos'))
    const m = ref('invoices')
    m.spec.surfaces['needs-you'][0].audience = 'producer-agent'
    mkdirSync(join(dataDir, 'silos', 'registry', 'invoices'), { recursive: true })
    writeFileSync(join(dataDir, 'silos', 'registry', 'invoices', 'silo.json'), JSON.stringify(m))
    operator.set('invoices', { decision: 'approved', producers: ['finance'], slotsOff: [], decidedAt: 'x' })
    const registry = new SiloRegistry({ dataDir, operator })
    registry.load()
    const brief = producerBriefFor('finance', [], { registry, operator })!
    expect(brief).toContain("These needs-you conditions are YOURS to work (audience: producer-agent) — the owner's inbox does not list them:")
    expect(brief).toContain('rows matching `state in [open, partial] and kind = sale and due < now` until `state in [paid, refunded]`')
    operator.patch('invoices', { audienceOff: [0] })
    expect(producerBriefFor('finance', [], { registry, operator })!).not.toContain('YOURS to work')
  })

  it("the sync automation's prompt instructs exactly this flow", () => {
    const p = syncPrompt(ref('invoices'), 'finance', [{ name: 'INVOICING_API_KEY', signed: false }])
    expect(p.split('\n')[0]).toBe('Run the Invoicing sync of the silo Invoices (invoices) now.')
    for (const s of [
      'write one record per document through the API',
      'read INVOICING_API_KEY from your environment',
      'Never read ~/secrets',
      '/merged',
      '/records/<id>',
      "The owner's fields are sacred",
      'Derive due',
    ]) {
      expect(p, s).toContain(s)
    }
    expect(p).not.toMatch(/~\/secrets\/[^\s]/) // never a path into ~/secrets
  })
})

describe('the rehearsal: a producer through the real routes, with a real bearer', () => {
  let app: FastifyInstance
  afterEach(async () => {
    await app?.close()
  })

  async function build() {
    const root = join(base, 'projects')
    const dataDir = join(base, 'data')
    mkdirSync(root, { recursive: true })
    mkdirSync(join(dataDir, 'trash'), { recursive: true })
    const index = claudeSessionIndex(root, join(dataDir, 'cache.json'))
    await index.init()
    const registry = new AgentRegistry(join(dataDir, 'agents.json'))
    registry.load()
    registry.create({ id: 'finance', name: 'Finance', folder: join(base, 'finance') })
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
    const tokens = new AgentTokens(dataDir)
    const silosRoot = join(dataDir, 'silos')
    const operator = new SiloOperatorStore(silosRoot)
    const siloRegistry = new SiloRegistry({ dataDir, operator })
    siloRegistry.load()
    const agentStateBase = join(dataDir, 'agent-state')
    const locations = { agentStates: () => [{ agentId: 'finance', dir: join(agentStateBase, 'finance') }], projects: () => [] }
    const kernel = new SiloKernel({
      registry: siloRegistry,
      reader: new SiloReader(locations),
      journal: new TransitionJournal(siloRegistry.conventionsDir),
      overlay: new OverlayStore(siloRegistry.conventionsDir),
      isAgent: (v) => v === 'finance',
    })
    const events = new SiloEvents(silosRoot)
    const actions = new SiloActions({
      registry: siloRegistry,
      kernel,
      events,
      acks: new SiloAcks(silosRoot),
      proposals: new SiloProposals(silosRoot),
      agentStateBase,
      isAgent: (v) => v === 'finance',
      agentMayReadLocation: (a, l) => l === `agent:${a}`,
      producersOf: (id) => operator.producersOf(id),
    })
    const installer = new SiloInstaller({
      root: silosRoot,
      registry: siloRegistry,
      operator,
      kernel,
      events,
      locations,
      agentStateBase,
      isAgent: (v) => v === 'finance',
      hasBearer: () => true,
      territoriesOf: () => [],
    })
    installer.submit({ manifest: ref('invoices') }, 'owner')
    expect(installer.approve('invoices', { producers: ['finance'] }).code).toBe(200)
    app = buildServer({
      index,
      registry,
      store: new SessionStore(root, dataDir),
      native,
      chat,
      exec: new ExecService(registry),
      complete: new CompleteService(registry, index),
      prefs: new PrefsStore(dataDir),
      memory: new MemoryService(root, dataDir, registry),
      token: 'owner-token',
      liveMs: 120_000,
      agentTokens: tokens,
      siloRegistry,
      siloKernel: kernel,
      siloActions: actions,
      siloInstaller: installer,
      siloOperator: operator,
    })
    const fetchImpl = async (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => {
      const u = new URL(url)
      const r = await app.inject({
        method: (init?.method ?? 'GET') as 'GET',
        url: u.pathname + u.search,
        headers: { host: '127.0.0.1:3210', ...(init?.headers ?? {}) },
        ...(init?.body ? { payload: init.body } : {}),
      })
      return { ok: r.statusCode < 300, status: r.statusCode, json: async () => r.json(), text: async () => r.body }
    }
    // the producer runs inside a turn of its agent: SILOS_TURN (live-turns.ts)
    return { kernel, actions, tokens, dataDir, fetchImpl, token: tokens.tokenFor('finance'), turn: liveTurnOf(chat, 'finance') }
  }
  const sync = (ctx: Awaited<ReturnType<typeof build>>, records: Json[]) =>
    produce({ records, siloId: 'invoices', agentId: 'finance', token: ctx.token, turn: ctx.turn, fetchImpl: ctx.fetchImpl })

  it("first pass writes one file per record, the kernel refuses the broken one; the second pass writes nothing; the owner's overlay stands over the sync until the service reaches it", async () => {
    const ctx = await build()
    const recs = serviceRecords()

    // pass 1
    const first = await sync(ctx, recs)
    expect(first).toMatchObject({ unchanged: 0, written: 5 })
    expect(first.rejected).toEqual([{ id: 'inv-6', status: 422, reason: 'missing contactName' }])
    ctx.kernel.refresh('invoices')
    const dir = join(ctx.dataDir, 'agent-state', 'finance', 'silos', 'invoices')
    expect(readdirSync(dir).filter((f) => f.endsWith('.json'))).toHaveLength(5)
    const records = ctx.kernel.reading('invoices')!.records.map((r) => r.record)
    const states = records.reduce<Record<string, number>>((m, r) => ({ ...m, [String(r.state)]: (m[String(r.state)] ?? 0) + 1 }), {})
    expect(states).toEqual({ draft: 1, open: 1, partial: 1, paid: 1, refunded: 1 })
    const refundNoNumber = records.find((r) => r.kind === 'refund' && r.documentNumber == null)!
    expect(refundNoNumber.identity).toBe(`${refundNoNumber.id} · ${refundNoNumber.contactName}`)

    // pass 2: idempotent
    const second = await sync(ctx, recs.slice(0, 5))
    expect(second).toMatchObject({ written: 0, unchanged: 5 })

    // the owner marks the overdue open sale paid — the overlay, not the file
    const key = 'agent:finance/inv-2'
    const set = await ctx.fetchImpl('http://127.0.0.1:3210/api/silos/invoices/record/set-field', {
      method: 'POST',
      headers: { 'x-token': 'owner-token', 'content-type': 'application/json' },
      body: JSON.stringify({ key, field: 'state', value: 'paid' }),
    })
    expect(set.status).toBe(200)

    // pass 3: the service still says open — nothing written, the owner's value stands
    const third = await sync(ctx, recs.slice(0, 5))
    expect(third).toMatchObject({ written: 0, unchanged: 5 })
    expect(JSON.parse(readFileSync(join(dir, 'inv-2.json'), 'utf8')).state).toBe('open')
    ctx.kernel.refresh('invoices')
    expect(ctx.kernel.reading('invoices')!.records.find((r) => r.record.id === 'inv-2')!.record.state).toBe('paid')

    // the merged view the producer read carries the installed sync contract
    const view = await (
      await ctx.fetchImpl('http://127.0.0.1:3210/api/silos/invoices/agents/finance/merged', { headers: { authorization: `Bearer ${ctx.token}` } })
    ).json()
    expect(view.sync).toMatchObject({ service: 'Invoicing', version: '0.1.0', stateMap: { 'status=completed': 'paid' } })
    expect(view.records.find((r: Json) => r.key === key).overlay.state).toMatchObject({ value: 'paid', base: 'open' })

    // pass 4: the service records the payment — one write; the overlay retires by itself
    const paid = serviceRecords().slice(0, 5)
    paid[1]!.state = 'paid'
    const fourth = await sync(ctx, paid)
    expect(fourth).toMatchObject({ written: 1, unchanged: 4 })
    ctx.kernel.refresh('invoices')
    const after = ctx.kernel.reading('invoices')!.records.find((r) => r.record.id === 'inv-2')!
    expect(after.record.state).toBe('paid')
    expect(after.overlay).toBeUndefined()
    expect(ctx.kernel.overlayState('invoices')).toEqual({ conflicts: [], orphans: [] })
  })

  it('a forged bearer is refused at the door', async () => {
    const ctx = await build()
    const r = await ctx.fetchImpl('http://127.0.0.1:3210/api/silos/invoices/agents/finance/merged', { headers: { authorization: 'Bearer forged' } })
    expect(r.status).toBe(401)
  })

  it("Settings › Silos is the owner's: a producer's real bearer can neither read the inventory nor resubmit", async () => {
    const ctx = await build()
    const auth = { authorization: `Bearer ${ctx.token}` }
    expect((await ctx.fetchImpl('http://127.0.0.1:3210/api/silos', { headers: auth })).status).toBe(403)
    expect(
      (
        await ctx.fetchImpl('http://127.0.0.1:3210/api/silos/invoices/resubmit', {
          method: 'POST',
          headers: { ...auth, 'content-type': 'application/json' },
          body: '{}',
        })
      ).status,
    ).toBe(403)
    expect(
      (
        await ctx.fetchImpl('http://127.0.0.1:3210/api/silos/%69nvoices/resubmit', {
          method: 'POST',
          headers: { ...auth, 'content-type': 'application/json' },
          body: '{}',
        })
      ).status,
    ).toBe(403)
    // the owner reads it
    expect((await ctx.fetchImpl('http://127.0.0.1:3210/api/silos', { headers: { 'x-token': 'owner-token' } })).status).toBe(200)
  })
})
