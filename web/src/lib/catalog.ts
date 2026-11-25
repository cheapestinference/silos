// catalog.ts — catalog of Claude Code/Silos's 4 memory layers: Global
// (~/.claude/CLAUDE.md) · a per-project CLAUDE.md · a per-agent memory.md ·
// per-project auto-memory. Reuses GET /api/memory (memory-service.ts) the
// same way the agent page reads memory — one call PER AGENT
// brings back global+project+autoMemory+agent all at once, so no new
// endpoint is needed: it just has to dedupe by path across agents in the
// same project.
//
// SettingsPage.tsx (the "Memories" tab) is the ONLY real consumer of this catalog.
import { api } from './api'
import { basename } from './routes'
import type { AgentView, MemoryFileInfo } from './types'

export interface Catalog {
  global: MemoryFileInfo
  projects: { folder: string; claude: MemoryFileInfo; auto: MemoryFileInfo[] }[]
  /** per agent: its memory.md, and its automatic memory when its engine
   *  reads one (memory per agent — the server says autoScope) */
  agentEntries: { agent: AgentView; memory: MemoryFileInfo; auto: MemoryFileInfo[] }[]
}

export async function buildCatalog(agents: AgentView[]): Promise<Catalog> {
  let global: MemoryFileInfo | null = null
  const projectsByFolder = new Map<string, { folder: string; claude: MemoryFileInfo; auto: MemoryFileInfo[] }>()
  const agentEntries: Catalog['agentEntries'] = []

  for (const a of agents) {
    const layers = await api.memory.list(a.folder ?? undefined, a.id)
    if (!global) global = layers.global
    if (a.folder && layers.project && !projectsByFolder.has(a.folder)) {
      // folder-scoped call: with an agentId the auto layer is the AGENT's
      // (memory per agent) — the project row wants the folder's
      const folderLayers = await api.memory.list(a.folder)
      projectsByFolder.set(a.folder, { folder: a.folder, claude: folderLayers.project ?? layers.project, auto: folderLayers.autoMemory })
    }
    if (layers.agent) agentEntries.push({ agent: a, memory: layers.agent, auto: layers.autoScope === 'agent' ? layers.autoMemory : [] })
  }

  return {
    global: global ?? { name: 'CLAUDE.md', path: '', scope: 'global', mtime: 0, exists: false },
    projects: [...projectsByFolder.values()].sort((x, y) => basename(x.folder).localeCompare(basename(y.folder))),
    agentEntries,
  }
}
