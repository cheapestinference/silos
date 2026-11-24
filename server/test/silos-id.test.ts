// Silos ID on the instance — its start and callback against the REAL broker
// (the Cloudflare Worker in silos-id/, run in-process with a memory KV):
// the instance's fetch is routed to the Worker, Google's JWKS is a fake,
// every key is generated here. No network. The broker's own rules are
// tested in silos-id/test/.
import { describe, it, expect, beforeEach } from 'vitest'
import { createHash, createPublicKey, createSign, generateKeyPairSync, type KeyObject } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { createBroker, type Env } from '../../silos-id/src/broker.js'
import { SilosIdClient, silosIdSettingsFromEnv } from '../src/silos-id.js'
import { parseServerEnv, readServerEnv, serverSettings, serverEnvWarning } from '../src/server-env.js'
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
const nowSec = Math.floor(NOW / 1000)
const BROKER = 'https://id.silos.test'
const INSTANCE = 'https://my-silos.up.railway.app'
const OWNER = 'owner@example.com'
const TOKEN = 'static-owner-token'
const REMOTE = { host: 'my-silos.up.railway.app', 'x-forwarded-for': '1.2.3.4' }

// Google's side: the Firebase ID token the popup would yield
const PROJECT = 'silos-test'
const google = generateKeyPairSync('rsa', { modulusLength: 2048 })
const googleJwk = { ...(google.publicKey.export({ format: 'jwk' }) as Record<string, unknown>), kid: 'g1', alg: 'RS256' }
const googleFetch = (async () =>
  new Response(JSON.stringify({ keys: [googleJwk] }), { status: 200, headers: { 'cache-control': 'max-age=600' } })) as typeof fetch
function idToken(extra: Record<string, unknown> = {}): string {
  const b = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString('base64url')
  const base = `${b({ alg: 'RS256', kid: 'g1' })}.${b({ aud: PROJECT, iss: `https://securetoken.google.com/${PROJECT}`, sub: 'uid-1', iat: nowSec - 5, exp: nowSec + 3600, email: OWNER, email_verified: true, ...extra })}`
  return `${base}.${createSign('RSA-SHA256').update(base).sign(google.privateKey).toString('base64url')}`
}

// a key and its RFC 7638 kid, as the broker names its own
function keyOf(priv: KeyObject): { key: KeyObject; kid: string } {
  const j = createPublicKey(priv).export({ format: 'jwk' }) as { e: string; n: string }
  return {
    key: priv,
    kid: createHash('sha256')
      .update(JSON.stringify({ e: j.e, kty: 'RSA', n: j.n }))
      .digest('base64url'),
  }
}
// a pass forged here, signed with any key under any kid
function signJwt(payload: Record<string, unknown>, key: KeyObject, kid: string): string {
  const b = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString('base64url')
  const base = `${b({ alg: 'RS256', typ: 'JWT', kid })}.${b(payload)}`
  return `${base}.${createSign('RSA-SHA256').update(base).sign(key).toString('base64url')}`
}

const brokerPriv = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey
const brokerKey = keyOf(brokerPriv)
const foreignKey = keyOf(generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey)

interface Injected {
  statusCode: number
  body: string
  headers: Record<string, string>
  json(): any
}
interface TestBroker {
  env: Env
  fetch(req: Request): Promise<Response>
  inject(o: { method?: string; url: string; payload?: unknown }): Promise<Injected>
}

/** the Worker, in-process, over a memory KV */
function broker(o: { authDomain?: string; proxyFetch?: typeof fetch } = {}): TestBroker {
  const kv = new Map<string, string>()
  const env: Env = {
    INSTANCES: {
      get: async (k) => kv.get(k) ?? null,
      put: async (k, v) => {
        kv.set(k, v)
      },
    },
    SILOS_ID_PRIVATE_KEY: brokerPriv.export({ format: 'pem', type: 'pkcs8' }).toString(),
    SILOS_ID_FIREBASE_API_KEY: 'k',
    SILOS_ID_FIREBASE_PROJECT: PROJECT,
    SILOS_ID_PUBLIC_URL: BROKER,
    ...(o.authDomain ? { SILOS_ID_FIREBASE_AUTH_DOMAIN: o.authDomain } : {}),
  }
  const worker = createBroker({ fetchImpl: googleFetch, ...(o.proxyFetch ? { proxyFetch: o.proxyFetch } : {}), now: () => NOW })
  const fetch = (req: Request): Promise<Response> => worker.fetch(req, env)
  return {
    env,
    fetch,
    async inject(o) {
      const res = await fetch(
        new Request(BROKER + o.url, {
          method: o.method ?? 'GET',
          ...(o.payload !== undefined ? { body: JSON.stringify(o.payload), headers: { 'content-type': 'application/json' } } : {}),
        }),
      )
      const body = await res.text()
      return { statusCode: res.status, body, headers: Object.fromEntries(res.headers), json: () => JSON.parse(body) }
    },
  }
}

// the instance's fetch, answered by the broker in-process
function brokerFetch(b: TestBroker): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(input))
    expect(u.origin).toBe(BROKER)
    return b.fetch(new Request(u, init))
  }) as typeof fetch
}

async function instance(opts: { client: SilosIdClient; onOwnerActivity?: () => void }): Promise<FastifyInstance> {
  const base = mkdtempSync(join(tmpdir(), 'silos-id-'))
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
    authNow: () => NOW,
    silosId: opts.client,
    ...(opts.onOwnerActivity ? { onOwnerActivity: opts.onOwnerActivity } : {}),
  })
}

const cookieFrom = (setCookie: unknown): string => String(Array.isArray(setCookie) ? setCookie[0] : setCookie).split(';')[0]!

describe('Silos ID broker (the Worker) — the way in picked on the instance', () => {
  let b: TestBroker
  beforeEach(() => {
    b = broker()
  })

  // the instance's own login page picked the method: the broker's page
  // only carries it out — a value it can't read is dropped, never guessed
  it('the page carries out the method the instance picked; an unreadable one is dropped', async () => {
    const id = (await b.inject({ method: 'POST', url: '/register', payload: { url: INSTANCE } })).json().instanceId as string
    const state = 'S'.repeat(32)
    const cfgOf = async (extra: string): Promise<Record<string, unknown>> => {
      const html = (await b.inject({ url: `/login?instance=${id}&state=${state}${extra}` })).body
      return JSON.parse(/const cfg = (\{.*?\});/s.exec(html)![1]!.replace(/\\u003c/g, '<')) as Record<string, unknown>
    }
    expect(await cfgOf('&method=email&email=Ana%40example.com')).toMatchObject({ method: 'email', email: 'Ana@example.com' })
    expect(await cfgOf('&method=google')).toMatchObject({ method: 'google' })
    const bad = await cfgOf('&method=sms&email=not-an-email')
    expect(bad.method).toBeUndefined()
    expect(bad.email).toBeUndefined()
    expect(await cfgOf('&method=email&email=%3Cscript%3E%40x.example.com')).not.toHaveProperty('email')
  })

  // Google by redirect (no click) needs Firebase's auth handler on the
  // broker's own domain — otherwise the page keeps the button (popup)
  it('redirect sign-in only when Firebase’s auth domain is the broker’s own', async () => {
    const own = broker({ authDomain: new URL(BROKER).host })
    for (const [inst, want] of [
      [b, false],
      [own, true],
    ] as const) {
      const id = (await inst.inject({ method: 'POST', url: '/register', payload: { url: INSTANCE } })).json().instanceId as string
      const html = (await inst.inject({ url: `/login?instance=${id}&state=${'S'.repeat(32)}&method=google` })).body
      expect(JSON.parse(/const cfg = (\{.*?\});/s.exec(html)![1]!).redirect).toBe(want)
    }
  })

  // the auth handler Firebase's redirect needs, served from the broker's
  // domain: only Firebase's own paths, passed through from the project's
  // firebaseapp.com — anything else is not the broker's
  it('proxies only Firebase’s auth paths, to the project’s own domain', async () => {
    const seen: string[] = []
    const upstream = (async (input: string | URL | Request) => {
      seen.push(String(input))
      return new Response('<html>handler</html>', { status: 200, headers: { 'content-type': 'text/html; charset=utf-8', 'x-other': 'dropped' } })
    }) as typeof fetch
    const p = broker({ proxyFetch: upstream })
    const h = await p.inject({ url: '/__/auth/handler?apiKey=k&mode=x' })
    expect(h.statusCode).toBe(200)
    expect(h.body).toBe('<html>handler</html>')
    expect(h.headers['content-type']).toContain('text/html')
    expect(h.headers['x-other']).toBeUndefined()
    expect((await p.inject({ url: '/__/firebase/init.json' })).statusCode).toBe(200)
    expect(seen).toEqual([`https://${PROJECT}.firebaseapp.com/__/auth/handler?apiKey=k&mode=x`, `https://${PROJECT}.firebaseapp.com/__/firebase/init.json`])
    for (const url of ['/__/other', '/__/auth/../../etc', '/__/authx']) expect((await p.inject({ url })).statusCode, url).toBe(404)
    expect((await p.inject({ method: 'POST', url: '/__/auth/handler', payload: {} })).statusCode).toBe(404)
  })
})

describe('Silos ID on the instance', () => {
  let b: TestBroker
  let client: SilosIdClient
  let app: FastifyInstance
  let clock: number
  beforeEach(async () => {
    clock = NOW
    b = broker()
    client = new SilosIdClient({ brokerUrl: BROKER, publicOrigin: INSTANCE, ownerEmails: [OWNER] }, { fetchImpl: brokerFetch(b), now: () => clock })
    app = await instance({ client })
  })

  /** start → (the popup) → the broker's exchange: the real pass + the browser's cookie */
  async function signIn(tokenExtra: Record<string, unknown> = {}): Promise<{ pass: string; state: string; cookie: string; instanceId: string }> {
    const start = await app.inject({ url: '/api/auth/silos-id/start', headers: REMOTE })
    expect(start.statusCode).toBe(302)
    const to = new URL(String(start.headers.location))
    expect(to.origin + to.pathname).toBe(`${BROKER}/login`)
    const instanceId = to.searchParams.get('instance')!
    const state = to.searchParams.get('state')!
    expect((await b.inject({ url: to.pathname + to.search })).statusCode).toBe(200)
    const ex = await b.inject({ method: 'POST', url: '/login/exchange', payload: { idToken: idToken(tokenExtra), instance: instanceId, state } })
    const back = new URL(ex.json().redirect)
    return { pass: back.searchParams.get('pass')!, state, cookie: cookieFrom(start.headers['set-cookie']), instanceId }
  }

  const callback = (pass: string, state: string, cookie: string) =>
    app.inject({ url: `/api/auth/silos-id/callback?pass=${encodeURIComponent(pass)}&state=${encodeURIComponent(state)}`, headers: { ...REMOTE, cookie } })

  const landed = (res: { headers: Record<string, unknown> }): URLSearchParams =>
    new URLSearchParams(new URL(String(res.headers.location), INSTANCE).hash.slice(1))

  // the method is picked on the instance's own page and travels to the
  // broker; an email that isn't one stops at the instance with a reason
  it('start carries the picked method to the broker; a bad email is said, never sent', async () => {
    const to = async (q: string): Promise<URL> =>
      new URL(String((await app.inject({ url: `/api/auth/silos-id/start${q}`, headers: REMOTE })).headers.location), INSTANCE)
    const email = await to('?method=email&email=ana%40example.com')
    expect(email.origin).toBe(BROKER)
    expect(email.searchParams.get('method')).toBe('email')
    expect(email.searchParams.get('email')).toBe('ana@example.com')
    expect((await to('?method=google')).searchParams.get('method')).toBe('google')
    expect((await to('')).searchParams.has('method')).toBe(false)
    expect((await to('?method=sms')).searchParams.has('method')).toBe(false)
    const bad = await to('?method=email&email=nope')
    expect(bad.origin).toBe(INSTANCE)
    expect(new URLSearchParams(bad.hash.slice(1)).get('silos-id-error')).toMatch(/email/)
  })

  // instance-usage.ts marks the hour on this: only the owner's credential
  // (a session from the sign-in, or the token) — never an anonymous read,
  // a refused credential, or the public sign-in routes
  it('owner activity is told for the owner’s credential only', async () => {
    let told = 0
    const counted = await instance({
      client,
      onOwnerActivity: () => {
        told++
      },
    })
    expect((await counted.inject({ url: '/api/agents' })).statusCode).toBe(401) // local, no identity: nothing under /api
    expect((await counted.inject({ url: '/api/agents', headers: { ...REMOTE, 'x-token': 'wrong' } })).statusCode).toBe(401)
    expect((await counted.inject({ url: '/api/agents', headers: { authorization: 'Bearer nope' } })).statusCode).toBe(401)
    expect((await counted.inject({ url: '/api/auth/config', headers: REMOTE })).statusCode).toBe(200)
    expect(told).toBe(0)
    expect((await counted.inject({ url: '/api/agents', headers: { ...REMOTE, 'x-token': TOKEN } })).statusCode).toBe(200)
    expect(told).toBe(1)
    await counted.close()
  })

  it('config announces the broker flow and leaks nothing', async () => {
    const res = await app.inject({ url: '/api/auth/config', headers: REMOTE })
    expect(res.json()).toEqual({ enabled: true, mode: 'silos-id' })
  })

  it('a valid pass mints the 7-day session: the browser lands signed in, a remote request is the owner', async () => {
    const { pass, state, cookie } = await signIn()
    const res = await callback(pass, state, cookie)
    expect(res.statusCode).toBe(302)
    const session = landed(res).get('silos-id')
    expect(session).toMatch(/^[0-9a-f]{64}$/)
    expect(landed(res).get('email')).toBe(OWNER)
    expect((await app.inject({ url: '/api/auth/me', headers: { ...REMOTE, 'x-token': session! } })).json()).toEqual({ who: 'owner' })
    expect((await app.inject({ url: '/api/overview', headers: { ...REMOTE, 'x-token': session! } })).statusCode).toBe(200)
    // remote without a credential still needs auth; the ?token= hatch is untouched
    expect((await app.inject({ url: '/api/overview', headers: REMOTE })).statusCode).toBe(401)
    expect((await app.inject({ url: `/api/overview?token=${TOKEN}`, headers: REMOTE })).statusCode).toBe(200)
  })

  it('a replayed state is refused — the state is single use', async () => {
    const { pass, state, cookie } = await signIn()
    expect(landed(await callback(pass, state, cookie)).get('silos-id')).toBeTruthy()
    const again = await callback(pass, state, cookie)
    expect(landed(again).get('silos-id')).toBeNull()
    expect(landed(again).get('silos-id-error')).toMatch(/already used|expired/)
  })

  it('a sign-in started in another browser (no or wrong binding cookie) is refused', async () => {
    const { pass, state } = await signIn()
    expect(landed(await callback(pass, state, 'silos_id_bind=someone-else')).get('silos-id')).toBeNull()
    const second = await signIn()
    expect(landed(await callback(second.pass, second.state, '')).get('silos-id')).toBeNull()
  })

  it('an email link returns to the same attempt and still needs the starting browser and a verified email', async () => {
    const start = await app.inject({ url: '/api/auth/silos-id/start', headers: REMOTE })
    const to = new URL(String(start.headers.location))
    const instanceId = to.searchParams.get('instance')!,
      state = to.searchParams.get('state')!
    // Firebase appends its own params to the continue URL: the page still serves
    expect((await b.inject({ url: `${to.pathname}${to.search}&apiKey=k&oobCode=abc&mode=signIn&lang=en` })).statusCode).toBe(200)
    const emailLink = { firebase: { sign_in_provider: 'password' } }
    expect(
      (
        await b.inject({
          method: 'POST',
          url: '/login/exchange',
          payload: { idToken: idToken({ ...emailLink, email_verified: false }), instance: instanceId, state },
        })
      ).statusCode,
    ).toBe(401)
    const ex = await b.inject({ method: 'POST', url: '/login/exchange', payload: { idToken: idToken(emailLink), instance: instanceId, state } })
    const pass = new URL(ex.json().redirect).searchParams.get('pass')!
    // opened in another browser: no bind cookie, no session (and the state is spent)
    expect(landed(await callback(pass, state, '')).get('silos-id')).toBeNull()
    // the starting browser completes a fresh attempt
    const again = await signIn(emailLink)
    expect(landed(await callback(again.pass, again.state, again.cookie)).get('silos-id')).toMatch(/^[0-9a-f]{64}$/)
  })

  it('a pass for another instance (aud), from another issuer, with a foreign key, or expired is refused', async () => {
    const cases: Array<[string, (s: { state: string; instanceId: string }) => string]> = [
      [
        'aud',
        (s) =>
          signJwt(
            { iss: BROKER, aud: 'another-instance-id-xyz', sub: 'u', email: OWNER, email_verified: true, nonce: s.state, iat: nowSec, exp: nowSec + 120 },
            brokerKey.key,
            brokerKey.kid,
          ),
      ],
      [
        'iss',
        (s) =>
          signJwt(
            {
              iss: 'https://evil.example.com',
              aud: s.instanceId,
              sub: 'u',
              email: OWNER,
              email_verified: true,
              nonce: s.state,
              iat: nowSec,
              exp: nowSec + 120,
            },
            brokerKey.key,
            brokerKey.kid,
          ),
      ],
      [
        'foreign key, same kid',
        (s) =>
          signJwt(
            { iss: BROKER, aud: s.instanceId, sub: 'u', email: OWNER, email_verified: true, nonce: s.state, iat: nowSec, exp: nowSec + 120 },
            foreignKey.key,
            brokerKey.kid,
          ),
      ],
      [
        'foreign key, own kid',
        (s) =>
          signJwt(
            { iss: BROKER, aud: s.instanceId, sub: 'u', email: OWNER, email_verified: true, nonce: s.state, iat: nowSec, exp: nowSec + 120 },
            foreignKey.key,
            foreignKey.kid,
          ),
      ],
      [
        'expired',
        (s) =>
          signJwt(
            { iss: BROKER, aud: s.instanceId, sub: 'u', email: OWNER, email_verified: true, nonce: s.state, iat: nowSec - 600, exp: nowSec - 300 },
            brokerKey.key,
            brokerKey.kid,
          ),
      ],
      [
        'nonce',
        (s) =>
          signJwt(
            { iss: BROKER, aud: s.instanceId, sub: 'u', email: OWNER, email_verified: true, nonce: 'another-state-0000000', iat: nowSec, exp: nowSec + 120 },
            brokerKey.key,
            brokerKey.kid,
          ),
      ],
      [
        'unverified email',
        (s) =>
          signJwt(
            { iss: BROKER, aud: s.instanceId, sub: 'u', email: OWNER, email_verified: false, nonce: s.state, iat: nowSec, exp: nowSec + 120 },
            brokerKey.key,
            brokerKey.kid,
          ),
      ],
      [
        'alg none',
        (s) =>
          `${Buffer.from(JSON.stringify({ alg: 'none', kid: brokerKey.kid })).toString('base64url')}.${Buffer.from(JSON.stringify({ iss: BROKER, aud: s.instanceId, sub: 'u', email: OWNER, email_verified: true, nonce: s.state, iat: nowSec, exp: nowSec + 120 })).toString('base64url')}.`,
      ],
    ]
    for (const [name, forge] of cases) {
      // a fresh pair per case: the sign-in routes are rate-limited (10/min)
      b = broker()
      client = new SilosIdClient({ brokerUrl: BROKER, publicOrigin: INSTANCE, ownerEmails: [OWNER] }, { fetchImpl: brokerFetch(b), now: () => clock })
      app = await instance({ client })
      const s = await signIn()
      const res = await callback(forge(s), s.state, s.cookie)
      expect(landed(res).get('silos-id'), name).toBeNull()
      expect(landed(res).get('silos-id-error'), name).toBeTruthy()
    }
  })

  it("the broker's own pass expires after 120 s", async () => {
    const s = await signIn()
    clock = NOW + 200_000
    expect(landed(await callback(s.pass, s.state, s.cookie)).get('silos-id')).toBeNull()
  })

  it('an email outside the allowed set is refused — no first-login ownership', async () => {
    const s = await signIn({ email: 'stranger@example.com' })
    const res = await callback(s.pass, s.state, s.cookie)
    expect(landed(res).get('silos-id')).toBeNull()
    expect(landed(res).get('silos-id-error')).toMatch(/not authorized/)
  })

  it('the allowed set is case-insensitive and may hold several emails', async () => {
    const two = new SilosIdClient(
      silosIdSettingsFromEnv({ SILOS_ID_URL: BROKER, SILOS_PUBLIC_URL: INSTANCE, SILOS_OWNER_EMAIL: 'a@example.com, Owner@Example.com' }) as never,
      { fetchImpl: brokerFetch(b), now: () => clock },
    )
    app = await instance({ client: two })
    const s = await signIn()
    expect(landed(await callback(s.pass, s.state, s.cookie)).get('silos-id')).toBeTruthy()
  })
})

describe('Silos ID client mode from the environment', () => {
  it('SILOS_ID_URL turns it on; unset is off, whatever else is set', () => {
    const env = { SILOS_ID_URL: BROKER, SILOS_PUBLIC_URL: INSTANCE, SILOS_OWNER_EMAIL: OWNER }
    expect(silosIdSettingsFromEnv(env)).toEqual({ brokerUrl: BROKER, publicOrigin: INSTANCE, ownerEmails: [OWNER] })
    expect(silosIdSettingsFromEnv({ SILOS_PUBLIC_URL: INSTANCE, SILOS_OWNER_EMAIL: OWNER })).toBeNull()
  })

  it('the public origin falls back to Railway; no owner email or no origin = off', () => {
    expect(silosIdSettingsFromEnv({ SILOS_ID_URL: BROKER, RAILWAY_PUBLIC_DOMAIN: 'x.up.railway.app', SILOS_OWNER_EMAIL: OWNER })).toMatchObject({
      publicOrigin: 'https://x.up.railway.app',
    })
    expect(silosIdSettingsFromEnv({ SILOS_ID_URL: BROKER, SILOS_PUBLIC_URL: INSTANCE })).toHaveProperty('off')
    expect(silosIdSettingsFromEnv({ SILOS_ID_URL: BROKER, SILOS_OWNER_EMAIL: OWNER })).toHaveProperty('off')
    expect(silosIdSettingsFromEnv({ SILOS_ID_URL: 'http://id.example.com', SILOS_PUBLIC_URL: INSTANCE, SILOS_OWNER_EMAIL: OWNER })).toHaveProperty('off')
  })

  it('the registration persists for its broker and origin only', async () => {
    const b = broker()
    const dir = mkdtempSync(join(tmpdir(), 'silos-id-reg-'))
    const c1 = new SilosIdClient({ brokerUrl: BROKER, publicOrigin: INSTANCE, ownerEmails: [OWNER] }, { dataDir: dir, fetchImpl: brokerFetch(b) })
    const id = await c1.ensureRegistered()
    expect(JSON.parse(readFileSync(join(dir, 'silos-id.json'), 'utf8'))).toEqual({ broker: BROKER, origin: INSTANCE, instanceId: id, key: expect.any(String) })
    let fetched = 0
    const counting = (async (...a: Parameters<typeof fetch>) => {
      fetched++
      return brokerFetch(b)(...a)
    }) as typeof fetch
    const c2 = new SilosIdClient({ brokerUrl: BROKER, publicOrigin: INSTANCE, ownerEmails: [OWNER] }, { dataDir: dir, fetchImpl: counting })
    expect(await c2.ensureRegistered()).toBe(id)
    expect(fetched).toBe(0)
  })
})

describe('server.env — the deploy settings an install keeps across restarts', () => {
  const dir = (): string => mkdtempSync(join(tmpdir(), 'silos-server-env-'))

  it('is read from the data dir: KEY=VALUE, comments, optional quotes', () => {
    const d = dir()
    writeFileSync(
      join(d, 'server.env'),
      ['# Silos ID', `SILOS_ID_URL=${BROKER}`, '', `  SILOS_PUBLIC_URL = "${INSTANCE}"  `, `SILOS_OWNER_EMAIL='${OWNER}, b@example.com'`].join('\n'),
    )
    const parsed = readServerEnv(d)
    expect(parsed.values).toEqual({ SILOS_ID_URL: BROKER, SILOS_PUBLIC_URL: INSTANCE, SILOS_OWNER_EMAIL: `${OWNER}, b@example.com` })
    expect(serverEnvWarning(parsed)).toBeNull()
    expect(silosIdSettingsFromEnv({ ...serverSettings({}, parsed.values) })).toEqual({
      brokerUrl: BROKER,
      publicOrigin: INSTANCE,
      ownerEmails: [OWNER, 'b@example.com'],
    })
    expect(readServerEnv(dir())).toEqual({ values: {}, unknown: [], malformed: [] }) // no file: nothing
  })

  it('the real environment wins over the file; an empty variable does not', () => {
    const file = { SILOS_ID_URL: BROKER, SILOS_PUBLIC_URL: INSTANCE, SILOS_OWNER_EMAIL: OWNER }
    expect(serverSettings({ SILOS_OWNER_EMAIL: 'env@example.com', SILOS_PUBLIC_URL: '  ' }, file)).toEqual({ ...file, SILOS_OWNER_EMAIL: 'env@example.com' })
  })

  it("never reaches process.env: the merged view is a copy, the file's values stay out of every child's environment", () => {
    const d = dir()
    writeFileSync(join(d, 'server.env'), 'SILOS_OWNER_EMAIL=file-only@example.com\nSILOS_ID_URL=https://id.example.com\n')
    const before = { ...process.env }
    const env = { ...process.env }
    delete env.SILOS_OWNER_EMAIL
    delete env.SILOS_ID_URL
    const merged = serverSettings(env, readServerEnv(d).values)
    expect(merged.SILOS_OWNER_EMAIL).toBe('file-only@example.com')
    expect(process.env).toEqual(before)
    expect(env.SILOS_OWNER_EMAIL).toBeUndefined()
  })

  it('malformed lines and unknown keys are ignored — and named, keys only (never values)', () => {
    const parsed = parseServerEnv(
      [
        'SILOS_ID_URL', // no =
        '=https://x.example.com', // no key
        'BAD KEY=1', // not a key
        'SILOS_PUBLIC_URL="https://open.example.com', // unclosed quote
        'SILOS_TOKEN=secret-value', // not server.env's to hold
        'SILOS_PORT=4000',
        `SILOS_OWNER_EMAIL=${OWNER}`,
      ].join('\n'),
    )
    expect(parsed.values).toEqual({ SILOS_OWNER_EMAIL: OWNER })
    expect(parsed.unknown).toEqual(['SILOS_TOKEN', 'SILOS_PORT'])
    expect(parsed.malformed).toEqual([1, 2, 3, 4])
    const line = serverEnvWarning(parsed)!
    expect(line).toContain('SILOS_TOKEN')
    expect(line).not.toContain('secret-value')
  })
})
