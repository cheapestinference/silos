// engine-compat.test.ts — Silos declares the engine versions it
// needs and refuses an older engine instead of tolerating it. The chat gate
// (ChatService.compatGate), the console gate (POST /api/console) and the ONE
// folded Home row (inbox.ts engineCompatRow).
import { afterAll, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { TerminalService } from '../src/terminal-service.js'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentRegistry } from '../src/agent-registry.js'
import { NativeStore } from '../src/native-store.js'
import { ChatService } from '../src/chat-service.js'
import { HarnessService } from '../src/harness.js'
import { minimumVerdict, type EngineCompat, type RunFn } from '../src/harness-run.js'
import { composeInbox, engineCompatRow, engineUnwiredRow, inboxSignature } from '../src/inbox.js'
import { claudeSessionIndex } from '../src/harnesses/claude-code/reader.js'
import { SessionStore } from '../src/session-store.js'
import { ExecService } from '../src/exec-service.js'
import { CompleteService } from '../src/complete-service.js'
import { PrefsStore } from '../src/prefs-store.js'
import { MemoryService } from '../src/memory-service.js'
import { buildServer } from '../src/server.js'
import type { QueryArgs } from '../src/harnesses/claude-code/sdk-types.js'

const PAIRING = { library: '0.3.319', pairedWith: '2.1.319' }
function harnessAt(claude: string, opencode = '1.19.4'): HarnessService {
  const run: RunFn = async (cmd, args) => {
    if (cmd === '/x/claude' && args[0] === '--version') return { stdout: `${claude} (Claude Code)\n`, stderr: '' }
    if (cmd === 'npm') return { stdout: '2.1.319\n', stderr: '' }
    throw new Error(`unexpected ${cmd}`)
  }
  return new HarnessService({
    run,
    engines: {
      'claude-code': { resolve: () => '/x/claude', pairing: () => PAIRING },
      opencode: { cmd: '/x/opencode', probe: { version: async () => opencode } },
    },
  })
}

describe('the chat gate', () => {
  function chatWith(gate: HarnessService) {
    const dir = mkdtempSync(join(tmpdir(), 'compat-chat-'))
    const registry = new AgentRegistry(join(dir, 'agents.json'))
    registry.load()
    registry.create({ id: 'cc', name: 'Cc', folder: dir })
    const calls: QueryArgs[] = []
    const chat = new ChatService({
      registry,
      native: new NativeStore(join(dir, 'native.json')),
      queryFn: (a) => {
        calls.push(a)
        return {
          async *[Symbol.asyncIterator]() {
            yield { type: 'result', subtype: 'success', total_cost_usd: 0 } as never
          },
          async interrupt() {
            return undefined
          },
        }
      },
      compatGate: (h) => gate.refusal(h, 'chat'),
    })
    return { chat, calls }
  }
  const send = async (chat: ChatService): Promise<string | null> => {
    try {
      for await (const _ of chat.send({ turnId: 't', agentId: 'cc', text: 'hi' })) void _
    } catch (e) {
      return (e as Error).message
    }
    return null
  }

  it("an outdated Claude Code: the turn is refused in the verdict's one line, the SDK never asked", async () => {
    const { chat, calls } = chatWith(harnessAt('2.1.304'))
    expect(await send(chat)).toBe('Claude Code 2.1.304 is older than Silos needs (2.1.319) — update it: claude update')
    expect(calls).toHaveLength(0)
  })

  it('the paired version, or a newer 2.1 patch: the turn runs', async () => {
    for (const v of ['2.1.319', '2.1.325']) {
      const { chat, calls } = chatWith(harnessAt(v))
      expect(await send(chat)).toBeNull()
      expect(calls).toHaveLength(1)
    }
  })
})

describe('the console gate', () => {
  const sockets: string[] = []
  afterAll(() => {
    for (const s of sockets) {
      try {
        execFileSync('tmux', ['-L', s, 'kill-server'], { stdio: 'ignore' })
      } catch {
        /* no server */
      }
    }
  })
  async function app(h: HarnessService) {
    const base = mkdtempSync(join(tmpdir(), 'compat-console-'))
    const root = join(base, 'projects')
    const dataDir = join(base, 'data')
    const folder = join(base, 'folder')
    mkdirSync(root, { recursive: true })
    mkdirSync(join(dataDir, 'trash'), { recursive: true })
    mkdirSync(folder)
    const index = claudeSessionIndex(root, join(dataDir, 'cache.json'))
    await index.init()
    const registry = new AgentRegistry(join(dataDir, 'agents.json'))
    registry.load()
    registry.create({ id: 'writer', name: 'Writer', folder })
    const native = new NativeStore(join(dataDir, 'native.json'))
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
    // a sandboxed console service: a console that got past the gate runs `sleep`, never claude
    const socket = `silos-test-${process.pid}-${Date.now()}`
    sockets.push(socket)
    const terminals = new TerminalService(registry, index, undefined, undefined, {
      tmuxSocket: socket,
      appendDir: join(base, 'append'),
      envDir: join(base, 'env'),
      sessionsDir: join(base, 'claude-sessions'),
      consolesDir: join(dataDir, 'consoles'),
      command: () => ['bash', '-c', 'sleep 5'],
    })
    return buildServer({
      terminals,
      index,
      registry,
      store: new SessionStore(root, dataDir),
      native,
      chat,
      exec: new ExecService(registry),
      complete: new CompleteService(registry, index),
      prefs: new PrefsStore(dataDir),
      memory: new MemoryService(root, dataDir, registry),
      token: 't',
      liveMs: 120_000,
      harness: h,
    })
  }

  it('an outdated Claude Code: a new console is refused with the compat line', async () => {
    const a = await app(harnessAt('2.1.300'))
    const res = await a.inject({ method: 'POST', url: '/api/console', headers: { 'x-token': 't' }, payload: { agentId: 'writer' } })
    expect(res.statusCode).toBe(409)
    expect(res.json()).toEqual({ error: 'Claude Code 2.1.300 is older than Silos needs (2.1.319) — update it: claude update', compat: true })
    await a.close()
  })

  it('a newer line (2.2.x) refuses nothing: the console opens', async () => {
    const a = await app(harnessAt('2.2.0'))
    const res = await a.inject({ method: 'POST', url: '/api/console', headers: { 'x-token': 't' }, payload: { agentId: 'writer' } })
    expect(res.json().compat).toBeUndefined()
    await a.close()
  })
})

describe('engineCompatRow — one folded row, names + door', () => {
  const outdated = minimumVerdict({
    harness: 'claude-code',
    name: 'Claude Code',
    installed: '2.1.304',
    needed: '2.1.319',
    update: 'claude update',
    install: 'i',
  })
  const ok = minimumVerdict({ harness: 'opencode', name: 'OpenCode', installed: '1.19.4', needed: '1.19.4', update: 'opencode upgrade', install: 'i' })
  const old = minimumVerdict({ harness: 'opencode', name: 'OpenCode', installed: '1.14.22', needed: '1.19.4', update: 'opencode upgrade', install: 'i' })
  const ahead: EngineCompat = {
    harness: 'claude-code',
    name: 'Claude Code',
    state: 'ahead',
    installed: '2.1.322',
    needed: '2.1.319',
    update: 'npm …',
    refuses: [],
    message: 'Claude Code 2.1.322 is newer …',
  }
  const agents = [
    { id: 'builder', harness: 'claude-code' },
    { id: 'writer', harness: 'claude-code' },
    { id: 'oc', harness: 'opencode' },
  ]
  const nameOf = (id: string) => id.toUpperCase()

  it('nothing to say when every engine in use is ok, or the broken one runs nobody', () => {
    expect(engineCompatRow([ok], { agents, nameOf, now: 1 })).toBeNull()
    expect(engineCompatRow([outdated], { agents: [{ id: 'oc', harness: 'opencode' }], nameOf, now: 1 })).toBeNull()
  })

  it("one refused engine: due, its line and the agents that can't run", () => {
    const r = engineCompatRow([outdated, ok], { agents, nameOf, now: 1 })!
    expect(r).toMatchObject({ kind: 'engineCompat', key: 'engine-compat', urgency: 'due', agentIds: ['builder', 'writer'] })
    expect(r.voice).toBe("Claude Code 2.1.304 is older than Silos needs (2.1.319) — update it: claude update · BUILDER and WRITER can't run on it")
    expect(r.ack).toBeUndefined()
  })

  it('several engines fold into ONE row; ahead alone is routine', () => {
    const r = engineCompatRow([outdated, old], { agents, nameOf, now: 1 })!
    expect(r.voice).toBe('2 engines need an update: Claude Code, OpenCode')
    expect(r.kind === 'engineCompat' && r.engines.map((e) => e.agentIds)).toEqual([['builder', 'writer'], ['oc']])
    expect(engineCompatRow([ahead], { agents, nameOf, now: 1 })!.urgency).toBe('routine')
  })

  it('rides the inbox like any kernel row, and its signature moves with the verdict', () => {
    const row = engineCompatRow([outdated], { agents, nameOf, now: 1 })!
    const rows = composeInbox({ nameOf, asks: [], needsYou: [], pending: [], automations: [], kernel: [row] })
    expect(rows.map((x) => x.kind)).toEqual(['engineCompat'])
    const later = engineCompatRow([{ ...outdated, installed: '2.1.310', message: 'x' }], { agents, nameOf, now: 2 })!
    expect(inboxSignature([row])).not.toBe(inboxSignature([later]))
    expect(inboxSignature([row])).toBe(inboxSignature([engineCompatRow([outdated], { agents, nameOf, now: 99 })!]))
  })
})

// an engine newer than Silos' library is Silos' own update — the fix
// named is the one THIS Silos can run (an install never sees the repo's npm).
describe('ahead: the fix follows how Silos got here', () => {
  const p = { library: '0.3.319', pairedWith: '2.1.319' }
  it('a checkout names the paired SDK bump; an install `silos update`; npx its @latest', async () => {
    const { claudeCompat } = await import('../src/harnesses/claude-code/version.js')
    const { silosUpdateCommand } = await import('../src/silos-origin.js')
    expect(claudeCompat('2.1.330', p).update).toBe('npm install -w server --save-exact @anthropic-ai/claude-agent-sdk@0.3.330')
    const inst = claudeCompat('2.1.330', p, silosUpdateCommand('installed'))
    expect(inst).toMatchObject({ state: 'ahead', update: 'silos update', refuses: [] })
    expect(inst.message).not.toContain('npm install -w server')
    expect(silosUpdateCommand('npx')).toBe('npx silosplatform@latest')
    expect(silosUpdateCommand('source')).toBeNull()
    expect(claudeCompat('2.1.319', p, 'silos update').state).toBe('ok')
  })
})

describe('an unreadable or missing settings file reads as UNWIRED — the engine cannot run those hooks either', () => {
  it('claudeSettingsPath pointing at a directory: /api/board carries the engineUnwired row', async () => {
    const base = mkdtempSync(join(tmpdir(), 'wired-'))
    const root = join(base, 'projects')
    const dataDir = join(base, 'data')
    const folder = join(base, 'folder')
    mkdirSync(root, { recursive: true })
    mkdirSync(join(dataDir, 'trash'), { recursive: true })
    mkdirSync(folder)
    const asDir = join(base, 'settings-as-dir')
    mkdirSync(asDir)
    const index = claudeSessionIndex(root, join(dataDir, 'cache.json'))
    await index.init()
    const registry = new AgentRegistry(join(dataDir, 'agents.json'))
    registry.load()
    registry.create({ id: 'writer', name: 'Writer', folder })
    const native = new NativeStore(join(dataDir, 'native.json'))
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
    const a = buildServer({
      claudeSettingsPath: asDir,
      index,
      registry,
      store: new SessionStore(root, dataDir),
      native,
      chat,
      exec: new ExecService(registry),
      complete: new CompleteService(registry, index),
      prefs: new PrefsStore(dataDir),
      memory: new MemoryService(root, dataDir, registry),
      token: 't',
      dataDir,
    })
    const res = await a.inject({ url: '/api/board', headers: { 'x-token': 't' } })
    expect((res.json().inbox as Array<{ kind: string }>).some((r) => r.kind === 'engineUnwired')).toBe(true)
    await a.close()
  })
})

describe('engineUnwiredRow — agents run on the engine but its Silos hooks are not installed', () => {
  const agents = [
    { id: 'builder', harness: 'claude-code' },
    { id: 'oc', harness: 'opencode' },
  ]
  it('wired → null; unwired with nobody on that engine → null', () => {
    expect(engineUnwiredRow(true, { engine: 'Claude Code', harnessId: 'claude-code', agents, now: 1 })).toBeNull()
    expect(engineUnwiredRow(false, { engine: 'Claude Code', harnessId: 'claude-code', agents: [{ id: 'oc', harness: 'opencode' }], now: 1 })).toBeNull()
  })
  it('unwired with agents on it → ONE routine row naming exactly them', () => {
    const r = engineUnwiredRow(false, { engine: 'Claude Code', harnessId: 'claude-code', agents, now: 7 })!
    expect(r).toMatchObject({ kind: 'engineUnwired', key: 'engine-unwired', urgency: 'routine', at: 7, agentIds: ['builder'] })
  })
})
