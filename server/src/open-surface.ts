// open-surface.ts — where «Open» goes for an agent: its CONSOLE when it has one in the index and its engine's
// console takes the task's briefing; chat otherwise. The first console is
// always opened by the owner by hand — Silos never makes it the default on
// its own. One source for the facts every door reads: New task's buttons
// («Give and open console ›» / «… chat ›»), the task page's «Open console ›»
// / «Open chat ›» and Home's unread-messages row; the web's give.ts says
// the words (surfaceOf / openLabel).
import { harnessById, harnessOf } from './harnesses/registry.js'
import type { Agent, SessionMeta } from './types.js'

export interface OpenFacts {
  // a console of this agent is in the index (SessionMeta.console)
  hasConsole: boolean
  // its engine's console starts with the briefing (traits.consoleBriefing)
  consoleBriefs: boolean
}

/** The agents that have a console conversation in the index: one pass over
 *  the metas (the overview's own loop feeds it). */
export function consoleOwners(metas: Iterable<SessionMeta>, ownerOf: (m: SessionMeta) => string): Set<string> {
  const out = new Set<string>()
  for (const m of metas) if (m.console === true) out.add(ownerOf(m))
  return out
}

export function consoleBriefsOf(agent: Pick<Agent, 'framework'>): boolean {
  try {
    return harnessById(harnessOf(agent)).traits.consoleBriefing === true
  } catch {
    return false
  }
}

export function openFactsOf(agent: Pick<Agent, 'id' | 'framework'>, owners: ReadonlySet<string>): OpenFacts {
  return { hasConsole: owners.has(agent.id), consoleBriefs: consoleBriefsOf(agent) }
}
