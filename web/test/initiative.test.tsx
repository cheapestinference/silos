// initiative.test.tsx — what agents create on their own, on the web
// (Decided/Measured, lone acts, Undo):
// the rows' words and doors, Undo saying what it does not undo BEFORE it
// acts, the reactive tail folded, «added outside Silos ›» where opening never
// blesses and the button does, and the baseline's «Keep them all ›» with the
// ones left out.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { Decided } from '../src/components/agent/Decided'
import { ControlSwitch } from '../src/components/agent/ControlSwitch'
import { OriginMark, useOriginOutside } from '../src/components/tasks/OriginMark'

// the page reads the origin once and hands it to the mark
function Marked({ taskKey }: { taskKey: string }) {
  const o = useOriginOutside(taskKey)
  return <OriginMark taskKey={taskKey} outside={o.outside} onKept={o.kept} />
}
import { HomePage } from '../src/components/home/HomePage'
import { useStore } from '../src/store'
import { api } from '../src/lib/api'
import { headline, scopeInbox } from '../src/lib/home'
import { UNDO_SAYS, baselineKeepWords, baselineWords, decidedRow, heartbeatDayLine, measuredLine, reactiveFold, undoTarget } from '../src/lib/initiative'
import type { AgentView, Creation, HeartbeatView, InboxRow, Measures } from '../src/lib/types'
import { openNeedsYou } from './home-tiles'

vi.mock('../src/lib/api')
const mockedApi = vi.mocked(api, { deep: true })

const creation = (o: Partial<Creation> = {}): Creation => ({
  id: 'c1',
  kind: 'task',
  ref: 'folder:/w/x/plans/tasks/tasks/t4',
  title: 'read new tax law',
  createdAt: '2026-11-10T09:00:00Z',
  signal: 'mission',
  by: 'x',
  ...o,
})
const measures = (o: Partial<Measures> = {}): Measures => ({
  initiatives: { created: 3, kept: 2, undone: 1 },
  reactive: { created: 5, kept: 1, undone: 0 },
  rejected: 0,
  tainted: 0,
  ...o,
})
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
  heartbeat: { period: { every: 1, unit: 'weeks', day: 1, at: '09:07' } },
  ...o,
})
const hb = (o: Partial<HeartbeatView> = {}): HeartbeatView => ({
  period: { every: 1, unit: 'weeks', day: 1, at: '09:07' },
  next: null,
  sleeping: null,
  last: null,
  decided: [],
  decidedReactive: 0,
  measures: null,
  today: null,
  ...o,
})

beforeEach(() => {
  vi.clearAllMocks()
  useStore.setState({ page: null })
})

describe('the words', () => {
  it('a decision, a withdrawal, a pause — each with its door', () => {
    expect(decidedRow(creation(), 'X')).toMatchObject({ id: 'c1', text: expect.stringContaining('read new tax law'), door: 'undo', outside: null })
    expect(decidedRow(creation({ kind: 'automation', action: 'withdrew', title: 'Weekly law check' }), 'X')).toMatchObject({
      text: expect.stringContaining('Weekly law check'),
      door: 'restore',
    })
    expect(decidedRow(creation({ kind: 'automation', action: 'paused', title: 'Weekly law check' }), 'X')).toMatchObject({
      text: expect.stringContaining('Weekly law check'),
      door: 'unpause',
    })
    expect(decidedRow(creation({ readOutside: ['WebFetch'] }), 'X').outside).toContain('WebFetch')
  })
  it('Undo names its target; the reactive tail folds; the measure says initiatives', () => {
    expect(undoTarget(creation())).toEqual({ task: 'folder:/w/x/plans/tasks/tasks/t4' })
    expect(undoTarget(creation({ kind: 'automation', ref: 'a9' }))).toEqual({ automation: 'a9' })
    expect(reactiveFold(0)).toBeNull()
    expect(reactiveFold(12)).toBe('…and 12 tasks from its inbox ›')
    expect(measuredLine(measures())).toBe('Last 30 days: 3 initiatives · 2 kept · 1 undone')
    expect(measuredLine(measures({ initiatives: { created: 0, kept: 0, undone: 0 } }))).toBeNull()
    expect(measuredLine(null)).toBeNull()
    expect(UNDO_SAYS).toBe("Undo stops it. It doesn't undo what it did.")
  })
  it('the baseline row and its button', () => {
    expect(baselineWords(14)).toBe('14 tasks existed before Silos watched this folder')
    expect(baselineKeepWords(14, 0)).toBe('Keep them all')
    expect(baselineKeepWords(14, 2)).toBe('Keep 12 of 14')
  })
})

describe('Decided on the agent page', () => {
  it('Undo first says what it does not undo; only the confirm undoes', async () => {
    mockedApi.initiative.undo.mockResolvedValue({ undone: 'task', stopped: false })
    const onChanged = vi.fn()
    render(<Decided agent={{ id: 'x', name: 'X' }} items={[creation()]} reactive={0} onChanged={onChanged} />)
    expect(screen.getByTestId('decided-row')).toHaveTextContent('X decided: read new tax law · Undo')
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
    expect(screen.getByTestId('decided-undo-says')).toHaveTextContent(UNDO_SAYS)
    expect(mockedApi.initiative.undo).not.toHaveBeenCalled()
    await act(async () => {
      fireEvent.click(screen.getByTestId('decided-undo-confirm'))
    })
    expect(mockedApi.initiative.undo).toHaveBeenCalledWith({ task: 'folder:/w/x/plans/tasks/tasks/t4' })
    expect(onChanged).toHaveBeenCalled()
  })
  it("Restore › brings a withdrawal back; Unpause is the owner's resume", async () => {
    mockedApi.initiative.restore.mockResolvedValue({ restored: 'a1' })
    mockedApi.automations.resume.mockResolvedValue({} as never)
    render(
      <Decided
        agent={{ id: 'x', name: 'X' }}
        items={[
          creation({ id: 'w', kind: 'automation', ref: 'a1', action: 'withdrew', title: 'Weekly law check' }),
          creation({ id: 'p', kind: 'automation', ref: 'a2', action: 'paused', title: 'Monthly close' }),
        ]}
        reactive={0}
        onChanged={() => {}}
      />,
    )
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Restore ›' }))
    })
    expect(mockedApi.initiative.restore).toHaveBeenCalledWith('a1')
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Unpause' }))
    })
    expect(mockedApi.automations.resume).toHaveBeenCalledWith('a2')
  })
  it('a refused Undo is said in the row', async () => {
    mockedApi.initiative.undo.mockRejectedValue(new Error('already undone'))
    render(<Decided agent={{ id: 'x', name: 'X' }} items={[creation()]} reactive={0} onChanged={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
    await act(async () => {
      fireEvent.click(screen.getByTestId('decided-undo-confirm'))
    })
    expect(screen.getByRole('alert')).toHaveTextContent('already undone')
  })
  it('only the reactive tail: one line that opens its tasks; nothing at all: no box', () => {
    const { rerender } = render(<Decided agent={{ id: 'x', name: 'X' }} items={[]} reactive={3} onChanged={() => {}} />)
    fireEvent.click(screen.getByTestId('decided-reactive'))
    expect(screen.getByTestId('decided-reactive')).toHaveTextContent('…and 3 tasks from its inbox ›')
    expect(useStore.getState().page).toEqual({ kind: 'tasks', agent: ['x'] })
    rerender(<Decided agent={{ id: 'x', name: 'X' }} items={[]} reactive={0} onChanged={() => {}} />)
    expect(screen.queryByText('Decided')).toBeNull()
  })
  it('the page paints Decided and the 30-day measure also under Only when told — never its day count', async () => {
    mockedApi.agents.heartbeat.mockResolvedValue(
      hb({ decided: [creation()], measures: measures(), today: { used: 2, costUsd: 0, unpriced: 0, ceiling: 10, spendCap: 5, exempt: false } }),
    )
    render(<ControlSwitch agent={agent()} />)
    expect(await screen.findByTestId('control-decided')).toHaveTextContent('read new tax law')
    expect(screen.getByTestId('control-measured-30d')).toHaveTextContent('3')
    expect(screen.getByTestId('control-measured')).not.toHaveTextContent('Started')
  })
})

describe('«added outside Silos ›» on a task', () => {
  const KEY = 'folder:/w/x/plans/tasks/tasks/t9'
  it('opening the task reads its origin and never blesses it — the button does', async () => {
    mockedApi.initiative.origin.mockResolvedValue({ key: KEY, by: 'unknown', how: null, outside: true })
    mockedApi.initiative.keep.mockResolvedValue({ blessed: true })
    render(<Marked taskKey={KEY} />)
    const mark = await screen.findByRole('button', { name: 'added outside Silos ›' })
    expect(mockedApi.initiative.origin).toHaveBeenCalledWith(KEY)
    // opening the mark is still only looking
    fireEvent.click(mark)
    expect(mockedApi.initiative.keep).not.toHaveBeenCalled()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: "Keep it — it's mine" }))
    })
    expect(mockedApi.initiative.keep).toHaveBeenCalledWith(KEY)
    expect(screen.queryByTestId('task-origin-outside')).toBeNull()
  })
  it('a known origin has no mark', async () => {
    mockedApi.initiative.origin.mockResolvedValue({ key: KEY, by: 'owner', how: 'owner', outside: false })
    render(<Marked taskKey={KEY} />)
    await waitFor(() => expect(mockedApi.initiative.origin).toHaveBeenCalled())
    expect(screen.queryByTestId('task-origin-outside')).toBeNull()
  })
})

describe('the baseline in Needs you', () => {
  const row = (): InboxRow => ({
    kind: 'plansBaseline',
    key: 'plansBaseline:/proj',
    urgency: 'due',
    at: 0,
    voice: '',
    clears: '',
    folder: '/proj',
    tasks: [
      { key: 'folder:/proj/plans/tasks/tasks/t1', title: 'Close Q3' },
      { key: 'folder:/proj/plans/tasks/tasks/t2', title: 'Old idea' },
    ],
  })
  beforeEach(() => {
    mockedApi.tasks.mockResolvedValue({ sessions: [] })
    mockedApi.automations.list.mockResolvedValue([])
    mockedApi.automations.pending.mockResolvedValue([])
    mockedApi.proposals.list.mockResolvedValue([])
    useStore.setState({
      agents: [agent({ id: 'builder', name: 'Builder', folder: '/proj' })],
      automations: [],
      automationsPending: [],
      nowTick: Date.parse('2026-11-11T12:00:00Z'),
      page: null,
    })
  })
  it('the pulse names it and a project keeps its own', () => {
    expect(headline({ inbox: [row()], working: [], agentName: (id) => id, now: 0, ago: () => '' })).toBe('2 tasks existed before Silos watched this folder.')
    expect(scopeInbox([row()], '/proj', new Set(), 'master')).toHaveLength(1)
    expect(scopeInbox([row()], '/other', new Set(['builder']), 'master')).toHaveLength(0)
  })
  it('Keep them all › opens the list; one left out, the rest kept in one gesture', async () => {
    mockedApi.board.mockResolvedValue({ cards: [], needsYou: [], inbox: [row()] })
    mockedApi.initiative.keepAll.mockResolvedValue({ kept: 1 })
    render(<HomePage />)
    const inbox = await openNeedsYou()
    expect(await within(inbox).findByText('2 tasks existed before Silos watched this folder')).toBeInTheDocument()
    fireEvent.click(within(inbox).getByRole('button', { name: 'Keep them all ›' }))
    const sheet = within(inbox).getByTestId('baseline-sheet')
    fireEvent.click(within(sheet).getByRole('checkbox', { name: 'Keep Old idea' }))
    await act(async () => {
      fireEvent.click(within(sheet).getByRole('button', { name: 'Keep 1 of 2' }))
    })
    expect(mockedApi.initiative.keepAll).toHaveBeenCalledWith('/proj', ['folder:/proj/plans/tasks/tasks/t2'])
  })
})

describe('the max and the spend cap say why', () => {
  const ceilingRow = (): InboxRow => ({
    kind: 'ownTurnsCeiling',
    key: 'own-turns-ceiling:builder',
    urgency: 'due',
    at: 0,
    clears: '',
    voice: 'Builder started 10 times on its own today — its max · 3 wait for tomorrow',
    agentId: 'builder',
    used: 10,
    perDay: 10,
    waiting: 3,
    day: '2026-11-11',
    cap: 'ceiling',
    spentUsd: 0,
    why: '7 task starts · 3 runs of its own automations. The max keeps one agent from spending the day by itself.',
  })
  beforeEach(() => {
    mockedApi.tasks.mockResolvedValue({ sessions: [] })
    mockedApi.automations.list.mockResolvedValue([])
    mockedApi.automations.pending.mockResolvedValue([])
    mockedApi.proposals.list.mockResolvedValue([])
    useStore.setState({
      agents: [agent({ id: 'builder', name: 'Builder', folder: '/proj' })],
      automations: [],
      automationsPending: [],
      nowTick: Date.parse('2026-11-11T12:00:00Z'),
      page: null,
    })
  })
  it("the head, the why under it, and «See today ›» opening that agent's day", async () => {
    mockedApi.board.mockResolvedValue({ cards: [], needsYou: [], inbox: [ceilingRow()] })
    render(<HomePage />)
    const inbox = await openNeedsYou()
    expect(await within(inbox).findByText(/started 10 times on its own today/)).toBeInTheDocument()
    expect(within(inbox).getByText(/7 task starts · 3 runs of its own automations/)).toBeInTheDocument()
    fireEvent.click(within(inbox).getByRole('button', { name: 'See today ›' }))
    expect(useStore.getState().page).toEqual({ kind: 'usage', agent: 'builder', period: 'today' })
  })
  it("Measured says its heartbeat's day apart from the max — empty is no line", () => {
    expect(heartbeatDayLine({ looks: 2, thinks: 0 })).toMatch(/looked twice today/)
    expect(heartbeatDayLine({ looks: 1, thinks: 0 })).toMatch(/looked once today/)
    // a think is a heartbeat's day too (it was counted nowhere)
    expect(heartbeatDayLine({ looks: 0, thinks: 1 })).toBe('Heartbeat: thought once today')
    expect(heartbeatDayLine({ looks: 0, thinks: 0 })).toBeNull()
    expect(heartbeatDayLine({ looks: 0, thinks: 0, rounds: 5 })).toBe('Heartbeat: 5 rounds today')
    expect(heartbeatDayLine(undefined)).toBeNull()
  })
})
