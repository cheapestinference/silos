// automations-page.test.tsx — the way back from a run to its conversation
// a run's conversation lives under its automation; the run
// history is where you open it when you need to.
import { beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('../src/lib/api')
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { AutomationsPage } from '../src/components/AutomationsPage'
import { useStore } from '../src/store'
import { api } from '../src/lib/api'
import type { Automation, Run } from '../src/lib/types'

const automation: Automation = {
  id: 'digest',
  name: 'Daily digest',
  agentId: 'a1',
  prompt: 'p',
  trigger: { kind: 'cron', expr: '0 9 * * *' },
  thread: { mode: 'new' },
  approval: false,
  keepAlive: false,
  paused: false,
  createdAt: '2026-08-01T00:00:00.000Z',
}
const run = (o: Partial<Run> & Pick<Run, 'id'>): Run => ({ automationId: 'digest', at: '2026-08-29T10:00:00.000Z', status: 'ok', ...o })

beforeEach(() => {
  useStore.setState({
    page: { kind: 'automation', id: 'digest' },
    automations: [automation],
    automationRuns: [run({ id: 'r1', sessionKey: '-home-u-proj/sess-1' }), run({ id: 'r2', status: 'skipped', reason: 'no changes' })],
    agents: [
      {
        id: 'a1',
        name: 'Ana',
        emoji: '🧠',
        mission: { text: 'writer', never: [], updatedAt: '2026-11-10T09:00:00Z' },
        folder: '/home/u/proj',
        skills: [],
        sessions: [],
        liveCount: 0,
        sessionCount: 0,
      },
    ],
    modal: null,
  })
})

describe('AutomationsPage — run history', () => {
  it('a run with a conversation offers "Open conversation" → openSession(folder, id, exact); a run without one does not', () => {
    const openSession = vi.fn().mockResolvedValue(undefined)
    useStore.setState({ openSession })
    render(<AutomationsPage />)
    const buttons = screen.getAllByRole('button', { name: 'Open conversation' })
    expect(buttons).toHaveLength(1)
    fireEvent.click(buttons[0]!)
    expect(openSession).toHaveBeenCalledWith('-home-u-proj', 'sess-1', { exact: true })
  })

  it('the run row itself READS the conversation as a window (readingSession), leaving the page where it is', () => {
    render(<AutomationsPage />)
    fireEvent.click(screen.getByTitle('Read the conversation'))
    expect(useStore.getState().readingSession).toEqual({ folder: '-home-u-proj', id: 'sess-1' })
    expect(useStore.getState().page).toEqual({ kind: 'automation', id: 'digest' })
  })
})

describe('AutomationsPage — the history folds runs with no news', () => {
  const nn = (id: string, at: string) => run({ id, outcome: 'nothing', summary: 'Nothing new.', at })
  it('consecutive no-news runs fold into one quiet row; acted and failed never fold; a click unfolds them', () => {
    useStore.setState({
      automationRuns: [
        run({ id: 'a1', outcome: 'acted', summary: 'Fixed the test.', at: '2026-08-29T12:00:00.000Z' }),
        nn('n1', '2026-08-29T11:00:00.000Z'),
        nn('n2', '2026-08-29T10:00:00.000Z'),
        nn('n3', '2026-08-29T09:00:00.000Z'),
        run({ id: 'f1', status: 'failed', error: 'timeout', at: '2026-08-29T08:00:00.000Z' }),
        nn('n4', '2026-08-29T07:00:00.000Z'),
        nn('n5', '2026-08-29T06:00:00.000Z'),
      ],
    })
    render(<AutomationsPage />)
    const folds = screen.getAllByTestId('runs-no-news-fold')
    expect(folds).toHaveLength(2)
    expect(folds[0]).toHaveTextContent('3 runs with no news')
    expect(folds[1]).toHaveTextContent('2 runs with no news')
    expect(screen.getAllByTestId('run-row')).toHaveLength(2) // acted + failed
    expect(screen.getByText('acted')).toBeInTheDocument()
    expect(screen.getByText('It timed out after 30 min')).toBeInTheDocument()
    fireEvent.click(folds[0]!)
    expect(screen.getAllByTestId('runs-no-news-fold')).toHaveLength(1)
    expect(screen.getAllByTestId('run-row')).toHaveLength(5)
    expect(screen.getAllByText('no news')).toHaveLength(3)
  })
})

// the page is the automation's ONE home: its actions, what
// waits on you, and its kept conversation all live here.
describe('AutomationsPage — actions and what waits on you', () => {
  it('Run now / Pause call the api; Delete asks first', async () => {
    const mocked = vi.mocked(api, { deep: true })
    mocked.automations.runNow.mockResolvedValue({ ok: true })
    mocked.automations.runs.mockResolvedValue([]) // Run now re-reads the history
    mocked.automations.pause.mockResolvedValue({ ...automation, paused: true })
    mocked.automations.delete.mockResolvedValue(undefined)
    render(<AutomationsPage />)
    fireEvent.click(screen.getByText('Run now'))
    await waitFor(() => expect(mocked.automations.runNow).toHaveBeenCalledWith('digest'))
    fireEvent.click(screen.getByText('Pause'))
    await waitFor(() => expect(mocked.automations.pause).toHaveBeenCalledWith('digest'))
    expect(screen.queryByText('Delete')).toBeNull() // apart, in the ⋯
    fireEvent.click(screen.getByLabelText('More actions'))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }))
    expect(mocked.automations.delete).not.toHaveBeenCalled()
    fireEvent.click(screen.getByText('Delete — sure?'))
    await waitFor(() => expect(mocked.automations.delete).toHaveBeenCalledWith('digest'))
  })

  it('a run waiting for approval is answered on the page: Approve / Skip', async () => {
    const mocked = vi.mocked(api, { deep: true })
    mocked.automations.approve.mockResolvedValue({ ok: true })
    useStore.setState({
      automationsPending: [
        run({ id: 'w1', status: 'waiting_approval', promptOverride: 'with the new prices' }),
        run({ id: 'w2', automationId: 'other', status: 'waiting_approval' }),
      ],
    })
    render(<AutomationsPage />)
    const waits = screen.getAllByTestId('automation-approval')
    expect(waits).toHaveLength(1) // only THIS automation's
    expect(waits[0]).toHaveTextContent('with the new prices')
    fireEvent.click(within(waits[0]!).getByText('Approve'))
    await waitFor(() => expect(mocked.automations.approve).toHaveBeenCalledWith('w1'))
  })

  it('a kept thread offers its conversation; the agent link opens the agent page', () => {
    const openSession = vi.fn().mockResolvedValue(undefined)
    useStore.setState({ openSession, automations: [{ ...automation, thread: { mode: 'keep', folder: '-home-u-proj', sessionId: 'kept' } }] })
    render(<AutomationsPage />)
    fireEvent.click(screen.getByText('Open its conversation →'))
    expect(openSession).toHaveBeenCalledWith('-home-u-proj', 'kept')
    fireEvent.click(screen.getByTitle('View agent'))
    expect(useStore.getState().selectedAgentId).toBe('a1')
  })
})

// the header says whose and where in one sentence, what it does in one
// line.
describe('AutomationsPage — belonging, what it does, edit panel', () => {
  const long = { ...automation, prompt: "Summarize yesterday's commits. Then post the digest to the team channel and flag anything risky." }

  it('the belonging sentence: agent → its page, folder → the project page', () => {
    render(<AutomationsPage />)
    const line = screen.getByTestId('automation-belongs')
    expect(line).toHaveTextContent('with')
    // words are flex items (spacing is gap), so the text runs together
    expect(line).toHaveTextContent(/with\s*🧠\s*Ana,\s*writer\s*·\s*in\s*proj/)
    fireEvent.click(within(line).getByTitle('View agent'))
    expect(useStore.getState().selectedAgentId).toBe('a1')
    act(() => useStore.setState({ page: { kind: 'automation', id: 'digest' } }))
    fireEvent.click(screen.getByLabelText('Open project proj'))
    expect(useStore.getState().page).toEqual({ kind: 'project', folder: '/home/u/proj' })
  })

  it('no Runs | Edit tabs: the runs are the body', () => {
    render(<AutomationsPage />)
    expect(screen.queryByRole('button', { name: 'Runs' })).toBeNull()
    expect(screen.getAllByRole('button', { name: 'Open conversation' })).toHaveLength(1)
  })

  it('the prompt shows as its first sentence; "show all" reveals it whole, "less" folds it', () => {
    useStore.setState({ automations: [long] })
    render(<AutomationsPage />)
    const box = screen.getByTestId('automation-prompt')
    expect(box).toHaveTextContent("Summarize yesterday's commits.")
    expect(box).not.toHaveTextContent('flag anything risky')
    fireEvent.click(within(box).getByText('show all'))
    expect(screen.getByTestId('automation-prompt-full')).toHaveTextContent('flag anything risky')
    fireEvent.click(within(box).getByText('less'))
    expect(screen.queryByTestId('automation-prompt-full')).toBeNull()
  })

  it('a one-sentence prompt has nothing more to show', () => {
    useStore.setState({ automations: [{ ...automation, prompt: 'Check the queue.' }] })
    render(<AutomationsPage />)
    expect(screen.getByTestId('automation-prompt')).toHaveTextContent('Check the queue.')
    expect(screen.queryByText('show all')).toBeNull()
  })
})

// editing is a MODE of the page: Edit swaps the runs for the
// editor under the same header; leaving with unsaved changes asks inline.
describe('AutomationsPage — the editor, in place of the runs', () => {
  const mocked = vi.mocked(api, { deep: true })
  beforeEach(() => {
    vi.clearAllMocks()
    mocked.automations.list.mockResolvedValue([automation])
    mocked.automations.pending.mockResolvedValue([])
  })

  function enterEdit(): void {
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
  }

  it('editing keeps the stored keepAlive — the new default (on) is for new automations only', () => {
    mocked.automations.list.mockResolvedValue([{ ...automation, keepAlive: false }])
    useStore.setState({ automations: [{ ...automation, keepAlive: false }] })
    render(<AutomationsPage />)
    enterEdit()
    expect(screen.getByRole('switch', { name: /If a usage limit hits, wait and retry/ })).toHaveAttribute('aria-checked', 'false')
  })

  it('Edit swaps the runs for the editor: the header stays and says "Editing"; Run now / Pause / ⋯ hide; no Notify', () => {
    render(<AutomationsPage />)
    enterEdit()
    expect(screen.getByTestId('automation-editor')).toBeInTheDocument()
    expect(screen.getByLabelText('Automation name')).toHaveValue('Daily digest')
    expect(screen.getByText('Editing')).toBeInTheDocument()
    expect(screen.getByTestId('automation-belongs')).toHaveTextContent(/Ana/)
    expect(screen.getByLabelText('What the agent should do')).toHaveValue('p')
    expect(screen.queryByText('Run now')).toBeNull()
    expect(screen.queryByText('Pause')).toBeNull()
    expect(screen.queryByLabelText('More actions')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Open conversation' })).toBeNull() // the runs are gone
    expect(screen.queryByText(/Notify/)).toBeNull()
    // the schedule opened parsed: "0 9 * * *" is "Every day at 09:00"
    expect(within(screen.getByTestId('schedule-daily')).getByRole('radio')).toBeChecked()
    expect(screen.getByLabelText('time')).toHaveValue('09:00')
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
  })

  it('Esc and Cancel with nothing changed go straight back to the runs', () => {
    render(<AutomationsPage />)
    enterEdit()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByTestId('automation-editor')).toBeNull()
    expect(screen.getAllByRole('button', { name: 'Open conversation' })).toHaveLength(1)
    enterEdit()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByTestId('automation-editor')).toBeNull()
  })

  it('with unsaved changes, Cancel asks once inline: Keep editing stays, Discard goes back to the runs', () => {
    render(<AutomationsPage />)
    enterEdit()
    fireEvent.change(screen.getByLabelText('What the agent should do'), { target: { value: 'Write the digest.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.getByText('Discard changes?')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }))
    expect(screen.queryByText('Discard changes?')).toBeNull()
    expect(screen.getByLabelText('What the agent should do')).toHaveValue('Write the digest.')
    // Esc asks the same way
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.getByText('Discard changes?')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }))
    expect(screen.queryByTestId('automation-editor')).toBeNull()
    expect(screen.getByTestId('automation-prompt')).toHaveTextContent('p') // nothing was saved
  })

  it('with unsaved changes, navigating away is held and asked; Discard lets it through', async () => {
    render(<AutomationsPage />)
    enterEdit()
    fireEvent.change(screen.getByLabelText('What the agent should do'), { target: { value: 'changed' } })
    act(() => useStore.getState().changePage({ kind: 'project', folder: '/home/u/proj' }))
    await screen.findByText('Discard changes?')
    expect(useStore.getState().page).toEqual({ kind: 'automation', id: 'digest' })
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }))
    await waitFor(() => expect(useStore.getState().page).toEqual({ kind: 'project', folder: '/home/u/proj' }))
  })

  // an automation picks what its runs run on — from THE Run on
  // list, saved as runsOn, the agent's default as null
  describe('What it runs on', () => {
    const acct = {
      id: 'default',
      kind: 'claude-account',
      label: 'Claude (this machine)',
      window: null,
      account: { name: 'me', configDir: null, providerId: 'default', loggedIn: true, email: 'me@x.com', plan: 'max', shared: true },
    }
    const CATALOG = [
      { value: 'haiku', displayName: 'Haiku 4.5', resolvedModel: 'claude-haiku-4-5' },
      { value: 'opus', displayName: 'Opus 5', resolvedModel: 'claude-opus-5' },
    ]
    beforeEach(() => {
      mocked.providers.list.mockResolvedValue([acct] as never)
      useStore.setState({ providers: [acct] as never, catalog: CATALOG as never })
    })

    it('a model of its own: saving waits for a pick; the pick is sent as runsOn', async () => {
      render(<AutomationsPage />)
      enterEdit()
      const section = screen.getByTestId('automation-runs-on')
      expect(within(section).getByRole('radio', { name: /Ana’s default/ })).toBeChecked()
      fireEvent.click(within(section).getByRole('radio', { name: /A model of its own/ }))
      expect(within(section).getByTestId('runs-on-problem')).toHaveTextContent('Pick the model above — or keep Ana’s default.')
      expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
      fireEvent.click(within(section).getByRole('menuitemradio', { name: /Haiku 4\.5/ }))
      expect(within(section).queryByTestId('runs-on-problem')).toBeNull()
      expect(within(section).getByRole('radio', { name: /A model of its own — Haiku 4\.5/ })).toBeChecked()
      fireEvent.click(screen.getByRole('button', { name: 'Save' }))
      // a pick in the machine's account group pins that account — never the agent's by stealth
      await waitFor(() =>
        expect(mocked.automations.update).toHaveBeenCalledWith('digest', expect.objectContaining({ runsOn: { provider: 'default', model: 'haiku' } })),
      )
    })

    it('one that has a model of its own says it in the header; back to the default sends null', async () => {
      useStore.setState({ automations: [{ ...automation, runsOn: { model: 'opus' } }] })
      render(<AutomationsPage />)
      expect(screen.getByTestId('automation-cadence')).toHaveTextContent('on Opus 5')
      enterEdit()
      const section = screen.getByTestId('automation-runs-on')
      expect(within(section).getByRole('radio', { name: /A model of its own — Opus 5/ })).toBeChecked()
      fireEvent.click(within(section).getByRole('radio', { name: /Ana’s default/ }))
      fireEvent.click(screen.getByRole('button', { name: 'Save' }))
      await waitFor(() => expect(mocked.automations.update).toHaveBeenCalledWith('digest', expect.objectContaining({ runsOn: null })))
    })
  })

  it('a period chosen in edit lifts the shown max to max(saved, its runs a day) and leaves it to the server — never sent untouched', async () => {
    mocked.automations.update.mockResolvedValue(automation)
    render(<AutomationsPage />)
    enterEdit()
    fireEvent.click(screen.getByTestId('schedule-to-period'))
    fireEvent.change(screen.getByTestId('schedule-period-every'), { target: { value: '10' } })
    fireEvent.click(screen.getByTestId('schedule-period-unit-minutes'))
    expect(screen.getByLabelText('most runs a day')).toHaveValue(144)
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(mocked.automations.update).toHaveBeenCalled())
    const body = mocked.automations.update.mock.calls[0]![1] as Record<string, unknown>
    expect(body.trigger).toEqual({ kind: 'period', period: { every: 10, unit: 'minutes' } })
    expect(body.maxRunsPerDay).toBeUndefined()
  })

  it('Save sends what the sentences say — trigger, thread, approval, keepAlive, a daily ceiling — and returns to the runs', async () => {
    mocked.automations.update.mockResolvedValue({ ...automation, name: 'Weekday digest' })
    render(<AutomationsPage />)
    enterEdit()
    fireEvent.change(screen.getByLabelText('Automation name'), { target: { value: 'Weekday digest' } })
    fireEvent.click(within(screen.getByTestId('schedule-weekdays')).getByRole('radio'))
    fireEvent.change(screen.getByLabelText('time'), { target: { value: '07:30' } })
    fireEvent.click(screen.getByText('Keep one conversation across runs'))
    fireEvent.click(screen.getByRole('switch', { name: 'Ask me before each run' }))
    fireEvent.click(screen.getByRole('switch', { name: 'If a usage limit hits, wait and retry when it resets' }))
    fireEvent.change(screen.getByLabelText('most runs a day'), { target: { value: '6' } })
    expect(screen.getByTestId('schedule-preview')).toHaveTextContent('weekdays 07:30')
    const save = screen.getByRole('button', { name: 'Save' })
    expect(save).toBeEnabled()
    fireEvent.click(save)
    await waitFor(() =>
      expect(mocked.automations.update).toHaveBeenCalledWith('digest', {
        name: 'Weekday digest',
        prompt: 'p',
        trigger: { kind: 'cron', expr: '30 7 * * 1-5' }, // no zone was set: none is invented
        thread: { mode: 'keep' },
        // no notify: retired from the UI — an edit never sends
        // it, so the stored value stays exactly as the file has it
        approval: true,
        keepAlive: true,
        maxRunsPerDay: 6,
        runsOn: null, // the agent's default, said explicitly
      }),
    )
    await waitFor(() => expect(screen.queryByTestId('automation-editor')).toBeNull())
    expect(mocked.automations.list).toHaveBeenCalled() // loadAutomations
  })

  it('a schedule left alone is not sent (its zone and shape stay as saved)', async () => {
    mocked.automations.update.mockResolvedValue(automation)
    render(<AutomationsPage />)
    enterEdit()
    fireEvent.change(screen.getByLabelText('What the agent should do'), { target: { value: 'new words' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(mocked.automations.update).toHaveBeenCalled())
    expect(mocked.automations.update.mock.calls[0]![1]).not.toHaveProperty('trigger')
  })

  it('a server 400 shows under the field it is about and the editor stays open', async () => {
    mocked.automations.update.mockRejectedValue(new Error('invalid cron'))
    render(<AutomationsPage />)
    enterEdit()
    fireEvent.click(within(screen.getByTestId('schedule-custom')).getByRole('radio'))
    fireEvent.change(screen.getByLabelText('cron expression'), { target: { value: '0 9 * * 1,3' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByTestId('schedule-problem')).toHaveTextContent('Invalid cron')
    expect(screen.getByTestId('automation-editor')).toBeInTheDocument()
  })

  it('name and prompt are required, said under each field', () => {
    render(<AutomationsPage />)
    enterEdit()
    fireEvent.change(screen.getByLabelText('Automation name'), { target: { value: '' } })
    fireEvent.change(screen.getByLabelText('What the agent should do'), { target: { value: '  ' } })
    expect(screen.getByTestId('name-problem')).toHaveTextContent('Give it a name.')
    expect(screen.getByTestId('prompt-problem')).toHaveTextContent('Say what the agent should do')
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
  })

  it('a webhook trigger is shown read-only, and never sent back', async () => {
    const hook: Automation = { ...automation, trigger: { kind: 'webhook', secret: 's3cret' } }
    useStore.setState({ automations: [hook] })
    mocked.automations.update.mockResolvedValue(hook)
    render(<AutomationsPage />)
    enterEdit()
    expect(screen.getByText('Set up elsewhere; the schedule can’t be changed here.')).toBeInTheDocument()
    expect(screen.queryByRole('radiogroup', { name: 'When it runs' })).toBeNull()
    fireEvent.change(screen.getByLabelText('What the agent should do'), { target: { value: 'on each call' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(mocked.automations.update).toHaveBeenCalled())
    expect(mocked.automations.update.mock.calls[0]![1]).not.toHaveProperty('trigger')
  })

  it('a kept conversation is one click away from the editor', () => {
    const openSession = vi.fn().mockResolvedValue(undefined)
    useStore.setState({ openSession, automations: [{ ...automation, thread: { mode: 'keep', folder: '-home-u-proj', sessionId: 'kept' } }] })
    render(<AutomationsPage />)
    enterEdit()
    fireEvent.click(screen.getByText('Open its conversation →'))
    expect(openSession).toHaveBeenCalledWith('-home-u-proj', 'kept')
  })
})

// a standing duty's beat (heartbeat-*) runs every beat in a fresh
// conversation: the editor says so instead of
// offering «keep» that reconcile would undo, and the page points at the
// one thread its earlier beats shared, so that history stays in reach
describe('AutomationsPage — the responsibility beat', () => {
  const beat: Automation = { ...automation, id: 'heartbeat-a1', name: 'Responsibility', thread: { mode: 'new' } }
  const br = (o: Partial<Run> & Pick<Run, 'id'>): Run => run({ automationId: 'heartbeat-a1', ...o })
  beforeEach(() => {
    useStore.setState({
      page: { kind: 'automation', id: 'heartbeat-a1' },
      automations: [beat],
      automationRuns: [
        br({ id: 'n3', sessionKey: '-p/fresh-3' }),
        br({ id: 'n2', sessionKey: '-p/fresh-2' }),
        br({ id: 'k2', sessionKey: '-p/old-thread' }),
        br({ id: 'k1', sessionKey: '-p/old-thread' }),
      ],
    })
  })

  it('«Earlier heartbeats ran in one thread — open it ›» opens the thread two or more runs shared', () => {
    const openSession = vi.fn().mockResolvedValue(undefined)
    useStore.setState({ openSession })
    render(<AutomationsPage />)
    fireEvent.click(screen.getByTestId('earlier-beats-thread'))
    expect(openSession).toHaveBeenCalledWith('-p', 'old-thread')
  })

  it('no shared thread → no line; an ordinary automation never shows it', () => {
    useStore.setState({ automationRuns: [br({ id: 'n3', sessionKey: '-p/fresh-3' })] })
    const { unmount } = render(<AutomationsPage />)
    expect(screen.queryByTestId('earlier-beats-thread')).toBeNull()
    unmount()
    useStore.setState({
      page: { kind: 'automation', id: 'digest' },
      automations: [automation],
      automationRuns: [run({ id: 'a', sessionKey: '-p/x' }), run({ id: 'b', sessionKey: '-p/x' })],
    })
    render(<AutomationsPage />)
    expect(screen.queryByTestId('earlier-beats-thread')).toBeNull()
  })
})

// The heartbeat's schedule/prompt/thread are derived (server autonomy.ts
// reconcile; PATCH refuses them with 409) — on its page they are read-only,
// said so — this page IS the check-in's home (runs, Pause); the «In charge
// of» card it once pointed to is gone.
describe('AutomationsPage — a heartbeat (heartbeat-*)', () => {
  const mocked = vi.mocked(api, { deep: true })
  const beat: Automation = { ...automation, id: 'heartbeat-a1', name: 'Responsibility — Ana', prompt: 'You are in charge of: the books', origin: 'agent' }
  beforeEach(() => {
    vi.clearAllMocks()
    mocked.automations.list.mockResolvedValue([beat])
    mocked.automations.pending.mockResolvedValue([])
    useStore.setState({ page: { kind: 'automation', id: 'heartbeat-a1' }, automations: [beat], automationRuns: [] })
  })

  it("the page says where its rhythm is set, with the door there — its agent's control block, never the mission", () => {
    render(<AutomationsPage />)
    const door = screen.getByTestId('beat-schedule-door')
    expect(door.tagName).toBe('BUTTON')
    fireEvent.click(door)
    expect(useStore.getState().page).toEqual({ kind: 'agent', id: beat.agentId })
    expect(useStore.getState().tab).toBe('control')
    expect(screen.queryByText(/In charge of/)).toBeNull()
  })

  // third review round, defect 3: an archived agent's beat has no home
  it("the beat of an agent the web doesn't list (archived) is said paused — no door to In charge of", () => {
    const old: Automation = { ...beat, id: 'heartbeat-old', agentId: 'old' }
    useStore.setState({ page: { kind: 'automation', id: 'heartbeat-old' }, automations: [old] })
    render(<AutomationsPage />)
    expect(screen.queryByTestId('beat-schedule-door')).toBeNull()
    expect(screen.getByTestId('beat-paused')).toHaveTextContent(/archived — its heartbeat stopped/)
    expect(screen.queryByRole('button', { name: /In charge of/ })).toBeNull()
  })

  it('an ordinary automation has no such line', () => {
    useStore.setState({ page: { kind: 'automation', id: 'digest' }, automations: [automation] })
    render(<AutomationsPage />)
    expect(screen.queryByTestId('beat-schedule-door')).toBeNull()
  })

  // a beat lives as long as its responsibility: the server refuses DELETE
  // (409), so the page offers no Delete — the ⋯ held only that
  it('no Delete on a beat: the ⋯ menu is gone; an ordinary automation keeps it', () => {
    render(<AutomationsPage />)
    expect(screen.queryByLabelText('More actions')).toBeNull()
    expect(screen.queryByRole('button', { name: /Delete/ })).toBeNull()
  })

  it("a heartbeat has no Edit and no Pause: its rhythm is set on its agent's page", () => {
    render(<AutomationsPage />)
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Pause' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Run now' })).toBeInTheDocument()
  })
})
