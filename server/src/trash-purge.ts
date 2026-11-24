// trash-purge.ts — the trash empties itself after 30
// days. Invariant 3 still holds for every DELETE the owner
// makes: it moves to ~/.silos/trash, never rm. This is the second step the
// owner chose: what has sat in the trash longer than the window is gone.
//
// "Since when is it in the trash" = the entry's ctime: trashing is a rename,
// which stamps ctime and keeps mtime (mtime still says when the transcript
// was last written, which is not the question). Entries are the top level
// of trash/<folder>/ — a transcript `<id>.jsonl` and its `<id>/` sidecar
// dir, each judged on its own stamp (both renamed in the same instant).
// A folder left empty is removed too. Nothing outside the trash dir is
// ever touched; a failure on one entry never stops the rest.
import { lstatSync, readdirSync, rmSync, rmdirSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'

export const TRASH_KEEP_MS = 30 * 24 * 3600_000
export const TRASH_PURGE_INTERVAL_MS = 6 * 3600_000

export function purgeTrash(trashDir: string, now = Date.now(), keepMs = TRASH_KEEP_MS): { removed: number } {
  const base = resolve(trashDir)
  let removed = 0
  let folders: string[]
  try {
    folders = readdirSync(base)
  } catch {
    return { removed } // no trash yet
  }
  for (const folder of folders) {
    const dir = join(base, folder)
    let entries: string[]
    try {
      if (!lstatSync(dir).isDirectory()) continue
      entries = readdirSync(dir)
    } catch {
      continue
    }
    for (const name of entries) {
      const path = join(dir, name)
      if (!resolve(path).startsWith(base + sep)) continue // never outside the trash
      try {
        if (now - lstatSync(path).ctimeMs <= keepMs) continue
        rmSync(path, { recursive: true, force: true })
        removed++
      } catch {
        /* best effort — the next pass retries */
      }
    }
    try {
      if (readdirSync(dir).length === 0) rmdirSync(dir)
    } catch {
      /* not empty or gone */
    }
  }
  return { removed }
}
