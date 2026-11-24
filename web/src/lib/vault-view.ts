// vault-view.ts — the per-agent Vault view: which entries actually REACH an
// agent, and where each one comes from. Pure mirror of the server's
// resolution (vault-store.ts envFor: agents > folder > global, folder scopes
// matching the agent's folder with the path boundary respected; within the
// agents tier the SHORTEST visibility list naming this agent wins, then the
// newest entry) — computed client-side from the masked /api/vault list so
// the dossier can show provenance, not just the flat store.
import type { VaultEntry } from './types'

export interface EffectiveVaultVar {
  name: string
  entry: VaultEntry // the WINNING entry (value already masked by the server)
  source: 'agent' | 'project' | 'global'
  // lower-precedence entries this one shadows (e.g. an agent var over a
  // global one) — shown so an override is never silent.
  overrides: ('project' | 'global')[]
}

function underFolder(cwd: string, folder: string): boolean {
  return cwd === folder || cwd.startsWith(folder.endsWith('/') ? folder : `${folder}/`)
}

export function effectiveVaultFor(entries: VaultEntry[], agentId: string, folder: string | null): EffectiveVaultVar[] {
  const byName = new Map<string, EffectiveVaultVar>()
  const put = (entry: VaultEntry, source: EffectiveVaultVar['source']) => {
    const prev = byName.get(entry.name)
    const overrides = prev ? [...prev.overrides, ...(prev.source === 'agent' ? [] : [prev.source])] : []
    byName.set(entry.name, { name: entry.name, entry, source, overrides: overrides as ('project' | 'global')[] })
  }
  for (const e of entries) if (e.scope.type === 'global') put(e, 'global')
  if (folder !== null) {
    for (const e of entries) if (e.scope.type === 'folder' && underFolder(folder, e.scope.folder)) put(e, 'project')
  }
  const mine = entries.filter((e) => e.scope.type === 'agents' && e.scope.agentIds.includes(agentId))
  mine.sort((a, b) => {
    const la = a.scope.type === 'agents' ? a.scope.agentIds.length : 0
    const lb = b.scope.type === 'agents' ? b.scope.agentIds.length : 0
    return lb - la || a.createdAt.localeCompare(b.createdAt)
  })
  for (const e of mine) put(e, 'agent')
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
}
