// «A task never needs a plan» (tasks-conversations t3, plans 0.5.0): every
// project has ONE standing list, plans/tasks.plan.json — a reserved name
// whose plan is always active (never `all(done)`), made by the kernel's
// owner-only ensure-record verb when New task needs it, and rotated monthly:
// old finished tasks leave for plans/closed/tasks-<month>.plan.json, their
// ids retired (never reused). Run over the REAL reference manifest.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SiloRegistry } from '../src/silos/registry.js'
import { SiloReader } from '../src/silos/reader.js'
import { SiloKernel } from '../src/silos/kernel.js'
import { TransitionJournal } from '../src/silos/journal.js'
import { OverlayStore } from '../src/silos/overlay.js'
import { SiloActions, SiloAcks, SiloEvents, SiloProposals } from '../src/silos/actions.js'
import { validateSilo } from '../src/silos/validator.js'
import { plansManifest } from './helpers/plans-silo.js'

type Json = Record<string, any>
const isAgent = (v: string): boolean => ['writer', 'finance'].includes(v)

let base: string
let proj: string
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'silo-standing-'))
  proj = join(base, 'proj')
  mkdirSync(proj, { recursive: true })
})
afterEach(() => rmSync(base, { recursive: true, force: true }))

function setup(now = '2026-11-08T10:00:00Z', projects: () => string[] = () => [proj]) {
  const dataDir = join(base, 'data')
  mkdirSync(join(dataDir, 'silos', 'registry', 'plans'), { recursive: true })
  writeFileSync(join(dataDir, 'silos', 'registry', 'plans', 'silo.json'), JSON.stringify(plansManifest()))
  const registry = new SiloRegistry({ dataDir, operator: { decisionFor: () => 'approved', slotsOff: () => [] } })
  registry.load()
  const kernel = new SiloKernel({
    registry,
    journal: new TransitionJournal(registry.conventionsDir),
    overlay: new OverlayStore(registry.conventionsDir),
    isAgent,
    reader: new SiloReader({ agentStates: () => [], projects }),
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
    locations: { projects },
    now: () => new Date(now),
  })
  return { actions, kernel, events }
}
const backlog = (): string => join(proj, 'plans', 'tasks.plan.json')
const read = (f: string): Json => JSON.parse(readFileSync(f, 'utf8'))
const put = (name: string, v: Json): void => {
  mkdirSync(join(proj, 'plans'), { recursive: true })
  writeFileSync(join(proj, 'plans', name), JSON.stringify(v, null, 2))
}
const task = (id: string, status: string, extra: Json = {}): Json => ({ id, title: `task ${id}`, owner: 'writer', status, dependsOn: [], ...extra })
const loc = (): string => `folder:${proj}`

describe('the reference manifest (plans 0.8.2)', () => {
  it('validates, and declares ensure-record for the reserved list, owner-only', () => {
    const m = plansManifest()
    expect((m.metadata as Json).version).toBe('0.8.2')
    const r = validateSilo(m)
    expect(r.errors).toEqual([])
    const a = ((m.spec as Json).actions as Json[]).find((x) => x.verb === 'ensure-record')
    expect(a).toMatchObject({ kind: 'plan', id: 'tasks', by: ['owner'] })
  })
})

describe('the state rule — the standing list never finishes', () => {
  it('a backlog whose every task is done is still active; any other such plan is done', () => {
    put('tasks.plan.json', { title: 'Tasks', tasks: [task('t1', 'done'), task('t2', 'cancelled')] })
    put('ship.plan.json', { title: 'Ship', tasks: [task('t1', 'done')] })
    const { kernel } = setup()
    const states = Object.fromEntries(kernel.reading('plans')!.records.map((r) => [r.record.id, r.record.state]))
    expect(states).toEqual({ tasks: 'active', ship: 'done' })
  })
  it('an empty backlog is active too', () => {
    put('tasks.plan.json', { title: 'Tasks', tasks: [] })
    const { kernel } = setup()
    expect(kernel.reading('plans')!.records[0]!.record.state).toBe('active')
  })
  it('an empty NAMED plan is active — nothing finished, nothing to close (plans 0.8.2)', () => {
    put('ship.plan.json', { title: 'Ship', tasks: [] })
    const { kernel } = setup()
    expect(kernel.reading('plans')!.records[0]!.record.state).toBe('active')
  })
})

describe("ensure-record — the project's standing list exists when New task needs it", () => {
  it('makes plans/tasks.plan.json from the seed in a project with no plans, stamped this month', () => {
    const { actions, kernel, events } = setup()
    const r = actions.ensureRecord('plans', loc(), 'tasks')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value).toMatchObject({ key: `${loc()}/tasks`, created: true, rotated: [] })
    expect(read(backlog())).toEqual({ title: '', tasks: [], rotatedAt: '2026-11' })
    expect(kernel.reading('plans')!.records.map((x) => x.record.id)).toEqual(['tasks'])
    expect(events.list('plans').map((e) => e.verb)).toContain('ensure-record')
    // and a task can be appended right away
    expect(actions.appendItem('plans', r.value.key, 'tasks', { id: 't1', title: 'one', owner: 'writer' }).ok).toBe(true)
    expect(read(backlog()).tasks.map((t: Json) => t.id)).toEqual(['t1'])
  })
  it('never rewrites a list that exists — the second ensure answers it as it is', () => {
    put('tasks.plan.json', { title: 'Mine', rotatedAt: '2026-11', tasks: [task('t1', 'pending')] })
    const before = readFileSync(backlog(), 'utf8')
    const { actions } = setup()
    const r = actions.ensureRecord('plans', loc(), 'tasks')
    expect(r.ok && r.value.created).toBe(false)
    expect(readFileSync(backlog(), 'utf8')).toBe(before)
  })
  it('a file the reading missed (an agent just wrote it) is kept, never replaced', () => {
    const { actions } = setup()
    put('tasks.plan.json', { title: 'Agent-made', rotatedAt: '2026-11', tasks: [task('t5', 'pending')] })
    const r = actions.ensureRecord('plans', loc(), 'tasks')
    expect(r.ok && r.value.created).toBe(false)
    expect(read(backlog()).title).toBe('Agent-made')
  })
  it('refuses a folder Silos does not read, an id the manifest does not reserve, and a non-folder location', () => {
    const { actions } = setup()
    const other = join(base, 'elsewhere')
    mkdirSync(other)
    expect(actions.ensureRecord('plans', `folder:${other}`, 'tasks')).toMatchObject({ ok: false, code: 404 })
    expect(existsSync(join(other, 'plans'))).toBe(false)
    expect(actions.ensureRecord('plans', loc(), 'ship')).toMatchObject({ ok: false, code: 403 })
    expect(actions.ensureRecord('plans', 'agent:writer', 'tasks')).toMatchObject({ ok: false, code: 400 })
    expect(existsSync(backlog())).toBe(false)
  })
  it('a backlog that does not read as a plan is said, never overwritten', () => {
    put('tasks.plan.json', { tasks: 'nope' } as Json)
    const before = readFileSync(backlog(), 'utf8')
    const { actions } = setup()
    expect(actions.ensureRecord('plans', loc(), 'tasks')).toMatchObject({ ok: false, code: 409 })
    expect(readFileSync(backlog(), 'utf8')).toBe(before)
  })
})

describe('the monthly rotation — the list never closes, its old finished tasks leave', () => {
  it('in a new month: finished tasks go to plans/closed/tasks-<last month>, written first; ids retired; the open stay', () => {
    put('tasks.plan.json', {
      title: 'Tasks',
      rotatedAt: '2026-10',
      tasks: [task('t1', 'done'), task('t2', 'pending'), task('t3', 'cancelled'), task('t4', 'in_progress')],
    })
    const { actions } = setup('2026-11-02T08:00:00Z')
    const r = actions.ensureRecord('plans', loc(), 'tasks')
    expect(r.ok && r.value.rotated.sort()).toEqual(['t1', 't3'])
    const live = read(backlog())
    expect(live.tasks.map((t: Json) => t.id)).toEqual(['t2', 't4'])
    expect(live.retired).toEqual(['t1', 't3'])
    expect(live.rotatedAt).toBe('2026-11')
    const arch = read(join(proj, 'plans', 'closed', 'tasks-2026-10.plan.json'))
    expect(arch.tasks.map((t: Json) => t.id)).toEqual(['t1', 't3'])
    expect(arch.rotatedFrom).toBe('tasks')
  })
  it('keeps a finished task an open one still names — a done blocker, a parent that groups — to a fixpoint', () => {
    put('tasks.plan.json', {
      title: 'Tasks',
      rotatedAt: '2026-10',
      tasks: [
        task('t1', 'done'),
        task('t2', 'done', { parent: 't1' }),
        task('t3', 'pending', { parent: 't2' }),
        task('t4', 'done'),
        task('t5', 'pending', { dependsOn: ['t4'] }),
        task('t6', 'done'),
      ],
    })
    const { actions } = setup()
    const r = actions.ensureRecord('plans', loc(), 'tasks')
    expect(r.ok && r.value.rotated).toEqual(['t6'])
    expect(read(backlog()).tasks.map((t: Json) => t.id)).toEqual(['t1', 't2', 't3', 't4', 't5'])
  })
  it('the same month: nothing moves and nothing is written', () => {
    put('tasks.plan.json', { title: 'Tasks', rotatedAt: '2026-11', tasks: [task('t1', 'done')] })
    const before = readFileSync(backlog(), 'utf8')
    const { actions } = setup()
    expect(actions.ensureRecord('plans', loc(), 'tasks')).toMatchObject({ ok: true, value: { rotated: [] } })
    expect(readFileSync(backlog(), 'utf8')).toBe(before)
  })
  it('a list without a stamp (an agent made it) rotates on its first ensure', () => {
    put('tasks.plan.json', { title: 'Tasks', tasks: [task('t1', 'done'), task('t2', 'pending')] })
    const { actions } = setup()
    expect(actions.ensureRecord('plans', loc(), 'tasks')).toMatchObject({ ok: true, value: { rotated: ['t1'] } })
  })
  it('an archive already there is joined by id, never replaced', () => {
    mkdirSync(join(proj, 'plans', 'closed'), { recursive: true })
    writeFileSync(join(proj, 'plans', 'closed', 'tasks-2026-10.plan.json'), JSON.stringify({ title: 'old', tasks: [task('t1', 'done')] }))
    put('tasks.plan.json', { title: 'Tasks', rotatedAt: '2026-10', retired: ['t1'], tasks: [task('t2', 'done')] })
    const { actions } = setup()
    expect(actions.ensureRecord('plans', loc(), 'tasks').ok).toBe(true)
    const arch = read(join(proj, 'plans', 'closed', 'tasks-2026-10.plan.json'))
    expect([arch.title, arch.tasks.map((t: Json) => t.id)]).toEqual(['old', ['t1', 't2']])
    expect(read(backlog()).retired).toEqual(['t1', 't2'])
  })
  it('a retired id is never reused — append-item refuses it (409)', () => {
    put('tasks.plan.json', { title: 'Tasks', rotatedAt: '2026-10', tasks: [task('t1', 'done'), task('t2', 'pending')] })
    const { actions } = setup()
    const r = actions.ensureRecord('plans', loc(), 'tasks')
    expect(r.ok).toBe(true)
    const dup = actions.appendItem('plans', `${loc()}/tasks`, 'tasks', { id: 't1', title: 'again', owner: 'writer' })
    expect(dup).toMatchObject({ ok: false, code: 409 })
    expect(actions.appendItem('plans', `${loc()}/tasks`, 'tasks', { id: 't3', title: 'new', owner: 'writer' }).ok).toBe(true)
  })
  it('an archive that is not JSON stops the rotation before anything moves', () => {
    mkdirSync(join(proj, 'plans', 'closed'), { recursive: true })
    writeFileSync(join(proj, 'plans', 'closed', 'tasks-2026-10.plan.json'), '{nope')
    put('tasks.plan.json', { title: 'Tasks', rotatedAt: '2026-10', tasks: [task('t1', 'done')] })
    const before = readFileSync(backlog(), 'utf8')
    const { actions } = setup()
    expect(actions.ensureRecord('plans', loc(), 'tasks')).toMatchObject({ ok: false, code: 409 })
    expect(readFileSync(backlog(), 'utf8')).toBe(before)
  })
  it('the archive is never read as a live plan', () => {
    put('tasks.plan.json', { title: 'Tasks', rotatedAt: '2026-10', tasks: [task('t1', 'done')] })
    const { actions, kernel } = setup()
    expect(actions.ensureRecord('plans', loc(), 'tasks').ok).toBe(true)
    kernel.refresh()
    expect(kernel.reading('plans')!.records.map((r) => r.record.id)).toEqual(['tasks'])
  })
})
