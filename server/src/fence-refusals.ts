// fence-refusals.ts — what the fence refused today, per agent and project:
// Settings › Territory's «N refused in beta ›». Read from the conversations'
// contexts (SessionContext.refused — each engine's reader records a refused
// call's time and the path its own input named, never the refusal text, the
// command or any output) and bucketed by the project the path lies in
// (project-scope.ts projectOfPath; a path in no project is `elsewhere`).
// Neutral and pure: no engine named, no I/O — the caller hands the sessions
// and their contexts the index already holds in memory.
import { foldersOf, inProjects, projectOfPath, type Member } from './project-scope.js'
import type { SessionContext } from './types.js'

export interface RefusedConversation {
  folder: string
  id: string
  count: number
  lastAt: string
}
/** One bucket: `project` the folder of the project the refused paths lie
 *  in, null = elsewhere (no project's, or a call that named no path). */
export interface RefusedBucket {
  project: string | null
  count: number
  conversations: RefusedConversation[]
}
export interface RefusedAgent {
  agentId: string
  total: number
  buckets: RefusedBucket[]
}

export function refusedSince(
  sessions: ReadonlyArray<{ folder: string; id: string; agentId: string | null | undefined }>,
  contextOf: (folder: string, id: string) => Pick<SessionContext, 'refused'> | null,
  agents: readonly Member[],
  since: number,
): RefusedAgent[] {
  const folders = [...new Set(agents.filter(inProjects).flatMap((a) => foldersOf(a)))]
  const by = new Map<string, Map<string | null, Map<string, RefusedConversation>>>()
  for (const s of sessions) {
    if (!s.agentId) continue
    const refused = contextOf(s.folder, s.id)?.refused ?? []
    for (const r of refused) {
      const at = Date.parse(r.at)
      if (!Number.isFinite(at) || at < since) continue
      const project = r.path ? projectOfPath(r.path, folders) : null
      const agent = by.get(s.agentId) ?? new Map<string | null, Map<string, RefusedConversation>>()
      by.set(s.agentId, agent)
      const bucket = agent.get(project) ?? new Map<string, RefusedConversation>()
      agent.set(project, bucket)
      const key = `${s.folder}\u0000${s.id}`
      const c = bucket.get(key) ?? { folder: s.folder, id: s.id, count: 0, lastAt: r.at }
      c.count += 1
      if (r.at > c.lastAt) c.lastAt = r.at
      bucket.set(key, c)
    }
  }
  return [...by.entries()]
    .map(([agentId, buckets]) => {
      const list = [...buckets.entries()]
        .map(([project, convs]) => {
          const conversations = [...convs.values()].sort((a, b) => b.lastAt.localeCompare(a.lastAt))
          return { project, count: conversations.reduce((n, c) => n + c.count, 0), conversations }
        })
        .sort((a, b) => b.count - a.count || (a.project ?? '￿').localeCompare(b.project ?? '￿'))
      return { agentId, total: list.reduce((n, b) => n + b.count, 0), buckets: list }
    })
    .sort((a, b) => a.agentId.localeCompare(b.agentId))
}
