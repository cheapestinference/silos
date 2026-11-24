// silos/child-digest.ts — a child's digest: its DECLARED fields, in the
// sub-kind's order, as written. What an append-item event records of the
// child it wrote (the whole text, never clipped — silos/actions.ts
// appendItem), and what task-mode/owner-notes.ts recomputes from the file to
// know that event wrote THAT child.
import { createHash } from 'node:crypto'

export function childDigest(item: Record<string, unknown>, fieldNames: readonly string[]): string {
  return createHash('sha256')
    .update(JSON.stringify(fieldNames.map((f) => item[f] ?? null)))
    .digest('hex')
}
