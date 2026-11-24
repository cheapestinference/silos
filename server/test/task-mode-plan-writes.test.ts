// task-mode-plan-writes.test.ts — the two writes task mode asks of the plans
// silo (plans 0.2.2), through the kernel's own verbs on the REAL reference
// manifest: «Work on this» appends its conversation to a task's
// conversations[] — written as the skill writes it (a session id string),
// never materializing the list, idempotent — and a fired next check is
// cleared (set-field nextCheckAt, clearable). Notes keep their object form.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SiloRegistry } from '../src/silos/registry.js'
import { SiloReader } from '../src/silos/reader.js'
import { SiloKernel } from '../src/silos/kernel.js'
import { TransitionJournal } from '../src/silos/journal.js'
import { OverlayStore } from '../src/silos/overlay.js'
import { SiloActions, SiloAcks, SiloEvents, SiloProposals } from '../src/silos/actions.js'

type Json = Record<string, any>
const REF = join(import.meta.dirname, '..', '..', 'docs', 'standard', 'reference', 'plans.silo.json')

let base: string
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'task-mode-writes-'))
})
afterEach(() => rmSync(base, { recursive: true, force: true }))

function setup(tasks: Json[]) {
  const proj = join(base, 'proj')
  const f = join(proj, 'plans', 'p.plan.json')
  mkdirSync(join(f, '..'), { recursive: true })
  writeFileSync(f, JSON.stringify({ title: 'P', updatedAt: '2026-11-01', tasks }, null, 2))
  const dataDir = join(base, 'data')
  mkdirSync(join(dataDir, 'silos', 'registry', 'plans'), { recursive: true })
  writeFileSync(join(dataDir, 'silos', 'registry', 'plans', 'silo.json'), readFileSync(REF, 'utf8'))
  const registry = new SiloRegistry({ dataDir, operator: { decisionFor: () => 'approved', slotsOff: () => [] } })
  registry.load()
  const isAgent = (v: string): boolean => v === 'writer'
  const kernel = new SiloKernel({
    registry,
    journal: new TransitionJournal(registry.conventionsDir),
    overlay: new OverlayStore(registry.conventionsDir),
    isAgent,
    reader: new SiloReader({ agentStates: () => [], projects: () => [proj] }),
  })
  kernel.refresh()
  const actions = new SiloActions({
    registry,
    kernel,
    events: new SiloEvents(registry.root),
    acks: new SiloAcks(registry.root),
    proposals: new SiloProposals(registry.root),
    agentStateBase: join(dataDir, 'agent-state'),
    isAgent,
    agentMayReadLocation: () => false,
  })
  const key = (id: string): string => `folder:${proj}/p/tasks/${id}`
  const file = (): Json => JSON.parse(readFileSync(f, 'utf8'))
  return { actions, key, file, f }
}
const t = (id: string, over: Json = {}): Json => ({ id, title: `Task ${id}`, owner: 'writer', status: 'pending', dependsOn: [], ...over })

describe('append-item plan/task/conversation — an identity child is written as its id', () => {
  it('a list of strings stays strings; the new id goes last', () => {
    const w = setup([t('t1', { conversations: ['aaaaaaaa-0001'] })])
    const r = w.actions.appendItem('plans', w.key('t1'), 'conversations', { session: 'bbbbbbbb-0002' })
    expect(r.ok).toBe(true)
    expect(w.file().tasks[0].conversations).toEqual(['aaaaaaaa-0001', 'bbbbbbbb-0002'])
  })
  it('idempotent: an id already there writes nothing', () => {
    const w = setup([t('t1', { conversations: ['aaaaaaaa-0001'] })])
    const before = statSync(w.f).mtimeMs
    expect(w.actions.appendItem('plans', w.key('t1'), 'conversations', { session: 'aaaaaaaa-0001' }).ok).toBe(true)
    expect(statSync(w.f).mtimeMs).toBe(before)
    expect(w.file().tasks[0].conversations).toEqual(['aaaaaaaa-0001'])
  })
  it('a loose `conversation` is no conversation: the list is made of the appended id alone; the loose field rides along untouched', () => {
    const w = setup([t('t1', { conversation: 'aaaaaaaa-0001' })])
    expect(w.actions.appendItem('plans', w.key('t1'), 'conversations', { session: 'bbbbbbbb-0002' }).ok).toBe(true)
    expect(w.file().tasks[0]).toMatchObject({ conversation: 'aaaaaaaa-0001', conversations: ['bbbbbbbb-0002'] })
  })
  it('no list at all: a list of one string', () => {
    const w = setup([t('t1')])
    expect(w.actions.appendItem('plans', w.key('t1'), 'conversations', { session: 'bbbbbbbb-0002' }).ok).toBe(true)
    expect(w.file().tasks[0].conversations).toEqual(['bbbbbbbb-0002'])
  })
  it('a list of objects gets an object', () => {
    const w = setup([t('t1', { conversations: [{ session: 'aaaaaaaa-0001' }] })])
    expect(w.actions.appendItem('plans', w.key('t1'), 'conversations', { session: 'bbbbbbbb-0002' }).ok).toBe(true)
    expect(w.file().tasks[0].conversations).toEqual([{ session: 'aaaaaaaa-0001' }, { session: 'bbbbbbbb-0002' }])
  })
  it('notes keep their object form ({at, by, text})', () => {
    const w = setup([t('t1', { notes: [{ at: '2026-11-01T00:00:00Z', by: 'writer', text: 'started' }] })])
    expect(w.actions.appendItem('plans', w.key('t1'), 'notes', { text: 'go on' }).ok).toBe(true)
    const notes = w.file().tasks[0].notes
    expect(notes).toHaveLength(2)
    expect(notes[1]).toMatchObject({ by: 'owner', text: 'go on' })
  })
})

describe('set-field dependsOn — the owner removes a dropped blocker (plans 0.6.1)', () => {
  it("a subset of the task's own siblings is written; nothing else moves", () => {
    const w = setup([t('a', { status: 'cancelled' }), t('b'), t('c', { status: 'blocked', dependsOn: ['a', 'b'] })])
    expect(w.actions.setField('plans', w.key('c'), 'dependsOn', ['b']).ok).toBe(true)
    expect(w.file().tasks[2]).toEqual(t('c', { status: 'blocked', dependsOn: ['b'] }))
    expect(w.actions.setField('plans', w.key('c'), 'dependsOn', []).ok).toBe(true)
    expect(w.file().tasks[2].dependsOn).toEqual([])
  })
  it('judged before the write: not a list, an id no sibling has, or the task itself → 400, nothing written', () => {
    const w = setup([t('a'), t('c', { dependsOn: ['a'] })])
    const before = readFileSync(w.f, 'utf8')
    expect(w.actions.setField('plans', w.key('c'), 'dependsOn', 'a')).toMatchObject({ ok: false, code: 400 })
    expect(w.actions.setField('plans', w.key('c'), 'dependsOn', ['zz'])).toMatchObject({
      ok: false,
      code: 400,
      reason: 'dependsOn names zz — not another task of this plan',
    })
    expect(w.actions.setField('plans', w.key('c'), 'dependsOn', ['c'])).toMatchObject({ ok: false, code: 400 })
    expect(w.actions.setField('plans', w.key('c'), 'dependsOn', null)).toMatchObject({ ok: false, code: 400 })
    expect(readFileSync(w.f, 'utf8')).toBe(before)
  })
})

describe('set-field nextCheckAt — the one-shot clears it', () => {
  it('null removes the field; nothing else in the task moves', () => {
    const w = setup([t('t1', { status: 'in_review', nextCheckAt: '2026-11-03T09:00:00Z', notes: [{ at: 'x', by: 'writer', text: 'n' }] })])
    const before = w.file().tasks[0]
    expect(w.actions.setField('plans', w.key('t1'), 'nextCheckAt', null).ok).toBe(true)
    const { nextCheckAt: _gone, ...rest } = before
    expect(w.file().tasks[0]).toEqual(rest)
  })
})
