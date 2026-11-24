// The dimensions that come with Silos (silos/native.ts): a dimension still
// served NATIVELY never enters through the door (once, Plans installed from
// Available counted the owner's plan tasks twice), and a BUILTIN silo is installed by the platform
// at boot, born active, said as an event, uninstallable — and an uninstall is
// respected at every later boot. Plans, Task mode and System are the
// house's recommended builtins; the native guard runs over the table as it was before the
// plans flip (PRE_FLIP: plans native) — the mechanism, with the manifest that
// once tested it for real.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SiloRegistry } from '../src/silos/registry.js'
import { SiloReader } from '../src/silos/reader.js'
import { SiloKernel } from '../src/silos/kernel.js'
import { TransitionJournal } from '../src/silos/journal.js'
import { OverlayStore } from '../src/silos/overlay.js'
import { SiloOperatorStore } from '../src/silos/operator.js'
import { SiloInstaller, compareVersions } from '../src/silos/installer.js'
import { SiloEvents } from '../src/silos/actions.js'
import { availableSilos, availableManifest } from '../src/silos/catalog.js'
import { DIMENSIONS, HOUSE_DIMENSIONS, dimensions, engineWords, nativeWords, type Dimension, type Dimensions } from '../src/silos/native.js'
import type { SiloLocations } from '../src/silos/files-source.js'
import { siloManifest } from './helpers/silo-manifests.js'

type Json = Record<string, any>
const ref = (id: string): Json => siloManifest(id)
const AGENTS = ['finance', 'writer', 'support']

let base: string
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'silo-native-'))
})
afterEach(() => rmSync(base, { recursive: true, force: true }))

function put(rel: string, v: unknown): string {
  const f = join(base, rel)
  mkdirSync(join(f, '..'), { recursive: true })
  writeFileSync(f, typeof v === 'string' ? v : JSON.stringify(v, null, 2))
  return f
}

// the support reference manifest under another id — the fixture builtin
function helpdesk(over: (m: Json) => void = () => {}): Json {
  const m = ref('support')
  m.metadata.id = 'helpdesk'
  m.metadata.name = 'Helpdesk'
  m.metadata.version = '0.2.0' // the fixture's own version, whatever the reference ships
  over(m)
  return m
}
const kase = (id: string, over: Json = {}): Json => ({ ...ref('support').spec.kinds.case.examples[0], id, ...over })

// the house table as it was before the plans flip: plans native
const PRE_FLIP: Dimensions = dimensions(
  DIMENSIONS.map((d) => (d.id === 'plans' ? { id: d.id, name: d.name, served: 'native' as const, manifest: d.manifest! } : d)),
)

function setup(dims: Dimensions = HOUSE_DIMENSIONS) {
  const dataDir = join(base, 'data')
  const root = join(dataDir, 'silos')
  const operator = new SiloOperatorStore(root)
  const registry = new SiloRegistry({ dataDir, operator, nativeRefusal: (id) => dims.nativeRefusal(id) })
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
  const installer = new SiloInstaller({
    root,
    registry,
    operator,
    kernel,
    events,
    locations,
    agentStateBase: join(base, 'agent-state'),
    isAgent,
    hasBearer: () => true,
    territoriesOf: () => [],
    dimensions: dims,
  })
  return { root, operator, registry, kernel, events, installer }
}

// a fixture table: helpdesk builtin (its manifest in a temp reference dir), alfa native
function fixtureDims(m: Json | string = helpdesk(), served: Dimension['served'] = 'builtin'): Dimensions {
  const dir = join(base, 'reference')
  put('reference/helpdesk.silo.json', m)
  return dimensions(
    [
      { id: 'helpdesk', name: 'Helpdesk', served, manifest: 'helpdesk.silo.json' },
      { id: 'alfa', name: 'Alfa', served: 'native' },
    ],
    dir,
  )
}

describe('the house table', () => {
  it('the recommended silos are Plans, Task mode and System — Plans and System born with their pulse off, each saying what uninstalling it gives up; none is native any more', () => {
    expect(DIMENSIONS.map((d) => d.id)).toEqual(['plans', 'memories', 'skills', 'mcps', 'task-mode', 'system'])
    expect(DIMENSIONS.filter((d) => d.served === 'builtin').map((d) => [d.id, d.slotsOff])).toEqual([
      ['plans', ['pulse']],
      ['task-mode', undefined],
      ['system', ['pulse']],
    ])
    expect(DIMENSIONS.filter((d) => d.served === 'native')).toEqual([])
    expect(HOUSE_DIMENSIONS.builtins()).toEqual([
      expect.objectContaining({ id: 'plans', slotsOff: ['pulse'], manifest: expect.objectContaining({ metadata: expect.objectContaining({ id: 'plans' }) }) }),
      expect.objectContaining({ id: 'task-mode', manifest: expect.objectContaining({ metadata: expect.objectContaining({ id: 'task-mode' }) }) }),
      expect.objectContaining({
        id: 'system',
        slotsOff: ['pulse'],
        manifest: expect.objectContaining({ metadata: expect.objectContaining({ id: 'system' }) }),
      }),
    ])
    for (const id of ['plans', 'task-mode', 'system']) expect(HOUSE_DIMENSIONS.loses(id)).toMatch(/\.$/)
    // Support and Executions are optional: not builtin, not native — the catalog offers them
    for (const id of ['support', 'executions', 'invoices']) {
      expect(HOUSE_DIMENSIONS.isBuiltin(id)).toBe(false)
      expect(HOUSE_DIMENSIONS.nativeRefusal(id)).toBeNull()
      expect(HOUSE_DIMENSIONS.loses(id)).toBeNull()
    }
  })
  // memories, skills and MCPs are configuration the engine
  // consumes (its own files are the truth) — they never become silos, and
  // the door refuses their ids saying so, not «when Silos migrates it»
  it('memories, skills and MCPs are part of the engine: refused at the door in their own words, never builtins', () => {
    expect(DIMENSIONS.filter((d) => d.served === 'engine').map((d) => d.id)).toEqual(['memories', 'skills', 'mcps'])
    expect(HOUSE_DIMENSIONS.nativeRefusal('skills')).toBe("Skills is part of the engine — Silos reads it from the engine's own files; it never becomes a silo")
    expect(HOUSE_DIMENSIONS.nativeRefusal('mcps')).toBe(engineWords('MCPs'))
    expect(HOUSE_DIMENSIONS.isBuiltin('memories')).toBe(false)
  })
  it('the manifests the table names exist and say their own id', () => {
    for (const d of DIMENSIONS.filter((x) => x.manifest)) expect(ref(d.id).metadata.id).toBe(d.id)
  })
  it('moving a row from native to builtin is ONE edit: it leaves the refusal and joins the builtins', () => {
    const native = fixtureDims(helpdesk(), 'native')
    expect(native.nativeRefusal('helpdesk')).toBe(nativeWords('Helpdesk'))
    expect(native.builtins()).toEqual([])
    const builtin = fixtureDims(helpdesk(), 'builtin')
    expect(builtin.nativeRefusal('helpdesk')).toBeNull()
    expect(builtin.isBuiltin('helpdesk')).toBe(true)
    expect(builtin.builtins()).toEqual([
      expect.objectContaining({ id: 'helpdesk', manifest: expect.objectContaining({ metadata: expect.objectContaining({ id: 'helpdesk' }) }) }),
    ])
  })
  it('a builtin whose manifest is missing, unreadable or another id is said, never a crash', () => {
    expect(dimensions([{ id: 'x', name: 'X', served: 'builtin', manifest: 'x.silo.json' }], join(base, 'nowhere')).builtins()).toEqual([
      { id: 'x', name: 'X', error: 'its manifest x.silo.json is not in this Silos' },
    ])
    put('r/x.silo.json', '{nope')
    expect(dimensions([{ id: 'x', name: 'X', served: 'builtin', manifest: 'x.silo.json' }], join(base, 'r')).builtins()[0]).toMatchObject({
      error: expect.stringContaining('could not be read'),
    })
    put('r/y.silo.json', { metadata: { id: 'zeta' } })
    expect(dimensions([{ id: 'y', name: 'Y', served: 'builtin', manifest: 'y.silo.json' }], join(base, 'r')).builtins()[0]).toMatchObject({
      error: 'its manifest y.silo.json does not say id "y"',
    })
  })
})

describe('the native guard — the catalog never offers a native dimension', () => {
  it('the shipped catalog offers the optional silos — never a recommended one', () => {
    expect(availableSilos({ heldIds: () => new Set() }).map((x) => x.id)).toEqual(['executions', 'heather', 'hierarchy', 'support'])
    expect(availableManifest({ heldIds: () => new Set() }, 'plans')).toBeNull()
    expect(availableManifest({ heldIds: () => new Set() }, 'system')).toBeNull()
  })
  it('a fixture table decides what is native', () => {
    put('cat/a.silo.json', { metadata: { id: 'alfa' } })
    put('cat/b.silo.json', { metadata: { id: 'beta' } })
    expect(availableSilos({ dir: join(base, 'cat'), heldIds: () => new Set(), dimensions: fixtureDims() }).map((x) => x.id)).toEqual(['beta'])
  })
})

describe('the native guard — the door refuses it, in plain words', () => {
  it('submit: the owner and an agent alike get 409 and the words; nothing lands', () => {
    const { installer, events } = setup(PRE_FLIP)
    for (const by of ['owner', 'writer']) {
      for (const id of ['plans']) {
        const r = installer.submit({ manifest: ref(id) }, by)
        expect(r.code).toBe(409)
        expect(r.body).toEqual({ error: PRE_FLIP.nativeRefusal(id), native: true })
      }
    }
    expect(installer.submissions()).toEqual([])
    expect(events.list()).toEqual([])
  })
  it('a draft of a native id is refused the same way', () => {
    put('agent-state/writer/silo-drafts/plans.json', ref('plans'))
    const { installer } = setup(PRE_FLIP)
    expect(installer.submit({ draft: { id: 'plans' } }, 'writer')).toMatchObject({ code: 409, body: { native: true } })
  })
  it('resubmit: the uninstalled Plans row has its manifest kept — refused anyway, and the row says why', () => {
    const { installer, operator, root } = setup(PRE_FLIP)
    operator.set('plans', {
      decision: 'uninstalled',
      producers: [],
      slotsOff: [],
      name: 'Plans',
      decidedAt: '2026-11-02T16:48:30.942Z',
      uninstalledAt: '2026-11-02T16:48:30.942Z',
      conventions: [],
    })
    put(join('data', 'silos', 'uninstalled', 'plans-2026-11-02T16-48-30-942Z.json'), ref('plans'))
    expect(installer.keptManifest('plans')).not.toBeNull()
    const r = installer.resubmit('plans')
    expect(r).toEqual({
      code: 409,
      body: { error: 'Plans comes with Silos — it already runs natively; it becomes a silo when Silos migrates it', native: true },
    })
    expect(installer.getSubmission('plans')).toBeNull()
    const row = installer.uninstalled().find((u) => u.id === 'plans')!
    expect(row.manifest).not.toBeNull()
    expect(row.native).toBe(PRE_FLIP.nativeRefusal('plans'))
    expect(root).toBeTruthy()
  })
  it('a native submission that predates the guard: approve refuses, reject still clears it', () => {
    const { installer, registry, root } = setup(PRE_FLIP)
    put(join('data', 'silos', 'submissions', 'plans.json'), {
      id: 'plans',
      manifest: ref('plans'),
      submittedBy: 'owner',
      at: '2026-11-01T10:00:00Z',
      source: 'body',
    })
    expect(installer.approve('plans', { producers: [] })).toMatchObject({ code: 409, body: { native: true } })
    expect(registry.get('plans')).toBeNull()
    expect(installer.reject('plans', null).code).toBe(200)
    expect(installer.getSubmission('plans')).toBeNull()
    expect(root).toBeTruthy()
  })
  // review (defect 5): an install of Plans from Available (while it was
  // native) left a native id APPROVED in the registry
  it('a native id already approved and registered is turned off at boot, with the native words, as an event — nothing deleted', () => {
    const dataDir = join(base, 'data')
    put(join('data', 'silos', 'registry', 'plans', 'silo.json'), ref('plans'))
    put(join('data', 'silos', 'operator.json'), {
      version: 1,
      silos: { plans: { decision: 'approved', producers: [], slotsOff: [], name: 'Plans', decidedAt: '2026-11-01T10:00:00Z' } },
    })
    const { installer, registry, operator, events } = setup(PRE_FLIP)
    const out = installer.installBuiltins()
    const words = PRE_FLIP.nativeRefusal('plans')!
    expect(out).toContainEqual({
      id: 'plans',
      outcome: 'native-off',
      says: `Silos turned off the silo Plans: ${words} — its manifest, records and journal stay`,
    })
    expect(registry.get('plans')!.status).toMatchObject({ state: 'disabled', reason: words })
    expect(operator.get('plans')).toMatchObject({ decision: 'disabled', name: 'Plans' })
    expect(readFileSync(join(dataDir, 'silos', 'registry', 'plans', 'silo.json'), 'utf8')).toContain('"plans"')
    expect(events.list('plans')).toEqual([expect.objectContaining({ verb: 'native-off', by: 'Silos', text: out.find((o) => o.id === 'plans')!.says })])
    // the next boot finds it off: said once
    expect(installer.installBuiltins().some((o) => o.id === 'plans')).toBe(false)
    expect(events.list('plans')).toHaveLength(1)
    // turning it back on is refused in the same words
    expect(installer.operatorPatch('plans', { disabled: false })).toMatchObject({ code: 409, body: { error: words, native: true } })
  })
  it('the registry never holds a native id active, whatever operator.json says (its reason is the native words)', () => {
    const dataDir = join(base, 'data')
    put(join('data', 'silos', 'registry', 'plans', 'silo.json'), ref('plans'))
    const registry = new SiloRegistry({
      dataDir,
      operator: { decisionFor: () => 'approved', slotsOff: () => [] },
      nativeRefusal: (id) => PRE_FLIP.nativeRefusal(id),
    })
    registry.load()
    expect(registry.get('plans')!.status).toMatchObject({ state: 'disabled', reason: PRE_FLIP.nativeRefusal('plans') })
    expect(registry.get('plans')!.status.slots.granted).toEqual([])
  })
  it('an id that is not native passes the door as before', () => {
    const { installer } = setup()
    expect(installer.submit({ manifest: ref('invoices') }, 'owner').code).toBe(201)
    expect(installer.nativeRefusal('invoices')).toBeNull()
  })
})

describe('builtin — comes with Silos', () => {
  it('installBuiltins installs it at boot: active, provenance builtin, producers from the disk, a visible event', () => {
    put('agent-state/writer/support/cases/c1.json', kase('c1'))
    put('agent-state/support/support/cases/c2.json', kase('c2'))
    const { installer, registry, operator, events, kernel } = setup(fixtureDims())
    const out = installer.installBuiltins()
    expect(out).toEqual([
      {
        id: 'helpdesk',
        outcome: 'installed',
        says: 'Silos installed Helpdesk 0.2.0 — comes with Silos · producers: support, writer · slots: rail, pulse, needs-you, agent-section',
      },
    ])
    expect(registry.get('helpdesk')!.status.state).toBe('active')
    expect(operator.get('helpdesk')).toMatchObject({ decision: 'approved', provenance: 'builtin', producers: ['support', 'writer'] })
    expect(installer.provenanceOf('helpdesk')).toBe('builtin')
    expect(registry.reservedIds().approved).toContain('helpdesk')
    // born active without the dialog: no submission ever existed
    expect(installer.submissions()).toEqual([])
    expect(events.list('helpdesk')).toEqual([expect.objectContaining({ verb: 'installed', by: 'Silos', text: out[0]!.says })])
    expect(
      kernel
        .reading('helpdesk')!
        .records.map((r) => r.record.id)
        .sort(),
    ).toEqual(['c1', 'c2'])
  })
  it("a builtin born with slots off (the house table's slotsOff — support's pulse): requested, not granted, said", () => {
    const dir = join(base, 'reference')
    put('reference/helpdesk.silo.json', helpdesk())
    const dims = dimensions([{ id: 'helpdesk', name: 'Helpdesk', served: 'builtin', manifest: 'helpdesk.silo.json', slotsOff: ['pulse'] }], dir)
    const { installer, registry, operator } = setup(dims)
    const [o] = installer.installBuiltins()
    // nobody holds its files yet: nobody is bound (a role is never an agent id)
    expect(o!.says).toBe('Silos installed Helpdesk 0.2.0 — comes with Silos · producers: none bound yet · slots: rail, needs-you, agent-section · off: pulse')
    expect(operator.get('helpdesk')!.slotsOff).toEqual(['pulse'])
    expect(registry.get('helpdesk')!.status.slots).toMatchObject({ granted: ['rail', 'needs-you', 'agent-section'], off: ['pulse'] })
    // the operator turns it on like any slot — no code, no manifest edit
    expect(installer.operatorPatch('helpdesk', { slotsOff: [] }).code).toBe(200)
    expect(registry.get('helpdesk')!.status.slots.granted).toContain('pulse')
  })
  it('the next boot keeps it as it is — no second install, no second event', () => {
    const { installer, events } = setup(fixtureDims())
    installer.installBuiltins()
    expect(installer.installBuiltins()).toEqual([{ id: 'helpdesk', outcome: 'kept', says: 'Helpdesk is approved — left as it is' }])
    expect(events.list('helpdesk')).toHaveLength(1)
  })
  it('uninstallable — and the uninstall is respected at every later boot; the door back keeps the provenance', () => {
    const dims = fixtureDims()
    const first = setup(dims)
    first.installer.installBuiltins()
    expect(first.installer.uninstall('helpdesk').code).toBe(200)
    // a fresh boot over the same data dir
    const { installer, registry, operator } = setup(dims)
    expect(installer.installBuiltins()).toEqual([{ id: 'helpdesk', outcome: 'kept', says: 'Helpdesk was uninstalled by the owner — left out' }])
    expect(registry.get('helpdesk')).toBeNull()
    const row = installer.uninstalled().find((u) => u.id === 'helpdesk')!
    expect(row).toMatchObject({ provenance: 'builtin', native: null, manifest: { version: '0.2.0' } })
    // the owner's door back is the normal one
    expect(installer.resubmit('helpdesk').code).toBe(201)
    expect(installer.approve('helpdesk', {}).code).toBe(400) // nobody holds its files: the owner binds someone
    expect(installer.approve('helpdesk', { producers: ['support'] }).code).toBe(200)
    expect(registry.get('helpdesk')!.status.state).toBe('active')
    expect(operator.get('helpdesk')).toMatchObject({ decision: 'approved', provenance: 'builtin' })
  })
  it('turned off by the owner stays off at the next boot', () => {
    const { installer, registry } = setup(fixtureDims())
    installer.installBuiltins()
    expect(installer.operatorPatch('helpdesk', { disabled: true }).code).toBe(200)
    expect(installer.installBuiltins()[0]).toMatchObject({ outcome: 'kept', says: 'Helpdesk is disabled — left as it is' })
    expect(registry.get('helpdesk')!.status.state).toBe('disabled')
  })
  it('a builtin manifest that does not validate installs nothing and says why, as an event', () => {
    const { installer, registry, events } = setup(
      fixtureDims(
        helpdesk((m) => {
          m.spec.sources[0].parser = 'yaml'
        }),
      ),
    )
    const [o] = installer.installBuiltins()
    expect(o).toMatchObject({ id: 'helpdesk', outcome: 'failed' })
    expect(registry.get('helpdesk')).toBeNull()
    expect(events.list('helpdesk')).toEqual([
      expect.objectContaining({
        verb: 'builtin-failed',
        by: 'Silos',
        text: expect.stringContaining('Silos could not install Helpdesk 0.2.0 — its manifest does not validate'),
      }),
    ])
  })
  it('a builtin whose manifest is missing is said (once), nothing installed', () => {
    const dims = dimensions([{ id: 'helpdesk', name: 'Helpdesk', served: 'builtin', manifest: 'helpdesk.silo.json' }], join(base, 'nowhere'))
    const { installer, registry, events } = setup(dims)
    expect(installer.installBuiltins()).toEqual([{ id: 'helpdesk', outcome: 'failed', says: 'its manifest helpdesk.silo.json is not in this Silos' }])
    expect(registry.get('helpdesk')).toBeNull()
    expect(events.list('helpdesk')[0]).toMatchObject({
      verb: 'builtin-failed',
      text: 'Silos could not install Helpdesk: its manifest helpdesk.silo.json is not in this Silos',
    })
  })
  it('a fresh house boot installs exactly the recommended silos — an optional one waits in the catalog', () => {
    const { installer, registry } = setup()
    expect(installer.installBuiltins().map((o) => [o.id, o.outcome])).toEqual([
      ['plans', 'installed'],
      ['task-mode', 'installed'],
      ['system', 'installed'],
    ])
    expect(registry.get('support')).toBeNull()
    expect(registry.get('executions')).toBeNull()
  })
  it('an install that holds Support from when it came with Silos keeps it as it is — the boot never touches an id it does not ship as recommended', () => {
    put('agent-state/support/support/cases/c2.json', kase('c2'))
    const { installer, operator, registry } = setup()
    expect(installer.submit({ manifest: ref('support') }, 'owner').code).toBe(201)
    expect(installer.approve('support', { producers: ['support'] }).code).toBe(200)
    operator.patch('support', { provenance: 'builtin' } as Json)
    const before = JSON.stringify(operator.get('support'))
    expect(installer.installBuiltins().find((o) => o.id === 'support')).toBeUndefined()
    expect(JSON.stringify(operator.get('support'))).toBe(before)
    expect(registry.get('support')!.status.state).toBe('active')
  })

  // the plans kernelectomy: Plans comes with Silos, its pulse off —
  // the owner's tasks are said by Needs you and Yours to do
  it('the house boot installs Plans — comes with Silos, its pulse off', () => {
    const { installer, operator, registry } = setup()
    expect(installer.installBuiltins().find((o) => o.id === 'plans')).toMatchObject({
      id: 'plans',
      outcome: 'installed',
      says: expect.stringMatching(/^Silos installed Plans 0\.8\.2 — comes with Silos · .*off: pulse$/),
    })
    expect(operator.get('plans')).toMatchObject({ decision: 'approved', provenance: 'builtin', slotsOff: ['pulse'] })
    expect(registry.get('plans')!.status).toMatchObject({ state: 'active', slots: { off: ['pulse'] } })
  })

  // the System silo: the processes conversations left — a kernel
  // source, nobody bound, its pulse born off (Home's sentence stays as it was)
  it('the house boot installs System — comes with Silos, a kernel source, its pulse off', () => {
    const { installer, operator, registry } = setup()
    expect(installer.installBuiltins().find((o) => o.id === 'system')).toMatchObject({
      id: 'system',
      outcome: 'installed',
      says: expect.stringMatching(/^Silos installed System \d+\.\d+\.\d+ — comes with Silos · .*off: pulse$/),
    })
    expect(operator.get('system')).toMatchObject({ decision: 'approved', provenance: 'builtin', slotsOff: ['pulse'] })
    expect(registry.get('system')!.status).toMatchObject({ state: 'active', slots: { off: ['pulse'] } })
  })

  // Plans once installed from Available (while native) counted the owner's
  // tasks twice; that copy was uninstalled. That uninstall was the cure for
  // the double count — no decision about the built-in: the flip installs it,
  // and says so. An uninstall of the BUILTIN stays respected (provenance).
  it("a copy uninstalled while the dimension ran natively does not keep the built-in out; the builtin's own uninstall does", () => {
    // the real leftover: registry/plans holds a status.json and NO
    // silo.json; the convention's journal holds what that copy observed
    put('data/silos/registry/plans/status.json', { state: 'active', reason: 'active', manifest: { version: '0.1.0', name: 'Plans' } })
    const old = '{"at":"2026-11-02T14:52:19.280Z","event":"opened","silo":"plans","reason":"first reading"}\n'
    put('data/silos/conventions/project%3Aplans/journal.jsonl', old)
    const { installer, operator, registry, events } = setup()
    operator.set('plans', {
      decision: 'uninstalled',
      producers: [],
      slotsOff: [],
      name: 'Plans',
      decidedAt: '2026-11-02T16:48:30.942Z',
      uninstalledAt: '2026-11-02T16:48:30.942Z',
      conventions: [],
    })
    const out = installer.installBuiltins().find((o) => o.id === 'plans')!
    expect(readFileSync(join(base, 'data/silos/registry/plans/silo.json'), 'utf8')).toContain('"version": "0.8.2"')
    expect(readFileSync(join(base, 'data/silos/conventions/project%3Aplans/journal.jsonl'), 'utf8').startsWith(old)).toBe(true)
    expect(out).toMatchObject({
      outcome: 'installed',
      says: expect.stringContaining('the copy uninstalled on 2026-11-02, while Plans ran natively, was not a choice against it'),
    })
    expect(operator.get('plans')).toMatchObject({ decision: 'approved', provenance: 'builtin' })
    expect(registry.get('plans')!.status.state).toBe('active')
    expect(events.list('plans').map((e) => e.verb)).toEqual(['installed'])
    // the owner uninstalls the builtin: respected at every later boot
    expect(installer.uninstall('plans').code).toBe(200)
    expect(operator.get('plans')).toMatchObject({ decision: 'uninstalled', provenance: 'builtin' })
    expect(installer.installBuiltins().find((o) => o.id === 'plans')).toEqual({
      id: 'plans',
      outcome: 'kept',
      says: 'Plans was uninstalled by the owner — left out',
    })
    expect(registry.get('plans')?.status.state).not.toBe('active')
  })
  // review (defect 7): approve with no slotsOff set [] — a reinstall
  // turned support's born-off pulse back on
  it('reinstalling a builtin starts from its declared born-off slots; the dialog shows them as starting off', () => {
    const dir = join(base, 'reference')
    put('reference/helpdesk.silo.json', helpdesk())
    const dims = dimensions([{ id: 'helpdesk', name: 'Helpdesk', served: 'builtin', manifest: 'helpdesk.silo.json', slotsOff: ['pulse'] }], dir)
    const { installer, registry, operator } = setup(dims)
    installer.installBuiltins()
    expect(installer.uninstall('helpdesk').code).toBe(200)
    expect(installer.resubmit('helpdesk').code).toBe(201)
    const c = installer.consequences('helpdesk') as Json
    expect(c.derived.slots.find((s: Json) => s.slot === 'pulse')).toMatchObject({ off: true })
    expect(c.derived.slots.find((s: Json) => s.slot === 'rail')).toMatchObject({ off: false })
    expect(installer.approve('helpdesk', { producers: ['support'] }).code).toBe(200) // what an old dialog sent: no slotsOff
    expect(operator.get('helpdesk')!.slotsOff).toEqual(['pulse'])
    expect(registry.get('helpdesk')!.status.slots.off).toEqual(['pulse'])
    expect(registry.get('helpdesk')!.status.slots.granted).not.toContain('pulse')
  })
  it('an explicit slotsOff on the approval wins over the default (the owner turns the pulse on in the dialog)', () => {
    const dir = join(base, 'reference')
    put('reference/helpdesk.silo.json', helpdesk())
    const dims = dimensions([{ id: 'helpdesk', name: 'Helpdesk', served: 'builtin', manifest: 'helpdesk.silo.json', slotsOff: ['pulse'] }], dir)
    const { installer, operator } = setup(dims)
    installer.installBuiltins()
    installer.uninstall('helpdesk')
    installer.resubmit('helpdesk')
    expect(installer.approve('helpdesk', { producers: ['support'], slotsOff: [] }).code).toBe(200)
    expect(operator.get('helpdesk')!.slotsOff).toEqual([])
  })
  it("an update approved with no slotsOff keeps the owner's switches and audience vetoes (any silo)", () => {
    put('agent-state/finance/silos/invoices/x.json', {})
    const { installer, operator } = setup()
    expect(installer.submit({ manifest: ref('invoices') }, 'owner').code).toBe(201)
    expect(installer.approve('invoices', { producers: ['finance'], slotsOff: ['pulse'] }).code).toBe(200)
    operator.patch('invoices', { audienceOff: [0] })
    const next = ref('invoices')
    next.metadata.version = '9.0.0'
    expect(installer.submit({ manifest: next }, 'owner').code).toBe(201)
    expect((installer.consequences('invoices') as Json).derived.slots.find((s: Json) => s.slot === 'pulse')).toMatchObject({ off: true })
    expect(installer.approve('invoices', { producers: ['finance'] })).toMatchObject({ code: 200, body: { kind: 'updated' } })
    expect(operator.get('invoices')).toMatchObject({ slotsOff: ['pulse'], audienceOff: [0] })
  })

  // review (defect 6): a shipped builtin's newer manifest never
  // reached an installed builtin
  it('a newer shipped manifest updates an installed builtin at boot — journaled, every owner decision kept; never a downgrade', () => {
    const dir = join(base, 'reference')
    put('reference/helpdesk.silo.json', helpdesk())
    const dims = dimensions([{ id: 'helpdesk', name: 'Helpdesk', served: 'builtin', manifest: 'helpdesk.silo.json', slotsOff: ['pulse'] }], dir)
    const first = setup(dims)
    first.installer.installBuiltins()
    // the owner's decisions after the install
    first.installer.operatorPatch('helpdesk', { producers: ['writer'], slotsOff: ['pulse', 'rail'], audienceOff: [1] })
    first.installer.operatorPatch('helpdesk', { disabled: true })
    // Silos ships 0.3.0
    put(
      'reference/helpdesk.silo.json',
      helpdesk((m) => {
        m.metadata.version = '0.3.0'
      }),
    )
    const { installer, registry, operator, events } = setup(dims)
    const [o] = installer.installBuiltins()
    expect(o).toMatchObject({
      id: 'helpdesk',
      outcome: 'updated',
      says: expect.stringContaining(
        'Silos updated Helpdesk 0.2.0 → 0.3.0 — comes with Silos · your choices kept (off · producers: writer · slots off: pulse, rail)',
      ),
    })
    expect(registry.get('helpdesk')!.status.manifest.version).toBe('0.3.0')
    expect(registry.get('helpdesk')!.status.state).toBe('disabled')
    expect(operator.get('helpdesk')).toMatchObject({
      decision: 'disabled',
      provenance: 'builtin',
      producers: ['writer'],
      slotsOff: ['pulse', 'rail'],
      audienceOff: [1],
    })
    expect(events.list('helpdesk').at(-1)).toMatchObject({ verb: 'updated', by: 'Silos' })
    // the same version again: kept, no second event
    expect(installer.installBuiltins()[0]).toMatchObject({ outcome: 'kept' })
    expect(events.list('helpdesk').filter((e) => e.verb === 'updated')).toHaveLength(1)
    // an OLDER shipped manifest never downgrades
    put(
      'reference/helpdesk.silo.json',
      helpdesk((m) => {
        m.metadata.version = '0.2.5'
      }),
    )
    expect(installer.installBuiltins()[0]).toMatchObject({ outcome: 'kept' })
    expect(registry.get('helpdesk')!.status.manifest.version).toBe('0.3.0')
  })
  it('an uninstalled builtin is never updated (nor brought back) by a newer shipped manifest', () => {
    const dir = join(base, 'reference')
    put('reference/helpdesk.silo.json', helpdesk())
    const dims = dimensions([{ id: 'helpdesk', name: 'Helpdesk', served: 'builtin', manifest: 'helpdesk.silo.json' }], dir)
    const first = setup(dims)
    first.installer.installBuiltins()
    first.installer.uninstall('helpdesk')
    put(
      'reference/helpdesk.silo.json',
      helpdesk((m) => {
        m.metadata.version = '0.3.0'
      }),
    )
    const { installer, registry } = setup(dims)
    expect(installer.installBuiltins()).toEqual([{ id: 'helpdesk', outcome: 'kept', says: 'Helpdesk was uninstalled by the owner — left out' }])
    expect(registry.get('helpdesk')).toBeNull()
  })
  it('a newer shipped manifest that does not validate leaves the running version and says why', () => {
    const dir = join(base, 'reference')
    put('reference/helpdesk.silo.json', helpdesk())
    const dims = dimensions([{ id: 'helpdesk', name: 'Helpdesk', served: 'builtin', manifest: 'helpdesk.silo.json' }], dir)
    setup(dims).installer.installBuiltins()
    put(
      'reference/helpdesk.silo.json',
      helpdesk((m) => {
        m.metadata.version = '0.3.0'
        m.spec.sources[0].parser = 'yaml'
      }),
    )
    const { installer, registry, events } = setup(dims)
    expect(installer.installBuiltins()[0]).toMatchObject({ outcome: 'failed' })
    expect(registry.get('helpdesk')!.status.manifest.version).toBe('0.2.0')
    expect(events.list('helpdesk').at(-1)!.text).toContain('Silos could not update Helpdesk 0.2.0 → 0.3.0')
  })
  // review (second round): approving an UPDATE of a silo the owner had
  // turned off turned it back on silently, while the boot path kept it off.
  // One rule for both update paths: an update keeps the owner's on/off.
  it("an update keeps the owner's off — the dialog path and the boot path agree, and the dialog says so", () => {
    put('agent-state/finance/silos/invoices/x.json', {})
    const { installer, operator, registry } = setup()
    expect(installer.submit({ manifest: ref('invoices') }, 'owner').code).toBe(201)
    expect(installer.approve('invoices', { producers: ['finance'] }).code).toBe(200)
    expect(installer.operatorPatch('invoices', { disabled: true }).code).toBe(200)
    const next = ref('invoices')
    next.metadata.version = '9.0.0'
    expect(installer.submit({ manifest: next }, 'owner').code).toBe(201)
    const c = installer.consequences('invoices') as Json
    expect(c.derived.update).toMatchObject({ off: true, says: 'stays off — turn it on from its page' })
    expect(installer.approve('invoices', { producers: ['finance'] })).toMatchObject({ code: 200, body: { kind: 'updated' } })
    expect(operator.get('invoices')!.decision).toBe('disabled')
    expect(registry.get('invoices')!.status.state).toBe('disabled')
    expect(registry.get('invoices')!.status.manifest.version).toBe('9.0.0')

    // the boot path, over a builtin turned off: the same outcome
    const dir = join(base, 'reference')
    put('reference/helpdesk.silo.json', helpdesk())
    const dims = dimensions([{ id: 'helpdesk', name: 'Helpdesk', served: 'builtin', manifest: 'helpdesk.silo.json' }], dir)
    const boot = setup(dims)
    boot.installer.installBuiltins()
    boot.installer.operatorPatch('helpdesk', { disabled: true })
    put(
      'reference/helpdesk.silo.json',
      helpdesk((m) => {
        m.metadata.version = '0.3.0'
      }),
    )
    expect(boot.installer.installBuiltins()[0]).toMatchObject({ outcome: 'updated' })
    expect(boot.operator.get('helpdesk')!.decision).toBe('disabled')
  })
  it('an update of a silo that is on stays on, and the dialog has nothing to say about it', () => {
    put('agent-state/finance/silos/invoices/x.json', {})
    const { installer, operator } = setup()
    installer.submit({ manifest: ref('invoices') }, 'owner')
    installer.approve('invoices', { producers: ['finance'] })
    const next = ref('invoices')
    next.metadata.version = '9.0.0'
    installer.submit({ manifest: next }, 'owner')
    expect((installer.consequences('invoices') as Json).derived.update).toMatchObject({ off: false })
    expect((installer.consequences('invoices') as Json).derived.update.says).toBeUndefined()
    installer.approve('invoices', { producers: ['finance'] })
    expect(operator.get('invoices')!.decision).toBe('approved')
  })

  // tsx restarts often: a shipped builtin that fails validation was journaled
  // as builtin-failed on EVERY boot. Once per (silo, shipped version).
  it('a failing shipped builtin is journaled once per shipped version, however many boots', () => {
    const dims = fixtureDims(
      helpdesk((m) => {
        m.spec.sources[0].parser = 'yaml'
      }),
    )
    for (let i = 0; i < 3; i++) expect(setup(dims).installer.installBuiltins()[0]).toMatchObject({ outcome: 'failed' })
    const { events } = setup(dims)
    expect(events.list('helpdesk').filter((e) => e.verb === 'builtin-failed')).toHaveLength(1)
    // a NEW shipped version that still fails is a new fact: said once more
    const dims2 = fixtureDims(
      helpdesk((m) => {
        m.metadata.version = '0.2.1'
        m.spec.sources[0].parser = 'yaml'
      }),
    )
    setup(dims2).installer.installBuiltins()
    setup(dims2).installer.installBuiltins()
    expect(events.list('helpdesk').filter((e) => e.verb === 'builtin-failed')).toHaveLength(2)
  })
  it('a failing shipped UPDATE is journaled once per shipped version, and a missing manifest once', () => {
    const dir = join(base, 'reference')
    put('reference/helpdesk.silo.json', helpdesk())
    const dims = dimensions([{ id: 'helpdesk', name: 'Helpdesk', served: 'builtin', manifest: 'helpdesk.silo.json' }], dir)
    setup(dims).installer.installBuiltins()
    put(
      'reference/helpdesk.silo.json',
      helpdesk((m) => {
        m.metadata.version = '0.3.0'
        m.spec.sources[0].parser = 'yaml'
      }),
    )
    for (let i = 0; i < 3; i++) expect(setup(dims).installer.installBuiltins()[0]).toMatchObject({ outcome: 'failed' })
    expect(
      setup(dims)
        .events.list('helpdesk')
        .filter((e) => e.verb === 'builtin-failed'),
    ).toHaveLength(1)

    const gone = dimensions([{ id: 'ghost', name: 'Ghost', served: 'builtin', manifest: 'ghost.silo.json' }], join(base, 'nowhere'))
    for (let i = 0; i < 3; i++) setup(gone).installer.installBuiltins()
    expect(
      setup(gone)
        .events.list('ghost')
        .filter((e) => e.verb === 'builtin-failed'),
    ).toHaveLength(1)
  })

  it('compareVersions orders a.b.c by number and refuses what it cannot order', () => {
    expect(compareVersions('0.10.0', '0.9.9')).toBe(1)
    expect(compareVersions('0.2.0', '0.2.0')).toBe(0)
    expect(compareVersions('0.2.0-rc1', '0.2.0')).toBe(-1)
    expect(compareVersions('1.0', '1.0.0')).toBe(0)
    expect(compareVersions('next', '0.1.0')).toBeNull()
  })

  it('operator.json keeps provenance only as the word builtin', () => {
    const root = join(base, 'op')
    put('op/operator.json', { silos: { a: { decision: 'approved', provenance: 'builtin' }, b: { decision: 'approved', provenance: 'forged' } } })
    const op = new SiloOperatorStore(root)
    expect(op.get('a')!.provenance).toBe('builtin')
    expect(op.get('b')!.provenance).toBeUndefined()
  })
})

// (E6, B1/N6): a silo installed THROUGH THE DOOR that now comes with
// Silos is ADOPTED — provenance builtin, every choice the owner made kept —
// never re-installed over the owner's word. Task mode is the case (its
// reference manifest, shipped one version up in a fixture reference dir).
describe('adoption — a door install that now comes with Silos', () => {
  const NEXT = '9.0.1'
  function taskModeDims(version = NEXT): Dimensions {
    put(
      'reference/task-mode.silo.json',
      (() => {
        const m = ref('task-mode')
        m.metadata.version = version
        return m
      })(),
    )
    return dimensions([{ id: 'task-mode', name: 'Task mode', served: 'builtin', manifest: 'task-mode.silo.json' }], join(base, 'reference'))
  }
  function doorInstall(dims: Dimensions) {
    const w = setup(dims)
    expect(w.installer.submit({ manifest: ref('task-mode') }, 'owner').code).toBe(201)
    expect(w.installer.approve('task-mode', { producers: AGENTS }).code).toBe(200)
    expect(w.operator.get('task-mode')!.provenance).toBeUndefined()
    return w
  }

  it('approved through the door: adopted and updated in the same pass — builtin, the same producers and choices', () => {
    const dims = taskModeDims()
    const from = String(ref('task-mode').metadata.version)
    const first = doorInstall(dims)
    first.operator.patch('task-mode', { slotsOff: ['rail'], audienceOff: [0] })
    const { installer, operator, registry, events } = setup(dims)
    const out = installer.installBuiltins().filter((o) => o.id === 'task-mode')
    expect(out.map((o) => o.outcome)).toEqual(['adopted', 'updated'])
    expect(out[0]!.says).toBe(`Task mode now comes with Silos — your choices kept (on · producers: ${AGENTS.join(', ')})`)
    expect(out[1]!.says).toContain(`Silos updated Task mode ${from} → ${NEXT}`)
    expect(operator.get('task-mode')).toMatchObject({ decision: 'approved', provenance: 'builtin', producers: AGENTS, slotsOff: ['rail'], audienceOff: [0] })
    expect(registry.get('task-mode')!.status).toMatchObject({ state: 'active', manifest: { version: NEXT } })
    expect(events.list('task-mode').map((e) => e.verb)).toContain('adopted')
    // the next boot: nothing more to do
    expect(
      installer
        .installBuiltins()
        .filter((o) => o.id === 'task-mode')
        .map((o) => o.outcome),
    ).toEqual(['kept'])
  })

  it('uninstalled through the door stays uninstalled forever — adopted, never re-installed; its row offers Reinstall', () => {
    const dims = taskModeDims()
    const first = doorInstall(dims)
    expect(first.installer.uninstall('task-mode').code).toBe(200)
    const { installer, operator, registry } = setup(dims)
    const out = installer.installBuiltins().filter((o) => o.id === 'task-mode')
    expect(out.map((o) => o.outcome)).toEqual(['adopted', 'kept'])
    expect(out[1]!.says).toBe('Task mode was uninstalled by the owner — left out')
    expect(registry.get('task-mode')).toBeNull()
    expect(operator.get('task-mode')).toMatchObject({ decision: 'uninstalled', provenance: 'builtin' })
    expect(installer.uninstalled().find((u) => u.id === 'task-mode')).toMatchObject({
      provenance: 'builtin',
      native: null,
      manifest: expect.objectContaining({ version: expect.any(String) }),
    })
    // and at every later boot
    expect(
      setup(dims)
        .installer.installBuiltins()
        .filter((o) => o.id === 'task-mode')
        .map((o) => o.outcome),
    ).toEqual(['kept'])
  })

  it('turned off through the door stays off (adopted, the shipped manifest applied, off kept)', () => {
    const dims = taskModeDims()
    const first = doorInstall(dims)
    expect(first.installer.operatorPatch('task-mode', { disabled: true }).code).toBe(200)
    const { installer, operator, registry } = setup(dims)
    expect(
      installer
        .installBuiltins()
        .filter((o) => o.id === 'task-mode')
        .map((o) => o.outcome),
    ).toEqual(['adopted', 'updated'])
    expect(operator.get('task-mode')).toMatchObject({ decision: 'disabled', provenance: 'builtin', producers: AGENTS })
    expect(registry.get('task-mode')!.status.state).toBe('disabled')
  })

  it('a fork (a registered version newer than the shipped one) is never adopted', () => {
    const dims = taskModeDims('0.0.1')
    doorInstall(dims)
    const { installer, operator } = setup(dims)
    expect(
      installer
        .installBuiltins()
        .filter((o) => o.id === 'task-mode')
        .map((o) => o.outcome),
    ).toEqual(['kept'])
    expect(operator.get('task-mode')!.provenance).toBeUndefined()
  })
})

describe('a silo that brings only a look (spec.theme)', () => {
  it('installs from the catalog: the dialog says the look and its colours; approved, the descriptor carries it; an update that recolours it says so; off, it is not offered', () => {
    const { installer, registry } = setup()
    expect(availableSilos({ heldIds: () => new Set() }).map((x) => x.id)).toContain('heather')
    const m = availableManifest({ heldIds: () => new Set() }, 'heather')!
    expect(installer.submit({ manifest: m }, 'owner').code).toBe(201)
    const c = installer.consequences('heather') as Json
    expect(c.derived.errors).toEqual([])
    expect(c.derived.look).toMatchObject({
      name: 'Heather',
      change: null,
      light: { background: '#f7f5f8', accent: '#8a2f6e', 'accent-soft': '#f1e2ec' },
      dark: { accent: '#e59ac9', 'accent-soft': 'rgba(229, 154, 201, 0.12)' },
    })
    expect(c.derived.look.says).toContain('Heather')
    expect(c.derived.reads).toEqual([])
    // pending: nothing offered yet
    expect(registry.describe().find((d) => d.id === 'heather')?.theme ?? null).toBeNull()
    expect(installer.approve('heather', {}).code).toBe(200)
    const d = registry.describe().find((x) => x.id === 'heather')!
    expect(d.state).toBe('active')
    expect(d.theme).toMatchObject({ name: 'Heather', light: { text: '#221a29' }, dark: { 'on-accent': '#2a0f22' } })
    // an update that recolours the look says it, in the update's lines
    const next = ref('heather')
    next.metadata.version = '0.2.0'
    next.spec.theme.dark.accent = '#f0a8d4'
    expect(installer.submit({ manifest: next }, 'owner').code).toBe(201)
    const u = installer.consequences('heather') as Json
    expect(u.derived.update.lines).toContain('its look Heather changes its colours — a browser using it takes the new ones')
    expect(u.derived.look.change).toBe('its look Heather changes its colours — a browser using it takes the new ones')
    // turned off, the look is no longer offered
    expect(installer.operatorPatch('heather', { disabled: true }).code).toBe(200)
    expect(registry.describe().find((x) => x.id === 'heather')!.theme).toBeNull()
  })
})
