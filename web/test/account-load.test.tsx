// account-load.test.tsx — Home's "who is on my Claude subscription right
// now": the phrase builders per variant, and the line under the pulse
// (shown on the unscoped Home only, hidden when nothing runs, unfolding
// in place into its groups).
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { HomePage } from '../src/components/home/HomePage'
import { useStore } from '../src/store'
import { api } from '../src/lib/api'
import { accountLoadGroups, accountLoadLines } from '../src/lib/account-load'
import type { AccountLoad, AccountLoadEntry, AgentView } from '../src/lib/types'

vi.mock('../src/lib/api')
const mockedApi = vi.mocked(api, { deep: true })

function entry(over: Partial<Omit<AccountLoadEntry, 'bySource'>> & { bySource?: Partial<AccountLoadEntry['bySource']> } = {}): AccountLoadEntry {
  const bySource = { console: 0, silos: 0, nested: 0, outside: 0, ...(over.bySource ?? {}) }
  return { account: 'default', outside: [], consoles: [], ...over, bySource, total: bySource.console + bySource.silos + bySource.nested + bySource.outside }
}
const load = (...accounts: AccountLoadEntry[]): AccountLoad => ({ supported: true, at: 1, accounts })

const OWNERS_MACHINE = entry({
  bySource: { console: 10, outside: 2 },
  consoles: [
    { agentId: 'silos', count: 6 },
    { agentId: 'support', count: 2 },
    { agentId: 'writer', count: 1 },
    { agentId: 'builder', count: 1 },
  ],
  outside: [{ label: 'claude-mem plugin', count: 2 }],
})

describe('accountLoadLines', () => {
  it('several outside launchers are counted by label', () => {
    const e = entry({
      bySource: { outside: 3 },
      outside: [
        { label: 'claude-mem plugin', count: 2 },
        { label: 'tmux', count: 1 },
      ],
    })
    const text = accountLoadLines(load(e))[0]!.text
    expect(text).toContain('claude-mem plugin')
    expect(text).toContain('tmux')
  })

  it('several accounts in use: one line each, named', () => {
    const lines = accountLoadLines(
      load(entry({ bySource: { console: 2 } }), entry({ account: 'work', bySource: { outside: 1 }, outside: [{ label: 'tmux', count: 1 }] })),
    )
    expect(lines.map((l) => l.account)).toEqual(['default', 'work'])
    expect(lines[1]!.text).toContain('work')
  })

  it('a single account that is not the machine login is still named', () => {
    expect(accountLoadLines(load(entry({ account: 'work', bySource: { console: 1 } })))[0]!.text).toContain('work')
  })

  it('a scan that hit its cap says so', () => {
    expect(accountLoadLines({ ...load(entry({ bySource: { console: 2 } })), truncated: true } as AccountLoad)[0]!.text).toMatch(/partial/)
  })

  it('nothing running, unsupported or no data → no line', () => {
    expect(accountLoadLines(load())).toEqual([])
    expect(accountLoadLines(load(entry()))).toEqual([])
    expect(accountLoadLines({ supported: false })).toEqual([])
    expect(accountLoadLines(null)).toEqual([])
  })
})

describe('accountLoadGroups', () => {
  it('consoles by agent name, Silos chats, nested runs, outside by label', () => {
    const e = entry({
      bySource: { console: 3, silos: 1, nested: 2, outside: 2 },
      consoles: [{ agentId: 'builder', count: 2 }, { count: 1 }],
      outside: [{ label: 'claude-mem plugin', count: 2 }],
    })
    const groups = accountLoadGroups(e, (id) => (id === 'builder' ? 'Builder' : null))
    expect(groups.map((g) => g.key)).toEqual(['console:builder', 'console:', 'silos', 'nested', 'outside:claude-mem plugin'])
    expect(groups[0]).toMatchObject({ label: 'Builder', agentId: 'builder' })
  })
  it('an agent the store does not know is named by its id', () => {
    const e = entry({ bySource: { console: 1 }, consoles: [{ agentId: 'ghost', count: 1 }] })
    expect(accountLoadGroups(e, () => null)[0]).toMatchObject({ label: 'ghost', agentId: 'ghost' })
  })
})

function makeAgent(over: Partial<AgentView> = {}): AgentView {
  return { id: 'builder', name: 'Builder', emoji: '🛠', folder: '/proj', skills: [], sessions: [], liveCount: 0, sessionCount: 0, ...over }
}

describe('HomePage — the account line', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockedApi.board.mockResolvedValue({ cards: [], needsYou: [], inbox: [] })
    mockedApi.tasks.mockResolvedValue({ sessions: [] })
    useStore.setState({
      agents: [makeAgent(), makeAgent({ id: 'silos', name: 'Silos writer' })],
      automations: [],
      automationsPending: [],
      nowTick: Date.parse('2026-10-28T10:00:00Z'),
      page: null,
    })
  })

  it('says who is on the subscription under the pulse, and unfolds into groups', async () => {
    mockedApi.accountLoad.mockResolvedValue(load(OWNERS_MACHINE))
    render(<HomePage />)
    const line = await screen.findByRole('button', { name: /10 consoles/ })
    expect(line).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(line)
    expect(line).toHaveAttribute('aria-expanded', 'true')
    const list = screen.getByRole('list', { name: 'On default' })
    expect(within(list).getByText('Silos writer')).toBeInTheDocument()
    expect(within(list).getByText('6 consoles')).toBeInTheDocument()
    expect(within(list).getByText('claude-mem plugin')).toBeInTheDocument()
    fireEvent.click(within(list).getByRole('button', { name: 'Builder' }))
    expect(useStore.getState().page).toEqual({ kind: 'agent', id: 'builder' })
  })

  it('a failed poll drops the count instead of keeping a stale one', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      mockedApi.accountLoad.mockResolvedValue(load(OWNERS_MACHINE))
      render(<HomePage />)
      expect(await screen.findByTestId('account-load')).toBeInTheDocument()
      mockedApi.accountLoad.mockRejectedValue(new Error('HTTP 500'))
      await vi.advanceTimersByTimeAsync(15_000)
      await waitFor(() => expect(screen.queryByTestId('account-load')).not.toBeInTheDocument())
    } finally {
      vi.useRealTimers()
    }
  })

  it('nothing running → no line', async () => {
    mockedApi.accountLoad.mockResolvedValue(load())
    render(<HomePage />)
    await screen.findByTestId('pulse')
    await Promise.resolve()
    expect(screen.queryByTestId('account-load')).not.toBeInTheDocument()
  })

  it('a project Home never asks and never shows it (the account is global)', async () => {
    mockedApi.accountLoad.mockResolvedValue(load(OWNERS_MACHINE))
    render(<HomePage scope={{ folder: '/proj' }} />)
    await screen.findByTestId('pulse')
    await Promise.resolve()
    expect(screen.queryByTestId('account-load')).not.toBeInTheDocument()
    expect(mockedApi.accountLoad).not.toHaveBeenCalled()
  })
})
