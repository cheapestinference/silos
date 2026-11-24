// Home's «Since …» band: after a day away or
// whenever something was decided; the decided clause names one agent or
// counts several, and opens the sheet where each decision has its Undo.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { HomePage } from '../src/components/home/HomePage'
import { useStore } from '../src/store'
import { api } from '../src/lib/api'
import { decidedWords, sinceShows, sinceWords, type HomeSince } from '../src/lib/since'
import type { AgentView, Creation } from '../src/lib/types'

vi.mock('../src/lib/api')
const mockedApi = vi.mocked(api, { deep: true })

const NOW = Date.parse('2026-11-12T09:00:00')
const c = (by: string, id: string, title = id): Creation => ({
  id,
  kind: 'task',
  ref: `p/tasks/tasks/${id}`,
  title,
  createdAt: new Date(NOW - 3600_000).toISOString(),
  by,
  signal: 'mission',
})
const since = (over: Partial<HomeSince> = {}): HomeSince => ({
  from: new Date(NOW - 2 * 86_400_000).toISOString(),
  done: 0,
  automations: { ran: 0, of: 0 },
  stuck: 0,
  decided: [],
  needsYou: 0,
  usage: null,
  cost: null,
  ...over,
})
const name = (id: string): string => id.toUpperCase()

describe("the band's rule and words", () => {
  it('shows after a day away, or with something decided even the same morning', () => {
    expect(sinceShows(since(), NOW)).toBe(true)
    expect(sinceShows(since({ from: new Date(NOW - 3600_000).toISOString() }), NOW)).toBe(false)
    expect(sinceShows(since({ from: new Date(NOW - 3600_000).toISOString(), decided: [c('x', 'a')] }), NOW)).toBe(true)
  })
  it('one decider is named; several are counted — the fixed words', () => {
    expect(decidedWords([c('x', 'a'), c('x', 'b')], name)).toBe('X decided 2 things')
    expect(decidedWords([c('x', 'a'), c('y', 'b'), c('y', 'c')], name)).toBe('2 agents decided 3 things')
    expect(decidedWords([], name)).toBeNull()
  })
  it('only the clauses that have something', () => {
    const w = sinceWords(since({ done: 9, automations: { ran: 7, of: 1 }, stuck: 1, decided: [c('x', 'a')] }), NOW, name)
    expect(w.head).toMatch(/^Since \w+: 9 done, 1 automation ran 7 times, 1 stuck, $/)
    expect(w.decided).toBe('X decided 1 thing')
  })
})

describe('HomePage — the band and its sheet', () => {
  const agent = (id: string, nameS: string): AgentView => ({
    id,
    name: nameS,
    emoji: '•',
    folder: `/${id}`,
    skills: [],
    sessions: [],
    liveCount: 0,
    sessionCount: 0,
  })
  beforeEach(() => {
    vi.clearAllMocks()
    mockedApi.tasks.mockResolvedValue({ sessions: [] })
    mockedApi.board.mockResolvedValue({ cards: [], needsYou: [], inbox: [] })
    useStore.setState({ agents: [agent('finance', 'Finance')], automations: [], automationsPending: [], nowTick: NOW, page: null, homeSheet: null })
  })

  it('the pulse says what was decided, the band opens the sheet with Undo per row', async () => {
    mockedApi.home.since.mockResolvedValue(
      since({ done: 3, decided: [c('finance', 'a', 'every Monday, read new tax law')], usage: { percent: 34, account: 'your Claude account', agents: 2 } }),
    )
    render(<HomePage />)
    expect(await screen.findByTestId('pulse-decided')).toHaveTextContent('Finance decided something ›')
    expect(screen.getByTestId('home-since')).toHaveTextContent(/: 3 done, Finance decided 1 thing ›$/)
    fireEvent.click(screen.getByTestId('home-since-decided'))
    const sheet = await screen.findByTestId('sheet-since')
    expect(within(sheet).getByText('Finance decided: every Monday, read new tax law')).toBeInTheDocument()
    expect(within(sheet).getByRole('button', { name: 'Undo' })).toBeInTheDocument()
  })

  it('a first look (nothing before, nothing decided) has no band; quiet says «All quiet.» alone; Needs you says «Nothing needs you.»', async () => {
    mockedApi.home.since.mockResolvedValue(since({ from: new Date(NOW).toISOString() }))
    render(<HomePage />)
    expect(await screen.findByText('All quiet.')).toBeInTheDocument()
    expect(screen.queryByTestId('home-since')).toBeNull()
    expect(screen.queryByTestId('pulse-next')).toBeNull()
    expect(screen.getByText('Nothing needs you.')).toBeInTheDocument()
  })

  it('an install with no agent of its own says the one door', async () => {
    useStore.setState({ agents: [{ ...agent('master', 'Anywhere'), folder: null } as unknown as AgentView] })
    mockedApi.home.since.mockResolvedValue(since())
    render(<HomePage />)
    expect(await screen.findByTestId('pulse-create')).toHaveTextContent('Create your first agent ›')
  })
})
