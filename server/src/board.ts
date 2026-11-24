// board.ts — conversation-state aggregation behind GET /api/board (the
// Board page is retired; the cards feed Home: Working now's waiting line,
// the digest sheet's finished-today list, the fleet rows). Pure functions, no per-session fetches: the
// caller already has index.allSessions()+index.getContext() in memory (the
// index's own accumulators) — a single pass.
import type { BoardCard, SessionContext, SessionMeta } from './types.js'
import { conversationWorking, type WorkSignals } from './work-live.js'

export type BoardState = BoardCard['state']

// FacetFilter: cap on tool names per card — see the comment in boardCardOf.
export const MAX_BOARD_TOOLS = 12

// Priority (the first match wins): the agent's own pending state > live right
// now > waiting on something external (Monitor/wakeup/workflow) > touched
// today but no longer live > everything else.
// «Live right now» = it moved within liveMs, or it is working by the one rule
// (work-live.ts: a silent tool in flight, a background agent of it at work).
export function boardStateOf(meta: WorkSignals, ctx: SessionContext | null, now: number, liveMs: number): BoardState {
  const { mtime } = meta
  if (ctx?.pending) return 'needs_you'
  if (now - mtime < liveMs || conversationWorking(meta, now, liveMs)) return 'working'
  if (ctx?.waiting) return 'waiting'
  if (new Date(mtime).toDateString() === new Date(now).toDateString()) return 'done_today'
  return 'idle'
}

// classifyAgentId/title come from the caller (server.ts already resolves
// them for /api/overview with the same logic — reused here instead of
// duplicated).
export function boardCardOf(meta: SessionMeta, ctx: SessionContext | null, now: number, liveMs: number, agentId: string, title: string): BoardCard {
  const card: BoardCard = {
    folder: meta.folder,
    id: meta.id,
    title,
    agentId,
    cwd: meta.cwd,
    state: boardStateOf(meta, ctx, now, liveMs),
    mtime: meta.mtime,
  }
  // what a waiting conversation waits ON — Home's Working now names it
  // («waiting on a monitor — <its description>»), the context column's words
  if (card.state === 'waiting' && ctx?.waiting) card.waiting = { ...ctx.waiting }
  if (ctx?.plan) {
    card.planDone = ctx.plan.done
    card.planTotal = ctx.plan.total
  }
  // FacetFilter: tools by NAME (deduplicated — ctx.tools distinguishes
  // server:name, but the name alone is enough for the facet), only if there
  // are any. Capped: the rest of the board payload is deliberately lean and
  // a session with dozens of MCP tools shouldn't bloat every GET /api/board;
  // 12 names are plenty for faceting.
  if (ctx && ctx.tools.length > 0) {
    card.tools = [...new Set(ctx.tools.map((t) => t.name))].slice(0, MAX_BOARD_TOOLS)
  }
  return card
}
