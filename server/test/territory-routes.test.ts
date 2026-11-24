import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdtempSync, mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
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
import { AgentTokens } from '../src/agent-tokens.js'
import { DEFAULT_PRIVATE, TerritoryStore } from '../src/territory-store.js'
import { makeTerritory } from '../src/territory.js'
import { AgentStateStore } from '../src/agent-state.js'
import { buildServer } from '../src/server.js'
import { asOwner } from './helpers/owner.js'

const LOCAL = { host: '127.0.0.1:3210' }
// per fenceable agent: the harness it runs on and what its fence really
// denies there once on (Read/Edit rules, and Bash on Silos' tmux server), enabled or not
const AGENTS = [
  {
    id: 'builder',
    harness: 'claude-code',
    label: 'Claude Code',
    fenced: ['read', 'edit', 'bash'],
    scope: expect.objectContaining({ works: expect.any(Array) }),
  },
  { id: 'oc', harness: 'opencode', label: 'OpenCode', fenced: ['read', 'edit', 'bash'], scope: expect.objectContaining({ works: expect.any(Array) }) },
]
let app: FastifyInstance, tokens: AgentTokens, store: TerritoryStore, dataDir: string, folder: string, extra: string

beforeEach(async () => {
  const base = mkdtempSync(join(tmpdir(), 'deck-terr-'))
  const root = join(base, 'projects')
  dataDir = join(base, 'data')
  folder = mkdtempSync(join(tmpdir(), 'deck-terr-folder-'))
  extra = mkdtempSync(join(tmpdir(), 'deck-terr-extra-'))
  mkdirSync(join(dataDir, 'trash'), { recursive: true })
  mkdirSync(root, { recursive: true })
  const index = claudeSessionIndex(root, join(dataDir, 'cache.json'))
  await index.init()
  const registry = new AgentRegistry(join(dataDir, 'agents.json'))
  registry.load()
  registry.create({ id: 'builder', name: 'Builder', folder, folders: [extra] })
  registry.create({ id: 'oc', name: 'Oc', folder, framework: 'opencode' })
  const native = new NativeStore(join(dataDir, 'native.json'))
  const chat = new ChatService({
    registry,
    native,
    queryFn: () => {
      throw new Error('no sdk')
    },
  })
  tokens = new AgentTokens(dataDir)
  store = new TerritoryStore(dataDir)
  store.load()
  const territory = makeTerritory({ registry, agentState: new AgentStateStore(join(dataDir, 'agent-state')), store, home: base, dataDir })
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
    agentTokens: tokens,
    territory,
    territoryStore: store,
    home: base,
  })
  asOwner(app, 't0k')
})
afterEach(async () => {
  await app.close()
})

describe('GET/PUT /api/territory', () => {
  it('GET returns the private paths (defaults when no file)', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/territory', headers: LOCAL })
    expect(r.statusCode).toBe(200)
    expect(r.json()).toEqual({ privatePaths: DEFAULT_PRIVATE, enabled: [], agents: AGENTS })
  })

  it('reading or saving it never creates agent state dirs (a fence is computed from paths, not mkdir)', async () => {
    expect(existsSync(join(dataDir, 'agent-state'))).toBe(false)
    expect((await app.inject({ method: 'GET', url: '/api/territory', headers: LOCAL })).statusCode).toBe(200)
    expect((await app.inject({ method: 'PUT', url: '/api/territory', headers: LOCAL, payload: { enabled: ['builder'] } })).statusCode).toBe(200)
    expect((await app.inject({ method: 'GET', url: '/api/agents/builder/territory', headers: LOCAL })).statusCode).toBe(200)
    expect(existsSync(join(dataDir, 'agent-state'))).toBe(false)
  })

  it('PUT saves (trimmed, blanks dropped) and persists to territory.json', async () => {
    const r = await app.inject({ method: 'PUT', url: '/api/territory', headers: LOCAL, payload: { privatePaths: ['~/vault', ' /srv/keys ', ''] } })
    expect(r.statusCode).toBe(200)
    expect(r.json()).toEqual({ privatePaths: ['~/vault', '/srv/keys'], enabled: [], agents: AGENTS })
    expect(JSON.parse(readFileSync(join(dataDir, 'territory.json'), 'utf8'))).toEqual({ privatePaths: ['~/vault', '/srv/keys'], enabled: [] })
    expect((await app.inject({ method: 'GET', url: '/api/territory', headers: LOCAL })).json()).toEqual({
      privatePaths: ['~/vault', '/srv/keys'],
      enabled: [],
      agents: AGENTS,
    })
  })

  it('PUT with a relative path → 400 naming the entry, nothing saved', async () => {
    const r = await app.inject({ method: 'PUT', url: '/api/territory', headers: LOCAL, payload: { privatePaths: ['~/ok', 'relative/dir'] } })
    expect(r.statusCode).toBe(400)
    expect(r.json().error).toContain('relative/dir')
    expect(store.privatePaths()).toEqual(DEFAULT_PRIVATE)
  })

  it('PUT with a non-array body → 400', async () => {
    const r = await app.inject({ method: 'PUT', url: '/api/territory', headers: LOCAL, payload: { privatePaths: 'nope' } })
    expect(r.statusCode).toBe(400)
  })

  it('agents can neither read nor write it', async () => {
    const auth = { ...LOCAL, authorization: `Bearer ${tokens.tokenFor('builder')}` }
    expect((await app.inject({ method: 'GET', url: '/api/territory', headers: auth })).statusCode).toBe(403)
    expect((await app.inject({ method: 'PUT', url: '/api/territory', headers: auth, payload: { privatePaths: [] } })).statusCode).toBe(403)
  })
})

describe('PUT /api/territory enabled — the rollout gate', () => {
  it('round-trips, persists next to privatePaths, and leaves the other field alone', async () => {
    const r = await app.inject({ method: 'PUT', url: '/api/territory', headers: LOCAL, payload: { enabled: ['builder'] } })
    expect(r.statusCode).toBe(200)
    expect(r.json()).toEqual({ privatePaths: DEFAULT_PRIVATE, enabled: ['builder'], agents: AGENTS })
    expect(JSON.parse(readFileSync(join(dataDir, 'territory.json'), 'utf8'))).toEqual({ privatePaths: DEFAULT_PRIVATE, enabled: ['builder'] })
    const fresh = new TerritoryStore(dataDir)
    fresh.load()
    expect(fresh.isEnabled('builder')).toBe(true)
    expect((await app.inject({ method: 'PUT', url: '/api/territory', headers: LOCAL, payload: { enabled: [] } })).json().enabled).toEqual([])
    expect(store.isEnabled('builder')).toBe(false)
  })

  it('master, an unknown id or a non-array → 400, nothing saved', async () => {
    for (const enabled of [['master'], ['ghost'], 'builder', [1]]) {
      const r = await app.inject({ method: 'PUT', url: '/api/territory', headers: LOCAL, payload: { enabled } })
      expect(r.statusCode).toBe(400)
    }
    expect(store.enabled()).toEqual([])
  })

  it('an empty body → 400', async () => {
    expect((await app.inject({ method: 'PUT', url: '/api/territory', headers: LOCAL, payload: {} })).statusCode).toBe(400)
  })

  it('an agent bearer cannot enable or disable anyone', async () => {
    const auth = { ...LOCAL, authorization: `Bearer ${tokens.tokenFor('builder')}` }
    expect((await app.inject({ method: 'PUT', url: '/api/territory', headers: auth, payload: { enabled: ['builder'] } })).statusCode).toBe(403)
    expect(store.enabled()).toEqual([])
  })
})

describe('GET /api/agents/:id/territory', () => {
  it('not enabled yet: territory off, 0 applied private paths — its launches still carry the always-on groups', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/agents/builder/territory', headers: LOCAL })
    expect(r.statusCode).toBe(200)
    expect(r.json()).toEqual({
      fenced: false,
      enabled: false,
      territories: [folder, extra],
      privatePaths: 0,
      deny: expect.any(Number),
      skipped: [],
      scope: expect.objectContaining({ works: expect.any(Array) }),
    })
    const off = r.json().deny as number
    expect(off).toBeGreaterThan(0)
    store.setEnabled(['builder'])
    expect((await app.inject({ method: 'GET', url: '/api/agents/builder/territory', headers: LOCAL })).json().deny).toBeGreaterThan(off)
  })

  it('a fenced agent: territories, private path count, deny rule count', async () => {
    store.setEnabled(['builder'])
    const r = await app.inject({ method: 'GET', url: '/api/agents/builder/territory', headers: LOCAL })
    expect(r.statusCode).toBe(200)
    const body = r.json()
    expect(body.fenced).toBe(true)
    expect(body.enabled).toBe(true)
    expect(body.territories).toEqual([folder, extra])
    expect(body.privatePaths).toBe(DEFAULT_PRIVATE.length)
    expect(body.deny).toBeGreaterThan(0)
    expect(body.skipped).toEqual([])
  })

  it('a data-dir entry whose name holds a glob character is listed as skipped, with the reason', async () => {
    store.setEnabled(['builder'])
    mkdirSync(join(dataDir, 'odd*dir'))
    const body = (await app.inject({ method: 'GET', url: '/api/agents/builder/territory', headers: LOCAL })).json()
    expect(body.skipped).toEqual([{ path: join(dataDir, 'odd*dir'), reason: expect.stringContaining('"*"') }])
  })

  it('privatePaths is the APPLIED count: a configured path containing a territory is not denied, not counted', async () => {
    store.setEnabled(['builder'])
    store.setPrivatePaths(['~/secrets', '~/.ssh', dirname(folder), `${extra}/inner`])
    const body = (await app.inject({ method: 'GET', url: '/api/agents/builder/territory', headers: LOCAL })).json()
    expect(body.privatePaths).toBe(2)
  })

  it('master: no fence, never enabled', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/agents/master/territory', headers: LOCAL })
    expect(r.statusCode).toBe(200)
    expect(r.json()).toEqual({ fenced: false, enabled: false, territories: [], privatePaths: 0, deny: 0, skipped: [], scope: null })
  })

  it('unknown agent → 404', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/agents/ghost/territory', headers: LOCAL })
    expect(r.statusCode).toBe(404)
  })

  it('master holds a bearer like any agent: the owner rotates it and the new one resolves to master', async () => {
    const old = tokens.tokenFor('master')
    const r = await app.inject({ method: 'POST', url: '/api/agents/master/token/rotate', headers: LOCAL })
    expect(r.statusCode).toBe(200)
    expect(existsSync(join(dataDir, 'agents', 'master', 'token'))).toBe(true)
    expect(tokens.agentIdOf(old)).toBeNull()
    expect(tokens.agentIdOf(tokens.tokenFor('master'))).toBe('master')
  })
})

// Fenced at birth — Settings › Territory keeps the
// explicit off, it is no longer the way on
describe('POST /api/agents — fenced at birth', () => {
  it('a new agent is enabled, the others kept; its territory answers fenced', async () => {
    store.setEnabled(['builder'])
    const r = await app.inject({ method: 'POST', url: '/api/agents', headers: LOCAL, payload: { id: 'ops', name: 'Ops', folder } })
    expect(r.statusCode).toBe(201)
    expect(r.json().warn).toBeUndefined()
    expect(store.enabled()).toEqual(['builder', 'ops'])
    const t = (await app.inject({ method: 'GET', url: '/api/agents/ops/territory', headers: LOCAL })).json()
    expect(t.fenced).toBe(true)
  })
  it('a fence that cannot be turned on: 201 with the honest warn, the agent exists unfenced', async () => {
    const orig = store.setEnabled.bind(store)
    store.setEnabled = () => {
      throw new Error('territory.json could not be written')
    }
    try {
      const r = await app.inject({ method: 'POST', url: '/api/agents', headers: LOCAL, payload: { id: 'ops', name: 'Ops', folder } })
      expect(r.statusCode).toBe(201)
      expect(r.json().agent.id).toBe('ops')
      expect(r.json().warn).toBe(
        "Ops's territory is off — territory.json could not be written. It stays Only when told, but the automations you set still run unattended. Turn it on in its Settings ›",
      )
    } finally {
      store.setEnabled = orig
    }
    expect(store.isEnabled('ops')).toBe(false)
  })
  it('persisted at birth; a refused create enables nobody', async () => {
    expect((await app.inject({ method: 'POST', url: '/api/agents', headers: LOCAL, payload: { id: 'ops', name: 'Ops', folder } })).statusCode).toBe(201)
    expect(JSON.parse(readFileSync(join(dataDir, 'territory.json'), 'utf8')).enabled).toEqual(['ops'])
    store.setEnabled([])
    const r = await app.inject({ method: 'POST', url: '/api/agents', headers: LOCAL, payload: { name: 'Builder', folder } })
    expect(r.statusCode).toBe(409)
    expect(store.enabled()).toEqual([])
  })
  it('the owner can still turn it off explicitly afterwards', async () => {
    await app.inject({ method: 'POST', url: '/api/agents', headers: LOCAL, payload: { id: 'ops', name: 'Ops', folder } })
    const r = await app.inject({ method: 'PUT', url: '/api/territory', headers: LOCAL, payload: { enabled: [] } })
    expect(r.statusCode).toBe(200)
    expect(store.isEnabled('ops')).toBe(false)
  })
})
