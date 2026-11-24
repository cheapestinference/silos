// scope-nav.test.tsx — navigating by scope and its three
// conditions, at the store/Composer level: an agent thing clicked from a
// conversation navigates to the agent page with the conversation as its
// way back; the composer's draft survives the round trip and goes on send;
// the global Esc cancels only a turn whose conversation is on screen.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { Composer } from '../src/components/Composer'
import { useStore, turnOnScreen, draftKeyOf, type ChatTurnState } from '../src/store'
import { api } from '../src/lib/api'
import type { AgentView, SessionView } from '../src/lib/types'

vi.mock('../src/lib/api')
const mockedApi = vi.mocked(api, { deep: true })

function makeSession(over: Partial<SessionView> = {}): SessionView {
  return {
    id: 's1',
    folder: 'f',
    title: 'Fix the parser',
    skills: [],
    cwd: null,
    mtime: 1,
    size: 1,
    turnCount: 1,
    live: false,
    worktree: false,
    native: true,
    agentId: 'a1',
    ...over,
  }
}
function makeAgent(over: Partial<AgentView> = {}): AgentView {
  return {
    id: 'a1',
    name: 'Ana',
    emoji: '🧠',
    folder: '/x',
    skills: [],
    sessions: [makeSession(), makeSession({ id: 's2', title: 'Other' })],
    liveCount: 0,
    sessionCount: 2,
    ...over,
  }
}
const turn = (over: Partial<ChatTurnState> = {}): ChatTurnState => ({
  turnId: 't1',
  agentId: 'a1',
  text: '',
  tools: [],
  status: 'streaming',
  userText: 'x',
  ...over,
})

beforeEach(() => {
  vi.clearAllMocks()
  mockedApi.sessionDetail.mockResolvedValue({ meta: makeSession(), turns: [], total: 0 })
  useStore.setState({
    agents: [makeAgent(), makeAgent({ id: 'b2', name: 'Beto', sessions: [] })],
    selectedAgentId: 'a1',
    page: { kind: 'agent', id: 'a1' },
    selected: { folder: 'f', id: 's1' },
    detail: { meta: makeSession(), turns: [], total: 0 },
    newChatOpen: false,
    agentFrom: null,
    drafts: {},
    tab: 'threads',
    active: null,
    queue: [],
    memoryMode: null,
    send: vi.fn().mockResolvedValue(undefined),
  })
})

describe('openDossier — navigation C', () => {
  it('from a conversation: the agent page on that facet, the conversation as the way back', () => {
    useStore.getState().openDossier('memory')
    const st = useStore.getState()
    expect(st.page).toEqual({ kind: 'agent', id: 'a1' })
    expect(st.selected).toBeNull()
    expect(st.tab).toBe('memory')
    expect(st.agentFrom).toEqual({ folder: 'f', id: 's1' })
  })

  it('on the agent page already: only the tab moves, the way back stays', () => {
    useStore.getState().openDossier('memory')
    useStore.getState().openDossier('skills')
    expect(useStore.getState().tab).toBe('skills')
    expect(useStore.getState().agentFrom).toEqual({ folder: 'f', id: 's1' })
  })

  it('from a new chat: the agent page, no way back to a conversation that does not exist', () => {
    useStore.setState({ selected: null, detail: null, newChatOpen: true })
    useStore.getState().openDossier('identity')
    expect(useStore.getState().newChatOpen).toBe(false)
    expect(useStore.getState().tab).toBe('identity')
    expect(useStore.getState().agentFrom).toBeNull()
  })

  it('any other navigation drops the way back', () => {
    useStore.getState().openDossier('memory')
    useStore.getState().selectAgent('b2')
    expect(useStore.getState().agentFrom).toBeNull()
    useStore.getState().openDossier('memory')
    useStore.setState({ agentFrom: { folder: 'f', id: 's1' } })
    useStore.getState().changePage({ kind: 'settings' })
    expect(useStore.getState().agentFrom).toBeNull()
  })

  it('opening the conversation again (the return chip) clears it', async () => {
    useStore.getState().openDossier('memory')
    await useStore.getState().openSession('f', 's1', { exact: true })
    expect(useStore.getState().selected).toEqual({ folder: 'f', id: 's1' })
    expect(useStore.getState().agentFrom).toBeNull()
  })
})

describe('condition 1 — drafts survive', () => {
  it('the unsent text is kept across a round trip to the agent page and restored', async () => {
    const view = render(<Composer />)
    fireEvent.change(screen.getByLabelText('message'), { target: { value: 'half a thought' } })
    // to the agent page: the conversation view (and the Composer) unmount
    useStore.getState().openDossier('memory')
    view.unmount()
    expect(useStore.getState().drafts['f/s1']).toBe('half a thought')
    // back
    await useStore.getState().openSession('f', 's1', { exact: true })
    render(<Composer />)
    expect(screen.getByLabelText('message')).toHaveValue('half a thought')
  })

  it('each conversation keeps its own draft, even under a mounted Composer', () => {
    render(<Composer />)
    const box = screen.getByLabelText('message')
    fireEvent.change(box, { target: { value: 'for s1' } })
    act(() => {
      useStore.setState({ selected: { folder: 'f', id: 's2' } })
    })
    expect(screen.getByLabelText('message')).toHaveValue('')
    fireEvent.change(screen.getByLabelText('message'), { target: { value: 'for s2' } })
    act(() => {
      useStore.setState({ selected: { folder: 'f', id: 's1' } })
    })
    expect(screen.getByLabelText('message')).toHaveValue('for s1')
    expect(useStore.getState().drafts).toEqual({ 'f/s1': 'for s1', 'f/s2': 'for s2' })
  })

  it('the new chat keeps its draft per agent', () => {
    useStore.setState({ selected: null, detail: null, newChatOpen: true })
    const view = render(<Composer />)
    fireEvent.change(screen.getByLabelText('message'), { target: { value: 'a new idea' } })
    view.unmount()
    expect(useStore.getState().drafts[draftKeyOf(null, 'a1')]).toBe('a new idea')
    render(<Composer />)
    expect(screen.getByLabelText('message')).toHaveValue('a new idea')
  })

  it('sending clears the draft', () => {
    useStore.setState({ drafts: { 'f/s1': 'ship it' } })
    render(<Composer />)
    const box = screen.getByLabelText('message')
    expect(box).toHaveValue('ship it')
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(useStore.getState().send).toHaveBeenCalledWith('ship it')
    expect(useStore.getState().drafts['f/s1']).toBeUndefined()
  })
})

describe('condition 2 — Esc stays where it belongs (turnOnScreen)', () => {
  it('the turn of the conversation on screen', () => {
    expect(
      turnOnScreen({ active: turn({ sessionKey: 'f/s1' }), page: { kind: 'agent', id: 'a1' }, selected: { folder: 'f', id: 's1' }, newChatOpen: false }),
    ).toBe(true)
  })
  it('never on the agent page (the conversation is not on screen)', () => {
    expect(turnOnScreen({ active: turn({ sessionKey: 'f/s1' }), page: { kind: 'agent', id: 'a1' }, selected: null, newChatOpen: false })).toBe(false)
  })
  it('never for another conversation', () => {
    expect(
      turnOnScreen({ active: turn({ sessionKey: 'f/s1' }), page: { kind: 'agent', id: 'a1' }, selected: { folder: 'f', id: 's2' }, newChatOpen: false }),
    ).toBe(false)
  })
  it('never on another page', () => {
    expect(turnOnScreen({ active: turn({ sessionKey: 'f/s1' }), page: { kind: 'settings' }, selected: { folder: 'f', id: 's1' }, newChatOpen: false })).toBe(
      false,
    )
  })
  it("a new chat's turn (no session yet) while that new chat is open", () => {
    expect(turnOnScreen({ active: turn({ sessionKey: null }), page: { kind: 'agent', id: 'a1' }, selected: null, newChatOpen: true })).toBe(true)
    expect(turnOnScreen({ active: turn({ sessionKey: null, agentId: 'b2' }), page: { kind: 'agent', id: 'a1' }, selected: null, newChatOpen: true })).toBe(
      false,
    )
  })
  it('a finished turn is nothing to cancel', () => {
    expect(
      turnOnScreen({
        active: turn({ sessionKey: 'f/s1', status: 'done' }),
        page: { kind: 'agent', id: 'a1' },
        selected: { folder: 'f', id: 's1' },
        newChatOpen: false,
      }),
    ).toBe(false)
  })
})
