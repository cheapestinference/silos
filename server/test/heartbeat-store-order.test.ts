// heartbeat-store-order.test.ts — the heartbeat's state follows its runs IN
// ORDER: a row of an older run (a terminal row that
// closes after midnight, an audit's re-write, a boot's close) never
// overrides what a newer one set — today's counters and the pending think.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HeartbeatStore } from '../src/heartbeat-store.js'
import type { Run, RunHeartbeat } from '../src/automations-types.js'

let dir: string, store: HeartbeatStore
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'silos-hbs-'))
  store = new HeartbeatStore(dir)
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const at = (d: number, h: number, m: number): string => new Date(2026, 10, d, h, m).toISOString()
const hb = (kind: RunHeartbeat['kind'], over: Partial<RunHeartbeat> = {}): RunHeartbeat => ({
  kind,
  packet: { keys: [] },
  created: [],
  proposed: [],
  considered: 0,
  ...over,
})
const row = (id: string, when: string, status: Run['status'], h: RunHeartbeat, over: Partial<Run> = {}): Run => ({
  id,
  automationId: 'heartbeat-x',
  at: when,
  status,
  heartbeat: h,
  ...over,
})

describe('noteRun — ordered by run', () => {
  it("a round started at 23:58 that closes after midnight never resets the new day's counters", () => {
    store.noteRun('x', row('r1', at(11, 23, 58), 'running', hb('round')))
    // the new day's first slot skips while it still runs
    store.noteRun('x', row('s1', at(12, 0, 1), 'skipped', hb('round', { skipped: 'busy' })))
    store.noteRun('x', row('r1', at(11, 23, 58), 'ok', hb('round')))
    expect(store.state('x').today).toMatchObject({ day: '2026-11-12', skipped: 1 })
    expect(store.turnsOfDay('x', '2026-11-12')).toEqual({ looks: 0, thinks: 0, rounds: 0 })
    // what it did is still known: its turn
    expect(store.state('x').lastTurnAt).toBe(at(11, 23, 58))
  })

  it('an older think re-written after a newer one succeeded never sets the think pending again', () => {
    store.noteRun('x', row('t1', at(11, 9, 0), 'running', hb('think')))
    store.noteRun('x', row('t1', at(11, 9, 0), 'failed', hb('think')))
    expect(store.state('x').pendingThink).toEqual({ at: at(11, 9, 0), why: 'failed' })
    // the re-arm after midnight thinks — and succeeds
    store.noteRun('x', row('t2', at(12, 0, 30), 'running', hb('think'), { cause: 'rearm' }))
    store.noteRun('x', row('t2', at(12, 0, 30), 'ok', hb('think'), { cause: 'rearm' }))
    expect(store.state('x').pendingThink).toBeUndefined()
    // the old failure's audit is written onto its run: nothing comes back
    store.noteRun('x', row('t1', at(11, 9, 0), 'failed', hb('think'), { audit: { readOutside: [] } }))
    expect(store.state('x').pendingThink).toBeUndefined()
    expect(store.state('x').rearmDay).toBe('2026-11-12')
    expect(store.state('x').thinkTriedDay).toBe('2026-11-12')
    // and the same row twice is the same state (idempotent per run)
    const before = JSON.stringify(store.state('x'))
    store.noteRun('x', row('t2', at(12, 0, 30), 'ok', hb('think'), { cause: 'rearm' }))
    expect(JSON.stringify(store.state('x'))).toBe(before)
  })
})
