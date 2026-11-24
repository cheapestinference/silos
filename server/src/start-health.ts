// start-health.ts — a row's health and how often it did not start, from the
// two readings Silos has of a folder's MCP servers and connectors
// (docs/architecture.md «Tool health»). Neutral: it reads the ledger's
// status readings (tool-health.ts) and the engines' start notices
// (LoadsInventory.notices, names already the engine's own) and names none.
//
// Status readings are the truth and are preferred: a row a reading lists
// takes its health from the newest such reading (tool-health.ts withHealth)
// and its count from the readings — «didn't start the last 12 times ·
// since 3 Nov» from the kept failing run (it holds past the readings' cap),
// «didn't start 3 of the last 20 times» from the window. A row no reading
// lists falls back to the start notices of the folder's conversations — a
// PART of the health (the engine names some failures there, not all) and
// said so: `read.from: 'notice'`, `count.from: 'notices'`, `consoles` when
// every notice counted is a console's. An account row counts only what was
// read on its login. A placeholder, the same server as another, a copy
// standing aside and what does not load have no health and are never
// counted; `pending` and `disabled` are never a failure.
import type { LoadsHealth, LoadsRow, LoadsSignIn, ResolvedNotice } from './harnesses/contract.js'
import { READINGS_PER_LOGIN, heldBy, withHealth, type FailureRun, type StoredReading } from './tool-health.js'

/** What the folder's health rests on — said on Tools when only notices do. */
export interface HealthBasis {
  /** status readings kept for the folder */
  readings: number
  /** conversations whose start notice was read */
  notices: number
  /** of them, console starts */
  consoles: number
}

const dials = (row: LoadsRow): boolean => row.kind !== 'plugin' && row.state === 'active' && !row.replacedBy && !row.placeholder && !row.sameAs

/** The login whose readings and notices a row counts: an account row's
 *  own; any other row, the login its health was read on. */
const loginFilter = (row: LoadsRow): ((login: string | null) => boolean) | null =>
  row.origin.owner === 'account' && row.origin.login != null ? (l) => l === row.origin.login : null

function readingsCount(
  row: LoadsRow,
  readings: StoredReading[],
  runs: FailureRun[],
  threadOf: (conversation: string) => string | null = (c) => c,
): LoadsHealth['count'] | undefined {
  const h = row.health!
  const onLogin = loginFilter(row) ?? ((l: string | null) => l === h.read.login)
  if (h.status === 'failed') {
    const run = runs.find((r) => r.name === row.name && onLogin(r.login))
    if (run) return { from: 'readings', n: run.count, since: run.since }
  }
  // the window: the readings of that login that list it
  let of = 0
  let n = 0
  for (const r of readings) {
    if (!onLogin(r.login)) continue
    if (heldBy(row, r.agent, r.conversation ? threadOf(r.conversation) : null)) continue
    const s = r.servers.find((x) => x.name === row.name)
    if (!s || s.noAddress) continue
    of++
    if (s.status === 'failed') n++
  }
  return n > 0 ? { from: 'readings', n, of } : undefined
}

function fromNotices(row: LoadsRow, notices: ResolvedNotice[]): LoadsRow {
  const onLogin = loginFilter(row)
  const pool = notices.filter((n) => !onLogin || onLogin(n.login)).slice(0, READINGS_PER_LOGIN)
  if (pool.length === 0) return row
  const named = (n: ResolvedNotice): ResolvedNotice['servers'][number] | undefined => n.servers.find((s) => s.name === row.name)
  const newest = pool[0]!
  const entry = named(newest)
  // the unbroken run of notices that name it failed, newest first
  let run = 0
  while (run < pool.length && named(pool[run]!)?.status === 'failed') run++
  const failures = pool.filter((n) => named(n)?.status === 'failed').length
  const consoles = (ns: ResolvedNotice[]): { consoles?: true } => (ns.every((n) => n.mode === 'console') ? { consoles: true } : {})
  // failing now: the run; else how many of the window's starts it failed
  const count: LoadsHealth['count'] | undefined =
    entry?.status === 'failed'
      ? { from: 'notices', n: run, since: pool[run - 1]!.at, ...consoles(pool.slice(0, run)) }
      : failures > 0
        ? { from: 'notices', n: failures, of: pool.length, ...consoles(pool) }
        : undefined
  // the newest notice does not name it: nothing says how it is now
  if (!entry) return row
  const health: LoadsHealth = {
    status: entry.status,
    ...(entry.reason ? { reason: entry.reason } : {}),
    read: { at: newest.at, from: 'notice', login: newest.login, ...(newest.mode ? { mode: newest.mode } : {}) },
    ...(count ? { count } : {}),
  }
  return { ...row, health }
}

/** Every row with its health and its count (see the head of this file). */
export function healthOfRows(
  rows: LoadsRow[],
  readings: StoredReading[],
  runs: FailureRun[],
  notices: ResolvedNotice[],
  threadOf?: (conversation: string) => string | null,
): LoadsRow[] {
  const newestFirst = notices.slice().sort((a, b) => b.at - a.at)
  const sorted = readings.slice().sort((a, b) => b.at - a.at)
  return withHealth(rows, sorted, threadOf).map((row) => {
    if (!dials(row)) return row
    if (row.health) {
      const count = readingsCount(row, sorted, runs, threadOf)
      return count ? { ...row, health: { ...row.health, count } } : row
    }
    return fromNotices(row, newestFirst)
  })
}

/** What the folder's health rests on. */
export function healthBasis(readings: StoredReading[], notices: { mode: 'console' | 'chat' | null }[]): HealthBasis {
  return { readings: readings.length, notices: notices.length, consoles: notices.filter((n) => n.mode === 'console').length }
}

/** What went wrong at ONE conversation's start (its column's alert): a
 *  server that did not start, or one waiting for a sign-in — with the key
 *  of the inventory row it lands on (`row`), so a door names a row the
 *  inventory made, never a name the screen derives. No `row`: a folder that
 *  is no project (names, no door). Never a placeholder nor the same server
 *  as another (spec tools-origin §9). */
export interface StartProblem {
  kind: 'failed' | 'needs-auth'
  /** the engine's own name (or, unresolved, the id its tool names carry) */
  name: string
  /** the short name on screen: its row's label */
  label: string
  row?: string
  /** a sign-in's door: its row's (contract LoadsSignIn) */
  signIn?: LoadsSignIn
}

/** The row a server's name lands on — the copy that really loads: of the
 *  rows with that name, one this project loads and no other copy stands in
 *  for, on the conversation's login for an account row; else any loading
 *  one; else any. The criteria the rows' health is set by (withHealth). */
export function rowOfServer(rows: LoadsRow[], name: string, login: string | null): LoadsRow | undefined {
  const named = rows.filter((r) => r.kind !== 'plugin' && r.name === name)
  const live = named.filter((r) => r.state === 'active' && !r.replacedBy)
  const onLogin = (r: LoadsRow): boolean => r.origin.owner !== 'account' || r.origin.login == null || r.origin.login === login
  return live.find(onLogin) ?? live[0] ?? named.find(onLogin) ?? named[0]
}

/** One conversation's problems from its own reading of its servers (a
 *  chat's status reading, else a console's start notice — names already
 *  the engine's own), each on its row (`rows` null: no project here). A
 *  server with no address, a row that is a placeholder or the same server
 *  as another is never a problem. */
export function problemsOf(rows: LoadsRow[] | null, servers: { name: string; status: string; noAddress?: true }[], login: string | null): StartProblem[] {
  const out: StartProblem[] = []
  for (const s of servers) {
    if (s.status !== 'failed' && s.status !== 'needs-auth') continue
    if (s.noAddress || out.some((p) => p.name === s.name)) continue
    const kind = s.status
    if (rows === null) {
      out.push({ kind, name: s.name, label: s.name })
      continue
    }
    const row = rowOfServer(rows, s.name, login)
    if (row?.placeholder || row?.sameAs) continue
    // a thing the owner turned off is not a problem: of course it didn't
    // start — no copy of it loads for new conversations here (owner 24-11)
    if (row && row.state !== 'active') continue
    out.push({
      kind,
      name: s.name,
      label: row?.label ?? s.name,
      ...(row ? { row: row.key } : {}),
      ...(kind === 'needs-auth' && row?.signIn ? { signIn: row.signIn } : {}),
    })
  }
  return out
}
