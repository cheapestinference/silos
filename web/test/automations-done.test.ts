import { describe, expect, it } from 'vitest'
import { doneLabel, isDone } from '../src/lib/automations'
import type { Automation } from '../src/lib/types'

// A `once` automation that has run is DONE — a terminal state of its own,
// not "paused". The resident parks a fired once as paused:true (it has no
// other switch), and every surface read that word literally: the builder's
// sidebar counted 12 automations of which 9 were finished probes, each
// offering a "Resume" that would have re-fired the probe.
// The rule lives here once; sidebar, column, agent page and Board read it.
const once = (over: Partial<Automation> = {}): Automation => ({
  id: 'p1',
  name: 'Probe',
  agentId: 'a1',
  prompt: 'p',
  trigger: { kind: 'once', at: '2026-08-29T10:00:00Z' },
  thread: { mode: 'new' },
  approval: false,
  keepAlive: false,
  paused: true,
  createdAt: '2026-08-29T09:00:00Z',
  lastRun: { at: '2026-08-29T10:00:30Z', status: 'ok', durationMs: 1000 },
  ...over,
})

describe('isDone — a once that has run', () => {
  it('a fired once (paused by the resident, with a last run) is done', () => {
    expect(isDone(once())).toBe(true)
  })
  it('a once paused BEFORE it fired is paused, not done', () => {
    expect(isDone(once({ lastRun: undefined }))).toBe(false)
  })
  it('a once that has not fired and is armed is neither', () => {
    expect(isDone(once({ paused: false, lastRun: undefined }))).toBe(false)
  })
  it('a paused cron with runs is paused — only a once finishes', () => {
    expect(isDone(once({ trigger: { kind: 'cron', expr: '0 9 * * *' } }))).toBe(false)
  })
  it('a once that fired and failed, or was skipped (missed by >6h), is done too — it will not fire again', () => {
    expect(isDone(once({ lastRun: { at: '2026-08-29T10:00:30Z', status: 'failed', durationMs: 5 } }))).toBe(true)
    expect(isDone(once({ lastRun: { at: '2026-08-29T10:00:30Z', status: 'skipped', durationMs: 0 } }))).toBe(true)
  })
})

describe('doneLabel — what a finished once says instead of "paused"', () => {
  it('ran <date> on success', () => {
    expect(doneLabel(once())).toMatch(/^ran /)
  })
  it('failed <date> / skipped <date> otherwise — the outcome, not a switch', () => {
    expect(doneLabel(once({ lastRun: { at: '2026-08-29T10:00:30Z', status: 'failed', durationMs: 5 } }))).toMatch(/^failed /)
    expect(doneLabel(once({ lastRun: { at: '2026-08-29T10:00:30Z', status: 'skipped', durationMs: 0 } }))).toMatch(/^skipped /)
  })
})
