// console-fallback.test.tsx — when the real console can't open (dead cwd,
// spawn failure), "View in chat instead" must be a LOCAL fallback for that
// conversation view, never a flip of the global sticky chatMode: the owner
// fell back once and every conversation opened in chat forever, with no way
// back to the real console (the Console|Chat selector is hidden once a
// conversation has started). Regression for a real bug.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { act } from 'react'
import { AgentPage } from '../src/components/AgentPage'
import { useStore } from '../src/store'
import { api, ApiError } from '../src/lib/api'
import type { AgentView, SessionDetail, SessionView } from '../src/lib/types'

vi.mock('../src/lib/api')
const mockedApi = vi.mocked(api, { deep: true })

function makeSession(id: string, title: string): SessionView {
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
  }
}

function makeDetail(id: string, text: string): SessionDetail {
  return {
    meta: makeSession(id, `title ${id}`),
    turns: [{ index: 0, role: 'user', text, tools: [], ts: '2026-08-30T10:00:00.000Z' }],
    total: 1,
  }
}

const agent: AgentView = {
  id: 'a1',
  name: 'Ana',
  emoji: '🧠',
  folder: '/tmp/ana',
  skills: [],
  sessions: [makeSession('s1', 'First'), makeSession('s2', 'Second')],
  liveCount: 0,
  sessionCount: 2,
}

describe('console error fallback', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    useStore.setState({
      agents: [agent],
      selected: null,
      detail: null,
      selectedAgentId: 'a1',
      page: { kind: 'agent', id: 'a1' },
      chatMode: 'console',
    })
    mockedApi.console.mockRejectedValue(new Error('spawn failed'))
    mockedApi.sessionDetail.mockImplementation(async (_f: string, id: string) => makeDetail(id, id === 's1' ? 'transcript of s1' : 'transcript of s2'))
    mockedApi.markSeen.mockResolvedValue(undefined as never)
    mockedApi.conversationPrefs = { get: vi.fn().mockResolvedValue(null), patch: vi.fn() } as never
    mockedApi.agents = {} as never
  })

  it('"View in chat instead" falls back locally: the sticky mode stays console', async () => {
    render(<AgentPage />)
    await act(async () => {
      await useStore.getState().openSession('f', 's1')
    })
    await waitFor(() => expect(screen.getByText(/Couldn't open the real console/)).toBeTruthy())
    // the console pane tells the context column it's on screen (the column
    // then leaves an open question to Claude's own dialog)
    expect(useStore.getState().consoleShown).toBe('f/s1')

    fireEvent.click(screen.getByRole('button', { name: 'View in chat instead' }))
    // the conversation is readable in chat…
    await waitFor(() => expect(screen.getByText('transcript of s1')).toBeTruthy())
    expect(useStore.getState().consoleShown).toBeNull()
    // …but the global sticky mode was NOT flipped: nothing persisted, and
    // the next conversation will try the real console again.
    expect(useStore.getState().chatMode).toBe('console')
    expect(localStorage.getItem('silos.chatMode')).toBeNull()
  })

  it('switching to another conversation retries the real console', async () => {
    render(<AgentPage />)
    await act(async () => {
      await useStore.getState().openSession('f', 's1')
    })
    await waitFor(() => expect(screen.getByText(/Couldn't open the real console/)).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'View in chat instead' }))
    await waitFor(() => expect(screen.getByText('transcript of s1')).toBeTruthy())

    const callsBefore = mockedApi.console.mock.calls.length
    await act(async () => {
      await useStore.getState().openSession('f', 's2')
    })
    // the new conversation tried the console again (and failed again —
    // the error view is back, with the same local escape hatch).
    await waitFor(() => expect(mockedApi.console.mock.calls.length).toBeGreaterThan(callsBefore))
    await waitFor(() => expect(screen.getByText(/Couldn't open the real console/)).toBeTruthy())
  })

  // an older piece of a split thread: the server answers 409 with the tip it
  // continues in — the console opens THERE, never an error to read
  it("a 409 naming the thread's tip opens the tip instead of an error", async () => {
    const superseded = Object.assign(Object.create(ApiError.prototype) as Error, {
      message: 'this thread continues in a newer conversation',
      status: 409,
      body: { error: 'this thread continues in a newer conversation', tip: 'f/s2' },
    })
    mockedApi.console.mockImplementation(async (input: { sessionId?: string }) => {
      if (input.sessionId === 's1') throw superseded
      // the tip's console stays «opening»: the jump is what is under test
      return new Promise<never>(() => {})
    })
    render(<AgentPage />)
    await act(async () => {
      await useStore.getState().openSession('f', 's1')
    })
    await waitFor(() => expect(useStore.getState().selected).toEqual({ folder: 'f', id: 's2' }))
    expect(screen.queryByText(/Couldn't open the real console/)).toBeNull()
  })

  // the web's idea of the tip can land back on the same conversation: the
  // view must say why, never hang on «Opening the real console…»
  it('a 409 tip that does not move the view ends in the error, not an endless opening', async () => {
    const superseded = Object.assign(Object.create(ApiError.prototype) as Error, {
      message: 'this thread continues in a newer conversation',
      status: 409,
      body: { tip: 'f/s1' },
    })
    mockedApi.console.mockRejectedValue(superseded)
    render(<AgentPage />)
    await act(async () => {
      await useStore.getState().openSession('f', 's1')
    })
    await waitFor(() => expect(screen.getByText(/Couldn't open the real console/)).toBeTruthy())
  })
})
