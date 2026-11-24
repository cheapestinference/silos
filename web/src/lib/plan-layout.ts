// plan-layout.ts — the BPMN-style swimlane layout of a team plan, ported
// from the team-plan skill's render-bpmn.py (the reference design; the
// Python stays as the artifact generator). Pure
// geometry, no DOM: PlanView.tsx draws what this returns.
//
// Rules (deterministic, no dependencies):
//   pools  = tracks. A task's track is its `track` field; without one, tasks
//            group by the alphabetic prefix of their id (r1/s1 → r, s) when
//            there are ≥2 prefixes, else one pool.
//   lanes  = owners, in order of first appearance in the file.
//   column = dependency depth INSIDE the pool (deps in other pools become
//            dashed "needs …" message pills, BPMN message-flow style).
//   ◇+     = parallel gateway on fan-out (≥2 successors) / fan-in (≥2 deps).
//   ○ / ◉  = start (no in-pool deps) / end (no successors).
//   Nodes within a lane column are ordered by the mean y of their already
//   placed predecessors (barycenter) — never by file order.
import { isFinished, type PlanStatus, type TeamPlan, type TeamPlanTask } from './team-plan'

export const NW = 172
export const NH = 48
export const GX = 74
export const GY = 18
export const LANE_PAD = 22
export const LABEL_W = 34
export const G = 11 // gateway half-diagonal

export interface Pt {
  x: number
  y: number
}

// what the node's stroke says: done (green) · ready (thick accent) ·
// active (in progress, dashed accent) · blocked (dimmed) · pending (plain —
// a pending task whose deps aren't met: the file is lying, drawn plainly).
// `dropped`: cancelled — finished without being done; drawn apart from a
// blocked node
export type NodeState = 'done' | 'ready' | 'active' | 'blocked' | 'pending' | 'dropped'

export interface LayoutLane {
  owner: string
  y: number
  h: number
  idx: number
}
export interface LayoutNode {
  id: string
  x: number
  y: number
  lines: string[]
  state: NodeState
  status: PlanStatus
  owner: string
  // dependencies living in ANOTHER pool — drawn as a dashed message pill.
  ext: string[]
}
export interface LayoutFlow {
  kind: 'line' | 'curve'
  from: Pt
  to: Pt
  arrow: boolean
}
export interface PoolLayout {
  name: string
  width: number
  height: number
  lanes: LayoutLane[]
  nodes: LayoutNode[]
  flows: LayoutFlow[]
  gates: Pt[]
  start: Pt
  ends: Pt[]
}

export function isReady(t: TeamPlanTask, byId: ReadonlyMap<string, TeamPlanTask>): boolean {
  return !isFinished(t.status) && t.status !== 'in_review' && t.dependsOn.every((d) => byId.get(d)?.status === 'done')
}

// ≤2 lines of label: the optional `short` field verbatim, else the title
// wrapped at ~27 chars and ellipsised.
export function labelLines(t: TeamPlanTask): string[] {
  const short = (t as { short?: unknown }).short
  if (typeof short === 'string' && short.trim() !== '') return short.split('\n').slice(0, 2)
  const words = t.title.split(/\s+/)
  const lines: string[] = []
  let cur = ''
  for (const w of words) {
    if (cur === '') cur = w
    else if ((cur + ' ' + w).length <= 27) cur += ' ' + w
    else {
      lines.push(cur)
      cur = w
    }
  }
  if (cur !== '') lines.push(cur)
  if (lines.length > 2) {
    const second = lines[1]!
    return [lines[0]!, `${second.slice(0, 24).trimEnd()}…`]
  }
  return lines
}

export function tracksOf(tasks: readonly TeamPlanTask[]): string[] {
  if (tasks.some((t) => 'track' in t)) {
    return tasks.map((t) => (typeof t.track === 'string' ? t.track : 'plan'))
  }
  const prefixes = tasks.map((t) => /^[A-Za-z]*/.exec(t.id)?.[0] || '_')
  return new Set(prefixes).size >= 2 ? prefixes : tasks.map(() => 'plan')
}

function stateOf(t: TeamPlanTask, byId: ReadonlyMap<string, TeamPlanTask>): NodeState {
  if (t.status === 'done') return 'done'
  if (t.status === 'cancelled') return 'dropped'
  if (isReady(t, byId)) return 'ready'
  if (t.status === 'in_progress' || t.status === 'in_review') return 'active'
  if (t.status === 'blocked') return 'blocked'
  return 'pending'
}

function layoutPool(name: string, ids: readonly string[], byId: ReadonlyMap<string, TeamPlanTask>, lanes: readonly string[]): PoolLayout {
  const inPool = new Set(ids)
  const preds = new Map<string, string[]>()
  for (const i of ids)
    preds.set(
      i,
      byId.get(i)!.dependsOn.filter((d) => inPool.has(d)),
    )
  const succ = new Map<string, string[]>()
  for (const i of ids)
    succ.set(
      i,
      ids.filter((j) => preds.get(j)!.includes(i)),
    )

  // depth = longest in-pool chain behind the task; a cycle caps at the
  // point of re-entry instead of hanging.
  const memo = new Map<string, number>()
  const depth = (i: string, seen: readonly string[]): number => {
    const hit = memo.get(i)
    if (hit !== undefined) return hit
    const ps = preds.get(i)!.filter((d) => !seen.includes(d))
    const d = ps.length === 0 ? 0 : 1 + Math.max(...ps.map((p) => depth(p, [...seen, i])))
    memo.set(i, d)
    return d
  }
  for (const i of ids) depth(i, [])
  const maxD = Math.max(...ids.map((i) => memo.get(i)!))

  // lane geometry: a lane's height is its busiest column.
  const colsOf = (lane: string): Map<number, string[]> => {
    const cols = new Map<number, string[]>()
    for (const i of ids) {
      if (byId.get(i)!.owner !== lane) continue
      const d = memo.get(i)!
      if (!cols.has(d)) cols.set(d, [])
      cols.get(d)!.push(i)
    }
    return cols
  }
  const laneRows = new Map<string, number>()
  for (const lane of lanes) laneRows.set(lane, Math.max(0, ...[...colsOf(lane).values()].map((v) => v.length)))
  const lanesHere = lanes.filter((l) => laneRows.get(l)! > 0)
  const laneOut: LayoutLane[] = []
  let y = 0
  for (const lane of lanesHere) {
    const rows = laneRows.get(lane)!
    const h = LANE_PAD * 2 + rows * NH + (rows - 1) * GY
    laneOut.push({ owner: lane, y, h, idx: lanes.indexOf(lane) })
    y += h
  }
  const H = y
  const x0 = LABEL_W + 70
  const pos = new Map<string, Pt>()
  for (const lane of laneOut) {
    const cols = colsOf(lane.owner)
    for (const d of [...cols.keys()].sort((a, b) => a - b)) {
      const lst = cols.get(d)!
      // barycenter: mean y of already-placed predecessors (∞ = none → last)
      const bary = (i: string): number => {
        const ys = preds
          .get(i)!
          .filter((p) => pos.has(p))
          .map((p) => pos.get(p)!.y)
        return ys.length === 0 ? Number.POSITIVE_INFINITY : ys.reduce((a, b) => a + b, 0) / ys.length
      }
      const keyed = lst.map((i, k) => ({ i, k, b: bary(i) }))
      keyed.sort((a, b) => (a.b === b.b ? a.k - b.k : a.b - b.b)) // stable on ties
      const tot = keyed.length * NH + (keyed.length - 1) * GY
      const top = lane.y + (lane.h - tot) / 2
      keyed.forEach(({ i }, k) => pos.set(i, { x: x0 + d * (NW + GX), y: top + k * (NH + GY) }))
    }
  }
  const W = x0 + (maxD + 1) * (NW + GX) + 40
  const starts = ids.filter((i) => preds.get(i)!.length === 0)
  const ends = ids.filter((i) => succ.get(i)!.length === 0)

  const flows: LayoutFlow[] = []
  const gates: Pt[] = []
  const outAnchor = new Map<string, Pt>()
  const inAnchor = new Map<string, Pt>()
  for (const i of ids) {
    const { x, y: py } = pos.get(i)!
    if (succ.get(i)!.length >= 2) {
      const g = { x: x + NW + GX / 2 - 4, y: py + NH / 2 }
      gates.push(g)
      outAnchor.set(i, { x: g.x + G, y: g.y })
      flows.push({ kind: 'line', from: { x: x + NW, y: g.y }, to: { x: g.x - G, y: g.y }, arrow: false })
    } else {
      outAnchor.set(i, { x: x + NW, y: py + NH / 2 })
    }
    if (preds.get(i)!.length >= 2) {
      const g = { x: x - GX / 2 + 4, y: py + NH / 2 }
      gates.push(g)
      inAnchor.set(i, { x: g.x - G, y: g.y })
      flows.push({ kind: 'line', from: { x: g.x + G, y: g.y }, to: { x: x - 1, y: g.y }, arrow: true })
    } else {
      inAnchor.set(i, { x, y: py + NH / 2 })
    }
  }
  const curve = (from: Pt, to: Pt) => flows.push({ kind: 'curve', from, to, arrow: true })

  const start = { x: LABEL_W + 20, y: H / 2 }
  if (starts.length >= 2) {
    const g = { x: LABEL_W + 52, y: start.y }
    flows.push({ kind: 'line', from: { x: start.x + 9, y: start.y }, to: { x: g.x - G, y: g.y }, arrow: false })
    gates.push(g)
    for (const i of starts) curve({ x: g.x + G, y: g.y }, inAnchor.get(i)!)
  } else {
    for (const i of starts) curve({ x: start.x + 9, y: start.y }, inAnchor.get(i)!)
  }
  for (const i of ids) for (const j of succ.get(i)!) curve(outAnchor.get(i)!, inAnchor.get(j)!)
  const endPts: Pt[] = []
  for (const i of ends) {
    const { x, y: py } = pos.get(i)!
    const e = { x: x + NW + 26, y: py + NH / 2 }
    flows.push({ kind: 'line', from: { x: x + NW, y: e.y }, to: { x: e.x - 10, y: e.y }, arrow: true })
    endPts.push(e)
  }

  const nodes: LayoutNode[] = ids.map((i) => {
    const t = byId.get(i)!
    const p = pos.get(i)!
    return {
      id: i,
      x: p.x,
      y: p.y,
      lines: labelLines(t),
      state: stateOf(t, byId),
      status: t.status,
      owner: t.owner,
      ext: t.dependsOn.filter((d) => !inPool.has(d)),
    }
  })
  return { name, width: W, height: H, lanes: laneOut, nodes, flows, gates, start, ends: endPts }
}

// owners in order of first appearance — the lane order, shared by every pool.
export function lanesOf(plan: TeamPlan): string[] {
  return [...new Set(plan.tasks.map((t) => t.owner))]
}

export function layoutPlan(plan: TeamPlan): PoolLayout[] {
  if (plan.tasks.length === 0) return []
  const byId = new Map(plan.tasks.map((t) => [t.id, t]))
  const lanes = lanesOf(plan)
  const tracks = tracksOf(plan.tasks)
  const pools = new Map<string, string[]>()
  plan.tasks.forEach((t, k) => {
    const name = tracks[k]!
    if (!pools.has(name)) pools.set(name, [])
    pools.get(name)!.push(t.id)
  })
  return [...pools.entries()].map(([name, ids]) => layoutPool(name, ids, byId, lanes))
}
