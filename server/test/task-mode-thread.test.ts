// task-mode-thread.test.ts — the task-mode server follows the THREAD, not
// only the ids a task lists. After a /clear or a
// keep-thread rotation the live session is a descendant nobody listed: the
// task must not read stalled, a wake must resume the tip (never fork the
// ancestor), and the tip busy must hold the wake — while ANOTHER agent's busy
// conversation on the same task never holds it. Generic fixtures only.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { taskThreads, type TaskThreads } from '../src/task-threads.js'
import { TaskModeStore } from '../src/task-mode/store.js'
import { TaskModeEngine } from '../src/task-mode/engine.js'
import { kernelInboxRows } from '../src/inbox-source.js'
import { dictionaryForKind, type FieldDict } from '../src/silos/expressions.js'
import { taskFlow, type TaskEnv } from '../src/silos/task-flow.js'
import type { SiloReading } from '../src/silos/reader.js'
import type { LineageStore } from '../src/lineage.js'
import type { SessionMeta } from '../src/types.js'

const T0 = Date.parse('2026-11-08T09:00:00Z')
const MIN = 60_000

const meta = (id: string, mtime: number, extra: Partial<SessionMeta> = {}): SessionMeta => ({
  id,
  folder: 'proj',
  title: 'T',
  skills: [],
  cwd: null,
  mtime,
  size: 10,
  turnCount: 1,
  ...extra,
})
const lineageOf = (parents: Record<string, string>): LineageStore =>
  ({ parentIdOf: (id: string) => parents[id] ?? null, continuationParentIdOf: (id: string) => parents[id] ?? null }) as unknown as LineageStore

// a world: sessions (id → owner, mtime), lineage links, what is busy
function threadsOf(sessions: Array<{ id: string; owner: string; mtime: number }>, parents: Record<string, string>): TaskThreads {
  const owner = new Map(sessions.map((s) => [s.id, s.owner]))
  return taskThreads({ metas: sessions.map((s) => meta(s.id, s.mtime)), lineage: lineageOf(parents), ownerOf: (m) => owner.get(m.id) ?? null })
}

// ── the engine, over the real thread reads ──
let base: string
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'task-thread-'))
})
afterEach(() => rmSync(base, { recursive: true, force: true }))

function readingOf(tasks: Array<Record<string, unknown>>): SiloReading {
  return {
    records: [
      {
        silo: 'plans',
        kind: 'plan',
        source: 'plans',
        file: '/p/plans/demo.plan.json',
        rel: 'plans/demo.plan.json',
        location: 'folder:/p',
        anchors: {},
        mtimeMs: 0,
        raw: {},
        record: { id: 'demo', title: 'D', tasks },
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

function engineOver(threads: TaskThreads, busy: ReadonlySet<string>) {
  let now = T0
  let tasks: Array<Record<string, unknown>> = []
  const sent: Array<{ agentId: string; resume: string | null }> = []
  const inputs: Array<Parameters<ConstructorParameters<typeof TaskModeEngine>[0]['send']>[0]> = []
  const engine = new TaskModeEngine({
    store: new TaskModeStore(base),
    plans: () => ({ reading: readingOf(tasks) }),
    bound: () => new Set(['writer', 'builder']),
    ready: () => true,
    setField: () => ({ ok: true }),
    appendConversation: () => ({ ok: true }),
    conversationOf: (agent, ids) => threads.tipOf(agent, ids),
    holdersOf: (agent, ids) => threads.holdersOf(agent, ids),
    busyWhy: (s) => (busy.has(s) ? 'a console has its conversation open' : null),
    send: (i) => {
      sent.push({ agentId: i.agentId, resume: i.resume })
      inputs.push(i)
      if (!i.resume) i.onSession('new-session')
      return { turnId: `turn-${sent.length}`, done: new Promise<void>(() => {}) }
    },
    now: () => now,
  })
  // an unblock: writer's t2 waits on sam's a, which gets done
  const unblock = (conversations: unknown[]) => {
    tasks = [
      { id: 'a', title: 'A', owner: 'sam', state: 'pending', dependsOn: [], notes: [] },
      { id: 't2', title: 'T2', owner: 'writer', state: 'blocked', dependsOn: ['a'], notes: [], conversations },
    ]
    engine.look(now)
    now += MIN
    tasks = [{ ...tasks[0]!, state: 'done' }, tasks[1]!]
    engine.look(now)
  }
  return { engine, sent, inputs, unblock, queued: () => engine.store.queued() }
}

// the TASK is the record of its turns: an audit that
// could not read a wake's transcript taints the wake and hangs a Needs you
// row from the task (ref + session), Seen by that turn
describe('a wake whose transcript is unreadable (fail closed)', () => {
  const threads = threadsOf([{ id: 'tip', owner: 'writer', mtime: T0 }], {})
  it('the wake and the task carry the taint; the row names the task and the session; a newer clean turn clears it', () => {
    const w = engineOver(threads, new Set())
    w.unblock([{ session: 'tip' }])
    expect(w.inputs).toHaveLength(1)
    w.inputs[0]!.onAudit!({ readOutside: ['transcript unreadable'] }, { sessionId: 'tip' })
    const wake = w.engine.store.wakes().find((x) => x.turnId === 'turn-1')!
    expect(wake.audit).toEqual({ readOutside: ['transcript unreadable'] })
    const hits = w.engine.unreadableAudits()
    expect(hits).toMatchObject([{ agent: 'writer', ref: expect.stringContaining('t2'), title: 'T2', session: 'tip', turnId: 'turn-1' }])
    const rows = kernelInboxRows({
      agents: [{ id: 'writer', name: 'Writer', emoji: '', role: '', folder: '/p', skills: [] }],
      nameOf: () => 'Writer',
      now: T0,
      taskAuditsUnreadable: () => w.engine.unreadableAudits(),
    })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      kind: 'auditUnreadable',
      agentId: 'writer',
      urgency: 'due',
      task: { session: 'tip', turnId: 'turn-1' },
      ack: { kind: 'audit', version: 'turn-1' },
    })
    expect(rows[0]!.voice).toMatch(
      /^Silos couldn't read the transcript of Writer's turn on .*t2 «T2» — transcript unreadable, so it counts as having read outside$/,
    )
    // a newer turn on the task read cleanly: the row goes
    w.inputs[0]!.onAudit!({ readOutside: [] }, { sessionId: 'tip' })
    expect(w.engine.unreadableAudits()).toEqual([])
  })
})

describe('a rotation: the task lists the ancestor, the tip works', () => {
  // writer's console was listed as «anc»; a /clear rotated it into «tip»
  const threads = threadsOf(
    [
      { id: 'anc', owner: 'writer', mtime: T0 - 60 * MIN },
      { id: 'tip', owner: 'writer', mtime: T0 },
    ],
    { tip: 'anc' },
  )

  it('the (agent, task) conversation is the tip, and a wake resumes it — never the ancestor', () => {
    expect(threads.tipOf('writer', ['anc'])).toEqual({ sessionId: 'tip', folder: 'proj' })
    const w = engineOver(threads, new Set())
    w.unblock([{ session: 'anc' }])
    expect(w.sent).toEqual([{ agentId: 'writer', resume: 'tip' }])
  })

  it('the tip busy holds the wake (the ancestor alone is idle)', () => {
    const w = engineOver(threads, new Set(['tip']))
    w.unblock([{ session: 'anc' }])
    expect(w.sent).toEqual([])
    expect(w.queued()[0]?.held).toMatch(/console has its conversation open/)
  })
})

describe('the task flow reads the thread live', () => {
  const dict = (): FieldDict =>
    dictionaryForKind('plan', {
      envelope: {
        id: { from: 'filename' },
        identity: { template: '{{title}}' },
        state: { computed: 'all(tasks, state in [done, cancelled]) ? done : active' },
        at: { field: 'updatedAt' },
      },
      states: [
        { value: 'active', label: { one: 'a', many: 'a' } },
        { value: 'done', label: { one: 'd', many: 'd' }, terminal: true },
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
          states: ['pending', 'in_progress', 'in_review', 'blocked', 'done', 'cancelled'].map((v) => ({ value: v, label: { one: v, many: v } })),
          roles: { task: { owner: 'owner', dependsOn: 'dependsOn', conversations: 'conversations' } },
          fields: { owner: { type: 'actor', required: true }, dependsOn: { type: 'refs(task)', withinParent: true } },
          subKinds: {
            conversation: {
              path: 'conversations[]',
              envelope: { id: { field: 'session' }, identity: { template: '{{session}}' } },
              fields: { session: { type: 'string', required: true } },
            },
          },
        },
      },
    }).dict.collections.tasks!
  const working = (listed: string) => ({ id: 't1', owner: 'writer', state: 'in_progress', dependsOn: [], conversations: [{ id: listed, session: listed }] })
  const flow = (listed: string, te: TaskEnv) => taskFlow(working(listed), [working(listed)], dict(), { now: T0, isAgent: (v) => v === 'writer', taskEnv: te })

  it('a working tip under a listed ancestor: not stalled', () => {
    const threads = threadsOf(
      [
        { id: 'anc', owner: 'writer', mtime: T0 - 60 * MIN },
        { id: 'tip', owner: 'writer', mtime: T0 },
      ],
      { tip: 'anc' },
    )
    const isLive = (s: string) => s === 'tip'
    expect(flow('anc', { isLive, wakes: () => 'task', threadLive: (ids) => threads.anyLive(ids, isLive) }).stalled).toBe(false)
    // the listed ids alone (the old read) called it stalled
    expect(flow('anc', { isLive, wakes: () => 'task' }).stalledCause).toBe('in-progress-nothing-live')
  })

  it('a trashed listed id with a live tip: not stalled, and the wake resumes the tip', () => {
    // «gone» was trashed (unindexed); lineage still names it the parent of kid ← kid2
    const threads = threadsOf(
      [
        { id: 'kid', owner: 'writer', mtime: T0 - MIN },
        { id: 'kid2', owner: 'writer', mtime: T0 },
      ],
      { kid: 'gone', kid2: 'kid' },
    )
    const isLive = (s: string) => s === 'kid2'
    expect(flow('gone', { isLive, wakes: () => 'task', threadLive: (ids) => threads.anyLive(ids, isLive) }).stalled).toBe(false)
    expect(threads.tipOf('writer', ['gone'])).toEqual({ sessionId: 'kid2', folder: 'proj' })
    const w = engineOver(threads, new Set())
    w.unblock([{ session: 'gone' }])
    expect(w.sent).toEqual([{ agentId: 'writer', resume: 'kid2' }])
  })
})

describe('two agents on one task: busy is filtered by OWNER', () => {
  // writer's thread and builder's thread both listed on writer's task; builder's console is open
  const threads = threadsOf(
    [
      { id: 'writer-1', owner: 'writer', mtime: T0 - 10 * MIN },
      { id: 'builder-1', owner: 'builder', mtime: T0 - 20 * MIN },
      { id: 'builder-2', owner: 'builder', mtime: T0 },
    ],
    { 'builder-2': 'builder-1' },
  )

  it("builder's busy console does not hold writer's wake; writer's own conversation is resumed", () => {
    expect(threads.holdersOf('writer', ['writer-1', 'builder-1'])).toEqual(['writer-1'])
    const w = engineOver(threads, new Set(['builder-2']))
    w.unblock([{ session: 'writer-1' }, { session: 'builder-1' }])
    expect(w.sent).toEqual([{ agentId: 'writer', resume: 'writer-1' }])
  })

  it('a listed id the index does not know yet (a fresh console) still holds it', () => {
    expect(threads.holdersOf('writer', ['writer-1', 'fresh'])).toEqual(['writer-1', 'fresh'])
    const w = engineOver(threads, new Set(['fresh']))
    w.unblock([{ session: 'writer-1' }, { session: 'fresh' }])
    expect(w.sent).toEqual([])
  })
})

describe('a chain deeper than 8', () => {
  // root ← c1 … ← c12: the tip is 12 rotations below the listed root
  const chain = ['root', ...Array.from({ length: 12 }, (_, i) => `c${i + 1}`)]
  const parents: Record<string, string> = {}
  for (let i = 1; i < chain.length; i++) parents[chain[i]!] = chain[i - 1]!
  const threads = threadsOf(
    chain.map((id, i) => ({ id, owner: 'writer', mtime: T0 - (chain.length - i) * MIN })),
    parents,
  )

  it('the tip is found, the wake resumes it, and its busy holds it', () => {
    expect(threads.tipOf('writer', ['root'])?.sessionId).toBe('c12')
    expect(threads.anyLive(['root'], (s) => s === 'c12')).toBe(true)
    const w = engineOver(threads, new Set())
    w.unblock([{ session: 'root' }])
    expect(w.sent).toEqual([{ agentId: 'writer', resume: 'c12' }])
    const held = engineOver(threads, new Set(['c12']))
    held.unblock([{ session: 'root' }])
    expect(held.sent).toEqual([])
  })
})
