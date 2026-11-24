// automations-list.test.tsx — the Automations page: which automations
// exist, whose, on what schedule, active or not, what each one did last.
// One list grouped by agent, no Board lens and no facets; a
// "Needs a look" strip only when a run failed or waits for the owner;
// finished one-shots fold under a count with a way to clear them (so dead
// probes don't crowd the list).
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { AutomationsListPage } from '../src/components/AutomationsListPage'
import { useStore } from '../src/store'
import { api } from '../src/lib/api'
import type { AgentView, Automation } from '../src/lib/types'

vi.mock('../src/lib/api')
const mockedApi = vi.mocked(api, { deep: true })

function makeAgent(overrides: Partial<AgentView> = {}): AgentView {
  return { id: 'builder', name: 'Builder', emoji: '🛠', folder: '/tmp/ci', skills: [], sessions: [], liveCount: 0, sessionCount: 0, ...overrides }
}
function makeAutomation(overrides: Partial<Automation> = {}): Automation {
  return {
    id: 'a',
    name: 'Automation',
    agentId: 'builder',
    prompt: 'Does a thing. Then another.',
    trigger: { kind: 'cron', expr: '30 6 * * *' },
    thread: { mode: 'new' },
    approval: false,
    keepAlive: false,
    paused: false,
    createdAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
  }
}

const NOW = Date.parse('2026-10-18T16:00:00.000Z')

// with several agents the page is a board of tiles (never lists
// stacked one under another); an agent's rows live one click away, at
// /automations/<agent> — the path row-level assertions take.
function openAgent(agent: string): void {
  useStore.setState({ page: { kind: 'automations', agent } })
}

const standing = makeAutomation({
  id: 'daily',
  name: 'Daily cost report',
  prompt: 'Run the daily cost report from the cost plan. Steps: many.',
  nextRunAt: '2026-10-19T04:30:00.000Z',
  lastRun: { at: '2026-10-18T04:38:00.000Z', status: 'ok', durationMs: 1000 },
})
const paused = makeAutomation({ id: 'glm', name: 'Retire alias model-a', prompt: 'Reminder about the grace alias.', paused: true })
const asksFirst = makeAutomation({
  id: 'mimo',
  name: 'Retire alias model-b',
  prompt: 'Grace alias for model-b.',
  trigger: { kind: 'once', at: '2026-10-21T07:10:00.000Z' },
  approval: true,
  nextRunAt: '2026-10-21T07:10:00.000Z',
})
const doneA = makeAutomation({
  id: 'probe1',
  name: 'TEST console keepalive (one-shot)',
  prompt: 'End-to-end keepalive test.',
  trigger: { kind: 'once', at: '2026-08-28T21:54:07Z' },
  paused: true,
  lastRun: { at: '2026-08-28T22:00:00.000Z', status: 'ok', durationMs: 1000 },
})
const doneB = makeAutomation({
  id: 'probe2',
  name: 'DIAG variable shape (one-shot)',
  prompt: 'Diagnosis.',
  trigger: { kind: 'once', at: '2026-08-28T22:00:16Z' },
  paused: true,
  lastRun: { at: '2026-08-28T22:01:00.000Z', status: 'ok', durationMs: 1000 },
})
const otherAgent = makeAutomation({
  id: 'fiscal',
  name: 'Tax watch FINANCE (daily)',
  agentId: 'finance',
  prompt: 'Daily tax watch pass.',
  trigger: { kind: 'cron', expr: '45 8 * * *' },
})

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  mockedApi.board.mockResolvedValue({ cards: [], needsYou: [], inbox: [] })
  mockedApi.automations.delete.mockResolvedValue(undefined)
  mockedApi.automations.list.mockResolvedValue([])
  mockedApi.automations.pending.mockResolvedValue([])
  useStore.setState({
    agents: [makeAgent(), makeAgent({ id: 'finance', name: 'Finance', emoji: '🧾' })],
    selected: null,
    page: { kind: 'automations' },
    automations: [standing, paused, asksFirst, doneA, doneB, otherAgent],
    automationsPending: [],
    nowTick: NOW,
  })
})

describe('Automations — the inventory list', () => {
  it('is the page: grouped by agent, with standing, paused and done counts', () => {
    render(<AutomationsListPage />)
    // several agents: one tile each, no rows stacked on the page
    expect(screen.queryByTestId(/^automation-row-/)).toBeNull()
    const list = screen.getByTestId('automations-list')
    const builder = within(list).getByTestId('automations-group-builder')
    expect(within(builder).getByText('Builder')).toBeInTheDocument()
    expect(builder.textContent).toMatch(/3 automations/)
    expect(builder.textContent).toMatch(/1 paused/)
    expect(builder.textContent).toMatch(/2 done/)
    const finance = within(list).getByTestId('automations-group-finance')
    expect(finance.textContent).toMatch(/1 automation(?!s)/)
    expect(finance.textContent).not.toMatch(/done/)
  })

  it('a row says what it does, how often, when next and how the last run went', () => {
    openAgent('builder')
    render(<AutomationsListPage />)
    const row = screen.getByTestId('automation-row-daily')
    expect(within(row).getByText('Daily cost report')).toBeInTheDocument()
    expect(within(row).getByText('Run the daily cost report from the cost plan.')).toBeInTheDocument()
    expect(row.textContent).toMatch(/06:30/)
    // next in the words a person plans with, never a countdown to the minute
    expect(row.textContent).toMatch(/tomorrow \d\d:\d\d/)
    expect(row.textContent).not.toMatch(/12h 30m/)
    expect(row.textContent).toMatch(/11h/)
  })

  it("once it has run, the second line is what its last run did — the prompt's gist only before", () => {
    useStore.setState({
      automations: [
        { ...standing, lastRun: { ...standing.lastRun!, summary: 'regenerated the daily report and flagged 3 sessions.' } },
        makeAutomation({ id: 'fresh', name: 'Stripe sales → Ledgerly', prompt: 'Mechanical task, no judgement.', nextRunAt: '2026-10-19T03:47:00.000Z' }),
      ],
    })
    render(<AutomationsListPage />)
    const daily = screen.getByTestId('automation-row-daily')
    expect(within(daily).getByTestId('automation-row-did').textContent).toBe('regenerated the daily report and flagged 3 sessions.')
    expect(within(daily).queryByTestId('automation-row-gist')).toBeNull()
    const fresh = screen.getByTestId('automation-row-fresh')
    expect(within(fresh).getByTestId('automation-row-gist').textContent).toBe('Mechanical task, no judgement.')
    expect(fresh.textContent).toMatch(/never ran/)
  })

  it('a failed last run: the row says failed and why, and the page leads with it under "Needs a look"', () => {
    const failed = makeAutomation({
      id: 'fiscal',
      name: 'Tax watch FINANCE (daily)',
      agentId: 'finance',
      trigger: { kind: 'cron', expr: '45 8 * * *' },
      lastRun: { at: '2026-10-18T08:00:00.000Z', status: 'failed', durationMs: 2000 },
      lastRunError: "Claude Code returned an error result: You've reached your Fable limit.",
    })
    useStore.setState({ automations: [standing, failed] })
    render(<AutomationsListPage />)
    // the page (every agent) leads with it…
    const look = screen.getByTestId('automations-needs-a-look')
    expect(look.textContent).toMatch(/Tax watch FINANCE \(daily\) · Finance — The usage limit was reached/)
    expect(look.textContent).toMatch(/failed 8h ago/)
    // …and its agent's tile counts it and names the word
    const finance = screen.getByTestId('automations-group-finance')
    expect(finance.textContent).toMatch(/1 automation · 1 needs a look/)
    expect(finance.textContent).toMatch(/Tax watch FINANCE \(daily\) · failed/)
    expect(screen.getByTestId('automations-group-builder').textContent).not.toMatch(/needs a look/)
    // the row, one click away, says failed and why
    fireEvent.click(finance)
    const row = screen.getByTestId('automation-row-fiscal')
    expect(within(row).getByText('failed')).toBeInTheDocument()
    expect(within(row).getByTestId('automation-row-did').textContent).toBe('The usage limit was reached')
    expect(screen.getByTestId('automations-needs-a-look').textContent).toMatch(/Tax watch FINANCE/)
  })

  it('"Needs a look" is absent when nothing is off; a run waiting for approval is in it; a paused failure is not', () => {
    const { unmount } = render(<AutomationsListPage />)
    expect(screen.queryByTestId('automations-needs-a-look')).toBeNull()
    unmount()
    useStore.setState({
      automations: [
        standing,
        makeAutomation({ id: 'old', name: 'Old', paused: true, lastRun: { at: '2026-10-18T08:00:00.000Z', status: 'failed', durationMs: 1 } }),
      ],
      automationsPending: [{ id: 'r1', automationId: 'daily', at: '2026-10-18T15:00:00.000Z', status: 'waiting_approval' } as never],
    })
    render(<AutomationsListPage />)
    const look = screen.getByTestId('automations-needs-a-look')
    expect(look.textContent).toMatch(/Daily cost report · Builder — waiting for your go/)
    expect(look.textContent).not.toMatch(/Old/)
  })

  it('a failure with no recorded reason says so — never "failed" twice', () => {
    useStore.setState({ automations: [makeAutomation({ id: 'x', name: 'X', lastRun: { at: '2026-10-18T08:00:00.000Z', status: 'failed', durationMs: 1 } })] })
    render(<AutomationsListPage />)
    expect(within(screen.getByTestId('automation-row-x')).getByTestId('automation-row-did').textContent).toBe('no reason recorded — open it to see the run')
    expect(screen.getByTestId('automations-needs-a-look').textContent).toMatch(/X · Builder — no reason recorded/)
  })

  // the beat LEFT this page entirely — its home is
  // the «In charge of» card on the agent page; only enumerations hide it
  // (/automation/heartbeat-* stays reachable from that card).
  // a limit row that stopped SEVERAL agents'
  // beats lands on this whole list (inbox-destination.ts) — so the beats,
  // never rows, are named in one quiet line per agent («X's heartbeat ·
  // <period words> · Run now»), its name the door.
  it("an agent's standing beat (heartbeat-*) is never a row nor a group — the page names it in one line with a door to its own page", () => {
    const beat = makeAutomation({
      id: 'heartbeat-finance',
      name: 'Responsibility — Finance',
      agentId: 'finance',
      origin: 'agent',
      prompt: 'You are in charge of: x',
      trigger: { kind: 'cron', expr: '0 0 * * *' },
      nextRunAt: '2026-10-19T00:00:00.000Z',
    })
    const soloBeat = makeAutomation({ id: 'heartbeat-solo', name: 'Responsibility — Solo', agentId: 'solo', origin: 'agent' })
    useStore.setState({
      agents: [makeAgent(), makeAgent({ id: 'finance', name: 'Finance', emoji: '🧾' }), makeAgent({ id: 'solo', name: 'Solo' })],
      automations: [otherAgent, beat, soloBeat],
    })
    render(<AutomationsListPage />)
    expect(screen.queryByTestId('automation-row-heartbeat-finance')).toBeNull()
    // Finance's and Solo's beats, each with its own door
    const door = screen.getByTestId('automations-beat-door')
    expect(door.textContent).toMatch(/Finance’s heartbeat/)
    expect(door.textContent).toMatch(/Solo’s heartbeat/)
    expect(within(door).getAllByRole('button', { name: 'Run now' })).toHaveLength(2)
    // each beat: its runs (its own page) and its rhythm (its agent's control block)
    fireEvent.click(within(screen.getByTestId('beat-row-finance')).getByRole('button', { name: 'Runs ›' }))
    expect(useStore.getState().page).toEqual({ kind: 'automation', id: 'heartbeat-finance' })
    fireEvent.click(within(screen.getByTestId('beat-row-solo')).getByRole('button', { name: 'Rhythm ›' }))
    expect(useStore.getState().page).toEqual({ kind: 'agent', id: 'solo' })
    expect(useStore.getState().tab).toBe('control')
    // the beat is not counted among the agent's automations either
    expect(screen.getByTestId('automations-group-finance').textContent).toMatch(/1 automation(?!s)/)
    expect(screen.getByTestId('automation-row-fiscal')).toBeInTheDocument()
    // an agent whose only automation is its beat never conjures a group
    expect(screen.queryByTestId('automations-group-solo')).toBeNull()
  })

  it("a FAILED beat doesn't reach Needs a look here either (its failure lives in Home's inbox and on the agent's card)", () => {
    const beat = makeAutomation({
      id: 'heartbeat-finance',
      name: 'Responsibility — Finance',
      agentId: 'finance',
      origin: 'agent',
      lastRun: { at: '2026-10-18T08:00:00.000Z', status: 'failed', durationMs: 1 },
    })
    useStore.setState({ automations: [standing, beat] })
    render(<AutomationsListPage />)
    expect(screen.queryByTestId('automations-needs-a-look')).toBeNull()
  })

  it('an owner whose ONLY automations are beats sees them named with doors — never a blank list, never «No automations yet»', () => {
    const beat = makeAutomation({ id: 'heartbeat-finance', name: 'Responsibility — Finance', agentId: 'finance', origin: 'agent' })
    const beat2 = makeAutomation({ id: 'heartbeat-builder', name: 'Responsibility — Builder', agentId: 'builder', origin: 'agent' })
    useStore.setState({ agents: [makeAgent(), makeAgent({ id: 'finance', name: 'Finance' })], automations: [beat, beat2] })
    render(<AutomationsListPage />)
    expect(screen.queryByTestId('automations-list')).toBeNull()
    expect(screen.queryByText('No automations yet')).toBeNull()
    const empty = screen.getByTestId('automations-empty')
    expect(empty.textContent).toMatch(/The only automations are heartbeats/)
    expect(within(screen.getByTestId('beat-row-finance')).getByRole('button', { name: 'Runs ›' })).toBeInTheDocument()
    expect(within(screen.getByTestId('beat-row-builder')).getByRole('button', { name: 'Runs ›' })).toBeInTheDocument()
  })
  it('a single beat as the only automation: its agent named, one door to it', () => {
    useStore.setState({
      agents: [makeAgent(), makeAgent({ id: 'finance', name: 'Finance' })],
      automations: [makeAutomation({ id: 'heartbeat-finance', name: 'Responsibility — Finance', agentId: 'finance', origin: 'agent' })],
    })
    render(<AutomationsListPage />)
    expect(screen.getByText('Finance’s only automation is its heartbeat')).toBeInTheDocument()
    expect(within(screen.getByTestId('beat-row-finance')).getByRole('button', { name: 'Runs ›' })).toBeInTheDocument()
  })

  it('what it runs on shows only when it is not the agent default', () => {
    // both rows under one agent, so the page is that agent's list
    useStore.setState({
      catalog: [{ value: 'haiku', displayName: 'Haiku 4.5', resolvedModel: 'claude-haiku-4-5' }] as never,
      automations: [standing, { ...otherAgent, agentId: 'builder', runsOn: { model: 'haiku' } }],
    })
    render(<AutomationsListPage />)
    expect(within(screen.getByTestId('automation-row-fiscal')).getByTestId('automation-row-runs-on').textContent).toBe(' · on Haiku 4.5')
    expect(within(screen.getByTestId('automation-row-daily')).queryByTestId('automation-row-runs-on')).toBeNull()
  })

  it('states read as plain words: paused · asks first', () => {
    openAgent('builder')
    render(<AutomationsListPage />)
    expect(within(screen.getByTestId('automation-row-glm')).getByText('paused')).toBeInTheDocument()
    const mimo = screen.getByTestId('automation-row-mimo')
    expect(within(mimo).getByText('asks first')).toBeInTheDocument()
    // a once's trigger already says when — no second "next" line
    expect(mimo.textContent).not.toMatch(/next /)
  })

  it('finished one-shots fold under a count and unfold on request', () => {
    openAgent('builder')
    render(<AutomationsListPage />)
    expect(screen.queryByTestId('automation-row-probe1')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /2 done/ }))
    expect(screen.getByTestId('automation-row-probe1')).toBeInTheDocument()
    expect(screen.getByTestId('automation-row-probe2').textContent).toMatch(/ran Aug 2[89]/)
  })

  it('"Clear done" asks once, then deletes only the finished ones', async () => {
    openAgent('builder')
    render(<AutomationsListPage />)
    const builder = screen.getByTestId('automations-group-builder')
    fireEvent.click(within(builder).getByRole('button', { name: 'Clear done' }))
    expect(mockedApi.automations.delete).not.toHaveBeenCalled()
    fireEvent.click(within(builder).getByRole('button', { name: /Clear 2 done — sure\?/ }))
    await waitFor(() => expect(mockedApi.automations.delete).toHaveBeenCalledTimes(2))
    const ids = mockedApi.automations.delete.mock.calls.map((c) => c[0]).sort()
    expect(ids).toEqual(['probe1', 'probe2'])
  })

  it('a click on a row opens the automation', () => {
    const openAutomation = vi.fn()
    useStore.setState({ openAutomation })
    openAgent('builder')
    render(<AutomationsListPage />)
    fireEvent.click(within(screen.getByTestId('automation-row-daily')).getByRole('button', { name: /Daily cost report/ }))
    expect(openAutomation).toHaveBeenCalledWith('daily')
  })

  it("several agents: a tile each — counts, standing automations with state and next run, a click opens that agent's list", () => {
    render(<AutomationsListPage />)
    const builder = screen.getByTestId('automations-group-builder')
    const finance = screen.getByTestId('automations-group-finance')
    expect(builder.tagName).toBe('BUTTON')
    expect(finance.tagName).toBe('BUTTON')
    // standing automations preview with their state word; finished ones are only counted
    expect(builder.textContent).toMatch(/Daily cost report/)
    expect(builder.textContent).toMatch(/Retire alias model-a · paused/)
    expect(builder.textContent).toMatch(/Retire alias model-b · asks first/)
    expect(builder.textContent).toMatch(/tomorrow \d\d:\d\d/)
    expect(builder.textContent).not.toMatch(/TEST console keepalive/)
    expect(finance.textContent).toMatch(/Tax watch FINANCE \(daily\)/)
    // agent order follows the sidebar
    expect(builder.compareDocumentPosition(finance) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    fireEvent.click(finance)
    expect(useStore.getState().page).toEqual({ kind: 'automations', agent: 'finance' })
    expect(screen.getByTestId('automation-row-fiscal')).toBeInTheDocument()
    expect(screen.queryByTestId('automations-group-builder')).toBeNull()
  })

  it('a tile previews at most three automations and says how many more', () => {
    const many = [1, 2, 3, 4, 5].map((n) => makeAutomation({ id: `m${n}`, name: `Many ${n}` }))
    useStore.setState({ automations: [...many, otherAgent] })
    render(<AutomationsListPage />)
    const builder = screen.getByTestId('automations-group-builder')
    expect(builder.textContent).toMatch(/5 automations/)
    expect(builder.textContent).toMatch(/Many 3/)
    expect(builder.textContent).not.toMatch(/Many 4/)
    expect(builder.textContent).toMatch(/2 more/)
  })
})

// the sidebar's per-agent "⚡ N automations" row lands here filtered to that
// agent (/automations?agent=<id>); the global entry lands unfiltered.
describe('Automations — opened for one agent', () => {
  it('page.agent shows only that agent’s group', () => {
    useStore.setState({ page: { kind: 'automations', agent: 'finance' } })
    render(<AutomationsListPage />)
    expect(screen.getByTestId('automations-group-finance')).toBeInTheDocument()
    expect(screen.queryByTestId('automations-group-builder')).toBeNull()
  })

  it('the global entry afterwards drops the seed and shows every agent', () => {
    useStore.setState({ page: { kind: 'automations', agent: 'finance' } })
    render(<AutomationsListPage />)
    act(() => {
      useStore.getState().changePage({ kind: 'automations' })
    })
    expect(screen.getByTestId('automations-group-builder')).toBeInTheDocument()
    expect(screen.getByTestId('automations-group-finance')).toBeInTheDocument()
  })

  it('narrowed, the title stays «Automations» (a root page, no crumbs); the agent is a removable chip that widens back', () => {
    useStore.setState({ page: { kind: 'automations', agent: 'finance' } })
    render(<AutomationsListPage />)
    expect(screen.getByRole('heading', { name: 'Automations' })).toBeInTheDocument()
    expect(screen.queryByRole('navigation', { name: 'Where this lives' })).toBeNull()
    expect(screen.getByRole('button', { name: 'filter by Agent' })).toHaveTextContent('Finance')
    fireEvent.click(screen.getByRole('button', { name: 'clear Agent filter' }))
    expect(useStore.getState().page).toEqual({ kind: 'automations' })
    expect(screen.getByTestId('automations-group-builder')).toBeInTheDocument()
  })

  it('the chip narrows from the page too: one agent at a time, the address says it', () => {
    useStore.setState({ page: { kind: 'automations' } })
    render(<AutomationsListPage />)
    fireEvent.click(screen.getByRole('button', { name: 'filter by Agent' }))
    fireEvent.click(screen.getByRole('option', { name: /Finance/ }))
    expect(useStore.getState().page).toEqual({ kind: 'automations', agent: 'finance' })
  })
})
