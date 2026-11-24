import { describe, it, expect } from 'vitest'
import { capSessionsByKind } from '../src/overview-cap.js'

describe('capSessionsByKind', () => {
  const caps = { conversations: 2, runsPerAutomation: 2 }
  it('trims conversations and runs per automation apart', () => {
    const list = [
      { id: 'c1' },
      { id: 'r1', origin: { kind: 'automation' as const, automationId: 'a' } },
      { id: 'c2' },
      { id: 'r2', origin: { kind: 'automation' as const, automationId: 'a' } },
      { id: 'c3' },
      { id: 'r3', origin: { kind: 'automation' as const, automationId: 'a' } },
    ]
    expect(capSessionsByKind(list, caps).map((s) => s.id)).toEqual(['c1', 'r1', 'c2', 'r2'])
  })

  // nested runs (births): never eat the owner's conversation slots; capped
  // per parent like runs per automation, so the newest of each survives.
  it('nested runs are capped per parent, apart from conversations', () => {
    const n = (id: string, parent: string | null) => ({ id, origin: { kind: 'nested' as const, parent, agentId: 'builder' } })
    const list = [n('n1', 'p'), n('n2', 'p'), n('n3', 'p'), n('m1', null), { id: 'c1' }, { id: 'c2' }]
    expect(capSessionsByKind(list, caps).map((s) => s.id)).toEqual(['n1', 'n2', 'm1', 'c1', 'c2'])
  })

  // message conversations (origin message): capped per
  // agent apart from the owner's conversations, so months of them never push
  // the owner's out of the list
  it('message conversations are capped per agent, apart from conversations', () => {
    const m = (id: string, agentId: string) => ({ id, agentId, origin: { kind: 'message' as const, messageId: id } })
    const list = [m('m1', 'builder'), m('m2', 'builder'), m('m3', 'builder'), m('x1', 'finance'), { id: 'c1' }, { id: 'c2' }]
    expect(capSessionsByKind(list, { ...caps, messagesPerAgent: 2 }).map((s) => s.id)).toEqual(['m1', 'm2', 'x1', 'c1', 'c2'])
  })
})
