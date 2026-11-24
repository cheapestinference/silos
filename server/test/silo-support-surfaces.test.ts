// What support's kernelectomy added to the shared surfaces: the
// list's child columns (count/last), the project facet, the needs-you rank
// and the id filter, the row's state select, the record's child links,
// authors and verbs, the folded summary's noun, and the producer brief that
// a skill-produced silo never sends.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SiloRegistry } from '../src/silos/registry.js'
import { SiloReader } from '../src/silos/reader.js'
import { SiloKernel } from '../src/silos/kernel.js'
import { TransitionJournal } from '../src/silos/journal.js'
import { OverlayStore } from '../src/silos/overlay.js'
import { SiloSurfaces } from '../src/silos/surfaces.js'
import { recordDetail, recordsPage } from '../src/silos/views.js'
import { composeInbox } from '../src/inbox.js'
import { instructedElsewhere, producerBriefFor, viaSkill } from '../src/silos/producer-brief.js'

const REF_DIR = join(import.meta.dirname, '..', '..', 'docs', 'standard', 'reference')
type Json = Record<string, any>
const ref = (id: string): Json => JSON.parse(readFileSync(join(REF_DIR, `${id}.silo.json`), 'utf8'))
const AGENTS = ['writer', 'support']
const isAgent = (v: string): boolean => AGENTS.includes(v)
const FOLDERS: Record<string, string> = { writer: '/w/acme', support: '/w/helpdesk' }
const NOW = Date.parse('2026-10-30T12:00:00Z')

let base: string
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'silo-support-'))
})
afterEach(() => rmSync(base, { recursive: true, force: true }))

const canon = (over: Json = {}): Json => ({ ...ref('support').spec.kinds.case.examples[0], ...over })
function put(agent: string, id: string, v: Json): void {
  const f = join(base, 'agent-state', agent, 'support', 'cases', `${id}.json`)
  mkdirSync(join(f, '..'), { recursive: true })
  writeFileSync(f, JSON.stringify({ ...v, id }))
  utimesSync(f, new Date(), new Date())
}
function setup() {
  const dataDir = join(base, 'data')
  mkdirSync(join(dataDir, 'silos', 'registry', 'support'), { recursive: true })
  writeFileSync(join(dataDir, 'silos', 'registry', 'support', 'silo.json'), JSON.stringify(ref('support')))
  const registry = new SiloRegistry({ dataDir, operator: { decisionFor: () => 'approved', slotsOff: () => [] } })
  registry.load()
  const kernel = new SiloKernel({
    registry,
    journal: new TransitionJournal(registry.conventionsDir),
    overlay: new OverlayStore(registry.conventionsDir),
    isAgent,
    reader: new SiloReader({ agentStates: () => AGENTS.map((a) => ({ agentId: a, dir: join(base, 'agent-state', a) })), projects: () => [] }),
  })
  kernel.refresh()
  const entry = registry.get('support')!
  const page = (q: Parameters<typeof recordsPage>[3] = {}) => {
    const p = recordsPage(
      entry,
      kernel.reading('support'),
      { voice: { now: NOW, isAgent }, overlayKeys: new Set(), conflictKeys: new Set(), folderOf: (a) => FOLDERS[a] ?? null },
      q,
    )
    if ('error' in p) throw new Error(p.error)
    return p
  }
  return { registry, kernel, entry, page }
}

describe('the list page over support', () => {
  it('child columns: count(threads) and last(notes) said with who wrote it; a blank summary stays blank', () => {
    put(
      'support',
      'c1',
      canon({
        summary: '',
        notes: [
          { at: '2026-10-28T09:05:00Z', by: 'agent', text: 'first' },
          { at: '2026-10-29T09:05:00Z', by: 'owner', text: 'refund ok' },
        ],
      }),
    )
    const { page } = setup()
    const r = page().records[0]!
    expect(r.identity).toBe('')
    expect(Object.fromEntries(r.cells.map((c) => [c.column, c.text]))).toMatchObject({
      agent: 'support',
      customerEmail: 'customer@example.com',
      state: 'needs you',
      intent: 'refund',
      identity: '—',
      'count(threads)': '1',
      'last(notes)': 'owner: refund ok',
    })
    expect(page().kind.columnTypes['count(threads)']).toBe('number')
  })

  it('the state is a select on the row (set-field on status); waiting_customer reads «waiting on the customer»', () => {
    put('writer', 'w1', canon({ status: 'waiting_customer' }))
    const { page } = setup()
    expect(page().kind.stateEdit).toEqual({ field: 'status', values: ['new', 'needs_owner', 'draft_ready', 'waiting_customer', 'closed'] })
    expect(page().records[0]!.stateLabel).toBe('waiting on the customer')
  })

  it("the project facet is the anchored agent's folder, labelled by its last segment, and filters", () => {
    put('writer', 'd1', canon())
    put('support', 's1', canon())
    const { page } = setup()
    const project = page().kind.facets.find((f) => f.name === 'project')!
    expect(project.values).toEqual([
      { value: '/w/acme', label: 'acme', count: 1 },
      { value: '/w/helpdesk', label: 'helpdesk', count: 1 },
    ])
    expect(page({ facets: { project: '/w/acme' } }).records.map((r) => r.id)).toEqual(['d1'])
  })

  it('rank needs-you: the records waiting on the owner first, then by activity; the id filter finds one record', () => {
    put('support', 'old-pending', canon({ status: 'draft_ready', lastActivityAt: '2026-10-01T00:00:00Z' }))
    put('support', 'new-waiting', canon({ status: 'waiting_customer', lastActivityAt: '2026-10-29T00:00:00Z' }))
    const { page } = setup()
    expect(page().records.map((r) => r.id)).toEqual(['new-waiting', 'old-pending'])
    expect(page({ rank: 'needs-you' }).records.map((r) => [r.id, r.needsYou])).toEqual([
      ['old-pending', true],
      ['new-waiting', false],
    ])
    expect(page({ id: 'new-waiting' }).records.map((r) => r.key)).toEqual(['agent:support/new-waiting'])
  })
})

describe('the record page over support', () => {
  it('threads link to their url and say nothing invented; notes say who wrote them; the verbs carry what they need', () => {
    put(
      'support',
      'c1',
      canon({
        threads: [
          { threadId: 'th1', subject: 'Refund', lastMessageId: 'm', lastMessageAt: '2026-10-28T09:00:00Z', url: 'https://mail.example/th1' },
          { threadId: 'th2', subject: '', lastMessageId: 'm', lastMessageAt: '2026-10-28T09:00:00Z', url: 'javascript:alert(1)' },
        ],
      }),
    )
    put('support', 'c2', canon({ customerEmail: 'b@example.com', summary: 'Another case' }))
    put('writer', 'd1', canon())
    const { entry, kernel } = setup()
    const d = recordDetail(entry, kernel.reading('support'), 'agent:support/c1', { voice: { now: NOW, isAgent } })!
    const threads = d.children.find((c) => c.collection === 'threads')!
    expect(threads.rows.map((r) => [r.id, r.identity, r.url ?? null])).toEqual([
      ['th1', 'Refund', 'https://mail.example/th1'],
      ['th2', '(thread)', null],
    ])
    // move-item: siblings of the same agent only, by customer · summary
    expect(threads.move).toEqual({ targets: [{ key: 'agent:support/c2', label: 'b@example.com · Another case' }] })
    expect(threads.append).toBeUndefined()
    const notes = d.children.find((c) => c.collection === 'notes')!
    expect(notes.rows[0]).toMatchObject({ by: 'agent', identity: 'Customer since March; I propose a prorated refund.' })
    expect(notes.append).toEqual({ fields: [{ name: 'text', required: true, max: 2000 }] })
    expect(notes.move).toBeUndefined()
    // userId is clearable on the record
    expect(d.actions.find((a) => a.verb === 'set-field')!.fields).toEqual([
      { name: 'status', values: ['new', 'needs_owner', 'draft_ready', 'waiting_customer', 'closed'] },
      { name: 'userId', clearable: true },
    ])
  })
})

describe("Home over support: ONE summary row in today's words", () => {
  it('needs_owner and draft_ready fold into «N support tickets wait on you», due — however few they are', () => {
    put('support', 'a', canon())
    put('writer', 'b', canon({ status: 'draft_ready' }))
    const { registry, kernel } = setup()
    const board = new SiloSurfaces({ registry, kernel, isAgent }).board(NOW)
    expect(board.needsYou.map((n) => [n.urgency, n.folded, n.noun])).toEqual([
      ['due', true, { one: 'support ticket', many: 'support tickets' }],
      ['due', true, { one: 'support ticket', many: 'support tickets' }],
    ])
    const rows = composeInbox({ nameOf: (id) => id, asks: [], pending: [], automations: [], kernel: [], now: NOW, needsYou: board.needsYou })
    expect(rows.map((r) => [r.kind, r.urgency, r.voice])).toEqual([['siloSummary', 'due', '2 support tickets wait on you']])
    put('writer', 'b', canon({ status: 'closed' }))
    kernel.refresh()
    const one = composeInbox({
      nameOf: (id) => id,
      asks: [],
      pending: [],
      automations: [],
      kernel: [],
      now: NOW,
      needsYou: new SiloSurfaces({ registry, kernel, isAgent }).board(NOW).needsYou,
    })
    expect(one.map((r) => r.voice)).toEqual(['1 support ticket waits on you'])
  })
})

describe('a silo produced through a skill: the skill is the channel when the session loads it', () => {
  it('support (via skill support-inbox): no kernel brief for a session WITH the skill; the brief for one without it (M2)', () => {
    const { registry } = setup()
    const operator = { producersOf: () => ['support', 'writer'], audienceOff: () => [] }
    expect(producerBriefFor('support', ['support-inbox', 'team-plan'], { registry, operator })).toBeNull()
    const without = producerBriefFor('writer', ['team-plan'], { registry, operator })!
    expect(without).toContain('## Silo you produce: Support (support)')
    expect(without).toContain('support/cases/*.json')
    // only bound producers, with or without the skill
    expect(producerBriefFor('finance', [], { registry, operator })).toBeNull()
    const m = ref('support')
    delete m.spec.producer.via
    writeFileSync(join(base, 'data', 'silos', 'registry', 'support', 'silo.json'), JSON.stringify(m))
    registry.load()
    expect(producerBriefFor('support', [], { registry, operator })).toContain('## Silo you produce: Support (support)')
  })
})

describe("instructedElsewhere — who already carries a via-skill silo's instructions", () => {
  const via = (v: string | undefined) => ({ spec: { producer: v === undefined ? {} : { via: v } } })
  it('the via skill loaded, or a skill the briefing stands in for (plans: team-plan); a via that names a mechanism stays the channel', () => {
    expect(viaSkill(via('skill support-inbox'))).toBe('support-inbox')
    expect(viaSkill(via('team-plan'))).toBe('team-plan')
    expect(viaSkill(via('the mailbox sync, nightly'))).toBeNull()
    expect(instructedElsewhere(via('skill support-inbox'), ['support-inbox'])).toBe(true)
    expect(instructedElsewhere(via('skill support-inbox'), [])).toBe(false)
    expect(instructedElsewhere(via('skill team-plan'), [])).toBe(true)
    expect(instructedElsewhere(via('the mailbox sync, nightly'), [])).toBe(true)
    expect(instructedElsewhere(via(undefined), ['support-inbox'])).toBe(false)
  })
})
