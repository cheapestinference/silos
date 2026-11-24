// An archived agent keeps no valid bearer (territory final review, 24-10):
// archiving revokes its token file, and the auth hook accepts a bearer only
// for an agent that is in the registry and not archived — so a token left
// on disk (archived by PATCH or by hand in agents.json, or an agent removed
// from the registry) is refused like any unknown token.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { AgentTokens } from '../src/agent-tokens.js'
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
import { asOwner } from './helpers/owner.js'

const LOCAL = { host: '127.0.0.1:3210' }
let app: FastifyInstance, registry: AgentRegistry, agentTokens: AgentTokens, dataDir: string

beforeEach(async () => {
  const base = mkdtempSync(join(tmpdir(), 'deck-tokarch-'))
  const root = join(base, 'projects')
  dataDir = join(base, 'data')
  const folder = mkdtempSync(join(tmpdir(), 'deck-tokarch-folder-'))
  mkdirSync(join(dataDir, 'trash'), { recursive: true })
  mkdirSync(root, { recursive: true })
  const index = claudeSessionIndex(root, join(dataDir, 'cache.json'))
  await index.init()
  registry = new AgentRegistry(join(dataDir, 'agents.json'))
  registry.load()
  registry.create({ id: 'finance', name: 'Finance', folder })
  registry.create({ id: 'builder', name: 'Builder', folder })
  agentTokens = new AgentTokens(dataDir)
  const native = new NativeStore(join(dataDir, 'native.json'))
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
    store: new SessionStore(root, dataDir),
    exec: new ExecService(registry),
    complete: new CompleteService(registry, index),
    prefs: new PrefsStore(dataDir),
    memory: new MemoryService(root, dataDir, registry),
    token: 't0k',
    liveMs: 120_000,
    agentTokens,
  })
  asOwner(app, 't0k')
})
afterEach(async () => {
  await app.close()
})

const asAgent = (bearer: string) => ({ ...LOCAL, authorization: `Bearer ${bearer}` })
const roster = (bearer: string) => app.inject({ method: 'GET', url: '/api/agents', headers: asAgent(bearer) })
const tokenFile = (id: string) => join(dataDir, 'agents', id, 'token')

describe('archived agents keep no valid bearer', () => {
  it('POST /api/agents/:id/archive deletes the token file and the old bearer is refused', async () => {
    const bearer = agentTokens.tokenFor('finance')
    expect((await roster(bearer)).statusCode).toBe(200)
    expect((await app.inject({ method: 'POST', url: '/api/agents/finance/archive', headers: LOCAL })).statusCode).toBe(200)
    expect(existsSync(tokenFile('finance'))).toBe(false)
    expect((await roster(bearer)).statusCode).toBe(401)
    // another agent is untouched
    expect((await roster(agentTokens.tokenFor('builder'))).statusCode).toBe(200)
  })

  it('PATCH /api/agents/:id {archived:true} revokes the same way', async () => {
    const bearer = agentTokens.tokenFor('finance')
    expect((await app.inject({ method: 'PATCH', url: '/api/agents/finance', headers: LOCAL, payload: { archived: true } })).statusCode).toBe(200)
    expect(existsSync(tokenFile('finance'))).toBe(false)
    expect((await roster(bearer)).statusCode).toBe(401)
  })

  it('a token left on disk for an agent archived by hand is refused (registry checked on every request)', async () => {
    const bearer = agentTokens.tokenFor('finance')
    const file = join(dataDir, 'agents.json')
    const json = JSON.parse(readFileSync(file, 'utf8'))
    const list = Array.isArray(json) ? json : json.agents
    list.find((a: { id: string }) => a.id === 'finance').archived = true
    writeFileSync(file, JSON.stringify(json))
    registry.load()
    expect(registry.get('finance')?.archived).toBe(true)
    expect(existsSync(tokenFile('finance'))).toBe(true)
    const r = await roster(bearer)
    expect(r.statusCode).toBe(401)
    expect(r.json()).toEqual({ error: 'invalid agent token' })
  })

  it('a token left on disk for an id no longer in the registry is refused', async () => {
    const bearer = agentTokens.tokenFor('ghost')
    expect((await roster(bearer)).statusCode).toBe(401)
  })

  it('unarchiving does not bring the old bearer back; a fresh mint works', async () => {
    const bearer = agentTokens.tokenFor('finance')
    await app.inject({ method: 'POST', url: '/api/agents/finance/archive', headers: LOCAL })
    expect((await app.inject({ method: 'POST', url: '/api/agents/finance/unarchive', headers: LOCAL })).statusCode).toBe(200)
    expect((await roster(bearer)).statusCode).toBe(401)
    const fresh = agentTokens.tokenFor('finance')
    expect(fresh).not.toBe(bearer)
    expect((await roster(fresh)).statusCode).toBe(200)
  })
})
