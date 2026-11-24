// task-page.test.tsx — the owner's gestures on a task's page are ONE write
// each: Done, Drop, Reopen, Remove the dependency,
// Reopen the dependency, Answer, Approve and Send back go through the owner's
// verb (POST /api/tasks/act) with what the page painted; a plain note is
// append-item on notes at the file's CAS version; a refusal is said beside
// the control that caused it. Never a file write.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { TaskPage } from '../src/components/tasks/TaskPage'
import { useStore } from '../src/store'
import { api } from '../src/lib/api'
import { resetTasksCache } from '../src/hooks/useTasks'
import type { SiloRecordDetail, SiloRecordsPage } from '../src/lib/types'

vi.mock('../src/lib/api', async (orig) => {
  const real = await orig<typeof import('../src/lib/api')>()
  return {
    ...real,
    api: {
      silos: { record: vi.fn(), records: vi.fn(), setField: vi.fn(), append: vi.fn(), respond: vi.fn() },
      tasksAct: vi.fn(),
      sessionDetail: vi.fn(),
      taskWakes: vi.fn(() => Promise.reject(new Error('no task mode'))),
      taskMode: vi.fn(() => Promise.reject(new Error('no task mode'))),
      tasksFeed: vi.fn(() => Promise.resolve({ items: [] })),
      workOnTask: vi.fn(),
      conversationRefs: vi.fn(),
    },
  }
})
const mocked = vi.mocked(api, { deep: true })

const PLAN = 'folder:/home/u/proj/ship'
const KEY = `${PLAN}/tasks/t2`
const detail = (state: string, over: Partial<SiloRecordDetail> = {}): SiloRecordDetail => ({
  silo: { id: 'plans', name: 'Plans', state: 'active' },
  kind: { name: 'plans/plan/task', states: [] },
  record: {
    key: KEY,
    id: 't2',
    identity: 'Pick the org',
    state,
    stateLabel: state,
    at: null,
    anchors: { folder: '/home/u/proj' },
    cells: [],
    row: '',
    folded: false,
    overlay: false,
    conflict: false,
    remarks: [],
    file: '/home/u/proj/plans/ship.plan.json',
  },
  version: 'v1',
  fields: [],
  extra: {},
  children: [{ kind: 'plans/plan/task/note', collection: 'notes', rows: [], append: { fields: [{ name: 'text', required: true, max: 8000 }] } }],
  overlay: null,
  needsYou: [],
  actions: [],
  history: [{ at: '2026-11-02T10:00:00Z', event: 'transition', key: KEY, from: 'pending', to: state }],
  events: [],
  value: { id: 't2', owner: 'sam', state, dependsOn: [], conversations: [], notes: [{ at: '2026-11-02T09:00:00Z', by: 'writer', text: 'over to you' }] },
  parent: { key: PLAN, kind: 'plan', identity: 'Ship it', at: '2026-11-01T00:00:00Z' },
  flow: { waiting: false, gate: false, unblocks: [], stalled: false, stalledCause: null, stalledBy: null },
  writtenBy: [{ folder: '-home-u-proj', id: 's1', agentId: 'writer', title: 'Plan it', mtime: 1 }],
  ...over,
})
const empty: SiloRecordsPage = {
  silo: { id: 'plans', name: 'Plans', state: 'active', freshness: null },
  kind: { name: 'plans/plan/task', states: [], columns: [], columnTypes: {}, facets: [], stateEdit: null },
  total: 0,
  matching: 0,
  offset: 0,
  limit: 200,
  said: null,
  unreadable: { count: 0, items: [] },
  records: [],
}

beforeEach(() => {
  vi.clearAllMocks()
  resetTasksCache()
  useStore.setState({
    agents: [{ id: 'writer', name: 'Writer', emoji: '🛠', folder: '/home/u/proj', sessions: [] } as never],
    nowTick: Date.parse('2026-11-03T12:00:00Z'),
  })
  mocked.silos.records.mockResolvedValue(empty)
  mocked.silos.setField.mockResolvedValue({})
  mocked.silos.append.mockResolvedValue({})
  mocked.tasksAct.mockResolvedValue({ key: KEY, record: { tasks: [] }, already: false, holds: [] })
  // the page asks the server for ids the capped list lost; by default the
  // answer never comes — a test that needs one programs it
  mocked.conversationRefs.mockImplementation(() => new Promise(() => {}))
})

describe('TaskPage', () => {
  it('says where it came from and who wrote it, its notes and its state changes', async () => {
    mocked.silos.record.mockResolvedValue(detail('pending'))
    render(<TaskPage planKey={PLAN} taskId="t2" />)
    expect(await screen.findByTestId('task-title')).toHaveTextContent('Pick the org')
    // where it lives is the crumb trail (project › plan); the facts say who wrote it
    expect(screen.getByTestId('task-header').querySelector('nav')).toHaveTextContent('Ship it')
    expect(screen.getByTestId('task-origin')).toHaveTextContent('Writer')
    expect(screen.getByTestId('task-note')).toHaveTextContent('over to you')
    expect(screen.getByTestId('task-state-change')).toHaveTextContent('pending')
  })

  it('the feed: an agent reply card interleaves with the notes, folded to its LAST segment, with its door', async () => {
    mocked.silos.record.mockResolvedValue(detail('pending'))
    mocked.tasksFeed.mockResolvedValue({
      items: [
        {
          at: '2026-11-02T10:30:00Z',
          agent: 'writer',
          via: 'wake',
          texts: ['Reading the plan first.', 'Done: the owner chose dog.'],
          folder: '-home-u-proj',
          sessionId: 's1',
        },
      ],
    })
    render(<TaskPage planKey={PLAN} taskId="t2" />)
    const reply = await screen.findByTestId('task-reply')
    expect(reply).toHaveTextContent('Writer')
    expect(reply).toHaveTextContent('Done: the owner chose dog.')
    expect(reply).not.toHaveTextContent('Reading the plan first.') // folded = the answer, not the narration
    fireEvent.click(screen.getByTestId('task-reply-more'))
    expect(reply).toHaveTextContent('Reading the plan first.')
    expect(screen.getByTestId('reply-conversation-door')).toBeInTheDocument()
    // chronological: the 09:00 note sits above the 10:30 reply
    const items = screen.getAllByTestId(/task-(note|reply)/)
    expect(items[0]).toHaveAttribute('data-testid', 'task-note')
    expect(items[1]).toHaveAttribute('data-testid', 'task-reply')
  })

  it("Done: the owner's verb with the state the page painted — one request", async () => {
    mocked.silos.record.mockResolvedValue(detail('pending'))
    render(<TaskPage planKey={PLAN} taskId="t2" />)
    fireEvent.click((await screen.findAllByRole('button', { name: 'Done' }))[0]!)
    await waitFor(() => expect(mocked.tasksAct).toHaveBeenCalledWith({ key: KEY, verb: 'done', state: 'pending' }))
    expect(mocked.silos.setField).not.toHaveBeenCalled()
  })

  it("Drop: the verb with its reason and the state painted — the note and cancelled are the server's one write", async () => {
    mocked.silos.record.mockResolvedValue(detail('pending'))
    render(<TaskPage planKey={PLAN} taskId="t2" />)
    fireEvent.click((await screen.findAllByRole('button', { name: 'Drop…' }))[0]!)
    fireEvent.change(screen.getAllByLabelText('Why it is dropped')[0]!, { target: { value: 'superseded' } })
    fireEvent.click(screen.getAllByRole('button', { name: 'Drop' })[0]!)
    await waitFor(() => expect(mocked.tasksAct).toHaveBeenCalledWith({ key: KEY, verb: 'drop', state: 'pending', text: 'superseded' }))
    expect(mocked.silos.append).not.toHaveBeenCalled()
    expect(mocked.silos.setField).not.toHaveBeenCalled()
  })

  it('Reopen a finished task: the verb reopen — the server sets the state it is really in', async () => {
    mocked.silos.record.mockResolvedValue(detail('done'))
    render(<TaskPage planKey={PLAN} taskId="t2" />)
    fireEvent.click((await screen.findAllByRole('button', { name: 'Reopen' }))[0]!)
    await waitFor(() => expect(mocked.tasksAct).toHaveBeenCalledWith({ key: KEY, verb: 'reopen' }))
  })

  it("a refused gesture is said beside its control in the server's words — never «someone wrote first»", async () => {
    mocked.silos.record.mockResolvedValue(detail('pending'))
    const { ApiError } = await import('../src/lib/api')
    mocked.tasksAct.mockRejectedValue(new ApiError('it changed — it is in progress now', 409, {}))
    render(<TaskPage planKey={PLAN} taskId="t2" />)
    fireEvent.click((await screen.findAllByRole('button', { name: 'Done' }))[0]!)
    const said = await screen.findAllByTestId('task-action-error')
    expect(said[0]).toHaveTextContent('It changed — it is in progress now.')
    expect(said[0]!.closest('[data-testid="task-actions"]')).not.toBeNull()
  })

  const reviewing = (asked?: string) =>
    detail('in_review', {
      value: {
        id: 't2',
        owner: 'writer',
        state: 'in_review',
        dependsOn: [],
        conversations: [],
        notes: [],
        waitingOn: { owner: 'owner', action: 'review it', ...(asked ? { asked } : {}) },
      },
    })
  it("an agent's review waiting on you: Approve is the verb approve with the question painted; the box is «Send back» — the verb answer (B1c, F5)", async () => {
    mocked.silos.record.mockResolvedValue(reviewing('Good to ship?'))
    render(<TaskPage planKey={PLAN} taskId="t2" />)
    fireEvent.click(await screen.findByTestId('task-approve'))
    await waitFor(() => expect(mocked.tasksAct).toHaveBeenCalledWith({ key: KEY, verb: 'approve', asked: 'Good to ship?' }))
    fireEvent.change(screen.getByTestId('task-note-box'), { target: { value: 'Tighten the intro' } })
    fireEvent.click(screen.getByTestId('task-send-back'))
    await waitFor(() => expect(mocked.tasksAct).toHaveBeenCalledWith({ key: KEY, verb: 'answer', text: 'Tighten the intro', asked: 'Good to ship?' }))
    expect(mocked.silos.append).not.toHaveBeenCalled()
  })
  it('a question that changed since the page painted it: the 409 is said under the box', async () => {
    mocked.silos.record.mockResolvedValue(reviewing())
    const { ApiError } = await import('../src/lib/api')
    mocked.tasksAct.mockRejectedValue(new ApiError('it asks something else now', 409, {}))
    render(<TaskPage planKey={PLAN} taskId="t2" />)
    fireEvent.click(await screen.findByTestId('task-approve'))
    expect(await screen.findByTestId('task-action-error')).toHaveTextContent('It asks something else now.')
  })
  it('a choice of a question on you is one tap: the verb answer with its words and the question painted', async () => {
    mocked.silos.record.mockResolvedValue(
      detail('blocked', {
        value: {
          id: 't2',
          owner: 'writer',
          state: 'blocked',
          dependsOn: [],
          conversations: [],
          notes: [],
          waitingOn: { owner: 'owner', action: 'decide', asked: 'Publish today?', options: ['Yes', 'No'] },
        },
      }),
    )
    render(<TaskPage planKey={PLAN} taskId="t2" />)
    fireEvent.click((await screen.findAllByTestId('task-answer-option'))[0]!)
    await waitFor(() => expect(mocked.tasksAct).toHaveBeenCalledWith({ key: KEY, verb: 'answer', text: 'Yes', asked: 'Publish today?' }))
  })

  it('on a gate of yours the PRIMARY gesture answers: submit (and Enter) is Answer & done; Add note is the quiet secondary', async () => {
    mocked.silos.record.mockResolvedValue(
      detail('pending', {
        value: { id: 't2', owner: 'owner', state: 'pending', dependsOn: [], conversations: [], notes: [] },
        flow: { waiting: false, gate: true, unblocks: [{ id: 't3', owner: 'writer' }], stalled: false, stalledCause: null, stalledBy: null },
      }),
    )
    mocked.silos.respond.mockResolvedValue({ notified: [{ key: `${PLAN}/tasks/t3`, owner: 'writer' }] })
    render(<TaskPage planKey={PLAN} taskId="t2" />)
    const box = await screen.findByTestId('task-note-box')
    expect(box).toHaveAttribute('placeholder', expect.stringContaining('Your answer'))
    fireEvent.change(box, { target: { value: 'dog' } })
    fireEvent.keyDown(box, { key: 'Enter' }) // Enter sends the PRIMARY gesture
    // the painted state, never the file's version
    await waitFor(() => expect(mocked.silos.respond).toHaveBeenCalledWith('plans', { key: KEY, text: 'dog', state: 'pending' }))
    expect(mocked.silos.append).not.toHaveBeenCalled()
    // the quiet secondary still writes a plain note
    fireEvent.change(box, { target: { value: 'just context' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add note' }))
    await waitFor(() =>
      expect(mocked.silos.append).toHaveBeenCalledWith('plans', { key: KEY, collection: 'notes', values: { text: 'just context' }, version: 'v1' }),
    )
  })

  it('a note is append-item on notes — the kernel stamps who and when', async () => {
    mocked.silos.record.mockResolvedValue(detail('pending'))
    render(<TaskPage planKey={PLAN} taskId="t2" />)
    fireEvent.change(await screen.findByTestId('task-note-box'), { target: { value: 'Org is acme' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add note' }))
    await waitFor(() =>
      expect(mocked.silos.append).toHaveBeenCalledWith('plans', { key: KEY, collection: 'notes', values: { text: 'Org is acme' }, version: 'v1' }),
    )
  })

  it('stalled: the banner says the cause and names the first stuck task', async () => {
    mocked.silos.record.mockResolvedValue(
      detail('blocked', { flow: { waiting: false, gate: false, unblocks: [], stalled: true, stalledCause: 'blocker-cancelled', stalledBy: 't4' } }),
    )
    render(<TaskPage planKey={PLAN} taskId="t2" />)
    const banner = await screen.findByTestId('task-banner')
    expect(banner).toHaveTextContent('ship#t4')
  })

  // the plan's other tasks, as the records route reads them
  const sib = (id: string, state: string, value: Record<string, unknown> = {}) => ({
    key: `${PLAN}/tasks/${id}`,
    id,
    identity: `Task ${id}`,
    state,
    stateLabel: state,
    at: null,
    anchors: { folder: '/home/u/proj' },
    cells: [],
    row: '',
    folded: false,
    overlay: false,
    conflict: false,
    remarks: [],
    file: '/home/u/proj/plans/ship.plan.json',
    parent: { key: PLAN, identity: 'Ship it', at: '2026-11-01T00:00:00Z' },
    value: { id, owner: 'writer', state, dependsOn: [], ...value },
  })
  const withSiblings = (...rows: ReturnType<typeof sib>[]): void => {
    mocked.silos.records.mockResolvedValue({ ...empty, total: rows.length, matching: rows.length, records: rows as never })
  }

  it('a dropped dependency: the banner says it never resolves and offers both ways out — Remove the dependency, Reopen it', async () => {
    withSiblings(sib('t4', 'cancelled'), sib('t2', 'blocked', { owner: 'sam', dependsOn: ['t4'] }))
    mocked.silos.record.mockResolvedValue(
      detail('blocked', { value: { id: 't2', owner: 'sam', state: 'blocked', dependsOn: ['t4'], conversations: [], notes: [] } }),
    )
    render(<TaskPage planKey={PLAN} taskId="t2" />)
    const banner = await screen.findByText(/which was dropped — that never resolves/)
    expect(banner.closest('[data-testid="task-banner"]')).toHaveAttribute('data-kind', 'dropped-blocker')
    fireEvent.click(screen.getAllByTestId('task-remove-dependency')[0]!)
    // one write: dependsOn without it (and pending when nothing else holds it — the server's rule)
    await waitFor(() => expect(mocked.tasksAct).toHaveBeenCalledWith({ key: KEY, verb: 'remove-dependency', dep: 't4' }))
    fireEvent.click(screen.getAllByTestId('task-reopen-dependency')[0]!)
    await waitFor(() => expect(mocked.tasksAct).toHaveBeenCalledWith({ key: `${PLAN}/tasks/t4`, verb: 'reopen' }))
    expect(screen.getAllByTestId('task-reopen-dependency')[0]).toHaveTextContent('Reopen ship#t4')
  })

  it('Drop says what it leaves hanging before anything is written (A5)', async () => {
    withSiblings(sib('t2', 'pending', { owner: 'sam' }), sib('t3', 'pending', { dependsOn: ['t2'] }))
    mocked.silos.record.mockResolvedValue(detail('pending'))
    render(<TaskPage planKey={PLAN} taskId="t2" />)
    await waitFor(() => expect(screen.getAllByText('Task t3').length).toBeGreaterThan(0))
    fireEvent.click(screen.getAllByRole('button', { name: 'Drop…' })[0]!)
    expect(screen.getAllByTestId('task-drop-confirm-hangs')[0]).toHaveTextContent('Writer')
    expect(mocked.silos.append).not.toHaveBeenCalled()
  })

  it("a dropped task reads «dropped» from its state; a person's task keeps a note for the record", async () => {
    mocked.silos.record.mockResolvedValue(detail('cancelled', { record: { ...detail('cancelled').record, stateLabel: 'dropped' } }))
    render(<TaskPage planKey={PLAN} taskId="t2" />)
    expect((await screen.findAllByTestId('task-props'))[0]).toHaveTextContent('dropped')
    expect(screen.getByTestId('task-note-box')).toHaveAttribute('placeholder', expect.stringContaining('note'))
  })

  it('a task no plan holds says so — never a blank page', async () => {
    const { ApiError } = await import('../src/lib/api')
    mocked.silos.record.mockRejectedValue(new ApiError('no record', 404, null))
    render(<TaskPage planKey={PLAN} taskId="t9" />)
    expect(await screen.findByTestId('task-missing')).toHaveTextContent('ship#t9')
  })
})

describe('a conversation the capped overview did not carry (A: «gone» only when the server says so)', () => {
  const CID = 'f0e1d2c3b4a59687'
  const convDetail = () =>
    detail('in_progress', { value: { id: 't2', owner: 'writer', state: 'in_progress', dependsOn: [], conversations: [CID], notes: [] } as never })

  it('the server knows it: the row is a door that opens it', async () => {
    mocked.silos.record.mockResolvedValue(convDetail())
    mocked.conversationRefs.mockResolvedValue({ [CID]: { sessionId: CID, folder: '-home-u-proj', agentId: 'writer', title: 'Old thread', live: false } })
    const openSession = vi.fn(async () => {})
    useStore.setState({ openSession: openSession as never })
    render(<TaskPage planKey={PLAN} taskId="t2" />)
    const row = await screen.findByTestId('task-conversation')
    await waitFor(() => expect(row.querySelector('button')).not.toBeNull())
    expect(row.getAttribute('data-state')).not.toBe('gone')
    fireEvent.click(row.querySelector('button')!)
    expect(openSession).toHaveBeenCalledWith('-home-u-proj', CID)
  })

  it('the server answered without it: gone, no door', async () => {
    mocked.silos.record.mockResolvedValue(convDetail())
    mocked.conversationRefs.mockResolvedValue({})
    render(<TaskPage planKey={PLAN} taskId="t2" />)
    const row = await screen.findByTestId('task-conversation')
    await waitFor(() => expect(row.getAttribute('data-state')).toBe('gone'))
    expect(row.querySelector('button')).toBeNull()
  })

  it('no answer yet: the row claims nothing either way', async () => {
    mocked.silos.record.mockResolvedValue(convDetail())
    render(<TaskPage planKey={PLAN} taskId="t2" />)
    const row = await screen.findByTestId('task-conversation')
    expect(row.getAttribute('data-state')).toBe('unresolved')
    expect(row.querySelector('button')).toBeNull()
  })
})
