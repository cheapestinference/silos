// silo-view.test.ts — the pure derivations behind the silo pages (Task 8):
// what is visible where (active / rail-granted), facet adapters with the
// server's single-value contract, column words, values in voice, the record's
// story in the standard's honesty, and the template preview.
import { describe, expect, it } from 'vitest'
import {
  activeSilos,
  anchorLinks,
  columnAlign,
  columnHeader,
  editorFor,
  facetLabel,
  facetsToBars,
  fillTemplate,
  filterToFacets,
  isTerminal,
  momentWord,
  overlayRows,
  parseEdit,
  proposalWords,
  railSilos,
  siloHeaderParts,
  producerAgent,
  singleValuePerFacet,
  stateWord,
  storyOf,
  valueWord,
} from '../src/lib/silo-view'
import type { SiloDescriptor, SiloJournalLine, SiloRecordDetail, SiloStateWord } from '../src/lib/types'

const descriptor = (over: Partial<SiloDescriptor> = {}): SiloDescriptor => ({
  id: 'invoices',
  name: 'Invoices',
  description: 'invoices',
  version: '0.1.0',
  apiVersion: 'silo-standard/v0',
  state: 'active',
  reason: 'active',
  conventions: [],
  wants: [],
  kinds: ['invoices/invoice'],
  producer: { role: 'finance', sync: 'Ledgerly' },
  records: { parsed: 614, failed: 2 },
  lastWrite: null,
  freshness: null,
  slots: { requested: ['pulse'], granted: ['pulse'], off: [] },
  observedAt: '2026-10-30T12:00:00Z',
  ...over,
})

const STATES: SiloStateWord[] = [
  { value: 'open', one: 'outstanding', many: 'outstanding', terminal: false },
  { value: 'paid', one: 'paid', many: 'paid', terminal: true },
]

describe('what is visible where', () => {
  it('only active silos are destinations; only rail-granted ones get a rail door', () => {
    const silos = [
      descriptor(),
      descriptor({ id: 'docs', state: 'pending' }),
      descriptor({ id: 'rail-one', slots: { requested: ['rail'], granted: ['rail'], off: [] } }),
      descriptor({ id: 'rail-off', slots: { requested: ['rail'], granted: [], off: ['rail'] } }),
    ]
    expect(activeSilos(silos).map((s) => s.id)).toEqual(['invoices', 'rail-one', 'rail-off'])
    expect(railSilos(silos).map((s) => s.id)).toEqual(['rail-one'])
    expect(railSilos([])).toEqual([])
  })

  it('the header sentence is composed only of what the descriptor really says', () => {
    expect(siloHeaderParts(descriptor({ producers: ['finance'] }))[1]).toContain('finance')
    // the agents bound are who writes — a role is a word of the manifest, never an
    // agent: nobody bound names nobody (the binding line under it says «No producer yet»)
    expect(siloHeaderParts(descriptor()).join(' ')).not.toContain('finance')
    expect(siloHeaderParts(descriptor({ records: { parsed: 1, failed: 0 }, producer: { role: 'finance', sync: null } }))).toHaveLength(1)
    const two = siloHeaderParts(
      descriptor({ records: { parsed: 0, failed: 0 }, producer: { role: 'helpdesk', sync: null }, producers: ['finance', 'writer'] }),
    ).join(' ')
    expect(two).toContain('finance')
    expect(two).toContain('writer')
    expect(two).not.toContain('helpdesk')
    expect(siloHeaderParts(descriptor({ producers: [] })).join(' ')).not.toContain('finance')
    expect(siloHeaderParts(descriptor({ producer: null, freshness: { stale: true, term: 'no new invoices since Oct 25' } }))).toContain(
      'no new invoices since Oct 25',
    )
  })
})

describe('producerAgent — whom «Make it a task for X ›» names', () => {
  const agents = [
    { id: 'finance', name: 'Finance' },
    { id: 'writer', name: 'Writer', archived: true },
  ]
  it('only a binding names an agent — a role that happens to be an agent id names nobody', () => {
    expect(producerAgent({ producer: { role: 'finance', sync: null }, producers: null }, agents)).toBeNull()
    expect(producerAgent({ producer: { role: 'finance', sync: null }, producers: ['finance'] }, agents)).toEqual({ id: 'finance', name: 'Finance' })
    expect(producerAgent({ producer: { role: 'finance', sync: null }, producers: ['writer'] }, agents)).toBeNull() // archived
  })
})

describe('facets with the single-value contract', () => {
  it('maps server facets to chips; labels are the last dot segment', () => {
    expect(facetLabel('total.currency')).toBe('currency')
    expect(facetLabel('state')).toBe('state')
    const bars = facetsToBars({ facets: [{ name: 'total.currency', values: [{ value: 'EUR', label: 'EUR', count: 7 }] }] })
    expect(bars).toEqual([{ id: 'total.currency', label: 'currency', values: [{ value: 'EUR', label: 'EUR', count: 7 }] }])
  })
  it('a toggle that grows a set keeps only the value just added; clearing stays clearing', () => {
    const prev = { state: new Set(['open']) }
    expect(singleValuePerFacet(prev, { state: new Set(['open', 'paid']) })).toEqual({ state: new Set(['paid']) })
    expect(singleValuePerFacet(prev, { state: new Set<string>() })).toEqual({ state: new Set() })
    expect(singleValuePerFacet({}, { kind: new Set(['sale']) })).toEqual({ kind: new Set(['sale']) })
  })
  it('the query carries one value per facet', () => {
    expect(filterToFacets({ state: new Set(['open']), kind: new Set<string>() })).toEqual({ state: 'open' })
  })
})

describe('columns and states in plain words', () => {
  it('identity reads as the kind noun, at as date, dotted fields keep their last segment', () => {
    expect(columnHeader('identity', 'invoices/invoice')).toBe('invoice')
    expect(columnHeader('at', 'invoices/invoice')).toBe('date')
    expect(columnHeader('total.currency', 'invoices/invoice')).toBe('currency')
    expect(columnHeader('due', 'invoices/invoice')).toBe('due')
  })
  it('state words and terminals come from the kind, never invented', () => {
    expect(stateWord(STATES, 'open')).toBe('outstanding')
    expect(stateWord(STATES, 'weird')).toBe('weird')
    expect(isTerminal(STATES, 'paid')).toBe(true)
    expect(isTerminal(STATES, 'open')).toBe(false)
  })
})

describe('values in voice', () => {
  it('money as money, states by their word, null as a dash', () => {
    expect(valueWord({ amount: 465.51, currency: 'EUR' })).toBe('€465.51')
    expect(valueWord('open', STATES)).toBe('outstanding')
    expect(valueWord(null)).toBe('—')
    expect(valueWord(true)).toBe('true')
  })
  it('a proposal line speaks the server voice', () => {
    expect(proposalWords({ verb: 'set-field', field: 'state', from: 'open', to: 'paid', by: 'finance' }, STATES)).toBe(
      'set-field state: outstanding → paid · proposed by finance',
    )
  })
})

describe('overlay and anchors', () => {
  it('overlay rows carry the owner value, the sealed base and the conflict', () => {
    const rows = overlayRows({
      overlay: {
        state: { value: 'paid', base: 'open', at: '2026-10-30T10:00:00Z', by: 'owner', conflict: { sourceValue: 'partial', seenAt: '2026-10-30T11:00:00Z' } },
        note: { value: 'x', base: null, at: '2026-10-30T10:00:00Z', by: 'owner' },
      },
    })
    expect(rows).toEqual([
      { field: 'state', owner: 'paid', base: 'open', at: '2026-10-30T10:00:00Z', conflict: { sourceValue: 'partial', seenAt: '2026-10-30T11:00:00Z' } },
      { field: 'note', owner: 'x', base: null, at: '2026-10-30T10:00:00Z', conflict: null },
    ])
    expect(overlayRows({ overlay: null })).toEqual([])
  })
  it('anchors become typed links; empty values are dropped', () => {
    expect(anchorLinks({ agent: 'finance', folder: '/p/x', junk: 3, empty: '' })).toEqual([
      { hub: 'agent', value: 'finance' },
      { hub: 'folder', value: '/p/x' },
    ])
  })
})

describe('the story — journal + events in the standard honesty', () => {
  const when = momentWord
  it('baseline says «arrived», a transition says both words and when it was seen', () => {
    const history: SiloJournalLine[] = [
      { at: '2026-10-29T09:00:00Z', event: 'baseline', to: 'open' },
      { at: '2026-10-30T12:00:00Z', event: 'transition', from: 'open', to: 'paid', prevSeenAt: '2026-10-29T09:00:00Z' },
    ]
    const events = [{ at: '2026-10-30T13:00:00Z', silo: 'invoices', verb: 'ack', by: 'owner', text: 'ack · by owner' }]
    const lines = storyOf(history, events, STATES, when)
    expect(lines.map((l) => l.text)).toEqual([
      'first seen — arrived outstanding',
      'outstanding → paid · seen Oct 30, 12:00 UTC · after Oct 29, 09:00 UTC',
      'ack · by owner',
    ])
    expect(lines.map((l) => l.source)).toEqual(['journal', 'journal', 'event'])
  })
  it('appeared and removed say so; opened lines are silo-level and skipped', () => {
    const lines = storyOf(
      [
        { at: '2026-10-28T00:00:00Z', event: 'opened' },
        { at: '2026-10-29T00:00:00Z', event: 'appeared', to: 'open' },
        { at: '2026-10-30T00:00:00Z', event: 'removed', from: 'open' },
      ],
      [],
      STATES,
      when,
    )
    expect(lines).toHaveLength(2)
  })
})

describe('moments and templates', () => {
  it('momentWord matches the server voice: day values stay days', () => {
    expect(momentWord('2026-10-28')).toBe('Oct 28')
    expect(momentWord('2026-10-30T12:05:00Z')).toBe('Oct 30, 12:05 UTC')
    expect(momentWord('garbage')).toBe('garbage')
  })
  it('the preview fills {{slots}} with the record words; an unknown slot stays as written', () => {
    const detail: Pick<SiloRecordDetail, 'record' | 'fields'> = {
      record: {
        key: 'k',
        id: 'a1',
        identity: 'F-a1 · Acme SL',
        state: 'open',
        stateLabel: 'outstanding',
        at: '2026-10-02',
        anchors: {},
        cells: [],
        row: '',
        folded: false,
        overlay: false,
        conflict: false,
        remarks: [],
        file: null,
      },
      fields: [{ name: 'total', type: 'money', value: { amount: 465.51, currency: 'EUR' }, text: '€465.51' }],
    }
    expect(fillTemplate('Chase payment for {{identity}} ({{total}})', detail)).toBe('Chase payment for F-a1 · Acme SL (€465.51)')
    expect(fillTemplate('{{state}} · {{nope}}', detail)).toBe('outstanding · {{nope}}')
  })
})

describe('typed columns', () => {
  it('money right-aligns by its declared type; untyped and other types read as text', () => {
    const kind = { columnTypes: { total: 'money', due: 'timestamp', state: 'state' } }
    expect(columnAlign('total', kind)).toBe('right')
    expect(columnAlign('due', kind)).toBe('left')
    expect(columnAlign('identity', kind)).toBe('left')
    // an older server sends no types: everything stays as it was
    expect(columnAlign('total', {})).toBe('left')
  })
})

describe('set-field on a field with no declared values', () => {
  it('text-shaped types edit as text, money as its amount with the currency kept, yes/no as a choice', () => {
    expect(editorFor({ type: 'string', value: 'u_123' })).toEqual({ kind: 'text', initial: 'u_123', placeholder: '' })
    expect(editorFor({ type: 'timestamp', value: null })).toEqual({ kind: 'text', initial: '', placeholder: 'YYYY-MM-DD' })
    expect(editorFor({ type: 'email', value: null })).toMatchObject({ kind: 'text', placeholder: 'name@example.com' })
    expect(editorFor({ type: 'money', value: { amount: 465.51, currency: 'EUR' } })).toEqual({ kind: 'money', initial: '465.51', currency: 'EUR' })
    expect(editorFor({ type: 'boolean', value: true })).toEqual({ kind: 'boolean', initial: true })
  })
  it("what can't be typed honestly stays read-only and says why", () => {
    expect(editorFor({ type: 'money', value: null })).toEqual({ kind: 'none', why: 'an amount needs its currency, and this record has none yet' })
    expect(editorFor({ type: 'attachment', value: 'a.pdf' })).toEqual({ kind: 'none', why: 'a attachment value is written by the producer' })
    expect(editorFor({ type: 'refs(item)', value: [] }).kind).toBe('none')
  })
  it('parses what the owner typed — or says why not', () => {
    const text = editorFor({ type: 'string', value: '' })
    expect(parseEdit(text, '  u_9 ', false)).toEqual({ ok: true, value: 'u_9' })
    expect(parseEdit(text, '  ', false)).toEqual({ ok: false, reason: 'this field can’t be left empty' })
    expect(parseEdit(text, '', true)).toEqual({ ok: true, value: null }) // clearable: empty clears
    const money = editorFor({ type: 'money', value: { amount: 1, currency: 'EUR' } })
    expect(parseEdit(money, '1234,5', false)).toEqual({ ok: true, value: { amount: 1234.5, currency: 'EUR' } })
    expect(parseEdit(money, '1,234.50', false)).toEqual({ ok: true, value: { amount: 1234.5, currency: 'EUR' } })
    expect(parseEdit(money, '12 euros', false)).toEqual({ ok: false, reason: '12 euros is not an amount' })
    expect(parseEdit(editorFor({ type: 'boolean', value: false }), 'true', false)).toEqual({ ok: true, value: true })
    expect(parseEdit({ kind: 'none', why: 'x' }, 'a', false)).toEqual({ ok: false, reason: 'x' })
  })
})

describe('a kernel source', () => {
  it('the header says Silos keeps the records, from what the catalog says it reads — never «written by kernel»', () => {
    const d = descriptor({
      id: 'system',
      name: 'System',
      producer: { role: 'kernel', sync: null },
      records: { parsed: 2, failed: 0 },
      kernel: { kind: 'process', reads: 'the processes your conversations started on this machine and the ports they listen on' },
    })
    const parts = siloHeaderParts(d).join(' ')
    expect(parts).toContain('the processes your conversations started')
    expect(parts).not.toContain('kernel')
  })
})
