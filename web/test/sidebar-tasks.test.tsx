// The sidebar's Tasks doors: the switch changes the list and nothing
// else; «All tasks · N open» opens the set it counts; Now's «more» opens the
// view its left-out rows belong to. The photograph (work-photograph R1/R2):
// plans before the loose tasks, each plan's fraction over ALL its tasks, the
// «No plan» group only when loose tasks exist, «Finished plans ›» → Done.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { useStore } from '../src/store'
import { taskOfRow, type TaskView } from '../src/lib/tasks'
import type { SiloRecordRow } from '../src/lib/types'
import { serverTaskRow } from './server-task-row'

const PLAN = 'folder:/home/u/proj/ship'
const LIST = 'folder:/home/u/proj/tasks'
const row = (id: string, value: Record<string, unknown>, plan = PLAN): SiloRecordRow =>
  ({
    key: `${plan}/tasks/${id}`,
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
    file: `/home/u/proj/plans/${plan.slice(plan.lastIndexOf('/') + 1)}.plan.json`,
    parent: { key: plan, identity: plan === PLAN ? 'Ship it' : '', at: '2026-11-01T10:00:00Z' },
    flow: { waiting: false, gate: false, unblocks: [], stalled: false, stalledCause: null, stalledBy: null },
    value: { id, title: id, owner: 'writer', dependsOn: [], conversations: [], notes: [], ...value },
    moved: null,
  }) as SiloRecordRow
let tasks: TaskView[] = []
vi.mock('../src/hooks/useTasks', () => ({ useTasks: () => ({ state: 'ready', tasks }) }))
vi.mock('../src/hooks/useTaskSeen', () => ({ useNewTasks: () => new Set<string>() }))

const { SidebarListSwitch, SidebarTasks } = await import('../src/components/tasks/SidebarTasks')

beforeEach(() => {
  tasks = []
  useStore.setState({ page: null, sidebarList: 'conversations', agents: [] })
})

describe('the sidebar Tasks doors', () => {
  it('the switch is the door to Tasks: «Tasks» opens the page (an open task stays), «Conversations» leaves it alone', () => {
    render(<SidebarListSwitch />)
    fireEvent.click(screen.getByRole('tab', { name: 'Tasks' }))
    expect(useStore.getState().sidebarList).toBe('tasks')
    expect(useStore.getState().page).toEqual({ kind: 'tasks' })
    fireEvent.click(screen.getByRole('tab', { name: 'Conversations' }))
    expect(useStore.getState().sidebarList).toBe('conversations')
    expect(useStore.getState().page).toEqual({ kind: 'tasks' })
    const open = { kind: 'task' as const, plan: 'p', task: 't1' }
    useStore.setState({ page: open })
    fireEvent.click(screen.getByRole('tab', { name: 'Tasks' }))
    expect(useStore.getState().page).toEqual(open)
  })

  it('«All tasks · N open» opens Tasks › Open, the set it counts', () => {
    tasks = [
      taskOfRow(serverTaskRow(row('a', {})))!,
      taskOfRow(serverTaskRow(row('b', { state: 'in_progress' })))!,
      taskOfRow(serverTaskRow(row('c', { state: 'done' })))!,
    ]
    render(<SidebarTasks />)
    const door = screen.getByTestId('sidebar-all-tasks')
    expect(door).toHaveTextContent('2 open')
    fireEvent.click(door)
    expect(useStore.getState().page).toEqual({ kind: 'tasks', view: 'open' })
  })

  it("Now's «more» opens Yours to do — every row it left out is yours", () => {
    tasks = Array.from({ length: 7 }, (_, i) => taskOfRow(serverTaskRow(row(`y${i}`, { owner: 'owner' })))!)
    render(<SidebarTasks />)
    const more = screen.getByTestId('sidebar-tasks-more')
    expect(more).toHaveTextContent('2 more')
    fireEvent.click(more)
    expect(useStore.getState().page).toEqual({ kind: 'tasks', view: 'mine' })
  })

  it("a project's plans come before its loose tasks, which sit under «No plan»; the plan's door is its house", () => {
    const t = (id: string, v: Record<string, unknown>, plan?: string): TaskView => taskOfRow(serverTaskRow(row(id, v, plan)))!
    tasks = [t('e1', {}, LIST), t('p1', {}), t('p2', { state: 'done' }), t('e2', { state: 'in_progress' }, LIST)]
    render(<SidebarTasks />)
    const project = screen.getByTestId('sidebar-project')
    const plan = screen.getByTestId('sidebar-plan')
    const loose = screen.getByTestId('sidebar-loose')
    expect(project.contains(plan) && project.contains(loose)).toBe(true)
    expect(plan.compareDocumentPosition(loose) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    fireEvent.click(screen.getByTestId('sidebar-plan-open'))
    expect(useStore.getState().page).toEqual({ kind: 'tasks', view: 'open', plan: [PLAN] })
  })

  it("a plan's fraction counts its done tasks over ALL its tasks, a dropped one leaving the total; its yours-count is the owner's open ones", () => {
    const t = (id: string, v: Record<string, unknown>): TaskView => taskOfRow(serverTaskRow(row(id, v)))!
    tasks = [
      t('a', { state: 'done' }),
      t('b', { state: 'done' }),
      t('c', { state: 'cancelled' }),
      t('d', { owner: 'owner' }),
      t('e', {}),
      t('f', { owner: 'owner', state: 'done' }),
    ]
    render(<SidebarTasks />)
    const counts = screen.getByTestId('sidebar-plan-counts')
    expect([counts.dataset.done, counts.dataset.total, counts.dataset.yours]).toEqual(['3', '5', '1'])
  })

  it('without loose tasks there is no «No plan» group', () => {
    tasks = [taskOfRow(serverTaskRow(row('p1', {})))!]
    render(<SidebarTasks />)
    expect(screen.getByTestId('sidebar-plan')).toBeInTheDocument()
    expect(screen.queryByTestId('sidebar-loose')).toBeNull()
  })

  it('«Finished plans ›» opens Tasks › Done — finished plans are never listed in the sidebar', () => {
    tasks = [taskOfRow(serverTaskRow(row('p1', { state: 'done' })))!]
    render(<SidebarTasks />)
    expect(screen.queryByTestId('sidebar-plan')).toBeNull()
    fireEvent.click(screen.getByTestId('sidebar-finished-plans'))
    expect(useStore.getState().page).toEqual({ kind: 'tasks', view: 'done' })
  })
})
