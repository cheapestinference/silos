// Sessions maintenance — the pure side of Settings › Maintenance › Sessions.
// Every session Silos knows (each agent's `sessions`, the master's
// included) laid out BY PROJECT so the owner can see what is there and
// trash it in bulk. Nothing here touches the network: the component does
// `api.trash` per session and the WS 'removed' event drops the rows.
import type { AgentView, SessionView } from './types'
import { DAY_MS } from './rel-time'

export interface MaintenanceRow {
  session: SessionView
  // the agent the row is shown under — the first non-archived carrier, or
  // the archived one when nobody else has the session (so it still shows).
  agent: AgentView
}

export interface ProjectGroup {
  // the project's cwd; null = sessions that carry no folder at all.
  cwd: string | null
  rows: MaintenanceRow[]
  bytes: number
  lastActivity: number
}

export interface SessionFilter {
  text: string
  olderThanDays?: number
  emptyOnly?: boolean
}

// bytes below which a transcript is "empty" for maintenance purposes — a
// JSONL with just the summary/first prompt line lands here.
export const EMPTY_BYTES = 2 * 1024

export function sessionKey(s: Pick<SessionView, 'folder' | 'id'>): string {
  return `${s.folder}/${s.id}`
}

export function groupSessionsByProject(agents: readonly AgentView[]): ProjectGroup[] {
  const rowsByKey = new Map<string, MaintenanceRow>()
  for (const agent of agents) {
    for (const session of agent.sessions) {
      const key = sessionKey(session)
      const prev = rowsByKey.get(key)
      // first carrier wins, except an archived carrier yields to a live one.
      if (!prev || (prev.agent.archived && !agent.archived)) rowsByKey.set(key, { session, agent })
    }
  }
  const groups = new Map<string | null, ProjectGroup>()
  for (const row of rowsByKey.values()) {
    const cwd = row.session.cwd ?? row.agent.folder ?? null
    let g = groups.get(cwd)
    if (!g) {
      g = { cwd, rows: [], bytes: 0, lastActivity: 0 }
      groups.set(cwd, g)
    }
    g.rows.push(row)
    g.bytes += row.session.size
    if (row.session.mtime > g.lastActivity) g.lastActivity = row.session.mtime
  }
  const out = [...groups.values()]
  for (const g of out) g.rows.sort((a, b) => b.session.mtime - a.session.mtime)
  out.sort((a, b) => b.lastActivity - a.lastActivity)
  return out
}

export function applySessionFilter(rows: readonly MaintenanceRow[], filter: SessionFilter, now: number): MaintenanceRow[] {
  const q = filter.text.trim().toLowerCase()
  const cutoff = filter.olderThanDays != null ? now - filter.olderThanDays * DAY_MS : null
  return rows.filter(({ session, agent }) => {
    if (cutoff != null && session.mtime > cutoff) return false
    if (filter.emptyOnly && session.size >= EMPTY_BYTES) return false
    if (q === '') return true
    return session.title.toLowerCase().includes(q) || session.skills.some((sk) => sk.toLowerCase().includes(q)) || agent.name.toLowerCase().includes(q)
  })
}

// shift-click: everything between the anchor and the target in the list's
// visual order. An anchor that is no longer visible collapses to the target.
export function rangeSelect(orderedKeys: readonly string[], anchor: string, target: string): string[] {
  const a = orderedKeys.indexOf(anchor)
  const t = orderedKeys.indexOf(target)
  if (t < 0) return []
  if (a < 0) return [target]
  const [lo, hi] = a < t ? [a, t] : [t, a]
  return orderedKeys.slice(lo, hi + 1)
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = n / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(1)} ${units[i]}`
}
