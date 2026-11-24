// conversation-live.ts — the live facts a task's flow reads (silos/
// task-flow.ts), each written ONCE so the native plan route, the silo's
// set-field answer and the kernel's request-time evaluation never disagree:
//
//   wakesOfControl   will this agent move when a task of its becomes ready?
//                    'task' — it is On its own (control.ts controlOf): Task
//                    mode wakes it on its task's events; 'never' — Only when
//                    told: it moves when someone opens a conversation
//                    (no run-mode, no watch, no beat).
//   conversationLive the resident's «busy» rule: a turn running now, or
//                    activity within CONVERSATION_BUSY_MS
import type { Wakes } from './silos/task-flow.js'
import { backgroundAtWork, conversationWorking, type WorkSignals } from './work-live.js'

// the activity window a write keeps work live (config.ts liveMs)
const LIVE_MS = 120_000

export type { Wakes }

// how recent a task's conversation's last activity keeps it «being worked»
export const CONVERSATION_BUSY_MS = 2 * 3600_000

/** Whether an agent moves on its tasks by itself — its derived control. */
export function wakesOfControl(control: 'told' | 'own'): Wakes {
  return control === 'own' ? 'task' : 'never'
}

// A conversation is live when its turn runs now, it moved within
// CONVERSATION_BUSY_MS, or it is WORKING by the one rule (work-live.ts) —
// a background agent of it writes or runs a silent tool long after the main
// transcript went quiet (a test suite in a subagent once read «Waiting for
// you to continue»). The sessions are read lazily and kept `ttlMs` — a
// request evaluating many tasks reads the index once.
export function conversationLive(
  o: { isActive(sessionId: string): boolean; sessions(): ReadonlyArray<{ id: string } & WorkSignals>; now?: () => number; liveMs?: number },
  ttlMs = 5_000,
): (sessionId: string) => boolean {
  let cache: { at: number; byId: Map<string, WorkSignals> } | null = null
  const now = o.now ?? Date.now
  const liveMs = o.liveMs ?? LIVE_MS
  return (sessionId) => {
    if (o.isActive(sessionId)) return true
    const t = now()
    if (!cache || t - cache.at > ttlMs) cache = { at: t, byId: new Map(o.sessions().map((m) => [m.id, m])) }
    const m = cache.byId.get(sessionId)
    return m !== undefined && (t - m.mtime < CONVERSATION_BUSY_MS || conversationWorking(m, t, liveMs))
  }
}

// Task mode's busy check (index.ts busyWhy) beside the running turn and the
// open console: the conversation's BACKGROUND work is live by the one rule
// (work-live.ts) — a wake delivered now would start a turn under agents still
// working for it. Same lazy read of the index, kept `ttlMs`.
export const BACKGROUND_BUSY = 'its subagents are at work'
export function backgroundBusy(
  o: { sessions(): ReadonlyArray<{ id: string } & WorkSignals>; now?: () => number; liveMs?: number },
  ttlMs = 5_000,
): (sessionId: string) => boolean {
  let cache: { at: number; byId: Map<string, WorkSignals> } | null = null
  const now = o.now ?? Date.now
  const liveMs = o.liveMs ?? LIVE_MS
  return (sessionId) => {
    const t = now()
    if (!cache || t - cache.at > ttlMs) cache = { at: t, byId: new Map(o.sessions().map((m) => [m.id, m])) }
    const m = cache.byId.get(sessionId)
    return m !== undefined && backgroundAtWork(m, t, liveMs)
  }
}

// The set-field answer's nowReady, each owner said with whether it will move
// (G6, the route half): an agent in play gets its wakes; a human, an archived
// or an unknown owner gets none — the native route listed agents only.
export function withWakes<T extends { owner: string }>(
  items: readonly T[],
  o: { inPlay(agentId: string): boolean; wakes(agentId: string): Wakes },
): Array<T & { wakes?: Wakes }> {
  return items.map((x) => (x.owner !== '' && o.inPlay(x.owner) ? { ...x, wakes: o.wakes(x.owner) } : { ...x }))
}
