// home.task-gesture.test.tsx — Home's Needs you rows call the owner's ONE
// verb with what the row painted: a choice
// of an agent's question is `answer` with the question; an agent's review
// that waits on you offers Approve (`approve`) and Send back (`answer` with
// the words); a refusal is said under ITS row, which comes back;
// «Answer and open ›» opens only when the answer went in.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, waitFor, within } from '@testing-library/react'
import { HomePage } from '../src/components/home/HomePage'
import { useStore } from '../src/store'
import { api } from '../src/lib/api'
import { resetTasksCache } from '../src/hooks/useTasks'
import type { AgentView, InboxRow, SiloNeedsYou, SiloDescriptor, SiloRecordsPage } from '../src/lib/types'
import { siloRow } from './inbox-rows'
import { openNeedsYou } from './home-tiles'

vi.mock('../src/lib/api')
const mockedApi = vi.mocked(api, { deep: true })
const NOW = Date.parse('2026-11-02T12:00:00.000Z')
const PLAN = 'folder:/proj/ship'
const KEY = `${PLAN}/tasks/t1`

const agent = (o: Partial<AgentView> = {}): AgentView => ({
  id: 'writer',
  name: 'Writer',
  emoji: '🛠',
  folder: '/proj',
  skills: [],
  sessions: [],
  liveCount: 0,
  sessionCount: 0,
  ...o,
})
const plansSilo = {
  id: 'plans',
  name: 'Plans',
  state: 'active',
  slots: { requested: [], granted: ['needs-you'], off: ['pulse'] },
  records: { parsed: 1, failed: 0 },
} as unknown as SiloDescriptor
// the row the server sends for an agent's task waiting on you
const row = (text: string): InboxRow =>
  siloRow({
    kind: 'silo',
    reason: 'entry',
    silo: 'plans',
    siloName: 'Plans',
    key: KEY,
    recordKind: 'plan/task',
    urgency: 'due',
    text,
    identity: 'Write the page',
    at: '2026-11-01',
    folder: '/proj',
    file: '/proj/plans/ship.plan.json',
    entry: 1,
    actions: ['open', 'append-item'],
    parent: { key: PLAN, kind: 'plan', identity: 'Ship', at: '2026-11-01' },
  } as SiloNeedsYou)
// the task as the reading has it (what the row paints its question from)
function reading(state: string, waitingOn: Record<string, unknown>): void {
  const page: SiloRecordsPage = {
    silo: { id: 'plans', name: 'Plans', state: 'active', freshness: null },
    kind: { name: 'plans/plan/task', states: [], columns: [], columnTypes: {}, facets: [], stateEdit: null },
    total: 1,
    matching: 1,
    offset: 0,
    limit: 200,
    said: null,
    unreadable: { count: 0, items: [] },
    records: [
      {
        key: KEY,
        id: 't1',
        identity: 'Write the page',
        state,
        stateLabel: state,
        at: null,
        anchors: { folder: '/proj' },
        cells: [],
        row: '',
        folded: false,
        overlay: false,
        conflict: false,
        remarks: [],
        file: '/proj/plans/ship.plan.json',
        parent: { key: PLAN, identity: 'Ship', at: '2026-11-01' },
        value: { id: 't1', title: 'Write the page', owner: 'writer', state, dependsOn: [], waitingOn },
      } as never,
    ],
  }
  mockedApi.silos.records.mockResolvedValue(page)
}
const went = { key: KEY, record: { tasks: [{ id: 't1', state: 'pending' }] }, already: false, holds: [] }

beforeEach(() => {
  vi.clearAllMocks()
  resetTasksCache()
  mockedApi.tasks.mockResolvedValue({ sessions: [] })
  mockedApi.silos.list.mockResolvedValue({ silos: [plansSilo] })
  useStore.setState({ agents: [agent()], automations: [], automationsPending: [], nowTick: NOW, page: null, silos: [plansSilo] })
})

describe("Home — a question of an agent's on you", () => {
  it('a choice is the verb answer with its words and the question the row painted', async () => {
    reading('blocked', { owner: 'owner', action: 'decide', asked: 'Publish today?', options: ['Yes', 'No'] })
    mockedApi.board.mockResolvedValue({ cards: [], needsYou: [], inbox: [row('Writer asks: Publish today?')] })
    mockedApi.tasksAct.mockResolvedValue(went)
    render(<HomePage />)
    const inbox = await openNeedsYou()
    fireEvent.click(await within(inbox).findByRole('button', { name: 'Yes' }))
    await waitFor(() => expect(mockedApi.tasksAct).toHaveBeenCalledWith({ key: KEY, verb: 'answer', text: 'Yes', asked: 'Publish today?' }))
    expect(mockedApi.silos.append).not.toHaveBeenCalled()
    expect(mockedApi.silos.setField).not.toHaveBeenCalled()
  })
  it('refused («it asks something else now»): said under its row, and the row comes back', async () => {
    reading('blocked', { owner: 'owner', action: 'decide', asked: 'Publish today?', options: ['Yes', 'No'] })
    mockedApi.board.mockResolvedValue({ cards: [], needsYou: [], inbox: [row('Writer asks: Publish today?')] })
    mockedApi.tasksAct.mockRejectedValue(new Error('it asks something else now'))
    render(<HomePage />)
    const inbox = await openNeedsYou()
    fireEvent.click(await within(inbox).findByRole('button', { name: 'Yes' }))
    expect(await within(inbox).findByTestId('needs-you-row-error')).toHaveTextContent('It asks something else now.')
    expect(within(inbox).getByTestId('needs-you-ask')).toBeInTheDocument()
  })
})

describe("Home — an agent's review that waits on you", () => {
  beforeEach(() => {
    reading('in_review', { owner: 'owner', action: 'review it', asked: 'Good to ship?' })
    mockedApi.board.mockResolvedValue({ cards: [], needsYou: [], inbox: [row('Writer asks: Good to ship?')] })
  })
  it('Approve is the verb approve with the question painted', async () => {
    mockedApi.tasksAct.mockResolvedValue({ ...went, record: { tasks: [{ id: 't1', state: 'done' }] } })
    render(<HomePage />)
    const inbox = await openNeedsYou()
    fireEvent.click(await within(inbox).findByRole('button', { name: 'Approve' }))
    await waitFor(() => expect(mockedApi.tasksAct).toHaveBeenCalledWith({ key: KEY, verb: 'approve', asked: 'Good to ship?' }))
  })
  it('Send back is the verb answer with the words — never a loose note', async () => {
    mockedApi.tasksAct.mockResolvedValue(went)
    render(<HomePage />)
    const inbox = await openNeedsYou()
    fireEvent.click(await within(inbox).findByRole('button', { name: 'Send back…' }))
    const box = await within(inbox).findByTestId('home-send-back')
    fireEvent.change(within(box).getByLabelText('What to change'), { target: { value: 'Tighten the intro' } })
    fireEvent.click(within(box).getByRole('button', { name: 'Send back' }))
    await waitFor(() => expect(mockedApi.tasksAct).toHaveBeenCalledWith({ key: KEY, verb: 'answer', text: 'Tighten the intro', asked: 'Good to ship?' }))
    expect(mockedApi.silos.append).not.toHaveBeenCalled()
  })
})

describe('Home — Done on a task row sends the state the row was composed with', () => {
  it("the tasks reading has not loaded: the row's own state goes, never an empty one", async () => {
    mockedApi.silos.records.mockReturnValue(new Promise(() => {})) // the reading never arrives
    const done = siloRow({
      kind: 'silo',
      reason: 'entry',
      silo: 'plans',
      siloName: 'Plans',
      key: KEY,
      recordKind: 'plan/task',
      urgency: 'due',
      text: 'Write the page — in progress',
      identity: 'Write the page',
      at: '2026-11-01',
      folder: '/proj',
      file: '/proj/plans/ship.plan.json',
      entry: 0,
      actions: ['open', 'set-field'],
      parent: { key: PLAN, kind: 'plan', identity: 'Ship', at: '2026-11-01' },
      resolve: { field: 'status', done: 'done', note: 'notes' },
      state: 'in_progress',
    } as SiloNeedsYou)
    mockedApi.board.mockResolvedValue({ cards: [], needsYou: [], inbox: [done] })
    mockedApi.tasksAct.mockResolvedValue({ ...went, record: { tasks: [{ id: 't1', state: 'done' }] } })
    render(<HomePage />)
    const inbox = await openNeedsYou()
    fireEvent.click(await within(inbox).findByRole('button', { name: 'Done' }))
    await waitFor(() => expect(mockedApi.tasksAct).toHaveBeenCalledWith({ key: KEY, verb: 'done', state: 'in_progress' }))
  })
})
