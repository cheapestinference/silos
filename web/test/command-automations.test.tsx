// command-automations.test.tsx — an automation that runs a command, not an
// agent turn: the page's
// belonging sentence and what-it-runs block, the run rows «exit 0 · 4 s ·
// <last line>» with the log opened in place, the list's terminal glyph, the
// editor's Agent turn | Command, and the plain-words helpers behind them.
import { beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('../src/lib/api')
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { AutomationsPage } from '../src/components/AutomationsPage'
import { AutomationsListPage } from '../src/components/AutomationsListPage'
import { RunRow } from '../src/components/RunRow'
import { useStore } from '../src/store'
import { api } from '../src/lib/api'
import { argvLine, argvShort, commandRunLine, explainRunError, lastRunLine, parseArgvLine } from '../src/lib/automations'
import type { AgentView, Automation, Run } from '../src/lib/types'

const mocked = vi.mocked(api, { deep: true })

const finance: AgentView = {
  id: 'finance',
  name: 'Finance',
  emoji: '🧭',
  mission: { text: 'finance', never: [], updatedAt: '2026-11-10T09:00:00Z' },
  folder: '/home/u/acme',
  skills: [],
  sessions: [],
  liveCount: 0,
  sessionCount: 0,
}
const sync: Automation = {
  id: 'sync',
  name: 'Stripe sales → Ledgerly',
  agentId: 'finance',
  prompt: '',
  trigger: { kind: 'cron', expr: '47 5 * * *' },
  thread: { mode: 'new' },
  approval: false,
  keepAlive: false,
  paused: false,
  createdAt: '2026-10-31T00:00:00.000Z',
  run: { kind: 'command', argv: ['/usr/bin/python3', '/home/user/finance/sales_sync.py'], onFailure: 'inbox' },
  runsOn: { model: 'haiku' },
}
const invoices: Automation = {
  ...sync,
  id: 'invoices',
  name: 'Sync silo Invoices',
  prompt: 'If the sync aborts, investigate the dry-run.',
  run: { kind: 'command', argv: ['$SILOS_AGENT_STATE/ledgerly-export/daily-sync.sh'], onFailure: 'agent', okCodes: [0, 4] },
}
const run = (o: Partial<Run> & Pick<Run, 'id'>): Run => ({ automationId: 'sync', at: '2026-10-31T05:47:00.000Z', status: 'ok', ...o })

beforeEach(() => {
  // the template shelf at the top of /automation/new
  mocked.automationTemplates.list.mockResolvedValue([])
  vi.clearAllMocks()
  mocked.automations.list.mockResolvedValue([])
  mocked.automations.pending.mockResolvedValue([])
  mocked.automations.runs.mockResolvedValue([])
  useStore.setState({
    page: { kind: 'automation', id: 'sync' },
    automations: [sync, invoices],
    automationRuns: [],
    automationsPending: [],
    agents: [finance],
    modal: null,
    nowTick: Date.parse('2026-10-31T12:00:00.000Z'),
  })
})

describe('helpers', () => {
  it('parseArgvLine splits on spaces, keeps quoted spaces, expands nothing', () => {
    expect(parseArgvLine('/usr/bin/python3  /a/b.py --since "last week"')).toEqual({ argv: ['/usr/bin/python3', '/a/b.py', '--since', 'last week'] })
    expect(parseArgvLine("sh 'a b' c\\ d $HOME")).toEqual({ argv: ['sh', 'a b', 'c d', '$HOME'] })
    expect(parseArgvLine('echo "unclosed')).toEqual({ error: 'a double quote is never closed' })
    expect(parseArgvLine('   ')).toEqual({ error: 'type the command to run' })
    expect(parseArgvLine('echo ""')).toEqual({ error: 'an empty argument ("") can’t be run' })
  })
  it('argvLine round-trips through parseArgvLine', () => {
    for (const argv of [
      ['a', 'b c', "it's", 'x"y', 'back\\slash'],
      ['/usr/bin/python3', '/x.py'],
    ]) {
      expect(parseArgvLine(argvLine(argv))).toEqual({ argv })
    }
  })
  it('argvShort names paths by their last name', () => {
    expect(argvShort(['/usr/bin/python3', '/home/user/finance/sales_sync.py'])).toBe('python3 sales_sync.py')
    expect(argvShort(['$SILOS_AGENT_STATE/ledgerly-export/daily-sync.sh', '--dry'])).toBe('daily-sync.sh --dry')
  })
  it('a command run reads «exit N · 4 s · last line», a timeout and a failure to start in words', () => {
    const ok = commandRunLine({ exitCode: 0, durationMs: 4200, lastLine: 'synced 3 invoices', logBytes: 40 })
    expect(ok).toContain('0')
    expect(ok).toContain('synced 3 invoices')
    expect(commandRunLine({ timedOut: true, durationMs: 600_000, logBytes: 0 })).toMatch(/timed out/)
    expect(commandRunLine({ error: 'not found: /x', durationMs: 3, logBytes: 0 })).toContain('/x')
    expect(explainRunError({ error: 'timed out after 10 min', command: { timedOut: true, durationMs: 1, logBytes: 0 } }).text).toBe('timed out')
  })
  it('the list says a failed command as itself — never «Timed out after 30 min»', () => {
    expect(lastRunLine({ ...sync, lastRun: { at: 'x', status: 'failed', durationMs: 1, summary: 'boom' }, lastRunError: 'exited 2' })).toEqual({
      text: 'exited 2 · boom',
      failed: true,
    })
    expect(lastRunLine({ ...sync, lastRun: { at: 'x', status: 'failed', durationMs: 1 }, lastRunError: 'timed out after 10 min' })).toEqual({
      text: 'timed out after 10 min',
      failed: true,
    })
  })
})

describe('the automation page', () => {
  it('belongs as «runs `python3 sales_sync.py` · for 🧭 Finance · in acme», the argv whole, «If it fails: tells you», no model', () => {
    render(<AutomationsPage />)
    const belongs = screen.getByTestId('automation-belongs')
    expect(belongs.textContent).toContain('python3 sales_sync.py')
    expect(belongs.textContent).toContain('Finance')
    expect(screen.getByTestId('automation-argv').textContent).toBe('/usr/bin/python3 /home/user/finance/sales_sync.py')
    expect(screen.getByTestId('automation-on-failure').textContent).toMatch(/tells you/)
    // no prompt block, no «on haiku»
    expect(screen.queryByTestId('automation-prompt')).toBeNull()
    expect(screen.getByTestId('automation-cadence').textContent).not.toMatch(/on /)
  })

  it('a hand-over automation says who it goes to, its ok codes, and what it asks', () => {
    useStore.setState({ page: { kind: 'automation', id: 'invoices' } })
    render(<AutomationsPage />)
    expect(screen.getByTestId('automation-on-failure').textContent).toBe('If it fails: hands it to Finance · exit 0, 4 count as done')
    expect(screen.getByTestId('automation-prompt').textContent).toMatch(/What it asks Finance when it fails: If the sync aborts/)
  })

  it('runs read «exit 0 · 4 s · <last line>»; the log opens in place, read from the owner route', async () => {
    mocked.automations.runLog.mockResolvedValue('starting\nsynced 3 invoices\n')
    useStore.setState({
      automationRuns: [
        run({ id: 'r1', exitCode: 0, command: { exitCode: 0, durationMs: 4100, lastLine: 'synced 3 invoices', logBytes: 30 } }),
        run({ id: 'r2', status: 'failed', error: 'exited 2', exitCode: 2, command: { exitCode: 2, durationMs: 900, lastLine: 'boom', logBytes: 5 } }),
      ],
    })
    render(<AutomationsPage />)
    const lines = screen.getAllByTestId('command-run-line').map((x) => x.textContent)
    expect(lines).toEqual(['exit 0 · 4 s · synced 3 invoices', 'exit 2 · <1 s · boom'])
    fireEvent.click(screen.getAllByTestId('command-run-log-toggle')[0]!)
    await waitFor(() => expect(screen.getByTestId('command-run-log').textContent).toBe('starting\nsynced 3 invoices\n'))
    expect(mocked.automations.runLog).toHaveBeenCalledWith('sync', 'r1')
  })

  it('a run that left no log says so', async () => {
    mocked.automations.runLog.mockResolvedValue(null)
    render(
      <ul>
        <RunRow run={run({ id: 'r9', status: 'failed', error: 'not found: /x', command: { error: 'not found: /x', durationMs: 2, logBytes: 0 } })} />
      </ul>,
    )
    fireEvent.click(screen.getByTestId('command-run-log-toggle'))
    await waitFor(() => expect(screen.getByTestId('command-run-log').textContent).toBe('This run left no log.'))
  })

  it('a handed-over run says so, what the turn did, and reads its conversation', () => {
    render(
      <ul>
        <RunRow
          run={run({
            id: 'h',
            handover: true,
            exitCode: 3,
            outcome: 'acted',
            summary: 'reran it',
            sessionKey: '-p/s1',
            command: { exitCode: 3, durationMs: 1000, lastLine: 'aborted', logBytes: 9 },
          })}
        />
      </ul>,
    )
    expect(screen.getByTestId('command-run-line').textContent).toBe('exit 3 · handed over — acted · reran it')
    fireEvent.click(screen.getByRole('button', { name: 'Read the hand-over' }))
    expect(useStore.getState().readingSession).toEqual({ folder: '-p', id: 's1' })
  })
})

describe('the list', () => {
  it('a command row shows a terminal glyph instead of the model, and its argv as the gist', () => {
    useStore.setState({ page: { kind: 'automations' } })
    mocked.board.mockResolvedValue({ cards: [], needsYou: [], inbox: [] })
    render(<AutomationsListPage />)
    const row = screen.getByTestId('automation-row-sync')
    expect(within(row).getByTestId('automation-row-command')).toBeInTheDocument()
    expect(within(row).queryByTestId('automation-row-runs-on')).toBeNull()
    expect(within(row).getByTestId('automation-row-gist').textContent).toBe('python3 sales_sync.py')
  })
})

describe('the editor', () => {
  it('creates a command: one line of argv, where, if it fails — no prompt needed when it only tells you, no model section', async () => {
    useStore.setState({ page: { kind: 'automation', id: 'new', agent: 'finance' }, automations: [] })
    const created = { ...sync, id: 'fresh' }
    mocked.automations.create.mockResolvedValue(created)
    render(<AutomationsPage />)
    fireEvent.click(within(screen.getByRole('radiogroup', { name: 'What it runs' })).getByRole('radio', { name: 'A command' }))
    expect(screen.queryByTestId('automation-runs-on')).toBeNull()
    expect(screen.queryByLabelText('What the agent should do')).toBeNull()
    const create = screen.getByRole('button', { name: 'Create automation' })
    fireEvent.change(screen.getByLabelText('The command'), { target: { value: '/usr/bin/python3 "/home/u/my scripts/sync.py"' } })
    expect(screen.getByLabelText('Automation name')).toHaveValue('sync.py')
    expect(create).toBeEnabled()
    fireEvent.click(create)
    await waitFor(() =>
      expect(mocked.automations.create).toHaveBeenCalledWith({
        name: 'sync.py',
        agentId: 'finance',
        prompt: '',
        trigger: { kind: 'period', period: { every: 1, unit: 'days', at: '09:00' } }, // the period first
        thread: { mode: 'new' },
        approval: false,
        keepAlive: true, // a new automation retries a usage limit by default
        run: { kind: 'command', argv: ['/usr/bin/python3', '/home/u/my scripts/sync.py'], onFailure: 'inbox' },
      }),
    )
  })

  it('handing failures to the agent asks for the prompt; a bad line or folder is said under its field', () => {
    useStore.setState({ page: { kind: 'automation', id: 'new', agent: 'finance' }, automations: [] })
    render(<AutomationsPage />)
    fireEvent.click(screen.getByRole('radio', { name: 'A command' }))
    fireEvent.change(screen.getByLabelText('The command'), { target: { value: 'echo "oops' } })
    fireEvent.blur(screen.getByLabelText('The command'))
    expect(screen.getByTestId('command-problem')).toHaveTextContent('A double quote is never closed.')
    fireEvent.change(screen.getByLabelText('The command'), { target: { value: './sync.sh' } })
    fireEvent.change(screen.getByLabelText('In folder'), { target: { value: 'relative' } })
    expect(screen.getByTestId('cwd-problem')).toHaveTextContent('A full path')
    fireEvent.change(screen.getByLabelText('In folder'), { target: { value: '$SILOS_AGENT_STATE/x' } })
    fireEvent.click(screen.getByRole('radio', { name: /Hand it to Finance/ }))
    expect(screen.getByLabelText('What Finance should do when it fails')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Create automation' })).toBeDisabled()
    fireEvent.change(screen.getByLabelText('What Finance should do when it fails'), { target: { value: 'Find out why.' } })
    expect(screen.getByRole('button', { name: 'Create automation' })).toBeEnabled()
  })

  it('editing a command opens on Command with the argv literal; switching back to an agent turn sends {kind:"agent"}', async () => {
    mocked.automations.update.mockResolvedValue(sync)
    render(<AutomationsPage />)
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    expect(screen.getByRole('radio', { name: 'A command' })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByLabelText('The command')).toHaveValue('/usr/bin/python3 /home/user/finance/sales_sync.py')
    fireEvent.click(screen.getByRole('radio', { name: 'An agent turn' }))
    fireEvent.change(screen.getByLabelText('What the agent should do'), { target: { value: 'Run the sync yourself.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() =>
      expect(mocked.automations.update).toHaveBeenCalledWith('sync', expect.objectContaining({ prompt: 'Run the sync yourself.', run: { kind: 'agent' } })),
    )
  })
})
