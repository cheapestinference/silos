// task-link.ts — the owner ties a conversation to a task and lets it go.
//
// Link: ONE owner link, the server's (ownerLink, POST /api/tasks/link) — ⌘K
// «Link this conversation to a task…» and «Make this a task» call it, as
// «Work on this» does. A pending or in-progress task is claimed (linked +
// in_progress); a blocked or in-review one is listed and keeps its state (the
// header says «Linked to «x»»).
//
// Unlink: the release verb, never an edit of conversations[] — the thread
// stays in the task's history and stops being its holder. «Unlink…» offers a
// choice of what the task becomes only when it is in progress and this is
// its LAST current thread (releaseOffersChoice); the server writes that state
// in the same write as the mark, and answers what it did (releaseWords). A
// «blocked» names on whom in that SAME write (the release's `wait`)
// — nothing is written before it, nothing taken back after.
import { api, type ReleaseAnswer, type ReleaseState } from './api'
import { refreshTasks, refreshTasksBySession } from '../hooks/useTasks'
import type { TaskView } from './tasks'

export async function linkConversation(taskKey: string, sessionId: string): Promise<{ warn: string | null }> {
  const r = await api.tasksLink({ key: taskKey, session: sessionId })
  const warn = typeof r?.warn === 'string' && r.warn !== '' ? r.warn : null
  refreshTasks()
  refreshTasksBySession()
  return { warn }
}

// the dispositions, in the order offered — «to pick up» first (the default)
export const RELEASE_CHOICES: ReadonlyArray<{ state: ReleaseState; words: string }> = [
  { state: 'pending', words: 'to pick up' },
  { state: 'done', words: 'done' },
  { state: 'blocked', words: 'blocked' },
  { state: 'in_review', words: 'in review' },
]

// the choice exists only where the server will honour it: the task is in
// progress and no other conversation is current on it
export function releaseOffersChoice(t: Pick<TaskView, 'state' | 'currentConversations'>): boolean {
  return t.state === 'in_progress' && t.currentConversations.length === 1
}

const STATE_WORDS: Record<string, string> = {
  pending: 'to pick up',
  in_progress: 'in progress',
  in_review: 'in review',
  blocked: 'blocked',
  done: 'done',
  cancelled: 'dropped',
}
export const stateWords = (s: string): string => STATE_WORDS[s] ?? s.replace('_', ' ')

// what the server did, in words: «Unlinked — it is done now», «Unlinked — it
// stays in progress», «Already unlinked — it stays blocked»
export function releaseWords(r: ReleaseAnswer | null | undefined, asked?: ReleaseState): string {
  if (r?.already) return `Already unlinked${r.kept ? ` — it stays ${stateWords(r.kept)}` : ''}.`
  if (r?.kept) return `Unlinked — it stays ${stateWords(r.kept)}${r.kept === 'in_progress' ? ' (another conversation is on it)' : ''}.`
  const now = r?.disposed ?? r?.state ?? asked ?? 'pending'
  return `Unlinked — it is ${stateWords(now)} now.`
}

// What a «blocked» waits on (never a blocker nobody owns): the owner,
// or someone named, and what for — written by the release itself
export interface UnlinkWait {
  owner: string
  action: string
}

// «Unlink…» — the ONE path for the task page's sheet and ⌘K:
// ONE release, with what the task becomes and, for «blocked», on whom (the
// server writes the wait only when the release does leave it blocked; sent
// without one, it names you only when nothing else holds the task)
export async function unlinkConversation(
  taskKey: string,
  sessionId: string,
  state?: ReleaseState,
  wait?: UnlinkWait | null,
): Promise<{ warn: string | null; said: string; answer: ReleaseAnswer | null }> {
  const r = await api.tasksRelease({ key: taskKey, session: sessionId, ...(state ? { state } : {}), ...(state === 'blocked' && wait ? { wait } : {}) })
  refreshTasks()
  refreshTasksBySession()
  const said = releaseWords(r, state)
  const unwritten = state === 'blocked' && wait && !r?.wait ? " It isn't blocked, so no wait was written." : ''
  return { warn: typeof r?.warn === 'string' && r.warn !== '' ? r.warn : null, said: `${said}${unwritten}`, answer: r ?? null }
}
