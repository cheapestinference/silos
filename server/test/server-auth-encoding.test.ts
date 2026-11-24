// The auth hook decides on the DECODED request path: Fastify routes
// `/%61pi/agents` to `/api/agents`, so a check on the raw url let a remote
// request with no token read and write the API (and open websockets) by
// encoding one character. Remote = forwarding header + non-loopback host.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WebSocket from 'ws'
import { connect } from 'node:net'
import { AgentTokens } from '../src/agent-tokens.js'
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

const TOKEN = 'static-t0k'
const LOCAL = { host: '127.0.0.1:3210' }
const REMOTE = { host: 'silos.example.com', 'cf-connecting-ip': '1.2.3.4' }
let app: FastifyInstance, registry: AgentRegistry, agentTokens: AgentTokens

beforeEach(async () => {
  const base = mkdtempSync(join(tmpdir(), 'deck-enc-'))
  const root = join(base, 'projects')
  const folder = mkdtempSync(join(tmpdir(), 'deck-enc-folder-'))
  mkdirSync(join(base, 'data', 'trash'), { recursive: true })
  mkdirSync(root, { recursive: true })
  const index = claudeSessionIndex(root, join(base, 'data', 'cache.json'))
  await index.init()
  registry = new AgentRegistry(join(base, 'data', 'agents.json'))
  registry.load()
  registry.create({ id: 'finance', name: 'Finance', folder })
  agentTokens = new AgentTokens(join(base, 'data'))
  const native = new NativeStore(join(base, 'data', 'native.json'))
  const chat = new ChatService({
    registry,
    native,
    queryFn: () => {
      throw new Error('no sdk')
    },
  })
  app = buildServer({
    index,
    registry,
    native,
    chat,
    store: new SessionStore(root, join(base, 'data')),
    exec: new ExecService(registry),
    complete: new CompleteService(registry, index),
    prefs: new PrefsStore(join(base, 'data')),
    memory: new MemoryService(root, join(base, 'data'), registry),
    token: TOKEN,
    liveMs: 120_000,
    agentTokens,
  })
})
afterEach(async () => {
  await app.close()
})

describe('auth on the decoded path', () => {
  it('remote GET /%61pi/agents with no token → 401', async () => {
    const r = await app.inject({ method: 'GET', url: '/%61pi/agents', headers: REMOTE })
    expect(r.statusCode).toBe(401)
  })

  it('remote PATCH /%61pi/agents/finance with no token → 401 and the agent is unchanged', async () => {
    const r = await app.inject({ method: 'PATCH', url: '/%61pi/agents/finance', headers: REMOTE, payload: { name: 'Pwned' } })
    expect(r.statusCode).toBe(401)
    expect(registry.get('finance')?.name).toBe('Finance')
  })

  it('remote: an encoded later segment is judged the same (/api/%61gents)', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/%61gents', headers: REMOTE })).statusCode).toBe(401)
  })

  it('remote GET /api/agents?token=<static> → 200 (unchanged)', async () => {
    const r = await app.inject({ method: 'GET', url: `/api/agents?token=${TOKEN}`, headers: REMOTE })
    expect(r.statusCode).toBe(200)
  })

  // Fastify's router already answers 400 to an undecodable url before any
  // hook runs; the hook's own 401 'malformed path' is the backstop should
  // that ever change. Either way nothing is served.
  it('a malformed segment is refused (400 from the router, or 401 from the hook), local or remote', async () => {
    for (const headers of [LOCAL, REMOTE]) {
      for (const url of ['/api/%zz', '/%zz/agents', '/ws/%E0%A4%A']) {
        const r = await app.inject({ method: 'GET', url, headers })
        expect([400, 401]).toContain(r.statusCode)
      }
    }
  })

  it('owner on loopback GET /%61pi/agents → 200 (local no-token is still the owner)', async () => {
    const r = await app.inject({ method: 'GET', url: '/%61pi/agents', headers: LOCAL })
    expect(r.statusCode).toBe(200)
  })

  it('remote websocket upgrade on /%77s without a token is destroyed (no 101)', async () => {
    await app.listen({ port: 0, host: '127.0.0.1' })
    const port = (app.server.address() as { port: number }).port
    const ws = new WebSocket(`ws://127.0.0.1:${port}/%77s`, { headers: REMOTE })
    const opened = await new Promise<boolean>((resolve) => {
      ws.once('open', () => resolve(true))
      ws.once('error', () => resolve(false))
      ws.once('unexpected-response', () => resolve(false))
    })
    expect(opened).toBe(false)
    ws.terminate()
  })
})

// find-my-way rewrites an absolute-form target (`GET http://x/api/agents`)
// to `/api/agents`, but the hook's path came from req.url and read
// `http%3A//x/...` as "not /api" — auth skipped. Only a raw socket can send
// that request line (inject and fetch normalize it away).
describe('absolute-form request targets', () => {
  const raw = async (lines: string[]): Promise<string> => {
    await app.listen({ port: 0, host: '127.0.0.1' })
    const port = (app.server.address() as { port: number }).port
    return new Promise<string>((resolve, reject) => {
      const sock = connect(port, '127.0.0.1', () => sock.write(`${lines.join('\r\n')}\r\n\r\n`))
      let buf = ''
      sock.on('data', (d) => {
        buf += d.toString()
      })
      sock.on('end', () => resolve(buf))
      sock.on('close', () => resolve(buf))
      sock.on('error', reject)
    })
  }

  it('remote GET http://x/api/agents with no token → 400, nothing served', async () => {
    const res = await raw(['GET http://x/api/agents HTTP/1.1', 'Host: silos.example.com', 'CF-Connecting-IP: 1.2.3.4', 'Connection: close'])
    expect(res.split('\r\n')[0]).toMatch(/^HTTP\/1\.1 400/)
    expect(res).not.toContain('"finance"')
  })

  it('with a valid agent bearer it is still 400', async () => {
    const bearer = agentTokens.tokenFor('finance')
    const res = await raw([
      'GET http://x/api/agents HTTP/1.1',
      'Host: silos.example.com',
      'CF-Connecting-IP: 1.2.3.4',
      `Authorization: Bearer ${bearer}`,
      'Connection: close',
    ])
    expect(res.split('\r\n')[0]).toMatch(/^HTTP\/1\.1 400/)
  })

  it('a websocket upgrade with an absolute-form target is refused 400 at the socket', async () => {
    const res = await raw([
      'GET http://x/ws HTTP/1.1',
      'Host: silos.example.com',
      'CF-Connecting-IP: 1.2.3.4',
      'Upgrade: websocket',
      'Connection: Upgrade',
      'Sec-WebSocket-Version: 13',
      'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
    ])
    expect(res.split('\r\n')[0]).toMatch(/^HTTP\/1\.1 400/)
  })
})

// The two hotfixes (4c21c75 encoded path, cb59ea2 absolute-form target) on a
// MUTATING route, over the real HTTP stack: a raw socket sends the exact
// request line and body (inject and fetch normalize the target away). Every
// refused PATCH must leave the agent unchanged; the controls prove the same
// raw request DOES write when it is allowed.
describe('PATCH over a raw socket', () => {
  const patch = async (target: string, headers: string[], body: object = { name: 'Pwned' }): Promise<{ status: number; text: string }> => {
    if (!app.server.listening) await app.listen({ port: 0, host: '127.0.0.1' })
    const port = (app.server.address() as { port: number }).port
    const json = JSON.stringify(body)
    const head = [`PATCH ${target} HTTP/1.1`, ...headers, 'Content-Type: application/json', `Content-Length: ${Buffer.byteLength(json)}`, 'Connection: close']
    const text = await new Promise<string>((resolve, reject) => {
      const sock = connect(port, '127.0.0.1', () => sock.write(`${head.join('\r\n')}\r\n\r\n${json}`))
      let buf = ''
      sock.on('data', (d) => {
        buf += d.toString()
      })
      sock.on('end', () => resolve(buf))
      sock.on('close', () => resolve(buf))
      sock.on('error', reject)
    })
    const m = /^HTTP\/1\.1 (\d{3})/.exec(text)
    return { status: m ? Number(m[1]) : 0, text }
  }
  const REMOTE_H = ['Host: silos.example.com', 'CF-Connecting-IP: 1.2.3.4']
  const LOCAL_H = ['Host: 127.0.0.1:3210']
  const unchanged = () => expect(registry.get('finance')?.name).toBe('Finance')

  it('remote absolute-form PATCH http://x/api/agents/finance, no token → 400, unchanged', async () => {
    expect((await patch('http://x/api/agents/finance', REMOTE_H)).status).toBe(400)
    unchanged()
  })

  it('absolute-form PATCH with a valid agent bearer → 400, unchanged', async () => {
    const bearer = agentTokens.tokenFor('finance')
    expect((await patch('http://x/api/agents/finance', [...REMOTE_H, `Authorization: Bearer ${bearer}`])).status).toBe(400)
    unchanged()
  })

  it('absolute-form PATCH with the static ?token= → still 400 (origin-form only), unchanged', async () => {
    expect((await patch(`http://x/api/agents/finance?token=${TOKEN}`, REMOTE_H)).status).toBe(400)
    unchanged()
  })

  it('absolute-form PATCH from loopback with no forwarding headers → 400, unchanged', async () => {
    expect((await patch('http://127.0.0.1:3210/api/agents/finance', LOCAL_H)).status).toBe(400)
    unchanged()
  })

  it('remote PATCH with an encoded segment (/%61pi/agents/finance, /api/%61gents/finance, /api/agents/%66inance), no token → 401, unchanged', async () => {
    for (const target of ['/%61pi/agents/finance', '/api/%61gents/finance', '/api/agents/%66inance', '/%61%70%69/agents/finance']) {
      expect([target, (await patch(target, REMOTE_H)).status]).toEqual([target, 401])
    }
    unchanged()
  })

  it('an agent bearer PATCHing an agent through an encoded path → 403 (agents never edit agents), unchanged', async () => {
    const bearer = agentTokens.tokenFor('finance')
    const r = await patch('/%61pi/agents/finance', [...LOCAL_H, `Authorization: Bearer ${bearer}`])
    expect(r.status).toBe(403)
    expect(r.text).toContain('may not PATCH')
    unchanged()
  })

  it('a malformed segment in a PATCH target is refused (400/401), unchanged', async () => {
    expect([400, 401]).toContain((await patch('/api/agents/%zz', REMOTE_H)).status)
    unchanged()
  })

  it('control: the owner on loopback writes through the same raw PATCH (encoded or not)', async () => {
    expect((await patch('/%61pi/agents/finance', [...LOCAL_H, `x-token: ${TOKEN}`], { name: 'Renamed' })).status).toBe(200)
    expect(registry.get('finance')?.name).toBe('Renamed')
  })

  it('loopback with NO identity: an encoded PATCH is a 401 like any other local write, unchanged', async () => {
    for (const target of ['/%61pi/agents/finance', '/api/agents/finance']) {
      expect([target, (await patch(target, LOCAL_H, { name: 'Nobody' })).status]).toEqual([target, 401])
    }
    unchanged()
  })

  it('control: remote with the static ?token= on an origin-form encoded target writes', async () => {
    expect((await patch(`/%61pi/agents/finance?token=${TOKEN}`, REMOTE_H, { name: 'Remote' })).status).toBe(200)
    expect(registry.get('finance')?.name).toBe('Remote')
  })
})
