// Home with active silos (Silo Standard): the sixth needs-you
// source through the same inbox, the budget that folds due/routine, the
// pulse clause and Done today — and nothing at all while no silo is active.
import { describe, expect, it } from 'vitest'
import { fleet, headline, platformDoneLine, scopeToFolder, siloDoneInFolder, siloGrowthLines, siloPulseClause, siloWithProducerLines } from '../src/lib/home'
import { siloRow } from './inbox-rows'
import type { AgentView, SiloDoneItem, SiloNeedsYou } from '../src/lib/types'

const item = (over: Partial<SiloNeedsYou>): SiloNeedsYou => ({
  kind: 'silo',
  reason: 'entry',
  silo: 'invoices',
  siloName: 'Invoices',
  key: 'agent:finance/a1',
  recordKind: 'invoice',
  urgency: 'due',
  text: 'F-1 · Acme SL — outstanding · due Oct 28',
  at: '2026-10-02',
  agentId: 'finance',
  file: '/x/a1.json',
  ...over,
})
const empty = { agents: [], cards: [], needsYou: [], pending: [], automations: [] }
const agent = (id: string, folder = `/p/${id}`): AgentView => ({ id, name: id, emoji: '', folder, sessions: [], archived: false }) as unknown as AgentView

// the silo budget and folding are composed by the server — server/test/inbox.test.ts
describe('silo rows in the inbox', () => {
  it('the headline speaks the silo row in its own words', () => {
    const inbox = [siloRow(item({}))]
    const h = headline({ inbox, working: [], agentName: (id) => id, now: 0, ago: () => '' })
    expect(h).toContain('Invoices')
    expect(h).toContain('F-1 · Acme SL — outstanding · due Oct 28')
  })
})

describe('the pulse clause', () => {
  it("appends the silos' terms; none = the sentence as it always was", () => {
    expect(siloPulseClause(undefined)).toBe('')
    expect(siloPulseClause([])).toBe('')
    const base = headline({ inbox: [], working: [], agentName: (id) => id, now: 0, ago: () => '' })
    expect(headline({ inbox: [], working: [], agentName: (id) => id, now: 0, ago: () => '', silos: [] })).toBe(base)
    expect(
      headline({
        inbox: [],
        working: [],
        agentName: (id) => id,
        now: 0,
        ago: () => '',
        silos: [
          { silo: 'invoices', siloName: 'Invoices', term: '€150.50 outstanding' },
          { silo: 'support', siloName: 'Support', term: '3 cases' },
        ],
      }),
    ).toBe(`${base} Invoices: €150.50 outstanding · Support: 3 cases.`)
  })
})

describe('Done today and scope', () => {
  const done: SiloDoneItem = {
    silo: 'invoices',
    siloName: 'Invoices',
    key: 'agent:finance/a1',
    recordKind: 'invoice',
    identity: 'F-1 · Acme SL',
    to: 'paid',
    toLabel: 'paid',
    at: '2026-10-30T10:00:00Z',
    agentId: 'finance',
  }
  it("a closed record rides its agent's fleet row", () => {
    const rows = fleet([agent('finance'), agent('writer')], [], 0, 'master', [done])
    expect(rows.find((r) => r.agent.id === 'finance')!.siloDone).toEqual([done])
    expect(rows.find((r) => r.agent.id === 'writer')!.siloDone).toEqual([])
  })
  it('a project page keeps the silo rows and lines that belong to its folder', () => {
    const input = {
      ...empty,
      agents: [agent('finance', '/p/acme')],
      needsYou: [item({}), item({ key: 'f', agentId: undefined, folder: '/p/other' }), item({ key: 'g', agentId: undefined, folder: '/p/acme/sub' })],
    }
    expect(scopeToFolder(input, '/p/acme', 'master').needsYou.map((n) => (n as SiloNeedsYou).key)).toEqual(['agent:finance/a1', 'g'])
    expect(siloDoneInFolder([done, { ...done, key: 'x', agentId: undefined, folder: '/p/other' }], '/p/acme', new Set(['finance']))).toEqual([done])
  })
})

describe('a pending submission in the inbox', () => {
  const sub = item({
    reason: 'submission',
    silo: 'support',
    siloName: 'Support',
    key: 'submission',
    recordKind: 'silo',
    file: null,
    agentId: undefined,
    text: '0.1.0 waits for your approval to install — submitted by finance',
    at: '2026-10-31T10:00:00Z',
    submission: { kind: 'install', from: null, to: '0.1.0', submittedBy: 'finance', source: 'body' },
  })
  it('the headline says it', () => {
    expect(headline({ inbox: [siloRow(sub)], working: [], agentName: (id) => id, now: 0, ago: () => '' })).toBe(
      'Support: 0.1.0 waits for your approval to install — submitted by finance.',
    )
  })
})

describe('records an uninstalled silo keeps growing', () => {
  it('the term verbatim, one line per silo; none = no line', () => {
    expect(siloGrowthLines(undefined)).toEqual([])
    expect(siloGrowthLines([])).toEqual([])
    const t = {
      silo: 'invoices',
      siloName: 'Invoices',
      records: 12,
      since: '2026-10-30T12:00:00Z',
      term: "12 records written to Invoices's files since it was uninstalled — no silo shows them",
    }
    expect(siloGrowthLines([t, { ...t, term: 'dup' }, { ...t, silo: 'empty', records: 0 }])).toEqual([{ silo: 'invoices', text: t.term }])
  })
})

describe('rows the operator routed to a producer (audience: producer-agent)', () => {
  const w = { silo: 'invoices', siloName: 'Invoices', agentId: 'finance', recordKind: 'invoice', entry: 0, count: 674, oldest: '2026-02-27' }
  const done: SiloDoneItem = {
    silo: 'invoices',
    siloName: 'Invoices',
    key: 'k',
    recordKind: 'invoice',
    identity: 'F-1',
    to: 'paid',
    toLabel: 'paid',
    at: '2026-10-31T10:00:00Z',
  }
  it('one calm line: the count, who has them, and what the producer closed today', () => {
    expect(
      siloWithProducerLines([w], [done, { ...done, key: 'k2' }, { ...done, key: 'k3', silo: 'other' }], (id) => (id === 'finance' ? 'Finance' : id)),
    ).toEqual([{ silo: 'invoices', agentId: 'finance', text: '674 invoices are with Finance · 2 closed today' }])
  })
  it('singular, zero closures, and nothing at count 0', () => {
    expect(siloWithProducerLines([{ ...w, count: 1 }], [], (id) => id)).toEqual([{ silo: 'invoices', agentId: 'finance', text: '1 invoice is with finance' }])
    expect(siloWithProducerLines([{ ...w, count: 0 }], [], (id) => id)).toEqual([])
    expect(siloWithProducerLines(undefined, [], (id) => id)).toEqual([])
  })
})

describe('Done today for platform data (a kernel source)', () => {
  const reset: SiloDoneItem = {
    silo: 'executions',
    siloName: 'Executions',
    key: 'platform/billing-export',
    recordKind: 'execution',
    identity: 'Billing export',
    to: 'done',
    toLabel: 'done',
    at: '2026-11-01T05:00:30Z',
  }
  it('a record that belongs to no agent and no folder gets its own line — no fleet row would carry it', () => {
    expect(fleet([agent('finance')], [], 0, 'master', [reset])[0]!.siloDone).toEqual([])
    expect(platformDoneLine([reset, { ...reset, key: 'k2', identity: 'Search reindex' }])).toEqual({
      silo: 'executions',
      text: 'done today — Billing export done, Search reindex done',
    })
  })
  it('records with an agent or a folder are not platform data; nothing = no line', () => {
    expect(
      platformDoneLine([
        { ...reset, agentId: 'finance' },
        { ...reset, folder: '/p' },
      ]),
    ).toBeNull()
    expect(platformDoneLine(undefined)).toBeNull()
  })
})
