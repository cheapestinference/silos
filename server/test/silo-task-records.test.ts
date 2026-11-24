// The generic record routes read a SUB-KIND's records whole (task-view
// phase 2): the Tasks view and
// a task's page read the plans silo's tasks through the same records/record
// routes every silo uses — never a plans-only route.
//   records  a sub-kind row carries its parent ({key, identity, at}) and, when
//            the kind declares roles.task, the kernel's task flow (waiting,
//            gate, unblocks, stalled, stalledCause, stalledBy) at request time;
//            ?values=1 adds the record as read and the moment the journal last
//            saw it move
//   record   a sub-kind key (<plan key>/tasks/<id>) answers like a top-level
//            one: its fields, its children (notes with append, conversations),
//            the actions of ITS kind (set-field status), its file's CAS
//            version, its flow and its journal story
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
import { siloFile } from './helpers/silo-manifests.js'

type Json = Record<string, any>
const plans = (): Json => JSON.parse(readFileSync(siloFile('plans'), 'utf8'))
const isAgent = (v: string): boolean => ['finance', 'writer'].includes(v)

let base: string
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'silo-task-records-'))
})
afterEach(() => rmSync(base, { recursive: true, force: true }))

function put(rel: string, v: unknown): string {
  const f = join(base, rel)
  mkdirSync(join(f, '..'), { recursive: true })
  writeFileSync(f, JSON.stringify(v))
  utimesSync(f, new Date(), new Date())
  return f
}

function setup(live: ReadonlySet<string> = new Set()) {
  const dataDir = join(base, 'data')
  const m = plans()
  mkdirSync(join(dataDir, 'silos', 'registry', 'plans'), { recursive: true })
  writeFileSync(join(dataDir, 'silos', 'registry', 'plans', 'silo.json'), JSON.stringify(m))
  const registry = new SiloRegistry({ dataDir, operator: { decisionFor: () => 'approved', slotsOff: () => [] } })
  registry.load()
  let now = Date.parse('2026-11-03T12:00:00Z')
  const journal = new TransitionJournal(registry.conventionsDir)
  const kernel = new SiloKernel({
    registry,
    journal,
    overlay: new OverlayStore(registry.conventionsDir),
    isAgent,
    now: () => now,
    reader: new SiloReader({ agentStates: () => [], projects: () => [join(base, 'proj')] }),
  })
  const surfaces = new SiloSurfaces({
    registry,
    kernel,
    journal,
    isAgent,
    taskEnv: { isLive: (s) => live.has(s), wakes: (a) => (a === 'writer' ? 'now' : 'never') },
    nameOf: (a) => a.toUpperCase(),
  })
  kernel.refresh()
  const entry = registry.get('plans')!
  const ctx = () => ({ voice: surfaces.voice('plans', now), overlayKeys: new Set<string>(), conflictKeys: new Set<string>(), journal })
  return {
    registry,
    kernel,
    journal,
    surfaces,
    entry,
    ctx,
    now: () => now,
    tick: (ms: number) => {
      now += ms
    },
  }
}

const SHIP = {
  title: 'Ship it',
  updatedAt: '2026-11-02T10:00:00Z',
  tasks: [
    { id: 't1', title: 'Write the README', owner: 'writer', status: 'done', dependsOn: [] },
    { id: 't2', title: 'Pick the org', owner: 'sam', status: 'pending', dependsOn: ['t1'] },
    { id: 't3', title: 'Fill package.json', owner: 'writer', status: 'blocked', dependsOn: ['t2'], parent: 't5' },
    { id: 't4', title: 'Video', owner: 'finance', status: 'cancelled', dependsOn: [] },
    {
      id: 't5',
      title: 'Release',
      owner: 'writer',
      status: 'in_progress',
      dependsOn: [],
      conversations: ['s-live'],
      notes: [{ at: '2026-11-02T09:00:00Z', by: 'writer', text: 'started' }],
    },
    { id: 't6', title: 'Announce', owner: 'finance', status: 'blocked', dependsOn: ['t4'] },
    { id: 't7', title: 'Check the page', owner: 'finance', status: 'in_review', dependsOn: [] },
  ],
}

describe('records of a sub-kind: parent, task flow, values', () => {
  it('each task row says its plan and its flow — the stalled chain names the first stuck task', () => {
    put('proj/plans/ship.plan.json', SHIP)
    const { entry, kernel, ctx } = setup(new Set(['s-live']))
    const page = recordsPage(entry, kernel.reading('plans'), ctx(), { kind: 'plan/task', limit: 200 })
    if ('error' in page) throw new Error(page.error)
    const by = new Map(page.records.map((r) => [r.id, r]))
    const planKey = `folder:${join(base, 'proj')}/ship`
    expect(by.get('t2')).toMatchObject({ key: `${planKey}/tasks/t2`, parent: { key: planKey, identity: 'Ship it', at: '2026-11-02T10:00:00Z' } })
    expect(by.get('t2')!.flow).toMatchObject({ gate: true, unblocks: [{ id: 't3', owner: 'writer' }], stalled: false })
    // sam is a person other than the owner: the row says it is theirs (E8)
    expect(by.get('t2')!.row).toBe("SAM's Pick the org — pending · unblocks 1 task of WRITER")
    // the label paints a named plan's task as its ref (E7)
    expect(by.get('t2')!.label).toBe('ship#t2')
    // a cancelled blocker never resolves; an agent's review nobody holds
    expect(by.get('t6')!.flow).toMatchObject({ stalled: true, stalledCause: 'blocker-cancelled', stalledBy: 't4' })
    expect(by.get('t7')!.flow).toMatchObject({ stalled: true, stalledCause: 'review-without-reviewer', stalledBy: 't7' })
    // live: its conversation is live (the injected live fact)
    expect(by.get('t5')!.flow).toMatchObject({ stalled: false })
    // a live conversation guards an in-progress task whose owner never wakes
    // (conversations[] is what the flow reads; a loose `conversation` is none)
    put('proj/plans/live.plan.json', {
      title: 'Live',
      tasks: [
        { id: 'a', title: 'A', owner: 'finance', status: 'in_progress', dependsOn: [], conversations: ['s-live'] },
        { id: 'b', title: 'B', owner: 'finance', status: 'in_progress', dependsOn: [], conversations: [{ session: 's-live' }] },
        { id: 'c', title: 'C', owner: 'finance', status: 'in_progress', dependsOn: [], conversations: ['s-dead'] },
      ],
    })
    kernel.refresh()
    const lp = recordsPage(entry, kernel.reading('plans'), ctx(), { kind: 'plan/task', limit: 200, file: join(base, 'proj/plans/live.plan.json') })
    if ('error' in lp) throw new Error(lp.error)
    // …and with nothing live it is the owner's turn to continue it there
    // (waitsStart — never «Stalled»)
    expect(lp.records.map((r) => [r.id, r.flow!.stalled, r.flow!.waitsStart])).toEqual(
      expect.arrayContaining([
        ['a', false, false],
        ['b', false, false],
        ['c', false, true],
      ]),
    )
    // the record itself only when asked
    expect(by.get('t5')!.value).toBeUndefined()
  })

  it('?values: the record as read (notes and conversations lifted) and when the journal last saw it move', () => {
    put('proj/plans/ship.plan.json', SHIP)
    const { entry, kernel, ctx, tick } = setup()
    tick(60_000)
    const f = join(base, 'proj/plans/ship.plan.json')
    put('proj/plans/ship.plan.json', { ...SHIP, tasks: SHIP.tasks.map((t) => (t.id === 't2' ? { ...t, status: 'done' } : t)) })
    void f
    kernel.refresh()
    const page = recordsPage(entry, kernel.reading('plans'), ctx(), { kind: 'plan/task', limit: 200, values: true })
    if ('error' in page) throw new Error(page.error)
    const t5 = page.records.find((r) => r.id === 't5')!
    expect(t5.value).toMatchObject({
      owner: 'writer',
      state: 'in_progress',
      conversations: [{ session: 's-live' }],
      notes: [{ by: 'writer', text: 'started' }],
    })
    const t2 = page.records.find((r) => r.id === 't2')!
    expect(t2.moved).toBe('2026-11-03T12:01:00.000Z')
    // a record the journal only saw at its first look has no move: the
    // baseline is when Silos looked, not when the task did anything
    expect(t5.moved).toBeNull()
  })

  it('a top-level kind carries no parent and no flow (support, invoices unchanged)', () => {
    put('proj/plans/ship.plan.json', SHIP)
    const { entry, kernel, ctx } = setup()
    const page = recordsPage(entry, kernel.reading('plans'), ctx(), {})
    if ('error' in page) throw new Error(page.error)
    expect(page.records[0]!.parent).toBeUndefined()
    expect(page.records[0]!.flow).toBeUndefined()
  })
})

describe('one sub-kind record by its key', () => {
  it("answers with its fields, children, its kind's actions, the file's version, its flow and its parent", () => {
    put('proj/plans/ship.plan.json', SHIP)
    const { entry, kernel, ctx, journal } = setup(new Set(['s-live']))
    const planKey = `folder:${join(base, 'proj')}/ship`
    const d = recordDetail(entry, kernel.reading('plans'), `${planKey}/tasks/t5`, { voice: ctx().voice, journal })
    expect(d).not.toBeNull()
    expect(d!.kind.name).toBe('plans/plan/task')
    expect(d!.record).toMatchObject({ id: 't5', identity: 'Release', state: 'in_progress' })
    expect(d!.parent).toEqual({ key: planKey, kind: 'plan', identity: 'Ship it', at: '2026-11-02T10:00:00Z' })
    expect(d!.flow).toMatchObject({ stalled: false, gate: false })
    // the plan file's CAS version — the same the plan's own record carries
    const plan = recordDetail(entry, kernel.reading('plans'), planKey, { voice: ctx().voice, journal })!
    expect(d!.version).toBe(plan.version)
    expect(d!.version).toMatch(/^[0-9a-f]{64}$/)
    // its kind's actions: set-field on status (the owner's), not the plan's write
    expect(d!.actions.map((a) => a.verb)).toContain('set-field')
    const fields = d!.actions.find((a) => a.verb === 'set-field')!.fields
    expect(fields[0]).toEqual({ name: 'status', values: ['pending', 'in_progress', 'in_review', 'blocked', 'done', 'cancelled'] })
    // plans 0.2.2: the one-shot next check is clearable by the owner's side (task mode clears it)
    // 0.2.3: the escalation's wait, written by Silos for the owner; 0.6.1: dependsOn — the owner removes a dropped blocker
    expect(fields.map((f) => f.name)).toEqual(['status', 'dependsOn', 'nextCheckAt', 'waitingOn'])
    expect(d!.actions.map((a) => a.verb)).not.toContain('agent-record-write')
    // its children: notes (the owner may append) and conversations
    const notes = d!.children.find((c) => c.collection === 'notes')!
    expect(notes.rows).toEqual([expect.objectContaining({ identity: 'started', by: 'writer', at: '2026-11-02T09:00:00Z' })])
    expect(notes.append).toEqual({ fields: [{ name: 'text', required: true, max: 8000 }] })
    expect(d!.children.find((c) => c.collection === 'conversations')!.rows).toEqual([expect.objectContaining({ id: 's-live' })])
    expect(d!.value).toMatchObject({ id: 't5', owner: 'writer' })
    expect('parent' in d!.value).toBe(false)
    // its journal story is its own key's
    expect(d!.history.every((l) => l.key === undefined || l.key === `${planKey}/tasks/t5`)).toBe(true)
    expect(d!.history.some((l) => l.key === `${planKey}/tasks/t5`)).toBe(true)
  })

  it('an unknown task of a known plan, or a key nothing reads, is null', () => {
    put('proj/plans/ship.plan.json', SHIP)
    const { entry, kernel, ctx } = setup()
    const planKey = `folder:${join(base, 'proj')}/ship`
    expect(recordDetail(entry, kernel.reading('plans'), `${planKey}/tasks/t99`, { voice: ctx().voice })).toBeNull()
    expect(recordDetail(entry, kernel.reading('plans'), `${planKey}/nope/t1`, { voice: ctx().voice })).toBeNull()
  })
})
