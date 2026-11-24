// task-flow-stalls.test.ts — the kernel rules for stalled tasks (every open
// task has a next step): one test per rule over the ONE flow function
// (silos/task-flow.ts), its way out (stallExit), the turn sentence and Task
// mode's stall wake. Generic fixtures only (writer, builder, teller: agents;
// sam: a person).
import { describe, expect, it } from 'vitest'
import { dictionaryForKind, type FieldDict } from '../src/silos/expressions.js'
import { STALLED_CAUSES, stallExit, taskFlow, type TaskEnv, type TaskFlow } from '../src/silos/task-flow.js'
import { baseRecordOf, flowOf, kindsOf, recordsOfKind, taskFlowRecords, type KindRecord } from '../src/silos/voice.js'
import { turnOf } from '../src/silos/turn.js'
import { taskSnapshots } from '../src/task-mode/engine.js'
import { evaluateTaskWakes, stallShape, type Observation, type TaskSnap } from '../src/task-mode/evaluate.js'
import type { SiloReading } from '../src/silos/reader.js'

type Json = Record<string, any>
const NOW = Date.parse('2026-11-21T12:00:00Z')
const DAY = 24 * 3600_000
const AGENTS = new Set(['writer', 'builder', 'teller'])
const isAgent = (v: string): boolean => AGENTS.has(v)
const BOUND = new Set(['writer', 'builder'])
const STATES = ['pending', 'in_progress', 'in_review', 'blocked', 'done', 'cancelled']
function planSpec(): Json {
  return {
    envelope: { id: { from: 'filename' }, identity: { template: '{{title}}' }, state: { computed: 'all(tasks, state in [done, cancelled]) ? done : active' } },
    states: [
      { value: 'active', label: { one: 'active', many: 'active' } },
      { value: 'done', label: { one: 'done', many: 'done' }, terminal: true },
    ],
    subKinds: {
      task: {
        path: 'tasks[]',
        envelope: { id: { field: 'id' }, identity: { template: '{{title}}' }, state: { field: 'status' } },
        states: STATES.map((v) => ({ value: v, label: { one: v, many: v }, ...(v === 'done' || v === 'cancelled' ? { terminal: true } : {}) })),
        roles: { task: { owner: 'owner', dependsOn: 'dependsOn', waitingOn: 'waitingOn', nextCheckAt: 'nextCheckAt', conversations: 'conversations' } },
        fields: {
          owner: { type: 'actor', required: true },
          dependsOn: { type: 'refs(task)', withinParent: true },
          waitingOn: { type: 'string', optional: true },
          nextCheckAt: { type: 'timestamp', optional: true },
        },
      },
    },
  }
}
const DICT: FieldDict = dictionaryForKind('plan', planSpec()).dict.collections.tasks!
const MANIFEST = { spec: { kinds: { plan: planSpec() } } }
const ENV: TaskEnv = { isLive: () => false, wakes: (a) => (BOUND.has(a) ? 'task' : 'never'), startable: (a) => AGENTS.has(a) }
const T = (id: string, owner: string, state: string, dependsOn: string[] = [], over: Json = {}): Json => ({
  id,
  owner,
  state,
  dependsOn,
  conversations: [],
  ...over,
})
const flow = (id: string, tasks: Json[], o: { env?: TaskEnv | null; unreadable?: string[] } = {}): TaskFlow =>
  taskFlow(
    tasks.find((t) => t.id === id)!,
    tasks,
    DICT,
    { now: NOW, isAgent, ...(o.env === null ? {} : { taskEnv: o.env ?? ENV }), ...(o.unreadable ? { unreadableSiblings: o.unreadable } : {}) },
  )
const exitOf = (id: string, tasks: Json[]) =>
  stallExit(flow(id, tasks), { id, owner: String(tasks.find((t) => t.id === id)!.owner), bound: (o) => BOUND.has(o) })
const PAST = new Date(NOW - DAY).toISOString()
const FUTURE = new Date(NOW + DAY).toISOString()

// Task mode over a plan, through the real cascade: two looks, the wakes of the second
function wakesOver(
  tasks: Json[],
  prev: Record<string, Observation> = {},
  at = NOW,
): { wakes: Array<{ task: string; key: string; says: string }>; obs: Record<string, Observation> } {
  const base: KindRecord[] = [{ rec: { id: 'p', tasks }, anchors: {}, key: 'folder:/w/p', file: null }]
  const facts = taskFlowRecords(MANIFEST, base, { now: at, isAgent, taskEnv: ENV })
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
        record: { id: 'p', title: 'P', tasks },
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
  const ev = evaluateTaskWakes({ tasks: taskSnapshots(reading, facts), bound: BOUND, prev, now: at, nameOf: (id) => id.charAt(0).toUpperCase() + id.slice(1) })
  return {
    wakes: ev.wakes.filter((w) => w.reason === 'stalled').map((w) => ({ task: w.task.slice(w.task.lastIndexOf('/') + 1), key: w.key, says: w.says })),
    obs: ev.observations,
  }
}
const twoLooks = (tasks: Json[]) => {
  const first = wakesOver(tasks)
  return wakesOver(tasks, first.obs, NOW + 30_000).wakes
}

describe('in review: a past check guards only a bound owner; the owner is looked at before the state', () => {
  // (B1a supersedes A2.1 for an AGENT's review: a next
  // check — past or ahead, bound or told — reviews nothing; a reviewer named does)
  it("an agent's review with only a next check is review-without-reviewer, past or ahead, bound or told (B1a)", () => {
    expect(flow('a', [T('a', 'teller', 'in_review', [], { nextCheckAt: PAST })])).toMatchObject({
      stalled: true,
      stalledCause: 'review-without-reviewer',
      stalledAt: 'a',
    })
    expect(flow('a', [T('a', 'writer', 'in_review', [], { nextCheckAt: PAST })])).toMatchObject({ stalled: true, stalledCause: 'review-without-reviewer' })
    expect(flow('a', [T('a', 'teller', 'in_review', [], { nextCheckAt: FUTURE })])).toMatchObject({ stalled: true, stalledCause: 'review-without-reviewer' })
  })
  it('a task nobody owns in review is unowned, not review-without-reviewer', () => {
    expect(flow('a', [T('a', '', 'in_review')])).toMatchObject({ stalled: true, stalledCause: 'unowned', stalledAt: 'a' })
  })
})

describe('a wait on a named person stays waitsOnHuman', () => {
  it('waitsOnHuman, never waitsOnRelay — the task waits (guarded)', () => {
    expect(flow('a', [T('a', 'teller', 'pending', [], { waitingOn: { owner: 'sam', action: 'sign it' } })])).toMatchObject({
      waitsOnHuman: true,
      waitsOnRelay: false,
      stalled: false,
    })
  })
})

describe('the turn sentence names the person', () => {
  const turn = (id: string, tasks: Json[]) =>
    turnOf(
      tasks.find((t) => t.id === id)!,
      tasks,
      DICT,
      (x) => `p#${x}`,
      { now: NOW, isAgent, taskEnv: ENV, nameOf: (x) => x.charAt(0).toUpperCase() + x.slice(1) },
    )
  it("«Sam's turn» for another person; «Your turn» stays the owner's", () => {
    expect(turn('a', [T('a', 'sam', 'pending')])?.sentence).toBe("Sam's turn — nothing here waits on anyone else.")
    expect(turn('a', [T('a', 'owner', 'pending')])?.sentence).toBe('Your turn — nothing here waits on anyone else.')
  })
})

describe('one cause, one meaning: nine, blocker-unowned retired', () => {
  it('the nine causes, each from its own shape', () => {
    expect([...STALLED_CAUSES].sort()).toEqual([
      'blocked-on-nothing',
      'blocker-cancelled',
      'blocker-cycle',
      'blocker-missing',
      'blocker-parked',
      'in-progress-nothing-live',
      'owner-cannot-run',
      'review-without-reviewer',
      'unowned',
    ])
    const said = (id: string, tasks: Json[]) => flow(id, tasks).stalledCause
    expect(said('a', [T('a', '', 'pending')])).toBe('unowned')
    expect(said('a', [T('a', 'teller', 'blocked')])).toBe('blocked-on-nothing')
    expect(said('a', [T('a', 'teller', 'blocked', ['ghost'])])).toBe('blocker-missing')
    expect(said('a', [T('a', 'teller', 'blocked', ['b']), T('b', 'teller', 'blocked', ['a'])])).toBe('blocker-cycle')
    expect(said('a', [T('a', 'teller', 'blocked', ['b']), T('b', 'teller', 'pending')])).toBe('blocker-parked')
    expect(said('a', [T('a', 'teller', 'blocked', ['b']), T('b', 'teller', 'cancelled')])).toBe('blocker-cancelled')
    expect(said('a', [T('a', 'gone-agent', 'pending')])).toBe(null) // not an agent: a person — G3
    expect(flow('a', [T('a', 'teller', 'pending')], { env: { ...ENV, startable: () => false } }).stalledCause).toBe('owner-cannot-run')
    expect(said('a', [T('a', 'teller', 'in_review')])).toBe('review-without-reviewer')
    expect(said('a', [T('a', 'writer', 'in_progress')])).toBe('in-progress-nothing-live')
  })
  it("«unowned» says «it» or «a blocker» by stalledBy === id; the turn says the seat's words", () => {
    expect(flow('a', [T('a', '', 'pending')])).toMatchObject({ stalledBy: 'a', stalledAt: 'a' })
    expect(flow('a', [T('a', 'teller', 'blocked', ['b']), T('b', '', 'pending')])).toMatchObject({ stalledCause: 'unowned', stalledBy: 'b', stalledAt: 'b' })
    const tasks = [T('a', '', 'pending')]
    expect(turnOf(tasks[0]!, tasks, DICT, (x) => `p#${x}`, { now: NOW, isAgent, taskEnv: ENV })?.sentence).toBe('Sits untouched — nobody owns it.')
  })
})

describe('every stall has a SEAT, by position, and through it ONE way out', () => {
  it('the seat: the bottom of a chain · the declarer of a dead link · each cycle member · the first member a non-member reaches · a blocker waiting for its start', () => {
    const chain = [T('t1', 'writer', 'blocked', ['t2']), T('t2', 'writer', 'blocked', ['t3']), T('t3', 'teller', 'blocked')]
    expect(['t1', 't2', 't3'].map((id) => flow(id, chain).stalledAt)).toEqual(['t3', 't3', 't3'])
    const dead = [T('a', 'writer', 'blocked', ['b']), T('b', 'sam', 'blocked', ['c']), T('c', 'teller', 'cancelled')]
    expect(flow('a', dead)).toMatchObject({ stalledCause: 'blocker-cancelled', stalledBy: 'c', stalledAt: 'b' })
    expect(flow('b', dead)).toMatchObject({ stalledCause: 'blocker-cancelled', stalledBy: 'c', stalledAt: 'b' })
    const reach = [T('z', 'writer', 'blocked', ['a']), T('a', 'writer', 'blocked', ['b']), T('b', 'builder', 'blocked', ['a'])]
    expect(flow('z', reach)).toMatchObject({ stalledCause: 'blocker-cycle', stalledAt: 'a', stalledBy: 'a' })
    expect(flow('a', reach)).toMatchObject({ stalledCause: 'blocker-cycle', stalledAt: 'a', stalledBy: 'b' })
    expect(flow('b', reach)).toMatchObject({ stalledCause: 'blocker-cycle', stalledAt: 'b', stalledBy: 'a' })
    const parked = [T('a', 'writer', 'blocked', ['b']), T('b', 'teller', 'pending')]
    expect(flow('a', parked)).toMatchObject({ stalledCause: 'blocker-parked', stalledAt: 'b' })
    expect(flow('b', parked)).toMatchObject({ stalled: false, waitsStart: true })
  })
  it("the way out: a bound seat whose owner can clear it is a wake; nobody's, a person's, an unbound agent's, owner-cannot-run is the row; any other task follows its seat", () => {
    expect(exitOf('a', [T('a', 'writer', 'blocked')])).toBe('wake')
    expect(exitOf('a', [T('a', 'teller', 'blocked')])).toBe('row')
    expect(exitOf('a', [T('a', 'sam', 'blocked', ['ghost'])])).toBe('row')
    expect(exitOf('a', [T('a', '', 'pending')])).toBe('row')
    expect(exitOf('a', [T('a', 'writer', 'blocked', ['b']), T('b', 'teller', 'blocked')])).toBe('seat')
    expect(
      stallExit(flow('a', [T('a', 'writer', 'pending')], { env: { ...ENV, wakes: () => 'task', startable: () => false } }), {
        id: 'a',
        owner: 'writer',
        bound: () => true,
      }),
    ).toBe(null)
  })
  it('Task mode wakes by seat: a cancelled blocker deep in the chain wakes its DECLARER, never the task on top (ownerCanClear woke at any depth)', () => {
    const tasks = [T('a', 'writer', 'blocked', ['b']), T('b', 'builder', 'blocked', ['c']), T('c', 'teller', 'cancelled')]
    expect(twoLooks(tasks).map((w) => [w.task, w.key.split('@')[0]])).toEqual([['b', 'stalled:blocker-cancelled']])
  })
  it("a dependency on an id the file holds but the reader could not build: guarded by A1.8's row — neither stall nor wake", () => {
    expect(flow('a', [T('a', 'writer', 'blocked', ['u'])], { unreadable: ['u'] })).toMatchObject({ stalled: false })
    expect(flow('a', [T('a', 'writer', 'blocked', ['u'])])).toMatchObject({ stalled: true, stalledCause: 'blocker-missing' })
  })
})

describe("a person's task is walked, own() written once", () => {
  it("a person's task on a dead chain is stalled; on a healthy one it waits; with no open dependency it is G3", () => {
    expect(flow('a', [T('a', 'owner', 'pending', ['ghost'])])).toMatchObject({ stalled: true, stalledCause: 'blocker-missing', stalledAt: 'a' })
    expect(flow('a', [T('a', 'owner', 'pending', ['b']), T('b', 'writer', 'pending')])).toMatchObject({ stalled: false })
    expect(flow('a', [T('a', 'sam', 'pending', [], { nextCheckAt: PAST })])).toMatchObject({ stalled: false })
  })
  it("a person's past check guards nothing (its chain is walked); a future one always guards", () => {
    expect(flow('a', [T('a', 'sam', 'pending', ['ghost'], { nextCheckAt: PAST })])).toMatchObject({ stalled: true, stalledCause: 'blocker-missing' })
    expect(flow('a', [T('a', 'sam', 'pending', ['ghost'], { nextCheckAt: FUTURE })])).toMatchObject({ stalled: false })
    expect(flow('a', [T('a', '', 'pending', [], { nextCheckAt: FUTURE })])).toMatchObject({ stalled: false })
  })
  it("the same plan with and without the request's live facts: without them a person's task is ok, as before (the exception lives inside own())", () => {
    const tasks = [T('a', 'owner', 'pending', ['b']), T('b', 'teller', 'pending', ['ghost'])]
    expect(flow('a', tasks)).toMatchObject({ stalled: true, stalledCause: 'blocker-missing', stalledAt: 'b' })
    expect(flow('a', tasks, { env: null })).toMatchObject({ stalled: false })
    // an agent's task without them reads as before (nothing is startable)
    expect(flow('b', tasks, { env: null })).toMatchObject({ stalled: true, stalledCause: 'blocker-missing', stalledAt: 'b' })
  })
  it("E1 — the turn says the stall first only for its seat: a task waiting on another's stall keeps «Waiting — waits on …»", () => {
    const tasks = [T('a', 'owner', 'pending', ['b']), T('b', 'teller', 'blocked', ['c']), T('c', 'teller', 'cancelled')]
    const turn = (id: string) =>
      turnOf(
        tasks.find((t) => t.id === id)!,
        tasks,
        DICT,
        (x) => `p#${x}`,
        { now: NOW, isAgent, taskEnv: ENV, nameOf: (x) => x.charAt(0).toUpperCase() + x.slice(1) },
      )
    expect(turn('a')).toEqual({ kind: 'waiting', sentence: 'Waiting — waits on p#b (Teller). Then it is your turn.' })
    const own = [T('a', 'owner', 'blocked', ['ghost'])]
    expect(turnOf(own[0]!, own, DICT, (x) => `p#${x}`, { now: NOW, isAgent, taskEnv: ENV })).toEqual({
      kind: 'stalled',
      sentence: "Sits untouched — waits on a task its plan doesn't have.",
    })
  })
  it('the cause is said true beside any status: its own (stalledBy itself) says what is wrong with it, one down the chain «waits on …» (web causeWords, the other half)', () => {
    // a cycle: each member is a seat, its stalledBy the other member
    const cycle = [T('a', 'teller', 'pending', ['b']), T('b', 'teller', 'in_progress', ['a'])]
    for (const id of ['a', 'b']) {
      const s = turnOf(
        cycle.find((t) => t.id === id)!,
        cycle,
        DICT,
        (x) => `p#${x}`,
        { now: NOW, isAgent, taskEnv: ENV },
      )
      expect(s).toEqual({ kind: 'stalled', sentence: 'Sits untouched — waits on tasks that wait on each other.' })
    }
  })
})

describe('no depth cap, linear', () => {
  it('each task of a plan is looked at once per call, whatever the shape (a random plan, its liveness asked once per task)', () => {
    let seed = 7
    const rnd = (n: number): number => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31
      return seed % n
    }
    for (let round = 0; round < 50; round++) {
      const n = 30
      const tasks = Array.from({ length: n }, (_, i) =>
        T(
          `t${i}`,
          ['writer', 'teller', 'sam', 'owner'][rnd(4)]!,
          ['pending', 'blocked', 'in_progress'][rnd(3)]!,
          Array.from({ length: rnd(3) }, () => `t${rnd(n)}`),
          { conversations: [`s${i}`] },
        ),
      )
      for (const t of tasks) {
        const asked = new Map<string, number>()
        taskFlow(t, tasks, DICT, {
          now: NOW,
          isAgent,
          taskEnv: {
            ...ENV,
            isLive: (s) => {
              asked.set(s, (asked.get(s) ?? 0) + 1)
              return false
            },
          },
        })
        expect([...asked.values()].every((k) => k === 1)).toBe(true)
      }
    }
  })
  it('the seat of a seat is itself, or is not stalled — over random plans with cycles, dead links and mixed owners', () => {
    let seed = 11
    const rnd = (n: number): number => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31
      return seed % n
    }
    const bad: string[] = []
    for (let round = 0; round < 200; round++) {
      const n = 12
      const tasks = Array.from({ length: n }, (_, i) =>
        T(
          `t${i}`,
          ['writer', 'teller', 'sam', 'owner', ''][rnd(5)]!,
          ['pending', 'blocked', 'in_progress', 'in_review', 'cancelled', 'done'][rnd(6)]!,
          Array.from({ length: rnd(3) }, () => (rnd(8) === 0 ? 'ghost' : `t${rnd(n)}`)),
        ),
      )
      for (const t of tasks) {
        const f = flow(String(t.id), tasks)
        if (!f.stalled) continue
        if (f.stalledAt === null) {
          bad.push(`${round}/${t.id} no seat`)
          continue
        }
        const s = flow(f.stalledAt, tasks)
        if (s.stalled && s.stalledAt !== f.stalledAt) bad.push(`${round}/${t.id} → ${f.stalledAt} → ${s.stalledAt}`)
      }
    }
    expect(bad).toEqual([])
  })
})

describe('a cycle: stalledBy is the next member; every bound member is woken, naming the other', () => {
  it('a 2-cycle of two bound agents: two wakes, each names the other and who was told', () => {
    const tasks = [T('a', 'writer', 'blocked', ['b']), T('b', 'builder', 'blocked', ['a'])]
    const ws = twoLooks(tasks)
    expect(ws.map((w) => w.task).sort()).toEqual(['a', 'b'])
    expect(ws.find((w) => w.task === 'a')!.says).toBe(
      'it is stalled — it and p#b wait on each other — Builder was told too; remove YOUR dependency only if it is the wrong one; leave it with an explicit disposition',
    )
    expect(ws.find((w) => w.task === 'b')!.says).toMatch(/it and p#a wait on each other — Writer was told too/)
  })
  it('a member whose other member nobody wakes says the owner was told (its row)', () => {
    const ws = twoLooks([T('a', 'writer', 'blocked', ['b']), T('b', 'teller', 'blocked', ['a'])])
    expect(ws.map((w) => [w.task, w.says.includes('the owner was told too')])).toEqual([['a', true]])
  })
})

describe('unreadable ids reach the flow (KindRecord.unreadableSiblings)', () => {
  it('baseRecordOf names the children the reader could not build; recordsOfKind hands them to each sibling', () => {
    const r = {
      record: { id: 'p', tasks: [T('a', 'writer', 'blocked', ['u'])] },
      anchors: {},
      location: 'folder:/w',
      file: '/w/plans/p.plan.json',
      remarks: ['tasks[1] is not read: its owner is missing'],
      raw: { tasks: [{ id: 'a' }, { id: 'u' }] },
    }
    const base = baseRecordOf(r)
    expect(base.unreadableChildren).toEqual({ tasks: ['u'] })
    const kinds = kindsOf(MANIFEST)
    const [a] = recordsOfKind(kinds, [base], 'plan/task')
    expect(a!.unreadableSiblings).toEqual(['u'])
    expect(flowOf(kinds.get('plan/task')!, a!, { now: NOW, isAgent, taskEnv: ENV })).toMatchObject({ stalled: false })
  })
  it("the turn says the id Silos can't read, not «a task its plan no longer has» — and never «Your turn» over it", () => {
    const tasks = [T('a', 'writer', 'blocked', ['u'])]
    expect(
      turnOf(tasks[0]!, tasks, DICT, (x) => `p#${x}`, { now: NOW, isAgent, taskEnv: ENV, nameOf: () => 'Writer', unreadableSiblings: ['u'] })?.sentence,
    ).toBe("Waiting — waits on p#u, which Silos can't read. Then it is Writer's turn — Silos wakes it then.")
    const mine = [T('a', 'owner', 'pending', ['u'])]
    expect(turnOf(mine[0]!, mine, DICT, (x) => `p#${x}`, { now: NOW, isAgent, taskEnv: ENV, unreadableSiblings: ['u'] })?.sentence).toBe(
      "Waiting — waits on p#u, which Silos can't read. Then it is your turn.",
    )
  })
})

describe("the stall episode sees its blockers' states", () => {
  it("stallShape moves with a dependency's state", () => {
    const t = { state: 'blocked', dependsOn: ['b'], waitingFor: null, nextCheckAt: null } as Pick<
      TaskSnap,
      'state' | 'dependsOn' | 'waitingFor' | 'nextCheckAt'
    >
    expect(stallShape(t, () => 'cancelled')).not.toBe(stallShape(t, () => 'pending'))
    expect(stallShape(t, () => undefined)).toContain('b:?')
  })
  it('a cancelled blocker reopened and cancelled again opens a NEW episode — a second wake', () => {
    const cancelled = [T('a', 'writer', 'blocked', ['b']), T('b', 'teller', 'cancelled')]
    const reopened = [T('a', 'writer', 'blocked', ['b']), T('b', 'teller', 'blocked', ['c']), T('c', 'sam', 'pending')]
    let obs: Record<string, Observation> = {}
    const keys: string[] = []
    ;[cancelled, cancelled, reopened, cancelled, cancelled].forEach((tasks, i) => {
      const r = wakesOver(tasks, obs, NOW + i * 30_000)
      keys.push(...r.wakes.map((w) => w.key))
      obs = r.obs
    })
    expect(keys).toHaveLength(2)
    expect(new Set(keys).size).toBe(2)
  })
})
