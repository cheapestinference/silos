// harnesses/opencode/db — ONE OpenCode database (opencode.db, SQLite),
// opened strictly read-only: `readOnly` at the driver plus
// `PRAGMA query_only = 1`, so not even a mistaken statement here can write
// to a store Silos did not create (invariant 3). Typed queries only; the
// JSON in `message.data` / `part.data` is parsed here and mapped to Silos
// records in map.ts. A row whose `data` does not parse is skipped, never
// thrown — one corrupt row must not hide the rest of the conversation.
// Shapes verified against the real DB (OpenCode 1.14.x).

import { loadSqlite, type DatabaseSync, type DatabaseSyncCtor } from './sqlite.js'

export interface SessionRow {
  id: string
  project_id: string
  parent_id: string | null
  directory: string
  title: string
  version: string
  time_created: number
  time_updated: number
  time_archived: number | null
}

export interface MessageRow {
  id: string
  session_id: string
  time_created: number
  data: MessageData
}
export interface TodoRow {
  content: string
  status: string
  position: number
}
export interface PartRow {
  id: string
  message_id: string
  session_id: string
  time_created: number
  data: PartData
}

type Tokens = { total: number; input: number; output: number; reasoning: number; cache: { read: number; write: number } }

export type MessageData =
  | { role: 'user'; agent?: string; model?: { providerID: string; modelID: string }; time: { created: number } }
  | {
      role: 'assistant'
      agent?: string
      modelID: string
      providerID: string
      cost: number
      tokens: Tokens
      time: { created: number; completed?: number }
      finish?: 'stop' | 'tool-calls' | string
      // The provider refused the turn (APIError 429/401…, or OpenCode's own
      // failure): the message ends with `error` and no `finish`.
      error?: { name?: string; data?: { message?: string; statusCode?: number } }
    }

export type PartData =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | {
      type: 'tool'
      tool: string
      callID: string
      state: {
        status: 'pending' | 'running' | 'completed' | 'error'
        input?: unknown
        output?: string
        title?: string
        time?: { start: number; end?: number }
        error?: string
      }
    }
  | { type: 'step-start' }
  | { type: 'step-finish'; reason?: string; tokens: Tokens; cost: number }
  | { type: 'patch'; files: string[] }
  | { type: 'compaction'; auto?: boolean }

const SESSION_COLS = 'id, project_id, parent_id, directory, title, version, time_created, time_updated, time_archived'

type Raw = { id: string; session_id: string; time_created: number; data: string }

function parsed<T, R extends Raw>(rows: R[]): (Omit<R, 'data'> & { data: T })[] {
  const out: (Omit<R, 'data'> & { data: T })[] = []
  for (const r of rows) {
    let data: unknown
    try {
      data = JSON.parse(r.data)
    } catch {
      continue
    }
    if (!data || typeof data !== 'object') continue
    out.push({ ...r, data: data as T })
  }
  return out
}

export class OpenCodeDb {
  private readonly db: DatabaseSync

  // `sqlite` is injectable so a Node without node:sqlite can be tested.
  constructor(path: string, sqlite: () => DatabaseSyncCtor = loadSqlite) {
    const DatabaseSync = sqlite()
    this.db = new DatabaseSync(path, { readOnly: true })
    this.db.exec('PRAGMA query_only = 1')
  }

  sessions(): SessionRow[] {
    return this.db.prepare(`select ${SESSION_COLS} from session order by time_updated desc`).all() as unknown as SessionRow[]
  }

  session(id: string): SessionRow | null {
    return (this.db.prepare(`select ${SESSION_COLS} from session where id = ?`).get(id) as unknown as SessionRow | undefined) ?? null
  }

  /** The sessions this one spawned (subagents: `parent_id`), oldest first. */
  children(parentId: string): SessionRow[] {
    return this.db.prepare(`select ${SESSION_COLS} from session where parent_id = ? order by time_created, id`).all(parentId) as unknown as SessionRow[]
  }

  messages(sessionId: string): MessageRow[] {
    const rows = this.db
      .prepare('select id, session_id, time_created, data from message where session_id = ? order by time_created, id')
      .all(sessionId) as unknown as Raw[]
    return parsed<MessageData, Raw>(rows)
  }

  // In conversation order: by their message, then by the part's own time.
  parts(sessionId: string): PartRow[] {
    const rows = this.db
      .prepare(
        `select p.id, p.message_id, p.session_id, p.time_created, p.data
                from part p join message m on m.id = p.message_id
                where p.session_id = ?
                order by m.time_created, m.id, p.time_created, p.id`,
      )
      .all(sessionId) as unknown as (Raw & { message_id: string })[]
    return parsed<PartData, Raw & { message_id: string }>(rows)
  }

  // The session's checklist (its `todowrite` tool keeps the WHOLE list in
  // the `todo` table), in list order. A database without the table (an
  // older OpenCode) has none — never a throw.
  todos(sessionId: string): TodoRow[] {
    try {
      return this.db.prepare('select content, status, position from todo where session_id = ? order by position').all(sessionId) as unknown as TodoRow[]
    } catch {
      return []
    }
  }

  // Sessions touched after `ms` — the cheap poll a watcher diffs against.
  updatedSince(ms: number): { id: string; time_updated: number }[] {
    return this.db.prepare('select id, time_updated from session where time_updated > ? order by time_updated').all(ms) as unknown as {
      id: string
      time_updated: number
    }[]
  }

  close(): void {
    this.db.close()
  }
}
