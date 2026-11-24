// started-with-api.test.ts — the Started with routes:
// GET /api/sessions/:folder/:id/started-with (one conversation, measured
// from its transcript by its engine), …/started-with/part/:key (a part's
// exact text) and GET /api/agents/:id/started-with (per mode: console ·
// chat · run, medians over the last 10 measured of each).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync, appendFileSync, readFileSync, readdirSync, copyFileSync } from 'node:fs'
import { TranscriptStartedWith } from '../src/harnesses/claude-code/started-with.js'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { claudeSessionIndex } from '../src/harnesses/claude-code/reader.js'
import { AgentRegistry, mungePath } from '../src/agent-registry.js'
import { SessionStore } from '../src/session-store.js'
import { NativeStore } from '../src/native-store.js'
import { ChatService } from '../src/chat-service.js'
import { ExecService } from '../src/exec-service.js'
import { CompleteService } from '../src/complete-service.js'
import { PrefsStore } from '../src/prefs-store.js'
import { MemoryService } from '../src/memory-service.js'
import { AgentTokens } from '../src/agent-tokens.js'
import { AgentStateStore } from '../src/agent-state.js'
import { SessionOriginsStore } from '../src/session-origins.js'
import { harnesses } from '../src/harnesses/index.js'
import { buildServer } from '../src/server.js'

const LOCAL = { host: '127.0.0.1:3210' }
const OWNER = { ...LOCAL, 'x-token': 't0k' }
let app: FastifyInstance, tokens: AgentTokens, folder: string, dir: string, munged: string, index: ReturnType<typeof claudeSessionIndex>

const L = (o: unknown): string => `${JSON.stringify(o)}\n`

function transcript(id: string, o: { entry: string; total: number; shape?: boolean; first?: string; ageMin: number }): void {
  const base = { cwd: folder, sessionId: id, entrypoint: o.entry }
  const t = (s: number): string => new Date(Date.parse('2026-11-01T10:00:00.000Z') + s * 1000).toISOString()
  const text =
    L({
      ...base,
      type: 'attachment',
      timestamp: t(0),
      attachment: { type: 'instructions', files: [{ path: `${folder}/CLAUDE.md`, type: 'Project', content: 'P'.repeat(300) }] },
    }) +
    L({
      ...base,
      type: 'attachment',
      timestamp: t(0),
      attachment: { type: 'session_context', context: { userEmail: "The user's email address is me@example.test. Use it." } },
    }) +
    L({ ...base, type: 'user', timestamp: t(1), message: { role: 'user', content: o.first ?? 'hello there' } }) +
    (o.shape === false
      ? ''
      : L({
          type: 'api-request-shape',
          timestamp: t(1),
          shape: { system: [{ type: 'text', text: 'E'.repeat(400) }], tools: [{ name: 'Read', description: 'r'.repeat(200) }] },
        })) +
    L({
      ...base,
      type: 'assistant',
      timestamp: t(2),
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'ok' }],
        usage: { input_tokens: 1, cache_creation_input_tokens: o.total - 1, cache_read_input_tokens: 0 },
      },
    })
  const file = join(dir, `${id}.jsonl`)
  writeFileSync(file, text)
  const when = (Date.now() - o.ageMin * 60_000) / 1000
  utimesSync(file, when, when)
}

beforeEach(async () => {
  const base = mkdtempSync(join(tmpdir(), 'started-api-'))
  const home = join(base, 'home')
  folder = join(base, 'proj')
  const root = join(home, '.claude', 'projects')
  const dataDir = join(base, 'data')
  mkdirSync(join(dataDir, 'trash'), { recursive: true })
  mkdirSync(folder, { recursive: true })
  munged = mungePath(folder)
  dir = join(root, munged)
  mkdirSync(dir, { recursive: true })
  transcript('c1', { entry: 'cli', total: 1000, ageMin: 1 })
  transcript('c2', { entry: 'cli', total: 3000, ageMin: 2 })
  transcript('c3', { entry: 'cli', total: 2000, ageMin: 3 })
  transcript('h1', { entry: 'sdk-ts', total: 600, ageMin: 4 })
  transcript('r1', { entry: 'sdk-ts', total: 400, ageMin: 5 })
  transcript('u1', { entry: 'cli', total: 900, shape: false, ageMin: 6 })
  index = claudeSessionIndex(root, join(dataDir, 'cache.json'))
  await index.init()
  const registry = new AgentRegistry(join(dataDir, 'agents.json'))
  registry.load()
  registry.create({ id: 'finance', name: 'Finance', folder })
  registry.create({ id: 'idle', name: 'Idle', folder: mkdtempSync(join(tmpdir(), 'started-idle-')) })
  const native = new NativeStore(join(dataDir, 'native.json'))
  const origins = new SessionOriginsStore(dataDir)
  origins.record(`${munged}/r1`, { kind: 'automation', automationId: 'a1', runId: 'run1', at: '2026-11-01T10:00:00.000Z' })
  tokens = new AgentTokens(dataDir)
  app = buildServer({
    index,
    registry,
    native,
    origins,
    chat: new ChatService({
      registry,
      native,
      queryFn: () => {
        throw new Error('no sdk')
      },
    }),
    store: new SessionStore(root, dataDir),
    exec: new ExecService(registry),
    complete: new CompleteService(registry, index),
    prefs: new PrefsStore(dataDir),
    memory: new MemoryService(root, dataDir, registry),
    agentState: new AgentStateStore(join(dataDir, 'agent-state')),
    token: 't0k',
    liveMs: 120_000,
    agentTokens: tokens,
    home,
  })
})
afterEach(async () => {
  await app.close()
  index.stopHeartbeat()
  vi.restoreAllMocks()
})

describe('GET /api/sessions/:folder/:id/started-with', () => {
  it('a measured conversation: total, mode, parts by owner summing to the total, account', async () => {
    const r = await app.inject({ url: `/api/sessions/${munged}/c1/started-with`, headers: OWNER })
    expect(r.statusCode).toBe(200)
    const s = r.json()
    expect(s).toMatchObject({ measured: true, totalTokens: 1000, mode: 'console', accounts: [{ email: 'me@example.test' }] })
    expect(s.parts.reduce((a: number, p: { tokens: number }) => a + p.tokens, 0)).toBe(1000)
    // the project's CLAUDE.md, under the agent's folder → project
    expect(s.parts.find((p: { kind: string }) => p.kind === 'instructions')).toMatchObject({ owner: 'project', chars: 300, ref: 'file-0' })
  })

  it('unmeasured (no shape, no snapshot): the total alone', async () => {
    const s = (await app.inject({ url: `/api/sessions/${munged}/u1/started-with`, headers: OWNER })).json()
    expect(s).toMatchObject({ measured: false, totalTokens: 900, parts: [] })
  })

  it('cached by size + mtime: a grown transcript is read again', async () => {
    const first = (await app.inject({ url: `/api/sessions/${munged}/c1/started-with`, headers: OWNER })).json()
    expect(first.contextNow.tokens).toBe(1000)
    appendFileSync(
      join(dir, 'c1.jsonl'),
      L({
        type: 'assistant',
        cwd: folder,
        sessionId: 'c1',
        timestamp: '2026-11-01T11:00:00.000Z',
        message: { role: 'assistant', content: [], usage: { input_tokens: 5000 } },
      }),
    )
    const again = (await app.inject({ url: `/api/sessions/${munged}/c1/started-with`, headers: OWNER })).json()
    expect(again.contextNow.tokens).toBe(5000)
    expect(again.totalTokens).toBe(1000)
  })

  it('unknown session → 404; an engine without startedWith → null', async () => {
    expect((await app.inject({ url: `/api/sessions/${munged}/nope/started-with`, headers: OWNER })).statusCode).toBe(404)
    const cc = harnesses['claude-code']!
    const saved = cc.startedWith
    ;(cc as { startedWith?: unknown }).startedWith = undefined
    try {
      const r = await app.inject({ url: `/api/sessions/${munged}/c2/started-with`, headers: OWNER })
      expect(r.statusCode).toBe(200)
      expect(r.body).toBe('null')
    } finally {
      ;(cc as { startedWith?: unknown }).startedWith = saved
    }
  })

  it('owner-only: an agent bearer is refused', async () => {
    const auth = { ...LOCAL, authorization: `Bearer ${tokens.tokenFor('finance')}` }
    expect((await app.inject({ url: `/api/sessions/${munged}/c1/started-with`, headers: auth })).statusCode).toBe(403)
    expect((await app.inject({ url: `/api/sessions/${munged}/c1/started-with/part/first`, headers: auth })).statusCode).toBe(403)
  })
})

describe('GET /api/sessions/:folder/:id/started-with/part/:key', () => {
  it("a part's exact text by its ref; unknown key → 404; a malformed key → 400", async () => {
    const r = await app.inject({ url: `/api/sessions/${munged}/c1/started-with/part/first`, headers: OWNER })
    expect(r.statusCode).toBe(200)
    expect(r.json()).toEqual({ ref: 'first', text: 'hello there' })
    expect((await app.inject({ url: `/api/sessions/${munged}/c1/started-with/part/file-0`, headers: OWNER })).json().text).toBe('P'.repeat(300))
    expect((await app.inject({ url: `/api/sessions/${munged}/c1/started-with/part/now-file-0`, headers: OWNER })).json().text).toBe('P'.repeat(300))
    expect((await app.inject({ url: `/api/sessions/${munged}/c1/started-with/part/nope`, headers: OWNER })).statusCode).toBe(404)
    expect((await app.inject({ url: `/api/sessions/${munged}/c1/started-with/part/${encodeURIComponent('a b')}`, headers: OWNER })).statusCode).toBe(400)
    // an unmeasured conversation has no parts
    expect((await app.inject({ url: `/api/sessions/${munged}/u1/started-with/part/first`, headers: OWNER })).statusCode).toBe(404)
  })
})

describe('GET /api/agents/:id/started-with', () => {
  it('per mode, never mixed: console · chat · run (an automation’s), medians, range, n; unmeasured skipped', async () => {
    const r = await app.inject({ url: '/api/agents/finance/started-with', headers: OWNER })
    expect(r.statusCode).toBe(200)
    const b = r.json()
    expect(b.console).toMatchObject({ n: 3, total: 2000, range: [1000, 3000], latest: { folder: munged, id: 'c1' } })
    expect(b.chat).toMatchObject({ n: 1, total: 600, range: [600, 600] })
    expect(b.run).toMatchObject({ n: 1, total: 400, latest: { id: 'r1' } })
    // per-owner medians add up close to the median total
    const owners = b.console.owners as Record<string, number>
    expect(Object.keys(owners).sort()).toEqual(['conversation', 'engine', 'project'])
    expect(Math.abs(Object.values(owners).reduce((a, x) => a + x, 0) - 2000)).toBeLessThanOrEqual(3)
  })

  it('an agent with no measured conversation → null; unknown agent → 404', async () => {
    const r = await app.inject({ url: '/api/agents/idle/started-with', headers: OWNER })
    expect(r.statusCode).toBe(200)
    expect(r.body).toBe('null')
    expect((await app.inject({ url: '/api/agents/nobody/started-with', headers: OWNER })).statusCode).toBe(404)
  })
})

// Followed, not re-read: a live transcript grows on every tool call;
// each request feeds only what was appended, and requests share one read.
describe('Started with — a transcript followed as it grows', () => {
  const linesFed = (spy: { mock: { calls: unknown[][] } }): number => spy.mock.calls.reduce((a, c) => a + (c[0] as string[]).filter((l) => l !== '').length, 0)
  const nonBlank = (file: string): number =>
    readFileSync(file, 'utf8')
      .split('\n')
      .filter((l) => l !== '').length

  it('an unchanged transcript is not fed again; a grown one feeds only what was appended, and reads as the whole file', async () => {
    const fed = vi.spyOn(TranscriptStartedWith.prototype, 'feed')
    await app.inject({ url: `/api/sessions/${munged}/c1/started-with`, headers: OWNER })
    expect(linesFed(fed)).toBe(nonBlank(join(dir, 'c1.jsonl')))
    fed.mockClear()
    await app.inject({ url: `/api/sessions/${munged}/c1/started-with`, headers: OWNER })
    await app.inject({ url: `/api/sessions/${munged}/c1/started-with/part/first`, headers: OWNER })
    expect(linesFed(fed)).toBe(0)
    const grow =
      L({
        type: 'assistant',
        cwd: folder,
        sessionId: 'c1',
        timestamp: '2026-11-01T11:00:00.000Z',
        message: { role: 'assistant', content: [], usage: { input_tokens: 5000 } },
      }) +
      L({
        type: 'attachment',
        cwd: folder,
        sessionId: 'c1',
        timestamp: '2026-11-01T11:00:01.000Z',
        attachment: { type: 'session_context', context: { userEmail: 'other@example.test' } },
      })
    appendFileSync(join(dir, 'c1.jsonl'), grow)
    const followed = (await app.inject({ url: `/api/sessions/${munged}/c1/started-with`, headers: OWNER })).json()
    expect(linesFed(fed)).toBe(2)
    // the same answer as a conversation whose identical transcript is read whole
    copyFileSync(join(dir, 'c1.jsonl'), join(dir, 'c1copy.jsonl'))
    await index.refresh(munged, 'c1copy')
    const whole = (await app.inject({ url: `/api/sessions/${munged}/c1copy/started-with`, headers: OWNER })).json()
    expect(followed).toEqual(whole)
    expect(followed.accounts.map((a: { email: string }) => a.email)).toEqual(['me@example.test', 'other@example.test'])
  })

  it("the column, its part rows and the agent's medians asking at once read each transcript once", async () => {
    const fed = vi.spyOn(TranscriptStartedWith.prototype, 'feed')
    const rs = await Promise.all([
      app.inject({ url: `/api/sessions/${munged}/c1/started-with`, headers: OWNER }),
      app.inject({ url: `/api/sessions/${munged}/c1/started-with/part/first`, headers: OWNER }),
      app.inject({ url: `/api/sessions/${munged}/c1/started-with/part/file-0`, headers: OWNER }),
      app.inject({ url: '/api/agents/finance/started-with', headers: OWNER }),
      app.inject({ url: '/api/agents/finance/started-with', headers: OWNER }),
    ])
    for (const r of rs) expect(r.statusCode).toBe(200)
    const all = readdirSync(dir)
      .filter((f) => f.endsWith('.jsonl'))
      .reduce((a, f) => a + nonBlank(join(dir, f)), 0)
    expect(linesFed(fed)).toBe(all)
  })
})

// The measured weight on Tools rows (tools-origin §6 Weight): the newest
// measured start in the folder, its parts keyed by the inventory row each
// was placed on.
describe('GET /api/folders/:folder/loads/weight', () => {
  const withServer = async (): Promise<void> => {
    writeFileSync(join(folder, '.mcp.json'), JSON.stringify({ mcpServers: { books: { command: 'books-mcp' } } }))
    const base = { cwd: folder, sessionId: 'w1', entrypoint: 'cli' }
    writeFileSync(
      join(dir, 'w1.jsonl'),
      L({ ...base, type: 'user', timestamp: '2026-11-02T10:00:00.000Z', message: { role: 'user', content: 'hi' } }) +
        L({
          ...base,
          type: 'attachment',
          timestamp: '2026-11-02T10:00:00.000Z',
          attachment: { type: 'deferred_tools_delta', addedNames: ['mcp__books__list', 'mcp__books__add'] },
        }) +
        L({
          type: 'api-request-shape',
          timestamp: '2026-11-02T10:00:01.000Z',
          shape: { system: [{ type: 'text', text: 'E'.repeat(400) }], tools: [{ name: 'mcp__books__find', description: 'f'.repeat(200) }] },
        }) +
        L({
          ...base,
          type: 'assistant',
          timestamp: '2026-11-02T10:00:02.000Z',
          message: { role: 'assistant', content: [], usage: { input_tokens: 1, cache_creation_input_tokens: 1999, cache_read_input_tokens: 0 } },
        }),
    )
    await index.refresh(munged, 'w1')
  }

  it('the newest measured start: each part on its row — a server’s tool definitions and names on the server', async () => {
    await withServer()
    const r = await app.inject({ url: `/api/folders/${encodeURIComponent(folder)}/loads/weight`, headers: OWNER })
    expect(r.statusCode).toBe(200)
    const w = r.json()
    expect(w).toMatchObject({ folder, conversation: { folder: munged, id: 'w1' }, total: 2000 })
    const books = w.items['mcp:project:books']
    expect(books.tokens).toBeGreaterThan(0)
    expect(books.parts).toEqual([expect.objectContaining({ kind: 'mcp', label: 'books' })])
    // only what belongs to a row is keyed: the system prompt is no row's
    const keyed = Object.values(w.items as Record<string, { tokens: number }>).reduce((a, x) => a + x.tokens, 0)
    expect(keyed).toBeLessThan(2000)
    // the conversation's own reading names the same row
    const s = (await app.inject({ url: `/api/sessions/${munged}/w1/started-with`, headers: OWNER })).json()
    expect(s.parts.find((p: { kind: string }) => p.kind === 'mcp')).toMatchObject({ owner: 'project', label: 'books', item: 'mcp:project:books' })
  })

  it('a folder no agent manages is 404; an agent bearer is refused; no measured start → null', async () => {
    expect((await app.inject({ url: `/api/folders/${encodeURIComponent('/etc')}/loads/weight`, headers: OWNER })).statusCode).toBe(404)
    const auth = { ...LOCAL, authorization: `Bearer ${tokens.tokenFor('finance')}` }
    expect((await app.inject({ url: `/api/folders/${encodeURIComponent(folder)}/loads/weight`, headers: auth })).statusCode).toBe(403)
    const empty = mkdtempSync(join(tmpdir(), 'started-empty-'))
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/agents',
          headers: { ...LOCAL, 'x-token': 't0k' },
          payload: { id: 'quiet', name: 'Quiet', folder: empty },
        })
      ).statusCode,
    ).toBeLessThan(300)
    const r = await app.inject({ url: `/api/folders/${encodeURIComponent(empty)}/loads/weight`, headers: OWNER })
    expect(r.statusCode).toBe(200)
    expect(r.body).toBe('null')
  })
})
