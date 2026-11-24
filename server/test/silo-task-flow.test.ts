// The kernel's task flow (plans phase 1, G3+G4): a sub-kind declaring
// roles.task gets waiting, gate, stalled, stalledCause and stalledBy computed
// by ONE kernel function — at request time, with the live facts injected
// (isLive, wakes). Every cause, the walk naming the FIRST stuck task, cycles,
// nextCheckAt past/future and a walk with no depth cap (A2.7).
import { describe, expect, it } from 'vitest'
import { dictionaryForKind, evaluate, parse, validateDictionary, type EvalEnv, type FieldDict } from '../src/silos/expressions.js'
import { STALLED_CAUSES, taskFlow, type TaskEnv } from '../src/silos/task-flow.js'
import { holds, kindsOf, sayRow, type KindRecord } from '../src/silos/voice.js'

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
    computed: { ready: 'state in [pending, in_progress, blocked] and all(dependsOn, state = done) and waiting = false' },
    subKinds: {
      conversation: {
        path: 'conversations[]',
        envelope: { id: { field: 'session' }, identity: { template: '{{session}}' } },
        fields: { session: { type: 'string', required: true } },
      },
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

// a task as the reader normalizes it: state, id, owner, deps, conversations
const T = (id: string, owner: string, state: string, dependsOn: string[] = [], over: Json = {}): Json => ({
  id,
  owner,
  state,
  dependsOn,
  conversations: [],
  ...over,
})
const env = (te: Partial<TaskEnv> = {}): { now: number; isAgent: (v: string) => boolean; taskEnv: TaskEnv } => ({
  now: NOW,
  isAgent,
  taskEnv: { isLive: () => false, wakes: () => 'now', ...te },
})
const flowOf = (id: string, tasks: Json[], te: Partial<TaskEnv> = {}) =>
  taskFlow(
    tasks.find((t) => t.id === id)!,
    tasks,
    taskDict(),
    env(te),
  )

describe('the dictionary of a sub-kind with roles.task', () => {
  it('declares the kernel-computed names, typed; validates; refuses a role naming an undeclared field', () => {
    const d = taskDict()
    expect(d.task).toEqual({ owner: 'owner', dependsOn: 'dependsOn', waitingOn: 'waitingOn', nextCheckAt: 'nextCheckAt', conversations: 'conversations' })
    expect(d.fields.waiting).toEqual({ type: 'boolean' })
    expect(d.fields.gate).toEqual({ type: 'boolean' })
    expect(d.fields.stalled).toEqual({ type: 'boolean' })
    expect(d.fields.stalledCause).toEqual({ type: 'string', values: [...STALLED_CAUSES] })
    expect(d.fields.stalledBy).toEqual({ type: 'string' })
    expect(validateDictionary(dictionaryForKind('plan', planSpec()).dict)).toEqual([])
    const bad = planSpec()
    bad.subKinds.task.roles.task.waitingOn = 'nope'
    const { issues } = dictionaryForKind('plan', bad)
    expect(issues.map((i) => i.message)).toEqual(['roles.task.waitingOn names nope, which plan/task does not declare'])
  })
})

describe('waiting', () => {
  it('a waitingOn with an owner, or a nextCheckAt still ahead, is waiting; a past or invalid nextCheckAt is not', () => {
    expect(flowOf('a', [T('a', 'writer', 'blocked', [], { waitingOn: { owner: 'sam', action: 'sign' } })]).waiting).toBe(true)
    expect(flowOf('a', [T('a', 'writer', 'blocked', [], { waitingOn: { action: 'no owner' } })]).waiting).toBe(false)
    expect(flowOf('a', [T('a', 'writer', 'pending', [], { nextCheckAt: '2026-11-04T09:00:00Z' })]).waiting).toBe(true)
    expect(flowOf('a', [T('a', 'writer', 'pending', [], { nextCheckAt: '2026-11-01T09:00:00Z' })]).waiting).toBe(false)
    expect(flowOf('a', [T('a', 'writer', 'pending', [], { nextCheckAt: 'tomorrow' })]).waiting).toBe(false)
  })
  it('ready = an open state, every dependency done, and not waiting — evaluated through the dictionary', () => {
    const d = taskDict()
    const ready = parse('ready')
    if (!ready.ok) throw new Error('parse')
    const tasks = [
      T('a', 'writer', 'done'),
      T('b', 'writer', 'blocked', ['a']),
      T('c', 'writer', 'in_progress', ['a'], { nextCheckAt: '2026-11-05' }),
      T('d', 'writer', 'in_review'),
      T('e', 'writer', 'pending', ['x']),
    ]
    const e = (_t: Json): EvalEnv => ({ now: NOW, dict: d, siblings: tasks, isAgent })
    expect(tasks.map((t) => evaluate(ready.ast, t, e(t)))).toEqual([false, true, false, false, false])
  })
})

describe('gate', () => {
  it("a task an agent's open task waits on directly — not when that task is done, cancelled or a human's", () => {
    expect(flowOf('h', [T('h', 'sam', 'pending'), T('a', 'writer', 'blocked', ['h'])]).gate).toBe(true)
    expect(flowOf('h', [T('h', 'sam', 'pending'), T('a', 'writer', 'done', ['h'])]).gate).toBe(false)
    expect(flowOf('h', [T('h', 'sam', 'pending'), T('a', 'writer', 'cancelled', ['h'])]).gate).toBe(false)
    expect(flowOf('h', [T('h', 'sam', 'pending'), T('a', 'ana', 'blocked', ['h'])]).gate).toBe(false)
    expect(flowOf('h', [T('h', 'sam', 'pending'), T('a', 'writer', 'blocked', ['z'])]).gate).toBe(false)
  })
  it("unblocks: WHICH open agent tasks wait on it directly, each with its owner, in the plan's order — gate is exactly «some»", () => {
    const tasks = [
      T('h', 'sam', 'pending'),
      T('a', 'writer', 'blocked', ['h']),
      T('b', 'finance', 'pending', ['h', 'x']),
      T('c', 'writer', 'done', ['h']),
      T('d', 'ana', 'blocked', ['h']),
      T('e', 'writer', 'pending', ['h']),
    ]
    const f = flowOf('h', tasks)
    expect(f.unblocks).toEqual([
      { id: 'a', owner: 'writer' },
      { id: 'b', owner: 'finance' },
      { id: 'e', owner: 'writer' },
    ])
    expect(f.gate).toBe(true)
    expect(flowOf('a', tasks).unblocks).toEqual([])
  })
})

describe('the gate row says WHAT finishing it unblocks (native parity: «unblocks 1 task of E2E»)', () => {
  const kinds = kindsOf({ spec: { kinds: { plan: planSpec() } } })
  const info = kinds.get('plan/task')!
  const names: Record<string, string> = { writer: 'Writer', finance: 'Finance' }
  const row = (id: string, tasks: Json[], nameOf?: (a: string) => string): string => {
    const rec = { ...tasks.find((t) => t.id === id)!, identity: `Task ${id}`, stateLabel: { one: 'pending' } }
    return sayRow(info, { rec, anchors: {}, key: `k/${id}`, file: null, siblings: tasks } as KindRecord, { now: NOW, isAgent, ...(nameOf ? { nameOf } : {}) })
  }
  it('one task of one agent, by its name', () => {
    expect(row('h', [T('h', 'owner', 'pending'), T('a', 'writer', 'blocked', ['h'])], (a) => names[a] ?? a)).toBe(
      'Task h — pending · unblocks 1 task of Writer',
    )
  })
  it('a person other than the owner holds it: said as theirs («you» is only the owner — E8)', () => {
    expect(row('h', [T('h', 'sam', 'pending'), T('a', 'writer', 'blocked', ['h'])], (a) => names[a] ?? a)).toBe(
      "sam's Task h — pending · unblocks 1 task of Writer",
    )
    expect(row('h', [T('h', 'sam', 'pending'), T('a', 'writer', 'blocked', ['h'])], (a) => (a === 'sam' ? 'Sam' : (names[a] ?? a)))).toBe(
      "Sam's Task h — pending · unblocks 1 task of Writer",
    )
  })
  it("several, grouped per agent in the plan's order", () => {
    const tasks = [T('h', 'owner', 'pending'), T('a', 'writer', 'blocked', ['h']), T('b', 'finance', 'pending', ['h']), T('e', 'writer', 'pending', ['h'])]
    expect(row('h', tasks, (a) => names[a] ?? a)).toBe('Task h — pending · unblocks 2 tasks of Writer and 1 of Finance')
  })
  it('no name to say: the agent id; nothing waiting: no clause at all', () => {
    expect(row('h', [T('h', 'owner', 'pending'), T('a', 'builder', 'blocked', ['h'])])).toBe('Task h — pending · unblocks 1 task of builder')
    expect(row('h', [T('h', 'owner', 'pending'), T('a', 'builder', 'done', ['h'])])).toBe('Task h — pending')
  })
})

describe('waits on a human: a declared waitingOn naming a person admits the task into Needs you', () => {
  it("waitsOn carries the file's words; waitsOnHuman only for a person on an open task", () => {
    const f = flowOf('a', [T('a', 'writer', 'blocked', [], { waitingOn: { owner: 'owner', action: 'Decide: (A) resume or (B) park' } })])
    expect(f.waitsOn).toEqual({ owner: 'owner', action: 'Decide: (A) resume or (B) park' })
    expect(f.waitsOnHuman).toBe(true)
    // an in-progress task can wait on a person too (waitingOn rides beside status)
    expect(flowOf('a', [T('a', 'writer', 'in_progress', [], { waitingOn: { owner: 'sam', action: 'sign' } })]).waitsOnHuman).toBe(true)
    // an agent is not a human: the wake machinery owns that wait, not the inbox
    expect(flowOf('a', [T('a', 'writer', 'blocked', [], { waitingOn: { owner: 'builder', action: 'deploy' } })]).waitsOnHuman).toBe(false)
    expect(flowOf('a', [T('a', 'writer', 'pending')]).waitsOn).toBe(null)
    expect(flowOf('a', [T('a', 'writer', 'pending')]).waitsOnHuman).toBe(false)
    expect(flowOf('a', [T('a', 'writer', 'blocked', [], { waitingOn: { action: 'no owner' } })]).waitsOnHuman).toBe(false)
    expect(flowOf('a', [T('a', 'writer', 'done', [], { waitingOn: { owner: 'owner', action: 'x' } })]).waitsOnHuman).toBe(false)
  })
  it('asked and options are read raw from the object (P3) — a shape outside G9 is ignored, never refused', () => {
    const w = (waitingOn: Json) => flowOf('a', [T('a', 'writer', 'blocked', [], { waitingOn })]).waitsOn
    expect(w({ owner: 'owner', action: 'decide', asked: ' publish today? ', options: ['Yes', 'No'] })).toEqual({
      owner: 'owner',
      action: 'decide',
      asked: 'publish today?',
      options: ['Yes', 'No'],
    })
    expect(w({ owner: 'owner', asked: 'which?', options: ['a', 'b', 'c', 'd'] })).toEqual({
      owner: 'owner',
      action: '',
      asked: 'which?',
      options: ['a', 'b', 'c', 'd'],
    })
    // five options, an empty list, a long one, a non-string: options ignored, the rest kept
    for (const options of [['a', 'b', 'c', 'd', 'e'], [], ['x'.repeat(41)], ['ok', 3], 'yes', ['  ']]) {
      expect(w({ owner: 'owner', asked: 'q', options })).toEqual({ owner: 'owner', action: '', asked: 'q' })
    }
    expect(w({ owner: 'owner', asked: 42 })).toEqual({ owner: 'owner', action: '' })
    expect(w({ owner: 'owner', asked: '   ' })).toEqual({ owner: 'owner', action: '' })
    expect(w({ owner: 'owner', options: ['x'.repeat(40)] })).toEqual({ owner: 'owner', action: '', options: ['x'.repeat(40)] })
  })
  it('the row leads with the question an agent asks (P3 «Finance asks: …»)', () => {
    const kinds = kindsOf({ spec: { kinds: { plan: planSpec() } } })
    const info = kinds.get('plan/task')!
    const row = (tasks: Json[], nameOf?: (a: string) => string): string => {
      const rec = { ...tasks[0]!, identity: 'Publish', stateLabel: { one: 'blocked' } }
      return sayRow(info, { rec, anchors: {}, key: 'k/a', file: null, siblings: tasks } as KindRecord, { now: NOW, isAgent, ...(nameOf ? { nameOf } : {}) })
    }
    const names = (a: string): string => (({ finance: 'Finance', sam: 'Sam' }) as Record<string, string>)[a] ?? a
    expect(row([T('a', 'finance', 'blocked', [], { waitingOn: { owner: 'owner', action: 'decide', asked: 'publish today?' } })], names)).toBe(
      'Finance asks: publish today? — Publish',
    )
    expect(row([T('a', 'finance', 'blocked', [], { waitingOn: { owner: 'sam', asked: 'will you sign?' } })], names)).toBe(
      'Finance asks Sam: will you sign? — Publish',
    )
    // a person's own task waiting on the owner keeps the plain row, said as theirs
    expect(row([T('a', 'sam', 'blocked', [], { waitingOn: { owner: 'owner', asked: 'ok?' } })], names)).toBe("Sam's Publish — blocked · waits on you: ok?")
  })
  it("the dictionary declares it and the manifest's predicate holds over it", () => {
    expect(taskDict().fields.waitsOnHuman).toEqual({ type: 'boolean' })
    const kinds = kindsOf({ spec: { kinds: { plan: planSpec() } } })
    const info = kinds.get('plan/task')!
    const tasks = [T('a', 'writer', 'blocked', [], { waitingOn: { owner: 'owner', action: 'decide' } }), T('b', 'writer', 'pending')]
    const p = (id: string): KindRecord => ({ rec: tasks.find((t) => t.id === id)!, anchors: {}, key: `k/${id}`, file: null, siblings: tasks }) as KindRecord
    expect(holds('waitsOnHuman', info, p('a'), { now: NOW, isAgent })).toBe(true)
    expect(holds('waitsOnHuman', info, p('b'), { now: NOW, isAgent })).toBe(false)
  })
  it("the row says who it waits on, in the file's words — «you» for the owner", () => {
    const kinds = kindsOf({ spec: { kinds: { plan: planSpec() } } })
    const info = kinds.get('plan/task')!
    const row = (id: string, tasks: Json[]): string => {
      const rec = { ...tasks.find((t) => t.id === id)!, identity: `Task ${id}`, stateLabel: { one: 'blocked' } }
      return sayRow(info, { rec, anchors: {}, key: `k/${id}`, file: null, siblings: tasks } as KindRecord, { now: NOW, isAgent })
    }
    expect(row('a', [T('a', 'writer', 'blocked', [], { waitingOn: { owner: 'owner', action: 'Decide: (A) resume or (B) park' } })])).toBe(
      'Task a — blocked · waits on you: Decide: (A) resume or (B) park',
    )
    // toward another person: who waits on whom leads (E8 «Writer waits on Sam»)
    expect(row('a', [T('a', 'writer', 'blocked', [], { waitingOn: { owner: 'sam', action: 'sign' } })])).toBe('writer waits on sam: sign — Task a')
    expect(row('a', [T('a', 'writer', 'blocked', [], { waitingOn: { owner: 'owner' } })])).toBe('Task a — blocked · waits on you')
  })
})

describe('stalled — every cause, named by the first stuck task', () => {
  const said = (f: ReturnType<typeof flowOf>): [boolean, string | null, string | null] => [f.stalled, f.stalledCause, f.stalledBy]

  it("healthy: a terminal task, a human's, a live one, a waiting one, an agent that wakes, a past nextCheckAt (a wake due)", () => {
    expect(said(flowOf('a', [T('a', 'writer', 'done')], { wakes: () => 'never' }))).toEqual([false, null, null])
    expect(said(flowOf('a', [T('a', 'sam', 'pending')], { wakes: () => 'never' }))).toEqual([false, null, null])
    expect(
      said(flowOf('a', [T('a', 'writer', 'in_progress', [], { conversations: [{ id: 's1' }] })], { wakes: () => 'never', isLive: (s) => s === 's1' })),
    ).toEqual([false, null, null])
    expect(said(flowOf('a', [T('a', 'writer', 'pending', [], { waitingOn: { owner: 'sam', action: 'x' } })], { wakes: () => 'never' }))).toEqual([
      false,
      null,
      null,
    ])
    expect(said(flowOf('a', [T('a', 'writer', 'pending')], { wakes: () => 'beat' }))).toEqual([false, null, null])
    expect(said(flowOf('a', [T('a', 'writer', 'pending', [], { nextCheckAt: '2026-11-01T00:00:00Z' })], { wakes: () => 'never' }))).toEqual([false, null, null])
  })

  it("owner can't run: an agent's ready task whose owner never wakes AND can't be started (out of play, no folder — F11)", () => {
    expect(said(flowOf('a', [T('a', 'writer', 'pending')], { wakes: () => 'never', startable: () => false }))).toEqual([true, 'owner-cannot-run', 'a'])
    expect(said(flowOf('a', [T('a', 'writer', 'in_progress')], { wakes: () => 'never', startable: () => false }))).toEqual([true, 'owner-cannot-run', 'a'])
  })
  it('in progress with nothing live: claims to be worked, no conversation live, its owner in task mode', () => {
    expect(said(flowOf('a', [T('a', 'writer', 'in_progress', [], { conversations: [{ id: 's1' }] })], { wakes: () => 'task' }))).toEqual([
      true,
      'in-progress-nothing-live',
      'a',
    ])
  })
  // (B1a — the old «a check is a reviewer» falls on purpose)
  it("in review without a reviewer: an agent's, with no waitingOn naming someone else — a next check is no reviewer, a human owner is", () => {
    expect(said(flowOf('a', [T('a', 'writer', 'in_review')]))).toEqual([true, 'review-without-reviewer', 'a'])
    expect(said(flowOf('a', [T('a', 'sam', 'in_review')]))).toEqual([false, null, null])
    expect(said(flowOf('a', [T('a', 'writer', 'in_review', [], { nextCheckAt: '2026-11-09' })]))).toEqual([true, 'review-without-reviewer', 'a'])
    expect(said(flowOf('a', [T('a', 'writer', 'in_review', [], { nextCheckAt: '2026-11-02' })]))).toEqual([true, 'review-without-reviewer', 'a'])
  })
  describe("B1a — an agent's review names its reviewer (F12 edges)", () => {
    const wait = (owner: string, action = 'review it'): Json => ({ waitingOn: { owner, action } })
    it('a reviewer named: the owner, a person, another agent (the relay, B1d) — guarded', () => {
      expect(said(flowOf('a', [T('a', 'writer', 'in_review', [], wait('owner'))]))).toEqual([false, null, null])
      expect(said(flowOf('a', [T('a', 'writer', 'in_review', [], wait('sam'))]))).toEqual([false, null, null])
      const relay = flowOf('a', [T('a', 'writer', 'in_review', [], wait('builder'))])
      expect([relay.stalled, relay.waitsOnRelay]).toEqual([false, true])
    })
    it("a wait naming the task's own owner is no reviewer — review-without-reviewer, never a relay row", () => {
      const f = flowOf('a', [T('a', 'writer', 'in_review', [], wait('writer'))])
      expect([f.stalled, f.stalledCause, f.waitsOnRelay, f.waitsOnHuman]).toEqual([true, 'review-without-reviewer', false, false])
    })
    it("Silos' own wait (unstick …) guards it as it always did", () => {
      expect(said(flowOf('a', [T('a', 'writer', 'in_review', [], wait('writer', 'unstick plan#a'))]))).toEqual([false, null, null])
    })
    it('nobody owns it: unowned; an archived agent is an agent (isAgent includes it)', () => {
      expect(said(flowOf('a', [T('a', '', 'in_review')]))).toEqual([true, 'unowned', 'a'])
      // `teller` stands for an archived agent: the registry's isAgent still names it
      const archived = taskFlow(T('a', 'teller', 'in_review'), [T('a', 'teller', 'in_review')], taskDict(), { now: NOW, isAgent: (v) => v === 'teller' })
      expect([archived.stalled, archived.stalledCause]).toEqual([true, 'review-without-reviewer'])
    })
    it('a live conversation still guards it (G1) — the review rule is about who reviews once it rests', () => {
      expect(said(flowOf('a', [T('a', 'writer', 'in_review', [], { conversations: [{ id: 's1' }] })], { isLive: (x) => x === 's1' }))).toEqual([
        false,
        null,
        null,
      ])
    })
  })
  it('blocked by an unowned task: unowned, seated at the blocker (A2.4/A2.5)', () => {
    expect(said(flowOf('a', [T('a', 'writer', 'blocked', ['b']), T('b', '', 'pending')]))).toEqual([true, 'unowned', 'b'])
    expect(flowOf('a', [T('a', 'writer', 'blocked', ['b']), T('b', '', 'pending')]).stalledAt).toBe('b')
  })
  it('blocked by a cancelled task — a cancelled blocker never resolves', () => {
    expect(said(flowOf('a', [T('a', 'writer', 'blocked', ['b']), T('b', 'finance', 'cancelled')]))).toEqual([true, 'blocker-cancelled', 'b'])
  })
  it('blocked by untouched work: a blocker in progress with nothing live, or in review with nobody reviewing', () => {
    expect(
      said(flowOf('a', [T('a', 'writer', 'blocked', ['b']), T('b', 'finance', 'in_progress')], { wakes: (x) => (x === 'finance' ? 'never' : 'now') })),
    ).toEqual([true, 'blocker-parked', 'b'])
    expect(said(flowOf('a', [T('a', 'writer', 'blocked', ['b']), T('b', 'finance', 'in_review')]))).toEqual([true, 'blocker-parked', 'b'])
  })
  it("blocked by a task whose owner can't run", () => {
    expect(
      said(
        flowOf('a', [T('a', 'writer', 'blocked', ['b']), T('b', 'finance', 'pending')], {
          wakes: (x) => (x === 'finance' ? 'never' : 'now'),
          startable: (x) => x !== 'finance',
        }),
      ),
    ).toEqual([true, 'owner-cannot-run', 'b'])
  })
  it('a dependency naming no task is blocker-missing, seated at the task that declares it (A2.4/A2.5)', () => {
    expect(said(flowOf('a', [T('a', 'writer', 'blocked', ['ghost'])]))).toEqual([true, 'blocker-missing', 'ghost'])
    expect(flowOf('a', [T('a', 'writer', 'blocked', ['ghost'])]).stalledAt).toBe('a')
  })
  it("waiting on healthy work is not stalled: a human's blocker, a blocker that wakes", () => {
    expect(said(flowOf('a', [T('a', 'writer', 'blocked', ['b']), T('b', 'sam', 'pending')]))).toEqual([false, null, null])
    expect(said(flowOf('a', [T('a', 'writer', 'blocked', ['b']), T('b', 'finance', 'pending')]))).toEqual([false, null, null])
  })
  it('the walk names the FIRST stuck task down the chain, not the one on top', () => {
    const tasks = [
      T('a', 'writer', 'blocked', ['b']),
      T('b', 'finance', 'blocked', ['c']),
      T('c', 'builder', 'blocked', ['d']),
      T('d', 'builder', 'in_progress'),
    ]
    expect(said(flowOf('a', tasks, { wakes: (x) => (x === 'builder' ? 'never' : 'now') }))).toEqual([true, 'blocker-parked', 'd'])
    expect(said(flowOf('b', tasks, { wakes: (x) => (x === 'builder' ? 'never' : 'now') }))).toEqual([true, 'blocker-parked', 'd'])
  })
  it('a dependency cycle is blocker-cycle: each member its own seat, stalledBy the next member — and it ends (A2.4, E4)', () => {
    const tasks = [T('a', 'writer', 'blocked', ['b']), T('b', 'finance', 'blocked', ['a'])]
    expect(said(flowOf('a', tasks))).toEqual([true, 'blocker-cycle', 'b'])
    expect(said(flowOf('b', tasks))).toEqual([true, 'blocker-cycle', 'a'])
    expect([flowOf('a', tasks).stalledAt, flowOf('b', tasks).stalledAt]).toEqual(['a', 'b'])
  })
  it('no depth cap (A2.7): a chain of 200 reaches the stall at its bottom, from the top and from anywhere', () => {
    const n = 200
    const tasks = Array.from({ length: n }, (_, i) => T(`t${i}`, 'writer', 'blocked', i + 1 < n ? [`t${i + 1}`] : []))
    tasks[n - 1] = T(`t${n - 1}`, '', 'pending')
    expect(said(flowOf('t0', tasks))).toEqual([true, 'unowned', `t${n - 1}`])
    expect(flowOf('t0', tasks).stalledAt).toBe(`t${n - 1}`)
    expect(said(flowOf(`t${n - 10}`, tasks))).toEqual([true, 'unowned', `t${n - 1}`])
  })
})

describe('request time (G4): the voice carries the live facts', () => {
  it('a predicate over `stalled` reads isLive and wakes from the Voice; without them nothing is live and nobody wakes', () => {
    const m = { spec: { kinds: { plan: { ...planSpec(), examples: [] } } } }
    const kinds = kindsOf(m)
    const info = kinds.get('plan/task')!
    const tasks = [T('a', 'writer', 'in_progress', [], { conversations: [{ id: 's1', session: 's1' }] })]
    const kr: KindRecord = { rec: tasks[0]!, anchors: {}, key: 'folder:/w/p/tasks/a', file: null, parent: { id: 'p' }, siblings: tasks }
    expect(holds('stalled', info, kr, { now: NOW, isAgent })).toBe(true)
    expect(holds('stalled', info, kr, { now: NOW, isAgent, taskEnv: { isLive: (s) => s === 's1', wakes: () => 'never' } })).toBe(false)
    expect(holds("stalledCause = 'in-progress-nothing-live'", info, kr, { now: NOW, isAgent, taskEnv: { isLive: () => false, wakes: () => 'task' } })).toBe(
      true,
    )
    // a 'never' agent's in-progress task is the owner's to continue (E6) — a flow name, no stall
    expect(holds('waitsStart and stalled = false', info, kr, { now: NOW, isAgent, taskEnv: { isLive: () => false, wakes: () => 'never' } })).toBe(true)
    expect(holds('stalled', info, kr, { now: NOW, isAgent, taskEnv: { isLive: () => false, wakes: () => 'now' } })).toBe(false)
  })
})

describe('task mode (wakes: task) — the stall walk', () => {
  it('a pending or blocked task of a task-mode agent is guarded (its events wake it); an in-progress one with nothing live is parked', () => {
    const te = { wakes: (a: string) => (a === 'writer' ? ('task' as const) : ('never' as const)) }
    expect(flowOf('t1', [T('t1', 'writer', 'pending')], te)).toMatchObject({ stalled: false })
    expect(flowOf('t2', [T('t1', 'sam', 'pending'), T('t2', 'writer', 'blocked', ['t1'])], te)).toMatchObject({ stalled: false })
    expect(flowOf('t1', [T('t1', 'writer', 'in_progress')], te)).toMatchObject({ stalled: true, stalledCause: 'in-progress-nothing-live', stalledBy: 't1' })
    // the same agent out of task mode and out of play: can't run
    expect(flowOf('t1', [T('t1', 'writer', 'pending')], { wakes: () => 'never', startable: () => false })).toMatchObject({
      stalled: true,
      stalledCause: 'owner-cannot-run',
    })
  })
})

// (E6 T3/S6/N8, F11, F12): an agent that only runs when opened is
// the OWNER's turn to start — never «Stalled»
describe("waitsStart — the owner starts a 'never' agent on its task", () => {
  const never = { wakes: () => 'never' as const }
  it('a pending or in-progress open task, nothing blocking it, no live thread: waitsStart, not stalled', () => {
    for (const state of ['pending', 'in_progress']) {
      expect(flowOf('a', [T('a', 'writer', state)], never)).toMatchObject({ waitsStart: true, stalled: false, stalledCause: null })
    }
  })
  it('not when it is live, waits, is blocked, in review, done — nor for a person, nor an agent that wakes', () => {
    expect(flowOf('a', [T('a', 'writer', 'in_progress', [], { conversations: [{ id: 's1' }] })], { ...never, isLive: (x) => x === 's1' }).waitsStart).toBe(
      false,
    )
    expect(flowOf('a', [T('a', 'writer', 'pending', [], { waitingOn: { owner: 'owner', action: 'decide' } })], never).waitsStart).toBe(false)
    expect(flowOf('a', [T('a', 'writer', 'blocked', ['b']), T('b', 'sam', 'pending')], never).waitsStart).toBe(false)
    expect(flowOf('a', [T('a', 'writer', 'in_review')], never).waitsStart).toBe(false)
    expect(flowOf('a', [T('a', 'writer', 'done')], never).waitsStart).toBe(false)
    expect(flowOf('a', [T('a', 'sam', 'pending')], never).waitsStart).toBe(false)
    expect(flowOf('a', [T('a', 'writer', 'pending')], { wakes: () => 'beat' }).waitsStart).toBe(false)
  })
  it('only an agent in play with a folder (F11): otherwise it stays owner-cannot-run', () => {
    expect(flowOf('a', [T('a', 'writer', 'pending')], { ...never, startable: () => false })).toMatchObject({
      waitsStart: false,
      stalledCause: 'owner-cannot-run',
    })
  })
  it('a task blocked on it is blocker-parked BY it (the one to fix: its start)', () => {
    const tasks = [T('a', 'finance', 'blocked', ['b']), T('b', 'writer', 'pending')]
    expect(said(flowOf('a', tasks, { wakes: (x) => (x === 'writer' ? 'never' : 'now') }))).toEqual([true, 'blocker-parked', 'b'])
    expect(flowOf('b', tasks, { wakes: (x) => (x === 'writer' ? 'never' : 'now') })).toMatchObject({ waitsStart: true, stalled: false })
  })
  it("without the request's live facts nothing is said startable (the old reading)", () => {
    const f = taskFlow(T('a', 'writer', 'pending'), [T('a', 'writer', 'pending')], taskDict(), { now: NOW, isAgent })
    expect(f).toMatchObject({ waitsStart: false, stalled: true, stalledCause: 'owner-cannot-run' })
  })
  const said = (f: ReturnType<typeof flowOf>): [boolean, string | null, string | null] => [f.stalled, f.stalledCause, f.stalledBy]
})

// (E5, G2): ready and nobody on it — only an agent Silos wakes on its tasks
describe('idle — ready, nobody on it', () => {
  const task = { wakes: () => 'task' as const }
  it('pending, deps done, no wait, no current conversation, a task-mode owner, no wake on the way', () => {
    expect(flowOf('a', [T('a', 'writer', 'pending')], task).idle).toBe(true)
    expect(flowOf('a', [T('a', 'writer', 'pending', ['b']), T('b', 'sam', 'done')], task).idle).toBe(true)
  })
  it("never for a beat agent (its check-in picks it up), a 'never' one (waitsStart), a person, a 'now' one", () => {
    for (const w of ['beat', 'never', 'now'] as const) expect(flowOf('a', [T('a', 'writer', 'pending')], { wakes: () => w }).idle).toBe(false)
    expect(flowOf('a', [T('a', 'sam', 'pending')], task).idle).toBe(false)
  })
  it('not with an open dependency, a wait, a current conversation, another state — nor a wake on its way', () => {
    expect(flowOf('a', [T('a', 'writer', 'pending', ['b']), T('b', 'sam', 'pending')], task).idle).toBe(false)
    expect(flowOf('a', [T('a', 'writer', 'pending', [], { waitingOn: { owner: 'owner' } })], task).idle).toBe(false)
    // a current conversation holds it only while it is LIVE (A1.1)
    expect(flowOf('a', [T('a', 'writer', 'pending', [], { conversations: [{ id: 's1' }] })], { ...task, isLive: (s) => s === 's1' }).idle).toBe(false)
    expect(flowOf('a', [T('a', 'writer', 'in_progress')], task).idle).toBe(false)
    const asked: Array<{ key: string | null; owner: string; id: string }> = []
    expect(
      flowOf('a', [T('a', 'writer', 'pending')], {
        ...task,
        wakeOnTheWay: (q) => {
          asked.push(q)
          return true
        },
      }).idle,
    ).toBe(false)
    expect(asked).toEqual([{ key: null, owner: 'writer', id: 'a' }])
  })
  it('a released history is no current conversation: idle again', () => {
    const tasks = [T('a', 'writer', 'pending', [], { conversations: [{ id: 's1' }] })]
    expect(flowOf('a', tasks, { ...task, currentOf: () => [] }).idle).toBe(true)
  })
})
