// plans-claim-release.test.ts — the standard and the kernel of
// R1/R4/R13: the claim and release verbs (schema addition v0 + the
// validator's own check), plans 0.5.1 as a builtin update (loosening says the
// new verbs and who may do them), the standing list from the manifest, and
// SiloActions' claim / release / revive judged by the verbs. Generic fixtures.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { validateSilo } from '../src/silos/validator.js'
import { DEFAULT_SCHEMA_PATH, readManifest, standingIdsOf } from '../src/silos/manifest.js'
import { REFERENCE_DIR, dimensions } from '../src/silos/native.js'
import { SiloRegistry } from '../src/silos/registry.js'
import { SiloReader, readRecordValue } from '../src/silos/reader.js'
import { SiloKernel } from '../src/silos/kernel.js'
import { TransitionJournal } from '../src/silos/journal.js'
import { OverlayStore } from '../src/silos/overlay.js'
import { SiloOperatorStore } from '../src/silos/operator.js'
import { SiloInstaller, loosening } from '../src/silos/installer.js'
import { SiloActions, SiloAcks, SiloEvents, SiloProposals } from '../src/silos/actions.js'
import { recordDetail } from '../src/silos/views.js'

type Json = Record<string, any>
const plans = (): Json => JSON.parse(readFileSync(join(REFERENCE_DIR, 'plans.silo.json'), 'utf8')) as Json
// plans as it was before 0.5.1: no claim, no release, no releases[]
const plans050 = (): Json => {
  const m = plans()
  m.metadata.version = '0.5.0'
  m.spec.actions = m.spec.actions.filter((a: Json) => a.verb !== 'claim' && a.verb !== 'release')
  const task = m.spec.kinds.plan.subKinds.task
  delete task.subKinds.release
  delete task.roles.task.releases
  m.spec.actions.find((a: Json) => a.verb === 'ensure-record').seed.title = 'Tasks'
  return m
}

let base: string
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'plans-claim-'))
})
afterEach(() => rmSync(base, { recursive: true, force: true }))

describe('plans 0.6.1 — the reference manifest', () => {
  it('validates as the owner with nothing left as wants', () => {
    const r = validateSilo(plans())
    expect(r.errors).toEqual([])
    expect(r.wants).toEqual([])
    expect(r.ok).toBe(true)
  })
  it('declares claim and release with the literal shapes, releases[] and its role, and the seed with an empty title that reads', () => {
    const m = plans()
    expect(m.spec.actions.filter((a: Json) => a.verb === 'claim' || a.verb === 'release')).toEqual([
      { verb: 'claim', subKind: 'plan/task', link: 'conversations', set: { status: 'in_progress' }, keep: ['blocked'], by: ['owner', 'task-owner'] },
      {
        verb: 'release',
        subKind: 'plan/task',
        link: 'releases',
        by: ['owner', 'task-owner'],
        dispose: { field: 'status', from: 'in_progress', default: 'pending', allowed: ['pending', 'in_review', 'blocked', 'done', 'cancelled'] },
      },
    ])
    const task = m.spec.kinds.plan.subKinds.task
    expect(task.roles.task.releases).toBe('releases')
    expect(task.subKinds.release).toEqual({
      path: 'releases[]',
      appendOnly: true,
      envelope: { identity: { template: '{{session}}' }, at: { field: 'at', mayBeEmpty: true }, updatedBy: { field: 'by' } },
      fields: { session: { type: 'string', required: true }, released: { type: 'boolean', required: true } },
    })
    // no append-item for plan/task/release: only the verbs write there
    expect(m.spec.actions.some((a: Json) => a.verb === 'append-item' && a.subKind === 'plan/task/release')).toBe(false)
    const seed = m.spec.actions.find((a: Json) => a.verb === 'ensure-record').seed
    expect(seed).toEqual({ title: '', tasks: [] })
    expect(readRecordValue(m, 'plan', seed, 'tasks').ok).toBe(true)
    expect(m.spec.surfaces.pulse.label).toEqual({ one: 'task yours to do', many: 'tasks yours to do' })
  })
  it('the standing list comes from the manifest (standingIdsOf), never from a name in code', () => {
    expect([...standingIdsOf(plans(), 'plan')]).toEqual(['tasks'])
    expect([...standingIdsOf(plans(), 'plan/task')]).toEqual([])
    const m = plans()
    m.spec.actions.find((a: Json) => a.verb === 'ensure-record').id = 'pie'
    expect([...standingIdsOf(m, 'plan')]).toEqual(['pie'])
  })
  it('against the schema before the addition it fails with a clear error — never half-applied', () => {
    const old = JSON.parse(readFileSync(DEFAULT_SCHEMA_PATH, 'utf8')) as Json
    const action = old.$defs.action
    // (kernel-verb came after claim/release: the schema before them had neither)
    action.properties.verb.enum = action.properties.verb.enum.filter((v: string) => v !== 'claim' && v !== 'release' && v !== 'kernel-verb')
    delete action.properties.link
    delete action.properties.set
    action.properties.by.anyOf[1].items.enum = ['owner', 'producer']
    delete old.$defs.roles.properties.task.properties.releases
    const schemaPath = join(base, 'old.schema.json')
    writeFileSync(schemaPath, JSON.stringify(old))
    const r = readManifest(plans(), { schemaPath })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toMatch(
      /^the manifest does not follow the Silo Standard: .*must be one of set-field, append-item, move-item, ensure-record, agent-record-write, ack, open, message-agent \(found "claim"\)/,
    )
  })
})

describe("the validator's own check of claim and release (not CATALOG_VERBS)", () => {
  const errs = (mut: (m: Json) => void): string[] => {
    const m = plans()
    mut(m)
    return validateSilo(m).errors.map((e) => `${e.where}: ${e.message}`)
  }
  const claimOf = (m: Json): Json => m.spec.actions.find((a: Json) => a.verb === 'claim')
  const releaseOf = (m: Json): Json => m.spec.actions.find((a: Json) => a.verb === 'release')
  it('by: ["producer"] on claim is refused', () => {
    expect(
      errs((m) => {
        claimOf(m).by = ['producer']
      }).some((e) => /claim is done by owner or task-owner only \(found producer\)/.test(e)),
    ).toBe(true)
  })
  it('link must be a collection of the subKind — an identity one for claim, the releases one for release', () => {
    expect(
      errs((m) => {
        claimOf(m).link = 'nope'
      }).some((e) => /nope is not a collection of plan\/task/.test(e)),
    ).toBe(true)
    expect(
      errs((m) => {
        claimOf(m).link = 'notes'
      }).some((e) => /claim links an id — notes is not a list of ids/.test(e)),
    ).toBe(true)
    expect(
      errs((m) => {
        releaseOf(m).link = 'conversations'
      }).some((e) => /release marks the collection roles.task.releases names/.test(e)),
    ).toBe(true)
  })
  it('set only fields with declared states, to a declared state', () => {
    expect(
      errs((m) => {
        claimOf(m).set = { owner: 'writer' }
      }).some((e) => /claim sets only a field with declared states \(status\) — owner is not one/.test(e)),
    ).toBe(true)
    expect(
      errs((m) => {
        claimOf(m).set = { status: 'flying' }
      }).some((e) => /flying is not a state of plan\/task/.test(e)),
    ).toBe(true)
  })
  it('task-owner needs roles.task.owner, and only claim/release take it', () => {
    expect(
      errs((m) => {
        delete m.spec.kinds.plan.subKinds.task.roles.task.owner
      }).length,
    ).toBeGreaterThan(0)
    expect(
      errs((m) => {
        m.spec.actions.find((a: Json) => a.verb === 'append-item' && a.subKind === 'plan/task/note').by = ['task-owner']
      }).some((e) => /task-owner does only claim and release/.test(e)),
    ).toBe(true)
  })
})

describe('loosening — `by` compared on every verb (the class rule)', () => {
  it('says the new verbs with who may do them, and a `by` that gains someone', () => {
    const lines = loosening(plans050(), plans(), [], [])
    expect(lines).toContain('a new action: claim on plan/task (by owner, task-owner)')
    expect(lines).toContain('a new action: release on plan/task (by owner, task-owner)')
    const wider = plans()
    wider.spec.actions.find((a: Json) => a.verb === 'append-item' && a.subKind === 'plan/task/conversation').by = ['owner', 'producer']
    expect(loosening(plans(), wider, [], [])).toEqual(['append-item may now be done by producer'])
  })
})

describe('updateBuiltin applies plans 0.8.2 over an installed 0.5.0', () => {
  it('outcome «updated», said with what it loosens', () => {
    const dataDir = join(base, 'data')
    const root = join(dataDir, 'silos')
    const ref = join(base, 'reference')
    mkdirSync(ref, { recursive: true })
    const setup = () => {
      const operator = new SiloOperatorStore(root)
      const dims = dimensions([{ id: 'plans', name: 'Plans', served: 'builtin', manifest: 'plans.silo.json', slotsOff: ['pulse'] }], ref)
      const registry = new SiloRegistry({ dataDir, operator, nativeRefusal: (id) => dims.nativeRefusal(id) })
      registry.load()
      const locations = { agentStates: () => [], projects: () => [join(base, 'proj')] }
      const kernel = new SiloKernel({
        registry,
        reader: new SiloReader(locations),
        journal: new TransitionJournal(registry.conventionsDir),
        overlay: new OverlayStore(registry.conventionsDir),
        isAgent: () => false,
      })
      return {
        registry,
        installer: new SiloInstaller({
          root,
          registry,
          operator,
          kernel,
          events: new SiloEvents(root),
          locations,
          agentStateBase: join(base, 'agent-state'),
          isAgent: () => false,
          hasBearer: () => true,
          territoriesOf: () => [],
          dimensions: dims,
        }),
      }
    }
    writeFileSync(join(ref, 'plans.silo.json'), JSON.stringify(plans050()))
    expect(setup().installer.installBuiltins()[0]).toMatchObject({ id: 'plans', outcome: 'installed' })
    writeFileSync(join(ref, 'plans.silo.json'), JSON.stringify(plans()))
    const { installer, registry } = setup()
    const [o] = installer.installBuiltins()
    expect(o).toMatchObject({ id: 'plans', outcome: 'updated' })
    expect(o!.says).toContain('Silos updated Plans 0.5.0 → 0.8.2')
    expect(o!.says).toContain('a new action: claim on plan/task (by owner, task-owner)')
    expect(registry.get('plans')!.status.manifest.version).toBe('0.8.2')
  })
})

// ── SiloActions over the real kernel ──
function world(tasks: Json[], manifest: Json = plans(), threadKey?: (id: string) => string) {
  const dataDir = join(base, 'data')
  const proj = join(base, 'proj')
  const f = join(proj, 'plans', 'p.plan.json')
  mkdirSync(join(f, '..'), { recursive: true })
  writeFileSync(f, JSON.stringify({ title: 'P', tasks }, null, 2))
  mkdirSync(join(dataDir, 'silos', 'registry', 'plans'), { recursive: true })
  writeFileSync(join(dataDir, 'silos', 'registry', 'plans', 'silo.json'), JSON.stringify(manifest))
  const registry = new SiloRegistry({ dataDir, operator: { decisionFor: () => 'approved', slotsOff: () => [] } })
  registry.load()
  const isAgent = (v: string): boolean => v === 'writer' || v === 'ops'
  const kernel = new SiloKernel({
    registry,
    journal: new TransitionJournal(registry.conventionsDir),
    overlay: new OverlayStore(registry.conventionsDir),
    isAgent,
    reader: new SiloReader({ agentStates: () => [], projects: () => [proj] }),
  })
  kernel.refresh()
  const events = new SiloEvents(registry.root)
  const actions = new SiloActions({
    registry,
    kernel,
    events,
    acks: new SiloAcks(registry.root),
    proposals: new SiloProposals(registry.root),
    agentStateBase: join(dataDir, 'agent-state'),
    isAgent,
    agentMayReadLocation: () => false,
    ...(threadKey ? { threadKey } : {}),
  })
  const key = (id: string): string => `folder:${proj}/p/tasks/${id}`
  const file = (): Json => JSON.parse(readFileSync(f, 'utf8'))
  return { actions, kernel, registry, events, key, file, f }
}
const task = (id: string, over: Json = {}): Json => ({ id, title: `Task ${id}`, owner: 'writer', status: 'pending', dependsOn: [], ...over })

describe('linkAndSet — judged by the claim verb', () => {
  it("the owner and the task's own agent may; another agent may not", () => {
    const w = world([task('t1')])
    expect(w.actions.linkAndSet('plans', w.key('t1'), 'conversations', 'aaaaaaaa-0001', 'status', 'in_progress', { actor: { agentId: 'ops' } })).toMatchObject({
      ok: false,
      code: 403,
    })
    expect(w.file().tasks[0].conversations).toBeUndefined()
    expect(
      w.actions.linkAndSet('plans', w.key('t1'), 'conversations', 'aaaaaaaa-0001', 'status', 'in_progress', { actor: { agentId: 'writer' }, by: 'writer' }),
    ).toMatchObject({ ok: true, value: { linked: true, set: true, revived: false } })
    expect(w.actions.linkAndSet('plans', w.key('t1'), 'conversations', 'bbbbbbbb-0002', 'status', 'in_progress', {})).toMatchObject({ ok: true })
    expect(w.file().tasks[0]).toMatchObject({ status: 'in_progress', conversations: ['aaaaaaaa-0001', 'bbbbbbbb-0002'] })
  })
  it("without the verb, today's rule: set-field's writableBy and append-item's by", () => {
    const w = world([task('t1')], plans050())
    expect(w.actions.linkAndSet('plans', w.key('t1'), 'conversations', 'aaaaaaaa-0001', 'owner', 'ops')).toMatchObject({ ok: false, code: 403 })
    expect(w.actions.linkAndSet('plans', w.key('t1'), 'conversations', 'aaaaaaaa-0001', 'status', 'in_progress', { actor: { agentId: 'ops' } })).toMatchObject({
      ok: true,
    })
    expect(w.file().tasks[0]).toMatchObject({ status: 'in_progress', conversations: ['aaaaaaaa-0001'] })
  })
})

describe('appendRelease and the revive — releases[] (R13)', () => {
  it('a release appends {session, released: true, at, by}; again is idempotent against the last mark of its thread', () => {
    const w = world([task('t1', { status: 'in_progress', conversations: ['aaaaaaaa-0001'] })])
    const r = w.actions.appendRelease('plans', w.key('t1'), 'aaaaaaaa-0001', true, { by: 'writer', actor: { agentId: 'writer' } })
    expect(r).toMatchObject({ ok: true, value: { written: true, state: 'pending', disposed: 'pending' } })
    const t1 = w.file().tasks[0]
    expect(t1.releases).toEqual([{ session: 'aaaaaaaa-0001', released: true, at: expect.any(String), by: 'writer' }])
    expect(t1.status).toBe('pending') // 0.5.2 dispose: the last current thread let go → to pick up
    expect(w.actions.appendRelease('plans', w.key('t1'), 'aaaaaaaa-0001', true, {})).toMatchObject({
      ok: true,
      value: { written: false, kept: 'pending', already: 'released' },
    })
    expect(w.file().tasks[0].releases).toHaveLength(1)
    expect(w.actions.appendRelease('plans', w.key('t1'), 'aaaaaaaa-0001', true, { actor: { agentId: 'ops' } })).toMatchObject({ ok: false, code: 403 })
  })
  it('release → claim with the same id → current again, in ONE write (conversations[] dedupes, releases[] gains false)', () => {
    const w = world([
      task('t1', {
        status: 'pending',
        conversations: ['aaaaaaaa-0001'],
        releases: [{ session: 'aaaaaaaa-0001', released: true, at: '2026-11-08T08:00:00Z', by: 'writer' }],
      }),
    ])
    const before = readFileSync(w.f, 'utf8')
    const r = w.actions.linkAndSet('plans', w.key('t1'), 'conversations', 'aaaaaaaa-0001', 'status', 'in_progress', {
      actor: { agentId: 'writer' },
      by: 'writer',
    })
    expect(r).toMatchObject({ ok: true, value: { linked: false, set: true, revived: true } })
    const t1 = w.file().tasks[0]
    expect(before).not.toBe(readFileSync(w.f, 'utf8'))
    expect(t1.conversations).toEqual(['aaaaaaaa-0001'])
    expect(t1.releases.map((x: Json) => x.released)).toEqual([true, false])
    // released again inside two minutes: history — never the append dedupe
    expect(w.actions.appendRelease('plans', w.key('t1'), 'aaaaaaaa-0001', true, {})).toMatchObject({ ok: true, value: { written: true } })
    expect(w.file().tasks[0].releases.map((x: Json) => x.released)).toEqual([true, false, true])
  })
  it('the revive needs nothing else to change: a re-claim of a released, in-progress, listed id writes the false mark alone', () => {
    const w = world([task('t1', { status: 'in_progress', conversations: ['aaaaaaaa-0001'], releases: [{ session: 'aaaaaaaa-0001', released: true }] })])
    expect(w.actions.linkAndSet('plans', w.key('t1'), 'conversations', 'aaaaaaaa-0001', 'status', 'in_progress', {})).toMatchObject({
      ok: true,
      value: { revived: true },
    })
    expect(w.file().tasks[0].releases.at(-1)).toMatchObject({ session: 'aaaaaaaa-0001', released: false })
  })
  it('⌘K Link (append-item on conversations) revives too; the thread groups by o.threadKey', () => {
    const tk = (id: string): string => (id === 'bbbbbbbb-tip' ? 'aaaaaaaa-0001' : id)
    const w = world([task('t1', { conversations: ['aaaaaaaa-0001'], releases: [{ session: 'aaaaaaaa-0001', released: true }] })], plans(), tk)
    expect(w.actions.appendItem('plans', w.key('t1'), 'conversations', { session: 'bbbbbbbb-tip' }).ok).toBe(true)
    const t1 = w.file().tasks[0]
    expect(t1.conversations).toEqual(['aaaaaaaa-0001', 'bbbbbbbb-tip'])
    expect(t1.releases.at(-1)).toMatchObject({ session: 'bbbbbbbb-tip', released: false })
  })
  it('revive:false (sealing an engine id onto a released key) adds the id and never undoes the release', () => {
    const tk = (id: string): string => (id === 'ses_native' ? 'console-key' : id)
    const w = world([task('t1', { conversations: ['console-key'], releases: [{ session: 'console-key', released: true }] })], plans(), tk)
    expect(w.actions.appendItem('plans', w.key('t1'), 'conversations', { session: 'ses_native' }, { by: 'silos', revive: false }).ok).toBe(true)
    const t1 = w.file().tasks[0]
    expect(t1.conversations).toEqual(['console-key', 'ses_native'])
    expect(t1.releases).toEqual([{ session: 'console-key', released: true }])
  })
  it('a releases that is not a list: 409, nothing written', () => {
    const w = world([task('t1', { conversations: ['aaaaaaaa-0001'], releases: 'oops' })])
    const before = readFileSync(w.f, 'utf8')
    expect(w.actions.appendRelease('plans', w.key('t1'), 'aaaaaaaa-0001', true, {})).toMatchObject({ ok: false })
    expect(readFileSync(w.f, 'utf8')).toBe(before)
  })
  it('without the release verb: 501 «this Plans has no release — update it»', () => {
    const w = world([task('t1', { conversations: ['aaaaaaaa-0001'] })], plans050())
    expect(w.actions.appendRelease('plans', w.key('t1'), 'aaaaaaaa-0001', true, {})).toMatchObject({
      ok: false,
      code: 501,
      reason: 'this Plans has no release — update it',
    })
  })
  it("a task of the standing list says standingList on its parent (from the manifest's ensure-record id)", () => {
    const w = world([task('t1')])
    const proj = join(base, 'proj')
    writeFileSync(join(proj, 'plans', 'tasks.plan.json'), JSON.stringify({ title: '', tasks: [task('b1')] }))
    w.kernel.refresh()
    const of = (k: string): Json => (recordDetail(w.registry.get('plans')!, w.kernel.reading('plans'), k, { voice: { now: Date.now() } }) as Json).parent
    expect(of(`folder:${proj}/tasks/tasks/b1`)).toMatchObject({ standingList: true })
    expect(of(w.key('t1')).standingList).toBeUndefined()
  })
  it('the record page omits roles.task.releases: history of validity, not content', () => {
    const w = world([task('t1', { conversations: ['aaaaaaaa-0001'], releases: [{ session: 'aaaaaaaa-0001', released: true }] })])
    const d = recordDetail(w.registry.get('plans')!, w.kernel.reading('plans'), w.key('t1'), { voice: { now: Date.now() } }) as Json
    expect(d.children.map((c: Json) => c.collection).sort()).toEqual(['conversations', 'notes'])
  })
})
