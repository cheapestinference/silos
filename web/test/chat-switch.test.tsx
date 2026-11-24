// chat-switch.test.tsx — switching conversations in chat mode must REPLACE
// the transcript, never stack the previous one. Regression for a real bug
// Transcript and Composer were siblings keyed with the SAME
// value (`folder/id`) — React's duplicate-key reconciliation left the old
// Transcript's DOM mounted on every switch, so conversations piled up in
// the same view until a full reload.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { act } from 'react'
import { AgentPage } from '../src/components/AgentPage'
import { useStore } from '../src/store'
import { api } from '../src/lib/api'
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
    turns: [
      { index: 0, role: 'user', text, tools: [], ts: '2026-08-30T10:00:00.000Z' },
      { index: 1, role: 'assistant', text: `reply for ${id}`, tools: [], ts: '2026-08-30T10:00:05.000Z' },
    ],
    total: 2,
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

describe('switching conversations in chat mode', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useStore.setState({
      agents: [agent],
      selected: null,
      detail: null,
      selectedAgentId: 'a1',
      page: { kind: 'agent', id: 'a1' },
      chatMode: 'chat',
    })
    mockedApi.sessionDetail.mockImplementation(async (_f: string, id: string) => makeDetail(id, id === 's1' ? 'unique text of s1' : 'unique text of s2'))
    mockedApi.markSeen.mockResolvedValue(undefined as never)
    mockedApi.conversationPrefs = { get: vi.fn().mockResolvedValue(null), patch: vi.fn() } as never
    mockedApi.agents = {} as never
  })

  it('the previous transcript unmounts when opening another conversation', async () => {
    render(<AgentPage />)
    await act(async () => {
      await useStore.getState().openSession('f', 's1')
    })
    await waitFor(() => expect(screen.getByText('unique text of s1')).toBeTruthy())
    await act(async () => {
      await useStore.getState().openSession('f', 's2')
    })
    await waitFor(() => expect(screen.getByText('unique text of s2')).toBeTruthy())
    expect(screen.queryByText('unique text of s1')).toBeNull()
    expect(screen.queryByText('reply for s1')).toBeNull()
  })

  it('switching back still renders exactly one copy', async () => {
    render(<AgentPage />)
    await act(async () => {
      await useStore.getState().openSession('f', 's1')
    })
    await waitFor(() => expect(screen.getByText('unique text of s1')).toBeTruthy())
    await act(async () => {
      await useStore.getState().openSession('f', 's2')
    })
    await waitFor(() => expect(screen.getByText('unique text of s2')).toBeTruthy())
    await act(async () => {
      await useStore.getState().openSession('f', 's1')
    })
    await waitFor(() => expect(screen.getAllByText('unique text of s1')).toHaveLength(1))
    expect(screen.queryByText('unique text of s2')).toBeNull()
  })
})
