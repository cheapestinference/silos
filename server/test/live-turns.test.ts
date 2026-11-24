// The turn token: the class of a bearer write comes
// from a token only Silos hands out — minted per turn (Claude SDK and
// OpenCode `opencode run` alike) and per console (every engine's console,
// through the launcher's generic env file), bound at chat-init, dropped at
// the turn's end / its tmux's death, consoles persisted. A bearer write
// without its turn is never guessed: 400 with something live, 403 with
// nothing live — never «attended» by default (G2); another agent's token 403.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { claudeSessionIndex } from '../src/harnesses/claude-code/reader.js'
import { AgentRegistry } from '../src/agent-registry.js'
import { SessionStore } from '../src/session-store.js'
import { NativeStore } from '../src/native-store.js'
import { AUTOMATIONS_NOTE, ChatService } from '../src/chat-service.js'
import { recipeText } from '../src/harnesses/briefing.js'
import { kernelRoutes } from '../src/silos/producer-brief.js'
import { ExecService } from '../src/exec-service.js'
import { CompleteService } from '../src/complete-service.js'
import { PrefsStore } from '../src/prefs-store.js'
import { MemoryService } from '../src/memory-service.js'
import { AgentTokens } from '../src/agent-tokens.js'
import { AgentStateStore } from '../src/agent-state.js'
import { MessageStore } from '../src/messages.js'
import { AutomationsStore } from '../src/automations-store.js'
import { ProposalsStore } from '../src/proposals.js'
import { Resident } from '../src/resident.js'
import { buildServer } from '../src/server.js'
import { TerminalService } from '../src/terminal-service.js'
import { agentMayWrite, agentWriteNeedsTurn, TURN_EXEMPT_WRITES } from '../src/agent-authz.js'
import { LiveTurns, TURN_HEADER, TURN_OF_ANOTHER, TURN_REQUIRED_LIVE, TURN_REQUIRED_NONE_LIVE } from '../src/live-turns.js'
import { OpenCodeHeadless, opencodeEngine } from '../src/harnesses/opencode/headless.js'
import { envFor } from '../src/harnesses/opencode/launch.js'
import type { ChatEvent } from '../src/chat-types.js'
import type { QueryFn, SdkMessage } from '../src/harnesses/claude-code/sdk-types.js'
import { asOwner } from './helpers/owner.js'
import { liveTurnOf } from './helpers/live-turn.js'

const TOKEN_RE = /^[0-9a-f]{32}$/

async function collect(gen: AsyncGenerator<ChatEvent>): Promise<ChatEvent[]> {
  const out: ChatEvent[] = []
  for await (const ev of gen) out.push(ev)
  return out
}

async function until(cond: () => boolean, ms = 5_000): Promise<void> {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting')
    await new Promise((r) => setTimeout(r, 25))
  }
}

describe('LiveTurns — the registry and its classification', () => {
  it('a token per turn: 128 random bits, never two alike, its class and facts kept', async () => {
    const turns = new LiveTurns()
    const a = turns.mintTurn({ agentId: 'x', turnId: 't1', turn: { class: 'chat' } })
    const b = turns.mintTurn({
      agentId: 'x',
      turnId: 't2',
      turn: { class: 'heartbeat', kind: 'think', packetKeys: ['message:m1'], automationId: 'heartbeat-x' },
    })
    expect(a).toMatch(TOKEN_RE)
    expect(b).toMatch(TOKEN_RE)
    expect(a).not.toBe(b)
    expect(turns.get(a)).toMatchObject({ agentId: 'x', turnId: 't1', class: 'chat', unattended: false })
    expect(turns.get(b)).toMatchObject({ class: 'heartbeat', kind: 'think', packetKeys: ['message:m1'], automationId: 'heartbeat-x', unattended: true })
    // a wake and a run are unattended by their class; a chat resent with
    // nobody in front carries both truths
    expect(turns.get(turns.mintTurn({ agentId: 'x', turnId: 't3', turn: { class: 'wake', taskKey: 'k' } }))).toMatchObject({ unattended: true, taskKey: 'k' })
    expect(turns.get(turns.mintTurn({ agentId: 'x', turnId: 't4', turn: { class: 'chat' }, unattended: true }))).toMatchObject({
      class: 'chat',
      unattended: true,
    })
  })

  it("classification: own token → its turn; another agent's → 403; absent/unknown with something live → 400; with nothing live → 403", async () => {
    const turns = new LiveTurns()
    // nothing live: never «attended» by default (G2)
    expect(turns.classify('x', undefined)).toEqual({ ok: false, code: 403, error: TURN_REQUIRED_NONE_LIVE })
    expect(turns.classify('x', 'f'.repeat(32))).toEqual({ ok: false, code: 403, error: TURN_REQUIRED_NONE_LIVE })
    const mine = turns.mintTurn({ agentId: 'x', turnId: 't1', turn: { class: 'wake', taskKey: 'k' } })
    const theirs = turns.mintTurn({ agentId: 'y', turnId: 't2', turn: { class: 'chat' } })
    const ok = turns.classify('x', mine)
    expect(ok.ok && ok.turn).toMatchObject({ agentId: 'x', class: 'wake', taskKey: 'k' })
    expect(turns.classify('x', theirs)).toEqual({ ok: false, code: 403, error: TURN_OF_ANOTHER })
    // something live and no token: never «the only live one»
    expect(turns.classify('x', undefined)).toEqual({ ok: false, code: 400, error: TURN_REQUIRED_LIVE })
    expect(turns.classify('x', 'not-a-token')).toEqual({ ok: false, code: 400, error: TURN_REQUIRED_LIVE })
    expect(turns.classify('x', 42)).toEqual({ ok: false, code: 400, error: TURN_REQUIRED_LIVE })
    // the end of the turn: it is gone
    turns.drop(mine)
    expect(turns.get(mine)).toBeNull()
    expect(turns.classify('x', mine)).toEqual({ ok: false, code: 403, error: TURN_REQUIRED_NONE_LIVE })
  })

  it('the words teach the way: "turn": "$SILOS_TURN"', async () => {
    expect(TURN_REQUIRED_LIVE).toBe('a turn of yours is running: say which turn this is — send "turn": "$SILOS_TURN"')
    expect(TURN_REQUIRED_NONE_LIVE).toBe('no conversation of yours is live — this must come from inside a turn (send "turn": "$SILOS_TURN")')
  })

  it('consoles persist in live-turns.json (SDK turns never do), reload after a restart, and expire when their tmux is gone', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'live-turns-'))
    const file = join(dir, 'live-turns.json')
    const alive = new Set<string>(['k1', 'k2'])
    const turns = new LiveTurns({ file, consoleAlive: (k) => (alive.has(k) ? 'alive' : 'gone') })
    const c1 = turns.mintConsole('x', 'k1')
    const c2 = turns.mintConsole('y', 'k2')
    const sdk = turns.mintTurn({ agentId: 'x', turnId: 't', turn: { class: 'chat' } })
    const saved = JSON.parse(readFileSync(file, 'utf8')) as { consoles: { token: string; key: string }[] }
    expect(saved.consoles.map((c) => c.key).sort()).toEqual(['k1', 'k2'])
    expect(JSON.stringify(saved)).not.toContain(sdk)
    expect(statSync(file).mode & 0o077).toBe(0) // tokens: owner-only
    // a restart: consoles come back, the SDK turn does not
    const again = new LiveTurns({ file, consoleAlive: (k) => (alive.has(k) ? 'alive' : 'gone') })
    expect(again.get(c1)).toMatchObject({ agentId: 'x', class: 'console', unattended: false, consoleKey: 'k1' })
    expect(again.get(sdk)).toBeNull()
    // the console's tmux died: its token is dropped where it is found
    alive.delete('k1')
    expect(again.classify('x', c1)).toEqual({ ok: false, code: 403, error: TURN_REQUIRED_NONE_LIVE })
    expect((JSON.parse(readFileSync(file, 'utf8')) as { consoles: unknown[] }).consoles).toHaveLength(1)
    // a listing of live consoles prunes the rest; a kill drops its own
    again.pruneConsoles(new Set())
    expect(again.get(c2)).toBeNull()
    expect((JSON.parse(readFileSync(file, 'utf8')) as { consoles: unknown[] }).consoles).toHaveLength(0)
    const c3 = again.mintConsole('x', 'k3')
    alive.add('k3')
    again.dropConsole('k3')
    expect(again.get(c3)).toBeNull()
  })

  it('a console relaunched under the same key replaces its earlier token', async () => {
    const turns = new LiveTurns()
    const first = turns.mintConsole('x', 'k')
    const second = turns.mintConsole('x', 'k')
    expect(turns.get(first)).toBeNull()
    expect(turns.get(second)).toMatchObject({ consoleKey: 'k' })
    expect(turns.liveOf('x')).toHaveLength(1)
  })
})

describe('ChatService.send mints the token of every turn', () => {
  let base: string, registry: AgentRegistry, native: NativeStore
  beforeEach(async () => {
    base = mkdtempSync(join(tmpdir(), 'live-turns-chat-'))
    mkdirSync(join(base, 'proj'))
    registry = new AgentRegistry(join(base, 'agents.json'))
    registry.load()
    registry.create({ id: 'cl', name: 'Cl', folder: join(base, 'proj') })
    registry.create({ id: 'oc', name: 'Oc', folder: join(base, 'proj'), framework: 'opencode' })
    native = new NativeStore(join(base, 'native.json'))
  })

  it('Claude: SILOS_TURN in the SDK env, live while the turn runs (chat by default), bound to its NEW session at chat-init, dropped at the end', async () => {
    const seen: { env: Record<string, string>; live: ReturnType<LiveTurns['get']> }[] = []
    let chat!: ChatService
    const queryFn = ((args: { options: { env?: Record<string, string>; sessionId?: string } }) => {
      const env = args.options.env ?? {}
      const sessionId = args.options.sessionId ?? 's-new'
      return {
        async *[Symbol.asyncIterator]() {
          yield {
            type: 'system',
            subtype: 'init',
            session_id: sessionId,
            model: 'm',
            permissionMode: 'bypassPermissions',
            slash_commands: [],
          } as unknown as SdkMessage
          seen.push({ env, live: chat.liveTurns.get(env.SILOS_TURN!) })
          yield { type: 'result', subtype: 'success', total_cost_usd: 0 } as unknown as SdkMessage
        },
        async interrupt() {
          return undefined
        },
      }
    }) as unknown as QueryFn
    chat = new ChatService({ registry, native, queryFn })
    const evs = await collect(chat.send({ turnId: 't1', agentId: 'cl', text: 'hi' }))
    const init = evs.find((e) => e.ev === 'chat-init') as Extract<ChatEvent, { ev: 'chat-init' }>
    expect(seen).toHaveLength(1)
    const token = seen[0]!.env.SILOS_TURN!
    expect(token).toMatch(TOKEN_RE)
    expect(seen[0]!.live).toMatchObject({ agentId: 'cl', turnId: 't1', class: 'chat', unattended: false, sessionId: init.sessionId })
    // its end: gone
    expect(chat.liveTurns.get(token)).toBeNull()
    expect(chat.liveTurns.liveOf('cl')).toEqual([])
  })

  it('an unattended send must name its class — attended is never a default (G2); a declared heartbeat carries kind and packet keys', async () => {
    let live: ReturnType<LiveTurns['get']> = null
    let chat!: ChatService
    const queryFn = ((args: { options: { env?: Record<string, string> } }) => ({
      async *[Symbol.asyncIterator]() {
        live = chat.liveTurns.get(args.options.env!.SILOS_TURN!)
        yield { type: 'result', subtype: 'success', total_cost_usd: 0 } as unknown as SdkMessage
      },
      async interrupt() {
        return undefined
      },
    })) as unknown as QueryFn
    chat = new ChatService({ registry, native, queryFn })
    await expect(collect(chat.send({ turnId: 'u', agentId: 'cl', text: 'x', unattended: true }))).rejects.toThrow(/must declare its class/)
    expect(chat.liveTurns.liveOf('cl')).toEqual([])
    await collect(
      chat.send({
        turnId: 'h',
        agentId: 'cl',
        text: 'x',
        unattended: true,
        turn: { class: 'heartbeat', kind: 'look', packetKeys: ['task:k1'], automationId: 'heartbeat-cl' },
      }),
    )
    expect(live).toMatchObject({ class: 'heartbeat', kind: 'look', packetKeys: ['task:k1'], automationId: 'heartbeat-cl', unattended: true })
  })

  it('a turn the caller passes a token for still gets its own (a caller can never choose it)', async () => {
    let env: Record<string, string> = {}
    const queryFn = ((args: { options: { env?: Record<string, string> } }) => ({
      async *[Symbol.asyncIterator]() {
        env = args.options.env!
        yield { type: 'result', subtype: 'success', total_cost_usd: 0 } as unknown as SdkMessage
      },
      async interrupt() {
        return undefined
      },
    })) as unknown as QueryFn
    const chat = new ChatService({ registry, native, queryFn })
    await collect(chat.send({ turnId: 't', agentId: 'cl', text: 'x', turnToken: 'a'.repeat(32) }))
    expect(env.SILOS_TURN).toMatch(TOKEN_RE)
    expect(env.SILOS_TURN).not.toBe('a'.repeat(32))
  })

  it('OpenCode: `opencode run` gets SILOS_TURN in its env, live (and bound to the session it announces) while it runs', async () => {
    const rec = join(base, 'rec')
    mkdirSync(rec)
    const bin = join(base, 'opencode-stub.sh')
    writeFileSync(
      bin,
      [
        '#!/bin/sh',
        `env > '${rec}/env'`,
        `printf '%s\\n' '{"type":"step_start","sessionID":"ses_lt1","part":{}}'`,
        // hold until the test has looked at the registry
        `while [ ! -f '${rec}/go' ]; do sleep 0.05; done`,
        `printf '%s\\n' '{"type":"step_finish","sessionID":"ses_lt1","part":{"tokens":{"input":1,"output":1,"reasoning":0,"cache":{"read":0,"write":0}},"cost":0}}'`,
      ].join('\n'),
    )
    chmodSync(bin, 0o755)
    const agentState = new AgentStateStore(join(base, 'agent-state'))
    const headless = new OpenCodeHeadless({
      binary: bin,
      registry,
      agentState,
      native,
      dataDir: base,
      home: base,
      silosApi: 'http://127.0.0.1:3210',
      agentOfDb: () => 'oc',
    })
    const neverQuery = (() => {
      throw new Error('no claude')
    }) as unknown as QueryFn
    const chat = new ChatService({ registry, native, queryFn: neverQuery, headless: { opencode: (ctx) => opencodeEngine(headless, ctx.hooks) } })
    let token = ''
    let live: ReturnType<LiveTurns['get']> = null
    for await (const ev of chat.send({ turnId: 'to', agentId: 'oc', text: 'hi' })) {
      if (ev.ev === 'chat-init') {
        const env = Object.fromEntries(
          readFileSync(join(rec, 'env'), 'utf8')
            .split('\n')
            .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
        )
        token = env.SILOS_TURN ?? ''
        live = chat.liveTurns.get(token)
        writeFileSync(join(rec, 'go'), '')
      }
    }
    expect(token).toMatch(TOKEN_RE)
    expect(live).toMatchObject({ agentId: 'oc', turnId: 'to', class: 'chat', sessionId: 'ses_lt1' })
    expect(chat.liveTurns.get(token)).toBeNull()
  })

  it("OpenCode envFor carries the turn, and SILOS_TURN is Silos' own (a Vault entry may not name it)", async () => {
    const env = envFor({ agentId: 'oc', agentDb: '/db', silosApi: 'http://127.0.0.1:3210', agentStateEnv: {}, configContent: '{}', turn: 'b'.repeat(32) })
    expect(env.SILOS_TURN).toBe('b'.repeat(32))
    expect(() => envFor({ agentId: 'oc', agentDb: '/db', silosApi: 'x', agentStateEnv: { SILOS_TURN: 'planted' }, configContent: '{}' })).toThrow(
      /SILOS_TURN is set by Silos/,
    )
  })
})

// Both console surfaces receive their token through the SAME generic
// launcher env file (terminal-service.ts writeEnvFile, sourced then
// removed — never `tmux -e`): a Claude-shaped console (Silos' own argv) and
// an OpenCode-shaped one (the harness's argv + its envFor env), m6-r5.
describe("consoles get their own token through the launcher's env file", () => {
  const socket = `silos-liveturns-${process.pid}`
  let terminals: TerminalService | undefined
  let base: string

  afterEach(async () => {
    terminals?.killAll()
    terminals?.stopReaper()
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

  async function world() {
    base = mkdtempSync(join(tmpdir(), 'live-turns-console-'))
    const root = join(base, 'projects')
    const folder = join(base, 'proj')
    mkdirSync(root, { recursive: true })
    mkdirSync(folder, { recursive: true })
    const index = claudeSessionIndex(root, join(base, 'cache.json'))
    await index.init()
    const registry = new AgentRegistry(join(base, 'agents.json'))
    registry.load()
    registry.create({ id: 'cl', name: 'Cl', folder })
    registry.create({ id: 'oc', name: 'Oc', folder, framework: 'opencode' })
    const liveTurns = new LiveTurns({ file: join(base, 'live-turns.json') })
    const out = join(base, 'out')
    mkdirSync(out)
    terminals = new TerminalService(registry, index, undefined, undefined, {
      tmuxSocket: socket,
      appendDir: join(base, 'append'),
      envDir: join(base, 'env'),
      sessionsDir: join(base, 'claude-sessions'),
      consolesDir: join(base, 'consoles'),
      liveTurns,
      // the Claude-shaped console: Silos' own argv (no input.command)
      command: (o) => ['sh', '-c', `printf %s "$SILOS_TURN" > '${out}/${o.sessionId ?? o.resumeId}'; sleep 60`],
    })
    return { terminals, liveTurns, folder, out }
  }

  it('Claude console and OpenCode console: each its own token, class console, in the process env only — the env file gone, tmux shows nothing', async () => {
    const w = await world()
    await w.terminals.ensureConsole({ cwd: w.folder, key: 'kcl', sessionId: 'kcl', agentId: 'cl', extraEnv: { SILOS_API: 'http://127.0.0.1:3210' } })
    const ocEnv = envFor({
      agentId: 'oc',
      agentDb: join(base, 'oc.db'),
      consoleKey: 'koc',
      silosApi: 'http://127.0.0.1:3210',
      agentStateEnv: {},
      configContent: '{}',
    })
    await w.terminals.ensureConsole({
      cwd: w.folder,
      key: 'koc',
      agentId: 'oc',
      harness: 'opencode',
      baseEnv: { TERM: 'xterm-256color' },
      extraEnv: ocEnv,
      command: ['sh', '-c', `printf %s "$SILOS_TURN" > '${w.out}/koc'; sleep 60`],
    })
    await until(
      () =>
        existsSync(join(w.out, 'kcl')) &&
        existsSync(join(w.out, 'koc')) &&
        readFileSync(join(w.out, 'kcl'), 'utf8') !== '' &&
        readFileSync(join(w.out, 'koc'), 'utf8') !== '',
    )
    const cl = readFileSync(join(w.out, 'kcl'), 'utf8')
    const oc = readFileSync(join(w.out, 'koc'), 'utf8')
    expect(cl).toMatch(TOKEN_RE)
    expect(oc).toMatch(TOKEN_RE)
    expect(cl).not.toBe(oc)
    expect(w.liveTurns.get(cl)).toMatchObject({ agentId: 'cl', class: 'console', unattended: false, consoleKey: 'kcl' })
    expect(w.liveTurns.get(oc)).toMatchObject({ agentId: 'oc', class: 'console', unattended: false, consoleKey: 'koc' })
    // the launcher sourced and removed the file; tmux's environment never had it
    await until(() => !existsSync(join(base, 'env', 'kcl.env')) && !existsSync(join(base, 'env', 'koc.env')))
    for (const k of ['kcl', 'koc']) {
      const shown = execFileSync('tmux', ['-L', socket, 'show-environment', '-t', `=silos-${k}`]).toString()
      expect(shown).not.toContain('SILOS_TURN')
    }
    // persisted (a console outlives the server)
    const saved = JSON.parse(readFileSync(join(base, 'live-turns.json'), 'utf8')) as { consoles: { key: string }[] }
    expect(saved.consoles.map((c) => c.key).sort()).toEqual(['kcl', 'koc'])
    // a reattach mints nothing new
    await w.terminals.ensureConsole({ cwd: w.folder, key: 'kcl', sessionId: 'kcl', agentId: 'cl' })
    expect(w.liveTurns.liveOf('cl')).toHaveLength(1)
    // killed: its token goes with it
    await w.terminals.killConsole('kcl')
    expect(w.liveTurns.get(cl)).toBeNull()
    // died outside Silos: found gone at the next look — the token check reads
    // the last answer tmux gave (no fork per request); the next probe (a
    // background one once that answer is LIVENESS_FRESH_MS old, or any
    // caller's) states it gone
    execFileSync('tmux', ['-L', socket, 'kill-session', '-t', '=silos-koc'])
    expect(await w.terminals.consoleState('koc')).toBe('gone')
    expect(w.liveTurns.classify('oc', oc)).toEqual({ ok: false, code: 403, error: TURN_REQUIRED_NONE_LIVE })
    expect(readdirSync(join(base, 'env'))).toEqual([])
  })
})

// The route level: every bearer write agentMayWrite lets through names its
// turn — the normative list's existing routes one by one.
describe('bearer writes need their turn (the normative list)', () => {
  let app: FastifyInstance, tokens: AgentTokens, chat: ChatService, messages: MessageStore, resident: Resident
  let automations: AutomationsStore, proposals: ProposalsStore
  const LOCAL = { host: '127.0.0.1:3210' }
  const as = (id: string) => ({ ...LOCAL, authorization: `Bearer ${tokens.tokenFor(id)}` })

  beforeEach(async () => {
    const base = mkdtempSync(join(tmpdir(), 'live-turns-routes-'))
    const root = join(base, 'projects')
    const data = join(base, 'data')
    const folder = join(base, 'proj')
    mkdirSync(root, { recursive: true })
    mkdirSync(join(data, 'trash'), { recursive: true })
    mkdirSync(folder)
    const index = claudeSessionIndex(root, join(data, 'cache.json'))
    await index.init()
    const registry = new AgentRegistry(join(data, 'agents.json'))
    registry.load()
    registry.create({ id: 'x', name: 'X', folder })
    registry.create({ id: 'y', name: 'Y', folder })
    const native = new NativeStore(join(data, 'native.json'))
    chat = new ChatService({
      registry,
      native,
      queryFn: () => {
        throw new Error('no sdk')
      },
    })
    tokens = new AgentTokens(data)
    const agentState = new AgentStateStore(join(data, 'agent-state'), tokens)
    messages = new MessageStore(data)
    automations = new AutomationsStore(data)
    automations.load()
    resident = new Resident({
      store: automations,
      registry,
      chat,
      native,
      index,
      root,
      dataDir: data,
      agentState,
      broadcast: () => {},
      tickIntervalMs: 999_999_999,
    })
    proposals = new ProposalsStore(data)
    proposals.load()
    app = buildServer({
      index,
      registry,
      native,
      chat,
      store: new SessionStore(root, data),
      exec: new ExecService(registry),
      complete: new CompleteService(registry, index),
      prefs: new PrefsStore(data),
      memory: new MemoryService(root, data, registry),
      token: 't0k',
      liveMs: 120_000,
      agentTokens: tokens,
      agentState,
      messages,
      automations,
      resident,
      proposals,
    })
    asOwner(app, 't0k')
  })
  afterEach(async () => {
    resident.stop()
    await resident.drain()
    await app.close()
  })

  const routes = (): { name: string; method: 'POST' | 'PATCH' | 'DELETE'; url: string; payload?: Record<string, unknown> }[] => {
    const m = messages.send({ to: 'x', from: 'y', text: 'hello' })
    const a = automations.create({
      name: 'mine',
      agentId: 'x',
      prompt: 'p',
      trigger: { kind: 'cron', expr: '0 9 * * *' },
      thread: { mode: 'new' },
      approval: false,
      keepAlive: false,
      paused: false,
    } as never)
    const p = proposals.add({
      by: 'x',
      kind: 'automation',
      reason: 'why',
      input: { name: 'n', agentId: 'x', prompt: 'p', trigger: { kind: 'cron', expr: '0 9 * * *' } },
    })
    return [
      { name: 'POST /api/agents/:id/messages', method: 'POST', url: '/api/agents/y/messages', payload: { text: 'hello' } },
      { name: 'PATCH /api/agents/<self>/messages/:mid', method: 'PATCH', url: `/api/agents/x/messages/${m.id}`, payload: { state: 'read' } },
      {
        name: 'POST /api/automations',
        method: 'POST',
        url: '/api/automations',
        payload: { name: 'n', agentId: 'x', prompt: 'p', trigger: { kind: 'cron', expr: '0 9 * * *' } },
      },
      { name: 'PATCH /api/automations/:id', method: 'PATCH', url: `/api/automations/${a.id}`, payload: { name: 'renamed' } },
      {
        name: 'POST /api/proposals',
        method: 'POST',
        url: '/api/proposals',
        payload: { kind: 'automation', reason: 'why', input: { name: 'n2', agentId: 'x', prompt: 'p', trigger: { kind: 'cron', expr: '0 9 * * *' } } },
      },
      { name: 'POST /api/proposals/:id/dismiss', method: 'POST', url: `/api/proposals/${p.id}/dismiss`, payload: {} },
      { name: 'POST /api/tasks/claim', method: 'POST', url: '/api/tasks/claim', payload: { key: 'k', session: 's' } },
      { name: 'POST /api/tasks/release', method: 'POST', url: '/api/tasks/release', payload: { key: 'k', session: 's' } },
      // append-item (t5, G2): the bearer's way to create a task of its own
      {
        name: 'POST /api/silos/:id/record/append',
        method: 'POST',
        url: '/api/silos/plans/record/append',
        payload: { key: 'folder:/p/tasks', collection: 'tasks', values: { id: 't1', title: 'x', owner: 'x' } },
      },
    ]
  }

  it("each existing route: no turn and nothing live → 403; no turn while a turn of the agent runs → 400; another agent's turn → 403 — nothing written", async () => {
    for (const r of routes()) {
      const before = { msgs: messages.list('y').length, autos: automations.list().length, props: proposals.pending().length }
      const none = await app.inject({ method: r.method, url: r.url, headers: as('x'), payload: r.payload ?? {} })
      expect([r.name, none.statusCode, none.json().error]).toEqual([r.name, 403, TURN_REQUIRED_NONE_LIVE])
      const theirs = liveTurnOf(chat, 'y')
      const other = await app.inject({ method: r.method, url: r.url, headers: as('x'), payload: { ...(r.payload ?? {}), turn: theirs } })
      expect([r.name, other.statusCode, other.json().error]).toEqual([r.name, 403, TURN_OF_ANOTHER])
      const mine = liveTurnOf(chat, 'x', { class: 'wake', taskKey: 'k' })
      const absent = await app.inject({ method: r.method, url: r.url, headers: as('x'), payload: r.payload ?? {} })
      expect([r.name, absent.statusCode, absent.json().error]).toEqual([r.name, 400, TURN_REQUIRED_LIVE])
      chat.liveTurns.drop(mine)
      chat.liveTurns.drop(theirs)
      expect({ msgs: messages.list('y').length, autos: automations.list().length, props: proposals.pending().length }).toEqual(before)
    }
  })

  it('with its own turn the write goes through — and the token never reaches what the route stores', async () => {
    const turn = liveTurnOf(chat, 'x')
    const r = await app.inject({ method: 'POST', url: '/api/agents/y/messages', headers: as('x'), payload: { text: 'hello', turn } })
    expect(r.statusCode).toBe(201)
    expect(JSON.stringify(messages.list('y'))).not.toContain(turn)
    const prop = await app.inject({
      method: 'POST',
      url: '/api/proposals',
      headers: as('x'),
      payload: { kind: 'automation', reason: 'why', input: { name: 'n', agentId: 'x', prompt: 'p', trigger: { kind: 'cron', expr: '0 9 * * *' } }, turn },
    })
    expect([prop.statusCode, prop.json()]).toEqual([201, expect.anything()])
    expect(JSON.stringify(proposals.pending())).not.toContain(turn)
  })

  it('a console of the agent counts as live (400 without its token) and its token passes', async () => {
    const c = chat.liveTurns.mintConsole('x', 'kx')
    const absent = await app.inject({ method: 'POST', url: '/api/agents/y/messages', headers: as('x'), payload: { text: 'hello' } })
    expect([absent.statusCode, absent.json().error]).toEqual([400, TURN_REQUIRED_LIVE])
    const ok = await app.inject({ method: 'POST', url: '/api/agents/y/messages', headers: as('x'), payload: { text: 'hello', turn: c } })
    expect(ok.statusCode).toBe(201)
  })

  it('a DELETE names its turn in the x-silos-turn header', async () => {
    const turn = liveTurnOf(chat, 'x')
    const none = await app.inject({ method: 'DELETE', url: '/api/agents/x/vault/abc', headers: as('x') })
    expect([none.statusCode, none.json().error]).toEqual([400, TURN_REQUIRED_LIVE])
    const named = await app.inject({ method: 'DELETE', url: '/api/agents/x/vault/abc', headers: { ...as('x'), [TURN_HEADER]: turn } })
    // past the classification: whatever the vault route answers, it is not the turn's
    expect(String(named.json().error ?? '')).not.toMatch(/SILOS_TURN|not yours/)
  })

  it('reads are never classified; the owner never sends a turn', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/agents', headers: as('x') })).statusCode).toBe(200)
    const owner = await app.inject({ method: 'POST', url: '/api/agents/y/messages', headers: LOCAL, payload: { text: 'from the owner' } })
    expect(owner.statusCode).toBe(201)
  })

  it('every write agentMayWrite allows needs a turn: the exemption list is empty, a new bearer route enters by default', async () => {
    expect(TURN_EXEMPT_WRITES).toEqual([])
    const writes: [string, string][] = [
      ['POST', '/api/agents/y/messages'],
      ['PATCH', '/api/agents/x/messages/m1'],
      ['POST', '/api/agents/x/vault'],
      ['DELETE', '/api/agents/x/vault/e1'],
      ['POST', '/api/automations'],
      ['POST', '/api/automations/templates/t/use'],
      ['POST', '/api/automations/templates/t/preview'],
      ['PATCH', '/api/automations/a1'],
      ['POST', '/api/tasks/claim'],
      ['POST', '/api/tasks/release'],
      ['POST', '/api/silos/validate'],
      ['POST', '/api/silos/submissions'],
      ['PUT', '/api/silos/s/agents/x/records/r1'],
      ['POST', '/api/silos/s/agents/x/proposals'],
      // the rest of the normative list, whichever phase opens them to a bearer
      ['POST', '/api/tasks/assign'],
      ['POST', '/api/silos/s/record/append'],
      ['POST', '/api/proposals'],
      ['POST', '/api/proposals/p/dismiss'],
      ['POST', '/api/agents/x/heartbeat/sleep'],
      ['POST', '/api/agents/x/considered'],
      ['DELETE', '/api/automations/a1'],
      // changed on purpose: the two ask routes
      ['POST', '/api/tasks/ask'],
      ['POST', '/api/tasks/ask/answer'],
    ]
    for (const [m, u] of writes) expect([m, u, agentWriteNeedsTurn(m, u)]).toEqual([m, u, true])
    // the ones a bearer may make today are among them
    expect(writes.filter(([m, u]) => agentMayWrite('x', m, u)).length).toBeGreaterThanOrEqual(18)
    expect(agentWriteNeedsTurn('GET', '/api/agents')).toBe(false)
  })
})

// Every agent-facing text that teaches a bearer write sends the turn
// (the recipes change in the same merge).
describe('every recipe that writes names its turn', () => {
  const read = (rel: string) => readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8')
  const TURN = `"turn":"'"$SILOS_TURN"'"`
  it('claim and release: the one source carries it (its verbatim copies are pinned by recipes-identical)', async () => {
    for (const name of ['claim', 'release'] as const) expect(recipeText(name)).toContain(TURN)
  })
  const files = [
    ...readdirSync(new URL('../../plugin/context/briefing.d/', import.meta.url)).map((f) => `plugin/context/briefing.d/${f}`),
    'plugin/context/recipes/claim.sh',
    'plugin/context/recipes/release.sh',
    'plugin/hooks/pre-cron.sh',
    'plugin/context/reference/tasks.md',
    'plugin/context/reference/automations.md',
    'plugin/skills/team-plan/SKILL.md',
    ...readdirSync(new URL('../../plugin/skills/team-plan/reference/', import.meta.url)).map((f) => `plugin/skills/team-plan/reference/${f}`),
    'plugin/skills/heartbeat/SKILL.md',
    'plugin/skills/vault-secrets/SKILL.md',
    'plugin/skills/support-inbox/SKILL.md',
    'docs/product.md',
  ]
  for (const rel of files) {
    it(`${rel}: each curl write carries its turn`, async () => {
      const text = rel.endsWith('pre-cron.sh') ? read(rel).replace(/\\"/g, '"') : read(rel)
      const writes = text.match(/curl -s -X (POST|PATCH|PUT|DELETE)[\s\S]*?(?=`|\n\n)/g) ?? []
      for (const w of writes) expect(w, rel).toMatch(/SILOS_TURN/)
    })
  }
  it("the server's own prompts: the automations note, a producer's kernel routes", async () => {
    expect(AUTOMATIONS_NOTE).toContain('"turn": "$SILOS_TURN"')
    const writes = kernelRoutes('s', { sync: true, ownerFields: ['state'] }).filter((l) => / -X (PUT|POST) /.test(l))
    expect(writes).toHaveLength(2)
    for (const line of writes) expect(line).toContain('SILOS_TURN')
  })
})
