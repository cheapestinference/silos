import { describe, it, expect, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
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
import { TerminalService } from '../src/terminal-service.js'
import { buildServer } from '../src/server.js'
import { asOwner } from './helpers/owner.js'

// A console's NEWBORN session: the real console starts a
// fresh claude with --session-id <key>; the first prompt typed into it
// creates the JSONL, whose first lines (last-prompt / mode /
// permission-mode) carry no cwd — the cwd arrives a few writes later.
// The watcher fires on those first bytes, the client opens the session
// and asks for ITS console (POST /api/console {id}). Reattaching to a
// console that already runs needs no cwd — only spawning does. Answering
// 400 "session has no cwd" here bounced the owner to "View in chat
// instead", and the chat engine then FORKED the console-born session:
// the terminal kept an idle claude nobody could reach, the conversation
// went on as an SDK twin.
describe('POST /api/console — a newborn console session', () => {
  const socket = `silos-newborn-${process.pid}`
  let app: FastifyInstance, terminals: TerminalService

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

  it('reattaches to the running console even before the transcript has written its cwd', async () => {
    const base = mkdtempSync(join(tmpdir(), 'deck-'))
    const root = join(base, 'projects')
    const folder = mkdtempSync(join(tmpdir(), 'deck-folder-'))
    mkdirSync(root, { recursive: true })
    mkdirSync(join(base, 'data', 'trash'), { recursive: true })
    const index = claudeSessionIndex(root, join(base, 'data', 'cache.json'))
    await index.init()
    const registry = new AgentRegistry(join(base, 'data', 'agents.json'))
    registry.load()
    registry.create({ id: 'writer', name: 'Writer', folder })
    const store = new SessionStore(root, join(base, 'data'))
    const native = new NativeStore(join(base, 'data', 'native.json'))
    const prefs = new PrefsStore(join(base, 'data'))
    const memory = new MemoryService(root, join(base, 'data'), registry)
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
    terminals = new TerminalService(registry, index, undefined, undefined, {
      tmuxSocket: socket,
      appendDir: join(base, 'append'),
      envDir: join(base, 'env'),
      sessionsDir: join(base, 'claude-sessions'),
      command: () => ['bash', '-c', 'sleep 60'],
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
      token: 't0k',
      liveMs: 120_000,
    })
    asOwner(app, 't0k')

    // 1. the new conversation's console is already running, born with its id
    const id = randomUUID()
    expect(await terminals.ensureConsole({ cwd: folder, key: id, sessionId: id, agentId: 'writer' })).toEqual({ key: id, theme: 'dark' })

    // 2. the first prompt creates the JSONL — header lines first, no cwd yet
    const mf = mungePath(folder)
    mkdirSync(join(root, mf), { recursive: true })
    writeFileSync(
      join(root, mf, `${id}.jsonl`),
      [
        `{"type":"last-prompt","leafUuid":"x","sessionId":"${id}"}`,
        `{"type":"mode","mode":"normal","sessionId":"${id}"}`,
        `{"type":"permission-mode","permissionMode":"bypassPermissions","sessionId":"${id}"}`,
      ].join('\n') + '\n',
    )
    const meta = await index.refresh(mf, id)
    expect(meta?.cwd).toBeNull() // the race the client lands in

    // 3. the client opens the session and asks for its console
    const res = await app.inject({ method: 'POST', url: '/api/console', payload: { id } })
    expect(res.statusCode).toBe(201)
    expect(res.json()).toEqual({ key: id, theme: 'dark' })
  })

  // the even earlier race: the watcher has not indexed the JSONL at all
  // (no meta), but the console born with that id is running — still its
  // console, still a 201. With neither, the 400 stands.
  it('reattaches before the transcript is even indexed, and still refuses when nothing runs', async () => {
    const base = mkdtempSync(join(tmpdir(), 'deck-'))
    const root = join(base, 'projects')
    const folder = mkdtempSync(join(tmpdir(), 'deck-folder-'))
    mkdirSync(root, { recursive: true })
    mkdirSync(join(base, 'data', 'trash'), { recursive: true })
    const index = claudeSessionIndex(root, join(base, 'data', 'cache.json'))
    await index.init()
    const registry = new AgentRegistry(join(base, 'data', 'agents.json'))
    registry.load()
    registry.create({ id: 'writer', name: 'Writer', folder })
    const store = new SessionStore(root, join(base, 'data'))
    const native = new NativeStore(join(base, 'data', 'native.json'))
    const prefs = new PrefsStore(join(base, 'data'))
    const memory = new MemoryService(root, join(base, 'data'), registry)
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
    terminals = new TerminalService(registry, index, undefined, undefined, {
      tmuxSocket: socket,
      appendDir: join(base, 'append'),
      envDir: join(base, 'env'),
      sessionsDir: join(base, 'claude-sessions'),
      command: () => ['bash', '-c', 'sleep 60'],
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
      token: 't0k',
      liveMs: 120_000,
    })
    asOwner(app, 't0k')

    const id = randomUUID()
    expect(await terminals.ensureConsole({ cwd: folder, key: id, sessionId: id, agentId: 'writer', theme: 'light' })).toEqual({ key: id, theme: 'light' })
    expect(index.allSessions().some((m) => m.id === id)).toBe(false)

    const res = await app.inject({ method: 'POST', url: '/api/console', payload: { id } })
    expect(res.statusCode).toBe(201)
    expect(res.json()).toEqual({ key: id, theme: 'light' }) // the birth theme, not a default

    const none = await app.inject({ method: 'POST', url: '/api/console', payload: { id: randomUUID() } })
    expect(none.statusCode).toBe(400)
    expect(none.json().error).toMatch(/no cwd/)
  })
})
