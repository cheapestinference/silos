// store/selectors.ts — pure reads over the store's state. Re-exported from
// ../store.ts.
import type { AgentView, SessionView } from '../lib/types'
import type { State } from './state'

// the overview's view of a session (its sidebar row): title, folder, cwd —
// known BEFORE the transcript fetch. Opening a known conversation must never
// show anything it isn't: the header and the subtitle read
// this while `detail` is still null, and only the transcript shows a loader.
export function sessionViewOf(agents: readonly AgentView[], sel: { folder: string; id: string } | null): SessionView | null {
  if (!sel) return null
  for (const a of agents) {
    const s = a.sessions.find((x) => x.folder === sel.folder && x.id === sel.id)
    if (s) return s
  }
  return null
}

// the composer draft's key (State.drafts): the open conversation, or the
// agent's new chat.
export function draftKeyOf(sel: { folder: string; id: string } | null, agentId: string | null): string {
  return sel ? `${sel.folder}/${sel.id}` : `new:${agentId ?? ''}`
}

// is the streaming turn's conversation ON SCREEN?
// The global Esc cancels a turn only then: the agent page of the turn's
// agent, with the conversation view mounted (a selected conversation, or
// the new chat), and the selected conversation IS the turn's one (a new
// chat's turn has no sessionKey until chat-init).
export function turnOnScreen(s: Pick<State, 'active' | 'page' | 'selected' | 'newChatOpen'>): boolean {
  const a = s.active
  if (!a || a.status !== 'streaming') return false
  if (s.page && s.page.kind !== 'agent') return false
  if (s.selected) return a.sessionKey === `${s.selected.folder}/${s.selected.id}`
  // no page yet: AgentPage's cold-start fallback IS the chat (Chat.tsx)
  if (s.page === null) return true
  return s.newChatOpen && !a.sessionKey && a.agentId === s.page.id
}
