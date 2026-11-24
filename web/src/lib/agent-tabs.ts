// agent-tabs.ts — the agent page's tabs, ONE definition: their order, names,
// the facet each is addressed by, and the figure each carries. The agent
// page's tab bar (AgentTab) and the conversation header's «▾» menu
// (AgentTabsMenu) both draw this list, so the two can never disagree — a tab
// added here appears in both, with the same count rule.
import { memoryNotes } from './knows-anatomy'
import { agentRows, topLevel } from './loads-view'
import { MASTER_ID } from './constants'
import type { KnowsSources } from '../components/knows/KnowsAnatomy'
import type { Tab } from '../store'

export type AgentSectionId = 'now' | 'messages' | 'automations' | 'memory' | 'files' | 'skills' | 'tools' | 'secrets' | 'starts' | 'settings'

/** the facet (URL / store tab) each section is addressed by */
export const AGENT_TAB_FACET: Record<AgentSectionId, Tab> = {
  now: 'threads',
  messages: 'inbox',
  automations: 'control',
  memory: 'memory',
  files: 'context',
  skills: 'skills',
  tools: 'tools',
  secrets: 'vault',
  starts: 'loaded',
  settings: 'identity',
}

/** what a tab says beside its name: a live dot, a count (accent = it waits on someone), or nothing yet */
export type AgentTabSignal = { kind: 'dot' } | { kind: 'count'; text: string; accent?: boolean } | null

export interface AgentTabDef {
  id: AgentSectionId
  label: string
  facet: Tab
  signal: AgentTabSignal
  /** Profile sits apart, after the rest */ apart?: boolean
}

export interface AgentTabInputs {
  agentId: string
  /** a conversation of it is live */
  live: boolean
  /** unread messages in its inbox */
  inboxNew: number
  /** the Knows reads (memory, catalog, context, produced, loaded); null = not read (no figures) */
  src: Pick<KnowsSources, 'memory' | 'catalog' | 'context' | 'produced' | 'loaded'> | null
  /** the Vault secrets that reach it; null = not read */
  secrets: number | null
  /** tokens a new conversation starts with (its lead mode); null = not measured */
  atStartTotal: number | null
  /** its automations (its heartbeat aside): how many, and whether one waits on you (failed, needs approval); absent/null = not read */
  automations?: { n: number; alert: boolean } | null
  /** what it loads, counted from the folder's inventory (lib/loads-view.ts); absent = the At start read's servers */
  tools?: number | null
}

export function agentTabs(i: AgentTabInputs): AgentTabDef[] {
  const src = i.src
  const count = (text: string | null, accent = false): AgentTabSignal => (text === null ? null : { kind: 'count', text, accent })
  const files = src && (src.context || src.produced) ? (src.context?.agent.length ?? 0) + (src.produced?.length ?? 0) + (src.context?.shared.length ?? 0) : null
  const master = i.agentId === MASTER_ID
  const tabs: Omit<AgentTabDef, 'facet'>[] = [
    { id: 'now', label: 'Now', signal: i.live ? { kind: 'dot' } : null },
    { id: 'messages', label: 'Messages', signal: i.inboxNew > 0 ? count(`${i.inboxNew}`, true) : null },
    // what it does without you (owner 24-11): its control, heartbeat,
    // limits and automations — set here; how they went is on Now
    { id: 'automations', label: 'Automations', signal: i.automations ? count(`${i.automations.n}`, i.automations.alert) : null },
    // what it produced sits with what it does; what it knows and can follows (owner 24-11)
    { id: 'files', label: 'Files', signal: count(files !== null ? `${files}` : null) },
    { id: 'memory', label: 'Memory', signal: count(src?.memory ? `${memoryNotes(src.memory).length}` : null) },
    { id: 'skills', label: 'Skills', signal: count(src?.catalog ? `${src.catalog.filter((s) => (s.state ?? 'active') === 'active').length}` : null) },
    {
      id: 'tools',
      label: 'Tools',
      signal: count(i.tools !== undefined ? (i.tools !== null ? `${i.tools}` : null) : src?.loaded ? `${src.loaded.mcp.length}` : null),
    },
    // Anywhere has no secrets of its own to hold — the Vault page is its view
    ...(master ? [] : [{ id: 'secrets' as const, label: 'Secrets', signal: count(i.secrets !== null ? `${i.secrets}` : null) }]),
    {
      id: 'starts',
      label: 'At start',
      signal: count(i.atStartTotal !== null ? `~${i.atStartTotal >= 1000 ? `${Math.round(i.atStartTotal / 1000)}k` : i.atStartTotal}` : null),
    },
    // its profile — who it is and what it runs on (owner 24-11: «Settings»
    // read as every tab's; each other tab edits its own thing) — last and
    // apart; Anywhere (master) has none of its own to edit
    ...(master ? [] : [{ id: 'settings' as const, label: 'Profile', signal: null, apart: true }]),
  ]
  return tabs.map((t) => ({ ...t, facet: AGENT_TAB_FACET[t.id] }))
}

/** The Tools tab's figure — what it loads: its own active servers and, where
 *  its folder is a project, the inventory's things that load there (a plugin
 *  once, its servers with it); without an inventory, the At start read's
 *  servers. One rule for the tab bar and the conversation's agent row. */
export function agentToolsFigure(src: Pick<KnowsSources, 'loads' | 'ownTools' | 'loaded'>): number | null {
  return src.loads && src.loads.engines.length > 0
    ? (src.ownTools ?? []).filter((t) => t.state === 'active').length + topLevel(agentRows(src.loads.rows)).length
    : src.loaded
      ? src.loaded.mcp.length
      : null
}
