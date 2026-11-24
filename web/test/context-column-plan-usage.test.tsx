// context-column-plan-usage.test.tsx — the subscription's 5h/weekly bars
// under the runs-on line: drawn for a Claude account with the reading's
// percent and pace sentence, never for a key (no call either), and a stale
// reading says how old it is.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { ContextColumn } from '../src/components/ContextColumn'
import { useStore } from '../src/store'
import { api } from '../src/lib/api'
import type { AgentView, PlanUsage, ProviderView, SessionView } from '../src/lib/types'

vi.mock('../src/lib/api')
const mockedApi = vi.mocked(api, { deep: true })

const meta: SessionView = {
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
}
const ACCOUNT = {
  id: 'default',
  kind: 'claude-account',
  label: 'Claude (this machine)',
  window: null,
  account: { name: 'default', configDir: null, providerId: 'default', loggedIn: true, email: 'o@x.com', plan: null, shared: true },
} as unknown as ProviderView
const KEY = { id: 'ci', kind: 'anthropic-compatible', label: 'cheapestinference', window: null } as unknown as ProviderView
const in1h = new Date(Date.now() + 3600_000).toISOString()
const READING: PlanUsage = {
  ok: true,
  at: Date.now(),
  stale: false,
  windows: [
    { kind: 'session', label: '5h', percent: 4, resetsAt: in1h, windowMs: 5 * 3600_000, severity: 'normal', active: false },
    { kind: 'weekly_scoped', label: 'Fable', percent: 100, resetsAt: in1h, windowMs: 7 * 86_400_000, severity: 'critical', active: true },
  ],
}

function setup(provider: string): void {
  const agent = {
    id: 'a1',
    name: 'Ana',
    emoji: '🧠',
    role: 'writer',
    folder: '/x',
    skills: [],
    sessions: [],
    liveCount: 0,
    sessionCount: 0,
    provider,
  } as AgentView
  useStore.setState({
    chatMode: 'chat',
    agents: [agent],
    automations: [],
    automationsPending: [],
    nowTick: Date.now(),
    selectedAgentId: 'a1',
    selected: { folder: 'f', id: 's1' },
    active: null,
    modal: null,
    error: null,
    page: null,
    contextOpen: true,
    contextScope: 'conversation',
    convPrefs: {},
    pendingConvPrefs: {},
    turnOverrides: {},
    catalog: [],
    providers: [ACCOUNT, KEY],
    detail: { meta, turns: [], total: 0 },
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  mockedApi.patchPrefsContextScope.mockResolvedValue({})
})

describe('plan usage bars', () => {
  it('a Claude account: one bar per window, percent and sentence', async () => {
    mockedApi.planUsage.mockResolvedValue(READING)
    setup('default')
    render(<ContextColumn />)
    const bars = await screen.findByTestId('plan-usage')
    expect(mockedApi.planUsage).toHaveBeenCalledWith('default')
    expect(bars).toHaveTextContent('5h')
    expect(bars).toHaveTextContent('4%')
    expect(bars).toHaveTextContent('Fable')
    expect(bars).toHaveTextContent('100%')
    expect(screen.getByRole('img', { name: /^5-hour window: 4% used · resets \d\d:\d\d · \d+% of the window gone$/ })).toBeInTheDocument()
    expect(screen.getByRole('img', { name: /^Fable weekly window: 100% used/ })).toBeInTheDocument()
  })

  it('a key: no bars and no call', async () => {
    mockedApi.planUsage.mockResolvedValue(READING)
    setup('ci')
    render(<ContextColumn />)
    // the column has rendered and run its effects
    await screen.findAllByText('This conversation')
    expect(mockedApi.planUsage).not.toHaveBeenCalled()
    expect(screen.queryByTestId('plan-usage')).not.toBeInTheDocument()
  })

  it('a stale reading stays, dimmed, with its time', async () => {
    mockedApi.planUsage.mockResolvedValue({ ...READING, stale: true })
    setup('default')
    render(<ContextColumn />)
    const bars = await screen.findByTestId('plan-usage')
    expect(bars.className).toMatch(/opacity-60/)
    expect(bars.getAttribute('title')).toMatch(/^As of \d\d:\d\d/)
  })

  it('no reading (not logged in): no bars', async () => {
    mockedApi.planUsage.mockResolvedValue({ ok: false, at: Date.now(), reason: 'not-logged-in' })
    setup('default')
    render(<ContextColumn />)
    await waitFor(() => expect(mockedApi.planUsage).toHaveBeenCalled())
    expect(screen.queryByTestId('plan-usage')).not.toBeInTheDocument()
  })
})
