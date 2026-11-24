import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { claudeSessionIndex } from '../src/harnesses/claude-code/reader.js'
import { AgentRegistry, mungePath } from '../src/agent-registry.js'
import { SessionStore } from '../src/session-store.js'
import { NativeStore } from '../src/native-store.js'
import { ChatService } from '../src/chat-service.js'
import { ExecService } from '../src/exec-service.js'
import { CompleteService } from '../src/complete-service.js'
import { PrefsStore } from '../src/prefs-store.js'
import { MemoryService } from '../src/memory-service.js'
import { buildServer } from '../src/server.js'
import { AgentTokens } from '../src/agent-tokens.js'

// a genuinely LOCAL request (loopback Host, no forwarding/tunnel headers)
// no longer requires a token — see isLocalRequest in server.ts. These 401
// assertions must look REMOTE (public host) so they keep exercising the
// guard without weakening it.
const REMOTE = { host: 'silos.example.com' }

let app: FastifyInstance
let base: string, root: string, folder: string, memDir: string
let tokens: AgentTokens
const TOKEN = 'testtoken'
const STALLS = {
  lastMinute: { count: 1, worstMs: 850 },
  lastHour: { count: 3, worstMs: 12_000 },
  sinceBoot: { count: 9, worstMs: 12_000, since: '2026-11-21T10:00:00.000Z' },
  worstLastHourAt: '2026-11-21T10:30:00.000Z',
  last: { ms: 850, at: '2026-11-21T10:59:00.000Z' },
  thresholds: { countOverMs: 200, logOverMs: 500 },
}

beforeEach(async () => {
  base = mkdtempSync(join(tmpdir(), 'deck-mem-api-'))
  root = join(base, 'projects')
  const dataDir = join(base, 'data')
  folder = join(base, 'proj')
  mkdirSync(root, { recursive: true })
  mkdirSync(join(dataDir, 'trash'), { recursive: true })
  mkdirSync(folder, { recursive: true })
  writeFileSync(join(base, 'CLAUDE.md'), '# global\n')
  writeFileSync(join(folder, 'CLAUDE.md'), '# project\n')
  memDir = join(root, mungePath(folder), 'memory')
  mkdirSync(memDir, { recursive: true })
  writeFileSync(join(memDir, 'MEMORY.md'), '# index\n')
  // a conversation of the agent (cwd = its folder) and a note born in it
  const rec = (o: Record<string, unknown>): string => JSON.stringify({ sessionId: 's-ag-1', cwd: folder, timestamp: '2026-11-01T10:00:00.000Z', ...o })
  writeFileSync(
    join(root, mungePath(folder), 's-ag-1.jsonl'),
    [
      rec({ type: 'user', uuid: 'u1', message: { role: 'user', content: 'remember this' } }),
      rec({ type: 'assistant', uuid: 'a1', parentUuid: 'u1', message: { role: 'assistant', content: [{ type: 'text', text: 'noted' }] } }),
    ].join('\n') + '\n',
  )
  writeFileSync(join(memDir, 'learned.md'), '---\nname: learned\nmetadata:\n  type: feedback\n  originSessionId: s-ag-1\n---\nbody\n')
  writeFileSync(join(memDir, 'orphan.md'), '---\nname: orphan\nmetadata:\n  originSessionId: gone-session\n---\nbody\n')

  const index = claudeSessionIndex(root, join(dataDir, 'cache.json'))
  await index.init()
  const registry = new AgentRegistry(join(dataDir, 'agents.json'))
  registry.load()
  registry.create({ id: 'ag', name: 'Agent', folder })
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
  const exec = new ExecService(registry)
  const complete = new CompleteService(registry, index)
  const prefs = new PrefsStore(dataDir)
  const memory = new MemoryService(root, dataDir, registry)
  tokens = new AgentTokens(dataDir)
  app = buildServer({
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
    agentTokens: tokens,
    loopStalls: { snapshot: () => STALLS },
  })
})

const get = (url: string) => app.inject({ url, headers: { 'x-token': TOKEN } })
const put = (url: string, payload: unknown) => app.inject({ method: 'PUT', url, headers: { 'x-token': TOKEN }, payload })

describe('GET /api/memory', () => {
  it('no folder -> only the global layer', async () => {
    const res = await get('/api/memory')
    expect(res.statusCode).toBe(200)
    expect(res.json().global.exists).toBe(true)
    expect(res.json().project).toBeNull()
  })

  it("with a registered agent's folder -> all 3 layers", async () => {
    const res = await get(`/api/memory?folder=${encodeURIComponent(folder)}`)
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.project.exists).toBe(true)
    expect(body.autoMemory).toHaveLength(3) // the index + the two seeded notes
  })

  it('an unknown folder -> 400', async () => {
    const res = await get('/api/memory?folder=/no/such/folder')
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toContain('not recognized')
  })

  it('no token -> 401', async () => {
    expect((await app.inject({ url: '/api/memory', headers: REMOTE })).statusCode).toBe(401)
  })
})

describe('GET /api/memory — who learned each note', () => {
  it("a note born in an agent's conversation carries that agent as author; one whose conversation is gone has none", async () => {
    const res = await get(`/api/memory?folder=${encodeURIComponent(folder)}`)
    expect(res.statusCode).toBe(200)
    const auto = res.json().autoMemory as { name: string; author?: string; origin?: string }[]
    expect(auto.find((n) => n.name === 'learned')).toMatchObject({ origin: 's-ag-1', author: 'ag' })
    const orphan = auto.find((n) => n.name === 'orphan')!
    expect(orphan.origin).toBe('gone-session')
    expect(orphan.author).toBeUndefined()
  })
})

describe('GET /api/memory/file', () => {
  it('reads an allowed file', async () => {
    const res = await get(`/api/memory/file?path=${encodeURIComponent(join(folder, 'CLAUDE.md'))}`)
    expect(res.statusCode).toBe(200)
    expect(res.json().content).toBe('# project\n')
  })

  it('a disallowed path -> 400', async () => {
    const outside = join(base, 'other.md')
    writeFileSync(outside, 'x')
    const res = await get(`/api/memory/file?path=${encodeURIComponent(outside)}`)
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toContain('not allowed')
  })

  it('a nonexistent file -> 404', async () => {
    const res = await get(`/api/memory/file?path=${encodeURIComponent(join(memDir, 'missing.md'))}`)
    expect(res.statusCode).toBe(404)
  })

  it('no path -> 400', async () => {
    const res = await get('/api/memory/file')
    expect(res.statusCode).toBe(400)
  })
})

describe('PUT /api/memory/file', () => {
  it('writes, makes a backup, and reflects it in the response', async () => {
    const target = join(folder, 'CLAUDE.md')
    const res = await put('/api/memory/file', { path: target, content: '# updated\n' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.ok).toBe(true)
    expect(body.backup).toBeTruthy()
    expect(existsSync(body.backup)).toBe(true)
    const read = await get(`/api/memory/file?path=${encodeURIComponent(target)}`)
    expect(read.json().content).toBe('# updated\n')
  })

  it('a disallowed path -> 400, nothing gets written', async () => {
    const outside = join(base, 'other.md')
    const res = await put('/api/memory/file', { path: outside, content: 'x' })
    expect(res.statusCode).toBe(400)
    expect(existsSync(outside)).toBe(false)
  })

  it('an incomplete body -> 400', async () => {
    expect((await put('/api/memory/file', { path: join(folder, 'CLAUDE.md') })).statusCode).toBe(400)
    expect((await put('/api/memory/file', { content: 'x' })).statusCode).toBe(400)
  })
})

// spec memory-places T2/T3 over the API: the rows the web draws, and the
// write boundary's refusals as codes
describe('memory rows and the write boundary, over the API', () => {
  it('GET answers rows with origin · reach · when · weight beside the four layers it always had', async () => {
    writeFileSync(join(folder, 'CLAUDE.local.md'), 'private\n')
    const body = (await get(`/api/memory?folder=${encodeURIComponent(folder)}&agent=ag`)).json()
    expect(body.global).toBeDefined()
    expect(body.project.exists).toBe(true)
    const local = body.rows.find((r: { rel: string }) => r.rel === 'CLAUDE.local.md')
    expect(local).toMatchObject({
      origin: 'private',
      kind: 'private',
      engineType: 'Local',
      when: { at: 'start' },
      weight: { as: 'disk', chars: 8 },
      engine: 'claude-code',
    })
    expect(local.reach.launches).not.toContain('wake')
    expect(body.rows.at(-1)).toMatchObject({ origin: 'agent', kind: 'agent', reach: { scope: 'agent' } })
    expect(body.places.map((p: { kind: string }) => p.kind)).toContain('agent')
  })

  it('a machine file: 409 without confirmed, nothing written; written with it', async () => {
    const global = join(base, 'CLAUDE.md')
    const refused = await put('/api/memory/file', { path: global, content: 'x' })
    expect(refused.statusCode).toBe(409)
    expect(refused.json().error).toContain('confirm')
    expect((await get(`/api/memory/file?path=${encodeURIComponent(global)}`)).json().content).toBe('# global\n')
    expect((await put('/api/memory/file', { path: global, content: '# mine\n', confirmed: true })).statusCode).toBe(200)
    expect((await get(`/api/memory/file?path=${encodeURIComponent(global)}`)).json().content).toBe('# mine\n')
  })

  it('a read-only row: 409 saying why; an unknown folder: 400; a name the server does not list: 400', async () => {
    writeFileSync(join(base, 'secret.md'), 's')
    const { rmSync, symlinkSync } = await import('node:fs')
    rmSync(join(folder, 'CLAUDE.md'))
    symlinkSync(join(base, 'secret.md'), join(folder, 'CLAUDE.md'))
    const ro = await put('/api/memory/file', { path: join(folder, 'CLAUDE.md'), content: 'x', folder })
    expect(ro.statusCode).toBe(409)
    expect(ro.json().error).toContain('read-only')
    expect((await put('/api/memory/file', { path: join(folder, 'notes.md'), content: 'x', folder: '/no/such' })).statusCode).toBe(400)
    expect((await put('/api/memory/file', { path: join(folder, 'notes.md'), content: 'x', folder })).statusCode).toBe(400)
    expect(existsSync(join(folder, 'notes.md'))).toBe(false)
  })

  it("an agent's bearer never writes memory — not even its own folder's file, confirmed or not", async () => {
    const bearer = { host: '127.0.0.1:3210', authorization: `Bearer ${tokens.tokenFor('ag')}` }
    for (const payload of [
      { path: join(folder, 'CLAUDE.md'), content: 'x' },
      { path: join(base, 'CLAUDE.md'), content: 'x', confirmed: true },
      { path: join(memDir, 'n.md'), content: 'x' },
    ]) {
      const res = await app.inject({ method: 'PUT', url: '/api/memory/file', headers: bearer, payload })
      expect(res.statusCode).toBe(403)
    }
    expect((await get(`/api/memory/file?path=${encodeURIComponent(join(folder, 'CLAUDE.md'))}`)).json().content).toBe('# project\n')
    expect(existsSync(join(memDir, 'n.md'))).toBe(false)
  })
})

// /healthz: liveness probe for PaaS/containers (Railway healthcheck, docker
// HEALTHCHECK). Lives outside /api on purpose so it needs no token even
// from a remote (proxied) host, and it reveals nothing.
describe('GET /healthz', () => {
  it('answers 200 {ok:true} without a token from a remote host', async () => {
    const res = await app.inject({ url: '/healthz', headers: { ...REMOTE, 'x-forwarded-for': '203.0.113.9' } })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true })
  })

  // the event loop's stalls (loop-stalls.ts): numbers only, and only to a
  // request from this machine — one curl, no token
  it("from this machine it carries the event loop's stall numbers; remote never", async () => {
    const local = await app.inject({ url: '/healthz', headers: { host: '127.0.0.1:3210' } })
    expect(local.statusCode).toBe(200)
    expect(local.json()).toEqual({ ok: true, loop: STALLS })
    const tunneled = await app.inject({ url: '/healthz', headers: { host: '127.0.0.1:3210', 'cf-connecting-ip': '203.0.113.9' } })
    expect(tunneled.json()).toEqual({ ok: true })
  })
})
