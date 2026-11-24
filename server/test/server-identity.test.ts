import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WebSocket from 'ws'
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
import { buildServer } from '../src/server.js'
import { authorOf } from '../src/author.js'
import { ownerHeaders } from './helpers/owner.js'

const LOCAL = { host: '127.0.0.1:3210' }
const WRITES_NEED_IDENTITY =
  'writes need an identity — the owner: x-token (or ?token=) with the token in ~/.silos/token, or open Silos from the link the server prints at start; an agent: Authorization: Bearer $SILOS_AGENT_TOKEN'
const TOKEN = 't0k'
let app: FastifyInstance, tokens: AgentTokens, seenAgentId: string | undefined | null

beforeEach(async () => {
  const base = mkdtempSync(join(tmpdir(), 'deck-ident-'))
  const root = join(base, 'projects')
  const folder = mkdtempSync(join(tmpdir(), 'deck-ident-folder-'))
  mkdirSync(join(base, 'data', 'trash'), { recursive: true })
  mkdirSync(root, { recursive: true })
  const index = claudeSessionIndex(root, join(base, 'data', 'cache.json'))
  await index.init()
  const registry = new AgentRegistry(join(base, 'data', 'agents.json'))
  registry.load()
  registry.create({ id: 'builder', name: 'Builder', folder })
  registry.create({ id: 'finance', name: 'Finance', folder })
  const native = new NativeStore(join(base, 'data', 'native.json'))
  const chat = new ChatService({
    registry,
    native,
    queryFn: () => {
      throw new Error('no sdk')
    },
  })
  tokens = new AgentTokens(join(base, 'data'))
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
    token: TOKEN,
    liveMs: 120_000,
    agentTokens: tokens,
  })
  seenAgentId = null
  // under the agent's own subtree: agent bearers only read the allow-list
  app.get('/api/agents/:id/__probe', async (req) => {
    seenAgentId = req.agentId
    return { ok: true, owner: req.ownerCredential === true, author: authorOf(req, registry) }
  })
  // a write an agent may make (its own messages), to read who the server says spoke
  app.post('/api/agents/:id/__probe', async (req) => ({ agentId: req.agentId ?? null, owner: req.ownerCredential === true, author: authorOf(req, registry) }))
})
afterEach(async () => {
  await app.close()
  vi.restoreAllMocks()
})

const bearer = (t: string) => ({ ...LOCAL, authorization: `Bearer ${t}` })

describe('agent identity on the API', () => {
  it('GET with a valid bearer → 200 and req.agentId is the agent', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/agents', headers: bearer(tokens.tokenFor('builder')) })
    expect(r.statusCode).toBe(200)
    const p = await app.inject({ method: 'GET', url: '/api/agents/builder/__probe', headers: bearer(tokens.tokenFor('builder')) })
    expect(p.statusCode).toBe(200)
    expect(seenAgentId).toBe('builder')
  })

  it('a valid bearer also works remotely (no static token needed)', async () => {
    const r = await app.inject({
      method: 'GET',
      url: '/api/agents/finance/__probe',
      headers: { host: 'silos.example.com', authorization: `Bearer ${tokens.tokenFor('finance')}` },
    })
    expect(r.statusCode).toBe(200)
    expect(seenAgentId).toBe('finance')
  })

  it('PATCH another agent with Bearer builder → 403 naming the method and path', async () => {
    const r = await app.inject({ method: 'PATCH', url: '/api/agents/finance?x=1', headers: bearer(tokens.tokenFor('builder')), payload: { name: 'Hacked' } })
    expect(r.statusCode).toBe(403)
    expect(r.json()).toEqual({ error: 'agent builder may not PATCH /api/agents/finance' })
  })

  it('invalid bearer is 401 even on loopback', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/agents', headers: bearer('nope') })
    expect(r.statusCode).toBe(401)
    expect(r.json()).toEqual({ error: 'invalid agent token' })
  })

  it('POST /api/agents/:id/token/rotate: owner rotates (old token dies), agent gets 403, unknown → 404', async () => {
    const old = tokens.tokenFor('builder')
    const denied = await app.inject({ method: 'POST', url: '/api/agents/builder/token/rotate', headers: bearer(old) })
    expect(denied.statusCode).toBe(403)
    const ok = await app.inject({ method: 'POST', url: '/api/agents/builder/token/rotate', headers: { ...LOCAL, ...ownerHeaders(TOKEN) } })
    expect(ok.statusCode).toBe(200)
    expect(ok.json()).toEqual({ rotated: true })
    expect(tokens.agentIdOf(old)).toBeNull()
    const missing = await app.inject({ method: 'POST', url: '/api/agents/ghost/token/rotate', headers: { ...LOCAL, ...ownerHeaders(TOKEN) } })
    expect(missing.statusCode).toBe(404)
  })

  it('an empty bearer is an invalid agent token, even on loopback', async () => {
    for (const authorization of ['Bearer ', 'Bearer', 'bearer   ']) {
      const r = await app.inject({ method: 'PATCH', url: '/api/agents/finance', headers: { ...LOCAL, authorization }, payload: { name: 'x' } })
      expect(r.statusCode).toBe(401)
      expect(r.json()).toEqual({ error: 'invalid agent token' })
    }
  })

  it('an agent bearer cannot dodge the read allow-list by encoding /api (GET /%61pi/board → 403)', async () => {
    const r = await app.inject({ method: 'GET', url: '/%61pi/board', headers: bearer(tokens.tokenFor('builder')) })
    expect(r.statusCode).toBe(403)
    expect(r.json()).toEqual({ error: 'agent builder may not read /api/board' })
    expect(
      (await app.inject({ method: 'PATCH', url: '/%61pi/agents/finance', headers: bearer(tokens.tokenFor('builder')), payload: { name: 'x' } })).statusCode,
    ).toBe(403)
  })

  it('a WebSocket upgrade with a valid agent bearer is refused with 403 and never opens', async () => {
    await app.listen({ port: 0, host: '127.0.0.1' })
    const port = (app.server.address() as { port: number }).port
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { authorization: `Bearer ${tokens.tokenFor('builder')}` } })
    const outcome = await new Promise<{ opened: boolean; status?: number; body?: string }>((resolve) => {
      ws.once('open', () => resolve({ opened: true }))
      ws.once('error', () => resolve({ opened: false }))
      ws.once('unexpected-response', (_req, res) => {
        let body = ''
        res.on('data', (c: Buffer) => {
          body += String(c)
        })
        res.on('end', () => resolve({ opened: false, status: res.statusCode, body }))
        res.on('error', () => resolve({ opened: false, status: res.statusCode, body }))
      })
    })
    expect(outcome.opened).toBe(false)
    expect(outcome.status).toBe(403)
    expect(JSON.parse(outcome.body ?? '{}')).toEqual({ error: 'agent builder may not open a websocket' })
    ws.terminate()
  })

  it('a WebSocket upgrade with an invalid bearer is destroyed (never opens)', async () => {
    await app.listen({ port: 0, host: '127.0.0.1' })
    const port = (app.server.address() as { port: number }).port
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { authorization: 'Bearer nope' } })
    const opened = await new Promise<boolean>((resolve) => {
      ws.once('open', () => resolve(true))
      ws.once('error', () => resolve(false))
      ws.once('unexpected-response', () => resolve(false))
    })
    expect(opened).toBe(false)
    ws.terminate()
  })
})

// (B1, I5) nobody is the owner by default.
describe('identity of every write (t0)', () => {
  it('a local write with no identity → 401 that teaches the way; nothing written', async () => {
    const r = await app.inject({ method: 'PATCH', url: '/api/agents/finance', headers: LOCAL, payload: { name: 'Hacked' } })
    expect(r.statusCode).toBe(401)
    expect(r.json()).toEqual({ error: WRITES_NEED_IDENTITY })
    for (const method of ['POST', 'PUT', 'DELETE'] as const) {
      const w = await app.inject({ method, url: '/api/agents/finance/__probe', headers: LOCAL, payload: {} })
      expect(w.statusCode).toBe(401)
    }
    const after = await app.inject({ method: 'GET', url: '/api/agents', headers: LOCAL })
    expect(JSON.stringify(after.json())).not.toContain('Hacked')
  })

  it('a local GET with no identity reads only the anonymous routes — never as anyone, whatever it declares', async () => {
    // any process on the machine can make a local request: past the roster
    // and a conversation's tasks, a read needs an identity
    const p = await app.inject({ method: 'GET', url: '/api/agents/builder/__probe', headers: LOCAL })
    expect(p.statusCode).toBe(401)
    expect(seenAgentId).toBeNull() // the route never ran
    // X-Silos-Agent is declared authorship over a RESOLVED identity, never one
    const named = await app.inject({ method: 'GET', url: '/api/agents/builder/__probe', headers: { ...LOCAL, 'x-silos-agent': 'finance' } })
    expect(named.statusCode).toBe(401)
    expect((await app.inject({ method: 'HEAD', url: '/api/agents', headers: LOCAL })).statusCode).toBe(200)
    expect((await app.inject({ method: 'GET', url: '/api/agents', headers: { ...LOCAL, 'x-silos-agent': 'finance' } })).statusCode).toBe(200)
  })

  it('the owner credential writes, local or remote: x-token, ?token= — and only it makes the author «owner»', async () => {
    const local = await app.inject({ method: 'POST', url: '/api/agents/builder/__probe', headers: { ...LOCAL, ...ownerHeaders(TOKEN) }, payload: {} })
    expect(local.statusCode).toBe(200)
    expect(local.json()).toEqual({ agentId: null, owner: true, author: 'owner' })
    const query = await app.inject({ method: 'POST', url: `/api/agents/builder/__probe?token=${TOKEN}`, headers: LOCAL, payload: {} })
    expect(query.json()).toEqual({ agentId: null, owner: true, author: 'owner' })
    const remote = await app.inject({
      method: 'POST',
      url: '/api/agents/builder/__probe',
      headers: { host: 'silos.example.com', 'cf-connecting-ip': '1.2.3.4', ...ownerHeaders(TOKEN) },
      payload: {},
    })
    expect(remote.json()).toEqual({ agentId: null, owner: true, author: 'owner' })
    // under the owner's credential, X-Silos-Agent names the author (as before)
    const named = await app.inject({
      method: 'POST',
      url: '/api/agents/builder/__probe',
      headers: { ...LOCAL, ...ownerHeaders(TOKEN), 'x-silos-agent': 'finance' },
      payload: {},
    })
    expect(named.json()).toEqual({ agentId: null, owner: true, author: 'finance' })
    // a wrong token is no credential: a local write gets the same teaching 401
    const wrong = await app.inject({ method: 'POST', url: '/api/agents/builder/__probe', headers: { ...LOCAL, 'x-token': 'nope' }, payload: {} })
    expect(wrong.statusCode).toBe(401)
    expect(wrong.json()).toEqual({ error: WRITES_NEED_IDENTITY })
  })

  it('an agent bearer is the agent, never the owner — even when it also carries the owner token', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/agents/builder/__probe', headers: bearer(tokens.tokenFor('builder')) })
    expect(r.json()).toEqual({ ok: true, owner: false, author: 'builder' })
    const both = await app.inject({
      method: 'GET',
      url: '/api/agents/builder/__probe',
      headers: { ...bearer(tokens.tokenFor('builder')), ...ownerHeaders(TOKEN) },
    })
    expect(both.json()).toEqual({ ok: true, owner: false, author: 'builder' })
  })

  it('a remote request with no credential is still 401 «invalid token», reads included', async () => {
    const REMOTE = { host: 'silos.example.com', 'cf-connecting-ip': '1.2.3.4' }
    expect((await app.inject({ method: 'GET', url: '/api/agents', headers: REMOTE })).json()).toEqual({ error: 'invalid token' })
    expect((await app.inject({ method: 'PATCH', url: '/api/agents/finance', headers: REMOTE, payload: { name: 'x' } })).statusCode).toBe(401)
  })
})

describe('GET /api/auth/me (public): who THIS request is', () => {
  it('owner by x-token or ?token=, agent:<id> by bearer, unknown otherwise — local or remote', async () => {
    const me = async (headers: Record<string, string>, url = '/api/auth/me') => {
      const r = await app.inject({ method: 'GET', url, headers })
      expect(r.statusCode).toBe(200)
      return r.json()
    }
    expect(await me(LOCAL)).toEqual({ who: 'unknown' })
    expect(await me({ ...LOCAL, ...ownerHeaders(TOKEN) })).toEqual({ who: 'owner' })
    expect(await me(LOCAL, `/api/auth/me?token=${TOKEN}`)).toEqual({ who: 'owner' })
    expect(await me({ ...LOCAL, 'x-token': 'nope' })).toEqual({ who: 'unknown' })
    expect(await me(bearer(tokens.tokenFor('finance')))).toEqual({ who: 'agent:finance' })
    expect(await me(bearer('nope'))).toEqual({ who: 'unknown' })
    expect(await me({ host: 'silos.example.com', 'cf-connecting-ip': '1.2.3.4' })).toEqual({ who: 'unknown' })
    expect(await me({ host: 'silos.example.com', 'cf-connecting-ip': '1.2.3.4', ...ownerHeaders(TOKEN) })).toEqual({ who: 'owner' })
  })

  it("master's own bearer resolves to agent:master (identity for every agent, G2-r4 + r6 #23)", async () => {
    expect((await app.inject({ method: 'GET', url: '/api/auth/me', headers: bearer(tokens.tokenFor('master')) })).json()).toEqual({ who: 'agent:master' })
  })
})

describe('WebSocket upgrades need the owner (t0)', () => {
  const upgrade = async (url: string, headers: Record<string, string> = {}) => {
    await app.listen({ port: 0, host: '127.0.0.1' })
    const port = (app.server.address() as { port: number }).port
    const ws = new WebSocket(`ws://127.0.0.1:${port}${url}`, { headers })
    const outcome = await new Promise<{ opened: boolean; status?: number; body?: string }>((resolve) => {
      ws.once('open', () => resolve({ opened: true }))
      ws.once('error', () => resolve({ opened: false }))
      ws.once('unexpected-response', (_req, res) => {
        let body = ''
        res.on('data', (c: Buffer) => {
          body += String(c)
        })
        res.on('end', () => resolve({ opened: false, status: res.statusCode, body }))
        res.on('error', () => resolve({ opened: false, status: res.statusCode, body }))
      })
    })
    ws.terminate()
    return outcome
  }

  it('a local upgrade with no identity → 401 with the same teaching words, never opens', async () => {
    const o = await upgrade('/ws')
    expect(o.opened).toBe(false)
    expect(o.status).toBe(401)
    expect(JSON.parse(o.body ?? '{}')).toEqual({ error: WRITES_NEED_IDENTITY })
  })

  it('the owner opens it with ?token=', async () => {
    expect((await upgrade(`/ws?token=${TOKEN}`)).opened).toBe(true)
  })

  it("an agent bearer stays 403 — master's included (M4-r4)", async () => {
    const o = await upgrade('/ws', { authorization: `Bearer ${tokens.tokenFor('master')}` })
    expect(o.opened).toBe(false)
    expect(o.status).toBe(403)
    expect(JSON.parse(o.body ?? '{}')).toEqual({ error: 'agent master may not open a websocket' })
  })
})
