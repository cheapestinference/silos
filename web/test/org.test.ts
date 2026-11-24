// org.ts — the tree a relation draws and the lens over tasks:
// which silo draws it, the forest, who a node may report to, and the
// kernel's floor (stalled / escalated / ready on you above every group,
// «No team» never hidden). Data only — no layout.
import { describe, expect, it } from 'vitest'
import {
  flatten,
  floorPanel,
  lensGroups,
  liveEdges,
  orgForest,
  orgProjects,
  orgSource,
  orgTileFacts,
  reportCandidates,
  teamOf,
  type LensTask,
} from '../src/lib/org'
import type { AgentView, SiloDescriptor, SiloRelationEdge } from '../src/lib/types'

const desc = (over: Partial<SiloDescriptor>): SiloDescriptor => ({
  id: 'hierarchy',
  name: 'Hierarchy',
  description: null,
  version: '0.1.0',
  apiVersion: 'silo-standard/v0',
  state: 'active',
  reason: 'active',
  conventions: [],
  wants: [],
  kinds: [],
  producer: null,
  records: { parsed: 0, failed: 0 },
  lastWrite: null,
  freshness: null,
  slots: { requested: ['lens'], granted: ['lens'], off: [] },
  observedAt: '',
  relations: [{ name: 'reports_to', from: 'agent', to: 'agent', acyclic: true }],
  tree: { view: 'org', relation: 'reports_to' },
  lens: { over: 'tasks', label: 'by team', relation: 'reports_to', by: 'subtree' },
  ...over,
})

describe('orgSource', () => {
  it('the first active silo with an acyclic agent → agent relation; its lens on only when granted', () => {
    expect(orgSource([desc({})])).toEqual({ silo: 'hierarchy', siloName: 'Hierarchy', relation: 'reports_to', label: 'by team', lensOn: true })
    expect(orgSource([desc({ slots: { requested: ['lens'], granted: [], off: ['lens'] } })])?.lensOn).toBe(false)
    expect(orgSource([desc({ state: 'pending' })])).toBeNull()
    expect(orgSource([desc({ relations: [{ name: 'reports_to', from: 'agent', to: 'agent', acyclic: false }] })])).toBeNull()
    expect(orgSource([])).toBeNull()
  })
})

describe('the forest', () => {
  const edges = { writer: 'finance', finance: 'builder', support: 'builder' }
  it('roots in order, children by the edge; a dead edge is no edge', () => {
    const rows = flatten(orgForest(['builder', 'finance', 'writer', 'support', 'silos'], edges))
    expect(rows.map((n) => `${'-'.repeat(n.depth)}${n.id}`)).toEqual(['builder', '-finance', '--writer', '-support', 'silos'])
    expect(
      liveEdges(
        [
          { from: 'writer', to: 'finance' },
          { from: 'finance', to: 'old', note: 'archived' },
        ],
        new Set(['writer', 'finance']),
      ),
    ).toEqual({ writer: 'finance' })
    expect(teamOf(edges, 'writer')).toBe('builder')
  })
  it('a node may report to anyone but itself and those below it', () => {
    expect(reportCandidates(['builder', 'finance', 'writer', 'support'], edges, 'finance')).toEqual(['builder', 'support'])
    expect(reportCandidates(['builder', 'finance', 'writer', 'support'], edges, 'writer')).toEqual(['builder', 'finance', 'support'])
  })
})

describe('lensGroups — the floor and the groups', () => {
  const T = (id: string, owner: string, state = 'in_progress', over: Partial<LensTask> = {}): LensTask => ({
    key: `p/tasks/${id}`,
    owner,
    state,
    planKey: 'p',
    id,
    dependsOn: [],
    waitingOn: null,
    flow: { stalled: false },
    ...over,
  })
  const placed = ['builder', 'finance', 'writer', 'support']
  const edges = { writer: 'finance', finance: 'builder' }
  it('stalled, escalated and owner-ready go above every group; human and outside owners to No team', () => {
    const tasks = [
      T('a', 'writer'),
      T('b', 'finance'),
      T('c', 'support'),
      T('s', 'writer', 'in_progress', { flow: { stalled: true } }),
      T('e', 'finance', 'blocked', { waitingOn: { owner: 'owner', action: 'unstick p#e' } }),
      T('y', 'sam', 'pending'),
      T('w', 'sam', 'pending', { dependsOn: ['a'] }), // a person's, but its blocker is open
      T('x', 'ghost'), // an agent outside the chart (or a person): no team
      T('d', 'writer', 'done'),
    ]
    const r = lensGroups(tasks, placed, edges, tasks, new Set([...placed, 'ghost']))
    expect(r.floor.map((f) => `${f.task.id}:${f.why}`)).toEqual(['e:escalated', 's:stalled', 'y:yours'])
    expect(r.groups.map((g) => [g.root, g.members, g.tasks.map((t) => t.id)])).toEqual([
      ['builder', ['builder', 'finance', 'writer'], ['a', 'b', 'd']],
      ['support', ['support'], ['c']],
    ])
    expect(r.noTeam.map((t) => t.id)).toEqual(['w', 'x'])
    // every task is somewhere — the lens folds, never hides
    expect(r.floor.length + r.groups.reduce((n, g) => n + g.tasks.length, 0) + r.noTeam.length).toBe(tasks.length)
  })
  it('no edges drawn: one group per agent', () => {
    const r = lensGroups([T('a', 'writer'), T('b', 'builder')], placed, {})
    expect(r.groups.map((g) => g.root)).toEqual(['builder', 'writer'])
  })
})

describe('floorPanel: the lens floor folds «ready on you», never what is urgent', () => {
  const floor = [
    { task: 'e1', why: 'escalated' as const },
    { task: 's1', why: 'stalled' as const },
    { task: 's2', why: 'stalled' as const },
    ...['y1', 'y2', 'y3', 'y4', 'y5'].map((task) => ({ task, why: 'yours' as const })),
  ]
  it('keeps everything escalated and stalled, three of yours, and counts the rest', () => {
    expect(floorPanel(floor, false)).toEqual({ rows: ['e1', 's1', 's2', 'y1', 'y2', 'y3'], folded: 2, foldable: true })
  })
  it('unfolded hides nothing, and can fold again', () => {
    expect(floorPanel(floor, true)).toEqual({ rows: floor.map((f) => f.task), folded: 0, foldable: true })
  })
  it('three or fewer have nothing to fold', () => {
    expect(floorPanel(floor.slice(0, 5), false)).toMatchObject({ folded: 0, foldable: false })
  })
})

describe('one org per project', () => {
  const ag = (id: string, name: string, folder: string): AgentView => ({ id, name, folder }) as AgentView
  const agents = [
    ag('builder', 'Builder', '/p/ci'),
    ag('writer', 'Writer', '/p/ci'),
    ag('finance', 'Finance', '/p/ci'),
    ag('finance2', 'Finance', '/p/other'),
    ag('silos', 'Silos', '/p/silos'),
  ]
  it('orgProjects groups agents by their folder, biggest first', () => {
    expect(orgProjects(agents)).toEqual([
      { folder: '/p/ci', ids: ['builder', 'writer', 'finance'] },
      { folder: '/p/other', ids: ['finance2'] },
      { folder: '/p/silos', ids: ['silos'] },
    ])
  })
  it("a project's facts count only its own agents — two Finances, two orgs", () => {
    const edges = [{ from: 'writer', to: 'builder' }] as SiloRelationEdge[]
    expect(orgTileFacts(agents, edges, '/p/ci')).toEqual({ folder: '/p/ci', teams: [{ root: 'builder', members: ['writer'] }], loners: ['finance'] })
    expect(orgTileFacts(agents, edges, '/p/other')).toEqual({ folder: '/p/other', teams: [], loners: ['finance2'] })
  })
  it('an edge across projects is never drawn', () => {
    const edges = [{ from: 'finance2', to: 'builder' }] as SiloRelationEdge[]
    expect(orgTileFacts(agents, edges, '/p/other').teams).toEqual([])
    expect(orgTileFacts(agents, edges, '/p/ci').teams).toEqual([])
  })
})
