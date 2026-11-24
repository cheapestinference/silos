// switch-proof.ts — «a switch proves itself» (spec tools-origin §2 rule 7,
// §7 «Proof»; docs/architecture.md «Tool health»). Neutral: it reads what
// the engine marked on its rows (LoadsRow.heldHere — the project's own
// switch file turns the row off, and the exact names a reading would list),
// the ledger's status readings and switch records (tool-health.ts) and the
// start notices, and names no engine.
//
// A reading taken after the switch file last changed — a turn's status, a
// check, a console's start notice — that still LISTS a thing the file turns
// off marks its row: «still loaded — the switch didn't take». Listed =
// present with a status other than `disabled` (the engine's own toggle).
// A reading counts from when its process STARTED (it read its settings
// then): a turn already running when the switch was made is not proof.
//
// When the file changed: the file's mtime is coarse — any key, by anyone.
// The one writer records each row it switches with the file's mtime right
// after; while the file still has the newest record's mtime nobody else
// wrote it since, so a row Silos switched off has its own exact time. Any
// other case falls back to the file's mtime (never earlier than the real
// change, so never a false proof).
//
// A name some row that loads here also has (the same plugin installed and
// sent; a namesake on another layer) is explained by that row — no proof.
// An account row counts only readings of its login. Skills cannot be
// proven: a status reading lists servers only — a plugin with no server has
// no proof either.
import type { LoadsExpect, LoadsHealth, LoadsLine, LoadsPlaceProof, LoadsProof, LoadsRow, ResolvedNotice } from './harnesses/contract.js'
import { heldBy, type StoredReading, type SwitchRecord } from './tool-health.js'

/** The record key of an origin's head (folder-loads.ts switchFolderOrigin). */
export const originRecordKey = (origin: string): string => `origin:${origin}`
/** The head whose record times a row held by its origin. */
const headOf = (row: LoadsRow): string | null =>
  row.heldHere?.by !== 'origin' ? null : row.kind === 'connector' ? originRecordKey('connectors') : originRecordKey('plugins')

/** When the row's switch last changed: its own record — or, for a row held
 *  by its origin, the head's — while nothing else wrote the file since,
 *  else the file's mtime. null: no file. */
export function changedAtOf(row: LoadsRow, fileChangedAt: number | null, records: SwitchRecord[], to: 'on' | 'off' = 'off'): number | null {
  if (fileChangedAt === null) return null
  const newest = records.slice().sort((a, b) => b.at - a.at)
  if (newest.length > 0 && newest[0]!.mtime === fileChangedAt) {
    const head = headOf(row)
    const own = newest.find((r) => r.key === row.key || (head !== null && r.key === head))
    if (own && own.to === to) return own.at
  }
  return fileChangedAt
}

/** The launch line that holds the row for a reading's conversation — its
 *  thread's own entry, else its agent's — when that entry can change the
 *  result: the reading is that place's evidence, never a wider one's
 *  (spec scopes §7: a reading of a holder never marks the project's line). */
export function holderOf(row: LoadsRow, r: { agent?: string; thread?: string | null }): LoadsLine | undefined {
  const holds = (l: LoadsLine): boolean => l.entry !== undefined && !l.locked
  return (
    row.at?.find((l) => l.place === 'conversation' && r.thread != null && l.conversation === r.thread && holds(l)) ??
    row.at?.find((l) => l.place === 'agent' && r.agent !== undefined && l.agent === r.agent && holds(l))
  )
}

/** A conversation's thread from its session id — the server resolves it
 *  (a resume, a `/clear` rotation keep one thread). */
export type ThreadOf = (conversation: string) => string | null
const sameThread: ThreadOf = (c) => c

interface Seen {
  at: number
  from: number
  name: string
  status: LoadsHealth['status']
  read: LoadsHealth['read']
  agent?: string
  conversation?: string
}

/** Every held row a reading after its switch still lists gets `proof`. */
export function withProof(
  rows: LoadsRow[],
  readings: StoredReading[],
  notices: ResolvedNotice[],
  fileChangedAt: number | null,
  records: SwitchRecord[],
  threadOf: ThreadOf = sameThread,
): LoadsRow[] {
  if (fileChangedAt === null) return rows
  const seen: Seen[] = [
    ...readings.flatMap((r) =>
      r.servers.map((s): Seen => ({
        at: r.at,
        from: r.started ?? r.at,
        name: s.name,
        status: s.status,
        read: { at: r.at, from: r.from, login: r.login, ...(r.via ? { via: r.via } : {}), ...(r.agent ? { agent: r.agent } : {}) },
        ...(r.agent ? { agent: r.agent } : {}),
        ...(r.conversation ? { conversation: r.conversation } : {}),
      })),
    ),
    // a start notice is taken AT the start; it names only failures and sign-ins
    ...notices.flatMap((n) =>
      n.servers.map((s): Seen => ({
        at: n.at,
        from: n.at,
        name: s.name,
        status: s.status,
        read: { at: n.at, from: 'notice', login: n.login, ...(n.mode ? { mode: n.mode } : {}) },
        conversation: n.conversation,
      })),
    ),
  ].sort((a, b) => b.at - a.at)
  if (seen.length === 0) return rows
  const onLogin = (r: LoadsRow, login: string | null): boolean => r.origin.owner !== 'account' || r.origin.login == null || r.origin.login === login
  return rows.map((row) => {
    const held = row.heldHere
    if (!held || held.names.length === 0 || row.state === 'active') return row
    const since = changedAtOf(row, fileChangedAt, records)
    if (since === null) return row
    for (const s of seen) {
      if (s.from <= since || s.status === 'disabled' || !held.names.includes(s.name)) continue
      if (row.origin.owner === 'account' && row.origin.login != null && s.read.login !== row.origin.login) continue
      // a reading of an agent or a conversation that holds the row is its
      // own place's evidence (withPlaceProof), never the project's
      if (heldBy(row, s.agent, s.conversation ? threadOf(s.conversation) : null)) continue
      // another row that loads here, on that login, explains the name
      if (rows.some((o) => o !== row && o.state === 'active' && !o.replacedBy && o.name === s.name && onLogin(o, s.read.login))) continue
      const proof: LoadsProof = { name: s.name, status: s.status, by: held.by, read: s.read }
      return { ...row, proof }
    }
    return row
  })
}

/** One process start of a conversation's thread, as a proof reads it: when
 *  it started (it read its settings then), the exact names it listed, and
 *  whether that list is whole (a status reading) or names only what went
 *  wrong (a start notice). */
export interface ThreadStart {
  from: number
  names: string[]
  whole: boolean
}

/** The exact names a reading would list for a row: a plugin's are its
 *  servers' (the rows it parents), anything else its own exact name. */
export function proofNamesOf(row: LoadsRow, rows: readonly LoadsRow[]): string[] {
  if (row.kind === 'plugin') return rows.filter((r) => r.parent === row.key && r.exact).map((r) => r.name)
  return row.exact ? [row.name] : []
}

/** Where ONE conversation's own entry for a row stands (spec scopes §7,
 *  per place): `pending` while no start of its thread began after the
 *  entry (`since`) — a running process keeps what it started with;
 *  after one, `in-effect` when that start agrees with the entry (an «off»
 *  no longer listed; an «on» listed, or a start that cannot say: a notice
 *  names only failures, a plugin without a server names nothing),
 *  `didnt-take` when it does not (an «off» still listed; an «on» a whole
 *  reading leaves out). The newest start decides. */
export function conversationEntryState(
  entry: 'on' | 'off',
  since: number,
  names: readonly string[],
  starts: readonly ThreadStart[],
): NonNullable<LoadsLine['here']> {
  const s = starts.filter((x) => x.from > since).sort((a, b) => b.from - a.from)[0]
  if (!s) return { state: 'pending', since }
  const listed = names.some((n) => s.names.includes(n))
  const took = entry === 'off' ? !listed : listed || !s.whole || names.length === 0
  return { state: took ? 'in-effect' : 'didnt-take', since, read: s.from }
}

/** When each place other than the project last changed for a row — what a
 *  reading must have started after to count for it (null: no time known,
 *  nothing is proven there). `machine`: its own switch record while the
 *  machine's file still has that record's mtime, else the file's mtime
 *  (changedAtOf); `agent` and `conversation`: that ENTRY's own `at`
 *  (loads-scopes.ts) — one time per entry, so a later click on another row
 *  moves nothing here. */
export interface PlaceTimes {
  machine: (row: LoadsRow, to: 'on' | 'off') => number | null
  agent: (agent: string, rowKey: string) => number | null
  conversation: (thread: string, rowKey: string) => number | null
}

/** Each place other than the project that a reading after its own change
 *  contradicts gets `proof` on its line (spec scopes §7). A reading counts
 *  for ONE place: the conversation's thread or its agent where either holds
 *  the row (holderOf), else the machine — and the machine only where the
 *  engine said its entry decides (LoadsRow.expect: a narrower file, a fact
 *  or the project's own entry turns it back by right). The newest reading
 *  that counts decides: an «off» is contradicted when it still lists one of
 *  the names (not `disabled`, and no other row that loads for that reading
 *  explains the name); an «on» when it lists none of them — a status
 *  reading only (a start notice names failures and sign-ins alone, so its
 *  silence proves nothing). A notice reaches the machine only on a row no
 *  launch place holds (it carries no agent). */
export function withPlaceProof(
  rows: LoadsRow[],
  readings: StoredReading[],
  notices: ResolvedNotice[],
  times: PlaceTimes,
  threadOf: ThreadOf = sameThread,
): LoadsRow[] {
  if (!rows.some((r) => r.expect && r.expect.length > 0 && r.at)) return rows
  interface Taken {
    at: number
    from: number
    status: boolean
    agent?: string
    thread: string | null
    login: string | null
    servers: { name: string; status: LoadsHealth['status'] }[]
    read: LoadsHealth['read']
  }
  const taken: Taken[] = [
    ...readings.map((r): Taken => ({
      at: r.at,
      from: r.started ?? r.at,
      status: true,
      ...(r.agent ? { agent: r.agent } : {}),
      thread: r.conversation ? threadOf(r.conversation) : null,
      login: r.login,
      servers: r.servers,
      read: { at: r.at, from: r.from, login: r.login, ...(r.via ? { via: r.via } : {}), ...(r.agent ? { agent: r.agent } : {}) },
    })),
    ...notices.map((n): Taken => ({
      at: n.at,
      from: n.at,
      status: false,
      thread: threadOf(n.conversation),
      login: n.login,
      servers: n.servers,
      read: { at: n.at, from: 'notice', login: n.login, ...(n.mode ? { mode: n.mode } : {}) },
    })),
  ].sort((a, b) => b.at - a.at)
  if (taken.length === 0) return rows
  // whether another row loads for this reading: its holder's line, else the project's
  const loadsFor = (o: LoadsRow, t: Taken): boolean => {
    if (o.replacedBy) return false
    if (o.origin.owner === 'account' && o.origin.login != null && o.origin.login !== t.login) return false
    const line = o.at ? (holderOf(o, t) ?? o.at.find((l) => l.place === 'project')) : undefined
    return line ? line.result === 'on' : o.state === 'active'
  }
  const sinceOf = (row: LoadsRow, e: LoadsExpect): number | null => {
    try {
      if (e.scope === 'machine') return times.machine(row, e.to)
      if (e.scope === 'agent') return e.agent ? times.agent(e.agent, row.key) : null
      return e.conversation ? times.conversation(e.conversation, row.key) : null
    } catch {
      return null
    }
  }
  const sameLine = (e: LoadsExpect, l: LoadsLine): boolean =>
    e.scope === l.place && (e.scope === 'machine' || (e.scope === 'agent' ? l.agent === e.agent : l.conversation === e.conversation))
  return rows.map((row) => {
    const expects = row.expect ?? []
    if (expects.length === 0 || !row.at) return row
    const launchHeld = row.at.some((l) => (l.place === 'agent' || l.place === 'conversation') && l.entry !== undefined && !l.locked)
    const proofs: [LoadsExpect, LoadsPlaceProof][] = []
    for (const e of expects) {
      const since = sinceOf(row, e)
      if (since === null) continue
      for (const t of taken) {
        if (t.from <= since) continue
        if (row.origin.owner === 'account' && row.origin.login != null && t.login !== row.origin.login) continue
        // the one place this reading counts for
        const holder = holderOf(row, t)
        if (holder ? !sameLine(e, holder) : !(e.scope === 'machine' && (t.status || !launchHeld))) continue
        const lists = (s: { name: string; status: LoadsHealth['status'] }): boolean => s.status !== 'disabled' && e.names.includes(s.name)
        if (e.to === 'off') {
          // a name another row that loads for this reading also has is explained by it (a plugin's own servers are not another row)
          const listed = t.servers.find((s) => lists(s) && !rows.some((o) => o !== row && o.parent !== row.key && o.name === s.name && loadsFor(o, t)))
          if (!listed && !t.status) continue // a notice that names none of it says nothing
          if (listed) proofs.push([e, { to: 'off', name: listed.name, status: listed.status, read: t.read }])
        } else {
          if (!t.status) continue
          if (!t.servers.some(lists)) proofs.push([e, { to: 'on', read: t.read }])
        }
        break // the newest reading that counts decides
      }
    }
    if (proofs.length === 0) return row
    return {
      ...row,
      at: row.at.map((l) => {
        const p = proofs.find(([e]) => sameLine(e, l))
        return p ? { ...l, proof: p[1] } : l
      }),
    }
  })
}

/** What a conversation's own record says, as an instruction file's proof
 *  reads it (Harness.instructions.reading): the real paths in force after
 *  its newest start, its on-demand loads, the starts the record shows. */
export interface InstructionSeen {
  inForce: readonly string[]
  nested: readonly { path: string; at: number }[]
  starts: readonly number[]
}

/** Where ONE conversation's own entry for an instruction file stands (spec
 *  memory-places §6 «Proof in the product»). A start counts only from a
 *  start MARKER after the entry's own time (`since`) — the record's own
 *  start hooks, or `markers` the caller knows (the ledger's process
 *  starts) — never from an instructions record: the CLI writes none when
 *  nothing changed, and none on a fresh conversation that loads nothing.
 *  No start after the entry: `pending`. After one, by the replay in force:
 *  · a file at start — an «off» still in force is `didnt-take` (a start
 *    with no record since kept the earlier record: nothing changed, so the
 *    file is still loaded); gone (a `removed`, a new base without it, a
 *    fresh session with no record) is `in-effect`. An «on» (auto memory,
 *    an override) in force is `in-effect`; absent, `didnt-take` only where
 *    the file is there to load (`exists`), else it stays `pending`.
 *  · an on-demand file — proven only by PRESENCE: loaded after a start
 *    after the entry is `didnt-take` for an «off», `in-effect` for an «on»;
 *    absence proves nothing — `pending`, the when-words stay. */
export function instructionEntryState(
  entry: 'on' | 'off',
  since: number,
  file: { paths: readonly string[]; onDemand: boolean; exists: boolean },
  seen: InstructionSeen,
  markers: readonly number[] = [],
): NonNullable<LoadsLine['here']> {
  const after = [...seen.starts, ...markers].filter((s) => Number.isFinite(s) && s > since).sort((a, b) => a - b)
  if (after.length === 0) return { state: 'pending', since }
  const first = after[0]!,
    newest = after[after.length - 1]!
  const named = (p: string): boolean => file.paths.includes(p)
  if (file.onDemand) {
    const hit = seen.nested.filter((n) => named(n.path) && n.at > first).sort((a, b) => b.at - a.at)[0]
    if (!hit) return { state: 'pending', since }
    return { state: entry === 'off' ? 'didnt-take' : 'in-effect', since, read: hit.at }
  }
  const loaded = seen.inForce.some(named)
  if (entry === 'off') return { state: loaded ? 'didnt-take' : 'in-effect', since, read: newest }
  if (loaded) return { state: 'in-effect', since, read: newest }
  return file.exists ? { state: 'didnt-take', since, read: newest } : { state: 'pending', since }
}
