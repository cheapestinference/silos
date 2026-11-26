import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useStore } from '../src/store'
import { api } from '../src/lib/api'
import { MASTER_ID } from '../src/lib/constants'
import type { AgentView, SessionCounts, SessionView } from '../src/lib/types'

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

beforeEach(() => {
  vi.clearAllMocks()
  useStore.setState({
    agents: [],
    warming: false,
    selectedAgentId: null,
    selected: null,
    detail: null,
    filter: '',
    active: null,
    execOut: null,
    modal: null,
    error: null,
    failedDraft: null,
    queue: [],
    userTextPersisted: false,
    connection: 'connected',
    unreadAgentIds: new Set(),
    chosenProject: null,
  })
})

describe('loadOverview', () => {
  it('populates agents and selects the first non-master agent with sessions', async () => {
    const master = makeAgent({ id: 'master', sessions: [] })
    const noSessions = makeAgent({ id: 'a-empty', sessions: [] })
    const withSessions = makeAgent({ id: 'a2', sessions: [makeSession()] })
    mockedApi.overview.mockResolvedValue({ agents: [master, noSessions, withSessions], now: 1, warming: false })

    await useStore.getState().loadOverview()

    expect(useStore.getState().agents).toEqual([master, noSessions, withSessions])
    expect(useStore.getState().selectedAgentId).toBe('a2')
    expect(useStore.getState().warming).toBe(false)
  })

  it('does not overwrite selectedAgentId if one was already set', async () => {
    useStore.setState({ selectedAgentId: 'already-chosen' })
    const withSessions = makeAgent({ id: 'a2', sessions: [makeSession()] })
    mockedApi.overview.mockResolvedValue({ agents: [withSessions], now: 1, warming: false })

    await useStore.getState().loadOverview()

    expect(useStore.getState().selectedAgentId).toBe('already-chosen')
  })

  // "indexing sessions…" once stayed under the logo after a server
  // restart — the resync read a warming index and nothing read it again.
  it('a list read while the index warms is read again until it is ready, then stops', async () => {
    vi.useFakeTimers()
    try {
      mockedApi.overview.mockReset()
      mockedApi.overview
        .mockResolvedValueOnce({ agents: [], now: 1, warming: true })
        .mockResolvedValueOnce({ agents: [], now: 2, warming: true })
        .mockResolvedValue({ agents: [makeAgent({ id: 'a2', sessions: [makeSession()] })], now: 3, warming: false })
      await useStore.getState().loadOverview()
      expect(useStore.getState().warming).toBe(true)
      await vi.advanceTimersByTimeAsync(2000)
      expect(mockedApi.overview).toHaveBeenCalledTimes(2)
      await vi.advanceTimersByTimeAsync(2000)
      expect(mockedApi.overview).toHaveBeenCalledTimes(3)
      expect(useStore.getState().warming).toBe(false)
      expect(useStore.getState().agents).toHaveLength(1)
      await vi.advanceTimersByTimeAsync(10_000)
      expect(mockedApi.overview).toHaveBeenCalledTimes(3)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('send', () => {
  it('with normal text calls api.chat, creates a streaming active, accumulates deltas, and chat-done finishes + refetches', async () => {
    vi.useFakeTimers()
    try {
      const agent = makeAgent({ id: 'a1', sessions: [makeSession({ folder: 'f', id: 's1' })] })
      useStore.setState({
        selectedAgentId: 'a1',
        agents: [agent],
        selected: { folder: 'f', id: 's1' },
        detail: {
          meta: makeSession({ folder: 'f', id: 's1' }),
          turns: [{ index: 0, role: 'user', text: 'hi', tools: [], ts: null }],
          total: 1,
        },
      })
      mockedApi.chat.mockResolvedValue({ turnId: 't1' })
      mockedApi.sessionDetail.mockResolvedValue({
        meta: makeSession({ folder: 'f', id: 's1' }),
        turns: [{ index: 1, role: 'assistant', text: 'response', tools: [], ts: null }],
        total: 2,
      })

      await useStore.getState().send('hi again')

      expect(mockedApi.chat).toHaveBeenCalledWith('a1', 'hi again', { folder: 'f', id: 's1' })
      expect(useStore.getState().active).toEqual({
        turnId: 't1',
        agentId: 'a1',
        text: '',
        tools: [],
        status: 'streaming',
        userText: 'hi again',
        sessionKey: 'f/s1',
        thinkingText: '',
        lastEvent: 'init',
        startedAt: expect.any(Number),
        requested: { permissionMode: 'bypassPermissions' },
      })

      // deltas accumulate in a buffer and apply in a single flush 80ms
      // later (a performance batching) — that timer must run before
      // reading the accumulated text.
      useStore.getState().applyWs({ ev: 'chat-delta', turnId: 't1', text: 'Hello' })
      useStore.getState().applyWs({ ev: 'chat-delta', turnId: 't1', text: ' world' })
      vi.advanceTimersByTime(80)
      expect(useStore.getState().active?.text).toBe('Hello world')

      useStore.getState().applyWs({ ev: 'chat-tool', turnId: 't1', name: 'Bash' })
      expect(useStore.getState().active?.tools).toEqual(['Bash'])

      useStore.getState().applyWs({ ev: 'chat-done', turnId: 't1', subtype: 'result', costUsd: 0.05 })
      expect(useStore.getState().active?.status).toBe('done')
      expect(useStore.getState().active?.costUsd).toBe(0.05)
      expect(mockedApi.sessionDetail).toHaveBeenCalledWith('f', 's1', 1)

      // let the refetch's microtasks run (doesn't depend on the fake timers)
      await Promise.resolve()
      await Promise.resolve()
      expect(useStore.getState().detail?.total).toBe(2)
      expect(useStore.getState().detail?.turns).toHaveLength(2)

      // at 100ms the active turn clears (it's already in the transcript)
      expect(useStore.getState().active).not.toBeNull()
      vi.advanceTimersByTime(100)
      expect(useStore.getState().active).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  // a session's chat-init can bring init's real slash commands — cached by
  // folder/sessionId key for the '/' menu.
  it("chat-init with slashCommands caches them under the session's key", () => {
    useStore.setState({
      active: {
        turnId: 't1',
        agentId: 'a1',
        text: '',
        tools: [],
        status: 'streaming',
        userText: 'x',
      },
      slashCommandsBySession: {},
    })
    useStore.getState().applyWs({
      ev: 'chat-init',
      turnId: 't1',
      folder: 'f',
      sessionId: 's1',
      slashCommands: ['clear', 'model', 'compact'],
    })
    expect(useStore.getState().slashCommandsBySession['f/s1']).toEqual(['clear', 'model', 'compact'])
  })

  it('chat-init with no slashCommands neither creates nor overwrites the commands entry', () => {
    useStore.setState({
      active: { turnId: 't2', agentId: 'a1', text: '', tools: [], status: 'streaming', userText: 'x' },
      slashCommandsBySession: { 'f/s2': ['previous'] },
    })
    useStore.getState().applyWs({ ev: 'chat-init', turnId: 't2', folder: 'f', sessionId: 's2' })
    // no field → whatever was there stays (here, the previous one intact)
    expect(useStore.getState().slashCommandsBySession['f/s2']).toEqual(['previous'])
  })

  // a successful chat-done leaves a turn receipt in store.receipts[sessionKey]
  // — the past-tense verb of the SAME turnId, a measured elapsed, and the
  // last chat-usage's tokens. A FAILED turn (chat-error, or chat-done with
  // an error subtype) leaves a failed receipt naming the error: the
  // ErrorStrip toast auto-dismisses in 8s, so without this the failure
  // vanishes for anyone not staring at the screen. Only a turn the USER
  // interrupted leaves nothing — that outcome was chosen, not suffered.
  it('a successful chat-done saves a turn receipt; a failed turn saves a failed one naming the error', async () => {
    vi.useFakeTimers()
    try {
      useStore.setState({
        selectedAgentId: 'a1',
        agents: [makeAgent({ id: 'a1', sessions: [makeSession({ folder: 'f', id: 's1' })] })],
        selected: { folder: 'f', id: 's1' },
        detail: { meta: makeSession({ folder: 'f', id: 's1' }), turns: [], total: 0 },
        receipts: {},
      })
      mockedApi.chat.mockResolvedValue({ turnId: 't1' })
      mockedApi.sessionDetail.mockResolvedValue({ meta: makeSession({ folder: 'f', id: 's1' }), turns: [], total: 0 })

      await useStore.getState().send('hi')
      // chat-init sets sessionKey — the receipt is saved under that key
      useStore.getState().applyWs({ ev: 'chat-init', turnId: 't1', folder: 'f', sessionId: 's1' })
      useStore.getState().applyWs({ ev: 'chat-usage', turnId: 't1', outputTokens: 79_200 })
      vi.advanceTimersByTime(80) // flushes the usage batch
      vi.advanceTimersByTime(86_000)
      useStore.getState().applyWs({ ev: 'chat-done', turnId: 't1', subtype: 'result', costUsd: 0 })

      const receipts = useStore.getState().receipts['f/s1']
      expect(receipts).toHaveLength(1)
      const { pastVerbForTurn } = await import('../src/lib/thinking-verbs')
      expect(receipts![0]!.verb).toBe(pastVerbForTurn('t1'))
      expect(receipts![0]!.outputTokens).toBe(79_200)
      expect(receipts![0]!.elapsedMs).toBeGreaterThanOrEqual(86_000)

      // a second turn failing via the SDK's exception path: a failed receipt
      vi.advanceTimersByTime(100) // clears active
      mockedApi.chat.mockResolvedValue({ turnId: 't2' })
      await useStore.getState().send('another')
      useStore.getState().applyWs({ ev: 'chat-init', turnId: 't2', folder: 'f', sessionId: 's1' })
      useStore.getState().applyWs({ ev: 'chat-error', turnId: 't2', error: 'boom' })
      const after = useStore.getState().receipts['f/s1']
      expect(after).toHaveLength(2)
      expect(after![1]!.error).toBe('boom')

      // a third turn failing via chat-done's error subtype: same rule
      vi.advanceTimersByTime(100)
      mockedApi.chat.mockResolvedValue({ turnId: 't3' })
      await useStore.getState().send('again')
      useStore.getState().applyWs({ ev: 'chat-init', turnId: 't3', folder: 'f', sessionId: 's1' })
      useStore.getState().applyWs({ ev: 'chat-done', turnId: 't3', subtype: 'error_during_execution', costUsd: 0 })
      const third = useStore.getState().receipts['f/s1']
      expect(third).toHaveLength(3)
      expect(third![2]!.error).toBe('error_during_execution')
    } finally {
      vi.useRealTimers()
    }
  })

  it("with '!command' calls api.exec, saves execOut, and doesn't touch active", async () => {
    useStore.setState({ selectedAgentId: 'a1', agents: [makeAgent({ id: 'a1' })], active: null })
    mockedApi.exec.mockResolvedValue({ stdout: 'out', stderr: '', code: 0, ms: 3, truncated: false })

    await useStore.getState().send('!ls -la')

    expect(mockedApi.exec).toHaveBeenCalledWith('a1', 'ls -la')
    expect(mockedApi.chat).not.toHaveBeenCalled()
    expect(useStore.getState().execOut).toEqual({ stdout: 'out', stderr: '', code: 0, ms: 3, truncated: false })
    expect(useStore.getState().active).toBeNull()
  })

  it("applies the turn's WS events that arrived BEFORE the POST resolved (a buffer)", async () => {
    // the buffered delta applies via the same batched path — fake timers to
    // let the 80ms flush run after draining the buffer.
    vi.useFakeTimers()
    try {
      useStore.setState({
        selectedAgentId: 'a1',
        agents: [makeAgent({ id: 'a1' })],
        active: null,
        selected: null,
        detail: null,
      })
      let resolveChat!: (v: { turnId: string }) => void
      mockedApi.chat.mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveChat = resolve
          }),
      )

      const pending = useStore.getState().send('hi')

      // the WS delivers the delta before the 202/POST resolves with the turnId
      useStore.getState().applyWs({ ev: 'chat-delta', turnId: 'T', text: 'ahead' })
      expect(useStore.getState().active).toBeNull()

      resolveChat({ turnId: 'T' })
      await pending

      expect(useStore.getState().active?.turnId).toBe('T')
      vi.advanceTimersByTime(80)
      expect(useStore.getState().active?.text).toBe('ahead')
    } finally {
      vi.useRealTimers()
    }
  })

  it('if api.chat fails, saves the global error and does NOT lose the text (failedDraft) nor leave active hanging', async () => {
    useStore.setState({ selectedAgentId: 'a1', agents: [makeAgent({ id: 'a1' })], active: null, error: null, failedDraft: null })
    mockedApi.chat.mockRejectedValueOnce(new Error('the server did not respond'))

    await useStore.getState().send('an important message')

    expect(useStore.getState().error).toBe('the server did not respond')
    // failedDraft carries the destination agent — a failure targeting
    // another agent (a queue drain) must not be restorable over the
    // composer of whichever agent is being viewed at that moment.
    expect(useStore.getState().failedDraft).toEqual({ agentId: 'a1', text: 'an important message' })
    expect(useStore.getState().active).toBeNull()
  })

  it('clears execOut when starting a normal chat (not when doing !exec)', async () => {
    useStore.setState({
      selectedAgentId: 'a1',
      agents: [makeAgent({ id: 'a1' })],
      active: null,
      execOut: { stdout: 'old', stderr: '', code: 0, ms: 1, truncated: false },
    })
    mockedApi.chat.mockResolvedValue({ turnId: 't9' })

    await useStore.getState().send('hi')

    expect(useStore.getState().execOut).toBeNull()
  })
})

describe('memory-mode send', () => {
  it('builds the memory preamble with the file content and appends the raw text', async () => {
    const agent = makeAgent({ id: 'a1', sessions: [makeSession({ folder: 'f', id: 's1' })] })
    useStore.setState({ selectedAgentId: 'a1', agents: [agent], selected: { folder: 'f', id: 's1' } })
    mockedApi.chat.mockResolvedValue({ turnId: 't1' })
    mockedApi.sessionDetail.mockResolvedValue({ meta: makeSession({ folder: 'f', id: 's1' }), turns: [], total: 0 })
    mockedApi.memory.read.mockResolvedValue('CURRENT CONTENT')

    await useStore.getState().send('append a line', { path: '/data/agents/a1/memory.md' })

    expect(mockedApi.memory.read).toHaveBeenCalledWith('/data/agents/a1/memory.md')
    const [agentId, sentText, session] = mockedApi.chat.mock.calls[0] as [string, string, unknown]
    expect(agentId).toBe('a1')
    expect(sentText).toContain('[silos-memory path=/data/agents/a1/memory.md]')
    expect(sentText).toContain('CURRENT CONTENT')
    expect(sentText.endsWith('\n\nappend a line')).toBe(true)
    expect(session).toEqual({ folder: 'f', id: 's1' })
    expect(useStore.getState().active?.memoryPath).toBe('/data/agents/a1/memory.md')
  })

  it('a failed read sends anyway, with empty prior content', async () => {
    const agent = makeAgent({ id: 'a1', sessions: [makeSession({ folder: 'f', id: 's1' })] })
    useStore.setState({ selectedAgentId: 'a1', agents: [agent], selected: { folder: 'f', id: 's1' } })
    mockedApi.chat.mockResolvedValue({ turnId: 't1' })
    mockedApi.sessionDetail.mockResolvedValue({ meta: makeSession({ folder: 'f', id: 's1' }), turns: [], total: 0 })
    mockedApi.memory.read.mockRejectedValue(new Error('ENOENT'))

    await useStore.getState().send('first note', { path: '/data/agents/a1/memory.md' })
    const [, sentText] = mockedApi.chat.mock.calls[0] as [string, string]
    expect(sentText).toContain('[silos-memory path=/data/agents/a1/memory.md]')
    expect(sentText).toContain('first note')
  })

  it('CRITICAL: switching conversation during the file read does NOT redirect the edit — it goes to the destination fixed at send time', async () => {
    const agentA = makeAgent({ id: 'A', sessions: [makeSession({ folder: 'fa', id: 'sa' })] })
    const agentB = makeAgent({ id: 'B', sessions: [makeSession({ folder: 'fb', id: 'sb' })] })
    useStore.setState({ selectedAgentId: 'A', agents: [agentA, agentB], selected: { folder: 'fa', id: 'sa' } })
    mockedApi.chat.mockResolvedValue({ turnId: 't1' })
    mockedApi.sessionDetail.mockResolvedValue({ meta: makeSession({ folder: 'fa', id: 'sa' }), turns: [], total: 0 })
    let resolveRead!: (v: string) => void
    mockedApi.memory.read.mockReturnValue(
      new Promise<string>((r) => {
        resolveRead = r
      }),
    )

    const p = useStore.getState().send('for A only', { path: '/data/agents/A/memory.md' })
    // the user navigates to B while the read is still pending
    useStore.setState({ selectedAgentId: 'B', selected: { folder: 'fb', id: 'sb' } })
    resolveRead('content')
    await p

    const [agentId, , session] = mockedApi.chat.mock.calls[0] as [string, string, unknown]
    expect(agentId).toBe('A') // captured at send time, not the current 'B'
    expect(session).toEqual({ folder: 'fa', id: 'sa' })
  })
})

describe('chat-thinking', () => {
  it('accumulates thinkingText and updates lastEvent; chat-delta and chat-tool update it too', async () => {
    // chat-thinking/chat-delta batch — the 80ms flush must run to see the
    // accumulated thinkingText before moving on.
    vi.useFakeTimers()
    try {
      useStore.setState({ selectedAgentId: 'a1', agents: [makeAgent({ id: 'a1' })], active: null })
      mockedApi.chat.mockResolvedValue({ turnId: 'T' })

      await useStore.getState().send('hi')

      useStore.getState().applyWs({ ev: 'chat-thinking', turnId: 'T', text: 'thinking ' })
      useStore.getState().applyWs({ ev: 'chat-thinking', turnId: 'T', text: 'thinking ' })
      vi.advanceTimersByTime(80)
      expect(useStore.getState().active?.thinkingText).toBe('thinking thinking ')
      expect(useStore.getState().active?.lastEvent).toBe('thinking')

      useStore.getState().applyWs({ ev: 'chat-delta', turnId: 'T', text: 'hi' })
      vi.advanceTimersByTime(80)
      expect(useStore.getState().active?.lastEvent).toBe('delta')

      // chat-tool doesn't batch: it forces its own immediate flush (nothing
      // pending here) and applies right away.
      useStore.getState().applyWs({ ev: 'chat-tool', turnId: 'T', name: 'Bash' })
      expect(useStore.getState().active?.lastEvent).toBe('tool')
    } finally {
      vi.useRealTimers()
    }
  })

  it('a chat-thinking that arrives BEFORE the POST resolves stays in the buffer and applies once the turn starts', async () => {
    // same idea — draining the pre-202 buffer goes through the same batched
    // path, so the 80ms flush must run.
    vi.useFakeTimers()
    try {
      useStore.setState({
        selectedAgentId: 'a1',
        agents: [makeAgent({ id: 'a1' })],
        active: null,
        selected: null,
        detail: null,
      })
      let resolveChat!: (v: { turnId: string }) => void
      mockedApi.chat.mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveChat = resolve
          }),
      )

      const pending = useStore.getState().send('hi')

      useStore.getState().applyWs({ ev: 'chat-thinking', turnId: 'T', text: 'ahead' })
      expect(useStore.getState().active).toBeNull()

      resolveChat({ turnId: 'T' })
      await pending

      expect(useStore.getState().active?.turnId).toBe('T')
      vi.advanceTimersByTime(80)
      expect(useStore.getState().active?.thinkingText).toBe('ahead')
      expect(useStore.getState().active?.lastEvent).toBe('thinking')
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('streaming performance — delta batching', () => {
  it('5 consecutive chat-delta apply nothing until 80ms pass; then arrive concatenated in order', () => {
    vi.useFakeTimers()
    try {
      useStore.setState({
        active: {
          turnId: 'T',
          agentId: 'a1',
          text: '',
          tools: [],
          status: 'streaming',
          userText: '',
          thinkingText: '',
          lastEvent: 'init',
        },
      })

      for (const chunk of ['a', 'b', 'c', 'd', 'e']) {
        useStore.getState().applyWs({ ev: 'chat-delta', turnId: 'T', text: chunk })
      }
      // no flush yet: 0 immediate sets, the text stays as it started
      expect(useStore.getState().active?.text).toBe('')

      vi.advanceTimersByTime(80)

      // a single set with everything accumulated, in arrival order
      expect(useStore.getState().active?.text).toBe('abcde')
    } finally {
      vi.useRealTimers()
    }
  })

  it('a chat-tool after 2 pending deltas forces the flush: deltas and tool apply in order', () => {
    vi.useFakeTimers()
    try {
      useStore.setState({
        active: {
          turnId: 'T',
          agentId: 'a1',
          text: '',
          tools: [],
          status: 'streaming',
          userText: '',
          thinkingText: '',
          lastEvent: 'init',
        },
      })

      useStore.getState().applyWs({ ev: 'chat-delta', turnId: 'T', text: 'Hello ' })
      useStore.getState().applyWs({ ev: 'chat-delta', turnId: 'T', text: 'world' })
      expect(useStore.getState().active?.text).toBe('') // still no flush

      useStore.getState().applyWs({ ev: 'chat-tool', turnId: 'T', name: 'Bash' })

      expect(useStore.getState().active?.text).toBe('Hello world') // a flush forced by the tool, BEFORE the tool
      expect(useStore.getState().active?.tools).toEqual(['Bash'])
      expect(useStore.getState().active?.lastEvent).toBe('tool')

      // no leftover timer that touches the state again
      vi.advanceTimersByTime(80)
      expect(useStore.getState().active?.text).toBe('Hello world')
      expect(useStore.getState().active?.tools).toEqual(['Bash'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('a buffered delta from turn A does not bleed into turn B if A is replaced before the flush', () => {
    // a real window: A's chat-done leaves `active` with turnId A for
    // CLEAR_ACTIVE_DELAY_MS before clearing it; if in that gap a direct send
    // starts turn B (replacing `active` entirely) while a delta from A was
    // still in pendingBatch, the 80ms flush must NOT mix A's text into B's active.
    vi.useFakeTimers()
    try {
      useStore.setState({
        active: {
          turnId: 'A',
          agentId: 'a1',
          text: '',
          tools: [],
          status: 'streaming',
          userText: '',
          thinkingText: '',
          lastEvent: 'init',
        },
      })

      // A's delta stays in the buffer (no flush yet)
      useStore.getState().applyWs({ ev: 'chat-delta', turnId: 'A', text: "A's text" })
      expect(useStore.getState().active?.text).toBe('')

      // B replaces active entirely (e.g. a queue drain / a new send) BEFORE
      // the 80ms timeout gets to fire
      useStore.setState({
        active: {
          turnId: 'B',
          agentId: 'a1',
          text: "B's text",
          tools: [],
          status: 'streaming',
          userText: '',
          thinkingText: '',
          lastEvent: 'init',
        },
      })

      vi.advanceTimersByTime(80)

      // A's orphaned delta is silently discarded — B's active stays intact,
      // no text bleed between turns
      expect(useStore.getState().active?.turnId).toBe('B')
      expect(useStore.getState().active?.text).toBe("B's text")
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('the activity tree — steps, subagents and tokens', () => {
  it('chat-usage (batched) sets outputTokens without touching the rest of active', () => {
    vi.useFakeTimers()
    try {
      useStore.setState({
        active: {
          turnId: 'T',
          agentId: 'a1',
          text: 'something',
          tools: [],
          status: 'streaming',
          userText: '',
          thinkingText: '',
          lastEvent: 'delta',
        },
      })

      useStore.getState().applyWs({ ev: 'chat-usage', turnId: 'T', outputTokens: 1234 })
      // no flush yet: not applied (batchable, like delta/thinking)
      expect(useStore.getState().active?.outputTokens).toBeUndefined()

      vi.advanceTimersByTime(80)

      expect(useStore.getState().active?.outputTokens).toBe(1234)
      expect(useStore.getState().active?.text).toBe('something') // doesn't disturb the rest
      expect(useStore.getState().active?.lastEvent).toBe('delta') // chat-usage doesn't change the phase
    } finally {
      vi.useRealTimers()
    }
  })

  it('a later chat-usage overwrites the previous value (accumulated exactly as the SDK gives it)', () => {
    vi.useFakeTimers()
    try {
      useStore.setState({
        active: { turnId: 'T', agentId: 'a1', text: '', tools: [], status: 'streaming', userText: '', thinkingText: '', lastEvent: 'init' },
      })
      useStore.getState().applyWs({ ev: 'chat-usage', turnId: 'T', outputTokens: 100 })
      vi.advanceTimersByTime(80)
      expect(useStore.getState().active?.outputTokens).toBe(100)

      useStore.getState().applyWs({ ev: 'chat-usage', turnId: 'T', outputTokens: 250 })
      vi.advanceTimersByTime(80)
      expect(useStore.getState().active?.outputTokens).toBe(250)
    } finally {
      vi.useRealTimers()
    }
  })

  // chat-usage with contextTokens populates active.contextTokens — the same
  // batched path as outputTokens (an 80ms buffer).
  it('chat-usage with contextTokens populates active.contextTokens', () => {
    vi.useFakeTimers()
    try {
      useStore.setState({
        active: { turnId: 'T', agentId: 'a1', text: '', tools: [], status: 'streaming', userText: '', thinkingText: '', lastEvent: 'init' },
      })

      useStore.getState().applyWs({ ev: 'chat-usage', turnId: 'T', outputTokens: 1234, contextTokens: 108_656 })
      vi.advanceTimersByTime(80)

      expect(useStore.getState().active?.contextTokens).toBe(108_656)
      expect(useStore.getState().active?.outputTokens).toBe(1234)
    } finally {
      vi.useRealTimers()
    }
  })

  // a chat-usage with NO contextTokens (the SDK doesn't always bring it)
  // must not erase a previously saved value.
  it('a chat-usage with no contextTokens does not erase the previously saved value', () => {
    vi.useFakeTimers()
    try {
      useStore.setState({
        active: { turnId: 'T', agentId: 'a1', text: '', tools: [], status: 'streaming', userText: '', thinkingText: '', lastEvent: 'init' },
      })

      useStore.getState().applyWs({ ev: 'chat-usage', turnId: 'T', outputTokens: 100, contextTokens: 50_000 })
      vi.advanceTimersByTime(80)
      expect(useStore.getState().active?.contextTokens).toBe(50_000)

      useStore.getState().applyWs({ ev: 'chat-usage', turnId: 'T', outputTokens: 150 }) // no contextTokens
      vi.advanceTimersByTime(80)
      expect(useStore.getState().active?.contextTokens).toBe(50_000) // untouched
      expect(useStore.getState().active?.outputTokens).toBe(150) // this one does update
    } finally {
      vi.useRealTimers()
    }
  })

  it('chat-tool opens a step; a second chat-tool closes the previous one and opens its own', () => {
    useStore.setState({
      active: { turnId: 'T', agentId: 'a1', text: '', tools: [], status: 'streaming', userText: '', thinkingText: '', lastEvent: 'init' },
    })

    useStore.getState().applyWs({ ev: 'chat-tool', turnId: 'T', name: 'Read', input: 'file.ts' })
    const steps1 = useStore.getState().active?.steps
    expect(steps1).toHaveLength(1)
    expect(steps1?.[0]).toMatchObject({ name: 'Read', desc: 'file.ts', end: null, isSubagent: false })

    useStore.getState().applyWs({ ev: 'chat-tool', turnId: 'T', name: 'Bash' })
    const steps2 = useStore.getState().active?.steps
    expect(steps2).toHaveLength(2)
    expect(steps2?.[0]?.end).not.toBeNull() // the first one closed
    expect(steps2?.[1]).toMatchObject({ name: 'Bash', desc: null, end: null })
  })

  it("chat-tool 'Task' or 'Agent' marks isSubagent true; everything else false", () => {
    useStore.setState({
      active: { turnId: 'T', agentId: 'a1', text: '', tools: [], status: 'streaming', userText: '', thinkingText: '', lastEvent: 'init' },
    })
    useStore.getState().applyWs({ ev: 'chat-tool', turnId: 'T', name: 'Task' })
    expect(useStore.getState().active?.steps?.[0]?.isSubagent).toBe(true)

    useStore.getState().applyWs({ ev: 'chat-tool', turnId: 'T', name: 'Agent' })
    expect(useStore.getState().active?.steps?.[1]?.isSubagent).toBe(true)

    useStore.getState().applyWs({ ev: 'chat-tool', turnId: 'T', name: 'Grep' })
    expect(useStore.getState().active?.steps?.[2]?.isSubagent).toBe(false)
  })

  it("a live refetch enriches a description-less step's desc with the most recent persisted toolUse of the same name", async () => {
    const meta = makeSession({ folder: 'f', id: 's1', agentId: 'a1' })
    useStore.setState({
      selected: { folder: 'f', id: 's1' },
      detail: { meta, turns: [{ index: 0, role: 'user', text: 'hi', tools: [], ts: null }], total: 1 },
      active: {
        turnId: 'T',
        agentId: 'a1',
        text: '',
        tools: ['Read'],
        status: 'streaming',
        userText: 'hi',
        thinkingText: '',
        lastEvent: 'tool',
        steps: [{ name: 'Read', isSubagent: false, desc: null, start: Date.now(), end: null }],
      },
    })
    mockedApi.sessionDetail.mockResolvedValue({
      meta,
      turns: [
        {
          index: 1,
          role: 'assistant',
          text: '',
          tools: ['Read'],
          ts: null,
          toolUses: [{ name: 'Read', skill: null, input: 'src/App.tsx', result: null }],
        },
      ],
      total: 2,
    })

    useStore.getState().applyWs({ ev: 'session', meta })

    await Promise.resolve()
    await Promise.resolve()

    expect(useStore.getState().active?.steps?.[0]?.desc).toBe('src/App.tsx')
  })
})

describe('userText on the active turn (an optimistic bubble)', () => {
  it('send() records the sent text in active.userText while streaming', async () => {
    useStore.setState({ selectedAgentId: 'a1', agents: [makeAgent({ id: 'a1' })], active: null })
    mockedApi.chat.mockResolvedValue({ turnId: 't1' })

    await useStore.getState().send("hi, how's it going?")

    expect(useStore.getState().active?.userText).toBe("hi, how's it going?")
    expect(useStore.getState().active?.status).toBe('streaming')
  })
})

describe('execOut clears on a context change', () => {
  it('openSession clears execOut', async () => {
    useStore.setState({ execOut: { stdout: 'x', stderr: '', code: 0, ms: 1, truncated: false } })
    mockedApi.sessionDetail.mockResolvedValue({ meta: makeSession(), turns: [], total: 0 })

    await useStore.getState().openSession('f', 's1')

    expect(useStore.getState().execOut).toBeNull()
  })

  it('closeSession clears execOut', () => {
    useStore.setState({ execOut: { stdout: 'x', stderr: '', code: 0, ms: 1, truncated: false } })

    useStore.getState().closeSession()

    expect(useStore.getState().execOut).toBeNull()
  })

  it('selectAgent clears execOut', () => {
    useStore.setState({ execOut: { stdout: 'x', stderr: '', code: 0, ms: 1, truncated: false } })

    useStore.getState().selectAgent('a9')

    expect(useStore.getState().execOut).toBeNull()
  })
})

describe('renameSession', () => {
  it('optimistic in agents + detail, then confirms with api.rename', async () => {
    const meta = makeSession({ folder: 'f', id: 's1', agentId: 'a1', title: 'Old' })
    useStore.setState({
      agents: [makeAgent({ id: 'a1', sessions: [meta] })],
      selected: { folder: 'f', id: 's1' },
      detail: { meta, turns: [], total: 0 },
    })
    mockedApi.rename.mockResolvedValue(undefined)

    const pending = useStore.getState().renameSession('f', 's1', 'New')

    // optimistic: already visible in agents and in detail.meta before the API resolves
    expect(useStore.getState().agents[0]?.sessions[0]?.title).toBe('New')
    expect(useStore.getState().detail?.meta.title).toBe('New')

    await pending
    expect(mockedApi.rename).toHaveBeenCalledWith('f', 's1', 'New')
    expect(useStore.getState().agents[0]?.sessions[0]?.title).toBe('New')
    expect(useStore.getState().detail?.meta.title).toBe('New')
  })

  it('if api.rename fails, reverts the title in agents and in detail and saves the error', async () => {
    const meta = makeSession({ folder: 'f', id: 's1', agentId: 'a1', title: 'Old' })
    useStore.setState({
      agents: [makeAgent({ id: 'a1', sessions: [meta] })],
      selected: { folder: 'f', id: 's1' },
      detail: { meta, turns: [], total: 0 },
      error: null,
    })
    mockedApi.rename.mockRejectedValueOnce(new Error('network failure'))

    await useStore.getState().renameSession('f', 's1', 'New')

    expect(useStore.getState().agents[0]?.sessions[0]?.title).toBe('Old')
    expect(useStore.getState().detail?.meta.title).toBe('Old')
    expect(useStore.getState().error).toBe('network failure')
  })
})

describe('applyWs — session', () => {
  // A console /clear (or a keep-thread rotation) does not end the
  // conversation — it CONTINUES it in a new session id. The conversation
  // is the chain, and the focus follows its tip: the same rule openSession
  // applies on entry, applied when the tip moves under you. Without it the
  // selected row became a folded ancestor and the sidebar highlighted
  // nothing (a /clear lost the conversation's focus).
  it('a rotation child of the OPEN conversation moves the focus to the new tip', () => {
    const s1 = makeSession({ folder: 'f', id: 's1', agentId: 'a1', mtime: 100 })
    useStore.setState({
      agents: [makeAgent({ id: 'a1', sessions: [s1] })],
      selectedAgentId: 'a1',
      selected: { folder: 'f', id: 's1' },
      detail: { meta: s1, turns: [], total: 0 },
      active: null,
    })
    mockedApi.sessionDetail.mockResolvedValue({ meta: makeSession({ folder: 'f', id: 's2' }), turns: [], total: 0 })

    const child = makeSession({ folder: 'f', id: 's2', agentId: 'a1', mtime: 200, parentKey: 'f/s1' })
    useStore.getState().applyWs({ ev: 'session', meta: child })

    expect(useStore.getState().selected).toEqual({ folder: 'f', id: 's2' })
  })

  it('reading an EARLIER entry of the chain is never yanked by a rotation elsewhere in it', () => {
    const s0 = makeSession({ folder: 'f', id: 's0', agentId: 'a1', mtime: 50 })
    const s1 = makeSession({ folder: 'f', id: 's1', agentId: 'a1', mtime: 100, parentKey: 'f/s0' })
    useStore.setState({
      agents: [makeAgent({ id: 'a1', sessions: [s0, s1] })],
      selectedAgentId: 'a1',
      selected: { folder: 'f', id: 's0' }, // deliberately on the ancestor
      detail: { meta: s0, turns: [], total: 0 },
      active: null,
    })

    const child = makeSession({ folder: 'f', id: 's2', agentId: 'a1', mtime: 200, parentKey: 'f/s1' })
    useStore.getState().applyWs({ ev: 'session', meta: child })

    expect(useStore.getState().selected).toEqual({ folder: 'f', id: 's0' })
  })

  // a /clear child is a NEW conversation (its own sidebar row) — and the
  // owner just started it from the console they are looking at. The moment
  // its link to the open conversation is born, the focus follows it ONCE:
  // the cleared-away transcript is archived (the sidebar stops listing it),
  // so staying on it left no highlighted row and a page frozen on a
  // finished transcript (a /clear made a new untitled conversation but the
  // focus was lost). Even empty: the new
  // conversation is where the console is now.
  it('the birth of a /clear child under the OPEN conversation moves the focus to it', async () => {
    const s1 = makeSession({ folder: 'f', id: 's1', agentId: 'a1', mtime: 100 })
    useStore.setState({
      agents: [makeAgent({ id: 'a1', sessions: [s1] })],
      selectedAgentId: 'a1',
      selected: { folder: 'f', id: 's1' },
      detail: { meta: s1, turns: [], total: 0 },
      active: null,
    })
    mockedApi.sessionDetail.mockResolvedValue({ meta: makeSession({ folder: 'f', id: 's2' }), turns: [], total: 0 })

    const cleared = makeSession({ folder: 'f', id: 's2', agentId: 'a1', mtime: 200, parentKey: 'f/s1', parentKind: 'clear', turnCount: 0 })
    useStore.getState().applyWs({ ev: 'session', meta: cleared })
    await vi.waitFor(() => expect(useStore.getState().selected).toEqual({ folder: 'f', id: 's2' }))
  })

  // the hook that files the rotation can lose the race against the index:
  // the child's first event arrives as an orphan (no parentKey) and the
  // server re-announces it once the link is known. The focus follows the
  // LINK's birth, not the session's.
  it('a /clear child announced first as an orphan moves the focus when its link arrives', async () => {
    const s1 = makeSession({ folder: 'f', id: 's1', agentId: 'a1', mtime: 100 })
    useStore.setState({
      agents: [makeAgent({ id: 'a1', sessions: [s1] })],
      selectedAgentId: 'a1',
      selected: { folder: 'f', id: 's1' },
      detail: { meta: s1, turns: [], total: 0 },
      active: null,
    })
    mockedApi.sessionDetail.mockResolvedValue({ meta: makeSession({ folder: 'f', id: 's2' }), turns: [], total: 0 })

    const orphan = makeSession({ folder: 'f', id: 's2', agentId: 'a1', mtime: 200, turnCount: 0 })
    useStore.getState().applyWs({ ev: 'session', meta: orphan })
    expect(useStore.getState().selected).toEqual({ folder: 'f', id: 's1' })

    useStore.getState().applyWs({ ev: 'session', meta: { ...orphan, parentKey: 'f/s1', parentKind: 'clear' } })
    await vi.waitFor(() => expect(useStore.getState().selected).toEqual({ folder: 'f', id: 's2' }))
  })

  // ...but only at its birth. Afterwards the /clear child is its own
  // conversation: its activity — every message typed in that console —
  // must never steal the page from the cleared-away parent being read
  // (reading a check-in kept jumping to the cleared-into
  // terminal on each new message there).
  it('later events of a known /clear child never steal the focus from the parent being read', () => {
    const s1 = makeSession({ folder: 'f', id: 's1', agentId: 'a1', mtime: 100 })
    const cleared = makeSession({ folder: 'f', id: 's2', agentId: 'a1', mtime: 200, parentKey: 'f/s1', parentKind: 'clear' })
    useStore.setState({
      agents: [makeAgent({ id: 'a1', sessions: [s1, cleared] })],
      selectedAgentId: 'a1',
      selected: { folder: 'f', id: 's1' }, // deliberately reading the archived parent
      detail: { meta: s1, turns: [], total: 0 },
      active: null,
    })

    useStore.getState().applyWs({ ev: 'session', meta: { ...cleared, mtime: 300, turnCount: 5 } })

    expect(useStore.getState().selected).toEqual({ folder: 'f', id: 's1' })
    expect(mockedApi.sessionDetail).not.toHaveBeenCalled()
  })

  // a child OLDER than the open session (a stale SDK fork born at once by
  // an old bug) is not where the thread continues: its event
  // — a late index of it, a title change — never yanks a live console.
  it('a child event OLDER than the open session leaves the focus where it is', () => {
    const live = makeSession({ folder: 'f', id: 'live', agentId: 'a1', mtime: 500 })
    useStore.setState({
      agents: [makeAgent({ id: 'a1', sessions: [live] })],
      selectedAgentId: 'a1',
      selected: { folder: 'f', id: 'live' },
      detail: { meta: live, turns: [], total: 0 },
      active: null,
    })

    const stale = makeSession({ folder: 'f', id: 'stale', agentId: 'a1', mtime: 100, parentKey: 'f/live' })
    useStore.getState().applyWs({ ev: 'session', meta: stale })

    expect(useStore.getState().selected).toEqual({ folder: 'f', id: 'live' })
  })

  it('an open session with no active turn fires sessionDetail with since=detail.total', async () => {
    const oldMeta = makeSession({ folder: 'f', id: 's1', agentId: 'a1', mtime: 100 })
    const newMeta = makeSession({ folder: 'f', id: 's1', agentId: 'a1', mtime: 200 })
    useStore.setState({
      agents: [makeAgent({ id: 'a1', sessions: [oldMeta] })],
      selected: { folder: 'f', id: 's1' },
      detail: { meta: oldMeta, turns: [], total: 3 },
      active: null,
    })
    mockedApi.sessionDetail.mockResolvedValue({
      meta: newMeta,
      turns: [{ index: 3, role: 'assistant', text: 'new', tools: [], ts: null }],
      total: 4,
    })

    useStore.getState().applyWs({ ev: 'session', meta: newMeta })

    expect(mockedApi.sessionDetail).toHaveBeenCalledWith('f', 's1', 3)
    expect(useStore.getState().agents[0]?.sessions[0]).toEqual(newMeta)

    await Promise.resolve()
    await Promise.resolve()
    expect(useStore.getState().detail?.total).toBe(4)
    expect(useStore.getState().detail?.turns).toHaveLength(1)
  })

  it('with an active turn IN PROGRESS for the same session, fires a throttled refetch (not total silence until chat-done)', () => {
    // a live transcript: the refetch used to be fully suppressed while
    // there was an active; now it refetches throttled — the first call,
    // with no recent prior refetches, goes out immediately.
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date(2030, 0, 1, 0, 0, 0))
      const meta = makeSession({ folder: 'f', id: 's1', agentId: 'a1' })
      useStore.setState({
        agents: [makeAgent({ id: 'a1', sessions: [] })],
        selected: { folder: 'f', id: 's1' },
        detail: { meta, turns: [], total: 0 },
        active: { turnId: 't1', agentId: 'a1', text: '', tools: [], status: 'streaming', userText: '', thinkingText: '', lastEvent: 'init' },
      })
      mockedApi.sessionDetail.mockResolvedValue({ meta, turns: [], total: 0 })

      useStore.getState().applyWs({ ev: 'session', meta })

      expect(mockedApi.sessionDetail).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it("re-home: if the meta changes agent, it's removed from the old agent", () => {
    const meta = makeSession({ folder: 'f', id: 's1', agentId: 'a2', mtime: 50 })
    useStore.setState({
      agents: [makeAgent({ id: 'a1', sessions: [makeSession({ folder: 'f', id: 's1', agentId: 'a1', mtime: 10 })] }), makeAgent({ id: 'a2', sessions: [] })],
    })

    useStore.getState().applyWs({ ev: 'session', meta })

    const [a1, a2] = useStore.getState().agents
    expect(a1?.sessions).toHaveLength(0)
    expect(a2?.sessions).toEqual([meta])
  })
})

// `live`/`liveCount` no longer paint from the server's snapshot — they're
// derived client-side with isLive(mtime, nowTick). `nowTick` starts at
// Date.now() when the store is created and refreshes two ways: the boot's
// 30s interval (see App.tsx) and, so fresh activity lights up the badge
// WITHOUT waiting up to 30s, every applied 'session' event.
describe('nowTick — a live-derived clock', () => {
  it('a session event refreshes nowTick instantly, without waiting for the 30s tick', () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date(2030, 0, 1, 0, 0, 0))
      useStore.setState({
        nowTick: 0,
        agents: [makeAgent({ id: 'a1', sessions: [] })],
      })
      mockedApi.sessionDetail.mockResolvedValue({ meta: makeSession(), turns: [], total: 0 })

      const meta = makeSession({ folder: 'f', id: 's1', agentId: 'a1', mtime: Date.now() })
      useStore.getState().applyWs({ ev: 'session', meta })

      expect(useStore.getState().nowTick).toBe(Date.now())
    } finally {
      vi.useRealTimers()
    }
  })
})

// a chat-init with a sessionId different from the previous `selected` (a
// fork — an external session got continued as a new branch) must not leave
// the old `detail` stuck, with its "terminal session" banner painted over
// the new branch while the turn streams.
describe("applyWs — chat-init (a fork's banner does not stick)", () => {
  it('a sessionId different from the previous selected clears `detail`', () => {
    useStore.setState({
      selected: { folder: 'f', id: 'old-one' },
      detail: { meta: makeSession({ folder: 'f', id: 'old-one', native: false }), turns: [], total: 0 },
      active: {
        turnId: 't1',
        agentId: 'a1',
        text: '',
        tools: [],
        status: 'streaming',
        userText: '',
        thinkingText: '',
        lastEvent: 'init',
      },
    })

    useStore.getState().applyWs({ ev: 'chat-init', turnId: 't1', folder: 'f', sessionId: 'new-one' })

    expect(useStore.getState().detail).toBeNull()
    expect(useStore.getState().selected).toEqual({ folder: 'f', id: 'new-one' })
  })

  it('the same sessionId as the one already open (a normal continuation) does NOT touch detail', () => {
    const detail = { meta: makeSession({ folder: 'f', id: 's1' }), turns: [], total: 0 }
    useStore.setState({
      selected: { folder: 'f', id: 's1' },
      detail,
      active: {
        turnId: 't1',
        agentId: 'a1',
        text: '',
        tools: [],
        status: 'streaming',
        userText: '',
        thinkingText: '',
        lastEvent: 'init',
      },
    })

    useStore.getState().applyWs({ ev: 'chat-init', turnId: 't1', folder: 'f', sessionId: 's1' })

    expect(useStore.getState().detail).toBe(detail)
  })

  it("a new chat with no previous selected (sel === null) doesn't break: sets selected, no detail to clear", () => {
    useStore.setState({
      selected: null,
      detail: null,
      active: {
        turnId: 't1',
        agentId: 'a1',
        text: '',
        tools: [],
        status: 'streaming',
        userText: '',
        thinkingText: '',
        lastEvent: 'init',
      },
    })

    useStore.getState().applyWs({ ev: 'chat-init', turnId: 't1', folder: 'f', sessionId: 's1' })

    expect(useStore.getState().selected).toEqual({ folder: 'f', id: 's1' })
    expect(useStore.getState().detail).toBeNull()
  })
})

describe('a live transcript during the turn', () => {
  it('session for the active session refetches throttled (max 1/1500ms, trailing)', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date(2030, 0, 1, 1, 0, 0))
      const meta = makeSession({ folder: 'f', id: 's1', agentId: 'a1' })
      useStore.setState({
        agents: [makeAgent({ id: 'a1', sessions: [] })],
        selected: { folder: 'f', id: 's1' },
        detail: { meta, turns: [], total: 4 },
        active: {
          turnId: 't1',
          agentId: 'a1',
          text: 'streaming',
          tools: [],
          status: 'streaming',
          userText: 'hi',
          thinkingText: '',
          lastEvent: 'delta',
          sessionKey: 'f/s1',
        },
      })
      mockedApi.sessionDetail.mockResolvedValue({
        meta,
        turns: [{ index: 4, role: 'assistant', text: 'a turn persisted during streaming', tools: [], ts: null }],
        total: 5,
      })

      // 3 consecutive 'session' events: 1 immediate call (no recent prior
      // live refetch) + the other two stack into ONE trailing call, without accumulating.
      useStore.getState().applyWs({ ev: 'session', meta })
      useStore.getState().applyWs({ ev: 'session', meta })
      useStore.getState().applyWs({ ev: 'session', meta })
      expect(mockedApi.sessionDetail).toHaveBeenCalledTimes(1)

      // let the in-flight refetch resolve before advancing the clock —
      // otherwise the anti-overlap guard would discard the trailing call.
      await Promise.resolve()
      await Promise.resolve()

      vi.advanceTimersByTime(1500)
      await Promise.resolve()
      await Promise.resolve()

      expect(mockedApi.sessionDetail).toHaveBeenCalledTimes(2)
      expect(useStore.getState().detail?.total).toBe(5)
    } finally {
      vi.useRealTimers()
    }
  })

  it('the optimistic bubble hides once the user turn is already persisted', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date(2030, 0, 1, 2, 0, 0))
      const meta = makeSession({ folder: 'f', id: 's1', agentId: 'a1' })
      useStore.setState({
        agents: [makeAgent({ id: 'a1', sessions: [] })],
        selected: { folder: 'f', id: 's1' },
        detail: { meta, turns: [], total: 0 },
        active: {
          turnId: 't1',
          agentId: 'a1',
          text: '',
          tools: [],
          status: 'streaming',
          userText: 'hi',
          thinkingText: '',
          lastEvent: 'init',
          sessionKey: 'f/s1',
        },
        userTextPersisted: false,
      })
      mockedApi.sessionDetail.mockResolvedValue({
        meta,
        turns: [{ index: 0, role: 'user', text: 'hi', tools: [], ts: null }],
        total: 1,
      })

      useStore.getState().applyWs({ ev: 'session', meta })
      await Promise.resolve()
      await Promise.resolve()

      expect(useStore.getState().userTextPersisted).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  // a peer message (interSession) landing right AFTER the owner's message in
  // the same delta carries role:'user' but isn't userText's echo — without
  // skipping it, `last` was the peer, the comparison failed, and the
  // optimistic bubble stayed DUPLICATED (the real message is already
  // persisted on top).
  it('the optimistic bubble hides even when a peer message (interSession) is the last persisted turn', async () => {
    vi.useFakeTimers()
    try {
      // an own time BETWEEN the previous test's (2:00) and the next one's
      // (2:30): the live throttle is a shared closure across tests, and the
      // file's times must be increasing in execution order.
      vi.setSystemTime(new Date(2030, 0, 1, 2, 15, 0))
      const meta = makeSession({ folder: 'f', id: 's1', agentId: 'a1' })
      useStore.setState({
        agents: [makeAgent({ id: 'a1', sessions: [] })],
        selected: { folder: 'f', id: 's1' },
        detail: { meta, turns: [], total: 0 },
        active: {
          turnId: 't1',
          agentId: 'a1',
          text: '',
          tools: [],
          status: 'streaming',
          userText: 'hi',
          thinkingText: '',
          lastEvent: 'init',
          sessionKey: 'f/s1',
        },
        userTextPersisted: false,
      })
      mockedApi.sessionDetail.mockResolvedValue({
        meta,
        turns: [
          { index: 0, role: 'user', text: 'hi', tools: [], ts: null },
          { index: 1, role: 'user', text: 'peer coordination message', tools: [], ts: null, interSession: { from: 'peer-x' } },
        ],
        total: 2,
      })

      useStore.getState().applyWs({ ev: 'session', meta })
      await Promise.resolve()
      await Promise.resolve()

      expect(useStore.getState().userTextPersisted).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  // the first user turn of a new session with a skills-carrying agent
  // carries the [silos-context]...[/silos-context] prelude prepended
  // by the server (ChatService.withSkillsPrelude) — active.userText NEVER
  // carries it (it's the text the user typed, before the prelude). Without
  // stripAgentContext in the comparison, last.text (with prelude) !==
  // active.userText (without prelude) ALWAYS → the optimistic bubble stays
  // duplicated for the whole turn in any new session of a skills-carrying agent.
  it('the optimistic bubble hides even when the persisted turn carries the skills prelude', async () => {
    vi.useFakeTimers()
    try {
      // a time different from the previous test's (the same shared-closure
      // live throttle, lastLiveRefetch): reusing the same instant would make
      // this 'session' fall inside the previous refetch's 1500ms window and
      // take the "trailing" (deferred) branch, never resolving without
      // advancing the clock.
      vi.setSystemTime(new Date(2030, 0, 1, 2, 30, 0))
      const meta = makeSession({ folder: 'f', id: 's1', agentId: 'a1' })
      const prelude = '[silos-context] Your skills for this session: /finance-skill — load them when the task calls for them. [/silos-context]\n\n'
      useStore.setState({
        agents: [makeAgent({ id: 'a1', sessions: [] })],
        selected: { folder: 'f', id: 's1' },
        detail: { meta, turns: [], total: 0 },
        active: {
          turnId: 't1',
          agentId: 'a1',
          text: '',
          tools: [],
          status: 'streaming',
          userText: 'hi',
          thinkingText: '',
          lastEvent: 'init',
          sessionKey: 'f/s1',
        },
        userTextPersisted: false,
      })
      mockedApi.sessionDetail.mockResolvedValue({
        meta,
        turns: [{ index: 0, role: 'user', text: `${prelude}hi`, tools: [], ts: null }],
        total: 1,
      })

      useStore.getState().applyWs({ ev: 'session', meta })
      await Promise.resolve()
      await Promise.resolve()

      expect(useStore.getState().userTextPersisted).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  // the in-progress turn's turns landing via the live refetch must not show
  // doubled — the active block trims what's already persisted (liveTrim)
  // and the optimistic bubble stays hidden even once the echo is no longer
  // the last turn (it used to REAPPEAR as soon as the first assistant turn landed).
  it("liveTrim covers the in-progress turn's already-persisted text and chips", async () => {
    vi.useFakeTimers()
    try {
      // an own time after the previous test's (a shared live throttle).
      vi.setSystemTime(new Date(2030, 0, 1, 2, 45, 0))
      const meta = makeSession({ folder: 'f', id: 's1', agentId: 'a1' })
      useStore.setState({
        agents: [makeAgent({ id: 'a1', sessions: [] })],
        selected: { folder: 'f', id: 's1' },
        detail: { meta, turns: [], total: 0 },
        active: {
          turnId: 't1',
          agentId: 'a1',
          text: 'Let me take a look.\n\nand still streaming',
          tools: ['Bash', 'Read'],
          status: 'streaming',
          userText: 'hi',
          thinkingText: '',
          lastEvent: 'delta',
          sessionKey: 'f/s1',
        },
        userTextPersisted: false,
      })
      mockedApi.sessionDetail.mockResolvedValue({
        meta,
        turns: [
          { index: 0, role: 'user', text: 'hi', tools: [], ts: null },
          { index: 1, role: 'assistant', text: 'Let me take a look.', tools: [], ts: null },
          { index: 2, role: 'assistant', text: '', tools: ['Bash'], ts: null },
        ],
        total: 3,
      })

      useStore.getState().applyWs({ ev: 'session', meta })
      await Promise.resolve()
      await Promise.resolve()

      const st = useStore.getState()
      // the echo is no longer the last persisted turn, but the bubble stays hidden
      expect(st.userTextPersisted).toBe(true)
      expect(st.liveTrim).toEqual({ chars: 'Let me take a look.'.length, tools: 1, echoed: true })
      // what's left to paint in the live block: only the unpersisted queue
      expect(st.active!.text.slice(st.liveTrim.chars).trimStart()).toBe('and still streaming')
    } finally {
      vi.useRealTimers()
    }
  })

  it('with no active, session refetches immediately as before (a regression check)', () => {
    const meta = makeSession({ folder: 'f', id: 's1', agentId: 'a1' })
    useStore.setState({
      agents: [makeAgent({ id: 'a1', sessions: [] })],
      selected: { folder: 'f', id: 's1' },
      detail: { meta, turns: [], total: 2 },
      active: null,
    })
    mockedApi.sessionDetail.mockResolvedValue({ meta, turns: [], total: 2 })

    useStore.getState().applyWs({ ev: 'session', meta })

    expect(mockedApi.sessionDetail).toHaveBeenCalledTimes(1)
    expect(mockedApi.sessionDetail).toHaveBeenCalledWith('f', 's1', 2)
  })

  it("two overlapping refetches (the live throttled one + chat-done's final one) returning the same turn don't duplicate it", async () => {
    // both read since=detail.total BEFORE either resolves — 'session''s
    // throttled refetch and chat-done's unconditional one can request the
    // same range and return the same turn.
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date(2030, 0, 1, 3, 0, 0))
      const meta = makeSession({ folder: 'f', id: 's1', agentId: 'a1' })
      const resolvers: Array<(v: Awaited<ReturnType<typeof api.sessionDetail>>) => void> = []
      mockedApi.sessionDetail.mockImplementation(
        () =>
          new Promise((resolve) => {
            resolvers.push(resolve)
          }),
      )
      useStore.setState({
        agents: [makeAgent({ id: 'a1', sessions: [] })],
        selected: { folder: 'f', id: 's1' },
        detail: { meta, turns: [], total: 4 },
        active: {
          turnId: 't1',
          agentId: 'a1',
          text: 'streaming',
          tools: [],
          status: 'streaming',
          userText: 'hi',
          thinkingText: '',
          lastEvent: 'init',
          sessionKey: 'f/s1',
        },
      })

      // 1st in-flight call: a throttled refetch fired by 'session'
      useStore.getState().applyWs({ ev: 'session', meta })
      // 2nd in-flight call: chat-done's unconditional final refetch
      useStore.getState().applyWs({ ev: 'chat-done', turnId: 't1', subtype: 'result', costUsd: 0 })

      expect(resolvers).toHaveLength(2)

      const newTurn = { index: 4, role: 'assistant' as const, text: 'new', tools: [], ts: null }
      resolvers[0]!({ meta, turns: [newTurn], total: 5 })
      await Promise.resolve()
      await Promise.resolve()
      resolvers[1]!({ meta, turns: [newTurn], total: 5 })
      await Promise.resolve()
      await Promise.resolve()

      expect(useStore.getState().detail?.turns.map((t) => t.index)).toEqual([4])
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('applyWs — removed', () => {
  it('removes the session from the lists and closes it if it was the open one', () => {
    const meta = makeSession({ folder: 'f', id: 's1', agentId: 'a1' })
    useStore.setState({
      agents: [makeAgent({ id: 'a1', sessions: [meta] })],
      selected: { folder: 'f', id: 's1' },
      detail: { meta, turns: [], total: 0 },
    })

    useStore.getState().applyWs({ ev: 'removed', folder: 'f', id: 's1' })

    expect(useStore.getState().agents[0]?.sessions).toHaveLength(0)
    expect(useStore.getState().selected).toBeNull()
    expect(useStore.getState().detail).toBeNull()
  })
})

// the lists are capped, so the totals ride each event from the server —
// a session event never re-derives a count from a list's length
describe('applyWs — counts', () => {
  const c = (conversations: number, runs: number): SessionCounts => ({ conversations, runs, runsByAutomation: runs ? { hourly: runs } : {}, byCwd: {} })
  it("a session event replaces every agent's totals with the server's", () => {
    useStore.setState({ agents: [makeAgent({ id: 'a1', sessions: [], sessionCount: 1399, counts: c(3, 1396) }), makeAgent({ id: 'a2', counts: c(1, 0) })] })
    useStore
      .getState()
      .applyWs({
        ev: 'session',
        meta: makeSession({ folder: 'f', id: 'new', agentId: 'a1', origin: { kind: 'automation', automationId: 'hourly', runId: 'r' } }),
        counts: { a1: c(3, 1397) },
      })
    const [a1, a2] = useStore.getState().agents
    expect(a1).toMatchObject({ counts: c(3, 1397), sessionCount: 1400 })
    expect(a2).toMatchObject({ counts: c(0, 0), sessionCount: 0 }) // absent from the event = none left
  })
  it('removed carries the totals too; an event without counts leaves them as they were (never the list length)', () => {
    const s1 = makeSession({ folder: 'f', id: 's1', agentId: 'a1' })
    useStore.setState({ agents: [makeAgent({ id: 'a1', sessions: [s1], sessionCount: 50, counts: c(50, 0) })] })
    useStore.getState().applyWs({ ev: 'removed', folder: 'f', id: 's1' })
    expect(useStore.getState().agents[0]).toMatchObject({ sessionCount: 50, counts: c(50, 0) })
    useStore.getState().applyWs({ ev: 'removed', folder: 'f', id: 'zz', counts: { a1: c(49, 0) } })
    expect(useStore.getState().agents[0]).toMatchObject({ sessionCount: 49, counts: c(49, 0) })
  })
})

describe('applyWs — chat-error', () => {
  it('marks active.status=error and the global error when the active turnId matches', () => {
    useStore.setState({
      active: { turnId: 't1', agentId: 'a1', text: 'something', tools: [], status: 'streaming', userText: 'something', thinkingText: '', lastEvent: 'init' },
    })

    useStore.getState().applyWs({ ev: 'chat-error', turnId: 't1', error: 'boom' })

    expect(useStore.getState().active).toEqual({
      turnId: 't1',
      agentId: 'a1',
      text: 'something',
      tools: [],
      status: 'error',
      error: 'boom',
      userText: 'something',
      thinkingText: '',
      lastEvent: 'init',
    })
    expect(useStore.getState().error).toBe('boom')
  })

  it('does NOT mark the global error if the turnId was canceled with cancel() (expected interrupt noise)', async () => {
    useStore.setState({
      selectedAgentId: 'a1',
      active: { turnId: 't1', agentId: 'a1', text: 'something', tools: [], status: 'streaming', userText: 'something', thinkingText: '', lastEvent: 'init' },
      error: null,
    })
    mockedApi.cancel.mockResolvedValue({ ok: true })

    await useStore.getState().cancel()
    expect(mockedApi.cancel).toHaveBeenCalledWith('t1')

    useStore.getState().applyWs({ ev: 'chat-error', turnId: 't1', error: 'interrupted mid-response' })

    expect(useStore.getState().error).toBeNull()
    expect(useStore.getState().active?.status).toBe('error')
  })

  it('does NOT mark the global error if a chat-done with an error subtype arrives after canceling that turn', async () => {
    useStore.setState({
      selectedAgentId: 'a1',
      selected: { folder: 'f', id: 's1' },
      agents: [makeAgent({ id: 'a1', sessions: [makeSession({ folder: 'f', id: 's1' })] })],
      detail: { meta: makeSession({ folder: 'f', id: 's1' }), turns: [], total: 0 },
      active: { turnId: 't1', agentId: 'a1', text: 'something', tools: [], status: 'streaming', userText: 'something', thinkingText: '', lastEvent: 'init' },
      error: null,
    })
    mockedApi.cancel.mockResolvedValue({ ok: true })
    mockedApi.sessionDetail.mockResolvedValue({ meta: makeSession({ folder: 'f', id: 's1' }), turns: [], total: 0 })

    await useStore.getState().cancel()

    useStore.getState().applyWs({ ev: 'chat-done', turnId: 't1', subtype: 'error_during_execution', costUsd: null })

    expect(useStore.getState().error).toBeNull()
  })

  it('DOES mark the global error if a chat-done arrives with an error subtype without having canceled', () => {
    useStore.setState({
      selectedAgentId: 'a1',
      active: { turnId: 't1', agentId: 'a1', text: 'something', tools: [], status: 'streaming', userText: 'something', thinkingText: '', lastEvent: 'init' },
      error: null,
    })

    useStore.getState().applyWs({ ev: 'chat-done', turnId: 't1', subtype: 'error_max_turns', costUsd: null })

    expect(useStore.getState().error).toBe('error_max_turns')
  })

  // a real bug: chat-error (the SDK's exception path) marked status='error'
  // but never called finishTurn — unlike chat-done with an error subtype
  // (above), which does. Consequence: the queue never drained and the
  // pending live-refetch timer stayed hanging. They must behave IDENTICALLY
  // (the same turn close, only the error's origin differs).
  it('finishes the turn like an error chat-done: drains the queue and clears the pending live-refetch timer', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date(2030, 0, 1, 5, 0, 0)) // after every other setSystemTime in the file — avoids colliding with the shared throttle
      const meta = makeSession({ folder: 'f', id: 's1', agentId: 'a1' })
      useStore.setState({
        selectedAgentId: 'a1',
        agents: [makeAgent({ id: 'a1', sessions: [meta] })],
        selected: { folder: 'f', id: 's1' },
        detail: { meta, turns: [], total: 0 },
        active: {
          turnId: 't1',
          agentId: 'a1',
          text: 'something',
          tools: [],
          status: 'streaming',
          userText: 'something',
          thinkingText: '',
          lastEvent: 'init',
          sessionKey: 'f/s1',
        },
        queue: [{ text: 'next', agentId: 'a1', session: { folder: 'f', id: 's1' } }],
        error: null,
      })
      mockedApi.sessionDetail.mockResolvedValue({ meta, turns: [], total: 0 })
      mockedApi.chat.mockResolvedValue({ turnId: 't2' })

      // 1st 'session': an immediate live refetch (starts the throttle window)
      useStore.getState().applyWs({ ev: 'session', meta })
      // 2nd 'session' within the window: schedules the trailing call, no immediate call
      useStore.getState().applyWs({ ev: 'session', meta })
      expect(mockedApi.sessionDetail).toHaveBeenCalledTimes(1)

      await Promise.resolve()
      await Promise.resolve()

      // the active turn's chat-error arrives before the trailing call fires
      useStore.getState().applyWs({ ev: 'chat-error', turnId: 't1', error: 'boom' })

      expect(useStore.getState().active?.status).toBe('error')
      expect(mockedApi.sessionDetail).toHaveBeenCalledTimes(2) // finishTurn's unconditional final refetch

      vi.advanceTimersByTime(1_500) // exhausts the pending trailing window + CLEAR_ACTIVE_DELAY_MS, with margin
      await Promise.resolve()
      await Promise.resolve()

      expect(mockedApi.sessionDetail).toHaveBeenCalledTimes(2) // no 3rd call: the trailing one cleared
      expect(useStore.getState().queue).toEqual([]) // drained
      expect(useStore.getState().active?.turnId).not.toBe('t1')
      expect(mockedApi.chat).toHaveBeenCalledWith('a1', 'next', { folder: 'f', id: 's1' })
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('filter and selection', () => {
  it('setFilter, selectAgent, setModal and clearError update the state', () => {
    useStore.getState().setFilter('foo')
    expect(useStore.getState().filter).toBe('foo')

    useStore.getState().selectAgent('a9')
    expect(useStore.getState().selectedAgentId).toBe('a9')

    useStore.setState({ error: 'something failed' })
    useStore.getState().clearError()
    expect(useStore.getState().error).toBeNull()

    useStore.getState().setModal('create')
    expect(useStore.getState().modal).toBe('create')

    useStore.getState().setModal('create-skill')
    expect(useStore.getState().modal).toBe('create-skill')
  })
})

describe('the message queue', () => {
  it('send() during a streaming turn queues {text, agentId, session} — a snapshot of the destination WHEN QUEUED', async () => {
    useStore.setState({
      selectedAgentId: 'a1',
      agents: [makeAgent({ id: 'a1', sessions: [makeSession({ folder: 'f', id: 's1' })] })],
      selected: { folder: 'f', id: 's1' },
      active: { turnId: 't1', agentId: 'a1', text: '', tools: [], status: 'streaming', userText: 'hi', thinkingText: '', lastEvent: 'init' },
      queue: [],
    })

    await useStore.getState().send('while you work, this too')

    expect(mockedApi.chat).not.toHaveBeenCalled()
    expect(useStore.getState().queue).toEqual([
      // convPrefs: a snapshot of the destination's prefs when queued
      { text: 'while you work, this too', agentId: 'a1', session: { folder: 'f', id: 's1' }, convPrefs: {} },
    ])
    expect(useStore.getState().active?.turnId).toBe('t1') // the in-progress turn isn't touched
  })

  it("if the open session doesn't belong to the selected agent, the snapshot queues session: null", async () => {
    useStore.setState({
      selectedAgentId: 'a1',
      agents: [makeAgent({ id: 'a1', sessions: [] }), makeAgent({ id: 'a2', sessions: [makeSession({ folder: 'f', id: 's1' })] })],
      selected: { folder: 'f', id: 's1' }, // belongs to a2, not the selected a1
      active: { turnId: 't1', agentId: 'a1', text: '', tools: [], status: 'streaming', userText: '', thinkingText: '', lastEvent: 'init' },
      queue: [],
    })

    await useStore.getState().send('message')

    expect(useStore.getState().queue).toEqual([{ text: 'message', agentId: 'a1', session: null }])
  })

  it("a '!command' runs immediately even with a turn in progress (not queued)", async () => {
    useStore.setState({
      selectedAgentId: 'a1',
      agents: [makeAgent({ id: 'a1' })],
      active: { turnId: 't1', agentId: 'a1', text: '', tools: [], status: 'streaming', userText: 'hi', thinkingText: '', lastEvent: 'init' },
      queue: [],
    })
    mockedApi.exec.mockResolvedValue({ stdout: 'out', stderr: '', code: 0, ms: 1, truncated: false })

    await useStore.getState().send('!ls')

    expect(mockedApi.exec).toHaveBeenCalledWith('a1', 'ls')
    expect(useStore.getState().queue).toEqual([])
  })

  it('queuing several messages stacks them in order', async () => {
    useStore.setState({
      selectedAgentId: 'a1',
      agents: [makeAgent({ id: 'a1' })],
      active: { turnId: 't1', agentId: 'a1', text: '', tools: [], status: 'streaming', userText: '', thinkingText: '', lastEvent: 'init' },
      queue: [],
    })

    await useStore.getState().send('first')
    await useStore.getState().send('second')

    expect(useStore.getState().queue).toEqual([
      { text: 'first', agentId: 'a1', session: null },
      { text: 'second', agentId: 'a1', session: null },
    ])
  })

  it('removeFromQueue(i) removes the item at that position (a real array index)', () => {
    useStore.setState({
      queue: [
        { text: 'a', agentId: 'a1', session: null },
        { text: 'b', agentId: 'a1', session: null },
        { text: 'c', agentId: 'a1', session: null },
      ],
    })

    useStore.getState().removeFromQueue(1)

    expect(useStore.getState().queue).toEqual([
      { text: 'a', agentId: 'a1', session: null },
      { text: 'c', agentId: 'a1', session: null },
    ])
  })

  it('chat-done drains the first item in the queue: send is called with that text and goes to the session captured when queued', async () => {
    vi.useFakeTimers()
    try {
      const agent = makeAgent({ id: 'a1', sessions: [makeSession({ folder: 'f', id: 's1' })] })
      useStore.setState({
        selectedAgentId: 'a1',
        agents: [agent],
        selected: { folder: 'f', id: 's1' },
        detail: { meta: makeSession({ folder: 'f', id: 's1' }), turns: [], total: 0 },
      })
      mockedApi.chat.mockResolvedValue({ turnId: 't1' })
      mockedApi.sessionDetail.mockResolvedValue({ meta: makeSession({ folder: 'f', id: 's1' }), turns: [], total: 0 })

      await useStore.getState().send('first message')
      expect(mockedApi.chat).toHaveBeenCalledTimes(1)

      // while streaming, a second message gets queued
      await useStore.getState().send('queued message')
      expect(useStore.getState().queue).toEqual([{ text: 'queued message', agentId: 'a1', session: { folder: 'f', id: 's1' }, convPrefs: {} }])
      expect(mockedApi.chat).toHaveBeenCalledTimes(1)

      mockedApi.chat.mockResolvedValueOnce({ turnId: 't2' })

      useStore.getState().applyWs({ ev: 'chat-done', turnId: 't1', subtype: 'result', costUsd: 0.01 })
      await Promise.resolve()
      await Promise.resolve()

      vi.advanceTimersByTime(100)
      await Promise.resolve()
      await Promise.resolve()

      expect(useStore.getState().queue).toEqual([])
      expect(mockedApi.chat).toHaveBeenCalledTimes(2)
      expect(mockedApi.chat).toHaveBeenLastCalledWith('a1', 'queued message', { folder: 'f', id: 's1' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('a failed queue drain re-inserts the message at the front and never strands the rest of the queue', async () => {
    vi.useFakeTimers()
    try {
      const agent = makeAgent({ id: 'a1', sessions: [makeSession({ folder: 'f', id: 's1' })] })
      const q0 = { text: 'first queued', agentId: 'a1', session: { folder: 'f', id: 's1' } }
      const q1 = { text: 'second queued', agentId: 'a1', session: { folder: 'f', id: 's1' } }
      useStore.setState({
        selectedAgentId: 'a1',
        agents: [agent],
        selected: { folder: 'f', id: 's1' },
        detail: { meta: makeSession({ folder: 'f', id: 's1' }), turns: [], total: 0 },
        active: {
          turnId: 't1',
          agentId: 'a1',
          text: '',
          tools: [],
          status: 'streaming',
          userText: '',
          thinkingText: '',
          lastEvent: 'init',
          sessionKey: 'f/s1',
        },
        queue: [{ ...q0 }, { ...q1 }],
        error: null,
      })
      mockedApi.sessionDetail.mockResolvedValue({ meta: makeSession({ folder: 'f', id: 's1' }), turns: [], total: 0 })
      // the drain's POST fails — a network blip, or the dev server restarting
      // mid-drain (tsx watch). Before the fix this dropped q0 and stranded q1.
      mockedApi.chat.mockRejectedValueOnce(new Error('network down'))

      useStore.getState().applyWs({ ev: 'chat-done', turnId: 't1', subtype: 'result', costUsd: 0 })
      for (let i = 0; i < 4; i++) await Promise.resolve()
      vi.advanceTimersByTime(100)
      for (let i = 0; i < 6; i++) await Promise.resolve()

      // nothing lost, nothing stranded: the failed message is back at the head,
      // the rest still behind it, and the error is surfaced.
      expect(useStore.getState().queue).toEqual([q0, q1])
      expect(useStore.getState().error).toBe('network down')
    } finally {
      vi.useRealTimers()
    }
  })

  it('CRITICAL: navigating to another agent/session while the queued turn is still in progress does NOT redirect the drain — it sends to the destination captured when queued', async () => {
    vi.useFakeTimers()
    try {
      const agentA = makeAgent({ id: 'A', sessions: [makeSession({ folder: 'f', id: 'S' })] })
      const agentB = makeAgent({ id: 'B', sessions: [makeSession({ folder: 'g', id: 'other' })] })
      useStore.setState({
        selectedAgentId: 'A',
        agents: [agentA, agentB],
        selected: { folder: 'f', id: 'S' },
        active: { turnId: 't1', agentId: 'A', text: '', tools: [], status: 'streaming', userText: 'hi', thinkingText: '', lastEvent: 'init' },
        queue: [],
      })

      // gets queued with A/S as the in-progress destination
      await useStore.getState().send('for A, not for B')
      expect(useStore.getState().queue).toEqual([{ text: 'for A, not for B', agentId: 'A', session: { folder: 'f', id: 'S' }, convPrefs: {} }])

      // the user navigates — the multitasking flow the bug used to break
      useStore.setState({ selectedAgentId: 'B', selected: { folder: 'g', id: 'other' } })

      mockedApi.chat.mockResolvedValueOnce({ turnId: 't2' })
      mockedApi.sessionDetail.mockResolvedValue({ meta: makeSession({ folder: 'f', id: 'S' }), turns: [], total: 0 })

      useStore.getState().applyWs({ ev: 'chat-done', turnId: 't1', subtype: 'result', costUsd: 0 })
      await Promise.resolve()
      await Promise.resolve()

      vi.advanceTimersByTime(100)
      await Promise.resolve()
      await Promise.resolve()

      expect(mockedApi.chat).toHaveBeenCalledWith('A', 'for A, not for B', { folder: 'f', id: 'S' })
      expect(mockedApi.chat).not.toHaveBeenCalledWith('B', expect.anything(), expect.anything())
      // the user's navigation isn't overwritten: still viewing B
      expect(useStore.getState().selectedAgentId).toBe('B')
    } finally {
      vi.useRealTimers()
    }
  })

  it("chained draining: two queued messages — the first one's chat-done drains the second (not just the first)", async () => {
    vi.useFakeTimers()
    try {
      const agent = makeAgent({ id: 'a1', sessions: [makeSession({ folder: 'f', id: 's1' })] })
      useStore.setState({
        selectedAgentId: 'a1',
        agents: [agent],
        selected: { folder: 'f', id: 's1' },
        detail: { meta: makeSession({ folder: 'f', id: 's1' }), turns: [], total: 0 },
        active: { turnId: 't0', agentId: 'a1', text: '', tools: [], status: 'streaming', userText: '', thinkingText: '', lastEvent: 'init' },
        queue: [
          { text: 'item1', agentId: 'a1', session: { folder: 'f', id: 's1' } },
          { text: 'item2', agentId: 'a1', session: { folder: 'f', id: 's1' } },
        ],
      })
      mockedApi.sessionDetail.mockResolvedValue({ meta: makeSession({ folder: 'f', id: 's1' }), turns: [], total: 0 })

      // t0 ends: drains item1 → a new turn t1
      mockedApi.chat.mockResolvedValueOnce({ turnId: 't1' })
      useStore.getState().applyWs({ ev: 'chat-done', turnId: 't0', subtype: 'result', costUsd: 0 })
      await Promise.resolve()
      await Promise.resolve()
      vi.advanceTimersByTime(100)
      await Promise.resolve()
      await Promise.resolve()

      expect(mockedApi.chat).toHaveBeenNthCalledWith(1, 'a1', 'item1', { folder: 'f', id: 's1' })
      expect(useStore.getState().queue).toEqual([{ text: 'item2', agentId: 'a1', session: { folder: 'f', id: 's1' } }])
      expect(useStore.getState().active?.turnId).toBe('t1')

      // t1 ends: drains item2 → a new turn t2
      mockedApi.chat.mockResolvedValueOnce({ turnId: 't2' })
      useStore.getState().applyWs({ ev: 'chat-done', turnId: 't1', subtype: 'result', costUsd: 0 })
      await Promise.resolve()
      await Promise.resolve()
      vi.advanceTimersByTime(100)
      await Promise.resolve()
      await Promise.resolve()

      expect(mockedApi.chat).toHaveBeenNthCalledWith(2, 'a1', 'item2', { folder: 'f', id: 's1' })
      expect(useStore.getState().queue).toEqual([])
      expect(useStore.getState().active?.turnId).toBe('t2')
    } finally {
      vi.useRealTimers()
    }
  })

  // chat-error finishes the turn like an error chat-done (see
  // describe('applyWs — chat-error') above) — the queue DOES drain, by
  // symmetry, same as after any other turn close; the error stays visible
  // in active.error meanwhile.
  it('chat-error finishes the turn: the queue DOES drain (symmetric with an error chat-done)', async () => {
    vi.useFakeTimers()
    try {
      useStore.setState({
        selectedAgentId: 'a1',
        active: { turnId: 't1', agentId: 'a1', text: 'something', tools: [], status: 'streaming', userText: 'something', thinkingText: '', lastEvent: 'init' },
        queue: [{ text: 'this one gets sent', agentId: 'a1', session: null }],
        error: null,
      })
      mockedApi.chat.mockResolvedValue({ turnId: 't2' })

      useStore.getState().applyWs({ ev: 'chat-error', turnId: 't1', error: 'boom' })

      vi.advanceTimersByTime(100) // finishTurn's CLEAR_ACTIVE_DELAY_MS
      await Promise.resolve()
      await Promise.resolve()

      expect(useStore.getState().queue).toEqual([])
      expect(mockedApi.chat).toHaveBeenCalledWith('a1', 'this one gets sent', undefined)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('buffer TTL', () => {
  it('purges buffered events older than 10s', async () => {
    vi.useFakeTimers()
    try {
      useStore.setState({ selectedAgentId: 'a1', agents: [makeAgent({ id: 'a1' })], active: null })

      // an orphaned event (a turnId that never becomes the active turn) stays buffered
      useStore.getState().applyWs({ ev: 'chat-delta', turnId: 'old', text: 'x' })

      vi.advanceTimersByTime(10_001)

      mockedApi.chat.mockResolvedValue({ turnId: 'old' })
      await useStore.getState().send('hi')

      // since the buffer already purged the old event, the active turn starts clean
      expect(useStore.getState().active).toEqual({
        turnId: 'old',
        agentId: 'a1',
        text: '',
        tools: [],
        status: 'streaming',
        userText: 'hi',
        sessionKey: null,
        thinkingText: '',
        lastEvent: 'init',
        startedAt: expect.any(Number),
        requested: { permissionMode: 'bypassPermissions' },
      })
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('resync', () => {
  it('reloads overview and does a delta refetch of the open session with since=total', async () => {
    const meta = makeSession({ folder: 'f', id: 's1', agentId: 'a1' })
    useStore.setState({
      agents: [makeAgent({ id: 'a1', sessions: [meta] })],
      selected: { folder: 'f', id: 's1' },
      detail: { meta, turns: [], total: 3 },
      active: null,
    })
    mockedApi.overview.mockResolvedValue({ agents: [makeAgent({ id: 'a1', sessions: [meta] })], now: 1, warming: false })
    mockedApi.sessionDetail.mockResolvedValue({ meta, turns: [], total: 3 })

    await useStore.getState().resync()

    expect(mockedApi.overview).toHaveBeenCalledTimes(1)
    expect(mockedApi.sessionDetail).toHaveBeenCalledWith('f', 's1', 3)
  })

  it('with no open session, only reloads overview (no sessionDetail or chatAlive)', async () => {
    useStore.setState({ selected: null, active: null })
    mockedApi.overview.mockResolvedValue({ agents: [], now: 1, warming: false })

    await useStore.getState().resync()

    expect(mockedApi.overview).toHaveBeenCalledTimes(1)
    expect(mockedApi.sessionDetail).not.toHaveBeenCalled()
    expect(mockedApi.chatAlive).not.toHaveBeenCalled()
  })

  // refetchDelta (called by resync(), by the streaming watchdog, and at the
  // end of every turn) used to rebuild `detail` from just meta/turns/total —
  // `context` (Needs You/Plan/Waiting/Links/Events/Files/Tools, the whole
  // context column) went undefined on the first refetch after openSession()
  // and never recovered.
  it('refetchDelta (via resync) assigns detail.context from the patch — no longer lost on the first refetch', async () => {
    const meta = makeSession({ folder: 'f', id: 's1', agentId: 'a1' })
    const serverContext: import('../src/lib/types').SessionContext = {
      plan: { tasks: [], done: 0, total: 0 },
      agents: [],
      pending: { question: 'Continue?', options: [{ label: 'Yes' }], askedAt: '2026-08-19T00:00:00.000Z' },
      links: { prs: [], artifacts: [], worktree: null },
      events: [],
      files: [],
      tools: [],
      flags: { remote: false, permissionMode: null, gitBranch: null, effort: null, model: null },
      waiting: null,
    }
    useStore.setState({
      agents: [makeAgent({ id: 'a1', sessions: [meta] })],
      selected: { folder: 'f', id: 's1' },
      detail: { meta, turns: [], total: 3 }, // no context yet — as right after openSession()
      active: null,
    })
    mockedApi.overview.mockResolvedValue({ agents: [makeAgent({ id: 'a1', sessions: [meta] })], now: 1, warming: false })
    mockedApi.sessionDetail.mockResolvedValue({ meta, turns: [], total: 3, context: serverContext })

    await useStore.getState().resync()

    expect(useStore.getState().detail?.context).toEqual(serverContext)
  })

  it("refetchDelta keeps the previous context if a patch (defensive, shouldn't happen) arrives with no context", async () => {
    const meta = makeSession({ folder: 'f', id: 's1', agentId: 'a1' })
    const previousContext: import('../src/lib/types').SessionContext = {
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
    useStore.setState({
      agents: [makeAgent({ id: 'a1', sessions: [meta] })],
      selected: { folder: 'f', id: 's1' },
      detail: { meta, turns: [], total: 3, context: previousContext },
      active: null,
    })
    mockedApi.overview.mockResolvedValue({ agents: [makeAgent({ id: 'a1', sessions: [meta] })], now: 1, warming: false })
    mockedApi.sessionDetail.mockResolvedValue({ meta, turns: [], total: 4 }) // no context

    await useStore.getState().resync()

    expect(useStore.getState().detail?.context).toEqual(previousContext)
  })

  it('refetchDelta keeps every field the patch carries — the execution record survives a delta (no flicker to a plan file count)', async () => {
    const meta = makeSession({ folder: 'f', id: 's1', agentId: 'a1' })
    const execution: import('../src/lib/types').ExecutionRecord = {
      ledgerPath: '/w/.superpowers/sdd/p/progress.md',
      planPath: '/w/docs/p.md',
      planTitle: 'P',
      tasks: [
        { n: 0, title: 'A', state: 'complete' },
        { n: 1, title: 'B', state: 'pending' },
      ],
      done: 1,
      total: 2,
      updatedAt: 1,
      gone: false,
    }
    useStore.setState({
      agents: [makeAgent({ id: 'a1', sessions: [meta] })],
      selected: { folder: 'f', id: 's1' },
      detail: { meta, turns: [], total: 3, execution },
      active: null,
    })
    mockedApi.overview.mockResolvedValue({ agents: [makeAgent({ id: 'a1', sessions: [meta] })], now: 1, warming: false })
    // the server sends the record with every detail; a newer one replaces it
    const newer = { ...execution, done: 2, tasks: execution.tasks.map((t) => ({ ...t, state: 'complete' as const })) }
    mockedApi.sessionDetail.mockResolvedValue({ meta, turns: [], total: 4, execution: newer })
    await useStore.getState().resync()
    expect(useStore.getState().detail?.execution).toEqual(newer)
    // a patch without the field keeps the previous value, like context
    mockedApi.sessionDetail.mockResolvedValue({ meta, turns: [], total: 5 })
    await useStore.getState().resync()
    expect(useStore.getState().detail?.execution).toEqual(newer)
  })

  // resync() used to not refresh automationRuns for an open automation
  // detail page — 'run' WS events lost during a drop weren't recovered
  // until navigating away and reopening the automation (loadAutomationRuns).
  it('with an automation page open, resync() also refreshes automationRuns', async () => {
    useStore.setState({ selected: null, active: null, page: { kind: 'automation', id: 'auto1' } })
    mockedApi.overview.mockResolvedValue({ agents: [], now: 1, warming: false })
    mockedApi.automations.runs.mockResolvedValue([{ id: 'run-1', automationId: 'auto1', at: '2026-08-19T00:00:00.000Z', status: 'ok' }])

    await useStore.getState().resync()

    expect(mockedApi.automations.runs).toHaveBeenCalledWith('auto1')
    expect(useStore.getState().automationRuns).toEqual([{ id: 'run-1', automationId: 'auto1', at: '2026-08-19T00:00:00.000Z', status: 'ok' }])
  })

  it('with no automation page open, resync() does NOT call automations.runs', async () => {
    useStore.setState({ selected: null, active: null, page: { kind: 'automations' } })
    mockedApi.overview.mockResolvedValue({ agents: [], now: 1, warming: false })

    await useStore.getState().resync()

    expect(mockedApi.automations.runs).not.toHaveBeenCalled()
  })

  it('single-flight: two near-simultaneous resync() calls coalesce — overview is requested only once', async () => {
    useStore.setState({ selected: null, active: null })
    let resolveOverview!: (v: Awaited<ReturnType<typeof api.overview>>) => void
    mockedApi.overview.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveOverview = resolve
        }),
    )

    const p1 = useStore.getState().resync()
    const p2 = useStore.getState().resync() // arrives while the first is still waiting on overview() — coalesces

    resolveOverview({ agents: [], now: 1, warming: false })
    await Promise.all([p1, p2])

    expect(mockedApi.overview).toHaveBeenCalledTimes(1)
  })
})

function setupActiveStreaming(): { meta: SessionView } {
  const meta = makeSession({ folder: 'f', id: 's1', agentId: 'a1' })
  useStore.setState({
    agents: [makeAgent({ id: 'a1', sessions: [meta] })],
    selected: { folder: 'f', id: 's1' },
    detail: { meta, turns: [], total: 0 },
    active: {
      turnId: 't1',
      agentId: 'a1',
      text: '',
      tools: [],
      status: 'streaming',
      userText: 'hi',
      thinkingText: '',
      lastEvent: 'init',
      sessionKey: 'f/s1',
    },
  })
  mockedApi.overview.mockResolvedValue({ agents: [makeAgent({ id: 'a1', sessions: [meta] })], now: 1, warming: false })
  return { meta }
}

describe("resync — the active turn's watchdog (the server's truth via api.chatAlive)", () => {
  it('alive=true: active stays intact, not finished', async () => {
    vi.useFakeTimers()
    try {
      const { meta } = setupActiveStreaming()
      mockedApi.sessionDetail.mockResolvedValue({ meta, turns: [], total: 0 })
      mockedApi.chatAlive.mockResolvedValue({ alive: true })

      await useStore.getState().resync()

      expect(mockedApi.chatAlive).toHaveBeenCalledWith('t1')

      vi.advanceTimersByTime(5_000) // well past the grace period — nothing should happen
      await Promise.resolve()
      await Promise.resolve()

      expect(useStore.getState().active?.status).toBe('streaming')
      expect(mockedApi.sessionDetail).toHaveBeenCalledTimes(1) // only resync's own refetch
    } finally {
      vi.useRealTimers()
    }
  })

  it('alive=false and no real chat-done within the 3s grace period: finishes — active null, a final refetch, and drains the queue', async () => {
    vi.useFakeTimers()
    try {
      const { meta } = setupActiveStreaming()
      useStore.setState({ queue: [{ text: 'next', agentId: 'a1', session: { folder: 'f', id: 's1' } }] })
      mockedApi.sessionDetail
        .mockResolvedValueOnce({ meta, turns: [], total: 0 }) // resync's own refetch
        .mockResolvedValueOnce({ meta, turns: [], total: 0 }) // finishTurn's final refetch
      mockedApi.chatAlive.mockResolvedValue({ alive: false })
      mockedApi.chat.mockResolvedValue({ turnId: 't2' }) // draining the queue fires sendTo → api.chat

      await useStore.getState().resync()
      expect(useStore.getState().active?.status).toBe('streaming') // still within the grace period

      vi.advanceTimersByTime(3_000)
      await Promise.resolve()
      await Promise.resolve()

      vi.advanceTimersByTime(100) // finishTurn's CLEAR_ACTIVE_DELAY_MS
      await Promise.resolve()
      await Promise.resolve()

      expect(mockedApi.sessionDetail).toHaveBeenCalledTimes(2)
      expect(useStore.getState().active?.turnId).not.toBe('t1') // the old turn is no longer active
      expect(useStore.getState().queue).toEqual([]) // drained
      expect(mockedApi.chat).toHaveBeenCalledWith('a1', 'next', { folder: 'f', id: 's1' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('alive=false but a real chat-done arrives within the grace period: the normal path wins, no double finish', async () => {
    vi.useFakeTimers()
    try {
      const { meta } = setupActiveStreaming()
      mockedApi.sessionDetail.mockResolvedValue({ meta, turns: [], total: 0 })
      mockedApi.chatAlive.mockResolvedValue({ alive: false })

      await useStore.getState().resync()

      // within the grace window (3s) the real chat-done arrives via WS
      vi.advanceTimersByTime(1_000)
      useStore.getState().applyWs({ ev: 'chat-done', turnId: 't1', subtype: 'success', costUsd: 0.02 })
      await Promise.resolve()
      await Promise.resolve()

      vi.advanceTimersByTime(100) // the real chat-done's CLEAR_ACTIVE_DELAY_MS
      await Promise.resolve()
      await Promise.resolve()

      expect(useStore.getState().active).toBeNull()
      const callsAfterChatDone = mockedApi.sessionDetail.mock.calls.length

      // the rest of the grace period runs out (2s more): the watchdog must
      // not touch anything again — there's no more active streaming with that turnId (a guard).
      vi.advanceTimersByTime(2_000)
      await Promise.resolve()
      await Promise.resolve()

      expect(useStore.getState().active).toBeNull()
      expect(mockedApi.sessionDetail).toHaveBeenCalledTimes(callsAfterChatDone) // no extra refetch from the watchdog
    } finally {
      vi.useRealTimers()
    }
  })

  // a real bug: a new chat (no session selected yet) + the WS drops after
  // the POST but before chat-init arrives + the turn finishes during the
  // drop. The old resync used to bail on `if (!selected) return` BEFORE
  // reaching the watchdog — `active` stayed 'streaming' forever (the
  // composer stuck in queue mode). The watchdog only needs `active`, never
  // `selected` — the transcript part (refetchDelta) is the only one that
  // must stay gated by selected.
  it("active with NO session selected: still queries /alive and finishes after the grace period (the watchdog doesn't depend on selected)", async () => {
    vi.useFakeTimers()
    try {
      useStore.setState({
        selected: null,
        detail: null,
        active: {
          turnId: 't1',
          agentId: 'a1',
          text: '',
          tools: [],
          status: 'streaming',
          userText: 'hi',
          thinkingText: '',
          lastEvent: 'init',
        },
      })
      mockedApi.overview.mockResolvedValue({ agents: [], now: 1, warming: false })
      mockedApi.chatAlive.mockResolvedValue({ alive: false })

      await useStore.getState().resync()

      expect(mockedApi.chatAlive).toHaveBeenCalledWith('t1')
      expect(mockedApi.sessionDetail).not.toHaveBeenCalled() // no session selected: nothing to refetch

      vi.advanceTimersByTime(3_000) // grace period
      await Promise.resolve()
      await Promise.resolve()
      vi.advanceTimersByTime(100) // finishTurn's CLEAR_ACTIVE_DELAY_MS
      await Promise.resolve()
      await Promise.resolve()

      expect(useStore.getState().active).toBeNull() // without the fix, it stays 'streaming' forever
    } finally {
      vi.useRealTimers()
    }
  })
})

// finished-turn notices — unreadAgentIds is marked from finishTurn, the
// single completion path (chat-done, the watchdog, and chat-error all go
// through it — see the comment next to finishTurn).
describe('unreadAgentIds — finished-turn notices', () => {
  function setDocumentHidden(hidden: boolean): void {
    Object.defineProperty(document, 'hidden', { value: hidden, configurable: true })
  }

  beforeEach(() => {
    useStore.setState({ unreadAgentIds: new Set() })
    setDocumentHidden(false)
  })

  afterEach(() => {
    setDocumentHidden(false)
  })

  it('a chat-done from an agent that is NOT the selected one marks it unread', () => {
    vi.useFakeTimers()
    try {
      useStore.setState({
        selectedAgentId: 'a1',
        selected: null,
        active: {
          turnId: 't1',
          agentId: 'other-agent',
          text: '',
          tools: [],
          status: 'streaming',
          userText: 'hi',
          thinkingText: '',
          lastEvent: 'init',
        },
      })

      useStore.getState().applyWs({ ev: 'chat-done', turnId: 't1', subtype: 'result', costUsd: 0 })

      expect(useStore.getState().unreadAgentIds.has('other-agent')).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  // a finished automation run is not a reply waiting for you
  it('a chat-done whose session is automation-born (origin) never marks the agent unread', () => {
    vi.useFakeTimers()
    try {
      useStore.setState({
        selectedAgentId: 'a1',
        selected: null,
        agents: [
          {
            id: 'other-agent',
            name: 'Other',
            emoji: '·',
            folder: '/o',
            skills: [],
            liveCount: 0,
            sessionCount: 1,
            sessions: [
              {
                id: 'run-1',
                folder: 'f',
                title: 'Run',
                mtime: 0,
                agentId: 'other-agent',
                skills: [],
                cwd: null,
                size: 1,
                turnCount: 1,
                live: false,
                worktree: false,
                native: true,
                origin: { kind: 'automation', automationId: 'auto', runId: 'r1' },
              },
            ],
          },
        ],
        active: {
          turnId: 't1',
          agentId: 'other-agent',
          sessionKey: 'f/run-1',
          text: '',
          tools: [],
          status: 'streaming',
          userText: 'hi',
          thinkingText: '',
          lastEvent: 'init',
        },
      })
      useStore.getState().applyWs({ ev: 'chat-done', turnId: 't1', subtype: 'result', costUsd: 0 })
      expect(useStore.getState().unreadAgentIds.has('other-agent')).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('a chat-done from the selected agent with the tab hidden (document.hidden) also marks it', () => {
    vi.useFakeTimers()
    try {
      setDocumentHidden(true)
      useStore.setState({
        selectedAgentId: 'a1',
        selected: null,
        active: {
          turnId: 't1',
          agentId: 'a1',
          text: '',
          tools: [],
          status: 'streaming',
          userText: 'hi',
          thinkingText: '',
          lastEvent: 'init',
        },
      })

      useStore.getState().applyWs({ ev: 'chat-done', turnId: 't1', subtype: 'result', costUsd: 0 })

      expect(useStore.getState().unreadAgentIds.has('a1')).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('a chat-done from the selected agent with the tab visible does NOT mark it unread', () => {
    vi.useFakeTimers()
    try {
      setDocumentHidden(false)
      useStore.setState({
        selectedAgentId: 'a1',
        selected: null,
        active: {
          turnId: 't1',
          agentId: 'a1',
          text: '',
          tools: [],
          status: 'streaming',
          userText: 'hi',
          thinkingText: '',
          lastEvent: 'init',
        },
      })

      useStore.getState().applyWs({ ev: 'chat-done', turnId: 't1', subtype: 'result', costUsd: 0 })

      expect(useStore.getState().unreadAgentIds.size).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('chat-error (the exception path) marks unread just like chat-done, the same finishTurn path', () => {
    vi.useFakeTimers()
    try {
      useStore.setState({
        selectedAgentId: 'a1',
        selected: null,
        active: {
          turnId: 't1',
          agentId: 'other-agent',
          text: '',
          tools: [],
          status: 'streaming',
          userText: 'hi',
          thinkingText: '',
          lastEvent: 'init',
        },
      })

      useStore.getState().applyWs({ ev: 'chat-error', turnId: 't1', error: 'boom' })

      expect(useStore.getState().unreadAgentIds.has('other-agent')).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('selectAgent(id) removes that id from unreadAgentIds', () => {
    useStore.setState({ unreadAgentIds: new Set(['a1', 'a2']) })

    useStore.getState().selectAgent('a1')

    expect(useStore.getState().unreadAgentIds.has('a1')).toBe(false)
    expect(useStore.getState().unreadAgentIds.has('a2')).toBe(true)
  })

  it('selectAgent(id) with that id not in unreadAgentIds does not break (a no-op on the set)', () => {
    useStore.setState({ unreadAgentIds: new Set(['a2']) })

    useStore.getState().selectAgent('a1')

    expect(useStore.getState().unreadAgentIds.has('a2')).toBe(true)
  })
})

// master's project selector — chosenProject and the cwd that send() puts in
// the body of master's new chat (cwd is required for master without a
// resume, forbidden for everyone else).
describe('newChatTitle — naming a conversation at birth', () => {
  it('send() on a new chat sends the typed title and consumes it', async () => {
    useStore.setState({
      selectedAgentId: 'a1',
      agents: [makeAgent({ id: 'a1', sessions: [] })],
      selected: null,
      newChatOpen: true,
      newChatTitle: 'My research',
      active: null,
    })
    mockedApi.chat.mockResolvedValue({ turnId: 't1' })

    await useStore.getState().send('hello')

    expect(mockedApi.chat).toHaveBeenCalledWith('a1', 'hello', undefined, undefined, undefined, 'My research')
    expect(useStore.getState().newChatTitle).toBeNull() // it traveled — consumed
  })

  it('send() on an existing session never sends a title, even if one lingers', async () => {
    const meta = makeSession({ folder: 'f', id: 's1' })
    useStore.setState({
      selectedAgentId: 'a1',
      agents: [makeAgent({ id: 'a1', sessions: [meta] })],
      selected: { folder: 'f', id: 's1' },
      newChatTitle: 'orphan',
      active: null,
    })
    mockedApi.chat.mockResolvedValue({ turnId: 't1' })

    await useStore.getState().send('go on')

    expect(mockedApi.chat).toHaveBeenCalledWith('a1', 'go on', { folder: 'f', id: 's1' })
  })

  it('startNewConversation resets the pending title', () => {
    useStore.setState({ newChatTitle: 'from last time' })
    useStore.getState().startNewConversation()
    expect(useStore.getState().newChatTitle).toBeNull()
  })

  it('a queued new-chat send snapshots the title and it travels on drain', async () => {
    vi.useFakeTimers()
    try {
      useStore.setState({
        selectedAgentId: 'a1',
        agents: [makeAgent({ id: 'a1', sessions: [] })],
        selected: null,
        newChatOpen: true,
        newChatTitle: 'Named while queued',
        active: {
          turnId: 't0',
          agentId: 'a1',
          text: '',
          tools: [],
          status: 'streaming',
          userText: 'x',
          sessionKey: null,
          thinkingText: '',
          lastEvent: 'init',
          startedAt: Date.now(),
          requested: { permissionMode: 'bypassPermissions' },
        },
      })
      mockedApi.chat.mockResolvedValue({ turnId: 't1' })
      mockedApi.sessionDetail.mockResolvedValue({ meta: makeSession(), turns: [], total: 0 })

      await useStore.getState().send('hello with a name')
      expect(useStore.getState().queue[0]?.title).toBe('Named while queued')
      expect(useStore.getState().newChatTitle).toBeNull() // consumed when queued

      useStore.getState().applyWs({ ev: 'chat-done', turnId: 't0', subtype: 'success', costUsd: null })
      await vi.runAllTimersAsync()

      expect(mockedApi.chat).toHaveBeenCalledWith('a1', 'hello with a name', undefined, undefined, undefined, 'Named while queued')
    } finally {
      vi.useRealTimers()
    }
  })
})

describe("chosenProject — master's project selector", () => {
  it('chooseProject sets chosenProject', () => {
    useStore.getState().chooseProject('/x/project')
    expect(useStore.getState().chosenProject).toBe('/x/project')
  })

  it('selectAgent resets chosenProject', () => {
    useStore.setState({ chosenProject: '/x/project' })
    useStore.getState().selectAgent('a9')
    expect(useStore.getState().chosenProject).toBeNull()
  })

  it('openSession resets chosenProject', async () => {
    useStore.setState({ chosenProject: '/x/project' })
    mockedApi.sessionDetail.mockResolvedValue({ meta: makeSession(), turns: [], total: 0 })

    await useStore.getState().openSession('f', 's1')

    expect(useStore.getState().chosenProject).toBeNull()
  })

  it('send() on master with a new chat and a chosen project sends cwd in the body', async () => {
    useStore.setState({
      selectedAgentId: MASTER_ID,
      agents: [makeAgent({ id: MASTER_ID, folder: null, sessions: [] })],
      selected: null,
      chosenProject: '/x/project',
      active: null,
    })
    mockedApi.chat.mockResolvedValue({ turnId: 't1' })

    await useStore.getState().send('hi master')

    expect(mockedApi.chat).toHaveBeenCalledWith(MASTER_ID, 'hi master', undefined, '/x/project')
  })

  it('send() on master with a session already open does NOT send cwd (even with chosenProject populated)', async () => {
    const meta = makeSession({ folder: 'f', id: 's1', agentId: MASTER_ID })
    useStore.setState({
      selectedAgentId: MASTER_ID,
      agents: [makeAgent({ id: MASTER_ID, folder: null, sessions: [meta] })],
      selected: { folder: 'f', id: 's1' },
      // in practice openSession already resets it to null — forced here to
      // verify send() itself also respects the "no session" condition.
      chosenProject: '/x/project',
      active: null,
    })
    mockedApi.chat.mockResolvedValue({ turnId: 't1' })

    await useStore.getState().send('continue')

    expect(mockedApi.chat).toHaveBeenCalledWith(MASTER_ID, 'continue', { folder: 'f', id: 's1' })
  })

  it('send() on a normal agent never sends cwd, even with chosenProject populated', async () => {
    useStore.setState({
      selectedAgentId: 'a1',
      agents: [makeAgent({ id: 'a1', sessions: [] })],
      selected: null,
      chosenProject: '/x/project',
      active: null,
    })
    mockedApi.chat.mockResolvedValue({ turnId: 't1' })

    await useStore.getState().send('hi')

    expect(mockedApi.chat).toHaveBeenCalledWith('a1', 'hi', undefined)
  })

  it('send() on master with no chosen project does not send cwd', async () => {
    useStore.setState({
      selectedAgentId: MASTER_ID,
      agents: [makeAgent({ id: MASTER_ID, folder: null, sessions: [] })],
      selected: null,
      chosenProject: null,
      active: null,
    })
    mockedApi.chat.mockResolvedValue({ turnId: 't1' })

    await useStore.getState().send('hi')

    expect(mockedApi.chat).toHaveBeenCalledWith(MASTER_ID, 'hi', undefined)
  })

  it('queuing a new master chat with a chosen project (turn in progress) drains sending the same cwd captured when queued', async () => {
    vi.useFakeTimers()
    try {
      useStore.setState({
        selectedAgentId: MASTER_ID,
        agents: [makeAgent({ id: MASTER_ID, folder: null, sessions: [] })],
        selected: null,
        chosenProject: '/x/project',
        active: {
          turnId: 't0',
          agentId: MASTER_ID,
          text: '',
          tools: [],
          status: 'streaming',
          userText: '',
          thinkingText: '',
          lastEvent: 'init',
        },
        queue: [],
      })

      await useStore.getState().send('while it works')

      expect(useStore.getState().queue).toEqual([{ text: 'while it works', agentId: MASTER_ID, session: null, cwd: '/x/project' }])

      mockedApi.chat.mockResolvedValueOnce({ turnId: 't1' })
      useStore.getState().applyWs({ ev: 'chat-done', turnId: 't0', subtype: 'result', costUsd: 0 })
      await Promise.resolve()
      await Promise.resolve()
      vi.advanceTimersByTime(100)
      await Promise.resolve()
      await Promise.resolve()

      expect(mockedApi.chat).toHaveBeenCalledWith(MASTER_ID, 'while it works', undefined, '/x/project')
    } finally {
      vi.useRealTimers()
    }
  })
})

// the terminal panel — the store (opening/closing/height), without mounting
// any real component (TerminalPanel/xterm are covered separately, in
// terminal-panel.test.tsx).
describe('terminal panel', () => {
  beforeEach(() => {
    useStore.setState({
      terminals: [],
      activeTerminalId: null,
      terminalOpen: false,
      terminalHeight: 220,
      agents: [makeAgent({ id: 'a1', folder: '/x', sessions: [] })],
      selectedAgentId: 'a1',
      selected: null,
      detail: null,
      chosenProject: null,
    })
  })

  it('newTerminal creates via the API (agentId) and leaves the panel open with the active tab', async () => {
    mockedApi.terminals.create.mockResolvedValue({ id: 't1', agentId: 'a1', cwd: '/x' })

    await useStore.getState().newTerminal()

    expect(mockedApi.terminals.create).toHaveBeenCalledWith({ agentId: 'a1' })
    expect(useStore.getState().terminals).toEqual([{ id: 't1', agentId: 'a1', title: 'Ana' }])
    expect(useStore.getState().activeTerminalId).toBe('t1')
    expect(useStore.getState().terminalOpen).toBe(true)
  })

  it('newTerminal with master and no session or chosen project creates nothing (no destination)', async () => {
    useStore.setState({ agents: [makeAgent({ id: MASTER_ID, folder: null, sessions: [] })], selectedAgentId: MASTER_ID })

    await useStore.getState().newTerminal()

    expect(mockedApi.terminals.create).not.toHaveBeenCalled()
    expect(useStore.getState().terminals).toEqual([])
  })

  it('openTerminalPanel with no terminals yet creates the first one', async () => {
    mockedApi.terminals.create.mockResolvedValue({ id: 't1', agentId: 'a1', cwd: '/x' })

    await useStore.getState().openTerminalPanel()

    expect(mockedApi.terminals.create).toHaveBeenCalledTimes(1)
    expect(useStore.getState().terminalOpen).toBe(true)
  })

  it("openTerminalPanel with terminals already open just expands (doesn't create another)", async () => {
    useStore.setState({ terminals: [{ id: 't1', agentId: 'a1', title: 'Ana' }], activeTerminalId: 't1', terminalOpen: false })

    await useStore.getState().openTerminalPanel()

    expect(mockedApi.terminals.create).not.toHaveBeenCalled()
    expect(useStore.getState().terminalOpen).toBe(true)
  })

  it('closeTerminal kills it on the server, removes it from the list, and collapses the panel if it was the last one', async () => {
    mockedApi.terminals.kill.mockResolvedValue(undefined)
    useStore.setState({ terminals: [{ id: 't1', agentId: 'a1', title: 'Ana' }], activeTerminalId: 't1', terminalOpen: true })

    useStore.getState().closeTerminal('t1')

    expect(mockedApi.terminals.kill).toHaveBeenCalledWith('t1')
    expect(useStore.getState().terminals).toEqual([])
    expect(useStore.getState().activeTerminalId).toBeNull()
    expect(useStore.getState().terminalOpen).toBe(false)
  })

  it("closeTerminal on a background tab doesn't touch the active tab or collapse the panel", () => {
    mockedApi.terminals.kill.mockResolvedValue(undefined)
    useStore.setState({
      terminals: [
        { id: 't1', agentId: 'a1', title: 'Ana' },
        { id: 't2', agentId: 'a1', title: 'Ana' },
      ],
      activeTerminalId: 't1',
      terminalOpen: true,
    })

    useStore.getState().closeTerminal('t2')

    expect(useStore.getState().terminals).toEqual([{ id: 't1', agentId: 'a1', title: 'Ana' }])
    expect(useStore.getState().activeTerminalId).toBe('t1')
    expect(useStore.getState().terminalOpen).toBe(true)
  })

  it('toggleTerminalPanel collapses/expands without touching the terminals list', () => {
    useStore.setState({ terminals: [{ id: 't1', agentId: 'a1', title: 'Ana' }], terminalOpen: false })

    useStore.getState().toggleTerminalPanel()
    expect(useStore.getState().terminalOpen).toBe(true)

    useStore.getState().toggleTerminalPanel()
    expect(useStore.getState().terminalOpen).toBe(false)
  })

  it('resizeTerminal clamps to the minimum and only persists when requested', () => {
    mockedApi.patchPrefsTerminal.mockResolvedValue({ terminal: { height: 300 } })
    useStore.getState().resizeTerminal(40) // below the minimum (120)
    expect(useStore.getState().terminalHeight).toBe(120)
    expect(mockedApi.patchPrefsTerminal).not.toHaveBeenCalled()

    useStore.getState().resizeTerminal(300, true)
    expect(useStore.getState().terminalHeight).toBe(300)
    expect(mockedApi.patchPrefsTerminal).toHaveBeenCalledWith(300)
  })

  it('setTerminalFontSize clamps to [10, 24], persists, and skips a no-op', () => {
    mockedApi.patchPrefsTerminalFont.mockResolvedValue({ terminal: { fontSize: 15 } })
    useStore.getState().setTerminalFontSize(15)
    expect(useStore.getState().terminalFontSize).toBe(15)
    expect(mockedApi.patchPrefsTerminalFont).toHaveBeenCalledWith(15)

    useStore.getState().setTerminalFontSize(15)
    expect(mockedApi.patchPrefsTerminalFont).toHaveBeenCalledTimes(1)

    useStore.getState().setTerminalFontSize(40)
    expect(useStore.getState().terminalFontSize).toBe(24)
    useStore.getState().setTerminalFontSize(3)
    expect(useStore.getState().terminalFontSize).toBe(10)
  })

  it('loadPrefs loads the persisted font size (clamped)', async () => {
    mockedApi.prefs.mockResolvedValue({ terminal: { fontSize: 99 } })
    await useStore.getState().loadPrefs()
    expect(useStore.getState().terminalFontSize).toBe(24)
  })

  it('loadPrefs loads the persisted height (with the minimum applied)', async () => {
    mockedApi.prefs.mockResolvedValue({ terminal: { height: 50 } })

    await useStore.getState().loadPrefs()

    expect(useStore.getState().terminalHeight).toBe(120)
  })
})

// auto-resuming interactive chats: the store hydrates the records, reacts
// to the WS (upsert/remove by "folder/sessionId"), and cancels optimistically.
describe('pending resumes (auto-resume)', () => {
  it('loadPendingResumes indexes the list by "folder/sessionId"', async () => {
    mockedApi.pendingResumes.list.mockResolvedValue([
      { agentId: 'a1', folder: 'f', sessionId: 's1', text: 'x', resetsAt: 'r', resumeAt: 'r', createdAt: 'c', attempts: 0 },
    ])
    await useStore.getState().loadPendingResumes()
    expect(useStore.getState().pendingResumes['f/s1']?.text).toBe('x')
  })

  it('applyWs pending-resume upserts; pending-resume-removed removes it', () => {
    useStore.setState({ pendingResumes: {} })
    useStore
      .getState()
      .applyWs({
        ev: 'pending-resume',
        pending: { agentId: 'a1', folder: 'f', sessionId: 's1', text: 'x', resetsAt: 'r', resumeAt: 'r', createdAt: 'c', attempts: 0 },
      })
    expect(useStore.getState().pendingResumes['f/s1']).toBeDefined()
    useStore.getState().applyWs({ ev: 'pending-resume-removed', folder: 'f', id: 's1' })
    expect(useStore.getState().pendingResumes['f/s1']).toBeUndefined()
  })

  it('cancelPendingResume removes the optimistic record and calls the API', async () => {
    mockedApi.pendingResumes.cancel.mockResolvedValue({ ok: true })
    useStore.setState({
      pendingResumes: { 'f/s1': { agentId: 'a1', folder: 'f', sessionId: 's1', text: 'x', resetsAt: 'r', resumeAt: 'r', createdAt: 'c', attempts: 0 } },
    })
    await useStore.getState().cancelPendingResume('f', 's1')
    expect(useStore.getState().pendingResumes['f/s1']).toBeUndefined()
    expect(mockedApi.pendingResumes.cancel).toHaveBeenCalledWith('f', 's1')
  })
})

describe('a new console conversation hands off to its session', () => {
  it("the session event for the console's announced id selects it and closes the new-chat state", async () => {
    useStore.setState({ selectedAgentId: 'a1', agents: [makeAgent({ id: 'a1' })], selected: null, newChatOpen: true, page: { kind: 'agent', id: 'a1' } })
    useStore.getState().setPendingConsole('n1')
    const meta = makeSession({ id: 'n1', folder: 'f', title: '(untitled)', agentId: 'a1' })
    mockedApi.sessionDetail.mockResolvedValue({ meta, turns: [], total: 0 })

    useStore.getState().applyWs({ ev: 'session', meta })
    await Promise.resolve()
    await Promise.resolve()

    expect(useStore.getState().selected).toEqual({ folder: 'f', id: 'n1' })
    expect(useStore.getState().newChatOpen).toBe(false)
    expect(useStore.getState().pendingConsoleId).toBeNull()
  })

  it('a draft title lands via the manual rename when the console session persists', async () => {
    useStore.setState({
      selectedAgentId: 'a1',
      agents: [makeAgent({ id: 'a1' })],
      selected: null,
      newChatOpen: true,
      newChatTitle: 'My console',
      page: { kind: 'agent', id: 'a1' },
    })
    useStore.getState().setPendingConsole('n1')
    const meta = makeSession({ id: 'n1', folder: 'f', title: '(untitled)', agentId: 'a1' })
    mockedApi.rename.mockResolvedValue(undefined)
    mockedApi.sessionDetail.mockResolvedValue({ meta: { ...meta, title: 'My console' }, turns: [], total: 0 })

    useStore.getState().applyWs({ ev: 'session', meta })
    await vi.waitFor(() => expect(useStore.getState().selected).toEqual({ folder: 'f', id: 'n1' }))

    expect(mockedApi.rename).toHaveBeenCalledWith('f', 'n1', 'My console')
    expect(useStore.getState().newChatTitle).toBeNull() // consumed — it landed
    // the rename goes out BEFORE the session opens, so the fetched detail
    // already resolves the manual title (no flash of the raw title)
    const renameOrder = mockedApi.rename.mock.invocationCallOrder[0]!
    const detailOrder = mockedApi.sessionDetail.mock.invocationCallOrder[0]!
    expect(renameOrder).toBeLessThan(detailOrder)
  })

  it('a session event for ANOTHER id leaves the new chat alone', () => {
    useStore.setState({ selectedAgentId: 'a1', agents: [makeAgent({ id: 'a1' })], selected: null, newChatOpen: true })
    useStore.getState().setPendingConsole('n1')

    useStore.getState().applyWs({ ev: 'session', meta: makeSession({ id: 'other', folder: 'f', agentId: 'a1' }) })

    expect(useStore.getState().selected).toBeNull()
    expect(useStore.getState().newChatOpen).toBe(true)
  })
})

// showAutomation — an automation's full context WHERE YOU ARE (the column
// and the sidebar's category click it): the automations facet over the
// transcript, landing on that automation. Distinct from openAutomation
// (Board → the automation's own page).
describe("showAutomation — an automation's full context, where you are", () => {
  const auto = (id: string, agentId: string) => ({
    id,
    name: id,
    agentId,
    prompt: 'p',
    trigger: { kind: 'cron' as const, expr: '0 9 * * *' },
    thread: { mode: 'new' as const },
    approval: false,
    keepAlive: false,
    paused: false,
    createdAt: '2026-08-01T00:00:00.000Z',
  })
  const agent = (id: string) => ({ id, name: id, emoji: '·', role: '', folder: `/${id}`, skills: [], sessions: [], liveCount: 0, sessionCount: 0 })
  beforeEach(() => {
    useStore.setState({
      agents: [agent('a1'), agent('b2')],
      automations: [auto('x', 'a1'), auto('y', 'b2')],
      selectedAgentId: 'a1',
      selected: { folder: 'f', id: 's1' },
      page: { kind: 'agent', id: 'a1' },
      tab: 'threads',
      readingSession: null,
    })
  })

  it("showAutomation opens the automation's own page — its one home — for any agent, and loads its runs", () => {
    useStore.getState().showAutomation('y')
    const s = useStore.getState()
    expect(s.page).toEqual({ kind: 'automation', id: 'y' })
    expect(s.selected).toEqual({ folder: 'f', id: 's1' }) // the conversation is kept behind
    expect(mockedApi.automations.runs).toHaveBeenCalledWith('y')
  })

  it('an unknown automation is a no-op', () => {
    useStore.getState().showAutomation('nope')
    expect(useStore.getState().page).toEqual({ kind: 'agent', id: 'a1' })
  })

  it('readSession / closeReading — a conversation read as a window, then put down', () => {
    useStore.getState().readSession('f', 's9')
    expect(useStore.getState().readingSession).toEqual({ folder: 'f', id: 's9' })
    useStore.getState().closeReading()
    expect(useStore.getState().readingSession).toBeNull()
  })
})
