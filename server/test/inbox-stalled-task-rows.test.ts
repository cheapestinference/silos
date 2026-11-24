// inbox-stalled-task-rows.test.ts — the Needs you rows for stalled tasks: the
// row of stalls nobody is woken for counts distinct SEATS (it closes the
// it.todo «a task nobody owns, or a named person's, is stalled with no row
// that says it»); «Coming to you» leaves out only the owner's task that is its
// own seat; the idle-console row read from Task mode's store.
// Generic fixtures only.
import { describe, expect, it } from 'vitest'
import { dictionaryForKind, type FieldDict } from '../src/silos/expressions.js'
import { taskFlow, type TaskEnv } from '../src/silos/task-flow.js'
import { idleConsoleRows, taskLineRows, tasksStalledRow, type TaskFlowFact } from '../src/inbox.js'
import { kernelInboxRows } from '../src/inbox-source.js'
import type { Agent } from '../src/types.js'

type Json = Record<string, any>
const NOW = Date.parse('2026-11-21T12:00:00Z')
const H = 3600_000
const PLAN = 'folder:/w/p'
const AGENTS = new Set(['writer', 'teller'])
const isAgent = (v: string): boolean => AGENTS.has(v)
const ENV: TaskEnv = { isLive: () => false, wakes: (a) => (a === 'writer' ? 'task' : 'never'), startable: (a) => AGENTS.has(a) }
function taskDict(): FieldDict {
  const STATES = ['pending', 'in_progress', 'in_review', 'blocked', 'done', 'cancelled']
  return dictionaryForKind('plan', {
    envelope: { id: { from: 'filename' }, identity: { template: '{{title}}' }, state: { computed: 'all(tasks, state in [done, cancelled]) ? done : active' } },
    states: [
      { value: 'active', label: { one: 'active', many: 'active' } },
      { value: 'done', label: { one: 'done', many: 'done' }, terminal: true },
    ],
    subKinds: {
      task: {
        path: 'tasks[]',
        envelope: { id: { field: 'id' }, identity: { template: '{{title}}' }, state: { field: 'status' } },
        states: STATES.map((v) => ({ value: v, label: { one: v, many: v } })),
        roles: { task: { owner: 'owner', dependsOn: 'dependsOn', waitingOn: 'waitingOn', nextCheckAt: 'nextCheckAt', conversations: 'conversations' } },
        fields: { owner: { type: 'actor', required: true }, dependsOn: { type: 'refs(task)', withinParent: true } },
      },
    },
  }).dict.collections.tasks!
}
const DICT = taskDict()
const T = (id: string, owner: string, state: string, dependsOn: string[] = []): Json => ({
  id,
  title: `Task ${id}`,
  owner,
  state,
  dependsOn,
  conversations: [],
})
// the facts Needs you reads, from the real kernel flow (index.ts taskFlowsNow)
const factsOf = (tasks: Json[]): TaskFlowFact[] =>
  tasks.map((t) => ({
    key: `${PLAN}/tasks/${t.id}`,
    planKey: PLAN,
    ref: `p#${t.id}`,
    title: t.title,
    owner: t.owner,
    state: t.state,
    ready: t.state === 'pending' && t.dependsOn.every((d: string) => tasks.find((x) => x.id === d)?.state === 'done'),
    flow: taskFlow(t, tasks, DICT, { now: NOW, isAgent, taskEnv: ENV }),
  }))
const opts = { isAgent, isBound: (id: string) => id === 'writer', now: NOW }

describe('«N tasks sit untouched» counts distinct seats nobody is woken for', () => {
  it("a task nobody owns and a named person's are rows now; ten tasks above one dead link count once", () => {
    const tasks = [
      T('nobody', '', 'pending'),
      T('sams', 'sam', 'blocked', ['ghost']),
      ...Array.from({ length: 10 }, (_, i) => T(`up${i}`, 'teller', 'blocked', [i === 9 ? 'sams' : `up${i + 1}`])),
    ]
    const row = tasksStalledRow(factsOf(tasks), opts)!
    expect(row).toMatchObject({ kind: 'tasksStalled', count: 2, agentIds: [], voice: '2 tasks sit untouched — nobody is moving them' })
    expect(row.keys).toEqual([`${PLAN}/tasks/nobody`, `${PLAN}/tasks/sams`])
  })
  it('a bound seat is its wake, never the row; the tasks above it are not counted either', () => {
    expect(tasksStalledRow(factsOf([T('a', 'teller', 'blocked', ['b']), T('b', 'writer', 'blocked')]), opts)).toBeNull()
  })
  it("an unbound agent's seat names its agent", () => {
    expect(tasksStalledRow(factsOf([T('a', 'teller', 'in_review')]), opts)).toMatchObject({ count: 1, agentIds: ['teller'] })
  })
})

describe("«Coming to you» leaves out only the owner's task that is its own seat", () => {
  it("waiting on an agent's untouched work stays coming to you, said «Waiting — …»; waiting on a dead link is the row's", () => {
    const tasks = [T('a', 'owner', 'pending', ['b']), T('b', 'teller', 'pending'), T('c', 'owner', 'pending', ['ghost'])]
    const facts = factsOf(tasks)
    const coming = taskLineRows(facts, NOW).find((r) => r.kind === 'taskLine' && r.line === 'comingToYou')
    expect(coming && coming.kind === 'taskLine' ? coming.keys : null).toEqual([`${PLAN}/tasks/a`])
    expect(tasksStalledRow(facts, opts)).toMatchObject({ count: 1, keys: [`${PLAN}/tasks/c`] })
  })
})

describe("«X's console on «title» is open and idle — N wakes wait for it»", () => {
  const at = (ms: number): string => new Date(ms).toISOString()
  const f = (o: Partial<Parameters<typeof idleConsoleRows>[1]> = {}) => ({
    threadLive: () => false,
    busyMs: 2 * H,
    sessionOf: () => ({ title: 'Launch', folder: '/w' }),
    nameOf: (id: string) => id.charAt(0).toUpperCase() + id.slice(1),
    now: NOW,
    ...o,
  })
  const held = (task: string, since: number, session = 'sess-1') => ({
    agent: 'writer',
    task,
    holdClass: 'console',
    holdSession: session,
    heldSince: at(since),
  })
  it('one due row per conversation, past the 2 h rule, its thread not live — the oldest hold dates it and is its Seen', () => {
    const rows = idleConsoleRows([held('k1', NOW - 3 * H), held('k2', NOW - 2.5 * H), held('k3', NOW - 3 * H, 'sess-2')], f())
    expect(rows.map((r) => r.kind === 'consoleIdle' && [r.session.id, r.count, r.ack?.version])).toEqual([
      ['sess-1', 2, at(NOW - 3 * H)],
      ['sess-2', 1, at(NOW - 3 * H)],
    ])
    expect(rows[0]).toMatchObject({
      urgency: 'due',
      voice: "Writer's console on «Launch» is open and idle — 2 wakes wait for it",
      ack: { kind: 'consoleIdle', key: 'sess-1' },
    })
  })
  it('never before the 2 h rule, never while its thread is live, never a hold whose console probe failed (no holdSession), never another class', () => {
    expect(idleConsoleRows([held('k1', NOW - H)], f())).toEqual([])
    expect(idleConsoleRows([held('k1', NOW - 3 * H)], f({ threadLive: () => true }))).toEqual([])
    expect(idleConsoleRows([{ agent: 'writer', task: 'k1', holdClass: 'console', heldSince: at(NOW - 3 * H) }], f())).toEqual([])
    expect(idleConsoleRows([{ ...held('k1', NOW - 3 * H), holdClass: 'turn' }], f())).toEqual([])
  })
  it('kernelInboxRows reads it from the queued wakes and the conversation facts — agents in play only', () => {
    const agents = [{ id: 'writer', name: 'Writer', folder: '/w' }] as unknown as Agent[]
    const rows = kernelInboxRows({
      agents,
      nameOf: (id) => id,
      now: NOW,
      queuedWakes: () => [held('k1', NOW - 3 * H), { ...held('k2', NOW - 3 * H, 'sess-9'), agent: 'gone' }],
      conversations: { threadLive: () => false, busyMs: 2 * H, sessionOf: () => null },
    })
    expect(rows.filter((r) => r.kind === 'consoleIdle').map((r) => r.kind === 'consoleIdle' && r.session)).toEqual([
      { id: 'sess-1', folder: null, title: null },
    ])
  })
})
