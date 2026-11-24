// control-switch.test.tsx — the agent's ONE control and its period: its sentences, the refusals
// with their doors, the heartbeat row and its period editor, and the sheet
// the flip to Only when told answers with.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ControlSwitch, controlSentence, heartbeatLines, scheduleWords } from '../src/components/agent/ControlSwitch'
import { useStore } from '../src/store'
import { api } from '../src/lib/api'
import type { AgentView, HeartbeatView } from '../src/lib/types'
import type { Period } from '../src/lib/period'

vi.mock('../src/lib/api')
const mockedApi = vi.mocked(api, { deep: true })
const WEEKLY: Period = { every: 1, unit: 'weeks', day: 1, at: '09:07' }

const agent = (o: Partial<AgentView> = {}): AgentView => ({
  id: 'x',
  name: 'X',
  emoji: '🤖',
  folder: '/w/x',
  skills: [],
  sessions: [],
  liveCount: 0,
  sessionCount: 0,
  control: 'told',
  heartbeat: { period: WEEKLY },
  ...o,
})
const view = (o: Partial<HeartbeatView> = {}): HeartbeatView => ({
  period: WEEKLY,
  next: null,
  sleeping: null,
  last: null,
  decided: [],
  decidedReactive: 0,
  measures: null,
  today: { used: 4, costUsd: 0, unpriced: 0, ceiling: 10, spendCap: 5, exempt: false },
  ...o,
})

beforeEach(() => {
  vi.clearAllMocks()
  mockedApi.overview.mockImplementation(async () => ({ agents: useStore.getState().agents, now: 0, warming: false }))
  mockedApi.agents.heartbeat.mockResolvedValue(view())
  mockedApi.agents.update.mockResolvedValue(undefined)
  mockedApi.agents.stop.mockResolvedValue({ stopped: [], paused: [] })
})

describe('the words', () => {
  it("each control and period says its sentence; the row says the period's words", () => {
    expect(controlSentence('told', WEEKLY).rest).toBeNull()
    expect(controlSentence('own', WEEKLY).rest).toBe('Looks at what arrived every Monday at 09:07')
    expect(controlSentence('own', null).rest).toBe("Doesn't look or think on its own")
    expect(scheduleWords({ period: { every: 3, unit: 'hours', at: '08:22', between: { from: '08:00', to: '20:00' } } })).toBe(
      'Every 3 hours from 08:22 · 08:00–20:00',
    )
    expect(scheduleWords({ period: null })).toBeNull()
  })
  it("the heartbeat's lines: its last turn, then a later skip in the page's words, and when it comes", () => {
    const now = new Date(2026, 10, 16, 18, 0).getTime()
    const at = (h: number, m = 0): string => new Date(2026, 10, 16, h, m).toISOString()
    const last = (o: Partial<NonNullable<HeartbeatView['last']>>): HeartbeatView['last'] => ({
      at: at(9),
      kind: 'look',
      skipped: null,
      summary: null,
      created: [],
      proposed: [],
      tainted: false,
      ...o,
    })
    expect(heartbeatLines(view({ last: last({ skipped: 'nothing happened since x' }) }), 'X', now).quiet).toBe('Looked 09:00 — nothing happened')
    expect(heartbeatLines(view({ last: last({ kind: 'think', created: ['t1'] }) }), 'X', now).made).toEqual({
      text: 'Thought 09:00 — decided one thing',
      door: true,
    })
    const round = view({
      lastTurn: { at: at(14, 22), kind: 'round', created: ['a', 'b'], proposed: [] },
      last: last({
        at: at(17, 22),
        kind: 'round',
        skipped: "X's account is at 88% of its 5-hour window — rounds wait so there is room for you",
        cause: 'headroom',
      }),
      next: new Date(2026, 10, 17, 8, 22).toISOString(),
      skips: [
        { at: at(17, 22), cause: 'headroom', kind: 'round', reason: "X's account is at 88% of its 5-hour window — rounds wait so there is room for you" },
        { at: at(16, 22), cause: 'busy', kind: 'round', reason: 'the previous one is still running' },
        { at: at(15, 22), cause: 'empty', kind: 'look', reason: 'nothing happened since 14:22' },
      ],
    })
    const l = heartbeatLines(round, 'X', now)
    expect(l.made).toEqual({ text: 'Made its round 14:22 — decided 2 things', door: true })
    // the last skip at rest, with its one door; the day's others folded behind it
    expect(l.skip).toMatchObject({ text: 'its account is at 88% of its 5-hour window', door: 'usage', round: true })
    expect(l.more.map((s) => s.at)).toEqual([at(16, 22)])
    expect(l.next).toBe('Next: tomorrow 08:22')
    expect(
      heartbeatLines(view({ lastTurn: { at: at(11, 22), kind: 'round', created: [], proposed: [] }, last: last({ at: at(11, 22), kind: 'round' }) }), 'X', now)
        .made,
    ).toEqual({ text: 'Made its round 11:22 — nothing needed doing', door: false })
    expect(heartbeatLines(view({ sleeping: { until: '2027-01-07T00:00:00Z', why: 'nothing fiscal until January' } }), 'X', now).asleep).toMatch(
      /^Sleeping until .+ — “nothing fiscal until January”$/,
    )
    expect(heartbeatLines(view({ next: new Date(2026, 10, 17, 9, 0).toISOString() }), 'X', now).next).toBe('Next: tomorrow 09:00')
  })
})

describe('the switch', () => {
  it('told → own sends control, and a refusal names its door', async () => {
    mockedApi.agents.update.mockRejectedValueOnce(new Error('Give X a mission first — on its own, it needs to know what it answers for'))
    render(<ControlSwitch agent={agent()} />)
    await act(async () => {
      fireEvent.click(screen.getByTestId('control-own'))
    })
    expect(mockedApi.agents.update).toHaveBeenCalledWith('x', { control: 'own' })
    expect(screen.getByTestId('control-error').textContent).toContain('Give X a mission first')
    expect(screen.getByRole('button', { name: 'Write its mission ›' })).toBeInTheDocument()
  })
  it("On its own shows the heartbeat row and the day's count", async () => {
    render(<ControlSwitch agent={agent({ control: 'own', mission: { text: 'Do x.', never: [], updatedAt: '' } })} />)
    expect(await screen.findByTestId('control-heartbeat')).toHaveTextContent('Every Monday at 09:07')
    expect(await screen.findByTestId('control-measured')).toHaveTextContent('Started 4 times today · max 10 ›')
    // change › the period editor: every 3 hours, only between 08:00 and 20:00
    fireEvent.click(screen.getByTestId('control-period-change'))
    fireEvent.change(screen.getByTestId('control-period-editor-form-every'), { target: { value: '3' } })
    fireEvent.click(screen.getByTestId('control-period-editor-form-unit-hours'))
    fireEvent.click(screen.getByTestId('control-period-editor-form-band'))
    expect(screen.getByTestId('control-period-editor-form-ruler').getAttribute('data-slots')).toBe('5')
    await act(async () => {
      fireEvent.click(screen.getByTestId('control-period-save'))
    })
    expect(mockedApi.agents.update).toHaveBeenCalledWith('x', { heartbeat: { period: { every: 3, unit: 'hours', between: { from: '08:00', to: '20:00' } } } })
  })
  it('the heartbeat row has its doors: Runs › its own page, Run now its own verb — Wake now only while it sleeps', async () => {
    mockedApi.agents.heartbeatRunNow.mockResolvedValue(undefined)
    useStore.setState({ agents: [agent({ control: 'own' })] })
    const { unmount } = render(<ControlSwitch agent={agent({ control: 'own' })} />)
    await screen.findByTestId('control-heartbeat')
    fireEvent.click(screen.getByTestId('control-heartbeat-run'))
    await waitFor(() => expect(mockedApi.agents.heartbeatRunNow).toHaveBeenCalledWith('x'))
    fireEvent.click(screen.getByTestId('control-heartbeat-runs'))
    expect(useStore.getState().page).toEqual({ kind: 'automation', id: 'heartbeat-x' })
    unmount()
    mockedApi.agents.heartbeat.mockResolvedValue(view({ sleeping: { until: '2099-01-01T00:00:00.000Z', why: null } as never }))
    render(<ControlSwitch agent={agent({ control: 'own' })} />)
    expect(await screen.findByText('Wake now')).toBeInTheDocument()
    expect(screen.queryByTestId('control-heartbeat-run')).toBeNull()
  })
  it("Never is a choice of the editor; the floor is said in the server's words before Save", async () => {
    render(<ControlSwitch agent={agent({ control: 'own', mission: { text: 'Do x.', never: [], updatedAt: '' } })} />)
    fireEvent.click(await screen.findByTestId('control-period-change'))
    fireEvent.change(screen.getByTestId('control-period-editor-form-every'), { target: { value: '2' } })
    fireEvent.click(screen.getByTestId('control-period-editor-form-unit-minutes'))
    expect(screen.getByTestId('control-period-editor-form-problem')).toHaveTextContent(/every 5 minutes/)
    expect(screen.getByTestId('control-period-save')).toBeDisabled()
    fireEvent.click(screen.getByTestId('control-period-editor-form-never'))
    await act(async () => {
      fireEvent.click(screen.getByTestId('control-period-save'))
    })
    expect(mockedApi.agents.update).toHaveBeenCalledWith('x', { heartbeat: { period: null } })
  })
  it('the flip to Only when told answers with the sheet: Stop a running turn, Pause too its own work, the dropped queue', async () => {
    mockedApi.agents.update.mockResolvedValueOnce({
      pending: { running: [{ turnId: 't1', what: 'Close the month' }], stillRuns: [{ id: 'a1', name: 'Weekly law check' }], queued: 2 },
    })
    render(<ControlSwitch agent={agent({ control: 'own', mission: { text: 'Do x.', never: [], updatedAt: '' } })} />)
    await act(async () => {
      fireEvent.click(screen.getByTestId('control-told'))
    })
    const sheet = await screen.findByTestId('control-sheet')
    expect(sheet).toHaveTextContent('Running now: Close the month — Let it finish · Stop')
    expect(sheet).toHaveTextContent('Still runs: Weekly law check — Keep (it runs under Only when told) · Pause too')
    expect(sheet).toHaveTextContent('Queued: 2 waiting wakes — they are dropped')
    expect(sheet).toHaveTextContent('Its heartbeat stops.')
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
    })
    expect(mockedApi.agents.stop).toHaveBeenCalledWith('x', { turns: ['t1'] })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Pause too' }))
    })
    expect(mockedApi.agents.stop).toHaveBeenCalledWith('x', { pause: ['a1'] })
    await waitFor(() => expect(sheet).toHaveTextContent('paused'))
  })
})

describe('Measured — the plan and the money, and what came from outside', () => {
  it("a Claude account: its weekly % said as the ACCOUNT's, shared by the agents on it", async () => {
    useStore.setState({ agents: [agent(), agent({ id: 'y', name: 'Y' }), agent({ id: 'z', name: 'Z', provider: 'account:second' })] })
    mockedApi.planUsage.mockResolvedValue({
      ok: true,
      at: 0,
      stale: false,
      windows: [{ kind: 'weekly_all', label: 'Week', percent: 34, resetsAt: null, windowMs: 7 * 24 * 3600_000, severity: 'normal', active: false }],
    })
    render(<ControlSwitch agent={agent()} />)
    expect(await screen.findByTestId('control-measured-plan')).toHaveTextContent("34% of your Claude account's weekly window used · shared by 2 agents")
  })
  it('an API key that prices: «~$ today» with its unpriced turns — never a plan line', async () => {
    mockedApi.planUsage.mockResolvedValue(null)
    mockedApi.agents.heartbeat.mockResolvedValue(view({ today: { used: 2, costUsd: 3.2, unpriced: 4, ceiling: 10, spendCap: 5, exempt: false, priced: true } }))
    render(<ControlSwitch agent={agent({ control: 'own' })} />)
    expect(await screen.findByTestId('control-measured-spend')).toHaveTextContent('~$3.20 today + 4 unpriced')
    expect(screen.queryByTestId('control-measured-plan')).toBeNull()
  })
  it('its tasks added outside Silos: one line, each a door to its task', async () => {
    mockedApi.planUsage.mockResolvedValue(null)
    mockedApi.agents.heartbeat.mockResolvedValue(view({ outside: [{ key: 'folder:/w/x/plan/tasks/t1', title: 'Renew the domain' }] }))
    render(<ControlSwitch agent={agent()} />)
    const line = await screen.findByTestId('control-outside')
    expect(line).toHaveTextContent('1 task')
    expect(screen.getByRole('button', { name: 'Renew the domain ›' })).toBeInTheDocument()
  })
})
