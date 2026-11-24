import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { Turn, areTurnsEqual } from '../src/components/Turn'
import { Transcript, compensateScrollAfter } from '../src/components/Transcript'
import { Chat } from '../src/components/Chat'
import { ToolStreak } from '../src/components/ToolStreak'
import { useStore } from '../src/store'
import type { AgentView, SessionDetail, SessionView, Turn as TurnType } from '../src/lib/types'

function makeTurn(overrides: Partial<TurnType> = {}): TurnType {
  return {
    index: 0,
    role: 'assistant',
    text: '',
    tools: [],
    ts: null,
    ...overrides,
  }
}

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
    native: false,
    agentId: 'a1',
    ...overrides,
  }
}

function makeDetail(turns: TurnType[], total?: number): SessionDetail {
  return { meta: makeSession(), turns, total: total ?? turns.length }
}

function resetStore(): void {
  useStore.setState({
    chatMode: 'chat',
    agents: [makeAgent()],
    warming: false,
    selectedAgentId: 'a1',
    selected: { folder: 'f', id: 's1' },
    detail: null,
    filter: '',
    active: null,
    execOut: null,
    modal: null,
    error: null,
    userTextPersisted: false,
    receipts: {}, // a test with receipts must not contaminate the next one
    turnCloses: {}, // same criterion — a seeded close must not contaminate the next test
  })
}

describe('Turn', () => {
  it('assistant: markdown with bold and a code block renders <strong> and <pre>', () => {
    const t = makeTurn({
      role: 'assistant',
      text: 'this is **bold** and\n\n```js\nconst x = 1\n```',
    })
    render(<Turn turn={t} />)
    expect(screen.getByText('bold').tagName).toBe('STRONG')
    expect(document.querySelector('pre')).toBeInTheDocument()
  })

  it('thinking: "Reasoning…" collapsed, the content only appears after opening the details', () => {
    const t = makeTurn({
      role: 'assistant',
      text: 'final answer',
      thinking: 'thinking out loud about the problem',
    })
    render(<Turn turn={t} />)
    expect(screen.getByText('Reasoning…')).toBeInTheDocument()
    const details = document.querySelector('details')
    expect(details).toBeInTheDocument()
    expect(details?.hasAttribute('open')).toBe(false)
    expect(screen.getByText('thinking out loud about the problem')).not.toBeVisible()
    if (details) details.open = true
    fireEvent(details as Element, new Event('toggle'))
    expect(screen.getByText('thinking out loud about the problem')).toBeVisible()
  })

  it('ToolChip with detail: input visible after a click, a skill chip with data-skill="true"', () => {
    const t = makeTurn({
      role: 'assistant',
      text: 'used a skill',
      toolUses: [{ name: 'skill:frontend-design', skill: 'frontend-design', input: 'test input', result: 'result ok' }],
    })
    render(<Turn turn={t} />)
    const chip = screen.getByRole('button', { name: /frontend-design/ })
    expect(chip).toHaveAttribute('data-skill', 'true')
    expect(screen.queryByText('test input')).not.toBeInTheDocument()
    // aria-expanded reflects whether the detail is expanded.
    expect(chip).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(chip)
    expect(screen.getByText('test input')).toBeInTheDocument()
    expect(screen.getByText('result ok')).toBeInTheDocument()
    expect(chip).toHaveAttribute('aria-expanded', 'true')
  })

  // a chip with NO detail (just the name, streaming) is not expandable — it
  // must not carry aria-expanded (neither true nor false: the attribute's
  // absence is the correct signal for "this doesn't expand").
  it('a ToolChip with no detail (just the name) carries no aria-expanded', () => {
    const t = makeTurn({ role: 'assistant', text: '', tools: ['Bash'] })
    render(<Turn turn={t} />)
    const chip = screen.getByRole('button', { name: 'Bash' })
    expect(chip).not.toHaveAttribute('aria-expanded')
  })

  // the skills prelude (ChatService.withSkillsPrelude) stays in the real
  // JSONL, but the UI must never show it to the owner.
  // messages rescued from inside a tool_result (sent while a turn was in
  // progress) carry a subtle mark distinguishing them from a normal user turn.
  it('user: with interjection:true shows the "sent mid-turn" mark', () => {
    const t = makeTurn({ role: 'user', text: 'wait, change direction', interjection: true })
    render(<Turn turn={t} />)
    expect(screen.getByText('sent mid-turn')).toBeInTheDocument()
  })

  it('user: with no interjection, does not show the mark', () => {
    const t = makeTurn({ role: 'user', text: 'hi' })
    render(<Turn turn={t} />)
    expect(screen.queryByText('sent mid-turn')).not.toBeInTheDocument()
  })

  // a compaction marker turn (server: entry isCompactSummary, text always
  // '') — a divider, NOT a message bubble: no markdown, no turn
  // actions/chips, no bubble/avatar chrome.
  it('compact:true renders a divider with "Conversation compacted", no message bubble', () => {
    const t = makeTurn({ role: 'assistant', text: '', compact: true })
    const { container } = render(<Turn turn={t} />)
    expect(screen.getByText('Conversation compacted')).toBeInTheDocument()
    // no user bubble (ml-auto) and no markdown container (turn-md)
    expect(container.querySelector('.ml-auto')).not.toBeInTheDocument()
    expect(container.querySelector('.turn-md')).not.toBeInTheDocument()
  })

  it("user: the first turn's [silos-context] prelude is not shown", () => {
    const t = makeTurn({
      role: 'user',
      text: '[silos-context] Your skills for this session: /finance-skill — load them when the task calls for them. [/silos-context]\n\ngive me the VAT',
    })
    render(<Turn turn={t} />)
    expect(screen.getByText('give me the VAT')).toBeInTheDocument()
    expect(screen.queryByText(/silos-context/)).not.toBeInTheDocument()
  })
})

// a message from ANOTHER Claude session — the transcript's THIRD VOICE. A
// band row (a relative of system notices: hairline + a mono tag) with
// "↦ from <sender>"; the body renders as markdown at normal size. NEVER a
// user bubble (the owner didn't write it) and NEVER terracotta (orange is
// for action/live).
describe('Turn — a cross-session message (interSession)', () => {
  it('paints the band with "↦ from <sender>" and the body as markdown, with no user bubble', () => {
    const t = makeTurn({
      role: 'user',
      text: 'Hi — my commits on main are **DONE** and deployable.',
      interSession: { from: 'acme-e8' },
    })
    const { container } = render(<Turn turn={t} />)
    expect(screen.getByText('↦ from acme-e8')).toBeInTheDocument()
    // real markdown (not plain text): bold renders <strong>
    expect(screen.getByText('DONE').tagName).toBe('STRONG')
    expect(container.querySelector('.turn-md')).toBeInTheDocument()
    // never the owner's bubble (ml-auto is the user bubble's anatomy)
    expect(container.querySelector('.ml-auto')).not.toBeInTheDocument()
  })

  it('a normal user turn (no interSession) is still a bubble, no band', () => {
    const t = makeTurn({ role: 'user', text: 'hi' })
    const { container } = render(<Turn turn={t} />)
    expect(container.querySelector('.ml-auto')).toBeInTheDocument()
    expect(container.querySelector('[data-inter-session]')).not.toBeInTheDocument()
  })

  // with `agentId` resolved by the server, the sender's name is a button
  // that jumps to THEIR dossier (selectAgent). With no agentId, plain text
  // (the previous behavior). Honest: the sender's dossier, not the exact
  // thread (a clarifying title "go to <sender>").
  it('with an agentId the sender is a button that calls selectAgent(agentId)', () => {
    const spy = vi.spyOn(useStore.getState(), 'selectAgent').mockImplementation(() => {})
    const t = makeTurn({ role: 'user', text: 'body', interSession: { from: 'acme-e8', agentId: 'acme' } })
    render(<Turn turn={t} />)
    const button = screen.getByRole('button', { name: 'acme-e8' })
    fireEvent.click(button)
    expect(spy).toHaveBeenCalledWith('acme')
    spy.mockRestore()
  })

  it('with no agentId the sender is plain text (no button)', () => {
    const t = makeTurn({ role: 'user', text: 'body', interSession: { from: 'acme-e8' } })
    render(<Turn turn={t} />)
    expect(screen.queryByRole('button', { name: 'acme-e8' })).not.toBeInTheDocument()
    // the name is still visible inside the tag, just without a link
    expect(screen.getByText('↦ from acme-e8')).toBeInTheDocument()
  })
})

// an outgoing SendMessage — the chip shows the destination ("→ to X") when
// the input carries `to`; with no `to` (or no detail) it's just the bare name.
describe("ToolChip — an outgoing SendMessage's label", () => {
  it('SendMessage with input.to → the "→ to <destination>" chip', () => {
    const t = makeTurn({
      role: 'assistant',
      text: '',
      toolUses: [
        {
          name: 'SendMessage',
          skill: null,
          input: JSON.stringify({ to: 'acme-c6', summary: 'status', message: 'ping', type: 'message', recipient: 'acme-c6' }),
          result: null,
        },
      ],
    })
    render(<Turn turn={t} />)
    expect(screen.getByRole('button', { name: /acme-c6/ })).toBeInTheDocument()
  })

  it('SendMessage with no `to` in the input → the bare name', () => {
    const t = makeTurn({
      role: 'assistant',
      text: '',
      toolUses: [{ name: 'SendMessage', skill: null, input: JSON.stringify({ message: 'ping' }), result: null }],
    })
    render(<Turn turn={t} />)
    expect(screen.getByRole('button', { name: 'SendMessage' })).toBeInTheDocument()
  })

  it('SendMessage name-only (streaming, no detail) → the bare name', () => {
    const t = makeTurn({ role: 'assistant', text: '', tools: ['SendMessage'] })
    render(<Turn turn={t} />)
    expect(screen.getByRole('button', { name: 'SendMessage' })).toBeInTheDocument()
  })

  it('a truncated input (invalid JSON, capped at 2000) does not break: the bare name', () => {
    const t = makeTurn({
      role: 'assistant',
      text: '',
      toolUses: [{ name: 'SendMessage', skill: null, input: '{"to":"x","message":"trunc', result: null }],
    })
    render(<Turn turn={t} />)
    expect(screen.getByRole('button', { name: 'SendMessage' })).toBeInTheDocument()
  })
})

// a synthetic turn (message.model="<synthetic>" in the JSONL) paints as a
// system notice band — a mono tag + a severity tint — never as assistant
// prose.
describe('Turn — system notices (synthetic)', () => {
  it('rate limit: a notice with the "limit" tag', () => {
    const t = makeTurn({ synthetic: true, text: "You've hit your session limit · resets 10:20pm (Europe/Berlin)" })
    render(<Turn turn={t} />)
    expect(screen.getByRole('note')).toBeInTheDocument()
    expect(screen.getByText('limit')).toBeInTheDocument()
  })

  it('an API error: a notice with the "api error" tag', () => {
    const t = makeTurn({
      synthetic: true,
      text: 'API Error: 529 Overloaded. This is a server-side issue, usually temporary — try again in a moment. If it persists, check https://status.claude.com.',
    })
    render(<Turn turn={t} />)
    expect(screen.getByRole('note')).toBeInTheDocument()
    expect(screen.getByText('api error')).toBeInTheDocument()
  })

  it('an unknown synthetic: the "system" tag, neither limit nor api error', () => {
    const t = makeTurn({ synthetic: true, text: 'No response requested.' })
    render(<Turn turn={t} />)
    expect(screen.getByRole('note')).toBeInTheDocument()
    expect(screen.queryByText('limit')).not.toBeInTheDocument()
    expect(screen.queryByText('api error')).not.toBeInTheDocument()
    expect(screen.getByText('system')).toBeInTheDocument()
  })
})

// the durationMs marker turn (the CLI's system/turn_duration) paints a dim
// "✻ Worked for X"; below 5s nothing paints (same criterion as the external
// monitor).
describe('Turn — a historic receipt (durationMs)', () => {
  it('durationMs 86s → the turn says 1m 26s', () => {
    render(<Turn turn={makeTurn({ durationMs: 86_000 })} />)
    expect(screen.getByText(/1m 26s/)).toBeInTheDocument()
  })

  it('durationMs < 5s → renders nothing', () => {
    const { container } = render(<Turn turn={makeTurn({ durationMs: 3000 })} />)
    expect(container).toBeEmptyDOMElement()
  })
})

describe("areTurnsEqual (React.memo's comparator)", () => {
  it('same index/text.length/tools.length → true (React.memo skips the re-render)', () => {
    const a = makeTurn({ index: 3, text: 'hello world', tools: ['Bash'] })
    const b = makeTurn({ index: 3, text: 'goodbye all', tools: ['Grep'] }) // same lengths, different content
    expect(areTurnsEqual(a, b)).toBe(true)
  })

  it('the message grows (streaming) → false', () => {
    const a = makeTurn({ index: 3, text: 'hi' })
    const b = makeTurn({ index: 3, text: 'hi there' })
    expect(areTurnsEqual(a, b)).toBe(false)
  })

  it('the tools (or toolUses) grow → false', () => {
    const a = makeTurn({ index: 3, text: 'x', tools: ['Bash'] })
    const b = makeTurn({ index: 3, text: 'x', tools: ['Bash', 'Grep'] })
    expect(areTurnsEqual(a, b)).toBe(false)
  })

  // compact must enter the comparison — otherwise a turn that becomes the
  // compaction marker (same index/lengths) would stay painted as if nothing
  // changed by React's memo.
  it('compact differs (same index/lengths) → false', () => {
    const a = makeTurn({ index: 3, text: '', compact: false })
    const b = makeTurn({ index: 3, text: '', compact: true })
    expect(areTurnsEqual(a, b)).toBe(false)
  })
})

describe('Transcript', () => {
  // there's a team but no agent chosen yet (selectedAgentId null) —
  // Threads.tsx always showed "Choose an agent" in this gap; it got lost
  // migrating Threads to the unified sidebar.
  it('with a team but no agent chosen (selectedAgentId null), shows "Choose an agent"', () => {
    resetStore()
    useStore.setState({ selectedAgentId: null, selected: null, detail: null })
    render(<Transcript />)
    expect(screen.getByText('Choose an agent')).toBeInTheDocument()
  })

  it('with an active streaming turn shows the cursor', () => {
    resetStore()
    useStore.setState({
      detail: makeDetail([]),
      active: { turnId: 't1', agentId: 'a1', text: 'writing', tools: [], status: 'streaming', userText: 'hi', thinkingText: '', lastEvent: 'init' },
    })
    render(<Transcript />)
    expect(screen.getByTestId('cursor-streaming')).toBeInTheDocument()
  })

  it("while streaming, the user's optimistic bubble (active.userText) appears above the in-progress turn", () => {
    resetStore()
    useStore.setState({
      detail: makeDetail([]),
      active: {
        turnId: 't1',
        agentId: 'a1',
        text: 'responding…',
        tools: [],
        status: 'streaming',
        userText: 'this is what I just typed',
        thinkingText: '',
        lastEvent: 'init',
      },
    })
    render(<Transcript />)
    expect(screen.getByText('this is what I just typed')).toBeInTheDocument()
    expect(screen.getByTestId('cursor-streaming')).toBeInTheDocument()
  })

  it('userTextPersisted=true: the optimistic bubble does NOT paint but streaming stays visible (no duplicate)', () => {
    resetStore()
    useStore.setState({
      detail: makeDetail([{ index: 0, role: 'user', text: 'already persisted', tools: [], ts: null }]),
      active: {
        turnId: 't1',
        agentId: 'a1',
        text: 'responding…',
        tools: [],
        status: 'streaming',
        userText: 'already persisted',
        thinkingText: '',
        lastEvent: 'init',
      },
      userTextPersisted: true,
    })
    render(<Transcript />)
    // the persisted turn ('already persisted') IS there — the optimistic
    // bubble (same text) does NOT duplicate on top: it must appear only once.
    expect(screen.getAllByText('already persisted')).toHaveLength(1)
    expect(screen.getByTestId('cursor-streaming')).toBeInTheDocument()
  })

  it('userTextPersisted=false: the optimistic bubble paints (the default behavior)', () => {
    resetStore()
    useStore.setState({
      detail: makeDetail([]),
      active: {
        turnId: 't1',
        agentId: 'a1',
        text: 'responding…',
        tools: [],
        status: 'streaming',
        userText: 'not persisted yet',
        thinkingText: '',
        lastEvent: 'init',
      },
      userTextPersisted: false,
    })
    render(<Transcript />)
    expect(screen.getByText('not persisted yet')).toBeInTheDocument()
    expect(screen.getByTestId('cursor-streaming')).toBeInTheDocument()
  })

  it('if the active turn belongs to ANOTHER agent, nothing paints (neither the bubble nor streaming) in this view', () => {
    resetStore()
    useStore.setState({
      selectedAgentId: 'a1',
      detail: null,
      active: {
        turnId: 't1',
        agentId: 'other-agent',
        text: 'responding in another session…',
        tools: [],
        status: 'streaming',
        userText: 'message from another agent',
        thinkingText: '',
        lastEvent: 'init',
      },
    })
    render(<Transcript />)
    expect(screen.queryByText('message from another agent')).not.toBeInTheDocument()
    expect(screen.queryByTestId('cursor-streaming')).not.toBeInTheDocument()
  })

  it('if the active turn already has a sessionKey and it does not match the open session, nothing paints', () => {
    resetStore()
    useStore.setState({
      selectedAgentId: 'a1',
      selected: { folder: 'f', id: 's1' },
      detail: makeDetail([]),
      active: {
        turnId: 't1',
        agentId: 'a1',
        text: 'from another session',
        tools: [],
        status: 'streaming',
        userText: 'message from another session',
        sessionKey: 'f/other-session',
        thinkingText: '',
        lastEvent: 'init',
      },
    })
    render(<Transcript />)
    expect(screen.queryByText('message from another session')).not.toBeInTheDocument()
  })

  it('a 200-item cap: with 250 turns only renders the last 200 and shows the "show earlier" button', () => {
    resetStore()
    const turns = Array.from({ length: 250 }, (_, i) => makeTurn({ index: i, role: 'user', text: `turn ${i}` }))
    useStore.setState({ detail: makeDetail(turns, turns.length) })
    render(<Transcript />)
    expect(screen.queryByText('turn 0')).not.toBeInTheDocument()
    expect(screen.queryByText('turn 49')).not.toBeInTheDocument()
    expect(screen.getByText('turn 50')).toBeInTheDocument()
    expect(screen.getByText('turn 249')).toBeInTheDocument()
    const button = screen.getByRole('button', { name: 'Show earlier turns' })
    expect(button).toBeInTheDocument()

    fireEvent.click(button)
    expect(screen.getByText('turn 0')).toBeInTheDocument()
  })

  // a session's expanded windowSize must NOT survive a session change —
  // Chat.tsx mounts <Transcript key={selected...}/>, so switching sessions
  // remounts the whole component and resets `windowSize`.
  it("switching sessions resets the transcript's windowSize (fresh state, keyed per session)", () => {
    resetStore()
    const turnsA = Array.from({ length: 250 }, (_, i) => makeTurn({ index: i, role: 'user', text: `A turn ${i}` }))
    useStore.setState({ selected: { folder: 'f', id: 's1' }, detail: makeDetail(turnsA, turnsA.length) })
    const { rerender } = render(<Chat />)

    fireEvent.click(screen.getByRole('button', { name: 'Show earlier turns' }))
    expect(screen.getByText('A turn 0')).toBeInTheDocument()

    const turnsB = Array.from({ length: 250 }, (_, i) => makeTurn({ index: i, role: 'user', text: `B turn ${i}` }))
    useStore.setState({ selected: { folder: 'f', id: 's2' }, detail: makeDetail(turnsB, turnsB.length) })
    rerender(<Chat />)

    // a fresh windowSize again: B's oldest is still hidden by the cap, and
    // the "show earlier" button reappears without having been clicked this time.
    expect(screen.queryByText('B turn 0')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Show earlier turns' })).toBeInTheDocument()
    expect(screen.getByText('B turn 249')).toBeInTheDocument()
  })

  // saves the scrollHeight before expanding the windowSize and compensates
  // scrollTop after the repaint so the point the user was looking at
  // doesn't jump. jsdom doesn't measure real layout (scrollHeight is always
  // 0), so the compensation function is tested in isolation, with a mocked
  // ref — exactly what the handler claims to do (see Transcript.tsx).
  it('compensateScrollAfter adds the scrollHeight difference to scrollTop', () => {
    const elMock = { scrollHeight: 3200, scrollTop: 500 } as unknown as HTMLElement
    compensateScrollAfter(elMock, 1200)
    expect(elMock.scrollTop).toBe(500 + (3200 - 1200))
  })

  it('expanding the windowSize schedules the compensation via requestAnimationFrame', () => {
    resetStore()
    const turns = Array.from({ length: 250 }, (_, i) => makeTurn({ index: i, role: 'user', text: `turn ${i}` }))
    useStore.setState({ detail: makeDetail(turns, turns.length) })
    const rafSpy = vi.spyOn(window, 'requestAnimationFrame')
    try {
      render(<Transcript />)
      fireEvent.click(screen.getByRole('button', { name: 'Show earlier turns' }))
      expect(rafSpy).toHaveBeenCalled()
    } finally {
      rafSpy.mockRestore()
    }
  })

  // compact tool streaks — consecutive assistant "tools-only" turns (no
  // text) group visually.
  it('a streak of 5 tool-only turns collapses into a one-line breakdown (aria "5 steps") and expands into chips', () => {
    resetStore()
    const turns = Array.from({ length: 5 }, (_, i) => makeTurn({ index: i, role: 'assistant', text: '', tools: [`Tool${i}`] }))
    useStore.setState({ detail: makeDetail(turns) })
    render(<Transcript />)
    expect(screen.getByLabelText('5 steps')).toBeInTheDocument()
    const chip = screen.getByRole('button', { name: 'Tool4' })
    expect(chip).not.toBeVisible()
    const details = document.querySelector('details')
    expect(details).toBeInTheDocument()
    if (details) details.open = true
    fireEvent(details as Element, new Event('toggle'))
    expect(chip).toBeVisible()
  })

  it('a streak of 2 tool-only turns shows the chips directly, no details', () => {
    resetStore()
    const turns = [makeTurn({ index: 0, role: 'assistant', text: '', tools: ['Bash'] }), makeTurn({ index: 1, role: 'assistant', text: '', tools: ['Grep'] })]
    useStore.setState({ detail: makeDetail(turns) })
    render(<Transcript />)
    expect(screen.getByRole('button', { name: 'Bash' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Grep' })).toBeInTheDocument()
    expect(document.querySelector('details')).not.toBeInTheDocument()
  })

  it('a normal turn (with text) between two separate streaks still shows as a standalone turn', () => {
    resetStore()
    const turns = [
      makeTurn({ index: 0, role: 'assistant', text: '', tools: ['Bash'] }),
      makeTurn({ index: 1, role: 'assistant', text: 'normal response' }),
      makeTurn({ index: 2, role: 'assistant', text: '', tools: ['Grep'] }),
    ]
    useStore.setState({ detail: makeDetail(turns) })
    render(<Transcript />)
    expect(screen.getByText('normal response')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Bash' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Grep' })).toBeInTheDocument()
  })

  // the original "5 steps" test used 1 tool per turn, so it couldn't
  // distinguish "sum of tools" from "number of turns" (with 5 turns of 1
  // tool each, both readings give 5). Here the counting semantics are
  // pinned with differently-sized turns, and the windowSize cap's edge and
  // the duration formatting are covered too.
  it('windowSize edge: a streak starting BEFORE the cap only counts the VISIBLE turns', () => {
    resetStore()
    const turns: TurnType[] = []
    for (let i = 0; i < 3; i++) turns.push(makeTurn({ index: i, role: 'user', text: `previous ${i}` }))
    // 3,4: tool-only turns HIDDEN by the windowSize cap (200) — the same
    // "physical" streak as the one below, but the windowSize cutoff leaves them out.
    turns.push(makeTurn({ index: 3, role: 'assistant', text: '', tools: ['Hidden1'] }))
    turns.push(makeTurn({ index: 4, role: 'assistant', text: '', tools: ['Hidden2'] }))
    // 5..8: VISIBLE tool-only turns — 4 tools, 1 per turn.
    for (let i = 5; i <= 8; i++) turns.push(makeTurn({ index: i, role: 'assistant', text: '', tools: [`Visible${i}`] }))
    // padding up to 205 total turns → the default cap (200) hides exactly
    // the first 5 (indices 0..4, including both "Hidden*").
    for (let i = 9; i < 205; i++) turns.push(makeTurn({ index: i, role: 'user', text: `padding ${i}` }))

    useStore.setState({ detail: makeDetail(turns, turns.length) })
    render(<Transcript />)

    // if the grouping counted the hidden ones, the summary would say
    // "6 steps"; grouping ONLY over what's visible (groupTurns applies
    // after the cap), the visible streak fragment is 4 tools → "4 steps".
    expect(screen.getByLabelText('4 steps')).toBeInTheDocument()
    expect(screen.queryByLabelText('6 steps')).not.toBeInTheDocument()
    expect(screen.queryByText('Hidden1')).not.toBeInTheDocument()
    expect(screen.queryByText('Hidden2')).not.toBeInTheDocument()
  })
})

describe('ToolStreak — counting and duration semantics', () => {
  it('the summary sums TOOLS, not turns: a streak of 2 turns with [3,2] tools → 5 steps, named', () => {
    const turns: TurnType[] = [
      makeTurn({ index: 0, role: 'assistant', text: '', tools: ['A', 'B', 'C'] }),
      makeTurn({ index: 1, role: 'assistant', text: '', tools: ['D', 'E'] }),
    ]
    render(<ToolStreak turns={turns} />)
    expect(screen.getByLabelText('5 steps')).toHaveTextContent('A')
    expect(screen.queryByLabelText('2 steps')).not.toBeInTheDocument()
  })

  it('duration: first/last ts 3 minutes apart → the summary ends with "— 3m"', () => {
    const turns: TurnType[] = [
      makeTurn({
        index: 0,
        role: 'assistant',
        text: '',
        tools: ['A', 'B', 'C', 'D'],
        ts: '2026-08-18T10:00:00.000Z',
      }),
      makeTurn({ index: 1, role: 'assistant', text: '', tools: ['E'], ts: '2026-08-18T10:03:00.000Z' }),
    ]
    render(<ToolStreak turns={turns} />)
    expect(screen.getByText(/— 3m$/)).toBeInTheDocument()
  })

  // "· 0s" added nothing — the same 5s threshold as the rest of the app.
  it('duration: first/last ts 3 seconds apart (<5s) → no duration suffix', () => {
    const turns: TurnType[] = [
      makeTurn({
        index: 0,
        role: 'assistant',
        text: '',
        tools: ['A', 'B', 'C', 'D'],
        ts: '2026-08-18T10:00:00.000Z',
      }),
      makeTurn({ index: 1, role: 'assistant', text: '', tools: ['E'], ts: '2026-08-18T10:00:03.000Z' }),
    ]
    render(<ToolStreak turns={turns} />)
    const summary = screen.getByLabelText('5 steps')
    expect(summary.textContent).not.toMatch(/—/)
  })

  it('duration: a null ts on the last turn → no duration suffix and no "NaN" in the summary', () => {
    const turns: TurnType[] = [
      makeTurn({
        index: 0,
        role: 'assistant',
        text: '',
        tools: ['A', 'B', 'C', 'D'],
        ts: '2026-08-18T10:00:00.000Z',
      }),
      makeTurn({ index: 1, role: 'assistant', text: '', tools: ['E'], ts: null }),
    ]
    render(<ToolStreak turns={turns} />)
    const summary = screen.getByLabelText('5 steps')
    expect(summary.textContent).not.toMatch(/—/)
    expect(summary.textContent).not.toMatch(/NaN/)
  })
})

// turn receipts anchored in the Transcript: an anchor that lands in the
// MIDDLE of a streak must not silently lose the receipt, and the queue's
// "still running" count only applies to a LIVE session (a dead session
// can't claim work in flight).
describe('Transcript — anchored receipts', () => {
  const T0 = '2026-08-20T10:00:00.000Z'
  const contextWithSubagent: NonNullable<SessionDetail['context']> = {
    plan: null,
    agents: [{ id: 'sa1', description: 'sweep tests', type: 'general-purpose', background: true, startedAt: T0 }], // no endedAt: "running"
    pending: null,
    links: { prs: [], artifacts: [], worktree: null },
    events: [],
    files: [],
    tools: [],
    flags: { remote: false, permissionMode: null, gitBranch: null, effort: null, model: null },
    waiting: null,
  }

  function seedReceipt(overrides: { mtime: number; context?: SessionDetail['context'] }): void {
    resetStore()
    const turns: TurnType[] = [
      makeTurn({ index: 0, role: 'user', text: 'go', ts: T0 }),
      // two consecutive tools-only turns → groupTurns merges them into ONE
      // streak; the receipt (ts between the two) anchors on the FIRST — mid-streak.
      makeTurn({ index: 1, role: 'assistant', text: '', tools: ['Bash'], ts: '2026-08-20T10:00:10.000Z' }),
      makeTurn({ index: 2, role: 'assistant', text: '', tools: ['Read'], ts: '2026-08-20T10:05:00.000Z' }),
    ]
    useStore.setState({
      detail: {
        meta: makeSession({ native: true, mtime: overrides.mtime }),
        turns,
        total: turns.length,
        ...(overrides.context ? { context: overrides.context } : {}),
      },
      active: null,
      nowTick: Date.now(),
      receipts: {
        'f/s1': [{ turnId: 't-r1', verb: 'Brewed', elapsedMs: 86_000, outputTokens: 79_200, ts: Date.parse('2026-08-20T10:00:12.000Z') }],
      },
      // an own receipt ONLY exists if this client witnessed the chat-done —
      // finishTurn registers both at once. With no close, the derived
      // monitor would believe the session "live" (a fresh mtime) and
      // absorb the final streak with its receipt anchored inside.
      turnCloses: { 'f/s1': overrides.mtime },
    })
  }

  it('a receipt anchored mid-streak still paints (it is not lost)', () => {
    seedReceipt({ mtime: Date.parse(T0) })
    render(<Transcript />)
    expect(screen.getByText('Brewed for 1m 26s')).toBeInTheDocument()
    expect(screen.getByText('↓ 79.2k tokens')).toBeInTheDocument()
  })

  it('a NOT-live session with a subagent with no endedAt → the receipt does not say "still running"', () => {
    seedReceipt({ mtime: Date.parse(T0), context: contextWithSubagent }) // a very old mtime: not live
    render(<Transcript />)
    expect(screen.getByText('Brewed for 1m 26s')).toBeInTheDocument()
    expect(screen.queryByText(/still running/)).not.toBeInTheDocument()
  })

  it('the same LIVE session does count the open subagent ("1 still running")', () => {
    seedReceipt({ mtime: Date.now(), context: contextWithSubagent })
    render(<Transcript />)
    expect(screen.getByText(/1 still running/)).toBeInTheDocument()
  })

  // a live NATIVE session with no `active` (a refresh erased the client's
  // memory) and no known close → the JSONL-derived monitor takes over:
  // absorbs the live streak and paints the phase, same as a long-lived
  // external session.
  it("a live native session with no active and no close → the derived monitor paints the in-progress turn's phase", () => {
    resetStore()
    const turns: TurnType[] = [
      makeTurn({ index: 0, role: 'user', text: 'go', ts: T0 }),
      makeTurn({ index: 1, role: 'assistant', text: '', tools: ['Bash'], ts: '2026-08-20T10:00:10.000Z' }),
      makeTurn({ index: 2, role: 'assistant', text: '', tools: ['Read'], ts: '2026-08-20T10:05:00.000Z' }),
    ]
    useStore.setState({
      detail: { meta: makeSession({ native: true, mtime: Date.now() }), turns, total: turns.length },
      active: null,
      nowTick: Date.now(),
    })
    render(<Transcript />)
    expect(screen.getByText(/Running Read…/)).toBeInTheDocument()
  })
})
