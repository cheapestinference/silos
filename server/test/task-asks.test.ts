// task-asks.test.ts — B2 (agent ↔ agent, ONE fact per task)
// with its binding amendments H1–H11, over a real Task mode store and engine
// and an in-memory plan file written through the same mutator contract as
// SiloActions.silosWriteChild. Generic agents only: writer and builder (bound
// to Task mode, a heartbeat in reach), teller (Only when told), gone
// (archived), slowpoke (bound, its next beat days away); sam is a person.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TaskModeStore, WAKE_KEEP_MS } from '../src/task-mode/store.js'
import { MISSING_KEEP_MS, TaskModeEngine } from '../src/task-mode/engine.js'
import { askSeenByOf, TaskAsks, type TaskAsksDeps } from '../src/task-asks.js'
import { askLinked, taskFlow, type TaskEnv } from '../src/silos/task-flow.js'
import { dictionaryForKind } from '../src/silos/expressions.js'
import { TRANSCRIPT_UNREADABLE } from '../src/heartbeat-audit.js'
import { ANSWERS_PER_TASK_DAY, ASK_ACTION_MAX, ASK_ASKED_MAX, ASKS_PER_DAY, ASK_REACH_MS } from '../src/limits.js'
import type { LiveTurn } from '../src/live-turns.js'
import type { SiloReading } from '../src/silos/reader.js'
import type { Period } from '../src/period.js'

type Json = Record<string, any>
const T0 = Date.parse('2026-11-21T09:00:00Z')
const MIN = 60_000
const HOUR = 3600_000
const DAY = 24 * HOUR
const KEY = (id: string): string => `folder:/p/launch/tasks/${id}`
const AGENTS = new Set(['writer', 'builder', 'teller', 'gone', 'slowpoke'])
const IN_PLAY = new Set(['writer', 'builder', 'teller', 'slowpoke'])
const BOUND = new Set(['writer', 'builder', 'slowpoke'])
const NAMES: Record<string, string> = { writer: 'Writer', builder: 'Builder', teller: 'Teller', gone: 'Gone', slowpoke: 'Slowpoke' }

let base: string
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'task-asks-'))
})
afterEach(() => rmSync(base, { recursive: true, force: true }))

function readingOf(tasks: Json[]): SiloReading {
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
        record: { id: 'launch', title: 'L', tasks: tasks.map((t) => ({ ...t, state: t.status })) },
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

// the plan's dictionary, as the kernel reads a Plans task (status is the state)
const DICT = dictionaryForKind('plan', {
  envelope: { id: { from: 'filename' }, identity: { template: '{{title}}' }, state: { computed: 'all(tasks, state in [done, cancelled]) ? done : active' } },
  states: [
    { value: 'active', label: { one: 'active', many: 'active' } },
    { value: 'done', label: { one: 'done', many: 'done' }, terminal: true },
  ],
  subKinds: {
    task: {
      path: 'tasks[]',
      envelope: { id: { field: 'id' }, identity: { template: '{{title}}' }, state: { field: 'status' } },
      states: ['pending', 'in_progress', 'in_review', 'blocked', 'done', 'cancelled'].map((v) => ({ value: v, label: { one: v, many: v } })),
      roles: { task: { owner: 'owner', dependsOn: 'dependsOn', waitingOn: 'waitingOn', nextCheckAt: 'nextCheckAt', conversations: 'conversations' } },
      fields: { owner: { type: 'actor', required: true } },
    },
  },
}).dict.collections.tasks!

const T = (id: string, owner: string, status = 'pending', over: Json = {}): Json => ({
  id,
  title: `Task ${id}`,
  owner,
  status,
  dependsOn: [],
  notes: [],
  conversations: [],
  ...over,
})

interface WorldOpts {
  tasks?: Json[]
  store?: TaskModeStore
  seenBy?: TaskAsksDeps['seenBy']
  plansOff?: boolean
  ofProject?: TaskAsksDeps['ofProject']
}
function world(o: WorldOpts = {}) {
  let now = T0
  let tasks: Json[] = o.tasks ?? [T('t1', 'writer'), T('t2', 'builder')]
  let failWrite: 'before' | 'after' | null = null
  let plansOff = o.plansOff === true
  const sent: Array<{ agentId: string; text: string }> = []
  const store = o.store ?? new TaskModeStore(mkdtempSync(join(base, 'w-')))
  const own: Array<{ key: string; shape: Json; undone: boolean }> = []
  const marks: Array<{ kind: 'ask' | 'note'; key: string; agent: string; at: string }> = []
  const live = new Set<string>()
  const audits = new Map<string, string[]>()
  const engine = new TaskModeEngine({
    store,
    plans: () => (plansOff ? null : { reading: readingOf(tasks) }),
    bound: () => BOUND,
    ready: () => true,
    setField: () => ({ ok: true }),
    appendConversation: () => ({ ok: true }),
    conversationOf: () => null,
    holdersOf: () => [],
    busyWhy: () => null,
    // a turn that starts and ends at once (its end is a microtask away)
    send: (i) => {
      sent.push({ agentId: i.agentId, text: i.text })
      i.onStarted?.()
      return { turnId: `turn-${sent.length}`, done: Promise.resolve({ started: true }) }
    },
    nameOf: (id) => NAMES[id] ?? id,
    answeredTurn: { live: (agent, run) => live.has(`${agent}|${run}`), readOutside: (agent, run) => audits.get(`${agent}|${run}`) ?? null },
    now: () => now,
  })
  const asks = new TaskAsks({
    store,
    tasks: () => engine.tasks(now),
    write: (key, mutate) => {
      if (failWrite === 'before') return { ok: false, code: 409, reason: 'the file no longer holds valid JSON' }
      const list = tasks.map((t) => JSON.parse(JSON.stringify(t)) as Json)
      const id = key.slice(key.lastIndexOf('/') + 1)
      const child = list.find((t) => t.id === id) ?? null
      const out = mutate(child, list)
      if (typeof out === 'string') return { ok: false, code: 409, reason: out }
      if (!out.write) return { ok: true }
      if (failWrite === 'after') return { ok: false, code: 400, reason: 'the task would no longer read' }
      tasks = list
      return { ok: true }
    },
    isAgent: (id) => AGENTS.has(id),
    inPlay: (id) => IN_PLAY.has(id),
    nameOf: (id) => NAMES[id] ?? id,
    bound: (id) => BOUND.has(id),
    ...(o.ofProject ? { ofProject: o.ofProject } : {}),
    seenBy: o.seenBy ?? ((to, at) => (to === 'builder' || to === 'writer' ? at + HOUR : to === 'slowpoke' ? at + 3 * DAY : null)),
    ownWrite: (key, shape) => {
      const e = { key, shape: JSON.parse(JSON.stringify(shape)) as Json, undone: false }
      own.push(e)
      return () => {
        e.undone = true
      }
    },
    markAsk: (key, agent, _turn, at) => {
      marks.push({ kind: 'ask', key, agent, at })
    },
    markNote: (key, agent, _turn, at) => {
      marks.push({ kind: 'note', key, agent, at })
    },
    look: () => engine.look(now),
    now: () => now,
  })
  // the task env a reader of the flow has (index.ts): the store's fact, its reach
  const env: TaskEnv = {
    isLive: () => false,
    wakes: (a) => (BOUND.has(a) ? 'task' : 'never'),
    askOf: (key) => {
      const f = store.armedOf(key)
      return f
        ? {
            ...f,
            seenBy: (o.seenBy ?? ((to: string, at: number) => (to === 'builder' || to === 'writer' ? at + HOUR : to === 'slowpoke' ? at + 3 * DAY : null)))(
              f.to,
              Date.parse(f.at),
            ),
          }
        : null
    },
  }
  const flowOf = (id: string, withKey = true) =>
    taskFlow(
      tasks.find((t) => t.id === id)!,
      tasks,
      DICT,
      { now, isAgent: (v) => AGENTS.has(v), taskEnv: env, ...(withKey ? { key: KEY(id) } : {}) },
    )
  const turn = (agentId: string, unattended = false): LiveTurn => ({
    agentId,
    turnId: `t-${agentId}`,
    unattended,
    class: unattended ? 'heartbeat' : 'chat',
    ...(unattended ? { runId: `run-${agentId}` } : {}),
    at: new Date(now).toISOString(),
  })
  return {
    asks,
    engine,
    store,
    sent,
    own,
    marks,
    live,
    audits,
    flowOf,
    get tasks() {
      return tasks
    },
    set tasks(v: Json[]) {
      tasks = v
    },
    task: (id: string) => tasks.find((t) => t.id === id)!,
    at: (ms: number) => {
      now = ms
    },
    fail: (f: 'before' | 'after' | null) => {
      failWrite = f
    },
    plans: (on: boolean) => {
      plansOff = !on
    },
    ask: (agentId: string, key: string, body: Json, unattended = false) =>
      asks.ask({ agentId, turn: turn(agentId, unattended), key, ...body } as Parameters<TaskAsks['ask']>[0]),
    answer: (agentId: string, key: string, text: unknown, unattended = false) => asks.answer({ agentId, turn: turn(agentId, unattended), key, text }),
  }
}

describe('B2.1 — arming: one fact in the store, the plain wait in the file', () => {
  it('writes waitingOn {owner, action, asked} + blocked, keeps {to, action, asked, at}, wakes nobody, and says who sees it', () => {
    const w = world()
    const r = w.ask('writer', KEY('t1'), { to: 'builder', action: 'answer the pricing question', asked: 'Which tier ships first?' })
    expect(r).toMatchObject({ ok: true, value: { to: 'builder', state: 'blocked', sees: 'beat', already: false } })
    expect(w.task('t1')).toMatchObject({
      status: 'blocked',
      waitingOn: { owner: 'builder', action: 'answer the pricing question', asked: 'Which tier ships first?' },
    })
    expect(w.store.armedOf(KEY('t1'))).toEqual({
      to: 'builder',
      action: 'answer the pricing question',
      asked: 'Which tier ships first?',
      at: new Date(T0).toISOString(),
      by: 'writer',
    })
    // the request wakes nobody: no wake queued for builder
    expect(w.store.queued().filter((x) => x.agent === 'builder')).toEqual([])
    expect(w.sent).toEqual([])
    // H4: Silos' own write, registered with the stamper inside the mutator
    expect(w.own.map((e) => [e.key, e.shape.status, e.undone])).toEqual([[KEY('t1'), 'blocked', false]])
  })

  it('with review: in_review; refused while a dependency is open', () => {
    const w = world({ tasks: [T('t1', 'writer', 'in_progress'), T('t3', 'writer', 'pending', { dependsOn: ['t4'] }), T('t4', 'sam')] })
    expect(w.ask('writer', KEY('t1'), { to: 'builder', action: 'review the draft', review: true })).toMatchObject({ ok: true, value: { state: 'in_review' } })
    expect(w.task('t1')).toMatchObject({ status: 'in_review', waitingOn: { owner: 'builder', action: 'review the draft' } })
    expect(w.task('t1').waitingOn.asked).toBeUndefined()
    const r = w.ask('writer', KEY('t3'), { to: 'builder', action: 'review it', review: true })
    expect(r).toMatchObject({ ok: false, code: 409 })
    if (!r.ok) expect(r.error).toMatch(/t4 is still open/)
  })

  it('the file gets exactly the bounded strings the fact keeps (H5)', () => {
    const w = world()
    const r = w.ask('writer', KEY('t1'), { to: 'builder', action: '  ' + 'a'.repeat(200), asked: 'q'.repeat(900) })
    expect(r.ok).toBe(true)
    const f = w.store.armedOf(KEY('t1'))!
    expect(f.action).toHaveLength(ASK_ACTION_MAX)
    expect(f.asked).toHaveLength(ASK_ASKED_MAX)
    expect(w.task('t1').waitingOn).toEqual({ owner: 'builder', action: f.action, asked: f.asked })
    expect(askLinked(f, w.task('t1').waitingOn)).toBe(true)
  })

  it("refusals, each in its words — another's task 403, nothing written", () => {
    const w = world({
      tasks: [
        T('t1', 'writer'),
        T('t2', 'builder'),
        T('t5', 'writer', 'done'),
        T('t6', 'writer', 'blocked', { waitingOn: { owner: 'owner', action: 'decide' } }),
      ],
    })
    const err = (r: ReturnType<typeof w.ask>): [number, string] => (r.ok ? [200, ''] : [r.code, r.error])
    expect(err(w.ask('builder', KEY('t1'), { to: 'writer', action: 'x' }))).toEqual([403, expect.stringMatching(/Writer's task, not yours/)])
    expect(err(w.ask('writer', KEY('t1'), { to: 'writer', action: 'x' }))).toEqual([409, expect.stringMatching(/can't ask yourself/)])
    expect(err(w.ask('writer', KEY('t1'), { to: 'owner', action: 'x' }))).toEqual([409, expect.stringMatching(/the owner is asked in the file/)])
    expect(err(w.ask('writer', KEY('t1'), { to: 'gone', action: 'x' }))).toEqual([409, expect.stringMatching(/not an agent in play/)])
    expect(err(w.ask('writer', KEY('t1'), { to: 'builder', action: '  unstick launch#t1' }))).toEqual([409, expect.stringMatching(/Silos' own wait/)])
    expect(err(w.ask('writer', KEY('t5'), { to: 'builder', action: 'x' }))).toEqual([409, expect.stringMatching(/is done/)])
    expect(err(w.ask('writer', KEY('t6'), { to: 'builder', action: 'x' }))).toEqual([409, expect.stringMatching(/waits on the owner already \(decide\)/)])
    expect(err(w.ask('writer', KEY('t1'), { to: 'builder', action: '' }))).toEqual([400, expect.stringMatching(/send \{action\}/)])
    expect(w.store.armed()).toEqual({})
    expect(w.task('t1').waitingOn).toBeUndefined()
  })

  it('arming twice is idempotent: 200 already, `at` NOT renewed, nothing counted (N9)', () => {
    const w = world()
    w.ask('writer', KEY('t1'), { to: 'builder', action: 'review the draft' })
    const day = new Date(T0).toISOString().slice(0, 10)
    const used = w.store.armsToday('writer', day)
    w.at(T0 + 3 * HOUR)
    const again = w.ask('writer', KEY('t1'), { to: 'builder', action: 'review the draft' })
    expect(again).toMatchObject({ ok: true, value: { already: true, at: new Date(T0).toISOString() } })
    expect(w.store.armedOf(KEY('t1'))!.at).toBe(new Date(T0).toISOString())
    expect(w.store.armsToday('writer', day)).toBe(used)
  })

  it('re-arming over its own linked wait replaces it without renewing `at` (H5); a wait written by hand without a fact is adopted', () => {
    const w = world({ tasks: [T('t1', 'writer'), T('t7', 'writer', 'blocked', { waitingOn: { owner: 'builder', action: 'look at it' } })] })
    w.ask('writer', KEY('t1'), { to: 'builder', action: 'review the draft' })
    w.at(T0 + HOUR)
    expect(w.ask('writer', KEY('t1'), { to: 'builder', action: 'review the second draft', asked: 'Is part 2 right?' })).toMatchObject({
      ok: true,
      value: { already: false },
    })
    expect(w.store.armedOf(KEY('t1'))).toEqual({
      to: 'builder',
      action: 'review the second draft',
      asked: 'Is part 2 right?',
      at: new Date(T0).toISOString(),
      by: 'writer',
    })
    // the hand-written wait, the same ask: adopted — a fact now
    expect(w.ask('writer', KEY('t7'), { to: 'builder', action: 'look at it' })).toMatchObject({ ok: true })
    expect(w.store.armedOf(KEY('t7'))).toMatchObject({ to: 'builder', action: 'look at it' })
    expect(w.flowOf('t7')).toMatchObject({ waitsOnRelay: false, asked: { to: 'builder' } })
  })

  it('the daily cap of arms (ASKS_PER_DAY): the next one is 409, nothing written', () => {
    const tasks = Array.from({ length: ASKS_PER_DAY + 1 }, (_, i) => T(`c${i}`, 'writer'))
    const w = world({ tasks })
    for (let i = 0; i < ASKS_PER_DAY; i++) expect(w.ask('writer', KEY(`c${i}`), { to: 'builder', action: `look ${i}` }).ok).toBe(true)
    const r = w.ask('writer', KEY(`c${ASKS_PER_DAY}`), { to: 'builder', action: 'one more' })
    expect(r).toMatchObject({ ok: false, code: 409 })
    if (!r.ok) expect(r.error).toMatch(new RegExp(`armed ${ASKS_PER_DAY} asks today`))
    expect(w.task(`c${ASKS_PER_DAY}`).waitingOn).toBeUndefined()
    // a new local day: allowed again
    w.at(T0 + DAY)
    expect(w.ask('writer', KEY(`c${ASKS_PER_DAY}`), { to: 'builder', action: 'one more' }).ok).toBe(true)
  })

  it("an ask from an unattended turn carries the existing `ask` mark, with the fact's own moment (H6)", () => {
    const w = world()
    w.ask('writer', KEY('t1'), { to: 'builder', action: 'review it' }, true)
    expect(w.marks).toEqual([{ kind: 'ask', key: KEY('t1'), agent: 'writer', at: new Date(T0).toISOString() }])
  })
})

describe('B2.3 / B2.5 / H5 / H8 — «linked» is derived; linked and in reach is a guard, else the owner relays it', () => {
  it('linked + its beat in reach: `asked`, no relay row; past ASK_REACH_MS: the relay row', () => {
    const w = world()
    w.ask('writer', KEY('t1'), { to: 'builder', action: 'review it' })
    expect(w.flowOf('t1')).toMatchObject({ waitsOnRelay: false, asked: { to: 'builder', at: new Date(T0).toISOString(), seenBy: T0 + HOUR }, stalled: false })
    w.at(T0 + ASK_REACH_MS)
    expect(w.flowOf('t1')).toMatchObject({ waitsOnRelay: true, asked: null })
  })

  it('`to` with no beat in reach — Only when told, archived, its beat days away: the relay from minute zero, and the 200 says so', () => {
    const w = world({ tasks: [T('t1', 'writer'), T('t8', 'writer')] })
    const told = w.ask('writer', KEY('t1'), { to: 'teller', action: 'review it' })
    expect(told).toMatchObject({ ok: true, value: { sees: 'relay' } })
    if (told.ok) expect(told.value.says).toMatch(/the owner relays it/)
    expect(w.flowOf('t1')).toMatchObject({ waitsOnRelay: true, asked: null })
    w.ask('writer', KEY('t8'), { to: 'slowpoke', action: 'review it' })
    expect(w.flowOf('t8')).toMatchObject({ waitsOnRelay: true, asked: null })
    // the reach rule itself: told / archived / no period / asleep past it → none
    const weekly: Period = { every: 1, unit: 'weeks', day: 1, at: '09:00' } as Period
    const minutes: Period = { every: 30, unit: 'minutes' } as Period
    const a = { archived: false, bound: true, own: true, period: minutes }
    expect(askSeenByOf(a, T0)).not.toBeNull()
    expect(askSeenByOf({ ...a, own: false }, T0)).toBeNull()
    expect(askSeenByOf({ ...a, archived: true }, T0)).toBeNull()
    expect(askSeenByOf({ ...a, bound: false }, T0)).toBeNull()
    expect(askSeenByOf({ ...a, period: null }, T0)).toBeNull()
    expect(askSeenByOf({ ...a, sleepUntil: new Date(T0 + 2 * DAY).toISOString() }, T0)).toBeNull()
    // counted from the ask, never from now: the same answer at any moment
    expect(askSeenByOf({ ...a, period: weekly }, T0)).toBe(askSeenByOf({ ...a, period: weekly }, T0))
  })

  it('the wait edited by hand after arming: the relay, no error, the fact kept (H2) — and an answer to it is 409', () => {
    const w = world()
    w.ask('writer', KEY('t1'), { to: 'builder', action: 'review it' })
    w.tasks = w.tasks.map((t) => (t.id === 't1' ? { ...t, waitingOn: { owner: 'builder', action: 'review it, and the tests' } } : t))
    expect(w.flowOf('t1')).toMatchObject({ waitsOnRelay: true, asked: null })
    w.engine.look(T0 + MIN)
    expect(w.store.armedOf(KEY('t1'))).not.toBeNull()
    const r = w.answer('builder', KEY('t1'), 'looks fine')
    expect(r).toMatchObject({ ok: false, code: 409 })
    if (!r.ok) expect(r.error).toMatch(/no longer waits on you through Silos/)
    expect(w.store.armedOf(KEY('t1'))).not.toBeNull()
    // and it is not listed to builder (only linked asks are)
    expect(w.asks.asksTo('builder')).toEqual([])
  })

  it('an empty store with waits on agents in the files: every one is the relay', () => {
    const w = world({
      tasks: [
        T('t1', 'writer', 'blocked', { waitingOn: { owner: 'builder', action: 'review it' } }),
        T('t2', 'builder', 'blocked', { waitingOn: { owner: 'writer', action: 'answer', asked: 'which one?' } }),
      ],
    })
    expect(w.flowOf('t1')).toMatchObject({ waitsOnRelay: true, asked: null })
    expect(w.flowOf('t2')).toMatchObject({ waitsOnRelay: true, asked: null })
    expect(w.asks.asksTo('builder')).toEqual([])
  })

  it('a reader without the record key reads the relay (H5); a task of the owner or of a person waiting on an agent is always the relay (H11)', () => {
    const w = world({
      tasks: [
        T('t1', 'writer'),
        T('t9', 'owner', 'blocked', { waitingOn: { owner: 'builder', action: 'review it' } }),
        T('t10', 'sam', 'blocked', { waitingOn: { owner: 'builder', action: 'review it' } }),
      ],
    })
    w.ask('writer', KEY('t1'), { to: 'builder', action: 'review it' })
    expect(w.flowOf('t1', false)).toMatchObject({ waitsOnRelay: true, asked: null })
    // a fact for them can only be made by hand in the store: still relay
    w.store.update((s) => {
      s.armed[KEY('t9')] = { to: 'builder', action: 'review it', asked: '', at: new Date(T0).toISOString() }
      s.armed[KEY('t10')] = { to: 'builder', action: 'review it', asked: '', at: new Date(T0).toISOString() }
    })
    expect(w.flowOf('t9')).toMatchObject({ waitsOnRelay: true, asked: null })
    expect(w.flowOf('t10')).toMatchObject({ waitsOnRelay: true, asked: null })
    // and the owner's task cannot be armed: only the owner's bearer could, and no bearer is the owner's
    expect(w.ask('writer', KEY('t9'), { to: 'builder', action: 'x' })).toMatchObject({ ok: false, code: 403 })
  })

  it('`plans()` null at boot changes nothing: no fact goes, none is listed, and they read linked again once the plans read', () => {
    const w = world()
    w.ask('writer', KEY('t1'), { to: 'builder', action: 'review it' })
    w.plans(false)
    w.engine.look(T0 + MIN)
    w.engine.deliver(T0 + MIN)
    expect(w.store.armedOf(KEY('t1'))).not.toBeNull()
    expect(w.asks.asksTo('builder')).toEqual([])
    w.plans(true)
    expect(w.asks.asksTo('builder').map((a) => a.key)).toEqual([KEY('t1')])
    expect(w.flowOf('t1')).toMatchObject({ asked: { to: 'builder' } })
  })

  it('a fact goes by age (WAKE_KEEP_MS), never by comparison', () => {
    const w = world()
    w.ask('writer', KEY('t1'), { to: 'builder', action: 'review it' })
    w.tasks = w.tasks.map((t) => (t.id === 't1' ? { ...t, waitingOn: { owner: 'owner', action: 'decide' } } : t))
    w.store.update(() => {}, T0 + DAY)
    expect(w.store.armedOf(KEY('t1'))).not.toBeNull()
    w.store.update(() => {}, T0 + WAKE_KEEP_MS + MIN)
    expect(w.store.armedOf(KEY('t1'))).toBeNull()
  })
})

describe('B2.6 / H1 — answering: the write first, then the fact; the answer wakes the one who waits', () => {
  it('ONE write (note by `to`, wait out, blocked → pending), then the fact consumed and an `answered` wake with the text in its notes', () => {
    const w = world()
    w.ask('writer', KEY('t1'), { to: 'builder', action: 'answer the pricing question', asked: 'Which tier first?' })
    w.at(T0 + 10 * MIN)
    const r = w.answer('builder', KEY('t1'), '  Pro first, Team next.  ')
    expect(r).toMatchObject({ ok: true, value: { state: 'pending', woke: true } })
    const t = w.task('t1')
    expect(t.waitingOn).toBeUndefined()
    expect(t.status).toBe('pending')
    expect(t.notes).toEqual([{ at: new Date(T0 + 10 * MIN).toISOString(), by: 'builder', text: 'Pro first, Team next.' }])
    expect(w.store.armedOf(KEY('t1'))).toBeNull()
    const wake = w.store.wakes().find((x) => x.reason === 'answered')!
    expect(wake).toMatchObject({ agent: 'writer', task: KEY('t1'), answeredBy: 'builder', notes: [{ by: 'builder', text: 'Pro first, Team next.' }] })
    expect(wake.gesture).toBeUndefined()
    expect(wake.bypassThrottle).toBe(false)
    // an attended answer is not held for an audit: it goes at once
    expect(wake.answeredIn).toBeUndefined()
    expect(wake.state).toBe('delivered')
    expect(w.sent.map((s) => s.agentId)).toEqual(['writer'])
    expect(w.sent[0]!.text).toMatch(/Builder answered what you asked through Silos/)
    expect(w.sent[0]!.text).toMatch(/- Builder \(.*\): Pro first, Team next\./)
  })

  it('answering twice: the second is 409 — no fact left', () => {
    const w = world()
    w.ask('writer', KEY('t1'), { to: 'builder', action: 'review it' })
    expect(w.answer('builder', KEY('t1'), 'fine').ok).toBe(true)
    const again = w.answer('builder', KEY('t1'), 'fine')
    expect(again).toMatchObject({ ok: false, code: 409 })
    if (!again.ok) expect(again.error).toMatch(/nothing asks you on/)
    expect(w.task('t1').notes).toHaveLength(1)
  })

  it('the wrong bearer: 403, nothing written, the fact kept', () => {
    const w = world()
    w.ask('writer', KEY('t1'), { to: 'builder', action: 'review it' })
    const r = w.answer('teller', KEY('t1'), 'not me')
    expect(r).toMatchObject({ ok: false, code: 403 })
    if (!r.ok) expect(r.error).toMatch(/asks Builder, not you/)
    expect(w.store.armedOf(KEY('t1'))).not.toBeNull()
    expect(w.task('t1').notes).toEqual([])
  })

  it('a review: in_review → pending, the owner woken, the reviewer closes nothing (B2.9)', () => {
    const w = world({ tasks: [T('t1', 'writer', 'in_progress')] })
    w.ask('writer', KEY('t1'), { to: 'builder', action: 'review the draft', review: true })
    expect(w.answer('builder', KEY('t1'), 'Approved — ship it.')).toMatchObject({ ok: true, value: { state: 'pending' } })
    expect(w.task('t1').status).toBe('pending')
  })

  it('blocked → pending only when nothing else holds it: an open dependency keeps it blocked', () => {
    const w = world({ tasks: [T('t1', 'writer', 'blocked', { dependsOn: ['t4'] }), T('t4', 'sam')] })
    w.ask('writer', KEY('t1'), { to: 'builder', action: 'answer it' })
    expect(w.answer('builder', KEY('t1'), 'yes').ok).toBe(true)
    expect(w.task('t1').status).toBe('blocked')
  })

  it('a write that fails keeps the fact and loses nothing: `to` sends it again (H1)', () => {
    const w = world()
    w.ask('writer', KEY('t1'), { to: 'builder', action: 'review it' })
    w.fail('before')
    expect(w.answer('builder', KEY('t1'), 'all good')).toMatchObject({ ok: false, code: 409 })
    w.fail('after')
    expect(w.answer('builder', KEY('t1'), 'all good')).toMatchObject({ ok: false, code: 400 })
    // the stamper's registration of the write that did not land is undone
    expect(w.own.at(-1)).toMatchObject({ key: KEY('t1'), undone: true })
    expect(w.store.armedOf(KEY('t1'))).not.toBeNull()
    expect(w.store.wakes().filter((x) => x.reason === 'answered')).toEqual([])
    w.fail(null)
    expect(w.answer('builder', KEY('t1'), 'all good').ok).toBe(true)
    expect(w.task('t1').notes.map((n: Json) => n.text)).toEqual(['all good'])
  })

  it("the owner answered first (the wait gone): `to`'s answer is 409, nothing written", () => {
    const w = world()
    w.ask('writer', KEY('t1'), { to: 'builder', action: 'review it' })
    w.tasks = w.tasks.map((t) => (t.id === 't1' ? { ...t, status: 'pending', waitingOn: undefined, notes: [{ at: 'x', by: 'owner', text: 'I did it' }] } : t))
    expect(w.answer('builder', KEY('t1'), 'too late')).toMatchObject({ ok: false, code: 409 })
  })

  it('an owner Task mode does not wake: the note lands, no wake', () => {
    const w = world({ tasks: [T('t1', 'teller')] })
    w.ask('teller', KEY('t1'), { to: 'builder', action: 'review it' })
    expect(w.answer('builder', KEY('t1'), 'fine')).toMatchObject({ ok: true, value: { woke: false } })
    expect(w.store.wakes()).toEqual([])
  })

  it('two agents asking each other: each fact its own, each answer wakes the other', () => {
    const w = world()
    w.ask('writer', KEY('t1'), { to: 'builder', action: 'review my part' })
    w.ask('builder', KEY('t2'), { to: 'writer', action: 'review mine' })
    expect(w.asks.asksTo('builder').map((a) => a.key)).toEqual([KEY('t1')])
    expect(w.asks.asksTo('writer').map((a) => a.key)).toEqual([KEY('t2')])
    expect(w.answer('writer', KEY('t2'), 'yours is fine').ok).toBe(true)
    expect(w.answer('builder', KEY('t1'), 'yours too').ok).toBe(true)
    expect(
      w.store
        .wakes()
        .filter((x) => x.reason === 'answered')
        .map((x) => [x.agent, x.answeredBy]),
    ).toEqual([
      ['builder', 'writer'],
      ['writer', 'builder'],
    ])
  })

  it('H9 — the round trips are capped at ARM time: after 3 answered wakes of that answerer on that task in 24 h, the next ask is 409; nothing is held', async () => {
    const w = world()
    for (let i = 0; i < ANSWERS_PER_TASK_DAY; i++) {
      w.at(T0 + i * HOUR)
      expect(w.ask('writer', KEY('t1'), { to: 'builder', action: `round ${i}` }).ok).toBe(true)
      expect(w.answer('builder', KEY('t1'), `answer ${i}`).ok).toBe(true)
      // the woken turn ends before the next round
      await new Promise((r) => setImmediate(r))
    }
    expect(w.store.wakes().filter((x) => x.reason === 'answered' && x.state === 'delivered')).toHaveLength(ANSWERS_PER_TASK_DAY)
    w.at(T0 + 4 * HOUR)
    const r = w.ask('writer', KEY('t1'), { to: 'builder', action: 'round 4' })
    expect(r).toMatchObject({ ok: false, code: 409 })
    if (!r.ok) expect(r.error).toMatch(new RegExp(`asked ${ANSWERS_PER_TASK_DAY} times today on this task`))
    // another answerer is not capped by builder's round trips
    expect(w.ask('writer', KEY('t1'), { to: 'slowpoke', action: 'round 4' }).ok).toBe(true)
    // nothing was held by the cap
    expect(w.store.queued().filter((x) => x.holdClass === 'throttle')).toEqual([])
    // a day later builder can be asked again
    w.tasks = w.tasks.map((t) => (t.id === 't1' ? { ...t, status: 'pending', waitingOn: undefined } : t))
    w.at(T0 + 2 * DAY)
    expect(w.ask('writer', KEY('t1'), { to: 'builder', action: 'round 5' }).ok).toBe(true)
  })
})

describe("H3 — an answer from an unattended turn: the `answered` wake waits for that turn's audit (class `turn`)", () => {
  it("held while the turn runs; then its notes carry the audit's mark and it goes", () => {
    const w = world()
    w.ask('writer', KEY('t1'), { to: 'builder', action: 'review it' })
    w.live.add('builder|run-builder')
    expect(w.answer('builder', KEY('t1'), 'fine', true).ok).toBe(true)
    // H4: markNote only on answering
    expect(w.marks).toEqual([{ kind: 'note', key: KEY('t1'), agent: 'builder', at: new Date(T0).toISOString() }])
    let wake = w.store.wakes().find((x) => x.reason === 'answered')!
    expect(wake).toMatchObject({ state: 'queued', holdClass: 'turn', answeredIn: { agent: 'builder', run: 'run-builder' } })
    expect(wake.held).toMatch(/Builder's turn that answered is still running/)
    w.live.clear()
    w.at(T0 + MIN)
    w.engine.deliver(T0 + MIN)
    wake = w.store.wakes().find((x) => x.reason === 'answered')!
    expect(wake).toMatchObject({ state: 'queued', holdClass: 'turn' })
    expect(wake.held).toMatch(/audit of Builder's turn that answered is not in yet/)
    w.audits.set('builder|run-builder', ['WebFetch'])
    w.engine.deliver(T0 + 2 * MIN)
    wake = w.store.wakes().find((x) => x.reason === 'answered')!
    expect(wake.state).toBe('delivered')
    expect(wake.answeredIn).toBeUndefined()
    expect(wake.notes[0]!.readOutside).toEqual(['WebFetch'])
    expect(w.sent.at(-1)!.text).toMatch(/written after reading the web \(WebFetch\)/)
  })

  it('a turn that ended with no audit MISSING_KEEP_MS after: it goes marked «transcript unreadable» (closed by default)', () => {
    const w = world()
    w.ask('writer', KEY('t1'), { to: 'builder', action: 'review it' })
    expect(w.answer('builder', KEY('t1'), 'fine', true).ok).toBe(true)
    let wake = w.store.wakes().find((x) => x.reason === 'answered')!
    expect(wake).toMatchObject({ state: 'queued', holdClass: 'turn', answeredIn: { endedAt: new Date(T0).toISOString() } })
    w.engine.deliver(T0 + MISSING_KEEP_MS - MIN)
    expect(w.store.wakes().find((x) => x.reason === 'answered')!.state).toBe('queued')
    w.engine.deliver(T0 + MISSING_KEEP_MS)
    wake = w.store.wakes().find((x) => x.reason === 'answered')!
    expect(wake.state).toBe('delivered')
    expect(wake.notes[0]!.readOutside).toEqual([TRANSCRIPT_UNREADABLE])
  })
})

describe("H11 — `armed` and the day's count survive a restart (store.load copies them)", () => {
  it('a new store over the same data dir reads the fact and the count; a malformed fact is dropped', () => {
    const dir = mkdtempSync(join(base, 'restart-'))
    const w = world({ store: new TaskModeStore(dir) })
    w.ask('writer', KEY('t1'), { to: 'builder', action: 'review it', asked: 'ok?' })
    const again = new TaskModeStore(dir)
    expect(again.armedOf(KEY('t1'))).toEqual({ to: 'builder', action: 'review it', asked: 'ok?', at: new Date(T0).toISOString(), by: 'writer' })
    expect(again.armsToday('writer', new Date(T0).toISOString().slice(0, 10))).toBe(1)
    const w2 = world({ store: again, tasks: w.tasks })
    expect(w2.answer('builder', KEY('t1'), 'yes').ok).toBe(true)
  })
})

describe("B2.10 / H10 — the escalation's agent hop arms the same fact", () => {
  it("writeHop + armHop: the wait and blocked in one write the stamper expects, the fact with asked ''; it is listed to the hop as Silos' own; its answer clears the wait", () => {
    const w = world({ tasks: [T('t1', 'writer', 'in_progress')] })
    expect(w.asks.writeHop(KEY('t1'), 'builder', 'unstick launch#t1')).toBe(true)
    w.asks.armHop(KEY('t1'), 'builder', 'unstick launch#t1')
    expect(w.task('t1')).toMatchObject({ status: 'blocked', waitingOn: { owner: 'builder', action: 'unstick launch#t1' } })
    expect(w.store.armedOf(KEY('t1'))).toMatchObject({ to: 'builder', action: 'unstick launch#t1', asked: '' })
    expect(w.asks.hopArmed(KEY('t1'), 'builder', 'unstick launch#t1')).toBe(true)
    // not counted in anybody's day
    expect(w.store.armsToday('writer', new Date(T0).toISOString().slice(0, 10))).toBe(0)
    // the hop sees it as Silos' own ask; its wait is never the relay (H8), with or without the fact
    expect(w.asks.asksTo('builder')).toMatchObject([{ key: KEY('t1'), silos: true }])
    expect(w.flowOf('t1')).toMatchObject({ waitsOnRelay: false, asked: null })
    expect(w.answer('builder', KEY('t1'), 'Writer needs the API key — it is in the vault now.')).toMatchObject({ ok: true, value: { state: 'pending' } })
    expect(w.task('t1').waitingOn).toBeUndefined()
    // a second arm of the same hop keeps its fact
    const w2 = world({ tasks: [T('t1', 'writer', 'blocked', { waitingOn: { owner: 'builder', action: 'unstick launch#t1' } })] })
    w2.asks.armHop(KEY('t1'), 'builder', 'unstick launch#t1')
    const at = w2.store.armedOf(KEY('t1'))!.at
    w2.at(T0 + HOUR)
    w2.asks.armHop(KEY('t1'), 'builder', 'unstick launch#t1')
    expect(w2.store.armedOf(KEY('t1'))!.at).toBe(at)
    // the hop's write over a wait already so writes nothing
    const before = w2.own.length
    expect(w2.asks.writeHop(KEY('t1'), 'builder', 'unstick launch#t1')).toBe(true)
    expect(w2.own.length).toBe(before)
  })
  it("(R3) a hop to an agent outside the task's project writes and arms nothing — the ask's bound on `to`", () => {
    const w = world({ tasks: [T('t1', 'writer', 'in_progress')], ofProject: (id) => id !== 'builder' })
    expect(w.asks.writeHop(KEY('t1'), 'builder', 'unstick launch#t1')).toBe(false)
    w.asks.armHop(KEY('t1'), 'builder', 'unstick launch#t1')
    expect(w.task('t1')).toMatchObject({ status: 'in_progress' })
    expect(w.task('t1').waitingOn).toBeUndefined()
    expect(w.store.armedOf(KEY('t1'))).toBeNull()
  })
})
