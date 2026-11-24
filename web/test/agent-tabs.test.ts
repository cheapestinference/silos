// agent-tabs.test.ts — the agent page's tabs are ONE list (lib/agent-tabs.ts):
// the page's tab bar and the conversation header's ▾ menu both draw it, so its
// order, its Anywhere exceptions and its count rules are the contract.
import { describe, expect, it } from 'vitest'
import { agentTabs } from '../src/lib/agent-tabs'
import { MASTER_ID } from '../src/lib/constants'

const base = { agentId: 'builder', live: false, inboxNew: 0, src: null, secrets: null, atStartTotal: null }

describe('agentTabs', () => {
  it('a regular agent: Now … At start, then Profile apart; each with its facet', () => {
    const t = agentTabs(base)
    expect(t.map((x) => x.id)).toEqual(['now', 'messages', 'automations', 'files', 'memory', 'skills', 'tools', 'secrets', 'starts', 'settings'])
    expect(t.filter((x) => x.apart).map((x) => x.id)).toEqual(['settings'])
    expect(t.find((x) => x.id === 'settings')?.facet).toBe('identity')
    expect(t.find((x) => x.id === 'messages')?.facet).toBe('inbox')
    // what it does without you is set on its own tab — the old «control» address lands there
    expect(t.find((x) => x.id === 'automations')?.facet).toBe('control')
  })

  it('Anywhere has no Secrets and no Profile of its own', () => {
    expect(agentTabs({ ...base, agentId: MASTER_ID }).map((x) => x.id)).toEqual([
      'now',
      'messages',
      'automations',
      'files',
      'memory',
      'skills',
      'tools',
      'starts',
    ])
  })

  it('automations: their count, accented when one failed or waits for approval', () => {
    const sig = (a: { n: number; alert: boolean }) => agentTabs({ ...base, automations: a }).find((x) => x.id === 'automations')?.signal
    expect(sig({ n: 3, alert: false })).toEqual({ kind: 'count', text: '3', accent: false })
    expect(sig({ n: 1, alert: true })).toEqual({ kind: 'count', text: '1', accent: true })
  })

  it('figures: unread messages accented, files summed, only active skills, At start in k; unread → no figure', () => {
    const t = agentTabs({
      ...base,
      live: true,
      inboxNew: 2,
      secrets: 4,
      atStartTotal: 67_400,
      src: {
        memory: null,
        catalog: [{ state: 'active' }, { state: 'held' }, {}] as never,
        context: { agent: [{}] as never, shared: [{}, {}] as never },
        produced: [{}] as never,
        loaded: { mcp: [{}, {}, {}] } as never,
      },
    })
    const sig = Object.fromEntries(t.map((x) => [x.id, x.signal]))
    expect(sig.now).toEqual({ kind: 'dot' })
    expect(sig.automations).toBeNull()
    expect(sig.messages).toEqual({ kind: 'count', text: '2', accent: true })
    expect(sig.memory).toBeNull()
    expect(sig.files).toEqual({ kind: 'count', text: '4', accent: false })
    expect(sig.skills).toEqual({ kind: 'count', text: '2', accent: false })
    expect(sig.tools).toEqual({ kind: 'count', text: '3', accent: false })
    expect(sig.secrets).toEqual({ kind: 'count', text: '4', accent: false })
    expect(sig.starts).toEqual({ kind: 'count', text: '~67k', accent: false })
  })
})
