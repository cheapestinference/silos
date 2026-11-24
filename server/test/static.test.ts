import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
import { buildServer, type ServerDeps } from '../src/server.js'

// a genuinely LOCAL request (loopback Host, no forwarding/tunnel headers)
// no longer requires a token — see isLocalRequest in server.ts. These 401
// assertions must look REMOTE (public host) so they keep exercising the
// guard without weakening it.
const REMOTE = { host: 'silos.example.com' }

const TOKEN = 'testtoken'

async function deps(base: string): Promise<Omit<ServerDeps, 'webDist'>> {
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
  const exec = new ExecService(registry)
  const complete = new CompleteService(registry, index)
  const prefs = new PrefsStore(dataDir)
  const memory = new MemoryService(root, dataDir, registry)
  return { index, registry, store, native, chat, exec, complete, prefs, memory, token: TOKEN, liveMs: 120_000 }
}

describe('static SPA', () => {
  let app: FastifyInstance
  afterEach(async () => {
    await app?.close()
  })

  it('serves index.html at / and at unknown routes; /api stays API-only', async () => {
    const base = mkdtempSync(join(tmpdir(), 'deck-'))
    const webDist = join(base, 'dist')
    mkdirSync(webDist, { recursive: true })
    writeFileSync(join(webDist, 'index.html'), '<!doctype html><title>Silos</title>')
    app = buildServer({ ...(await deps(base)), webDist })
    const home = await app.inject({ url: '/' })
    expect(home.statusCode).toBe(200)
    expect(home.body).toContain('Silos')
    const spa = await app.inject({ url: '/any/path' })
    expect(spa.statusCode).toBe(200)
    expect(spa.body).toContain('Silos')
    // a deep-link with SEVERAL segments (a conversation) must also fall
    // through to the SPA — a browser refreshing at /agent/x/c/f/s has to
    // get index.html, not a 404, so the client router can restore state.
    // this covers the multi-segment case, which '/any/path' (a
    // single level) didn't exercise.
    const deep = await app.inject({ url: '/agent/master/c/%2Fhome%2Fx/s9/memory' })
    expect(deep.statusCode).toBe(200)
    expect(deep.body).toContain('Silos')
    const api = await app.inject({ url: '/api/overview', headers: REMOTE }) // no token, remote host
    expect(api.statusCode).toBe(401)
  })

  it('with NO web/dist built yet, a page GET returns a 503 that says to run npm run build', async () => {
    const base = mkdtempSync(join(tmpdir(), 'deck-'))
    // webDist points at a path that does not exist (never built)
    app = buildServer({ ...(await deps(base)), webDist: join(base, 'dist') })
    const home = await app.inject({ url: '/' })
    expect(home.statusCode).toBe(503)
    expect(home.headers['content-type']).toContain('text/html')
    expect(home.body).toContain('npm run build')
    // /api still behaves as an API (not the HTML landing)
    const api = await app.inject({ url: '/api/overview', headers: REMOTE })
    expect(api.statusCode).toBe(401)
  })

  // regression guard: with wildcard:false, assets used to get fixed at
  // boot time, so a later build (new hash) fell through to the SPA
  // fallback — HTML with a 200 where the browser expects JS, hence a
  // blank page. The lookup must happen per-request: a file created AFTER
  // the server was built gets served with its real content and MIME type,
  // no restart needed.
  it('an asset created after boot gets served (build without restarting)', async () => {
    const base = mkdtempSync(join(tmpdir(), 'deck-'))
    const webDist = join(base, 'dist')
    mkdirSync(join(webDist, 'assets'), { recursive: true })
    writeFileSync(join(webDist, 'index.html'), '<!doctype html><title>Silos</title>')
    app = buildServer({ ...(await deps(base)), webDist })
    // the server is already built — now "a new build lands"
    writeFileSync(join(webDist, 'assets', 'index-NEW123.js'), 'console.log("new bundle")')
    const asset = await app.inject({ url: '/assets/index-NEW123.js' })
    expect(asset.statusCode).toBe(200)
    expect(asset.headers['content-type']).toContain('javascript')
    expect(asset.body).toContain('new bundle')
  })

  // the stale-tab banner's server half: the overview announces the build id
  // found in dist/build-id.json, re-read per request — same per-request
  // philosophy as the assets above: a new build lands under a running
  // server, no restart.
  it('the overview announces the served build id, fresh on every request', async () => {
    const base = mkdtempSync(join(tmpdir(), 'deck-'))
    const webDist = join(base, 'dist')
    mkdirSync(webDist, { recursive: true })
    writeFileSync(join(webDist, 'index.html'), '<!doctype html><title>Silos</title>')
    writeFileSync(join(webDist, 'build-id.json'), JSON.stringify({ id: 'b1' }))
    app = buildServer({ ...(await deps(base)), webDist })
    expect((await app.inject({ url: '/api/overview' })).json().build).toBe('b1')
    writeFileSync(join(webDist, 'build-id.json'), JSON.stringify({ id: 'b2' }))
    expect((await app.inject({ url: '/api/overview' })).json().build).toBe('b2')
  })

  it('without build-id.json (or without webDist) the overview omits build', async () => {
    const base = mkdtempSync(join(tmpdir(), 'deck-'))
    const webDist = join(base, 'dist')
    mkdirSync(webDist, { recursive: true })
    writeFileSync(join(webDist, 'index.html'), '<!doctype html><title>Silos</title>')
    app = buildServer({ ...(await deps(base)), webDist })
    expect((await app.inject({ url: '/api/overview' })).json()).not.toHaveProperty('build')
  })

  it('with webDist entirely unset, a page GET serves the same build-required 503 landing', async () => {
    const base = mkdtempSync(join(tmpdir(), 'deck-'))
    app = buildServer(await deps(base)) // no webDist at all
    const res = await app.inject({ url: '/' })
    expect(res.statusCode).toBe(503)
    expect(res.body).toContain('npm run build')
  })
})

// The PWA manifest is a static file like any other, but Chrome refuses to
// install the app unless it arrives as application/manifest+json — and it
// is fetched by the browser BEFORE any login (remote visitors must still
// be able to install). Pins both: the MIME and the no-auth path.
describe('static PWA manifest', () => {
  let app: FastifyInstance
  afterEach(async () => {
    await app?.close()
  })

  it('serves /manifest.webmanifest with the manifest MIME, without auth even for a remote host', async () => {
    const base = mkdtempSync(join(tmpdir(), 'deck-'))
    const webDist = join(base, 'dist')
    mkdirSync(webDist, { recursive: true })
    writeFileSync(join(webDist, 'index.html'), '<!doctype html><title>Silos</title>')
    writeFileSync(join(webDist, 'manifest.webmanifest'), '{"name":"Silos","display":"standalone"}')
    app = buildServer({ ...(await deps(base)), webDist })
    const res = await app.inject({ url: '/manifest.webmanifest', headers: REMOTE })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('application/manifest+json')
    expect(JSON.parse(res.body).display).toBe('standalone')
  })
})
