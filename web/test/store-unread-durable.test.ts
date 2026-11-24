import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useStore } from '../src/store'
import { api } from '../src/lib/api'
import type { AgentView, SessionView } from '../src/lib/types'

vi.mock('../src/lib/api')
const mockedApi = vi.mocked(api, { deep: true })

function makeSession(overrides: Partial<SessionView> = {}): SessionView {
  return {
    id: 's1',
    folder: 'f',
    title: 'Session',
    skills: [],
    cwd: null,
    mtime: 1,
    size: 10,
    turnCount: 1,
    live: false,
    worktree: false,
    native: false,
    agentId: 'a1',
    ...overrides,
  }
}
function makeAgent(overrides: Partial<AgentView> = {}): AgentView {
  return { id: 'a1', name: 'Ana', emoji: '🧠', folder: '/x', skills: [], sessions: [], liveCount: 0, sessionCount: 0, ...overrides }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockedApi.markSeen.mockResolvedValue(undefined)
  mockedApi.conversationPrefs.get.mockResolvedValue({})
})
afterEach(() => {
  vi.restoreAllMocks()
})

// durable unread — the interplay between the durable layer (session.unread,
// server) and the in-memory one (unreadAgentIds, a live pulse). Opening a
// conversation clears BOTH for that conversation/agent, and they don't fight.
describe('openSession and durable unread', () => {
  it('marks it seen on disk (api.markSeen) and clears session.unread optimistically', async () => {
    const unread = makeSession({ id: 's1', unread: true })
    useStore.setState({ agents: [makeAgent({ sessions: [unread] })], selectedAgentId: 'a1' })
    mockedApi.sessionDetail.mockResolvedValue({ meta: makeSession({ id: 's1', unread: true }), turns: [], total: 0 })

    await useStore.getState().openSession('f', 's1')

    expect(mockedApi.markSeen).toHaveBeenCalledWith('f', 's1')
    const s = useStore.getState().agents[0]!.sessions.find((x) => x.id === 's1')!
    expect(s.unread).toBe(false) // cleared optimistically, without waiting for the next overview
  })

  it("opening clears the agent's unreadAgentIds (memory) AND the conversation's durable flag — they don't clash", async () => {
    const unread = makeSession({ id: 's1', unread: true })
    useStore.setState({
      agents: [makeAgent({ sessions: [unread] })],
      selectedAgentId: 'a1',
      unreadAgentIds: new Set(['a1']), // a live pulse had marked the agent
    })
    mockedApi.sessionDetail.mockResolvedValue({ meta: makeSession({ id: 's1', unread: true }), turns: [], total: 0 })

    await useStore.getState().openSession('f', 's1')

    expect(useStore.getState().unreadAgentIds.has('a1')).toBe(false) // the memory layer is clear
    const s = useStore.getState().agents[0]!.sessions.find((x) => x.id === 's1')!
    expect(s.unread).toBe(false) // the durable layer is clear
  })

  it("when a turn ends in the OPEN and visible conversation, re-marks it seen (durable) — the dot doesn't reappear where you're looking", async () => {
    mockedApi.sessionDetail.mockResolvedValue({ meta: makeSession({ id: 's1', unread: true }), turns: [], total: 0 })
    useStore.setState({
      agents: [makeAgent({ sessions: [makeSession({ id: 's1', unread: true })] })],
      selectedAgentId: 'a1',
      selected: { folder: 'f', id: 's1' },
      active: {
        turnId: 't1',
        agentId: 'a1',
        text: '',
        tools: [],
        status: 'streaming',
        userText: '',
        sessionKey: 'f/s1',
      },
    })
    useStore.getState().applyWs({ ev: 'chat-done', turnId: 't1', subtype: 'result', costUsd: 0 })
    await Promise.resolve()
    expect(mockedApi.markSeen).toHaveBeenCalledWith('f', 's1')
    const s = useStore.getState().agents[0]!.sessions.find((x) => x.id === 's1')!
    expect(s.unread).toBe(false)
    // and it was NOT marked unread in memory (you were watching it)
    expect(useStore.getState().unreadAgentIds.has('a1')).toBe(false)
  })

  it('a later overview that no longer marks unread leaves the conversation up to date (confirms the optimistic update)', async () => {
    useStore.setState({ agents: [makeAgent({ sessions: [makeSession({ id: 's1', unread: true })] })] })
    mockedApi.overview.mockResolvedValue({
      agents: [makeAgent({ sessions: [makeSession({ id: 's1', unread: false })] })],
      now: 1,
      warming: false,
    })
    await useStore.getState().loadOverview()
    expect(useStore.getState().agents[0]!.sessions[0]!.unread).toBe(false)
  })
})
