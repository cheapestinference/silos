// loads-scopes.ts — what Silos keeps for the LAUNCH places of «Where it
// loads» (spec scopes §6): <dataDir>/loads-scopes.json, 0600, the server its
// only writer (seal-regimes.ts `restore`; a top-level `*.json`, so outside
// every fenced agent's tools — territory.ts DATA_DIR_FILES_DENIED). Never in
// an agent's state dir: the agent writes there.
//
//   { "agents":        { "<agent id>":  { "<engine id>": { "entries": …, "at": { "<row key>": ms } } } },
//     "conversations": { "<thread id>": { "<engine id>": { … } } },   — the same shape
//     "folders":       { "<folder>":    { "<engine id>": { … } } },   — an engine whose project place is carried (OpenCode, T13)
//     "undo":          { "<place>":     { … } } }                        — each place's last bulk click (T11)
//
// `entries` is the engine's own payload: neutral code keeps it and never
// reads inside — the engine validates it against its allowlist whenever it
// is handed one (at a switch and at every launch). `at` is neutral: the
// time of each row's own entry, by row key (proof, spec §7) — never one
// time for a whole payload; a row whose entry goes loses its time.
//
// `undo` (spec scopes §4, T11): ONE set per place — `project:<folder>`,
// `machine`, `agent:<id>` (`placeKey`) — the last «Turn all off / on» there:
// the head it was clicked on, the folder whose rows it named, and each item
// it changed with its entry at that place before and after (the line's own
// `entry`, a word of the contract — never inside a payload). The next bulk
// click there replaces it; it is dropped when used or once the place no
// longer reads as the click left it (folder-loads.ts).
//
// An archived agent keeps its entries; an agent the roster no longer has
// loses them (`prune`). A role pack never carries them (role-pack.ts reads
// nothing here: they name this machine's things).
//
// Names are data: a row key such as `plugin:__proto__@x` is a key like any
// other (every map is built with own data properties).
import { chmodSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteJson, backupCorruptJson } from './json-store.js'

export const LOADS_SCOPES_FILE = 'loads-scopes.json'
/** A conversation's entries outlive the index's ignorance of its thread
 *  this long (the pins' window, conversation-prefs.ts). */
export const CONVERSATION_GRACE_MS = 10 * 60_000

/** A launch place's kind in the store: an agent, (T5) a conversation's
 *  thread, or a folder — the project's place of an engine that carries it
 *  at launch (spec scopes §9: OpenCode's project is the launch's too). */
export type CarriedPlace = 'agents' | 'conversations' | 'folders'

export interface CarriedRecord {
  /** the engine's own payload (never read here) */
  entries: unknown
  /** each row's own entry time, ms */
  at: Record<string, number>
}

type Json = Record<string, unknown>
type Places = Record<string, Record<string, CarriedRecord>>

const isMap = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v)
const own = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k)
const put = <T>(o: Record<string, T>, k: string, v: T): void => {
  Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true })
}

function placesOf(raw: unknown): Places {
  const out: Places = {}
  if (!isMap(raw)) return out
  for (const [id, engines] of Object.entries(raw)) {
    if (!isMap(engines)) continue
    const byEngine: Record<string, CarriedRecord> = {}
    for (const [engine, rec] of Object.entries(engines)) {
      if (!isMap(rec) || rec.entries === undefined || rec.entries === null) continue
      const at: Record<string, number> = {}
      if (isMap(rec.at)) for (const [k, v] of Object.entries(rec.at)) if (typeof v === 'number' && Number.isFinite(v)) put(at, k, v)
      put(byEngine, engine, { entries: rec.entries, at })
    }
    if (Object.keys(byEngine).length > 0) put(out, id, byEngine)
  }
  return out
}

/** A place's entry for one item, before and after a bulk click (absent:
 *  none — it followed the line above). */
export interface UndoItem {
  before?: string
  after?: string
}

/** One place's last bulk click (spec scopes §4). */
export interface BulkUndoRecord {
  engine: string
  /** the folder whose inventory named the rows */
  folder: string
  /** the head it was clicked on (the screen's own id: a group, the tab) */
  group: string
  to: 'on' | 'off'
  /** when, ms */
  at: number
  rows: Record<string, UndoItem>
  origins: Record<string, UndoItem>
  /** what it changed, by kind — the sentence beside «Undo» */
  counts: Record<string, number>
  /** a click on skills (rows keyed `<from>:<name>`, a folder copy moved
   *  out or back `store:<name>`; an entry may be any position) — absent:
   *  on tools (an entry is on or off) */
  kind?: 'skills'
}

/** The undo set's key for a place. */
export function placeKey(
  at: { scope: 'project'; folder: string } | { scope: 'machine' } | { scope: 'agent'; agent: string } | { scope: 'conversation'; thread: string },
): string {
  return at.scope === 'project'
    ? `project:${at.folder}`
    : at.scope === 'machine'
      ? 'machine'
      : at.scope === 'agent'
        ? `agent:${at.agent}`
        : `conversation:${at.thread}`
}

const ENTRY_WORDS: readonly unknown[] = ['on', 'off']
/** a skill's entry: a position, or a value found by hand (kept as found) */
const SKILL_ENTRY = /^[a-z][a-z-]{0,39}$/
function itemsOf(raw: unknown, skills = false): Record<string, UndoItem> | null {
  if (!isMap(raw)) return null
  const out: Record<string, UndoItem> = {}
  const ok = (v: unknown): boolean => v === undefined || (skills ? typeof v === 'string' && SKILL_ENTRY.test(v) : ENTRY_WORDS.includes(v))
  for (const [k, v] of Object.entries(raw)) {
    if (!isMap(v)) return null
    if (!ok(v.before) || !ok(v.after)) return null
    put(out, k, { ...(v.before !== undefined ? { before: v.before as string } : {}), ...(v.after !== undefined ? { after: v.after as string } : {}) })
  }
  return out
}
/** A kept record as read — anything of another shape is not one. */
function undoOf(raw: unknown): BulkUndoRecord | null {
  if (!isMap(raw)) return null
  const { engine, folder, group, to, at } = raw
  if (
    typeof engine !== 'string' ||
    typeof folder !== 'string' ||
    typeof group !== 'string' ||
    (to !== 'on' && to !== 'off') ||
    typeof at !== 'number' ||
    !Number.isFinite(at)
  )
    return null
  if (raw.kind !== undefined && raw.kind !== 'skills') return null
  const skills = raw.kind === 'skills'
  const rows = itemsOf(raw.rows, skills),
    origins = itemsOf(raw.origins ?? {})
  if (!rows || !origins) return null
  const counts: Record<string, number> = {}
  if (isMap(raw.counts)) for (const [k, v] of Object.entries(raw.counts)) if (typeof v === 'number' && Number.isInteger(v) && v >= 0) put(counts, k, v)
  return { engine, folder, group, to, at, rows, origins, counts, ...(skills ? { kind: 'skills' as const } : {}) }
}

/** The slow sweep (the resident's heartbeat, beside the pins'): the entries
 *  of a conversation the index no longer knows go — ONLY with a warm index
 *  (during warmup it knows nothing and would sweep every one), and never
 *  within the grace of the record's newest row time. A thread is known
 *  while the index has its root or any session on it. */
export function sweepLostConversations(
  store: Pick<LoadsScopesStore, 'ids' | 'sweepConversations'>,
  index: { isReady(): boolean; metaById(id: string): { id: string } | null; allSessions(): { id: string }[] },
  threadIdOf: (sessionId: string) => string,
  now: number = Date.now(),
): string[] {
  if (!index.isReady() || store.ids('conversations').length === 0) return []
  let roots: Set<string> | null = null
  return store.sweepConversations((thread) => {
    if (index.metaById(thread)) return true
    roots ??= new Set(
      index.allSessions().map((m) => {
        try {
          return threadIdOf(m.id)
        } catch {
          return m.id
        }
      }),
    )
    return roots.has(thread)
  }, now)
}

export class LoadsScopesStore {
  private readonly file: string
  private places: Record<CarriedPlace, Places> = { agents: {}, conversations: {}, folders: {} }
  /** what this phase does not write yet, kept as it was read */
  private undo: Record<string, BulkUndoRecord> = {}

  constructor(dataDir: string) {
    this.file = join(dataDir, LOADS_SCOPES_FILE)
  }

  get path(): string {
    return this.file
  }

  load(): void {
    this.places = { agents: {}, conversations: {}, folders: {} }
    this.undo = {}
    if (!existsSync(this.file)) return
    let text: string
    try {
      text = readFileSync(this.file, 'utf8')
    } catch {
      return
    }
    let raw: unknown
    try {
      raw = JSON.parse(text)
    } catch {
      backupCorruptJson(this.file, text, 'loads-scopes', { mode: 0o600 })
      return
    }
    if (!isMap(raw)) return
    this.places = { agents: placesOf(raw.agents), conversations: placesOf(raw.conversations), folders: placesOf(raw.folders) }
    if (isMap(raw.undo))
      for (const [k, v] of Object.entries(raw.undo)) {
        const r = undoOf(v)
        if (r) put(this.undo, k, r)
      }
  }

  /** One place's record for one engine, or null. */
  get(place: CarriedPlace, id: string, engine: string): CarriedRecord | null {
    const p = this.places[place]
    if (!own(p, id) || !own(p[id]!, engine)) return null
    const r = p[id]![engine]!
    return { entries: r.entries, at: { ...r.at } }
  }

  /** The payload an engine is handed for a place (null: none). */
  payloadOf(place: CarriedPlace, id: string, engine: string): unknown {
    return this.get(place, id, engine)?.entries ?? null
  }

  /** Keeps what an engine's switch returned for one row: the new payload
   *  (null: nothing left — the record goes), and the row's own time while
   *  it `held` an entry there. Writes only when something changed. */
  record(
    place: CarriedPlace,
    id: string,
    engine: string,
    rowKey: string,
    answer: { payload: unknown; changed: boolean; held: boolean },
    now: number = Date.now(),
  ): void {
    if (!answer.changed) return
    const p = this.places[place]
    const byEngine: Record<string, CarriedRecord> = own(p, id) ? p[id]! : {}
    if (answer.payload === null || answer.payload === undefined) {
      delete byEngine[engine]
    } else {
      const at: Record<string, number> = own(byEngine, engine) ? { ...byEngine[engine]!.at } : {}
      if (answer.held) put(at, rowKey, now)
      else delete at[rowKey]
      put(byEngine, engine, { entries: answer.payload, at })
    }
    if (Object.keys(byEngine).length > 0) put(p, id, byEngine)
    else delete p[id]
    this.save()
  }

  /** Keeps what an engine's bulk switch returned for one place: the new
   *  payload once, and each changed item's own time while it `held` an
   *  entry there (a bulk click is one write, never one per row). */
  recordMany(
    place: CarriedPlace,
    id: string,
    engine: string,
    answer: { payload: unknown; changed: boolean },
    items: readonly { key: string; held: boolean }[],
    now: number = Date.now(),
  ): void {
    if (!answer.changed) return
    const p = this.places[place]
    const byEngine: Record<string, CarriedRecord> = own(p, id) ? p[id]! : {}
    if (answer.payload === null || answer.payload === undefined) {
      delete byEngine[engine]
    } else {
      const at: Record<string, number> = own(byEngine, engine) ? { ...byEngine[engine]!.at } : {}
      for (const it of items) {
        if (it.held) put(at, it.key, now)
        else delete at[it.key]
      }
      put(byEngine, engine, { entries: answer.payload, at })
    }
    if (Object.keys(byEngine).length > 0) put(p, id, byEngine)
    else delete p[id]
    this.save()
  }

  /** A place's last bulk click, or null. */
  undoAt(place: string): BulkUndoRecord | null {
    if (!own(this.undo, place)) return null
    const r = this.undo[place]!
    return { ...r, rows: { ...r.rows }, origins: { ...r.origins }, counts: { ...r.counts } }
  }

  /** Keeps a place's bulk click (replacing the one before), or drops it (null). */
  setUndo(place: string, rec: BulkUndoRecord | null): void {
    if (rec === null) {
      if (!own(this.undo, place)) return
      delete this.undo[place]
    } else put(this.undo, place, rec)
    this.save()
  }

  /** Drops the entries of every agent the roster no longer has (an
   *  archived agent is still on the roster: its entries stay). */
  prune(knownAgents: ReadonlySet<string>): void {
    const gone = Object.keys(this.places.agents).filter((id) => !knownAgents.has(id))
    if (gone.length === 0) return
    for (const id of gone) {
      delete this.places.agents[id]
      delete this.undo[`agent:${id}`]
    }
    this.save()
  }

  /** The ids a place keeps something for (a conversation: thread ids). */
  ids(place: CarriedPlace): string[] {
    return Object.keys(this.places[place])
  }

  /** Each id a place keeps something for, with its oldest row time (every
   *  engine's) — a start before it proves nothing there. */
  kept(place: CarriedPlace): { id: string; oldest: number }[] {
    return Object.entries(this.places[place]).map(([id, byEngine]) => {
      const times = Object.values(byEngine).flatMap((r) => Object.values(r.at))
      return { id, oldest: times.length > 0 ? Math.min(...times) : 0 }
    })
  }

  /** Drops the entries of every conversation the index no longer knows —
   *  the pins' discipline (conversation-prefs.ts): the caller sweeps only
   *  with a WARM index, and a record whose newest row time is within
   *  `graceMs` stays whatever the index says (a thread born a moment ago
   *  is not indexed yet). The grace rides the record's own times, so a
   *  restart keeps it. Writes only when something went. */
  sweepConversations(known: (thread: string) => boolean, now: number = Date.now(), graceMs = CONVERSATION_GRACE_MS): string[] {
    const gone: string[] = []
    for (const [id, byEngine] of Object.entries(this.places.conversations)) {
      const newest = Math.max(0, ...Object.values(byEngine).flatMap((r) => Object.values(r.at)))
      if (now - newest < graceMs) continue
      if (known(id)) continue
      gone.push(id)
    }
    if (gone.length === 0) return gone
    for (const id of gone) {
      delete this.places.conversations[id]
      delete this.undo[`conversation:${id}`]
    }
    this.save()
    return gone
  }

  private save(): void {
    atomicWriteJson(
      this.file,
      { agents: this.places.agents, conversations: this.places.conversations, folders: this.places.folders, undo: this.undo },
      { mode: 0o600 },
    )
    try {
      chmodSync(this.file, 0o600)
    } catch {
      /* the seal wrote it with its own mode */
    }
  }
}
