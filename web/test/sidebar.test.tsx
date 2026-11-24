import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { Sidebar } from '../src/components/Sidebar'
import { useStore } from '../src/store'
import { api } from '../src/lib/api'
import { relTime } from '../src/lib/rel-time'
import { INACTIVE_MS } from '../src/lib/grouping'
import type { AgentView, Automation, SessionView } from '../src/lib/types'
import { MASTER_ID } from '../src/lib/constants'

const NOW = 1_700_000_000_000

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

// liveCount is no longer read from the snapshot (agent.liveCount) — the
// Sidebar derives it from agent.sessions with isLive(mtime, nowTick).
// "Live" sessions in these tests carry mtime === NOW === nowTick (diff 0).
function makeSession(overrides: Partial<SessionView> = {}): SessionView {
  return {
    id: 's1',
    folder: 'f',
    title: 'Session',
    skills: [],
    cwd: null,
    mtime: NOW,
    size: 10,
    turnCount: 1,
    live: false,
    worktree: false,
    native: true,
    agentId: 'a1',
    ...overrides,
  }
}

beforeEach(() => {
  // the Sidebar adopts the drawn order into prefs on mount (adoptConversationOrder)
  // — never let a test reach the network for it.
  vi.spyOn(api, 'patchPrefsConversationSlots').mockResolvedValue({})
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
    nowTick: NOW,
    unreadAgentIds: new Set(),
    projectsPrefs: {},
    collapsedAgents: [],
    olderOpenAgents: [],
    automations: [],
    automationsPending: [],
    agentOrder: [],
    conversationSlots: {},
    detachedChains: [],
    nav: { filter: {}, groupBy: 'project', preset: 'default' },
    // the visual selection is also derived from page/newChatOpen — without
    // resetting them here, state navigated by a previous test leaks into
    // the next one (and an aria-current could pass "by accident").
    page: null,
    newChatOpen: false,
    // the Silo Standard's rail doors: zero silos = no door (setState merges,
    // so an explicit reset keeps tests from leaking into each other).
    silos: [],
  })
})

// rename/delete live inside the topic's ⋯ menu ("topic options") — opening
// it is the first step of any row action. With several topics rendered
// there are several triggers: the first corresponds to the most recent
// topic (mtime desc order).
function openTopicMenu(index = 0): void {
  fireEvent.click(screen.getAllByLabelText('topic options')[index]!)
}

// a minimal DataTransfer fake to simulate native drag&drop in jsdom (which
// doesn't implement it) — the SAME instance is passed to dragStart and to
// drop (fireEvent allows injecting `dataTransfer` into the synthetic
// event), just like the real browser keeps it alive for the whole gesture.
class FakeDataTransfer {
  private data: Record<string, string> = {}
  effectAllowed = ''
  setData(kind: string, value: string): void {
    this.data[kind] = value
  }
  getData(kind: string): string {
    return this.data[kind] ?? ''
  }
}

function headerFor(folderName: string): HTMLElement {
  const el = screen.getAllByTestId('group-header').find((e) => e.textContent?.includes(folderName))
  if (!el) throw new Error(`no group header found for "${folderName}"`)
  return el
}

describe('Sidebar', () => {
  it('shows the wordmark and the agent names', () => {
    useStore.setState({
      agents: [makeAgent({ id: 'a1', name: 'Ana' }), makeAgent({ id: 'b2', name: 'Beto' })],
    })
    render(<Sidebar />)
    expect(screen.getByText('Silos')).toBeInTheDocument()
    expect(screen.getByText('Ana')).toBeInTheDocument()
    expect(screen.getByText('Beto')).toBeInTheDocument()
  })

  it('clicking an agent selects it in the state', () => {
    useStore.setState({ agents: [makeAgent({ id: 'a1', name: 'Ana' })] })
    render(<Sidebar />)
    fireEvent.click(screen.getByText('Ana'))
    expect(useStore.getState().selectedAgentId).toBe('a1')
  })

  // the agent row only marks "you're here" when its DOSSIER is the open
  // page — with a conversation open, the selection lives in the # topic
  // (see the "conversation-first selection" describe below).
  it('marks the agent with aria-current when its dossier is the open page', () => {
    useStore.setState({
      agents: [makeAgent({ id: 'a1', name: 'Ana' })],
      selectedAgentId: 'a1',
      page: { kind: 'agent', id: 'a1' },
    })
    render(<Sidebar />)
    expect(screen.getByText('Ana').closest('button')).toHaveAttribute('aria-current', 'true')
  })

  // the "live" pulse/chip on conversation rows was removed (noise) — no
  // pulse anywhere in the sidebar, live or not, and no
  // agent-level roll-up count either.
  describe('agents: drag-only order', () => {
    it('agentOrder (prefs.agentOrder) decides the rows inside a project; unknown agents follow', () => {
      useStore.setState({
        agents: [
          makeAgent({ id: 'a1', name: 'Ana', folder: '/p' }),
          makeAgent({ id: 'b2', name: 'Beto', folder: '/p' }),
          makeAgent({ id: 'c3', name: 'Cata', folder: '/p' }),
        ],
        agentOrder: ['c3', 'b2'],
      })
      render(<Sidebar />)
      const names = screen.getAllByTestId('agent-row').map((r) => r.textContent ?? '')
      expect(names.findIndex((t) => t.includes('Cata'))).toBeLessThan(names.findIndex((t) => t.includes('Beto')))
      expect(names.findIndex((t) => t.includes('Beto'))).toBeLessThan(names.findIndex((t) => t.includes('Ana')))
    })

    it('dropping an agent row onto another persists the new global order (agentOrder)', async () => {
      const spy = vi.spyOn(api, 'patchPrefsAgentOrder').mockResolvedValue({})
      useStore.setState({
        agents: [makeAgent({ id: 'a1', name: 'Ana', folder: '/p' }), makeAgent({ id: 'b2', name: 'Beto', folder: '/p' })],
        agentOrder: [],
      })
      render(<Sidebar />)
      const rows = screen.getAllByTestId('agent-row')
      const dt = new FakeDataTransfer()
      fireEvent.dragStart(rows[1]!, { dataTransfer: dt })
      fireEvent.dragOver(rows[0]!, { dataTransfer: dt })
      fireEvent.drop(rows[0]!, { dataTransfer: dt })
      await waitFor(() => expect(spy).toHaveBeenCalledWith(['b2', 'a1']))
      expect(useStore.getState().agentOrder).toEqual(['b2', 'a1'])
    })
  })

  describe('chains: drag out / drag back', () => {
    function chainAgent() {
      return makeAgent({
        id: 'a1',
        name: 'Ana',
        sessions: [
          makeSession({ id: 'head', folder: 'f', title: 'Head', mtime: NOW, agentId: 'a1', parentKey: 'f/old' }),
          makeSession({ id: 'old', folder: 'f', title: 'Old', mtime: NOW - 5000, agentId: 'a1' }),
        ],
      })
    }
    // a /clear child is its own conversation and the only row: the thread
    // it left behind (head + old) is archived — no row.
    it('a continuation is ONE row (no earlier rows, no affix); a /clear child is its own row and the thread it left is archived', () => {
      useStore.setState({
        agents: [
          makeAgent({
            id: 'a1',
            name: 'Ana',
            sessions: [
              makeSession({ id: 'clr', folder: 'f', title: 'Cleared', mtime: NOW + 1000, agentId: 'a1', parentKey: 'f/head', parentKind: 'clear' }),
              ...chainAgent().sessions,
            ],
          }),
        ],
        selectedAgentId: 'a1',
        selected: null,
        detachedChains: [],
      })
      render(<Sidebar />)
      const rows = screen.getAllByTestId('session-row').map((r) => r.getAttribute('data-session-key'))
      expect(rows).toEqual(['f/clr'])
      expect(screen.queryByText(/earlier/)).not.toBeInTheDocument()
      expect(screen.queryByRole('button', { name: /archived/i })).toBeNull()
    })

    it('a detached row dragged back onto its chain head nests again', async () => {
      const spy = vi.spyOn(api, 'patchPrefsDetachedChains').mockResolvedValue({})
      // the CHILD is the detached one (its parent link is what gets cut)
      useStore.setState({ agents: [chainAgent()], selectedAgentId: 'a1', selected: null, detachedChains: ['f/head'] })
      render(<Sidebar />)
      const byKey = (k: string) => screen.getAllByTestId('session-row').find((r) => r.getAttribute('data-session-key') === k)!
      expect(byKey('f/old')).toBeTruthy()
      const dt = new FakeDataTransfer()
      fireEvent.dragStart(byKey('f/head'), { dataTransfer: dt })
      fireEvent.dragOver(byKey('f/old'), { dataTransfer: dt })
      fireEvent.drop(byKey('f/old'), { dataTransfer: dt })
      await waitFor(() => expect(spy).toHaveBeenCalledWith([]))
      // nested again: one row for the thread, its tip
      expect(screen.getAllByTestId('session-row').map((r) => r.getAttribute('data-session-key'))).toEqual(['f/head'])
    })
  })

  // the order: newest activity first; a conversation the user drags
  // stays FIXED at the position it was dropped at. Older ones fold under
  // "N older" whether the agent is selected or not.
  describe('the order — newest first, dragged ones fixed in place', () => {
    function three(): void {
      useStore.setState({
        agents: [
          makeAgent({
            id: 'a1',
            name: 'Ana',
            sessions: [
              makeSession({ id: 's1', folder: 'f', title: 'One', mtime: NOW - 1000, agentId: 'a1' }),
              makeSession({ id: 's2', folder: 'f', title: 'Two', mtime: NOW - 2000, agentId: 'a1' }),
              makeSession({ id: 's3', folder: 'f', title: 'Three', mtime: NOW - 3000, agentId: 'a1' }),
            ],
          }),
        ],
        selectedAgentId: 'a1',
        selected: null,
      })
    }
    const titles = () => screen.getAllByText(/^(One|Two|Three|Four)$/).map((el) => el.textContent)
    const byKey = (k: string) => screen.getAllByTestId('session-row').find((r) => r.getAttribute('data-session-key') === k)!

    it('activity reorders: a conversation that moves rises to the top; nothing is persisted for it', () => {
      const spy = vi.spyOn(api, 'patchPrefsConversationSlots').mockResolvedValue({})
      spy.mockClear()
      three()
      render(<Sidebar />)
      expect(titles()).toEqual(['One', 'Two', 'Three'])
      act(() => {
        useStore.getState().applyWs({ ev: 'session', meta: makeSession({ id: 's3', folder: 'f', title: 'Three', mtime: NOW + 5000, agentId: 'a1' }) })
      })
      expect(titles()).toEqual(['Three', 'One', 'Two'])
      expect(spy).not.toHaveBeenCalled()
    })

    it('dropping a conversation onto another fixes it at that position; only that agent travels', async () => {
      const spy = vi.spyOn(api, 'patchPrefsConversationSlots').mockResolvedValue({})
      three()
      useStore.setState({ conversationSlots: { other: [{ key: 'g/x', at: 0 }] } })
      render(<Sidebar />)
      const dt = new FakeDataTransfer()
      fireEvent.dragStart(byKey('f/s3'), { dataTransfer: dt })
      fireEvent.dragOver(byKey('f/s1'), { dataTransfer: dt })
      fireEvent.drop(byKey('f/s1'), { dataTransfer: dt })
      await waitFor(() => expect(spy).toHaveBeenLastCalledWith({ a1: [{ key: 'f/s3', at: 0 }] }))
      expect(useStore.getState().conversationSlots).toEqual({ other: [{ key: 'g/x', at: 0 }], a1: [{ key: 'f/s3', at: 0 }] })
      expect(titles()).toEqual(['Three', 'One', 'Two'])
    })

    it('a fixed conversation holds its position while newer activity flows around it', () => {
      three()
      useStore.setState({ conversationSlots: { a1: [{ key: 'f/s3', at: 1 }] } })
      render(<Sidebar />)
      expect(titles()).toEqual(['One', 'Three', 'Two'])
      act(() => {
        useStore.getState().applyWs({ ev: 'session', meta: makeSession({ id: 's4', folder: 'f', title: 'Four', mtime: NOW + 6000, agentId: 'a1' }) })
      })
      // (the event moves nowTick to the real clock, so the 4th folds under "1 older")
      expect(titles().slice(0, 3)).toEqual(['Four', 'Three', 'One'])
    })

    it('only a fixed row offers "Unfix position", and it lets the row flow again', async () => {
      const spy = vi.spyOn(api, 'patchPrefsConversationSlots').mockResolvedValue({})
      three()
      useStore.setState({ conversationSlots: { a1: [{ key: 'f/s3', at: 0 }] } })
      render(<Sidebar />)
      fireEvent.click(within(byKey('f/s1')).getByLabelText('topic options'))
      expect(screen.queryByRole('menuitem', { name: 'Unfix position' })).toBeNull()
      fireEvent.keyDown(document, { key: 'Escape' })
      fireEvent.click(within(byKey('f/s3')).getByLabelText('topic options'))
      fireEvent.click(screen.getByRole('menuitem', { name: 'Unfix position' }))
      await waitFor(() => expect(spy).toHaveBeenLastCalledWith({ a1: [] }))
      expect(titles()).toEqual(['One', 'Two', 'Three'])
    })

    it('a rotated chain (new head via /clear) keeps its fixed position', () => {
      three()
      useStore.setState({ conversationSlots: { a1: [{ key: 'f/s3', at: 0 }] } })
      render(<Sidebar />)
      act(() => {
        useStore
          .getState()
          .applyWs({ ev: 'session', meta: makeSession({ id: 's3b', folder: 'f', title: 'Three', mtime: NOW - 2500, agentId: 'a1', parentKey: 'f/s3' }) })
      })
      const rows = () => screen.getAllByTestId('session-row').map((r) => r.getAttribute('data-session-key'))
      expect(rows()).toEqual(['f/s3b', 'f/s1', 'f/s2'])
    })

    it('an agent that is NOT selected also folds its older conversations under "N older", and it opens', () => {
      const many = Array.from({ length: 8 }, (_, i) =>
        makeSession({ id: `m${i}`, folder: 'f', title: `Conv ${i}`, mtime: NOW - (i + 1) * 30 * 86_400_000, agentId: 'a1' }),
      )
      useStore.setState({
        agents: [makeAgent({ id: 'a1', name: 'Ana', sessions: many }), makeAgent({ id: 'a2', name: 'Bea', sessions: [] })],
        selectedAgentId: 'a2',
        selected: null,
      })
      render(<Sidebar />)
      fireEvent.click(screen.getByRole('button', { name: /5 older/ }))
      expect(screen.getByText('Conv 7')).toBeTruthy()
    })

    // the fold is the AGENT's state, not the component instance's: opening
    // one of the unfolded conversations makes that agent the selected one,
    // which swaps its compact block for the full one (a remount) — the
    // older rows must still be there afterwards (they used to hide again).
    it('"N older" stays open after opening one of the older conversations of a non-selected agent', async () => {
      vi.spyOn(api, 'sessionDetail').mockResolvedValue({ meta: makeSession({ id: 'm7', folder: 'f' }), turns: [], total: 0 })
      vi.spyOn(api, 'markSeen').mockResolvedValue(undefined)
      const many = Array.from({ length: 8 }, (_, i) =>
        makeSession({ id: `m${i}`, folder: 'f', title: `Conv ${i}`, mtime: NOW - (i + 1) * 30 * 86_400_000, agentId: 'a1' }),
      )
      useStore.setState({
        agents: [makeAgent({ id: 'a1', name: 'Ana', sessions: many }), makeAgent({ id: 'a2', name: 'Bea', sessions: [] })],
        selectedAgentId: 'a2',
        selected: null,
      })
      render(<Sidebar />)
      fireEvent.click(screen.getByRole('button', { name: /5 older/ }))
      await act(async () => {
        fireEvent.click(screen.getByText('Conv 7'))
      })
      expect(useStore.getState().selectedAgentId).toBe('a1')
      expect(screen.getByText('Conv 7')).toBeTruthy()
      expect(screen.getByText('Conv 5')).toBeTruthy()
      expect(screen.queryByRole('button', { name: /5 older/ })).toBeNull()
      expect(screen.getByRole('button', { name: /Hide older/ })).toBeTruthy()
    })

    // the same when the agent IS selected and its row gets clicked (the
    // click remounts the block on purpose, to reopen the md rail's overlay).
    it('"N older" survives a click on the agent\'s own row', () => {
      const many = Array.from({ length: 8 }, (_, i) =>
        makeSession({ id: `m${i}`, folder: 'f', title: `Conv ${i}`, mtime: NOW - (i + 1) * 30 * 86_400_000, agentId: 'a1' }),
      )
      useStore.setState({ agents: [makeAgent({ id: 'a1', name: 'Ana', sessions: many })], selectedAgentId: 'a1', selected: null })
      render(<Sidebar />)
      fireEvent.click(screen.getByRole('button', { name: /5 older/ }))
      fireEvent.click(screen.getByText('Ana'))
      expect(screen.getByText('Conv 7')).toBeTruthy()
    })

    it('a conversation fixed further down is never folded away', () => {
      const many = Array.from({ length: 8 }, (_, i) =>
        makeSession({ id: `m${i}`, folder: 'f', title: `Conv ${i}`, mtime: NOW - (i + 1) * 30 * 86_400_000, agentId: 'a1' }),
      )
      useStore.setState({
        agents: [makeAgent({ id: 'a1', name: 'Ana', sessions: many })],
        selectedAgentId: 'a1',
        selected: null,
        conversationSlots: { a1: [{ key: 'f/m7', at: 4 }] },
      })
      render(<Sidebar />)
      expect(screen.getByText('Conv 7')).toBeTruthy()
      expect(screen.getByRole('button', { name: /3 older/ })).toBeTruthy()
    })
  })

  describe('the conversation dot', () => {
    it("blinks (dot-blink) while the agent is working: agent's turn + live activity", () => {
      useStore.setState({
        agents: [makeAgent({ id: 'a1', name: 'Ana', sessions: [makeSession({ id: 's1', mtime: NOW, lastRole: 'user', unread: false })] })],
        selectedAgentId: 'a1',
        selected: null,
      })
      render(<Sidebar />)
      const dot = screen.getByTestId('session-dot')
      expect(dot).toHaveAttribute('data-signal', 'working')
      expect(dot.className).toContain('dot-blink')
    })

    // the main turn closed, a background subagent runs a long test
    // suite — silent inside one tool call; the dot blinks for it (live.ts
    // backgroundWorking), and stops once nothing is in flight
    it('blinks for a background agent silent 5 min inside a tool, the turn closed — solid unread once nothing is in flight', () => {
      const quiet = { id: 's1', mtime: NOW - 20 * 60_000, lastRole: 'assistant' as const, turnOpen: false, unread: true, subMtime: NOW - 5 * 60_000 }
      useStore.setState({
        agents: [makeAgent({ id: 'a1', name: 'Ana', sessions: [makeSession({ ...quiet, subToolSince: NOW - 5 * 60_000 })] })],
        selectedAgentId: 'a1',
        selected: null,
        nowTick: NOW,
      })
      const { unmount } = render(<Sidebar />)
      expect(screen.getByTestId('session-dot')).toHaveAttribute('data-signal', 'working')
      expect(screen.getByTestId('session-dot').className).toContain('dot-blink')
      unmount()
      useStore.setState({ agents: [makeAgent({ id: 'a1', name: 'Ana', sessions: [makeSession(quiet)] })] })
      render(<Sidebar />)
      expect(screen.getByTestId('session-dot')).toHaveAttribute('data-signal', 'attention')
      expect(screen.getByTestId('session-dot').className).not.toContain('dot-blink')
    })

    it('stays solid when the agent replied and you have not looked (durable unread)', () => {
      useStore.setState({
        agents: [makeAgent({ id: 'a1', name: 'Ana', sessions: [makeSession({ id: 's1', mtime: NOW - 3_600_000, lastRole: 'assistant', unread: true })] })],
        selectedAgentId: 'a1',
        selected: null,
      })
      render(<Sidebar />)
      const dot = screen.getByTestId('session-dot')
      expect(dot).toHaveAttribute('data-signal', 'attention')
      expect(dot.className).not.toContain('dot-blink')
    })

    it('no dot on the OPEN conversation, nor on an up-to-date one', () => {
      useStore.setState({
        agents: [
          makeAgent({
            id: 'a1',
            name: 'Ana',
            sessions: [
              makeSession({ id: 's1', folder: 'f', mtime: NOW, lastRole: 'user', unread: false }),
              makeSession({ id: 's2', folder: 'f', mtime: NOW - 1000, lastRole: 'assistant', unread: false }),
            ],
          }),
        ],
        selectedAgentId: 'a1',
        selected: { folder: 'f', id: 's1' },
      })
      render(<Sidebar />)
      expect(screen.queryByTestId('session-dot')).not.toBeInTheDocument()
    })
  })

  it('renders no live pulse on conversation rows, even when they are live', () => {
    useStore.setState({
      agents: [
        makeAgent({
          id: 'a1',
          name: 'Ana',
          sessions: [makeSession({ id: 's1', mtime: NOW }), makeSession({ id: 's2', mtime: NOW })],
        }),
      ],
    })
    render(<Sidebar />)
    expect(screen.queryByTestId('pulse')).not.toBeInTheDocument()
    expect(screen.queryByText('live')).not.toBeInTheDocument()
    expect(screen.queryByText('2')).not.toBeInTheDocument()
  })

  // "+ New agent"/"Create skill"/the theme toggle left the Sidebar's footer
  // (see AccountFooter) — "+ New agent" is now reached from a group
  // header's "+ agent" hover (prefilled) or from ProjectPage; "Create
  // skill" still lives in AgentPage's Skills tab. Those paths' coverage:
  // sidebar-header below, project-page.test.tsx, and agent-page.test.tsx.

  // The master is the inbox (a CATEGORY, not an agent): it has no name row,
  // its loose sessions hang straight off the "Unassigned" label, at the
  // bottom after every real agent.
  it('the inbox goes AT THE BOTTOM (after the agents) under "Unassigned", with no name row', () => {
    useStore.setState({
      agents: [
        makeAgent({ id: 'master', name: 'Master', folder: null, sessions: [makeSession({ id: 'm1', title: 'Loose', agentId: 'master' })] }),
        makeAgent({ id: 'a1', name: 'Ana', folder: '/a/one', sessions: [makeSession({ id: 's1', title: 'Ana chat', agentId: 'a1' })] }),
      ],
    })
    render(<Sidebar />)
    // no "Anywhere" name row: the inbox is a section, not an agent.
    expect(screen.queryByText('Anywhere')).not.toBeInTheDocument()
    const ana = screen.getByText('Ana')
    const unassigned = screen.getByText('Unassigned')
    expect(screen.getByText('Loose')).toBeInTheDocument()
    // Unassigned sits AFTER the agents in document order.
    expect(ana.compareDocumentPosition(unassigned) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('shows the "indexing sessions…" ribbon when warming is true', () => {
    useStore.setState({ warming: true })
    render(<Sidebar />)
    expect(screen.getByText('indexing sessions…')).toBeInTheDocument()
  })

  it('does not show the indexing ribbon when warming is false', () => {
    useStore.setState({ warming: false })
    render(<Sidebar />)
    expect(screen.queryByText('indexing sessions…')).not.toBeInTheDocument()
  })

  // the unread dot — static, in ink (NOT terracotta, NOT animated like the
  // live-sessions Pulse).
  it('renders the unread dot for an agent in unreadAgentIds', () => {
    useStore.setState({
      agents: [makeAgent({ id: 'a1', name: 'Ana' })],
      unreadAgentIds: new Set(['a1']),
    })
    render(<Sidebar />)
    const dot = screen.getByTestId('unread-dot')
    expect(dot).toBeInTheDocument()
    expect(dot.className).toContain('bg-ink')
    expect(dot.className).not.toContain('terracotta')
    expect(dot.className).not.toContain('dot-blink')
  })

  it('does not render the unread dot for an agent outside unreadAgentIds', () => {
    useStore.setState({
      agents: [makeAgent({ id: 'a1', name: 'Ana' })],
      unreadAgentIds: new Set(),
    })
    render(<Sidebar />)
    expect(screen.queryByTestId('unread-dot')).not.toBeInTheDocument()
  })

  it('selecting an unread agent clears it from unreadAgentIds (via selectAgent)', () => {
    useStore.setState({
      agents: [makeAgent({ id: 'a1', name: 'Ana' })],
      unreadAgentIds: new Set(['a1']),
    })
    render(<Sidebar />)
    fireEvent.click(screen.getByText('Ana'))
    expect(useStore.getState().unreadAgentIds.has('a1')).toBe(false)
  })

  it('a live AND unread agent still shows the unread dot (and no pulse)', () => {
    useStore.setState({
      agents: [makeAgent({ id: 'a1', name: 'Ana', sessions: [makeSession({ id: 's1', mtime: NOW })] })],
      unreadAgentIds: new Set(['a1']),
    })
    render(<Sidebar />)
    expect(screen.queryByTestId('pulse')).not.toBeInTheDocument()
    expect(screen.getByTestId('unread-dot')).toBeInTheDocument()
  })

  // the theme toggle moved to SettingsPage › Appearance (left the
  // Sidebar's footer) — "respects the system preference" coverage now
  // lives in settings-page.test.tsx (the same useDarkMode hook, re-exported).
})

// the Sidebar's footer — the account (GET /api/account) + ⚙ → settings.
// Replaces "+ New agent"/"Create skill"/theme toggle/Archived.
describe('Sidebar — the account footer', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('with an account, shows the email (and plan if present) + initials', async () => {
    vi.spyOn(api, 'account').mockResolvedValue({
      email: 'owner@example.com',
      plan: 'Max',
      organizationName: null,
    })
    render(<Sidebar />)
    await waitFor(() => expect(screen.getByText('owner@example.com')).toBeInTheDocument())
    expect(screen.getByText('O')).toBeInTheDocument() // the avatar's initial
    expect(screen.getByText(/Max/)).toBeInTheDocument()
  })

  it('with no account (null), shows "Not signed in"', async () => {
    vi.spyOn(api, 'account').mockResolvedValue(null)
    render(<Sidebar />)
    await waitFor(() => expect(screen.getByText('Not signed in')).toBeInTheDocument())
  })

  it('the ⚙ Settings button navigates to page={settings}', () => {
    vi.spyOn(api, 'account').mockResolvedValue(null)
    render(<Sidebar />)
    fireEvent.click(screen.getByLabelText('Settings'))
    expect(useStore.getState().page).toEqual({ kind: 'settings' })
  })
})

// the global navigation menu — a fixed section above the sidebar, labeled,
// with an active state; Settings does NOT go here (it stays in the footer's
// gear). Automations has its own entry: they left the sidebar's tree, so
// their page needs a door. Board and Map are NOT doors (the inbox comes
// first): they are lenses on Home's date line and ⌘K; their pages stay.
describe('Sidebar — the global navigation menu', () => {
  beforeEach(() => {
    useStore.setState({ automationsPending: [], page: null, silos: [] })
  })

  it('Home is the mark; Automations and System are the rail — no Tasks, Files, Vault, Board or Map entry; Settings stays in the footer', () => {
    render(<Sidebar />)
    expect(screen.getByTestId('rail-home')).toBeInTheDocument()
    // System is the one door to the machine: with no System
    // lands on Vitals (/system), silo or not; the sidebar's switch is the door to Tasks
    fireEvent.click(screen.getByLabelText('System'))
    expect(useStore.getState().page).toEqual({ kind: 'system' })
    fireEvent.click(screen.getByRole('tab', { name: 'Tasks' }))
    expect(useStore.getState().page).toEqual({ kind: 'tasks' })
    for (const gone of ['Files', 'Vault']) expect(screen.queryByLabelText(gone, { exact: true })).not.toBeInTheDocument()
    expect(screen.getByLabelText('Automations')).toBeInTheDocument()
    // the rail diet: Board and Map are lenses, opened from Home and ⌘K
    expect(screen.queryByLabelText('Board', { exact: true })).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Map', { exact: true })).not.toBeInTheDocument()
    // Settings is NOT in the menu: it stays in its footer gear.
    expect(screen.getByLabelText('Settings')).toBeInTheDocument()
  })

  it('runs pending approval put NO badge in the menu — approvals surface in each conversation', () => {
    useStore.setState({
      automationsPending: [
        { id: 'r1', automationId: 'a1', at: '2026-08-19T00:00:00.000Z', status: 'waiting_approval' },
        { id: 'r2', automationId: 'a2', at: '2026-08-19T00:00:00.000Z', status: 'waiting_approval' },
      ],
    })
    render(<Sidebar />)
    expect(screen.getByLabelText('Automations')).not.toHaveTextContent(/\d/)
  })

  // support is a silo: its door is the generic rail entry of an
  // active silo whose rail slot stands — gone when the owner uninstalls it
  it("no hand-written Support door: the Support silo's rail entry, only while it is installed", () => {
    const first = render(<Sidebar />)
    expect(screen.queryByLabelText('Support')).not.toBeInTheDocument()
    first.unmount()
    useStore.setState({
      silos: [
        {
          id: 'support',
          name: 'Support',
          description: null,
          version: '0.2.0',
          apiVersion: null,
          state: 'active',
          reason: '',
          conventions: [],
          wants: [],
          kinds: ['support/case'],
          producer: null,
          records: { parsed: 0, failed: 0 },
          lastWrite: null,
          freshness: null,
          slots: { requested: ['rail'], granted: ['rail'], off: [] },
          observedAt: '',
        },
      ],
    })
    render(<Sidebar />)
    fireEvent.click(screen.getByLabelText('Support'))
    expect(useStore.getState().page).toEqual({ kind: 'silo', id: 'support' })
  })

  it('on a lens page (Map, Org) no rail door claims to be current', () => {
    for (const page of [{ kind: 'map' as const }, { kind: 'map' as const, view: 'org' as const }]) {
      useStore.setState({ page })
      const { unmount } = render(<Sidebar />)
      for (const b of screen.getAllByRole('button')) {
        if (b.getAttribute('aria-current') === 'true') expect(b).not.toHaveAccessibleName(/^(Home|Automations|Support)$/)
      }
      unmount()
    }
  })

  it('Home shows the page itself — on a phone too (mobileView chat, never the bare list)', () => {
    useStore.setState({ page: { kind: 'vault' }, mobileView: 'list' })
    render(<Sidebar />)
    fireEvent.click(screen.getByTestId('rail-home'))
    expect(useStore.getState().page).toBeNull()
    expect(useStore.getState().mobileView).toBe('chat')
  })
})

describe('Sidebar — the project visible per agent', () => {
  it('with more than one distinct folder, groups and shows headers with the basename', () => {
    useStore.setState({
      agents: [
        makeAgent({ id: 'a1', name: 'Ana', folder: '/a/one' }),
        makeAgent({ id: 'a2', name: 'Beto', folder: '/a/one' }),
        makeAgent({ id: 'a3', name: 'Coco', folder: '/b/two' }),
      ],
    })
    render(<Sidebar />)
    expect(screen.getByText('one')).toBeInTheDocument()
    expect(screen.getByText('two')).toBeInTheDocument()
  })

  it('with all agents in the same folder, there are no headers and each row shows the basename', () => {
    useStore.setState({
      agents: [makeAgent({ id: 'a1', name: 'Ana', folder: '/a/one' }), makeAgent({ id: 'a2', name: 'Beto', folder: '/a/one' })],
    })
    render(<Sidebar />)
    // no group header (there'd be an extra 'one'): only the 2 rows repeat the basename
    expect(screen.getAllByText('one')).toHaveLength(2)
  })

  it('the inbox (master) stays out of the folder grouping, at the bottom under "Unassigned"', () => {
    useStore.setState({
      agents: [
        makeAgent({ id: 'a1', name: 'Ana', folder: '/a/one' }),
        makeAgent({ id: 'a2', name: 'Beto', folder: '/b/two' }),
        makeAgent({ id: 'master', name: 'Master', folder: null, sessions: [makeSession({ id: 'm1', title: 'Loose', agentId: 'master' })] }),
      ],
    })
    render(<Sidebar />)
    expect(screen.getByText('one')).toBeInTheDocument()
    expect(screen.getByText('two')).toBeInTheDocument()
    expect(screen.getByText('Unassigned')).toBeInTheDocument()
    expect(screen.getByText('Loose')).toBeInTheDocument()
  })
})

// the Sidebar footer's "Archived" accordion was retired — its coverage now
// lives in settings-page.test.tsx (SettingsPage › Agents).

// sessions under each agent — what Threads.tsx used to do (opening/
// renaming/trashing rows, a text filter, live pulses, an optimistic title
// reconciliation) migrated into the block that expands inline under the
// selected agent. A per-agent collapse chevron, persisted in
// ~/.silos/ui.json (collapsedAgents) — collapsed = just the row, no topic
// list (neither compact nor expanded).
describe('Sidebar — agent collapse (chevron)', () => {
  it('the chevron collapses the row: the topic list disappears (a selected agent, with sessions)', () => {
    useStore.setState({
      agents: [makeAgent({ id: 'a1', name: 'Ana', sessions: [makeSession({ id: 's1', folder: 'f', agentId: 'a1' })] })],
      selectedAgentId: 'a1',
    })
    render(<Sidebar />)
    expect(screen.getByTestId('expanded-sessions')).toBeInTheDocument()
    fireEvent.click(screen.getByLabelText('collapse Ana'))
    expect(screen.queryByTestId('expanded-sessions')).not.toBeInTheDocument()
    fireEvent.click(screen.getByLabelText('expand Ana'))
    expect(screen.getByTestId('expanded-sessions')).toBeInTheDocument()
  })

  it('the collapse persists via api.patchPrefsCollapsedAgents (optimistic)', () => {
    const spy = vi.spyOn(api, 'patchPrefsCollapsedAgents').mockResolvedValue({})
    useStore.setState({
      agents: [makeAgent({ id: 'a1', name: 'Ana', sessions: [] })],
    })
    render(<Sidebar />)
    fireEvent.click(screen.getByLabelText('collapse Ana'))
    expect(useStore.getState().collapsedAgents).toEqual(['a1'])
    expect(spy).toHaveBeenCalledWith(['a1'])

    fireEvent.click(screen.getByLabelText('expand Ana'))
    expect(useStore.getState().collapsedAgents).toEqual([])
    expect(spy).toHaveBeenCalledWith([])
  })

  it('an already-collapsed agent (prefs loaded beforehand) starts with no topic list', () => {
    useStore.setState({
      agents: [makeAgent({ id: 'a1', name: 'Ana', sessions: [makeSession({ id: 's1', folder: 'f', agentId: 'a1' })] })],
      selectedAgentId: 'a1',
      collapsedAgents: ['a1'],
    })
    render(<Sidebar />)
    expect(screen.queryByTestId('expanded-sessions')).not.toBeInTheDocument()
  })
})

describe("Sidebar — the selected agent's expanded sessions", () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  // ids and titles prefixed per agent — two agents with sessions must never
  // share an ambiguous "Session 0" title between them (otherwise a
  // "collapsed" assertion could be looking at the OTHER agent's session).
  function makeSessions(n: number, agentId: string): SessionView[] {
    return Array.from({ length: n }, (_, i) =>
      makeSession({ id: `${agentId}-s${i}`, folder: 'f', title: `${agentId} session ${i}`, agentId, mtime: NOW - i * 1000 }),
    )
  }

  // once selected, an agent shows its 5 most recent topics DIRECTLY; the
  // rest collapse into "▸ N older" (10 sessions, all "active" within
  // INACTIVE_MS → splitRecent caps them at 5) — expanding it reveals the
  // rest without going through "Show all".
  it('selecting an agent: 5 recent topics + the rest in "▸ N older"; the other agents stay compact', () => {
    useStore.setState({
      agents: [makeAgent({ id: 'a1', name: 'Ana', sessions: makeSessions(10, 'a1') }), makeAgent({ id: 'b2', name: 'Beto', sessions: makeSessions(3, 'b2') })],
      selectedAgentId: 'a1',
    })
    render(<Sidebar />)
    // Ana (selected): the 5 most recent, mtime desc.
    expect(screen.getByText('a1 session 0')).toBeInTheDocument()
    expect(screen.getByText('a1 session 4')).toBeInTheDocument()
    expect(screen.queryByText('a1 session 5')).not.toBeInTheDocument()
    expect(screen.queryByText('a1 session 9')).not.toBeInTheDocument()
    expect(screen.getByText('5 older')).toBeInTheDocument()

    fireEvent.click(screen.getByText('5 older'))
    expect(screen.getByText('a1 session 5')).toBeInTheDocument()
    expect(screen.getByText('a1 session 9')).toBeInTheDocument()
    expect(screen.getByText('Hide older')).toBeInTheDocument()

    // Slack-style: every agent always shows its topics (compact 5 / selected 5+older)
    expect(screen.getAllByTestId('expanded-sessions').length).toBeGreaterThanOrEqual(1)

    fireEvent.click(screen.getByText('Beto'))
    expect(useStore.getState().selectedAgentId).toBe('b2')
    // once Beto is selected, Ana collapses (its sessions disappear) and
    // Beto expands (its own, with its own prefix, appear) — a single
    // expanded block still exists, but now it's Beto's.
    // Slack-style: a1 goes compact — and its "older" fold, opened above,
    // stays open: the fold belongs to the agent, not to the block that
    // happened to render it (otherwise the older ones hide again).
    expect(screen.getByText('a1 session 0')).toBeInTheDocument()
    expect(screen.getByText('a1 session 5')).toBeInTheDocument()
    expect(screen.getByText('b2 session 0')).toBeInTheDocument()
    // Slack-style: every agent always shows its topics (compact 5 / selected 8)
    expect(screen.getAllByTestId('expanded-sessions').length).toBeGreaterThanOrEqual(1)
  })

  it('"▸ N older" expands the full list, and the header search filters', () => {
    useStore.setState({
      agents: [makeAgent({ id: 'a1', name: 'Ana', sessions: makeSessions(10, 'a1') })],
      selectedAgentId: 'a1',
    })
    render(<Sidebar />)
    expect(screen.queryByText('a1 session 9')).not.toBeInTheDocument()

    fireEvent.click(screen.getByText(/older$/)) // "5 older" — the single inline expand
    expect(screen.getByText('a1 session 9')).toBeInTheDocument()

    // the header search (on demand) filters the list
    act(() => useStore.getState().setFilter('·')) // a filter in force shows its field (set from ⌘K's «Filter the list to …»)
    fireEvent.change(screen.getByLabelText('search conversations'), { target: { value: 'session 9' } })
    expect(screen.getByText('a1 session 9')).toBeInTheDocument()
    expect(screen.queryByText('a1 session 0')).not.toBeInTheDocument()
  })

  // the two filter variants restore coverage — padded past the 8 cap so that
  // "Show all" (and with it, the filter input) is available.
  it('the filter matches by skill, not just by title', () => {
    useStore.setState({
      agents: [
        makeAgent({
          id: 'a1',
          name: 'Ana',
          sessions: [
            ...makeSessions(8, 'a1'),
            makeSession({
              id: 'a1-alive',
              folder: 'f',
              title: 'Live chat',
              skills: ['frontend-design', 'testing'],
              agentId: 'a1',
              mtime: NOW - 500,
            }),
            makeSession({
              id: 'a1-external',
              folder: 'f',
              title: 'External session',
              skills: ['ops'],
              agentId: 'a1',
              mtime: NOW - 600,
            }),
          ],
        }),
      ],
      selectedAgentId: 'a1',
    })
    render(<Sidebar />)
    act(() => useStore.getState().setFilter('·')) // a filter in force shows its field (set from ⌘K's «Filter the list to …»)
    fireEvent.change(screen.getByLabelText('search conversations'), { target: { value: 'ops' } })
    expect(screen.getByText('External session')).toBeInTheDocument()
    expect(screen.queryByText('Live chat')).not.toBeInTheDocument()
  })

  it('the title filter is case-insensitive', () => {
    useStore.setState({
      agents: [
        makeAgent({
          id: 'a1',
          name: 'Ana',
          sessions: [
            ...makeSessions(8, 'a1'),
            makeSession({
              id: 'a1-alive',
              folder: 'f',
              title: 'Live chat',
              skills: [],
              agentId: 'a1',
              mtime: NOW - 500,
            }),
            makeSession({
              id: 'a1-external',
              folder: 'f',
              title: 'External session',
              skills: [],
              agentId: 'a1',
              mtime: NOW - 600,
            }),
          ],
        }),
      ],
      selectedAgentId: 'a1',
    })
    render(<Sidebar />)
    act(() => useStore.getState().setFilter('·')) // a filter in force shows its field (set from ⌘K's «Filter the list to …»)
    fireEvent.change(screen.getByLabelText('search conversations'), { target: { value: 'LIVE' } })
    expect(screen.getByText('Live chat')).toBeInTheDocument()
    expect(screen.queryByText('External session')).not.toBeInTheDocument()
  })

  it('clicking a session row opens the session (same action as openSession / api.sessionDetail)', async () => {
    const spy = vi.spyOn(api, 'sessionDetail').mockResolvedValue({ meta: makeSession({ id: 'a1-s0', folder: 'f' }), turns: [], total: 0 })
    useStore.setState({
      agents: [makeAgent({ id: 'a1', name: 'Ana', sessions: makeSessions(2, 'a1') })],
      selectedAgentId: 'a1',
    })
    render(<Sidebar />)
    fireEvent.click(screen.getByText('a1 session 0'))
    await waitFor(() => expect(useStore.getState().selected).toEqual({ folder: 'f', id: 'a1-s0' }))
    expect(spy).toHaveBeenCalledWith('f', 'a1-s0')
  })

  it('renaming inline from the topic ⋯ menu triggers api.rename', () => {
    const spy = vi.spyOn(api, 'rename').mockResolvedValue(undefined)
    useStore.setState({
      agents: [makeAgent({ id: 'a1', name: 'Ana', sessions: [makeSession({ id: 's1', folder: 'f', title: 'Chat', agentId: 'a1' })] })],
      selectedAgentId: 'a1',
    })
    render(<Sidebar />)
    openTopicMenu()
    fireEvent.click(screen.getByLabelText('rename session'))
    const input = screen.getByDisplayValue('Chat')
    fireEvent.change(input, { target: { value: 'New title' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(spy).toHaveBeenCalledWith('f', 's1', 'New title')
    expect(screen.getByText('New title')).toBeInTheDocument()
  })

  it('renaming cancels with Escape without calling the api', () => {
    const spy = vi.spyOn(api, 'rename').mockResolvedValue(undefined)
    useStore.setState({
      agents: [makeAgent({ id: 'a1', name: 'Ana', sessions: [makeSession({ id: 's1', folder: 'f', title: 'Chat', agentId: 'a1' })] })],
      selectedAgentId: 'a1',
    })
    render(<Sidebar />)
    openTopicMenu()
    fireEvent.click(screen.getByLabelText('rename session'))
    const input = screen.getByDisplayValue('Chat')
    fireEvent.change(input, { target: { value: 'Something else' } })
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(spy).not.toHaveBeenCalled()
    expect(screen.getByText('Chat')).toBeInTheDocument()
  })

  it('deleting from the ⋯ menu requires a double click: the first asks for confirmation, the second calls api.trash', () => {
    const spy = vi.spyOn(api, 'trash').mockResolvedValue(undefined)
    useStore.setState({
      agents: [makeAgent({ id: 'a1', name: 'Ana', sessions: [makeSession({ id: 's1', folder: 'f', agentId: 'a1' })] })],
      selectedAgentId: 'a1',
    })
    render(<Sidebar />)
    openTopicMenu()
    fireEvent.click(screen.getByLabelText('delete session'))
    expect(spy).not.toHaveBeenCalled()
    expect(screen.getByText('sure? delete')).toBeInTheDocument()
    fireEvent.click(screen.getByLabelText('sure? confirm delete'))
    // a row is a thread: Delete buries the tip AND the history folded under
    // it (rotations, what a /clear left archived) — otherwise each ancestor
    // surfaced as a "new" conversation the moment the tip was gone
    expect(spy).toHaveBeenCalledWith('f', 's1', { thread: true })
  })

  // trashing can legitimately take ~20 s server-side (it waits for the
  // console's claude to really exit before moving the file) — without a
  // visible in-flight state the row just sits there and the owner reads
  // it as "delete didn't work" and retries.
  it('while the trash request is in flight the row says deleting…; a failure clears it and surfaces the error', async () => {
    let reject!: (e: Error) => void
    vi.spyOn(api, 'trash').mockImplementation(
      () =>
        new Promise<undefined>((_res, rej) => {
          reject = rej
        }),
    )
    useStore.setState({
      agents: [makeAgent({ id: 'a1', name: 'Ana', sessions: [makeSession({ id: 's1', folder: 'f', agentId: 'a1' })] })],
      selectedAgentId: 'a1',
    })
    render(<Sidebar />)
    openTopicMenu()
    fireEvent.click(screen.getByLabelText('delete session'))
    fireEvent.click(screen.getByLabelText('sure? confirm delete'))
    expect(screen.getByText('deleting…')).toBeInTheDocument()
    act(() => reject(new Error('a turn is in progress')))
    await waitFor(() => expect(screen.queryByText('deleting…')).not.toBeInTheDocument())
    expect(useStore.getState().error).toBe('a turn is in progress')
  })

  // «Also stop»: explicit, OFF by default, never automatic
  describe('delete when the conversation left processes running', () => {
    const proc = (over: Record<string, unknown> = {}) => ({
      id: '21-210',
      key: 'platform/21-210',
      state: 'left',
      stateLabel: 'left running',
      command: 'node /srv/app/node_modules/.bin/vite --port 5193',
      startedAt: '2026-11-20T08:00:00.000Z',
      origin: 'conversation',
      stoppable: true,
      ports: '5193',
      ...over,
    })
    function setup(processes: ReturnType<typeof proc>[]) {
      vi.spyOn(api, 'processes').mockResolvedValue(processes as never)
      const trash = vi.spyOn(api, 'trash').mockResolvedValue(undefined)
      useStore.setState({
        agents: [makeAgent({ id: 'a1', name: 'Ana', sessions: [makeSession({ id: 's1', folder: 'f', agentId: 'a1' })] })],
        selectedAgentId: 'a1',
      })
      render(<Sidebar />)
      openTopicMenu()
      fireEvent.click(screen.getByLabelText('delete session'))
      return trash
    }

    it('names them, the stop box unchecked — Delete sends no stopProcesses', async () => {
      const trash = setup([proc(), proc({ id: '33-330', key: 'platform/33-330', command: 'python3 -m http.server 4391', ports: '4391' })])
      const panel = await screen.findByTestId('delete-processes')
      expect(panel.textContent).toContain('vite :5193')
      expect(panel.textContent).toContain('http.server :4391')
      expect(screen.getByRole('checkbox', { name: /Also stop them/ })).not.toBeChecked()
      fireEvent.click(screen.getByLabelText('sure? confirm delete'))
      expect(trash).toHaveBeenCalledWith('f', 's1', { thread: true })
    })

    it('ticked, Delete asks the server to stop them too', async () => {
      const trash = setup([proc()])
      fireEvent.click(await screen.findByRole('checkbox', { name: /Also stop it/ }))
      fireEvent.click(screen.getByLabelText('sure? confirm delete'))
      expect(trash).toHaveBeenCalledWith('f', 's1', { thread: true, stopProcesses: true })
    })

    it('none Silos may stop: named, nothing offered, nothing asked', async () => {
      const trash = setup([proc({ stoppable: false, origin: 'other-user' })])
      await screen.findByTestId('delete-processes')
      expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
      fireEvent.click(screen.getByLabelText('sure? confirm delete'))
      expect(trash).toHaveBeenCalledWith('f', 's1', { thread: true })
    })

    it('what the server stopped is said, quietly; what it could not, as a problem', async () => {
      setup([proc()])
      vi.mocked(api.trash).mockResolvedValueOnce({
        ok: true,
        processes: {
          stopped: [{ id: '21-210', key: 'platform/21-210', command: 'vite', outcome: 'stopped', says: 'Stopped vite.' }],
          notStopped: [],
          says: 'stopped 1 process',
        },
      })
      fireEvent.click(await screen.findByRole('checkbox', { name: /Also stop it/ }))
      fireEvent.click(screen.getByLabelText('sure? confirm delete'))
      await waitFor(() => expect(useStore.getState().error).toBe('Deleted «Session» — stopped 1 process.'))
      expect(useStore.getState().reportOnly).toBe('Deleted «Session» — stopped 1 process.')
    })

    it("with none, the confirmation is exactly today's", async () => {
      const trash = setup([])
      await waitFor(() => expect(api.processes).toHaveBeenCalledWith('f', 's1'))
      expect(screen.queryByTestId('delete-processes')).not.toBeInTheDocument()
      fireEvent.click(screen.getByLabelText('sure? confirm delete'))
      expect(trash).toHaveBeenCalledWith('f', 's1', { thread: true })
    })
  })

  it('no "terminal" badge on non-native sessions anymore', () => {
    useStore.setState({
      agents: [
        makeAgent({
          id: 'a1',
          name: 'Ana',
          sessions: [makeSession({ id: 's1', folder: 'f', native: true, agentId: 'a1' }), makeSession({ id: 's2', folder: 'f', native: false, agentId: 'a1' })],
        }),
      ],
      selectedAgentId: 'a1',
    })
    render(<Sidebar />)
    expect(screen.queryByText('terminal')).not.toBeInTheDocument()
  })

  it('the optimistic title reconciles when a different title arrives from the server', async () => {
    vi.spyOn(api, 'rename').mockResolvedValue(undefined)
    useStore.setState({
      agents: [makeAgent({ id: 'a1', name: 'Ana', sessions: [makeSession({ id: 's1', folder: 'f', title: 'Chat', agentId: 'a1' })] })],
      selectedAgentId: 'a1',
    })
    render(<Sidebar />)
    openTopicMenu()
    fireEvent.click(screen.getByLabelText('rename session'))
    fireEvent.change(screen.getByDisplayValue('Chat'), { target: { value: 'Optimistic' } })
    fireEvent.keyDown(screen.getByDisplayValue('Optimistic'), { key: 'Enter' })
    expect(screen.getByText('Optimistic')).toBeInTheDocument()

    // the server's truth arrives (another tab, another rename, truncation...) with a DIFFERENT title
    useStore.setState((s) => ({
      agents: s.agents.map((a) => (a.id === 'a1' ? { ...a, sessions: [{ ...a.sessions[0]!, title: 'Server title' }] } : a)),
    }))

    await waitFor(() => expect(screen.getByText('Server title')).toBeInTheDocument())
    expect(screen.queryByText('Optimistic')).not.toBeInTheDocument()
  })

  it('if api.rename fails, it reverts the optimistic title and stores the error', async () => {
    vi.spyOn(api, 'rename').mockRejectedValueOnce(new Error('network failure'))
    useStore.setState({
      agents: [makeAgent({ id: 'a1', name: 'Ana', sessions: [makeSession({ id: 's1', folder: 'f', title: 'Chat', agentId: 'a1' })] })],
      selectedAgentId: 'a1',
    })
    render(<Sidebar />)
    openTopicMenu()
    fireEvent.click(screen.getByLabelText('rename session'))
    fireEvent.change(screen.getByDisplayValue('Chat'), { target: { value: 'Optimistic' } })
    fireEvent.keyDown(screen.getByDisplayValue('Optimistic'), { key: 'Enter' })
    expect(screen.getByText('Optimistic')).toBeInTheDocument()

    await waitFor(() => expect(screen.getByText('Chat')).toBeInTheDocument())
    expect(useStore.getState().error).toBe('network failure')
  })

  it('if api.trash fails, it stores the error', async () => {
    vi.spyOn(api, 'trash').mockRejectedValueOnce(new Error('could not delete'))
    useStore.setState({
      agents: [makeAgent({ id: 'a1', name: 'Ana', sessions: [makeSession({ id: 's1', folder: 'f', agentId: 'a1' })] })],
      selectedAgentId: 'a1',
    })
    render(<Sidebar />)
    openTopicMenu()
    fireEvent.click(screen.getByLabelText('delete session'))
    fireEvent.click(screen.getByLabelText('sure? confirm delete'))
    await waitFor(() => expect(useStore.getState().error).toBe('could not delete'))
  })

  // the expanded block's header (which showed the full path as text) is
  // removed entirely — the path is still accessible, but now ONLY as a
  // tooltip (`title`) on the agent row, not as visible text.
  it('the full folder path is no longer shown as text, but stays in the agent row tooltip', () => {
    useStore.setState({
      agents: [makeAgent({ id: 'a1', name: 'Ana', folder: '/home/user/projects/ana' })],
      selectedAgentId: 'a1',
    })
    render(<Sidebar />)
    expect(screen.queryByText('/home/user/projects/ana')).not.toBeInTheDocument()
    expect(screen.getByText('Ana').closest('button')).toHaveAttribute('title', '/home/user/projects/ana')
  })

  // with per-folder headers (>1 group), showFolder is false and the
  // collapsed row doesn't render the basename under the name — the tooltip
  // is the ONLY way to recover the full path there, so it must stay present
  // always, not just when showFolder was already showing it as text.
  it('with per-folder headers (showFolder=false), the agent row still carries the full path in the tooltip', () => {
    useStore.setState({
      agents: [makeAgent({ id: 'a1', name: 'Ana', folder: '/a/one' }), makeAgent({ id: 'a2', name: 'Beto', folder: '/b/two' })],
    })
    render(<Sidebar />)
    expect(screen.getByText('Ana').closest('button')).toHaveAttribute('title', '/a/one')
    expect(screen.getByText('Beto').closest('button')).toHaveAttribute('title', '/b/two')
  })

  it('master (no folder) shows no path line at all in the expanded block', () => {
    useStore.setState({
      agents: [makeAgent({ id: 'master', name: 'Master', folder: null })],
      selectedAgentId: 'master',
    })
    render(<Sidebar />)
    expect(screen.queryByTitle(/\//)).not.toBeInTheDocument()
  })

  // the pencil becomes a ⋯ menu (New conversation · View agent · Edit ·
  // Archive). "Edit" still navigates to AgentPage on its Settings tab, same
  // as the pencil did.
  it('the agent row\'s ⋯ menu: "Edit" navigates to AgentPage on Identity for that agent', () => {
    useStore.setState({
      agents: [makeAgent({ id: 'a1', name: 'Ana' })],
      selectedAgentId: 'a1',
    })
    render(<Sidebar />)
    fireEvent.click(screen.getByLabelText('agent options'))
    fireEvent.click(screen.getByText('Edit'))
    expect(useStore.getState().page).toEqual({ kind: 'agent', id: 'a1' })
    expect(useStore.getState().tab).toBe('identity')
  })

  it('the ⋯ menu: "View agent" navigates to the dossier without opening any facet', () => {
    useStore.setState({
      agents: [makeAgent({ id: 'a1', name: 'Ana' })],
      selectedAgentId: 'a1',
    })
    render(<Sidebar />)
    fireEvent.click(screen.getByLabelText('agent options'))
    fireEvent.click(screen.getByText('View agent'))
    expect(useStore.getState().page).toEqual({ kind: 'agent', id: 'a1' })
    expect(useStore.getState().selected).toBeNull()
    expect(useStore.getState().newChatOpen).toBe(false)
  })

  it('the ⋯ menu: "New conversation" selects the agent and starts a new chat', () => {
    useStore.setState({
      agents: [makeAgent({ id: 'a1', name: 'Ana' })],
      selectedAgentId: 'b2',
    })
    render(<Sidebar />)
    const anaRow = screen.getByText('Ana').closest('button')!.parentElement!
    fireEvent.click(within(anaRow).getByLabelText('agent options'))
    fireEvent.click(screen.getByText('New conversation'))
    expect(useStore.getState().selectedAgentId).toBe('a1')
    expect(useStore.getState().newChatOpen).toBe(true)
    expect(useStore.getState().selected).toBeNull()
  })

  it('the ⋯ menu: "Archive" asks for confirmation with a double click', async () => {
    const spy = vi.spyOn(api.agents, 'archive').mockResolvedValue(undefined)
    // archiving triggers loadOverview() after resolving — without this stub,
    // the real fetch blows up in jsdom (unhandled rejection, noise in the run).
    vi.spyOn(api, 'overview').mockResolvedValue({ agents: [], now: 0, warming: false })
    useStore.setState({
      agents: [makeAgent({ id: 'a1', name: 'Ana' })],
      selectedAgentId: 'a1',
    })
    render(<Sidebar />)
    fireEvent.click(screen.getByLabelText('agent options'))
    fireEvent.click(screen.getByText('Archive'))
    expect(spy).not.toHaveBeenCalled()
    fireEvent.click(screen.getByText(/sure/i))
    await waitFor(() => expect(spy).toHaveBeenCalledWith('a1'))
  })

  // same hover/focus pattern as SessionRow's actions (rename/delete) —
  // invisible by default (opacity-0), revealed by the row container's
  // group-hover/group-focus-within.
  it('the ⋯ menu trigger follows the same hover/focus pattern as the session actions', () => {
    useStore.setState({
      agents: [makeAgent({ id: 'a1', name: 'Ana' })],
      selectedAgentId: 'a1',
    })
    render(<Sidebar />)
    const trigger = screen.getByLabelText('agent options')
    expect(trigger.className).toContain('opacity-0')
    expect(trigger.className).toContain('group-hover:opacity-100')
    expect(trigger.className).toContain('group-focus-within:opacity-100')
  })

  // The inbox is a CATEGORY, not an agent: it carries no agent ⋯ menu and
  // no name row — only its loose sessions hang under the "Unassigned" label.
  it('the inbox exposes no agent ⋯ menu (it is a section, not an agent)', () => {
    useStore.setState({
      agents: [makeAgent({ id: 'master', name: 'Master', folder: null, sessions: [makeSession({ id: 'm1', title: 'Loose', agentId: 'master' })] })],
    })
    render(<Sidebar />)
    expect(screen.getByText('Unassigned')).toBeInTheDocument()
    // the agent ⋯ trigger only belongs to real agent rows — none here.
    expect(screen.queryByLabelText('agent options')).not.toBeInTheDocument()
  })

  it('"New conversation" clears the open session and navigates to chat', () => {
    useStore.setState({
      agents: [makeAgent({ id: 'a1', name: 'Ana', sessions: [makeSession({ id: 's1', folder: 'f', agentId: 'a1' })] })],
      selectedAgentId: 'a1',
      selected: { folder: 'f', id: 's1' },
      detail: { meta: makeSession({ id: 's1', folder: 'f' }), turns: [], total: 0 },
      mobileView: 'list',
    })
    render(<Sidebar />)
    // "New conversation" is an INLINE button on the agent row (not a ghost
    // row). aria-label = "new conversation with <name>".
    fireEvent.click(screen.getByLabelText('new conversation with Ana'))
    expect(useStore.getState().selected).toBeNull()
    expect(useStore.getState().detail).toBeNull()
    expect(useStore.getState().mobileView).toBe('chat')
  })

  // the "+ New conversation" ghost row became an INLINE button on the agent
  // row -- one click, no menu to open.
  it('the agent row inline + button starts a new chat for THAT agent', () => {
    useStore.setState({
      agents: [makeAgent({ id: 'a1', name: 'Ana', sessions: makeSessions(3, 'a1') })],
      selectedAgentId: null,
    })
    render(<Sidebar />)
    fireEvent.click(screen.getByLabelText('new conversation with Ana'))
    expect(useStore.getState().selectedAgentId).toBe('a1')
    expect(useStore.getState().newChatOpen).toBe(true)
  })

  // the prefix went from a dash (-) to `#` -- row decoration (text-ink-2),
  // NOT part of the data: the rename input still shows the raw title,
  // without it.
  describe('header+sidebar redesign -- a mute # before the session title', () => {
    it('the title renders alone in the list, no # prefix', () => {
      useStore.setState({
        agents: [makeAgent({ id: 'a1', name: 'Ana', sessions: [makeSession({ id: 's1', folder: 'f', title: 'Chat', agentId: 'a1' })] })],
        selectedAgentId: 'a1',
      })
      render(<Sidebar />)
      // the exact title can still be found without the prefix (it lives in
      // its own node) -- and the # exists in the row as separate decoration.
      const title = screen.getByText('Chat')
      expect(title).toBeInTheDocument()
      const row = title.closest('li')
      expect(row).not.toBeNull()
      expect(row?.textContent).not.toContain('#') // the # prefix is gone
    })

    it('renaming still operates on the raw title, without the #', () => {
      const spy = vi.spyOn(api, 'rename').mockResolvedValue(undefined)
      useStore.setState({
        agents: [makeAgent({ id: 'a1', name: 'Ana', sessions: [makeSession({ id: 's1', folder: 'f', title: 'Chat', agentId: 'a1' })] })],
        selectedAgentId: 'a1',
      })
      render(<Sidebar />)
      openTopicMenu()
      fireEvent.click(screen.getByLabelText('rename session'))
      // the rename input starts with the EXACT title, without the decorative
      // dash -- if the dash had leaked into the data, this value wouldn't match.
      const input = screen.getByDisplayValue('Chat')
      fireEvent.change(input, { target: { value: 'New title' } })
      fireEvent.keyDown(input, { key: 'Enter' })
      expect(spy).toHaveBeenCalledWith('f', 's1', 'New title')
    })
  })

  // the icon rail has no room for a list with text, so the expanded block
  // floats as an overlay ONLY at the md breakpoint, and flows back inline
  // at lg (static) where the sidebar already has full width -- checked by
  // class, since jsdom doesn't evaluate @media. position:fixed, not
  // absolute: <nav> has overflow-y-auto, and the CSS rule that pairs
  // overflow axes (if one isn't 'visible', the other is forced to 'auto')
  // clips any absolute descendant that overflows horizontally -- confirmed
  // with a real screenshot at the md breakpoint before this fix (the block
  // wasn't visible, even though its computed geometry said otherwise).
  // fixed escapes the clipping of any ancestor with overflow.
  it('the expanded block uses a fixed overlay on the md rail and inline at lg (responsive classes)', () => {
    useStore.setState({
      agents: [makeAgent({ id: 'a1', name: 'Ana', sessions: [makeSession({ id: 's1', folder: 'f', agentId: 'a1' })] })],
      selectedAgentId: 'a1',
    })
    render(<Sidebar />)
    const block = screen.getByTestId('expanded-sessions')
    expect(block.className).toContain('md:max-lg:fixed')
    expect(block.className).not.toContain('lg:static')
  })

  // without a close affordance, the md rail's overlay (position:fixed,
  // opaque) covered ~288px of chat PERMANENTLY -- selectedAgentId almost
  // never goes back to null in normal use. jsdom doesn't evaluate @media,
  // so "md" is checked by CLASS (md:hidden/lg:block present or not), same
  // as the rest of this file -- not by real viewport.
  describe('md -- closing and reopening the rail overlay', () => {
    it('opening a session from the overlay closes it on md (md:hidden appears, lg:block restores it) without touching md:fixed/lg:static', async () => {
      const spy = vi.spyOn(api, 'sessionDetail').mockResolvedValue({ meta: makeSession({ id: 'a1-s0', folder: 'f' }), turns: [], total: 0 })
      useStore.setState({
        agents: [makeAgent({ id: 'a1', name: 'Ana', sessions: makeSessions(2, 'a1') })],
        selectedAgentId: 'a1',
      })
      render(<Sidebar />)
      // at load the overlay is closed on md; the agent's row opens it
      expect(screen.getByTestId('expanded-sessions').className).toContain('md:max-lg:hidden')
      fireEvent.click(screen.getByText('Ana'))
      const before = screen.getByTestId('expanded-sessions')
      expect(before.className).not.toContain('md:max-lg:hidden')
      // lg+ (current behavior, untouched): these classes stay put.
      expect(before.className).toContain('md:max-lg:fixed')
      expect(before.className).not.toContain('lg:static')

      fireEvent.click(screen.getByText('a1 session 0'))
      await waitFor(() => expect(useStore.getState().selected).toEqual({ folder: 'f', id: 'a1-s0' }))
      expect(spy).toHaveBeenCalledWith('f', 'a1-s0')

      const after = screen.getByTestId('expanded-sessions')
      expect(after.className).toContain('md:max-lg:hidden')
      expect(after.className).toContain('md:max-lg:hidden')
      // lg+ stays intact after closing on md -- the flag is inert there.
      expect(after.className).toContain('md:max-lg:fixed')
      expect(after.className).not.toContain('lg:static')
    })

    it('the close button exists, is a native <button> (keyboard-operable), and hides the overlay on md', () => {
      useStore.setState({
        agents: [makeAgent({ id: 'a1', name: 'Ana', sessions: [makeSession({ id: 's1', folder: 'f', agentId: 'a1' })] })],
        selectedAgentId: 'a1',
      })
      render(<Sidebar />)
      fireEvent.click(screen.getByText('Ana'))
      const closeBtn = screen.getByLabelText('Close sessions panel')
      expect(closeBtn.tagName).toBe('BUTTON')
      // only visible at the md breakpoint -- below md/at lg the panel is
      // inline and always visible while the agent is selected.
      expect(closeBtn).toHaveClass('md:inline-flex')
      expect(closeBtn).toHaveClass('lg:hidden')

      expect(screen.getByTestId('expanded-sessions').className).not.toContain('md:max-lg:hidden')
      fireEvent.click(closeBtn)
      expect(screen.getByTestId('expanded-sessions').className).toContain('md:max-lg:hidden')
    })

    // clicking the already-selected agent row again reopens the overlay.
    it('clicking the already-selected agent row again reopens the overlay after closing it', () => {
      useStore.setState({
        agents: [makeAgent({ id: 'a1', name: 'Ana', sessions: [makeSession({ id: 's1', folder: 'f', agentId: 'a1' })] })],
        selectedAgentId: 'a1',
      })
      render(<Sidebar />)
      fireEvent.click(screen.getByLabelText('Close sessions panel'))
      expect(screen.getByTestId('expanded-sessions').className).toContain('md:max-lg:hidden')

      fireEvent.click(screen.getByText('Ana'))
      expect(useStore.getState().selectedAgentId).toBe('a1')
      expect(screen.getByTestId('expanded-sessions').className).not.toContain('md:max-lg:hidden')
    })
  })
})

// chains: sessions born from one another (a fork of "Continue in Silos" or
// the rotation of a keep thread) are grouped in the sidebar as ONE topic —
// the head (most recent) visible, with a "⌄ N earlier" affix that expands
// the indented ancestors. See groupChains (lib/grouping.ts) for the pure
// grouping logic — this only tests the component wiring.
describe('Sidebar — chains (chained sessions)', () => {
  function makeSessions(n: number, agentId: string): SessionView[] {
    return Array.from({ length: n }, (_, i) =>
      makeSession({ id: `${agentId}-s${i}`, folder: 'f', title: `${agentId} session ${i}`, agentId, mtime: NOW - i * 1000 }),
    )
  }

  it('a chain is ONE row — its tip — and that row is active while any of its sessions is open', () => {
    useStore.setState({
      agents: [
        makeAgent({
          id: 'a1',
          name: 'Ana',
          sessions: [
            makeSession({ id: 'old-root', folder: 'f', title: 'Original thread', agentId: 'a1', mtime: NOW - 20_000 }),
            makeSession({ id: 'middle', folder: 'f', title: 'Rotated thread', agentId: 'a1', mtime: NOW - 10_000, parentKey: 'f/old-root' }),
            makeSession({ id: 'new-tip', folder: 'f', title: 'Current thread', agentId: 'a1', mtime: NOW, parentKey: 'f/middle' }),
          ],
        }),
      ],
      selectedAgentId: 'a1',
      selected: { folder: 'f', id: 'old-root' }, // reading where it continued from
      page: { kind: 'agent', id: 'a1' },
    })
    render(<Sidebar />)
    expect(screen.getByText('Current thread')).toBeInTheDocument()
    expect(screen.queryByText('Rotated thread')).not.toBeInTheDocument()
    expect(screen.queryByText('Original thread')).not.toBeInTheDocument()
    expect(screen.queryByText(/earlier/)).not.toBeInTheDocument()
    expect(screen.getAllByTestId('session-row')[0]!.querySelector('[aria-current="true"]')).not.toBeNull()
  })

  function makeForkChains(n: number): SessionView[] {
    // n chains of 2 sessions each (simple fork: origin + fork)
    const sessions: SessionView[] = []
    for (let i = 0; i < n; i++) {
      sessions.push(makeSession({ id: `orig-${i}`, folder: 'f', title: `original ${i}`, agentId: 'a1', mtime: NOW - i * 10_000 - 5000 }))
      sessions.push(makeSession({ id: `fork-${i}`, folder: 'f', title: `fork ${i}`, agentId: 'a1', mtime: NOW - i * 10_000, parentKey: `f/orig-${i}` }))
    }
    return sessions
  }

  // 8 chains — splitRecent caps the recent ones at 5, the other 3 fold into
  // "▸ 3 older" — expanding it reveals all 8 without going through "Show
  // all" (total=8 doesn't trip that threshold).
  it('8 chains (16 sessions): 5 recent + "▸ 3 older" — all reachable without "Show all"', () => {
    useStore.setState({
      agents: [makeAgent({ id: 'a1', name: 'Ana', sessions: makeForkChains(8) })],
      selectedAgentId: 'a1',
    })
    render(<Sidebar />)
    for (let i = 0; i < 5; i++) expect(screen.getByText(`fork ${i}`)).toBeInTheDocument()
    for (let i = 5; i < 8; i++) expect(screen.queryByText(`fork ${i}`)).not.toBeInTheDocument()
    expect(screen.getByText('3 older')).toBeInTheDocument()
    expect(screen.queryByText(/^Show all/)).not.toBeInTheDocument()

    fireEvent.click(screen.getByText('3 older'))
    for (let i = 0; i < 8; i++) expect(screen.getByText(`fork ${i}`)).toBeInTheDocument()
    expect(screen.queryByText(/^Show all/)).not.toBeInTheDocument()
  })

  it('the 9th chain collapses into "▸ N older" — counting chains, not the 18 sessions in total', () => {
    const sessions = [...makeForkChains(8), makeSession({ id: 'loose', folder: 'f', title: 'ninth', agentId: 'a1', mtime: NOW + 1 })]
    useStore.setState({
      agents: [makeAgent({ id: 'a1', name: 'Ana', sessions })],
      selectedAgentId: 'a1',
    })
    render(<Sidebar />)
    // 9 chains → 5 recent + "4 older" (a chain count, never the 18 sessions).
    expect(screen.getByText(/older$/)).toBeInTheDocument()
    expect(screen.queryByText(/18 older/)).not.toBeInTheDocument()
  })

  it('a filter that only matches an earlier session still finds the conversation (its row)', () => {
    useStore.setState({
      agents: [
        makeAgent({
          id: 'a1',
          name: 'Ana',
          sessions: [
            ...makeSessions(8, 'a1'), // pads past the recent cap so the older ones need the filter to surface
            makeSession({ id: 'origin', folder: 'f', title: 'Migration to Postgres', agentId: 'a1', mtime: NOW - 9000 }),
            makeSession({
              id: 'branch',
              folder: 'f',
              title: 'New unrelated chat',
              agentId: 'a1',
              mtime: NOW - 8000,
              parentKey: 'f/origin',
            }),
          ],
        }),
      ],
      selectedAgentId: 'a1',
    })
    render(<Sidebar />)
    act(() => useStore.getState().setFilter('·')) // a filter in force shows its field (set from ⌘K's «Filter the list to …»)
    fireEvent.change(screen.getByLabelText('search conversations'), { target: { value: 'postgres' } })
    // the match is on the earlier session ('origin'), not on the tip
    // ('branch') — the conversation still appears, as its one row
    expect(screen.getByText('New unrelated chat')).toBeInTheDocument()
    expect(screen.queryByText('Migration to Postgres')).not.toBeInTheDocument()
  })
})

// clickable project name (group header) → ProjectPage; hovering "+ agent"
// → a creation modal with the folder pre-filled.
describe('Sidebar — navigable group header', () => {
  it('clicking the project name navigates to page={project,folder} without collapsing/expanding', () => {
    useStore.setState({
      agents: [makeAgent({ id: 'a1', name: 'Ana', folder: '/a/one' }), makeAgent({ id: 'a2', name: 'Beto', folder: '/b/two' })],
    })
    render(<Sidebar />)
    fireEvent.click(within(headerFor('one')).getByLabelText('open project one'))
    expect(useStore.getState().page).toEqual({ kind: 'project', folder: '/a/one' })
    // the other group stays expanded — clicking the name didn't collapse anything.
    expect(screen.getByText('Beto')).toBeInTheDocument()
  })

  // the header's "+ agent" and "memory" buttons were retired: clicking the
  // project name goes to its PAGE, which already does all that.
  it('the header no longer offers "+ agent" or "memory" (they live on the project page)', () => {
    useStore.setState({
      agents: [makeAgent({ id: 'a1', name: 'Ana', folder: '/a/one' }), makeAgent({ id: 'a2', name: 'Beto', folder: '/b/two' })],
    })
    render(<Sidebar />)
    const header = headerFor('one')
    expect(within(header).queryByLabelText('add agent to one')).toBeNull()
    expect(within(header).queryByLabelText('memory for one')).toBeNull()
  })

  // the group name is a project — the tooltip types it
  it('a project group says its type and path on hover', () => {
    useStore.setState({ agents: [makeAgent({ id: 'a1', name: 'Ana', folder: '/home/user/silos' }), makeAgent({ id: 'a2', name: 'Beto', folder: '/b/two' })] })
    render(<Sidebar />)
    expect(headerFor('silos')).toHaveAttribute('title', 'Project · silos — /home/user/silos')
  })
})

// project menu: order by activity (covered in grouping.test.ts, pure
// function), demote to "Inactive", drag-to-pin, persisted collapse, and
// the master agent untouchable by any of the above.
describe('Sidebar — the projects menu', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('projects bag (manual)', () => {
    it('a project put in by hand (inPool) falls into the bag: not listed, just the counter', () => {
      useStore.setState({
        agents: [
          makeAgent({ id: 'a1', name: 'Ana', folder: '/a/one', sessions: [makeSession({ id: 's1', folder: 'f1', mtime: NOW })] }),
          makeAgent({ id: 'b2', name: 'Beto', folder: '/b/two', sessions: [makeSession({ id: 's2', folder: 'f2', mtime: NOW - 200_000 })] }),
        ],
        projectsPrefs: { inPool: ['/b/two'] },
      })
      render(<Sidebar />)
      // Ana (outside) is seen directly; Beto (put in by hand) falls into the bag.
      expect(screen.getByText('Ana')).toBeInTheDocument()
      expect(screen.queryByText('Beto')).not.toBeInTheDocument()
      expect(screen.getByLabelText('projects bag, 1 inside')).toBeInTheDocument()
    })

    it('a project NOT put in by hand never falls into the bag, no matter how old its activity is (manual bag)', () => {
      useStore.setState({
        agents: [
          makeAgent({ id: 'a1', name: 'Ana', folder: '/a/one', sessions: [makeSession({ id: 's1', folder: 'f1', mtime: NOW })] }),
          makeAgent({ id: 'b2', name: 'Beto', folder: '/b/two', sessions: [makeSession({ id: 's2', folder: 'f2', mtime: 0 })] }),
        ],
      })
      render(<Sidebar />)
      expect(screen.getByText('Ana')).toBeInTheDocument()
      expect(screen.getByText('Beto')).toBeInTheDocument()
      expect(screen.queryByLabelText(/projects bag/)).not.toBeInTheDocument()
    })

    it('opening the bag shows a card per project; clicking one brings it back (leaves inPool)', () => {
      useStore.setState({
        agents: [
          makeAgent({ id: 'a1', name: 'Ana', folder: '/a/one', sessions: [makeSession({ id: 's1', folder: 'f1', mtime: NOW })] }),
          // non-live (old mtime) so inPool has an effect: a live one never falls in
          makeAgent({ id: 'b2', name: 'Beto', folder: '/b/two', sessions: [makeSession({ id: 's2', folder: 'f2', mtime: NOW - 200_000 })] }),
        ],
        projectsPrefs: { inPool: ['/b/two'] },
      })
      render(<Sidebar />)
      fireEvent.click(screen.getByLabelText('projects bag, 1 inside'))
      const card = screen.getByText('two')
      expect(card.closest('button')).toHaveAttribute('draggable', 'true')
      expect(screen.queryByText('Beto')).not.toBeInTheDocument()
      // clicking the card = bring it back → leaves inPool
      fireEvent.click(card)
      expect(useStore.getState().projectsPrefs.inPool ?? []).not.toContain('/b/two')
    })

    it('a project with a live session is never demoted, even if the rest of its activity is old', () => {
      useStore.setState({
        agents: [
          makeAgent({
            id: 'b2',
            name: 'Beto',
            folder: '/b/two',
            sessions: [makeSession({ id: 's2', folder: 'f2', mtime: NOW })], // live: mtime === nowTick
          }),
          makeAgent({ id: 'a1', name: 'Ana', folder: '/a/one', sessions: [makeSession({ id: 's1', folder: 'f1', mtime: NOW - 1 })] }),
        ],
      })
      render(<Sidebar />)
      expect(screen.getByText('Beto')).toBeInTheDocument()
      expect(screen.queryByLabelText(/projects bag/)).not.toBeInTheDocument()
    })

    it('a pinned project is never demoted even without recent activity', () => {
      useStore.setState({
        agents: [
          makeAgent({ id: 'a1', name: 'Ana', folder: '/a/one', sessions: [makeSession({ id: 's1', folder: 'f1', mtime: NOW })] }),
          makeAgent({
            id: 'b2',
            name: 'Beto',
            folder: '/b/two',
            sessions: [makeSession({ id: 's2', folder: 'f2', mtime: NOW - INACTIVE_MS - 1 })],
          }),
        ],
        projectsPrefs: { pinned: ['/b/two'] },
      })
      render(<Sidebar />)
      expect(screen.getByText('Beto')).toBeInTheDocument()
      expect(screen.queryByLabelText(/projects bag/)).not.toBeInTheDocument()
    })
  })

  describe('per-project collapse, persisted', () => {
    it('collapsing a group header hides its agents and calls PATCH /api/prefs', async () => {
      const spy = vi.spyOn(api, 'patchPrefsProjects').mockResolvedValue({})
      useStore.setState({
        agents: [makeAgent({ id: 'a1', name: 'Ana', folder: '/a/one' }), makeAgent({ id: 'a2', name: 'Coco', folder: '/b/two' })],
      })
      render(<Sidebar />)
      expect(screen.getByText('Ana')).toBeInTheDocument()

      fireEvent.click(within(headerFor('one')).getByLabelText('collapse one'))

      expect(screen.queryByText('Ana')).not.toBeInTheDocument()
      expect(screen.getByText('Coco')).toBeInTheDocument() // the other group is unaffected
      await waitFor(() => expect(spy).toHaveBeenCalledWith({ collapsed: ['/a/one'] }))
      expect(useStore.getState().projectsPrefs.collapsed).toEqual(['/a/one'])
    })

    it('memory: a project already in `collapsed` on mount starts collapsed', () => {
      useStore.setState({
        agents: [makeAgent({ id: 'a1', name: 'Ana', folder: '/a/one' }), makeAgent({ id: 'a2', name: 'Coco', folder: '/b/two' })],
        projectsPrefs: { collapsed: ['/a/one'] },
      })
      render(<Sidebar />)
      expect(screen.queryByText('Ana')).not.toBeInTheDocument()
      expect(screen.getByText('Coco')).toBeInTheDocument()
    })

    it('clicking again expands it back and persists without the key', async () => {
      const spy = vi.spyOn(api, 'patchPrefsProjects').mockResolvedValue({})
      useStore.setState({
        agents: [makeAgent({ id: 'a1', name: 'Ana', folder: '/a/one' }), makeAgent({ id: 'a2', name: 'Coco', folder: '/b/two' })],
        projectsPrefs: { collapsed: ['/a/one'] },
      })
      render(<Sidebar />)
      fireEvent.click(within(headerFor('one')).getByLabelText('expand one'))
      expect(screen.getByText('Ana')).toBeInTheDocument()
      await waitFor(() => expect(spy).toHaveBeenCalledWith({ collapsed: [] }))
    })

    it('a save failure (PATCH rejects) does not break the UI — the local collapse is kept', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      vi.spyOn(api, 'patchPrefsProjects').mockRejectedValue(new Error('offline'))
      useStore.setState({
        agents: [makeAgent({ id: 'a1', name: 'Ana', folder: '/a/one' }), makeAgent({ id: 'a2', name: 'Coco', folder: '/b/two' })],
      })
      render(<Sidebar />)
      fireEvent.click(within(headerFor('one')).getByLabelText('collapse one'))
      expect(screen.queryByText('Ana')).not.toBeInTheDocument()
      await waitFor(() => expect(warn).toHaveBeenCalled())
      // the UI stays operable: the other group, intact.
      expect(screen.getByText('Coco')).toBeInTheDocument()
    })
  })

  describe('drag-to-pin on group headers', () => {
    it('dragging a header over another pins the dragged project and persists order+pinned', async () => {
      const spy = vi.spyOn(api, 'patchPrefsProjects').mockResolvedValue({})
      useStore.setState({
        agents: [
          makeAgent({ id: 'a1', name: 'Ana', folder: '/a/one', sessions: [makeSession({ id: 's1', folder: 'f1', mtime: NOW })] }),
          makeAgent({ id: 'b2', name: 'Beto', folder: '/b/two', sessions: [makeSession({ id: 's2', folder: 'f2', mtime: NOW - 5000 })] }),
        ],
      })
      render(<Sidebar />)
      // initial order by activity: one (more recent) before two.
      const dt = new FakeDataTransfer()
      fireEvent.dragStart(headerFor('two'), { dataTransfer: dt })
      fireEvent.dragOver(headerFor('one'), { dataTransfer: dt })
      fireEvent.drop(headerFor('one'), { dataTransfer: dt })

      await waitFor(() => expect(spy).toHaveBeenCalled())
      expect(spy).toHaveBeenCalledWith({ order: ['/b/two', '/a/one'], pinned: ['/b/two'], inPool: [] })
      expect(useStore.getState().projectsPrefs.pinned).toEqual(['/b/two'])
    })

    it('a project pinned by drag goes first, beating the registry order', () => {
      useStore.setState({
        agents: [
          makeAgent({ id: 'a1', name: 'Ana', folder: '/a/one', sessions: [makeSession({ id: 's1', folder: 'f1', mtime: NOW })] }),
          makeAgent({ id: 'b2', name: 'Beto', folder: '/b/two', sessions: [makeSession({ id: 's2', folder: 'f2', mtime: NOW - 5000 })] }),
        ],
        projectsPrefs: { pinned: ['/b/two'], order: ['/b/two', '/a/one'] },
      })
      render(<Sidebar />)
      const buttons = screen.getAllByRole('button').map((b) => b.textContent ?? '')
      const idxBeto = buttons.findIndex((t) => t.includes('Beto'))
      const idxAna = buttons.findIndex((t) => t.includes('Ana'))
      expect(idxBeto).toBeGreaterThanOrEqual(0)
      expect(idxBeto).toBeLessThan(idxAna)
    })

    it('no up/down order arrows on group headers — drag is the only way to reorder', () => {
      useStore.setState({
        agents: [
          makeAgent({ id: 'a1', name: 'Ana', folder: '/a/one', sessions: [makeSession({ id: 's1', folder: 'f1', mtime: NOW })] }),
          makeAgent({ id: 'b2', name: 'Beto', folder: '/b/two', sessions: [makeSession({ id: 's2', folder: 'f2', mtime: NOW - 5000 })] }),
        ],
      })
      render(<Sidebar />)
      expect(within(headerFor('one')).queryByLabelText('move one up')).not.toBeInTheDocument()
      expect(within(headerFor('two')).queryByLabelText('move two down')).not.toBeInTheDocument()
    })

    it('projects never reorder by activity: a more recent project stays where the registry put it', () => {
      useStore.setState({
        agents: [
          makeAgent({ id: 'a1', name: 'Ana', folder: '/a/one', sessions: [makeSession({ id: 's1', folder: 'f1', mtime: NOW - 500_000 })] }),
          makeAgent({ id: 'b2', name: 'Beto', folder: '/b/two', sessions: [makeSession({ id: 's2', folder: 'f2', mtime: NOW })] }),
        ],
      })
      render(<Sidebar />)
      const buttons = screen.getAllByRole('button').map((b) => b.textContent ?? '')
      const idxAna = buttons.findIndex((t) => t.includes('Ana'))
      const idxBeto = buttons.findIndex((t) => t.includes('Beto'))
      expect(idxAna).toBeLessThan(idxBeto)
    })
  })

  describe('the master agent stays out of drag/order/collapse', () => {
    it('the inbox goes AFTER the groups and has no group header, with or without projects prefs', () => {
      useStore.setState({
        agents: [
          makeAgent({ id: 'master', name: 'Master', folder: null, sessions: [makeSession({ id: 'm1', title: 'Loose', agentId: 'master' })] }),
          makeAgent({ id: 'a1', name: 'Ana', folder: '/a/one' }),
          makeAgent({ id: 'b2', name: 'Beto', folder: '/b/two' }),
        ],
        projectsPrefs: { order: ['/b/two', '/a/one'], pinned: ['/b/two'], collapsed: ['/a/one'] },
      })
      render(<Sidebar />)
      const unassigned = screen.getByText('Unassigned')
      // the inbox goes last, after both project headers (document order).
      expect(headerFor('one').compareDocumentPosition(unassigned) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
      expect(headerFor('two').compareDocumentPosition(unassigned) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
      // the inbox has no project group header of its own (it has no folder).
      expect(headerFor('one').textContent).not.toContain('Unassigned')
      expect(headerFor('two').textContent).not.toContain('Unassigned')
    })

    it('the inbox never falls into "Inactive"/the bag, no matter how old its activity is', () => {
      useStore.setState({
        agents: [
          makeAgent({
            id: 'master',
            name: 'Master',
            folder: null,
            sessions: [makeSession({ id: 'sm', folder: 'fm', title: 'Loose', mtime: NOW - INACTIVE_MS - 1 })],
          }),
          makeAgent({ id: 'a1', name: 'Ana', folder: '/a/one' }),
        ],
      })
      render(<Sidebar />)
      expect(screen.getByText('Unassigned')).toBeInTheDocument()
      expect(screen.getByText('Loose')).toBeInTheDocument()
      expect(screen.queryByLabelText(/projects bag/)).not.toBeInTheDocument()
    })
  })
})

// search below the header — writes to the global `filter` (the same state
// that already fed "Show all"). ⌘K no longer focuses this field — it opens
// the global command palette (see command-palette.test.tsx), which
// searches over ALL agents instead of just the list visible here.
describe('Sidebar — global search', () => {
  it('the magnifier is the ⌘K door: it opens the palette, never a second search', () => {
    useStore.setState({ modal: null, filter: '' })
    render(<Sidebar />)
    expect(screen.queryByLabelText('search conversations')).not.toBeInTheDocument()
    fireEvent.click(screen.getAllByLabelText('search everything')[0]!)
    expect(useStore.getState().modal).toBe('palette')
    expect(screen.queryByLabelText('search conversations')).not.toBeInTheDocument()
  })

  it('a filter in force shows itself and clears with its ✕', () => {
    useStore.setState({ filter: 'parser' })
    render(<Sidebar />)
    expect(screen.getByLabelText('search conversations')).toHaveValue('parser')
    fireEvent.click(screen.getAllByLabelText('clear the filter')[0]!)
    expect(useStore.getState().filter).toBe('')
    expect(screen.queryByLabelText('search conversations')).not.toBeInTheDocument()
  })

  it('typing in the search box updates store.filter', () => {
    render(<Sidebar />)
    act(() => useStore.getState().setFilter('·')) // a filter in force shows its field (set from ⌘K's «Filter the list to …»)
    fireEvent.change(screen.getByLabelText('search conversations'), { target: { value: 'flaky' } })
    expect(useStore.getState().filter).toBe('flaky')
  })

  it('with text in the search box, the compact list (no agent selected) also filters, not just "Show all"', () => {
    useStore.setState({
      agents: [
        makeAgent({
          id: 'a1',
          name: 'Ana',
          sessions: [
            makeSession({ id: 's1', folder: 'f', title: 'Fix the parser', agentId: 'a1' }),
            makeSession({ id: 's2', folder: 'f', title: 'Review README', agentId: 'a1' }),
          ],
        }),
      ],
    })
    render(<Sidebar />)
    act(() => useStore.getState().setFilter('·')) // a filter in force shows its field (set from ⌘K's «Filter the list to …»)
    fireEvent.change(screen.getByLabelText('search conversations'), { target: { value: 'parser' } })
    expect(screen.getByText('Fix the parser')).toBeInTheDocument()
    expect(screen.queryByText('Review README')).not.toBeInTheDocument()
  })
})

describe('relTime', () => {
  it('under 60s → "just now"', () => {
    expect(relTime(NOW - 30_000, NOW)).toBe('just now')
  })

  it('minutes → "Nm ago"', () => {
    expect(relTime(NOW - 5 * 60_000, NOW)).toBe('5m ago')
  })

  it('hours → "Nh ago"', () => {
    expect(relTime(NOW - 3 * 3_600_000, NOW)).toBe('3h ago')
  })

  it('days → "Nd ago"', () => {
    expect(relTime(NOW - 2 * 86_400_000, NOW)).toBe('2d ago')
  })
})

// the sidebar speaks conversation-first — "what's selected right now?" has
// ONE visible answer per state, and it's always the open page.
describe('Sidebar — conversation-first selection', () => {
  function seed(overrides: Partial<ReturnType<typeof useStore.getState>> = {}): void {
    useStore.setState({
      agents: [makeAgent({ id: 'a1', name: 'Ana', sessions: [makeSession({ id: 's1', folder: 'f', title: 'Chat', agentId: 'a1' })] })],
      selectedAgentId: 'a1',
      ...overrides,
    })
  }

  it('with the conversation open, the selection lives on the # topic: bold + terracotta accent + aria-current; the agent row stays quiet', () => {
    seed({ selected: { folder: 'f', id: 's1' }, page: { kind: 'agent', id: 'a1' } })
    render(<Sidebar />)
    // the open topic is THE selected element
    const title = screen.getByText('Chat')
    expect(title.closest('span[title]')?.className).toContain('font-medium')
    const topicRow = title.closest('button')
    expect(topicRow).toHaveAttribute('aria-current', 'true')
    // no box: the selection is the terracotta accent on the left (no bg)
    expect(title.closest('li')?.querySelector('div')?.className).toContain('border-terracotta')
    // the agent row does NOT steal the selection
    const agentRow = screen.getByText('Ana').closest('button')
    expect(agentRow).not.toHaveAttribute('aria-current')
    expect(screen.getByText('Ana').closest('div.group')?.className).not.toContain('border-terracotta')
  })

  it('with the dossier open (no conversation), the selection lives on the agent row and no topic is bold', () => {
    seed({ selected: null, page: { kind: 'agent', id: 'a1' } })
    render(<Sidebar />)
    const agentRow = screen.getByText('Ana').closest('button')
    expect(agentRow).toHaveAttribute('aria-current', 'true')
    expect(screen.getByText('Ana').closest('div.group')?.className).toContain('border-terracotta')
    const title = screen.getByText('Chat')
    expect(title.closest('button')).not.toHaveAttribute('aria-current')
    expect(title.closest('span[title]')?.className).not.toContain('font-semibold')
  })

  it('with Settings open, nothing in the list reads as selected (even though selected stays set in the store)', () => {
    seed({ selected: { folder: 'f', id: 's1' }, page: { kind: 'settings' } })
    render(<Sidebar />)
    const nav = document.querySelector('nav') as HTMLElement
    expect(within(nav).queryAllByRole('button', { current: 'true' })).toHaveLength(0)
    expect(screen.getByText('Chat').closest('span[title]')?.className).not.toContain('font-semibold')
  })

  // the "+ New conversation" ghost row test with aria-current was retired:
  // there's no such row anymore — it's an inline button on the agent row
  // (see "the agent row inline + button starts a new chat" above).
})

describe('Sidebar — the per-topic ⋯ menu', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  function seedWithSession(): void {
    useStore.setState({
      agents: [makeAgent({ id: 'a1', name: 'Ana', sessions: [makeSession({ id: 's1', folder: 'f', title: 'Chat', agentId: 'a1' })] })],
      selectedAgentId: 'a1',
    })
  }

  it('the topic ⋯ trigger follows the hover/focus pattern (invisible by default) and opens a menu with Rename and Delete', () => {
    seedWithSession()
    render(<Sidebar />)
    const trigger = screen.getByLabelText('topic options')
    expect(trigger.className).toContain('opacity-0')
    expect(trigger.className).toContain('group-hover:opacity-100')
    expect(trigger.className).toContain('group-focus-within:opacity-100')
    expect(trigger).toHaveAttribute('aria-haspopup', 'menu')

    fireEvent.click(trigger)
    const menu = screen.getByRole('menu')
    expect(within(menu).getByText('Rename')).toBeInTheDocument()
    expect(within(menu).getByText('Delete')).toBeInTheDocument()
    // the old standalone ghost icons no longer exist outside the menu
    expect(screen.queryAllByLabelText('rename session')).toHaveLength(1)
  })

  it('Escape closes the topic ⋯ menu (keyboard-accessible)', () => {
    seedWithSession()
    render(<Sidebar />)
    fireEvent.click(screen.getByLabelText('topic options'))
    expect(screen.getByRole('menu')).toBeInTheDocument()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('closing the menu with the confirmation armed resets it (reopens with "Delete", not "sure? delete")', () => {
    seedWithSession()
    render(<Sidebar />)
    fireEvent.click(screen.getByLabelText('topic options'))
    fireEvent.click(screen.getByLabelText('delete session'))
    expect(screen.getByText('sure? delete')).toBeInTheDocument()
    fireEvent.keyDown(document, { key: 'Escape' })
    fireEvent.click(screen.getByLabelText('topic options'))
    expect(screen.getByText('Delete')).toBeInTheDocument()
    expect(screen.queryByText('sure? delete')).not.toBeInTheDocument()
  })
})

// The inbox is a CATEGORY, not an agent and not a project: its "Unassigned"
// label reads apart from a project header, while its loose sessions still
// share the exact same row anatomy/indentation as any agent's topics (they
// are the same SessionRow).
describe('Sidebar — Unassigned inbox', () => {
  it('the "Unassigned" label is styled apart from a project header (a different category)', () => {
    useStore.setState({
      agents: [
        makeAgent({ id: 'master', name: 'Master', folder: null, sessions: [makeSession({ id: 'm1', title: 'Loose', agentId: 'master' })] }),
        makeAgent({ id: 'a1', name: 'Ana', folder: '/a/one' }),
        // a second project so the group headers actually render (a single
        // group is shown headerless).
        makeAgent({ id: 'b2', name: 'Beto', folder: '/b/two' }),
      ],
    })
    render(<Sidebar />)
    const unassigned = screen.getByText('Unassigned')
    // a project header's label is UPPERCASE + letter-tracked; the inbox label
    // is neither — that's the visual cue that it's a different kind of thing.
    expect(unassigned.className).not.toContain('uppercase')
    expect(within(headerFor('one')).getByText('one').className).toContain('uppercase')
  })

  it("the inbox's loose sessions share the same row indentation as an agent's topics", () => {
    useStore.setState({
      agents: [
        makeAgent({ id: 'master', name: 'Master', folder: null, sessions: [makeSession({ id: 'm1', folder: 'fm', title: 'Loose', agentId: 'master' })] }),
        makeAgent({ id: 'a1', name: 'Ana', folder: '/a/one', sessions: [makeSession({ id: 's1', folder: 'f', title: 'Chat', agentId: 'a1' })] }),
      ],
    })
    render(<Sidebar />)
    const masterRow = screen.getByText('Loose').closest('li')?.querySelector('div')
    const anaRow = screen.getByText('Chat').closest('li')?.querySelector('div')
    expect(masterRow?.className).toContain('pl-3')
    expect(masterRow?.className).toBe(anaRow?.className)
  })

  // pinning a conversation puts it in its OWN "Pinned" section at the very
  // top AND it stays in its agent's list too — pinning is quick access, not
  // a move: "if it's pinned it shouldn't disappear from its project".
  describe('pin/unpin a conversation', () => {
    it("the topic ⋯ menu has Pin; clicking it pins it (pins) and it appears in Pinned WITHOUT leaving the agent's list", () => {
      vi.spyOn(api, 'patchPrefsProjects').mockResolvedValue({})
      useStore.setState({
        agents: [makeAgent({ id: 'a1', name: 'Ana', sessions: [makeSession({ id: 's1', folder: 'f', title: 'Chat', agentId: 'a1' })] })],
        selectedAgentId: 'a1',
      })
      render(<Sidebar />)
      fireEvent.click(screen.getByLabelText('topic options'))
      fireEvent.click(screen.getByText('Pin'))
      expect(useStore.getState().projectsPrefs.pins).toContainEqual({ source: 'claude', ref: 'f/s1' })
      // it appears under the "Pinned" section AND is still listed under its agent (twice)
      expect(screen.getByText('Pinned')).toBeInTheDocument()
      expect(screen.getAllByText('Chat')).toHaveLength(2)
      // in the Pinned section each row offers a direct "unpin" (no ⋯ menu);
      // clicking it unpins the conversation and it disappears from Pinned.
      fireEvent.click(screen.getByLabelText('unpin'))
      expect(useStore.getState().projectsPrefs.pins).not.toContainEqual({ source: 'claude', ref: 'f/s1' })
      expect(screen.getAllByText('Chat')).toHaveLength(1)
    })

    it('a pinned conversation carries the same dot as the tree: blinking while working, solid when unread', () => {
      useStore.setState({
        agents: [
          makeAgent({
            id: 'a1',
            name: 'Ana',
            sessions: [
              makeSession({ id: 'w', folder: 'f', title: 'Working one', mtime: NOW, lastRole: 'user', unread: false }),
              makeSession({ id: 'u', folder: 'f', title: 'Unread one', mtime: NOW - 3_600_000, lastRole: 'assistant', unread: true }),
            ],
          }),
        ],
        selectedAgentId: null,
        selected: null,
        projectsPrefs: {
          pins: [
            { source: 'claude', ref: 'f/w' },
            { source: 'claude', ref: 'f/u' },
          ],
        },
      })
      render(<Sidebar />)
      const pinned = screen.getByTestId('pinned-section')
      const dots = within(pinned).getAllByTestId('session-dot')
      expect(dots.map((d) => d.getAttribute('data-signal'))).toEqual(['working', 'attention'])
    })

    it("a pinned conversation appears in the Pinned section even if old (beyond the agent's collapse)", () => {
      const sessions = Array.from({ length: 8 }, (_, i) =>
        makeSession({ id: `s${i}`, folder: 'f', title: `topic ${i}`, agentId: 'a1', mtime: NOW - i * 100_000 }),
      )
      useStore.setState({
        agents: [makeAgent({ id: 'a1', name: 'Ana', sessions })],
        selectedAgentId: 'a1',
        projectsPrefs: { pins: [{ source: 'claude', ref: 'f/s7' }] }, // the oldest one
      })
      render(<Sidebar />)
      expect(screen.getByText('Pinned')).toBeInTheDocument()
      expect(screen.getByText('topic 7')).toBeInTheDocument() // visible in Pinned, without opening "older"
    })
  })

  // the durable "awaiting your reply" signal (a global summary + a
  // per-agent counter + a per-conversation dot, in terracotta) was RETIRED
  // — it wasn't practical per agent and the color read as an alarm; it'll
  // come back per conversation in a calmer color. What remains is the
  // neutral memory pulse (unread).
  describe('unread in memory (neutral dot)', () => {
    it('with a memory pulse (unreadAgentIds), the neutral unread dot shows on the agent emoji', () => {
      useStore.setState({
        agents: [makeAgent({ id: 'a1', name: 'Ana', sessions: [makeSession({ id: 's1', unread: false })] })],
        unreadAgentIds: new Set(['a1']),
      })
      render(<Sidebar />)
      expect(screen.getByTestId('unread-dot')).toBeInTheDocument()
    })

    it('the durable "awaiting your reply" signal no longer renders even with unread sessions', () => {
      useStore.setState({
        agents: [makeAgent({ id: 'a1', name: 'Ana', sessions: [makeSession({ id: 's1', unread: true }), makeSession({ id: 's2', unread: true })] })],
        selectedAgentId: 'a1',
      })
      render(<Sidebar />)
      expect(screen.queryByTestId('awaiting-reply-summary')).toBeNull()
      expect(screen.queryByTestId('awaiting-reply-count')).toBeNull()
      expect(screen.queryByTestId('awaiting-reply-dot')).toBeNull()
      expect(screen.queryByTestId('awaiting-reply-dot-agent')).toBeNull()
    })
  })
})

describe('cross-session address (peer) on hover', () => {
  it('resting on a topic with a live peer shows ONLY its short name as the tooltip; nothing painted in the row', () => {
    useStore.setState({
      agents: [
        makeAgent({
          id: 'a1',
          sessions: [makeSession({ id: 'ac1bf2e6-9c33-4306-af2f-57464db23ad9', title: 'Plan touch', peer: { name: 'silos-1f', status: 'busy' } })],
        }),
      ],
      selected: { folder: 'f', id: 'ac1bf2e6-9c33-4306-af2f-57464db23ad9' },
      nowTick: NOW,
    })
    render(<Sidebar />)
    expect(screen.getByTitle('silos-1f')).toHaveTextContent('Plan touch')
    expect(screen.queryByText(/ac1bf2e6/)).not.toBeInTheDocument()
  })

  it('no peer (no live process) → the tooltip is the title itself, as before', () => {
    useStore.setState({
      agents: [makeAgent({ id: 'a1', sessions: [makeSession({ id: 's1', title: 'Old' })] })],
      selected: { folder: 'f', id: 's1' },
      nowTick: NOW,
    })
    render(<Sidebar />)
    expect(screen.getByTitle('Old')).toBeInTheDocument()
  })
})

// the conversation being assembled (newChatOpen, nothing persisted yet) is
// a row too: the sidebar is the conversation list, and the one you're about
// to write into belongs in it from the moment it's on screen — named by the
// draft title as you type it in the header, even before you start writing.
describe('Sidebar — the new conversation has a row before its first message', () => {
  function seedNewChat(overrides: Partial<ReturnType<typeof useStore.getState>> = {}): void {
    useStore.setState({
      agents: [makeAgent({ id: 'a1', name: 'Ana', sessions: [makeSession({ id: 's1', folder: 'f', title: 'Chat', agentId: 'a1' })] })],
      selectedAgentId: 'a1',
      selected: null,
      page: { kind: 'agent', id: 'a1' },
      newChatOpen: true,
      newChatTitle: null,
      ...overrides,
    })
  }

  it('paints a selected draft row on top, named "New conversation" until a title is typed', () => {
    seedNewChat()
    render(<Sidebar />)
    const row = screen.getByTestId('draft-row')
    expect(within(row).getByText('New conversation')).toBeInTheDocument()
    expect(within(row).getByRole('button')).toHaveAttribute('aria-current', 'true')
    expect(row.querySelector('div')?.className).toContain('border-terracotta')
    // it sits ABOVE the persisted conversations
    expect(row.closest('ul')?.firstElementChild).toBe(row)
    // and the real topic doesn't read as selected
    expect(screen.getByText('Chat').closest('button')).not.toHaveAttribute('aria-current')
  })

  it('follows the draft title live (the header rename) and leaves when the session persists', () => {
    seedNewChat()
    render(<Sidebar />)
    act(() => useStore.setState({ newChatTitle: 'Helpdesk' }))
    expect(within(screen.getByTestId('draft-row')).getByText('Helpdesk')).toBeInTheDocument()
    expect(screen.queryByText('New conversation')).toBeNull()
    // first message landed: chat-init sets `selected` and turns newChatOpen off
    act(() => useStore.setState({ newChatOpen: false, selected: { folder: 'f', id: 's1' } }))
    expect(screen.queryByTestId('draft-row')).toBeNull()
  })

  it('with no conversations yet, the draft row replaces the empty hint', () => {
    seedNewChat({ agents: [makeAgent({ id: 'a1', name: 'Ana', sessions: [] })] })
    render(<Sidebar />)
    expect(screen.getByTestId('draft-row')).toBeInTheDocument()
    expect(screen.queryByText('No conversations yet')).toBeNull()
  })

  it('only while the agent page is in front — Settings shows no draft row', () => {
    seedNewChat({ page: { kind: 'settings' } })
    render(<Sidebar />)
    expect(screen.queryByTestId('draft-row')).toBeNull()
  })
})

// the whole row is the click target — its padding, the time, the dot, the
// empty right edge — not just the title's letters (no aiming at the text).
describe('Sidebar — the whole topic row opens the conversation', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('a click on the row surface (outside the title text) opens the session', async () => {
    const spy = vi.spyOn(api, 'sessionDetail').mockResolvedValue({ meta: makeSession({ id: 's1', folder: 'f' }), turns: [], total: 0 })
    useStore.setState({
      agents: [makeAgent({ id: 'a1', name: 'Ana', sessions: [makeSession({ id: 's1', folder: 'f', title: 'Chat', agentId: 'a1' })] })],
      selectedAgentId: 'a1',
    })
    render(<Sidebar />)
    const surface = screen.getByTestId('session-row').querySelector('div.group') as HTMLElement
    fireEvent.click(surface)
    await waitFor(() => expect(useStore.getState().selected).toEqual({ folder: 'f', id: 's1' }))
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('the title button still opens it exactly once (keyboard/click activation bubbles to the row)', async () => {
    const spy = vi.spyOn(api, 'sessionDetail').mockResolvedValue({ meta: makeSession({ id: 's1', folder: 'f' }), turns: [], total: 0 })
    useStore.setState({
      agents: [makeAgent({ id: 'a1', name: 'Ana', sessions: [makeSession({ id: 's1', folder: 'f', title: 'Chat', agentId: 'a1' })] })],
      selectedAgentId: 'a1',
    })
    render(<Sidebar />)
    fireEvent.click(screen.getByText('Chat'))
    await waitFor(() => expect(useStore.getState().selected).toEqual({ folder: 'f', id: 's1' }))
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('the ⋯ menu and its items never open the session; neither does a click while renaming', () => {
    const spy = vi.spyOn(api, 'sessionDetail').mockResolvedValue({ meta: makeSession({ id: 's1', folder: 'f' }), turns: [], total: 0 })
    vi.spyOn(api, 'rename').mockResolvedValue(undefined)
    useStore.setState({
      agents: [makeAgent({ id: 'a1', name: 'Ana', sessions: [makeSession({ id: 's1', folder: 'f', title: 'Chat', agentId: 'a1' })] })],
      selectedAgentId: 'a1',
    })
    render(<Sidebar />)
    openTopicMenu()
    fireEvent.click(screen.getByLabelText('rename session'))
    const input = screen.getByDisplayValue('Chat')
    fireEvent.click(input)
    fireEvent.click(input.closest('div.group') as HTMLElement)
    expect(spy).not.toHaveBeenCalled()
    expect(useStore.getState().selected).toBeNull()
  })
})

// automations in the sidebar: the sidebar is for
// navigation — agents and their conversations. An agent's automations are
// ONE small ⚡ on the agent's own row (no row of their own) pointing to the
// Automations page filtered to that agent; runs never appear; a KEPT thread
// is a conversation with a ⚡ mark.
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

describe('Sidebar — an agent’s automations are one ⚡ on its row', () => {
  const born = (id: string, automationId: string, mtime: number, title = `Run ${id}`): SessionView =>
    makeSession({ id, folder: 'f', title, mtime, agentId: 'a1', origin: { kind: 'automation', automationId, runId: `r-${id}` } })

  function seed(extra: Partial<ReturnType<typeof useStore.getState>> = {}): void {
    useStore.setState({
      agents: [
        makeAgent({
          id: 'a1',
          name: 'Ana',
          sessions: [
            makeSession({ id: 'h1', folder: 'f', title: 'Human one', mtime: NOW - 1000, agentId: 'a1' }),
            born('d2', 'digest', NOW - 500, 'Digest 29 Aug'),
            born('d1', 'digest', NOW - 90_000, 'Digest 28 Aug'),
            born('x1', 'gone-auto', NOW - 5000, 'Orphan run'),
          ],
        }),
      ],
      automations: [
        makeAutomation({ id: 'digest', name: 'Daily digest' }),
        makeAutomation({ id: 'keepalive', name: 'Keep consoles alive', paused: true }),
        makeAutomation({ id: 'other', agentId: 'b2', name: 'Not mine' }),
      ],
      selectedAgentId: 'a1',
      selected: null,
      page: { kind: 'agent', id: 'a1' },
      ...extra,
    })
  }
  const glyphOf = (agentId = 'a1'): HTMLElement => screen.getAllByTestId('automations-glyph').find((r) => r.getAttribute('data-agent-id') === agentId)!
  type Pending = ReturnType<typeof useStore.getState>['automationsPending'][number]

  it('one glyph ON the agent row that says whose it is and how many — no row, no names, no pill, no runs', () => {
    seed()
    render(<Sidebar />)
    const glyph = glyphOf()
    expect(glyph).toHaveAttribute('aria-label', "Ana's automations: 2 automations")
    expect(glyph).toHaveAttribute('data-signal', 'quiet')
    expect(glyph.className).not.toContain('text-terracotta')
    expect(screen.getByTestId('agent-row')).toContainElement(glyph)
    expect(screen.queryByTestId('automations-row')).toBeNull()
    expect(screen.queryByText(/\d+ automations?$/)).toBeNull()
    expect(screen.queryByText('Daily digest')).toBeNull()
    expect(screen.queryByText('Not mine')).toBeNull()
    expect(screen.queryByTestId('automations-tree')).toBeNull()
    expect(screen.queryByTestId('automations-count')).toBeNull()
  })

  it('one automation reads singular', () => {
    seed({ automations: [makeAutomation({ id: 'digest', name: 'Daily digest' })] })
    render(<Sidebar />)
    expect(glyphOf()).toHaveAttribute('aria-label', "Ana's automations: 1 automation")
  })

  it('run-born conversations never appear in the sidebar — of a live automation or a removed one', () => {
    seed()
    render(<Sidebar />)
    expect(screen.getAllByTestId('session-row').map((r) => r.getAttribute('data-session-key'))).toEqual(['f/h1'])
    expect(screen.queryByText('Digest 29 Aug')).toBeNull()
    expect(screen.queryByText('Orphan run')).toBeNull()
  })

  it('with every conversation run-born, the thread list is honestly empty and the glyph still points to the page', () => {
    seed({ agents: [makeAgent({ id: 'a1', name: 'Ana', sessions: [born('d1', 'digest', NOW - 90_000)] })] })
    render(<Sidebar />)
    expect(screen.getByText('No conversations yet')).toBeInTheDocument()
    expect(glyphOf()).toBeInTheDocument()
  })

  it('a click opens the Automations page filtered to this agent, without selecting the agent', () => {
    seed({ selectedAgentId: null, page: null })
    render(<Sidebar />)
    fireEvent.click(glyphOf())
    expect(useStore.getState().page).toEqual({ kind: 'automations', agent: 'a1' })
    expect(useStore.getState().selected).toBeNull()
  })

  it('terracotta (filled) when a last run failed', () => {
    seed({ automations: [makeAutomation({ id: 'digest', lastRun: { at: new Date(NOW).toISOString(), status: 'failed', durationMs: 1 } })] })
    render(<Sidebar />)
    const glyph = glyphOf()
    expect(glyph).toHaveAttribute('aria-label', "Ana's automations: 1 automation · 1 failed")
    expect(glyph).toHaveAttribute('data-signal', 'needs-you')
    expect(glyph.className).toContain('text-terracotta')
    expect(glyph.className).not.toContain('dot-blink')
    expect(glyph.querySelector('svg')).toHaveAttribute('fill', 'currentColor')
  })

  it('terracotta when a run waits for approval', () => {
    seed({
      automations: [makeAutomation({ id: 'digest' })],
      automationsPending: [{ id: 'run1', automationId: 'digest', status: 'waiting_approval' } as unknown as Pending],
    })
    render(<Sidebar />)
    const glyph = glyphOf()
    expect(glyph).toHaveAttribute('aria-label', "Ana's automations: 1 automation · 1 waiting for your approval")
    expect(glyph).toHaveAttribute('data-signal', 'needs-you')
  })

  it('blinking while one runs', () => {
    seed({ automations: [makeAutomation({ id: 'digest', lastRun: { at: new Date(NOW).toISOString(), status: 'running', durationMs: 0 } })] })
    render(<Sidebar />)
    const glyph = glyphOf()
    expect(glyph).toHaveAttribute('aria-label', "Ana's automations: 1 automation · 1 running")
    expect(glyph).toHaveAttribute('data-signal', 'working')
    expect(glyph.className).toContain('dot-blink')
    expect(glyph.className).not.toContain('text-terracotta')
  })

  it('quiet when nothing failed, waits or runs (another agent’s trouble is not this one’s)', () => {
    seed({
      automations: [
        makeAutomation({ id: 'digest', lastRun: { at: new Date(NOW).toISOString(), status: 'ok', durationMs: 1 } }),
        makeAutomation({ id: 'other', agentId: 'b2', lastRun: { at: new Date(NOW).toISOString(), status: 'failed', durationMs: 1 } }),
      ],
    })
    render(<Sidebar />)
    expect(glyphOf()).toHaveAttribute('data-signal', 'quiet')
  })

  it('a kept thread is no row at rest (its home is its automation); open, it is listed with a ⚡ mark; new-per-run sessions never are', () => {
    seed({
      agents: [
        makeAgent({
          id: 'a1',
          name: 'Ana',
          sessions: [
            makeSession({ id: 'h1', folder: 'f', title: 'Human one', mtime: NOW - 1000, agentId: 'a1' }),
            born('k1', 'watcher', NOW - 200, 'Watcher thread'),
            born('d2', 'digest', NOW - 500, 'Digest 29 Aug'),
          ],
        }),
      ],
      automations: [
        makeAutomation({ id: 'digest', name: 'Daily digest' }),
        makeAutomation({ id: 'watcher', name: 'Inbox watcher', thread: { mode: 'keep', folder: 'f', sessionId: 'k1' } }),
      ],
    })
    render(<Sidebar />)
    expect(screen.getAllByTestId('session-row').map((r) => r.getAttribute('data-session-key'))).toEqual(['f/h1'])
    act(() => {
      useStore.setState({ page: { kind: 'agent', id: 'a1' } as never, selected: { folder: 'f', id: 'k1' } as never })
    })
    const rows = screen.getAllByTestId('session-row')
    expect(rows.map((r) => r.getAttribute('data-session-key'))).toEqual(['f/k1', 'f/h1'])
    const mark = within(rows[0]!).getByTestId('kept-mark')
    expect(mark).toHaveAttribute('title', 'kept by automation Inbox watcher')
    expect(within(rows[1]!).queryByTestId('kept-mark')).toBeNull()
    expect(screen.queryByText('Digest 29 Aug')).toBeNull()
  })

  it('a conversation Silos opened for a message (history) is no row at rest (its home is the Inbox); open, it is a row with a ✉ mark and no unread dot', () => {
    seed({
      agents: [
        makeAgent({
          id: 'a1',
          name: 'Ana',
          sessions: [
            makeSession({ id: 'h1', folder: 'f', title: 'Human one', mtime: NOW - 1000, agentId: 'a1' }),
            makeSession({
              id: 'm1',
              folder: 'f',
              title: 'Ship the fix',
              mtime: NOW - 200,
              agentId: 'a1',
              lastRole: 'assistant',
              unread: false,
              origin: { kind: 'message', messageId: 'msg-1', from: 'finance', gist: 'ship the fix' },
            }),
          ],
        }),
      ],
      automations: [],
    })
    render(<Sidebar />)
    expect(screen.getAllByTestId('session-row').map((r) => r.getAttribute('data-session-key'))).toEqual(['f/h1'])
    act(() => {
      useStore.setState({ page: { kind: 'agent', id: 'a1' } as never, selected: { folder: 'f', id: 'm1' } as never })
    })
    const rows = screen.getAllByTestId('session-row')
    expect(rows.map((r) => r.getAttribute('data-session-key'))).toEqual(['f/m1', 'f/h1'])
    expect(within(rows[0]!).getByTestId('message-mark')).toHaveAttribute('title', 'opened for a message — “ship the fix”')
    expect(within(rows[0]!).queryByTestId('session-dot')).toBeNull()
    expect(within(rows[1]!).queryByTestId('message-mark')).toBeNull()
  })

  it('an agent with no automations shows no glyph at all', () => {
    seed({ automations: [], agents: [makeAgent({ id: 'a1', name: 'Ana', sessions: [makeSession({ id: 'h1', folder: 'f', agentId: 'a1' })] })] })
    render(<Sidebar />)
    expect(screen.queryByTestId('automations-glyph')).toBeNull()
  })

  // an automation belongs to an AGENT (Automation.agentId), Anywhere
  // included — the inbox has no agent row, so its "Unassigned" label line
  // carries the glyph from the moment one exists.
  it("Anywhere's automations show as the same glyph on the Unassigned line, even with no sessions under it", () => {
    useStore.setState({
      agents: [
        makeAgent({ id: MASTER_ID, name: 'Anywhere', folder: null, sessions: [] }),
        makeAgent({ id: 'a1', name: 'Ana', sessions: [makeSession({ id: 'h1', folder: 'f', agentId: 'a1' })] }),
      ],
      automations: [makeAutomation({ id: 'sweep', agentId: MASTER_ID, name: 'Nightly sweep' })],
      selectedAgentId: null,
      selected: null,
      page: null,
    })
    render(<Sidebar />)
    expect(screen.getByText('Unassigned')).toBeInTheDocument()
    expect(glyphOf(MASTER_ID)).toHaveAttribute('aria-label', "Anywhere's automations: 1 automation")
    expect(screen.queryByText('Nightly sweep')).toBeNull()
    fireEvent.click(glyphOf(MASTER_ID))
    expect(useStore.getState().page).toEqual({ kind: 'automations', agent: MASTER_ID })
  })

  it('Anywhere with neither sessions nor automations stays hidden — an empty inbox is noise', () => {
    useStore.setState({
      agents: [makeAgent({ id: MASTER_ID, name: 'Anywhere', folder: null, sessions: [] }), makeAgent({ id: 'a1', name: 'Ana' })],
      automations: [],
    })
    render(<Sidebar />)
    expect(screen.queryByText('Unassigned')).toBeNull()
  })
})

describe('Sidebar — the rail’s Automations door carries the global dot', () => {
  it('no dot when nothing needs the owner; solid when any agent’s automation failed or waits; blinking while one runs', () => {
    useStore.setState({ automations: [makeAutomation({ id: 'a', agentId: 'a1' })], automationsPending: [] })
    const { rerender } = render(<Sidebar />)
    expect(screen.queryByTestId('rail-automations-dot')).toBeNull()
    expect(screen.queryByTestId('rail-board-dot')).toBeNull()

    useStore.setState({
      automations: [makeAutomation({ id: 'a', agentId: 'b2', lastRun: { at: new Date(NOW).toISOString(), status: 'failed', durationMs: 1 } })],
    })
    rerender(<Sidebar />)
    expect(screen.getByTestId('rail-automations-dot')).toHaveAttribute('data-signal', 'needs-you')
    expect(screen.getByRole('button', { name: 'Automations' })).toHaveAttribute('title', 'Automations · one needs you')

    useStore.setState({
      automations: [makeAutomation({ id: 'a', agentId: 'b2', lastRun: { at: new Date(NOW).toISOString(), status: 'running', durationMs: 0 } })],
    })
    rerender(<Sidebar />)
    const dot = screen.getByTestId('rail-automations-dot')
    expect(dot).toHaveAttribute('data-signal', 'working')
  })
})

describe('Sidebar — Automations has its own entry in the global menu', () => {
  it('opens the unfiltered Automations page and reads active there', () => {
    render(<Sidebar />)
    fireEvent.click(screen.getByRole('button', { name: 'Automations' }))
    expect(useStore.getState().page).toEqual({ kind: 'automations' })
    expect(screen.getByRole('button', { name: 'Automations' })).toHaveAttribute('aria-current', 'true')
  })
})

// after a /clear the conversation left behind is DONE — it
// must not pile up next to the living one, and not under a fold either:
// it is archived, no row at all; only search (the text filter here, the
// command palette) finds it.
describe('a conversation left by /clear is archived: no row, search only', () => {
  function seedClear(): void {
    const before = makeSession({ id: 'old', title: 'Before the clear', mtime: NOW - 60_000 })
    const after = makeSession({ id: 'new', title: 'After the clear', mtime: NOW, parentKey: 'f/old', parentKind: 'clear' })
    const other = makeSession({ id: 'oth', title: 'Unrelated', mtime: NOW - 30_000 })
    useStore.setState({ agents: [makeAgent({ id: 'a1', name: 'Ana', sessions: [before, after, other] })], selectedAgentId: 'a1', selected: null })
  }

  it('the cleared conversation has no row and no fold', () => {
    seedClear()
    render(<Sidebar />)
    expect(screen.getByText('After the clear')).toBeTruthy()
    expect(screen.getByText('Unrelated')).toBeTruthy()
    expect(screen.queryByText('Before the clear')).toBeNull()
    expect(screen.queryByRole('button', { name: /archived/i })).toBeNull()
  })

  it('the text filter still finds it', () => {
    seedClear()
    useStore.setState({ filter: 'Before' })
    render(<Sidebar />)
    expect(screen.getByText('Before the clear')).toBeTruthy()
    expect(screen.queryByText('After the clear')).toBeNull()
  })

  it('the whole thread that led up to the /clear goes with it', () => {
    const a = makeSession({ id: 'a', title: 'Root', mtime: NOW - 90_000 })
    const b = makeSession({ id: 'b', title: 'Rotated', mtime: NOW - 60_000, parentKey: 'f/a' })
    const c = makeSession({ id: 'c', title: 'Fresh', mtime: NOW, parentKey: 'f/b', parentKind: 'clear' })
    useStore.setState({ agents: [makeAgent({ id: 'a1', name: 'Ana', sessions: [a, b, c] })], selectedAgentId: 'a1', selected: null })
    render(<Sidebar />)
    expect(screen.getAllByTestId('session-row').map((r) => r.getAttribute('data-session-key'))).toEqual(['f/c'])
  })
})

// births (plugin 0.7.0): a nested run — a `claude -p` an agent launched
// from Bash, presented at birth — is never one of the owner's
// conversations: no sidebar row, like an automation run.
describe('Sidebar — nested runs are not conversations', () => {
  it('a session with origin nested never gets a row', () => {
    useStore.setState({
      agents: [
        makeAgent({
          id: 'a1',
          name: 'Ana',
          sessions: [
            makeSession({ id: 'h1', folder: 'f', title: 'Human one', mtime: NOW - 1000, agentId: 'a1' }),
            makeSession({
              id: 'n1',
              folder: 'f',
              title: 'Smoke run',
              mtime: NOW - 500,
              agentId: 'a1',
              origin: { kind: 'nested', parent: 'h1', agentId: 'a1' },
            }),
            makeSession({
              id: 'n2',
              folder: 'f',
              title: 'Loose run',
              mtime: NOW - 400,
              agentId: 'a1',
              origin: { kind: 'nested', parent: null, agentId: 'a1' },
            }),
          ],
        }),
      ],
      automations: [],
      selectedAgentId: 'a1',
      selected: null,
      page: { kind: 'agent', id: 'a1' },
    })
    render(<Sidebar />)
    expect(screen.getAllByTestId('session-row').map((r) => r.getAttribute('data-session-key'))).toEqual(['f/h1'])
    expect(screen.queryByText('Smoke run')).toBeNull()
    expect(screen.queryByText('Loose run')).toBeNull()
  })
})

// the Silo Standard's rail door (Task 8): ONLY a silo whose manifest asked
// for the `rail` slot and whose grant stands gets one — never mere existence.
describe("MenuGlobal — a silo's rail door", () => {
  const silo = (over: Record<string, unknown> = {}) => ({
    id: 'invoices',
    name: 'Invoices',
    description: null,
    version: '0.1.0',
    apiVersion: 'silo-standard/v0',
    state: 'active',
    reason: 'active',
    conventions: [],
    wants: [],
    kinds: ['invoices/invoice'],
    producer: null,
    records: { parsed: 0, failed: 0 },
    lastWrite: null,
    freshness: null,
    slots: { requested: ['pulse'], granted: ['pulse'], off: [] },
    observedAt: '2026-10-30T12:00:00Z',
    ...over,
  })

  it('an active silo WITHOUT the rail grant adds nothing; with it, the door opens its page', () => {
    useStore.setState({ silos: [silo()] as never })
    const { rerender } = render(<Sidebar />)
    expect(screen.queryByLabelText('Invoices')).not.toBeInTheDocument()

    useStore.setState({ silos: [silo({ slots: { requested: ['rail'], granted: ['rail'], off: [] } })] as never })
    rerender(<Sidebar />)
    fireEvent.click(screen.getByLabelText('Invoices'))
    expect(useStore.getState().page).toEqual({ kind: 'silo', id: 'invoices' })
  })

  it('a granted rail turned off by the operator, or a pending silo, adds nothing', () => {
    useStore.setState({
      silos: [
        silo({ slots: { requested: ['rail'], granted: [], off: ['rail'] } }),
        silo({ id: 'docs', name: 'Docs', state: 'pending', slots: { requested: ['rail'], granted: [], off: [] } }),
      ] as never,
    })
    render(<Sidebar />)
    expect(screen.queryByLabelText('Invoices')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Docs')).not.toBeInTheDocument()
  })
})

// an empty install guides from the sidebar: a door where the list would be,
// and a quiet mark on «+» — both gone once anything exists
describe('Sidebar · empty install', () => {
  it('nothing yet: the list offers its door and «+» carries the mark; the door opens the New menu', () => {
    useStore.setState({ agents: [makeAgent({ id: MASTER_ID, name: 'Anywhere' })] })
    render(<Sidebar />)
    expect(screen.getByTestId('new-mark')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Start a conversation or a project/ }))
    expect(screen.getByRole('menu', { name: 'New' })).toBeInTheDocument()
  })
  it('an agent exists: no door, no mark', () => {
    useStore.setState({ agents: [makeAgent({ id: MASTER_ID, name: 'Anywhere' }), makeAgent()] })
    render(<Sidebar />)
    expect(screen.queryByTestId('new-mark')).toBeNull()
    expect(screen.queryByRole('button', { name: /Start a conversation or a project/ })).toBeNull()
  })
})
