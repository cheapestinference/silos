// knows.ts — the words and items the library's open-item pane reads: a
// context file or a skill as a KnowsItem (its scope in ScopePill's
// vocabulary plus its original word), whether Delete is honest for a
// context file, and where a skill really comes from. Pure: no React, no
// fetches.
import type { ScopeId } from '../components/knows/ScopePill'
import type { ContextFile, SkillCatalogEntry } from './types'

export type KnowsKind = 'memory' | 'skills' | 'context'

export interface KnowsItem {
  kind: KnowsKind
  name: string
  scope: ScopeId
  rawScope: string
  path?: string
  description?: string
  mtime?: number
  isNew?: boolean
  // context files only: the path under the scope root and the territory —
  // what decides whether Delete is honest (removableContext).
  rel?: string
  folder?: string
}

// The remove route takes a BARE name under the agent's PRIMARY folder
// (<folder>/context/<scope>/<name>). Only a top-level shared/private file of
// that folder is what it would delete; a deeper file or another
// territory's file of the same name is not — offering Delete there would
// remove the wrong file.
export function removableContext(
  f: { rel?: string | undefined; folder?: string | undefined; scope?: string | undefined },
  primaryFolder: string | null,
): boolean {
  if (!primaryFolder || typeof f.rel !== 'string' || typeof f.folder !== 'string') return false
  if (f.scope !== 'shared' && f.scope !== 'agent') return false
  return !f.rel.includes('/') && f.folder === primaryFolder
}

// Context files: shared (by the folder's agents) → project, agent → agent.
export function contextItems(ctx: { shared: ContextFile[]; agent: ContextFile[] }): KnowsItem[] {
  const item = (f: ContextFile, scope: ScopeId): KnowsItem => ({
    kind: 'context',
    name: f.name,
    scope,
    rawScope: f.scope,
    path: f.path,
    mtime: f.mtime,
    rel: f.rel,
    folder: f.folder,
  })
  return [...ctx.shared.map((f) => item(f, 'project')), ...ctx.agent.map((f) => item(f, 'agent'))]
}

const SKILL_SCOPE: Record<NonNullable<SkillCatalogEntry['source']>, ScopeId> = {
  project: 'project',
  // the operator's personal ~/.claude/skills load for EVERY agent — the
  // amber "only this agent" was a false word
  user: 'global',
  plugin: 'global',
  // one of Silos' own skills not in the folder yet: adding it lands it there
  silos: 'project',
  // sent by a Claude account: every conversation on that login
  account: 'global',
}

/** A skill's scope from its catalog source; no source (name-only) reads as the agent's own. */
export function skillScope(source: SkillCatalogEntry['source']): ScopeId {
  return source ? SKILL_SCOPE[source] : 'agent'
}

/** Where a skill really comes from and what governs it, in one sentence —
 *  said per source and state, never a default that mislabels (a plugin
 *  skill once read «Personal (~/.claude/skills)», and so did «Could add»).
 *  `rawScope` is the catalog source as a KnowsItem carries it. */
export function skillWhere(s: {
  source?: string
  state?: SkillCatalogEntry['state']
  seen?: SkillCatalogEntry['seen']
  plugin?: string
  shadowed?: string
  stillLoads?: SkillCatalogEntry['stillLoads']
  position?: string
  origin?: SkillCatalogEntry['origin']
}): string {
  if (s.source === 'account') {
    if (s.origin && !s.origin.on)
      return 'Sent by your Claude account — this project doesn’t load what the account sends; set it on or name only to add just this one.'
    return s.state === 'available'
      ? 'Sent by your Claude account — turned off in this project’s own settings; nothing on claude.ai changes.'
      : 'Sent by your Claude account — loads in every conversation here on that login. Its position is this project’s own setting; nothing on claude.ai changes.'
  }
  if (s.source === 'user' && s.state === 'held')
    return 'Personal (~/.claude/skills) — turned off in this project’s own settings; the skill itself stays where it is and loads everywhere else.'
  if (s.state === 'held') {
    return s.stillLoads === 'personal'
      ? 'This folder’s copy is turned off — but your personal copy of the same name (~/.claude/skills) still loads in every folder; Silos never turns that one off.'
      : 'Turned off — moved out of its folder into Silos’ store; no engine sees it until it is turned on.'
  }
  if (s.state === 'available') return 'One of Silos’ own skills, not in this folder yet — Add copies it in, and every agent working here then loads it.'
  if (s.state === 'seen') {
    if (s.seen === 'other-folder') return 'Lives in another agent’s folder — not loaded here.'
    if (s.seen === 'plugin-off') return 'Comes with a Claude Code plugin that is off in this folder — it loads once the plugin is on (the project’s Tools).'
    return 'Known only by name — seen in a conversation or declared on an agent; there is no SKILL.md for it here.'
  }
  if (s.source === 'project') return 'In its folder — loaded in every conversation there.'
  if (s.source === 'user') {
    return s.shadowed
      ? 'Personal (~/.claude/skills) — applies in every folder, and runs instead of the folder’s own copy (turning that copy off would change nothing); Silos never touches it.'
      : 'Personal (~/.claude/skills) — applies in every folder; Silos never touches the skill, only this project’s own settings.'
  }
  if (s.source === 'plugin') {
    // OpenCode is handed Silos' skills as a launch root: there is no folder
    // copy to move out, and the add route won't create one (it would change
    // nothing for this engine) — so it stays on, and says so
    if (s.plugin === 'silos')
      return 'One of Silos’ own skills, handed to its engine at every launch — there is no copy in the folder, so it can’t be turned off for this agent.'
    return `Comes with ${s.plugin ? `the ${s.plugin.split('@')[0]} plugin` : 'an enabled plugin'} — on and off with the plugin, in the project’s Tools.`
  }
  if (s.source === 'silos') return 'One of Silos’ own skills.'
  return 'Known only by name — there is no SKILL.md for it here.'
}
