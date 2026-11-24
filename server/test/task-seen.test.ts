// «New to you»: the owner's read marks on plan tasks — on the server (not in the
// browser, not in the plan), the owner's alone.
import { describe, it, expect, beforeEach } from 'vitest'
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
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
import { TaskSeenStore } from '../src/task-seen-store.js'
import { agentMayRead, agentMayWrite } from '../src/agent-authz.js'
import { buildServer } from '../src/server.js'

const KEY = 'folder:/home/u/proj/ship/tasks/t1'

describe('TaskSeenStore', () => {
  let dir: string
  let clock: number
  const fresh = (): TaskSeenStore => {
    const s = new TaskSeenStore(dir, () => clock)
    s.load()
    return s
  }
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'task-seen-'))
    clock = 1_000
  })

  it('the book opens once: `since` survives a restart, so old history never turns new', () => {
    expect(fresh().read()).toEqual({ since: 1_000, seen: {} })
    clock = 9_000
    expect(fresh().read().since).toBe(1_000)
  })

  it('a mark survives a restart, with the state it was left in', () => {
    clock = 2_000
    expect(fresh().mark(KEY, 'in_review')).toEqual({ at: 2_000, state: 'in_review' })
    expect(fresh().read().seen[KEY]).toEqual({ at: 2_000, state: 'in_review' })
  })

  it('a corrupt file is copied aside, never silently lost', () => {
    writeFileSync(join(dir, 'task-seen.json'), '{nope')
    expect(fresh().read()).toEqual({ since: 1_000, seen: {} })
    expect(readdirSync(dir).some((n) => n.startsWith('task-seen.json.corrupt-'))).toBe(true)
  })

  it('a hand-edited entry that makes no sense is dropped, the others stay', () => {
    writeFileSync(join(dir, 'task-seen.json'), JSON.stringify({ since: 5, seen: { a: { at: 'x', state: 'done' }, b: { at: 7, state: 'done' } } }))
    expect(fresh().read()).toEqual({ since: 5, seen: { b: { at: 7, state: 'done' } } })
  })
})

describe('/api/task-seen', () => {
  let app: FastifyInstance
  let dataDir: string
  const TOKEN = 'testtoken'
  const headers = { 'x-token': TOKEN, host: 'silos.example.com' }

  beforeEach(async () => {
    const base = mkdtempSync(join(tmpdir(), 'task-seen-api-'))
    const root = join(base, 'projects')
    dataDir = join(base, 'data')
    mkdirSync(root, { recursive: true })
    mkdirSync(join(dataDir, 'trash'), { recursive: true })
    const index = claudeSessionIndex(root, join(dataDir, 'cache.json'))
    await index.init()
    const registry = new AgentRegistry(join(dataDir, 'agents.json'))
    registry.load()
    const taskSeen = new TaskSeenStore(dataDir, () => 4_000)
    taskSeen.load()
    app = buildServer({
      index,
      registry,
      store: new SessionStore(root, dataDir),
      native: new NativeStore(join(dataDir, 'native.json')),
      chat: new ChatService({
        registry,
        native: new NativeStore(join(dataDir, 'native.json')),
        queryFn: () => ({
          async *[Symbol.asyncIterator]() {},
          async interrupt() {
            return undefined
          },
        }),
      }),
      exec: new ExecService(registry),
      complete: new CompleteService(registry, index),
      prefs: new PrefsStore(dataDir),
      memory: new MemoryService(root, dataDir, registry),
      taskSeen,
      token: TOKEN,
      liveMs: 120_000,
    })
  })

  const patch = (payload: unknown, h: Record<string, string> = headers) =>
    app.inject({ method: 'PATCH', url: '/api/task-seen', headers: h, payload: payload as object })

  it('marks and reads back, into its own file', async () => {
    const res = await patch({ key: KEY, state: 'done' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ key: KEY, at: 4_000, state: 'done' })
    const read = await app.inject({ url: '/api/task-seen', headers })
    expect(read.json().seen[KEY]).toEqual({ at: 4_000, state: 'done' })
    expect(JSON.parse(readFileSync(join(dataDir, 'task-seen.json'), 'utf8')).seen[KEY].state).toBe('done')
    expect(existsSync(join(dataDir, 'seen.json'))).toBe(false)
  })

  it('remote without auth: 401, read and write', async () => {
    const remote = { host: 'silos.example.com' }
    expect((await patch({ key: KEY, state: 'done' }, remote)).statusCode).toBe(401)
    expect((await app.inject({ url: '/api/task-seen', headers: remote })).statusCode).toBe(401)
  })

  it('refuses what is not a task key and a state', async () => {
    expect((await patch({ key: 'nope', state: 'done' })).statusCode).toBe(400)
    expect((await patch({ key: KEY })).statusCode).toBe(400)
    expect((await patch({ key: KEY, state: 7 })).statusCode).toBe(400)
    expect((await patch({ key: `${KEY}${'x'.repeat(2000)}`, state: 'done' })).statusCode).toBe(400)
  })

  it("an agent neither reads nor writes the owner's marks", () => {
    expect(agentMayRead('finance', '/api/task-seen')).toBe(false)
    expect(agentMayWrite('finance', 'PATCH', '/api/task-seen')).toBe(false)
  })
})
