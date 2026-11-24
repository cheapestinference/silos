// OpenCode's question tool as a conversation's pending question: its own
// options (more = questions 2..n), and only while its tool call still waits.
import { describe, it, expect } from 'vitest'
import { pendingOf, stillAsking } from '../src/harnesses/opencode/reader.js'
import type { PendingAsk } from '../src/asks-store.js'
import type { PartRow } from '../src/harnesses/opencode/db.js'

const q = (over: Partial<PendingAsk> = {}): PendingAsk => ({
  agentId: 'writer',
  sessionId: 'ses_q',
  id: 'que_1',
  type: 'question',
  pattern: null,
  title: 'Deploy now?',
  askedAt: '2026-11-01T10:00:00.000Z',
  questions: [
    {
      question: 'Deploy now?',
      header: 'Deploy',
      options: [
        { label: 'Now', description: 'ship' },
        { label: 'Wait', description: '' },
      ],
    },
    { question: 'Regions?', header: '', options: [{ label: 'eu', description: '' }], multiple: true },
  ],
  callId: 'call_1',
  ...over,
})
const part = (callID: string, status: string): PartRow =>
  ({
    id: 'p',
    message_id: 'm',
    session_id: 'ses_q',
    time_created: 1,
    data: { type: 'tool', tool: 'question', callID, state: { status } },
  }) as unknown as PartRow

describe('pendingOf — questions', () => {
  it('shows the question with its own options, the rest as more', () => {
    expect(pendingOf([q()])).toEqual({
      question: 'Deploy now?',
      header: 'Deploy',
      options: [{ label: 'Now', description: 'ship' }, { label: 'Wait' }],
      more: [{ question: 'Regions?', options: [{ label: 'eu' }], multiSelect: true }],
      askedAt: '2026-11-01T10:00:00.000Z',
    })
  })
  it('a permission is still Allow / Deny', () => {
    const p = pendingOf([{ agentId: 'writer', sessionId: 's', id: 'per', type: 'bash', pattern: 'rm *', title: null, askedAt: 'x' }])
    expect(p?.options).toEqual([{ label: 'Allow' }, { label: 'Deny' }])
  })
})

describe('stillAsking', () => {
  it('waits while its tool call is pending or running, or not written yet', () => {
    expect(stillAsking(q(), [part('call_1', 'running')])).toBe(true)
    expect(stillAsking(q(), [part('call_1', 'pending')])).toBe(true)
    expect(stillAsking(q(), [part('other', 'completed')])).toBe(true)
  })
  it('a call that completed or failed (answered, rejected, its process died) is stale', () => {
    expect(stillAsking(q(), [part('call_1', 'completed')])).toBe(false)
    expect(stillAsking(q(), [part('call_1', 'error')])).toBe(false)
  })
  it('a permission ask is never judged by tool parts', () => {
    expect(stillAsking({ ...q(), type: 'bash', callId: undefined }, [part('call_1', 'completed')])).toBe(true)
  })
})
