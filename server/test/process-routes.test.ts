// process-routes.test.ts — the routes over the System silo's processes, on
// a real server with a FAKE process table and a FAKE signal (no real pid is
// ever signalled): POST /api/silos/system/record/kernel-verb (the owner's
// stop-process; an agent bearer refused), GET /api/sessions/:f/:id/processes
// across a /clear-rotated thread, and the trash's «also stop» — only with the
// flag, only on the thread's tip, never on a refusal path. Fixtures generic.
import { describe, it, expect, afterEach } from 'vitest'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { claudeSessionIndex } from '../src/harnesses/claude-code/reader.js'
import { AgentRegistry } from '../src/agent-registry.js'
import { AgentTokens } from '../src/agent-tokens.js'
import { SessionStore } from '../src/session-store.js'
import { NativeStore } from '../src/native-store.js'
import { ChatService } from '../src/chat-service.js'
import { ExecService } from '../src/exec-service.js'
import { CompleteService } from '../src/complete-service.js'
import { PrefsStore } from '../src/prefs-store.js'
import { MemoryService } from '../src/memory-service.js'
import { LineageStore } from '../src/lineage.js'
import { TerminalService } from '../src/terminal-service.js'
import { buildServer } from '../src/server.js'
import { SiloRegistry } from '../src/silos/registry.js'
import { SiloKernel } from '../src/silos/kernel.js'
import { SiloReader } from '../src/silos/reader.js'
import { TransitionJournal } from '../src/silos/journal.js'
import { SiloActions, SiloAcks, SiloEvents, SiloProposals } from '../src/silos/actions.js'
import { ProcessRecords, SILOS_SESSION_KEY, type StopSignal } from '../src/silos/processes.js'
import type { ProcEntry, ProcTable, ProcessTableReader } from '../src/silos/proc-table.js'

const T0 = Date.parse('2026-11-21T10:00:00Z')
const TOKEN = 't0k'
const OWNER = { 'x-token': TOKEN, 'content-type': 'application/json' }
const REF = join(import.meta.dirname, '..', '..', 'docs', 'standard', 'reference', 'system.silo.json')

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

let app: FastifyInstance
let base: string
afterEach(async () => {
  await app?.close()
  rmSync(base, { recursive: true, force: true })
})

interface Boot {
  m: Machine
  src: ProcessRecords
  tokens: AgentTokens
  chatActive: Set<string>
  holders: Set<string>
}

// a thread `root` → `tip` (a /clear rotated it); a dev server born in `root`
// (its processes carry root's id) on 5193, and one of another conversation
async function boot(): Promise<Boot> {
  base = mkdtempSync(join(tmpdir(), 'silos-proc-routes-'))
  const root = join(base, 'projects')
  const dataDir = join(base, 'data')
  mkdirSync(join(root, '-tmp-p'), { recursive: true })
  mkdirSync(join(dataDir, 'trash'), { recursive: true })
  for (const [id, at] of [
    ['root', T0 - 60_000],
    ['tip', T0],
    ['other', T0],
  ] as const) {
    const f = join(root, '-tmp-p', `${id}.jsonl`)
    writeFileSync(f, `{"type":"user","cwd":"/tmp/p","message":{"role":"user","content":"${id}"}}\n`)
    utimesSync(f, new Date(at), new Date(at))
  }
  const index = claudeSessionIndex(root, join(dataDir, 'cache.json'))
  await index.init()
  const registry = new AgentRegistry(join(dataDir, 'agents.json'))
  registry.load()
  registry.create({ id: 'writer', name: 'Writer', folder: '/tmp/p' })
  const tokens = new AgentTokens(dataDir)
  const lineage = new LineageStore(join(dataDir, 'lineage.json'))
  lineage.record('-tmp-p/tip', '-tmp-p/root')
  const native = new NativeStore(join(dataDir, 'native.json'))
  const terminals = new TerminalService(registry, index, undefined, undefined, { tmuxSocket: join(base, 'tmux.sock') })
  terminals.hasConsole = () => false
  terminals.killConsoleAndWait = async () => {}
  const holders = new Set<string>()
  terminals.holdersOf = (id: string) => (holders.has(id) ? [4242] : [])
  terminals.holderDetailsOf = (id: string) =>
    holders.has(id) ? [{ pid: 4242, tmux: null, name: null, cwd: null, kind: null, status: null, startedAt: null, updatedAt: null } as never] : []
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
  const chatActive = new Set<string>()
  chat.isSessionActive = (id: string) => chatActive.has(id)
  // the processes
  const m = new Machine()
  const src = new ProcessRecords({
    file: join(dataDir, 'silos', 'kernel', 'process', 'processes.json'),
    table: m,
    sessionKeys: () => [SILOS_SESSION_KEY],
    engineCommands: () => new Set(),
    selfPid: 900,
    conversations: (ids) => new Map(ids.map((id) => [id, { session: id, folder: '-tmp-p', agent: 'writer', title: `the ${id} conversation`, running: false }])),
    now: () => m.now,
    signal: m.signal,
    wait: m.wait,
  })
  m.procs = [
    proc(21, 1, ['npm', 'run', 'dev'], 'root'),
    proc(22, 21, ['node', 'vite'], 'root'),
    proc(31, 1, ['node', 'srv.js'], 'other'),
    proc(900, 1, ['node', 'index.ts'], 'tip'),
  ]
  m.listeners = [
    { port: 5193, uid: 1000, user: 'op', pids: [22] },
    { port: 7000, uid: 1000, user: 'op', pids: [31] },
    { port: 3210, uid: 1000, user: 'op', pids: [900] },
  ]
  await src.tick()
  // the System silo, active
  mkdirSync(join(dataDir, 'silos', 'registry', 'system'), { recursive: true })
  copyFileSync(REF, join(dataDir, 'silos', 'registry', 'system', 'silo.json'))
  const siloRegistry = new SiloRegistry({ dataDir, operator: { decisionFor: () => 'approved' as const, slotsOff: () => [] } })
  siloRegistry.load()
  const siloJournal = new TransitionJournal(siloRegistry.conventionsDir)
  const siloKernel = new SiloKernel({
    registry: siloRegistry,
    journal: siloJournal,
    reader: new SiloReader({ agentStates: () => [], projects: () => [] }, (k) => (k === 'process' ? src : null)),
  })
  siloKernel.refresh()
  const siloActions = new SiloActions({
    registry: siloRegistry,
    kernel: siloKernel,
    events: new SiloEvents(siloRegistry.root),
    acks: new SiloAcks(siloRegistry.root),
    proposals: new SiloProposals(siloRegistry.root),
    agentStateBase: join(dataDir, 'agent-state'),
    isAgent: (v) => v === 'writer',
    agentMayReadLocation: () => false,
  })
  app = buildServer({
    index,
    registry,
    store: new SessionStore(root, dataDir),
    native,
    chat,
    exec: new ExecService(registry),
    complete: new CompleteService(registry, index),
    prefs: new PrefsStore(dataDir),
    memory: new MemoryService(root, dataDir, registry),
    lineage,
    terminals,
    token: TOKEN,
    liveMs: 120_000,
    agentTokens: tokens,
    siloRegistry,
    siloKernel,
    siloJournal,
    siloActions,
    processes: src,
  })
  return { m, src, tokens, chatActive, holders }
}

const post = (url: string, body: unknown, headers: Record<string, string> = OWNER) =>
  app.inject({ method: 'POST', url, headers, payload: JSON.stringify(body) })
const get = (url: string) => app.inject({ method: 'GET', url, headers: { 'x-token': TOKEN } })

describe("POST /api/silos/system/record/kernel-verb — stop-process, the owner's", () => {
  it('the owner stops a record: the answer says it, the record reads exited, its story has the event', async () => {
    const b = await boot()
    const res = await post('/api/silos/system/record/kernel-verb', { key: 'platform/21-210', name: 'stop-process' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({
      name: 'stop-process',
      key: 'platform/21-210',
      outcome: 'stopped',
      signalled: 2,
      stopped: 2,
      survivors: [],
      says: 'Stopped npm run dev — 2 processes.',
    })
    expect(b.m.sent.map(([pid, s]) => `${pid}:${s}`).sort()).toEqual(['21:SIGTERM', '22:SIGTERM'])
    const rec = await get(`/api/silos/system/record?key=${encodeURIComponent('platform/21-210')}`)
    expect(rec.json().value).toMatchObject({ state: 'exited', stoppedBy: 'owner', why: 'stopped by you', stoppable: false })
    expect(rec.json().events).toEqual([expect.objectContaining({ verb: 'kernel-verb', by: 'owner', text: 'stop-process: Stopped npm run dev — 2 processes.' })])
  })

  it("an agent bearer is refused in words, nothing signalled; so is a request without the owner's credential", async () => {
    const b = await boot()
    const bearer = await post(
      '/api/silos/system/record/kernel-verb',
      { key: 'platform/21-210', name: 'stop-process', turn: 'x' },
      { authorization: `Bearer ${b.tokens.tokenFor('writer')}`, 'content-type': 'application/json' },
    )
    expect(bearer.statusCode).toBe(403)
    expect(bearer.json().error).toMatch(/writer may not POST/)
    const none = await post(
      '/api/silos/system/record/kernel-verb',
      { key: 'platform/21-210', name: 'stop-process' },
      { 'content-type': 'application/json', host: '127.0.0.1:3210' },
    )
    expect([401, 403]).toContain(none.statusCode)
    expect(b.m.sent).toEqual([])
  })

  it('refusals in words: Silos itself (the when holds the door shut), an unknown name, an unknown record, a bad body', async () => {
    const b = await boot()
    const self = await post('/api/silos/system/record/kernel-verb', { key: 'platform/900-9000', name: 'stop-process' })
    expect(self.statusCode).toBe(409)
    expect(self.json().error).toContain('stop is not offered on it now')
    expect((await post('/api/silos/system/record/kernel-verb', { key: 'platform/21-210', name: 'restart-process' })).statusCode).toBe(404)
    expect((await post('/api/silos/system/record/kernel-verb', { key: 'platform/nope', name: 'stop-process' })).statusCode).toBe(404)
    expect((await post('/api/silos/system/record/kernel-verb', { key: 'platform/21-210' })).statusCode).toBe(400)
    expect(b.m.sent).toEqual([])
  })

  it('a row says whether it may be stopped: `stoppable` in the record values', async () => {
    await boot()
    const page = await get('/api/silos/system/records?values=1')
    const byId = new Map((page.json().records as Array<{ id: string; value: Record<string, unknown> }>).map((r) => [r.id, r.value]))
    expect(byId.get('21-210')).toMatchObject({ stoppable: true })
    expect(byId.get('900-9000')).toMatchObject({ origin: 'silos', stoppable: false })
  })
})

describe("GET /api/sessions/:folder/:id/processes — the thread's live processes", () => {
  it("a process born before the /clear answers from the tip and from the earlier row; another conversation's never", async () => {
    await boot()
    for (const id of ['tip', 'root']) {
      const res = await get(`/api/sessions/-tmp-p/${id}/processes`)
      expect(res.statusCode).toBe(200)
      expect(res.json().processes).toEqual([
        expect.objectContaining({
          id: '21-210',
          key: 'platform/21-210',
          command: 'npm run dev',
          state: 'left',
          stateLabel: 'left running',
          pid: 21,
          ports: '5193',
          processes: 2,
          memoryMb: 16,
          stoppable: true,
          startedAt: new Date(T0 - 3600_000).toISOString(),
        }),
      ])
    }
    expect((await get('/api/sessions/-tmp-p/other/processes')).json().processes.map((p: { id: string }) => p.id)).toEqual(['31-310'])
    expect((await get('/api/sessions/-tmp-p/missing/processes')).statusCode).toBe(404)
  })
})

describe('POST /api/sessions/:folder/:id/trash — «also stop», explicit, never automatic', () => {
  it('without the flag nothing is stopped — the answer is as before', async () => {
    const b = await boot()
    const res = await post('/api/sessions/-tmp-p/tip/trash', { thread: true })
    expect(res.statusCode).toBe(200)
    expect(res.json().processes).toBeUndefined()
    expect(b.m.sent).toEqual([])
  })

  it("with the flag on the thread's tip: its processes stop (named before the move, stopped after), said", async () => {
    const b = await boot()
    const res = await post('/api/sessions/-tmp-p/tip/trash', { thread: true, stopProcesses: true })
    expect(res.statusCode).toBe(200)
    expect(res.json().buried).toEqual(['-tmp-p/root'])
    expect(res.json().processes).toEqual({
      stopped: [{ id: '21-210', key: 'platform/21-210', command: 'npm run dev', outcome: 'stopped', says: 'Stopped npm run dev — 2 processes.' }],
      notStopped: [],
      says: 'stopped 1 process',
    })
    expect(b.m.sent.map(([pid]) => pid).sort()).toEqual([21, 22])
    expect(b.src.ofSessions(['root', 'tip'])).toEqual([])
  })

  it('with the flag on an ANCESTOR row: burying history stops nothing, and says so', async () => {
    const b = await boot()
    const res = await post('/api/sessions/-tmp-p/root/trash', { stopProcesses: true })
    expect(res.statusCode).toBe(200)
    expect(res.json().processes).toMatchObject({ stopped: [], notStopped: [], says: expect.stringContaining('burying history never stops live work') })
    expect(b.m.sent).toEqual([])
  })

  it('the refusal paths (a live turn, a claude holding it) stop nothing', async () => {
    const b = await boot()
    b.chatActive.add('tip')
    expect((await post('/api/sessions/-tmp-p/tip/trash', { thread: true, stopProcesses: true })).statusCode).toBe(409)
    b.chatActive.clear()
    b.holders.add('tip')
    expect((await post('/api/sessions/-tmp-p/tip/trash', { thread: true, stopProcesses: true })).statusCode).toBe(409)
    expect(b.m.sent).toEqual([])
  })

  it("another conversation's trash stops only its own; this server, though started from the tip's shell, is never its record", async () => {
    const b = await boot()
    expect(b.src.ofSessions(['tip']).map((p) => p.id)).toEqual([]) // Silos speaks as silos, with no session
    const res = await post('/api/sessions/-tmp-p/other/trash', { stopProcesses: true })
    expect(res.json().processes.stopped.map((p: { id: string }) => p.id)).toEqual(['31-310'])
    expect(b.m.sent.every(([pid]) => pid === 31)).toBe(true)
  })
})
