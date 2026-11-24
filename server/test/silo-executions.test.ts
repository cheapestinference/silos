// silo-executions.test.ts — the kernel kind `execution` (task-view phase 5,
// D1/D2): what an
// execution is (a saved copy per conversation, a live ledger nobody claims),
// its states, the two literal edges to its task and their precedence, the
// gone copy, and the guards the store already had (a FIFO, an oversize file).
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync, realpathSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ExecutionStore } from '../src/execution-store.js'
import { buildRecord } from '../src/execution-record.js'
import { KERNEL_KINDS } from '../src/silos/kernel-kinds.js'
import { validateSilo } from '../src/silos/validator.js'
import { SiloReader } from '../src/silos/reader.js'
import {
  ExecutionsSource,
  executionState,
  executionValue,
  resolveTaskEdges,
  sessionAtWork,
  sourceDocOf,
  taskRefsOf,
  type ExecutionTaskRef,
} from '../src/silos/executions.js'
import { siloManifest } from './helpers/silo-manifests.js'

let data: string, main: string
beforeEach(() => {
  data = mkdtempSync(join(tmpdir(), 'silos-exk-'))
  main = realpathSync(mkdtempSync(join(tmpdir(), 'silos-exk-main-')))
  mkdirSync(join(main, '.git', 'worktrees'), { recursive: true })
  mkdirSync(join(main, 'docs', 'plans'), { recursive: true })
  mkdirSync(join(main, 'plans'), { recursive: true })
  writeFileSync(join(main, 'docs', 'plans', 'x.md'), '# X plan\n### Task 1: a\n### Task 2: b\n### Task 3: c\n')
})
afterEach(() => {
  rmSync(data, { recursive: true, force: true })
  rmSync(main, { recursive: true, force: true })
})

function worktree(name: string): string {
  const wt = join(main, '.worktrees', name)
  mkdirSync(join(wt, 'docs', 'plans'), { recursive: true })
  writeFileSync(join(wt, 'docs', 'plans', 'x.md'), '# X plan\n### Task 1: a\n### Task 2: b\n### Task 3: c\n')
  mkdirSync(join(main, '.git', 'worktrees', name), { recursive: true })
  writeFileSync(join(wt, '.git'), `gitdir: ${join(main, '.git', 'worktrees', name)}\n`)
  writeFileSync(join(main, '.git', 'worktrees', name, 'gitdir'), `${join(wt, '.git')}\n`)
  return wt
}
function ledger(root: string, text: string, mtime?: number, plan = 'x'): string {
  const dir = join(root, '.superpowers', 'sdd', plan)
  mkdirSync(dir, { recursive: true })
  const p = join(dir, 'progress.md')
  writeFileSync(p, text)
  if (mtime !== undefined) utimesSync(p, new Date(mtime), new Date(mtime))
  return p
}
const head = '# SDD ledger — plan: docs/plans/x.md\n'
const folderOf = (p: string): string => p.replace(/[^A-Za-z0-9]/g, '-')

function source(over: Partial<ConstructorParameters<typeof ExecutionsSource>[0]> = {}): { src: ExecutionsSource; store: ExecutionStore } {
  const store = new ExecutionStore(data)
  const src = new ExecutionsSource({
    store,
    checkouts: () => [main],
    agentOf: (_f, id) => (id.startsWith('s-') ? 'writer' : null),
    tasks: () => [],
    ...over,
  })
  return { src, store }
}
const task = (over: Partial<ExecutionTaskRef> & { key: string }): ExecutionTaskRef => ({
  ref: over.key.split('/').slice(-3, -2)[0] + '#' + over.key.split('/').pop(),
  conversations: [],
  source: null,
  file: join(main, 'plans', 'p.plan.json'),
  open: true,
  ...over,
})

describe('the catalog entry', () => {
  it('execution: running · fixing · stopped · done (terminal), hangs from a task, at = updatedAt', () => {
    const k = KERNEL_KINDS.execution!
    expect(k.states).toEqual([
      { value: 'running', terminal: false },
      { value: 'fixing', terminal: false },
      { value: 'stopped', terminal: false },
      { value: 'done', terminal: true },
    ])
    expect(k.parent).toEqual({ hub: 'task', field: 'task' })
    expect(k.envelope.at).toBe('updatedAt')
    expect(k.fields.task).toEqual({ type: 'string', optional: true })
    expect(k.fields.gone!.type).toBe('boolean')
    expect(k.binds).toBeUndefined()
  })
})

describe('states', () => {
  const rec = (ledgerText: string, plan: string | null) =>
    buildRecord({ ledgerPath: '/r/.superpowers/sdd/x/progress.md', ledger: ledgerText, ledgerMtime: 1, planPath: plan ? '/r/x.md' : null, plan, gone: false })
  const doc = '# X\n### Task 1: a\n### Task 2: b\n'
  it('running while tasks remain; fixing while one is in a fix round; done when every counted task is complete', () => {
    expect(executionState(rec(`${head}Task 1: complete (a)\n`, doc), true)).toBe('running')
    expect(executionState(rec(`${head}Task 1: complete\nTask 2: fix round 1 (x)\n`, doc), true)).toBe('fixing')
    expect(executionState(rec(`${head}Task 1: complete\nTask 2: fix round 1\nTask 2: complete\n`, doc), true)).toBe('done')
  })
  it("without a document the total is the tasks the ledger names (the line's «all N done»)", () => {
    const r = rec(`${head}Task 1: complete\nTask 2: complete\n`, null)
    expect(executionState(r)).toBe('done')
    expect(executionValue({ id: 'i', record: r, session: null, folder: null, agent: null, docKey: null, task: null, live: true, others: [] })).toMatchObject({
      total: 2,
      totalFrom: 'ledger',
      done: 2,
    })
  })
  it('an empty ledger is running, never done (0 of 0)', () => {
    expect(executionState(rec(`${head}`, null), true)).toBe('running')
  })
  it('the value: the first fixing task and its round while not done; nothing of it once done', () => {
    const r = rec(`${head}Task 1: fix round 2 (spec)\nTask 2: fix round 1\n`, doc)
    expect(
      executionValue({
        id: 'i',
        record: r,
        session: 's',
        folder: 'f',
        agent: 'writer',
        docKey: { main: '/r', rel: 'x.md' },
        task: { key: 'k', ref: 'p#t1', edge: 'document' },
        live: true,
        others: [],
      }),
    ).toMatchObject({
      state: 'fixing',
      fixingTask: 1,
      round: 2,
      session: 's',
      folder: 'f',
      agent: 'writer',
      project: '/r',
      doc: 'x.md',
      task: 'k',
      taskRef: 'p#t1',
      edge: 'document',
      title: 'X',
      updatedBy: 'kernel',
    })
  })
})

describe('what is an execution', () => {
  it('a saved copy per conversation: id <folder>~<session>, its session, folder and agent', () => {
    const p = ledger(main, `${head}Task 1: complete (a)\n`)
    const { src, store } = source()
    store.capture(folderOf(main), 's-1', [p])
    const [e, ...rest] = src.list()
    expect(rest).toEqual([]) // the live ledger the copy names is not listed twice
    expect(e).toMatchObject({ id: `${folderOf(main)}~s-1`, session: 's-1', folder: folderOf(main), agent: 'writer', docKey: { main, rel: 'docs/plans/x.md' } })
    expect(e!.record).toMatchObject({ done: 1, total: 3, gone: false })
  })
  it('a live ledger nobody claims: id ledger~<path>, no session, found in the main checkout and in a worktree', () => {
    const wt = worktree('w1')
    ledger(main, `${head}Task 1: complete\n`, 1_000_000)
    writeFileSync(join(wt, 'docs', 'plans', 'z.md'), '# Z\n### Task 1: a\n### Task 2: b\n')
    ledger(wt, '# SDD ledger — plan: docs/plans/z.md\nTask 1: complete\nTask 2: complete\n', 2_000_000)
    const { src } = source()
    const list = src.list()
    expect(list.map((e) => [e.id.startsWith('ledger~'), e.session, e.record.done])).toEqual([
      [true, null, 2],
      [true, null, 1],
    ])
    expect(list.map((e) => e.docKey?.rel)).toEqual(['docs/plans/z.md', 'docs/plans/x.md'])
  })
  it('the conversations the index knows are captured before listing — the ledger is theirs', () => {
    const p = ledger(main, `${head}Task 1: complete\n`)
    const { src } = source({ sessions: () => [{ folder: 'f', id: 's-2', cwd: main, ledgerPaths: [p] }] })
    expect(src.list().map((e) => e.id)).toEqual(['f~s-2'])
  })
  it('a copy behind its live ledger: the live file speaks, nothing is saved by the listing', () => {
    const p = ledger(main, `${head}Task 1: complete\n`, 1_000_000)
    const { src, store } = source()
    store.capture('f', 's-1', [p])
    ledger(main, `${head}Task 1: complete\nTask 2: complete\n`, 2_000_000)
    expect(src.list()[0]!.record.done).toBe(2)
    expect(new ExecutionStore(data).get('f', 's-1')!.ledgerMtime).toBe(1_000_000)
  })
  it('the worktree is removed: the copy stays, gone', () => {
    const wt = worktree('w2')
    const p = ledger(wt, `${head}Task 1: complete\n`)
    const { src, store } = source()
    store.capture('f', 's-1', [p])
    rmSync(wt, { recursive: true, force: true })
    rmSync(join(main, '.git', 'worktrees', 'w2'), { recursive: true, force: true })
    const [e] = src.list()
    expect(e).toMatchObject({ id: 'f~s-1', docKey: { main, rel: 'docs/plans/x.md' } })
    expect(e!.record.gone).toBe(true)
  })
  it("a FIFO or an oversize file named like a ledger is never read (the store's guards)", () => {
    const dir = join(main, '.superpowers', 'sdd', 'fifo')
    mkdirSync(dir, { recursive: true })
    execFileSync('mkfifo', [join(dir, 'progress.md')])
    const big = join(main, '.superpowers', 'sdd', 'big')
    mkdirSync(big, { recursive: true })
    writeFileSync(join(big, 'progress.md'), `${head}${'x'.repeat(1_100_000)}`)
    expect(source().src.list()).toEqual([])
  })
  it("records: the kernel kind's values, newest first; lastWrite = the newest ledger", () => {
    writeFileSync(join(main, 'docs', 'plans', 'y.md'), '# Y plan\n### Task 1: a\n### Task 2: b\n')
    ledger(main, `${head}Task 1: complete\n`, 1_000_000, 'a')
    ledger(main, '# SDD ledger — plan: docs/plans/y.md\nTask 1: fix round 1\n', 3_000_000, 'b')
    const { src } = source({ liveMs: Number.MAX_SAFE_INTEGER })
    const recs = src.records(Date.now())
    expect(recs.map((r) => r.value.state)).toEqual(['fixing', 'running'])
    expect(recs[0]!.writtenAt).toBe(3_000_000)
    expect(src.lastWrite()).toBe(3_000_000)
  })
})

describe('the edge to its task (D2)', () => {
  const plan = (): string => join(main, 'plans', 'p.plan.json')
  it("sourceDocOf: relative to the plan's project, absolute as written, markdown only, never climbing out", () => {
    expect(sourceDocOf(join(main, 'plans', 'p.plan.json'), 'docs/plans/x.md')).toBe(join(main, 'docs', 'plans', 'x.md'))
    expect(sourceDocOf(null, '/abs/x.md')).toBe('/abs/x.md')
    expect(sourceDocOf(plan(), 'docs/x.json')).toBeNull()
    expect(sourceDocOf(plan(), '../x.md')).toBeNull()
    expect(sourceDocOf('/no/plans-dir/p.json', 'x.md')).toBeNull()
  })
  it("(a) its conversation is in the task's conversations[]", () => {
    const p = ledger(main, `${head}Task 1: complete\n`)
    const { src, store } = source({ tasks: () => [task({ key: 'folder:/m/p/tasks/t1' }), task({ key: 'folder:/m/p/tasks/t2', conversations: ['s-1'] })] })
    store.capture('f', 's-1', [p])
    expect(src.list()[0]!.task).toEqual({ key: 'folder:/m/p/tasks/t2', ref: 'p#t2', edge: 'conversation' })
  })
  it("(b) else the task's source names the same document — a worktree's ledger joins the main folder's task", () => {
    const wt = worktree('w1')
    ledger(wt, `${head}Task 1: complete\n`)
    const { src } = source({ tasks: () => [task({ key: 'folder:/m/p/tasks/t3', source: 'docs/plans/x.md' })] })
    expect(src.list()[0]!.task).toEqual({ key: 'folder:/m/p/tasks/t3', ref: 'p#t3', edge: 'document' })
  })
  it('conversation first: a document match elsewhere does not win over it', () => {
    const p = ledger(main, `${head}Task 1: complete\n`)
    const { src, store } = source({
      tasks: () => [task({ key: 'folder:/m/p/tasks/doc', source: 'docs/plans/x.md' }), task({ key: 'folder:/m/p/tasks/conv', conversations: ['s-1'] })],
    })
    store.capture('f', 's-1', [p])
    expect(src.list()[0]!.task?.key).toBe('folder:/m/p/tasks/conv')
  })
  it("ties: the task holding both edges, then an open one, then the plan's order", () => {
    const k = { main, rel: 'docs/plans/x.md' }
    const keyFor = (t: ExecutionTaskRef) => (t.source ? k : null)
    const e = [{ id: 'e', session: 's', docKey: k }]
    const both = resolveTaskEdges(
      e,
      [task({ key: 'a/tasks/1', conversations: ['s'] }), task({ key: 'a/tasks/2', conversations: ['s'], source: 'x.md' })],
      keyFor,
    )
    expect(both.get('e')?.key).toBe('a/tasks/2')
    const open = resolveTaskEdges(e, [task({ key: 'a/tasks/1', conversations: ['s'], open: false }), task({ key: 'a/tasks/2', conversations: ['s'] })], keyFor)
    expect(open.get('e')?.key).toBe('a/tasks/2')
    const order = resolveTaskEdges(
      [{ id: 'e', session: null, docKey: k }],
      [task({ key: 'a/tasks/1', source: 'x.md', open: false }), task({ key: 'a/tasks/2', source: 'x.md', open: false })],
      keyFor,
    )
    expect(order.get('e')).toEqual({ key: 'a/tasks/1', ref: 'a#1', edge: 'document' })
  })
  it('nothing else: no session in any task and no document named → no task', () => {
    ledger(main, `${head}Task 1: complete\n`)
    const { src } = source({ tasks: () => [task({ key: 'folder:/m/p/tasks/t1', source: 'docs/plans/other.md' })] })
    expect(src.list()[0]!.task).toBeNull()
  })
  it('the plans silo inactive: nothing hangs, everything is still listed', () => {
    ledger(main, `${head}Task 1: complete\n`)
    expect(
      source({ tasks: () => null })
        .src.list()
        .map((e) => e.task),
    ).toEqual([null])
  })
  it("taskRefsOf reads the plans silo's reading: conversations (strings or objects), source, open", () => {
    const reading = {
      records: [
        {
          kind: 'plan',
          location: 'folder:/m',
          file: '/m/plans/p.plan.json',
          record: {
            id: 'p',
            tasks: [
              { id: 't1', state: 'done', conversations: ['s-1', { session: 's-2' }], source: 'docs/x.md' },
              { id: 't2', state: 'pending' },
            ],
          },
        },
      ],
    } as never
    expect(taskRefsOf(reading, new Set())).toEqual([
      { key: 'folder:/m/p/tasks/t1', ref: 'p#t1', conversations: ['s-1', 's-2'], source: 'docs/x.md', file: '/m/plans/p.plan.json', open: false },
      { key: 'folder:/m/p/tasks/t2', ref: 'p#t2', conversations: [], source: null, file: '/m/plans/p.plan.json', open: true },
    ])
  })
  it("taskRefsOf says the project's list's tasks by the project (task-ref.ts — one ref form)", () => {
    const reading = {
      records: [
        { kind: 'plan', location: 'folder:/m/acme', file: '/m/acme/plans/tasks.plan.json', record: { id: 'tasks', tasks: [{ id: 't3', state: 'pending' }] } },
      ],
    } as never
    expect(taskRefsOf(reading, new Set(['tasks']))[0]!.ref).toBe('acme#t3')
  })
})

describe("the conversation's execution and the throttle's reading", () => {
  it('forSession: captures now, the same record the kind lists, with its task', () => {
    const p = ledger(main, `${head}Task 1: complete\n`)
    const { src } = source({ tasks: () => [task({ key: 'folder:/m/p/tasks/t1', conversations: ['s-1'] })] })
    const r = src.forSession('f', 's-1', [p], [])
    expect(r?.record).toMatchObject({ done: 1, total: 3 })
    expect(r?.task?.key).toBe('folder:/m/p/tasks/t1')
    expect(src.list().find((e) => e.id === 'f~s-1')!.record).toEqual(r!.record)
    expect(src.forSession('f', 's-none', [], [])).toBeNull()
  })
  it('forSession after the ledger moved: the fresh record, not the cached listing', () => {
    const p = ledger(main, `${head}Task 1: complete\n`, 1_000_000)
    const { src } = source()
    src.forSession('f', 's-1', [p], [])
    ledger(main, `${head}Task 1: complete\nTask 2: complete\n`, 2_000_000)
    expect(src.forSession('f', 's-1', [p], [])!.record.done).toBe(2)
  })
  it("doneByTask: each task's executions' done counts", () => {
    const p1 = ledger(main, `${head}Task 1: complete\n`, 1_000_000, 'a')
    ledger(main, `${head}Task 1: complete\nTask 2: complete\n`, 2_000_000, 'b')
    const { src, store } = source({ tasks: () => [task({ key: 'k/tasks/t1', conversations: ['s-1'], source: 'docs/plans/x.md' })] })
    store.capture('f', 's-1', [p1])
    expect(src.doneByTask().get('k/tasks/t1')?.sort()).toEqual([1, 2])
  })
})

describe('the manifest and the task anchor (D3)', () => {
  const ref = (name = 'executions'): Record<string, any> => siloManifest(name) as Record<string, any>
  const NOW = Date.parse('2026-11-03T12:00:00Z')
  const errorsOf = (m: unknown): Array<[number, string, string]> => validateSilo(m, { now: NOW }).errors.map((e) => [e.check, e.where, e.message])
  it('executions.silo.json validates: kernel producer, a task parent anchor, open only', () => {
    expect(errorsOf(ref())).toEqual([])
  })
  it('a task anchor only as a parent, only over a kernel kind with a task parent', () => {
    const a = ref()
    a.spec.kinds.execution.envelope.anchors = [{ hub: 'task', from: 'location' }]
    expect(errorsOf(a)).toEqual([
      [5, 'spec.kinds.execution.envelope.anchors[0]', 'a record hangs from a task only as its parent (from: parent) — a location holds no task'],
    ])
    const b = ref()
    b.spec.kinds.execution.envelope.anchors = [{ hub: 'platform', from: 'parent' }]
    expect(errorsOf(b).map((e) => e[2])).toEqual(['only a task is a parent hub — platform comes from the location'])
    const s = ref('system')
    s.spec.kinds.process.envelope.anchors = [{ hub: 'task', from: 'parent' }]
    expect(errorsOf(s).map((e) => e[2])).toEqual(['a record hangs from a task only when the kernel resolves it — the kernel kind process has no task parent'])
    const p = ref('plans')
    p.spec.kinds.plan.envelope.anchors = [{ hub: 'task', from: 'parent' }]
    expect(errorsOf(p).map((e) => e[2])).toEqual(['a record hangs from a task only when the kernel resolves it — files name no parent the kernel resolves'])
  })
  it('the reader anchors each record to the task the kernel resolved (none when it hangs from nothing)', () => {
    const p = ledger(main, `${head}Task 1: complete\n`)
    ledger(main, `${head}Task 1: complete\n`, undefined, 'other')
    const { src, store } = source({ tasks: () => [task({ key: 'folder:/m/p/tasks/t1', conversations: ['s-1'] })] })
    store.capture('f', 's-1', [p])
    const reader = new SiloReader({ agentStates: () => [], projects: () => [] }, (k) => (k === 'execution' ? src : null))
    const reading = reader.read('executions', ref())
    expect(reading.unreadable).toEqual([])
    const byId = new Map(reading.records.map((r) => [r.record.id, r]))
    expect(byId.get('f~s-1')!.anchors).toEqual({ task: 'folder:/m/p/tasks/t1' })
    expect([...byId.values()].filter((r) => !r.anchors.task)).toHaveLength(1)
    expect(byId.get('f~s-1')!.record).toMatchObject({ identity: 'X plan', state: 'stopped', done: 1, total: 3, taskRef: 'p#t1' })
  })
})

describe('an execution is running only while something runs it', () => {
  const NOW = 10_000_000
  const doc = '# X\n### Task 1: a\n### Task 2: b\n### Task 3: c\n'
  const rec = (ledgerText: string, plan: string | null) =>
    buildRecord({ ledgerPath: '/r/.superpowers/sdd/x/progress.md', ledger: ledgerText, ledgerMtime: 1, planPath: plan ? '/r/x.md' : null, plan, gone: false })
  it('executionState: unfinished with nothing live is stopped, in a fix round too; finished stays done', () => {
    expect(executionState(rec(`${head}Task 1: complete (a)\n`, doc), false)).toBe('stopped')
    expect(executionState(rec(`${head}Task 1: complete\nTask 2: fix round 1 (x)\n`, doc), false)).toBe('stopped')
    expect(executionState(rec(`${head}Task 1: complete\nTask 2: complete\nTask 3: complete\n`, doc), false)).toBe('done')
    expect(executionState(rec(`${head}Task 1: complete\nTask 2: fix round 1 (x)\n`, doc), true)).toBe('fixing')
  })
  it('a stopped execution keeps naming the task it stopped fixing', () => {
    const e = {
      id: 'x',
      session: null,
      folder: null,
      agent: null,
      docKey: null,
      task: null,
      live: false,
      record: rec(`${head}Task 1: complete\nTask 2: fix round 1 (x)\n`, doc),
      others: [],
    }
    expect(executionValue(e)).toMatchObject({ state: 'stopped', fixingTask: 2, round: 1 })
  })
  it('sessionAtWork: an open turn writing or in a tool, a background agent, or a question to the owner; never a closed quiet one', () => {
    const LIVE = 120_000
    expect(sessionAtWork({ mtime: NOW - 1000, turnOpen: true }, NOW, LIVE)).toBe(true)
    expect(sessionAtWork({ mtime: NOW - 500_000, turnOpen: true, toolSince: NOW - 500_000 }, NOW, LIVE)).toBe(true)
    expect(sessionAtWork({ mtime: NOW - 500_000, turnOpen: false, subMtime: NOW - 1000 }, NOW, LIVE)).toBe(true)
    expect(sessionAtWork({ mtime: NOW - 500_000, turnOpen: true, pendingAsk: true }, NOW, LIVE)).toBe(true)
    expect(sessionAtWork({ mtime: NOW - 1000, turnOpen: false }, NOW, LIVE)).toBe(false)
    expect(sessionAtWork({ mtime: NOW - 500_000, turnOpen: true }, NOW, LIVE)).toBe(false)
  })
  it('the source: live by its conversation, or by a ledger written within the live window; else stopped', () => {
    const now = Date.now()
    writeFileSync(join(main, 'docs', 'plans', 'y.md'), '# Y\n### Task 1: a\n### Task 2: b\n')
    const p = ledger(main, `${head}Task 1: complete\n`, now - 60_000, 'a')
    const q = ledger(main, '# SDD ledger — plan: docs/plans/y.md\nTask 1: complete\n', now - 3_600_000, 'b')
    const r = ledger(main, `${head}Task 1: complete\n`, now - 3_600_000, 'c')
    const { src, store } = source({ liveMs: 120_000, sessionLive: (_f: string, id: string) => id === 's-r' })
    store.capture('f', 's-r', [r])
    const byLedger = new Map(src.list(now).map((e) => [e.record.ledgerPath, e.live]))
    expect(byLedger.get(p)).toBe(true) // just written, nobody known
    expect(byLedger.get(q)).toBe(false) // old, nobody known
    expect(byLedger.get(r)).toBe(true) // old, its conversation at work
  })
  it('two conversationless ledgers of one document are one execution: the newest speaks, the other is named', () => {
    const wt = worktree('w3')
    const a = ledger(main, `${head}Task 1: complete\nTask 2: complete\n`, 2_000_000)
    const b = ledger(wt, `${head}Task 1: complete\n`, 1_000_000)
    const list = source().src.list()
    expect(list).toHaveLength(1)
    expect(list[0]!.record.ledgerPath).toBe(a)
    expect(list[0]!.others.map((o) => o.ledger)).toEqual([b])
    expect(executionValue(list[0]!)).toMatchObject({ otherLedgers: 1, otherLedgersSay: `${b} (1 of ${list[0]!.others[0]!.total} done)` })
  })
  it('a ledger a conversation wrote is never folded: two conversations of one document stay two', () => {
    const wt = worktree('w4')
    const a = ledger(main, `${head}Task 1: complete\n`, 2_000_000)
    const b = ledger(wt, `${head}Task 1: complete\n`, 1_000_000)
    const { src, store } = source()
    store.capture('f', 's-1', [a])
    store.capture('f', 's-2', [b])
    expect(
      src
        .list()
        .map((e) => e.id)
        .sort(),
    ).toEqual(['f~s-1', 'f~s-2'])
  })
})
