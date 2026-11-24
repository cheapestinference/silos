// opencode-console-route.test.ts — an OpenCode agent's real console: the
// OpenCode TUI in Silos' tmux, through the same POST /api/console and the
// same tmux machinery (and env-file launcher) Claude's console uses.
// tmux is faked (as in harnesses-claude-console.test.ts): every tmux call
// is recorded, nothing is spawned — the argv, the env file and the stores
// are what's asserted.
import { describe, it, expect, afterEach, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'node:fs'
import { createServer } from 'node:net'
import { homedir, tmpdir } from 'node:os'
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
import { TerminalService } from '../src/terminal-service.js'
import { defaultConsoleCommand, type ConsoleCommandOpts } from '../src/harnesses/claude-code/console.js'
import { HarnessService } from '../src/harness.js'
import { buildServer } from '../src/server.js'
import { AgentStateStore } from '../src/agent-state.js'
import type { FenceOverlay } from '../src/territory.js'
import type { HarnessReader, SessionRef } from '../src/harnesses/contract.js'
import type { SessionMeta } from '../src/types.js'
import { BirthsStore } from '../src/births-store.js'
import { ConsoleRegistrar, pinProviderInto } from '../src/harnesses/opencode/registrar.js'
import { ConversationPrefsStore } from '../src/conversation-prefs.js'
import { opencode } from '../src/harnesses/opencode/index.js'
import { ProvidersStore } from '../src/providers-store.js'
import { harnesses } from '../src/harnesses/index.js'
import { allocatePort } from '../src/harnesses/opencode/ports.js'
import { worktreeOf } from '../src/harnesses/opencode/worktree.js'
import { asOwner } from './helpers/owner.js'

describe('worktreeOf — the worktree OpenCode 1.14.22 computes for a cwd', () => {
  // Project.fromDirectory: the nearest `.git` (dir or file) upward from the
  // cwd decides (its directory; git's toplevel of it); none → "/".
  it('a folder inside a git repo → the repo root; a nested subfolder too', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'oc-wt-'))
    mkdirSync(join(repo, '.git'))
    mkdirSync(join(repo, 'a', 'b'), { recursive: true })
    expect(worktreeOf(repo)).toBe(repo)
    expect(worktreeOf(join(repo, 'a', 'b'))).toBe(repo)
  })
  it('a linked worktree (`.git` is a file) → its own directory', async () => {
    const wt = mkdtempSync(join(tmpdir(), 'oc-wt-'))
    writeFileSync(join(wt, '.git'), 'gitdir: /elsewhere/.git/worktrees/x\n')
    expect(worktreeOf(join(wt))).toBe(wt)
  })
  it('outside any git repo → "/"', async () => {
    const loose = mkdtempSync(join(tmpdir(), 'oc-wt-'))
    expect(worktreeOf(loose)).toBe('/')
  })
})

describe('allocatePort', () => {
  it('returns a free loopback port that can be bound right after', async () => {
    const port = await allocatePort()
    expect(Number.isInteger(port) && port > 0 && port < 65536).toBe(true)
    await new Promise<void>((resolve, reject) => {
      const s = createServer()
      s.once('error', reject)
      s.listen(port, '127.0.0.1', () => s.close(() => resolve()))
    })
  })
})

describe('the opencode harness object', () => {
  const agent = { id: 'oc', name: 'Oc', folder: '/p', framework: 'opencode' } as never
  const spec = {
    agent,
    cwd: '/p',
    key: 'k1',
    fence: null,
    provider: null,
    env: {
      OPENCODE_DB: '/d/agents/oc/opencode.db',
      OPENCODE_CONFIG_CONTENT: '{}',
      SILOS_API: 'http://127.0.0.1:3210',
      SILOS_AGENT_ID: 'oc',
      SILOS_AGENT_STATE: '/s/oc',
      VAULT_X: 'v',
    },
    port: 4123,
  }
  it('command: the TUI on a fixed loopback port; --session only on a resume', async () => {
    expect(opencode.console.command(spec)).toEqual(['opencode', '--port', '4123', '--hostname', '127.0.0.1'])
    expect(opencode.console.command({ ...spec, resumeId: 'ses_x' })).toEqual(['opencode', '--port', '4123', '--hostname', '127.0.0.1', '--session', 'ses_x'])
    // the pinned model rides as --model: a resumed session otherwise keeps the model it last used
    expect(opencode.console.command({ ...spec, resumeId: 'ses_x', model: 'silos-ci/mimo-v2.6-flash' })).toEqual([
      'opencode',
      '--port',
      '4123',
      '--hostname',
      '127.0.0.1',
      '--session',
      'ses_x',
      '--model',
      'silos-ci/mimo-v2.6-flash',
    ])
    // the cockpit's mode rides in OpenCode's argv (auto-mode.ts modeArgs); nothing else changes
    expect(opencode.console.command({ ...spec, modeArgs: ['--auto'] })).toEqual(['opencode', '--port', '4123', '--hostname', '127.0.0.1', '--auto'])
    // the mode's argv sits before --session (the argv tail stays `--session <id>`)
    expect(opencode.console.command({ ...spec, resumeId: 'ses_x', modeArgs: ['--agent', 'plan'] })).toEqual([
      'opencode',
      '--port',
      '4123',
      '--hostname',
      '127.0.0.1',
      '--agent',
      'plan',
      '--session',
      'ses_x',
    ])
  })
  it('command without a port throws (the TUI API is how Silos talks to it)', async () => {
    expect(() => opencode.console.command({ ...spec, port: undefined })).toThrow(/port/)
  })
  it('env: envFor(...) + TERM — the key, the rest passed through; never SILOS_SESSION_ID (a `/new` in a resumed console is no child of the old one)', async () => {
    expect(opencode.console.env(spec)).toEqual({
      OPENCODE_DB: '/d/agents/oc/opencode.db',
      OPENCODE_CONFIG_CONTENT: '{}',
      SILOS_API: 'http://127.0.0.1:3210',
      SILOS_AGENT_ID: 'oc',
      SILOS_AGENT_STATE: '/s/oc',
      VAULT_X: 'v',
      SILOS_CONSOLE_KEY: 'k1',
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
    })
    expect(opencode.console.env({ ...spec, resumeId: 'ses_x' })).not.toHaveProperty('SILOS_SESSION_ID')
  })
  it('caps, id discovery, registered', async () => {
    expect(opencode.caps).toEqual({
      compaction: true,
      subagents: true,
      skills: false,
      thinking: true,
      costFromHarness: true,
      permissionsAsEvents: true,
      sendToConsole: true,
      outputStyles: false,
    })
    expect(opencode.console.idDiscovery).toBe('reported-by-plugin')
    expect(harnesses.opencode).toBe(opencode)
  })
})

// a minimal second reader so the index holds an OpenCode session
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

describe('POST /api/console — an OpenCode agent', () => {
  const socket = `silos-occ-${process.pid}`
  let app: FastifyInstance, terminals: TerminalService

  afterEach(async () => {
    terminals?.killAll()
    terminals?.stopReaper()
    await app?.close()
    vi.restoreAllMocks()
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

  async function setup(
    opts: { fence?: boolean; vault?: Record<string, string>; opencodeVersion?: string | null; providers?: (data: string) => ProvidersStore } = {},
  ) {
    const base = mkdtempSync(join(tmpdir(), 'deck-'))
    const root = join(base, 'projects')
    const data = join(base, 'data')
    const folder = mkdtempSync(join(tmpdir(), 'deck-folder-'))
    mkdirSync(root, { recursive: true })
    mkdirSync(join(data, 'trash'), { recursive: true })
    const index = claudeSessionIndex(root, join(data, 'cache.json'))
    const reader = new FakeOpenCodeReader()
    index.addReader(reader)
    await index.init()
    const registry = new AgentRegistry(join(data, 'agents.json'))
    registry.load()
    registry.create({ id: 'writer', name: 'Writer', folder })
    registry.create({ id: 'oc', name: 'Oc', folder, framework: 'opencode', mission: { text: 'You are Oc, the OpenCode agent.' } })
    const store = new SessionStore(root, data)
    const native = new NativeStore(join(data, 'native.json'))
    const prefs = new PrefsStore(data)
    const memory = new MemoryService(root, data, registry)
    const providers = opts.providers?.(data)
    const convPrefs = new ConversationPrefsStore(data)
    const chat = new ChatService({
      registry,
      native,
      convPrefs,
      queryFn: () => ({
        async *[Symbol.asyncIterator]() {},
        async interrupt() {
          return undefined
        },
      }),
      ...(providers ? { providers } : {}),
    })
    const seen: ConsoleCommandOpts[] = []
    terminals = new TerminalService(registry, index, undefined, undefined, {
      tmuxSocket: socket,
      appendDir: join(base, 'append'),
      envDir: join(base, 'env'),
      sessionsDir: join(base, 'claude-sessions'),
      consolesDir: join(base, 'consoles'),
      command: (o) => {
        seen.push(o)
        return defaultConsoleCommand(o)
      },
      // every tmux READ answers as a socket with no server (the writes below are
      // recorded, so no console ever exists): tmux's own «gone», never a real
      // probe that a loaded machine can time out into «unknown» (→ 503)
      tmuxRunner: () => {
        throw Object.assign(new Error('tmux: no server'), { status: 1, signal: null, stderr: Buffer.from(`no server running on /tmp/tmux-0/${socket}\n`) })
      },
    })
    const calls: Array<{ args: string[]; env?: NodeJS.ProcessEnv }> = []
    ;(terminals as unknown as { tmux: (args: string[], env?: NodeJS.ProcessEnv) => void }).tmux = (args, env) => {
      calls.push({ args, env })
    }
    const agentState = new AgentStateStore(join(data, 'agent-state'))
    const fence: FenceOverlay = { permissions: { deny: ['Read(//secret/**)'], additionalDirectories: [] } }
    const territory = { fenceFor: (id: string) => (id === 'oc' || id === 'writer' ? fence : null) }
    const agentDb = new Map<string, string>()
    const contested = new Set<string>()
    const register = vi.spyOn(native, 'register')
    // the real registrar over the real stores (the resume route sweeps it)
    const births = new BirthsStore(agentState, { ttlMs: 0 })
    const registrar = new ConsoleRegistrar({
      births,
      native,
      terminals,
      mungePath,
      agentOfDb: (id) => agentDb.get(id) ?? null,
      isContested: (id) => contested.has(id),
      pinProvider: pinProviderInto(convPrefs),
    })
    const sweep = vi.spyOn(registrar, 'sweep')
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
      agentState,
      dataDir: data,
      vault: { envFor: () => opts.vault ?? { VAULT_SECRET: "s3cr'et" } } as never,
      births,
      engines: {
        opencode: {
          registrar,
          agentOfDb: (id: string) => agentDb.get(id) ?? null,
          isContested: (id: string) => contested.has(id),
        },
      },
      // the compatibility gate over a fake installed OpenCode (default: the
      // minimum, 1.19.4) and an ok Claude Code — no process is run
      harness: new HarnessService({
        run: async (cmd) => {
          if (cmd === '/x/claude') return { stdout: '2.1.319 (Claude Code)\n', stderr: '' }
          throw new Error(`unexpected ${cmd}`)
        },
        engines: {
          'claude-code': { resolve: () => '/x/claude', pairing: () => ({ library: '0.3.319', pairedWith: '2.1.319' }) },
          opencode: { cmd: '/x/opencode', probe: { version: async () => ('opencodeVersion' in opts ? opts.opencodeVersion! : '1.19.4') } },
        },
      }),
      convPrefs,
      silosApi: 'http://127.0.0.1:3999',
      ...(opts.fence ? { territory } : {}),
      ...(providers ? { providers } : {}),
    })
    asOwner(app, 't0k')
    // the launch argv, and what the SAME tmux call does after it (`;` …)
    const newSession = (): { args: string[]; env?: NodeJS.ProcessEnv; tmuxTail: string[] } => {
      const c = calls.filter((x) => x.args.includes('new-session'))
      expect(c).toHaveLength(1)
      const all = c[0]!.args
      const cut = all.indexOf(';')
      return { ...c[0]!, args: cut === -1 ? all : all.slice(0, cut), tmuxTail: cut === -1 ? [] : all.slice(cut) }
    }
    // the env file the launcher sources: `sh -c '…' silos-console <file> <argv…>`
    const envFileOf = (args: string[]): Record<string, string> => {
      const file = args[args.indexOf('silos-console') + 1]!
      const out: Record<string, string> = {}
      for (const line of readFileSync(file, 'utf8').split('\n').filter(Boolean)) {
        const m = /^export ([A-Za-z_][A-Za-z0-9_]*)='(.*)'$/s.exec(line)
        if (!m) throw new Error(`unexpected env line: ${line}`)
        out[m[1]!] = m[2]!.replace(/'\\''/g, "'")
      }
      return out
    }
    const putSession = (id: string, cwd: string | null = folder): void => {
      reader.metas.set(id, {
        id,
        folder: mungePath(cwd ?? folder),
        cwd,
        mtime: Date.now(),
        startedAt: Date.now(),
        harness: 'opencode',
      } as unknown as SessionMeta)
    }
    // the plugin's birth marker, as plugin-opencode/silos.ts writes it
    const mark = (id: string, consoleKey: string, agentId = 'oc'): void => {
      const dir = join(agentState.pathFor(agentId), 'births')
      mkdirSync(dir, { recursive: true })
      writeFileSync(
        join(dir, `${id}.json`),
        JSON.stringify({ sessionId: id, agentId, parent: null, cwd: folder, source: 'startup', harness: 'opencode', consoleKey, at: new Date().toISOString() }),
      )
    }
    return {
      registry,
      base,
      data,
      folder,
      native,
      register,
      seen,
      calls,
      newSession,
      envFileOf,
      agentDb,
      contested,
      putSession,
      agentState,
      sweep,
      mark,
      registrar,
      convPrefs,
      chat,
    }
  }

  it('a new OpenCode conversation: the TUI on a port, its config + identity in the env file, no native record', async () => {
    const h = await setup()
    const res = await app.inject({ method: 'POST', url: '/api/console', payload: { agentId: 'oc' } })
    expect(res.statusCode).toBe(201)
    const { key, theme } = res.json() as { key: string; theme: string }
    expect(key).toMatch(/^[0-9a-f-]{36}$/)
    expect(theme).toBe('dark')
    const { args, env } = h.newSession()
    // argv: opencode --port <n> --hostname 127.0.0.1 --auto (the cockpit's
    // default bypass, in OpenCode's dialect), no --session, no claude
    const at = args.indexOf('opencode')
    expect(at).toBeGreaterThan(0)
    const port = Number(args[at + 2])
    expect(args.slice(at)).toEqual(['opencode', '--port', String(port), '--hostname', '127.0.0.1', '--auto'])
    expect(Number.isInteger(port) && port > 0).toBe(true)
    expect(args).not.toContain('--session')
    expect(args).not.toContain('claude')
    // port, agent and HTTP password in the Silos-owned console record (0600)
    expect(terminals.consolePort(key)).toBe(port)
    const rec = JSON.parse(readFileSync(join(h.base, 'consoles', `${key}.json`), 'utf8')) as Record<string, unknown>
    expect(rec).toMatchObject({ key, agentId: 'oc', harness: 'opencode', port })
    expect(typeof rec.serverPassword).toBe('string')
    expect((rec.serverPassword as string).length).toBeGreaterThanOrEqual(32)
    expect(args.join(' ')).not.toContain(rec.serverPassword as string)
    // nothing secret or large on argv
    expect(args.join(' ')).not.toMatch(/OPENCODE_CONFIG_CONTENT|OPENCODE_DB|s3cr/)
    expect(env?.TERM).toBe('xterm-256color')
    expect(env?.CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN).toBeUndefined()
    // the env file
    const file = h.envFileOf(args)
    expect(file.OPENCODE_DB).toBe(join(h.data, 'agents', 'oc', 'opencode.db'))
    expect(file.SILOS_CONSOLE_KEY).toBe(key)
    expect(file.SILOS_SESSION_ID).toBeUndefined() // a new console's id is OpenCode's to mint
    expect(file.SILOS_AGENT_ID).toBe('oc')
    expect(file.SILOS_AGENT_STATE).toBe(h.agentState.pathFor('oc'))
    expect(file.SILOS_ASKS_REPLIES).toBe(join(h.data, 'asks-replies', 'oc')) // the plugin's reply dir, out of the agent's reach
    expect(file.SILOS_API).toBe('http://127.0.0.1:3999')
    expect(file.VAULT_SECRET).toBe("s3cr'et")
    expect(file.ANTHROPIC_API_KEY).toBeUndefined()
    expect(file.OPENCODE_SERVER_USERNAME).toBe('silos')
    expect(file.OPENCODE_SERVER_PASSWORD).toBe(rec.serverPassword)
    const cfg = JSON.parse(file.OPENCODE_CONFIG_CONTENT!) as { plugin: string[]; instructions: string[]; permission?: unknown }
    expect(cfg.plugin[0]).toMatch(/plugin-opencode\/silos\.ts$/)
    // context file first (briefing + roster), role prompt second
    expect(cfg.instructions).toEqual([join(h.agentState.pathFor('oc'), 'opencode', 'context.md'), join(h.agentState.pathFor('oc'), 'opencode', 'role.md')])
    expect(readFileSync(cfg.instructions[0]!, 'utf8')).toMatch(/Your projects \(Silos\):/)
    // the mission rides role.md as the head of the append
    expect(readFileSync(cfg.instructions[1]!, 'utf8').startsWith('Your mission: You are Oc, the OpenCode agent.\n\n')).toBe(true)
    expect(cfg.permission).toBeUndefined() // no territory dep: no fence
    expect(file.OPENCODE_DISABLE_PROJECT_CONFIG).toBeUndefined() // unfenced: today's default
    // the registrar seals the id once the plugin reports it — not the route
    expect(h.register).not.toHaveBeenCalled()
    expect(terminals.consoleAgent(key)).toBe('oc')
    expect(terminals.nativeIdOf(key)).toBeNull()
  })

  it("provider: the agent's harness-provider becomes config + SILOS_PROVIDER_KEY in the env file, never argv; a Claude account pick is refused", async () => {
    let mmId = ''
    const h = await setup({
      providers: (data) => {
        mkdirSync(join(data, 'claude-accounts', 'main'), { recursive: true })
        const ps = new ProvidersStore(data)
        ps.load()
        mmId = ps.create({
          kind: 'harness-provider',
          label: 'MiniMax',
          harness: 'opencode',
          providerId: 'minimax-coding-plan',
          apiKey: 'mm-secret-key-123456',
        }).id
        return ps
      },
    })
    h.registry.update('oc', { provider: mmId, model: 'MiniMax-M2' })
    const refused = await app.inject({ method: 'POST', url: '/api/console', payload: { agentId: 'oc', provider: 'account:main' } })
    expect(refused.statusCode).toBe(400)
    expect((refused.json() as { error: string }).error).toBe('a Claude account cannot run on OpenCode')
    const res = await app.inject({ method: 'POST', url: '/api/console', payload: { agentId: 'oc' } })
    expect(res.statusCode).toBe(201)
    const { args } = h.newSession()
    expect(args.join(' ')).not.toContain('mm-secret')
    const file = h.envFileOf(args)
    expect(file.SILOS_PROVIDER_KEY).toBe('mm-secret-key-123456')
    expect(file.OPENCODE_CONFIG_CONTENT).not.toContain('mm-secret')
    const cfg = JSON.parse(file.OPENCODE_CONFIG_CONTENT!) as { provider?: unknown; model?: string }
    expect(cfg.provider).toEqual({ 'minimax-coding-plan': { options: { apiKey: '{env:SILOS_PROVIDER_KEY}' } } })
    expect(cfg.model).toBe('minimax-coding-plan/MiniMax-M2')
    expect(file.ANTHROPIC_AUTH_TOKEN).toBeUndefined()
  })

  // I1 (final review): the account picked for a NEW console is the
  // conversation's — kept in the console record until the id is sealed,
  // then pinned, so a wake / headless turn / runs-on never fall back to the
  // agent's provider in silence.
  it("the console follows Silos' theme: OPENCODE_TUI_CONFIG (theme system) in its env, the pane styled with the birth theme's colours and passthrough on (Silos answers its palette) in the same tmux call; 'own' leaves both out", async () => {
    const h = await setup()
    const res = await app.inject({ method: 'POST', url: '/api/console', payload: { agentId: 'oc', theme: 'light' } })
    expect(res.statusCode).toBe(201)
    const { args, tmuxTail } = h.newSession()
    expect(tmuxTail).toEqual([
      ';',
      'set-option',
      '-w',
      '-t',
      tmuxTail[4],
      'window-style',
      'bg=#faf9f5,fg=#141413',
      ';',
      'set-option',
      '-p',
      '-t',
      tmuxTail[4],
      'allow-passthrough',
      'on',
    ])
    const tui = h.envFileOf(args).OPENCODE_TUI_CONFIG
    expect(tui).toBe(join(h.data, 'opencode-tui', 'tui.json'))
    expect(JSON.parse(readFileSync(tui!, 'utf8')).theme).toBe('system')
  })

  it("consoleTheme.opencode 'own' keeps OpenCode's theme: no tui config, no pane style", async () => {
    const h = await setup()
    expect((await app.inject({ method: 'PATCH', url: '/api/prefs', payload: { consoleTheme: { opencode: 'own' } } })).statusCode).toBe(200)
    expect((await app.inject({ method: 'PATCH', url: '/api/prefs', payload: { consoleTheme: { opencode: 'neon' } } })).statusCode).toBe(400)
    await app.inject({ method: 'POST', url: '/api/console', payload: { agentId: 'oc', theme: 'dark' } })
    const { args, tmuxTail } = h.newSession()
    expect(tmuxTail).toEqual([])
    expect(h.envFileOf(args)).not.toHaveProperty('OPENCODE_TUI_CONFIG')
  })

  it("a model pick for a new console names the launch model (--model under the account's id) and is stored in its record; a different model on reuse replaces it", async () => {
    let zaiId = ''
    const h = await setup({
      providers: (data) => {
        const ps = new ProvidersStore(data)
        ps.load()
        zaiId = ps.create({ kind: 'harness-provider', label: 'Z.ai', harness: 'opencode', providerId: 'zai-coding-plan', apiKey: 'zai-secret-key-123456' }).id
        return ps
      },
    })
    const res = await app.inject({ method: 'POST', url: '/api/console', payload: { agentId: 'oc', provider: zaiId, model: 'glm-5.3' } })
    expect(res.statusCode).toBe(201)
    const { key } = res.json() as { key: string }
    const args = h.newSession().args
    expect(args.slice(args.indexOf('--model'))).toEqual(['--model', 'zai-coding-plan/glm-5.3'])
    const rec = () => JSON.parse(readFileSync(join(h.base, 'consoles', `${key}.json`), 'utf8')) as Record<string, unknown>
    expect(rec()).toMatchObject({ providerPick: zaiId, modelPick: 'glm-5.3' })
    vi.spyOn(terminals, 'hasConsole').mockImplementation((k) => k === key)
    vi.spyOn(terminals, 'reattachConsole').mockImplementation((k) => (k === key ? { key: k, theme: 'dark' } : null))
    await app.inject({ method: 'POST', url: '/api/console', payload: { agentId: 'oc', provider: zaiId, model: 'glm-5.3-flash' } })
    expect(rec().modelPick).toBe('glm-5.3-flash')
    // a brace or an absurd length is never taken
    const bad = await app.inject({ method: 'POST', url: '/api/console', payload: { agentId: 'oc', provider: zaiId, model: '{env:X}' } })
    expect(bad.statusCode).toBe(201)
    expect(rec().modelPick).toBe('glm-5.3-flash')
  })

  it('an account pick for a new console is stored in its record and pinned on the conversation at the seal; a different pick on reuse replaces it', async () => {
    let mmId = '',
      zaiId = ''
    const h = await setup({
      providers: (data) => {
        const ps = new ProvidersStore(data)
        ps.load()
        mmId = ps.create({
          kind: 'harness-provider',
          label: 'MiniMax',
          harness: 'opencode',
          providerId: 'minimax-coding-plan',
          apiKey: 'mm-secret-key-123456',
        }).id
        zaiId = ps.create({ kind: 'harness-provider', label: 'Z.ai', harness: 'opencode', providerId: 'zai-coding-plan', apiKey: 'zai-secret-key-123456' }).id
        return ps
      },
    })
    h.registry.update('oc', { provider: mmId })
    const res = await app.inject({ method: 'POST', url: '/api/console', payload: { agentId: 'oc', provider: zaiId } })
    expect(res.statusCode).toBe(201)
    const { key } = res.json() as { key: string }
    expect(h.envFileOf(h.newSession().args).OPENCODE_CONFIG_CONTENT).toContain('zai-coding-plan')
    const rec = () => JSON.parse(readFileSync(join(h.base, 'consoles', `${key}.json`), 'utf8')) as Record<string, unknown>
    expect(rec().providerPick).toBe(zaiId)
    // a second open while nothing was typed, on the agent's own account: the record follows
    vi.spyOn(terminals, 'hasConsole').mockImplementation((k) => k === key)
    vi.spyOn(terminals, 'reattachConsole').mockImplementation((k) => (k === key ? { key: k, theme: 'dark' } : null))
    const again = await app.inject({ method: 'POST', url: '/api/console', payload: { agentId: 'oc', provider: mmId } })
    expect((again.json() as { key: string }).key).toBe(key)
    expect(rec().providerPick).toBe(mmId)
    const back = await app.inject({ method: 'POST', url: '/api/console', payload: { agentId: 'oc', provider: zaiId } })
    expect((back.json() as { key: string }).key).toBe(key)
    expect(rec().providerPick).toBe(zaiId)
    // the plugin reports the id, the registrar seals it → the pick is the conversation's pin
    vi.spyOn(terminals, 'listConsoles').mockReturnValue([{ key, attached: 0, createdMs: 0 }])
    h.putSession('ses_new')
    h.agentDb.set('ses_new', 'oc')
    h.mark('ses_new', key)
    expect(await h.registrar.sweep()).toBe(1)
    expect(terminals.nativeIdOf(key)).toBe('ses_new')
    expect(h.convPrefs.get(mungePath(h.folder), 'ses_new')).toEqual({ provider: zaiId })
    // what a wake (--session), a headless turn and the runs-on line resolve
    expect(h.chat.consoleProviderFor('oc', h.folder, 'ses_new')?.id).toBe(zaiId)
    expect(h.chat.consoleProviderFor('oc', h.folder, 'ses_other')?.id).toBe(mmId)
  })

  it('no pick → nothing in the record, nothing pinned (the conversation follows the agent)', async () => {
    const h = await setup()
    const { key } = (await app.inject({ method: 'POST', url: '/api/console', payload: { agentId: 'oc' } })).json() as { key: string }
    expect(JSON.parse(readFileSync(join(h.base, 'consoles', `${key}.json`), 'utf8'))).not.toHaveProperty('providerPick')
    vi.spyOn(terminals, 'listConsoles').mockReturnValue([{ key, attached: 0, createdMs: 0 }])
    h.putSession('ses_plain')
    h.agentDb.set('ses_plain', 'oc')
    h.mark('ses_plain', key)
    expect(await h.registrar.sweep()).toBe(1)
    expect(h.convPrefs.get(mungePath(h.folder), 'ses_plain')).toBeNull()
  })

  it('an OpenCode older than the minimum: the console is refused in one line naming the versions and `opencode upgrade`, nothing launched', async () => {
    const h = await setup({ opencodeVersion: '1.14.22' })
    const res = await app.inject({ method: 'POST', url: '/api/console', payload: { agentId: 'oc' } })
    expect(res.statusCode).toBe(409)
    expect(res.json()).toEqual({ error: 'OpenCode 1.14.22 is older than Silos needs (1.19.4) — update it: opencode upgrade', compat: true })
    h.putSession('ses_old')
    h.agentDb.set('ses_old', 'oc')
    expect((await app.inject({ method: 'POST', url: '/api/console', payload: { id: 'ses_old' } })).statusCode).toBe(409)
    expect(h.calls.filter((x) => x.args.includes('new-session'))).toHaveLength(0)
  })

  it('no readable OpenCode version: refused as missing, nothing launched', async () => {
    const h = await setup({ opencodeVersion: null })
    const res = await app.inject({ method: 'POST', url: '/api/console', payload: { agentId: 'oc' } })
    expect(res.statusCode).toBe(409)
    expect(res.json().error).toMatch(/^Silos can't find OpenCode .* Silos needs OpenCode 1\.19\.4 or newer/)
    expect(h.calls.filter((x) => x.args.includes('new-session'))).toHaveLength(0)
  })

  it('bypass on the minimum: the TUI gets --auto', async () => {
    const h = await setup()
    const res = await app.inject({ method: 'POST', url: '/api/console', payload: { agentId: 'oc' } })
    expect(res.statusCode).toBe(201)
    expect(h.newSession().args).toContain('--auto')
  })

  it("a conversation in plan mode: the TUI opens on OpenCode's plan agent, before --session, never --auto", async () => {
    const h = await setup()
    h.putSession('ses_pl')
    h.agentDb.set('ses_pl', 'oc')
    h.convPrefs.patch(mungePath(h.folder), 'ses_pl', { permissionMode: 'plan' })
    const res = await app.inject({ method: 'POST', url: '/api/console', payload: { id: 'ses_pl' } })
    expect(res.statusCode).toBe(201)
    const { args } = h.newSession()
    expect(args).not.toContain('--auto')
    expect(args.slice(-4)).toEqual(['--agent', 'plan', '--session', 'ses_pl'])
    const cfg = JSON.parse(h.envFileOf(args).OPENCODE_CONFIG_CONTENT!) as { permission?: Record<string, unknown> }
    expect(cfg.permission?.edit).toBeUndefined()
  })

  it("a conversation in acceptEdits: neither --auto nor --agent, and the config carries no edit base (OpenCode's defaults and the fence stand)", async () => {
    const h = await setup({ fence: true })
    h.putSession('ses_ae')
    h.agentDb.set('ses_ae', 'oc')
    h.convPrefs.patch(mungePath(h.folder), 'ses_ae', { permissionMode: 'acceptEdits' })
    const res = await app.inject({ method: 'POST', url: '/api/console', payload: { id: 'ses_ae' } })
    expect(res.statusCode).toBe(201)
    const { args } = h.newSession()
    expect(args).not.toContain('--auto')
    expect(args).not.toContain('--agent')
    expect(args.slice(-2)).toEqual(['--session', 'ses_ae'])
    const raw = h.envFileOf(args).OPENCODE_CONFIG_CONTENT!
    expect(raw).not.toContain('"*":"allow"')
    const cfg = JSON.parse(raw) as { permission: { edit: Record<string, string>; read: Record<string, string> } }
    expect(Object.keys(cfg.permission.edit)).not.toContain('*')
    expect(Object.keys(cfg.permission.edit).at(-1)).toBe(`${h.agentState.pathFor('oc')}/**`)
    expect(cfg.permission.read['/secret/**']).toBe('deny')
  })

  it('a resume on the minimum OpenCode: password in the env file', async () => {
    const h = await setup()
    h.putSession('ses_b')
    h.agentDb.set('ses_b', 'oc')
    const res = await app.inject({ method: 'POST', url: '/api/console', payload: { id: 'ses_b' } })
    expect(res.statusCode).toBe(201)
    const { key } = res.json() as { key: string }
    const rec = terminals.consoleRecord(key)!
    expect(typeof rec.serverPassword).toBe('string')
    expect(h.envFileOf(h.newSession().args).OPENCODE_SERVER_PASSWORD).toBe(rec.serverPassword)
  })

  it("the agent's fence rides the config as OpenCode permissions, relative to OpenCode's worktree", async () => {
    const h = await setup({ fence: true })
    expect((await app.inject({ method: 'POST', url: '/api/console', payload: { agentId: 'oc' } })).statusCode).toBe(201)
    const file = h.envFileOf(h.newSession().args)
    // no project config layer can precede ours (launch.ts configContent)
    expect(file.OPENCODE_DISABLE_PROJECT_CONFIG).toBe('1')
    const cfg = JSON.parse(file.OPENCODE_CONFIG_CONTENT!) as { permission: { read: Record<string, string>; edit: Record<string, string> } }
    expect(cfg.permission.read['/secret/**']).toBe('deny')
    // the agent's own state dir allowed last (fence.ts allowPaths)
    const own = h.agentState.pathFor('oc')
    expect(Object.entries(cfg.permission.read).at(-1)).toEqual([`${own}/**`, 'allow'])
    // OpenCode's config files denied for edit, before the own-state allows
    const editKeys = Object.keys(cfg.permission.edit)
    expect(cfg.permission.edit['**/opencode.json']).toBe('deny')
    expect(cfg.permission.edit[join(homedir(), '.config', 'opencode', '**')]).toBe('deny')
    expect(editKeys.indexOf('**/.opencode/**')).toBeLessThan(editKeys.indexOf(`${own}/**`))
    expect(Object.entries(cfg.permission.edit).at(-1)).toEqual([`${own}/**`, 'allow'])
  })

  it('a second open while nothing was typed reuses the waiting console', async () => {
    await setup()
    const first = (await app.inject({ method: 'POST', url: '/api/console', payload: { agentId: 'oc' } })).json() as { key: string }
    vi.spyOn(terminals, 'hasConsole').mockImplementation((k) => k === first.key)
    vi.spyOn(terminals, 'reattachConsole').mockImplementation((k) => (k === first.key ? { key: k, theme: 'dark' } : null))
    const again = (await app.inject({ method: 'POST', url: '/api/console', payload: { agentId: 'oc' } })).json() as { key: string }
    expect(again.key).toBe(first.key)
    // once the registrar bound it to a session, a new conversation gets a new console
    terminals.bindNativeId(first.key, 'ses_typed')
    const third = (await app.inject({ method: 'POST', url: '/api/console', payload: { agentId: 'oc' } })).json() as { key: string }
    expect(third.key).not.toBe(first.key)
  })

  it('resume { id: ses_x } with no live console: --session ses_x under the id as key (no SILOS_SESSION_ID in the process), bound at once', async () => {
    const h = await setup()
    h.putSession('ses_x')
    h.agentDb.set('ses_x', 'oc')
    const res = await app.inject({ method: 'POST', url: '/api/console', payload: { id: 'ses_x' } })
    expect(res.statusCode).toBe(201)
    const { key } = res.json() as { key: string }
    expect(key).toBe('ses_x')
    const { args } = h.newSession()
    expect(args.slice(-2)).toEqual(['--session', 'ses_x'])
    const file = h.envFileOf(args)
    expect(file.SILOS_SESSION_ID).toBeUndefined()
    expect(file.SILOS_CONSOLE_KEY).toBe('ses_x')
    expect(file.OPENCODE_DB).toBe(join(h.data, 'agents', 'oc', 'opencode.db'))
    expect(terminals.nativeIdOf('ses_x')).toBe('ses_x')
    expect(terminals.keyOfNativeId('ses_x')).toBe('ses_x')
    expect(terminals.consoleAgent('ses_x')).toBe('oc')
    expect(h.register).not.toHaveBeenCalled()
  })

  it('resume reattaches to the live console the id is bound to (no launch, no Claude lock-file guard)', async () => {
    const h = await setup()
    h.putSession('ses_y')
    h.agentDb.set('ses_y', 'oc')
    terminals.bindNativeId('born-key', 'ses_y')
    vi.spyOn(terminals, 'reattachConsole').mockImplementation((k) => (k === 'born-key' ? { key: k, theme: 'light' } : null))
    const holders = vi.spyOn(terminals, 'holdersOf')
    const res = await app.inject({ method: 'POST', url: '/api/console', payload: { id: 'ses_y' } })
    expect(res.statusCode).toBe(201)
    expect(res.json()).toEqual({ key: 'born-key', theme: 'light' })
    expect(h.calls.filter((c) => c.args.includes('new-session'))).toHaveLength(0)
    expect(holders).not.toHaveBeenCalled()
  })

  it('a woken console (slept: tmux gone, bindings cleared) relaunches with --session', async () => {
    const h = await setup()
    h.putSession('ses_w')
    h.agentDb.set('ses_w', 'oc')
    terminals.bindNativeId('born-key', 'ses_w')
    await terminals.killConsole('born-key') // what the sleep sweep does
    const res = await app.inject({ method: 'POST', url: '/api/console', payload: { id: 'ses_w' } })
    expect(res.statusCode).toBe(201)
    expect(h.newSession().args.slice(-2)).toEqual(['--session', 'ses_w'])
  })

  it('a woken console records its port and a fresh API password again (send-to-console keeps working)', async () => {
    const h = await setup()
    h.putSession('ses_v')
    h.agentDb.set('ses_v', 'oc')
    const first = (await app.inject({ method: 'POST', url: '/api/console', payload: { agentId: 'oc' } })).json() as { key: string }
    const before = terminals.consoleRecord(first.key)!
    terminals.bindNativeId(first.key, 'ses_v')
    await terminals.killConsole(first.key) // what the sleep sweep does
    expect(terminals.consoleRecord(first.key)).toBeNull()
    const res = await app.inject({ method: 'POST', url: '/api/console', payload: { id: 'ses_v' } })
    expect(res.statusCode).toBe(201)
    const { key } = res.json() as { key: string }
    const woken = h.calls.filter((c) => c.args.includes('new-session')).at(-1)!.args
    const at = woken.indexOf('opencode')
    const rec = terminals.consoleRecord(key)!
    expect(rec).toMatchObject({ key, agentId: 'oc', harness: 'opencode', port: Number(woken[at + 2]) })
    expect(terminals.consolePort(key)).toBe(rec.port)
    expect(typeof rec.serverPassword).toBe('string')
    expect(rec.serverPassword).not.toBe(before.serverPassword)
    expect(h.envFileOf(woken).OPENCODE_SERVER_PASSWORD).toBe(rec.serverPassword)
  })

  it("an OpenCode id outside its agent's own DB (global, contested, unknown) gets no console", async () => {
    const h = await setup()
    h.putSession('ses_g')
    expect((await app.inject({ method: 'POST', url: '/api/console', payload: { id: 'ses_g' } })).statusCode).toBe(400)
    h.agentDb.set('ses_g', 'writer') // a Claude Code agent's? never an OpenCode console for it
    expect((await app.inject({ method: 'POST', url: '/api/console', payload: { id: 'ses_g' } })).statusCode).toBe(400)
    h.agentDb.set('ses_g', 'oc')
    h.contested.add('ses_g')
    expect((await app.inject({ method: 'POST', url: '/api/console', payload: { id: 'ses_g' } })).statusCode).toBe(400)
    expect(h.calls.filter((c) => c.args.includes('new-session'))).toHaveLength(0)
  })

  it("a Claude agent's console is launched exactly as before (argv byte-identical, native record, no port)", async () => {
    const h = await setup()
    const res = await app.inject({ method: 'POST', url: '/api/console', payload: { agentId: 'writer' } })
    expect(res.statusCode).toBe(201)
    const { key } = res.json() as { key: string }
    const { args, env } = h.newSession()
    expect(h.seen).toHaveLength(1)
    expect(h.seen[0]!.sessionId).toBe(key)
    const claudeArgv = defaultConsoleCommand(h.seen[0]!)
    expect(args.slice(-claudeArgv.length)).toEqual(claudeArgv)
    // the -e stamps: the theme only, as before
    expect(args.filter((a, i) => args[i - 1] === '-e')).toEqual(['SILOS_CONSOLE_THEME=dark'])
    expect(env?.CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN).toBe('1')
    expect(h.register).toHaveBeenCalledWith(mungePath(h.folder), key, expect.objectContaining({ agentId: 'writer' }))
    expect(terminals.consolePort(key)).toBeNull()
    expect(existsSync(join(h.data, 'agents', 'writer', 'opencode.db'))).toBe(false)
  })

  // a resume racing the registrar (marker landed, DB row
  // there, not sealed yet) must reattach the console it was born in — via
  // the REAL sweep, before the nested-run check (an unsealed startup marker
  // reads as nested) and before any launch.
  it('resume racing the registrar: the real sweep seals the marker, the born console is reattached, no launch', async () => {
    const h = await setup()
    const opened = (await app.inject({ method: 'POST', url: '/api/console', payload: { agentId: 'oc' } })).json() as { key: string }
    h.calls.length = 0
    vi.spyOn(terminals, 'listConsoles').mockReturnValue([{ key: opened.key, attached: 0, createdMs: 0 }])
    vi.spyOn(terminals, 'hasConsole').mockImplementation((k) => k === opened.key)
    vi.spyOn(terminals, 'reattachConsole').mockImplementation((k) => (k === opened.key ? { key: k, theme: 'dark' } : null))
    h.putSession('ses_r')
    h.agentDb.set('ses_r', 'oc')
    h.mark('ses_r', opened.key)
    const res = await app.inject({ method: 'POST', url: '/api/console', payload: { id: 'ses_r' } })
    expect(res.statusCode).toBe(201)
    expect(res.json()).toEqual({ key: opened.key, theme: 'dark' })
    expect(h.sweep).toHaveBeenCalled()
    expect(h.calls.filter((c) => c.args.includes('new-session'))).toHaveLength(0)
    expect(terminals.keyOfNativeId('ses_r')).toBe(opened.key)
    expect(h.native.get(mungePath(h.folder), 'ses_r')?.agentId).toBe('oc')
  })

  it('…a marker naming a console launched for ANOTHER agent is refused by the sweep: that console stays unbound, the session reads as nested (409)', async () => {
    const h = await setup()
    await terminals.ensureConsole({ cwd: h.folder, key: 'writer-key', command: ['x'], agentId: 'writer', harness: 'opencode', port: 1 })
    h.calls.length = 0
    vi.spyOn(terminals, 'listConsoles').mockReturnValue([{ key: 'writer-key', attached: 0, createdMs: 0 }])
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    h.putSession('ses_s')
    h.agentDb.set('ses_s', 'oc')
    h.mark('ses_s', 'writer-key')
    const res = await app.inject({ method: 'POST', url: '/api/console', payload: { id: 'ses_s' } })
    expect(h.native.get(mungePath(h.folder), 'ses_s')).toBeNull()
    expect(terminals.nativeIdOf('writer-key')).toBeNull()
    // unsealed, its startup marker reads as a run the agent launched itself
    expect(res.statusCode).toBe(409)
    expect(res.json()).toMatchObject({ nested: true })
    expect(h.calls.filter((c) => c.args.includes('new-session'))).toHaveLength(0)
  })

  // a fenced launch turns OpenCode's project discovery off, so
  // Silos lists the project's instruction files itself (OpenCode's rule).
  it("fenced: the project's AGENTS.md files (cwd up to the worktree) follow context and role, absolute", async () => {
    const h = await setup({ fence: true })
    const repo = mkdtempSync(join(tmpdir(), 'oc-repo-'))
    mkdirSync(join(repo, '.git'))
    mkdirSync(join(repo, 'sub'))
    writeFileSync(join(repo, 'AGENTS.md'), 'root')
    writeFileSync(join(repo, 'sub', 'AGENTS.md'), 'sub')
    writeFileSync(join(repo, 'CLAUDE.md'), 'skipped: AGENTS.md was found first')
    const agentFolder = join(repo, 'sub')
    // point the agent at the repo subfolder (the registry is the server's)
    const res0 = await app.inject({ method: 'PATCH', url: '/api/agents/oc', payload: { folder: agentFolder } })
    expect(res0.statusCode).toBeLessThan(300)
    expect((await app.inject({ method: 'POST', url: '/api/console', payload: { agentId: 'oc' } })).statusCode).toBe(201)
    const cfg = JSON.parse(h.envFileOf(h.newSession().args).OPENCODE_CONFIG_CONTENT!) as { instructions: string[] }
    expect(cfg.instructions.slice(2)).toEqual([join(agentFolder, 'AGENTS.md'), join(repo, 'AGENTS.md')])
  })

  it('unfenced: no project files listed (OpenCode discovers them itself)', async () => {
    const h = await setup()
    writeFileSync(join(h.folder, 'AGENTS.md'), 'x')
    expect((await app.inject({ method: 'POST', url: '/api/console', payload: { agentId: 'oc' } })).statusCode).toBe(201)
    const cfg = JSON.parse(h.envFileOf(h.newSession().args).OPENCODE_CONFIG_CONTENT!) as { instructions: string[] }
    expect(cfg.instructions).toHaveLength(2)
  })

  it('a Vault entry named OPENCODE_* is refused with a clear message, nothing launched', async () => {
    const h = await setup({ vault: { OPENCODE_CONFIG: '/evil.json' } })
    const res = await app.inject({ method: 'POST', url: '/api/console', payload: { agentId: 'oc' } })
    expect(res.statusCode).toBe(400)
    expect((res.json() as { error: string }).error).toMatch(/OPENCODE_CONFIG is set by Silos.*Vault/)
    expect(h.calls.filter((c) => c.args.includes('new-session'))).toHaveLength(0)
  })

  it('a Vault entry named SILOS_PROVIDER_KEY is refused on the console too (no provider would otherwise take it as its key)', async () => {
    const h = await setup({ vault: { SILOS_PROVIDER_KEY: 'vault-smuggled-key' } })
    const res = await app.inject({ method: 'POST', url: '/api/console', payload: { agentId: 'oc' } })
    expect(res.statusCode).toBe(400)
    expect((res.json() as { error: string }).error).toMatch(/SILOS_PROVIDER_KEY is set by Silos.*Vault/)
    expect(h.calls.filter((c) => c.args.includes('new-session'))).toHaveLength(0)
  })

  it('a harness-provider whose key was cleared (providerId changed) fails closed: 400 naming it, nothing launched', async () => {
    let mmId = ''
    const h = await setup({
      providers: (data) => {
        const ps = new ProvidersStore(data)
        ps.load()
        mmId = ps.create({
          kind: 'harness-provider',
          label: 'MiniMax',
          harness: 'opencode',
          providerId: 'minimax-coding-plan',
          apiKey: 'mm-secret-key-123456',
        }).id
        ps.update(mmId, { providerId: 'zai' })
        return ps
      },
    })
    h.registry.update('oc', { provider: mmId })
    const res = await app.inject({ method: 'POST', url: '/api/console', payload: { agentId: 'oc' } })
    expect(res.statusCode).toBe(400)
    expect((res.json() as { error: string }).error).toMatch(/MiniMax has no key — paste it again/)
    expect(h.calls.filter((c) => c.args.includes('new-session'))).toHaveLength(0)
  })
})

describe('worktreeOf follows symlinks like OpenCode (realpath)', () => {
  it('a symlinked folder inside a repo resolves to the real repo root', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'oc-wt-'))
    mkdirSync(join(repo, '.git'))
    mkdirSync(join(repo, 'real'))
    const link = join(mkdtempSync(join(tmpdir(), 'oc-ln-')), 'l')
    symlinkSync(join(repo, 'real'), link)
    expect(worktreeOf(link)).toBe(realpathSync(repo))
  })
})
