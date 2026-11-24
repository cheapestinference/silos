import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
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
import { FileService } from '../src/file-service.js'
import { ContextService } from '../src/context-service.js'
import { buildServer, type ServerDeps } from '../src/server.js'
import { AgentStateStore } from '../src/agent-state.js'
import { LineageStore } from '../src/lineage.js'
import { AgentTokens } from '../src/agent-tokens.js'
import { mungePath } from '../src/agent-registry.js'
import { readContextNews } from '../src/context-news.js'

const REMOTE = { host: 'silos.example.com' }
const TOKEN = 'testtoken'

let app: FastifyInstance
let base: string, agentFolder: string
let deps: ServerDeps
let agentTokens: AgentTokens, dataDirOf: string
// one conversation of builder across a /clear (ROOT → TIP), one of finance
const ROOT = 'aaaaaaaa-1111-4111-8111-111111111111'
const TIP = 'bbbbbbbb-2222-4222-8222-222222222222'
const OTHER = 'cccccccc-3333-4333-8333-333333333333'

beforeEach(async () => {
  base = mkdtempSync(join(tmpdir(), 'ctx-api-'))
  const root = join(base, 'projects')
  const dataDir = join(base, 'data')
  agentFolder = join(base, 'agent-home')
  mkdirSync(root, { recursive: true })
  mkdirSync(join(dataDir, 'trash'), { recursive: true })
  mkdirSync(agentFolder, { recursive: true })
  // one session on disk, for the detail route
  mkdirSync(join(root, '-r'), { recursive: true })
  writeFileSync(join(root, '-r', 's1.jsonl'), '{"type":"user","cwd":"/r","message":{"role":"user","content":"hi"}}\n')
  const af = mungePath(agentFolder)
  mkdirSync(join(root, af), { recursive: true })
  for (const id of [ROOT, TIP, OTHER])
    writeFileSync(
      join(root, af, `${id}.jsonl`),
      `{"type":"user","cwd":${JSON.stringify(agentFolder)},"sessionId":"${id}","message":{"role":"user","content":"hi"}}\n`,
    )
  dataDirOf = dataDir

  const index = claudeSessionIndex(root, join(dataDir, 'cache.json'))
  await index.init()
  const registry = new AgentRegistry(join(dataDir, 'agents.json'))
  registry.load()
  registry.create({ id: 'builder', name: 'BUILDER', folder: agentFolder })
  registry.create({ id: 'finance', name: 'FINANCE', folder: agentFolder })
  const store = new SessionStore(root, dataDir)
  const native = new NativeStore(join(dataDir, 'native.json'))
  for (const [id, agentId] of [
    [ROOT, 'builder'],
    [TIP, 'builder'],
    [OTHER, 'finance'],
  ] as const)
    native.register(af, id, { agentId, createdAt: '2026-01-01T00:00:00Z' })
  const lineage = new LineageStore(join(dataDir, 'lineage.json'))
  lineage.record(`${af}/${TIP}`, `${af}/${ROOT}`)
  agentTokens = new AgentTokens(dataDir)
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
  const exec = new ExecService(registry)
  const complete = new CompleteService(registry, index)
  const prefs = new PrefsStore(dataDir)
  const memory = new MemoryService(root, dataDir, registry)
  const files = new FileService(dataDir)
  const context = new ContextService()
  const agentState = new AgentStateStore(join(dataDir, 'agent-state'))
  deps = {
    index,
    registry,
    store,
    native,
    lineage,
    chat,
    exec,
    complete,
    prefs,
    memory,
    files,
    context,
    agentState,
    agentTokens,
    dataDir,
    token: TOKEN,
    liveMs: 120_000,
  }
  app = buildServer(deps)
})

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64')
const post = (id: string, payload: unknown) => app.inject({ method: 'POST', url: `/api/agents/${id}/context`, headers: { 'x-token': TOKEN }, payload })
const list = (id: string) => app.inject({ url: `/api/agents/${id}/context`, headers: { 'x-token': TOKEN } })
const del = (id: string, scope: string, name: string) =>
  app.inject({ method: 'DELETE', url: `/api/agents/${id}/context?scope=${scope}&name=${encodeURIComponent(name)}`, headers: { 'x-token': TOKEN } })

describe('POST /api/agents/:id/context — upload', () => {
  it('uploads a shared file and returns it with its path under context/shared/', async () => {
    const res = await post('builder', { scope: 'shared', name: 'guide.md', contentBase64: b64('# guide') })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.name).toBe('guide.md')
    expect(body.scope).toBe('shared')
    expect(body.path).toBe(join(agentFolder, 'context', 'shared', 'guide.md'))
  })

  it('invalid scope -> 400', async () => {
    expect((await post('builder', { scope: 'other', name: 'x.md', contentBase64: b64('y') })).statusCode).toBe(400)
  })

  it('a name containing a path -> 400 (containment)', async () => {
    expect((await post('builder', { scope: 'shared', name: '../outside.md', contentBase64: b64('y') })).statusCode).toBe(400)
  })

  it('nonexistent agent -> 404', async () => {
    expect((await post('nope', { scope: 'shared', name: 'x.md', contentBase64: b64('y') })).statusCode).toBe(404)
  })

  it('REMOTE without a token -> 401 and nothing gets uploaded', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/agents/builder/context',
      headers: REMOTE,
      payload: { scope: 'shared', name: 'x.md', contentBase64: b64('y') },
    })
    expect(res.statusCode).toBe(401)
    expect((await list('builder')).json().shared).toEqual([])
  })
})

describe('GET /api/agents/:id/context — list', () => {
  it("lists the agent's shared + private files", async () => {
    await post('builder', { scope: 'shared', name: 'common.md', contentBase64: b64('a') })
    await post('builder', { scope: 'agent', name: 'mine.md', contentBase64: b64('b') })
    const body = (await list('builder')).json()
    expect(body.shared.map((f: { name: string }) => f.name)).toEqual(['common.md'])
    expect(body.agent.map((f: { name: string }) => f.name)).toEqual(['mine.md'])
  })
})

describe('DELETE /api/agents/:id/context — delete', () => {
  it('deletes the file from the correct scope', async () => {
    await post('builder', { scope: 'agent', name: 'tmp.md', contentBase64: b64('a') })
    expect((await del('builder', 'agent', 'tmp.md')).statusCode).toBe(200)
    expect((await list('builder')).json().agent).toEqual([])
  })
})

describe('master context (Anywhere, no folder)', () => {
  it('GET returns empty lists (it has no folder)', async () => {
    const body = (await list('master')).json()
    expect(body).toEqual({ shared: [], agent: [], conversation: [] })
  })
  it('POST -> 400 (master has no folder for context)', async () => {
    expect((await post('master', { scope: 'shared', name: 'x.md', contentBase64: b64('y') })).statusCode).toBe(400)
  })
})

describe('GET /api/sessions/:folder/:id — execution', () => {
  it('the detail carries the execution record and the task it hangs from when the kernel kind has one, null otherwise', async () => {
    const detail = (a: FastifyInstance) => a.inject({ url: '/api/sessions/-r/s1', headers: { 'x-token': TOKEN } })
    const none = await detail(app)
    expect(none.statusCode).toBe(200)
    expect(none.json().execution).toBeNull()

    const withStore = buildServer({
      ...deps,
      executions: {
        forSession: () => ({
          record: {
            ledgerPath: '/r/.superpowers/sdd/x/progress.md',
            planPath: null,
            planTitle: 'X',
            tasks: [],
            done: 0,
            total: null,
            updatedAt: 1,
            gone: false,
          },
          task: { key: 'folder:/r/p/tasks/t3', ref: 'p#t3', edge: 'conversation' },
        }),
      },
    })
    const res = await detail(withStore)
    expect(res.statusCode).toBe(200)
    expect(res.json().execution.planTitle).toBe('X')
    expect(res.json().executionTask).toEqual({ key: 'folder:/r/p/tasks/t3', ref: 'p#t3', edge: 'conversation' })
  })
})

describe('GET /api/agents/:id/produced', () => {
  it('[] for an agent whose own folder holds nothing; 404 for an unknown agent', async () => {
    const res = await app.inject({ url: '/api/agents/builder/produced', headers: { 'x-token': TOKEN } })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual([])
    expect((await app.inject({ url: '/api/agents/nobody/produced', headers: { 'x-token': TOKEN } })).statusCode).toBe(404)
  })

  it('lists what the agent wrote in its own folder, scope own', async () => {
    const dir = join(base, 'data', 'agent-state', 'builder', 'reports')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'q4.md'), '# q4')
    const res = await app.inject({ url: '/api/agents/builder/produced', headers: { 'x-token': TOKEN } })
    expect(res.json()).toMatchObject([{ rel: 'reports/q4.md', scope: 'own', name: 'q4.md' }])
  })
})

describe('the conversation scope — files the owner gives ONE conversation', () => {
  const given = (id: string, sid: string) => app.inject({ url: `/api/agents/${id}/context?conversation=${sid}`, headers: { 'x-token': TOKEN } })
  it('any session id of a thread resolves to the same folder (its ROOT), and the upload is queued as news for that thread alone', async () => {
    const res = await post('builder', { scope: 'conversation', conversation: TIP, name: 'brief.md', contentBase64: b64('b') })
    expect(res.statusCode).toBe(200)
    expect(res.json().path).toBe(join(agentFolder, 'context', 'builder', 'conversations', ROOT, 'brief.md'))
    for (const sid of [ROOT, TIP]) {
      const body = (await given('builder', sid)).json()
      expect(body.conversation.map((f: { name: string }) => f.name)).toEqual(['brief.md'])
      expect(body.agent).toEqual([]) // never mixed into the agent's own list
    }
    expect(readContextNews(dataDirOf, ROOT)).toEqual([`context/builder/conversations/${ROOT}/brief.md`])
    const threads = (await app.inject({ url: '/api/agents/builder/context/conversations', headers: { 'x-token': TOKEN } })).json()
    expect(threads.map((t: { thread: string; gone: boolean }) => [t.thread, t.gone])).toEqual([[ROOT, false]])
    // «Give to the agent»: up to the top level; a second time, refused
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/agents/builder/context/promote',
          headers: { 'x-token': TOKEN },
          payload: { conversation: TIP, name: 'brief.md' },
        })
      ).statusCode,
    ).toBe(200)
    expect((await list('builder')).json().agent.map((f: { name: string }) => f.name)).toEqual(['brief.md'])
    await post('builder', { scope: 'conversation', conversation: ROOT, name: 'brief.md', contentBase64: b64('again') })
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/agents/builder/context/promote',
          headers: { 'x-token': TOKEN },
          payload: { conversation: ROOT, name: 'brief.md' },
        })
      ).statusCode,
    ).toBe(409)
    expect(
      (
        await app.inject({
          method: 'DELETE',
          url: `/api/agents/builder/context?scope=conversation&conversation=${TIP}&name=brief.md`,
          headers: { 'x-token': TOKEN },
        })
      ).statusCode,
    ).toBe(200)
    expect((await given('builder', ROOT)).json().conversation).toEqual([])
  })
  it('a session of another agent is refused, reading and writing', async () => {
    expect((await post('builder', { scope: 'conversation', conversation: OTHER, name: 'x.md', contentBase64: b64('x') })).statusCode).toBe(403)
    expect((await given('builder', OTHER)).statusCode).toBe(403)
    expect((await post('builder', { scope: 'conversation', conversation: '../../etc', name: 'x.md', contentBase64: b64('x') })).statusCode).toBe(400)
  })
  it("an agent bearer still cannot write: upload, delete and promote are the owner's alone", async () => {
    const bearer = { authorization: `Bearer ${agentTokens.tokenFor('builder')}` }
    const up = await app.inject({
      method: 'POST',
      url: '/api/agents/builder/context',
      headers: bearer,
      payload: { scope: 'conversation', conversation: ROOT, name: 'x.md', contentBase64: b64('x') },
    })
    expect(up.statusCode).toBe(403)
    expect(
      (await app.inject({ method: 'POST', url: '/api/agents/builder/context/promote', headers: bearer, payload: { conversation: ROOT, name: 'x.md' } }))
        .statusCode,
    ).toBe(403)
    expect(
      (await app.inject({ method: 'DELETE', url: `/api/agents/builder/context?scope=conversation&conversation=${ROOT}&name=x.md`, headers: bearer }))
        .statusCode,
    ).toBe(403)
    expect((await given('builder', ROOT)).json().conversation).toEqual([])
  })
})
