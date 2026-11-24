// vault-signer.test.ts — the signer: a Vault
// entry with a binding is USED through /api/egress/<NAME>/… and never held.
// Real sockets on both sides — a Silos server on an ephemeral loopback port
// and a simulated upstream (a local HTTP server); never a real service.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import http from 'node:http'
import net from 'node:net'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync } from 'node:fs'
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
import { agentMayWrite, agentWriteNeedsTurn, isWriteClass } from '../src/agent-authz.js'
import { parseEgressTarget } from '../src/routes/egress.js'
import { credentialsLine } from '../src/silos/producer-brief.js'
import { liveTurnOf } from './helpers/live-turn.js'

const TOKEN = 't0k-signer'
const IDLE_MS = 400

interface Seen {
  method: string
  url: string
  headers: http.IncomingHttpHeaders
  body: Buffer
}

let app: FastifyInstance
let chat: ChatService
let vault: VaultStore
let agentTokens: AgentTokens
let registry: AgentRegistry
let dataDir: string, folderA: string, folderB: string
let silos: string // http://127.0.0.1:<port>
let upstream: http.Server, upstreamUrl: string
let other: http.Server, otherUrl: string, otherHits: number
let seen: Seen[]
let upstreamHandler: (req: http.IncomingMessage, res: http.ServerResponse, body: Buffer) => void

const listen = (s: http.Server): Promise<string> =>
  new Promise((resolve) => s.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(s.address() as AddressInfo).port}`)))

beforeEach(async () => {
  const base = mkdtempSync(join(tmpdir(), 'silos-signer-'))
  const root = join(base, 'projects')
  dataDir = join(base, 'data')
  folderA = join(base, 'work', 'alpha')
  folderB = join(base, 'work', 'beta')
  for (const d of [root, join(dataDir, 'trash'), folderA, folderB]) mkdirSync(d, { recursive: true })
  const index = claudeSessionIndex(root, join(dataDir, 'cache.json'))
  await index.init()
  registry = new AgentRegistry(join(dataDir, 'agents.json'))
  registry.load()
  registry.create({ id: 'builder', name: 'Builder', folder: folderA, folders: [folderB] })
  registry.create({ id: 'finance', name: 'Finance', folder: folderA })
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
    dataDir,
    egressIdleMs: IDLE_MS,
    // this suite's simulated upstream LIVES on 127.0.0.1 — the private-address
    // guard is itself under test in net-guard.test.ts and the case below
    egressPrivateReason: () => null,
  })
  await app.listen({ host: '127.0.0.1', port: 0 })
  silos = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`

  seen = []
  upstreamHandler = (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('ok')
  }
  upstream = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const body = Buffer.concat(chunks)
      seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body })
      upstreamHandler(req, res, body)
    })
  })
  upstreamUrl = await listen(upstream)
  otherHits = 0
  other = http.createServer((_req, res) => {
    otherHits++
    res.end('other')
  })
  otherUrl = await listen(other)
})

afterEach(async () => {
  upstream.closeAllConnections()
  other.closeAllConnections()
  await new Promise<void>((r) => upstream.close(() => r()))
  await new Promise<void>((r) => other.close(() => r()))
  await app.close()
})

interface Res {
  status: number
  headers: http.IncomingHttpHeaders
  body: Buffer
}

function call(method: string, path: string, headers: Record<string, string> = {}, body?: Buffer | string): Promise<Res> {
  return new Promise((resolve, reject) => {
    const u = new URL(silos)
    const req = http.request(
      { hostname: u.hostname, port: u.port, method, path, headers: { host: `127.0.0.1:${u.port}`, ...headers }, agent: false },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }))
        res.on('error', reject)
      },
    )
    req.on('error', reject)
    if (body !== undefined) req.write(body)
    req.end()
  })
}

const asAgent = (id: string, extra: Record<string, string> = {}): Record<string, string> => ({
  authorization: `Bearer ${agentTokens.tokenFor(id)}`,
  'x-silos-turn': liveTurnOf(chat, id),
  ...extra,
})
const asOwner = (extra: Record<string, string> = {}): Record<string, string> => ({ 'x-token': TOKEN, ...extra })
const bind = (header = 'X-Api-Key', format = '%s', baseUrl = upstreamUrl) => ({ baseUrl, inject: { header, format } })
const signed = (name: string, value: string, scope: unknown, binding = bind()) => vault.create({ name, value, scope, binding })

describe('who may call — identity always, the route is write-class', () => {
  it('a GET without identity is 401 — the local read-without-token exception never reaches it', async () => {
    signed('SVC_KEY', 'sk-1', { type: 'global' })
    const r = await call('GET', '/api/egress/SVC_KEY/items')
    expect(r.status).toBe(401)
    expect(seen).toHaveLength(0)
    // and encoded, the same route
    expect((await call('GET', '/%61pi/egress/SVC_KEY/items')).status).toBe(401)
  })

  it('an invalid bearer is 401; an agent without its turn is refused before anything is sent', async () => {
    signed('SVC_KEY', 'sk-1', { type: 'global' })
    expect((await call('GET', '/api/egress/SVC_KEY/x', { authorization: 'Bearer nope' })).status).toBe(401)
    const noTurn = await call('GET', '/api/egress/SVC_KEY/x', { authorization: `Bearer ${agentTokens.tokenFor('builder')}` })
    expect([400, 403]).toContain(noTurn.status)
    expect(seen).toHaveLength(0)
  })

  it('agent-authz: every verb on /api/egress is a write the agent may make, and it names its turn', () => {
    for (const m of ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
      expect(isWriteClass(m, '/api/egress/SVC_KEY/a//b/')).toBe(true)
      expect(agentMayWrite('builder', m, '/api/egress/SVC_KEY/a//b/')).toBe(true)
      expect(agentWriteNeedsTurn(m, '/api/egress/SVC_KEY/x')).toBe(true)
    }
    expect(isWriteClass('GET', '/api/vault')).toBe(false)
    expect(isWriteClass('GET', '/%61pi/egress/K/x')).toBe(true)
  })

  it('the owner signs too: global entries only, or as an agent it names', async () => {
    signed('SVC_KEY', 'sk-global', { type: 'global' })
    signed('OWN_KEY', 'sk-b', { type: 'agents', agentIds: ['builder'] })
    expect((await call('GET', '/api/egress/SVC_KEY/x', asOwner())).status).toBe(200)
    expect((await call('GET', '/api/egress/OWN_KEY/x', asOwner())).status).toBe(404)
    expect((await call('GET', '/api/egress/OWN_KEY/x', asOwner({ 'x-silos-agent': 'builder' }))).status).toBe(200)
    expect(seen.map((s) => s.headers['x-api-key'])).toEqual(['sk-global', 'sk-b'])
    expect(seen[1]!.headers['x-silos-agent']).toBeUndefined()
  })
})

describe('resolution — the viewFor winner over every folder, binding after, no fallback', () => {
  it("a folder entry over the agent's SECOND folder is signable; another agent never sees it", async () => {
    signed('BETA_KEY', 'sk-beta', { type: 'folder', folder: folderB })
    expect((await call('GET', '/api/egress/BETA_KEY/x', asAgent('builder'))).status).toBe(200)
    expect((await call('GET', '/api/egress/BETA_KEY/x', asAgent('finance'))).status).toBe(404)
    expect(seen).toHaveLength(1)
  })

  it('a winner without binding is 404 — never a fallback to the outer signed entry; and the phrase never confirms it exists', async () => {
    signed('SVC_KEY', 'sk-global', { type: 'global' })
    vault.create({ name: 'SVC_KEY', value: 'delivered-own', scope: { type: 'agents', agentIds: ['builder'] } })
    const shadowed = await call('GET', '/api/egress/SVC_KEY/x', asAgent('builder'))
    const absent = await call('GET', '/api/egress/NOPE_KEY/x', asAgent('builder'))
    expect(shadowed.status).toBe(404)
    expect(absent.status).toBe(404)
    expect(JSON.parse(shadowed.body.toString()).error.replace('SVC_KEY', 'X')).toBe(JSON.parse(absent.body.toString()).error.replace('NOPE_KEY', 'X'))
    expect((await call('GET', '/api/egress/SVC_KEY/x', asAgent('finance'))).status).toBe(200)
    expect(seen).toHaveLength(1)
  })

  it('the deepest folder entry signs (the class tie-break, at the signer)', async () => {
    signed('SVC_KEY', 'sk-deep', { type: 'folder', folder: folderB })
    signed('SVC_KEY', 'sk-shallow', { type: 'folder', folder: join(folderB, '..') })
    await call('GET', '/api/egress/SVC_KEY/x', asAgent('builder'))
    expect(seen[0]!.headers['x-api-key']).toBe('sk-deep')
  })

  it('a signed entry is NOT in the env, nor in what logs are redacted of', () => {
    signed('SVC_KEY', 'sk-1', { type: 'agents', agentIds: ['builder'] })
    vault.create({ name: 'PLAIN_KEY', value: 'p-1', scope: { type: 'agents', agentIds: ['builder'] } })
    expect(vault.envFor('builder', folderA)).toEqual({ PLAIN_KEY: 'p-1' })
    expect(vault.secretsFor('builder', folderA)).toEqual(['p-1'])
    expect(vault.credentialsFor('builder', [folderA])).toEqual([
      { name: 'PLAIN_KEY', signed: false },
      { name: 'SVC_KEY', signed: true },
    ])
  })
})

describe("forwarding — the host is fixed, the body raw, the agent's credentials dropped", () => {
  it('forwards method, path under the base path (one slash at the join), query, and injects the credential', async () => {
    signed('SVC_KEY', 'sk-1', { type: 'global' }, bind('Authorization', 'Bearer %s', `${upstreamUrl}/v2/`))
    const r = await call(
      'PATCH',
      '/api/egress/SVC_KEY/items/7?expand=a&b=%20c',
      asAgent('builder', { 'content-type': 'application/json', accept: 'application/json', cookie: 'sid=agent', 'x-forwarded-for': '10.0.0.1' }),
      '{"a":1}',
    )
    expect(r.status).toBe(200)
    const s = seen[0]!
    expect(s.method).toBe('PATCH')
    expect(s.url).toBe('/v2/items/7?expand=a&b=%20c')
    expect(s.headers.authorization).toBe('Bearer sk-1') // the signed one — never the agent's bearer
    expect(s.headers['x-silos-turn']).toBeUndefined()
    expect(s.headers.cookie).toBeUndefined()
    expect(s.headers['x-forwarded-for']).toBeUndefined()
    expect(s.headers.host).toBe(new URL(upstreamUrl).host)
    expect(s.headers['content-type']).toBe('application/json')
    expect(s.headers.accept).toBe('application/json')
  })

  it("the agent's own copy of the injected header never stands over the signed one", async () => {
    signed('SVC_KEY', 'sk-real', { type: 'global' })
    await call('GET', '/api/egress/SVC_KEY/x', asAgent('builder', { 'x-api-key': 'forged' }))
    expect(seen[0]!.headers['x-api-key']).toBe('sk-real')
  })

  it("the owner's ?token= is Silos' credential: never forwarded", async () => {
    signed('SVC_KEY', 'sk-1', { type: 'global' })
    await call('GET', `/api/egress/SVC_KEY/x?page=2&token=${TOKEN}`)
    expect(seen[0]!.url).toBe('/x?page=2')
    expect(seen[0]!.headers['x-token']).toBeUndefined()
  })

  it('a binary body passes byte for byte, whatever its declared type (no parser reads it), and so does the response', async () => {
    signed('SVC_KEY', 'sk-1', { type: 'global' })
    const payload = Buffer.concat([Buffer.from(Array.from({ length: 256 }, (_, i) => i)), randomBytes(200_000)])
    upstreamHandler = (_req, res, body) => {
      res.writeHead(200, { 'content-type': 'application/octet-stream' })
      res.end(Buffer.from(body).reverse())
    }
    const r = await call('POST', '/api/egress/SVC_KEY/upload', asAgent('builder', { 'content-type': 'application/octet-stream' }), payload)
    expect(r.status).toBe(200)
    expect(seen[0]!.body.equals(payload)).toBe(true)
    expect(r.body.equals(Buffer.from(payload).reverse())).toBe(true)
    // a body declared JSON that is not JSON reaches the service as is
    const r2 = await call('PUT', '/api/egress/SVC_KEY/raw', asAgent('builder', { 'content-type': 'application/json' }), '{not json')
    expect(r2.status).toBe(200)
    expect(seen[1]!.body.toString()).toBe('{not json')
    // no content-type at all
    const r3 = await call('POST', '/api/egress/SVC_KEY/raw', asAgent('builder'), 'plain bytes')
    expect(r3.status).toBe(200)
    expect(seen[2]!.body.toString()).toBe('plain bytes')
  })

  it('path traversal, encoded or not, is refused before anything is sent', async () => {
    signed('SVC_KEY', 'sk-1', { type: 'global' }, bind('X-Api-Key', '%s', `${upstreamUrl}/base`))
    for (const p of ['/api/egress/SVC_KEY/../admin', '/api/egress/SVC_KEY/a/%2e%2e/admin', '/api/egress/SVC_KEY/a/%2E%2E%2Fadmin', '/api/egress/SVC_KEY/./x']) {
      const r = await call('GET', p, asOwner())
      expect(r.status, p).toBe(400)
    }
    expect(seen).toHaveLength(0)
  })

  it('an absolute URL or a //host in the path stays a path on the bound host', async () => {
    signed('SVC_KEY', 'sk-1', { type: 'global' })
    const evil = new URL(otherUrl).host
    await call('GET', `/api/egress/SVC_KEY//${evil}/steal`, asAgent('builder'))
    await call('GET', `/api/egress/SVC_KEY/http://${evil}/steal`, asAgent('builder'))
    expect(otherHits).toBe(0)
    // a leading // collapses at the join; inside, the path is the agent's as written
    expect(seen.map((s) => s.url)).toEqual([`/${evil}/steal`, `/http://${evil}/steal`])
    expect(seen.every((s) => s.headers.host === new URL(upstreamUrl).host)).toBe(true)
  })

  it('parseEgressTarget refuses what a request line cannot carry (CR/LF, spaces, non-ASCII)', () => {
    expect(parseEgressTarget('/api/egress/K/a\r\nHost: evil')).toEqual(expect.stringContaining('request line'))
    expect(parseEgressTarget('/api/egress/K/a b')).toEqual(expect.stringContaining('request line'))
    expect(parseEgressTarget('/api/egress/K/ñ')).toEqual(expect.stringContaining('request line'))
    expect(parseEgressTarget('/api/egress/K/a//b/?q=1')).toEqual({ name: 'K', rest: '/a//b/', query: 'q=1' })
    expect(parseEgressTarget('/api/egress/K')).toEqual({ name: 'K', rest: '', query: '' })
  })

  it('a header carrying CR/LF from the caller never reaches the service (refused at the socket)', async () => {
    signed('SVC_KEY', 'sk-1', { type: 'global' })
    const port = new URL(silos).port
    const reply = await new Promise<string>((resolve) => {
      const sock = net.connect(Number(port), '127.0.0.1', () => {
        sock.write(`GET /api/egress/SVC_KEY/x HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nx-token: ${TOKEN}\r\nX-Evil: a\rInjected: b\r\n\r\n`)
      })
      let buf = ''
      sock.on('data', (d) => {
        buf += d.toString()
      })
      sock.on('close', () => resolve(buf))
      sock.on('error', () => resolve(buf))
      setTimeout(() => sock.destroy(), 1500)
    })
    expect(reply.startsWith('HTTP/1.1 400')).toBe(true)
    expect(seen).toHaveLength(0)
  })

  it('a redirect comes back as it is — never followed, never carrying the credential elsewhere', async () => {
    signed('SVC_KEY', 'sk-1', { type: 'global' })
    upstreamHandler = (_req, res) => {
      res.writeHead(302, { location: `${otherUrl}/landing` })
      res.end()
    }
    const r = await call('GET', '/api/egress/SVC_KEY/go', asAgent('builder'))
    expect(r.status).toBe(302)
    expect(r.headers.location).toBe(`${otherUrl}/landing`)
    expect(otherHits).toBe(0)
  })

  it("upstream errors pass as they are (status and body); a service's cookie never lands on Silos' origin", async () => {
    signed('SVC_KEY', 'sk-1', { type: 'global' })
    upstreamHandler = (_req, res) => {
      res.writeHead(422, { 'content-type': 'application/json', 'set-cookie': 'svc=1', 'x-request-id': 'r-9' })
      res.end('{"error":"bad field"}')
    }
    const r = await call('POST', '/api/egress/SVC_KEY/items', asAgent('builder'), '{}')
    expect(r.status).toBe(422)
    expect(r.body.toString()).toBe('{"error":"bad field"}')
    expect(r.headers['x-request-id']).toBe('r-9')
    expect(r.headers['set-cookie']).toBeUndefined()
  })

  it('an upgrade (WebSocket) is refused — the owner gets a 400, an agent never opens one', async () => {
    signed('SVC_KEY', 'sk-1', { type: 'global' })
    const ws = { connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': randomBytes(16).toString('base64') }
    const port = new URL(silos).port
    const raw = (headers: Record<string, string>): Promise<string> =>
      new Promise((resolve) => {
        const sock = net.connect(Number(port), '127.0.0.1', () => {
          sock.write(
            `GET /api/egress/SVC_KEY/socket HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n${Object.entries(headers)
              .map(([k, v]) => `${k}: ${v}`)
              .join('\r\n')}\r\n\r\n`,
          )
        })
        let buf = ''
        sock.on('data', (d) => {
          buf += d.toString()
        })
        sock.on('close', () => resolve(buf))
        sock.on('error', () => resolve(buf))
        setTimeout(() => sock.destroy(), 1500)
      })
    const owner = await raw({ ...ws, 'x-token': TOKEN })
    expect(owner).not.toMatch(/^HTTP\/1\.1 101/)
    expect(owner).toMatch(/^HTTP\/1\.1 400/)
    expect(owner).toContain('never upgrades')
    const agent = await raw({ ...ws, authorization: `Bearer ${agentTokens.tokenFor('builder')}`, 'x-silos-turn': liveTurnOf(chat, 'builder') })
    expect(agent).toMatch(/^HTTP\/1\.1 403/)
    expect(seen).toHaveLength(0)
  })
})

describe('streaming and the idle cut', () => {
  it('the response streams: the first bytes reach the caller before the service ends', async () => {
    signed('SVC_KEY', 'sk-1', { type: 'global' })
    let finish: () => void = () => {}
    upstreamHandler = (_req, res) => {
      res.writeHead(200)
      res.write('first;')
      finish = () => res.end('last')
    }
    const u = new URL(silos)
    const body = await new Promise<string>((resolve, reject) => {
      const req = http.request({ hostname: u.hostname, port: u.port, path: '/api/egress/SVC_KEY/stream', headers: asAgent('builder'), agent: false }, (res) => {
        let text = ''
        res.on('data', (c: Buffer) => {
          text += c.toString()
          if (text === 'first;') finish()
        })
        res.on('end', () => resolve(text))
      })
      req.on('error', reject)
      req.end()
    })
    expect(body).toBe('first;last')
  })

  it('a long stream that keeps sending is never cut (inactivity, not duration)', async () => {
    signed('SVC_KEY', 'sk-1', { type: 'global' })
    upstreamHandler = (_req, res) => {
      res.writeHead(200)
      let n = 0
      const t = setInterval(() => {
        res.write(`${n};`)
        if (++n === 8) {
          clearInterval(t)
          res.end('end')
        }
      }, IDLE_MS / 3)
    }
    const r = await call('GET', '/api/egress/SVC_KEY/sync', asAgent('builder'))
    expect(r.status).toBe(200)
    expect(r.body.toString()).toBe('0;1;2;3;4;5;6;7;end')
  })

  it('a silent service is cut after the idle window — 504 and a row that says so', async () => {
    signed('SVC_KEY', 'sk-1', { type: 'global' })
    upstreamHandler = () => {
      /* never answers */
    }
    // (a stream that keeps sending is never cut — the test above — so the
    // cut is the idle window, not a duration)
    const r = await call('GET', '/api/egress/SVC_KEY/hang', asAgent('builder'))
    expect(r.status).toBe(504)
    const row = (await call('GET', '/api/vault/signed-calls', asOwner())).body
    expect(JSON.parse(row.toString()).rows[0]).toMatchObject({ status: 504, error: 'idle' })
  })

  it('an unreachable service is a 502, nothing hangs', async () => {
    const dead = http.createServer()
    const url = await listen(dead)
    await new Promise<void>((r) => dead.close(() => r()))
    signed('SVC_KEY', 'sk-1', { type: 'global' }, bind('X-Api-Key', '%s', url))
    const r = await call('GET', '/api/egress/SVC_KEY/x', asAgent('builder'))
    expect(r.status).toBe(502)
  })
})

describe("the log — one row per signed call, the owner's to read", () => {
  it('records agent, entry, method, host + path WITHOUT the query, status and duration — never the body', async () => {
    const e = signed('SVC_KEY', 'sk-secret-value', { type: 'global' }, bind('X-Api-Key', '%s', `${upstreamUrl}/v1`))
    upstreamHandler = (_req, res) => {
      res.writeHead(201)
      res.end('created-body')
    }
    await call('POST', '/api/egress/SVC_KEY/invoices?customer=c-42&api_key=zz', asAgent('builder'), 'request-body-secret')
    await call('GET', '/api/egress/SVC_KEY/invoices', asAgent('finance'))
    await call('GET', '/api/egress/NOPE_KEY/x', asAgent('finance')) // not signed: no call, no row
    const rows = JSON.parse((await call('GET', '/api/vault/signed-calls', asOwner())).body.toString()).rows
    expect(rows).toHaveLength(2)
    expect(rows[1]).toMatchObject({
      agent: 'builder',
      by: 'agent',
      entry: 'SVC_KEY',
      entryId: e.id,
      method: 'POST',
      host: upstreamUrl,
      path: '/v1/invoices',
      status: 201,
    })
    expect(typeof rows[1].ms).toBe('number')
    expect(typeof rows[1].at).toBe('string')
    const onDisk = readFileSync(join(dataDir, 'egress', 'signed.jsonl'), 'utf8')
    for (const never of ['c-42', 'api_key', 'request-body-secret', 'created-body', 'sk-secret-value']) expect(onDisk).not.toContain(never)
    const byAgent = JSON.parse((await call('GET', '/api/vault/signed-calls?agent=finance', asOwner())).body.toString()).rows
    expect(byAgent.map((r: { agent: string }) => r.agent)).toEqual(['finance'])
    const byEntry = JSON.parse((await call('GET', `/api/vault/signed-calls?entry=${e.id}&limit=1`, asOwner())).body.toString()).rows
    expect(byEntry).toHaveLength(1)
  })

  it("the read route is the owner's: an agent is refused, a local request without a token too", async () => {
    expect((await call('GET', '/api/vault/signed-calls', asAgent('builder'))).status).toBe(403)
    expect((await call('GET', '/api/vault/signed-calls')).status).toBe(401)
    expect((await call('GET', '/api/vault/signed-calls', asOwner())).status).toBe(200)
  })
})

describe('the Vault routes — binding in place, with the identity rule', () => {
  it('PATCH binds and unbinds; agents scope with an archived agent is refused by name; folder gives warnings', async () => {
    const e = vault.create({ name: 'SVC_KEY', value: 'sk-1', scope: { type: 'agents', agentIds: ['builder'] } })
    const json = { 'content-type': 'application/json' }
    const on = await call('PATCH', `/api/vault/${e.id}`, asOwner(json), JSON.stringify({ binding: bind() }))
    expect(on.status).toBe(200)
    expect(JSON.parse(on.body.toString()).entry.binding.baseUrl).toBe(upstreamUrl)
    expect(vault.envFor('builder', null)).toEqual({})
    const off = await call('PATCH', `/api/vault/${e.id}`, asOwner(json), JSON.stringify({ binding: null }))
    expect(off.status).toBe(200)
    expect(vault.envFor('builder', null)).toEqual({ SVC_KEY: 'sk-1' })
    registry.archive('finance')
    const refused = await call(
      'POST',
      '/api/vault',
      asOwner(json),
      JSON.stringify({ name: 'TEAM_KEY', value: 'v', scope: { type: 'agents', agentIds: ['builder', 'finance'] }, binding: bind() }),
    )
    expect(refused.status).toBe(400)
    expect(JSON.parse(refused.body.toString()).error).toMatch(/identity — finance has none/)
    const ok = await call(
      'POST',
      '/api/vault',
      asOwner(json),
      JSON.stringify({ name: 'TEAM_KEY', value: 'v', scope: { type: 'folder', folder: folderA }, binding: bind() }),
    )
    expect(ok.status).toBe(201)
    expect(JSON.parse(ok.body.toString()).warnings).toBeUndefined() // every live agent there holds its bearer
  })

  it('an agent binds what it wrote in its own scope and then signs with it', async () => {
    const json = { 'content-type': 'application/json' }
    const w = await call(
      'POST',
      '/api/agents/builder/vault',
      asAgent('builder', json),
      JSON.stringify({ name: 'MY_COOKIE', value: 'c-1', binding: bind('Cookie', 'session=%s'), turn: liveTurnOf(chat, 'builder') }),
    )
    expect(w.status).toBe(201)
    expect(vault.envFor('builder', null)).toEqual({})
    const r = await call('GET', '/api/egress/MY_COOKIE/me', asAgent('builder', { cookie: 'session=forged' }))
    expect(r.status).toBe(200)
    expect(seen[0]!.headers.cookie).toBe('session=c-1')
  })
})

describe('discovery — the brief names both classes', () => {
  it('delivered by name from the env; signed as a call through Silos', () => {
    const line = credentialsLine('Acme', [
      { name: 'ACME_TOKEN', signed: false },
      { name: 'ACME_API_KEY', signed: true },
      { name: 'OTHER_KEY', signed: true },
    ])
    expect(line).toContain('read ACME_TOKEN from your environment')
    expect(line).toContain('sign with ACME_API_KEY via ${SILOS_API:-http://127.0.0.1:3210}/api/egress/ACME_API_KEY/')
    expect(line).toContain('x-silos-turn: $SILOS_TURN')
    expect(line).not.toContain('OTHER_KEY')
  })
})
