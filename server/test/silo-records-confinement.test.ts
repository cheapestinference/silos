// silo-records-confinement.test.ts — sixth review round: a silo's record
// files are read and written through safe-file.ts — the kernel's read, the
// owner's set-field (CAS + atomic replace) and the producer's
// agent-record-write. A hard link the agent plants in its state (a second
// name for another agent's file, or any file of the house) is never read as
// its record, never merged into one, never written over.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SiloRegistry } from '../src/silos/registry.js'
import { SiloReader } from '../src/silos/reader.js'
import { SiloKernel } from '../src/silos/kernel.js'
import { TransitionJournal } from '../src/silos/journal.js'
import { OverlayStore } from '../src/silos/overlay.js'
import { SiloActions, SiloAcks, SiloEvents, SiloProposals } from '../src/silos/actions.js'
import { siloManifest } from './helpers/silo-manifests.js'

type Json = Record<string, any>
const ref = (id: string): Json => siloManifest(id) as Json
const AGENTS = ['finance', 'support']
const isAgent = (v: string): boolean => AGENTS.includes(v)

let base: string
beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'silo-rec-conf-')))
})
afterEach(() => rmSync(base, { recursive: true, force: true }))
const as = (): string => join(base, 'agent-state')
function put(rel: string, v: unknown): string {
  const f = join(base, rel)
  mkdirSync(join(f, '..'), { recursive: true })
  writeFileSync(f, JSON.stringify(v, null, 2))
  utimesSync(f, new Date(), new Date())
  return f
}

function setup() {
  const dataDir = join(base, 'data')
  for (const id of ['invoices', 'support']) {
    mkdirSync(join(dataDir, 'silos', 'registry', id), { recursive: true })
    writeFileSync(join(dataDir, 'silos', 'registry', id, 'silo.json'), JSON.stringify(ref(id)))
  }
  const registry = new SiloRegistry({ dataDir, operator: { decisionFor: () => 'approved', slotsOff: () => [] } })
  registry.load()
  const kernel = new SiloKernel({
    registry,
    journal: new TransitionJournal(registry.conventionsDir),
    overlay: new OverlayStore(registry.conventionsDir),
    isAgent,
    reader: new SiloReader({ agentStates: () => AGENTS.map((a) => ({ agentId: a, dir: join(as(), a) })), projects: () => [] }),
  })
  kernel.refresh()
  const actions = new SiloActions({
    registry,
    kernel,
    events: new SiloEvents(registry.root),
    acks: new SiloAcks(registry.root),
    proposals: new SiloProposals(registry.root),
    messages: { send: () => ({ id: 'm1' }) },
    agentStateBase: as(),
    isAgent,
    agentMayReadLocation: (agent, loc) => loc === `agent:${agent}`,
    // the owner's bindings (operator.json): a role is never an agent id
    producersOf: (id: string) => (({ invoices: ['finance'], support: ['support'] }) as Record<string, string[]>)[id] ?? null,
  })
  return { kernel, actions }
}

const invoice = (over: Json = {}): Json => ({ ...ref('invoices').spec.kinds.invoice.examples[0], ...over })
const canon = (over: Json = {}): Json => ({ ...ref('support').spec.kinds.case.examples[0], ...over })

describe("silo records are the agent's own files", () => {
  it("the kernel never reads a hard-linked record as the agent's", () => {
    const victim = put('elsewhere/bob-invoice.json', invoice({ id: 'hd-bob' }))
    mkdirSync(join(as(), 'finance', 'silos', 'invoices'), { recursive: true })
    linkSync(victim, join(as(), 'finance', 'silos', 'invoices', 'hd-bob.json'))
    put('agent-state/finance/silos/invoices/hd-mine.json', invoice({ id: 'hd-mine' }))
    const { kernel } = setup()
    const ids = (kernel.reading('invoices')?.records ?? []).map((r) => String(r.record.id))
    expect(ids).toEqual(['hd-mine'])
  })

  it('agent-record-write over a hard-linked record: refused, the other file neither merged nor touched', () => {
    const victim = put('elsewhere/case.json', canon({ id: 'c1', notes: [{ at: '2026-10-29T10:00:00Z', by: 'owner', text: 'PRIVATE NOTE' }] }))
    const before = readFileSync(victim, 'utf8')
    mkdirSync(join(as(), 'support', 'support', 'cases'), { recursive: true })
    linkSync(victim, join(as(), 'support', 'support', 'cases', 'c1.json'))
    const { actions } = setup()
    const r = actions.agentWrite('support', 'support', 'c1', canon({ id: 'c1', notes: [] }))
    expect(r).toMatchObject({ ok: false, code: 409 })
    expect(readFileSync(victim, 'utf8')).toBe(before)
  })

  it("the owner's set-field on a record whose file became a hard link: refused, nothing written", () => {
    const f = put('agent-state/support/support/cases/c1.json', canon({ id: 'c1' }))
    const { actions } = setup()
    const victim = put('elsewhere/x.json', canon({ id: 'c1', mine: 'VICTIM' }))
    rmSync(f)
    linkSync(victim, f)
    const before = readFileSync(victim, 'utf8')
    expect(actions.setField('support', 'agent:support/c1', 'userId', null)).toMatchObject({ ok: false, code: 409 })
    expect(readFileSync(victim, 'utf8')).toBe(before)
  })

  it('plain records still read and write', () => {
    const f = put('agent-state/support/support/cases/c1.json', canon({ id: 'c1' }))
    const { actions } = setup()
    expect(actions.setField('support', 'agent:support/c1', 'userId', null).ok).toBe(true)
    expect('userId' in JSON.parse(readFileSync(f, 'utf8'))).toBe(false)
    expect(actions.agentWrite('invoices', 'finance', 'hd-new', invoice({ id: 'hd-new' })).ok).toBe(true)
  })
})
