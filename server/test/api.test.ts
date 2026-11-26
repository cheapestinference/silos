import { PeerRegistry } from '../src/harnesses/claude-code/peer-registry.js'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, cpSync, utimesSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import http from 'node:http'
import type { FastifyInstance } from 'fastify'
import type { SessionIndex } from '../src/session-index.js'
import { claudeSessionIndex } from '../src/harnesses/claude-code/reader.js'
import { AgentRegistry } from '../src/agent-registry.js'
import { SessionStore } from '../src/session-store.js'
import { NativeStore } from '../src/native-store.js'
import { ChatService } from '../src/chat-service.js'
import { ExecService } from '../src/exec-service.js'
import { CompleteService } from '../src/complete-service.js'
import { PrefsStore } from '../src/prefs-store.js'
import { MemoryService } from '../src/memory-service.js'
import { AutomationsStore } from '../src/automations-store.js'
import { SessionOriginsStore } from '../src/session-origins'
import { SeenStore } from '../src/seen-store'
import { BirthsStore } from '../src/births-store'
import { AgentStateStore } from '../src/agent-state.js'
import { buildServer } from '../src/server.js'
import { TerminalService } from '../src/terminal-service.js'
import { LineageStore } from '../src/lineage.js'

// a genuinely LOCAL request (loopback Host, no forwarding/tunnel headers)
// no longer requires a token — see isLocalRequest in server.ts. These 401
// assertions must look REMOTE (public host) so they keep exercising the
// guard without weakening it.
const REMOTE = { host: 'silos.example.com' }

const FIX = new URL('./fixtures/basic.jsonl', import.meta.url).pathname
let app: FastifyInstance
let terminals: TerminalService
let base: string, root: string
let registry: AgentRegistry, native: NativeStore, sessionStore: SessionStore
let automations: AutomationsStore, agentState: AgentStateStore, origins: SessionOriginsStore
let appDeps: () => Parameters<typeof buildServer>[0]
let index: SessionIndex
let lineage: LineageStore
const TOKEN = 'testtoken'

beforeEach(async () => {
  base = mkdtempSync(join(tmpdir(), 'deck-'))
  root = join(base, 'projects')
  const dataDir = join(base, 'data')
  mkdirSync(join(root, '-tmp-project-x'), { recursive: true })
  mkdirSync(join(dataDir, 'trash'), { recursive: true })
  cpSync(FIX, join(root, '-tmp-project-x', 'aaa.jsonl'))
  // cpSync does NOT preserve mtime -> without this the session would come
  // out live:true and the test would be flaky
  const old = (Date.now() - 3_600_000) / 1000
  utimesSync(join(root, '-tmp-project-x', 'aaa.jsonl'), old, old)
  index = claudeSessionIndex(root, join(dataDir, 'cache.json'))
  await index.init()
  registry = new AgentRegistry(join(dataDir, 'agents.json'))
  registry.load()
  registry.create({ id: 'finance', name: 'FINANCE', folder: '/tmp/project-x', skills: ['finance-acme'] })
  const store = new SessionStore(root, dataDir)
  sessionStore = store
  native = new NativeStore(join(dataDir, 'native.json'))
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
  automations = new AutomationsStore(dataDir)
  automations.load()
  agentState = new AgentStateStore(join(dataDir, 'agent-state'))
  // A hermetic TerminalService: its sessions dir (claude's ~/.claude/sessions
  // lock files, consulted by the trash route's live-writer guard) lives under
  // the test's temp base — buildServer's default instance would read the REAL
  // home. The tmux socket is overridden so no test ever touches the real one.
  mkdirSync(join(base, 'claude-sessions'), { recursive: true })
  terminals = new TerminalService(registry, index, undefined, undefined, { sessionsDir: join(base, 'claude-sessions'), tmuxSocket: 'silos-apitest-none' })
  origins = new SessionOriginsStore(dataDir)
  lineage = new LineageStore(join(dataDir, 'lineage.json'))
  const births = new BirthsStore(agentState, { ttlMs: 0 })
  appDeps = () => ({
    index,
    registry,
    store,
    native,
    chat,
    exec,
    complete,
    prefs,
    memory,
    token: TOKEN,
    liveMs: 120_000,
    automations,
    agentState,
    terminals,
    origins,
    lineage,
    births,
    peers: new PeerRegistry(join(base, 'claude-sessions')),
    home: join(base, 'home'),
  })
  app = buildServer(appDeps())
})

const get = (url: string) => app.inject({ url, headers: { 'x-token': TOKEN } })

describe('auth', () => {
  it('no token -> 401; with a token -> 200', async () => {
    expect((await app.inject({ url: '/api/overview', headers: REMOTE })).statusCode).toBe(401)
    expect((await get('/api/overview')).statusCode).toBe(200)
  })

  // CSWSH / localhost CSRF regression: a request with a loopback Host and no
  // forwarding headers is "local" ONLY if it doesn't carry a foreign Origin —
  // otherwise any web page the user has open could drive the API with no token.
  describe('cross-origin guard', () => {
    const LOCAL = { host: '127.0.0.1' }
    it('local request with no Origin keeps the no-token bypass for the web app root only (curl, same-origin GET)', async () => {
      expect((await app.inject({ url: '/', headers: LOCAL })).statusCode).not.toBe(401)
      // under /api a request that names nobody is answered nothing, local or not
      expect((await app.inject({ url: '/api/agents', headers: LOCAL })).statusCode).toBe(401)
    })
    it('a foreign Origin loses the local bypass -> 401', async () => {
      expect((await app.inject({ url: '/api/agents', headers: { ...LOCAL, origin: 'https://evil.example.com' } })).statusCode).toBe(401)
    })
    it('Origin: null (sandboxed iframe / opaque) is untrusted -> 401', async () => {
      expect((await app.inject({ url: '/api/agents', headers: { ...LOCAL, origin: 'null' } })).statusCode).toBe(401)
    })
    it('the served SPA (loopback Origin, same port) keeps working with no token', async () => {
      expect((await app.inject({ url: '/', headers: { ...LOCAL, origin: 'http://127.0.0.1:3210' } })).statusCode).not.toBe(401)
    })
    it('the Vite dev server (loopback Origin, other port) keeps working with no token', async () => {
      expect((await app.inject({ url: '/', headers: { ...LOCAL, origin: 'http://localhost:5173' } })).statusCode).not.toBe(401)
    })
    it('a foreign Origin still works WITH a valid token (the ?token=/x-token escape hatch)', async () => {
      expect((await app.inject({ url: '/api/overview', headers: { ...LOCAL, origin: 'https://evil.example.com', 'x-token': TOKEN } })).statusCode).toBe(200)
    })
    it('a state-changing POST from a foreign Origin is rejected (blind CSRF) -> 401', async () => {
      expect(
        (await app.inject({ method: 'POST', url: '/api/sessions/-tmp-project-x/aaa/trash', headers: { ...LOCAL, origin: 'https://evil.example.com' } }))
          .statusCode,
      ).toBe(401)
    })
  })
})

describe('overview', () => {
  // runCause: the overview answers it from one index per request
  // (runCauseIndex) — pinned to what the per-session detail says.
  it('a session whose keep-thread automation is running a caused run carries runCause, in the overview and the detail alike', async () => {
    const financeOf = async () => (await get('/api/overview')).json().agents.find((a: { id: string }) => a.id === 'finance')
    expect((await financeOf()).sessions[0]).not.toHaveProperty('runCause')
    const mk = (id: string, sessionId?: string) =>
      automations.create({
        id,
        name: id,
        agentId: 'finance',
        prompt: 'p',
        trigger: { kind: 'cron', expr: '0 0 * * *' },
        thread: sessionId ? { mode: 'keep', sessionId } : { mode: 'new' },
        approval: false,
        keepAlive: false,
        paused: false,
        createdAt: '2026-10-23T00:00:00Z',
      })
    mk('other', 'zzz')
    automations.appendRun('other', { id: 'r0', automationId: 'other', at: '2026-10-23T09:00:00Z', status: 'running', cause: 'not this one' })
    mk('keeper', 'aaa')
    automations.appendRun('keeper', { id: 'r1', automationId: 'keeper', at: '2026-10-23T09:00:00Z', status: 'running', cause: 'message:m1:builder' })
    const s = (await financeOf()).sessions[0]
    expect(s.id).toBe('aaa')
    expect(s.runCause).toBe('message:m1:builder')
    expect((await get('/api/sessions/-tmp-project-x/aaa')).json().meta.runCause).toBe('message:m1:builder')
    automations.appendRun('keeper', { id: 'r1', automationId: 'keeper', at: '2026-10-23T09:00:00Z', status: 'ok', cause: 'message:m1:builder' })
    expect((await financeOf()).sessions[0]).not.toHaveProperty('runCause')
  })

  // birth: a session an automation run opened carries `origin`; the owner's
  // own never does — the sidebar files the first under its automation.
  it('a session recorded as automation-born carries origin; the rest carry none', async () => {
    let body = (await get('/api/overview')).json()
    let finance = body.agents.find((a: { id: string }) => a.id === 'finance')
    expect(finance.sessions[0].origin).toBeUndefined()
    origins.record('-tmp-project-x/aaa', { kind: 'automation', automationId: 'auto-1', runId: 'run-1', at: '2026-08-29T10:00:00.000Z' })
    body = (await get('/api/overview')).json()
    finance = body.agents.find((a: { id: string }) => a.id === 'finance')
    expect(finance.sessions[0].origin).toEqual({ kind: 'automation', automationId: 'auto-1', runId: 'run-1' })
  })

  // births (plugin 0.7.0): a session an agent launched itself (a `claude
  // -p` from Bash) presented itself at start and Silos holds no native
  // record of it: origin {kind:'nested'} — folded under its parent, never
  // one of the owner's conversations, and not counted as one.
  it('a startup birth marker with no native record makes the session nested', async () => {
    const put = (body: Record<string, unknown>) => {
      mkdirSync(join(base, 'data', 'agent-state', 'finance', 'births'), { recursive: true })
      writeFileSync(
        join(base, 'data', 'agent-state', 'finance', 'births', 'aaa.json'),
        JSON.stringify({ sessionId: 'aaa', agentId: 'finance', cwd: '/tmp/project-x', at: '2026-10-26T10:00:00Z', ...body }),
      )
    }
    put({ parent: 'conv-1', source: 'startup' })
    let finance = (await get('/api/overview')).json().agents.find((a: { id: string }) => a.id === 'finance')
    // conv-1 is not indexed: a parent that can't be verified as finance's is nulled
    expect(finance.sessions[0].origin).toEqual({ kind: 'nested', parent: null, agentId: 'finance' })
    expect(finance.counts.conversations).toBe(0)
    // its parent is not indexed: nothing to fold under — the agent's own
    expect(finance.counts.nestedLoose).toBe(1)
    // Silos launched it (a native record): the owner's, not nested
    native.register('-tmp-project-x', 'aaa', { agentId: 'finance', createdAt: '2026-10-26T10:00:00Z' })
    finance = (await get('/api/overview')).json().agents.find((a: { id: string }) => a.id === 'finance')
    expect(finance.sessions[0].origin).toBeUndefined()
    expect(finance.counts.conversations).toBe(1)
  })

  it('a clear/resume marker is not a birth: the session stays a conversation', async () => {
    mkdirSync(join(base, 'data', 'agent-state', 'finance', 'births'), { recursive: true })
    writeFileSync(
      join(base, 'data', 'agent-state', 'finance', 'births', 'aaa.json'),
      JSON.stringify({ sessionId: 'aaa', agentId: 'finance', parent: 'x', cwd: '/tmp/project-x', source: 'clear', at: '2026-10-26T10:00:00Z' }),
    )
    const finance = (await get('/api/overview')).json().agents.find((a: { id: string }) => a.id === 'finance')
    expect(finance.sessions[0].origin).toBeUndefined()
  })

  it('classifies the session to the agent by cwd+skill', async () => {
    const body = (await get('/api/overview')).json()
    const finance = body.agents.find((a: { id: string }) => a.id === 'finance')
    expect(finance.sessions).toHaveLength(1)
    expect(finance.sessions[0]).toMatchObject({ id: 'aaa', agentId: 'finance', worktree: false, live: false })
    expect(finance.liveCount).toBe(0) // deterministic: the beforeEach set mtime to 1h ago with utimesSync
    const master = body.agents.find((a: { id: string }) => a.id === 'master')
    expect(master.sessions).toHaveLength(0)
  })
})

describe('session detail', () => {
  it('full turns and since', async () => {
    const full = (await get('/api/sessions/-tmp-project-x/aaa')).json()
    expect(full.total).toBe(4)
    expect(full.turns).toHaveLength(4)
    const delta = (await get('/api/sessions/-tmp-project-x/aaa?since=3')).json()
    expect(delta.turns.map((t: { index: number }) => t.index)).toEqual([3])
  })
  it('invalid params -> 400, nonexistent -> 404', async () => {
    expect((await get('/api/sessions/..%2Fbad/aaa')).statusCode).toBe(400)
    expect((await get('/api/sessions/-tmp-project-x/nobody')).statusCode).toBe(404)
  })

  // when serving the detail, every third-voice (interSession) turn carries
  // `agentId` whenever its sender resolves to a known, non-archived agent.
  // This is VIEW-time resolution (the parser doesn't know the registry).
  // No match / archived -> no agentId (plain text in the UI).
  it('detail: a resolved peer sender adds agentId; an unresolved one does not', async () => {
    const peer = (name: string, ts: string) =>
      JSON.stringify({
        type: 'user',
        isMeta: true,
        promptSource: 'system',
        timestamp: ts,
        origin: { kind: 'peer', from: 'uds:/tmp/cc-socks/1.sock', name, body: `hi from ${name}` },
        message: {
          role: 'user',
          content: `Another Claude session sent a message:\n<cross-session-message from="uds:/tmp/cc-socks/1.sock" from-name="${name}">\nhi from ${name}\n</cross-session-message>`,
        },
      })
    // 'FINANCE' matches the agent id/name 'finance'; 'ghost-z9' matches nobody
    writeFileSync(
      join(root, '-tmp-project-x', 'peers.jsonl'),
      peer('FINANCE', '2026-08-20T10:00:00.000Z') + '\n' + peer('ghost-z9', '2026-08-20T10:01:00.000Z') + '\n',
    )
    const idx = claudeSessionIndex(root, join(base, 'data', 'cache2.json'))
    await idx.init()
    const app2 = buildServer({
      index: idx,
      registry,
      store: sessionStore,
      native,
      chat: new ChatService({
        registry,
        native,
        queryFn: () => ({
          async *[Symbol.asyncIterator]() {},
          async interrupt() {
            return undefined
          },
        }),
      }),
      exec: new ExecService(registry),
      complete: new CompleteService(registry, idx),
      prefs: new PrefsStore(join(base, 'data')),
      memory: new MemoryService(root, join(base, 'data'), registry),
      token: TOKEN,
      liveMs: 120_000,
    })
    const detail = (await app2.inject({ url: '/api/sessions/-tmp-project-x/peers', headers: { 'x-token': TOKEN } })).json()
    const inter = detail.turns.filter((t: { interSession?: unknown }) => t.interSession)
    expect(inter).toHaveLength(2)
    expect(inter[0].interSession).toEqual({ from: 'FINANCE', agentId: 'finance' })
    expect(inter[1].interSession).toEqual({ from: 'ghost-z9' }) // no agentId

    // an archived agent -> stops resolving (no link, honestly)
    registry.archive('finance')
    const detail2 = (await app2.inject({ url: '/api/sessions/-tmp-project-x/peers', headers: { 'x-token': TOKEN } })).json()
    const inter2 = detail2.turns.filter((t: { interSession?: unknown }) => t.interSession)
    expect(inter2[0].interSession).toEqual({ from: 'FINANCE' }) // no longer has agentId
    registry.unarchive('finance')
  })
})

describe("conversation refs — a session name or id becomes the conversation's title", () => {
  it("a live session name resolves through claude's lock; an id through the index; the title is the one the sidebar shows", async () => {
    writeFileSync(
      join(base, 'claude-sessions', `${process.pid}.json`),
      JSON.stringify({ pid: process.pid, sessionId: 'aaa', name: 'silos-35', cwd: '/tmp/project-x' }),
    )
    const uuid = '9c62c5c2-88a5-4545-9f5c-13b5bf311b4a'
    cpSync(FIX, join(root, '-tmp-project-x', `${uuid}.jsonl`))
    await index.refresh('-tmp-project-x', uuid)
    await app.inject({
      method: 'POST',
      url: '/api/sessions/-tmp-project-x/aaa/rename',
      headers: { 'x-token': TOKEN },
      payload: { title: 'Fix the reconnect loop' },
    })
    const res = (await get(`/api/conversation-refs?names=silos-35,silos-99&ids=${uuid},00000000-0000-0000-0000-000000000000`)).json()
    expect(res.refs['silos-35']).toEqual({ sessionId: 'aaa', folder: '-tmp-project-x', agentId: 'finance', title: 'Fix the reconnect loop', live: true })
    expect(res.refs[uuid]).toMatchObject({ sessionId: uuid, folder: '-tmp-project-x', agentId: 'finance', live: false })
    // what is not there is not linked
    expect(Object.keys(res.refs).sort()).toEqual([uuid, 'silos-35'].sort())
  })
  it('an id that is no UUID (a session id of any engine) resolves through the index too', async () => {
    // the task page asks here before saying «gone» (the overview is capped):
    // the id's shape is the claim's neutral one, never one engine's prefix
    const id = 'run-abc12345'
    cpSync(FIX, join(root, '-tmp-project-x', `${id}.jsonl`))
    await index.refresh('-tmp-project-x', id)
    const res = (await get(`/api/conversation-refs?ids=${id}`)).json()
    expect(res.refs[id]).toMatchObject({ sessionId: id, folder: '-tmp-project-x', live: false })
  })

  it("a dead holder's name resolves to nothing; malformed tokens are ignored", async () => {
    writeFileSync(join(base, 'claude-sessions', '1.json'), JSON.stringify({ pid: 2 ** 22 + 7, sessionId: 'aaa', name: 'gone-1a' }))
    const res = (await get('/api/conversation-refs?names=gone-1a,../etc&ids=not-a-uuid')).json()
    expect(res.refs).toEqual({})
  })
})

describe('rename + trash', () => {
  it('rename applies an override in overview', async () => {
    await app.inject({ method: 'POST', url: '/api/sessions/-tmp-project-x/aaa/rename', headers: { 'x-token': TOKEN }, payload: { title: 'Renamed' } })
    const body = (await get('/api/overview')).json()
    const finance = body.agents.find((a: { id: string }) => a.id === 'finance')
    expect(finance.sessions[0].title).toBe('Renamed')
    expect(finance.sessions[0].titleOrigin).toBe('manual')
  })
  it('auto-titles: manual > auto > raw precedence with titleOrigin in the view', async () => {
    // with no overrides: the parser's first sentence, origin 'raw'
    let s = (await get('/api/overview')).json().agents.find((a: { id: string }) => a.id === 'finance').sessions[0]
    expect(s.titleOrigin).toBe('raw')
    // a synthesized autoTitle -> wins over raw
    sessionStore.setAutoTitle('-tmp-project-x', 'aaa', 'parser jsonl')
    s = (await get('/api/overview')).json().agents.find((a: { id: string }) => a.id === 'finance').sessions[0]
    expect(s).toMatchObject({ title: 'parser jsonl', titleOrigin: 'auto' })
    // the session detail resolves the same way as overview
    const detail = (await get('/api/sessions/-tmp-project-x/aaa')).json()
    expect(detail.meta).toMatchObject({ title: 'parser jsonl', titleOrigin: 'auto' })
    // a manual rename -> sacred, overrides auto without deleting it
    await app.inject({ method: 'POST', url: '/api/sessions/-tmp-project-x/aaa/rename', headers: { 'x-token': TOKEN }, payload: { title: 'The good one' } })
    s = (await get('/api/overview')).json().agents.find((a: { id: string }) => a.id === 'finance').sessions[0]
    expect(s).toMatchObject({ title: 'The good one', titleOrigin: 'manual' })
    expect(sessionStore.autoTitle('-tmp-project-x', 'aaa')).toBe('parser jsonl') // still there, just hidden
  })
  it('trash removes the session from overview', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/sessions/-tmp-project-x/aaa/trash', headers: { 'x-token': TOKEN } })
    expect(res.json().ok).toBe(true)
    const body = (await get('/api/overview')).json()
    expect(body.agents.every((a: { sessions: unknown[] }) => a.sessions.length === 0)).toBe(true)
  })
  // The live-writer rule's third variant: an SDK turn refuses with 409 and a
  // Silos console is killed+awaited — but a claude OUTSIDE Silos (launched by
  // hand, or orphaned) holding the id via its ~/.claude/sessions lock would
  // keep appending and resurrect the "deleted" JSONL at the old path. Refuse
  // honestly instead.
  it('trash refuses (409) while a live external claude holds the session id, and succeeds once released', async () => {
    writeFileSync(join(base, 'claude-sessions', 'ext.json'), JSON.stringify({ pid: process.pid, sessionId: 'aaa' }))
    const res = await app.inject({ method: 'POST', url: '/api/sessions/-tmp-project-x/aaa/trash', headers: { 'x-token': TOKEN } })
    expect(res.statusCode).toBe(409)
    expect((res.json() as { error: string }).error).toMatch(/outside Silos still holds this conversation/)
    // nothing moved: the session is still listed
    expect(JSON.stringify((await get('/api/overview')).json())).toContain('aaa')
    // the writer goes away -> the same request now succeeds
    rmSync(join(base, 'claude-sessions', 'ext.json'))
    expect((await app.inject({ method: 'POST', url: '/api/sessions/-tmp-project-x/aaa/trash', headers: { 'x-token': TOKEN } })).statusCode).toBe(200)
  })

  it('trash twice in a row -> the second time is 404 (does not exist), not 500', async () => {
    await app.inject({ method: 'POST', url: '/api/sessions/-tmp-project-x/aaa/trash', headers: { 'x-token': TOKEN } })
    const second = await app.inject({ method: 'POST', url: '/api/sessions/-tmp-project-x/aaa/trash', headers: { 'x-token': TOKEN } })
    expect(second.statusCode).toBe(404)
  })
})

// app.inject() (light-my-request) normalizes the path and collapses "/.."
// before routing, so it never reproduces the real attack. A raw HTTP client
// on the socket (like an attacker would use) does not do this: a real
// server listening and an http.request bypassing new URL() are needed.
const rawPost = (port: number, path: string): Promise<{ statusCode: number; body: string }> =>
  new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method: 'POST', headers: { 'x-token': TOKEN } }, (res) => {
      let body = ''
      res.on('data', (c) => {
        body += c
      })
      res.on('end', () => resolve({ statusCode: res.statusCode ?? 0, body }))
    })
    req.on('error', reject)
    req.end()
  })

describe('trash — traversal closed off', () => {
  it('folder=".." -> 400 and nothing moves outside the index', async () => {
    // If this weren't rejected, store.trash would resolve join(root, '..', 'projects.jsonl') === base/projects.jsonl
    const decoy = join(base, 'projects.jsonl')
    writeFileSync(decoy, 'do not touch\n')
    await app.listen({ port: 0, host: '127.0.0.1' })
    const port = (app.server.address() as { port: number }).port
    const res = await rawPost(port, '/api/sessions/../projects/trash')
    await app.close()
    expect(res.statusCode).toBe(400)
    expect(existsSync(decoy)).toBe(true)
    expect(readFileSync(decoy, 'utf8')).toBe('do not touch\n')
  })
  it('id=".." -> 400 and the original session stays intact', async () => {
    // If this weren't rejected, the subdir step would move join(root, '-tmp-project-x', '..') === the whole root
    await app.listen({ port: 0, host: '127.0.0.1' })
    const port = (app.server.address() as { port: number }).port
    const res = await rawPost(port, '/api/sessions/-tmp-project-x/../trash')
    await app.close()
    expect(res.statusCode).toBe(400)
    expect(existsSync(join(root, '-tmp-project-x', 'aaa.jsonl'))).toBe(true)
  })
})

describe('agents CRUD', () => {
  it('create/patch/archive over HTTP', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/agents',
      headers: { 'x-token': TOKEN },
      payload: { id: 'pepe', name: 'Pepe', folder: '/tmp/pepe' },
    })
    expect(created.statusCode).toBe(201)
    const patched = await app.inject({ method: 'PATCH', url: '/api/agents/pepe', headers: { 'x-token': TOKEN }, payload: { emoji: '🦄' } })
    expect(patched.json().agent.emoji).toBe('🦄')
    await app.inject({ method: 'POST', url: '/api/agents/pepe/archive', headers: { 'x-token': TOKEN } })
    const list = (await get('/api/agents')).json()
    expect(list.agents.find((a: { id: string }) => a.id === 'pepe')).toBeUndefined()
    const all = (await get('/api/agents?all=1')).json()
    expect(all.agents.find((a: { id: string }) => a.id === 'pepe').archived).toBe(true)
  })
  it('folders round-trip through POST/PATCH; bad ones are 400', async () => {
    const post = (payload: unknown) => app.inject({ method: 'POST', url: '/api/agents', headers: { 'x-token': TOKEN }, payload: payload as object })
    const ok = await post({ id: 'multi', name: 'Multi', folder: '/tmp/multi', folders: ['/tmp/multi-b'] })
    expect(ok.statusCode).toBe(201)
    expect(ok.json().agent.folders).toEqual(['/tmp/multi-b'])
    expect((await post({ id: 'rel', name: 'R', folder: '/tmp/r', folders: ['r'] })).statusCode).toBe(400)
    expect((await post({ id: 'dup', name: 'D', folder: '/tmp/d', folders: ['/tmp/x', '/tmp/x'] })).statusCode).toBe(400)
    expect((await post({ id: 'many', name: 'M', folder: '/tmp/m', folders: Array.from({ length: 17 }, (_, i) => `/tmp/m${i}`) })).statusCode).toBe(400)
    const patch = (payload: unknown) => app.inject({ method: 'PATCH', url: '/api/agents/multi', headers: { 'x-token': TOKEN }, payload: payload as object })
    expect((await patch({ folders: ['/tmp/multi-c', '/tmp/multi-d'] })).json().agent.folders).toEqual(['/tmp/multi-c', '/tmp/multi-d'])
    expect((await patch({ folders: ['/tmp/multi'] })).statusCode).toBe(400)
    expect((await patch({ folders: ['x'] })).statusCode).toBe(400)
    const m = await app.inject({ method: 'PATCH', url: '/api/agents/master', headers: { 'x-token': TOKEN }, payload: { folders: ['/tmp/z'] } })
    expect(m.statusCode).toBe(400)
    expect(m.json().error).toBe('master has no folders')
    expect((await patch({ folders: ['/'] })).statusCode).toBe(400)
    expect((await get('/api/agents')).json().agents.find((a: { id: string }) => a.id === 'multi').folders).toEqual(['/tmp/multi-c', '/tmp/multi-d'])
  })
  it('validation -> 400 with a message', async () => {
    const bad = await app.inject({ method: 'POST', url: '/api/agents', headers: { 'x-token': TOKEN }, payload: { name: 'X', folder: 'relative/x' } })
    expect(bad.statusCode).toBe(400)
    expect(bad.json().error).toContain('folder must be an absolute path')
  })

  // creation without decisions: the id is the
  // name's slug — the client sends none —, the folder ~/Silos/<id> when none
  // was chosen, and both refusals in their words
  it('the id comes from the name and the folder is derived and made when none was chosen', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/agents', headers: { 'x-token': TOKEN }, payload: { id: 'ignored', name: '  Accounting Ñandú  ' } })
    expect(r.statusCode).toBe(201)
    const a = r.json().agent
    expect(a.id).toBe('accounting-nandu')
    expect(a.name).toBe('Accounting Ñandú')
    expect(a.folder).toMatch(/\/Silos\/accounting-nandu$/)
    expect(existsSync(a.folder)).toBe(true)
    const again = await app.inject({ method: 'POST', url: '/api/agents', headers: { 'x-token': TOKEN }, payload: { name: 'accounting ñandú' } })
    expect(again.statusCode).toBe(409)
    expect(again.json().error).toBe('an agent called accounting ñandú exists — pick another name')
    const empty = await app.inject({ method: 'POST', url: '/api/agents', headers: { 'x-token': TOKEN }, payload: { name: ' ·· ' } })
    expect(empty.statusCode).toBe(400)
    expect(empty.json().error).toBe('name is required — use letters or digits')
  })
})

describe('complete', () => {
  it('files and skills respond with items; a bad kind -> 400', async () => {
    const f = await get('/api/agents/finance/complete?kind=files&q=')
    expect(f.statusCode).toBe(200)
    expect(Array.isArray(f.json().items)).toBe(true)
    const s = await get('/api/agents/finance/complete?kind=skills&q=')
    expect(s.statusCode).toBe(200)
    const bad = await get('/api/agents/finance/complete?kind=zzz&q=')
    expect(bad.statusCode).toBe(400)
    expect(bad.json().error).toBe('invalid kind')
  })
  it('a nonexistent agent -> 404', async () => {
    const r = await get('/api/agents/nobody/complete?kind=files&q=')
    expect(r.statusCode).toBe(404)
  })
})

// the skills catalog WITH descriptions — distinct from /complete?kind=skills
// (that one still returns names only, see above).
describe('skills-catalog', () => {
  it('responds with items carrying name (and description if there is a SKILL.md)', async () => {
    const r = await get('/api/agents/finance/skills-catalog')
    expect(r.statusCode).toBe(200)
    const { skills } = r.json()
    expect(Array.isArray(skills)).toBe(true)
    expect(skills.some((s: { name: string }) => s.name === 'finance-acme')).toBe(true)
  })
  it('a nonexistent agent -> 404', async () => {
    const r = await get('/api/agents/nobody/skills-catalog')
    expect(r.statusCode).toBe(404)
  })
})

describe('silos-skills', () => {
  // the route never touches the real plugin/ dir — a fixture is used instead
  const seedPluginSkillsDir = () => {
    const dir = mkdtempSync(join(tmpdir(), 'plugin-'))
    for (const name of ['responsibility', 'heartbeat', 'team-plan']) {
      mkdirSync(join(dir, name), { recursive: true })
      writeFileSync(join(dir, name, 'SKILL.md'), `# ${name}\n`)
    }
    return dir
  }
  const buildWithSkills = async (pluginSkillsDir: string) => {
    const idx = claudeSessionIndex(root, join(base, 'data', 'cache-skills.json'))
    await idx.init()
    return buildServer({
      index: idx,
      registry,
      store: sessionStore,
      native,
      chat: new ChatService({
        registry,
        native,
        queryFn: () => ({
          async *[Symbol.asyncIterator]() {},
          async interrupt() {
            return undefined
          },
        }),
      }),
      exec: new ExecService(registry),
      complete: new CompleteService(registry, idx),
      prefs: new PrefsStore(join(base, 'data')),
      memory: new MemoryService(root, join(base, 'data'), registry),
      token: TOKEN,
      liveMs: 120_000,
      pluginSkillsDir,
      dataDir: join(base, 'data'),
    })
  }

  it("GET /api/silos-skills lists what add can ever copy — Silos' plugin skills, nothing else", async () => {
    const withSkills = await buildWithSkills(seedPluginSkillsDir())
    const res = await withSkills.inject({ method: 'GET', url: '/api/silos-skills', headers: { 'x-token': TOKEN } })
    expect(res.statusCode).toBe(200)
    expect(res.json().skills.map((s: { name: string }) => s.name)).toEqual(['heartbeat', 'responsibility', 'team-plan'])
  })
})

// Capability states: hold / activate / add act on the agent's
// primary folder and answer with the refreshed catalog. The moves
// themselves are skill-states.test.ts's business — this checks the HTTP
// wiring (404/400 criteria, the catalog in the response, honest words).
describe('skill state routes', () => {
  const buildStates = async () => {
    const dataDir = join(base, 'data')
    const pluginSkillsDir = join(base, 'plugin-src')
    mkdirSync(join(pluginSkillsDir, 'team-plan'), { recursive: true })
    writeFileSync(join(pluginSkillsDir, 'team-plan', 'SKILL.md'), '---\ndescription: Plan work\n---\nx')
    const personalDir = join(base, 'personal-skills')
    mkdirSync(join(personalDir, 'mine'), { recursive: true })
    writeFileSync(join(personalDir, 'mine', 'SKILL.md'), '---\ndescription: Personal\n---\nx')
    const agentFolder = join(base, 'states-target')
    mkdirSync(join(agentFolder, '.claude', 'skills', 'heartbeat'), { recursive: true })
    writeFileSync(join(agentFolder, '.claude', 'skills', 'heartbeat', 'SKILL.md'), '---\ndescription: Beat\n---\nx')
    registry.create({ id: 'states', name: 'States', folder: agentFolder })
    const idx = claudeSessionIndex(root, join(base, 'data', 'cache-states.json'))
    await idx.init()
    const { heldSkills } = await import('../src/skill-states.js')
    const app2 = buildServer({
      index: idx,
      registry,
      store: sessionStore,
      native,
      chat: new ChatService({
        registry,
        native,
        queryFn: () => ({
          async *[Symbol.asyncIterator]() {},
          async interrupt() {
            return undefined
          },
        }),
      }),
      // the two engines' skill loads, as their harness traits declare them:
      // OpenCode is handed Silos' plugin skills as a launch root
      exec: new ExecService(registry),
      complete: new CompleteService(
        registry,
        idx,
        personalDir,
        (f) => heldSkills(dataDir, f),
        (a) => (a.framework === 'opencode' ? { claudePlugins: false, roots: [{ plugin: 'silos', dir: pluginSkillsDir }] } : { claudePlugins: true }),
        pluginSkillsDir,
      ),
      prefs: new PrefsStore(join(base, 'data')),
      memory: new MemoryService(root, join(base, 'data'), registry),
      token: TOKEN,
      liveMs: 120_000,
      pluginSkillsDir,
      dataDir,
    })
    const post = (url: string) => app2.inject({ method: 'POST', url, headers: { 'x-token': TOKEN } })
    const get = (url: string) => app2.inject({ method: 'GET', url, headers: { 'x-token': TOKEN } })
    return { post, get, dataDir, agentFolder, personalDir, pluginSkillsDir }
  }

  it('hold moves the folder copy to the held store and the refreshed catalog says held; activate brings it back', async () => {
    const { post, dataDir, agentFolder } = await buildStates()
    const r1 = await post('/api/agents/states/skills/heartbeat/hold')
    expect(r1.statusCode).toBe(200)
    expect(existsSync(join(agentFolder, '.claude', 'skills', 'heartbeat'))).toBe(false)
    expect(existsSync(join(dataDir, 'skills-held'))).toBe(true)
    const held = r1.json().skills.find((s: { name: string }) => s.name === 'heartbeat' && s.state === 'held')
    expect(held).toEqual({ name: 'heartbeat', description: 'Beat', state: 'held' })
    const r2 = await post('/api/agents/states/skills/heartbeat/activate')
    expect(r2.statusCode).toBe(200)
    expect(existsSync(join(agentFolder, '.claude', 'skills', 'heartbeat', 'SKILL.md'))).toBe(true)
    expect(r2.json().skills.find((s: { name: string }) => s.name === 'heartbeat')?.state).toBe('active')
  })

  it('add copies a plugin skill into the folder; a personal skill is refused with honest words', async () => {
    const { post, agentFolder } = await buildStates()
    const r1 = await post('/api/agents/states/skills/team-plan/add')
    expect(r1.statusCode).toBe(200)
    expect(existsSync(join(agentFolder, '.claude', 'skills', 'team-plan', 'SKILL.md'))).toBe(true)
    expect(r1.json().skills.find((s: { name: string }) => s.name === 'team-plan')?.state).toBe('active')
    const r2 = await post('/api/agents/states/skills/mine/add')
    expect(r2.statusCode).toBe(400)
    expect(r2.json().error).toContain('already applies everywhere')
  })

  it('the offer and the gesture agree: every available entry adds; nothing else (seen, active, held) does — and a refusal writes nothing', async () => {
    const { post, agentFolder } = await buildStates()
    // a name only declared on an agent, and another agent's folder skill seen in no transcript
    registry.create({ id: 'other', name: 'Other', folder: join(base, 'other-folder'), skills: ['declared-only'] })
    const get = async () => (await post('/api/agents/states/skills/heartbeat/hold')).json().skills as { name: string; state: string; source?: string }[]
    const catalog = await get()
    await post('/api/agents/states/skills/heartbeat/activate')
    const available = catalog.filter((s) => s.state === 'available')
    expect(available.map((s) => [s.name, s.source])).toEqual([['team-plan', 'silos']])
    const declared = catalog.find((s) => s.name === 'declared-only')
    expect(declared?.state).toBe('seen')
    const refused = await post('/api/agents/states/skills/declared-only/add')
    expect(refused.statusCode).toBe(400)
    expect(refused.json().error).toContain("not one of Silos' plugin skills")
    expect(existsSync(join(agentFolder, '.claude', 'skills', 'declared-only'))).toBe(false)
    // active: already loads
    const again = await post('/api/agents/states/skills/heartbeat/add')
    expect(again.statusCode).toBe(400)
    expect(again.json().error).toContain('already loads in this folder')
    for (const s of available) expect((await post(`/api/agents/states/skills/${s.name}/add`)).statusCode).toBe(200)
  })

  it('a held Silos skill: add refuses (turn it on instead)', async () => {
    const { post, agentFolder, dataDir } = await buildStates()
    await post('/api/agents/states/skills/team-plan/add')
    await post('/api/agents/states/skills/team-plan/hold')
    const r = await post('/api/agents/states/skills/team-plan/add')
    expect(r.statusCode).toBe(400)
    expect(r.json().error).toContain('turn it on instead')
    void dataDir
    expect(existsSync(join(agentFolder, '.claude', 'skills', 'team-plan'))).toBe(false)
  })

  it('unknown agent -> 404; master (no folder) -> 400; an invalid name -> 400; a missing skill names itself', async () => {
    const { post } = await buildStates()
    expect((await post('/api/agents/nobody/skills/x/hold')).statusCode).toBe(404)
    const master = await post('/api/agents/master/skills/x/hold')
    expect(master.statusCode).toBe(400)
    expect(master.json().error).toBe('agent has no folder')
    // '..' itself never reaches the handler (the router collapses dot
    // segments, same as the other skill routes) — '...' does, and PURE_DOTS
    // closes it
    expect((await post('/api/agents/states/skills/.../hold')).statusCode).toBe(400)
    const missing = await post('/api/agents/states/skills/ghost/hold')
    expect(missing.statusCode).toBe(400)
    expect(missing.json().error).toContain('nothing to turn off')
  })

  // a folder copy whose personal twin loads changes nothing when held (Claude
  // Code runs the personal one instead; OpenCode would have to deny the NAME,
  // turning the personal skill off — never done): refused, in words
  it('hold refuses a folder copy whose personal twin loads — plain words, nothing moved', async () => {
    const { post, agentFolder } = await buildStates()
    mkdirSync(join(agentFolder, '.claude', 'skills', 'mine'), { recursive: true })
    writeFileSync(join(agentFolder, '.claude', 'skills', 'mine', 'SKILL.md'), '---\ndescription: Folder copy\n---\nx')
    const r = await post('/api/agents/states/skills/mine/hold')
    expect(r.statusCode).toBe(400)
    expect(r.json().error).toContain('also exists as your personal skill')
    expect(existsSync(join(agentFolder, '.claude', 'skills', 'mine', 'SKILL.md'))).toBe(true)
  })

  // the new-agent picker offers EXACTLY what add will accept for that agent
  // (engine + folder), from the same catalog rule — and says why for the rest
  describe("GET /api/silos-skills?framework=&folder= — the draft agent's offer", () => {
    it('Claude Code: offered = what add accepts; a folder copy and a personal twin are not offered, each with its reason', async () => {
      const { get, post, agentFolder, personalDir, pluginSkillsDir } = await buildStates()
      for (const n of ['heartbeat', 'mine']) {
        mkdirSync(join(pluginSkillsDir, n), { recursive: true })
        writeFileSync(join(pluginSkillsDir, n, 'SKILL.md'), `---\ndescription: ${n}\n---\nx`)
      }
      const r = await get(`/api/silos-skills?framework=claude-code&folder=${encodeURIComponent(agentFolder)}`)
      expect(r.statusCode).toBe(200)
      expect(r.json().skills).toEqual([{ name: 'team-plan', description: 'Plan work' }])
      const why = Object.fromEntries((r.json().notOffered as { name: string; why: string }[]).map((x) => [x.name, x.why]))
      expect(why.heartbeat).toContain('already loads in this folder')
      expect(why.mine).toContain('personal skill')
      expect(existsSync(join(personalDir, 'mine'))).toBe(true)
      // every offered one adds for an agent on that folder; every refused one is refused
      for (const s of r.json().skills as { name: string }[]) expect((await post(`/api/agents/states/skills/${s.name}/add`)).statusCode).toBe(200)
      for (const n of Object.keys(why)) expect((await post(`/api/agents/states/skills/${n}/add`)).statusCode).toBe(400)
    })

    it('OpenCode: nothing is offered — every Silos skill already loads from the launch root — and the add route agrees', async () => {
      const { get, post, agentFolder } = await buildStates()
      const r = await get(`/api/silos-skills?framework=opencode&folder=${encodeURIComponent(agentFolder)}`)
      expect(r.json().skills).toEqual([])
      expect(r.json().notOffered).toContainEqual({ name: 'team-plan', why: expect.stringContaining("handed Silos' skills at every launch") })
      registry.create({ id: 'oc-agent', name: 'Oc', folder: agentFolder, framework: 'opencode' })
      const add = await post('/api/agents/oc-agent/skills/team-plan/add')
      expect(add.statusCode).toBe(400)
      expect(add.json().error).toContain("handed Silos' skills at every launch")
    })

    it('a draft without a folder is offered nothing (add needs one); a relative folder is a 400; the bare route stays the inventory', async () => {
      const { get } = await buildStates()
      const none = await get('/api/silos-skills?framework=claude-code&folder=')
      expect(none.json().skills).toEqual([])
      expect(none.json().notOffered[0].why).toContain('pick a folder first')
      expect((await get('/api/silos-skills?framework=claude-code&folder=rel/path')).statusCode).toBe(400)
      expect((await get('/api/silos-skills')).json().skills.map((s: { name: string }) => s.name)).toEqual(['team-plan'])
    })
  })
})

describe('muted', () => {
  it('no token -> 401; with a token -> 200 with the array passed via deps', async () => {
    expect((await app.inject({ url: '/api/muted', headers: REMOTE })).statusCode).toBe(401)
    const r = await get('/api/muted')
    expect(r.statusCode).toBe(200)
    expect(Array.isArray(r.json().muted)).toBe(true)
  })
})

describe('prefs', () => {
  it('no token -> 401 (the same global hook as the rest of /api)', async () => {
    expect((await app.inject({ url: '/api/prefs', headers: REMOTE })).statusCode).toBe(401)
    expect((await app.inject({ method: 'PATCH', url: '/api/prefs', payload: { projects: {} }, headers: REMOTE })).statusCode).toBe(401)
  })

  it('GET with no file -> {}', async () => {
    expect((await get('/api/prefs')).json()).toEqual({})
  })

  it('PATCH applies and GET reflects the merge', async () => {
    const first = await app.inject({
      method: 'PATCH',
      url: '/api/prefs',
      headers: { 'x-token': TOKEN },
      payload: { projects: { order: ['x', 'y'], pinned: ['x'] } },
    })
    expect(first.statusCode).toBe(200)
    expect(first.json()).toEqual({ projects: { order: ['x', 'y'], pinned: ['x'] } })

    const second = await app.inject({
      method: 'PATCH',
      url: '/api/prefs',
      headers: { 'x-token': TOKEN },
      payload: { projects: { collapsed: ['-x'] } },
    })
    expect(second.json()).toEqual({ projects: { order: ['x', 'y'], pinned: ['x'], collapsed: ['-x'] } })

    expect((await get('/api/prefs')).json()).toEqual(second.json())
  })

  it('PATCH with an invalid shape -> 400', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/prefs',
      headers: { 'x-token': TOKEN },
      payload: { projects: { order: 'no-array' } },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toContain('projects.order must be an array of strings')
  })

  // the PATCH accepts projects/contextOpen/notifications/terminal/
  // collapsedAgents/agentOrder/detachedChains/setup/uses — the 400
  // only fires if NONE of them are sent (see PATCH /api/prefs in server.ts).
  it('PATCH with none of the fields -> 400', async () => {
    const res = await app.inject({ method: 'PATCH', url: '/api/prefs', headers: { 'x-token': TOKEN }, payload: {} })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toBe(
      'projects, contextOpen, notifications, consoleTheme, terminal, collapsedAgents, collapsedAutomations, contextScope, agentOrder, conversationOrder, conversationSlots, detachedChains, setup, or uses required',
    )
  })

  // uses — Map › Uses' axes and window.
  it('PATCH with `uses` applies and GET reflects it', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/prefs',
      headers: { 'x-token': TOKEN },
      payload: { uses: { rows: 'project', cols: 'file' } },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ uses: { rows: 'project', cols: 'file' } })
    expect((await get('/api/prefs')).json()).toEqual({ uses: { rows: 'project', cols: 'file' } })
  })

  // `setup` — the "Agent setup" zone of the context column.
  it('PATCH with `setup` applies and GET reflects it', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/prefs',
      headers: { 'x-token': TOKEN },
      payload: { setup: true },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ setup: true })
    expect((await get('/api/prefs')).json()).toEqual({ setup: true })
  })

  it('PATCH with `collapsedAgents` applies and GET reflects it', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/prefs',
      headers: { 'x-token': TOKEN },
      payload: { collapsedAgents: ['a1', 'b2'] },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ collapsedAgents: ['a1', 'b2'] })
    expect((await get('/api/prefs')).json()).toEqual({ collapsedAgents: ['a1', 'b2'] })
  })

  it('PATCH with `agentOrder` applies and GET reflects it', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/prefs',
      headers: { 'x-token': TOKEN },
      payload: { agentOrder: ['b2', 'a1'] },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ agentOrder: ['b2', 'a1'] })
    expect((await get('/api/prefs')).json()).toEqual({ agentOrder: ['b2', 'a1'] })
  })

  it('PATCH with `contextScope` applies and GET reflects it; anything outside the four radii is a 400', async () => {
    const res = await app.inject({ method: 'PATCH', url: '/api/prefs', headers: { 'x-token': TOKEN }, payload: { contextScope: 'agent' } })
    expect(res.statusCode).toBe(200)
    expect((await get('/api/prefs')).json()).toEqual({ contextScope: 'agent' })
    for (const bad of ['global', '', 1, null, ['agent']]) {
      const r = await app.inject({ method: 'PATCH', url: '/api/prefs', headers: { 'x-token': TOKEN }, payload: { contextScope: bad } })
      expect(r.statusCode).toBe(400)
    }
  })

  it('PATCH with `collapsedAutomations` applies and GET reflects it', async () => {
    const res = await app.inject({ method: 'PATCH', url: '/api/prefs', headers: { 'x-token': TOKEN }, payload: { collapsedAutomations: ['a1'] } })
    expect(res.statusCode).toBe(200)
    expect((await get('/api/prefs')).json()).toEqual({ collapsedAutomations: ['a1'] })
  })

  it('PATCH with `conversationOrder` (agentId → chain keys) applies and GET reflects it; a bad shape is a 400', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/prefs',
      headers: { 'x-token': TOKEN },
      payload: { conversationOrder: { a1: ['f/s2', 'f/s1'], master: [] } },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ conversationOrder: { a1: ['f/s2', 'f/s1'], master: [] } })
    expect((await get('/api/prefs')).json()).toEqual({ conversationOrder: { a1: ['f/s2', 'f/s1'], master: [] } })
    for (const bad of [['f/s1'], { a1: 'f/s1' }, { a1: [1] }, 'x']) {
      const r = await app.inject({ method: 'PATCH', url: '/api/prefs', headers: { 'x-token': TOKEN }, payload: { conversationOrder: bad } })
      expect(r.statusCode).toBe(400)
    }
  })

  // a tab sends only the agent whose list changed; another
  // agent's stored order must survive it (a whole-map replace let a tab
  // with a stale or empty map erase every other agent's order).
  it('PATCH `conversationOrder` merges per agent — agents not in the patch keep their order', async () => {
    const patch = (conversationOrder: unknown) =>
      app.inject({ method: 'PATCH', url: '/api/prefs', headers: { 'x-token': TOKEN }, payload: { conversationOrder } })
    expect((await patch({ a1: ['f/s1'], b2: ['g/x', 'g/y'] })).statusCode).toBe(200)
    const res = await patch({ a1: ['f/s2', 'f/s1'] })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ conversationOrder: { a1: ['f/s2', 'f/s1'], b2: ['g/x', 'g/y'] } })
    expect((await get('/api/prefs')).json()).toEqual({ conversationOrder: { a1: ['f/s2', 'f/s1'], b2: ['g/x', 'g/y'] } })
  })

  // conversations dragged to a fixed position in an agent's list.
  it('PATCH `conversationSlots` merges per agent and GET reflects it; a bad shape is a 400', async () => {
    const patch = (conversationSlots: unknown) =>
      app.inject({ method: 'PATCH', url: '/api/prefs', headers: { 'x-token': TOKEN }, payload: { conversationSlots } })
    expect((await patch({ a1: [{ key: 'f/s1', at: 0 }], b2: [{ key: 'g/x', at: 3 }] })).statusCode).toBe(200)
    const res = await patch({ a1: [] })
    expect(res.json()).toEqual({ conversationSlots: { a1: [], b2: [{ key: 'g/x', at: 3 }] } })
    expect((await get('/api/prefs')).json()).toEqual({ conversationSlots: { a1: [], b2: [{ key: 'g/x', at: 3 }] } })
    for (const bad of [['f/s1'], { a1: 'f/s1' }, { a1: ['f/s1'] }, { a1: [{ key: 'f/s1', at: -1 }] }, { a1: [{ key: 'f/s1', at: 1.5 }] }, 'x']) {
      expect((await patch(bad)).statusCode).toBe(400)
    }
  })

  it('PATCH with `detachedChains` applies and GET reflects it', async () => {
    const res = await app.inject({ method: 'PATCH', url: '/api/prefs', headers: { 'x-token': TOKEN }, payload: { detachedChains: ['f/s2'] } })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ detachedChains: ['f/s2'] })
    expect((await get('/api/prefs')).json()).toEqual({ detachedChains: ['f/s2'] })
  })

  it('PATCH with `terminal` applies and GET reflects it', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/prefs',
      headers: { 'x-token': TOKEN },
      payload: { terminal: { height: 300 } },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ terminal: { height: 300 } })
    expect((await get('/api/prefs')).json()).toEqual({ terminal: { height: 300 } })
  })

  it('PATCH with `notifications` applies and GET reflects it', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/prefs',
      headers: { 'x-token': TOKEN },
      payload: { notifications: true },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ notifications: true })
    expect((await get('/api/prefs')).json()).toEqual({ notifications: true })
  })

  it('PATCH with `contextOpen` persists and it comes back on GET', async () => {
    const patch = await app.inject({ method: 'PATCH', url: '/api/prefs', headers: { 'x-token': TOKEN }, payload: { contextOpen: false } })
    expect(patch.statusCode).toBe(200)
    expect(patch.json().contextOpen).toBe(false)
    const get = await app.inject({ method: 'GET', url: '/api/prefs', headers: { 'x-token': TOKEN } })
    expect(get.json().contextOpen).toBe(false)
  })
})

describe('native owner', () => {
  it('overview hangs the session off the native owner even when skills point at another agent', async () => {
    // a second agent in the same folder as finance but without its skills — the
    // default classification (classify) would still hang the session off
    // finance by skills
    registry.create({ id: 'finance2', name: 'CFO2', folder: '/tmp/project-x' })
    native.register('-tmp-project-x', 'aaa', { agentId: 'finance2', createdAt: 'x' })
    const body = (await get('/api/overview')).json()
    const finance = body.agents.find((a: { id: string }) => a.id === 'finance')
    const finance2 = body.agents.find((a: { id: string }) => a.id === 'finance2')
    expect(finance.sessions).toHaveLength(0)
    expect(finance2.sessions).toHaveLength(1)
    expect(finance2.sessions[0].id).toBe('aaa')
  })
})

// c7: the raw document endpoint — serves the idx-th document block pasted
// into the conversation, decoded, with its real media type. The transcript
// carries no filename, so the index (order of appearance) is the address.
describe('documents — raw viewer endpoint', () => {
  const PDF_BYTES = Buffer.from('%PDF-1.4 tiny')
  beforeEach(async () => {
    const doc = {
      type: 'user',
      timestamp: '2026-08-12T19:29:56.477Z',
      message: { role: 'user', content: [{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: PDF_BYTES.toString('base64') } }] },
    }
    writeFileSync(join(root, '-tmp-project-x', 'docs.jsonl'), JSON.stringify(doc) + '\n')
  })

  it('serves the document bytes with its media type; out-of-range -> 404', async () => {
    const res = await app.inject({ url: '/api/sessions/-tmp-project-x/docs/documents/0', headers: { 'x-token': TOKEN } })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toBe('application/pdf')
    expect(res.rawPayload.equals(PDF_BYTES)).toBe(true)
    expect((await app.inject({ url: '/api/sessions/-tmp-project-x/docs/documents/1', headers: { 'x-token': TOKEN } })).statusCode).toBe(404)
    expect((await app.inject({ url: '/api/sessions/-tmp-project-x/nope/documents/0', headers: { 'x-token': TOKEN } })).statusCode).toBe(404)
  })

  it('a document replayed inside an api-request-blob never shifts the index (same numbering as the context column)', async () => {
    const other = Buffer.from('%PDF-1.4 second')
    const blob = {
      type: 'api-request-blob',
      message: {
        role: 'user',
        content: [{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: Buffer.from('%PDF blob').toString('base64') } }],
      },
    }
    const real = {
      type: 'user',
      timestamp: 't',
      message: { role: 'user', content: [{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: other.toString('base64') } }] },
    }
    writeFileSync(join(root, '-tmp-project-x', 'blobdocs.jsonl'), [blob, real].map((o) => JSON.stringify(o)).join('\n') + '\n')
    const res = await app.inject({ url: '/api/sessions/-tmp-project-x/blobdocs/documents/0', headers: { 'x-token': TOKEN } })
    expect(res.statusCode).toBe(200)
    expect(res.rawPayload.equals(other)).toBe(true)
    expect((await app.inject({ url: '/api/sessions/-tmp-project-x/blobdocs/documents/1', headers: { 'x-token': TOKEN } })).statusCode).toBe(404)
  })

  it('rejects a non-numeric index and traversal params', async () => {
    expect((await app.inject({ url: '/api/sessions/-tmp-project-x/docs/documents/x', headers: { 'x-token': TOKEN } })).statusCode).toBe(400)
    expect((await app.inject({ url: '/api/sessions/..%2Fbad/docs/documents/0', headers: { 'x-token': TOKEN } })).statusCode).toBe(400)
  })

  // the media_type comes from the transcript — untrusted. A text/html
  // "document" must NEVER render as the Silos origin (XSS): non-inert
  // types download as an opaque attachment, and every response carries
  // nosniff + a sandboxing CSP.
  it('a text/html document is served as an opaque download, never rendered; inert responses carry nosniff', async () => {
    const evil = {
      type: 'user',
      timestamp: 't',
      message: {
        role: 'user',
        content: [{ type: 'document', source: { type: 'base64', media_type: 'text/html', data: Buffer.from('<script>alert(1)</script>').toString('base64') } }],
      },
    }
    writeFileSync(join(root, '-tmp-project-x', 'evil.jsonl'), JSON.stringify(evil) + '\n')
    const res = await app.inject({ url: '/api/sessions/-tmp-project-x/evil/documents/0', headers: { 'x-token': TOKEN } })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('application/octet-stream')
    expect(res.headers['content-disposition']).toBe('attachment')
    expect(res.headers['x-content-type-options']).toBe('nosniff')
    expect(res.headers['content-security-policy']).toContain('sandbox')
    // and the inert pdf keeps its type but also carries the guards
    const pdf = await app.inject({ url: '/api/sessions/-tmp-project-x/docs/documents/0', headers: { 'x-token': TOKEN } })
    expect(pdf.headers['content-type']).toBe('application/pdf')
    expect(pdf.headers['x-content-type-options']).toBe('nosniff')
  })
})

// c1: the global background-work view — every recent session's subagents
// in one call. Only sessions that HAVE subagents appear; newest background
// activity first. The census per session is the same listSubagents the
// context column already trusts.
describe('tasks — global background work', () => {
  it('lists recent sessions with their subagents, titled, newest sub-activity first', async () => {
    const dir = join(root, '-tmp-project-x', 'aaa', 'subagents')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'agent-abc123.jsonl'), '{}\n')
    writeFileSync(join(dir, 'agent-abc123.meta.json'), JSON.stringify({ description: 'Verify finding 3', agentType: 'general-purpose' }))
    const res = await get('/api/tasks')
    expect(res.statusCode).toBe(200)
    const body = res.json() as {
      sessions: { folder: string; id: string; title: string; agentId: string; subagents: { id: string; description: string | null }[] }[]
    }
    expect(body.sessions).toHaveLength(1)
    expect(body.sessions[0]).toMatchObject({ folder: '-tmp-project-x', id: 'aaa', agentId: 'finance' })
    expect(body.sessions[0]!.subagents[0]).toMatchObject({ id: 'abc123', description: 'Verify finding 3', type: 'general-purpose' })
  })

  it('a session with no subagents dir does not appear', async () => {
    const res = await get('/api/tasks')
    expect((res.json() as { sessions: unknown[] }).sessions).toEqual([])
  })
})

describe("overview — the per-agent cap never hides the owner's conversations", () => {
  // Builder had 1,347 conversations and the sidebar read "No conversations yet":
  // the overview kept the 40 most recent sessions per agent and ALL of them
  // were automation runs (one every hour), so every human conversation fell
  // off the end before the client could split runs from conversations.
  // The cap is per kind: conversations and runs are trimmed apart, and runs
  // are trimmed per automation (the sidebar files them under their automation).
  it("keeps the owner's older conversation when the newest 40+ sessions are all runs", async () => {
    const dir = join(root, '-tmp-project-x')
    const base = Date.now() / 1000
    for (let i = 0; i < 45; i++) {
      const id = `run-${String(i).padStart(2, '0')}`
      cpSync(FIX, join(dir, `${id}.jsonl`))
      const t = base - 60 * (45 - i) // (the view's mtime is the transcript's own clock — all 46 tie; the point is the count)
      utimesSync(join(dir, `${id}.jsonl`), t, t)
      origins.record(`-tmp-project-x/${id}`, {
        kind: 'automation',
        automationId: i % 2 === 0 ? 'auto-a' : 'auto-b',
        runId: `r${i}`,
        at: new Date(t * 1000).toISOString(),
      })
      await index.refresh('-tmp-project-x', id, false)
    }
    const body = (await get('/api/overview')).json()
    const finance = body.agents.find((a: { id: string }) => a.id === 'finance')
    expect(finance.sessionCount).toBe(46)
    const human = finance.sessions.filter((s: { origin?: unknown }) => s.origin === undefined)
    expect(human.map((s: { id: string }) => s.id)).toEqual(['aaa'])
    const runs = finance.sessions.filter((s: { origin?: unknown }) => s.origin !== undefined)
    const perAutomation = new Map<string, number>()
    for (const r of runs) perAutomation.set(r.origin.automationId, (perAutomation.get(r.origin.automationId) ?? 0) + 1)
    expect(perAutomation.get('auto-a')).toBe(10)
    expect(perAutomation.get('auto-b')).toBe(10)
    // the totals are UNCAPPED and split by kind — "N conversations" never
    // counts runs, and an automation's badge never reads min(10, n)
    expect(finance.counts).toMatchObject({ conversations: 1, runs: 45, runsByAutomation: { 'auto-a': 23, 'auto-b': 22 } })
    expect(
      Object.values(finance.counts.byCwd as Record<string, { conversations: number; runs: number }>).reduce((n, c) => n + c.conversations + c.runs, 0),
    ).toBe(46)
  })
})

// A conversation Silos opened for one urgent message:
// origin message — a conversation anyone can continue, but never the
// owner's unread, never counted among the owner's conversations.
describe('a message conversation (origin message)', () => {
  const born = { kind: 'message' as const, agentId: 'finance', messageId: 'm1', from: 'builder', gist: 'Close Q3', at: '2026-11-02T10:00:00.000Z' }
  it('carries origin message in the overview, counts apart, and is never unread', async () => {
    const withSeen = buildServer({ ...appDeps(), seen: new SeenStore(join(base, 'data')) })
    try {
      const before = (await withSeen.inject({ url: '/api/overview', headers: { 'x-token': TOKEN } }))
        .json()
        .agents.find((a: { id: string }) => a.id === 'finance')
      expect(before.sessions[0].unread).toBe(true)
      origins.record('-tmp-project-x/aaa', born)
      const finance = (await withSeen.inject({ url: '/api/overview', headers: { 'x-token': TOKEN } }))
        .json()
        .agents.find((a: { id: string }) => a.id === 'finance')
      expect(finance.sessions[0].origin).toEqual({ kind: 'message', messageId: 'm1', from: 'builder', gist: 'Close Q3' })
      expect(finance.sessions[0].unread).toBe(false)
      expect(finance.counts.conversations).toBe(0)
      expect(finance.counts.runs).toBe(0)
      expect(finance.counts.messageConversations).toBe(1)
    } finally {
      await withSeen.close()
    }
  })

  it('is not a transcript: its console is not refused as a run', async () => {
    origins.record('-tmp-project-x/aaa', born)
    const res = await app.inject({ method: 'POST', url: '/api/console', headers: { 'x-token': TOKEN }, payload: { id: 'aaa' } })
    expect(res.json()?.error ?? '').not.toMatch(/automation run/)
  })
})

// Two writers on one transcript — a console never opens over a
// session a chat turn (the SDK) is writing right now.
describe('POST /api/console — a session a chat turn is writing', () => {
  it('answers 409 «a conversation is working in it»', async () => {
    const spy = vi.spyOn(ChatService.prototype, 'isSessionActive').mockImplementation((id: string) => id === 'aaa')
    try {
      const res = await app.inject({ method: 'POST', url: '/api/console', headers: { 'x-token': TOKEN }, payload: { id: 'aaa' } })
      expect(res.statusCode).toBe(409)
      expect(res.json()).toEqual({ error: 'a conversation is working in it', working: true })
    } finally {
      spy.mockRestore()
    }
  })
})

describe('POST /api/console — a run born from an automation never gets a console', () => {
  // runs are transcripts: a --resume console on a run would make it one of
  // the owner's threads (and spawn a claude for something nobody is driving).
  it('answers 409 naming the automation', async () => {
    origins.record('-tmp-project-x/aaa', { kind: 'automation', automationId: 'auto-1', runId: 'run-1', at: '2026-10-18T10:00:00.000Z' })
    const res = await app.inject({ method: 'POST', url: '/api/console', headers: { 'x-token': TOKEN }, payload: { id: 'aaa' } })
    expect(res.statusCode).toBe(409)
    expect(res.json()).toMatchObject({ error: expect.stringMatching(/automation run/), automationId: 'auto-1' })
  })

  // the same rule on the chat engine (one rule, transcriptOnly)
  it('a chat turn into an automation run is refused the same way', async () => {
    origins.record('-tmp-project-x/aaa', { kind: 'automation', automationId: 'auto-1', runId: 'run-1', at: '2026-10-18T10:00:00.000Z' })
    const res = await app.inject({
      method: 'POST',
      url: '/api/agents/finance/chat',
      headers: { 'x-token': TOKEN },
      payload: { text: 'hello', session: { folder: '-tmp-project-x', id: 'aaa' } },
    })
    expect(res.statusCode).toBe(409)
    expect(res.json()).toMatchObject({ error: expect.stringMatching(/automation run/), automationId: 'auto-1' })
  })
})

describe('POST /api/console — only a MORE RECENTLY ACTIVE descendant makes a session an ancestor', () => {
  // a live console with a recorded child OLDER than it (an SDK
  // fork born at once by an old bug) 409'd and pushed the client through
  // the stale child. The tip is the most recently active of the session
  // and its descendants (content activity, the index's mtime).
  const childFrom = async (id: string, day: string) => {
    const text = readFileSync(FIX, 'utf8').replaceAll('2026-08-17', day)
    writeFileSync(join(root, '-tmp-project-x', `${id}.jsonl`), text)
    await index.refresh('-tmp-project-x', id, false)
  }

  it('an OLDER child does not 409 its parent', async () => {
    await childFrom('old', '2026-08-16')
    lineage.record('-tmp-project-x/old', '-tmp-project-x/aaa')
    const res = await app.inject({ method: 'POST', url: '/api/console', headers: { 'x-token': TOKEN }, payload: { id: 'aaa' } })
    // past the lineage guard (the test folder isn't a real cwd → 400, nothing spawns)
    expect(res.statusCode).not.toBe(409)
  })

  // opening the stale fork reattached the THREAD's console
  // (consoleKeyFor walks to the root), painting the live conversation under
  // both rows. The fork is not the thread's tip → transcript.
  it("the OLDER child itself 409s, naming the thread's tip (its parent)", async () => {
    await childFrom('old', '2026-08-16')
    lineage.record('-tmp-project-x/old', '-tmp-project-x/aaa')
    const res = await app.inject({ method: 'POST', url: '/api/console', headers: { 'x-token': TOKEN }, payload: { id: 'old' } })
    expect(res.statusCode).toBe(409)
    expect(res.json()).toMatchObject({ tip: '-tmp-project-x/aaa' })
  })

  // ...and trashing that fork must never kill the thread's live console
  // (it would have killed the owner's own).
  it("trashing the OLDER child kills no console; trashing the thread's tip does", async () => {
    await childFrom('old', '2026-08-16')
    lineage.record('-tmp-project-x/old', '-tmp-project-x/aaa')
    const kill = vi.spyOn(terminals, 'killConsoleAndWait').mockResolvedValue()
    const r1 = await app.inject({ method: 'POST', url: '/api/sessions/-tmp-project-x/old/trash', headers: { 'x-token': TOKEN } })
    expect(r1.statusCode).toBeLessThan(300)
    expect(kill).not.toHaveBeenCalled()
    const r2 = await app.inject({ method: 'POST', url: '/api/sessions/-tmp-project-x/aaa/trash', headers: { 'x-token': TOKEN } })
    expect(r2.statusCode).toBeLessThan(300)
    expect(kill).toHaveBeenCalledWith('aaa')
    kill.mockRestore()
  })

  // the real split: a console relaunch made the engine write a --resume twin
  // linked ONLY by its own derived-from record (no lineage entry), and chat
  // then forked the twin (a lineage entry). The tip walk crossed only
  // lineage entries: from the root it stopped at the root, refused the real
  // tip with «continues in a newer conversation», and the web sent the
  // owner straight back to it.
  it('a twin linked only by its transcript still carries the thread down to its real tip', async () => {
    const day = (d: string) => readFileSync(FIX, 'utf8').replaceAll('2026-08-17', d)
    writeFileSync(
      join(root, '-tmp-project-x', 'twin.jsonl'),
      `${JSON.stringify({ type: 'derived-from', v: 1, sessionId: 'twin', sessions: [{ type: 'claude_code_session', id: 'aaa', via: 'fork' }] })}\n${day('2026-08-18')}`,
    )
    await index.refresh('-tmp-project-x', 'twin', false)
    await childFrom('chatc', '2026-08-19')
    lineage.record('-tmp-project-x/chatc', '-tmp-project-x/twin')
    const tip = await app.inject({ method: 'POST', url: '/api/console', headers: { 'x-token': TOKEN }, payload: { id: 'chatc' } })
    expect(tip.statusCode).not.toBe(409)
    const root409 = await app.inject({ method: 'POST', url: '/api/console', headers: { 'x-token': TOKEN }, payload: { id: 'aaa' } })
    expect(root409.statusCode).toBe(409)
    expect(root409.json()).toMatchObject({ tip: '-tmp-project-x/chatc' })
  })

  it('a NEWER child (a real rotation) still 409s naming it as the tip', async () => {
    await childFrom('new', '2026-08-18')
    lineage.record('-tmp-project-x/new', '-tmp-project-x/aaa')
    const res = await app.inject({ method: 'POST', url: '/api/console', headers: { 'x-token': TOKEN }, payload: { id: 'aaa' } })
    expect(res.statusCode).toBe(409)
    expect(res.json()).toMatchObject({ error: expect.stringMatching(/continues in a newer conversation/), tip: '-tmp-project-x/new' })
  })
})
