import { describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { messagesNeedsYou } from '../src/needs-you.js'
import { MessageStore } from '../src/messages.js'
import type { Agent } from '../src/types.js'

function agent(overrides: Partial<Agent> = {}): Agent {
  return { id: 'finance', name: 'FINANCE', emoji: '💰', role: '', folder: null, skills: [], ...overrides }
}

describe('messagesNeedsYou', () => {
  it('a needs_owner message appears once, with recipient and sender', () => {
    const messages = new MessageStore(mkdtempSync(join(tmpdir(), 'needs-you-msg-')))
    const m = messages.send({ from: 'builder', to: 'finance', text: 'need the owner to sign' })
    messages.send({ from: 'builder', to: 'finance', text: 'just fyi' })
    messages.setState('finance', m.id, 'needs_owner')
    const agents = [agent({ id: 'finance' }), agent({ id: 'builder', name: 'BUILDER' })]
    expect(messagesNeedsYou(agents, messages)).toEqual([
      { kind: 'message', agentId: 'finance', from: 'builder', messageId: m.id, text: 'need the owner to sign', at: m.at },
    ])
  })

  it('marking it answered or read removes it', () => {
    const messages = new MessageStore(mkdtempSync(join(tmpdir(), 'needs-you-msg-')))
    const a = messages.send({ from: 'builder', to: 'finance', text: 'a' })
    const b = messages.send({ from: 'owner', to: 'builder', text: 'b' })
    messages.setState('finance', a.id, 'needs_owner')
    messages.setState('builder', b.id, 'needs_owner')
    const agents = [agent({ id: 'finance' }), agent({ id: 'builder' })]
    expect(messagesNeedsYou(agents, messages)).toHaveLength(2)
    messages.setState('finance', a.id, 'answered')
    messages.setState('builder', b.id, 'read')
    expect(messagesNeedsYou(agents, messages)).toEqual([])
  })
})
