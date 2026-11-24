// seals.ts — integrity of the control files, and of what an engine LOADS.
// The regime of each data-dir entry is declared ONCE in
// seal-regimes.ts by its legitimate writer; this module enforces it.
//
// RESTORE (the server is the only legitimate writer). The server keeps, IN
// MEMORY, the hash of its last WRITE and a literal copy. While it lives its
// memory is the truth: on a delta (the reconcile tick, or a read that
// checks), the outside bytes are MOVED to held/<ts>/<path>, the copy is put
// back and a due row says «<file> changed outside Silos — review the
// set-aside copy · Keep the edit · Discard». Keep validates against the
// file's rules, rewrites and re-seals; opening the sheet never adopts;
// Discard sends the held bytes to the trash. A file Silos never wrote that
// APPEARS is held the same. Until Keep nothing of the delta operates: the
// stores keep serving what Silos wrote.
//
// The write ORDER is contract (S9-r5), each piece atomic (tmp + rename):
// (1) the copy (seals/copies/<path>), (2) the file, (3) the cache
// (seals.json). The boot re-hashes every sealed file against cache + copy:
//   disk == cache, newer orphan copy  ⇒ own write that never reached the
//                                       file: the orphan is dropped, no row
//   disk == copy, cache old           ⇒ own write interrupted after the
//                                       file: adopted, re-sealed, no row
//   disk ≠ copy == cache              ⇒ changed from outside: restored from
//                                       the copy (held + row)
//   all three differ                  ⇒ the ONLY double mismatch: row
//                                       «<file> changed while Silos was off —
//                                       unverified across restart · Review ›»;
//                                       the disk is loaded only DEGRADED to
//                                       safe (the file's `degrade` rule) and
//                                       its original is kept in held/
// The anchor is the process memory (S2-r4): seals.json and the copies are a
// BOOT cache only — nothing on disk can silence a delta while the server
// lives. Residue (said once, as in the spec): a consistent rewrite of file +
// copy + cache with the server OFF is undetectable — the interpreter class,
// whose frontier is the boxes (parked).
//
// CREDENTIALS (rotate). The same order and boot recognition — the copy of a
// credential is its HASH, never a second copy of the secret — but a delta is
// never adopted: ~/.silos/token is ROTATED + row; sessions.json is rewritten
// from memory (at boot: all sessions revoked + row); agents/<id>/token is
// rotated with NO row and one server log line (G8-r6).
//
// PLUGIN TREE (agent-state/<id>/plugin/**, writers Silos and the owner's
// hand): a path that APPEARED outside Silos is moved to
// agent-state/<id>/plugin-held/<ts>/ (outside --plugin-dir: it does not
// load) with «Something appeared in X's plugin outside Silos: <n> file<s> set
// aside — Review ›» (per file Put back · Delete); a path EDITED or deleted ⇒
// «X's plugin changed outside Silos — X's engine loads it on its next
// conversation · Hold», whose door takes the edited paths out of load in one
// touch: they move to plugin-held/ like an appearance, and the row becomes
// its set-aside twin (Put back · Delete).
//
// READ HASH (configFiles, <folder>/.claude/settings*.json — settings.local.json
// INCLUDED: Claude Code itself writes there — and ~/.claude/{commands,agents,
// plugins,output-styles}/**): hash of last READ + a row (Seen) «<file>
// changed — X's engine loads it on its next conversation · Review ›», NEVER
// restore nor held. One row per file per day, folded per folder; a diff that
// only touches engine keys (permissions.allow) is a page line, never Needs you.
// Under ~/.claude/plugins/ only what the engine's plugin record
// (installed_plugins.json) names loads, so only three things are rows: the
// record gains or loses a plugin («X was installed in / removed from the
// engine outside Silos»), a file edited, added or deleted inside a version
// directory the record named at Silos' last read and still names, and the
// record turning unreadable (or readable again). A plugin moving to another
// version is the engine's routine — a page line; the catalog, caches, store,
// synced state and a version directory fetched before the record names it
// are the engine's storage — nothing. The last read of the record is
// persisted (seals.json) so a boot after an update diffs against it.
import { createHash, randomBytes } from 'node:crypto'
import {
  createReadStream,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { lstat, readdir, readFile, readlink, stat } from 'node:fs/promises'
import { dirname, join, relative, sep } from 'node:path'
import { declarationOf, DATA_DIR_REGIMES, type RegimeDecl } from './seal-regimes.js'
import { setSealHooks } from './seal-hooks.js'

export const SEALS_FILE = 'seals.json'
export const SEALS_DIR = 'seals'
export const HELD_DIR = 'held'
export const PLUGIN_HELD_DIR = 'plugin-held'

/** Engine keys of a Claude Code settings file: a diff that touches only these
 *  is the engine's routine («Always allow») — a page line, never Needs you
 *  (m10-r7). */
export const ENGINE_KEYS: readonly string[] = ['permissions.allow']

/** The home layer of Claude Code that loads in every session (G2-r7). */
export const CLAUDE_HOME_LAYER = ['commands', 'agents', 'plugins', 'output-styles'] as const

/** Claude Code's own bookkeeping inside that layer: markers its processes
 *  write while they run — one file per live session under a plugin's
 *  `.in_use/<pid>`, the sweep's stamp, an orphan's mark. Not content the
 *  engine loads, and it changes every time a session starts or ends: never
 *  read-hashed, never a row (a «changed» row a day that
 *  nobody could review). Tight on purpose: a pid-named file, two exact names. */
export const ENGINE_BOOKKEEPING = /(^|\/)(\.in_use\/\d+|\.last_inuse_sweep|\.orphaned_at)$/
export const isEngineBookkeeping = (file: string): boolean => ENGINE_BOOKKEEPING.test(file)

/** Claude Code's record of the plugins it has installed, inside the home
 *  layer's `plugins/` tree: plugin key → the version directory it loads.
 *  Everything else under `plugins/` (the marketplace catalog, caches, the
 *  store, account-synced state, a version directory fetched before the
 *  record names it) is the engine's own storage, not what it loads. */
export const ENGINE_PLUGIN_RECORD = 'plugins/installed_plugins.json'

export type PluginRecordEntry = { version: string | null; installPath: string | null }
/** The record as Silos last read it; `readable: false` = it did not parse
 *  (then `plugins` is the last record that did). */
export type PluginRecordRead = { readable: boolean; plugins: Record<string, PluginRecordEntry> }

/** installed_plugins.json → plugin key → {version, installPath} (the first
 *  entry of each key — the shape the engine writes). A missing file is an
 *  empty record; bytes that are not that shape are unreadable (null). */
export function parsePluginRecord(bytes: Buffer | null): Record<string, PluginRecordEntry> | null {
  if (bytes === null) return {}
  let raw: unknown
  try {
    raw = JSON.parse(bytes.toString('utf8'))
  } catch {
    return null
  }
  const plugins = typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? (raw as { plugins?: unknown }).plugins : undefined
  if (typeof plugins !== 'object' || plugins === null || Array.isArray(plugins)) return null
  const out: Record<string, PluginRecordEntry> = {}
  for (const key of Object.keys(plugins).sort()) {
    const recs = (plugins as Record<string, unknown>)[key]
    const first = Array.isArray(recs) ? (recs[0] as { version?: unknown; installPath?: unknown } | undefined) : undefined
    const ip = typeof first?.installPath === 'string' && first.installPath !== '' ? first.installPath.replace(/\/+$/, '') : null
    out[key] = { version: typeof first?.version === 'string' ? first.version : null, installPath: ip }
  }
  return out
}

const installPathsOf = (plugins: Record<string, PluginRecordEntry> | undefined): Set<string> =>
  new Set(Object.values(plugins ?? {}).flatMap((e) => (e.installPath ? [e.installPath] : [])))
const underAny = (file: string, paths: ReadonlySet<string>): boolean => {
  for (const p of paths) if (file.startsWith(`${p}/`)) return true
  return false
}

/** «a, b and c» / «a, b, c and N more» */
function namesList(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? ''
  if (names.length <= 3) return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]!}`
  return `${names.slice(0, 3).join(', ')} and ${names.length - 3} more`
}

/** A line on the page, never Needs you: an engine-keys-only settings diff,
 *  or a plugin the engine moved to another version of itself. */
export type PageLine =
  | { kind: 'engineKeys'; at: string; file: string; folder: string; agentIds: string[]; keys: string[] }
  | { kind: 'pluginVersion'; at: string; plugin: string; from: string; to: string; text: string }

/** A bound on how many files one read-hash walk visits (the ~/.claude/plugins
 *  cache can be large); past it the walk stops and logs once. */
export const READ_WALK_MAX = 20_000

/** Files stat'ed/read per batch of the async read-hash pass; the event loop
 *  is released between batches. */
export const READ_BATCH = 64

/** The in-life reconcile tick (index.ts). */
export const SEAL_TICK_MS = 10_000
/** The read-hash walk runs every this many ticks (once a minute). */
export const READS_EVERY_TICKS = 6

const sha = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex')
const stamp = (ms: number): string => new Date(ms).toISOString().replace(/[:.]/g, '-')
const dayOf = (ms: number): string => {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function atomicWrite(file: string, data: Buffer | string, mode?: number): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  writeFileSync(tmp, data, mode !== undefined ? { mode } : undefined)
  renameSync(tmp, file)
}

// files that carry secrets under the restore regime: 0600 when no mode is
// known, never wider than their owner
const SECRET_FILES: ReadonlySet<string> = new Set(['providers.json', 'vault.json', 'territory.json'])

function statMode(file: string): number | null {
  try {
    const st = lstatSync(file)
    return st.isFile() ? st.mode & 0o777 : null
  } catch {
    return null
  }
}

function lstatOrNull(file: string): ReturnType<typeof lstatSync> | null {
  try {
    return lstatSync(file)
  } catch {
    return null
  }
}

function readOrNull(file: string): Buffer | null {
  try {
    const st = lstatSync(file)
    if (st.isSymbolicLink()) return Buffer.from(`link:${readlinkSync(file)}`)
    if (!st.isFile()) return Buffer.from('not-a-file')
    return readFileSync(file)
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// rows
// ---------------------------------------------------------------------------

export type SealRow = { id: string; at: string } &
  // a restore file changed (or appeared) outside Silos; `held` is the
  // set-aside copy (data-dir relative), null when nothing was set aside (a
  // deletion put back)
  (
    | { kind: 'changedOutside'; file: string; held: string | null }
    // the double mismatch at boot: the file was loaded DEGRADED; `held` keeps
    // its original for review
    | { kind: 'unverified'; file: string; held: string | null }
    | { kind: 'ownerTokenRotated' }
    | { kind: 'sessionsReset' }
    // `byHold`: set aside by the owner's «Hold» on an edited plugin, not
    // because it appeared
    | { kind: 'pluginAppeared'; agentId: string; files: Array<{ path: string; held: string }>; byHold?: true }
    // `edited`: the changed paths still on disk — what «Hold» can set aside
    | { kind: 'pluginChanged'; agentId: string; paths: string[]; version: string; edited?: string[] }
    // `folder` null = the ~/.claude home layer (every agent on Claude Code)
    // `record`: the engine's plugin record became unreadable (or readable
    // again) — a row of its own on that one file, never folded with others
    | { kind: 'configChanged'; folder: string | null; agentIds: string[]; files: string[]; day: string; record?: true }
    // the engine's plugin record gained (installed) or lost (removed) plugins
    // versus Silos' last read of it — one row per change per day, folded
    | { kind: 'enginePlugins'; change: 'installed' | 'removed'; plugins: string[]; day: string }
  )

export type SealRowKind = SealRow['kind']
type NewRow = SealRow extends infer R ? (R extends SealRow ? Omit<R, 'id' | 'at'> : never) : never

/** The row's words (the spec's, verbatim) and its doors. */
export function sealRowWords(row: SealRow, nameOf: (agentId: string) => string): { text: string; doors: string[] } {
  switch (row.kind) {
    case 'changedOutside':
      return { text: `${row.file} changed outside Silos — review the set-aside copy`, doors: row.held === null ? ['Discard'] : ['Keep the edit', 'Discard'] }
    case 'unverified':
      return { text: `${row.file} changed while Silos was off — unverified across restart`, doors: ['Review ›'] }
    case 'ownerTokenRotated':
      return {
        text: 'your owner token changed outside Silos — Silos rotated it; pair your browsers again: paste the token from ~/.silos/token (or restart the server and open the new link it prints)',
        doors: [],
      }
    case 'sessionsReset':
      return { text: 'your login sessions were reset — sign in again', doors: [] }
    case 'pluginAppeared': {
      const n = row.files.length
      if (row.byHold) {
        const x = nameOf(row.agentId)
        return {
          text: `${n} edited file${n === 1 ? '' : 's'} of ${x}'s plugin set aside — ${x}'s engine won't load ${n === 1 ? 'it' : 'them'} until you put ${n === 1 ? 'it' : 'them'} back`,
          doors: ['Review ›'],
        }
      }
      return { text: `Something appeared in ${nameOf(row.agentId)}'s plugin outside Silos: ${n} file${n === 1 ? '' : 's'} set aside`, doors: ['Review ›'] }
    }
    case 'pluginChanged': {
      const x = nameOf(row.agentId)
      return {
        text: `${x}'s plugin changed outside Silos — ${x}'s engine loads it on its next conversation`,
        doors: (row.edited?.length ?? 0) > 0 ? ['Hold'] : [],
      }
    }
    case 'configChanged': {
      const who =
        row.folder === null || row.agentIds.length === 0
          ? "every agent's"
          : row.agentIds.length === 1
            ? `${nameOf(row.agentIds[0]!)}'s`
            : `${row.agentIds.map(nameOf).join(', ')}'s`
      const what = row.files.length === 1 ? row.files[0]! : `${row.files[0]!} and ${row.files.length - 1} more`
      return { text: `${what} changed — ${who} engine loads it on its next conversation`, doors: ['Review ›'] }
    }
    case 'enginePlugins': {
      const one = row.plugins.length === 1
      const text =
        row.change === 'installed'
          ? `${namesList(row.plugins)} ${one ? 'was' : 'were'} installed in the engine outside Silos — every agent's engine loads ${one ? 'it' : 'them'} on its next conversation`
          : `${namesList(row.plugins)} ${one ? 'was' : 'were'} removed from the engine outside Silos — every agent's engine stops loading ${one ? 'it' : 'them'} on its next conversation`
      return { text, doors: ['Review ›'] }
    }
  }
}

// ---------------------------------------------------------------------------
// per-file rules (a store opts in with registerFile)
// ---------------------------------------------------------------------------

export interface FileRules {
  /** «Keep the edit» validation: null = acceptable, else the refusal words. */
  validate?: (bytes: Buffer, rel: string) => string | null
  /** The boot double mismatch: the SAFE form of the unverified bytes. */
  degrade?: (bytes: Buffer) => Buffer
  /** After Keep (or a degraded load in life): the store reloads from disk.
   *  `rel` names the file (a directory's rules serve many). */
  onAdopt?: (bytes: Buffer, rel: string) => void
}

/** The minimum any JSON file of the data dir must be to be kept. */
export function validateJsonObject(bytes: Buffer): string | null {
  try {
    const v = JSON.parse(bytes.toString('utf8')) as unknown
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? null : 'it is not a JSON object'
  } catch {
    return 'it is not valid JSON'
  }
}

// agents.json — the reconcile's rules, applied to the raw file (the
// typed fields Agent.control/ownTurnsPerDay/unattendedSpendPerDay/
// ownExemptDay arrive with t3; the rules read the raw JSON so they hold
// whatever the type says today).
const inRange = (v: unknown, lo: number, hi: number): boolean => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi

/** Keep the edit on agents.json: an agent On its own without a mission does
 *  not enter, not even through Keep. */
export function validateAgentsJson(bytes: Buffer): string | null {
  const bad = validateJsonObject(bytes)
  if (bad) return bad
  const raw = JSON.parse(bytes.toString('utf8')) as { agents?: unknown }
  if (!Array.isArray(raw.agents)) return 'it has no agents list'
  for (const a of raw.agents as Array<Record<string, unknown>>) {
    if (typeof a !== 'object' || a === null || typeof a.id !== 'string') return 'an agent without an id'
    const mission = a.mission as { text?: unknown } | undefined
    const hasMission = typeof mission === 'object' && mission !== null && typeof mission.text === 'string' && mission.text.trim() !== ''
    if (a.control === 'own' && !hasMission)
      return `${typeof a.name === 'string' ? a.name : a.id} is On its own and needs its mission — set it Only when told first, or write its mission`
  }
  return null
}

/** The safe form of an unverified agents.json (boot double mismatch): own →
 *  told, out-of-range knobs → default (deleted), no exempt day. */
export function degradeAgentsJson(bytes: Buffer): Buffer {
  let raw: { agents?: unknown }
  try {
    raw = JSON.parse(bytes.toString('utf8')) as { agents?: unknown }
  } catch {
    return bytes
  }
  if (!Array.isArray(raw.agents)) return bytes
  for (const a of raw.agents as Array<Record<string, unknown>>) {
    if (typeof a !== 'object' || a === null) continue
    if (a.control === 'own') a.control = 'told'
    if ('ownTurnsPerDay' in a && !(a.ownTurnsPerDay === null || inRange(a.ownTurnsPerDay, 1, 200))) delete a.ownTurnsPerDay
    if ('unattendedSpendPerDay' in a && !(a.unattendedSpendPerDay === null || inRange(a.unattendedSpendPerDay, 1, 1000))) delete a.unattendedSpendPerDay
    if ('taskWakesPerDay' in a && !(a.taskWakesPerDay === null || inRange(a.taskWakesPerDay, 1, 500))) delete a.taskWakesPerDay
    delete a.ownExemptDay
  }
  return Buffer.from(JSON.stringify(raw, null, 2) + '\n')
}

// ---------------------------------------------------------------------------
// the seal
// ---------------------------------------------------------------------------

export interface SealAgent {
  id: string
  name: string
  folder: string | null
  folders?: string[]
  archived?: boolean
  framework?: string
}

export interface SealsOpts {
  dataDir: string
  /** the machine home (~/.claude lives here) */
  home: string
  now?: () => number
  log?: (line: string) => void
  /** the agents in play (folders for configFiles, ids for plugins) */
  agents?: () => SealAgent[]
  /** the union of every registered engine's configFiles(folder, home) */
  configFilesOf?: (folder: string, home: string) => string[]
}

interface Cache {
  v: 1
  files: Record<string, string>
  reads: Record<string, string>
  plugins: Record<string, Record<string, string>>
  rows: SealRow[]
  // what the owner marked Seen: configChanged per `<file>|<day>`, pluginChanged per `<agent>|<version>`
  seen: string[]
  degraded: string[]
  // directories watched by read hash whose files were walked before: a file
  // first seen inside one APPEARED (a planted user subagent, G2-r7)
  dirs: string[]
  // the engine's plugin record as Silos last read it (ENGINE_PLUGIN_RECORD);
  // absent = never read: the first read is the seal
  pluginRecord?: PluginRecordRead
  // what the engine changed in its own configuration (PageLine), oldest
  // first, the last PAGE_LINES_MAX — they survive a restart; a cache written
  // before them reads as none
  pageLines: PageLine[]
}

/** How many page lines the cache keeps (the newest). */
export const PAGE_LINES_MAX = 50

const emptyCache = (): Cache => ({ v: 1, files: {}, reads: {}, plugins: {}, rows: [], seen: [], degraded: [], dirs: [], pageLines: [] })

// the plugin record during one read-hash pass: `prev` = Silos' last read,
// `cur` = the disk now, `kept` = the version directories both name
type RecordPass = { prev: PluginRecordRead | undefined; cur: PluginRecordRead; kept: ReadonlySet<string> }

type ReadHash = { hash: string | null; bytes: Buffer | null; fp: string }
export type WatchedRead = { file: string; folder: string | null; agentIds: string[]; dir?: string }
// one step of the read-hash plan: a named file, or a tree walked (`bookkeeping`
// false = the engine's bookkeeping files under it are skipped — the home layer)
type ReadStep =
  | { kind: 'file'; file: string; folder: string | null; agentIds: string[] }
  | { kind: 'tree'; dir: string; folder: string | null; agentIds: string[]; bookkeeping: boolean }

type BootClass = 'none' | 'ok' | 'firstSeal' | 'appeared' | 'orphanCopy' | 'interrupted' | 'outside' | 'double'

export type DoorResult = { ok: true } | { ok: false; status: number; error: string }

export class Seals {
  readonly dataDir: string
  private readonly home: string
  private readonly now: () => number
  private readonly log: (line: string) => void
  private agentsOf: () => SealAgent[]
  private configFilesOf: (folder: string, home: string) => string[]

  // THE truth while the server lives: rel → hash of the last write, and the
  // literal copy (null for a credential: its copy is its hash)
  private mem = new Map<string, { hash: string; copy: Buffer | null }>()
  private rules = new Map<string, FileRules>()
  private cache: Cache = emptyCache()
  private cacheLoaded = false
  // seals.json did not exist: the FIRST boot under the seal — what is on disk
  // is sealed as found (nothing to verify against). Only during the boot
  // phase (until endBoot()).
  private fresh = false
  private bootPhase = true
  private readHashes = new Map<string, ReadHash>()
  private recordPass: RecordPass | null = null
  private walkTruncated = false
  private warnedWalk = false
  private walkedNow = new Set<string>()
  private readsRunning: Promise<void> | null = null
  // the async pass writes seals.json only when it changed something of it
  // (a steady ~/.claude is ~2 MB of cache re-serialized for nothing)
  private readsDirty = false
  private touchedDuringPass: Set<string> | null = null

  // credentials the server holds in memory
  private ownerTokenValue: string | null = null
  private sessionsRewrite: (() => void) | null = null
  private agentTokenRotate: ((agentId: string) => void) | null = null

  constructor(opts: SealsOpts) {
    this.dataDir = opts.dataDir
    this.home = opts.home
    this.now = opts.now ?? Date.now
    this.log = opts.log ?? ((l) => console.log(l))
    this.agentsOf = opts.agents ?? (() => [])
    this.configFilesOf = opts.configFilesOf ?? (() => [])
  }

  setAgents(fn: () => SealAgent[]): void {
    this.agentsOf = fn
  }
  setConfigFiles(fn: (folder: string, home: string) => string[]): void {
    this.configFilesOf = fn
  }

  /** The stores' writes go through the seal from now on (seal-hooks.ts). */
  install(): this {
    setSealHooks({
      write: (file, text, mode) => this.writeIfSealed(file, text, mode),
      remove: (file) => this.removeIfSealed(file),
      stage: (file, text) => {
        this.stage(file, text)
      },
      commit: (file) => {
        this.commit(file)
      },
      abort: (file) => {
        this.abort(file)
      },
      beforeOwnEdit: (file) => {
        this.checkRead(file)
      },
      afterOwnEdit: (file) => {
        this.resealRead(file)
      },
      pluginWritten: (dir) => {
        this.resealPluginDir(dir)
      },
    })
    return this
  }

  uninstall(): void {
    setSealHooks(null)
  }

  /** A store opts its file into the seal's rules (validate/degrade/adopt). */
  registerFile(rel: string, rules: FileRules): void {
    this.rules.set(rel, rules)
  }

  /** A store of MANY files under one directory (messages/**) opts every file
   *  below `dir` into the same rules. */
  registerDir(dir: string, rules: FileRules): void {
    this.dirRules.set(dir.replace(/\/+$/, ''), rules)
  }

  private dirRules = new Map<string, FileRules>()
  private rulesOf(rel: string): FileRules | undefined {
    const own = this.rules.get(rel)
    if (own) return own
    for (const [dir, r] of this.dirRules) if (rel.startsWith(`${dir}/`)) return r
    return undefined
  }

  // ---- paths ----

  private abs(rel: string): string {
    return join(this.dataDir, rel)
  }
  private relOf(file: string): string | null {
    const r = relative(this.dataDir, file)
    if (r === '' || r.startsWith('..') || r.startsWith(sep) || r.includes('\0')) return null
    return r.split(sep).join('/')
  }
  private copyPath(rel: string, credential: boolean): string {
    return join(this.dataDir, SEALS_DIR, 'copies', credential ? `${rel}.sha256` : rel)
  }
  private regime(rel: string): RegimeDecl['regime'] | null {
    return declarationOf(rel)?.regime ?? null
  }
  private isCredential(rel: string): boolean {
    return this.regime(rel) === 'rotate'
  }

  // ---- file modes: a restore or a kept edit never widens who can read ----
  // The mode of each sealed file as Silos last wrote or adopted it (memory,
  // like the copy). A write that names no mode keeps it: the remembered one,
  // else the file's own on disk (stat BEFORE it is set aside or written),
  // else 0600 for a secret-bearing file and the default for the rest. A
  // secret-bearing file never gets bits beyond its owner's.
  private modes = new Map<string, number>()
  private isSecretFile(rel: string): boolean {
    return this.isCredential(rel) || SECRET_FILES.has(rel)
  }
  private modeFor(rel: string, explicit?: number): number | undefined {
    const m = explicit ?? this.modes.get(rel) ?? statMode(this.abs(rel)) ?? undefined
    if (!this.isSecretFile(rel)) return m
    return m === undefined ? 0o600 : m & 0o700 || 0o600
  }
  private rememberMode(rel: string): void {
    const m = statMode(this.abs(rel))
    if (m !== null) this.modes.set(rel, m)
  }

  // ---- the cache (boot only) ----

  private loadCache(): void {
    this.cacheLoaded = true
    const file = this.abs(SEALS_FILE)
    if (!existsSync(file)) {
      this.fresh = true
      this.cache = emptyCache()
      return
    }
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<Cache>
      this.cache = { ...emptyCache(), ...raw, v: 1, pageLines: Array.isArray(raw.pageLines) ? raw.pageLines.slice(-PAGE_LINES_MAX) : [] }
    } catch {
      // a broken cache is a missing anchor: everything is checked as if the
      // seal were new, but NOT adopted silently — see classify()
      this.cache = emptyCache()
      this.fresh = false
      this.log('seals: seals.json unreadable — every sealed file is checked against its copy')
    }
  }

  private saveCache(): void {
    atomicWrite(this.abs(SEALS_FILE), JSON.stringify(this.cache, null, 2) + '\n', 0o600)
  }

  private readCopy(rel: string): { hash: string; bytes: Buffer | null } | null {
    const cred = this.isCredential(rel)
    const b = readOrNull(this.copyPath(rel, cred))
    if (b === null) return null
    return cred ? { hash: b.toString('utf8').trim(), bytes: null } : { hash: sha(b), bytes: b }
  }

  // ---- the sealed write: (1) copy, (2) file, (3) cache ----

  private sealedWrite(rel: string, bytes: Buffer, mode?: number, opts: { skipFile?: boolean } = {}): void {
    const cred = this.isCredential(rel)
    const hash = sha(bytes)
    this.mem.set(rel, { hash, copy: cred ? null : bytes })
    atomicWrite(this.copyPath(rel, cred), cred ? hash : bytes, 0o600)
    if (!opts.skipFile) atomicWrite(this.abs(rel), bytes, this.modeFor(rel, mode))
    this.rememberMode(rel)
    this.cache.files[rel] = hash
    this.saveCache()
  }

  private forget(rel: string): void {
    this.mem.delete(rel)
    rmSync(this.copyPath(rel, this.isCredential(rel)), { force: true })
    delete this.cache.files[rel]
  }

  /** seal-hooks write: true when the seal wrote the file. */
  writeIfSealed(file: string, text: string, mode?: number): boolean {
    const rel = this.relOf(file)
    if (rel === null || this.regime(rel) !== 'restore') return false
    this.sealedWrite(rel, Buffer.from(text), mode)
    return true
  }

  private staged = new Map<string, Buffer>()

  /** Step (1) of a write its store performs itself (seal-hooks stage). */
  stage(file: string, text: string): void {
    const rel = this.relOf(file)
    if (rel === null || this.regime(rel) !== 'restore') return
    const b = Buffer.from(text)
    this.staged.set(rel, b)
    atomicWrite(this.copyPath(rel, false), b, 0o600)
  }

  /** Step (3): the store wrote the file; memory and cache follow. */
  commit(file: string): void {
    const rel = this.relOf(file)
    const b = rel === null ? undefined : this.staged.get(rel)
    if (rel === null || b === undefined) return
    this.staged.delete(rel)
    this.mem.set(rel, { hash: sha(b), copy: b })
    this.cache.files[rel] = sha(b)
    this.saveCache()
  }

  /** The store's write did not happen: the staged copy goes. */
  abort(file: string): void {
    const rel = this.relOf(file)
    if (rel === null || !this.staged.has(rel)) return
    this.staged.delete(rel)
    const m = this.mem.get(rel)
    if (m?.copy) atomicWrite(this.copyPath(rel, false), m.copy, 0o600)
    else rmSync(this.copyPath(rel, false), { force: true })
  }

  /** A restore-regime file Silos writes on its own (not via atomicWriteJson). */
  write(rel: string, bytes: Buffer | string, mode?: number): void {
    this.sealedWrite(rel, Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes), mode)
  }

  /** Append to a restore-regime file (a ledger, a .jsonl): a full sealed
   *  rewrite of what Silos wrote + the text — never an append to whatever
   *  the disk holds now. */
  append(rel: string, text: string, mode?: number): void {
    if (!this.checkRestore(rel)) {
      /* the delta is set aside; Silos' copy is back */
    }
    const base = this.mem.get(rel)?.copy ?? Buffer.alloc(0)
    this.sealedWrite(rel, Buffer.concat([base, Buffer.from(text)]), mode)
  }

  /** seal-hooks remove: true when the file is under a restore seal and the
   *  seal removed it (copy, file, cache). */
  removeIfSealed(file: string): boolean {
    const rel = this.relOf(file)
    if (rel === null || this.regime(rel) !== 'restore') return false
    this.remove(rel)
    return true
  }

  /** Silos deletes a sealed file of its own (copy, file, cache). */
  remove(rel: string): void {
    rmSync(this.copyPath(rel, this.isCredential(rel)), { force: true })
    rmSync(this.abs(rel), { force: true })
    this.mem.delete(rel)
    delete this.cache.files[rel]
    this.saveCache()
  }

  /** A credential written by its store (token, sessions.json, agents/<id>/token). */
  writeCredential(rel: string, value: string, mode = 0o600): void {
    this.sealedWrite(rel, Buffer.from(value), mode)
  }

  /** What the server wrote last — the copy it serves (restore). */
  served(rel: string): Buffer | null {
    return this.mem.get(rel)?.copy ?? null
  }

  /** The file was loaded DEGRADED at boot (double mismatch) and the owner has
   *  not reviewed it yet. The registry reads this to keep own → told. */
  degraded(rel: string): boolean {
    return this.cache.degraded.includes(rel)
  }

  // ---- classification (boot) ----

  private classify(rel: string): { cls: BootClass; disk: Buffer | null; copy: { hash: string; bytes: Buffer | null } | null } {
    const disk = readOrNull(this.abs(rel))
    const dh = disk === null ? null : sha(disk)
    const c = this.cache.files[rel]
    const copy = this.readCopy(rel)
    const ph = copy?.hash
    let cls: BootClass
    const first = this.fresh && this.bootPhase
    if (c === undefined && ph === undefined) cls = disk === null ? 'none' : first ? 'firstSeal' : 'appeared'
    else if (c !== undefined && dh === c) cls = ph === c ? 'ok' : 'orphanCopy'
    else if (ph !== undefined && dh === ph) cls = 'interrupted'
    else if (c === undefined)
      cls = disk === null ? 'orphanCopy' : first ? 'firstSeal' : 'appeared' // a first write that crashed before the cache
    else if (ph === c) cls = 'outside'
    else cls = 'double'
    return { cls, disk, copy }
  }

  private hold(rel: string, opts: { copyOnly?: boolean } = {}): string | null {
    const from = this.abs(rel)
    if (readOrNull(from) === null) return null
    const heldRel = `${HELD_DIR}/${stamp(this.now())}/${rel}`
    const to = this.abs(heldRel)
    mkdirSync(dirname(to), { recursive: true, mode: 0o700 })
    if (opts.copyOnly) writeFileSync(to, readFileSync(from), { mode: 0o600 })
    else renameSync(from, to)
    return heldRel
  }

  private addRow(row: NewRow): SealRow {
    const r = { ...row, id: randomBytes(6).toString('hex'), at: new Date(this.now()).toISOString() } as SealRow
    this.cache.rows.push(r)
    this.saveCache()
    return r
  }

  /** Every restore path the seal knows or finds on disk. */
  private restorePaths(): string[] {
    const out = new Set<string>([...Object.keys(this.cache.files), ...this.mem.keys()])
    for (const [name, decl] of Object.entries(DATA_DIR_REGIMES)) {
      if (decl.regime !== 'restore') continue
      const p = this.abs(name)
      let st
      try {
        st = lstatSync(p)
      } catch {
        continue
      }
      if (!st.isDirectory()) {
        out.add(name)
        continue
      }
      for (const f of walkFiles(p, 5_000)) out.add(`${name}/${f}`)
    }
    // copies whose file is gone
    const copies = join(this.dataDir, SEALS_DIR, 'copies')
    if (existsSync(copies)) for (const f of walkFiles(copies, 50_000)) out.add(f.replace(/\.sha256$/, ''))
    return [...out].filter((rel) => this.regime(rel) === 'restore').sort()
  }

  /** Boot: before any store loads. Re-hashes every restore file against
   *  the cache and its copy (credentials boot with their store). */
  boot(): void {
    if (!this.cacheLoaded) this.loadCache()
    for (const rel of this.restorePaths()) this.bootRestore(rel)
    // plugin trees and read hashes: their deltas while off are deltas
    this.reconcilePlugins()
    this.reconcileReads()
    this.saveCache()
  }

  /** Every store has loaded: from now on nothing is «first seen» on disk —
   *  a sealed file Silos never wrote APPEARED. */
  endBoot(): void {
    this.bootPhase = false
    this.fresh = false
    this.saveCache()
  }

  private bootRestore(rel: string): void {
    const { cls, disk, copy } = this.classify(rel)
    const consumed = DATA_DIR_REGIMES[rel.split('/')[0]!]?.deletion === 'consumed'
    switch (cls) {
      case 'none':
        return
      case 'ok':
        this.mem.set(rel, { hash: this.cache.files[rel]!, copy: disk })
        this.rememberMode(rel)
        return
      case 'firstSeal':
        this.sealedWrite(rel, disk!, undefined, { skipFile: true })
        return
      case 'orphanCopy':
        if (disk === null) {
          this.forget(rel)
          return
        }
        this.sealedWrite(rel, disk, undefined, { skipFile: true })
        return
      case 'interrupted':
        this.sealedWrite(rel, disk!, undefined, { skipFile: true })
        return
      case 'appeared': {
        const held = this.hold(rel)
        this.addRow({ kind: 'changedOutside', file: rel, held })
        return
      }
      case 'outside': {
        if (disk === null && consumed) {
          this.forget(rel)
          return
        }
        const mode = this.modeFor(rel)
        const held = this.hold(rel)
        this.sealedWrite(rel, copy!.bytes!, mode)
        this.addRow({ kind: 'changedOutside', file: rel, held })
        this.log(`seals: ${rel} changed outside Silos while it was off — set aside${held ? ` in ${held}` : ''}, Silos' copy put back`)
        return
      }
      case 'double': {
        if (disk === null) {
          this.forget(rel)
          this.addRow({ kind: 'unverified', file: rel, held: null })
          return
        }
        const held = this.hold(rel, { copyOnly: true })
        const safe = this.rulesOf(rel)?.degrade?.(disk) ?? disk
        this.sealedWrite(rel, safe)
        if (!this.cache.degraded.includes(rel)) this.cache.degraded.push(rel)
        this.addRow({ kind: 'unverified', file: rel, held })
        this.log(`seals: ${rel} changed while Silos was off and could not be verified — loaded degraded to safe; its original is in ${held}`)
        return
      }
    }
  }

  // ---- in life: the reconcile ----

  /** One pass over every seal (the server's tick calls it; a test calls it). */
  // `reads: false` skips the read-hash walk (the ~/.claude home layer can be
  // thousands of stats): the server's tick runs it every READS_EVERY_TICKS
  reconcile(opts: { reads?: boolean } = {}): void {
    for (const rel of this.restorePaths()) this.checkRestore(rel)
    this.reconcileCredentials()
    this.reconcilePlugins()
    if (opts.reads !== false) this.reconcileReads()
  }

  /** One restore file, now: a delta is set aside and the copy put back.
   *  Returns true when the file is what Silos wrote (after any restore). */
  checkRestore(rel: string): boolean {
    const disk = readOrNull(this.abs(rel))
    const m = this.mem.get(rel)
    const dh = disk === null ? null : sha(disk)
    if (m && dh === m.hash) return true
    if (!m && disk === null) return true
    const consumed = DATA_DIR_REGIMES[rel.split('/')[0]!]?.deletion === 'consumed'
    if (m && disk === null && consumed) {
      this.forget(rel)
      this.saveCache()
      return true
    }
    const mode = this.modeFor(rel)
    const held = this.hold(rel)
    if (m && m.copy) {
      // put back what Silos wrote, with the mode Silos gave it; the cache
      // already says so
      atomicWrite(this.abs(rel), m.copy, mode)
    }
    this.addRow({ kind: 'changedOutside', file: rel, held })
    this.log(`seals: ${rel} changed outside Silos — set aside${held ? ` in ${held}` : ''}${m ? ", Silos' copy put back" : ''}`)
    return false
  }

  // ---- the doors ----

  /** The open rows. A configChanged row never lists the engine's own
   *  bookkeeping, nor — under the engine's `plugins/` tree — anything but
   *  files inside a version directory the plugin record names now (the
   *  record itself is no file of a row: its changes are their own rows);
   *  one that lists nothing else is no row. */
  rows(): SealRow[] {
    const root = this.pluginsRoot()
    const recorded = installPathsOf((this.cache.pluginRecord ?? this.readPluginRecord()).plugins)
    const record = this.pluginRecordFile()
    const keep = (f: string): boolean => !isEngineBookkeeping(f) && f !== record && (!f.startsWith(root) || underAny(f, recorded))
    return this.cache.rows.flatMap((r): SealRow[] => {
      if (r.kind !== 'configChanged' || r.record) return [r]
      const files = r.files.filter(keep)
      return files.length === 0 ? [] : files.length === r.files.length ? [r] : [{ ...r, files }]
    })
  }

  row(id: string): SealRow | null {
    return this.cache.rows.find((r) => r.id === id) ?? null
  }

  private dropRow(id: string): void {
    this.cache.rows = this.cache.rows.filter((r) => r.id !== id)
    this.saveCache()
  }

  /** The set-aside bytes, for the review sheet. Opening never adopts. */
  heldText(id: string, maxBytes = 256 * 1024): { file: string; held: string; text: string; truncated: boolean } | null {
    const r = this.row(id)
    if (!r || (r.kind !== 'changedOutside' && r.kind !== 'unverified')) return null
    if (r.held === null) return null
    const b = readOrNull(this.abs(r.held))
    if (b === null) return null
    return { file: r.file, held: r.held ?? r.file, text: b.subarray(0, maxBytes).toString('utf8'), truncated: b.length > maxBytes }
  }

  /** «Keep the edit»: validate against the file's rules, write, re-seal. */
  keep(id: string): DoorResult {
    const r = this.row(id)
    if (!r) return { ok: false, status: 404, error: 'no such row' }
    if (r.kind !== 'changedOutside' && r.kind !== 'unverified') return { ok: false, status: 409, error: 'this row has nothing to keep' }
    if (r.held === null) return { ok: false, status: 409, error: 'nothing was set aside — the file was deleted outside Silos and Silos put its copy back' }
    const bytes = readOrNull(this.abs(r.held))
    if (bytes === null) return { ok: false, status: 409, error: 'the set-aside copy is gone' }
    const rules = this.rulesOf(r.file)
    const err = rules?.validate ? rules.validate(bytes, r.file) : r.file.endsWith('.json') ? validateJsonObject(bytes) : null
    if (err) return { ok: false, status: 400, error: `Silos can't keep this edit of ${r.file}: ${err}` }
    this.sealedWrite(r.file, bytes)
    rmSync(this.abs(r.held), { force: true })
    this.cache.degraded = this.cache.degraded.filter((f) => f !== r.file)
    this.dropRow(id)
    rules?.onAdopt?.(bytes, r.file)
    return { ok: true }
  }

  /** «Discard»: the set-aside bytes go to the trash; Silos' copy stays. */
  discard(id: string): DoorResult {
    const r = this.row(id)
    if (!r) return { ok: false, status: 404, error: 'no such row' }
    if (r.kind !== 'changedOutside' && r.kind !== 'unverified') return { ok: false, status: 409, error: 'this row has nothing to discard' }
    if (r.held !== null) this.toTrash(r.held, r.held)
    this.dropRow(id)
    return { ok: true }
  }

  /** «Seen» on a row that has no other resolution. An unverified file seen
   *  stays as loaded (degraded) — its original goes to the trash. */
  seen(id: string): DoorResult {
    const r = this.row(id)
    if (!r) return { ok: false, status: 404, error: 'no such row' }
    if (r.kind === 'changedOutside' || r.kind === 'pluginAppeared') return { ok: false, status: 409, error: 'this row is resolved with its own doors' }
    if (r.kind === 'unverified') {
      if (r.held) this.toTrash(r.held, r.held)
      this.cache.degraded = this.cache.degraded.filter((f) => f !== r.file)
    }
    if (r.kind === 'pluginChanged') this.cache.seen.push(`plugin|${r.agentId}|${r.version}`)
    if (r.kind === 'configChanged') for (const f of r.files) this.cache.seen.push(`config|${f}|${r.day}`)
    this.dropRow(id)
    return { ok: true }
  }

  private toTrash(fromRel: string, name: string): void {
    const from = this.abs(fromRel)
    if (readOrNull(from) === null) return
    const to = join(this.dataDir, 'trash', 'set-aside', stamp(this.now()), name)
    mkdirSync(dirname(to), { recursive: true, mode: 0o700 })
    renameSync(from, to)
  }

  // ---- credentials ----

  /** Boot of a credential its store is about to load: 'ok' = load it,
   *  'delta' = it changed outside Silos (rotate / revoke, never adopt). */
  bootCredential(rel: string): 'ok' | 'delta' | 'none' {
    if (!this.cacheLoaded) this.loadCache()
    const { cls, disk } = this.classify(rel)
    switch (cls) {
      case 'none':
        return 'none'
      case 'ok':
        this.mem.set(rel, { hash: this.cache.files[rel]!, copy: null })
        return 'ok'
      case 'firstSeal':
      case 'interrupted':
        this.sealedWrite(rel, disk!, undefined, { skipFile: true })
        return 'ok'
      case 'orphanCopy':
        if (disk === null) {
          this.forget(rel)
          this.saveCache()
          return 'none'
        }
        this.sealedWrite(rel, disk, undefined, { skipFile: true })
        return 'ok'
      case 'appeared':
      case 'outside':
      case 'double':
        return 'delta'
    }
  }

  /** The owner's token at boot: ensureData read it (or minted it). A delta
   *  (planted while off) is never served: rotated + row. `fromEnv`: the
   *  owner fixed it with SILOS_TOKEN — that IS a legitimate write. */
  bootOwnerToken(read: string, opts: { fromEnv?: boolean } = {}): string {
    if (opts.fromEnv) {
      this.writeCredential('token', read)
      this.ownerTokenValue = read
      return read
    }
    const v = this.bootCredential('token')
    if (v === 'delta') return this.rotateOwnerToken('while Silos was off')
    this.ownerTokenValue = read
    if (v === 'none') this.writeCredential('token', read)
    return read
  }

  /** The owner's token the server authenticates against (memory). */
  ownerToken(): string | null {
    return this.ownerTokenValue
  }

  private rotateOwnerToken(when: string): string {
    const t = randomBytes(16).toString('hex')
    this.writeCredential('token', t)
    this.ownerTokenValue = t
    this.addRow({ kind: 'ownerTokenRotated' })
    this.log(`seals: the owner token changed outside Silos ${when} — rotated; the planted value never authenticates`)
    return t
  }

  /** sessions.json: the store rewrites itself from memory on a delta. */
  bindSessions(rewrite: () => void): void {
    this.sessionsRewrite = rewrite
  }

  /** sessions.json at boot: a delta ⇒ every session revoked + row. */
  bootSessions(): 'ok' | 'reset' {
    const v = this.bootCredential('sessions.json')
    if (v !== 'delta') return 'ok'
    this.addRow({ kind: 'sessionsReset' })
    this.log('seals: sessions.json changed outside Silos while it was off — every login session revoked')
    return 'reset'
  }

  /** agents/<id>/token: the token store rotates on a delta (no row). */
  bindAgentTokens(rotate: (agentId: string) => void): void {
    this.agentTokenRotate = rotate
  }

  private reconcileCredentials(): void {
    for (const rel of [...this.mem.keys()]) {
      if (!this.isCredential(rel)) continue
      const disk = readOrNull(this.abs(rel))
      if (disk !== null && sha(disk) === this.mem.get(rel)!.hash) continue
      if (rel === 'token') {
        this.rotateOwnerToken('while Silos ran')
        continue
      }
      if (rel === 'sessions.json') {
        this.log('seals: sessions.json changed outside Silos — rewritten from memory')
        if (this.sessionsRewrite) this.sessionsRewrite()
        continue
      }
      const m = /^agents\/([^/]+)\/token$/.exec(rel)
      if (m) {
        this.log(`seals: ${m[1]}'s bearer changed outside Silos — rotated`)
        if (this.agentTokenRotate) this.agentTokenRotate(m[1]!)
        else this.forget(rel)
      }
    }
  }

  // ---- plugin trees ----

  private pluginDirOf(agentId: string): string {
    return join(this.dataDir, 'agent-state', agentId, 'plugin')
  }

  private treeOf(dir: string): Record<string, string> {
    const out: Record<string, string> = {}
    for (const f of walkFiles(dir, 10_000, { links: true })) {
      const b = readOrNull(join(dir, f))
      if (b !== null) out[f] = sha(b)
    }
    return out
  }

  private pluginIds(): string[] {
    const ids = new Set<string>(Object.keys(this.cache.plugins))
    try {
      for (const id of readdirSync(join(this.dataDir, 'agent-state'))) if (existsSync(this.pluginDirOf(id))) ids.add(id)
    } catch {
      /* no agent-state yet */
    }
    return [...ids].filter((id) => /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id)).sort()
  }

  /** Silos wrote into a plugin: the tree as it is now is Silos'. */
  resealPlugin(agentId: string): void {
    this.cache.plugins[agentId] = this.treeOf(this.pluginDirOf(agentId))
    this.saveCache()
  }

  private resealPluginDir(pluginDir: string): void {
    const rel = this.relOf(pluginDir)
    const m = rel ? /^agent-state\/([^/]+)\/plugin$/.exec(rel) : null
    if (m) this.resealPlugin(m[1]!)
  }

  reconcilePlugins(): void {
    for (const id of this.pluginIds()) {
      const dir = this.pluginDirOf(id)
      const now = this.treeOf(dir)
      const sealed = this.cache.plugins[id]
      if (sealed === undefined && this.fresh && this.bootPhase) {
        this.cache.plugins[id] = now
        continue
      }
      const before = sealed ?? {}
      const appeared = Object.keys(now).filter((p) => !(p in before))
      if (appeared.length > 0) {
        const ts = stamp(this.now())
        const files: Array<{ path: string; held: string }> = []
        for (const p of appeared) {
          const heldRel = `agent-state/${id}/${PLUGIN_HELD_DIR}/${ts}/${p}`
          mkdirSync(dirname(this.abs(heldRel)), { recursive: true, mode: 0o700 })
          renameSync(join(dir, p), this.abs(heldRel))
          files.push({ path: p, held: heldRel })
          delete now[p]
        }
        pruneEmptyDirs(dir)
        this.addRow({ kind: 'pluginAppeared', agentId: id, files })
        this.log(`seals: ${files.length} file(s) appeared in ${id}'s plugin outside Silos — set aside in plugin-held/`)
      }
      if (sealed === undefined) {
        this.cache.plugins[id] = now
        this.saveCache()
        continue
      }
      const changed = [...Object.keys(before).filter((p) => !(p in now)), ...Object.keys(now).filter((p) => p in before && before[p] !== now[p])].sort()
      if (changed.length === 0) continue
      const version = sha(JSON.stringify(Object.entries(now).sort()))
      const already =
        this.cache.rows.some((r) => r.kind === 'pluginChanged' && r.agentId === id && r.version === version) ||
        this.cache.seen.includes(`plugin|${id}|${version}`)
      if (already) continue
      // one open row per agent: a newer edit replaces the older one
      this.cache.rows = this.cache.rows.filter((r) => !(r.kind === 'pluginChanged' && r.agentId === id))
      const edited = changed.filter((p) => p in now)
      this.addRow({ kind: 'pluginChanged', agentId: id, paths: changed, version, ...(edited.length > 0 ? { edited } : {}) })
    }
  }

  /** «Hold» an edited plugin (M12-r6), one touch: the paths edited outside
   *  Silos move to plugin-held/<ts>/ — outside --plugin-dir, so X's next
   *  conversation does not load them (the one safe hold: nothing in a plugin
   *  is the operator's content) — and the row becomes their set-aside row
   *  (Put back · Delete). A deletion has nothing to hold. */
  holdPlugin(id: string): DoorResult {
    const r = this.row(id)
    if (!r || r.kind !== 'pluginChanged') return { ok: false, status: 404, error: 'no such row' }
    const dir = this.pluginDirOf(r.agentId)
    const ts = stamp(this.now())
    const files: Array<{ path: string; held: string }> = []
    for (const p of r.edited ?? []) {
      const src = join(dir, p)
      try {
        lstatSync(src)
      } catch {
        continue
      }
      const heldRel = `agent-state/${r.agentId}/${PLUGIN_HELD_DIR}/${ts}/${p}`
      mkdirSync(dirname(this.abs(heldRel)), { recursive: true, mode: 0o700 })
      renameSync(src, this.abs(heldRel))
      files.push({ path: p, held: heldRel })
    }
    if (files.length === 0) return { ok: false, status: 409, error: 'nothing to hold — what changed is no longer in the plugin' }
    pruneEmptyDirs(dir)
    this.resealPlugin(r.agentId)
    this.cache.rows = this.cache.rows.filter((x) => x.id !== r.id)
    this.addRow({ kind: 'pluginAppeared', agentId: r.agentId, files, byHold: true })
    this.log(`seals: held ${files.length} edited file(s) of ${r.agentId}'s plugin in plugin-held/`)
    return { ok: true }
  }

  /** «Put back» one set-aside plugin file: it loads again (Silos' write). */
  putBack(id: string, path: string): DoorResult {
    const r = this.row(id)
    if (!r || r.kind !== 'pluginAppeared') return { ok: false, status: 404, error: 'no such row' }
    const f = r.files.find((x) => x.path === path)
    if (!f) return { ok: false, status: 404, error: 'no such file in this row' }
    const dest = join(this.pluginDirOf(r.agentId), f.path)
    if (existsSync(dest)) return { ok: false, status: 409, error: `${f.path} exists again in the plugin — Silos won't overwrite it` }
    mkdirSync(dirname(dest), { recursive: true })
    renameSync(this.abs(f.held), dest)
    this.resealPlugin(r.agentId)
    this.afterPluginDoor(r, f.path)
    return { ok: true }
  }

  /** «Delete» one set-aside plugin file: to the trash. */
  deleteHeld(id: string, path: string): DoorResult {
    const r = this.row(id)
    if (!r || r.kind !== 'pluginAppeared') return { ok: false, status: 404, error: 'no such row' }
    const f = r.files.find((x) => x.path === path)
    if (!f) return { ok: false, status: 404, error: 'no such file in this row' }
    this.toTrash(f.held, `plugin-${r.agentId}/${f.path}`)
    this.afterPluginDoor(r, f.path)
    return { ok: true }
  }

  private afterPluginDoor(r: Extract<SealRow, { kind: 'pluginAppeared' }>, path: string): void {
    r.files = r.files.filter((x) => x.path !== path)
    if (r.files.length === 0) this.dropRow(r.id)
    else this.saveCache()
  }

  // ---- read hash: configFiles, settings*.json, the ~/.claude home layer ----

  /** What read hash watches, in order, before any tree is walked: the named
   *  files and the trees (`<dir>/**`) with the folder (null = home) and the
   *  agents that load them. Cheap (one readdir per agent folder's .claude):
   *  the walk is the costly part, done by watchedReads (sync) or
   *  watchedReadsAsync (yields). */
  private readPlan(): ReadStep[] {
    const byFolder = new Map<string, string[]>()
    for (const a of this.agentsOf()) {
      if (a.archived) continue
      for (const f of [a.folder, ...(a.folders ?? [])]) {
        if (!f) continue
        byFolder.set(f, [...(byFolder.get(f) ?? []), a.id])
      }
    }
    const steps: ReadStep[] = []
    for (const [folder, agentIds] of byFolder) {
      const claudeDir = join(folder, '.claude')
      try {
        for (const n of readdirSync(claudeDir)) if (/^settings.*\.json$/.test(n)) steps.push({ kind: 'file', file: join(claudeDir, n), folder, agentIds })
      } catch {
        /* no .claude */
      }
      steps.push({ kind: 'file', file: join(claudeDir, 'settings.json'), folder, agentIds })
      steps.push({ kind: 'file', file: join(claudeDir, 'settings.local.json'), folder, agentIds })
      for (const p of this.configFilesOf(folder, this.home)) {
        if (!p.startsWith('/')) continue
        // a home-wide config (OpenCode's ~/.config/opencode) loads for everyone
        const home = p.startsWith(this.home + '/') && !p.startsWith(folder + '/')
        const at = home ? null : folder,
          ids = home ? [] : agentIds
        if (p.endsWith('/**')) steps.push({ kind: 'tree', dir: p.slice(0, -3), folder: at, agentIds: ids, bookkeeping: true })
        else steps.push({ kind: 'file', file: p, folder: at, agentIds: ids })
      }
    }
    for (const sub of CLAUDE_HOME_LAYER) steps.push({ kind: 'tree', dir: join(this.home, '.claude', sub), folder: null, agentIds: [], bookkeeping: false })
    return steps
  }

  /** The plan with its trees walked (`walk` = walkFiles or its async twin),
   *  bounded by READ_WALK_MAX across all trees; deduplicated, first wins. */
  // a generator so the async pass can release the loop every SLICE files
  // (drain() runs it straight through for the sync callers)
  private *materialize(steps: ReadStep[], walked: Map<string, string[]>): Generator<void, { watched: WatchedRead[]; truncated: boolean; dirs: Set<string> }> {
    const out: WatchedRead[] = []
    const seen = new Set<string>()
    const add = (file: string, folder: string | null, agentIds: string[], dir?: string): void => {
      if (seen.has(file)) return
      seen.add(file)
      out.push({ file, folder, agentIds, ...(dir ? { dir } : {}) })
    }
    let budget = READ_WALK_MAX
    const dirs = new Set<string>()
    for (const st of steps) {
      if (st.kind === 'file') {
        add(st.file, st.folder, st.agentIds)
        continue
      }
      const files = (walked.get(st.dir) ?? []).slice(0, Math.max(0, budget))
      budget -= files.length
      dirs.add(st.dir)
      // join(dir, rel) without re-normalizing 20 000 times: rel is clean
      // (readdir names joined with '/'), so the normalized dir + '/' + rel is it
      const prefix = join(st.dir, '_').slice(0, -1)
      let i = 0
      for (const rel of files) {
        if (++i % SLICE === 0) yield
        const f = prefix + rel
        if (!st.bookkeeping && isEngineBookkeeping(f)) continue
        add(f, st.folder, st.agentIds, st.dir)
      }
    }
    return { watched: out, truncated: budget <= 0, dirs }
  }

  private noteWalk(truncated: boolean, dirs: Set<string>): void {
    this.walkTruncated = truncated
    for (const d of dirs) this.walkedNow.add(d)
    if (truncated && !this.warnedWalk) {
      this.warnedWalk = true
      this.log(`seals: more than ${READ_WALK_MAX} engine config files — the read-hash watch stops there`)
    }
  }

  /** Every file watched by read hash, with the folder (null = home) and the
   *  agents that load it. Synchronous: the boot and tests; the server's
   *  tick walks with watchedReadsAsync. */
  watchedReads(): WatchedRead[] {
    const steps = this.readPlan()
    // each tree walked with what budget is left, in order — as one walk
    const walked = new Map<string, string[]>()
    let budget = READ_WALK_MAX
    for (const st of steps) {
      if (st.kind !== 'tree') continue
      const files = walkFiles(st.dir, Math.max(0, budget))
      walked.set(st.dir, files)
      budget -= files.length
    }
    const m = drain(this.materialize(steps, walked))
    this.noteWalk(m.truncated, m.dirs)
    return m.watched
  }

  /** watchedReads, walking with async readdir: the loop is released
   *  between directories. Same list, same order, same bound. */
  async watchedReadsAsync(): Promise<{ watched: WatchedRead[]; truncated: boolean; dirs: Set<string> }> {
    const steps = this.readPlan()
    const walked = new Map<string, string[]>()
    let budget = READ_WALK_MAX
    for (const st of steps) {
      if (st.kind !== 'tree') continue
      const files = await walkFilesAsync(st.dir, Math.max(0, budget))
      walked.set(st.dir, files)
      budget -= files.length
    }
    return released(this.materialize(steps, walked))
  }

  /** The watch entry of one file, from the plan alone — no tree walked
   *  (checkRead runs on a request: an owner's settings write). */
  private watchedEntryOf(file: string): Omit<WatchedRead, 'file'> | null {
    for (const st of this.readPlan()) {
      if (st.kind === 'file') {
        if (st.file === file) return { folder: st.folder, agentIds: st.agentIds }
        continue
      }
      if (file.startsWith(st.dir + '/') && (st.bookkeeping || !isEngineBookkeeping(file))) return { folder: st.folder, agentIds: st.agentIds, dir: st.dir }
    }
    return null
  }

  private fingerprint(file: string): string {
    try {
      const st = statSync(file, { bigint: true })
      return `${st.size}:${st.mtimeNs}:${st.ctimeNs}:${st.ino}`
    } catch {
      return 'absent'
    }
  }

  private readNow(file: string): ReadHash {
    const fp = this.fingerprint(file)
    const b = readOrNull(file)
    return { hash: b === null ? null : sha(b), bytes: file.endsWith('.json') && b !== null && b.length < 512 * 1024 ? b : null, fp }
  }

  /** Silos is about to edit a watched file: a foreign change is noticed
   *  first (its row), so re-sealing after the write never swallows it. */
  checkRead(file: string): void {
    this.touchedDuringPass?.add(file)
    const w = this.watchedEntryOf(file)
    this.observeRead(file, w ? w.folder : dirname(dirname(file)), w?.agentIds ?? [], w?.dir)
  }

  /** Silos wrote a watched file (capability states): its bytes are the new
   *  last read. */
  resealRead(file: string): void {
    this.touchedDuringPass?.add(file)
    const n = this.readNow(file)
    this.readHashes.set(file, n)
    if (n.hash === null) delete this.cache.reads[file]
    else this.cache.reads[file] = n.hash
    this.saveCache()
  }

  // ---- the engine's plugins/ tree: only what the record names loads ----

  private pluginsRoot(): string {
    return join(this.home, '.claude', 'plugins') + '/'
  }
  private pluginRecordFile(): string {
    return join(this.home, '.claude', ENGINE_PLUGIN_RECORD)
  }

  private readPluginRecord(): PluginRecordRead {
    const plugins = parsePluginRecord(readOrNull(this.pluginRecordFile()))
    return plugins === null ? { readable: false, plugins: this.cache.pluginRecord?.plugins ?? {} } : { readable: true, plugins }
  }

  private recordPassNow(): RecordPass {
    const prev = this.cache.pluginRecord
    const cur = this.readPluginRecord()
    const now = installPathsOf(cur.plugins)
    const kept = new Set(prev === undefined ? [] : [...installPathsOf(prev.plugins)].filter((p) => now.has(p)))
    return { prev, cur, kept }
  }

  /** May a change to `file` (under the engine's plugins/ tree) be a row? Only
   *  inside a version directory the record named at Silos' last read AND
   *  still names now — an in-place edit of what the engine loads. A file
   *  under a path the previous record did not name (a version fetched before
   *  the record is rewritten, the catalog, caches) is the engine's storage.
   *  The record file itself is judged by its own diff (reconcileReads). */
  private pluginFileMayRow(file: string): boolean {
    if (file === this.pluginRecordFile()) return false
    return underAny(file, (this.recordPass ?? this.recordPassNow()).kept)
  }

  /** The record now vs Silos' last read: a plugin gained or lost is a row
   *  (installed / removed outside Silos); a plugin moved to another version
   *  is the engine's routine — a page line; the record turning unreadable,
   *  or readable again, is the configChanged row on that file. The read is
   *  persisted (it survives a restart); the first read is the seal. */
  private settlePluginRecord(pass: RecordPass): void {
    const { prev, cur } = pass
    this.cache.pluginRecord = cur
    if (prev === undefined) return
    const at = new Date(this.now()).toISOString()
    if (prev.readable !== cur.readable) this.raiseConfigRow(this.pluginRecordFile(), null, [], null, null, { record: true })
    if (!cur.readable) return
    const added = Object.keys(cur.plugins).filter((k) => !(k in prev.plugins))
    const removed = Object.keys(prev.plugins).filter((k) => !(k in cur.plugins))
    if (added.length > 0) this.raisePluginsRow('installed', added)
    if (removed.length > 0) this.raisePluginsRow('removed', removed)
    for (const [k, was] of Object.entries(prev.plugins)) {
      const is = cur.plugins[k]
      if (!is || (is.version === was.version && is.installPath === was.installPath)) continue
      // the version words when both name one and they differ, else the
      // version directory's name (a re-fetch under the same version)
      const byVersion = was.version !== null && is.version !== null && was.version !== is.version
      const label = (e: PluginRecordEntry): string => (byVersion ? e.version! : (e.installPath?.split('/').pop() ?? '?'))
      const from = label(was),
        to = label(is)
      this.addPageLine({ kind: 'pluginVersion', at, plugin: k, from, to, text: `${k.split('@')[0]!} ${from} → ${to}` })
    }
  }

  // a page line kept in the cache (the newest PAGE_LINES_MAX): a read pass
  // saves it with its reads; outside a pass it is saved now
  private addPageLine(l: PageLine): void {
    this.cache.pageLines.push(l)
    if (this.cache.pageLines.length > PAGE_LINES_MAX) this.cache.pageLines.splice(0, this.cache.pageLines.length - PAGE_LINES_MAX)
    this.readsDirty = true
    if (this.recordPass === null) this.saveCache()
  }

  private raisePluginsRow(change: 'installed' | 'removed', plugins: string[]): void {
    const day = dayOf(this.now())
    const open = this.cache.rows.find(
      (r): r is Extract<SealRow, { kind: 'enginePlugins' }> => r.kind === 'enginePlugins' && r.change === change && r.day === day,
    )
    if (open) {
      for (const p of plugins) if (!open.plugins.includes(p)) open.plugins.push(p)
      open.at = new Date(this.now()).toISOString()
      this.saveCache()
      return
    }
    this.addRow({ kind: 'enginePlugins', change, plugins: [...plugins], day })
  }

  private observeRead(file: string, folder: string | null, agentIds: string[], dir?: string): void {
    const prev = this.readHashes.get(file)
    // the stat short-circuit only for the walked trees (~/.claude/plugins can
    // hold thousands of files); a named file (settings*.json, .mcp.json) is
    // always re-hashed — a same-size edit inside one timestamp tick is real
    if (dir !== undefined && prev && prev.fp !== 'absent' && prev.fp === this.fingerprint(file)) return
    this.applyRead(file, folder, agentIds, dir, prev, this.readNow(file))
  }

  // what a read of `file` means (observeRead's rules, the reading given —
  // read synchronously or by the async pass)
  private applyRead(file: string, folder: string | null, agentIds: string[], dir: string | undefined, prev: ReadHash | undefined, n: ReadHash): void {
    // what Silos last read: this run's read, else the boot cache's
    const known: string | null | undefined = prev ? prev.hash : file in this.cache.reads ? this.cache.reads[file]! : undefined
    this.readHashes.set(file, n)
    if ((n.hash ?? undefined) !== this.cache.reads[file]) this.readsDirty = true
    if (n.hash === null) delete this.cache.reads[file]
    else this.cache.reads[file] = n.hash
    // under the engine's plugins/ tree only what the record names loads
    if (file.startsWith(this.pluginsRoot()) && !this.pluginFileMayRow(file)) return
    // first sight (a folder newly watched, the first boot): the read is the
    // seal — unless it sits in a directory already walked: it APPEARED
    if (known === undefined) {
      if (n.hash !== null && dir !== undefined && this.cache.dirs.includes(dir)) this.raiseConfigRow(file, folder, agentIds, null, n.bytes)
      return
    }
    if (known === n.hash) return
    this.raiseConfigRow(file, folder, agentIds, prev?.bytes ?? null, n.bytes)
  }

  private raiseConfigRow(
    file: string,
    folder: string | null,
    agentIds: string[],
    before: Buffer | null,
    after: Buffer | null,
    opts: { record?: true } = {},
  ): void {
    const day = dayOf(this.now())
    const engineOnly = /\/\.claude\/settings[^/]*\.json$/.test(file) && before !== null && after !== null ? onlyEngineKeys(before, after) : null
    if (engineOnly !== null) {
      this.addPageLine({ kind: 'engineKeys', at: new Date(this.now()).toISOString(), file, folder: folder ?? '', agentIds, keys: engineOnly })
      return
    }
    if (isEngineBookkeeping(file) || this.cache.seen.includes(`config|${file}|${day}`)) return
    const open = this.cache.rows.find(
      (r): r is Extract<SealRow, { kind: 'configChanged' }> => r.kind === 'configChanged' && r.folder === folder && r.day === day && r.record === opts.record,
    )
    if (open) {
      if (!open.files.includes(file)) open.files.push(file)
      open.at = new Date(this.now()).toISOString()
      this.saveCache()
      return
    }
    this.addRow({ kind: 'configChanged', folder, agentIds, files: [file], day, ...(opts.record ? { record: true as const } : {}) })
  }

  reconcileReads(): void {
    this.walkedNow.clear()
    const pass = this.recordPassNow()
    this.recordPass = pass
    try {
      const watched = this.watchedReads()
      for (const w of watched) this.observeRead(w.file, w.folder, w.agentIds, w.dir)
      if (!this.walkTruncated) this.sweepGonePluginFiles(new Set(watched.map((w) => w.file)))
      this.settlePluginRecord(pass)
    } finally {
      this.recordPass = null
    }
    for (const d of this.walkedNow) if (!this.cache.dirs.includes(d)) this.cache.dirs.push(d)
    this.saveCache()
  }

  /** The read-hash pass of the server's tick: the same rules and results as
   *  reconcileReads, but it never holds the event loop — the trees are
   *  walked with async readdir, the files stat'ed and read async in batches
   *  of READ_BATCH with the loop released between batches (measured: a
   *  20 000-file ~/.claude/plugins held the loop ~850 ms a minute). Never
   *  overlaps itself: a call while one runs gets the running pass. A file
   *  Silos itself checks or reseals meanwhile (checkRead / resealRead, an
   *  owner's settings write) is left to that newer reading. */
  reconcileReadsAsync(): Promise<void> {
    this.readsRunning ??= this.readsPass().finally(() => {
      this.readsRunning = null
    })
    return this.readsRunning
  }

  private async readsPass(): Promise<void> {
    this.readsDirty = false
    const recordBefore = JSON.stringify(this.cache.pluginRecord ?? null)
    const touched = new Set<string>()
    this.touchedDuringPass = touched
    const pass = this.recordPassNow()
    this.recordPass = pass
    try {
      const { watched, truncated, dirs } = await this.watchedReadsAsync()
      for (let i = 0; i < watched.length; i += READ_BATCH) {
        const batch = watched.slice(i, i + READ_BATCH)
        const reads = await Promise.all(
          batch.map(async (w) => {
            const prev = this.readHashes.get(w.file)
            const fp = await fingerprintAsync(w.file)
            if (w.dir !== undefined && prev && prev.fp !== 'absent' && prev.fp === fp) return null
            return { prev, n: await readHashAsync(w.file, fp) }
          }),
        )
        for (let j = 0; j < batch.length; j++) {
          const w = batch[j]!,
            r = reads[j]
          if (!r || touched.has(w.file)) continue
          this.applyRead(w.file, w.folder, w.agentIds, w.dir, this.readHashes.get(w.file), r.n)
        }
        await new Promise<void>((resolve) => setImmediate(resolve))
      }
      this.walkedNow.clear()
      this.noteWalk(truncated, dirs)
      if (!this.walkTruncated) await released(this.sweepGone(new Set(watched.map((w) => w.file))))
      this.settlePluginRecord(pass)
    } finally {
      this.recordPass = null
      this.touchedDuringPass = null
    }
    for (const d of this.walkedNow)
      if (!this.cache.dirs.includes(d)) {
        this.cache.dirs.push(d)
        this.readsDirty = true
      }
    if (JSON.stringify(this.cache.pluginRecord ?? null) !== recordBefore) this.readsDirty = true
    // rows and their folds saved themselves (addRow / raise*); the rest only if changed
    if (this.readsDirty) this.saveCache()
  }

  /** A file Silos read under the engine's plugins/ tree that the walk no
   *  longer finds: a deletion inside a version directory the record still
   *  names is a row (rule 2); any other (an old version directory the engine
   *  pruned, its catalog, caches) just leaves the read hash. Only on a walk
   *  that was not cut by READ_WALK_MAX — a cut walk proves nothing gone. */
  private sweepGonePluginFiles(walked: ReadonlySet<string>): void {
    drain(this.sweepGone(walked))
  }

  private *sweepGone(walked: ReadonlySet<string>): Generator<void, void> {
    const root = this.pluginsRoot()
    let i = 0
    for (const file of Object.keys(this.cache.reads)) {
      if (++i % SLICE === 0) yield
      if (!file.startsWith(root) || walked.has(file) || lstatOrNull(file) !== null) continue
      this.readsDirty = true
      delete this.cache.reads[file]
      this.readHashes.delete(file)
      if (!isEngineBookkeeping(file) && this.pluginFileMayRow(file)) this.raiseConfigRow(file, null, [], null, null)
    }
  }

  /** Engine-routine changes (only engine keys; a plugin's version moved):
   *  the page's lines. A plugin line is the home layer's — every agent's. */
  pageLines(agentId?: string): PageLine[] {
    return this.cache.pageLines.filter((l) => agentId === undefined || l.kind === 'pluginVersion' || l.agentIds.includes(agentId))
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Files under `dir` (relative posix paths), regular files and — with
 *  `links` — symlinks as entries; bounded. */
export function walkFiles(dir: string, max: number, opts: { links?: boolean } = {}): string[] {
  const out: string[] = []
  const go = (d: string, prefix: string): void => {
    let entries
    try {
      entries = readdirSync(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (out.length >= max) return
      const rel = prefix ? `${prefix}/${e.name}` : e.name
      if (e.isDirectory()) go(join(d, e.name), rel)
      else if (e.isFile() || (opts.links && e.isSymbolicLink())) out.push(rel)
    }
  }
  go(dir, '')
  return out
}

/** A slice of a long synchronous loop of the read pass: the async pass
 *  releases the event loop between slices. */
const SLICE = 2_000
function drain<T>(g: Generator<void, T>): T {
  for (;;) {
    const r = g.next()
    if (r.done) return r.value
  }
}
async function released<T>(g: Generator<void, T>): Promise<T> {
  for (;;) {
    const r = g.next()
    if (r.done) return r.value
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
}

/** walkFiles with async readdir — the same files, the same order, the same
 *  bound; the event loop is free between directories. */
export async function walkFilesAsync(dir: string, max: number, opts: { links?: boolean } = {}): Promise<string[]> {
  const out: string[] = []
  const go = async (d: string, prefix: string): Promise<void> => {
    let entries
    try {
      entries = await readdir(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (out.length >= max) return
      const rel = prefix ? `${prefix}/${e.name}` : e.name
      if (e.isDirectory()) await go(join(d, e.name), rel)
      else if (e.isFile() || (opts.links && e.isSymbolicLink())) out.push(rel)
    }
  }
  await go(dir, '')
  return out
}

// the async twins of Seals.fingerprint / readNow (same shapes, same bytes)
async function fingerprintAsync(file: string): Promise<string> {
  try {
    const st = await stat(file, { bigint: true })
    return `${st.size}:${st.mtimeNs}:${st.ctimeNs}:${st.ino}`
  } catch {
    return 'absent'
  }
}

// past this a file is hashed as a stream (chunks between which the loop runs)
const STREAM_HASH_OVER = 1024 * 1024

async function readHashAsync(file: string, fp: string): Promise<ReadHash> {
  try {
    const st = await lstat(file)
    if (st.isSymbolicLink()) return { hash: sha(Buffer.from(`link:${await readlink(file)}`)), bytes: null, fp }
    if (!st.isFile()) return { hash: sha(Buffer.from('not-a-file')), bytes: null, fp }
    if (st.size > STREAM_HASH_OVER) {
      const h = createHash('sha256')
      for await (const chunk of createReadStream(file)) h.update(chunk as Buffer)
      return { hash: h.digest('hex'), bytes: null, fp }
    }
    const b = await readFile(file)
    return { hash: sha(b), bytes: file.endsWith('.json') && b.length < 512 * 1024 ? b : null, fp }
  } catch {
    return { hash: null, bytes: null, fp }
  }
}

function pruneEmptyDirs(dir: string): void {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue
    const p = join(dir, e.name)
    pruneEmptyDirs(p)
    try {
      if (readdirSync(p).length === 0) rmSync(p, { recursive: false, force: true })
    } catch {
      /* not empty */
    }
  }
}

function flatten(v: unknown, prefix: string, out: Map<string, string>): void {
  if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
    for (const [k, x] of Object.entries(v)) flatten(x, prefix ? `${prefix}.${k}` : k, out)
  } else {
    out.set(prefix, JSON.stringify(v))
  }
}

/** The keys a settings diff touches, when ALL of them are engine keys
 *  (ENGINE_KEYS, or below one); null when anything else changed or a side
 *  does not parse. */
export function onlyEngineKeys(before: Buffer, after: Buffer): string[] | null {
  let a: unknown, b: unknown
  try {
    a = JSON.parse(before.toString('utf8'))
    b = JSON.parse(after.toString('utf8'))
  } catch {
    return null
  }
  const fa = new Map<string, string>(),
    fb = new Map<string, string>()
  flatten(a, '', fa)
  flatten(b, '', fb)
  const changed = new Set<string>()
  for (const [k, v] of fa) if (fb.get(k) !== v) changed.add(k)
  for (const k of fb.keys()) if (!fa.has(k)) changed.add(k)
  if (changed.size === 0) return null
  const engine = (k: string): string | null => ENGINE_KEYS.find((e) => k === e || k.startsWith(`${e}.`)) ?? null
  const keys = new Set<string>()
  for (const k of changed) {
    const e = engine(k)
    if (e === null) return null
    keys.add(e)
  }
  return [...keys]
}
