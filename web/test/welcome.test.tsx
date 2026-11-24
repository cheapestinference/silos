// Creating an agent without decisions: Welcome asks what the New agent
// form asks (lib/birth.ts) — its project first, on a step of its own (by
// default a new one named like the agent, never a path), then a name, how
// it works, what it takes care of —,
// sends no id, and lands on the agent's first minute —
// «<Name> is reading its mission…», the card as it answered, or why it
// couldn't start; without a mission, «<Name> is here. It does what you give it.»
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { harnessDescriptors } from '../src/lib/harnesses'
import { knowsDoors } from '../src/components/knows/KnowsAnatomy'
import { Welcome } from '../src/components/Welcome'
import { FirstMeeting } from '../src/components/agent/FirstMeeting'
import { useStore } from '../src/store'
import { api } from '../src/lib/api'
import { endFirstMeeting, firstMeetingNow, startFirstMeeting } from '../src/lib/first-meeting'
import type { AgentView } from '../src/lib/types'

vi.mock('../src/lib/api')
const mockedApi = vi.mocked(api, { deep: true })

const agent = (o: Partial<AgentView> = {}): AgentView => ({
  id: 'ana',
  name: 'Ana',
  emoji: '•',
  folder: '/home/u/Silos/ana',
  skills: [],
  sessions: [],
  liveCount: 0,
  sessionCount: 0,
  control: 'own',
  heartbeat: { period: { every: 1, unit: 'weeks', day: 1, at: '09:07' } },
  mission: { text: 'Taxes and accounts.', never: [], updatedAt: '' },
  ...o,
})

// the rail's step by name
const go = (step: string): void => {
  fireEvent.click(within(screen.getByRole('list', { name: 'Setup' })).getByRole('button', { name: new RegExp(step) }))
}
const named = (name: string): void => {
  go('Who')
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: name } })
}

beforeEach(() => {
  vi.clearAllMocks()
  endFirstMeeting()
  mockedApi.overview.mockImplementation(async () => ({ agents: useStore.getState().agents, now: 0, warming: false }))
  mockedApi.silos.records.mockResolvedValue({ records: [], total: 0 } as never)
  useStore.setState({ agents: [], page: null, turnPulse: {} })
})

describe('Welcome', () => {
  it('a name, «Also on its own» and a mission: Create sends them alone — the server derives id, folder and control — and opens its first minute', async () => {
    mockedApi.agents.create.mockResolvedValue({ agent: agent() })
    render(<Welcome />)
    named('Ana')
    fireEvent.click(screen.getByRole('radio', { name: /Also on its own/ }))
    fireEvent.change(screen.getByLabelText('What will Ana take care of?'), { target: { value: 'Taxes and accounts.\nNever: file or pay anything' } })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    })
    expect(mockedApi.agents.create).toHaveBeenCalledWith({
      name: 'Ana',
      project: { name: 'Ana' },
      mission: { text: 'Taxes and accounts.', never: ['file or pay anything'] },
    })
    expect(firstMeetingNow()).toEqual({ agentId: 'ana' })
    await waitFor(() => expect(useStore.getState().page).toEqual({ kind: 'agent', id: 'ana' }))
    expect(screen.queryByText(/cp -r|claude plugin install/)).toBeNull()
  })
  // the project is the first step; its name follows the agent's until typed
  it('opens on the project: nothing named, Create waits; named on Who, the project takes the name and Create is live there', async () => {
    mockedApi.agents.create.mockResolvedValue({ agent: agent({ control: 'told', mission: undefined }) })
    render(<Welcome />)
    expect(screen.getByTestId('tour-project')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Create' })).toBeDisabled()
    named('Ana')
    go('Project')
    expect(screen.getByLabelText('The new project’s name')).toHaveValue('Ana')
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    })
    expect(mockedApi.agents.create).toHaveBeenCalledWith({ name: 'Ana', project: { name: 'Ana' } })
  })
  it('a project named on its own step is sent as its own — the agent keeps its name', async () => {
    mockedApi.agents.create.mockResolvedValue({ agent: agent({ control: 'told', mission: undefined }) })
    render(<Welcome />)
    fireEvent.change(screen.getByLabelText('The new project’s name'), { target: { value: 'Acme books' } })
    named('Ana')
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    })
    expect(mockedApi.agents.create).toHaveBeenCalledWith({ name: 'Ana', project: { name: 'Acme books' } })
  })
  // how it works is asked, never inferred from the mission
  it('«When you give it work» (the default) with a mission: sent as Only when told — nothing wakes it', async () => {
    mockedApi.agents.create.mockResolvedValue({ agent: agent({ control: 'told' }) })
    render(<Welcome />)
    named('Ana')
    fireEvent.change(screen.getByLabelText(/What will Ana take care of\?/), { target: { value: 'Taxes and accounts.' } })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    })
    expect(mockedApi.agents.create).toHaveBeenCalledWith({
      name: 'Ana',
      project: { name: 'Ana' },
      mission: { text: 'Taxes and accounts.', never: [] },
      control: 'told',
    })
  })
  it('«Also on its own» without a mission: Create waits for one', () => {
    render(<Welcome />)
    named('Ana')
    fireEvent.click(screen.getByRole('radio', { name: /Also on its own/ }))
    expect(screen.getByRole('button', { name: 'Create' })).toBeDisabled()
  })
  it('«Never» lines alone are no mission yet — said in the field, Create waits', () => {
    render(<Welcome />)
    named('Ana')
    fireEvent.change(screen.getByLabelText(/What will Ana take care of\?/), { target: { value: 'Never: pay' } })
    expect(screen.getByRole('alert')).toHaveTextContent("Write what Ana takes care of — “Never” lines alone aren't a mission yet")
    expect(screen.getByRole('button', { name: 'Create' })).toBeDisabled()
  })
})

// «Skip for now»: nothing is made; Home takes the pane, and stays after a reload
describe('Welcome · skip', () => {
  it('Skip leaves the tour for Home and makes nothing', () => {
    render(<Welcome />)
    fireEvent.click(screen.getByRole('button', { name: /Skip for now/ }))
    expect(useStore.getState().welcomeSkipped).toBe(true)
    expect(mockedApi.agents.create).not.toHaveBeenCalled()
    expect(mockedApi.silos.uninstall).not.toHaveBeenCalled()
  })
})

// signing in to Claude lives in ONE step — what it runs on — never on the first
describe('Welcome · signing in to Claude', () => {
  const signedOut = [
    {
      id: 'default',
      kind: 'claude-account',
      label: 'default',
      window: null,
      account: { name: 'default', configDir: null, providerId: 'default', loggedIn: false, email: null, plan: null, shared: true },
    },
  ]
  it('signed out: the first step asks nothing of it; «Runs on» opens Claude’s own sign-in for the machine’s account', async () => {
    mockedApi.providers.list.mockResolvedValue(signedOut as never)
    mockedApi.accounts.list.mockResolvedValue([{ name: 'default', configDir: null, providerId: 'default', loggedIn: false } as never])
    mockedApi.accounts.login.mockReturnValue(new Promise(() => {}))
    render(<Welcome />)
    await waitFor(() => expect(mockedApi.providers.list).toHaveBeenCalled())
    expect(screen.queryByRole('button', { name: 'Sign in to Claude ›' })).toBeNull()
    fireEvent.click(within(screen.getByRole('list', { name: 'Setup' })).getByRole('button', { name: /Runs on/ }))
    fireEvent.click(await screen.findByRole('button', { name: 'Sign in to Claude ›' }))
    expect(await screen.findByTestId('claude-sign-in')).toBeInTheDocument()
    expect(mockedApi.accounts.login).toHaveBeenCalledWith('default')
  })
})

// the tour's choices reach what Create sends — defaults stay absence (above)
describe('Welcome · the tour', () => {
  const [FIRST, SECOND] = harnessDescriptors()
  const verdict = (harness: string, state: 'ok' | 'missing') => ({
    harness,
    name: harness,
    state,
    installed: state === 'ok' ? '9.9.9' : null,
    needed: '1.0.0',
    update: null,
    refuses: [],
    message: state === 'ok' ? null : `${harness} isn’t installed`,
  })
  const silos = {
    silos: [
      { id: 'plans', name: 'Plans', description: 'Shared plans.', provenance: 'builtin', lineup: 'recommended', producer: { role: 'any-agent', sync: null } },
      {
        id: 'system',
        name: 'System',
        description: 'What your conversations left running.',
        provenance: 'builtin',
        lineup: 'recommended',
        loses: 'System loses its lists.',
        producer: { role: 'kernel', sync: null },
      },
      { id: 'support', name: 'Support', description: 'Support cases.', provenance: 'builtin', lineup: 'optional', producer: { role: 'helpdesk', sync: null } },
    ],
    available: [{ id: 'hierarchy', name: 'Hierarchy', description: 'Who reports to whom.', version: '0.1.0', producerRole: null }],
  }
  const start = async (): Promise<void> => {
    render(<Welcome />)
    named('Ana')
  }
  beforeEach(() => {
    mockedApi.agents.create.mockResolvedValue({ agent: agent() })
    mockedApi.harness.mockResolvedValue({
      harness: FIRST!.id,
      name: '',
      console: { version: null, path: null },
      latest: null,
      checkedAt: '',
      compat: [verdict(FIRST!.id, 'ok'), verdict(SECOND!.id, 'ok')],
    })
    mockedApi.silos.list.mockResolvedValue(silos as never)
  })

  it('another engine is sent as the framework', async () => {
    await start()
    go('Engine')
    fireEvent.click(await screen.findByRole('radio', { name: new RegExp(SECOND!.label) }))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    })
    expect(mockedApi.agents.create).toHaveBeenCalledWith({ name: 'Ana', project: { name: 'Ana' }, framework: SECOND!.id })
  })
  // the birth model's rule: the Engine step only when more than one runs here
  it('one engine runs here: no Engine step, and Create sends the default', async () => {
    mockedApi.harness.mockResolvedValue({
      harness: FIRST!.id,
      name: '',
      console: { version: null, path: null },
      latest: null,
      checkedAt: '',
      compat: [verdict(FIRST!.id, 'ok'), verdict(SECOND!.id, 'missing')],
    })
    await start()
    const rail = screen.getByRole('list', { name: 'Setup' })
    await waitFor(() => expect(within(rail).queryByRole('button', { name: /Engine/ })).toBeNull())
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    })
    expect(mockedApi.agents.create).toHaveBeenCalledWith({ name: 'Ana', project: { name: 'Ana' } })
  })
  it('silos toggled: uninstall, then install + approve with no producers — all before the agent', async () => {
    mockedApi.silos.installAvailable.mockResolvedValue({ submission: { id: 'sub-1' } })
    mockedApi.silos.approve.mockResolvedValue({ kind: 'installed', silo: null })
    mockedApi.silos.uninstall.mockResolvedValue({ uninstalled: 'system' })
    await start()
    go('Silos')
    fireEvent.click(await screen.findByRole('checkbox', { name: /System/ }))
    fireEvent.click(screen.getByRole('checkbox', { name: /Hierarchy/ }))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    })
    expect(mockedApi.silos.uninstall).toHaveBeenCalledWith('system')
    expect(mockedApi.silos.installAvailable).toHaveBeenCalledWith('hierarchy')
    expect(mockedApi.silos.approve).toHaveBeenCalledWith('sub-1', { producers: [], automation: false })
    expect(mockedApi.silos.approve.mock.invocationCallOrder[0]!).toBeLessThan(mockedApi.agents.create.mock.invocationCallOrder[0]!)
    expect(mockedApi.silos.uninstall).not.toHaveBeenCalledWith('plans')
  })
  it('a silo change that fails is said on the agent’s first minute — the agent is still made', async () => {
    mockedApi.silos.uninstall.mockRejectedValue(new Error('nope'))
    await start()
    go('Silos')
    fireEvent.click(await screen.findByRole('checkbox', { name: /System/ }))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    })
    expect(mockedApi.agents.create).toHaveBeenCalledTimes(1)
    expect(firstMeetingNow()?.warn).toContain('system')
  })
  // what a new project starts with (spec tools-origin §8): the step only
  // for an engine that declares classes; Create saves the set — when it
  // differs from Recommended — before the agent whose folder is born with it
  const startingSet = {
    [FIRST!.id]: [
      { id: 'plugins', what: 'plugins', from: 'an account', recommended: false, covers: 'plugin' as const },
      { id: 'skills', what: 'skills', from: 'an account', recommended: true, covers: 'skill' as const },
    ],
  }
  it('At start ticked: the set is saved, then the agent is made', async () => {
    mockedApi.platformSettings.get.mockResolvedValue({ unattendedProvider: null, keepOwnAccount: [], startingSet })
    mockedApi.platformSettings.setStartingSet.mockResolvedValue({ unattendedProvider: null, keepOwnAccount: [], startingSet })
    await start()
    await waitFor(() => go('At start'))
    fireEvent.click(await screen.findByRole('checkbox', { name: /Plugins from an account/ }))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    })
    expect(mockedApi.platformSettings.setStartingSet).toHaveBeenCalledWith({ [FIRST!.id]: { plugins: true } })
    expect(mockedApi.platformSettings.setStartingSet.mock.invocationCallOrder[0]!).toBeLessThan(mockedApi.agents.create.mock.invocationCallOrder[0]!)
  })
  it('At start left on Recommended: nothing is saved; an engine with no class has no At start step', async () => {
    mockedApi.platformSettings.get.mockResolvedValue({ unattendedProvider: null, keepOwnAccount: [], startingSet })
    await start()
    const rail = screen.getByRole('list', { name: 'Setup' })
    await waitFor(() => expect(within(rail).getAllByRole('listitem')).toHaveLength(6))
    go('Engine')
    fireEvent.click(await screen.findByRole('radio', { name: new RegExp(SECOND!.label) }))
    expect(within(rail).getAllByRole('listitem')).toHaveLength(5)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    })
    expect(mockedApi.platformSettings.setStartingSet).not.toHaveBeenCalled()
    expect(mockedApi.agents.create).toHaveBeenCalledTimes(1)
  })
  it('silos that can’t be read leave Create working', async () => {
    mockedApi.silos.list.mockRejectedValue(new Error('500'))
    await start()
    go('Silos')
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    })
    expect(mockedApi.agents.create).toHaveBeenCalledWith({ name: 'Ana', project: { name: 'Ana' } })
    expect(mockedApi.silos.uninstall).not.toHaveBeenCalled()
  })
  it('a Create that fails after the silos changed: the retry does not change them again', async () => {
    mockedApi.silos.uninstall.mockResolvedValue({ uninstalled: 'system' })
    mockedApi.agents.create.mockRejectedValueOnce(new Error('that name is taken'))
    await start()
    go('Silos')
    fireEvent.click(await screen.findByRole('checkbox', { name: /System/ }))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    })
    expect(await screen.findByText('that name is taken')).toBeInTheDocument()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    })
    expect(mockedApi.agents.create).toHaveBeenCalledTimes(2)
    expect(mockedApi.silos.uninstall).toHaveBeenCalledTimes(1)
  })
  it('the default engine this machine cannot run and one other that runs: no Engine step, Create sends the one that runs', async () => {
    mockedApi.harness.mockResolvedValue({
      harness: FIRST!.id,
      name: '',
      console: { version: null, path: null },
      latest: null,
      checkedAt: '',
      compat: [verdict(FIRST!.id, 'missing'), verdict(SECOND!.id, 'ok')],
    })
    await start()
    const rail = screen.getByRole('list', { name: 'Setup' })
    await waitFor(() => expect(within(rail).queryByRole('button', { name: /Engine/ })).toBeNull())
    await waitFor(() => expect(screen.getByRole('button', { name: 'Create' })).toBeEnabled())
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    })
    expect(mockedApi.agents.create).toHaveBeenCalledWith({ name: 'Ana', project: { name: 'Ana' }, framework: SECOND!.id })
  })
  it('no engine runs here: Create waits', async () => {
    mockedApi.harness.mockResolvedValue({
      harness: FIRST!.id,
      name: '',
      console: { version: null, path: null },
      latest: null,
      checkedAt: '',
      compat: [verdict(FIRST!.id, 'missing'), verdict(SECOND!.id, 'missing')],
    })
    await start()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Create' })).toBeDisabled())
  })
})

describe('FirstMeeting', () => {
  it('with a mission: reading it, then the card word for word with Right · Change · Make it a task instead, and its rhythm', async () => {
    mockedApi.chat.mockResolvedValue({ turnId: 'T1' })
    startFirstMeeting({ agentId: 'ana' })
    render(<FirstMeeting agent={agent()} />)
    expect(screen.getByTestId('first-reading')).toHaveTextContent('Ana is reading its mission…')
    await waitFor(() => expect(mockedApi.chat).toHaveBeenCalledTimes(1))
    act(() => {
      useStore.setState({
        turnPulse: { T1: { tool: null, lastAt: 1, ended: 'done', said: "I'll look after: taxes and accounts.\nI won't: file or pay anything." } },
      })
    })
    const card = await screen.findByTestId('first-card')
    expect(card).toHaveTextContent("I'll look after: taxes and accounts.")
    expect(screen.getByTestId('first-right')).toBeInTheDocument()
    expect(screen.getByTestId('first-change')).toBeInTheDocument()
    expect(screen.getByTestId('first-instead')).toHaveTextContent('Make it a task instead')
    expect(screen.getByTestId('first-control')).toHaveTextContent('Every Monday at 09:07 ›')
  })
  // the task first, in ONE request; the mission
  // goes only once the task exists — a refusal leaves it where it was
  it('«Make it a task instead»: ONE `new`, THEN the mission goes; refused — the mission stays', async () => {
    mockedApi.chat.mockResolvedValue({ turnId: 'T3' })
    mockedApi.tasksNew.mockRejectedValueOnce(new Error('the plan no longer reads'))
    startFirstMeeting({ agentId: 'ana' })
    useStore.setState({ turnPulse: { T3: { tool: null, lastAt: 1, ended: 'done', said: 'ok' } } })
    render(<FirstMeeting agent={agent()} />)
    fireEvent.click(await screen.findByTestId('first-instead'))
    expect(await screen.findByRole('alert')).toHaveTextContent('the plan no longer reads')
    expect(mockedApi.tasksNew).toHaveBeenCalledWith({ folder: '/home/u/Silos/ana', plan: 'tasks', title: 'Taxes and accounts.', owner: 'ana' })
    expect(mockedApi.agents.update).not.toHaveBeenCalled()
    expect(mockedApi.silos.append).not.toHaveBeenCalled()
    mockedApi.tasksNew.mockResolvedValueOnce({ key: 'folder:/home/u/Silos/ana/tasks/tasks/t1', id: 't1', ref: 'ana#t1', title: 'Taxes and accounts.' })
    mockedApi.agents.update.mockResolvedValue({} as never)
    fireEvent.click(screen.getByTestId('first-instead'))
    await waitFor(() => expect(mockedApi.agents.update).toHaveBeenCalledWith('ana', { control: 'told', mission: null }))
    expect(mockedApi.tasksNew.mock.invocationCallOrder[1]!).toBeLessThan(mockedApi.agents.update.mock.invocationCallOrder[0]!)
  })
  it('a birth degraded to Only when told: no rhythm promised — the territory warn and its door', async () => {
    mockedApi.chat.mockResolvedValue({ turnId: 'T2' })
    startFirstMeeting({ agentId: 'ana', warn: "Ana's territory is off — its folder could not be created. It stays Only when told." })
    useStore.setState({ turnPulse: { T2: { tool: null, lastAt: 1, ended: 'done', said: 'ok' } } })
    render(<FirstMeeting agent={agent({ control: 'told' })} />)
    await waitFor(() => expect(screen.getByTestId('first-control')).toHaveTextContent("Ana's territory is off"))
    expect(screen.getByTestId('first-control')).not.toHaveTextContent('Every Monday')
  })
  it("a turn that can't start says why, with its door — never a mute screen", async () => {
    mockedApi.chat.mockRejectedValue(new Error("Ana's account is at its usage limit — it goes at 14:00"))
    startFirstMeeting({ agentId: 'ana' })
    render(<FirstMeeting agent={agent()} />)
    expect(await screen.findByTestId('first-failed')).toHaveTextContent("Ana's account is at its usage limit — it goes at 14:00")
  })
  // its first minute offers context — files and skills — optional, in place
  it('«Give it something to work with»: an available skill is added (a held one turned back on); nothing is forced', async () => {
    const catalog = vi.spyOn(knowsDoors, 'catalog').mockResolvedValue([
      { name: 'pdf', description: 'Read and fill PDFs.', state: 'available', source: 'silos' },
      { name: 'notes', description: 'Keep notes.', state: 'held', source: 'project' },
      { name: 'already', state: 'active', source: 'project' },
    ])
    const state = vi.spyOn(knowsDoors, 'skillState').mockResolvedValue([])
    startFirstMeeting({ agentId: 'ana' })
    render(<FirstMeeting agent={agent({ mission: undefined, control: 'told' })} />)
    await waitFor(() => expect(catalog).toHaveBeenCalled())
    expect(screen.queryByRole('button', { name: /Add already/ })).toBeNull()
    await act(async () => {
      fireEvent.click(await screen.findByRole('button', { name: 'Add pdf' }))
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Add notes' }))
    })
    expect(state).toHaveBeenCalledWith(expect.objectContaining({ id: 'ana' }), 'pdf', 'add')
    expect(state).toHaveBeenCalledWith(expect.objectContaining({ id: 'ana' }), 'notes', 'activate')
    expect(screen.getByTestId('give-context')).toBeInTheDocument()
  })
  // the starting set left the account's tools off in its project: the door
  // lands on the project's Tools at the account's group; all on, no door
  it('«Tools from your Claude account ›» while an account origin is off in its project — landing on its Tools, at the account', async () => {
    vi.spyOn(knowsDoors, 'catalog').mockResolvedValue([])
    mockedApi.folders.loads.mockResolvedValue({
      folder: '/home/u/Silos/ana',
      engines: [],
      rows: [],
      logins: [],
      notes: [],
      origins: [
        { id: 'plugins', engine: 'E', on: false, switch: true },
        { id: 'connectors', engine: 'E', on: true, switch: true },
      ],
    })
    startFirstMeeting({ agentId: 'ana' })
    render(<FirstMeeting agent={agent({ mission: undefined, control: 'told' })} />)
    fireEvent.click(await screen.findByTestId('give-account-tools'))
    expect(useStore.getState().page).toEqual({ kind: 'project', folder: '/home/u/Silos/ana' })
    expect(useStore.getState().projectTab).toBe('tools')
    expect(useStore.getState().projectItem).toBe('group:account')
  })
  it('every account origin on in its project: no account door', async () => {
    const catalog = vi.spyOn(knowsDoors, 'catalog').mockResolvedValue([])
    mockedApi.folders.loads.mockResolvedValue({
      folder: '/home/u/Silos/ana',
      engines: [],
      rows: [],
      logins: [],
      notes: [],
      origins: [{ id: 'plugins', engine: 'E', on: true, switch: true }],
    })
    startFirstMeeting({ agentId: 'ana' })
    render(<FirstMeeting agent={agent({ mission: undefined, control: 'told' })} />)
    await waitFor(() => expect(catalog).toHaveBeenCalled())
    await waitFor(() => expect(mockedApi.folders.loads).toHaveBeenCalled())
    expect(screen.queryByTestId('give-account-tools')).toBeNull()
  })
  it('without a mission: it is here, and does what you give it — no turn', () => {
    startFirstMeeting({ agentId: 'ana' })
    render(<FirstMeeting agent={agent({ mission: undefined, control: 'told' })} />)
    expect(screen.getByTestId('first-here')).toHaveTextContent('Ana is here. It does what you give it.')
    expect(mockedApi.chat).not.toHaveBeenCalled()
  })
})
