// The sidebar's Tasks doors: the switch changes the list and nothing
// else; «All tasks · N open» opens the set it counts; Now's «more» opens the
// view its left-out rows belong to.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { useStore } from '../src/store'
import { taskOfRow, type TaskView } from '../src/lib/tasks'
import type { SiloRecordRow } from '../src/lib/types'
import { serverTaskRow } from './server-task-row'

const PLAN = 'folder:/home/u/proj/ship'
const row = (id: string, value: Record<string, unknown>): SiloRecordRow =>
  ({
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
    parent: { key: PLAN, identity: 'Ship it', at: '2026-11-01T10:00:00Z' },
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
})
