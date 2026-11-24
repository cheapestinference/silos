// settings-page.test.tsx — SettingsPage.tsx — a vertical, grouped nav by
// what each thing IS: You (Access · Appearance ·
// Notifications) / Fleet (Accounts & providers · Engines · Territory ·
// Archived agents) / Library (Memories · Skills · Silos) / This install
// (Maintenance · About), and one content column shared by every section.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { SettingsPage } from '../src/components/SettingsPage'
import { useStore } from '../src/store'
import { api, ApiError } from '../src/lib/api'
import type { AgentSummary, MemoryLayers } from '../src/lib/types'

vi.mock('../src/lib/api', async (importOriginal) => {
  // keep the REAL ApiError class: components do `instanceof ApiError` and
  // read .status/.body — an auto-mocked constructor would drop both
  const real = await importOriginal<typeof import('../src/lib/api')>()
  const { vi: v } = await import('vitest')
  const mocked = v.mockObject ? v.mockObject(real) : real
  return { ...mocked, ApiError: real.ApiError }
})
const mockedApi = vi.mocked(api, { deep: true })

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
  // tab clicks NAVIGATE now (each section has its URL) — the global page
  // must not leak from one test's click into the next test's mount.
  useStore.setState({ page: null })
  vi.clearAllMocks()
  document.documentElement.classList.remove('dark')
  window.localStorage.removeItem('silos-dark')
  mockedApi.memory.list.mockResolvedValue(makeLayers())
  mockedApi.prefs.mockResolvedValue({})
  mockedApi.muted.mockResolvedValue([])
  useStore.setState({ agents: [], mobileView: 'chat' })
})

describe('SettingsPage — tabs', () => {
  it('starts on Access and navigates between tabs', async () => {
    mockedApi.account.mockResolvedValue(null)
    render(<SettingsPage />)
    expect(screen.getByRole('button', { name: 'Access', current: true } as never)).toBeInTheDocument()
    expect(screen.getByText('This browser')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'About' }))
    expect(screen.getByText(/Silos — local/)).toBeInTheDocument()
  })

  // the tab mounts ProvidersTab (details in providers-tab.test.tsx).
  it('the Accounts & providers tab exists and mounts its two sections', async () => {
    mockedApi.account.mockResolvedValue(null)
    mockedApi.providers.list.mockResolvedValue([])
    render(<SettingsPage />)
    fireEvent.click(screen.getByRole('button', { name: 'Accounts & providers' }))
    await waitFor(() => expect(screen.getByText('Claude accounts')).toBeInTheDocument())
    expect(screen.getByText('Inference providers')).toBeInTheDocument()
  })
})

describe('SettingsPage — Providers › Unattended turns', () => {
  const acct = {
    id: 'default',
    kind: 'claude-account',
    label: 'Claude (this machine)',
    account: { name: 'default', providerId: 'default', configDir: null, email: null, plan: null },
  }
  const key = { id: 'k1', kind: 'anthropic-compatible', label: 'Gateway', baseUrl: 'https://gw.example', apiKey: 'sk-…0000' }

  it('the switch reads «Each agent’s own account», links the policy (never paraphrases it) and saves a pick through PATCH', async () => {
    mockedApi.account.mockResolvedValue(null)
    mockedApi.providers.list.mockResolvedValue([acct, key] as never)
    mockedApi.platformSettings.get.mockResolvedValue({ unattendedProvider: null, keepOwnAccount: [] })
    mockedApi.platformSettings.setUnattendedProvider.mockResolvedValue({ unattendedProvider: 'k1', keepOwnAccount: ['OpenCode'] })
    render(<SettingsPage />)
    fireEvent.click(screen.getByRole('button', { name: 'Accounts & providers' }))
    const select = await screen.findByLabelText('Unattended turns run on')
    expect((select as HTMLSelectElement).value).toBe('')
    expect(screen.getByText(/Heartbeats, task wakes and automations use this/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Anthropic’s usage policy/ })).toHaveAttribute('href', 'https://www.anthropic.com/legal/aup')
    fireEvent.change(select, { target: { value: 'k1' } })
    await waitFor(() => expect(mockedApi.platformSettings.setUnattendedProvider).toHaveBeenCalledWith('k1'))
    expect(await screen.findByText('Agents on OpenCode keep their own account.')).toBeInTheDocument()
  })

  it('a refused pick says the server’s words', async () => {
    mockedApi.account.mockResolvedValue(null)
    mockedApi.providers.list.mockResolvedValue([acct, key] as never)
    mockedApi.platformSettings.get.mockResolvedValue({ unattendedProvider: null, keepOwnAccount: [] })
    mockedApi.platformSettings.setUnattendedProvider.mockRejectedValue(new Error("Gateway runs on none of your agents' engines — pick one that does"))
    render(<SettingsPage />)
    fireEvent.click(screen.getByRole('button', { name: 'Accounts & providers' }))
    fireEvent.change(await screen.findByLabelText('Unattended turns run on'), { target: { value: 'k1' } })
    expect(await screen.findByRole('alert')).toHaveTextContent("runs on none of your agents' engines")
  })
})

// what a new project starts with (spec tools-origin §8): one switch per
// class the engine declares; a switch sends the class's value, «Back to
// recommended» sends null (the stored choice goes)
describe('SettingsPage — Providers › New projects', () => {
  const view = (chosen?: boolean) => ({
    unattendedProvider: null,
    keepOwnAccount: [],
    startingSet: {
      alpha: [
        { id: 'plugins', what: 'plugins', from: 'an account', recommended: false, covers: 'plugin' as const, ...(chosen !== undefined ? { chosen } : {}) },
        { id: 'skills', what: 'skills', from: 'an account', recommended: true, covers: 'skill' as const },
      ],
    },
  })
  it('a switch saves the class for that engine; Back to recommended takes it back', async () => {
    mockedApi.account.mockResolvedValue(null)
    mockedApi.providers.list.mockResolvedValue([] as never)
    mockedApi.platformSettings.get.mockResolvedValue(view())
    mockedApi.platformSettings.setStartingSet.mockResolvedValueOnce(view(true)).mockResolvedValueOnce(view())
    render(<SettingsPage />)
    fireEvent.click(screen.getByRole('button', { name: 'Accounts & providers' }))
    const plugins = await screen.findByRole('switch', { name: 'Plugins from an account' })
    expect(plugins).toHaveAttribute('aria-checked', 'false')
    fireEvent.click(plugins)
    await waitFor(() => expect(mockedApi.platformSettings.setStartingSet).toHaveBeenCalledWith({ alpha: { plugins: true } }))
    await waitFor(() => expect(screen.getByRole('switch', { name: 'Plugins from an account' })).toHaveAttribute('aria-checked', 'true'))
    fireEvent.click(screen.getByRole('button', { name: 'Back to recommended' }))
    await waitFor(() => expect(mockedApi.platformSettings.setStartingSet).toHaveBeenLastCalledWith({ alpha: { plugins: null } }))
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Back to recommended' })).toBeNull())
  })
})

describe('SettingsPage — Access', () => {
  // who can open this Silos — never the machine's Claude login, whose one
  // house is Accounts & providers
  it('a Google identity is shown with its Sign out; the Claude login is not asked for', () => {
    window.localStorage.setItem('silos-google-identity', JSON.stringify({ email: 'owner@x.com', name: 'Owner', photo: null }))
    try {
      render(<SettingsPage />)
      expect(screen.getByText('owner@x.com')).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Sign out' })).toBeInTheDocument()
      expect(mockedApi.account).not.toHaveBeenCalled()
    } finally {
      window.localStorage.removeItem('silos-google-identity')
    }
  })
})

describe('SettingsPage — Appearance', () => {
  it('respects the system preference already applied by main.tsx, and the toggle offers it', () => {
    mockedApi.account.mockResolvedValue(null)
    document.documentElement.classList.add('dark')
    try {
      render(<SettingsPage />)
      fireEvent.click(screen.getByRole('button', { name: 'Appearance' }))
      expect(document.documentElement.classList.contains('dark')).toBe(true)
      expect(screen.getByText('Switch to light theme')).toBeInTheDocument()
    } finally {
      document.documentElement.classList.remove('dark')
    }
  })

  it('a click toggles the theme', () => {
    mockedApi.account.mockResolvedValue(null)
    render(<SettingsPage />)
    fireEvent.click(screen.getByRole('button', { name: 'Appearance' }))
    fireEvent.click(screen.getByText('Switch to dark theme'))
    expect(document.documentElement.classList.contains('dark')).toBe(true)
    expect(screen.getByText('Switch to light theme')).toBeInTheDocument()
  })
})

describe('SettingsPage — Notifications', () => {
  // the old «Browser notifications» checkbox («Saved for later — nothing
  // fires yet») is gone: the tab is the real doorbell (notifications-tab.test.tsx)
  it('shows the doorbell for this device and the digest hour, not the old checkbox', async () => {
    mockedApi.account.mockResolvedValue(null)
    mockedApi.push.get.mockResolvedValue({ publicKey: 'BKEY', devices: [] })
    mockedApi.digest.get.mockResolvedValue({ hour: '08:00', band: null })
    render(<SettingsPage />)
    fireEvent.click(screen.getByRole('button', { name: 'Notifications' }))
    expect(await screen.findByText('This device')).toBeInTheDocument()
    expect(await screen.findByLabelText('Morning digest')).toBeInTheDocument()
    expect(screen.queryByLabelText('Browser notifications')).toBeNull()
  })
})

describe('SettingsPage — Archived agents', () => {
  function makeArchived(overrides: Partial<AgentSummary> = {}): AgentSummary {
    return { id: 'x1', name: 'Pepe', emoji: '🤖', folder: '/x', skills: [], archived: true, ...overrides }
  }

  it('lists archived agents and Restore calls unarchive + loadOverview', async () => {
    mockedApi.account.mockResolvedValue(null)
    mockedApi.agents.list.mockResolvedValue([makeArchived()])
    mockedApi.agents.unarchive.mockResolvedValue(undefined)
    mockedApi.overview.mockResolvedValue({ agents: [], now: 0, warming: false })
    render(<SettingsPage />)
    fireEvent.click(screen.getByRole('button', { name: 'Archived agents' }))
    await waitFor(() => expect(screen.getByText(/Pepe/)).toBeInTheDocument())
    fireEvent.click(screen.getByText('Restore'))
    await waitFor(() => expect(mockedApi.agents.unarchive).toHaveBeenCalledWith('x1'))
  })
})

describe('SettingsPage — Maintenance (muted folders)', () => {
  it('folds the muted folders under the ledger and explains the restart rule', async () => {
    mockedApi.account.mockResolvedValue(null)
    mockedApi.muted.mockResolvedValue(['-home-user--claude-mem-observer-sessions'])
    render(<SettingsPage />)
    fireEvent.click(screen.getByRole('button', { name: 'Maintenance' }))
    fireEvent.click(await screen.findByRole('button', { name: /1 muted folder/ }))
    await waitFor(() => expect(screen.getByText('-home-user--claude-mem-observer-sessions')).toBeInTheDocument())
    expect(screen.getByText(/~\/.silos\/muted.json/)).toBeInTheDocument()
  })
})

describe('SettingsPage — nav', () => {
  it('is grouped You / Fleet / Library / This install, each tab one kind of thing', () => {
    mockedApi.account.mockResolvedValue(null)
    render(<SettingsPage />)
    const nav = screen.getByRole('navigation')
    for (const g of ['You', 'Fleet', 'Library', 'This install']) expect(within(nav).getByText(g, { selector: 'div' })).toBeInTheDocument()
    const tabs = within(nav)
      .getAllByRole('button')
      .map((b) => b.textContent)
    // housekeeping closes the spine: reached only from here, on purpose.
    // No 'Vault': the Vault is its own page.
    expect(tabs).toEqual([
      'Access',
      'Appearance',
      'Notifications',
      'Accounts & providers',
      'Engines',
      'Territory',
      'Archived agents',
      'Memories',
      'Skills',
      'Silos',
      'Maintenance',
      'About',
    ])
  })

  // a click navigates: the tab's id is its label in kebab-case
  it('a tab click navigates to its own address', () => {
    mockedApi.account.mockResolvedValue(null)
    render(<SettingsPage />)
    fireEvent.click(screen.getByRole('button', { name: 'Accounts & providers' }))
    expect(useStore.getState().page).toEqual({ kind: 'settings', tab: 'accounts' })
    fireEvent.click(screen.getByRole('button', { name: 'Archived agents' }))
    expect(useStore.getState().page).toEqual({ kind: 'settings', tab: 'archived' })
  })
})

// Memories/Skills are catalog tabs in Settings' Library group. Each is a
// SELF-CONTAINED list+detail (local state, never touches the global
// `page`/`nav.preset` — unlike Board, choosing an item here must not take
// anyone out of Settings).
describe('SettingsPage — catalog tabs (Memories · Skills)', () => {
  beforeEach(() => {
    mockedApi.account.mockResolvedValue(null)
  })

  it('Memories: choosing a catalog file reads it and allows editing/saving, WITHOUT leaving Settings', async () => {
    // buildCatalog (lib/catalog.ts) walks `agents` to request their memory
    // layers — with no agent at all it never calls api.memory.list and
    // falls back to the empty default (path='').
    useStore.setState({
      agents: [{ id: 'a1', name: 'Ana', emoji: '🧠', folder: null, skills: [], sessions: [], liveCount: 0, sessionCount: 0 }],
    })
    mockedApi.memory.list.mockResolvedValue({
      global: { name: 'CLAUDE.md', path: '/home/x/.claude/CLAUDE.md', scope: 'global', mtime: 1, exists: true },
      project: null,
      autoMemory: [],
      agent: null,
    })
    mockedApi.memory.read.mockResolvedValue('# hi')
    mockedApi.memory.write.mockResolvedValue({ ok: true, backup: '/backups/x.md' })
    render(<SettingsPage />)
    fireEvent.click(screen.getByRole('button', { name: 'Memories' }))
    fireEvent.click(await screen.findByText('Your personal instructions'))
    await waitFor(() => expect(mockedApi.memory.read).toHaveBeenCalledWith('/home/x/.claude/CLAUDE.md'))
    fireEvent.click(screen.getByText('Edit'))
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '# bye' } })
    fireEvent.click(screen.getByRole('button', { name: /^Save/ }))
    await waitFor(() => expect(mockedApi.memory.write).toHaveBeenCalledWith('/home/x/.claude/CLAUDE.md', '# bye'))
    // still on Settings: the tab bar is still in the DOM.
    expect(screen.getByRole('button', { name: 'Memories', current: true } as never)).toBeInTheDocument()
  })

  // spec memory-places T3: the server refuses a machine file without
  // `confirmed: true` — the editor asks inline and resends only on confirm
  it('Memories: a machine file the server wants confirmed is resent with confirmed only after the confirm', async () => {
    useStore.setState({
      agents: [{ id: 'a1', name: 'Ana', emoji: '🧠', folder: null, skills: [], sessions: [], liveCount: 0, sessionCount: 0 }],
    })
    mockedApi.memory.list.mockResolvedValue({
      global: { name: 'CLAUDE.md', path: '/home/x/.claude/CLAUDE.md', scope: 'global', mtime: 1, exists: true },
      project: null,
      autoMemory: [],
      agent: null,
    })
    mockedApi.memory.read.mockResolvedValue('# hi')
    mockedApi.memory.write.mockReset()
    // the server's rule: refused (409 «confirm») unless the request says confirmed
    mockedApi.memory.write.mockImplementation(async (_p, _c, opts) => {
      if (opts?.confirmed !== true) throw new ApiError('confirm: this file reaches every project on this machine — send confirmed: true', 409, {})
      return { ok: true, backup: null }
    })
    render(<SettingsPage />)
    fireEvent.click(screen.getByRole('button', { name: 'Memories' }))
    fireEvent.click(await screen.findByText('Your personal instructions'))
    await waitFor(() => expect(mockedApi.memory.read).toHaveBeenCalled())
    fireEvent.click(screen.getByText('Edit'))
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '# bye' } })
    fireEvent.click(screen.getByRole('button', { name: /^Save/ }))
    const group = await screen.findByRole('group', { name: 'Confirm saving a machine file' })
    expect(mockedApi.memory.write).toHaveBeenCalledTimes(1)
    // «Keep editing» goes back to the editor, writing nothing
    fireEvent.click(within(group).getByRole('button', { name: 'Keep editing' }))
    expect(mockedApi.memory.write).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: /^Save/ }))
    fireEvent.click(await screen.findByRole('button', { name: 'Save for every project on this machine' }))
    await waitFor(() => expect(mockedApi.memory.write).toHaveBeenLastCalledWith('/home/x/.claude/CLAUDE.md', '# bye', { confirmed: true }))
  })

  // one house per thing: a project's CLAUDE.md and an agent's memory
  // are read here, changed on their page — no second editor
  it("Memories: a project's or an agent's file is read here, and its door leads to its page", async () => {
    useStore.setState({
      agents: [{ id: 'a1', name: 'Ana', emoji: '🧠', folder: '/p/alpha', skills: [], sessions: [], liveCount: 0, sessionCount: 0 }],
    })
    mockedApi.memory.list.mockResolvedValue({
      global: { name: 'CLAUDE.md', path: '/home/x/.claude/CLAUDE.md', scope: 'global', mtime: 1, exists: true },
      project: { name: 'CLAUDE.md', path: '/p/alpha/CLAUDE.md', scope: 'project', mtime: 1, exists: true },
      autoMemory: [],
      agent: { name: 'memory.md', path: '/data/agents/a1/memory.md', scope: 'agent', mtime: 1, exists: true },
    })
    mockedApi.memory.read.mockResolvedValue('# project rules')
    render(<SettingsPage />)
    fireEvent.click(screen.getByRole('button', { name: 'Memories' }))
    fireEvent.click(await screen.findByText('alpha'))
    await screen.findByText('project rules')
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull()
    fireEvent.click(screen.getByTestId('memory-house'))
    expect(useStore.getState().page).toEqual({ kind: 'project', folder: '/p/alpha' })
    expect(useStore.getState().projectTab).toBe('memory')
  })

  it('Skills: choosing a catalog skill shows its readme, WITHOUT leaving Settings', async () => {
    mockedApi.skillsCatalog.mockResolvedValue([{ name: 'frontend-design', description: 'Guidance for UI', source: 'user', state: 'active' }])
    mockedApi.silosSkills.mockResolvedValue([])
    mockedApi.skillReadme.mockResolvedValue({ name: 'frontend-design', description: 'Guidance for UI', body: '# Frontend design\n\nBody.' })
    render(<SettingsPage />)
    fireEvent.click(screen.getByRole('button', { name: 'Skills' }))
    fireEvent.click(await screen.findByText('frontend-design'))
    expect(await screen.findByText('Body.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Skills', current: true } as never)).toBeInTheDocument()
  })

  // capability states: the folder is the only real unit —
  // Settings › Skills is the read-only disk inventory, each folder a door to
  // its project's Skills. The per-agent Add/Remove (writing the
  // retired agent.skills) is gone: it changed nothing the engine loads.
  it('Skills: a read-only inventory — where each skill sits, a door per folder, never a per-agent Add/Remove', async () => {
    useStore.setState({
      agents: [
        { id: 'a1', name: 'Ana', emoji: '🧠', folder: '/p/alpha', skills: ['team-plan'], sessions: [], liveCount: 0, sessionCount: 0 },
        { id: 'b2', name: 'Bea', emoji: '🐝', folder: '/p/alpha', skills: [], sessions: [], liveCount: 0, sessionCount: 0 },
        { id: 'c3', name: 'Cid', emoji: '🦊', folder: '/p/beta', skills: [], sessions: [], liveCount: 0, sessionCount: 0 },
      ],
    })
    mockedApi.skillsCatalog.mockImplementation(async (id: string) =>
      id === 'a1'
        ? [{ name: 'team-plan', source: 'project', state: 'active' }]
        : id === 'c3'
          ? [
              { name: 'team-plan', state: 'held' },
              { name: 'transcript-only', state: 'seen', seen: 'name-only' },
            ]
          : [
              { name: 'deploy', source: 'user', state: 'active' },
              { name: 'transcript-only', state: 'seen', seen: 'name-only' },
            ],
    )
    mockedApi.silosSkills.mockResolvedValue([
      { name: 'team-plan', description: 'Plan work' },
      { name: 'heartbeat', description: 'Beat' },
    ])
    mockedApi.skillReadme.mockResolvedValue(null as never)
    render(<SettingsPage />)
    fireEvent.click(screen.getByRole('button', { name: 'Skills' }))
    fireEvent.click(await screen.findByText('team-plan'))
    const places = await screen.findByTestId('skill-places')
    expect(within(places).getByText('Silos platform')).toBeInTheDocument()
    expect(within(places).getByText('alpha')).toBeInTheDocument()
    expect(within(places).getByText('in its folder')).toBeInTheDocument()
    expect(within(places).getByText('· Ana · Bea')).toBeInTheDocument() // whom that folder reaches
    expect(within(places).getByText('turned off')).toBeInTheDocument() // beta holds it
    expect(within(places).getAllByRole('button', { name: /^Skills in / })).toHaveLength(2) // one door per folder
    expect(screen.queryByRole('button', { name: /^(Add|Remove)$/ })).toBeNull()
    expect(screen.queryByText(/Agents using it/)).toBeNull()
    // a name only seen in a transcript is not disk inventory
    expect(screen.queryByText('transcript-only')).toBeNull()
    // the door lands on the project's Skills, the skill's row open
    fireEvent.click(within(places).getAllByRole('button', { name: /^Skills in / })[1]!)
    expect(useStore.getState().page).toEqual({ kind: 'project', folder: '/p/beta' })
    expect(useStore.getState().projectTab).toBe('skills')
    expect(useStore.getState().projectItem).toBe('team-plan')
    expect(mockedApi.agents.update).not.toHaveBeenCalled()
  })

  it('page={settings,tab:"skills"} (⌘K "Skills") starts directly on that tab', () => {
    useStore.setState({ page: { kind: 'settings', tab: 'skills' } })
    mockedApi.skillsCatalog.mockResolvedValue([])
    render(<SettingsPage />)
    expect(screen.getByRole('button', { name: 'Skills', current: true } as never)).toBeInTheDocument()
  })
})

describe('Claude Code — its phone push (Notifications), retention and hooks (Engines)', () => {
  const view = {
    cleanupPeriodDays: 3650,
    explicit: true,
    keepForeverDays: 3650,
    path: '/home/u/.claude/settings.json',
    agentPushNotifEnabled: true,
    pushExplicit: true,
    todoTools: false,
    hooks: { briefing: 'installed' as const, cronGate: 'missing' as const },
  }
  it('the push toggle reflects settings.json and writes through the API', async () => {
    mockedApi.claudeSettings.mockResolvedValue(view)
    mockedApi.setAgentPushNotif.mockResolvedValue({ view: { agentPushNotifEnabled: false }, backup: null })
    mockedApi.account.mockResolvedValue(null)
    mockedApi.push.get.mockResolvedValue({ publicKey: 'BKEY', devices: [] })
    mockedApi.digest.get.mockResolvedValue({ hour: '08:00', band: null })
    render(<SettingsPage />)
    fireEvent.click(screen.getByRole('button', { name: 'Notifications' }))
    const box = (await screen.findByLabelText('Push notifications on your phone')) as HTMLInputElement
    expect(box.checked).toBe(true)
    fireEvent.click(box)
    await waitFor(() => expect(mockedApi.setAgentPushNotif).toHaveBeenCalledWith(false))
    await waitFor(() => expect((screen.getByLabelText('Push notifications on your phone') as HTMLInputElement).checked).toBe(false))
  })
  it('the retention period is editable: type a number and Save writes it through the API', async () => {
    mockedApi.claudeSettings.mockResolvedValue({ ...view, cleanupPeriodDays: 30, explicit: false })
    mockedApi.setCleanupPeriodDays.mockResolvedValue({ view: { cleanupPeriodDays: 90, explicit: true, path: view.path }, backup: '/bk' })
    mockedApi.account.mockResolvedValue(null)
    render(<SettingsPage />)
    fireEvent.click(screen.getByRole('button', { name: 'Engines' }))
    const input = (await screen.findByLabelText('Transcript retention (days)')) as HTMLInputElement
    expect(input.value).toBe('30')
    fireEvent.change(input, { target: { value: '90' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(mockedApi.setCleanupPeriodDays).toHaveBeenCalledWith(90))
  })

  it('a missing hook offers Install; complete wiring reads ✓ installed', async () => {
    mockedApi.claudeSettings.mockResolvedValue(view)
    mockedApi.installClaudeHooks.mockResolvedValue({ view: { hooks: { briefing: 'installed', cronGate: 'installed' } }, backup: '/bk' })
    mockedApi.account.mockResolvedValue(null)
    render(<SettingsPage />)
    fireEvent.click(screen.getByRole('button', { name: 'Engines' }))
    const btn = await screen.findByRole('button', { name: 'Install missing hook' })
    fireEvent.click(btn)
    await waitFor(() => expect(mockedApi.installClaudeHooks).toHaveBeenCalled())
    await screen.findByText('✓ installed')
  })

  // the way out exists wherever something of Silos' is wired, and is the
  // server's removal — never a local edit of the view
  it('installed hooks offer Uninstall, which asks the server to remove them', async () => {
    mockedApi.claudeSettings.mockResolvedValue({ ...view, hooks: { briefing: 'installed', cronGate: 'installed' } })
    mockedApi.uninstallClaudeHooks.mockResolvedValue({ view: { hooks: { briefing: 'missing', cronGate: 'missing' } }, backup: '/bk' })
    mockedApi.account.mockResolvedValue(null)
    render(<SettingsPage />)
    fireEvent.click(screen.getByRole('button', { name: 'Engines' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Uninstall' }))
    await waitFor(() => expect(mockedApi.uninstallClaudeHooks).toHaveBeenCalled())
    await screen.findByRole('button', { name: 'Install hooks' })
    expect(screen.queryByRole('button', { name: 'Uninstall' })).toBeNull()
  })

  // «installed» means the script runs: a hook wired to a path that is gone
  // (a moved repo) is said in plain words and offers Repair, never ✓
  it('a hook pointing at a script that is gone says so and offers Repair', async () => {
    mockedApi.claudeSettings.mockResolvedValue({ ...view, hooks: { briefing: 'broken', cronGate: 'installed' } })
    mockedApi.installClaudeHooks.mockResolvedValue({ view: { hooks: { briefing: 'installed', cronGate: 'installed' } }, backup: '/bk' })
    mockedApi.account.mockResolvedValue(null)
    render(<SettingsPage />)
    fireEvent.click(screen.getByRole('button', { name: 'Engines' }))
    const btn = await screen.findByRole('button', { name: 'Repair hooks' })
    expect(screen.getByText(/A hook points at a script that is no longer there/)).toBeTruthy()
    expect(screen.queryByText('✓ installed')).toBeNull()
    fireEvent.click(btn)
    await screen.findByText('✓ installed')
  })
})

// the harness row (ONE Claude Code): the claude
// that runs consoles and chats, the Agent SDK library and its pairing, npm's
// latest — Update only when there is something newer — and the verdict.
describe("Settings › Engines — Claude Code's version + Update", () => {
  const status = {
    harness: 'claude-code' as const,
    name: 'Claude Code',
    checkedAt: '2026-10-20T10:00:00.000Z',
    console: { version: '2.1.304', path: '/home/u/.local/bin/claude' },
    library: { name: 'Agent SDK', version: '0.3.304', pairedWith: '2.1.304' },
    latest: '2.1.304',
  }
  function mount(): void {
    mockedApi.account.mockResolvedValue(null)
    mockedApi.claudeSettings.mockRejectedValue(new Error('x'))
    useStore.setState({ page: { kind: 'settings', tab: 'engines' } })
    render(<SettingsPage />)
  }

  it('installed = latest → "✓ up to date", no button', async () => {
    mockedApi.harness.mockResolvedValue(status)
    mount()
    await screen.findByText(/up to date/)
    expect(screen.queryByRole('button', { name: /^Update/ })).toBeNull()
  })

  it('a newer release → Update; while running it reads Updating…; after, the new version and what it means for open consoles', async () => {
    mockedApi.harness.mockResolvedValue({ ...status, latest: '2.1.310' })
    let finish: (v: { before: string; after: string; output: string }) => void = () => {}
    mockedApi.updateHarness.mockReturnValue(
      new Promise((r) => {
        finish = r
      }),
    )
    mount()
    const btn = await screen.findByRole('button', { name: 'Update to 2.1.310' })
    fireEvent.click(btn)
    const busy = await screen.findByRole('button', { name: 'Updating…' })
    expect(busy).toBeDisabled()
    finish({ before: '2.1.304', after: '2.1.310', output: 'ok' })
    await screen.findByText(/New consoles use 2\.1\.310; open ones keep theirs until they restart\./)
    expect(screen.getByText('✓ up to date')).toBeInTheDocument()
    expect(mockedApi.updateHarness).toHaveBeenCalledTimes(1)
  })

  it('a failed update says what failed and keeps the button', async () => {
    mockedApi.harness.mockResolvedValue({ ...status, latest: '2.1.310' })
    mockedApi.updateHarness.mockRejectedValue(new Error('claude update failed: permission denied'))
    mount()
    fireEvent.click(await screen.findByRole('button', { name: 'Update to 2.1.310' }))
    await screen.findByText('Update failed — claude update failed: permission denied')
    expect(screen.getByRole('button', { name: 'Update to 2.1.310' })).toBeEnabled()
  })

  it('npm unreachable → no verdict, says it could not check', async () => {
    mockedApi.harness.mockResolvedValue({ ...status, latest: null })
    mount()
    await screen.findByText(/could not check/i)
    expect(screen.queryByText('✓ up to date')).toBeNull()
    expect(screen.queryByRole('button', { name: /^Update/ })).toBeNull()
  })

  it("an outdated claude: the verdict's own message is shown", async () => {
    const line = 'Claude Code 2.1.300 is older than Silos needs (2.1.304) — update it: claude update'
    mockedApi.harness.mockResolvedValue({
      ...status,
      console: { ...status.console, version: '2.1.300' },
      compat: [
        {
          harness: 'claude-code',
          name: 'Claude Code',
          state: 'outdated',
          installed: '2.1.300',
          needed: '2.1.304',
          update: 'claude update',
          refuses: ['console', 'chat'],
          message: line,
        },
      ],
    })
    mount()
    expect(await screen.findByText(line)).toBeInTheDocument()
  })

  it('the version endpoint failing says so', async () => {
    mockedApi.harness.mockRejectedValue(new Error('boom'))
    mount()
    await screen.findByText('Could not read Claude Code’s version.')
  })
})

describe('SettingsPage — Territory', () => {
  beforeEach(() => {
    mockedApi.account.mockResolvedValue(null)
    mockedApi.agents.list.mockResolvedValue([])
  })

  it('loads the list into the textarea and saves it back, one per line', async () => {
    mockedApi.territory.get.mockResolvedValue({ privatePaths: ['~/secrets', '~/.ssh'] })
    mockedApi.territory.set.mockResolvedValue({ privatePaths: ['~/secrets', '/srv/keys'] })
    render(<SettingsPage />)
    fireEvent.click(screen.getByRole('button', { name: 'Territory' }))
    const box = await screen.findByLabelText(/Private paths/)
    await waitFor(() => expect(box).toHaveValue('~/secrets\n~/.ssh'))
    fireEvent.change(box, { target: { value: '~/secrets\n\n /srv/keys \n' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save private paths' }))
    await waitFor(() => expect(mockedApi.territory.set).toHaveBeenCalledWith(['~/secrets', '/srv/keys']))
    await waitFor(() => expect(box).toHaveValue('~/secrets\n/srv/keys'))
  })

  it('the server error shows under the button', async () => {
    mockedApi.territory.get.mockResolvedValue({ privatePaths: [] })
    mockedApi.territory.set.mockRejectedValue(new Error('private path must be absolute or ~-prefixed: rel/dir'))
    render(<SettingsPage />)
    fireEvent.click(screen.getByRole('button', { name: 'Territory' }))
    const box = await screen.findByLabelText(/Private paths/)
    fireEvent.change(box, { target: { value: 'rel/dir' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save private paths' }))
    await waitFor(() => expect(screen.getByText('private path must be absolute or ~-prefixed: rel/dir')).toBeInTheDocument())
  })

  // The rollout gate: one toggle per agent with a folder; nobody is
  // fenced until the owner turns them on, one at a time.
  it('a "Fenced" toggle per agent with a folder, bound to enabled', async () => {
    useStore.setState({
      agents: [
        { id: 'master', name: 'Master', emoji: '🎛️', role: '', folder: null, skills: [], sessions: [], liveCount: 0, sessionCount: 0 },
        { id: 'silos', name: 'Silos', emoji: '🧱', role: '', folder: '/home/u/silos', skills: [], sessions: [], liveCount: 0, sessionCount: 0 },
        { id: 'builder', name: 'Builder', emoji: '🛠', role: '', folder: '/home/u/ci', skills: [], sessions: [], liveCount: 0, sessionCount: 0 },
        { id: 'loose', name: 'Loose', emoji: '🎈', role: '', folder: null, skills: [], sessions: [], liveCount: 0, sessionCount: 0 },
      ] as never,
    })
    mockedApi.territory.get.mockResolvedValue({ privatePaths: [], enabled: ['silos'] })
    mockedApi.territory.setEnabled.mockResolvedValue({ privatePaths: [], enabled: ['silos', 'builder'] })
    render(<SettingsPage />)
    fireEvent.click(screen.getByRole('button', { name: 'Territory' }))
    const silos = await screen.findByRole('switch', { name: /Territory: Silos/ })
    const builder = screen.getByRole('switch', { name: /Territory: Builder/ })
    expect(silos).toBeChecked()
    expect(builder).not.toBeChecked()
    expect(screen.queryByRole('switch', { name: /Territory: Master/ })).toBeNull()
    expect(screen.queryByRole('switch', { name: /Territory: Loose/ })).toBeNull()
    expect(screen.getByTestId('fenced-builder')).toHaveTextContent('open')
    fireEvent.click(builder)
    await waitFor(() => expect(mockedApi.territory.setEnabled).toHaveBeenCalledWith(['silos', 'builder']))
    await waitFor(() => expect(screen.getByRole('switch', { name: /Territory: Builder/ })).toBeChecked())
    expect(screen.getByTestId('fenced-builder')).toHaveTextContent('fenced')
  })

  // Per harness: what the fence covers there, from the server (GET
  // /api/territory agents[].label/fenced) — the Claude row stays as it was.
  it("an OpenCode agent's row says what the fence covers there, and one sentence names the OpenCode limits", async () => {
    useStore.setState({
      agents: [
        { id: 'builder', name: 'Builder', emoji: '🛠', role: '', folder: '/home/u/ci', skills: [], sessions: [], liveCount: 0, sessionCount: 0 },
        { id: 'oc', name: 'Oc', emoji: '🧪', role: '', folder: '/home/u/oc', skills: [], sessions: [], liveCount: 0, sessionCount: 0 },
      ] as never,
    })
    mockedApi.territory.get.mockResolvedValue({
      privatePaths: [],
      enabled: [],
      agents: [
        { id: 'builder', harness: 'claude-code', label: 'Claude Code', fenced: ['read', 'edit'] },
        { id: 'oc', harness: 'opencode', label: 'OpenCode', fenced: ['read', 'edit'] },
      ],
    })
    render(<SettingsPage />)
    fireEvent.click(screen.getByRole('button', { name: 'Territory' }))
    // the row opens to the agent's three surfaces
    fireEvent.click(await screen.findByRole('button', { name: /Oc/, expanded: false }))
    expect(await screen.findByTestId('fence-harness-oc')).toHaveTextContent('on OpenCode: read · edit kept out')
    expect(screen.queryByTestId('fence-harness-builder')).toBeNull()
    expect(
      screen.getByText(/On OpenCode a fenced agent runs without the project's own opencode\.json \(Silos passes the project instructions itself\)\./),
    ).toBeInTheDocument()
  })

  it('with no OpenCode agent, no OpenCode sentence', async () => {
    useStore.setState({
      agents: [
        { id: 'builder', name: 'Builder', emoji: '🛠', role: '', folder: '/home/u/ci', skills: [], sessions: [], liveCount: 0, sessionCount: 0 },
      ] as never,
    })
    mockedApi.territory.get.mockResolvedValue({
      privatePaths: [],
      enabled: [],
      agents: [{ id: 'builder', harness: 'claude-code', label: 'Claude Code', fenced: ['read', 'edit'] }],
    })
    render(<SettingsPage />)
    fireEvent.click(screen.getByRole('button', { name: 'Territory' }))
    await screen.findByRole('switch', { name: /Territory: Builder/ })
    expect(screen.queryByText(/On OpenCode a fenced agent/)).toBeNull()
  })

  // the network surface: the mode and the allowlist are
  // edited through PATCH /api/territory/egress/:id; an optional engine host
  // is one tap; the server's refusal is said in its words
  it('the Network band switches the mode, adds an optional engine host in one tap and says a refusal', async () => {
    useStore.setState({
      agents: [
        { id: 'builder', name: 'Builder', emoji: '🛠', role: '', folder: '/home/u/ci', skills: [], sessions: [], liveCount: 0, sessionCount: 0 },
      ] as never,
    })
    const engine = {
      source: 'https://docs.example/network',
      hosts: [
        { host: 'api.engine.example', reason: 'its API' },
        { host: 'telemetry.example', optional: true as const, reason: 'telemetry' },
      ],
    }
    const open = { id: 'builder', name: 'Builder', mode: 'open' as const, hosts: [] as string[], engine }
    const allow = { ...open, mode: 'allowlist' as const }
    mockedApi.territory.get.mockResolvedValue({ privatePaths: [], enabled: [] })
    mockedApi.territory.egress.mockResolvedValue({ proxyPort: 3211, agents: [open] })
    mockedApi.territory.egressRejections.mockResolvedValue([])
    mockedApi.vault.list.mockResolvedValue([])
    mockedApi.territory.setEgress
      .mockResolvedValueOnce(allow)
      .mockResolvedValueOnce({ ...allow, hosts: ['telemetry.example'] })
      .mockRejectedValueOnce(new Error('https://x: a host name only — no scheme, port, path or credentials'))
    render(<SettingsPage />)
    fireEvent.click(screen.getByRole('button', { name: 'Territory' }))
    fireEvent.click(await screen.findByRole('button', { name: /Builder/, expanded: false }))
    fireEvent.click(await screen.findByRole('radio', { name: 'Allowlist' }))
    await waitFor(() => expect(mockedApi.territory.setEgress).toHaveBeenCalledWith('builder', { mode: 'allowlist' }))
    fireEvent.click(await screen.findByRole('button', { name: /^Allow telemetry\.example/ }))
    await waitFor(() => expect(mockedApi.territory.setEgress).toHaveBeenCalledWith('builder', { hosts: ['telemetry.example'] }))
    expect(await screen.findByRole('button', { name: 'Remove telemetry.example' })).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Add a host for Builder'), { target: { value: 'https://x' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('a host name only')
  })

  it('without the route (older server), the tab says so instead of an empty page', async () => {
    mockedApi.territory.get.mockRejectedValue(new Error('Not Found'))
    render(<SettingsPage />)
    fireEvent.click(screen.getByRole('button', { name: 'Territory' }))
    await waitFor(() => expect(screen.getByTestId('territory-absent')).toBeInTheDocument())
    expect(screen.queryByLabelText(/Private paths/)).not.toBeInTheDocument()
  })
})
