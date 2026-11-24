import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
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
import { AgentTokens } from '../src/agent-tokens.js'
import { AgentStateStore } from '../src/agent-state.js'
import { AsksStore } from '../src/asks-store.js'
import { buildServer } from '../src/server.js'
import { asOwner } from './helpers/owner.js'

const LOCAL = { host: '127.0.0.1:3210' }
let app: FastifyInstance, tokens: AgentTokens, stateDir: string, dataDir: string, folder: string
// two real sessions in the index, owned (birth records) by finance and writer
const SES_CFO = '11111111-1111-4111-8111-111111111111'
const SES_DEV = '22222222-2222-4222-8222-222222222222'

beforeEach(async () => {
  const base = mkdtempSync(join(tmpdir(), 'deck-asks-'))
  const root = join(base, 'projects')
  folder = mkdtempSync(join(tmpdir(), 'deck-asks-folder-'))
  mkdirSync(join(base, 'data', 'trash'), { recursive: true })
  mkdirSync(join(root, mungePath(folder)), { recursive: true })
  for (const id of [SES_CFO, SES_DEV]) {
    writeFileSync(
      join(root, mungePath(folder), `${id}.jsonl`),
      JSON.stringify({ type: 'user', sessionId: id, cwd: folder, timestamp: new Date().toISOString(), message: { role: 'user', content: 'hello' } }) + '\n',
    )
  }
  const index = claudeSessionIndex(root, join(base, 'data', 'cache.json'))
  await index.init()
  const registry = new AgentRegistry(join(base, 'data', 'agents.json'))
  registry.load()
  registry.create({ id: 'finance', name: 'Finance', folder })
  registry.create({ id: 'writer', name: 'Writer', folder })
  const native = new NativeStore(join(base, 'data', 'native.json'))
  native.register(mungePath(folder), SES_CFO, { agentId: 'finance', createdAt: new Date().toISOString() })
  native.register(mungePath(folder), SES_DEV, { agentId: 'writer', createdAt: new Date().toISOString() })
  tokens = new AgentTokens(join(base, 'data'))
  stateDir = join(base, 'data', 'agent-state')
  dataDir = join(base, 'data')
  const agentState = new AgentStateStore(stateDir, tokens)
  app = buildServer({
    index,
    registry,
    native,
    chat: new ChatService({
      registry,
      native,
      queryFn: () => {
        throw new Error('no sdk')
      },
    }),
    store: new SessionStore(root, join(base, 'data')),
    exec: new ExecService(registry),
    complete: new CompleteService(registry, index),
    prefs: new PrefsStore(join(base, 'data')),
    memory: new MemoryService(root, join(base, 'data'), registry),
    token: 't0k',
    liveMs: 120_000,
    agentTokens: tokens,
    agentState,
    asks: new AsksStore(agentState, { dataDir: join(base, 'data'), ttlMs: 0 }),
  })
  asOwner(app, 't0k')
})
afterEach(async () => {
  await app.close()
})

function writeAsk(agentId: string, sessionId: string, id: string): void {
  const dir = join(stateDir, agentId, 'asks', sessionId)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, `${id}.json`),
    JSON.stringify({ id, sessionId, type: 'bash', pattern: 'rm -rf dist', title: null, metadata: {}, askedAt: '2026-10-26T10:00:00.000Z' }),
  )
}
// the Silos-owned reply dir, out of every agent's reach (fenced)
const replyFile = (agentId: string, sessionId: string, id: string) => join(dataDir, 'asks-replies', agentId, sessionId, `${id}.reply.json`)
const post = (url: string, payload: unknown, headers: Record<string, string> = LOCAL) => app.inject({ method: 'POST', url, headers, payload: payload as never })

describe('POST /api/asks/:agentId/:sessionId/:permissionId/reply', () => {
  it("status 'allow' → 200 and the reply file exists", async () => {
    writeAsk('finance', 'ses_1', 'perm_1')
    const r = await post('/api/asks/finance/ses_1/perm_1/reply', { status: 'allow' })
    expect(r.statusCode).toBe(200)
    expect(r.json()).toEqual({ ok: true })
    expect(JSON.parse(readFileSync(replyFile('finance', 'ses_1', 'perm_1'), 'utf8')).status).toBe('allow')
    expect(existsSync(join(stateDir, 'finance', 'asks', 'ses_1', 'perm_1.reply.json'))).toBe(false)
  })

  it("status 'deny' → 200", async () => {
    writeAsk('finance', 'ses_1', 'perm_1')
    expect((await post('/api/asks/finance/ses_1/perm_1/reply', { status: 'deny' })).statusCode).toBe(200)
    expect(JSON.parse(readFileSync(replyFile('finance', 'ses_1', 'perm_1'), 'utf8')).status).toBe('deny')
  })

  it('a second answer while the first still waits → 409, the first stands', async () => {
    writeAsk('finance', 'ses_1', 'perm_1')
    expect((await post('/api/asks/finance/ses_1/perm_1/reply', { status: 'allow' })).statusCode).toBe(200)
    const again = await post('/api/asks/finance/ses_1/perm_1/reply', { status: 'deny' })
    expect(again.statusCode).toBe(409)
    expect(again.json()).toEqual({ error: 'already answered' })
    expect(JSON.parse(readFileSync(replyFile('finance', 'ses_1', 'perm_1'), 'utf8')).status).toBe('allow')
  })

  it("status 'maybe' or none → 400, nothing written", async () => {
    writeAsk('finance', 'ses_1', 'perm_1')
    expect((await post('/api/asks/finance/ses_1/perm_1/reply', { status: 'maybe' })).statusCode).toBe(400)
    expect((await post('/api/asks/finance/ses_1/perm_1/reply', {})).statusCode).toBe(400)
    expect(existsSync(replyFile('finance', 'ses_1', 'perm_1'))).toBe(false)
  })

  it('an unsafe segment → 400 (every one of the three)', async () => {
    writeAsk('finance', 'ses_1', 'perm_1')
    for (const url of [
      '/api/asks/finance/ses_1/..%2Fx/reply',
      '/api/asks/finance/..%2Fses_1/perm_1/reply',
      '/api/asks/..%2Ffinance/ses_1/perm_1/reply',
      '/api/asks/finance/ses_1/.x/reply',
      '/api/asks/finance/ses_1/per%20m/reply',
      '/api/asks/finance/ses_1/per.m/reply',
    ]) {
      const r = await post(url, { status: 'allow' })
      expect(r.statusCode, url).toBe(400)
    }
  })

  it('an unknown ask → 404 and never writes (a stale reply file with no ask is ignored too)', async () => {
    expect((await post('/api/asks/finance/ses_1/perm_1/reply', { status: 'allow' })).statusCode).toBe(404)
    expect(existsSync(join(stateDir, 'finance'))).toBe(false)
    const dir = join(dataDir, 'asks-replies', 'finance', 'ses_1')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'perm_2.reply.json'), JSON.stringify({ status: 'allow', at: 'x' }))
    expect((await post('/api/asks/finance/ses_1/perm_2/reply', { status: 'deny' })).statusCode).toBe(404)
    expect(JSON.parse(readFileSync(join(dir, 'perm_2.reply.json'), 'utf8')).status).toBe('allow')
  })

  it('an agent bearer → 403 (owner-only), even for its own ask', async () => {
    writeAsk('finance', 'ses_1', 'perm_1')
    const r = await post('/api/asks/finance/ses_1/perm_1/reply', { status: 'allow' }, { ...LOCAL, authorization: `Bearer ${tokens.tokenFor('finance')}` })
    expect(r.statusCode).toBe(403)
    expect(existsSync(replyFile('finance', 'ses_1', 'perm_1'))).toBe(false)
  })
})

describe('GET /api/board needsYou', () => {
  const askRows = async () =>
    ((await app.inject({ method: 'GET', url: '/api/board', headers: LOCAL })).json().needsYou as { kind: string; id: string }[]).filter((n) => n.kind === 'ask')

  it("carries a pending ask on its own agent's session, and drops it once answered", async () => {
    writeAsk('finance', SES_CFO, 'perm_1')
    expect(await askRows()).toEqual([
      {
        kind: 'ask',
        agentId: 'finance',
        sessionId: SES_CFO,
        folder: mungePath(folder),
        id: 'perm_1',
        title: 'bash rm -rf dist',
        pattern: 'rm -rf dist',
        type: 'bash',
        at: '2026-10-26T10:00:00.000Z',
      },
    ])
    await post(`/api/asks/finance/${SES_CFO}/perm_1/reply`, { status: 'allow' })
    expect(await askRows()).toEqual([])
  })

  it("an ask under writer naming finance's session is not on Home; naming writer's own session it is; an unknown session is not", async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    writeAsk('writer', SES_CFO, 'perm_peer')
    writeAsk('writer', SES_DEV, 'perm_own')
    writeAsk('writer', 'ses_unknown', 'perm_unknown')
    expect((await askRows()).map((n) => n.id)).toEqual(['perm_own'])
    warn.mockRestore()
  })
})
