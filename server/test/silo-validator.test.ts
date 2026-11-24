// The validator (Silo Standard step 1, Task 7): the eleven checks of
// conformance.md in their order, plain words with positions, and the text
// preview — the exact sentences Silos will say.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSiloValidate, draftPath, readDraft, validateSilo, type ValidatorContext } from '../src/silos/validator.js'
import { SiloRegistry } from '../src/silos/registry.js'
import { SiloReader } from '../src/silos/reader.js'
import { siloManifest } from './helpers/silo-manifests.js'

const REF_DIR = join(import.meta.dirname, '..', '..', 'docs', 'standard', 'reference')
type Json = Record<string, any>
const ref = (id: string): Json => siloManifest(id) as Json
const NOW = Date.parse('2026-10-30T12:00:00Z')
const isAgent = (v: string): boolean => ['finance', 'writer', 'support'].includes(v)
const ctx = (extra: Partial<ValidatorContext> = {}): ValidatorContext => ({ now: NOW, isAgent, ...extra })
const errorsOf = (m: unknown, c: ValidatorContext = ctx()): Array<[number, string, string]> =>
  validateSilo(m, c).errors.map((e) => [e.check, e.where, e.message])

let base: string
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'silo-validator-'))
})
afterEach(() => rmSync(base, { recursive: true, force: true }))

describe('the four reference manifests validate, with their exact preview', () => {
  it('invoices', () => {
    const r = validateSilo(ref('invoices'), ctx())
    expect(r.errors).toEqual([])
    expect(r.ok).toBe(true)
    expect(r.requirements).toEqual([
      { what: "requires the token of the agent bound to finance — the sync reads the owner's changes through the API before writing", met: null },
    ])
    expect(r.preview).toEqual({
      from: 'examples',
      basis: 'from the 2 examples — no records on disk yet',
      pulse: '€465.51 outstanding',
      needsYou: [{ urgency: 'due', matches: 0, row: null, sample: 'F2026-0412 · Acme SL — outstanding · due Nov 1' }],
      list: 'F2026-0412 · Acme SL · outstanding · €465.51 · Nov 1 · Oct 2',
    })
    expect(r.notes).toContain("examples must be synthetic — never a real person's data (no check can prove it; the standard requires it)")
  })
  it('support', () => {
    const r = validateSilo(ref('support'), ctx())
    expect(r.ok).toBe(true)
    // both entries due and folded: Home says ONE «N support tickets wait on you»
    expect(r.preview).toMatchObject({
      pulse: '2 support tickets',
      needsYou: [
        { urgency: 'due', matches: 1, row: 'Asks for a refund of the annual plan — needs you' },
        { urgency: 'due', matches: 0 },
      ],
      list: '— · customer@example.com · needs you · refund · Asks for a refund of the annual plan · 1 · Oct 28, 09:05 UTC · agent: Customer since March; I propose a prorated refund.',
    })
  })
  it('plans — validates; its preview says the gate (0.2.0)', () => {
    const r = validateSilo(ref('plans'), ctx())
    expect(r.ok).toBe(true)
    // 0.2.0 (G7): the ready human task gates the Finance's → a `due` entry holds, and says it;
    // 0.5.2 (E8): «you» is only the owner — sam's gate is the chase entry (FIRST), said
    // as sam's; the owner's two entries and the pulse match none of the examples;
    // 0.3.0: the example's task waiting on ana is the waitsOnHuman entry's match (the w6 fix);
    // 0.8.1: the example's review names sam as its reviewer — a second match, said first
    expect(r.preview).toMatchObject({
      pulse: '0 tasks yours to do',
      needsYou: [
        { urgency: 'due', matches: 1, row: "sam's Confirm the figure with the accountant — pending · unblocks 1 task of finance" },
        { urgency: 'due', matches: 0, row: null },
        { urgency: 'routine', matches: 0, row: null },
        { urgency: 'due', matches: 2, row: 'writer asks sam: Do we publish this version? — Write the page' },
      ],
      list: 'August books close · active · Aug 27 · —',
    })
    // the task's title is declared since 0.2.0 — nothing left to say about it
    expect(r.notes.filter((n) => n.includes('identity.template names'))).toEqual([])
  })
  it('documents', () => {
    const r = validateSilo(ref('documents'), ctx())
    expect(r.ok).toBe(true)
    expect(r.preview).toMatchObject({
      pulse: null,
      needsYou: [{ urgency: 'due', matches: 1, row: 'Information request — reply — needs a response · due Oct 10' }],
    })
  })
})

describe('the checks, in their order, each in plain words with its position', () => {
  it('1 — schema: errors stop the rest; an unknown additive field is a want; a restrictive one rejects', () => {
    const m = ref('invoices')
    m.spec.sources[0].root = 'cloud'
    m.spec.kinds.invoice.horizon = {}
    expect(errorsOf(m)).toEqual([[1, 'spec.sources[0].root', 'spec.sources[0].root must be one of agent-state, project, kernel (found "cloud")']])
    const w = ref('plans')
    w.spec.kinds.plan.horizon = {}
    expect(validateSilo(w, ctx()).wants).toEqual(['spec.kinds.plan.horizon'])
    const rr = ref('plans')
    rr.spec.kinds.plan.sensitive = true
    expect(errorsOf(rr, ctx({ restrictive: ['sensitive'] }))[0]![0]).toBe(1)
    expect(errorsOf('x')).toEqual([[1, 'the manifest', 'silo.json must hold a JSON object']])
  })
  it("2 — ids: the kernel's words and every id ever approved are reserved; a record charset must be a pattern", () => {
    const m = ref('plans')
    m.metadata.id = 'validate'
    expect(errorsOf(m)).toEqual([[2, 'metadata.id', 'validate is a word the kernel keeps for itself — pick another id']])
    const registry = { get: () => null, list: () => [], reservedIds: () => ({ kernel: [], approved: ['plans'] }) }
    expect(errorsOf(ref('plans'), ctx({ registry }))).toEqual([
      [2, 'metadata.id', 'plans belonged to a silo the owner approved before; approved ids stay reserved after an uninstall'],
    ])
    const cs = ref('plans')
    cs.spec.kinds.plan.envelope.id.charset = '[a-'
    expect(errorsOf(cs)).toEqual([[2, 'spec.kinds.plan.envelope.id.charset', 'the record id charset "[a-" is not a valid pattern']])
  })
  it('3 — confinement', () => {
    const m = ref('invoices')
    m.spec.sources[0].glob = 'notes/*.json'
    expect(errorsOf(m)).toEqual([
      [3, 'spec.sources[0].glob', 'source invoices: under agent-state a silo\'s records live in silos/<silo>/ — "notes/*.json" is outside it'],
    ])
  })
  it("4 — one kind per source; reading another active silo's files is a coexistence note, not an error", () => {
    const m = ref('invoices')
    m.spec.kinds.extra = m.spec.kinds.invoice
    expect(errorsOf(m)).toContainEqual([
      4,
      'spec.sources',
      'this silo declares 2 kinds and nothing says which source feeds which — v0 reads silos with one kind per manifest',
    ])
    const registry = {
      get: () => null,
      list: () => [{ id: 'invoices-old', status: { state: 'active', conventions: [{ convention: 'agent-state:silos/invoices' }] } }],
      reservedIds: () => ({ kernel: [], approved: [] }),
    } as unknown as ValidatorContext['registry']
    const r = validateSilo(ref('invoices'), ctx({ registry }))
    expect(r.ok).toBe(true)
    expect(r.notes[0]).toBe(
      'reads the same files as invoices-old (agent-state:silos/invoices) — installing offers to take over its slots and instructions, reversibly, or to stay a separate view',
    )
  })
  it('5 — the envelope: at mapped, anchors the location can hold, labels for one and many, a terminal state', () => {
    const m = ref('invoices')
    m.spec.kinds.invoice.envelope.at = {}
    m.spec.kinds.invoice.envelope.anchors = [
      { hub: 'folder', from: 'location' },
      { hub: 'conversation', from: 'location' },
    ]
    m.spec.kinds.invoice.states[0].label = { one: 'draft' }
    m.spec.kinds.invoice.states = m.spec.kinds.invoice.states.map((s: Json) => ({ ...s, terminal: false }))
    expect(errorsOf(m).filter((e) => e[0] === 5)).toEqual([
      [5, 'spec.kinds.invoice.envelope.at', 'at maps no field — name the field that dates the record (or inherit it from the parent)'],
      [5, 'spec.kinds.invoice.envelope.anchors[0]', 'a kind read from agent-state cannot anchor to a folder from its location'],
      [
        5,
        'spec.kinds.invoice.envelope.anchors[1]',
        "a record anchors to a conversation only through a declared field or the owner's gesture — never from its location",
      ],
      [5, 'spec.kinds.invoice.states[0].label', 'state "draft" needs its plain words for one and many'],
      [5, 'spec.kinds.invoice.states', 'at least one state must be terminal (what counts as done)'],
    ])
  })
  it('6 — expressions parse and name only declared fields; views, pulse and actions name what exists', () => {
    const m = ref('invoices')
    m.spec.surfaces['needs-you'][0].when = 'state in [open, partial] and dueDate < now'
    m.spec.surfaces['needs-you'][0].clears = 'state = = paid'
    m.spec.surfaces['needs-you'][0].actions = ['open', 'call-customer']
    m.spec.surfaces.pulse.field = 'description'
    m.spec.views[0].facets = ['state', 'total.colour']
    m.spec.views.push({ id: 'x', archetype: 'list', kind: 'receipt' })
    m.spec.surfaces.rail = { label: 'F', view: 'nope' }
    m.spec.kinds.invoice.computed = { a: 'b = 1', b: 'a = 2' }
    expect(errorsOf(m).filter((e) => e[0] === 6)).toEqual([
      [6, 'spec.kinds.invoice.computed.a', 'a depends on itself — a computed field cannot reference itself, directly or through another (column 1)'],
      [6, 'spec.kinds.invoice.computed.b', 'b depends on itself — a computed field cannot reference itself, directly or through another (column 1)'],
      [6, 'spec.views[0].facets[1]', 'total.colour is not a field of invoice'],
      [6, 'spec.views[1].kind', 'receipt is not a kind of this silo (invoice)'],
      [6, 'spec.surfaces.rail.view', "nope is not one of this silo's views"],
      [6, 'spec.surfaces.pulse.field', 'description is not a money field of invoice'],
      [6, 'spec.surfaces.needs-you[0].when', 'dueDate is not a field of invoice — declare it in fields (or fix the name) (column 30)'],
      [6, 'spec.surfaces.needs-you[0].clears', 'expected a field, a value, now or since(…), found "=" (column 9)'],
      [
        6,
        'spec.surfaces.needs-you[0].actions[1]',
        'call-customer is not an action of the catalog (set-field, append-item, move-item, ensure-record, agent-record-write, ack, open, message-agent)',
      ],
    ])
  })
  it('7 — a blocking item must clear by something the owner can do; any item by someone', () => {
    const m = ref('support')
    m.spec.surfaces['needs-you'][0].urgency = 'blocking'
    m.spec.actions = m.spec.actions.filter((a: Json) => a.verb !== 'set-field')
    expect(errorsOf(m)).toEqual([
      [
        7,
        'spec.surfaces.needs-you[0].clears',
        'a blocking item must clear by something the owner can do — state != needs_owner reads state, none of which a set-field action lets the owner write',
      ],
    ])
    const n = ref('documents')
    n.spec.actions = n.spec.actions.filter((a: Json) => a.verb !== 'set-field' && a.verb !== 'agent-record-write')
    expect(errorsOf(n)).toEqual([
      [
        7,
        'spec.surfaces.needs-you[0].clears',
        'nobody can clear this item: state = filed reads state, which neither the owner (set-field) nor the producer (agent-record-write or a sync) writes',
      ],
    ])
  })
  it("7 — a sync is the producer's write channel: a due item cleared only by fields the sync fills validates (finding 75a)", () => {
    const m = ref('invoices')
    m.spec.actions = (m.spec.actions ?? []).filter((a: Json) => a.verb !== 'set-field' && a.verb !== 'agent-record-write')
    expect(m.spec.producer.sync).toBeTruthy()
    expect(errorsOf(m, ctx()).filter((e) => e[0] === 7)).toEqual([])
    delete m.spec.producer.sync
    expect(
      errorsOf(m, ctx())
        .filter((e) => e[0] === 7)
        .map((e) => e[2]),
    ).toEqual([expect.stringMatching(/^nobody can clear this item/)])
  })
  it("8 — sync + ownerWritable needs the bound producer's token: said, checked at approval (a role is never an agent id)", () => {
    expect(errorsOf(ref('invoices'), ctx({ isAgent: (v) => v === 'finance' }))).toEqual([])
    expect(validateSilo(ref('invoices'), ctx({ isAgent: (v) => v === 'finance' })).requirements).toEqual([
      { what: "requires the token of the agent bound to finance — the sync reads the owner's changes through the API before writing", met: null },
    ])
  })
  it('9 — every example reads with the manifest itself', () => {
    const m = ref('invoices')
    delete m.spec.kinds.invoice.examples[1].contactId
    expect(errorsOf(m)).toEqual([[9, 'spec.kinds.invoice.examples[1]', 'this example does not read: missing contactId']])
  })
  it('errors come in check order', () => {
    const m = ref('invoices')
    m.metadata.id = 'status'
    m.spec.sources[0].glob = 'x/*.json'
    delete m.spec.kinds.invoice.examples[0].contactName
    const checks = validateSilo(m, ctx()).errors.map((e) => e.check)
    expect(checks).toEqual([...checks].sort((a, b) => a - b))
    expect(checks).toEqual([2, 3, 9])
  })
})

describe('9 + 10 on an update, and the dry-run over real disk', () => {
  function installed(manifest: Json): SiloRegistry {
    const dataDir = join(base, 'data')
    mkdirSync(join(dataDir, 'silos', 'registry', manifest.metadata.id), { recursive: true })
    writeFileSync(join(dataDir, 'silos', 'registry', manifest.metadata.id, 'silo.json'), JSON.stringify(manifest))
    const registry = new SiloRegistry({ dataDir, operator: { decisionFor: () => 'approved', slotsOff: () => [] } })
    registry.load()
    return registry
  }
  const reader = (): SiloReader => new SiloReader({ agentStates: () => [{ agentId: 'finance', dir: join(base, 'as', 'finance') }], projects: () => [] })
  const put = (name: string, v: unknown): void => {
    const f = join(base, 'as', 'finance', 'silos', 'invoices', name)
    mkdirSync(join(f, '..'), { recursive: true })
    writeFileSync(f, JSON.stringify(v))
  }

  it("the previous version's examples must still read (or declare an alias); the diff counts records on disk that stop parsing", () => {
    const registry = installed(ref('invoices'))
    expect(registry.reservedIds().approved).toEqual(['invoices'])
    put('inv-70a1.json', ref('invoices').spec.kinds.invoice.examples[0])
    const next = ref('invoices')
    next.metadata.version = '0.2.0'
    next.spec.kinds.invoice.fields.customerName = { type: 'string', required: true }
    delete next.spec.kinds.invoice.fields.contactName
    next.spec.kinds.invoice.envelope.identity = { template: '{{documentNumber}} · {{customerName}}' }
    next.spec.kinds.invoice.examples = next.spec.kinds.invoice.examples.map((e: Json) => ({ ...e, customerName: e.contactName }))
    const r = validateSilo(next, ctx({ registry, reader: reader() }))
    expect(r.errors).toEqual([
      {
        check: 9,
        where: 'spec.kinds.invoice.examples',
        message: 'example 1 of version 0.1.0 no longer reads: missing customerName — keep it reading or declare an alias',
      },
      {
        check: 9,
        where: 'spec.kinds.invoice.examples',
        message: 'example 2 of version 0.1.0 no longer reads: missing customerName — keep it reading or declare an alias',
      },
    ])
    // with the alias declared, it reads — and so does the record on disk
    next.spec.kinds.invoice.fields.customerName.aliases = ['contactName']
    const ok = validateSilo(next, ctx({ registry, reader: reader() }))
    expect(ok.errors).toEqual([])
    expect(ok.update).toEqual({ from: '0.1.0', lines: ['every record on disk still reads'] })
    expect(ok.preview!.basis).toBe('from 1 record on disk')
  })

  it('an update that drops a record says how many stop parsing', () => {
    const registry = installed(ref('invoices'))
    put('inv-70a1.json', ref('invoices').spec.kinds.invoice.examples[0])
    put('inv-70b2.json', { ...ref('invoices').spec.kinds.invoice.examples[1], kind: 'purchase' })
    const next = ref('invoices')
    next.spec.kinds.invoice.fields.kind.oneOf = ['sale', 'refund']
    const r = validateSilo(next, ctx({ registry, reader: reader() }))
    expect(r.update!.lines).toEqual(['1 record on disk stops parsing'])
    expect(r.notes).toContain('1 record on disk stops parsing')
  })
})

describe('drafts and the route handler', () => {
  it('a draft lives at agent-state/<agent>/silo-drafts/<id>.json, outside the records namespace', () => {
    expect(draftPath('/s/agent-state', 'finance', 'invoices')).toBe('/s/agent-state/finance/silo-drafts/invoices.json')
    expect(draftPath('/s/agent-state', '../x', 'invoices')).toBeNull()
    expect(draftPath('/s/agent-state', 'finance', 'Bad')).toBeNull()
  })
  it('validates a sent manifest or a draft; refuses anything else', () => {
    const as = join(base, 'agent-state')
    mkdirSync(join(as, 'finance', 'silo-drafts'), { recursive: true })
    writeFileSync(join(as, 'finance', 'silo-drafts', 'plans.json'), JSON.stringify(ref('plans')))
    const route = createSiloValidate({ agentStateBase: as, isAgent })
    expect(route({ manifest: ref('documents') })).toMatchObject({ code: 200, body: { ok: true, id: 'documents' } })
    expect(route({ draft: { agent: 'finance', id: 'plans' } })).toMatchObject({
      code: 200,
      body: { ok: true, state: 'draft', draft: join(as, 'finance', 'silo-drafts', 'plans.json') },
    })
    expect(route({ draft: { agent: 'finance', id: 'nope' } })).toMatchObject({ code: 404 })
    expect(route({})).toMatchObject({ code: 400 })
    expect(readDraft(as, 'finance', '../x')).toEqual({ error: 'the draft is named by an agent id and a silo id (lowercase letters, digits and -)' })
  })
})

describe('audience: producer-agent', () => {
  it('invoices with the overdue entry routed validates, and the preview SAYS the routing', () => {
    const m = ref('invoices')
    m.spec.surfaces['needs-you'][0].audience = 'producer-agent'
    const r = validateSilo(m, ctx())
    expect(r.errors).toEqual([])
    expect(r.preview!.needsYou[0]).toMatchObject({ urgency: 'due', audience: 'producer-agent' })
  })
  it('an explicit audience: owner changes nothing', () => {
    const m = ref('invoices')
    m.spec.surfaces['needs-you'][0].audience = 'owner'
    const r = validateSilo(m, ctx())
    expect(r.errors).toEqual([])
    expect(r.preview!.needsYou[0].audience).toBeUndefined()
  })
  it('7 — a blocking entry cannot be routed to the producer', () => {
    const m = ref('support')
    m.spec.surfaces['needs-you'][0].urgency = 'blocking'
    m.spec.surfaces['needs-you'][0].audience = 'producer-agent'
    expect(errorsOf(m)).toContainEqual([
      7,
      'spec.surfaces.needs-you[0].audience',
      'a blocking entry cannot be routed to the producer — what blocks is the owner’s by definition',
    ])
  })
  it('7 — routing needs the producer to be able to clear it (agent-record-write, or a sync)', () => {
    const m = ref('plans')
    m.spec.surfaces['needs-you'][0].audience = 'producer-agent'
    m.spec.actions = m.spec.actions.filter((a: Json) => a.verb !== 'agent-record-write')
    expect(errorsOf(m)).toContainEqual([
      7,
      'spec.surfaces.needs-you[0].audience',
      'audience producer-agent needs the producer to be able to clear it — declare agent-record-write on this kind, or a sync (the sync is its write channel)',
    ])
  })
  it('1 — a value outside the enum is a schema error, not a want', () => {
    const m = ref('invoices')
    m.spec.surfaces['needs-you'][0].audience = 'everyone'
    expect(errorsOf(m).map(([c]) => c)).toContain(1)
  })
})

describe('12 — a theme (spec.theme): a closed vocabulary of #rrggbb values, and the contrast rule', () => {
  const heather = (): Json => ref('heather')
  it('the reference look validates on its own — no producer, sources or kinds', () => {
    const r = validateSilo(heather(), ctx())
    expect(r.errors).toEqual([])
    expect(r.preview).toMatchObject({ pulse: null, needsYou: [], list: null })
  })
  it('a value that is not #rrggbb, an unknown token and a missing mode are schema errors — never wants', () => {
    const m = heather()
    m.spec.theme.light.accent = 'rgba(138, 47, 110, 0.9)'
    m.spec.theme.light.glow = '#ffffff'
    delete m.spec.theme.dark
    const r = validateSilo(m, ctx())
    expect(r.wants).toEqual([])
    expect(r.errors.map((e) => [e.check, e.where])).toEqual(
      expect.arrayContaining([
        [1, 'spec.theme'],
        [1, 'spec.theme.light'],
        [1, 'spec.theme.light.accent'],
      ]),
    )
    expect(r.errors.find((e) => e.where === 'spec.theme')!.message).toContain('dark')
    expect(r.errors.find((e) => e.where === 'spec.theme.light')!.message).toContain('"glow"')
    const short = heather()
    short.spec.theme.dark.text = '#fff'
    expect(errorsOf(short).map(([c, w]) => [c, w])).toEqual([[1, 'spec.theme.dark.text']])
  })
  it('a pair under its minimum rejects the manifest, naming the mode, the pair, the ratio and the minimum', () => {
    const m = heather()
    m.spec.theme.dark['text-3'] = '#4a4050' // on #1c1720
    m.spec.theme.light['on-accent'] = '#c060a0' // on #8a2f6e
    const r = validateSilo(m, ctx())
    expect(r.ok).toBe(false)
    expect(r.errors.map((e) => [e.check, e.where])).toEqual([
      [12, 'spec.theme.light'],
      [12, 'spec.theme.dark'],
    ])
    const [light, dark] = r.errors.map((e) => e.message)
    expect(light).toMatch(/\blight\b.*on-accent on accent.* (\d+\.\d\d):1 .*4\.5:1/)
    expect(dark).toMatch(/\bdark\b.*text-3 on background.* (\d+\.\d\d):1 .*3:1/)
    expect(Number(/(\d+\.\d\d):1/.exec(dark!)![1])).toBeLessThan(3)
  })
  it('a look does not relax a silo that reads records: sources still need their kinds and producer', () => {
    const m = heather()
    m.spec.sources = ref('documents').spec.sources
    expect(errorsOf(m).some(([c, , msg]) => c === 1 && /producer|kinds/.test(msg))).toBe(true)
    const plain = ref('invoices')
    delete plain.spec.kinds
    expect(errorsOf(plain).some(([c]) => c === 1)).toBe(true)
  })
})

describe('every reference manifest validates', () => {
  it('each file of docs/standard/reference', () => {
    const bad: string[] = []
    for (const f of readdirSync(REF_DIR).filter((x) => x.endsWith('.silo.json'))) {
      const r = validateSilo(JSON.parse(readFileSync(join(REF_DIR, f), 'utf8')), ctx())
      if (!r.ok) bad.push(`${f}: ${r.errors.map((e) => `${e.where} ${e.message}`).join('; ')}`)
    }
    expect(bad).toEqual([])
  })
})
