// external-status.test.tsx — a state monitor for external sessions:
// deriveExternalState (a pure function) + <ExternalStatus/>'s render
// (✢ phase… (elapsed · tokens) live, ✻ Worked for X when the last exchange
// closes). No stop/esc buttons — it isn't our turn.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import { ExternalStatus, deriveExternalState } from '../src/components/ExternalStatus'
import type { Turn } from '../src/lib/types'

function makeTurn(overrides: Partial<Turn> = {}): Turn {
  return {
    index: 0,
    role: 'assistant',
    text: '',
    tools: [],
    ts: null,
    ...overrides,
  }
}

// jsdom does not implement matchMedia — we stub it so the glyph can be
// tested under reduced-motion. With no stub, the component falls back
// (typeof window.matchMedia !== 'function' → false) — the same behavior as
// tests that don't call it.
function mockMatchMedia(reduced: boolean): void {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: reduced,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  })
}

const T0 = '2026-08-18T10:00:00.000Z'
const T0_MS = Date.parse(T0)
const T1 = '2026-08-18T10:01:00.000Z' // +1m
const T2 = '2026-08-18T10:02:00.000Z' // +2m

describe('deriveExternalState', () => {
  it('with no user turns → null', () => {
    expect(deriveExternalState([makeTurn({ role: 'assistant', text: 'hi' })], true, T0_MS)).toBeNull()
  })

  it("live: the last turn's phase (text) and tokens summed from assistants after the last user turn", () => {
    const turns: Turn[] = [
      makeTurn({ index: 0, role: 'user', text: 'go', ts: T0 }),
      makeTurn({ index: 1, role: 'assistant', tools: ['Bash'], ts: T1, outputTokens: 3000 }),
      makeTurn({ index: 2, role: 'assistant', text: 'done', ts: T2, outputTokens: 4400 }),
    ]
    const state = deriveExternalState(turns, true, Date.parse(T2))
    expect(state).not.toBeNull()
    expect(state!.phase).toBe('Writing…')
    expect(state!.tokens).toBe(7400)
    expect(state!.done).toBe(false)
  })

  it('live with a tools turn last → "Running Bash…"', () => {
    const turns: Turn[] = [
      makeTurn({ index: 0, role: 'user', text: 'go', ts: T0 }),
      makeTurn({ index: 1, role: 'assistant', tools: ['Bash'], ts: T1, outputTokens: 3000 }),
    ]
    const state = deriveExternalState(turns, true, Date.parse(T1))
    expect(state!.phase).toBe('Running Bash…')
  })

  it('with no assistant carrying outputTokens, tokens is null', () => {
    const turns: Turn[] = [makeTurn({ index: 0, role: 'user', text: 'go', ts: T0 }), makeTurn({ index: 1, role: 'assistant', tools: ['Bash'], ts: T1 })]
    expect(deriveExternalState(turns, true, Date.parse(T1))!.tokens).toBeNull()
  })

  it("!live → done true with the last exchange's duration (last ts − user ts)", () => {
    const turns: Turn[] = [
      makeTurn({ index: 0, role: 'user', text: 'go', ts: T0 }),
      makeTurn({ index: 1, role: 'assistant', tools: ['Bash'], ts: T1, outputTokens: 3000 }),
      makeTurn({ index: 2, role: 'assistant', text: 'done', ts: T2, outputTokens: 4400 }),
    ]
    const state = deriveExternalState(turns, false, Date.parse(T2))
    expect(state).not.toBeNull()
    expect(state!.done).toBe(true)
    expect(state!.elapsedMs).toBe(Date.parse(T2) - Date.parse(T0)) // 2 minutes
  })

  it('!live with a short exchange (<5s) → null (no notice needed)', () => {
    const turns: Turn[] = [
      makeTurn({ index: 0, role: 'user', text: 'go', ts: T0 }),
      makeTurn({ index: 1, role: 'assistant', text: 'done', ts: '2026-08-18T10:00:02.000Z' }), // +2s
    ]
    expect(deriveExternalState(turns, false, Date.parse(T0))).toBeNull()
  })

  // interSession turns carry role:'user' but are NOT the owner's ask — a
  // peer message landing mid-turn (or after) used to re-anchor
  // startMs/tokens/phase and fabricate durations in "Worked for". External
  // sessions (native:false) are exactly the population where peer-messaging
  // genuinely gets used.
  describe('cross-session messages', () => {
    const T3 = '2026-08-18T10:03:00.000Z'
    const peer = (index: number, ts: string): Turn => makeTurn({ index, role: 'user', text: 'peer coordination message', ts, interSession: { from: 'peer-x' } })

    it('live: a peer after the real ask does NOT re-anchor the start or lose the prior tokens', () => {
      const turns: Turn[] = [
        makeTurn({ index: 0, role: 'user', text: 'go', ts: T0 }),
        makeTurn({ index: 1, role: 'assistant', tools: ['Bash'], ts: T1, outputTokens: 3000 }),
        peer(2, T2),
        makeTurn({ index: 3, role: 'assistant', text: 'done', ts: T3, outputTokens: 4400 }),
      ]
      const state = deriveExternalState(turns, true, Date.parse(T3))
      expect(state).not.toBeNull()
      expect(state!.startMs).toBe(T0_MS) // anchored to the REAL ask, not the peer
      expect(state!.tokens).toBe(7400) // tokens from BEFORE the peer aren't lost
      expect(state!.elapsedMs).toBe(Date.parse(T3) - T0_MS)
    })

    it('closed: "Worked for" measures from the real ask to the last assistant even with a peer in between', () => {
      const turns: Turn[] = [
        makeTurn({ index: 0, role: 'user', text: 'go', ts: T0 }),
        makeTurn({ index: 1, role: 'assistant', tools: ['Bash'], ts: T1, outputTokens: 3000 }),
        peer(2, T2),
        makeTurn({ index: 3, role: 'assistant', text: 'done', ts: T3, outputTokens: 4400 }),
      ]
      const state = deriveExternalState(turns, false, Date.parse(T3))
      expect(state).not.toBeNull()
      expect(state!.done).toBe(true)
      expect(state!.elapsedMs).toBe(Date.parse(T3) - T0_MS) // 3 real minutes, not T3−T2
    })

    it('closed: a peer AFTER the last assistant neither extends nor voids the duration', () => {
      const turns: Turn[] = [
        makeTurn({ index: 0, role: 'user', text: 'go', ts: T0 }),
        makeTurn({ index: 1, role: 'assistant', text: 'done', ts: T1 }),
        peer(2, T3), // arrives 2 minutes after the exchange ended
      ]
      const state = deriveExternalState(turns, false, Date.parse(T3))
      expect(state).not.toBeNull()
      expect(state!.elapsedMs).toBe(Date.parse(T1) - T0_MS) // 1 real minute
    })

    it('only peer turns (no real ask from the owner) → null', () => {
      expect(deriveExternalState([peer(0, T0), makeTurn({ index: 1, role: 'assistant', text: 'ack', ts: T1 })], true, Date.parse(T1))).toBeNull()
    })
  })

  // the last user turn with no ts (a session with no reliable timestamps, or
  // half-summarized) must not break — with no ts there's no "start" for the
  // exchange, so there's nothing to derive.
  it('the last user turn with no ts (ts: null) → null, without breaking', () => {
    const turns: Turn[] = [makeTurn({ index: 0, role: 'user', text: 'go', ts: null }), makeTurn({ index: 1, role: 'assistant', tools: ['Bash'], ts: T1 })]
    expect(deriveExternalState(turns, true, Date.parse(T1))).toBeNull()
    expect(deriveExternalState(turns, false, Date.parse(T1))).toBeNull()
  })
})

describe('ExternalStatus (render)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(T1)) // "now" starts right when the last tool began
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  // the user turn's ts = the mount's "now" (T1): the elapsed starts at 0 and
  // only crosses the 5s threshold at 6s of advancing the fake clock.
  it('live: the elapsed does not appear before 5s; after 6s it appears next to the tokens', () => {
    const turns: Turn[] = [
      makeTurn({ index: 0, role: 'user', text: 'go', ts: T1 }), // ts = the mount's "now"
      makeTurn({ index: 1, role: 'assistant', tools: ['Bash'], ts: T1, outputTokens: 7400 }),
    ]
    render(<ExternalStatus turns={turns} live={true} />)
    expect(screen.getByText('Running Bash…')).toBeInTheDocument()
    expect(screen.getByText(/↓ 7\.4k tokens/)).toBeInTheDocument()
    expect(screen.queryByText(/\(6s/)).not.toBeInTheDocument()

    act(() => {
      vi.advanceTimersByTime(6000)
    })
    expect(screen.getByText(/\(6s · ↓ 7\.4k tokens\)/)).toBeInTheDocument()
  })

  it('live with no tokens: does not show the tokens indicator', () => {
    const turns: Turn[] = [makeTurn({ index: 0, role: 'user', text: 'go', ts: T1 }), makeTurn({ index: 1, role: 'assistant', tools: ['Bash'], ts: T1 })]
    render(<ExternalStatus turns={turns} live={true} />)
    expect(screen.queryByText(/↓/)).not.toBeInTheDocument()
  })

  it('done: shows "Worked for" with the last exchange\'s fixed duration', () => {
    const turns: Turn[] = [makeTurn({ index: 0, role: 'user', text: 'go', ts: T0 }), makeTurn({ index: 1, role: 'assistant', text: 'done', ts: T2 })]
    render(<ExternalStatus turns={turns} live={false} />)
    expect(screen.getByText(/Worked for/)).toBeInTheDocument()
    expect(screen.getByText(/Worked for 2m 0s/)).toBeInTheDocument()
  })

  // the context-% gauge — the same % as StatusLine, derived from
  // meta.contextTokens/meta.model (passed here as flat props).
  it('with a known contextTokens, shows the same context % as StatusLine', () => {
    const turns: Turn[] = [
      makeTurn({ index: 0, role: 'user', text: 'go', ts: T1 }),
      makeTurn({ index: 1, role: 'assistant', tools: ['Bash'], ts: T1, outputTokens: 7400 }),
    ]
    render(<ExternalStatus turns={turns} live={true} contextTokens={108_656} />)
    expect(screen.getByText('54% context')).toBeInTheDocument()
  })

  // the % needs the model's window size, which OpenCode does not
  // report — the only honest value is none, even with tokens in hand.
  it('an OpenCode session never shows a context %, even with contextTokens; Claude with the same tokens does', () => {
    const turns: Turn[] = [makeTurn({ index: 0, role: 'user', text: 'go', ts: T1 }), makeTurn({ index: 1, role: 'assistant', tools: ['Bash'], ts: T1 })]
    const oc = render(<ExternalStatus turns={turns} live={true} contextTokens={15_737} harness="opencode" />)
    expect(oc.container.textContent).not.toContain('%')
    oc.unmount()
    const cc = render(<ExternalStatus turns={turns} live={true} contextTokens={15_737} />)
    expect(cc.container.textContent).toMatch(/\d+% context/)
  })

  it('with no contextTokens, the context % indicator does not show', () => {
    const turns: Turn[] = [makeTurn({ index: 0, role: 'user', text: 'go', ts: T1 }), makeTurn({ index: 1, role: 'assistant', tools: ['Bash'], ts: T1 })]
    render(<ExternalStatus turns={turns} live={true} />)
    expect(screen.queryByText(/% context/)).not.toBeInTheDocument()
  })

  it('done: also shows the context % when known', () => {
    const turns: Turn[] = [makeTurn({ index: 0, role: 'user', text: 'go', ts: T0 }), makeTurn({ index: 1, role: 'assistant', text: 'done', ts: T2 })]
    render(<ExternalStatus turns={turns} live={false} contextTokens={190_000} />)
    expect(screen.getByText(/Worked for/)).toBeInTheDocument()
    expect(screen.getByText(/95%/)).toBeInTheDocument()
  })

  it('with no user turn, renders nothing', () => {
    const { container } = render(<ExternalStatus turns={[makeTurn({ role: 'assistant', text: 'x' })]} live={true} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('clears the interval on unmount while live', () => {
    const turns: Turn[] = [makeTurn({ index: 0, role: 'user', text: 'go', ts: T0 })]
    const { unmount } = render(<ExternalStatus turns={turns} live={true} />)
    const pendingBefore = vi.getTimerCount()
    unmount()
    expect(vi.getTimerCount()).toBeLessThan(pendingBefore)
  })
})

// the glyph rotates ✢ → ✻ → ✽ on the existing 1s tick, and stays fixed on ✢
// under prefers-reduced-motion. matchMedia is queried ONCE on mount (not
// reactive to a live preference change, same as the rest of the app — see
// main.tsx).
//
// the Unicode characters were replaced by an inline SVG (see
// ExternalStatus.tsx) — these tests no longer look up the character by text
// (tofu in headless Chromium with no font, zero guarantee in jsdom either),
// but the index exposed in the wrapper <span aria-hidden>'s data-glyph.
//
// an external queue: meta.queue (SessionView.queue) arrives here as a flat
// `queue` prop, the same criterion as contextTokens/model. A visual sibling
// of the queue chips but NOT operable: no remove button, no terracotta — it's
// another turn's queue, not ours.
describe('ExternalStatus — an external queue', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(T1))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('with a queue, shows "Queued: N" and one chip per item, in order', () => {
    const turns: Turn[] = [
      makeTurn({ index: 0, role: 'user', text: 'go', ts: T1 }),
      makeTurn({ index: 1, role: 'assistant', tools: ['Bash'], ts: T1, outputTokens: 7400 }),
    ]
    const { container } = render(<ExternalStatus turns={turns} live={true} queue={['message one', 'two']} />)
    expect(screen.getByText('Queued: 2')).toBeInTheDocument()
    const chips = container.querySelectorAll('[data-queue-item]')
    expect(chips).toHaveLength(2)
    expect(chips[0]?.textContent).toBe('message one')
    expect(chips[1]?.textContent).toBe('two')
  })

  it('a long item truncates visually to 60 chars, with the full text in the title', () => {
    const turns: Turn[] = [
      makeTurn({ index: 0, role: 'user', text: 'go', ts: T1 }),
      makeTurn({ index: 1, role: 'assistant', tools: ['Bash'], ts: T1, outputTokens: 7400 }),
    ]
    const long = 'a'.repeat(80)
    const { container } = render(<ExternalStatus turns={turns} live={true} queue={[long]} />)
    const chip = container.querySelector('[data-queue-item]')
    expect(chip?.textContent).toBe(`${long.slice(0, 60)}…`)
    expect(chip).toHaveAttribute('title', long)
  })

  it('a short item (<=60 chars) does not truncate, and the title carries the same text', () => {
    const turns: Turn[] = [
      makeTurn({ index: 0, role: 'user', text: 'go', ts: T1 }),
      makeTurn({ index: 1, role: 'assistant', tools: ['Bash'], ts: T1, outputTokens: 7400 }),
    ]
    const { container } = render(<ExternalStatus turns={turns} live={true} queue={['short']} />)
    const chip = container.querySelector('[data-queue-item]')
    expect(chip?.textContent).toBe('short')
    expect(chip).toHaveAttribute('title', 'short')
  })

  it('with no queue, no "Queued" and no chips appear', () => {
    const turns: Turn[] = [
      makeTurn({ index: 0, role: 'user', text: 'go', ts: T1 }),
      makeTurn({ index: 1, role: 'assistant', tools: ['Bash'], ts: T1, outputTokens: 7400 }),
    ]
    const { container } = render(<ExternalStatus turns={turns} live={true} />)
    expect(screen.queryByText(/Queued/)).not.toBeInTheDocument()
    expect(container.querySelectorAll('[data-queue-item]')).toHaveLength(0)
  })

  it('with an empty queue ([]), no "Queued" and no chips appear', () => {
    const turns: Turn[] = [
      makeTurn({ index: 0, role: 'user', text: 'go', ts: T1 }),
      makeTurn({ index: 1, role: 'assistant', tools: ['Bash'], ts: T1, outputTokens: 7400 }),
    ]
    const { container } = render(<ExternalStatus turns={turns} live={true} queue={[]} />)
    expect(screen.queryByText(/Queued/)).not.toBeInTheDocument()
    expect(container.querySelectorAll('[data-queue-item]')).toHaveLength(0)
  })

  it('the "done" state also shows the queue if it arrives', () => {
    const turns: Turn[] = [makeTurn({ index: 0, role: 'user', text: 'go', ts: T0 }), makeTurn({ index: 1, role: 'assistant', text: 'done', ts: T2 })]
    render(<ExternalStatus turns={turns} live={false} queue={['pending']} />)
    expect(screen.getByText(/Worked for/)).toBeInTheDocument()
    expect(screen.getByText('Queued: 1')).toBeInTheDocument()
  })
})

describe('ExternalStatus — the rotating glyph', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(T1))
  })

  afterEach(() => {
    vi.useRealTimers()
    // @ts-expect-error — clear the stub so it doesn't leak into other tests
    delete window.matchMedia
  })

  it('rotates the glyph 0 → 1 → 2 → 0 on each 1s tick (SVG, no font dependency)', () => {
    mockMatchMedia(false)
    const turns: Turn[] = [makeTurn({ index: 0, role: 'user', text: 'go', ts: T1 })]
    const { container } = render(<ExternalStatus turns={turns} live={true} />)

    expect(container.querySelector('[data-glyph="0"]')).toBeInTheDocument()

    act(() => {
      vi.advanceTimersByTime(1000)
    })
    expect(container.querySelector('[data-glyph="1"]')).toBeInTheDocument()

    act(() => {
      vi.advanceTimersByTime(1000)
    })
    expect(container.querySelector('[data-glyph="2"]')).toBeInTheDocument()

    act(() => {
      vi.advanceTimersByTime(1000)
    })
    expect(container.querySelector('[data-glyph="0"]')).toBeInTheDocument()
  })

  it('with prefers-reduced-motion, the glyph stays fixed at index 0', () => {
    mockMatchMedia(true)
    const turns: Turn[] = [makeTurn({ index: 0, role: 'user', text: 'go', ts: T1 })]
    const { container } = render(<ExternalStatus turns={turns} live={true} />)

    expect(container.querySelector('[data-glyph="0"]')).toBeInTheDocument()

    act(() => {
      vi.advanceTimersByTime(3000)
    })
    expect(container.querySelector('[data-glyph="0"]')).toBeInTheDocument()
    expect(container.querySelector('[data-glyph="1"]')).not.toBeInTheDocument()
    expect(container.querySelector('[data-glyph="2"]')).not.toBeInTheDocument()
  })

  it('the "done" state uses the same SVG (glyph index 1, static)', () => {
    const turns: Turn[] = [makeTurn({ index: 0, role: 'user', text: 'go', ts: T0 }), makeTurn({ index: 1, role: 'assistant', text: 'done', ts: T2 })]
    const { container } = render(<ExternalStatus turns={turns} live={false} />)
    expect(container.querySelector('[data-glyph="1"]')).toBeInTheDocument()
    expect(screen.getByText(/Worked for 2m 0s/)).toBeInTheDocument()
  })
})

// the CLI closes practically EVERY turn with a system/turn_duration marker,
// so in a finished CLI session the last turn is almost always the marker.
// The monitor can only suppress "Worked for" when that inline receipt is
// genuinely VISIBLE (>= 5s), and the context % is never suppressed: it's a
// snapshot of the session, not of the exchange.
describe("ExternalStatus — the CLI's inline receipt", () => {
  const turns = (durationMs: number): Turn[] => [
    makeTurn({ index: 0, role: 'user', text: 'go', ts: T0 }),
    makeTurn({ index: 1, role: 'assistant', text: 'done', ts: T1 }),
    makeTurn({ index: 2, role: 'assistant', text: '', ts: T1, durationMs }),
  ]

  it('a final marker >= 5s: no duplicated "Worked for", but the context % ALWAYS shows', () => {
    render(<ExternalStatus turns={turns(60_000)} live={false} contextTokens={156_000} />)
    expect(screen.queryByText(/Worked for/)).not.toBeInTheDocument()
    expect(screen.getByText('78% context')).toBeInTheDocument()
  })

  it('a final marker < 5s (the historic receipt paints nothing): the monitor\'s "Worked for" is the only one and is NOT suppressed', () => {
    render(<ExternalStatus turns={turns(3000)} live={false} contextTokens={156_000} />)
    expect(screen.getByText(/Worked for 1m 0s/)).toBeInTheDocument()
    expect(screen.getByText('78% context')).toBeInTheDocument()
  })

  it('a final marker >= 5s with no contextTokens: no empty row is left (just the queue, if any)', () => {
    const { container } = render(<ExternalStatus turns={turns(60_000)} live={false} />)
    expect(screen.queryByText(/Worked for/)).not.toBeInTheDocument()
    expect(container.querySelector('[data-glyph]')).not.toBeInTheDocument()
  })

  // a peer (interSession) landing AFTER the real marker used to make this
  // check read the peer as the last turn (durationMs undefined) →
  // duplicated "Worked for" over the inline receipt already visible a few
  // lines up in the same transcript. The check must look at the same
  // filtered view (no peers) as deriveExternalState.
  it('a final marker >= 5s with a peer AFTER it: the inline receipt still counts — no duplicated "Worked for"', () => {
    const withPeer: Turn[] = [
      ...turns(60_000),
      makeTurn({ index: 3, role: 'user', text: 'peer coordination message', ts: T2, interSession: { from: 'peer-x' } }),
    ]
    render(<ExternalStatus turns={withPeer} live={false} contextTokens={156_000} />)
    expect(screen.queryByText(/Worked for/)).not.toBeInTheDocument() // one sentence: the transcript's inline one
    expect(screen.getByText('78% context')).toBeInTheDocument() // the gauge is never suppressed
  })

  // the monitor also covers NATIVE sessions with no `active` — when THIS
  // client did witness the chat-done, its own inline receipt ("Brewed for
  // X") already covers the close and the monitor's "Worked for" is
  // suppressed the same as with the CLI's marker. A receipt from an
  // EARLIER exchange does not count.
  const noMarker: Turn[] = [makeTurn({ index: 0, role: 'user', text: 'go', ts: T0 }), makeTurn({ index: 1, role: 'assistant', text: 'done', ts: T1 })]

  it('an own receipt for the current exchange (ts >= the user turn): no duplicated "Worked for"', () => {
    render(<ExternalStatus turns={noMarker} live={false} contextTokens={156_000} ownReceiptTs={Date.parse(T1)} />)
    expect(screen.queryByText(/Worked for/)).not.toBeInTheDocument()
    expect(screen.getByText('78% context')).toBeInTheDocument()
  })

  it('an OLD own receipt (before the last exchange\'s user turn): the monitor\'s "Worked for" DOES show', () => {
    render(<ExternalStatus turns={noMarker} live={false} ownReceiptTs={T0_MS - 60_000} />)
    expect(screen.getByText(/Worked for 1m 0s/)).toBeInTheDocument()
  })
})
