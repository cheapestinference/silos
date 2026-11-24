// automation-editor.test.tsx — "When it runs" as sentences (lib/schedule.ts)
// and the editor creating an automation (/automation/new).
import { beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('../src/lib/api')
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { AutomationsPage } from '../src/components/AutomationsPage'
import { useStore } from '../src/store'
import { api } from '../src/lib/api'
import { stateToRoute, routeToState } from '../src/lib/routes'
import {
  browserTimeZone,
  cronOfDraft,
  defaultDraft,
  draftFromCron,
  draftFromTrigger,
  draftProblem,
  formatNextRuns,
  nextRuns,
  triggerOfDraft,
} from '../src/lib/schedule'
import type { Automation } from '../src/lib/types'

describe('schedule: cron ↔ sentences', () => {
  const base = defaultDraft({ tz: '' })
  const roundTrip = (expr: string) => cronOfDraft(draftFromCron(expr, base))

  it.each([
    ['0 9 * * *', 'daily', { time: '09:00' }],
    ['0 9 * * 1-5', 'weekdays', { time: '09:00' }],
    ['30 6 * * 1', 'weekly', { time: '06:30', weekday: 1 }],
    ['58 0-22/2 * * *', 'hourly', { minute: 58, everyHours: 2, window: { from: 0, to: 22 } }],
    ['0 */4 * * *', 'hourly', { minute: 0, everyHours: 4, window: null }],
    ['15 * * * *', 'hourly', { minute: 15, everyHours: 1, window: null }],
    ['0 8-18 * * *', 'hourly', { minute: 0, everyHours: 1, window: { from: 8, to: 18 } }],
  ])('%s reads as %s and serializes back to itself', (expr, kind, fields) => {
    const d = draftFromCron(expr, base)
    expect(d.kind).toBe(kind)
    expect(d).toMatchObject(fields)
    expect(roundTrip(expr)).toBe(expr)
  })

  it('Sunday as 7 reads as Sunday', () => {
    expect(draftFromCron('0 10 * * 7', base)).toMatchObject({ kind: 'weekly', weekday: 0 })
  })

  it.each(['*/15 * * * *', '0 9 1 * *', '0 9 * * 1,3', '10 9 28 9 *', '70 9 * * *', '0 22-6 * * *', 'every day'])(
    '%s has no sentence: custom, with the expression kept verbatim',
    (expr) => {
      const d = draftFromCron(expr, base)
      expect(d.kind).toBe('custom')
      expect(d.custom).toBe(expr)
      expect(triggerOfDraft(d)).toEqual({ kind: 'cron', expr })
    },
  )

  it('an existing cron keeps its zone; none stays none (the server’s clock) — a new one starts in the browser’s', () => {
    expect(draftFromTrigger({ kind: 'cron', expr: '0 9 * * *', tz: 'Europe/Madrid' }).tz).toBe('Europe/Madrid')
    expect(draftFromTrigger({ kind: 'cron', expr: '0 9 * * *' }).tz).toBe('')
    expect(triggerOfDraft(draftFromTrigger({ kind: 'cron', expr: '0 9 * * *' }))).toEqual({ kind: 'cron', expr: '0 9 * * *' })
    expect(triggerOfDraft(draftFromTrigger({ kind: 'cron', expr: '0 9 * * *', tz: 'Asia/Tokyo' }))).toEqual({
      kind: 'cron',
      expr: '0 9 * * *',
      tz: 'Asia/Tokyo',
    })
    expect(defaultDraft().tz).toBe(browserTimeZone())
  })

  it('a once round-trips through the local date and time', () => {
    const at = new Date(2026, 9, 21, 6, 30).toISOString()
    const d = draftFromTrigger({ kind: 'once', at })
    expect(d).toMatchObject({ kind: 'once', onceDate: '2026-10-21', onceTime: '06:30' })
    expect(triggerOfDraft(d)).toEqual({ kind: 'once', at })
  })

  it('problems are said in words', () => {
    const now = new Date(2026, 9, 20, 12, 0).getTime()
    expect(draftProblem({ ...base, kind: 'once', onceDate: '2026-10-19', onceTime: '09:00' }, now)).toMatch(/already passed/)
    expect(draftProblem({ ...base, kind: 'custom', custom: '0 9 * *' }, now)).toMatch(/five fields/)
    expect(draftProblem({ ...base, kind: 'hourly', everyHours: 0 }, now)).toMatch(/1 to 23/)
    expect(draftProblem({ ...base, kind: 'hourly', window: { from: 20, to: 8 } }, now)).toMatch(/starts before it ends/)
    expect(draftProblem({ ...base, kind: 'daily', tz: 'Mars/Olympus' }, now)).toMatch(/isn’t a time zone/)
    expect(draftProblem({ ...base, kind: 'daily', tz: 'Europe/Madrid' }, now)).toBeNull()
  })
})

describe('schedule: the next runs, read in a zone', () => {
  it('weekdays 06:30 in UTC from Monday 20 Oct 2026 noon', () => {
    const after = Date.UTC(2026, 9, 20, 12, 0)
    const runs = nextRuns('30 6 * * 1-5', 'UTC', after, 3)
    expect(runs.map((t) => new Date(t).toISOString())).toEqual(['2026-10-21T06:30:00.000Z', '2026-10-22T06:30:00.000Z', '2026-10-23T06:30:00.000Z'])
    expect(formatNextRuns(runs, 'UTC')).toBe('Wed 21 Oct 06:30 · Thu 22 · Fri 23')
  })

  it('every 2 hours at :58 in a window says the times of the same day', () => {
    const after = Date.UTC(2026, 9, 20, 12, 0)
    const runs = nextRuns('58 0-22/2 * * *', 'UTC', after, 3)
    expect(formatNextRuns(runs, 'UTC')).toBe('Tue 20 Oct 12:58 · 14:58 · 16:58')
  })

  it('reads the wall clock of the zone, not the browser’s', () => {
    const after = Date.UTC(2026, 9, 20, 12, 0)
    const [first] = nextRuns('0 9 * * *', 'Asia/Tokyo', after, 1)
    expect(new Date(first!).toISOString()).toBe('2026-10-21T00:00:00.000Z') // 09:00 JST
  })

  it('an unknown zone or a broken expression yields nothing (never a guess)', () => {
    expect(nextRuns('0 9 * * *', 'Mars/Olympus', 0)).toEqual([])
    expect(nextRuns('nope', 'UTC', 0)).toEqual([])
  })
})

describe('routes: /automation/new', () => {
  const snap = { selected: null, newChatOpen: false, tab: 'threads' as const, projectTab: 'now' as const }
  it('round-trips with and without an agent; /automation/:id is untouched', () => {
    expect(stateToRoute({ ...snap, page: { kind: 'automation', id: 'new' } })).toBe('/automation/new')
    expect(stateToRoute({ ...snap, page: { kind: 'automation', id: 'new', agent: 'a1' } })).toBe('/automation/new?agent=a1')
    expect(routeToState('/automation/new?agent=a1')).toEqual({ page: { kind: 'automation', id: 'new', agent: 'a1' } })
    expect(routeToState('/automation/new')).toEqual({ page: { kind: 'automation', id: 'new' } })
    expect(routeToState('/automation/digest')).toEqual({ page: { kind: 'automation', id: 'digest' } })
  })
})

describe('the editor, creating (/automation/new)', () => {
  const mocked = vi.mocked(api, { deep: true })
  const created: Automation = {
    id: 'fresh',
    name: 'Check the inbox',
    agentId: 'a1',
    prompt: 'Check the inbox and answer what you can.',
    trigger: { kind: 'cron', expr: '0 9 * * *' },
    thread: { mode: 'new' },
    approval: false,
    keepAlive: false,
    paused: false,
    createdAt: '2026-10-20T00:00:00.000Z',
  }
  beforeEach(() => {
    vi.clearAllMocks()
    mocked.automations.list.mockResolvedValue([created])
    mocked.automations.pending.mockResolvedValue([])
    // the template shelf at the top of /automation/new
    mocked.automationTemplates.list.mockResolvedValue([])
    mocked.automations.runs.mockResolvedValue([])
    useStore.setState({
      page: { kind: 'automation', id: 'new' },
      automations: [],
      automationRuns: [],
      agents: [
        { id: 'a1', name: 'Ana', emoji: '🧠', folder: '/home/u/proj', skills: [], sessions: [], liveCount: 0, sessionCount: 0 },
        { id: 'master', name: 'Master', emoji: '✳', folder: null, skills: [], sessions: [], liveCount: 0, sessionCount: 0 },
        { id: 'old', name: 'Old', emoji: '📦', folder: '/x', skills: [], sessions: [], liveCount: 0, sessionCount: 0, archived: true },
      ],
    })
  })

  it('picks the agent, names itself from the prompt, creates, and lands on the new automation’s page', async () => {
    render(<AutomationsPage />)
    const picker = screen.getByRole('radiogroup', { name: 'Who runs it' })
    expect(
      within(picker)
        .getAllByRole('radio')
        .map((r) => r.textContent),
    ).toEqual(['🧠Ana', '✳Anywhere']) // archived ones aren't offered
    const create = screen.getByRole('button', { name: 'Create automation' })
    expect(create).toBeDisabled()
    expect(screen.getByRole('switch', { name: /If a usage limit hits, wait and retry/ })).toHaveAttribute('aria-checked', 'true')
    fireEvent.change(screen.getByLabelText('What the agent should do'), { target: { value: 'Check the inbox and answer what you can.' } })
    expect(screen.getByLabelText('Automation name')).toHaveValue('Check the inbox and answer what')
    expect(screen.getByTestId('agent-problem')).toHaveTextContent('Pick who runs it.')
    expect(create).toBeDisabled()
    fireEvent.click(within(picker).getByText('Ana'))
    expect(screen.getByTestId('automation-belongs')).toHaveTextContent(/Ana/)
    fireEvent.change(screen.getByLabelText('Automation name'), { target: { value: 'Check the inbox' } })
    mocked.automations.create.mockResolvedValue(created)
    fireEvent.click(create)
    await waitFor(() =>
      expect(mocked.automations.create).toHaveBeenCalledWith({
        name: 'Check the inbox',
        agentId: 'a1',
        prompt: 'Check the inbox and answer what you can.',
        // the period first; its max is the server's to derive
        trigger: { kind: 'period', period: { every: 1, unit: 'days', at: '09:00' } },
        thread: { mode: 'new' },
        approval: false,
        keepAlive: true, // on by default: a usage limit retries at its reset
      }),
    )
    await waitFor(() => expect(useStore.getState().page).toEqual({ kind: 'automation', id: 'fresh' }))
  })

  it('opened from an agent (?agent=a1), that agent is already chosen', () => {
    useStore.setState({ page: { kind: 'automation', id: 'new', agent: 'a1' } })
    render(<AutomationsPage />)
    expect(within(screen.getByRole('radiogroup', { name: 'Who runs it' })).getByRole('radio', { name: /Ana/ })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByLabelText('What the agent should do')).toHaveFocus()
  })

  it("opened from the composer sheet's «More options ›»: the sentence, its schedule and its kept conversation are already there — Create is one click", async () => {
    const { seedNextEditor } = await import('../src/components/automation/AutomationEditor')
    const { draftOfPeriod } = await import('../src/lib/period')
    const { defaultDraft } = await import('../src/lib/schedule')
    seedNextEditor({
      agentId: 'a1',
      name: '',
      prompt: 'Summarize the day.',
      when: 'period',
      period: draftOfPeriod({ every: 2, unit: 'hours' }),
      schedule: defaultDraft(),
      threadMode: 'keep',
      folder: '',
      approval: true,
      keep: { sessionId: 's9' },
    })
    useStore.setState({ page: { kind: 'automation', id: 'new', agent: 'a1' } })
    render(<AutomationsPage />)
    expect(screen.getByLabelText('What the agent should do')).toHaveValue('Summarize the day.')
    expect(screen.getByRole('radio', { name: /Keep one conversation across runs/ })).toBeChecked()
    expect(screen.getByRole('switch', { name: 'Ask me before each run' })).toHaveAttribute('aria-checked', 'true')
    const create = screen.getByRole('button', { name: 'Create automation' })
    expect(create).toBeEnabled()
    mocked.automations.create.mockResolvedValue(created)
    fireEvent.click(create)
    await waitFor(() =>
      expect(mocked.automations.create).toHaveBeenCalledWith(
        expect.objectContaining({
          agentId: 'a1',
          prompt: 'Summarize the day.',
          approval: true,
          trigger: { kind: 'period', period: expect.objectContaining({ every: 2, unit: 'hours' }) },
          thread: { mode: 'keep', sessionId: 's9' },
        }),
      ),
    )
  })

  it('the hand-over is taken once: the next editor opens blank', async () => {
    const { seedNextEditor } = await import('../src/components/automation/AutomationEditor')
    const { draftOfPeriod } = await import('../src/lib/period')
    const { defaultDraft } = await import('../src/lib/schedule')
    seedNextEditor({
      agentId: 'a1',
      name: '',
      prompt: 'Once only.',
      when: 'period',
      period: draftOfPeriod(null),
      schedule: defaultDraft(),
      threadMode: 'new',
      folder: '',
      approval: false,
      keep: null,
    })
    useStore.setState({ page: { kind: 'automation', id: 'new', agent: 'a1' } })
    const first = render(<AutomationsPage />)
    expect(screen.getByLabelText('What the agent should do')).toHaveValue('Once only.')
    first.unmount()
    render(<AutomationsPage />)
    expect(screen.getByLabelText('What the agent should do')).toHaveValue('')
  })

  it('Anywhere keeps one conversation, in a project it must be told', async () => {
    render(<AutomationsPage />)
    fireEvent.click(screen.getByRole('radio', { name: /Anywhere/ }))
    fireEvent.change(screen.getByLabelText('What the agent should do'), { target: { value: 'Tidy the repo.' } })
    expect(screen.getByRole('radio', { name: /Start a new conversation each run/ })).toBeDisabled()
    expect(screen.getByRole('radio', { name: /Keep one conversation across runs/ })).toBeChecked()
    const create = screen.getByRole('button', { name: 'Create automation' })
    expect(create).toBeDisabled()
    fireEvent.change(screen.getByLabelText('In project'), { target: { value: '/home/u/proj' } })
    expect(create).toBeEnabled()
    mocked.automations.create.mockResolvedValue({ ...created, agentId: 'master' })
    fireEvent.click(create)
    await waitFor(() =>
      expect(mocked.automations.create).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'master', thread: { mode: 'keep', folder: '/home/u/proj' } })),
    )
  })

  it("a period says its runs a day, and a new one's max follows it until typed", () => {
    render(<AutomationsPage />)
    expect(screen.getByTestId('schedule-period-consequence')).toHaveTextContent(/one run a day/i)
    fireEvent.change(screen.getByTestId('schedule-period-every'), { target: { value: '15' } })
    fireEvent.click(screen.getByTestId('schedule-period-unit-minutes'))
    expect(screen.getByTestId('schedule-period-consequence')).toHaveTextContent('≈ 96 runs a day')
    expect(screen.getByLabelText('most runs a day')).toHaveValue(96)
    fireEvent.change(screen.getByTestId('schedule-period-every'), { target: { value: '0' } })
    expect(screen.getByTestId('schedule-period-problem')).toHaveTextContent(/whole number, 1 or more/)
  })

  it('a schedule in a set zone previews its next runs — behind «or a cron expression ›»', () => {
    render(<AutomationsPage />)
    fireEvent.click(screen.getByTestId('schedule-to-cron'))
    expect(screen.getByTestId('schedule-preview')).toHaveTextContent(`daily 09:00 · ${browserTimeZone()}`)
    expect(screen.getByTestId('schedule-next').textContent).toMatch(/^\w{3} \d{1,2} \w{3} 09:00 · \w{3} \d{1,2}/)
  })
})
