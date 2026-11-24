import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { SessionsMaintenance } from '../src/components/settings/SessionsMaintenance'
import { useStore } from '../src/store'
import { api } from '../src/lib/api'
import type { AgentView, SessionView } from '../src/lib/types'

vi.mock('../src/lib/api')
const mockedApi = vi.mocked(api, { deep: true })

const DAY = 24 * 3600 * 1000
const NOW = 1_700_000_000_000

function makeSession(overrides: Partial<SessionView> = {}): SessionView {
  return {
    id: 's1',
    folder: '-alpha',
    title: 'Untitled',
    skills: [],
    cwd: '/home/u/alpha',
    mtime: NOW - DAY,
    size: 10_000,
    turnCount: 3,
    live: false,
    worktree: false,
    native: true,
    agentId: 'a1',
    ...overrides,
  } as SessionView
}
function makeAgent(overrides: Partial<AgentView> = {}): AgentView {
  return {
    id: 'a1',
    name: 'Ana',
    emoji: '🧠',
    role: 'writer',
    folder: '/home/u/alpha',
    skills: [],
    sessions: [],
    liveCount: 0,
    sessionCount: 0,
    ...overrides,
  } as AgentView
}

describe('SessionsMaintenance', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockedApi.trash.mockResolvedValue(undefined)
    useStore.setState({
      nowTick: NOW,
      agents: [
        makeAgent({
          sessions: [makeSession({ id: 'one', title: 'Deploy notes' }), makeSession({ id: 'two', title: 'Scratch', size: 500, mtime: NOW - 40 * DAY })],
        }),
        makeAgent({
          id: 'a2',
          name: 'Bo',
          folder: '/home/u/beta',
          sessions: [makeSession({ id: 'b', folder: '-beta', cwd: '/home/u/beta', title: 'Beta work', native: false })],
        }),
      ],
    })
  })

  it('lists sessions grouped by project with totals, and marks terminal ones', () => {
    render(<SessionsMaintenance />)
    expect(screen.getByText('alpha')).toBeInTheDocument()
    expect(screen.getByText('beta')).toBeInTheDocument()
    expect(screen.getByText('Deploy notes')).toBeInTheDocument()
    expect(screen.getByText('terminal')).toBeInTheDocument()
    // header total: 3 conversations
    expect(screen.getByText('3')).toBeInTheDocument()
  })

  it('selecting rows shows the action bar with count + bytes; confirm twice trashes them', async () => {
    render(<SessionsMaintenance />)
    expect(screen.queryByText(/Trash \d/)).toBeNull()
    fireEvent.click(screen.getByLabelText('select Deploy notes'))
    fireEvent.click(screen.getByLabelText('select Scratch'))
    expect(screen.getByText('Trash 2')).toBeInTheDocument()
    expect(screen.getByText('10.3 KB')).toBeInTheDocument()

    fireEvent.click(screen.getByText('Trash 2'))
    expect(screen.getByText('Sure? Trash 2')).toBeInTheDocument()
    expect(mockedApi.trash).not.toHaveBeenCalled()
    fireEvent.click(screen.getByText('Sure? Trash 2'))
    await waitFor(() => expect(mockedApi.trash).toHaveBeenCalledTimes(2))
    expect(mockedApi.trash).toHaveBeenCalledWith('-alpha', 'one')
    expect(mockedApi.trash).toHaveBeenCalledWith('-alpha', 'two')
    await waitFor(() => expect(screen.queryByText(/Trash \d/)).toBeNull())
  })

  // A claude outside Silos (an auto-retry tmux from the night before)
  // still holds a row: the server's 409 names where it lives and hands the
  // holders back, and the strip offers to close it — a second trash of
  // exactly the held rows with `closeHolders`. Nothing is killed on its own.
  it('a row held by a claude outside Silos offers "Close it and trash", which retries only that row with closeHolders', async () => {
    const message = 'a claude started outside Silos still holds this conversation — tmux "claude-retry-1" (pid 7), idle for 12 h — close it before trashing'
    const refusal = Object.assign(new Error(message), {
      status: 409,
      body: { error: message, holders: [{ pid: 7, tmux: 'claude-retry-1', name: null }], canClose: true },
    })
    mockedApi.trash.mockImplementation((_f: string, id: string, opts?: { closeHolders?: boolean }) =>
      id === 'one' && !opts?.closeHolders ? Promise.reject(refusal) : Promise.resolve(undefined),
    )
    render(<SessionsMaintenance />)
    fireEvent.click(screen.getByLabelText('select Deploy notes')) // id 'one' — held
    fireEvent.click(screen.getByLabelText('select Scratch')) // id 'two' — trashed
    fireEvent.click(screen.getByText('Trash 2'))
    fireEvent.click(screen.getByText('Sure? Trash 2'))
    await waitFor(() => expect(mockedApi.trash).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(useStore.getState().error).toContain('tmux "claude-retry-1"'))
    const action = useStore.getState().errorAction
    expect(action?.label).toBe('Close it and trash')
    expect(action?.forMessage).toBe(useStore.getState().error)
    action!.run()
    await waitFor(() => expect(mockedApi.trash).toHaveBeenCalledTimes(3))
    expect(mockedApi.trash).toHaveBeenLastCalledWith('-alpha', 'one', { closeHolders: true })
    // the second attempt went through: nothing left selected, no action pending
    await waitFor(() => expect(screen.queryByText(/Trash \d/)).toBeNull())
  })

  // "it doesn't always work": with N selected, each failure
  // overwrote the same global error and the selection was cleared anyway —
  // the survivors just sat in the list with nothing marking them. A partial
  // failure must KEEP the failed rows selected and say how many failed.
  it('a partial failure keeps the failed rows selected and names the count', async () => {
    mockedApi.trash.mockImplementation((_f: string, id: string) =>
      id === 'one' ? Promise.reject(new Error('a turn is in progress')) : Promise.resolve(undefined),
    )
    render(<SessionsMaintenance />)
    fireEvent.click(screen.getByLabelText('select Deploy notes')) // id 'one' — will fail
    fireEvent.click(screen.getByLabelText('select Scratch')) // id 'two' — succeeds
    fireEvent.click(screen.getByText('Trash 2'))
    fireEvent.click(screen.getByText('Sure? Trash 2'))
    await waitFor(() => expect(mockedApi.trash).toHaveBeenCalledTimes(2))
    // the failed row stays selected — the action bar still offers it
    await waitFor(() => expect(screen.getByText('Trash 1')).toBeInTheDocument())
    expect((screen.getByLabelText('select Deploy notes') as HTMLInputElement).checked).toBe(true)
    // and the error names the real scale, not just the last message
    expect(useStore.getState().error).toMatch(/1 of 2/)
    expect(useStore.getState().error).toMatch(/a turn is in progress/)
  })

  it('the group checkbox selects every session of that project', () => {
    render(<SessionsMaintenance />)
    fireEvent.click(screen.getByLabelText('select all in alpha'))
    expect(screen.getByText('Trash 2')).toBeInTheDocument()
    fireEvent.click(screen.getByLabelText('select all in alpha'))
    expect(screen.queryByText(/Trash \d/)).toBeNull()
  })

  it('quick filters narrow the ledger and drop hidden rows from the selection', () => {
    render(<SessionsMaintenance />)
    fireEvent.click(screen.getByLabelText('select Deploy notes'))
    fireEvent.click(screen.getByRole('radio', { name: 'Older than 30d' }))
    expect(screen.queryByText('Deploy notes')).toBeNull()
    expect(screen.getByText('Scratch')).toBeInTheDocument()
    expect(screen.queryByText(/Trash \d/)).toBeNull()
    fireEvent.click(screen.getByRole('radio', { name: 'Empty' }))
    expect(screen.getByText('Scratch')).toBeInTheDocument()
    expect(screen.queryByText('Beta work')).toBeNull()
  })

  it('clicking a title opens the conversation under its agent', () => {
    const selectAgent = vi.fn()
    const openSession = vi.fn().mockResolvedValue(undefined)
    useStore.setState({ selectAgent, openSession } as never)
    render(<SessionsMaintenance />)
    fireEvent.click(screen.getByText('Beta work'))
    expect(selectAgent).toHaveBeenCalledWith('a2')
    expect(openSession).toHaveBeenCalledWith('-beta', 'b')
  })
})
