// status-line.test.tsx — phaseLabel (a pure phase→text mapping function) and
// <StatusLine/>'s render: a header with NO counter, a step tree with an
// elapsed time per step (≥5s threshold), a footer with total elapsed/tokens/
// an Esc hint, and the stop button (relocated from the Composer).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { ReceiptLine, StatusLine, phaseLabel, formatLongDuration, formatTokens, groupSteps } from '../src/components/StatusLine'
import { PAST_VERBS, THINKING_VERBS, verbForTurn, pastVerbForTurn } from '../src/lib/thinking-verbs'
import { useStore } from '../src/store'
import type { ChatTurnState, ActiveStep, TurnReceipt } from '../src/store'

function makeActive(overrides: Partial<ChatTurnState> = {}): ChatTurnState {
  return {
    turnId: 't1',
    agentId: 'a1',
    text: '',
    tools: [],
    status: 'streaming',
    userText: '',
    thinkingText: '',
    lastEvent: 'init',
    startedAt: Date.now(),
    ...overrides,
  }
}

// formatTokens used to always divide by 1000 (999 → "1.0k", 50 → "0.1k") —
// below 1000 it must show the plain integer, with no "k" suffix.
describe('formatTokens', () => {
  it('999 → "999" (no k suffix)', () => {
    expect(formatTokens(999)).toBe('999')
  })

  it('1000 → "1.0k"', () => {
    expect(formatTokens(1000)).toBe('1.0k')
  })

  it('79200 → "79.2k"', () => {
    expect(formatTokens(79_200)).toBe('79.2k')
  })
})

describe('phaseLabel', () => {
  // waiting phases (init/thinking) no longer say a fixed "Reasoning…" — a
  // verb from the THINKING_VERBS pool, stable per turnId (the text doesn't
  // change within a turn) but different across turns.
  it("lastEvent 'init' → a verb from the pool, ending in …", () => {
    const label = phaseLabel(makeActive({ lastEvent: 'init' }))
    expect(label.endsWith('…')).toBe(true)
    expect(THINKING_VERBS).toContain(label.slice(0, -1))
  })

  it("lastEvent 'thinking' → the same verb as 'init' for the same turnId (stable within the turn)", () => {
    expect(phaseLabel(makeActive({ lastEvent: 'thinking' }))).toBe(phaseLabel(makeActive({ lastEvent: 'init' })))
    expect(phaseLabel(makeActive({ lastEvent: 'thinking' }))).toBe(`${verbForTurn('t1')}…`)
  })

  it('different turnIds can produce different verbs (variety across turns)', () => {
    const verbs = new Set(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((id) => verbForTurn(id)))
    expect(verbs.size).toBeGreaterThan(1)
  })

  it("lastEvent 'delta' → 'Writing…'", () => {
    expect(phaseLabel(makeActive({ lastEvent: 'delta' }))).toBe('Writing…')
  })

  it("lastEvent 'tool' with tools ['Bash','Read'] → 'Running Read…'", () => {
    expect(phaseLabel(makeActive({ lastEvent: 'tool', tools: ['Bash', 'Read'] }))).toBe('Running Read…')
  })

  it("lastEvent 'tool' with no tools → 'Running tool…'", () => {
    expect(phaseLabel(makeActive({ lastEvent: 'tool', tools: [] }))).toBe('Running tool…')
  })
})

describe('StatusLine', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 0, 1, 0, 0, 0))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('renders nothing with no active turn', () => {
    useStore.setState({ active: null })
    const { container } = render(<StatusLine />)
    expect(container).toBeEmptyDOMElement()
  })

  it("shows the current phase's label", () => {
    useStore.setState({ active: makeActive({ lastEvent: 'thinking' }) })
    render(<StatusLine />)
    expect(screen.getByText(`${verbForTurn('t1')}…`)).toBeInTheDocument()
  })

  // a counter next to "Thinking…" for just a few seconds looked odd — the
  // total elapsed (footer) only appears once the turn passes 5s, and the
  // header never carries a counter at all.
  it('at 3s into the turn there is no visible elapsed; at 6s there is (a 5s threshold)', () => {
    useStore.setState({ active: makeActive({ startedAt: Date.now() }) })
    render(<StatusLine />)
    expect(screen.queryByText(/^\d+:\d{2}$/)).not.toBeInTheDocument()

    act(() => {
      vi.advanceTimersByTime(3000)
    })
    expect(screen.queryByText(/^\d+:\d{2}$/)).not.toBeInTheDocument()

    act(() => {
      vi.advanceTimersByTime(3000) // total 6s
    })
    expect(screen.getByText('0:06')).toBeInTheDocument()
  })

  it('the header carries no counter (no elapsed next to the phase)', () => {
    useStore.setState({ active: makeActive({ lastEvent: 'init', startedAt: Date.now() }) })
    render(<StatusLine />)
    expect(screen.getByText(`${verbForTurn('t1')}…`)).toBeInTheDocument()
    expect(screen.queryByText(/^\d+:\d{2}$/)).not.toBeInTheDocument()
  })

  // the widget no longer repeats the agent's name — we're already inside
  // their conversation (identity comes from the seal and the band; the
  // emoji-color experiment was reverted — a fixed terracotta ✻).
  it("the header does NOT show the agent's name", () => {
    useStore.setState({
      agents: [{ id: 'a1', name: 'Ana', emoji: '🧠', folder: '/x', skills: [], sessions: [], liveCount: 0, sessionCount: 0 }],
      active: makeActive({ agentId: 'a1' }),
    })
    render(<StatusLine />)
    expect(screen.queryByText('Ana')).toBeNull()
  })

  it('clears the interval on unmount (no timer leaks)', () => {
    useStore.setState({ active: makeActive() })
    const { unmount } = render(<StatusLine />)
    const pendingBefore = vi.getTimerCount()
    unmount()
    expect(vi.getTimerCount()).toBeLessThan(pendingBefore)
  })

  it('the stop button calls cancel (relocated from the Composer)', () => {
    const cancel = vi.fn().mockResolvedValue(undefined)
    useStore.setState({ active: makeActive(), cancel })
    render(<StatusLine />)
    fireEvent.click(screen.getByLabelText('stop'))
    expect(cancel).toHaveBeenCalled()
  })
})

function makeStep(overrides: Partial<ActiveStep> = {}): ActiveStep {
  return { name: 'general-purpose', isSubagent: true, desc: null, start: Date.now(), end: null, ...overrides }
}

describe('StatusLine — the activity tree', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 0, 1, 0, 0, 0))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('renders a header + an open step + formatted tokens', () => {
    useStore.setState({
      agents: [{ id: 'a1', name: 'Ana', emoji: '🧠', folder: '/x', skills: [], sessions: [], liveCount: 0, sessionCount: 0 }],
      active: makeActive({
        agentId: 'a1',
        outputTokens: 79_200,
        steps: [makeStep({ name: 'general-purpose', desc: 'Reading Composer and Chat.tsx tests' })],
      }),
    })
    render(<StatusLine />)

    expect(screen.getByText(/general-purpose/)).toBeInTheDocument()
    expect(screen.getByText(/Reading Composer and Chat\.tsx tests/)).toBeInTheDocument()
    expect(screen.getByText('↓ 79.2k tokens')).toBeInTheDocument()
  })

  it('with no outputTokens, the tokens indicator does not show', () => {
    useStore.setState({ active: makeActive({ steps: [makeStep()] }) })
    render(<StatusLine />)
    expect(screen.queryByText(/↓/)).not.toBeInTheDocument()
  })

  it('the footer always shows the "esc to interrupt" hint', () => {
    useStore.setState({ active: makeActive() })
    render(<StatusLine />)
    expect(screen.getByText('esc to interrupt')).toBeInTheDocument()
  })

  it('an open step shows no elapsed before 5s, and does from 5s on', () => {
    useStore.setState({
      // startedAt is in the future: the footer's TOTAL elapsed stays hidden
      // (negative) for the whole test — this isolates the assertion to the
      // STEP's own elapsed, which uses its own `start`, not the turn's.
      active: makeActive({ startedAt: Date.now() + 60_000, steps: [makeStep({ start: Date.now() })] }),
    })
    render(<StatusLine />)
    expect(screen.queryByText(/^\d+:\d{2}$/)).not.toBeInTheDocument()

    act(() => {
      vi.advanceTimersByTime(5000)
    })
    expect(screen.getByText('0:05')).toBeInTheDocument()
  })

  // the context-% gauge — next to the tokens, format
  // "↓ 2.0k tokens · 54% context".
  it('with a known contextTokens, the footer shows the context % next to the tokens', () => {
    useStore.setState({ active: makeActive({ outputTokens: 2000, contextTokens: 108_656 }) })
    render(<StatusLine />)
    expect(screen.getByText('↓ 2.0k tokens')).toBeInTheDocument()
    expect(screen.getByText('54% context')).toBeInTheDocument()
  })

  it('an OpenCode conversation never shows a context % (no window size reported); tokens still show', () => {
    useStore.setState({
      active: makeActive({ outputTokens: 2000, contextTokens: 15_737 }),
      detail: {
        meta: {
          id: 's1',
          folder: 'f',
          title: '',
          skills: [],
          cwd: null,
          mtime: 0,
          size: 0,
          turnCount: 0,
          live: true,
          worktree: false,
          native: true,
          agentId: 'a1',
          harness: 'opencode',
        },
        turns: [],
        total: 0,
      },
    })
    const { container } = render(<StatusLine />)
    expect(screen.getByText('↓ 2.0k tokens')).toBeInTheDocument()
    expect(container.textContent).not.toContain('%')
    useStore.setState({ detail: null })
  })

  it('with no contextTokens, the context % indicator does not show', () => {
    useStore.setState({ active: makeActive({ outputTokens: 2000 }) })
    render(<StatusLine />)
    expect(screen.queryByText(/% context/)).not.toBeInTheDocument()
  })

  it('from 80% up, the context % paints amber', () => {
    useStore.setState({ active: makeActive({ contextTokens: 160_000 }) }) // 80%
    render(<StatusLine />)
    expect(screen.getByText('80% context').className).toContain('amber')
  })

  it('from 95% up, the context % paints red', () => {
    useStore.setState({ active: makeActive({ contextTokens: 190_000 }) }) // 95%
    render(<StatusLine />)
    expect(screen.getByText('95% context').className).toContain('red')
  })

  it('below 80%, the context % carries no semantic color (amber/red)', () => {
    useStore.setState({ active: makeActive({ contextTokens: 100_000 }) }) // 50%
    render(<StatusLine />)
    const el = screen.getByText('50% context')
    expect(el.className).not.toContain('amber')
    expect(el.className).not.toContain('red')
  })

  it('a closed step paints with reduced opacity and only the last 3 show', () => {
    const now = Date.now()
    const steps: ActiveStep[] = [
      makeStep({ name: 'step1', end: now - 1 }),
      makeStep({ name: 'step2', end: now - 1 }),
      makeStep({ name: 'step3', end: now - 1 }),
      makeStep({ name: 'step4', end: now - 1 }),
      makeStep({ name: 'step5', end: null }), // the only open one
    ]
    useStore.setState({ active: makeActive({ steps }) })
    render(<StatusLine />)

    expect(screen.queryByText(/step1/)).not.toBeInTheDocument()
    expect(screen.getByText(/step2/)).toBeInTheDocument()
    expect(screen.getByText(/step3/)).toBeInTheDocument()
    expect(screen.getByText(/step4/)).toBeInTheDocument()
    expect(screen.getByText(/step5/)).toBeInTheDocument()
    expect(screen.getByText(/step4/).closest('div')).toHaveClass('opacity-50')
    expect(screen.getByText(/step5/).closest('div')).not.toHaveClass('opacity-50')
  })
})

// the cockpit pass: a fixed terracotta ✻ (reverting the emoji-color
// experiment), past-tense verbs for the receipt and the ReceiptLine.
describe('StatusLine — the live ✻ glyph', () => {
  it('paints the SVG asterisk with the glyph-live animation and terracotta color', () => {
    useStore.setState({ active: makeActive() })
    const { container } = render(<StatusLine />)
    const glyph = container.querySelector('.glyph-live')
    expect(glyph).not.toBeNull()
    expect(glyph!.className).toContain('text-terracotta')
    expect(glyph!.querySelector('svg')).not.toBeNull()
  })
})

describe('thinking-verbs — past-tense forms', () => {
  it('every verb in the pool has a past-tense form, and none end in "ing"', () => {
    for (const v of THINKING_VERBS) {
      const past = PAST_VERBS[v]
      expect(past, v).toBeTruthy()
      expect(past.endsWith('ing'), `${v} → ${past}`).toBe(false)
    }
  })

  it('correct irregulars: Thinking→Thought, Weaving→Wove', () => {
    expect(PAST_VERBS.Thinking).toBe('Thought')
    expect(PAST_VERBS.Weaving).toBe('Wove')
  })

  it('pastVerbForTurn is the past tense of the SAME verb the turn used live', () => {
    for (const id of ['t1', 'abc', 'turn-99']) {
      expect(pastVerbForTurn(id)).toBe(PAST_VERBS[verbForTurn(id)])
    }
  })
})

describe('formatLongDuration', () => {
  it('86s → "1m 26s"; 4297s → "1h 11m 37s"; 12s → "12s"', () => {
    expect(formatLongDuration(86_000)).toBe('1m 26s')
    expect(formatLongDuration(4_297_000)).toBe('1h 11m 37s')
    expect(formatLongDuration(12_000)).toBe('12s')
  })
})

function makeReceipt(overrides: Partial<TurnReceipt> = {}): TurnReceipt {
  return { turnId: 't1', verb: 'Brewed', elapsedMs: 86_000, ts: Date.now(), ...overrides }
}

describe("ReceiptLine (the turn's receipt)", () => {
  it('a failed receipt says "Failed after …" and names the error', () => {
    render(<ReceiptLine receipt={{ turnId: 't', verb: 'Brewed', elapsedMs: 5000, ts: 1, error: 'boom' }} />)
    expect(screen.getByText(/Failed after/)).toBeInTheDocument()
    expect(screen.getByText(/boom/)).toBeInTheDocument()
    // never the success verb — a failed turn didn't "brew"
    expect(screen.queryByText(/Brewed/)).not.toBeInTheDocument()
  })

  it('"<past-tense verb> for <duration>" with tokens when known', () => {
    render(<ReceiptLine receipt={makeReceipt({ outputTokens: 79_200 })} />)
    expect(screen.getByText(/1m 26s/)).toBeInTheDocument()
    expect(screen.getByText(/79\.2k/)).toBeInTheDocument()
  })

  it('with no outputTokens there is no tokens indicator', () => {
    render(<ReceiptLine receipt={makeReceipt()} />)
    expect(screen.queryByText(/↓/)).not.toBeInTheDocument()
  })

  it('with live background work adds "· N still running"; with 0, it doesn\'t', () => {
    const { rerender } = render(<ReceiptLine receipt={makeReceipt()} stillRunning={2} />)
    expect(screen.getByText('2 still running')).toBeInTheDocument()
    rerender(<ReceiptLine receipt={makeReceipt()} stillRunning={0} />)
    expect(screen.queryByText(/still running/)).not.toBeInTheDocument()
  })
})

describe('groupSteps', () => {
  const step = (name: string, desc: string | null, end: number | null = 1): ActiveStep => ({ name, isSubagent: false, desc, start: 0, end })
  it('folds consecutive calls of one tool into one row carrying the latest description', () => {
    const g = groupSteps([step('Bash', 'a'), step('Bash', 'b'), step('Bash', null, null), step('Read', 'x'), step('Bash', 'c', null)])
    expect(g.map((x) => [x.step.name, x.count, x.step.desc])).toEqual([
      ['Bash', 3, 'b'],
      ['Read', 1, 'x'],
      ['Bash', 1, 'c'],
    ])
    expect(g[0]!.step.end).toBeNull() // the run is open while its latest call is
  })

  it('keeps only the last rows', () => {
    const names = ['A', 'B', 'C', 'D', 'E', 'F']
    expect(groupSteps(names.map((n) => step(n, null))).map((x) => x.step.name)).toEqual(['C', 'D', 'E', 'F'])
  })
})
