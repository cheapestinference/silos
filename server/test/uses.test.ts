// uses.test.ts — Map › Uses (uses.ts + GET /api/uses): every column kind
// counted from a session's own context, the three row kinds, the window,
// the runs toggle, the "shared by ≥N rows" filter applied before the cap,
// the evidence cap, and the route over a real index (fixture transcript).
import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, mkdirSync, cpSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { buildUses, MAX_COLS, MAX_REFS, projectOf, tildePath, type UsesQuery, type UsesSession } from '../src/uses.js'
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
import type { AccountsService } from '../src/harnesses/claude-code/accounts.js'
import type { ProvidersStore } from '../src/providers-store.js'
import type { ConversationPrefsStore } from '../src/conversation-prefs.js'

const NOW = Date.parse('2026-11-02T12:00:00Z')
const DAY = 86_400_000
const HOME = '/home/u'
const labels = {
  agent: (id: string) => id.toUpperCase(),
  provider: (id: string) =>
    id === 'k1'
      ? { label: 'cheapestinference · kimi-k3, qwen3.8-max', short: 'cheapestinference' }
      : id === 'default'
        ? { label: 'me@example.com', sub: 'Claude · this machine' }
        : { label: id },
  home: HOME,
}

let seq = 0
function session(over: Partial<UsesSession> & { ctx?: Partial<NonNullable<UsesSession['ctx']>> | null } = {}): UsesSession {
  seq++
  const { ctx, ...rest } = over
  return {
    folder: '-home-u-p',
    id: `s${seq}`,
    title: `conv ${seq}`,
    agentId: 'writer',
    project: '/home/u/p',
    cwd: '/home/u/p',
    mtime: NOW - DAY,
    run: false,
    skills: [],
    provider: 'default',
    ctx: ctx === null ? null : { files: [], tools: [], cost: null, ...ctx },
    ...rest,
  }
}
const q = (over: Partial<UsesQuery> = {}): UsesQuery => ({ rows: 'agent', cols: 'model', sinceMs: null, runs: true, minRows: 1, ...over })
const cost = (byModel: { model: string; inputTokens: number; outputTokens: number }[]) => ({
  totalUsd: 0,
  unknownModels: false,
  byModel: byModel.map((b) => ({ ...b, usd: 0, cacheReadTokens: 1_000_000, cacheCreationTokens: 0 })),
})
const file = (path: string, n: Partial<{ edits: number; writes: number; reads: number; sent: number; disk: number }> = {}) => ({
  path,
  edits: 0,
  writes: 0,
  reads: 0,
  sent: 0,
  disk: 0,
  ...n,
})

describe('buildUses — column kinds', () => {
  it('models: conversations per agent, tokens = input + output (cache reads not counted), synthetic turns skipped', () => {
    const v = buildUses(
      [
        session({
          agentId: 'writer',
          ctx: {
            cost: cost([
              { model: 'claude-opus-5-5', inputTokens: 100, outputTokens: 50 },
              { model: '<synthetic>', inputTokens: 0, outputTokens: 0 },
            ]),
          },
        }),
        session({ agentId: 'writer', ctx: { cost: cost([{ model: 'claude-opus-5-5', inputTokens: 10, outputTokens: 5 }]) } }),
        session({
          agentId: 'builder',
          ctx: {
            cost: cost([
              { model: 'claude-opus-5-5', inputTokens: 1, outputTokens: 1 },
              { model: 'claude-haiku-4-5', inputTokens: 7, outputTokens: 0 },
            ]),
          },
        }),
      ],
      q(),
      labels,
      NOW,
    )
    expect(v.measure).toBe('tokens')
    expect(v.cols.map((c) => [c.id, c.n, c.m, c.rows])).toEqual([
      ['claude-opus-5-5', 3, 167, 2],
      ['claude-haiku-4-5', 1, 7, 1],
    ])
    expect(v.rows.map((r) => [r.id, r.label, r.n])).toEqual([
      ['writer', 'WRITER', 2],
      ['builder', 'BUILDER', 1],
    ])
    expect(v.cells.find((c) => c.r === 'writer' && c.c === 'claude-opus-5-5')).toMatchObject({ n: 2, m: 165 })
  })

  it("a model reached through a Silos key reads under the key's short label, never its id", () => {
    const v = buildUses(
      [
        session({
          ctx: {
            cost: cost([
              { model: 'silos-k1/kimi-k3', inputTokens: 1, outputTokens: 1 },
              { model: 'zai/glm-5.3', inputTokens: 1, outputTokens: 1 },
            ]),
          },
        }),
      ],
      q(),
      labels,
      NOW,
    )
    expect(v.cols.find((c) => c.id === 'silos-k1/kimi-k3')).toMatchObject({ label: 'kimi-k3', sub: 'cheapestinference' })
    expect(v.cols.find((c) => c.id === 'zai/glm-5.3')).toMatchObject({ label: 'glm-5.3', sub: 'zai' })
  })

  it('files: absolute (a relative path joins the cwd), shown with ~, m = edits + writes + disk, r = reads + sent', () => {
    const v = buildUses(
      [
        session({ agentId: 'writer', ctx: { files: [file('/home/u/.silos/agents.json', { edits: 2, reads: 1 }), file('src/a.ts', { writes: 1 })] } }),
        session({ agentId: 'finance', cwd: null, ctx: { files: [file('/home/u/.silos/agents.json', { reads: 3, sent: 1 }), file('rel.ts', { edits: 1 })] } }),
      ],
      q({ cols: 'file' }),
      labels,
      NOW,
    )
    expect(v.measure).toBe('changes')
    const agents = v.cols.find((c) => c.id === '/home/u/.silos/agents.json')!
    expect(agents).toMatchObject({ label: 'agents.json', sub: '~/.silos', n: 2, rows: 2, m: 2 })
    expect(v.cols.some((c) => c.id === '/home/u/p/src/a.ts')).toBe(true)
    expect(v.cols.some((c) => c.id.endsWith('rel.ts'))).toBe(false) // no cwd to resolve it against
    const financeCell = v.cells.find((c) => c.r === 'finance' && c.c === agents.id)!
    expect(financeCell.refs).toEqual([{ s: expect.any(Number), m: 0, r: 4 }])
  })

  it('tools are the built-in ones; MCP is per server — calls summed', () => {
    const tools = [
      { name: 'Bash', server: null, count: 4 },
      { name: 'mcp__gmail__search', server: 'claude_ai_Gmail', count: 2 },
      { name: 'mcp__gmail__send', server: 'claude_ai_Gmail', count: 1 },
    ]
    const t = buildUses([session({ ctx: { tools } })], q({ cols: 'tool' }), labels, NOW)
    expect(t.cols.map((c) => [c.id, c.m])).toEqual([['Bash', 4]])
    const m = buildUses([session({ ctx: { tools } })], q({ cols: 'mcp' }), labels, NOW)
    expect(m.cols.map((c) => [c.id, c.m])).toEqual([['claude_ai_Gmail', 3]])
    expect(m.measure).toBe('calls')
  })

  it('skills and providers count conversations only (no measure); an account reads as its email, what it is underneath', () => {
    const s = buildUses([session({ skills: ['team-plan', 'heartbeat'] }), session({ skills: ['team-plan'] })], q({ cols: 'skill' }), labels, NOW)
    expect(s.measure).toBeNull()
    expect(s.cols.map((c) => [c.id, c.n])).toEqual([
      ['team-plan', 2],
      ['heartbeat', 1],
    ])
    expect(s.cells[0]).not.toHaveProperty('m')
    const p = buildUses([session({ provider: 'k1' }), session({ provider: 'default' }), session({ provider: 'k1' })], q({ cols: 'provider' }), labels, NOW)
    expect(p.cols.map((c) => [c.id, c.label, c.sub, c.n])).toEqual([
      ['k1', 'cheapestinference · kimi-k3, qwen3.8-max', undefined, 2],
      ['default', 'me@example.com', 'Claude · this machine', 1],
    ])
  })

  it('a session without context or without any use of the column kind is not a row', () => {
    const v = buildUses([session({ ctx: null }), session({ agentId: 'builder' })], q(), labels, NOW)
    expect(v.rows).toEqual([])
    expect(v.considered).toBe(2)
  })
})

describe('buildUses — rows, window, filters, caps', () => {
  it('project rows: label = folder name, sub = ~path; conversation rows: title + agent, newest first', () => {
    const a = session({ skills: ['x'], project: '/home/u/acme', mtime: NOW - 3 * DAY, title: 'older' })
    const b = session({ skills: ['x'], project: '/home/u/acme', mtime: NOW - DAY, title: 'newer', agentId: 'builder' })
    const p = buildUses([a, b], q({ rows: 'project', cols: 'skill' }), labels, NOW)
    expect(p.rows).toEqual([{ id: '/home/u/acme', label: 'acme', sub: '~/acme', n: 2 }])
    const c = buildUses([a, b], q({ rows: 'conversation', cols: 'skill' }), labels, NOW)
    expect(c.rows.map((r) => [r.label, r.sub])).toEqual([
      ['newer', 'BUILDER'],
      ['older', 'WRITER'],
    ])
    expect(c.rows[0]!.id).toBe(`${b.folder}/${b.id}`)
  })

  it('since: only sessions active inside the window', () => {
    const v = buildUses(
      [session({ skills: ['x'], mtime: NOW - 2 * DAY }), session({ skills: ['x'], mtime: NOW - 40 * DAY })],
      q({ cols: 'skill', sinceMs: NOW - 7 * DAY }),
      labels,
      NOW,
    )
    expect(v.cols[0]!.n).toBe(1)
    expect(v.considered).toBe(1)
  })

  it('runs: counted under their agent by default, left out with runs=false', () => {
    const all = [session({ skills: ['x'] }), session({ skills: ['x'], run: true })]
    expect(buildUses(all, q({ cols: 'skill' }), labels, NOW).cols[0]!.n).toBe(2)
    expect(buildUses(all, q({ cols: 'skill', runs: false }), labels, NOW).cols[0]!.n).toBe(1)
    const v = buildUses(all, q({ cols: 'skill' }), labels, NOW)
    expect(v.sessions.map((s) => s.run).sort()).toEqual([false, true])
  })

  it('folder scope: only sessions whose cwd lies inside it (worktrees included)', () => {
    const v = buildUses(
      [
        session({ skills: ['x'], cwd: '/home/u/silos/.claude/worktrees/w1' }),
        session({ skills: ['x'], cwd: '/home/u/silos-old' }),
        session({ skills: ['x'], cwd: null }),
      ],
      q({ cols: 'skill', folder: '/home/u/silos' }),
      labels,
      NOW,
    )
    expect(v.cols[0]!.n).toBe(1)
  })

  it('minRows: the shared filter applies BEFORE the column cap, so a low-ranked shared column survives', () => {
    const sessions: UsesSession[] = []
    // MAX_COLS + 5 files used by writer only, three conversations each (rank high)
    for (let i = 0; i < MAX_COLS + 5; i++)
      for (let k = 0; k < 3; k++) sessions.push(session({ agentId: 'writer', ctx: { files: [file(`/home/u/p/f${i}.ts`, { edits: 1 })] } }))
    // one file both agents touched once
    sessions.push(session({ agentId: 'writer', ctx: { files: [file('/home/u/shared.md', { reads: 1 })] } }))
    sessions.push(session({ agentId: 'builder', ctx: { files: [file('/home/u/shared.md', { reads: 1 })] } }))
    const all = buildUses(sessions, q({ cols: 'file' }), labels, NOW)
    expect(all.cols).toHaveLength(MAX_COLS)
    expect(all.truncated.cols).toBe(6)
    expect(all.cols.some((c) => c.id === '/home/u/shared.md')).toBe(false)
    const shared = buildUses(sessions, q({ cols: 'file', minRows: 2 }), labels, NOW)
    expect(shared.cols.map((c) => c.id)).toEqual(['/home/u/shared.md'])
    expect(shared.truncated.cols).toBe(0)
    // a row left with no kept column is no row: builder is there, and writer only for the shared file
    expect(shared.rows.map((r) => [r.id, r.n]).sort()).toEqual([
      ['builder', 1],
      ['writer', 1],
    ])
  })

  it('evidence: a cell keeps its true count but at most MAX_REFS refs, newest first, into one sessions table', () => {
    const many = Array.from({ length: MAX_REFS + 10 }, (_, i) => session({ skills: ['x'], mtime: NOW - i * 1000, title: `t${i}` }))
    const v = buildUses(many, q({ cols: 'skill' }), labels, NOW)
    const cell = v.cells[0]!
    expect(cell.n).toBe(MAX_REFS + 10)
    expect(cell.refs).toHaveLength(MAX_REFS)
    expect(v.sessions[cell.refs[0]!.s]!.title).toBe('t0')
    expect(v.sessions).toHaveLength(MAX_REFS)
  })
})

describe('projectOf / tildePath', () => {
  it('the longest known folder holding the cwd, else its main checkout', () => {
    expect(projectOf('/home/u/a/b/c', ['/home/u/a', '/home/u/a/b'])).toBe('/home/u/a/b')
    expect(projectOf('/home/u/ab', ['/home/u/a'])).toBe('/home/u/ab')
    expect(projectOf('/home/u/x/.claude/worktrees/w', [])).toBe('/home/u/x')
    expect(projectOf(null, ['/home/u/a'])).toBeNull()
  })
  it('~ only for the home itself or below it', () => {
    expect(tildePath('/home/u/.silos', '/home/u')).toBe('~/.silos')
    expect(tildePath('/home/uu', '/home/u')).toBe('/home/uu')
  })
})

describe('GET /api/uses', () => {
  const FIX = new URL('./fixtures/basic.jsonl', import.meta.url).pathname
  const TOKEN = 'testtoken'
  let app: FastifyInstance
  let build: (extra?: Partial<ServerDeps>) => FastifyInstance
  let index: ReturnType<typeof claudeSessionIndex>
  let sessionFile: string

  beforeEach(async () => {
    const base = mkdtempSync(join(tmpdir(), 'deck-uses-'))
    const root = join(base, 'projects')
    const dataDir = join(base, 'data')
    mkdirSync(join(root, '-tmp-project-x'), { recursive: true })
    mkdirSync(join(dataDir, 'trash'), { recursive: true })
    cpSync(FIX, join(root, '-tmp-project-x', 'aaa.jsonl'))
    // recent content activity so the session falls inside a 7-day window
    appendFileSync(
      join(root, '-tmp-project-x', 'aaa.jsonl'),
      JSON.stringify({
        type: 'user',
        timestamp: new Date().toISOString(),
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tick', content: 'ok' }] },
      }) + '\n',
    )
    sessionFile = join(root, '-tmp-project-x', 'aaa.jsonl')
    index = claudeSessionIndex(root, join(dataDir, 'cache.json'))
    await index.init()
    const registry = new AgentRegistry(join(dataDir, 'agents.json'))
    registry.load()
    registry.create({ id: 'finance', name: 'FINANCE', folder: '/tmp/project-x', skills: [], provider: 'default' })
    const native = new NativeStore(join(dataDir, 'native.json'))
    build = (extra = {}) =>
      buildServer({
        index,
        registry,
        store: new SessionStore(root, dataDir),
        native,
        chat: new ChatService({
          registry,
          native,
          queryFn: () => ({
            async *[Symbol.asyncIterator]() {},
            async interrupt() {
              return undefined
            },
          }),
        }),
        exec: new ExecService(registry),
        complete: new CompleteService(registry, index),
        prefs: new PrefsStore(dataDir),
        memory: new MemoryService(root, dataDir, registry),
        token: TOKEN,
        liveMs: 120_000,
        home: base,
        ...extra,
      })
    app = build()
  })

  const get = (url: string) => app.inject({ url, headers: { 'x-token': TOKEN } })

  it('agents × tools from the real transcript, with its title as evidence', async () => {
    const res = await get('/api/uses?rows=agent&cols=tool&since=7')
    expect(res.statusCode).toBe(200)
    const v = res.json()
    expect(v.rows).toEqual([expect.objectContaining({ id: 'finance', label: 'FINANCE', n: 1 })])
    expect(v.cols.map((c: { id: string }) => c.id)).toContain('Bash')
    expect(v.sessions).toEqual([expect.objectContaining({ key: '-tmp-project-x/aaa', agentId: 'finance', title: 'JSONL parser fix', run: false })])
  })

  it('projects × skills, scoped to a folder', async () => {
    const v = (await get('/api/uses?rows=project&cols=skill&since=all&folder=/tmp/project-x')).json()
    expect(v.rows.map((r: { id: string }) => r.id)).toEqual(['/tmp/project-x'])
    expect(v.cols.map((c: { id: string }) => c.id)).toEqual(['finance-acme'])
    expect((await get('/api/uses?cols=skill&since=all&folder=/elsewhere')).json().rows).toEqual([])
  })

  it("accounts: the legacy anthropic id is the machine's default account, one column", async () => {
    const v = (await get('/api/uses?cols=provider&since=all')).json()
    expect(v.cols).toEqual([expect.objectContaining({ id: 'default', label: 'Claude · this machine', n: 1 })])
  })

  it('an account Silos knows the email of reads as that email, what it is underneath', async () => {
    const accounts = {
      list: () => [
        { name: 'default', providerId: 'default', email: 'me@example.com' },
        { name: 'kai', providerId: 'account:kai', email: null },
      ],
    } as unknown as AccountsService
    app = build({ accounts })
    const v = (await get('/api/uses?cols=provider&since=all')).json()
    expect(v.cols).toEqual([expect.objectContaining({ id: 'default', label: 'me@example.com', sub: 'Claude · this machine' })])
  })

  it("the account a conversation RAN on (its transcript's login email) beats the one it was set to; a key is never replaced", async () => {
    appendFileSync(
      sessionFile,
      JSON.stringify({
        type: 'attachment',
        timestamp: new Date().toISOString(),
        attachment: { type: 'session_context', context: { userEmail: "The user's email address is kai@example.com. Use it only to identify the user." } },
      }) + '\n',
    )
    await index.refresh('-tmp-project-x', 'aaa')
    const accounts = {
      list: () => [
        { name: 'default', providerId: 'default', email: 'me@example.com' },
        { name: 'kai', providerId: 'account:kai', email: 'kai@example.com' },
      ],
    } as unknown as AccountsService
    app = build({ accounts })
    // set to the machine's account (the agent's 'default'), ran on kai
    expect((await get('/api/uses?cols=provider&since=all')).json().cols).toEqual([
      expect.objectContaining({ id: 'account:kai', label: 'kai@example.com', n: 1 }),
    ])
    const providers = {
      get: (id: string) => (id === 'k1' ? { id: 'k1', kind: 'anthropic-compatible', label: 'gw', baseUrl: 'https://x', apiKey: 'x' } : null),
    } as unknown as ProvidersStore
    const convPrefs = { get: () => ({ provider: 'k1' }) } as unknown as ConversationPrefsStore
    app = build({ accounts, providers, convPrefs })
    expect((await get('/api/uses?cols=provider&since=all')).json().cols).toEqual([expect.objectContaining({ id: 'k1' })])
  })

  it('a key Silos named reads as its gateway with the models it reaches underneath', async () => {
    const providers = {
      get: (id: string) =>
        id === 'k1'
          ? {
              id: 'k1',
              kind: 'anthropic-compatible',
              label: 'cheapestinference · kimi-k3, qwen3.8-max',
              baseUrl: 'https://api.cheapestinference.com/anthropic',
              apiKey: 'x',
              models: ['kimi-k3', 'qwen3.8-max'],
            }
          : null,
    } as unknown as ProvidersStore
    const convPrefs = { get: () => ({ provider: 'k1' }) } as unknown as ConversationPrefsStore
    app = build({ providers, convPrefs })
    const v = (await get('/api/uses?cols=provider&since=all')).json()
    expect(v.cols).toEqual([expect.objectContaining({ id: 'k1', label: 'cheapestinference', sub: 'kimi-k3, qwen3.8-max', n: 1 })])
  })

  it('400 on an unknown axis, a bad window, a bad min or a relative folder', async () => {
    expect((await get('/api/uses?rows=file')).statusCode).toBe(400)
    expect((await get('/api/uses?cols=agent')).statusCode).toBe(400)
    expect((await get('/api/uses?since=week')).statusCode).toBe(400)
    expect((await get('/api/uses?min=0')).statusCode).toBe(400)
    expect((await get('/api/uses?folder=tmp')).statusCode).toBe(400)
  })
})
