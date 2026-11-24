// egress-proxy.test.ts — the network surface of the fence:
// ONE local proxy, a stable port, identity by Proxy-Authorization, an
// allowlist per agent with its engine's own hosts pinned, public addresses
// only (the REAL guard where it matters), one row per refusal; the env both
// engines receive; the owner's routes. Upstreams are local test servers —
// never a real service.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import http from 'node:http'
import net from 'node:net'
import type { AddressInfo } from 'node:net'
import type { FastifyInstance } from 'fastify'
import {
  EGRESS_NO_PROXY,
  effectiveAllowlist,
  effectiveEgressOf,
  egressProxyEnv,
  egressProxyPort,
  engineHostsOf,
  hostMatches,
  parseConnectTarget,
  proxyIdentity,
  startEgressProxy,
  type EffectiveEgress,
  type EgressProxy,
} from '../src/egress-proxy.js'
import { EgressRejectLog } from '../src/egress-log.js'
import { TerritoryStore, egressHostProblem, normalizeEgressHosts } from '../src/territory-store.js'
import { AgentStateStore } from '../src/agent-state.js'
import { AgentTokens } from '../src/agent-tokens.js'
import { agentProcessEnv } from '../src/agent-env.js'
import { registeredHarnesses } from '../src/harnesses/registry.js'
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

const basic = (user: string, pass: string): string => `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`

describe('host matching and the engine hosts', () => {
  it('exact (case-insensitive), *. = any subdomain never the apex, *- = a prefix inside the first label', () => {
    expect(hostMatches('API.anthropic.com', 'api.anthropic.com')).toBe(true)
    expect(hostMatches('api.anthropic.com.', 'api.anthropic.com')).toBe(true)
    expect(hostMatches('xapi.anthropic.com', 'api.anthropic.com')).toBe(false)
    expect(hostMatches('a.frame.claudeusercontent.com', '*.frame.claudeusercontent.com')).toBe(true)
    expect(hostMatches('a.b.frame.claudeusercontent.com', '*.frame.claudeusercontent.com')).toBe(true)
    expect(hostMatches('frame.claudeusercontent.com', '*.frame.claudeusercontent.com')).toBe(false)
    expect(hostMatches('evilframe.claudeusercontent.com', '*.frame.claudeusercontent.com')).toBe(false)
    expect(hostMatches('chromium-review.googlesource.com', '*-review.googlesource.com')).toBe(true)
    expect(hostMatches('a.chromium-review.googlesource.com', '*-review.googlesource.com')).toBe(false)
    expect(hostMatches('-review.googlesource.com', '*-review.googlesource.com')).toBe(false)
  })

  it('owner hosts are validated: names only, one leading wildcard', () => {
    expect(normalizeEgressHosts([' Example.COM ', 'example.com', '*.foo.dev', '*-review.googlesource.com'])).toEqual([
      'example.com',
      '*.foo.dev',
      '*-review.googlesource.com',
    ])
    for (const bad of [
      'https://example.com',
      'example.com:443',
      'example.com/x',
      'user@example.com',
      '*',
      'a.*.com',
      '**.x.com',
      '',
      '[::1]',
      'ex ample.com',
    ]) {
      expect(typeof normalizeEgressHosts([bad]), bad).toBe('string')
    }
    expect(normalizeEgressHosts('example.com')).toBe('hosts must be an array of host names')
  })

  it("every registered engine declares a sourced list, its patterns valid; the engine's hosts are always in the effective allowlist", () => {
    for (const h of registeredHarnesses()) {
      expect(h.engineHosts, h.id).toBeDefined()
      expect(h.engineHosts!.source).toMatch(/^https:\/\//)
      for (const e of h.engineHosts!.hosts) expect(egressHostProblem(e.host), `${h.id} ${e.host}`).toBeNull()
    }
    const claude = effectiveAllowlist([], engineHostsOf({}))
    expect(claude).toEqual(expect.arrayContaining(['api.anthropic.com', 'claude.ai', '*.frame.claudeusercontent.com', 'registry.npmjs.org']))
    // optional ones are offered, never pinned
    expect(claude).not.toContain('formulae.brew.sh')
    expect(effectiveAllowlist(['example.com'], engineHostsOf({ framework: 'opencode' }))).toEqual([
      'example.com',
      'opencode.ai',
      '*.opencode.ai',
      'models.dev',
      'api.anthropic.com',
    ])
    const store = { egressOf: () => ({ mode: 'allowlist' as const, hosts: [] }), agent: () => ({}) }
    const eff = effectiveEgressOf(store, 'a') as Extract<EffectiveEgress, { mode: 'allowlist' }>
    expect(eff.hosts.some((p) => hostMatches('x.frame.claudeusercontent.com', p))).toBe(true)
    expect(effectiveEgressOf({ egressOf: () => ({ mode: 'open', hosts: ['x.com'] }), agent: () => ({}) }, 'a')).toEqual({ mode: 'open' })
  })

  it('identity and CONNECT targets parse strictly', () => {
    const agentOf = (b: string): string | null => (b === 'tok' ? 'builder' : null)
    expect(proxyIdentity(basic('agent', 'tok'), agentOf)).toBe('builder')
    expect(proxyIdentity(basic('owner', 'tok'), agentOf)).toBeNull()
    expect(proxyIdentity(basic('agent', 'nope'), agentOf)).toBeNull()
    expect(proxyIdentity(basic('agent', ''), agentOf)).toBeNull()
    expect(proxyIdentity('Bearer tok', agentOf)).toBeNull()
    expect(proxyIdentity(undefined, agentOf)).toBeNull()
    expect(parseConnectTarget('Example.com:443')).toEqual({ host: 'example.com', port: 443 })
    expect(parseConnectTarget('[::1]:8443')).toEqual({ host: '::1', port: 8443 })
    for (const bad of ['example.com', 'example.com:0', 'example.com:70000', 'a@b.com:443', 'http://x:80', '']) expect(parseConnectTarget(bad), bad).toBeNull()
  })
})

describe('the env both engines receive', () => {
  let dataDir: string
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'silos-egress-env-'))
  })

  it('the stable port is the API port + 1', () => {
    expect(egressProxyPort(3210)).toBe(3211)
  })

  it('allowlist ⇒ the proxy with the bearer, both spellings, NO_PROXY for loopback; open ⇒ nothing', () => {
    const env = egressProxyEnv({ mode: 'allowlist' }, 'abc123', 3211)
    expect(env).toEqual({
      HTTP_PROXY: 'http://agent:abc123@127.0.0.1:3211',
      HTTPS_PROXY: 'http://agent:abc123@127.0.0.1:3211',
      NO_PROXY: 'localhost,127.0.0.1,::1',
      http_proxy: 'http://agent:abc123@127.0.0.1:3211',
      https_proxy: 'http://agent:abc123@127.0.0.1:3211',
      no_proxy: 'localhost,127.0.0.1,::1',
    })
    expect(egressProxyEnv({ mode: 'open' }, 'abc123', 3211)).toEqual({})
    // no bearer: still the proxy (every call a 407) — closed, never open
    expect(egressProxyEnv({ mode: 'allowlist' }, null, 3211).HTTPS_PROXY).toBe('http://127.0.0.1:3211')
  })

  it('composed through the identity channel: the agent process env carries it after the Vault (a Vault entry never stands over it)', () => {
    const store = new TerritoryStore(dataDir)
    store.load()
    const tokens = new AgentTokens(dataDir)
    const port = egressProxyPort(3210)
    const state = new AgentStateStore(join(dataDir, 'agent-state'), tokens, (id, bearer) => egressProxyEnv(store.egressOf(id), bearer, port))
    const vault = { envFor: () => ({ https_proxy: '', NO_PROXY: '*', OTHER: 'x' }) }
    const open = agentProcessEnv({ vault, agentState: state, silosApi: 'http://127.0.0.1:3210' }, { id: 'builder' }, null)
    expect(open.HTTP_PROXY).toBeUndefined()
    expect(open.HTTPS_PROXY).toBeUndefined()
    store.setEgress('builder', { mode: 'allowlist', hosts: ['example.com'] })
    const env = agentProcessEnv({ vault, agentState: state, silosApi: 'http://127.0.0.1:3210' }, { id: 'builder' }, null)
    const url = `http://agent:${tokens.tokenFor('builder')}@127.0.0.1:3211`
    expect(env).toMatchObject({
      HTTP_PROXY: url,
      HTTPS_PROXY: url,
      https_proxy: url,
      NO_PROXY: EGRESS_NO_PROXY,
      no_proxy: EGRESS_NO_PROXY,
      OTHER: 'x',
      SILOS_API: 'http://127.0.0.1:3210',
    })
    // another agent stays open
    expect(agentProcessEnv({ agentState: state }, { id: 'other' }, null).HTTPS_PROXY).toBeUndefined()
  })

  it('the policy persists in territory.json beside the fence settings; back to open with no hosts leaves the map', () => {
    const store = new TerritoryStore(dataDir)
    store.load()
    store.setEnabled(['builder'])
    store.setEgress('builder', { mode: 'allowlist', hosts: ['Example.com'] })
    const again = new TerritoryStore(dataDir)
    again.load()
    expect(again.egressOf('builder')).toEqual({ mode: 'allowlist', hosts: ['example.com'] })
    expect(again.enabled()).toEqual(['builder'])
    expect(again.egressOf('nobody')).toEqual({ mode: 'open', hosts: [] })
    again.setEgress('builder', { mode: 'open', hosts: [] })
    expect(JSON.parse(readFileSync(join(dataDir, 'territory.json'), 'utf8')).egress).toBeUndefined()
  })
})

// ── the proxy itself ──────────────────────────────────────────────────────

interface Upstream {
  port: number
  seen: { url: string; headers: http.IncomingHttpHeaders }[]
  close(): Promise<void>
}
async function upstream(): Promise<Upstream> {
  const seen: Upstream['seen'] = []
  const srv = http.createServer((req, res) => {
    seen.push({ url: req.url ?? '', headers: req.headers })
    res.writeHead(200, { 'content-type': 'text/plain', 'x-up': 'yes' })
    res.end(`hello from upstream ${req.url}`)
  })
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()))
  return {
    port: (srv.address() as AddressInfo).port,
    seen,
    close: () =>
      new Promise((r) => {
        srv.closeAllConnections()
        srv.close(() => r())
      }),
  }
}

// CONNECT through the proxy: the status line, then (when 200) an HTTP GET
// sent INSIDE the tunnel and what comes back
function connect(proxyPort: number, target: string, auth?: string): Promise<{ status: number; head: string; tunneled?: string }> {
  return new Promise((resolve, reject) => {
    const s = net.connect(proxyPort, '127.0.0.1')
    let buf = ''
    let status = 0
    let head = ''
    s.on('data', (d) => {
      buf += d.toString('utf8')
      if (status === 0 && buf.includes('\r\n\r\n')) {
        const i = buf.indexOf('\r\n\r\n')
        head = buf.slice(0, i)
        status = Number(head.split(' ')[1])
        buf = buf.slice(i + 4)
        if (status === 200) s.write('GET /through-the-tunnel HTTP/1.1\r\nHost: up\r\nConnection: close\r\n\r\n')
      }
    })
    s.on('end', () => resolve({ status, head, ...(status === 200 ? { tunneled: buf } : {}) }))
    s.on('error', reject)
    s.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n${auth ? `Proxy-Authorization: ${auth}\r\n` : ''}\r\n`)
  })
}

// a plain-HTTP forward: an absolute URI on the request line
function forward(proxyPort: number, url: string, auth?: string): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: proxyPort,
        method: 'GET',
        path: url,
        headers: { ...(auth ? { 'proxy-authorization': auth } : {}), host: new URL(url).host },
        agent: false,
      },
      (res) => {
        let body = ''
        res.on('data', (d) => {
          body += d
        })
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }))
      },
    )
    req.on('error', reject)
    req.end()
  })
}

describe('the egress proxy', () => {
  let up: Upstream
  let proxy: EgressProxy
  let log: EgressRejectLog
  let dataDir: string
  let policies: Record<string, EffectiveEgress>
  const BEARERS: Record<string, string> = { 'tok-builder': 'builder', 'tok-open': 'wanderer' }

  const start = async (privateReason?: (ip: string) => string | null, port = 0): Promise<EgressProxy> =>
    startEgressProxy(
      {
        agentOf: (b) => BEARERS[b] ?? null,
        policyFor: (id) => policies[id] ?? { mode: 'open' },
        log,
        ...(privateReason ? { privateReason } : {}),
      },
      { port },
    )
  const rows = (): Array<Record<string, unknown>> => {
    try {
      return readFileSync(join(dataDir, 'egress', 'rejected.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .filter((l) => l !== '')
        .map((l) => JSON.parse(l) as Record<string, unknown>)
    } catch {
      return []
    }
  }

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'silos-egress-proxy-'))
    log = new EgressRejectLog(join(dataDir, 'egress'))
    up = await upstream()
    policies = { builder: { mode: 'allowlist', hosts: ['127.0.0.1', '*.allowed.test'] } }
    // the upstream lives on 127.0.0.1: these tests inject a permissive
    // guard (the private-address suite below runs the REAL one)
    proxy = await start(() => null)
  })
  afterEach(async () => {
    await proxy.close()
    await up.close()
  })

  it('identity is mandatory: no header, a bad bearer or another user name → 407 with the Basic challenge (CONNECT and forward)', async () => {
    for (const auth of [undefined, basic('agent', 'wrong'), basic('owner', 'tok-builder'), 'Bearer tok-builder']) {
      const c = await connect(proxy.port, `127.0.0.1:${up.port}`, auth)
      expect(c.status).toBe(407)
      expect(c.head).toMatch(/Proxy-Authenticate: Basic/i)
      const f = await forward(proxy.port, `http://127.0.0.1:${up.port}/x`, auth)
      expect(f.status).toBe(407)
      expect(f.headers['proxy-authenticate']).toMatch(/^Basic/)
    }
    expect(up.seen).toHaveLength(0)
    expect(rows()).toHaveLength(0) // nobody to name: a 407 is not a refusal row
  })

  it('CONNECT to an allowed host tunnels to the upstream, bytes intact', async () => {
    const c = await connect(proxy.port, `127.0.0.1:${up.port}`, basic('agent', 'tok-builder'))
    expect(c.status).toBe(200)
    expect(c.tunneled).toContain('hello from upstream /through-the-tunnel')
    expect(up.seen.map((s) => s.url)).toEqual(['/through-the-tunnel'])
    expect(rows()).toHaveLength(0)
  })

  it('CONNECT to a host outside the allowlist → 403 with the host named, and ONE row (who, host, port, why — no path)', async () => {
    const c = await connect(proxy.port, 'evil.example.com:443', basic('agent', 'tok-builder'))
    expect(c.status).toBe(403)
    const r = rows()
    expect(r).toHaveLength(1)
    expect(r[0]).toMatchObject({ agentId: 'builder', host: 'evil.example.com', port: 443, reason: 'not in its allowlist' })
    expect(typeof r[0]!.at).toBe('string')
    expect(Object.keys(r[0]!).sort()).toEqual(['agentId', 'at', 'host', 'port', 'reason'])
  })

  it('a plain-HTTP forward: allowed reaches the upstream (path + query, never the proxy credential); denied → 403 + row without the path', async () => {
    const ok = await forward(proxy.port, `http://127.0.0.1:${up.port}/hello?x=1`, basic('agent', 'tok-builder'))
    expect(ok.status).toBe(200)
    expect(ok.body).toBe('hello from upstream /hello?x=1')
    expect(ok.headers['x-up']).toBe('yes')
    expect(up.seen[0]!.url).toBe('/hello?x=1')
    expect(up.seen[0]!.headers['proxy-authorization']).toBeUndefined()
    const no = await forward(proxy.port, 'http://denied.example.org/secret-path?q=token', basic('agent', 'tok-builder'))
    expect(no.status).toBe(403)
    expect(no.body).toContain('denied.example.org')
    const onDisk = readFileSync(join(dataDir, 'egress', 'rejected.jsonl'), 'utf8')
    expect(onDisk).toContain('denied.example.org')
    expect(onDisk).not.toContain('secret-path')
    expect(onDisk).not.toContain('token')
  })

  it('an https:// absolute URI is not forwarded (CONNECT only), a relative one is not a proxy request', async () => {
    expect((await forward(proxy.port, 'https://127.0.0.1/x', basic('agent', 'tok-builder'))).status).toBe(400)
    const r = await new Promise<number>((resolve) => {
      http.get({ host: '127.0.0.1', port: proxy.port, path: '/' }, (res) => {
        res.resume()
        resolve(res.statusCode ?? 0)
      })
    })
    expect(r).toBe(400)
  })

  it('open means open: an open agent calling the proxy with its bearer is let through (public-address rule aside)', async () => {
    const c = await connect(proxy.port, `127.0.0.1:${up.port}`, basic('agent', 'tok-open'))
    expect(c.status).toBe(200)
    expect(rows()).toHaveLength(0)
  })

  it('the port is stable: a second boot on the same port listens there again', async () => {
    const port = proxy.port
    await proxy.close()
    proxy = await start(() => null, port)
    expect(proxy.port).toBe(port)
    expect((await connect(proxy.port, `127.0.0.1:${up.port}`, basic('agent', 'tok-builder'))).status).toBe(200)
  })

  describe('public addresses only — the REAL guard', () => {
    beforeEach(async () => {
      await proxy.close()
      policies = { builder: { mode: 'allowlist', hosts: ['127.0.0.1', 'localhost', '10.1.2.3'] }, wanderer: { mode: 'open' } }
      proxy = await start() // no injection: net-guard's privateAddressReason
    })

    it('a loopback / private literal → 502 + row, nothing reaches the upstream (allowlisted or open alike)', async () => {
      const c = await connect(proxy.port, `127.0.0.1:${up.port}`, basic('agent', 'tok-builder'))
      expect(c.status).toBe(502)
      const o = await connect(proxy.port, `127.0.0.1:${up.port}`, basic('agent', 'tok-open'))
      expect(o.status).toBe(502)
      const p = await connect(proxy.port, '10.1.2.3:443', basic('agent', 'tok-builder'))
      expect(p.status).toBe(502)
      const f = await forward(proxy.port, `http://127.0.0.1:${up.port}/x`, basic('agent', 'tok-builder'))
      expect(f.status).toBe(502)
      expect(up.seen).toHaveLength(0)
      const r = rows()
      expect(r.map((x) => x.reason)).toEqual(['loopback (127.0.0.1)', 'loopback (127.0.0.1)', 'a private network (10.1.2.3)', 'loopback (127.0.0.1)'])
      expect(r.map((x) => x.agentId)).toEqual(['builder', 'wanderer', 'builder', 'builder'])
    })

    it("a name that resolves private → 502 + row (the guarded lookup is the connection's own)", async () => {
      const c = await connect(proxy.port, `localhost:${up.port}`, basic('agent', 'tok-builder'))
      expect(c.status).toBe(502)
      const f = await forward(proxy.port, `http://localhost:${up.port}/x`, basic('agent', 'tok-builder'))
      expect(f.status).toBe(502)
      expect(f.body).toContain('only talks to public addresses')
      expect(up.seen).toHaveLength(0)
      const r = rows()
      expect(r).toHaveLength(2)
      expect(r[0]).toMatchObject({ agentId: 'builder', host: 'localhost', port: up.port })
      expect(String(r[0]!.reason)).toMatch(/^resolves to loopback/)
    })
  })
})

// ── the owner's routes ────────────────────────────────────────────────────

describe('the egress routes', () => {
  let app: FastifyInstance
  let tokens: AgentTokens
  let store: TerritoryStore
  let dataDir: string
  const OWNER = { host: '127.0.0.1:3210', 'x-token': 't0k' }
  const LOCAL = { host: '127.0.0.1:3210' }

  beforeEach(async () => {
    const base = mkdtempSync(join(tmpdir(), 'silos-egress-routes-'))
    const root = join(base, 'projects')
    dataDir = join(base, 'data')
    const folder = mkdtempSync(join(tmpdir(), 'silos-egress-folder-'))
    mkdirSync(join(dataDir, 'trash'), { recursive: true })
    mkdirSync(root, { recursive: true })
    const index = claudeSessionIndex(root, join(dataDir, 'cache.json'))
    await index.init()
    const registry = new AgentRegistry(join(dataDir, 'agents.json'))
    registry.load()
    registry.create({ id: 'builder', name: 'Builder', folder })
    registry.create({ id: 'oc', name: 'Oc', folder, framework: 'opencode' })
    const native = new NativeStore(join(dataDir, 'native.json'))
    const chat = new ChatService({
      registry,
      native,
      queryFn: () => {
        throw new Error('no sdk')
      },
    })
    tokens = new AgentTokens(dataDir)
    store = new TerritoryStore(dataDir)
    store.load()
    const log = new EgressRejectLog(join(dataDir, 'egress'))
    log.append({ at: '2026-11-17T10:00:00.000Z', agentId: 'builder', host: 'evil.example.com', port: 443, reason: 'not in its allowlist' })
    log.append({ at: '2026-11-17T10:01:00.000Z', agentId: 'oc', host: 'other.example.com', port: 443, reason: 'not in its allowlist' })
    app = buildServer({
      index,
      registry,
      native,
      chat,
      store: new SessionStore(root, dataDir),
      exec: new ExecService(registry),
      complete: new CompleteService(registry, index),
      prefs: new PrefsStore(dataDir),
      memory: new MemoryService(root, dataDir, registry),
      token: 't0k',
      liveMs: 120_000,
      agentTokens: tokens,
      territoryStore: store,
      home: base,
      dataDir,
      egressRejectLog: log,
      egressProxyPort: 3211,
    })
  })
  afterEach(async () => {
    await app.close()
  })

  it("GET lists each agent's policy with its engine's own hosts and the proxy port", async () => {
    const r = await app.inject({ method: 'GET', url: '/api/territory/egress', headers: OWNER })
    expect(r.statusCode).toBe(200)
    const body = r.json() as {
      proxyPort: number
      agents: Array<{ id: string; mode: string; hosts: string[]; engine: { source: string; hosts: { host: string }[] } }>
    }
    expect(body.proxyPort).toBe(3211)
    const b = body.agents.find((a) => a.id === 'builder')!
    expect(b).toMatchObject({ mode: 'open', hosts: [] })
    expect(b.engine.source).toBe('https://code.claude.com/docs/en/network-config')
    expect(body.agents.find((a) => a.id === 'oc')!.engine.hosts.map((h) => h.host)).toContain('models.dev')
  })

  it('PATCH validates before saving, then persists', async () => {
    const patch = (id: string, payload: unknown, headers: Record<string, string> = OWNER) =>
      app.inject({ method: 'PATCH', url: `/api/territory/egress/${id}`, headers, payload: payload as Record<string, unknown> })
    expect((await patch('builder', {})).statusCode).toBe(400)
    expect((await patch('builder', { mode: 'closed' })).statusCode).toBe(400)
    for (const bad of [['https://example.com'], ['example.com:443'], ['example.com/path'], 'example.com', [42]]) {
      expect((await patch('builder', { mode: 'allowlist', hosts: bad })).statusCode, JSON.stringify(bad)).toBe(400)
    }
    expect((await patch('nobody', { mode: 'allowlist' })).statusCode).toBe(404)
    expect((await patch('master', { mode: 'allowlist' })).statusCode).toBe(404)
    expect(store.egressOf('builder')).toEqual({ mode: 'open', hosts: [] })
    const ok = await patch('builder', { mode: 'allowlist', hosts: ['API.example.com', '*.cdn.example.com'] })
    expect(ok.statusCode).toBe(200)
    expect(ok.json().agent).toMatchObject({ id: 'builder', mode: 'allowlist', hosts: ['api.example.com', '*.cdn.example.com'] })
    // hosts alone keep the mode; mode alone keeps the hosts
    await patch('builder', { hosts: ['only.example.com'] })
    expect(store.egressOf('builder')).toEqual({ mode: 'allowlist', hosts: ['only.example.com'] })
    await patch('builder', { mode: 'open' })
    expect(store.egressOf('builder')).toEqual({ mode: 'open', hosts: ['only.example.com'] })
    const again = new TerritoryStore(dataDir)
    again.load()
    expect(again.egressOf('builder')).toEqual({ mode: 'open', hosts: ['only.example.com'] })
  })

  it("an agent can neither set egress nor read the refusals; a local request without the owner's credential cannot read them", async () => {
    const asAgent = { ...LOCAL, authorization: `Bearer ${tokens.tokenFor('builder')}` }
    expect((await app.inject({ method: 'PATCH', url: '/api/territory/egress/builder', headers: asAgent, payload: { mode: 'open' } })).statusCode).toBe(403)
    expect((await app.inject({ method: 'GET', url: '/api/territory/egress/rejections', headers: asAgent })).statusCode).toBe(403)
    expect((await app.inject({ method: 'GET', url: '/api/territory/egress', headers: asAgent })).statusCode).toBe(403)
    expect((await app.inject({ method: 'GET', url: '/api/territory/egress/rejections', headers: LOCAL })).statusCode).toBe(401)
    expect((await app.inject({ method: 'PATCH', url: '/api/territory/egress/builder', headers: LOCAL, payload: { mode: 'open' } })).statusCode).toBe(401)
  })

  it('GET rejections: newest first, filtered by agent', async () => {
    const all = (await app.inject({ method: 'GET', url: '/api/territory/egress/rejections', headers: OWNER })).json().rows as Array<{ agentId: string }>
    expect(all.map((r) => r.agentId)).toEqual(['oc', 'builder'])
    const one = (await app.inject({ method: 'GET', url: '/api/territory/egress/rejections?agent=builder&limit=5', headers: OWNER })).json().rows as Array<{
      host: string
    }>
    expect(one.map((r) => r.host)).toEqual(['evil.example.com'])
  })
})
