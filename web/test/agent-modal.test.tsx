import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { AgentModal, slugify } from '../src/components/AgentModal'
import { useStore } from '../src/store'
import { api } from '../src/lib/api'

vi.mock('../src/lib/api')

const mockedApi = vi.mocked(api, { deep: true })

beforeEach(() => {
  vi.clearAllMocks()
  mockedApi.agents.create.mockImplementation(async (input) => ({ agent: { id: String(input.name).toLowerCase(), name: input.name } as never }))
  mockedApi.agents.update.mockResolvedValue(undefined)
  mockedApi.agents.archive.mockResolvedValue(undefined)
  mockedApi.agents.skillState.mockResolvedValue([])
  mockedApi.complete.mockResolvedValue([])
  mockedApi.silosSkillOffer.mockResolvedValue({ skills: [], notOffered: [] })
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
  })
})

describe('AgentModal', () => {
  it('renders nothing with no modal open', () => {
    render(<AgentModal />)
    expect(screen.queryByLabelText('Name')).not.toBeInTheDocument()
  })

  it('create: name "Pepe" + folder "/tmp/x" calls api.agents.create with id "pepe"', async () => {
    useStore.setState({ modal: 'create' })
    render(<AgentModal />)

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Pepe' } })
    fireEvent.change(screen.getByLabelText('Folder'), { target: { value: '/tmp/x' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))

    await waitFor(() => expect(mockedApi.agents.create).toHaveBeenCalledWith(expect.objectContaining({ name: 'Pepe', folder: '/tmp/x' })))
  })

  // setModal('create', folder) — the Sidebar group header's "+ agent"
  // hover / ProjectPage's "+ Create an agent for these".
  it('creating with a prefilled folder (setModal("create", folder)) starts the Folder field already filled in', () => {
    useStore.getState().setModal('create', '/tmp/prefilled')
    render(<AgentModal />)
    expect(screen.getByLabelText('Folder')).toHaveValue('/tmp/prefilled')
  })

  it('creating with no folder (the usual "+ New agent") starts the Folder field empty', () => {
    useStore.getState().setModal('create')
    render(<AgentModal />)
    expect(screen.getByLabelText('Folder')).toHaveValue('')
  })

  it('create: the Emoji field starts pre-filled with a glyph (a new agent is never icon-less)', () => {
    useStore.getState().setModal('create')
    render(<AgentModal />)
    expect((screen.getByLabelText('Emoji') as HTMLInputElement).value).not.toBe('')
  })

  it("create: the id shows in gray under the name as it's typed", () => {
    useStore.setState({ modal: 'create' })
    render(<AgentModal />)
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Pepe' } })
    expect(screen.getByText('pepe')).toBeInTheDocument()
  })

  it('create: the slug of "José María" is "jose-maria"', () => {
    useStore.setState({ modal: 'create' })
    render(<AgentModal />)
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'José María' } })
    expect(screen.getByText('jose-maria')).toBeInTheDocument()
  })

  it('create: a 400 error from the backend shows in the form and does not close the modal', async () => {
    mockedApi.agents.create.mockRejectedValueOnce(new Error('duplicate id'))
    useStore.setState({ modal: 'create' })
    render(<AgentModal />)

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Pepe' } })
    fireEvent.change(screen.getByLabelText('Folder'), { target: { value: '/tmp/x' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))

    await waitFor(() => expect(screen.getByText('duplicate id')).toBeInTheDocument())
    expect(useStore.getState().modal).not.toBeNull()
  })

  it('a folder error ("folder must be an absolute path") shows under the Folder field', async () => {
    mockedApi.agents.create.mockRejectedValueOnce(new Error('folder must be an absolute path'))
    useStore.setState({ modal: 'create' })
    render(<AgentModal />)

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Pepe' } })
    fireEvent.change(screen.getByLabelText('Folder'), { target: { value: 'not-absolute' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))

    await waitFor(() => expect(screen.getByText('folder must be an absolute path')).toBeInTheDocument())
    const message = screen.getByText('folder must be an absolute path')
    // lives in the same block as the Folder input, not at the form's top/bottom
    expect(screen.getByLabelText('Folder').parentElement).toContainElement(message)
  })

  it('name "!!!" (an empty slug) disables submit and shows the hint under Name', () => {
    useStore.setState({ modal: 'create' })
    render(<AgentModal />)
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: '!!!' } })
    expect(screen.getByText('name must contain letters or numbers')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Create' })).toBeDisabled()
  })

  it("slugify truncates to 32 characters (the server's cap)", () => {
    expect(slugify('a'.repeat(40)).length).toBeLessThanOrEqual(32)
  })

  it('create: on success closes the modal and reloads the overview', async () => {
    mockedApi.overview.mockResolvedValue({ agents: [], now: 0, warming: false })
    useStore.setState({ modal: 'create' })
    render(<AgentModal />)

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Pepe' } })
    fireEvent.change(screen.getByLabelText('Folder'), { target: { value: '/tmp/x' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))

    await waitFor(() => expect(useStore.getState().modal).toBeNull())
    expect(mockedApi.overview).toHaveBeenCalled()
  })

  it("skills: Enter adds one of Silos' skills as a chip and clicking the chip removes it", async () => {
    mockedApi.silosSkillOffer.mockResolvedValue({ skills: [{ name: 'team-plan' }], notOffered: [] })
    useStore.setState({ modal: 'create' })
    render(<AgentModal />)
    await screen.findByRole('checkbox', { name: 'team-plan' })
    const input = screen.getByLabelText('Skills')
    fireEvent.change(input, { target: { value: 'team-plan' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(screen.getByTitle('remove')).toHaveTextContent('team-plan')
    fireEvent.click(screen.getByTitle('remove'))
    expect(screen.queryByTitle('remove')).not.toBeInTheDocument()
  })

  it('Esc closes the modal', () => {
    useStore.setState({ modal: 'create' })
    render(<AgentModal />)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(useStore.getState().modal).toBeNull()
  })

  it('Cancel closes the modal without calling the api', () => {
    useStore.setState({ modal: 'create' })
    render(<AgentModal />)
    fireEvent.click(screen.getByText('Cancel'))
    expect(useStore.getState().modal).toBeNull()
    expect(mockedApi.agents.create).not.toHaveBeenCalled()
  })

  // role, charter and «In charge of» became ONE
  // textarea — «What will <Name> take care of?» — split by the one rule
  // (lib/mission.ts): lines starting «Never:» are the rules, the rest the text.
  it('the mission textarea is split by the one rule and sent as the mission', async () => {
    useStore.setState({ modal: 'create' })
    render(<AgentModal />)
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Pepe' } })
    fireEvent.change(screen.getByLabelText('Folder'), { target: { value: '/tmp/x' } })
    expect(screen.queryByLabelText('Role')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Charter')).not.toBeInTheDocument()
    expect(screen.queryByLabelText(/in charge of/i)).not.toBeInTheDocument()
    expect(screen.getByText(/Leave it empty and Pepe does only what you give it/)).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText(/What will Pepe take care of\?/), {
      target: { value: 'Taxes and accounts.\n  never: file anything\nKeep receipts. Never: this mid-line cuts nothing\nNEVER:   pay anything ' },
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    })
    const body = mockedApi.agents.create.mock.calls[0]![0] as Record<string, unknown>
    expect(body.mission).toEqual({ text: 'Taxes and accounts.\nKeep receipts. Never: this mid-line cuts nothing', never: ['file anything', 'pay anything'] })
    // «When you give it work» is the default: the mission only describes the job
    expect(body.control).toBe('told')
    for (const gone of ['role', 'systemAppend', 'responsibility']) expect(gone in body).toBe(false)
    expect(useStore.getState().modal).toBeNull()
  })

  it('empty: the agent is created with no mission', async () => {
    useStore.setState({ modal: 'create' })
    render(<AgentModal />)
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Pepe' } })
    fireEvent.change(screen.getByLabelText('Folder'), { target: { value: '/tmp/x' } })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    })
    expect('mission' in (mockedApi.agents.create.mock.calls[0]![0] as object)).toBe(false)
    expect(useStore.getState().modal).toBeNull()
  })

  it('«Never» lines alone are said in the field before sending — the API words never reach this screen', async () => {
    useStore.setState({ modal: 'create' })
    render(<AgentModal />)
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Pepe' } })
    fireEvent.change(screen.getByLabelText('Folder'), { target: { value: '/tmp/x' } })
    fireEvent.change(screen.getByLabelText(/What will Pepe take care of\?/), { target: { value: 'Never: pay anything' } })
    expect(screen.getByRole('alert')).toHaveTextContent("Write what Pepe takes care of — “Never” lines alone aren't a mission yet")
    expect(screen.getByRole('button', { name: 'Create' })).toBeDisabled()
    await act(async () => {
      fireEvent.submit(screen.getByRole('button', { name: 'Create' }).closest('form')!)
    })
    expect(mockedApi.agents.create).not.toHaveBeenCalled()
  })
})

// The picker offers EXACTLY what the add route can copy into the new
// agent's folder — Silos' own skills (GET /api/silos-skills). It used to
// list every name ever seen (transcripts, other folders, plugins), each of
// which then failed after the agent existed.
describe("AgentModal — the skills selector offers only Silos' skills", () => {
  it("opening the modal loads Silos' skills; checking one adds it as a chip; submit adds it as a real copy", async () => {
    mockedApi.silosSkillOffer.mockResolvedValue({ skills: [{ name: 'team-plan', description: 'Plan' }, { name: 'heartbeat' }], notOffered: [] })
    useStore.setState({ modal: 'create' })
    render(<AgentModal />)
    expect(await screen.findByRole('checkbox', { name: 'team-plan' })).toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: 'heartbeat' })).toBeInTheDocument()
    expect(mockedApi.silosSkillOffer).toHaveBeenCalled()
    expect(mockedApi.complete).not.toHaveBeenCalled() // never the everything-ever-seen name list
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Pepe' } })
    fireEvent.click(screen.getByRole('checkbox', { name: 'team-plan' }))
    expect(screen.getByTitle('remove')).toHaveTextContent('team-plan')
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    })
    // capability states: the pick becomes a REAL copy via the add
    // route after the create — agent.skills is never written
    expect(mockedApi.agents.create).toHaveBeenCalledWith(expect.objectContaining({ skills: [] }))
    expect(mockedApi.agents.skillState).toHaveBeenCalledWith('pepe', 'team-plan', 'add')
  })

  it('a failed add is surfaced by name and the modal stays open', async () => {
    mockedApi.silosSkillOffer.mockResolvedValue({ skills: [{ name: 'team-plan' }], notOffered: [] })
    mockedApi.overview.mockResolvedValue({ agents: [], now: 0, warming: false })
    mockedApi.agents.skillState.mockRejectedValueOnce(new Error('agent has no folder'))
    useStore.setState({ modal: 'create' })
    render(<AgentModal />)
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Pepe' } })
    fireEvent.click(await screen.findByRole('checkbox', { name: 'team-plan' }))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    })
    expect(useStore.getState().modal).not.toBeNull()
    expect(screen.getByText(/team-plan: agent has no folder/)).toBeInTheDocument()
    fireEvent.click(screen.getByText('Close'))
    expect(useStore.getState().modal).toBeNull()
  })

  it('typing filters the options; Enter on the one option left adds it', async () => {
    mockedApi.silosSkillOffer.mockResolvedValue({ skills: [{ name: 'team-plan' }, { name: 'heartbeat' }], notOffered: [] })
    useStore.setState({ modal: 'create' })
    render(<AgentModal />)
    await screen.findByRole('checkbox', { name: 'team-plan' })
    const input = screen.getByLabelText('Skills')
    fireEvent.change(input, { target: { value: 'heart' } })
    expect(screen.queryByRole('checkbox', { name: 'team-plan' })).not.toBeInTheDocument()
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(screen.getByTitle('remove')).toHaveTextContent('heartbeat')
  })

  it("Enter on a name that isn't one of Silos' skills adds nothing and says why — never a chip that will fail after the create", async () => {
    mockedApi.silosSkillOffer.mockResolvedValue({ skills: [{ name: 'team-plan' }], notOffered: [] })
    useStore.setState({ modal: 'create' })
    render(<AgentModal />)
    await screen.findByRole('checkbox', { name: 'team-plan' })
    const input = screen.getByLabelText('Skills')
    fireEvent.change(input, { target: { value: 'frontend-design' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(screen.queryByTitle('remove')).not.toBeInTheDocument()
    expect(screen.getByText(/“frontend-design” isn’t one of Silos’ skills/)).toBeInTheDocument()
  })

  it("if Silos' skills can't be read: no options, and the modal says so — still usable", async () => {
    mockedApi.silosSkillOffer.mockRejectedValue(new Error('down'))
    useStore.setState({ modal: 'create' })
    render(<AgentModal />)
    expect(await screen.findByText(/Silos’ skills couldn’t be read/)).toBeInTheDocument()
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
  })
})

// The offer is the server's catalog rule for THIS draft (engine + folder):
// a Silos skill add would refuse for that agent is never offered, and the
// modal says why instead of an unexplained empty picker.
describe('AgentModal — the offer follows the draft engine and folder', () => {
  it('asks per folder; a pick no longer offered is dropped and the reason is said', async () => {
    mockedApi.silosSkillOffer.mockImplementation(async ({ folder }) =>
      folder === '/p'
        ? { skills: [{ name: 'team-plan' }], notOffered: [] }
        : folder === '/q'
          ? { skills: [], notOffered: [{ name: 'team-plan', why: '"team-plan" already loads in this folder — there is nothing to add' }] }
          : { skills: [], notOffered: [{ name: 'team-plan', why: 'pick a folder first — a skill is added as a copy in the agent’s folder' }] },
    )
    useStore.setState({ modal: 'create' })
    render(<AgentModal />)
    expect(await screen.findByText(/pick a folder first/)).toBeInTheDocument()
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Folder'), { target: { value: '/p' } })
    fireEvent.click(await screen.findByRole('checkbox', { name: 'team-plan' }))
    expect(mockedApi.silosSkillOffer).toHaveBeenLastCalledWith(expect.objectContaining({ folder: '/p' }))
    expect(screen.getByTitle('remove')).toHaveTextContent('team-plan')
    fireEvent.change(screen.getByLabelText('Folder'), { target: { value: '/q' } })
    expect(await screen.findByText(/already loads in this folder/)).toBeInTheDocument()
    expect(screen.getByTestId('skills-not-offered')).toHaveTextContent('team-plan — already loads in this folder')
    expect(screen.queryByTitle('remove')).not.toBeInTheDocument() // dropped: add would refuse it
    // Enter on the refused name says the server's reason
    const input = screen.getByLabelText('Skills')
    fireEvent.change(input, { target: { value: 'team-plan' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(screen.getByText(/“team-plan” already loads in this folder/)).toBeInTheDocument()
  })

  it('a relative folder is never sent as the draft folder', async () => {
    useStore.setState({ modal: 'create' })
    render(<AgentModal />)
    fireEvent.change(screen.getByLabelText('Folder'), { target: { value: 'rel/path' } })
    await waitFor(() => expect(mockedApi.silosSkillOffer).toHaveBeenLastCalledWith(expect.objectContaining({ folder: '' })))
  })
})
