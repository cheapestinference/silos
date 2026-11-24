import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ProjectSelector } from '../src/components/ProjectSelector'
import { Transcript } from '../src/components/Transcript'
import { useStore } from '../src/store'
import { api } from '../src/lib/api'
import { MASTER_ID } from '../src/lib/constants'
import type { AgentView, Project } from '../src/lib/types'

vi.mock('../src/lib/api')

const mockedApi = vi.mocked(api, { deep: true })

function makeAgent(overrides: Partial<AgentView> = {}): AgentView {
  return {
    id: 'a1',
    name: 'Ana',
    emoji: '🧠',

    folder: '/x',
    skills: [],
    sessions: [],
    liveCount: 0,
    sessionCount: 0,
    ...overrides,
  }
}

function makeMaster(overrides: Partial<AgentView> = {}): AgentView {
  return makeAgent({ id: MASTER_ID, name: 'Master', folder: null, ...overrides })
}

function makeProject(overrides: Partial<Project> = {}): Project {
  return { cwd: '/home/user/project-one', sessions: 3, lastActivity: 1_700_000_000_000, ...overrides }
}

beforeEach(() => {
  vi.clearAllMocks()
  useStore.setState({
    agents: [],
    warming: false,
    selectedAgentId: null,
    selected: null,
    detail: null,
    filter: '',
    active: null,
    execOut: null,
    modal: null,
    error: null,
    chosenProject: null,
  })
})

describe('ProjectSelector', () => {
  it('requests the list on mount and paints it in the order it arrives in (highlighted basename + dimmed full path + counter)', async () => {
    const projects = [makeProject({ cwd: '/home/user/beta', sessions: 5 }), makeProject({ cwd: '/home/user/alfa', sessions: 1 })]
    mockedApi.projects.mockResolvedValue(projects)

    render(<ProjectSelector />)

    await waitFor(() => expect(screen.getByText('beta')).toBeInTheDocument())

    const rows = screen.getAllByRole('button').filter((b) => b.textContent?.includes('/home/user'))
    // the order arrives as-is from the server (no reordering): beta before alfa
    expect(rows[0]?.textContent).toContain('beta')
    expect(rows[1]?.textContent).toContain('alfa')

    expect(screen.getByText('/home/user/beta')).toBeInTheDocument()
    expect(screen.getByText('5')).toBeInTheDocument()
  })

  it('choosing a project from the list calls chooseProject with its cwd', async () => {
    mockedApi.projects.mockResolvedValue([makeProject({ cwd: '/home/user/beta' })])
    render(<ProjectSelector />)
    await waitFor(() => expect(screen.getByText('beta')).toBeInTheDocument())

    fireEvent.click(screen.getByText('beta'))

    expect(useStore.getState().chosenProject).toBe('/home/user/beta')
  })

  it('with no projects, nothing breaks: the free-text path still works', async () => {
    mockedApi.projects.mockResolvedValue([])
    render(<ProjectSelector />)
    await waitFor(() => expect(mockedApi.projects).toHaveBeenCalled())
    expect(screen.getByLabelText('project path')).toBeInTheDocument()
  })

  it('the free-text path must start with "/": the confirm button is disabled with a relative path', async () => {
    mockedApi.projects.mockResolvedValue([])
    render(<ProjectSelector />)
    const input = screen.getByLabelText('project path')

    fireEvent.change(input, { target: { value: 'does-not-start-with-a-slash' } })
    expect(screen.getByText('Use path')).toBeDisabled()

    fireEvent.change(input, { target: { value: '/x/y' } })
    expect(screen.getByText('Use path')).not.toBeDisabled()
  })

  it('confirming the free-text path (button or Enter) calls chooseProject with the path', async () => {
    mockedApi.projects.mockResolvedValue([])
    mockedApi.mkdir.mockResolvedValue({ path: '/another/project' })
    render(<ProjectSelector />)
    const input = screen.getByLabelText('project path')

    fireEvent.change(input, { target: { value: '/another/project' } })
    fireEvent.click(screen.getByText('Use path'))

    // A fresh path is created first (6d99ee0), then chosen.
    expect(mockedApi.mkdir).toHaveBeenCalledWith('/another/project')
    await waitFor(() => expect(useStore.getState().chosenProject).toBe('/another/project'))
  })

  it('confirming with Enter in the free-text path input also works', async () => {
    mockedApi.projects.mockResolvedValue([])
    mockedApi.mkdir.mockResolvedValue({ path: '/another/project' })
    render(<ProjectSelector />)
    const input = screen.getByLabelText('project path')

    fireEvent.change(input, { target: { value: '/another/project' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(mockedApi.mkdir).toHaveBeenCalledWith('/another/project')
    await waitFor(() => expect(useStore.getState().chosenProject).toBe('/another/project'))
  })

  it('a relative path does not confirm, not even with Enter', async () => {
    mockedApi.projects.mockResolvedValue([])
    render(<ProjectSelector />)
    const input = screen.getByLabelText('project path')

    fireEvent.change(input, { target: { value: 'relative' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(useStore.getState().chosenProject).toBeNull()
  })
})

// integration with Transcript: the slot where the normal EmptyState lives.
describe('Transcript — the project selector replaces the EmptyState for master', () => {
  it('with master selected and no open session, the selector shows instead of the EmptyState', async () => {
    mockedApi.projects.mockResolvedValue([])
    useStore.setState({
      agents: [makeMaster(), makeAgent({ id: 'a1', name: 'Ana' })],
      selectedAgentId: MASTER_ID,
      selected: null,
      detail: null,
    })

    render(<Transcript />)

    expect(screen.getByText('Pick a project')).toBeInTheDocument()
    expect(screen.queryByText('Choose a conversation or type below to start a new one.')).not.toBeInTheDocument()
  })

  it('with a normal agent selected, the usual EmptyState still shows (not the selector)', () => {
    useStore.setState({
      agents: [makeMaster(), makeAgent({ id: 'a1', name: 'Ana', sessionCount: 0 })],
      selectedAgentId: 'a1',
      selected: null,
      detail: null,
    })

    render(<Transcript />)

    expect(screen.queryByText('Pick a project')).not.toBeInTheDocument()
    expect(mockedApi.projects).not.toHaveBeenCalled()
  })

  it('master with a session already open does not show the selector', () => {
    useStore.setState({
      agents: [makeMaster()],
      selectedAgentId: MASTER_ID,
      selected: { folder: 'f', id: 's1' },
      detail: {
        meta: {
          id: 's1',
          folder: 'f',
          title: 'Session',
          skills: [],
          cwd: '/home/user/project',
          mtime: 1,
          size: 1,
          turnCount: 0,
          live: false,
          worktree: false,
          native: true,
          agentId: MASTER_ID,
        },
        turns: [],
        total: 0,
      },
    })

    render(<Transcript />)

    expect(screen.queryByText('Pick a project')).not.toBeInTheDocument()
  })
})
