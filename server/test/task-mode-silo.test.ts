// task-mode-silo.test.ts — the Task mode silo on the Silo Standard (task-view
// phase 3): a kernel kind written ABOUT bound agents (`task-wake`, binds:
// producers), its validator rule (an agent role, instructions allowed, never
// sync — and the old rule untouched for every other kernel kind), the brief
// the bound agents get (the protocol, no record routes) and the unbound don't
// (byte-identical), and the install: offered in the catalog, nobody proposed,
// at least one agent to approve, rebinding through the operator.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { validateSilo } from '../src/silos/validator.js'
import { KERNEL_KINDS } from '../src/silos/kernel-kinds.js'
import { SiloRegistry } from '../src/silos/registry.js'
import { SiloReader } from '../src/silos/reader.js'
import { SiloKernel } from '../src/silos/kernel.js'
import { TransitionJournal } from '../src/silos/journal.js'
import { SiloOperatorStore } from '../src/silos/operator.js'
import { SiloInstaller } from '../src/silos/installer.js'
import { SiloEvents } from '../src/silos/actions.js'
import { producerBriefFor, bindsThroughKernel } from '../src/silos/producer-brief.js'
import { availableSilos } from '../src/silos/catalog.js'
import { TaskModeStore } from '../src/task-mode/store.js'
import type { SiloLocations } from '../src/silos/files-source.js'
import { siloManifest } from './helpers/silo-manifests.js'

type Json = Record<string, any>
const ref = (name = 'task-mode'): Json => siloManifest(name) as Json
const NOW = Date.parse('2026-11-03T12:00:00Z')
const errorsOf = (m: unknown): Array<[number, string, string]> => validateSilo(m, { now: NOW }).errors.map((e) => [e.check, e.where, e.message])

let base: string
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'task-mode-silo-'))
})
afterEach(() => rmSync(base, { recursive: true, force: true }))

describe('the manifest and the kernel kind task-wake', () => {
  it('the reference manifest validates; the kind binds producers', () => {
    expect(errorsOf(ref())).toEqual([])
    expect(KERNEL_KINDS['task-wake']!.binds).toBe('producers')
    expect(KERNEL_KINDS.process!.binds).toBeUndefined()
    expect(bindsThroughKernel(ref())).toBe(true)
    expect(bindsThroughKernel(ref('system'))).toBe(false)
    expect(bindsThroughKernel(ref('plans'))).toBe(false)
  })
  it('check 3: over a binding kind the role is an agent role — never kernel, never any-agent, never a sync', () => {
    const a = ref()
    a.spec.producer = { role: 'kernel' }
    expect(errorsOf(a)).toEqual([
      [3, 'spec.producer.role', 'the kernel writes task-wake about the agents the owner binds — name the role they are bound to (not "kernel")'],
    ])
    const b = ref()
    b.spec.producer.role = 'any-agent'
    expect(errorsOf(b).map((e) => e[1])).toEqual(['spec.producer.role'])
    const c = ref()
    c.spec.producer.sync = { service: 'X', contract: ['one record per file'] }
    expect(errorsOf(c)).toEqual([[3, 'spec.producer', 'a kernel source has no sync — the kernel produces its records']])
  })
  it('every other kernel kind keeps the old rule: producer kernel, nobody to instruct', () => {
    const s = ref('system')
    s.spec.producer = { role: 'finance', instructions: { summary: 'x' } }
    expect(errorsOf(s).map((e) => e[2])).toContain('the records of a kernel source are written by the kernel — its producer role is kernel (found "finance")')
  })
  it("the store's records read through the manifest (a queued wake, a delivered one)", () => {
    const store = new TaskModeStore(join(base, 'data'))
    store.update((st) => {
      st.wakes.push({
        id: 'writer~p~t1~unblocked~1',
        agent: 'writer',
        task: 'folder:/p/p/tasks/t1',
        ref: 'p#t1',
        title: 'T',
        reason: 'unblocked',
        says: 'its blockers are done (t0)',
        at: '2026-11-03T10:00:00.000Z',
        state: 'delivered',
        deliveredAt: '2026-11-03T10:00:01.000Z',
        session: 's-1',
        notes: [],
        bypassThrottle: false,
      })
      st.wakes.push({
        id: 'writer~p~t2~owner-note~2',
        agent: 'writer',
        task: 'folder:/p/p/tasks/t2',
        ref: 'p#t2',
        title: 'U',
        reason: 'owner-note',
        says: 'a note from the owner',
        at: '2026-11-03T11:00:00.000Z',
        state: 'queued',
        held: 'a console holds it',
        notes: [{ at: 'x', by: 'owner', text: 'private words' }],
        bypassThrottle: true,
      })
    })
    const reader = new SiloReader({ agentStates: () => [], projects: () => [] }, (k) => (k === 'task-wake' ? store : null))
    const reading = reader.read('task-mode', ref())
    expect(reading.unreadable).toEqual([])
    expect(reading.records.map((r) => [r.record.identity, r.record.state])).toEqual([
      ['p#t1 · its blockers are done (t0)', 'delivered'],
      ['p#t2 · a note from the owner', 'queued'],
    ])
    // the notes a wake carries are not part of the record the silo presents
    expect(JSON.stringify(reading.records)).not.toContain('private words')
  })
})

describe('the brief: the protocol reaches ONLY the bound agents', () => {
  function silos(producers: string[] | null) {
    const dataDir = join(base, 'data')
    const operator = new SiloOperatorStore(join(dataDir, 'silos'))
    mkdirSync(join(dataDir, 'silos', 'registry', 'task-mode'), { recursive: true })
    writeFileSync(join(dataDir, 'silos', 'registry', 'task-mode', 'silo.json'), JSON.stringify(ref()))
    if (producers) operator.set('task-mode', { decision: 'approved', producers, slotsOff: [], decidedAt: 'x' })
    const registry = new SiloRegistry({ dataDir, operator })
    registry.load()
    return { registry, operator }
  }
  it('a bound agent gets the summary and the protocol — no record places, no routes', () => {
    const { registry, operator } = silos(['finance'])
    const brief = producerBriefFor('finance', [], { registry, operator })!
    expect(brief).toContain('## Silo you produce: Task mode (task-mode)')
    expect(brief).toContain('You work in TASK MODE')
    expect(brief).toContain('- Leave every turn with an explicit disposition')
    expect(brief).toContain('Naming someone in a note is not a block')
    expect(brief).not.toContain('Your records live')
    expect(brief).not.toContain('/api/silos/task-mode/agents')
  })
  it('an unbound agent — and everyone, with nobody bound or the silo not installed — gets nothing (the append stays as it was)', () => {
    expect(producerBriefFor('writer', [], silos(['finance']))).toBeNull()
    rmSync(join(base, 'data'), { recursive: true, force: true })
    expect(producerBriefFor('finance', [], silos([]))).toBeNull()
    rmSync(join(base, 'data'), { recursive: true, force: true })
    expect(producerBriefFor('finance', [], silos(null))).toBeNull()
  })
})

describe('the install: opt-in, nobody bound until the owner binds', () => {
  function world() {
    const dataDir = join(base, 'data')
    const root = join(dataDir, 'silos')
    const store = new TaskModeStore(dataDir)
    const kinds = (k: string) => (k === 'task-wake' ? store : null)
    const operator = new SiloOperatorStore(root)
    const registry = new SiloRegistry({ dataDir, operator })
    registry.load()
    const locations: SiloLocations = { agentStates: () => [], projects: () => [] }
    const kernel = new SiloKernel({
      registry,
      reader: new SiloReader(locations, kinds),
      journal: new TransitionJournal(registry.conventionsDir),
      isAgent: (v) => ['finance', 'writer', 'task-agent'].includes(v),
      now: () => NOW,
    })
    const installer = new SiloInstaller({
      root,
      registry,
      operator,
      kernel,
      events: new SiloEvents(root),
      locations,
      agentStateBase: join(base, 'agent-state'),
      isAgent: (v) => ['finance', 'writer'].includes(v),
      hasBearer: () => false,
      territoriesOf: () => [],
      now: () => NOW,
      kernelKinds: kinds,
    })
    return { installer, operator, registry }
  }
  // Task mode comes WITH Silos — born at boot with nobody
  // bound (zero change until the owner binds an agent), never in Available
  it('it comes with Silos (builtin since 09-11): not in the catalog', () => {
    expect(availableSilos({ heldIds: () => new Set() }).map((a) => a.id)).not.toContain('task-mode')
  })
  it('the dialog proposes nobody and says it binds a protocol; it installs with nobody bound', () => {
    const w = world()
    expect(w.installer.submit({ manifest: ref() }, 'owner').code).toBe(201)
    const c = w.installer.consequences('task-mode') as Json
    expect(c.derived.producerRole).toBe('task-agent')
    expect(c.derived.bindsTo).toBe('protocol')
    expect(c.derived.proposedProducers).toEqual([])
    expect(c.derived.requirements).toEqual([])
    // installing binds nobody unless the owner picks: Task mode for nobody
    const ok = w.installer.approve('task-mode', {})
    expect(ok.code).toBe(200)
    expect(w.operator.producersOf('task-mode')).toEqual([])
    expect(w.installer.operatorPatch('task-mode', { producers: ['finance'] }).code).toBe(200)
    expect(w.operator.producersOf('task-mode')).toEqual(['finance'])
    // rebinding after approval — the owner's switch; none bound = task mode for nobody
    expect(w.installer.operatorPatch('task-mode', { producers: ['finance', 'writer'] }).code).toBe(200)
    expect(w.operator.producersOf('task-mode')).toEqual(['finance', 'writer'])
    expect(w.installer.operatorPatch('task-mode', { producers: [] }).code).toBe(200)
    expect(w.operator.producersOf('task-mode')).toEqual([])
  })
})
