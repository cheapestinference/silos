// A task of a CLOSED plan (plans/closed/) still resolves by the key it had
// while open — read-only, for references only (tasks-conversations t5):
// the conversation's chip and the task's page. Never in the silo's reading.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SiloRegistry } from '../src/silos/registry.js'
import { SiloReader } from '../src/silos/reader.js'
import { SiloKernel } from '../src/silos/kernel.js'
import { TransitionJournal } from '../src/silos/journal.js'
import { OverlayStore } from '../src/silos/overlay.js'
import { outsideDetail } from '../src/silos/views.js'
import { ClosedPlans, projectConventionDir } from '../src/plans-closed.js'

const REF_DIR = join(import.meta.dirname, '..', '..', 'docs', 'standard', 'reference')
type Json = Record<string, any>
const plans = (): Json => JSON.parse(readFileSync(join(REF_DIR, 'plans.silo.json'), 'utf8'))
const isAgent = (v: string): boolean => v === 'writer'

let base: string
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'plans-closed-'))
})
afterEach(() => rmSync(base, { recursive: true, force: true }))

function put(rel: string, v: unknown): void {
  const f = join(base, rel)
  mkdirSync(join(f, '..'), { recursive: true })
  writeFileSync(f, typeof v === 'string' ? v : JSON.stringify(v))
}

function setup() {
  const dataDir = join(base, 'data')
  mkdirSync(join(dataDir, 'silos', 'registry', 'plans'), { recursive: true })
  writeFileSync(join(dataDir, 'silos', 'registry', 'plans', 'silo.json'), JSON.stringify(plans()))
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
  const closed = new ClosedPlans({
    siloId: 'plans',
    manifest: () => registry.get('plans')?.manifest as Json,
    conventionDirs: () =>
      kernel
        .watchedFolders()
        .filter((w) => w.silo === 'plans')
        .map((w) => w.dir),
  })
  return { registry, kernel, closed }
}

const plan = (title: string, tasks: Json[]): Json => ({ title, tasks })

describe('closed plans resolve by their old key, read-only', () => {
  it('the convention folder comes from the source glob', () => {
    expect(projectConventionDir(plans())).toEqual(['plans'])
    expect(projectConventionDir({ spec: { sources: [{ root: 'project', glob: '*.plan.json' }] } })).toBeNull()
  })

  it('a task under plans/closed/ resolves by the key it had open; nothing else does', () => {
    put('proj/plans/live.plan.json', plan('Live', [{ id: 't1', title: 'Open one', owner: 'writer', status: 'in_progress' }]))
    put('proj/plans/closed/ship.plan.json', plan('Ship', [{ id: 't4', title: 'Bump proxy image', owner: 'writer', status: 'done', conversations: ['s-1'] }]))
    put('proj/plans/closed/notes.txt', 'not a plan')
    const { registry, kernel, closed } = setup()
    const proj = join(base, 'proj')
    // the reading (the lists' truth) never holds it
    expect(kernel.reading('plans')!.records.map((r) => r.record.id)).toEqual(['live'])
    const recs = closed.records({ isAgent })
    expect(recs.map((r) => `${r.location}/${r.record.id}`)).toEqual([`folder:${proj}/ship`])
    expect(recs[0]!.anchors).toEqual({ folder: proj })
    const key = `folder:${proj}/ship/tasks/t4`
    const hit = closed.resolve(key, { isAgent })
    expect(hit?.record.id).toBe('ship')
    expect(closed.resolve(`folder:${proj}/live/tasks/t1`)).toBeNull() // open: the reading's, not this
    expect(closed.resolve(`folder:${proj}/nope/tasks/t1`)).toBeNull()
    expect(closed.resolve('outside/ship')).toBeNull()
    // the page's detail: the task, with no version and no actions
    const d = outsideDetail(registry.get('plans')!, hit!, { now: Date.now(), isAgent }, key)
    expect(d).toMatchObject({
      outside: true,
      version: null,
      actions: [],
      record: { id: 't4', key, identity: 'Bump proxy image' },
      parent: { key: `folder:${proj}/ship` },
    })
  })

  it('re-reads a closed plan when its file changes', () => {
    put('proj/plans/closed/ship.plan.json', plan('Ship', [{ id: 't4', title: 'Before', owner: 'writer', status: 'done' }]))
    const { closed } = setup()
    expect(closed.records()[0]!.record.identity).toBe('Ship')
    put('proj/plans/closed/ship.plan.json', plan('Shipped', [{ id: 't4', title: 'After', owner: 'writer', status: 'done' }]))
    const f = join(base, 'proj', 'plans', 'closed', 'ship.plan.json')
    const later = new Date(Date.now() + 5000)
    utimesSync(f, later, later)
    expect(closed.records()[0]!.record.identity).toBe('Shipped')
  })
})
