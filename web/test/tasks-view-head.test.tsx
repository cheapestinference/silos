// tasks-view-head.test.tsx — what the Tasks head counts and the plan's house
// says, as numbers and sets (never words): the head sentence counts kinds
// apart (inPlans + noPlan === open; the project's list is never «a plan»);
// narrowed to exactly ONE named plan the view grows a head computed over the
// plan's ALL tasks, its wait line only when a wait names you.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { TasksView, headCounts, planHeadOf } from '../src/components/tasks/TasksView'
import { useStore } from '../src/store'
import { api } from '../src/lib/api'
import { resetTasksCache } from '../src/hooks/useTasks'
import { NO_PLAN_FACET, taskOfRow, type ChainFacts, type TaskView } from '../src/lib/tasks'
import { serverTaskRow } from './server-task-row'
import type { SiloRecordRow, SiloRecordsPage } from '../src/lib/types'

vi.mock('../src/lib/api', async (orig) => {
  const real = await orig<typeof import('../src/lib/api')>()
  return {
    ...real,
    api: {
      ...real.api,
      silos: { ...real.api.silos, records: vi.fn() },
      tasksBySession: vi.fn(async () => ({})),
      taskSeen: { read: vi.fn(async () => ({ seen: {} })), mark: vi.fn(async () => null) },
    },
  }
})
const mocked = vi.mocked(api, { deep: true })

const SHIP = 'folder:/home/u/proj/ship'
const DOCS = 'folder:/home/u/proj/docs'
const LIST = 'folder:/home/u/proj/tasks'
const row = (plan: string, id: string, value: Record<string, unknown>): SiloRecordRow =>
  serverTaskRow({
    key: `${plan}/tasks/${id}`,
    id,
    identity: id,
    state: String(value.state ?? 'pending'),
    stateLabel: '',
    at: null,
    anchors: { folder: '/home/u/proj' },
    cells: [],
    row: '',
    folded: false,
    overlay: false,
    conflict: false,
    remarks: [],
    file: `/home/u/proj/plans/${plan.slice(plan.lastIndexOf('/') + 1)}.plan.json`,
    parent: { key: plan, identity: plan === LIST ? '' : plan === SHIP ? 'Ship it' : 'Docs', at: null },
    value: { id, owner: 'builder', dependsOn: [], conversations: [], notes: [], ...value },
    moved: null,
  } as unknown as SiloRecordRow)
const task = (plan: string, id: string, value: Record<string, unknown> = {}): TaskView => taskOfRow(row(plan, id, value))!
const facts: ChainFacts = { agentIds: new Set(['builder']), isLive: () => false, nameOf: (id) => id }

describe('headCounts — kinds apart', () => {
  it('inPlans + noPlan === open; planCount counts named plans only', () => {
    const shown = [task(SHIP, 't1'), task(SHIP, 't2'), task(DOCS, 't1'), task(LIST, 't1'), task(LIST, 't2'), task(LIST, 't3')]
    const c = headCounts(shown, () => false)
    expect(c).toMatchObject({ open: 6, inPlans: 3, planCount: 2, noPlan: 3 })
    expect(c.inPlans + c.noPlan).toBe(c.open)
  })
  it("only the project's list: no plan at all", () => {
    const c = headCounts([task(LIST, 't1'), task(LIST, 't2')], () => false)
    expect(c).toMatchObject({ open: 2, inPlans: 0, planCount: 0, noPlan: 2 })
  })
  it('untouched and live count open tasks only', () => {
    const stalled = { ...task(SHIP, 't1'), flow: { waiting: false, gate: false, unblocks: [], stalled: true, stalledCause: null, stalledBy: null } } as TaskView
    const doneStalled = { ...task(SHIP, 't2', { state: 'done' }), flow: stalled.flow } as TaskView
    const c = headCounts([stalled, doneStalled, task(LIST, 't1')], (t) => t.planKey === LIST || t.id === 't2')
    expect(c).toMatchObject({ stalled: 1, live: 1 })
  })
})

describe("planHeadOf — the plan's house", () => {
  const all = [
    task(SHIP, 't1', { state: 'done' }),
    task(SHIP, 't2', { state: 'cancelled' }),
    task(SHIP, 't3', { state: 'pending' }),
    task(SHIP, 't4', { state: 'done' }),
    task(DOCS, 't1'),
    task(LIST, 't1'),
  ]
  it('only under exactly one named plan — never «No plan», never the list, never two', () => {
    expect(planHeadOf([SHIP], all, facts)).not.toBeNull()
    expect(planHeadOf(undefined, all, facts)).toBeNull()
    expect(planHeadOf([], all, facts)).toBeNull()
    expect(planHeadOf([SHIP, DOCS], all, facts)).toBeNull()
    expect(planHeadOf([NO_PLAN_FACET], all, facts)).toBeNull()
    expect(planHeadOf([LIST], all, facts)).toBeNull()
  })
  it("its numbers are over ALL the plan's tasks (dropped out of the total), whatever the view shows", () => {
    expect(planHeadOf([SHIP], all, facts)).toMatchObject({ planKey: SHIP, done: 2, total: 3, waitsOnYou: null })
  })
  it('the wait line only when a wait names you', () => {
    const onSam = [...all, task(SHIP, 't5', { waitingOn: { owner: 'sam', action: 'sign' } })]
    expect(planHeadOf([SHIP], onSam, facts)?.waitsOnYou).toBeNull()
    const onBuilder = [...all, task(SHIP, 't5', { waitingOn: { owner: 'builder', action: 'review' } })]
    expect(planHeadOf([SHIP], onBuilder, facts)?.waitsOnYou).toBeNull()
    const onYouDone = [...all, task(SHIP, 't5', { state: 'done', waitingOn: { owner: 'owner', action: 'confirm' } })]
    expect(planHeadOf([SHIP], onYouDone, facts)?.waitsOnYou).toBeNull()
    const onYou = [...all, task(SHIP, 't5', { waitingOn: { owner: 'owner', action: 'confirm' } })]
    expect(planHeadOf([SHIP], onYou, facts)?.waitsOnYou).toEqual(expect.any(String))
  })
})

describe('Tasks narrowed to one plan — the head is drawn', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetTasksCache()
    const records = [
      row(SHIP, 't1', { state: 'done' }),
      row(SHIP, 't2', { state: 'pending', waitingOn: { owner: 'owner', action: 'confirm' } }),
      row(LIST, 't1', {}),
    ]
    const page: SiloRecordsPage = {
      silo: { id: 'plans', name: 'Plans', state: 'active', freshness: null },
      kind: { name: 'plans/plan/task', states: [], columns: [], columnTypes: {}, facets: [], stateEdit: null },
      total: records.length,
      matching: records.length,
      offset: 0,
      limit: 200,
      said: null,
      unreadable: { count: 0, items: [] },
      records: records as never,
    }
    mocked.silos.records.mockResolvedValue(page)
  })
  it('one named plan: the head with its wait; «No plan»: none', async () => {
    useStore.setState({ agents: [], silos: [], page: { kind: 'tasks', view: 'open', plan: [SHIP] } as never })
    const { unmount } = render(<TasksView />)
    expect(await screen.findByTestId('plan-head')).toBeInTheDocument()
    expect(screen.getByTestId('plan-head-wait')).toBeInTheDocument()
    unmount()
    useStore.setState({ page: { kind: 'tasks', view: 'open', plan: [NO_PLAN_FACET] } as never })
    render(<TasksView />)
    await screen.findAllByTestId('task-row')
    expect(screen.queryByTestId('plan-head')).not.toBeInTheDocument()
  })
})
