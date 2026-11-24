import { describe, it, expect, beforeEach } from 'vitest'
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
import { NOT_AN_ENGINE } from './helpers/built-ins.js'

// The harness is chosen when an agent is created and never changed after:
// POST validates the id, PATCH refuses to switch a harness already set, and
// a legacy agent without one may be stamped once.
const TOKEN = 'testtoken'
let app: FastifyInstance
let registry: AgentRegistry

beforeEach(async () => {
  const base = mkdtempSync(join(tmpdir(), 'deck-harness-'))
  const root = join(base, 'projects')
  const dataDir = join(base, 'data')
  mkdirSync(root, { recursive: true })
  mkdirSync(join(dataDir, 'trash'), { recursive: true })
  const index = claudeSessionIndex(root, join(dataDir, 'cache.json'))
  await index.init()
  registry = new AgentRegistry(join(dataDir, 'agents.json'))
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
  mkdirSync(join(base, 'claude-sessions'), { recursive: true })
  const terminals = new TerminalService(registry, index, undefined, undefined, {
    sessionsDir: join(base, 'claude-sessions'),
    tmuxSocket: 'silos-harnesstest-none',
  })
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
    token: TOKEN,
    liveMs: 120_000,
    terminals,
  })
})

const headers = { 'x-token': TOKEN }
const post = (payload: object) => app.inject({ method: 'POST', url: '/api/agents', headers, payload })
const patch = (id: string, payload: object) => app.inject({ method: 'PATCH', url: `/api/agents/${id}`, headers, payload })

describe('agent harness (framework)', () => {
  it('POST rejects an unknown harness', async () => {
    const res = await post({ id: 'cod', name: 'Cod', folder: '/tmp/cod', framework: NOT_AN_ENGINE })
    expect(res.statusCode).toBe(400)
    expect(res.body).toMatch(/unknown harness/)
  })

  it('POST accepts opencode and GET echoes it', async () => {
    const res = await post({ id: 'oc', name: 'Oc', folder: '/tmp/oc', framework: 'opencode' })
    expect(res.statusCode).toBe(201)
    const agents = (await app.inject({ url: '/api/agents', headers })).json().agents as { id: string; framework?: string }[]
    expect(agents.find((a) => a.id === 'oc')?.framework).toBe('opencode')
  })

  it('PATCH cannot switch a harness already chosen', async () => {
    await post({ id: 'oc', name: 'Oc', folder: '/tmp/oc', framework: 'opencode' })
    const res = await patch('oc', { framework: 'claude-code' })
    expect(res.statusCode).toBe(400)
    expect(res.body).toMatch(/chosen at creation/)
    expect(registry.get('oc')?.framework).toBe('opencode')
  })

  it('PATCH rejects an unknown harness too', async () => {
    registry.create({ id: 'leg', name: 'Leg', folder: '/tmp/leg' })
    delete registry.get('leg')!.framework
    const res = await patch('leg', { framework: NOT_AN_ENGINE })
    expect(res.statusCode).toBe(400)
    expect(res.body).toMatch(/unknown harness/)
  })

  it('PATCH stamps a legacy agent that has no harness', async () => {
    registry.create({ id: 'leg', name: 'Leg', folder: '/tmp/leg' })
    delete registry.get('leg')!.framework
    const res = await patch('leg', { framework: 'claude-code' })
    expect(res.statusCode).toBe(200)
    expect(registry.get('leg')?.framework).toBe('claude-code')
  })

  it('PATCH resending the same harness (a full form save) is fine', async () => {
    await post({ id: 'oc', name: 'Oc', folder: '/tmp/oc', framework: 'opencode' })
    expect((await patch('oc', { framework: 'opencode', emoji: '🦄' })).statusCode).toBe(200)
  })
})
