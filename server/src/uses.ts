// uses.ts — the usage matrix behind Map › Uses (GET /api/uses): which
// agents, projects or conversations ACTUALLY used a model, a file, a tool,
// an MCP server, a skill or an account. It sits beside the Graph: the Graph draws what configuration says COULD happen; here every
// cell is a count of conversations whose own transcript shows the use.
//
// Pure: the route resolves each session once (owner, title, project,
// account, its in-memory context) into a UsesSession and hands the list
// over; this module only counts. No engine names on purpose (the harness
// boundary test) — a model id is whatever the reader recorded.
import { basename, isAbsolute, join } from 'node:path'
import type { SessionContext } from './types.js'

export const USES_ROWS = ['agent', 'project', 'conversation', 'automation'] as const
// no 'command' column: the matrix maps VISIBILITY and reach —
// who touches what, who sees which secret — and «which programs a Bash
// launched» answers neither; OS-level permissions are the parked boxes topic
export const USES_COLS = ['model', 'file', 'tool', 'mcp', 'skill', 'provider', 'secret'] as const
export type UsesRowKind = (typeof USES_ROWS)[number]
export type UsesColKind = (typeof USES_COLS)[number]

// one session as the route resolved it — everything the counting needs
export interface UsesSession {
  folder: string
  id: string
  title: string
  agentId: string
  // the project folder it belongs to (an agent's folder holding its cwd, or
  // the cwd itself) — null when the transcript names no cwd
  project: string | null
  cwd: string | null
  mtime: number
  // an automation run or a nested `claude -p` — counted under its agent
  run: boolean
  skills: string[]
  // the account/key it runs on: the conversation's pick › its agent's › 'default'
  provider: string
  // the automation an automation run belongs to (null: not a run of one)
  automationId?: string | null
  ctx: Pick<SessionContext, 'files' | 'tools' | 'cost' | 'envRefs'> | null
}

export interface UsesQuery {
  rows: UsesRowKind
  cols: UsesColKind
  sinceMs: number | null // null = all time; else only sessions active since
  runs: boolean // false = the owner's conversations only
  minRows: number // a column survives only if ≥ this many rows use it (1 = all)
  folder?: string // scope: only sessions whose cwd lies inside this folder
}

// how an account/key reads: `label` is what tells it apart (an account's
// email when Claude knows it), `sub` what it is ("Claude · this machine"),
// `short` the name beside a model that already names itself (a key's gateway)
export interface UsesName {
  label: string
  sub?: string
  short?: string
}

export interface UsesLabels {
  agent(id: string): string
  provider(id: string): UsesName
  home: string
  // optional — absent: the kind has no names/origins beyond its id
  automation?(id: string): string
  // a Vault secret by NAME → where it reaches (null: not a Vault secret —
  // an env var the agent named is a column only when the Vault holds it)
  secret?(name: string): string | null
  // where an MCP server comes from (the engine's own naming — injected)
  mcpOrigin?(server: string): string
  // the known project folders (files: in a project vs outside)
  projects?: readonly string[]
}

// one axis entry: `n` distinct conversations, `m` the summed measure
// (tokens / changes / calls) when the column kind has one, `rows` how many
// rows touch a column (the "shared by ≥2" filter reads it)
// origin: where a column's thing comes from (the scope each thing comes
// from) — a file's area, an MCP server's source, a skill's,
// a secret's reach; absent where the kind has none (models)
export interface UsesAxis {
  id: string
  label: string
  sub?: string
  n: number
  m?: number
  rows?: number
  origin?: string
}
// one session's share of a cell: `s` indexes UsesView.sessions; `m` its
// measure, `r` its reads (files only — `m` there is edits + writes)
export interface UsesRef {
  s: number
  m?: number
  r?: number
}
export interface UsesCell {
  r: string
  c: string
  n: number
  m?: number
  refs: UsesRef[]
}
export interface UsesSessionRef {
  key: string
  title: string
  agentId: string
  mtime: number
  run: boolean
}

export interface UsesView {
  rows: UsesAxis[]
  cols: UsesAxis[]
  cells: UsesCell[]
  sessions: UsesSessionRef[]
  // what `m` counts for this column kind — null = only conversations
  measure: 'tokens' | 'changes' | 'calls' | null
  // sessions inside the window (after the runs/folder filters)
  considered: number
  // axis entries left out by the caps — said, never silently dropped
  truncated: { rows: number; cols: number }
  now: number
}

export const MAX_ROWS = 120
export const MAX_COLS = 300
export const MAX_REFS = 40

const MEASURE: Record<UsesColKind, UsesView['measure']> = {
  model: 'tokens',
  file: 'changes',
  tool: 'calls',
  mcp: 'calls',
  skill: null,
  provider: null,
  secret: 'calls',
}

// a file's area, literally from its path: what kind of place it lives in
export function fileOrigin(path: string, home: string, projects: readonly string[]): string {
  const inside = (root: string): boolean => path === root || path.startsWith(root.endsWith('/') ? root : root + '/')
  if (home && inside(join(home, '.silos'))) return 'Silos state'
  if (home && inside(join(home, '.claude'))) return /\/memory\/[^/]+$/.test(path) ? 'memory' : 'your machine'
  const project = projects.some((p) => inside(p)) || path.includes('/.claude/worktrees/')
  if (project) {
    if (/\/context\//.test(path)) return 'deliverables'
    if (/\/plans\//.test(path)) return 'plans'
    if (/\/(CLAUDE|AGENTS)\.md$/.test(path)) return 'instructions'
    return 'project'
  }
  return 'outside projects'
}

export function tildePath(p: string, home: string): string {
  if (home && (p === home || p.startsWith(home + '/'))) return '~' + p.slice(home.length)
  return p
}

// a worktree checkout belongs to its main checkout's project
export function mainCheckout(cwd: string): string {
  const i = cwd.indexOf('/.claude/worktrees/')
  return i > 0 ? cwd.slice(0, i) : cwd
}

// the project a cwd belongs to: the longest known project folder that holds
// it, else its main checkout — literal, nothing guessed past the path
export function projectOf(cwd: string | null, known: readonly string[]): string | null {
  if (!cwd) return null
  let best: string | null = null
  for (const f of known) {
    if ((cwd === f || cwd.startsWith(f.endsWith('/') ? f : f + '/')) && (best === null || f.length > best.length)) best = f
  }
  return best ?? mainCheckout(cwd)
}

// `silos-<id>/<model>` is a model reached through a Silos key (how an engine
// names the provider Silos injects into it): shown under the key's own label
// instead of its id
function modelLabel(raw: string, labels: UsesLabels): { label: string; sub?: string } {
  const slash = raw.indexOf('/')
  if (slash > 0 && raw.startsWith('silos-')) {
    return { label: raw.slice(slash + 1), sub: ((n) => n.short ?? n.label)(labels.provider(raw.slice('silos-'.length, slash))) }
  }
  if (slash > 0) return { label: raw.slice(slash + 1), sub: raw.slice(0, slash) }
  return { label: raw }
}

// what one session uses of a column kind: column id → its measure
function usesOf(s: UsesSession, kind: UsesColKind, secretOf?: (name: string) => string | null): Map<string, { m: number; r?: number }> {
  const out = new Map<string, { m: number; r?: number }>()
  const add = (id: string, m: number, r?: number): void => {
    const cur = out.get(id)
    if (cur) {
      cur.m += m
      if (r !== undefined) cur.r = (cur.r ?? 0) + r
    } else out.set(id, r !== undefined ? { m, r } : { m })
  }
  if (kind === 'model') {
    for (const b of s.ctx?.cost?.byModel ?? []) {
      if (!b.model || b.model.startsWith('<')) continue // '<synthetic>' turns ran no model
      add(b.model, b.inputTokens + b.outputTokens)
    }
  } else if (kind === 'file') {
    for (const f of s.ctx?.files ?? []) {
      const abs = isAbsolute(f.path) ? f.path : s.cwd ? join(s.cwd, f.path) : null
      if (!abs) continue
      add(abs, f.edits + f.writes + f.disk, f.reads + f.sent)
    }
  } else if (kind === 'tool') {
    for (const t of s.ctx?.tools ?? []) if (t.server === null) add(t.name, t.count)
  } else if (kind === 'mcp') {
    for (const t of s.ctx?.tools ?? []) if (t.server !== null) add(t.server, t.count)
  } else if (kind === 'skill') {
    for (const k of s.skills) add(k, 0)
  } else if (kind === 'secret') {
    for (const v of s.ctx?.envRefs ?? []) if (secretOf?.(v.name) != null) add(v.name, v.count)
  } else {
    add(s.provider, 0)
  }
  return out
}

function rowIdOf(s: UsesSession, kind: UsesRowKind): string | null {
  if (kind === 'agent') return s.agentId
  if (kind === 'project') return s.project
  if (kind === 'automation') return s.automationId ?? null
  return `${s.folder}/${s.id}`
}

export function buildUses(all: readonly UsesSession[], q: UsesQuery, labels: UsesLabels, now: number): UsesView {
  const measured = MEASURE[q.cols] !== null
  const inside = (cwd: string | null): boolean => q.folder === undefined || (cwd !== null && (cwd === q.folder || cwd.startsWith(q.folder + '/')))
  const sessions = all.filter((s) => (q.runs || !s.run) && (q.sinceMs === null || s.mtime >= q.sinceMs) && inside(s.cwd))

  type Acc = { n: number; m: number; refs: { s: UsesSession; m: number; r?: number }[] }
  const cells = new Map<string, Map<string, Acc>>() // row → col → acc
  const rowSessions = new Map<string, Set<UsesSession>>()
  const colSessions = new Map<string, Set<UsesSession>>()
  const colRows = new Map<string, Set<string>>()
  const rowM = new Map<string, number>()
  const colM = new Map<string, number>()
  const rowSample = new Map<string, UsesSession>()
  const usedBy = new Map<UsesSession, Map<string, { m: number; r?: number }>>()

  for (const s of sessions) {
    const r = rowIdOf(s, q.rows)
    if (r === null) continue
    const used = usesOf(s, q.cols, labels.secret)
    if (used.size === 0) continue
    usedBy.set(s, used)
    rowSample.set(r, rowSample.get(r) ?? s)
    let byCol = cells.get(r)
    if (!byCol) {
      byCol = new Map()
      cells.set(r, byCol)
    }
    for (const [c, u] of used) {
      let acc = byCol.get(c)
      if (!acc) {
        acc = { n: 0, m: 0, refs: [] }
        byCol.set(c, acc)
      }
      acc.n += 1
      acc.m += u.m
      acc.refs.push({ s, m: u.m, ...(u.r !== undefined ? { r: u.r } : {}) })
      ;(rowSessions.get(r) ?? rowSessions.set(r, new Set()).get(r)!).add(s)
      ;(colSessions.get(c) ?? colSessions.set(c, new Set()).get(c)!).add(s)
      ;(colRows.get(c) ?? colRows.set(c, new Set()).get(c)!).add(r)
      rowM.set(r, (rowM.get(r) ?? 0) + u.m)
      colM.set(c, (colM.get(c) ?? 0) + u.m)
    }
  }

  // columns: the "shared by ≥ minRows" filter BEFORE the cap, so a shared
  // file that ranks low still makes it; ranked by conversations, then measure
  const colIds = [...colSessions.keys()]
    .filter((c) => (colRows.get(c)?.size ?? 0) >= q.minRows)
    .sort((a, b) => colSessions.get(b)!.size - colSessions.get(a)!.size || (colM.get(b) ?? 0) - (colM.get(a) ?? 0) || a.localeCompare(b))
  const keptCols = colIds.slice(0, MAX_COLS)
  const colSet = new Set(keptCols)

  // rows: only those touching a kept column; conversations newest first,
  // agents/projects by how many conversations they put in the matrix
  const rowN = (r: string): number => {
    let n = 0
    for (const s of rowSessions.get(r) ?? []) if ([...usedBy.get(s)!.keys()].some((c) => colSet.has(c))) n++
    return n
  }
  const rowCounts = new Map<string, number>()
  for (const r of rowSessions.keys()) {
    const n = rowN(r)
    if (n > 0) rowCounts.set(r, n)
  }
  const rowIds = [...rowCounts.keys()].sort(
    q.rows === 'conversation'
      ? (a, b) => rowSample.get(b)!.mtime - rowSample.get(a)!.mtime
      : (a, b) => rowCounts.get(b)! - rowCounts.get(a)! || (rowM.get(b) ?? 0) - (rowM.get(a) ?? 0) || a.localeCompare(b),
  )
  const keptRows = rowIds.slice(0, MAX_ROWS)

  // the sessions table: only those a kept cell points at
  const sessionIdx = new Map<UsesSession, number>()
  const sessionRefs: UsesSessionRef[] = []
  const idxOf = (s: UsesSession): number => {
    let i = sessionIdx.get(s)
    if (i === undefined) {
      i = sessionRefs.length
      sessionIdx.set(s, i)
      sessionRefs.push({ key: `${s.folder}/${s.id}`, title: s.title, agentId: s.agentId, mtime: s.mtime, run: s.run })
    }
    return i
  }

  const outCells: UsesCell[] = []
  for (const r of keptRows) {
    for (const [c, acc] of cells.get(r) ?? []) {
      if (!colSet.has(c)) continue
      const refs = acc.refs
        .sort((a, b) => b.s.mtime - a.s.mtime)
        .slice(0, MAX_REFS)
        .map((x) => ({ s: idxOf(x.s), ...(measured ? { m: x.m } : {}), ...(x.r !== undefined ? { r: x.r } : {}) }))
      outCells.push({ r, c, n: acc.n, ...(measured ? { m: acc.m } : {}), refs })
    }
  }

  const rowAxis = (r: string): UsesAxis => {
    const base = { id: r, n: rowCounts.get(r)!, ...(measured ? { m: rowM.get(r) ?? 0 } : {}) }
    if (q.rows === 'agent') return { ...base, label: labels.agent(r) }
    if (q.rows === 'project') return { ...base, label: basename(r) || r, sub: tildePath(r, labels.home) }
    if (q.rows === 'automation') {
      const s = rowSample.get(r)!
      return { ...base, label: labels.automation?.(r) ?? r, sub: labels.agent(s.agentId) }
    }
    const s = rowSample.get(r)!
    return { ...base, label: s.title, sub: labels.agent(s.agentId) }
  }
  const colAxis = (c: string): UsesAxis => {
    const base = { id: c, n: colSessions.get(c)!.size, rows: colRows.get(c)!.size, ...(measured ? { m: colM.get(c) ?? 0 } : {}) }
    if (q.cols === 'model') return { ...base, ...modelLabel(c, labels) }
    if (q.cols === 'file') {
      const t = tildePath(c, labels.home)
      const cut = t.lastIndexOf('/')
      return {
        ...base,
        label: cut >= 0 ? t.slice(cut + 1) : t,
        ...(cut > 0 ? { sub: t.slice(0, cut) } : {}),
        origin: fileOrigin(c, labels.home, labels.projects ?? []),
      }
    }
    if (q.cols === 'mcp') return { ...base, label: c, ...(labels.mcpOrigin ? { origin: labels.mcpOrigin(c) } : {}) }
    if (q.cols === 'skill') return { ...base, label: c, origin: c.includes(':') ? 'a plugin' : 'its folder or yours' }
    if (q.cols === 'secret') return { ...base, label: c, origin: labels.secret?.(c) ?? 'Vault' }
    if (q.cols === 'provider') {
      const n = labels.provider(c)
      return { ...base, label: n.label, ...(n.sub !== undefined ? { sub: n.sub } : {}) }
    }
    return { ...base, label: c }
  }

  return {
    rows: keptRows.map(rowAxis),
    cols: keptCols.map(colAxis),
    cells: outCells,
    sessions: sessionRefs,
    measure: MEASURE[q.cols],
    considered: sessions.length,
    truncated: { rows: rowIds.length - keptRows.length, cols: colIds.length - keptCols.length },
    now,
  }
}
