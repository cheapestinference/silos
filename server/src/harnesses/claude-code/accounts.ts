// accounts.ts — Providers v1: own Claude accounts. The 'default' account is
// the machine's `claude` login (~/.claude + ~/.claude.json); each directory
// under ~/.silos/claude-accounts/<name>/ is an EXTRA account whose
// CLAUDE_CONFIG_DIR is that same directory.
//
// "Connect another account" NEVER offers a claude.ai login of Silos's own
// (Anthropic policy: no embedded login, no token ever handled by the
// product). The server creates the directory and the sign-in is Claude's:
// the unmodified `CLAUDE_CONFIG_DIR=<dir> claude auth login`, either in the
// owner's terminal (the returned command) or in a terminal Silos opens in
// the UI (TerminalService.openAccountLogin — Silos carries the bytes, the
// owner pastes Claude's code into Claude's prompt). Whether an account is
// signed in, and as whom, is Claude's own answer to `claude auth status
// --json` under that account (auth-status.ts) — never a file Silos reads.
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmdirSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { shellQuote } from '../../shell-quote.js'
import type { ClaudeIdentity, ClaudeIdentityReader } from './auth-status.js'

// exported so providers-store can reuse it to validate the name of an
// 'account:<name>' id BEFORE resolving it to a directory.
export const ACCOUNT_NAME_RE = /^[a-z0-9][a-z0-9-]{0,31}$/
const NAME_RE = ACCOUNT_NAME_RE

// The dirs an account shares with the machine account. Transcripts
// (projects/) so the single-root index, --resume, lineage and the trash
// see every conversation wherever it was born; sessions/ so the console's
// lock scan keeps one dir; plugins/ so there is one plugin install. NOT
// .credentials.json (refresh tokens rotate — a shared file breaks the
// other logins) and NOT settings/skills as whole dirs/files (each has the
// account's own entries) — what of them the account must follow is below
// (followMachineSettings, followPersonalSkills).
export const SHARED_DIRS = ['projects', 'sessions', 'plugins'] as const

// Points <dir>/<shared> at <defaultConfigDir>/<shared>, creating the
// target when missing. Idempotent. A real directory WITH content is left
// alone (never destroy transcripts) and makes the result false; an empty
// real directory (claude creates projects/ eagerly) is replaced.
export function ensureSharedLinks(dir: string, defaultConfigDir: string): boolean {
  return linkAndFollow(dir, defaultConfigDir).shared
}

/** Whether an account's settings.json follows the machine's now: `followed`
 *  it holds every key the machine sets (written, or already so); otherwise
 *  why not — its own file can't be read as an object (never clobbered), or
 *  the machine's can't (nothing is known to follow). */
export type FollowAnswer = { followed: true } | { followed: false; why: 'account-unreadable' | 'machine-unreadable' | 'error'; file: string }

function linkAndFollow(dir: string, defaultConfigDir: string): { shared: boolean; settings: FollowAnswer } {
  let shared = true
  for (const name of SHARED_DIRS) {
    const target = join(defaultConfigDir, name)
    const link = join(dir, name)
    mkdirSync(target, { recursive: true })
    let st: ReturnType<typeof lstatSync> | null = null
    try {
      st = lstatSync(link)
    } catch {
      st = null
    }
    if (st?.isSymbolicLink()) {
      if (readlinkSync(link) === target) continue
      // a link elsewhere (an older layout, a hand edit): repoint it
      unlinkSync(link)
    } else if (st?.isDirectory()) {
      if (readdirSync(link).length > 0) {
        shared = false
        continue
      }
      rmdirSync(link)
    } else if (st) {
      shared = false // a file where a dir should be — not ours to touch
      continue
    }
    symlinkSync(target, link)
  }
  for (const name of FOLLOWED_DIRS) followMachineDir(dir, defaultConfigDir, name)
  for (const name of FOLLOWED_FILES) followMachineDir(dir, defaultConfigDir, name)
  followPersonalSkills(dir, defaultConfigDir)
  return { shared, settings: followMachineSettings(dir, defaultConfigDir) }
}

// An extra account is the SAME Claude with another login
// (switching accounts must never change the result). So the account's
// settings.json follows the machine's ~/.claude/settings.json KEY BY KEY —
// every key the machine sets (plugins and their skills/MCP servers, hooks —
// Silos' own SessionStart briefing, births and inbox among them —,
// permissions, env, model, effort, and above all transcript retention:
// projects/ is SHARED, so an account left on Claude Code's 30-day default
// deletes every agent's transcripts past 30 days — hundreds of runs
// were once lost that way while ~/.claude said 180). The account keeps only what
// the machine doesn't set, and never the machine's credentials (env:
// followedEnv). Written whenever Silos looks at the account; never written:
// credentials and ~/.claude itself (read-only to Silos).
function followMachineSettings(dir: string, defaultConfigDir: string): FollowAnswer {
  const machinePath = join(defaultConfigDir, 'settings.json')
  // no file = the machine sets nothing (a key it dropped must drop here
  // too); a file that doesn't parse = unknown — leave the account as it is
  const machine = existsSync(machinePath) ? readJsonObject(machinePath) : {}
  if (!machine) return { followed: false, why: 'machine-unreadable', file: machinePath }
  const path = join(dir, 'settings.json')
  let own: Record<string, unknown> = {}
  if (existsSync(path)) {
    const parsed = readJsonObject(path)
    // an unreadable file of the account's — never clobbered, and said
    if (!parsed) return { followed: false, why: 'account-unreadable', file: path }
    own = parsed
  }
  // what Silos wrote last time, so a key the machine DROPS is removed only
  // when the account still holds Silos' copy — never the account's own value
  const ledgerPath = join(dir, FOLLOW_LEDGER)
  const ledger = (existsSync(ledgerPath) ? readJsonObject(ledgerPath) : null) ?? {}
  const next = { ...own }
  const wrote: Record<string, unknown> = {}
  for (const key of new Set([...Object.keys(machine), ...Object.keys(ledger)])) {
    if (key in machine) {
      const value = key === 'env' ? followedEnv(machine.env) : machine[key]
      next[key] = value
      wrote[key] = value
    } else if (key in ledger && JSON.stringify(own[key]) === JSON.stringify(ledger[key])) {
      delete next[key]
    }
  }
  if (JSON.stringify(next) !== JSON.stringify(own)) {
    const tmp = `${path}.silos-tmp`
    writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 })
    renameSync(tmp, path)
  }
  if (JSON.stringify(wrote) !== JSON.stringify(ledger)) writeFileSync(ledgerPath, JSON.stringify(wrote) + '\n', { mode: 0o600 })
  return { followed: true }
}

// Silos' own note of what it last wrote into the account's settings.json
// (a file Claude Code never reads — unknown keys in settings.json itself
// would be Claude's to complain about).
const FOLLOW_LEDGER = '.silos-followed.json'

// The machine's env minus what decides WHICH login and endpoint a process
// uses: an API key, a token or a gateway URL set for the machine's own
// claude would override the account's OAuth login — the account would no
// longer be itself.
const ACCOUNT_OWN_ENV = /^(ANTHROPIC_(API_KEY|AUTH_TOKEN|BASE_URL)|CLAUDE_CODE_OAUTH_TOKEN|CLAUDE_CONFIG_DIR)$/

function followedEnv(env: unknown): unknown {
  if (!env || typeof env !== 'object' || Array.isArray(env)) return env
  return Object.fromEntries(Object.entries(env as Record<string, unknown>).filter(([k]) => !ACCOUNT_OWN_ENV.test(k)))
}

function readJsonObject(path: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(readFileSync(path, 'utf8'))
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

// The operator's personal skills (~/.claude/skills/<name>) load in every
// folder on the machine account; an account's skills/ is its OWN dir
// (Claude syncs the account's claude.ai skills into skills/synced), so each
// personal skill is linked entry by entry — never `synced`, never over an
// entry of the account's own — and a link Silos made whose skill is gone
// is removed.
function followPersonalSkills(dir: string, defaultConfigDir: string): void {
  const source = join(defaultConfigDir, 'skills')
  const own = join(dir, 'skills')
  const names = existsSync(source) ? readdirSync(source).filter((n) => n !== 'synced' && !n.startsWith('.')) : []
  if (names.length === 0 && !existsSync(own)) return
  mkdirSync(own, { recursive: true })
  for (const n of names) followMachineDir(own, source, n)
  for (const n of readdirSync(own)) {
    const link = join(own, n)
    try {
      if (!lstatSync(link).isSymbolicLink()) continue
      const target = readlinkSync(link)
      if (target.startsWith(source + '/') && !existsSync(target)) unlinkSync(link)
    } catch {
      /* raced away */
    }
  }
}

// The operator's own assets an account FOLLOWS when they exist: the cockpit
// offers every style in ~/.claude/output-styles to every conversation, so
// a conversation on an extra account must see the same files or its pinned
// style silently falls back. Unlike SHARED_DIRS: the target is never
// created (~/.claude is the operator's, read-only to Silos), an account's
// own real dir is left alone, and none of it decides `shared` (that flag
// is about transcripts being visible). `rules`: the operator's personal
// rules load with their CLAUDE.md on every conversation (spec memory-places
// T2) — an account that keeps a rules folder of its own is named on the
// row instead (instructions.ts, reach.notOn).
export const FOLLOWED_DIRS = ['output-styles', 'agents', 'commands', 'rules'] as const
// the operator's user memory, loaded by every conversation on the machine
export const FOLLOWED_FILES = ['CLAUDE.md'] as const

function followMachineDir(dir: string, defaultConfigDir: string, name: string): void {
  const target = join(defaultConfigDir, name)
  const link = join(dir, name)
  let st: ReturnType<typeof lstatSync> | null = null
  try {
    st = lstatSync(link)
  } catch {
    st = null
  }
  if (st && !st.isSymbolicLink()) return // the account's own — never touched
  if (!existsSync(target)) return // nothing to follow (a dangling link is harmless)
  if (st) {
    if (readlinkSync(link) === target) return
    unlinkSync(link)
  }
  symlinkSync(target, link)
}

export interface ClaudeAccountView {
  name: string // 'default' or the directory name
  configDir: string | null // null = ~/.claude (the machine's account)
  providerId: string // id used by the provider selector ('default' | 'account:<name>')
  // Claude's own answer (auth-status.ts): an API-key login is signed in
  // with no email and no plan
  loggedIn: boolean
  email: string | null
  plan: string | null
  // true when claude run under this account writes its transcripts where
  // the index reads (projects/, sessions/ and plugins/ are links to the
  // machine account's). false = a real projects/ dir with content that
  // Silos refused to replace — that account's conversations stay invisible
  // until the owner moves them.
  shared: boolean
}

/** One extra account's answer to the follow (AccountsService.follow). */
export type AccountFollow = { name: string } & FollowAnswer

export interface AccountsPaths {
  dataDir: string
  // injectable for tests — defaults: the machine's real ones.
  defaultConfigDir?: string // ~/.claude
  // who each account is signed in as — Claude's answer, asked by the reader
  // (tests hand one with a fake runner: never the real claude)
  identity: ClaudeIdentityReader
}

export class AccountsService {
  private accountsDir: string
  private defaultConfigDir: string
  private identity: ClaudeIdentityReader

  constructor(paths: AccountsPaths) {
    this.accountsDir = join(paths.dataDir, 'claude-accounts')
    this.defaultConfigDir = paths.defaultConfigDir ?? join(homedir(), '.claude')
    this.identity = paths.identity
  }

  dirFor(name: string): string {
    return join(this.accountsDir, name)
  }

  // Identity of an account: Claude's answer under that account (kept a
  // short while unless `fresh`). Every look also re-asserts the links: an
  // account dir created before they existed (or by hand) gets them the
  // first time Silos looks at it.
  private async viewOf(name: string, configDir: string | null, fresh = false): Promise<ClaudeAccountView> {
    const shared = configDir === null ? true : this.linkShared(configDir)
    const id = await this.identity.read(configDir, { fresh })
    return {
      name,
      configDir,
      providerId: configDir === null ? 'default' : `account:${name}`,
      loggedIn: id.loggedIn,
      email: id.email,
      plan: id.plan,
      shared,
    }
  }

  /** The machine's own account, as Claude says it is signed in. */
  machineIdentity(): Promise<ClaudeIdentity> {
    return this.identity.read(null)
  }

  private extraNames(): string[] {
    try {
      return readdirSync(this.accountsDir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .sort()
    } catch {
      return [] // no extra accounts yet
    }
  }

  async list(): Promise<ClaudeAccountView[]> {
    return Promise.all([this.viewOf('default', null), ...this.extraNames().map((n) => this.viewOf(n, this.dirFor(n)))])
  }

  // Re-applies what every extra account follows of the machine (shared
  // links, FOLLOWED_*, settings) without asking anyone who is signed in —
  // the boot pass, the ~/.claude watcher (index.ts) and the «This machine»
  // switch, which names any account that did not follow (spec scopes §6).
  follow(): AccountFollow[] {
    return this.extraNames().map((name) => {
      const dir = this.dirFor(name)
      try {
        return { name, ...linkAndFollow(dir, this.defaultConfigDir).settings }
      } catch (err) {
        console.warn(`accounts: could not follow the machine for ${dir}:`, err)
        return { name, followed: false as const, why: 'error' as const, file: join(dir, 'settings.json') }
      }
    })
  }

  // name → config dir of every account, with NO side effect (list() re-links
  // the shared dirs on each read; a 5 s poll must not touch the disk) —
  // what the account load (account-load.ts) maps CLAUDE_CONFIG_DIR against.
  configDirs(): Array<{ name: string; configDir: string }> {
    const out = [{ name: 'default', configDir: this.defaultConfigDir }]
    try {
      for (const e of readdirSync(this.accountsDir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .sort((a, b) => a.name.localeCompare(b.name))) {
        out.push({ name: e.name, configDir: this.dirFor(e.name) })
      }
    } catch {
      /* no extra accounts yet */
    }
    return out
  }

  // Creates a new account's directory and returns instructions for the
  // owner. Idempotent on the name: if the directory already exists, errors
  // out (so a prior login is never silently overwritten).
  create(name: string): { name: string; configDir: string; command: string } {
    if (!NAME_RE.test(name)) throw new Error('invalid name (lowercase/digits/hyphens slug, max 32)')
    if (name === 'default') throw new Error("'default' is reserved for the machine's account")
    const dir = this.dirFor(name)
    if (existsSync(dir)) throw new Error('an account with that name already exists')
    // 0700: will hold credentials — same criterion as the rest of ~/.silos.
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    this.linkShared(dir)
    return { name, configDir: dir, command: `CLAUDE_CONFIG_DIR=${shellQuote(dir)} claude auth login` }
  }

  private linkShared(dir: string): boolean {
    try {
      return ensureSharedLinks(dir, this.defaultConfigDir)
    } catch (err) {
      console.warn(`accounts: could not share transcripts for ${dir}:`, err)
      return false
    }
  }

  // a fresh answer: the sign-in polls this until Claude says it is in
  async verify(name: string): Promise<ClaudeAccountView> {
    if (name === 'default') return this.viewOf('default', null, true)
    if (!NAME_RE.test(name)) throw new Error('invalid name')
    const dir = this.dirFor(name)
    if (!existsSync(dir)) throw new Error('account not found')
    return this.viewOf(name, dir, true)
  }
}
