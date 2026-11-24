// harness-fake-engine.test.tsx — a third engine the web never heard of at
// build time (harness seam). The list goes through
// setHarnessDescriptors exactly as the store's loadHarnesses does; then every
// surface that once decided by engine name is rendered for a `framework:
// 'fake'` agent — its label and own login, none of Claude's affordances (no
// Claude accounts, no context %, no SDK catalogue, no "Claude Code"). The same
// agent on an id the list does not know ('not-an-engine') reads as the unknown engine.
// A 'none' engine (no model list) says so in plain words and takes a typed id.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import seed from '../src/lib/harnesses.seed.json'
import { setHarnessDescriptors, unknownDescriptor } from '../src/lib/harnesses'
import { SettingsTab } from '../src/components/agent/SettingsTab'
import { ProviderPanel } from '../src/components/ProviderPanel'
import { SettingsPage } from '../src/components/SettingsPage'
import { AgentModal } from '../src/components/AgentModal'
import { StatusLine } from '../src/components/StatusLine'
import { ExternalStatus } from '../src/components/ExternalStatus'
import { CockpitChips } from '../src/components/CockpitChips'
import { AgentPage } from '../src/components/AgentPage'
import { ProvidersTab } from '../src/components/ProvidersTab'
import { CommandPalette } from '../src/components/CommandPalette'
import type { ChatTurnState } from '../src/store'
import { useStore } from '../src/store'
import { api } from '../src/lib/api'
import type { AgentView, HarnessDescriptor, HarnessStatus, ModelInfo, ProviderView, SessionDetail, SessionView, Turn } from '../src/lib/types'

vi.mock('../src/lib/api')
const mockedApi = vi.mocked(api, { deep: true })
class IdleSocket {
  static OPEN = 1
  readyState = 0
  constructor(public url: string) {}
  addEventListener() {}
  send() {}
  close() {}
}
vi.stubGlobal('WebSocket', IdleSocket)

const SEED = seed.harnesses as HarnessDescriptor[]
// a third engine: its own login, no model list, no provider kinds of its own
const FAKE: HarnessDescriptor = { ...unknownDescriptor('fake'), label: 'Fake' }

const NOW = Date.parse('2026-10-29T10:00:00.000Z')
const acct = (id: string, name: string) => ({
  id,
  kind: 'claude-account',
  label: id === 'default' ? 'Claude (this machine)' : `Claude · ${name}`,
  window: null,
  account: { name, configDir: null, providerId: id, loggedIn: true, email: `${name}@x.com`, plan: 'max', shared: true },
})
const PROVIDERS = [
  acct('default', 'default'),
  acct('account:kai', 'kai'),
  {
    id: 'mm',
    kind: 'harness-provider',
    label: 'MiniMax plan',
    harness: 'opencode',
    providerId: 'minimax-coding-plan',
    apiKey: 'mm-…3456',
    createdAt: '2026-10-26',
    window: null,
  },
] as unknown as ProviderView[]
const CATALOG: ModelInfo[] = [
  {
    value: 'default',
    resolvedModel: 'claude-opus-5[1m]',
    displayName: 'Default (recommended)',
    supportsEffort: true,
    supportedEffortLevels: ['low', 'high'],
    supportsFastMode: true,
  },
  { value: 'sonnet', resolvedModel: 'claude-sonnet-5', displayName: 'Sonnet', supportsEffort: true, supportedEffortLevels: ['low', 'high'] },
]
// Claude's affordances, as text a surface would show
const CLAUDE_TEXT = /Claude Code|Claude \(this machine\)|Claude · kai|Add a Claude account|Sonnet|Default \(recommended\)|% context/

const agentOn = (framework: string): AgentView =>
  ({
    id: 'a1',
    name: 'Ana',
    emoji: '🧠',
    role: 'writer',
    folder: '/home/user/ana',
    skills: [],
    sessions: [],
    liveCount: 0,
    sessionCount: 0,
    framework,
  }) as unknown as AgentView
const sessionOn = (harness: string): SessionView =>
  ({
    id: `${harness}_1`,
    folder: 'f',
    title: 'Fix the parser',
    skills: [],
    cwd: null,
    mtime: 0,
    size: 1,
    turnCount: 1,
    live: false,
    worktree: false,
    native: true,
    agentId: 'a1',
    harness,
  }) as unknown as SessionView
const detailOn = (harness: string): SessionDetail => ({ meta: sessionOn(harness), turns: [], total: 0 })

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++)
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'], now: NOW })
  vi.clearAllMocks()
  expect(setHarnessDescriptors([...SEED, FAKE])).toBe(true)
  mockedApi.conversationPrefs.patch.mockResolvedValue({})
  mockedApi.conversationPrefs.patchApplied.mockResolvedValue({ prefs: {}, applied: 'next-turn' })
  mockedApi.providers.list.mockResolvedValue(PROVIDERS)
  mockedApi.models.mockResolvedValue({ models: [], fetchedAt: null })
  mockedApi.agents.list.mockResolvedValue([])
  mockedApi.agents.update.mockResolvedValue(undefined)
  mockedApi.complete.mockResolvedValue([])
  mockedApi.memory.list.mockResolvedValue({
    global: { name: 'CLAUDE.md', path: '/home/CLAUDE.md', scope: 'global', mtime: 0, exists: false },
    project: null,
    autoMemory: [],
    agent: null,
  })
  mockedApi.console.mockResolvedValue({ key: 'console-key', theme: 'dark' })
  mockedApi.overview.mockImplementation(async () => ({ agents: useStore.getState().agents, now: 0, warming: false }))
  mockedApi.automations.list.mockImplementation(async () => useStore.getState().automations)
  mockedApi.automations.pending.mockResolvedValue([])
  mockedApi.prefs.mockResolvedValue({})
  mockedApi.muted.mockResolvedValue([])
  useStore.setState({
    warming: false,
    filter: '',
    tab: 'threads',
    newChatOpen: false,
    mobileView: 'chat',
    automations: [],
    automationsPending: [],
    automationRuns: [],
    agents: [],
    selectedAgentId: null,
    selected: null,
    detail: null,
    active: null,
    modal: null,
    page: null,
    catalog: CATALOG,
    convPrefs: {},
    pendingConvPrefs: {},
    turnOverrides: {},
    providers: PROVIDERS as never,
    chatMode: 'chat' as never,
    providerPanel: null,
    consoleRestartRequest: 0,
  } as never)
})
afterEach(() => {
  setHarnessDescriptors(SEED)
  vi.useRealTimers()
})

// the two ids under test: a registered third engine, and one nobody registered
const CASES: Array<[string, string]> = [
  ['fake', 'Fake'],
  ['not-an-engine', 'not-an-engine'],
]

describe('an engine with no model list (ui.models none)', () => {
  it.each(CASES)('%s: the Run on panel says so in plain words, never "Reading its models…"', async (id, label) => {
    useStore.setState({ agents: [agentOn(id)], selectedAgentId: 'a1', selected: { folder: 'f', id: `${id}_1` }, detail: detailOn(id) })
    useStore.getState().openProviderPanel(null)
    render(<ProviderPanel agent={agentOn(id)} />)
    await settle()
    const dialog = screen.getByRole('dialog', { name: 'Run on' })
    expect(dialog.textContent).toContain(`No model list — ${label} picks`)
    expect(dialog.textContent).not.toContain('Reading its models')
  })

  it.each(CASES)('%s: the agent editor takes a typed model id', async (id, label) => {
    render(<SettingsTab agent={agentOn(id)} fields="runs" />)
    await waitFor(() => expect(mockedApi.providers.list).toHaveBeenCalled())
    await settle()
    const field = screen.getByLabelText('Model') as HTMLInputElement
    expect(field.tagName).toBe('INPUT')
    expect(field.placeholder).toBe(`model id as ${label} names it — empty lets it pick`)
    fireEvent.change(field, { target: { value: ' fake-large ' } })
    expect((screen.getByLabelText('Model') as HTMLInputElement).value).toBe('fake-large')
  })
})

describe('Settings refreshes each per-provider model list once', () => {
  it('today: exactly one refresh, for the provider-model engine; a later arrival is refreshed once too', async () => {
    setHarnessDescriptors(SEED)
    mockedApi.account.mockResolvedValue(null)
    mockedApi.claudeSettings.mockRejectedValue(new Error('x'))
    mockedApi.refreshModels.mockResolvedValue({ models: [], fetchedAt: null })
    render(<SettingsPage />)
    await settle()
    expect(mockedApi.refreshModels.mock.calls).toEqual([['opencode']])
    // /api/harnesses answers after mount with a third per-provider engine
    const late: HarnessDescriptor = { ...FAKE, id: 'late', ui: { ...FAKE.ui, models: 'provider-model' } }
    act(() => {
      setHarnessDescriptors([...SEED, late])
    })
    await settle()
    expect(mockedApi.refreshModels.mock.calls).toEqual([['opencode'], ['late']])
    // the same engines again (a reload of the list): nobody twice
    act(() => {
      setHarnessDescriptors([...SEED, late])
    })
    await settle()
    expect(mockedApi.refreshModels.mock.calls).toEqual([['opencode'], ['late']])
  })
})

// 'fake' is registered (the list holds it); 'not-an-engine' is not (the seed only)
function listFor(id: string): void {
  expect(setHarnessDescriptors(id === 'fake' ? [...SEED, FAKE] : SEED)).toBe(true)
}
function selectOn(id: string): void {
  useStore.setState({ agents: [agentOn(id)], selectedAgentId: 'a1', selected: { folder: 'f', id: `${id}_1` }, detail: detailOn(id) })
}

describe('AgentModal — the engine radios follow the list', () => {
  it('a registered third engine is a radio, after the built-in ones', async () => {
    useStore.setState({ modal: 'create' })
    render(<AgentModal />)
    await settle()
    const radio = screen.getByLabelText('Fake') as HTMLInputElement
    expect(radio.type).toBe('radio')
    const fieldset = radio.closest('fieldset')!
    expect(Array.from(fieldset.querySelectorAll('input')).map((i) => i.value)).toEqual(['claude-code', 'opencode', 'fake'])
    fireEvent.click(radio)
    expect((screen.getByLabelText('Fake') as HTMLInputElement).checked).toBe(true)
  })
  it('an id the list does not know is never offered', async () => {
    listFor('not-an-engine')
    useStore.setState({ modal: 'create' })
    render(<AgentModal />)
    await settle()
    expect(screen.queryByLabelText('Fake')).toBeNull()
    expect(screen.queryByLabelText('not-an-engine')).toBeNull()
  })
})

describe.each(CASES)('%s — none of Claude’s affordances', (id, label) => {
  beforeEach(() => listFor(id))

  it('ProviderPanel: its label, its own login, no Claude accounts, no "Add a Claude account"', async () => {
    selectOn(id)
    useStore.getState().openProviderPanel(null)
    render(<ProviderPanel agent={agentOn(id)} />)
    await settle()
    const dialog = screen.getByRole('dialog', { name: 'Run on' })
    expect(dialog.querySelector('header')!.textContent).toContain(`Ana · ${label} · this conversation`)
    expect(dialog.textContent).toContain(`${label}’s own login`)
    expect(dialog.textContent).toContain(`whatever ${label} uses by default`)
    expect(dialog.textContent).not.toMatch(CLAUDE_TEXT)
    expect(dialog.textContent).not.toContain('kai@x.com')
    expect(dialog.textContent).not.toContain('MiniMax plan')
  })

  it('StatusLine: an active turn with contextTokens shows no % context', () => {
    useStore.setState({
      detail: detailOn(id),
      active: {
        turnId: 't1',
        agentId: 'a1',
        text: '',
        tools: [],
        status: 'streaming',
        userText: 'go',
        thinkingText: '',
        lastEvent: 'init',
        startedAt: NOW,
        outputTokens: 1200,
        contextTokens: 108_656,
        requested: { model: 'sonnet', permissionMode: 'bypassPermissions' },
      } as ChatTurnState,
    })
    const { container } = render(<StatusLine />)
    expect(container.textContent).not.toMatch(/context/)
    expect(container.textContent).not.toMatch(CLAUDE_TEXT)
  })

  it('ExternalStatus: contextTokens shows no % context', () => {
    const turns: Turn[] = [
      { index: 0, role: 'user', text: 'go', tools: [], ts: '2026-10-29T09:58:00.000Z' },
      { index: 1, role: 'assistant', text: 'done', tools: [], ts: '2026-10-29T10:00:00.000Z', outputTokens: 4400 },
    ]
    const { container } = render(<ExternalStatus turns={turns} live={false} contextTokens={108_656} model="sonnet" harness={id} />)
    expect(container.textContent).not.toMatch(/context/)
  })

  it('CockpitChips → Run on: no SDK catalogue models, a typed id only; the account is its own login', async () => {
    selectOn(id)
    render(
      <>
        <CockpitChips />
        <ProviderPanel agent={agentOn(id)} />
      </>,
    )
    await settle()
    expect(screen.queryByLabelText('effort selector')).toBeNull()
    expect(screen.getByTestId('chip-account').textContent).toContain(`${label} login`)
    fireEvent.click(screen.getByTestId('chip-model'))
    await settle()
    const panel = screen.getByRole('dialog', { name: 'Run on' })
    expect(panel.textContent).not.toMatch(CLAUDE_TEXT)
    expect(panel.textContent).not.toContain('Seen in use')
    const custom = screen.getByLabelText('another model id') as HTMLInputElement
    fireEvent.change(custom, { target: { value: 'fake-large' } })
    fireEvent.keyDown(custom, { key: 'Enter' })
    await settle()
    expect(mockedApi.conversationPrefs.patch.mock.calls.length + mockedApi.conversationPrefs.patchApplied.mock.calls.length).toBeGreaterThan(0)
    expect(JSON.stringify([...mockedApi.conversationPrefs.patch.mock.calls, ...mockedApi.conversationPrefs.patchApplied.mock.calls])).toContain('fake-large')
  })

  it('AgentPage: a started conversation has no mode selector', async () => {
    const meta = sessionOn(id)
    useStore.setState({
      agents: [{ ...agentOn(id), sessions: [meta] }],
      page: { kind: 'agent', id: 'a1' },
      selected: { folder: meta.folder, id: meta.id },
      detail: { meta, turns: [], total: 0 },
    })
    const { container } = render(<AgentPage />)
    await settle()
    const header = container.querySelector('header')!
    expect(header).not.toBeNull()
    expect(header.textContent).not.toContain('Real console')
    expect(header.textContent).not.toMatch(CLAUDE_TEXT)
  })
})

// The reverse net: a third engine that GRANTS what OpenCode has (mode switch,
// a per-provider model list, its own login, keys) and what Claude Code has
// (a context %). Each feature must appear for it — a component that decided
// by `=== 'opencode'` (or `=== 'claude-code'`) instead of the descriptor
// would hide it here.
const FAKE_PLUS: HarnessDescriptor = {
  ...unknownDescriptor('fake-plus'),
  label: 'Fake+',
  modeSwitch: true,
  providerKinds: ['anthropic-compatible'],
  ui: { ...unknownDescriptor('fake-plus').ui, contextPercent: true, models: 'provider-model', ownLogin: true },
}
const GATEWAY_KEY = {
  id: 'gw',
  kind: 'anthropic-compatible',
  label: 'Plus gateway',
  baseUrl: 'https://gw.example',
  apiKey: 'gw-…9876',
  createdAt: '2026-10-26',
  window: null,
} as unknown as ProviderView
const RAW_MODELS: ModelInfo[] = [{ value: 'fakeco/big-1', resolvedModel: 'fakeco/big-1', displayName: 'Big One' } as ModelInfo]

describe('fake-plus — a granted feature appears by descriptor, never by engine name', () => {
  beforeEach(() => {
    expect(setHarnessDescriptors([...SEED, FAKE_PLUS])).toBe(true)
    useStore.setState({ providers: [...PROVIDERS, GATEWAY_KEY] as never })
    mockedApi.providers.list.mockResolvedValue([...PROVIDERS, GATEWAY_KEY])
    mockedApi.models.mockImplementation(async (h?: string) => (h === 'fake-plus' ? { models: RAW_MODELS, fetchedAt: null } : { models: [], fetchedAt: null }))
  })

  it('AgentPage: a started conversation offers the Real console | Chat selector', async () => {
    const meta = sessionOn('fake-plus')
    useStore.setState({
      agents: [{ ...agentOn('fake-plus'), sessions: [meta] }],
      page: { kind: 'agent', id: 'a1' },
      selected: { folder: meta.folder, id: meta.id },
      detail: { meta, turns: [], total: 0 },
    })
    const { container } = render(<AgentPage />)
    await settle()
    const header = container.querySelector('header')!
    expect(header.textContent).toContain('Real console')
    expect(header.textContent).toContain('Chat')
  })

  it('StatusLine: an active turn with contextTokens shows the % context', () => {
    useStore.setState({
      detail: detailOn('fake-plus'),
      active: {
        turnId: 't1',
        agentId: 'a1',
        text: '',
        tools: [],
        status: 'streaming',
        userText: 'go',
        thinkingText: '',
        lastEvent: 'init',
        startedAt: NOW,
        outputTokens: 1200,
        contextTokens: 108_656,
        requested: { model: 'sonnet', permissionMode: 'bypassPermissions' },
      } as ChatTurnState,
    })
    const { container } = render(<StatusLine />)
    expect(container.textContent).toMatch(/\d+% context/)
  })

  it('ExternalStatus: contextTokens shows the % context', () => {
    const turns: Turn[] = [
      { index: 0, role: 'user', text: 'go', tools: [], ts: '2026-10-29T09:58:00.000Z' },
      { index: 1, role: 'assistant', text: 'done', tools: [], ts: '2026-10-29T10:00:00.000Z', outputTokens: 4400 },
    ]
    const { container } = render(<ExternalStatus turns={turns} live={false} contextTokens={108_656} model="sonnet" harness="fake-plus" />)
    expect(container.textContent).toMatch(/\d+% context/)
  })

  it('CockpitChips → Run on: the per-provider path — its own model rows, raw; its key; never the SDK catalogue or a Claude account', async () => {
    selectOn('fake-plus')
    render(
      <>
        <CockpitChips />
        <ProviderPanel agent={agentOn('fake-plus')} />
      </>,
    )
    await settle()
    // useModelOptions asked THIS engine for its provider's models
    expect(mockedApi.models).toHaveBeenCalledWith('fake-plus', { provider: 'default' })
    expect(screen.getByTestId('chip-account').textContent).toContain('Fake+ login')
    fireEvent.click(screen.getByTestId('chip-model'))
    await settle()
    const panel = screen.getByRole('dialog', { name: 'Run on' })
    expect(panel.textContent).toContain('fakeco/big-1')
    expect(panel.textContent).not.toContain('Big One')
    expect(panel.textContent).not.toMatch(/Sonnet|Default \(recommended\)/)
    expect(panel.textContent).toContain('Plus gateway')
    expect(panel.textContent).not.toMatch(/Claude \(this machine\)|Claude · kai|MiniMax plan/)
  })
})

// A third engine with its OWN login import (ui.loginImport naming its routes):
// both surfaces ask the api by THIS descriptor — never OpenCode's routes.
const FAKE_LOGINS: HarnessDescriptor = {
  ...unknownDescriptor('fake-login'),
  label: 'Fake Login',
  providerKinds: ['harness-provider', 'harness-native'],
  ui: {
    ...unknownDescriptor('fake-login').ui,
    loginImport: { list: '/api/providers/fake-login/logins', import: '/api/providers/fake-login/import' },
    loginCommand: 'fake auth login',
  },
}
const isFakeLogins = (d: unknown): boolean => (d as HarnessDescriptor | undefined)?.id === 'fake-login'

describe('fake-login — the login import follows the descriptor', () => {
  beforeEach(() => {
    expect(setHarnessDescriptors([...SEED, FAKE_LOGINS])).toBe(true)
    mockedApi.providers.engineLogins.mockImplementation(async (d) => (isFakeLogins(d) ? ['acme'] : ['zai']))
    mockedApi.providers.importLogin.mockResolvedValue({
      id: 'acme-p',
      kind: 'harness-provider',
      label: 'acme',
      harness: 'fake-login',
      providerId: 'acme',
      apiKey: 'ac-…1',
      createdAt: '2026-10-29',
      window: null,
    } as unknown as ProviderView)
  })

  it('Settings › Providers: its section lists its logins and imports through its descriptor', async () => {
    mockedApi.account.mockResolvedValue(null)
    render(<ProvidersTab />)
    await screen.findByText('Import from Fake Login')
    expect(mockedApi.providers.engineLogins.mock.calls.some(([d]) => isFakeLogins(d))).toBe(true)
    fireEvent.click(await screen.findByLabelText('import acme'))
    await waitFor(() => expect(mockedApi.providers.importLogin).toHaveBeenCalledWith(expect.objectContaining({ id: 'fake-login' }), 'acme', 'acme'))
  })

  it('Run on panel: offers its own logins and imports through its descriptor', async () => {
    selectOn('fake-login')
    useStore.setState({ agents: [agentOn('fake-login')], detail: detailOn('fake-login') })
    useStore.getState().openProviderPanel(null)
    render(<ProviderPanel agent={agentOn('fake-login')} />)
    await settle()
    const dialog = screen.getByRole('dialog', { name: 'Run on' })
    expect(dialog.textContent).toContain('acme · login Fake Login holds')
    expect(dialog.textContent).not.toContain('zai')
    expect(mockedApi.providers.engineLogins.mock.calls.every(([d]) => isFakeLogins(d))).toBe(true)
    fireEvent.click(screen.getByLabelText('import acme'))
    await waitFor(() => expect(mockedApi.providers.importLogin).toHaveBeenCalledWith(expect.objectContaining({ id: 'fake-login' }), 'acme', 'acme'))
  })
})

// A third engine with console colours of its own: the row reads and writes
// ITS entry (prefs.consoleTheme.<id>), never OpenCode's, and the 'own' hint is
// its descriptor's (or none).
describe('fake-colours — the Console colours row is per engine', () => {
  const COLOURS: HarnessDescriptor = {
    ...unknownDescriptor('fake-colours'),
    label: 'Fake Colours',
    ui: { ...unknownDescriptor('fake-colours').ui, consoleColours: true, consoleColoursHint: 'press F7 inside it' },
  }
  const status: HarnessStatus = {
    harness: 'claude-code',
    name: 'Claude Code',
    checkedAt: '2026-10-29T10:00:00.000Z',
    console: { version: '2.1.304', path: '/u/claude' },
    library: { name: 'Agent SDK', version: '0.3.304', pairedWith: '2.1.304' },
    latest: '2.1.304',
    others: [
      { harness: 'opencode', name: 'OpenCode', version: '1.19.4', path: '/u/opencode', latest: null },
      { harness: 'fake-colours', name: 'Fake Colours', version: '0.1.0', path: '/u/fake', latest: null },
    ],
  }
  beforeEach(() => {
    expect(setHarnessDescriptors([...SEED, COLOURS])).toBe(true)
    mockedApi.harness.mockResolvedValue(status)
    mockedApi.account.mockResolvedValue(null)
    mockedApi.claudeSettings.mockRejectedValue(new Error('x'))
    mockedApi.refreshModels.mockResolvedValue({ models: [], fetchedAt: null })
    mockedApi.patchPrefsConsoleTheme.mockImplementation(async (h, v) => ({ consoleTheme: { opencode: 'silos', [h]: v } }))
    useStore.setState({ page: { kind: 'settings', tab: 'appearance' } })
  })

  it("reads its own entry (OpenCode's 'own' does not leak), writes its own id, and shows its own hint", async () => {
    mockedApi.prefs.mockResolvedValue({ consoleTheme: { opencode: 'own' } })
    render(<SettingsPage />)
    const group = await screen.findByRole('radiogroup', { name: 'Fake Colours console colours' })
    const ocGroup = await screen.findByRole('radiogroup', { name: 'OpenCode console colours' })
    await waitFor(() => expect(group.querySelector('input[type=radio]:checked')!.parentElement!.textContent).toBe('Follow Silos'))
    expect(ocGroup.querySelector('input[type=radio]:checked')!.parentElement!.textContent).toBe('OpenCode’s own')
    fireEvent.click(screen.getByRole('radio', { name: 'Fake Colours’s own' }))
    await waitFor(() => expect(mockedApi.patchPrefsConsoleTheme).toHaveBeenCalledWith('fake-colours', 'own'))
    expect(screen.getByText(/Fake Colours’s own theme — press F7 inside it\./)).toBeInTheDocument()
    expect(screen.queryByText(/Fake Colours’s own theme — change it with \/theme/)).toBeNull()
  })

  it('no hint declared: the plain sentence, never /theme', async () => {
    setHarnessDescriptors([...SEED, { ...COLOURS, ui: { ...COLOURS.ui, consoleColoursHint: null } }])
    mockedApi.prefs.mockResolvedValue({ consoleTheme: { 'fake-colours': 'own' } })
    render(<SettingsPage />)
    expect(await screen.findByText(/Fake Colours’s own theme/)).toBeInTheDocument()
    expect(screen.queryByText(/\/theme|F7/)).toBeNull()
  })
})

// ⌘K's message search names each engine whose conversations it could not
// read, by the server's per-engine count — never "OpenCode" for everyone.
describe('CommandPalette — the unsearched count names each engine', () => {
  beforeEach(() => {
    mockedApi.artifacts.mockResolvedValue({ artifacts: [], total: 0 })
    useStore.setState({ modal: 'palette', agents: [] } as never)
  })

  it.each([
    [{ fake: 3 }, 3, '3 Fake conversations'],
    [{ opencode: 2, fake: 1 }, 3, '2 OpenCode and 1 Fake conversations'],
    [{ 'not-an-engine': 1 }, 1, '1 not-an-engine conversation'],
  ] as const)('%j', async (by, total, text) => {
    mockedApi.search.mockResolvedValue({ hits: [], scanned: 4, truncated: false, unsearched: total, unsearchedBy: by })
    render(<CommandPalette />)
    fireEvent.change(screen.getByLabelText('search'), { target: { value: 'deploy' } })
    expect(await screen.findByText(`Message text not searched in ${text} — titles are`, { exact: false })).toBeInTheDocument()
  })

  it('a server that sends only the total names no engine', async () => {
    mockedApi.search.mockResolvedValue({ hits: [], scanned: 4, truncated: false, unsearched: 2 })
    render(<CommandPalette />)
    fireEvent.change(screen.getByLabelText('search'), { target: { value: 'deploy' } })
    expect(await screen.findByText(/not searched in 2 conversations —/)).toBeInTheDocument()
  })
})
