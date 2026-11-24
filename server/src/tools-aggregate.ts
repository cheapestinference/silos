// tools-aggregate.ts — aggregation for the Tools dimension (GET /api/tools in
// server.ts). Pure function: receives (agentId, SessionContext['tools']) pairs
// already resolved by the caller (a single pass over
// index.allSessions()+getContext(), no per-session fetches) and returns the
// global catalog (name, server, total invocations, which agents used it).
import type { SessionContext, ToolAgg } from './types.js'

function toolKey(server: string | null, name: string): string {
  return `${server ?? ''}␟${name}`
}

export function aggregateTools(entries: { agentId: string; tools: SessionContext['tools'] }[]): ToolAgg[] {
  const byKey = new Map<string, { name: string; server: string | null; count: number; agentIds: Set<string> }>()
  for (const { agentId, tools } of entries) {
    for (const t of tools) {
      const key = toolKey(t.server, t.name)
      let e = byKey.get(key)
      if (!e) {
        e = { name: t.name, server: t.server, count: 0, agentIds: new Set() }
        byKey.set(key, e)
      }
      e.count += t.count
      e.agentIds.add(agentId)
    }
  }
  return [...byKey.values()]
    .map((e) => ({ name: e.name, server: e.server, count: e.count, agentIds: [...e.agentIds] }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
}
