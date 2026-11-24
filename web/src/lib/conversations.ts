// conversations.ts — a flat timeline of ALL conversations (every agent),
// used by the Conversations dimension (a sidebar grouped by
// today/week/older) and by the ⌘K palette (CommandPalette.tsx) — the same
// source, the same matching, no duplicated logic between the two surfaces.
import { MASTER_ID } from './constants'
import { clearedKeys } from './grouping'
import { basename } from './routes'
import { DAY_MS, WEEK_MS } from './rel-time'
import type { AgentView } from './types'

export interface ConversationItem {
  folder: string
  id: string
  title: string
  agentId: string
  agentName: string
  agentEmoji: string
  project: string | null
  skills: string[]
  mtime: number
  // an automation's conversation (SessionView.origin) — ⌘K labels it,
  // never hides it.
  automationId?: string
  // a conversation a /clear left behind (lib/grouping clearedKeys): the
  // sidebar never lists it, search does — marked so the owner knows
  archived?: true
}

// flattens agents[].sessions[] into a single list, sorted by recent
// activity — the source of truth already lives in the store (overview),
// no fetch of its own.
export function allConversations(agents: AgentView[]): ConversationItem[] {
  const out: ConversationItem[] = []
  for (const a of agents) {
    const name = a.id === MASTER_ID ? 'Anywhere' : a.name
    const emoji = a.id === MASTER_ID ? '✳' : a.emoji
    const cleared = clearedKeys(a.sessions)
    for (const s of a.sessions) {
      out.push({
        folder: s.folder,
        id: s.id,
        title: s.title,
        agentId: a.id,
        agentName: name,
        agentEmoji: emoji,
        project: s.cwd ?? a.folder,
        skills: s.skills,
        mtime: s.mtime,
        ...(s.origin?.kind === 'automation' ? { automationId: s.origin.automationId } : {}),
        ...(cleared.has(`${s.folder}/${s.id}`) ? { archived: true as const } : {}),
      })
    }
  }
  return out.sort((x, y) => y.mtime - x.mtime)
}

// the same "matches" criterion as the rest of the app (title/skill; here
// also agent and project — this is a cross-cutting search, not a single
// session list's local filter).
export function matchesConversation(item: ConversationItem, filter: string): boolean {
  const q = filter.trim().toLowerCase()
  if (!q) return true
  if (item.title.toLowerCase().includes(q)) return true
  if (item.agentName.toLowerCase().includes(q)) return true
  if (item.project && basename(item.project).toLowerCase().includes(q)) return true
  return item.skills.some((sk) => sk.toLowerCase().includes(q))
}

export type TimeBucket = 'today' | 'week' | 'older'

export function timeBucket(mtime: number, now: number): TimeBucket {
  const diff = now - mtime
  if (diff < DAY_MS) return 'today'
  if (diff < WEEK_MS) return 'week'
  return 'older'
}

export const TIME_BUCKET_LABEL: Record<TimeBucket, string> = {
  today: 'Today',
  week: 'This week',
  older: 'Older',
}

export const TIME_BUCKET_ORDER: readonly TimeBucket[] = ['today', 'week', 'older']
