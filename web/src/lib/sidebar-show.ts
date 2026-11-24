// sidebar-show.ts — which of an agent's conversations the sidebar lists.
//
// The rule:
// the sidebar lists the conversations YOU started; work Silos starts on its
// own lives under its cause. An automation's run → its automation's page;
// its kept thread (⚡) → the same page; a conversation Silos
// once opened for a message (✉, history — no message wakes anyone
// any more) → the agent's Inbox, beside the message and its
// answer; a conversation Task mode opened for a task → that task's
// page. The list never grows with the traffic between agents.
//
// Never hidden: the conversation open right now (you must see where you
// are), and anything a typed search matches (a search finds everything).
import { isBeatAutomation } from './automations-signal'
import type { SessionView } from './types'

export type ConversationKind = 'own' | 'kept' | 'message' | 'task' | 'run'

export function conversationKind(s: Pick<SessionView, 'id' | 'origin'>, keptBy: ReadonlyMap<string, string>): ConversationKind {
  if (keptBy.has(s.id)) return 'kept'
  if (s.origin === undefined) return 'own'
  if (s.origin.kind === 'message') return 'message'
  if (s.origin.kind === 'task') return 'task'
  return 'run'
}

// The sessions that may become rows: your own always; a kept thread, a
// message or a task conversation only while open or matched by a search;
// runs never.
export function listedConversations<S extends Pick<SessionView, 'id' | 'folder' | 'origin'>>(
  sessions: readonly S[],
  keptBy: ReadonlyMap<string, string>,
  opts: { searching: boolean; isOpen: (s: S) => boolean },
): S[] {
  return sessions.filter((s) => {
    const kind = conversationKind(s, keptBy)
    if (kind === 'own') return true
    if (kind === 'run') return false
    return opts.searching || opts.isOpen(s)
  })
}

// ---- why a conversation exists (C1) -------------------------------------------
//
// Every list that shows a conversation the sidebar would not list says its
// CAUSE on its quiet line (Home's Working now and Done today, the agent
// page's Now): without it the owner cannot tell a task wake, a run, a
// heartbeat and a nested `claude -p` from a conversation of their own.
// Data first (testable), words beside it; precedence: an open task it works
// outranks every origin (a Task mode wake claims its task at start, so it
// reads like any conversation working that task).
export type ConversationCause =
  | { kind: 'task'; title: string; more: number }
  | { kind: 'nested'; parent: string | null }
  | { kind: 'kept'; automation: string }
  | { kind: 'heartbeat' }
  | { kind: 'run'; automation: string | null }
  | { kind: 'message' }
  | { kind: 'born-of-task'; ref: string }

export interface CauseFacts {
  /** open tasks this conversation works (useOpenTasksBySession) */
  tasks?: ReadonlyArray<{ title: string }>
  /** kept thread → its automation's name, fleet-wide */
  keptBy?: ReadonlyMap<string, string>
  /** an automation's name by id, null when it no longer exists */
  automationName?: (id: string) => string | null
  /** a session's title by id, for a nested run's parent */
  parentTitle?: (sessionId: string) => string | null
}

export function conversationCause(s: Pick<SessionView, 'id' | 'origin'>, facts: CauseFacts): ConversationCause | null {
  const tasks = facts.tasks ?? []
  if (tasks.length > 0) return { kind: 'task', title: tasks[0]!.title, more: tasks.length - 1 }
  const o = s.origin
  if (o?.kind === 'nested') return { kind: 'nested', parent: (o.parent !== null ? facts.parentTitle?.(o.parent) : null) ?? null }
  const kept = facts.keptBy?.get(s.id)
  if (kept !== undefined) return { kind: 'kept', automation: kept }
  if (o?.kind === 'automation') {
    // the one beat predicate (automations-signal.ts), never a scattered check
    if (isBeatAutomation({ id: o.automationId })) return { kind: 'heartbeat' }
    return { kind: 'run', automation: facts.automationName?.(o.automationId) ?? null }
  }
  if (o?.kind === 'message') return { kind: 'message' }
  if (o?.kind === 'task') return { kind: 'born-of-task', ref: o.ref }
  return null
}

// the words other surfaces already use for each cause (Chat's footer,
// the sidebar's marks) — one voice
export function causeWords(c: ConversationCause | null): string | null {
  if (c === null) return null
  switch (c.kind) {
    case 'task':
      return `on “${c.title}”${c.more > 0 ? ` +${c.more}` : ''}`
    case 'nested':
      return c.parent !== null ? `nested run from “${c.parent}”` : 'nested run'
    case 'kept':
      return `kept by automation ${c.automation}`
    case 'heartbeat':
      return 'heartbeat'
    case 'run':
      return c.automation !== null ? `run of “${c.automation}”` : 'run of an automation'
    case 'message':
      return 'opened for a message'
    case 'born-of-task':
      return `task ${c.ref}`
  }
}
