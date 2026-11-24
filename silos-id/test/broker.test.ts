// The Silos ID Worker, run in Node: WebCrypto as in a Worker, a memory KV,
// Google's JWKS answered by an injected fetch, every key generated here. No
// network. The last block is end to end: the Worker signs, the instance's
// own verifier (server/src/silos-id.ts) accepts.
import { describe, it, expect, beforeEach } from 'vitest'
import { createSign, generateKeyPairSync } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  createBroker,
  brokerConfig,
  normalizeOrigin,
  INSTANCE_ID,
  PASS_TTL_S,
  STATE,
  SIGN_IN_EMAIL,
  readSignInPick,
  countLogin,
  USAGE_DAYS,
  type Broker,
  type Env,
  type InstanceRecord,
} from '../src/broker.js'
import * as instanceSide from '../../server/src/silos-id.js'

const NOW = 1_700_000_000_000
const nowSec = Math.floor(NOW / 1000)
const BROKER = 'https://id.silos.test'
const INSTANCE = 'https://my-silos.example.com'
const PROJECT = 'silos-test'
const OWNER = 'owner@example.com'
const STATE_A = 'S'.repeat(32)

// Google's side: the Firebase ID token the popup would yield
const google = generateKeyPairSync('rsa', { modulusLength: 2048 })
const googleJwk = { ...(google.publicKey.export({ format: 'jwk' }) as Record<string, unknown>), kid: 'g1', alg: 'RS256' }
const googleFetch = (async () =>
  new Response(JSON.stringify({ keys: [googleJwk] }), { status: 200, headers: { 'cache-control': 'max-age=600' } })) as typeof fetch
const b64 = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString('base64url')
function idToken(extra: Record<string, unknown> = {}, key = google.privateKey): string {
  const base = `${b64({ alg: 'RS256', kid: 'g1' })}.${b64({ aud: PROJECT, iss: `https://securetoken.google.com/${PROJECT}`, sub: 'uid-1', iat: nowSec - 5, exp: nowSec + 3600, email: OWNER, email_verified: true, ...extra })}`
  return `${base}.${createSign('RSA-SHA256').update(base).sign(key).toString('base64url')}`
}

const pem = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ format: 'pem', type: 'pkcs8' }).toString()

function memoryKV(): Env['INSTANCES'] & { map: Map<string, string> } {
  const map = new Map<string, string>()
  return {
    map,
    get: async (k) => map.get(k) ?? null,
    put: async (k, v) => {
      map.set(k, v)
    },
  }
}

function envWith(over: Partial<Env> = {}): Env {
  return {
    INSTANCES: memoryKV(),
    SILOS_ID_PRIVATE_KEY: pem,
    SILOS_ID_FIREBASE_API_KEY: 'k',
    SILOS_ID_FIREBASE_PROJECT: PROJECT,
    SILOS_ID_PUBLIC_URL: BROKER,
    ...over,
  }
}

let clock = NOW
let broker: Broker
let env: Env
beforeEach(() => {
  clock = NOW
  broker = createBroker({ fetchImpl: googleFetch, now: () => clock })
  env = envWith()
})

const call = (path: string, init?: { method?: string; body?: unknown; ip?: string }): Promise<Response> =>
  broker.fetch(
    new Request(BROKER + path, {
      method: init?.method ?? (init?.body !== undefined ? 'POST' : 'GET'),
      headers: { 'content-type': 'application/json', ...(init?.ip ? { 'cf-connecting-ip': init.ip } : {}) },
      ...(init?.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    }),
    env,
  )

async function register(url: string, ip?: string): Promise<string> {
  const res = await call('/register', { body: { url }, ...(ip ? { ip } : {}) })
  expect(res.status, url).toBe(200)
  return ((await res.json()) as { instanceId: string }).instanceId
}

const exchange = (body: Record<string, unknown>, ip?: string): Promise<Response> => call('/login/exchange', { body, ...(ip ? { ip } : {}) })

describe('configuration', () => {
  it('no Firebase project, key or signing key: every route but /healthz refuses, naming what is missing', async () => {
    env = envWith({ SILOS_ID_FIREBASE_PROJECT: '', SILOS_ID_PRIVATE_KEY: undefined })
    expect((await call('/healthz')).status).toBe(200)
    const res = await call('/jwks')
    expect(res.status).toBe(500)
    expect(((await res.json()) as { error: string }).error).toMatch(/SILOS_ID_FIREBASE_PROJECT and SILOS_ID_PRIVATE_KEY/)
    expect(brokerConfig(envWith({ SILOS_ID_PUBLIC_URL: 'http://auth.example.com' }))).toMatch(/not an https origin/)
    expect(brokerConfig(envWith())).toMatchObject({ firebase: { authDomain: `${PROJECT}.firebaseapp.com` }, issuer: BROKER })
  })

  it('anything but the routes is a 404', async () => {
    expect((await call('/api/agents')).status).toBe(404)
    expect((await call('/register')).status).toBe(404) // GET
  })
})

describe('register', () => {
  it('is idempotent per origin, normalizes to the origin, and adds no key for a known origin', async () => {
    const kv = env.INSTANCES as ReturnType<typeof memoryKV>
    const id = await register(INSTANCE)
    const writes = kv.map.size
    expect(await register(`${INSTANCE}/some/path?x=1`)).toBe(id)
    expect(kv.map.size).toBe(writes)
    expect(id).toMatch(INSTANCE_ID)
    expect(await register('https://other.example.com')).not.toBe(id)
  })

  it('takes https origins and http only for loopback', async () => {
    for (const url of ['http://localhost:3210', 'http://127.0.0.1:3210', 'http://[::1]:3210']) await register(url)
    for (const url of ['http://evil.example.com', 'javascript:alert(1)', 'https://user:pw@x.example.com', 'not a url', 42, null]) {
      expect((await call('/register', { body: { url } })).status, String(url)).toBe(400)
    }
    expect((await call('/register', { method: 'POST' })).status).toBe(400)
    expect((await broker.fetch(new Request(BROKER + '/register', { method: 'POST', body: '{nope' }), env)).status).toBe(400)
    expect((await call('/register', { body: { url: INSTANCE, pad: 'x'.repeat(20_000) } })).status).toBe(413)
  })

  it('is rate-limited per IP', async () => {
    const codes: number[] = []
    for (let i = 0; i < 25; i++) codes.push((await call('/register', { body: { url: `https://s${i}.example.com` }, ip: '1.1.1.1' })).status)
    expect(codes).toContain(429)
    expect((await call('/register', { body: { url: INSTANCE }, ip: '2.2.2.2' })).status).toBe(200)
    clock += 61_000
    expect((await call('/register', { body: { url: INSTANCE }, ip: '1.1.1.1' })).status).toBe(200)
  })
})

describe('login page', () => {
  it('serves only for a registered instance and a well-formed state, under a nonce CSP', async () => {
    const id = await register(INSTANCE)
    const ok = await call(`/login?instance=${id}&state=${STATE_A}`)
    expect(ok.status).toBe(200)
    const csp = ok.headers.get('content-security-policy') ?? ''
    const nonce = /'nonce-([^']+)'/.exec(csp)?.[1]
    expect(nonce).toBeTruthy()
    expect(await ok.text()).toContain(`nonce="${nonce}"`)
    expect(ok.headers.get('cache-control')).toBe('no-store')
    // Firebase appends its own params to an email link's continue URL
    expect((await call(`/login?instance=${id}&state=${STATE_A}&apiKey=k&oobCode=abc&mode=signIn&lang=en`)).status).toBe(200)
    expect((await call(`/login?instance=${'x'.repeat(22)}&state=${STATE_A}`)).status).toBe(400)
    expect((await call(`/login?instance=${id}&state=short`)).status).toBe(400)
    expect((await call(`/login?state=${STATE_A}`)).status).toBe(400)
  })
})

describe('the way in, picked on the instance', () => {
  const cfgOf = async (q: string): Promise<Record<string, unknown>> => {
    const html = await (await call(`/login?instance=${await register(INSTANCE)}&state=${STATE_A}${q}`)).text()
    return JSON.parse(/const cfg = (\{.*?\});/s.exec(html)![1]!.replace(/\\u003c/g, '<')) as Record<string, unknown>
  }

  // the page sends the link at once: it gets the method and the address
  it('method=email carries the address to the page; an address that isn’t one is dropped', async () => {
    expect(await cfgOf('&method=email&email=ana%40example.com')).toMatchObject({ method: 'email', email: 'ana@example.com' })
    for (const bad of ['nope', '%3Cb%3E%40x.example.com', 'a%40b', `${'a'.repeat(250)}%40x.example.com`]) {
      const c = await cfgOf(`&method=email&email=${bad}`)
      expect(c, bad).not.toHaveProperty('email')
      expect(c, bad).not.toHaveProperty('method')
    }
    expect(await cfgOf('&method=sms&email=ana%40example.com')).not.toHaveProperty('email')
  })

  it('Google by redirect only when Firebase’s auth domain is this broker’s host', async () => {
    expect((await cfgOf('&method=google')).redirect).toBe(false)
    env = envWith({ SILOS_ID_FIREBASE_AUTH_DOMAIN: new URL(BROKER).host })
    expect((await cfgOf('&method=google')).redirect).toBe(true)
  })

  it('passes through only Firebase’s auth paths, only GET, to the project’s domain, with the allowed headers', async () => {
    const seen: string[] = []
    broker = createBroker({
      fetchImpl: googleFetch,
      now: () => clock,
      proxyFetch: (async (input: string | URL | Request) => {
        const u = String(input)
        seen.push(u)
        if (u.endsWith('/__/firebase/init.json')) return new Response('nope', { status: 404 })
        return new Response('<html>handler</html>', {
          status: 302,
          headers: { 'content-type': 'text/html', location: 'https://accounts.google.com/x', 'set-cookie': 'a=b', 'x-other': '1' },
        })
      }) as typeof fetch,
    })
    const h = await call('/__/auth/handler?apiKey=k')
    expect(h.status).toBe(302)
    expect(h.headers.get('location')).toBe('https://accounts.google.com/x')
    expect(h.headers.get('set-cookie')).toBeNull()
    expect(h.headers.get('x-other')).toBeNull()
    expect(await h.text()).toBe('<html>handler</html>')
    expect((await call('/__/firebase/init.json')).status).toBe(404)
    expect(seen).toEqual([`https://${PROJECT}.firebaseapp.com/__/auth/handler?apiKey=k`, `https://${PROJECT}.firebaseapp.com/__/firebase/init.json`])
    for (const path of ['/__/other', '/__/auth/../../etc', '/__/authx', '/__/auth/', '/__/firebase/init.js']) expect((await call(path)).status, path).toBe(404)
    for (const method of ['POST', 'PUT', 'DELETE']) expect((await call('/__/auth/handler', { method, body: {} })).status, method).toBe(404)
    expect(seen).toHaveLength(2)
  })

  it('an unreachable Firebase is a 502, never another host', async () => {
    broker = createBroker({
      fetchImpl: googleFetch,
      now: () => clock,
      proxyFetch: (async () => {
        throw new Error('down')
      }) as typeof fetch,
    })
    expect((await call('/__/auth/handler')).status).toBe(502)
  })
})

describe('exchange', () => {
  it('redirects only to the REGISTERED origin, whatever the request names', async () => {
    const id = await register(INSTANCE)
    const res = await exchange({ idToken: idToken(), instance: id, state: STATE_A, redirect: 'https://evil.example.com', origin: 'https://evil.example.com' })
    expect(res.status).toBe(200)
    const to = new URL(((await res.json()) as { redirect: string }).redirect)
    expect(to.origin).toBe(INSTANCE)
    expect(to.pathname).toBe('/api/auth/silos-id/callback')
    expect(to.searchParams.get('state')).toBe(STATE_A)
    expect((await exchange({ idToken: idToken(), instance: 'x'.repeat(22), state: STATE_A })).status).toBe(400)
    expect((await exchange({ idToken: idToken(), instance: id, state: 'bad' })).status).toBe(400)
    expect((await exchange({ instance: id, state: STATE_A })).status).toBe(400)
  })

  it('refuses unverified email, wrong audience or issuer, expired, foreign-signed and tampered tokens', async () => {
    const id = await register(INSTANCE)
    const good = idToken()
    const [h, p, s] = good.split('.') as [string, string, string]
    const tampered = `${h}.${b64({ ...JSON.parse(Buffer.from(p, 'base64url').toString()), email: 'attacker@example.com' })}.${s}`
    const foreign = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey
    const cases: Array<[string, string]> = [
      ['unverified', idToken({ email_verified: false })],
      ['aud', idToken({ aud: 'another-project' })],
      ['iss', idToken({ iss: 'https://securetoken.google.com/another-project' })],
      ['expired', idToken({ iat: nowSec - 7200, exp: nowSec - 3600 })],
      ['future', idToken({ iat: nowSec + 3600 })],
      ['no email', idToken({ email: '' })],
      ['foreign key', idToken({}, foreign)],
      ['tampered', tampered],
      ['alg none', `${b64({ alg: 'none', kid: 'g1' })}.${p}.`],
      ['garbage', 'a.b.c'],
    ]
    for (const [name, token] of cases) {
      const res = await exchange({ idToken: token, instance: id, state: STATE_A }, `10.0.0.${cases.findIndex(([n]) => n === name)}`)
      expect(res.status, name).toBe(401)
      expect(((await res.json()) as { error?: string }).error, name).toBeTruthy()
    }
  })

  it('is rate-limited per IP', async () => {
    const id = await register(INSTANCE)
    const codes: number[] = []
    for (let i = 0; i < 12; i++) codes.push((await exchange({ idToken: idToken(), instance: id, state: STATE_A }, '3.3.3.3')).status)
    expect(codes.slice(0, 10).every((c) => c === 200)).toBe(true)
    expect(codes).toContain(429)
  })
})

describe('usage', () => {
  const recordOf = (id: string): InstanceRecord => JSON.parse((env.INSTANCES as ReturnType<typeof memoryKV>).map.get(`id:${id}`)!) as InstanceRecord
  it('counts boots and passes per instance and per UTC day, by email, and keeps USAGE_DAYS days', async () => {
    const id = await register(INSTANCE)
    await register(INSTANCE)
    const other = await register('https://other.example.com')
    expect(recordOf(id)).toMatchObject({ origin: INSTANCE, boots: 2, lastBootAt: NOW })
    expect((await exchange({ idToken: idToken({ email: 'Ana@example.com' }), instance: id, state: STATE_A })).status).toBe(200)
    expect((await exchange({ idToken: idToken({ email: 'ana@example.com' }), instance: id, state: STATE_A })).status).toBe(200)
    expect((await exchange({ idToken: idToken({ email: 'bo@example.com' }), instance: id, state: STATE_A })).status).toBe(200)
    // a refused sign-in is not a login
    expect((await exchange({ idToken: idToken({ email_verified: false }), instance: id, state: STATE_A })).status).toBe(401)
    const today = new Date(NOW).toISOString().slice(0, 10)
    expect(recordOf(id)).toMatchObject({ logins: 3, lastLoginAt: NOW, days: { [today]: { logins: 3, users: { 'ana@example.com': 2, 'bo@example.com': 1 } } } })
    expect(recordOf(other).logins).toBeUndefined()
    const later = countLogin(recordOf(id), 'ana@example.com', NOW + USAGE_DAYS * 86_400_000)
    expect(Object.keys(later.days!)).toEqual([new Date(NOW + USAGE_DAYS * 86_400_000).toISOString().slice(0, 10)])
    expect(later.logins).toBe(4)
  })

  it('a KV that refuses writes never stops a sign-in', async () => {
    const id = await register(INSTANCE)
    const kv = env.INSTANCES as ReturnType<typeof memoryKV>
    env = {
      ...env,
      INSTANCES: {
        get: kv.get,
        put: async () => {
          throw new Error('KV down')
        },
      },
    }
    expect((await exchange({ idToken: idToken(), instance: id, state: STATE_A })).status).toBe(200)
    expect((await call('/register', { body: { url: INSTANCE } })).status).toBe(200)
  })
})

describe('signing key', () => {
  it('/jwks publishes the public half only, under a kid stable across isolates', async () => {
    const a = (await (await call('/jwks')).json()) as { keys: Array<Record<string, unknown>> }
    broker = createBroker({ fetchImpl: googleFetch, now: () => clock })
    const b = (await (await call('/jwks')).json()) as { keys: Array<Record<string, unknown>> }
    expect(a.keys).toHaveLength(1)
    expect(b.keys[0]!.kid).toBe(a.keys[0]!.kid)
    expect(Object.keys(a.keys[0]!).sort()).toEqual(['alg', 'e', 'kid', 'kty', 'n', 'use'])
  })

  it('scripts/gen-key.mjs prints a PKCS8 PEM the Worker signs with', async () => {
    const script = fileURLToPath(new URL('../scripts/gen-key.mjs', import.meta.url))
    const fresh = execFileSync(process.execPath, [script], { encoding: 'utf8' })
    expect(fresh).toMatch(/^-----BEGIN PRIVATE KEY-----/)
    env = envWith({ SILOS_ID_PRIVATE_KEY: fresh })
    expect((await call('/jwks')).status).toBe(200)
  })
})

describe('end to end: the Worker signs, the instance verifies', () => {
  const brokerFetch = (async (input: string | URL | Request, init?: RequestInit) => broker.fetch(new Request(input, init), env)) as typeof fetch

  it('shares the wire contract with the instance', () => {
    expect(PASS_TTL_S).toBe(instanceSide.PASS_TTL_S)
    expect(String(INSTANCE_ID)).toBe(String(instanceSide.INSTANCE_ID))
    expect(String(STATE)).toBe(String(instanceSide.STATE))
    expect(String(SIGN_IN_EMAIL)).toBe(String(instanceSide.SIGN_IN_EMAIL))
    for (const q of [{ method: 'google' }, { method: 'email', email: ' a@b.example.com ' }, { method: 'email', email: 'x' }, { method: 'sms' }, {}]) {
      expect(readSignInPick(q), JSON.stringify(q)).toEqual(instanceSide.readSignInPick(q))
    }
    for (const raw of ['https://a.example.com/x', 'http://localhost:1', 'http://127.0.0.1', 'http://a.example.com', 'https://u:p@a.example.com', 'ftp://a']) {
      expect(normalizeOrigin(raw), raw).toBe(instanceSide.normalizeOrigin(raw))
    }
  })

  async function signIn(client: instanceSide.SilosIdClient, tokenExtra: Record<string, unknown> = {}): Promise<{ pass: string; state: string; bind: string }> {
    const { location, state, bind } = await client.start()
    const to = new URL(location)
    expect(to.origin + to.pathname).toBe(`${BROKER}/login`)
    expect((await brokerFetch(location)).status).toBe(200)
    const res = await exchange({ idToken: idToken(tokenExtra), instance: to.searchParams.get('instance'), state })
    expect(res.status).toBe(200)
    const back = new URL(((await res.json()) as { redirect: string }).redirect)
    expect(back.origin).toBe(INSTANCE)
    return { pass: back.searchParams.get('pass')!, state: back.searchParams.get('state')!, bind }
  }

  const client = (): instanceSide.SilosIdClient =>
    new instanceSide.SilosIdClient({ brokerUrl: BROKER, publicOrigin: INSTANCE, ownerEmails: [OWNER] }, { fetchImpl: brokerFetch, now: () => clock })

  it('a pass from the Worker completes the sign-in on the instance', async () => {
    const c = client()
    const s = await signIn(c, { name: 'Owner', picture: 'https://example.com/p.png' })
    expect(await c.complete(s.pass, s.state, s.bind)).toEqual({ email: OWNER, name: 'Owner', picture: 'https://example.com/p.png' })
  })

  it('the instance refuses a Worker pass that is replayed, expired, or for another instance', async () => {
    const c = client()
    const s = await signIn(c)
    await c.complete(s.pass, s.state, s.bind)
    await expect(c.complete(s.pass, s.state, s.bind)).rejects.toThrow(/already used|expired/)

    const late = await signIn(c)
    clock += (PASS_TTL_S + 60) * 1000
    await expect(c.complete(late.pass, late.state, late.bind)).rejects.toThrow(/expired/)
    clock = NOW

    // the same pass shape, aimed at another registered instance
    const other = new instanceSide.SilosIdClient(
      { brokerUrl: BROKER, publicOrigin: 'https://other.example.com', ownerEmails: [OWNER] },
      { fetchImpl: brokerFetch, now: () => clock },
    )
    const mine = await signIn(c)
    const { state, bind } = await other.start()
    await expect(other.complete(mine.pass, state, bind)).rejects.toThrow(/another Silos|another sign-in/)
  })

  it('an issuer other than the instance expects is refused', async () => {
    env = envWith({ SILOS_ID_PUBLIC_URL: 'https://not-the-broker.example.com' })
    const c = client()
    const s = await signIn(c)
    await expect(c.complete(s.pass, s.state, s.bind)).rejects.toThrow(/not issued by this Silos ID/)
  })
})
