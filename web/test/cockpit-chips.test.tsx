// cockpit-chips.test.tsx — the cockpit's chips per state: the effective
// truth (default / conversation override / a "next turn" one-shot), effort
// and fast mode hidden when the catalog doesn't confirm them, an amber
// shield tint outside bypass, and the echo's warn chip. Model and account
// are SHOWN here and edited in Run on: their chips open it.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { CockpitChips } from '../src/components/CockpitChips'
import { useStore } from '../src/store'
import { api } from '../src/lib/api'
import type { AgentView, ModelInfo, SessionDetail, SessionView } from '../src/lib/types'

vi.mock('../src/lib/api')
const mockedApi = vi.mocked(api, { deep: true })

const CATALOG: ModelInfo[] = [
  {
    value: 'default',
    resolvedModel: 'claude-opus-5[1m]',
    displayName: 'Default (recommended)',
    supportsEffort: true,
    supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
    supportsFastMode: true,
  },
  {
    value: 'sonnet',
    resolvedModel: 'claude-sonnet-5',
    displayName: 'Sonnet',
    supportsEffort: true,
    supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
  },
  { value: 'haiku', resolvedModel: 'claude-haiku-4-5-20251001', displayName: 'Haiku' },
]

function makeAgent(overrides: Partial<AgentView> = {}): AgentView {
  return {
    id: 'a1',
    name: 'Ana',
    emoji: '🧠',
    folder: '/x',
    skills: [],
    sessions: [],
    liveCount: 0,
    sessionCount: 0,
    ...overrides,
  }
}
function makeDetail(overrides: Partial<SessionView> = {}): SessionDetail {
  return {
    meta: {
      id: 's1',
      folder: 'f',
      title: 'Session',
      skills: [],
      cwd: null,
      mtime: 0,
      size: 1,
      turnCount: 1,
      live: false,
      worktree: false,
      native: true,
      agentId: 'a1',
      ...overrides,
    },
    turns: [],
    total: 0,
  }
}

const modelChip = () => screen.getByTestId('chip-model')
const accountChip = () => screen.getByTestId('chip-account')

beforeEach(() => {
  vi.clearAllMocks()
  mockedApi.conversationPrefs.patch.mockResolvedValue({})
  useStore.setState({
    agents: [makeAgent({ model: 'sonnet' })],
    selectedAgentId: 'a1',
    selected: { folder: 'f', id: 's1' },
    detail: makeDetail(),
    catalog: CATALOG,
    convPrefs: {},
    pendingConvPrefs: {},
    turnOverrides: {},
    active: null,
    providerPanel: null,
  })
})

describe('the default state (a cascade with no overrides)', () => {
  it("the model chip shows the agent's default, resolved against the catalog", () => {
    render(<CockpitChips />)
    expect(modelChip()).toHaveTextContent('Sonnet')
  })

  it('effort is visible (the catalog confirms support) with the "default" truth; the shield is calm in bypass', () => {
    render(<CockpitChips />)
    expect(screen.getByLabelText('effort selector')).toHaveTextContent('default')
    const shield = screen.getByLabelText('permission mode selector')
    expect(shield).toHaveTextContent('bypass')
  })

  it("an agent with no model: the chip says Default (the CLI's truth, no invented id)", () => {
    useStore.setState({ agents: [makeAgent()] })
    render(<CockpitChips />)
    expect(modelChip()).toHaveTextContent('Default (recommended)')
  })
})

describe('model and account have one editor — Run on', () => {
  it('the model chip opens Run on (no menu of its own)', () => {
    render(<CockpitChips />)
    fireEvent.click(modelChip())
    expect(useStore.getState().providerPanel).toEqual({ reason: null })
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('the account chip opens Run on too', () => {
    render(<CockpitChips />)
    fireEvent.click(accountChip())
    expect(useStore.getState().providerPanel).toEqual({ reason: null })
  })
})

describe('a conversation override', () => {
  it("the chip shows the override's effective value", () => {
    useStore.setState({ convPrefs: { model: 'haiku' } })
    render(<CockpitChips />)
    expect(modelChip()).toHaveTextContent('Haiku')
    expect(screen.queryByText('· next turn')).toBeNull() // a conversation is not a one-shot
  })

  it("effort is HIDDEN if the effective model doesn't support it per the catalog (haiku)", () => {
    useStore.setState({ convPrefs: { model: 'haiku' } })
    render(<CockpitChips />)
    expect(screen.queryByLabelText('effort selector')).toBeNull()
  })
})

describe('a one-shot (a turn override)', () => {
  it('marks "next turn" on the affected chip', () => {
    useStore.setState({ turnOverrides: { model: 'haiku' } })
    render(<CockpitChips />)
    expect(modelChip()).toHaveTextContent('Haiku')
    expect(modelChip()).toHaveTextContent('· next turn')
  })

  it('with "next turn only" on, choosing a value goes to turnOverrides (never PATCHes anything)', () => {
    render(<CockpitChips />)
    fireEvent.click(screen.getByLabelText('permission mode selector'))
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: /next turn only/ }))
    fireEvent.click(screen.getByRole('menuitemradio', { name: /Plan mode/ }))
    expect(useStore.getState().turnOverrides).toEqual({ permissionMode: 'plan' })
    expect(useStore.getState().convPrefs).toEqual({})
    expect(mockedApi.conversationPrefs.patch).not.toHaveBeenCalled()
  })
})

describe('the shield — amber outside bypass', () => {
  it('plan (conversation) tints the chip amber with its label', () => {
    useStore.setState({ convPrefs: { permissionMode: 'plan' } })
    render(<CockpitChips />)
    const shield = screen.getByLabelText('permission mode selector')
    expect(shield).toHaveTextContent('plan mode')
  })

  it('accept edits too', () => {
    useStore.setState({ convPrefs: { permissionMode: 'acceptEdits' } })
    render(<CockpitChips />)
    expect(screen.getByLabelText('permission mode selector')).toHaveTextContent('accept edits')
  })
})

describe('fast mode — a chip of its own', () => {
  it('the chip only exists when the catalog confirms the effective model supports it', () => {
    // sonnet (the agent's default) doesn't support fast → no chip
    render(<CockpitChips />)
    expect(screen.queryByLabelText('fast mode selector')).toBeNull()
  })

  it('with a model that supports it: On sets the conversation, the chip says so', () => {
    useStore.setState({ convPrefs: { model: 'default' } })
    render(<CockpitChips />)
    expect(screen.getByLabelText('fast mode selector')).not.toHaveTextContent('on')
    fireEvent.click(screen.getByLabelText('fast mode selector'))
    fireEvent.click(screen.getByRole('menuitemradio', { name: /^On/ }))
    expect(useStore.getState().convPrefs).toEqual({ model: 'default', fastMode: true })
    expect(screen.getByLabelText('fast mode selector')).toHaveTextContent('fast · on')
  })
})

describe('an empty catalog — honesty', () => {
  it('with no catalog, effort support cannot be verified → the chip is hidden', () => {
    useStore.setState({ catalog: [], agents: [makeAgent({ model: 'sonnet' })] })
    render(<CockpitChips />)
    expect(modelChip()).toHaveTextContent('sonnet')
    expect(screen.queryByLabelText('effort selector')).toBeNull()
  })
})

describe('an existing override never becomes invisible', () => {
  it('an effort override on an unsupported model: the chip stays VISIBLE, amber "unsupported", and clearable from its menu', () => {
    useStore.setState({ convPrefs: { model: 'haiku', effort: 'max' } })
    render(<CockpitChips />)
    const chip = screen.getByLabelText('effort selector')
    expect(chip).toHaveTextContent('effort · max')
    expect(chip).toHaveTextContent('unsupported')

    fireEvent.click(chip)
    fireEvent.click(screen.getByRole('menuitemradio', { name: /Model default/ }))
    expect(useStore.getState().convPrefs).toEqual({ model: 'haiku' })
    expect(mockedApi.conversationPrefs.patch).toHaveBeenCalledWith('f', 's1', { effort: null })
    // with no override and no support, the chip disappears again (the original rule)
    expect(screen.queryByLabelText('effort selector')).toBeNull()
  })

  it('an active fastMode on an unsupported model: the chip stays visible (unsupported) and can be turned off', () => {
    useStore.setState({ convPrefs: { model: 'haiku', fastMode: true } })
    render(<CockpitChips />)
    const chip = screen.getByLabelText('fast mode selector')
    expect(chip).toHaveTextContent('unsupported')
    fireEvent.click(chip)
    fireEvent.click(screen.getByRole('menuitemradio', { name: /^Off/ }))
    expect(useStore.getState().convPrefs).toEqual({ model: 'haiku' }) // off = the field is gone
  })
})

describe('Esc closes the menus', () => {
  it('Esc with a menu open closes it and consumes the event (the global Esc contract does not fire)', () => {
    render(<CockpitChips />)
    fireEvent.click(screen.getByLabelText('permission mode selector'))
    expect(screen.getByRole('menu', { name: 'permission mode' })).toBeInTheDocument()
    const consumed = !fireEvent.keyDown(screen.getByRole('menu', { name: 'permission mode' }), { key: 'Escape' })
    expect(screen.queryByRole('menu', { name: 'permission mode' })).toBeNull()
    expect(consumed).toBe(true) // preventDefault → the global handler (e.defaultPrevented) respects it
  })
})

describe('an honest echo (the warn chip)', () => {
  it("a requested-vs-init mismatch → an amber chip with the process's truth", () => {
    useStore.setState({
      active: {
        turnId: 't1',
        agentId: 'a1',
        text: '',
        tools: [],
        status: 'streaming',
        userText: 'x',
        requested: { model: 'sonnet', permissionMode: 'plan' },
        echo: { model: 'claude-sonnet-5', permissionMode: 'bypassPermissions' },
      },
    })
    render(<CockpitChips />)
    expect(screen.getByRole('status')).toHaveTextContent('ran in bypass')
  })

  it('a resolved alias is NOT a mismatch (no warn)', () => {
    useStore.setState({
      active: {
        turnId: 't1',
        agentId: 'a1',
        text: '',
        tools: [],
        status: 'streaming',
        userText: 'x',
        requested: { model: 'sonnet', permissionMode: 'bypassPermissions' },
        echo: { model: 'claude-sonnet-5', permissionMode: 'bypassPermissions' },
      },
    })
    render(<CockpitChips />)
    expect(screen.queryByRole('status')).toBeNull()
  })
})

// The account chip: which Claude login or key THIS conversation spends
// (several subscriptions, picked per conversation, always visible;
// a fallback is declared, never a silent rotation).
describe('the account chip', () => {
  const PROVIDERS = [
    {
      id: 'default',
      kind: 'claude-account',
      label: 'Claude (this machine)',
      window: null,
      account: { name: 'default', configDir: null, providerId: 'default', loggedIn: true, email: 'o@x.com', plan: 'max', shared: true },
    },
    {
      id: 'account:kai',
      kind: 'claude-account',
      label: 'Claude · kai',
      window: null,
      account: { name: 'kai', configDir: '/x/kai', providerId: 'account:kai', loggedIn: true, email: 'kai@x.com', plan: 'pro', shared: true },
    },
    {
      id: 'account:cold',
      kind: 'claude-account',
      label: 'Claude · cold',
      window: null,
      account: { name: 'cold', configDir: '/x/cold', providerId: 'account:cold', loggedIn: false, email: null, plan: null, shared: true },
    },
    { id: 'ci', kind: 'anthropic-compatible', label: 'cheapestinference', baseUrl: 'https://ci.test', apiKey: 'k', createdAt: '2026-08-01', window: null },
  ] as never[]

  beforeEach(() => {
    useStore.setState({ providers: PROVIDERS as never, chatMode: 'chat' as never })
  })

  it("shows the agent's own account by default, the conversation's pin when set", () => {
    render(<CockpitChips />)
    expect(accountChip()).toHaveTextContent('o')
    act(() => useStore.setState({ convPrefs: { provider: 'account:kai' } }))
    expect(accountChip()).toHaveTextContent('kai')
  })

  it('an agent fallback diverting THIS conversation tints the chip amber and names where it runs; a pinned conversation is untouched', () => {
    useStore.setState({ agents: [makeAgent({ model: 'sonnet', onFallback: { providerId: 'ci', from: 'default', until: '2026-10-23T15:00:00.000Z' } })] })
    const { rerender } = render(<CockpitChips />)
    const chip = accountChip()
    expect(chip).toHaveTextContent('cheapestinference')
    expect(chip).toHaveTextContent('fallback')
    act(() => useStore.setState({ convPrefs: { provider: 'account:kai' } }))
    rerender(<CockpitChips />)
    expect(accountChip()).toHaveTextContent('kai')
    expect(accountChip()).not.toHaveTextContent('fallback')
  })
})
