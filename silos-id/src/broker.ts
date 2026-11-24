// Silos ID broker: one Google login for ANY Silos instance on ANY domain.
//
// Firebase only signs in on AUTHORIZED domains (no wildcards), so an
// instance on a fresh domain cannot run the popup itself. The broker is the
// one authorized domain. Routes (nothing else is served):
//   POST /register {url}        an instance's public origin → {instanceId}
//                               (idempotent per origin, rate-limited)
//   GET  /login?instance&state[&method&email]
//                               the sign-in page. The way in is picked on
//                               the instance (method=google|email, email):
//                               an email link is sent at once; Google opens
//                               by redirect when Firebase's auth domain is
//                               this broker's own, else by button + popup.
//                               No method: the page offers both. An email
//                               link returns to this same URL.
//   GET  /__/auth/*, /__/firebase/init.json
//                               Firebase's auth handler on this domain (what
//                               the redirect needs), passed through from
//                               <project>.firebaseapp.com — only these
//                               paths, only GET
//   POST /login/exchange        the page's Firebase ID token → {redirect}:
//                               the REGISTERED origin + the callback with a
//                               signed pass, never anywhere else
//   GET  /jwks                  the broker's public key
//   GET  /healthz
// The pass is a short RS256 JWT: {iss: the broker's origin, aud: the
// instance id, sub: the Firebase uid, email, email_verified, name?,
// picture?, nonce: the instance's state, iat, exp: +120 s}. The instance
// (server/src/silos-id.ts) verifies it against /jwks, checks the state it
// bound to the browser, and decides who gets in (SILOS_OWNER_EMAIL): the
// broker lets nobody in by itself and stores no account, only origins.
import { GoogleKeys, importSigningKey, randomId, signJwt, verifyFirebaseIdToken, type SigningKey } from './jwt.js'
import { loginPage, type BrokerFirebase } from './page.js'

/** The wire contract with the instance (server/src/silos-id.ts holds the
 *  same values: the end-to-end test pins them together). */
export const PASS_TTL_S = 120
export const INSTANCE_ID = /^[A-Za-z0-9_-]{16,64}$/
export const STATE = /^[A-Za-z0-9_-]{16,128}$/
/** How the owner chose to sign in, on the instance's own page. */
export interface SignInPick {
  method?: 'google' | 'email'
  email?: string
}
/** An address that can be sent a link — plain, short, nothing markup could
 *  use (it is echoed on the page) */
export const SIGN_IN_EMAIL = /^[^\s@<>"'()&;\\]{1,64}@[^\s@<>"'()&;\\]{1,189}\.[^\s@<>"'()&;\\]{2,}$/
/** a pick read from a query: what can't be read is dropped (null = an email
 *  method whose address isn't one) */
export function readSignInPick(q: Record<string, unknown>): SignInPick | null {
  if (q.method === 'google') return { method: 'google' }
  if (q.method !== 'email') return {}
  const email = typeof q.email === 'string' ? q.email.trim() : ''
  return email.length <= 254 && SIGN_IN_EMAIL.test(email) ? { method: 'email', email } : null
}

// Firebase's own paths the redirect sign-in needs on the auth domain — the
// broker passes these, and only these, through to the project's domain
const FIREBASE_PATH = /^\/__\/(auth\/[A-Za-z0-9_-][A-Za-z0-9._-]*|firebase\/init\.json)$/
const PASSED_HEADERS = ['content-type', 'cache-control', 'content-security-policy', 'x-frame-options', 'referrer-policy', 'location']

/** The slice of Workers KV the registry uses. */
export interface KV {
  get(key: string): Promise<string | null>
  put(key: string, value: string): Promise<void>
}

export interface Env {
  /** KV: `origin:<origin>` → id, `id:<id>` → {origin, registeredAt} */
  INSTANCES: KV
  /** Worker secret: the PKCS8 PEM that signs the passes (scripts/gen-key.mjs) */
  SILOS_ID_PRIVATE_KEY?: string
  SILOS_ID_FIREBASE_API_KEY?: string
  SILOS_ID_FIREBASE_PROJECT?: string
  SILOS_ID_FIREBASE_AUTH_DOMAIN?: string
  /** the broker's own origin, the passes' iss (else the request's origin) */
  SILOS_ID_PUBLIC_URL?: string
}

const LOOPBACK = /^(127\.\d+\.\d+\.\d+|localhost|\[::1\])$/i

/** A public origin (scheme://host[:port]) or null. https only; plain http
 *  only for a loopback host (a local broker/instance pair). */
export function normalizeOrigin(raw: string): string | null {
  let u: URL
  try {
    u = new URL(raw.trim())
  } catch {
    return null
  }
  if (u.username !== '' || u.password !== '') return null
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && LOOPBACK.test(u.hostname))) return null
  return u.origin
}

interface Config {
  firebase: BrokerFirebase
  pem: string
  issuer: string | null
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null)

/** The broker's configuration, or what is missing in the words it refuses
 *  with. There is no default Firebase project. */
export function brokerConfig(env: Env): Config | string {
  const apiKey = str(env.SILOS_ID_FIREBASE_API_KEY)
  const projectId = str(env.SILOS_ID_FIREBASE_PROJECT)
  const pem = str(env.SILOS_ID_PRIVATE_KEY)
  const missing = [
    ...(apiKey ? [] : ['SILOS_ID_FIREBASE_API_KEY']),
    ...(projectId ? [] : ['SILOS_ID_FIREBASE_PROJECT']),
    ...(pem ? [] : ['SILOS_ID_PRIVATE_KEY']),
  ]
  if (!apiKey || !projectId || !pem) return `Silos ID broker: set ${missing.join(' and ')} (silos-id/README.md)`
  const rawIssuer = str(env.SILOS_ID_PUBLIC_URL)
  const issuer = rawIssuer ? normalizeOrigin(rawIssuer) : null
  if (rawIssuer && !issuer) return `Silos ID broker: SILOS_ID_PUBLIC_URL is not an https origin (${rawIssuer})`
  return {
    firebase: { apiKey, projectId, authDomain: str(env.SILOS_ID_FIREBASE_AUTH_DOMAIN) ?? `${projectId}.firebaseapp.com` },
    pem,
    issuer,
  }
}

/** Sliding window per IP, in the isolate's memory: best effort (each
 *  isolate counts on its own), and no KV write per request. */
export class RateLimiter {
  private hits = new Map<string, number[]>()
  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    private readonly now: () => number,
  ) {}
  allow(ip: string): boolean {
    const t = this.now()
    if (this.hits.size > 10_000) this.hits.clear()
    const recent = (this.hits.get(ip) ?? []).filter((h) => t - h < this.windowMs)
    const ok = recent.length < this.max
    if (ok) recent.push(t)
    this.hits.set(ip, recent)
    return ok
  }
}

interface Instance {
  id: string
  origin: string
}

async function lookup(kv: KV, id: string): Promise<Instance | null> {
  const raw = await kv.get(`id:${id}`)
  if (raw === null) return null
  try {
    const o = JSON.parse(raw) as { origin?: unknown }
    const origin = typeof o.origin === 'string' ? normalizeOrigin(o.origin) : null
    return origin ? { id, origin } : null
  } catch {
    return null
  }
}

/** One id per origin. Known origins cost one read and no write (instances
 *  re-register on every boot). Two first registrations racing may mint two
 *  ids for one origin: both point at that origin, so both are harmless. */
async function register(kv: KV, origin: string, now: number): Promise<string> {
  const known = await kv.get(`origin:${origin}`)
  if (known !== null && INSTANCE_ID.test(known) && (await lookup(kv, known))?.origin === origin) return known
  const id = randomId(16)
  await kv.put(`id:${id}`, JSON.stringify({ origin, registeredAt: now }))
  await kv.put(`origin:${origin}`, id)
  return id
}

const BODY_LIMIT = 16 * 1024

const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...headers } })

const text = (body: string, status: number): Response => new Response(body, { status, headers: { 'content-type': 'text/plain; charset=utf-8' } })

async function readJson(req: Request): Promise<Record<string, unknown> | Response> {
  const raw = await req.text()
  if (raw.length > BODY_LIMIT) return json({ error: 'body too large' }, 413)
  try {
    const o: unknown = raw === '' ? {} : JSON.parse(raw)
    return typeof o === 'object' && o !== null && !Array.isArray(o) ? (o as Record<string, unknown>) : {}
  } catch {
    return json({ error: 'body is not JSON' }, 400)
  }
}

export interface BrokerDeps {
  /** Google's keys (tests answer with their own) */
  fetchImpl?: typeof fetch
  /** Firebase's auth handler (/__/auth/*) is passed through with this fetch */
  proxyFetch?: typeof fetch
  now?: () => number
}

export interface Broker {
  fetch(req: Request, env: Env): Promise<Response>
}

/** A broker with its own caches and limits (the Worker keeps one per isolate). */
export function createBroker(deps: BrokerDeps = {}): Broker {
  const now = deps.now ?? Date.now
  const google = new GoogleKeys(deps.fetchImpl ?? ((input, init) => fetch(input, init)), now)
  const registerLimiter = new RateLimiter(20, 60_000, now)
  const exchangeLimiter = new RateLimiter(10, 60_000, now)
  const proxyFetch = deps.proxyFetch ?? ((input, init) => fetch(input, init))
  let signing: { pem: string; key: Promise<SigningKey> } | null = null
  const keyOf = (pem: string): Promise<SigningKey> => {
    if (signing?.pem !== pem) signing = { pem, key: importSigningKey(pem) }
    return signing.key
  }

  return {
    async fetch(req: Request, env: Env): Promise<Response> {
      const url = new URL(req.url)
      const route = `${req.method} ${url.pathname}`
      if (route === 'GET /healthz') return json({ ok: true })
      const firebasePath = req.method === 'GET' && FIREBASE_PATH.test(url.pathname)
      if (!firebasePath && !['GET /jwks', 'POST /register', 'GET /login', 'POST /login/exchange'].includes(route)) return json({ error: 'not found' }, 404)
      const cfg = brokerConfig(env)
      if (typeof cfg === 'string') return json({ error: cfg }, 500)
      const ip = req.headers.get('cf-connecting-ip') ?? 'unknown'

      // Firebase's auth handler on this domain — what lets Google sign in by
      // redirect here (third-party storage never involved)
      if (firebasePath) {
        let res: Response
        try {
          res = await proxyFetch(`https://${cfg.firebase.projectId}.firebaseapp.com${url.pathname}${url.search}`, { redirect: 'manual' })
        } catch {
          return text('Google sign-in is unreachable — try again.', 502)
        }
        const headers = new Headers()
        for (const h of PASSED_HEADERS) {
          const v = res.headers.get(h)
          if (v) headers.set(h, v)
        }
        return new Response(await res.arrayBuffer(), { status: res.status, headers })
      }

      if (route === 'GET /jwks') {
        return json({ keys: [(await keyOf(cfg.pem)).jwk] }, 200, { 'cache-control': 'public, max-age=300' })
      }

      if (route === 'POST /register') {
        if (!registerLimiter.allow(ip)) return json({ error: 'too many registrations — wait a minute' }, 429)
        const b = await readJson(req)
        if (b instanceof Response) return b
        const origin = typeof b.url === 'string' ? normalizeOrigin(b.url) : null
        if (!origin) return json({ error: 'url must be an https origin' }, 400)
        return json({ instanceId: await register(env.INSTANCES, origin, now()) })
      }

      if (route === 'GET /login') {
        const id = url.searchParams.get('instance')
        const state = url.searchParams.get('state')
        const instance = id !== null && INSTANCE_ID.test(id) ? await lookup(env.INSTANCES, id) : null
        if (!instance) return text('Unknown Silos — open sign-in from your Silos again.', 400)
        if (state === null || !STATE.test(state)) return text('Malformed sign-in — open it from your Silos again.', 400)
        // what the instance's page picked; an address that isn't one is
        // dropped (the page then offers both ways)
        const pick = readSignInPick(Object.fromEntries(url.searchParams)) ?? {}
        const redirect = cfg.firebase.authDomain === new URL(cfg.issuer ?? url.origin).host
        const nonce = randomId(16)
        return new Response(loginPage({ firebase: cfg.firebase, instance: instance.id, state, target: instance.origin, ...pick, redirect }, nonce), {
          status: 200,
          headers: {
            'content-type': 'text/html; charset=utf-8',
            'content-security-policy': `default-src 'self'; script-src 'nonce-${nonce}' https://www.gstatic.com https://apis.google.com; connect-src 'self' https:; frame-src https:; img-src 'self' data: https:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
            'referrer-policy': 'no-referrer',
            'cache-control': 'no-store',
          },
        })
      }

      // POST /login/exchange
      if (!exchangeLimiter.allow(ip)) return json({ error: 'too many sign-in attempts — wait a minute' }, 429)
      const b = await readJson(req)
      if (b instanceof Response) return b
      // the target is the REGISTERED origin of a known id: nothing in the
      // request names where the browser goes
      const instance = typeof b.instance === 'string' && INSTANCE_ID.test(b.instance) ? await lookup(env.INSTANCES, b.instance) : null
      if (!instance) return json({ error: 'unknown Silos' }, 400)
      if (typeof b.state !== 'string' || !STATE.test(b.state)) return json({ error: 'malformed sign-in' }, 400)
      if (typeof b.idToken !== 'string' || b.idToken === '') return json({ error: 'missing idToken' }, 400)
      let who
      try {
        who = await verifyFirebaseIdToken(b.idToken, cfg.firebase.projectId, google, now)
      } catch (err) {
        return json({ error: err instanceof Error ? err.message : 'invalid Google credential' }, 401)
      }
      const iat = Math.floor(now() / 1000)
      const pass = await signJwt(
        {
          iss: cfg.issuer ?? url.origin,
          aud: instance.id,
          sub: who.uid,
          email: who.email,
          email_verified: true,
          ...(who.name ? { name: who.name } : {}),
          ...(who.picture ? { picture: who.picture } : {}),
          nonce: b.state,
          iat,
          exp: iat + PASS_TTL_S,
        },
        await keyOf(cfg.pem),
      )
      const q = new URLSearchParams({ pass, state: b.state })
      return json({ redirect: `${instance.origin}/api/auth/silos-id/callback?${q.toString()}` })
    },
  }
}
