// live.test.ts — isLive is the client's single source of truth for
// "live". It must match the server's semantics EXACTLY
// (server/src/server.ts: `live: now - m.mtime < liveMs`) so they don't
// diverge: a diff strictly less than LIVE_MS is live; on the edge (diff
// === LIVE_MS) it no longer is.
import { describe, expect, it } from 'vitest'
import {
  agentAtWork,
  backgroundWorking,
  CLOSE_MARGIN_MS,
  closedByClient,
  isLive,
  LIVE_MS,
  TOOL_MAX_MS,
  lastTurnClosed,
  sessionSignal,
  SHELL_MAX_MS,
} from '../src/lib/live'

describe('isLive', () => {
  it('diff 0 (mtime === now) is live', () => {
    expect(isLive(1000, 1000)).toBe(true)
  })

  it('just under LIVE_MS is still live', () => {
    expect(isLive(0, LIVE_MS - 1)).toBe(true)
  })

  it('exactly at LIVE_MS is NO longer live (an exclusive edge, same as the server)', () => {
    expect(isLive(0, LIVE_MS)).toBe(false)
  })

  it('well past LIVE_MS is not live', () => {
    expect(isLive(0, LIVE_MS + 60_000)).toBe(false)
  })
})

// Working ≠ live: real signals of a closed turn — the CLI's turn_duration
// marker and a chat-done this client witnessed.
describe('lastTurnClosed', () => {
  it('with no turns (or detail not loaded yet) there is no close to assert', () => {
    expect(lastTurnClosed(undefined)).toBe(false)
    expect(lastTurnClosed([])).toBe(false)
  })

  it('last turn = a receipt marker (durationMs) → closed', () => {
    expect(lastTurnClosed([{}, { durationMs: 3200 }])).toBe(true)
  })

  it('last turn with neither durationMs nor turnEnded (a half-finished turn) → not closed', () => {
    expect(lastTurnClosed([{ durationMs: 3200 }, {}])).toBe(false)
  })

  it('last turn with turnEnded (stop_reason end_turn, SDK sessions) → closed', () => {
    expect(lastTurnClosed([{}, { turnEnded: true }])).toBe(true)
  })

  it('a synthetic notice behind the real close does not hide it', () => {
    expect(lastTurnClosed([{ turnEnded: true }, { synthetic: true }])).toBe(true)
  })

  it('only synthetic entries (or an empty list after skipping them) → not closed', () => {
    expect(lastTurnClosed([{ synthetic: true }])).toBe(false)
  })
})

describe('closedByClient', () => {
  it('with no recorded close for the session, asserts nothing', () => {
    expect(closedByClient(undefined, 1000)).toBe(false)
  })

  it('mtime within the margin after the close → closed (the chat-done refetch settles mtime ≈ close)', () => {
    expect(closedByClient(10_000, 10_000 + CLOSE_MARGIN_MS)).toBe(true)
  })

  it('new content past the margin → someone wrote again, the close stops counting', () => {
    expect(closedByClient(10_000, 10_000 + CLOSE_MARGIN_MS + 1)).toBe(false)
  })
})

describe('sessionSignal', () => {
  const NOW = 1_700_000_000_000
  it("'working' (blinking) when it's the agent's turn and there's live activity", () => {
    expect(sessionSignal({ mtime: NOW - 1000, lastRole: 'user', unread: false }, NOW, false)).toBe('working')
  })
  it("no 'working' once the activity goes cold, even if it's still the agent's turn", () => {
    expect(sessionSignal({ mtime: NOW - LIVE_MS - 1, lastRole: 'user', unread: false }, NOW, false)).toBeNull()
  })
  it("'attention' (solid) when the durable unread says the agent replied and you haven't looked", () => {
    expect(sessionSignal({ mtime: NOW - 3_600_000, lastRole: 'assistant', unread: true }, NOW, false)).toBe('attention')
  })
  it("'working' beats 'attention': a live agent turn blinks even with unread pending", () => {
    expect(sessionSignal({ mtime: NOW - 1000, lastRole: 'user', unread: true }, NOW, false)).toBe('working')
  })
  it("…and once the activity goes cold, the pending unread shows as 'attention' again", () => {
    expect(sessionSignal({ mtime: NOW - LIVE_MS - 1, lastRole: 'user', unread: true }, NOW, false)).toBe('attention')
  })
  it("'working' while the turn is still OPEN even if the agent already wrote intermediate messages (turnOpen wins over lastRole)", () => {
    // mid-turn the agent's tool calls set lastRole 'assistant' and the durable
    // unread lights up — the blink stays on for as long as it's working.
    expect(sessionSignal({ mtime: NOW - 1000, lastRole: 'assistant', unread: true, turnOpen: true }, NOW, false)).toBe('working')
  })
  it('a CLOSED turn (turnOpen false) never blinks, whatever lastRole says', () => {
    expect(sessionSignal({ mtime: NOW - 1000, lastRole: 'user', unread: false, turnOpen: false }, NOW, false)).toBeNull()
    expect(sessionSignal({ mtime: NOW - 1000, lastRole: 'assistant', unread: true, turnOpen: false }, NOW, false)).toBe('attention')
  })
  it("'working' with NO live activity while a tool is in flight (a long Bash writes nothing until it ends)", () => {
    expect(
      sessionSignal({ mtime: NOW - LIVE_MS - 60_000, lastRole: 'assistant', unread: true, turnOpen: true, toolSince: NOW - LIVE_MS - 60_000 }, NOW, false),
    ).toBe('working')
  })
  it('…but a tool "in flight" for longer than TOOL_MAX_MS is a dead session, not a working one', () => {
    expect(
      sessionSignal({ mtime: NOW - TOOL_MAX_MS - 1, lastRole: 'assistant', unread: true, turnOpen: true, toolSince: NOW - TOOL_MAX_MS - 1 }, NOW, false),
    ).toBe('attention')
  })
  it('a tool in flight never keeps a CLOSED turn working', () => {
    expect(sessionSignal({ mtime: NOW - LIVE_MS - 1, lastRole: 'assistant', unread: false, turnOpen: false, toolSince: NOW - 1000 }, NOW, false)).toBeNull()
  })
  it("a CLOSED turn blinks while a BACKGROUND agent's transcript is fresh (the Agent tool spawns detached and ends the turn)", () => {
    expect(sessionSignal({ mtime: NOW - LIVE_MS - 1, lastRole: 'assistant', unread: true, turnOpen: false, subMtime: NOW - 1000 }, NOW, false)).toBe('working')
  })
  it('…and once the background agent goes quiet past LIVE_MS, the dot falls back to attention/idle (a stale subagents dir is history, not work)', () => {
    expect(sessionSignal({ mtime: NOW - LIVE_MS - 1, lastRole: 'assistant', unread: true, turnOpen: false, subMtime: NOW - LIVE_MS - 1 }, NOW, false)).toBe(
      'attention',
    )
    expect(
      sessionSignal({ mtime: NOW - LIVE_MS - 1, lastRole: 'assistant', unread: false, turnOpen: false, subMtime: NOW - LIVE_MS - 1 }, NOW, false),
    ).toBeNull()
  })
  // a background subagent inside a long tool writes nothing — the same
  // bound as the main turn's toolSince keeps the blink (backgroundWorking)
  it('a CLOSED turn blinks while a background command it launched is awaited (shellSince), not past its bound', () => {
    const quiet = { mtime: NOW - 3 * 3600_000, turnOpen: false, lastRole: 'assistant' as const }
    expect(sessionSignal({ ...quiet, shellSince: NOW - 10 * 60_000 }, NOW, false)).toBe('working')
    expect(sessionSignal({ ...quiet, shellSince: NOW - SHELL_MAX_MS - 1 }, NOW, false)).not.toBe('working')
  })
  it('a CLOSED turn blinks while a background agent is silent 5 min INSIDE a tool (subToolSince), not past the bound', () => {
    const quiet = { mtime: NOW - 20 * 60_000, lastRole: 'assistant' as const, unread: true, turnOpen: false, subMtime: NOW - 5 * 60_000 }
    expect(sessionSignal({ ...quiet, subToolSince: NOW - 5 * 60_000 }, NOW, false)).toBe('working')
    expect(sessionSignal(quiet, NOW, false)).toBe('attention')
    expect(sessionSignal({ ...quiet, subToolSince: NOW - TOOL_MAX_MS - 1 }, NOW, false)).toBe('attention')
    expect(sessionSignal({ ...quiet, pendingAsk: true, subToolSince: NOW - 1000 }, NOW, false)).toBe('attention')
  })
  it('agentAtWork (a census row): it writes, or a tool of its runs within the bound', () => {
    expect(agentAtWork({ mtime: NOW - 10_000 }, NOW)).toBe(true)
    expect(agentAtWork({ mtime: NOW - 5 * 60_000, toolSince: NOW - 5 * 60_000 }, NOW)).toBe(true)
    expect(agentAtWork({ mtime: NOW - 5 * 60_000 }, NOW)).toBe(false)
    expect(agentAtWork({ mtime: NOW - 5 * 60_000, toolSince: NOW - TOOL_MAX_MS }, NOW)).toBe(false)
    expect(backgroundWorking({ subMtime: NOW - 5 * 60_000, subToolSince: NOW - 5 * 60_000 }, NOW)).toBe(true)
    expect(backgroundWorking({ subMtime: NOW - 5 * 60_000 }, NOW)).toBe(false)
  })
  it('pendingAsk still beats a working background agent — the main agent waits on you', () => {
    expect(sessionSignal({ mtime: NOW - 1000, lastRole: 'assistant', turnOpen: false, pendingAsk: true, subMtime: NOW - 1000 }, NOW, false)).toBe('attention')
  })

  it('nothing when the reply was already seen', () => {
    expect(sessionSignal({ mtime: NOW - 1000, lastRole: 'assistant', unread: false }, NOW, false)).toBeNull()
  })
  it('the OPEN conversation never shows a dot, whatever its state', () => {
    expect(sessionSignal({ mtime: NOW, lastRole: 'user', unread: false }, NOW, true)).toBeNull()
    expect(sessionSignal({ mtime: NOW, lastRole: 'assistant', unread: true }, NOW, true)).toBeNull()
  })
  it('an open AskUserQuestion (pendingAsk) goes solid even mid-turn — the agent waits on you', () => {
    expect(sessionSignal({ mtime: NOW, lastRole: 'user', turnOpen: true, pendingAsk: true }, NOW, false)).toBe('attention')
    expect(sessionSignal({ mtime: NOW, lastRole: 'user', turnOpen: true, pendingAsk: true }, NOW, true)).toBeNull()
  })

  it('a session with no real turn yet (no lastRole) shows nothing', () => {
    expect(sessionSignal({ mtime: NOW }, NOW, false)).toBeNull()
  })
})
