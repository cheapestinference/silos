// loop-stalls.ts — the event loop's stalls, seen instead of guessed.
//
// The server is ONE event loop, and it also relays the owner's live
// consoles: any synchronous stretch freezes their terminal for its length.
// Until 21-11 nothing said so — an 11–15 s freeze every 30 s was found only
// by profiling by hand. This keeps the numbers permanently:
//  · a timer that measures its own lateness every TICK_MS (unref'd: it never
//    keeps the process alive; ~10 wake-ups a second cost nothing measurable)
//    — a tick late by L ms means the loop was held ~L ms;
//  · every stall over COUNT_OVER_MS (200) is counted, with the worst, in
//    rolling windows: the last minute, the last hour, since boot;
//  · a stall over LOG_OVER_MS (500) writes ONE log line saying how long and
//    when — at most one line per LOG_EVERY_MS (10 s); the stalls a line
//    swallowed are counted into the next one;
//  · the numbers are on GET /healthz for a request from this machine (numbers
//    only — a remote caller still gets `{ ok: true }`): the next diagnosis is
//    `curl -s 127.0.0.1:3210/healthz`.
// The windows and the rate limit are a pure class with an injected clock
// (LoopStalls); startLoopStallMonitor wires it to real timers.

export const TICK_MS = 100
export const COUNT_OVER_MS = 200
export const LOG_OVER_MS = 500
export const LOG_EVERY_MS = 10_000
const MINUTE = 60_000
const HOUR = 60 * MINUTE
// a bound on what the hour window keeps (a stall every 100 ms for an hour
// would be 36 000; far past what a sane server shows)
const KEEP_MAX = 10_000

export interface StallWindow {
  count: number
  worstMs: number
}
export interface StallSnapshot {
  /** stalls over COUNT_OVER_MS */
  lastMinute: StallWindow
  lastHour: StallWindow
  sinceBoot: StallWindow & { since: string }
  /** the worst stall of the last hour, and when it ended (ISO) — null when none */
  worstLastHourAt: string | null
  /** the latest stall over COUNT_OVER_MS (ms, and when it ended) — null when none */
  last: { ms: number; at: string } | null
  thresholds: { countOverMs: number; logOverMs: number }
}

export class LoopStalls {
  private recent: { at: number; ms: number }[] = []
  private boot: StallWindow = { count: 0, worstMs: 0 }
  private lastLogAt = -Infinity
  private swallowed = 0
  private readonly startedAt: number

  constructor(private readonly o: { now: () => number; log: (line: string) => void }) {
    this.startedAt = o.now()
  }

  /** A stall of `ms` that ended now. */
  record(ms: number): void {
    if (!(ms > COUNT_OVER_MS)) return
    const at = this.o.now()
    const ms0 = Math.round(ms)
    this.boot.count += 1
    this.boot.worstMs = Math.max(this.boot.worstMs, ms0)
    this.recent.push({ at, ms: ms0 })
    this.prune(at)
    if (ms0 <= LOG_OVER_MS) return
    if (at - this.lastLogAt < LOG_EVERY_MS) {
      this.swallowed += 1
      return
    }
    const more = this.swallowed > 0 ? ` (and ${this.swallowed} more over ${LOG_OVER_MS} ms since the last line, not logged)` : ''
    this.o.log(`event loop blocked ${ms0} ms, until ${new Date(at).toISOString()}${more} — every live console froze for it`)
    this.lastLogAt = at
    this.swallowed = 0
  }

  snapshot(): StallSnapshot {
    const now = this.o.now()
    this.prune(now)
    const win = (span: number): { w: StallWindow; worstAt: number | null } => {
      let count = 0,
        worstMs = 0,
        worstAt: number | null = null
      for (const s of this.recent) {
        if (now - s.at > span) continue
        count += 1
        if (s.ms > worstMs) {
          worstMs = s.ms
          worstAt = s.at
        }
      }
      return { w: { count, worstMs }, worstAt }
    }
    const hour = win(HOUR)
    const last = this.recent[this.recent.length - 1]
    return {
      lastMinute: win(MINUTE).w,
      lastHour: hour.w,
      sinceBoot: { ...this.boot, since: new Date(this.startedAt).toISOString() },
      worstLastHourAt: hour.worstAt === null ? null : new Date(hour.worstAt).toISOString(),
      last: last ? { ms: last.ms, at: new Date(last.at).toISOString() } : null,
      thresholds: { countOverMs: COUNT_OVER_MS, logOverMs: LOG_OVER_MS },
    }
  }

  private prune(now: number): void {
    let drop = 0
    while (drop < this.recent.length && now - this.recent[drop]!.at > HOUR) drop++
    if (this.recent.length - drop > KEEP_MAX) drop = this.recent.length - KEEP_MAX
    if (drop > 0) this.recent.splice(0, drop)
  }
}

/** The monitor on real timers: a tick every TICK_MS measures how late it
 *  ran (monotonic clock); the lateness past the tick is the stall. Never
 *  keeps the process alive. */
export function startLoopStallMonitor(o: { log?: (line: string) => void } = {}): { stalls: LoopStalls; stop: () => void; timer: NodeJS.Timeout } {
  const stalls = new LoopStalls({ now: Date.now, log: o.log ?? ((l) => console.warn(l)) })
  let last = performance.now()
  const timer = setInterval(() => {
    const t = performance.now()
    stalls.record(t - last - TICK_MS)
    last = t
  }, TICK_MS)
  timer.unref()
  return { stalls, stop: () => clearInterval(timer), timer }
}
