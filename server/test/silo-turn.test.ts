// turnOf: whose turn a task is, in one server-composed sentence —
// the one voice the task page, rows and digest share. Table-driven over the
// same fixture shape as the task-flow tests; the wake clauses are pinned here
// because the server owns them (the web renders them).
import { describe, expect, it } from 'vitest'
import { dictionaryForKind, type FieldDict } from '../src/silos/expressions.js'
import type { TaskEnv } from '../src/silos/task-flow.js'
import { turnOf } from '../src/silos/turn.js'
import { conversationLive } from '../src/conversation-live.js'

type Json = Record<string, any>
const NOW = Date.parse('2026-11-07T12:00:00Z')
const AGENTS = new Set(['writer', 'finance', 'silos'])
const isAgent = (v: string): boolean => AGENTS.has(v)
const NAMES: Record<string, string> = { writer: 'Writer', finance: 'Finance', silos: 'Silos' }
const nameOf = (id: string): string => NAMES[id] ?? id

const STATES = ['pending', 'in_progress', 'in_review', 'blocked', 'done', 'cancelled']
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
    subKinds: {
      task: {
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
          waitingOn: { type: 'object', optional: true },
          nextCheckAt: { type: 'timestamp', optional: true },
        },
      },
    },
  }
}
const dict = (): FieldDict => dictionaryForKind('plan', planSpec()).dict.collections.tasks!
const T = (id: string, owner: string, state: string, dependsOn: string[] = [], over: Json = {}): Json => ({
  id,
  owner,
  state,
  dependsOn,
  conversations: [],
  ...over,
})
const turn = (id: string, tasks: Json[], te: Partial<TaskEnv> = {}) =>
  turnOf(
    tasks.find((t) => t.id === id)!,
    tasks,
    dict(),
    (id) => `plan#${id}`,
    { now: NOW, isAgent, nameOf, taskEnv: { isLive: () => false, wakes: () => 'task', ...te } },
  )

describe('turnOf — the one sentence per kind', () => {
  it('done and cancelled read settled; a kind without roles.task reads nothing', () => {
    expect(turn('a', [T('a', 'sam', 'done')])).toEqual({ kind: 'done', sentence: '' })
    expect(turn('a', [T('a', 'writer', 'cancelled')])).toEqual({ kind: 'done', sentence: '' })
    expect(turnOf(T('a', 'sam', 'pending'), [], { task: undefined } as never, (id) => `plan#${id}`, { now: NOW })).toBeNull()
  })

  it('a dropped (cancelled) blocker never resolves: stalled with the way out — a person’s task too, never «Your turn»', () => {
    const said = { kind: 'stalled', sentence: 'Blocked — waits on plan#x, which was dropped; it never resolves — remove that dependency or reopen it.' }
    expect(turn('a', [T('a', 'owner', 'pending', ['x']), T('x', 'writer', 'cancelled')])).toEqual(said)
    expect(turn('a', [T('a', 'sam', 'blocked', ['x']), T('x', 'writer', 'cancelled')])).toEqual(said)
    expect(turn('a', [T('a', 'writer', 'blocked', ['x', 'y']), T('x', 'writer', 'cancelled'), T('y', 'writer', 'cancelled')])).toEqual({
      kind: 'stalled',
      sentence: 'Blocked — waits on plan#x, which was dropped (and 1 more); it never resolves — remove that dependency or reopen it.',
    })
    // done resolves it: back to the plain turn
    expect(turn('a', [T('a', 'owner', 'pending', ['x']), T('x', 'writer', 'done')]).kind).toBe('yours')
  })

  it('a declared waitingOn wins: «you» for the owner, the ask verbatim when written', () => {
    expect(turn('a', [T('a', 'writer', 'blocked', [], { waitingOn: { owner: 'owner', action: 'Decide: (A) or (B)' } })])).toEqual({
      kind: 'waiting',
      sentence: 'Waiting on you: Decide: (A) or (B).',
    })
    expect(turn('a', [T('a', 'writer', 'in_progress', [], { waitingOn: { owner: 'finance', action: 'sign', asked: 'Shall I sign block A?' } })])).toEqual({
      kind: 'waiting',
      sentence: 'Waiting on Finance: «Shall I sign block A?».',
    })
  })

  it('a person’s future next check is a park; an agent’s keeps its own words', () => {
    expect(turn('a', [T('a', 'sam', 'pending', [], { nextCheckAt: '2026-11-21T09:00:00Z' })])).toEqual({
      kind: 'parked',
      sentence: 'Parked — out of Needs you; back on Nov 21.',
    })
    expect(turn('a', [T('a', 'writer', 'pending', [], { nextCheckAt: '2026-11-21T09:00:00Z' })])).toEqual({
      kind: 'waiting',
      sentence: 'Not now — Silos wakes its owner on it on Nov 21.',
    })
  })

  it('unfinished dependencies name the first blocker, its owner and whose turn follows — with the wake clause for a bound agent', () => {
    const tasks = [T('g', 'owner', 'pending'), T('h', 'owner', 'pending'), T('x', 'silos', 'blocked', ['g', 'h', 'd']), T('d', 'writer', 'done')]
    expect(turn('x', tasks)).toEqual({
      kind: 'waiting',
      sentence: "Waiting — waits on plan#g (you) and 1 more. Then it is Silos's turn — Silos wakes it then.",
    })
    expect(turn('x', tasks, { wakes: () => 'never' })).toEqual({
      kind: 'waiting',
      sentence: "Waiting — waits on plan#g (you) and 1 more. Then it is Silos's turn.",
    })
  })

  it('blocked naming nothing open: a stall is said with its cause (A2.4: blocked-on-nothing)', () => {
    expect(turn('a', [T('a', 'writer', 'blocked')], { wakes: () => 'never' })).toEqual({
      kind: 'stalled',
      sentence: 'Sits untouched — blocked, and it names nothing it waits on.',
    })
  })

  it('yours: what finishing it hands out, or that nothing waits', () => {
    expect(turn('g', [T('g', 'owner', 'pending'), T('a', 'writer', 'blocked', ['g']), T('b', 'finance', 'pending', ['g'])])).toEqual({
      kind: 'yours',
      sentence: 'Your turn — finishing it unblocks 1 task of Writer and 1 of Finance.',
    })
    // (A2.3) another person's task names them — «Your turn» is the owner's
    expect(turn('g', [T('g', 'sam', 'in_progress')])).toEqual({ kind: 'yours', sentence: "Sam's turn — nothing here waits on anyone else." })
  })

  it('theirs: working now when a conversation is live, else how it wakes — the web’s own wake words', () => {
    const live = [T('a', 'writer', 'in_progress', [], { conversations: [{ id: 's1' }] })]
    expect(turn('a', live, { isLive: (s) => s === 's1' })).toEqual({ kind: 'theirs', sentence: 'Writer is working on it now.' })
    // a wake on its way: its turn, how it wakes (the page paints the queued wake)
    expect(turn('a', [T('a', 'writer', 'pending')], { wakeOnTheWay: () => true })).toEqual({
      kind: 'theirs',
      sentence: "Writer's turn — no conversation yet; it wakes when its task moves — Silos wakes it.",
    })
    // an agent that never wakes AND can't be started has no cheerful turn:
    // its ready task IS the stall (owner-cannot-run)
    expect(turn('a', [T('a', 'writer', 'pending')], { wakes: () => 'never', startable: () => false })).toEqual({
      kind: 'stalled',
      sentence: 'Sits untouched — its owner never wakes on its own.',
    })
  })

  // (E5, E6) the beat retired with t3: an agent is On its own ('task') or Only when told ('never')
  it("start: a 'never' agent waits for you to start — or continue — it there, never «Stalled»", () => {
    expect(turn('a', [T('a', 'writer', 'pending')], { wakes: () => 'never' })).toEqual({
      kind: 'start',
      sentence: 'Not started — it opens with Writer and you.',
    })
    const at = NOW - 3 * 60_000
    expect(
      turn('a', [T('a', 'writer', 'in_progress', [], { conversations: [{ id: 's1' }] })], {
        wakes: () => 'never',
        titleOf: (id) => (id === 's1' ? { title: 'the logo', at } : null),
      }),
    ).toEqual({ kind: 'start', sentence: 'Waiting for you to continue Writer on it — last in «the logo» 3 min ago.' })
    expect(turn('a', [T('a', 'writer', 'in_progress')], { wakes: () => 'never' })).toEqual({
      kind: 'start',
      sentence: 'Waiting for you to continue Writer on it.',
    })
  })

  // the main turn closed hours ago, a background subagent of it runs a
  // long test suite (silent inside one tool call) — the conversation is live
  // by the one rule (work-live.ts), so its 'never' agent is working, not
  // waiting on the owner; with nothing in flight it is the owner's turn again
  it("a 'never' agent whose conversation's background agent runs a silent tool is working on it now", () => {
    const quiet = { id: 's1', mtime: NOW - 3 * 3600_000, turnOpen: false, subMtime: NOW - 5 * 60_000 }
    const tasks = [T('a', 'writer', 'in_progress', [], { conversations: [{ id: 's1' }] })]
    const isLive = (s: typeof quiet & { subToolSince?: number }) =>
      conversationLive({ isActive: () => false, sessions: () => [s], now: () => NOW, liveMs: 120_000 })
    expect(turn('a', tasks, { wakes: () => 'never', isLive: isLive({ ...quiet, subToolSince: NOW - 5 * 60_000 }) })).toEqual({
      kind: 'theirs',
      sentence: 'Writer is working on it now.',
    })
    expect(turn('a', tasks, { wakes: () => 'never', isLive: isLive(quiet) })).toEqual({ kind: 'start', sentence: 'Waiting for you to continue Writer on it.' })
  })

  it('idle: ready, nobody on it — with its last conversation when it had one', () => {
    expect(turn('a', [T('a', 'writer', 'pending')])).toEqual({ kind: 'idle', sentence: 'Not started — nobody is on it.' })
    const at = NOW - 2 * 3600_000
    expect(
      turn('a', [T('a', 'writer', 'pending', [], { conversations: [{ id: 's1' }] })], { currentOf: () => [], titleOf: () => ({ title: null, at }) }),
    ).toEqual({ kind: 'idle', sentence: 'Not started — nobody is on it — last 2 h ago.' })
  })

  it('nobody works it now: every conversation let go (A3); «no conversation yet» only when there is none', () => {
    const at = NOW - 2 * 60_000
    const tasks = [T('a', 'writer', 'pending', [], { conversations: [{ id: 's1' }] })]
    expect(turn('a', tasks, { wakes: () => 'task', wakeOnTheWay: () => true, currentOf: () => [], titleOf: () => ({ title: 'logo', at }) })).toEqual({
      kind: 'theirs',
      sentence: 'Nobody works it now — last in «logo» 2 min ago; it wakes when its task moves — Silos wakes it.',
    })
  })

  it('an in-progress bound task with nothing live is the stall, not a cheerful turn', () => {
    expect(turn('a', [T('a', 'writer', 'in_progress')])).toEqual({ kind: 'stalled', sentence: 'Sits untouched — in progress, but nothing is working on it.' })
  })
})
