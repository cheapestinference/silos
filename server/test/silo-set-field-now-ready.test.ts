// set-field's nowReady (plans phase 1, G6 — the kernel half): when the owner
// moves a task's state, the answer names the sibling tasks that became ready
// by it (ready after, not before) — what the native Done/Drop route reported
// as `unblocked`. Nothing is recomputed into the file: only the field the
// owner set is written (the producer keeps its statuses; `ready` is read).
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

type Json = Record<string, any>
const STATES = ['pending', 'in_progress', 'in_review', 'blocked', 'done', 'cancelled']
function manifest(withRole = true): Json {
  return {
    apiVersion: 'silo-standard/v0',
    metadata: { id: 'chores', version: '0.1.0', name: 'Chores', description: 'task fixture' },
    spec: {
      producer: { role: 'writer', instructions: { summary: 'writes plans', protocol: ['one file per plan'] } },
      sources: [{ id: 'plans', type: 'files', root: 'project', glob: 'chores/*.plan.json', parser: 'json', expects: { producer: 'agent' } }],
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
              ...(withRole ? { roles: { task: { owner: 'owner', dependsOn: 'dependsOn' } } } : {}),
              fields: { owner: { type: 'actor', required: true }, dependsOn: { type: 'refs(task)', withinParent: true } },
              computed: { ready: `state in [pending, in_progress, blocked] and all(dependsOn, state = done)${withRole ? ' and waiting = false' : ''}` },
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
      actions: [{ verb: 'set-field', subKind: 'plan/task', fields: { status: { writableBy: 'owner' } } }, { verb: 'open' }],
    },
  }
}

let base: string
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'silo-now-ready-'))
})
afterEach(() => rmSync(base, { recursive: true, force: true }))

function setup(m: Json) {
  const dataDir = join(base, 'data')
  mkdirSync(join(dataDir, 'silos', 'registry', 'chores'), { recursive: true })
  writeFileSync(join(dataDir, 'silos', 'registry', 'chores', 'silo.json'), JSON.stringify(m))
  const registry = new SiloRegistry({ dataDir, operator: { decisionFor: () => 'approved', slotsOff: () => [] } })
  registry.load()
  const isAgent = (v: string): boolean => ['writer', 'finance'].includes(v)
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
  return { actions }
}
function put(tasks: Json[]): string {
  const f = join(base, 'proj', 'chores', 'p.plan.json')
  mkdirSync(join(f, '..'), { recursive: true })
  writeFileSync(f, JSON.stringify({ title: 'P', updatedAt: '2026-11-01', tasks }, null, 2))
  return f
}
const t = (id: string, owner: string, status: string, dependsOn: string[] = []): Json => ({ id, title: `Task ${id}`, owner, status, dependsOn })
const key = (id: string): string => `folder:${join(base, 'proj')}/p/tasks/${id}`

describe('set-field nowReady', () => {
  it("names the siblings ready AFTER and not before — the gate's dependents whose every dependency is now done", () => {
    const f = put([
      t('g', 'sam', 'pending'),
      t('a', 'writer', 'blocked', ['g']),
      t('b', 'finance', 'blocked', ['g', 'x']),
      t('x', 'writer', 'pending'),
      t('r', 'writer', 'pending'),
    ])
    const { actions } = setup(manifest())
    const r = actions.setField('chores', key('g'), 'status', 'done')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.nowReady).toEqual([{ key: key('a'), id: 'a', identity: 'Task a', owner: 'writer' }])
    // only the field the owner set was written — a's `blocked` stays (the producer recomputes)
    const raw = JSON.parse(readFileSync(f, 'utf8'))
    expect(raw.tasks.map((x: Json) => [x.id, x.status])).toEqual([
      ['g', 'done'],
      ['a', 'blocked'],
      ['b', 'blocked'],
      ['x', 'pending'],
      ['r', 'pending'],
    ])
  })

  it('empty when nothing became ready; absent on a kind without the task role', () => {
    put([t('g', 'sam', 'pending'), t('a', 'writer', 'blocked', ['g', 'x']), t('x', 'writer', 'pending')])
    const one = setup(manifest())
    const r = one.actions.setField('chores', key('g'), 'status', 'in_progress')
    expect(r.ok && r.value.nowReady).toEqual([])
    rmSync(join(base, 'data'), { recursive: true, force: true })
    const two = setup(manifest(false))
    const r2 = two.actions.setField('chores', key('g'), 'status', 'done')
    expect(r2.ok).toBe(true)
    expect(r2.ok && 'nowReady' in r2.value).toBe(false)
  })
})
