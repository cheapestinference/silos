// record-writers.ts — the conversations that WROTE a record's file (task-view
// phase 2: a task page says «Created from <plan> by <who>»). Read from what
// each conversation's transcript did to the path — a Write/Edit, or a mention
// of the path in a tool's input (context.ts attributePlanMentions) — never guessed
// from a field the file may not carry: a plan names no author, so the answer
// is the transcripts' or nothing. Generic for any silo record with a file
// (the record route answers it). A conversation's mtime is its last activity,
// not its birth, so the list is newest first and the page says WHO wrote it,
// never who wrote it first.
import type { SessionMeta } from './types.js'

export interface RecordWriter {
  folder: string
  id: string
  agentId: string
  title: string
  mtime: number
}

export function recordWriters(
  file: string,
  sessions: readonly SessionMeta[],
  o: {
    filesOf(folder: string, id: string): ReadonlyArray<{ path: string; edits: number; writes: number; disk?: number }> | undefined
    agentOf(m: SessionMeta): string
  },
  limit = 5,
): RecordWriter[] {
  const out: RecordWriter[] = []
  for (const m of sessions) {
    const files = o.filesOf(m.folder, m.id) ?? []
    if (!files.some((f) => f.path === file && f.edits + f.writes + (f.disk ?? 0) > 0)) continue
    out.push({ folder: m.folder, id: m.id, agentId: o.agentOf(m), title: m.title, mtime: m.mtime })
  }
  return out.sort((a, b) => b.mtime - a.mtime).slice(0, limit)
}
