// store/helpers.ts — the store's constants and pure helpers shared by the
// engine and the slices (TERMINAL_* are re-exported from ../store.ts).
import { activeLeaveGuard } from '../lib/leave-guard'
import type { AgentView, SessionCounts, SessionView, WsEvent } from '../lib/types'
import type { Page } from './types'
import type { State } from './state'

// the terminal panel's height limits (~220 default, 120 min, 60vh max — the
// max depends on the viewport, clamped in the component while dragging;
// here only the minimum is protected against, in case a corrupt value
// arrives from prefs).
export const TERMINAL_HEIGHT_DEFAULT = 220
export const TERMINAL_HEIGHT_MIN = 120
export const TERMINAL_FONT_DEFAULT = 13
export const TERMINAL_FONT_MIN = 10
export const TERMINAL_FONT_MAX = 24
export function clampFont(px: number): number {
  return Math.min(TERMINAL_FONT_MAX, Math.max(TERMINAL_FONT_MIN, Math.round(px)))
}

export const BUFFER_TTL_MS = 10_000
export const CLEAR_ACTIVE_DELAY_MS = 100
// a defensive cap on receipts per session — a very long-lived view mustn't
// grow state without bound; 50 turns back covers any real session.
export const RECEIPTS_CAP = 50
export const LIVE_REFETCH_THROTTLE_MS = 1500 // live transcript: at most 1 refetch every 1500ms while a turn is active
export const BATCH_FLUSH_MS = 80 // streaming performance: at most 1 render per this window for accumulated deltas
// resync: once the server confirms the turn is NO LONGER inflight, this is
// the grace period given to a chat-done that might be in transit (a WS
// buffer, a message in flight) before giving it up as lost and finishing by hand.
export const WATCHDOG_ALIVE_GRACE_MS = 3000

export type ChatEvent = Extract<WsEvent, { turnId: string }>
// how long the Knows live toast stays (~6 s)
export const KNOWS_TOAST_MS = 6_000
// "delta-type" events that accumulate in the batching buffer instead of
// firing a set() per event — chat-delta, chat-thinking and chat-usage (the
// token counter arrives at the same cadence as the text, so it's added to
// the same buffer instead of forcing its own flush).
export type BatchableEvent = Extract<ChatEvent, { ev: 'chat-delta' | 'chat-thinking' | 'chat-usage' }>

export function isChatEvent(ev: WsEvent): ev is ChatEvent {
  return (
    ev.ev === 'chat-init' ||
    ev.ev === 'chat-delta' ||
    ev.ev === 'chat-thinking' ||
    ev.ev === 'chat-tool' ||
    ev.ev === 'chat-usage' ||
    ev.ev === 'chat-done' ||
    ev.ev === 'chat-error'
  )
}

export function isBatchable(ev: ChatEvent): ev is BatchableEvent {
  return ev.ev === 'chat-delta' || ev.ev === 'chat-thinking' || ev.ev === 'chat-usage'
}

export function sessionBelongsToAgent(sel: { folder: string; id: string }, agentId: string, agents: AgentView[]): boolean {
  const agent = agents.find((a) => a.id === agentId)
  return agent?.sessions.some((s) => s.folder === sel.folder && s.id === sel.id) ?? false
}

// the list changed: liveCount follows it (live sessions are the newest —
// always inside the cap); the TOTALS never do — they arrive from the server
// with the event (applyCounts), the list is capped.
export function withCounts(a: AgentView, sessions: SessionView[]): AgentView {
  return { ...a, sessions, liveCount: sessions.filter((s) => s.live).length }
}

export function applyCounts(agents: AgentView[], counts: Record<string, SessionCounts> | undefined): AgentView[] {
  if (!counts) return agents
  return agents.map((a) => {
    const c = counts[a.id] ?? { conversations: 0, runs: 0, runsByAutomation: {}, byCwd: {} }
    return { ...a, counts: c, sessionCount: c.conversations + c.runs }
  })
}

// upserts meta into agent meta.agentId; removed from any other agent
// (re-homing) and that agent's list re-sorted by mtime desc.
export function upsertSessionInAgents(agents: AgentView[], meta: SessionView): AgentView[] {
  return agents.map((a) => {
    const withoutOld = a.sessions.filter((s) => !(s.folder === meta.folder && s.id === meta.id))
    if (a.id !== meta.agentId) {
      return withoutOld.length === a.sessions.length ? a : withCounts(a, withoutOld)
    }
    const sessions = [...withoutOld, meta].sort((x, y) => y.mtime - x.mtime)
    return withCounts(a, sessions)
  })
}

export function renameSessionInAgents(agents: AgentView[], folder: string, id: string, title: string): AgentView[] {
  return agents.map((a) => {
    const idx = a.sessions.findIndex((s) => s.folder === folder && s.id === id)
    if (idx === -1) return a
    const sessions = a.sessions.slice()
    sessions[idx] = { ...sessions[idx]!, title: title }
    return { ...a, sessions }
  })
}

export function removeSessionFromAgents(agents: AgentView[], folder: string, id: string): AgentView[] {
  return agents.map((a) => {
    const sessions = a.sessions.filter((s) => !(s.folder === folder && s.id === id))
    return sessions.length === a.sessions.length ? a : withCounts(a, sessions)
  })
}

// durable unseen: on OPENING a conversation, its durable dot clears
// optimistically on the client (unread=false) so the sidebar reacts
// instantly — the PATCH /api/seen confirms it on disk and the next
// overview keeps it clear. Without this there'd be a flicker until the next refresh.
export function markSeenInAgents(agents: AgentView[], folder: string, id: string): AgentView[] {
  return agents.map((a) => {
    const idx = a.sessions.findIndex((s) => s.folder === folder && s.id === id)
    if (idx === -1 || a.sessions[idx]!.unread !== true) return a
    const sessions = a.sessions.slice()
    sessions[idx] = { ...sessions[idx]!, unread: false }
    return { ...a, sessions }
  })
}

export const WARMING_RETRY_MS = 2000

// a page change while a leave guard is armed (lib/leave-guard.ts) is held
// back, together with every set() of the same tick, and handed to the
// guard — the page with unsaved work stays until the owner says Discard.
export function samePage(a: Page, b: Page): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}
export type SetFn = (partial: State | Partial<State> | ((s: State) => State | Partial<State>), replace?: false) => void
export function guardedSet(rawSet: SetFn, get: () => State): SetFn {
  let held: Partial<State>[] | null = null
  return (partial, replace) => {
    const guard = activeLeaveGuard()
    if (!guard) {
      rawSet(partial, replace)
      return
    }
    if (held) {
      const draft = Object.assign({}, get(), ...held) as State
      held.push(typeof partial === 'function' ? partial(draft) : partial)
      return
    }
    const patch = typeof partial === 'function' ? partial(get()) : partial
    if (patch && 'page' in patch && !samePage(patch.page as Page, get().page)) {
      const mine: Partial<State>[] = [patch]
      held = mine
      queueMicrotask(() => {
        held = null
        guard.onBlocked(mine as Record<string, unknown>[])
      })
      return
    }
    rawSet(patch, replace)
  }
}
