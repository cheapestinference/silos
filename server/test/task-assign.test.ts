// task-assign.test.ts — the owner's GESTURE «Give to X» / «Start X ›»
// over the engine and a real store: one `assigned` wake through the
// pipe every wake takes, never a second one while a wake is on its way (New
// task's description note already woke it), the owner's notes carried once
// and baselined so no later look fires owner-note for them; plus what the
// day's wakes cost and the agent's own ceiling (E6).
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TaskModeStore } from '../src/task-mode/store.js'
import { TaskModeEngine, localDay, type TaskModeDeps } from '../src/task-mode/engine.js'
import type { SiloReading } from '../src/silos/reader.js'

const T0 = Date.parse('2026-11-09T09:00:00Z')
const MIN = 60_000
const KEY = (id: string): string => `folder:/p/launch/tasks/${id}`

let base: string
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'task-assign-'))
})
afterEach(() => rmSync(base, { recursive: true, force: true }))

function readingOf(tasks: Array<Record<string, unknown>>): SiloReading {
  return {
    records: [
      {
        silo: 'plans',
        kind: 'plan',
        source: 'plans',
        file: '/p/plans/launch.plan.json',
        rel: 'plans/launch.plan.json',
        location: 'folder:/p',
        anchors: {},
        mtimeMs: 0,
        raw: {},
        record: { id: 'launch', title: 'L', tasks },
        remarks: [],
        partial: [],
      },
    ],
    unreadable: [],
    problems: [],
    sources: {},
    lastWrite: null,
  } as unknown as SiloReading
}
const t = (id: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id,
  title: `Task ${id}`,
  owner: 'writer',
  state: 'pending',
  dependsOn: [],
  notes: [],
  conversations: [],
  ...over,
})
const note = (text: string, at = '2026-11-09T09:00:30Z') => ({ at, by: 'owner', text })

function world(opts: { bound?: string[]; busy?: (s: string) => string | null; deliveryOff?: boolean; ceiling?: number | null } = {}) {
  let now = T0
  let tasks: Array<Record<string, unknown>> = []
  const sent: Array<{ agentId: string; text: string; resume: string | null }> = []
  let finish: Array<(v?: { costUsd?: number | null }) => void> = []
  const store = new TaskModeStore(base)
  const deps: TaskModeDeps = {
    store,
    plans: () => ({ reading: readingOf(tasks) }),
    bound: () => new Set(opts.bound ?? ['writer']),
    ready: () => true,
    setField: () => ({ ok: true }),
    // the conversation a new wake opens joins the task (as appendConversation would write it)
    appendConversation: (k, s) => {
      tasks = tasks.map((x) => (KEY(String(x.id)) === k ? { ...x, conversations: [...(x.conversations as unknown[]), s] } : x))
      return { ok: true }
    },
    conversationOf: (_a, ids) => (ids.length > 0 ? { sessionId: ids[ids.length - 1]!, folder: '-p' } : null),
    holdersOf: (_a, ids) => ids,
    busyWhy: (s) => opts.busy?.(s) ?? null,
    send: (i) => {
      sent.push({ agentId: i.agentId, text: i.text, resume: i.resume })
      if (!i.resume) i.onSession(`new-session-000${sent.length}`)
      let done!: (v?: { costUsd?: number | null }) => void
      const p = new Promise<void | { costUsd?: number | null }>((r) => {
        done = r
      })
      finish.push(done)
      return { turnId: `turn-${sent.length}`, done: p }
    },
    nameOf: (id) => (id === 'writer' ? 'Writer' : id),
    ...(opts.deliveryOff ? { deliveryOff: true } : {}),
    // the agent's day on its own (own-turns.ts in life): here the charged
    // wakes of the store's day against the test's ceiling
    ownToday: (agent, at) => ({
      used: store.usedToday(agent, localDay(at)),
      costUsd: 0,
      unpriced: 0,
      ceiling: opts.ceiling ?? 10,
      spendCap: 1000,
      exempt: false,
    }),
    now: () => now,
  }
  const engine = new TaskModeEngine(deps)
  return {
    engine,
    store,
    sent,
    set: (x: Array<Record<string, unknown>>) => {
      tasks = x
    },
    tasks: () => tasks,
    at: (ms: number) => {
      now = ms
    },
    finishAll: async (v?: { costUsd?: number | null }) => {
      for (const f of finish) f(v)
      finish = []
      await new Promise((r) => setTimeout(r, 0))
    },
  }
}

describe('assign — the gesture, one wake through the usual pipe (G1/G5)', () => {
  it('1a · New task WITH a description for a bound agent: the note IS the wake; assign after it queues nothing — exactly one turn, with the note', async () => {
    const w = world()
    w.set([])
    w.engine.look()
    // New task writes the task (a look baselines it) then the note (owner-note fires)
    w.set([t('t1')])
    w.engine.look()
    w.set([t('t1', { notes: [note('make it orange')] })])
    w.engine.look()
    expect(w.sent).toHaveLength(1)
    // …and calls assign last: its turn is running → nothing more (3b too)
    expect(w.engine.assign(KEY('t1'))).toEqual({ queued: false, why: 'it is already on its way' })
    await w.finishAll()
    expect(w.sent).toHaveLength(1)
    expect(w.sent[0]!.text).toContain('make it orange')
    expect(w.store.wakes().map((x) => x.reason)).toEqual(['owner-note'])
  })

  it("1b · New task WITHOUT a description: the wake is assign's — one turn, «the owner handed it to you»", () => {
    const w = world()
    w.set([])
    w.engine.look()
    w.set([t('t1')])
    w.engine.look()
    expect(w.sent).toEqual([])
    expect(w.engine.assign(KEY('t1'), T0 + MIN, { ownerGesture: true })).toEqual({ queued: true })
    expect(w.sent).toHaveLength(1)
    expect(w.sent[0]!.text).toContain('Why: the owner handed it to you.')
    // an owner's gesture (R1): never charged to the agent's day
    expect(w.store.wakes()[0]!.gesture).toBe(true)
    expect(w.store.wakes()).toEqual([
      expect.objectContaining({ reason: 'assigned', state: 'delivered', via: 'wake', key: `assigned:${KEY('t1')}:writer:${new Date(T0 + MIN).toISOString()}` }),
    ])
  })

  it("the owner's notes no delivered wake carried ride the assigned wake — and no later look fires owner-note for them (baseline in the same write)", () => {
    const w = world({ deliveryOff: true })
    // task + note written before Silos ever looked: no observation yet
    w.set([t('t1', { notes: [note('use the new rate'), { at: 'x', by: 'writer', text: 'an agent note' }] })])
    expect(w.engine.assign(KEY('t1'))).toEqual({ queued: true })
    expect(w.store.queued()).toEqual([expect.objectContaining({ reason: 'assigned', notes: [note('use the new rate')] })])
    expect(w.store.observations()[KEY('t1')]!.ownerSeen).toHaveLength(1)
    w.engine.look()
    w.engine.look()
    expect(w.store.wakes().map((x) => x.reason)).toEqual(['assigned'])
  })

  it('3 · assign twice in a row → one wake (the second: «it is already on its way»), held or delivered alike', () => {
    for (const busy of [null, 'a console has its conversation open'] as const) {
      rmSync(base, { recursive: true, force: true })
      base = mkdtempSync(join(tmpdir(), 'task-assign-'))
      const w = world({ busy: () => busy })
      w.set([t('t1')])
      expect(w.engine.assign(KEY('t1')).queued).toBe(true)
      expect(w.engine.assign(KEY('t1'))).toEqual({ queued: false, why: 'it is already on its way' })
      expect(w.store.wakes()).toHaveLength(1)
    }
  })

  it('3b · a queued wake of ANY reason holds the gesture back (the owner-note of New task, waiting on a console)', () => {
    const w = world({ busy: () => 'a console has its conversation open' })
    w.set([t('t1', { conversations: ['sess-held0001'] })])
    w.engine.look()
    w.set([t('t1', { conversations: ['sess-held0001'], notes: [note('hello')] })])
    w.engine.look()
    expect(w.store.queued().map((x) => x.reason)).toEqual(['owner-note'])
    expect(w.engine.assign(KEY('t1'))).toEqual({ queued: false, why: 'it is already on its way' })
  })

  it('4 · a task with a current conversation, a closed one, a blocked one, one that waits: nothing queued, said', () => {
    const w = world()
    w.set([
      t('a', { conversations: ['sess-aaaa0001'] }),
      t('b', { state: 'done' }),
      t('c', { dependsOn: ['b0'] }),
      t('b0', { owner: 'sam' }),
      t('d', { state: 'blocked' }),
      t('e', { waitingOn: { owner: 'owner', action: 'decide' } }),
      t('f', { owner: 'finance' }),
    ])
    expect(w.engine.assign(KEY('a'))).toEqual({ queued: false, why: 'Writer is on it already — open it' })
    expect(w.engine.assign(KEY('b'))).toEqual({ queued: false, why: 'the task is done already' })
    expect(w.engine.assign(KEY('c'))).toEqual({ queued: false, why: 'it waits on b0 — Silos wakes Writer when it is done' })
    expect(w.engine.assign(KEY('d'))).toEqual({ queued: false, why: 'it is blocked — unblock it first' })
    expect(w.engine.assign(KEY('e'))).toEqual({ queued: false, why: 'it waits on you' })
    expect(w.engine.assign(KEY('f'))).toEqual({ queued: false, why: 'finance is Only when told — open it on the task' })
    expect(w.engine.assign(KEY('nope'))).toEqual({ queued: false, why: 'no such task in the plans Silos reads' })
    expect(w.store.wakes()).toEqual([])
  })

  it('4b · a dropped blocker never resolves: no «wakes Writer when it is done» — the way out is said; a cancelled task is «cancelled already»', () => {
    const w = world()
    w.set([t('x', { state: 'cancelled' }), t('g', { dependsOn: ['x'] }), t('h', { dependsOn: ['x', 'b0'] }), t('b0', { owner: 'sam' })])
    expect(w.engine.assign(KEY('g'))).toEqual({ queued: false, why: 'it waits on x which was dropped — remove the dependency or reopen it first' })
    expect(w.engine.assign(KEY('h'))).toEqual({ queued: false, why: 'it waits on x which was dropped — remove the dependency or reopen it first' })
    expect(w.engine.assign(KEY('x'))).toEqual({ queued: false, why: 'the task is cancelled already' })
    expect(w.store.wakes()).toEqual([])
  })

  it("the ceiling holds an agent's own assign (it does not skip the throttle nor the day's ceiling) — said in the answer", () => {
    const w = world({ ceiling: 2 })
    w.store.update((s) => {
      s.budget.writer = { day: localDay(T0), used: 2 }
    })
    w.set([t('t1')])
    const r = w.engine.assign(KEY('t1'))
    expect(r).toEqual({ queued: true, held: 'started 2 times without you today — it waits for tomorrow' })
    expect(w.sent).toEqual([])
  })

  // the owner's gesture is never held by a ceiling
  // nor a throttle — only the live caps queue it
  it("the owner's assign is never held by the ceiling", () => {
    const w = world({ ceiling: 2 })
    w.store.update((s) => {
      s.budget.writer = { day: localDay(T0), used: 2 }
    })
    w.set([t('t1')])
    expect(w.engine.assign(KEY('t1'), T0, { ownerGesture: true })).toEqual({ queued: true })
    expect(w.sent).toHaveLength(1)
  })
})

describe('wakeOnTheWay — what idle and assign read (G2)', () => {
  it('a queued wake of the owner, or its turn running; by key, or by owner + task id when no key', async () => {
    const w = world({ busy: () => 'a console holds it' })
    w.set([t('t1'), t('t2')])
    expect(w.engine.wakeOnTheWay({ key: KEY('t1'), owner: 'writer', id: 't1' })).toBe(false)
    w.engine.assign(KEY('t1'))
    expect(w.engine.wakeOnTheWay({ key: KEY('t1'), owner: 'writer', id: 't1' })).toBe(true)
    expect(w.engine.wakeOnTheWay({ key: null, owner: 'writer', id: 't1' })).toBe(true)
    expect(w.engine.wakeOnTheWay({ key: KEY('t2'), owner: 'writer', id: 't2' })).toBe(false)
    expect(w.engine.wakeOnTheWay({ key: KEY('t1'), owner: 'finance', id: 't1' })).toBe(false)
  })
})

describe("the day's wakes, their cost and the agent's ceiling (E6)", () => {
  it('today: delivered wake turns, priced by their engine at the end; unpriced and running said apart', async () => {
    const w = world()
    w.set([t('t1'), t('t2')])
    w.engine.assign(KEY('t1'))
    expect(w.engine.today('writer')).toMatchObject({ woke: 1, costUsd: null, running: 1, unpriced: 0, ceiling: 10 })
    await w.finishAll({ costUsd: 0.25 })
    w.engine.assign(KEY('t2'))
    await w.finishAll({ costUsd: null })
    expect(w.engine.today('writer')).toMatchObject({
      agent: 'writer',
      day: localDay(T0),
      woke: 2,
      costUsd: 0.25,
      unpriced: 1,
      running: 0,
      ceiling: 10,
      heldByCeiling: 0,
    })
    // tomorrow starts at zero
    expect(w.engine.today('writer', T0 + 36 * 3600_000)).toMatchObject({ woke: 0, costUsd: null })
  })

  it("the agent's own ceiling is where the engine checks it; a hit is listed for Needs you", () => {
    const w = world({ ceiling: 1 })
    w.set([t('t1'), t('t2')])
    expect(w.engine.assign(KEY('t1'))).toEqual({ queued: true })
    expect(w.engine.ceilingHits()).toEqual([
      { agent: 'writer', used: 1, perDay: 1, waiting: 0, until: expect.any(String), day: localDay(T0), cap: 'ceiling', spentUsd: 0 },
    ])
    expect(w.engine.assign(KEY('t2'))).toEqual({ queued: true, held: 'started 1 times without you today — it waits for tomorrow' })
    expect(w.engine.ceilingHits()[0]).toMatchObject({ waiting: 1 })
    expect(w.engine.today('writer')).toMatchObject({ ceiling: 1, heldByCeiling: 1 })
  })
})

// the flip to Only when told supersedes every
// queued wake at once (a wake held until midnight never fires against R2);
// the pipe re-verifies the control at dequeue (bound() is derived from it)
describe('the flip to Only when told', () => {
  it("supersedeAgent marks the agent's queued wakes superseded, said", () => {
    const w = world({ ceiling: 1 })
    w.store.update((s) => {
      s.budget.writer = { day: localDay(T0), used: 1 }
    })
    w.set([t('t1')])
    w.engine.assign(KEY('t1'))
    expect(w.store.queued()).toHaveLength(1)
    expect(w.engine.supersedeAgent('writer', 'Writer is Only when told now — its queued wakes were dropped')).toBe(1)
    expect(w.store.queued()).toEqual([])
    expect(w.store.wakes()[0]).toMatchObject({ state: 'superseded', held: 'Writer is Only when told now — its queued wakes were dropped' })
  })
  it('a queued wake of an agent no longer On its own is superseded at the next delivery', () => {
    const w = world({ bound: [] })
    w.store.update((s) => {
      s.wakes.push({
        id: 'w1',
        agent: 'writer',
        task: KEY('t1'),
        ref: 'p#t1',
        title: 'T',
        reason: 'unblocked',
        says: 'x',
        at: new Date(T0).toISOString(),
        state: 'queued',
        notes: [],
        bypassThrottle: false,
      })
    })
    w.set([t('t1')])
    w.engine.deliver()
    expect(w.store.wakes()[0]).toMatchObject({ state: 'superseded' })
    expect(w.sent).toEqual([])
  })
})
