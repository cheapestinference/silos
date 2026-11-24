// loop-stalls.test.ts — the stall monitor's windows and its log's rate limit
// (loop-stalls.ts), on an injected clock: no wall-clock assertions.
import { describe, it, expect } from 'vitest'
import { COUNT_OVER_MS, LOG_EVERY_MS, LOG_OVER_MS, LoopStalls, startLoopStallMonitor } from '../src/loop-stalls.js'

function world(start = Date.parse('2026-11-21T10:00:00Z')) {
  let now = start
  const lines: string[] = []
  const s = new LoopStalls({ now: () => now, log: (l) => lines.push(l) })
  return {
    s,
    lines,
    advance: (ms: number) => {
      now += ms
    },
    at: () => now,
  }
}

describe('LoopStalls — counted over 200 ms, in rolling windows', () => {
  it('nothing at or under the count threshold is a stall', () => {
    const w = world()
    w.s.record(0)
    w.s.record(COUNT_OVER_MS)
    w.s.record(Number.NaN)
    const snap = w.s.snapshot()
    expect(snap.sinceBoot.count).toBe(0)
    expect(snap.last).toBeNull()
    expect(snap.worstLastHourAt).toBeNull()
  })

  it('the last minute, the last hour and since boot each keep their count and worst', () => {
    const w = world()
    w.s.record(300) // t0
    w.advance(30 * 60_000)
    w.s.record(900) // t0 + 30 min
    w.advance(50 * 60_000)
    w.s.record(250) // t0 + 80 min: the 300 left the hour
    w.advance(20_000)
    w.s.record(400) // 20 s later
    const snap = w.s.snapshot()
    expect(snap.lastMinute).toEqual({ count: 2, worstMs: 400 })
    expect(snap.lastHour).toEqual({ count: 3, worstMs: 900 })
    expect(snap.sinceBoot).toMatchObject({ count: 4, worstMs: 900 })
    expect(snap.worstLastHourAt).toBe(new Date(Date.parse('2026-11-21T10:30:00Z')).toISOString())
    expect(snap.last).toEqual({ ms: 400, at: new Date(w.at()).toISOString() })
    // time passes with no stall: the windows empty, since-boot stays
    w.advance(61 * 60_000)
    const later = w.s.snapshot()
    expect(later.lastMinute).toEqual({ count: 0, worstMs: 0 })
    expect(later.lastHour).toEqual({ count: 0, worstMs: 0 })
    expect(later.sinceBoot).toMatchObject({ count: 4, worstMs: 900 })
  })
})

describe('LoopStalls — one log line per stall over 500 ms, at most one per 10 s', () => {
  it('a 200–500 ms stall is counted, never logged', () => {
    const w = world()
    w.s.record(LOG_OVER_MS)
    expect(w.lines).toEqual([])
    expect(w.s.snapshot().sinceBoot.count).toBe(1)
  })

  it('logs duration and when; within 10 s the next ones are swallowed and counted into the next line', () => {
    const w = world()
    w.s.record(850)
    expect(w.lines).toHaveLength(1)
    expect(w.lines[0]).toContain('850 ms')
    expect(w.lines[0]).toContain(new Date(w.at()).toISOString())
    w.advance(2_000)
    w.s.record(600)
    w.advance(2_000)
    w.s.record(12_000)
    w.advance(2_000)
    w.s.record(300) // under the log threshold: neither logged nor swallowed
    expect(w.lines).toHaveLength(1)
    w.advance(LOG_EVERY_MS - 6_000) // exactly 10 s after the first line
    w.s.record(700)
    expect(w.lines).toHaveLength(2)
    expect(w.lines[1]).toContain('700 ms')
    expect(w.lines[1]).toContain('2 more')
    // the swallowed count starts over
    w.advance(LOG_EVERY_MS)
    w.s.record(510)
    expect(w.lines[2]).not.toContain('more')
    // every one of them is in the numbers
    expect(w.s.snapshot().sinceBoot).toMatchObject({ count: 6, worstMs: 12_000 })
  })
})

describe('startLoopStallMonitor', () => {
  it('never keeps the process alive, and stops', () => {
    const m = startLoopStallMonitor({ log: () => {} })
    expect(m.timer.hasRef()).toBe(false)
    expect(m.stalls.snapshot().sinceBoot.count).toBe(0)
    m.stop()
  })
})
