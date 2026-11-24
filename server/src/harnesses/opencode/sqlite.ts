// harnesses/opencode/sqlite — the ONE place node:sqlite is loaded, and only
// when an OpenCode database is actually opened: node:sqlite exists from
// Node 22.5 (unflagged from 22.13), and a server on an older Node must still
// boot — the reader catches a failed load and reads no OpenCode sessions.
// Node prints an ExperimentalWarning on the first load; the filter installed
// here drops that one warning (and only that one) from logs and test output.
import { createRequire } from 'node:module'

export type DatabaseSyncCtor = typeof import('node:sqlite').DatabaseSync
export type DatabaseSync = import('node:sqlite').DatabaseSync

let ctor: DatabaseSyncCtor | null = null

function silenceExperimentalWarning(): void {
  const emitWarning = process.emitWarning.bind(process)
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    const text = typeof warning === 'string' ? warning : warning.message
    if (/SQLite is an experimental feature/.test(text)) return
    return (emitWarning as (...a: unknown[]) => void)(warning, ...rest)
  }) as typeof process.emitWarning
}

/** node:sqlite's DatabaseSync; throws when this Node lacks the module. */
export function loadSqlite(): DatabaseSyncCtor {
  if (ctor) return ctor
  silenceExperimentalWarning()
  ctor = (createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite')).DatabaseSync
  return ctor
}
