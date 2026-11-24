import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { App } from '../src/App'
import { useStore } from '../src/store'
import { api } from '../src/lib/api'
import { WsClient } from '../src/lib/ws'
import { isLive } from '../src/lib/live'

vi.mock('../src/lib/api')
// the real WsClient opens a real socket — the wiring tests care about
// firing `onStatus` by hand, without depending on timers/network; the
// automock keeps the shape (connect/close as no-ops) and lets the
// constructor's arguments be inspected.
vi.mock('../src/lib/ws')

const mockedApi = vi.mocked(api, { deep: true })
const mockedWsClient = vi.mocked(WsClient)

beforeEach(() => {
  vi.clearAllMocks()
  // the Sidebar adopts the drawn conversation order into prefs on mount —
  // an automocked api returns undefined, which the store's .catch can't ride.
  mockedApi.patchPrefsConversationSlots.mockResolvedValue({})
  useStore.setState({
    chatMode: 'chat',
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
    connection: 'connected',
  })
})

describe('App — boot', () => {
  it('if loadOverview fails on mount, the error reaches the store', async () => {
    mockedApi.overview.mockRejectedValueOnce(new Error('overview failed'))
    render(<App />)
    await waitFor(() => expect(useStore.getState().error).toBe('overview failed'))
  })

  it("navigating to page={agent,id}+tab settings mounts the real AgentPage from App's tree", async () => {
    mockedApi.overview.mockResolvedValue({
      agents: [
        {
          id: 'a1',
          name: 'Ana',
          emoji: '🧠',

          folder: '/home/user/ana',
          skills: [],
          sessions: [],
          liveCount: 0,
          sessionCount: 0,
        },
      ],
      now: 0,
      warming: false,
    })
    // zone 1 (InChargeOf) fetches GET /api/agents/:id/autonomy unconditionally
    // for a folder agent's Identity tab — an unmocked call throws (see
    // agent-page.test.tsx's own default for the same reason).
    render(<App />)
    await waitFor(() => expect(useStore.getState().agents).toHaveLength(1))

    act(() => useStore.setState({ page: { kind: 'agent', id: 'a1' }, tab: 'identity' }))

    // the dossier's Who zone is read-first — the Name field only
    // mounts once the SettingsTab editor is expanded (any config chip, or
    // the charter's "Edit ✎"/"No charter yet — Edit ›").
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }))
    await waitFor(() => expect(screen.getByLabelText('Name')).toHaveValue('Ana'))
  })
})

describe('App — connection↔resync wiring', () => {
  it("the first successful connection does NOT trigger a resync (it wasn't reconnecting)", async () => {
    mockedApi.overview.mockResolvedValue({ agents: [], now: 0, warming: false })
    const resyncSpy = vi.fn().mockResolvedValue(undefined)
    useStore.setState({ resync: resyncSpy })

    render(<App />)
    await waitFor(() => expect(mockedWsClient).toHaveBeenCalledTimes(1))

    const onStatus = mockedWsClient.mock.calls[0]![1]?.onStatus
    expect(onStatus).toBeDefined()
    onStatus!('connected') // the first open, already starting 'connected' by default

    expect(useStore.getState().connection).toBe('connected')
    expect(resyncSpy).not.toHaveBeenCalled()
  })

  it('a drop and reconnect (reconnecting → connected) DOES trigger a resync', async () => {
    mockedApi.overview.mockResolvedValue({ agents: [], now: 0, warming: false })
    const resyncSpy = vi.fn().mockResolvedValue(undefined)
    useStore.setState({ resync: resyncSpy })

    render(<App />)
    await waitFor(() => expect(mockedWsClient).toHaveBeenCalledTimes(1))
    const onStatus = mockedWsClient.mock.calls[0]![1]!.onStatus!

    onStatus('reconnecting')
    expect(useStore.getState().connection).toBe('reconnecting')
    expect(resyncSpy).not.toHaveBeenCalled()

    onStatus('connected')
    expect(useStore.getState().connection).toBe('connected')
    expect(resyncSpy).toHaveBeenCalledTimes(1)
  })
})

// the "live" badge is no longer painted statically from the server — it's
// derived client-side with isLive(mtime, nowTick). Before the fix, a lit
// badge stayed a zombie until that session's next WS event (which could
// take minutes or hours); now the boot's 30s interval (App.tsx) turns it
// off on its own, with no need for any 'session' event.
describe('App — the live clock', () => {
  it("the live badge turns off on its own after 121s with no events, via the boot's 30s interval", async () => {
    vi.useFakeTimers()
    try {
      const start = new Date(2030, 0, 1, 0, 0, 0).getTime()
      vi.setSystemTime(start)
      mockedApi.overview.mockResolvedValue({
        agents: [
          {
            id: 'a1',
            name: 'Ana',
            emoji: '🧠',

            folder: '/x',
            skills: [],
            sessions: [
              {
                id: 's1',
                folder: 'f',
                title: 'Chat',
                skills: [],
                cwd: null,
                mtime: start,
                size: 1,
                turnCount: 1,
                live: true,
                worktree: false,
                native: true,
                agentId: 'a1',
              },
            ],
            liveCount: 1,
            sessionCount: 1,
          },
        ],
        now: start,
        warming: false,
      })

      render(<App />)
      await act(async () => {
        await Promise.resolve()
        await Promise.resolve()
      })
      // the sidebar no longer paints a pulse — the clock
      // is observed on the store itself: isLive(mtime, nowTick) is what
      // every remaining live surface (ContextColumn, AgentPage) reads.
      expect(isLive(start, useStore.getState().nowTick)).toBe(true)

      // no 'session' event at all — time just passes.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(121_000)
      })
      expect(isLive(start, useStore.getState().nowTick)).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('App — providers freshness', () => {
  it('coming back to the tab re-reads providers (a `claude auth login` outside the app must reach every runs-on line)', async () => {
    render(<App />)
    await waitFor(() => expect(mockedApi.providers.list).toHaveBeenCalledTimes(1))
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'))
    }) // jsdom's visibilityState is 'visible'
    await waitFor(() => expect(mockedApi.providers.list).toHaveBeenCalledTimes(2))
  })
})
