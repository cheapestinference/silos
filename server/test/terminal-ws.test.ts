// terminal-ws.test.ts — PTY half-open handling. Verifies, against a real
// server (app.listen, not inject — a real WS is needed for this) that:
//  1. kill() (DELETE /api/terminals/:id) closes any WS still attached to
//     that terminal — previously it stayed "zombie", pointing at a PTY
//     that no longer existed.
//  2. a client that stops RESPONDING to the server's pings (simulated by
//     pausing the underlying socket's reads — so the ping frame never
//     gets processed or auto-answered) gets terminated after the
//     configured number of failures, freeing the terminal's slot —
//     without this, a "half-open" remote client (a sleeping laptop, a
//     dropped network without a clean FIN) kept the PTY alive forever.
import { describe, it, expect, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WebSocket from 'ws'
import type { FastifyInstance } from 'fastify'
import type { SessionIndex } from '../src/session-index.js'
import { claudeSessionIndex } from '../src/harnesses/claude-code/reader.js'
import { AgentRegistry } from '../src/agent-registry.js'
import { SessionStore } from '../src/session-store.js'
import { NativeStore } from '../src/native-store.js'
import { ChatService } from '../src/chat-service.js'
import { ExecService } from '../src/exec-service.js'
import { CompleteService } from '../src/complete-service.js'
import { PrefsStore } from '../src/prefs-store.js'
import { MemoryService } from '../src/memory-service.js'
import { TerminalService } from '../src/terminal-service.js'
import { AgentStateStore } from '../src/agent-state.js'
import { buildServer, type ServerDeps } from '../src/server.js'

const TOKEN = 't0k-termws'
let app: FastifyInstance | undefined
let terminals: TerminalService | undefined
let index: SessionIndex | undefined
let root = ''

afterEach(async () => {
  terminals?.killAll()
  terminals?.stopReaper()
  await app?.close()
})

async function setup(
  terminalPingMs: number,
  idleMs = 30 * 60_000,
  reaperIntervalMs?: number,
  consoleOpts?: ConstructorParameters<typeof TerminalService>[4],
  extraDeps: Partial<ServerDeps> = {},
): Promise<{ port: number; agentFolder: string }> {
  const base = mkdtempSync(join(tmpdir(), 'deck-termws-'))
  root = join(base, 'projects')
  const agentFolder = mkdtempSync(join(tmpdir(), 'deck-termws-folder-'))
  mkdirSync(root, { recursive: true })
  mkdirSync(join(base, 'data', 'trash'), { recursive: true })
  index = claudeSessionIndex(root, join(base, 'data', 'cache.json'))
  await index.init()
  const registry = new AgentRegistry(join(base, 'data', 'agents.json'))
  registry.load()
  registry.create({ id: 'writer', name: 'Writer', folder: agentFolder })
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
  terminals = new TerminalService(registry, index, idleMs, reaperIntervalMs, consoleOpts)
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
    token: TOKEN,
    liveMs: 120_000,
    terminalPingMs,
    ...extraDeps,
  })
  await app.listen({ port: 0, host: '127.0.0.1' })
  const port = (app.server.address() as { port: number }).port
  return { port, agentFolder }
}

async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const t0 = Date.now()
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timeout waiting for the condition')
    await new Promise((r) => setTimeout(r, 30))
  }
}

describe('/ws/terminal/:id', () => {
  it('kill() closes any WS still attached to that terminal', async () => {
    const { port } = await setup(30_000)
    const created = await app!.inject({ method: 'POST', url: '/api/terminals', headers: { 'x-token': TOKEN }, payload: { agentId: 'writer' } })
    const { id } = created.json() as { id: string }

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/terminal/${id}?token=${TOKEN}`)
    await new Promise((r) => ws.once('open', r))

    const closed = new Promise<void>((resolve) => ws.once('close', () => resolve()))
    terminals!.kill(id) // equivalent to DELETE /api/terminals/:id
    await closed // without the fix, this WS stayed open forever, pointing at an already-dead PTY
  })

  it("answers the client's {op:'ping'} with an empty BINARY frame — never text, which is the pane's output", async () => {
    const { port } = await setup(30_000)
    const created = await app!.inject({ method: 'POST', url: '/api/terminals', headers: { 'x-token': TOKEN }, payload: { agentId: 'writer' } })
    const { id } = created.json() as { id: string }
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/terminal/${id}?token=${TOKEN}`)
    await new Promise((r) => ws.once('open', r))
    const pong = new Promise<{ data: Buffer; isBinary: boolean }>((resolve) => {
      ws.on('message', (data: Buffer, isBinary: boolean) => {
        if (isBinary) resolve({ data, isBinary })
      })
    })
    ws.send(JSON.stringify({ op: 'ping' }))
    const got = await pong
    expect(got.data.length).toBe(0)
    ws.close()
  })

  it('a client that stops responding to pings gets terminated; the reaper frees the terminal without the client ever cooperating', async () => {
    // ping every 50ms, idle=100ms, sweep every 20ms — only for this test.
    const { port } = await setup(50, 100, 20)
    const created = await app!.inject({ method: 'POST', url: '/api/terminals', headers: { 'x-token': TOKEN }, payload: { agentId: 'writer' } })
    const { id } = created.json() as { id: string }

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/terminal/${id}?token=${TOKEN}`)
    await new Promise((r) => ws.once('open', r))

    // simulate a "half-open" client: pause the underlying socket's reads —
    // the server's ping frame never gets processed (the ws library
    // auto-answers with a pong while PARSING the frame; if it's never
    // parsed, there's never a pong) and the TCP socket stays "open" with
    // no real FIN/RST, exactly as would happen with a sleeping laptop or a
    // dropped network with no clean close.
    const raw = (ws as unknown as { _socket: { pause: () => void } })._socket
    raw.pause()

    // full chain: the server detects the missed pongs -> socket.terminate()
    // -> the server-side 'close' -> terminals.detach() (clients down to 0)
    // -> the reaper, seeing clients===0 for idleMs, kills the PTY. Without
    // the fix (neither ping/pong nor the reaper), this NEVER happened with
    // a client that never closes or cooperates.
    await until(() => terminals!.list().length === 0, 5000)
  }, 8000)
})

// the real console over the wire: POST /api/console → a key; /ws/console/:key
// spawns a tmux client PER socket at the size in the query, so each socket
// receives the full screen on attach and closing it kills only its client.
describe('/ws/console/:key', () => {
  const socket = `silos-termws-${process.pid}`
  afterEach(() => {
    try {
      execFileSync('tmux', ['-L', socket, 'kill-server'], { stdio: 'ignore' })
    } catch {
      /* no server */
    }
    // kill-server leaves the socket FILE behind in /tmp/tmux-$UID — 160 of
    // them had piled up by 25-08. Removing it after the kill keeps /tmp clean.
    try {
      rmSync(join(process.env.TMUX_TMPDIR ?? '/tmp', `tmux-${process.getuid?.() ?? 0}`, socket), { force: true })
    } catch {
      /* best effort */
    }
  })

  it('SILOS_AGENT_STATE reaches the console via the extraEnv merge, alongside whatever the Vault contributes', async () => {
    const agentState = new AgentStateStore(mkdtempSync(join(tmpdir(), 'deck-termws-agentstate-')))
    const spy = vi.spyOn(TerminalService.prototype, 'ensureConsole')
    try {
      await setup(30_000, undefined, undefined, { tmuxSocket: socket, command: () => ['bash', '-c', 'sleep 30'] }, { agentState })
      const opened = await app!.inject({ method: 'POST', url: '/api/console', headers: { 'x-token': TOKEN }, payload: { agentId: 'writer' } })
      expect(opened.statusCode).toBe(201)
      expect(spy).toHaveBeenCalledTimes(1)
      const call = spy.mock.calls[0]![0] as { extraEnv?: Record<string, string> }
      expect(call.extraEnv?.SILOS_AGENT_STATE).toBe(agentState.dirFor('writer'))
      // the agent's process env (agent-env.ts): the server's address too
      expect(call.extraEnv?.SILOS_API).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    } finally {
      spy.mockRestore()
    }
  })

  it('two sockets on the same key both get the screen; closing one leaves the other attached', async () => {
    const { port } = await setup(30_000, undefined, undefined, { tmuxSocket: socket, command: () => ['bash', '-c', 'printf "WS-MARK\\n"; sleep 60'] })
    const opened = await app!.inject({ method: 'POST', url: '/api/console', headers: { 'x-token': TOKEN }, payload: { agentId: 'writer' } })
    expect(opened.statusCode).toBe(201)
    const { key } = opened.json() as { key: string }
    expect(key).toMatch(/^[0-9a-f-]{36}$/)

    function client(cols: number, rows: number): Promise<{ ws: WebSocket; out: { value: string } }> {
      return new Promise((resolve) => {
        const out = { value: '' }
        const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/console/${key}?token=${TOKEN}&cols=${cols}&rows=${rows}`)
        ws.on('message', (d) => {
          out.value += String(d)
        })
        ws.on('open', () => resolve({ ws, out }))
      })
    }
    const a = await client(100, 30)
    await until(() => a.out.value.includes('WS-MARK'))
    const b = await client(60, 20)
    await until(() => b.out.value.includes('WS-MARK'))
    const sizes = () =>
      execFileSync('tmux', ['-L', socket, 'list-clients', '-F', '#{client_width}x#{client_height}']).toString().trim().split('\n').filter(Boolean).sort()
    expect(sizes()).toEqual(['100x30', '60x20'])
    a.ws.close()
    await until(() => sizes().length === 1)
    expect(sizes()).toEqual(['60x20'])
    b.ws.close()
    await until(() => sizes().length === 0)
    // the session (the claude) survives its clients
    execFileSync('tmux', ['-L', socket, 'has-session', '-t', `=silos-${key}`], { stdio: 'ignore' })
  }, 20000)

  // The bug (25-08): "new conversation" ran a fresh claude in a tmux keyed
  // BY AGENT. Once it wrote its JSONL (id X) and the user opened X, a second
  // `claude --resume X` started under key X; trashing X killed only that one
  // — the original kept writing X.jsonl (the session "came back") and the
  // next "new conversation" reattached to it (the old chat "reappeared").
  // Now the fresh claude is born with its id (`--session-id`) and that id IS
  // the key: opening the session reattaches, trashing kills, and the next
  // new conversation is a clean claude.
  it('a new conversation is born with its own session id as key; reused until it persists; opening it reattaches; trash kills it', async () => {
    const calls: Array<{ resumeId?: string; sessionId?: string }> = []
    const { agentFolder } = await setup(30_000, undefined, undefined, {
      tmuxSocket: socket,
      command: (o) => {
        calls.push({ resumeId: o.resumeId, sessionId: o.sessionId })
        return ['bash', '-c', 'sleep 60']
      },
    })
    const open = async (payload: object): Promise<string> => {
      const r = await app!.inject({ method: 'POST', url: '/api/console', headers: { 'x-token': TOKEN }, payload })
      expect(r.statusCode).toBe(201)
      return (r.json() as { key: string }).key
    }
    const has = (key: string): boolean => {
      try {
        execFileSync('tmux', ['-L', socket, 'has-session', '-t', `=silos-${key}`], { stdio: 'ignore' })
        return true
      } catch {
        return false
      }
    }
    const a = await open({ agentId: 'writer' })
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    expect(calls).toEqual([{ resumeId: undefined, sessionId: a }])
    // nothing typed yet → the same waiting claude, not another one
    expect(await open({ agentId: 'writer' })).toBe(a)
    expect(calls).toHaveLength(1)
    // the claude writes its first turn → the session now exists
    const folder = agentFolder.replace(/\//g, '-')
    mkdirSync(join(root, folder), { recursive: true })
    writeFileSync(
      join(root, folder, `${a}.jsonl`),
      JSON.stringify({ type: 'user', cwd: agentFolder, sessionId: a, message: { role: 'user', content: 'hi' }, timestamp: new Date().toISOString() }) + '\n',
    )
    await index!.refresh(folder, a, false)
    // opening the session reattaches the SAME claude (no --resume twin)
    expect(await open({ id: a })).toBe(a)
    expect(calls).toHaveLength(1)
    // a new conversation now is a NEW claude
    const b = await open({ agentId: 'writer' })
    expect(b).not.toBe(a)
    expect(calls).toHaveLength(2)
    expect(has(a) && has(b)).toBe(true)
    // trash kills the conversation's claude — and only that one
    const trashed = await app!.inject({ method: 'POST', url: `/api/sessions/${folder}/${a}/trash`, headers: { 'x-token': TOKEN } })
    expect(trashed.statusCode).toBe(200)
    expect(has(a)).toBe(false)
    expect(has(b)).toBe(true)
  }, 20000)

  it('an unknown key just closes the socket', async () => {
    const { port } = await setup(30_000, undefined, undefined, { tmuxSocket: socket })
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/console/nope?token=${TOKEN}&cols=80&rows=24`)
    await new Promise<void>((resolve) => ws.on('close', () => resolve()))
  })
})
