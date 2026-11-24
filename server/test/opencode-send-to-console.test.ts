// opencode-send-to-console.test.ts — handing a console what the owner says,
// on both harnesses:
//  · POST /api/console/:key/send — an OpenCode console is a TUI with its own
//    loopback HTTP server (port + basic-auth password in the Silos-owned
//    console record): /tui/append-prompt then /tui/submit-prompt, asserted
//    against a REAL stub HTTP server on a free port; a Claude console gets
//    the text typed literally (tmux send-keys -l --), then Enter.
//  · POST /api/sessions/:folder/:id/answer — an OpenCode session's question
//    is a permission ask, answered through its ask file (never a digit in
//    the TUI); a Claude session keeps digit + Enter (consoleSendKeys).
import { describe, it, expect, afterEach, vi } from 'vitest'
import { createServer, type Server, type IncomingMessage } from 'node:http'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
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
import { TerminalService } from '../src/terminal-service.js'
import { buildServer } from '../src/server.js'
import { AgentStateStore } from '../src/agent-state.js'
import { appendAndSubmit, TuiSendError } from '../src/harnesses/opencode/tui-client.js'
import { AsksStore } from '../src/asks-store.js'
import { ProvidersStore } from '../src/providers-store.js'
import { ConversationPrefsStore } from '../src/conversation-prefs.js'
import { mungePath } from '../src/agent-registry.js'
import type { HarnessReader, SessionRef } from '../src/harnesses/contract.js'
import type { SessionMeta } from '../src/types.js'
import { tmuxExec } from '../src/terminal-service.js'
import { asOwner } from './helpers/owner.js'

// tmux passes through to the real one (its own socket); a test may record
// tmux argv by setting `tmuxImpl` (the service's injected runner)
let tmuxImpl: ((args: readonly string[]) => string | Buffer) | null = null

// a minimal second reader so the index holds OpenCode sessions
class FakeOpenCodeReader implements HarnessReader {
  readonly harness = 'opencode' as const
  metas = new Map<string, SessionMeta>()
  ownsId(id: string): boolean {
    return id.startsWith('ses_')
  }
  list(): SessionMeta[] {
    return [...this.metas.values()]
  }
  async init(): Promise<void> {}
  getMeta(_f: string, id: string): SessionMeta | null {
    return this.metas.get(id) ?? null
  }
  getContext(): null {
    return null
  }
  async readTurns(): Promise<never[]> {
    return []
  }
  async refresh(_f: string, id: string): Promise<SessionMeta | null> {
    return this.metas.get(id) ?? null
  }
  remove(): void {}
  watch(_cb: (ref: SessionRef, kind: 'created' | 'updated' | 'removed') => void): () => void {
    return () => {}
  }
}

type Hit = { method: string; url: string; auth: string | undefined; body: string }

// a stand-in for the OpenCode TUI's HTTP server: records every request,
// answers `status(url)` (default 200 `true`)
async function stubTui(
  status: (url: string) => number = () => 200,
  reply: (url: string) => string | undefined = () => undefined,
): Promise<{ port: number; hits: Hit[]; srv: Server }> {
  const hits: Hit[] = []
  const srv = createServer((req: IncomingMessage, res) => {
    let body = ''
    req.on('data', (c) => {
      body += c
    })
    req.on('end', () => {
      hits.push({ method: req.method ?? '', url: req.url ?? '', auth: req.headers.authorization, body })
      const s = status(req.url ?? '')
      res.writeHead(s, { 'Content-Type': 'application/json' }).end(s === 200 ? (reply(req.url ?? '') ?? 'true') : '{"error":"x"}')
    })
  })
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()))
  const addr = srv.address()
  return { port: typeof addr === 'object' && addr ? addr.port : 0, hits, srv }
}

const basic = (pw: string): string => `Basic ${Buffer.from(`silos:${pw}`).toString('base64')}`

describe('appendAndSubmit', () => {
  const servers: Server[] = []
  afterEach(async () => {
    for (const s of servers.splice(0)) await new Promise((r) => s.close(r))
  })

  it('POSTs append-prompt { text } then submit-prompt (no body), both with basic auth silos:<password>', async () => {
    const tui = await stubTui()
    servers.push(tui.srv)
    await appendAndSubmit({ port: tui.port, password: 'pw-1', text: 'fix the "bug"\nplease' })
    expect(tui.hits.map((h) => [h.method, h.url])).toEqual([
      ['POST', '/tui/append-prompt'],
      ['POST', '/tui/submit-prompt'],
    ])
    expect(JSON.parse(tui.hits[0]!.body)).toEqual({ text: 'fix the "bug"\nplease' })
    expect(tui.hits[1]!.body).toBe('')
    expect(tui.hits.every((h) => h.auth === basic('pw-1'))).toBe(true)
  })

  it('a 401 on append stops before submit; the error never carries the password', async () => {
    const tui = await stubTui((u) => (u === '/tui/append-prompt' ? 401 : 200))
    servers.push(tui.srv)
    const err = await appendAndSubmit({ port: tui.port, password: 'sekrit-pw', text: 'x' }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(TuiSendError)
    expect(String((err as Error).message)).toMatch(/401/)
    expect(String((err as Error).message)).not.toContain('sekrit-pw')
    expect(tui.hits.map((h) => h.url)).toEqual(['/tui/append-prompt'])
  })

  it('connection refused → TuiSendError', async () => {
    const tui = await stubTui()
    const port = tui.port
    await new Promise((r) => tui.srv.close(r))
    await expect(appendAndSubmit({ port, password: 'p', text: 'x' })).rejects.toBeInstanceOf(TuiSendError)
  })

  it('uses the injected fetch', async () => {
    const fetchImpl = vi.fn(async () => new Response('true', { status: 200 }))
    await appendAndSubmit({ port: 1, password: 'p', text: 'hi', fetchImpl: fetchImpl as unknown as typeof fetch })
    expect(fetchImpl.mock.calls.map((c) => (c as unknown[])[0])).toEqual(['http://127.0.0.1:1/tui/append-prompt', 'http://127.0.0.1:1/tui/submit-prompt'])
  })
})

describe('POST /api/console/:key/send and /answer — OpenCode and Claude', () => {
  let app: FastifyInstance, terminals: TerminalService
  const servers: Server[] = []
  afterEach(async () => {
    terminals?.stopReaper()
    await app?.close()
    for (const s of servers.splice(0)) await new Promise((r) => s.close(r))
    vi.restoreAllMocks()
  })

  async function setup(opts: { tuiFetch?: typeof fetch } = {}) {
    const base = mkdtempSync(join(tmpdir(), 'deck-send-'))
    const root = join(base, 'projects')
    const data = join(base, 'data')
    const folder = mkdtempSync(join(tmpdir(), 'deck-send-folder-'))
    mkdirSync(root, { recursive: true })
    mkdirSync(join(data, 'trash'), { recursive: true })
    // a Claude session on disk, for the /answer Claude path
    const claudeId = '11111111-2222-4333-8444-555555555555'
    mkdirSync(join(root, mungePath(folder)), { recursive: true })
    writeFileSync(
      join(root, mungePath(folder), `${claudeId}.jsonl`),
      JSON.stringify({
        type: 'user',
        uuid: 'u1',
        sessionId: claudeId,
        cwd: folder,
        timestamp: new Date().toISOString(),
        message: { role: 'user', content: 'hi' },
      }) + '\n',
    )
    const index = claudeSessionIndex(root, join(data, 'cache.json'))
    const reader = new FakeOpenCodeReader()
    index.addReader(reader)
    await index.init()
    const registry = new AgentRegistry(join(data, 'agents.json'))
    registry.load()
    registry.create({ id: 'writer', name: 'Writer', folder })
    registry.create({ id: 'oc', name: 'Oc', folder, framework: 'opencode' })
    const agentState = new AgentStateStore(join(data, 'agent-state'))
    const asks = new AsksStore(agentState, { dataDir: data, ttlMs: 0 })
    const agentDb = new Map<string, string>()
    const store = new SessionStore(root, data)
    const native = new NativeStore(join(data, 'native.json'))
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
    const consolesDir = join(base, 'consoles')
    terminals = new TerminalService(registry, index, undefined, undefined, {
      tmuxSocket: `silos-send-${process.pid}`,
      appendDir: join(base, 'append'),
      envDir: join(base, 'env'),
      sessionsDir: join(base, 'claude-sessions'),
      consolesDir,
      tmuxRunner: (args, opts) => (tmuxImpl ? tmuxImpl(args) : tmuxExec(args, opts)),
    })
    const providers = new ProvidersStore(data)
    const convPrefs = new ConversationPrefsStore(data)
    app = buildServer({
      index,
      registry,
      store,
      native,
      chat,
      exec: new ExecService(registry),
      complete: new CompleteService(registry, index),
      prefs: new PrefsStore(data),
      memory: new MemoryService(root, data, registry),
      terminals,
      token: 't0k',
      liveMs: 120_000,
      agentState,
      dataDir: data,
      asks,
      providers,
      convPrefs,
      engines: { opencode: { agentOfDb: (id: string) => agentDb.get(id) ?? null, ...(opts.tuiFetch ? { tuiFetch: opts.tuiFetch } : {}) } },
    })
    asOwner(app, 't0k')
    // a console record exactly as TerminalService writes it before new-session
    const record = (key: string, r: Record<string, unknown>): void => {
      mkdirSync(consolesDir, { recursive: true })
      writeFileSync(join(consolesDir, `${key}.json`), JSON.stringify({ key, agentId: 'oc', harness: 'opencode', createdMs: Date.now(), ...r }), { mode: 0o600 })
    }
    const putSession = (id: string): void => {
      reader.metas.set(id, {
        id,
        folder: mungePath(folder),
        cwd: folder,
        mtime: Date.now(),
        startedAt: Date.now(),
        harness: 'opencode',
      } as unknown as SessionMeta)
      agentDb.set(id, 'oc')
    }
    // an ask exactly as plugin-opencode/silos.ts writes it; returns the
    // Silos-owned dir its reply lands in (never the agent's state dir)
    const ask = (agentId: string, sessionId: string, id: string, askedAt: string, over: Record<string, unknown> = {}): string => {
      const dir = join(agentState.pathFor(agentId), 'asks', sessionId)
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, `${id}.json`), JSON.stringify({ id, sessionId, type: 'bash', pattern: 'ls', askedAt, ...over }))
      return join(data, 'asks-replies', agentId, sessionId)
    }
    return { record, putSession, ask, folder: mungePath(folder), claudeId, providers, convPrefs }
  }

  it('GET /api/search scans the file-backed transcripts and counts an OpenCode session as unsearched — never a 500', async () => {
    const h = await setup()
    h.putSession('ses_db_only')
    const r = await app.inject({ method: 'GET', url: '/api/search?q=nothing-matches' })
    expect(r.statusCode).toBe(200)
    // the Claude transcript on disk is scanned; the OpenCode one is counted, not read
    expect(r.json()).toMatchObject({ hits: [], scanned: 1, unsearched: 1 })
    expect(r.json().unsearchedBy).toEqual({ opencode: 1 })
  })

  it('PATCH prefs on an OpenCode conversation with a LIVE console: live only when its SCREEN already shows the pick; otherwise restart (the relaunch puts the pin first and settles it); no console → next-turn', async () => {
    const h = await setup()
    const ci = h.providers.create({
      label: 'ci',
      baseUrl: 'https://api.ci.test/anthropic',
      apiKey: 'sk-ci-secret-123456',
      models: ['mimo-v2.6-flash', 'deepseek-v4.1-flash'],
    })
    h.putSession('ses_live')
    const providersJson = JSON.stringify({
      providers: [
        {
          id: `silos-${ci.id}`,
          name: 'ci',
          models: { 'mimo-v2.6-flash': { name: 'mimo-v2.6-flash' }, 'deepseek-v4.1-flash': { name: 'deepseek-v4.1-flash' } },
        },
      ],
    })
    const tui = await stubTui(
      () => 200,
      (u) => (u === '/config/providers' ? providersJson : undefined),
    )
    servers.push(tui.srv)
    h.record('k-live', { port: tui.port, serverPassword: 'pw-l' })
    terminals.bindNativeId('k-live', 'ses_live')
    // the screen: the header reads mimo until the owner (or a relaunch) moves it
    const screenSpy = vi.spyOn(terminals, 'consoleScreen').mockImplementation(() => '┃  Build auto · mimo-v2.6-flash ci')
    try {
      const same = await app.inject({
        method: 'PATCH',
        url: `/api/sessions/${h.folder}/ses_live/prefs`,
        payload: { provider: ci.id, model: 'mimo-v2.6-flash' },
      })
      expect(same.statusCode).toBe(200)
      expect(same.json()).toMatchObject({ applied: 'live', prefs: { provider: ci.id, model: 'mimo-v2.6-flash' } })
      const other = await app.inject({
        method: 'PATCH',
        url: `/api/sessions/${h.folder}/ses_live/prefs`,
        payload: { provider: ci.id, model: 'deepseek-v4.1-flash' },
      })
      expect(other.json()).toMatchObject({ applied: 'restart', prefs: { provider: ci.id, model: 'deepseek-v4.1-flash' } })
      // verified 27-10 on OpenCode 1.19.4: POST /session/{id}/model does not move the TUI's selection, and cycling a running process in place trips over entries its providers lack — Silos does neither here
      expect(tui.hits.find((x) => x.method === 'POST' && x.url === '/api/session/ses_live/model')).toBeUndefined()
      expect(tui.hits.find((x) => x.method === 'POST' && x.url === '/tui/publish')).toBeUndefined()
      // a model the running process does not list (never used there) → restart as well
      const ci2 = h.providers.create({ label: 'ci2', baseUrl: 'https://api.ci2.test/anthropic', apiKey: 'sk-ci2-secret-12345', models: ['kimi-k3'] })
      expect(
        (await app.inject({ method: 'PATCH', url: `/api/sessions/${h.folder}/ses_live/prefs`, payload: { provider: ci2.id, model: 'kimi-k3' } })).json(),
      ).toMatchObject({ applied: 'restart' })
    } finally {
      screenSpy.mockRestore()
    }
    // no console at all → the next launch takes the pin
    h.putSession('ses_none')
    expect(
      (await app.inject({ method: 'PATCH', url: `/api/sessions/${h.folder}/ses_none/prefs`, payload: { model: 'mimo-v2.6-flash' } })).json(),
    ).toMatchObject({ applied: 'next-turn' })
  })

  it('PATCH prefs on a Claude conversation with a LIVE console types /model <id> into its pane (applied: live); an unpin or no console → next-turn', async () => {
    const h = await setup()
    const has = vi.spyOn(terminals, 'hasConsole').mockImplementation((key: string) => key === h.claudeId)
    const typed = vi.spyOn(terminals, 'consoleSendLiteral').mockImplementation(() => {})
    try {
      const live = await app.inject({ method: 'PATCH', url: `/api/sessions/${h.folder}/${h.claudeId}/prefs`, payload: { model: 'opus' } })
      expect(live.statusCode).toBe(200)
      expect(live.json()).toMatchObject({ applied: 'live', prefs: { model: 'opus' } })
      expect(typed).toHaveBeenCalledWith(h.claudeId, '/model opus')
      // an unpin has no in-place form
      expect((await app.inject({ method: 'PATCH', url: `/api/sessions/${h.folder}/${h.claudeId}/prefs`, payload: { model: null } })).json()).toMatchObject({
        applied: 'next-turn',
      })
      expect(typed).toHaveBeenCalledTimes(1)
      // the pane refusing the keys → next-turn, never a 5xx
      typed.mockImplementationOnce(() => {
        throw new Error('console not open')
      })
      expect((await app.inject({ method: 'PATCH', url: `/api/sessions/${h.folder}/${h.claudeId}/prefs`, payload: { model: 'sonnet' } })).json()).toMatchObject({
        applied: 'next-turn',
      })
    } finally {
      has.mockRestore()
      typed.mockRestore()
    }
  })

  it('an OpenCode console: append-prompt { text } then submit-prompt on its recorded port, with its password', async () => {
    const h = await setup()
    const tui = await stubTui()
    servers.push(tui.srv)
    h.record('k-oc', { port: tui.port, serverPassword: 'pw-oc' })
    const keys = vi.spyOn(terminals, 'consoleSendKeys')
    const res = await app.inject({ method: 'POST', url: '/api/console/k-oc/send', payload: { text: 'run the tests' } })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true, key: 'k-oc', via: 'tui' })
    expect(tui.hits.map((x) => x.url)).toEqual(['/tui/append-prompt', '/tui/submit-prompt'])
    expect(JSON.parse(tui.hits[0]!.body)).toEqual({ text: 'run the tests' })
    expect(tui.hits.every((x) => x.auth === basic('pw-oc'))).toBe(true)
    expect(keys).not.toHaveBeenCalled()
  })

  it('a ses_ id resolves to the console bound to it', async () => {
    const h = await setup()
    const tui = await stubTui()
    servers.push(tui.srv)
    h.record('born-key', { port: tui.port, serverPassword: 'pw-b' })
    terminals.bindNativeId('born-key', 'ses_abc')
    const res = await app.inject({ method: 'POST', url: '/api/console/ses_abc/send', payload: { text: 'hi' } })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ key: 'born-key', via: 'tui' })
    expect(tui.hits).toHaveLength(2)
  })

  it('the TUI refusing (401) or gone (connection refused) → 502, never keystrokes, no secret in the answer', async () => {
    const h = await setup()
    const tui = await stubTui(() => 401)
    servers.push(tui.srv)
    h.record('k-401', { port: tui.port, serverPassword: 'pw-secret' })
    const dead = await stubTui()
    await new Promise((r) => dead.srv.close(r))
    h.record('k-dead', { port: dead.port, serverPassword: 'pw-secret' })
    const keys = vi.spyOn(terminals, 'consoleSendKeys')
    for (const key of ['k-401', 'k-dead']) {
      const res = await app.inject({ method: 'POST', url: `/api/console/${key}/send`, payload: { text: 'x' } })
      expect(res.statusCode).toBe(502)
      expect(res.body).not.toContain('pw-secret')
      expect(res.body).not.toContain('Basic')
    }
    expect(keys).not.toHaveBeenCalled()
  })

  it('a record with no password → 502, nothing sent', async () => {
    const h = await setup()
    const tui = await stubTui()
    servers.push(tui.srv)
    h.record('k-bad', { port: tui.port, serverPassword: null })
    h.record('k-none', { port: tui.port })
    for (const k of ['k-bad', 'k-none']) {
      const res = await app.inject({ method: 'POST', url: `/api/console/${k}/send`, payload: { text: 'x' } })
      expect(res.statusCode).toBe(502)
    }
    expect(tui.hits).toEqual([])
  })

  it('a record with its password sends the header', async () => {
    const h = await setup()
    const tui = await stubTui()
    servers.push(tui.srv)
    h.record('k-basic', { port: tui.port, serverPassword: 'pw-x' })
    const res = await app.inject({ method: 'POST', url: '/api/console/k-basic/send', payload: { text: 'x' } })
    expect(res.statusCode).toBe(200)
    expect(tui.hits.every((x) => x.auth === basic('pw-x'))).toBe(true)
  })

  it('an OpenCode record without port or password → 502 (no keystrokes)', async () => {
    const h = await setup()
    h.record('k-noport', { serverPassword: 'p' })
    const keys = vi.spyOn(terminals, 'consoleSendKeys')
    const res = await app.inject({ method: 'POST', url: '/api/console/k-noport/send', payload: { text: 'x' } })
    expect(res.statusCode).toBe(502)
    expect(keys).not.toHaveBeenCalled()
  })

  it('the HTTP client is injectable (tuiFetch)', async () => {
    const tuiFetch = vi.fn(async () => new Response('true', { status: 200 }))
    const h = await setup({ tuiFetch: tuiFetch as unknown as typeof fetch })
    h.record('k-inj', { port: 4242, serverPassword: 'p' })
    const res = await app.inject({ method: 'POST', url: '/api/console/k-inj/send', payload: { text: 'x' } })
    expect(res.statusCode).toBe(200)
    expect(tuiFetch.mock.calls.map((c) => (c as unknown[])[0])).toEqual(['http://127.0.0.1:4242/tui/append-prompt', 'http://127.0.0.1:4242/tui/submit-prompt'])
  })

  // records tmux argv for one call, then restores the real tmux;
  // `fail` makes the n-th tmux call throw
  async function recordingTmux<T>(run: () => Promise<T>, fail?: number): Promise<{ seen: string[][]; out: T }> {
    const seen: string[][] = []
    tmuxImpl = (args: readonly string[]) => {
      seen.push([...args])
      if (fail === seen.length) throw new Error('tmux: unknown flag')
      return Buffer.from('')
    }
    try {
      return { seen, out: await run() }
    } finally {
      tmuxImpl = null
    }
  }

  it('a Claude console (no OpenCode record): the text literally (send-keys -l --), then Enter as a key — even a key name or a leading "-"', async () => {
    await setup()
    vi.spyOn(terminals, 'hasConsole').mockImplementation((k) => k === 'claude-key')
    const keys = vi.spyOn(terminals, 'consoleSendKeys')
    const sock = `silos-send-${process.pid}`
    for (const text of ['Enter', '-R', '- item one\n- item two']) {
      const { seen, out: res } = await recordingTmux(() => app.inject({ method: 'POST', url: '/api/console/claude-key/send', payload: { text } }))
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({ ok: true, key: 'claude-key', via: 'keys' })
      expect(seen).toEqual([
        // the guard reads the screen first (no dialog on an empty one)
        ['-L', sock, 'capture-pane', '-p', '-t', '=silos-claude-key:'],
        ['-L', sock, 'send-keys', '-t', '=silos-claude-key:', '-l', '--', text],
        ['-L', sock, 'send-keys', '-t', '=silos-claude-key:', 'Enter'],
      ])
    }
    expect(keys).not.toHaveBeenCalled() // /answer's key-gesture method stays its own
  })

  it('a tmux failure while typing is a 502 (not "console not open"); a console gone before the send is a 404', async () => {
    await setup()
    vi.spyOn(terminals, 'hasConsole').mockImplementation((k) => k === 'claude-key')
    // call 1 reads the screen, call 2 types
    const { out: res } = await recordingTmux(() => app.inject({ method: 'POST', url: '/api/console/claude-key/send', payload: { text: 'x' } }), 2)
    expect(res.statusCode).toBe(502)
    expect(res.json().error).not.toMatch(/not open/)
    vi.spyOn(terminals, 'consoleSendLiteral').mockImplementation(() => {
      throw new Error('console not open')
    })
    expect((await app.inject({ method: 'POST', url: '/api/console/claude-key/send', payload: { text: 'x' } })).statusCode).toBe(404)
  })

  it('a Claude console showing a dialog: 409 { dialog }, NOTHING typed (its Enter would pick an option); an unknown screen still types', async () => {
    await setup()
    vi.spyOn(terminals, 'hasConsole').mockImplementation((k) => k === 'claude-key')
    const trust = ['', ' Do you trust the files in this folder?', '', ' ❯ 1. Yes, proceed', '   2. No, exit', '', ' Enter to confirm · Esc to exit', ''].join(
      '\n',
    )
    let screenNow = trust
    const seen: string[][] = []
    tmuxImpl = (args: readonly string[]) => {
      seen.push([...args])
      return args.includes('capture-pane') ? screenNow : Buffer.from('')
    }
    try {
      const res = await app.inject({ method: 'POST', url: '/api/console/claude-key/send', payload: { text: 'hello' } })
      expect(res.statusCode).toBe(409)
      expect(res.json()).toEqual({ error: 'the console is showing a dialog', dialog: 'trust' })
      expect(seen.filter((a) => a.includes('send-keys'))).toEqual([])
      // the owner answered it: the screen is the prompt again → typed
      screenNow = ['', '> ', '  ? for shortcuts', ''].join('\n')
      const ok = await app.inject({ method: 'POST', url: '/api/console/claude-key/send', payload: { text: 'hello' } })
      expect(ok.statusCode).toBe(200)
      expect(seen.filter((a) => a.includes('send-keys')).length).toBe(2)
    } finally {
      tmuxImpl = null
    }
  })

  it('the /model pick into a console showing a dialog types nothing and waits (next-turn), never a 5xx', async () => {
    const h = await setup()
    vi.spyOn(terminals, 'hasConsole').mockImplementation((key: string) => key === h.claudeId)
    vi.spyOn(terminals, 'consoleScreen').mockReturnValue(['', ' Do you want to proceed?', ' ❯ 1. Yes', '   2. No', ''].join('\n'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const seen: string[][] = []
    tmuxImpl = (args: readonly string[]) => {
      seen.push([...args])
      return Buffer.from('')
    }
    try {
      const res = await app.inject({ method: 'PATCH', url: `/api/sessions/${h.folder}/${h.claudeId}/prefs`, payload: { model: 'opus' } })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toMatchObject({ applied: 'next-turn', prefs: { model: 'opus' } })
      expect(seen.filter((a) => a.includes('send-keys'))).toEqual([])
      expect(warn).toHaveBeenCalled()
    } finally {
      tmuxImpl = null
    }
  })

  it('/answer is the deliberate reply to a dialog: digit + Enter even while the screen shows one', async () => {
    const h = await setup()
    vi.spyOn(terminals, 'hasConsole').mockImplementation((k) => k === h.claudeId)
    vi.spyOn(terminals, 'consoleScreen').mockReturnValue(['', ' Do you want to proceed?', ' ❯ 1. Yes', '   2. No', ''].join('\n'))
    const keys = vi.spyOn(terminals, 'consoleSendKeys').mockImplementation(() => {})
    const res = await app.inject({ method: 'POST', url: `/api/sessions/${h.folder}/${h.claudeId}/answer`, payload: { index: 0 } })
    expect(res.statusCode).toBe(200)
    expect(keys).toHaveBeenCalledWith(h.claudeId, ['1', 'Enter'])
  })

  it('a prompt over 100 KB is a 413, nothing sent', async () => {
    await setup()
    vi.spyOn(terminals, 'hasConsole').mockReturnValue(true)
    const lit = vi.spyOn(terminals, 'consoleSendLiteral').mockImplementation(() => {})
    expect((await app.inject({ method: 'POST', url: '/api/console/k/send', payload: { text: 'a'.repeat(100 * 1024) } })).statusCode).toBe(200)
    expect((await app.inject({ method: 'POST', url: '/api/console/k/send', payload: { text: 'a'.repeat(100 * 1024 + 1) } })).statusCode).toBe(413)
    expect(lit).toHaveBeenCalledTimes(1)
  })

  // /answer on an OpenCode session: its open question is a permission ask
  // (pendingOf: Allow/Deny) — answered through the ask file, never by
  // typing a digit into the TUI.
  it('/answer on an OpenCode session: index 0 writes allow for the newest ask of its own agent; never keystrokes', async () => {
    const h = await setup()
    h.putSession('ses_q')
    h.record('ses_q', { port: 1, serverPassword: 'p' }) // a live console keyed by the id
    const dir = h.ask('oc', 'ses_q', 'perm_old', '2026-10-26T10:00:00.000Z')
    h.ask('oc', 'ses_q', 'perm_new', '2026-10-26T11:00:00.000Z')
    h.ask('writer', 'ses_q', 'perm_forged', '2026-10-26T12:00:00.000Z') // another agent's dir: never counts
    const keys = vi.spyOn(terminals, 'consoleSendKeys')
    const hasConsole = vi.spyOn(terminals, 'hasConsole').mockReturnValue(true)
    const res = await app.inject({ method: 'POST', url: `/api/sessions/${h.folder}/ses_q/answer`, payload: { index: 0 } })
    expect(res.statusCode).toBe(200)
    // explicit: the ask is answered — the column must never fall back to a chat turn
    expect(res.json()).toEqual({ engine: 'ask', ok: true })
    expect(JSON.parse(readFileSync(join(dir, 'perm_new.reply.json'), 'utf8'))).toMatchObject({ status: 'allow' })
    expect(existsSync(join(dir, 'perm_old.reply.json'))).toBe(false)
    expect(keys).not.toHaveBeenCalled()
    expect(hasConsole).not.toHaveBeenCalled()
  })

  it('/answer index 1 → deny; a second answer once the reply waits finds no pending ask (404); no ask → 404; index > 1 → 400', async () => {
    const h = await setup()
    h.putSession('ses_d')
    h.putSession('ses_none')
    const dir = h.ask('oc', 'ses_d', 'perm_1', '2026-10-26T10:00:00.000Z')
    const keys = vi.spyOn(terminals, 'consoleSendKeys')
    const res = await app.inject({ method: 'POST', url: `/api/sessions/${h.folder}/ses_d/answer`, payload: { index: 1 } })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(readFileSync(join(dir, 'perm_1.reply.json'), 'utf8'))).toMatchObject({ status: 'deny' })
    // the store no longer lists it as pending (its reply waits) → nothing left to answer
    const again = await app.inject({ method: 'POST', url: `/api/sessions/${h.folder}/ses_d/answer`, payload: { index: 0 } })
    expect(again.statusCode).toBe(404)
    const none = await app.inject({ method: 'POST', url: `/api/sessions/${h.folder}/ses_none/answer`, payload: { index: 0 } })
    expect(none.statusCode).toBe(404)
    // only 0 (allow) and 1 (deny) exist for an ask
    h.ask('oc', 'ses_none', 'perm_2', '2026-10-26T10:00:00.000Z')
    const two = await app.inject({ method: 'POST', url: `/api/sessions/${h.folder}/ses_none/answer`, payload: { index: 2 } })
    expect(two.statusCode).toBe(400)
    expect(keys).not.toHaveBeenCalled()
  })

  // OpenCode's question tool: answered with its own option labels, through
  // the same reply file — never a digit in the TUI, never a chat turn
  it("/answer on an OpenCode question: the picked option, or the form's answers, written as label lists", async () => {
    const h = await setup()
    h.putSession('ses_one')
    h.putSession('ses_two')
    const one = [
      {
        question: 'Deploy?',
        header: '',
        options: [
          { label: 'Now', description: '' },
          { label: 'Wait', description: '' },
        ],
      },
    ]
    const two = [
      ...one,
      {
        question: 'Where?',
        header: '',
        options: [
          { label: 'eu', description: '' },
          { label: 'us', description: '' },
        ],
        multiple: true,
      },
    ]
    const d1 = h.ask('oc', 'ses_one', 'que_1', '2026-11-01T10:00:00.000Z', { type: 'question', pattern: null, questions: one })
    const d2 = h.ask('oc', 'ses_two', 'que_2', '2026-11-01T10:00:00.000Z', { type: 'question', pattern: null, questions: two })
    const keys = vi.spyOn(terminals, 'consoleSendKeys')
    const r1 = await app.inject({ method: 'POST', url: `/api/sessions/${h.folder}/ses_one/answer`, payload: { index: 1 } })
    expect(r1.json()).toEqual({ engine: 'ask', ok: true })
    expect(JSON.parse(readFileSync(join(d1, 'que_1.reply.json'), 'utf8'))).toMatchObject({ status: 'answer', answers: [['Wait']] })
    // two parts: one click cannot answer them — the form's answers can
    expect((await app.inject({ method: 'POST', url: `/api/sessions/${h.folder}/ses_two/answer`, payload: { index: 0 } })).statusCode).toBe(400)
    expect((await app.inject({ method: 'POST', url: `/api/sessions/${h.folder}/ses_two/answer`, payload: { index: 0, answers: [['Now']] } })).statusCode).toBe(
      400,
    )
    expect((await app.inject({ method: 'POST', url: `/api/sessions/${h.folder}/ses_two/answer`, payload: { index: 0, answers: 'Now' } })).statusCode).toBe(400)
    const r2 = await app.inject({ method: 'POST', url: `/api/sessions/${h.folder}/ses_two/answer`, payload: { index: 0, answers: [['Now'], ['eu', 'us']] } })
    expect(r2.json()).toEqual({ engine: 'ask', ok: true })
    expect(JSON.parse(readFileSync(join(d2, 'que_2.reply.json'), 'utf8'))).toMatchObject({ status: 'answer', answers: [['Now'], ['eu', 'us']] })
    expect(keys).not.toHaveBeenCalled()
  })

  it("/answer with a form's answers on a Claude session goes as a chat turn — digits answer one question only", async () => {
    const h = await setup()
    vi.spyOn(terminals, 'hasConsole').mockReturnValue(true)
    const keys = vi.spyOn(terminals, 'consoleSendKeys').mockImplementation(() => {})
    const res = await app.inject({ method: 'POST', url: `/api/sessions/${h.folder}/${h.claudeId}/answer`, payload: { index: 0, answers: [['A'], ['B']] } })
    expect(res.json()).toEqual({ engine: 'chat' })
    expect(keys).not.toHaveBeenCalled()
  })

  it('/answer on a Claude session with a live console: digit + Enter through consoleSendKeys, as before', async () => {
    const h = await setup()
    vi.spyOn(terminals, 'hasConsole').mockImplementation((k) => k === h.claudeId)
    const keys = vi.spyOn(terminals, 'consoleSendKeys').mockImplementation(() => {})
    const res = await app.inject({ method: 'POST', url: `/api/sessions/${h.folder}/${h.claudeId}/answer`, payload: { index: 2 } })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ engine: 'console', key: h.claudeId })
    expect(keys).toHaveBeenCalledWith(h.claudeId, ['3', 'Enter'])
  })

  it('no console at all → 404; empty or non-string text → 400', async () => {
    await setup()
    vi.spyOn(terminals, 'hasConsole').mockReturnValue(false)
    expect((await app.inject({ method: 'POST', url: '/api/console/nope/send', payload: { text: 'x' } })).statusCode).toBe(404)
    expect((await app.inject({ method: 'POST', url: '/api/console/nope/send', payload: { text: '' } })).statusCode).toBe(400)
    expect((await app.inject({ method: 'POST', url: '/api/console/nope/send', payload: { text: 3 } })).statusCode).toBe(400)
  })
})
