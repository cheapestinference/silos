// home-projects.test.ts — the pure side of Home by project.
import { describe, expect, it } from 'vitest'
import {
  folderOfRow,
  groupPlans,
  isTaskRow,
  projectSections,
  sectionCounts,
  splitPlans,
  taskFile,
  taskPageOf,
  taskTitle,
  type ProjectSection,
  type TaskItem,
} from '../src/lib/home-projects'
import type { AgentView, InboxRow } from '../src/lib/types'

const agent = (id: string, folder: string | null): AgentView => ({ id, name: id, emoji: '', folder, skills: [], sessions: [], liveCount: 0, sessionCount: 0 })
const NOW = Date.parse('2026-11-01T12:00:00Z')
// a plans-silo task row (server silos/surfaces.ts: `parent` set)
const task = (plan: string, id: string, at: string, over: Record<string, unknown> = {}): TaskItem =>
  ({
    kind: 'silo',
    key: `silo:entry:plans:folder:/p/${plan}/tasks/${id}`,
    urgency: 'routine',
    at: Date.parse(at),
    voice: '',
    clears: '',
    item: {
      kind: 'silo',
      reason: 'entry',
      silo: 'plans',
      siloName: 'Plans',
      key: `folder:/p/${plan}/tasks/${id}`,
      recordKind: 'plan/task',
      urgency: 'routine',
      text: `${id} — pending`,
      identity: id,
      at,
      folder: '/p',
      file: `/p/plans/${plan}.plan.json`,
      parent: { key: `folder:/p/${plan}`, kind: 'plan', identity: plan.toUpperCase(), at, ...(plan === 'tasks' ? { standingList: true as const } : {}) },
      ...over,
    },
  }) as TaskItem
const item = (plan: string, id: string, at: string): TaskItem => task(plan, id, at)

describe('folderOfRow', () => {
  const agents = [agent('support', '/ci'), agent('writer', '/ci'), agent('silos', '/silos')]
  it('a support summary belongs to a project only when every agent in it lives there', () => {
    expect(
      folderOfRow(
        { kind: 'siloSummary', count: 3, agentIds: ['support', 'writer'], folders: [], byAgent: { support: 2, writer: 1 } } as unknown as InboxRow,
        agents,
      ),
    ).toBe('/ci')
    expect(
      folderOfRow(
        { kind: 'siloSummary', count: 3, agentIds: ['support', 'silos'], folders: [], byAgent: { support: 2, silos: 1 } } as unknown as InboxRow,
        agents,
      ),
    ).toBeNull()
  })
})

describe('groupPlans / splitPlans', () => {
  it('one group per plan file, the one with most of yours first', () => {
    const g = groupPlans([item('a', 't1', '2026-10-30'), item('b', 't1', '2026-10-31'), item('b', 't2', '2026-10-31')])
    expect(g.map((p) => [p.file, p.tasks.length])).toEqual([
      ['/p/plans/b.plan.json', 2],
      ['/p/plans/a.plan.json', 1],
    ])
  })
  it('three in view; idle 2+ weeks always folded, after the live overflow', () => {
    const g = groupPlans(['a', 'b', 'c', 'd'].map((f) => item(f, 't', '2026-10-30')).concat(item('old', 't', '2026-10-01')))
    const s = splitPlans(g, NOW)
    expect(s.shown).toHaveLength(3)
    expect(s.folded.map((p) => p.file).at(-1)).toBe('/p/plans/old.plan.json')
    expect(s.idle).toBe(1)
  })
})

describe('sectionCounts', () => {
  it('says only what is true and non-zero', () => {
    const base: ProjectSection = { folder: '/p', name: 'p', rows: [], quiet: [], plans: [], asks: 0, working: 0, lastActive: 0 }
    expect(sectionCounts(base)).toBe('')
    expect(sectionCounts({ ...base, asks: 1, working: 2, plans: groupPlans([item('a', 't1', '2026-10-30'), item('a', 't2', '2026-10-30')]) })).toBe(
      '1 needs you · 2 working · 2 to do in 1 plan',
    )
  })
})

// the project's list is no plan — never counted as one
describe("the project's list in Home's counts", () => {
  it('its group is standing, has no title, and «in M plans» counts only the named ones', () => {
    const g = groupPlans([item('tasks', 't1', '2026-10-30'), item('tasks', 't2', '2026-10-30'), item('a', 't1', '2026-10-30')])
    expect(g.map((p) => [p.key, p.standing, p.title])).toEqual([
      ['folder:/p/tasks', true, ''],
      ['folder:/p/a', false, 'A'],
    ])
    const base: ProjectSection = { folder: '/p', name: 'p', rows: [], quiet: [], plans: g, asks: 0, working: 0, lastActive: 0 }
    expect(sectionCounts(base)).toBe('3 to do in 1 plan')
    expect(sectionCounts({ ...base, plans: groupPlans([item('tasks', 't1', '2026-10-30')]) })).toBe('1 to do')
  })
  it("the server's standingList marks it whatever the id", () => {
    const t = task('inbox', 't1', '2026-10-30')
    const marked = { ...t, item: { ...t.item, parent: { ...t.item.parent, standingList: true as const } } } as TaskItem
    expect(groupPlans([marked])[0]!.standing).toBe(true)
  })
})

// G5 (plans phase 1): a silo's sub-kind rows (a plan's tasks, `parent` set)
// group by their parent like the native plan rows did — never one line per
// silo, never one row each
describe('silo task rows — grouped by parent', () => {
  it('one group per parent record: its identity, moment, file and kind; idle ones fold like a plan', () => {
    const g = groupPlans([task('a', 't1', '2026-10-30'), task('b', 't1', '2026-10-31'), task('b', 't2', '2026-10-31'), task('old', 't', '2026-10-01')])
    expect(g.map((p) => [p.key, p.title, p.kind, p.file, p.tasks.length])).toEqual([
      ['folder:/p/b', 'B', 'plan', '/p/plans/b.plan.json', 2],
      ['folder:/p/a', 'A', 'plan', '/p/plans/a.plan.json', 1],
      ['folder:/p/old', 'OLD', 'plan', '/p/plans/old.plan.json', 1],
    ])
    expect(splitPlans(g, NOW).idle).toBe(1)
    expect(taskTitle(g[0]!.tasks[0]!)).toBe('t1')
    expect(taskFile(g[0]!.tasks[0]!)).toBe('/p/plans/b.plan.json')
  })

  it('a silo row is a task row only with a parent; the section counts it in its plans', () => {
    const t = task('a', 't1', '2026-10-30')
    expect(isTaskRow(t)).toBe(true)
    const { parent: _p, ...plain } = (t as Extract<TaskItem, { kind: 'silo' }>).item
    expect(isTaskRow({ ...t, item: plain } as unknown as InboxRow)).toBe(false)
    const [sec] = projectSections({ rows: [], planItems: [t, task('a', 't2', '2026-10-30')], waiting: [], agents: [agent('writer', '/p')] })
    expect(sectionCounts(sec!)).toBe('2 to do in 1 plan')
  })
})

describe('taskPageOf — a Needs you task row opens its task (task-view phase 2)', () => {
  it('the plan key and the task id, read off the record key', () => {
    expect(taskPageOf(task('ship', 't2', '2026-11-01T00:00:00Z'))).toEqual({ kind: 'task', plan: 'folder:/p/ship', task: 't2' })
  })
  it('a key that is not <parent>/<collection>/<id> opens nothing', () => {
    expect(taskPageOf(task('ship', 't2', '2026-11-01T00:00:00Z', { key: 'elsewhere/t2' }))).toBeNull()
  })
})
