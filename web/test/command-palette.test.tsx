// command-palette.test.tsx — the command palette (⌘K, the one new
// floating element this phase) — open/close, filtering, keyboard
// navigation (↑↓ Enter), and Esc with the contract (preventDefault,
// doesn't cancel the active turn).
// The navigation entries (Home/Map/Automations/Settings/Memories/
// Skills, +Support only where an agent keeps cases) ALWAYS ride ahead of
// conversations in the same ↑↓/Enter flow — a universal navigator. The
// Map's views among them come from the MAP_VIEWS registry; «Map» opens its
// landing view, Uses.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { CommandPalette } from '../src/components/CommandPalette'
import { useStore } from '../src/store'
import type { AgentView, SessionView } from '../src/lib/types'

function makeAgent(overrides: Partial<AgentView> = {}): AgentView {
  return { id: 'a1', name: 'Ana', emoji: '🧠', folder: '/tmp/project-x', skills: [], sessions: [], liveCount: 0, sessionCount: 0, ...overrides }
}
function makeSession(overrides: Partial<SessionView> = {}): SessionView {
  return {
    id: 's1',
    folder: 'f',
    title: 'Session',
    skills: [],
    cwd: '/tmp/project-x',
    mtime: 1000,
    size: 1,
    turnCount: 1,
    live: false,
    worktree: false,
    native: true,
    agentId: 'a1',
    ...overrides,
  }
}

beforeEach(() => {
  useStore.setState({
    modal: null,
    // same criterion for the Silo Standard's entries: zero silos = nothing.
    silos: [],
    agents: [
      makeAgent({
        id: 'a1',
        name: 'Ana',
        sessions: [makeSession({ id: 's1', title: 'Fix the parser', mtime: 3000 }), makeSession({ id: 's2', title: 'Review README', mtime: 2000 })],
      }),
    ],
  })
})

describe('CommandPalette — open/close', () => {
  it('closed by default (modal !== palette)', () => {
    render(<CommandPalette />)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('⌘K opens it from anywhere', () => {
    render(<CommandPalette />)
    fireEvent.keyDown(window, { key: 'k', metaKey: true })
    expect(useStore.getState().modal).toBe('palette')
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('⌘K does not open the palette over another modal already open', () => {
    useStore.setState({ modal: 'shortcuts' })
    render(<CommandPalette />)
    fireEvent.keyDown(window, { key: 'k', metaKey: true })
    expect(useStore.getState().modal).toBe('shortcuts')
  })

  it('Esc closes it and calls preventDefault (must not read as cancel turn)', () => {
    useStore.setState({ modal: 'palette' })
    render(<CommandPalette />)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(useStore.getState().modal).toBeNull()
  })
})

describe('CommandPalette — search and keyboard navigation', () => {
  beforeEach(() => useStore.setState({ modal: 'palette' }))

  it('lists every conversation (all agents) with no filter', () => {
    render(<CommandPalette />)
    expect(screen.getByText('Fix the parser')).toBeInTheDocument()
    expect(screen.getByText('Review README')).toBeInTheDocument()
  })

  // a conversation a /clear left behind has no sidebar row (archived lives
  // only in the global search) — the palette finds it and says so
  it("a conversation left by /clear is listed with an 'archived' mark; the living one carries none", () => {
    const st = useStore.getState()
    useStore.setState({
      agents: st.agents.map((a, i) =>
        i === 0
          ? {
              ...a,
              sessions: [
                ...a.sessions,
                { ...a.sessions[0]!, id: 'fresh', title: 'After the clear', mtime: 4000, parentKey: 'f/s1', parentKind: 'clear' as const },
              ],
            }
          : a,
      ),
    })
    render(<CommandPalette />)
    fireEvent.keyDown(window, { key: 'k', metaKey: true })
    const marks = screen.getAllByTestId('palette-archived')
    expect(marks).toHaveLength(1)
    expect(marks[0]!.closest('button')?.textContent).toMatch(/Fix the parser/)
    expect(screen.getByText('After the clear').closest('button')?.textContent).not.toMatch(/archived/)
  })

  // an automation's conversation is findable and says so
  it("an automation-born conversation carries an '⚡ <automation>' affix; the owner's own carries none", () => {
    const st = useStore.getState()
    const a0 = st.agents[0]!
    useStore.setState({
      automations: [
        {
          id: 'digest',
          name: 'Daily digest',
          agentId: a0.id,
          prompt: 'p',
          trigger: { kind: 'cron', expr: '0 9 * * *' },
          thread: { mode: 'new' },
          approval: false,
          keepAlive: false,
          paused: false,
          createdAt: '2026-08-01T00:00:00.000Z',
        },
      ],
      agents: st.agents.map((a, i) =>
        i === 0
          ? {
              ...a,
              sessions: [
                ...a.sessions,
                { ...a.sessions[0]!, id: 'born-1', title: 'Digest run', origin: { kind: 'automation', automationId: 'digest', runId: 'r1' } },
              ],
            }
          : a,
      ),
    })
    render(<CommandPalette />)
    const affix = screen.getByTestId('palette-automation')
    expect(affix).toHaveTextContent('Daily digest')
    expect(affix.closest('[role="option"]')).toHaveTextContent('Digest run')
    expect(screen.getByText('Fix the parser').closest('[role="option"]')?.querySelector('[data-testid="palette-automation"]')).toBeNull()
  })

  it('typing filters by title', async () => {
    render(<CommandPalette />)
    fireEvent.change(screen.getByLabelText('search'), { target: { value: 'parser' } })
    await waitFor(() => expect(screen.queryByText('Review README')).not.toBeInTheDocument())
    expect(screen.getByText('Fix the parser')).toBeInTheDocument()
  })

  it('↓ moves the visual selection (aria-selected)', () => {
    render(<CommandPalette />)
    const options = screen.getAllByRole('option')
    expect(options[0]).toHaveAttribute('aria-selected', 'true')
    fireEvent.keyDown(document, { key: 'ArrowDown' })
    expect(options[0]).toHaveAttribute('aria-selected', 'false')
    expect(options[1]).toHaveAttribute('aria-selected', 'true')
  })

  it('Enter opens the selected conversation and closes the palette', () => {
    const selectAgent = vi.fn()
    const openSession = vi.fn().mockResolvedValue(undefined)
    useStore.setState({ selectAgent, openSession })
    render(<CommandPalette />)
    // the navigation entries go first, then the conversations: walking down
    // from the first row to the SECOND conversation ('Review README', lower
    // mtime) and pressing Enter opens it
    const target = screen.getAllByRole('option').findIndex((o) => o.textContent?.includes('Review README'))
    expect(target).toBeGreaterThan(0)
    for (let i = 0; i < target; i++) fireEvent.keyDown(document, { key: 'ArrowDown' })
    fireEvent.keyDown(document, { key: 'Enter' })
    expect(selectAgent).toHaveBeenCalledWith('a1')
    expect(openSession).toHaveBeenCalledWith('f', 's2')
    expect(useStore.getState().modal).toBeNull()
  })

  it('the last row keeps the query as the sidebar list filter — the list comes up, the palette closes', () => {
    useStore.setState({ filter: '', mobileView: 'chat', sidebarList: 'tasks' })
    render(<CommandPalette />)
    expect(screen.queryByTestId('palette-filter-list')).not.toBeInTheDocument() // nothing typed, nothing to keep
    fireEvent.change(screen.getByLabelText('search'), { target: { value: 'parser ' } })
    const options = screen.getAllByRole('option')
    expect(options[options.length - 1]).toHaveAttribute('data-testid', 'palette-filter-list')
    fireEvent.click(screen.getByTestId('palette-filter-list'))
    expect(useStore.getState().filter).toBe('parser')
    expect(useStore.getState().sidebarList).toBe('conversations')
    expect(useStore.getState().mobileView).toBe('list')
    expect(useStore.getState().modal).toBeNull()
  })

  it('a query that finds nothing still says so, beside the filter row', () => {
    render(<CommandPalette />)
    fireEvent.change(screen.getByLabelText('search'), { target: { value: 'zzqxnothing' } })
    expect(screen.getByText('No results.')).toBeInTheDocument()
  })

  it('clicking a row also opens it', () => {
    const selectAgent = vi.fn()
    const openSession = vi.fn().mockResolvedValue(undefined)
    useStore.setState({ selectAgent, openSession })
    render(<CommandPalette />)
    fireEvent.click(screen.getByText('Fix the parser'))
    expect(selectAgent).toHaveBeenCalledWith('a1')
    expect(openSession).toHaveBeenCalledWith('f', 's1')
  })
})

// the navigation entries — Home/Map/Uses/Automations/
// Settings/Memories/Skills (+Support only where an agent keeps cases),
// ⌘K as a "universal navigator". The Map's views among them come from
// the `MAP_VIEWS` registry, not from a hand-written line in the palette.
describe('CommandPalette — universal navigator', () => {
  beforeEach(() => useStore.setState({ modal: 'palette' }))

  it('with an empty query, the navigation entries appear first, with "Home" selected by default', () => {
    render(<CommandPalette />)
    for (const label of [
      'Home',
      'Tasks',
      'Usage',
      'System › Files',
      'Map',
      'Automations',
      'Settings',
      'Settings › Memories',
      'Settings › Skills',
      'Settings › Silos',
    ]) {
      expect(screen.getByRole('option', { name: label })).toBeInTheDocument()
    }
    expect(screen.getByRole('option', { name: 'Home' })).toHaveAttribute('aria-selected', 'true')
  })

  // Support is a standing surface — always listed, like the
  // sidebar rail (an empty page beats a hidden one).
  // «Map» opens its landing, Uses — never «Wiring», «Graph», «Lanes» or «Constellation»
  it('Enter on "Map" opens the bare Map — and no retired view is named', () => {
    render(<CommandPalette />)
    for (const gone of [/Constellation/, /Graph/, /Lanes/, /Wiring/, /Map › Uses/]) expect(screen.queryByRole('option', { name: gone })).toBeNull()
    fireEvent.click(screen.getByRole('option', { name: 'Map' }))
    expect(useStore.getState().page).toEqual({ kind: 'map' })
    expect(useStore.getState().modal).toBeNull()
  })

  it('no hand-written "Support" entry: support is a silo, listed like any active silo', () => {
    render(<CommandPalette />)
    expect(screen.queryByRole('option', { name: 'Support' })).toBeNull()
  })

  it('typing also filters the navigation entries by label', () => {
    render(<CommandPalette />)
    fireEvent.change(screen.getByLabelText('search'), { target: { value: 'memories' } })
    expect(screen.getByRole('option', { name: 'Settings › Memories' })).toBeInTheDocument()
    expect(screen.queryByRole('option', { name: 'Board' })).not.toBeInTheDocument()
  })

  it('Enter on "Home" (selected by default) lands on Home (page null) and closes the palette', () => {
    useStore.setState({ page: { kind: 'settings' } })
    render(<CommandPalette />)
    fireEvent.keyDown(document, { key: 'Enter' })
    expect(useStore.getState().page).toBeNull()
    expect(useStore.getState().modal).toBeNull()
  })

  it('clicking "Settings" navigates to page={settings}', () => {
    render(<CommandPalette />)
    fireEvent.click(screen.getByRole('option', { name: 'Settings' }))
    expect(useStore.getState().page).toEqual({ kind: 'settings' })
  })

  it('clicking "Settings › Skills" navigates to Settings with the Skills tab preselected', () => {
    render(<CommandPalette />)
    fireEvent.click(screen.getByRole('option', { name: 'Settings › Skills' }))
    expect(useStore.getState().page).toEqual({ kind: 'settings', tab: 'skills' })
  })

  it('Usage and Files are reachable by name', () => {
    render(<CommandPalette />)
    fireEvent.click(screen.getByRole('option', { name: 'Usage' }))
    expect(useStore.getState().page).toEqual({ kind: 'usage' })
    useStore.setState({ modal: 'palette' })
    render(<CommandPalette />)
    fireEvent.click(screen.getAllByRole('option', { name: 'System › Files' })[0]!)
    expect(useStore.getState().page).toEqual({ kind: 'files' })
  })

  it('clicking "Automations" opens the Automations page', () => {
    render(<CommandPalette />)
    fireEvent.click(screen.getByRole('option', { name: 'Automations' }))
    expect(useStore.getState().page).toEqual({ kind: 'automations' })
  })
})

// the Silo Standard's entries: every ACTIVE silo's list page rides
// the same navigator; with zero active silos nothing is added — the whole
// surface is invisible until the first installation.
describe('CommandPalette — silo entries', () => {
  const silo = (over: Record<string, unknown> = {}) => ({
    id: 'invoices',
    name: 'Invoices',
    description: null,
    version: '0.1.0',
    apiVersion: 'silo-standard/v0',
    state: 'active',
    reason: 'active',
    conventions: [],
    wants: [],
    kinds: ['invoices/invoice'],
    producer: null,
    records: { parsed: 0, failed: 0 },
    lastWrite: null,
    freshness: null,
    slots: { requested: [], granted: [], off: [] },
    observedAt: '2026-10-30T12:00:00Z',
    ...over,
  })

  it('with zero silos there is no silo entry at all', () => {
    useStore.setState({ modal: 'palette', silos: [] })
    render(<CommandPalette />)
    expect(screen.queryByRole('option', { name: 'Invoices' })).not.toBeInTheDocument()
  })

  it('an ACTIVE silo is an entry that opens its list page; a pending one is not', () => {
    useStore.setState({ modal: 'palette', silos: [silo(), silo({ id: 'documents', name: 'Documents', state: 'pending' })] as never })
    render(<CommandPalette />)
    expect(screen.queryByRole('option', { name: 'Documents' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('option', { name: 'Invoices' }))
    expect(useStore.getState().page).toEqual({ kind: 'silo', id: 'invoices' })
    expect(useStore.getState().modal).toBeNull()
  })
})

// a name is never bare — «silos» meant the agent, the
// project folder and the platform's page at once
describe('CommandPalette — typed entries', () => {
  beforeEach(() => useStore.setState({ modal: 'palette' }))

  it('the platform page, agents and projects say their type', () => {
    const selectAgent = vi.fn()
    const changePage = vi.fn()
    useStore.setState({
      selectAgent,
      changePage,
      agents: [
        makeAgent({ id: 'silos', name: 'Silos', folder: '/home/user/silos' }),
        makeAgent({ id: 'builder', name: 'Builder', folder: '/home/user/silos', folders: ['/home/user/ci'] }),
        makeAgent({ id: 'old', name: 'Old', folder: '/home/user/old', archived: true }),
      ],
    })
    render(<CommandPalette />)
    const labels = screen.getAllByRole('option').map((o) => o.textContent ?? '')
    expect(labels).toContain('Settings › Silos')
    expect(labels).not.toContain('Silos')
    expect(labels).toContain('Agent · Silos')
    expect(labels).toContain('Agent · Builder')
    expect(labels).toContain('Agent · Builder › Profile')
    expect(labels).toContain('Agent · Builder › Secrets')
    expect(labels).not.toContain('Agent · Old') // archived agents are not destinations
    // one entry per folder, secondary folders included
    expect(labels.filter((l) => l === 'Project · silos')).toHaveLength(1)
    expect(labels).toContain('Project · ci')
    fireEvent.click(screen.getByText('Agent · Builder'))
    expect(selectAgent).toHaveBeenCalledWith('builder')
  })

  // Anywhere (master) has no sidebar row: ⌘K is its page's door
  it('Anywhere is a typed agent entry too', () => {
    const selectAgent = vi.fn()
    useStore.setState({ selectAgent, agents: [makeAgent({ id: 'master', name: 'master', folder: null as unknown as string })] })
    render(<CommandPalette />)
    fireEvent.click(screen.getByText('Agent · Anywhere'))
    expect(selectAgent).toHaveBeenCalledWith('master')
  })

  it('typing «silos» finds all three, each with its type', () => {
    useStore.setState({ agents: [makeAgent({ id: 'silos', name: 'Silos', folder: '/home/user/silos' })] })
    render(<CommandPalette />)
    fireEvent.change(screen.getByLabelText('search'), { target: { value: 'silos' } })
    const labels = screen.getAllByRole('option').map((o) => o.textContent ?? '')
    expect(labels).toEqual(expect.arrayContaining(['Settings › Silos', 'Agent · Silos', 'Project · silos']))
  })
})
