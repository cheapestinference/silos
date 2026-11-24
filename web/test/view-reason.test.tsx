// view-reason.test.tsx — a conversation is either LIVE (the real console,
// or a chat you can type into) or a TRANSCRIPT. The window itself says
// which: a transcript has no composer — where the composer would be sits a
// read-only footer with at most ONE way out — and no sentence above the
// messages (five explanatory lines were too much; the kind of window must
// be visually clear instead). Three read-only cases:
//   · an older rotation of a thread (the live console is the tip's) → open the tip
//   · a run born from an automation (runs never open a console) → no way out
// Two live cases keep the composer: chat by choice (the band's selector is
// the way to the real console) and a console that couldn't open (a strip
// above the composer offers a retry). The exact reason lives in the
// footer's tooltip, never as a line of prose.
// A conversation idle for over a day is NOT read-only: its
// claude slept after a day without work and opening the conversation wakes
// it (`claude --resume`) — the sidebar orders by content activity, so a
// wake never bumps a dead thread; the console says it was asleep.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { act } from 'react'
import { AgentPage } from '../src/components/AgentPage'
import { useStore } from '../src/store'
import { api } from '../src/lib/api'
import { terminalBannerShows, type ViewReason } from '../src/components/Chat'
import type { AgentView, SessionDetail, SessionView } from '../src/lib/types'

vi.mock('../src/lib/api')
// the live console's xterm needs a real browser (matchMedia, canvas); the
// shell around it is what these tests look at.
vi.mock('../src/components/TerminalPanel', async (orig) => ({ ...(await orig<Record<string, unknown>>()), TerminalView: () => <div data-testid="xterm" /> }))
const mockedApi = vi.mocked(api, { deep: true })

function makeSession(id: string, title: string, extra: Partial<SessionView> = {}): SessionView {
  return {
    id,
    folder: 'f',
    title,
    skills: [],
    cwd: null,
    mtime: Date.now(),
    size: 10,
    turnCount: 2,
    live: false,
    worktree: false,
    native: false,
    agentId: 'a1',
    ...extra,
  }
}

function makeDetail(id: string): SessionDetail {
  return {
    meta: makeSession(id, `title ${id}`),
    turns: [{ index: 0, role: 'user', text: `transcript of ${id}`, tools: [], ts: '2026-10-18T10:00:00.000Z' }],
    total: 1,
  }
}

function agentWith(sessions: SessionView[]): AgentView {
  return { id: 'a1', name: 'Ana', emoji: '🧠', folder: '/tmp/ana', skills: [], sessions, liveCount: 0, sessionCount: sessions.length }
}

function seed(sessions: SessionView[], chatMode: 'chat' | 'console') {
  useStore.setState({
    agents: [agentWith(sessions)],
    selected: null,
    detail: null,
    selectedAgentId: 'a1',
    page: { kind: 'agent', id: 'a1' },
    chatMode,
    automations: [
      {
        id: 'au1',
        name: 'Daily digest',
        agentId: 'a1',
        prompt: 'x',
        paused: false,
        trigger: { kind: 'cron', expr: '0 9 * * *' },
        thread: { mode: 'new' },
        approval: false,
        keepAlive: false,
        createdAt: '2026-10-01T00:00:00.000Z',
      },
    ] as never,
  })
}

const composer = () => screen.queryByPlaceholderText(/Message Ana/)
const footer = () => screen.getByTestId('transcript-footer')

describe('a transcript is a read-only window: no composer, a footer with one way out', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    mockedApi.console.mockResolvedValue({ key: 'k', theme: 'dark' })
    mockedApi.sessionDetail.mockImplementation(async (_f: string, id: string) => makeDetail(id))
    mockedApi.markSeen.mockResolvedValue(undefined as never)
    mockedApi.conversationPrefs = { get: vi.fn().mockResolvedValue(null), patch: vi.fn() } as never
    mockedApi.agents = {} as never
  })

  it("an older rotation is read-only and points at the thread's tip", async () => {
    seed([makeSession('s1', 'First', { mtime: Date.now() - 60_000 }), makeSession('s2', 'First (continued)', { parentKey: 'f/s1' })], 'console')
    render(<AgentPage />)
    await act(async () => {
      await useStore.getState().openSession('f', 's1', { exact: true })
    })
    await waitFor(() => expect(screen.getByText('transcript of s1')).toBeTruthy())
    expect(mockedApi.console).not.toHaveBeenCalled()
    expect(composer()).toBeNull()
    expect(screen.queryByTestId('view-reason')).toBeNull()
    expect(footer().textContent).toMatch(/Read-only/)
    expect(footer().getAttribute('title')).toMatch(/continues in “First \(continued\)”/)
    fireEvent.click(within(footer()).getByRole('button', { name: 'Open the current conversation ›' }))
    await waitFor(() => expect(useStore.getState().selected?.id).toBe('s2'))
  })

  // a /clear starts a NEW conversation. Opening the cleared one
  // (its own sidebar row, no `exact`) reads THAT conversation — the
  // navigation never jumps across the /clear — and the footer says where
  // the console went.
  it('a conversation left by /clear opens as itself, read-only, with the way to where the console went', async () => {
    seed(
      [makeSession('s1', 'Before', { mtime: Date.now() - 60_000 }), makeSession('s2', 'After the clear', { parentKey: 'f/s1', parentKind: 'clear' })],
      'console',
    )
    render(<AgentPage />)
    await act(async () => {
      await useStore.getState().openSession('f', 's1')
    })
    expect(useStore.getState().selected?.id).toBe('s1')
    await waitFor(() => expect(screen.getByText('transcript of s1')).toBeTruthy())
    expect(mockedApi.console).not.toHaveBeenCalled()
    expect(composer()).toBeNull()
    expect(footer().getAttribute('title')).toMatch(/cleared with \/clear.*“After the clear”/i)
    fireEvent.click(within(footer()).getByRole('button', { name: 'Open the current conversation ›' }))
    await waitFor(() => expect(useStore.getState().selected?.id).toBe('s2'))
  })

  // a live console with a recorded child OLDER than it (an
  // SDK fork born at once by an old bug) is not superseded — it opens its
  // own console, and the stale child is never where the thread lands.
  it('a child OLDER than the conversation does not supersede it: the console opens on the conversation itself', async () => {
    const now = Date.now()
    seed([makeSession('s1', 'Live', { mtime: now }), makeSession('s2', 'Stale fork', { mtime: now - 3 * 3_600_000, parentKey: 'f/s1' })], 'console')
    useStore.setState({ nowTick: now })
    render(<AgentPage />)
    await act(async () => {
      await useStore.getState().openSession('f', 's1')
    })
    expect(useStore.getState().selected?.id).toBe('s1')
    await waitFor(() => expect(mockedApi.console).toHaveBeenCalled())
    expect(screen.queryByTestId('transcript-footer')).toBeNull()
  })

  it('a run born from an automation is read-only with no way out — and says whose run it is', async () => {
    seed([makeSession('s1', 'Digest for 18 Oct', { origin: { kind: 'automation', automationId: 'au1', runId: 'r1' } })], 'console')
    render(<AgentPage />)
    await act(async () => {
      await useStore.getState().openSession('f', 's1')
    })
    await waitFor(() => expect(screen.getByText('transcript of s1')).toBeTruthy())
    expect(mockedApi.console).not.toHaveBeenCalled()
    expect(composer()).toBeNull()
    expect(footer().getAttribute('title')).toMatch(/Daily digest/)
    expect(within(footer()).queryByRole('button')).toBeNull()
  })

  // a conversation Silos once opened for a message (origin 'message' —
  // history: no message wakes anyone anymore) is NOT a run — it opens its console like any conversation, and
  // the line under the title says which message it was opened for
  it('a conversation opened for a message is live (its console opens), and says why it exists', async () => {
    seed([makeSession('m1', 'Ship the fix', { origin: { kind: 'message', messageId: 'msg-1', from: 'owner', gist: 'ship the fix today' } })], 'console')
    render(<AgentPage />)
    await act(async () => {
      await useStore.getState().openSession('f', 'm1')
    })
    await waitFor(() => expect(mockedApi.console).toHaveBeenCalled())
    expect(screen.queryByTestId('transcript-footer')).toBeNull()
    const line = screen.getByTestId('opened-for-message')
    expect(line).toHaveTextContent('Opened for your message “ship the fix today”')
    fireEvent.click(within(line).getByRole('button', { name: '“ship the fix today”' }))
    // its agent's inbox — the agent page, with this conversation as the way back
    expect(useStore.getState().tab).toBe('inbox')
    expect(useStore.getState().agentFrom).toEqual({ folder: 'f', id: 'm1' })
  })

  it("in chat, a conversation opened for an agent's message keeps its composer and names the sender", async () => {
    seed([makeSession('m2', 'Close Q3', { origin: { kind: 'message', messageId: 'msg-2', from: 'a1', gist: 'close Q3' } })], 'chat')
    render(<AgentPage />)
    await act(async () => {
      await useStore.getState().openSession('f', 'm2')
    })
    await waitFor(() => expect(composer()).toBeTruthy())
    expect(screen.queryByTestId('transcript-footer')).toBeNull()
    expect(screen.getByTestId('opened-for-message')).toHaveTextContent("Opened for Ana's message “close Q3”")
  })

  // births (plugin 0.7.0): a nested run — an agent's own `claude -p` —
  // is a transcript like an automation run; its one way out is the
  // conversation whose claude ran it.
  it('a nested run is read-only, never a console, and points at the conversation that ran it', async () => {
    seed(
      [
        makeSession('p1', 'Release prep', { mtime: Date.now() - 60_000 }),
        makeSession('n1', 'Run the smoke suite', { origin: { kind: 'nested', parent: 'p1', agentId: 'a1' } }),
      ],
      'console',
    )
    render(<AgentPage />)
    await act(async () => {
      await useStore.getState().openSession('f', 'n1')
    })
    await waitFor(() => expect(screen.getByText('transcript of n1')).toBeTruthy())
    expect(mockedApi.console).not.toHaveBeenCalled()
    expect(composer()).toBeNull()
    expect(footer().getAttribute('title')).toMatch(/Nested run.*“Release prep”/)
    fireEvent.click(within(footer()).getByRole('button', { name: 'Open the conversation that ran it ›' }))
    await waitFor(() => expect(useStore.getState().selected?.id).toBe('p1'))
  })

  it('a loose nested run (parent unknown) is read-only with no way out', async () => {
    seed([makeSession('n1', 'Run the smoke suite', { origin: { kind: 'nested', parent: null, agentId: 'a1' } })], 'console')
    render(<AgentPage />)
    await act(async () => {
      await useStore.getState().openSession('f', 'n1')
    })
    await waitFor(() => expect(screen.getByText('transcript of n1')).toBeTruthy())
    expect(mockedApi.console).not.toHaveBeenCalled()
    expect(footer().getAttribute('title')).toMatch(/Nested run of Ana/)
    expect(within(footer()).queryByRole('button')).toBeNull()
  })

  // a nested run outside the capped overview (⌘K, a link)
  // has no row in the agents list — the open detail's own origin decides.
  it('a nested run missing from the overview still opens read-only, from its detail', async () => {
    seed([], 'console')
    mockedApi.sessionDetail.mockImplementation(async (_f: string, id: string) => ({
      ...makeDetail(id),
      meta: makeSession(id, 'Off-list run', { origin: { kind: 'nested', parent: null, agentId: 'a1' } }),
    }))
    render(<AgentPage />)
    await act(async () => {
      await useStore.getState().openSession('f', 'n9', { exact: true })
    })
    // the console may be ASKED before the detail lands (the server refuses
    // a nested run with 409); once the detail says what it is, the window
    // is a read-only transcript — never a live composer.
    await waitFor(() => expect(screen.getByText('transcript of n9')).toBeTruthy())
    expect(composer()).toBeNull()
    expect(footer().getAttribute('title')).toMatch(/Nested run of Ana/)
  })

  // the console route's 409 names the run — the window goes
  // read-only on it at once, without waiting for the detail (which here
  // never arrives), and never offers the live-chat fallback.
  it('a 409 from the console naming a nested run is read-only at once', async () => {
    seed([], 'console')
    mockedApi.sessionDetail.mockImplementation(() => new Promise(() => {}))
    mockedApi.console.mockRejectedValue(
      Object.assign(new Error('nested run'), { status: 409, body: { error: 'nested run', nested: true, parent: null, agentId: 'a1' } }),
    )
    render(<AgentPage />)
    act(() => {
      useStore.setState({ selected: { folder: 'f', id: 'n7' } })
    })
    await waitFor(() => expect(footer().getAttribute('title')).toMatch(/Nested run of Ana/))
    expect(composer()).toBeNull()
    expect(screen.queryByText(/Couldn't open the real console/)).toBeNull()
    expect(screen.queryByRole('button', { name: 'View in chat instead' })).toBeNull()
  })

  it('a console that could not open keeps the chat live: a strip above the composer names the error and offers a retry', async () => {
    mockedApi.console.mockRejectedValue(new Error('spawn failed'))
    seed([makeSession('s1', 'First')], 'console')
    render(<AgentPage />)
    await act(async () => {
      await useStore.getState().openSession('f', 's1')
    })
    await waitFor(() => expect(screen.getByText(/Couldn't open the real console/)).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'View in chat instead' }))
    await waitFor(() => expect(screen.getByText('transcript of s1')).toBeTruthy())
    expect(composer()).not.toBeNull()
    expect(screen.queryByTestId('transcript-footer')).toBeNull()
    const strip = screen.getByTestId('console-fallback')
    expect(strip.textContent).toMatch(/spawn failed/)
    const before = mockedApi.console.mock.calls.length
    fireEvent.click(within(strip).getByRole('button', { name: /Retry/ }))
    await waitFor(() => expect(mockedApi.console.mock.calls.length).toBeGreaterThan(before))
  })

  it("chat by choice is a live window: the composer, no footer, and the band's selector opens the real console", async () => {
    seed([makeSession('s1', 'First')], 'chat')
    render(<AgentPage />)
    await act(async () => {
      await useStore.getState().openSession('f', 's1')
    })
    await waitFor(() => expect(screen.getByText('transcript of s1')).toBeTruthy())
    expect(mockedApi.console).not.toHaveBeenCalled()
    expect(composer()).not.toBeNull()
    expect(screen.queryByTestId('transcript-footer')).toBeNull()
    expect(screen.queryByTestId('view-reason')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /Real console/ }))
    await waitFor(() => expect(mockedApi.console).toHaveBeenCalled())
    expect(useStore.getState().chatMode).toBe('console')
  })

  it('the live console itself shows no footer', async () => {
    seed([makeSession('s1', 'First')], 'console')
    render(<AgentPage />)
    await act(async () => {
      await useStore.getState().openSession('f', 's1')
    })
    await waitFor(() => expect(mockedApi.console).toHaveBeenCalled())
    expect(screen.queryByTestId('transcript-footer')).toBeNull()
  })

  it('a conversation idle for over a day opens its console directly (wake on open) and says it was asleep', async () => {
    const now = Date.now()
    seed([makeSession('s1', 'Old', { mtime: now - 48 * 86_400_000 })], 'console')
    useStore.setState({ nowTick: now })
    render(<AgentPage />)
    await act(async () => {
      await useStore.getState().openSession('f', 's1')
    })
    await waitFor(() => expect(mockedApi.console).toHaveBeenCalled())
    expect(screen.queryByTestId('transcript-footer')).toBeNull()
    expect(await screen.findByTestId('console-woke')).toHaveTextContent(/asleep since/)
  })

  it('the "asleep" line leaves once the conversation has new activity', async () => {
    const now = Date.now()
    seed([makeSession('s1', 'Old', { mtime: now - 3 * 86_400_000 })], 'console')
    useStore.setState({ nowTick: now })
    render(<AgentPage />)
    await act(async () => {
      await useStore.getState().openSession('f', 's1')
    })
    expect(await screen.findByTestId('console-woke')).toBeTruthy()
    act(() => useStore.setState({ agents: [agentWith([makeSession('s1', 'Old', { mtime: now })])] }))
    await waitFor(() => expect(screen.queryByTestId('console-woke')).toBeNull())
  })

  it('a conversation touched an hour ago opens the console directly', async () => {
    const now = Date.now()
    seed([makeSession('s1', 'Recent', { mtime: now - 3_600_000 })], 'console')
    useStore.setState({ nowTick: now })
    render(<AgentPage />)
    await act(async () => {
      await useStore.getState().openSession('f', 's1')
    })
    await waitFor(() => expect(mockedApi.console).toHaveBeenCalled())
    expect(screen.queryByTestId('transcript-footer')).toBeNull()
    expect(screen.queryByTestId('console-woke')).toBeNull()
  })

  it('idle and in chat mode is just chat — flipping to the real console opens it', async () => {
    seed([makeSession('s1', 'Old', { mtime: Date.now() - 48 * 86_400_000 })], 'chat')
    render(<AgentPage />)
    await act(async () => {
      await useStore.getState().openSession('f', 's1')
    })
    await waitFor(() => expect(screen.getByText('transcript of s1')).toBeTruthy())
    expect(composer()).not.toBeNull()
    expect(screen.queryByTestId('transcript-footer')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /Real console/ }))
    await waitFor(() => expect(mockedApi.console).toHaveBeenCalled())
  })
})

// «Sign in ›» (spec tools-origin §9): the sentence a new console was
// opened to send sits beside THAT console to copy — Silos never types it
// (no documented prefill; typing into tmux for the owner is refused), and
// it follows the console to the conversation it becomes, never another.
describe('the sentence beside a new console (consoleCue)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    mockedApi.console.mockResolvedValue({ key: 'new-key', theme: 'dark' })
    mockedApi.sessionDetail.mockImplementation(async (_f: string, id: string) => makeDetail(id))
    mockedApi.markSeen.mockResolvedValue(undefined as never)
    mockedApi.conversationPrefs = { get: vi.fn().mockResolvedValue(null), patch: vi.fn() } as never
    mockedApi.agents = {} as never
  })

  it("shows beside its agent's new console, is pinned to its key, stays with that conversation, and is never sent", async () => {
    seed([makeSession('s1', 'First'), makeSession('new-key', 'Sign-in')], 'console')
    useStore.setState({ consoleCue: { agentId: 'a1', console: null, text: 'Sign me in to "x"' }, newChatOpen: true })
    render(<AgentPage />)
    const cue = await screen.findByTestId('console-cue')
    expect(within(cue).getByTestId('console-cue-text').textContent).toBe('Sign me in to "x"')
    // a NEW console of its agent — nothing typed nor sent for the owner
    expect(mockedApi.console).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'a1' }))
    expect(mockedApi.console.mock.calls[0]![0].sessionId).toBeUndefined()
    expect(mockedApi.chat).not.toHaveBeenCalled()
    await waitFor(() => expect(useStore.getState().consoleCue?.console).toBe('new-key'))
    // another conversation: not there
    await act(async () => {
      await useStore.getState().openSession('f', 's1')
    })
    await waitFor(() => expect(mockedApi.console).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 's1' })))
    expect(screen.queryByTestId('console-cue')).toBeNull()
    // the conversation the console became: still there; × drops it
    await act(async () => {
      await useStore.getState().openSession('f', 'new-key', { exact: true })
    })
    fireEvent.click(within(await screen.findByTestId('console-cue')).getByRole('button', { name: 'Hide this sentence' }))
    expect(useStore.getState().consoleCue).toBeNull()
  })
})

// a 49-day-old terminal thread once read "Idle for 49d — a
// transcript" and, right under it, "Terminal session — following live".
// "following live" is a claim about NOW: only while the session is live,
// and only beside a reason that keeps THIS conversation as the place to go on.
describe('the terminal banner never contradicts the window', () => {
  const now = Date.now()
  const live = now - 10_000
  const old = now - 49 * 86_400_000
  const reasons: [string, ViewReason | null, boolean][] = [
    ['no reason (live console)', null, true],
    ['chat by choice', { kind: 'chat' }, true],
    ['console fallback', { kind: 'fallback', error: 'x' }, true],
    ['older rotation', { kind: 'superseded', tip: null, cleared: false }, false],
    ['automation run', { kind: 'run', automationId: 'au1' }, false],
  ]
  for (const [name, reason, whenLive] of reasons) {
    it(`${name}: ${whenLive ? 'shown while live' : 'never shown'}, never when not live`, () => {
      expect(terminalBannerShows(false, live, now, reason)).toBe(whenLive)
      expect(terminalBannerShows(false, old, now, reason)).toBe(false)
    })
  }
  it('a Silos-native session never shows it', () => {
    expect(terminalBannerShows(true, live, now, { kind: 'chat' })).toBe(false)
    expect(terminalBannerShows(undefined, live, now, { kind: 'chat' })).toBe(false)
  })

  beforeEach(() => {
    vi.clearAllMocks()
    mockedApi.sessionDetail.mockImplementation(async (_f: string, id: string) => makeDetail(id))
    mockedApi.markSeen.mockResolvedValue(undefined as never)
    mockedApi.conversationPrefs = { get: vi.fn().mockResolvedValue(null), patch: vi.fn() } as never
    mockedApi.agents = {} as never
  })

  it('a 49-day-old terminal thread wakes its console and says nothing about following live', async () => {
    seed([makeSession('s1', 'Old', { mtime: old })], 'console')
    useStore.setState({ nowTick: now })
    render(<AgentPage />)
    await act(async () => {
      await useStore.getState().openSession('f', 's1')
    })
    await waitFor(() => expect(mockedApi.console).toHaveBeenCalled())
    expect(await screen.findByTestId('console-woke')).toHaveTextContent(/asleep since/)
    expect(screen.queryByText(/following live/)).toBeNull()
    expect(screen.queryByTestId('transcript-footer')).toBeNull()
  })

  it('a live terminal thread in chat mode follows live', async () => {
    seed([makeSession('s1', 'Fresh', { mtime: live })], 'chat')
    useStore.setState({ nowTick: now })
    render(<AgentPage />)
    await act(async () => {
      await useStore.getState().openSession('f', 's1')
    })
    await waitFor(() => expect(screen.getByText('transcript of s1')).toBeTruthy())
    expect(screen.getByText(/following live/)).toBeTruthy()
  })
})
