// runs-on-card.test.tsx — the agent's Settings › Runs on card: the folders
// it works in (and their editor), the fence the engines launch with
// (GET /api/agents/:id/territory), its switch (PUT /api/territory) and the
// token's Rotate action (POST /api/agents/:id/token/rotate).
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { RunsOnCard } from '../src/components/agent/RunsOnCard'
import { useStore } from '../src/store'
import { api } from '../src/lib/api'
import type { AgentView } from '../src/lib/types'

vi.mock('../src/lib/api')
const mockedApi = vi.mocked(api, { deep: true })

const agent = (o: Partial<AgentView> = {}): AgentView => ({
  id: 'builder',
  name: 'Builder',
  emoji: '🛠',
  folder: '/home/u/builder',
  skills: [],
  sessions: [],
  liveCount: 0,
  sessionCount: 0,
  ...o,
})

function mount(a: AgentView, editing = false): void {
  render(<RunsOnCard agent={a} editing={editing} onEditingChange={() => {}} />)
}

beforeEach(() => {
  vi.clearAllMocks()
  useStore.setState({ automations: [], providers: [], agents: [], page: null })
  mockedApi.agents.update.mockResolvedValue(undefined)
  mockedApi.complete.mockResolvedValue([])
  mockedApi.providers.list.mockResolvedValue([])
  mockedApi.overview.mockImplementation(async () => ({ agents: useStore.getState().agents, now: 0, warming: false }))
  mockedApi.agents.territory.mockResolvedValue({ fenced: false, enabled: false, territories: ['/home/u/builder'], privatePaths: 0, deny: 0 })
})

describe('RunsOnCard — territory and token', () => {
  it('an agent with a folder the owner has not enabled: territory off, with the switch to turn it on', async () => {
    mount(agent())
    await waitFor(() => expect(screen.getByTestId('runs-on-territory')).toHaveTextContent(/^Off/))
    expect(screen.getByTestId('runs-on-territory-switch')).toHaveTextContent('Turn on')
  })

  const SCOPE = {
    works: ['~/ci'],
    state: '~/.silos/agent-state/builder',
    readOnly: ['~/ci/context/finance'],
    blocked: [
      { kind: 'silos' as const, paths: ['~/.silos/agents/**'] },
      { kind: 'claude' as const, paths: ['~/.claude.json'] },
      { kind: 'private' as const, paths: ['~/secrets'] },
    ],
  }
  it('a fenced agent: territory on, and what it covers in places — works in, reads only, kept out of, API, commands', async () => {
    mockedApi.agents.territory.mockResolvedValue({ fenced: true, territories: ['/home/u/ci'], privatePaths: 1, deny: 31, scope: SCOPE })
    mount(agent())
    await waitFor(() => expect(screen.getByTestId('runs-on-territory')).toHaveTextContent(/^On/))
    expect(screen.getByTestId('runs-on-territory-switch')).toHaveTextContent('Turn off')
    const scope = await screen.findByTestId('fence-scope')
    expect(screen.getByTestId('runs-on-fence-scope')).toContainElement(scope)
    expect(scope).toHaveTextContent('works in~/ci~/.silos/agent-state/builder')
    expect(scope).toHaveTextContent('reads onlycontext/finance')
    expect(scope).toHaveTextContent("kept out ofSilos' own dataClaude login, settings & memory~/secrets")
    expect(scope).toHaveTextContent('APIas itself')
    expect(scope).toHaveTextContent('commandsa plain cat is held too')
    expect(mockedApi.agents.territory).toHaveBeenCalledWith('builder')
  })

  it('not enabled yet: says it is not fenced and what the fence would keep it out of; no token row', async () => {
    mockedApi.agents.territory.mockResolvedValue({ fenced: false, enabled: false, territories: ['/home/u/ci'], privatePaths: 0, deny: 0, scope: SCOPE })
    mount(agent())
    const off = await screen.findByTestId('fence-scope-off')
    expect(off).toHaveTextContent('~/secrets')
    expect(screen.queryByRole('button', { name: 'Rotate' })).toBeNull()
  })

  it('master: no territory to switch (it works anywhere)', async () => {
    mockedApi.agents.territory.mockResolvedValue({ fenced: false, territories: [], privatePaths: 2, deny: 0 })
    mount(agent({ id: 'master', name: 'Master', folder: null }))
    await waitFor(() => expect(screen.getByTestId('runs-on-territory')).toHaveTextContent(/anywhere/))
    expect(screen.queryByTestId('runs-on-territory-switch')).toBeNull()
    expect(screen.queryByTestId('runs-on-fence-scope')).toBeNull()
  })

  it('Turn on writes the fenced list with this agent added — the others kept — and re-reads its territory', async () => {
    mockedApi.territory.get.mockResolvedValue({ privatePaths: [], enabled: ['ops', 'writer'] })
    mockedApi.territory.setEnabled.mockResolvedValue({ privatePaths: [], enabled: ['ops', 'writer', 'builder'] })
    mount(agent())
    const sw = await screen.findByTestId('runs-on-territory-switch')
    mockedApi.agents.territory.mockResolvedValue({ fenced: true, enabled: true, territories: ['/home/u/builder'], privatePaths: 0, deny: 12 })
    fireEvent.click(sw)
    await waitFor(() => expect(mockedApi.territory.setEnabled).toHaveBeenCalledWith(['ops', 'writer', 'builder']))
    await waitFor(() => expect(screen.getByTestId('runs-on-territory-switch')).toHaveTextContent('Turn off'))
    expect(mockedApi.agents.territory).toHaveBeenCalledTimes(2)
  })

  it('Turn off takes only this agent out of the list', async () => {
    mockedApi.agents.territory.mockResolvedValue({ fenced: true, enabled: true, territories: ['/home/u/builder'], privatePaths: 0, deny: 12 })
    mockedApi.territory.get.mockResolvedValue({ privatePaths: [], enabled: ['ops', 'builder', 'writer'] })
    mockedApi.territory.setEnabled.mockResolvedValue({ privatePaths: [], enabled: ['ops', 'writer'] })
    mount(agent())
    fireEvent.click(await screen.findByTestId('runs-on-territory-switch'))
    await waitFor(() => expect(mockedApi.territory.setEnabled).toHaveBeenCalledWith(['ops', 'writer']))
  })

  it("a refused switch says the server's words and leaves the territory as it was", async () => {
    mockedApi.territory.get.mockResolvedValue({ privatePaths: [], enabled: [] })
    mockedApi.territory.setEnabled.mockRejectedValue(new Error('builder has no folder to fence'))
    mount(agent())
    fireEvent.click(await screen.findByTestId('runs-on-territory-switch'))
    expect(await screen.findByRole('alert')).toHaveTextContent('builder has no folder to fence')
    expect(screen.getByTestId('runs-on-territory-switch')).toHaveTextContent('Turn on')
  })

  it("network and private paths are the roster's: a door to Settings › Territory", async () => {
    mount(agent())
    fireEvent.click(await screen.findByRole('button', { name: /Network and private paths/ }))
    expect(useStore.getState().page).toEqual({ kind: 'settings', tab: 'territory' })
  })

  it('Rotate calls the route and confirms in one line', async () => {
    mockedApi.agents.territory.mockResolvedValue({ fenced: true, territories: ['/home/u/builder'], privatePaths: 2, deny: 10 })
    mockedApi.agents.rotateToken.mockResolvedValue({ rotated: true })
    mount(agent())
    fireEvent.click(await screen.findByRole('button', { name: 'Rotate' }))
    await waitFor(() => expect(screen.getByText(/Rotated — restart its console/)).toBeInTheDocument())
    expect(mockedApi.agents.rotateToken).toHaveBeenCalledWith('builder')
  })

  it('a failed rotate says so', async () => {
    mockedApi.agents.territory.mockResolvedValue({ fenced: true, territories: ['/home/u/builder'], privatePaths: 2, deny: 10 })
    mockedApi.agents.rotateToken.mockRejectedValue(new Error('boom'))
    mount(agent())
    fireEvent.click(await screen.findByRole('button', { name: 'Rotate' }))
    await waitFor(() => expect(screen.getByText(/didn’t rotate/i)).toBeInTheDocument())
  })
})

// folders[] = membership: the card names every folder the agent works in,
// and its editor edits that list (it used to live on the Who card)
describe('RunsOnCard — the folders it works in', () => {
  it('names the primary folder, and the others under «Also works in»', () => {
    mount(agent({ folder: '/home/u/ci', folders: ['/home/u/builder', '/home/u/ops'] }))
    expect(screen.getByTitle('/home/u/ci')).toBeInTheDocument()
    expect(screen.getByText('Also works in')).toBeInTheDocument()
    expect(screen.getByTitle('/home/u/builder')).toBeInTheDocument()
    expect(screen.getByTitle('/home/u/ops')).toBeInTheDocument()
  })
  it('a single folder adds no «Also works in» row', () => {
    mount(agent())
    expect(screen.queryByText('Also works in')).not.toBeInTheDocument()
  })
  it('the editor is seeded one path per line and saves the list as folders[]', async () => {
    mount(agent({ folder: '/home/u/ci', folders: ['/home/u/builder'] }), true)
    const box = screen.getByLabelText('Also works in') as HTMLTextAreaElement
    expect(box.value).toBe('/home/u/builder')
    fireEvent.change(box, { target: { value: '/home/u/builder\n\n  /home/u/ops  \n' } })
    fireEvent.click(screen.getByText('Save'))
    await waitFor(() => expect(mockedApi.agents.update).toHaveBeenCalled())
    expect(mockedApi.agents.update.mock.calls[0]![1]).toMatchObject({ folder: '/home/u/ci', folders: ['/home/u/builder', '/home/u/ops'] })
  })
  it("surfaces the server's folders error under the field", async () => {
    mockedApi.agents.update.mockRejectedValueOnce(new Error('folders must be absolute paths: ops'))
    mount(agent(), true)
    fireEvent.change(screen.getByLabelText('Also works in'), { target: { value: 'ops' } })
    fireEvent.click(screen.getByText('Save'))
    const err = await screen.findByText('folders must be absolute paths: ops')
    expect(err.previousElementSibling).toBe(screen.getByLabelText('Also works in'))
  })
})
