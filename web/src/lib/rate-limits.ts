// rate-limits.ts — 5h vs weekly labeling for Claude's rate limits. The
// system's own truth comes first: the SDK emits rateLimitType
// ('five_hour' | 'seven_day' | 'seven_day_opus' | 'seven_day_sonnet' |
// 'seven_day_overage_included' | 'overage') and it already travels as
// `kind` in chat-ratelimit and in the per-provider window. When only
// resetsAt is available (resident runs, the fallback badge), an honest
// heuristic: a reset more than 24h out can't be the 5h window.
import { DAY_MS } from './rel-time'

export function limitLabel(kind?: string, resetsAt?: string, now: number = Date.now()): string {
  switch (kind) {
    case 'five_hour':
      return '5h window'
    case 'seven_day':
    case 'seven_day_overage_included':
      return 'weekly window'
    case 'seven_day_opus':
      return 'weekly · opus'
    case 'seven_day_sonnet':
      return 'weekly · sonnet'
    case 'overage':
      return 'overage'
  }
  if (kind !== undefined) return kind.replace(/_/g, ' ') // a new SDK type: readable and raw, never hidden
  if (resetsAt !== undefined) {
    const ms = Date.parse(resetsAt)
    if (!Number.isNaN(ms)) return ms - now > DAY_MS ? 'weekly window' : '5h window'
  }
  return 'limit'
}

// Auto-resume: the readable reset time for the banner's reassurance line
// ("Silos will resume this automatically at <time>"). Same criterion as
// resumeLabel: past 24h out, the day gets prepended (HH:MM of WHICH day?).
// null if it doesn't parse — the caller never promises a resume with no time.
export function resetTime(resetsAt: string, now: number = Date.now()): string | null {
  const ms = Date.parse(resetsAt)
  if (Number.isNaN(ms)) return null
  const time = new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  if (ms - now <= DAY_MS) return time
  const day = new Date(ms).toLocaleDateString(undefined, { weekday: 'short' })
  return `${day} ${time}`
}

// "resumes HH:MM" is misleading if the reset is days out (HH:MM of WHICH
// day?): past 24h, the day gets added along with a weekly marker. Returns
// null if the date doesn't parse — the caller decides its own fallback
// ("waiting", etc.).
export function resumeLabel(resetsAt: string, now: number = Date.now(), kind?: string): string | null {
  const ms = Date.parse(resetsAt)
  if (Number.isNaN(ms)) return null
  const time = new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  const isWeekly = kind?.startsWith('seven_day') || (kind === undefined && ms - now > DAY_MS)
  if (!isWeekly) return `resumes ${time}`
  const day = new Date(ms).toLocaleDateString(undefined, { weekday: 'short' })
  return `resumes ${day} ${time} · weekly`
}
