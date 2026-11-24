// folder-identity.ts — what makes two folder paths the SAME folder: the
// engine reads <folder>/.claude/… through the filesystem, so a symlinked
// folder and its target are one folder to it. Every place that compares
// folder identity for capability states (the held-skills store key, the
// catalog's "another agent's folder", ~/.claude.json's per-project entry)
// compares canonicalFolder(), never the raw string.
import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'

/** The folder's realpath; the resolved path when it can't be resolved (the
 *  folder doesn't exist yet, or any more) — never a throw. */
export function canonicalFolder(folder: string): string {
  const abs = resolve(folder)
  try {
    return realpathSync(abs)
  } catch {
    return abs
  }
}

/** Same folder to the engine? */
export function sameFolder(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false
  return a === b || canonicalFolder(a) === canonicalFolder(b)
}
