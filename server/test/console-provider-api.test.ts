import { describe, it, expect, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
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
import { TerminalService } from '../src/terminal-service.js'
import { ProvidersStore } from '../src/providers-store.js'
import { ConversationPrefsStore } from '../src/conversation-prefs.js'
import { buildServer } from '../src/server.js'
import { asOwner } from './helpers/owner.js'

// The console honors the same provider cascade as a chat turn (two
// engines, one truth): a conversation pinned to a Claude account spawns
// its claude with that account's CLAUDE_CONFIG_DIR; a NEW console can be
// opened on an account, and that pick is persisted as the conversation's
// pref so the column shows it. Unknown ids are refused at the route.
describe('provider on the console and on the conversation prefs', () => {
  const socket = `silos-provider-${process.pid}`
  let app: FastifyInstance, terminals: TerminalService
  let base: string, root: string, folder: string, envDump: string, convPrefs: ConversationPrefsStore
  let launched: { model?: string } = {}

  afterEach(async () => {
    terminals?.killAll()
    terminals?.stopReaper()
    await app?.close()
    try {
      execFileSync('tmux', ['-L', socket, 'kill-server'], { stdio: 'ignore' })
    } catch {
      /* no server */
    }
    try {
      rmSync(join(process.env.TMUX_TMPDIR ?? '/tmp', `tmux-${process.getuid?.() ?? 0}`, socket), { force: true })
    } catch {
      /* best effort */
    }
  })

  async function setup(): Promise<void> {
    base = mkdtempSync(join(tmpdir(), 'deck-'))
    root = join(base, 'projects')
    folder = mkdtempSync(join(tmpdir(), 'deck-folder-'))
    envDump = join(base, 'console-env.txt')
    mkdirSync(root, { recursive: true })
    mkdirSync(join(base, 'data', 'trash'), { recursive: true })
    mkdirSync(join(base, 'data', 'claude-accounts', 'alt'), { recursive: true })
    const index = claudeSessionIndex(root, join(base, 'data', 'cache.json'))
    await index.init()
    const registry = new AgentRegistry(join(base, 'data', 'agents.json'))
    registry.load()
    registry.create({ id: 'writer', name: 'Writer', folder })
    const store = new SessionStore(root, join(base, 'data'))
    const native = new NativeStore(join(base, 'data', 'native.json'))
    const prefs = new PrefsStore(join(base, 'data'))
    const memory = new MemoryService(root, join(base, 'data'), registry)
    const providers = new ProvidersStore(join(base, 'data'))
    providers.load()
    convPrefs = new ConversationPrefsStore(join(base, 'data'))
    convPrefs.load()
    const chat = new ChatService({
      registry,
      native,
      providers,
      convPrefs,
      queryFn: () => ({
        async *[Symbol.asyncIterator]() {},
        async interrupt() {
          return undefined
        },
      }),
    })
    terminals = new TerminalService(registry, index, undefined, undefined, {
      tmuxSocket: socket,
      appendDir: join(base, 'append'),
      envDir: join(base, 'env'),
      sessionsDir: join(base, 'claude-sessions'),
      // the "claude" dumps its environment, so the env file the launcher
      // sourced is asserted end to end — not a spy on ensureConsole.
      command: (opts) => {
        launched = { ...(opts.model ? { model: opts.model } : {}) }
        return ['bash', '-c', `env > "${envDump}"; sleep 60`]
      },
    })
    app = buildServer({
      index,
      registry,
      store,
      native,
      chat,
      exec: new ExecService(registry),
      complete: new CompleteService(registry, index),
      prefs,
      memory,
      terminals,
      providers,
      convPrefs,
      token: 't0k',
      liveMs: 120_000,
    })
    asOwner(app, 't0k')
  }

  async function dumpedEnv(): Promise<Record<string, string>> {
    for (let i = 0; i < 100; i++) {
      if (existsSync(envDump) && readFileSync(envDump, 'utf8').includes('PATH=')) break
      await new Promise((r) => setTimeout(r, 50))
    }
    const out: Record<string, string> = {}
    for (const line of readFileSync(envDump, 'utf8').split('\n')) {
      const i = line.indexOf('=')
      if (i > 0) out[line.slice(0, i)] = line.slice(i + 1)
    }
    return out
  }

  it('a NEW console opened on an account spawns with its CLAUDE_CONFIG_DIR and persists the pick as the conversation pref', async () => {
    await setup()
    // the model picked before the first prompt is what claude LAUNCHES on
    // (21-11: it opened on the agent's model whatever the pick said)
    const res = await app.inject({ method: 'POST', url: '/api/console', payload: { agentId: 'writer', provider: 'account:alt', model: 'claude-haiku-5-5' } })
    expect(res.statusCode).toBe(201)
    const { key } = res.json() as { key: string }
    const env = await dumpedEnv()
    expect(env.CLAUDE_CONFIG_DIR).toBe(join(base, 'data', 'claude-accounts', 'alt'))
    expect(env.ANTHROPIC_API_KEY).toBe('')
    expect(launched.model).toBe('claude-haiku-5-5')
    const prefs = await app.inject({ url: `/api/sessions/${mungePath(folder)}/${key}/prefs` })
    expect(prefs.json()).toEqual({ prefs: { provider: 'account:alt', model: 'claude-haiku-5-5' } })
  })

  it('an existing conversation pinned to an account reopens its console under that account', async () => {
    await setup()
    const id = randomUUID()
    const mf = mungePath(folder)
    mkdirSync(join(root, mf), { recursive: true })
    writeFileSync(
      join(root, mf, `${id}.jsonl`),
      [
        JSON.stringify({
          type: 'user',
          uuid: 'u1',
          parentUuid: null,
          sessionId: id,
          cwd: folder,
          timestamp: '2026-10-23T10:00:00.000Z',
          message: { role: 'user', content: 'hello' },
        }),
      ].join('\n') + '\n',
    )
    const index = (app as unknown as { silosIndex?: SessionIndex }).silosIndex
    void index
    await terminalsIndexRefresh(mf, id)
    convPrefs.patch(mf, id, { provider: 'account:alt' })
    const res = await app.inject({ method: 'POST', url: '/api/console', payload: { id } })
    expect(res.statusCode).toBe(201)
    const env = await dumpedEnv()
    expect(env.CLAUDE_CONFIG_DIR).toBe(join(base, 'data', 'claude-accounts', 'alt'))
  })

  it('an unknown provider is refused: 400 on POST /api/console and on PATCH …/prefs; a known one is accepted', async () => {
    await setup()
    const bad = await app.inject({ method: 'POST', url: '/api/console', payload: { agentId: 'writer', provider: 'account:nope' } })
    expect(bad.statusCode).toBe(400)
    expect(bad.json().error).toMatch(/unknown provider/)
    const mf = mungePath(folder)
    const badPatch = await app.inject({ method: 'PATCH', url: `/api/sessions/${mf}/s1/prefs`, payload: { provider: 'account:nope' } })
    expect(badPatch.statusCode).toBe(400)
    expect(badPatch.json().error).toMatch(/unknown provider/)
    const ok = await app.inject({ method: 'PATCH', url: `/api/sessions/${mf}/s1/prefs`, payload: { provider: 'account:alt' } })
    expect(ok.statusCode).toBe(200)
    expect(ok.json()).toEqual({ prefs: { provider: 'account:alt' } })
    // clearing the pin is always fine
    const cleared = await app.inject({ method: 'PATCH', url: `/api/sessions/${mf}/s1/prefs`, payload: { provider: null } })
    expect(cleared.json()).toEqual({ prefs: {} })
  })

  // the index is private to the server here; refresh through the
  // terminals' own reference (same instance).
  async function terminalsIndexRefresh(mf: string, id: string): Promise<void> {
    const idx = (terminals as unknown as { index: SessionIndex }).index
    await idx.refresh(mf, id)
  }
})
