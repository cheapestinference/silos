// task-ref.ts — the ONE form a task is said by: a task
// of a standing record (the project's list) is said by its project,
// `<project>#t3`, or `<project>/<list>#t3` when the same place also holds a
// record named like the project (the two would read alike); any other
// parent: `<parent id>#<id>`. Task mode's refs (wakes, claim answers), the
// rows' labels and the conversation's tasks (the /clear reminder) all say it
// this way — and the claim/release API reads every form back
// (routes/console.ts findTask).
import { basename } from 'node:path'

export function taskRefOf(o: { parentId: string; id: string; place: string | null; standing: boolean; idsHere: () => Iterable<string> }): string {
  if (!o.standing || o.place === null) return `${o.parentId}#${o.id}`
  const base = basename(o.place)
  if (base === '') return `${o.parentId}#${o.id}`
  return [...o.idsHere()].includes(base) ? `${base}/${o.parentId}#${o.id}` : `${base}#${o.id}`
}
