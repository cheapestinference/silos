// silo-bearer-scope.test.ts — what a silo route reads or renders on behalf of
// a bearer is bounded by that bearer's own territory: an
// agent's token never makes the server read another agent's state, drafts or
// project folders, and never returns their content — before or after the
// owner approved anything. The owner's credential keeps its full view.
// Reproduced first: POST /api/silos/validate with alice's bearer returned
// bob's draft validated, and a manifest whose glob pointed at bob's records
// (root agent-state) or at bob's project (root project) quoted them in its
// preview. Each route of the class has both sides here.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { claudeSessionIndex } from '../src/harnesses/claude-code/reader.js'
import { AgentRegistry } from '../src/agent-registry.js'
import { AgentTokens } from '../src/agent-tokens.js'
import { territoriesOf } from '../src/territory.js'
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
import { TransitionJournal } from '../src/silos/journal.js'
import { SiloReader } from '../src/silos/reader.js'
import { OverlayStore } from '../src/silos/overlay.js'
import { SiloInstaller } from '../src/silos/installer.js'
import { SiloOperatorStore } from '../src/silos/operator.js'
import { SiloActions, SiloAcks, SiloEvents, SiloProposals } from '../src/silos/actions.js'
import { bearerLocations, bearerMayReadLocation } from '../src/silos/bearer-scope.js'
import type { SiloLocations } from '../src/silos/files-source.js'
import { bearerWritesCarryTurns } from './helpers/live-turn.js'
import { siloManifest } from './helpers/silo-manifests.js'

type Json = Record<string, unknown>
const ref = (n: string): Json => siloManifest(n) as Json
const OWNER = 'owner-token'
const BOB_SECRET = 'BOB-PRIVATE-7731'
const BOB_PROJECT_SECRET = 'BOB-PROJECT-4402'

let T: string
let app: FastifyInstance
let tokens: AgentTokens
let dataDir: string

// a copy of a reference manifest under another id (one kind, its examples)
function named(n: string, id: string, patch: (m: Json) => void = () => {}): Json {
  const m = ref(n)
  ;(m.metadata as Json).id = id
  patch(m)
  return m
}

beforeEach(async () => {
  T = realpathSync(mkdtempSync(join(tmpdir(), 'silo-bearer-')))
  const root = join(T, 'projects')
  dataDir = join(T, 'data')
  mkdirSync(root, { recursive: true })
  mkdirSync(join(dataDir, 'trash'), { recursive: true })
  const index = claudeSessionIndex(root, join(dataDir, 'cache.json'))
  await index.init()
  const registry = new AgentRegistry(join(dataDir, 'agents.json'))
  registry.load()
  const pAlice = join(T, 'p-alice')
  const pBob = join(T, 'p-bob')
  mkdirSync(pAlice, { recursive: true })
  mkdirSync(pBob, { recursive: true })
  registry.create({ id: 'alice', name: 'Alice', folder: pAlice })
  registry.create({ id: 'bob', name: 'Bob', folder: pBob })
  const agentStateBase = join(dataDir, 'agent-state')
  // bob's records in his own (fenced) state, as invoices reads them
  const inv = ref('invoices').spec as Json
  const ex = ((inv.kinds as Json).invoice as Json).examples as Json[]
  mkdirSync(join(agentStateBase, 'bob', 'silos', 'invoices'), { recursive: true })
  writeFileSync(join(agentStateBase, 'bob', 'silos', 'invoices', 'b1.json'), JSON.stringify({ ...ex[0], id: 'b1', contactName: BOB_SECRET }))
  mkdirSync(join(agentStateBase, 'bob', 'silos', 'ledger'), { recursive: true })
  writeFileSync(join(agentStateBase, 'bob', 'silos', 'ledger', 'b2.json'), JSON.stringify({ ...ex[0], id: 'b2', contactName: BOB_SECRET }))
  mkdirSync(join(agentStateBase, 'alice', 'silos', 'invoices'), { recursive: true })
  writeFileSync(join(agentStateBase, 'alice', 'silos', 'invoices', 'a1.json'), JSON.stringify({ ...ex[0], id: 'a1', contactName: 'Alice Own Co' }))
  // support's cases under another id: notes appendable by the producer
  const cex = ((((ref('support').spec as Json).kinds as Json).case as Json).examples as Json[])[0]!
  for (const [who, id, summary] of [
    ['alice', 'c1', 'Alice case'],
    ['bob', 'c2', BOB_SECRET],
  ] as const) {
    mkdirSync(join(agentStateBase, who, 'support', 'cases'), { recursive: true })
    writeFileSync(join(agentStateBase, who, 'support', 'cases', `${id}.json`), JSON.stringify({ ...cex, id, summary }))
  }
  // bob's draft, in his state
  mkdirSync(join(agentStateBase, 'bob', 'silo-drafts'), { recursive: true })
  writeFileSync(
    join(agentStateBase, 'bob', 'silo-drafts', 'bobs.json'),
    JSON.stringify(
      named('invoices', 'bobs', (m) => {
        ;(m.metadata as Json).name = BOB_SECRET
      }),
    ),
  )
  mkdirSync(join(agentStateBase, 'alice', 'silo-drafts'), { recursive: true })
  writeFileSync(join(agentStateBase, 'alice', 'silo-drafts', 'alices.json'), JSON.stringify(named('invoices', 'alices')))
  // a document in bob's PROJECT folder (documents reads root: project)
  const docs = ((ref('documents').spec as Json).kinds as Json).document as Json
  const dex = (docs.examples as Json[])[0]!
  mkdirSync(join(pBob, 'context', 'documents'), { recursive: true })
  writeFileSync(join(pBob, 'context', 'documents', 'd1.json'), JSON.stringify({ ...dex, id: 'd1', title: BOB_PROJECT_SECRET }))

  const locations: SiloLocations = {
    agentStates: () => ['alice', 'bob'].map((agentId) => ({ agentId, dir: join(agentStateBase, agentId) })),
    projects: () => [pAlice, pBob],
  }
  const terr = (id: string): string[] => {
    const a = registry.list(true).find((x) => x.id === id)
    return a ? territoriesOf(a) : []
  }
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
  tokens = new AgentTokens(dataDir)
  const silosRoot = join(dataDir, 'silos')
  const operator = new SiloOperatorStore(silosRoot)
  const siloRegistry = new SiloRegistry({ dataDir, operator })
  siloRegistry.load()
  const isAgent = (v: string): boolean => v === 'alice' || v === 'bob'
  const reader = new SiloReader(locations)
  const kernel = new SiloKernel({
    registry: siloRegistry,
    reader,
    journal: new TransitionJournal(siloRegistry.conventionsDir),
    overlay: new OverlayStore(siloRegistry.conventionsDir),
    isAgent,
  })
  const events = new SiloEvents(silosRoot)
  const actions = new SiloActions({
    registry: siloRegistry,
    kernel,
    events,
    acks: new SiloAcks(silosRoot),
    proposals: new SiloProposals(silosRoot),
    agentStateBase,
    isAgent,
    agentMayReadLocation: (a, l) => bearerMayReadLocation(a, l, terr),
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
    isAgent,
    hasBearer: () => true,
    territoriesOf: terr,
  })
  // invoices installed with BOTH as producers: what a shared silo looks like after approval
  installer.submit({ manifest: ref('invoices') }, 'owner')
  expect(installer.approve('invoices', { producers: ['alice', 'bob'] }).code).toBe(200)
  expect(installer.submit({ manifest: named('support', 'cases') }, 'owner').code).toBe(201)
  expect(installer.approve('cases', { producers: ['alice', 'bob'] }).code).toBe(200)
  kernel.refresh()
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
    token: OWNER,
    liveMs: 120_000,
    agentTokens: tokens,
    siloRegistry,
    siloKernel: kernel,
    siloActions: actions,
    siloInstaller: installer,
    siloOperator: operator,
    // wired as index.ts wires it: the owner's reader, and the bearer's bound one
    siloValidate: createSiloValidate({
      registry: siloRegistry,
      reader,
      isAgent,
      agentStateBase,
      readerFor: (by) => new SiloReader(bearerLocations(locations, by, terr)),
    }),
  })
  bearerWritesCarryTurns(app, chat, tokens)
})
afterEach(async () => {
  await app?.close()
  rmSync(T, { recursive: true, force: true })
})

const as = (who: 'owner' | 'alice' | 'bob'): Record<string, string> =>
  who === 'owner' ? { 'x-token': OWNER } : { authorization: `Bearer ${tokens.tokenFor(who)}` }
const post = (who: 'owner' | 'alice' | 'bob', url: string, payload: unknown) => app.inject({ method: 'POST', url, headers: as(who), payload: payload as Json })
const get = (who: 'owner' | 'alice' | 'bob', url: string) => app.inject({ url, headers: as(who) })

describe("POST /api/silos/validate — a draft is read on its author's authority", () => {
  it('alice validates her own draft (named, or by id alone)', async () => {
    const r = await post('alice', '/api/silos/validate', { draft: { agent: 'alice', id: 'alices' } })
    expect(r.statusCode).toBe(200)
    expect(r.json()).toMatchObject({ ok: true, id: 'alices', state: 'draft' })
    const bare = await post('alice', '/api/silos/validate', { draft: { id: 'alices' } })
    expect(bare.statusCode).toBe(200)
    expect(bare.json()).toMatchObject({ ok: true, id: 'alices' })
  })
  it("alice naming bob's draft is refused in plain words, and nothing of it comes back", async () => {
    const r = await post('alice', '/api/silos/validate', { draft: { agent: 'bob', id: 'bobs' } })
    expect(r.statusCode).toBe(403)
    expect(r.json().error).toBe('alice may only validate its own drafts')
    expect(r.body).not.toContain(BOB_SECRET)
    // the same answer whether bob has that draft or not: no existence probe
    const none = await post('alice', '/api/silos/validate', { draft: { agent: 'bob', id: 'nothing-here' } })
    expect(none.statusCode).toBe(403)
    expect(none.json()).toEqual(r.json())
  })
  it("the owner reads any agent's draft", async () => {
    const r = await post('owner', '/api/silos/validate', { draft: { agent: 'bob', id: 'bobs' } })
    expect(r.statusCode).toBe(200)
    expect(r.json()).toMatchObject({ ok: true, id: 'bobs' })
  })
})

describe("the preview reads records on the bearer's authority (validate and submit alike)", () => {
  // invoices under another id: root agent-state, matches EVERY agent's state
  const peek = (): Json => named('invoices', 'peek')
  // the same, its glob aimed at a folder only bob's state holds
  const peekBob = (): Json =>
    named('invoices', 'peek-bob', (m) => {
      ;((m.spec as Json).sources as Json[])[0]!.glob = 'silos/ledger/*.json'
    })
  // documents under another id: root project, matches EVERY project folder
  const peekDocs = (): Json => named('documents', 'peek-docs')

  it("agent-state: alice sees her own records, never bob's", async () => {
    const r = await post('alice', '/api/silos/validate', { manifest: peek() })
    expect(r.statusCode).toBe(200)
    const v = r.json()
    expect(v.ok).toBe(true)
    expect(v.preview.from).toBe('records')
    expect(v.preview.basis).toMatch(/^from 1 record on disk/)
    expect(JSON.stringify(v)).toContain('Alice Own Co')
    expect(r.body).not.toContain(BOB_SECRET)
  })
  it("agent-state: a glob aimed at bob's records gives alice the examples, never his records", async () => {
    const r = await post('alice', '/api/silos/validate', { manifest: peekBob() })
    expect(r.statusCode).toBe(200)
    expect(r.json().preview.from).toBe('examples')
    expect(r.body).not.toContain(BOB_SECRET)
  })
  it("agent-state: the owner's dry-run reads every agent's records", async () => {
    expect((await post('owner', '/api/silos/validate', { manifest: peek() })).json().preview.basis).toMatch(/^from 2 records on disk/)
    const r = await post('owner', '/api/silos/validate', { manifest: peekBob() })
    expect(r.json().preview.from).toBe('records')
    expect(r.body).toContain(BOB_SECRET)
  })
  it("project: alice's preview never reads bob's project folder — she sees the examples", async () => {
    const r = await post('alice', '/api/silos/validate', { manifest: peekDocs() })
    expect(r.statusCode).toBe(200)
    expect(r.json().preview.from).toBe('examples')
    expect(r.body).not.toContain(BOB_PROJECT_SECRET)
    const owner = await post('owner', '/api/silos/validate', { manifest: peekDocs() })
    expect(owner.json().preview.from).toBe('records')
    expect(owner.body).toContain(BOB_PROJECT_SECRET)
  })
  it('submission answers the same bounded preview (it always did — one bound for both doors)', async () => {
    const r = await post('alice', '/api/silos/submissions', { manifest: peek() })
    expect(r.statusCode).toBe(201)
    expect(r.body).not.toContain(BOB_SECRET)
    expect(r.json().validation.preview.basis).toMatch(/^from 1 record on disk/)
    const b = await post('alice', '/api/silos/submissions', { manifest: peekBob() })
    expect(b.statusCode).toBe(201)
    expect(b.body).not.toContain(BOB_SECRET)
    const d = await post('alice', '/api/silos/submissions', { manifest: peekDocs() })
    expect(d.statusCode).toBe(201)
    expect(d.body).not.toContain(BOB_PROJECT_SECRET)
  })
})

describe("the review dialog proposes an agent's own submission's author as its producer", () => {
  it("alice submits: the owner's dialog proposes alice; the owner's own submission proposes nobody", async () => {
    expect((await post('alice', '/api/silos/submissions', { manifest: named('invoices', 'peek') })).statusCode).toBe(201)
    const c = await get('owner', '/api/silos/submissions/peek/consequences')
    expect(c.json().derived).toMatchObject({ proposedProducers: ['alice'], forProducers: ['alice'] })
    expect((await post('owner', '/api/silos/submissions', { manifest: named('invoices', 'mine') })).statusCode).toBe(201)
    expect((await get('owner', '/api/silos/submissions/mine/consequences')).json().derived.proposedProducers).toEqual([])
  })
})

describe("after approval: the producer routes read only the bearer's own locations", () => {
  it("merged view: alice gets her records only; the owner reads anyone's", async () => {
    const r = await get('alice', '/api/silos/invoices/agents/alice/merged')
    expect(r.statusCode).toBe(200)
    expect(r.json().records.map((x: { key: string }) => x.key)).toEqual(['agent:alice/a1'])
    expect(r.body).not.toContain(BOB_SECRET)
    const other = await get('alice', '/api/silos/invoices/agents/bob/merged')
    expect(other.statusCode).toBe(403)
    expect(other.body).not.toContain(BOB_SECRET)
    const owner = await get('owner', '/api/silos/invoices/agents/bob/merged')
    expect(owner.statusCode).toBe(200)
    expect(owner.body).toContain(BOB_SECRET)
  })
  it("proposals: alice proposes on her own record; on bob's she is refused and his value never comes back", async () => {
    const own = await post('alice', '/api/silos/invoices/agents/alice/proposals', { key: 'agent:alice/a1', field: 'state', value: 'paid' })
    expect(own.statusCode).toBe(201)
    const other = await post('alice', '/api/silos/invoices/agents/alice/proposals', { key: 'agent:bob/b1', field: 'state', value: 'paid' })
    expect(other.statusCode).toBe(403)
    expect(other.json().error).toBe('alice may only act on records in its own territory — agent:bob/b1 is not')
    expect(other.body).not.toContain(BOB_SECRET)
    // the same answer for a key that does not exist: nothing to probe
    const none = await post('alice', '/api/silos/invoices/agents/alice/proposals', { key: 'agent:bob/zz', field: 'state', value: 'paid' })
    expect(none.statusCode).toBe(403)
  })
  it("append-item: alice notes her own case; bob's case is refused before any lookup, his record never returned", async () => {
    const note = { collection: 'notes', values: { text: 'seen' } }
    const own = await post('alice', '/api/silos/cases/record/append', { key: 'agent:alice/c1', ...note })
    expect(own.statusCode).toBe(200)
    const other = await post('alice', '/api/silos/cases/record/append', { key: 'agent:bob/c2', ...note })
    expect(other.statusCode).toBe(403)
    expect(other.json()).toEqual({ error: 'alice may only act on records in its own territory — agent:bob/c2 is not' })
    expect(other.body).not.toContain(BOB_SECRET)
    const none = await post('alice', '/api/silos/cases/record/append', { key: 'agent:bob/nothing', ...note })
    expect(none.statusCode).toBe(403)
    expect(readFileSync(join(dataDir, 'agent-state', 'bob', 'support', 'cases', 'c2.json'), 'utf8')).not.toContain('seen')
    const owner = await post('owner', '/api/silos/cases/record/append', { key: 'agent:bob/c2', ...note })
    expect(owner.statusCode).toBe(200)
    expect(owner.body).toContain(BOB_SECRET)
  })
  it("the owner's routes stay the owner's: an agent bearer reads no records, consequences, queue or events", async () => {
    for (const url of [
      '/api/silos/invoices/records',
      '/api/silos/invoices/record?key=agent:bob/b1',
      '/api/silos/submissions',
      '/api/silos/submissions/invoices/consequences',
      '/api/silos/invoices/events',
      '/api/silos/invoices/proposals',
      '/api/silos',
    ]) {
      const r = await get('alice', url)
      expect(r.statusCode, url).toBe(403)
      expect(r.body, url).not.toContain(BOB_SECRET)
    }
    expect((await get('owner', '/api/silos/invoices/records')).body).toContain(BOB_SECRET)
  })
})

describe('bearerLocations — the one bound', () => {
  it('an agent: its own state and the project folders inside its territories; the owner: all', () => {
    const all: SiloLocations = {
      agentStates: () => [
        { agentId: 'a', dir: '/s/a' },
        { agentId: 'b', dir: '/s/b' },
      ],
      projects: () => ['/p/a', '/p/a/sub', '/p/ab', '/p/b'],
    }
    const terr = (id: string): string[] => (id === 'a' ? ['/p/a'] : [])
    const a = bearerLocations(all, 'a', terr)
    expect(a.agentStates()).toEqual([{ agentId: 'a', dir: '/s/a' }])
    expect(a.projects()).toEqual(['/p/a', '/p/a/sub'])
    expect(bearerLocations(all, 'owner', terr)).toBe(all)
    expect(bearerMayReadLocation('a', 'agent:a', terr)).toBe(true)
    expect(bearerMayReadLocation('a', 'agent:b', terr)).toBe(false)
    expect(bearerMayReadLocation('a', 'folder:/p/a/sub', terr)).toBe(true)
    expect(bearerMayReadLocation('a', 'folder:/p/ab', terr)).toBe(false)
    expect(bearerMayReadLocation('a', 'platform', terr)).toBe(false)
  })
})

describe('one id rule for every door: a native or engine id never validates', () => {
  for (const id of ['memories', 'skills', 'mcps']) {
    it(`${id}: validate says it (check 2, the door's words), submit refuses it 409 native`, async () => {
      const m = named('documents', id)
      for (const who of ['owner', 'alice'] as const) {
        const v = await post(who, '/api/silos/validate', { manifest: m })
        expect(v.statusCode).toBe(200)
        const body = v.json()
        expect(body.ok).toBe(false)
        expect(body.native).toMatch(/is part of the engine/)
        expect(body.errors).toContainEqual({ check: 2, where: 'metadata.id', message: body.native })
        const s = await post(who, '/api/silos/submissions', { manifest: m })
        expect(s.statusCode).toBe(409)
        expect(s.json()).toEqual({ error: body.native, native: true })
      }
    })
  }
  it('over a manifest the schema refuses, the id is still said', async () => {
    const v = await post('owner', '/api/silos/validate', { manifest: { metadata: { id: 'skills' } } })
    expect(v.json().ok).toBe(false)
    expect(v.json().native).toMatch(/Skills is part of the engine/)
    expect((await post('owner', '/api/silos/submissions', { manifest: { metadata: { id: 'skills' } } })).statusCode).toBe(409)
  })
  it('an ordinary id carries no native word', async () => {
    const v = await post('owner', '/api/silos/validate', { manifest: named('documents', 'contracts') })
    expect(v.json().ok).toBe(true)
    expect(v.json().native).toBeUndefined()
  })
})
