// org.ts — an agent → agent relation read as a tree (an edge-only silo,
// the `tree` archetype). Pure: which installed silo
// draws the chain, the forest of agents it makes, each node's live line, and
// the agents a node may be placed under (never itself, never below itself).
//
// Nothing here knows a relation by name: the silo's descriptor says which
// relation its tree draws and its lens groups by — the same first-active
// rule the server's escalation walks (silos/relations.ts agentChainRelation).
import { MASTER_ID } from './constants'
import { territoriesOf } from './territory'
import { sameProject } from '../../../server/src/project-scope'
import type { AgentView, SiloDescriptor, SiloRelationEdge } from './types'

export interface OrgSource {
  silo: string
  siloName: string
  relation: string
  label: string | null
  lensOn: boolean
}

// The first ACTIVE silo with an acyclic agent → agent relation — by id, like
// the server. `lensOn`: its lens slot is granted (the operator can turn it off).
export function orgSource(silos: readonly SiloDescriptor[]): OrgSource | null {
  for (const s of [...silos].sort((a, b) => a.id.localeCompare(b.id))) {
    if (s.state !== 'active') continue
    const rel = (s.relations ?? []).find((r) => r.from === 'agent' && r.to === 'agent' && r.acyclic)
    if (!rel) continue
    const lensOn = !!s.lens && s.lens.relation === rel.name && s.slots.granted.includes('lens')
    return { silo: s.id, siloName: s.name ?? s.id, relation: s.tree?.relation ?? rel.name, label: s.lens?.label ?? null, lensOn }
  }
  return null
}

// the agents an org chart places: in play, never the owner's desk (Anywhere)
export function orgAgents(agents: readonly AgentView[]): AgentView[] {
  return agents.filter((a) => !a.archived && a.id !== MASTER_ID)
}

// the live edges (both ends placed) as a map from → to
export function liveEdges(edges: readonly SiloRelationEdge[], placed: ReadonlySet<string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const e of edges) if (!e.note && placed.has(e.from) && placed.has(e.to)) out[e.from] = e.to
  return out
}

export function chainUp(edges: Readonly<Record<string, string>>, start: string): string[] {
  const out: string[] = []
  const seen = new Set([start])
  let cur = edges[start]
  while (cur !== undefined && !seen.has(cur) && out.length < 64) {
    out.push(cur)
    seen.add(cur)
    cur = edges[cur]
  }
  return out
}

export interface OrgNode {
  id: string
  children: OrgNode[]
  depth: number
}

// roots = no live edge up (or a loop written by hand), in the given order;
// children under their parent in the given order. Never drops a node.
export function orgForest(ids: readonly string[], edges: Readonly<Record<string, string>>): OrgNode[] {
  const known = new Set(ids)
  const nodes = new Map(ids.map((id) => [id, { id, children: [] as OrgNode[], depth: 0 }]))
  const roots: OrgNode[] = []
  for (const id of ids) {
    const up = edges[id]
    if (up !== undefined && known.has(up) && up !== id && !chainUp(edges, up).includes(id)) nodes.get(up)!.children.push(nodes.get(id)!)
    else roots.push(nodes.get(id)!)
  }
  const setDepth = (n: OrgNode, d: number): void => {
    n.depth = d
    for (const c of n.children) setDepth(c, d + 1)
  }
  for (const r of roots) setDepth(r, 0)
  return roots
}

// the forest in reading order (depth-first), one row per node
export function flatten(forest: readonly OrgNode[]): OrgNode[] {
  const out: OrgNode[] = []
  const walk = (n: OrgNode): void => {
    out.push(n)
    for (const c of n.children) walk(c)
  }
  for (const r of forest) walk(r)
  return out
}

// The root of an agent's team (itself when it reports to nobody).
export function teamOf(edges: Readonly<Record<string, string>>, agent: string): string {
  const up = chainUp(edges, agent)
  return up.length > 0 ? up[up.length - 1]! : agent
}

// Who `agent` may report to: any placed agent but itself and those below it
// (choosing one of them would close a loop — the server refuses it too).
export function reportCandidates(ids: readonly string[], edges: Readonly<Record<string, string>>, agent: string): string[] {
  return ids.filter((id) => id !== agent && !chainUp(edges, id).includes(agent))
}

// a node's live line: its open tasks and how many of them are stalled
export function liveCounts(
  tasks: ReadonlyArray<{ owner: string; state: string; flow: { stalled: boolean } | null }>,
  agent: string,
): { open: number; stalled: number } {
  let open = 0
  let stalled = 0
  for (const t of tasks) {
    if (t.owner !== agent || t.state === 'done' || t.state === 'cancelled') continue
    open += 1
    if (t.flow?.stalled) stalled += 1
  }
  return { open, stalled }
}

// ── the lens over tasks ──────────────────────────────────────
//
// Groups = each root's subtree, in tree order. The kernel's FLOOR, never
// negotiable by the silo: what is stalled, what escalated (its wait is the
// escalation's «unstick …») and what is ready on the owner are painted
// unfolded ABOVE every group — a lens folds, it never hides. A task whose
// owner is a person or an agent outside the tree goes to «No team», never
// out of the view.
export interface LensTask {
  key: string
  owner: string
  state: string
  planKey: string
  id: string
  dependsOn: readonly string[]
  waitingOn: { owner: string; action: string } | null
  flow: { stalled: boolean } | null
}
export interface LensGroup<T> {
  root: string
  members: string[]
  tasks: T[]
}
export interface LensReading<T> {
  floor: Array<{ task: T; why: 'stalled' | 'escalated' | 'yours' }>
  groups: Array<LensGroup<T>>
  noTeam: T[]
}

export const ESCALATION_ACTION = /^unstick /

const finished = (s: string): boolean => s === 'done' || s === 'cancelled'

// `agents`: every agent id Silos knows (archived too) — an owner that is none
// of them is a person
export function lensGroups<T extends LensTask>(
  tasks: readonly T[],
  placed: readonly string[],
  edges: Readonly<Record<string, string>>,
  all: readonly LensTask[] = tasks,
  agents: ReadonlySet<string> = new Set(placed),
): LensReading<T> {
  const state = new Map(all.map((t) => [`${t.planKey}/tasks/${t.id}`, t.state]))
  const floorWhy = (t: T): 'stalled' | 'escalated' | 'yours' | null => {
    if (finished(t.state)) return null
    if (t.waitingOn && ESCALATION_ACTION.test(t.waitingOn.action)) return 'escalated'
    if (t.flow?.stalled) return 'stalled'
    // ready on the owner: a person's task whose blockers are all done
    const human = t.owner !== '' && !agents.has(t.owner)
    if (human && t.state !== 'blocked' && t.dependsOn.every((d) => state.get(`${t.planKey}/tasks/${d}`) === 'done')) return 'yours'
    return null
  }
  const out: LensReading<T> = { floor: [], groups: [], noTeam: [] }
  const roots = orgForest(placed, edges)
  const groupOf = new Map<string, LensGroup<T>>()
  for (const r of roots) {
    const g: LensGroup<T> = { root: r.id, members: flatten([r]).map((n) => n.id), tasks: [] }
    out.groups.push(g)
    for (const m of g.members) groupOf.set(m, g)
  }
  for (const t of tasks) {
    const why = floorWhy(t)
    if (why) {
      out.floor.push({ task: t, why })
      continue
    }
    const g = groupOf.get(t.owner)
    if (g) g.tasks.push(t)
    else out.noTeam.push(t)
  }
  out.groups = out.groups.filter((g) => g.tasks.length > 0)
  // the floor reads by weight: escalated first, then stalled, then yours
  const rank = { escalated: 0, stalled: 1, yours: 2 } as const
  out.floor = out.floor
    .map((f, i) => ({ f, i }))
    .sort((a, b) => rank[a.f.why] - rank[b.f.why] || a.i - b.i)
    .map((x) => x.f)
  return out
}

// The floor as a panel: what is escalated or
// stalled is rare and urgent, always whole; «ready on you» shows its first rows
// and counts the rest — it folds, it never hides.
export const FLOOR_YOURS = 3
export function floorPanel<T>(
  floor: ReadonlyArray<{ task: T; why: 'stalled' | 'escalated' | 'yours' }>,
  open: boolean,
  cap = FLOOR_YOURS,
): { rows: T[]; folded: number; foldable: boolean } {
  const yours = floor.filter((f) => f.why === 'yours')
  const shownYours = open ? yours.length : Math.min(cap, yours.length)
  const keep = new Set(yours.slice(0, shownYours))
  return {
    rows: floor.filter((f) => f.why !== 'yours' || keep.has(f)).map((f) => f.task),
    folded: yours.length - shownYours,
    foldable: yours.length > cap,
  }
}

// ── one org per project (one project can have its own finance agent and
// another project a different one). An agent's org is its folder's;
// an edge across folders is refused by the server and never drawn here.
export interface OrgProject {
  folder: string
  ids: string[]
}
/** An agent is of the org at `folder`: one of its folders is the same
 *  project (project-scope.ts sameProject — folders that nest are one). */
export const inOrg = (a: Pick<AgentView, 'folder' | 'folders'>, folder: string): boolean => territoriesOf(a).some((t) => sameProject(t, folder))
export function orgProjects(agents: readonly AgentView[]): OrgProject[] {
  // one org per PROJECT, headed by its outermost folder: folders that nest
  // are one project (the one resolver). A declared folder is membership: an
  // agent of two projects sits in both orgs; its one line draws where both
  // ends are
  const placed = orgAgents(agents)
  const all = [...new Set(placed.flatMap((a) => territoriesOf(a)))]
  const heads = all.filter((f) => !all.some((g) => g !== f && f.startsWith(`${g}/`)))
  return heads
    .map((folder) => ({ folder, ids: placed.filter((a) => inOrg(a, folder)).map((a) => a.id) }))
    .sort((a, b) => b.ids.length - a.ids.length || a.folder.localeCompare(b.folder))
}

/** The lines out of every chain because their two agents share no project
 *  (stage 2's `apart`), shown in the org of the agent that reports. */
export function apartEdges(edges: readonly SiloRelationEdge[], agents: readonly AgentView[], folder: string): SiloRelationEdge[] {
  return edges.filter((e) => e.note === 'apart' && agents.some((a) => a.id === e.from && !a.archived && inOrg(a, folder)))
}

export interface OrgTileFacts {
  folder: string
  teams: Array<{ root: string; members: string[] }>
  loners: string[]
}
export function orgTileFacts(agents: readonly AgentView[], edges: readonly SiloRelationEdge[], folder: string): OrgTileFacts {
  const ids = orgAgents(agents)
    .filter((a) => inOrg(a, folder))
    .map((a) => a.id)
  const forest = orgForest(ids, liveEdges(edges, new Set(ids)))
  return {
    folder,
    teams: forest.filter((n) => n.children.length > 0).map((n) => ({ root: n.id, members: flatten(n.children).map((c) => c.id) })),
    loners: forest.filter((n) => n.children.length === 0).map((n) => n.id),
  }
}
