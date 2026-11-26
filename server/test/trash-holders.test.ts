import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
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
import { describeHolders, readHolderLock, type SessionHolder } from '../src/harnesses/claude-code/holders.js'

// A claude OUTSIDE Silos' consoles (launched by hand, by a retry wrapper,
// orphaned from a dead pane) still holds a conversation through its
// ~/.claude/sessions lock, and the trash route refuses — rightly: moving the
// JSONL under a live writer brings it straight back. But "a live claude
// (pid N) still holds this conversation" read as "another conversation is
// running" (a stray row born from an
// auto-retry tmux the night before). The lock file already says WHERE that
// claude lives (tmux target, derived name, cwd, status), so the refusal
// names the place, the 409 carries the holders structured, and the owner
// can ask Silos to close them first (`closeHolders: true`) instead of
// hunting a pid.
describe('describeHolders — where a holder lives, in words', () => {
  const base = { pid: 1787366, cwd: '/home/user/acme', startedAt: null, updatedAt: null, status: null, kind: 'interactive' }

  it('names the tmux session a holder runs in and says it is outside Silos', () => {
    const h: SessionHolder = { ...base, tmux: 'claude-retry-1786661-1793049620082', name: 'acme-91' }
    const s = describeHolders([h], Date.now())
    expect(s).toContain('outside Silos')
    expect(s).toContain('tmux "claude-retry-1786661-1793049620082"')
    expect(s).toContain('pid 1787366')
  })

  it('a holder in a silos-* tmux is a Silos console, not a stranger', () => {
    const h: SessionHolder = { ...base, tmux: 'silos-30e20773-527c-47c9-9dc4-aac1654c1ef8', name: null }
    expect(describeHolders([h], Date.now())).toMatch(/Silos console/)
    expect(describeHolders([h], Date.now())).not.toContain('outside Silos')
  })

  it('without a tmux it falls back to the derived name, then to the bare pid', () => {
    expect(describeHolders([{ ...base, tmux: null, name: 'acme-91' }], Date.now())).toContain('"acme-91"')
    expect(describeHolders([{ ...base, tmux: null, name: null }], Date.now())).toContain('pid 1787366')
  })

  it('says how long it has been idle when the lock carries status + updatedAt', () => {
    const now = Date.now()
    const h: SessionHolder = { ...base, tmux: 'claude-retry-1', name: null, status: 'idle', updatedAt: now - 12 * 3_600_000 }
    expect(describeHolders([h], now)).toContain('idle for 12 h')
  })

  it('counts several holders', () => {
    const s = describeHolders(
      [
        { ...base, tmux: 'a', name: null },
        { ...base, pid: 2, tmux: 'b', name: null },
      ],
      Date.now(),
    )
    expect(s).toMatch(/^2 claudes/)
    expect(s).toContain('tmux "a"')
    expect(s).toContain('tmux "b"')
  })
})

describe('readHolderLock — the ~/.claude/sessions lock, as written by claude 2.1.x', () => {
  const raw = JSON.stringify({
    pid: 1787366,
    sessionId: 'abc',
    cwd: '/home/user/acme',
    startedAt: 1793049686533,
    version: '2.1.310',
    kind: 'interactive',
    tmux: 'claude-retry-1786661-1793049620082:@0.%0',
    name: 'acme-91',
    status: 'idle',
    updatedAt: 1793049704394,
  })

  it('keeps the tmux SESSION (drops the window/pane suffix) and the derived name', () => {
    const h = readHolderLock(raw, 'abc', () => true)
    expect(h).toMatchObject({
      pid: 1787366,
      tmux: 'claude-retry-1786661-1793049620082',
      name: 'acme-91',
      status: 'idle',
      updatedAt: 1793049704394,
      cwd: '/home/user/acme',
    })
  })

  it('is null for another session, a dead pid, or junk', () => {
    expect(readHolderLock(raw, 'other', () => true)).toBeNull()
    expect(readHolderLock(raw, 'abc', () => false)).toBeNull()
    expect(readHolderLock('{not json', 'abc', () => true)).toBeNull()
    expect(readHolderLock(JSON.stringify({ sessionId: 'abc' }), 'abc', () => true)).toBeNull()
  })

  // claude stamps procStart (its process's kernel start ticks) into the
  // lock so a recycled pid can be told from the claude that died. A lock
  // whose pid now belongs to ANOTHER process is no holder: without the
  // check, «Close and open here» SIGHUPed an innocent process and
  // dead-ended on «it did not exit when asked».
  it('a reused pid (procStart differs from the live process) is no holder; a matching or unverifiable one stands', () => {
    const withStart = JSON.stringify({ pid: 1787366, sessionId: 'abc', procStart: '2446021866', startedAt: 1793049686533 })
    expect(
      readHolderLock(
        withStart,
        'abc',
        () => true,
        () => '999',
      ),
    ).toBeNull()
    expect(
      readHolderLock(
        withStart,
        'abc',
        () => true,
        () => '2446021866',
      ),
    ).toMatchObject({ pid: 1787366 })
    // off Linux / unreadable stat → conservative: the lock stands
    expect(
      readHolderLock(
        withStart,
        'abc',
        () => true,
        () => null,
      ),
    ).toMatchObject({ pid: 1787366 })
    // an old claude's lock without procStart: nothing to verify against
    expect(
      readHolderLock(
        raw,
        'abc',
        () => true,
        () => '999',
      ),
    ).toMatchObject({ pid: 1787366 })
    // claude may write the ticks as a number
    const numeric = JSON.stringify({ pid: 1787366, sessionId: 'abc', procStart: 2446021866 })
    expect(
      readHolderLock(
        numeric,
        'abc',
        () => true,
        () => '2446021866',
      ),
    ).toMatchObject({ pid: 1787366 })
    expect(
      readHolderLock(
        numeric,
        'abc',
        () => true,
        () => '999',
      ),
    ).toBeNull()
  })
})

describe('POST /api/sessions/:folder/:id/trash with a holder outside Silos', () => {
  let app: FastifyInstance
  afterEach(async () => {
    await app?.close()
  })

  interface Boot {
    base: string
    sessionsDir: string
    closed: number[]
    alive: Set<number>
  }

  async function boot(): Promise<Boot> {
    const base = mkdtempSync(join(tmpdir(), 'deck-'))
    const root = join(base, 'projects')
    mkdirSync(join(root, '-tmp-p'), { recursive: true })
    mkdirSync(join(base, 'data', 'trash'), { recursive: true })
    writeFileSync(join(root, '-tmp-p', 'abc.jsonl'), '{"type":"user","cwd":"/tmp/p","message":{"role":"user","content":"hello"}}\n')
    const sessionsDir = join(base, 'claude-sessions')
    mkdirSync(sessionsDir)
    const alive = new Set([1787366])
    writeFileSync(
      join(sessionsDir, '1787366.json'),
      JSON.stringify({
        pid: 1787366,
        sessionId: 'abc',
        cwd: '/tmp/p',
        kind: 'interactive',
        tmux: 'claude-retry-1786661-1793049620082:@0.%0',
        name: 'p-91',
        status: 'idle',
        updatedAt: Date.now() - 3_600_000,
      }),
    )
    const index = claudeSessionIndex(root, join(base, 'data', 'cache.json'))
    await index.init()
    const registry = new AgentRegistry(join(base, 'data', 'agents.json'))
    registry.load()
    const closed: number[] = []
    const terminals = new TerminalService(registry, index, undefined, undefined, {
      tmuxSocket: join(base, 'tmux.sock'),
      sessionsDir,
      isAlive: (pid) => alive.has(pid),
      // the signal is the ONLY side effect of closing a holder; here it just "kills"
      signal: (pid) => {
        closed.push(pid)
        alive.delete(pid)
      },
    })
    terminals.hasConsole = () => false
    terminals.killConsoleAndWait = async () => {}
    const chat = new ChatService({
      registry,
      native: new NativeStore(join(base, 'data', 'native.json')),
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
      native: new NativeStore(join(base, 'data', 'native.json')),
      chat,
      exec: new ExecService(registry),
      complete: new CompleteService(registry, index),
      prefs: new PrefsStore(join(base, 'data')),
      memory: new MemoryService(root, join(base, 'data'), registry),
      terminals,
      token: 't0k',
      liveMs: 120_000,
    })
    return { base, sessionsDir, closed, alive }
  }

  const trash = (body?: object) =>
    app.inject({ method: 'POST', url: '/api/sessions/-tmp-p/abc/trash', headers: { 'x-token': 't0k' }, ...(body ? { payload: body } : {}) })
  const inTrash = (b: Boot) => existsSync(join(b.base, 'data', 'trash', '-tmp-p', 'abc.jsonl'))

  it('refuses with 409, names where the claude lives and hands the holders back structured', async () => {
    const b = await boot()
    const res = await trash({ thread: true })
    expect(res.statusCode).toBe(409)
    const body = res.json()
    expect(body.error).toContain('outside Silos')
    expect(body.error).toContain('tmux "claude-retry-1786661-1793049620082"')
    expect(body.holders).toHaveLength(1)
    expect(body.holders[0]).toMatchObject({ pid: 1787366, tmux: 'claude-retry-1786661-1793049620082', name: 'p-91' })
    expect(body.canClose).toBe(true)
    expect(b.closed).toEqual([])
    expect(inTrash(b)).toBe(false)
  })

  it('with closeHolders it signals the holder, waits for it to be gone, then trashes', async () => {
    const b = await boot()
    const res = await trash({ thread: true, closeHolders: true })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ ok: true, closed: [1787366] })
    expect(b.closed).toEqual([1787366])
    expect(inTrash(b)).toBe(true)
  })

  it('a holder that survives the signal keeps the refusal honest (409, still named)', async () => {
    const b2 = await bootStubborn()
    const res = await trash({ thread: true, closeHolders: true })
    expect(res.statusCode).toBe(409)
    expect(res.json().error).toContain('tmux "claude-retry-1786661-1793049620082"')
    expect(inTrash(b2)).toBe(false)
  })

  async function bootStubborn(): Promise<Boot> {
    const base = mkdtempSync(join(tmpdir(), 'deck-'))
    const root = join(base, 'projects')
    mkdirSync(join(root, '-tmp-p'), { recursive: true })
    mkdirSync(join(base, 'data', 'trash'), { recursive: true })
    writeFileSync(join(root, '-tmp-p', 'abc.jsonl'), '{"type":"user","cwd":"/tmp/p","message":{"role":"user","content":"hello"}}\n')
    const sessionsDir = join(base, 'claude-sessions')
    mkdirSync(sessionsDir)
    writeFileSync(
      join(sessionsDir, '1787366.json'),
      JSON.stringify({ pid: 1787366, sessionId: 'abc', cwd: '/tmp/p', tmux: 'claude-retry-1786661-1793049620082:@0.%0' }),
    )
    const index = claudeSessionIndex(root, join(base, 'data', 'cache.json'))
    await index.init()
    const registry = new AgentRegistry(join(base, 'data', 'agents.json'))
    registry.load()
    const terminals = new TerminalService(registry, index, undefined, undefined, {
      tmuxSocket: join(base, 'tmux.sock'),
      sessionsDir,
      isAlive: () => true,
      signal: () => {},
      holderExitGraceMs: 50,
    })
    terminals.hasConsole = () => false
    terminals.killConsoleAndWait = async () => {}
    const chat = new ChatService({
      registry,
      native: new NativeStore(join(base, 'data', 'native.json')),
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
      native: new NativeStore(join(base, 'data', 'native.json')),
      chat,
      exec: new ExecService(registry),
      complete: new CompleteService(registry, index),
      prefs: new PrefsStore(join(base, 'data')),
      memory: new MemoryService(root, join(base, 'data'), registry),
      terminals,
      token: 't0k',
      liveMs: 120_000,
    })
    return { base, sessionsDir, closed: [], alive: new Set([1787366]) }
  }
})
