// harnesses/claude-code/loads/account-batches.ts — the plugins a claude.ai
// account sends, as Claude Code keeps them on disk.
//
// `<config dir>/plugins/synced/<organizationUuid>_<accountUuid>/` is one
// BATCH per login (plugins/ is one tree shared by every login Silos connects
// — accounts.ts SHARED_DIRS — so batches of several logins sit side by
// side). Inside a batch, every directory holding a plugin manifest
// (`.claude-plugin/plugin.json` with a string `name`) is a plugin copy; a
// copy's folder is `<folder>` or `<folder>~gN`, and the highest generation
// of a folder is the live one (a bare folder is generation 0). The plugin's
// id is its MANIFEST name `@synced` — `design@synced` even when the folder
// is a UUID (what `enabledPlugins` keys and `claude plugin disable` write).
//
// The layout is the engine's private storage, read by STRUCTURE only:
// anything of another shape (a batch name that is not two ids, a folder with
// no manifest or a manifest without a name) is skipped, never guessed at.
//
// A batch belongs to a login by its account id — exactly, when a start
// recorded that login's ids (the transcript's `session-owner` record); by
// elimination when exactly one login and one batch remain unmatched; else
// it is left unmatched («a Claude login Silos can't match yet»).
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

export interface SyncedPlugin {
  /** the manifest's name — what the engine calls the plugin */
  name: string
  /** `<name>@synced` — the enabledPlugins key */
  id: string
  /** the live copy's directory */
  dir: string
  /** the folder without its generation suffix (a UUID or a name) */
  folder: string
  generation: number
}

export interface AccountBatch {
  dir: string
  organizationUuid: string
  accountUuid: string
  plugins: SyncedPlugin[]
}

/** `<organizationUuid>_<accountUuid>`: two non-empty ids, no other `_`. */
const BATCH = /^([A-Za-z0-9-]+)_([A-Za-z0-9-]+)$/
/** `<folder>` or `<folder>~g<N>` */
const COPY = /^(.+?)(?:~g(\d+))?$/

function manifestName(dir: string): string | null {
  try {
    const m: unknown = JSON.parse(readFileSync(join(dir, '.claude-plugin', 'plugin.json'), 'utf8'))
    if (typeof m !== 'object' || m === null || Array.isArray(m)) return null
    const name = (m as Record<string, unknown>).name
    return typeof name === 'string' && name.trim() !== '' ? name : null
  } catch {
    return null
  }
}

const isDir = (p: string): boolean => {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

/** The live plugins of one batch directory: per folder its highest
 *  generation that holds a manifest; of two folders with one manifest name,
 *  the higher generation (then the folder name, for a stable answer). */
export function readBatchPlugins(batchDir: string): SyncedPlugin[] {
  let names: string[]
  try {
    names = readdirSync(batchDir)
  } catch {
    return []
  }
  const byFolder = new Map<string, SyncedPlugin>()
  for (const entry of names.sort()) {
    if (entry.startsWith('.')) continue
    const m = COPY.exec(entry)
    if (!m) continue
    const dir = join(batchDir, entry)
    if (!isDir(dir)) continue
    const name = manifestName(dir)
    if (name === null) continue
    const folder = m[1]!
    const generation = m[2] === undefined ? 0 : Number(m[2])
    const prev = byFolder.get(folder)
    if (!prev || generation > prev.generation) byFolder.set(folder, { name, id: `${name}@synced`, dir, folder, generation })
  }
  const byName = new Map<string, SyncedPlugin>()
  for (const p of byFolder.values()) {
    const prev = byName.get(p.name)
    if (!prev || p.generation > prev.generation || (p.generation === prev.generation && p.folder < prev.folder)) byName.set(p.name, p)
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
}

/** Every batch under `<config dir>/plugins/synced` (missing tree: none). */
export function readAccountBatches(syncedRoot: string): AccountBatch[] {
  let names: string[]
  try {
    names = readdirSync(syncedRoot)
  } catch {
    return []
  }
  const out: AccountBatch[] = []
  for (const entry of names.sort()) {
    const m = BATCH.exec(entry)
    if (!m) continue
    const dir = join(syncedRoot, entry)
    if (!isDir(dir)) continue
    out.push({ dir, organizationUuid: m[1]!, accountUuid: m[2]!, plugins: readBatchPlugins(dir) })
  }
  return out
}

/** A login Silos knows, with the account id a start recorded for it (if any). */
export interface BatchLogin {
  key: string
  accountUuid?: string | null
}

export type BatchMatch = { login: string; by: 'account-id' | 'elimination' } | null

/** Which login each batch belongs to, in batch order: by account id; then,
 *  when exactly one login and one batch are left, the one to the other;
 *  else unmatched (null). */
export function matchBatches(batches: readonly { accountUuid: string }[], logins: BatchLogin[]): BatchMatch[] {
  const out: BatchMatch[] = batches.map(() => null)
  const taken = new Set<string>()
  batches.forEach((b, i) => {
    const login = logins.find((l) => !taken.has(l.key) && typeof l.accountUuid === 'string' && l.accountUuid === b.accountUuid)
    if (login) {
      out[i] = { login: login.key, by: 'account-id' }
      taken.add(login.key)
    }
  })
  const leftLogins = logins.filter((l) => !taken.has(l.key))
  const leftBatches = out.map((m, i) => (m === null ? i : -1)).filter((i) => i >= 0)
  // a login whose recorded id matched no batch has no batch here: it is not
  // a candidate for elimination
  const candidates = leftLogins.filter((l) => typeof l.accountUuid !== 'string')
  if (leftLogins.length === 1 && candidates.length === 1 && leftBatches.length === 1) {
    out[leftBatches[0]!] = { login: candidates[0]!.key, by: 'elimination' }
  }
  return out
}
