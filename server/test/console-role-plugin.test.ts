import { describe, it, expect, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { claudeSessionIndex } from '../src/harnesses/claude-code/reader.js'
import { defaultConsoleCommand } from '../src/harnesses/claude-code/console.js'
import { AgentRegistry, mungePath } from '../src/agent-registry.js'
import { AgentStateStore } from '../src/agent-state.js'
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

// The role's own skills reach the REAL console. The
// SDK turn and OpenCode already loaded the role plugin; the Claude console
// open (server-hooks openSession / openNew → TerminalService.ensureConsole)
// dropped it, so a role skill never showed in the console. Tested on the
// real path: POST /api/console → the Claude hooks → ensureConsole → the
// argv defaultConsoleCommand builds (only the spawned program is a sleep).
describe('POST /api/console — the role plugin reaches the console argv', () => {
  const socket = `silos-roleplugin-${process.pid}`
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

  function setup() {
    const base = mkdtempSync(join(tmpdir(), 'deck-'))
    const root = join(base, 'projects')
    const folder = mkdtempSync(join(tmpdir(), 'deck-folder-'))
    mkdirSync(root, { recursive: true })
    mkdirSync(join(base, 'data', 'trash'), { recursive: true })
    const index = claudeSessionIndex(root, join(base, 'data', 'cache.json'))
    const registry = new AgentRegistry(join(base, 'data', 'agents.json'))
    registry.load()
    registry.create({ id: 'writer', name: 'Writer', folder })
    registry.create({ id: 'ops', name: 'Ops', folder })
    const agentState = new AgentStateStore(join(base, 'data', 'agent-state'))
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
    const argvs: string[][] = []
    terminals = new TerminalService(registry, index, undefined, undefined, {
      tmuxSocket: socket,
      appendDir: join(base, 'append'),
      envDir: join(base, 'env'),
      sessionsDir: join(base, 'claude-sessions'),
      command: (o) => {
        argvs.push(defaultConsoleCommand(o))
        return ['bash', '-c', 'sleep 60']
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
      agentState,
      token: 't0k',
      liveMs: 120_000,
    })
    asOwner(app, 't0k')
    // a role skill for `writer` only: putting a SKILL.md there IS the switch
    const devPlugin = join(agentState.pathFor('writer'), 'plugin')
    mkdirSync(join(devPlugin, 'skills', 'triage'), { recursive: true })
    writeFileSync(join(devPlugin, 'skills', 'triage', 'SKILL.md'), '---\nname: triage\ndescription: x\n---\n')
    return { base, root, folder, index, native, argvs, devPlugin }
  }

  const pluginArg = (argv: string[]): string | null => {
    const i = argv.indexOf('--plugin-dir')
    return i < 0 ? null : (argv[i + 1] ?? null)
  }

  it('a new conversation: --plugin-dir when the role has skills (manifest ensured), none when it has not', async () => {
    const { index, argvs, devPlugin } = setup()
    await index.init()

    const writer = await app.inject({ method: 'POST', url: '/api/console', payload: { agentId: 'writer' } })
    expect(writer.statusCode).toBe(201)
    expect(pluginArg(argvs.at(-1)!)).toBe(devPlugin)
    expect(existsSync(join(devPlugin, '.claude-plugin', 'plugin.json'))).toBe(true)

    const ops = await app.inject({ method: 'POST', url: '/api/console', payload: { agentId: 'ops' } })
    expect(ops.statusCode).toBe(201)
    expect(argvs).toHaveLength(2)
    expect(argvs.at(-1)!.includes('--plugin-dir')).toBe(false)
  })

  it('an existing session relaunched with --resume carries it too', async () => {
    const { root, folder, index, native, argvs, devPlugin } = setup()
    const id = randomUUID()
    const mf = mungePath(folder)
    native.register(mf, id, { agentId: 'writer', createdAt: new Date().toISOString() })
    mkdirSync(join(root, mf), { recursive: true })
    writeFileSync(
      join(root, mf, `${id}.jsonl`),
      JSON.stringify({
        type: 'user',
        uuid: 'u1',
        sessionId: id,
        cwd: folder,
        timestamp: new Date().toISOString(),
        message: { role: 'user', content: 'hi' },
      }) + '\n',
    )
    await index.init()

    const res = await app.inject({ method: 'POST', url: '/api/console', payload: { id } })
    expect(res.statusCode).toBe(201)
    const argv = argvs.at(-1)!
    expect(argv).toContain('--resume')
    expect(pluginArg(argv)).toBe(devPlugin)
  })
})
