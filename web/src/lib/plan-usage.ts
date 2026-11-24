// plan-usage.ts — the words and geometry of a Claude subscription's usage
// bars (the runs-on line, ContextColumn). Pure: what the server read
// (GET /api/plan-usage) → tone, the pace tick, the reset time.
import type { PlanUsageWindow } from './types'
import { DAY_MS, MINUTE_MS } from './rel-time'

export type UsageTone = 'calm' | 'warn' | 'out'

// spent → terracotta (this window is what stops a turn); the account's own
// warning/critical → amber; otherwise ink.
export function usageTone(w: PlanUsageWindow): UsageTone {
  if (w.percent >= 100) return 'out'
  return w.severity === 'normal' ? 'calm' : 'warn'
}

// How much of the window has gone by (0..1) — where the pace tick sits: a
// fill past the tick spends faster than the window refills. null when the
// window's length or reset is unknown (no tick rather than a wrong one).
export function paceFraction(w: PlanUsageWindow, now: number = Date.now()): number | null {
  if (w.windowMs === null || w.resetsAt === null) return null
  const left = Date.parse(w.resetsAt) - now
  if (Number.isNaN(left)) return null
  return Math.min(1, Math.max(0, 1 - left / w.windowMs))
}

// 24 h clock like the rest of the column, rounded to the minute (the API
// says 04:59:59.6 for a reset at 05:00), the weekday once it is a day out.
export function usageResetLabel(w: PlanUsageWindow, now: number = Date.now()): string | null {
  if (w.resetsAt === null) return null
  const raw = Date.parse(w.resetsAt)
  if (Number.isNaN(raw)) return null
  const d = new Date(Math.round(raw / MINUTE_MS) * MINUTE_MS)
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false })
  return d.getTime() - now > DAY_MS ? `${d.toLocaleDateString(undefined, { weekday: 'short' })} ${time}` : time
}

// the row's full sentence (title + aria): never shorter than what the bar shows.
export function usageSentence(w: PlanUsageWindow, now: number = Date.now()): string {
  const name = w.label === '5h' ? '5-hour window' : w.label === 'Week' ? 'Weekly window' : `${w.label} weekly window`
  const parts = [`${name}: ${Math.round(w.percent)}% used`]
  const reset = usageResetLabel(w, now)
  if (reset) parts.push(`resets ${reset}`)
  const pace = paceFraction(w, now)
  if (pace !== null) parts.push(`${Math.round(pace * 100)}% of the window gone`)
  return parts.join(' · ')
}
