// egress-private-guard.test.ts — the signer only talks to PUBLIC addresses
// (security review): a binding to loopback or
// any private range is refused at connect time — an agent that binds its
// own entry to 127.0.0.1 can neither reach the Silos API as a «local read»
// nor any internal service; a public name that RESOLVES private (DNS
// rebinding) dies in guardedLookup. This suite runs the REAL guard (the
// signer suite injects a permissive one for its 127.0.0.1 upstream).
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
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
import { buildServer } from '../src/server.js'
import { AgentTokens } from '../src/agent-tokens.js'
import { VaultStore } from '../src/vault-store.js'
import { privateAddressReason, guardedLookup, guardedFetch } from '../src/net-guard.js'
import { createServer, type Server } from 'node:http'
import { liveTurnOf } from './helpers/live-turn.js'

describe('privateAddressReason', () => {
  it.each([
    ['127.0.0.1', 'loopback'],
    ['127.8.8.8', 'loopback'],
    ['::1', 'loopback'],
    ['0.0.0.0', 'unspecified'],
    ['::', 'unspecified'],
    ['10.0.0.5', 'a private network'],
    ['172.16.0.1', 'a private network'],
    ['172.31.255.255', 'a private network'],
    ['192.168.1.1', 'a private network'],
    ['fc00::1', 'a private network'],
    ['fd12:3456::1', 'a private network'],
    ['169.254.169.254', 'link-local'],
    ['fe80::1', 'link-local'],
    ['100.64.0.1', 'carrier-grade NAT'],
    ['224.0.0.1', 'multicast or reserved'],
    ['255.255.255.255', 'multicast or reserved'],
    ['ff02::1', 'multicast'],
    ['192.0.0.170', 'reserved'],
    ['198.18.0.1', 'reserved'],
    ['::ffff:127.0.0.1', 'loopback'],
    ['::ffff:10.1.2.3', 'a private network'],
    // hex-form embedded v4 (no dots) — the first cut's miss (review)
    ['::ffff:7f00:1', 'loopback'],
    ['::ffff:a01:203', 'a private network'],
    ['64:ff9b::7f00:1', 'loopback'],
    ['64:ff9b::a00:1', 'a private network'],
    // not global unicast (2000::/3): refused by default, recognised or not
    ['::2', 'not global unicast'],
    ['100::1', 'not global unicast'],
    ['4000::1', 'not global unicast'],
  ])('%s → %s', (ip, why) => {
    expect(privateAddressReason(ip)).toBe(why)
  })

  it.each(['8.8.8.8', '1.1.1.1', '172.15.0.1', '172.32.0.1', '100.63.0.1', '100.128.0.1', '2606:4700::1111', '::ffff:8.8.8.8', '::ffff:808:808'])(
    '%s is public',
    (ip) => {
      expect(privateAddressReason(ip)).toBeNull()
    },
  )

  it('a non-IP is refused (lookup hands it addresses, never names)', () => {
    expect(privateAddressReason('evil.example')).toBe('not an IP address')
  })
})

describe('guardedLookup', () => {
  it('refuses a name that resolves to loopback (rebinding dies here)', async () => {
    const err = await new Promise<NodeJS.ErrnoException | null>((resolve) => {
      guardedLookup()('localhost', {}, (e) => resolve(e))
    })
    expect(err?.code).toBe('EPRIVATE')
    expect(err?.message).toContain('only talks to public addresses')
  })
})

describe('the signer with the real guard', () => {
  let app: FastifyInstance
  let vault: VaultStore
  let agentTokens: AgentTokens
  let chat: ChatService
  let silos: string
  const TOKEN = 't0k-guard'

  beforeEach(async () => {
    const base = mkdtempSync(join(tmpdir(), 'silos-guard-'))
    const root = join(base, 'projects')
    const dataDir = join(base, 'data')
    const folder = join(base, 'work')
    for (const d of [root, join(dataDir, 'trash'), folder]) mkdirSync(d, { recursive: true })
    const index = claudeSessionIndex(root, join(dataDir, 'cache.json'))
    await index.init()
    const registry = new AgentRegistry(join(dataDir, 'agents.json'))
    registry.load()
    registry.create({ id: 'builder', name: 'Builder', folder })
    agentTokens = new AgentTokens(dataDir)
    vault = new VaultStore(join(dataDir, 'vault.json'))
    vault.load()
    const native = new NativeStore(join(dataDir, 'native.json'))
    chat = new ChatService({
      registry,
      native,
      queryFn: () => {
        throw new Error('no turns here')
      },
      dataDir,
    })
    app = buildServer({
      index,
      registry,
      store: new SessionStore(root, dataDir),
      native,
      chat,
      exec: new ExecService(registry),
      complete: new CompleteService(registry, index),
      prefs: new PrefsStore(dataDir),
      memory: new MemoryService(root, dataDir, registry),
      token: TOKEN,
      liveMs: 120_000,
      agentTokens,
      vault,
      dataDir, // no egressPrivateReason: the REAL one runs
    })
    await app.listen({ host: '127.0.0.1', port: 0 })
    silos = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`
  })

  afterEach(async () => {
    await app.close()
  })

  const sign = async (): Promise<Response> => {
    const bearer = agentTokens.tokenFor('builder')
    return fetch(`${silos}/api/egress/SVC_KEY/items`, { headers: { authorization: `Bearer ${bearer}`, 'x-silos-turn': liveTurnOf(chat, 'builder') } })
  }

  it('an IP-literal binding to loopback is refused before any connection', async () => {
    vault.create({
      name: 'SVC_KEY',
      value: 'sk-x',
      scope: { type: 'agents', agentIds: ['builder'] },
      binding: { baseUrl: `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`, inject: { header: 'authorization', format: 'Bearer %s' } },
    })
    const r = await sign()
    expect(r.status).toBe(502)
    expect(((await r.json()) as { error: string }).error).toContain('only talks to public addresses')
  })

  it('a private-network IP literal is refused the same way', async () => {
    vault.create({
      name: 'SVC_KEY',
      value: 'sk-x',
      scope: { type: 'agents', agentIds: ['builder'] },
      binding: { baseUrl: 'http://10.0.0.7', inject: { header: 'x-key', format: '%s' } },
    })
    const r = await sign()
    expect(r.status).toBe(502)
  })

  it('a NAME that resolves to loopback is refused at lookup (rebinding)', async () => {
    vault.create({
      name: 'SVC_KEY',
      value: 'sk-x',
      scope: { type: 'agents', agentIds: ['builder'] },
      binding: { baseUrl: 'http://localhost:9', inject: { header: 'x-key', format: '%s' } },
    })
    const r = await sign()
    expect(r.status).toBe(502)
    expect(((await r.json()) as { error: string }).error).toContain('only talks to public addresses')
  })
})

// (t7) an http watch an agent set is fetched through the guard on EVERY
// check — the address it named when written may resolve elsewhere now, and a
// redirect may point anywhere. Two loopback hosts stand for the internet:
// 127.0.0.2 is «public», everything else private.
describe('guardedFetch', () => {
  const onlyDot2 = (ip: string): string | null => (ip === '127.0.0.2' ? null : 'private')
  let srv: Server
  let port = 0
  beforeEach(async () => {
    srv = createServer((req, res) => {
      if (req.url === '/to-literal') {
        res.writeHead(302, { location: `http://127.0.0.1:${port}/` })
        res.end()
        return
      }
      if (req.url === '/to-name') {
        res.writeHead(301, { location: `http://localhost:${port}/` })
        res.end()
        return
      }
      if (req.url === '/hop') {
        res.writeHead(307, { location: '/' })
        res.end()
        return
      }
      res.end('hello')
    })
    await new Promise<void>((ok) => srv.listen(0, '127.0.0.2', ok))
    port = (srv.address() as AddressInfo).port
  })
  afterEach(async () => {
    await new Promise<void>((ok) => srv.close(() => ok()))
  })

  it('fetches a public address and follows a redirect that stays public', async () => {
    expect(await guardedFetch(`http://127.0.0.2:${port}/hop`, { reason: onlyDot2 })).toEqual({ status: 200, body: 'hello' })
  })
  it('a private literal is refused before any connection', async () => {
    await expect(guardedFetch(`http://127.0.0.1:${port}/`, { reason: onlyDot2 })).rejects.toMatchObject({ code: 'EPRIVATE' })
  })
  it('a redirect to a private literal is refused', async () => {
    await expect(guardedFetch(`http://127.0.0.2:${port}/to-literal`, { reason: onlyDot2 })).rejects.toMatchObject({ code: 'EPRIVATE' })
  })
  it('a redirect to a name that resolves private dies in the lookup (rebinding)', async () => {
    await expect(guardedFetch(`http://127.0.0.2:${port}/to-name`, { reason: onlyDot2 })).rejects.toMatchObject({ code: 'EPRIVATE' })
  })
})
