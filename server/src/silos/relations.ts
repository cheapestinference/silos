// silos/relations.ts — the kernel's store of a silo's RELATIONS (Silo
// Standard catalogs.md «Relations»): typed edges between hubs that a
// manifest declares in spec.relations and the OWNER writes. Generic: any
// edge-only silo uses it; nothing here knows what a relation means.
//
//   <dataDir>/silos/<id>/relations.json
//   { "version": 1, "relations": { "<name>": { "<from id>": "<to id>" } } }
//
// v1 = cardinality one between agents: a relation is a map from → to.
// Written through safe-file.ts; a corrupt file is set aside
// (backupCorruptJson) and reads empty — never guessed. The kernel REFUSES in
// words a write that would dangle (an id that is no agent), point at itself
// or, on an acyclic relation, close a loop. An edge whose agent was archived
// or deleted afterwards stays in the file (the owner's drawing is kept) but
// leaves every chain — said as «an archived agent» where it is shown.
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { readContainedTextOrNull, writeContained } from '../safe-file.js'
import { backupCorruptJson } from '../json-store.js'

type Json = Record<string, unknown>
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)
const isStr = (v: unknown): v is string => typeof v === 'string'

export const RELATIONS_MAX_BYTES = 512 * 1024
const SILO_ID = /^[a-z0-9][a-z0-9-]*$/
const NAME = /^[a-z][a-z0-9_]*$/

// a relation as the manifest declares it (schema $defs/relation)
export interface RelationDecl {
  name: string
  from: string
  to: string
  cardinality: 'one'
  acyclic: boolean
  writableBy: 'owner'
}

export function relationsOf(manifest: Json | null | undefined): RelationDecl[] {
  const spec = isObj(manifest?.spec) ? (manifest!.spec as Json) : {}
  return (Array.isArray(spec.relations) ? spec.relations : [])
    .filter(isObj)
    .filter((r) => isStr(r.name) && isStr(r.from) && isStr(r.to))
    .map((r) => ({
      name: String(r.name),
      from: String(r.from),
      to: String(r.to),
      cardinality: 'one' as const,
      acyclic: r.acyclic === true,
      writableBy: 'owner' as const,
    }))
}

// what an endpoint is, at the moment of reading
export type EndpointState = 'ok' | 'archived' | 'gone'
export interface AgentLookup {
  // 'ok' an agent in play · 'archived' known, out of play · 'gone' no agent by that id
  stateOf(id: string): EndpointState
  // the agent's projects (its folder + declared folders — territoriesOf) —
  // one org per project (a finance agent for one project and another for
  // another): an edge joins two agents who share
  // a project. Absent → no project rule.
  projectsOf?(id: string): string[]
}

export interface RelationEdge {
  from: string
  to: string
  note?: 'archived' | 'gone'
} // note: the far end is out of every chain
export type RelationWrite = { ok: true; edges: Record<string, string> } | { ok: false; code: number; reason: string }

export class RelationStore {
  constructor(private root: string) {} // <dataDir>/silos

  private dirOf(siloId: string): string | null {
    return SILO_ID.test(siloId) ? join(this.root, siloId) : null
  }

  private readAll(siloId: string): Record<string, Record<string, string>> {
    const dir = this.dirOf(siloId)
    if (!dir) return {}
    let text: string | null = null
    try {
      text = readContainedTextOrNull(dir, 'relations.json', { maxBytes: RELATIONS_MAX_BYTES })
      if (text === null) return {}
      const raw = JSON.parse(text) as unknown
      if (!isObj(raw) || raw.version !== 1 || !isObj(raw.relations)) throw new Error('not a relations file')
      const out: Record<string, Record<string, string>> = {}
      for (const [name, map] of Object.entries(raw.relations)) {
        if (!NAME.test(name) || !isObj(map)) continue
        const edges: Record<string, string> = {}
        for (const [from, to] of Object.entries(map)) if (isStr(to) && to !== '' && from !== '') edges[from] = to
        out[name] = edges
      }
      return out
    } catch {
      if (text !== null && text !== '') {
        try {
          backupCorruptJson(join(dir, 'relations.json'), text, `silo ${siloId} relations`, { mode: 0o600 })
        } catch {
          /* set aside or not, it reads empty */
        }
      }
      return {}
    }
  }

  // the raw edges of one relation, from → to, as the owner drew them
  edges(siloId: string, name: string): Record<string, string> {
    return { ...(this.readAll(siloId)[name] ?? {}) }
  }

  // the edges with the state of their ends: an edge to (or from) an agent
  // archived or deleted since is listed, marked, and out of every chain
  list(siloId: string, name: string, agents: AgentLookup): RelationEdge[] {
    return Object.entries(this.edges(siloId, name))
      .map(([from, to]) => {
        const worst = [agents.stateOf(from), agents.stateOf(to)].find((s) => s !== 'ok')
        return worst ? { from, to, note: worst } : { from, to }
      })
      .sort((a, b) => a.from.localeCompare(b.from))
  }

  // the edges a chain may walk: both ends agents in play
  live(siloId: string, name: string, agents: AgentLookup): Record<string, string> {
    const out: Record<string, string> = {}
    for (const [from, to] of Object.entries(this.edges(siloId, name))) {
      if (agents.stateOf(from) === 'ok' && agents.stateOf(to) === 'ok') out[from] = to
    }
    return out
  }

  // Set (or clear, to = null) the one edge from `from`. Refused in words:
  // an end that is no agent, an end out of play (a new edge to an archived
  // agent would be dead on arrival), itself, or a loop on an acyclic
  // relation («Builder already reports to Writer through Finance»).
  set(siloId: string, decl: RelationDecl, from: string, to: string | null, agents: AgentLookup, nameOf: (id: string) => string = (id) => id): RelationWrite {
    const dir = this.dirOf(siloId)
    if (!dir) return { ok: false, code: 400, reason: `${siloId} is not a silo id` }
    const all = this.readAll(siloId)
    const edges = { ...(all[decl.name] ?? {}) }
    const fromState = agents.stateOf(from)
    if (fromState === 'gone') return { ok: false, code: 400, reason: `${from} is not an agent — a ${decl.name} edge joins two agents Silos knows` }
    if (to === null) {
      if (!(from in edges)) return { ok: true, edges }
      delete edges[from]
    } else {
      const toState = agents.stateOf(to)
      if (toState === 'gone') return { ok: false, code: 400, reason: `${to} is not an agent — a ${decl.name} edge joins two agents Silos knows` }
      if (fromState === 'archived') return { ok: false, code: 400, reason: `${nameOf(from)} is archived — an archived agent takes no new ${decl.name} edge` }
      if (toState === 'archived') return { ok: false, code: 400, reason: `${nameOf(to)} is archived — an archived agent takes no new ${decl.name} edge` }
      if (to === from) return { ok: false, code: 400, reason: `${nameOf(from)} cannot ${decl.name} itself` }
      const fromProjects = agents.projectsOf?.(from) ?? []
      const toProjects = agents.projectsOf?.(to) ?? []
      if (fromProjects.length > 0 && toProjects.length > 0 && !fromProjects.some((f) => toProjects.includes(f))) {
        const word = (f: string): string => f.split('/').filter(Boolean).pop() ?? f
        return {
          ok: false,
          code: 400,
          reason: `${nameOf(from)} works in ${fromProjects.map(word).join(', ')} and ${nameOf(to)} in ${toProjects.map(word).join(', ')} — each project has its own org, so a ${decl.name} line joins two agents of one project`,
        }
      }
      if (decl.acyclic) {
        // walk up from `to`: reaching `from` closes a loop
        const path: string[] = [to]
        const seen = new Set<string>([to])
        let cur = edges[to]
        while (cur !== undefined && !seen.has(cur)) {
          if (cur === from) {
            return {
              ok: false,
              code: 409,
              reason: `that would close a loop — ${nameOf(to)} already ${decl.name} ${nameOf(from)}${path.length > 1 ? ` through ${path.slice(1).map(nameOf).join(', ')}` : ''}`,
            }
          }
          path.push(cur)
          seen.add(cur)
          cur = edges[cur]
        }
        if (cur === from)
          return {
            ok: false,
            code: 409,
            reason: `that would close a loop — ${nameOf(to)} already ${decl.name} ${nameOf(from)}${path.length > 1 ? ` through ${path.slice(1).map(nameOf).join(', ')}` : ''}`,
          }
      }
      edges[from] = to
    }
    all[decl.name] = edges
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    writeContained(dir, 'relations.json', JSON.stringify({ version: 1, relations: all }, null, 2) + '\n', { mode: 0o600 })
    return { ok: true, edges }
  }
}

// ── reading a relation as a tree, and walking a chain (pure) ────────────────

// The chain up from `start` through `edges` (from → to), `start` excluded,
// cycle-proof and bounded: a loop written by hand (the store refuses one,
// the file is the operator's) stops the walk where it closes.
export const MAX_CHAIN = 64
export function chainUp(edges: Readonly<Record<string, string>>, start: string): string[] {
  const out: string[] = []
  const seen = new Set<string>([start])
  let cur = edges[start]
  while (cur !== undefined && !seen.has(cur) && out.length < MAX_CHAIN) {
    out.push(cur)
    seen.add(cur)
    cur = edges[cur]
  }
  return out
}

// The root of `start`: the last link of its chain, or itself when it has none.
export function rootOf(edges: Readonly<Record<string, string>>, start: string): string {
  const up = chainUp(edges, start)
  return up.length > 0 ? up[up.length - 1]! : start
}

// Every id of `ids` placed in a forest: roots (no live edge up, or an edge
// to an id outside `ids`) in the given order, children under their parent in
// the given order. A loop written by hand leaves its members as roots — a
// node is never dropped.
export interface TreeNode {
  id: string
  children: TreeNode[]
}
export function forest(ids: readonly string[], edges: Readonly<Record<string, string>>): TreeNode[] {
  const known = new Set(ids)
  const nodes = new Map(ids.map((id) => [id, { id, children: [] as TreeNode[] }]))
  const roots: TreeNode[] = []
  for (const id of ids) {
    const up = edges[id]
    const n = nodes.get(id)!
    // a parent that is unknown, or whose chain leads back here, is no parent
    if (up !== undefined && known.has(up) && up !== id && !chainUp(edges, up).includes(id)) nodes.get(up)!.children.push(n)
    else roots.push(n)
  }
  return roots
}

// The relations of the ACTIVE silos, as the kernel serves them (the Graph's
// edges, Map's Org, the lens, the escalation chain): each declaring silo with
// its declaration. A disabled or pending silo draws nothing.
export interface ActiveRelation {
  silo: string
  siloName: string
  decl: RelationDecl
}
export function activeRelations(
  entries: ReadonlyArray<{ id: string; manifest: Json | null; status: { state: string; manifest: { name: string | null } } }>,
): ActiveRelation[] {
  const out: ActiveRelation[] = []
  for (const e of [...entries].sort((a, b) => a.id.localeCompare(b.id))) {
    if (e.status.state !== 'active' || !e.manifest) continue
    for (const decl of relationsOf(e.manifest)) out.push({ silo: e.id, siloName: e.status.manifest.name ?? e.id, decl })
  }
  return out
}

// The ONE agent → agent chain the kernel walks when it needs «who is above
// this agent» (the escalation engine; no silo is ever named): the first
// active acyclic agent → agent relation, by silo id. null = none installed
// — every chain is empty.
export function agentChainRelation(entries: Parameters<typeof activeRelations>[0]): ActiveRelation | null {
  return activeRelations(entries).find((r) => r.decl.from === 'agent' && r.decl.to === 'agent' && r.decl.acyclic) ?? null
}
