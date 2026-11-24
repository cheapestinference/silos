// vault-page.ts — pure derivations for the Vault page (/vault): the whole
// keyring, grouped by NAME so a collision is never silent. For every entry
// the page says, in plain words, who it reaches (its audience), where a
// more specific same-name entry wins instead (`shadowedFor`), and what
// deleting it takes away (`lossPhrase`). All of it mirrors the server's
// resolution (vault-store.ts envFor: agents > folder > global; within the
// agents tier the shortest visibility list naming the agent wins, then the
// newest) via effectiveVaultFor — computed per agent, so the annotations
// are the real outcome, not the nominal scope.
//
// Deliberately generic in shape (silo horizon, docs/standard annex
// `credentials`): a row is identity (name) + visibility + age — the
// component maps VaultEntry onto it, nothing here reads the store.
import type { VaultEntry } from './types'
import type { ScopeId } from '../components/knows/ScopePill'
import { effectiveVaultFor } from './vault-view'
import { basename } from './routes'
import { DAY_MS } from './rel-time'
import { foldersOf, inProjects, sameProject, type Member } from '../../../server/src/project-scope'

export interface VaultPageAgent {
  id: string
  name: string
  folder: string | null
}

export interface AnnotatedVaultEntry {
  entry: VaultEntry
  /** the ScopePill hue — the same vocabulary Knows uses everywhere. */
  scope: ScopeId
  /** who the visibility NAMES, as a label (owners.ts grammar): 'Every agent' ·
   *  'Project · <folder>' · 'Agent · Finance' · 'Agents · Finance + Builder'. */
  audience: string
  /** the same audience inside a sentence: 'Finance + Builder', 'acme' */
  audienceWords: string
  /** agent names that actually RECEIVE this entry (resolution applied). */
  reaches: string[]
  /** agents in the nominal audience where a more specific same-name entry wins. */
  shadowedFor: string[]
}

export interface VaultGroup {
  name: string
  entries: AnnotatedVaultEntry[]
}

function underFolder(cwd: string, folder: string): boolean {
  return cwd === folder || cwd.startsWith(folder.endsWith('/') ? folder : `${folder}/`)
}

/** join agent names the way the house writes lists: 'Ana', 'Ana + Ben', 'Ana + Ben + 2 more'. */
export function joinNames(names: string[], max = 3): string {
  if (names.length <= max) return names.join(' + ')
  return `${names.slice(0, max - 1).join(' + ')} + ${names.length - max + 1} more`
}

function nameOf(agents: VaultPageAgent[], id: string): string {
  return agents.find((a) => a.id === id)?.name ?? id
}

/** the agents a scope nominally covers (folder scopes approximate by the agent's home folder). */
function nominalAudience(entry: VaultEntry, agents: VaultPageAgent[]): VaultPageAgent[] {
  if (entry.scope.type === 'global') return agents
  if (entry.scope.type === 'folder') {
    const { folder } = entry.scope
    return agents.filter((a) => a.folder !== null && underFolder(a.folder, folder))
  }
  const ids = new Set(entry.scope.agentIds)
  return agents.filter((a) => ids.has(a.id))
}

/** The install's projects, by name — each folder an agent in play works in,
 *  folders that nest counted once as the outermost (the one resolver,
 *  project-scope.ts). What «every agent» reaches, spelled out (D7). */
export function installProjects(agents: readonly Member[]): string[] {
  const all = [...new Set(agents.filter(inProjects).flatMap((a) => foldersOf(a)))]
  const outer = all.filter((f) => !all.some((g) => g !== f && sameProject(f, g) && f.startsWith(`${g}/`)))
  return [...new Set(outer.map((f) => basename(f)))].sort((a, b) => a.localeCompare(b))
}

/** «acme and beta», «acme, beta and gamma» */
export function andList(xs: readonly string[]): string {
  return xs.length <= 1 ? (xs[0] ?? '') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`
}

export function audienceOf(entry: VaultEntry, agents: VaultPageAgent[], projects: readonly string[] = []): string {
  // «everyone» spelled as the projects it reaches, once the install has more than one
  if (entry.scope.type === 'global') return projects.length > 1 ? `Every agent · ${projects.join(' + ')}` : 'Every agent'
  if (entry.scope.type === 'folder') return `Project · ${basename(entry.scope.folder)}`
  return `${entry.scope.agentIds.length === 1 ? 'Agent' : 'Agents'} · ${joinNames(entry.scope.agentIds.map((id) => nameOf(agents, id)))}`
}

/** who the visibility names, inside a sentence: 'Finance', 'Finance + Builder', 'acme' */
function audienceWords(entry: VaultEntry, agents: VaultPageAgent[], projects: readonly string[] = []): string {
  if (entry.scope.type === 'global') return projects.length > 1 ? `every agent of ${andList(projects)}` : 'every agent'
  if (entry.scope.type === 'folder') return basename(entry.scope.folder)
  return joinNames(entry.scope.agentIds.map((id) => nameOf(agents, id)))
}

export function scopeIdOf(entry: VaultEntry): ScopeId {
  return entry.scope.type === 'global' ? 'global' : entry.scope.type === 'folder' ? 'project' : 'agent'
}

/**
 * The whole vault as name-groups, each entry annotated with its REAL reach.
 * Groups come out sorted by name; a group with >1 entries is a collision
 * (same env var from several visibilities — the page must say who wins).
 */
export function vaultGroups(entries: VaultEntry[], agents: VaultPageAgent[], projects: readonly string[] = []): VaultGroup[] {
  // the winner per (agent, name) — the server's resolution, reused verbatim.
  const winners = new Map<string, string>() // `${agentId}\u0000${name}` -> entry id
  for (const a of agents) {
    for (const v of effectiveVaultFor(entries, a.id, a.folder)) {
      winners.set(`${a.id}\u0000${v.name}`, v.entry.id)
    }
  }
  const byName = new Map<string, VaultEntry[]>()
  for (const e of entries) {
    const list = byName.get(e.name)
    if (list) list.push(e)
    else byName.set(e.name, [e])
  }
  const groups: VaultGroup[] = []
  for (const [name, list] of byName) {
    // most specific first, the same order the resolution applies them in
    // reverse: agents (shortest list first, then newest) > folder > global.
    const tier = (e: VaultEntry): number => (e.scope.type === 'agents' ? 0 : e.scope.type === 'folder' ? 1 : 2)
    const sorted = [...list].sort((a, b) => {
      const t = tier(a) - tier(b)
      if (t !== 0) return t
      if (a.scope.type === 'agents' && b.scope.type === 'agents') {
        const l = a.scope.agentIds.length - b.scope.agentIds.length
        if (l !== 0) return l
        return b.createdAt.localeCompare(a.createdAt)
      }
      return a.createdAt.localeCompare(b.createdAt)
    })
    const annotated = sorted.map((entry): AnnotatedVaultEntry => {
      const nominal = nominalAudience(entry, agents)
      const reaches: string[] = []
      const shadowedFor: string[] = []
      for (const a of nominal) {
        if (winners.get(`${a.id}\u0000${name}`) === entry.id) reaches.push(a.name)
        else shadowedFor.push(a.name)
      }
      return {
        entry,
        scope: scopeIdOf(entry),
        audience: audienceOf(entry, agents, projects),
        audienceWords: audienceWords(entry, agents, projects),
        reaches,
        shadowedFor,
      }
    })
    groups.push({ name, entries: annotated })
  }
  groups.sort((a, b) => a.name.localeCompare(b.name))
  return groups
}

/** what deleting this entry takes away, in plain words — never a silent removal. */
export function lossPhrase(v: AnnotatedVaultEntry): string {
  const e = v.entry
  if (e.scope.type === 'agents') return `${v.audienceWords} lose${e.scope.agentIds.length === 1 ? 's' : ''} it`
  if (e.scope.type === 'folder') return `everything in ${v.audienceWords} loses it`
  // global: honest about the agents that keep their own more specific copy.
  if (v.shadowedFor.length > 0) return `${v.audienceWords} but ${joinNames(v.shadowedFor)} loses it`
  return `${v.audienceWords} loses it`
}

/** the page's pulse line — composed only of real counts, zero parts dropped. */
export function countsPhrase(entries: VaultEntry[]): string | null {
  if (entries.length === 0) return null
  const global = entries.filter((e) => e.scope.type === 'global').length
  const folder = entries.filter((e) => e.scope.type === 'folder').length
  const agents = entries.filter((e) => e.scope.type === 'agents').length
  const parts: string[] = []
  if (global > 0) parts.push(`${global} for every agent`)
  if (folder > 0) parts.push(`${folder} for ${folder === 1 ? 'a project' : 'projects'}`)
  if (agents > 0) parts.push(`${agents} for agents`)
  const head = `${entries.length} secret${entries.length === 1 ? '' : 's'}`
  // a single kind repeats the total — the head alone already says it all.
  return parts.length > 1 ? `${head} — ${parts.join(' · ')}` : head + (parts.length === 1 ? ` — ${parts[0]!.replace(/^\d+ /, '')}` : '')
}

/** coarse age for rotation — 'added 3mo ago'; unknown createdAt → null. */
export function vaultAge(createdAt: string, now: number = Date.now()): string | null {
  const t = Date.parse(createdAt)
  if (Number.isNaN(t)) return null
  const days = Math.floor(Math.max(0, now - t) / DAY_MS)
  if (days < 1) return 'added today'
  if (days < 14) return `added ${days}d ago`
  if (days < 61) return `added ${Math.floor(days / 7)}w ago`
  if (days < 365) return `added ${Math.floor(days / 30)}mo ago`
  return `added ${Math.floor(days / 365)}y ago`
}

/**
 * search over the name and what the visibility NAMES (the audience phrase:
 * agent names, project basename). Deliberately not the computed reach — a
 * global entry reaches everyone, so searching an agent's name would return
 * the whole vault; "what does THIS agent get" is the agent page's question.
 */
export function filterGroups(groups: VaultGroup[], query: string): VaultGroup[] {
  const q = query.trim().toLowerCase()
  if (!q) return groups
  return groups.filter((g) => g.name.toLowerCase().includes(q) || g.entries.some((v) => v.audienceWords.toLowerCase().includes(q)))
}

export type VaultSort = 'name' | 'oldest'

/** 'oldest' floats the groups most in need of rotation; unknown dates count as oldest. */
export function sortGroups(groups: VaultGroup[], sort: VaultSort): VaultGroup[] {
  if (sort === 'name') return groups
  const oldest = (g: VaultGroup): string =>
    g.entries.reduce((min, v) => (v.entry.createdAt < min ? v.entry.createdAt : min), g.entries[0]?.entry.createdAt ?? '')
  return [...groups].sort((a, b) => oldest(a).localeCompare(oldest(b)))
}
