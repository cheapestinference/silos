// live.ts — client-side derivation of a session's "live" state.
//
// Root cause of the erratic "live" state reported by users: `live`/`liveCount`
// used to get computed server-side at snapshot time (server/src/server.ts,
// view()) and the client painted them as static — a badge stayed zombie
// (lit) until the next WS event for THAT specific session, which could
// take minutes, and it could also flicker when crossing the LIVE_MS window
// with no event arriving to trigger a re-render.
//
// Fix: the client derives `live` from `mtime` + its own clock (`ahoraTick`
// in the store), with the SAME semantics as the server so they don't
// diverge: `now - mtime < liveMs` (server.ts). The `live`/`liveCount`
// field the server sends is kept in the types (compat/public API) but the
// client stops reading it for render — only isLive(mtime, ahoraTick) matters.
export const LIVE_MS = 120_000

export function isLive(mtime: number, now: number): boolean {
  return now - mtime < LIVE_MS
}

// --- Working != live -------------------------------------------------------
//
// "live" (sidebar) = recent activity, a coarse signal. "Working"
// (ContextColumn) = a turn ACTUALLY in progress, a fine signal. They used
// to both be mtime < LIVE_MS and a session would say "Working" for up to 2
// min after its turn ended. Real closing signals, in order of preference
// (derive, never simulate):
//  1. the system/turn_duration marker the CLI harness writes when it
//     closes each turn — if the last parsed turn is that receipt, the turn
//     is CLOSED (only the "cli" entrypoint; SDK sessions don't carry it).
//  2. turnEnded: message.stop_reason === "end_turn" on the turn's FINAL
//     message — intermediate ones (including text between tools) carry
//     "tool_use", so there are no false closes mid-turn. Covers SDK
//     sessions, which don't write turn_duration (parser.ts emits it).
//  3. the close THIS client witnessed (chat-done -> store.turnCloses), for
//     turns launched from Silos itself.
// With none of the three (e.g. a turn interrupted halfway): the original
// behavior — Working while live.

// a margin to compare the close the client saw (its local clock) against
// the server's content mtime: chat-done's refetch settles mtime ~= now;
// content activity after this slack means SOMEONE wrote again (a drained
// queue, an external turn) and the close stops counting.
export const CLOSE_MARGIN_MS = 5_000

export function lastTurnClosed(turns: readonly { durationMs?: number; turnEnded?: boolean; synthetic?: boolean }[] | undefined): boolean {
  if (!turns) return false
  // synthetic harness notices (rate limit, API error) can land AFTER the
  // real close — they aren't turn activity, so they get skipped.
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i]!
    if (t.synthetic) continue
    return t.durationMs !== undefined || t.turnEnded === true
  }
  return false
}

export function closedByClient(closedAt: number | undefined, mtime: number): boolean {
  return closedAt !== undefined && mtime <= closedAt + CLOSE_MARGIN_MS
}

// --- the conversation dot (sidebar rows) ------------------------------------
//
// ONE terracotta dot per conversation row, two states:
//  - 'working': blinking — the agent's turn is still OPEN (turnOpen from
//    the server; lastRole 'user' as fallback for old metas) AND there's
//    recent activity (isLive): it's writing right now. Intermediate
//    assistant messages (tool calls) don't end the blink.
//    A BACKGROUND agent blinks too: the Agent tool spawns detached and
//    CLOSES the main turn, but its transcript keeps moving — fresh
//    subMtime (from the server's subagents-dir poll) means someone still
//    works for this conversation. A background agent silent
//    inside a long tool of its own keeps the blink too (subToolSince, the
//    same bound as the main turn's toolSince — otherwise a test suite in a
//    subagent read as waiting on the owner).
//  - 'attention': solid — the agent replied and you haven't looked since
//    (the DURABLE unread from the server, unread.ts: survives reloads and
//    closing the laptop; opening the conversation clears it).
//  - null: up to date, or idle — nothing to say.
// The OPEN conversation never shows a dot: you're looking at it (the same
// suppression the sidebar's unread counters apply).
export type SessionSignal = 'working' | 'attention' | null

// A tool in flight (open turn, tool_use with no result yet) counts as
// working even with no activity — a 5-minute Bash writes nothing until it
// returns — but not forever: past this, the session is dead, not busy.
export const TOOL_MAX_MS = 30 * 60_000

// ── the ONE rule (server twin: server/src/work-live.ts) ──────────────────
// Work a conversation started is live while it WRITES (isLive) or has a TOOL
// IN FLIGHT (toolOpen, bounded by TOOL_MAX_MS) — the main turn, a subagent at
// any depth, a workflow agent, a resumed subagent alike. Every surface that
// asks «is it working?» goes through these, never through a bare isLive.
export function toolOpen(since: number | undefined, now: number): boolean {
  return since !== undefined && since > 0 && now - since < TOOL_MAX_MS
}

export function toolInFlight(s: { turnOpen?: boolean; toolSince?: number }, now: number): boolean {
  return s.turnOpen === true && toolOpen(s.toolSince, now)
}

// one agent's transcript (a census row, DiskSubagent): writes, or a tool runs
export function agentAtWork(a: { mtime: number; toolSince?: number }, now: number): boolean {
  return isLive(a.mtime, now) || toolOpen(a.toolSince, now)
}

// a conversation's background work (its subagents dir, any depth) is live
// — or a background command it launched and still awaits (shellSince: the
// engine re-opens the conversation when it ends), bounded wider than a tool
export const SHELL_MAX_MS = 2 * 3600_000
export function shellRunning(s: { shellSince?: number }, now: number): boolean {
  return s.shellSince !== undefined && s.shellSince > 0 && now - s.shellSince < SHELL_MAX_MS
}
export function backgroundWorking(s: { subMtime?: number; subToolSince?: number; shellSince?: number }, now: number): boolean {
  return (s.subMtime !== undefined && isLive(s.subMtime, now)) || toolOpen(s.subToolSince, now) || shellRunning(s, now)
}

// working ONLY because a command it launched still runs (turn closed, no
// agent of its own at work): the sidebar's blink slows — it waits on a
// machine, nobody is thinking
export function onlyShellRunning(
  s: { mtime: number; lastRole?: 'user' | 'assistant'; turnOpen?: boolean; toolSince?: number; subMtime?: number; subToolSince?: number; shellSince?: number },
  now: number,
): boolean {
  if (!shellRunning(s, now)) return false
  const agentsTurn = s.turnOpen ?? s.lastRole === 'user'
  return !backgroundWorking({ subMtime: s.subMtime, subToolSince: s.subToolSince }, now) && !(agentsTurn && (isLive(s.mtime, now) || toolInFlight(s, now)))
}

export function sessionSignal(
  s: {
    mtime: number
    unread?: boolean
    lastRole?: 'user' | 'assistant'
    turnOpen?: boolean
    toolSince?: number
    pendingAsk?: boolean
    subMtime?: number
    subToolSince?: number
    shellSince?: number
  },
  now: number,
  open: boolean,
): SessionSignal {
  if (open) return null
  // an OPEN question (AskUserQuestion unanswered) beats the blink: the
  // turn is technically still open, but the agent is waiting on the owner
  // — that's "needs you", solid.
  if (s.pendingAsk === true) return 'attention'
  // Working wins over unread: while the agent is on it,
  // the blink is the truth — the solid "needs you" dot returns when it stops.
  const agentsTurn = s.turnOpen ?? s.lastRole === 'user'
  if (backgroundWorking(s, now) || (agentsTurn && (isLive(s.mtime, now) || toolInFlight(s, now)))) return 'working'
  if (s.unread === true) return 'attention'
  return null
}

// an agent is working when any of its conversations is (the sidebar's blink)
export function agentWorking(agent: { sessions: ReadonlyArray<Parameters<typeof sessionSignal>[0]> }, now: number): boolean {
  return agent.sessions.some((s) => sessionSignal(s, now, false) === 'working')
}

// The parked state, in ONE voice everywhere it is said (the column's status
// line and Home's rows): what the conversation waits on — the kind always,
// the tool's own label when it gave one. H6: two surfaces used to word this
// each their own way, and the column's dangled on an empty label.
export function parkedWords(kind: 'monitor' | 'wakeup' | 'workflow', label: string): string {
  const on = { monitor: 'waiting on a monitor', wakeup: 'waiting for a wakeup', workflow: 'waiting on a workflow' } as const
  const l = label.trim()
  return l !== '' ? `${on[kind]} — ${l}` : on[kind]
}
