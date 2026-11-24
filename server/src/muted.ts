import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

// muted.json — folders under <root>/projects that never reach the product:
// a hand-edited JSON array of projects-dir names (the engine's encoding of a
// path, e.g. a plugin's own observer sessions). Filtered server-side before
// indexing/watching; no toggle, no endpoint writes it (GET /api/muted reads
// it). Absent = nothing muted — Silos never creates it. A corrupt file logs a
// warning and mutes nothing, but is never overwritten: the owner could be
// editing it by hand.
export function loadMuted(dataDir: string): string[] {
  const file = join(dataDir, 'muted.json')
  if (!existsSync(file)) return []
  try {
    const raw: unknown = JSON.parse(readFileSync(file, 'utf8'))
    if (!Array.isArray(raw) || !raw.every((x) => typeof x === 'string')) {
      throw new Error('muted.json must be an array of strings')
    }
    return raw
  } catch (err) {
    console.warn('invalid muted.json, muting nothing without touching the file:', err instanceof Error ? err.message : err)
    return []
  }
}
