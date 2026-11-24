// inbox-destination.test.tsx — a Needs you row about automations never lands
// on a blank page (the heartbeat LEFT the
// Automations lists; its home is «In charge of» on the agent page). One test
// per row kind, then the filtered Automations page's own empty state.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { HomePage } from '../src/components/home/HomePage'
import { AutomationsListPage } from '../src/components/AutomationsListPage'
import { useStore } from '../src/store'
import { api } from '../src/lib/api'
import { inboxDestination } from '../src/lib/inbox-destination'
import type { AgentView, Automation, InboxRow } from '../src/lib/types'
import { openNeedsYou } from './home-tiles'
import { accountLimitRow, agentSummaryRow, escalatedRow, failedRunRow, missedRetryRow, territoryOffRow, unreadMessagesRow } from './inbox-rows'

vi.mock('../src/lib/api')
const mockedApi = vi.mocked(api, { deep: true })
const NOW = Date.parse('2026-10-19T12:00:00.000Z')

function makeAgent(o: Partial<AgentView> = {}): AgentView {
  return { id: 'builder', name: 'Builder', emoji: '🛠', folder: '/proj', skills: [], sessions: [], liveCount: 0, sessionCount: 0, ...o }
}
function makeAutomation(o: Partial<Automation> = {}): Automation {
  return {
    id: 'a',
    name: 'Automation',
    agentId: 'builder',
    prompt: 'Does a thing.',
    trigger: { kind: 'cron', expr: '30 6 * * *' },
    thread: { mode: 'new' },
    approval: false,
    keepAlive: false,
    paused: false,
    createdAt: '2026-08-01T00:00:00.000Z',
    ...o,
  }
}
const BEAT = { id: 'heartbeat-finance', name: 'Responsibility — Finance', agentId: 'finance' }
const board = (inbox: InboxRow[]) => ({ cards: [], needsYou: [], inbox })

beforeEach(() => {
  vi.clearAllMocks()
  mockedApi.tasks.mockResolvedValue({ sessions: [] })
  mockedApi.automations.list.mockResolvedValue([])
  mockedApi.automations.pending.mockResolvedValue([])
  useStore.setState({
    agents: [makeAgent(), makeAgent({ id: 'finance', name: 'Finance', emoji: '💶' })],
    automations: [],
    automationsPending: [],
    nowTick: NOW,
    page: null,
  })
})

describe('inboxDestination — every row kind', () => {
  it('failed run / missed retry: the automation is the subject — its page, a beat included', () => {
    expect(inboxDestination(failedRunRow())).toEqual({ kind: 'page', page: { kind: 'automation', id: 'sweep' } })
    expect(inboxDestination(failedRunRow({ agentId: 'finance', automationId: 'heartbeat-finance' }))).toEqual({
      kind: 'page',
      page: { kind: 'automation', id: 'heartbeat-finance' },
    })
    expect(inboxDestination(missedRetryRow({ dueAt: '2026-10-19T10:00:00.000Z' }))).toEqual({ kind: 'page', page: { kind: 'automation', id: 'sweep' } })
  })

  it("usage limit that stopped only a heartbeat: the heartbeat's own page", () => {
    expect(inboxDestination(accountLimitRow({ automations: [BEAT] }))).toEqual({ kind: 'page', page: { kind: 'automation', id: 'heartbeat-finance' } })
  })

  it("usage limit over one agent's automations (a beat among them or not): that agent's list, which names its beat", () => {
    const own = { id: 'fiscal', name: 'Tax watch', agentId: 'finance' }
    expect(inboxDestination(accountLimitRow({ automations: [own] }))).toEqual({ kind: 'page', page: { kind: 'automations', agent: 'finance' } })
    expect(inboxDestination(accountLimitRow({ automations: [own, BEAT] }))).toEqual({ kind: 'page', page: { kind: 'automations', agent: 'finance' } })
  })

  it('usage limit over several agents: the whole list', () => {
    expect(inboxDestination(accountLimitRow())).toEqual({ kind: 'page', page: { kind: 'automations' } })
  })

  it("«N automations failing»: that agent's list; «N things need you»: the agent", () => {
    expect(inboxDestination(agentSummaryRow('finance', 4))).toEqual({ kind: 'page', page: { kind: 'automations', agent: 'finance' } })
    expect(inboxDestination(agentSummaryRow('finance', 4, false))).toEqual({ kind: 'page', page: { kind: 'agent', id: 'finance' } })
  })

  it("territory off: the agent's page (its control); escalation: the heartbeat's own page", () => {
    expect(inboxDestination(territoryOffRow('finance'))).toEqual({ kind: 'page', page: { kind: 'agent', id: 'finance' } })
    expect(inboxDestination(escalatedRow('finance', '2026-10-19T10:00:00.000Z'))).toEqual({
      kind: 'page',
      page: { kind: 'automation', id: 'heartbeat-finance' },
    })
  })

  // the mission says nothing about the heartbeat — no row about
  // the heartbeat may land on the agent page's mission
  it('no heartbeat row ever lands on the mission (or on the agent page)', () => {
    for (const row of [escalatedRow('finance', '2026-10-19T10:00:00.000Z'), accountLimitRow({ automations: [BEAT] })]) {
      const dest = inboxDestination(row)!
      expect(dest.kind).toBe('page')
      expect(dest.kind === 'page' && dest.page?.kind).toBe('automation')
    }
  })

  it('rows about messages are not about automations (their own doors)', () => {
    expect(inboxDestination(unreadMessagesRow())).toBeNull()
  })
})

describe("HomePage — the heartbeat's rows open its own page", () => {
  it("a usage limit that stopped only Finance's heartbeat opens /automation/heartbeat-finance", async () => {
    mockedApi.board.mockResolvedValue(board([accountLimitRow({ automations: [BEAT] })]))
    render(<HomePage />)
    const inbox = await openNeedsYou()
    fireEvent.click(await within(inbox).findByText(/^Your Claude account/))
    expect(useStore.getState().page).toEqual({ kind: 'automation', id: 'heartbeat-finance' })
    expect(useStore.getState().tab).not.toBe('mission')
  })

  it("a territory turned off opens the agent's Runs on (its door)", async () => {
    mockedApi.board.mockResolvedValue(board([territoryOffRow('builder')]))
    render(<HomePage />)
    const inbox = await openNeedsYou()
    fireEvent.click(await within(inbox).findByText(/territory turned off/))
    expect(useStore.getState().page).toEqual({ kind: 'agent', id: 'builder' })
  })

  it("«N automations failing» opens that agent's list", async () => {
    mockedApi.board.mockResolvedValue(board([agentSummaryRow('finance', 4)]))
    render(<HomePage />)
    const inbox = await openNeedsYou()
    fireEvent.click(await within(inbox).findByText(/automations failing/))
    expect(useStore.getState().page).toEqual({ kind: 'automations', agent: 'finance' })
  })
})

describe('the filtered Automations page — per agent, and its beat named', () => {
  it('an agent whose only automation is its heartbeat: says so, with a door to it', () => {
    useStore.setState({
      page: { kind: 'automations', agent: 'finance' },
      automations: [makeAutomation({ id: 'heartbeat-finance', agentId: 'finance' }), makeAutomation({ id: 'sweep', agentId: 'builder' })],
    })
    render(<AutomationsListPage />)
    expect(screen.queryByTestId('automations-list')).toBeNull()
    const empty = screen.getByTestId('automations-empty')
    expect(empty.textContent).toMatch(/Finance’s only automation is its heartbeat/)
    fireEvent.click(within(empty).getByRole('button', { name: 'Runs ›' }))
    expect(useStore.getState().page).toEqual({ kind: 'automation', id: 'heartbeat-finance' })
  })

  it('an agent with no automation at all (others have some): its own empty state, never a blank list', () => {
    useStore.setState({ page: { kind: 'automations', agent: 'finance' }, automations: [makeAutomation({ id: 'sweep', agentId: 'builder' })] })
    render(<AutomationsListPage />)
    expect(screen.queryByTestId('automations-list')).toBeNull()
    expect(screen.getByTestId('automations-empty').textContent).toMatch(/No automations for Finance yet/)
  })

  it('an agent with automations and a beat: the list, and one line naming the beat with its door', () => {
    useStore.setState({
      page: { kind: 'automations', agent: 'finance' },
      automations: [makeAutomation({ id: 'heartbeat-finance', agentId: 'finance' }), makeAutomation({ id: 'fiscal', name: 'Tax watch', agentId: 'finance' })],
    })
    render(<AutomationsListPage />)
    expect(screen.getByTestId('automation-row-fiscal')).toBeInTheDocument()
    expect(screen.queryByTestId('automation-row-heartbeat-finance')).toBeNull()
    fireEvent.click(within(screen.getByTestId('automations-beat-door')).getByRole('button', { name: 'Runs ›' }))
    expect(useStore.getState().page).toEqual({ kind: 'automation', id: 'heartbeat-finance' })
  })
})

// third review round, defect 3: an ARCHIVED agent's beat is kept paused by
// design and the web doesn't list the agent — its beat is never a door to
// «In charge of» (that door once selected an agent nobody has, and the
// agent page fell back to a chat that started a real console for it)
describe("an archived (or unknown) agent's beat is named, never a door", () => {
  const OLD = { id: 'heartbeat-old', name: 'Responsibility — Old', agentId: 'old' }
  const inPlay = (id: string) => id === 'builder' || id === 'finance'

  it('inboxDestination: no «In charge of» for an agent out of play', () => {
    expect(inboxDestination(escalatedRow('old', '2026-10-19T10:00:00.000Z'), inPlay)).toBeNull()
    expect(inboxDestination(territoryOffRow('old'), inPlay)).toBeNull()
    // a limit that stopped only its paused beat: the whole list, which names it
    expect(inboxDestination(accountLimitRow({ automations: [OLD] }), inPlay)).toEqual({ kind: 'page', page: { kind: 'automations' } })
    // beside an in-play beat, the in-play one decides
    expect(inboxDestination(accountLimitRow({ automations: [OLD, BEAT] }), inPlay)).toEqual({
      kind: 'page',
      page: { kind: 'automation', id: 'heartbeat-finance' },
    })
    expect(inboxDestination(agentSummaryRow('old', 3, false), inPlay)).toEqual({ kind: 'page', page: { kind: 'automations', agent: 'old' } })
  })

  it("the whole Automations list: the archived agent's beat is said paused, with no In charge of door", () => {
    useStore.setState({
      page: { kind: 'automations' },
      automations: [
        makeAutomation({ id: 'heartbeat-old', agentId: 'old' }),
        makeAutomation({ id: 'heartbeat-finance', agentId: 'finance' }),
        makeAutomation({ id: 'sweep', agentId: 'builder' }),
      ],
    })
    render(<AutomationsListPage />)
    const door = screen.getByTestId('automations-beat-door')
    expect(door.textContent).toMatch(/Finance’s heartbeat/)
    expect(door.textContent).not.toMatch(/old/)
    const paused = screen.getByTestId('automations-beat-paused')
    expect(paused.textContent).toMatch(/«old» — archived — its heartbeat stopped/)
    expect(within(paused).queryByRole('button', { name: /In charge of/ })).toBeNull()
    // its one door: restoring the agent
    fireEvent.click(within(paused).getByRole('button', { name: /Restore in Settings › Archived agents/ }))
    expect(useStore.getState().page).toEqual({ kind: 'settings', tab: 'archived' })
  })

  it('filtered to the archived agent: its paused beat is all there is — said so, never «No automations» and never a door to In charge of', () => {
    useStore.setState({ page: { kind: 'automations', agent: 'old' }, automations: [makeAutomation({ id: 'heartbeat-old', agentId: 'old' })] })
    render(<AutomationsListPage />)
    const empty = screen.getByTestId('automations-empty')
    expect(empty.textContent).toMatch(/The only automation here is «old»’s heartbeat/)
    expect(within(empty).queryByRole('button', { name: /In charge of/ })).toBeNull()
    expect(useStore.getState().page).toEqual({ kind: 'automations', agent: 'old' })
  })

  it("a stale call to openCheckIn for an agent the web doesn't list opens nothing", async () => {
    const { openCheckIn } = await import('../src/lib/beat-home')
    useStore.setState({ page: { kind: 'automations' } })
    openCheckIn('old')
    expect(useStore.getState().page).toEqual({ kind: 'automations' })
  })
})
