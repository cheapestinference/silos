// task-flow-invariant.test.ts — the invariant «every open task
// has a next step», over the product its parts A1 and A2 name:
//
//   I. An open task has, at every moment, at least ONE guard. With none it is
//      stalled — and every stall has a way out. Never «ok» without a guard.
//
// {owner: the owner · a bound agent · a told agent · an archived agent ·
//         a named person · nobody (A2)}
// × {pending · in_progress · in_review · blocked}
// × {no conversation · a live one · one that is not live}
// × {no dependency · an open one · a done one · and the chains of A2: an id
//    the plan lacks · an id the file holds but can't be read · a cancelled
//    blocker · a cycle of 2 and of 3 with mixed owners · a blocker nobody owns}
// × {no wait · a wait on the owner · a wait on an agent — and, by B2, the
//    same wait LINKED to an ask fact in reach · written by hand (a fact that
//    does not match) · the ask consumed (answered: the wait out, the fact
//    left behind)}
// × {no next check · one ahead · one past}
//
// ONE assertion for every shape: a guard (the guard table, read independently of
// the flow), OR stalled, OR one of the owner's rows (waitsStart, idle,
// waitsOnHuman, waitsOnRelay) — B2.5: a linked ask on an AGENT's task is a
// guard and never the relay row; by hand, or on a person's task, the row —
// and, hardened by A2, for EVERY task of the
// shape's plan: a stall has its seat (stalledAt); the seat of a seat is itself
// or is not stalled; and a stall whose way out is a wake (stallExit) really
// FIRES `stalled:<cause>@…` when Task mode evaluates the plan over two looks
// (the first is the baseline) — and no other task of the plan fires one.
import { describe, expect, it } from 'vitest'
import { dictionaryForKind, type FieldDict } from '../src/silos/expressions.js'
import { stallExit, taskFlow, type AskFact, type TaskEnv, type TaskFlow } from '../src/silos/task-flow.js'
import { taskFlowRecords, type KindRecord } from '../src/silos/voice.js'
import { taskSnapshots } from '../src/task-mode/engine.js'
import { evaluateTaskWakes } from '../src/task-mode/evaluate.js'
import type { SiloReading } from '../src/silos/reader.js'

type Json = Record<string, any>
const NOW = Date.parse('2026-11-21T12:00:00Z')
const DAY = 24 * 3600_000

function planSpec(): Json {
  const STATES = ['pending', 'in_progress', 'in_review', 'blocked', 'done', 'cancelled']
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

// the agents: one bound to Task mode, one Only when told, one archived (still
// an agent id — isAgent — out of play: it never wakes and can't be started),
// and the one a wait names; `owner` is the owner, `sam` a named person
const OWNERS = { owner: 'owner', bound: 'writer', told: 'teller', archived: 'gone', person: 'sam', nobody: '' } as const
const AGENTS = new Set(['writer', 'teller', 'gone', 'helper'])
const isAgent = (v: string): boolean => AGENTS.has(v)
const BOUND = new Set(['writer'])
const ENV: TaskEnv = {
  isLive: (s) => s === 'sess-live',
  wakes: (a) => (BOUND.has(a) ? 'task' : 'never'),
  startable: (a) => a === 'writer' || a === 'teller' || a === 'helper',
  wakeOnTheWay: () => false,
}

type Owner = keyof typeof OWNERS
type State = 'pending' | 'in_progress' | 'in_review' | 'blocked'
type Conv = 'none' | 'live' | 'not-live'
type Deps = 'none' | 'open' | 'done' | 'missing' | 'unreadable' | 'cancelled' | 'cycle2' | 'cycle3' | 'unowned'
// (B2) agent-linked: the wait an ask wrote, its fact in Task mode's store, the
// asked agent's beat in reach · agent-hand: a wait on an agent whose fact
// says something else (edited by hand) · consumed: answered — the wait out,
// the fact still there (inert)
type Wait = 'none' | 'owner' | 'agent' | 'agent-linked' | 'agent-hand' | 'consumed'
const WAITS: Wait[] = ['none', 'owner', 'agent', 'agent-linked', 'agent-hand', 'consumed']
type Check = 'none' | 'future' | 'past'
interface Shape {
  owner: Owner
  state: State
  conv: Conv
  deps: Deps
  wait: Wait
  check: Check
}
const DEPS: Deps[] = ['none', 'open', 'done', 'missing', 'unreadable', 'cancelled', 'cycle2', 'cycle3', 'unowned']

const nameOf = (s: Shape): string => `${s.owner} · ${s.state} · conversation ${s.conv} · deps ${s.deps} · wait ${s.wait} · check ${s.check}`

function shapes(): Shape[] {
  const out: Shape[] = []
  for (const owner of Object.keys(OWNERS) as Owner[])
    for (const state of ['pending', 'in_progress', 'in_review', 'blocked'] as State[])
      for (const conv of ['none', 'live', 'not-live'] as Conv[])
        for (const deps of DEPS)
          for (const wait of WAITS) for (const check of ['none', 'future', 'past'] as Check[]) out.push({ owner, state, conv, deps, wait, check })
  return out
}

// the shape's plan: the task `a` and what its dependency dimension names
function planOf(s: Shape): { tasks: Json[]; unreadable: string[] } {
  const a: Json = {
    id: 'a',
    owner: OWNERS[s.owner],
    state: s.state,
    dependsOn: [],
    conversations: s.conv === 'none' ? [] : [s.conv === 'live' ? 'sess-live' : 'sess-old'],
    ...(s.wait === 'owner'
      ? { waitingOn: { owner: 'owner', action: 'decide' } }
      : s.wait === 'agent' || s.wait === 'agent-linked' || s.wait === 'agent-hand'
        ? { waitingOn: { owner: 'helper', action: 'deploy it' } }
        : {}),
    ...(s.check === 'future'
      ? { nextCheckAt: new Date(NOW + DAY).toISOString() }
      : s.check === 'past'
        ? { nextCheckAt: new Date(NOW - DAY).toISOString() }
        : {}),
  }
  const T = (id: string, owner: string, state: string, dependsOn: string[] = []): Json => ({ id, owner, state, dependsOn, conversations: [] })
  switch (s.deps) {
    case 'none':
      return { tasks: [a], unreadable: [] }
    // the blocker: the owner's own pending task — guarded (G3), so an open
    // dependency on it is a guarded chain (G6)
    case 'open':
      return { tasks: [{ ...a, dependsOn: ['b'] }, T('b', 'owner', 'pending')], unreadable: [] }
    case 'done':
      return { tasks: [{ ...a, dependsOn: ['b'] }, T('b', 'owner', 'done')], unreadable: [] }
    case 'missing':
      return { tasks: [{ ...a, dependsOn: ['ghost'] }], unreadable: [] }
    case 'unreadable':
      return { tasks: [{ ...a, dependsOn: ['u'] }], unreadable: ['u'] }
    case 'cancelled':
      return { tasks: [{ ...a, dependsOn: ['b'] }, T('b', 'owner', 'cancelled')], unreadable: [] }
    // mixed owners: a told agent closes the 2-cycle; the 3-cycle runs through
    // a bound agent and a person
    case 'cycle2':
      return { tasks: [{ ...a, dependsOn: ['c1'] }, T('c1', 'teller', 'blocked', ['a'])], unreadable: [] }
    case 'cycle3':
      return { tasks: [{ ...a, dependsOn: ['c1'] }, T('c1', 'writer', 'blocked', ['c2']), T('c2', 'sam', 'pending', ['a'])], unreadable: [] }
    case 'unowned':
      return { tasks: [{ ...a, dependsOn: ['b'] }, T('b', '', 'pending')], unreadable: [] }
  }
}
// (B2) the ask fact of the shape's task `a` — armed an hour ago, the asked
// agent's next beat an hour after that (in reach)
const ASKED_AT = new Date(NOW - 3600_000).toISOString()
const factOf = (w: Wait): AskFact | null =>
  w === 'agent-linked' || w === 'consumed'
    ? { to: 'helper', action: 'deploy it', asked: '', at: ASKED_AT, seenBy: NOW + 3600_000 }
    : w === 'agent-hand'
      ? { to: 'helper', action: 'deploy the other thing', asked: '', at: ASKED_AT, seenBy: NOW + 3600_000 }
      : null
const envs = new Map<Wait, TaskEnv>()
const envOf = (w: Wait = 'none'): TaskEnv => {
  let e = envs.get(w)
  if (!e) {
    const f = factOf(w)
    e = { ...ENV, askOf: (key) => (key === 'folder:/w/p/tasks/a' ? f : null) }
    envs.set(w, e)
  }
  return e
}
const flowIn = (id: string, p: { tasks: Json[]; unreadable: string[] }, w: Wait = 'none'): TaskFlow =>
  taskFlow(
    p.tasks.find((t) => t.id === id)!,
    p.tasks,
    DICT,
    { now: NOW, isAgent, taskEnv: envOf(w), key: `folder:/w/p/tasks/${id}`, unreadableSiblings: p.unreadable },
  )

// The guards, read from the shape — never from the flow under test — in the
// order of own()
function guarded(s: Shape): boolean {
  if (s.conv === 'live') return true // G1
  if (s.wait !== 'none' && s.wait !== 'consumed') return true // a wait naming someone (G4 when Silos carries it — B2.5 —, else its row: waitsOnHuman / waitsOnRelay)
  if (s.check === 'future') return true // G5: Task mode fires it, or it comes back to the owner — a task nobody owns too (E11)
  if (s.owner === 'nobody') return false // nobody owns it: no guard
  if (s.check === 'past' && s.owner === 'bound') return true // G5: Task mode fires or clears it (A1.4)
  const human = s.owner === 'owner' || s.owner === 'person'
  if (s.state === 'in_review') return human // a person reviews it; an agent's has nobody
  if (s.deps === 'open') return true // G6: its blocker is the owner's own task
  if (s.deps === 'unreadable') return true // A1.8's row («N tasks in <plan> can't be read») guards it (E11)
  if (s.deps !== 'none' && s.deps !== 'done') return false // a dead chain is never a guard
  return human // G3
}
function wayOut(s: Shape): boolean {
  const f = flowIn('a', planOf(s), s.wait)
  return guarded(s) || f.stalled || f.waitsStart || f.idle || f.waitsOnHuman || f.waitsOnRelay
}
// (B2.5, H11) which of the two a wait on an agent is, read from the shape:
// Silos carries it (an agent's task, linked, in reach) — or the owner relays it
function relayOf(s: Shape): 'carried' | 'relay' | null {
  if (s.wait === 'agent-linked') return s.owner === 'bound' || s.owner === 'told' || s.owner === 'archived' ? 'carried' : 'relay'
  if (s.wait === 'agent' || s.wait === 'agent-hand') return 'relay'
  return null
}

// Task mode over the shape's plan, through the real cascade (E5): the
// kernel's flow → voice.taskFlowRecords → taskSnapshots → evaluateTaskWakes,
// two looks (the first is the baseline): the stalled wakes it fires, by task id
function stalledFired(p: { tasks: Json[]; unreadable: string[] }): Map<string, string[]> {
  const base: KindRecord[] = [
    {
      rec: { id: 'p', tasks: p.tasks },
      anchors: {},
      key: 'folder:/w/p',
      file: null,
      ...(p.unreadable.length > 0 ? { unreadableChildren: { tasks: p.unreadable } } : {}),
    },
  ]
  const facts = taskFlowRecords(MANIFEST, base, { now: NOW, isAgent, taskEnv: ENV })
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
        record: { id: 'p', title: 'P', tasks: p.tasks },
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
  const snaps = taskSnapshots(reading, facts)
  const first = evaluateTaskWakes({ tasks: snaps, bound: BOUND, prev: {}, now: NOW })
  const second = evaluateTaskWakes({ tasks: snaps, bound: BOUND, prev: first.observations, now: NOW + 30_000 })
  const out = new Map<string, string[]>()
  for (const w of [...first.wakes, ...second.wakes].filter((x) => x.reason === 'stalled')) {
    const id = w.task.slice(w.task.lastIndexOf('/') + 1)
    out.set(id, [...(out.get(id) ?? []), w.key])
  }
  return out
}

describe("every open task has a guard, or is stalled, or is one of the owner's rows", () => {
  const all = shapes()
  it(`the product: ${all.length} shapes`, () => {
    // (B2) changed on purpose: the wait dimension gains linked / by hand / consumed
    expect(all).toHaveLength(6 * 4 * 3 * 9 * 6 * 3)
  })
  it('every shape has its way out — A2 left none open', () => {
    expect(all.filter((s) => !wayOut(s)).map(nameOf)).toEqual([])
  })
  it("B2.5: a wait on an agent is EITHER carried by Silos (a guard — `asked`, no relay row) OR the owner's relay — never both, never neither; an ask consumed leaves no wait to relay", () => {
    const wrong: string[] = []
    for (const s of all) {
      const f = flowIn('a', planOf(s), s.wait)
      const want = relayOf(s)
      const got = f.asked !== null ? 'carried' : f.waitsOnRelay ? 'relay' : null
      // F12: an agent's review waiting on its own owner is no relay — not reached here (the wait names `helper`)
      if (got !== want) wrong.push(`${nameOf(s)} — ${got ?? 'neither'}, want ${want ?? 'neither'}`)
      if (f.asked !== null && f.waitsOnRelay) wrong.push(`${nameOf(s)} — both`)
    }
    expect(wrong).toEqual([])
  })
  it('hardened (A2.5): every stall of the plan has its seat; the seat of a seat is itself or is not stalled; a wake way out FIRES over two looks — and nothing else fires a stalled wake', () => {
    const broken: string[] = []
    const exits = { wake: 0, row: 0, seat: 0 }
    for (const s of all) {
      const p = planOf(s)
      const fired = stalledFired(p)
      for (const t of p.tasks) {
        if (t.state === 'done' || t.state === 'cancelled') continue
        const id = String(t.id)
        const f = flowIn(id, p, s.wait)
        if (!f.stalled) {
          if (fired.has(id)) broken.push(`${nameOf(s)} — ${id} not stalled but woken`)
          continue
        }
        if (f.stalledAt === null) {
          broken.push(`${nameOf(s)} — ${id} stalled with no seat`)
          continue
        }
        const seat = f.stalledAt
        const sf = p.tasks.some((x) => x.id === seat) ? flowIn(seat, p, s.wait) : null
        if (sf && sf.stalled && sf.stalledAt !== seat) broken.push(`${nameOf(s)} — ${id}'s seat ${seat} sits at ${sf.stalledAt}`)
        const exit = stallExit(f, { id, owner: String(t.owner).trim(), bound: (o) => ENV.wakes(o) === 'task' && isAgent(o) })
        if (exit) exits[exit]++
        const keys = fired.get(id) ?? []
        if (exit === 'wake' && !keys.some((k) => k.startsWith(`stalled:${f.stalledCause}@`)))
          broken.push(`${nameOf(s)} — ${id}'s way out is a wake that never fires`)
        if (exit !== 'wake' && keys.length > 0) broken.push(`${nameOf(s)} — ${id} (way out ${exit}) was woken`)
      }
    }
    expect(broken).toEqual([])
    // never vacuous: the product reaches every way out
    expect(exits.wake).toBeGreaterThan(0)
    expect(exits.row).toBeGreaterThan(0)
    expect(exits.seat).toBeGreaterThan(0)
  })
})

// A2 closed the six shapes A1 left open (they were it.todo here): four are
// flow tests below; the stopped console lives in task-mode-holds.test.ts, the
// row for a task nobody (or a person) owns in inbox-stalled-task-rows.test.ts
describe('A2 — the shapes A1 left without a way out', () => {
  const T = (id: string, owner: string, state: string, dependsOn: string[] = [], over: Json = {}): Json => ({
    id,
    owner,
    state,
    dependsOn,
    conversations: [],
    ...over,
  })
  const plan = (tasks: Json[]) => ({ tasks, unreadable: [] as string[] })
  it('an agent Silos does not wake (told or archived), in review, its next check already past, no wait: review-without-reviewer, its own seat, a row (A2.1)', () => {
    for (const o of ['teller', 'gone']) {
      const p = plan([T('a', o, 'in_review', [], { nextCheckAt: new Date(NOW - DAY).toISOString() })])
      const f = flowIn('a', p)
      expect(f).toMatchObject({ stalled: true, stalledCause: 'review-without-reviewer', stalledAt: 'a' })
      expect(stallExit(f, { id: 'a', owner: o, bound: (x) => BOUND.has(x) })).toBe('row')
    }
  })
  it("a person's task whose chain is dead (a dependency naming no task, a cancelled blocker, a cycle) is walked — stalled at the right seat (A2.6)", () => {
    expect(flowIn('a', plan([T('a', 'sam', 'pending', ['ghost'])]))).toMatchObject({
      stalled: true,
      stalledCause: 'blocker-missing',
      stalledBy: 'ghost',
      stalledAt: 'a',
    })
    expect(flowIn('a', plan([T('a', 'owner', 'pending', ['b']), T('b', 'writer', 'cancelled')]))).toMatchObject({
      stalled: true,
      stalledCause: 'blocker-cancelled',
      stalledAt: 'a',
    })
    expect(flowIn('a', plan([T('a', 'sam', 'blocked', ['b']), T('b', 'teller', 'blocked', ['a'])]))).toMatchObject({
      stalled: true,
      stalledCause: 'blocker-cycle',
      stalledBy: 'b',
      stalledAt: 'a',
    })
    // a healthy chain stays a guard: waiting on a bound agent's ready task
    expect(flowIn('a', plan([T('a', 'owner', 'pending', ['b']), T('b', 'writer', 'pending')]))).toMatchObject({ stalled: false })
  })
  it('no depth cap and linear (A2.7): a chain of 200 reaches its bottom; a ladder of 40 diamonds is walked looking at each task once', () => {
    const n = 200
    const chain = Array.from({ length: n }, (_, i) => T(`t${i}`, 'writer', 'blocked', i + 1 < n ? [`t${i + 1}`] : []))
    chain[n - 1] = T(`t${n - 1}`, 'sam', 'blocked', ['ghost'])
    expect(flowIn('t0', plan(chain))).toMatchObject({ stalled: true, stalledCause: 'blocker-missing', stalledBy: 'ghost', stalledAt: `t${n - 1}` })
    // 40 diamonds: top_i → {l_i, r_i} → top_{i+1}; healthy at the bottom (the
    // owner's own task). Without remembering healthy verdicts the walk is 2^40.
    const tasks: Json[] = []
    for (let i = 0; i < 40; i++) {
      tasks.push(T(`top${i}`, 'writer', 'blocked', [`l${i}`, `r${i}`], { conversations: [`s-top${i}`] }))
      tasks.push(
        T(`l${i}`, 'writer', 'blocked', [`top${i + 1}`], { conversations: [`s-l${i}`] }),
        T(`r${i}`, 'writer', 'blocked', [`top${i + 1}`], { conversations: [`s-r${i}`] }),
      )
    }
    tasks.push(T('top40', 'owner', 'pending', [], { conversations: ['s-top40'] }))
    const asked = new Map<string, number>()
    const counting: TaskEnv = {
      ...ENV,
      isLive: (sid) => {
        asked.set(sid, (asked.get(sid) ?? 0) + 1)
        return false
      },
    }
    const f = taskFlow(tasks[0]!, tasks, DICT, { now: NOW, isAgent, taskEnv: counting })
    expect(f.stalled).toBe(false)
    // the visit bound: every task looked at once (its liveness asked once)
    expect(asked.size).toBe(tasks.length)
    expect([...asked.values()].every((k) => k === 1)).toBe(true)
  })
  it("a wait naming a person who is neither the owner nor an agent is waitsOnHuman, not waitsOnRelay (A2.2: A1.6's second clause retired)", () => {
    expect(flowIn('a', plan([T('a', 'writer', 'blocked', [], { waitingOn: { owner: 'sam', action: 'sign it' } })]))).toMatchObject({
      waitsOnHuman: true,
      waitsOnRelay: false,
      stalled: false,
    })
  })
})
