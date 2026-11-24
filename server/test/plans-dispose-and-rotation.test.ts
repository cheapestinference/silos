// plans-dispose-and-rotation.test.ts — the plans kernel over the REAL
// reference manifest:
//   - release with `dispose` — only from in_progress AND the last current
//     thread; `kept` / `already`; 400 outside dispose.allowed
//   - the rotation by month with since() from the journal + `undated: old`,
//     `monthStart` in UTC; rotateExisting never makes a backlog; the daily
//     sweep once per project and day; `retired` = union of the archives;
//     the live child wins; retired ids resolve to their archive; `label`
//     and the standing record's own row
//   - the plans silo validates with EMPTY wants (the boot test)
// Generic fixtures: agents dev/ops, a person sam, project folders under tmp.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { validateSilo } from '../src/silos/validator.js'
import { SiloRegistry } from '../src/silos/registry.js'
import { SiloReader } from '../src/silos/reader.js'
import { SiloKernel } from '../src/silos/kernel.js'
import { TransitionJournal } from '../src/silos/journal.js'
import { OverlayStore } from '../src/silos/overlay.js'
import { SiloActions, SiloAcks, SiloEvents, SiloProposals } from '../src/silos/actions.js'
import { evaluate, parse, test as testExpr } from '../src/silos/expressions.js'
import { ClosedPlans } from '../src/plans-closed.js'
import { outsideDetail, recordDetail, recordsPage } from '../src/silos/views.js'
import { plansManifest } from './helpers/plans-silo.js'

type Json = Record<string, any>
const isAgent = (v: string): boolean => v === 'writer' || v === 'ops'

let base: string
let proj: string
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'plans-kernel-'))
  proj = join(base, 'acme')
  mkdirSync(join(proj, 'plans'), { recursive: true })
})
afterEach(() => rmSync(base, { recursive: true, force: true }))

const put = (name: string, v: Json): void => {
  mkdirSync(join(proj, 'plans', name, '..'), { recursive: true })
  writeFileSync(join(proj, 'plans', name), JSON.stringify(v, null, 2))
}
const read = (name: string): Json => JSON.parse(readFileSync(join(proj, 'plans', name), 'utf8'))
const task = (id: string, status: string, over: Json = {}): Json => ({ id, title: `Task ${id}`, owner: 'writer', status, dependsOn: [], ...over })
const loc = (): string => `folder:${proj}`

// a clock the kernel's journal and the actions share
function world(opts: { manifest?: Json; projects?: () => string[]; currentOf?: (l: string[], r: unknown) => string[] } = {}) {
  let now = Date.parse('2026-11-03T10:00:00Z')
  const dataDir = join(base, 'data')
  mkdirSync(join(dataDir, 'silos', 'registry', 'plans'), { recursive: true })
  writeFileSync(join(dataDir, 'silos', 'registry', 'plans', 'silo.json'), JSON.stringify(opts.manifest ?? plansManifest()))
  const registry = new SiloRegistry({ dataDir, operator: { decisionFor: () => 'approved', slotsOff: () => [] } })
  registry.load()
  const projects = opts.projects ?? (() => [proj])
  const journal = new TransitionJournal(registry.conventionsDir)
  let ticks = 0
  const kernel = new SiloKernel({
    registry,
    journal,
    overlay: new OverlayStore(registry.conventionsDir),
    isAgent,
    now: () => now,
    reader: new SiloReader({ agentStates: () => [], projects }),
    onTick: () => {
      ticks++
    },
  })
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
    locations: { projects },
    now: () => new Date(now),
    ...(opts.currentOf ? { currentOf: opts.currentOf } : {}),
  })
  return {
    registry,
    kernel,
    journal,
    actions,
    events,
    at: (iso: string) => {
      now = Date.parse(iso)
    },
    ticks: () => ticks,
  }
}

describe('plans 0.8.2 — the boot test', () => {
  it("validates as the owner with EMPTY wants (dispose, undated, monthStart, owner = 'owner' all understood)", () => {
    const m = plansManifest()
    expect(m.metadata.version).toBe('0.8.2')
    const r = validateSilo(m)
    expect(r.errors).toEqual([])
    expect(r.wants).toEqual([])
    expect(r.ok).toBe(true)
  })
  it('declares the literal release of E4, the rotation of E7 and the needs-you order of E8 (the chase rule FIRST)', () => {
    const m = plansManifest()
    const rel = m.spec.actions.find((a: Json) => a.verb === 'release')
    expect(rel).toEqual({
      verb: 'release',
      subKind: 'plan/task',
      link: 'releases',
      by: ['owner', 'task-owner'],
      dispose: { field: 'status', from: 'in_progress', default: 'pending', allowed: ['pending', 'in_review', 'blocked', 'done', 'cancelled'] },
    })
    const ens = m.spec.actions.find((a: Json) => a.verb === 'ensure-record')
    expect(ens.seed).toEqual({ title: '', tasks: [] })
    expect(ens.rotate).toMatchObject({
      when: '(state = done and since(done) < monthStart) or (state = cancelled and since(cancelled) < monthStart)',
      undated: 'old',
    })
    expect(m.spec.surfaces['needs-you'].map((n: Json) => n.when)).toEqual([
      "ready and owner is human and owner != 'owner' and gate",
      "ready and owner = 'owner' and (gate or due < now + 7d)",
      "ready and owner = 'owner'",
      'waitsOnHuman',
    ])
    expect(m.spec.surfaces.pulse.when).toBe("ready and owner = 'owner'")
    // the protocol is format only: no behaviour words left for the skill to contradict
    const protocol = m.spec.producer.instructions.protocol.join('\n')
    expect(protocol).toContain('"at": "<ISO>", "by": "<you>"')
    expect(protocol).not.toMatch(/re-?read the plan|never closed/)
    expect(m.spec.producer.instructions.summary).not.toContain('never closed')
  })
})

describe('the standard — dispose and undated in the schema and the validator', () => {
  const withRelease = (dispose: unknown): Json => {
    const m = plansManifest()
    m.spec.actions.find((a: Json) => a.verb === 'release').dispose = dispose
    return m
  }
  const msgs = (m: Json): string[] => validateSilo(m).errors.map((e) => `${e.where}: ${e.message}`)
  it('a dispose whose field is not the state field, or whose states are not declared, is refused in words', () => {
    expect(msgs(withRelease({ field: 'owner', from: 'in_progress', default: 'pending', allowed: ['pending'] })).join('\n')).toMatch(
      /dispose\.field: dispose acts on a field with declared states \(status\)/,
    )
    expect(msgs(withRelease({ field: 'status', from: 'running', default: 'pending', allowed: ['pending'] })).join('\n')).toMatch(
      /dispose\.from: running is not a state of plan\/task/,
    )
    expect(msgs(withRelease({ field: 'status', from: 'in_progress', default: 'pending', allowed: ['pending', 'paused'] })).join('\n')).toMatch(
      /dispose\.allowed: paused is not a state/,
    )
    expect(msgs(withRelease({ field: 'status', from: 'in_progress', default: 'done', allowed: ['pending'] })).join('\n')).toMatch(
      /dispose\.default: the default \(done\) must be one of allowed/,
    )
  })
  it('dispose on claim is refused; set on release is still refused', () => {
    const m = plansManifest()
    m.spec.actions.find((a: Json) => a.verb === 'claim').dispose = { field: 'status', from: 'pending', default: 'pending', allowed: ['pending'] }
    expect(msgs(m).join('\n')).toMatch(/dispose belongs to release/)
    const n = plansManifest()
    n.spec.actions.find((a: Json) => a.verb === 'release').set = { status: 'pending' }
    expect(msgs(n).join('\n')).toMatch(/release never sets a field/)
  })
  it('undated is "old" or nothing — another value is refused (by the schema\'s const)', () => {
    const m = plansManifest()
    m.spec.actions.find((a: Json) => a.verb === 'ensure-record').rotate.undated = 'new'
    expect(validateSilo(m).ok).toBe(false)
  })
})

describe('the language — monthStart (UTC) and since() undated only inside a rotation', () => {
  const ast = (src: string) => {
    const r = parse(src, 'predicate')
    if (!r.ok) throw new Error(r.error.message)
    return r.ast
  }
  it('monthStart is the first instant of the current month in UTC, comparable as a moment', () => {
    const now = Date.parse('2026-11-30T23:30:00-05:00') // already Dec 1 in UTC
    const v = evaluate(
      { t: 'cmp', op: '=', left: { t: 'monthStart', pos: 0 }, right: { t: 'num', value: Date.parse('2026-12-01T00:00:00Z'), pos: 0 }, pos: 0 },
      {},
      { now },
    )
    expect(v).toBe(true)
    expect(testExpr(ast('at < monthStart'), { at: '2026-11-30T12:00:00Z' }, { now })).toBe(true)
    expect(testExpr(ast('at < monthStart'), { at: '2026-12-01T00:00:01Z' }, { now })).toBe(false)
  })
  it('since(x) with no transition is never true — save under sinceUndatedIsOld, where it counts as long ago', () => {
    const e = ast('state = done and since(done) < monthStart')
    const env = { now: Date.parse('2026-11-03T10:00:00Z'), since: () => null }
    expect(testExpr(e, { state: 'done' }, env)).toBe(false)
    expect(testExpr(e, { state: 'done' }, { ...env, sinceUndatedIsOld: true })).toBe(true)
    // a dated since is read as it is, whatever the option
    const dated = { ...env, since: () => Date.parse('2026-11-02T00:00:00Z'), sinceUndatedIsOld: true }
    expect(testExpr(e, { state: 'done' }, dated)).toBe(false)
  })
})

describe('the rotation by month — since() from the journal, undated old', () => {
  it('what finished before this month (UTC) leaves; what finished this month stays; a baseline-finished task is undated → old', () => {
    const w = world()
    w.at('2026-10-20T10:00:00Z')
    put('tasks.plan.json', {
      title: '',
      rotatedAt: '2026-10',
      tasks: [task('t1', 'pending'), task('t2', 'pending'), task('t3', 'done'), task('t4', 'cancelled'), task('t5', 'in_progress')],
    })
    w.kernel.refresh() // baseline: t3/t4 finished «as found» — undated
    w.at('2026-10-25T10:00:00Z')
    put('tasks.plan.json', {
      ...read('tasks.plan.json'),
      tasks: [task('t1', 'done'), task('t2', 'pending'), task('t3', 'done'), task('t4', 'cancelled'), task('t5', 'in_progress')],
    })
    w.kernel.refresh() // t1 done, seen Oct 25
    w.at('2026-11-03T10:00:00Z')
    put('tasks.plan.json', {
      ...read('tasks.plan.json'),
      tasks: [task('t1', 'done'), task('t2', 'done'), task('t3', 'done'), task('t4', 'cancelled'), task('t5', 'in_progress')],
    })
    w.kernel.refresh() // t2 done, seen Nov 3
    // the rotation reads since() over the SAME objects the journal keyed (the kernel's WeakMap)
    const rec = w.kernel.reading('plans')!.records.find((r) => r.record.id === 'tasks')!
    const kids = rec.record.tasks as Json[]
    const since = w.kernel.sinceFor('plans')
    expect(
      since(
        kids.find((k) => k.id === 't2')!,
        'done',
      ),
    ).toBe(Date.parse('2026-11-03T10:00:00Z'))
    expect(
      since(
        kids.find((k) => k.id === 't1')!,
        'done',
      ),
    ).toBe(Date.parse('2026-10-25T10:00:00Z'))
    expect(
      since(
        kids.find((k) => k.id === 't3')!,
        'done',
      ),
    ).toBeNull()
    const r = w.actions.ensureRecord('plans', loc(), 'tasks')
    expect(r.ok && r.value.rotated.sort()).toEqual(['t1', 't3', 't4'])
    expect(read('tasks.plan.json').tasks.map((t: Json) => t.id)).toEqual(['t2', 't5'])
    const arch = read('closed/tasks-2026-10.plan.json')
    expect(arch.title).toBe('acme — closed 2026-10') // «<project> — closed <YYYY-MM>»
    expect(arch.tasks.map((t: Json) => t.id)).toEqual(['t1', 't3', 't4'])
  })
})

describe('rotateExisting and the daily sweep — never a backlog made', () => {
  it('a project without a standing list keeps having none', () => {
    const w = world()
    w.kernel.refresh()
    expect(w.actions.rotateExisting('plans', proj)).toEqual({ ok: true, value: [] })
    expect(existsSync(join(proj, 'plans', 'tasks.plan.json'))).toBe(false)
    expect(w.actions.rotateSweep()).toEqual([])
    expect(existsSync(join(proj, 'plans', 'tasks.plan.json'))).toBe(false)
    expect(w.actions.rotateExisting('plans', join(base, 'elsewhere'))).toMatchObject({ ok: false, code: 404 })
  })
  it('an existing one rotates in a new month without anyone adding a task', () => {
    put('tasks.plan.json', { title: '', rotatedAt: '2026-10', tasks: [task('t1', 'done'), task('t2', 'pending')] })
    const w = world()
    w.kernel.refresh()
    expect(w.actions.rotateExisting('plans', proj)).toEqual({ ok: true, value: [{ key: `${loc()}/tasks`, rotated: ['t1'] }] })
    expect(read('tasks.plan.json')).toMatchObject({ rotatedAt: '2026-11', retired: ['t1'] })
  })
  it('the sweep runs at most once per project and UTC day; the kernel tick is where it hangs', () => {
    put('tasks.plan.json', { title: '', rotatedAt: '2026-10', tasks: [task('t1', 'done')] })
    const w = world()
    w.kernel.start(60 * 60_000)
    expect(w.ticks()).toBe(1)
    w.kernel.stop()
    expect(w.actions.rotateSweep()).toEqual([{ silo: 'plans', folder: proj, key: `${loc()}/tasks`, rotated: ['t1'] }])
    // the same day: a stale write drops the stamp and a finished task arrives — the sweep waits for tomorrow
    put('tasks.plan.json', { ...read('tasks.plan.json'), rotatedAt: '2026-10', tasks: [task('t9', 'done')] })
    w.kernel.refresh()
    expect(w.actions.rotateSweep()).toEqual([])
    expect(read('tasks.plan.json').rotatedAt).toBe('2026-10')
    // tomorrow it runs: t9 arrived finished THIS month (the journal saw it Nov 3) — it stays
    w.at('2026-11-04T00:05:00Z')
    expect(w.actions.rotateSweep()).toEqual([{ silo: 'plans', folder: proj, key: `${loc()}/tasks`, rotated: [] }])
    expect(read('tasks.plan.json')).toMatchObject({ rotatedAt: '2026-11', tasks: [expect.objectContaining({ id: 't9' })] })
    // and leaves in December
    w.kernel.refresh()
    w.at('2026-12-01T00:05:00Z')
    expect(w.actions.rotateSweep()).toEqual([{ silo: 'plans', folder: proj, key: `${loc()}/tasks`, rotated: ['t9'] }])
    expect(read('closed/tasks-2026-11.plan.json').tasks.map((t: Json) => t.id)).toEqual(['t9'])
  })
})

describe('integrity — retired never shrinks; the live child wins; retired ids keep resolving', () => {
  it("retired is rebuilt as the union of the archives' ids, whatever the stamp says", () => {
    put('closed/tasks-2026-09.plan.json', { title: 'acme — closed 2026-09', rotatedFrom: 'tasks', tasks: [task('t1', 'done')] })
    put('closed/tasks-2026-10.plan.json', { title: 'acme — closed 2026-10', rotatedFrom: 'tasks', tasks: [task('t2', 'done'), task('t3', 'cancelled')] })
    put('closed/other.plan.json', { title: 'Not an archive of the list', tasks: [task('t7', 'done')] })
    // an agent's stale read→write dropped retired[]
    put('tasks.plan.json', { title: '', rotatedAt: '2026-11', retired: ['t2'], tasks: [task('t4', 'pending')] })
    const w = world()
    w.kernel.refresh()
    expect(w.actions.rotateExisting('plans', proj)).toMatchObject({ ok: true, value: [{ rotated: [] }] })
    const live = read('tasks.plan.json')
    expect(live.retired).toEqual(['t2', 't1', 't3'])
    expect(live.rotatedAt).toBe('2026-11')
    expect(w.events.list('plans').map((e) => e.text)).toContain('retired 2 ids again from the archives (t1, t3) — they are never reused')
    // never reused
    expect(w.actions.appendItem('plans', `${loc()}/tasks`, 'tasks', { id: 't1', title: 'again', owner: 'writer' })).toMatchObject({ ok: false, code: 409 })
    // nothing missing: nothing written
    const before = readFileSync(join(proj, 'plans', 'tasks.plan.json'), 'utf8')
    w.kernel.refresh()
    w.actions.rotateExisting('plans', proj)
    expect(readFileSync(join(proj, 'plans', 'tasks.plan.json'), 'utf8')).toBe(before)
  })
  it('a child both live and archived: the live one is what the next rotation archives', () => {
    put('closed/tasks-2026-10.plan.json', { title: 'acme — closed 2026-10', rotatedFrom: 'tasks', tasks: [task('t1', 'done', { title: 'old copy' })] })
    put('tasks.plan.json', { title: '', rotatedAt: '2026-10', tasks: [task('t1', 'done', { title: 'live copy' })] })
    const w = world()
    w.kernel.refresh()
    expect(w.actions.rotateExisting('plans', proj)).toMatchObject({ ok: true, value: [{ rotated: ['t1'] }] })
    expect(read('closed/tasks-2026-10.plan.json').tasks).toEqual([expect.objectContaining({ id: 't1', title: 'live copy' })])
  })
  it('ClosedPlans.resolve answers a retired id by the key it had in the list — the newest archive holding it', () => {
    put('closed/tasks-2026-09.plan.json', { title: 'acme — closed 2026-09', rotatedFrom: 'tasks', tasks: [task('t1', 'done', { title: 'September copy' })] })
    put('closed/tasks-2026-10.plan.json', {
      title: 'acme — closed 2026-10',
      rotatedFrom: 'tasks',
      tasks: [task('t1', 'done', { title: 'October copy' }), task('t2', 'done')],
    })
    put('tasks.plan.json', { title: '', rotatedAt: '2026-11', retired: ['t1', 't2'], tasks: [task('t3', 'pending')] })
    const w = world()
    w.kernel.refresh()
    const closed = new ClosedPlans({
      siloId: 'plans',
      manifest: () => w.registry.get('plans')!.manifest as Json,
      conventionDirs: () =>
        w.kernel
          .watchedFolders()
          .filter((x) => x.silo === 'plans')
          .map((x) => x.dir),
    })
    const key = `${loc()}/tasks/tasks/t1`
    // the live reading does not hold it
    expect(recordDetail(w.registry.get('plans')!, w.kernel.reading('plans'), key, { voice: { now: Date.now(), isAgent } })).toBeNull()
    const hit = closed.resolve(key, { isAgent })
    expect(hit).toMatchObject({ location: loc(), record: { id: 'tasks' } })
    const d = outsideDetail(w.registry.get('plans')!, hit!, { now: Date.now(), isAgent }, key)
    expect(d).toMatchObject({
      outside: true,
      record: { id: 't1', key, identity: 'October copy', label: 'acme#t1' },
      parent: { key: `${loc()}/tasks`, identity: 'acme — closed 2026-10' },
    })
    // an archive's own key still resolves as before; an id no archive holds does not
    expect(closed.resolve(`${loc()}/tasks-2026-09/tasks/t1`, { isAgent })?.record.id).toBe('tasks-2026-09')
    expect(closed.resolve(`${loc()}/tasks/tasks/t9`, { isAgent })).toBeNull()
  })
})

describe('release with dispose', () => {
  const S1 = 'aaaaaaaa-0001'
  const S2 = 'bbbbbbbb-0002'
  const setup = (t: Json, opts: Parameters<typeof world>[0] = {}) => {
    put('p.plan.json', { title: 'P', tasks: [t] })
    const w = world(opts)
    w.kernel.refresh()
    const key = `${loc()}/p/tasks/${t.id}`
    const status = (): string => read('p.plan.json').tasks[0].status
    return { ...w, key, status }
  }
  it('no state: the last current thread let go → pending, in the same write as the mark', () => {
    const w = setup(task('t1', 'in_progress', { conversations: [S1] }))
    expect(w.actions.appendRelease('plans', w.key, S1, true, { by: 'writer', actor: { agentId: 'writer' } })).toMatchObject({
      ok: true,
      value: { written: true, state: 'pending', disposed: 'pending' },
    })
    const t = read('p.plan.json').tasks[0]
    expect([t.status, t.releases.length]).toEqual(['pending', 1])
    expect(w.events.list('plans').map((e) => e.text)).toEqual([
      `released ${S1} — it is history on this task`,
      'set-field status: in_progress → pending (released)',
    ])
  })
  it('a state in allowed is the one left; one outside is a 400 in words and nothing is written', () => {
    const w = setup(task('t1', 'in_progress', { conversations: [S1] }))
    expect(w.actions.appendRelease('plans', w.key, S1, true, { state: 'in_progress' })).toEqual({
      ok: false,
      code: 400,
      reason: 'state must be one of pending, in_review, blocked, done, cancelled — omit it to leave it pending',
    })
    expect(read('p.plan.json').tasks[0].releases).toBeUndefined()
    expect(w.actions.appendRelease('plans', w.key, S1, true, { state: 'done' })).toMatchObject({ ok: true, value: { state: 'done', disposed: 'done' } })
    expect(w.status()).toBe('done')
  })
  it('another thread still current: the state is not touched and the answer says kept; the last one disposes', () => {
    const w = setup(task('t1', 'in_progress', { conversations: [S1, S2] }))
    expect(w.actions.appendRelease('plans', w.key, S1, true, { state: 'done' })).toMatchObject({
      ok: true,
      value: { written: true, state: 'in_progress', kept: 'in_progress' },
    })
    expect(w.status()).toBe('in_progress')
    w.kernel.refresh()
    expect(w.actions.appendRelease('plans', w.key, S2, true, { state: 'blocked' })).toMatchObject({
      ok: true,
      value: { state: 'blocked', disposed: 'blocked' },
    })
    expect(w.status()).toBe('blocked')
  })
  it("the current threads come from the house's one rule when given (currentOf)", () => {
    // a currentOf that still sees another live thread on the task
    const w = setup(task('t1', 'in_progress', { conversations: [S1] }), { currentOf: () => ['cccccccc-0003'] })
    expect(w.actions.appendRelease('plans', w.key, S1, true, {})).toMatchObject({ ok: true, value: { kept: 'in_progress' } })
    expect(w.status()).toBe('in_progress')
  })
  it('a task not in progress keeps its state (the done its agent already set is respected)', () => {
    const w = setup(task('t1', 'done', { conversations: [S1] }))
    expect(w.actions.appendRelease('plans', w.key, S1, true, {})).toMatchObject({ ok: true, value: { written: true, state: 'done', kept: 'done' } })
    expect(w.status()).toBe('done')
  })
  it('a mark already there: nothing written, kept + already — a second release with a state does not apply it', () => {
    const w = setup(task('t1', 'in_progress', { conversations: [S1], releases: [{ session: S1, released: true }] }))
    expect(w.actions.appendRelease('plans', w.key, S1, true, { state: 'done' })).toMatchObject({
      ok: true,
      value: { written: false, state: 'in_progress', kept: 'in_progress', already: 'released' },
    })
    expect(w.status()).toBe('in_progress')
  })
  it('a Plans without dispose (0.5.1): the mark only, the state kept', () => {
    const m = plansManifest()
    delete m.spec.actions.find((a: Json) => a.verb === 'release').dispose
    const w = setup(task('t1', 'in_progress', { conversations: [S1] }), { manifest: m })
    expect(w.actions.appendRelease('plans', w.key, S1, true, { state: 'done' })).toMatchObject({ ok: true, value: { written: true, kept: 'in_progress' } })
    expect(w.status()).toBe('in_progress')
  })
  it('a revive (released: false) never disposes', () => {
    const w = setup(task('t1', 'pending', { conversations: [S1], releases: [{ session: S1, released: true }] }))
    const r = w.actions.appendRelease('plans', w.key, S1, false, {})
    expect(r).toMatchObject({ ok: true, value: { written: true, state: 'pending' } })
    expect(r.ok && 'kept' in r.value).toBe(false)
  })
})

describe("label and the standing record's own row", () => {
  it("a backlog task paints <project>#t3, a named plan's <plan>#t3; the backlog's own row says standingList", () => {
    put('tasks.plan.json', { title: '', rotatedAt: '2026-11', tasks: [task('t3', 'pending')] })
    put('ship.plan.json', { title: 'Ship', tasks: [task('t1', 'pending')] })
    const w = world()
    w.kernel.refresh()
    const entry = w.registry.get('plans')!
    const ctx = { voice: { now: Date.now(), isAgent }, overlayKeys: new Set<string>(), conflictKeys: new Set<string>() }
    const tasks = recordsPage(entry, w.kernel.reading('plans'), ctx, { kind: 'plan/task', limit: 50 })
    if ('error' in tasks) throw new Error(tasks.error)
    expect(Object.fromEntries(tasks.records.map((r) => [r.key.split('/').slice(-3).join('/'), r.label]))).toEqual({
      'tasks/tasks/t3': 'acme#t3',
      'ship/tasks/t1': 'ship#t1',
    })
    const plans = recordsPage(entry, w.kernel.reading('plans'), ctx, { kind: 'plan', limit: 50 })
    if ('error' in plans) throw new Error(plans.error)
    expect(Object.fromEntries(plans.records.map((r) => [r.id, r.standingList ?? false]))).toEqual({ tasks: true, ship: false })
    expect(recordDetail(entry, w.kernel.reading('plans'), `${loc()}/tasks`, { voice: ctx.voice })!.record.standingList).toBe(true)
    // the ref stays the address everywhere: the key holds backlog
    expect(recordDetail(entry, w.kernel.reading('plans'), `${loc()}/tasks/tasks/t3`, { voice: ctx.voice })!.record).toMatchObject({
      key: `${loc()}/tasks/tasks/t3`,
      label: 'acme#t3',
    })
  })
  it('a project that also has a plan named like its folder: <project>/tasks#t3', () => {
    put('tasks.plan.json', { title: '', rotatedAt: '2026-11', tasks: [task('t3', 'pending')] })
    put('acme.plan.json', { title: 'Acme launch', tasks: [task('t3', 'pending')] })
    const w = world()
    w.kernel.refresh()
    const page = recordsPage(
      w.registry.get('plans')!,
      w.kernel.reading('plans'),
      { voice: { now: Date.now(), isAgent }, overlayKeys: new Set<string>(), conflictKeys: new Set<string>() },
      { kind: 'plan/task', limit: 50 },
    )
    if ('error' in page) throw new Error(page.error)
    expect(page.records.map((r) => r.label).sort()).toEqual(['acme#t3', 'acme/tasks#t3'])
  })
})
