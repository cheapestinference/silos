// auto-resume for interactive chats: the /api/agents/:id/chat route builds
// a durable record when an interactive turn hits a rate limit and does NOT
// continue via a fallback; the DELETE route cancels it; both notify over WS.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WebSocket from 'ws'
import type { FastifyInstance } from 'fastify'
import type { SessionIndex } from '../src/session-index.js'
import { claudeSessionIndex } from '../src/harnesses/claude-code/reader.js'
import { AgentRegistry, mungePath } from '../src/agent-registry.js'
import { SessionStore } from '../src/session-store.js'
import { NativeStore } from '../src/native-store.js'
import { ChatService } from '../src/chat-service.js'
import { ExecService } from '../src/exec-service.js'
import { CompleteService } from '../src/complete-service.js'
import { PrefsStore } from '../src/prefs-store.js'
import { MemoryService } from '../src/memory-service.js'
import { ProvidersStore } from '../src/providers-store.js'
import { PendingResumesStore } from '../src/pending-resumes-store.js'
import { buildServer } from '../src/server.js'
import type { QueryArgs, SdkMessage, SdkQueryHandle } from '../src/harnesses/claude-code/sdk-types.js'

const TOKEN = 't0k'

async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const t0 = Date.now()
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timeout waiting for the condition')
    await new Promise((r) => setTimeout(r, 25))
  }
}

const successScript = (sessionId: string): SdkMessage[] => [
  { type: 'system', subtype: 'init', session_id: sessionId },
  { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'ok' } } },
  { type: 'result', subtype: 'success', total_cost_usd: 0 },
]
const limitedScript = (sessionId: string, resetsAtMs: number): SdkMessage[] => [
  { type: 'system', subtype: 'init', session_id: sessionId },
  { type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: resetsAtMs, rateLimitType: 'five_hour' } } as unknown as SdkMessage,
  { type: 'result', subtype: 'error_during_execution', total_cost_usd: 0 },
]

let app: FastifyInstance, calls: QueryArgs[], index: SessionIndex, native: NativeStore, root: string, base: string
let pending: PendingResumesStore, providers: ProvidersStore, registry: AgentRegistry
let scripts: SdkMessage[][] // queue of scripts, one per call to queryFn
let folder: string, mf: string

beforeEach(async () => {
  base = mkdtempSync(join(tmpdir(), 'deck-prapi-'))
  root = join(base, 'projects')
  folder = mkdtempSync(join(tmpdir(), 'deck-folder-'))
  mkdirSync(join(base, 'data', 'trash'), { recursive: true })
  mkdirSync(root, { recursive: true })
  index = claudeSessionIndex(root, join(base, 'data', 'cache.json'))
  await index.init()
  registry = new AgentRegistry(join(base, 'data', 'agents.json'))
  registry.load()
  registry.create({ id: 'writer', name: 'Writer', folder })
  native = new NativeStore(join(base, 'data', 'native.json'))
  providers = new ProvidersStore(join(base, 'data'))
  providers.load()
  pending = new PendingResumesStore(join(base, 'data'))
  pending.load()
  calls = []
  scripts = []
  const chat = new ChatService({
    registry,
    native,
    providers,
    dataDir: join(base, 'data'),
    queryFn: (args) => {
      calls.push(args)
      const script = scripts.shift() ?? successScript('sess-9')
      return {
        async *[Symbol.asyncIterator]() {
          for (const m of script) yield m
        },
        async interrupt() {
          return { status: 'interrupted' }
        },
      } as SdkQueryHandle
    },
  })
  const exec = new ExecService(registry)
  const complete = new CompleteService(registry, index)
  const prefs = new PrefsStore(join(base, 'data'))
  const memory = new MemoryService(root, join(base, 'data'), registry)
  app = buildServer({
    index,
    registry,
    store: new SessionStore(root, join(base, 'data')),
    native,
    chat,
    exec,
    complete,
    prefs,
    memory,
    token: TOKEN,
    liveMs: 120_000,
    providers,
    pendingResumes: pending,
  })
  // a real native session in the index to resume into (resume append)
  mf = mungePath(folder)
  mkdirSync(join(root, mf), { recursive: true })
  writeFileSync(join(root, mf, 'sess.jsonl'), `{"type":"user","cwd":"${folder}","message":{"role":"user","content":"old"}}\n`)
  await index.refresh(mf, 'sess')
  native.register(mf, 'sess', { agentId: 'writer', createdAt: 'x' })
})
afterEach(async () => {
  await app.close()
})

async function sendChat(): Promise<void> {
  await app.inject({
    method: 'POST',
    url: '/api/agents/writer/chat',
    headers: { 'x-token': TOKEN },
    payload: { text: 'go-on', session: { folder: mf, id: 'sess' } },
  })
}

describe('auto-resume: POST /api/agents/:id/chat', () => {
  it('an interactive turn rejected by a rate limit (no fallback) -> builds a pending resume + WS pending-resume', async () => {
    await app.listen({ port: 0, host: '127.0.0.1' })
    const port = (app.server.address() as { port: number }).port
    const seen: any[] = []
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${TOKEN}`)
    ws.on('message', (d) => seen.push(JSON.parse(String(d))))
    await new Promise((r) => ws.once('open', r))

    const resetsAtMs = Date.now() + 4 * 3600_000
    scripts = [limitedScript('sess', resetsAtMs)]
    await sendChat()
    await until(() => pending.get(mf, 'sess') !== null)

    const rec = pending.get(mf, 'sess')!
    expect(rec.agentId).toBe('writer')
    expect(rec.text).toBe('go-on')
    expect(rec.resetsAt).toBe(new Date(resetsAtMs).toISOString())
    expect(rec.resumeAt).toBe(new Date(resetsAtMs).toISOString()) // no fallback: waits for the reset
    expect(rec.fallbackProviderId).toBeUndefined()

    await until(() => seen.some((m) => m.ev === 'pending-resume'))
    ws.close()
  })

  it('a successful turn (no rate limit) -> builds nothing', async () => {
    scripts = [successScript('sess')]
    await sendChat()
    await until(() => calls.length > 0)
    await new Promise((r) => setTimeout(r, 50))
    expect(pending.get(mf, 'sess')).toBeNull()
  })

  it('a storage failure while arming the resume is swallowed, never an unhandled rejection (would crash the process)', async () => {
    // Regression: the turn-completion runs in a fire-and-forget IIFE. If the
    // durable write throws (disk full / read-only volume) with no .catch, the
    // rejection is unhandled and Node 22 kills the whole server. Assert the
    // route still answers and no unhandledRejection escapes.
    const rejections: unknown[] = []
    const onRej = (e: unknown): void => {
      rejections.push(e)
    }
    process.on('unhandledRejection', onRej)
    try {
      pending.upsert = () => {
        throw new Error('ENOSPC: no space left on device')
      }
      scripts = [limitedScript('sess', Date.now() + 4 * 3600_000)]
      const res = await app.inject({
        method: 'POST',
        url: '/api/agents/writer/chat',
        headers: { 'x-token': TOKEN },
        payload: { text: 'go-on', session: { folder: mf, id: 'sess' } },
      })
      expect(res.statusCode).toBe(202) // the route answered; arming runs async afterwards
      await new Promise((r) => setTimeout(r, 150)) // let the IIFE run and reject internally
      expect(rejections).toHaveLength(0) // .catch swallowed it — the process lives
      expect(pending.get(mf, 'sess')).toBeNull() // nothing persisted, as expected
    } finally {
      process.off('unhandledRejection', onRej)
    }
  })

  it('a fallback that DOES work -> the conversation continues there, NO pending resume gets built', async () => {
    // the agent has a fallback chain to a key-based provider
    const keyId = providers.create({ label: 'ci', baseUrl: 'https://api.ci.test/anthropic', apiKey: 'sk-ci-abcdef123456' }).id
    registry.update('writer', { fallback: [keyId] })
    // 1st call (primary) is limited -> triggers the fallback; 2nd (fallback) succeeds
    scripts = [limitedScript('sess', Date.now() + 3 * 3600_000), successScript('sess')]
    await sendChat()
    await until(() => calls.length >= 2) // primary + fallback retry
    await new Promise((r) => setTimeout(r, 50))
    expect(pending.get(mf, 'sess')).toBeNull() // continued on the fallback: no pending resume
  })
})

describe('auto-resume: GET/DELETE /api/pending-resumes', () => {
  it('GET lists the records; DELETE cancels and notifies over WS; DELETE of a nonexistent one -> 404', async () => {
    await app.listen({ port: 0, host: '127.0.0.1' })
    const port = (app.server.address() as { port: number }).port
    const seen: any[] = []
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${TOKEN}`)
    ws.on('message', (d) => seen.push(JSON.parse(String(d))))
    await new Promise((r) => ws.once('open', r))

    scripts = [limitedScript('sess', Date.now() + 2 * 3600_000)]
    await sendChat()
    await until(() => pending.get(mf, 'sess') !== null)

    const list = await app.inject({ method: 'GET', url: '/api/pending-resumes', headers: { 'x-token': TOKEN } })
    expect(list.statusCode).toBe(200)
    expect(list.json().pending).toHaveLength(1)

    const del = await app.inject({ method: 'DELETE', url: `/api/pending-resumes/${mf}/sess`, headers: { 'x-token': TOKEN } })
    expect(del.statusCode).toBe(200)
    expect(pending.get(mf, 'sess')).toBeNull()
    await until(() => seen.some((m) => m.ev === 'pending-resume-removed' && m.folder === mf && m.id === 'sess'))

    const del2 = await app.inject({ method: 'DELETE', url: `/api/pending-resumes/${mf}/sess`, headers: { 'x-token': TOKEN } })
    expect(del2.statusCode).toBe(404)
    ws.close()
  })
})
