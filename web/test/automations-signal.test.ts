import { describe, expect, it } from 'vitest'
import { automationsSignal, isBeatAutomation } from '../src/lib/automations-signal'
import type { Automation } from '../src/lib/types'

function auto(id: string, agentId: string, status?: 'ok' | 'failed' | 'running'): Automation {
  return { id, agentId, lastRun: status ? { status } : undefined } as unknown as Automation
}

describe('automationsSignal', () => {
  it('counts only the agent asked for, and nothing when it has none', () => {
    const all = [auto('a', 'builder'), auto('b', 'builder'), auto('c', 'finance')]
    expect(automationsSignal(all, [], 'builder')).toMatchObject({ count: 2, state: null })
    expect(automationsSignal(all, [], 'writer')).toMatchObject({ count: 0, state: null })
    expect(automationsSignal(all, [], 'finance').count).toBe(1)
  })

  it('needs-you wins over working: a failed last run, or a run waiting for approval', () => {
    const all = [auto('a', 'builder', 'failed'), auto('b', 'builder', 'running')]
    expect(automationsSignal(all, [], 'builder')).toMatchObject({ state: 'needs-you', failed: 1, running: 1 })
    const waiting = [auto('a', 'builder', 'ok')]
    expect(automationsSignal(waiting, [{ automationId: 'a' }, { automationId: 'a' }], 'builder')).toMatchObject({
      state: 'needs-you',
      waiting: 1,
    })
  })

  it('working only while a run goes and nothing needs the owner', () => {
    expect(automationsSignal([auto('a', 'builder', 'running')], [], 'builder')).toMatchObject({ state: 'working', running: 1 })
  })

  it("without an agent it reads across every agent (the rail's global dot)", () => {
    const all = [auto('a', 'builder', 'ok'), auto('b', 'finance', 'failed')]
    expect(automationsSignal(all, [])).toMatchObject({ count: 2, state: 'needs-you', failed: 1 })
    // a pending run of another agent's automation never counts for this one
    expect(automationsSignal(all, [{ automationId: 'b' }], 'builder').state).toBe(null)
  })

  // The beat leaves every automations enumeration, the
  // ⚡ included — a FAILED beat already reaches Needs you as the inbox's
  // failed-run row and opens the «In charge of» card itself, so a terracotta
  // bolt here would be a second, vaguer door to the same fact.
  it('beats (heartbeat-*) never count, light, or blink the ⚡ — per agent or globally', () => {
    const all = [auto('heartbeat-builder', 'builder', 'failed'), auto('b', 'builder', 'ok')]
    expect(automationsSignal(all, [], 'builder')).toMatchObject({ count: 1, failed: 0, state: null })
    expect(automationsSignal(all, [])).toMatchObject({ count: 1, state: null })
    // an agent whose ONLY automation is its beat shows no glyph at all (count 0)
    expect(automationsSignal([auto('heartbeat-finance', 'finance', 'running')], [], 'finance')).toMatchObject({ count: 0, running: 0, state: null })
    // a beat's run waiting for approval doesn't light it either — it is in the inbox
    expect(automationsSignal([auto('heartbeat-finance', 'finance', 'ok')], [{ automationId: 'heartbeat-finance' }], 'finance').state).toBe(null)
  })

  it('isBeatAutomation is the one shared predicate: the id prefix, nothing else', () => {
    expect(isBeatAutomation({ id: 'heartbeat-finance' })).toBe(true)
    expect(isBeatAutomation({ id: 'heartbeat-' })).toBe(true)
    expect(isBeatAutomation({ id: 'daily-digest' })).toBe(false)
    expect(isBeatAutomation({ id: 'resp-finance' })).toBe(false)
  })
})
