// RS256 with WebCrypto (RSASSA-PKCS1-v1_5, SHA-256): the broker's signing
// key and its passes, and the verification of Firebase ID tokens against
// Google's published keys. Nothing here needs node: it runs in a Worker and,
// unchanged, in Node's tests.

const ALG = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' } as const
const enc = new TextEncoder()

export function b64urlEncode(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function b64urlDecode(s: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new Error('not base64url')
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4))
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

const b64json = (o: unknown): string => b64urlEncode(enc.encode(JSON.stringify(o)))

export function randomId(bytes: number): string {
  return b64urlEncode(crypto.getRandomValues(new Uint8Array(bytes)))
}

// ——— the broker's signing key ———

export interface SigningKey {
  key: CryptoKey
  kid: string
  jwk: Record<string, unknown>
}

function pemBody(pem: string): Uint8Array<ArrayBuffer> {
  const m = /-----BEGIN PRIVATE KEY-----([\s\S]+?)-----END PRIVATE KEY-----/.exec(pem.replace(/\\n/g, '\n'))
  if (!m || !m[1]) throw new Error('SILOS_ID_PRIVATE_KEY is not a PKCS8 PEM (-----BEGIN PRIVATE KEY-----): make one with scripts/gen-key.mjs')
  const bin = atob(m[1].replace(/\s+/g, ''))
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/** The secret PEM → the signing key, its public JWK and a stable kid: the
 *  RFC 7638 thumbprint, so the same key always names itself the same. */
export async function importSigningKey(pem: string): Promise<SigningKey> {
  const extractable = await crypto.subtle.importKey('pkcs8', pemBody(pem), ALG, true, ['sign'])
  const full = (await crypto.subtle.exportKey('jwk', extractable)) as { n?: string; e?: string }
  if (typeof full.n !== 'string' || typeof full.e !== 'string') throw new Error('SILOS_ID_PRIVATE_KEY is not an RSA key')
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(JSON.stringify({ e: full.e, kty: 'RSA', n: full.n })))
  const kid = b64urlEncode(new Uint8Array(digest))
  // the key that signs is not extractable: nothing after this can read it back
  const key = await crypto.subtle.importKey('pkcs8', pemBody(pem), ALG, false, ['sign'])
  return { key, kid, jwk: { kty: 'RSA', n: full.n, e: full.e, kid, alg: 'RS256', use: 'sig' } }
}

export async function signJwt(payload: Record<string, unknown>, key: SigningKey): Promise<string> {
  const base = `${b64json({ alg: 'RS256', typ: 'JWT', kid: key.kid })}.${b64json(payload)}`
  const sig = await crypto.subtle.sign(ALG, key.key, enc.encode(base))
  return `${base}.${b64urlEncode(new Uint8Array(sig))}`
}

// ——— Firebase ID tokens ———

/** Google's keys for Firebase ID tokens (securetoken), as a JWKS. */
export const GOOGLE_JWKS_URL = 'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com'

/** Google's keys, kept in the isolate's memory for the TTL Google declares
 *  (Cache-Control max-age; 5 min without one). An unknown kid while the
 *  cache is fresh forces ONE refetch (a rotation mid-TTL). */
export class GoogleKeys {
  private keys = new Map<string, CryptoKey>()
  private expiresAt = 0
  constructor(
    private readonly fetchImpl: typeof fetch,
    private readonly now: () => number,
    private readonly url = GOOGLE_JWKS_URL,
  ) {}

  private async refresh(): Promise<void> {
    const res = await this.fetchImpl(this.url)
    if (!res.ok) throw new Error(`could not fetch Google's keys (HTTP ${res.status})`)
    const body = (await res.json()) as { keys?: Array<Record<string, unknown>> }
    if (!Array.isArray(body.keys)) throw new Error("Google's key response is not in JWKS format")
    const next = new Map<string, CryptoKey>()
    for (const jwk of body.keys) {
      if (typeof jwk.kid !== 'string' || jwk.kty !== 'RSA' || typeof jwk.n !== 'string' || typeof jwk.e !== 'string') continue
      try {
        next.set(jwk.kid, await crypto.subtle.importKey('jwk', { kty: 'RSA', n: jwk.n, e: jwk.e, alg: 'RS256', ext: true }, ALG, false, ['verify']))
      } catch {
        /* a malformed key must not invalidate the rest of the set */
      }
    }
    this.keys = next
    const m = /max-age=(\d+)/.exec(res.headers.get('cache-control') ?? '')
    this.expiresAt = this.now() + (m ? Number(m[1]) * 1000 : 5 * 60_000)
  }

  async get(kid: string): Promise<CryptoKey | null> {
    if (this.now() >= this.expiresAt || this.keys.size === 0) await this.refresh()
    if (!this.keys.has(kid)) await this.refresh()
    return this.keys.get(kid) ?? null
  }
}

export interface VerifiedIdentity {
  uid: string
  email: string
  name: string | null
  picture: string | null
}

function partJson(part: string): Record<string, unknown> {
  const o: unknown = JSON.parse(new TextDecoder().decode(b64urlDecode(part)))
  if (typeof o !== 'object' || o === null) throw new Error('not an object')
  return o as Record<string, unknown>
}

/** Firebase's documented manual verification (alg, kid, signature, exp,
 *  iat, aud, iss, sub) plus email_verified: the email IS the identity the
 *  instance compares, an unverified one is none. Throws with the reason. */
export async function verifyFirebaseIdToken(idToken: string, projectId: string, keys: GoogleKeys, now: () => number): Promise<VerifiedIdentity> {
  const parts = idToken.split('.')
  if (parts.length !== 3) throw new Error('malformed Firebase token')
  const [h, p, s] = parts as [string, string, string]
  let header: Record<string, unknown>, payload: Record<string, unknown>, sig: Uint8Array<ArrayBuffer>
  try {
    header = partJson(h)
    payload = partJson(p)
    sig = b64urlDecode(s)
  } catch {
    throw new Error('malformed Firebase token')
  }
  if (header.alg !== 'RS256') throw new Error('unsupported token algorithm')
  if (typeof header.kid !== 'string') throw new Error('Firebase token has no kid')
  const key = await keys.get(header.kid)
  if (!key) throw new Error('unknown signing key')
  if (!(await crypto.subtle.verify(ALG, key, sig, enc.encode(`${h}.${p}`)))) throw new Error('invalid token signature')

  const nowSec = Math.floor(now() / 1000)
  const SKEW = 30
  if (typeof payload.exp !== 'number' || payload.exp <= nowSec - SKEW) throw new Error('Firebase token expired')
  if (typeof payload.iat !== 'number' || payload.iat > nowSec + SKEW) throw new Error('Firebase token issued in the future')
  if (payload.aud !== projectId) throw new Error("token audience doesn't match the project")
  if (payload.iss !== `https://securetoken.google.com/${projectId}`) throw new Error('token issuer is not Firebase')
  if (typeof payload.sub !== 'string' || payload.sub === '') throw new Error('Firebase token has no subject')
  if (typeof payload.email !== 'string' || payload.email === '') throw new Error('Firebase token has no email')
  if (payload.email_verified !== true) throw new Error("the Google account's email is not verified")
  return {
    uid: payload.sub,
    email: payload.email,
    name: typeof payload.name === 'string' ? payload.name : null,
    picture: typeof payload.picture === 'string' ? payload.picture : null,
  }
}
