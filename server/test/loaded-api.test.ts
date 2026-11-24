// loaded-api.test.ts — GET /api/agents/:id/loaded: the engine's own reader
// of what every session of an agent receives at start, fed the agent's
// newest CONVERSATION transcripts (runs start without hooks) and the MCP
// servers its conversations called. Owner reads anyone's; an agent bearer
// reads only its own.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
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
import { harnesses } from '../src/harnesses/index.js'
import { buildServer } from '../src/server.js'
import { asOwner } from './helpers/owner.js'

const LOCAL = { host: '127.0.0.1:3210' }
let app: FastifyInstance, tokens: AgentTokens, home: string, folder: string

const line = (o: unknown): string => `${JSON.stringify(o)}\n`

beforeEach(async () => {
  const base = mkdtempSync(join(tmpdir(), 'loaded-api-'))
  home = join(base, 'home')
  folder = join(base, 'proj')
  const root = join(home, '.claude', 'projects')
  const dataDir = join(base, 'data')
  mkdirSync(join(dataDir, 'trash'), { recursive: true })
  mkdirSync(folder, { recursive: true })
  mkdirSync(join(root, mungePath(folder)), { recursive: true })
  writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: '/u/brief.sh' }] }] } }))
  // a conversation whose start recorded the hook, and called an account connector
  writeFileSync(
    join(root, mungePath(folder), 's1.jsonl'),
    line({
      type: 'attachment',
      cwd: folder,
      sessionId: 's1',
      timestamp: '2026-10-31T09:00:00.000Z',
      attachment: {
        type: 'hook_success',
        hookEvent: 'SessionStart',
        hookName: 'SessionStart:startup',
        command: '/u/brief.sh',
        stdout: JSON.stringify({ hookSpecificOutput: { additionalContext: 'hello briefing' } }),
        exitCode: 0,
      },
    }) +
      line({ type: 'user', cwd: folder, sessionId: 's1', timestamp: '2026-10-31T09:00:01.000Z', message: { role: 'user', content: 'hi' } }) +
      line({
        type: 'assistant',
        cwd: folder,
        sessionId: 's1',
        timestamp: '2026-10-31T09:00:02.000Z',
        message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'mcp__claude_ai_ledgerly__list_invoices', input: {} }] },
      }),
  )
  const index = claudeSessionIndex(root, join(dataDir, 'cache.json'))
  await index.init()
  const registry = new AgentRegistry(join(dataDir, 'agents.json'))
  registry.load()
  registry.create({ id: 'finance', name: 'Finance', folder })
  registry.create({ id: 'oc', name: 'Oc', folder: mkdtempSync(join(tmpdir(), 'loaded-oc-')), framework: 'opencode' })
  const native = new NativeStore(join(dataDir, 'native.json'))
  tokens = new AgentTokens(dataDir)
  app = buildServer({
    index,
    registry,
    native,
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
  asOwner(app, 't0k')
})
afterEach(async () => {
  await app.close()
})

describe('GET /api/agents/:id/loaded', () => {
  it('a Claude Code agent: its hooks with what its last start received, and the connectors its conversations used', async () => {
    const r = await app.inject({ url: '/api/agents/finance/loaded', headers: LOCAL })
    expect(r.statusCode).toBe(200)
    const body = r.json()
    expect(body.engine).toBe('Claude Code')
    expect(body.folder).toBe(folder)
    expect(body.injections).toEqual([
      expect.objectContaining({ origin: 'user', command: '/u/brief.sh', seen: expect.objectContaining({ chars: 14, excerpt: 'hello briefing' }) }),
    ])
    expect(body.mcp).toContainEqual({ name: 'claude_ai_ledgerly', source: 'account', from: 'claude.ai' })
  })

  it("another agent of the same folder: its own conversations recorded nothing, the folder's last start is the evidence", async () => {
    const created = await app.inject({ method: 'POST', url: '/api/agents', headers: LOCAL, payload: { id: 'support', name: 'Support', folder } })
    expect(created.statusCode).toBeLessThan(300)
    const body = (await app.inject({ url: '/api/agents/support/loaded', headers: LOCAL })).json()
    expect(body.injections[0].seen).toMatchObject({ chars: 14 })
    // its servers are the folder's inventory: a connector a conversation
    // in the folder used loads for every agent there on that login
    expect(body.mcp).toContainEqual({ name: 'claude_ai_ledgerly', source: 'account', from: 'claude.ai' })
  })

  it("an OpenCode agent gets OpenCode's reading — never Claude's hooks", async () => {
    const body = (await app.inject({ url: '/api/agents/oc/loaded', headers: LOCAL })).json()
    expect(body.engine).toBe('OpenCode')
    expect(body.injections).toEqual([])
  })

  it('no folder, or an engine that cannot say → null (the page hides the row); unknown agent → 404', async () => {
    expect((await app.inject({ url: '/api/agents/master/loaded', headers: LOCAL })).json()).toBeNull()
    const oc = harnesses['opencode']!
    const saved = oc.loadedAtStart
    ;(oc as { loadedAtStart?: unknown }).loadedAtStart = undefined
    try {
      const r = await app.inject({ url: '/api/agents/oc/loaded', headers: LOCAL })
      expect(r.statusCode).toBe(200)
      expect(r.body).toBe('null')
    } finally {
      ;(oc as { loadedAtStart?: unknown }).loadedAtStart = saved
    }
    expect((await app.inject({ url: '/api/agents/nobody/loaded', headers: LOCAL })).statusCode).toBe(404)
  })

  it('an agent bearer reads its own, never another agent’s', async () => {
    const auth = { ...LOCAL, authorization: `Bearer ${tokens.tokenFor('finance')}` }
    expect((await app.inject({ url: '/api/agents/finance/loaded', headers: auth })).statusCode).toBe(200)
    expect((await app.inject({ url: '/api/agents/oc/loaded', headers: auth })).statusCode).toBe(403)
  })
})
