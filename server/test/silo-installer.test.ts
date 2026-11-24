// Install, approve, uninstall (Silo Standard step 1, Task 11): submissions
// always land pending, the dialog's consequences are derived, approval binds
// producers and (opt-in) creates the sync automation, uninstall destroys
// nothing — and every step is an event.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SiloRegistry } from '../src/silos/registry.js'
import { SiloReader } from '../src/silos/reader.js'
import { SiloKernel } from '../src/silos/kernel.js'
import { TransitionJournal } from '../src/silos/journal.js'
import { OverlayStore } from '../src/silos/overlay.js'
import { SiloOperatorStore } from '../src/silos/operator.js'
import { SiloInstaller, cronForCadence, loosening, syncPrompt } from '../src/silos/installer.js'
import { SiloActions, SiloAcks, SiloEvents, SiloProposals } from '../src/silos/actions.js'
import type { Automation } from '../src/automations-types.js'
import type { SiloLocations } from '../src/silos/files-source.js'
import { siloManifest } from './helpers/silo-manifests.js'

type Json = Record<string, any>
const ref = (id: string): Json => siloManifest(id) as Json
const AGENTS = ['finance', 'writer']

let base: string
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'silo-installer-'))
})
afterEach(() => rmSync(base, { recursive: true, force: true }))

function put(rel: string, v: unknown, mtime?: Date): string {
  const f = join(base, rel)
  mkdirSync(join(f, '..'), { recursive: true })
  writeFileSync(f, JSON.stringify(v, null, 2))
  if (mtime) utimesSync(f, mtime, mtime)
  return f
}
const invoice = (id: string, over: Json = {}): Json => ({ ...ref('invoices').spec.kinds.invoice.examples[0], id, ...over })

function setup(opts: { bearer?: (a: string) => boolean; archived?: Set<string>; inboxRefuses?: boolean } = {}) {
  const dataDir = join(base, 'data')
  const root = join(dataDir, 'silos')
  const operator = new SiloOperatorStore(root)
  const registry = new SiloRegistry({ dataDir, operator })
  registry.load()
  const locations: SiloLocations = {
    agentStates: () => AGENTS.map((a) => ({ agentId: a, dir: join(base, 'agent-state', a) })),
    projects: () => [join(base, 'proj')],
  }
  const isAgent = (v: string): boolean => AGENTS.includes(v)
  const kernel = new SiloKernel({
    registry,
    reader: new SiloReader(locations),
    journal: new TransitionJournal(registry.conventionsDir),
    overlay: new OverlayStore(registry.conventionsDir),
    isAgent,
  })
  const events = new SiloEvents(root)
  const autos = new Map<string, Automation>()
  const sent: Array<{ to: string; text: string }> = []
  const installer = new SiloInstaller({
    root,
    registry,
    operator,
    kernel,
    events,
    locations,
    agentStateBase: join(base, 'agent-state'),
    isAgent,
    ...(opts.archived ? { inPlay: (v: string) => isAgent(v) && !opts.archived!.has(v) } : {}),
    hasBearer: opts.bearer ?? (() => true),
    territoriesOf: () => [],
    automations: {
      create: (a) => {
        autos.set(a.id, a)
        return a
      },
      get: (id) => autos.get(id) ?? null,
      update: (id, p) => {
        const n = { ...autos.get(id)!, ...p } as Automation
        autos.set(id, n)
        return n
      },
    },
    messages: {
      send: (m) => {
        if (opts.inboxRefuses) throw new Error('its inbox is a link leading outside its state')
        sent.push(m)
        return { id: `m${sent.length}` }
      },
    },
  })
  const actions = new SiloActions({
    registry,
    kernel,
    events,
    acks: new SiloAcks(root),
    proposals: new SiloProposals(root),
    agentStateBase: join(base, 'agent-state'),
    isAgent,
    agentMayReadLocation: (a, l) => l === `agent:${a}`,
    producersOf: (id) => operator.producersOf(id),
  })
  return { dataDir, root, operator, registry, kernel, events, installer, actions, autos, sent }
}

describe('operator.json is hand-editable — a minimal entry never breaks a consumer', () => {
  it('normalizes {decision} without producers/slotsOff on load; producersOf never throws', () => {
    const dataDir = join(base, 'data-minimal')
    const root = join(dataDir, 'silos')
    mkdirSync(root, { recursive: true })
    writeFileSync(join(root, 'operator.json'), JSON.stringify({ silos: { invoices: { decision: 'approved' }, broken: { decision: 'nope' }, none: null } }))
    const op = new SiloOperatorStore(root)
    expect(op.producersOf('invoices')).toEqual([])
    expect(op.get('invoices')).toMatchObject({ decision: 'approved', producers: [], slotsOff: [] })
    expect(op.decisionFor('invoices')).toBe('approved')
    expect(op.get('broken')).toBeNull() // an unknown decision word is not a decision
    expect(op.get('none')).toBeNull()
  })
})

describe('submit — always pending, never in the registry until approved', () => {
  it('the owner submits: pending, listed, an event; nothing installed', () => {
    const { installer, registry, events } = setup()
    const r = installer.submit({ manifest: ref('invoices') }, 'owner')
    expect(r.code).toBe(201)
    expect(r.body).toMatchObject({ submission: { id: 'invoices', submittedBy: 'owner', source: 'body', state: 'pending' }, validation: { ok: true } })
    expect(registry.get('invoices')).toBeNull()
    expect(installer.submissions()).toEqual([
      expect.objectContaining({ id: 'invoices', name: 'Invoices', version: '0.1.0', update: false, submittedBy: 'owner' }),
    ])
    expect(events.list('invoices').map((e) => e.text)).toEqual(['you submitted Invoices 0.1.0 — waiting for the owner'])
  })

  it('an invalid manifest creates nothing and answers the validator', () => {
    const { installer } = setup()
    const m = ref('invoices')
    delete m.spec.kinds.invoice.examples[0].contactId
    const r = installer.submit({ manifest: m }, 'owner')
    expect(r.code).toBe(422)
    expect((r.body as Json).errors[0]).toMatchObject({ check: 9 })
    expect(installer.submissions()).toEqual([])
  })

  it("an agent submits its own draft — never another's; its preview reads only what it reads on disk", () => {
    put('agent-state/finance/silo-drafts/invoices.json', ref('invoices'))
    put('agent-state/finance/silos/invoices/a1.json', invoice('a1'))
    put('agent-state/writer/silos/invoices/b1.json', invoice('b1'))
    const { installer } = setup()
    expect(installer.submit({ draft: { id: 'invoices', agent: 'writer' } }, 'finance').code).toBe(403)
    const r = installer.submit({ draft: { id: 'invoices' } }, 'finance')
    expect(r.code).toBe(201)
    expect((r.body as Json).submission).toMatchObject({ source: 'draft', submittedBy: 'finance' })
    expect((r.body as Json).validation.preview.basis).toBe('from 1 record on disk')
    // the owner's dialog runs the full dry-run
    expect((installer.consequences('invoices') as Json).derived.preview.basis).toBe('from 2 records on disk')
  })
})

describe("the courtesy note to an agent submitter never fails the owner's decision", () => {
  it("approve and reject still succeed when the submitter's inbox refuses the note", () => {
    put('agent-state/finance/silo-drafts/invoices.json', ref('invoices'))
    put('agent-state/finance/silos/invoices/a1.json', invoice('a1'))
    const { installer, operator } = setup({ inboxRefuses: true })
    expect(installer.submit({ draft: { id: 'invoices' } }, 'finance').code).toBe(201)
    const ok = installer.approve('invoices', { producers: ['finance'] })
    expect(ok.code).toBeLessThan(300)
    expect(operator.get('invoices')?.decision).toBe('approved')
  })
})

describe('the consequences the dialog shows', () => {
  it('paths, slots with their sentences, requirements per producer, the author as a quote, the proposed automation', () => {
    put('agent-state/finance/silos/invoices/a1.json', invoice('a1', { due: '2026-01-01' }))
    const { installer } = setup({ bearer: () => false })
    // the owner names who produces it (a role is a word of the manifest, never an agent id)
    installer.submit({ manifest: ref('invoices') }, 'owner', { producers: ['finance'] })
    const c = installer.consequences('invoices') as Json
    expect(c).toMatchObject({ id: 'invoices', kind: 'install', version: { from: null, to: '0.1.0' }, submittedBy: 'owner' })
    expect(c.authorSays).toMatchObject({ name: 'Invoices', sync: { service: 'Invoicing' } })
    expect(c.authorSays.summary).toMatch(/^Every day: produce the export of your invoicing service/)
    expect(c.authorSays.sync.contract).toHaveLength(6)
    expect(c.derived.reads).toEqual([
      {
        source: 'invoices',
        root: 'agent-state',
        glob: 'silos/invoices/*.json',
        parser: 'json',
        convention: 'agent-state:silos/invoices',
        locations: [
          { location: 'agent:finance', path: join(base, 'agent-state', 'finance', 'silos', 'invoices'), exists: true, files: 1 },
          { location: 'agent:writer', path: join(base, 'agent-state', 'writer', 'silos', 'invoices'), exists: false, files: 0 },
        ],
      },
    ])
    expect(c.derived.slots).toEqual([
      { slot: 'pulse', says: '€465.51 outstanding', off: false },
      { slot: 'needs-you', says: 'due: F2026-0412 · Acme SL — outstanding · due Jan 1', off: false },
      { slot: 'agent-section', says: "a section in the producer's page, under machinery", off: false },
    ])
    expect(c.derived.proposedProducers).toEqual(['finance'])
    expect(c.derived.requirements).toEqual([{ what: "requires finance's token — finance is archived, so it holds none", agentId: 'finance', met: false }])
    expect(c.derived.proposedAutomation).toMatchObject({
      agentId: 'finance',
      name: 'Invoices — Invoicing sync',
      cadence: '24h',
      cron: '0 0 * * *',
      says: 'every 24h, at 00:00 server time',
    })
    expect(c.derived.proposedAutomation.prompt).toContain('Run the Invoicing sync of the silo Invoices (invoices) now.')
    expect(c.derived.proposedAutomation.prompt).toContain('/api/silos/invoices/agents/$SILOS_AGENT_ID/merged')
    expect(c.derived.update).toBeNull()
    expect(c.name).toBe('Invoices')
    expect(c.derived.forProducers).toEqual(['finance'])
  })

  it('the binding the owner weighs: requirements and the automation re-derived for it, the proposal kept', () => {
    const { installer } = setup({ bearer: (a) => a === 'writer' })
    installer.submit({ manifest: ref('invoices') }, 'owner', { producers: ['finance'] })
    const c = installer.consequences('invoices', { producers: ['writer', 'writer'] }) as Json
    expect(c.derived.proposedProducers).toEqual(['finance']) // what Silos proposes stays said
    expect(c.derived.forProducers).toEqual(['writer'])
    expect(c.derived.requirements).toEqual([{ what: "requires writer's token", agentId: 'writer', met: true }])
    expect(c.derived.proposedAutomation).toMatchObject({ agentId: 'writer' })
    // none bound: the requirement says so, the automation has nobody to run it
    const none = installer.consequences('invoices', { producers: [] }) as Json
    expect(none.derived.requirements).toEqual([{ what: 'requires the token of the agent bound to finance — no agent bound yet', agentId: null, met: false }])
    expect(none.derived.proposedAutomation).toMatchObject({ agentId: null })
    expect(installer.notAgents(['finance', 'ghost'])).toEqual(['ghost'])
  })
})

describe('a pending submission is a Needs you row', () => {
  it('install / update / reinstall, in plain words; the submitter as its agent; gone once decided', () => {
    const s = setup()
    let refreshed = 0
    const installer = new SiloInstaller({
      ...(s.installer as any).o,
      kernel: {
        refresh: (id?: string) => {
          refreshed++
          s.kernel.refresh(id)
        },
        reading: (id: string) => s.kernel.reading(id),
      },
    })
    expect(installer.needsYou()).toEqual([])
    installer.submit({ manifest: ref('documents') }, 'finance')
    expect(refreshed).toBe(1) // the board's listener hears it at once
    expect(installer.needsYou()).toEqual([
      expect.objectContaining({
        kind: 'silo',
        reason: 'submission',
        silo: 'documents',
        siloName: 'Documents',
        key: 'submission',
        urgency: 'due',
        agentId: 'finance',
        file: null,
        text: '0.1.0 waits for your approval to install — submitted by finance',
        submission: { kind: 'install', from: null, to: '0.1.0', submittedBy: 'finance', source: 'body' },
      }),
    ])
    installer.reject('documents', null)
    expect(refreshed).toBe(2)
    expect(installer.needsYou()).toEqual([])

    installer.submit({ manifest: ref('invoices') }, 'owner')
    installer.approve('invoices', { producers: ['finance'] })
    const next = ref('invoices')
    next.metadata.version = '0.2.0'
    installer.submit({ manifest: next }, 'owner')
    const [u] = installer.needsYou()
    expect(u).toMatchObject({
      text: 'an update 0.1.0 → 0.2.0 waits for your approval — submitted by you',
      submission: { kind: 'update', from: '0.1.0', to: '0.2.0' },
    })
    expect(u).not.toHaveProperty('agentId') // the owner's own submission belongs to no agent
    installer.approve('invoices', { producers: ['finance'] })
    installer.uninstall('invoices')
    installer.submit({ manifest: ref('invoices') }, 'owner')
    expect(installer.needsYou()[0]).toMatchObject({ text: '0.1.0 waits for your approval to reinstall — submitted by you', submission: { kind: 'reinstall' } })
  })
})

describe('approve', () => {
  it('refused while a bound producer lacks its token; then active, bound, reserved, automation opt-in, event, submitter told', () => {
    put('agent-state/finance/silo-drafts/invoices.json', ref('invoices'))
    let on = false
    const { installer, registry, operator, autos, events, sent, root } = setup({ bearer: () => on })
    installer.submit({ draft: { id: 'invoices' } }, 'finance')
    expect(installer.approve('invoices', { producers: ['finance'] })).toMatchObject({
      code: 409,
      body: { error: "requires finance's token — finance is archived, so it holds none" },
    })
    expect(installer.approve('invoices', { producers: ['nobody'] })).toMatchObject({ code: 400, body: { error: 'not agents: nobody' } })
    on = true
    const r = installer.approve('invoices', { producers: ['finance'], slotsOff: ['agent-section'], automation: true })
    expect(r.code).toBe(200)
    expect(r.body).toMatchObject({
      kind: 'installed',
      silo: { id: 'invoices', state: 'active', slots: { granted: ['pulse', 'needs-you'], off: ['agent-section'] } },
    })
    expect(registry.get('invoices')!.status.state).toBe('active')
    expect(registry.reservedIds().approved).toEqual(['invoices'])
    expect(JSON.parse(readFileSync(join(root, 'operator.json'), 'utf8')).silos.invoices).toMatchObject({
      decision: 'approved',
      producers: ['finance'],
      slotsOff: ['agent-section'],
    })
    const a = [...autos.values()]
    expect(a).toEqual([
      expect.objectContaining({
        name: 'Invoices — Invoicing sync',
        agentId: 'finance',
        trigger: { kind: 'cron', expr: '0 0 * * *' },
        paused: false,
        keepAlive: true,
      }),
    ])
    expect(operator.get('invoices')!.automationId).toBe(a[0]!.id)
    expect(installer.submissions()).toEqual([])
    expect(events.list('invoices').at(-1)!.text).toBe(
      'installed Invoices 0.1.0 · producers: finance · slots: pulse, needs-you · sync automation Invoices — Invoicing sync',
    )
    expect(sent).toEqual([{ from: 'owner', to: 'finance', text: 'Your silo Invoices 0.1.0 was approved (installed).' }])
  })

  it("an ARCHIVED agent is never proposed nor accepted as a producer — approval and the operator's patch say why", () => {
    const archived = new Set(['finance'])
    const { installer } = setup({ archived })
    installer.submit({ manifest: ref('invoices') }, 'owner')
    // the role names finance, archived: nothing proposed, so approval asks for a binding
    expect((installer.consequences('invoices') as Json).derived.proposedProducers).toEqual([])
    expect(installer.approve('invoices', { producers: ['finance'] })).toMatchObject({
      code: 400,
      body: { error: 'archived — an archived agent works no rows: finance' },
    })
    // nobody named: a role is never an agent id — the sync has nobody to run it
    expect(installer.approve('invoices', {})).toMatchObject({ code: 400, body: { error: 'bind the producer role finance to at least one agent' } })
    expect(installer.approve('invoices', { producers: ['writer'] }).code).toBe(200)
    expect(installer.operatorPatch('invoices', { producers: ['finance'] })).toMatchObject({
      code: 400,
      body: { error: 'archived — an archived agent works no rows: finance' },
    })
    archived.delete('finance')
    expect(installer.operatorPatch('invoices', { producers: ['finance'] }).code).toBe(200)
  })

  it("the owner's submission may name who produces it (a role pack's new agent): proposed, approved with no binding sent; an agent's may not", () => {
    const { installer, operator } = setup({ bearer: () => true })
    installer.submit({ manifest: ref('invoices') }, 'owner', { producers: ['writer', 'nobody'] })
    expect((installer.consequences('invoices') as Json).derived.proposedProducers).toEqual(['writer'])
    expect(installer.approve('invoices', {}).code).toBe(200)
    expect(operator.producersOf('invoices')).toEqual(['writer'])
    put('agent-state/writer/silo-drafts/documents.json', ref('documents'))
    installer.submit({ draft: { id: 'documents' } }, 'writer', { producers: ['finance'] })
    expect(installer.getSubmission('documents')!.producers).toBeUndefined()
  })

  it('an update: the diff with its loosenings; approval updates, never duplicates the automation', () => {
    const { installer, autos } = setup()
    installer.submit({ manifest: ref('invoices') }, 'owner')
    installer.approve('invoices', { producers: ['finance'], automation: true })
    const next = ref('invoices')
    next.metadata.version = '0.2.0'
    next.spec.surfaces.rail = { label: 'Invoices', view: 'invoices' }
    next.spec.actions[0].fields.description = { writableBy: 'owner' }
    expect(installer.submit({ manifest: next }, 'owner').code).toBe(201)
    const c = installer.consequences('invoices') as Json
    expect(c.kind).toBe('update')
    expect(c.derived.update).toEqual({
      from: '0.1.0',
      lines: ['every record on disk still reads'],
      loosening: ['set-field may now write description', 'asks for a new slot: rail'],
      off: false,
    })
    expect(installer.approve('invoices', { producers: ['finance'], automation: true })).toMatchObject({ code: 200, body: { kind: 'updated' } })
    expect(autos.size).toBe(1)
  })
})

describe('reject, uninstall, reinstall', () => {
  it('a rejection is said — event and the submitting agent told', () => {
    const { installer, events, sent } = setup()
    installer.submit({ manifest: ref('invoices') }, 'finance')
    expect(installer.reject('invoices', 'not this month')).toMatchObject({ code: 200, body: { rejected: 'invoices', reason: 'not this month' } })
    expect(installer.submissions()).toEqual([])
    expect(events.list('invoices').at(-1)!.text).toBe('rejected Invoices: not this month')
    expect(sent.at(-1)).toEqual({ from: 'owner', to: 'finance', text: 'Your silo Invoices was not approved: not this month' })
    expect(installer.reject('invoices', null).code).toBe(404)
  })

  it('uninstall destroys nothing, pauses the sync, lists the producers; files still growing become a Home term', () => {
    const f = put('agent-state/finance/silos/invoices/a1.json', invoice('a1'), new Date('2026-10-01T00:00:00Z'))
    let now = Date.parse('2026-10-30T12:00:00Z')
    const s = setup()
    const installer = new SiloInstaller({ ...(s.installer as any).o, now: () => now })
    installer.submit({ manifest: ref('invoices') }, 'owner')
    installer.approve('invoices', { producers: ['finance'], automation: true })
    s.kernel.refresh()
    s.actions.setField('invoices', 'agent:finance/a1', 'state', 'paid')
    const r = installer.uninstall('invoices')
    expect(r.code).toBe(200)
    expect(r.body).toMatchObject({
      uninstalled: 'invoices',
      kept: { records: 1, conventions: ['agent-state:silos/invoices'] },
      producers: ['finance'],
      automation: { paused: true },
    })
    expect(s.operator.get('invoices')).toMatchObject({ keptRecords: 1 })
    expect(s.registry.get('invoices')).toBeNull()
    expect(existsSync(f)).toBe(true)
    expect(readdirSync(join(s.root, 'uninstalled'))[0]).toMatch(/^invoices-/)
    const conv = join(s.registry.conventionsDir, encodeURIComponent('agent-state:silos/invoices'))
    expect(existsSync(join(conv, 'journal.jsonl'))).toBe(true)
    expect(readdirSync(join(conv, 'data'))).toHaveLength(1)
    expect([...s.autos.values()][0]).toMatchObject({ paused: true, autoPaused: true })
    expect(s.operator.get('invoices')).toMatchObject({ decision: 'uninstalled', producers: ['finance'] })
    expect(s.events.list('invoices').at(-1)!.text).toBe(
      "uninstalled Invoices — its 1 records, the owner's overlay and the journal stay · still producing: finance",
    )
    expect(installer.growth()).toEqual([])
    now += 120_000
    put('agent-state/finance/silos/invoices/a2.json', invoice('a2'), new Date(now))
    expect(installer.growth()).toEqual([
      {
        silo: 'invoices',
        siloName: 'Invoices',
        records: 1,
        since: '2026-10-30T12:00:00.000Z',
        term: "1 record written to Invoices's files since it was uninstalled — no silo shows them",
      },
    ])
  })

  it('reinstall: the owner may; a bearer only if it is a bound producer', () => {
    const { installer, actions } = setup()
    installer.submit({ manifest: ref('invoices') }, 'owner')
    installer.approve('invoices', { producers: ['finance'] })
    installer.uninstall('invoices')
    expect(installer.submit({ manifest: ref('invoices') }, 'writer')).toMatchObject({
      code: 403,
      body: { error: 'invoices belongs to a silo that is installed or was approved before — only its bound producers (finance) may submit an update' },
    })
    expect(installer.submit({ manifest: ref('invoices') }, 'finance').code).toBe(201)
    expect(installer.submit({ manifest: ref('invoices') }, 'owner').code).toBe(201)
    expect((installer.consequences('invoices') as Json).kind).toBe('reinstall')
    expect(installer.approve('invoices', { producers: ['finance', 'writer'] })).toMatchObject({ code: 200, body: { kind: 'reinstalled' } })
    // the binding replaces role = id: writer now writes as a producer
    expect(actions.agentWrite('invoices', 'writer', 'd1', invoice('d1')).ok).toBe(true)
  })

  it('a pending submission by one agent is not taken over by another', () => {
    const { installer } = setup()
    installer.submit({ manifest: ref('documents') }, 'finance')
    expect(installer.submit({ manifest: ref('documents') }, 'writer')).toMatchObject({
      code: 409,
      body: { error: 'a submission of documents by finance is already pending' },
    })
  })
})

// Settings › Silos: the owner's door back — the manifest Silos
// already holds goes through submit(), and the list says what stayed.
describe("resubmit — the owner's door back", () => {
  it('an uninstalled silo: the newest kept manifest becomes a reinstall; approval reactivates it', () => {
    put('agent-state/finance/silos/invoices/a1.json', invoice('a1'), new Date('2026-10-01T00:00:00Z'))
    let now = Date.parse('2026-10-30T12:00:00Z')
    const s = setup()
    const installer = new SiloInstaller({ ...(s.installer as any).o, now: () => now })
    installer.submit({ manifest: ref('invoices') }, 'owner')
    installer.approve('invoices', { producers: ['finance'], automation: true })
    installer.uninstall('invoices')
    // an OLDER kept copy with another version, and a copy of another id that
    // shares the prefix: neither is the one submitted
    const old = ref('invoices')
    old.metadata.version = '0.0.9'
    put('data/silos/uninstalled/invoices-2026-09-01T00-00-00-000Z.json', old)
    const other = ref('invoices')
    other.metadata.id = 'invoices-old'
    put('data/silos/uninstalled/invoices-old-2026-12-01T00-00-00-000Z.json', other)

    const [u] = installer.uninstalled()
    expect(u).toMatchObject({
      id: 'invoices',
      name: 'Invoices',
      uninstalledAt: '2026-10-30T12:00:00.000Z',
      producers: ['finance'],
      kept: { files: 1, records: 1, conventions: ['agent-state:silos/invoices'] },
      grown: 0,
      manifest: { version: '0.1.0', keptAt: '2026-10-30T12:00:00.000Z' },
      automation: { paused: true },
      submission: null,
    })
    expect(installer.uninstalled()).toHaveLength(1)

    now += 60_000
    const r = installer.resubmit('invoices')
    expect(r.code).toBe(201)
    expect(installer.getSubmission('invoices')!.manifest.metadata.version).toBe('0.1.0')
    expect(installer.needsYou()[0]).toMatchObject({ submission: { kind: 'reinstall' } })
    expect((installer.consequences('invoices') as Json).kind).toBe('reinstall')
    expect(s.events.list('invoices').at(-1)).toMatchObject({
      verb: 'submitted',
      by: 'owner',
      text: 'you submitted Invoices 0.1.0 from the manifest kept when it was uninstalled (2026-10-30T12:00:00.000Z) — waiting for the owner',
    })
    expect(installer.uninstalled()[0]!.submission).toMatchObject({ submittedBy: 'owner', version: '0.1.0' })

    expect(installer.approve('invoices', { producers: ['finance'], automation: true })).toMatchObject({ code: 200, body: { kind: 'reinstalled' } })
    expect(s.registry.get('invoices')!.status.state).toBe('active')
    expect(installer.uninstalled()).toEqual([])
    expect([...s.autos.values()]).toHaveLength(1) // the paused automation is resumed, never duplicated
    expect([...s.autos.values()][0]!.paused).toBe(false)
  })

  it('a pending submission is answered, never stacked', () => {
    const { installer } = setup()
    installer.submit({ manifest: ref('invoices') }, 'owner')
    installer.approve('invoices', { producers: ['finance'] })
    installer.uninstall('invoices')
    expect(installer.resubmit('invoices').code).toBe(201)
    const again = installer.resubmit('invoices')
    expect(again).toMatchObject({
      code: 409,
      body: { error: 'a submission of invoices already waits for your approval', submission: { id: 'invoices', submittedBy: 'owner', state: 'pending' } },
    })
    expect(installer.submissions()).toHaveLength(1)
  })

  it('a silo pending in the registry without a submission: its own manifest, an INSTALL (not an update of itself)', () => {
    put('data/silos/registry/documents/silo.json', ref('documents'))
    const s = setup()
    expect(s.registry.get('documents')!.status.state).toBe('pending')
    const r = s.installer.resubmit('documents')
    expect(r.code).toBe(201)
    expect(s.events.list('documents').at(-1)!.text).toBe('you submitted Documents 0.1.0 from the manifest in the registry — waiting for the owner')
    expect(s.installer.needsYou()[0]).toMatchObject({
      text: '0.1.0 waits for your approval to install — submitted by you',
      submission: { kind: 'install', from: null },
    })
    const c = s.installer.consequences('documents') as Json
    expect(c).toMatchObject({ kind: 'install', version: { from: null, to: '0.1.0' }, derived: { update: null } })
    expect(s.installer.approve('documents', { producers: ['finance'] })).toMatchObject({ code: 200, body: { kind: 'installed' } })
    expect(s.registry.get('documents')!.status.state).toBe('active')
  })

  it('a bearer over a registry-pending id is still refused, with words that are true', () => {
    put('data/silos/registry/documents/silo.json', ref('documents'))
    const s = setup()
    expect(s.registry.get('documents')!.status.state).toBe('pending')
    expect(s.installer.submit({ manifest: ref('documents') }, 'writer')).toMatchObject({
      code: 403,
      body: { error: 'documents already sits pending in the registry — only the owner submits it for approval (Settings › Silos)' },
    })
  })

  it('nothing to submit is said: unknown, installed, uninstalled without a kept manifest', () => {
    const s = setup()
    expect(s.installer.resubmit('nope')).toMatchObject({
      code: 404,
      body: { error: 'no silo nope — nothing installed, uninstalled or waiting in the registry' },
    })
    expect(s.installer.resubmit('../x').code).toBe(404)
    s.installer.submit({ manifest: ref('invoices') }, 'owner')
    s.installer.approve('invoices', { producers: ['finance'] })
    expect(s.installer.resubmit('invoices')).toMatchObject({ code: 409, body: { error: 'invoices is active — there is nothing to submit' } })
    s.installer.uninstall('invoices')
    rmSync(join(s.root, 'uninstalled'), { recursive: true })
    expect(s.installer.uninstalled()[0]!.manifest).toBeNull()
    expect(s.installer.resubmit('invoices')).toMatchObject({
      code: 404,
      body: { error: 'invoices was uninstalled but no manifest of it was kept — its author submits it again' },
    })
  })
})

describe("the operator's switches", () => {
  it('slots off, off/on, producers — each an event, read back by the registry', () => {
    const { installer, registry, events } = setup()
    installer.submit({ manifest: ref('invoices') }, 'owner')
    installer.approve('invoices', { producers: ['finance'] })
    expect(installer.operatorPatch('invoices', { slotsOff: ['pulse'] })).toMatchObject({
      code: 200,
      body: { silo: { slots: { granted: ['needs-you', 'agent-section'], off: ['pulse'] } } },
    })
    expect(installer.operatorPatch('invoices', { disabled: true }).code).toBe(200)
    expect(registry.get('invoices')!.status.state).toBe('disabled')
    expect(installer.operatorPatch('invoices', { slotsOff: ['bogus'] }).code).toBe(400)
    expect(installer.operatorPatch('nope', { disabled: true }).code).toBe(404)
    expect(
      events
        .list('invoices')
        .slice(-2)
        .map((e) => e.text),
    ).toEqual(['slots off: pulse', 'turned off'])
  })

  it('audienceOff — the per-entry veto on a routed audience, an event like the rest', () => {
    const { installer, operator, events } = setup()
    installer.submit({ manifest: ref('invoices') }, 'owner')
    installer.approve('invoices', { producers: ['finance'] })
    expect(installer.operatorPatch('invoices', { audienceOff: [0, 0, 2] }).code).toBe(200)
    expect(operator.audienceOff('invoices')).toEqual([0, 2])
    expect(events.list('invoices').slice(-1)[0]!.text).toBe('audience back to you on entries: 0, 2')
    expect(installer.operatorPatch('invoices', { audienceOff: ['x'] }).code).toBe(400)
    expect(installer.operatorPatch('invoices', { audienceOff: [-1] }).code).toBe(400)
    expect(installer.operatorPatch('invoices', { audienceOff: [] })).toMatchObject({ code: 200 })
    expect(operator.audienceOff('invoices')).toEqual([])
  })
})

describe('helpers', () => {
  it('cronForCadence', () => {
    expect(cronForCadence('24h')).toEqual({ cron: '0 0 * * *', says: 'every 24h, at 00:00 server time' })
    expect(cronForCadence('6h')).toEqual({ cron: '0 */6 * * *', says: 'every 6h, on the hour' })
    expect(cronForCadence('15m')).toEqual({ cron: '*/15 * * * *', says: 'every 15 minutes' })
    expect(cronForCadence('7d')).toEqual({ cron: '0 0 */7 * *', says: 'every 7 days, at 00:00 server time' })
    expect(cronForCadence('7h')).toBeNull()
  })
  it('loosening names a new convention and a changed producer', () => {
    const a = ref('invoices')
    const b = ref('invoices')
    b.spec.producer.role = 'writer'
    expect(loosening(a, b, [{ convention: 'x' } as any], [{ convention: 'x' } as any, { convention: 'y' } as any])).toEqual([
      'reads files it did not read before: y',
      'the producer role changes from finance to writer',
    ])
  })
  it('the sync prompt carries the contract', () => {
    expect(syncPrompt(ref('invoices'))).toContain('- Idempotent: same service id → same file')
  })
})
