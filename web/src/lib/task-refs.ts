// task-refs.ts — the `plan#id` references inside free text (a note's words):
// each one a task the reading knows becomes a door with its card (study proposal
// 10); one it does not know stays the plain text it was, never a dead link.
import type { TaskView } from './tasks'

// plan#id, not inside a word or a URL's path, its trailing punctuation left out
const REF = /(^|[^\w#/-])([a-z0-9][a-z0-9._-]*#[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?)/gi

export type TextPart<T> = string | { ref: string; task: T }

export function splitTaskRefs<T>(text: string, resolve: (ref: string) => T | null): Array<TextPart<T>> {
  const out: Array<TextPart<T>> = []
  let plain = ''
  let last = 0
  for (const m of text.matchAll(REF)) {
    const ref = m[2]!
    const task = resolve(ref)
    if (task === null) continue
    const at = m.index + m[1]!.length
    plain += text.slice(last, at)
    if (plain !== '') out.push(plain)
    plain = ''
    out.push({ ref, task })
    last = at + ref.length
  }
  plain += text.slice(last)
  if (plain !== '') out.push(plain)
  return out
}

// Which task a reference names, seen from another: two plans in two projects
// can share a slug, so its own plan first, then its own project, then any.
// The reference (tasks#t3) or the label a screen painted (<project>#t3)
// — both name the same task.
export function taskOfRef(ref: string, tasks: readonly TaskView[], from?: Pick<TaskView, 'planKey' | 'folder'>): TaskView | null {
  const hits = tasks.filter((t) => t.ref === ref || t.label === ref)
  if (hits.length <= 1) return hits[0] ?? null
  const own = hits.find((t) => t.planKey === from?.planKey) ?? hits.find((t) => t.folder === from?.folder)
  return own ?? hits[0]!
}
