// give-dialog.test.tsx — New task → «Give»:
// the button says what will happen by the agent's control and names the
// surface; the line under «For» says it; «Save for later» is the task
// without the gesture; «Give to X» assigns and the dialog stays as the
// task's row with its live line — «Starting X…», never «on it» at the click;
// «Give and open …» goes in on the surface it names. Creating is ONE request
// (POST /api/tasks/new): the server makes the list and
// the id, writes the details and the conversation with the task, and gives
// it. The retired labels («Create and start», «Create») are gone.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { GiveDialog } from '../src/components/tasks/GiveDialog'
import { useStore } from '../src/store'
import { api } from '../src/lib/api'
import { giveFor } from '../src/lib/new-task'
import type { AgentView } from '../src/lib/types'

vi.mock('../src/lib/api', async (orig) => {
  const real = await orig<typeof import('../src/lib/api')>()
  return {
    ...real,
    api: {
      silos: { ensure: vi.fn(), append: vi.fn(), records: vi.fn() },
      sessionDetail: vi.fn(() => Promise.resolve({})),
      taskWakes: vi.fn(),
      taskMode: vi.fn(() => Promise.resolve({ silo: 'task-mode', installed: true, active: true, bound: [] })),
      tasksNew: vi.fn(),
      tasksAssign: vi.fn(),
      tasksTalk: vi.fn(),
      workOnTask: vi.fn(),
      agents: { stop: vi.fn() },
    },
  }
})
const mocked = vi.mocked(api, { deep: true })

const STANDING = 'folder:/home/u/proj/tasks'
const writer = (control: 'own' | 'told', hasConsole = false): AgentView =>
  ({
    id: 'writer',
    name: 'Writer',
    emoji: '',
    folder: '/home/u/proj',
    sessions: [],
    liveCount: 0,
    sessionCount: 0,
    skills: [],
    controlNow: control,
    open: { hasConsole, consoleBriefs: true },
  }) as unknown as AgentView

beforeEach(() => {
  vi.clearAllMocks()
  try {
    localStorage.clear()
  } catch {
    /* none */
  }
  mocked.tasksNew.mockResolvedValue({ key: `${STANDING}/tasks/t1`, id: 't1', ref: 'proj#t1', title: 'x' })
  useStore.setState({ openSession: vi.fn(async () => {}) as never })
})

const fill = (text: string): void => {
  fireEvent.change(screen.getByLabelText('What to do'), { target: { value: text } })
}

describe('GiveDialog — the button says what will happen', () => {
  it('On its own: «Give to X» — «Starts now, on its own»; «Save for later» beside it', () => {
    render(<GiveDialog all={[]} agents={[writer('own')]} initialOwner="writer" onClose={() => {}} onCreated={() => {}} />)
    expect(screen.getByTestId('give-primary')).toHaveTextContent('Writer')
    expect(screen.getByTestId('give-line')).toBeInTheDocument()
    expect(screen.getByTestId('give-later')).toBeInTheDocument()
  })

  it('Only when told: the surface on the button — chat with no console yet, console once it has one', () => {
    const { unmount } = render(<GiveDialog all={[]} agents={[writer('told')]} initialOwner="writer" onClose={() => {}} onCreated={() => {}} />)
    expect(screen.getByTestId('give-primary')).toHaveTextContent('chat')
    expect(screen.getByTestId('give-line')).toBeInTheDocument()
    unmount()
    render(<GiveDialog all={[]} agents={[writer('told', true)]} initialOwner="writer" onClose={() => {}} onCreated={() => {}} />)
    expect(screen.getByTestId('give-primary')).toHaveTextContent('console')
  })

  it('yours: «Add to my list», nothing beside it', () => {
    render(<GiveDialog all={[]} agents={[writer('own')]} initialOwner="owner" onClose={() => {}} onCreated={() => {}} />)
    expect(screen.getByTestId('give-primary')).toHaveTextContent('Add to my list')
    expect(screen.queryByTestId('give-later')).toBeNull()
    expect(screen.queryByTestId('give-line')).toBeNull()
  })
})

describe('GiveDialog — the gesture, in ONE request', () => {
  it('«Give to X»: one `new` with give — and the dialog stays as its row, «Starting X…»', async () => {
    mocked.tasksNew.mockResolvedValue({
      key: `${STANDING}/tasks/t1`,
      id: 't1',
      ref: 'proj#t1',
      title: 'Draft the release notes',
      assign: { queued: true, wakes: 'task' },
    })
    mocked.taskWakes.mockResolvedValue({
      bound: true,
      owner: 'writer',
      wakes: 'task',
      history: [],
      live: { kind: 'running', turns: [{ turnId: 'k1', sessionId: null, started: false }] },
    })
    const onCreated = vi.fn()
    render(<GiveDialog all={[]} agents={[writer('own')]} initialOwner="writer" onClose={() => {}} onCreated={onCreated} />)
    fill('Draft the release notes')
    fireEvent.click(screen.getByTestId('give-details'))
    fireEvent.change(screen.getByLabelText('Details'), { target: { value: 'Keep it to one page.' } })
    fireEvent.click(screen.getByTestId('give-primary'))
    await waitFor(() =>
      expect(mocked.tasksNew).toHaveBeenCalledWith({
        folder: '/home/u/proj',
        plan: 'tasks',
        title: 'Draft the release notes',
        owner: 'writer',
        details: 'Keep it to one page.',
        give: true,
      }),
    )
    // nothing else is written by the page
    expect(mocked.silos.ensure).not.toHaveBeenCalled()
    expect(mocked.silos.append).not.toHaveBeenCalled()
    expect(mocked.tasksAssign).not.toHaveBeenCalled()
    expect(await screen.findByTestId('give-given')).toHaveTextContent('Draft the release notes')
    expect(screen.getByTestId('give-live')).toHaveTextContent('Starting Writer…')
    expect(onCreated).not.toHaveBeenCalled()
  })

  it('«Give and open chat ›»: the task (no give), then its chat opens on it', async () => {
    mocked.tasksTalk.mockResolvedValue({ folder: '-home-u-proj', sessionId: 's1', isNew: false, folded: 0 })
    const onCreated = vi.fn()
    render(<GiveDialog all={[]} agents={[writer('told')]} initialOwner="writer" onClose={() => {}} onCreated={onCreated} />)
    fill('Check the invoices')
    fireEvent.click(screen.getByTestId('give-primary'))
    await waitFor(() => expect(mocked.tasksTalk).toHaveBeenCalledWith(`${STANDING}/tasks/t1`))
    expect(mocked.tasksNew).toHaveBeenCalledWith({ folder: '/home/u/proj', plan: 'tasks', title: 'Check the invoices', owner: 'writer' })
    expect(mocked.workOnTask).not.toHaveBeenCalled()
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(expect.objectContaining({ id: 't1', started: true })))
  })

  it('«Save for later»: the task alone — no give', async () => {
    const onCreated = vi.fn()
    render(<GiveDialog all={[]} agents={[writer('own')]} initialOwner="writer" onClose={() => {}} onCreated={onCreated} />)
    fill('Someday')
    fireEvent.click(screen.getByTestId('give-later'))
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(expect.objectContaining({ id: 't1' })))
    expect(mocked.tasksNew).toHaveBeenCalledWith({ folder: '/home/u/proj', plan: 'tasks', title: 'Someday', owner: 'writer' })
    expect(mocked.tasksTalk).not.toHaveBeenCalled()
  })

  it('«Make this a task»: the conversation rides the same request (session) — never a second link call', async () => {
    const onCreated = vi.fn()
    render(
      <GiveDialog
        all={[]}
        agents={[writer('own')]}
        initialOwner="writer"
        conversation={{ id: 'sess-0001aaaa', folder: '-home-u-proj' }}
        onClose={() => {}}
        onCreated={onCreated}
      />,
    )
    fill('From this chat')
    fireEvent.click(screen.getByTestId('give-later'))
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(expect.objectContaining({ id: 't1', linked: true })))
    expect(mocked.tasksNew).toHaveBeenCalledWith({ folder: '/home/u/proj', plan: 'tasks', title: 'From this chat', owner: 'writer', session: 'sess-0001aaaa' })
  })

  it("refused: nothing was created — the dialog stays with the server's words beside it", async () => {
    mocked.tasksNew.mockRejectedValueOnce(new Error("Writer can't open proj — its fence does not hold it"))
    const onCreated = vi.fn()
    render(<GiveDialog all={[]} agents={[writer('own')]} initialOwner="writer" onClose={() => {}} onCreated={onCreated} />)
    fill('Draft the release notes')
    fireEvent.click(screen.getByTestId('give-later'))
    expect(await screen.findByRole('alert')).toHaveTextContent('its fence does not hold it')
    expect(onCreated).not.toHaveBeenCalled()
  })

  it('«Give to X» refused by the server with nothing live: the row says why — never an endless «Starting X…»', async () => {
    mocked.tasksNew.mockResolvedValue({
      key: `${STANDING}/tasks/t1`,
      id: 't1',
      ref: 'proj#t1',
      title: 'x',
      assign: { queued: false, why: 'Writer is Only when told — open it on the task' },
    })
    mocked.taskWakes.mockResolvedValue({ bound: false, owner: 'writer', wakes: 'never', history: [], live: null })
    render(<GiveDialog all={[]} agents={[writer('own')]} initialOwner="writer" onClose={() => {}} onCreated={() => {}} />)
    fill('Draft the release notes')
    fireEvent.click(screen.getByTestId('give-primary'))
    expect(await screen.findByTestId('give-ended')).toHaveTextContent('It did not start: Writer is Only when told')
  })
})

describe('giveFor — «For: X ▾»: the one named, the last used, the only one', () => {
  const a = (id: string, over: object = {}) => ({ id, folder: `/f/${id}`, archived: false, ...over })
  it('a door that names someone wins; else the last used (still in play); else the default agent or the first; with none, you', () => {
    expect(giveFor({ named: 'owner', last: 'b', agents: [a('a'), a('b')] })).toBe('owner')
    expect(giveFor({ named: null, last: 'b', agents: [a('a'), a('b')] })).toBe('b')
    expect(giveFor({ named: null, last: 'gone', agents: [a('a'), a('b', { default: true })] })).toBe('b')
    expect(giveFor({ named: null, last: null, agents: [a('only')] })).toBe('only')
    expect(giveFor({ named: null, last: null, agents: [] })).toBe('owner')
  })
})
