// providers-tab.test.tsx — Settings › Providers (Claude account cards with
// an honest 5h bar, "Connect another account" via terminal, the
// cheapestinference widget, and a custom provider). Keys arrive from the
// server ALREADY masked — this only checks the UI doesn't invent anything.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ProvidersTab, CHEAPESTINFERENCE_KEYS_URL } from '../src/components/ProvidersTab'
import { api } from '../src/lib/api'
import type { ClaudeAccountView, ProviderView } from '../src/lib/types'

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

function account(overrides: Partial<ClaudeAccountView> = {}): ClaudeAccountView {
  return {
    name: 'default',
    configDir: null,
    providerId: 'default',
    loggedIn: true,
    email: 'owner@x.com',
    plan: 'max',
    shared: true,
    window: null,
    ...overrides,
  }
}

function providerAccount(c: ClaudeAccountView): ProviderView {
  return {
    id: c.providerId,
    kind: 'claude-account',
    label: c.name === 'default' ? 'Claude (this machine)' : `Claude · ${c.name}`,
    account: c,
    window: c.window ?? null,
  }
}

function provKey(overrides: Partial<Extract<ProviderView, { kind: 'anthropic-compatible' }>> = {}): ProviderView {
  return {
    id: 'p1',
    kind: 'anthropic-compatible',
    label: 'cheapestinference',
    baseUrl: 'https://api.cheapestinference.com/anthropic',
    apiKey: 'sk-…3456',
    createdAt: '2026-08-20T00:00:00.000Z',
    window: null,
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockedApi.providers.list.mockResolvedValue([providerAccount(account())])
  mockedApi.accounts.login.mockResolvedValue({ terminal: { id: 'term-1', agentId: null, cwd: '/d' } })
  mockedApi.terminals.kill.mockResolvedValue(undefined)
  mockedApi.accounts.verify.mockResolvedValue(account({ name: 'work', loggedIn: false }))
})

describe('ProvidersTab — Claude accounts', () => {
  it('with a known window, the bar carries its utilization', async () => {
    mockedApi.providers.list.mockResolvedValue([
      providerAccount(
        account({
          window: { status: 'allowed_warning', utilization: 87, kind: 'five_hour', resetsAt: '2026-08-20T15:00:00.000Z', at: '2026-08-20T13:00:00.000Z' },
        }),
      ),
    ])
    render(<ProvidersTab />)
    await waitFor(() => expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '87'))
  })

  it('"Connect another account": creates the account and opens Claude\'s own sign-in here, with the terminal command as the other way', async () => {
    mockedApi.accounts.create.mockResolvedValue({
      name: 'work',
      configDir: '/home/o/.silos/claude-accounts/work',
      command: 'CLAUDE_CONFIG_DIR=/home/o/.silos/claude-accounts/work claude login',
    })
    render(<ProvidersTab />)
    await waitFor(() => expect(screen.getByText('owner@x.com')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: /Connect another account/ }))
    fireEvent.change(screen.getByLabelText('account name'), { target: { value: 'work' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    await waitFor(() => expect(mockedApi.accounts.create).toHaveBeenCalledWith('work'))
    // the sign-in is the claude binary's, never a login form of Silos's
    await waitFor(() => expect(mockedApi.accounts.login).toHaveBeenCalledWith('work'))
    expect(screen.queryByLabelText(/password/i)).toBeNull()
    // the other way, folded: the command for the owner's own terminal + Verify
    fireEvent.click(screen.getByRole('button', { name: /Sign in from your own terminal instead/ }))
    expect(screen.getByText('CLAUDE_CONFIG_DIR=/home/o/.silos/claude-accounts/work claude login')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Verify' })).toBeInTheDocument()
  })

  it('a card that is not logged in offers Sign in', async () => {
    mockedApi.providers.list.mockResolvedValue([
      providerAccount(account()),
      providerAccount(
        account({ name: 'work', providerId: 'account:work', configDir: '/home/o/.silos/claude-accounts/work', loggedIn: false, email: null, plan: null }),
      ),
    ])
    render(<ProvidersTab />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    await waitFor(() => expect(mockedApi.accounts.login).toHaveBeenCalledWith('work'))
  })
})

describe('ProvidersTab — the cheapestinference widget', () => {
  it('with no key: a "Get your key" link to its site + a paste field + Connect', async () => {
    render(<ProvidersTab />)
    await waitFor(() => expect(screen.getByText(/cheapest/)).toBeInTheDocument())
    const link = screen.getByRole('link', { name: /Get your key/ })
    expect(link).toHaveAttribute('href', CHEAPESTINFERENCE_KEYS_URL)
    expect(screen.getByLabelText('cheapestinference api key')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Connect' })).toBeDisabled()
  })

  it("Connect is ONE server call that verifies the key on the proxy's baseUrl before storing it", async () => {
    mockedApi.providers.connect.mockResolvedValue({ provider: provKey(), models: [] })
    render(<ProvidersTab />)
    await waitFor(() => expect(screen.getByText(/cheapest/)).toBeInTheDocument())
    fireEvent.change(screen.getByLabelText('cheapestinference api key'), { target: { value: 'sk-live-abcdef123456' } })
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
    await waitFor(() =>
      expect(mockedApi.providers.connect).toHaveBeenCalledWith({
        label: 'cheapestinference',
        baseUrl: 'https://api.cheapestinference.com/anthropic',
        apiKey: 'sk-live-abcdef123456',
      }),
    )
    expect(mockedApi.providers.create).not.toHaveBeenCalled()
  })

  it('connected: shows the MASKED key and a connected status after verifying', async () => {
    mockedApi.providers.list.mockResolvedValue([providerAccount(account()), provKey()])
    mockedApi.providers.verify.mockResolvedValue({ ok: true })
    render(<ProvidersTab />)
    await waitFor(() => expect(screen.getByText('sk-…3456')).toBeInTheDocument())
    expect(screen.getByText('connected')).toBeInTheDocument()
    expect(screen.queryByText(/sk-live/)).not.toBeInTheDocument()
  })

  // deliberately a non-English error, to prove the UI passes it through
  // verbatim rather than reformatting or translating it.
  it("a failed verify shows the server's error as-is, in whatever language it arrives in", async () => {
    mockedApi.providers.list.mockResolvedValue([providerAccount(account()), provKey()])
    mockedApi.providers.verify.mockResolvedValue({ ok: false, error: 'upstream refused the key (HTTP 401)' })
    render(<ProvidersTab />)
    await waitFor(() => expect(screen.getByText('sk-…3456')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: 'Verify' }))
    await waitFor(() => expect(screen.getByText('upstream refused the key (HTTP 401)')).toBeInTheDocument())
  })
})

describe('ProvidersTab — one cheapestinference row per key', () => {
  it('three keys are three rows, each named after what it reaches, with its models and masked key; the field adds another', async () => {
    mockedApi.providers.list.mockResolvedValue([
      providerAccount(account()),
      provKey({ id: 'k1', label: 'cheapestinference · kimi-k3, qwen3.8-max', models: ['kimi-k3', 'qwen3.8-max'], apiKey: 'sk-…1111' }),
      provKey({ id: 'k2', label: 'cheapestinference · glm-5.3, minimax-m3', models: ['glm-5.3', 'minimax-m3'], apiKey: 'sk-…2222' }),
      provKey({ id: 'k3', label: 'cheapestinference', apiKey: 'sk-…3333' }),
    ])
    render(<ProvidersTab />)
    await waitFor(() => expect(screen.getByText('cheapestinference · kimi-k3, qwen3.8-max')).toBeInTheDocument())
    expect(screen.getByText('cheapestinference · glm-5.3, minimax-m3')).toBeInTheDocument()
    expect(screen.getByText('kimi-k3 · qwen3.8-max')).toBeInTheDocument()
    expect(screen.getByText('sk-…3333')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Add another key' })).toBeDisabled()
    expect(screen.getAllByRole('button', { name: 'Verify' })).toHaveLength(3)
    // the rows live in the widget, not in the custom list
    expect(screen.queryByText('key required')).toBeNull()
  })

  it("a refused key is shown in the server's words and nothing is stored", async () => {
    mockedApi.providers.connect.mockRejectedValue(new Error('the provider rejected the key (HTTP 401)'))
    render(<ProvidersTab />)
    await waitFor(() => expect(screen.getByText(/cheapest/)).toBeInTheDocument())
    fireEvent.change(screen.getByLabelText('cheapestinference api key'), { target: { value: 'sk-live-wrong-9999' } })
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
    await waitFor(() => expect(screen.getByText('the provider rejected the key (HTTP 401)')).toBeInTheDocument())
    expect(mockedApi.providers.create).not.toHaveBeenCalled()
  })
})

describe('ProvidersTab — a custom provider', () => {
  it('the form requires a label, base URL and key; creates + verifies', async () => {
    mockedApi.providers.create.mockResolvedValue(provKey({ id: 'p2', label: 'my-proxy', baseUrl: 'https://my.proxy/anthropic' }))
    mockedApi.providers.verify.mockResolvedValue({ ok: true })
    render(<ProvidersTab />)
    await waitFor(() => expect(screen.getByText('owner@x.com')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: /Custom provider/ }))
    const button = screen.getByRole('button', { name: 'Add provider' })
    expect(button).toBeDisabled()
    fireEvent.change(screen.getByLabelText('provider name'), { target: { value: 'my-proxy' } })
    fireEvent.change(screen.getByLabelText('base url'), { target: { value: 'https://my.proxy/anthropic' } })
    fireEvent.change(screen.getByLabelText('api key'), { target: { value: 'sk-x-99990000' } })
    expect(button).toBeEnabled()
    fireEvent.click(button)
    await waitFor(() => expect(mockedApi.providers.verify).toHaveBeenCalledWith('p2'))
    expect(mockedApi.providers.create).toHaveBeenCalledWith({ label: 'my-proxy', baseUrl: 'https://my.proxy/anthropic', apiKey: 'sk-x-99990000' })
  })

  // an exact baseUrl comparison — a custom provider with 'cheapestinference.com'
  // somewhere in the host is NOT absorbed into the widget.
  it('a custom provider with a host that merely resembles cheapestinference is NOT absorbed into the widget', async () => {
    mockedApi.providers.list.mockResolvedValue([
      providerAccount(account()),
      provKey({ id: 'p9', label: 'suspicious', baseUrl: 'https://cheapestinference.com.evil.io/anthropic', apiKey: 'sk-…6666' }),
    ])
    render(<ProvidersTab />)
    await waitFor(() => expect(screen.getByText('suspicious')).toBeInTheDocument()) // in the custom list
    // the widget stays in "not connected" state: a paste field + Connect
    expect(screen.getByRole('button', { name: 'Connect' })).toBeInTheDocument()
  })

  // a baseUrl PATCH invalidates the key server-side — the widget/rows must
  // show "key required", not a blank or "connected".
  it('a provider with an invalidated key (an empty apiKey) asks to paste it again, with no connected dot', async () => {
    mockedApi.providers.list.mockResolvedValue([providerAccount(account()), provKey({ apiKey: '' })])
    render(<ProvidersTab />)
    await waitFor(() => expect(screen.getAllByText(/key required/i).length).toBeGreaterThan(0))
    expect(screen.queryByText('connected')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Connect' })).toBeInTheDocument() // not "Update key"
  })

  it('existing custom providers are listed with a masked key and Remove', async () => {
    mockedApi.providers.list.mockResolvedValue([
      providerAccount(account()),
      provKey({ id: 'p3', label: 'byok', baseUrl: 'https://other.proxy', apiKey: 'sk-…7777' }),
    ])
    mockedApi.providers.delete.mockResolvedValue(undefined)
    render(<ProvidersTab />)
    await waitFor(() => expect(screen.getByText('byok')).toBeInTheDocument())
    expect(screen.getByText('sk-…7777')).toBeInTheDocument()
    // arm→confirm: first click arms (no delete yet), second confirms
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
    expect(mockedApi.providers.delete).not.toHaveBeenCalled()
    fireEvent.click(screen.getByText('Remove?'))
    await waitFor(() => expect(mockedApi.providers.delete).toHaveBeenCalledWith('p3'))
  })
})
