// inbox-held-task-rows.test.ts — the Needs you rows for held tasks (every open
// task has a next step): a task waiting on an agent the owner relays, the
// closed plans still holding open tasks, a plan's tasks that can't be read —
// the pure builders, what feeds them, and the reader's own words for an
// unreadable task. Generic fixtures only.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { closedPlansOpenRow, tasksUnreadableRows, waitsOnRelayRows, type TaskFlowFact } from '../src/inbox.js'
import { kernelInboxRows } from '../src/inbox-source.js'
import { readOutside, type SiloReading } from '../src/silos/reader.js'
import { unreadableTasksOf } from '../src/task-mode/engine.js'
import { ClosedPlans } from '../src/plans-closed.js'
import type { Agent } from '../src/types.js'

type Json = Record<string, any>
const NOW = Date.parse('2026-11-21T12:00:00Z')
const PLAN = 'folder:/w/ship'
const REF = join(import.meta.dirname, '..', '..', 'docs', 'standard', 'reference', 'plans.silo.json')
const flow = (over: Partial<TaskFlowFact['flow']> = {}): TaskFlowFact['flow'] => ({
  stalled: false,
  stalledCause: null,
  stalledBy: null,
  stalledAt: null,
  waitsStart: false,
  idle: false,
  ...over,
})
const fact = (id: string, over: Partial<TaskFlowFact> = {}): TaskFlowFact => ({
  key: `${PLAN}/tasks/${id}`,
  planKey: PLAN,
  ref: `ship#${id}`,
  title: `Task ${id}`,
  owner: 'writer',
  state: 'blocked',
  ready: false,
  flow: flow(),
  ...over,
})
const NAMES: Record<string, string> = { writer: 'Writer', builder: 'Builder' }
const nameOf = (id: string): string => NAMES[id] ?? id

let base: string
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'inbox-held-'))
})
afterEach(() => rmSync(base, { recursive: true, force: true }))

describe('«X waits on Y — <action>»: one due row per task whose wait names an agent', () => {
  it('the question when the wait asks one, else its action, else the title — its door the task', () => {
    const rows = waitsOnRelayRows(
      [
        fact('a', { flow: flow({ waitsOnRelay: true, waitsOn: { owner: 'builder', action: 'deploy it' } }) }),
        fact('b', { flow: flow({ waitsOnRelay: true, waitsOn: { owner: 'builder', action: 'x', asked: 'which region?' } }) }),
        fact('c', { flow: flow({ waitsOnRelay: true, waitsOn: { owner: 'writer', action: '' } }) }),
        // not a relay: a wait on the owner, a closed task
        fact('d', { flow: flow({ waitsOnRelay: false, waitsOn: { owner: 'owner', action: 'decide' } }) }),
        fact('e', { state: 'done', flow: flow({ waitsOnRelay: true, waitsOn: { owner: 'builder', action: 'x' } }) }),
      ],
      { nameOf, now: NOW },
    )
    expect(rows.map((r) => [r.key, r.urgency, r.voice])).toEqual([
      [`waits-on-relay:${PLAN}/tasks/a`, 'due', 'Writer waits on Builder — deploy it'],
      [`waits-on-relay:${PLAN}/tasks/b`, 'due', 'Writer waits on Builder — which region?'],
      [`waits-on-relay:${PLAN}/tasks/c`, 'due', 'Writer wrote a wait on itself — Task c'],
    ])
    expect(rows[0]).toMatchObject({
      kind: 'waitsOnRelay',
      task: { key: `${PLAN}/tasks/a`, ref: 'ship#a', title: 'Task a', owner: 'writer' },
      on: 'builder',
      agentIds: ['writer', 'builder'],
    })
  })
})

describe('«N closed plans still have open tasks»: ONE routine row, a door to each plan', () => {
  it('only the plans with open tasks; none → no row', () => {
    expect(closedPlansOpenRow([{ key: 'folder:/w/old', title: 'Old', folder: '/w', file: '/w/plans/closed/old.plan.json', open: 0 }], NOW)).toBeNull()
    const row = closedPlansOpenRow(
      [
        { key: 'folder:/w/old', title: 'Old', folder: '/w', file: '/w/plans/closed/old.plan.json', open: 2 },
        { key: 'folder:/w/done', title: 'Done', folder: '/w', file: '/w/plans/closed/done.plan.json', open: 0 },
        { key: 'folder:/v/x', title: 'X', folder: '/v', file: '/v/plans/closed/x.plan.json', open: 1 },
      ],
      NOW,
    )
    expect(row).toMatchObject({
      kind: 'closedPlansOpen',
      urgency: 'routine',
      count: 2,
      voice: '2 closed plans still have open tasks',
      plans: [
        { key: 'folder:/w/old', file: '/w/plans/closed/old.plan.json', open: 2 },
        { key: 'folder:/v/x', open: 1 },
      ],
    })
    expect(closedPlansOpenRow([{ key: 'folder:/w/old', title: 'Old', folder: '/w', file: '/w/plans/closed/old.plan.json', open: 1 }], NOW)?.voice).toBe(
      '1 closed plan still has open tasks',
    )
  })
  it("read from plans/closed/ through the Plans silo's rules (plans-closed.ts) — what index.ts feeds the row", () => {
    const proj = join(base, 'proj')
    mkdirSync(join(proj, 'plans', 'closed'), { recursive: true })
    writeFileSync(
      join(proj, 'plans', 'closed', 'old.plan.json'),
      JSON.stringify({
        title: 'Old',
        tasks: [
          { id: 't1', title: 'a', owner: 'writer', status: 'pending' },
          { id: 't2', title: 'b', owner: 'writer', status: 'done' },
        ],
      }),
    )
    writeFileSync(
      join(proj, 'plans', 'closed', 'finished.plan.json'),
      JSON.stringify({ title: 'Finished', tasks: [{ id: 't1', title: 'a', owner: 'writer', status: 'done' }] }),
    )
    const manifest = JSON.parse(readFileSync(REF, 'utf8')) as Json
    const closed = new ClosedPlans({ siloId: 'plans', manifest: () => manifest, conventionDirs: () => [join(proj, 'plans')] })
    const plans = closed.records({ now: NOW }).map((r) => ({
      key: `${r.location}/${r.record.id}`,
      title: String(r.record.title),
      folder: proj,
      file: r.file,
      open: (r.record.tasks as Json[]).filter((t) => t.state !== 'done' && t.state !== 'cancelled').length,
    }))
    expect(closedPlansOpenRow(plans, NOW)).toMatchObject({
      count: 1,
      plans: [{ key: `folder:${proj}/old`, title: 'Old', file: join(proj, 'plans', 'closed', 'old.plan.json'), open: 1 }],
    })
  })
})

describe("a plan's tasks that can't be read: the reader's own why, one due row per plan", () => {
  function readingOfFile(tasks: Json[]): SiloReading {
    const file = join(base, 'plans', 'ship.plan.json')
    mkdirSync(join(base, 'plans'), { recursive: true })
    writeFileSync(file, JSON.stringify({ title: 'Ship', tasks }))
    const r = readOutside('plans', JSON.parse(readFileSync(REF, 'utf8')) as Json, file, { now: NOW })
    if (!r || 'unreadable' in r) throw new Error('the plan itself should read')
    return { records: [{ ...r, location: 'folder:/w', anchors: { folder: '/w' } }], unreadable: [], lastWrite: null, sources: {}, truncated: [], problems: [] }
  }
  it("a task in a shape the format refuses is out of the plan, said with its id and the reader's reason; a lone `conversation` is no loss of the task", () => {
    const reading = readingOfFile([
      { id: 't1', title: 'fine', owner: 'writer', status: 'pending' },
      { id: 't7', title: 'notes as a string', owner: 'writer', status: 'pending', notes: 'remember this' },
      { title: 'no id', owner: 'writer', status: 'weird' },
      { id: 't9', title: 'a lone conversation', owner: 'writer', status: 'pending', conversation: 'abc' },
    ])
    expect((reading.records[0]!.record.tasks as Json[]).map((t) => t.id)).toEqual(['t1', 't9'])
    const bad = unreadableTasksOf(reading)
    expect(bad).toEqual([
      {
        key: 'folder:/w/ship',
        id: 'ship',
        title: 'Ship',
        folder: '/w',
        file: join(base, 'plans', 'ship.plan.json'),
        tasks: [
          { id: 't7', reason: 'notes is not an array' },
          { id: null, reason: expect.stringMatching(/^missing id|^status/) },
        ],
      },
    ])
    expect(tasksUnreadableRows(bad, NOW)).toEqual([
      expect.objectContaining({
        kind: 'tasksUnreadable',
        key: 'tasks-unreadable:folder:/w/ship',
        urgency: 'due',
        count: 2,
        reason: 'notes is not an array',
        first: 't7',
        plan: { key: 'folder:/w/ship', id: 'ship', title: 'Ship', folder: '/w', file: join(base, 'plans', 'ship.plan.json') },
        voice: "2 tasks in Ship can't be read — t7: notes is not an array",
      }),
    ])
  })
  it('a plan whose tasks all read: no row', () => {
    expect(tasksUnreadableRows(unreadableTasksOf(readingOfFile([{ id: 't1', title: 'fine', owner: 'writer', status: 'pending' }])), NOW)).toEqual([])
  })
})

describe('kernelInboxRows feeds them (inbox-source)', () => {
  it('taskFlows → the relay rows; closedPlans → the closed row; tasksUnreadable → a row per plan', () => {
    const agents = ['writer', 'builder'].map((id) => ({ id, name: nameOf(id), folder: '/w' })) as unknown as Agent[]
    const rows = kernelInboxRows({
      agents,
      nameOf,
      now: NOW,
      taskFlows: () => [fact('a', { flow: flow({ waitsOnRelay: true, waitsOn: { owner: 'builder', action: 'deploy it' } }) })],
      closedPlans: () => [{ key: 'folder:/w/old', title: 'Old', folder: '/w', file: '/w/plans/closed/old.plan.json', open: 1 }],
      tasksUnreadable: () => [
        {
          key: 'folder:/w/ship',
          id: 'ship',
          title: 'Ship',
          folder: '/w',
          file: '/w/plans/ship.plan.json',
          tasks: [{ id: 't7', reason: 'notes is not an array' }],
        },
      ],
    })
    expect(rows.map((r) => r.kind)).toEqual(['waitsOnRelay', 'closedPlansOpen', 'tasksUnreadable'])
  })
})
