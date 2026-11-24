// Hierarchy phase 4 — the stuck sweep (task mode's `stalled` wake, ONE
// retry) and the escalation by chain (escalation/): chain resolution, hop
// timing, the recovery note and the wait through the plans silo's verbs,
// the owner's final row, the producer-agent window. Engine/data only.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { evaluateTaskWakes, wakesForStall, type Observation, type TaskSnap } from '../src/task-mode/evaluate.js'
import { TaskModeEngine } from '../src/task-mode/engine.js'
import { TaskModeStore } from '../src/task-mode/store.js'
import { askedWords, evaluateEscalation, hopTargets, OWNER, type Case, type ChainView, type Subject } from '../src/escalation/evaluate.js'
import { EscalationEngine, creatorOf, type RoutedRow } from '../src/escalation/engine.js'
import { EscalationStore } from '../src/escalation/store.js'
import { chainUp } from '../src/silos/relations.js'
import type { SiloReading } from '../src/silos/reader.js'

const PLAN = 'folder:/p/plans/launch'
const T0 = Date.parse('2026-11-03T09:00:00Z')
const H = 3600_000
function task(id: string, over: Partial<TaskSnap> = {}): TaskSnap {
  return {
    key: `${PLAN}/tasks/${id}`,
    planKey: PLAN,
    planId: 'launch',
    id,
    ref: `launch#${id}`,
    title: `Task ${id}`,
    owner: 'writer',
    state: 'in_progress',
    dependsOn: [],
    parent: null,
    nextCheckAt: null,
    waitingOn: false,
    waitingFor: null,
    stalledCause: null,
    stalledBy: null,
    stalledAt: null,
    notes: [],
    conversations: [],
    file: '/p/plans/launch.plan.json',
    folder: '/p',
    ...over,
  }
}
const stalled = (id: string, cause = 'in-progress-nothing-live', over: Partial<TaskSnap> = {}): TaskSnap =>
  task(id, { stalledCause: cause, stalledBy: id, stalledAt: id, ...over })
const BOUND = new Set(['writer'])
function looks(seq: TaskSnap[][], start = T0, step = 30_000): { wakes: string[][]; obs: Record<string, Observation> } {
  let prev: Record<string, Observation> = {}
  const wakes: string[][] = []
  seq.forEach((tasks, i) => {
    const ev = evaluateTaskWakes({ tasks, bound: BOUND, prev, now: start + i * step })
    wakes.push(ev.wakes.map((w) => `${w.reason}:${w.key.split('@')[0]}`))
    prev = ev.observations
  })
  return { wakes, obs: prev }
}

describe('the stuck sweep: a `stalled` wake, one per episode', () => {
  it('baseline first, then ONE wake; the same stall never wakes again', () => {
    const t = stalled('t1')
    expect(looks([[t], [t], [t], [t]]).wakes).toEqual([[], ['stalled:stalled:in-progress-nothing-live'], [], []])
  })
  it('a live turn hides the stall but the episode holds (same shape): no second wake', () => {
    const t = stalled('t1')
    const live = task('t1') // the wake's own turn: live, not stalled, nothing visible moved
    const withNote = stalled('t1', 'in-progress-nothing-live', { notes: [{ at: '', by: 'writer', text: 'looking' }] })
    expect(looks([[t], [t], [live], [live], [withNote], [t]]).wakes.flat()).toEqual(['stalled:stalled:in-progress-nothing-live'])
  })
  it('a change of cause starts a new episode — a new wake', () => {
    const r = looks([
      [stalled('t1')],
      [stalled('t1')],
      [stalled('t1', 'review-without-reviewer', { state: 'in_review' })],
      [stalled('t1', 'review-without-reviewer', { state: 'in_review' })],
    ])
    expect(r.wakes.flat()).toEqual(['stalled:stalled:in-progress-nothing-live', 'stalled:stalled:review-without-reviewer'])
  })
  it('the task moved (its state), then stalled again: a new episode', () => {
    const r = looks([[stalled('t1')], [stalled('t1')], [task('t1', { state: 'pending' })], [stalled('t1')], [stalled('t1')]])
    expect(r.wakes.flat()).toEqual(['stalled:stalled:in-progress-nothing-live', 'stalled:stalled:in-progress-nothing-live'])
  })
  it("owner-cannot-run never wakes; a stall seated at another task is that seat's; a cancelled blocker is the DECLARER's to clear (A2.5: by seat, never at any depth)", () => {
    expect(wakesForStall(stalled('t1', 'owner-cannot-run'), BOUND)).toBe(false)
    expect(wakesForStall(task('t1', { stalledCause: 'blocker-parked', stalledBy: 't0', stalledAt: 't0' }), BOUND)).toBe(false)
    // t1 declares the cancelled blocker t0: its own seat — its owner clears it
    expect(wakesForStall(task('t1', { stalledCause: 'blocker-cancelled', stalledBy: 't0', stalledAt: 't1' }), BOUND)).toBe(true)
    // t1 waits on t2, which declares the cancelled t0: t2's to clear, not t1's
    expect(wakesForStall(task('t1', { stalledCause: 'blocker-cancelled', stalledBy: 't0', stalledAt: 't2' }), BOUND)).toBe(false)
    // an unbound owner's seat is never woken (its row is Needs you's)
    expect(wakesForStall(stalled('t1', 'in-progress-nothing-live', { owner: 'finance' }), BOUND)).toBe(false)
    const r = looks([[stalled('t1', 'owner-cannot-run')], [stalled('t1', 'owner-cannot-run')], [stalled('t1', 'owner-cannot-run')]])
    expect(r.wakes.flat()).toEqual([])
  })
  it("an unbound agent's stalled task is not even observed", () => {
    const r = looks([[stalled('t1', 'in-progress-nothing-live', { owner: 'finance' })], [stalled('t1', 'in-progress-nothing-live', { owner: 'finance' })]])
    expect(r.wakes.flat()).toEqual([])
    expect(r.obs).toEqual({})
  })
})

describe('retryFailed: the one wake changed nothing', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tm-retry-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))
  const readingOf = (tasks: Array<Record<string, unknown>>): SiloReading => ({
    records: [
      {
        silo: 'plans',
        kind: 'plan',
        source: 's',
        file: '/p/plans/launch.plan.json',
        rel: '',
        location: 'folder:/p/plans',
        anchors: {},
        mtimeMs: 0,
        raw: {},
        record: { id: 'launch', tasks },
        remarks: [],
        partial: false,
      } as never,
    ],
    unreadable: [],
    lastWrite: null,
    sources: {},
    truncated: [],
    problems: [],
  })
  it('only after the stalled wake was delivered, its turn ended, and a tick passed — with the same cause', () => {
    let now = T0
    let tasks: Array<Record<string, unknown>> = [{ id: 't1', title: 'Ship', owner: 'writer', status: 'in_progress' }]
    let stall: string | null = 'in-progress-nothing-live'
    let done: () => void = () => {}
    const sent: string[] = []
    const engine = new TaskModeEngine({
      store: new TaskModeStore(dir),
      plans: () => ({ reading: readingOf(tasks) }),
      bound: () => BOUND,
      ready: () => true,
      stalled: () => new Map(stall ? [['folder:/p/plans/launch/tasks/t1', { cause: stall, by: 't1', at: 't1' }]] : []),
      setField: () => ({ ok: true }),
      appendConversation: () => ({ ok: true }),
      conversationOf: () => null,
      holdersOf: () => [],
      busyWhy: () => null,
      send: (i) => {
        sent.push(i.text)
        return {
          turnId: 'turn-1',
          done: new Promise<void>((r) => {
            done = r
          }),
        }
      },
      now: () => now,
    })
    engine.look(now) // baseline
    now += 30_000
    engine.look(now) // the wake, delivered at once
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatch(/it is stalled — it is in progress and nothing is working it/)
    now += 120_000
    expect(engine.retryFailed(now)).toEqual([]) // its turn is still running
    done()
    return Promise.resolve()
      .then(() => Promise.resolve())
      .then(() => {
        expect(engine.retryFailed(now - 100_000)).toEqual([]) // 20 s after delivery: within the grace
        const f = engine.retryFailed(now)
        expect(f).toMatchObject([{ task: { key: 'folder:/p/plans/launch/tasks/t1', owner: 'writer' }, cause: 'in-progress-nothing-live' }])
        stall = null // someone gave it a disposition
        expect(engine.retryFailed(now)).toEqual([])
        tasks = [{ id: 't1', title: 'Ship', owner: 'writer', status: 'in_progress' }]
      })
  })
})

// ── the chain ───────────────────────────────────────────────────────────────

const ORG = { writer: 'finance', finance: 'builder', support: 'builder', ana: 'support' }
const chainOf = (edges: Record<string, string>): ChainView => ({ installed: true, up: (a) => chainUp(edges, a) })
const NONE: ChainView = { installed: false, up: () => [] }

describe("hopTargets — who is asked, in the spec's order", () => {
  it("owner → its chain (one hop at a time) → the creator's chain → the root → the human owner", () => {
    expect(hopTargets({ kind: 'task', who: 'writer', creator: 'ana' }, chainOf(ORG))).toEqual(['finance', 'builder', 'ana', 'support', OWNER])
  })
  it('a missing creator skips step 3; a creator in the chain already is not asked twice', () => {
    expect(hopTargets({ kind: 'task', who: 'writer', creator: null }, chainOf(ORG))).toEqual(['finance', 'builder', OWNER])
    expect(hopTargets({ kind: 'task', who: 'writer', creator: 'finance' }, chainOf(ORG))).toEqual(['finance', 'builder', OWNER])
    expect(hopTargets({ kind: 'task', who: 'writer', creator: 'writer' }, chainOf(ORG))).toEqual(['finance', 'builder', OWNER])
  })
  it('a root owner goes to the owner; without a chain relation, steps 2-4 are skipped', () => {
    expect(hopTargets({ kind: 'task', who: 'builder', creator: null }, chainOf(ORG))).toEqual([OWNER])
    expect(hopTargets({ kind: 'task', who: 'writer', creator: 'ana' }, NONE)).toEqual([OWNER])
  })
  it('cycle-proof: a loop written by hand ends the walk', () => {
    expect(hopTargets({ kind: 'task', who: 'a', creator: null }, chainOf({ a: 'b', b: 'c', c: 'a' }))).toEqual(['b', 'c', OWNER])
  })
  it("a row asks its producer's chain, never its creator's; an archived agent is skipped", () => {
    expect(hopTargets({ kind: 'row', who: 'writer', creator: 'ana' }, chainOf(ORG))).toEqual(['finance', 'builder', OWNER])
    expect(hopTargets({ kind: 'row', who: 'writer', creator: null }, chainOf(ORG), (id) => id !== 'finance')).toEqual(['builder', OWNER])
  })
  it("creatorOf: the first note's author, when an agent", () => {
    expect(
      creatorOf(
        {
          notes: [
            { at: '', by: 'ana', text: 'x' },
            { at: '', by: 'writer', text: 'y' },
          ],
        },
        () => true,
      ),
    ).toBe('ana')
    expect(creatorOf({ notes: [{ at: '', by: 'owner', text: 'x' }] }, () => true)).toBeNull()
    expect(creatorOf({ notes: [] }, () => true)).toBeNull()
  })
})

describe('evaluateEscalation — hop timing', () => {
  const W = 24 * H
  const subj = (over: Partial<Subject> = {}): Subject => ({
    id: 'task:k',
    kind: 'task',
    key: 'k',
    ref: 'p#t1',
    title: 'T',
    who: 'writer',
    creator: null,
    cause: 'c',
    since: new Date(T0).toISOString(),
    ...over,
  })
  const run = (steps: Array<{ at: number; subjects: Subject[] }>, chain = chainOf(ORG)) => {
    let prev: Record<string, Case> = {}
    return steps.map(({ at, subjects }) => {
      const ev = evaluateEscalation({ subjects, prev, now: at, windowMs: W, chain })
      prev = ev.cases
      return { fire: ev.fire.map((f) => f.to), closed: ev.closed.map((c) => c.id), opened: ev.opened.map((c) => c.id), cases: ev.cases }
    })
  }
  it('a task asks at once, then one hop per window, the owner last and once', () => {
    const r = run([
      { at: T0, subjects: [subj()] },
      { at: T0 + 1 * H, subjects: [subj()] },
      { at: T0 + W, subjects: [subj()] },
      { at: T0 + 2 * W, subjects: [subj()] },
      { at: T0 + 3 * W, subjects: [subj()] },
    ])
    expect(r.map((x) => x.fire)).toEqual([['finance'], [], ['builder'], [OWNER], []])
    expect(r[0]!.opened).toEqual(['task:k'])
    expect(askedWords(r[4]!.cases['task:k']!, (id) => id.toUpperCase())).toBe('asked FINANCE, then BUILDER')
  })
  it('after a long downtime, one hop per tick — never a burst', () => {
    const r = run([
      { at: T0, subjects: [subj()] },
      { at: T0 + 10 * W, subjects: [subj()] },
      { at: T0 + 10 * W + 30_000, subjects: [subj()] },
    ])
    expect(r.map((x) => x.fire)).toEqual([['finance'], ['builder'], []])
  })
  it('without a chain: straight to the owner', () => {
    expect(run([{ at: T0, subjects: [subj()] }], NONE).map((x) => x.fire)).toEqual([[OWNER]])
  })
  it('a row: the producer has the first window', () => {
    const row = subj({ id: 'row:f:0:k', kind: 'row' })
    expect(
      run(
        [
          { at: T0, subjects: [row] },
          { at: T0 + W - 1, subjects: [row] },
          { at: T0 + W, subjects: [row] },
        ],
        NONE,
      ).map((x) => x.fire),
    ).toEqual([[], [], [OWNER]])
  })
  it('a subject no longer stuck closes its case', () => {
    const r = run([
      { at: T0, subjects: [subj()] },
      { at: T0 + H, subjects: [] },
    ])
    expect(r[1]!.closed).toEqual(['task:k'])
    expect(r[1]!.cases).toEqual({})
  })
})

// ── the engine: notes, waits, messages, the owner's row ─────────────────────

describe('EscalationEngine', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'escalation-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  function rig(opts: { chain?: ChainView; rows?: () => RoutedRow[]; asks?: boolean } = {}) {
    let now = T0
    let t = stalled('t1', 'in-progress-nothing-live', { notes: [{ at: '', by: 'ana', text: 'please ship' }] })
    let failed = true
    const writes: Array<[string, string, unknown]> = []
    const notes: string[] = []
    const msgs: Array<[string, string]> = []
    // (B2.10) the asks: a hop's write and its fact, as task-asks.ts makes them
    const armed = new Map<string, { to: string; action: string }>()
    const hops: Array<[string, string]> = []
    const asks = {
      writeHop: (key: string, to: string, action: string) => {
        hops.push([key, to])
        t = { ...t, waitingOn: true, waitingFor: { owner: to, action }, state: 'blocked', stalledCause: null, stalledBy: null, stalledAt: null }
        failed = false
        return true
      },
      hopArmed: (key: string, to: string, action: string) => armed.get(key)?.to === to && armed.get(key)?.action === action,
      armHop: (key: string, to: string, action: string) => {
        armed.set(key, { to, action })
      },
    }
    const engine = new EscalationEngine({
      ...(opts.asks ? { asks } : {}),
      store: new EscalationStore(dir),
      taskMode: {
        tasks: () => [t],
        retryFailed: () =>
          failed
            ? [{ task: t, cause: 'in-progress-nothing-live', since: new Date(T0 - H).toISOString(), wokeAt: new Date(T0 - 30 * 60_000).toISOString() }]
            : [],
      },
      ...(opts.rows ? { routedRows: opts.rows } : {}),
      chain: () => opts.chain ?? chainOf(ORG),
      isAgent: () => true,
      nameOf: (id) => id[0]!.toUpperCase() + id.slice(1),
      setField: (key, field, value) => {
        writes.push([key, field, value])
        // the plan file follows the write (what the kernel would read next)
        if (field === 'waitingOn')
          t = { ...t, waitingOn: true, waitingFor: value as { owner: string; action: string }, stalledCause: null, stalledBy: null, stalledAt: null }
        if (field === 'status') t = { ...t, state: String(value) }
        failed = false
        return { ok: true }
      },
      appendNote: (_key, text) => {
        notes.push(text)
        return { ok: true }
      },
      message: (to, text) => {
        msgs.push([to, text])
      },
      now: () => now,
    })
    return {
      engine,
      writes,
      notes,
      msgs,
      armed,
      hops,
      at: (ms: number) => {
        now = T0 + ms
      },
      move: (over: Partial<TaskSnap>) => {
        t = { ...t, ...over }
      },
    }
  }

  it('the failed retry: a recovery note by silos, blocked waiting on the first hop, a normal message; then up the chain; the owner last', () => {
    const r = rig()
    r.engine.tick()
    expect(r.notes).toEqual([
      expect.stringMatching(
        /^stalled: it is in progress and nothing is working it; one wake on Nov 3, 08:30 UTC changed nothing\. .*Writer stays its owner\.$/,
      ),
    ])
    expect(r.writes).toEqual([
      [`${PLAN}/tasks/t1`, 'waitingOn', { owner: 'finance', action: 'unstick launch#t1' }],
      [`${PLAN}/tasks/t1`, 'status', 'blocked'],
    ])
    expect(r.msgs.map((m) => m[0])).toEqual(['finance'])
    expect(r.msgs[0]![1]).toMatch(/not an assignment: Writer stays its owner/)
    r.at(H)
    r.engine.tick()
    expect(r.msgs).toHaveLength(1) // the window has not passed
    r.at(24 * H)
    r.engine.tick()
    expect(r.msgs.map((m) => m[0])).toEqual(['finance', 'builder'])
    expect(r.writes.at(-1)).toEqual([`${PLAN}/tasks/t1`, 'waitingOn', { owner: 'builder', action: 'unstick launch#t1' }])
    r.at(48 * H)
    r.engine.tick() // ana: the creator
    r.at(72 * H)
    r.engine.tick() // support: ana's chain
    r.at(96 * H)
    r.engine.tick() // the owner
    expect(r.msgs.map((m) => m[0])).toEqual(['finance', 'builder', 'ana', 'support'])
    expect(r.writes.at(-1)).toEqual([`${PLAN}/tasks/t1`, 'waitingOn', { owner: OWNER, action: 'unstick launch#t1' }])
    expect(r.engine.ownerRows().map((x) => x.text)).toEqual([
      'launch#t1 stalled since Nov 3, 08:00 UTC — asked Finance, then Builder, then Ana, then Support; nobody moved it',
    ])
    // anyone moving it closes the case — and the owner's row with it
    r.move({ state: 'pending' })
    r.at(97 * H)
    r.engine.tick()
    expect(r.engine.ownerRows()).toEqual([])
    expect(r.engine.view().closed.map((c) => c.id)).toEqual([`task:${PLAN}/tasks/t1`])
  })

  // (B2.10, H10) changed by B2 only where `asks` is wired
  it('H10: an agent hop arms the same fact an ask arms — its wait in one write, no message; its answer (the wait out) closes the case; the owner hop is the setField of before', () => {
    const r = rig({ asks: true })
    r.engine.tick()
    expect(r.notes).toHaveLength(1) // the recovery note, as before
    expect(r.hops).toEqual([[`${PLAN}/tasks/t1`, 'finance']])
    expect(r.armed.get(`${PLAN}/tasks/t1`)).toEqual({ to: 'finance', action: 'unstick launch#t1' })
    expect(r.msgs).toEqual([]) // the ask is the notice
    expect(r.writes).toEqual([])
    // a tick over the same hop: nothing written again, the fact kept
    r.at(H)
    r.engine.tick()
    expect(r.hops).toHaveLength(1)
    // the fact lost (a store reset): armed again, the file untouched (waitOk compares the fact too)
    r.armed.clear()
    r.at(24 * H)
    r.engine.tick()
    expect(r.hops.map((h) => h[1])).toEqual(['finance', 'builder'])
    expect(r.armed.get(`${PLAN}/tasks/t1`)?.to).toBe('builder')
    expect(r.msgs).toEqual([])
    // builder answers (POST /api/tasks/ask/answer): the wait leaves the task, it is pending — the case closes
    r.move({ state: 'pending', waitingOn: false, waitingFor: null })
    r.at(25 * H)
    r.engine.tick()
    expect(r.engine.view().open).toEqual([])
    expect(r.engine.view().closed.map((c) => c.id)).toEqual([`task:${PLAN}/tasks/t1`])
  })

  it('H10: the last hop, the owner — the wait through setField as before, no fact armed', () => {
    const r = rig({ asks: true, chain: NONE })
    r.engine.tick()
    expect(r.hops).toEqual([])
    expect(r.armed.size).toBe(0)
    expect(r.writes[0]).toEqual([`${PLAN}/tasks/t1`, 'waitingOn', { owner: OWNER, action: 'unstick launch#t1' }])
  })

  it("without the chain relation: the failed retry is the owner's row at once — no message", () => {
    const r = rig({ chain: NONE })
    r.engine.tick()
    expect(r.msgs).toEqual([])
    expect(r.engine.ownerRows().map((x) => x.text)).toEqual(['launch#t1 stalled since Nov 3, 08:00 UTC — one wake to Writer changed nothing; nobody moved it'])
  })

  it("D7: routed rows hop after the producer's window — one message per agent for many rows — then reach the owner", () => {
    const row = (k: string): RoutedRow => ({
      silo: 'invoices',
      siloName: 'Invoices',
      entry: 0,
      key: k,
      text: `F-${k} — overdue`,
      producer: 'finance',
      recordKind: 'invoice',
      file: null,
    })
    let rows: RoutedRow[] = []
    const r = rig({ rows: () => rows, chain: chainOf(ORG) })
    r.at(-H)
    r.engine.tick() // the first look: nothing routed yet (the strict baseline is empty)
    rows = [row('a1'), row('a2'), row('a3')]
    r.at(0)
    r.engine.tick() // routed after the first look: they get the window
    const rowMsgs = () => r.msgs.filter((m) => m[1].includes('Invoices'))
    expect(rowMsgs()).toEqual([])
    expect(r.engine.escalatedRow('invoices', 0, 'a1')).toBeNull()
    r.at(24 * H)
    r.engine.tick()
    expect(rowMsgs().map((m) => m[0])).toEqual(['builder']) // finance's chain: one message for three rows
    expect(rowMsgs()[0]![1]).toMatch(/^3 rows of Invoices have been with Finance past its window/)
    r.at(48 * H)
    r.engine.tick()
    expect(r.engine.escalatedRow('invoices', 0, 'a1')).toEqual({ since: new Date(T0).toISOString(), asked: ['builder'] })
  })

  it('strict baseline: rows already routed at the first look never rise, across restarts; a new row and a re-entry get the window', () => {
    const row = (k: string): RoutedRow => ({
      silo: 'invoices',
      siloName: 'Invoices',
      entry: 0,
      key: k,
      text: `F-${k} — overdue`,
      producer: 'finance',
      recordKind: 'invoice',
      file: null,
    })
    let rows: RoutedRow[] = [row('old')]
    const r = rig({ rows: () => rows, chain: chainOf(ORG) })
    const rowMsgs = () => r.msgs.filter((m) => m[1].includes('Invoices'))
    r.engine.tick() // first look: «old» is baseline
    r.at(72 * H)
    r.engine.tick()
    expect(rowMsgs()).toEqual([])
    expect(r.engine.escalatedRow('invoices', 0, 'old')).toBeNull()
    // a restart keeps the mark: a fresh engine over the same dir
    const again = rig({ rows: () => rows, chain: chainOf(ORG) })
    again.at(96 * H)
    again.engine.tick()
    expect(again.msgs.filter((m) => m[1].includes('Invoices'))).toEqual([])
    // a new row, and «old» leaving and coming back: both get the window
    rows = [row('new')]
    again.at(100 * H)
    again.engine.tick()
    rows = [row('new'), row('old')]
    again.at(101 * H)
    again.engine.tick()
    again.at(125 * H)
    again.engine.tick()
    const m = again.msgs.filter((x) => x[1].includes('Invoices'))
    expect(m.map((x) => x[0])).toEqual(['builder'])
    expect(m[0]![1]).toMatch(/^2 rows of Invoices/)
  })

  it("the window is the owner's knob, kept; a corrupt state is set aside", () => {
    const s = new EscalationStore(dir)
    expect(s.windowHours()).toBe(24)
    s.setWindowHours(6)
    expect(new EscalationStore(dir).windowMs()).toBe(6 * H)
    mkdirSync(join(dir, 'escalation'), { recursive: true })
    writeFileSync(join(dir, 'escalation', 'state.json'), '{ broken')
    expect(new EscalationStore(dir).windowHours()).toBe(24)
    expect(readdirSync(join(dir, 'escalation')).some((f) => f.startsWith('state.json.corrupt'))).toBe(true)
  })
})
