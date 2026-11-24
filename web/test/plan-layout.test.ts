import { describe, expect, it } from 'vitest'
import { layoutPlan, labelLines, tracksOf, lanesOf, NW, GX, LABEL_W } from '../src/lib/plan-layout'
import type { TeamPlan, TeamPlanTask } from '../src/lib/team-plan'

const task = (id: string, owner: string, status: TeamPlanTask['status'], dependsOn: string[] = [], extra: Record<string, unknown> = {}): TeamPlanTask => ({
  id,
  title: `Task ${id}`,
  owner,
  status,
  dependsOn,
  ...extra,
})

const plan = (tasks: TeamPlanTask[]): TeamPlan => ({ title: 'P', tasks })

describe('plan-layout — swimlanes by owner, columns by depth (render-bpmn.py port)', () => {
  it('one lane per owner in order of first appearance; only owners present in the pool get a lane', () => {
    const [pool] = layoutPlan(plan([task('t1', 'silos', 'done'), task('t2', 'sam', 'pending', ['t1']), task('t3', 'silos', 'blocked', ['t2'])]))
    expect(pool!.lanes.map((l) => l.owner)).toEqual(['silos', 'sam'])
    expect(lanesOf(plan([task('a', 'x', 'done'), task('b', 'y', 'done'), task('c', 'x', 'done')]))).toEqual(['x', 'y'])
  })

  it('column = dependency depth inside the pool: x grows with the longest chain behind the task', () => {
    const [pool] = layoutPlan(
      plan([task('t1', 'a', 'done'), task('t2', 'a', 'pending', ['t1']), task('t3', 'a', 'blocked', ['t2']), task('t4', 'a', 'pending')]),
    )
    const x = Object.fromEntries(pool!.nodes.map((n) => [n.id, n.x]))
    const x0 = LABEL_W + 70
    expect(x).toEqual({ t1: x0, t2: x0 + (NW + GX), t3: x0 + 2 * (NW + GX), t4: x0 })
  })

  it('orders a column by the mean y of its predecessors (barycenter), never by file order', () => {
    // a and b in column 0 (a above b); in column 1 the FILE lists y-then-x,
    // but x depends on a (top) and y on b (bottom) → x must sit above y.
    // (ids share the `t` prefix on purpose: distinct prefixes would split pools)
    const [pool] = layoutPlan(plan([task('t1', 'o', 'done'), task('t2', 'o', 'done'), task('t3', 'o', 'pending', ['t2']), task('t4', 'o', 'pending', ['t1'])]))
    const y = Object.fromEntries(pool!.nodes.map((n) => [n.id, n.y]))
    expect(y.t1).toBeLessThan(y.t2!)
    expect(y.t4).toBeLessThan(y.t3!) // t4 follows t1 (top), t3 follows t2 (bottom)
  })

  it('fan-out and fan-in get a parallel gateway; start/end events sit on the first/last tasks', () => {
    const [pool] = layoutPlan(
      plan([task('t1', 'o', 'done'), task('t2', 'o', 'pending', ['t1']), task('t3', 'o', 'pending', ['t1']), task('t4', 'o', 'blocked', ['t2', 't3'])]),
    )
    expect(pool!.gates).toHaveLength(2) // one after t1 (fan-out), one before t4 (fan-in)
    expect(pool!.ends).toHaveLength(1)
    const t4 = pool!.nodes.find((n) => n.id === 't4')!
    expect(pool!.ends[0]!.x).toBeGreaterThan(t4.x + NW)
    // start event → t1 (single start: no gateway at the start)
    expect(pool!.start.x).toBeLessThan(pool!.nodes[0]!.x)
    expect(pool!.flows.some((f) => f.kind === 'curve' && f.arrow)).toBe(true)
  })

  it('≥2 start tasks share a gateway right after the start event', () => {
    const [pool] = layoutPlan(plan([task('t1', 'o', 'pending'), task('t2', 'o', 'pending')]))
    expect(pool!.gates).toHaveLength(1)
    expect(pool!.gates[0]!.x).toBe(LABEL_W + 52)
  })

  it('node state: done · ready (deps met, not done) · active · blocked · pending-with-unmet-deps', () => {
    const [pool] = layoutPlan(
      plan([
        task('t1', 'o', 'done'),
        task('t2', 'o', 'pending', ['t1']),
        task('t3', 'o', 'in_progress', ['t2']), // lying file: in progress with unmet deps → active
        task('t4', 'o', 'blocked', ['t2']),
        task('t5', 'o', 'pending', ['t2']),
      ]),
    )
    const st = Object.fromEntries(pool!.nodes.map((n) => [n.id, n.state]))
    expect(st).toEqual({ t1: 'done', t2: 'ready', t3: 'active', t4: 'blocked', t5: 'pending' })
  })

  it('tracks: the `track` field, else id prefixes when ≥2, else one pool; cross-pool deps become `ext` pills', () => {
    expect(tracksOf([task('r1', 'o', 'done'), task('s1', 'o', 'done')])).toEqual(['r', 's'])
    expect(tracksOf([task('t1', 'o', 'done'), task('t2', 'o', 'done')])).toEqual(['plan', 'plan'])
    expect(tracksOf([task('t1', 'o', 'done', [], { track: 'A' }), task('t2', 'o', 'done')])).toEqual(['A', 'plan'])
    const pools = layoutPlan(plan([task('r1', 'o', 'done'), task('s1', 'o', 'pending', ['r1']), task('s2', 'o', 'blocked', ['s1'])]))
    expect(pools.map((p) => p.name)).toEqual(['r', 's'])
    const s1 = pools[1]!.nodes.find((n) => n.id === 's1')!
    expect(s1.ext).toEqual(['r1'])
    expect(s1.x).toBe(LABEL_W + 70) // depth 0 INSIDE its pool
  })

  it('labels: `short` verbatim (≤2 lines); otherwise the title wrapped to two lines and ellipsised', () => {
    expect(labelLines(task('x', 'o', 'done', [], { short: 'one\ntwo\nthree' }))).toEqual(['one', 'two'])
    expect(labelLines({ ...task('x', 'o', 'done'), title: 'short title' })).toEqual(['short title'])
    const long = labelLines({ ...task('x', 'o', 'done'), title: 'Design the per-disk attribution across every single turn of any given session' })
    expect(long).toHaveLength(2)
    expect(long[1]!.endsWith('…')).toBe(true)
    expect(long[0]!.length).toBeLessThanOrEqual(27)
  })

  it('a cycle (a lying file) still lays out instead of hanging; an empty plan yields no pools', () => {
    const [pool] = layoutPlan(plan([task('t1', 'o', 'pending', ['t2']), task('t2', 'o', 'pending', ['t1'])]))
    expect(pool!.nodes).toHaveLength(2)
    expect(layoutPlan(plan([]))).toEqual([])
  })
})
