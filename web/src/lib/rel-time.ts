// rel-time.ts — relTime used to live in Threads.tsx and got re-exported from
// there for Chat.tsx (its only external consumer until now). With
// Threads.tsx absorbed into Sidebar.tsx, and BOTH components needing it,
// it's extracted into a shared lib instead of one re-exporting the other.
// The canonical time constants — exported so nothing redefines 24*60*60*1000
// on its own (it was spelled out in ~5 files).
export const MINUTE_MS = 60_000
export const HOUR_MS = 60 * MINUTE_MS
export const DAY_MS = 24 * HOUR_MS
export const WEEK_MS = 7 * DAY_MS

// Claude Code style: short forms ("5m ago").
export function relTime(mtime: number, now: number = Date.now()): string {
  const diff = Math.max(0, now - mtime)
  if (diff < MINUTE_MS) return 'just now'
  if (diff < HOUR_MS) return `${Math.floor(diff / MINUTE_MS)}m ago`
  if (diff < DAY_MS) return `${Math.floor(diff / HOUR_MS)}h ago`
  return `${Math.floor(diff / DAY_MS)}d ago`
}

// A moment still AHEAD, in the same short forms («in 5m», «in 3h», «in 14d»);
// one already behind falls back to relTime's words — a caller that mixes both
// (a next check that may have passed) says the truth either way.
export function untilTime(t: number, now: number = Date.now()): string {
  const diff = t - now
  if (diff <= 0) return relTime(t, now)
  if (diff < MINUTE_MS) return 'in under a minute'
  if (diff < HOUR_MS) return `in ${Math.ceil(diff / MINUTE_MS)}m`
  if (diff < DAY_MS) return `in ${Math.ceil(diff / HOUR_MS)}h`
  return `in ${Math.ceil(diff / DAY_MS)}d`
}

// A moment the server sent as text (ISO) — or null when there is none to
// say: '' (a silo record with no moment), absent, or not a date. Callers show
// no time then (never «NaNd ago»).
export function relTimeOf(iso: string | null | undefined, now: number = Date.now()): string | null {
  if (!iso) return null
  const t = Date.parse(iso)
  return Number.isFinite(t) ? relTime(t, now) : null
}
