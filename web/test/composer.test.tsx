import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { Composer } from '../src/components/Composer'
import { PendingQueue } from '../src/components/PendingQueue'
import { Chat } from '../src/components/Chat'
import { AgentPage } from '../src/components/AgentPage'
import { ShortcutsOverlay } from '../src/components/ShortcutsOverlay'
import { AgentModal } from '../src/components/AgentModal'
import { useStore } from '../src/store'
import { api } from '../src/lib/api'
import { MASTER_ID } from '../src/lib/constants'
import type { AgentView, SessionDetail, SessionView } from '../src/lib/types'

vi.mock('../src/lib/api')

const mockedApi = vi.mocked(api, { deep: true })

// the real send() implementation (before each test's beforeEach replaces it
// with a mock) — used by tests that want to exercise the real send-failure
// flow (failedDraft).
const realSend = useStore.getState().send
// same idea, for the ↑ edit-queued-messages tests: the global beforeEach
// replaces removeFromQueue with a mock — these tests want the real
// implementation to verify the item genuinely leaves `queue`.
const realRemoveFromQueue = useStore.getState().removeFromQueue

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
  // Composer/Esc tests (which don't care about autonomy) don't crash on
  // the automock's undefined return.
  useStore.setState({
    chatMode: 'chat',
    agents: [makeAgent({ id: 'a1', name: 'Ana', sessions: [] })],
    warming: false,
    selectedAgentId: 'a1',
    selected: null,
    detail: null,
    // `page` isn't reset by any other field in this beforeEach — without
    // this explicit reset, a test that sets it (e.g. "ConversationHeader:
    // inline title rename") leaves it stuck for the rest of the file
    // (AgentPage falls back to a1's AgentDossier instead of the <Chat/>
    // fallback these Composer/Esc tests assume).
    page: null,
    newChatOpen: false,
    drafts: {},
    filter: '',
    active: null,
    execOut: null,
    modal: null,
    error: null,
    queue: [],
    memoryMode: null,
    terminals: [],
    terminalOpen: false,
    send: vi.fn().mockResolvedValue(undefined),
    cancel: vi.fn().mockResolvedValue(undefined),
    renameSession: vi.fn().mockResolvedValue(undefined),
    removeFromQueue: vi.fn(),
  })
})

describe('Composer', () => {
  it('typing + Enter calls send with the text and clears the textarea', () => {
    render(<Composer />)
    const textarea = screen.getByLabelText('message')
    fireEvent.change(textarea, { target: { value: 'hi agent' } })
    fireEvent.keyDown(textarea, { key: 'Enter' })
    expect(useStore.getState().send).toHaveBeenCalledWith('hi agent')
    expect(textarea).toHaveValue('')
  })

  it('Enter with empty text does not send', () => {
    render(<Composer />)
    const textarea = screen.getByLabelText('message')
    fireEvent.keyDown(textarea, { key: 'Enter' })
    expect(useStore.getState().send).not.toHaveBeenCalled()
  })

  it('Shift+Enter does not send (a line break)', () => {
    render(<Composer />)
    const textarea = screen.getByLabelText('message')
    fireEvent.change(textarea, { target: { value: 'line 1' } })
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: true })
    expect(useStore.getState().send).not.toHaveBeenCalled()
    expect(textarea).toHaveValue('line 1')
  })

  it('"!ls" activates shell mode (data-mode="shell")', () => {
    render(<Composer />)
    const textarea = screen.getByLabelText('message')
    fireEvent.change(textarea, { target: { value: '!ls' } })
    expect(textarea.closest('[data-mode]')).toHaveAttribute('data-mode', 'shell')
  })

  // the "stop" button relocated to the StatusLine. The message queue
  // CHANGES streaming behavior again: the textarea no longer disables
  // (typing while the agent works is the queue's whole point) and the send
  // button becomes "add to queue" — still no stop button here (it lives in
  // the StatusLine).
  it('while streaming: textarea enabled, "add to queue" button (disabled with no text), no stop button in the Composer', () => {
    useStore.setState({
      active: { turnId: 't1', agentId: 'a1', text: '', tools: [], status: 'streaming', userText: '', thinkingText: '', lastEvent: 'init' },
    })
    render(<Composer />)
    expect(screen.getByLabelText('message')).not.toBeDisabled()
    expect(screen.queryByLabelText('send')).not.toBeInTheDocument()
    expect(screen.getByLabelText('add to queue')).toBeDisabled()
    expect(screen.queryByLabelText('stop')).not.toBeInTheDocument()
  })

  it('while streaming: typing + Enter calls send (the store decides whether to queue) and clears the textarea', () => {
    useStore.setState({
      active: { turnId: 't1', agentId: 'a1', text: '', tools: [], status: 'streaming', userText: '', thinkingText: '', lastEvent: 'init' },
    })
    render(<Composer />)
    const textarea = screen.getByLabelText('message')
    fireEvent.change(textarea, { target: { value: 'a message while it works' } })
    expect(screen.getByLabelText('add to queue')).not.toBeDisabled()

    fireEvent.keyDown(textarea, { key: 'Enter' })

    expect(useStore.getState().send).toHaveBeenCalledWith('a message while it works')
    expect(textarea).toHaveValue('')
  })

  // the textarea no longer disables during streaming (see above), so it no
  // longer loses focus by being disabled — but the "reclaim focus when
  // done" effect is still valid for when nothing else had it (the user
  // wasn't typing at that moment).
  it('when streaming ends, the composer reclaims focus if nothing else had it', async () => {
    useStore.setState({
      active: { turnId: 't1', agentId: 'a1', text: '', tools: [], status: 'streaming', userText: '', thinkingText: '', lastEvent: 'init' },
    })
    render(<Composer />)
    const textarea = screen.getByLabelText('message')
    expect(textarea).not.toHaveFocus()

    useStore.setState({ active: null })

    await waitFor(() => expect(textarea).toHaveFocus())
  })

  it('when streaming ends, it does NOT steal focus if another element already has it (e.g. a rename input)', async () => {
    useStore.setState({
      active: { turnId: 't1', agentId: 'a1', text: '', tools: [], status: 'streaming', userText: '', thinkingText: '', lastEvent: 'init' },
    })
    render(<Composer />)
    const textarea = screen.getByLabelText('message')

    const otherInput = document.createElement('input')
    otherInput.setAttribute('aria-label', 'another focused input')
    document.body.appendChild(otherInput)
    otherInput.focus()
    expect(otherInput).toHaveFocus()

    useStore.setState({ active: null })

    await waitFor(() => expect(textarea).not.toBeDisabled())
    expect(otherInput).toHaveFocus()
    expect(textarea).not.toHaveFocus()

    document.body.removeChild(otherInput)
  })

  it('Enter during IME composition does not send', () => {
    render(<Composer />)
    const textarea = screen.getByLabelText('message')
    fireEvent.change(textarea, { target: { value: 'こんにちは' } })
    fireEvent.keyDown(textarea, { key: 'Enter', isComposing: true })
    expect(useStore.getState().send).not.toHaveBeenCalled()
    expect(textarea).toHaveValue('こんにちは')
  })

  it('the send button is disabled when the text is empty', () => {
    render(<Composer />)
    expect(screen.getByLabelText('send')).toBeDisabled()
    fireEvent.change(screen.getByLabelText('message'), { target: { value: 'something' } })
    expect(screen.getByLabelText('send')).not.toBeDisabled()
  })
})

// master with no open session needs a chosen project (see
// ProjectSelector/store.chosenProject) before it can write — master's new
// chat requires `cwd` in the body.
describe('Composer — master needs a chosen project before it can write', () => {
  it('master with no session and no chosen project: textarea and send button disabled, with a placeholder hint', () => {
    useStore.setState({ selectedAgentId: MASTER_ID, selected: null, chosenProject: null })
    render(<Composer />)
    const textarea = screen.getByLabelText('message')
    expect(textarea).toBeDisabled()
    expect(textarea).toHaveAttribute('placeholder', 'Pick a project above to start chatting')
    expect(screen.getByLabelText('send')).toBeDisabled()
  })

  it('master with no session but WITH a chosen project: the composer is enabled normally', () => {
    useStore.setState({ selectedAgentId: MASTER_ID, selected: null, chosenProject: '/x/project' })
    render(<Composer />)
    const textarea = screen.getByLabelText('message')
    expect(textarea).not.toBeDisabled()
    fireEvent.change(textarea, { target: { value: 'hi' } })
    expect(screen.getByLabelText('send')).not.toBeDisabled()
  })

  it('master with a session already open: the composer is enabled even with no chosenProject', () => {
    useStore.setState({ selectedAgentId: MASTER_ID, selected: { folder: 'f', id: 's1' }, chosenProject: null })
    render(<Composer />)
    expect(screen.getByLabelText('message')).not.toBeDisabled()
  })

  it('a normal agent is never disabled by this, even with no chosenProject', () => {
    useStore.setState({ selectedAgentId: 'a1', selected: null, chosenProject: null })
    render(<Composer />)
    expect(screen.getByLabelText('message')).not.toBeDisabled()
  })

  it('Enter in the disabled textarea does not call send', () => {
    useStore.setState({ selectedAgentId: MASTER_ID, selected: null, chosenProject: null })
    render(<Composer />)
    const textarea = screen.getByLabelText('message')
    fireEvent.keyDown(textarea, { key: 'Enter' })
    expect(useStore.getState().send).not.toHaveBeenCalled()
  })
})

describe('Composer — @files and /skills autocomplete', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  // the suggestions fetch happens after the 150ms debounce; advance the
  // timer inside act() so React applies the then()'s setState.
  async function advanceDebounce(): Promise<void> {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150)
    })
  }

  it('typing "@par" shows the dropdown with api.complete\'s suggestions', async () => {
    mockedApi.complete.mockResolvedValue(['src/pages/App.tsx', 'src/pages/Home.tsx'])
    render(<Composer />)
    const textarea = screen.getByLabelText('message')
    fireEvent.change(textarea, { target: { value: '@par' } })

    await advanceDebounce()

    expect(screen.getByRole('listbox')).toBeInTheDocument()
    expect(screen.getByText('src/pages/App.tsx')).toBeInTheDocument()
    expect(screen.getByText('src/pages/Home.tsx')).toBeInTheDocument()
    expect(mockedApi.complete).toHaveBeenCalledWith('a1', 'files', 'par')
  })

  it('↓ moves the selection and Tab inserts the chosen suggestion', async () => {
    mockedApi.complete.mockResolvedValue(['src/pages/App.tsx', 'src/pages/Home.tsx'])
    render(<Composer />)
    const textarea = screen.getByLabelText('message')
    fireEvent.change(textarea, { target: { value: '@par' } })
    await advanceDebounce()
    expect(screen.getByRole('listbox')).toBeInTheDocument()

    fireEvent.keyDown(textarea, { key: 'ArrowDown' })
    fireEvent.keyDown(textarea, { key: 'Tab' })

    expect(textarea).toHaveValue('@src/pages/Home.tsx ')
    expect(useStore.getState().send).not.toHaveBeenCalled()
  })

  it('Esc closes the dropdown', async () => {
    mockedApi.complete.mockResolvedValue(['src/pages/App.tsx'])
    render(<Composer />)
    const textarea = screen.getByLabelText('message')
    fireEvent.change(textarea, { target: { value: '@par' } })
    await advanceDebounce()
    expect(screen.getByRole('listbox')).toBeInTheDocument()

    fireEvent.keyDown(textarea, { key: 'Escape' })

    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  })

  it('Enter with the dropdown open accepts the suggestion and does not send', async () => {
    mockedApi.complete.mockResolvedValue(['src/pages/App.tsx'])
    render(<Composer />)
    const textarea = screen.getByLabelText('message')
    fireEvent.change(textarea, { target: { value: '@par' } })
    await advanceDebounce()
    expect(screen.getByRole('listbox')).toBeInTheDocument()

    fireEvent.keyDown(textarea, { key: 'Enter' })

    expect(useStore.getState().send).not.toHaveBeenCalled()
    expect(textarea).toHaveValue('@src/pages/App.tsx ')
  })

  it('"/cf" triggers skills autocomplete', async () => {
    mockedApi.complete.mockResolvedValue(['finance-acme'])
    render(<Composer />)
    const textarea = screen.getByLabelText('message')
    fireEvent.change(textarea, { target: { value: '/cf' } })

    await advanceDebounce()

    expect(mockedApi.complete).toHaveBeenCalledWith('a1', 'skills', 'cf')
    // the slash menu now shows skills with the '/' prefix (consistent with
    // what gets inserted and with the Commands section).
    expect(screen.getByText('/finance-acme')).toBeInTheDocument()
  })

  it('Enter during IME composition does not accept the suggestion or send, even with the dropdown open', async () => {
    mockedApi.complete.mockResolvedValue(['src/pages/App.tsx'])
    render(<Composer />)
    const textarea = screen.getByLabelText('message')
    fireEvent.change(textarea, { target: { value: '@par' } })
    await advanceDebounce()
    expect(screen.getByRole('listbox')).toBeInTheDocument()

    fireEvent.keyDown(textarea, { key: 'Enter', isComposing: true })

    expect(useStore.getState().send).not.toHaveBeenCalled()
    expect(textarea).toHaveValue('@par')
    expect(screen.getByRole('listbox')).toBeInTheDocument()
  })

  it('Shift+Enter with the dropdown open does not accept the suggestion (lets the line break through)', async () => {
    mockedApi.complete.mockResolvedValue(['src/pages/App.tsx'])
    render(<Composer />)
    const textarea = screen.getByLabelText('message')
    fireEvent.change(textarea, { target: { value: '@par' } })
    await advanceDebounce()
    expect(screen.getByRole('listbox')).toBeInTheDocument()

    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: true })

    expect(useStore.getState().send).not.toHaveBeenCalled()
    expect(textarea).toHaveValue('@par')
  })

  // a helper: leaves a session open with real cached commands (as if its
  // chat-init had brought them) for the '/' menu.
  function withSessionAndCommands(commands: string[]): void {
    useStore.setState({
      selected: { folder: 'f', id: 's1' },
      slashCommandsBySession: { 'f/s1': commands },
    })
  }

  it('"/" lists init\'s real commands (Commands section) and skills (Skills section), in separate sections', async () => {
    withSessionAndCommands(['clear', 'compact', 'model'])
    mockedApi.complete.mockResolvedValue(['finance-acme'])
    render(<Composer />)
    const textarea = screen.getByLabelText('message')
    fireEvent.change(textarea, { target: { value: '/' } })
    await advanceDebounce()

    expect(screen.getByText('Commands')).toBeInTheDocument()
    expect(screen.getByText('Skills')).toBeInTheDocument()
    expect(screen.getByText('/clear')).toBeInTheDocument()
    expect(screen.getByText('/compact')).toBeInTheDocument()
    expect(screen.getByText('/model')).toBeInTheDocument()
    expect(screen.getByText('/finance-acme')).toBeInTheDocument()
  })

  it('the "/" menu filters commands by what was typed', async () => {
    withSessionAndCommands(['clear', 'compact', 'model'])
    mockedApi.complete.mockResolvedValue([])
    render(<Composer />)
    const textarea = screen.getByLabelText('message')
    fireEvent.change(textarea, { target: { value: '/co' } })
    await advanceDebounce()

    expect(screen.getByText('/compact')).toBeInTheDocument()
    expect(screen.queryByText('/clear')).not.toBeInTheDocument()
    expect(screen.queryByText('/model')).not.toBeInTheDocument()
  })

  it('with no cached commands (a new chat with no init) the "/" menu falls back to skills only — never empty', async () => {
    // selected null (the beforeEach's default) → no commands; skills only.
    mockedApi.complete.mockResolvedValue(['a-skill'])
    render(<Composer />)
    const textarea = screen.getByLabelText('message')
    fireEvent.change(textarea, { target: { value: '/un' } })
    await advanceDebounce()

    expect(screen.getByText('/a-skill')).toBeInTheDocument()
    expect(screen.queryByText('Commands')).not.toBeInTheDocument()
  })

  it('choosing "/clear" (mapped) starts a new conversation and does NOT insert text', async () => {
    withSessionAndCommands(['clear'])
    const startNewConversation = vi.fn()
    useStore.setState({ startNewConversation })
    mockedApi.complete.mockResolvedValue([])
    render(<Composer />)
    const textarea = screen.getByLabelText('message')
    fireEvent.change(textarea, { target: { value: '/clear' } })
    await advanceDebounce()

    fireEvent.keyDown(textarea, { key: 'Enter' })

    expect(startNewConversation).toHaveBeenCalledTimes(1)
    expect(useStore.getState().send).not.toHaveBeenCalled()
    expect(textarea).toHaveValue('')
  })

  it('choosing "/model" (mapped) opens Run on and does NOT insert text', async () => {
    withSessionAndCommands(['model'])
    const openProviderPanel = vi.fn()
    useStore.setState({ openProviderPanel })
    mockedApi.complete.mockResolvedValue([])
    render(<Composer />)
    const textarea = screen.getByLabelText('message')
    fireEvent.change(textarea, { target: { value: '/model' } })
    await advanceDebounce()

    fireEvent.keyDown(textarea, { key: 'Enter' })

    expect(openProviderPanel).toHaveBeenCalledTimes(1)
    expect(textarea).toHaveValue('')
  })

  it('choosing a passthrough command (/compact) inserts it as text (the SDK will run it), fires no action', async () => {
    withSessionAndCommands(['compact'])
    mockedApi.complete.mockResolvedValue([])
    render(<Composer />)
    const textarea = screen.getByLabelText('message')
    fireEvent.change(textarea, { target: { value: '/comp' } })
    await advanceDebounce()

    fireEvent.keyDown(textarea, { key: 'Enter' })

    expect(textarea).toHaveValue('/compact ')
    expect(useStore.getState().send).not.toHaveBeenCalled()
  })

  // belt-and-suspenders: if the autocomplete trigger breaks before Enter (a
  // prior Esc, or a trailing space), a literal '/clear'/'/model' must NOT
  // travel raw to the SDK — the send-if-there's-text guard maps it all the same.
  it('Escape then Enter with a complete "/clear" still fires the action, does not send the raw text', async () => {
    withSessionAndCommands(['clear'])
    const startNewConversation = vi.fn()
    useStore.setState({ startNewConversation })
    mockedApi.complete.mockResolvedValue([])
    render(<Composer />)
    const textarea = screen.getByLabelText('message')
    fireEvent.change(textarea, { target: { value: '/clear' } })
    await advanceDebounce()
    // breaks the dropdown with Esc (manuallyClosed) — the trigger persists, but the menu is closed
    fireEvent.keyDown(textarea, { key: 'Escape' })
    fireEvent.keyDown(textarea, { key: 'Enter' })

    expect(startNewConversation).toHaveBeenCalledTimes(1)
    expect(useStore.getState().send).not.toHaveBeenCalled()
    expect(textarea).toHaveValue('')
  })

  it('a "/model " with a trailing space (a broken trigger) still maps to opening the cockpit on send', async () => {
    withSessionAndCommands(['model'])
    const openProviderPanel = vi.fn()
    useStore.setState({ openProviderPanel })
    mockedApi.complete.mockResolvedValue([])
    render(<Composer />)
    const textarea = screen.getByLabelText('message')
    // the trailing space kills the trigger (detectTrigger returns null with whitespace in q)
    fireEvent.change(textarea, { target: { value: '/model ' } })
    await advanceDebounce()
    fireEvent.keyDown(textarea, { key: 'Enter' })

    expect(openProviderPanel).toHaveBeenCalledTimes(1)
    expect(useStore.getState().send).not.toHaveBeenCalled()
    expect(textarea).toHaveValue('')
  })

  it('a command with args ("/model sonnet") is NOT intercepted on send — passes through as-is', async () => {
    withSessionAndCommands(['model'])
    const openProviderPanel = vi.fn()
    useStore.setState({ openProviderPanel })
    mockedApi.complete.mockResolvedValue([])
    render(<Composer />)
    const textarea = screen.getByLabelText('message')
    fireEvent.change(textarea, { target: { value: '/model sonnet' } })
    await advanceDebounce()
    fireEvent.keyDown(textarea, { key: 'Enter' })

    expect(openProviderPanel).not.toHaveBeenCalled()
    expect(useStore.getState().send).toHaveBeenCalledWith('/model sonnet')
  })
})

describe('Composer — a failed send does not lose the message', () => {
  it('if api.chat fails, the textarea (already optimistically cleared) recovers the text that was attempted', async () => {
    useStore.setState({ send: realSend })
    mockedApi.chat.mockRejectedValueOnce(new Error('the network dropped'))

    render(<Composer />)
    const textarea = screen.getByLabelText('message')
    fireEvent.change(textarea, { target: { value: 'an important message' } })
    fireEvent.keyDown(textarea, { key: 'Enter' })

    // an optimistic clear: the textarea empties right away, before the POST resolves
    expect(textarea).toHaveValue('')

    await waitFor(() => expect(textarea).toHaveValue('an important message'))
    expect(useStore.getState().error).toBe('the network dropped')
    expect(useStore.getState().failedDraft).toBeNull()
  })

  it('if the user retypes a new message while the old send is still in flight and THAT one fails, the old draft does NOT overwrite what was retyped', async () => {
    useStore.setState({ send: realSend })
    let rejectChat!: (e: Error) => void
    mockedApi.chat.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          rejectChat = reject
        }),
    )

    render(<Composer />)
    const textarea = screen.getByLabelText('message')
    fireEvent.change(textarea, { target: { value: 'an important message' } })
    fireEvent.keyDown(textarea, { key: 'Enter' })
    expect(textarea).toHaveValue('')

    // the textarea doesn't disable until the POST resolves — the user is
    // already typing the next message when the old one finally fails.
    fireEvent.change(textarea, { target: { value: 'new text' } })

    rejectChat(new Error('the network dropped'))

    await waitFor(() => expect(useStore.getState().error).toBe('the network dropped'))
    expect(useStore.getState().failedDraft).toBeNull()
    expect(textarea).toHaveValue('new text')
  })

  // a failed queue drain targets the agent it was queued for — almost never
  // the one being viewed at that instant. Restoring it over the visible
  // composer would be a silent misdelivery (B's text would appear in A's
  // textarea). It's only restored once B comes into view with an empty composer.
  it('a failed queue drain targeting another agent does NOT restore the text in the composer of the agent being viewed; selecting that agent does', async () => {
    useStore.setState({
      send: realSend,
      selectedAgentId: 'a1',
      agents: [makeAgent({ id: 'a1' }), makeAgent({ id: 'a2', name: 'Beto' })],
      active: { turnId: 't1', agentId: 'a1', text: '', tools: [], status: 'streaming', userText: '', thinkingText: '', lastEvent: 'init' },
      queue: [{ text: 'for B', agentId: 'a2', session: null }],
    })
    mockedApi.chat.mockRejectedValueOnce(new Error('drain failed'))
    mockedApi.sessionDetail.mockResolvedValue(makeDetail())

    render(<Composer />)
    const textarea = screen.getByLabelText('message') as HTMLTextAreaElement
    expect(textarea).toHaveValue('')

    // the in-progress turn's chat-done fires finishTurn → drains the queue
    // toward a2 → fails → failedDraft ends up with agentId: 'a2'.
    act(() => {
      useStore.getState().applyWs({ ev: 'chat-done', turnId: 't1', subtype: 'result', costUsd: 0 })
    })
    await waitFor(() => expect(useStore.getState().failedDraft).toEqual({ agentId: 'a2', text: 'for B' }))

    // we're still viewing a1: the composer must NOT steal B's text
    expect(textarea).toHaveValue('')

    // now a2 gets selected (composer still empty) — the draft restores
    act(() => {
      useStore.setState({ selectedAgentId: 'a2' })
    })

    await waitFor(() => expect(textarea).toHaveValue('for B'))
    expect(useStore.getState().failedDraft).toBeNull()
  })
})

// ↑ in the EMPTY composer edits the last queued message.
describe('Composer — ↑ edits the last queued message', () => {
  it('with 2 in the queue, ↑ pulls out the last one: the queue goes to 1, the textarea gets the text with the caret at the end', () => {
    useStore.setState({
      selectedAgentId: 'a1',
      removeFromQueue: realRemoveFromQueue,
      queue: [
        { text: 'first', agentId: 'a1', session: null },
        { text: 'second', agentId: 'a1', session: null },
      ],
    })
    render(<Composer />)
    const textarea = screen.getByLabelText('message') as HTMLTextAreaElement
    fireEvent.keyDown(textarea, { key: 'ArrowUp' })

    expect(textarea).toHaveValue('second')
    expect(textarea.selectionStart).toBe('second'.length)
    expect(useStore.getState().queue).toEqual([{ text: 'first', agentId: 'a1', session: null }])
  })

  it('repeated ↑ keeps pulling backward', () => {
    useStore.setState({
      selectedAgentId: 'a1',
      removeFromQueue: realRemoveFromQueue,
      queue: [
        { text: 'first', agentId: 'a1', session: null },
        { text: 'second', agentId: 'a1', session: null },
      ],
    })
    render(<Composer />)
    const textarea = screen.getByLabelText('message')
    fireEvent.keyDown(textarea, { key: 'ArrowUp' })
    expect(textarea).toHaveValue('second')
    // the textarea is no longer empty after the first ↑ — it needs to be
    // cleared (as the user would after editing/sending) for the second ↑ to fire.
    fireEvent.change(textarea, { target: { value: '' } })
    fireEvent.keyDown(textarea, { key: 'ArrowUp' })
    expect(textarea).toHaveValue('first')
    expect(useStore.getState().queue).toHaveLength(0)
  })

  it('with an empty queue, ↑ does nothing (recovering the last SENT message is out of scope)', () => {
    useStore.setState({ selectedAgentId: 'a1', removeFromQueue: realRemoveFromQueue, queue: [] })
    render(<Composer />)
    const textarea = screen.getByLabelText('message')
    fireEvent.keyDown(textarea, { key: 'ArrowUp' })
    expect(textarea).toHaveValue('')
  })

  it("↑ with text already typed does not touch the queue (the caret's normal behavior)", () => {
    useStore.setState({
      selectedAgentId: 'a1',
      removeFromQueue: realRemoveFromQueue,
      queue: [{ text: 'in queue', agentId: 'a1', session: null }],
    })
    render(<Composer />)
    const textarea = screen.getByLabelText('message')
    fireEvent.change(textarea, { target: { value: 'already typing something' } })
    fireEvent.keyDown(textarea, { key: 'ArrowUp' })
    expect(textarea).toHaveValue('already typing something')
    expect(useStore.getState().queue).toHaveLength(1)
  })

  it("↑ with the autocomplete dropdown open does not touch the queue (the dropdown's normal navigation)", async () => {
    mockedApi.complete.mockResolvedValue(['skill-a', 'skill-b'])
    useStore.setState({
      selectedAgentId: 'a1',
      removeFromQueue: realRemoveFromQueue,
      queue: [{ text: 'en queue', agentId: 'a1', session: null }],
    })
    vi.useFakeTimers()
    try {
      render(<Composer />)
      const textarea = screen.getByLabelText('message')
      fireEvent.change(textarea, { target: { value: '/' } })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(150)
      })
      expect(screen.getByRole('listbox')).toBeInTheDocument()

      fireEvent.keyDown(textarea, { key: 'ArrowUp' })

      expect(useStore.getState().queue).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it("only pulls out the VISIBLE AGENT's last one, not another agent's deeper in the queue", () => {
    useStore.setState({
      selectedAgentId: 'a1',
      removeFromQueue: realRemoveFromQueue,
      queue: [
        { text: 'for a1', agentId: 'a1', session: null },
        { text: 'for a2 (more recent)', agentId: 'a2', session: null },
      ],
    })
    render(<Composer />)
    const textarea = screen.getByLabelText('message')
    fireEvent.keyDown(textarea, { key: 'ArrowUp' })
    expect(textarea).toHaveValue('for a1')
    expect(useStore.getState().queue).toEqual([{ text: 'for a2 (more recent)', agentId: 'a2', session: null }])
  })

  // the central flow: pull a message out of the queue, keep working (even
  // switch agents), and resend it — it must go to whoever is selected AT
  // THAT MOMENT, not to whoever it was queued for.
  it('the edited message + Enter during streaming re-queues with the RE-CAPTURED destination', () => {
    useStore.setState({
      selectedAgentId: 'a1',
      agents: [
        { id: 'a1', name: 'Ana', emoji: '🧠', folder: '/x', skills: [], sessions: [], liveCount: 0, sessionCount: 0 },
        { id: 'a2', name: 'Beto', emoji: '🤖', folder: '/y', skills: [], sessions: [], liveCount: 0, sessionCount: 0 },
      ],
      selected: null,
      send: realSend,
      removeFromQueue: realRemoveFromQueue,
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
      queue: [{ text: 'editable message', agentId: 'a1', session: null }],
    })
    render(<Composer />)
    const textarea = screen.getByLabelText('message')
    fireEvent.keyDown(textarea, { key: 'ArrowUp' })
    expect(textarea).toHaveValue('editable message')
    expect(useStore.getState().queue).toHaveLength(0)

    // the user navigates to ANOTHER agent before resending
    useStore.setState({ selectedAgentId: 'a2' })

    fireEvent.keyDown(textarea, { key: 'Enter' })

    expect(useStore.getState().queue).toEqual([{ text: 'editable message', agentId: 'a2', session: null }])
  })
})

// Cmd/Ctrl+Enter as an explicit alternative to Enter for sending.
describe('Composer — Cmd/Ctrl+Enter sends', () => {
  it('Cmd+Enter (metaKey) sends just like Enter', () => {
    render(<Composer />)
    const textarea = screen.getByLabelText('message')
    fireEvent.change(textarea, { target: { value: 'hi' } })
    fireEvent.keyDown(textarea, { key: 'Enter', metaKey: true })
    expect(useStore.getState().send).toHaveBeenCalledWith('hi')
    expect(textarea).toHaveValue('')
  })

  it('Ctrl+Enter (ctrlKey) sends just like Enter', () => {
    render(<Composer />)
    const textarea = screen.getByLabelText('message')
    fireEvent.change(textarea, { target: { value: 'hi' } })
    fireEvent.keyDown(textarea, { key: 'Enter', ctrlKey: true })
    expect(useStore.getState().send).toHaveBeenCalledWith('hi')
    expect(textarea).toHaveValue('')
  })
})

// the queue paints as shaded bubbles INSIDE the conversation (PendingQueue),
// not as chips over the input. The contract (filtered by agent, a real
// index into removeFromQueue) stays identical.
describe('PendingQueue', () => {
  it('with no queued messages, renders nothing', () => {
    useStore.setState({ selectedAgentId: 'a1', queue: [] })
    const { container } = render(<PendingQueue />)
    expect(container).toBeEmptyDOMElement()
  })

  it('shows the selected agent\'s queued messages, marked "queued"', () => {
    useStore.setState({
      selectedAgentId: 'a1',
      queue: [
        { text: 'short', agentId: 'a1', session: null },
        { text: 'another message', agentId: 'a1', session: null },
      ],
    })
    render(<PendingQueue />)
    expect(screen.getByText('short')).toBeInTheDocument()
    expect(screen.getByText('another message')).toBeInTheDocument()
    expect(screen.getAllByText('queued')).toHaveLength(2)
  })

  it("a bubble's X calls removeFromQueue with its real index in the array", () => {
    useStore.setState({
      selectedAgentId: 'a1',
      queue: [
        { text: 'a', agentId: 'a1', session: null },
        { text: 'b', agentId: 'a1', session: null },
      ],
    })
    render(<PendingQueue />)
    fireEvent.click(screen.getAllByLabelText('remove from queue')[1]!)
    expect(useStore.getState().removeFromQueue).toHaveBeenCalledWith(1)
  })

  // CRITICAL (misdelivery): the queue is global to the store but a queued
  // message belongs to ONE specific agent (whoever was selected when it was
  // typed) — the bubble must only show under that agent, not under
  // whichever one the user happens to be looking at now.
  it("filters by agent: under B, A's bubble is not visible; under A, it is", () => {
    useStore.setState({
      selectedAgentId: 'B',
      queue: [
        { text: 'for A', agentId: 'A', session: null },
        { text: 'for B', agentId: 'B', session: null },
      ],
    })
    const { rerender } = render(<PendingQueue />)
    expect(screen.queryByText('for A')).not.toBeInTheDocument()
    expect(screen.getByText('for B')).toBeInTheDocument()

    useStore.setState({ selectedAgentId: 'A' })
    rerender(<PendingQueue />)
    expect(screen.getByText('for A')).toBeInTheDocument()
    expect(screen.queryByText('for B')).not.toBeInTheDocument()
  })

  // Same misdelivery class, one level deeper: an item also freezes its
  // SESSION at queue time (QueueItem.session). With two topics of the SAME
  // agent — one streaming, one where a reply was queued — the bubble must
  // only paint inside its own conversation, or the open one promises a
  // message that will actually land in the other.
  it('filters by session too: a bubble queued for topic s2 does not paint inside topic s1', () => {
    useStore.setState({
      selectedAgentId: 'A',
      selected: { folder: 'f', id: 's1' },
      queue: [
        { text: 'for topic two', agentId: 'A', session: { folder: 'f', id: 's2' } },
        { text: 'for topic one', agentId: 'A', session: { folder: 'f', id: 's1' } },
      ],
    })
    const { rerender } = render(<PendingQueue />)
    expect(screen.queryByText('for topic two')).not.toBeInTheDocument()
    expect(screen.getByText('for topic one')).toBeInTheDocument()

    // a new-conversation item (session null) paints only in the new-chat
    // view (no open session), never inside an existing topic
    useStore.setState({ queue: [{ text: 'for a new chat', agentId: 'A', session: null }] })
    rerender(<PendingQueue />)
    expect(screen.queryByText('for a new chat')).not.toBeInTheDocument()
    useStore.setState({ selected: null })
    rerender(<PendingQueue />)
    expect(screen.getByText('for a new chat')).toBeInTheDocument()
  })

  it("removeFromQueue still points to the array's real index even when the visible list is filtered", () => {
    useStore.setState({
      selectedAgentId: 'B',
      queue: [
        { text: 'for A', agentId: 'A', session: null }, // index 0, hidden under B
        { text: 'for B first', agentId: 'B', session: null }, // index 1, visible
        { text: 'for B second', agentId: 'B', session: null }, // index 2, visible
      ],
    })
    render(<PendingQueue />)
    const buttons = screen.getAllByLabelText('remove from queue')
    expect(buttons).toHaveLength(2)
    fireEvent.click(buttons[1]!)
    expect(useStore.getState().removeFromQueue).toHaveBeenCalledWith(2)
  })
})

// Chat.tsx lost its entire header (title/status/badges moved to
// ConversationHeader, AgentPage.tsx) — all that's left is the external
// terminal session banner.
describe('Chat — the external session banner', () => {
  it('the "Continue in Silos" banner only appears with detail.meta.native === false — while it is live', () => {
    const now = Date.now()
    useStore.setState({ selected: { folder: 'f', id: 's1' }, detail: makeDetail({ native: false, mtime: now }), nowTick: now })
    render(<Chat />)
    expect(screen.getByText('Continue in Silos ›')).toBeInTheDocument()
  })

  it('a terminal session that is no longer live does not claim to follow live', () => {
    const now = Date.now()
    useStore.setState({ selected: { folder: 'f', id: 's1' }, detail: makeDetail({ native: false, mtime: now - 3_600_000 }), nowTick: now })
    render(<Chat />)
    expect(screen.queryByText(/following live/)).not.toBeInTheDocument()
  })

  it('with no native session, there is no banner', () => {
    useStore.setState({ selected: { folder: 'f', id: 's1' }, detail: makeDetail({ native: true }) })
    render(<Chat />)
    expect(screen.queryByText('Continue in Silos ›')).not.toBeInTheDocument()
  })

  it('with no open session, there is no banner', () => {
    render(<Chat />)
    expect(screen.queryByText('Continue in Silos ›')).not.toBeInTheDocument()
    expect(screen.getByLabelText('message')).toBeInTheDocument()
  })

  it('switching between two open conversations clears the composer draft (no misdelivery)', () => {
    // type a draft for conversation A, then switch to an ALREADY-OPEN
    // conversation B without sending. The composer is keyed by the
    // destination, so it remounts and the draft never carries into B (send()
    // reads the current selection, which would otherwise misdeliver A into B).
    useStore.setState({ selected: { folder: 'f', id: 'A' }, detail: makeDetail({ id: 'A' }) })
    render(<Chat />)
    const ta = screen.getByLabelText('message')
    fireEvent.change(ta, { target: { value: 'draft meant for A' } })
    expect((screen.getByLabelText('message') as HTMLTextAreaElement).value).toBe('draft meant for A')

    act(() => {
      useStore.setState({ selected: { folder: 'f', id: 'B' }, detail: makeDetail({ id: 'B' }) })
    })
    expect((screen.getByLabelText('message') as HTMLTextAreaElement).value).toBe('')
  })
})

// the title lives in ConversationHeader (AgentPage.tsx) — the inline rename
// is tested there, mounting the full page.
describe('AgentPage — ConversationHeader: inline title rename', () => {
  it('clicking the title renames via store.renameSession', () => {
    useStore.setState({
      agents: [makeAgent({ id: 'a1' })],
      page: { kind: 'agent', id: 'a1' },
      selected: { folder: 'f', id: 's1' },
      detail: makeDetail({ title: 'Session' }),
    })
    render(<AgentPage />)
    fireEvent.click(screen.getByText('Session'))
    const input = screen.getByLabelText('new session title')
    fireEvent.change(input, { target: { value: 'New title' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(useStore.getState().renameSession).toHaveBeenCalledWith('f', 's1', 'New title')
  })
})

// a window-level Esc shortcut ("esc to interrupt" in the activity tree's
// footer). The handler lives in Chat.tsx (a keydown on window, cleaned up
// on unmount) and respects the contract with the Composer: if the
// autocomplete dropdown was open, its own Esc already did preventDefault —
// the global handler must see that and NOT interrupt the turn.
describe('AgentPage — the Esc shortcut', () => {
  it('Esc with a streaming turn calls cancel()', () => {
    const cancel = vi.fn().mockResolvedValue(undefined)
    useStore.setState({
      active: { turnId: 't1', agentId: 'a1', text: '', tools: [], status: 'streaming', userText: '', thinkingText: '', lastEvent: 'init' },
      cancel,
    })
    render(<AgentPage />)

    fireEvent.keyDown(window, { key: 'Escape' })

    expect(cancel).toHaveBeenCalled()
  })

  it('Esc with no active turn does not call cancel()', () => {
    const cancel = vi.fn().mockResolvedValue(undefined)
    useStore.setState({ active: null, cancel })
    render(<AgentPage />)

    fireEvent.keyDown(window, { key: 'Escape' })

    expect(cancel).not.toHaveBeenCalled()
  })

  it("Esc with the Composer's autocomplete dropdown open closes the dropdown and does NOT call cancel (the Composer did preventDefault)", async () => {
    mockedApi.complete.mockResolvedValue(['src/pages/App.tsx'])
    const cancel = vi.fn().mockResolvedValue(undefined)
    useStore.setState({
      active: { turnId: 't1', agentId: 'a1', text: '', tools: [], status: 'streaming', userText: '', thinkingText: '', lastEvent: 'init' },
      cancel,
    })
    vi.useFakeTimers()
    try {
      render(<AgentPage />)
      const textarea = screen.getByLabelText('message')
      fireEvent.change(textarea, { target: { value: '@par' } })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(150)
      })
      expect(screen.getByRole('listbox')).toBeInTheDocument()

      fireEvent.keyDown(textarea, { key: 'Escape' })

      expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
      expect(cancel).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('the handler cleans up on unmount (no listener leaks)', () => {
    const cancel = vi.fn().mockResolvedValue(undefined)
    useStore.setState({
      active: { turnId: 't1', agentId: 'a1', text: '', tools: [], status: 'streaming', userText: '', thinkingText: '', lastEvent: 'init' },
      cancel,
    })
    const { unmount } = render(<AgentPage />)
    unmount()

    fireEvent.keyDown(window, { key: 'Escape' })

    expect(cancel).not.toHaveBeenCalled()
  })

  // the header's session-rename input had its own Escape with no
  // preventDefault — a streaming turn used to cut off just from closing the
  // rename. Same contract as the Composer's dropdown: consume the Esc.
  it('Esc with the session rename input focused closes the rename and does NOT call cancel', () => {
    const cancel = vi.fn().mockResolvedValue(undefined)
    useStore.setState({
      agents: [makeAgent({ id: 'a1' })],
      page: { kind: 'agent', id: 'a1' },
      selected: { folder: 'f', id: 's1' },
      detail: makeDetail({ title: 'Session' }),
      active: { turnId: 't1', agentId: 'a1', text: '', tools: [], status: 'streaming', userText: '', thinkingText: '', lastEvent: 'init' },
      cancel,
    })
    render(<AgentPage />)
    fireEvent.click(screen.getByText('Session'))
    const input = screen.getByLabelText('new session title')

    fireEvent.keyDown(input, { key: 'Escape' })

    expect(screen.queryByLabelText('new session title')).not.toBeInTheDocument()
    expect(screen.getByText('Session')).toBeInTheDocument()
    expect(cancel).not.toHaveBeenCalled()
  })

  // memory mode shares the same global handler — with no turn in progress,
  // Esc exits the mode; with a turn in progress, it still cancels (the chip
  // closes with its own ✕ in that case, not Esc).
  it('Esc with no turn in progress exits memory mode', () => {
    useStore.setState({ memoryMode: { path: '/data/agents/a1/memory.md', name: 'Agent memory' }, active: null })
    render(<AgentPage />)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(useStore.getState().memoryMode).toBeNull()
  })

  it('Esc WITH a turn in progress cancels and does NOT touch memory mode', () => {
    const cancel = vi.fn().mockResolvedValue(undefined)
    useStore.setState({
      memoryMode: { path: '/data/agents/a1/memory.md', name: 'Agent memory' },
      active: { turnId: 't1', agentId: 'a1', text: '', tools: [], status: 'streaming', userText: '', thinkingText: '', lastEvent: 'init' },
      cancel,
    })
    render(<AgentPage />)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(cancel).toHaveBeenCalled()
    expect(useStore.getState().memoryMode).not.toBeNull()
  })
})

describe('Composer — memory mode', () => {
  it('with memoryMode active, shows the "Editing memory: <name>" chip with ✕', () => {
    useStore.setState({ memoryMode: { path: '/data/agents/a1/memory.md', name: 'Agent memory' } })
    render(<Composer />)
    expect(screen.getByText(/Editing memory: Agent memory/)).toBeInTheDocument()
    expect(screen.getByLabelText('exit memory mode')).toBeInTheDocument()
  })

  it('with no memoryMode, the chip is not visible', () => {
    render(<Composer />)
    expect(screen.queryByText(/Editing memory/)).not.toBeInTheDocument()
  })

  it("the chip's ✕ exits the mode without touching the typed text", () => {
    useStore.setState({ memoryMode: { path: '/data/agents/a1/memory.md', name: 'Agent memory' } })
    render(<Composer />)
    fireEvent.change(screen.getByLabelText('message'), { target: { value: 'a draft' } })
    fireEvent.click(screen.getByLabelText('exit memory mode'))
    expect(useStore.getState().memoryMode).toBeNull()
    expect(screen.getByLabelText('message')).toHaveValue('a draft')
  })

  it("Enter in memory mode: reads the file's fresh content, sends with the hidden prelude, and exits the mode", async () => {
    mockedApi.memory.read.mockResolvedValue('current content')
    useStore.setState({ memoryMode: { path: '/data/agents/a1/memory.md', name: 'Agent memory' } })
    render(<Composer />)
    const textarea = screen.getByLabelText('message')
    fireEvent.change(textarea, { target: { value: 'add a note about X' } })
    fireEvent.keyDown(textarea, { key: 'Enter' })

    // exits the mode right away, and passes the RAW text + path to send()
    // (send reads the file and builds the preamble itself, AFTER fixing the
    // destination — the read no longer happens here in the Composer, so there
    // is no async gap to misdeliver the edit). Prelude/read behavior is covered
    // by the store's send() tests in store.test.ts.
    expect(useStore.getState().memoryMode).toBeNull()
    expect(textarea).toHaveValue('')

    await waitFor(() => expect(useStore.getState().send).toHaveBeenCalled())
    const sendMock = useStore.getState().send as ReturnType<typeof vi.fn>
    const [sentText, options] = sendMock.mock.calls[0] as [string, { path: string }]
    expect(sentText).toBe('add a note about X')
    expect(options).toEqual({ path: '/data/agents/a1/memory.md' })
  })
})

// a shortcuts overlay with '?', but only when the composer (or any other
// text field) does NOT have focus — otherwise '?' types normally. The
// global handler lives in Chat.tsx (same place as Esc's); the modal itself
// is ShortcutsOverlay.
describe('AgentPage — the "?" shortcuts overlay', () => {
  it('"?" with the composer unfocused opens the overlay and lists the shortcuts', () => {
    render(
      <>
        <AgentPage />
        <ShortcutsOverlay />
      </>,
    )
    expect(screen.queryByRole('dialog', { name: 'Keyboard shortcuts' })).not.toBeInTheDocument()

    fireEvent.keyDown(window, { key: '?' })

    expect(useStore.getState().modal).toBe('shortcuts')
    expect(screen.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeInTheDocument()
    expect(screen.getByText('Edit queued message')).toBeInTheDocument()
    expect(screen.getByText('↑')).toBeInTheDocument()
    expect(screen.getByText('Cmd/Ctrl+Enter')).toBeInTheDocument()
  })

  // with a modal open (AgentModal/CreateSkillDialog) '?' must not open the
  // overlay either — it would replace it and the in-progress form would be
  // lost. Focus alone isn't enough to check: a click outside the input
  // (e.g. on a label) leaves the modal open but with no text field focused.
  it('"?" with a modal open (AgentModal) does NOT open the overlay or overwrite the modal', () => {
    useStore.setState({ modal: 'create' })
    render(
      <>
        <AgentPage />
        <ShortcutsOverlay />
        <AgentModal />
      </>,
    )
    expect(screen.getByRole('dialog', { name: 'new agent' })).toBeInTheDocument()

    fireEvent.keyDown(window, { key: '?' })

    expect(useStore.getState().modal).toBe('create')
    expect(screen.queryByRole('dialog', { name: 'Keyboard shortcuts' })).not.toBeInTheDocument()
    expect(screen.getByRole('dialog', { name: 'new agent' })).toBeInTheDocument()
  })

  it('"?" with the composer focused does NOT open the overlay (types normally)', () => {
    render(
      <>
        <AgentPage />
        <ShortcutsOverlay />
      </>,
    )
    const textarea = screen.getByLabelText('message')
    textarea.focus()

    fireEvent.keyDown(textarea, { key: '?' })

    expect(useStore.getState().modal).toBeNull()
    expect(screen.queryByRole('dialog', { name: 'Keyboard shortcuts' })).not.toBeInTheDocument()
  })

  it('Esc closes the shortcuts overlay', () => {
    useStore.setState({ modal: 'shortcuts' })
    render(<ShortcutsOverlay />)
    expect(screen.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeInTheDocument()

    fireEvent.keyDown(document, { key: 'Escape' })

    expect(useStore.getState().modal).toBeNull()
  })

  it('the X closes the overlay', () => {
    useStore.setState({ modal: 'shortcuts' })
    render(<ShortcutsOverlay />)

    fireEvent.click(screen.getByLabelText('close'))

    expect(useStore.getState().modal).toBeNull()
  })

  // with no preventDefault on the overlay's own Escape, the global handler's
  // Chat.tsx's global Esc handler (gated on defaultPrevented) used to see
  // the free event and cancel the in-progress turn — closing the overlay
  // with Esc must not cut anything off.
  it('Esc with a streaming turn closes the overlay WITHOUT canceling the turn', () => {
    const cancel = vi.fn().mockResolvedValue(undefined)
    useStore.setState({
      modal: 'shortcuts',
      active: { turnId: 't1', agentId: 'a1', text: '', tools: [], status: 'streaming', userText: '', thinkingText: '', lastEvent: 'init' },
      cancel,
    })
    render(
      <>
        <AgentPage />
        <ShortcutsOverlay />
      </>,
    )
    expect(screen.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeInTheDocument()

    fireEvent.keyDown(document, { key: 'Escape' })

    expect(useStore.getState().modal).toBeNull()
    expect(cancel).not.toHaveBeenCalled()
  })
})

// AgentModal and CreateSkillDialog used to close with Esc with no
// preventDefault — Chat.tsx's global handler used to see the free event and
// cancel an in-progress turn just from closing the modal. One combined test
// is enough (same pattern in both, same fix).
describe('AgentPage — Esc in modals does not cancel an in-progress turn', () => {
  it('Esc with AgentModal open and a streaming turn: closes the modal WITHOUT canceling', () => {
    const cancel = vi.fn().mockResolvedValue(undefined)
    useStore.setState({
      modal: 'create',
      active: { turnId: 't1', agentId: 'a1', text: '', tools: [], status: 'streaming', userText: '', thinkingText: '', lastEvent: 'init' },
      cancel,
    })
    render(
      <>
        <AgentPage />
        <AgentModal />
      </>,
    )
    expect(screen.getByRole('dialog')).toBeInTheDocument()

    fireEvent.keyDown(document, { key: 'Escape' })

    expect(useStore.getState().modal).toBeNull()
    expect(cancel).not.toHaveBeenCalled()
  })
})

// the send button's ▾ caret (Slack-style: Send now / Once at… / Every…) —
// opens a menu, and Once/Every mount the inline sheet (AutomationSheet) OVER
// the composer with the composer's text as the starting prompt.
describe('Composer — the ▾ caret (automations)', () => {
  // with no text the caret no longer exists (a permanently disabled sliver
  // uglified the empty composer) — it appears as a split-button segment as
  // soon as something is typed.
  it('with no text typed the caret does not render; with text it appears', () => {
    render(<Composer />)
    expect(screen.queryByLabelText('schedule options')).not.toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('message'), { target: { value: 'ping' } })
    expect(screen.getByLabelText('schedule options')).toBeInTheDocument()
  })

  // with no caret, its spot is held by a 28px gap — the button group
  // doesn't widen (nor does the textarea shrink) on the first keystroke.
  // With a caret, the gap disappears: constant geometry.
  it('with no caret there is a gap reserving its 28px; with text the gap is replaced by the caret', () => {
    render(<Composer />)
    expect(screen.getByTestId('caret-slot')).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('message'), { target: { value: 'ping' } })
    expect(screen.queryByTestId('caret-slot')).not.toBeInTheDocument()
    expect(screen.getByLabelText('schedule options')).toBeInTheDocument()
  })

  it('with text, the caret opens the Send now / Once at… / Every… menu', () => {
    render(<Composer />)
    fireEvent.change(screen.getByLabelText('message'), { target: { value: 'ping' } })
    fireEvent.click(screen.getByLabelText('schedule options'))
    expect(screen.getByText('Send now')).toBeInTheDocument()
    expect(screen.getByText('Once at…')).toBeInTheDocument()
    expect(screen.getByText('Every…')).toBeInTheDocument()
  })

  it('the menu\'s "Send now" sends just like Enter/the send button', () => {
    render(<Composer />)
    fireEvent.change(screen.getByLabelText('message'), { target: { value: 'ping' } })
    fireEvent.click(screen.getByLabelText('schedule options'))
    fireEvent.click(screen.getByText('Send now'))
    expect(useStore.getState().send).toHaveBeenCalledWith('ping')
  })

  it('"Once at…" opens the inline sheet with the composer\'s text as the starting prompt', () => {
    render(<Composer />)
    fireEvent.change(screen.getByLabelText('message'), { target: { value: 'check the deploy' } })
    fireEvent.click(screen.getByLabelText('schedule options'))
    fireEvent.click(screen.getByText('Once at…'))
    const sheet = screen.getByRole('dialog', { name: 'Schedule automation' })
    expect(within(sheet).getByLabelText('automation prompt')).toHaveValue('check the deploy')
    // the editor's own schedule sentences, on «Once»
    expect(within(sheet).getByRole('radio', { name: 'Once' })).toBeChecked()
  })

  it('"Every…" opens the sheet on the editor\'s period («Every [n] [unit]»), no date', () => {
    render(<Composer />)
    fireEvent.change(screen.getByLabelText('message'), { target: { value: 'daily check' } })
    fireEvent.click(screen.getByLabelText('schedule options'))
    fireEvent.click(screen.getByText('Every…'))
    const sheet = screen.getByRole('dialog', { name: 'Schedule automation' })
    expect(within(sheet).getByTestId('sheet-period')).toBeInTheDocument()
    expect(within(sheet).queryByRole('radio', { name: 'Once' })).toBeNull()
  })

  it('«More options ›» opens the automation editor for this agent, with the sentence handed over', () => {
    render(<Composer />)
    fireEvent.change(screen.getByLabelText('message'), { target: { value: 'weekly digest' } })
    fireEvent.click(screen.getByLabelText('schedule options'))
    fireEvent.click(screen.getByText('Every…'))
    fireEvent.click(screen.getByTestId('sheet-more-options'))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(useStore.getState().page).toEqual({ kind: 'automation', id: 'new', agent: 'a1' })
  })

  it('Esc closes the sheet (preventDefault: the global cancel-turn Esc does not fire)', () => {
    render(<Composer />)
    fireEvent.change(screen.getByLabelText('message'), { target: { value: 'ping' } })
    fireEvent.click(screen.getByLabelText('schedule options'))
    fireEvent.click(screen.getByText('Once at…'))
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('Schedule with no prompt stays disabled', () => {
    render(<Composer />)
    fireEvent.change(screen.getByLabelText('message'), { target: { value: 'ping' } })
    fireEvent.click(screen.getByLabelText('schedule options'))
    fireEvent.click(screen.getByText('Once at…'))
    const sheet = screen.getByRole('dialog')
    fireEvent.change(within(sheet).getByLabelText('automation prompt'), { target: { value: '' } })
    expect(within(sheet).getByText('Schedule')).toBeDisabled()
  })

  it('Schedule (Every…) POSTs via api.automations.create and, on success, clears the composer and confirms', async () => {
    mockedApi.automations.create.mockResolvedValue({
      id: 'new',
      name: 'ping',
      agentId: 'a1',
      prompt: 'ping',
      trigger: { kind: 'cron', expr: '0 9 * * 1-5' },
      thread: { mode: 'new' },
      approval: false,
      keepAlive: false,
      paused: false,
      createdAt: '2026-08-19T00:00:00.000Z',
    })
    render(<Composer />)
    fireEvent.change(screen.getByLabelText('message'), { target: { value: 'ping' } })
    fireEvent.click(screen.getByLabelText('schedule options'))
    fireEvent.click(screen.getByText('Every…'))
    const sheet = screen.getByRole('dialog')
    fireEvent.click(within(sheet).getByText('Schedule'))
    await waitFor(() =>
      expect(mockedApi.automations.create).toHaveBeenCalledWith(
        expect.objectContaining({ agentId: 'a1', prompt: 'ping', trigger: expect.objectContaining({ kind: 'period' }) }),
      ),
    )
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(screen.getByLabelText('message')).toHaveValue('')
    expect(screen.getByText('⏰ Automation created — ping')).toBeInTheDocument()
  })
})

// the '! for shell · / skills · @ files' affordances live in a guide row
// under the input that ALWAYS reserves its height (only toggles opacity —
// no layout jumps for the transcript anchored above it) and in an sr-only
// element linked via aria-describedby (screen readers used to announce them
// via the old placeholder; they can't be lost).
describe('Composer — the affordances guide row', () => {
  it('the textarea links the affordances via aria-describedby and the sr-only exists', () => {
    render(<Composer />)
    const textarea = screen.getByLabelText('message')
    expect(textarea).toHaveAttribute('aria-describedby', 'composer-affordances')
    const sr = document.getElementById('composer-affordances')
    expect(sr).not.toBeNull()
    expect(sr!.className).toContain('sr-only')
    expect(sr!.textContent).toContain('! for shell · / commands · @ files')
  })

  it('the visual row ALWAYS reserves its height: present in the DOM, opacity-0 unfocused, opacity-100 focused+empty', () => {
    render(<Composer />)
    const textarea = screen.getByLabelText('message')
    const row = document.querySelector('[aria-hidden="true"].h-4')
    expect(row).not.toBeNull()
    expect(row!.className).toContain('opacity-0')

    fireEvent.focus(textarea)
    expect(row!.className).toContain('opacity-100')

    // with text, it dims again — but the row stays mounted (no jump)
    fireEvent.change(textarea, { target: { value: 'hi' } })
    expect(row!.className).toContain('opacity-0')
    expect(document.querySelector('[aria-hidden="true"].h-4')).not.toBeNull()
  })

  it('the placeholder stays clean (no affordances inside it)', () => {
    render(<Composer />)
    const placeholder = screen.getByLabelText('message').getAttribute('placeholder')!
    expect(placeholder).toMatch(/^Message /)
    expect(placeholder).not.toContain('! for shell')
  })
})
