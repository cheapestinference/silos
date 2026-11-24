// Creating a task through the kernel: append-item on
// plan/task births a WHOLE child — envelope id (required, never reused) and
// state (declared values only, first one by default) beside the declared
// fields — and the create→note choreography is what wakes a bound owner:
// the first look at a new task is a baseline that fires nothing (evaluate
// under `if (was)`), the owner note that follows fires owner-note.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SiloRegistry } from '../src/silos/registry.js'
import { SiloReader } from '../src/silos/reader.js'
import { SiloKernel } from '../src/silos/kernel.js'
import { TransitionJournal } from '../src/silos/journal.js'
import { OverlayStore } from '../src/silos/overlay.js'
import { SiloActions, SiloAcks, SiloEvents, SiloProposals } from '../src/silos/actions.js'
import { evaluateTaskWakes } from '../src/task-mode/evaluate.js'
import { taskSnapshots } from '../src/task-mode/engine.js'

type Json = Record<string, any>
const STATES = ['pending', 'in_progress', 'in_review', 'blocked', 'done', 'cancelled']
const isAgent = (v: string): boolean => ['writer', 'finance'].includes(v)

function manifest(): Json {
  return {
    apiVersion: 'silo-standard/v0',
    metadata: { id: 'todo', version: '0.1.0', name: 'Todo', description: 'task fixture' },
    spec: {
      producer: { role: 'writer', instructions: { summary: 'writes plans', protocol: ['one file per plan'] } },
      sources: [{ id: 'plans', type: 'files', root: 'project', glob: 'todo/*.plan.json', parser: 'json', expects: { producer: 'agent' } }],
      kinds: {
        plan: {
          envelope: {
            id: { from: 'filename' },
            identity: { template: '{{title}}' },
            state: { computed: 'all(tasks, state in [done, cancelled]) ? done : active' },
            at: { field: 'updatedAt' },
            anchors: [{ hub: 'folder', from: 'location' }],
            updatedBy: { absent: 'unknown' },
          },
          states: [
            { value: 'active', label: { one: 'active', many: 'active' } },
            { value: 'done', label: { one: 'done', many: 'done' }, terminal: true },
          ],
          fields: { title: { type: 'string', required: true }, updatedAt: { type: 'timestamp', required: true } },
          unknownFields: 'preserve',
          subKinds: {
            task: {
              path: 'tasks[]',
              envelope: {
                id: { field: 'id' },
                identity: { template: '{{title}}' },
                state: { field: 'status' },
                at: { inherit: 'parent.at' },
                updatedBy: { absent: 'unknown' },
              },
              states: STATES.map((v) => ({ value: v, label: { one: v, many: v }, ...(v === 'done' || v === 'cancelled' ? { terminal: true } : {}) })),
              roles: { task: { owner: 'owner', dependsOn: 'dependsOn' } },
              fields: {
                title: { type: 'string', required: true },
                owner: { type: 'actor', required: true },
                dependsOn: { type: 'refs(task)', withinParent: true },
              },
              subKinds: {
                note: {
                  path: 'notes[]',
                  appendOnly: true,
                  envelope: { identity: { template: '{{text}}' }, at: { field: 'at', mayBeEmpty: true }, updatedBy: { field: 'by' } },
                  fields: { text: { type: 'string', required: true, max: 8000 } },
                },
              },
            },
          },
          examples: [
            {
              _file: 'a.plan.json',
              title: 'A',
              updatedAt: '2026-11-01',
              tasks: [{ id: 't1', title: 'one', owner: 'writer', status: 'pending', dependsOn: [] }],
            },
          ],
        },
      },
      surfaces: {},
      actions: [
        { verb: 'set-field', subKind: 'plan/task', fields: { status: { writableBy: 'owner' } } },
        { verb: 'append-item', subKind: 'plan/task', by: ['owner'] },
        { verb: 'append-item', subKind: 'plan/task/note', by: ['owner', 'producer'] },
        { verb: 'open' },
      ],
    },
  }
}

let base: string
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'silo-task-create-'))
})
afterEach(() => rmSync(base, { recursive: true, force: true }))

function setup() {
  const dataDir = join(base, 'data')
  mkdirSync(join(dataDir, 'silos', 'registry', 'todo'), { recursive: true })
  writeFileSync(join(dataDir, 'silos', 'registry', 'todo', 'silo.json'), JSON.stringify(manifest()))
  const registry = new SiloRegistry({ dataDir, operator: { decisionFor: () => 'approved', slotsOff: () => [] } })
  registry.load()
  const kernel = new SiloKernel({
    registry,
    journal: new TransitionJournal(registry.conventionsDir),
    overlay: new OverlayStore(registry.conventionsDir),
    isAgent,
    reader: new SiloReader({ agentStates: () => [], projects: () => [join(base, 'proj')] }),
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
  return { actions, kernel }
}
const file = (): string => join(base, 'proj', 'todo', 'p.plan.json')
function put(tasks: Json[]): void {
  mkdirSync(join(file(), '..'), { recursive: true })
  writeFileSync(file(), JSON.stringify({ title: 'P', updatedAt: '2026-11-01', tasks }, null, 2))
}
const planKey = (): string => `folder:${join(base, 'proj')}/p`

describe('append-item on plan/task — a task is born whole', () => {
  it('writes id, title, owner, the DEFAULT first state and the at stamp; the engine sees it', () => {
    put([{ id: 't1', title: 'one', owner: 'writer', status: 'pending', dependsOn: [] }])
    const { actions, kernel } = setup()
    const r = actions.appendItem('todo', planKey(), 'tasks', { id: 't2', title: 'new one', owner: 'writer' })
    expect(r.ok).toBe(true)
    const raw = JSON.parse(readFileSync(file(), 'utf8'))
    const born = raw.tasks.find((x: Json) => x.id === 't2')
    expect(born).toMatchObject({ id: 't2', title: 'new one', owner: 'writer', status: 'pending' })
    const reading = kernel.reading('todo')!
    const snaps = taskSnapshots(reading)
    expect(snaps.map((s) => s.id)).toContain('t2')
    // the ref: `<plan>#t2`; a reserved (standing) plan's task reads as the
    // screen paints it, `<project>#t2`
    expect(snaps.find((s) => s.id === 't2')!.ref).toBe('p#t2')
    expect(taskSnapshots(reading, undefined, undefined, new Set(['p'])).find((s) => s.id === 't2')!.ref).toBe('proj#t2')
  })
  it('refuses a missing id, a reused id, and an undeclared state', () => {
    put([{ id: 't1', title: 'one', owner: 'writer', status: 'pending', dependsOn: [] }])
    const { actions } = setup()
    const noId = actions.appendItem('todo', planKey(), 'tasks', { title: 'x', owner: 'writer' })
    expect(noId.ok).toBe(false)
    if (!noId.ok) expect(noId.reason).toContain('id is required')
    const dup = actions.appendItem('todo', planKey(), 'tasks', { id: 't1', title: 'x', owner: 'writer' })
    expect(dup.ok).toBe(false)
    if (!dup.ok) expect([dup.code, dup.reason.includes('never reused')]).toEqual([409, true])
    const badState = actions.appendItem('todo', planKey(), 'tasks', { id: 't9', title: 'x', owner: 'writer', status: 'doing' })
    expect(badState.ok).toBe(false)
    if (!badState.ok) expect(badState.reason).toContain('must be one of')
  })
})

describe('the create→note choreography wakes a bound owner (the tested coupling the contrarian demanded)', () => {
  it('the first look at a NEW task is a baseline (no wake); the owner note that follows fires owner-note', () => {
    put([])
    const { actions, kernel } = setup()
    const bound = new Set(['writer'])
    const T0 = Date.parse('2026-11-08T10:00:00Z')
    // look 0: empty plan — the baseline before the create
    let prev = evaluateTaskWakes({ tasks: taskSnapshots(kernel.reading('todo')!), bound, prev: {}, now: T0 }).observations
    // create: the task appears; the NEXT look baselines it and fires nothing
    expect(actions.appendItem('todo', planKey(), 'tasks', { id: 't1', title: 'new one', owner: 'writer' }).ok).toBe(true)
    const look1 = evaluateTaskWakes({ tasks: taskSnapshots(kernel.reading('todo')!), bound, prev, now: T0 + 1000 })
    expect(look1.wakes).toEqual([])
    prev = look1.observations
    // the description lands as the owner's first note: owner-note fires
    expect(actions.appendItem('todo', `${planKey()}/tasks/t1`, 'notes', { text: 'make it orange' }).ok).toBe(true)
    const look2 = evaluateTaskWakes({ tasks: taskSnapshots(kernel.reading('todo')!), bound, prev, now: T0 + 2000 })
    expect(look2.wakes.map((w) => [w.reason, w.agent])).toEqual([['owner-note', 'writer']])
  })
})
