// The doorbell's Web Push adapter: aes128gcm (RFC 8291) decrypts with the
// browser's own keys, the VAPID JWT verifies with the instance's public key,
// devices persist 0600 and a gone one (404/410) is pruned. A real push can't
// run in CI — the transport is a fake that records what would be sent.
import { describe, expect, it, beforeEach } from 'vitest'
import { createDecipheriv, createECDH, createPublicKey, hkdfSync, randomBytes, verify } from 'node:crypto'
import { mkdirSync, mkdtempSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import {
  encryptPayload,
  generateVapidKeys,
  loadOrCreateVapidKeys,
  PushSubscriptionsStore,
  validSubscription,
  vapidAuthorization,
  WebPushDoorbell,
  type PushTransport,
} from '../src/web-push.js'
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

// a browser: its P-256 key and auth secret
function browser() {
  const ecdh = createECDH('prime256v1')
  ecdh.generateKeys()
  const auth = randomBytes(16)
  return { ecdh, auth, keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: auth.toString('base64url') } }
}

// RFC 8291 §3-4 from the receiving side
function decrypt(body: Buffer, ua: ReturnType<typeof browser>): string {
  const salt = body.subarray(0, 16)
  const idlen = body[20]!
  const asPublic = body.subarray(21, 21 + idlen)
  const ct = body.subarray(21 + idlen)
  const shared = ua.ecdh.computeSecret(asPublic)
  const ikm = Buffer.from(hkdfSync('sha256', shared, ua.auth, Buffer.concat([Buffer.from('WebPush: info\0'), ua.ecdh.getPublicKey(), asPublic]), 32))
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16))
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12))
  const d = createDecipheriv('aes-128-gcm', cek, nonce)
  d.setAuthTag(ct.subarray(ct.length - 16))
  const plain = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()])
  expect(plain[plain.length - 1]).toBe(2) // the last-record delimiter
  return plain.subarray(0, plain.length - 1).toString()
}

const sub = (b: ReturnType<typeof browser>, endpoint = 'https://fcm.googleapis.com/fcm/send/abc') => ({ endpoint, keys: b.keys })

describe('aes128gcm and VAPID', () => {
  it("the payload decrypts with the browser's keys, header laid out as RFC 8291 says", () => {
    const b = browser()
    const body = encryptPayload(Buffer.from('{"title":"Silos"}'), b.keys)
    expect(body.readUInt32BE(16)).toBe(4096)
    expect(body[20]).toBe(65)
    expect(decrypt(body, b)).toBe('{"title":"Silos"}')
  })

  it("the JWT is ES256 over the endpoint's origin, verifiable with the public key", () => {
    const keys = generateVapidKeys()
    const header = vapidAuthorization('https://web.push.apple.com/abc/def', keys, 'https://silos.example.com', Date.parse('2026-10-31T09:00:00Z'))
    const m = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(header)!
    expect(m[4]).toBe(keys.publicKey)
    expect(JSON.parse(Buffer.from(m[2]!, 'base64url').toString())).toEqual({
      aud: 'https://web.push.apple.com',
      exp: Date.parse('2026-10-31T21:00:00Z') / 1000,
      sub: 'https://silos.example.com',
    })
    const pub = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: keys.privateJwk.x, y: keys.privateJwk.y }, format: 'jwk' })
    expect(verify('sha256', Buffer.from(`${m[1]}.${m[2]}`), { key: pub, dsaEncoding: 'ieee-p1363' }, Buffer.from(m[3]!, 'base64url'))).toBe(true)
  })

  it('keys are generated once, kept 0600, and read back the same', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vapid-'))
    const a = loadOrCreateVapidKeys(dir)
    expect(statSync(join(dir, 'push', 'vapid.json')).mode & 0o777).toBe(0o600)
    expect(loadOrCreateVapidKeys(dir)).toEqual(a)
    expect(Buffer.from(a.publicKey, 'base64url')).toHaveLength(65)
  })
})

describe('devices', () => {
  it('validSubscription takes an https endpoint and keys at their real sizes only', () => {
    const b = browser()
    expect(validSubscription(sub(b))).toEqual(sub(b))
    expect(validSubscription(sub(b, 'http://push.example/x'))).toBeNull()
    expect(validSubscription({ endpoint: 'https://x', keys: { p256dh: 'AAAA', auth: b.keys.auth } })).toBeNull()
    expect(validSubscription({ endpoint: 'https://x', keys: { p256dh: b.keys.p256dh, auth: 'AAAA' } })).toBeNull()
    expect(validSubscription(null)).toBeNull()
  })

  it('the store persists 0600; the same endpoint again is the same device', () => {
    const dir = mkdtempSync(join(tmpdir(), 'push-subs-'))
    const s = new PushSubscriptionsStore(dir)
    const b = browser()
    const d = s.add(sub(b), 'iPhone · Safari', 'https://silos.example.com', new Date())
    expect(s.add(sub(b), 'iPhone · Safari (Home Screen)', 'https://silos.example.com', new Date()).id).toBe(d.id)
    expect(statSync(join(dir, 'push-subscriptions.json')).mode & 0o777).toBe(0o600)
    const again = new PushSubscriptionsStore(dir)
    again.load()
    expect(again.list()).toEqual([expect.objectContaining({ id: d.id, label: 'iPhone · Safari (Home Screen)' })])
    expect(again.remove(d.id)).toBe(true)
    expect(again.remove(d.id)).toBe(false)
  })
})

describe('WebPushDoorbell — the adapter over a fake transport', () => {
  let store: PushSubscriptionsStore, sent: Array<{ endpoint: string; headers: Record<string, string>; body: Buffer }>, status: Record<string, number>
  const transport: PushTransport = async (endpoint, init) => {
    sent.push({ endpoint, ...init })
    return { status: status[endpoint] ?? 201 }
  }
  beforeEach(() => {
    store = new PushSubscriptionsStore(mkdtempSync(join(tmpdir(), 'push-bell-')))
    sent = []
    status = {}
  })

  it('every device gets its own encrypted copy; accepted is noted, gone (410) is pruned', async () => {
    const a = browser()
    const b = browser()
    const da = store.add(sub(a, 'https://fcm.googleapis.com/fcm/send/a'), 'Pixel · Chrome', 'https://silos.example.com', new Date())
    store.add(sub(b, 'https://web.push.apple.com/b'), 'iPhone · Safari', 'http://127.0.0.1:3210', new Date())
    status['https://web.push.apple.com/b'] = 410
    const bell = new WebPushDoorbell({ keys: generateVapidKeys(), store, transport, now: () => Date.parse('2026-10-31T09:00:00Z') })
    const out = await bell.ring({ title: 'Silos', body: 'Something new needs you: a question', tag: 'silos-inbox', url: '/' })
    expect(out.map((r) => r.status).sort()).toEqual([201, 410])
    expect(sent).toHaveLength(2)
    const toA = sent.find((s) => s.endpoint.endsWith('/a'))!
    expect(toA.headers['Content-Encoding']).toBe('aes128gcm')
    expect(toA.headers.TTL).toBe(String(6 * 3600))
    expect(JSON.parse(decrypt(toA.body, a))).toEqual({ title: 'Silos', body: 'Something new needs you: a question', tag: 'silos-inbox', url: '/' })
    // an http origin can't be a VAPID subject: a mailto stands in
    const toB = sent.find((s) => s.endpoint.endsWith('/b'))!
    const claims = JSON.parse(Buffer.from(/t=[^.]+\.([^.]+)\./.exec(toB.headers.Authorization!)![1]!, 'base64url').toString())
    expect(claims.sub).toBe('mailto:push@silos.invalid')
    expect(store.list()).toEqual([expect.objectContaining({ id: da.id, lastAcceptedAt: '2026-10-31T09:00:00.000Z' })])
  })

  it('a refusal is remembered on the device, not thrown', async () => {
    const a = browser()
    const d = store.add(sub(a), 'Mac · Firefox', '', new Date())
    status[sub(a).endpoint] = 403
    const bell = new WebPushDoorbell({ keys: generateVapidKeys(), store, transport })
    await bell.ring({ title: 'Silos', body: 'x', tag: 't', url: '/' })
    expect(store.list()[0]).toMatchObject({ id: d.id, lastError: { status: 403 } })
  })
})

describe('/api/push routes', () => {
  const TOKEN = 't'
  const H = { 'x-token': TOKEN }
  let app: FastifyInstance, sent: string[]

  beforeEach(async () => {
    const base = mkdtempSync(join(tmpdir(), 'push-api-'))
    const root = join(base, 'projects')
    const dataDir = join(base, 'data')
    mkdirSync(root, { recursive: true })
    mkdirSync(join(dataDir, 'trash'), { recursive: true })
    const index = claudeSessionIndex(root, join(dataDir, 'cache.json'))
    await index.init()
    const registry = new AgentRegistry(join(dataDir, 'agents.json'))
    registry.load()
    const store = new SessionStore(root, dataDir)
    const native = new NativeStore(join(dataDir, 'native.json'))
    const chat = new ChatService({
      registry,
      native,
      queryFn: () => ({
        async *[Symbol.asyncIterator]() {},
        async interrupt() {
          return undefined
        },
      }),
    })
    const devices = new PushSubscriptionsStore(dataDir)
    sent = []
    const doorbell = new WebPushDoorbell({
      keys: loadOrCreateVapidKeys(dataDir),
      store: devices,
      transport: async (endpoint) => {
        sent.push(endpoint)
        return { status: 201 }
      },
    })
    app = buildServer({
      index,
      registry,
      store,
      native,
      chat,
      exec: new ExecService(registry),
      complete: new CompleteService(registry, index),
      prefs: new PrefsStore(dataDir),
      memory: new MemoryService(root, dataDir, registry),
      token: TOKEN,
      liveMs: 120_000,
      push: { doorbell, devices },
    })
  })

  it('subscribe, list (no keys back), test one device, revoke', async () => {
    const b = browser()
    const created = await app.inject({
      method: 'POST',
      url: '/api/push/devices',
      headers: { ...H, origin: 'https://silos.example.com' },
      payload: { subscription: sub(b), label: 'iPhone\u0007 · Safari' },
    })
    expect(created.statusCode).toBe(201)
    const d = created.json()
    expect(d).toMatchObject({ label: 'iPhone · Safari', endpoint: sub(b).endpoint })
    expect(d.keys).toBeUndefined()
    const list = (await app.inject({ url: '/api/push', headers: H })).json()
    expect(Buffer.from(list.publicKey, 'base64url')).toHaveLength(65)
    expect(list.devices).toHaveLength(1)
    const test = (await app.inject({ method: 'POST', url: `/api/push/devices/${d.id}/test`, headers: H })).json()
    expect(test.status).toBe(201)
    expect(test.device.lastAcceptedAt).toBeTruthy()
    expect(sent).toEqual([sub(b).endpoint])
    expect((await app.inject({ method: 'DELETE', url: `/api/push/devices/${d.id}`, headers: H })).statusCode).toBe(204)
    expect((await app.inject({ method: 'DELETE', url: `/api/push/devices/${d.id}`, headers: H })).statusCode).toBe(404)
    expect((await app.inject({ method: 'POST', url: '/api/push/devices/nope/test', headers: H })).statusCode).toBe(404)
  })

  it('refuses what is not a usable subscription', async () => {
    expect(
      (await app.inject({ method: 'POST', url: '/api/push/devices', headers: H, payload: { subscription: { endpoint: 'http://x', keys: {} } } })).statusCode,
    ).toBe(400)
  })
})
