// proactive.test.tsx — the proactive mode on the screen: what PATCH each
// gesture of the ladder sends, the sheet's
// prefill and its «≈ n rounds a day» (slotsPerDay over the period the server
// will stamp), what holds it, the 409s with their doors, the Proactive row
// and its cut. Copy is pinned loosely — the screenshots carry the words.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ControlSwitch } from '../src/components/agent/ControlSwitch'
import { useStore } from '../src/store'
import { api } from '../src/lib/api'
import { draftOfPeriod, type Period } from '../src/lib/period'
import { TERRITORY_DOOR_WORDS } from '../src/lib/territory'
import { holdsWords, roundsOfDraft, sheetBody, sheetPeriod, shownPosition, switchGesture } from '../src/lib/proactive'
import type { AgentView, HeartbeatView, ProactiveView } from '../src/lib/types'

vi.mock('../src/lib/api')
const mockedApi = vi.mocked(api, { deep: true })
const WEEKLY: Period = { every: 1, unit: 'weeks', day: 1, at: '09:07' }
const HOURS: Period = { every: 3, unit: 'hours', at: '08:22', between: { from: '08:00', to: '20:00' }, since: '2026-11-11' }
const BAND = { from: '08:00', to: '20:00' }
const MISSION = { text: 'Keep the books.', never: [], updatedAt: '' }

const agent = (o: Partial<AgentView> = {}): AgentView => ({
  id: 'x',
  name: 'X',
  emoji: '🤖',
  folder: '/w/x',
  skills: [],
  sessions: [],
  liveCount: 0,
  sessionCount: 0,
  control: 'own',
  mission: MISSION,
  heartbeat: { period: WEEKLY },
  ...o,
})
const pro = (o: Partial<ProactiveView> = {}): ProactiveView => ({
  position: 'own',
  setting: null,
  effective: false,
  off: null,
  today: { made: 2, perDay: 5, left: 3, open: 2, openMax: 10 },
  roundsPerDay: 4,
  holds: { kind: 'account', account: 'default', headroomPercent: 85 },
  connectors: [
    { name: 'gmail', kind: 'mcp', scope: 'user' },
    { name: 'drive', kind: 'plugin', scope: 'project' },
  ],
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
  staggerMinute: 22,
  proactive: pro(),
  ...o,
})

beforeEach(() => {
  vi.clearAllMocks()
  useStore.setState({ agents: [] })
  mockedApi.overview.mockImplementation(async () => ({ agents: useStore.getState().agents, now: 0, warming: false }))
  mockedApi.agents.heartbeat.mockResolvedValue(view())
  mockedApi.agents.update.mockResolvedValue(undefined)
  mockedApi.planUsage.mockResolvedValue(null)
})

describe('the gestures', () => {
  it("the position is the owner's choice: own with a setting is Proactive", () => {
    expect(shownPosition({ control: 'told' })).toBe('told')
    expect(shownPosition({ control: 'own' })).toBe('own')
    expect(shownPosition({ control: 'own', proactive: { perDay: 5, tools: true } })).toBe('proactive')
  })
  it('each touch: Proactive opens the sheet; On its own from Proactive sends proactive: null; Only when told sends the control', () => {
    expect(switchGesture('own', 'proactive')).toEqual({ sheet: true })
    expect(switchGesture('told', 'proactive')).toEqual({ sheet: true })
    expect(switchGesture('proactive', 'own')).toEqual({ body: { proactive: null } })
    expect(switchGesture('told', 'own')).toEqual({ body: { control: 'own' } })
    expect(switchGesture('proactive', 'told')).toEqual({ body: { control: 'told' } })
    expect(switchGesture('own', 'own')).toBeNull()
  })
  it("the sheet's PATCH carries On its own only from Only when told", () => {
    const d = draftOfPeriod(sheetPeriod(null))
    expect(sheetBody('told', d, 5, true)).toEqual({
      control: 'own',
      heartbeat: { period: { every: 3, unit: 'hours', between: BAND } },
      proactive: { perDay: 5, tools: true },
    })
    expect(sheetBody('own', d, 7, false)).toEqual({ heartbeat: { period: { every: 3, unit: 'hours', between: BAND } }, proactive: { perDay: 7, tools: false } })
  })
})

describe("the sheet's numbers", () => {
  it('prefill: its own period under a day (the server re-stamps at and since), else every 3 hours · 08:00–20:00', () => {
    expect(sheetPeriod(HOURS)).toEqual({ every: 3, unit: 'hours', between: BAND })
    expect(sheetPeriod({ every: 45, unit: 'minutes' })).toEqual({ every: 45, unit: 'minutes' })
    expect(sheetPeriod(WEEKLY)).toEqual({ every: 3, unit: 'hours', between: BAND })
    expect(sheetPeriod({ every: 1, unit: 'days', at: '09:00' })).toEqual({ every: 3, unit: 'hours', between: BAND })
    expect(sheetPeriod(null)).toEqual({ every: 3, unit: 'hours', between: BAND })
  })
  it('≈ n rounds a day is slotsPerDay over the period the server will keep — anchored at the staggered minute', () => {
    const d = draftOfPeriod(sheetPeriod(null))
    // 08:22, 11:22, 14:22, 17:22 — 20:22 falls outside the band
    expect(roundsOfDraft(d, 22)).toMatchObject({ n: 4, from: '08:22' })
    // anchored on the hour, 20:00 is inside (both ends inclusive)
    expect(roundsOfDraft(d, 0)).toMatchObject({ n: 5, from: '08:00' })
    expect(roundsOfDraft({ ...d, every: '45', unit: 'minutes', band: null }, 7)).toMatchObject({ n: 32, from: '00:07' })
    expect(roundsOfDraft({ ...d, every: '1', unit: 'days', at: '09:30' }, 7)).toMatchObject({ n: 1, from: '09:30', cadence: 'one round a day' })
    // a draft the server refuses has no count
    expect(roundsOfDraft({ ...d, every: '2', unit: 'minutes' }, 7)).toBeNull()
  })
  it('what holds it, in its variant', () => {
    expect(holdsWords({ kind: 'spend', spendPerDay: 5, sharePercent: 50 })).toContain('$5')
    expect(holdsWords({ kind: 'account', account: 'default', headroomPercent: 85 })).toContain('85%')
    expect(holdsWords({ kind: 'unmeasured', account: 'opencode', roundsPerDay: 12 })).toContain('12')
  })
})

describe("the ladder on the agent's page", () => {
  it('On its own → Proactive: the sheet, prefilled, with its rounds, connectors and holds; Make sends period, count and tools', async () => {
    render(<ControlSwitch agent={agent()} />)
    await screen.findByTestId('control-measured')
    fireEvent.click(screen.getByTestId('control-proactive'))
    const sheet = await screen.findByTestId('proactive-sheet')
    expect(screen.getByTestId('proactive-sheet-rounds')).toHaveTextContent('≈ 4 rounds a day, from 08:22')
    expect(screen.getByTestId('proactive-sheet-connectors')).toHaveTextContent('gmail, drive')
    expect(screen.getByTestId('proactive-sheet-holds')).toHaveTextContent('85%')
    expect(sheet).toHaveTextContent('within its 10 starts a day')
    fireEvent.change(screen.getByTestId('proactive-sheet-perday'), { target: { value: '3' } })
    fireEvent.click(screen.getByTestId('proactive-sheet-files'))
    await act(async () => {
      fireEvent.click(screen.getByTestId('proactive-sheet-make'))
    })
    expect(mockedApi.agents.update).toHaveBeenCalledWith('x', {
      heartbeat: { period: { every: 3, unit: 'hours', between: BAND } },
      proactive: { perDay: 3, tools: false },
    })
    expect(screen.queryByTestId('proactive-sheet')).toBeNull()
  })
  it('Only when told → Proactive: own in the same write, and a refusal names its door', async () => {
    mockedApi.agents.update.mockRejectedValueOnce(new Error("X's territory is off. Turn it on, then it can go on its own ›"))
    render(<ControlSwitch agent={agent({ control: 'told' })} />)
    fireEvent.click(screen.getByTestId('control-proactive'))
    await screen.findByTestId('proactive-sheet')
    await act(async () => {
      fireEvent.click(screen.getByTestId('proactive-sheet-make'))
    })
    expect(mockedApi.agents.update).toHaveBeenCalledWith('x', expect.objectContaining({ control: 'own', proactive: { perDay: 5, tools: true } }))
    expect(screen.getByTestId('proactive-sheet-error')).toHaveTextContent("X's territory is off")
    // the door leads to the agent's Settings, where its territory is turned on
    fireEvent.click(screen.getByRole('button', { name: TERRITORY_DOOR_WORDS }))
    expect(useStore.getState().page).toEqual({ kind: 'agent', id: 'x' })
    expect(useStore.getState().tab).toBe('identity')
  })
  it('Proactive → On its own: proactive: null, explicit, no sheet; its rows say its round', async () => {
    mockedApi.agents.heartbeat.mockResolvedValue(
      view({ period: HOURS, proactive: pro({ position: 'proactive', setting: { perDay: 5, tools: true }, effective: true }) }),
    )
    render(<ControlSwitch agent={agent({ heartbeat: { period: HOURS }, proactive: { perDay: 5, tools: true } })} />)
    expect(screen.getByTestId('control-proactive')).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByTestId('control-sentence')).toHaveTextContent(/^Goes looking for work\. Every 3 hours from 08:22 · 08:00–20:00 it does a round/)
    // the row exists before the heartbeat view resolves (then it says
    // «change»): wait for the CONTENT, not the container, or a slow
    // machine asserts on the earlier render
    const row = await screen.findByTestId('control-proactive-row')
    await waitFor(() => expect(row).toHaveTextContent('Up to 5 tasks a day from its mission · 2 today'))
    await act(async () => {
      fireEvent.click(screen.getByTestId('control-own'))
    })
    expect(mockedApi.agents.update).toHaveBeenCalledWith('x', { proactive: null })
    expect(screen.queryByTestId('proactive-sheet')).toBeNull()
  })
  it('a week or more between rounds: said under the editor before the click, Make held — no PATCH', async () => {
    render(<ControlSwitch agent={agent()} />)
    await screen.findByTestId('control-measured')
    fireEvent.click(screen.getByTestId('control-proactive'))
    await screen.findByTestId('proactive-sheet')
    fireEvent.change(screen.getByTestId('proactive-sheet-period-form-every'), { target: { value: '1' } })
    fireEvent.click(screen.getByTestId('proactive-sheet-period-form-unit-weeks'))
    expect(screen.getByTestId('proactive-sheet-period-form-problem')).toHaveTextContent(/less than a week/)
    expect(screen.getByTestId('proactive-sheet-make')).toBeDisabled()
    await act(async () => {
      fireEvent.click(screen.getByTestId('proactive-sheet-make'))
    })
    // seven days is a week too; six is not
    fireEvent.click(screen.getByTestId('proactive-sheet-period-form-unit-days'))
    fireEvent.change(screen.getByTestId('proactive-sheet-period-form-every'), { target: { value: '7' } })
    expect(screen.getByTestId('proactive-sheet-make')).toBeDisabled()
    fireEvent.change(screen.getByTestId('proactive-sheet-period-form-every'), { target: { value: '6' } })
    expect(screen.queryByTestId('proactive-sheet-period-form-problem')).toBeNull()
    expect(mockedApi.agents.update).not.toHaveBeenCalled()
  })
  it('«decided N things ›» brings Decided — where its Undo is — into view, never another page', async () => {
    const changePage = vi.fn()
    useStore.setState({ changePage })
    const decided = [
      { id: 'c1', kind: 'task' as const, ref: 'folder:/w/x/tasks/tasks/t1', title: 'Renew the domain', createdAt: '', by: 'x', signal: 'mission' },
    ]
    mockedApi.agents.heartbeat.mockResolvedValue(
      view({ period: HOURS, decided, lastTurn: { at: new Date().toISOString(), kind: 'round', created: ['Renew the domain'], proposed: [] } }),
    )
    render(<ControlSwitch agent={agent({ heartbeat: { period: HOURS }, proactive: { perDay: 5, tools: true } })} />)
    const door = await screen.findByTestId('control-made-door')
    const list = screen.getByTestId('control-decided')
    const scrolled = vi.fn()
    list.scrollIntoView = scrolled
    fireEvent.click(door)
    expect(scrolled).toHaveBeenCalled()
    expect(document.activeElement).toBe(list)
    expect(changePage).not.toHaveBeenCalled()
  })
  it('cut: «Rounds are off» with Allow again', async () => {
    mockedApi.agents.heartbeat.mockResolvedValue(view({ period: HOURS, proactive: pro({ setting: { perDay: 5, tools: true }, off: 'cut' }) }))
    render(<ControlSwitch agent={agent({ heartbeat: { period: HOURS }, proactive: { perDay: 5, tools: true }, cut: { at: '', why: 'read outside' } })} />)
    const off = await screen.findByTestId('control-proactive-off')
    // the sentence stops promising rounds; the row says why, from its record
    expect(screen.getByTestId('control-sentence')).toHaveTextContent('Rounds are off')
    expect(screen.getByTestId('control-sentence')).not.toHaveTextContent('it does a round')
    expect(off).toHaveTextContent('read outside')
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Allow again' }))
    })
    expect(mockedApi.agents.update).toHaveBeenCalledWith('x', { cut: null })
  })
  it("on a task's page «Proactive ›» is a door to the agent's page, never the sheet", () => {
    const changePage = vi.fn()
    useStore.setState({ changePage })
    render(<ControlSwitch agent={agent()} compact testId="task-moves-control" />)
    const door = screen.getByTestId('task-moves-control-proactive')
    expect(door).toHaveTextContent('Proactive ›')
    fireEvent.click(door)
    expect(changePage).toHaveBeenCalledWith({ kind: 'agent', id: 'x' })
    expect(mockedApi.agents.update).not.toHaveBeenCalled()
  })
})
