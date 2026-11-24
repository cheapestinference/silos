// home-page.test.tsx — HomePage's inbox, rendered from the rows the server
// composed (GET /api/board `inbox`, server/src/inbox.ts): Seen on any row that
// carries an ack (persisted server-side, «this version»), the four new rows in
// plain words, the ceiling line, and the page by project — one row per plan.
// Home is a board of tiles: each list is read in the Sheet its tile opens
// (./home-tiles), the tile itself says the sentence and the first lines.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { HomePage } from '../src/components/home/HomePage'
import { useStore } from '../src/store'
import { api } from '../src/lib/api'
import type { AgentView, InboxRow, NeedsYouItem, Run } from '../src/lib/types'
import { agentSummaryRow, approvalRow, escalatedRow, failedRunRow, missedRetryRow, planRow, siloRow, territoryOffRow, unreadMessagesRow } from './inbox-rows'
import { openNeedsYou, openYours } from './home-tiles'
import { HOME_LIST_MAX } from '../src/lib/home'

vi.mock('../src/lib/api')
const mockedApi = vi.mocked(api, { deep: true })

const NOW = Date.parse('2026-10-19T12:00:00.000Z')

function makeAgent(overrides: Partial<AgentView> = {}): AgentView {
  return { id: 'builder', name: 'Builder', emoji: '🛠', folder: '/proj', skills: [], sessions: [], liveCount: 0, sessionCount: 0, ...overrides }
}
const board = (inbox: InboxRow[], extra: Record<string, unknown> = {}) => ({ cards: [], needsYou: [], inbox, ...extra })

beforeEach(() => {
  vi.clearAllMocks()
  mockedApi.tasks.mockResolvedValue({ sessions: [] })
  mockedApi.needsYou.ack.mockResolvedValue(undefined)
  useStore.setState({
    agents: [makeAgent(), makeAgent({ id: 'finance', name: 'Finance', emoji: '💶' })],
    automations: [],
    automationsPending: [],
    nowTick: NOW,
    page: null,
  })
})

describe('HomePage — an escalation can be marked seen', () => {
  const esc = escalatedRow('builder', '2026-10-07T10:00:00.000Z', 'Stripe keys expire Friday')

  it('"Seen" acks THAT version and the row leaves the inbox at once', async () => {
    mockedApi.board.mockResolvedValue(board([esc]))
    render(<HomePage />)
    const inbox = await openNeedsYou()
    expect(await within(inbox).findByText('Stripe keys expire Friday')).toBeInTheDocument()
    mockedApi.board.mockResolvedValue(board([]))
    fireEvent.click(within(inbox).getByRole('button', { name: 'Seen' }))
    expect(within(inbox).queryByText('Stripe keys expire Friday')).not.toBeInTheDocument()
    expect(mockedApi.needsYou.ack).toHaveBeenCalledWith({ kind: 'escalated', key: 'builder', version: '2026-10-07T10:00:00.000Z' })
    await waitFor(() => expect(mockedApi.board.mock.calls.length).toBeGreaterThanOrEqual(2))
  })

  it("the escalation itself opens the check-in that escalated — never the agent's mission", async () => {
    mockedApi.board.mockResolvedValue(board([esc]))
    render(<HomePage />)
    fireEvent.click(within(await openNeedsYou()).getByText('Stripe keys expire Friday'))
    expect(useStore.getState().page).toEqual({ kind: 'automation', id: 'heartbeat-builder' })
    expect(useStore.getState().tab).not.toBe('mission')
  })

  it('a failed ack brings the row back and says so', async () => {
    mockedApi.board.mockResolvedValue(board([esc]))
    mockedApi.needsYou.ack.mockRejectedValue(new Error('HTTP 500'))
    render(<HomePage />)
    const inbox = await openNeedsYou()
    fireEvent.click(within(inbox).getByRole('button', { name: 'Seen' }))
    expect(await screen.findByText('HTTP 500')).toBeInTheDocument()
    expect(within(inbox).getByText('Stripe keys expire Friday')).toBeInTheDocument()
  })
})

describe('HomePage — the four provable rows', () => {
  it('a failed run says the automation, how often and why; it opens the automation; Seen acks that run', async () => {
    mockedApi.board.mockResolvedValue(board([failedRunRow({ agentId: 'builder', streak: 2, runId: 'r7', at: NOW - 60_000 })]))
    render(<HomePage />)
    const inbox = await openNeedsYou()
    expect(await within(inbox).findByText(/^Builder · failed twice/)).toBeInTheDocument()
    expect(within(inbox).getByText('Nightly sweep').textContent).toBe('Nightly sweep — the API rejected the request (400)')
    fireEvent.click(within(inbox).getByRole('button', { name: 'Seen' }))
    expect(mockedApi.needsYou.ack).toHaveBeenCalledWith({ kind: 'run', key: 'sweep', version: 'r7' })
  })

  it("the failed run row opens the automation's one home", async () => {
    mockedApi.board.mockResolvedValue(board([failedRunRow()]))
    render(<HomePage />)
    fireEvent.click(within(await openNeedsYou()).getByText('Nightly sweep'))
    expect(useStore.getState().page).toEqual({ kind: 'automation', id: 'sweep' })
  })

  it('a missed retry and a territory turned off, each in plain words', async () => {
    const due = new Date(2026, 9, 19, 14, 5).toISOString()
    mockedApi.board.mockResolvedValue(board([missedRetryRow({ dueAt: due }), territoryOffRow('builder')]))
    render(<HomePage />)
    const inbox = await openNeedsYou()
    expect(await within(inbox).findByText(/was due to retry at 14:05 and didn't/)).toBeInTheDocument()
    expect(within(inbox).getByText(/territory turned off/).textContent).toBe("BUILDER's territory turned off — it is Only when told until it is on again")
    expect(within(inbox).getByRole('button', { name: 'Turn it on ›' })).toBeInTheDocument()
    expect(within(inbox).getAllByRole('button', { name: 'Seen' })).toHaveLength(1)
  })

  // no message wakes anyone — unread messages past
  // their recipient's next chance are ONE row per recipient·sender, in the
  // server's voice; the door opens a new conversation of the recipient
  it("unread messages: the server's voice, Seen acks up to the newest, the door opens a new conversation of the recipient", async () => {
    const voice = "Builder hasn't read 2 messages from Finance · 1 d — it hasn't looked yet: it was sleeping"
    mockedApi.board.mockResolvedValue(
      board([unreadMessagesRow({ agentId: 'builder', from: 'finance', messageIds: ['m1', 'm9'], why: 'sleeping', at: NOW - 86_400_000, voice })]),
    )
    useStore.setState({ chatMode: 'chat' })
    render(<HomePage />)
    const inbox = await openNeedsYou()
    expect((await within(inbox).findByText(/hasn't read 2 messages/)).textContent).toBe(voice)
    fireEvent.click(within(inbox).getByRole('button', { name: 'Open chat ›' }))
    expect(useStore.getState().selectedAgentId).toBe('builder')
    expect(useStore.getState().newChatOpen).toBe(true)
    fireEvent.click(within(inbox).getByRole('button', { name: 'Seen' }))
    expect(mockedApi.needsYou.ack).toHaveBeenCalledWith({ kind: 'message', key: 'builder/finance', version: 'm9' })
  })

  // «Open» goes to a console only when the agent has one in the index
  // (server open-surface.ts) — never the owner's last surface
  it('unread messages: an agent with a console in the index — the door says «Open console ›» and opens one', async () => {
    mockedApi.board.mockResolvedValue(board([unreadMessagesRow({ agentId: 'finance', from: 'owner', at: NOW - 86_400_000 })]))
    useStore.setState({
      chatMode: 'chat',
      agents: [makeAgent(), makeAgent({ id: 'finance', name: 'Finance', emoji: '💶', open: { hasConsole: true, consoleBriefs: true } })],
    })
    render(<HomePage />)
    const inbox = await openNeedsYou()
    fireEvent.click(await within(inbox).findByRole('button', { name: 'Open console ›' }))
    expect(useStore.getState().selectedAgentId).toBe('finance')
    expect(useStore.getState().chatMode).toBe('console')
    expect(useStore.getState().newChatOpen).toBe(true)
  })

  it('an agent past its budget is one line that points to its automations', async () => {
    mockedApi.board.mockResolvedValue(board([agentSummaryRow('builder', 5)]))
    render(<HomePage />)
    const line = within(await openNeedsYou()).getByText(/5 automations failing/)
    expect(line.textContent).toBe('5 automations failing — newest: Auto 1 (the API rejected the request (400))')
    fireEvent.click(line)
    expect(useStore.getState().page).toEqual({ kind: 'automations', agent: 'builder' })
  })

  it('Approve leaves at once (the store decides the run)', async () => {
    const approveRun = vi.fn(async () => {})
    useStore.setState({ approveRun } as never)
    const run = { id: 'r1', automationId: 'au1', at: new Date(NOW - 5000).toISOString(), status: 'waiting_approval' } as Run
    mockedApi.board.mockResolvedValue(board([approvalRow(run, { id: 'au1', name: 'Morning standup', agentId: 'builder' })]))
    render(<HomePage />)
    const inbox = await openNeedsYou()
    expect(within(inbox).getByText('Morning standup')).toBeInTheDocument()
    fireEvent.click(within(inbox).getByRole('button', { name: 'Approve' }))
    expect(approveRun).toHaveBeenCalledWith('r1')
    expect(screen.queryByText('Morning standup')).not.toBeInTheDocument()
  })
})

describe('HomePage — the inbox ceiling and an older server', () => {
  it('past 12 loud rows the inbox says so once', async () => {
    mockedApi.board.mockResolvedValue(
      board(Array.from({ length: 13 }, (_, i) => failedRunRow({ automationId: `a${i}`, agentId: `ag${i}`, at: NOW - 2 * 86_400_000 }))),
    )
    render(<HomePage />)
    // Home's list shows its bound and counts the rest for its door; the ceiling is said once, in the list
    await waitFor(() => expect(screen.getByTestId('needs-you-more')).toHaveTextContent(`${13 - HOME_LIST_MAX} more`))
    expect(screen.getAllByTestId('needs-you-row')).toHaveLength(HOME_LIST_MAX)
    await openNeedsYou()
    expect(screen.getAllByTestId('inbox-ceiling')).toHaveLength(1)
    expect(screen.getByTestId('inbox-ceiling').textContent).toBe('13 rows — more than anyone reads; the oldest have waited 2 days')
  })
})

// Home's one list: your own tasks follow what holds
// someone up, a row each with Done, in their projects' order (idle plans
// last); the list of your own («N are your own») holds every plan, project
// by project, a row per plan.
describe('HomePage — by project, one row per plan', () => {
  // a task of the plans silo (planRow builds the silo row the server sends)
  const planTask = (file: string, taskId: string, planUpdatedAt: string, folder = '/proj') => ({
    folder,
    file: `${file}.plan.json`,
    taskId,
    title: `Task ${file}:${taskId}`,
    planTitle: `Plan ${file}`,
    planUpdatedAt,
  })

  it('three tasks of yours are three rows with Done on Home, and ONE plan row in your list; a click unfolds the tasks', async () => {
    mockedApi.board.mockResolvedValue(
      board([planTask('a', 't1', '2026-10-18'), planTask('a', 't2', '2026-10-18'), planTask('a', 't3', '2026-10-18')].map(planRow)),
    )
    render(<HomePage />)
    await waitFor(() => expect(screen.getAllByTestId('needs-you-row')).toHaveLength(3))
    for (const row of screen.getAllByTestId('needs-you-row')) {
      expect(row).toHaveAttribute('data-holds', 'false')
      expect(within(row).getByRole('button', { name: 'Done' })).toBeInTheDocument()
    }
    const proj = within(await openYours()).getByRole('region', { name: 'proj' })
    expect(within(proj).getAllByTestId('plan-group')).toHaveLength(1)
    expect(within(proj).getByText('Plan a')).toBeInTheDocument()
    expect(within(proj).getByText('next: Task a:t1')).toBeInTheDocument()
    expect(within(proj).queryByRole('button', { name: 'Done' })).not.toBeInTheDocument()
    fireEvent.click(within(proj).getByRole('button', { name: /Plan a/ }))
    expect(within(proj).getAllByRole('button', { name: 'Done' })).toHaveLength(3)
    expect(within(proj).getByText('Task a:t3')).toBeInTheDocument()
  })

  it("your tasks keep their plans' order on Home — the idle plan last; your list holds them all", async () => {
    mockedApi.board.mockResolvedValue(
      board(
        [
          planTask('a', 't1', '2026-10-18'),
          planTask('old', 't1', '2026-09-20'),
          planTask('b', 't1', '2026-10-17'),
          planTask('c', 't1', '2026-10-16'),
          planTask('d', 't1', '2026-10-15'),
        ].map(planRow),
      ),
    )
    render(<HomePage />)
    await waitFor(() => expect(screen.getAllByTestId('needs-you-row')).toHaveLength(5))
    expect(screen.getAllByTestId('needs-you-row').at(-1)).toHaveTextContent('Task old:t1')
    const proj = within(await openYours()).getByRole('region', { name: 'proj' })
    const groups = within(proj).getAllByTestId('plan-group')
    expect(groups).toHaveLength(5)
    expect(groups.at(-1)).toHaveTextContent('Plan old')
  })
})

describe('HomePage — silos waiting on the owner, and files nobody sees', () => {
  const sub: Extract<NeedsYouItem, { kind: 'silo' }> = {
    kind: 'silo',
    reason: 'submission',
    silo: 'support',
    siloName: 'Support',
    key: 'submission',
    recordKind: 'silo',
    urgency: 'due',
    text: '0.1.0 waits for your approval to install — submitted by builder',
    at: '2026-10-19T11:00:00.000Z',
    agentId: 'builder',
    file: null,
    submission: { kind: 'install', from: null, to: '0.1.0', submittedBy: 'builder', source: 'body' },
  }

  it('a pending submission is a Needs you row whose Review opens the install dialog', async () => {
    mockedApi.board.mockResolvedValue(board([siloRow(sub)]))
    render(<HomePage />)
    const inbox = await openNeedsYou()
    expect(await within(inbox).findByText('0.1.0 waits for your approval to install — submitted by builder')).toBeInTheDocument()
    expect(within(inbox).getByText(/^support · install/)).toBeInTheDocument()
    fireEvent.click(within(inbox).getByRole('button', { name: 'Review' }))
    expect(useStore.getState().page).toEqual({ kind: 'silo', id: 'support', review: true })
  })

  it('records an uninstalled silo keeps growing are said beside the pulse, verbatim', async () => {
    const term = "12 records written to Invoices's files since it was uninstalled — no silo shows them"
    mockedApi.board.mockResolvedValue(
      board([], { silos: { pulse: [], done: [], growth: [{ silo: 'invoices', siloName: 'Invoices', records: 12, since: '2026-10-18T00:00:00Z', term }] } }),
    )
    render(<HomePage />)
    expect((await screen.findByTestId('silo-growth')).textContent).toBe(term)
  })

  it('no growth, no line', async () => {
    mockedApi.board.mockResolvedValue(board([]))
    render(<HomePage />)
    await screen.findByTestId('pulse')
    expect(screen.queryByTestId('silo-growth')).not.toBeInTheDocument()
  })
})

// the rail diet: Board and Map left the
// rail, so Home's date line is their door at a desk; on a phone Home is the
// first screen, the lenses hide and the line's ‹ opens the list.
describe('HomePage — the date line: lenses at a desk, the list on a phone', () => {
  it('map opens its page — no board, no graph, no uses of its own; the line hides below md', async () => {
    mockedApi.board.mockResolvedValue({ cards: [], needsYou: [], inbox: [] })
    render(<HomePage />)
    const lenses = await screen.findByTestId('home-lenses')
    expect(lenses).toHaveClass('hidden', 'md:flex')
    fireEvent.click(within(lenses).getByRole('button', { name: 'map' }))
    expect(useStore.getState().page).toEqual({ kind: 'map' })
    expect(within(lenses).queryByRole('button', { name: 'graph' })).toBeNull()
    // Uses IS the Map since the Wiring view retired: one word, not two
    expect(within(lenses).queryByRole('button', { name: 'uses' })).toBeNull()
    // the Board retired into Home: the line is the Map's family
    expect(within(lenses).queryByRole('button', { name: 'board' })).toBeNull()
  })

  it('the phone-only ‹ names what it opens and goes to the list', async () => {
    mockedApi.board.mockResolvedValue({ cards: [], needsYou: [], inbox: [] })
    useStore.setState({ mobileView: 'chat' })
    render(<HomePage />)
    const list = await screen.findByRole('button', { name: 'agents and conversations' })
    expect(list).toHaveClass('md:hidden')
    expect(screen.queryByRole('button', { name: 'back' })).not.toBeInTheDocument()
    fireEvent.click(list)
    expect(useStore.getState().mobileView).toBe('list')
  })

  it('scoped (the project page) carries no lens line — its machinery line unfolds the Map', async () => {
    mockedApi.board.mockResolvedValue({ cards: [], needsYou: [], inbox: [] })
    render(<HomePage scope={{ folder: '/proj' }} />)
    await screen.findByTestId('pulse')
    expect(screen.queryByTestId('home-lenses')).not.toBeInTheDocument()
  })
})

describe('HomePage — the inbox moves when the server says so', () => {
  it('an `inbox` WS nudge (inboxTick) re-fetches the board', async () => {
    mockedApi.board.mockResolvedValue(board([]))
    render(<HomePage />)
    await waitFor(() => expect(mockedApi.board).toHaveBeenCalledTimes(1))
    mockedApi.board.mockResolvedValue(board([failedRunRow()]))
    useStore.setState((s) => ({ inboxTick: s.inboxTick + 1 }))
    expect(within(await openNeedsYou()).getByText('Nightly sweep')).toBeInTheDocument()
  })
})
