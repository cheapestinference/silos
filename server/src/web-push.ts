// web-push.ts — the doorbell's first adapter: Web Push.
// node:crypto only, no SDK (house precedent: silos-id.ts verifies RS256
// the same way):
//   VAPID (RFC 8292)   an ES256 JWT per request, signed with a P-256 key
//                      generated ONCE and kept in <dataDir>/push/vapid.json (0600)
//   aes128gcm (RFC 8291 over RFC 8188)  the payload is encrypted end to end
//                      for the browser that subscribed; the push service
//                      (FCM, Apple, Mozilla) sees timing and size, not content
// Subscriptions live in <dataDir>/push-subscriptions.json (0600), one per
// device, with a label and «last accepted at». A 404/410 from the push
// service means the subscription is gone: it is pruned. Delivery is best
// effort — Silos learns «accepted» (2xx), never «displayed».
//
// What a ring carries is decided elsewhere (doorbell.ts): counts and kinds
// only. This file encrypts whatever it is handed and never logs it.
import {
  createECDH,
  createHash,
  createPrivateKey,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  randomUUID,
  sign,
  createCipheriv,
  type KeyObject,
} from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { atomicWriteJson, backupCorruptJson } from './json-store.js'
import type { Doorbell, DoorbellPayload } from './doorbell.js'

export const b64url = (buf: Buffer | Uint8Array): string => Buffer.from(buf).toString('base64url')
export const fromB64url = (s: string): Buffer => Buffer.from(s, 'base64url')

// ── VAPID keys ─────────────────────────────────────────────────────────────

export interface VapidKeys {
  publicKey: string // base64url, uncompressed P-256 point (65 bytes) — the page's applicationServerKey
  privateJwk: { kty: 'EC'; crv: 'P-256'; x: string; y: string; d: string }
}

export function generateVapidKeys(): VapidKeys {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const jwk = privateKey.export({ format: 'jwk' }) as { x: string; y: string; d: string }
  const pub = Buffer.concat([Buffer.from([4]), fromB64url(jwk.x), fromB64url(jwk.y)])
  return { publicKey: b64url(pub), privateJwk: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, d: jwk.d } }
}

// Read the instance's keys, generating them on first use. A file that can't
// be read is kept aside (.corrupt-…) and replaced: every subscription made
// with the old key then stops working, which Settings says (no device
// delivers) — never a silent crash.
export function loadOrCreateVapidKeys(dataDir: string): VapidKeys {
  const file = join(dataDir, 'push', 'vapid.json')
  if (existsSync(file)) {
    const text = readFileSync(file, 'utf8')
    try {
      const raw = JSON.parse(text) as VapidKeys
      if (typeof raw.publicKey === 'string' && raw.privateJwk && typeof raw.privateJwk.d === 'string') return raw
      throw new Error('shape')
    } catch {
      backupCorruptJson(file, text, 'push', { mode: 0o600 })
    }
  }
  const keys = generateVapidKeys()
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  atomicWriteJson(file, keys, { mode: 0o600 })
  chmodSync(file, 0o600)
  return keys
}

// The `Authorization` header for one push service (RFC 8292 §3): the JWT's
// audience is the endpoint's origin; 12 h expiry (the spec's ceiling is 24).
export function vapidAuthorization(endpoint: string, keys: VapidKeys, subject: string, nowMs: number): string {
  const header = b64url(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })))
  const claims = b64url(Buffer.from(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(nowMs / 1000) + 12 * 3600, sub: subject })))
  const key: KeyObject = createPrivateKey({ key: keys.privateJwk, format: 'jwk' })
  const sig = sign('sha256', Buffer.from(`${header}.${claims}`), { key, dsaEncoding: 'ieee-p1363' })
  return `vapid t=${header}.${claims}.${b64url(sig)}, k=${keys.publicKey}`
}

// ── aes128gcm (RFC 8291) ───────────────────────────────────────────────────

export interface PushKeys {
  p256dh: string
  auth: string
} // base64url, from PushSubscription.toJSON()

// One record, as RFC 8291 §4 lays it out:
//   salt(16) · rs(4, BE) · idlen(1)=65 · as_public(65) · AES-128-GCM(plaintext · 0x02)
// `salt`/`asKeys` are injectable only so a test can pin the RFC's vector.
export function encryptPayload(plaintext: Buffer, ua: PushKeys, opts?: { salt?: Buffer; asPrivate?: Buffer }): Buffer {
  const uaPublic = fromB64url(ua.p256dh)
  const authSecret = fromB64url(ua.auth)
  const ecdh = createECDH('prime256v1')
  if (opts?.asPrivate) ecdh.setPrivateKey(opts.asPrivate)
  else ecdh.generateKeys()
  const asPublic = ecdh.getPublicKey()
  const shared = ecdh.computeSecret(uaPublic)
  const salt = opts?.salt ?? randomBytes(16)
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic])
  const ikm = Buffer.from(hkdfSync('sha256', shared, authSecret, keyInfo, 32))
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16))
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12))
  const cipher = createCipheriv('aes-128-gcm', cek, nonce)
  const body = Buffer.concat([cipher.update(Buffer.concat([plaintext, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()])
  const rs = Buffer.alloc(4)
  rs.writeUInt32BE(4096)
  return Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic, body])
}

// ── devices ────────────────────────────────────────────────────────────────

export interface PushDevice {
  id: string
  endpoint: string
  keys: PushKeys
  label: string // plain words, from the page that subscribed («iPhone · Safari»)
  origin: string // the page's origin — the VAPID subject when it is https
  createdAt: string
  lastAcceptedAt?: string // the push service took the last message (2xx)
  lastError?: { at: string; status: number }
}

const P256DH_BYTES = 65
const AUTH_BYTES = 16

// what a page may hand in: an https endpoint and the two keys at their real sizes
export function validSubscription(v: unknown): { endpoint: string; keys: PushKeys } | null {
  if (typeof v !== 'object' || v === null) return null
  const s = v as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } }
  if (typeof s.endpoint !== 'string' || s.endpoint.length > 2048) return null
  let url: URL
  try {
    url = new URL(s.endpoint)
  } catch {
    return null
  }
  if (url.protocol !== 'https:') return null
  const p = s.keys?.p256dh
  const a = s.keys?.auth
  if (typeof p !== 'string' || typeof a !== 'string' || !/^[A-Za-z0-9_-]+=*$/.test(p) || !/^[A-Za-z0-9_-]+=*$/.test(a)) return null
  const pb = fromB64url(p)
  if (pb.length !== P256DH_BYTES || pb[0] !== 4 || fromB64url(a).length !== AUTH_BYTES) return null
  return { endpoint: s.endpoint, keys: { p256dh: p.replace(/=+$/, ''), auth: a.replace(/=+$/, '') } }
}

export class PushSubscriptionsStore {
  private devices: PushDevice[] = []
  private file: string

  constructor(dataDir: string) {
    this.file = join(dataDir, 'push-subscriptions.json')
  }

  load(): void {
    if (!existsSync(this.file)) return
    const text = readFileSync(this.file, 'utf8')
    try {
      const raw = JSON.parse(text) as { devices?: unknown }
      this.devices = (Array.isArray(raw.devices) ? raw.devices : []).filter(
        (d): d is PushDevice => typeof d === 'object' && d !== null && typeof (d as PushDevice).id === 'string' && validSubscription(d) !== null,
      )
    } catch {
      backupCorruptJson(this.file, text, 'push-subscriptions', { mode: 0o600 })
      this.devices = []
    }
  }

  list(): PushDevice[] {
    return this.devices.map((d) => ({ ...d }))
  }

  // the same endpoint subscribing again is the same device (a refreshed
  // label and keys, its history kept)
  add(sub: { endpoint: string; keys: PushKeys }, label: string, origin: string, now: Date): PushDevice {
    const known = this.devices.find((d) => d.endpoint === sub.endpoint)
    if (known) {
      known.keys = sub.keys
      known.label = label
      known.origin = origin
      this.save()
      return { ...known }
    }
    const d: PushDevice = { id: randomUUID().slice(0, 8), endpoint: sub.endpoint, keys: sub.keys, label, origin, createdAt: now.toISOString() }
    this.devices.push(d)
    this.save()
    return { ...d }
  }

  remove(id: string): boolean {
    const before = this.devices.length
    this.devices = this.devices.filter((d) => d.id !== id)
    if (this.devices.length === before) return false
    this.save()
    return true
  }

  note(id: string, patch: Pick<PushDevice, 'lastAcceptedAt'> | Pick<PushDevice, 'lastError'>): void {
    const d = this.devices.find((x) => x.id === id)
    if (!d) return
    if ('lastAcceptedAt' in patch) {
      d.lastAcceptedAt = patch.lastAcceptedAt
      delete d.lastError
    }
    if ('lastError' in patch) d.lastError = patch.lastError
    this.save()
  }

  private save(): void {
    mkdirSync(dirname(this.file), { recursive: true })
    atomicWriteJson(this.file, { devices: this.devices }, { mode: 0o600 })
    chmodSync(this.file, 0o600)
  }
}

// ── the adapter ────────────────────────────────────────────────────────────

// The pipe, injectable: tests hand in a fake (a real push can't run in CI).
export type PushTransport = (endpoint: string, init: { headers: Record<string, string>; body: Buffer }) => Promise<{ status: number }>

export const fetchTransport: PushTransport = async (endpoint, init) => {
  const res = await fetch(endpoint, { method: 'POST', headers: init.headers, body: new Uint8Array(init.body), signal: AbortSignal.timeout(15_000) })
  return { status: res.status }
}

// a stable short fingerprint of an endpoint, for logs that must not carry it
export const endpointTag = (endpoint: string): string => createHash('sha256').update(endpoint).digest('hex').slice(0, 8)

export interface DeliveryResult {
  deviceId: string
  status: number | 'error'
}

export class WebPushDoorbell implements Doorbell {
  constructor(
    private opts: {
      keys: VapidKeys
      store: PushSubscriptionsStore
      transport?: PushTransport
      now?: () => number
    },
  ) {}

  get publicKey(): string {
    return this.opts.keys.publicKey
  }

  async ring(payload: DoorbellPayload): Promise<DeliveryResult[]> {
    return this.deliver(this.opts.store.list(), payload)
  }

  // one device only — Settings' «Send a test»
  async ringDevice(id: string, payload: DoorbellPayload): Promise<DeliveryResult | null> {
    const d = this.opts.store.list().find((x) => x.id === id)
    return d ? ((await this.deliver([d], payload))[0] ?? null) : null
  }

  private async deliver(devices: readonly PushDevice[], payload: DoorbellPayload): Promise<DeliveryResult[]> {
    const now = this.opts.now ?? Date.now
    const transport = this.opts.transport ?? fetchTransport
    const plaintext = Buffer.from(JSON.stringify(payload))
    return Promise.all(
      devices.map(async (d): Promise<DeliveryResult> => {
        const subject = d.origin.startsWith('https://') ? d.origin : 'mailto:push@silos.invalid'
        try {
          const res = await transport(d.endpoint, {
            headers: {
              Authorization: vapidAuthorization(d.endpoint, this.opts.keys, subject, now()),
              'Content-Encoding': 'aes128gcm',
              'Content-Type': 'application/octet-stream',
              TTL: String(payload.ttl ?? 6 * 3600),
              Urgency: payload.urgency ?? 'normal',
            },
            body: encryptPayload(plaintext, d.keys),
          })
          if (res.status >= 200 && res.status < 300) {
            this.opts.store.note(d.id, { lastAcceptedAt: new Date(now()).toISOString() })
          } else if (res.status === 404 || res.status === 410) {
            // the browser dropped it (unsubscribed, reinstalled, expired)
            this.opts.store.remove(d.id)
            console.warn(`push: device ${d.id} (${endpointTag(d.endpoint)}) is gone (${res.status}) — removed`)
          } else {
            this.opts.store.note(d.id, { lastError: { at: new Date(now()).toISOString(), status: res.status } })
            console.warn(`push: device ${d.id} (${endpointTag(d.endpoint)}) refused with ${res.status}`)
          }
          return { deviceId: d.id, status: res.status }
        } catch (err) {
          this.opts.store.note(d.id, { lastError: { at: new Date(now()).toISOString(), status: 0 } })
          console.warn(`push: device ${d.id} (${endpointTag(d.endpoint)}) unreachable —`, err instanceof Error ? err.message : err)
          return { deviceId: d.id, status: 'error' }
        }
      }),
    )
  }
}
