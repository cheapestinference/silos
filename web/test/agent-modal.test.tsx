// The New agent form asks what Welcome asks (lib/birth.ts, BirthFields):
// its project — one Silos knows or a new one by name, never a path —, a
// name, how it works, its mission, and its engine only when more than one
// is usable. What Create sends is the contract with POST /api/agents.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { AgentModal, fieldForError, slugify } from '../src/components/AgentModal'
import { useStore } from '../src/store'
import { api } from '../src/lib/api'
import type { AgentView } from '../src/lib/types'

vi.mock('../src/lib/api')

const mockedApi = vi.mocked(api, { deep: true })

const agent = (o: Partial<AgentView>): AgentView => ({
  id: 'builder',
  name: 'Builder',
  emoji: '',
  folder: '/home/user/Silos/shop',
  skills: [],
  sessions: [],
  liveCount: 0,
  sessionCount: 0,
  ...o,
})

beforeEach(() => {
  vi.clearAllMocks()
  mockedApi.agents.create.mockImplementation(async (input) => ({ agent: { id: String(input.name).toLowerCase(), name: input.name } as never }))
  mockedApi.overview.mockResolvedValue({ agents: [], now: 0, warming: false })
  useStore.setState({ agents: [], selectedAgentId: null, selected: null, detail: null, modal: null, modalFolder: null, modalName: null, error: null })
})

const sent = (): Record<string, unknown> => mockedApi.agents.create.mock.calls[0]![0] as Record<string, unknown>
const create = async (): Promise<void> => {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
  })
}

describe('AgentModal — what Create sends', () => {
  it('renders nothing with no modal open', () => {
    render(<AgentModal />)
    expect(screen.queryByLabelText('Name')).not.toBeInTheDocument()
  })

  it('a name alone: a new project named like the agent, no path, no model, no skills, no emoji', async () => {
    useStore.setState({ modal: 'create' })
    render(<AgentModal />)
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Pepe' } })
    await create()
    expect(sent()).toEqual({ name: 'Pepe', project: { name: 'Pepe' }, framework: 'claude-code' })
    expect(useStore.getState().modal).toBeNull()
    expect(useStore.getState().page).toEqual({ kind: 'agent', id: 'pepe' })
  })

  it("the new project's name follows the agent's until it is typed; then it is its own", async () => {
    useStore.setState({ modal: 'create' })
    render(<AgentModal />)
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Pepe' } })
    fireEvent.change(screen.getByLabelText('The new project’s name'), { target: { value: 'Acme books' } })
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Ledger' } })
    expect(screen.getByLabelText('The new project’s name')).toHaveValue('Acme books')
    await create()
    expect(sent()).toMatchObject({ name: 'Ledger', project: { name: 'Acme books' } })
  })

  it('an existing project Silos knows is sent as that project; a door opening on it picks it', async () => {
    useStore.setState({ agents: [agent({})], modal: 'create', modalFolder: '/home/user/Silos/shop' })
    render(<AgentModal />)
    expect(screen.getByLabelText('Project')).toHaveValue('/home/user/Silos/shop')
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Clerk' } })
    await create()
    expect(sent()).toMatchObject({ name: 'Clerk', project: { folder: '/home/user/Silos/shop' } })
    expect('folder' in sent()).toBe(false)
  })

  it('a folder New project just made is sent as that folder — the one path the form never asks', async () => {
    useStore.getState().setModal('create', '/home/user/work/acme', 'Acme')
    render(<AgentModal />)
    expect(screen.getByLabelText('Name')).toHaveValue('Acme')
    await create()
    expect(sent()).toMatchObject({ name: 'Acme', folder: '/home/user/work/acme' })
    expect('project' in sent()).toBe(false)
  })

  it('a new project named like a known one is said before sending, and Create waits', async () => {
    useStore.setState({ agents: [agent({})], modal: 'create' })
    render(<AgentModal />)
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Shop' } })
    expect(screen.getByRole('alert')).toHaveTextContent(/A project called Shop exists/)
    expect(screen.getByRole('button', { name: 'Create' })).toBeDisabled()
  })

  it("the server's project refusal shows under Project and the modal stays open", async () => {
    mockedApi.agents.create.mockRejectedValueOnce(new Error('~/Silos/pepe already exists with files in it — pick another project name'))
    useStore.setState({ modal: 'create' })
    render(<AgentModal />)
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Pepe' } })
    await create()
    const message = screen.getByText(/already exists with files in it/)
    expect(screen.getByLabelText('Project').parentElement).toContainElement(message)
    expect(useStore.getState().modal).toBe('create')
  })

  it('name "!!!" (an empty slug) disables submit', () => {
    useStore.setState({ modal: 'create' })
    render(<AgentModal />)
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: '!!!' } })
    expect(screen.getByRole('button', { name: 'Create' })).toBeDisabled()
  })

  it("slugify truncates to 32 characters (the server's cap)", () => {
    expect(slugify('a'.repeat(40)).length).toBeLessThanOrEqual(32)
  })

  it("a project's refusal maps to the Project field, before Name", () => {
    expect(fieldForError('a project called books exists — pick it from the list, or name the new one differently')).toBe('project')
    expect(fieldForError('/home/user/x is not a project Silos knows — pick one from the list')).toBe('project')
  })

  it('Esc and Cancel close it without calling the api', () => {
    useStore.setState({ modal: 'create' })
    const { unmount } = render(<AgentModal />)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(useStore.getState().modal).toBeNull()
    unmount()
    useStore.setState({ modal: 'create' })
    render(<AgentModal />)
    fireEvent.click(screen.getByText('Cancel'))
    expect(useStore.getState().modal).toBeNull()
    expect(mockedApi.agents.create).not.toHaveBeenCalled()
  })
})

// how it works: the ladder's three rungs, asked and never inferred
describe('AgentModal — how it works and the mission', () => {
  it('the mission is split by the one rule; «When you give it work» (the default) sends Only when told', async () => {
    useStore.setState({ modal: 'create' })
    render(<AgentModal />)
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Pepe' } })
    fireEvent.change(screen.getByLabelText(/What will Pepe take care of\?/), {
      target: { value: 'Taxes and accounts.\n  never: file anything\nKeep receipts. Never: this mid-line cuts nothing\nNEVER:   pay anything ' },
    })
    await create()
    expect(sent().mission).toEqual({ text: 'Taxes and accounts.\nKeep receipts. Never: this mid-line cuts nothing', never: ['file anything', 'pay anything'] })
    expect(sent().control).toBe('told')
  })

  it('«Also on its own» sends no control (the server makes a mission On its own); «Proactive» asks for it', async () => {
    useStore.setState({ modal: 'create' })
    const { unmount } = render(<AgentModal />)
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Pepe' } })
    fireEvent.click(screen.getByRole('radio', { name: /Also on its own/ }))
    fireEvent.change(screen.getByLabelText(/What will Pepe take care of\?/), { target: { value: 'Keep the books.' } })
    await create()
    expect('control' in sent()).toBe(false)
    unmount()
    mockedApi.agents.create.mockClear()
    useStore.setState({ modal: 'create' })
    render(<AgentModal />)
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Scout' } })
    fireEvent.click(screen.getByRole('radio', { name: /Proactive/ }))
    expect(screen.getByRole('button', { name: 'Create' })).toBeDisabled() // it needs a mission
    fireEvent.change(screen.getByLabelText(/What will Scout take care of\?/), { target: { value: 'Find leads.' } })
    await create()
    expect(sent()).toMatchObject({ control: 'proactive', mission: { text: 'Find leads.', never: [] } })
  })

  it('empty mission: none is sent, nothing asked', async () => {
    useStore.setState({ modal: 'create' })
    render(<AgentModal />)
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Pepe' } })
    await create()
    expect('mission' in sent()).toBe(false)
    expect('control' in sent()).toBe(false)
  })

  it('«Never» lines alone are said in the field before sending', async () => {
    useStore.setState({ modal: 'create' })
    render(<AgentModal />)
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Pepe' } })
    fireEvent.change(screen.getByLabelText(/What will Pepe take care of\?/), { target: { value: 'Never: pay anything' } })
    expect(screen.getByRole('button', { name: 'Create' })).toBeDisabled()
    await act(async () => {
      fireEvent.submit(screen.getByRole('button', { name: 'Create' }).closest('form')!)
    })
    expect(mockedApi.agents.create).not.toHaveBeenCalled()
  })
})
