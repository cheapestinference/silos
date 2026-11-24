// task-mode-wakes.test.ts — WHEN a task calls its bound owner (task-view
// phase 3): the pure evaluation (each event, its dedup key, the baseline, no
// self-wake, owner vs agent notes, the one-shot next check), the no-progress
// throttle, and the engine over a store: queued while the conversation is
// mid-turn or a console holds it, superseded when the task moves on, resume
// vs a new conversation, the day's ceiling, and — above all — an UNBOUND
// agent's tasks are never looked at.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CHECK_LATE_MS,
  evaluateTaskWakes,
  fingerprintOf,
  throttle,
  THROTTLE_BASE_MS,
  THROTTLE_MAX_MS,
  type Observation,
  type TaskSnap,
} from '../src/task-mode/evaluate.js'
import { wakeBriefing, workBriefing, BRIEFING_MAX } from '../src/task-mode/briefing.js'
import { TaskModeStore } from '../src/task-mode/store.js'
import { TaskModeEngine, localDay, SEEN_REFRESH_MS, type TaskModeDeps } from '../src/task-mode/engine.js'
import { OWN_TURNS_PER_DAY } from '../src/limits.js'
import type { SiloReading } from '../src/silos/reader.js'

const T0 = Date.parse('2026-11-03T09:00:00Z')
const MIN = 60_000
const PLAN = 'folder:/p/launch'

function task(id: string, over: Partial<TaskSnap> = {}): TaskSnap {
  return {
    key: `${PLAN}/tasks/${id}`,
    planKey: PLAN,
    planId: 'launch',
    id,
    ref: `launch#${id}`,
    title: `Task ${id}`,
    owner: 'writer',
    state: 'pending',
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
const BOUND = new Set(['writer'])

// look twice: a baseline, then the change
function step(tasksBefore: TaskSnap[], tasksAfter: TaskSnap[], opts: { bound?: Set<string>; now?: number } = {}) {
  const bound = opts.bound ?? BOUND
  const a = evaluateTaskWakes({ tasks: tasksBefore, bound, prev: {}, now: T0 })
  return { base: a, next: evaluateTaskWakes({ tasks: tasksAfter, bound, prev: a.observations, now: opts.now ?? T0 + MIN }) }
}

describe('the events — each a transition Silos saw, one wake per key', () => {
  it('the first look is a baseline: it records and wakes nothing, even over a ready task', () => {
    const r = evaluateTaskWakes({
      tasks: [task('t1', { state: 'done' }), task('t2', { dependsOn: ['t1'], state: 'blocked' })],
      bound: BOUND,
      prev: {},
      now: T0,
    })
    expect(r.wakes).toEqual([])
    expect(Object.keys(r.observations)).toEqual([`${PLAN}/tasks/t1`, `${PLAN}/tasks/t2`])
  })

  it('unblocked: every blocker done wakes the owner once, keyed by the sorted blockers + when it entered blocked', () => {
    const before = [task('a', { owner: 'sam' }), task('b', { owner: 'sam', state: 'done' }), task('t2', { dependsOn: ['b', 'a'], state: 'blocked' })]
    const after = [
      task('a', { owner: 'sam', state: 'done' }),
      task('b', { owner: 'sam', state: 'done' }),
      task('t2', { dependsOn: ['b', 'a'], state: 'blocked' }),
    ]
    const { base, next } = step(before, after)
    expect(next.wakes).toEqual([
      expect.objectContaining({
        agent: 'writer',
        task: `${PLAN}/tasks/t2`,
        reason: 'unblocked',
        key: `unblocked:a,b@${new Date(T0).toISOString()}`,
        says: 'its blockers are done (b, a)',
      }),
    ])
    // looked at again with nothing new: no second wake
    expect(evaluateTaskWakes({ tasks: after, bound: BOUND, prev: next.observations, now: T0 + 2 * MIN }).wakes).toEqual([])
    expect(base.observations[`${PLAN}/tasks/t2`]!.blockedSince).toBe(new Date(T0).toISOString())
  })

  it('a cancelled blocker never unblocks', () => {
    const { next } = step(
      [task('a', { owner: 'sam' }), task('t2', { dependsOn: ['a'] })],
      [task('a', { owner: 'sam', state: 'cancelled' }), task('t2', { dependsOn: ['a'] })],
    )
    expect(next.wakes).toEqual([])
  })

  it('no self-wake: an owner that blocks its own task over blockers already done is not woken at once', () => {
    // t1 done all along; writer rewrites t2 as blocked on it
    const { next } = step(
      [task('t1', { state: 'done' }), task('t2', { state: 'in_progress' })],
      [task('t1', { state: 'done' }), task('t2', { state: 'blocked', dependsOn: ['t1'] })],
    )
    expect(next.wakes).toEqual([])
    // and swapping the blockers for others already done is a new baseline too
    const { next: n2 } = step(
      [task('x', { owner: 'sam' }), task('y', { owner: 'sam', state: 'done' }), task('t2', { dependsOn: ['x'] })],
      [task('x', { owner: 'sam' }), task('y', { owner: 'sam', state: 'done' }), task('t2', { dependsOn: ['y'] })],
    )
    expect(n2.wakes).toEqual([])
  })

  it('a new blocked state after an unblock is a new key — it wakes again when THAT clears', () => {
    const a1 = evaluateTaskWakes({ tasks: [task('a', { owner: 'sam' }), task('t2', { dependsOn: ['a'] })], bound: BOUND, prev: {}, now: T0 })
    const a2 = evaluateTaskWakes({
      tasks: [task('a', { owner: 'sam', state: 'done' }), task('t2', { dependsOn: ['a'] })],
      bound: BOUND,
      prev: a1.observations,
      now: T0 + MIN,
    })
    expect(a2.wakes).toHaveLength(1)
    const a3 = evaluateTaskWakes({
      tasks: [task('a', { owner: 'sam', state: 'done' }), task('c', { owner: 'sam' }), task('t2', { dependsOn: ['a', 'c'] })],
      bound: BOUND,
      prev: a2.observations,
      now: T0 + 2 * MIN,
    })
    expect(a3.wakes).toEqual([])
    const a4 = evaluateTaskWakes({
      tasks: [task('a', { owner: 'sam', state: 'done' }), task('c', { owner: 'sam', state: 'done' }), task('t2', { dependsOn: ['a', 'c'] })],
      bound: BOUND,
      prev: a3.observations,
      now: T0 + 3 * MIN,
    })
    expect(a4.wakes.map((w) => w.key)).toEqual([`unblocked:a,c@${new Date(T0 + 2 * MIN).toISOString()}`])
  })

  it('still waiting on someone (waitingOn) when its blockers clear: no wake — the wait is a blocker too', () => {
    const { next } = step(
      [task('a', { owner: 'sam' }), task('t2', { dependsOn: ['a'], waitingOn: true })],
      [task('a', { owner: 'sam', state: 'done' }), task('t2', { dependsOn: ['a'], waitingOn: true })],
    )
    expect(next.wakes).toEqual([])
  })

  it("children-done: the parent's owner wakes when every direct child is done or cancelled", () => {
    const kids = (s1: string, s2: string) => [
      task('p', { state: 'in_progress' }),
      task('k1', { owner: 'sam', parent: 'p', state: s1 }),
      task('k2', { owner: 'ana', parent: 'p', state: s2 }),
    ]
    const { next } = step(kids('done', 'pending'), kids('done', 'cancelled'))
    expect(next.wakes).toEqual([expect.objectContaining({ task: `${PLAN}/tasks/p`, reason: 'children-done', key: 'children-done:k1,k2' })])
  })

  // the reopen is no longer Task mode's: it happens in
  // the note's own write (silos/actions.ts appendItem) — the evaluation only wakes
  it('owner-note: wakes, whatever the state; it skips the throttle and carries the notes — and asks for no reopen (D17)', () => {
    const note = { at: '2026-11-03T09:01:00Z', by: 'owner', text: 'Use the new rate' }
    for (const state of ['done', 'blocked', 'cancelled', 'in_review'] as const) {
      const { next } = step([task('t1', { state })], [task('t1', { state, notes: [note] })])
      expect(next.wakes).toEqual([expect.objectContaining({ reason: 'owner-note', notes: [note], bypassThrottle: true, says: 'a note from the owner' })])
      expect('reopen' in next).toBe(false)
    }
  })

  it("an agent's note never wakes — nor does the owner's «Dropped:» (a disposition)", () => {
    const { next } = step(
      [task('t1', { state: 'done' })],
      [
        task('t1', {
          state: 'done',
          notes: [
            { at: 'x', by: 'writer', text: 'Reopening this myself' },
            { at: 'y', by: 'finance', text: 'cc @writer' },
          ],
        }),
      ],
    )
    expect(next.wakes).toEqual([])
    const { next: d } = step([task('t1')], [task('t1', { notes: [{ at: 'x', by: 'owner', text: 'Dropped: superseded' }] })])
    expect(d.wakes).toEqual([])
  })

  it("mentions never wake nor assign: a note naming another bound agent wakes only the task's own owner", () => {
    const bound = new Set(['writer', 'finance'])
    const { next } = step([task('t1')], [task('t1', { notes: [{ at: 'x', by: 'owner', text: '@finance please look too' }] })], { bound })
    expect(next.wakes.map((w) => w.agent)).toEqual(['writer'])
  })

  it('next-check: one shot per value — it wakes once when it passes and asks for the field to be cleared', () => {
    const at = new Date(T0 + 5 * MIN).toISOString()
    const a1 = evaluateTaskWakes({ tasks: [task('t1', { nextCheckAt: at, state: 'in_review' })], bound: BOUND, prev: {}, now: T0 })
    expect(a1.wakes).toEqual([])
    const a2 = evaluateTaskWakes({ tasks: [task('t1', { nextCheckAt: at, state: 'in_review' })], bound: BOUND, prev: a1.observations, now: T0 + 6 * MIN })
    expect(a2.wakes).toEqual([expect.objectContaining({ reason: 'next-check', key: `next-check:${at}` })])
    expect(a2.clearCheck).toEqual([`${PLAN}/tasks/t1`])
    // the clear failed and the field is still there: never twice — but the
    // clear is asked again
    const a3 = evaluateTaskWakes({ tasks: [task('t1', { nextCheckAt: at, state: 'in_review' })], bound: BOUND, prev: a2.observations, now: T0 + 7 * MIN })
    expect(a3.wakes).toEqual([])
    expect(a3.clearCheck).toEqual([`${PLAN}/tasks/t1`])
  })

  it('a check already past at the FIRST look (finding 4): recent → it wakes once and is cleared; long past → cleared and said, no wake', () => {
    const at = new Date(T0 + 5 * MIN).toISOString()
    const recent = evaluateTaskWakes({ tasks: [task('t9', { nextCheckAt: at })], bound: BOUND, prev: {}, now: T0 + 9 * MIN })
    expect(recent.wakes).toEqual([expect.objectContaining({ reason: 'next-check', key: `next-check:${at}` })])
    expect(recent.clearCheck).toEqual([`${PLAN}/tasks/t9`])
    expect(recent.staleCheck).toEqual([])
    // the next look never fires it again
    const again = evaluateTaskWakes({ tasks: [task('t9', { nextCheckAt: at })], bound: BOUND, prev: recent.observations, now: T0 + 10 * MIN })
    expect(again.wakes).toEqual([])
    const old = evaluateTaskWakes({ tasks: [task('t9', { nextCheckAt: at })], bound: BOUND, prev: {}, now: T0 + 5 * MIN + CHECK_LATE_MS + 1 })
    expect(old.wakes).toEqual([])
    expect(old.clearCheck).toEqual([`${PLAN}/tasks/t9`])
    expect(old.staleCheck).toEqual([{ key: `${PLAN}/tasks/t9`, at }])
    // a closed task's stale check is left alone
    expect(evaluateTaskWakes({ tasks: [task('t9', { nextCheckAt: at, state: 'done' })], bound: BOUND, prev: {}, now: T0 + 9 * MIN }).clearCheck).toEqual([])
  })

  it('a transition across a restart still wakes: the observations persist', () => {
    const a1 = evaluateTaskWakes({ tasks: [task('a', { owner: 'sam' }), task('t2', { dependsOn: ['a'] })], bound: BOUND, prev: {}, now: T0 })
    const persisted = JSON.parse(JSON.stringify(a1.observations)) as Record<string, Observation>
    expect(
      evaluateTaskWakes({
        tasks: [task('a', { owner: 'sam', state: 'done' }), task('t2', { dependsOn: ['a'] })],
        bound: BOUND,
        prev: persisted,
        now: T0 + 3600_000,
      }).wakes,
    ).toHaveLength(1)
  })

  it('UNBOUND agents: their tasks are not looked at — no observation, no wake, no write', () => {
    const before = [task('a', { owner: 'sam' }), task('t2', { owner: 'ops', dependsOn: ['a'], state: 'done' })]
    const after = [
      task('a', { owner: 'sam', state: 'done' }),
      task('t2', { owner: 'ops', dependsOn: ['a'], state: 'done', notes: [{ at: 'x', by: 'owner', text: 'hey' }], nextCheckAt: '2026-01-01T00:00:00Z' }),
    ]
    const { base, next } = step(before, after)
    expect(base.observations).toEqual({})
    expect(next).toEqual({ observations: {}, wakes: [], clearCheck: [], staleCheck: [] })
  })

  it('an agent leaving task mode forgets its tasks; coming back is a baseline', () => {
    const a1 = evaluateTaskWakes({ tasks: [task('a', { owner: 'sam' }), task('t2', { dependsOn: ['a'] })], bound: BOUND, prev: {}, now: T0 })
    const off = evaluateTaskWakes({
      tasks: [task('a', { owner: 'sam' }), task('t2', { dependsOn: ['a'] })],
      bound: new Set(),
      prev: a1.observations,
      now: T0 + MIN,
    })
    expect(off.observations).toEqual({})
    const back = evaluateTaskWakes({
      tasks: [task('a', { owner: 'sam', state: 'done' }), task('t2', { dependsOn: ['a'] })],
      bound: BOUND,
      prev: off.observations,
      now: T0 + 2 * MIN,
    })
    expect(back.wakes).toEqual([])
  })
})

describe('the no-progress throttle: 2 wakes with no visible change, then 2 min doubling to 30', () => {
  it('counts the streak over the same fingerprint and holds from the 2nd', () => {
    const fp = 'A'
    let s = { lastFp: null as string | null, streak: 0, lastAt: null as string | null }
    const at = (ms: number): string => new Date(ms).toISOString()
    let r = throttle(s, fp, T0)
    expect(r).toEqual({ streak: 0, until: null })
    s = { lastFp: fp, streak: r.streak, lastAt: at(T0) }
    r = throttle(s, fp, T0 + 1000)
    expect(r).toEqual({ streak: 1, until: null })
    s = { lastFp: fp, streak: r.streak, lastAt: at(T0 + 1000) }
    r = throttle(s, fp, T0 + 2000)
    expect(r).toEqual({ streak: 2, until: T0 + 1000 + THROTTLE_BASE_MS })
    // past the wait it goes; the next one waits twice as long
    r = throttle(s, fp, T0 + 1000 + THROTTLE_BASE_MS)
    expect(r.until).toBeNull()
    s = { lastFp: fp, streak: r.streak, lastAt: at(T0 + 1000 + THROTTLE_BASE_MS) }
    expect(throttle(s, fp, Date.parse(s.lastAt!) + 1).until).toBe(Date.parse(s.lastAt!) + 2 * THROTTLE_BASE_MS)
    // capped at 30 min
    expect(throttle({ lastFp: fp, streak: 12, lastAt: at(T0) }, fp, T0 + 1).until).toBe(T0 + THROTTLE_MAX_MS)
    // a visible change resets it
    expect(throttle({ lastFp: fp, streak: 9, lastAt: at(T0) }, 'B', T0 + 1)).toEqual({ streak: 0, until: null })
  })
  it("the fingerprint moves with the task, its blockers' and its children's states — not with an unrelated sibling", () => {
    const sib = [task('a', { owner: 'sam' }), task('k', { parent: 't1' }), task('z', { owner: 'sam' })]
    const t1 = task('t1', { dependsOn: ['a'] })
    const fp = fingerprintOf(t1, [...sib, t1])
    expect(fingerprintOf(t1, [task('a', { owner: 'sam', state: 'done' }), sib[1]!, sib[2]!, t1])).not.toBe(fp)
    expect(fingerprintOf(t1, [sib[0]!, task('k', { parent: 't1', state: 'done' }), sib[2]!, t1])).not.toBe(fp)
    expect(fingerprintOf(t1, [sib[0]!, sib[1]!, task('z', { owner: 'sam', state: 'done' }), t1])).toBe(fp)
    expect(fingerprintOf({ ...t1, notes: [{ at: '', by: 'writer', text: 'x' }] }, [...sib, t1])).not.toBe(fp)
  })
  it('D5: an execution completing a task is progress; a retry that completes nothing is not — so retry wakes hit the backoff', () => {
    const t1 = task('t1')
    // no execution and an empty list read the same (unchanged fingerprint for every task without one)
    expect(fingerprintOf({ ...t1, executionsDone: [] }, [t1])).toBe(fingerprintOf(t1, [t1]))
    const fp = fingerprintOf({ ...t1, executionsDone: [3] }, [t1])
    // a fix round (round, mtime) is not in the snapshot at all: same done → same fingerprint
    expect(fingerprintOf({ ...t1, executionsDone: [3] }, [t1])).toBe(fp)
    expect(fingerprintOf({ ...t1, executionsDone: [4] }, [t1])).not.toBe(fp)
    // order of the executions is not progress
    expect(fingerprintOf({ ...t1, executionsDone: [1, 3] }, [t1])).toBe(fingerprintOf({ ...t1, executionsDone: [3, 1] }, [t1]))
    // the throttle over those fingerprints: three retry wakes with nothing completed → the third waits
    const T0 = Date.parse('2026-11-03T10:00:00Z')
    let s = { lastFp: null as string | null, streak: 0, lastAt: null as string | null }
    for (let i = 0; i < 2; i++) {
      const r = throttle(s, fp, T0 + i)
      s = { lastFp: fp, streak: r.streak, lastAt: new Date(T0 + i).toISOString() }
    }
    expect(throttle(s, fp, T0 + 2).until).not.toBeNull()
    // a task completed in the ledger resets it
    expect(throttle(s, fingerprintOf({ ...t1, executionsDone: [4] }, [t1]), T0 + 2)).toEqual({ streak: 0, until: null })
  })
})

describe('the briefing: scoped to one task, the reason, the notes, the acknowledgement', () => {
  it('a wake says the task, not to switch, why, the new notes and to acknowledge the latest first', () => {
    const b = wakeBriefing(
      task('t4', { title: 'Close the month' }),
      [{ says: 'a note from the owner' }],
      [{ at: '2026-11-03T09:01:00Z', by: 'owner', text: 'Use the new rate' }],
    )
    expect(b).toContain('this turn is about launch#t4 «Close the month»')
    expect(b).toContain("Don't switch tasks")
    expect(b).toContain('Why: a note from the owner.')
    expect(b).toContain('- the owner (2026-11-03T09:01:00Z): Use the new rate')
    expect(b).toContain('Acknowledge the latest note first and say how it changes your next action.')
    expect(b).toContain('/p/plans/launch.plan.json (task t4)')
  })
  it('no notes, no acknowledgement line; a work briefing folds what was waiting; both capped', () => {
    expect(wakeBriefing(task('t4'), [{ says: 'its blockers are done (t3)' }], [])).not.toContain('Acknowledge')
    const w = workBriefing(task('t4', { state: 'in_progress' }), [{ says: 'a note from the owner', notes: [{ at: '', by: 'owner', text: 'ping' }] }])
    expect(w).toContain('The owner opened this conversation to work ONE task — launch#t4')
    expect(w).toContain('Waiting for you on it: a note from the owner.')
    const long = wakeBriefing(
      task('t4'),
      [{ says: 'x' }],
      Array.from({ length: 40 }, (_, i) => ({ at: '', by: 'owner', text: 'y'.repeat(900) + i })),
    )
    expect(long.length).toBeLessThanOrEqual(BRIEFING_MAX)
  })
})

// ── the engine over a real store and a fake plans reading ──

let base: string
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'task-mode-'))
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
const KEY = (id: string): string => `folder:/p/launch/tasks/${id}`

function world(opts: { bound?: string[]; busy?: (s: string) => string | null; conv?: string | null; deliveryOff?: boolean; ready?: () => boolean } = {}) {
  let now = T0
  let tasks: Array<Record<string, unknown>> = []
  const sent: Array<{ agentId: string; text: string; resume: string | null }> = []
  const writes: Array<[string, string, unknown]> = []
  const appended: Array<[string, string]> = []
  let finish: Array<() => void> = []
  let saves = 0
  const store = new TaskModeStore(base, () => {
    saves += 1
  })
  const deps: TaskModeDeps = {
    store,
    plans: () => ({ reading: readingOf(tasks) }),
    bound: () => new Set(opts.bound ?? ['writer']),
    ready: opts.ready ?? (() => true),
    setField: (k, f, v) => {
      writes.push([k, f, v])
      return { ok: true }
    },
    appendConversation: (k, s) => {
      appended.push([k, s])
      return { ok: true }
    },
    conversationOf: (_a, ids) => (opts.conv === null ? null : ids.length > 0 ? { sessionId: ids[ids.length - 1]!, folder: '-p' } : null),
    holdersOf: (_a, ids) => ids,
    busyWhy: (s) => opts.busy?.(s) ?? null,
    send: (i) => {
      sent.push({ agentId: i.agentId, text: i.text, resume: i.resume })
      if (!i.resume) i.onSession('new-session-0001')
      let done!: () => void
      const p = new Promise<void>((r) => {
        done = r
      })
      finish.push(done)
      return { turnId: `turn-${sent.length}`, done: p }
    },
    ...(opts.deliveryOff ? { deliveryOff: true } : {}),
    // the agent's day on its own (own-turns.ts in life): the store's charged wakes
    ownToday: (agent, at) => ({
      used: store.usedToday(agent, localDay(at)),
      costUsd: 0,
      unpriced: 0,
      ceiling: OWN_TURNS_PER_DAY,
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
    writes,
    appended,
    saves: () => saves,
    set: (t: Array<Record<string, unknown>>) => {
      tasks = t
    },
    at: (ms: number) => {
      now = ms
    },
    finishAll: async () => {
      for (const f of finish) f()
      finish = []
      await new Promise((r) => setTimeout(r, 0))
    },
  }
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

describe('the engine: queued, delivered, superseded — never injected mid-turn', () => {
  it('an unblock resumes the (agent, task) conversation with the scoped briefing, and is recorded delivered', async () => {
    const w = world()
    w.set([t('a', { owner: 'sam' }), t('t2', { dependsOn: ['a'], conversations: [{ session: 'sess-t2-0001' }] })])
    w.engine.look()
    w.at(T0 + MIN)
    w.set([t('a', { owner: 'sam', state: 'done' }), t('t2', { dependsOn: ['a'], conversations: [{ session: 'sess-t2-0001' }] })])
    w.engine.look()
    expect(w.sent).toHaveLength(1)
    expect(w.sent[0]).toMatchObject({ agentId: 'writer', resume: 'sess-t2-0001' })
    expect(w.sent[0]!.text).toContain('this turn is about launch#t2')
    expect(w.store.wakes()).toEqual([expect.objectContaining({ state: 'delivered', reason: 'unblocked', session: 'sess-t2-0001', via: 'wake' })])
    // it is a kernel record of the kind task-wake
    expect(w.store.records()[0]!.value).toMatchObject({ state: 'delivered', agent: 'writer', ref: 'launch#t2', updatedBy: 'kernel' })
    // the state lives in Silos' data dir, not in the plan
    expect(JSON.parse(readFileSync(join(base, 'task-mode', 'state.json'), 'utf8')).wakes).toHaveLength(1)
    await w.finishAll()
  })

  it("no conversation yet: a new one, whose id joins the task's conversations[]", () => {
    const w = world({ conv: null })
    w.set([t('a', { owner: 'sam' }), t('t2', { dependsOn: ['a'] })])
    w.engine.look()
    w.set([t('a', { owner: 'sam', state: 'done' }), t('t2', { dependsOn: ['a'] })])
    w.engine.look()
    expect(w.sent[0]!.resume).toBeNull()
    expect(w.appended).toEqual([[KEY('t2'), 'new-session-0001']])
    expect(w.store.wakes()[0]!.session).toBe('new-session-0001')
  })

  it('mid-turn or held by a console: QUEUED with its reason, delivered at the next look once free', () => {
    let busy: string | null = 'a turn is running on its conversation'
    const w = world({ busy: () => busy })
    w.set([t('t1', { state: 'in_progress', conversations: ['sess-0001aaaa'] })])
    w.engine.look()
    w.set([t('t1', { state: 'in_progress', conversations: ['sess-0001aaaa'], notes: [{ at: 'x', by: 'owner', text: 'change of plan' }] })])
    w.engine.look()
    expect(w.sent).toEqual([])
    expect(w.store.queued()).toEqual([
      expect.objectContaining({ reason: 'owner-note', held: 'a turn is running on its conversation — it gets this at its next turn' }),
    ])
    busy = null
    w.engine.deliver()
    expect(w.sent).toHaveLength(1)
    expect(w.sent[0]!.text).toContain('change of plan')
    expect(w.store.queued()).toEqual([])
  })

  it('the task moved on before it could be delivered: superseded, said', () => {
    const w = world({ busy: () => 'a console holds it' })
    w.set([t('a', { owner: 'sam' }), t('t2', { dependsOn: ['a'], conversations: ['sess-0002aaaa'] })])
    w.engine.look()
    w.set([t('a', { owner: 'sam', state: 'done' }), t('t2', { dependsOn: ['a'], conversations: ['sess-0002aaaa'] })])
    w.engine.look()
    w.set([t('a', { owner: 'sam', state: 'done' }), t('t2', { dependsOn: ['a'], state: 'done', conversations: ['sess-0002aaaa'] })])
    w.engine.deliver()
    expect(w.store.wakes()).toEqual([expect.objectContaining({ state: 'superseded', held: 'the task is done already' })])
  })

  it("an owner note on a done task: the wake goes, and Task mode writes nothing — the note's own write reopened it (D17)", () => {
    const w = world()
    w.set([t('t1', { state: 'done' })])
    w.engine.look()
    w.set([t('t1', { state: 'done', notes: [{ at: 'x', by: 'owner', text: 'not quite' }] })])
    w.engine.look()
    expect(w.writes).toEqual([])
    expect(w.sent).toHaveLength(1)
  })

  it('next-check fires once and clears the field through the plans verb', () => {
    const w = world()
    w.set([t('t1', { state: 'in_review', nextCheckAt: new Date(T0 + 5 * MIN).toISOString() })])
    w.engine.look()
    w.at(T0 + 10 * MIN)
    w.engine.look()
    expect(w.writes).toEqual([[KEY('t1'), 'nextCheckAt', null]])
    expect(w.sent).toHaveLength(1)
    w.engine.look()
    expect(w.sent).toHaveLength(1)
  })

  it('the throttle holds a third no-progress wake; an owner note goes through', async () => {
    const w = world()
    // three next-checks in a row over a task that never changes otherwise
    const at = (n: number): string => new Date(T0 + n * MIN).toISOString()
    const row = (n: number, notes: unknown[] = []) => [t('t1', { state: 'in_review', nextCheckAt: at(n), notes })]
    w.set(row(1))
    w.engine.look()
    for (const n of [1, 2, 3]) {
      w.at(T0 + n * MIN + 1)
      w.set(row(n))
      w.engine.look()
      await w.finishAll()
    }
    // the nextCheckAt value differs each time → a visible change: all three go
    expect(w.sent).toHaveLength(3)
    // now the same fingerprint wakes again (an agent note-less child event): use the store directly
    w.store.update((s) => {
      s.throttle[`writer|${KEY('t1')}`] = { lastFp: s.throttle[`writer|${KEY('t1')}`]!.lastFp, streak: 1, lastAt: new Date(T0 + 3 * MIN + 1).toISOString() }
    })
    w.store.update((s) => {
      s.wakes.push({
        id: 'manual-1',
        agent: 'writer',
        task: KEY('t1'),
        ref: 'launch#t1',
        title: 'Task t1',
        reason: 'children-done',
        says: 'x',
        at: new Date(T0 + 3 * MIN + 2).toISOString(),
        state: 'queued',
        notes: [],
        bypassThrottle: false,
      })
    })
    w.engine.deliver(T0 + 3 * MIN + 3)
    expect(w.sent).toHaveLength(3)
    expect(w.store.queued()[0]!.held).toMatch(/started 2 times with no visible change/)
    expect(w.store.queued()[0]!.until).toBe(new Date(T0 + 3 * MIN + 1 + THROTTLE_BASE_MS).toISOString())
    // an owner note skips it
    w.set(row(3, [{ at: 'x', by: 'owner', text: 'go' }]))
    w.engine.look(T0 + 3 * MIN + 4)
    expect(w.sent).toHaveLength(4)
  })

  it("the day's ceiling holds a wake until midnight; an owner note is never held by it", () => {
    const w = world()
    // localDay is local time; the budget matches whatever today is locally
    w.store.update((s) => {
      s.budget.writer = { day: localDay(T0), used: OWN_TURNS_PER_DAY }
    })
    w.set([t('a', { owner: 'sam' }), t('t2', { dependsOn: ['a'] })])
    w.engine.look()
    w.set([t('a', { owner: 'sam', state: 'done' }), t('t2', { dependsOn: ['a'] })])
    w.engine.look()
    expect(w.sent).toEqual([])
    expect(w.store.queued()[0]!.held).toMatch(/times without you today — it waits for tomorrow/)
  })

  it('delivery off (the e2e harness): evaluated and kept, never sent', () => {
    const w = world({ deliveryOff: true })
    w.set([t('t1')])
    w.engine.look()
    w.set([t('t1', { notes: [{ at: 'x', by: 'owner', text: 'hi' }] })])
    w.engine.look()
    expect(w.sent).toEqual([])
    expect(w.store.queued()).toHaveLength(1)
    expect(w.store.queued()[0]!.held).toBeUndefined()
  })

  it('UNBOUND: an agent nobody bound has nothing observed, nothing written, nothing sent — the store stays untouched', () => {
    const w = world({ bound: [] })
    w.set([t('a', { owner: 'sam' }), t('t2', { dependsOn: ['a'], state: 'done' })])
    w.engine.look()
    w.set([t('a', { owner: 'sam', state: 'done' }), t('t2', { dependsOn: ['a'], state: 'done', notes: [{ at: 'x', by: 'owner', text: 'x' }] })])
    w.engine.look()
    expect(w.sent).toEqual([])
    expect(w.writes).toEqual([])
    expect(w.appended).toEqual([])
    expect(() => readFileSync(join(base, 'task-mode', 'state.json'))).toThrow()
  })

  it('«Work on this» folds the waiting wakes into its briefing and marks them delivered via work', () => {
    const w = world({ busy: () => 'a console holds it' })
    w.set([t('t1', { conversations: ['sess-0003aaaa'] })])
    w.engine.look()
    w.set([t('t1', { conversations: ['sess-0003aaaa'], notes: [{ at: 'x', by: 'owner', text: 'look at the invoice' }] })])
    w.engine.look()
    const r = w.engine.work(KEY('t1'))!
    expect(r.briefing).toContain('Waiting for you on it: a note from the owner.')
    expect(r.briefing).toContain('look at the invoice')
    w.engine.markWorked(r.folded, 'sess-0003aaaa')
    expect(w.store.wakes()[0]).toMatchObject({ state: 'delivered', via: 'work', session: 'sess-0003aaaa' })
    // an unbound owner's task (t6): its briefing too, nothing folded in
    const u = world({ bound: [] })
    u.set([t('t1')])
    const ur = u.engine.work(KEY('t1'))!
    expect(ur.briefing).toContain('The owner opened this conversation to work ONE task')
    expect(ur.folded).toEqual([])
    expect(u.engine.work(KEY('nope'))).toBeNull()
  })

  it('an owner note on a CANCELLED task: the wake goes with it; Task mode writes no reopen (D17)', () => {
    const w = world()
    w.set([t('t1', { state: 'cancelled' })])
    w.engine.look()
    w.set([t('t1', { state: 'cancelled', notes: [{ at: 'x', by: 'owner', text: 'we need this after all' }] })])
    w.engine.look()
    expect(w.writes).toEqual([])
    expect(w.sent).toHaveLength(1)
    expect(w.sent[0]!.text).toContain('we need this after all')
  })

  it('the index not warm yet (right after boot): nothing is sent — no new conversation opened — the wake waits; the supersede pass still runs', () => {
    let ready = false
    const w = world({ ready: () => ready, conv: null })
    w.set([t('t1', { conversations: ['sess-held-0001'] }), t('t2')])
    w.engine.look()
    w.set([
      t('t1', { conversations: ['sess-held-0001'], notes: [{ at: 'x', by: 'owner', text: 'one' }] }),
      t('t2', { notes: [{ at: 'x', by: 'owner', text: 'two' }] }),
    ])
    w.engine.look()
    expect(w.sent).toEqual([])
    expect(w.appended).toEqual([])
    expect(w.store.queued()).toHaveLength(2)
    // t2 moves to someone else meanwhile: superseded even while not ready
    w.set([
      t('t1', { conversations: ['sess-held-0001'], notes: [{ at: 'x', by: 'owner', text: 'one' }] }),
      t('t2', { owner: 'sam', notes: [{ at: 'x', by: 'owner', text: 'two' }] }),
    ])
    w.engine.deliver()
    expect(w.store.wakes().find((x) => x.task === KEY('t2'))).toMatchObject({ state: 'superseded' })
    expect(w.sent).toEqual([])
    ready = true
    w.engine.deliver()
    expect(w.sent).toHaveLength(1)
    expect(w.store.queued()).toEqual([])
  })

  it("ANY of the task's conversations busy holds the wake — a console just opened by «Work on this» is not the one a wake would resume", () => {
    // the index still resolves the older conversation; the new console (not
    // indexed yet) is the one a console holds
    const w = world({ busy: (s) => (s === 'sess-new-console' ? 'a console has its conversation open' : null) })
    w.set([t('t1', { conversations: ['sess-new-console', 'sess-old-0001'] })])
    w.engine.look()
    w.set([t('t1', { conversations: ['sess-new-console', 'sess-old-0001'], notes: [{ at: 'x', by: 'owner', text: 'hi' }] })])
    w.engine.look()
    expect(w.sent).toEqual([])
    expect(w.store.queued()[0]!.held).toBe('a console has its conversation open — it gets this at its next turn')
  })

  it('a look that sees nothing new writes nothing (seenAt alone is no change) — until the seen moment goes stale', () => {
    const w = world()
    w.set([t('a', { owner: 'sam' }), t('t2', { dependsOn: ['a'] })])
    w.engine.look()
    const after = w.saves()
    expect(after).toBeGreaterThan(0)
    for (const n of [1, 2, 3]) {
      w.at(T0 + n * 30_000)
      w.engine.look()
    }
    expect(w.saves()).toBe(after)
    // in memory it is current all the same
    expect(w.store.observations()[KEY('t2')]!.seenAt).toBe(new Date(T0 + 90_000).toISOString())
    // a real change writes
    w.set([
      t('a', { owner: 'sam' }),
      t('t2', { dependsOn: ['a'], notes: [{ at: 'x', by: 'writer', text: 'progress' }], parent: null }),
      t('k', { owner: 'sam', parent: 't2' }),
    ])
    w.at(T0 + 120_000)
    w.engine.look()
    expect(w.saves()).toBe(after + 1)
    // and a seenAt older than SEEN_REFRESH_MS on disk is refreshed
    const s1 = w.saves()
    w.at(T0 + 120_000 + SEEN_REFRESH_MS)
    w.engine.look()
    expect(w.saves()).toBe(s1 + 1)
  })

  it('a corrupt state file is set aside and task mode starts from a baseline', () => {
    const dir = join(base, 'task-mode')
    new TaskModeStore(base) // creates the dir
    writeFileSync(join(dir, 'state.json'), '{nope')
    const s = new TaskModeStore(base)
    expect(s.wakes()).toEqual([])
  })
})

describe('view.heldNow — what would hold a wake, said BEFORE the owner sends (t1/P4)', () => {
  it('an open console on a task conversation shows as heldNow; nothing busy → null', () => {
    const w = world({ busy: (s) => (s === 'c-open' ? 'a console has its conversation open' : null) })
    w.set([t('x', { conversations: [{ session: 'c-open' }] }), t('y', { conversations: [{ session: 'c-free' }] })])
    expect(w.engine.view(KEY('x'))?.heldNow).toBe('a console has its conversation open')
    expect(w.engine.view(KEY('y'))?.heldNow).toBeNull()
  })
})

describe('openTalk — the chat-lane twin of Work on this (t3)', () => {
  it('an UNBOUND agent gets its turn too: the briefing goes out, a NEW conversation joins the task at once', async () => {
    const w = world({ bound: [], conv: null })
    w.set([t('x')])
    const r = await w.engine.openTalk(KEY('x'))
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.agent).toBe('writer')
      expect(r.isNew).toBe(true)
      expect(r.sessionId).toBe('new-session-0001')
    }
    expect(w.sent).toHaveLength(1)
    expect(w.sent[0]!.resume).toBeNull()
    expect(w.appended).toEqual([[KEY('x'), 'new-session-0001']])
  })
  it('resumes the existing thread, and a busy thread answers 409 naming the why', async () => {
    const w = world({ busy: (s) => (s === 'c1' ? 'a console has its conversation open' : null) })
    w.set([t('x', { conversations: [{ session: 'c0' }] }), t('b', { conversations: [{ session: 'c1' }] })])
    const r = await w.engine.openTalk(KEY('x'))
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.isNew).toBe(false)
      expect(r.sessionId).toBe('c0')
    }
    expect(w.sent[0]!.resume).toBe('c0')
    const busy = await w.engine.openTalk(KEY('b'))
    expect(busy.ok).toBe(false)
    if (!busy.ok) {
      expect(busy.code).toBe(409)
      expect(busy.reason).toContain('a console has its conversation open')
    }
  })
})
