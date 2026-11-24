// A task of yours in the PLANS SILO (a sub-kind row: `parent` set, server
// silos/surfaces.ts) — the native plan row's twin, said the same way: a
// gate or a near date waits in Needs you with its why after its title and
// Done / Drop beside it (set-field; a Drop leaves its «Dropped:» note first);
// a routine one stays in its project's «yours to do», grouped by its plan.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { HomePage } from '../src/components/home/HomePage'
import { useStore } from '../src/store'
import { api } from '../src/lib/api'
import { headline, isWaiting, taskWhy } from '../src/lib/home'
import { taskRefOf, type TaskItem } from '../src/lib/home-projects'
import type { AgentView, InboxRow, SiloNeedsYou, SiloDescriptor } from '../src/lib/types'
import { siloRow } from './inbox-rows'
import { openNeedsYou, openYours } from './home-tiles'

vi.mock('../src/lib/api')
const mockedApi = vi.mocked(api, { deep: true })
const NOW = Date.parse('2026-11-02T12:00:00.000Z')

function agent(o: Partial<AgentView> = {}): AgentView {
  return { id: 'writer', name: 'Writer', emoji: '🛠', folder: '/proj', skills: [], sessions: [], liveCount: 0, sessionCount: 0, ...o }
}
const board = (inbox: InboxRow[]) => ({ cards: [], needsYou: [], inbox })
const task = (id: string, o: Partial<SiloNeedsYou> = {}, plan = 'ship', planTitle = 'Ship'): SiloNeedsYou => ({
  kind: 'silo',
  reason: 'entry',
  silo: 'plans',
  siloName: 'Plans',
  key: `folder:/proj/${plan}/tasks/${id}`,
  recordKind: 'plan/task',
  urgency: 'routine',
  text: `Task ${id} — pending`,
  identity: `Task ${id}`,
  at: '2026-11-01',
  folder: '/proj',
  file: `/proj/plans/${plan}.plan.json`,
  entry: 1,
  actions: ['open', 'set-field', 'append-item'],
  parent: { key: `folder:/proj/${plan}`, kind: 'plan', identity: planTitle, at: '2026-11-01' },
  resolve: { field: 'status', done: 'done', drop: 'cancelled', note: 'notes' },
  ...o,
})
// as the server sends a gate: due, the row says whose work it unblocks
const gate = (id: string): InboxRow => siloRow(task(id, { urgency: 'due', entry: 0, text: `Task ${id} — pending · unblocks 1 task of E2E` }))
const routine = (id: string, plan = 'ship', planTitle = 'Ship'): InboxRow =>
  siloRow(task(id, { text: `Routine ${id} — pending`, identity: `Routine ${id}` }, plan, planTitle))
const plansSilo = {
  id: 'plans',
  name: 'Plans',
  state: 'active',
  slots: { requested: [], granted: ['needs-you'], off: ['pulse'] },
  records: { parsed: 3, failed: 0 },
} as unknown as SiloDescriptor

beforeEach(() => {
  vi.clearAllMocks()
  mockedApi.tasks.mockResolvedValue({ sessions: [] })
  mockedApi.silos.list.mockResolvedValue({ silos: [plansSilo] })
  useStore.setState({ agents: [agent()], automations: [], automationsPending: [], nowTick: NOW, page: null, silos: [plansSilo] })
})

describe('the words', () => {
  it('a due task row waits; a routine one is yours to do; the why is read off the row', () => {
    expect(isWaiting(gate('g1'))).toBe(true)
    expect(isWaiting(routine('r1'))).toBe(false)
    expect(taskWhy(gate('g1') as Extract<InboxRow, { kind: 'silo' }>)).toBe(' — unblocks 1 task of E2E')
    expect(taskWhy(siloRow(task('d', { text: 'Task d — in progress · unblocks 1 task of E2E · due Nov 6' })))).toBe(' — unblocks 1 task of E2E — due Nov 6')
    expect(taskWhy(routine('r1') as Extract<InboxRow, { kind: 'silo' }>)).toBe('')
    expect(taskRefOf(gate('g1') as TaskItem)).toBe('ship#g1')
  })

  it('the pulse names a gate when it is the first thing waiting', () => {
    expect(headline({ inbox: [gate('g1')], working: [], agentName: (id) => id, now: NOW, ago: () => '' })).toBe('Task g1 is yours — unblocks 1 task of E2E.')
  })
})

describe('HomePage — a plans-silo task in Needs you', () => {
  it('says the task, its plan and why, with Done and Drop; a routine task stays in its project; no Plans tile', async () => {
    mockedApi.board.mockResolvedValue(board([gate('g1'), routine('r1')]))
    render(<HomePage />)
    const inbox = await openNeedsYou()
    expect(await within(inbox).findByText('Task g1')).toBeInTheDocument()
    expect(within(inbox).getByText(/unblocks 1 task/)).toBeInTheDocument()
    expect(within(inbox).getByText('ship#g1')).toBeInTheDocument()
    expect(within(inbox).getByRole('button', { name: 'Done' })).toBeInTheDocument()
    expect(within(inbox).getByRole('button', { name: 'Drop…' })).toBeInTheDocument()
    expect(within(inbox).queryByText('Routine r1')).toBeNull()
    expect(screen.queryByTestId('silo-tile-plans')).toBeNull()
    const proj = within(await openYours()).getByRole('region', { name: 'proj' })
    expect(within(proj).getByText(/Routine r1/)).toBeInTheDocument()
  })

  it("Done = the owner's verb on the task with the state the row painted (one write); the row leaves; the handoff says who moves", async () => {
    mockedApi.board.mockResolvedValue(board([gate('g1')]))
    mockedApi.tasksAct.mockResolvedValue({
      key: 'folder:/proj/ship/tasks/g1',
      record: { tasks: [{ id: 'g1', state: 'done' }] },
      already: false,
      holds: [],
      nowReady: [
        { key: 'k1', id: 'w1', identity: 'Ship it', owner: 'writer', wakes: 'never' },
        { key: 'k2', id: 'w2', identity: 'Ask Sam', owner: 'sam' },
      ],
    })
    render(<HomePage />)
    const inbox = await openNeedsYou()
    fireEvent.click(await within(inbox).findByRole('button', { name: 'Done' }))
    expect(mockedApi.tasksAct).toHaveBeenCalledWith({ key: 'folder:/proj/ship/tasks/g1', verb: 'done', state: expect.any(String) })
    expect(mockedApi.silos.setField).not.toHaveBeenCalled()
    expect(mockedApi.silos.append).not.toHaveBeenCalled()
    await waitFor(() => expect(within(inbox).queryByText('Task g1')).toBeNull())
    const line = await screen.findByTestId('plan-handoff')
    expect(line).toHaveTextContent('Writer')
    expect(line).toHaveTextContent('Ship it')
    expect(line).not.toHaveTextContent('Sam')
  })

  it('Drop… is the same small confirm as the task page (never one click): the verb drop with its reason — the note and the close are one write', async () => {
    mockedApi.board.mockResolvedValue(board([gate('g1')]))
    mockedApi.silos.record.mockResolvedValue({ version: 'v1', value: { notes: [] } } as never)
    mockedApi.tasksAct.mockResolvedValue({ key: 'folder:/proj/ship/tasks/g1', record: { tasks: [] }, already: false, holds: [] })
    render(<HomePage />)
    const inbox = await openNeedsYou()
    fireEvent.click(await within(inbox).findByRole('button', { name: 'Drop…' }))
    expect(mockedApi.silos.append).not.toHaveBeenCalled()
    const form = await within(inbox).findByTestId('home-drop-confirm')
    fireEvent.change(within(form).getByLabelText('Why it is dropped'), { target: { value: 'not needed' } })
    fireEvent.click(within(form).getByRole('button', { name: 'Drop' }))
    await waitFor(() =>
      expect(mockedApi.tasksAct).toHaveBeenCalledWith({ key: 'folder:/proj/ship/tasks/g1', verb: 'drop', state: expect.any(String), text: 'not needed' }),
    )
    expect(mockedApi.silos.append).not.toHaveBeenCalled()
    expect(mockedApi.silos.setField).not.toHaveBeenCalled()
  })

  it('Drop… then Cancel writes nothing and the row keeps its actions', async () => {
    mockedApi.board.mockResolvedValue(board([gate('g1')]))
    render(<HomePage />)
    const inbox = await openNeedsYou()
    fireEvent.click(await within(inbox).findByRole('button', { name: 'Drop…' }))
    fireEvent.click(within(await within(inbox).findByTestId('home-drop-confirm')).getByRole('button', { name: 'Cancel' }))
    expect(within(inbox).getByRole('button', { name: 'Done' })).toBeInTheDocument()
    expect(mockedApi.silos.append).not.toHaveBeenCalled()
    expect(mockedApi.silos.setField).not.toHaveBeenCalled()
  })

  it("a refusal comes back under its row, in the server's words, and the row returns", async () => {
    mockedApi.board.mockResolvedValue(board([gate('g1')]))
    mockedApi.tasksAct.mockRejectedValue(new Error('it changed — it is in progress now'))
    render(<HomePage />)
    const inbox = await openNeedsYou()
    fireEvent.click(await within(inbox).findByRole('button', { name: 'Done' }))
    expect(await within(inbox).findByTestId('needs-you-row-error')).toHaveTextContent('It changed — it is in progress now.')
    expect(within(inbox).getByText('Task g1')).toBeInTheDocument()
  })

  it("the row itself opens the TASK's page (task-view phase 2); «Open task» says so", async () => {
    mockedApi.board.mockResolvedValue(board([gate('g1')]))
    const changePage = vi.fn()
    useStore.setState({ changePage })
    render(<HomePage />)
    const inbox = await openNeedsYou()
    fireEvent.click(await within(inbox).findByText('Task g1'))
    expect(changePage).toHaveBeenCalledWith({ kind: 'task', plan: 'folder:/proj/ship', task: 'g1', from: { kind: 'needs-you' } })
    changePage.mockClear()
    fireEvent.click(within(inbox).getByRole('button', { name: 'Open task' }))
    expect(changePage).toHaveBeenCalledWith({ kind: 'task', plan: 'folder:/proj/ship', task: 'g1', from: { kind: 'needs-you' } })
  })

  it('gates never fold: six all show in Needs you, while routine plans past the first three fold', async () => {
    const plans = ['a', 'b', 'c', 'd', 'e'].map((f) => routine(f, f, `Plan ${f}`))
    mockedApi.board.mockResolvedValue(board([...['g1', 'g2', 'g3', 'g4', 'g5', 'g6'].map((id) => gate(id)), ...plans]))
    render(<HomePage />)
    const inbox = await openNeedsYou()
    await within(inbox).findByText('Task g1')
    expect(within(inbox).getAllByRole('button', { name: 'Drop…' })).toHaveLength(6)
    // Home's one list: the six gates first, then the first of your own; the rest counted for its door
    act(() => useStore.getState().setHomeSheet(null))
    const rows = screen.getAllByTestId('needs-you-row')
    expect(rows.map((r) => r.getAttribute('data-holds'))).toEqual(['true', 'true', 'true', 'true', 'true', 'true', 'false'])
    expect(screen.getByTestId('yours-more')).toHaveTextContent('4 more of your own')
    const proj = within(await openYours()).getByRole('region', { name: 'proj' })
    expect(within(proj).getAllByTestId('plan-group')).toHaveLength(5)
  })
})
