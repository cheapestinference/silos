// task-seen.ts — «new to you»: a task another
// wrote on since the owner last opened it reads in semibold; no dot, no view, no
// «mark as unread». The marks are the owner's, on the server (server/src/
// task-seen-store.ts); this only reads them against the task as the plan says it.
import { isHumanOwner, type TaskView } from './tasks'

export interface SeenMark {
  at: number
  state: string
}
export interface SeenBook {
  since: number
  seen: Readonly<Record<string, SeenMark>>
}

// the owner's own note: one the server saw the owner write (`fromOwner`), or
// one under the name the plan's task uses for that person
function noteIsTheirs(n: Pick<TaskView['notes'][number], 'by' | 'fromOwner'>, t: Pick<TaskView, 'owner'>, agentIds: ReadonlySet<string>): boolean {
  return n.fromOwner || (n.by === t.owner && isHumanOwner(t.owner, agentIds))
}

// New: a note by someone else after the mark, or a state other than the one the
// owner left it in. Never looked at: only what happened after the book opened,
// so the first day is not the whole history in bold. An undated note is no event.
export function isNewToYou(t: Pick<TaskView, 'key' | 'owner' | 'state' | 'notes' | 'moved'>, book: SeenBook, agentIds: ReadonlySet<string>): boolean {
  const mark = book.seen[t.key]
  const after = mark?.at ?? book.since
  if (t.notes.some((n) => !noteIsTheirs(n, t, agentIds) && Date.parse(n.at) > after)) return true
  return mark ? mark.state !== t.state : (t.moved ?? 0) > book.since
}

export function newTaskKeys(tasks: readonly TaskView[], book: SeenBook | null, agentIds: ReadonlySet<string>): ReadonlySet<string> {
  if (!book) return new Set()
  return new Set(tasks.filter((t) => isNewToYou(t, book, agentIds)).map((t) => t.key))
}

// A reading from the server never takes back a mark made here since it left.
export function mergeBook(book: SeenBook, incoming: SeenBook): SeenBook {
  const seen: Record<string, SeenMark> = { ...incoming.seen }
  for (const [k, m] of Object.entries(book.seen)) if ((seen[k]?.at ?? -1) < m.at) seen[k] = m
  return { since: incoming.since, seen }
}
