// store-cockpit.test.ts — the cockpit cascade's behavior in the store: the
// one-shot is consumed on send (both direct AND queued), a new chat's
// pending prefs get assigned to the real conversation on its chat-init, and
// the init's echo lands in active.echo.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useStore } from '../src/store'
import { api } from '../src/lib/api'
import type { AgentView, SessionDetail, SessionView } from '../src/lib/types'

vi.mock('../src/lib/api')
const mockedApi = vi.mocked(api, { deep: true })

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
    size: 1,
    turnCount: 1,
    live: false,
    worktree: false,
    native: true,
    agentId: 'a1',
    ...overrides,
  }
}
function makeDetail(overrides: Partial<SessionView> = {}): SessionDetail {
  return { meta: makeSession(overrides), turns: [], total: 0 }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockedApi.chat.mockResolvedValue({ turnId: 't1' })
  mockedApi.sessionDetail.mockResolvedValue(makeDetail())
  mockedApi.conversationPrefs.get.mockResolvedValue({})
  mockedApi.conversationPrefs.patch.mockResolvedValue({})
  useStore.setState({
    // the open session must belong to the agent (sessionBelongsToAgent) —
    // otherwise send() would treat it as a new chat.
    agents: [makeAgent({ model: 'sonnet', sessions: [makeSession()] })],
    selectedAgentId: 'a1',
    selected: { folder: 'f', id: 's1' },
    detail: makeDetail(),
    active: null,
    queue: [],
    catalog: [],
    convPrefs: {},
    pendingConvPrefs: {},
    turnOverrides: {},
    chosenProject: null,
  })
})

describe('the one-shot on send', () => {
  it('the turn override travels in the POST and clears (a real one-shot)', async () => {
    useStore.setState({ turnOverrides: { effort: 'max' } })
    await useStore.getState().send('go')
    expect(mockedApi.chat).toHaveBeenCalledWith('a1', 'go', { folder: 'f', id: 's1' }, undefined, { effort: 'max' })
    expect(useStore.getState().turnOverrides).toEqual({})
  })

  it('with no overrides, the 5th argument does not travel (byte-identical to always)', async () => {
    await useStore.getState().send('go')
    expect(mockedApi.chat).toHaveBeenCalledWith('a1', 'go', { folder: 'f', id: 's1' })
  })

  it("active.requested reflects the requested cascade (conv prefs + one-shot over the agent's default)", async () => {
    useStore.setState({ convPrefs: { permissionMode: 'plan' }, turnOverrides: { model: 'haiku' } })
    await useStore.getState().send('go')
    expect(useStore.getState().active?.requested).toEqual({ model: 'haiku', permissionMode: 'plan' })
  })

  it('queued while streaming: the one-shot is captured on the item and consumed all the same', async () => {
    useStore.setState({
      active: { turnId: 't0', agentId: 'a1', text: '', tools: [], status: 'streaming', userText: 'previous' },
      turnOverrides: { permissionMode: 'plan' },
    })
    await useStore.getState().send('in queue')
    expect(useStore.getState().queue).toEqual([
      // convPrefs: a snapshot of the destination when queued — empty here
      { text: 'in queue', agentId: 'a1', session: { folder: 'f', id: 's1' }, overrides: { permissionMode: 'plan' }, convPrefs: {} },
    ])
    expect(useStore.getState().turnOverrides).toEqual({}) // consumed when queued
  })
})

describe('a new chat — pending prefs', () => {
  beforeEach(() => {
    useStore.setState({ selected: null, detail: null })
  })

  it('setConversationPref with no session goes to pendingConvPrefs (nothing to PATCH yet)', () => {
    useStore.getState().setConversationPref({ model: 'haiku' })
    expect(useStore.getState().pendingConvPrefs).toEqual({ model: 'haiku' })
    expect(mockedApi.conversationPrefs.patch).not.toHaveBeenCalled()
  })

  it("pending prefs travel as the first turn's overrides and chat-init assigns them to the real conversation", async () => {
    useStore.getState().setConversationPref({ model: 'haiku' })
    await useStore.getState().send('first message')
    expect(mockedApi.chat).toHaveBeenCalledWith('a1', 'first message', undefined, undefined, { model: 'haiku' })

    useStore.getState().applyWs({ ev: 'chat-init', turnId: 't1', folder: '-fx', sessionId: 'new' })
    expect(mockedApi.conversationPrefs.patch).toHaveBeenCalledWith('-fx', 'new', { model: 'haiku' })
    expect(useStore.getState().convPrefs).toEqual({ model: 'haiku' })
    expect(useStore.getState().pendingConvPrefs).toEqual({})
  })
})

describe("forking: the UI never shows another key's prefs", () => {
  it("isFork: convPrefs resets instantly and refetches for the new branch's key", async () => {
    // the source conversation is open with plan mode set
    useStore.setState({
      selected: { folder: 'f', id: 's1' },
      convPrefs: { permissionMode: 'plan' },
      active: { turnId: 't1', agentId: 'a1', text: '', tools: [], status: 'streaming', userText: 'x' },
    })
    // the server already copied the source's prefs to the branch, server-side
    mockedApi.conversationPrefs.get.mockResolvedValue({ permissionMode: 'plan' })

    useStore.getState().applyWs({ ev: 'chat-init', turnId: 't1', folder: 'f', sessionId: 'branch' })
    // an immediate reset: between the init and the fetch, never another key's truth
    expect(useStore.getState().convPrefs).toEqual({})
    await vi.waitFor(() => {
      expect(useStore.getState().convPrefs).toEqual({ permissionMode: 'plan' })
    })
    expect(mockedApi.conversationPrefs.get).toHaveBeenCalledWith('f', 'branch')
  })

  it('isFork with a source that has no prefs: the branch stays clean ({})', async () => {
    useStore.setState({
      selected: { folder: 'f', id: 's1' },
      convPrefs: { permissionMode: 'plan' }, // stale state that must NOT survive
      active: { turnId: 't1', agentId: 'a1', text: '', tools: [], status: 'streaming', userText: 'x' },
    })
    mockedApi.conversationPrefs.get.mockResolvedValue({})
    useStore.getState().applyWs({ ev: 'chat-init', turnId: 't1', folder: 'f', sessionId: 'branch' })
    expect(useStore.getState().convPrefs).toEqual({})
    await vi.waitFor(() => {
      expect(mockedApi.conversationPrefs.get).toHaveBeenCalledWith('f', 'branch')
    })
    expect(useStore.getState().convPrefs).toEqual({})
  })
})

describe('draining the queue uses the convPrefs captured when QUEUED', () => {
  it("queue for A (plan), navigate (prefs change), drain → requested carries A's", async () => {
    vi.useFakeTimers()
    try {
      useStore.setState({
        convPrefs: { permissionMode: 'plan' },
        active: { turnId: 't0', agentId: 'a1', text: '', tools: [], status: 'streaming', userText: 'previous' },
      })
      await useStore.getState().send('in queue')
      expect(useStore.getState().queue[0]!.convPrefs).toEqual({ permissionMode: 'plan' })

      // the user navigates: the visible prefs are now for ANOTHER conversation
      useStore.setState({ convPrefs: {} })

      mockedApi.chat.mockResolvedValue({ turnId: 't1' })
      useStore.getState().applyWs({ ev: 'chat-done', turnId: 't0', subtype: 'success', costUsd: null })
      vi.advanceTimersByTime(200) // CLEAR_ACTIVE_DELAY_MS + margin → drains
      await Promise.resolve()
      await Promise.resolve()

      await vi.waitFor(() => {
        expect(useStore.getState().active?.turnId).toBe('t1')
      })
      expect(useStore.getState().active?.requested).toEqual({ model: 'sonnet', permissionMode: 'plan' })
    } finally {
      vi.useRealTimers()
    }
  })
})

describe("the init's echo + loading prefs", () => {
  it('chat-init stores the echo (model/permissionMode) in active.echo', async () => {
    await useStore.getState().send('go')
    useStore.getState().applyWs({ ev: 'chat-init', turnId: 't1', folder: 'f', sessionId: 's1', model: 'claude-sonnet-5', permissionMode: 'bypassPermissions' })
    expect(useStore.getState().active?.echo).toEqual({ model: 'claude-sonnet-5', permissionMode: 'bypassPermissions' })
  })

  it("openSession resets the visible cascade and loads THAT conversation's prefs", async () => {
    useStore.setState({ convPrefs: { model: 'old' }, turnOverrides: { effort: 'low' } })
    mockedApi.conversationPrefs.get.mockResolvedValue({ permissionMode: 'plan' })
    await useStore.getState().openSession('f', 's1')
    expect(useStore.getState().turnOverrides).toEqual({})
    await vi.waitFor(() => {
      expect(useStore.getState().convPrefs).toEqual({ permissionMode: 'plan' })
    })
    expect(mockedApi.conversationPrefs.get).toHaveBeenCalledWith('f', 's1')
  })

  it('setConversationPref with a session: optimistic + PATCH; null clears the field', () => {
    useStore.setState({ convPrefs: { model: 'haiku', effort: 'low' } })
    useStore.getState().setConversationPref({ effort: null })
    expect(useStore.getState().convPrefs).toEqual({ model: 'haiku' })
    expect(mockedApi.conversationPrefs.patch).toHaveBeenCalledWith('f', 's1', { effort: null })
  })
})
