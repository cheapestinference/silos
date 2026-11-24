// Managed adjustment of transcript retention. Claude Code deletes JSONL
// files older than `cleanupPeriodDays` (default 30 — verified on the
// owner's machine: the oldest one had exactly 30 days). For a product that
// promises history and threads that don't die, that's a hole, so Silos
// exposes it and can pin it.
//
// Writes OUTSIDE ~/.silos — the user's own ~/.claude/settings.json — and
// ONLY through `editUserSettings` (one writer, spec scopes §6, §8): a file
// it can't read as a JSON object is refused untouched (absent: created);
// read-modify-write keeps every other key and entry; atomic tmp+rename
// beside the REAL file (written through a symlink); the file is re-read
// right before the rename and the change re-applied if it moved (Claude
// Code writes this file too). Its callers: retention, push, the checklist,
// Silos' hooks in and out (each after a prior backup that never overwrites
// another), and the «This machine» line of a Tools row (loads/machine.ts —
// only on the owner's click that names the machine, no backup: the same
// switch undoes it).
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  copyFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { shellQuote, shellWords } from '../../shell-quote.js'

export const CLEANUP_DEFAULT_DAYS = 30
export const KEEP_FOREVER_DAYS = 3650
const MAX_DAYS = 36500

/** How one Silos hook stands in a settings.json: `installed` = an entry runs
 *  it AND its command points at a script that exists; `broken` = an entry
 *  names the script but the path in it leads nowhere (a moved or re-cloned
 *  repo, a path with spaces written unquoted, an npx cache that changed) —
 *  every session would log a hook error; `missing` = no entry names it. */
export type HookWiring = 'installed' | 'broken' | 'missing'

export interface ClaudeSettingsView {
  cleanupPeriodDays: number // effective: the file's value or Claude Code's default
  explicit: boolean // true if the key is written in settings.json
  // Claude Code's mobile push notifications ("an agent is waiting for
  // you") — true when absent: pushes fire by default on this machine.
  agentPushNotifEnabled: boolean
  pushExplicit: boolean
  // the Silos integration hooks in this settings.json (see plugin/hooks):
  // briefing = SessionStart session-start.sh · cronGate = PreToolUse
  // pre-cron.sh on CronCreate.
  hooks: { briefing: HookWiring; cronGate: HookWiring }
  // the engine's checklist on CURRENT models: the task tools ship on only
  // for the 4.x family; env.CLAUDE_CODE_ENABLE_TODO_TOOLS = '1' (documented)
  // brings them back on the 5 family, for every claude on this machine
  todoTools: boolean
  path: string
}

// The two hook entries as plugin/hooks/hooks.json declares them (matcher,
// timeout in seconds) — installed by path here, so the command is the
// script's path quoted for the shell Claude Code runs it in (a path with a
// space split into words and exited 127). server/test/claude-code-settings
// .test.ts holds these equal to hooks.json.
export const SILOS_HOOK_ENTRIES = {
  SessionStart: { matcher: 'startup|resume|clear|compact|fork', script: 'session-start.sh', timeout: 15 },
  PreToolUse: { matcher: 'CronCreate', script: 'pre-cron.sh', timeout: 10 },
} as const

// each Silos hook by the name Settings reads it under; `matchOn` = the
// matcher an existing entry must have to count (the briefing counts under
// any matcher: an older entry with fewer sources still runs it)
const SILOS_HOOKS = {
  briefing: { event: 'SessionStart', ...SILOS_HOOK_ENTRIES.SessionStart, matchOn: undefined },
  cronGate: { event: 'PreToolUse', ...SILOS_HOOK_ENTRIES.PreToolUse, matchOn: 'CronCreate' },
} as const
type HookName = keyof typeof SILOS_HOOKS

function readJson(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {}
  const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('settings.json is not an object')
  return raw as Record<string, unknown>
}

/** A user settings file the writer refuses to touch — the words name it. */
export class UserSettingsError extends Error {}

/** The file's text as it is now: null when absent; a file that exists and
 *  can't be read throws (refused, named). */
function readText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw new UserSettingsError(`${path} exists but could not be read — fix or remove it; Silos won't overwrite it`)
  }
}

/** The object a text holds: absent → {}; not JSON or not an object →
 *  refused, named. */
function parseObject(path: string, text: string | null): Record<string, unknown> {
  if (text === null) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new UserSettingsError(`${path} exists but is not valid JSON — fix or remove it; Silos won't overwrite it`)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new UserSettingsError(`${path} exists but is not a JSON object — fix or remove it; Silos won't overwrite it`)
  return parsed as Record<string, unknown>
}

/** How many times a change is re-applied over a file that moved under it
 *  before the writer gives up (the engine writes this file too). */
const REAPPLY_LIMIT = 5

/** THE writer of the user's settings file (spec scopes §8). `mutate` gets
 *  the file's object and changes it in place; false = nothing to write (no
 *  write, no backup). With `backupDir`, a prior copy of an existing file is
 *  made before the write (the older writers' discipline). Refuses — throws
 *  UserSettingsError, the file untouched — a file it can't read, that isn't
 *  JSON or isn't an object. Right before the rename the file is read again:
 *  if it moved, the change is re-applied to what it holds now.
 *  `beforeRename` is a test seam (another writer, between read and rename). */
export function editUserSettings(
  path: string,
  mutate: (obj: Record<string, unknown>) => boolean,
  opts: { backupDir?: string; beforeRename?: () => void } = {},
): { changed: boolean; backup: string | null } {
  const real = realTarget(path)
  let text = readText(real)
  let backup: string | null = null
  for (let i = 0; i < REAPPLY_LIMIT; i++) {
    const obj = parseObject(path, text)
    if (!mutate(obj)) return { changed: false, backup }
    if (opts.backupDir && text !== null && backup === null) backup = backupOf(real, opts.backupDir)
    mkdirSync(dirname(real), { recursive: true })
    const tmp = `${real}.tmp-${process.pid}-${Date.now()}-${i}`
    writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', { mode: 0o600 })
    opts.beforeRename?.()
    let now: string | null
    try {
      now = readText(real)
    } catch (err) {
      try {
        unlinkSync(tmp)
      } catch {
        /* gone */
      }
      throw err
    }
    if (now === text) {
      renameSync(tmp, real)
      return { changed: true, backup }
    }
    // someone wrote it meanwhile: the change goes onto what it holds now
    try {
      unlinkSync(tmp)
    } catch {
      /* gone */
    }
    text = now
  }
  throw new UserSettingsError(`${path} kept changing while Silos wrote it — try again`)
}

export function readClaudeSettings(path: string, home: string = homedir()): ClaudeSettingsView {
  let obj: Record<string, unknown> = {}
  try {
    obj = readJson(path)
  } catch {
    obj = {}
  }
  const v = obj.cleanupPeriodDays
  const explicit = typeof v === 'number' && Number.isFinite(v)
  const push = obj.agentPushNotifEnabled
  const pushExplicit = typeof push === 'boolean'
  const env = obj.env
  const todo = typeof env === 'object' && env !== null && (env as Record<string, unknown>).CLAUDE_CODE_ENABLE_TODO_TOOLS === '1'
  return {
    cleanupPeriodDays: explicit ? (v as number) : CLEANUP_DEFAULT_DAYS,
    explicit,
    agentPushNotifEnabled: pushExplicit ? (push as boolean) : true,
    pushExplicit,
    hooks: hooksStatus(obj, home),
    todoTools: todo,
    path,
  }
}

/** The checklist on current models: sets or removes the documented env var
 *  in the operator's settings.json (same discipline: prior backup, atomic,
 *  a corrupt file is never overwritten). Off removes ONLY this key and
 *  leaves the rest of `env` alone. */
export function writeTodoTools(path: string, enabled: boolean, backupDir: string): { view: ClaudeSettingsView; backup: string | null } {
  const { backup } = editUserSettings(
    path,
    (obj) => {
      const env = (typeof obj.env === 'object' && obj.env !== null ? obj.env : {}) as Record<string, unknown>
      if (enabled) env.CLAUDE_CODE_ENABLE_TODO_TOOLS = '1'
      else delete env.CLAUDE_CODE_ENABLE_TODO_TOOLS
      if (Object.keys(env).length > 0) obj.env = env
      else delete obj.env
      return true
    },
    { backupDir },
  )
  return { view: readClaudeSettings(path), backup }
}

/** The script a hook command runs, as a path: the shell word whose last
 *  segment is `script`, with a leading `~/`, `$HOME/` or `${HOME}/`
 *  expanded. null when no word names it, or it is not an absolute path once
 *  expanded (another variable — nothing Silos can check). */
export function hookScriptPath(command: string, script: string, home: string = homedir()): string | null {
  const word = shellWords(command).find((w) => basename(w) === script)
  if (word === undefined) return null
  const path = word.replace(/^(~|\$HOME|\$\{HOME\})(?=\/)/, home)
  return isAbsolute(path) && !path.includes('$') ? path : null
}

/** The command Silos writes for a hook: the script's path, shell-quoted (a
 *  path with spaces or quotes still runs as one word). */
export function hookCommand(hooksDir: string, script: string): string {
  return shellQuote(join(hooksDir, script))
}

type HookCommand = { command: string; timeout?: unknown }

// every command hook under `event` (in entries with `matcher`, when given) that names `script`
function commandsNaming(obj: Record<string, unknown>, event: string, script: string, matcher?: string): HookCommand[] {
  const hooks = obj.hooks
  if (!hooks || typeof hooks !== 'object') return []
  const entries = (hooks as Record<string, unknown>)[event]
  if (!Array.isArray(entries)) return []
  const out: HookCommand[] = []
  for (const e of entries) {
    if (!e || typeof e !== 'object') continue
    const entry = e as { matcher?: unknown; hooks?: unknown }
    if (matcher !== undefined && entry.matcher !== matcher) continue
    if (!Array.isArray(entry.hooks)) continue
    for (const h of entry.hooks) {
      if (h && typeof h === 'object' && typeof (h as { command?: unknown }).command === 'string' && (h as HookCommand).command.includes(script))
        out.push(h as HookCommand)
    }
  }
  return out
}

function runsItsScript(command: string, script: string, home: string): boolean {
  const p = hookScriptPath(command, script, home)
  if (p === null) return false
  try {
    return statSync(p).isFile()
  } catch {
    return false
  }
}

// whether each Silos hook is wired in this settings.json AND would run — a
// command matched by script NAME alone read «installed» for a moved repo
// while every session logged a hook error
function hooksStatus(obj: Record<string, unknown>, home: string): Record<HookName, HookWiring> {
  const one = (name: HookName): HookWiring => {
    const h = SILOS_HOOKS[name]
    const named = commandsNaming(obj, h.event, h.script, h.matchOn)
    if (named.length === 0) return 'missing'
    return named.some((c) => runsItsScript(c.command, h.script, home)) ? 'installed' : 'broken'
  }
  return { briefing: one('briefing'), cronGate: one('cronGate') }
}

function backupOf(path: string, backupDir: string): string {
  mkdirSync(backupDir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  let dest = join(backupDir, `settings.${stamp}.json`)
  let n = 1
  while (existsSync(dest)) dest = join(backupDir, `settings.${stamp}-${n++}.json`)
  if (existsSync(path)) copyFileSync(path, dest)
  return dest
}

// The file a settings path really is: a settings.json that is a symlink (a
// dotfile manager keeps the real file in its own repo) is written THROUGH
// the link — a rename over the link itself would replace it with a regular
// file and silently detach it from where the operator keeps it. A dangling
// link resolves to its target, so the file is created where it points.
function realTarget(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    try {
      if (lstatSync(path).isSymbolicLink()) return resolve(dirname(path), readlinkSync(path))
    } catch {
      /* no such file: it is created at `path` */
    }
    return path
  }
}

// Only cleanupPeriodDays; an integer between 1 and MAX_DAYS. Returns the new
// view and the backup path (null if the file didn't exist).
// Only agentPushNotifEnabled — same discipline (prior backup, atomic, the
// rest of the file untouched).
export function writeAgentPushNotif(path: string, enabled: boolean, backupDir: string): { view: ClaudeSettingsView; backup: string | null } {
  const { backup } = editUserSettings(
    path,
    (obj) => {
      obj.agentPushNotifEnabled = enabled
      return true
    },
    { backupDir },
  )
  return { view: readClaudeSettings(path), backup }
}

// Wires the Silos hooks (briefing + cron gate) into settings.json,
// idempotently: a missing one is ADDED (existing entries of any kind are
// preserved); a broken one — an entry naming Silos' own script whose path
// leads nowhere — gets its command rewritten to `hooksDir` (the entry, its
// matcher and its neighbours stay; a timeout is added when it had none).
// Installing removes nothing (uninstallSilosHooks is the way out). A new
// entry is written as SILOS_HOOK_ENTRIES declares it (every source, the
// timeout). `hooksDir` is where the plugin's scripts live (repo-paths.ts).
export function installSilosHooks(
  path: string,
  backupDir: string,
  hooksDir: string,
  home: string = homedir(),
): { view: ClaudeSettingsView; backup: string | null } {
  const { backup } = editUserSettings(
    path,
    (obj) => {
      const before = hooksStatus(obj, home)
      if (before.briefing === 'installed' && before.cronGate === 'installed') return false
      const hooks = (obj.hooks = (obj.hooks && typeof obj.hooks === 'object' ? obj.hooks : {}) as Record<string, unknown>)
      for (const name of Object.keys(SILOS_HOOKS) as HookName[]) {
        const h = SILOS_HOOKS[name]
        const command = hookCommand(hooksDir, h.script)
        if (before[name] === 'missing') {
          const arr = Array.isArray(hooks[h.event]) ? (hooks[h.event] as unknown[]) : ((hooks[h.event] = [] as unknown[]) as unknown[])
          arr.push({ matcher: h.matcher, hooks: [{ type: 'command', command, timeout: h.timeout }] })
        } else if (before[name] === 'broken') {
          for (const c of commandsNaming(obj, h.event, h.script, h.matchOn)) {
            c.command = command
            if (c.timeout === undefined) c.timeout = h.timeout
          }
        }
      }
      return true
    },
    { backupDir },
  )
  return { view: readClaudeSettings(path, home), backup }
}

// The way out: removes Silos' two hooks from settings.json and nothing else
// — exactly the commands the status above counts (the ones naming
// session-start.sh under SessionStart and pre-cron.sh under PreToolUse's
// CronCreate matcher), installed or broken. A hook entry left with no
// command goes with it, then an event left with no entry, then an empty
// `hooks`; every other hook, entry and key stays as it was. Idempotent: with
// nothing of Silos' in the file it is not rewritten (no backup).
export function uninstallSilosHooks(path: string, backupDir: string, home: string = homedir()): { view: ClaudeSettingsView; backup: string | null } {
  const { backup } = editUserSettings(
    path,
    (obj) => {
      const before = hooksStatus(obj, home)
      if (before.briefing === 'missing' && before.cronGate === 'missing') return false
      const hooks = obj.hooks as Record<string, unknown>
      for (const name of Object.keys(SILOS_HOOKS) as HookName[]) {
        const h = SILOS_HOOKS[name]
        const ours = new Set<unknown>(commandsNaming(obj, h.event, h.script, h.matchOn))
        if (ours.size === 0) continue
        const entries = (hooks[h.event] as unknown[]).filter((e) => {
          const entry = e as { hooks?: unknown } | null
          if (!entry || typeof entry !== 'object' || !Array.isArray(entry.hooks)) return true
          const kept = entry.hooks.filter((c) => !ours.has(c))
          if (kept.length === entry.hooks.length) return true
          entry.hooks = kept
          return kept.length > 0
        })
        if (entries.length > 0) hooks[h.event] = entries
        else delete hooks[h.event]
      }
      if (Object.keys(hooks).length === 0) delete obj.hooks
      return true
    },
    { backupDir },
  )
  return { view: readClaudeSettings(path, home), backup }
}

export function writeCleanupPeriodDays(path: string, days: number, backupDir: string): { view: ClaudeSettingsView; backup: string | null } {
  if (!Number.isInteger(days) || days < 1 || days > MAX_DAYS) throw new Error('invalid cleanupPeriodDays')
  const { backup } = editUserSettings(
    path,
    (obj) => {
      obj.cleanupPeriodDays = days
      return true
    },
    { backupDir },
  )
  return { view: readClaudeSettings(path), backup }
}
