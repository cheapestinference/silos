import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
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
import { FileService, INLINE_CAP } from '../src/file-service.js'
import { buildServer } from '../src/server.js'

// a LOCAL request (loopback Host, no forwarding headers) does NOT require a
// token — to exercise the guard we have to look REMOTE (public host).
const REMOTE = { host: 'silos.example.com' }

let app: FastifyInstance
let base: string, proj: string, dataDir: string
const TOKEN = 'testtoken'

beforeEach(async () => {
  base = mkdtempSync(join(tmpdir(), 'deck-file-api-'))
  const root = join(base, 'projects')
  dataDir = join(base, 'data')
  proj = join(base, 'proj')
  mkdirSync(root, { recursive: true })
  mkdirSync(join(dataDir, 'trash'), { recursive: true })
  mkdirSync(proj, { recursive: true })

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
  const files = new FileService(dataDir)
  app = buildServer({ index, registry, store, native, chat, exec, complete, prefs, memory, files, token: TOKEN, liveMs: 120_000 })
})

const get = (url: string) => app.inject({ url, headers: { 'x-token': TOKEN } })
const put = (url: string, payload: unknown) => app.inject({ method: 'PUT', url, headers: { 'x-token': TOKEN }, payload })
const q = (p: string) => encodeURIComponent(p)

describe('GET /api/file (metadata)', () => {
  it('reads metadata for a markdown file', async () => {
    const p = join(proj, 'note.md')
    writeFileSync(p, '# hi\n')
    const res = await get(`/api/file?path=${q(p)}`)
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.kind).toBe('markdown')
    expect(body.editable).toBe(true)
    expect(body.name).toBe('note.md')
  })

  it('an ARBITRARY absolute path (outside any session) is readable once authenticated', async () => {
    const outside = join(base, 'loose.md')
    writeFileSync(outside, '# free\n')
    const res = await get(`/api/file?path=${q(outside)}`)
    expect(res.statusCode).toBe(200)
    expect(res.json().kind).toBe('markdown')
  })

  it('a relative path -> 400', async () => {
    expect((await get(`/api/file?path=${q('rel/x.md')}`)).statusCode).toBe(400)
  })

  it('a nonexistent file -> 404', async () => {
    expect((await get(`/api/file?path=${q(join(proj, 'no.md'))}`)).statusCode).toBe(404)
  })

  it('no path -> 400', async () => {
    expect((await get('/api/file')).statusCode).toBe(400)
  })

  it('a REMOTE request with no token -> 401', async () => {
    const p = join(proj, 'note.md')
    writeFileSync(p, 'x')
    const res = await app.inject({ url: `/api/file?path=${q(p)}`, headers: REMOTE })
    expect(res.statusCode).toBe(401)
  })
})

describe('GET /api/dir (explorer)', () => {
  // the Files page roots at the home /api/overview reports: with a configured
  // home (SILOS_HOME → deps.home — the e2e harness) both come from it, never
  // from the OS home, or a fixture server shows the machine's real home
  it('a configured home is the home reported to the web and the one listed', async () => {
    const home = join(base, 'home')
    mkdirSync(join(home, 'fixture-dir'), { recursive: true })
    writeFileSync(join(home, 'fixture.txt'), 'x')
    const index = claudeSessionIndex(join(base, 'projects'), join(dataDir, 'cache2.json'))
    await index.init()
    const registry = new AgentRegistry(join(dataDir, 'agents.json'))
    registry.load()
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
    const homed = buildServer({
      index,
      registry,
      store: new SessionStore(join(base, 'projects'), dataDir),
      native,
      chat,
      exec: new ExecService(registry),
      complete: new CompleteService(registry, index),
      prefs: new PrefsStore(dataDir),
      memory: new MemoryService(join(base, 'projects'), dataDir, registry),
      files: new FileService(dataDir),
      token: TOKEN,
      liveMs: 120_000,
      home,
      dataDir,
    })
    const overview = await homed.inject({ url: '/api/overview', headers: { 'x-token': TOKEN } })
    expect(overview.statusCode).toBe(200)
    const reported = overview.json().home
    expect(reported).toBe(home)
    expect(reported).not.toBe(homedir())
    const listing = await homed.inject({ url: `/api/dir?path=${q(reported)}`, headers: { 'x-token': TOKEN } })
    expect(listing.statusCode).toBe(200)
    expect(listing.json().entries.map((e: { name: string }) => e.name)).toEqual(['fixture-dir', 'fixture.txt'])
    await homed.close()
  })

  it('lists a folder: subfolders first, then files', async () => {
    writeFileSync(join(proj, 'z.txt'), 'x')
    writeFileSync(join(proj, 'a.md'), '# a')
    mkdirSync(join(proj, 'sub'))
    const res = await get(`/api/dir?path=${q(proj)}`)
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.entries[0]).toMatchObject({ name: 'sub', type: 'dir' })
    const names = body.entries.map((e: { name: string }) => e.name)
    expect(names).toEqual(['sub', 'a.md', 'z.txt'])
  })

  it('a file (not a folder) -> 400', async () => {
    const p = join(proj, 'f.txt')
    writeFileSync(p, 'x')
    expect((await get(`/api/dir?path=${q(p)}`)).statusCode).toBe(400)
  })

  it('a nonexistent folder -> 404', async () => {
    expect((await get(`/api/dir?path=${q(join(proj, 'nope'))}`)).statusCode).toBe(404)
  })

  // A probe by convention (e.g. the team-plan strip looking for plans/) must
  // not paint a red 404 in the browser console on every conversation without
  // that folder: ?optional=1 answers 200 + empty listing when it's missing.
  it('?optional=1 → 200 with an empty listing when the folder does not exist', async () => {
    const res = await get(`/api/dir?path=${q(join(proj, 'nope'))}&optional=1`)
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ path: join(proj, 'nope'), entries: [] })
  })

  it('?optional=1 does not hide other errors (a file is still "not a folder")', async () => {
    writeFileSync(join(proj, 'f.txt'), 'x')
    expect((await get(`/api/dir?path=${q(join(proj, 'f.txt'))}&optional=1`)).statusCode).toBe(400)
  })

  it('REMOTE with no token -> 401', async () => {
    expect((await app.inject({ url: `/api/dir?path=${q(proj)}`, headers: REMOTE })).statusCode).toBe(401)
  })
})

describe('GET /api/file/raw (bytes)', () => {
  it('serves the inline content of a text file', async () => {
    const p = join(proj, 'app.ts')
    writeFileSync(p, 'const x = 1\n')
    const res = await get(`/api/file/raw?path=${q(p)}`)
    expect(res.statusCode).toBe(200)
    expect(res.body).toBe('const x = 1\n')
    expect(res.headers['x-content-type-options']).toBe('nosniff')
    expect(res.headers['content-type']).toContain('text/plain')
  })

  it('text above the inline cap -> 413', async () => {
    const p = join(proj, 'big.txt')
    writeFileSync(p, 'x'.repeat(INLINE_CAP + 1))
    expect((await get(`/api/file/raw?path=${q(p)}`)).statusCode).toBe(413)
  })

  it('the same large file DOES download (?download=1)', async () => {
    const p = join(proj, 'big.txt')
    writeFileSync(p, 'x'.repeat(INLINE_CAP + 1))
    const res = await get(`/api/file/raw?path=${q(p)}&download=1`)
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-disposition']).toContain('attachment')
    expect(res.headers['content-type']).toBe('application/octet-stream')
  })

  it('a large image is served inline (the text cap does not apply)', async () => {
    const p = join(proj, 'photo.png')
    writeFileSync(p, Buffer.alloc(INLINE_CAP + 500))
    const res = await get(`/api/file/raw?path=${q(p)}`)
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toBe('image/png')
  })

  it('REMOTE with no token -> 401', async () => {
    const p = join(proj, 'app.ts')
    writeFileSync(p, 'x')
    expect((await app.inject({ url: `/api/file/raw?path=${q(p)}`, headers: REMOTE })).statusCode).toBe(401)
  })

  // an SVG served inline on the same origin is XSS via direct navigation —
  // a sandboxed CSP neutralizes it without breaking the <img> use case.
  it('an inline SVG carries a sandboxed CSP (anti-XSS for direct navigation)', async () => {
    const p = join(proj, 'icon.svg')
    writeFileSync(p, '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')
    const res = await get(`/api/file/raw?path=${q(p)}`)
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-security-policy']).toContain('sandbox')
  })

  it('a raster image (png) carries NO sandboxed CSP (not scriptable)', async () => {
    const p = join(proj, 'photo2.png')
    writeFileSync(p, Buffer.alloc(64))
    const res = await get(`/api/file/raw?path=${q(p)}`)
    expect(res.headers['content-security-policy']).toBeUndefined()
  })
})

describe('PUT /api/file (save)', () => {
  it('writes markdown, makes a backup and reflects it', async () => {
    const p = join(proj, 'doc.md')
    writeFileSync(p, '# v1\n')
    const res = await put('/api/file', { path: p, content: '# v2\n' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.ok).toBe(true)
    expect(existsSync(body.backup)).toBe(true)
    expect(readFileSync(p, 'utf8')).toBe('# v2\n')
    expect(readFileSync(body.backup, 'utf8')).toBe('# v1\n')
  })

  it('rejects saving over a binary file -> 400 and leaves it untouched', async () => {
    const p = join(proj, 'doc.pdf')
    writeFileSync(p, '%PDF-1.4\n')
    const res = await put('/api/file', { path: p, content: 'garbage' })
    expect(res.statusCode).toBe(400)
    expect(readFileSync(p, 'utf8')).toBe('%PDF-1.4\n')
  })

  it('an incomplete body -> 400', async () => {
    const p = join(proj, 'doc.md')
    writeFileSync(p, 'a\n')
    expect((await put('/api/file', { path: p })).statusCode).toBe(400)
    expect((await put('/api/file', { content: 'x' })).statusCode).toBe(400)
  })

  it('REMOTE with no token -> 401 and nothing gets written', async () => {
    const p = join(proj, 'doc.md')
    writeFileSync(p, '# v1\n')
    const res = await app.inject({ method: 'PUT', url: '/api/file', headers: REMOTE, payload: { path: p, content: '# hacked\n' } })
    expect(res.statusCode).toBe(401)
    expect(readFileSync(p, 'utf8')).toBe('# v1\n')
  })
})
