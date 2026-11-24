// work-live.ts — the ONE rule for «is this conversation working?» (server
// side; the web's twin is web/src/lib/live.ts, the same words):
//
//   Work a conversation started is live while it WRITES (activity within
//   liveMs) OR has a TOOL IN FLIGHT (a tool_use with no result yet), the
//   tool bounded by TOOL_MAX_MS — past it the work is dead, not busy.
//
// It holds for the main turn (its turn open, toolSince) and for the
// background work the turn left behind: its subagents at any depth, the
// workflow agents and a resumed subagent (subMtime = the newest write
// under <session>/subagents/, subToolSince = the newest tool still in
// flight there — the reader computes both, harnesses/claude-code/reader.ts).
// A subagent running a long command writes NOTHING until it returns (180 s
// silences measured on a real test-suite run), so «wrote lately» alone read
// the conversation as idle mid-work.
//
// Every server surface that asks goes through here: the execution block
// (silos/executions.ts), a task's «is working on it now» and the kernel's
// stalls (conversation-live.ts), Task mode's busy check (index.ts busyWhy),
// the board cards (board.ts), the Map's live counts and a claim's «others».

// A tool in flight counts as work even with nothing written — a long command
// writes nothing until it returns — but not forever.
export const TOOL_MAX_MS = 30 * 60_000
// A background command the conversation launched and awaits (the engine
// re-opens it when the command ends) is work with the turn CLOSED.
// Its end is a notification that may never come — the engine died,
// a server left running on purpose — so it is bounded too, wider: a suite
// or a build runs for minutes, rarely hours.
export const SHELL_MAX_MS = 2 * 3600_000

export interface WorkSignals {
  mtime: number
  turnOpen?: boolean
  lastRole?: 'user' | 'assistant'
  toolSince?: number
  subMtime?: number
  subToolSince?: number
  shellSince?: number
  pendingAsk?: boolean
}

/** A tool started at `since` is still in flight within the bound. */
export function toolOpen(since: number | undefined, now: number): boolean {
  return since !== undefined && since > 0 && now - since < TOOL_MAX_MS
}

/** One agent's transcript (a census row): it writes, or a tool of its runs. */
export function agentAtWork(a: { mtime: number; toolSince?: number }, now: number, liveMs: number): boolean {
  return now - a.mtime < liveMs || toolOpen(a.toolSince, now)
}

/** The background work of a conversation (its subagents, any depth) is live. */
export function backgroundAtWork(s: Pick<WorkSignals, 'subMtime' | 'subToolSince'>, now: number, liveMs: number): boolean {
  return (s.subMtime !== undefined && now - s.subMtime < liveMs) || toolOpen(s.subToolSince, now)
}

/** The main turn is open and it writes or runs a tool. */
export function mainTurnAtWork(s: WorkSignals, now: number, liveMs: number): boolean {
  if (!(s.turnOpen ?? s.lastRole === 'user')) return false
  return now - s.mtime < liveMs || toolOpen(s.toolSince, now)
}

/** A background command it launched is still awaited, within the bound. */
export function shellAtWork(s: Pick<WorkSignals, 'shellSince'>, now: number): boolean {
  return s.shellSince !== undefined && s.shellSince > 0 && now - s.shellSince < SHELL_MAX_MS
}

/** Working: its main turn, its background work or a command it awaits is live. */
export function conversationWorking(s: WorkSignals, now: number, liveMs: number): boolean {
  return backgroundAtWork(s, now, liveMs) || mainTurnAtWork(s, now, liveMs) || shellAtWork(s, now)
}

/** At work: working, or held on the owner's open question (not abandoned). */
export function sessionAtWork(s: WorkSignals, now: number, liveMs: number): boolean {
  return s.pendingAsk === true || conversationWorking(s, now, liveMs)
}
