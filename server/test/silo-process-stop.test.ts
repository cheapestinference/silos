// silo-process-stop.test.ts — the kernel-verb stop-process over the process
// engine (silos/processes.ts stopRecord), against a FAKE table and a FAKE
// signal: no real pid is ever signalled. The root's identity at the gesture
// (pid AND start time — a reused pid is a stranger), the tree as it is NOW,
// SIGTERM → grace → SIGKILL (each survivor re-verified), the refusals (Silos'
// own tree, another user's, exited, unknown, being stopped), the record
// after (exited, stoppedAt/By, «stopped by you», never revived by a stale
// scan), `stoppable` on every record, a conversation's live records, and the
// fresh numbers a read after a scan serves without a journal line.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProcessRecords, MIN_ALIVE_MS, SILOS_SESSION_KEY, STOP_GRACE_MS, type ConversationFacts, type StopSignal } from '../src/silos/processes.js'
import type { ProcEntry, ProcTable, ProcessTableReader } from '../src/silos/proc-table.js'
import { SiloReader } from '../src/silos/reader.js'
import { SiloRegistry } from '../src/silos/registry.js'
import { SiloKernel } from '../src/silos/kernel.js'
import { SiloOperatorStore } from '../src/silos/operator.js'
import { TransitionJournal } from '../src/silos/journal.js'
import { SiloActions, SiloAcks, SiloEvents, SiloProposals } from '../src/silos/actions.js'
import { recordDetail, recordsPage } from '../src/silos/views.js'
import { copyFileSync, mkdirSync } from 'node:fs'

const ENGINE_KEY = 'ENGINE_SESSION_ID'
const T0 = Date.parse('2026-11-21T10:00:00Z')
const SELF = 900
const REF = join(import.meta.dirname, '..', '..', 'docs', 'standard', 'reference', 'system.silo.json')

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'silos-stop-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const proc = (pid: number, ppid: number, argv: string[], o: Partial<ProcEntry> = {}): ProcEntry => ({
  pid,
  ppid,
  startTicks: pid * 10,
  startedAt: T0 - 3600_000,
  comm: argv[0]!.split('/').pop()!.slice(0, 15),
  argv,
  cwd: '/home/op/shop',
  cpuSeconds: 0,
  rssBytes: 10 * 1024 * 1024,
  env: {},
  ...o,
})

// How a fake process answers a signal: `term` exits on SIGTERM, `kill` only
// on SIGKILL, `never` not even then.
type Temper = 'term' | 'kill' | 'never'

// A machine: a mutable table, a clock, and the signals sent — recorded, never real.
class Machine implements ProcessTableReader {
  procs: ProcEntry[] = []
  listeners: ProcTable['listeners'] = []
  temper = new Map<number, Temper>()
  sent: Array<[number, StopSignal]> = []
  now = T0
  reads = 0
  read = async (): Promise<ProcTable> => {
    this.reads++
    return { at: this.now, uid: 1000, procs: this.procs.map((p) => ({ ...p })), listeners: this.listeners, complete: true }
  }
  alive = async (ps: ReadonlyArray<{ pid: number; startTicks: number }>) =>
    ps.filter((p) => this.procs.some((x) => x.pid === p.pid && x.startTicks === p.startTicks)).map((p) => ({ ...p }))
  signal = (pid: number, sig: StopSignal): void => {
    this.sent.push([pid, sig])
    const p = this.procs.find((x) => x.pid === pid)
    if (!p) {
      const e = new Error('ESRCH') as NodeJS.ErrnoException
      e.code = 'ESRCH'
      throw e
    }
    if (sig === 'SIGTERM' && this.slow.has(pid)) {
      this.exitAt.set(pid, this.now + this.slow.get(pid)!)
      return
    }
    const t = this.temper.get(pid) ?? 'term'
    if (t === 'term' || (t === 'kill' && sig === 'SIGKILL')) this.procs = this.procs.filter((x) => x.pid !== pid)
  }
  waits: number[] = []
  wait = async (ms: number): Promise<void> => {
    this.waits.push(ms)
    this.now += ms
    this.settle()
  }
  // a process that takes its time to exit on SIGTERM: gone `ms` after the signal
  slow = new Map<number, number>()
  exitAt = new Map<number, number>()
  private settle(): void {
    this.procs = this.procs.filter((x) => !(this.exitAt.has(x.pid) && this.now >= this.exitAt.get(x.pid)!))
  }
}

interface World {
  m: Machine
  src: ProcessRecords
  facts: Map<string, ConversationFacts | null>
  changes: number
}
function world(o: { facts?: Record<string, ConversationFacts | null>; file?: string } = {}): World {
  const m = new Machine()
  const w: World = { m, src: null as unknown as ProcessRecords, facts: new Map(Object.entries(o.facts ?? {})), changes: 0 }
  w.src = new ProcessRecords({
    file: o.file ?? join(dir, 'processes.json'),
    table: m,
    sessionKeys: () => [SILOS_SESSION_KEY, ENGINE_KEY],
    engineCommands: () => new Set(['engine']),
    selfPid: SELF,
    conversations: (ids) => new Map(ids.map((id) => [id, w.facts.get(id) ?? null])),
    onChange: () => {
      w.changes++
    },
    now: () => m.now,
    signal: m.signal,
    wait: m.wait,
  })
  return w
}
const conv = (session: string, running: boolean): ConversationFacts => ({
  session,
  folder: '-home-op-shop',
  agent: 'writer',
  title: 'Stripe checkout',
  running,
})
const env = { [SILOS_SESSION_KEY]: 's-1', [ENGINE_KEY]: 's-1' }
// a dev server a deleted conversation left: npm (21) → vite (22), esbuild (23), listening on 5193
const devTree = (): ProcEntry[] => [
  proc(21, 1, ['npm', 'run', 'dev'], { env }),
  proc(22, 21, ['node', 'vite'], { env }),
  proc(23, 21, ['node', 'esbuild'], { env }),
]
async function seen(w: World, procs: ProcEntry[], listeners: ProcTable['listeners'] = [{ port: 5193, uid: 1000, user: 'op', pids: [22] }]): Promise<void> {
  w.m.procs = procs
  w.m.listeners = listeners
  await w.src.tick()
}
const rec = (w: World, id: string) => w.src.records().find((r) => r.id === id)?.value

describe('stop-process — the root must still be the same process', () => {
  it('pid reuse: the same pid with another start time is a stranger — nothing is signalled, the record reads exited', async () => {
    const w = world()
    await seen(w, [proc(70, 1, ['node', 'a.js'])], [{ port: 8080, uid: 1000, user: 'op', pids: [70] }])
    // the process exited and the pid went to someone else before the gesture
    w.m.procs = [proc(70, 1, ['node', 'stranger.js'], { startTicks: 999 })]
    const r = await w.src.stopRecord('70-700')
    expect(r).toMatchObject({ ok: true, value: { outcome: 'gone', signalled: 0 } })
    expect(r.ok && r.value.says).toBe('node a.js had already exited — nothing was signalled.')
    expect(w.m.sent).toEqual([])
    expect(rec(w, '70-700')).toMatchObject({ state: 'exited', stoppable: false })
    expect(rec(w, '70-700')!.stoppedAt).toBeUndefined()
  })
})

describe('stop-process — the tree as it is at the gesture', () => {
  it("collects root + descendants NOW (a child born since the last scan included), never an engine nor another record's root", async () => {
    const w = world({ facts: { 's-1': conv('s-1', false) } })
    await seen(w, devTree())
    expect(rec(w, '21-210')).toMatchObject({ processes: 3, stoppable: true, state: 'left' })
    // since the scan: a new worker, an engine a script under it started (a
    // conversation of its own), and a process of another conversation below
    w.m.procs = [
      ...devTree(),
      proc(24, 22, ['node', 'worker.js'], { env }),
      proc(30, 21, ['engine', '-p', 'x'], { env: { [ENGINE_KEY]: 's-2' } }),
      proc(31, 30, ['node', 'engine-child.js'], { env: { [ENGINE_KEY]: 's-2' } }),
    ]
    const r = await w.src.stopRecord('21-210')
    expect(r).toMatchObject({ ok: true, value: { outcome: 'stopped', signalled: 4, stopped: 4, killed: 0, survivors: [] } })
    expect(w.m.sent.map(([pid]) => pid).sort()).toEqual([21, 22, 23, 24])
    expect(w.m.procs.map((p) => p.pid)).toEqual([30, 31]) // the engine and its child are untouched
    expect(r.ok && r.value.says).toBe('Stopped npm run dev — 4 processes.')
  })
})

describe('stop-process — SIGTERM, the grace, SIGKILL', () => {
  it('a survivor of SIGTERM gets SIGKILL after the grace — re-verified, the others never twice', async () => {
    const w = world({ facts: { 's-1': conv('s-1', false) } })
    await seen(w, devTree())
    w.m.temper.set(23, 'kill')
    const start = w.m.now
    const r = await w.src.stopRecord('21-210')
    expect(w.m.sent).toEqual([
      [21, 'SIGTERM'],
      [22, 'SIGTERM'],
      [23, 'SIGTERM'],
      [23, 'SIGKILL'],
    ])
    expect(w.m.now - start).toBeGreaterThanOrEqual(STOP_GRACE_MS)
    expect(r).toMatchObject({ ok: true, value: { outcome: 'stopped', signalled: 3, stopped: 3, killed: 1, survivors: [] } })
    expect(r.ok && r.value.says).toBe('Stopped npm run dev — 3 processes (1 of them only with SIGKILL).')
  })

  it('everyone gone at SIGTERM: no grace waited, no SIGKILL', async () => {
    const w = world({ facts: { 's-1': conv('s-1', false) } })
    await seen(w, devTree())
    const start = w.m.now
    await w.src.stopRecord('21-210')
    expect(w.m.sent.every(([, s]) => s === 'SIGTERM')).toBe(true)
    expect(w.m.now).toBe(start)
  })

  it('a process that takes 300 ms to exit on SIGTERM: the stop answers within one ~100 ms step of it, no SIGKILL', async () => {
    const w = world({ facts: { 's-1': conv('s-1', false) } })
    await seen(w, devTree())
    w.m.slow.set(22, 300)
    const start = w.m.now
    const r = await w.src.stopRecord('21-210')
    expect(r).toMatchObject({ ok: true, value: { outcome: 'stopped', killed: 0, survivors: [] } })
    expect(w.m.sent.some(([, s]) => s === 'SIGKILL')).toBe(false)
    expect(w.m.now - start).toBeGreaterThanOrEqual(300)
    expect(w.m.now - start).toBeLessThanOrEqual(400)
    expect(Math.max(...w.m.waits)).toBeLessThanOrEqual(100)
  })

  it('a process that survives SIGKILL is said by its pid; a surviving ROOT keeps the record alive', async () => {
    const w = world({ facts: { 's-1': conv('s-1', false) } })
    await seen(w, devTree())
    w.m.temper.set(22, 'never')
    const r = await w.src.stopRecord('21-210')
    expect(r).toMatchObject({ ok: true, value: { outcome: 'partial', signalled: 3, stopped: 2, killed: 1, survivors: [22] } })
    expect(r.ok && r.value.says).toBe('Stopped 2 of 3 processes of npm run dev — 1 did not exit (pid 22).')
    expect(rec(w, '21-210')!.state).toBe('exited') // the root went: the record is done; vite may become a record of its own
    const w2 = world({ facts: { 's-1': conv('s-1', false) }, file: join(dir, 'p2.json') })
    await seen(w2, devTree())
    w2.m.temper.set(21, 'never')
    const r2 = await w2.src.stopRecord('21-210')
    expect(r2).toMatchObject({ ok: true, value: { outcome: 'partial', survivors: [21] } })
    expect(rec(w2, '21-210')!.state).toBe('left')
  })
})

describe('stop-process — refusals, in words, signal nothing', () => {
  it("Silos' own tree, another user's listener, an exited record, an unknown id", async () => {
    const w = world()
    await seen(
      w,
      [proc(SELF, 1, ['node', 'index.ts']), proc(50, 1, ['postgres'])],
      [
        { port: 3210, uid: 1000, user: 'op', pids: [SELF] },
        { port: 5432, uid: 1000, user: 'op', pids: [50] },
        { port: 22, uid: 0, user: 'root', pids: [] },
      ],
    )
    expect(rec(w, `${SELF}-${SELF * 10}`)).toMatchObject({ origin: 'silos', stoppable: false })
    expect(rec(w, 'port-22-0')).toMatchObject({ origin: 'other-user', stoppable: false })
    expect(rec(w, '50-500')).toMatchObject({ origin: 'machine', stoppable: true })
    expect(await w.src.stopRecord(`${SELF}-${SELF * 10}`)).toEqual({
      ok: false,
      code: 409,
      reason: "node index.ts can't be stopped: it is Silos itself — this server and what runs it are stopped where they were started, never from here",
    })
    expect(await w.src.stopRecord('port-22-0')).toMatchObject({ ok: false, code: 409, reason: expect.stringContaining('it runs as another user') })
    expect(await w.src.stopRecord('nope-1')).toMatchObject({ ok: false, code: 404 })
    w.m.procs = [proc(SELF, 1, ['node', 'index.ts'])]
    await w.src.tick()
    expect(rec(w, '50-500')!.state).toBe('exited')
    expect(await w.src.stopRecord('50-500')).toEqual({ ok: false, code: 409, reason: "postgres can't be stopped: it already exited" })
    expect(w.m.sent).toEqual([])
  })

  it('re-checked on the fresh table: a root that now holds this server is refused, nothing signalled', async () => {
    const w = world({ facts: { 's-1': conv('s-1', false) } })
    await seen(w, devTree())
    // the restart recipe ran from that conversation's tree since the scan
    w.m.procs = [...devTree(), proc(SELF, 23, ['node', 'index.ts'])]
    const r = await w.src.stopRecord('21-210')
    expect(r).toMatchObject({ ok: false, code: 409, reason: expect.stringContaining('it holds Silos itself') })
    expect(w.m.sent).toEqual([])
  })

  it('one stop at a time per record', async () => {
    const w = world({ facts: { 's-1': conv('s-1', false) } })
    await seen(w, devTree())
    w.m.temper.set(22, 'kill')
    const first = w.src.stopRecord('21-210')
    expect(await w.src.stopRecord('21-210')).toMatchObject({ ok: false, code: 409, reason: 'npm run dev is being stopped already' })
    expect((await first).ok).toBe(true)
  })

  it('no process table on this machine: nothing signalled, said', async () => {
    const src = new ProcessRecords({
      file: join(dir, 'p.json'),
      sessionKeys: () => [],
      engineCommands: () => new Set(),
      signal: () => {
        throw new Error('never')
      },
    })
    expect(await src.stopRecord('x')).toMatchObject({ ok: false, code: 404 })
  })
})

describe('stop-process — the record after', () => {
  it('exited at once with stoppedAt/stoppedBy and «stopped by you»; a stale scan never revives it; onChange told', async () => {
    const w = world({ facts: { 's-1': conv('s-1', false) } })
    await seen(w, devTree())
    const before = w.changes
    await w.src.stopRecord('21-210', { by: 'owner' })
    const v = rec(w, '21-210')!
    expect(v).toMatchObject({
      state: 'exited',
      stoppedBy: 'owner',
      why: 'stopped by you',
      stoppable: false,
      exitedAt: new Date(w.m.now).toISOString(),
      stoppedAt: new Date(w.m.now).toISOString(),
    })
    expect(v.cpu).toBeUndefined()
    expect(w.changes).toBeGreaterThan(before)
    // a scan that read the table BEFORE the kill lands late: still exited
    w.src.observe({ at: w.m.now, uid: 1000, procs: devTree(), listeners: [{ port: 5193, uid: 1000, user: 'op', pids: [22] }], complete: true }, w.m.now)
    expect(rec(w, '21-210')!.state).toBe('exited')
    // and on disk
    expect(JSON.parse(readFileSync(join(dir, 'processes.json'), 'utf8')).records.find((r: { id: string }) => r.id === '21-210')).toMatchObject({
      stoppedBy: 'owner',
      why: 'stopped by you',
    })
  })
})

describe("a conversation's live records (ofSessions)", () => {
  it("only running/left records whose session is one of the thread's ids, with stoppable", async () => {
    const w = world({ facts: { 's-1': conv('s-1', false), 's-9': conv('s-9', true) } })
    await seen(
      w,
      [...devTree(), proc(60, 1, ['node', 'other.js'], { env: { [ENGINE_KEY]: 's-9' } })],
      [
        { port: 5193, uid: 1000, user: 'op', pids: [22] },
        { port: 7000, uid: 1000, user: 'op', pids: [60] },
      ],
    )
    const mine = w.src.ofSessions(['s-0', 's-1'])
    expect(mine).toEqual([
      expect.objectContaining({
        id: '21-210',
        state: 'left',
        command: 'npm run dev',
        pid: 21,
        ports: '5193',
        processes: 3,
        memoryMb: 30,
        stoppable: true,
        session: 's-1',
      }),
    ])
    expect(w.src.ofSessions(['s-9']).map((p) => p.id)).toEqual(['60-600'])
    await w.src.stopRecord('21-210')
    expect(w.src.ofSessions(['s-1'])).toEqual([])
  })
})

describe('fresh numbers: a read after a scan serves that scan — no journal line, no read per tick', () => {
  it('the kernel re-reads only when a scan moved the gauges since its last reading; cpu absent before two scans, never 0', async () => {
    const dataDir = join(dir, 'data')
    const root = join(dataDir, 'silos')
    mkdirSync(join(root, 'registry', 'system'), { recursive: true })
    copyFileSync(REF, join(root, 'registry', 'system', 'silo.json'))
    const w = world({ facts: { 's-1': conv('s-1', false) } })
    const registry = new SiloRegistry({ dataDir, operator: { decisionFor: () => 'approved' as const, slotsOff: () => [] } })
    registry.load()
    const journal = new TransitionJournal(registry.conventionsDir)
    let reads = 0
    const reader = new SiloReader({ agentStates: () => [], projects: () => [] }, (k) => (k === 'process' ? w.src : null))
    const counting = {
      read: (...a: Parameters<SiloReader['read']>) => {
        reads++
        return reader.read(...a)
      },
    } as unknown as SiloReader
    const kernel = new SiloKernel({ registry, reader: counting, journal, now: () => w.m.now })
    // the freshen index.ts wires
    const freshen = (): void => {
      const s = w.src.scannedAt()
      if (s !== null && s > (kernel.readAt('system') ?? -Infinity)) kernel.refresh('system')
    }
    const cpuOf = (): unknown => kernel.reading('system')!.records.find((r) => r.record.id === '21-210')?.raw.cpu
    await seen(w, devTree())
    kernel.refresh('system')
    expect(cpuOf()).toBeUndefined() // one scan: nothing to average
    const linesOf = (): number =>
      readdirSync(registry.conventionsDir, { recursive: true })
        .filter((f) => String(f).endsWith('.jsonl'))
        .map(
          (f) =>
            readFileSync(join(registry.conventionsDir, String(f)), 'utf8')
              .split('\n')
              .filter(Boolean).length,
        )
        .reduce((a, b) => a + b, 0)
    const lines = linesOf()
    const r0 = reads
    freshen()
    freshen()
    expect(reads).toBe(r0) // nothing scanned since: no read
    // 30 s later, 15 s of cpu: a scan, then the page asks twice
    w.m.now += 30_000
    w.m.procs = devTree().map((p) => (p.pid === 22 ? { ...p, cpuSeconds: 15 } : p))
    expect(await w.src.tick()).toBe(false) // a gauge is no fact: nobody told
    freshen()
    freshen()
    expect(reads).toBe(r0 + 1)
    expect(cpuOf()).toBe(50)
    expect(linesOf()).toBe(lines) // and no journal line for it
    void MIN_ALIVE_MS
  })
})

describe("the owner's gesture through the silo (SiloActions.kernelVerb)", () => {
  it('declared on the kind, admitted by the kernel kind, its when over the record; the event says what happened', async () => {
    const dataDir = join(dir, 'data')
    const root = join(dataDir, 'silos')
    mkdirSync(join(root, 'registry', 'system'), { recursive: true })
    copyFileSync(REF, join(root, 'registry', 'system', 'silo.json'))
    const w = world({ facts: { 's-1': conv('s-1', false) } })
    const registry = new SiloRegistry({ dataDir, operator: new SiloOperatorStore(root) })
    registry.load()
    const active = new SiloRegistry({ dataDir, operator: { decisionFor: () => 'approved' as const, slotsOff: () => [] } })
    active.load()
    const kernel = new SiloKernel({
      registry: active,
      reader: new SiloReader({ agentStates: () => [], projects: () => [] }, (k) => (k === 'process' ? w.src : null)),
      now: () => w.m.now,
    })
    const events = new SiloEvents(root)
    const actions = new SiloActions({
      registry: active,
      kernel,
      events,
      acks: new SiloAcks(root),
      proposals: new SiloProposals(root),
      agentStateBase: join(dir, 'as'),
      isAgent: () => false,
      agentMayReadLocation: () => false,
    })
    await seen(
      w,
      [...devTree(), proc(SELF, 1, ['node', 'index.ts'])],
      [
        { port: 5193, uid: 1000, user: 'op', pids: [22] },
        { port: 3210, uid: 1000, user: 'op', pids: [SELF] },
      ],
    )
    kernel.refresh('system')
    const impls = {
      'stop-process': async (id: string, by: string) => {
        const r = await w.src.stopRecord(id, { by })
        return r.ok ? { ok: true as const, value: { ...r.value } } : r
      },
    }
    // the manifest's when (stoppable) holds the door shut on Silos' own tree
    expect(await actions.kernelVerb('system', `platform/${SELF}-${SELF * 10}`, 'stop-process', impls)).toMatchObject({
      ok: false,
      code: 409,
      reason: expect.stringContaining('stop is not offered on it now (stoppable)'),
    })
    expect(await actions.kernelVerb('system', 'platform/21-210', 'restart-process', impls)).toMatchObject({ ok: false, code: 404 })
    expect(await actions.kernelVerb('system', 'platform/21-210', 'stop-process', {})).toMatchObject({ ok: false, code: 503 })
    expect(w.m.sent).toEqual([])
    const r = await actions.kernelVerb('system', 'platform/21-210', 'stop-process', impls)
    expect(r).toMatchObject({
      ok: true,
      value: { name: 'stop-process', key: 'platform/21-210', outcome: 'stopped', says: 'Stopped npm run dev — 3 processes.' },
    })
    expect(events.list('system', 'platform/21-210')).toEqual([
      expect.objectContaining({ verb: 'kernel-verb', by: 'owner', text: 'stop-process: Stopped npm run dev — 3 processes.' }),
    ])
    expect(kernel.reading('system')!.records.find((x) => x.record.id === '21-210')!.record.state).toBe('exited')
    void registry
  })

  it('the pages read the door from the descriptor: the catalog word, its pending word, the guard, and where the when holds', async () => {
    const dataDir = join(dir, 'data')
    const root = join(dataDir, 'silos')
    mkdirSync(join(root, 'registry', 'system'), { recursive: true })
    copyFileSync(REF, join(root, 'registry', 'system', 'silo.json'))
    const w = world({ facts: { 's-1': conv('s-1', false) } })
    const active = new SiloRegistry({ dataDir, operator: { decisionFor: () => 'approved' as const, slotsOff: () => [] } })
    active.load()
    const kernel = new SiloKernel({
      registry: active,
      reader: new SiloReader({ agentStates: () => [], projects: () => [] }, (k) => (k === 'process' ? w.src : null)),
      now: () => w.m.now,
    })
    await seen(
      w,
      [...devTree(), proc(SELF, 1, ['node', 'index.ts'])],
      [
        { port: 5193, uid: 1000, user: 'op', pids: [22] },
        { port: 3210, uid: 1000, user: 'op', pids: [SELF] },
      ],
    )
    kernel.refresh('system')
    const voice = { now: w.m.now }
    const page = recordsPage(active.get('system')!, kernel.reading('system'), { voice, overlayKeys: new Set(), conflictKeys: new Set() }, { folded: 'include' })
    if ('error' in page) throw new Error(page.error)
    expect(page.kind.verbs).toEqual([{ name: 'stop-process', says: 'Stop', pending: 'Stopping…', guard: 'stoppable' }])
    expect(page.records.find((r) => r.id === '21-210')!.verbs).toEqual(['stop-process'])
    expect(page.records.find((r) => r.id === `${SELF}-${SELF * 10}`)!.verbs).toEqual([])
    const d = recordDetail(active.get('system')!, kernel.reading('system'), 'platform/21-210', { voice })!
    expect(d.actions.find((a) => a.verb === 'kernel-verb')).toEqual({
      verb: 'kernel-verb',
      name: 'stop-process',
      says: 'Stop',
      pending: 'Stopping…',
      guard: 'stoppable',
      applies: true,
    })
    const own = recordDetail(active.get('system')!, kernel.reading('system'), `platform/${SELF}-${SELF * 10}`, { voice })!
    expect(own.actions.find((a) => a.verb === 'kernel-verb')?.applies).toBe(false)
  })

  it("a group whose conversation exists opens it (folder/session, the kernel kind's refs); a deleted conversation's group stays words", async () => {
    const dataDir = join(dir, 'data')
    mkdirSync(join(dataDir, 'silos', 'registry', 'system'), { recursive: true })
    copyFileSync(REF, join(dataDir, 'silos', 'registry', 'system', 'silo.json'))
    const w = world({ facts: { 's-1': conv('s-1', false), 's-gone': null } })
    const active = new SiloRegistry({ dataDir, operator: { decisionFor: () => 'approved' as const, slotsOff: () => [] } })
    active.load()
    const kernel = new SiloKernel({
      registry: active,
      reader: new SiloReader({ agentStates: () => [], projects: () => [] }, (k) => (k === 'process' ? w.src : null)),
      now: () => w.m.now,
    })
    const gone = { [SILOS_SESSION_KEY]: 's-gone' }
    await seen(
      w,
      [...devTree(), proc(41, 1, ['node', 'old.js'], { env: gone })],
      [
        { port: 5193, uid: 1000, user: 'op', pids: [22] },
        { port: 7001, uid: 1000, user: 'op', pids: [41] },
      ],
    )
    kernel.refresh('system')
    const page = recordsPage(
      active.get('system')!,
      kernel.reading('system'),
      { voice: { now: w.m.now }, overlayKeys: new Set(), conflictKeys: new Set() },
      { folded: 'include' },
    )
    if ('error' in page) throw new Error(page.error)
    expect(page.records.find((r) => r.id === '21-210')!.group).toMatchObject({
      label: 'Stripe checkout',
      opens: { hub: 'conversation', value: '-home-op-shop/s-1' },
    })
    const orphan = page.records.find((r) => r.id === '41-410')!.group!
    expect(orphan.label).toMatch(/deleted/)
    expect(orphan.opens).toBeUndefined()
  })
})
