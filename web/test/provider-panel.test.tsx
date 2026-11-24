// provider-panel.test.tsx — "Run on": one list of every model the engine can
// run, grouped by the provider that runs it; a click on a model is the
// decision (chat: applied, console: a restart bar); keys and logins are
// added in the same list. Opened from the column's runs-on line (always;
// with the reason when the conversation cannot run) and the account chip.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { ProviderPanel, defaultModelFor } from '../src/components/ProviderPanel'
import { CockpitChips } from '../src/components/CockpitChips'
import { ContextColumn } from '../src/components/ContextColumn'
import { useStore } from '../src/store'
import { api } from '../src/lib/api'
import type { AgentView, ProviderView, SessionDetail, Turn } from '../src/lib/types'

vi.mock('../src/lib/api')
// the sign-in reads Claude's output over its own socket — a socket that never opens is enough here
class IdleSocket {
  static OPEN = 1
  readyState = 0
  constructor(public url: string) {}
  addEventListener() {}
  send() {}
  close() {}
}
vi.stubGlobal('WebSocket', IdleSocket)
const mockedApi = vi.mocked(api, { deep: true })

const acct = (id: string, name: string, loggedIn = true) => ({
  id,
  kind: 'claude-account',
  label: id === 'default' ? 'Claude (this machine)' : `Claude · ${name}`,
  window: null,
  account: { name, configDir: null, providerId: id, loggedIn, email: `${name}@x.com`, plan: 'max', shared: true },
})
const CI = {
  id: 'ci',
  kind: 'anthropic-compatible',
  label: 'cheapestinference · kimi-k3, qwen3.8-max',
  baseUrl: 'https://api.cheapestinference.com/anthropic',
  apiKey: 'sk-…3456',
  models: ['kimi-k3', 'qwen3.8-max'],
  modelsAt: new Date(Date.now() - 2 * 3600_000).toISOString(),
  createdAt: '2026-10-27',
  window: null,
}
const PROVIDERS = [
  acct('default', 'default'),
  acct('account:kai', 'kai', false),
  CI,
  { id: 'zz', kind: 'harness-provider', label: 'Z.ai plan', harness: 'opencode', providerId: 'zai', apiKey: 'zk-…1234', createdAt: '2026-10-26', window: null },
  { id: 'kn', kind: 'harness-native', label: 'Kimi login', harness: 'opencode', providerId: 'kimi-for-coding', createdAt: '2026-10-26', window: null },
] as unknown as ProviderView[]
const CATALOG = [
  { value: 'default', resolvedModel: 'claude-opus-5', displayName: 'Default (recommended)' },
  { value: 'sonnet', resolvedModel: 'claude-sonnet-5', displayName: 'Sonnet' },
]

function agent(over: Partial<AgentView> = {}): AgentView {
  return { id: 'a1', name: 'Smoke', emoji: '🧪', folder: '/x', skills: [], sessions: [], liveCount: 0, sessionCount: 0, ...over }
}
const turn = (over: Partial<Turn>): Turn => ({ index: 0, role: 'assistant', text: 'ok', tools: [], ts: null, ...over })
function detail(turns: Turn[], harness: 'opencode' | 'claude-code' = 'opencode'): SessionDetail {
  return {
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
      harness,
    } as SessionDetail['meta'],
    turns,
    total: turns.length,
  }
}
const dialog = () => screen.getByRole('dialog', { name: 'Run on' })
const groupButton = (name: RegExp) => within(dialog()).getByRole('button', { name })
const modelRows = (provider?: string) =>
  within(dialog())
    .getAllByRole('menuitemradio')
    .filter((el) => provider === undefined || el.getAttribute('data-provider') === provider)
const rowTexts = (provider?: string) =>
  modelRows(provider)
    .map((el) => el.textContent ?? '')
    .join(' | ')
const checked = () =>
  within(dialog())
    .queryAllByRole('menuitemradio')
    .find((el) => el.getAttribute('aria-checked') === 'true')?.textContent ?? null

beforeEach(() => {
  vi.clearAllMocks()
  mockedApi.conversationPrefs.patch.mockResolvedValue({})
  mockedApi.conversationPrefs.patchApplied.mockResolvedValue({ prefs: {}, applied: 'next-turn' })
  mockedApi.providers.list.mockResolvedValue(PROVIDERS)
  mockedApi.providers.engineLogins.mockResolvedValue(['zai', 'kimi-for-coding', 'minimax-coding-plan'])
  mockedApi.models.mockImplementation((async (_h?: unknown, q?: { provider?: string }) => ({
    models: q?.provider === 'zz' ? [{ value: 'zai/glm-5.3', displayName: 'glm-5.3' }] : [{ value: 'opencode/big-pickle', displayName: 'big-pickle' }],
    fetchedAt: 'x',
  })) as never)
  useStore.setState({
    providers: PROVIDERS,
    catalog: CATALOG as never,
    agents: [agent({ framework: 'opencode' })],
    selectedAgentId: 'a1',
    selected: { folder: 'f', id: 's1' },
    convPrefs: {},
    pendingConvPrefs: {},
    turnOverrides: {},
    providerPanel: null,
    detail: detail([]),
    chatMode: 'chat',
    consoleRestartRequest: 0,
  })
})

describe('defaultModelFor', () => {
  it('a key never defaults to "no model" (its first real one); the engine\'s own login keeps its default row', () => {
    const opts = [
      { value: '', label: 'Default — OpenCode’s own' },
      { value: 'zai/glm-5.3', label: 'zai/glm-5.3' },
    ]
    expect(defaultModelFor(opts, 'harness-provider')).toBe('zai/glm-5.3')
    expect(defaultModelFor(opts, 'harness-native')).toBe('')
    expect(defaultModelFor([{ value: 'kimi-k3', label: 'kimi-k3' }], 'anthropic-compatible')).toBe('kimi-k3')
    expect(
      defaultModelFor(
        [
          { value: 'default', label: 'Default (recommended)' },
          { value: 'sonnet', label: 'Sonnet' },
        ],
        'claude-account',
      ),
    ).toBe('default')
  })
})

describe('Run on — the list', () => {
  it('is nothing until opened; opened with a reason, it leads with the reason and reloads the providers', async () => {
    const { rerender } = render(<ProviderPanel agent={agent({ framework: 'opencode' })} />)
    expect(screen.queryByRole('dialog', { name: 'Run on' })).toBeNull()
    useStore.getState().openProviderPanel('zai: Insufficient balance or no resource package. Please recharge. (429)')
    rerender(<ProviderPanel agent={agent({ framework: 'opencode' })} />)
    expect(within(dialog()).getByTestId('cannot-run-reason')).toHaveTextContent('zai: Insufficient balance')
    await waitFor(() => expect(mockedApi.providers.list).toHaveBeenCalled())
  })

  it('an OpenCode agent: one group per provider the engine can run — its own login, each login, each key — never a Claude account; the current group is open, the others say how many models they hold', async () => {
    useStore.getState().openProviderPanel(null)
    render(<ProviderPanel agent={agent({ framework: 'opencode' })} />)
    expect(groupButton(/OpenCode’s own login/)).toHaveAttribute('aria-expanded', 'true')
    await waitFor(() => expect(rowTexts('default')).toContain('big-pickle'))
    expect(rowTexts('default')).toMatch(/Default — OpenCode’s own.*default/)
    expect(groupButton(/Z.ai plan/)).toHaveAttribute('aria-expanded', 'false')
    expect(groupButton(/Kimi login/)).toBeInTheDocument()
    expect(groupButton(/cheapestinference · kimi-k3, qwen3.8-max — 2 models/)).toBeInTheDocument()
    expect(within(dialog()).getByText(/sk-…3456 · listed 2h ago/)).toBeInTheDocument()
    expect(within(dialog()).queryByText(/Claude \(this machine\)|Claude · kai/)).toBeNull()
    // a login OpenCode holds but Silos has not imported, one click away; "Add a key" folded to a line
    await waitFor(() => expect(within(dialog()).getByRole('button', { name: 'import minimax-coding-plan' })).toBeInTheDocument())
    expect(within(dialog()).getByRole('button', { name: /Add a key/ })).toBeInTheDocument()
  })

  it("a Claude Code agent: the machine's account first with the Claude catalog, a logged-out account offering to sign in, keys — never an OpenCode login", () => {
    useStore.setState({ agents: [agent()], detail: detail([], 'claude-code') })
    useStore.getState().openProviderPanel(null)
    render(<ProviderPanel agent={agent()} />)
    expect(groupButton(/Claude \(this machine\)/)).toHaveAttribute('aria-expanded', 'true')
    expect(rowTexts('default')).toMatch(/Default \(recommended\).*Sonnet/)
    expect(groupButton(/Claude · kai/)).toBeEnabled()
    expect(groupButton(/Claude · kai/).textContent).toMatch(/not logged in.*Sign in/)
    expect(groupButton(/cheapestinference · kimi-k3/)).toBeInTheDocument()
    expect(within(dialog()).queryByText(/Z.ai plan|Kimi login/)).toBeNull()
  })

  it("opening a key's group lists exactly the models its key reaches — no default row, no catalogue", () => {
    useStore.getState().openProviderPanel(null)
    render(<ProviderPanel agent={agent({ framework: 'opencode' })} />)
    fireEvent.click(groupButton(/cheapestinference · kimi-k3/))
    expect(rowTexts('ci')).toBe('kimi-k3 | qwen3.8-max')
    expect(groupButton(/OpenCode’s own login/)).toHaveAttribute('aria-expanded', 'false') // the own-login group folded
  })
})

describe('Run on — a click is the decision', () => {
  it("chat: clicking a model pins provider + model for the conversation and closes; the checkbox also makes them the agent's default", async () => {
    mockedApi.agents.update.mockResolvedValue(undefined)
    useStore.getState().openProviderPanel(null)
    render(<ProviderPanel agent={agent({ framework: 'opencode' })} />)
    fireEvent.click(screen.getByRole('checkbox', { name: /Also make it Smoke’s default/ }))
    fireEvent.click(groupButton(/cheapestinference · kimi-k3/))
    fireEvent.click(within(dialog()).getByRole('menuitemradio', { name: /qwen3.8-max/ }))
    await waitFor(() => expect(mockedApi.agents.update).toHaveBeenCalledWith('a1', { provider: 'ci', model: 'qwen3.8-max' }))
    expect(mockedApi.conversationPrefs.patchApplied).toHaveBeenCalledWith('f', 's1', { provider: 'ci', model: 'qwen3.8-max' })
    await waitFor(() => expect(useStore.getState().providerPanel).toBeNull())
    expect(useStore.getState().consoleRestartRequest).toBe(0)
  })

  it('console: a click pins and, when the server switched the live session in place, just closes — no restart', async () => {
    mockedApi.conversationPrefs.patchApplied.mockResolvedValue({ prefs: { provider: 'ci', model: 'qwen3.8-max' }, applied: 'live' })
    useStore.setState({ chatMode: 'console', convPrefs: { provider: 'ci', model: 'kimi-k3' } })
    useStore.getState().openProviderPanel(null)
    render(<ProviderPanel agent={agent({ framework: 'opencode' })} />)
    expect(checked()).toMatch(/kimi-k3/) // what it runs on now
    fireEvent.click(within(dialog()).getByRole('menuitemradio', { name: /qwen3.8-max/ }))
    await waitFor(() => expect(mockedApi.conversationPrefs.patchApplied).toHaveBeenCalledWith('f', 's1', { provider: 'ci', model: 'qwen3.8-max' }))
    await waitFor(() => expect(useStore.getState().providerPanel).toBeNull())
    expect(useStore.getState().consoleRestartRequest).toBe(0)
    expect(useStore.getState().convPrefs).toMatchObject({ provider: 'ci', model: 'qwen3.8-max' })
  })

  it('console: when the running process cannot reach the pick, it is saved and the console relaunches on it at once — no bar to click', async () => {
    mockedApi.conversationPrefs.patchApplied.mockResolvedValue({ prefs: { provider: 'ci', model: 'qwen3.8-max' }, applied: 'restart' })
    useStore.setState({ chatMode: 'console', convPrefs: {} })
    useStore.getState().openProviderPanel('zai: 429')
    render(<ProviderPanel agent={agent({ framework: 'opencode' })} />)
    fireEvent.click(groupButton(/cheapestinference · kimi-k3/))
    fireEvent.click(within(dialog()).getByRole('menuitemradio', { name: /qwen3.8-max/ }))
    await waitFor(() => expect(useStore.getState().consoleRestartRequest).toBe(1))
    await waitFor(() => expect(useStore.getState().providerPanel).toBeNull())
    expect(screen.queryByRole('button', { name: /Restart the console/ })).not.toBeInTheDocument()
    expect(useStore.getState().convPrefs).toMatchObject({ provider: 'ci', model: 'qwen3.8-max' })
  })

  it("«Agent default» on top names the agent's own pair, is checked while nothing is pinned, and clears both pins", async () => {
    useStore.setState({ agents: [agent()], detail: detail([], 'claude-code'), convPrefs: {} })
    useStore.getState().openProviderPanel(null)
    const { unmount } = render(<ProviderPanel agent={agent({ model: 'sonnet' })} />)
    const row = within(dialog()).getByTestId('run-on-agent-default')
    expect(row).toHaveAttribute('aria-checked', 'true')
    expect(row.textContent).toMatch(/Agent default.*Sonnet/)
    unmount()
    useStore.setState({ convPrefs: { provider: 'ci', model: 'kimi-k3' } })
    useStore.getState().openProviderPanel(null)
    render(<ProviderPanel agent={agent({ model: 'sonnet' })} />)
    expect(within(dialog()).getByTestId('run-on-agent-default')).toHaveAttribute('aria-checked', 'false')
    fireEvent.click(within(dialog()).getByTestId('run-on-agent-default'))
    await waitFor(() => expect(mockedApi.conversationPrefs.patchApplied).toHaveBeenCalledWith('f', 's1', { provider: null, model: null }))
  })

  it("the machine's account is a real group: picking in it pins that account — never the agent's own by stealth", async () => {
    useStore.setState({ agents: [agent({ provider: 'ci' })], detail: detail([], 'claude-code') })
    useStore.getState().openProviderPanel(null)
    render(<ProviderPanel agent={agent({ provider: 'ci' })} />)
    fireEvent.click(groupButton(/Claude \(this machine\)/))
    fireEvent.click(within(dialog()).getByRole('menuitemradio', { name: /Sonnet/ }))
    await waitFor(() => expect(mockedApi.conversationPrefs.patchApplied).toHaveBeenCalledWith('f', 's1', { provider: 'default', model: 'sonnet' }))
  })

  it('a Claude account takes a model id its catalog does not list yet, typed under the list', async () => {
    useStore.setState({ agents: [agent()], detail: detail([], 'claude-code') })
    useStore.getState().openProviderPanel(null)
    render(<ProviderPanel agent={agent()} />)
    const input = within(dialog()).getByLabelText('another model id')
    fireEvent.change(input, { target: { value: 'claude-next-1' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(mockedApi.conversationPrefs.patchApplied).toHaveBeenCalledWith('f', 's1', { provider: 'default', model: 'claude-next-1' }))
  })

  it('«Next message only» (a started chat): the pick rides the next send as a one-shot — nothing is pinned or saved', async () => {
    useStore.setState({ agents: [agent()], detail: detail([], 'claude-code') })
    useStore.getState().openProviderPanel(null)
    render(<ProviderPanel agent={agent()} />)
    fireEvent.click(within(dialog()).getByRole('checkbox', { name: /Next message only/ }))
    expect(within(dialog()).getByRole('checkbox', { name: /Also make it Smoke’s default/ })).toBeDisabled()
    fireEvent.click(within(dialog()).getByRole('menuitemradio', { name: /Sonnet/ }))
    await waitFor(() => expect(useStore.getState().providerPanel).toBeNull())
    expect(useStore.getState().turnOverrides).toEqual({ provider: 'default', model: 'sonnet' })
    expect(useStore.getState().convPrefs).toEqual({})
    expect(mockedApi.conversationPrefs.patchApplied).not.toHaveBeenCalled()
  })

  it('a console has no one-shot: «Next message only» is not offered', () => {
    useStore.setState({ chatMode: 'console' })
    useStore.getState().openProviderPanel(null)
    render(<ProviderPanel agent={agent({ framework: 'opencode' })} />)
    expect(within(dialog()).queryByRole('checkbox', { name: /Next message only/ })).toBeNull()
  })

  it('adding a key: ONE connect call; the new provider appears as an open group with its models; a click on one pins it', async () => {
    const fresh = {
      id: 'new',
      kind: 'anthropic-compatible',
      label: 'cheapestinference · glm-5.3, minimax-m3',
      baseUrl: 'https://api.cheapestinference.com/anthropic',
      apiKey: 'sk-…7777',
      models: ['glm-5.3', 'minimax-m3'],
      createdAt: '2026-10-27',
      window: null,
    }
    mockedApi.providers.connect.mockResolvedValue({ provider: fresh as unknown as ProviderView, models: ['glm-5.3', 'minimax-m3'] })
    mockedApi.providers.list.mockResolvedValue([...PROVIDERS, fresh as unknown as ProviderView])
    useStore.getState().openProviderPanel(null)
    render(<ProviderPanel agent={agent({ framework: 'opencode' })} />)
    fireEvent.click(within(dialog()).getByRole('button', { name: /Add a key/ }))
    fireEvent.change(screen.getByLabelText('api key'), { target: { value: 'sk-live-frontier-7777' } })
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
    await waitFor(() =>
      expect(mockedApi.providers.connect).toHaveBeenCalledWith({
        label: 'cheapestinference',
        baseUrl: 'https://api.cheapestinference.com/anthropic',
        apiKey: 'sk-live-frontier-7777',
      }),
    )
    await waitFor(() => expect(groupButton(/cheapestinference · glm-5.3, minimax-m3/)).toHaveAttribute('aria-expanded', 'true'))
    expect(rowTexts('new')).toBe('glm-5.3 | minimax-m3')
    expect(mockedApi.providers.create).not.toHaveBeenCalled()
    expect(screen.queryByText(/sk-live/)).toBeNull()
    fireEvent.click(within(dialog()).getByRole('menuitemradio', { name: /minimax-m3/ }))
    await waitFor(() => expect(mockedApi.conversationPrefs.patchApplied).toHaveBeenCalledWith('f', 's1', { provider: 'new', model: 'minimax-m3' }))
  })

  it("a rejected key shows the server's words; nothing stored, nothing pinned", async () => {
    mockedApi.providers.connect.mockRejectedValue(new Error('the provider responded HTTP 404: The model does not exist'))
    useStore.getState().openProviderPanel(null)
    render(<ProviderPanel agent={agent({ framework: 'opencode' })} />)
    fireEvent.click(within(dialog()).getByRole('button', { name: /Add a key/ }))
    fireEvent.change(screen.getByLabelText('api key'), { target: { value: 'sk-live-wrong' } })
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
    await waitFor(() => expect(screen.getByText('the provider responded HTTP 404: The model does not exist')).toBeInTheDocument())
    expect(mockedApi.conversationPrefs.patchApplied).not.toHaveBeenCalled()
    expect(mockedApi.providers.create).not.toHaveBeenCalled()
  })

  it('a key with no list takes a typed model id ("other endpoint" path)', async () => {
    const gw = {
      id: 'gw',
      kind: 'anthropic-compatible',
      label: 'byok.test',
      baseUrl: 'https://byok.test',
      apiKey: 'sk-…1111',
      createdAt: '2026-10-27',
      window: null,
    }
    mockedApi.providers.connect.mockResolvedValue({ provider: gw as unknown as ProviderView, models: [] })
    mockedApi.providers.list.mockResolvedValue([...PROVIDERS, gw as unknown as ProviderView])
    useStore.getState().openProviderPanel(null)
    render(<ProviderPanel agent={agent({ framework: 'opencode' })} />)
    fireEvent.click(within(dialog()).getByRole('button', { name: /Add a key/ }))
    fireEvent.click(screen.getByRole('button', { name: 'other endpoint' }))
    fireEvent.change(screen.getByLabelText('base url'), { target: { value: 'https://byok.test' } })
    fireEvent.change(screen.getByLabelText('api key'), { target: { value: 'sk-live-1111' } })
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
    await waitFor(() => expect(mockedApi.providers.connect).toHaveBeenCalled())
    useStore.setState({ providers: [...PROVIDERS, gw as unknown as ProviderView] })
    await waitFor(() => expect(within(dialog()).getByLabelText('model id')).toBeInTheDocument())
    fireEvent.change(within(dialog()).getByLabelText('model id'), { target: { value: 'my-model' } })
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Use' }))
    await waitFor(() => expect(mockedApi.conversationPrefs.patchApplied).toHaveBeenCalledWith('f', 's1', { provider: 'gw', model: 'my-model' }))
  })
})

describe('entry points', () => {
  it("the column's runs-on line is the alert when the last turn is the engine's refusal — a click opens the panel with that reason", () => {
    const refusal = 'zai: Insufficient balance or no resource package. Please recharge. (429)'
    useStore.setState({ detail: detail([turn({ role: 'user', text: 'hi' }), turn({ synthetic: true, turnEnded: true, text: refusal })]) })
    render(<ContextColumn />)
    fireEvent.click(screen.getByRole('button', { name: /Can’t run · zai: Insufficient balance/ }))
    expect(useStore.getState().providerPanel).toEqual({ reason: refusal })
  })

  it('a pinned model the key no longer lists is the alert too', () => {
    useStore.setState({
      convPrefs: { provider: 'ci', model: 'glm-9' },
      detail: detail([turn({ role: 'user', text: 'hi' }), turn({ text: 'Hello', turnEnded: true })]),
    })
    render(<ContextColumn />)
    fireEvent.click(screen.getByRole('button', { name: /Can’t run · cheapestinference · kimi-k3, qwen3.8-max no longer lists glm-9/ }))
    expect(useStore.getState().providerPanel?.reason).toContain('no longer lists glm-9')
  })

  it('with nothing wrong, the runs-on line is still the control: a click opens the panel without a reason', () => {
    useStore.setState({ detail: detail([turn({ role: 'user', text: 'hi' }), turn({ text: 'Hello', turnEnded: true })]) })
    render(<ContextColumn />)
    expect(screen.queryByRole('button', { name: /Can’t run/ })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Change what it runs on' }))
    expect(useStore.getState().providerPanel).toEqual({ reason: null })
  })

  it("a conversation pinned to a key opens Run on on that key's models — on a Claude agent too, never the Claude catalog", () => {
    useStore.setState({ agents: [agent()], detail: detail([], 'claude-code'), convPrefs: { provider: 'ci' } })
    useStore.getState().openProviderPanel(null)
    render(<ProviderPanel agent={agent()} />)
    expect(groupButton(/cheapestinference · kimi-k3/)).toHaveAttribute('aria-expanded', 'true')
    expect(rowTexts('ci')).toBe('kimi-k3 | qwen3.8-max')
  })
})

describe('Run on — signing in to a Claude account', () => {
  beforeEach(() => {
    useStore.setState({ agents: [agent()], detail: detail([], 'claude-code') })
    mockedApi.accounts.login.mockResolvedValue({ terminal: { id: 'term-1', agentId: null, cwd: '/d' } })
    mockedApi.terminals.kill.mockResolvedValue(undefined)
    mockedApi.accounts.verify.mockResolvedValue({
      name: 'kai',
      configDir: '/d',
      providerId: 'account:kai',
      loggedIn: false,
      email: null,
      plan: null,
      shared: true,
    })
  })

  it("opening a logged-out account IS signing in: Claude's own sign-in in a terminal inside the row, Silos only watches for the login", async () => {
    useStore.getState().openProviderPanel(null)
    render(<ProviderPanel agent={agent()} />)
    fireEvent.click(groupButton(/Claude · kai/))
    await waitFor(() => expect(screen.getByText(/Open Claude’s sign-in page/)).toBeInTheDocument())
    expect(mockedApi.accounts.login).toHaveBeenCalledWith('kai')
    expect(within(dialog()).getByLabelText('code from Claude')).toBeInTheDocument()
    // the login lands: the panel re-reads its providers
    mockedApi.accounts.verify.mockResolvedValue({
      name: 'kai',
      configDir: '/d',
      providerId: 'account:kai',
      loggedIn: true,
      email: 'kai@x.com',
      plan: 'max',
      shared: true,
    })
    const before = mockedApi.providers.list.mock.calls.length
    await waitFor(() => expect(mockedApi.providers.list.mock.calls.length).toBeGreaterThan(before), { timeout: 3500 })
  })

  it("a logged-out account the conversation runs on is never opened by the panel itself — signing in is the owner's click", () => {
    useStore.setState({ agents: [agent({ provider: 'account:kai' })] })
    useStore.getState().openProviderPanel(null)
    render(<ProviderPanel agent={agent({ provider: 'account:kai' })} />)
    expect(groupButton(/Claude · kai/)).toHaveAttribute('aria-expanded', 'false')
    expect(mockedApi.accounts.login).not.toHaveBeenCalled()
  })

  it('Add a Claude account: a name, then the same sign-in', async () => {
    mockedApi.accounts.create.mockResolvedValue({ name: 'work', configDir: '/w', command: 'x' })
    useStore.getState().openProviderPanel(null)
    render(<ProviderPanel agent={agent()} />)
    fireEvent.click(within(dialog()).getByRole('button', { name: /Add a Claude account/ }))
    fireEvent.change(within(dialog()).getByLabelText('account name'), { target: { value: 'Work' } })
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Sign in' }))
    await waitFor(() => expect(mockedApi.accounts.login).toHaveBeenCalledWith('work'))
    expect(mockedApi.accounts.create).toHaveBeenCalledWith('work')
    await waitFor(() => expect(screen.getByText(/Open Claude’s sign-in page/)).toBeInTheDocument())
  })

  it('an OpenCode agent is never offered a Claude account', () => {
    useStore.setState({ agents: [agent({ framework: 'opencode' })], detail: detail([]) })
    useStore.getState().openProviderPanel(null)
    render(<ProviderPanel agent={agent({ framework: 'opencode' })} />)
    expect(within(dialog()).queryByRole('button', { name: /Add a Claude account/ })).toBeNull()
  })

  it("the composer's model chip names a key's model bare — never OpenCode's silos-<id>/ prefix", () => {
    useStore.setState({ convPrefs: { provider: 'ci', model: 'qwen3.8-max' } })
    render(<CockpitChips />)
    expect(screen.getByTestId('chip-model')).toHaveTextContent('qwen3.8-max')
    expect(screen.getByTestId('chip-model').textContent).not.toContain('silos-')
  })
})
