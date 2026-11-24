// task-mode-owner-gestures.test.ts — Task mode's rules around the owner's
// gestures (every open task has a next step), over a real store and a fake
// plans reading: the owner's assign, the holds' class, «Open chat» and a
// stale stall's wake. Generic fixtures only.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TaskModeStore } from '../src/task-mode/store.js'
import { TaskModeEngine, localDay, type TaskModeDeps, type TaskTurnEnd } from '../src/task-mode/engine.js'
import type { SiloReading } from '../src/silos/reader.js'

const T0 = Date.parse('2026-11-09T09:00:00Z')
const MIN = 60_000
const KEY = (id: string): string => `folder:/p/launch/tasks/${id}`

let base: string
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'task-mode-gestures-'))
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
type Flow = { cause: string | null; by: string | null; at: string | null; idle?: boolean; waitsStart?: boolean; live?: boolean }

function world(
  opts: {
    bound?: string[]
    busy?: (s: string) => string | null
    flows?: () => Map<string, Flow>
    ceiling?: number
    send?: TaskModeDeps['send']
    extra?: Partial<TaskModeDeps>
  } = {},
) {
  let now = T0
  let tasks: Array<Record<string, unknown>> = []
  const sent: Array<{ agentId: string; text: string; resume: string | null; onStarted?: () => void }> = []
  let finish: Array<(v?: TaskTurnEnd) => void> = []
  // each world its own data dir: several worlds in one test never share a store
  const store = new TaskModeStore(mkdtempSync(join(base, 'w-')))
  const deps: TaskModeDeps = {
    store,
    plans: () => ({ reading: readingOf(tasks) }),
    bound: () => new Set(opts.bound ?? ['writer']),
    ready: () => true,
    setField: () => ({ ok: true }),
    appendConversation: (k, s) => {
      tasks = tasks.map((x) => (KEY(String(x.id)) === k ? { ...x, conversations: [...(x.conversations as unknown[]), s] } : x))
      return { ok: true }
    },
    conversationOf: (_a, ids) => (ids.length > 0 ? { sessionId: ids[ids.length - 1]!, folder: '-p' } : null),
    holdersOf: (_a, ids) => ids,
    busyWhy: (s) => opts.busy?.(s) ?? null,
    send:
      opts.send ??
      ((i) => {
        sent.push({ agentId: i.agentId, text: i.text, resume: i.resume, ...(i.onStarted ? { onStarted: i.onStarted } : {}) })
        if (!i.resume) i.onSession(`new-session-000${sent.length}`)
        let done!: (v?: TaskTurnEnd) => void
        const p = new Promise<void | TaskTurnEnd>((r) => {
          done = r
        })
        finish.push(done)
        return { turnId: `turn-${sent.length}`, done: p }
      }),
    nameOf: (id) => (id === 'writer' ? 'Writer' : id),
    ...(opts.flows ? { stalled: opts.flows } : {}),
    ownToday: (agent, at) => ({
      used: store.usedToday(agent, localDay(at)),
      costUsd: 0,
      unpriced: 0,
      ceiling: opts.ceiling ?? 10,
      spendCap: 1000,
      exempt: false,
    }),
    now: () => now,
    ...opts.extra,
  }
  const engine = new TaskModeEngine(deps)
  return {
    engine,
    store,
    sent,
    set: (x: Array<Record<string, unknown>>) => {
      tasks = x
    },
    at: (ms: number) => {
      now = ms
    },
    finishAll: async (v?: TaskTurnEnd) => {
      for (const f of finish) f(v)
      finish = []
      await new Promise((r) => setTimeout(r, 0))
    },
  }
}

describe("the owner's assign reads a blocked task nothing holds as pending", () => {
  it('blocked over dependencies all done, no wait: Start X queues; blocked naming nothing is still «unblock it first»', () => {
    const w = world()
    w.set([t('b0', { owner: 'sam', state: 'done' }), t('a', { state: 'blocked', dependsOn: ['b0'] }), t('d', { state: 'blocked' })])
    expect(w.engine.assign(KEY('d'), T0, { ownerGesture: true })).toEqual({ queued: false, why: 'it is blocked — unblock it first' })
    expect(w.engine.assign(KEY('a'), T0, { ownerGesture: true })).toMatchObject({ queued: true })
    expect(w.store.wakes().map((x) => [x.task, x.reason])).toEqual([[KEY('a'), 'assigned']])
  })
  it('a wait, or a check still ahead, keeps it blocked', () => {
    const w = world()
    w.set([
      t('b0', { owner: 'sam', state: 'done' }),
      t('a', { state: 'blocked', dependsOn: ['b0'], nextCheckAt: new Date(T0 + 60 * MIN).toISOString() }),
      t('e', { state: 'blocked', dependsOn: ['b0'], waitingOn: { owner: 'owner', action: 'decide' } }),
    ])
    expect(w.engine.assign(KEY('a'), T0, { ownerGesture: true })).toEqual({ queued: false, why: 'it is blocked — unblock it first' })
    expect(w.engine.assign(KEY('e'), T0, { ownerGesture: true })).toEqual({ queued: false, why: 'it is blocked — unblock it first' })
  })
})

describe("the owner's gesture is refused only by a conversation that is LIVE", () => {
  const flows = (live: boolean) => () => new Map<string, Flow>([[KEY('a'), { cause: null, by: null, at: null, idle: !live, waitsStart: false, live }]])
  it('a current conversation that stopped moving: the gesture queues and the wake RESUMES that conversation', () => {
    const w = world({ flows: flows(false) })
    w.set([t('a', { conversations: ['sess-old00001'] })])
    expect(w.engine.assign(KEY('a'), T0, { ownerGesture: true })).toEqual({ queued: true })
    expect(w.sent).toEqual([expect.objectContaining({ agentId: 'writer', resume: 'sess-old00001' })])
    expect(w.store.wakes()[0]).toMatchObject({ reason: 'assigned', gesture: true, state: 'delivered' })
  })
  it('a live one: «X is on it already — open it», nothing queued', () => {
    const w = world({ flows: flows(true) })
    w.set([t('a', { conversations: ['sess-live0001'] })])
    expect(w.engine.assign(KEY('a'), T0, { ownerGesture: true })).toEqual({ queued: false, why: 'Writer is on it already — open it' })
    expect(w.store.wakes()).toEqual([])
  })
  it('a console still open on it: queued and HELD by deliver — never injected into it', () => {
    const w = world({ flows: flows(false), busy: (s) => (s === 'sess-old00001' ? 'a console has its conversation open' : null) })
    w.set([t('a', { conversations: ['sess-old00001'] })])
    expect(w.engine.assign(KEY('a'), T0, { ownerGesture: true })).toEqual({
      queued: true,
      held: 'a console has its conversation open — it gets this at its next turn',
    })
    expect(w.sent).toEqual([])
  })
  it("a bearer's assign keeps its lock, letter by letter: any current conversation refuses it", () => {
    const w = world({ flows: flows(false) })
    w.set([t('a', { conversations: ['sess-old00001'] })])
    expect(w.engine.assign(KEY('a'), T0, { ownerGesture: false })).toEqual({ queued: false, why: 'Writer is on it already — open it' })
    expect(w.engine.assign(KEY('a'))).toEqual({ queued: false, why: 'Writer is on it already — open it' })
  })
  it("without the kernel's word on liveness (no flow given), the lock stands for the gesture too", () => {
    const w = world()
    w.set([t('a', { conversations: ['sess-old00001'] })])
    expect(w.engine.assign(KEY('a'), T0, { ownerGesture: true })).toEqual({ queued: false, why: 'Writer is on it already — open it' })
  })
})

describe("the owner's «Remove the dependency» on a bound agent's task leaves it ready: no inferred wake, «Start X ›» goes", () => {
  it('blocked on a dropped task with an old conversation → the owner removes the dependency (and sets it pending) → no wake from the look; idle; the gesture queues', () => {
    const live = false
    const w = world({ flows: () => new Map<string, Flow>([[KEY('a'), { cause: null, by: null, at: null, idle: !live, waitsStart: false, live }]]) })
    w.set([t('x', { owner: 'sam', state: 'cancelled' }), t('a', { state: 'blocked', dependsOn: ['x'], conversations: ['sess-old00001'] })])
    w.engine.look(T0)
    expect(w.engine.assign(KEY('a'), T0, { ownerGesture: true })).toMatchObject({
      queued: false,
      why: expect.stringMatching(/^it waits on x which was dropped/),
    })
    // the gesture: dependsOn without x, and — nothing else holding it — pending
    w.set([t('x', { owner: 'sam', state: 'cancelled' }), t('a', { state: 'pending', dependsOn: [], conversations: ['sess-old00001'] })])
    w.at(T0 + MIN)
    w.engine.look(T0 + MIN)
    expect(w.store.wakes()).toEqual([])
    expect(w.sent).toEqual([])
    // Start X ›: the gesture queues and resumes the old conversation
    expect(w.engine.assign(KEY('a'), T0 + MIN, { ownerGesture: true })).toEqual({ queued: true })
    expect(w.sent).toEqual([expect.objectContaining({ resume: 'sess-old00001' })])
  })
  it('«Reopen» of the dropped blocker: the task waits on it again — no wake, no Start until it is done', () => {
    const w = world({ flows: () => new Map<string, Flow>([[KEY('a'), { cause: null, by: null, at: null, idle: false, waitsStart: false, live: false }]]) })
    w.set([t('x', { owner: 'sam', state: 'cancelled' }), t('a', { state: 'blocked', dependsOn: ['x'] })])
    w.engine.look(T0)
    w.set([t('x', { owner: 'sam', state: 'pending' }), t('a', { state: 'blocked', dependsOn: ['x'] })])
    w.at(T0 + MIN)
    w.engine.look(T0 + MIN)
    expect(w.store.wakes()).toEqual([])
    expect(w.engine.assign(KEY('a'), T0 + MIN, { ownerGesture: true })).toEqual({ queued: false, why: 'it waits on x — Silos wakes Writer when it is done' })
  })
})

describe('a `stalled` wake is never delivered over an episode that no longer exists', () => {
  // a console holds the task's conversation until `free` — the stalled wake waits queued
  function stalledWorld() {
    let cause: string | null = 'in-progress-nothing-live'
    let held = true
    const w = world({
      flows: () => new Map<string, Flow>(cause ? [[KEY('a'), { cause, by: 'a', at: 'a', idle: false, waitsStart: false, live: false }]] : []),
      busy: (s) => (held && s === 'sess-a0000001' ? 'a console has its conversation open' : null),
    })
    w.set([t('a', { state: 'in_progress', conversations: ['sess-a0000001'] })])
    w.engine.look(T0) // baseline
    w.at(T0 + 30_000)
    w.engine.look(T0 + 30_000) // the episode's ONE wake — held by the console
    expect(w.store.queued().map((x) => x.reason)).toEqual(['stalled'])
    return {
      w,
      clear: () => {
        cause = null
      },
      free: () => {
        held = false
      },
    }
  }
  it('the task moved on (its state changed: no episode any more) before the wake could go: superseded, said', () => {
    const { w, clear, free } = stalledWorld()
    clear()
    w.set([t('a', { state: 'in_review', waitingOn: { owner: 'owner', action: 'review' }, conversations: ['sess-a0000001'] })])
    free()
    w.at(T0 + 60_000)
    w.engine.look(T0 + 60_000)
    expect(w.sent).toEqual([])
    expect(w.store.wakes()[0]).toMatchObject({ reason: 'stalled', state: 'superseded', held: 'the task moved on first' })
  })
  it('the episode still holds — hidden by a conversation that moved, its shape unchanged: delivered as always', () => {
    const { w, clear, free } = stalledWorld()
    clear() // the kernel no longer says stalled (a turn made it live), nothing visible moved
    free()
    w.at(T0 + 60_000)
    w.engine.look(T0 + 60_000)
    expect(w.sent).toHaveLength(1)
    expect(w.store.wakes()[0]).toMatchObject({ reason: 'stalled', state: 'delivered' })
  })
  it("per wake, not per group: the stale stall goes, the owner's note in the same group is delivered", () => {
    const { w, clear, free } = stalledWorld()
    const noted = { notes: [{ at: new Date(T0 + 40_000).toISOString(), by: 'owner', text: 'go on' }] }
    w.set([t('a', { state: 'in_progress', conversations: ['sess-a0000001'], ...noted })])
    w.at(T0 + 45_000)
    w.engine.look(T0 + 45_000) // the note's wake joins the held group
    expect(
      w.store
        .queued()
        .map((x) => x.reason)
        .sort(),
    ).toEqual(['owner-note', 'stalled'])
    // the agent moves it before the console lets go: the episode ends
    clear()
    w.set([t('a', { state: 'pending', conversations: ['sess-a0000001'], ...noted })])
    w.at(T0 + 50_000)
    w.engine.look(T0 + 50_000)
    expect(w.store.queued().map((x) => x.reason)).toEqual(['owner-note'])
    free()
    w.at(T0 + 60_000)
    w.engine.deliver(T0 + 60_000)
    expect(w.sent).toHaveLength(1)
    expect(w.sent[0]!.text).toContain('go on')
    expect(w.sent[0]!.text).not.toContain('it is stalled')
    expect(w.store.wakes().find((x) => x.reason === 'stalled')).toMatchObject({ state: 'superseded', held: 'the task moved on first' })
    expect(w.store.wakes().find((x) => x.reason === 'owner-note')).toMatchObject({ state: 'delivered' })
  })
})

describe('«Open chat» folds the queued wakes in when its turn STARTS, and a refusal is a 409 in its words', () => {
  // an owner's note whose wake waits for a console; the console then closes
  function heldNote() {
    let held = true
    const w = world({ busy: (s) => (held && s === 'sess-a0000001' ? 'a console has its conversation open' : null) })
    w.set([t('a', { conversations: ['sess-a0000001'] })])
    w.engine.look(T0)
    w.set([t('a', { conversations: ['sess-a0000001'], notes: [{ at: new Date(T0 + 10_000).toISOString(), by: 'owner', text: 'look at the logo' }] })])
    w.at(T0 + 20_000)
    w.engine.look(T0 + 20_000)
    expect(w.store.queued().map((x) => x.reason)).toEqual(['owner-note'])
    held = false
    return w
  }
  it("asked: the wake stays queued; the turn's first output marks it delivered (via talk)", async () => {
    const w = heldNote()
    const r = await w.engine.openTalk(KEY('a'))
    expect(r).toMatchObject({ ok: true, sessionId: 'sess-a0000001', folded: [expect.any(String)] })
    expect(w.store.queued().map((x) => x.reason)).toEqual(['owner-note'])
    expect(w.sent[0]!.text).toContain('look at the logo')
    w.sent[0]!.onStarted!()
    expect(w.store.queued()).toEqual([])
    expect(w.store.wakes()[0]).toMatchObject({ state: 'delivered', via: 'talk', session: 'sess-a0000001' })
  })
  it('a turn that never starts leaves the wake queued: once it is over, deliver sends it', async () => {
    const w = heldNote()
    await w.engine.openTalk(KEY('a'))
    // while the talk turn runs, deliver holds it (its turn is running)
    w.engine.deliver(T0 + 30_000)
    expect(w.sent).toHaveLength(1)
    await w.finishAll({ started: false, error: 'boom' })
    w.engine.deliver(T0 + 40_000)
    expect(w.sent).toHaveLength(2)
    expect(w.store.wakes()[0]).toMatchObject({ state: 'delivered', via: 'wake' })
  })
  it('the resident lane refuses (no agent in play, no folder): 409 with its words, nothing marked', async () => {
    const w = world({
      send: () => {
        throw new Error('Writer has no folder')
      },
    })
    w.set([t('a')])
    expect(await w.engine.openTalk(KEY('a'))).toEqual({ ok: false, code: 409, reason: 'Writer has no folder' })
  })
})

describe('every hold carries its class beside its words; the ceiling count reads the class', () => {
  // a bound task, then an inferred wake (unblocked) or the owner's note
  function unblock(w: ReturnType<typeof world>): void {
    w.set([t('b0', { owner: 'sam' }), t('a', { dependsOn: ['b0'], state: 'blocked', conversations: ['sess-a0000001'] })])
    w.engine.look(T0)
    w.set([t('b0', { owner: 'sam', state: 'done' }), t('a', { dependsOn: ['b0'], state: 'blocked', conversations: ['sess-a0000001'] })])
    w.at(T0 + MIN)
    w.engine.look(T0 + MIN)
  }
  const classOf = (w: ReturnType<typeof world>): Array<[string | undefined, string | undefined]> => w.store.queued().map((x) => [x.holdClass, x.held])
  it('console · turn · engine · limit · ceiling · slot', () => {
    const console = world({ busy: () => 'a console has its conversation open' })
    unblock(console)
    expect(classOf(console)).toEqual([['console', 'a console has its conversation open — it gets this at its next turn']])
    const turn = world({ busy: () => 'a turn is running on its conversation' })
    unblock(turn)
    expect(classOf(turn)[0]![0]).toBe('turn')
    const engine = world({ extra: { engineRefusal: () => 'Claude Code is missing' } })
    unblock(engine)
    expect(classOf(engine)[0]![0]).toBe('engine')
    const limit = world({ extra: { limitedUntil: () => new Date(T0 + 3 * 3600_000).toISOString() } })
    unblock(limit)
    expect(classOf(limit)[0]![0]).toBe('limit')
    const ceiling = world({ ceiling: 0 })
    unblock(ceiling)
    expect(classOf(ceiling)[0]).toEqual(['ceiling', 'started 0 times without you today — it waits for tomorrow'])
    expect(ceiling.engine.today('writer').heldByCeiling).toBe(1)
    const spend = world({ extra: { ownToday: () => ({ used: 0, costUsd: 9, unpriced: 0, ceiling: 10, spendCap: 5, exempt: false }) } })
    unblock(spend)
    expect(classOf(spend)[0]![0]).toBe('ceiling')
    expect(spend.engine.today('writer').heldByCeiling).toBe(1)
  })
  it('a start that failed (backoff), a task not found (missing) — and the class leaves with the hold', () => {
    const backoff = world({
      send: () => {
        throw new Error('boom')
      },
    })
    unblock(backoff)
    expect(classOf(backoff)[0]![0]).toBe('backoff')
    let held = true
    const w = world({ busy: (s) => (s === 'sess-a0000001' && held ? 'a console has its conversation open' : null) })
    unblock(w)
    expect(classOf(w)[0]![0]).toBe('console')
    w.set([])
    w.at(T0 + 2 * MIN)
    w.engine.deliver(T0 + 2 * MIN)
    expect(classOf(w)[0]![0]).toBe('missing')
    w.set([t('b0', { owner: 'sam', state: 'done' }), t('a', { dependsOn: ['b0'], state: 'blocked', conversations: ['sess-a0000001'] })])
    held = false
    w.at(T0 + 3 * MIN)
    w.engine.deliver(T0 + 3 * MIN)
    expect(w.store.wakes()[0]!.state).toBe('delivered')
    expect(w.store.wakes()[0]!.holdClass).toBeUndefined()
  })
  it('the ceiling count reads the class, never the words: a hold that only SAYS «times without you today» is not counted', () => {
    const w = world({ busy: () => 'a console has its conversation open' })
    unblock(w)
    w.store.update((s) => {
      for (const x of s.wakes) x.held = 'started 3 times without you today — it waits for tomorrow'
    })
    expect(w.engine.today('writer').heldByCeiling).toBe(0)
  })
})
