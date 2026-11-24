import { describe, it, expect, afterEach, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
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
import type { ConsoleCommandOpts } from '../src/harnesses/claude-code/console.js'
import { buildServer } from '../src/server.js'
import type { FenceOverlay } from '../src/territory.js'
import { AgentStateStore } from '../src/agent-state.js'
import { AgentTokens } from '../src/agent-tokens.js'
import type { Birth } from '../src/births-store.js'
import { asOwner } from './helpers/owner.js'

// Territory: POST /api/console asks the territory dep for the agent's fence
// and hands it to the console command — on a fresh console and on a resume.
describe("POST /api/console — the console carries the agent's fence", () => {
  const socket = `silos-cfence-${process.pid}`
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

  async function setup(withTerritory: boolean, enabled: string[] = [], loadsCarried?: (agentId: string, cwd?: string, sessionId?: string) => unknown[]) {
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
    const seen: ConsoleCommandOpts[] = []
    terminals = new TerminalService(registry, index, undefined, undefined, {
      tmuxSocket: socket,
      appendDir: join(base, 'append'),
      envDir: join(base, 'env'),
      sessionsDir: join(base, 'claude-sessions'),
      command: (o) => {
        seen.push(o)
        return ['bash', '-c', 'sleep 60']
      },
    })
    const fence: FenceOverlay = { permissions: { deny: ['Read(//secret/**)'], additionalDirectories: ['/state/writer'] } }
    const asked: string[] = []
    const territory = {
      fenceFor: (id: string) => {
        asked.push(id)
        return id === 'writer' ? fence : null
      },
    }
    const tokens = new AgentTokens(join(base, 'data'))
    // `enabled` only names the agents whose fence the test means on: the
    // bearer never depends on it
    void enabled
    const agentState = new AgentStateStore(join(base, 'data', 'agent-state'), tokens)
    const consoleEnvs: Record<string, string>[] = []
    const births = new Map<string, Birth>()
    const ensure = terminals.ensureConsole.bind(terminals)
    vi.spyOn(terminals, 'ensureConsole').mockImplementation((input) => {
      consoleEnvs.push(input.extraEnv ?? {})
      return ensure(input)
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
      agentState,
      agentTokens: tokens,
      births: { get: (id: string) => births.get(id) ?? null },
      ...(withTerritory ? { territory } : {}),
      ...(loadsCarried ? { loadsCarried } : {}),
    })
    asOwner(app, 't0k')
    return { native, root, folder, index, seen, fence, asked, consoleEnvs, tokens, base, births, registry }
  }

  it('a fresh console for an agent gets its fence', async () => {
    const { seen, fence, asked } = await setup(true)
    const res = await app.inject({ method: 'POST', url: '/api/console', payload: { agentId: 'writer' } })
    expect(res.statusCode).toBe(201)
    expect(asked).toEqual(['writer'])
    expect(seen).toHaveLength(1)
    expect(seen[0]!.fence).toEqual(fence)
  })

  // the mission reaches the REAL console — the
  // --append-system-prompt-file the claude it spawns reads holds it whole
  it("a fresh console's append file carries the agent's mission and its Never rules", async () => {
    const { seen, registry } = await setup(true)
    registry.update('writer', { mission: { text: 'Ship the product.', never: ['push to main on Fridays'] } })
    const res = await app.inject({ method: 'POST', url: '/api/console', payload: { agentId: 'writer' } })
    expect(res.statusCode).toBe(201)
    const file = seen[0]!.appendFile!
    expect(readFileSync(file, 'utf8').startsWith("Your mission: Ship the product.\nNever, without the owner's word:\n- push to main on Fridays\n\n")).toBe(true)
  })

  // A console-born conversation is Silos-born: it gets a birth record with
  // its agent at creation (the chat engine already did), so ownership never
  // falls back to classify-by-transcript — which, among four agents sharing
  // a folder, picked the DEFAULT agent (a Builder console landed
  // in Writer).
  it('a fresh console registers its birth to the agent that opened it', async () => {
    const { native, folder } = await setup(true)
    const res = await app.inject({ method: 'POST', url: '/api/console', payload: { agentId: 'writer' } })
    expect(res.statusCode).toBe(201)
    const key = (res.json() as { key: string }).key
    expect(native.isNative(mungePath(folder), key)).toBe(true)
    expect(native.get(mungePath(folder), key)?.agentId).toBe('writer')
  })

  it("a resumed console (session with a cwd) gets the owning agent's fence", async () => {
    const { root, folder, index, seen, fence } = await setup(true)
    const id = randomUUID()
    const mf = mungePath(folder)
    mkdirSync(join(root, mf), { recursive: true })
    writeFileSync(
      join(root, mf, `${id}.jsonl`),
      JSON.stringify({ type: 'user', sessionId: id, cwd: folder, timestamp: new Date().toISOString(), message: { role: 'user', content: 'hello' } }) + '\n',
    )
    await index.refresh(mf, id)
    const res = await app.inject({ method: 'POST', url: '/api/console', payload: { id } })
    expect(res.statusCode).toBe(201)
    expect(seen).toHaveLength(1)
    expect(seen[0]!.resumeId).toBe(id)
    expect(seen[0]!.fence).toEqual(fence)
  })

  // spec scopes §6 (T3): what Silos keeps for the agent rides the console's
  // launch — fresh and resumed — with the fence; none kept, nothing passed
  it("a fresh and a resumed console carry the agent's launch entries beside its fence", async () => {
    const entry = { disabledMcpjsonServers: ['github'] }
    const asked: string[] = []
    const { seen, fence, root, folder, index } = await setup(true, [], (id) => {
      asked.push(id)
      return id === 'writer' ? [entry] : []
    })
    expect((await app.inject({ method: 'POST', url: '/api/console', payload: { agentId: 'writer' } })).statusCode).toBe(201)
    expect(seen[0]!.carried).toEqual([entry])
    expect(seen[0]!.fence).toEqual(fence)
    const id = randomUUID()
    const mf = mungePath(folder)
    mkdirSync(join(root, mf), { recursive: true })
    writeFileSync(
      join(root, mf, `${id}.jsonl`),
      JSON.stringify({ type: 'user', sessionId: id, cwd: folder, timestamp: new Date().toISOString(), message: { role: 'user', content: 'hello' } }) + '\n',
    )
    await index.refresh(mf, id)
    expect((await app.inject({ method: 'POST', url: '/api/console', payload: { id } })).statusCode).toBe(201)
    expect(seen[1]!.carried).toEqual([entry])
    expect(asked).toContain('writer')
  })

  // spec scopes §6 (T5): a console reopened on a conversation carries that
  // conversation's entries after its agent's; one already running is only
  // reattached — it keeps what it started with, nothing is relaunched
  it("a reopened console asks for its conversation's entries; a running one is reattached, never relaunched", async () => {
    const agent = { disabledMcpjsonServers: ['github'] }
    const conv = { enabledPlugins: { 'stripe@market': false } }
    let kept: unknown[] = [agent]
    const asked: [string, string | undefined][] = []
    const { seen, root, folder, index } = await setup(true, [], (id, _cwd, session) => {
      asked.push([id, session])
      return session ? [...kept, conv] : kept
    })
    const id = randomUUID()
    const mf = mungePath(folder)
    mkdirSync(join(root, mf), { recursive: true })
    writeFileSync(
      join(root, mf, `${id}.jsonl`),
      JSON.stringify({ type: 'user', sessionId: id, cwd: folder, timestamp: new Date().toISOString(), message: { role: 'user', content: 'hello' } }) + '\n',
    )
    await index.refresh(mf, id)
    expect((await app.inject({ method: 'POST', url: '/api/console', payload: { id } })).statusCode).toBe(201)
    expect(asked).toContainEqual(['writer', id])
    expect(seen).toHaveLength(1)
    expect(seen[0]!.carried).toEqual([agent, conv])
    // the entries change while it runs: the open reattaches, the command is not run again
    kept = []
    expect((await app.inject({ method: 'POST', url: '/api/console', payload: { id } })).statusCode).toBe(201)
    expect(seen).toHaveLength(1)
  })

  it('an agent with nothing kept: the console command gets no carried field at all', async () => {
    const { seen } = await setup(true, [], () => [])
    expect((await app.inject({ method: 'POST', url: '/api/console', payload: { agentId: 'writer' } })).statusCode).toBe(201)
    expect('carried' in seen[0]!).toBe(false)
  })

  it('without the territory dep the console command carries no fence', async () => {
    const { seen } = await setup(false)
    const res = await app.inject({ method: 'POST', url: '/api/console', payload: { agentId: 'writer' } })
    expect(res.statusCode).toBe(201)
    expect('fence' in seen[0]!).toBe(false)
  })

  // Rollout gate + master: the console env carries SILOS_AGENT_TOKEN only
  // for an agent the owner enabled — never for a disabled one or master.
  it('console env: SILOS_AGENT_TOKEN for every agent, its territory on or off (G1)', async () => {
    const off = await setup(true, [])
    expect((await app.inject({ method: 'POST', url: '/api/console', payload: { agentId: 'writer' } })).statusCode).toBe(201)
    expect(off.consoleEnvs[0]!.SILOS_AGENT_ID).toBe('writer')
    expect(off.consoleEnvs[0]!.SILOS_AGENT_TOKEN).toBe(off.tokens.tokenFor('writer'))
    terminals.killAll()
    terminals.stopReaper()
    await app.close()
    const on = await setup(true, ['writer'])
    expect((await app.inject({ method: 'POST', url: '/api/console', payload: { agentId: 'writer' } })).statusCode).toBe(201)
    expect(on.consoleEnvs[0]!.SILOS_AGENT_TOKEN).toBe(on.tokens.tokenFor('writer'))
  })

  it('console env for master carries its own bearer, which resolves to master (G2-r4 + r6 #23)', async () => {
    const { consoleEnvs, base, root, index, tokens } = await setup(true, [])
    // A session in a folder no agent declares belongs to master.
    const loose = mkdtempSync(join(tmpdir(), 'deck-loose-'))
    const id = randomUUID()
    const mf = mungePath(loose)
    mkdirSync(join(root, mf), { recursive: true })
    writeFileSync(
      join(root, mf, `${id}.jsonl`),
      JSON.stringify({ type: 'user', sessionId: id, cwd: loose, timestamp: new Date().toISOString(), message: { role: 'user', content: 'hello' } }) + '\n',
    )
    await index.refresh(mf, id)
    const res = await app.inject({ method: 'POST', url: '/api/console', payload: { id } })
    expect(res.statusCode).toBe(201)
    expect(consoleEnvs).toHaveLength(1)
    expect(consoleEnvs[0]!.SILOS_AGENT_ID).toBe('master')
    const bearer = consoleEnvs[0]!.SILOS_AGENT_TOKEN
    expect(bearer).toMatch(/^[0-9a-f]{64}$/)
    expect(tokens.agentIdOf(bearer!)).toBe('master')
    expect(existsSync(join(base, 'data', 'agents', 'master', 'token'))).toBe(true)
  })

  // Births (plugin 0.7.0): the console's claude knows its own conversation
  // as SILOS_SESSION_ID, so a `claude -p` it runs from Bash inherits it and
  // presents itself as that conversation's nested run.
  it("console env: SILOS_SESSION_ID is the fresh console's session id", async () => {
    const { consoleEnvs } = await setup(true)
    const res = await app.inject({ method: 'POST', url: '/api/console', payload: { agentId: 'writer' } })
    expect(res.statusCode).toBe(201)
    expect(consoleEnvs[0]!.SILOS_SESSION_ID).toBe((res.json() as { key: string }).key)
  })

  it('console env: SILOS_SESSION_ID is the resumed session on a resume', async () => {
    const { root, folder, index, consoleEnvs } = await setup(true)
    const id = randomUUID()
    const mf = mungePath(folder)
    mkdirSync(join(root, mf), { recursive: true })
    writeFileSync(
      join(root, mf, `${id}.jsonl`),
      JSON.stringify({ type: 'user', sessionId: id, cwd: folder, timestamp: new Date().toISOString(), message: { role: 'user', content: 'hello' } }) + '\n',
    )
    await index.refresh(mf, id)
    expect((await app.inject({ method: 'POST', url: '/api/console', payload: { id } })).statusCode).toBe(201)
    expect(consoleEnvs[0]!.SILOS_SESSION_ID).toBe(id)
  })

  // a nested run (an agent's `claude -p`, presented at birth, not launched
  // by Silos) is a transcript, like an automation run: a --resume would
  // make it one of the owner's threads.
  it('a nested run never gets a console (409)', async () => {
    const { root, folder, index, births, seen } = await setup(true)
    const id = randomUUID()
    const mf = mungePath(folder)
    mkdirSync(join(root, mf), { recursive: true })
    writeFileSync(
      join(root, mf, `${id}.jsonl`),
      JSON.stringify({ type: 'user', sessionId: id, cwd: folder, timestamp: new Date().toISOString(), message: { role: 'user', content: 'smoke' } }) + '\n',
    )
    await index.refresh(mf, id)
    births.set(id, { sessionId: id, agentId: 'writer', parent: 'p-1', cwd: folder, source: 'startup', at: new Date().toISOString(), ctimeMs: 0 })
    const res = await app.inject({ method: 'POST', url: '/api/console', payload: { id } })
    expect(res.statusCode).toBe(409)
    // p-1 is not indexed: the parent can't be verified as the same agent's → loose
    expect(res.json()).toMatchObject({ error: 'nested run', nested: true, parent: null, agentId: 'writer' })
    expect(seen).toHaveLength(0)
  })

  // ONE rule for both engines — a nested run is a transcript
  // on the chat engine too (the console route already refuses it).
  it('a chat turn into a nested run is refused (409, nested)', async () => {
    const { root, folder, index, births } = await setup(true)
    const id = randomUUID()
    const mf = mungePath(folder)
    mkdirSync(join(root, mf), { recursive: true })
    writeFileSync(
      join(root, mf, `${id}.jsonl`),
      JSON.stringify({ type: 'user', sessionId: id, cwd: folder, timestamp: new Date().toISOString(), message: { role: 'user', content: 'smoke' } }) + '\n',
    )
    await index.refresh(mf, id)
    births.set(id, { sessionId: id, agentId: 'writer', parent: null, cwd: folder, source: 'startup', at: new Date().toISOString(), ctimeMs: 0 })
    const res = await app.inject({ method: 'POST', url: '/api/agents/writer/chat', payload: { text: 'hello', session: { folder: mf, id } } })
    expect(res.statusCode).toBe(409)
    expect(res.json()).toMatchObject({ error: 'nested run', nested: true, agentId: 'writer' })
  })
})
