// opencode-providers-ui.test.tsx — the operator sees and manages OpenCode:
// Run on (opened from the composer's chips) and the agent
// form list only what the agent's harness can run, the model select follows the harness,
// Settings › Engines has an OpenCode row (its console colours in Appearance),
// and Settings › Accounts & providers imports
// OpenCode logins, copies config (no key) and says when a key is needed.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { CockpitChips } from '../src/components/CockpitChips'
import { ProviderPanel } from '../src/components/ProviderPanel'
import { SettingsPage } from '../src/components/SettingsPage'
import { ProvidersTab } from '../src/components/ProvidersTab'
import { SettingsTab } from '../src/components/agent/SettingsTab'
import { AgentModal } from '../src/components/AgentModal'
import { useStore } from '../src/store'
import { api } from '../src/lib/api'
import type { AgentView, HarnessStatus, ProviderView, SessionDetail } from '../src/lib/types'

vi.mock('../src/lib/api')
const mockedApi = vi.mocked(api, { deep: true })

const acct = (id: string, name: string, _display: string) => ({
  id,
  kind: 'claude-account',
  label: `Claude · ${name}`,
  window: null,
  account: { name, configDir: null, providerId: id, loggedIn: true, email: `${name}@x.com`, plan: 'max', shared: true },
})
const PROVIDERS = [
  acct('default', 'default', 'Owner'),
  acct('account:kai', 'kai', 'Kai'),
  { id: 'ci', kind: 'anthropic-compatible', label: 'cheapestinference', baseUrl: 'https://ci.test', apiKey: 'sk-…3456', createdAt: '2026-08-01', window: null },
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
  { id: 'zz', kind: 'harness-provider', label: 'Z.ai plan', harness: 'opencode', providerId: 'zai', apiKey: '', createdAt: '2026-10-26', window: null },
  { id: 'kn', kind: 'harness-native', label: 'Kimi login', harness: 'opencode', providerId: 'kimi-for-coding', createdAt: '2026-10-26', window: null },
] as unknown as ProviderView[]

function makeAgent(overrides: Partial<AgentView> = {}): AgentView {
  return { id: 'a1', name: 'Ana', emoji: '🧠', folder: '/x', skills: [], sessions: [], liveCount: 0, sessionCount: 0, ...overrides }
}
const detail: SessionDetail = {
  meta: {
    id: 's1',
    folder: 'f',
    title: 'S',
    skills: [],
    cwd: null,
    mtime: 0,
    size: 1,
    turnCount: 1,
    live: false,
    worktree: false,
    native: true,
    agentId: 'a1',
  },
  turns: [],
  total: 0,
}

beforeEach(() => {
  vi.clearAllMocks()
  mockedApi.conversationPrefs.patch.mockResolvedValue({})
})

describe("Run on, opened from the composer's account chip, follows the agent's harness", () => {
  function mount(agent: AgentView): void {
    mockedApi.providers.list.mockResolvedValue(PROVIDERS)
    useStore.setState({
      agents: [agent],
      selectedAgentId: 'a1',
      selected: { folder: 'f', id: 's1' },
      detail,
      catalog: [],
      convPrefs: {},
      pendingConvPrefs: {},
      turnOverrides: {},
      active: null,
      providers: PROVIDERS as never,
      chatMode: 'chat' as never,
      providerPanel: null,
    })
    render(
      <>
        <CockpitChips />
        <ProviderPanel agent={agent} />
      </>,
    )
    fireEvent.click(screen.getByTestId('chip-account'))
  }
  // the group buttons' titles, in order (each group's button is labelled «title — count»)
  const groups = () =>
    within(screen.getByRole('dialog', { name: 'Run on' }))
      .getAllByRole('button', { expanded: undefined })
      .filter((b) => b.hasAttribute('aria-expanded'))
      .map((b) => (b.getAttribute('aria-label') ?? '').replace(/ — .*$/, ''))

  it('an OpenCode agent lists only OpenCode providers and Anthropic-compatible keys — never a Claude account', () => {
    mount(makeAgent({ framework: 'opencode' }))
    expect(screen.getByTestId('chip-account')).toHaveTextContent('OpenCode login')
    expect(screen.getByTestId('run-on-agent-default')).toHaveTextContent(/Agent default/)
    expect(groups()).toEqual(['OpenCode’s own login', 'cheapestinference', 'MiniMax plan', 'Z.ai plan', 'Kimi login'])
  })

  it('a cleared key is listed as "key needed — add it below" and cannot be opened', () => {
    mount(makeAgent({ framework: 'opencode' }))
    const zai = within(screen.getByRole('dialog', { name: 'Run on' })).getByRole('button', { name: /Z\.ai plan/ })
    expect(zai).toBeDisabled()
    expect(zai).toHaveTextContent('key needed — add it below')
  })

  it('a Claude agent lists no OpenCode provider', () => {
    mount(makeAgent())
    const rows = groups().join(' | ')
    expect(rows).toContain('Claude · kai')
    expect(rows).toContain('cheapestinference')
    expect(rows).not.toMatch(/MiniMax|Z\.ai|Kimi/)
  })
})

describe('the agent form follows the harness', () => {
  beforeEach(() => {
    mockedApi.providers.list.mockResolvedValue(PROVIDERS)
    mockedApi.agents.update.mockResolvedValue(undefined)
    mockedApi.models.mockResolvedValue({
      models: [{ value: 'minimax-coding-plan/MiniMax-M3', displayName: 'MiniMax-M3', description: 'minimax-coding-plan' }],
      fetchedAt: '2026-10-26T10:00:00Z',
    })
  })
  const optionTexts = (label: string) => Array.from((screen.getByLabelText(label) as HTMLSelectElement).options).map((o) => o.textContent)

  it('OpenCode agent: no Claude accounts, the cleared key disabled and named, models from `opencode models` for its provider', async () => {
    render(<SettingsTab agent={makeAgent({ framework: 'opencode', provider: 'mm' })} fields="runs" />)
    await waitFor(() => expect(optionTexts('Provider')).toContain('MiniMax plan'))
    expect(optionTexts('Provider')).toEqual(['Default — OpenCode’s own login', 'cheapestinference', 'MiniMax plan', 'Z.ai plan — key needed', 'Kimi login'])
    const zai = Array.from((screen.getByLabelText('Provider') as HTMLSelectElement).options).find((o) => o.value === 'zz')!
    expect(zai.disabled).toBe(true)
    await waitFor(() => expect(mockedApi.models).toHaveBeenCalledWith('opencode', { provider: 'mm' }))
    await waitFor(() => expect(optionTexts('Model')).toEqual(['Default — OpenCode’s own', 'minimax-coding-plan/MiniMax-M3']))
  })

  it('an OpenCode agent already on a cleared key says what to do', async () => {
    render(<SettingsTab agent={makeAgent({ framework: 'opencode', provider: 'zz' })} fields="runs" />)
    await screen.findByText(/key was cleared — paste it again in Settings › Accounts & providers/)
  })

  it('Claude agent: no OpenCode providers, the long-standing Claude models, no OpenCode catalogue asked', async () => {
    render(<SettingsTab agent={makeAgent()} fields="runs" />)
    await waitFor(() => expect(optionTexts('Provider')).toContain('cheapestinference'))
    expect(optionTexts('Provider').join(' ')).not.toMatch(/MiniMax|Z\.ai|Kimi/)
    expect(optionTexts('Model')).toContain('claude-sonnet-5')
    expect(mockedApi.models).not.toHaveBeenCalled()
  })

  it("create modal: picking OpenCode swaps the model list to OpenCode's", async () => {
    mockedApi.complete.mockResolvedValue([])
    useStore.setState({ agents: [], modal: 'create', error: null })
    render(<AgentModal />)
    expect(optionTexts('Model')).toContain('claude-sonnet-5')
    fireEvent.click(screen.getByLabelText('OpenCode'))
    await waitFor(() => expect(optionTexts('Model')).toEqual(['Default — OpenCode’s own', 'minimax-coding-plan/MiniMax-M3']))
    expect(mockedApi.models).toHaveBeenCalledWith('opencode', { provider: 'default' })
  })
})

describe('Settings › Engines — the OpenCode row', () => {
  const status = (version: string | null): HarnessStatus => ({
    harness: 'claude-code',
    name: 'Claude Code',
    checkedAt: '2026-10-26T10:00:00.000Z',
    console: { version: '2.1.304', path: '/u/claude' },
    library: { name: 'Agent SDK', version: '0.3.304', pairedWith: '2.1.304' },
    latest: '2.1.304',
    others: [{ harness: 'opencode', name: 'OpenCode', version, path: version ? '/home/u/.opencode/bin/opencode' : null, latest: null }],
  })
  function mount(): void {
    mockedApi.account.mockResolvedValue(null)
    mockedApi.claudeSettings.mockRejectedValue(new Error('x'))
    mockedApi.refreshModels.mockResolvedValue({ models: [], fetchedAt: null })
    useStore.setState({ page: { kind: 'settings', tab: 'engines' } })
    render(<SettingsPage />)
  }

  it('says "OpenCode 1.14.22" with its path; Update runs opencode upgrade; Settings refreshes the OpenCode models on open', async () => {
    mockedApi.harness.mockResolvedValue(status('1.14.22'))
    mockedApi.updateHarness.mockResolvedValue({ before: '1.14.22', after: '1.15.0', output: 'ok' })
    mount()
    const line = await screen.findByText(/^OpenCode/, { selector: 'span' })
    expect(line).toHaveTextContent('OpenCode 1.14.22 · /home/u/.opencode/bin/opencode')
    await waitFor(() => expect(mockedApi.refreshModels).toHaveBeenCalledWith('opencode'))
    fireEvent.click(screen.getByRole('button', { name: 'Update' }))
    await screen.findByText(/New OpenCode consoles use it/)
    expect(mockedApi.updateHarness).toHaveBeenCalledWith('opencode')
    expect(line).toHaveTextContent('OpenCode 1.15.0')
  })

  it('Console colours (in Appearance): "Follow Silos" by default; choosing "OpenCode’s own" saves the pref and says /theme now decides', async () => {
    mockedApi.harness.mockResolvedValue(status('1.19.4'))
    mockedApi.prefs.mockResolvedValue({})
    mockedApi.patchPrefsConsoleTheme.mockResolvedValue({ consoleTheme: { opencode: 'own' } })
    mount()
    expect(screen.queryByRole('radio', { name: 'Follow Silos' })).toBeNull() // not an engine's setting
    fireEvent.click(screen.getByRole('button', { name: 'Appearance' }))
    const follow = await screen.findByRole('radio', { name: 'Follow Silos' })
    await waitFor(() => expect(follow).toBeChecked())
    expect(screen.getByText(/Light or dark with Silos, like the Claude console/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('radio', { name: 'OpenCode’s own' }))
    await waitFor(() => expect(mockedApi.patchPrefsConsoleTheme).toHaveBeenCalledWith('opencode', 'own'))
    expect(screen.getByText(/change it with \/theme inside the console/)).toBeInTheDocument()
  })

  it('not installed → "OpenCode not installed", no button', async () => {
    mockedApi.harness.mockResolvedValue(status(null))
    mount()
    await screen.findByText('OpenCode not installed')
    expect(screen.queryByRole('button', { name: 'Update' })).toBeNull()
  })
})

describe('Settings › Accounts & providers — OpenCode', () => {
  beforeEach(() => {
    mockedApi.providers.list.mockResolvedValue(PROVIDERS)
    mockedApi.providers.engineLogins.mockResolvedValue(['kimi-for-coding', 'minimax-coding-plan', 'zai', 'zai-coding-plan'])
  })

  it("lists OpenCode's logins; an id already in Silos reads imported; one click imports", async () => {
    mockedApi.providers.importLogin.mockResolvedValue(PROVIDERS[3]!)
    render(<ProvidersTab />)
    await screen.findByText('zai-coding-plan')
    // kimi (native), minimax and zai (keys) are already Silos providers
    expect(screen.getAllByText('imported')).toHaveLength(3)
    expect(screen.queryByLabelText('import zai')).toBeNull()
    fireEvent.click(screen.getByLabelText('import zai-coding-plan'))
    await waitFor(() =>
      expect(mockedApi.providers.importLogin).toHaveBeenCalledWith(expect.objectContaining({ id: 'opencode' }), 'zai-coding-plan', 'zai-coding-plan'),
    )
  })

  it('rows say what each runs on: masked key, "key needed — paste it again", OpenCode\'s shared login', async () => {
    mockedApi.providers.update.mockResolvedValue(PROVIDERS[4]!)
    render(<ProvidersTab />)
    await screen.findByText('MiniMax plan')
    expect(screen.getByText('mm-…3456')).toBeInTheDocument()
    expect(screen.getByText('key needed — paste it again')).toBeInTheDocument()
    expect(screen.getByText('login from OpenCode · shared by every OpenCode agent')).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Z.ai plan api key'), { target: { value: 'zai-new-key-123456' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save key' }))
    await waitFor(() => expect(mockedApi.providers.update).toHaveBeenCalledWith('zz', { apiKey: 'zai-new-key-123456' }))
  })

  it("Copy config puts the server's snippet (no key) on the clipboard; an Anthropic-compatible key asks which harness", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.assign(navigator, { clipboard: { writeText } })
    mockedApi.providers.exportConfig.mockResolvedValue('{"provider":{"minimax-coding-plan":{"options":{"apiKey":"<paste your key>"}}}}\n')
    render(<ProvidersTab />)
    const row = (await screen.findByText('MiniMax plan')).closest('li')!
    fireEvent.click(within(row).getByRole('button', { name: 'Copy config' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(expect.stringContaining('<paste your key>')))
    expect(mockedApi.providers.exportConfig).toHaveBeenCalledWith('mm', 'opencode')
    await within(row).findByText(/Copied/)
  })

  it('the OpenCode provider form creates either kind — a login needs no key', async () => {
    mockedApi.providers.create.mockResolvedValue(PROVIDERS[5]!)
    render(<ProvidersTab />)
    fireEvent.click(await screen.findByRole('button', { name: 'OpenCode provider' }))
    fireEvent.click(screen.getByLabelText('OpenCode’s login'))
    expect(screen.queryByLabelText('api key')).toBeNull()
    fireEvent.change(screen.getByLabelText('provider name'), { target: { value: 'Z coding' } })
    fireEvent.change(screen.getByLabelText('opencode provider id'), { target: { value: 'zai-coding-plan' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add provider' }))
    await waitFor(() =>
      expect(mockedApi.providers.create).toHaveBeenCalledWith({
        kind: 'harness-native',
        harness: 'opencode',
        label: 'Z coding',
        providerId: 'zai-coding-plan',
      }),
    )
  })
})

// Coordinator rulings (pre-review): the composer's model chip uses the SAME
// filter as the agent form, and an Anthropic-compatible gateway on OpenCode
// takes a typed model id, stored bare, shown as silos-<id>/<model>.
describe("the composer model chip follows the agent's harness", () => {
  const OC_MODELS = [
    { value: 'minimax-coding-plan/MiniMax-M2.7', displayName: 'MiniMax-M2.7', description: 'minimax-coding-plan' },
    { value: 'minimax-coding-plan/MiniMax-M3', displayName: 'MiniMax-M3', description: 'minimax-coding-plan' },
  ]
  const CLAUDE = [
    { value: 'default', resolvedModel: 'claude-opus-5[1m]', displayName: 'Default (recommended)' },
    { value: 'sonnet', resolvedModel: 'claude-sonnet-5', displayName: 'Sonnet' },
  ]
  function mount(agent: AgentView, conv = {}): void {
    useStore.setState({
      agents: [agent],
      selectedAgentId: 'a1',
      selected: { folder: 'f', id: 's1' },
      detail,
      catalog: CLAUDE as never,
      convPrefs: conv,
      pendingConvPrefs: {},
      turnOverrides: {},
      active: null,
      providers: PROVIDERS as never,
      chatMode: 'chat' as never,
      providerPanel: null,
    })
    render(
      <>
        <CockpitChips />
        <ProviderPanel agent={agent} />
      </>,
    )
  }
  // the open group's model rows in Run on (the «Agent default» row apart)
  const modelRows = () =>
    within(screen.getByRole('dialog', { name: 'Run on' }))
      .getAllByRole('menuitemradio')
      .filter((el) => el.hasAttribute('data-provider'))
      .map((el) => el.textContent ?? '')

  it('an OpenCode agent lists the OpenCode catalogue its provider reaches — no Claude model', async () => {
    mockedApi.models.mockResolvedValue({ models: OC_MODELS, fetchedAt: 'x' })
    mount(makeAgent({ framework: 'opencode', provider: 'mm', model: 'minimax-coding-plan/MiniMax-M2.7' }))
    await waitFor(() => expect(mockedApi.models).toHaveBeenCalledWith('opencode', { provider: 'mm' }))
    await waitFor(() => expect(screen.getByTestId('chip-model')).toHaveTextContent('minimax-coding-plan/MiniMax-M2.7'))
    fireEvent.click(screen.getByTestId('chip-model'))
    await waitFor(() => expect(modelRows()).toContain('minimax-coding-plan/MiniMax-M3'))
    const rows = modelRows().join(' | ')
    expect(rows).toContain('minimax-coding-plan/MiniMax-M2.7')
    expect(rows).not.toMatch(/Sonnet|Default \(recommended\)|claude-/)
    mockedApi.conversationPrefs.patchApplied.mockResolvedValue({ prefs: {}, applied: 'next-turn' })
    fireEvent.click(screen.getByText('minimax-coding-plan/MiniMax-M3'))
    await waitFor(() => expect(useStore.getState().convPrefs.model).toBe('minimax-coding-plan/MiniMax-M3'))
  })

  it("a Claude agent keeps the SDK catalogue and never asks for OpenCode's", () => {
    mount(makeAgent({ model: 'sonnet' }))
    expect(screen.getByTestId('chip-model')).toHaveTextContent('Sonnet')
    fireEvent.click(screen.getByTestId('chip-model'))
    expect(modelRows().map((r) => r.replace(/default$/, ''))).toEqual(['Default (recommended)', 'Sonnet'])
    expect(screen.getByLabelText('another model id')).toBeInTheDocument()
    expect(mockedApi.models).not.toHaveBeenCalled()
  })

  it('an Anthropic-compatible gateway: the chip shows the bare model (never silos-<id>/), a typed id is stored bare', async () => {
    mount(makeAgent({ framework: 'opencode', provider: 'ci', model: 'claude-sonnet-4-5' }))
    expect(mockedApi.models).not.toHaveBeenCalled() // a gateway's models are its own names
    expect(screen.getByTestId('chip-model')).toHaveTextContent('claude-sonnet-4-5')
    fireEvent.click(screen.getByTestId('chip-model'))
    const input = within(screen.getByRole('dialog', { name: 'Run on' })).getByLabelText('model id')
    fireEvent.change(input, { target: { value: 'silos-ci/claude-opus-4-1' } })
    mockedApi.conversationPrefs.patchApplied.mockResolvedValue({ prefs: {}, applied: 'next-turn' })
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Run on' })).getByRole('button', { name: 'Use' }))
    await waitFor(() => expect(mockedApi.conversationPrefs.patchApplied).toHaveBeenCalledWith('f', 's1', { provider: 'ci', model: 'claude-opus-4-1' }))
    expect(screen.getByTestId('chip-model')).toHaveTextContent('claude-opus-4-1')
  })
})

describe('an Anthropic-compatible gateway in the agent form and the runs-on line', () => {
  beforeEach(() => {
    mockedApi.providers.list.mockResolvedValue(PROVIDERS)
    mockedApi.agents.update.mockResolvedValue(undefined)
  })

  it('the model is a typed id, shown as silos-<id>/<model>, saved bare', async () => {
    render(<SettingsTab agent={makeAgent({ framework: 'opencode', provider: 'ci', model: 'claude-sonnet-4-5' })} fields="runs" />)
    const input = await screen.findByPlaceholderText('model id as your gateway names it, e.g. claude-sonnet-4-5')
    expect(input).toHaveValue('claude-sonnet-4-5')
    expect(screen.getByText(/^Runs as/)).toHaveTextContent('Runs as claude-sonnet-4-5 on')
    fireEvent.change(input, { target: { value: 'silos-ci/claude-opus-4-1' } })
    expect(input).toHaveValue('claude-opus-4-1')
    fireEvent.click(screen.getByText('Save'))
    await waitFor(() => expect(mockedApi.agents.update).toHaveBeenCalled())
    expect(mockedApi.agents.update.mock.calls[0]![1]).toMatchObject({ model: 'claude-opus-4-1', provider: 'ci' })
    expect(mockedApi.models).not.toHaveBeenCalled()
  })

  it('runs-on names the gateway model as it runs before OpenCode reports one', async () => {
    const { runsOnLine } = await import('../src/lib/runs-on')
    const agent = makeAgent({ framework: 'opencode', provider: 'ci', model: 'claude-sonnet-4-5' })
    expect(runsOnLine({ agent, providers: PROVIDERS, catalog: [], harness: 'opencode' })).toBe('claude-sonnet-4-5 · cheapestinference')
    expect(runsOnLine({ agent, providers: PROVIDERS, catalog: [], harness: 'opencode', pinnedModel: 'claude-opus-4-1' })).toBe(
      'claude-opus-4-1 · cheapestinference',
    )
    expect(runsOnLine({ agent, providers: PROVIDERS, catalog: [], harness: 'opencode', observedModel: 'silos-ci/claude-sonnet-4-5' })).toBe(
      'claude-sonnet-4-5 · cheapestinference',
    )
    // a catalogue provider: the stored bare id under its OpenCode id
    expect(
      runsOnLine({
        agent: makeAgent({ framework: 'opencode', provider: 'mm', model: 'MiniMax-M2.7' }),
        providers: PROVIDERS,
        catalog: [],
        harness: 'opencode',
      }),
    ).toBe('MiniMax-M2.7 · minimax-coding-plan')
  })
})
