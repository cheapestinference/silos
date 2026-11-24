// needs-you-acks.test.ts — the owner's "Seen" on an escalation: a durable
// store (needs-you-acks.json) keyed by agent → the `at` of the status the
// owner acknowledged. The escalation leaves the inbox; a NEWER one (a
// different `at`) comes back. Plus POST /api/needs-you/ack end to end.
import { describe, expect, it, beforeEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { AgentStateStore } from '../src/agent-state.js'
import { NeedsYouAcksStore } from '../src/needs-you-acks.js'
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

const T1 = '2026-10-07T10:00:00.000Z'
const tmp = (p: string) => mkdtempSync(join(tmpdir(), p))

describe('NeedsYouAcksStore', () => {
  it('starts empty, remembers an ack, and survives a reload from disk', () => {
    const dir = tmp('acks-')
    const a = new NeedsYouAcksStore(dir)
    a.load()
    expect(a.escalatedAckedAt('builder')).toBeNull()
    a.ackEscalated('builder', T1)
    expect(a.escalatedAckedAt('builder')).toBe(T1)
    expect(JSON.parse(readFileSync(join(dir, 'needs-you-acks.json'), 'utf8'))).toEqual({ escalated: { builder: T1 } })
    const b = new NeedsYouAcksStore(dir)
    b.load()
    expect(b.escalatedAckedAt('builder')).toBe(T1)
  })

  it('a corrupt file is backed up and the store starts fresh', () => {
    const dir = tmp('acks-')
    writeFileSync(join(dir, 'needs-you-acks.json'), '{nope')
    const a = new NeedsYouAcksStore(dir)
    a.load()
    expect(a.escalatedAckedAt('builder')).toBeNull()
    expect(readdirSync(dir).some((n) => n.startsWith('needs-you-acks.json.corrupt-'))).toBe(true)
  })

  it('non-string entries are discarded on load', () => {
    const dir = tmp('acks-')
    writeFileSync(join(dir, 'needs-you-acks.json'), JSON.stringify({ escalated: { builder: 5, finance: T1 } }))
    const a = new NeedsYouAcksStore(dir)
    a.load()
    expect(a.escalatedAckedAt('builder')).toBeNull()
    expect(a.escalatedAckedAt('finance')).toBe(T1)
  })
})

describe('POST /api/needs-you/ack', () => {
  const TOKEN = 'testtoken'
  let app: FastifyInstance, agentState: AgentStateStore, dataDir: string

  beforeEach(async () => {
    const base = tmp('acks-api-')
    const root = join(base, 'projects')
    dataDir = join(base, 'data')
    mkdirSync(root, { recursive: true })
    mkdirSync(join(dataDir, 'trash'), { recursive: true })
    const index = claudeSessionIndex(root, join(dataDir, 'cache.json'))
    await index.init()
    const registry = new AgentRegistry(join(dataDir, 'agents.json'))
    registry.load()
    registry.create({ id: 'builder', name: 'BUILDER', folder: '/tmp/project-x', skills: [] })
    const store = new SessionStore(root, dataDir)
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
    agentState = new AgentStateStore(join(dataDir, 'agent-state'))
    const needsYouAcks = new NeedsYouAcksStore(dataDir)
    needsYouAcks.load()
    app = buildServer({
      index,
      registry,
      store,
      native,
      chat,
      exec: new ExecService(registry),
      complete: new CompleteService(registry, index),
      prefs: new PrefsStore(dataDir),
      memory: new MemoryService(root, dataDir, registry),
      token: TOKEN,
      liveMs: 120_000,
      agentState,
      needsYouAcks,
    })
  })

  const H = { 'x-token': TOKEN }
  const ack = (payload: unknown, headers: Record<string, string> = H) => app.inject({ method: 'POST', url: '/api/needs-you/ack', headers, payload })

  it('rejects a bad body with 400', async () => {
    expect((await ack({ kind: 'plan_task', agentId: 'builder', at: T1 })).statusCode).toBe(400)
    expect((await ack({ kind: 'escalated', agentId: '../x', at: T1 })).statusCode).toBe(400)
    expect((await ack({ kind: 'escalated', agentId: 'builder', at: '' })).statusCode).toBe(400)
    expect((await ack({ kind: 'escalated', agentId: 'builder' })).statusCode).toBe(400)
  })

  it('remote without a token -> 401', async () => {
    expect((await ack({ kind: 'escalated', agentId: 'builder', at: T1 }, { host: 'silos.example.com' })).statusCode).toBe(401)
  })
})
