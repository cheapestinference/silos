// Silos ID broker: one Google login for ANY Silos instance on ANY domain.
//
// Firebase only signs in on AUTHORIZED domains (no wildcards), so an
// instance on a fresh domain cannot run the popup itself. The broker is the
// one authorized domain. Routes (nothing else is served):
//   POST /register {url, reports?}
//                               an instance's public origin → {instanceId,
//                               key?} (idempotent per origin, rate-limited;
//                               `key` only to the first registration that
//                               asks for it — reports: true — while the
//                               record has none: an instance that can't keep
//                               a key never spends it)
//   POST /usage                 an instance's finished days, signed with its
//                               key (x-silos-signature: HMAC-SHA256 hex of
//                               the raw body)
//   GET  /stats, POST /stats/data
//                               the usage page, for SILOS_ID_ADMIN_EMAILS
//                               only (Google sign-in on this domain)
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
// Usage, on the instance's own record (`id:<id>`): boots (each /register),
// passes issued (each /login/exchange) and, per UTC day for USAGE_DAYS days,
// the signed-in emails with their pass count; plus what the instance
// reports itself (POST /usage, server/src/instance-usage.ts): the UTC hours
// Silos was open, turns the owner started and turns Silos started. Only the
// instance holding the record's key can report for it; what an operator
// reports about their OWN instance can't be proven — /stats flags activity
// with no sign-in behind it. Best effort: KV is read then written, so two
// writes racing may lose one count. Read at /stats.
// The pass is a short RS256 JWT: {iss: the broker's origin, aud: the
// instance id, sub: the Firebase uid, email, email_verified, name?,
// picture?, nonce: the instance's state, iat, exp: +120 s}. The instance
// (server/src/silos-id.ts) verifies it against /jwks, checks the state it
// bound to the browser, and decides who gets in (SILOS_OWNER_EMAIL): the
// broker lets nobody in by itself and stores no account, only origins and
// their usage.
import { GoogleKeys, importSigningKey, randomId, signJwt, verifyFirebaseIdToken, type SigningKey } from './jwt.js'
import { loginPage, statsPage, type BrokerFirebase } from './page.js'

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
  /** Workers KV's listing (only /stats lists) */
  list?(opts: { prefix: string; cursor?: string }): Promise<{ keys: Array<{ name: string }>; list_complete: boolean; cursor?: string }>
}

export interface Env {
  /** KV: `origin:<origin>` → id, `id:<id>` → InstanceRecord */
  INSTANCES: KV
  /** Worker secret: the PKCS8 PEM that signs the passes (scripts/gen-key.mjs) */
  SILOS_ID_PRIVATE_KEY?: string
  SILOS_ID_FIREBASE_API_KEY?: string
  SILOS_ID_FIREBASE_PROJECT?: string
  SILOS_ID_FIREBASE_AUTH_DOMAIN?: string
  /** the broker's own origin, the passes' iss (else the request's origin) */
  SILOS_ID_PUBLIC_URL?: string
  /** who may open /stats: comma-separated emails (none = nobody) */
  SILOS_ID_ADMIN_EMAILS?: string
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

/** How many UTC days of per-day usage an instance record keeps. */
export const USAGE_DAYS = 90

export interface DayUsage {
  logins: number
  users: Record<string, number>
  /** reported by the instance (POST /usage) */
  hours?: number[]
  attended?: number
  unattended?: number
}
/** `id:<id>` in KV: the origin plus its usage (all usage fields optional —
 *  records written before usage existed carry none). */
export interface InstanceRecord {
  origin: string
  registeredAt: number
  boots?: number
  lastBootAt?: number
  logins?: number
  lastLoginAt?: number
  days?: Record<string, DayUsage>
  /** the instance's reporting key (HMAC) — never leaves the broker but to
   *  the registration that minted it */
  key?: string
  version?: string
  lastReportAt?: number
}

interface Instance {
  id: string
  origin: string
  record: InstanceRecord
}

async function lookup(kv: KV, id: string): Promise<Instance | null> {
  const raw = await kv.get(`id:${id}`)
  if (raw === null) return null
  try {
    const o = JSON.parse(raw) as Partial<InstanceRecord>
    const origin = typeof o.origin === 'string' ? normalizeOrigin(o.origin) : null
    return origin ? { id, origin, record: { ...o, origin, registeredAt: typeof o.registeredAt === 'number' ? o.registeredAt : 0 } } : null
  } catch {
    return null
  }
}

const utcDay = (t: number): string => new Date(t).toISOString().slice(0, 10)
const DAY_MS = 86_400_000
const oldestDay = (now: number): string => utcDay(now - (USAGE_DAYS - 1) * DAY_MS)

/** A boot: one more count on the instance's record. */
export function countBoot(r: InstanceRecord, now: number): InstanceRecord {
  return { ...r, boots: (r.boots ?? 0) + 1, lastBootAt: now }
}

/** A pass issued to `email`: counted overall and on today, days past
 *  USAGE_DAYS dropped. */
export function countLogin(r: InstanceRecord, email: string, now: number): InstanceRecord {
  const today = utcDay(now)
  const days = recentDays(r, now)
  const day = days[today] ?? { logins: 0, users: {} }
  const who = email.toLowerCase()
  days[today] = { ...day, logins: day.logins + 1, users: { ...day.users, [who]: (day.users[who] ?? 0) + 1 } }
  return { ...r, logins: (r.logins ?? 0) + 1, lastLoginAt: now, days }
}

function recentDays(r: InstanceRecord, now: number): Record<string, DayUsage> {
  const oldest = oldestDay(now)
  const days: Record<string, DayUsage> = {}
  for (const [d, u] of Object.entries(r.days ?? {})) if (d >= oldest) days[d] = u
  return days
}

/** turns a day may claim — a cap on what one report can add */
export const MAX_TURNS_PER_DAY = 5000
const DAY = /^\d{4}-\d{2}-\d{2}$/
const VERSION = /^[\w.+-]{1,64}$/
export interface ReportedDay {
  day: string
  hours: number[]
  attended: number
  unattended: number
}

/** A usage report read, or why not. Days: within USAGE_DAYS, not past
 *  today, each once, at most 31; hours distinct 0–23; turns 0–cap. */
export function readUsageReport(b: Record<string, unknown>, now: number): { version: string | null; days: ReportedDay[] } | string {
  if (!Array.isArray(b.days) || b.days.length === 0 || b.days.length > 31) return 'days must be 1 to 31 entries'
  const today = utcDay(now)
  const oldest = oldestDay(now)
  const seen = new Set<string>()
  const days: ReportedDay[] = []
  for (const raw of b.days as unknown[]) {
    const d = raw as Record<string, unknown>
    if (typeof d !== 'object' || d === null || typeof d.day !== 'string' || !DAY.test(d.day) || Number.isNaN(Date.parse(d.day)))
      return 'a day is not YYYY-MM-DD'
    if (d.day > today || d.day < oldest || seen.has(d.day)) return `day ${d.day} is out of range or repeated`
    seen.add(d.day)
    const hours = d.hours
    if (!Array.isArray(hours) || hours.some((h) => !Number.isInteger(h) || (h as number) < 0 || (h as number) > 23) || new Set(hours).size !== hours.length)
      return `day ${d.day}: hours must be distinct 0–23`
    const turns = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= MAX_TURNS_PER_DAY
    if (!turns(d.attended) || !turns(d.unattended)) return `day ${d.day}: turns must be 0–${MAX_TURNS_PER_DAY}`
    days.push({ day: d.day, hours: [...(hours as number[])].sort((x, y) => x - y), attended: d.attended, unattended: d.unattended })
  }
  const version = typeof b.version === 'string' && VERSION.test(b.version) ? b.version : null
  return { version, days }
}

/** A report on the record: each day's reported fields REPLACED (a resend
 *  is idempotent), the broker's own counts kept. */
export function applyUsageReport(r: InstanceRecord, rep: { version: string | null; days: ReportedDay[] }, now: number): InstanceRecord {
  const days = recentDays(r, now)
  for (const d of rep.days) {
    const was = days[d.day] ?? { logins: 0, users: {} }
    days[d.day] = { ...was, hours: d.hours, attended: d.attended, unattended: d.unattended }
  }
  return { ...r, days, lastReportAt: now, ...(rep.version ? { version: rep.version } : {}) }
}

const hex = (buf: ArrayBuffer): string => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')

/** HMAC-SHA256 of `body` with `key`, hex — the instance computes the same
 *  (server/src/silos-id.ts usageSignature). */
export async function usageSignature(key: string, body: string): Promise<string> {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return hex(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(body)))
}

/** constant-time compare of two hex strings */
function sameHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let x = 0
  for (let i = 0; i < a.length; i++) x |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return x === 0
}

/** One row of /stats per instance. `unverified`: it reported activity in the
 *  last 7 days but no pass was issued to it in the last 8 (a session lasts
 *  7) — the report alone can't be proven. */
export interface StatsRow {
  id: string
  origin: string
  version: string | null
  registeredAt: number
  boots: number
  lastBootAt: number | null
  logins: number
  lastLoginAt: number | null
  lastReportAt: number | null
  reporting: boolean
  /** per day, newest first, the last 30 days that have anything */
  days: Array<{ day: string; logins: number; users: Record<string, number>; hours: number[] | null; attended: number | null; unattended: number | null }>
  unverified: boolean
}

export function statsRow(id: string, r: InstanceRecord, now: number): StatsRow {
  const since = (n: number): string => utcDay(now - (n - 1) * DAY_MS)
  const days = Object.entries(r.days ?? {})
    .filter(([d]) => d >= since(30))
    .sort(([a], [b]) => b.localeCompare(a))
    .map(([day, u]) => ({
      day,
      logins: u.logins,
      users: u.users,
      hours: u.hours ?? null,
      attended: u.attended ?? null,
      unattended: u.unattended ?? null,
    }))
  const activeRecently = days.some((d) => d.day >= since(7) && ((d.hours?.length ?? 0) > 0 || (d.attended ?? 0) > 0))
  return {
    id,
    origin: r.origin,
    version: r.version ?? null,
    registeredAt: r.registeredAt,
    boots: r.boots ?? 0,
    lastBootAt: r.lastBootAt ?? null,
    logins: r.logins ?? 0,
    lastLoginAt: r.lastLoginAt ?? null,
    lastReportAt: r.lastReportAt ?? null,
    reporting: typeof r.key === 'string',
    days,
    unverified: activeRecently && (r.lastLoginAt === undefined || now - r.lastLoginAt > 8 * DAY_MS),
  }
}

/** Usage never stands between anyone and their sign-in or boot. */
async function save(kv: KV, id: string, r: InstanceRecord): Promise<void> {
  try {
    await kv.put(`id:${id}`, JSON.stringify(r))
  } catch {
    /* best effort */
  }
}

/** One id per origin; every call is a boot of that instance (instances
 *  register on every boot) and counts as one. Two first registrations racing
 *  may mint two ids for one origin: both point at that origin, so both are
 *  harmless. */
async function register(kv: KV, origin: string, now: number, wantsKey: boolean): Promise<{ instanceId: string; key?: string }> {
  const known = await kv.get(`origin:${origin}`)
  const instance = known !== null && INSTANCE_ID.test(known) ? await lookup(kv, known) : null
  if (instance?.origin === origin) {
    // the key goes once: to the first registration after the record had none
    const key = wantsKey && instance.record.key === undefined ? randomId(32) : undefined
    await save(kv, instance.id, countBoot({ ...instance.record, ...(key ? { key } : {}) }, now))
    return { instanceId: instance.id, ...(key ? { key } : {}) }
  }
  const id = randomId(16)
  const key = wantsKey ? randomId(32) : undefined
  await kv.put(`id:${id}`, JSON.stringify(countBoot({ origin, registeredAt: now, ...(key ? { key } : {}) }, now)))
  await kv.put(`origin:${origin}`, id)
  return { instanceId: id, ...(key ? { key } : {}) }
}

const BODY_LIMIT = 16 * 1024

/** the broker's pages: Firebase's scripts by nonce, nothing framed */
const pageHeaders = (nonce: string): Record<string, string> => ({
  'content-type': 'text/html; charset=utf-8',
  'content-security-policy': `default-src 'self'; script-src 'nonce-${nonce}' https://www.gstatic.com https://apis.google.com; connect-src 'self' https:; frame-src https:; img-src 'self' data: https:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
  'referrer-policy': 'no-referrer',
  'cache-control': 'no-store',
})

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
  const usageLimiter = new RateLimiter(30, 60_000, now)
  const statsLimiter = new RateLimiter(20, 60_000, now)
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
      if (
        !firebasePath &&
        !['GET /jwks', 'POST /register', 'GET /login', 'POST /login/exchange', 'POST /usage', 'GET /stats', 'POST /stats/data'].includes(route)
      )
        return json({ error: 'not found' }, 404)
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
        return json(await register(env.INSTANCES, origin, now(), b.reports === true))
      }

      if (route === 'POST /usage') {
        if (!usageLimiter.allow(ip)) return json({ error: 'too many reports — wait a minute' }, 429)
        const raw = await req.text()
        if (raw.length > BODY_LIMIT) return json({ error: 'body too large' }, 413)
        let b: Record<string, unknown>
        try {
          b = JSON.parse(raw) as Record<string, unknown>
        } catch {
          return json({ error: 'body is not JSON' }, 400)
        }
        if (typeof b !== 'object' || b === null) return json({ error: 'body is not JSON' }, 400)
        const instance = typeof b.instance === 'string' && INSTANCE_ID.test(b.instance) ? await lookup(env.INSTANCES, b.instance) : null
        // one answer for an unknown instance, one without a key and a bad
        // signature: nothing tells a prober which ids exist
        const sig = req.headers.get('x-silos-signature') ?? ''
        if (!instance || instance.record.key === undefined || !sameHex(sig, await usageSignature(instance.record.key, raw)))
          return json({ error: 'unsigned report' }, 401)
        const rep = readUsageReport(b, now())
        if (typeof rep === 'string') return json({ error: rep }, 400)
        await save(env.INSTANCES, instance.id, applyUsageReport(instance.record, rep, now()))
        return json({ ok: true })
      }

      if (route === 'GET /stats') {
        const nonce = randomId(16)
        const redirect = cfg.firebase.authDomain === new URL(cfg.issuer ?? url.origin).host
        return new Response(statsPage({ firebase: cfg.firebase, redirect }, nonce), { status: 200, headers: pageHeaders(nonce) })
      }

      if (route === 'POST /stats/data') {
        if (!statsLimiter.allow(ip)) return json({ error: 'too many requests — wait a minute' }, 429)
        const b = await readJson(req)
        if (b instanceof Response) return b
        if (typeof b.idToken !== 'string' || b.idToken === '') return json({ error: 'missing idToken' }, 400)
        let who
        try {
          who = await verifyFirebaseIdToken(b.idToken, cfg.firebase.projectId, google, now)
        } catch (err) {
          return json({ error: err instanceof Error ? err.message : 'invalid Google credential' }, 401)
        }
        const admins = (env.SILOS_ID_ADMIN_EMAILS ?? '')
          .split(',')
          .map((e) => e.trim().toLowerCase())
          .filter(Boolean)
        if (!admins.includes(who.email.toLowerCase())) return json({ error: `${who.email} may not see usage` }, 403)
        const kv = env.INSTANCES
        if (!kv.list) return json({ error: 'this KV cannot list' }, 500)
        const rows: StatsRow[] = []
        let cursor: string | undefined
        do {
          const page = await kv.list({ prefix: 'id:', ...(cursor ? { cursor } : {}) })
          for (const k of page.keys) {
            const inst = await lookup(kv, k.name.slice(3))
            if (inst) rows.push(statsRow(inst.id, inst.record, now()))
          }
          cursor = page.list_complete ? undefined : page.cursor
        } while (cursor)
        return json({ now: now(), rows }, 200, { 'cache-control': 'no-store' })
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
          headers: pageHeaders(nonce),
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
      await save(env.INSTANCES, instance.id, countLogin(instance.record, who.email, now()))
      const q = new URLSearchParams({ pass, state: b.state })
      return json({ redirect: `${instance.origin}/api/auth/silos-id/callback?${q.toString()}` })
    },
  }
}
