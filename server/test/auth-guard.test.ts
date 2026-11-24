// The auth guard: local vs. remote per request, the static token hatch,
// login sessions (minted by the Silos ID callback — silos-id.test.ts runs
// that round trip against the real broker) and the sign-in rate limit.
// Network-free: the Silos ID client here is never asked to fetch.
import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { LoginRateLimiter, SilosIdClient } from '../src/silos-id.js'
import { SessionTokenStore, SESSION_TTL_MS } from '../src/session-tokens.js'
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

const NOW = 1_700_000_000_000
const OWNER = 'owner@example.com'

describe('LoginRateLimiter', () => {
  it('cuts off past the max within the window and recovers once outside it', () => {
    let t = 0
    const rl = new LoginRateLimiter(3, 60_000, () => t)
    expect(rl.allow('ip')).toBe(true)
    expect(rl.allow('ip')).toBe(true)
    expect(rl.allow('ip')).toBe(true)
    expect(rl.allow('ip')).toBe(false)
    expect(rl.allow('other-ip')).toBe(true) // per IP, not global
    t = 61_000
    expect(rl.allow('ip')).toBe(true)
  })
})

// ——— /api/auth/* routes on a real server (inject, no network) ———
const TOKEN = 'local-test-token'

// the "no token -> 401" assertions must look REMOTE — a genuinely local
// request no longer requires auth (see isLocalRequest, server.ts).
const REMOTE = { host: 'silos.example.com' }

const neverFetch = (async () => {
  throw new Error('no network should happen')
}) as unknown as typeof fetch
/** a Silos ID client that is never asked to reach its broker */
const silosIdClient = (): SilosIdClient =>
  new SilosIdClient(
    { brokerUrl: 'https://id.example.com', publicOrigin: 'https://silos.example.com', ownerEmails: [OWNER] },
    { fetchImpl: neverFetch, now: () => NOW },
  )

async function server(silosId: SilosIdClient | null, extra?: { sessions?: SessionTokenStore; allowlist?: () => string[] }): Promise<FastifyInstance> {
  const base = mkdtempSync(join(tmpdir(), 'deck-fb-api-'))
  const root = join(base, 'projects')
  const dataDir = join(base, 'data')
  mkdirSync(root, { recursive: true })
  mkdirSync(join(dataDir, 'trash'), { recursive: true })
  const index = claudeSessionIndex(root, join(dataDir, 'cache.json'))
  await index.init()
  const registry = new AgentRegistry(join(dataDir, 'agents.json'))
  registry.load()
  return buildServer({
    index,
    registry,
    store: new SessionStore(root, dataDir),
    native: new NativeStore(join(dataDir, 'native.json')),
    chat: new ChatService({
      registry,
      native: new NativeStore(join(dataDir, 'native2.json')),
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
    token: TOKEN,
    liveMs: 120_000,
    silosId,
    authNow: () => NOW,
    ...(extra?.sessions ? { sessions: extra.sessions } : {}),
    ...(extra?.allowlist ? { allowlist: extra.allowlist } : {}),
  })
}

describe('/api/auth/config', () => {
  it('with Silos ID: public, names the mode and leaks neither the allowed emails nor the token', async () => {
    const app = await server(silosIdClient())
    const res = await app.inject({ url: '/api/auth/config', headers: REMOTE }) // no x-token
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ enabled: true, mode: 'silos-id' })
  })

  it('without Silos ID: {enabled:false}, there is no other login route, and remote requests need the token', async () => {
    const app = await server(null)
    expect((await app.inject({ url: '/api/auth/config' })).json()).toEqual({ enabled: false })
    expect((await app.inject({ method: 'POST', url: '/api/auth/login', payload: { idToken: 'x' } })).statusCode).toBe(404)
    expect((await app.inject({ url: '/api/auth/silos-id/start', headers: REMOTE })).statusCode).toBe(404)
    expect((await app.inject({ url: '/api/overview', headers: REMOTE })).statusCode).toBe(401)
    expect((await app.inject({ url: '/api/overview', headers: { ...REMOTE, 'x-token': TOKEN } })).statusCode).toBe(200)
  })

  it('the ?token= hatch (the static token) works with Silos ID on — local AND remote', async () => {
    const app = await server(silosIdClient())
    expect((await app.inject({ url: `/api/overview?token=${TOKEN}` })).statusCode).toBe(200)
    expect((await app.inject({ url: `/api/overview?token=${TOKEN}`, headers: REMOTE })).statusCode).toBe(200)
  })
})

// ——— local vs. remote, PER REQUEST ———
// the owner serves Silos through cloudflared: the server still binds to
// 127.0.0.1 and the tunnel forwards over loopback — that's why "local" can
// never be inferred from the binding: it's per-request (a loopback Host AND
// zero forwarding headers).
describe('isLocalRequest (per-request guard)', () => {
  let app: FastifyInstance

  beforeEach(async () => {
    app = await server(silosIdClient())
  })

  it('genuinely local (a loopback Host, no forwarding headers) with no token -> the web app, nothing under /api', async () => {
    // inject defaults to Host localhost:80 — pure loopback
    expect((await app.inject({ url: '/' })).statusCode).not.toBe(401)
    expect((await app.inject({ url: '/', headers: { host: '127.0.0.1:3210' } })).statusCode).not.toBe(401)
    // every read needs an identity — local or not (any process on the
    // machine, an agent's shell included, can make a local request)
    for (const url of [
      '/api/agents',
      '/api/tasks/by-session?session=x',
      '/api/overview',
      '/api/file/raw?path=/home/user/.silos/token',
      '/api/file/meta?path=/etc/passwd',
      '/api/agents/builder',
      '/api/vault',
      '/api/%61gents/x',
      '/api/agents/',
      '/api/tasks/by-session/x',
    ]) {
      expect((await app.inject({ url })).statusCode, url).toBe(401)
      expect((await app.inject({ url, headers: { 'x-token': TOKEN } })).statusCode, `${url} with the owner token`).not.toBe(401)
    }
  })

  it('any tunnel/forwarding header forces auth even with a loopback Host (cloudflared)', async () => {
    // x-real-ip and true-client-ip included — an nginx-only proxy that
    // sends only X-Real-IP + a loopback Host must not be classified as local.
    const headers = ['x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'cf-connecting-ip', 'cf-ray', 'forwarded', 'x-real-ip', 'true-client-ip']
    for (const h of headers) {
      const without = await app.inject({ url: '/api/overview', headers: { host: '127.0.0.1:3210', [h]: 'x' } })
      expect(without.statusCode, `header ${h} must force auth`).toBe(401)
      const withToken = await app.inject({ url: '/api/overview', headers: { host: '127.0.0.1:3210', [h]: 'x', 'x-token': TOKEN } })
      expect(withToken.statusCode, `header ${h} + a valid token`).toBe(200)
    }
  })

  it('a loopback Host from a non-loopback peer (0.0.0.0 binding, a forged Host) -> auth required', async () => {
    for (const remoteAddress of ['172.17.0.1', '10.0.0.5', 'fd12::1']) {
      const forged = await app.inject({ url: '/api/agents', remoteAddress, headers: { host: '127.0.0.1:3210' } })
      expect(forged.statusCode, `peer ${remoteAddress}`).toBe(401)
      const withToken = await app.inject({ url: '/api/overview', remoteAddress, headers: { host: '127.0.0.1:3210', 'x-token': TOKEN } })
      expect(withToken.statusCode, `peer ${remoteAddress} + a valid token`).toBe(200)
    }
    for (const remoteAddress of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
      // a loopback peer with no identity is answered nothing under /api either
      expect((await app.inject({ url: '/api/agents', remoteAddress, headers: { host: '127.0.0.1:3210' } })).statusCode, `peer ${remoteAddress}`).toBe(401)
      expect(
        (await app.inject({ url: '/api/agents', remoteAddress, headers: { host: '127.0.0.1:3210', 'x-token': TOKEN } })).statusCode,
        `peer ${remoteAddress} + a valid token`,
      ).toBe(200)
    }
  })

  it('a public Host -> auth required; with ?token= (the manual hatch) it gets in', async () => {
    expect((await app.inject({ url: '/api/overview', headers: REMOTE })).statusCode).toBe(401)
    expect((await app.inject({ url: `/api/overview?token=${TOKEN}`, headers: REMOTE })).statusCode).toBe(200)
  })

  it('with no sign-in configured the local/remote guard is the same (the rule does not depend on login)', async () => {
    const noLogin = await server(null)
    expect((await noLogin.inject({ url: '/api/agents' })).statusCode).toBe(401) // local
    expect((await noLogin.inject({ url: '/api/agents', headers: REMOTE })).statusCode).toBe(401)
    expect((await noLogin.inject({ url: '/api/agents', headers: { 'x-token': TOKEN } })).statusCode).toBe(200)
    expect((await noLogin.inject({ url: '/api/overview' })).statusCode).toBe(401)
  })
})

// ——— login sessions (never a single god token) ———
// (a session is what the Silos ID callback mints — sessions.issue — so the
// tests issue it straight from the store the server uses)
describe('login sessions', () => {
  it('a session is never the static token and works only while Silos ID is configured', async () => {
    const sessions = new SessionTokenStore()
    const session = sessions.issue(OWNER)
    expect(session).not.toBe(TOKEN)
    expect(session).toMatch(/^[0-9a-f]{64}$/)
    const on = await server(silosIdClient(), { sessions })
    expect((await on.inject({ url: '/api/overview', headers: { ...REMOTE, 'x-token': session } })).statusCode).toBe(200)
    const off = await server(null, { sessions })
    expect((await off.inject({ url: '/api/overview', headers: { ...REMOTE, 'x-token': session } })).statusCode).toBe(401)
  })

  it('an expired session (a fixed 7 days) -> 401 on the next remote request', async () => {
    let t = NOW
    const sessions = new SessionTokenStore({ now: () => t })
    const app = await server(silosIdClient(), { sessions })
    const session = sessions.issue(OWNER)
    expect((await app.inject({ url: '/api/overview', headers: { ...REMOTE, 'x-token': session } })).statusCode).toBe(200)
    t = NOW + SESSION_TTL_MS + 1
    expect((await app.inject({ url: '/api/overview', headers: { ...REMOTE, 'x-token': session } })).statusCode).toBe(401)
  })

  it('removing the email from the allowlist revokes the session on the NEXT request (a fresh allowlist per request)', async () => {
    const allow = [OWNER]
    const sessions = new SessionTokenStore()
    const app = await server(silosIdClient(), { sessions, allowlist: () => allow })
    const session = sessions.issue('Owner@Example.com') // case-insensitive
    expect((await app.inject({ url: '/api/overview', headers: { ...REMOTE, 'x-token': session } })).statusCode).toBe(200)
    allow.length = 0 // the email leaves the allowed set — no restart
    expect((await app.inject({ url: '/api/overview', headers: { ...REMOTE, 'x-token': session } })).statusCode).toBe(401)
    // the static token does NOT depend on the allowlist (the escape hatch)
    expect((await app.inject({ url: '/api/overview', headers: { ...REMOTE, 'x-token': TOKEN } })).statusCode).toBe(200)
  })

  it('logout revokes the session server-side; the static token is never revoked that way', async () => {
    const sessions = new SessionTokenStore()
    const app = await server(silosIdClient(), { sessions })
    const session = sessions.issue(OWNER)
    expect((await app.inject({ url: '/api/overview', headers: { ...REMOTE, 'x-token': session } })).statusCode).toBe(200)
    expect((await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { 'x-token': session } })).statusCode).toBe(200)
    expect((await app.inject({ url: '/api/overview', headers: { ...REMOTE, 'x-token': session } })).statusCode).toBe(401)
    // trying to "revoke" the static one is a no-op: it keeps working
    await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { 'x-token': TOKEN } })
    expect((await app.inject({ url: '/api/overview', headers: { ...REMOTE, 'x-token': TOKEN } })).statusCode).toBe(200)
  })

  it('persistence: a new store on the same file keeps the session; a corrupt file -> starts from scratch', () => {
    const dir = mkdtempSync(join(tmpdir(), 'deck-sess-'))
    const file = join(dir, 'sessions.json')
    const a = new SessionTokenStore({ file })
    const token = a.issue('owner@example.com')
    const b = new SessionTokenStore({ file }) // a server "restart" (tsx watch)
    expect(b.validate(token)).toEqual({ email: 'owner@example.com' })
    b.revoke(token)
    const c = new SessionTokenStore({ file })
    expect(c.validate(token)).toBeNull()
    writeFileSync(file, 'not json')
    const d = new SessionTokenStore({ file })
    expect(d.validate(token)).toBeNull() // corrupt = empty, never crashes
  })
})
