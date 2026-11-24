// harnesses/claude-code/local-settings.ts — THE one writer of a folder's
// <folder>/.claude/settings.local.json, the only file Silos writes for what
// a project's conversations load (spec tools-origin §2 rule 3, §7). Every
// switch of Project › Tools goes through `editLocalSettings` (loads/
// switch.ts); nothing else in Silos writes this file.
//
//  · contained: <folder>/.claude is checked component by component
//    (contained-dir.ts) — a link leading outside the folder is refused, the
//    file is read and written in the REAL directory, never through a link;
//  · a HOME folder is refused: where <folder>/.claude is a login's own
//    config dir (the folder is $HOME, or lies inside ~/.claude), that file
//    is Claude Code's for EVERY project — a project switch never writes there
//    (the machine's own line does, through settings.ts editUserSettings);
//  · an existing file that does not parse as a JSON object is the owner's
//    hand-edited config in an unknown state: refused, never overwritten
//    (only a truly absent file starts empty — the PrefsStore rule, b26cf85);
//  · read-modify-write: every unknown key kept, pretty 2-space JSON, atomic
//    tmp+rename; the seal's read hash noticed before and renewed after
//    (seals.ts watches this file by read hash — Claude Code writes it too);
//  · after a write the file is kept git-ignored through .git/info/exclude
//    (Claude Code only auto-ignores it when IT creates the file; the
//    repository's tracked .gitignore is the owner's, never touched).
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, resolve, sep } from 'node:path'
import { sealHooks } from '../../seal-hooks.js'
import { containedDir, ContainmentError } from '../../contained-dir.js'
import { LoadsSwitchError } from '../contract.js'

export const LOCAL_SETTINGS = '.claude/settings.local.json'
const LOCAL_FILE = 'settings.local.json'

export type Json = Record<string, unknown>

const asObject = (v: unknown): Json | null => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Json) : null)
const real = (p: string): string => {
  try {
    return realpathSync(p)
  } catch {
    return resolve(p)
  }
}
const inside = (p: string, dir: string): boolean => p === dir || p.startsWith(dir.endsWith(sep) ? dir : dir + sep)

/** Whether <folder>/.claude is (or lies inside) a login's own config dir —
 *  `home`'s ~/.claude and any other config dir given: that settings file is
 *  the engine's for every project, never a project's local layer. */
export function isConfigHome(folder: string, home: string, configDirs: string[] = []): boolean {
  const claudeDir = real(join(real(folder), '.claude'))
  return [join(home, '.claude'), ...configDirs].map(real).some((d) => inside(claudeDir, d))
}

export const HOME_REFUSAL = 'this folder’s .claude is Claude Code’s own config folder — its settings reach every project, so Silos doesn’t switch anything here'

/** When the folder's local settings file last changed (its mtime, ms) —
 *  any key, by anyone; null when there is none. A switch's proof is read
 *  from readings newer than this (switch-proof.ts). */
export function localSettingsChangedAt(folder: string): number | null {
  try {
    return statSync(join(folder, LOCAL_SETTINGS)).mtimeMs
  } catch {
    return null
  }
}

/** Read-modify-write of the folder's local settings. `mutate` returns false
 *  for a no-op (nothing written). Throws LoadsSwitchError 409 for a home
 *  folder, a link out of the folder, or a file it can't read as an object. */
export function editLocalSettings(folder: string, home: string, mutate: (settings: Json) => boolean, configDirs: string[] = []): boolean {
  if (isConfigHome(folder, home, configDirs)) throw new LoadsSwitchError(HOME_REFUSAL, 409)
  const file = join(folder, LOCAL_SETTINGS)
  const realClaude = (create: boolean): string | null => {
    try {
      return containedDir(folder, ['.claude'], { create })
    } catch (err) {
      if (err instanceof ContainmentError) throw new LoadsSwitchError(err.message, 409)
      throw err
    }
  }
  const existing = realClaude(false)
  if (existing !== null) sealHooks().beforeOwnEdit?.(join(existing, LOCAL_FILE))
  let raw: string | null
  try {
    if (existing === null) throw Object.assign(new Error('absent'), { code: 'ENOENT' })
    raw = readFileSync(join(existing, LOCAL_FILE), 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new LoadsSwitchError(`${file} exists but could not be read — fix or remove it; Silos won't overwrite it`, 409)
    }
    raw = null
  }
  let settings: Json
  if (raw === null) {
    settings = {}
  } else {
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      throw new LoadsSwitchError(`${file} exists but is not valid JSON — fix or remove it; Silos won't overwrite it`, 409)
    }
    const obj = asObject(parsed)
    if (obj === null) throw new LoadsSwitchError(`${file} exists but is not a JSON object — fix or remove it; Silos won't overwrite it`, 409)
    settings = obj
  }
  if (!mutate(settings)) return false
  const dir = realClaude(true)!
  const into = join(dir, LOCAL_FILE)
  const tmp = `${into}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n')
  renameSync(tmp, into) // atomic: never a half-written settings file; a link at the name is replaced
  sealHooks().afterOwnEdit?.(into)
  ensureLocalSettingsIgnored(folder)
  return true
}

// If the folder is a git repo and the path is not already ignored, append
// it to .git/info/exclude (the repo's local, unversioned exclude file —
// created if missing). Any git failure (no git, not a repo) means skipping
// quietly — the settings write itself already succeeded. Synchronous git,
// BOUNDED (3 s, SIGKILL): known debt of the event-loop guard
// (test/no-sync-spawn.test.ts) — an owner's settings write, rare.
export function ensureLocalSettingsIgnored(folder: string): void {
  let commonDir: string
  try {
    commonDir = execFileSync('git', ['-C', folder, 'rev-parse', '--git-common-dir'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 3000,
      killSignal: 'SIGKILL',
    }).trim()
  } catch {
    return // not a git repo (or no git): nothing to ignore
  }
  try {
    execFileSync('git', ['-C', folder, 'check-ignore', '-q', LOCAL_SETTINGS], { stdio: 'ignore', timeout: 3000, killSignal: 'SIGKILL' })
    return // already ignored (global excludes, .gitignore, a previous pass…)
  } catch {
    // not ignored yet — fall through and append
  }
  try {
    const dir = isAbsolute(commonDir) ? commonDir : resolve(folder, commonDir)
    const excludeDir = join(dir, 'info')
    const exclude = join(excludeDir, 'exclude')
    const current = existsSync(exclude) ? readFileSync(exclude, 'utf8') : ''
    if (current.split('\n').some((l) => l.trim() === LOCAL_SETTINGS)) return
    mkdirSync(excludeDir, { recursive: true })
    const s = current === '' || current.endsWith('\n') ? '' : '\n'
    writeFileSync(exclude, `${current}${s}${LOCAL_SETTINGS}\n`)
  } catch {
    // the exclude file is best-effort — never fail the settings write over it
  }
}
