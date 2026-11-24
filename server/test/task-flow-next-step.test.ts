// task-flow-next-step.test.ts — the kernel rules of «every open task has a
// next step»: each rule with its sequence, over the ONE flow function
// (silos/task-flow.ts) and the readers that must say the same.
import { describe, expect, it } from 'vitest'
import { dictionaryForKind, evaluate, parse, type FieldDict } from '../src/silos/expressions.js'
import { taskFlow, type TaskEnv } from '../src/silos/task-flow.js'
import { envFor, holds, kindsOf, taskFlowRecords, type KindRecord } from '../src/silos/voice.js'
import { turnOf } from '../src/silos/turn.js'
import { taskSnapshots } from '../src/task-mode/engine.js'
import type { TaskSnap } from '../src/task-mode/evaluate.js'
import { heartbeatFacts } from '../src/heartbeat-facts.js'
import type { SiloReading } from '../src/silos/reader.js'
import type { Agent } from '../src/types.js'

type Json = Record<string, any>
const NOW = Date.parse('2026-11-03T12:00:00Z')
const AGENTS = new Set(['writer', 'finance', 'builder'])
const isAgent = (v: string): boolean => AGENTS.has(v)
const STATES = ['pending', 'in_progress', 'in_review', 'blocked', 'done', 'cancelled']

function taskSpec(): Json {
  return {
    path: 'tasks[]',
    envelope: {
      id: { field: 'id' },
      identity: { template: '{{title}}' },
      state: { field: 'status' },
      at: { inherit: 'parent.at' },
      updatedBy: { absent: 'unknown' },
    },
    states: STATES.map((v) => ({ value: v, label: { one: v, many: v }, ...(v === 'done' || v === 'cancelled' ? { terminal: true } : {}) })),
    roles: { task: { owner: 'owner', dependsOn: 'dependsOn', waitingOn: 'waitingOn', nextCheckAt: 'nextCheckAt', conversations: 'conversations' } },
    fields: {
      owner: { type: 'actor', required: true },
      dependsOn: { type: 'refs(task)', withinParent: true },
      waitingOn: { type: 'string', optional: true },
      nextCheckAt: { type: 'timestamp', optional: true },
    },
  }
}
function planSpec(): Json {
  return {
    envelope: {
      id: { from: 'filename' },
      identity: { template: '{{title}}' },
      state: { computed: 'all(tasks, state in [done, cancelled]) ? done : active' },
      at: { field: 'updatedAt' },
    },
    states: [
      { value: 'active', label: { one: 'active', many: 'active' } },
      { value: 'done', label: { one: 'done', many: 'done' }, terminal: true },
    ],
    fields: { title: { type: 'string' }, updatedAt: { type: 'timestamp' } },
    subKinds: { task: taskSpec() },
  }
}
const taskDict = (): FieldDict => dictionaryForKind('plan', planSpec()).dict.collections.tasks!
const T = (id: string, owner: string, state: string, dependsOn: string[] = [], over: Json = {}): Json => ({
  id,
  owner,
  state,
  dependsOn,
  conversations: [],
  ...over,
})
const flowOf = (id: string, tasks: Json[], te: Partial<TaskEnv> = {}, key?: string) =>
  taskFlow(
    tasks.find((t) => t.id === id)!,
    tasks,
    taskDict(),
    { now: NOW, isAgent, taskEnv: { isLive: () => false, wakes: () => 'never', ...te }, ...(key ? { key } : {}) },
  )

describe('envFor passes the key: `idle` as a predicate sees the wakes queued for THIS task, as flowOf does', () => {
  it('a wake queued for the same id in ANOTHER plan no longer hides the task from the predicate', () => {
    const info = kindsOf({ spec: { kinds: { plan: planSpec() } } }).get('plan/task')!
    const tasks = [T('a', 'writer', 'pending')]
    const kr: KindRecord = { rec: tasks[0]!, anchors: {}, key: 'folder:/w/p/tasks/a', file: null, parent: { id: 'p' }, siblings: tasks }
    const asked: Array<string | null> = []
    // the only wake on its way is for `a` of another plan
    const taskEnv: TaskEnv = {
      isLive: () => false,
      wakes: () => 'task',
      wakeOnTheWay: (q) => {
        asked.push(q.key)
        return q.key === null ? true : q.key === 'folder:/w/other/tasks/a'
      },
    }
    expect(holds('idle', info, kr, { now: NOW, isAgent, taskEnv })).toBe(true)
    expect(asked).toEqual(['folder:/w/p/tasks/a'])
    // …and a wake queued for THIS key hides it
    const mine: TaskEnv = { ...taskEnv, wakeOnTheWay: (q) => q.key === 'folder:/w/p/tasks/a' }
    expect(holds('idle', info, kr, { now: NOW, isAgent, taskEnv: mine })).toBe(false)
  })
  it("a nested reading never borrows the key: a plan-level all(tasks, idle) asks each task by its id, not by the plan's key", () => {
    const info = kindsOf({ spec: { kinds: { plan: planSpec() } } }).get('plan')!
    const tasks = [T('a', 'writer', 'pending')]
    const kr: KindRecord = { rec: { id: 'p', tasks }, anchors: {}, key: 'folder:/w/p', file: null }
    const asked: Array<string | null> = []
    const ast = parse('all(tasks, idle)', 'computed')
    if (!ast.ok) throw new Error('the aggregator does not parse')
    const v = evaluate(
      ast.ast,
      kr.rec,
      envFor(info, kr, {
        now: NOW,
        isAgent,
        taskEnv: {
          isLive: () => false,
          wakes: () => 'task',
          wakeOnTheWay: (q) => {
            asked.push(q.key)
            return false
          },
        },
      }),
    )
    expect(v).toBe(true)
    expect(asked).toEqual([null])
  })
})

describe('blocked, its declared dependencies all done, no wait, no check ahead: it reads as pending', () => {
  const done = T('b', 'finance', 'done')
  const unblocked = (over: Json = {}): Json[] => [T('a', 'writer', 'blocked', ['b'], over), done]
  it("own(): never «blocked naming nothing» — a told agent's is the owner's to start, a task-mode agent's is idle", () => {
    expect(flowOf('a', unblocked(), { wakes: () => 'never' })).toMatchObject({ stalled: false, stalledCause: null, waitsStart: true, idle: false })
    expect(flowOf('a', unblocked(), { wakes: () => 'task' })).toMatchObject({ stalled: false, waitsStart: false, idle: true })
    // a told agent that can't be started: owner-cannot-run, as a pending one
    expect(flowOf('a', unblocked(), { wakes: () => 'never', startable: () => false })).toMatchObject({ stalled: true, stalledCause: 'owner-cannot-run' })
  })
  it('a blocked task that declares neither a dependency nor a wait is blocked-on-nothing (A2.4 — blocker-unowned is retired)', () => {
    expect(flowOf('a', [T('a', 'writer', 'blocked')], { wakes: () => 'never' })).toMatchObject({
      stalled: true,
      stalledCause: 'blocked-on-nothing',
      stalledBy: 'a',
      stalledAt: 'a',
    })
  })
  it('anything that still holds it keeps it blocked: an open or missing dependency, a wait, a check ahead', () => {
    expect(flowOf('a', [T('a', 'writer', 'blocked', ['b']), T('b', 'finance', 'pending')], { wakes: () => 'task' }).idle).toBe(false)
    expect(flowOf('a', [T('a', 'writer', 'blocked', ['ghost'])], { wakes: () => 'never' })).toMatchObject({
      waitsStart: false,
      stalledCause: 'blocker-missing',
      stalledBy: 'ghost',
      stalledAt: 'a',
    })
    expect(flowOf('a', unblocked({ waitingOn: { owner: 'owner', action: 'decide' } }), { wakes: () => 'never' }).waitsStart).toBe(false)
    expect(flowOf('a', unblocked({ nextCheckAt: '2026-11-09T09:00:00Z' }), { wakes: () => 'task' }).idle).toBe(false)
  })
  it('the turn sentence reads it as pending too (silos/turn.ts): it opens with the owner, or it is yours — never «waits on a task its plan no longer has»', () => {
    const v = { now: NOW, isAgent, taskEnv: { isLive: () => false, wakes: () => 'never' as const }, nameOf: (id: string) => (id === 'writer' ? 'Writer' : id) }
    const tasks = unblocked()
    expect(turnOf(tasks[0]!, tasks, taskDict(), (id) => `p#${id}`, v)).toEqual({ kind: 'start', sentence: 'Not started — it opens with Writer and you.' })
    const mine = [T('a', 'owner', 'blocked', ['b']), done]
    expect(turnOf(mine[0]!, mine, taskDict(), (id) => `p#${id}`, v)?.kind).toBe('yours')
  })
})

describe('a past nextCheckAt guards only a bound owner (Task mode fires or clears it)', () => {
  const PAST = '2026-11-01T09:00:00Z'
  const FUTURE = '2026-11-09T09:00:00Z'
  it("a bound agent's past check still guards its in-progress task: no stall", () => {
    expect(flowOf('a', [T('a', 'writer', 'in_progress', [], { nextCheckAt: PAST })], { wakes: () => 'task' })).toMatchObject({ stalled: false })
  })
  it("a told agent's past check is nobody's: the task opens with the owner (startable) or its owner cannot run", () => {
    for (const state of ['pending', 'in_progress']) {
      expect(flowOf('a', [T('a', 'writer', state, [], { nextCheckAt: PAST })], { wakes: () => 'never' })).toMatchObject({ stalled: false, waitsStart: true })
      expect(flowOf('a', [T('a', 'writer', state, [], { nextCheckAt: PAST })], { wakes: () => 'never', startable: () => false })).toMatchObject({
        stalled: true,
        stalledCause: 'owner-cannot-run',
        waitsStart: false,
      })
    }
  })
  it("a check still ahead keeps guarding any agent's task; a person's with no open dependency stays ok; a task nobody owns with a past check is unowned (E3 amends A1.4)", () => {
    expect(flowOf('a', [T('a', 'writer', 'in_progress', [], { nextCheckAt: FUTURE })], { wakes: () => 'never' })).toMatchObject({
      stalled: false,
      waitsStart: false,
    })
    expect(flowOf('a', [T('a', 'sam', 'in_progress', [], { nextCheckAt: PAST })], { wakes: () => 'never' })).toMatchObject({
      stalled: false,
      waitsStart: false,
    })
    expect(flowOf('a', [T('a', '', 'pending', [], { nextCheckAt: PAST })], { wakes: () => 'never' })).toMatchObject({
      stalled: true,
      stalledCause: 'unowned',
      stalledAt: 'a',
    })
    expect(flowOf('a', [T('a', '', 'pending', [], { nextCheckAt: FUTURE })], { wakes: () => 'never' })).toMatchObject({ stalled: false })
  })
  it("a blocker whose told owner's check passed parks the task waiting on it, by it (the one to fix: its start)", () => {
    const tasks = [T('a', 'finance', 'blocked', ['b']), T('b', 'writer', 'pending', [], { nextCheckAt: PAST })]
    expect(flowOf('a', tasks, { wakes: (x) => (x === 'finance' ? 'task' : 'never') })).toMatchObject({
      stalled: true,
      stalledCause: 'blocker-parked',
      stalledBy: 'b',
      stalledAt: 'b',
    })
  })
})

describe('ready and nobody on it: no conversation of it LIVE (the same reading own() makes)', () => {
  const task = { wakes: () => 'task' as const }
  const withConv = [T('a', 'writer', 'pending', [], { conversations: [{ id: 's1' }] })]
  it('a current conversation that stopped moving is nobody on it: idle; a live one is someone on it', () => {
    expect(flowOf('a', withConv, task)).toMatchObject({ idle: true, live: false, currentConversations: ['s1'] })
    expect(flowOf('a', withConv, { ...task, isLive: (s) => s === 's1' })).toMatchObject({ idle: false, live: true })
    // …and the THREAD's live tip counts (a /clear descendant nobody listed)
    expect(flowOf('a', withConv, { ...task, threadLive: (ids) => ids.includes('s1') })).toMatchObject({ idle: false, live: true })
  })
  it('the rest of the rule is unchanged: pending, deps done, no wait, a task-mode owner, no wake on its way', () => {
    expect(flowOf('a', [T('a', 'writer', 'in_progress', [], { conversations: [{ id: 's1' }] })], task).idle).toBe(false)
    expect(flowOf('a', withConv, { wakes: () => 'never' }).idle).toBe(false)
    expect(flowOf('a', withConv, { ...task, wakeOnTheWay: () => true }).idle).toBe(false)
  })
  it('flow.idle, flow.waitsStart and flow.live travel to Task mode with the stall (voice.taskFlowRecords → TaskSnap)', () => {
    const m = { spec: { kinds: { plan: planSpec() } } }
    const base: KindRecord[] = [
      {
        rec: { id: 'p', tasks: [T('a', 'writer', 'pending', [], { conversations: [{ id: 's1' }] }), T('b', 'builder', 'in_progress')] },
        anchors: {},
        key: 'folder:/w/p',
        file: null,
      },
    ]
    const facts = taskFlowRecords(m, base, { now: NOW, isAgent, taskEnv: { isLive: () => false, wakes: (x) => (x === 'writer' ? 'task' : 'never') } })
    expect(facts.get('folder:/w/p/tasks/a')).toEqual({ cause: null, by: null, at: null, idle: true, waitsStart: false, live: false, asked: false })
    expect(facts.get('folder:/w/p/tasks/b')).toEqual({ cause: null, by: null, at: null, idle: false, waitsStart: true, live: false, asked: false })
    const reading = {
      records: [
        {
          silo: 'plans',
          kind: 'plan',
          source: 'plans',
          file: '/w/plans/p.plan.json',
          rel: 'p.plan.json',
          location: 'folder:/w',
          anchors: {},
          mtimeMs: 0,
          raw: {},
          record: { id: 'p', title: 'P', tasks: [{ id: 'a', title: 'A', owner: 'writer', state: 'pending', conversations: ['s1'] }] },
          remarks: [],
          partial: [],
        },
      ],
      unreadable: [],
      problems: [],
      sources: {},
      lastWrite: null,
      truncated: [],
    } as unknown as SiloReading
    expect(taskSnapshots(reading, facts)[0]).toMatchObject({ key: 'folder:/w/p/tasks/a', idle: true, waitsStart: false, live: false, stalledCause: null })
  })
  it("the heartbeat's «yours» READS idle — never a task with an open dependency, a live conversation or a wake on its way", () => {
    const snap = (id: string, idle: boolean): TaskSnap => ({
      key: `folder:/w/p/tasks/${id}`,
      planKey: 'folder:/w/p',
      planId: 'p',
      id,
      ref: `p#${id}`,
      title: id,
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
      current: [],
      file: null,
      folder: '/w',
      idle,
    })
    const f = heartbeatFacts(
      { automations: { list: () => [], listRuns: () => [] } as never, tasks: () => [snap('a', true), snap('b', false)], nameOf: (x) => x },
      { id: 'writer', name: 'Writer' } as Agent,
      0,
      NOW,
    )
    expect(f.yours.map((y) => y.key)).toEqual(['folder:/w/p/tasks/a'])
  })
  it("the heartbeat's «waits» READ flow.asked: a wait on an agent Silos carries is marked carried, the relay is not", () => {
    const snap = (id: string, asked: boolean): TaskSnap => ({
      key: `folder:/w/p/tasks/${id}`,
      planKey: 'folder:/w/p',
      planId: 'p',
      id,
      ref: `p#${id}`,
      title: id,
      owner: 'writer',
      state: 'blocked',
      dependsOn: [],
      parent: null,
      nextCheckAt: null,
      waitingOn: true,
      waitingFor: { owner: 'builder', action: 'review it' },
      stalledCause: null,
      stalledBy: null,
      stalledAt: null,
      notes: [],
      conversations: [],
      current: [],
      file: null,
      folder: '/w',
      asked,
    })
    const f = heartbeatFacts(
      { automations: { list: () => [], listRuns: () => [] } as never, tasks: () => [snap('a', true), snap('b', false)], nameOf: (x) => x },
      { id: 'writer', name: 'Writer' } as Agent,
      0,
      NOW,
    )
    expect(f.waits.map((w) => [w.key, w.carried === true])).toEqual([
      ['folder:/w/p/tasks/a', true],
      ['folder:/w/p/tasks/b', false],
    ])
  })
})

describe("a wait on an agent is, for now, the owner's to relay: waitsOnRelay, never waitsOnHuman", () => {
  const wait = (owner: string, action = 'deploy it'): Json => ({ waitingOn: { owner, action } })
  it("an agent of any kind — bound, told, the task's own owner — names a relay; the task stays guarded", () => {
    for (const te of [{ wakes: () => 'task' as const }, { wakes: () => 'never' as const }]) {
      expect(flowOf('a', [T('a', 'writer', 'blocked', [], wait('builder'))], te)).toMatchObject({
        waitsOnRelay: true,
        waitsOnHuman: false,
        stalled: false,
        waiting: true,
      })
    }
    expect(flowOf('a', [T('a', 'writer', 'blocked', [], wait('writer'))])).toMatchObject({ waitsOnRelay: true, waitsOnHuman: false })
    // an in-progress task can wait on an agent too
    expect(flowOf('a', [T('a', 'writer', 'in_progress', [], wait('finance'))]).waitsOnRelay).toBe(true)
  })
  it("never Silos' own wait (the escalation's «unstick …»), never on the owner, never on a closed task", () => {
    expect(flowOf('a', [T('a', 'writer', 'blocked', [], wait('finance', 'unstick p#a'))]).waitsOnRelay).toBe(false)
    expect(flowOf('a', [T('a', 'writer', 'blocked', [], wait('owner'))])).toMatchObject({ waitsOnRelay: false, waitsOnHuman: true })
    expect(flowOf('a', [T('a', 'writer', 'done', [], wait('builder'))]).waitsOnRelay).toBe(false)
    expect(flowOf('a', [T('a', 'writer', 'pending')]).waitsOnRelay).toBe(false)
  })
  it('a predicate can read it: the dictionary declares it', () => {
    const info = kindsOf({ spec: { kinds: { plan: planSpec() } } }).get('plan/task')!
    expect(info.dict.fields.waitsOnRelay).toEqual({ type: 'boolean' })
    const tasks = [T('a', 'writer', 'blocked', [], wait('builder'))]
    expect(holds('waitsOnRelay', info, { rec: tasks[0]!, anchors: {}, key: 'k/a', file: null, siblings: tasks } as KindRecord, { now: NOW, isAgent })).toBe(
      true,
    )
  })
})
