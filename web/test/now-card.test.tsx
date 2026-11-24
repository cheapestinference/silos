// now-card.test.tsx — what counts as "now" on the agent page: an open
// question, live work, or a reply you haven't read within a day. Older
// unread conversations keep their dot elsewhere but never make this card.
import { describe, expect, it } from 'vitest'
import { liveSessions, agentSignal, RECENT_MS } from '../src/components/agent/NowCard'
import type { AgentView, SessionView } from '../src/lib/types'

const NOW = 1_800_000_000_000
function session(o: Partial<SessionView>): SessionView {
  return { id: 'x', folder: 'f', title: 't', mtime: NOW - 60_000, agentId: 'a', skills: [], live: false, worktree: false, native: true, ...o } as SessionView
}
function agent(sessions: SessionView[]): AgentView {
  return { id: 'a', name: 'A', emoji: '·', folder: '/f', skills: [], sessions, liveCount: 0, sessionCount: sessions.length }
}

describe('liveSessions', () => {
  it('an unanswered question is "asks", first — even over a working one', () => {
    const rows = liveSessions(
      agent([session({ id: 'w', turnOpen: true, mtime: NOW - 10_000 }), session({ id: 'q', pendingAsk: true, turnOpen: true, mtime: NOW - 3_600_000 })]),
      NOW,
    )
    expect(rows.map((r) => [r.s.id, r.state])).toEqual([
      ['q', 'asks'],
      ['w', 'working'],
    ])
  })
  it('an unread reply counts only within a day; a ten-day-old one is not "now"', () => {
    const rows = liveSessions(
      agent([
        session({ id: 'fresh', unread: true, lastRole: 'assistant', mtime: NOW - 3_600_000 }),
        session({ id: 'stale', unread: true, lastRole: 'assistant', mtime: NOW - RECENT_MS - 1 }),
      ]),
      NOW,
    )
    expect(rows.map((r) => r.s.id)).toEqual(['fresh'])
    expect(rows[0]!.state).toBe('replied')
  })
  it('an idle, read conversation is nothing', () => {
    expect(liveSessions(agent([session({ lastRole: 'assistant', mtime: NOW - 10_000 })]), NOW)).toEqual([])
  })
})

describe('agentSignal (the seal ring)', () => {
  it('a question → attention; only work → working; only a fresh reply → attention; nothing → null', () => {
    expect(agentSignal(agent([session({ pendingAsk: true, turnOpen: true }), session({ id: 'w', turnOpen: true })]), NOW)).toBe('attention')
    expect(agentSignal(agent([session({ turnOpen: true })]), NOW)).toBe('working')
    expect(agentSignal(agent([session({ unread: true, lastRole: 'assistant' })]), NOW)).toBe('attention')
    expect(agentSignal(agent([session({ unread: true, lastRole: 'assistant', mtime: NOW - RECENT_MS - 1 })]), NOW)).toBeNull()
  })
})

// a finished automation run is not a reply waiting for you
describe('automation-born sessions (origin) and the agent-level signal', () => {
  const born = (o: Partial<SessionView>) => session({ origin: { kind: 'automation', automationId: 'auto', runId: 'r' }, ...o })
  it('a fresh run reply is NOT "replied" — no seal ring, no Now row', () => {
    const a = agent([born({ id: 'r1', lastRole: 'assistant', unread: true })])
    expect(liveSessions(a, NOW)).toEqual([])
    expect(agentSignal(a, NOW)).toBeNull()
  })
  it('a run that asks still reaches you; a run still working still blinks', () => {
    const asks = agent([born({ id: 'r2', pendingAsk: true })])
    expect(liveSessions(asks, NOW)[0]?.state).toBe('asks')
    expect(agentSignal(asks, NOW)).toBe('attention')
    const working = agent([born({ id: 'r3', lastRole: 'user', mtime: NOW - 1000 })])
    expect(liveSessions(working, NOW)[0]?.state).toBe('working')
    expect(agentSignal(working, NOW)).toBe('working')
  })
})

// a conversation Silos once opened for a message (origin 'message',
// history): its answer reaches the owner on the message, never as a «replied»
describe('message-born conversations (origin message)', () => {
  const opened = (o: Partial<SessionView>) => session({ origin: { kind: 'message', messageId: 'm1', from: 'finance', gist: 'pay it' }, ...o })
  it('a finished one is NOT «replied»; one at work still blinks', () => {
    const done = agent([opened({ id: 'm1', lastRole: 'assistant', unread: true })])
    expect(liveSessions(done, NOW)).toEqual([])
    expect(agentSignal(done, NOW)).toBeNull()
    const working = agent([opened({ id: 'm2', lastRole: 'user', mtime: NOW - 1000 })])
    expect(liveSessions(working, NOW)[0]?.state).toBe('working')
  })
})
