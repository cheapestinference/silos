import { makeOpenCodeDb } from './helpers/opencode-db.js'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentRegistry, mungePath } from '../src/agent-registry.js'
import { ephemeralPrefix } from '../src/ephemeral.js'
import { OpenCodeReader, pendingOf } from '../src/harnesses/opencode/reader.js'
import type { AsksStore, PendingAsk } from '../src/asks-store.js'
import { OpenCodeDb } from '../src/harnesses/opencode/db.js'
import { agentDbPath, globalDbPath } from '../src/harnesses/opencode/paths.js'

const T0 = 1776984076759
const DAY = 86_400_000
const session = (id: string, directory: string, over: Record<string, unknown> = {}) => ({
  id,
  project_id: 'p_' + id,
  directory,
  title: `title ${id}`,
  version: '1.14.22',
  time_created: T0,
  time_updated: T0 + 1000,
  ...over,
})
const user = (agent = 'build') => ({ role: 'user', agent, time: { created: T0 + 10 } })
const assistant = (agent = 'build') => ({
  role: 'assistant',
  agent,
  cost: 0,
  modelID: 'MiniMax-M2.7',
  providerID: 'minimax-coding-plan',
  tokens: { total: 3, input: 1, output: 2, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: T0 + 20, completed: T0 + 30 },
  finish: 'stop',
})

let base: string, dataDir: string, registry: AgentRegistry
let devDb: ReturnType<typeof makeOpenCodeDb>, globalDb: ReturnType<typeof makeOpenCodeDb>
const readers: OpenCodeReader[] = []
const scratch = join(tmpdir(), 'scratch')

function reader(over: Partial<ConstructorParameters<typeof OpenCodeReader>[0]> = {}): OpenCodeReader {
  const r = new OpenCodeReader({ dataDir, registry, globalDb: globalDb.path, muted: [], ephemeralPrefix: ephemeralPrefix(), ...over })
  readers.push(r)
  return r
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'opencode-reader-'))
  dataDir = join(base, 'data')
  mkdirSync(join(dataDir, 'agents', 'writer'), { recursive: true })
  writeFileSync(
    join(dataDir, 'agents.json'),
    JSON.stringify({ agents: [{ id: 'writer', name: 'Writer', role: 'writer', folder: '/home/u/proj', framework: 'opencode' }] }),
  )
  registry = new AgentRegistry(join(dataDir, 'agents.json'))
  registry.load()

  devDb = makeOpenCodeDb(join(dataDir, 'agents', 'writer'))
  devDb.insertSession(session('ses_dev1', '/home/u/proj'))
  devDb.insertMessage({ id: 'msg_d1', session_id: 'ses_dev1', time_created: T0 + 10, data: user() })
  devDb.insertMessage({ id: 'msg_d2', session_id: 'ses_dev1', time_created: T0 + 20, data: assistant() })
  devDb.insertPart({ id: 'prt_d1', message_id: 'msg_d2', session_id: 'ses_dev1', time_created: T0 + 21, data: { type: 'text', text: 'done' } })

  mkdirSync(join(base, 'global'))
  globalDb = makeOpenCodeDb(join(base, 'global'))
  globalDb.insertSession(session('ses_glob1', '/home/u/other'))
  globalDb.insertSession(session('ses_tmp1', scratch))
})
afterEach(() => {
  vi.restoreAllMocks()
  for (const r of readers.splice(0)) r.close()
  devDb.close()
  globalDb.close()
  rmSync(base, { recursive: true, force: true })
})

describe('OpenCodeReader', () => {
  it("lists the agents' and the global sessions, skipping tmp folders, and records who owns an agent DB", async () => {
    const r = reader()
    await r.init()
    const metas = r.list()
    expect(metas.map((m) => m.id).sort()).toEqual(['ses_dev1', 'ses_glob1'])
    expect(metas.find((m) => m.id === 'ses_dev1')).toMatchObject({ harness: 'opencode', folder: '-home-u-proj', title: 'title ses_dev1', turnCount: 1 })
    expect(r.agentOfDb('ses_dev1')).toBe('writer')
    expect(r.agentOfDb('ses_glob1')).toBeNull()
    expect(r.getMeta('-home-u-other', 'ses_glob1')).toMatchObject({ id: 'ses_glob1' })
    expect(r.ownsId('ses_x')).toBe(true)
    expect(r.ownsId('2f6a…uuid')).toBe(false)
    expect((await r.readTurns('-home-u-proj', 'ses_dev1')).map((t) => t.text)).toEqual(['', 'done'])
  })

  it('skips a muted folder too', async () => {
    const r = reader({ muted: [mungePath('/home/u/other')] })
    await r.init()
    expect(r.list().map((m) => m.id)).toEqual(['ses_dev1'])
  })

  it('a missing global DB is an empty list, not an error', async () => {
    const r = reader({ globalDb: join(base, 'nope', 'opencode.db') })
    await r.init()
    expect(r.list().map((m) => m.id)).toEqual(['ses_dev1'])
  })

  it('remove() hides a session across restarts until 30 days have passed — the DB is never written', async () => {
    const r = reader()
    await r.init()
    const onChange = vi.fn()
    r.watch(onChange)
    r.remove('-home-u-other', 'ses_glob1')
    expect(r.list().map((m) => m.id)).toEqual(['ses_dev1'])
    expect(r.getMeta('-home-u-other', 'ses_glob1')).toBeNull()
    expect(onChange).not.toHaveBeenCalled() // the SessionIndex emits 'removed' itself

    const again = reader()
    await again.init()
    expect(again.list().map((m) => m.id)).toEqual(['ses_dev1'])

    const later = reader({ now: () => Date.now() + 31 * DAY })
    await later.init()
    expect(
      later
        .list()
        .map((m) => m.id)
        .sort(),
    ).toEqual(['ses_dev1', 'ses_glob1'])
  })

  it('watch(): a write to an agent DB reports the session as updated, a new one as created', async () => {
    const r = reader()
    await r.init()
    const onChange = vi.fn()
    r.watch(onChange)
    devDb.insertMessage({ id: 'msg_d3', session_id: 'ses_dev1', time_created: T0 + 5000, data: user() })
    devDb.touchSession('ses_dev1', T0 + 5000)
    await vi.waitFor(() => expect(onChange).toHaveBeenCalledWith({ harness: 'opencode', folder: '-home-u-proj', id: 'ses_dev1' }, 'updated'), { timeout: 1000 })
    expect(r.getMeta('-home-u-proj', 'ses_dev1')).toMatchObject({ turnCount: 2, mtime: T0 + 5000 })

    devDb.insertSession(session('ses_dev2', '/home/u/proj', { time_updated: T0 + 6000 }))
    await vi.waitFor(() => expect(onChange).toHaveBeenCalledWith({ harness: 'opencode', folder: '-home-u-proj', id: 'ses_dev2' }, 'created'), { timeout: 1000 })
    expect(r.agentOfDb('ses_dev2')).toBe('writer')
  })

  it("a child session (a subagent) is not a row: it shows in its parent's context agents", async () => {
    devDb.insertSession(session('ses_child', '/home/u/proj', { parent_id: 'ses_dev1', title: 'Explore the repo' }))
    devDb.insertMessage({ id: 'msg_c1', session_id: 'ses_child', time_created: T0 + 40, data: user('explore') })
    devDb.insertMessage({ id: 'msg_c2', session_id: 'ses_child', time_created: T0 + 50, data: assistant('explore') })
    const r = reader()
    await r.init()
    expect(
      r
        .list()
        .map((m) => m.id)
        .sort(),
    ).toEqual(['ses_dev1', 'ses_glob1'])
    expect(r.getContext('-home-u-proj', 'ses_dev1')!.agents).toEqual([
      expect.objectContaining({
        id: 'ses_child',
        type: 'explore',
        description: 'Explore the repo',
        background: false,
        model: 'minimax-coding-plan/MiniMax-M2.7',
      }),
    ])
  })

  it('a child whose first message is `build` is a continuation, listed as its own row', async () => {
    devDb.insertSession(session('ses_fork', '/home/u/proj', { parent_id: 'ses_dev1' }))
    devDb.insertMessage({ id: 'msg_f1', session_id: 'ses_fork', time_created: T0 + 40, data: user('build') })
    const r = reader()
    await r.init()
    expect(r.getMeta('-home-u-proj', 'ses_fork')).toMatchObject({ resumedFrom: 'ses_dev1' })
    expect(r.getContext('-home-u-proj', 'ses_dev1')!.agents).toEqual([])
  })
})

// Agents share the uid and can write their own DB with
// sqlite3 — a row alone must not claim a session for its agent.
describe('OpenCodeReader — a row proves nothing by itself', () => {
  const builderDir = () => join(dataDir, 'agents', 'builder')
  function addCto(): ReturnType<typeof makeOpenCodeDb> {
    registry.create({ id: 'builder', name: 'Builder', folder: '/home/u/proj' })
    mkdirSync(builderDir(), { recursive: true })
    return makeOpenCodeDb(builderDir())
  }

  it('a Claude-UUID row in an agent DB is never listed and never owned (warned once)', async () => {
    const uuid = '0b9c6a52-1111-4222-8333-444455556666'
    devDb.insertSession(session(uuid, '/home/u/proj'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const r = reader()
    await r.init()
    expect(r.list().map((m) => m.id)).not.toContain(uuid)
    expect(r.agentOfDb(uuid)).toBeNull()
    expect(r.agentOfDb('ses_dev1')).toBe('writer')
    expect(warn.mock.calls.filter((c) => String(c[0]).includes(uuid))).toHaveLength(1)
  })

  it('a ses_ id in an agent DB AND the global DB: no owner, listed once — the global row', async () => {
    devDb.insertSession(session('ses_glob1', '/home/u/proj', { title: 'planted' }))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const r = reader()
    await r.init()
    expect(r.agentOfDb('ses_glob1')).toBeNull()
    const rows = r.list().filter((m) => m.id === 'ses_glob1')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ folder: '-home-u-other', title: 'title ses_glob1' })
  })

  it('the same ses_ id in two agent DBs: no owner, not listed', async () => {
    const builderDb = addCto()
    builderDb.insertSession(session('ses_dev1', '/home/u/proj', { title: 'planted' }))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const r = reader()
    await r.init()
    expect(r.agentOfDb('ses_dev1')).toBeNull()
    expect(r.isContested('ses_dev1')).toBe(true)
    expect(r.isContested('ses_other')).toBe(false)
    expect(r.list().map((m) => m.id)).not.toContain('ses_dev1')
    expect(r.getMeta('-home-u-proj', 'ses_dev1')).toBeNull()
    builderDb.close()
  })

  // the contest is durable — X deleting its copy and a Silos
  // restart must not hand the id (and a native record sealed for it) back.
  it('a contest survives a restart after the second copy is gone (contested-sessions.json)', async () => {
    const builderDb = addCto()
    builderDb.insertSession(session('ses_dev1', '/home/u/proj'))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const r = reader()
    await r.init()
    expect(r.isContested('ses_dev1')).toBe(true)
    expect(JSON.parse(readFileSync(join(dataDir, 'contested-sessions.json'), 'utf8'))).toEqual(['ses_dev1'])
    builderDb.close()
    rmSync(builderDir(), { recursive: true, force: true })
    r.close()
    const after = reader() // the restart
    await after.init()
    expect(after.isContested('ses_dev1')).toBe(true)
    expect(after.agentOfDb('ses_dev1')).toBeNull()
    expect(after.list().map((m) => m.id)).not.toContain('ses_dev1')
  })

  it('a listed agent session that turns up in another agent DB later is withdrawn (removed)', async () => {
    const r = reader()
    await r.init()
    const onChange = vi.fn()
    r.watch(onChange)
    const builderDb = addCto()
    builderDb.insertSession(session('ses_dev1', '/home/u/proj', { time_updated: T0 + 9000 }))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    // new agent DBs are looked for on a 10 s timer — run that pass now
    ;(r as unknown as { syncAgentSources(): void }).syncAgentSources()
    expect(r.agentOfDb('ses_dev1')).toBeNull()
    expect(r.list().map((m) => m.id)).not.toContain('ses_dev1')
    expect(onChange).toHaveBeenCalledWith({ harness: 'opencode', folder: '-home-u-proj', id: 'ses_dev1' }, 'removed')
    builderDb.close()
  })

  it('the registrar never seals a marker for a contested id (it waits, like an unknown one)', async () => {
    const { AgentStateStore } = await import('../src/agent-state.js')
    const { BirthsStore } = await import('../src/births-store.js')
    const { NativeStore } = await import('../src/native-store.js')
    const { ConsoleRegistrar } = await import('../src/harnesses/opencode/registrar.js')
    devDb.insertSession(session('ses_glob1', '/home/u/proj'))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const r = reader()
    await r.init()
    const stateDir = join(base, 'agent-state')
    mkdirSync(join(stateDir, 'writer', 'births'), { recursive: true })
    writeFileSync(
      join(stateDir, 'writer', 'births', 'ses_glob1.json'),
      JSON.stringify({
        sessionId: 'ses_glob1',
        agentId: 'writer',
        parent: null,
        cwd: '/home/u/proj',
        source: 'startup',
        harness: 'opencode',
        consoleKey: 'live',
        at: '2026-10-26T10:00:00Z',
      }),
    )
    const native = new NativeStore(join(base, 'native.json'))
    const bindNativeId = vi.fn()
    const registrar = new ConsoleRegistrar({
      births: new BirthsStore(new AgentStateStore(stateDir), { ttlMs: 0 }),
      native,
      terminals: {
        listConsoles: () => [{ key: 'live', attached: 0, createdMs: 0 }],
        consoleAgent: () => 'writer',
        nativeIdOf: () => null,
        bindNativeId,
        setConsoleAgent: vi.fn(),
        consoleRecords: () => [],
      },
      mungePath,
      agentOfDb: (id) => r.agentOfDb(id),
      isContested: (id) => r.isContested(id),
    })
    expect(await registrar.sweep()).toBe(0)
    expect(native.get('-home-u-proj', 'ses_glob1')).toBeNull()
    expect(bindNativeId).not.toHaveBeenCalled()
  })
})

describe('OpenCodeReader degrades instead of failing', () => {
  it('node:sqlite unavailable: one log line, init() resolves, list() is empty', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const r = reader({
      sqlite: () => {
        throw new Error('No such built-in module: node:sqlite')
      },
    })
    await expect(r.init()).resolves.toBeUndefined()
    expect(r.list()).toEqual([])
    expect(r.getContext('-home-u-proj', 'ses_dev1')).toBeNull()
    expect(err).toHaveBeenCalledTimes(1)
    expect(err.mock.calls[0]![0]).toBe('opencode: node:sqlite unavailable (No such built-in module: node:sqlite) — OpenCode sessions will not be read')
  })

  it('a row that fails to load (SQLITE_BUSY) is read again on the next scan, not skipped for good', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const real = OpenCodeDb.prototype.messages
    let busy = 2 // once at init, once on the first scan
    vi.spyOn(OpenCodeDb.prototype, 'messages').mockImplementation(function (this: OpenCodeDb, sid: string) {
      if (sid === 'ses_dev1' && busy-- > 0) throw new Error('database is locked')
      return real.call(this, sid)
    })
    devDb.insertSession(session('ses_dev0', '/home/u/proj', { time_updated: T0 + 500 })) // older: loads after the failure
    const r = reader()
    await r.init()
    expect(
      r
        .list()
        .map((m) => m.id)
        .sort(),
    ).toEqual(['ses_dev0', 'ses_glob1'])
    const onChange = vi.fn()
    r.watch(onChange)
    devDb.insertSession(session('ses_dev2', '/home/u/proj', { time_updated: T0 + 6000 }))
    await vi.waitFor(() => expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ id: 'ses_dev2' }), 'created'), { timeout: 1000 })
    expect(r.getMeta('-home-u-proj', 'ses_dev1')).toBeNull() // still busy on that scan
    devDb.touchSession('ses_dev2', T0 + 7000)
    await vi.waitFor(() => expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ id: 'ses_dev1' }), 'created'), { timeout: 1000 })
    expect(r.getMeta('-home-u-proj', 'ses_dev1')).toMatchObject({ turnCount: 1 })
  })

  it('an agent writing faster than the debounce is still scanned while it writes (max wait)', async () => {
    const r = reader()
    await r.init()
    const onChange = vi.fn()
    r.watch(onChange)
    let t = T0 + 10_000
    let calledWhileWriting = false
    const writer = setInterval(() => {
      t += 1
      devDb.insertMessage({ id: `msg_w${t}`, session_id: 'ses_dev1', time_created: t, data: user() })
      devDb.touchSession('ses_dev1', t)
      if (onChange.mock.calls.length > 0) calledWhileWriting = true
    }, 50)
    await new Promise((res) => setTimeout(res, 1500))
    clearInterval(writer)
    expect(calledWhileWriting).toBe(true)
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ id: 'ses_dev1' }), 'updated')
  })
})

describe('opencode paths', () => {
  it('global DB: SILOS_OPENCODE_DATA › XDG_DATA_HOME › ~/.local/share; agent DB under the data dir', () => {
    vi.stubEnv('SILOS_OPENCODE_DATA', '/x/data')
    expect(globalDbPath()).toBe('/x/data/opencode/opencode.db')
    vi.stubEnv('SILOS_OPENCODE_DATA', '')
    vi.stubEnv('XDG_DATA_HOME', '/xdg')
    expect(globalDbPath()).toBe('/xdg/opencode/opencode.db')
    vi.stubEnv('XDG_DATA_HOME', '')
    expect(globalDbPath('/h')).toBe('/h/.local/share/opencode/opencode.db')
    vi.unstubAllEnvs()
    expect(agentDbPath('/d', 'writer')).toBe('/d/agents/writer/opencode.db')
  })
})

describe('OpenCodeReader — permission asks (asks-store.ts)', () => {
  const ask = (over: Partial<PendingAsk> = {}): PendingAsk => ({
    agentId: 'writer',
    sessionId: 'ses_dev1',
    id: 'per_1',
    type: 'bash',
    pattern: 'rm -rf dist',
    title: null,
    askedAt: '2026-10-26T10:00:00.000Z',
    ...over,
  })
  const store = (asks: PendingAsk[]) => ({ forSession: (id: string) => asks.filter((a) => a.sessionId === id) }) as unknown as AsksStore

  it('pendingOf: the newest ask, as a Permission question with Allow / Deny', () => {
    expect(pendingOf([])).toBeNull()
    expect(pendingOf([ask(), ask({ id: 'per_2', title: 'Edit src/a.ts', askedAt: '2026-10-26T11:00:00.000Z' })])).toEqual({
      question: 'Edit src/a.ts',
      header: 'Permission',
      options: [{ label: 'Allow' }, { label: 'Deny' }],
      askedAt: '2026-10-26T11:00:00.000Z',
    })
    expect(pendingOf([ask({ pattern: null })])!.question).toBe('bash')
  })

  it("a pending ask from the session's own agent sets context.pending and the pendingAsk dot", async () => {
    const r = reader({ asks: store([ask()]) })
    await r.init()
    expect(r.getContext('-home-u-proj', 'ses_dev1')!.pending).toMatchObject({ question: 'bash rm -rf dist', header: 'Permission' })
    expect(r.getMeta('-home-u-proj', 'ses_dev1')!.pendingAsk).toBe(true)
    expect(r.list().find((m) => m.id === 'ses_dev1')!.pendingAsk).toBe(true)
    expect(r.getMeta('-home-u-other', 'ses_glob1')!.pendingAsk).toBeUndefined()
  })

  it("an ask written by another agent's plugin for this session never counts", async () => {
    const r = reader({ asks: store([ask({ agentId: 'finance' })]) })
    await r.init()
    expect(r.getContext('-home-u-proj', 'ses_dev1')!.pending).toBeNull()
    expect(r.getMeta('-home-u-proj', 'ses_dev1')!.pendingAsk).toBeUndefined()
  })
})
