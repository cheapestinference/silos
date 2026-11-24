// delete-stops-every-engine.test.ts — deleting a conversation is the same
// gesture on every registered engine: whatever deleting MEANS (the
// fallback's trash, another engine's hide), a ticked «Also stop them» stops
// the conversation's stoppable processes and says so, without the flag
// nothing is stopped, and the conversation's live Silos console is closed
// either way. Registry-driven: every harness registered (the fake third one
// included, for this file) through its conformance fixture's reader; a FAKE
// process table and a FAKE signal — no real pid is ever signalled.
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { registerHarness, registeredHarnesses } from '../src/harnesses/index.js'
import type { HarnessId } from '../src/harnesses/contract.js'
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
import { ProcessRecords, SILOS_SESSION_KEY, type StopSignal } from '../src/silos/processes.js'
import type { ProcEntry, ProcTable, ProcessTableReader } from '../src/silos/proc-table.js'
import { fakeHarness } from './fixtures/fake-harness.js'
import { runCleanups, type ConformanceFixture } from './conformance/contract.js'

const modules = import.meta.glob<{ fixture: ConformanceFixture }>('./conformance/*.fixture.ts', { eager: true })
const fixtures = new Map<HarnessId, ConformanceFixture>(Object.values(modules).map((m) => [m.fixture.harness.id, m.fixture]))

let unregisterFake: () => void = () => {}
beforeAll(() => {
  unregisterFake = registerHarness(fakeHarness)
})
afterAll(() => unregisterFake())

const T0 = Date.parse('2026-11-21T10:00:00Z')
const TOKEN = 't0k'
const OWNER = { 'x-token': TOKEN, 'content-type': 'application/json' }

const proc = (pid: number, ppid: number, argv: string[], session: string): ProcEntry => ({
  pid,
  ppid,
  startTicks: pid * 10,
  startedAt: T0 - 3600_000,
  comm: argv[0]!,
  argv,
  cwd: '/tmp/p',
  cpuSeconds: 0,
  rssBytes: 8 * 1024 * 1024,
  env: { [SILOS_SESSION_KEY]: session },
})
class Machine implements ProcessTableReader {
  procs: ProcEntry[] = []
  listeners: ProcTable['listeners'] = []
  sent: Array<[number, StopSignal]> = []
  now = T0
  read = async (): Promise<ProcTable> => ({ at: this.now, uid: 1000, procs: this.procs.map((p) => ({ ...p })), listeners: this.listeners, complete: true })
  alive = async (ps: ReadonlyArray<{ pid: number; startTicks: number }>) =>
    ps.filter((p) => this.procs.some((x) => x.pid === p.pid && x.startTicks === p.startTicks)).map((p) => ({ ...p }))
  signal = (pid: number, sig: StopSignal): void => {
    this.sent.push([pid, sig])
    this.procs = this.procs.filter((x) => x.pid !== pid)
  }
  wait = async (ms: number): Promise<void> => {
    this.now += ms
  }
}

let app: FastifyInstance | undefined
let base = ''
afterEach(async () => {
  await app?.close()
  app = undefined
  runCleanups()
  if (base) rmSync(base, { recursive: true, force: true })
})

// the engine's conversation (its fixture's victim) left a dev server
// running, and a Silos console bound to it under a Silos key
async function boot(f: ConformanceFixture): Promise<{ m: Machine; killed: string[]; victim: { folder: string; id: string } }> {
  const r = await f.reader()
  base = mkdtempSync(join(tmpdir(), 'silos-delete-engines-'))
  const dataDir = join(base, 'data')
  mkdirSync(join(dataDir, 'trash'), { recursive: true })
  const registry = new AgentRegistry(join(dataDir, 'agents.json'))
  registry.load()
  const native = new NativeStore(join(dataDir, 'native.json'))
  const terminals = new TerminalService(registry, r.index, undefined, undefined, { tmuxSocket: join(base, 'tmux.sock') })
  terminals.hasConsole = () => false
  const killed: string[] = []
  terminals.killConsoleAndWait = async (k: string) => {
    killed.push(k)
  }
  terminals.holdersOf = () => []
  terminals.holderDetailsOf = () => []
  terminals.bindNativeId('silos-console-key', r.victim.id)
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
  chat.isSessionActive = () => false
  const m = new Machine()
  const processes = new ProcessRecords({
    file: join(dataDir, 'silos', 'kernel', 'process', 'processes.json'),
    table: m,
    sessionKeys: () => [SILOS_SESSION_KEY],
    engineCommands: () => new Set(),
    selfPid: 900,
    conversations: (ids) => new Map(ids.map((id) => [id, { session: id, folder: r.victim.folder, agent: null, title: 'a conversation', running: false }])),
    now: () => m.now,
    signal: m.signal,
    wait: m.wait,
  })
  m.procs = [proc(21, 1, ['npm', 'run', 'dev'], r.victim.id), proc(22, 21, ['node', 'vite'], r.victim.id)]
  m.listeners = [{ port: 5193, uid: 1000, user: 'op', pids: [22] }]
  await processes.tick()
  const root = r.root ?? join(base, 'projects')
  app = buildServer({
    index: r.index,
    registry,
    store: new SessionStore(root, dataDir),
    native,
    chat,
    exec: new ExecService(registry),
    complete: new CompleteService(registry, r.index),
    prefs: new PrefsStore(dataDir),
    memory: new MemoryService(root, dataDir, registry),
    terminals,
    token: TOKEN,
    liveMs: 120_000,
    processes,
  })
  return { m, killed, victim: r.victim }
}

const del = (v: { folder: string; id: string }, body: unknown) =>
  app!.inject({ method: 'POST', url: `/api/sessions/${v.folder}/${v.id}/trash`, headers: OWNER, payload: JSON.stringify(body) })

describe('delete with «Also stop them» — the same on every engine', () => {
  it('covers every registered harness', () => {
    for (const h of registeredHarnesses()) expect(fixtures.has(h.id), `no conformance fixture for ${h.id}`).toBe(true)
  })

  // the registry as the server boots it, plus the fake third engine
  // (registered for this file in beforeAll)
  for (const id of [...registeredHarnesses().map((h) => h.id), fakeHarness.id]) {
    it(`${id}: the flag stops the conversation's processes and says so; its console closes`, async () => {
      const b = await boot(fixtures.get(id)!)
      const res = await del(b.victim, { thread: true, stopProcesses: true })
      expect(res.statusCode).toBe(200)
      expect(res.json().processes).toEqual({
        stopped: [expect.objectContaining({ command: 'npm run dev', outcome: 'stopped' })],
        notStopped: [],
        says: 'stopped 1 process',
      })
      expect(b.m.sent.map(([pid]) => pid).sort()).toEqual([21, 22])
      expect(b.killed).toContain('silos-console-key')
    })

    it(`${id}: without the flag nothing is stopped, the answer carries no processes; its console still closes`, async () => {
      const b = await boot(fixtures.get(id)!)
      const res = await del(b.victim, { thread: true })
      expect(res.statusCode).toBe(200)
      expect(res.json().processes).toBeUndefined()
      expect(b.m.sent).toEqual([])
      expect(b.killed).toContain('silos-console-key')
    })
  }
})
