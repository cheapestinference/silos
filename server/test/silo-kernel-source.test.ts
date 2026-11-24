// silo-kernel-source.test.ts — a silo that reads NOBODY's files (Silo
// Standard step 2): `source.root: kernel` presenting a kernel kind against
// the published catalog, at every layer — schema, the validator's
// kernel-source checks, the reader, the installer's derived consequences, the
// surfaces (pulse, Needs you — audience included, nothing special-cased), the
// record pages, uninstall. The manifest is the shipped System silo narrowed
// to its one `process` source, plus a Needs you entry; the records come from
// a fake kernel source — no process table, no network.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SiloRegistry } from '../src/silos/registry.js'
import { SiloReader } from '../src/silos/reader.js'
import { SiloKernel } from '../src/silos/kernel.js'
import { TransitionJournal } from '../src/silos/journal.js'
import { SiloOperatorStore } from '../src/silos/operator.js'
import { SiloInstaller } from '../src/silos/installer.js'
import { SiloAcks, SiloEvents } from '../src/silos/actions.js'
import { SiloSurfaces } from '../src/silos/surfaces.js'
import { recordDetail, recordsPage } from '../src/silos/views.js'
import { readManifest } from '../src/silos/manifest.js'
import { validateSilo, type ValidatorContext } from '../src/silos/validator.js'
import { KERNEL_KINDS, KERNEL_KINDS_VERSION, type KernelRecord, type KernelRecordSource } from '../src/silos/kernel-kinds.js'
import type { SiloLocations } from '../src/silos/files-source.js'
import { siloManifest } from './helpers/silo-manifests.js'

type Json = Record<string, any>
const SILO = 'machine'
// System narrowed to one kernel source (process), with a Needs you entry
const ref = (): Json => {
  const m = siloManifest('system') as Json
  m.metadata = { ...m.metadata, id: SILO, name: 'Machine' }
  m.spec.sources = m.spec.sources.filter((s: Json) => s.kind === 'process')
  m.spec.kinds = { process: m.spec.kinds.process }
  m.spec.views = m.spec.views.filter((v: Json) => v.kind === 'process')
  m.spec.surfaces['needs-you'] = [{ when: 'state = left', urgency: 'routine', clears: 'state = exited', actions: ['open', 'ack'] }]
  m.spec.actions = m.spec.actions.filter((a: Json) => a.kind === undefined || a.kind === 'process')
  return m
}
const NOW = Date.parse('2026-11-21T12:00:00Z')
const errorsOf = (m: unknown, ctx: ValidatorContext = {}): Array<[number, string, string]> =>
  validateSilo(m, { now: NOW, ...ctx }).errors.map((e) => [e.check, e.where, e.message])
const docs = (): Json => siloManifest('documents') as Json

// what the kernel holds of `process`, set by hand
class FakeProcesses implements KernelRecordSource {
  private held = new Map<string, KernelRecord>()
  private last: number | null = null
  set(value: Json, at: number): void {
    this.held.set(value.id, { id: value.id, value, writtenAt: at })
    this.last = at
  }
  records(): KernelRecord[] {
    return [...this.held.values()]
  }
  lastWrite(): number | null {
    return this.last
  }
}
const proc = (over: Json = {}): Json => ({
  id: '4821-77',
  command: 'npm run dev',
  startedAt: '2026-11-21T08:00:00.000Z',
  origin: 'conversation',
  pid: 4821,
  conversation: 'Checkout',
  why: 'its conversation is not running',
  stoppable: true,
  state: 'left',
  updatedBy: 'kernel',
  ...over,
})

let base: string
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'silo-kernel-source-'))
})
afterEach(() => rmSync(base, { recursive: true, force: true }))

describe('the schema and the manifest: kernel is a root, the convention is kernel:<kind>', () => {
  it('the manifest reads, with its convention derived — never declared', () => {
    const r = readManifest(ref())
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.wants).toEqual([])
    expect(r.conventions).toEqual([{ source: 'processes', root: 'kernel', glob: '', convention: 'kernel:process', dir: 'kernel%3Aprocess' }])
  })
  it('a kernel kind this kernel does not publish is an error, not a want', () => {
    const m = ref()
    m.spec.sources[0].kind = 'subscription'
    const r = readManifest(m)
    expect(r.ok).toBe(false)
    if (!r.ok)
      expect(r.reason).toBe(
        `source processes: this Silos publishes no kernel kind "subscription" (${KERNEL_KINDS_VERSION}: ${Object.keys(KERNEL_KINDS).join(', ')})`,
      )
  })
  it('a kernel source carries no glob; a files source names no kernel kind — one line each', () => {
    const m = ref()
    m.spec.sources[0].glob = 'silos/x/*.json'
    m.spec.sources[0].parser = 'json'
    expect(errorsOf(m)).toEqual([[1, 'spec.sources[0]', 'spec.sources[0] carries glob, parser, which a kernel source does not take — it reads no files']])
    const f = docs()
    f.spec.sources[0].kind = 'process'
    expect(errorsOf(f)).toEqual([[1, 'spec.sources[0]', 'spec.sources[0] carries kind, which only a kernel source names (a files source reads globs)']])
  })
  it('type and root say the same thing on a kernel source', () => {
    const m = ref()
    m.spec.sources[0].type = 'files'
    expect(errorsOf(m)).toEqual([[1, 'spec.sources[0].type', 'spec.sources[0].type must be "kernel" (found "files")']])
  })
})

describe('the validator over a kernel source: the checks, plus what kernel data asks', () => {
  it('the manifest validates', () => {
    const r = validateSilo(ref(), { now: NOW })
    expect(r.errors).toEqual([])
    expect(r.ok).toBe(true)
    expect(r.preview!.from).toBe('examples')
  })
  it('3 — the kind must be published; the producer is the kernel; a kernel source stands alone', () => {
    const a = ref()
    a.spec.sources[0].kind = 'subscription'
    expect(errorsOf(a)[0]).toEqual([
      3,
      'spec.sources[0].kind',
      `source processes: this Silos publishes no kernel kind "subscription" (${KERNEL_KINDS_VERSION}: ${Object.keys(KERNEL_KINDS).join(', ')})`,
    ])
    const b = ref()
    b.spec.producer = { role: 'finance' }
    expect(errorsOf(b)).toEqual([
      [3, 'spec.producer.role', 'the records of a kernel source are written by the kernel — its producer role is kernel (found "finance")'],
    ])
    const c = ref()
    c.spec.producer = { role: 'kernel', instructions: { summary: 'x' } }
    expect(errorsOf(c)).toEqual([[3, 'spec.producer', 'a kernel source has no agent to instruct and no sync — the kernel produces its records']])
    const d = ref()
    d.spec.sources.push({ id: 'others', type: 'files', root: 'agent-state', glob: 'silos/x/*.json', parser: 'json' })
    expect(errorsOf(d).map((e) => e[2])).toContain('a kernel source stands alone — kernel data and files never feed the same kind')
    const e = docs()
    e.spec.producer = { role: 'kernel' }
    expect(errorsOf(e)).toEqual([[3, 'spec.producer.role', 'kernel is the producer of kernel sources only — files are written by agents']])
  })
  it("5 — the platform anchor is kernel data's only; the kind matches the published kind", () => {
    const a = ref()
    a.spec.kinds.process.envelope.anchors = [{ hub: 'agent', from: 'location' }]
    expect(errorsOf(a)).toEqual([[5, 'spec.kinds.process.envelope.anchors[0]', 'a kind read from kernel cannot anchor to an agent from its location']])
    const f = docs()
    f.spec.kinds.document.envelope.anchors = [{ hub: 'platform', from: 'location' }]
    expect(errorsOf(f)).toEqual([
      [5, 'spec.kinds.document.envelope.anchors[0]', 'only kernel data anchors to the platform — records in files belong to an agent or a folder'],
    ])
    const s = ref()
    s.spec.kinds.process.states = s.spec.kinds.process.states.filter((x: Json) => x.value !== 'left')
    s.spec.kinds.process.examples = s.spec.kinds.process.examples.filter((x: Json) => x.state !== 'left')
    s.spec.views[0].first = undefined
    s.spec.surfaces.pulse.when = 'state = running'
    s.spec.surfaces['needs-you'][0].when = 'state = running'
    expect(errorsOf(s)).toEqual([[5, 'spec.kinds.process.states', 'the kernel kind process has the states running, left, exited — the manifest misses left']])
    const t = ref()
    t.spec.kinds.process.fields.pid.type = 'string'
    expect(errorsOf(t)[0]).toEqual([5, 'spec.kinds.process.fields.pid', 'pid is a number in the kernel kind process, not a string'])
    const u = ref()
    u.spec.kinds.process.fields.budget = { type: 'money' }
    expect(errorsOf(u)[0]![0]).toBe(5)
    expect(errorsOf(u)[0]![2]).toMatch(/^budget is not a field of the kernel kind process \(command, startedAt, origin, /)
    const v = ref()
    v.spec.kinds.process.states[2].terminal = false
    v.spec.kinds.process.states[1].terminal = true
    expect(errorsOf(v)).toEqual([
      [5, 'spec.kinds.process.states', 'left is not terminal in the kernel kind process'],
      [5, 'spec.kinds.process.states', 'exited is terminal in the kernel kind process'],
    ])
    const w = ref()
    w.spec.kinds.process.envelope.id = { from: 'filename' }
    expect(errorsOf(w)[0]).toEqual([5, 'spec.kinds.process.envelope.id', "a kernel record has no file to take its id from — its id is the kernel's"])
  })
  it('6 — over kernel data a silo only looks, says seen and names the kernel-verbs its kind admits', () => {
    const KV =
      "does not act on kernel data — a silo over a kernel source may only open, ack and declare the kernel-verbs its kind admits (the kernel's own mutations)"
    const a = ref()
    a.spec.surfaces['needs-you'][0].actions = ['open', 'set-field']
    expect(errorsOf(a)).toEqual([[6, 'spec.surfaces.needs-you[0].actions[1]', `set-field ${KV}`]])
    const b = ref()
    b.spec.actions.push({ verb: 'message-agent', kind: 'process', to: 'producer' })
    expect(errorsOf(b)[0]![0]).toBe(6)
    const at = ref().spec.actions.length
    // a kernel-verb names a verb of the closed catalog — one this kind admits
    const c = ref()
    c.spec.actions.push({ verb: 'kernel-verb', name: 'restart-process', kind: 'process' })
    expect(errorsOf(c)).toEqual([
      [6, `spec.actions[${at}].name`, 'this kernel knows no kernel-verb "restart-process" — the catalog is closed (stop-process, remove-worktree)'],
    ])
    const d = ref()
    d.spec.actions.push({ verb: 'kernel-verb', name: 'remove-worktree', kind: 'process' })
    expect(errorsOf(d)[0]).toEqual([6, `spec.actions[${at}].name`, expect.stringMatching(/^remove-worktree does not act on the kernel kind process/)])
    const e = ref()
    e.spec.actions.push({ verb: 'kernel-verb', kind: 'process' })
    expect(errorsOf(e)[0]).toEqual([6, `spec.actions[${at}].name`, expect.stringMatching(/^a kernel-verb names the kernel's verb it declares/)])
    // a needs-you entry can't carry a kernel-verb (it has no name there)
    const f = ref()
    f.spec.surfaces['needs-you'][0].actions = ['kernel-verb']
    expect(errorsOf(f)[0]![0]).toBe(6)
  })
  it('7 — the kernel clears what it writes; blocking still needs the owner; producer-agent has nobody to go to', () => {
    expect(errorsOf(ref())).toEqual([])
    const a = ref()
    a.spec.surfaces['needs-you'][0].urgency = 'blocking'
    expect(errorsOf(a)[0]![0]).toBe(7)
    const b = ref()
    b.spec.surfaces['needs-you'][0].audience = 'producer-agent'
    expect(errorsOf(b)).toEqual([
      [
        7,
        'spec.surfaces.needs-you[0].audience',
        'audience producer-agent needs the producer to be able to clear it — declare agent-record-write on this kind, or a sync (the sync is its write channel)',
      ],
    ])
    const c = ref()
    c.spec.surfaces['needs-you'][0].audience = 'owner'
    expect(errorsOf(c)).toEqual([])
  })
  it('9 — every example reads; a broken one names its field', () => {
    const m = ref()
    delete m.spec.kinds.process.examples[0].command
    expect(errorsOf(m)).toEqual([[9, 'spec.kinds.process.examples[0]', 'this example does not read: missing command']])
  })
})

// a kernel with the fake source, the registry and the real installer
function world(opts: { now?: () => number } = {}) {
  let now = opts.now ?? (() => NOW)
  const dataDir = join(base, 'data')
  const root = join(dataDir, 'silos')
  const held = new FakeProcesses()
  const kinds = (k: string) => (k === 'process' ? held : null)
  const operator = new SiloOperatorStore(root)
  const registry = new SiloRegistry({ dataDir, operator })
  registry.load()
  const locations: SiloLocations = { agentStates: () => [], projects: () => [] }
  const journal = new TransitionJournal(registry.conventionsDir)
  const kernel = new SiloKernel({ registry, reader: new SiloReader(locations, kinds), journal, isAgent: (v) => v === 'finance', now: () => now() })
  const events = new SiloEvents(root)
  const acks = new SiloAcks(root)
  const installer = new SiloInstaller({
    root,
    registry,
    operator,
    kernel,
    events,
    locations,
    agentStateBase: join(base, 'agent-state'),
    isAgent: (v) => v === 'finance',
    hasBearer: () => true,
    territoriesOf: () => [],
    now: () => now(),
    kernelKinds: kinds,
  })
  const surfaces = new SiloSurfaces({ registry, kernel, journal, isAgent: (v) => v === 'finance', acks, producersOf: (id) => operator.producersOf(id) })
  return {
    dataDir,
    root,
    held,
    registry,
    kernel,
    journal,
    installer,
    surfaces,
    acks,
    events,
    operator,
    setNow: (f: () => number) => {
      now = f
    },
  }
}

describe('the installer: consequences DERIVED for data that is not in files', () => {
  it('says what kernel data it reads in plain words, who writes it (the kernel), and binds nobody', () => {
    const w = world()
    w.held.set(proc(), NOW)
    expect(w.installer.submit({ manifest: ref() }, 'owner').code).toBe(201)
    const c = w.installer.consequences(SILO) as Json
    expect(c.kind).toBe('install')
    expect(c.derived.reads).toEqual([
      {
        source: 'processes',
        root: 'kernel',
        glob: '',
        parser: '',
        kind: 'process',
        convention: 'kernel:process',
        says: KERNEL_KINDS.process!.reads,
        records: 1,
        locations: [],
      },
    ])
    expect(c.derived.producerRole).toBe('kernel')
    expect(c.derived.proposedProducers).toEqual([])
    expect(c.derived.requirements).toEqual([])
    expect(c.derived.proposedAutomation).toBeNull()
    // the owner's dry-run reads what the kernel holds
    expect(c.derived.preview.basis).toBe('from 1 record Silos holds')
    // the kernel is the producer: binding an agent is refused, binding none installs
    expect(w.installer.approve(SILO, { producers: ['finance'] })).toEqual({
      code: 400,
      body: { error: 'the kernel writes the records of a kernel source — there is no producer to bind' },
    })
    const ok = w.installer.approve(SILO, { producers: [] })
    expect(ok.code).toBe(200)
    expect((ok.body as Json).silo).toMatchObject({
      state: 'active',
      kernel: { kind: 'process', reads: KERNEL_KINDS.process!.reads },
      producer: { role: 'kernel', sync: null },
    })
  })
  it("a bearer's dry-run never sees platform data — it speaks from the examples", () => {
    const w = world()
    w.held.set(proc(), NOW)
    const r = w.installer.submit({ manifest: ref() }, 'finance')
    expect(r.code).toBe(201)
    expect((r.body as Json).validation.preview.basis).toMatch(/^from the 3 examples/)
  })
})

function installed(opts: { now?: () => number } = {}) {
  const w = world(opts)
  w.installer.submit({ manifest: ref() }, 'owner')
  const a = w.installer.approve(SILO, {})
  if (a.code !== 200) throw new Error(JSON.stringify(a.body))
  return w
}

describe('surfaces: Home by the same pipe', () => {
  it("pulse and the row in the manifest's words (no agent, no folder), clearing itself when the kernel moves the record", () => {
    let now = NOW
    const w = installed({ now: () => now })
    // installed with nothing held: the journal's baseline is empty
    expect(w.surfaces.board(now).needsYou).toEqual([])
    w.held.set(proc(), now)
    w.kernel.refresh()
    let b = w.surfaces.board(now)
    expect(b.pulse).toEqual([{ silo: SILO, siloName: 'Machine', term: '1 process left running' }])
    expect(b.needsYou).toHaveLength(1)
    const row = b.needsYou[0]!
    expect(row).toMatchObject({
      kind: 'silo',
      reason: 'entry',
      silo: SILO,
      key: 'platform/4821-77',
      recordKind: 'process',
      urgency: 'routine',
      file: null,
      actions: ['open', 'ack'],
      clears: 'state = exited',
    })
    expect(row.agentId).toBeUndefined()
    expect(row.folder).toBeUndefined()
    // the kernel says it exited: the row clears, the pulse leaves
    now += 60_000
    w.held.set(proc({ state: 'exited', exitedAt: new Date(now).toISOString() }), now)
    w.kernel.refresh()
    b = w.surfaces.board(now)
    expect(b.needsYou).toEqual([])
    expect(b.pulse).toEqual([])
    // `exited` is quiet: not work done
    expect(b.done).toEqual([])
    const rec = w.kernel.reading(SILO)!.records.find((r) => r.record.id === '4821-77')!
    expect(w.kernel.sinceFor(SILO)(rec.record, 'exited')).toBe(now)
  })
  it('Seen hides the row until the record changes; a record that was there at install is baseline', () => {
    let now = NOW
    const w = world({ now: () => now })
    w.held.set(proc({ state: 'running' }), now)
    w.installer.submit({ manifest: ref() }, 'owner')
    w.installer.approve(SILO, {})
    w.kernel.refresh()
    expect(w.surfaces.board(now).needsYou).toEqual([])
    now += 60_000
    w.held.set(proc(), now)
    w.kernel.refresh()
    const [row] = w.surfaces.board(now).needsYou
    const rec = w.kernel.reading(SILO)!.records[0]!.record
    w.acks.ack(SILO, row!.key, rec.state, rec.at)
    expect(w.surfaces.board(now).needsYou).toEqual([])
    const hist = w.journal.history('kernel%3Aprocess', row!.key).map((l) => [l.event, l.from ?? null, l.to])
    expect(hist).toEqual([
      ['baseline', null, 'running'],
      ['transition', 'running', 'left'],
    ])
  })
  it('audience works on these entries without a special case: owner keeps them; producer-agent never routes (no producer)', () => {
    const w = world()
    w.held.set(proc(), NOW)
    const m = ref()
    m.spec.surfaces['needs-you'][0].audience = 'owner'
    w.installer.submit({ manifest: m }, 'owner')
    w.installer.approve(SILO, {})
    w.kernel.refresh()
    expect(w.surfaces.board(NOW).needsYou).toHaveLength(1)
    expect(w.surfaces.board(NOW).withProducer).toEqual([])
    expect(w.surfaces.routing(SILO)).toBeNull()
  })
})

describe('the pages: the list and the record archetypes, unchanged', () => {
  it('the record has no file, no CAS version, and its story', () => {
    const w = installed()
    w.held.set(proc(), NOW)
    w.kernel.refresh()
    const e = w.registry.get(SILO)!
    const page = recordsPage(e, w.kernel.reading(SILO), { voice: { now: NOW }, overlayKeys: new Set(), conflictKeys: new Set() }, {}) as Json
    expect(page.kind.columns).toEqual(['identity', 'state', 'ports', 'cpu', 'memoryMb', 'at'])
    expect(page.records[0].cells[0].text).toBe('npm run dev')
    expect(page.records[0].file).toBeNull()
    const d = recordDetail(e, w.kernel.reading(SILO), page.records[0].key, { voice: { now: NOW }, journal: w.journal })!
    expect(d.record.file).toBeNull()
    expect(d.version).toBeNull()
    expect(d.record.anchors).toEqual({})
    expect(d.needsYou).toEqual([{ entry: 0, urgency: 'routine', clears: 'state = exited', actions: ['open', 'ack'] }])
    expect(d.history.map((l) => l.event)).toEqual(['appeared'])
  })
  it('a kernel record the manifest cannot read is listed with its reason, never dropped', () => {
    const w = installed()
    w.held.set(proc(), NOW)
    const m = ref()
    m.spec.kinds.process.fields.origin.oneOf = ['machine']
    const r = new SiloReader({ agentStates: () => [], projects: () => [] }, (k) => (k === 'process' ? w.held : null)).read(SILO, m, { now: NOW })
    expect(r.records).toEqual([])
    expect(r.unreadable).toEqual([
      expect.objectContaining({ location: 'platform', id: '4821-77', rel: 'kernel:process/4821-77', reason: 'origin "conversation" is not one of machine' }),
    ])
  })
})

describe('uninstall: nothing to scan, the journal stays', () => {
  it('keeps the records (platform data) and the journal; no growth term from a kernel convention', () => {
    const w = installed()
    w.held.set(proc(), NOW)
    w.kernel.refresh()
    const u = w.installer.uninstall(SILO)
    expect(u.code).toBe(200)
    expect((u.body as Json).kept).toMatchObject({ records: 1, conventions: ['kernel:process'] })
    expect(w.installer.growth()).toEqual([])
    expect(w.installer.uninstalled()[0]).toMatchObject({ id: SILO, kept: { files: 0, records: 1, conventions: ['kernel:process'] } })
    expect(w.held.records()).toHaveLength(1)
    expect(w.journal.health('kernel%3Aprocess').opened).toBe(true)
  })
})

describe('the published catalog and the kernel agree (catalogs.md «Kernel kinds»)', () => {
  it("every kernel kind, its states (with terminals) and its fields are in the document, with the code's version", () => {
    const md = readFileSync(join(import.meta.dirname, '..', '..', 'docs', 'standard', 'catalogs.md'), 'utf8')
    expect(md).toContain(`## Kernel kinds — \`${KERNEL_KINDS_VERSION}\``)
    for (const [name, kk] of Object.entries(KERNEL_KINDS)) {
      const at = md.indexOf(`### \`${name}\``)
      expect(at, name).toBeGreaterThan(0)
      const end = md.indexOf('\n## ', at)
      const section = md.slice(at, end === -1 ? undefined : end)
      expect(section.replace(/\s+/g, ' ')).toContain(kk.reads)
      for (const st of kk.states) expect(section).toMatch(new RegExp(`\\| \`${st.value}\` \\| ${st.terminal ? '\\*\\*yes\\*\\*' : 'no'} \\|`))
      for (const [f, spec] of Object.entries(kk.fields)) expect(section).toMatch(new RegExp(`\\| \`${f}\` \\| ${spec.type}`))
      for (const f of Object.values(kk.envelope)) expect(section).toContain(`| \`${f}\` |`)
      if (kk.roles.due) expect(section).toContain(`\`${kk.roles.due}\` | timestamp | **role \`due\`**`)
    }
  })
})
