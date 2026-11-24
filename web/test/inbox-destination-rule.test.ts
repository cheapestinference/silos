import { describe, expect, it } from 'vitest'
import { inboxDestination } from '../src/lib/inbox-destination'
import { automationsPageView, isBeatAutomation } from '../src/lib/automations-signal'
import type { InboxRow } from '../src/lib/types'

// A usage-limit row lists every automation it stopped, beats included, across
// agents. Wherever it lands, every beat in its subject must be named there
// with a door to its home (doors are never dead ends).
type Ref = { id: string; name: string; agentId: string }
function limitRow(automations: Ref[]): InboxRow {
  return {
    kind: 'accountLimit',
    key: 'account-limit:default',
    urgency: 'due',
    at: 0,
    voice: '',
    clears: '',
    provider: 'default',
    account: 'Claude',
    window: null,
    automations,
    agentIds: [...new Set(automations.map((a) => a.agentId))],
  } as unknown as InboxRow
}
const beat = (agentId: string): Ref => ({ id: `heartbeat-${agentId}`, name: `${agentId} heartbeat`, agentId })
const plain = (id: string, agentId: string): Ref => ({ id, name: id, agentId })

// every beat of the row reachable on the landing it opens
function beatsReachable(row: InboxRow, all: Ref[]): boolean {
  if (row.kind !== 'accountLimit') throw new Error('limit rows only')
  const beats = [...new Set(row.automations.filter(isBeatAutomation).map((a) => a.agentId))]
  const dest = inboxDestination(row)
  if (!dest) return false
  if (dest.page?.kind === 'automation') return beats.every((b) => dest.page?.kind === 'automation' && dest.page.id === `heartbeat-${b}`)
  if (!dest.page || dest.page.kind !== 'automations') return beats.length === 0
  const view = automationsPageView(all, dest.page.agent)
  return beats.every((b) => view.beatAgentIds.includes(b))
}

describe('inboxDestination — a limit row that stopped beats', () => {
  it("one agent's beat alone opens its own check-in page", () => {
    expect(inboxDestination(limitRow([beat('builder')]))).toEqual({ kind: 'page', page: { kind: 'automation', id: 'heartbeat-builder' } })
  })

  it("two agents' beats: the whole list, which names both beats with doors", () => {
    const row = limitRow([beat('builder'), beat('finance')])
    const all = [beat('builder'), beat('finance')]
    expect(inboxDestination(row)).toEqual({ kind: 'page', page: { kind: 'automations' } })
    expect(beatsReachable(row, all)).toBe(true)
    // only heartbeats in scope: «No automations yet» must not be the answer
    expect(automationsPageView(all).empty).toBe('beats')
    expect(automationsPageView(all).beatAgentIds).toEqual(['builder', 'finance'])
  })

  it('mixed: beats of two agents beside ordinary automations — listed AND the beats named', () => {
    const all = [beat('builder'), beat('finance'), plain('daily', 'builder'), plain('invoices', 'writer')]
    const row = limitRow([beat('builder'), plain('daily', 'builder'), beat('finance')])
    expect(beatsReachable(row, all)).toBe(true)
    const view = automationsPageView(all)
    expect(view.empty).toBe(null)
    expect(view.listed.map((a) => a.id)).toEqual(['daily', 'invoices'])
    expect(view.beatAgentIds).toEqual(['builder', 'finance'])
  })

  it("one agent's beat plus its automations: its filtered page names the beat", () => {
    const all = [beat('builder'), plain('daily', 'builder'), beat('finance')]
    const row = limitRow([beat('builder'), plain('daily', 'builder')])
    expect(inboxDestination(row)).toEqual({ kind: 'page', page: { kind: 'automations', agent: 'builder' } })
    expect(beatsReachable(row, all)).toBe(true)
    // filtered, another agent's beat isn't this page's to name
    expect(automationsPageView(all, 'builder').beatAgentIds).toEqual(['builder'])
  })

  it('nothing at all is the only honest «No automations yet»', () => {
    expect(automationsPageView([]).empty).toBe('none')
    expect(automationsPageView([beat('finance')], 'builder').empty).toBe('none')
    expect(automationsPageView([beat('finance')], 'finance').empty).toBe('beats')
  })
})
