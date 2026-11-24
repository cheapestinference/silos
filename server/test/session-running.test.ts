// session-running.test.ts — GET /api/sessions/:folder/:id says which claudes
// hold the conversation open RIGHT NOW and the account each one really
// spends (its live CLAUDE_CONFIG_DIR), never the account it was pinned to
// (once two conversations pinned to an extra account ran on the
// machine's; one conversation was open twice, on two accounts).
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
import { TerminalService } from '../src/terminal-service.js'
import { AccountsService } from '../src/harnesses/claude-code/accounts.js'
import { procConfigDir } from '../src/harnesses/claude-code/holders.js'
import { fakeIdentity } from './helpers/fake-claude-auth.js'

describe('GET /api/sessions/:folder/:id — running', () => {
  let app: FastifyInstance
  afterEach(async () => {
    await app?.close()
  })

  async function boot(locks: Array<{ pid: number; tmux?: string }>, envs: Record<number, string | null>) {
    const base = mkdtempSync(join(tmpdir(), 'deck-'))
    const root = join(base, 'projects')
    mkdirSync(join(root, '-tmp-p'), { recursive: true })
    writeFileSync(join(root, '-tmp-p', 'abc.jsonl'), '{"type":"user","cwd":"/tmp/p","message":{"role":"user","content":"hello"}}\n')
    const sessionsDir = join(base, 'claude-sessions')
    mkdirSync(sessionsDir)
    for (const l of locks)
      writeFileSync(join(sessionsDir, `${l.pid}.json`), JSON.stringify({ pid: l.pid, sessionId: 'abc', cwd: '/tmp/p', ...(l.tmux ? { tmux: l.tmux } : {}) }))
    const dataDir = join(base, 'data')
    const machine = join(base, 'home', '.claude')
    mkdirSync(machine, { recursive: true })
    mkdirSync(join(dataDir, 'claude-accounts', 'kai'), { recursive: true })
    const accounts = new AccountsService({ dataDir, defaultConfigDir: machine, identity: fakeIdentity(machine) })
    const index = claudeSessionIndex(root, join(dataDir, 'cache.json'))
    await index.init()
    const registry = new AgentRegistry(join(dataDir, 'agents.json'))
    registry.load()
    const terminals = new TerminalService(registry, index, undefined, undefined, {
      tmuxSocket: join(base, 'tmux.sock'),
      sessionsDir,
      isAlive: () => true,
      signal: () => {},
      configDirOf: (pid) => (envs[pid] === 'KAI' ? join(dataDir, 'claude-accounts', 'kai') : (envs[pid] ?? null)),
    })
    const chat = new ChatService({
      registry,
      native: new NativeStore(join(dataDir, 'native.json')),
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
      store: new SessionStore(root, dataDir),
      native: new NativeStore(join(dataDir, 'native.json')),
      chat,
      exec: new ExecService(registry),
      complete: new CompleteService(registry, index),
      prefs: new PrefsStore(dataDir),
      memory: new MemoryService(root, dataDir, registry),
      terminals,
      accounts,
      token: 't0k',
      liveMs: 120_000,
    })
  }
  const get = () => app.inject({ method: 'GET', url: '/api/sessions/-tmp-p/abc', headers: { 'x-token': 't0k' } })

  it('open twice, on two accounts: each holder with the account its process really runs on', async () => {
    await boot(
      [
        { pid: 11, tmux: 'silos-abc:@1.%1' },
        { pid: 22, tmux: 'claude-other-9:@0.%0' },
      ],
      { 11: 'KAI', 22: null },
    )
    const running = (await get()).json().running
    expect(running).toHaveLength(2)
    expect(running).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ pid: 11, providerId: 'account:kai', silos: true }),
        expect.objectContaining({ pid: 22, providerId: 'default', silos: false, tmux: 'claude-other-9' }),
      ]),
    )
  })

  it('an unknown config dir is said as itself (no account), never folded into one', async () => {
    await boot([{ pid: 33 }], { 33: '/somewhere/else' })
    expect((await get()).json().running).toEqual([expect.objectContaining({ pid: 33, providerId: null, configDir: '/somewhere/else' })])
  })

  it('nobody holds it → an empty list', async () => {
    await boot([], {})
    expect((await get()).json().running).toEqual([])
  })
})

describe('procConfigDir — the one name read from a live environ', () => {
  it('reads CLAUDE_CONFIG_DIR and nothing else; unset or unreadable → null', () => {
    const proc = mkdtempSync(join(tmpdir(), 'proc-'))
    mkdirSync(join(proc, '7'))
    writeFileSync(join(proc, '7', 'environ'), 'ANTHROPIC_API_KEY=secret\0CLAUDE_CONFIG_DIR=/x/kai\0HOME=/h\0')
    mkdirSync(join(proc, '8'))
    writeFileSync(join(proc, '8', 'environ'), 'HOME=/h\0')
    expect(procConfigDir(7, proc)).toBe('/x/kai')
    expect(procConfigDir(8, proc)).toBeNull()
    expect(procConfigDir(9, proc)).toBeNull()
  })
})
