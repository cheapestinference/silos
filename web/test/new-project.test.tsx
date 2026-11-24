// new-project.test.tsx — how things are started (creating projects and
// agents must be obvious): one "+ New" in the sidebar and
// the same four in ⌘K; "New project" = a folder (known ones suggested, a new
// one created) with its own agent PROPOSED, named after the folder, through
// the usual new-agent form.
import { beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('../src/lib/api')
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { NewProjectModal, agentNameForFolder } from '../src/components/NewProjectModal'
import { NEW_ENTRIES } from '../src/lib/new-entries'
import { useStore } from '../src/store'
import { api } from '../src/lib/api'
import type { AgentView } from '../src/lib/types'

const mocked = vi.mocked(api, { deep: true })
const agent = (o: Partial<AgentView>): AgentView => ({
  id: 'a',
  name: 'A',
  emoji: '🧠',
  folder: '/x',
  skills: [],
  sessions: [],
  liveCount: 0,
  sessionCount: 0,
  ...o,
})

beforeEach(() => {
  vi.clearAllMocks()
  vi.useRealTimers()
  mocked.projects.mockResolvedValue([{ cwd: '/home/u/known', sessions: 3, lastActivity: 1 }])
  mocked.mkdir.mockResolvedValue({ path: '' })
  mocked.file.dir.mockImplementation(async (p: string) => {
    if (p === '/home/u/known' || p === '/home/u/silos') return { path: p, entries: [] }
    if (p === '/home/u/notes.md') throw new Error('not a folder')
    throw new Error('folder not found')
  })
  useStore.setState({
    modal: 'new-project',
    modalFolder: null,
    modalName: null,
    agents: [agent({ id: 'master', name: 'Master', folder: null }), agent({ id: 'writer', name: 'Writer', folder: '/home/u/silos' })],
  })
})

const folderInput = () => screen.getByLabelText('Folder')
const type = (v: string) => fireEvent.change(folderInput(), { target: { value: v } })
const hint = () => screen.getByTestId('new-project-folder-hint')

describe('agentNameForFolder', () => {
  it('names the agent after the folder, as a person would say it', () => {
    expect(agentNameForFolder('/home/u/acme-labs')).toBe('Acme labs')
    expect(agentNameForFolder('/home/u/research/')).toBe('Research')
    expect(agentNameForFolder('/')).toBe('')
  })
})

describe('New project', () => {
  it('a new folder: said, created, and its agent proposed through the usual form, already filled', async () => {
    render(<NewProjectModal />)
    type('/home/u/research-lab')
    await waitFor(() => expect(hint()).toHaveTextContent('New folder — Silos creates it.'))
    expect(screen.getByLabelText('Its name')).toHaveValue('Research lab')
    fireEvent.click(screen.getByRole('button', { name: 'Next: its agent' }))
    await waitFor(() => expect(mocked.mkdir).toHaveBeenCalledWith('/home/u/research-lab'))
    await waitFor(() => expect(useStore.getState().modal).toBe('create'))
    expect(useStore.getState().modalFolder).toBe('/home/u/research-lab')
    expect(useStore.getState().modalName).toBe('Research lab')
  })

  it('a known folder says how much ran there and is not re-created; a typed name sticks', async () => {
    render(<NewProjectModal />)
    type('/home/u/known')
    await waitFor(() => expect(hint()).toHaveTextContent('Exists — 3 conversations have run there.'))
    fireEvent.change(screen.getByLabelText('Its name'), { target: { value: 'Scout' } })
    type('/home/u/known/')
    await waitFor(() => expect(hint()).toHaveTextContent('Exists'))
    expect(screen.getByLabelText('Its name')).toHaveValue('Scout')
    fireEvent.click(screen.getByRole('button', { name: 'Next: its agent' }))
    await waitFor(() => expect(useStore.getState().modal).toBe('create'))
    expect(mocked.mkdir).not.toHaveBeenCalled()
    expect(useStore.getState().modalName).toBe('Scout')
  })

  it('without its own agent, it starts as a conversation with Anywhere in that folder', async () => {
    const selectAgent = vi.fn()
    const startNewConversation = vi.fn()
    const chooseProject = vi.fn()
    useStore.setState({ selectAgent, startNewConversation, chooseProject })
    render(<NewProjectModal />)
    type('/home/u/known')
    await waitFor(() => expect(hint()).toHaveTextContent('Exists'))
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: 'Start the project' }))
    await waitFor(() => expect(chooseProject).toHaveBeenCalledWith('/home/u/known'))
    expect(selectAgent).toHaveBeenCalledWith('master')
    expect(startNewConversation).toHaveBeenCalled()
    expect(useStore.getState().modal).toBeNull()
  })

  it('a folder an agent already lives in is a project already: no duplicate agent, it opens', async () => {
    render(<NewProjectModal />)
    type('/home/u/silos')
    await waitFor(() => expect(screen.getByTestId('new-project-residents')).toHaveTextContent('Already a project: Writer lives there.'))
    expect(screen.queryByLabelText('Its name')).toBeNull()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Open the project' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Open the project' }))
    await waitFor(() => expect(useStore.getState().page).toEqual({ kind: 'project', folder: '/home/u/silos' }))
  })

  it('a relative path or a file never creates anything', async () => {
    render(<NewProjectModal />)
    type('research')
    expect(hint()).toHaveTextContent(/absolute/)
    expect(screen.getByRole('button', { name: 'Next: its agent' })).toBeDisabled()
    type('/home/u/notes.md')
    await waitFor(() => expect(hint()).toHaveTextContent(/file/))
    expect(screen.getByRole('button', { name: 'Next: its agent' })).toBeDisabled()
  })
})

describe('the four ways to start something', () => {
  it('"+ New" and ⌘K share one list: project, agent, conversation, automation', () => {
    expect(NEW_ENTRIES.map((e) => e.label)).toEqual(['New project', 'New agent', 'New conversation', 'New automation'])
    act(() => NEW_ENTRIES[0]!.run())
    expect(useStore.getState().modal).toBe('new-project')
    act(() => NEW_ENTRIES[1]!.run())
    expect(useStore.getState().modal).toBe('create')
    act(() => NEW_ENTRIES[3]!.run())
    expect(useStore.getState().page).toEqual({ kind: 'automation', id: 'new' })
  })

  it('the agent form opens with the proposed name and folder', async () => {
    const { AgentModal } = await import('../src/components/AgentModal')
    mocked.skillsCatalog?.mockResolvedValue?.([] as never)
    useStore.setState({ modal: 'create', modalFolder: '/home/u/research-lab', modalName: 'Research lab' })
    render(<AgentModal />)
    const dialog = screen.getByRole('dialog', { name: 'new agent' })
    await waitFor(() => expect(within(dialog).getByDisplayValue('Research lab')).toBeInTheDocument())
    // the folder New project just made is no path to type: it is what Create sends
    mocked.agents.create.mockResolvedValue({ agent: { id: 'research-lab', name: 'Research lab' } } as never)
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }))
    await waitFor(() => expect(mocked.agents.create).toHaveBeenCalled())
    expect(mocked.agents.create.mock.calls[0]![0]).toMatchObject({ name: 'Research lab', folder: '/home/u/research-lab' })
  })
})
