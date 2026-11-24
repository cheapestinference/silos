// POST /api/sessions/:folder/:id/owner — the owner moves a thread to another
// agent (Settings › Maintenance / a misattributed console). Writes a birth
// record, which outranks classify-by-transcript in session-owner.ts.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import type { SessionIndex } from '../src/session-index.js'
import { claudeSessionIndex } from '../src/harnesses/claude-code/reader.js'
import { AgentRegistry, mungePath } from '../src/agent-registry.js'
import { SessionStore } from '../src/session-store.js'
import { NativeStore } from '../src/native-store.js'
import { ChatService } from '../src/chat-service.js'
import { ExecService } from '../src/exec-service.js'
import { CompleteService } from '../src/complete-service.js'
import { PrefsStore } from '../src/prefs-store.js'
import { MemoryService } from '../src/memory-service.js'
import { AgentTokens } from '../src/agent-tokens.js'
import { buildServer } from '../src/server.js'
import { asOwner } from './helpers/owner.js'

const LOCAL = { host: '127.0.0.1:3210' }
const REMOTE = { host: 'silos.example.com', 'cf-connecting-ip': '1.2.3.4' }
let app: FastifyInstance, native: NativeStore, index: SessionIndex, tokens: AgentTokens
let folder: string, mf: string, id: string

beforeEach(async () => {
  const base = mkdtempSync(join(tmpdir(), 'deck-owner-'))
  const root = join(base, 'projects')
  folder = mkdtempSync(join(tmpdir(), 'deck-owner-folder-'))
  mf = mungePath(folder)
  mkdirSync(join(base, 'data', 'trash'), { recursive: true })
  mkdirSync(join(root, mf), { recursive: true })
  id = randomUUID()
  writeFileSync(
    join(root, mf, `${id}.jsonl`),
    JSON.stringify({ type: 'user', sessionId: id, cwd: folder, timestamp: new Date().toISOString(), message: { role: 'user', content: 'hello' } }) + '\n',
  )
  index = claudeSessionIndex(root, join(base, 'data', 'cache.json'))
  await index.init()
  const registry = new AgentRegistry(join(base, 'data', 'agents.json'))
  registry.load()
  registry.create({ id: 'writer', name: 'Writer', folder, default: true })
  registry.create({ id: 'builder', name: 'Builder', folder })
  native = new NativeStore(join(base, 'data', 'native.json'))
  tokens = new AgentTokens(join(base, 'data'))
  const chat = new ChatService({
    registry,
    native,
    queryFn: () => {
      throw new Error('no sdk')
    },
  })
  app = buildServer({
    index,
    registry,
    native,
    chat,
    store: new SessionStore(root, join(base, 'data')),
    exec: new ExecService(registry),
    complete: new CompleteService(registry, index),
    prefs: new PrefsStore(join(base, 'data')),
    memory: new MemoryService(root, join(base, 'data'), registry),
    token: 't0k',
    liveMs: 120_000,
    agentTokens: tokens,
  })
  asOwner(app, 't0k')
})
afterEach(async () => {
  await app.close()
})

async function agentOf(): Promise<string | undefined> {
  const r = await app.inject({ method: 'GET', url: `/api/sessions/${mf}/${id}`, headers: LOCAL })
  expect(r.statusCode).toBe(200)
  return (r.json() as { meta: { agentId?: string } }).meta.agentId
}

describe('POST /api/sessions/:folder/:id/owner', () => {
  it('an external session in a shared folder starts with the default agent, and the owner moves it', async () => {
    expect(await agentOf()).toBe('writer')
    const r = await app.inject({ method: 'POST', url: `/api/sessions/${mf}/${id}/owner`, headers: LOCAL, payload: { agentId: 'builder' } })
    expect(r.statusCode).toBe(200)
    expect(r.json()).toEqual({ ok: true, agentId: 'builder' })
    expect(native.get(mf, id)?.agentId).toBe('builder')
    expect(await agentOf()).toBe('builder')
  })
  it('an unknown or archived agent is refused', async () => {
    const r = await app.inject({ method: 'POST', url: `/api/sessions/${mf}/${id}/owner`, headers: LOCAL, payload: { agentId: 'nope' } })
    expect(r.statusCode).toBe(404)
    expect(native.isNative(mf, id)).toBe(false)
  })
  it('a session that does not exist is 404', async () => {
    const r = await app.inject({ method: 'POST', url: `/api/sessions/${mf}/${randomUUID()}/owner`, headers: LOCAL, payload: { agentId: 'builder' } })
    expect(r.statusCode).toBe(404)
  })
  it('an agent bearer may not move threads (403); a remote without token is 401', async () => {
    const r = await app.inject({
      method: 'POST',
      url: `/api/sessions/${mf}/${id}/owner`,
      headers: { ...LOCAL, authorization: `Bearer ${tokens.tokenFor('builder')}` },
      payload: { agentId: 'builder' },
    })
    expect(r.statusCode).toBe(403)
    const r2 = await app.inject({ method: 'POST', url: `/api/sessions/${mf}/${id}/owner`, headers: REMOTE, payload: { agentId: 'builder' } })
    expect(r2.statusCode).toBe(401)
    expect(native.isNative(mf, id)).toBe(false)
  })
})
