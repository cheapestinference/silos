// turn-slots.test.ts — the live caps
// and the day on its own (own-turns.ts).
import { describe, expect, it } from 'vitest'
import { heldWords, TurnSlots } from '../src/turn-slots.js'
import { ownCapHold } from '../src/own-turns.js'

describe('TurnSlots: OWN_TURNS_LIVE per agent, UNATTENDED_TURNS_LIVE_GLOBAL for the fleet', () => {
  it('per agent: the third waits with its words', () => {
    const s = new TurnSlots({ agentMax: 2, globalMax: 9 })
    expect(s.tryAcquire({ id: 'a1', agentId: 'x', gesture: false, at: 1 }).ok).toBe(true)
    expect(s.tryAcquire({ id: 'a2', agentId: 'x', gesture: false, at: 2 }).ok).toBe(true)
    const third = s.tryAcquire({ id: 'a3', agentId: 'x', gesture: true, at: 3 })
    expect(third).toEqual({ ok: false, cap: 'agent', running: 2 })
    expect(heldWords('agent', 2, 'X')).toBe('X is running 2 things already — it starts when one ends')
    expect(heldWords('global', 3, 'X')).toBe('the fleet is running 3 things — X starts when one ends')
  })
  it("two classes: an owner's gesture goes ahead of everything inferred, FIFO inside each class (G1-r6)", () => {
    const s = new TurnSlots({ agentMax: 5, globalMax: 1 })
    const first = s.tryAcquire({ id: 'run', agentId: 'a', gesture: false, at: 0 })
    expect(first.ok).toBe(true)
    // seven inferred heartbeats queue on a Monday…
    for (let i = 0; i < 7; i++) expect(s.tryAcquire({ id: `hb${i}`, agentId: `b${i}`, gesture: false, at: 10 + i }).ok).toBe(false)
    // …then the owner gives work at 09:10
    expect(s.tryAcquire({ id: 'give', agentId: 'c', gesture: true, at: 100 }).ok).toBe(false)
    expect(s.queue().map((q) => q.id)).toEqual(['give', 'hb0', 'hb1', 'hb2', 'hb3', 'hb4', 'hb5', 'hb6'])
    if (first.ok) first.release()
    // an inferred one asking first in this pass still waits behind the gesture
    expect(s.tryAcquire({ id: 'hb0', agentId: 'b0', gesture: false, at: 10 }).ok).toBe(false)
    const g = s.tryAcquire({ id: 'give', agentId: 'c', gesture: true, at: 100 })
    expect(g.ok).toBe(true)
    if (g.ok) g.release()
    expect(s.tryAcquire({ id: 'hb0', agentId: 'b0', gesture: false, at: 10 }).ok).toBe(true)
  })
  it('a request nobody asks again for leaves the line; release is idempotent', () => {
    let t = 0
    const s = new TurnSlots({ agentMax: 5, globalMax: 1, now: () => t })
    const a = s.tryAcquire({ id: 'a', agentId: 'a', gesture: false, at: 0 })
    s.tryAcquire({ id: 'b', agentId: 'b', gesture: true, at: 0 })
    t = 10 * 60_000
    expect(s.queue()).toEqual([])
    if (a.ok) {
      a.release()
      a.release()
    }
    expect(s.liveTotal()).toBe(0)
  })
})

describe('the day on its own', () => {
  const day = (o: Partial<Parameters<typeof ownCapHold>[0]>) => ({ used: 0, costUsd: 0, unpriced: 0, ceiling: 10, spendCap: 5, exempt: false, ...o })
  it('the ceiling first, then the spend cap; «Let it continue today» lifts both; an accepted own run is outside the ceiling, inside the spend cap', () => {
    expect(ownCapHold(day({ used: 10 }))).toBe('ceiling')
    expect(ownCapHold(day({ costUsd: 5 }))).toBe('spend')
    expect(ownCapHold(day({ used: 10, costUsd: 9, exempt: true }))).toBeNull()
    expect(ownCapHold(day({ used: 10 }), { outsideCeiling: true })).toBeNull()
    expect(ownCapHold(day({ used: 10, costUsd: 6 }), { outsideCeiling: true })).toBe('spend')
  })
})
