// agent-page.test.tsx — AgentPage replaces the retired AgentPanel.tsx for
// the 'agent' scope (Settings — formerly Identity — Memory, Sessions) plus
// the newer tabs (Skills, Schedule) and the header plate/tab bar.
// Navigation is no longer "opening a drawer" — it's setting
// page={kind:'agent',id} and tab in the store (what selectAgent/changeTab
// do, or the test directly via setState).
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { AgentPage } from '../src/components/AgentPage'
import { useStore } from '../src/store'
import { api } from '../src/lib/api'
import { MASTER_ID } from '../src/lib/constants'
import type { AgentView, Automation, MemoryLayers, SessionView } from '../src/lib/types'

vi.mock('../src/lib/api')

const mockedApi = vi.mocked(api, { deep: true })

function makeAgent(overrides: Partial<AgentView> = {}): AgentView {
  return {
    id: 'a1',
    name: 'Ana',
    emoji: '🧠',

    folder: '/home/user/ana',
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
    mtime: 0,
    size: 0,
    turnCount: 0,
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

// zone 1's own fetch (InChargeOf, GET /api/agents/:id/autonomy) — this
// file's default is the honest "nothing chosen yet" shape; individual
// InChargeOf behaviors are covered by web/test/in-charge-of.test.tsx, not
// re-tested here.

// AGENT DOSSIER (no conversation open) — `tab` is the tab bar's real tab. 3
// tabs — 'identity' (the form + a summarized memory), 'threads' (sessions
// with a List⇄Board toggle), and 'automations'. Default 'identity' (where
// the edit form lives).
function open(
  agent: AgentView,
  tab: 'identity' | 'memory' | 'vault' | 'threads' | 'control' | 'context' | 'skills' | 'tools' | 'loaded' | 'inbox' = 'identity',
): void {
  useStore.setState({ agents: [agent], page: { kind: 'agent', id: agent.id }, tab, selected: null, agentFrom: null })
}

// mounts the composed page for a bare agent id — the Support section
// tests below only care about that id showing up (in the fixture agent
// and in the api.support.list call), not the rest of the dossier.
function renderAgentPage(id: string): void {
  open(makeAgent({ id, name: id, folder: `/home/user/${id}` }), 'threads')
  render(<AgentPage />)
}

// an open CONVERSATION VIEW (the transcript + its column)
function openConversation(agent: AgentView, session: SessionView): void {
  useStore.setState({
    agents: [agent],
    page: { kind: 'agent', id: agent.id },
    selected: { folder: session.folder, id: session.id },
    detail: { meta: session, turns: [], total: 0 },
    agentFrom: null,
  })
}

// a facet clicked FROM a conversation:
// the real path — openDossier navigates to the agent page on that facet,
// carrying the conversation as the way back.
function openFromConversation(
  agent: AgentView,
  session: SessionView,
  facet: 'identity' | 'memory' | 'vault' | 'threads' | 'control' | 'skills' | 'context' | 'tools',
): void {
  openConversation(agent, session)
  useStore.getState().openDossier(facet)
}

// the agent's Settings tab is read-first: two cards (Who · Runs on), each
// swapping the EXISTING SettingsTab half in for its body on its own Edit —
// Who: emoji, name, Archive; Runs on: folders, engine, model, provider.
function openWho(): void {
  fireEvent.click(within(document.getElementById('who')!).getByRole('button', { name: 'Edit' }))
}
function openRuns(): void {
  fireEvent.click(screen.getByRole('button', { name: 'Edit what it runs on' }))
}

// the agent page is SECTIONS with an index: one section at a
// time, the index names where you are (aria-current="page").
function sections(name = 'Ana'): HTMLElement {
  return screen.getByRole('navigation', { name: `${name}'s sections` })
}
function sectionButton(label: string, name = 'Ana'): HTMLElement {
  return within(sections(name)).getByRole('button', { name: new RegExp(`^${label}`) })
}
// the tabs are buttons — Settings is the last one, by its name
function currentSection(name = 'Ana'): string | undefined {
  const b = sections(name).querySelector('[aria-current="page"]')
  return b?.textContent?.replace(/[\d≈.k●~]+$/, '').trim()
}

// an Automation fixture — a mirror of server/src/automations-types.ts.
function makeAutomation(overrides: Partial<Automation> = {}): Automation {
  return {
    id: 'auto1',
    name: 'Morning standup',
    agentId: 'a1',
    prompt: 'summarize overnight activity',
    trigger: { kind: 'cron', expr: '0 9 * * 1-5' },
    thread: { mode: 'new' },
    approval: false,
    keepAlive: false,
    paused: false,
    createdAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  useStore.setState({ chatMode: 'chat' }) // these tests exercise the built-in chat view, not the real console
  mockedApi.agents.update.mockResolvedValue(undefined)
  mockedApi.agents.archive.mockResolvedValue(undefined)
  mockedApi.memory.list.mockResolvedValue(makeLayers())
  mockedApi.complete.mockResolvedValue([])
  // zone 1 (InChargeOf) now mounts unconditionally for any folder agent's
  // Identity tab/facet — a default resolved fetch so tests that never
  // touch "In charge of" aren't tripped by an unmocked async call.
  // the AgentHeader "Console" quick action starts a real console session —
  // a default resolved key so tests that click it (without exercising the
  // console UI itself) don't hit an unmocked async call either.
  mockedApi.console.mockResolvedValue({ key: 'console-key', theme: 'dark' })
  // SettingsTab/SkillsTab call loadOverview() after saving/archiving — with
  // no mock here, ov.agents blows up on an unresolved mock. Returns the
  // agents ALREADY in the store (a realistic no-op) instead of a fixed
  // array: a fixed empty array here would erase the agent the test itself
  // mounted, breaking any later assertion about the same page.
  mockedApi.overview.mockImplementation(async () => ({ agents: useStore.getState().agents, now: 0, warming: false }))
  // loadAutomations()/AgentPage call it on save/delete — the same
  // realistic-no-op criterion as mockedApi.overview above (reads from the
  // store, doesn't set an unrelated array that would overwrite what the
  // test itself mounted).
  mockedApi.automations.list.mockImplementation(async () => useStore.getState().automations)
  mockedApi.automations.pending.mockResolvedValue([])
  // SettingsTab mounts ProviderFields, which requests the provider
  // catalog — default + one key-based provider for the selector/chain.
  mockedApi.providers.list.mockResolvedValue([
    {
      id: 'default',
      kind: 'claude-account',
      label: 'Claude (this machine)',
      account: { name: 'default', configDir: null, providerId: 'default', loggedIn: true, email: 'o@x.com', plan: null, shared: true },
      window: null,
    },
    {
      id: 'prov-ci',
      kind: 'anthropic-compatible',
      label: 'cheapestinference',
      baseUrl: 'https://api.cheapestinference.com/anthropic',
      apiKey: 'sk-…3456',
      createdAt: '2026-08-20T00:00:00.000Z',
      window: null,
    },
  ])
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
    memoryMode: null,
    memorySaved: null,
    error: null,
    page: null,
    tab: 'threads',
    newChatOpen: false,
    automations: [],
    automationsPending: [],
    automationRuns: [],
  })
})

describe('AgentPage — with no agent page', () => {
  it('with no agent page, falls back (Chat.tsx decides the EmptyState)', () => {
    render(<AgentPage />)
    expect(screen.queryByText('Identity')).not.toBeInTheDocument()
  })
})

describe('AgentPage — dossier: header plate, one composed page, no tab bar', () => {
  // Conversations left the agent page: the sidebar lists them
  // per agent, bulk pruning lives in Settings › Maintenance › Sessions. The
  // old 'threads' landing id still lands — on the page itself.
  // scope: one tab per thing the agent reaches — each list
  // inside shows its owner; no Knows/Can use, no Who/Setup (inside Settings)
  it('lands on Now — tabs of what the agent reaches, never a tab bar of capabilities — even from the legacy threads landing', async () => {
    open(makeAgent({ id: 'a1', name: 'Ana', sessionCount: 3 }), 'threads')
    render(<AgentPage />)
    const labels = within(sections())
      .getAllByRole('button')
      .map((b) => b.textContent?.replace(/[\d≈.k]+$/, '').trim())
    expect(labels).toEqual(['Now', 'Messages', 'Automations', 'Files', 'Memory', 'Skills', 'Tools', 'Secrets', 'At start', 'Profile'])
    expect(currentSection()).toBe('Now')
    // the cover names the other sections in one door tile each (tiles,
    // never stacked lines); a tile only says data — no new messages
    // → no Messages tile, nothing measured → no At start tile;
    // Settings has no tile — its door is its tab.
    // Counts wait for the reads: the tiles appear once src.ready
    await screen.findByTestId('door-memory')
    const doors = Array.from(document.querySelectorAll('[data-testid^="door-"]')).map((d) => d.getAttribute('data-testid'))
    expect(doors).toEqual(['door-memory', 'door-files', 'door-skills', 'door-tools'])
    expect(screen.queryByTestId('door-settings')).toBeNull()
    for (const gone of ['Inbox', 'Knows', 'Can use', 'Who', 'Setup']) {
      expect(within(sections()).queryByRole('button', { name: new RegExp(`^${gone}`) })).not.toBeInTheDocument()
    }
    for (const t of ['Conversations', 'Identity', 'Chat', 'Agent']) {
      expect(screen.queryByText(t)).not.toBeInTheDocument()
    }
  })

  // the header must not read "1399 conversations" by counting every automation
  // run as one. The header reads the server's uncapped totals and
  // labels runs as runs.
  it("the header counts the owner's conversations and labels runs apart, from the uncapped totals", () => {
    open(makeAgent({ id: 'a1', name: 'Ana', sessionCount: 1399, counts: { conversations: 3, runs: 1396, runsByAutomation: { hourly: 1396 }, byCwd: {} } }))
    render(<AgentPage />)
    expect(screen.getByText(/\b3 conversations\b.*\b1,396 runs/)).toBeInTheDocument()
    expect(screen.queryByText(/1399 conversations/)).not.toBeInTheDocument()
  })

  // the last activity is the sidebar's — the header keeps the counts only
  it('the header keeps the counts and never says when it was last active', () => {
    open(
      makeAgent({
        id: 'a1',
        name: 'Ana',
        sessions: [makeSession({ id: 's1', mtime: Date.now() - 3 * 3600_000 })],
        counts: { conversations: 1, runs: 0, runsByAutomation: {}, byCwd: {} },
      }),
    )
    render(<AgentPage />)
    expect(screen.getByText(/\b1 conversation/)).toBeInTheDocument()
    expect(screen.queryByText(/\bago\b|^\d+h$/)).not.toBeInTheDocument()
  })

  // the way back
  it('reached from a conversation, the header says ‹ <its title>; the click opens it again', async () => {
    mockedApi.sessionDetail.mockResolvedValue({ meta: makeSession({ id: 's1', folder: 'f', title: 'Fix the parser', agentId: 'a1' }), turns: [], total: 0 })
    open(makeAgent({ id: 'a1', name: 'Ana', sessions: [makeSession({ id: 's1', folder: 'f', title: 'Fix the parser', agentId: 'a1' })] }), 'memory')
    useStore.setState({ agentFrom: { folder: 'f', id: 's1' } })
    render(<AgentPage />)
    const chip = screen.getByTestId('return-chip')
    expect(chip).toHaveTextContent('Fix the parser')
    await act(async () => {
      fireEvent.click(chip)
    })
    expect(useStore.getState().selected).toEqual({ folder: 'f', id: 's1' })
    expect(useStore.getState().agentFrom).toBeNull()
    expect(screen.queryByTestId('return-chip')).toBeNull()
  })

  it('no way back when the page was not reached from a conversation', () => {
    open(makeAgent({ id: 'a1', name: 'Ana' }))
    useStore.setState({ agentFrom: null })
    render(<AgentPage />)
    expect(screen.queryByTestId('return-chip')).toBeNull()
  })

  // Settings is the last tab, ONE flat page — who it is, what it runs
  // on — with no sub-navigation; Secrets is a tab of its own
  it('the Settings tab is one flat page (Who, Runs on) with no sub-nav; Secrets is its own tab; the name carries no gear', () => {
    open(makeAgent({ id: 'a1', name: 'Ana' }), 'threads')
    render(<AgentPage />)
    expect(screen.queryByRole('button', { name: /'s settings$/ })).not.toBeInTheDocument()
    fireEvent.click(sectionButton('Profile'))
    expect(useStore.getState().tab).toBe('identity')
    expect(currentSection()).toBe('Profile')
    expect(screen.queryByRole('group', { name: "Ana's settings" })).not.toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Who' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Runs on' })).toBeInTheDocument()
    fireEvent.click(sectionButton('Secrets'))
    expect(useStore.getState().tab).toBe('vault')
    expect(currentSection()).toBe('Secrets')
    fireEvent.click(sectionButton('Now'))
    expect(useStore.getState().tab).toBe('threads')
  })

  it('Anywhere (master) has neither a Settings nor a Secrets tab', () => {
    open(makeAgent({ id: MASTER_ID, name: 'Master', folder: null }), 'threads')
    render(<AgentPage />)
    expect(within(sections('Master')).queryByRole('button', { name: /^Profile/ })).not.toBeInTheDocument()
    expect(within(sections('Master')).queryByRole('button', { name: /^Secrets/ })).not.toBeInTheDocument()
  })

  it('the project is the crumb above the agent — a door to the project page', () => {
    open(makeAgent({ id: 'a1', name: 'Ana', folder: '/home/user/ana' }), 'threads')
    render(<AgentPage />)
    const door = within(screen.getByRole('navigation', { name: 'Where this lives' })).getAllByRole('button', { name: 'ana' })[0]!
    fireEvent.click(door)
    expect(useStore.getState().page).toEqual({ kind: 'project', folder: '/home/user/ana' })
  })

  it('Anywhere (master): the UI\'s name and role, even though the registry says "Master"', () => {
    open(makeAgent({ id: MASTER_ID, name: 'Master', folder: null }))
    render(<AgentPage />)
    // the crumb (Anywhere has no project of its own — its place is itself) and the title
    expect(screen.getAllByText('Anywhere').length).toBeGreaterThan(0)
    expect(screen.queryByText('Master')).not.toBeInTheDocument()
  })
})

// The section index itself: every facet — a URL, a column
// link — lands ON its section; moving writes the facet back (the page's
// tab, or the pane's facet over a conversation).
describe('AgentPage — the sections index', () => {
  // the skills and tools facets (old links, the column) land on their own
  // tabs: what it reaches, each row with its owner
  const cases: [Parameters<typeof open>[1], string][] = [
    ['threads', 'Now'],
    ['inbox', 'Messages'],
    ['memory', 'Memory'],
    ['context', 'Files'],
    ['loaded', 'At start'],
    ['skills', 'Skills'],
    ['tools', 'Tools'],
    ['vault', 'Secrets'],
    ['identity', 'Profile'],
    // what it does without you, set (its control, heartbeat, limits, automations)
    ['control', 'Automations'],
  ]
  it.each(cases)('the %s facet lands on %s', (facet, section) => {
    open(makeAgent({ id: 'a1', name: 'Ana', folder: '/home/user/ana' }), facet)
    render(<AgentPage />)
    expect(currentSection()).toBe(section)
  })

  it('clicking a tab moves the page and writes its facet to the tab (the URL), never the pane', async () => {
    open(makeAgent({ id: 'a1', name: 'Ana' }), 'threads')
    render(<AgentPage />)
    const expected: [string, string][] = [
      ['Messages', 'inbox'],
      ['Memory', 'memory'],
      ['Files', 'context'],
      ['Skills', 'skills'],
      ['Tools', 'tools'],
      ['Secrets', 'vault'],
      ['At start', 'loaded'],
      ['Profile', 'identity'],
      ['Now', 'threads'],
    ]
    for (const [label, facet] of expected) {
      fireEvent.click(sectionButton(label))
      expect(useStore.getState().tab).toBe(facet)
      expect(currentSection()).toBe(label)
    }
    // each door tile on the cover lands on its tab and writes its facet
    // (counts wait for the reads — the tiles appear with src.ready)
    await screen.findByTestId('door-memory')
    const doors: [string, string, string][] = [
      ['memory', 'Memory', 'memory'],
      ['files', 'Files', 'context'],
      ['skills', 'Skills', 'skills'],
      ['tools', 'Tools', 'tools'],
    ]
    for (const [id, label, facet] of doors) {
      fireEvent.click(screen.getByTestId(`door-${id}`))
      expect(useStore.getState().tab).toBe(facet)
      expect(currentSection()).toBe(label)
      fireEvent.click(sectionButton('Now'))
    }
  })

  it('from a conversation a facet NAVIGATES to the agent page (no pane over the transcript); moving writes the page tab and keeps the way back', () => {
    const session = makeSession({ id: 's1', folder: 'f', agentId: 'a1', title: 'Fix the parser' })
    const agent = makeAgent({ id: 'a1', name: 'Ana', sessions: [session] })
    openFromConversation(agent, session, 'identity')
    render(<AgentPage />)
    expect(useStore.getState().selected).toBeNull()
    expect(useStore.getState().agentFrom).toEqual({ folder: 'f', id: 's1' })
    expect(currentSection()).toBe('Profile')
    fireEvent.click(sectionButton('Secrets'))
    expect(useStore.getState().tab).toBe('vault')
    fireEvent.click(sectionButton('Memory'))
    expect(useStore.getState().tab).toBe('memory')
    // the return chip stays while moving between tabs of the page
    expect(useStore.getState().agentFrom).toEqual({ folder: 'f', id: 's1' })
    expect(screen.getByTestId('return-chip')).toHaveTextContent('Fix the parser')
  })
})

describe('AgentPage — the dossier: three zones, read-first', () => {
  // the head of Profile is the MISSION (owner 24-11: Now is what happens) — the
  // sentence the agent is, its «Never» rules with their honest gloss, and
  // its editor in place. It replaced the «In charge of» card and the
  // Autonomy invitation (InChargeOf.tsx, deleted with this substitute).
  const MISSION = { text: 'Taxes and accounts.\nThe quarter closes on time.', never: ['file or pay anything'], updatedAt: '2026-11-10T09:00:00Z' }

  it('the mission tops Profile: its text, its Never rules as a rule (the locks are its territory and its secrets), then Who', async () => {
    open(makeAgent({ id: 'a1', name: 'Ana', folder: '/home/user/ana', mission: MISSION }), 'identity')
    const { container } = render(<AgentPage />)
    const head = screen.getByTestId('mission-header')
    expect(within(head).getByRole('heading', { name: 'Mission' })).toBeInTheDocument()
    expect(within(head).getByTestId('mission-read')).toHaveTextContent('Taxes and accounts. The quarter closes on time.')
    const never = within(head).getByTestId('mission-never')
    expect(never).toHaveTextContent('Never: file or pay anything')
    expect(never).toHaveTextContent(/a rule it follows; the locks are/)
    // the first card on the page, above Who
    expect(container.querySelector('h3')?.textContent).toBe('Mission')
    expect(head.compareDocumentPosition(document.getElementById('who')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    // the old duty's card and invitation are gone
    expect(screen.queryByText('In charge of')).not.toBeInTheDocument()
    expect(screen.queryByText(/Nothing is in its charge yet/)).not.toBeInTheDocument()
    // «territory» and «secrets» are doors to where the locks are set: its
    // Settings (the territory switch) and its Secrets tab
    fireEvent.click(within(never).getByRole('button', { name: 'secrets' }))
    expect(useStore.getState().tab).toBe('vault')
    fireEvent.click(sectionButton('Profile'))
    fireEvent.click(within(screen.getByTestId('mission-never')).getByRole('button', { name: 'territory' }))
    expect(useStore.getState().tab).toBe('identity')
  })

  it('no mission: the honest empty line, itself the door to the editor', () => {
    open(makeAgent({ id: 'a1', name: 'Ana', folder: '/home/user/ana' }), 'identity')
    render(<AgentPage />)
    expect(screen.getByTestId('mission-empty')).toHaveTextContent('No mission yet — Ana does only what you give it. Write what Ana takes care of ›')
    fireEvent.click(screen.getByText('Write what Ana takes care of ›'))
    expect(screen.getByTestId('mission-editor')).toHaveTextContent('New conversations will use it.')
  })

  it('Edit opens the editor in place (text + Never); Save sends the split mission, a Never line in the text included', async () => {
    open(makeAgent({ id: 'a1', name: 'Ana', folder: '/home/user/ana', mission: MISSION }), 'identity')
    render(<AgentPage />)
    fireEvent.click(within(screen.getByTestId('mission-header')).getByText('Edit'))
    expect(screen.getByLabelText('What Ana takes care of')).toHaveValue(MISSION.text)
    expect(screen.getByLabelText('Never, without asking you first — one per line')).toHaveValue('file or pay anything')
    expect(screen.getByText('New conversations will use it.')).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('What Ana takes care of'), { target: { value: 'Taxes only.\nnever: sign contracts' } })
    fireEvent.change(screen.getByLabelText('Never, without asking you first — one per line'), {
      target: { value: 'file or pay anything\n\nNever: hire anyone' },
    })
    fireEvent.click(screen.getByText('Save'))
    await waitFor(() =>
      expect(mockedApi.agents.update).toHaveBeenCalledWith('a1', {
        mission: { text: 'Taxes only.', never: ['sign contracts', 'file or pay anything', 'hire anyone'] },
      }),
    )
  })

  it('the editor says a problem in place and never sends it; emptying both fields removes the mission', async () => {
    open(makeAgent({ id: 'a1', name: 'Ana', folder: '/home/user/ana', mission: MISSION }), 'identity')
    render(<AgentPage />)
    fireEvent.click(within(screen.getByTestId('mission-header')).getByText('Edit'))
    fireEvent.change(screen.getByLabelText('What Ana takes care of'), { target: { value: '' } })
    expect(screen.getByRole('alert')).toHaveTextContent("Write what Ana takes care of — “Never” lines alone aren't a mission yet")
    expect(screen.getByText('Save')).toBeDisabled()
    fireEvent.change(screen.getByLabelText('Never, without asking you first — one per line'), { target: { value: '' } })
    expect(screen.getByText(/Saving empty removes it/)).toBeInTheDocument()
    fireEvent.click(screen.getByText('Save'))
    await waitFor(() => expect(mockedApi.agents.update).toHaveBeenCalledWith('a1', { mission: null }))
  })

  it('Anywhere (master) has no mission head', () => {
    open(makeAgent({ id: MASTER_ID, name: 'Master', folder: null }), 'identity')
    render(<AgentPage />)
    expect(screen.queryByTestId('mission-header')).not.toBeInTheDocument()
  })

  it('Who says who it is — role and charter are gone; the mission sits above it on the same page', () => {
    open(makeAgent({ id: 'a1', name: 'Ana', folder: '/home/user/ana', mission: MISSION }))
    render(<AgentPage />)
    expect(screen.getByTestId('mission-header')).toBeInTheDocument()
    expect(screen.queryByText(/charter/i)).not.toBeInTheDocument()
  })

  it('Edit swaps the EXISTING SettingsTab in for the Who body — with no Role or Charter field; Cancel hands the prose back', () => {
    open(makeAgent({ id: 'a1', name: 'Ana', folder: '/home/user/ana' }))
    render(<AgentPage />)
    expect(screen.queryByLabelText('Name')).not.toBeInTheDocument()
    openWho()
    expect(screen.getByLabelText('Name')).toBeInTheDocument()
    // the Who half only: what it runs on is edited in its own card
    expect(screen.queryByLabelText('Folder')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Role')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Charter')).not.toBeInTheDocument()
    fireEvent.click(screen.getByText('Cancel'))
    expect(screen.queryByLabelText('Name')).not.toBeInTheDocument()
  })

  it('Runs on says model · provider · folder, on the same page as Who; its Edit swaps in the other half of the editor', async () => {
    open(makeAgent({ id: 'a1', name: 'Ana', folder: '/home/user/ana', model: 'claude-sonnet-4-5' }))
    render(<AgentPage />)
    expect(screen.getByRole('heading', { name: 'Runs on' })).toBeInTheDocument()
    // an unknown model id is prettified (lib/runs-on.ts); the provider reads as the real account, never "default provider"
    expect(screen.getByText('Sonnet 4.5')).toBeInTheDocument()
    expect(screen.getByText('Claude subscription')).toBeInTheDocument()
    expect(screen.getByText('/home/user/ana')).toBeInTheDocument()
    openRuns()
    expect(screen.getByLabelText('Folder')).toHaveValue('/home/user/ana')
    expect(screen.queryByLabelText('Name')).not.toBeInTheDocument()
    expect(screen.queryByText('Archive agent')).not.toBeInTheDocument()
    // one editor at a time: opening Who's closes this one
    openWho()
    expect(screen.getByLabelText('Name')).toBeInTheDocument()
    expect(screen.queryByLabelText('Folder')).not.toBeInTheDocument()
  })

  it('an untouched Who save never sends a mission, a role, a charter or a responsibility', async () => {
    open(makeAgent({ id: 'a1', name: 'Ana', folder: '/home/user/ana', mission: { text: 'Books.', never: [], updatedAt: '2026-11-10T09:00:00Z' } }))
    render(<AgentPage />)
    openWho()
    fireEvent.click(screen.getByText('Save'))
    await waitFor(() => expect(mockedApi.agents.update).toHaveBeenCalled())
    const [, payload] = mockedApi.agents.update.mock.calls[0]!
    for (const f of ['mission', 'role', 'systemAppend', 'responsibility']) expect(payload).not.toHaveProperty(f)
  })

  it('memory (its own tab) renders inline and open, with no fold button', async () => {
    open(makeAgent({ id: 'a1', name: 'Ana', folder: '/home/user/ana' }), 'memory')
    render(<AgentPage />)
    expect(screen.queryByText('Open memory ›')).not.toBeInTheDocument()
    await waitFor(() => expect(mockedApi.memory.list).toHaveBeenCalledWith('/home/user/ana', 'a1'))
  })
})

describe('AgentPage — AgentHeader quick actions', () => {
  it('"New conversation" selects the agent and starts a new conversation (the sidebar "+"\'s own store actions)', () => {
    open(makeAgent({ id: 'a1', name: 'Ana', folder: '/home/user/ana' }), 'threads')
    render(<AgentPage />)
    fireEvent.click(screen.getByText('New chat'))
    expect(useStore.getState().selectedAgentId).toBe('a1')
    expect(useStore.getState().newChatOpen).toBe(true)
  })

  it('"Console" sets chatMode to console, then starts a new conversation', () => {
    // the console never opens here: jsdom cannot host xterm, and the new
    // conversation's column (agent header, Knows) keeps the view alive long
    // enough for a resolved console to mount it after the test.
    mockedApi.console.mockReturnValue(new Promise(() => {}))
    open(makeAgent({ id: 'a1', name: 'Ana', folder: '/home/user/ana' }), 'threads')
    render(<AgentPage />)
    fireEvent.click(screen.getByText('New console'))
    expect(useStore.getState().chatMode).toBe('console')
    expect(useStore.getState().selectedAgentId).toBe('a1')
    expect(useStore.getState().newChatOpen).toBe(true)
  })

  it('"Console" is hidden for the folder-less agent (Anywhere); "New conversation" stays', () => {
    open(makeAgent({ id: MASTER_ID, name: 'Master', folder: null }), 'threads')
    render(<AgentPage />)
    expect(screen.getByText('New chat')).toBeInTheDocument()
    expect(screen.queryByText('New console')).not.toBeInTheDocument()
  })
})

// with a conversation open, the agent band shows the same facets — WITHOUT
// Chat (the conversation is already the page) — and clicking one opens it
// COVERING the transcript.
describe("AgentPage — a conversation: the sentence under the title, and the column's gear", () => {
  it("the common header: crumbs say where (project › the agent's pill); the role is not the conversation's subtitle; no facet buttons; the mode selector stays once the conversation exists", () => {
    const agent = makeAgent({
      id: 'a1',
      name: 'Ana',
      folder: '/home/user/ana',
      mission: { text: 'Designs the screens. And more.', never: [], updatedAt: '2026-11-10T09:00:00Z' },
    })
    const session = makeSession({ id: 's1', folder: 'f', title: 'Fix the parser', agentId: 'a1' })
    useStore.setState({
      agents: [agent],
      page: { kind: 'agent', id: 'a1' },
      selected: { folder: 'f', id: 's1' },
      detail: { meta: session, turns: [], total: 0 },
    })
    render(<AgentPage />)
    expect(screen.getByText('Fix the parser')).toBeInTheDocument()
    // the mission's first sentence is the agent's line under the title
    // the title line is the conversation's: the agent's role is not its subtitle
    expect(screen.getByTestId('conversation-subtitle')).not.toHaveTextContent('Designs the screens.')
    const crumbs = screen.getByRole('navigation', { name: 'Where this lives' })
    expect(within(crumbs).getByRole('button', { name: 'ana' })).toBeInTheDocument()
    expect(within(crumbs).getAllByRole('button', { name: 'Ana’s page' }).length).toBeGreaterThan(0)
    // the ▾ unfolds the agent's sections and folds them again
    fireEvent.click(within(crumbs).getAllByRole('button', { name: 'Unfold Ana’s sections' })[0]!)
    expect(screen.getByTestId('agent-fold')).toBeInTheDocument()
    fireEvent.click(within(crumbs).getAllByRole('button', { name: 'Fold Ana’s sections' })[0]!)
    expect(screen.queryByTestId('agent-fold')).toBeNull()
    // no facet buttons — Conversations lives in the sidebar
    expect(screen.queryByText('Conversations')).not.toBeInTheDocument()
    expect(screen.queryByText('Agent')).not.toBeInTheDocument()
    // a started conversation keeps the Console|Chat selector (both engines
    // hand the session over)
    expect(screen.getByText('Real console')).toBeInTheDocument()
    // nothing in a conversation opens the agent's Settings directly: the
    // seal is a door to its page (Now), with the conversation as the way back
    expect(screen.queryByRole('button', { name: /Settings/ })).not.toBeInTheDocument()
    fireEvent.click(within(crumbs).getAllByRole('button', { name: 'Ana’s page' })[0]!)
    expect(useStore.getState().selected).toBeNull()
    expect(useStore.getState().tab).toBe('threads')
    expect(useStore.getState().agentFrom).toEqual({ folder: 'f', id: 's1' })
    expect(screen.getByTestId('return-chip')).toBeInTheDocument()
  })

  it('a started OpenCode conversation keeps Real console | Chat (the TUI and `opencode run` share one session); a Claude-native one does not', () => {
    const agent = makeAgent({ id: 'oc', name: 'Smoke', framework: 'opencode' })
    const meta = makeSession({ id: 'ses_abc', agentId: 'oc', native: true, harness: 'opencode' })
    useStore.setState({
      agents: [{ ...agent, sessions: [meta] }],
      page: { kind: 'agent', id: 'oc' },
      selected: { folder: meta.folder, id: meta.id },
      detail: { meta, turns: [], total: 0 },
    })
    render(<AgentPage />)
    expect(screen.getByText('Real console')).toBeInTheDocument()
    expect(screen.getByText('Chat')).toBeInTheDocument()
  })

  it('a NEW conversation still offers Real console | Chat next to the title', () => {
    useStore.setState({ agents: [makeAgent({ id: 'a1', name: 'Ana' })], page: { kind: 'agent', id: 'a1' }, selected: null, newChatOpen: true, detail: null })
    render(<AgentPage />)
    expect(screen.getByText('Real console')).toBeInTheDocument()
    expect(screen.getByText('Chat')).toBeInTheDocument()
  })

  it('the agent crumb opens the agent page in one click, with the way back', () => {
    const agent = makeAgent({ id: 'a1', name: 'Ana' })
    const session = makeSession({ id: 's1', folder: 'f', title: 'Fix the parser', agentId: 'a1' })
    useStore.setState({
      agents: [agent],
      page: { kind: 'agent', id: 'a1' },
      selected: { folder: 'f', id: 's1' },
      detail: { meta: session, turns: [], total: 0 },
    })
    render(<AgentPage />)
    // the crumb is drawn twice — the phone's «‹ Ana» and the desktop trail
    fireEvent.click(within(screen.getByRole('navigation', { name: 'Where this lives' })).getAllByTitle('Ana’s page')[0]!)
    expect(useStore.getState().selectedAgentId).toBe('a1')
    expect(useStore.getState().selected).toBeNull()
    expect(useStore.getState().agentFrom).toEqual({ folder: 'f', id: 's1' })
  })

  it("the pill's ▾ unfolds the agent's sections under its line (the conversation stays); remembered; a section leaves with the way back", async () => {
    try {
      localStorage.removeItem('silos.conversation.agentTabs')
    } catch {
      /* none */
    }
    const agent = makeAgent({ id: 'a1', name: 'Ana' })
    const session = makeSession({ id: 's1', folder: 'f', title: 'Fix the parser', agentId: 'a1' })
    mockedApi.messages.list.mockResolvedValue([])
    useStore.setState({
      agents: [agent],
      page: { kind: 'agent', id: 'a1' },
      selected: { folder: 'f', id: 's1' },
      detail: { meta: session, turns: [], total: 0 },
    })
    const view = render(<AgentPage />)
    const crumbs = screen.getByRole('navigation', { name: 'Where this lives' })
    expect(screen.queryByTestId('agent-fold')).toBeNull()
    fireEvent.click(within(crumbs).getAllByRole('button', { name: 'Unfold Ana’s sections' })[0]!)
    const fold = screen.getByRole('navigation', { name: 'Ana’s page' })
    // the same list as the page's tab bar (lib/agent-tabs.ts)
    expect(
      within(fold)
        .getAllByRole('button')
        .map((b) => b.firstChild?.textContent),
    ).toEqual(['Now', 'Messages', 'Automations', 'Files', 'Memory', 'Skills', 'Tools', 'Secrets', 'At start', 'Profile'])
    // the conversation is still the page
    expect(useStore.getState().selected).toEqual({ folder: 'f', id: 's1' })
    // remembered per viewer: a new mount opens unfolded
    view.unmount()
    render(<AgentPage />)
    fireEvent.click(within(screen.getByRole('navigation', { name: 'Ana’s page' })).getByRole('button', { name: /^Profile/ }))
    const st = useStore.getState()
    expect(st.selected).toBeNull()
    expect(st.tab).toBe('identity')
    expect(st.agentFrom).toEqual({ folder: 'f', id: 's1' })
    try {
      localStorage.removeItem('silos.conversation.agentTabs')
    } catch {
      /* none */
    }
  })

  it("the agent's unread messages ride on its name: a mark only while there are some, opening its Messages with the way back", async () => {
    const agent = makeAgent({ id: 'a1', name: 'Ana' })
    const session = makeSession({ id: 's1', folder: 'f', title: 'Fix the parser', agentId: 'a1' })
    mockedApi.messages.list.mockResolvedValue([
      { id: 'a-000001', from: 'builder', to: 'a1', at: '2026-10-23T10:00:00Z', text: 'x', state: 'new' },
      { id: 'a-000002', from: 'builder', to: 'a1', at: '2026-10-23T10:01:00Z', text: 'y', state: 'new' },
    ])
    useStore.setState({
      agents: [agent],
      page: { kind: 'agent', id: 'a1' },
      selected: { folder: 'f', id: 's1' },
      detail: { meta: session, turns: [], total: 0 },
    })
    render(<AgentPage />)
    const marks = await screen.findAllByRole('button', { name: '2 new messages for Ana' })
    expect(mockedApi.messages.list).toHaveBeenCalledWith('a1', 'new')
    fireEvent.click(marks[0]!)
    const st = useStore.getState()
    expect(st.selected).toBeNull()
    expect(st.tab).toBe('inbox')
    expect(st.agentFrom).toEqual({ folder: 'f', id: 's1' })
  })

  it('no messages mark when nothing is unread', async () => {
    const agent = makeAgent({ id: 'a1', name: 'Ana' })
    mockedApi.messages.list.mockResolvedValue([])
    useStore.setState({
      agents: [agent],
      page: { kind: 'agent', id: 'a1' },
      selected: { folder: 'f', id: 's1' },
      detail: { meta: makeSession({ id: 's1', folder: 'f', agentId: 'a1' }), turns: [], total: 0 },
    })
    render(<AgentPage />)
    await waitFor(() => expect(mockedApi.messages.list).toHaveBeenCalledWith('a1', 'new'))
    expect(screen.queryByTestId('agent-messages-mark')).not.toBeInTheDocument()
  })

  it('Esc cancels the streaming turn of the conversation on screen', () => {
    const agent = makeAgent({ id: 'a1', name: 'Ana' })
    const session = makeSession({ id: 's1', folder: 'f', agentId: 'a1' })
    openConversation(agent, session)
    useStore.setState({ active: { turnId: 't1', agentId: 'a1', text: '', tools: [], status: 'streaming', userText: 'x', sessionKey: 'f/s1' } })
    render(<AgentPage />)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(mockedApi.cancel).toHaveBeenCalledWith('t1')
  })

  it('Esc does NOT cancel a turn of ANOTHER conversation than the one on screen', () => {
    const agent = makeAgent({ id: 'a1', name: 'Ana' })
    openConversation(agent, makeSession({ id: 's2', folder: 'f', agentId: 'a1' }))
    useStore.setState({ active: { turnId: 't1', agentId: 'a1', text: '', tools: [], status: 'streaming', userText: 'x', sessionKey: 'f/s1' } })
    render(<AgentPage />)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(mockedApi.cancel).not.toHaveBeenCalled()
  })
})

// a provider selector + fallback chain in Settings, and an
// "on fallback · resumes HH:MM" badge on the header plate and the
// conversation header.
describe('AgentPage — Provider and fallback', () => {
  it("the selector offers Default · accounts · key-based providers, and preloads the agent's", async () => {
    open(makeAgent({ id: 'a1', provider: 'prov-ci' }))
    render(<AgentPage />)
    openRuns()
    const selector = await screen.findByLabelText('Provider')
    // the value follows the catalog: wait for it, never race providers.list
    await waitFor(() => expect(selector).toHaveValue('prov-ci'))
    const options = within(selector as HTMLElement)
      .getAllByRole('option')
      .map((o) => o.textContent)
    expect(options).toEqual(['Default — Claude (this machine)', 'cheapestinference'])
  })

  it("the 'default' provider normalizes to Default in the selector", async () => {
    open(makeAgent({ id: 'a1', provider: 'default' }))
    render(<AgentPage />)
    openRuns()
    expect(await screen.findByLabelText('Provider')).toHaveValue('')
  })

  it('saving sends provider and fallback in the payload', async () => {
    open(makeAgent({ id: 'a1' }))
    render(<AgentPage />)
    openRuns()
    const fallbackSelector = await screen.findByLabelText('add fallback provider')
    fireEvent.change(fallbackSelector, { target: { value: 'prov-ci' } })
    fireEvent.click(screen.getByText('Save'))
    await waitFor(() => expect(mockedApi.agents.update).toHaveBeenCalledWith('a1', expect.objectContaining({ provider: 'default', fallback: ['prov-ci'] })))
  })

  it('the fallback chain can be emptied by removing the chip', async () => {
    open(makeAgent({ id: 'a1', fallback: ['prov-ci'] }))
    render(<AgentPage />)
    openRuns()
    // the chip's × is aria-hidden — the accessible name is just the label
    const chip = await screen.findByRole('button', { name: 'cheapestinference' })
    fireEvent.click(chip)
    fireEvent.click(screen.getByText('Save'))
    await waitFor(() => expect(mockedApi.agents.update).toHaveBeenCalledWith('a1', expect.objectContaining({ fallback: [] })))
  })

  // a deleted provider that's still referenced used to leave the controlled
  // select with a value that has no matching option — the browser painted
  // "Default" but Save sent the ghost id and the server rejected it (400)
  // without the user touching anything.
  it('a deleted provider normalizes to Default: Save sends "default", never the ghost id', async () => {
    open(makeAgent({ id: 'a1', provider: 'deleted-a-while-ago' }))
    render(<AgentPage />)
    openRuns()
    const selector = await screen.findByLabelText('Provider')
    // de-flaking: value '' is also the INITIAL pre-catalog state — if Save
    // fires before providers.list resolves, the payload races the
    // normalization. Anchor: the catalog's option is ALREADY in the DOM (an
    // unambiguous signal the catalog loaded) before checking the value.
    await screen.findAllByRole('option', { name: 'cheapestinference' })
    await waitFor(() => expect(selector).toHaveValue(''))
    fireEvent.click(screen.getByText('Save'))
    await waitFor(() => expect(mockedApi.agents.update).toHaveBeenCalledWith('a1', expect.objectContaining({ provider: 'default' })))
  })

  it('deleted ids in the fallback chain are pruned before saving', async () => {
    open(makeAgent({ id: 'a1', fallback: ['deleted', 'prov-ci'] }))
    render(<AgentPage />)
    openRuns()
    await screen.findByLabelText('Provider')
    // the deleted one's chip disappears; the known one survives
    await waitFor(() => expect(screen.queryByRole('button', { name: 'deleted' })).not.toBeInTheDocument())
    expect(screen.getByRole('button', { name: 'cheapestinference' })).toBeInTheDocument()
    fireEvent.click(screen.getByText('Save'))
    await waitFor(() => expect(mockedApi.agents.update).toHaveBeenCalledWith('a1', expect.objectContaining({ fallback: ['prov-ci'] })))
  })

  it('the header plate shows the "on fallback · resumes HH:MM" badge when the agent runs on fallback', () => {
    open(makeAgent({ id: 'a1', onFallback: { providerId: 'prov-ci', from: 'default', until: '2026-08-20T15:00:00.000Z' } }), 'threads')
    render(<AgentPage />)
    expect(screen.getByText(/on fallback · resumes/)).toBeInTheDocument()
  })

  it("in a conversation the fallback is a STATE on the column's runs-on line, not part of the identity sentence", () => {
    const agent = makeAgent({ id: 'a1', onFallback: { providerId: 'prov-ci', from: 'default', until: '2026-08-20T15:00:00.000Z' } })
    useStore.setState({
      providers: [
        {
          id: 'prov-ci',
          kind: 'anthropic-compatible',
          label: 'cheapestinference',
          baseUrl: 'https://api.cheapestinference.com/anthropic',
          apiKey: 'k',
          createdAt: '2026-08-01',
          window: null,
        },
      ] as never,
    })
    openConversation(agent, makeSession())
    render(<AgentPage />)
    expect(screen.getByText(/cheapestinference \(fallback\) · until \d{2}:\d{2}/)).toBeInTheDocument()
    expect(screen.getByTestId('conversation-subtitle')).not.toHaveTextContent(/fallback/)
  })

  it('with no fallback state there is no badge', () => {
    open(makeAgent({ id: 'a1' }), 'threads')
    render(<AgentPage />)
    expect(screen.queryByText(/on fallback/)).not.toBeInTheDocument()
  })
})

describe('AgentPage — Settings: the Who and Runs on editors', () => {
  it("preloads the existing agent's name", () => {
    open(makeAgent({ name: 'Ana' }))
    render(<AgentPage />)
    openWho()
    expect(screen.getByLabelText('Name')).toHaveValue('Ana')
    expect(screen.getByText('Save')).toBeInTheDocument()
  })

  it('the id is fixed and visible (no editable field)', () => {
    open(makeAgent({ id: 'a1', name: 'Ana' }))
    render(<AgentPage />)
    openWho()
    expect(screen.getByText('a1')).toBeInTheDocument()
  })

  it('saving calls api.agents.update with the existing id', async () => {
    open(makeAgent({ id: 'a1', name: 'Ana' }))
    render(<AgentPage />)
    openWho()
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'New Ana' } })
    fireEvent.click(screen.getByText('Save'))
    await waitFor(() => expect(mockedApi.agents.update).toHaveBeenCalledWith('a1', expect.objectContaining({ name: 'New Ana' })))
  })

  it('a save error with no identifiable field shows above the form', async () => {
    open(makeAgent({ id: 'a1', name: 'Ana' }))
    mockedApi.agents.update.mockRejectedValueOnce(new Error('agent not found'))
    render(<AgentPage />)
    openWho()
    fireEvent.click(screen.getByText('Save'))
    await waitFor(() => expect(screen.getByText('agent not found')).toBeInTheDocument())
  })

  it('"Archive agent" asks for confirmation with a double click', async () => {
    open(makeAgent({ id: 'a1', name: 'Ana' }))
    render(<AgentPage />)
    openWho()
    fireEvent.click(screen.getByText('Archive agent'))
    expect(mockedApi.agents.archive).not.toHaveBeenCalled()
    fireEvent.click(screen.getByText(/sure/i))
    await waitFor(() => expect(mockedApi.agents.archive).toHaveBeenCalledWith('a1'))
  })

  it('archiving the currently selected agent clears selectedAgentId, selected, detail and page', async () => {
    useStore.setState({
      agents: [makeAgent({ id: 'a1', name: 'Ana' })],
      selectedAgentId: 'a1',
      selected: null,
      detail: null,
      mobileView: 'chat',
      page: { kind: 'agent', id: 'a1' },
      tab: 'identity',
    })
    render(<AgentPage />)
    openWho()
    fireEvent.click(screen.getByText('Archive agent'))
    fireEvent.click(screen.getByText(/sure/i))
    await waitFor(() => expect(mockedApi.agents.archive).toHaveBeenCalledWith('a1'))
    expect(useStore.getState().selectedAgentId).toBeNull()
    expect(useStore.getState().selected).toBeNull()
    expect(useStore.getState().detail).toBeNull()
    expect(useStore.getState().mobileView).toBe('list')
    expect(useStore.getState().page).toBeNull()
  })

  it('archiving an agent that is NOT the selected one does not touch selectedAgentId/selected', async () => {
    useStore.setState({
      agents: [makeAgent({ id: 'a1', name: 'Ana' }), makeAgent({ id: 'b2', name: 'Beto' })],
      selectedAgentId: 'b2',
      selected: null,
      page: { kind: 'agent', id: 'a1' },
      tab: 'identity',
    })
    render(<AgentPage />)
    openWho()
    fireEvent.click(screen.getByText('Archive agent'))
    fireEvent.click(screen.getByText(/sure/i))
    await waitFor(() => expect(mockedApi.agents.archive).toHaveBeenCalledWith('a1'))
    expect(useStore.getState().selectedAgentId).toBe('b2')
    expect(useStore.getState().page).toEqual({ kind: 'agent', id: 'a1' })
  })

  it('gating for master: no "Archive agent" and Folder disabled', () => {
    open(makeAgent({ id: MASTER_ID, name: 'Master', folder: null }))
    render(<AgentPage />)
    openWho()
    expect(screen.queryByText('Archive agent')).not.toBeInTheDocument()
    openRuns()
    expect(screen.getByLabelText('Folder')).toBeDisabled()
  })

  // skills are the FOLDER's — neither editor has a Skills
  // field (it drove nothing); they are read and managed on the Skills tab
  it('Skills: no field to type into, in either editor', () => {
    open(makeAgent({ id: 'a1', name: 'Ana', folder: '/home/user/ana', skills: ['old-one'] }))
    render(<AgentPage />)
    for (const openEditor of [openWho, openRuns]) {
      openEditor()
      expect(document.getElementById('identity-skills')).toBeNull()
      expect(screen.queryByPlaceholderText('type and press Enter')).not.toBeInTheDocument()
    }
  })

  it('a normal agent: "Archive agent" visible and Folder enabled', () => {
    open(makeAgent({ id: 'a1', name: 'Ana' }))
    render(<AgentPage />)
    openWho()
    expect(screen.getByText('Archive agent')).toBeInTheDocument()
    openRuns()
    expect(screen.getByLabelText('Folder')).not.toBeDisabled()
  })
})

// The responsibility textarea + consent-first skill install flow moved OUT
// of SettingsTab entirely (zone 1, InChargeOf, owns it now) — fully covered
// by web/test/in-charge-of.test.tsx (typing/clearing/re-editing, the
// consent step, the folder-less agent rendering nothing). The one thing
// left for THIS file to guard is the round-trip regression, covered above
// in "AgentPage — the dossier: three zones, read-first".

describe('AgentPage — Esc cancels the active turn, regardless of the visible tab', () => {
  // the turn's conversation is not on
  // screen on the agent page — a stray Esc there never cancels it
  it('Esc on the agent page does NOT cancel a turn whose conversation is off screen', () => {
    open(makeAgent({ id: 'a1', name: 'Ana' }))
    useStore.setState({
      active: { turnId: 't1', agentId: 'a1', text: '', tools: [], status: 'streaming', userText: 'x', sessionKey: 'f/s1' },
      agentFrom: { folder: 'f', id: 's1' },
    })
    render(<AgentPage />)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(mockedApi.cancel).not.toHaveBeenCalled()
  })
})

// memory is no longer a tab, and no longer folded — it lives inside the
// dossier's Knows zone, rendered inline and open (the "renders inline...
// no fold button" case itself lives in "the dossier: three zones,
// read-first" above). Just the rest of the memory viewer's own behavior,
// unaffected by the promotion.
// Files (scope): every file the agent reaches — its own
// (context/<agent>), its working files (agent state), the project's shared
// ones — in one list grouped by owner, plus its artifacts.
describe('AgentPage — Files: everything it reaches, by owner; artifacts', () => {
  const f = (name: string, scope: 'agent' | 'shared') => ({
    name,
    rel: name,
    folder: '/home/user/ana',
    path: `/home/user/ana/context/${scope === 'shared' ? 'shared' : 'a1'}/${name}`,
    scope,
    size: 1,
    mtime: 1,
    kind: 'markdown' as const,
  })

  it("two parts under one SubNav (the project's same two); Files groups its own and the shared ones by owner, the shared one with a door to the project", async () => {
    mockedApi.context.list.mockResolvedValue({ shared: [f('brief.md', 'shared'), f('style.md', 'shared')], agent: [f('mine.md', 'agent')] })
    mockedApi.context.produced.mockResolvedValue([])
    mockedApi.file.meta.mockImplementation(async (path: string) => ({ path, kind: 'markdown', size: 1, mtime: 1 }) as never)
    open(makeAgent({ id: 'a1', name: 'Ana', folder: '/home/user/ana' }), 'context')
    render(<AgentPage />)
    expect(currentSection()).toBe('Files')
    const pieces = screen.getByRole('group', { name: 'Files' })
    expect(
      within(pieces)
        .getAllByRole('button')
        .map((b) => b.textContent?.replace(/\d+$/, '').trim()),
    ).toEqual(['Files', 'Artifacts'])
    expect(within(pieces).getByRole('button', { name: /^Files/ })).toHaveAttribute('aria-current', 'true')
    const own = await screen.findByRole('region', { name: 'From Agent · 🧠 Ana' })
    expect(within(own).getByText('mine.md')).toBeInTheDocument()
    const shared = screen.getByRole('region', { name: 'From Project · ana' })
    expect(within(shared).getByText('brief.md')).toBeInTheDocument()
    expect(within(shared).getByText('style.md')).toBeInTheDocument()
    // the tab counts all it reaches: its own + working + shared
    await waitFor(() => expect(sectionButton('Files')).toHaveTextContent('Files3'))
    // the «From» row: each chip counts its head
    expect(
      within(screen.getByTestId('scope-filter'))
        .getAllByRole('radio')
        .map((b) => b.lastElementChild?.textContent),
    ).toEqual(['3', '1', '2'])
    fireEvent.click(within(within(shared).getByTestId('owner-header')).getByRole('button', { name: /in ana ›$/ }))
    expect(useStore.getState().page).toEqual({ kind: 'project', folder: '/home/user/ana' })
    expect(useStore.getState().projectTab).toBe('files')
  })

  it('Artifacts is a part with an address (the store writes it), and «Browse its folder ›» opens the Files page rooted there', async () => {
    mockedApi.context.list.mockResolvedValue({ shared: [], agent: [] })
    mockedApi.context.produced.mockResolvedValue([])
    mockedApi.artifacts.mockResolvedValue({ artifacts: [], total: 0 })
    open(makeAgent({ id: 'a1', name: 'Ana', folder: '/home/user/ana' }), 'context')
    render(<AgentPage />)
    fireEvent.click(within(screen.getByRole('group', { name: 'Files' })).getByRole('button', { name: 'Artifacts' }))
    expect(useStore.getState().filesPart).toBe('artifacts')
    expect(await screen.findByText('No artifacts yet')).toBeInTheDocument()
    expect(mockedApi.artifacts).toHaveBeenCalledWith({ agent: 'a1' })
    fireEvent.click(screen.getByRole('button', { name: 'Browse its folder ›' }))
    expect(useStore.getState().page).toEqual({ kind: 'files', folder: '/home/user/ana' })
  })

  it('its working files sit with its own, said as working files, and selecting one shows it in the viewer', async () => {
    mockedApi.context.list.mockResolvedValue({ shared: [], agent: [] })
    mockedApi.context.produced.mockResolvedValue([
      { name: 'q4.md', rel: 'reports/q4.md', path: '/state/a1/reports/q4.md', folder: '/state/a1', scope: 'own', size: 4, mtime: 1, kind: 'markdown' },
    ])
    mockedApi.file.meta.mockReturnValue(new Promise(() => {})) // the viewer's own fetch: stays loading
    open(makeAgent(), 'context')
    render(<AgentPage />)
    await waitFor(() => expect(mockedApi.context.produced).toHaveBeenCalledWith('a1'))
    const own = await screen.findByRole('region', { name: 'From Agent · 🧠 Ana' })
    expect(within(own).getByText('working file')).toBeInTheDocument()
    fireEvent.click(within(own).getByText('reports/q4.md'))
    expect(screen.getByTestId('item-owner').textContent).toMatch(/^From Agent · 🧠 Ana/)
    // selecting it IS opening it: the viewer is already there, no «Open» in between
    expect(await screen.findByLabelText('File · /state/a1/reports/q4.md')).toBeTruthy()
  })

  it('with no file it reaches, Files says so honestly (0, an empty line)', async () => {
    mockedApi.context.list.mockResolvedValue({ shared: [], agent: [] })
    mockedApi.context.produced.mockResolvedValue([])
    open(makeAgent(), 'context')
    render(<AgentPage />)
    await waitFor(() => expect(mockedApi.context.produced).toHaveBeenCalledWith('a1'))
    await waitFor(() => expect(sectionButton('Files')).toHaveTextContent('Files0'))
    expect(await screen.findByText('No files yet.')).toBeInTheDocument()
  })

  it('Artifacts shows the block scoped to the agent, fetched only once opened; the address stays on Files', async () => {
    mockedApi.artifacts.mockResolvedValue({
      artifacts: [
        {
          title: 'report.html',
          url: 'https://claude.ai/a/1',
          path: '/tmp/out/report.html',
          ts: '2026-08-20T10:00:00.000Z',
          sessionKey: 'f/s1',
          sessionTitle: 'Report',
          agentId: 'a1',
        },
      ],
      total: 1,
    })
    open(makeAgent({ id: 'a1', name: 'Ana', sessions: [makeSession()] }), 'context')
    render(<AgentPage />)
    expect(mockedApi.artifacts).not.toHaveBeenCalled()
    fireEvent.click(within(screen.getByRole('group', { name: 'Files' })).getByRole('button', { name: 'Artifacts' }))
    await waitFor(() => expect(screen.getByText('report.html')).toBeInTheDocument())
    expect(mockedApi.artifacts).toHaveBeenCalledWith({ agent: 'a1' })
    expect(screen.getByRole('region', { name: 'Artifacts' })).toBeInTheDocument()
    expect(useStore.getState().tab).toBe('context')
  })

  it('with no artifacts, an honest "No artifacts yet"', async () => {
    mockedApi.artifacts.mockResolvedValue({ artifacts: [], total: 0 })
    open(makeAgent({ id: 'a1', name: 'Ana' }), 'context')
    render(<AgentPage />)
    fireEvent.click(within(screen.getByRole('group', { name: 'Files' })).getByRole('button', { name: 'Artifacts' }))
    await waitFor(() => expect(screen.getByText('No artifacts yet')).toBeInTheDocument())
  })
})

// Memory (scope): everything it reads — its own memory file,
// the project's CLAUDE.md, index and every note (each saying who learned
// it), yours — grouped by owner, the project's with a door to its house.
describe('AgentPage — Memory: everything it reads, by owner', () => {
  const note = (name: string, author?: string): MemoryLayers['autoMemory'][number] => ({
    name,
    path: `/mem/${name}`,
    scope: 'project',
    mtime: 1,
    exists: true,
    description: `about ${name}`,
    ...(author ? { author } : {}),
  })
  const seed = (): void => {
    mockedApi.memory.list.mockResolvedValue(
      makeLayers({
        project: { name: 'CLAUDE.md', path: '/home/user/ana/CLAUDE.md', scope: 'project', mtime: 0, exists: true, size: 100 },
        agent: { name: 'memory.md', path: '/data/agents/a1/memory.md', scope: 'agent', mtime: 0, exists: true, size: 40 },
        autoMemory: [
          { name: 'MEMORY.md', path: '/mem/MEMORY.md', scope: 'project', mtime: 1, exists: true, type: 'index', lines: 3, size: 10 },
          note('mine_deploy.md', 'a1'),
          note('theirs_billing.md', 'b2'),
          note('unknown_origin.md'),
        ],
      }),
    )
  }

  it("lists every note the folder holds — its own and another agent's, each with who learned it — under the project, its own file under Ana; the tab counts notes", async () => {
    seed()
    open(makeAgent({ id: 'a1', name: 'Ana', folder: '/home/user/ana' }), 'memory')
    useStore.setState({
      agents: [makeAgent({ id: 'a1', name: 'Ana', folder: '/home/user/ana' }), makeAgent({ id: 'b2', name: 'Bea', folder: '/home/user/ana' })],
    })
    render(<AgentPage />)
    expect(currentSection()).toBe('Memory')
    const project = await screen.findByRole('region', { name: 'From Project · ana' })
    for (const t of ['Mine deploy', 'Theirs billing', 'Unknown origin', 'Memory index', 'CLAUDE.md']) {
      expect(within(project).getAllByText(t).length).toBeGreaterThan(0)
    }
    expect(within(project).getByText('Ana · about mine_deploy.md')).toBeInTheDocument()
    expect(within(project).getByText('Bea · about theirs_billing.md')).toBeInTheDocument()
    expect(within(project).getByTestId('owner-header').textContent).toMatch(/^From Project · ana/)
    expect(within(screen.getByRole('region', { name: 'From Agent · 🧠 Ana' })).getByText('Its own memory')).toBeInTheDocument()
    expect(sectionButton('Memory')).toHaveTextContent('Memory3')
    // its share of the folder's memory, one click away
    fireEvent.click(screen.getByRole('button', { name: /^learned by Ana 1$/ }))
    expect(screen.queryByText('Theirs billing')).not.toBeInTheDocument()
    expect(screen.getAllByText('Mine deploy').length).toBeGreaterThan(0)
  })

  it("the project's group links to the project's Memory tab; its own group has no door", async () => {
    seed()
    open(makeAgent({ id: 'a1', name: 'Ana', folder: '/home/user/ana' }), 'memory')
    render(<AgentPage />)
    const project = await screen.findByRole('region', { name: 'From Project · ana' })
    expect(within(within(screen.getByRole('region', { name: 'From Agent · 🧠 Ana' })).getByTestId('owner-header')).queryByRole('button')).toBeNull()
    fireEvent.click(within(within(project).getByTestId('owner-header')).getByRole('button', { name: /in ana ›$/ }))
    expect(useStore.getState().page).toEqual({ kind: 'project', folder: '/home/user/ana' })
    expect(useStore.getState().projectTab).toBe('memory')
  })

  it('with no memory of its own, "+ Write Ana\'s own memory" opens the editor for it', async () => {
    mockedApi.memory.list.mockResolvedValue(
      makeLayers({ agent: { name: 'memory.md', path: '/data/agents/a1/memory.md', scope: 'agent', mtime: 0, exists: false } }),
    )
    open(makeAgent({ id: 'a1', name: 'Ana', folder: '/home/user/ana' }), 'memory')
    render(<AgentPage />)
    fireEvent.click(await screen.findByText('+ Write Ana’s own memory'))
    expect(screen.getByText(/read at the start of every conversation of Ana — and of no other agent/)).toBeInTheDocument()
    expect(screen.queryByText('+ Write Ana’s own memory')).not.toBeInTheDocument()
  })

  it('"Edit with chat" on its own memory enters memory mode and requests composer focus, without changing agent/session', async () => {
    mockedApi.memory.list.mockResolvedValue(
      makeLayers({ agent: { name: 'Agent memory', path: '/data/agents/a1/memory.md', scope: 'agent', mtime: 0, exists: true } }),
    )
    mockedApi.memory.read.mockResolvedValue('existing notes')
    useStore.setState({ agents: [makeAgent({ id: 'a1', name: 'Ana' })], selectedAgentId: 'b2', page: { kind: 'agent', id: 'a1' }, tab: 'memory' })
    render(<AgentPage />)

    // its own memory sits under its owner — the agent
    const head = await screen.findByRole('region', { name: 'From Agent · 🧠 Ana' })
    fireEvent.click(within(head).getByText('Its own memory'))
    fireEvent.click(await screen.findByText('Edit with chat'))

    expect(useStore.getState().memoryMode).toEqual({ path: '/data/agents/a1/memory.md', name: 'Its own memory' })
    expect(useStore.getState().composerFocusRequest).toBe(1)
    // "no longer opens another conversation" — doesn't touch the selected agent.
    expect(useStore.getState().selectedAgentId).toBe('b2')
  })
})

// Skills and Tools (scope): what it can use, each row with
// its owner; the project's switches live on the project page (or Settings) —
// Tools here switch only this agent's own line.
describe('AgentPage — Skills and Tools: what it can use, by owner', () => {
  it('Skills shows only the skills that load (active), grouped project · you, without a switch', async () => {
    mockedApi.skillsCatalog.mockResolvedValue([
      { name: 'heartbeat', source: 'project', state: 'active', description: 'beat' },
      { name: 'dormant', source: 'project', state: 'held' },
      { name: 'loop', source: 'plugin', state: 'available' },
      { name: 'deploy', source: 'user', state: 'active', description: 'ship it' },
    ])
    open(makeAgent({ id: 'a1', name: 'Ana', folder: '/home/user/ana' }), 'skills')
    render(<AgentPage />)
    expect(currentSection()).toBe('Skills')
    const project = await screen.findByRole('region', { name: 'From Project · ana' })
    expect(within(project).getByText('heartbeat')).toBeInTheDocument()
    expect(within(screen.getByRole('region', { name: 'From This machine' })).getByText('deploy')).toBeInTheDocument()
    expect(screen.queryByText('dormant')).not.toBeInTheDocument()
    expect(screen.queryByText('loop')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^(Turn off|Turn on|Add)$/ })).not.toBeInTheDocument()
    expect(sectionButton('Skills')).toHaveTextContent('Skills2')
    // what the folder holds back is said at the foot, with the door to switch it
    expect(screen.getByTestId('library-foot')).toHaveTextContent(/1 turned off.*1 could be added/)
    fireEvent.click(within(within(project).getByTestId('owner-header')).getByRole('button', { name: /in ana ›$/ }))
    expect(useStore.getState().page).toEqual({ kind: 'project', folder: '/home/user/ana' })
    expect(useStore.getState().projectTab).toBe('skills')
  })

  it("Tools lists the MCP servers it starts with — the folder's under the project, the rest yours", async () => {
    mockedApi.agents.loaded.mockResolvedValue({
      engine: 'Claude Code',
      folder: '/home/user/ana',
      instructions: [],
      injections: [],
      outputStyle: null,
      toolsDoor: true,
      notes: [],
      mcp: [
        { name: 'railway', source: 'project', from: '.mcp.json' },
        { name: 'context7', source: 'plugin', from: 'context7' },
      ],
    })
    open(makeAgent({ id: 'a1', name: 'Ana', folder: '/home/user/ana' }), 'tools')
    render(<AgentPage />)
    expect(currentSection()).toBe('Tools')
    expect(within(await screen.findByRole('region', { name: 'From Project · ana' })).getByText('railway')).toBeInTheDocument()
    expect(within(screen.getByRole('region', { name: 'From This machine' })).getByText('context7')).toBeInTheDocument()
    expect(sectionButton('Tools')).toHaveTextContent('Tools2')
  })

  // spec scopes §5 (T4): Agent › Tools is the house of «this agent» — its
  // plain switch writes the agent's line only; a row it alone holds stays
  // listed; a line a wider place locks writes nothing
  it('Tools: the plain switch acts for this agent only; what it alone holds stays listed; a locked line writes nothing', async () => {
    const lr = (key: string, name: string, agentLine: object, state: 'active' | 'held' = 'active') => ({
      key,
      engine: 'Claude Code',
      kind: 'mcp',
      name,
      label: name,
      exact: true,
      origin: { owner: 'project', carrier: '.mcp.json' },
      state,
      family: 'off-only',
      at: [
        { place: 'project', result: state === 'active' ? 'on' : 'off', keptIn: '.claude/settings.local.json' },
        { place: 'agent', agent: 'a1', agentName: 'Ana', switch: { names: [name] }, ...agentLine },
      ],
    })
    mockedApi.folders.loads.mockResolvedValue({
      folder: '/home/user/ana',
      engines: [{ id: 'claude-code', label: 'Claude Code', switches: true }],
      logins: [],
      notes: [],
      origins: [],
      basis: { readings: 0, notices: 0, consoles: 0 },
      rows: [
        lr('mcp:project:railway', 'railway', { result: 'on' }),
        lr('mcp:project:github', 'github', { entry: 'off', result: 'off' }),
        lr('mcp:project:stripe', 'stripe', { result: 'off', locked: { why: 'organization' } }),
        lr('mcp:project:linear', 'linear', { result: 'off' }, 'held'),
      ],
    } as never)
    mockedApi.folders.loadsSwitch.mockResolvedValue({ folder: '/home/user/ana', ok: true })
    mockedApi.folders.loadsCheck.mockResolvedValue({ targets: [], running: null })
    open(makeAgent({ id: 'a1', name: 'Ana', folder: '/home/user/ana' }), 'tools')
    try {
      render(<AgentPage />)
      const project = await screen.findByRole('region', { name: 'From Project · ana' })
      await waitFor(() => expect(mockedApi.folders.loads).toHaveBeenCalledWith('/home/user/ana', 'a1'))
      // the project keeps linear off: not listed, counted at the foot
      expect(within(project).queryByText('linear')).not.toBeInTheDocument()
      const item = (name: string) => within(project).getByText(name).closest('li')!
      fireEvent.click(within(item('railway')).getByRole('button', { name: 'Turn off' }))
      await waitFor(() => expect(mockedApi.folders.loadsSwitch).toHaveBeenCalledWith('/home/user/ana', 'mcp:project:railway', 'off', 'a1'))
      fireEvent.click(within(item('github')).getByRole('button', { name: 'Turn on' }))
      await waitFor(() => expect(mockedApi.folders.loadsSwitch).toHaveBeenCalledWith('/home/user/ana', 'mcp:project:github', 'on', 'a1'))
      // a line the organization decides opens its block instead of writing
      fireEvent.click(within(item('stripe')).getByRole('button', { name: 'Turn on' }))
      expect(within(item('stripe')).getByTestId('where-it-loads')).toBeInTheDocument()
      expect(mockedApi.folders.loadsSwitch).toHaveBeenCalledTimes(2)
    } finally {
      mockedApi.folders.loads.mockReset()
      mockedApi.folders.loadsCheck.mockReset()
    }
  })

  // a door that named a row (the column's «Turn off ›» on a server that
  // didn't start): the agent's Tools tab opens ON that row, by its key
  it('Tools opened by a door naming a row (openDossier with its key) opens that row', async () => {
    const lr = (key: string, name: string) => ({
      key,
      engine: 'Claude Code',
      kind: 'mcp',
      name,
      label: name,
      exact: true,
      origin: { owner: 'project', carrier: '.mcp.json' },
      state: 'active',
      family: 'off-only',
      detail: `https://${name}.example.com`,
      at: [
        { place: 'project', result: 'on', keptIn: '.claude/settings.local.json' },
        { place: 'agent', agent: 'a1', agentName: 'Ana', switch: { names: [name] }, result: 'on' },
      ],
    })
    mockedApi.folders.loads.mockResolvedValue({
      folder: '/home/user/ana',
      engines: [{ id: 'claude-code', label: 'Claude Code', switches: true }],
      logins: [],
      notes: [],
      origins: [],
      basis: { readings: 0, notices: 0, consoles: 0 },
      rows: [lr('mcp:project:railway', 'railway'), lr('mcp:project:github', 'github')],
    } as never)
    mockedApi.folders.loadsCheck.mockResolvedValue({ targets: [], running: null })
    open(makeAgent({ id: 'a1', name: 'Ana', folder: '/home/user/ana' }), 'identity')
    useStore.getState().openDossier('tools', { item: 'mcp:project:github' })
    try {
      render(<AgentPage />)
      expect(currentSection()).toBe('Tools')
      await waitFor(() => expect(screen.getByTestId('item-owner').parentElement!).toHaveTextContent('github.example.com'))
      expect(screen.getByTestId('item-owner').parentElement!).not.toHaveTextContent('railway.example.com')
      // the next move clears it
      useStore.getState().changeTab('skills')
      expect(useStore.getState().dossierItem).toBeNull()
    } finally {
      mockedApi.folders.loads.mockReset()
      mockedApi.folders.loadsCheck.mockReset()
    }
  })

  it('the cover names Skills and Tools in one door tile each', async () => {
    mockedApi.skillsCatalog.mockResolvedValue([
      { name: 'heartbeat', source: 'project', state: 'active' },
      { name: 'dormant', source: 'project', state: 'held' },
    ])
    mockedApi.agents.loaded.mockResolvedValue({
      engine: 'Claude Code',
      folder: '/home/user/ana',
      instructions: [],
      injections: [],
      outputStyle: null,
      toolsDoor: true,
      notes: [],
      mcp: [{ name: 'railway', source: 'project', from: '.mcp.json' }],
    })
    open(makeAgent({ id: 'a1', name: 'Ana', folder: '/home/user/ana' }), 'threads')
    render(<AgentPage />)
    // the figure is the tile's lead: active skills only (the held one is not counted)
    await waitFor(() => expect(screen.getByTestId('door-skills')).toHaveTextContent('1 skill'))
    fireEvent.click(screen.getByTestId('door-skills'))
    expect(currentSection()).toBe('Skills')
    fireEvent.click(sectionButton('Now'))
    const tools = screen.getByTestId('door-tools')
    await waitFor(() => expect(within(tools).getByText('1 MCP server')).toBeInTheDocument())
    fireEvent.click(tools)
    expect(currentSection()).toBe('Tools')
  })
})

// At start: what a NEW conversation of the agent
// starts with, MEASURED per mode (console · chat · automation runs, never
// mixed) — the median first-reply total of its last conversations of that
// mode, then its newest one part by part. Nothing measured → one sentence.
describe('AgentPage — At start: measured per mode', () => {
  const mode = (total: number, n: number, id: string, owners: Record<string, number>) => ({
    n,
    total,
    range: [total - 1000, total + 1000] as [number, number],
    owners,
    latest: { folder: 'f', id, at: null, login: null },
  })
  const measured = {
    console: mode(87_362, 3, 'c-newest', { agent: 158, project: 25_000, silos: 3_000, you: 16_000, engine: 43_204 }),
    run: mode(47_269, 10, 'r-newest', { project: 20_000, silos: 9_000, engine: 18_269 }),
  }
  const started = (id: string) => ({
    totalTokens: id === 'c-newest' ? 88_000 : 47_000,
    at: '2026-11-01T10:00:00Z',
    measured: true,
    mode: 'console' as const,
    parts: [
      { owner: 'conversation' as const, kind: 'first', label: 'first', chars: 40, tokens: 10, ref: 'first' },
      { owner: 'engine' as const, kind: 'system', label: 'system', chars: 4000, tokens: 1000 },
    ],
    pendingMcp: 0,
    pendingMcpServers: [],
    failedMcpServers: [],
    now: null,
    contextNow: null,
    accounts: [],
  })

  it('a mode switch picks the measurement; each mode shows its newest conversation part by part', async () => {
    mockedApi.agents.startedWith.mockResolvedValue(measured)
    mockedApi.startedWith.mockImplementation(async (_f, id) => started(id))
    open(makeAgent({ id: 'a1', name: 'Ana', folder: '/home/user/ana' }), 'loaded')
    render(<AgentPage />)
    expect(currentSection()).toBe('At start')
    const view = await screen.findByTestId('at-start')
    expect(mockedApi.agents.startedWith).toHaveBeenCalledWith('a1')
    // only the modes it has (no chat measured → no Chat option); the console leads
    const modes = within(view).getByRole('group', { name: 'Mode' })
    expect(
      within(modes)
        .getAllByRole('button')
        .map((b) => b.textContent?.replace(/~.*$/, '').trim()),
    ).toEqual(['Console', 'Automation runs'])
    expect(within(view).getByRole('region', { name: 'At start' })).toHaveTextContent('87,362')
    expect(within(view).getByRole('region', { name: 'At start' })).toHaveTextContent(/last 3 .*86,362–88,362/)
    await waitFor(() => expect(mockedApi.startedWith).toHaveBeenCalledWith('f', 'c-newest'))
    // off a conversation, the conversation's part is its first message
    await waitFor(() => expect(view.querySelector('[data-owner="conversation"]')).toHaveTextContent('First message'))
    fireEvent.click(within(modes).getByRole('button', { name: /^Automation runs/ }))
    expect(within(view).getByRole('region', { name: 'At start' })).toHaveTextContent('47,269')
    await waitFor(() => expect(mockedApi.startedWith).toHaveBeenCalledWith('f', 'r-newest'))
  })

  it('one mode measured → no switch', async () => {
    mockedApi.agents.startedWith.mockResolvedValue({ run: measured.run })
    mockedApi.startedWith.mockImplementation(async (_f, id) => started(id))
    open(makeAgent({ id: 'a1', name: 'Ana', folder: '/home/user/ana' }), 'loaded')
    render(<AgentPage />)
    const view = await screen.findByTestId('at-start')
    expect(within(view).queryByRole('group', { name: 'Mode' })).toBeNull()
    expect(within(view).getByRole('region', { name: 'At start' })).toHaveTextContent('47,269')
  })

  it('nothing measured in any mode → one sentence, never an estimate', async () => {
    mockedApi.agents.startedWith.mockResolvedValue({})
    open(makeAgent({ id: 'a1', name: 'Ana', folder: '/home/user/ana' }), 'loaded')
    render(<AgentPage />)
    expect(await screen.findByText(/Nothing measured for Ana/)).toBeInTheDocument()
    expect(screen.queryByTestId('at-start')).toBeNull()
    expect(mockedApi.startedWith).not.toHaveBeenCalled()
  })

  it('Now shows the Messages and At start tiles only with data — and each lands on its tab', async () => {
    mockedApi.agents.startedWith.mockResolvedValue(measured)
    mockedApi.messages.list.mockResolvedValue([{ id: 'm1', from: 'builder', to: 'a1', at: '2026-11-01T10:00:00Z', text: 'x', state: 'new' }])
    open(makeAgent({ id: 'a1', name: 'Ana', folder: '/home/user/ana' }), 'threads')
    render(<AgentPage />)
    expect(await screen.findByTestId('door-starts')).toHaveTextContent('87,362')
    expect(await screen.findByTestId('door-messages')).toHaveTextContent('1 new')
    fireEvent.click(screen.getByTestId('door-starts'))
    expect(useStore.getState().tab).toBe('loaded')
    expect(currentSection()).toBe('At start')
    fireEvent.click(sectionButton('Now'))
    fireEvent.click(screen.getByTestId('door-messages'))
    expect(useStore.getState().tab).toBe('inbox')
    expect(currentSection()).toBe('Messages')
  })
})

// the agent page's automations are a POINTER: one short row
// each (name · state word · next/last) opening the automation's own page.
// No runs, no Run now / Pause / Delete / Edit here — those live on that
// page. "+ new" opens the automation editor with the agent chosen.
// the agent's automations are set on its Automations tab (the old
// «control» address); Now says how they went (owner 24-11)
describe('AgentPage — its automations (the automations resident)', () => {
  it('with no automations, shows the empty state', () => {
    open(makeAgent({ id: 'a1', name: 'Ana' }), 'control')
    render(<AgentPage />)
    expect(currentSection()).toBe('Automations')
    const row = screen.getByTestId('agent-automations')
    expect(within(row).queryByTestId('automation-item')).toBeNull()
    expect(within(row).getByRole('button', { name: /New automation/ })).toBeInTheDocument()
  })

  it("lists only THIS agent's automations — name and next run — each row pointing to its page; no actions, no runs", () => {
    open(makeAgent({ id: 'a1', name: 'Ana' }), 'control')
    useStore.setState({
      automations: [
        makeAutomation({
          id: 'a-mine',
          agentId: 'a1',
          name: 'Morning standup',
          trigger: { kind: 'cron', expr: '0 9 * * 1-5' },
          nextRunAt: '2026-08-20T09:00:00.000Z',
        }),
        makeAutomation({ id: 'a-other', agentId: 'other', name: 'Not mine' }),
      ],
    })
    render(<AgentPage />)
    expect(screen.getByText('Morning standup')).toBeInTheDocument()
    expect(screen.queryByText('Not mine')).not.toBeInTheDocument()
    expect(screen.getByText(/^next /)).toBeInTheDocument()
    expect(screen.queryByText('Run now')).toBeNull()
    expect(screen.queryByText('Delete')).toBeNull()
    expect(mockedApi.automations.runs).not.toHaveBeenCalled()
    fireEvent.click(screen.getByText('Morning standup'))
    expect(useStore.getState().page).toEqual({ kind: 'automation', id: 'a-mine' })
  })

  it('paused shows as a word; a finished once reads "done" (never "paused"); a failed last run is named', () => {
    open(makeAgent({ id: 'a1', name: 'Ana' }), 'control')
    useStore.setState({
      automations: [
        makeAutomation({ id: 'p', name: 'Paused one', paused: true }),
        makeAutomation({
          id: 'd',
          name: 'Done one',
          trigger: { kind: 'once', at: '2026-08-29T10:00:00Z' },
          paused: true,
          lastRun: { at: '2026-08-29T10:00:30Z', status: 'ok', durationMs: 1000 },
        }),
        makeAutomation({ id: 'f', name: 'Failed one', lastRun: { at: '2026-08-29T10:00:30Z', status: 'failed', durationMs: 1000 } }),
      ],
    })
    render(<AgentPage />)
    const item = (name: string): HTMLElement => screen.getByText(name).closest<HTMLElement>('[data-testid="automation-item"]')!
    expect(within(item('Paused one')).getByText('paused')).toBeInTheDocument()
    expect(within(item('Done one')).getByText('done')).toBeInTheDocument()
    expect(within(item('Done one')).queryByText('paused')).toBeNull()
    expect(within(item('Failed one')).getByText('last run failed')).toBeInTheDocument()
    // the tab holds them all: no door to the rest
    expect(screen.queryByTestId('agent-automations-all')).toBeNull()
  })

  it('Now shows three at most — the ones that need a look first — and one door to all of them, on its Automations tab', () => {
    open(makeAgent({ id: 'a1', name: 'Ana', folder: '/home/user/ana' }), 'threads')
    useStore.setState({
      automations: [
        makeAutomation({ id: 'p', name: 'Paused one', paused: true }),
        makeAutomation({ id: 'r1', name: 'Armed one' }),
        makeAutomation({ id: 'r2', name: 'Armed two' }),
        makeAutomation({ id: 'f', name: 'Failed one', lastRun: { at: '2026-08-29T10:00:30Z', status: 'failed', durationMs: 1000 } }),
      ],
    })
    render(<AgentPage />)
    const items = screen.getAllByTestId('automation-item')
    expect(items).toHaveLength(3)
    expect(items[0]).toHaveTextContent('Failed one')
    expect(screen.queryByText('Paused one')).toBeNull()
    // Now has no «New»: it is set on the tab
    expect(within(screen.getByTestId('agent-automations')).queryByRole('button', { name: /New automation/ })).toBeNull()
    fireEvent.click(screen.getByTestId('agent-automations-all'))
    expect(useStore.getState().tab).toBe('control')
    expect(currentSection()).toBe('Automations')
    expect(screen.getAllByTestId('automation-item')).toHaveLength(4)
  })

  it('«New automation» opens the automation editor with this agent already chosen (/automation/new?agent=a1)', () => {
    open(makeAgent({ id: 'a1', name: 'Ana', folder: '/home/user/ana' }), 'control')
    render(<AgentPage />)
    fireEvent.click(within(screen.getByTestId('agent-automations')).getByRole('button', { name: /New automation/ }))
    expect(useStore.getState().page).toEqual({ kind: 'automation', id: 'new', agent: 'a1' })
    expect(screen.queryByRole('dialog')).toBeNull() // no inline sheet any more
  })
})

// "Board" is no longer a tab — it's Threads's Board toggle (the same data,
// two shapes). The engine is still the global Board filtered to THIS agent
// via a FIXED agent=<id> facet filter.

// Memory and Vault are tabs — and they must render on BOTH
// surfaces: the dossier and the facet pane over an open conversation (one
// TabBody switch; two hand-kept copies had diverged and the facet came up empty).
describe('AgentPage — Memory and Vault render as dossier tab AND when reached from a conversation', () => {
  it('Vault: the agent-side view mounts when reached from an open conversation', async () => {
    mockedApi.vault.list.mockResolvedValue([
      { id: 'v1', name: 'DATABASE_URL', value: '…lway', scope: { type: 'folder', folder: '/home/user/ana' }, createdAt: '2026-08-25T00:00:00Z' },
    ])
    openFromConversation(makeAgent({ id: 'a1', name: 'Ana', folder: '/home/user/ana' }), makeSession(), 'vault')
    render(<AgentPage />)
    expect(await screen.findByText('DATABASE_URL')).toBeInTheDocument()
    expect(screen.getAllByText('Project · ana').length).toBeGreaterThan(0) // provenance chip, the one label
    expect(screen.getByText('Add for Ana')).toBeInTheDocument()
  })
  it('Vault: same view as a dossier tab', async () => {
    mockedApi.vault.list.mockResolvedValue([
      { id: 'v2', name: 'STRIPE_KEY', value: '…1234', scope: { type: 'agents', agentIds: ['a1'] }, createdAt: '2026-08-25T00:00:00Z' },
    ])
    open(makeAgent({ id: 'a1', name: 'Ana', folder: '/home/user/ana' }), 'vault')
    render(<AgentPage />)
    expect(await screen.findByText('STRIPE_KEY')).toBeInTheDocument()
    expect(screen.getAllByText('Agent · Ana').length).toBeGreaterThan(0)
    expect(screen.getByText('delete')).toBeInTheDocument() // only the agent's own entries can be deleted here
  })
  it('Memory: mounts when reached from an open conversation and asks for the agent layers', async () => {
    openFromConversation(makeAgent({ id: 'a1', name: 'Ana', folder: '/home/user/ana' }), makeSession(), 'memory')
    render(<AgentPage />)
    await waitFor(() => expect(mockedApi.memory.list).toHaveBeenCalledWith('/home/user/ana', 'a1'))
  })
})

// opening a KNOWN conversation never shows anything it isn't (never «New
// conversation» until it loads). Its identity — title, folder —
// is in the overview before the transcript fetch; only the transcript loads,
// and that is the one place that shows a loader (in place, no modal).
describe('AgentPage — opening a conversation: identity first, a loader where the transcript goes', () => {
  it('the header shows the real title from the overview while detail is still null — never "New conversation"', async () => {
    const agent = makeAgent({ id: 'a1', name: 'Ana', sessions: [makeSession({ id: 's1', folder: 'f', title: 'Fix the parser', agentId: 'a1' })] })
    useStore.setState({ agents: [agent], selectedAgentId: 'a1', page: { kind: 'agent', id: 'a1' }, selected: { folder: 'f', id: 's1' }, detail: null })
    render(<AgentPage />)
    expect(screen.getByText('Fix the parser')).toBeInTheDocument()
    expect(screen.queryByText('New conversation')).toBeNull()
    // the body is a loader, not the "pick a conversation" empty state
    expect(screen.queryByTestId('empty-state')).toBeNull()
    expect(await screen.findByTestId('transcript-loading')).toBeInTheDocument()
  })

  it('a selected conversation the overview cannot name yet says "Loading…" — the "New conversation" placeholder is ONLY for a new one', () => {
    // the overview hasn't listed this session (page reload straight into
    // its URL, or a session outside the agent's list): no title from any
    // source, but a conversation IS selected → loading, not "new".
    useStore.setState({
      agents: [makeAgent({ id: 'a1', name: 'Ana', sessions: [] })],
      selectedAgentId: 'a1',
      page: { kind: 'agent', id: 'a1' },
      selected: { folder: 'f', id: 'ghost' },
      detail: null,
    })
    render(<AgentPage />)
    expect(screen.getByTestId('title-loading')).toHaveTextContent('Loading…')
    expect(screen.queryByText('New conversation')).toBeNull()
  })

  it('Anywhere (master): the project selector is NOT offered while a known conversation loads', async () => {
    const master = makeAgent({
      id: MASTER_ID,
      name: 'Anywhere',
      folder: null,
      sessions: [makeSession({ id: 's9', folder: 'f', title: 'Ops', agentId: MASTER_ID, cwd: '/home/u/proj' })],
    })
    useStore.setState({
      agents: [master, makeAgent({ id: 'a1', name: 'Ana' })],
      selectedAgentId: MASTER_ID,
      page: { kind: 'agent', id: MASTER_ID },
      selected: { folder: 'f', id: 's9' },
      detail: null,
    })
    render(<AgentPage />)
    expect(screen.getByText('Ops')).toBeInTheDocument()
    expect(screen.queryByText('New conversation')).toBeNull()
    expect(screen.queryByTestId('project-selector')).toBeNull()
    // the known cwd already names the project in the crumbs (where it lives)
    expect(within(screen.getByRole('navigation', { name: 'Where this lives' })).getByRole('button', { name: 'proj' })).toBeInTheDocument()
    expect(await screen.findByTestId('transcript-loading')).toBeInTheDocument()
  })
})

// fork/resume lineage must be visible — a session with
// family (parentKey graph: /clear rotations + --resume forks) shows a
// mark in the sentence under the title; clicking it opens the family tree
// in the draggable window; a node navigates to that session.
// Where a conversation continues from: the header names the
// session right before this one, in words; the click reads it. A /clear
// started a NEW conversation — no line.
describe('AgentPage — "continues “X”" in the header', () => {
  const seed = (current: SessionView, others: SessionView[]): void => {
    useStore.setState({
      agents: [makeAgent({ id: 'a1', sessions: [current, ...others] })],
      page: { kind: 'agent', id: 'a1' },
      selected: { folder: current.folder, id: current.id },
      detail: { meta: current, turns: [], total: 0 },
    })
  }
  it('a continuation names its parent; the click opens exactly that session', () => {
    const parent = makeSession({ id: 'p1', folder: 'f', title: 'The origin', agentId: 'a1', mtime: 1 })
    seed(makeSession({ id: 's1', folder: 'f', title: 'Forked work', agentId: 'a1', mtime: 2, parentKey: 'f/p1' }), [parent])
    const openSpy = vi.fn()
    useStore.setState({ openSession: openSpy as never })
    render(<AgentPage />)
    const line = screen.getByTestId('continues-from')
    expect(line).toHaveTextContent(/continues\s*“The origin”/)
    fireEvent.click(within(line).getByRole('button', { name: /The origin/ }))
    expect(openSpy).toHaveBeenCalledWith('f', 'p1', { exact: true })
  })

  it('a /clear child or a root shows no line', () => {
    const parent = makeSession({ id: 'p1', folder: 'f', title: 'The origin', agentId: 'a1', mtime: 1 })
    seed(makeSession({ id: 's1', folder: 'f', agentId: 'a1', mtime: 2, parentKey: 'f/p1', parentKind: 'clear' }), [parent])
    const { unmount } = render(<AgentPage />)
    expect(screen.queryByTestId('continues-from')).not.toBeInTheDocument()
    unmount()
    seed(makeSession({ id: 's2', folder: 'f', agentId: 'a1' }), [])
    render(<AgentPage />)
    expect(screen.queryByTestId('continues-from')).not.toBeInTheDocument()
  })
})

// a click on an automation from within a conversation (the column, the
// sidebar's category) → its full context OVER the transcript: the agent's
// automations facet, landing on that automation — unfolded, accented.
// the agent page's automations are a pointer: one short row
// each, no runs, no actions — the click opens the automation's own page.
describe('AgentPage — automations point to their own page', () => {
  it('a row names the automation and its state; clicking it opens /automation/:id; no runs or actions inline', () => {
    const auto = (id: string, name: string, extra: Partial<Automation> = {}): Automation => ({
      id,
      name,
      agentId: 'a1',
      prompt: 'p',
      trigger: { kind: 'cron', expr: '0 9 * * *' },
      thread: { mode: 'new' },
      approval: false,
      keepAlive: false,
      paused: false,
      createdAt: '2026-08-01T00:00:00.000Z',
      ...extra,
    })
    useStore.setState({
      agents: [makeAgent({ id: 'a1', name: 'Ana' })],
      page: { kind: 'agent', id: 'a1' },
      selectedAgentId: 'a1',
      selected: null,
      automations: [auto('x', 'Digest'), auto('y', 'Sweep', { paused: true })],
      tab: 'control',
    })
    render(<AgentPage />)
    const items = screen.getAllByTestId('automation-item')
    expect(items).toHaveLength(2)
    expect(within(items[1]!).getByText('paused')).toBeInTheDocument()
    expect(screen.queryByText('Run now')).toBeNull()
    expect(screen.queryByText('Delete')).toBeNull()
    expect(mockedApi.automations.runs).not.toHaveBeenCalled()
    fireEvent.click(within(items[1]!).getByText('Sweep'))
    expect(useStore.getState().page).toEqual({ kind: 'automation', id: 'y' })
  })
})

// The agent-section slot (silo/SiloAgentSection.tsx) — support's compact
// section, now the Support silo parameterized by its manifest: it renders
// only when the agent holds records of a silo that asked for the slot, the
// open ones first, closed ones folded away; «all cases» opens the silo page.
describe('agent-section slot (the Support silo)', () => {
  const descriptor = (over: Record<string, unknown> = {}) => ({
    id: 'support',
    name: 'Support',
    description: null,
    version: '0.2.0',
    apiVersion: 'silo-standard/v0',
    state: 'active' as const,
    reason: 'installed',
    conventions: [],
    wants: [],
    kinds: ['support/case'],
    producer: { role: 'support', sync: null },
    records: { parsed: 1, failed: 0 },
    lastWrite: null,
    freshness: null,
    slots: { requested: ['rail', 'pulse', 'needs-you', 'agent-section'], granted: ['rail', 'needs-you', 'agent-section'], off: ['pulse'] },
    observedAt: '',
    ...over,
  })
  const row = (id: string, email: string, state: string, label: string) => ({
    key: `agent:finance/${id}`,
    id,
    identity: 's',
    state,
    stateLabel: label,
    at: '2026-08-26T09:00:00.000Z',
    anchors: { agent: 'finance' },
    cells: [
      { column: 'agent', text: 'finance' },
      { column: 'customerEmail', text: email },
      { column: 'state', text: label },
      { column: 'identity', text: 's' },
    ],
    row: 's',
    folded: false,
    needsYou: state === 'needs_owner',
    overlay: false,
    conflict: false,
    remarks: [],
    file: null,
  })
  const page = (records: ReturnType<typeof row>[], matching = records.length) => ({
    silo: { id: 'support', name: 'Support', state: 'active' as const, freshness: null },
    kind: {
      name: 'support/case',
      states: [
        { value: 'needs_owner', one: 'needs you', many: 'need you', terminal: false },
        { value: 'closed', one: 'closed', many: 'closed', terminal: true },
      ],
      columns: ['agent', 'customerEmail', 'state', 'identity'],
      facets: [],
      stateEdit: { field: 'status', values: ['needs_owner', 'closed'] },
    },
    total: matching,
    matching,
    offset: 0,
    limit: 5,
    said: null,
    unreadable: { count: 0, items: [] },
    records,
  })
  it('absent when no silo asked for the slot', async () => {
    mockedApi.silos.list.mockResolvedValue({ silos: [descriptor({ slots: { requested: ['rail'], granted: ['rail'], off: [] } })] })
    renderAgentPage('finance')
    await screen.findByTestId('agent-sections')
    expect(screen.queryByTestId('silo-support')).toBeNull()
    // the Tasks tile reads the plans silo on its own — the SLOT read is what
    // must not happen without a grant
    expect(mockedApi.silos.records.mock.calls.filter((c) => c[0] !== 'plans')).toEqual([])
  })
  it('absent when the agent holds none of its records', async () => {
    mockedApi.silos.list.mockResolvedValue({ silos: [descriptor()] })
    mockedApi.silos.records.mockResolvedValue(page([]))
    renderAgentPage('finance')
    await waitFor(() => expect(mockedApi.silos.records).toHaveBeenCalled())
    await screen.findByTestId('agent-sections')
    expect(screen.queryByTestId('silo-support')).toBeNull()
  })
  // tiles, never stacked lists: the slot is a tile on the
  // cover — how many are open, the first few (identity + state) — and the
  // full table with its state editing lives one click away on the silo page.
  it('present as a tile, scoped to this agent, waiting-on-you first; no inline table or state select', async () => {
    mockedApi.silos.list.mockResolvedValue({ silos: [descriptor()] })
    mockedApi.silos.records.mockResolvedValue(
      page([
        { ...row('a', 'a@example.com', 'needs_owner', 'needs you'), identity: 'Refund for Ana' },
        { ...row('c', 'c@example.com', 'open', 'open'), identity: 'Login trouble' },
      ]),
    )
    renderAgentPage('finance')
    const tile = await screen.findByTestId('silo-support')
    expect(mockedApi.silos.records).toHaveBeenCalledWith('support', { facets: { agent: 'finance' }, folded: 'exclude', rank: 'needs-you', limit: 5 })
    expect(tile).toHaveTextContent(/^Support/)
    expect(tile).toHaveTextContent('2 open cases, 1 waiting on you.')
    // preview lines in the server's rank (waiting on you first): identity + state
    expect(tile.textContent!.indexOf('Refund for Ana')).toBeLessThan(tile.textContent!.indexOf('Login trouble'))
    expect(within(tile).getByText('needs you')).toBeInTheDocument()
    // the agent column (and every other cell) stays on the silo page
    expect(within(tile).queryByText('finance')).toBeNull()
    expect(screen.queryByText('a@example.com')).toBeNull()
    expect(screen.queryByRole('combobox', { name: 'Set status' })).toBeNull()
    expect(mockedApi.silos.setField).not.toHaveBeenCalled()
    fireEvent.click(tile)
    expect(useStore.getState().page).toEqual({ kind: 'silo', id: 'support' })
  })
  it('only closed records: the tile shows, «No open cases.», its «All cases» door opens the silo page', async () => {
    mockedApi.silos.list.mockResolvedValue({ silos: [descriptor()] })
    mockedApi.silos.records.mockImplementation(async (_id, q) =>
      q?.folded === 'include' ? page([row('b', 'closed@example.com', 'closed', 'closed')]) : page([]),
    )
    renderAgentPage('finance')
    const tile = await screen.findByTestId('silo-support')
    expect(within(tile).getByText('No open cases.')).toBeTruthy()
    expect(tile).toHaveTextContent('All cases ›')
    expect(screen.queryByText('closed@example.com')).toBeNull()
    fireEvent.click(tile)
    expect(useStore.getState().page).toEqual({ kind: 'silo', id: 'support' })
  })
})

// births (plugin 0.7.0): nested runs with no parent conversation to fold
// under (an agent's own `claude -p`, parent unknown) are the agent's — its
// page's Now says how many, and the link opens the newest.
describe('AgentPage — Now counts loose nested runs', () => {
  it('"N nested runs" with a link to the newest', () => {
    const openSpy = vi.fn()
    const n = (id: string, mtime: number, parent: string | null = null) =>
      makeSession({ id, folder: 'f', title: `run ${id}`, mtime, origin: { kind: 'nested', parent, agentId: 'a1' } })
    open(
      makeAgent({
        id: 'a1',
        sessions: [n('old', 1_000), n('new', 5_000), n('folded', 9_000, 'conv-1'), makeSession({ id: 'conv-1', mtime: 2_000 })],
        counts: { conversations: 1, runs: 0, runsByAutomation: {}, byCwd: {}, nestedLoose: 2 },
      }),
      'threads',
    )
    useStore.setState({ openSession: openSpy as never })
    render(<AgentPage />)
    const link = screen.getByRole('button', { name: /2 nested runs/ })
    fireEvent.click(link)
    expect(openSpy).toHaveBeenCalledWith('f', 'new')
  })

  it('no loose nested runs: no line', () => {
    open(
      makeAgent({ id: 'a1', sessions: [makeSession({ id: 'n', origin: { kind: 'nested', parent: 'conv', agentId: 'a1' } }), makeSession({ id: 'conv' })] }),
      'threads',
    )
    render(<AgentPage />)
    expect(screen.queryByText(/nested run/)).toBeNull()
  })
})

describe('AgentPage — Files › its own files: Delete only on top-level files of the primary folder', () => {
  it('deep row → no Delete; secondary top-level row → no Delete; primary top-level row → Delete', async () => {
    const f = (name: string, rel: string, folder: string) => ({
      name,
      rel,
      folder,
      path: `${folder}/context/a1/${rel}`,
      scope: 'agent' as const,
      size: 1,
      mtime: 1,
      kind: 'markdown' as const,
    })
    mockedApi.context.list.mockResolvedValue({
      shared: [],
      agent: [
        f('16-audit.md', 'analysis/16-audit.md', '/home/user/ana'),
        f('main.md', 'main.md', '/home/user/ana'),
        f('plan.md', 'plan.md', '/home/user/other'),
      ],
    })
    mockedApi.context.produced.mockResolvedValue([])
    mockedApi.file.meta.mockImplementation(async (path: string) => ({ path, kind: 'markdown', size: 1, mtime: 1 }) as never)
    open(makeAgent({ folders: ['/home/user/other'] }), 'context')
    render(<AgentPage />)
    const own = await screen.findByRole('region', { name: 'From Agent · 🧠 Ana' })
    // a file below the top level lists apart: the papers of its conversations
    const papers = await screen.findByRole('region', { name: 'From Agent · 🧠 Ana — papers' })
    const detailOf = async (rel: string, where: HTMLElement = own): Promise<void> => {
      fireEvent.click(within(where).getByText(rel))
      await screen.findByLabelText(new RegExp(`File · .*/${rel}$`))
    }
    await detailOf('main.md')
    expect(screen.getByLabelText('Delete main.md')).toBeTruthy()
    await detailOf('plan.md')
    expect(screen.queryByLabelText('Delete plan.md')).toBeNull()
    await detailOf('analysis/16-audit.md', papers)
    expect(screen.queryByLabelText('Delete 16-audit.md')).toBeNull()
  })
})

// third review round, defect 3: an agent page for an id the store doesn't
// list (archived, removed) never falls back to the console-starting Chat
describe('AgentPage — an agent the web does not list', () => {
  it('says so with doors back, and never opens a console or a conversation for that id', async () => {
    useStore.setState({
      agents: [makeAgent({ id: MASTER_ID, name: 'Anywhere', folder: null }), makeAgent({ id: 'a1' })],
      page: { kind: 'agent', id: 'old' },
      selectedAgentId: 'old',
      selected: null,
      newChatOpen: true,
      consoleMode: 'console',
    } as never)
    render(<AgentPage />)
    expect(screen.getByTestId('unknown-agent')).toHaveTextContent(/No agent «old» here/)
    await new Promise((r) => setTimeout(r, 20))
    expect(mockedApi.console).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: /Archived agents in Settings/ }))
    expect(useStore.getState().page).toEqual({ kind: 'settings', tab: 'archived' })
  })
})

// spec scopes T10: your personal instructions for THIS agent only — its
// line of «Where they load», kept by Silos (nothing in the folder written)
describe('AgentPage — Memory › your CLAUDE.md for this agent only', () => {
  it("the row's switch turns them off for this agent alone, never the folder's file", async () => {
    const line = (over: Record<string, unknown>) => ({
      folder: '/home/user/ana',
      engines: [
        {
          id: 'claude-code',
          label: 'Claude Code',
          state: 'on' as const,
          entries: [],
          logins: 1,
          rules: false,
          at: [
            { place: 'project', result: 'on' },
            { place: 'agent', agent: 'a1', agentName: 'Ana', result: 'on', switch: { names: [] }, ...over },
          ],
        },
      ],
    })
    mockedApi.memory.list.mockResolvedValue(
      makeLayers({ global: { name: 'CLAUDE.md', path: '/home/user/.claude/CLAUDE.md', scope: 'global', mtime: 0, exists: true, size: 400 } }),
    )
    mockedApi.folders.personal.mockResolvedValue(line({}) as never)
    mockedApi.folders.personalSwitchAt.mockResolvedValue(line({ entry: 'off', result: 'off' }) as never)
    open(makeAgent({ id: 'a1', name: 'Ana', folder: '/home/user/ana' }), 'memory')
    render(<AgentPage />)
    await waitFor(() => expect(mockedApi.folders.personal).toHaveBeenCalledWith('/home/user/ana', { agent: 'a1' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Turn off' }))
    await waitFor(() => expect(mockedApi.folders.personalSwitchAt).toHaveBeenCalledWith('/home/user/ana', 'off', { scope: 'agent', agent: 'a1' }))
    expect(mockedApi.folders.personalSwitch).not.toHaveBeenCalled()
  })
})

// spec scope-ui-review §4.3 (R6): «This conversation» lives on its agent's
// page opened FROM it — the row's «Where it loads» gains that
// conversation's line, switched through the conversation route with its
// session; opened any other way there is no such line. R4: the project
// line switches here too, after saying whom it reaches.
describe('AgentPage — opened from a conversation: its line in «Where it loads»', () => {
  const conv = makeSession({ id: 's1', folder: 'f', title: 'Fix the importer', cwd: '/home/user/ana' })
  const agent = makeAgent({ id: 'a1', name: 'Ana', folder: '/home/user/ana', sessions: [conv] })
  const project = { place: 'project', result: 'on', keptIn: '.claude/settings.local.json', switch: { names: ['github'] } }
  const agentLine = { place: 'agent', agent: 'a1', agentName: 'Ana', result: 'on', switch: { names: ['github'] } }
  const github = (at: object[]) => ({
    key: 'mcp:project:github',
    engine: 'Claude Code',
    kind: 'mcp',
    name: 'github',
    label: 'github',
    exact: true,
    origin: { owner: 'project', carrier: '.mcp.json' },
    state: 'active',
    family: 'off-only',
    at,
  })
  const read = (at: object[], over: object = {}) => ({
    folder: '/home/user/ana',
    engines: [{ id: 'claude-code', label: 'Claude Code', switches: true }],
    logins: [],
    notes: [],
    origins: [],
    basis: { readings: 0, notices: 0, consoles: 0 },
    rows: [github(at)],
    ...over,
  })
  const asAgent = read(
    [{ ...project, agents: ['Ana', 'Bea'] }, agentLine, { place: 'conversation', conversation: 't2', agent: 'a1', entry: 'off', result: 'off' }],
    { conversations: [{ thread: 't2', folder: 'f', id: 's2', title: 'Other' }] },
  )
  const asConversation = read(
    [
      project,
      agentLine,
      { place: 'agent', agent: 'b2', agentName: 'Bea', result: 'on' },
      { place: 'conversation', conversation: 't1', agent: 'a1', result: 'on', switch: { names: ['github'] } },
    ],
    { conversation: { thread: 't1', agent: 'a1' } },
  )
  const fromConversation = (tab: 'tools' | 'skills', from: { folder: string; id: string } | null) =>
    useStore.setState({ agents: [agent], page: { kind: 'agent', id: 'a1' }, tab, selected: null, detail: null, agentFrom: from })
  const block = async () => {
    const row = (await screen.findAllByText('github'))[0]!.closest('li')!
    fireEvent.click(within(row).getByTestId('where-toggle'))
    return within(row).getByTestId('where-it-loads')
  }
  beforeEach(() => {
    mockedApi.folders.loads.mockImplementation(async (_f: string, _a?: string, c?: string) => (c ? asConversation : asAgent) as never)
    mockedApi.folders.loadsCheck.mockResolvedValue({ targets: [], running: null })
    mockedApi.folders.loadsSwitchHere.mockResolvedValue({ folder: '/home/user/ana', ok: true })
    mockedApi.folders.loadsSwitchAt.mockResolvedValue({ folder: '/home/user/ana', ok: true })
  })

  it("Tools: the row's block has that conversation's line; its click posts for that conversation, with its session", async () => {
    try {
      fromConversation('tools', { folder: 'f', id: 's1' })
      render(<AgentPage />)
      await waitFor(() => expect(mockedApi.folders.loads).toHaveBeenCalledWith('/home/user/ana', undefined, 's1'))
      const where = await block()
      const line = await waitFor(() => {
        const l = where.querySelector('[data-place="conversation"]')
        expect(l).not.toBeNull()
        return l as HTMLElement
      })
      fireEvent.click(within(line).getByRole('switch'))
      await waitFor(() => expect(mockedApi.folders.loadsSwitchHere).toHaveBeenCalledWith('/home/user/ana', 'mcp:project:github', 'off', 's1'))
      expect(mockedApi.folders.loadsSwitch).not.toHaveBeenCalled()
    } finally {
      mockedApi.folders.loads.mockReset()
      mockedApi.folders.loadsCheck.mockReset()
    }
  })

  it("opened any other way: no conversation line, no conversation read — another conversation's entry is a door that opens this tab from it", async () => {
    try {
      fromConversation('tools', null)
      render(<AgentPage />)
      const where = await block()
      expect(where.querySelector('[data-place="conversation"]')).toBeNull()
      expect(mockedApi.folders.loads).not.toHaveBeenCalledWith('/home/user/ana', undefined, expect.anything())
      fireEvent.click(within(where).getByTestId('also-in-door'))
      expect(useStore.getState().agentFrom).toEqual({ folder: 'f', id: 's2' })
      expect(useStore.getState().page).toEqual({ kind: 'agent', id: 'a1' })
      expect(useStore.getState().tab).toBe('tools')
    } finally {
      mockedApi.folders.loads.mockReset()
      mockedApi.folders.loadsCheck.mockReset()
    }
  })

  it("the project line switches on an agent's page: whom it reaches is said first, then the project's place is written", async () => {
    try {
      fromConversation('tools', null)
      render(<AgentPage />)
      const where = await block()
      fireEvent.click(within(where).getByTestId('place-switch-project'))
      expect(mockedApi.folders.loadsSwitchAt).not.toHaveBeenCalled()
      const confirm = within(where).getByTestId('project-confirm')
      expect(confirm).toHaveTextContent('Bea')
      fireEvent.click(within(confirm).getByRole('button', { name: /^Turn off/ }))
      await waitFor(() => expect(mockedApi.folders.loadsSwitchAt).toHaveBeenCalledWith('/home/user/ana', 'mcp:project:github', 'off', 'project'))
    } finally {
      mockedApi.folders.loads.mockReset()
      mockedApi.folders.loadsCheck.mockReset()
    }
  })

  it("Skills: the conversation's line takes a position for that conversation alone", async () => {
    const skill = (conversation: boolean) => ({
      name: 'digest',
      source: 'project',
      state: 'active',
      at: [
        { place: 'project', result: 'on' },
        { place: 'agent', agent: 'a1', agentName: 'Ana', result: 'on', positions: ['on', 'off'] },
        ...(conversation ? [{ place: 'conversation', conversation: 't1', agent: 'a1', result: 'on', positions: ['on', 'off'] }] : []),
      ],
    })
    mockedApi.skillsCatalog.mockImplementation(async (_a: string, c?: string) => [skill(c !== undefined)] as never)
    mockedApi.folders.skillPositionAt.mockResolvedValue({ skills: [] })
    try {
      fromConversation('skills', { folder: 'f', id: 's1' })
      render(<AgentPage />)
      await waitFor(() => expect(mockedApi.skillsCatalog).toHaveBeenCalledWith('a1', 's1'))
      const row = (await screen.findAllByText('digest'))[0]!.closest('li')!
      await waitFor(() => expect(within(row).getByTestId('where-toggle')).toBeInTheDocument())
      fireEvent.click(within(row).getByTestId('where-toggle'))
      const line = await waitFor(() => {
        const l = within(row).getByTestId('skill-places').querySelector('[data-place="conversation"]')
        expect(l).not.toBeNull()
        return l as HTMLElement
      })
      fireEvent.click(within(line).getByRole('radio', { name: 'off' }))
      await waitFor(() =>
        expect(mockedApi.folders.skillPositionAt).toHaveBeenCalledWith('/home/user/ana', 'digest', 'project', 'off', {
          scope: 'conversation',
          conversation: 's1',
        }),
      )
    } finally {
      mockedApi.folders.loads.mockReset()
      mockedApi.folders.loadsCheck.mockReset()
      mockedApi.skillsCatalog.mockReset()
    }
  })
})

// spec memory-places T5 + the full Memory UI: every row GET /api/memory
// lists, a plain switch where the server marks the agent's line switchable;
// opened from a conversation, that conversation's line posts with its id.
describe("AgentPage — Memory: every instruction file, its switch, the conversation's line", () => {
  const F = '/home/user/ana'
  const row = (path: string, rel: string, kind: string, origin: string, over: object = {}) => ({
    path,
    real: path,
    rel,
    origin,
    kind,
    engineType: 'Project',
    engine: 'claude-code',
    reach: { scope: origin === 'agent' ? 'agent' : 'project', launches: ['console', 'chat'] },
    when: { at: 'start' },
    weight: { chars: 40, tokens: 10, as: 'disk' },
    bytes: 40,
    mtime: 1,
    editable: true,
    ...over,
  })
  const rows = [
    row(`${F}/CLAUDE.md`, 'CLAUDE.md', 'project', 'project'),
    row(`${F}/CLAUDE.local.md`, 'CLAUDE.local.md', 'private', 'private'),
    row(`${F}/AGENTS.md`, 'AGENTS.md', 'agents', 'project', { through: 'alone' }),
    row('/home/user/.silos/agents/a1/memory.md', 'memory.md', 'agent', 'agent'),
  ]
  const agentLine = { place: 'agent', agent: 'a1', agentName: 'Ana', result: 'on', switch: { names: [] } }
  const places = (conv: boolean) => ({
    folder: F,
    engines: [
      {
        id: 'claude-code',
        label: 'Claude Code',
        rows: [
          ...rows
            .slice(0, 3)
            .map((r) => ({
              path: r.path,
              key: `instruction:${r.path}`,
              family: 'off-only',
              at: [
                { place: 'project', result: 'on', keptIn: '.claude/settings.local.json', switch: { names: [r.path] } },
                agentLine,
                ...(conv ? [{ place: 'conversation', conversation: 't1', agent: 'a1', result: 'on', switch: { names: [r.path] } }] : []),
              ],
            })),
          { path: rows[3]!.path, key: 'instruction:agent', family: 'off-only', at: [], inert: 'Silos adds it' },
        ],
      },
    ],
    ...(conv ? { conversation: { thread: 't1', agent: 'a1' } } : {}),
  })
  beforeEach(() => {
    mockedApi.memory.list.mockResolvedValue(makeLayers({ rows: rows as never, places: [] }))
    mockedApi.folders.instructions.mockImplementation(
      async (_f: string, as?: { agent: string } | { conversation: string }) => places(!!as && 'conversation' in as) as never,
    )
    mockedApi.folders.instructionSwitch.mockResolvedValue(places(false) as never)
  })

  it("every row the server lists is drawn; each with a switchable agent line has its plain switch, which writes this agent's place", async () => {
    open(makeAgent({ id: 'a1', name: 'Ana', folder: F }), 'memory')
    render(<AgentPage />)
    for (const name of ['CLAUDE.md', 'CLAUDE.local.md', 'AGENTS.md', 'Its own memory']) expect((await screen.findAllByText(name)).length).toBeGreaterThan(0)
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Turn off' })).toHaveLength(3))
    const agentsRow = screen.getAllByText('AGENTS.md')[0]!.closest('li')!
    fireEvent.click(within(agentsRow).getByRole('button', { name: 'Turn off' }))
    await waitFor(() => expect(mockedApi.folders.instructionSwitch).toHaveBeenCalledWith(F, `${F}/AGENTS.md`, 'off', { scope: 'agent', agent: 'a1' }))
  })

  it("opened from a conversation: the row's block has its line, and its click posts for that conversation, with its session", async () => {
    const conv = makeSession({ id: 's1', folder: 'f', title: 'Fix the importer', cwd: F })
    mockedApi.folders.loads.mockImplementation(
      async (_f: string, _a?: string, c?: string) =>
        ({
          folder: F,
          engines: [],
          logins: [],
          notes: [],
          origins: [],
          basis: { readings: 0, notices: 0, consoles: 0 },
          rows: [],
          ...(c ? { conversation: { thread: 't1', agent: 'a1' } } : {}),
        }) as never,
    )
    try {
      useStore.setState({
        agents: [makeAgent({ id: 'a1', name: 'Ana', folder: F, sessions: [conv] })],
        page: { kind: 'agent', id: 'a1' },
        tab: 'memory',
        selected: null,
        detail: null,
        agentFrom: { folder: 'f', id: 's1' },
      })
      render(<AgentPage />)
      await waitFor(() => expect(mockedApi.folders.instructions).toHaveBeenCalledWith(F, { conversation: 's1' }))
      const li = (await screen.findAllByText('CLAUDE.local.md'))[0]!.closest('li')!
      fireEvent.click(await within(li).findByTestId('where-toggle'))
      const line = await waitFor(() => {
        const l = within(li).getByTestId('where-it-loads').querySelector('[data-place="conversation"]')
        expect(l).not.toBeNull()
        return l as HTMLElement
      })
      fireEvent.click(within(line).getByRole('switch'))
      await waitFor(() =>
        expect(mockedApi.folders.instructionSwitch).toHaveBeenCalledWith(F, `${F}/CLAUDE.local.md`, 'off', { scope: 'conversation', conversation: 's1' }),
      )
    } finally {
      mockedApi.folders.loads.mockReset()
    }
  })
})
