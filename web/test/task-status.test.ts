// A blocked task says which blocked it is:
// covered when its chain ends in an agent's work, on you when it ends in a
// person, stuck when the kernel says so anywhere in the chain. The kernel's
// flow is the truth; the walk only names where the chain ends.
import { describe, expect, it } from 'vitest'
import { boardColumns, readBlocked, siblingsOf, waitFacts, taskOfRow as rawTaskOfRow, type ChainFacts, type TaskView } from '../src/lib/tasks'
import type { SiloRecordRow, SiloTaskFlow } from '../src/lib/types'
import { serverTaskRow } from './server-task-row'
const taskOfRow = (r: Parameters<typeof rawTaskOfRow>[0]): ReturnType<typeof rawTaskOfRow> => rawTaskOfRow(serverTaskRow(r))

const PLAN = 'folder:/home/u/proj/ship'
const flow = (over: Partial<SiloTaskFlow> = {}): SiloTaskFlow => ({
  waiting: false,
  gate: false,
  unblocks: [],
  stalled: false,
  stalledCause: null,
  stalledBy: null,
  ...over,
})
const task = (id: string, value: Record<string, unknown>, f: Partial<SiloTaskFlow> = {}): TaskView =>
  taskOfRow({
    key: `${PLAN}/tasks/${id}`,
    id,
    identity: id,
    state: String(value.state ?? 'pending'),
    stateLabel: String(value.state ?? 'pending'),
    at: null,
    anchors: { folder: '/home/u/proj' },
    cells: [],
    row: '',
    folded: false,
    overlay: false,
    conflict: false,
    remarks: [],
    file: '/home/u/proj/plans/ship.plan.json',
    parent: { key: PLAN, identity: 'Ship it', at: null },
    flow: flow(f),
    value: { id, owner: 'writer', dependsOn: [], conversations: [], notes: [], ...value },
    moved: null,
  } as SiloRecordRow)!
const facts = (live: string[] = []): ChainFacts => ({
  agentIds: new Set(['writer', 'builder']),
  isLive: (t) => live.includes(t.id),
  nameOf: (id) => id.toUpperCase(),
})
const read = (t: TaskView, tasks: TaskView[], live: string[] = []) => readBlocked(t, siblingsOf(tasks, PLAN), facts(live))

describe('which blocked', () => {
  it('only a blocked task has a reading', () => {
    const t = task('t1', { state: 'pending' })
    expect(read(t, [t])).toBeNull()
  })

  it('covered: the chain ends in work an agent is doing now', () => {
    const b = task('b', { state: 'in_progress', owner: 'builder' })
    const t = task('t', { state: 'blocked', dependsOn: ['b'] })
    expect(read(t, [t, b], ['b'])).toMatchObject({ tone: 'covered', why: expect.stringContaining('ship#b') })
  })

  it('covered: the chain ends in an agent the kernel found guarded, though nothing runs yet', () => {
    const b = task('b', { state: 'pending', owner: 'builder' })
    const t = task('t', { state: 'blocked', dependsOn: ['b'] })
    expect(read(t, [t, b])).toMatchObject({ tone: 'covered', why: expect.stringContaining('BUILDER') })
  })

  it('on you: the chain ends in a person, however long it is', () => {
    const me = task('me', { state: 'pending', owner: 'owner' })
    const mid = task('mid', { state: 'blocked', dependsOn: ['me'] })
    const t = task('t', { state: 'blocked', dependsOn: ['mid'] })
    expect(read(t, [t, mid, me])).toMatchObject({ tone: 'on-you', why: expect.stringContaining('ship#me') })
  })

  it('another person is said by name, never «you»', () => {
    const sam = task('sam', { state: 'pending', owner: 'Sam' })
    const t = task('t', { state: 'blocked', dependsOn: ['sam'] })
    const r = read(t, [t, sam])
    expect(r).toMatchObject({ tone: 'on-you', why: expect.stringContaining('Sam') })
    expect(r?.why).not.toContain('you')
    const w = task('w', { state: 'blocked', waitingOn: { owner: 'Sam', action: 'sign' } })
    const rw = read(w, [w])
    expect(rw).toMatchObject({ tone: 'on-you', why: expect.stringContaining('Sam') })
    expect(rw?.why).not.toContain('you')
  })

  it('on you outranks covered when the chain forks', () => {
    const me = task('me', { owner: 'owner' })
    const live = task('live', { state: 'in_progress', owner: 'builder' })
    const t = task('t', { state: 'blocked', dependsOn: ['live', 'me'] })
    expect(read(t, [t, live, me], ['live'])?.tone).toBe('on-you')
  })

  it('a done blocker is not a wait; a wait on a person is yours', () => {
    const done = task('d', { state: 'done' })
    const t = task('t', { state: 'blocked', dependsOn: ['d'], waitingOn: { owner: 'owner', action: 'sign' } })
    expect(read(t, [t, done])).toMatchObject({ tone: 'on-you', why: expect.not.stringContaining('ship#d') })
  })

  it('a wait on an agent is covered', () => {
    const t = task('t', { state: 'blocked', waitingOn: { owner: 'builder', action: 'review' } })
    expect(read(t, [t])).toMatchObject({ tone: 'covered', why: expect.stringContaining('BUILDER') })
  })

  it('blocked and yours, naming nothing: yours to unblock', () => {
    const t = task('t', { state: 'blocked', owner: 'sam' })
    expect(read(t, [t])?.tone).toBe('on-you')
  })

  it('stuck: the kernel says so, in its own line', () => {
    const b = task('b', { state: 'in_progress' })
    const t = task('t', { state: 'blocked', dependsOn: ['b'] }, { stalled: true, stalledCause: 'blocker-parked', stalledBy: 'b' })
    const r = read(t, [t, b])
    expect(r?.tone).toBe('stuck')
    expect(r?.why).toContain('ship#b')
  })

  it("stuck: a stalled task further down, even when the top is a person's (the kernel stops at a person)", () => {
    const low = task('low', { state: 'in_progress' }, { stalled: true, stalledCause: 'in-progress-nothing-live', stalledBy: 'low' })
    const t = task('t', { state: 'blocked', owner: 'sam', dependsOn: ['low'] })
    expect(read(t, [t, low])?.tone).toBe('stuck')
  })

  it('stuck: a cancelled blocker, or an id naming no task', () => {
    const c = task('c', { state: 'cancelled' })
    const t = task('t', { state: 'blocked', owner: 'sam', dependsOn: ['c'] })
    expect(read(t, [t, c])?.tone).toBe('stuck')
    const u = task('u', { state: 'blocked', owner: 'sam', dependsOn: ['ghost'] })
    expect(read(u, [u])?.why).toContain('ship#ghost')
  })

  it('a cycle ends the walk, it never hangs', () => {
    const a = task('a', { state: 'blocked', dependsOn: ['b'] })
    const b = task('b', { state: 'blocked', dependsOn: ['a'] })
    expect(read(a, [a, b])?.tone).toBe('covered')
  })
})

describe('the Blocked column', () => {
  it('reads what needs you first and folds what is covered, never hiding it', () => {
    const me = task('me', { owner: 'owner' })
    const ok1 = task('ok1', { state: 'blocked', dependsOn: ['w'] })
    const need = task('need', { state: 'blocked', dependsOn: ['me'] })
    const w = task('w', { state: 'in_progress', owner: 'builder' })
    const all = [ok1, need, me, w]
    const col = boardColumns(all, (t) => read(t, all, ['w'])).find((c) => c.state === 'blocked')!
    expect(col.tasks.map((t) => t.id)).toEqual(['need', 'ok1'])
    expect(col.covered.map((t) => t.id)).toEqual(['ok1'])
  })

  it('without a reader nothing folds', () => {
    const t = task('t', { state: 'blocked' })
    expect(boardColumns([t]).find((c) => c.state === 'blocked')?.covered).toEqual([])
  })
})

// A row says why it waits, each fact once: the blocked reading and the
// declared wait (`waitingOn`) are one fact when the reading IS the wait.
describe('a row says each wait once', () => {
  const waits = (t: TaskView, tasks: TaskView[]) => waitFacts(t, siblingsOf(tasks, PLAN), facts())
  const wait = (owner: string, action = 'say yes') => ({ waitingOn: { owner, action } })

  it('a blocked task waiting on you: one entry, in the accent', () => {
    const t = task('t', { state: 'blocked', ...wait('owner') })
    expect(waits(t, [t])).toEqual([{ accent: true, words: expect.any(String) }])
  })

  it('a blocked task waiting on a teammate by name: one entry, in the accent', () => {
    const t = task('t', { state: 'blocked', ...wait('alice') })
    expect(waits(t, [t])).toEqual([{ accent: true, words: expect.any(String) }])
  })

  it('a blocked task waiting on an agent: one plain entry', () => {
    const t = task('t', { state: 'blocked', ...wait('builder') })
    expect(waits(t, [t])).toEqual([{ accent: false, words: expect.any(String) }])
  })

  it('an open task waiting on you, not blocked: one plain entry', () => {
    const t = task('t', { state: 'in_progress', ...wait('owner') })
    expect(waits(t, [t])).toEqual([{ accent: false, words: expect.any(String) }])
  })

  it('blocked by a chain that ends in you, no declared wait: one entry, in the accent', () => {
    const me = task('me', { state: 'pending', owner: 'owner' })
    const t = task('t', { state: 'blocked', dependsOn: ['me'] })
    expect(waits(t, [t, me])).toEqual([{ accent: true, words: expect.any(String) }])
  })

  it('a chain that ends in you AND a declared wait: two different facts, each once', () => {
    const me = task('me', { state: 'pending', owner: 'owner' })
    const t = task('t', { state: 'blocked', dependsOn: ['me'], ...wait('owner') })
    const said = waits(t, [t, me])
    expect(said.map((w) => w.accent)).toEqual([true, false])
    expect(new Set(said.map((w) => w.words)).size).toBe(2)
  })

  it('an escalation: one entry, in the accent', () => {
    const t = task('t', { state: 'blocked', ...wait('owner', 'unstick ship#t2') })
    expect(waits(t, [t])).toEqual([{ accent: true, words: expect.any(String) }])
  })

  it('a stalled task says its stall alone, never the wait beside it', () => {
    const t = task('t', { state: 'blocked', ...wait('owner') }, { stalled: true, stalledCause: 'blocker-missing' })
    expect(waits(t, [t])).toEqual([])
  })
})
