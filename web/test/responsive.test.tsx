// responsive.test.tsx — a TWO-level responsive design ('list' | 'chat' — the
// old third level, 'threads', merged into the unified sidebar). jsdom
// doesn't measure media queries, so this tests (a) `mobileView`'s
// transitions in the store and (b) the back button's presence/behavior/
// classes (ChevronLeft, md:hidden) in the chat header — the rest (the
// sidebar collapsing to icons/overlay, a single column <md) is pure CSS and
// is covered in sidebar.test.tsx with class assertions.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { AgentPage } from '../src/components/AgentPage'
import { MapPage } from '../src/components/MapPage'
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
    mtime: 1_700_000_000_000,
    size: 10,
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
  // ContextColumn's run-mode line fetches this for any folder-bearing
  // agent as soon as its header mounts — a default resolution so these
  // responsive-behavior tests (which don't care about autonomy) don't
  // crash on the automock's undefined return.
  useStore.setState({
    chatMode: 'chat',
    agents: [makeAgent({ id: 'a1', name: 'Ana', sessions: [] })],
    warming: false,
    selectedAgentId: 'a1',
    selected: null,
    detail: null,
    filter: '',
    active: null,
    execOut: null,
    modal: null,
    error: null,
    queue: [],
    mobileView: 'list',
  })
})

describe("mobileView — the store's transitions", () => {
  // the phone lands on Home (the inbox comes first): the
  // store's TRUE initial state (not the beforeEach reset) is the page
  // column, and page null is Home.
  it('starts on Home — the page column, not the list', () => {
    expect(useStore.getInitialState().mobileView).toBe('chat')
    expect(useStore.getInitialState().page).toBeNull()
  })

  it("changePage(null) — boot at '/' and browser back to Home — shows Home on a phone, not the list", () => {
    useStore.setState({ mobileView: 'list', page: { kind: 'vault' } })
    useStore.getState().changePage(null)
    expect(useStore.getState().page).toBeNull()
    expect(useStore.getState().mobileView).toBe('chat')
  })

  it('the list is still reached on purpose from Home (backToMobileList keeps page null)', () => {
    useStore.setState({ mobileView: 'chat', page: null })
    useStore.getState().backToMobileList()
    expect(useStore.getState().mobileView).toBe('list')
    expect(useStore.getState().page).toBeNull()
  })

  // clicking an agent ALWAYS navigates to its AGENT DOSSIER (a full page) —
  // 'chat' on mobile no matter what, whether it has sessions or not (an
  // agent WITH sessions used to stay on 'list' to expand inline; that gap no
  // longer applies: the dossier itself is the page, reachable with one tap).
  it('selectAgent always navigates to chat (the dossier is the page), with or without sessions', () => {
    useStore.setState({
      agents: [makeAgent({ id: 'a1', name: 'Ana', sessions: [makeSession({ id: 's1', folder: 'f', agentId: 'a1' })] })],
      mobileView: 'list',
    })
    useStore.getState().selectAgent('a1')
    expect(useStore.getState().mobileView).toBe('chat')

    useStore.setState({
      agents: [makeAgent({ id: 'a2', name: 'Beto', sessions: [] })],
      mobileView: 'list',
    })
    useStore.getState().selectAgent('a2')
    expect(useStore.getState().mobileView).toBe('chat')
  })

  it('openSession switches to chat', async () => {
    mockedApi.sessionDetail.mockResolvedValue(makeDetail())
    await useStore.getState().openSession('f', 's1')
    expect(useStore.getState().mobileView).toBe('chat')
  })

  it('send starting a new chat (no session) switches to chat', async () => {
    mockedApi.chat.mockResolvedValue({ turnId: 't1' })
    useStore.setState({ selectedAgentId: 'a1', selected: null })
    await useStore.getState().send('hi')
    expect(useStore.getState().mobileView).toBe('chat')
  })

  it('send of a !command does not change mobileView', async () => {
    mockedApi.exec.mockResolvedValue({ stdout: '', stderr: '', code: 0, ms: 1, truncated: false })
    useStore.setState({ mobileView: 'list' })
    await useStore.getState().send('!ls')
    expect(useStore.getState().mobileView).toBe('list')
  })

  it('backToMobileList goes back from chat to list', () => {
    useStore.setState({ mobileView: 'chat' })
    useStore.getState().backToMobileList()
    expect(useStore.getState().mobileView).toBe('list')
  })

  it('backToMobileList on list stays on list (a no-op)', () => {
    useStore.setState({ mobileView: 'list' })
    useStore.getState().backToMobileList()
    expect(useStore.getState().mobileView).toBe('list')
  })

  // closeSession() used to leave mobileView untouched — "New
  // conversation"/closing the open session could leave the view on 'chat'
  // with no session and no header with a back button. closeSession()
  // ALWAYS goes back to 'list' — the special case where the AGENT itself is
  // also lost (archiving the open agent) is handled by the caller (see
  // agent-modal.test.tsx).
  it('closeSession resets mobileView to list', () => {
    useStore.setState({ mobileView: 'chat', selected: { folder: 'f', id: 's1' } })
    useStore.getState().closeSession()
    expect(useStore.getState().mobileView).toBe('list')
  })

  // queuing a message that opens a new chat (no session) must also lead to
  // the chat view on mobile — the user stays there watching the queue
  // drain, same as if the send had gone straight through.
  it('send in queue with a new chat (no session) also switches to chat', async () => {
    useStore.setState({
      selectedAgentId: 'a1',
      selected: null,
      active: { turnId: 't0', agentId: 'a1', text: '', tools: [], status: 'streaming', userText: 'x' },
      mobileView: 'list',
    })
    await useStore.getState().send('queued')
    expect(useStore.getState().mobileView).toBe('chat')
    expect(useStore.getState().queue).toHaveLength(1)
  })

  it('send in queue with a session already open does NOT force the switch (was already on chat)', async () => {
    useStore.setState({
      selectedAgentId: 'a1',
      selected: { folder: 'f', id: 's1' },
      agents: [makeAgent({ id: 'a1', name: 'Ana', sessions: [makeSession({ id: 's1', folder: 'f', agentId: 'a1' })] })],
      active: { turnId: 't0', agentId: 'a1', text: '', tools: [], status: 'streaming', userText: 'x' },
      mobileView: 'list',
    })
    await useStore.getState().send('queued')
    // the queue's destination IS the open session, but the fix only forces
    // the jump to 'chat' when the queued message opens a new chat — here it
    // wasn't necessary, and shouldn't break a deliberate navigation
    // elsewhere while the turn runs.
    expect(useStore.getState().mobileView).toBe('list')
  })
})

// the back button no longer lives in Chat.tsx (which lost all notion of
// agent identity) — it lives in AgentPage.tsx's header plate, always
// visible whenever an agent page is open.
describe('the back button — AgentPage', () => {
  beforeEach(() => {
    useStore.setState({
      agents: [makeAgent({ id: 'a1', name: 'Ana', sessions: [] })],
      selectedAgentId: 'a1',
      selected: { folder: 'f', id: 's1' },
      detail: makeDetail({ title: 'Open session' }),
      mobileView: 'chat',
      page: { kind: 'agent', id: 'a1' },
      tab: 'threads',
    })
  })

  it('exists, is md:hidden, and calls backToMobileList on click', () => {
    render(<AgentPage />)
    const button = screen.getByLabelText('back')
    expect(button).toHaveClass('md:hidden')
    fireEvent.click(button)
    expect(useStore.getState().mobileView).toBe('list')
  })
})

// selectAgent jumps to 'chat' for an agent with no sessions — with no back
// button ANYWHERE in the chat, the user would be stranded until reloading
// the page. The back button must exist whenever mobileView is 'chat',
// whether there's an open session or not (AgentPage.tsx's header plate
// guarantees it).
describe('the back button — AgentPage with NO session open', () => {
  it('an agent with no sessions that jumps to chat (selected null) still has a back button, and returns to list', () => {
    useStore.setState({
      agents: [makeAgent({ id: 'a1', name: 'Ana', sessions: [] })],
      selectedAgentId: 'a1',
      selected: null,
      detail: null,
      mobileView: 'chat',
      page: { kind: 'agent', id: 'a1' },
      tab: 'threads',
    })
    render(<AgentPage />)
    const button = screen.getByLabelText('back')
    expect(button).toHaveClass('md:hidden')
    fireEvent.click(button)
    expect(useStore.getState().mobileView).toBe('list')
  })
})

// on mobile, Map hides the sidebar (mobileView='chat', set by changePage) — with no back button they were a dead end,
// contradicting the global menu's "always navigable". The same BackButton
// (md:hidden) as the conversation.
describe('the back button — Map on mobile', () => {
  it('Map (standalone): the md:hidden back button exists and returns to list', () => {
    mockedApi.uses.mockResolvedValue({
      rows: [],
      cols: [],
      cells: [],
      sessions: [],
      measure: 'tokens',
      considered: 0,
      truncated: { rows: 0, cols: 0 },
      now: 0,
    } as never)
    useStore.setState({ page: { kind: 'map' }, mobileView: 'chat' })
    render(<MapPage />)
    const button = screen.getByLabelText('back')
    expect(button).toHaveClass('md:hidden')
    fireEvent.click(button)
    expect(useStore.getState().mobileView).toBe('list')
  })
})
