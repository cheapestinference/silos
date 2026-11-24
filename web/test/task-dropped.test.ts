// task-dropped.test.ts — a dropped task (state cancelled) on every screen,
// one word and its consequences: the state says «dropped»,
// never a note; what a Drop leaves hanging; a dependency that was dropped;
// Done counts it apart; a plan's progress leaves it out; a conversation that
// worked it says «dropped», never ✓; an old alias ref never lands in another
// project's list; a missing sibling is labelled like its task.
import { describe, expect, it } from 'vitest'
import {
  doneWords,
  dropHangs,
  droppedDependencies,
  labelOf,
  siblingsOf,
  stateLabel,
  taskOfRow as rawTaskOfRow,
  workWord,
  type TaskView,
} from '../src/lib/tasks'
import { planProgress } from '../src/lib/team-plan'
import { taskOfRef } from '../src/lib/task-refs'
import { stateWords } from '../src/lib/task-link'
import { layoutPlan } from '../src/lib/plan-layout'
import type { SiloRecordRow } from '../src/lib/types'
import { serverTaskRow } from './server-task-row'
const taskOfRow = (r: Parameters<typeof rawTaskOfRow>[0]): ReturnType<typeof rawTaskOfRow> => rawTaskOfRow(serverTaskRow(r))

const PLAN = 'folder:/home/u/proj/ship'
const row = (id: string, value: Record<string, unknown>, over: Partial<SiloRecordRow> = {}): SiloRecordRow => ({
  key: `${PLAN}/tasks/${id}`,
  id,
  identity: String(value.title ?? id),
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
  parent: { key: PLAN, identity: 'Ship it', at: '2026-11-01T10:00:00Z' },
  value: { id, owner: 'writer', dependsOn: [], conversations: [], notes: [], ...value },
  moved: null,
  ...over,
})
const task = (id: string, value: Record<string, unknown>, over: Partial<SiloRecordRow> = {}): TaskView => taskOfRow(row(id, value, over))!
const nameOf = (id: string): string | undefined => (({ writer: 'Writer', builder: 'Builder' }) as Record<string, string>)[id]

describe('the state says it, never a note (A1/A2)', () => {
  it("cancelled reads «dropped» (the server's word); done with an old Dropped: note is done", () => {
    expect(task('a', { state: 'cancelled' }).stateLabel).toBe('dropped')
    expect(task('b', { state: 'done', notes: [{ at: '', by: 'owner', text: 'Dropped: old way' }] }).stateLabel).toBe('done')
    expect(stateLabel('cancelled')).toBe('Dropped')
    expect(stateWords('cancelled')).toBe('dropped')
  })
})

describe('what a Drop leaves hanging, and a dependency that was dropped (A4/A5)', () => {
  it('the open tasks that wait on it, by whose they are', () => {
    const t = task('t1', {})
    const all = [
      t,
      task('t2', { dependsOn: ['t1'], owner: 'builder' }),
      task('t3', { dependsOn: ['t1'], owner: 'builder' }),
      task('t4', { dependsOn: ['t1'], state: 'done' }),
    ]
    expect(dropHangs(t, all, nameOf)).toMatchObject({ words: '2 tasks of Builder wait on this — they stall until someone removes the dependency' })
    expect(dropHangs(t, [t, task('t5', { dependsOn: ['t1'], owner: 'owner' })], nameOf)!.words).toBe(
      '1 task of yours waits on this — it stalls until someone removes the dependency',
    )
    expect(dropHangs(t, [t], nameOf)).toBeNull()
  })
  it('a direct dependency that was dropped; none once the task is finished', () => {
    const plan = siblingsOf([task('x', { state: 'cancelled' }), task('y', { state: 'done' })], PLAN)
    expect(droppedDependencies(task('a', { state: 'blocked', dependsOn: ['x', 'y'] }), plan).map((b) => b.id)).toEqual(['x'])
    expect(droppedDependencies(task('a', { state: 'done', dependsOn: ['x'] }), plan)).toEqual([])
  })
})

describe('dropped is finished, never done (M1/M3)', () => {
  it('Tasks › Done counts them apart', () => {
    expect(doneWords([{ state: 'done' }, { state: 'done' }, { state: 'cancelled' }])).toBe('2 done, 1 dropped')
    expect(doneWords([{ state: 'done' }])).toBe('1 done')
    expect(doneWords([{ state: 'cancelled' }])).toBe('1 dropped')
  })
  it('progress leaves the dropped out of the total: 4 done + 1 dropped is 4/4', () => {
    expect(planProgress(['done', 'done', 'done', 'done', 'cancelled'])).toEqual({ done: 4, total: 4 })
    expect(planProgress(['done', 'pending', 'cancelled'])).toEqual({ done: 1, total: 2 })
  })
  it('the graph draws a dropped node apart from a blocked one', () => {
    const p = layoutPlan({
      title: 'P',
      tasks: [
        { id: 'a', title: 'A', owner: 'writer', status: 'cancelled', dependsOn: [] },
        { id: 'b', title: 'B', owner: 'writer', status: 'blocked', dependsOn: ['a'] },
      ],
    } as never)
    const nodes = p.flatMap((pool) => pool.nodes)
    expect(nodes.find((n) => n.id === 'a')!.state).toBe('dropped')
    expect(nodes.find((n) => n.id === 'b')!.state).toBe('blocked')
  })
  it('a conversation that worked a dropped task says so — no ✓', () => {
    expect(workWord({ state: 'cancelled', closed: false, current: true })).toEqual({ word: 'worked', lead: 'Worked on', state: 'dropped' })
    expect(workWord({ state: 'done', closed: false, current: true }).word).toBe('done')
  })
})

describe('labels (A6/M5/M7/B6)', () => {
  it("a missing sibling takes its task's prefix — the project for the project's list", () => {
    expect(labelOf({ label: 'proj#t3' }, 't9')).toBe('proj#t9')
    expect(labelOf({ label: 'ship#t3' }, 't9')).toBe('ship#t9')
  })
  it("an archived task of the project's list keeps its project label", () => {
    const t = task(
      't3',
      { state: 'done' },
      {
        file: '/home/u/proj/plans/closed/tasks-2026-10.plan.json',
        parent: { key: 'folder:/home/u/proj/tasks-2026-10', identity: 'proj — closed 2026-10', at: null },
      },
    )
    expect(t.label).toBe('proj#t3')
  })
  it("no alias: `backlog#t3` (an old name of the project's list) names no task", () => {
    const a = task(
      't3',
      {},
      {
        key: 'folder:/home/u/a/tasks/tasks/t3',
        anchors: { folder: '/home/u/a' },
        file: '/home/u/a/plans/tasks.plan.json',
        parent: { key: 'folder:/home/u/a/tasks', identity: '', at: null, standingList: true },
      },
    )
    expect(taskOfRef('backlog#t3', [a])).toBeNull()
    expect(taskOfRef('tasks#t3', [a])).toBe(a)
  })
})
