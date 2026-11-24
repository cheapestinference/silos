// context-column.test.tsx — ContextColumn.tsx renders its blocks
// conditionally (one per block, a minimal fixture) — one test per block plus
// "Needs you" sending and the collapse↔pill toggle (see also nav-store.test.ts
// for contextOpen in the store).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { ContextColumn } from '../src/components/ContextColumn'
import { AgentPage } from '../src/components/AgentPage'
import { useStore } from '../src/store'
import { api, ApiError, getToken } from '../src/lib/api'
import { setHarnessDescriptors, unknownDescriptor } from '../src/lib/harnesses'
import seed from '../src/lib/harnesses.seed.json'
import { resetTasksCache } from '../src/hooks/useTasks'
import { resetFileRefs } from '../src/lib/file-refs'
import { serverTaskRow } from './server-task-row'
import type {
  Automation,
  AgentView,
  DirEntry,
  FileMeta,
  HarnessDescriptor,
  Run,
  SessionContext,
  SessionDetail,
  SessionView,
  SiloRecordRow,
} from '../src/lib/types'

vi.mock('../src/lib/api')

const mockedApi = vi.mocked(api, { deep: true })
const SEED = seed.harnesses as HarnessDescriptor[]

function makeAgent(overrides: Partial<AgentView> = {}): AgentView {
  return {
    id: 'a1',
    name: 'Ana',
    emoji: '🧠',

    folder: '/x',
    skills: [],
    sessions: [],
    liveCount: 0,
    sessionCount: 0,
    ...overrides,
  }
}

function makeSession(overrides: Partial<SessionView> = {}): SessionView {
  return {
    id: 's1',
    folder: 'f',
    title: 'Session',
    skills: [],
    cwd: null,
    mtime: 0,
    size: 0,
    turnCount: 0,
    live: false,
    worktree: false,
    native: true,
    agentId: 'a1',
    ...overrides,
  }
}

function empty(): SessionContext {
  return {
    plan: null,
    agents: [],
    pending: null,
    links: { prs: [], artifacts: [], worktree: null },
    events: [],
    files: [],
    tools: [],
    flags: { remote: false, permissionMode: null, gitBranch: null, effort: null, model: null },
    waiting: null,
  }
}

function makeDetail(context: SessionContext, extra: Partial<SessionDetail> = {}): SessionDetail {
  return { meta: makeSession(), turns: [], total: 0, context, ...extra }
}

beforeEach(() => {
  vi.clearAllMocks()
  resetFileRefs() // the file service's answers are per test
  // the run-mode line fetches this for any folder-bearing agent as soon as
  // the header mounts (see RunModeLine in ContextColumn.tsx) — a default
  // resolution so tests that don't care about it don't crash on the
  // automock's undefined return; tests that DO care override it themselves.
  // the machinery radius persists on every change — an automocked api
  // returns undefined, which the store's .catch cannot ride.
  mockedApi.patchPrefsContextScope.mockResolvedValue({})
  // a plan is read through the plans silo (lib/plan-record.ts): its record
  // is the one of whatever the mocked file.text holds
  bridgePlanRecords(mockedApi as never)
  useStore.setState({
    chatMode: 'chat',
    agents: [],
    automations: [],
    automationsPending: [],
    nowTick: Date.now(), // tests that pin time set their own — never inherit a sibling's frozen clock
    selectedAgentId: null,
    selected: null,
    detail: null,
    active: null,
    modal: null,
    error: null,
    page: null,
    tab: 'threads',
    contextOpen: true,
    contextScope: 'conversation',
    readingSession: null,
    setupOpen: false,
    convPrefs: {},
    pendingConvPrefs: {},
    turnOverrides: {},
    catalog: [],
  })
})

function makeAutomation(overrides: Partial<Automation> = {}): Automation {
  return {
    id: 'auto1',
    name: 'Morning standup',
    agentId: 'a1',
    prompt: 'p',
    trigger: { kind: 'cron', expr: '0 9 * * 1-5' },
    thread: { mode: 'new' },
    approval: false,
    keepAlive: false,
    paused: false,
    createdAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
  }
}

function makeRun(overrides: Partial<Run> = {}): Run {
  return { id: 'run1', automationId: 'auto1', at: '2026-08-19T09:00:00.000Z', status: 'waiting_approval', ...overrides }
}

// the Automations radius opens on «this conversation» in every conversation
// a test reaches a wider one the way the owner does: the dial
function pickRadius(label: 'this conversation' | 'this agent' | 'this project' | 'everywhere'): void {
  fireEvent.click(screen.getByLabelText(/^Machinery shown for/))
  fireEvent.click(screen.getByRole('menuitem', { name: label }))
}
// what the conversation used lives in one folded block, one line per kind
function openUsed(kind: 'files' | 'tools' | 'links' | 'events'): void {
  fireEvent.click(within(screen.getByTestId('used-here')).getByRole('button', { name: new RegExp(`^${kind}`, 'i') }))
}

describe('ContextColumn — no data', () => {
  it('a NEW conversation paints its agent: what it runs on (the click that picks it), before any message — and no idle status line', () => {
    const agent = makeAgent({ id: 'a1', name: 'Ana', folder: '/home/user/ana' })
    useStore.setState({ agents: [agent], selected: null, detail: null, newChatOpen: true, pendingConvPrefs: {} })
    render(<ContextColumn agent={agent} />)
    expect(screen.getByText('This conversation')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Change what it runs on' })).toBeInTheDocument()
    // not started says nothing live: the status line shows only live work or a wait
    expect(screen.queryByText('Not started')).not.toBeInTheDocument()
    expect(screen.queryByText('No context yet.')).not.toBeInTheDocument()
  })

  it('the agent prop is ignored when no conversation is being started (nothing selected, no new chat)', () => {
    const agent = makeAgent({ id: 'a1', name: 'Ana', folder: '/home/user/ana' })
    useStore.setState({ agents: [agent], selected: null, detail: null, newChatOpen: false })
    render(<ContextColumn agent={agent} />)
    expect(screen.queryByText('Not started')).not.toBeInTheDocument()
  })

  it('with no context, shows the "no context yet" notice and no block', () => {
    useStore.setState({ selected: { folder: 'f', id: 's1' }, detail: { meta: makeSession(), turns: [], total: 0 } })
    render(<ContextColumn />)
    expect(screen.getByText('No context yet.')).toBeInTheDocument()
  })

  it('with context but everything empty, renders no block (just the header)', () => {
    useStore.setState({ selected: { folder: 'f', id: 's1' }, detail: makeDetail(empty()) })
    render(<ContextColumn />)
    expect(screen.queryByText('Needs you')).not.toBeInTheDocument()
    expect(screen.queryByText('Checklist')).not.toBeInTheDocument()
    expect(screen.queryByText('Plan')).not.toBeInTheDocument()
    expect(screen.queryByText('Waiting')).not.toBeInTheDocument()
    expect(screen.queryByText('Links')).not.toBeInTheDocument()
    expect(screen.queryByText('Events')).not.toBeInTheDocument()
    expect(screen.queryByText('Files')).not.toBeInTheDocument()
    expect(screen.queryByText('Tools')).not.toBeInTheDocument()
  })
})

describe('ContextColumn — Needs you', () => {
  it('renders the question and the options; clicking one asks the server first, then sends it as a chat message when no console runs', async () => {
    mockedApi.chat.mockResolvedValue({ turnId: 't1' })
    mockedApi.answer.mockResolvedValue({ engine: 'chat' })
    useStore.setState({
      agents: [makeAgent({ id: 'a1', sessions: [makeSession({ id: 's1', folder: 'f' })] })],
      selectedAgentId: 'a1',
      selected: { folder: 'f', id: 's1' },
      detail: makeDetail({
        ...empty(),
        pending: {
          question: 'Do we go with B or C?',
          options: [{ label: 'B', description: 'the safe option' }, { label: 'C' }],
          askedAt: '2026-08-19T00:00:00Z',
        },
      }),
    })
    render(<ContextColumn />)
    expect(screen.getByText('Do we go with B or C?')).toBeInTheDocument()
    fireEvent.click(screen.getByText('B'))
    await waitFor(() => expect(mockedApi.chat).toHaveBeenCalledWith('a1', 'B', { folder: 'f', id: 's1' }))
    expect(mockedApi.answer).toHaveBeenCalledWith('f', 's1', 0)
  })

  it('when a console runs for the conversation, the server types the answer in and no chat turn is sent', async () => {
    mockedApi.answer.mockResolvedValue({ engine: 'console' })
    useStore.setState({
      agents: [makeAgent({ id: 'a1', sessions: [makeSession({ id: 's1', folder: 'f' })] })],
      selectedAgentId: 'a1',
      selected: { folder: 'f', id: 's1' },
      detail: makeDetail({ ...empty(), pending: { question: 'Go?', options: [{ label: 'Yes' }, { label: 'No' }], askedAt: '2026-08-19T00:00:00Z' } }),
    })
    render(<ContextColumn />)
    fireEvent.click(screen.getByText('No'))
    await waitFor(() => expect(mockedApi.answer).toHaveBeenCalledWith('f', 's1', 1))
    expect(mockedApi.chat).not.toHaveBeenCalled()
  })

  // in the real console Claude's own dialog shows the question
  // (all of them, not just the first) — the column doesn't repeat it there
  it('is not repeated while the conversation is on screen as its console; back in chat it is', () => {
    useStore.setState({
      agents: [makeAgent({ id: 'a1', sessions: [makeSession({ id: 's1', folder: 'f' })] })],
      selectedAgentId: 'a1',
      selected: { folder: 'f', id: 's1' },
      detail: makeDetail({ ...empty(), pending: { question: 'Go?', options: [{ label: 'Yes' }, { label: 'No' }], askedAt: '2026-08-19T00:00:00Z' } }),
      consoleShown: 'f/s1',
    })
    const { rerender } = render(<ContextColumn />)
    expect(screen.queryByText('Needs you')).not.toBeInTheDocument()
    expect(screen.queryByText('Go?')).not.toBeInTheDocument()
    // another conversation's console says nothing about this one
    act(() => useStore.setState({ consoleShown: 'f/other' }))
    rerender(<ContextColumn />)
    expect(screen.getByText('Go?')).toBeInTheDocument()
    act(() => useStore.setState({ consoleShown: null }))
    rerender(<ContextColumn />)
    expect(screen.getByText('Go?')).toBeInTheDocument()
  })

  // two questions in one call must not show only the first
  it('several questions: every one is asked, and all the answers go out as ONE chat message once each has one', async () => {
    mockedApi.chat.mockResolvedValue({ turnId: 't1' })
    mockedApi.answer.mockResolvedValue({ engine: 'chat' }) // Claude: no engine answers a form in place
    useStore.setState({
      agents: [makeAgent({ id: 'a1', sessions: [makeSession({ id: 's1', folder: 'f' })] })],
      selectedAgentId: 'a1',
      selected: { folder: 'f', id: 's1' },
      detail: makeDetail({
        ...empty(),
        pending: {
          question: 'Pass it to the Finance?',
          options: [{ label: 'Investigate' }, { label: 'Fix' }],
          askedAt: '2026-08-19T00:00:00Z',
          more: [{ question: 'Which parts?', multiSelect: true, options: [{ label: 'X' }, { label: 'Y' }, { label: 'Z' }] }],
        },
      }),
    })
    render(<ContextColumn />)
    expect(screen.getByText('Pass it to the Finance?')).toBeInTheDocument()
    expect(screen.getByText('Which parts?')).toBeInTheDocument()
    const send = screen.getByRole('button', { name: 'Send answers' })
    fireEvent.click(screen.getByText('Fix'))
    expect(send).toBeDisabled() // the second one is still unanswered
    fireEvent.click(screen.getByText('X'))
    fireEvent.click(screen.getByText('Z'))
    fireEvent.click(screen.getByText('X')) // multiSelect toggles off
    fireEvent.click(screen.getByText('Y'))
    fireEvent.click(screen.getByText('Investigate')) // single choice replaces
    fireEvent.click(send)
    await waitFor(() =>
      expect(mockedApi.chat).toHaveBeenCalledWith('a1', 'Pass it to the Finance? → Investigate\nWhich parts? → Z, Y', { folder: 'f', id: 's1' }),
    )
    expect(mockedApi.answer).toHaveBeenCalledWith('f', 's1', 0, [['Investigate'], ['Z', 'Y']])
  })

  // OpenCode's question tool: the form's picks are the answer, written for
  // its plugin — no chat turn (one would land beside the still-open question)
  it('several questions answered in place by the engine send no chat turn', async () => {
    mockedApi.answer.mockResolvedValue({ engine: 'ask' })
    useStore.setState({
      agents: [makeAgent({ id: 'a1', sessions: [makeSession({ id: 's1', folder: 'f' })] })],
      selectedAgentId: 'a1',
      selected: { folder: 'f', id: 's1' },
      detail: makeDetail({
        ...empty(),
        pending: {
          question: 'Deploy?',
          options: [{ label: 'Now' }, { label: 'Wait' }],
          askedAt: '2026-11-01T00:00:00Z',
          more: [{ question: 'Where?', options: [{ label: 'eu' }] }],
        },
      }),
    })
    render(<ContextColumn />)
    fireEvent.click(screen.getByText('Wait'))
    fireEvent.click(screen.getByText('eu'))
    fireEvent.click(screen.getByRole('button', { name: 'Send answers' }))
    await waitFor(() => expect(mockedApi.answer).toHaveBeenCalledWith('f', 's1', 0, [['Wait'], ['eu']]))
    expect(mockedApi.chat).not.toHaveBeenCalled()
  })

  // An OpenCode permission ask: the reply file is the answer. A stale ask
  // (answered in the TUI, timed out) is a 404 — never a chat turn with the
  // literal "Allow" sent into a session a live TUI may hold.
  it('an OpenCode ask answered through its reply file sends no chat turn', async () => {
    mockedApi.answer.mockResolvedValue({ engine: 'ask' })
    useStore.setState({
      agents: [makeAgent({ id: 'a1', sessions: [makeSession({ id: 's1', folder: 'f' })] })],
      selectedAgentId: 'a1',
      selected: { folder: 'f', id: 's1' },
      detail: makeDetail({
        ...empty(),
        pending: { question: 'bash rm -rf dist', options: [{ label: 'Allow' }, { label: 'Deny' }], askedAt: '2026-08-19T00:00:00Z' },
      }),
    })
    render(<ContextColumn />)
    fireEvent.click(screen.getByText('Allow'))
    await waitFor(() => expect(mockedApi.answer).toHaveBeenCalledWith('f', 's1', 0))
    expect(mockedApi.chat).not.toHaveBeenCalled()
  })

  it('a failed answer (stale ask: 404) says so in a plain line and sends nothing', async () => {
    mockedApi.answer.mockRejectedValue(Object.assign(new Error('no such ask — already answered or gone'), { status: 404 }))
    useStore.setState({
      agents: [makeAgent({ id: 'a1', sessions: [makeSession({ id: 's1', folder: 'f' })] })],
      selectedAgentId: 'a1',
      selected: { folder: 'f', id: 's1' },
      detail: makeDetail({
        ...empty(),
        pending: { question: 'bash rm -rf dist', options: [{ label: 'Allow' }, { label: 'Deny' }], askedAt: '2026-08-19T00:00:00Z' },
      }),
    })
    render(<ContextColumn />)
    fireEvent.click(screen.getByText('Allow'))
    expect(await screen.findByRole('status')).toHaveTextContent('no such ask — already answered or gone')
    expect(mockedApi.chat).not.toHaveBeenCalled()
  })
})

describe('ContextColumn — Checklist (Claude Code native task list)', () => {
  it('a done/total bar, tasks with a glyph, and a hanging subagent with a live status', () => {
    useStore.setState({
      selectedAgentId: 'a1',
      selected: { folder: 'f', id: 's1' },
      detail: makeDetail({
        ...empty(),
        plan: {
          done: 1,
          total: 2,
          tasks: [
            { id: 't1', subject: 'Read the brief', status: 'completed', createdAt: '2026-08-19T00:00:00Z', durationMs: 65_000, agents: [] },
            { id: 't2', subject: 'Implement', status: 'in_progress', createdAt: '2026-08-19T00:00:00Z', agents: ['sub1'] },
          ],
        },
        agents: [{ id: 'sub1', description: 'code-explorer', type: 'general-purpose', background: false, startedAt: '2026-08-19T00:00:00Z', taskId: 't2' }],
      }),
    })
    render(<ContextColumn />)
    expect(screen.getByText('1/2')).toBeInTheDocument()
    expect(screen.getByText('Read the brief')).toBeInTheDocument()
    expect(screen.getByText('1:05')).toBeInTheDocument()
    expect(screen.getByText('code-explorer')).toBeInTheDocument()
    expect(screen.getByText('live')).toBeInTheDocument()
  })

  it('clicking a subagent opens the read-only panel (GET subagents/:id) with a back button', async () => {
    mockedApi.subagentTranscript.mockResolvedValue({
      turns: [{ index: 0, role: 'assistant', text: 'hi', tools: [], ts: null }],
    })
    useStore.setState({
      selectedAgentId: 'a1',
      selected: { folder: 'f', id: 's1' },
      detail: makeDetail(
        {
          ...empty(),
          plan: { done: 0, total: 1, tasks: [{ id: 't1', subject: 'Task', status: 'in_progress', createdAt: '2026-08-19T00:00:00Z', agents: ['sub1'] }] },
          agents: [
            {
              id: 'sub1',
              description: 'reader',
              type: 'Explore',
              background: false,
              startedAt: '2026-08-19T00:00:00Z',
              endedAt: '2026-08-19T00:01:00Z',
              taskId: 't1',
            },
          ],
        },
        { subagents: [{ id: 'sub1', description: 'reader (census)', type: 'Explore', mtime: Date.now() - 10 * 60_000 }] },
      ),
    })
    render(<ContextColumn />)
    fireEvent.click(screen.getByText('reader'))
    await waitFor(() => expect(mockedApi.subagentTranscript).toHaveBeenCalledWith('f', 's1', 'sub1'))
    // the transcript opens in a MODAL, with the column behind it
    await screen.findByText('hi')
    expect(screen.getByRole('dialog', { name: /Subagent/ })).toBeInTheDocument()
    fireEvent.click(screen.getByLabelText('Close subagent transcript'))
    expect(screen.queryByText('hi')).not.toBeInTheDocument()
    // the column stays mounted behind it (Checklist visible)
    expect(screen.getByText('Checklist')).toBeInTheDocument()
  })
})

// the file-based team plan (plans/*.plan.json, TeamPlanBlock) — titled
// "Plan", distinct from the SDK's own subagent task list above
// (context.plan, titled "Checklist" — see TasksBlock in ContextColumn.tsx).
describe('ContextColumn — Plan (team plan file)', () => {
  it('paints NO plan when the conversation never touched one — even if the project folder has plans', async () => {
    mockedApi.file.dir.mockResolvedValue({ path: '/proj/plans', entries: [{ name: 'other.plan.json', type: 'file', size: 10, mtime: 0 }] })
    mockedApi.file.text.mockResolvedValue(JSON.stringify({ title: 'Other', tasks: [] }))
    useStore.setState({
      agents: [makeAgent({ id: 'finance' })],
      selected: { folder: 'f', id: 's1' },
      detail: { meta: makeSession({ cwd: '/proj' }), turns: [], total: 0, context: empty() },
    })
    render(<ContextColumn />)
    await new Promise((r) => setTimeout(r, 30))
    expect(screen.queryByText('Plan')).not.toBeInTheDocument()
    expect(mockedApi.file.text).not.toHaveBeenCalled()
  })

  it('renders titled "Plan", with the needs-you accent OFF when the only human task is blocked', async () => {
    mockedApi.file.text.mockResolvedValue(
      JSON.stringify({
        title: 'Sprint',
        tasks: [
          { id: 't1', title: 'prep', owner: 'finance', status: 'pending', dependsOn: [] },
          { id: 't2', title: 'approve', owner: 'sam', status: 'blocked', dependsOn: ['t1'] },
        ],
      }),
    )
    useStore.setState({
      agents: [makeAgent({ id: 'finance' })],
      selected: { folder: 'f', id: 's1' },
      detail: {
        meta: makeSession({ cwd: '/proj' }),
        turns: [],
        total: 0,
        context: { ...empty(), files: [{ path: '/proj/plans/sprint.plan.json', edits: 0, writes: 1, reads: 0 }] },
      },
    })
    render(<ContextColumn />)
    await screen.findByText('Sprint')
    const header = screen.getByText('Plan').closest('details')
    expect(header?.className).not.toContain('border-l-terracotta')
  })

  it('turns the needs-you accent ON when a human task is ready (not done, deps met)', async () => {
    mockedApi.file.text.mockResolvedValue(
      JSON.stringify({
        title: 'Sprint',
        tasks: [
          { id: 't1', title: 'prep', owner: 'finance', status: 'done', dependsOn: [] },
          { id: 't2', title: 'approve', owner: 'sam', status: 'pending', dependsOn: ['t1'] },
        ],
      }),
    )
    useStore.setState({
      agents: [makeAgent({ id: 'finance' })],
      selected: { folder: 'f', id: 's1' },
      detail: {
        meta: makeSession({ cwd: '/proj' }),
        turns: [],
        total: 0,
        context: { ...empty(), files: [{ path: '/proj/plans/sprint.plan.json', edits: 0, writes: 1, reads: 0 }] },
      },
    })
    render(<ContextColumn />)
    await screen.findByText('Sprint')
    const header = screen.getByText('Plan').closest('details')
    expect(header?.className).toContain('border-l-terracotta')
  })

  it('re-reads the plan when plansVersion[folder] changes even if meta.mtime did not', async () => {
    mockedApi.file.text.mockResolvedValue(
      JSON.stringify({ title: 'Sprint', tasks: [{ id: 't1', title: 'prep', owner: 'finance', status: 'pending', dependsOn: [] }] }),
    )
    useStore.setState({
      agents: [makeAgent({ id: 'finance' })],
      selected: { folder: 'f', id: 's1' },
      plansVersion: {},
      detail: {
        meta: makeSession({ cwd: '/proj', mtime: 5 }),
        turns: [],
        total: 0,
        context: { ...empty(), files: [{ path: '/proj/plans/sprint.plan.json', edits: 0, writes: 1, reads: 0 }] },
      },
    })
    render(<ContextColumn />)
    await screen.findByText('Sprint')
    expect(mockedApi.file.text).toHaveBeenCalledTimes(1)

    // another folder's plan moving does not re-read this one
    mockedApi.file.text.mockResolvedValue(
      JSON.stringify({ title: 'Sprint v2', tasks: [{ id: 't1', title: 'prep', owner: 'finance', status: 'in_progress', dependsOn: [] }] }),
    )
    act(() => useStore.setState({ plansVersion: { '/elsewhere': 1 } }))
    expect(mockedApi.file.text).toHaveBeenCalledTimes(1)

    act(() => useStore.setState({ plansVersion: { '/elsewhere': 1, '/proj': 1 } }))
    await screen.findByText('Sprint v2')
    expect(mockedApi.file.text).toHaveBeenCalledTimes(2)
    expect(useStore.getState().detail?.meta.mtime).toBe(5)
  })
})

// Several plans touched by one conversation: ALL of them listed — never
// "last touched wins" (context.files is
// insertion-ordered, so re-reading an older plan never brought it to the
// front); plans from ANOTHER folder go in their own section under the
// project's name, never as if this thread owned them.
describe('ContextColumn — Plan with several plan files', () => {
  const planText = (title: string, tasks: unknown[]) => JSON.stringify({ title, tasks })
  const byPath = (map: Record<string, string>) =>
    mockedApi.file.text.mockImplementation(async (p: string) => {
      if (!(p in map)) throw new Error('404')
      return map[p]!
    })

  // One plan in play: the plan waiting on a human is the
  // card; every other plan folds under "N other plans".
  it('the plan waiting on a human is the card, the others fold, and the block accents', async () => {
    byPath({
      '/proj/plans/sprint.plan.json': planText('Sprint', [{ id: 't1', title: 'prep', owner: 'finance', status: 'pending', dependsOn: [] }]),
      '/proj/plans/tax.plan.json': planText('Tax', [{ id: 't1', title: 'sign', owner: 'sam', status: 'pending', dependsOn: [] }]),
    })
    useStore.setState({
      agents: [makeAgent({ id: 'finance' })],
      selected: { folder: 'f', id: 's1' },
      detail: {
        meta: makeSession({ cwd: '/proj' }),
        turns: [],
        total: 0,
        context: {
          ...empty(),
          files: [
            { path: '/proj/plans/sprint.plan.json', edits: 0, writes: 1, reads: 0 },
            { path: '/proj/plans/tax.plan.json', edits: 0, writes: 0, reads: 0, disk: 1 },
          ],
        },
      },
    })
    render(<ContextColumn />)
    await screen.findByTestId('team-plan-tax.plan.json')
    // two named plans: the block is «Plans · 2»
    const header = screen.getByText('Plans').closest('details')
    expect(header?.className).toContain('border-l-terracotta')
    expect(screen.getAllByTestId('team-plan-title').map((el) => el.textContent)).toEqual(['Tax'])
    expect(await screen.findByTestId('team-plan-row-sprint.plan.json')).toHaveTextContent('Sprint')
  })

  // Authorship over territory: a plan this conversation
  // WROTE paints wherever it lives — an agent working on another repo is
  // still the author of that plan. A plan from another folder it only READ
  // stays out (reading around is not work product). A foreign plan carries
  // its home: "in silos ›".
  it('a plan in ANOTHER folder this conversation WROTE paints, marked with its home; one it only READ does not', async () => {
    byPath({
      '/home/u/silos/plans/roadmap.plan.json': JSON.stringify({
        title: 'Roadmap',
        updatedAt: '2026-10-27',
        tasks: [{ id: 't1', title: 'ok', owner: 'finance', status: 'pending', dependsOn: [] }],
      }),
      '/home/u/other/plans/peek.plan.json': planText('Peek', [{ id: 't1', title: 'ok', owner: 'finance', status: 'pending', dependsOn: [] }]),
      '/proj/plans/sprint.plan.json': planText('Sprint', [{ id: 't1', title: 'prep', owner: 'finance', status: 'pending', dependsOn: [] }]),
    })
    useStore.setState({
      agents: [makeAgent({ id: 'finance' }), makeAgent({ id: 'silos', folder: '/home/u/silos' })],
      selected: { folder: 'f', id: 's1' },
      detail: {
        meta: makeSession({ cwd: '/proj' }),
        turns: [],
        total: 0,
        context: {
          ...empty(),
          files: [
            { path: '/proj/plans/sprint.plan.json', edits: 0, writes: 1, reads: 0 },
            { path: '/home/u/silos/plans/roadmap.plan.json', edits: 3, writes: 1, reads: 0 },
            { path: '/home/u/other/plans/peek.plan.json', edits: 0, writes: 0, reads: 1 },
          ],
        },
      },
    })
    render(<ContextColumn />)
    // the newer plan (Roadmap) is the card; Sprint folds; Peek is absent
    const roadmap = await screen.findByTestId('team-plan-roadmap.plan.json')
    expect(screen.getByTestId('team-plan-others')).toHaveTextContent('1 other plan')
    expect(screen.getByTestId('team-plan-row-sprint.plan.json')).toHaveTextContent('Sprint')
    expect(screen.queryByText('Peek')).not.toBeInTheDocument()
    // the foreign plan says where it lives
    expect(roadmap).toHaveTextContent(/in silos/)
  })

  it('a foreign plan mentioned by path in a command (disk touch) counts as written', async () => {
    byPath({ '/home/u/silos/plans/roadmap.plan.json': planText('Roadmap', []) })
    useStore.setState({
      agents: [makeAgent({ id: 'finance' })],
      selected: { folder: 'f', id: 's1' },
      detail: {
        meta: makeSession({ cwd: '/proj' }),
        turns: [],
        total: 0,
        context: { ...empty(), files: [{ path: '/home/u/silos/plans/roadmap.plan.json', edits: 0, writes: 0, reads: 0, disk: 1 }] },
      },
    })
    render(<ContextColumn />)
    await screen.findByText('Roadmap')
    expect(screen.getByTestId('team-plan-roadmap.plan.json')).toHaveTextContent(/in silos/)
  })

  it('only foreign plans READ → no Plan block at all', async () => {
    byPath({ '/home/u/silos/plans/roadmap.plan.json': planText('Roadmap', []) })
    useStore.setState({
      agents: [makeAgent({ id: 'finance' })],
      selected: { folder: 'f', id: 's1' },
      detail: {
        meta: makeSession({ cwd: '/proj' }),
        turns: [],
        total: 0,
        context: { ...empty(), files: [{ path: '/home/u/silos/plans/roadmap.plan.json', edits: 0, writes: 0, reads: 1 }] },
      },
    })
    render(<ContextColumn />)
    await new Promise((r) => setTimeout(r, 30))
    expect(screen.queryByText('Plan')).not.toBeInTheDocument()
  })

  // The whole card is the door to the plan: clicking anywhere on it opens the viewer on
  // THAT file. The two inner actions keep their own meaning — "Done" marks
  // the task, "in silos ›" opens the project — and never also open the plan.
  // A plan is ONE line, and the line is its door (straight to the plan view,
  // without showing the task list) — no task list,
  // no Done in the column: the task is worked where it lives.
  it('the plan line opens its house and shows no task of it', async () => {
    byPath({
      '/home/u/silos/plans/roadmap.plan.json': planText('Roadmap', [{ id: 't1', title: 'sign off', owner: 'sam', status: 'pending', dependsOn: [] }]),
    })
    useStore.setState({
      agents: [makeAgent({ id: 'finance' }), makeAgent({ id: 'silos', folder: '/home/u/silos' })],
      selected: { folder: 'f', id: 's1' },
      detail: {
        meta: makeSession({ cwd: '/proj' }),
        turns: [],
        total: 0,
        context: { ...empty(), files: [{ path: '/home/u/silos/plans/roadmap.plan.json', edits: 1, writes: 0, reads: 0 }] },
      },
    })
    render(<ContextColumn />)
    const line = await screen.findByTestId('team-plan-roadmap.plan.json')
    expect(line).toHaveTextContent('0/1')
    expect(screen.queryByText('sign off')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Done' })).not.toBeInTheDocument()
    fireEvent.click(line)
    await waitFor(() => expect(useStore.getState().page).toMatchObject({ kind: 'tasks', view: 'open', plan: ['folder:/home/u/silos/roadmap'] }))
    expect(mockedApi.file.meta).not.toHaveBeenCalled()
  })

  // A finished plan is hidden unless asked (owner rule): never a card, never
  // folded among the open ones — ONE quiet «✓ N finished ›» line whose door
  // is Tasks › Done (its Plans strip).
  it('a finished plan is no card: the open plan is, and the ✓ line opens Tasks › Done', async () => {
    byPath({
      '/proj/plans/sprint.plan.json': planText('Sprint', [
        { id: 't1', title: 'a', owner: 'finance', status: 'done', dependsOn: [] },
        { id: 't2', title: 'b', owner: 'sam', status: 'done', dependsOn: [] },
      ]),
      '/proj/plans/tax.plan.json': planText('Tax', [{ id: 't1', title: 'prep', owner: 'finance', status: 'pending', dependsOn: [] }]),
    })
    useStore.setState({
      agents: [makeAgent({ id: 'finance' })],
      selected: { folder: 'f', id: 's1' },
      detail: {
        meta: makeSession({ cwd: '/proj' }),
        turns: [],
        total: 0,
        context: {
          ...empty(),
          files: [
            { path: '/proj/plans/sprint.plan.json', edits: 0, writes: 1, reads: 0 },
            { path: '/proj/plans/tax.plan.json', edits: 1, writes: 0, reads: 0 },
          ],
        },
      },
    })
    render(<ContextColumn />)
    const finishedLine = await screen.findByTestId('team-plan-finished')
    expect(finishedLine).toHaveTextContent(/1 finished/)
    // the finished plan is neither a card nor a folded row
    expect(screen.queryByTestId('team-plan-sprint.plan.json')).not.toBeInTheDocument()
    expect(screen.queryByTestId('team-plan-row-sprint.plan.json')).not.toBeInTheDocument()
    expect(screen.queryByTestId('team-plan-others')).not.toBeInTheDocument()
    expect(screen.getByTestId('team-plan-tax.plan.json')).toHaveTextContent('1 open')
    expect(screen.getAllByTestId('team-plan-title').map((el) => el.textContent)).toEqual(['Tax'])
    // the pair names the open plan; the count is its open tasks only
    const header = screen.getByText('Plan').closest('summary')
    expect(header).toHaveTextContent('Tax')
    expect(header?.lastElementChild).toHaveTextContent(/^1$/)
    fireEvent.click(finishedLine)
    await waitFor(() => expect(useStore.getState().page).toMatchObject({ kind: 'tasks', view: 'done' }))
    expect(useStore.getState().page).not.toHaveProperty('plan')
  })

  it('when every plan is finished the block is the ✓ line alone, under its pair title', async () => {
    byPath({
      '/proj/plans/sprint.plan.json': planText('Sprint', [
        { id: 't1', title: 'a', owner: 'finance', status: 'done', dependsOn: [] },
        { id: 't2', title: 'b', owner: 'sam', status: 'done', dependsOn: [] },
      ]),
    })
    useStore.setState({
      agents: [makeAgent({ id: 'finance' })],
      selected: { folder: 'f', id: 's1' },
      detail: {
        meta: makeSession({ cwd: '/proj' }),
        turns: [],
        total: 0,
        context: { ...empty(), files: [{ path: '/proj/plans/sprint.plan.json', edits: 0, writes: 1, reads: 0 }] },
      },
    })
    render(<ContextColumn />)
    expect(await screen.findByTestId('team-plan-finished')).toHaveTextContent(/1 finished/)
    expect(screen.queryAllByTestId('team-plan-title')).toHaveLength(0)
    expect(screen.queryByTestId('team-plan-sprint.plan.json')).not.toBeInTheDocument()
    expect(screen.getByText('Plan').closest('summary')).toHaveTextContent('Sprint')
  })

  it('an unreadable plan is dropped silently while its siblings still render', async () => {
    byPath({ '/proj/plans/sprint.plan.json': planText('Sprint', []) })
    useStore.setState({
      agents: [makeAgent({ id: 'finance' })],
      selected: { folder: 'f', id: 's1' },
      detail: {
        meta: makeSession({ cwd: '/proj' }),
        turns: [],
        total: 0,
        context: {
          ...empty(),
          files: [
            { path: '/proj/plans/gone.plan.json', edits: 0, writes: 0, reads: 0, disk: 1 },
            { path: '/proj/plans/sprint.plan.json', edits: 0, writes: 1, reads: 0 },
          ],
        },
      },
    })
    render(<ContextColumn />)
    await screen.findByText('Sprint')
    expect(screen.getAllByTestId('team-plan-title')).toHaveLength(1)
  })
})

// The column's plans = the plans it AUTHORED ∪ the plans holding a task
// LINKED to it (the server's inverse, the header's own answer): a plan a
// script wrote by a relative path, or another conversation wrote, still
// paints when this conversation works its tasks — once, by path.
describe('ContextColumn — Plan by link', () => {
  const planText = (title: string, tasks: unknown[]) => JSON.stringify({ title, tasks })
  const LINKED = '/home/u/silos/plans/tools.plan.json'
  // the task lists an ANCESTOR of this conversation (a rotation): only the
  // server's thread rule knows s1 works it
  const row = (file: string, plan: string, folder: string) =>
    serverTaskRow({
      key: `folder:${folder}/${plan}/tasks/t1`,
      id: 't1',
      identity: 'wire it',
      state: 'in_progress',
      stateLabel: 'in progress',
      at: null,
      anchors: { folder },
      cells: [],
      row: '',
      folded: false,
      overlay: false,
      conflict: false,
      remarks: [],
      file,
      parent: { key: `folder:${folder}/${plan}`, identity: plan, at: null },
      value: { id: 't1', owner: 'builder', dependsOn: [], conversations: ['root-1'], notes: [] },
      moved: null,
    } as unknown as SiloRecordRow)
  const link = (...lines: Array<{ file: string; plan: string; folder: string }>) => {
    mockedApi.silos.records.mockResolvedValue({
      records: lines.map((l) => row(l.file, l.plan, l.folder)),
      total: lines.length,
      matching: lines.length,
      unreadable: { count: 0 },
    } as never)
    mockedApi.sessionTasks.mockResolvedValue({
      tasks: lines.map((l) => ({
        key: `folder:${l.folder}/${l.plan}/tasks/t1`,
        ref: `${l.plan}#t1`,
        title: 'wire it',
        state: 'in_progress',
        current: true,
        file: l.file,
      })),
    })
  }
  const files = (map: Record<string, string>) =>
    mockedApi.file.text.mockImplementation(async (p: string) => {
      if (!(p in map)) throw new Error('404')
      return map[p]!
    })
  beforeEach(() => {
    resetTasksCache()
  })
  // the link is this block's alone: later cases read no reading and no link
  afterEach(() => {
    mockedApi.silos.records.mockReset()
    mockedApi.sessionTasks.mockReset()
    resetTasksCache()
  })

  it('a plan holding a task linked to the conversation, never authored by it, paints once with its home', async () => {
    files({ [LINKED]: planText('Tools', [{ id: 't1', title: 'wire it', owner: 'builder', status: 'in_progress', dependsOn: [], conversations: ['root-1'] }]) })
    link({ file: LINKED, plan: 'tools', folder: '/home/u/silos' })
    useStore.setState({
      agents: [makeAgent({ id: 'builder' }), makeAgent({ id: 'silos', folder: '/home/u/silos' })],
      selected: { folder: 'f', id: 's1' },
      detail: { meta: makeSession({ cwd: '/proj' }), turns: [], total: 0, context: empty() },
    })
    render(<ContextColumn />)
    const line = await screen.findByTestId('team-plan-tools.plan.json')
    expect(line).toHaveTextContent(/in silos/)
    expect(screen.getAllByTestId('team-plan-title')).toHaveLength(1)
  })

  // the conversation's OWN loose task (a project's-list task it holds) is a
  // row of the Plan block, «<project>#tN · title», marked «no plan»; the
  // project's list itself never paints, and a loose task it does not hold
  // never shows
  it('an own loose task is a row with its ref; the list is no door', async () => {
    const LIST = '/proj/plans/tasks.plan.json'
    files({
      [LIST]: planText('', [
        { id: 't1', title: 'wire it', owner: 'builder', status: 'in_progress', dependsOn: [], conversations: ['root-1'] },
        { id: 't2', title: 'not mine', owner: 'builder', status: 'pending', dependsOn: [] },
      ]),
    })
    link({ file: LIST, plan: 'tasks', folder: '/proj' })
    useStore.setState({
      agents: [makeAgent({ id: 'builder', folder: '/proj' })],
      selected: { folder: 'f', id: 's1' },
      detail: { meta: makeSession({ cwd: '/proj' }), turns: [], total: 0, context: empty() },
    })
    render(<ContextColumn />)
    const row = await screen.findByTestId('team-plan-loose-folder:/proj/tasks/tasks/t1')
    expect(row).toHaveTextContent(/proj#t1/)
    expect(row).toHaveTextContent(/wire it/)
    expect(within(screen.getByTestId('team-plan-block')).queryByText(/not mine/)).not.toBeInTheDocument()
    expect(screen.queryByTestId('column-standing-tasks')).not.toBeInTheDocument()
    fireEvent.click(row)
    await waitFor(() => expect(useStore.getState().page).toMatchObject({ kind: 'task', plan: 'folder:/proj/tasks', task: 't1' }))
  })

  it('a loose task of the list it wrote but does not hold is no row', async () => {
    const LIST = '/proj/plans/tasks.plan.json'
    files({ [LIST]: planText('', [{ id: 't1', title: 'someone else', owner: 'builder', status: 'pending', dependsOn: [], conversations: ['other-1'] }]) })
    mockedApi.sessionTasks.mockResolvedValue({ tasks: [] })
    useStore.setState({
      agents: [makeAgent({ id: 'builder', folder: '/proj' })],
      selected: { folder: 'f', id: 's1' },
      detail: { meta: makeSession({ cwd: '/proj' }), turns: [], total: 0, context: { ...empty(), files: [{ path: LIST, edits: 1, writes: 0, reads: 0 }] } },
    })
    render(<ContextColumn />)
    await waitFor(() => expect(mockedApi.file.text).toHaveBeenCalled())
    expect(screen.queryByText(/someone else/)).not.toBeInTheDocument()
    expect(screen.queryByTestId('team-plan-block')).not.toBeInTheDocument()
  })

  it('an authored plan still paints; a plan only READ does not; authored AND linked is one line', async () => {
    const OWN = '/proj/plans/sprint.plan.json'
    const PEEK = '/home/u/other/plans/peek.plan.json'
    files({
      [LINKED]: planText('Tools', [{ id: 't1', title: 'wire it', owner: 'builder', status: 'in_progress', dependsOn: [], conversations: ['root-1'] }]),
      [OWN]: planText('Sprint', [{ id: 't1', title: 'prep', owner: 'builder', status: 'pending', dependsOn: [] }]),
      [PEEK]: planText('Peek', [{ id: 't1', title: 'ok', owner: 'builder', status: 'pending', dependsOn: [] }]),
    })
    link({ file: LINKED, plan: 'tools', folder: '/home/u/silos' })
    useStore.setState({
      agents: [makeAgent({ id: 'builder' }), makeAgent({ id: 'silos', folder: '/home/u/silos' })],
      selected: { folder: 'f', id: 's1' },
      detail: {
        meta: makeSession({ cwd: '/proj' }),
        turns: [],
        total: 0,
        context: {
          ...empty(),
          files: [
            { path: OWN, edits: 0, writes: 1, reads: 0 },
            { path: LINKED, edits: 2, writes: 0, reads: 0 },
            { path: PEEK, edits: 0, writes: 0, reads: 1 },
          ],
        },
      },
    })
    render(<ContextColumn />)
    await waitFor(() => expect(screen.getAllByTestId(/^team-plan-(row-)?(tools|sprint)\.plan\.json$/)).toHaveLength(2))
    expect(screen.queryByText('Peek')).not.toBeInTheDocument()
  })
})

describe('ContextColumn — Waiting/Links/Events/Files/Tools', () => {
  it("Waiting: the parked state in parkedWords' one voice · since", () => {
    useStore.setState({
      selected: { folder: 'f', id: 's1' },
      detail: makeDetail({ ...empty(), waiting: { kind: 'monitor', since: new Date(Date.now() - 60_000).toISOString(), label: 'PR review' } }),
    })
    render(<ContextColumn />)
    expect(screen.getByText(/Waiting on a monitor — PR review/)).toBeInTheDocument()
  })

  it('Links: PRs, artifacts and a worktree', () => {
    useStore.setState({
      selected: { folder: 'f', id: 's1' },
      detail: makeDetail({
        ...empty(),
        links: {
          prs: [{ number: 42, url: 'https://github.com/x/y/pull/42', repo: 'x/y', ts: '2026-08-19T00:00:00Z' }],
          artifacts: [{ path: 'report.pdf', url: 'https://claude.ai/a/1', ts: '2026-08-19T00:00:00Z' }],
          worktree: { path: '/tmp/wt', name: 'layout' },
        },
      }),
    })
    render(<ContextColumn />)
    openUsed('links')
    expect(screen.getByText('#42 x/y')).toBeInTheDocument()
    expect(screen.getByText('worktree: layout')).toBeInTheDocument()
    // artifacts live in their OWN block (Artifacts), not under Links
    expect(screen.getByText('Artifacts')).toBeInTheDocument()
    expect(screen.getByText('report.pdf').closest('a')).toHaveAttribute('href', 'https://claude.ai/a/1')
  })

  it('Artifacts: the page title links to the URL, the file name rides small; the same URL shows once (latest)', () => {
    useStore.setState({
      selected: { folder: 'f', id: 's1' },
      detail: makeDetail({
        ...empty(),
        links: {
          prs: [],
          worktree: null,
          artifacts: [
            { path: '/tmp/s/plan-bpmn.html', url: 'https://claude.ai/code/artifact/1', ts: '2026-08-26T10:00:00Z', title: 'Migration — map' },
            { path: '/tmp/s/other.html', url: 'https://claude.ai/code/artifact/2', ts: '2026-08-26T10:05:00Z' },
          ],
        },
      }),
    })
    render(<ContextColumn />)
    expect(screen.queryByTestId('used-here')).not.toBeInTheDocument()
    const a = screen.getByText('Migration — map').closest('a')
    expect(a).toHaveAttribute('href', 'https://claude.ai/code/artifact/1')
    expect(a).toHaveAttribute('rel', expect.stringContaining('noopener'))
    expect(screen.getByText('plan-bpmn.html')).toBeInTheDocument()
    expect(screen.getByText('other.html').closest('a')).toHaveAttribute('href', 'https://claude.ai/code/artifact/2')
    expect(screen.getByText('Artifacts').closest('details')?.textContent).toContain('2')
  })

  it('Events: ts + text', () => {
    useStore.setState({
      selected: { folder: 'f', id: 's1' },
      detail: makeDetail({ ...empty(), events: [{ ts: '2026-08-19T00:00:00Z', kind: 'compact', text: 'context compacted' }] }),
    })
    render(<ContextColumn />)
    openUsed('events')
    expect(screen.getByText('context compacted')).toBeInTheDocument()
  })

  it('Files: basename (the full path in the title) + counters', () => {
    useStore.setState({
      selected: { folder: 'f', id: 's1' },
      detail: makeDetail({ ...empty(), files: [{ path: '/home/x/src/store.ts', edits: 2, writes: 1, reads: 3 }] }),
    })
    render(<ContextColumn />)
    openUsed('files')
    expect(screen.getByText('store.ts')).toBeInTheDocument()
    expect(screen.getByTitle('/home/x/src/store.ts')).toBeInTheDocument()
    expect(screen.getByText('written')).toBeInTheDocument()
  })

  it('Tools: server · name · count', () => {
    useStore.setState({
      selected: { folder: 'f', id: 's1' },
      detail: makeDetail({ ...empty(), tools: [{ name: 'search', server: 'context7', count: 5 }] }),
    })
    render(<ContextColumn />)
    openUsed('tools')
    expect(screen.getByText('context7 · search')).toBeInTheDocument()
    expect(screen.getByText('5×')).toBeInTheDocument()
  })
})

// the column is PERMANENT from lg up (no collapse control); the pill only
// matters below lg, or if a persisted contextOpen=false
// from before is still around.
describe('ContextColumn — pill', () => {
  // Context belongs to the CONVERSATION — the pill lives in
  // ConversationView's agent band, not the dossier. The pill only makes
  // sense with a conversation open (`selected`).
  it('AgentPage (a conversation open): with contextOpen=false, the "Context" pill appears and reopens it on click', () => {
    mockedApi.overview.mockResolvedValue({ agents: [], now: 0, warming: false })
    mockedApi.patchPrefsContext.mockResolvedValue({})
    useStore.setState({
      agents: [makeAgent({ id: 'a1', name: 'Ana' })],
      page: { kind: 'agent', id: 'a1' },
      selected: { folder: 'f', id: 's1' },
      detail: makeDetail(empty()),
      contextOpen: false,
    })
    render(<AgentPage />)
    const pill = screen.getByLabelText('context tab')
    expect(pill).toHaveTextContent('Context')
    act(() => fireEvent.click(pill))
    expect(useStore.getState().contextOpen).toBe(true)
    // reopening does NOT leave the conversation for the agent page
    expect(useStore.getState().selected).not.toBeNull()
  })

  it('AgentPage: with contextOpen=true, the pill shows counters (⚑ pending, done/total plan)', () => {
    useStore.setState({
      agents: [makeAgent({ id: 'a1', name: 'Ana' })],
      page: { kind: 'agent', id: 'a1' },
      contextOpen: true,
      selected: { folder: 'f', id: 's1' },
      detail: makeDetail({
        ...empty(),
        pending: { question: '?', options: [{ label: 'yes' }], askedAt: '2026-08-19T00:00:00Z' },
        plan: { done: 2, total: 5, tasks: [] },
      }),
    })
    render(<AgentPage />)
    const pill = screen.getByLabelText('context tab')
    expect(pill).toHaveTextContent('2/5')
    expect(pill).toHaveTextContent('⚑')
  })
})

// the Automations block — the machinery, at a radius the owner chooses
// (contextScope, default 'conversation'). The row itself is unchanged: armed
// dot + countdown + run rail + inline Pause/Resume; what changes is HOW
// MANY rows the block may show, and that it never hides without saying so.
describe('ContextColumn — Automations', () => {
  const NOW = Date.parse('2026-08-27T10:00:00Z')
  const auto = (over: Partial<Automation> = {}): Automation => ({
    id: 'a1',
    name: 'Responsibility — Support',
    agentId: 'a1',
    prompt: 'p',
    trigger: { kind: 'cron', expr: '0 */4 * * *' },
    thread: { mode: 'new' },
    approval: false,
    keepAlive: false,
    paused: false,
    createdAt: '2026-08-25T00:00:00Z',
    nextRunAt: '2026-08-27T11:12:00Z',
    lastRun: { at: '2026-08-27T08:00:00Z', status: 'ok', durationMs: 12 },
    ...over,
  })

  it('an ARMED automation: terracotta dot, trigger + relative countdown, last outcome; the block counts the active ones', () => {
    mockedApi.automations.runs.mockResolvedValue([
      { id: 'r1', automationId: 'a1', at: '2026-08-27T04:00:00Z', status: 'ok' },
      { id: 'r2', automationId: 'a1', at: '2026-08-27T08:00:00Z', status: 'failed' },
    ] as Run[])
    useStore.setState({
      selected: { folder: 'f', id: 's1' },
      nowTick: NOW,
      automations: [auto()],
      detail: { meta: makeSession({ agentId: 'a1' }), turns: [], total: 0, context: empty() },
    })
    render(<ContextColumn />)
    pickRadius('this agent')
    expect(screen.getByText('Automations')).toBeInTheDocument()
    expect(screen.getByTitle('active')).toBeInTheDocument()
    expect(screen.getByText(/next in 1h 12m/)).toBeInTheDocument()
    expect(screen.getByText(/ok ·/)).toBeInTheDocument()
  })

  it('a PAUSED automation is dimmed and says so; with nothing armed the block is honest about it', async () => {
    mockedApi.automations.runs.mockResolvedValue([])
    useStore.setState({
      selected: { folder: 'f', id: 's1' },
      nowTick: NOW,
      automations: [auto({ paused: true })],
      detail: { meta: makeSession({ agentId: 'a1' }), turns: [], total: 0, context: empty() },
    })
    render(<ContextColumn />)
    pickRadius('this agent')
    expect(screen.getByTitle('paused')).toBeInTheDocument()
    expect(screen.getByText(/^paused ·/)).toBeInTheDocument()
    expect(screen.getByText('Nothing armed — every automation is paused.')).toBeInTheDocument()
  })

  it('a DONE once (fired, parked by the resident) says done, offers "Run again" (runNow — never Resume), and the block names it apart from paused', async () => {
    mockedApi.automations.runs.mockResolvedValue([])
    mockedApi.automations.runNow.mockResolvedValue({ ok: true })
    useStore.setState({
      selected: { folder: 'f', id: 's1' },
      nowTick: NOW,
      automations: [auto({ paused: true, trigger: { kind: 'once', at: '2026-08-27T08:00:00Z' }, nextRunAt: undefined })],
      detail: { meta: makeSession({ agentId: 'a1' }), turns: [], total: 0, context: empty() },
    })
    render(<ContextColumn />)
    pickRadius('this agent')
    expect(screen.getByTitle('done')).toBeInTheDocument()
    expect(screen.getByText(/^done ·/)).toBeInTheDocument()
    expect(screen.queryByText(/paused/)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Resume' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Run again' }))
    await waitFor(() => expect(mockedApi.automations.runNow).toHaveBeenCalledWith('a1'))
    expect(screen.getByText('Nothing armed — every automation is done.')).toBeInTheDocument()
  })

  it("the keep-thread automation of THIS conversation is the one the default radius keeps; widened, it still sorts first and says 'runs in this thread'; Pause calls the API", () => {
    mockedApi.automations.runs.mockResolvedValue([])
    mockedApi.automations.update.mockResolvedValue(auto({ paused: true }))
    useStore.setState({
      selected: { folder: 'f', id: 's1' },
      nowTick: NOW,
      automations: [
        auto({ id: 'other', name: 'Other cron' }),
        auto({ id: 'mine', name: 'Keep thread', thread: { mode: 'keep', folder: 'f', sessionId: 's1' } }),
      ],
      detail: { meta: makeSession({ id: 's1', agentId: 'a1' }), turns: [], total: 0, context: empty() },
    })
    render(<ContextColumn />)
    // the default radius: only the automation this conversation IS
    expect(screen.getAllByTitle(/Keep thread|Other cron/).map((el) => el.textContent)).toEqual(['Keep thread'])
    pickRadius('this agent')
    const names = screen.getAllByTitle(/Keep thread|Other cron/).map((el) => el.textContent)
    expect(names[0]).toBe('Keep thread')
    expect(screen.getByText('runs in this thread')).toBeInTheDocument()
    fireEvent.click(screen.getAllByRole('button', { name: 'Pause' })[0]!)
    expect(mockedApi.automations.update).toHaveBeenCalledWith('mine', { paused: true })
  })

  it("another agent's automations never paint at this agent's radius — only 'everywhere' reaches them, and the block says so", () => {
    useStore.setState({
      selected: { folder: 'f', id: 's1' },
      nowTick: NOW,
      automations: [auto({ agentId: 'someone-else', name: 'Not mine' })],
      detail: { meta: makeSession({ agentId: 'a1' }), turns: [], total: 0, context: empty() },
    })
    render(<ContextColumn />)
    pickRadius('this agent')
    expect(screen.queryByText('Not mine')).not.toBeInTheDocument()
    expect(screen.getByTestId('automations-empty-scope')).toBeInTheDocument()
    // and it never hides in silence: the dial reaches it
    fireEvent.click(screen.getByTestId('automations-wider'))
    expect(screen.getByText('Not mine')).toBeInTheDocument()
  })

  // the radius itself: the column is already about the open
  // conversation everywhere else — the machinery now is too, by default,
  // and says what each wider radius would add.
  describe('the radius dial', () => {
    const run = (over: Partial<Automation> = {}) => auto({ id: 'digest', name: 'Daily digest', ...over })
    function seedProject(): void {
      useStore.setState({
        selected: { folder: 'f', id: 's1' },
        nowTick: NOW,
        agents: [makeAgent({ id: 'a1', folder: '/p' }), makeAgent({ id: 'a2', folder: '/p' }), makeAgent({ id: 'a3', folder: '/other' })],
        automations: [run(), auto({ id: 'sibling', name: 'Sibling cron', agentId: 'a2' }), auto({ id: 'far', name: 'Far cron', agentId: 'a3' })],
        detail: {
          meta: makeSession({ id: 's1', agentId: 'a1', cwd: '/p', origin: { kind: 'automation', automationId: 'digest', runId: 'r1' } }),
          turns: [],
          total: 0,
          context: empty(),
        },
      })
    }

    it('by default shows only the automation that produced this conversation, and names what each wider radius adds', () => {
      mockedApi.automations.runs.mockResolvedValue([])
      seedProject()
      render(<ContextColumn />)
      expect(screen.getByText('Daily digest')).toBeInTheDocument()
      expect(screen.queryByText('Sibling cron')).not.toBeInTheDocument()
      expect(screen.getByTestId('automations-wider')).toHaveTextContent('+1')
    })

    it('the dial widens by hand, and the wider radius is never remembered — the next conversation opens on «this conversation»', async () => {
      mockedApi.automations.runs.mockResolvedValue([])
      seedProject()
      const first = render(<ContextColumn />)
      pickRadius('everywhere')
      expect(mockedApi.patchPrefsContextScope).not.toHaveBeenCalled()
      expect(screen.getByLabelText(/^Machinery shown for everywhere/)).toBeInTheDocument()
      first.unmount()
      render(<ContextColumn />)
      expect(screen.getByLabelText(/^Machinery shown for this conversation/)).toBeInTheDocument()
      pickRadius('everywhere')
      expect(screen.getByText('Far cron')).toBeInTheDocument()
      expect(screen.queryByTestId('automations-wider')).toBeNull() // nothing left to hide
    })

    it("on the owner's own conversation the block is empty and honest, and the dial is still there", () => {
      mockedApi.automations.runs.mockResolvedValue([])
      seedProject()
      useStore.setState({ detail: { meta: makeSession({ id: 's1', agentId: 'a1', cwd: '/p' }), turns: [], total: 0, context: empty() } })
      render(<ContextColumn />)
      expect(screen.getByTestId('automations-empty-scope')).toHaveTextContent('No automation produced this conversation.')
      expect(screen.getByTestId('automations-wider')).toHaveTextContent('+1 in this agent')
      expect(screen.getByLabelText(/Machinery shown for this conversation/)).toBeInTheDocument()
    })

    it("a provenance row reports THE run that produced this conversation — never the automation's latest — and rings its tick", async () => {
      mockedApi.automations.runs.mockResolvedValue([
        { id: 'r-new', automationId: 'digest', at: '2026-08-27T04:30:00Z', status: 'ok', durationMs: 1000 },
        { id: 'r1', automationId: 'digest', at: '2026-08-26T04:30:00Z', startedAt: '2026-08-26T04:30:00Z', status: 'failed', durationMs: 351858 },
      ] as Run[])
      seedProject()
      render(<ContextColumn />)
      const line = await screen.findByTestId('automation-this-run')
      expect(line).toHaveTextContent('this run · failed · 5m 52s')
      expect(screen.queryByText(/ok · /)).not.toBeInTheDocument() // the latest run's caption is gone
      expect(document.querySelector('[data-run-id="r1"]')?.className).toContain('ring-terracotta')
      expect(document.querySelector('[data-run-id="r-new"]')?.className).not.toContain('ring-terracotta')
      expect(mockedApi.automations.runs).toHaveBeenCalledWith('digest', 50) // a provenance row asks for deeper history
      expect(screen.getByText('produced this conversation')).toBeInTheDocument()
      expect(screen.queryByText('runs in this thread')).not.toBeInTheDocument()
    })

    it("a keep thread says 'runs in this thread'; a run that produced the conversation says so — never the other's words", () => {
      mockedApi.automations.runs.mockResolvedValue([])
      seedProject()
      useStore.setState({
        automations: [auto({ id: 'keep', name: 'Keep', thread: { mode: 'keep', folder: 'f', sessionId: 's1' } })],
        detail: { meta: makeSession({ id: 's1', agentId: 'a1', cwd: '/p' }), turns: [], total: 0, context: empty() },
      })
      render(<ContextColumn />)
      expect(screen.getByText('runs in this thread')).toBeInTheDocument()
      expect(screen.queryByText('produced this conversation')).not.toBeInTheDocument()
    })

    it('at project / everywhere the rows name their agent; at the agent radius they do not', () => {
      mockedApi.automations.runs.mockResolvedValue([])
      seedProject()
      render(<ContextColumn />)
      pickRadius('everywhere')
      const labels = screen.getAllByTestId('automation-agent').map((el) => el.textContent)
      expect(labels.some((l) => l?.includes('Far cron') === false && l?.includes('A') === true)).toBe(true)
      expect(labels).toHaveLength(3)
      pickRadius('this agent')
      expect(screen.queryAllByTestId('automation-agent')).toHaveLength(0)
    })

    it('beyond the conversation the column summarizes: five rows, then a pointer to the page that holds the rest', () => {
      mockedApi.automations.runs.mockResolvedValue([])
      seedProject()
      useStore.setState({
        automations: Array.from({ length: 7 }, (_, i) => auto({ id: `a${i}`, name: `Cron ${i}`, agentId: 'a1' })),
      })
      const first = render(<ContextColumn />)
      pickRadius('this agent')
      expect(screen.getAllByTestId('automation-row')).toHaveLength(5)
      const seeAll = screen.getByTestId('automations-see-all')
      expect(seeAll).toHaveTextContent('+2 more · all 7 in Automations')
      // the real actions, not mocks — replacing store functions leaks into every later test
      fireEvent.click(seeAll)
      // the rest live on the Automations page, narrowed to this agent
      expect(useStore.getState().page).toEqual({ kind: 'automations', agent: 'a1' })
      first.unmount()
      seedProject()
      useStore.setState({
        page: null,
        selectedAgentId: null,
        automations: Array.from({ length: 7 }, (_, i) => auto({ id: `a${i}`, name: `Cron ${i}`, agentId: 'a1' })),
      })
      render(<ContextColumn />)
      pickRadius('everywhere')
      expect(screen.getByTestId('automations-see-all')).toHaveTextContent('in Automations')
      fireEvent.click(screen.getByTestId('automations-see-all'))
      expect(useStore.getState().page).toEqual({ kind: 'automations' })
    })

    it('at the conversation radius nothing is capped — provenance is one row and it is always shown', () => {
      mockedApi.automations.runs.mockResolvedValue([])
      seedProject()
      render(<ContextColumn />)
      expect(screen.getAllByTestId('automation-row')).toHaveLength(1)
      expect(screen.queryByTestId('automations-see-all')).toBeNull()
    })

    it("the hint counts armed too, in the header's own language", () => {
      mockedApi.automations.runs.mockResolvedValue([])
      seedProject()
      useStore.setState({
        automations: [run(), auto({ id: 'sib1', name: 'Sib armed', agentId: 'a2' }), auto({ id: 'sib2', name: 'Sib paused', agentId: 'a2', paused: true })],
      })
      render(<ContextColumn />)
      expect(screen.getByTestId('automations-wider')).toHaveTextContent('+2 in this project · 1 armed')
    })

    it('the radius menu is keyboard-driven: focus lands on the current radius, arrows walk the list, Home/End jump', () => {
      mockedApi.automations.runs.mockResolvedValue([])
      seedProject()
      render(<ContextColumn />)
      fireEvent.click(screen.getByLabelText(/Machinery shown for this conversation/))
      expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'this conversation' }))
      fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' })
      expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'this agent' }))
      fireEvent.keyDown(document.activeElement!, { key: 'End' })
      expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'everywhere' }))
      fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' })
      expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'this conversation' })) // wraps
      fireEvent.keyDown(document.activeElement!, { key: 'ArrowUp' })
      expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'everywhere' }))
      fireEvent.keyDown(document, { key: 'Escape' })
      expect(screen.queryByRole('menu')).toBeNull()
    })

    it("the automation's name opens its own page", () => {
      mockedApi.automations.runs.mockResolvedValue([])
      seedProject()
      render(<ContextColumn />)
      fireEvent.click(screen.getByText('Daily digest'))
      expect(useStore.getState().page).toEqual({ kind: 'automation', id: 'digest' })
    })

    it('an approval waiting on you is NEVER dialled away — it is not reference material', () => {
      mockedApi.automations.runs.mockResolvedValue([])
      seedProject()
      useStore.setState({
        automationsPending: [{ id: 'p1', automationId: 'sibling', at: '2026-08-27T09:00:00Z', status: 'waiting_approval' } as Run],
        detail: { meta: makeSession({ id: 's1', agentId: 'a2', cwd: '/p' }), turns: [], total: 0, context: empty() },
      })
      render(<ContextColumn />)
      expect(screen.getByText('Sibling cron')).toBeInTheDocument() // in the approvals block, at conversation radius
    })
  })
})

// where a conversation continues from has ONE home — its header
// (AgentPage's ContinuesFrom); the column no longer repeats it.
describe('ContextColumn — no "Earlier in this chain" block', () => {
  it('a continuation shows no chain block in the column', () => {
    const origin = makeSession({ id: 'origin', folder: 'f', title: 'Original thread', agentId: 'a1', mtime: 1_700_000_000_000 - 10_000 })
    const current = makeSession({ id: 'current', folder: 'f', title: 'Current thread', agentId: 'a1', mtime: 1_700_000_000_000, parentKey: 'f/origin' })
    useStore.setState({
      agents: [makeAgent({ id: 'a1', sessions: [origin, current] })],
      selected: { folder: 'f', id: 'current' },
      detail: { meta: current, turns: [], total: 0, context: empty() },
    })
    render(<ContextColumn />)
    expect(screen.queryByText('Earlier in this chain')).not.toBeInTheDocument()
  })
})

// approvals for automations owned by THIS agent — reuses Needs you's visual
// pattern (cards with Approve/Skip), but the source is automationsPending
// (waiting_approval runs), not context.pending.
describe('ContextColumn — Needs approval (reusing the Needs you pattern for automations)', () => {
  it('a pending run from an automation owned by this agent shows with Approve/Skip', async () => {
    mockedApi.automations.approve.mockResolvedValue({ ok: true })
    useStore.setState({
      agents: [makeAgent({ id: 'a1', sessions: [makeSession({ id: 's1', folder: 'f' })] })],
      selected: { folder: 'f', id: 's1' },
      detail: { meta: makeSession(), turns: [], total: 0 },
      automations: [makeAutomation({ id: 'auto1', agentId: 'a1', name: 'Needs it' })],
      automationsPending: [makeRun({ id: 'r1', automationId: 'auto1' })],
    })
    render(<ContextColumn />)
    expect(screen.getByText('Needs approval')).toBeInTheDocument()
    // the name paints in the approval strip AND in the Automations block
    expect(screen.getAllByText('Needs it').length).toBeGreaterThan(0)
    fireEvent.click(screen.getByText('Approve'))
    await waitFor(() => expect(mockedApi.automations.approve).toHaveBeenCalledWith('r1'))
  })

  it("a pending run from ANOTHER agent does not show in this one's column", () => {
    useStore.setState({
      agents: [makeAgent({ id: 'a1', sessions: [makeSession({ id: 's1', folder: 'f' })] })],
      selected: { folder: 'f', id: 's1' },
      detail: { meta: makeSession(), turns: [], total: 0 },
      automations: [makeAutomation({ id: 'auto1', agentId: 'other-agent', name: 'Not mine' })],
      automationsPending: [makeRun({ id: 'r1', automationId: 'auto1' })],
    })
    render(<ContextColumn />)
    expect(screen.queryByText('Needs approval')).not.toBeInTheDocument()
  })
})

// the heavy blocks (Files/Tools/Events) show a preview of the first 5 with
// the TOTAL on the right and "Show all N" that expands into an internally
// scrolling area (the column never grows without end).
describe('ContextColumn — preview/expand for heavy blocks', () => {
  function manyFiles(n: number) {
    return Array.from({ length: n }, (_, i) => ({ path: `/proj/file${i}.ts`, edits: 0, writes: 0, reads: 1 }))
  }

  it('Files with >5 entries: a preview of 5, the total visible, "Show all N" expands the rest', () => {
    useStore.setState({
      selected: { folder: 'f', id: 's1' },
      detail: makeDetail({ ...empty(), files: manyFiles(12) }),
    })
    render(<ContextColumn />)
    expect(screen.getByTestId('used-here').closest('details')).toHaveTextContent('12 files')
    openUsed('files')
    expect(screen.getByText('file0.ts')).toBeInTheDocument()
    expect(screen.getByText('file4.ts')).toBeInTheDocument()
    expect(screen.queryByText('file5.ts')).not.toBeInTheDocument()
    fireEvent.click(screen.getByText('Show all 12'))
    expect(screen.getByText('file11.ts')).toBeInTheDocument()
    expect(screen.getByText('Show less')).toBeInTheDocument()
  })

  it('with ≤5 entries the expand control does not appear', () => {
    useStore.setState({
      selected: { folder: 'f', id: 's1' },
      detail: makeDetail({ ...empty(), files: manyFiles(3) }),
    })
    render(<ContextColumn />)
    expect(screen.queryByText(/Show all/)).not.toBeInTheDocument()
  })
})

// the column's top: how the agent RUNS (model · account, the gear) — never
// its identity, which lives in the sentence under the conversation's title —
// then the Knows block: memory, skills, context files, in charge, each
// summarized and pointing to its section of the agent page, plus a "+" menu.
describe('ContextColumn — runs-on line and the Knows block', () => {
  it("runs-on says «· pinned here» only when this conversation pins provider, model or style — else it is the agent's", () => {
    useStore.setState({
      agents: [makeAgent({ id: 'a1', name: 'Ana', model: 'sonnet', folder: '/home/user/ana' })],
      selected: { folder: 'f', id: 's1' },
      detail: { meta: makeSession({ agentId: 'a1' }), turns: [], total: 0 },
      convPrefs: {},
    })
    const { rerender } = render(<ContextColumn />)
    expect(screen.getByRole('button', { name: 'Change what it runs on' }).textContent).not.toMatch(/pinned here/)
    act(() => {
      useStore.setState({ convPrefs: { model: 'haiku' } })
    })
    rerender(<ContextColumn />)
    expect(screen.getByRole('button', { name: 'Change what it runs on' })).toHaveTextContent(/· pinned here$/)
  })

  it("runs-on: the resolved model and account; no name/role and no door to the agent's Settings here (that is the header's agent menu)", () => {
    useStore.setState({
      agents: [makeAgent({ id: 'a1', name: 'Ana', model: 'sonnet', folder: '/home/user/ana' })],
      selected: { folder: 'f', id: 's1' },
      detail: { meta: makeSession({ agentId: 'a1' }), turns: [], total: 0 },
    })
    render(<ContextColumn />)
    // no catalog in the test store → the id is prettified; the provider is the machine's Claude subscription
    expect(screen.getByRole('button', { name: 'Change what it runs on' })).toHaveTextContent(/Sonnet · Claude subscription/)
    expect(screen.queryByText('designer')).not.toBeInTheDocument()
    expect(screen.queryByText('Be kind.')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Settings/ })).toBeNull()
  })

  it('runs-on re-renders when the engine descriptors load (a third engine read through its descriptor)', () => {
    useStore.setState({
      agents: [makeAgent({ id: 'a1', framework: 'fake' as never })],
      selected: { folder: 'f', id: 's1' },
      detail: makeDetail({ ...empty(), flags: { ...empty().flags, model: 'acme/m-1' } }, { meta: makeSession({ agentId: 'a1', harness: 'fake' as never }) }),
    })
    render(<ContextColumn />)
    const line = () => screen.getByRole('button', { name: 'Change what it runs on' }).textContent
    const before = line()
    const fake = { ...unknownDescriptor('fake'), ui: { ...unknownDescriptor('fake').ui, models: 'provider-model' as const } }
    try {
      act(() => {
        setHarnessDescriptors([...SEED, fake])
      })
      // the provider-model wording, without any store change
      expect(line()).not.toBe(before)
      expect(line()).toContain('m-1')
    } finally {
      act(() => {
        setHarnessDescriptors(SEED)
      })
    }
  })

  it('Knows: the «Its agent» zone says what is its own — every row opens its tab of the agent page', async () => {
    mockedApi.memory.list.mockResolvedValue({
      global: { name: 'CLAUDE.md', path: '/g', scope: 'global', mtime: 0, exists: true, size: 800 },
      project: null,
      autoMemory: [
        { name: 'note.md', path: '/n', scope: 'auto', mtime: 0, exists: true, author: 'a1' },
        { name: 'bea.md', path: '/b', scope: 'auto', mtime: 0, exists: true, author: 'b2' },
      ],
      agent: null,
    })
    mockedApi.context.list.mockResolvedValue({
      shared: [{ name: 'brief.md', path: '/b', scope: 'shared', size: 1, mtime: 0, kind: 'md' }],
      agent: [
        { name: 'spec.md', path: '/s', scope: 'agent', size: 1, mtime: 0, kind: 'md' },
        { name: 'x.md', path: '/x', scope: 'agent', size: 1, mtime: 0, kind: 'md' },
      ],
    } as never)
    mockedApi.context.produced.mockResolvedValue([])
    mockedApi.agents.loaded.mockResolvedValue(null)
    // capability states: the catalog's ACTIVE entries are what it can use
    mockedApi.skillsCatalog.mockResolvedValue([
      { name: 'frontend-design', source: 'user', state: 'active' },
      { name: 'deploy', source: 'user', state: 'active' },
      { name: 'review', source: 'user', state: 'active' },
    ])
    useStore.setState({
      agents: [
        makeAgent({
          id: 'a1',
          name: 'Ana',
          skills: ['frontend-design', 'deploy', 'review'],
          folder: '/home/user/ana',
          mission: { text: 'Keep the queue healthy. Weekly.', never: ['delete data'], updatedAt: '2026-11-10T09:00:00Z' },
        }),
      ],
      selected: { folder: 'f', id: 's1' },
      detail: { meta: makeSession({ agentId: 'a1' }), turns: [], total: 0 },
      knowsDrawer: null,
    })
    let view = render(<ContextColumn />)
    // the per-row detail is covered in knows-block.test.tsx
    await waitFor(() => expect(screen.getByRole('button', { name: 'Open memory' })).toHaveTextContent('1 learned by Ana'))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Open files' })).toHaveTextContent('2 of its own · 0 working'))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Open skills' })).toHaveTextContent('3 it can use'))
    // the estimated «Starts with» bar is gone: the conversation's start is measured in its own zone
    expect(screen.queryByRole('button', { name: 'Open starts with' })).toBeNull()
    // its mission's first line, never the old duty
    expect(await screen.findByText('Keep the queue healthy. · 1 never rule')).toBeInTheDocument()
    expect(mockedApi.memory.list).toHaveBeenCalledWith('/home/user/ana', 'a1')
    // nothing editable here: the column points, the page edits
    expect(screen.queryByText(/Upload/)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'add to what this agent knows' })).not.toBeInTheDocument()
    // every row navigates to the agent page's tab, from this conversation
    const opens: [string, string][] = [
      ['Open memory', 'memory'],
      ['Open files', 'context'],
      ['Open skills', 'skills'],
    ]
    for (const [name, facet] of opens) {
      fireEvent.click(await screen.findByRole('button', { name }))
      expect(useStore.getState().tab).toBe(facet)
      expect(useStore.getState().agentFrom).toEqual({ folder: 'f', id: 's1' })
      expect(useStore.getState().knowsDrawer).toBeNull()
      // back in the conversation (a fresh column, as on the way back)
      view.unmount()
      useStore.setState({
        page: null,
        selectedAgentId: null,
        selected: { folder: 'f', id: 's1' },
        detail: { meta: makeSession({ agentId: 'a1' }), turns: [], total: 0 },
      })
      view = render(<ContextColumn />)
    }
    // Mission opens the drawer's compact panel
    fireEvent.click(await screen.findByRole('button', { name: 'Open mission' }))
    expect(useStore.getState().knowsDrawer).toEqual({ kind: 'mission' })
    expect(useStore.getState().page).toBeNull()
  })

  it('Knows on a conversation: one summary per kind as THIS conversation loads it — no switch, radio or menu; each line opens its agent tab carrying the conversation', async () => {
    const note = (name: string, origin?: string) => ({
      name,
      path: `/m/${name}`,
      scope: 'auto' as const,
      mtime: 0,
      exists: true,
      author: 'a1',
      ...(origin ? { origin } : {}),
    })
    mockedApi.memory.list.mockResolvedValue({
      global: { name: 'CLAUDE.md', path: '/g', scope: 'global', mtime: 0, exists: false },
      project: null,
      autoMemory: [note('a.md', 's1'), note('b.md', 's1'), note('c.md', 'other'), note('d.md')],
      agent: null,
    })
    // told at start = the top level only; a deliverable below is not told to anyone
    mockedApi.context.list.mockResolvedValue({
      shared: [{ name: 'brief.md', rel: 'brief.md', path: '/b', scope: 'shared', size: 1, mtime: 0, kind: 'md' }],
      agent: [
        { name: 'spec.md', rel: 'spec.md', path: '/s', scope: 'agent', size: 1, mtime: 0, kind: 'md' },
        { name: 'r.md', rel: 'reports/r.md', path: '/r', scope: 'agent', size: 1, mtime: 0, kind: 'md' },
      ],
      conversation: [{ name: 'given.pdf', rel: 'given.pdf', path: '/c', scope: 'conversation', size: 1, mtime: 0, kind: 'pdf' }],
    } as never)
    mockedApi.context.produced.mockResolvedValue([])
    mockedApi.agents.loaded.mockResolvedValue(null)
    mockedApi.skillsCatalog.mockResolvedValue([])
    // the conversation's own read: 2 rows load here, one of them is off here alone
    const conv = (entry?: 'on' | 'off', result: 'on' | 'off' = 'on') => ({
      place: 'conversation' as const,
      conversation: 't1',
      agent: 'a1',
      result,
      ...(entry ? { entry } : {}),
    })
    const row = (key: string, line: ReturnType<typeof conv>) => ({
      key,
      engine: 'Claude Code',
      kind: 'mcp',
      name: key,
      label: key,
      exact: true,
      origin: { owner: 'project', carrier: '.mcp.json' },
      state: 'active',
      at: [{ place: 'project', result: 'on' }, line],
    })
    mockedApi.folders.loads.mockResolvedValue({
      folder: '/home/user/ana',
      engines: [],
      rows: [row('a', conv()), row('b', conv()), row('c', conv('off', 'off'))],
      logins: [],
      notes: [],
      conversation: { thread: 't1', agent: 'a1' },
    } as never)
    const meta = makeSession({ agentId: 'a1', cwd: '/home/user/ana' })
    useStore.setState({
      agents: [makeAgent({ id: 'a1', name: 'Ana', folder: '/home/user/ana', sessions: [meta] })],
      selected: { folder: 'f', id: 's1' },
      detail: {
        meta,
        turns: [],
        total: 0,
        context: { ...empty(), files: [{ path: '/home/user/ana/out.md', edits: 0, writes: 1, reads: 0 }], tools: [{ name: 'Bash', server: null, count: 3 }] },
      },
    })
    let view = render(<ContextColumn />)
    let here = await screen.findByTestId('knows-here')
    await waitFor(() => expect(mockedApi.folders.loads).toHaveBeenCalledWith('/home/user/ana', undefined, 's1'))
    await waitFor(() => expect(within(here).getByRole('button', { name: 'Open memory' })).toHaveTextContent(/4 .*2 .*here/))
    await waitFor(() => expect(within(here).getByRole('button', { name: 'Open files' })).toHaveTextContent(/1 .*here.*1 .*here.*2 /))
    await waitFor(() => expect(within(here).getByRole('button', { name: 'Open tools' })).toHaveTextContent(/2 .*1 .*here/))
    // the column points: nothing in Knows switches, picks or unfolds
    expect(within(here).queryAllByRole('switch')).toHaveLength(0)
    expect(within(here).queryAllByRole('radio')).toHaveLength(0)
    expect(within(here).queryAllByRole('menuitem')).toHaveLength(0)
    expect(screen.queryByRole('button', { name: /^Knows shown for/ })).toBeNull()
    for (const b of within(here).getAllByRole('button')) expect(b).not.toHaveAttribute('aria-expanded')
    // every line is a door to its agent's tab, carrying this conversation
    const opens: [string, string][] = [
      ['Open memory', 'memory'],
      ['Open files', 'context'],
      ['Open skills', 'skills'],
      ['Open tools', 'tools'],
    ]
    for (const [name, facet] of opens) {
      fireEvent.click(within(here).getByRole('button', { name }))
      expect(useStore.getState().tab).toBe(facet)
      expect(useStore.getState().agentFrom).toEqual({ folder: 'f', id: 's1' })
      view.unmount()
      useStore.setState({
        page: null,
        selectedAgentId: null,
        selected: { folder: 'f', id: 's1' },
        detail: { meta, turns: [], total: 0, context: { ...empty(), files: [], tools: [] } },
      })
      view = render(<ContextColumn />)
      here = await screen.findByTestId('knows-here')
    }
  })

  it('Knows: nothing learned here → no "here" count', async () => {
    mockedApi.memory.list.mockResolvedValue({
      global: { name: 'CLAUDE.md', path: '/g', scope: 'global', mtime: 0, exists: false },
      project: null,
      autoMemory: [{ name: 'a.md', path: '/m/a.md', scope: 'auto', mtime: 0, exists: true, origin: 'other', author: 'a1' }],
      agent: null,
    })
    mockedApi.context.list.mockResolvedValue({ shared: [], agent: [] })
    mockedApi.context.produced.mockResolvedValue([])
    mockedApi.agents.loaded.mockResolvedValue(null)
    mockedApi.skillsCatalog.mockResolvedValue([])
    useStore.setState({
      agents: [makeAgent({ id: 'a1', name: 'Ana', folder: '/home/user/ana' })],
      selected: { folder: 'f', id: 's1' },
      detail: { meta: makeSession({ agentId: 'a1' }), turns: [], total: 0 },
    })
    render(<ContextColumn />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Open memory' })).toHaveTextContent('1 learned by Ana'))
    expect(screen.getByRole('button', { name: 'Open memory' })).not.toHaveTextContent('here')
  })

  it('Knows: a kind with nothing renders nothing — no placeholders; a folder-less agent never fetches autonomy nor context', async () => {
    mockedApi.memory.list.mockResolvedValue({
      global: { name: 'CLAUDE.md', path: '/g', scope: 'global', mtime: 0, exists: false },
      project: null,
      autoMemory: [],
      agent: null,
    })
    mockedApi.context.list.mockResolvedValue({ shared: [], agent: [] })
    mockedApi.context.produced.mockResolvedValue([])
    mockedApi.agents.loaded.mockResolvedValue(null)
    mockedApi.skillsCatalog.mockResolvedValue([]) // clearAllMocks keeps implementations: don't inherit the previous test's catalog
    useStore.setState({
      agents: [makeAgent({ id: 'master', name: 'Master', folder: null, skills: [] })],
      selected: { folder: 'f', id: 's1' },
      detail: { meta: makeSession({ agentId: 'master' }), turns: [], total: 0 },
    })
    render(<ContextColumn />)
    await waitFor(() => expect(mockedApi.memory.list).toHaveBeenCalled())
    await waitFor(() => expect(mockedApi.skillsCatalog).toHaveBeenCalled())
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
    // the zone is titled, and nothing under it pretends: no row, no «Needs a project folder», no «set a responsibility»
    for (const name of ['Open memory', 'Open files', 'Open skills', 'Open tools', 'Open mission', 'Open starts with']) {
      expect(screen.queryByRole('button', { name })).toBeNull()
    }
    expect(screen.queryByText('Needs a project folder')).not.toBeInTheDocument()
    expect(screen.queryByText('Nothing yet — set a responsibility')).not.toBeInTheDocument()
    expect(mockedApi.context.list).not.toHaveBeenCalled()
    // identity is not the column's job — no "Open Anywhere's page" line
    expect(screen.queryByRole('button', { name: /Open Anywhere/ })).not.toBeInTheDocument()
  })
})

// clicking a file opens the viewer/editor (FileViewer) — a modal with the
// requested path.
describe('ContextColumn — clicking a file opens the viewer', () => {
  function meta(overrides: Partial<FileMeta> = {}): FileMeta {
    return { path: '/proj/note.md', name: 'note.md', ext: '.md', kind: 'markdown', mime: 'text/plain', size: 10, tooLarge: false, editable: true, ...overrides }
  }

  it("clicking the row requests THAT path's metadata and mounts the modal", async () => {
    mockedApi.file.meta.mockResolvedValue(meta())
    mockedApi.file.text.mockResolvedValue('# hi\n')
    useStore.setState({
      selected: { folder: 'f', id: 's1' },
      detail: makeDetail({ ...empty(), files: [{ path: '/proj/note.md', edits: 1, writes: 0, reads: 0 }] }),
    })
    render(<ContextColumn />)
    openUsed('files')
    fireEvent.click(screen.getByText('note.md'))
    await waitFor(() => expect(mockedApi.file.meta).toHaveBeenCalledWith('/proj/note.md'))
    expect(await screen.findByRole('dialog')).toBeInTheDocument()
  })
})

// every file a conversation used gets the right door (file-refs
// usedFileDoor): the one viewer for a file that is there — a memory note
// too, never the memory-only reader — the cwd's file for a relative path,
// and no click at all for a file that is gone
describe('ContextColumn — the door of a used file', () => {
  function meta(path: string): FileMeta {
    return { path, name: path.slice(path.lastIndexOf('/') + 1), ext: '.md', kind: 'markdown', mime: 'text/plain', size: 10, tooLarge: false, editable: true }
  }
  it('opens a memory note and a relative path in the file viewer; a gone file is no button', async () => {
    const note = '/home/user/.claude/projects/-proj/memory/feedback_x.md'
    mockedApi.file.meta.mockImplementation(async (p: string) => {
      if (p === '/proj/gone.png') throw new ApiError('file not found', 404, {})
      return meta(p)
    })
    mockedApi.file.text.mockResolvedValue('# hi\n')
    useStore.setState({
      selected: { folder: 'f', id: 's1' },
      detail: {
        meta: makeSession({ cwd: '/proj' }),
        turns: [],
        total: 0,
        context: {
          ...empty(),
          files: [
            { path: note, edits: 1, writes: 0, reads: 0 },
            { path: 'out/report.md', edits: 0, writes: 1, reads: 0 },
            { path: '/proj/gone.png', edits: 0, writes: 0, reads: 1 },
          ],
        },
      },
    })
    render(<ContextColumn />)
    openUsed('files')
    // the gone file: answered 404 → not a door
    await waitFor(() => expect(screen.getByText('gone.png').closest('button')).toBeNull())
    fireEvent.click(screen.getByText('feedback_x.md'))
    expect(await screen.findByRole('dialog')).toBeInTheDocument()
    expect(mockedApi.memory.read).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: /close/i }))
    fireEvent.click(screen.getByText('report.md'))
    await waitFor(() => expect(mockedApi.file.text).toHaveBeenCalledWith('/proj/out/report.md'))
    expect(mockedApi.file.meta).not.toHaveBeenCalledWith('out/report.md')
  })
})

// the Knows block says the agent's MISSION (its first
// sentence) where the old duty's «In charge» line and its run-mode words
// were — the responsibility is never shown, and the column polls no beat.
describe('ContextColumn — the mission row', () => {
  const setup = (agent: Partial<AgentView>): void => {
    mockedApi.memory.list.mockResolvedValue({
      global: { name: 'CLAUDE.md', path: '/g', scope: 'global', mtime: 0, exists: false },
      project: null,
      autoMemory: [],
      agent: null,
    })
    mockedApi.context.list.mockResolvedValue({ shared: [], agent: [] })
    mockedApi.context.produced.mockResolvedValue([])
    mockedApi.agents.loaded.mockResolvedValue(null)
    mockedApi.skillsCatalog.mockResolvedValue([])
    useStore.setState({
      agents: [makeAgent({ id: 'a1', name: 'Ana', folder: '/home/user/ana', ...agent })],
      selected: { folder: 'f', id: 's1' },
      detail: { meta: makeSession({ agentId: 'a1' }), turns: [], total: 0 },
      knowsDrawer: null,
    })
  }
  it('a mission without rules: its first sentence, alone', async () => {
    setup({ mission: { text: 'Answers the support inbox. Every day.', never: [], updatedAt: '2026-11-10T09:00:00Z' } })
    render(<ContextColumn />)
    expect(await screen.findByRole('button', { name: 'Open mission' })).toHaveTextContent('Answers the support inbox.')
    expect(screen.getByRole('button', { name: 'Open mission' })).not.toHaveTextContent('Every day')
  })
  it('no mission: no row — and an old responsibility is never said', async () => {
    setup({})
    render(<ContextColumn />)
    await waitFor(() => expect(mockedApi.memory.list).toHaveBeenCalled())
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(screen.queryByRole('button', { name: 'Open mission' })).toBeNull()
    expect(screen.queryByText(/keep the books current/)).not.toBeInTheDocument()
    expect(screen.queryByText(/In charge|Check-in|On a mission/)).not.toBeInTheDocument()
  })
})

describe("ContextColumn — scope: only the conversation's own project", () => {
  it('Files lists only paths inside the conversation cwd; foreign-project paths are cut; SendUserFile deliverables stay', () => {
    useStore.setState({
      selected: { folder: 'f', id: 's1' },
      detail: {
        meta: makeSession({ cwd: '/proj' }),
        turns: [],
        total: 0,
        context: {
          ...empty(),
          files: [
            { path: '/proj/src/app.ts', edits: 1, writes: 0, reads: 2 },
            { path: '/other/context/shared/foreign.pdf', edits: 0, writes: 0, reads: 1 },
            { path: '/tmp/scratch/report.pdf', edits: 0, writes: 0, reads: 0, sent: 1 },
          ],
        },
      },
    })
    render(<ContextColumn />)
    openUsed('files')
    expect(screen.getByText('app.ts')).toBeInTheDocument()
    expect(screen.getByText('report.pdf')).toBeInTheDocument()
    expect(screen.queryByText('foreign.pdf')).not.toBeInTheDocument()
  })

  it("a deliverable the conversation WROTE outside any project (home, scratchpad) paints; written files in ANOTHER project's folder stay out", () => {
    useStore.setState({
      selected: { folder: 'f', id: 's1' },
      agents: [makeAgent({ id: 'other', folder: '/otherproj' })],
      detail: {
        meta: makeSession({ cwd: '/proj' }),
        turns: [],
        total: 0,
        context: {
          ...empty(),
          files: [
            { path: '/home/u/david-reply.txt', edits: 5, writes: 2, reads: 0 },
            { path: '/tmp/scratch/draft-v2.md', edits: 0, writes: 1, reads: 0 },
            { path: '/otherproj/src/tool.py', edits: 0, writes: 1, reads: 0 },
            { path: '/home/u/random-read.txt', edits: 0, writes: 0, reads: 3 },
          ],
        },
      },
    })
    render(<ContextColumn />)
    openUsed('files')
    expect(screen.getByText('david-reply.txt')).toBeInTheDocument()
    expect(screen.getByText('draft-v2.md')).toBeInTheDocument()
    expect(screen.queryByText('tool.py')).not.toBeInTheDocument()
    expect(screen.queryByText('random-read.txt')).not.toBeInTheDocument()
  })
})

// --- the disk census of background work (detail.subagents) -----------------
//
// A backgrounded skill (code-review, a Workflow) spawns agents whose
// transcripts live under <session>/subagents/ — the main turn CLOSES while
// they work. The column must say Working (never Idle over live work) and
// list them: who runs, under whom, and what each is doing now.
import type { DiskSubagent } from '../src/lib/types'
import { bridgePlanRecords } from './plan-records'

function makeSub(overrides: Partial<DiskSubagent> = {}): DiskSubagent {
  return { id: 'a'.repeat(16), description: 'Finder', type: 'general-purpose', mtime: Date.now(), ...overrides }
}

describe('background agents (disk census)', () => {
  it('a closed turn with a LIVE subagent reads Working — n at work, not Idle', () => {
    useStore.setState({
      selected: { folder: 'f', id: 's1' },
      detail: makeDetail(empty(), {
        subagents: [
          makeSub({ id: '1'.repeat(16), skill: 'code-review', description: '/code-review max — sixth pass' }),
          makeSub({ id: '2'.repeat(16), parentId: '1'.repeat(16), depth: 2, description: 'Finder: cross-file' }),
          makeSub({ id: '3'.repeat(16), mtime: Date.now() - 10 * 60_000, description: 'old finder' }),
        ],
      }),
    })
    render(<ContextColumn />)
    expect(screen.getByText('Working')).toBeInTheDocument()
    expect(screen.getByText(/2 subagents at work/)).toBeInTheDocument()
    expect(screen.queryByText('Idle')).not.toBeInTheDocument()
  })

  // a subagent running a long test suite writes nothing for minutes —
  // its open tool call keeps it at work (live.ts agentAtWork), the same bound
  // as the main turn's toolSince
  it('a closed turn whose subagent is silent 5 min INSIDE a tool reads Working — 1 agent at work, the tool named', () => {
    const at = Date.now() - 5 * 60_000
    useStore.setState({
      selected: { folder: 'f', id: 's1' },
      detail: makeDetail(empty(), {
        meta: makeSession({ mtime: Date.now() - 20 * 60_000, turnOpen: false, lastRole: 'assistant', subMtime: at, subToolSince: at }),
        subagents: [
          makeSub({ id: '1'.repeat(16), mtime: at, toolSince: at, description: 'suite runner', lastTool: 'Bash', lastToolDetail: 'Run the full suite' }),
        ],
      }),
    })
    render(<ContextColumn />)
    expect(screen.getByText('Working')).toBeInTheDocument()
    expect(screen.getByText(/1 subagent at work/)).toBeInTheDocument()
    expect(screen.getByText(/Bash — Run the full suite/)).toBeInTheDocument()
    expect(screen.queryByText('Idle')).not.toBeInTheDocument()
  })

  it('silent 5 min with NO tool in flight — or a tool past the bound — is not Working (Idle: the header stays quiet)', () => {
    const at = Date.now() - 5 * 60_000
    const stale = Date.now() - 31 * 60_000
    for (const sub of [makeSub({ mtime: at }), makeSub({ mtime: at, toolSince: stale })]) {
      useStore.setState({
        selected: { folder: 'f', id: 's1' },
        detail: makeDetail(empty(), {
          meta: makeSession({
            mtime: Date.now() - 20 * 60_000,
            turnOpen: false,
            lastRole: 'assistant',
            subMtime: at,
            ...(sub.toolSince ? { subToolSince: sub.toolSince } : {}),
          }),
          subagents: [sub],
        }),
      })
      const { unmount } = render(<ContextColumn />)
      expect(screen.queryByText('Working')).not.toBeInTheDocument()
      expect(screen.queryByText(/at work/)).not.toBeInTheDocument()
      expect(screen.getByText(/Earlier · 1/)).toBeInTheDocument() // the row folds as history
      unmount()
    }
  })

  it('an open question still outranks background work: Waiting for you', () => {
    const at = Date.now() - 5 * 60_000
    useStore.setState({
      selected: { folder: 'f', id: 's1' },
      detail: makeDetail(empty(), {
        meta: makeSession({ mtime: Date.now() - 20 * 60_000, turnOpen: true, pendingAsk: true, subMtime: at, subToolSince: at }),
        subagents: [makeSub({ mtime: at, toolSince: at })],
      }),
    })
    render(<ContextColumn />)
    expect(screen.getByText('Waiting for you')).toBeInTheDocument()
  })

  it('the Agents block lists the census: live rows, the skill run named, children nested under it', () => {
    useStore.setState({
      selected: { folder: 'f', id: 's1' },
      detail: makeDetail(empty(), {
        subagents: [
          makeSub({ id: '1'.repeat(16), skill: 'code-review', effort: 'max', description: '/code-review max — sixth pass' }),
          makeSub({
            id: '2'.repeat(16),
            parentId: '1'.repeat(16),
            depth: 2,
            description: 'Finder: cross-file',
            lastTool: 'Bash',
            lastToolDetail: 'Run the pledge test suite',
          }),
        ],
      }),
    })
    render(<ContextColumn />)
    expect(screen.getByText('/code-review max — sixth pass')).toBeInTheDocument()
    expect(screen.getByText('code-review')).toBeInTheDocument()
    expect(screen.getByText('Finder: cross-file')).toBeInTheDocument()
    expect(screen.getByText(/Bash — Run the pledge test suite/)).toBeInTheDocument()
  })

  it('finished agents fold behind Earlier with their count — history never crowds the live set', () => {
    useStore.setState({
      selected: { folder: 'f', id: 's1' },
      detail: makeDetail(empty(), {
        subagents: [
          makeSub({ id: '1'.repeat(16), description: 'live one' }),
          makeSub({ id: '2'.repeat(16), mtime: Date.now() - 10 * 60_000, description: 'done A' }),
          makeSub({ id: '3'.repeat(16), mtime: Date.now() - 11 * 60_000, description: 'done B' }),
        ],
      }),
    })
    render(<ContextColumn />)
    expect(screen.getByText('live one')).toBeInTheDocument()
    expect(screen.queryByText('done A')).not.toBeVisible()
    fireEvent.click(screen.getByText(/Earlier · 2/))
    expect(screen.getByText('done A')).toBeVisible()
  })

  it('clicking a census row opens its transcript (the existing subagent viewer)', async () => {
    mockedApi.subagentTranscript.mockResolvedValue({ turns: [] })
    useStore.setState({
      selected: { folder: 'f', id: 's1' },
      detail: makeDetail(empty(), { subagents: [makeSub({ id: 'f'.repeat(16), description: 'Finder: cross-file' })] }),
    })
    render(<ContextColumn />)
    fireEvent.click(screen.getByText('Finder: cross-file'))
    await waitFor(() => expect(mockedApi.subagentTranscript).toHaveBeenCalledWith('f', 's1', 'f'.repeat(16)))
  })
})

// --- the status states the CONVERSATION, never the agent ----
//
// An agent streaming in ANOTHER conversation must not light this one's
// column: Working means work in THIS conversation (its turn, its census).
describe('status is conversation-scoped', () => {
  const activeTurn = (sessionKey: string | null) => ({
    turnId: 't1',
    agentId: 'a1',
    text: '',
    tools: [],
    status: 'streaming' as const,
    userText: 'go',
    sessionKey,
  })

  it("the agent's stream in another conversation leaves this one idle — and idle draws no status line", () => {
    useStore.setState({
      selected: { folder: 'f', id: 's1' },
      detail: makeDetail(empty()),
      active: activeTurn('f/OTHER'),
    })
    render(<ContextColumn />)
    expect(screen.queryByText('Working')).not.toBeInTheDocument()
    // idle says nothing the sidebar's dot and time don't
    expect(screen.queryByText('Idle')).not.toBeInTheDocument()
  })

  it("this conversation's own stream reads Working", () => {
    useStore.setState({
      selected: { folder: 'f', id: 's1' },
      detail: makeDetail(empty()),
      active: activeTurn('f/s1'),
    })
    render(<ContextColumn />)
    expect(screen.getByText('Working')).toBeInTheDocument()
  })
})

// c11: the conversation's cost — the CLI's own cumulative cost-state.
// One quiet line under runs-on: honest label (~, "API price": notional
// under a subscription), per-model breakdown in the tooltip.
describe('cost line', () => {
  it('paints ~$total · API price when the context carries cost, with per-model tooltip', () => {
    useStore.setState({
      selectedAgentId: 'a1',
      agents: [makeAgent()],
      selected: { folder: 'f', id: 's1' },
      detail: {
        meta: makeSession(),
        turns: [],
        total: 0,
        context: {
          ...empty(),
          cost: {
            totalUsd: 38.748179,
            unknownModels: false,
            byModel: [
              { model: 'claude-opus-4-8', usd: 38.0, inputTokens: 100, outputTokens: 200, cacheReadTokens: 0, cacheCreationTokens: 0 },
              { model: 'claude-haiku-4-5-20251001', usd: 0.74, inputTokens: 920, outputTokens: 14, cacheReadTokens: 0, cacheCreationTokens: 0 },
            ],
          },
        },
      },
    })
    render(<ContextColumn />)
    const line = screen.getByText(/~\$38\.75 · API price/)
    expect(line).toBeInTheDocument()
    expect(line.closest('[title]')?.getAttribute('title')).toMatch(/claude-opus-4-8 \$38\.00/)
  })

  it('with no cost-state the line does not exist (honest absence)', () => {
    useStore.setState({
      selectedAgentId: 'a1',
      agents: [makeAgent()],
      selected: { folder: 'f', id: 's1' },
      detail: { meta: makeSession(), turns: [], total: 0, context: empty() },
    })
    render(<ContextColumn />)
    expect(screen.queryByText(/API price/)).not.toBeInTheDocument()
  })

  it('a model without a price is NAMED beside the priced dollars, never a bare «unpriced»', () => {
    useStore.setState({
      selectedAgentId: 'a1',
      agents: [makeAgent()],
      selected: { folder: 'f', id: 's1' },
      detail: {
        meta: makeSession(),
        turns: [],
        total: 0,
        context: {
          ...empty(),
          cost: {
            totalUsd: 2,
            unknownModels: true,
            unpricedModels: ['claude-new-1'],
            byModel: [
              { model: 'claude-opus-5-5', usd: 2, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 },
              { model: 'claude-new-1', usd: 0, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 },
            ],
          },
        },
      },
    })
    render(<ContextColumn />)
    expect(screen.getByText(/claude-new-1/)).toBeInTheDocument()
    expect(screen.queryByText(/unpriced/)).not.toBeInTheDocument()
  })
})

// documents pasted into the conversation — listed in the column
// (type · size · when; the transcript carries no filename), each row a
// link to the raw endpoint so the browser renders it.
describe('documents block', () => {
  it('lists each document with type and size, linking to the raw endpoint', () => {
    vi.mocked(getToken).mockReturnValue('tok-1')
    useStore.setState({
      selectedAgentId: 'a1',
      agents: [makeAgent()],
      selected: { folder: 'f', id: 's1' },
      detail: {
        meta: makeSession(),
        turns: [],
        total: 0,
        context: { ...empty(), documents: [{ mediaType: 'application/pdf', bytes: 45_000, ts: '2026-08-12T19:29:56.477Z' }] },
      },
    })
    render(<ContextColumn />)
    expect(screen.getByText('Documents')).toBeInTheDocument()
    const a = screen.getByRole('link', { name: /PDF · 44 KB/ })
    // ?token= rides along like MediaScope's media URLs: a plain <a> sends no
    // x-token header, so without it the link 401s on remote access.
    expect(a).toHaveAttribute('href', '/api/sessions/f/s1/documents/0?token=tok-1')
  })

  it('no documents -> no block', () => {
    useStore.setState({
      selectedAgentId: 'a1',
      agents: [makeAgent()],
      selected: { folder: 'f', id: 's1' },
      detail: { meta: makeSession(), turns: [], total: 0, context: empty() },
    })
    render(<ContextColumn />)
    expect(screen.queryByText('Documents')).not.toBeInTheDocument()
  })
})

// File history (rewind checkpoints) RETIRED from the column — the counts said nothing a user could
// act on. The server still observes it (context.fileHistory travels in the
// API); the surface returns the day a per-file diff makes it worth looking at.
describe('file history block (retired)', () => {
  it('fileHistory in the context renders NO block', () => {
    useStore.setState({
      selectedAgentId: 'a1',
      agents: [makeAgent()],
      selected: { folder: 'f', id: 's1' },
      detail: {
        meta: makeSession(),
        turns: [],
        total: 0,
        context: {
          ...empty(),
          fileHistory: [{ path: 'docs/a.md', versions: 2, lastAt: '2026-08-17T17:20:00.000Z' }],
        } as never,
      },
    })
    render(<ContextColumn />)
    expect(screen.queryByText(/File history/)).not.toBeInTheDocument()
  })
})

// births (plugin 0.7.0): the PARENT conversation's column lists the nested
// runs its claude launched (an agent's `claude -p`), with the same live/idle
// dot, each opening its transcript.
describe('ContextColumn — nested runs under their parent', () => {
  const NOW = 1_800_000_000_000
  it('lists nested runs whose parent is this conversation or an earlier rotation of it; clicking opens the transcript', () => {
    const openSpy = vi.fn()
    const parent = makeSession({ id: 'root', folder: 'f', title: 'Root', agentId: 'a1', mtime: NOW - 600_000 })
    const tip = makeSession({ id: 'tip', folder: 'f', title: 'Tip', agentId: 'a1', mtime: NOW - 1000, parentKey: 'f/root' })
    const live = makeSession({
      id: 'n-live',
      folder: 'f',
      title: 'Run the smoke suite against staging and report',
      agentId: 'a1',
      mtime: NOW - 2000,
      turnOpen: true,
      origin: { kind: 'nested', parent: 'tip', agentId: 'a1' },
    })
    const old = makeSession({
      id: 'n-old',
      folder: 'f',
      title: 'Earlier smoke',
      agentId: 'a1',
      mtime: NOW - 3_600_000,
      origin: { kind: 'nested', parent: 'root', agentId: 'a1' },
    })
    const other = makeSession({
      id: 'n-other',
      folder: 'f',
      title: 'Someone else’s run',
      agentId: 'a1',
      mtime: NOW - 2000,
      origin: { kind: 'nested', parent: 'elsewhere', agentId: 'a1' },
    })
    useStore.setState({
      agents: [makeAgent({ id: 'a1', sessions: [parent, tip, live, old, other] })],
      selectedAgentId: 'a1',
      selected: { folder: 'f', id: 'tip' },
      detail: makeDetail({ ...empty() }, { meta: tip }),
      nowTick: NOW,
      openSession: openSpy as never,
    })
    render(<ContextColumn />)
    const block = screen.getByTestId('nested-runs')
    const rows = within(block).getAllByRole('button')
    expect(rows.map((r) => r.textContent)).toEqual([
      expect.stringContaining('nested run · Run the smoke suite against staging and report'),
      expect.stringContaining('nested run · Earlier smoke'),
    ])
    expect(within(block).queryByText(/Someone else/)).toBeNull()
    expect(rows[0]!.querySelector('[data-signal="working"]')).not.toBeNull()
    expect(rows[1]!.querySelector('[data-signal="working"]')).toBeNull()
    fireEvent.click(rows[0]!)
    expect(openSpy).toHaveBeenCalledWith('f', 'n-live')
  })

  // the server already names the EFFECTIVE parent (the
  // thread's session current when the run was born, /clear included), so
  // the column follows only continuation rotations (one row) — never a
  // /clear link, which is a different conversation.
  it('a /clear splits the list: each side shows only its own runs', () => {
    const pre = makeSession({ id: 'pre', folder: 'f', title: 'Before', agentId: 'a1', mtime: NOW - 600_000 })
    const post = makeSession({ id: 'post', folder: 'f', title: 'After', agentId: 'a1', mtime: NOW - 1000, parentKey: 'f/pre', parentKind: 'clear' })
    const runPre = makeSession({
      id: 'n-pre',
      folder: 'f',
      title: 'Pre run',
      agentId: 'a1',
      mtime: NOW - 500_000,
      origin: { kind: 'nested', parent: 'pre', agentId: 'a1' },
    })
    const runPost = makeSession({
      id: 'n-post',
      folder: 'f',
      title: 'Post run',
      agentId: 'a1',
      mtime: NOW - 2000,
      origin: { kind: 'nested', parent: 'post', agentId: 'a1' },
    })
    const agents = [makeAgent({ id: 'a1', sessions: [pre, post, runPre, runPost] })]
    useStore.setState({ agents, selected: { folder: 'f', id: 'post' }, detail: makeDetail({ ...empty() }, { meta: post }), nowTick: NOW })
    const { unmount } = render(<ContextColumn />)
    expect(
      within(screen.getByTestId('nested-runs'))
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual([expect.stringContaining('Post run')])
    unmount()
    useStore.setState({ selected: { folder: 'f', id: 'pre' }, detail: makeDetail({ ...empty() }, { meta: pre }) })
    render(<ContextColumn />)
    expect(
      within(screen.getByTestId('nested-runs'))
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual([expect.stringContaining('Pre run')])
  })

  it('no nested runs: no block', () => {
    useStore.setState({
      agents: [makeAgent({ id: 'a1', sessions: [makeSession({ id: 's1' })] })],
      selected: { folder: 'f', id: 's1' },
      detail: makeDetail({ ...empty() }),
    })
    render(<ContextColumn />)
    expect(screen.queryByTestId('nested-runs')).toBeNull()
  })
})

// --- a plan EXECUTED with subagents (lib/execution.ts, ExecutionBlock) -----
//
// subagent-driven development names each subagent by a fixed template
// ("Implement Task 12: …", "Review Task 12 (…)", "Re-review Task 9 fix round
// 2") and keeps no other state, so the census is the record. The column
// groups those rows by task, in their own block, and the plain Agents block
// keeps only what is not part of that.
describe('Executing — a plan run step by step with subagents', () => {
  const OLD = Date.now() - 60 * 60_000
  it('with an execution record the progress and the ✓ come from it, not from a plan file', () => {
    const H = 60 * 60_000
    useStore.setState({
      selected: { folder: 'f', id: 's1' },
      detail: makeDetail(empty(), {
        execution: {
          ledgerPath: '/r/.superpowers/sdd/x/progress.md',
          planPath: '/r/docs/x.md',
          planTitle: 'X',
          updatedAt: Date.now() - 2 * H,
          gone: true,
          done: 1,
          total: 3,
          tasks: [
            { n: 0, title: null, state: 'complete', detail: 'baseline' },
            { n: 1, title: 'The parser', state: 'complete', detail: 'commits a..b, review clean' },
            { n: 2, title: 'The store', state: 'pending' },
            { n: 3, title: 'Wiring', state: 'pending' },
          ],
        },
        subagents: [makeSub({ id: '2'.repeat(16), description: 'Implement Task 2: The store', startedAt: Date.now() - H })],
      }),
    })
    render(<ContextColumn />)
    // Task 0 (outside the document) is listed but is not progress
    expect(screen.getByTestId('execution-progress')).toHaveTextContent('1 of 3 done')
    expect(screen.getByTestId('execution-task-2')).toBeVisible()
    fireEvent.click(screen.getByText(/Earlier · 2/))
    const t1 = screen.getByTestId('execution-task-1')
    expect(within(t1).getByTitle('done')).toHaveTextContent('✓')
    expect(t1).toHaveTextContent('The parser')
    expect(t1).toHaveTextContent('commits a..b, review clean')
    // a complete task the document does not name still reads ✓ — it ran and was approved
    expect(within(screen.getByTestId('execution-task-0')).getByTitle('done')).toHaveTextContent('✓')
  })

  it('groups the census by task: number, title, the steps in order, each opening its transcript', () => {
    useStore.setState({
      selected: { folder: 'f', id: 's1' },
      detail: makeDetail(empty(), {
        subagents: [
          makeSub({ id: '1'.repeat(16), description: 'Implement Task 12: OpenCode console route', startedAt: OLD, mtime: OLD }),
          makeSub({
            id: '2'.repeat(16),
            description: 'Review Task 12 (spec + quality)',
            startedAt: OLD + 1000,
            lastTool: 'Read',
            lastToolDetail: 'server/src/server.ts',
          }),
          makeSub({ id: '3'.repeat(16), description: 'Explore the repo' }),
        ],
      }),
    })
    render(<ContextColumn />)
    expect(screen.getByText('Executing')).toBeInTheDocument()
    const task = screen.getByTestId('execution-task-12')
    expect(task).toHaveTextContent('Step 12')
    expect(task).toHaveTextContent('OpenCode console route')
    const steps = within(task)
      .getAllByRole('button')
      .map((b) => b.textContent)
    expect(steps[0]).toContain('implement')
    expect(steps[1]).toContain('review')
    expect(task).toHaveTextContent('Read — server/src/server.ts')
    // the plain Agents block keeps only the row that is not a step
    expect(screen.getByText('Explore the repo')).toBeInTheDocument()
    expect(screen.queryByText('Implement Task 12: OpenCode console route')).not.toBeInTheDocument()
    fireEvent.click(within(task).getByLabelText('Open transcript of Review Task 12 (spec + quality)'))
    expect(screen.getByRole('dialog', { name: /Review Task 12/ })).toBeInTheDocument()
  })

  it('finished tasks fold behind Earlier; a re-review carries its round', () => {
    useStore.setState({
      selected: { folder: 'f', id: 's1' },
      detail: makeDetail(empty(), {
        subagents: [
          makeSub({ id: '1'.repeat(16), description: 'Implement Task 9: Merge', startedAt: OLD - 5000, mtime: OLD }),
          makeSub({ id: '2'.repeat(16), description: 'Re-review Task 9 fix round 2', startedAt: OLD - 4000, mtime: OLD }),
          makeSub({ id: '3'.repeat(16), description: 'Implement Task 10: Plugin', startedAt: OLD }),
        ],
      }),
    })
    render(<ContextColumn />)
    expect(screen.getByTestId('execution-task-10')).toBeVisible()
    expect(screen.getByTestId('execution-task-9')).not.toBeVisible()
    fireEvent.click(screen.getByText(/Earlier · 1/))
    expect(screen.getByTestId('execution-task-9')).toBeVisible()
    expect(screen.getByTestId('execution-task-9')).toHaveTextContent('re-review round 2')
    // nothing left for a plain Agents block
    expect(screen.queryByText('Subagents')).not.toBeInTheDocument()
  })

  it('sits right under the status, before Plan and Agents, and the status names the step', async () => {
    mockedApi.file.text.mockResolvedValue(
      JSON.stringify({
        title: 'Event layer',
        tasks: [
          { id: 't1', title: 'a', owner: 'silos', status: 'done', dependsOn: [] },
          { id: 't2', title: 'b', owner: 'silos', status: 'done', dependsOn: [] },
          { id: 't3', title: 'c', owner: 'silos', status: 'in_progress', dependsOn: [] },
          { id: 't4', title: 'd', owner: 'silos', status: 'pending', dependsOn: [] },
        ],
      }),
    )
    mockedApi.file.dir.mockResolvedValue({ path: '/proj/plans', entries: [] })
    const H = 60 * 60_000
    useStore.setState({
      agents: [makeAgent({ id: 'silos' })],
      selected: { folder: 'f', id: 's1' },
      detail: makeDetail(
        { ...empty(), files: [{ path: '/proj/plans/event-layer.plan.json', edits: 0, writes: 1, reads: 0 }] },
        {
          meta: makeSession({ cwd: '/proj' }),
          // the record the Executions silo lists for this conversation (phase 5: the only source of done/total)
          execution: {
            ledgerPath: '/proj/.superpowers/sdd/x/progress.md',
            planPath: '/proj/docs/x.md',
            planTitle: 'X',
            updatedAt: Date.now() - H,
            gone: false,
            done: 2,
            total: 4,
            tasks: [
              { n: 1, title: 'a', state: 'complete' },
              { n: 2, title: 'b', state: 'complete' },
              { n: 3, title: 'c', state: 'pending' },
              { n: 4, title: 'd', state: 'pending' },
            ],
          },
          subagents: [
            makeSub({ id: '1'.repeat(16), description: 'Implement Task 1: a', startedAt: Date.now() - 4 * H, mtime: Date.now() - 3 * H }),
            makeSub({ id: '2'.repeat(16), description: 'Implement Task 2: b', startedAt: Date.now() - 3 * H, mtime: Date.now() - 1 * H }),
            makeSub({ id: '3'.repeat(16), description: 'Implement Task 3: c', startedAt: Date.now() - 1 * H }),
            makeSub({ id: '4'.repeat(16), description: 'Finder' }),
          ],
        },
      ),
    })
    render(<ContextColumn />)
    await screen.findByText('Event layer')
    const titles = screen.getAllByText(/^(Executing|Plan|Subagents)$/).map((e) => e.textContent)
    expect(titles).toEqual(['Executing', 'Plan', 'Subagents'])
    // the status line names the step the way Home does
    expect(screen.getByText('Step 3 · implementing')).toBeInTheDocument()
    // progress against the plan: 2 of 4 done, mean work 1.5 h × 2 left = 3 h; the live step with its own time
    const progress = screen.getByTestId('execution-progress')
    expect(progress).toHaveTextContent('2 of 4 done')
    expect(progress).toHaveTextContent('implementing for 1 h')
    expect(progress).not.toHaveTextContent(/ in\b/)
    expect(progress).toHaveTextContent('about 3 h left at this pace')
    expect(within(progress).getByRole('progressbar')).toHaveAttribute('aria-valuenow', '50')
    // glyphs: the plan's done tasks read ✓, the live one ●, their steps ✓ once run
    fireEvent.click(screen.getByText(/Earlier · 2/))
    expect(within(screen.getByTestId('execution-task-1')).getByTitle('done')).toHaveTextContent('✓')
    expect(within(screen.getByTestId('execution-task-3')).getByTitle('running')).toHaveTextContent('●')
    expect(within(screen.getByTestId('execution-task-1')).getByRole('button', { name: /Implement Task 1/ })).toHaveTextContent('✓')
  })

  it('with a record, ◯ speaks the record: a fix round, or ran and not approved yet', () => {
    const H = 60 * 60_000
    useStore.setState({
      selected: { folder: 'f', id: 's1' },
      detail: makeDetail(empty(), {
        execution: {
          ledgerPath: '/r/.superpowers/sdd/x/progress.md',
          planPath: '/r/docs/x.md',
          planTitle: 'X',
          updatedAt: Date.now() - 2 * H,
          gone: false,
          done: 0,
          total: 3,
          tasks: [
            { n: 1, title: 'a', state: 'pending' },
            { n: 2, title: 'b', state: 'fixing', round: 2 },
            { n: 3, title: 'c', state: 'pending' },
          ],
        },
        subagents: [
          makeSub({ id: '1'.repeat(16), description: 'Implement Task 1: a', startedAt: Date.now() - 2 * H, mtime: Date.now() - H }),
          makeSub({ id: '3'.repeat(16), description: 'Implement Task 3: c', startedAt: Date.now() - H }),
        ],
      }),
    })
    render(<ContextColumn />)
    fireEvent.click(screen.getByText(/Earlier · 2/))
    expect(within(screen.getByTestId('execution-task-2')).getByTitle('fixing — round 2')).toHaveTextContent('◯')
    expect(within(screen.getByTestId('execution-task-1')).getByTitle('ran — not approved yet')).toHaveTextContent('◯')
  })

  it('without a plan file the line counts finished tasks and names no pace', () => {
    const H = 60 * 60_000
    useStore.setState({
      selected: { folder: 'f', id: 's1' },
      detail: makeDetail(empty(), {
        subagents: [
          makeSub({ id: '1'.repeat(16), description: 'Implement Task 1: a', startedAt: Date.now() - 2 * H, mtime: Date.now() - H }),
          makeSub({ id: '2'.repeat(16), description: 'Implement Task 2: b', startedAt: Date.now() - H }),
        ],
      }),
    })
    render(<ContextColumn />)
    const progress = screen.getByTestId('execution-progress')
    expect(progress).toHaveTextContent('1 step finished · implementing for 1 h')
    expect(progress).not.toHaveTextContent('at this pace')
    expect(within(progress).queryByRole('progressbar')).not.toBeInTheDocument()
    // no plan to call anything done: a finished task is ◯, named so
    fireEvent.click(screen.getByText(/Earlier · 1/))
    expect(within(screen.getByTestId('execution-task-1')).getByTitle('finished — not marked done in the plan')).toHaveTextContent('◯')
  })

  it('a finished execution leaves the top: folded "Executed" down with the agents, outcome in its header', async () => {
    mockedApi.file.text.mockResolvedValue(
      JSON.stringify({
        title: 'Event layer',
        tasks: [
          { id: 't1', title: 'a', owner: 'silos', status: 'done', dependsOn: [] },
          { id: 't2', title: 'b', owner: 'silos', status: 'done', dependsOn: [] },
        ],
      }),
    )
    mockedApi.file.dir.mockResolvedValue({ path: '/proj/plans', entries: [] })
    const H = 60 * 60_000
    const T = Date.now() // one clock for the timestamps and nowTick: "16h ago" must not floor to 15h
    useStore.setState({
      nowTick: T,
      agents: [makeAgent({ id: 'silos' })],
      selected: { folder: 'f', id: 's1' },
      detail: makeDetail(
        { ...empty(), files: [{ path: '/proj/plans/event-layer.plan.json', edits: 0, writes: 1, reads: 0 }] },
        {
          meta: makeSession({ cwd: '/proj' }),
          execution: {
            ledgerPath: '/proj/.superpowers/sdd/x/progress.md',
            planPath: '/proj/docs/x.md',
            planTitle: 'X',
            updatedAt: T - 16 * H,
            gone: false,
            done: 2,
            total: 2,
            tasks: [
              { n: 1, title: 'a', state: 'complete' },
              { n: 2, title: 'b', state: 'complete' },
            ],
          },
          subagents: [
            makeSub({ id: '1'.repeat(16), description: 'Implement Task 1: a', startedAt: T - 20 * H, mtime: T - 19 * H }),
            makeSub({ id: '2'.repeat(16), description: 'Implement Task 2: b', startedAt: T - 18 * H, mtime: T - 16 * H }),
            makeSub({ id: '3'.repeat(16), description: 'Finder' }),
          ],
        },
      ),
    })
    render(<ContextColumn />)
    // the finished plan is no card: the block's ✓ line alone
    await screen.findByTestId('team-plan-finished')
    expect(screen.queryByText('Executing')).not.toBeInTheDocument()
    expect(screen.queryByTestId('execution-progress')).not.toBeInTheDocument()
    // after Plan, beside Agents — not under the status
    const titles = screen.getAllByText(/^(Executing|Executed|Plan|Subagents)$/).map((e) => e.textContent)
    expect(titles).toEqual(['Plan', 'Executed', 'Subagents'])
    const summary = screen.getByText('Executed').closest('summary')!
    expect(summary).toHaveTextContent('2 of 2 done · 16h ago')
    // closed by default; its tasks are one click away
    expect(screen.getByTestId('execution-task-2')).not.toBeVisible()
    fireEvent.click(screen.getByText('Executed'))
    expect(screen.getByTestId('execution-task-2')).toBeVisible()
    expect(within(screen.getByTestId('execution-task-1')).getByTitle('done')).toHaveTextContent('✓')
  })

  it('a paused execution (plan unfinished, nothing live) stays at the top as Executing', async () => {
    mockedApi.file.text.mockResolvedValue(
      JSON.stringify({
        title: 'Event layer',
        tasks: [
          { id: 't1', title: 'a', owner: 'silos', status: 'done', dependsOn: [] },
          { id: 't2', title: 'b', owner: 'silos', status: 'pending', dependsOn: [] },
        ],
      }),
    )
    mockedApi.file.dir.mockResolvedValue({ path: '/proj/plans', entries: [] })
    const H = 60 * 60_000
    useStore.setState({
      agents: [makeAgent({ id: 'silos' })],
      selected: { folder: 'f', id: 's1' },
      detail: makeDetail(
        { ...empty(), files: [{ path: '/proj/plans/event-layer.plan.json', edits: 0, writes: 1, reads: 0 }] },
        {
          meta: makeSession({ cwd: '/proj' }),
          execution: {
            ledgerPath: '/proj/.superpowers/sdd/x/progress.md',
            planPath: '/proj/docs/x.md',
            planTitle: 'X',
            updatedAt: Date.now() - 19 * H,
            gone: false,
            done: 1,
            total: 2,
            tasks: [
              { n: 1, title: 'a', state: 'complete' },
              { n: 2, title: 'b', state: 'pending' },
            ],
          },
          subagents: [makeSub({ id: '1'.repeat(16), description: 'Implement Task 1: a', startedAt: Date.now() - 20 * H, mtime: Date.now() - 19 * H })],
        },
      ),
    })
    render(<ContextColumn />)
    await screen.findByText('Event layer')
    const titles = screen.getAllByText(/^(Executing|Executed|Plan)$/).map((e) => e.textContent)
    expect(titles).toEqual(['Executing', 'Plan'])
    expect(screen.getByTestId('execution-progress')).toHaveTextContent('1 of 2 done')
  })

  it('the door to the task it hangs from (phase 5): «for plan#t3 ›» opens the task page', () => {
    const H = 60 * 60_000
    const changePage = vi.fn()
    useStore.setState({
      changePage: changePage as never,
      selected: { folder: 'f', id: 's1' },
      detail: makeDetail(empty(), {
        execution: {
          ledgerPath: '/r/.superpowers/sdd/x/progress.md',
          planPath: '/r/docs/x.md',
          planTitle: 'X',
          updatedAt: Date.now() - H,
          gone: false,
          done: 1,
          total: 2,
          tasks: [
            { n: 1, title: 'a', state: 'complete' },
            { n: 2, title: 'b', state: 'pending' },
          ],
        },
        executionTask: { key: 'folder:/r/ship/tasks/t3', ref: 'ship#t3', edge: 'conversation' },
        subagents: [makeSub({ id: '2'.repeat(16), description: 'Implement Task 2: b', startedAt: Date.now() - H })],
      }),
    })
    render(<ContextColumn />)
    const door = screen.getByTestId('execution-task-door')
    expect(door).toHaveTextContent('ship#t3')
    fireEvent.click(door)
    expect(changePage).toHaveBeenCalledWith(expect.objectContaining({ kind: 'task', plan: 'folder:/r/ship', task: 't3' }))
  })

  it('a census with no such rows paints the Agents block as before, no Executing', () => {
    useStore.setState({
      selected: { folder: 'f', id: 's1' },
      detail: makeDetail(empty(), { subagents: [makeSub({ id: '1'.repeat(16), description: 'Finder' })] }),
    })
    render(<ContextColumn />)
    expect(screen.queryByText('Executing')).not.toBeInTheDocument()
    expect(screen.getByText('Subagents')).toBeInTheDocument()
  })
})

// Three plan-shaped things, three owners: the team's Plan (durable) above
// this conversation's Checklist (ephemeral); the project's list — no plan —
// is its own door outside the Plan block. One fraction everywhere
// (planProgress), one cut-word («yours to do» = the Yours-to-do set).
describe("Plan · Checklist · the project's list — order, door, fraction, yours", () => {
  const tasks = (statusOwner: Array<[string, string, string[]?]>) =>
    statusOwner.map(([status, owner, dependsOn], i) => ({ id: `t${i + 1}`, title: `x${i + 1}`, owner, status, dependsOn: dependsOn ?? [] }))
  const setup = (plans: Record<string, string>, extra: Partial<SessionContext> = {}) => {
    mockedApi.file.text.mockImplementation(async (p: string) => {
      if (!(p in plans)) throw new Error('404')
      return plans[p]!
    })
    mockedApi.file.dir.mockResolvedValue({ path: '/proj/plans', entries: [] })
    const go = vi.fn()
    useStore.setState({
      changePage: go as never,
      agents: [makeAgent({ id: 'builder' })],
      selected: { folder: 'f', id: 's1' },
      detail: {
        meta: makeSession({ cwd: '/proj' }),
        turns: [],
        total: 0,
        context: { ...empty(), ...extra, files: Object.keys(plans).map((path) => ({ path, edits: 0, writes: 1, reads: 0 })) },
      },
    })
    return go
  }

  it("the Plan block comes before the Checklist; the project's list is no door in the column", async () => {
    setup(
      {
        '/proj/plans/launch.plan.json': JSON.stringify({ title: 'Launch', tasks: tasks([['pending', 'builder']]) }),
        '/proj/plans/tasks.plan.json': JSON.stringify({ title: '', tasks: tasks([['pending', 'owner']]) }),
      },
      { plan: { done: 0, total: 1, tasks: [{ id: 'c1', subject: 'step', status: 'pending', createdAt: '2026-08-19T00:00:00Z', agents: [] }] } },
    )
    render(<ContextColumn />)
    const block = await screen.findByTestId('team-plan-block')
    const checklist = screen.getByText('Checklist').closest('details')!
    const planDetails = block.closest('details')!
    // document order: Plan, then Checklist
    expect(planDetails.compareDocumentPosition(checklist) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    // the list is never one of the Plan block's plans, nor a door anywhere
    expect(
      within(block)
        .queryAllByRole('button')
        .map((b) => b.getAttribute('title')),
    ).not.toContain('/proj/plans/tasks.plan.json')
    expect(screen.queryByTestId('column-standing-tasks')).not.toBeInTheDocument()
  })

  it("only the project's list, no task of it held: no block at all", async () => {
    setup({ '/proj/plans/tasks.plan.json': JSON.stringify({ title: '', tasks: tasks([['pending', 'owner']]) }) })
    render(<ContextColumn />)
    await waitFor(() => expect(mockedApi.file.text).toHaveBeenCalled())
    expect(screen.queryByTestId('team-plan-block')).not.toBeInTheDocument()
    expect(screen.queryByTestId('column-standing-tasks')).not.toBeInTheDocument()
  })

  it("the card's fraction is planProgress (a dropped task leaves the total); its yours-to-do count is your open tasks of it", async () => {
    setup({
      '/proj/plans/launch.plan.json': JSON.stringify({
        title: 'Launch',
        tasks: tasks([
          ['done', 'builder'],
          ['cancelled', 'builder'],
          ['pending', 'owner'], // yours, ready
          ['blocked', 'owner', ['t6']], // yours, not ready — still yours to do
          ['done', 'owner'], // finished: not to do
          ['pending', 'sam'], // another person's: never yours
        ]),
      }),
    })
    render(<ContextColumn />)
    const card = await screen.findByTestId('team-plan-launch.plan.json')
    expect(card).toHaveTextContent(/^2\/5/)
    expect(card).toHaveTextContent(/\b2 yours to do\b/)
  })
})

describe('Plan — one plan in play, the rest folded', () => {
  const files = (...names: string[]) => ({ ...empty(), files: names.map((n) => ({ path: `/proj/plans/${n}`, edits: 0, writes: 1, reads: 0 })) })
  const plan = (title: string, statuses: string[]) =>
    JSON.stringify({ title, tasks: statuses.map((s, i) => ({ id: `t${i + 1}`, title: `${title} ${i + 1}`, owner: 'silos', status: s, dependsOn: [] })) })
  it('the newest unfinished plan is the card; older open ones fold with their progress, finished ones are the ✓ line', async () => {
    mockedApi.file.text.mockImplementation(async (p: string) =>
      p.endsWith('old.plan.json')
        ? plan('Old', ['done', 'pending'])
        : p.endsWith('new.plan.json')
          ? plan('New', ['done', 'pending', 'pending'])
          : plan('Finished', ['done', 'done']),
    )
    mockedApi.file.dir.mockResolvedValue({
      path: '/proj/plans',
      entries: [
        { name: 'old.plan.json', type: 'file', size: 1, mtime: Date.now() - 40 * 24 * 60 * 60_000 },
        { name: 'new.plan.json', type: 'file', size: 1, mtime: Date.now() - 60_000 },
        { name: 'finished.plan.json', type: 'file', size: 1, mtime: Date.now() - 3600_000 },
      ],
    })
    const go = vi.fn()
    useStore.setState({
      changePage: go as never,
      agents: [makeAgent({ id: 'silos' })],
      selected: { folder: 'f', id: 's1' },
      detail: { meta: makeSession({ cwd: '/proj' }), turns: [], total: 0, context: files('old.plan.json', 'new.plan.json', 'finished.plan.json') },
    })
    render(<ContextColumn />)
    const card = await screen.findByTestId('team-plan-new.plan.json')
    expect(card).toHaveTextContent('New')
    expect(card).toHaveTextContent(/1m ago|just now/)
    expect(screen.queryByTestId('team-plan-old.plan.json')).not.toBeInTheDocument()
    const others = screen.getByTestId('team-plan-others')
    expect(others).toHaveTextContent('1 other plan')
    expect(screen.getByTestId('team-plan-row-old.plan.json')).not.toBeVisible()
    fireEvent.click(within(others).getByText('1 other plan'))
    expect(screen.getByTestId('team-plan-row-old.plan.json')).toHaveTextContent('1/2')
    expect(screen.queryByTestId('team-plan-row-finished.plan.json')).not.toBeInTheDocument()
    expect(screen.getByTestId('team-plan-finished')).toHaveTextContent(/1 finished/)
    mockedApi.file.meta.mockResolvedValue({
      path: '/proj/plans/old.plan.json',
      name: 'old.plan.json',
      ext: '.json',
      kind: 'text',
      mime: 'application/json',
      size: 10,
      tooLarge: false,
      editable: true,
    } as FileMeta)
    fireEvent.click(screen.getByTestId('team-plan-row-old.plan.json'))
    // an open plan's door is its house (planDoor), never the file
    await waitFor(() => expect(go).toHaveBeenCalledWith(expect.objectContaining({ kind: 'tasks', view: 'open' })))
    expect(mockedApi.file.meta).not.toHaveBeenCalledWith('/proj/plans/old.plan.json')
    // the Plan block's count is the CARD's open tasks only (2); the folded plans are history
    expect(screen.getByText('Plans').closest('summary')!.lastElementChild).toHaveTextContent(/^2$/)
  })
  it('a plan waiting on you is the card even when an agent-only plan is newer', async () => {
    mockedApi.file.text.mockImplementation(async (p: string) =>
      p.endsWith('yours.plan.json')
        ? JSON.stringify({ title: 'Yours', tasks: [{ id: 't1', title: 'approve', owner: 'sam', status: 'pending', dependsOn: [] }] })
        : plan('Agent', ['pending']),
    )
    mockedApi.file.dir.mockResolvedValue({
      path: '/proj/plans',
      entries: [
        { name: 'yours.plan.json', type: 'file', size: 1, mtime: Date.now() - 3600_000 },
        { name: 'agent.plan.json', type: 'file', size: 1, mtime: Date.now() - 1000 },
      ],
    })
    useStore.setState({
      agents: [makeAgent({ id: 'silos' })],
      selected: { folder: 'f', id: 's1' },
      detail: { meta: makeSession({ cwd: '/proj' }), turns: [], total: 0, context: files('yours.plan.json', 'agent.plan.json') },
    })
    render(<ContextColumn />)
    expect(await screen.findByTestId('team-plan-yours.plan.json')).toBeInTheDocument()
    expect(screen.getByTestId('team-plan-others')).toHaveTextContent('1 other plan')
  })
  it('the card does not switch on first paint: plans and their dates land together', async () => {
    // the older plan has the newer updatedAt: painted before its listing, it would be the card first
    mockedApi.file.text.mockImplementation(async (p: string) =>
      p.endsWith('old.plan.json')
        ? JSON.stringify({
            title: 'Old',
            updatedAt: new Date().toISOString(),
            tasks: [{ id: 't1', title: 'x', owner: 'silos', status: 'pending', dependsOn: [] }],
          })
        : JSON.stringify({
            title: 'New',
            updatedAt: '2020-01-01T00:00:00Z',
            tasks: [{ id: 't1', title: 'y', owner: 'silos', status: 'pending', dependsOn: [] }],
          }),
    )
    let resolveDir: (v: { path: string; entries: DirEntry[] }) => void = () => {}
    mockedApi.file.dir.mockImplementation(
      () =>
        new Promise<{ path: string; entries: DirEntry[] }>((r) => {
          resolveDir = r
        }),
    )
    useStore.setState({
      agents: [makeAgent({ id: 'silos' })],
      selected: { folder: 'f', id: 's1' },
      detail: { meta: makeSession({ cwd: '/proj' }), turns: [], total: 0, context: files('old.plan.json', 'new.plan.json') },
    })
    render(<ContextColumn />)
    await waitFor(() => expect(mockedApi.file.dir).toHaveBeenCalled())
    expect(screen.queryByTestId('team-plan-old.plan.json')).not.toBeInTheDocument() // nothing painted yet
    await act(async () => {
      resolveDir({
        path: '/proj/plans',
        entries: [
          { name: 'old.plan.json', type: 'file', size: 1, mtime: Date.now() - 40 * 24 * 60 * 60_000 },
          { name: 'new.plan.json', type: 'file', size: 1, mtime: Date.now() - 60_000 },
        ],
      })
    })
    expect(await screen.findByTestId('team-plan-new.plan.json')).toBeInTheDocument()
  })
  it('a listing mtime of 0 is no date: no "updated" line', async () => {
    mockedApi.file.text.mockResolvedValue(plan('Only', ['pending']))
    mockedApi.file.dir.mockResolvedValue({ path: '/proj/plans', entries: [{ name: 'only.plan.json', type: 'file', size: 1, mtime: 0 }] })
    useStore.setState({
      agents: [makeAgent({ id: 'silos' })],
      selected: { folder: 'f', id: 's1' },
      detail: { meta: makeSession({ cwd: '/proj' }), turns: [], total: 0, context: files('only.plan.json') },
    })
    render(<ContextColumn />)
    expect(await screen.findByTestId('team-plan-only.plan.json')).not.toHaveTextContent('updated')
  })
  it('one plan: a card and no fold', async () => {
    mockedApi.file.text.mockResolvedValue(plan('Only', ['pending']))
    mockedApi.file.dir.mockResolvedValue({ path: '/proj/plans', entries: [{ name: 'only.plan.json', type: 'file', size: 1, mtime: 0 }] })
    useStore.setState({
      agents: [makeAgent({ id: 'silos' })],
      selected: { folder: 'f', id: 's1' },
      detail: { meta: makeSession({ cwd: '/proj' }), turns: [], total: 0, context: files('only.plan.json') },
    })
    render(<ContextColumn />)
    expect(await screen.findByTestId('team-plan-only.plan.json')).toBeInTheDocument()
    expect(screen.queryByTestId('team-plan-others')).not.toBeInTheDocument()
  })
})
