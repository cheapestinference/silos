// counts.ts — the numbers every surface prints next to "conversations" and
// "runs", from the server's UNCAPPED totals (server/src/session-counts.ts).
//
// The overview caps each agent's list (40 conversations + 10 runs per
// automation), so a count is never the length of that list: Builder's header
// once read "1,399 conversations" (runs included), the project page summed
// capped lists (147) and Settings printed the capped total (165). The rule:
// "conversations" = the owner's own (no automation origin); runs are
// counted and labelled as runs; a conversation Silos once opened for a
// message (origin 'message', history) is neither — counted on its own. A project's share: home.ts countsInFolder.
import type { AgentView, SessionCounts } from './types'

// The agent's totals — the server's (`counts` travels in the overview and
// with every session event, store/helpers.ts applyCounts); the web counts
// no second way.
const NO_COUNTS: SessionCounts = { conversations: 0, runs: 0, runsByAutomation: {}, byCwd: {} }
export function countsOf(a: AgentView): SessionCounts {
  return a.counts ?? NO_COUNTS
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`
}

// "3 conversations · 1,396 runs" — the runs part only when there are any.
export function conversationsAndRuns(c: { conversations: number; runs: number }): string {
  return c.runs > 0 ? `${plural(c.conversations, 'conversation')} · ${plural(c.runs, 'run')}` : plural(c.conversations, 'conversation')
}
