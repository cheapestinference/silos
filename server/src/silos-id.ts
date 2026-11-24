// Silos ID — one Google login for ANY Silos instance on ANY domain.
//
// Firebase only signs in on AUTHORIZED domains (no wildcards), so an
// instance on a fresh Railway domain cannot run the popup itself. The
// broker (silos-id/: a Cloudflare Worker, the official one at
// https://auth.silosplatform.com) is the one authorized domain: it runs Google
// (redirect or popup) or an email link — the way the owner picked here —,
// verifies Firebase's ID token, and hands the browser back to the instance
// with a PASS — a short RS256 JWT the broker signs with its own key:
//   {iss: broker origin, aud: instanceId, sub: firebase uid, email,
//    email_verified, nonce: the instance's state, iat, exp: +120 s}
// The instance (client mode — SILOS_ID_URL set) verifies the pass against the broker's /jwks and mints its usual 7-day
// session (session-tokens.ts). The broker never decides who gets in: the
// instance's own allowed set (SILOS_OWNER_EMAIL) does.
//
// It is the ONE remote sign-in: an instance never runs a Firebase project of
// its own. This module is the instance side: registration, the single-use
// state bound to the browser, the pass's verification (plain node:crypto,
// no SDK) and the login routes' rate limit. PASS_TTL_S, INSTANCE_ID, STATE and the origin rule are
// the wire contract with silos-id/src/broker.ts (its end-to-end test pins
// the two together).
import { createHmac, createPublicKey, createVerify, randomBytes, timingSafeEqual, type KeyObject } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteJson } from './json-store.js'

export const PASS_TTL_S = 120
const SKEW_S = 30
/** the shapes both sides accept for an instance id and a state */
export const INSTANCE_ID = /^[A-Za-z0-9_-]{16,64}$/
/** How the owner chose to sign in, on the instance's own page: Google, or
 *  an email link to that address. The broker carries it out with no
 *  second choice. */
export interface SignInPick {
  method?: 'google' | 'email'
  email?: string
}
/** An address that can be sent a link — plain, short, nothing markup could
 *  use (it is echoed on the broker's page) */
export const SIGN_IN_EMAIL = /^[^\s@<>"'()&;\\]{1,64}@[^\s@<>"'()&;\\]{1,189}\.[^\s@<>"'()&;\\]{2,}$/
/** a pick read from a query: what can't be read is dropped (null = an email
 *  method whose address isn't one — the caller says so) */
export function readSignInPick(q: Record<string, unknown>): SignInPick | null {
  if (q.method === 'google') return { method: 'google' }
  if (q.method !== 'email') return {}
  const email = typeof q.email === 'string' ? q.email.trim() : ''
  return email.length <= 254 && SIGN_IN_EMAIL.test(email) ? { method: 'email', email } : null
}
export function signInPickParams(pick: SignInPick): Record<string, string> {
  return { ...(pick.method ? { method: pick.method } : {}), ...(pick.method === 'email' && pick.email ? { email: pick.email } : {}) }
}

export const STATE = /^[A-Za-z0-9_-]{16,128}$/

// ——— origins ———

const LOOPBACK = /^(127\.\d+\.\d+\.\d+|localhost|\[::1\])$/i

/** A public origin (scheme://host[:port]) or null. https only — plain http
 *  only for a loopback host (a local broker/instance pair). The broker
 *  applies the same rule to what it registers. */
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

/** This server's public origin: SILOS_PUBLIC_URL, else Railway's domain. */
export function publicOriginFromEnv(env: NodeJS.ProcessEnv): string | null {
  const explicit = env.SILOS_PUBLIC_URL?.trim()
  if (explicit) return normalizeOrigin(explicit)
  const railway = env.RAILWAY_PUBLIC_DOMAIN?.trim()
  if (railway) return normalizeOrigin(`https://${railway}`)
  return null
}

// ——— RS256 JWT ———

interface JwkKey {
  kid?: string
  kty?: string
  n?: string
  e?: string
}

/** The broker's public keys (its /jwks), cached for the TTL the response
 *  declares (Cache-Control max-age; 5 min if absent). An unknown kid with a
 *  still-valid cache forces ONE refetch (a key rotated mid-TTL) before giving
 *  up. The fetch is injectable: tests never touch the network. */
export class JwksCache {
  private keys = new Map<string, KeyObject>()
  private expiresAt = 0
  private readonly url: string
  private readonly fetchImpl: typeof fetch
  private readonly now: () => number

  constructor(opts: { url: string; fetchImpl?: typeof fetch; now?: () => number }) {
    this.url = opts.url
    this.fetchImpl = opts.fetchImpl ?? fetch
    this.now = opts.now ?? Date.now
  }

  private async refresh(): Promise<void> {
    const res = await this.fetchImpl(this.url)
    if (!res.ok) throw new Error(`could not fetch the signing keys (HTTP ${res.status})`)
    const body = (await res.json()) as { keys?: JwkKey[] }
    if (!Array.isArray(body.keys)) throw new Error('the signing keys are not in JWKS format')
    this.keys.clear()
    for (const jwk of body.keys) {
      if (typeof jwk.kid !== 'string' || jwk.kty !== 'RSA') continue
      try {
        this.keys.set(jwk.kid, createPublicKey({ key: jwk as never, format: 'jwk' }))
      } catch {
        // a malformed key must not invalidate the rest of the set
      }
    }
    const m = /max-age=(\d+)/.exec(res.headers.get('cache-control') ?? '')
    this.expiresAt = this.now() + (m ? Number(m[1]) * 1000 : 5 * 60_000)
  }

  async getKey(kid: string): Promise<KeyObject | null> {
    if (this.now() >= this.expiresAt || this.keys.size === 0) await this.refresh()
    if (!this.keys.has(kid)) await this.refresh()
    return this.keys.get(kid) ?? null
  }
}

/** Signature only (alg, kid, RSA-SHA256 against the key `kid` names); the
 *  claims are the caller's. */
export async function verifyJwtSignature(jwt: string, keyOf: (kid: string) => Promise<KeyObject | null>): Promise<Record<string, unknown>> {
  const parts = jwt.split('.')
  if (parts.length !== 3) throw new Error('malformed pass')
  const [h, p, s] = parts as [string, string, string]
  let header: Record<string, unknown>, payload: Record<string, unknown>
  try {
    header = JSON.parse(Buffer.from(h, 'base64url').toString('utf8')) as Record<string, unknown>
    payload = JSON.parse(Buffer.from(p, 'base64url').toString('utf8')) as Record<string, unknown>
  } catch {
    throw new Error('malformed pass')
  }
  if (typeof header !== 'object' || header === null || typeof payload !== 'object' || payload === null) throw new Error('malformed pass')
  if (header.alg !== 'RS256') throw new Error('unsupported pass algorithm')
  if (typeof header.kid !== 'string') throw new Error('pass has no kid')
  const key = await keyOf(header.kid)
  if (!key) throw new Error('unknown signing key')
  if (!createVerify('RSA-SHA256').update(`${h}.${p}`).verify(key, Buffer.from(s, 'base64url'))) throw new Error('invalid pass signature')
  return payload
}

// ——— the instance side ———

export interface SilosIdSettings {
  /** the broker's origin — also the pass's expected iss */
  brokerUrl: string
  /** this instance's public origin, the one registered with the broker */
  publicOrigin: string
  /** who may sign in (case-insensitive) */
  ownerEmails: string[]
}

/** Client mode from the settings (the environment merged with server.env —
 *  server-env.ts). null = off: SILOS_ID_URL unset. A misconfiguration is
 *  `{ off: why }` — warned at boot, login stays off. */
export function silosIdSettingsFromEnv(env: NodeJS.ProcessEnv): SilosIdSettings | { off: string } | null {
  const raw = env.SILOS_ID_URL?.trim()
  if (!raw) return null
  const brokerUrl = normalizeOrigin(raw)
  if (!brokerUrl) return { off: `SILOS_ID_URL is not an https origin (${raw})` }
  const publicOrigin = publicOriginFromEnv(env)
  if (!publicOrigin) return { off: 'no public URL to register — set SILOS_PUBLIC_URL (or run on Railway with a public domain)' }
  const ownerEmails = (env.SILOS_OWNER_EMAIL ?? '')
    .split(',')
    .map((e) => e.trim())
    .filter((e) => e.includes('@'))
  if (ownerEmails.length === 0) return { off: 'SILOS_OWNER_EMAIL is not set — nobody could sign in' }
  return { brokerUrl, publicOrigin, ownerEmails }
}

export interface SilosIdIdentity {
  email: string
  name: string | null
  picture: string | null
}

interface Pending {
  bind: string
  expiresAt: number
}

const STATE_TTL_MS = 10 * 60_000
const MAX_PENDING = 500

export class SilosIdClient {
  readonly brokerUrl: string
  readonly publicOrigin: string
  readonly ownerEmails: string[]
  private readonly file: string | null
  private readonly fetchImpl: typeof fetch
  private readonly now: () => number
  private readonly certs: JwksCache
  private instanceId: string | null = null
  /** the reporting key the broker gave this instance at its registration —
   *  only it can sign this instance's usage (instance-usage.ts) */
  private key: string | null = null
  private registering: Promise<string> | null = null
  private pending = new Map<string, Pending>()

  constructor(settings: SilosIdSettings, opts?: { dataDir?: string; fetchImpl?: typeof fetch; now?: () => number }) {
    this.brokerUrl = settings.brokerUrl
    this.publicOrigin = settings.publicOrigin
    this.ownerEmails = settings.ownerEmails
    this.file = opts?.dataDir ? join(opts.dataDir, 'silos-id.json') : null
    this.fetchImpl = opts?.fetchImpl ?? fetch
    this.now = opts?.now ?? Date.now
    this.certs = new JwksCache({ fetchImpl: this.fetchImpl, now: this.now, url: `${this.brokerUrl}/jwks` })
    const stored = this.readStored()
    this.instanceId = stored?.instanceId ?? null
    this.key = stored?.key ?? null
  }

  /** the persisted id (and key), only when registered for THIS broker and origin */
  private readStored(): { instanceId: string; key: string | null } | null {
    if (this.file === null || !existsSync(this.file)) return null
    try {
      const o = JSON.parse(readFileSync(this.file, 'utf8')) as Record<string, unknown>
      if (o.broker === this.brokerUrl && o.origin === this.publicOrigin && typeof o.instanceId === 'string' && INSTANCE_ID.test(o.instanceId)) {
        return { instanceId: o.instanceId, key: typeof o.key === 'string' && o.key !== '' ? o.key : null }
      }
    } catch {
      /* re-register */
    }
    return null
  }

  /** The instance id: persisted, else registered now (once at a time).
   *  `force` re-registers anyway (the boot: registration is idempotent, so
   *  a broker that lost its registry learns this origin again). */
  async ensureRegistered(force = false): Promise<string> {
    if (this.instanceId && !force) return this.instanceId
    this.registering ??= (async () => {
      const res = await this.fetchImpl(`${this.brokerUrl}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // reports: this instance keeps the reporting key if the broker has one to give
        body: JSON.stringify({ url: this.publicOrigin, reports: true }),
      })
      const body = (await res.json().catch(() => ({}))) as { instanceId?: unknown; key?: unknown; error?: unknown }
      if (!res.ok || typeof body.instanceId !== 'string' || !INSTANCE_ID.test(body.instanceId)) {
        throw new Error(`Silos ID refused the registration (${typeof body.error === 'string' ? body.error : `HTTP ${res.status}`})`)
      }
      // the broker hands the key out once; a later registration keeps ours
      // (a new id never inherits the key of the old one)
      if (typeof body.key === 'string' && body.key !== '') this.key = body.key
      else if (body.instanceId !== this.instanceId) this.key = null
      this.instanceId = body.instanceId
      if (this.file)
        atomicWriteJson(this.file, { broker: this.brokerUrl, origin: this.publicOrigin, instanceId: body.instanceId, ...(this.key ? { key: this.key } : {}) })
      return body.instanceId
    })().finally(() => {
      this.registering = null
    })
    return this.registering
  }

  private prune(): void {
    const t = this.now()
    for (const [s, p] of this.pending) if (p.expiresAt <= t) this.pending.delete(s)
    // a flood of starts never grows the map without bound: the oldest go first
    while (this.pending.size >= MAX_PENDING) {
      const first = this.pending.keys().next().value
      if (first === undefined) break
      this.pending.delete(first)
    }
  }

  /** Whether this instance can sign usage reports (it holds its key). */
  get canReport(): boolean {
    return this.instanceId !== null && this.key !== null
  }

  /** Hands finished days to the broker, signed with this instance's key
   *  (HMAC-SHA256 of the raw body — the broker's usageSignature). true =
   *  they landed. No key (an id registered before keys, whose key another
   *  registration took): false, nothing sent. */
  async reportUsage(report: { days: unknown[] }, version: string): Promise<boolean> {
    if (!this.instanceId || !this.key) return false
    const raw = JSON.stringify({ instance: this.instanceId, version, days: report.days })
    const res = await this.fetchImpl(`${this.brokerUrl}/usage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-silos-signature': usageSignature(this.key, raw) },
      body: raw,
    })
    return res.ok
  }

  /** A login attempt: a single-use state bound to this browser by `bind`
   *  (its cookie), and where to send the browser. */
  async start(pick: SignInPick = {}): Promise<{ location: string; state: string; bind: string }> {
    const instanceId = await this.ensureRegistered()
    this.prune()
    const state = randomBytes(24).toString('base64url')
    const bind = randomBytes(24).toString('base64url')
    this.pending.set(state, { bind, expiresAt: this.now() + STATE_TTL_MS })
    const q = new URLSearchParams({ instance: instanceId, state, ...signInPickParams(pick) })
    return { location: `${this.brokerUrl}/login?${q.toString()}`, state, bind }
  }

  /** The callback: the state is consumed FIRST (single use, whatever
   *  follows), then the browser binding, the pass's signature against the
   *  broker's keys, and its claims. Throws with the reason. The allowed set
   *  is the guard's (server.ts), not checked here. */
  async complete(pass: string, state: string, bind: string): Promise<SilosIdIdentity> {
    const p = this.pending.get(state)
    this.pending.delete(state)
    if (!p || p.expiresAt <= this.now()) throw new Error('this sign-in expired or was already used — start again')
    const a = Buffer.from(p.bind),
      b = Buffer.from(bind)
    if (a.length !== b.length || !timingSafeEqual(a, b)) throw new Error('this sign-in was started in another browser')
    const instanceId = this.instanceId
    if (!instanceId) throw new Error('this Silos is not registered with Silos ID')
    const c = await verifyJwtSignature(pass, (kid) => this.certs.getKey(kid))
    const nowSec = Math.floor(this.now() / 1000)
    if (c.iss !== this.brokerUrl) throw new Error('the pass was not issued by this Silos ID')
    if (c.aud !== instanceId) throw new Error('the pass is for another Silos')
    if (typeof c.exp !== 'number' || c.exp <= nowSec - SKEW_S) throw new Error('the pass expired')
    if (typeof c.iat !== 'number' || c.iat > nowSec + SKEW_S) throw new Error('the pass was issued in the future')
    if (c.nonce !== state) throw new Error('the pass belongs to another sign-in')
    if (typeof c.sub !== 'string' || c.sub === '') throw new Error('the pass has no subject')
    if (typeof c.email !== 'string' || c.email === '') throw new Error('the pass has no email')
    if (c.email_verified !== true) throw new Error("the Google account's email is not verified")
    return { email: c.email, name: typeof c.name === 'string' ? c.name : null, picture: typeof c.picture === 'string' ? c.picture : null }
  }
}

/** HMAC-SHA256 of `body` with `key`, hex — the broker checks the same
 *  (silos-id/src/broker.ts usageSignature). */
export function usageSignature(key: string, body: string): string {
  return createHmac('sha256', key).update(body).digest('hex')
}

/** a cookie's value from a Cookie header */
export function cookieOf(header: string | undefined, name: string): string | null {
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=')
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim()
  }
  return null
}

/** In-memory rate limit for the sign-in routes — pre-auth surface: no
 *  unthrottled verification oracle. Sliding window per IP. */
export class LoginRateLimiter {
  private hits = new Map<string, number[]>()
  constructor(
    private readonly max = 10,
    private readonly windowMs = 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  allow(ip: string): boolean {
    const t = this.now()
    const recent = (this.hits.get(ip) ?? []).filter((h) => t - h < this.windowMs)
    if (recent.length >= this.max) {
      this.hits.set(ip, recent)
      return false
    }
    recent.push(t)
    this.hits.set(ip, recent)
    return true
  }
}
