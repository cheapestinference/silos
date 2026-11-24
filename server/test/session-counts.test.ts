import { describe, it, expect } from 'vitest'
import { countSessions, emptyCounts } from '../src/session-counts.js'

// One rule for every surface that prints a count: a conversation is a
// session with no automation origin, a run is one an automation opened,
// and the totals cover EVERY session (the overview's lists are capped).
describe('countSessions', () => {
  it('splits conversations from runs per agent, runs per automation, both per cwd', () => {
    const c = countSessions([
      { agentId: 'builder', cwd: '/p', origin: null },
      { agentId: 'builder', cwd: '/p', origin: { automationId: 'hourly' } },
      { agentId: 'builder', cwd: '/p', origin: { automationId: 'hourly' } },
      { agentId: 'builder', cwd: '/p/sub', origin: { automationId: 'daily' } },
      { agentId: 'master', cwd: null },
      { agentId: 'master', cwd: '/p' },
    ])
    expect(c.get('builder')).toEqual({
      conversations: 1,
      runs: 3,
      runsByAutomation: { hourly: 2, daily: 1 },
      byCwd: { '/p': { conversations: 1, runs: 2 }, '/p/sub': { conversations: 0, runs: 1 } },
    })
    expect(c.get('master')).toEqual({
      conversations: 2,
      runs: 0,
      runsByAutomation: {},
      byCwd: { '': { conversations: 1, runs: 0 }, '/p': { conversations: 1, runs: 0 } },
    })
    expect(c.get('nobody')).toBeUndefined()
  })

  it('no sessions -> an empty map; emptyCounts is all zero', () => {
    expect(countSessions([]).size).toBe(0)
    expect(emptyCounts()).toEqual({ conversations: 0, runs: 0, runsByAutomation: {}, byCwd: {} })
  })

  // a nested run (an agent's own `claude -p`) is neither one of the owner's
  // conversations nor an automation run; the ones with no indexed parent
  // conversation to fold under are the agent's own (`nestedLoose`).
  it('nested runs count as neither; loose ones (no parent, or parent not indexed) are counted apart', () => {
    const c = countSessions(
      [
        { agentId: 'builder', cwd: '/p', origin: null },
        { agentId: 'builder', cwd: '/p', origin: { kind: 'nested', parent: null } },
        { agentId: 'builder', cwd: '/p', origin: { kind: 'nested', parent: 'gone' } },
        { agentId: 'builder', cwd: '/p', origin: { kind: 'nested', parent: 'conv' } },
      ],
      new Set(['conv']),
    )
    expect(c.get('builder')).toEqual({ conversations: 1, runs: 0, runsByAutomation: {}, byCwd: { '/p': { conversations: 1, runs: 0 } }, nestedLoose: 2 })
  })

  it("message conversations count as neither the owner's conversations nor runs — apart, per agent", () => {
    const c = countSessions([
      { agentId: 'builder', cwd: '/p', origin: null },
      { agentId: 'builder', cwd: '/p', origin: { kind: 'message' } },
      { agentId: 'builder', cwd: '/p', origin: { kind: 'message' } },
    ])
    expect(c.get('builder')).toEqual({
      conversations: 1,
      runs: 0,
      runsByAutomation: {},
      byCwd: { '/p': { conversations: 1, runs: 0 } },
      messageConversations: 2,
    })
  })
})
