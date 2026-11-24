// task-page-give.test.tsx — Rule 1 on the task page: the composer by
// control and by state (own: «Write to X» · Send;
// told: Send primary + «Send and open ›»; held: the note waits, «Open ›»;
// closed: «reopens it» — a told one's note reopens it from the page), the
// task nobody is on («Start X ›» without you / «Open console|chat ›» you go
// in), and the live line with Stop on the task's own turn.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { TaskPage } from '../src/components/tasks/TaskPage'
import { useStore } from '../src/store'
import { api } from '../src/lib/api'
import { resetTasksCache } from '../src/hooks/useTasks'
import type { SiloRecordDetail, SiloRecordsPage, TaskModeView } from '../src/lib/types'

vi.mock('../src/lib/api', async (orig) => {
  const real = await orig<typeof import('../src/lib/api')>()
  return {
    ...real,
    api: {
      silos: { record: vi.fn(), records: vi.fn(), setField: vi.fn(), append: vi.fn(), respond: vi.fn() },
      sessionDetail: vi.fn(() => Promise.resolve({})),
      taskWakes: vi.fn(),
      taskMode: vi.fn(() => Promise.resolve({ silo: 'task-mode', installed: true, active: true, bound: [] })),
      tasksFeed: vi.fn(() => Promise.resolve({ items: [] })),
      workOnTask: vi.fn(),
      tasksTalk: vi.fn(),
      tasksAssign: vi.fn(),
      tasksAct: vi.fn(() => Promise.resolve({ key: 'k', record: { tasks: [] }, already: false, holds: [] })),
      agents: { stop: vi.fn(() => Promise.resolve({ stopped: [], paused: [] })) },
      initiative: { origin: vi.fn(() => Promise.resolve({ outside: false })), keep: vi.fn() },
    },
  }
})
const mocked = vi.mocked(api, { deep: true })

const PLAN = 'folder:/home/u/proj/ship'
const KEY = `${PLAN}/tasks/t2`
const detail = (state: string): SiloRecordDetail =>
  ({
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
    history: [],
    events: [],
    value: { id: 't2', owner: 'writer', state, dependsOn: [], conversations: [], notes: [] },
    parent: { key: PLAN, kind: 'plan', identity: 'Ship it', at: '2026-11-01T00:00:00Z' },
    flow: { waiting: false, gate: false, unblocks: [], stalled: false, stalledCause: null, stalledBy: null, idle: state === 'pending' },
    writtenBy: [],
  }) as unknown as SiloRecordDetail
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
const view = (over: Partial<TaskModeView> = {}): TaskModeView => ({
  bound: true,
  owner: 'writer',
  wakes: 'task',
  history: [],
  heldNow: null,
  door: { thread: null, running: null, consoleBriefs: true, hasConsole: false },
  live: null,
  ...over,
})

const agent = (control: 'own' | 'told', open = { hasConsole: false, consoleBriefs: true }) =>
  useStore.setState({
    agents: [{ id: 'writer', name: 'Writer', emoji: '🛠', folder: '/home/u/proj', sessions: [], controlNow: control, open } as never],
    nowTick: Date.parse('2026-11-03T12:00:00Z'),
  })

beforeEach(() => {
  vi.clearAllMocks()
  resetTasksCache()
  mocked.silos.records.mockResolvedValue(empty)
  mocked.silos.setField.mockResolvedValue({})
  mocked.silos.append.mockResolvedValue({})
})

const box = async (): Promise<HTMLElement> => screen.findByTestId('task-note-box')

describe('the composer by control', () => {
  it('On its own: «Write to X» · Send — no «Send and open ›»', async () => {
    agent('own')
    mocked.silos.record.mockResolvedValue(detail('in_progress'))
    mocked.taskWakes.mockResolvedValue(view())
    render(<TaskPage planKey={PLAN} taskId="t2" />)
    await waitFor(async () => expect(await box()).toHaveAttribute('placeholder', 'Write to Writer'))
    expect(screen.getByRole('button', { name: 'Send' })).toBeInTheDocument()
    expect(screen.queryByTestId('task-send-open')).toBeNull()
  })

  it('Only when told: Send is primary, «Send and open ›» writes the note then goes in — chat when it has no console', async () => {
    agent('told')
    mocked.silos.record.mockResolvedValue(detail('in_progress'))
    mocked.taskWakes.mockResolvedValue(view({ wakes: 'never', bound: false }))
    mocked.tasksTalk.mockResolvedValue({ folder: '-home-u-proj', sessionId: 's9', isNew: false, folded: 0 })
    const openSession = vi.fn(async () => {})
    useStore.setState({ openSession: openSession as never })
    render(<TaskPage planKey={PLAN} taskId="t2" />)
    await waitFor(async () => expect(await box()).toHaveAttribute('placeholder', 'Write to Writer'))
    fireEvent.change(await box(), { target: { value: 'use the new rate' } })
    fireEvent.click(await screen.findByTestId('task-send-open'))
    expect(screen.getByTestId('task-send-open')).toHaveTextContent('Send and open ›')
    await waitFor(() =>
      expect(mocked.silos.append).toHaveBeenCalledWith(
        'plans',
        expect.objectContaining({ key: KEY, collection: 'notes', values: { text: 'use the new rate' } }),
      ),
    )
    await waitFor(() => expect(mocked.tasksTalk).toHaveBeenCalledWith(KEY))
    expect(mocked.workOnTask).not.toHaveBeenCalled()
    await waitFor(() => expect(openSession).toHaveBeenCalledWith('-home-u-proj', 's9'))
  })

  it('held: the note waits, said in the box, with the conversation one click away', async () => {
    agent('own')
    mocked.silos.record.mockResolvedValue(detail('in_progress'))
    mocked.taskWakes.mockResolvedValue(
      view({
        heldNow: 'a console has its conversation open',
        door: { thread: { sessionId: 's1', folder: '-f' }, running: null, consoleBriefs: true, hasConsole: true },
      }),
    )
    render(<TaskPage planKey={PLAN} taskId="t2" />)
    await waitFor(async () => expect(await box()).toHaveAttribute('placeholder', expect.stringContaining('a console has its conversation open')))
    expect(screen.getByTestId('task-held-open')).toBeInTheDocument()
  })

  // the note reopens in its OWN write, on the server —
  // the page sends the note and nothing after it (the two-step is gone)
  it('closed, Only when told: «reopens it» — the note alone; the server reopens it in the same write', async () => {
    agent('told')
    mocked.silos.record.mockResolvedValue(detail('done'))
    mocked.taskWakes.mockResolvedValue(view({ wakes: 'never', bound: false }))
    render(<TaskPage planKey={PLAN} taskId="t2" />)
    await waitFor(async () => expect(await box()).toHaveAttribute('placeholder', 'Write to Writer — reopens it'))
    fireEvent.change(await box(), { target: { value: 'one more thing' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() =>
      expect(mocked.silos.append).toHaveBeenCalledWith('plans', expect.objectContaining({ key: KEY, collection: 'notes', values: { text: 'one more thing' } })),
    )
    await new Promise((r) => setTimeout(r, 30))
    expect(mocked.tasksAct).not.toHaveBeenCalled()
  })
})

describe('a task nobody is on: Start = without you, Open = you go in', () => {
  it("On its own: «Start X ›» is the owner's gesture (assign)", async () => {
    agent('own')
    mocked.silos.record.mockResolvedValue(detail('pending'))
    mocked.taskWakes.mockResolvedValue(view())
    mocked.tasksAssign.mockResolvedValue({ queued: true })
    render(<TaskPage planKey={PLAN} taskId="t2" />)
    fireEvent.click(await screen.findByTestId('task-start-it'))
    expect(screen.getByTestId('task-start-it')).toHaveTextContent(/Start(ing)? Writer/)
    await waitFor(() => expect(mocked.tasksAssign).toHaveBeenCalledWith(KEY))
    expect(screen.queryByText(/Wake .* on it/)).toBeNull()
  })

  it('Only when told: the button names the surface — a console only when it has one', async () => {
    agent('told')
    mocked.silos.record.mockResolvedValue(detail('pending'))
    mocked.taskWakes.mockResolvedValue(view({ wakes: 'never', bound: false, door: { thread: null, running: null, consoleBriefs: true, hasConsole: true } }))
    render(<TaskPage planKey={PLAN} taskId="t2" />)
    expect(await screen.findByTestId('task-open-it')).toHaveTextContent('Open console ›')
    expect(screen.getAllByTestId('task-door-primary')[0]).toHaveTextContent('Open console ›')
    expect(mocked.tasksAssign).not.toHaveBeenCalled()
  })
})

describe('the live line on the page', () => {
  it('its own turn running: «X is on it» with Stop — Stop names that turn', async () => {
    agent('own')
    mocked.silos.record.mockResolvedValue(detail('in_progress'))
    mocked.taskWakes.mockResolvedValue(view({ live: { kind: 'running', turns: [{ turnId: 'turn-7', sessionId: 's7', started: true }] } }))
    render(<TaskPage planKey={PLAN} taskId="t2" />)
    expect(await screen.findByTestId('task-live')).toHaveTextContent('Writer is on it')
    fireEvent.click(screen.getByTestId('task-live-stop'))
    await waitFor(() => expect(mocked.agents.stop).toHaveBeenCalledWith('writer', { turns: ['turn-7'] }))
  })

  it('queued behind the fleet: said, no Stop', async () => {
    agent('own')
    mocked.silos.record.mockResolvedValue(detail('pending'))
    mocked.taskWakes.mockResolvedValue(view({ live: { kind: 'queued', cap: 'global', running: 6 } }))
    render(<TaskPage planKey={PLAN} taskId="t2" />)
    expect(await screen.findByTestId('task-live')).toHaveTextContent('The fleet is running 6 things — Writer starts when one ends')
    expect(screen.queryByTestId('task-live-stop')).toBeNull()
  })
})

// «Give to… ›» lives on the task page, beside
// Drop: the server's destinations, none picked for you; ONE act hand with
// what the page painted; the page then says what happened
describe('«Give to… ›» — the task page gives it to another', () => {
  const handTo = [
    { id: 'owner', name: 'You', wakes: null },
    { id: 'builder', name: 'Builder', wakes: 'task' as const },
    { id: 'teller', name: 'Teller', wakes: 'never' as const },
  ]
  it('no destination picked by default; giving sends to, the painted owner and state, and whether it showed «outside» — then says it started', async () => {
    agent('own')
    mocked.silos.record.mockResolvedValue(detail('pending'))
    mocked.taskWakes.mockResolvedValue(view({ handTo }))
    mocked.tasksAct.mockResolvedValueOnce({ key: KEY, record: { tasks: [] }, already: false, holds: [], assign: { queued: true, wakes: 'task' } } as never)
    render(<TaskPage planKey={PLAN} taskId="t2" />)
    fireEvent.click((await screen.findAllByTestId('task-give-to-open'))[0]!)
    expect((screen.getAllByTestId('task-give-to')[0]! as HTMLSelectElement).value).toBe('')
    expect(screen.getAllByTestId('task-give-to-confirm')[0]!).toBeDisabled()
    fireEvent.change(screen.getAllByTestId('task-give-to')[0]!, { target: { value: 'builder' } })
    expect(screen.getAllByTestId('task-give-to-moves')[0]!).toHaveTextContent('Builder starts on its own.')
    fireEvent.click(screen.getAllByTestId('task-give-to-confirm')[0]!)
    await waitFor(() =>
      expect(mocked.tasksAct).toHaveBeenCalledWith({ key: KEY, verb: 'hand', to: 'builder', owner: 'writer', state: 'pending', outside: false }),
    )
    expect((await screen.findAllByTestId('task-handed'))[0]!).toHaveTextContent('Given to Builder — starting now.')
  })
  it('an origin the page showed as outside Silos: said in the picker, and sent as outside: true', async () => {
    agent('own')
    mocked.initiative.origin.mockResolvedValueOnce({ outside: true } as never)
    mocked.silos.record.mockResolvedValue(detail('pending'))
    mocked.taskWakes.mockResolvedValue(view({ handTo }))
    render(<TaskPage planKey={PLAN} taskId="t2" />)
    await screen.findByTestId('task-origin-outside')
    fireEvent.click((await screen.findAllByTestId('task-give-to-open'))[0]!)
    expect(screen.getAllByTestId('task-give-to-outside')[0]!).toHaveTextContent('giving it counts as keeping it')
    fireEvent.change(screen.getAllByTestId('task-give-to')[0]!, { target: { value: 'teller' } })
    fireEvent.click(screen.getAllByTestId('task-give-to-confirm')[0]!)
    await waitFor(() => expect(mocked.tasksAct).toHaveBeenCalledWith(expect.objectContaining({ verb: 'hand', to: 'teller', outside: true })))
  })
  it("refused: the server's words beside the picker, which stays open", async () => {
    agent('own')
    mocked.silos.record.mockResolvedValue(detail('in_progress'))
    mocked.taskWakes.mockResolvedValue(view({ handTo }))
    mocked.tasksAct.mockRejectedValueOnce(new Error("Writer's conversation «draft» (2 min ago) is on it now — stop or unlink that conversation first"))
    render(<TaskPage planKey={PLAN} taskId="t2" />)
    fireEvent.click((await screen.findAllByTestId('task-give-to-open'))[0]!)
    fireEvent.change(screen.getAllByTestId('task-give-to')[0]!, { target: { value: 'owner' } })
    fireEvent.click(screen.getAllByTestId('task-give-to-confirm')[0]!)
    expect((await screen.findAllByTestId('task-action-error'))[0]!).toHaveTextContent('stop or unlink that conversation first')
    expect(screen.getAllByTestId('task-give-to-form')[0]!).toBeInTheDocument()
  })
})
