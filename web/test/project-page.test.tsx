// project-page.test.tsx — ProjectPage.tsx — a header plate + the folder's
// tabs, the agent page's nouns: Now · Memory · Files · Skills
// · Tools · Map.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { mungeFolder, resolveProjectFolder, signInAgentOf } from '../src/lib/home'
import { ProjectPage } from '../src/components/ProjectPage'
import { useStore } from '../src/store'
import { api } from '../src/lib/api'
import { MASTER_ID } from '../src/lib/constants'
import type { AgentView, BoardCard, LoadsRow, MemoryLayers, SessionView } from '../src/lib/types'
import { askRow } from './inbox-rows'
import { openNeedsYou } from './home-tiles'

vi.mock('../src/lib/api')
const mockedApi = vi.mocked(api, { deep: true })
// the store's own actions, before any test stands a fake in for one
const REAL_SELECT_AGENT = useStore.getState().selectAgent
const REAL_ASK_SIGN_IN = useStore.getState().askSignIn

function makeAgent(overrides: Partial<AgentView> = {}): AgentView {
  return {
    id: 'a1',
    name: 'Ana',
    emoji: '🧠',

    folder: '/proj',
    skills: [],
    sessions: [],
    liveCount: 0,
    sessionCount: 0,
    ...overrides,
  }
}

function makeSession(overrides: Partial<SessionView> = {}): SessionView {
  return {
    id: 's1',
    folder: 'f',
    title: 'Session',
    skills: [],
    cwd: null,
    mtime: 1_700_000_000_000,
    size: 10,
    turnCount: 1,
    live: false,
    worktree: false,
    native: true,
    agentId: 'a1',
    ...overrides,
  }
}

function makeLayers(overrides: Partial<MemoryLayers> = {}): MemoryLayers {
  return {
    global: { name: 'CLAUDE.md', path: '/home/CLAUDE.md', scope: 'global', mtime: 0, exists: false },
    project: null,
    autoMemory: [],
    agent: null,
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockedApi.memory.list.mockResolvedValue(makeLayers())
  mockedApi.uses.mockResolvedValue({
    rows: [],
    cols: [],
    cells: [],
    sessions: [],
    measure: 'tokens',
    considered: 0,
    truncated: { rows: 0, cols: 0 },
    now: 0,
  } as never)
  // Tools' head and rows read these beside the inventory: nothing checked, nothing measured
  mockedApi.folders.loadsCheck.mockResolvedValue({ targets: [], running: null } as never)
  mockedApi.folders.loadsWeight.mockResolvedValue(null)
  mockedApi.folders.loadsProjected.mockResolvedValue({ key: '', tokens: null })
  useStore.setState({
    agents: [],
    page: { kind: 'project', folder: '/proj' },
    projectTab: 'now',
    nowTick: 1_700_000_000_000,
    projectsPrefs: {},
    modal: null,
    modalFolder: null,
    selectedAgentId: null,
    selected: null,
    askSignIn: REAL_ASK_SIGN_IN,
  })
})

describe('ProjectPage — the header plate', () => {
  it('shows its name under the «Project» crumb (the type word first), the path, and N agents · N conversations', () => {
    useStore.setState({
      agents: [
        makeAgent({
          id: 'a1',
          name: 'Ana',
          folder: '/proj',
          sessionCount: 1,
          counts: { conversations: 1, runs: 0, runsByAutomation: {}, byCwd: {} },
          sessions: [makeSession({ id: 's1', agentId: 'a1' })],
        }),
        makeAgent({ id: 'a2', name: 'Beto', folder: '/proj', sessionCount: 0 }),
      ],
    })
    render(<ProjectPage />)
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('proj')
    expect(screen.getByRole('navigation', { name: 'Where this lives' })).toHaveTextContent('Project')
    expect(screen.getByText('/proj')).toBeInTheDocument()
    expect(screen.getByText('2 agents')).toBeInTheDocument()
    expect(screen.getByText('1 conversation')).toBeInTheDocument()
  })

  // the header once read "147 conversations" — the capped lists'
  // length, runs included. It reads the server's UNCAPPED totals: the
  // project's agents whole plus Anywhere's share inside the folder, runs
  // labelled as runs.
  it('counts from the uncapped totals, Anywhere only inside the folder, runs apart', () => {
    useStore.setState({
      agents: [
        makeAgent({
          id: 'a1',
          folder: '/proj',
          sessions: [makeSession({ id: 's1', agentId: 'a1' })],
          counts: { conversations: 3, runs: 1396, runsByAutomation: { hourly: 1396 }, byCwd: {} },
        }),
        makeAgent({ id: 'a2', name: 'Beto', folder: '/proj', counts: { conversations: 10, runs: 254, runsByAutomation: {}, byCwd: {} } }),
        makeAgent({
          id: 'master',
          name: 'Anywhere',
          folder: null,
          counts: {
            conversations: 9,
            runs: 0,
            runsByAutomation: {},
            byCwd: { '/proj/sub': { conversations: 2, runs: 0 }, '/elsewhere': { conversations: 7, runs: 0 } },
          },
        }),
      ],
    })
    render(<ProjectPage />)
    expect(screen.getByText('15 conversations · 1,650 runs')).toBeInTheDocument()
  })

  it('page is not of kind project: renders nothing', () => {
    useStore.setState({ page: { kind: 'settings' } })
    const { container } = render(<ProjectPage />)
    expect(container).toBeEmptyDOMElement()
  })
})

// the body is the Home scoped to the folder (docs/product.md): its
// agents, its inbox, its pulse — plus the folder's orphans and its pins.
describe('ProjectPage — the scoped Home', () => {
  // an agent with something to say is a tile — the door to its page; one
  // with nothing to say is named in the «Quiet agents» tile
  it("lists the project's agents (not another folder's); a click opens the agent page", () => {
    useStore.setState({
      agents: [
        makeAgent({ id: 'a1', name: 'Ana', folder: '/proj', mission: { text: 'Keeps the design system', never: [], updatedAt: '2026-11-10T09:00:00Z' } }),
        makeAgent({ id: 'a3', name: 'Beto', folder: '/proj' }),
        makeAgent({ id: 'a2', name: 'Zed', folder: '/elsewhere', mission: { text: 'Elsewhere duty', never: [], updatedAt: '2026-11-10T09:00:00Z' } }),
      ],
    })
    render(<ProjectPage />)
    const tiles = screen.getAllByTestId('agent-tile')
    expect(tiles).toHaveLength(1)
    expect(tiles[0]).toHaveTextContent('Ana')
    expect(tiles[0]).toHaveTextContent('Keeps the design system')
    expect(screen.getByTestId('tile-quiet')).toHaveTextContent('Beto')
    expect(screen.queryByText(/Zed/)).not.toBeInTheDocument()
    fireEvent.click(tiles[0]!)
    expect(useStore.getState().page).toEqual({ kind: 'agent', id: 'a1' })
  })

  // orphaned sessions: ones whose agentId==='master' and whose cwd falls
  // inside this folder.
  it('"Conversations without an agent" lists master\'s orphaned sessions in this folder', () => {
    useStore.setState({
      agents: [
        makeAgent({ id: 'a1', name: 'Ana', folder: '/proj' }),
        makeAgent({
          id: MASTER_ID,
          name: 'Master',
          folder: null,
          sessions: [
            makeSession({ id: 'orphan', folder: 'f', title: 'Orphan from this project', cwd: '/proj', agentId: MASTER_ID }),
            makeSession({ id: 'other', folder: 'g', title: 'From another project', cwd: '/other', agentId: MASTER_ID }),
          ],
        }),
      ],
    })
    render(<ProjectPage />)
    expect(screen.getByText('Orphan from this project')).toBeInTheDocument()
    expect(screen.queryByText('From another project')).not.toBeInTheDocument()
    expect(screen.getByText('Just this project')).toBeInTheDocument()
    expect(screen.getByText('Continue with Ana')).toBeInTheDocument()
  })

  it('"Just this project" opens the orphan via master (a real openSession)', async () => {
    const selectAgent = vi.fn()
    mockedApi.sessionDetail.mockResolvedValue({ meta: makeSession({ id: 'orphan', folder: 'f' }), turns: [], total: 0 })
    useStore.setState({
      agents: [
        makeAgent({ id: 'a1', name: 'Ana', folder: '/proj' }),
        makeAgent({
          id: MASTER_ID,
          name: 'Master',
          folder: null,
          sessions: [makeSession({ id: 'orphan', folder: 'f', title: 'Orphan', cwd: '/proj', agentId: MASTER_ID })],
        }),
      ],
      selectAgent,
    })
    render(<ProjectPage />)
    fireEvent.click(screen.getByText('Just this project'))
    expect(selectAgent).toHaveBeenCalledWith(MASTER_ID)
    await waitFor(() => expect(mockedApi.sessionDetail).toHaveBeenCalledWith('f', 'orphan'))
  })

  it('"+ Create an agent for these" (below the orphans) opens the creation modal with the folder prefilled', () => {
    useStore.setState({
      agents: [
        makeAgent({ id: 'a1', name: 'Ana', folder: '/proj' }),
        makeAgent({
          id: MASTER_ID,
          name: 'Master',
          folder: null,
          sessions: [makeSession({ id: 'orphan', folder: 'f', title: 'Orphan', cwd: '/proj', agentId: MASTER_ID })],
        }),
      ],
    })
    render(<ProjectPage />)
    fireEvent.click(screen.getByText('+ Create an agent for these'))
    expect(useStore.getState().modal).toBe('create')
    expect(useStore.getState().modalFolder).toBe('/proj')
  })

  it('"+ agent" (always visible, with no orphans) also opens the creation modal prefilled', () => {
    useStore.setState({ agents: [makeAgent({ id: 'a1', name: 'Ana', folder: '/proj' })] })
    render(<ProjectPage />)
    fireEvent.click(screen.getByText('+ agent'))
    expect(useStore.getState().modal).toBe('create')
    expect(useStore.getState().modalFolder).toBe('/proj')
  })
})

// the project is the house of what the FOLDER owns:
// the folder's tabs — the same nouns, in the same order, as the agent page:
// the folder's shared memory, its files, the skills and the MCP servers and
// plugins every conversation started in it loads, its map. Never «Skills &
// tools», never Infra.
describe("ProjectPage — the folder's tabs", () => {
  const tabs = (): HTMLElement => screen.getByRole('navigation', { name: 'Project sections' })
  const tab = (label: string): HTMLElement => within(tabs()).getByRole('button', { name: label })
  const loads = (list: LoadsRow[]) => ({ folder: '/proj', engines: [{ id: 'claude-code', label: 'Claude Code' }], rows: list, logins: [], notes: [] })
  const DRAFT = 'Sign me in to the MCP server "plugin:research:webstats".'
  const lr = (over: Partial<LoadsRow> & Pick<LoadsRow, 'key' | 'kind' | 'name'>): LoadsRow => ({
    engine: 'Claude Code',
    label: over.name,
    exact: true,
    origin: { owner: 'project', carrier: '.mcp.json' },
    state: 'active',
    ...over,
  })

  it('Now · Memory · Files · Skills · Tools · Map, landing on Now', () => {
    useStore.setState({ agents: [makeAgent({ id: 'a1', name: 'Ana', folder: '/proj' })] })
    render(<ProjectPage />)
    expect(
      within(tabs())
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['Now', 'Memory', 'Files', 'Skills', 'Tools', 'Map'])
    expect(tab('Now')).toHaveAttribute('aria-current', 'page')
    expect(screen.getByTestId('pulse')).toBeInTheDocument()
  })

  it('a tab writes projectTab by its own name', () => {
    useStore.setState({ agents: [makeAgent({ id: 'a1', name: 'Ana', folder: '/proj' })] })
    render(<ProjectPage />)
    for (const [label, projectTab] of [
      ['Memory', 'memory'],
      ['Files', 'files'],
      ['Skills', 'skills'],
      ['Tools', 'tools'],
      ['Map', 'map'],
      ['Now', 'now'],
    ] as const) {
      fireEvent.click(tab(label))
      expect(useStore.getState().projectTab).toBe(projectTab)
      expect(tab(label)).toHaveAttribute('aria-current', 'page')
    }
  })

  it("Memory: the folder's whole memory read for the FOLDER itself (no agent layer), who learned each note, and the agents it reaches", async () => {
    mockedApi.memory.list.mockResolvedValue(
      makeLayers({
        autoMemory: [
          { name: 'deploy_flow.md', path: '/m/deploy_flow.md', scope: 'project', mtime: 1, exists: true, description: 'how we ship', author: 'a1' },
          { name: 'billing_rules.md', path: '/m/billing_rules.md', scope: 'project', mtime: 1, exists: true, description: 'the rules' },
        ],
      }),
    )
    useStore.setState({
      agents: [
        makeAgent({ id: 'a1', name: 'Ana', folder: '/proj' }),
        makeAgent({ id: 'a2', name: 'Beto', folder: '/proj' }),
        makeAgent({ id: 'z', name: 'Zed', folder: '/elsewhere' }),
      ],
    })
    render(<ProjectPage />)
    fireEvent.click(tab('Memory'))
    await waitFor(() => expect(mockedApi.memory.list).toHaveBeenCalledWith('/proj'))
    expect(mockedApi.memory.list).not.toHaveBeenCalledWith('/proj', 'a1')
    expect(screen.getByText(/This memory reaches every agent that starts in this folder/)).toHaveTextContent(
      '— Ana · Beto. Only new conversations pick up a change.',
    )
    expect(screen.queryByText(/Zed/)).not.toBeInTheDocument()
    expect(await screen.findByText(/Silos knows who learned 1 of 2 notes/)).toBeInTheDocument()
    // every note of the folder, not one agent's share — the author said
    expect((await screen.findAllByText('Deploy flow')).length).toBeGreaterThan(0)
    expect(screen.getAllByText('Billing rules').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Ana · how we ship').length).toBeGreaterThan(0)
    // authorship is a facet, never ownership: who learned it, and who is unknown
    expect(screen.getByRole('button', { name: /^learned by Ana 1$/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^author unknown 1$/ })).toBeInTheDocument()
  })

  it("Memory: your CLAUDE.md carries the engine's per-project switch — off, then on, acting on the folder; no engine switch, no button", async () => {
    const eng = (state: 'on' | 'off') => ({
      folder: '/proj',
      engines: [{ id: 'claude-code', label: 'Claude Code', state, entries: ['/home/user/.claude/CLAUDE.md'], logins: 1, rules: false }],
    })
    mockedApi.memory.list.mockResolvedValue(
      makeLayers({ global: { name: 'CLAUDE.md', path: '/home/user/.claude/CLAUDE.md', scope: 'global', mtime: 0, exists: true, size: 400 } }),
    )
    mockedApi.folders.personal.mockResolvedValue(eng('on'))
    mockedApi.folders.personalSwitch.mockResolvedValueOnce(eng('off')).mockResolvedValueOnce(eng('on'))
    useStore.setState({ agents: [makeAgent({ id: 'a1', name: 'Ana', folder: '/proj' })], projectTab: 'memory' })
    render(<ProjectPage />)
    await waitFor(() => expect(mockedApi.folders.personal).toHaveBeenCalledWith('/proj'))
    fireEvent.click(await screen.findByRole('button', { name: 'Turn off' }))
    await waitFor(() => expect(mockedApi.folders.personalSwitch).toHaveBeenCalledWith('/proj', 'off'))
    fireEvent.click(await screen.findByRole('button', { name: 'Turn on' }))
    await waitFor(() => expect(mockedApi.folders.personalSwitch).toHaveBeenLastCalledWith('/proj', 'on'))
  })

  it("Memory: ▾ opens where your CLAUDE.md loads — the project line writes the folder's file, an agent line only that agent (spec scopes T10)", async () => {
    const at = [
      { place: 'machine', result: 'on', door: { word: 'Settings', where: 'Settings › Memories' } },
      { place: 'project', result: 'on', keptIn: '.claude/settings.local.json', switch: { names: ['/home/user/.claude/CLAUDE.md'] } },
      { place: 'agent', agent: 'a1', agentName: 'Ana', result: 'on', switch: { names: ['/home/user/.claude/CLAUDE.md'] } },
    ]
    const fp = {
      folder: '/proj',
      engines: [{ id: 'claude-code', label: 'Claude Code', state: 'on' as const, entries: ['/home/user/.claude/CLAUDE.md'], logins: 1, rules: false, at }],
    }
    mockedApi.memory.list.mockResolvedValue(
      makeLayers({ global: { name: 'CLAUDE.md', path: '/home/user/.claude/CLAUDE.md', scope: 'global', mtime: 0, exists: true, size: 400 } }),
    )
    mockedApi.folders.personal.mockResolvedValue(fp as never)
    mockedApi.folders.personalSwitch.mockResolvedValue(fp as never)
    mockedApi.folders.personalSwitchAt.mockResolvedValue(fp as never)
    useStore.setState({ agents: [makeAgent({ id: 'a1', name: 'Ana', folder: '/proj' })], projectTab: 'memory' })
    render(<ProjectPage />)
    fireEvent.click((await screen.findAllByRole('button', { name: /^Where .* loads$/ }))[0]!)
    const block = await screen.findByTestId('where-it-loads')
    fireEvent.click(within(block).getByTestId('line-switch'))
    await waitFor(() => expect(mockedApi.folders.personalSwitchAt).toHaveBeenCalledWith('/proj', 'off', { scope: 'agent', agent: 'a1' }))
    fireEvent.click(within(block).getByTestId('place-switch-project'))
    await waitFor(() => expect(mockedApi.folders.personalSwitch).toHaveBeenCalledWith('/proj', 'off'))
    // the machine line is the file itself: a door, never a switch
    expect(within(block).queryByTestId('place-switch-machine')).not.toBeInTheDocument()
  })

  it('Memory: an engine without the switch leaves your CLAUDE.md a fact', async () => {
    mockedApi.memory.list.mockResolvedValue(
      makeLayers({ global: { name: 'CLAUDE.md', path: '/home/user/.claude/CLAUDE.md', scope: 'global', mtime: 0, exists: true, size: 400 } }),
    )
    mockedApi.folders.personal.mockResolvedValue({ folder: '/proj', engines: [] })
    useStore.setState({ agents: [makeAgent({ id: 'a1', name: 'Ana', folder: '/proj' })], projectTab: 'memory' })
    render(<ProjectPage />)
    await waitFor(() => expect(mockedApi.folders.personal).toHaveBeenCalledWith('/proj'))
    await screen.findAllByText('Your personal instructions')
    expect(screen.queryByRole('button', { name: /^Turn (off|on)$/ })).not.toBeInTheDocument()
  })

  it('Memory with no agent in the folder says so honestly — nothing borrowed, a door to create one', async () => {
    useStore.setState({
      agents: [makeAgent({ id: MASTER_ID, name: 'Master', folder: null, sessions: [makeSession({ id: 'm', cwd: '/proj', agentId: MASTER_ID })] })],
      projectTab: 'memory',
    })
    render(<ProjectPage />)
    expect(screen.getByText('No agent works in this folder itself.')).toBeInTheDocument()
    expect(mockedApi.memory.list).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '+ Create an agent in this folder' }))
    expect(useStore.getState().modal).toBe('create')
  })

  it('Skills: switching a skill acts on the folder itself and names who it reaches', async () => {
    mockedApi.folders.skillsCatalog.mockResolvedValue([
      { name: 'team-plan', description: 'plan work', source: 'project', state: 'active' },
      { name: 'heartbeat', description: 'beat', source: 'project', state: 'held' },
    ])
    mockedApi.folders.skillState.mockResolvedValue([])
    useStore.setState({
      agents: [makeAgent({ id: 'a2', name: 'Beto', folder: '/proj/sub', folders: [] }), makeAgent({ id: 'a1', name: 'Ana', folder: '/proj' })],
    })
    render(<ProjectPage />)
    fireEvent.click(tab('Skills'))
    // Beto starts in /proj/sub: a /proj skill never reaches it
    expect(screen.getByTestId('switch-reach')).toHaveTextContent('— Ana.')
    await waitFor(() => expect(mockedApi.folders.skillsCatalog).toHaveBeenCalledWith('/proj'))
    fireEvent.click(await screen.findByRole('button', { name: 'Turn off' }))
    await waitFor(() => expect(mockedApi.folders.skillState).toHaveBeenCalledWith('/proj', 'team-plan', 'hold'))
    fireEvent.click(screen.getByRole('button', { name: 'Turn on' }))
    await waitFor(() => expect(mockedApi.folders.skillState).toHaveBeenCalledWith('/proj', 'heartbeat', 'activate'))
    // never through an agent route
    expect(mockedApi.skillsCatalog).not.toHaveBeenCalled()
    expect(mockedApi.agents.skillState).not.toHaveBeenCalled()
  })

  it('Skills: account and personal skills take a position here; adding one while the account is off says what stays off first; the head turns it all on', async () => {
    const origin = { on: false, switches: true as const }
    mockedApi.folders.skillsCatalog.mockResolvedValue([
      { name: 'vps-notes', source: 'user', state: 'active', switches: true },
      { name: 'brief', source: 'account', state: 'available', account: { login: 'sam@example.com' }, switches: true, origin },
      { name: 'digest', source: 'account', state: 'available', account: { login: 'sam@example.com' }, switches: true, origin },
    ])
    mockedApi.folders.skillPosition.mockResolvedValue([])
    mockedApi.folders.skillsOrigin.mockResolvedValue([])
    useStore.setState({ agents: [makeAgent({ id: 'a1', name: 'Ana', folder: '/proj' })], projectTab: 'skills' })
    render(<ProjectPage />)
    await waitFor(() => expect(mockedApi.folders.skillsCatalog).toHaveBeenCalledWith('/proj'))
    const personal = await screen.findByRole('radiogroup', { name: 'vps-notes in this project' })
    fireEvent.click(within(personal).getByRole('radio', { name: 'name only' }))
    await waitFor(() => expect(mockedApi.folders.skillPosition).toHaveBeenCalledWith('/proj', 'vps-notes', 'personal', 'name-only'))
    // the account's skills are off here: picking «on» for one asks first, then adds only it
    const brief = screen.getByRole('radiogroup', { name: 'brief in this project' })
    fireEvent.click(within(brief).getByRole('radio', { name: 'on' }))
    expect(mockedApi.folders.skillPosition).not.toHaveBeenCalledWith('/proj', 'brief', 'account', 'on')
    fireEvent.click(within(screen.getByTestId('switch-confirm')).getByRole('button', { name: 'Turn on' }))
    await waitFor(() => expect(mockedApi.folders.skillPosition).toHaveBeenCalledWith('/proj', 'brief', 'account', 'on'))
    fireEvent.click(screen.getByRole('button', { name: 'Turn all on in this project' }))
    await waitFor(() => expect(mockedApi.folders.skillsOrigin).toHaveBeenCalledWith('/proj', 'on'))
  })

  it("Skills: «Where it loads» — an agent line picks for that agent only, the machine's «off» asks first, the project line is the page's own; a locked line reads", async () => {
    const at = [
      { place: 'machine', result: 'on', keptIn: '~/.claude/settings.json', positions: ['on', 'name-only', 'off'] },
      { place: 'project', result: 'on', keptIn: '.claude/settings.local.json', positions: ['on', 'name-only', 'off'] },
      { place: 'agent', agent: 'a1', agentName: 'Ana', result: 'on', positions: ['on', 'name-only', 'off'] },
    ]
    mockedApi.folders.skillsCatalog.mockResolvedValue([
      { name: 'vps-notes', source: 'user', state: 'active', switches: true, at },
      {
        name: 'brainstorm',
        source: 'plugin',
        state: 'active',
        plugin: 'superpowers@x',
        at: [{ place: 'machine', result: 'on', locked: { why: 'engine', reason: 'plugin' } }],
      },
    ] as never)
    mockedApi.folders.skillPositionAt.mockResolvedValue({ skills: [] })
    mockedApi.folders.skillPosition.mockResolvedValue([])
    useStore.setState({ agents: [makeAgent({ id: 'a1', name: 'Ana', folder: '/proj' })], projectTab: 'skills' })
    render(<ProjectPage />)
    fireEvent.click(await screen.findByRole('button', { name: 'Where vps-notes loads' }))
    const block = screen.getByTestId('skill-places')
    fireEvent.click(within(within(block).getByRole('radiogroup', { name: 'vps-notes for Ana only' })).getByRole('radio', { name: 'name only' }))
    await waitFor(() =>
      expect(mockedApi.folders.skillPositionAt).toHaveBeenCalledWith('/proj', 'vps-notes', 'personal', 'name-only', { scope: 'agent', agent: 'a1' }),
    )
    fireEvent.click(within(within(block).getByRole('radiogroup', { name: 'vps-notes — this machine' })).getByRole('radio', { name: 'off' }))
    expect(mockedApi.folders.skillPositionAt).toHaveBeenCalledTimes(1)
    fireEvent.click(within(within(block).getByTestId('machine-confirm')).getByRole('button', { name: 'Turn off on this machine' }))
    await waitFor(() => expect(mockedApi.folders.skillPositionAt).toHaveBeenCalledWith('/proj', 'vps-notes', 'personal', 'off', { scope: 'machine' }))
    fireEvent.click(within(within(block).getByRole('radiogroup', { name: 'vps-notes — project · proj' })).getByRole('radio', { name: 'off' }))
    await waitFor(() => expect(mockedApi.folders.skillPosition).toHaveBeenCalledWith('/proj', 'vps-notes', 'personal', 'off'))
    // a plugin's skill: its lines read, no position to pick
    fireEvent.click(screen.getByRole('button', { name: 'Where brainstorm loads' }))
    const blocks = screen.getAllByTestId('skill-places')
    expect(within(blocks[blocks.length - 1]!).queryAllByRole('radiogroup')).toHaveLength(0)
  })

  // third review round, defect 1: a member only through folders[] (its
  // primary folder elsewhere) once lent ITS folder's skills to this page
  it("a folders[]-only member never lends its own folder: the catalog and the switches are the folder's", async () => {
    mockedApi.folders.skillsCatalog.mockResolvedValue([{ name: 'f-skill', source: 'project', state: 'active' }])
    mockedApi.folders.skillState.mockResolvedValue([])
    useStore.setState({ agents: [makeAgent({ id: 'v', name: 'Visitor', folder: '/elsewhere', folders: ['/proj'] })], projectTab: 'skills' })
    render(<ProjectPage />)
    await waitFor(() => expect(mockedApi.folders.skillsCatalog).toHaveBeenCalledWith('/proj'))
    expect(screen.getByText(/no agent starts here yet/)).toBeInTheDocument()
    fireEvent.click(await screen.findByRole('button', { name: 'Turn off' }))
    await waitFor(() => expect(mockedApi.folders.skillState).toHaveBeenCalledWith('/proj', 'f-skill', 'hold'))
    expect(mockedApi.skillsCatalog).not.toHaveBeenCalled()
    expect(mockedApi.agents.skillState).not.toHaveBeenCalled()
  })

  it('an agent nested inside the folder never lends its skills or tools: honest words and a door to ITS project', async () => {
    useStore.setState({ agents: [makeAgent({ id: 'w', name: 'WebDev', folder: '/proj/web' })], projectTab: 'tools' })
    render(<ProjectPage />)
    expect(screen.getByText('No agent works in this folder itself.')).toBeInTheDocument()
    expect(mockedApi.folders.loads).not.toHaveBeenCalled()
    expect(mockedApi.folders.skillsCatalog).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '/proj/web ›' }))
    expect(useStore.getState().page).toEqual({ kind: 'project', folder: '/proj/web' })
  })

  it("Skills: the folder's skills carry their switch, yours never — your machine's door says it is the inventory", async () => {
    mockedApi.folders.skillsCatalog.mockResolvedValue([
      { name: 'team-plan', description: 'plan work', source: 'project', state: 'active' },
      { name: 'deploy', description: 'ship it', source: 'user', state: 'active' },
      { name: 'superpowers:brainstorming', source: 'plugin', state: 'active' },
    ])
    useStore.setState({
      agents: [makeAgent({ id: 'a1', name: 'Ana', folder: '/proj' }), makeAgent({ id: 'a2', name: 'Beto', folder: '/proj' })],
      projectTab: 'skills',
    })
    render(<ProjectPage />)
    const project = await screen.findByRole('region', { name: 'From Project · proj' })
    expect(within(project).getByRole('button', { name: 'Turn off' })).toBeInTheDocument()
    const you = screen.getByRole('region', { name: 'From This machine' })
    expect(within(you).getByText('deploy')).toBeInTheDocument()
    expect(within(you).queryByRole('button', { name: /^(Turn off|Turn on|Add)$/ })).toBeNull()
    fireEvent.click(within(within(you).getByTestId('owner-header')).getByRole('button', { name: 'Inventory ›' }))
    expect(useStore.getState().page).toEqual({ kind: 'settings', tab: 'skills' })
  })

  it("Tools: the folder's servers are its own and switched here; your ~/.claude.json servers are a fact; plugins switch per folder", async () => {
    mockedApi.folders.loads.mockResolvedValue(
      loads([
        lr({
          key: 'plugin:superpowers@official',
          kind: 'plugin',
          name: 'superpowers@official',
          label: 'superpowers',
          origin: { owner: 'you', carrier: 'superpowers plugin' },
          switch: { names: ['superpowers@official'] },
        }),
        lr({ key: 'mcp:project:railway', kind: 'mcp', name: 'railway', detail: 'https://rw.example', switch: { names: ['railway'] } }),
        lr({ key: 'mcp:user:linear', kind: 'mcp', name: 'linear', origin: { owner: 'you', carrier: '~/.claude.json' } }),
      ]),
    )
    mockedApi.folders.loadsSwitch.mockResolvedValue({ folder: '/proj', ok: true })
    useStore.setState({ agents: [makeAgent({ id: 'a1', name: 'Ana', folder: '/proj' })], projectTab: 'tools' })
    render(<ProjectPage />)
    const project = await screen.findByRole('region', { name: 'From Project · proj' })
    expect(mockedApi.folders.loads).toHaveBeenCalledWith('/proj')
    fireEvent.click(within(project).getByRole('button', { name: 'Turn off' }))
    await waitFor(() => expect(mockedApi.folders.loadsSwitch).toHaveBeenCalledWith('/proj', 'mcp:project:railway', 'off'))
    const you = screen.getByRole('region', { name: 'From This machine' })
    // the plugin is switched here (the folder's settings decide it), the machine's server never
    expect(within(you).getAllByRole('button', { name: 'Turn off' })).toHaveLength(1)
  })

  it('Tools: a row another file or managed settings decide gets no switch; the account groups by login; a plugin unfolds to its servers', async () => {
    mockedApi.folders.loads.mockResolvedValue(
      loads([
        lr({
          key: 'mcp:project:github',
          kind: 'mcp',
          name: 'github',
          state: 'held',
          decidedBy: { file: '.claude/settings.json', key: 'disabledMcpjsonServers' },
        }),
        lr({
          key: 'plugin:team-plan@silos',
          kind: 'plugin',
          name: 'team-plan@silos',
          origin: { owner: 'you', carrier: 'team-plan plugin' },
          decidedBy: { file: 'managed settings', key: 'enabledPlugins.team-plan@silos' },
        }),
        lr({
          key: 'plugin:acc:design@synced',
          kind: 'plugin',
          name: 'design@synced',
          label: 'design',
          origin: { owner: 'account', carrier: 'design plugin', login: 'sam@example.com' },
        }),
        lr({
          key: 'server:acc:design@synced:files',
          kind: 'mcp',
          name: 'plugin:design:files',
          label: 'files',
          parent: 'plugin:acc:design@synced',
          origin: { owner: 'account', carrier: 'design plugin', login: 'sam@example.com' },
        }),
        lr({
          key: 'plugin:acc2:ops@synced',
          kind: 'plugin',
          name: 'ops@synced',
          label: 'ops',
          state: 'available',
          origin: { owner: 'account', carrier: 'ops plugin', login: 'kai@example.com' },
        }),
      ]),
    )
    useStore.setState({ agents: [makeAgent({ id: 'a1', name: 'Ana', folder: '/proj' })], projectTab: 'tools' })
    render(<ProjectPage />)
    const sam = await screen.findByRole('region', { name: 'From Your Claude account · sam@example.com' })
    expect(screen.getByRole('region', { name: 'From Your Claude account · kai@example.com' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Turn (on|off)$/ })).toBeNull()
    // the plugin's server is under it, folded until asked
    expect(within(sam).queryByText('files')).toBeNull()
    fireEvent.click(within(sam).getByRole('button', { name: /Unfold design/ }))
    expect(within(sam).getByText('files')).toBeInTheDocument()
  })

  // spec scopes §4 (T3): «Only <agent>» — the agent's line in «Where it
  // loads» switches that agent alone; a line held wider has no switch
  it("Tools: an agent's line switches that agent only; a line a wider place locks has no switch", async () => {
    const at = (l: object[]) => [
      { place: 'machine', result: 'on', keptIn: '~/.claude/settings.json' },
      { place: 'project', result: 'on', keptIn: '.claude/settings.local.json' },
      ...l,
    ]
    mockedApi.folders.loads.mockResolvedValue(
      loads([
        lr({
          key: 'mcp:project:railway',
          kind: 'mcp',
          name: 'railway',
          switch: { names: ['railway'] },
          family: 'off-only',
          at: at([
            { place: 'agent', agent: 'a1', agentName: 'Ana', result: 'on', switch: { names: ['railway'] } },
            { place: 'agent', agent: 'a2', agentName: 'Beto', result: 'off', locked: { why: 'wider', at: 'machine' } },
          ]),
        } as never),
      ]),
    )
    mockedApi.folders.loadsSwitch.mockResolvedValue({ folder: '/proj', ok: true })
    useStore.setState({
      agents: [makeAgent({ id: 'a1', name: 'Ana', folder: '/proj' }), makeAgent({ id: 'a2', name: 'Beto', folder: '/proj' })],
      projectTab: 'tools',
    })
    render(<ProjectPage />)
    const project = await screen.findByRole('region', { name: 'From Project · proj' })
    fireEvent.click(within(project).getByRole('button', { name: 'Where railway loads' }))
    const block = within(project).getByTestId('where-it-loads')
    const switches = within(block).getAllByRole('switch')
    expect(switches).toHaveLength(1)
    fireEvent.click(switches[0]!)
    await waitFor(() => expect(mockedApi.folders.loadsSwitch).toHaveBeenCalledWith('/proj', 'mcp:project:railway', 'off', 'a1'))
    expect(mockedApi.folders.loadsSwitch).toHaveBeenCalledTimes(1)
  })

  // spec scopes §9 (T13): an engine whose project place is carried at
  // launch — its project line writes that place (Silos keeps it), a machine
  // line whose file can't be rewritten has no switch and names the file
  it("Tools: an engine that carries the project at launch — its project line switches the project; a machine file it won't rewrite has no switch", async () => {
    mockedApi.folders.loads.mockResolvedValue({
      folder: '/proj',
      rows: [
        lr({
          key: 'mcp:project:github',
          kind: 'mcp',
          name: 'github',
          engine: 'OpenCode',
          origin: { owner: 'project', carrier: 'opencode.json' },
          switch: { names: ['github'] },
          family: 'override',
          at: [
            {
              place: 'machine',
              result: 'on',
              keptIn: '~/.config/opencode/opencode.jsonc',
              refused: { why: 'file', reason: '~/.config/opencode/opencode.jsonc is not plain JSON (comments?)' },
            },
            { place: 'project', result: 'on', switch: { names: ['github'] } },
            { place: 'agent', agent: 'a1', agentName: 'Ana', result: 'on', switch: { names: ['github'] } },
          ],
        } as never),
      ],
      logins: [],
      notes: [],
      engines: [
        {
          id: 'opencode',
          label: 'OpenCode',
          switches: true,
          scopes: [
            { id: 'machine', carrier: 'file', keptIn: '~/.config/opencode/opencode.json' },
            { id: 'project', carrier: 'launch' },
            { id: 'agent', carrier: 'launch' },
            { id: 'conversation', carrier: 'launch' },
          ],
        },
      ],
    } as never)
    mockedApi.folders.loadsSwitchAt.mockResolvedValue({ folder: '/proj', ok: true } as never)
    useStore.setState({ agents: [makeAgent({ id: 'a1', name: 'Ana', folder: '/proj', framework: 'opencode' } as never)], projectTab: 'tools' })
    render(<ProjectPage />)
    const project = await screen.findByRole('region', { name: 'From Project · proj' })
    fireEvent.click(within(project).getByRole('button', { name: 'Where github loads' }))
    const block = within(project).getByTestId('where-it-loads')
    expect(block.querySelector('[data-place="machine"] [role="switch"]')).toBeNull()
    expect(within(block).getByTestId('line-refused')).toBeInTheDocument()
    fireEvent.click(block.querySelector('[data-place="project"] [role="switch"]')!)
    await waitFor(() => expect(mockedApi.folders.loadsSwitchAt).toHaveBeenCalledWith('/proj', 'mcp:project:github', 'off', 'project'))
  })

  it('Tools: a server several plugins ship asks before the click, then switches every copy by its row; Keep writes nothing', async () => {
    const plug = (p: string) =>
      lr({
        key: `plugin:${p}@market`,
        kind: 'plugin',
        name: `${p}@market`,
        label: p,
        origin: { owner: 'you', carrier: `${p} plugin` },
        switch: { names: [`${p}@market`] },
      })
    const names = ['plugin:alpha:mail', 'plugin:beta:mail', 'plugin:gamma:mail']
    const server = (p: string) =>
      lr({
        key: `server:${p}@market:mail`,
        kind: 'mcp',
        name: `plugin:${p}:mail`,
        label: 'mail',
        parent: `plugin:${p}@market`,
        origin: { owner: 'you', carrier: `${p} plugin` },
        switch: { names, reaches: ['alpha', 'beta', 'gamma'].filter((x) => x !== p).map((x) => `server:${x}@market:mail`) },
      })
    mockedApi.folders.loads.mockResolvedValue(loads([plug('alpha'), plug('beta'), plug('gamma'), server('alpha'), server('beta'), server('gamma')]))
    mockedApi.folders.loadsSwitch.mockResolvedValue({ folder: '/proj', ok: true })
    useStore.setState({ agents: [makeAgent({ id: 'a1', name: 'Ana', folder: '/proj' })], projectTab: 'tools' })
    render(<ProjectPage />)
    const you = await screen.findByRole('region', { name: 'From This machine' })
    fireEvent.click(within(you).getByRole('button', { name: /Unfold beta/ }))
    const rows = within(you)
      .getAllByRole('listitem')
      .filter((li) => li.textContent?.includes('mail'))
    fireEvent.click(within(rows[0]!).getByRole('button', { name: 'Turn off' }))
    // nothing is written before the confirmation
    expect(mockedApi.folders.loadsSwitch).not.toHaveBeenCalled()
    const confirm = within(you).getByTestId('switch-confirm')
    fireEvent.click(within(confirm).getByRole('button', { name: 'Keep' }))
    expect(within(you).queryByTestId('switch-confirm')).toBeNull()
    fireEvent.click(within(rows[0]!).getByRole('button', { name: 'Turn off' }))
    fireEvent.click(within(within(you).getByTestId('switch-confirm')).getAllByRole('button')[0]!)
    await waitFor(() => expect(mockedApi.folders.loadsSwitch).toHaveBeenCalledWith('/proj', 'server:beta@market:mail', 'off'))
  })

  // spec tools-origin §7 rule 4 (T10): «Add» from an origin that is off asks
  // first, then switches only its row; each head writes the origin alone
  it("Tools: the account groups carry their origins' heads; «Add» from an origin that is off asks first, then adds only that row", async () => {
    const acct = (kind: 'plugin' | 'connector', label: string) =>
      lr({
        key: `${kind}:sam@example.com:${label}`,
        kind,
        name: kind === 'plugin' ? `${label}@synced` : `claude.ai ${label}`,
        label,
        state: 'available',
        origin: { owner: 'account', carrier: kind === 'plugin' ? `${label} plugin` : 'connector', login: 'sam@example.com' },
        switch: { names: [label] },
      })
    mockedApi.folders.loads.mockResolvedValue({
      ...loads([acct('plugin', 'design'), acct('plugin', 'docs'), acct('connector', 'Gmail'), acct('connector', 'Drive')]),
      origins: [
        { id: 'plugins', engine: 'Claude Code', on: false, switch: true },
        { id: 'connectors', engine: 'Claude Code', on: true, switch: true },
      ],
    })
    mockedApi.folders.loadsSwitch.mockResolvedValue({ folder: '/proj', ok: true })
    mockedApi.folders.loadsOrigin.mockResolvedValue({ folder: '/proj', ok: true })
    useStore.setState({ agents: [makeAgent({ id: 'a1', name: 'Ana', folder: '/proj' })], projectTab: 'tools' })
    render(<ProjectPage />)
    const sam = await screen.findByRole('region', { name: 'From Your Claude account · sam@example.com' })
    const plugins = within(sam).getByTestId('origin-plugins')
    const design = within(sam)
      .getAllByRole('listitem')
      .find((li) => li.textContent?.startsWith('design'))!
    fireEvent.click(within(design).getByRole('button', { name: 'Add' }))
    expect(mockedApi.folders.loadsSwitch).not.toHaveBeenCalled()
    fireEvent.click(within(within(sam).getByTestId('switch-confirm')).getByRole('button', { name: 'Add' }))
    await waitFor(() => expect(mockedApi.folders.loadsSwitch).toHaveBeenCalledWith('/proj', 'plugin:sam@example.com:design', 'on'))
    // with its origin on, a connector's «Add» needs no question
    const gmail = within(sam)
      .getAllByRole('listitem')
      .find((li) => li.textContent?.startsWith('Gmail'))!
    fireEvent.click(within(gmail).getByRole('button', { name: 'Add' }))
    await waitFor(() => expect(mockedApi.folders.loadsSwitch).toHaveBeenCalledWith('/proj', 'connector:sam@example.com:Gmail', 'on'))
    fireEvent.click(within(plugins).getByRole('button', { name: 'Turn all on in this project' }))
    await waitFor(() => expect(mockedApi.folders.loadsOrigin).toHaveBeenCalledWith('/proj', 'plugins', 'on'))
    fireEvent.click(within(within(sam).getByTestId('origin-connectors')).getByRole('button', { name: 'Turn all off in this project' }))
    await waitFor(() => expect(mockedApi.folders.loadsOrigin).toHaveBeenCalledWith('/proj', 'connectors', 'off'))
  })

  it('Tools: a refused switch has no button — an engine too old offers Update ›, landing on Settings › Engines', async () => {
    mockedApi.folders.loads.mockResolvedValue(
      loads([
        lr({
          key: 'mcp:user:linear',
          kind: 'mcp',
          name: 'linear',
          origin: { owner: 'you', carrier: '~/.claude.json' },
          refused: { why: 'engine', needs: '2.1.330' },
        }),
        lr({ key: 'mcp:project:railway', kind: 'mcp', name: 'railway', refused: { why: 'home' } }),
      ]),
    )
    useStore.setState({ agents: [makeAgent({ id: 'a1', name: 'Ana', folder: '/proj' })], projectTab: 'tools' })
    render(<ProjectPage />)
    const you = await screen.findByRole('region', { name: 'From This machine' })
    expect(screen.queryByRole('button', { name: /^Turn (on|off)$/ })).toBeNull()
    fireEvent.click(within(you).getByRole('button', { name: /Update ›/ }))
    expect(useStore.getState().page).toEqual({ kind: 'settings', tab: 'engines' })
    expect(mockedApi.folders.loadsSwitch).not.toHaveBeenCalled()
  })

  // the dead door (spec tools-origin §9): a door names the row KEY the
  // inventory made — of a plugin installed here (held) and the same plugin
  // the Claude account sends (the copy that loads), the key opens THAT copy;
  // a bare plugin name opens nothing (no fallback by name)
  it('a door that names a row key lands on the tab with that very row open — never a namesake copy', async () => {
    mockedApi.folders.loads.mockResolvedValue(
      loads([
        lr({
          key: 'plugin:research@market',
          kind: 'plugin',
          name: 'research@market',
          label: 'research',
          state: 'held',
          detail: '1.0.0-local',
          origin: { owner: 'you', carrier: 'research plugin' },
        }),
        lr({
          key: 'plugin:acc:research@synced',
          kind: 'plugin',
          name: 'research@synced',
          label: 'research',
          detail: '2.0.0-account',
          origin: { owner: 'account', carrier: 'research plugin', login: 'sam@example.com' },
        }),
      ]),
    )
    useStore.setState({ agents: [makeAgent({ id: 'a1', name: 'Ana', folder: '/proj' })] })
    render(<ProjectPage />)
    useStore.getState().changeProjectTab('tools')
    useStore.getState().setProjectItem('plugin:acc:research@synced')
    await waitFor(() => expect(screen.getByTestId('item-owner').parentElement!).toHaveTextContent('2.0.0-account'))
    expect(screen.getByTestId('item-owner').parentElement!).not.toHaveTextContent('1.0.0-local')
  })

  it('a bare plugin name opens no row (the name fallback is gone): the tab stays on its first row', async () => {
    mockedApi.folders.loads.mockResolvedValue(
      loads([
        lr({ key: 'mcp:project:tracker', kind: 'mcp', name: 'tracker', detail: 'https://tracker.example.com' }),
        lr({
          key: 'plugin:research@market',
          kind: 'plugin',
          name: 'research@market',
          label: 'research',
          detail: '1.0.0-local',
          origin: { owner: 'you', carrier: 'research plugin' },
        }),
      ]),
    )
    useStore.setState({ agents: [makeAgent({ id: 'a1', name: 'Ana', folder: '/proj' })] })
    render(<ProjectPage />)
    useStore.getState().changeProjectTab('tools')
    useStore.getState().setProjectItem('research')
    await waitFor(() => expect(screen.getByTestId('item-owner').parentElement!).toHaveTextContent('tracker.example.com'))
    expect(screen.getByTestId('item-owner').parentElement!).not.toHaveTextContent('1.0.0-local')
  })

  // spec tools-origin §9: «Sign in ›» opens a NEW real console (its
  // engine's sign-in tools live there, never in a chat) of an agent that
  // starts in the project — the one whose conversation read it, when it is
  // one — its sentence beside it; nothing is sent for the owner
  it('«Sign in ›» on a plugin server that needs your sign-in: a new console of the agent that read it, its sentence beside it, nothing sent', async () => {
    const read = { at: 1, from: 'turn' as const, login: 'sam@example.com', agent: 'b2' }
    mockedApi.folders.loads.mockResolvedValue(
      loads([
        lr({
          key: 'server:research@market:webstats',
          kind: 'mcp',
          name: 'plugin:research:webstats',
          label: 'webstats',
          origin: { owner: 'you', carrier: 'research plugin' },
          health: { status: 'needs-auth', read },
          signIn: { via: 'console', draft: DRAFT },
        }),
        lr({ key: 'mcp:project:tracker', kind: 'mcp', name: 'tracker', health: { status: 'connected', read }, signIn: { via: 'console', draft: 'unused' } }),
      ]),
    )
    useStore.setState({
      agents: [
        makeAgent({ id: 'a1', name: 'Ana', folder: '/proj' }),
        makeAgent({ id: 'b2', name: 'Builder', folder: '/proj' }),
        makeAgent({ id: 'x3', name: 'Elsewhere', folder: '/other' }),
      ],
      chatMode: 'chat',
      composerSeed: null,
      selectAgent: REAL_SELECT_AGENT,
    })
    render(<ProjectPage />)
    useStore.getState().changeProjectTab('tools')
    const signIns = await screen.findAllByTestId('sign-in')
    expect(signIns).toHaveLength(1) // the connected server has none
    expect(signIns[0]!.getAttribute('data-door')).toBe('console')
    fireEvent.click(signIns[0]!)
    const s = useStore.getState()
    expect(s.selectedAgentId).toBe('b2') // the agent whose conversation read it, not the first
    expect(s.newChatOpen).toBe(true)
    expect(s.selected).toBeNull()
    expect(s.chatMode).toBe('console') // a console, never a chat
    // the row's sentence beside the new console, the engine's exact name in
    // it — never in a chat composer, never sent
    expect(s.consoleCue).toEqual({ agentId: 'b2', console: null, text: DRAFT })
    expect(s.composerSeed).toBeNull()
    expect(mockedApi.chat).not.toHaveBeenCalled()
  })

  it('the agent choice: none that read it starts here → the first agent that starts here; none starts here → no door', async () => {
    const read = { at: 1, from: 'turn' as const, login: null, agent: 'x3' }
    mockedApi.folders.loads.mockResolvedValue(
      loads([
        lr({ key: 'mcp:project:tracker', kind: 'mcp', name: 'tracker', health: { status: 'needs-auth', read }, signIn: { via: 'console', draft: DRAFT } }),
      ]),
    )
    useStore.setState({
      agents: [
        makeAgent({ id: 'x3', name: 'Elsewhere', folder: '/other' }),
        makeAgent({ id: 'a1', name: 'Ana', folder: '/proj' }),
        makeAgent({ id: 'b2', name: 'Builder', folder: '/proj' }),
      ],
      selectAgent: REAL_SELECT_AGENT,
    })
    render(<ProjectPage />)
    useStore.getState().changeProjectTab('tools')
    fireEvent.click((await screen.findAllByTestId('sign-in'))[0]!)
    expect(useStore.getState().selectedAgentId).toBe('a1')
    expect(useStore.getState().consoleCue?.agentId).toBe('a1')
    // an agent whose territory only reaches the folder does not start there;
    // an archived one never: no console to open, no door
    const elsewhere = makeAgent({ id: 'x3', name: 'Elsewhere', folder: '/other', folders: ['/proj'] })
    expect(signInAgentOf([elsewhere, makeAgent({ id: 'z9', name: 'Old', folder: '/proj', archived: true })], '/proj', 'z9')).toBeNull()
    expect(useStore.getState().askSignIn('/proj/none', DRAFT)).toBe(false)
  })

  // the owner's walk (24-11): a claude.ai connector is connected in claude.ai,
  // never from a conversation; a row known only by a tool-name id opens a
  // console with the engine's own menu (`/mcp`) to send
  it('a connector waiting for sign-in: its door is the outside page in a new tab, no conversation; a tool-id-only row: a console with /mcp', async () => {
    const read = { at: 1, from: 'turn' as const, login: 'sam@example.com', agent: 'a1' }
    const LINK = { via: 'link' as const, url: 'https://connectors.example.com/settings', where: 'example.com' }
    mockedApi.folders.loads.mockResolvedValue(
      loads([
        lr({
          key: 'connector:sam@example.com:claude.ai Calendar',
          kind: 'connector',
          name: 'claude.ai Calendar',
          label: 'Calendar',
          origin: { owner: 'account', carrier: 'connector', login: 'sam@example.com' },
          health: { status: 'needs-auth', read },
          signIn: LINK,
        }),
        lr({
          key: 'seen:tracker_x',
          kind: 'mcp',
          name: 'tracker_x',
          exact: false,
          origin: { owner: null, carrier: 'seen when it last loaded' },
          health: { status: 'needs-auth', read },
          signIn: { via: 'console', draft: '/mcp', menu: true },
        }),
      ]),
    )
    const askSignIn = vi.fn(() => true)
    useStore.setState({ agents: [makeAgent({ id: 'a1', name: 'Ana', folder: '/proj' })], askSignIn })
    render(<ProjectPage />)
    useStore.getState().changeProjectTab('tools')
    await waitFor(() => expect(screen.getAllByTestId('sign-in').length).toBeGreaterThanOrEqual(2))
    const doors = screen.getAllByTestId('sign-in')
    const link = doors.find((d) => d.getAttribute('data-door') === 'link')!
    expect(link.tagName).toBe('A')
    expect(link).toHaveAttribute('href', LINK.url)
    expect(link).toHaveAttribute('target', '_blank')
    expect(link.getAttribute('rel')).toContain('noopener')
    fireEvent.click(link)
    expect(askSignIn).not.toHaveBeenCalled() // the connector door opens no conversation
    // the id-only row: a door that opens a console, `/mcp` beside it
    const menu = doors.find((d) => d.getAttribute('data-door') === 'console')!
    expect(menu.tagName).toBe('BUTTON')
    fireEvent.click(menu)
    expect(askSignIn).toHaveBeenCalledWith('/proj', '/mcp', 'a1')
  })

  it("the door is on every waiting row, filtered or not: folded under its plugin, the plugin row carries its server's", async () => {
    const read = { at: 1, from: 'turn' as const, login: null, agent: 'a1' }
    mockedApi.folders.loads.mockResolvedValue(
      loads([
        lr({ key: 'plugin:research@market', kind: 'plugin', name: 'research@market', label: 'research', origin: { owner: 'you', carrier: 'research plugin' } }),
        lr({
          key: 'server:research@market:webstats',
          kind: 'mcp',
          name: 'plugin:research:webstats',
          label: 'webstats',
          parent: 'plugin:research@market',
          origin: { owner: 'you', carrier: 'research plugin' },
          health: { status: 'needs-auth', read },
          signIn: { via: 'console', draft: DRAFT },
        }),
      ]),
    )
    const askSignIn = vi.fn(() => true)
    useStore.setState({ agents: [makeAgent({ id: 'a1', name: 'Ana', folder: '/proj' })], askSignIn })
    render(<ProjectPage />)
    useStore.getState().changeProjectTab('tools')
    const list = await screen.findByTestId('knows-library-panes')
    // unfiltered: the server is folded under its plugin — the door is there
    await waitFor(() => expect(within(list).getAllByTestId('sign-in').length).toBeGreaterThan(0))
    fireEvent.click(within(list).getAllByTestId('sign-in')[0]!)
    expect(askSignIn).toHaveBeenCalledWith('/proj', DRAFT, 'a1')
    // filtered: the server flat, its own door
    useStore.getState().setProjectItem(null, 'sign-in')
    await screen.findByTestId('facet-sign-in')
    await waitFor(() => expect(within(list).getAllByText('webstats').length).toBeGreaterThan(0))
    expect(within(list).getAllByTestId('sign-in').length).toBeGreaterThan(0)
  })

  it("the «need your sign-in» chip: a door with that filter narrows Tools to the waiting servers, a plugin's included; the chip removes it", async () => {
    const read = { at: 1, from: 'turn' as const, login: null }
    mockedApi.folders.loads.mockResolvedValue(
      loads([
        lr({ key: 'plugin:research@market', kind: 'plugin', name: 'research@market', label: 'research', origin: { owner: 'you', carrier: 'research plugin' } }),
        lr({
          key: 'server:research@market:webstats',
          kind: 'mcp',
          name: 'plugin:research:webstats',
          label: 'webstats',
          parent: 'plugin:research@market',
          origin: { owner: 'you', carrier: 'research plugin' },
          health: { status: 'needs-auth', read },
        }),
        lr({ key: 'mcp:project:tracker', kind: 'mcp', name: 'tracker', health: { status: 'connected', read } }),
      ]),
    )
    useStore.setState({ agents: [makeAgent({ id: 'a1', name: 'Ana', folder: '/proj' })] })
    render(<ProjectPage />)
    useStore.getState().changeProjectTab('tools')
    useStore.getState().setProjectItem(null, 'sign-in')
    const chip = await screen.findByTestId('facet-sign-in')
    const list = screen.getByTestId('knows-library-panes')
    await waitFor(() => expect(within(list).getAllByText('webstats').length).toBeGreaterThan(0))
    expect(within(list).queryByText('tracker')).toBeNull()
    fireEvent.click(within(chip).getByRole('button'))
    await waitFor(() => expect(within(list).getAllByText('tracker').length).toBeGreaterThan(0))
  })

  it("Files: the agent page's two parts, the folder's shared files, and a door to browse the folder", async () => {
    const f = (name: string, scope: 'agent' | 'shared') => ({
      name,
      rel: name,
      folder: '/proj',
      path: `/proj/context/${scope === 'shared' ? 'shared' : 'a1'}/${name}`,
      scope,
      size: 1,
      mtime: 1,
      kind: 'markdown' as const,
    })
    mockedApi.folders.context.mockResolvedValue({ shared: [f('brief.md', 'shared')], agent: [] })
    mockedApi.file.meta.mockImplementation(async (path: string) => ({ path, kind: 'markdown', size: 1, mtime: 1 }) as never)
    useStore.setState({ agents: [makeAgent({ id: 'a1', name: 'Ana', folder: '/proj' })] })
    render(<ProjectPage />)
    fireEvent.click(tab('Files'))
    const parts = screen.getByRole('group', { name: 'Files' })
    expect(
      within(parts)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['Files', 'Artifacts'])
    const shared = await screen.findByRole('region', { name: 'From Project · proj' })
    expect(within(shared).getByText('brief.md')).toBeInTheDocument()
    // asked about the folder itself, never an agent's territories
    expect(mockedApi.folders.context).toHaveBeenCalledWith('/proj')
    expect(mockedApi.context.list).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Browse the folder ›' }))
    expect(useStore.getState().page).toEqual({ kind: 'files', folder: '/proj' })
  })

  it('Files › Artifacts is a part of its own (an address), the list scoped to the folder', async () => {
    mockedApi.artifacts.mockResolvedValue({
      artifacts: [
        {
          title: 'dash.html',
          url: 'https://claude.ai/a/2',
          path: '/tmp/out/dash.html',
          ts: '2026-08-20T10:00:00.000Z',
          sessionKey: 'f/s1',
          sessionTitle: 'Dashboard',
          agentId: 'a1',
        },
      ],
      total: 1,
    })
    useStore.setState({
      agents: [makeAgent({ id: 'a1', name: 'Ana', folder: '/proj', sessions: [makeSession()] })],
      projectTab: 'files',
      filesPart: 'artifacts',
    })
    render(<ProjectPage />)
    expect(tab('Files')).toHaveAttribute('aria-current', 'page')
    expect(within(screen.getByRole('group', { name: 'Files' })).getByRole('button', { name: 'Artifacts' })).toHaveAttribute('aria-current', 'true')
    await waitFor(() => expect(screen.getByText('dash.html')).toBeInTheDocument())
    expect(mockedApi.artifacts).toHaveBeenCalledWith({ folder: '/proj' })
  })

  it('Pin to top and Put in bag sit on Now, always at hand', () => {
    mockedApi.patchPrefsProjects.mockResolvedValue({})
    useStore.setState({ agents: [makeAgent({ id: 'a1', name: 'Ana', folder: '/proj' })] })
    render(<ProjectPage />)
    fireEvent.click(screen.getByText('Pin to top'))
    expect(useStore.getState().projectsPrefs.pinned).toEqual(['/proj'])
    expect(screen.getByText('Put in bag')).toBeInTheDocument()
  })

  it('Map: Uses, scoped to the project', async () => {
    useStore.setState({ agents: [makeAgent({ id: 'a1', name: 'Ana', folder: '/proj' })], projectTab: 'map' })
    render(<ProjectPage />)
    expect(await screen.findByRole('tab', { name: 'Uses' })).toHaveAttribute('aria-selected', 'true')
    await waitFor(() => expect(mockedApi.uses).toHaveBeenCalledWith(expect.objectContaining({ folder: '/proj' })))
  })
})

// the scoped inbox (the Home's "Needs you", fed only what belongs to the
// folder) and the embedded Map lens.
describe('ProjectPage — the scoped inbox', () => {
  function makeCard(over: Partial<BoardCard> = {}): BoardCard {
    return { folder: 'f', id: 's', title: 't', agentId: 'a1', cwd: '/proj', state: 'needs_you', mtime: 10, ...over }
  }

  it("shows the questions waiting on you from conversations whose cwd falls in the folder — not another folder's", async () => {
    mockedApi.board.mockResolvedValue({
      cards: [
        makeCard({ id: 's-in', title: 'Inside the project', cwd: '/proj/sub' }),
        makeCard({ id: 's-out', title: 'Outside the project', cwd: '/other', agentId: 'a2', mtime: 20 }),
      ],
      needsYou: [],
      inbox: [
        askRow({ agentId: 'a1', id: 's-in', title: 'Inside the project', cwd: '/proj/sub', at: 10 }),
        askRow({ agentId: 'a2', id: 's-out', title: 'Outside the project', cwd: '/other', at: 20 }),
      ],
    })
    useStore.setState({ agents: [makeAgent({ id: 'a1', name: 'Ana', folder: '/proj' })] })
    render(<ProjectPage />)
    const inbox = await openNeedsYou()
    expect(within(inbox).getByText('Inside the project')).toBeInTheDocument()
    expect(screen.getByTestId('needs-you-all')).toHaveTextContent('1 holds someone up')
    expect(screen.queryByText('Outside the project')).not.toBeInTheDocument()
  })

  it('an honest quiet state when nothing in the folder waits on you', async () => {
    mockedApi.board.mockResolvedValue({
      cards: [makeCard({ id: 's-out', title: 'Outside', cwd: '/other' })],
      needsYou: [],
      inbox: [askRow({ agentId: 'a2', id: 's-out', title: 'Outside', cwd: '/other' })],
    })
    useStore.setState({ agents: [makeAgent({ id: 'a1', name: 'Ana', folder: '/proj' })] })
    render(<ProjectPage />)
    await waitFor(() => expect(screen.getByTestId('needs-you-empty')).toHaveTextContent('Nothing needs you.'))
    // nothing to open: no door to a list of nothing
    expect(screen.queryByTestId('needs-you-all')).not.toBeInTheDocument()
    expect(screen.queryByText('Outside')).not.toBeInTheDocument()
  })
})

// a folder Silos knows nothing about (a mistyped or munged link —
// /project/-home-user-x instead of the real path) says so, instead of
// inventing a quiet, empty project.
describe('ProjectPage — a folder no one knows', () => {
  it('an unknown folder shows the honest state, not the scoped Home; Back to Home leaves', () => {
    useStore.setState({
      page: { kind: 'project', folder: '-home-user-nowhere' },
      agents: [
        makeAgent({ id: 'a1', name: 'Ana', folder: '/home/user/acme' }),
        makeAgent({ id: MASTER_ID, name: 'Master', folder: null, sessions: [makeSession({ id: 'm', cwd: '/elsewhere', agentId: MASTER_ID })] }),
      ],
    })
    render(<ProjectPage />)
    expect(screen.getByRole('heading', { name: '-home-user-nowhere' })).toBeInTheDocument()
    expect(screen.getByText(/Silos knows no project here/)).toBeInTheDocument()
    expect(screen.queryByTestId('pulse')).not.toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'Machinery' })).not.toBeInTheDocument()
    expect(screen.queryByText(/0 agents/)).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Back to Home/ }))
    expect(useStore.getState().page).toBeNull()
  })

  it('a folder known only through a session cwd (no agent of its own) still renders the scoped Home', () => {
    useStore.setState({
      page: { kind: 'project', folder: '/proj' },
      agents: [
        makeAgent({
          id: MASTER_ID,
          name: 'Master',
          folder: null,
          sessions: [makeSession({ id: 'm', cwd: '/proj/sub', agentId: MASTER_ID, mtime: 1_600_000_000_000 })],
        }),
      ],
    })
    render(<ProjectPage />)
    expect(screen.getByTestId('pulse')).toBeInTheDocument()
    expect(screen.queryByText(/Silos knows no project here/)).not.toBeInTheDocument()
  })

  // /project/-home-user-acme (the session-folder
  // name) said "knows no project" while the real path worked.
  it('the munged session-folder form of a known folder is an alias of it', () => {
    useStore.setState({
      page: { kind: 'project', folder: '-home-user-acme' },
      agents: [makeAgent({ id: 'a1', name: 'Ana', folder: '/home/user/acme' }), makeAgent({ id: MASTER_ID, name: 'Master', folder: null, sessions: [] })],
    })
    render(<ProjectPage />)
    expect(screen.queryByText(/Silos knows no project here/)).not.toBeInTheDocument()
    expect(screen.getByTestId('pulse')).toBeInTheDocument()
  })

  it('a munged form two known folders share stays unknown — never a guess', () => {
    useStore.setState({
      page: { kind: 'project', folder: '-a-b-c' },
      agents: [makeAgent({ id: 'a1', name: 'Ana', folder: '/a/b-c' }), makeAgent({ id: 'a2', name: 'Bo', folder: '/a/b/c' })],
    })
    render(<ProjectPage />)
    expect(screen.getByText(/Silos knows no project here/)).toBeInTheDocument()
  })

  it('a known folder renders the scoped Home', () => {
    useStore.setState({ agents: [makeAgent({ id: 'a1', name: 'Ana', folder: '/proj' })] })
    render(<ProjectPage />)
    expect(screen.getByTestId('pulse')).toBeInTheDocument()
    expect(screen.queryByText(/Silos knows no project here/)).not.toBeInTheDocument()
  })

  it('before the overview loads (no agents yet) the unknown state does not flash', () => {
    useStore.setState({ agents: [], page: { kind: 'project', folder: '-home-user-acme' } })
    render(<ProjectPage />)
    expect(screen.queryByText(/Silos knows no project here/)).not.toBeInTheDocument()
  })
})

describe('resolveProjectFolder', () => {
  const agents = [
    makeAgent({ id: 'a1', name: 'Ana', folder: '/home/user/acme' }),
    makeAgent({ id: MASTER_ID, name: 'Master', folder: null, sessions: [makeSession({ id: 'm', cwd: '/home/user/side.proj', agentId: MASTER_ID })] }),
  ]
  it('a known real path is itself', () => {
    expect(resolveProjectFolder(agents, '/home/user/acme')).toBe('/home/user/acme')
  })
  it('the munged form of an agent folder or a session cwd maps back to it', () => {
    expect(mungeFolder('/home/user/side.proj')).toBe('-home-user-side-proj')
    expect(resolveProjectFolder(agents, '-home-user-acme')).toBe('/home/user/acme')
    expect(resolveProjectFolder(agents, '-home-user-side-proj')).toBe('/home/user/side.proj')
  })
  it('an unknown path or munged name is null', () => {
    expect(resolveProjectFolder(agents, '/nowhere')).toBeNull()
    expect(resolveProjectFolder(agents, '-nowhere')).toBeNull()
  })
})
