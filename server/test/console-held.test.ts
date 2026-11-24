// console-held.test.ts — POST /api/console when a claude OUTSIDE Silos still
// holds the conversation (a hand launch, a retry wrapper): the refusal is
// structured (409, holders, canClose) and `closeHolders: true` closes it —
// the trash route's own SIGHUP-then-SIGTERM — and opens in the same gesture
// (a message that only said «wait for it to exit» left no door).
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
import { buildServer } from '../src/server.js'
import { ConsoleHeldError, TerminalService } from '../src/terminal-service.js'

describe('POST /api/console — a holder outside Silos', () => {
  let app: FastifyInstance
  afterEach(async () => {
    await app?.close()
  })

  async function boot() {
    const base = mkdtempSync(join(tmpdir(), 'deck-held-'))
    const root = join(base, 'projects')
    mkdirSync(join(root, '-tmp-p'), { recursive: true })
    mkdirSync(join(base, 'data', 'trash'), { recursive: true })
    writeFileSync(join(root, '-tmp-p', 'abc.jsonl'), '{"type":"user","cwd":"/tmp/p","message":{"role":"user","content":"hello"}}\n')
    const sessionsDir = join(base, 'claude-sessions')
    mkdirSync(sessionsDir)
    const alive = new Set([424242])
    writeFileSync(join(sessionsDir, '424242.json'), JSON.stringify({ pid: 424242, sessionId: 'abc', cwd: '/tmp/p', tmux: 'claude-other-9:@0.%0' }))
    const index = claudeSessionIndex(root, join(base, 'data', 'cache.json'))
    await index.init()
    const registry = new AgentRegistry(join(base, 'data', 'agents.json'))
    registry.load()
    const closed: number[] = []
    const terminals = new TerminalService(registry, index, undefined, undefined, {
      tmuxSocket: join(base, 'tmux.sock'),
      sessionsDir,
      isAlive: (pid) => alive.has(pid),
      signal: (pid) => {
        closed.push(pid)
        alive.delete(pid)
      },
      holderExitGraceMs: 200,
    })
    // no tmux in tests: the stub keeps only the rule under test — refuse
    // while a holder lives, open once it is gone
    terminals.ensureConsole = (input: { key: string; resumeId?: string }) => {
      const prior = input.resumeId ? terminals.holderDetailsOf(input.resumeId) : []
      if (prior.length > 0) throw new ConsoleHeldError('the previous claude of this conversation is still running', input.resumeId!, prior)
      return { key: input.key, theme: 'dark' as const }
    }
    const native = new NativeStore(join(base, 'data', 'native.json'))
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
    app = buildServer({
      index,
      registry,
      store: new SessionStore(root, join(base, 'data')),
      native,
      chat,
      exec: new ExecService(registry),
      complete: new CompleteService(registry, index),
      prefs: new PrefsStore(join(base, 'data')),
      memory: new MemoryService(root, join(base, 'data'), registry),
      terminals,
      token: 't0k',
      liveMs: 120_000,
    })
    return { closed }
  }
  const post = (payload: object) => app.inject({ method: 'POST', url: '/api/console', headers: { 'x-token': 't0k' }, payload })

  it('refuses 409 with the holders and canClose; closeHolders closes it and opens in one gesture', async () => {
    const b = await boot()
    const r1 = await post({ id: 'abc' })
    expect(r1.statusCode).toBe(409)
    expect(r1.json().canClose).toBe(true)
    expect(r1.json().error).toContain('close it to resume here')
    expect(r1.json().holders).toEqual([expect.objectContaining({ pid: 424242, tmux: 'claude-other-9' })])
    expect(b.closed).toEqual([])

    const r2 = await post({ id: 'abc', closeHolders: true })
    expect(r2.statusCode).toBe(201)
    expect(r2.json().key).toBe('abc')
    expect(b.closed).toEqual([424242])
  })
})
