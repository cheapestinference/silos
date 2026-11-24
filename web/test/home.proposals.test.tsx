// An agent's proposals in Needs you: Accept
// sends the hash of what the row painted and an automation lands on its
// page; Dismiss leaves; a mission and a command are «Review ›» only — the
// mission's opens its editor preloaded and the save carries the proposal; a
// command's opens the automation editor on the proposal. A failure comes
// back inline and the row returns. Past the budget an agent's proposals fold.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { HomePage } from '../src/components/home/HomePage'
import { useStore } from '../src/store'
import { api } from '../src/lib/api'
import { headline, scopeInbox } from '../src/lib/home'
import type { AgentView, Automation, InboxRow, ProposalView } from '../src/lib/types'
import { proposalRow } from './inbox-rows'
import { openNeedsYou } from './home-tiles'

vi.mock('../src/lib/api')
const mockedApi = vi.mocked(api, { deep: true })
const NOW = Date.parse('2026-11-01T12:00:00.000Z')
const PID = '11111111-1111-1111-1111-111111111111'

function agent(o: Partial<AgentView>): AgentView {
  return { id: 'builder', name: 'Builder', emoji: '🛠', folder: '/proj', skills: [], sessions: [], liveCount: 0, sessionCount: 0, ...o }
}
const board = (inbox: InboxRow[]) => ({ cards: [], needsYou: [], inbox })
const view = (o: Partial<ProposalView> = {}): ProposalView => ({
  id: PID,
  by: 'builder',
  at: new Date(NOW).toISOString(),
  kind: 'automation',
  reason: 'the readings must stay fresh',
  input: {},
  state: 'pending',
  expiresAt: '',
  inputHash: 'h'.repeat(64),
  agentName: 'Builder',
  review: false,
  words: { title: 'Console readings' },
  automation: { name: 'Console readings', when: 'every 2h', maxRunsPerDay: 24, prompt: 'Read the console and write it down.' },
  ...o,
})

beforeEach(() => {
  vi.clearAllMocks()
  mockedApi.tasks.mockResolvedValue({ sessions: [] })
  mockedApi.automations.list.mockResolvedValue([])
  mockedApi.automations.pending.mockResolvedValue([])
  mockedApi.proposals.list.mockResolvedValue([view()])
  useStore.setState({ agents: [agent({}), agent({ id: 'ops', name: 'Ops', emoji: '💶' })], automations: [], automationsPending: [], nowTick: NOW, page: null })
})

describe('the words', () => {
  it('the pulse sentence names the agent and what it suggests', () => {
    expect(headline({ inbox: [proposalRow()], working: [], agentName: (id) => (id === 'builder' ? 'Builder' : id), now: NOW, ago: () => '' })).toBe(
      'Builder suggests: Console readings.',
    )
  })

  it("scopeInbox keeps it for the agent's folder, drops it elsewhere", () => {
    const row = proposalRow()
    expect(scopeInbox([row], '/proj', new Set(['builder']), 'master')).toEqual([row])
    expect(scopeInbox([row], '/other', new Set(['writer']), 'master')).toEqual([])
  })
})

describe('HomePage — the proposal row', () => {
  it('paints the whole automation under the row before the touch', async () => {
    mockedApi.board.mockResolvedValue(board([proposalRow()]))
    render(<HomePage />)
    const inbox = await openNeedsYou()
    expect(await within(inbox).findByTestId(`proposal-detail-${PID}`)).toBeInTheDocument()
    expect(within(inbox).getByTestId('proposal-prompt')).toHaveTextContent('Read the console and write it down.')
  })

  it('Accept sends the hash the row painted and lands on the new automation', async () => {
    mockedApi.board.mockResolvedValue(board([proposalRow()]))
    mockedApi.proposals.accept.mockResolvedValue({ automation: { id: 'new-auto' } as Automation })
    render(<HomePage />)
    const inbox = await openNeedsYou()
    fireEvent.click(await within(inbox).findByRole('button', { name: 'Accept' }))
    expect(mockedApi.proposals.accept).toHaveBeenCalledWith(PID, 'h'.repeat(64))
    await waitFor(() => expect(useStore.getState().page).toEqual({ kind: 'automation', id: 'new-auto' }))
  })

  it('Dismiss dismisses it and the row leaves', async () => {
    mockedApi.board.mockResolvedValue(board([proposalRow()]))
    mockedApi.proposals.dismiss.mockResolvedValue(undefined)
    render(<HomePage />)
    const inbox = await openNeedsYou()
    fireEvent.click(await within(inbox).findByRole('button', { name: 'Dismiss' }))
    expect(mockedApi.proposals.dismiss).toHaveBeenCalledWith(PID)
    await waitFor(() => expect(within(inbox).queryByText('Console readings')).toBeNull())
  })

  it('a refusal comes back inline and the row returns', async () => {
    mockedApi.board.mockResolvedValue(board([proposalRow()]))
    mockedApi.proposals.accept.mockRejectedValue(new Error('it changed since it was proposed — review it again'))
    render(<HomePage />)
    const inbox = await openNeedsYou()
    fireEvent.click(await within(inbox).findByRole('button', { name: 'Accept' }))
    expect(await screen.findByText('it changed since it was proposed — review it again')).toBeInTheDocument()
    expect(within(inbox).getAllByText('Console readings').length).toBeGreaterThan(0)
    expect(useStore.getState().page).toBeNull()
  })

  it('a command offers only Review ›, which opens the automation editor on the proposal', async () => {
    mockedApi.board.mockResolvedValue(board([proposalRow({ review: true })]))
    render(<HomePage />)
    const inbox = await openNeedsYou()
    expect(within(inbox).queryByRole('button', { name: 'Accept' })).toBeNull()
    fireEvent.click(await within(inbox).findByRole('button', { name: 'Review ›' }))
    expect(mockedApi.proposals.accept).not.toHaveBeenCalled()
    expect(useStore.getState().page).toEqual({ kind: 'automation', id: 'new', proposal: PID, agent: 'builder' })
  })

  it("a mission's Review opens the agent's mission editor with the proposal parked", async () => {
    mockedApi.proposals.list.mockResolvedValue([
      view({
        kind: 'mission',
        review: true,
        words: { title: 'a new mission' },
        automation: undefined,
        mission: { before: null, after: { text: 'Keep the books.', never: [] } },
      }),
    ])
    mockedApi.board.mockResolvedValue(board([proposalRow({ proposalKind: 'mission', review: true, title: 'a new mission', brake: undefined })]))
    render(<HomePage />)
    const inbox = await openNeedsYou()
    await within(inbox).findByTestId(`proposal-detail-${PID}`)
    fireEvent.click(within(inbox).getByRole('button', { name: 'Review ›' }))
    await waitFor(() => expect(useStore.getState().page).toEqual({ kind: 'agent', id: 'builder' }))
    const { useMissionReview } = await import('../src/lib/mission-review')
    const { renderHook } = await import('@testing-library/react')
    expect(renderHook(() => useMissionReview('builder')).result.current).toMatchObject({ proposalId: PID, after: { text: 'Keep the books.' } })
  })

  it("past the budget an agent's proposals fold into one line that opens each with its own buttons", async () => {
    const ids = ['a', 'b', 'c', 'd'].map((x) => `${x.repeat(8)}-1111-1111-1111-111111111111`)
    mockedApi.proposals.list.mockResolvedValue(ids.map((id, i) => view({ id, words: { title: `Thing ${i}` } })))
    mockedApi.board.mockResolvedValue(
      board([
        {
          kind: 'proposalSummary',
          key: 'proposal-summary:builder',
          urgency: 'due',
          at: NOW,
          voice: '',
          clears: '',
          agentId: 'builder',
          count: 4,
          proposalIds: ids,
        },
      ]),
    )
    render(<HomePage />)
    const inbox = await openNeedsYou()
    fireEvent.click(await within(inbox).findByText(/suggests 4 things/))
    await within(inbox).findByTestId(`proposal-unfolded-${ids[0]}`)
    expect(within(inbox).getAllByRole('button', { name: 'Accept' })).toHaveLength(4)
  })
})
