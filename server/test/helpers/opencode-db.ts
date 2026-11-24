// Builds a THROWAWAY OpenCode database for tests: the schema captured from
// a real DB (fixtures/opencode/schema.sql, DDL only) plus the
// synthetic rows each test inserts. Read-write on the temp file only — the
// owner's ~/.local/share/opencode/opencode.db is never touched.
//
// node:sqlite comes through src/harnesses/opencode/sqlite.ts — the same
// module production uses — which silences its ExperimentalWarning.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadSqlite } from '../../src/harnesses/opencode/sqlite.js'

export const DatabaseSync = loadSqlite()

const SCHEMA = join(import.meta.dirname, '..', 'fixtures', 'opencode', 'schema.sql')

export interface TestSession {
  id: string
  project_id: string
  parent_id?: string | null
  slug?: string
  directory: string
  title: string
  version: string
  time_created: number
  time_updated: number
  time_archived?: number | null
}
export interface TestMessage {
  id: string
  session_id: string
  time_created: number
  data: unknown
}
export interface TestPart {
  id: string
  message_id: string
  session_id: string
  time_created: number
  data: unknown
}

export function makeOpenCodeDb(dir: string) {
  const path = join(dir, 'opencode.db')
  const db = new DatabaseSync(path)
  db.exec('PRAGMA synchronous = OFF') // a throwaway file: no fsync per insert
  db.exec(readFileSync(SCHEMA, 'utf8'))
  return {
    path,
    insertSession(s: TestSession) {
      // session.project_id is a FK — the project row is implied.
      db.prepare(`insert or ignore into project (id, worktree, time_created, time_updated, sandboxes) values (?, ?, ?, ?, '[]')`).run(
        s.project_id,
        s.directory,
        s.time_created,
        s.time_created,
      )
      db.prepare(
        `insert into session (id, project_id, parent_id, slug, directory, title, version, time_created, time_updated, time_archived)
                  values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(s.id, s.project_id, s.parent_id ?? null, s.slug ?? s.id, s.directory, s.title, s.version, s.time_created, s.time_updated, s.time_archived ?? null)
    },
    insertMessage(m: TestMessage) {
      db.prepare(`insert into message (id, session_id, time_created, time_updated, data) values (?, ?, ?, ?, ?)`).run(
        m.id,
        m.session_id,
        m.time_created,
        m.time_created,
        JSON.stringify(m.data),
      )
    },
    insertPart(p: TestPart) {
      db.prepare(`insert into part (id, message_id, session_id, time_created, time_updated, data) values (?, ?, ?, ?, ?, ?)`).run(
        p.id,
        p.message_id,
        p.session_id,
        p.time_created,
        p.time_created,
        JSON.stringify(p.data),
      )
    },
    insertTodo(t: { session_id: string; content: string; status: string; position: number; priority?: string }) {
      db.prepare(`insert into todo (session_id, content, status, priority, position, time_created, time_updated) values (?, ?, ?, ?, ?, 0, 0)`).run(
        t.session_id,
        t.content,
        t.status,
        t.priority ?? 'high',
        t.position,
      )
    },
    // An OpenCode write touches the session row too: what updatedSince() polls.
    touchSession(id: string, time_updated: number) {
      db.prepare('update session set time_updated = ? where id = ?').run(time_updated, id)
    },
    close() {
      db.close()
    },
  }
}
