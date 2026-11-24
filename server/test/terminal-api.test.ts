import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync } from 'node:fs'
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
import { TerminalService } from '../src/terminal-service.js'
import { buildServer } from '../src/server.js'

// a genuinely LOCAL request (loopback Host, no forwarding/tunnel headers)
// no longer requires a token — see isLocalRequest in server.ts. These 401
// assertions must look REMOTE (public host) so they keep exercising the
// guard without weakening it.
const REMOTE = { host: 'silos.example.com' }

const TOKEN = 't0k'
let app: FastifyInstance, terminals: TerminalService

afterEach(async () => {
  terminals?.killAll()
  await app?.close()
})

async function setup(): Promise<void> {
  const base = mkdtempSync(join(tmpdir(), 'deck-'))
  const root = join(base, 'projects')
  const folder = mkdtempSync(join(tmpdir(), 'deck-folder-'))
  mkdirSync(root, { recursive: true })
  mkdirSync(join(base, 'data', 'trash'), { recursive: true })
  const index = claudeSessionIndex(root, join(base, 'data', 'cache.json'))
  await index.init()
  const registry = new AgentRegistry(join(base, 'data', 'agents.json'))
  registry.load()
  registry.create({ id: 'writer', name: 'Writer', folder })
  const store = new SessionStore(root, join(base, 'data'))
  const native = new NativeStore(join(base, 'data', 'native.json'))
  const prefs = new PrefsStore(join(base, 'data'))
  const memory = new MemoryService(root, join(base, 'data'), registry)
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
  terminals = new TerminalService(registry, index)
  app = buildServer({
    index,
    registry,
    store,
    native,
    chat,
    exec: new ExecService(registry),
    complete: new CompleteService(registry, index),
    prefs,
    memory,
    terminals,
    token: TOKEN,
    liveMs: 120_000,
  })
}

describe('/api/terminals', () => {
  it('POST creates a terminal, DELETE kills it', async () => {
    await setup()
    const res = await app.inject({ method: 'POST', url: '/api/terminals', headers: { 'x-token': TOKEN }, payload: { agentId: 'writer' } })
    expect(res.statusCode).toBe(201)
    const { id } = res.json() as { id: string }
    expect(typeof id).toBe('string')
    expect(terminals.list()).toHaveLength(1)

    const del = await app.inject({ method: 'DELETE', url: `/api/terminals/${id}`, headers: { 'x-token': TOKEN } })
    expect(del.statusCode).toBe(200)
    expect(terminals.list()).toHaveLength(0)
  })

  it('no token -> 401', async () => {
    await setup()
    const res = await app.inject({ method: 'POST', url: '/api/terminals', payload: { agentId: 'writer' }, headers: REMOTE })
    expect(res.statusCode).toBe(401)
  })

  it('a disallowed cwd -> 400', async () => {
    await setup()
    const res = await app.inject({ method: 'POST', url: '/api/terminals', headers: { 'x-token': TOKEN }, payload: { cwd: '/etc' } })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ error: expect.stringContaining('not allowed') })
  })

  it('DELETE of a nonexistent id does not blow up (still ok)', async () => {
    await setup()
    const res = await app.inject({ method: 'DELETE', url: '/api/terminals/missing', headers: { 'x-token': TOKEN } })
    expect(res.statusCode).toBe(200)
  })
})

// The console's scrollbar routes — only the "no such console" path here: a
// real console on the OWNER's tmux socket is off-limits to tests (the
// service tests drive the real thing on a throwaway socket).
describe('/api/console/:key/scroll', () => {
  it('GET on a console that is not open -> 404', async () => {
    await setup()
    const res = await app.inject({ method: 'GET', url: '/api/console/no-such-console/scroll', headers: { 'x-token': TOKEN } })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({ error: 'console not open' })
  })

  it('POST on a console that is not open -> 404; a non-numeric position is a 400', async () => {
    await setup()
    const res = await app.inject({ method: 'POST', url: '/api/console/no-such-console/scroll', headers: { 'x-token': TOKEN }, payload: { position: 3 } })
    expect(res.statusCode).toBe(404)
    const bad = await app.inject({ method: 'POST', url: '/api/console/no-such-console/scroll', headers: { 'x-token': TOKEN }, payload: { position: 'up' } })
    expect(bad.statusCode).toBe(400)
  })

  it('no token (remote) -> 401', async () => {
    await setup()
    const res = await app.inject({ method: 'GET', url: '/api/console/x/scroll', headers: REMOTE })
    expect(res.statusCode).toBe(401)
  })
})

// POST /api/sessions/:folder/:id/answer — the engine-picking answer to an
// open AskUserQuestion. Only the guards here (no owner tmux in tests).
describe('/api/sessions/:folder/:id/answer', () => {
  it('a bad index is a 400; an unknown session a 404', async () => {
    await setup()
    const bad = await app.inject({ method: 'POST', url: '/api/sessions/f/no-such/answer', headers: { 'x-token': TOKEN }, payload: { index: 'b' } })
    expect(bad.statusCode).toBe(400)
    const missing = await app.inject({ method: 'POST', url: '/api/sessions/f/no-such/answer', headers: { 'x-token': TOKEN }, payload: { index: 0 } })
    expect(missing.statusCode).toBe(404)
  })
})
