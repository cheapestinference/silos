// skill-states.ts — the three states of a (skill, FOLDER), the unit the
// engine actually respects (Claude Code loads whatever sits under
// <folder>/.claude/skills in EVERY conversation there; two agents sharing a
// folder share skills). The states:
//
//   active    — in the folder, the engine sees it
//   held      — moved to Silos' held store (<dataDir>/skills-held/<folderKey>/
//               <name>), the engine no longer sees it — a real off, both
//               engines (OpenCode ALSO loads Silos' plugin/skills through its
//               config's skills.paths, so every OpenCode launch denies the
//               folder's held names by permission.skill —
//               harnesses/opencode/assemble.ts)
//   available — one of Silos' plugin skills (plugin/skills) the folder does
//               not load yet; adding = a real copy into the folder. Exactly
//               what addSkill can do — nothing else is offered as addable.
//
// Moves are a rename; ONLY a cross-device rename (EXDEV) falls back to
// copy + move-aside + rm, and the source path is always whole or gone
// (moveDir). The boot
// sync (skill-install.ts syncSkillCopies) only updates copies ALREADY
// present, so a held skill is never resurrected at startup — a test pins it.
//
// Personal skills (~/.claude/skills) are the operator's own disk and are
// never moved from here (invariant 3); they apply everywhere, so adding
// one to a folder would change nothing — refused with those words at the
// route.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { containedDir, ContainmentError } from './contained-dir.js'
import { createHash } from 'node:crypto'
import { basename, dirname, join, sep } from 'node:path'
import { parseSkillMd } from './complete-service.js'
import { canonicalFolder } from './folder-identity.js'

export interface HeldSkill {
  name: string
  description?: string
}

// Same regex + pure-dots guard as /api/skills/:name (server.ts SKILL_NAME):
// the regex alone lets dots-only names through ('..' — every character is
// valid in \w.:-), so both checks close the segment on their own.
const SKILL_NAME = /^[\w.:-]+$/
const PURE_DOTS = /^\.+$/

function assertName(name: string): void {
  if (!SKILL_NAME.test(name) || PURE_DOTS.test(name)) throw new Error(`invalid skill name: ${JSON.stringify(name)}`)
}

/** The base name a skill takes in a folder ("silos:team-plan" → "team-plan"). */
export function skillBaseName(name: string): string {
  return name.includes(':') ? name.slice(name.lastIndexOf(':') + 1) : name
}

// The held store's key for a folder: a sha256 of the folder's REALPATH
// (canonicalFolder; the resolved path when it doesn't exist) — a symlinked
// folder and its target are ONE folder to the engine, and two folders whose
// names differ only in '/' vs '.' vs '-' are two — plus that path written
// inside the store (FOLDER_FILE — '#' is never valid in a skill name, so it
// can't clash with a held skill directory), so a key reads back to its folder.
export const FOLDER_FILE = '#folder'

function hashKey(path: string): string {
  return createHash('sha256').update(path).digest('hex').slice(0, 32)
}

function folderKey(folder: string): string {
  return hashKey(canonicalFolder(folder))
}

/** The held store for one folder (pure: no disk). */
export function heldDirFor(dataDir: string, folder: string): string {
  return join(dataDir, 'skills-held', folderKey(folder))
}

/** The folder a held store belongs to, read from its FOLDER_FILE (null:
 *  missing or unreadable). */
export function heldStoreFolder(storeDir: string): string | null {
  try {
    const v = readFileSync(join(storeDir, FOLDER_FILE), 'utf8').trim()
    return v === '' ? null : v
  } catch {
    return null
  }
}

function markStore(dir: string, folder: string): void {
  const canonical = canonicalFolder(folder)
  if (heldStoreFolder(dir) === canonical) return
  try {
    writeFileSync(join(dir, FOLDER_FILE), canonical + '\n')
  } catch {
    /* the marker only reads the key back — never fail a move over it */
  }
}

/** The held store for one folder, marked with its folder once it exists. */
export function heldStoreFor(dataDir: string, folder: string): string {
  const dir = heldDirFor(dataDir, folder)
  if (existsSync(dir)) markStore(dir, folder)
  return dir
}

function skillsRootOf(folder: string): string {
  return join(folder, '.claude', 'skills')
}

// The REAL <folder>/.claude/skills, every component checked
// (contained-dir.ts): a link leading outside the folder refuses — a skill is
// never moved or copied through it. null: not there (create false).
function realSkillsRoot(folder: string, create: boolean): string | null {
  try {
    return containedDir(folder, ['.claude', 'skills'], { create })
  } catch (err) {
    if (err instanceof ContainmentError) throw new Error(err.message)
    throw err
  }
}

/** Defense in depth, same idiom as complete.skillReadme: the RESOLVED path
 *  must stay inside the resolved root (a symlinked skill dir pointing out of
 *  the folder is never moved as if it were the folder's). */
function containedIn(root: string, path: string): boolean {
  let real: string, realRoot: string
  try {
    real = realpathSync(path)
    realRoot = realpathSync(root)
  } catch {
    return false
  }
  return real !== realRoot && real.startsWith(realRoot + sep)
}

export interface MoveOps {
  renameSync: typeof renameSync
  cpSync: typeof cpSync
  rmSync: typeof rmSync
}
const REAL_OPS: MoveOps = { renameSync, cpSync, rmSync }

/** Move a directory; the source path is always whole or gone, never
 *  partial. A rename first; ONLY a cross-device refusal (EXDEV) falls back —
 *  any other refusal (EACCES on a read-only folder, ENOENT…) is rethrown
 *  with the source untouched. The fallback:
 *    1. copy src → dest; a copy that fails midway removes what landed;
 *    2. move src ASIDE with one rename on its own device, into the parent of
 *       its parent (for a folder skill <folder>/.claude, for a held one
 *       <dataDir>/skills-held) — never next to it, where the engine or the
 *       held listing would read it. A refusal here drops the copy: the move
 *       did not happen, src is whole — nothing was deleted yet, so no
 *       restore copy (which could itself fail midway) is ever needed;
 *    3. remove the aside. The move already stands (dest complete, src gone);
 *       a removal that fails partway leaves only that hidden aside behind.
 *  `ops` is a seam for tests (a simulated EXDEV). */
export function moveDir(src: string, dest: string, ops: MoveOps = REAL_OPS): void {
  try {
    ops.renameSync(src, dest)
    return
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err
  }
  try {
    ops.cpSync(src, dest, { recursive: true })
  } catch (err) {
    ops.rmSync(dest, { recursive: true, force: true })
    throw err
  }
  const aside = join(dirname(dirname(src)), `.silos-moved-${basename(src)}-${process.pid}-${Date.now()}`)
  try {
    ops.renameSync(src, aside)
  } catch (err) {
    ops.rmSync(dest, { recursive: true, force: true })
    throw err
  }
  try {
    ops.rmSync(aside, { recursive: true, force: true })
  } catch {
    /* the move stands; only the hidden aside is left to clean by hand */
  }
}

/** Turn a folder skill OFF: move <folder>/.claude/skills/<name> into the
 *  held store. The engine genuinely stops seeing it, in both engines. */
export function holdSkill(dataDir: string, folder: string, name: string): void {
  assertName(name)
  const root = skillsRootOf(folder)
  const real = realSkillsRoot(folder, false)
  const src = join(real ?? root, name)
  if (real === null || !existsSync(src)) throw new Error(`"${name}" is not in ${root} — nothing to turn off`)
  if (!containedIn(root, src)) throw new Error(`"${name}" resolves outside ${root} — refusing to move it`)
  if (!statSync(src).isDirectory()) throw new Error(`"${name}" is not a skill directory`)
  const heldDir = heldStoreFor(dataDir, folder)
  const dest = join(heldDir, name)
  if (existsSync(dest)) throw new Error(`a held copy of "${name}" already exists for this folder — turn it on (or remove the held copy) first`)
  mkdirSync(heldDir, { recursive: true })
  markStore(heldDir, folder)
  moveDir(src, dest)
}

/** Turn a held skill back ON: move it from the held store to the folder. */
export function activateSkill(dataDir: string, folder: string, name: string): void {
  assertName(name)
  const heldDir = heldStoreFor(dataDir, folder)
  const src = join(heldDir, name)
  if (!existsSync(src)) throw new Error(`"${name}" is not held for this folder — nothing to turn on`)
  if (!containedIn(heldDir, src)) throw new Error(`the held copy of "${name}" resolves outside the held store — refusing to move it`)
  const root = skillsRootOf(folder)
  const dest = join(realSkillsRoot(folder, false) ?? root, name)
  if (existsSync(dest)) {
    throw new Error(`a copy of "${name}" reappeared in ${root} while this one was off — two copies would conflict; remove one first`)
  }
  moveDir(src, join(realSkillsRoot(folder, true)!, name))
}

/** Add a PLUGIN skill to the folder — a real copy of
 *  <pluginSkillsDir>/<base>/, the same materialization skill-install.ts
 *  does. Only Silos' plugin skills are addable (the catalog's 'available'
 *  is exactly this set — complete-service.ts). A plugin-qualified name
 *  ("silos:team-plan") lands under its base name, exactly how Claude Code
 *  reads a folder copy. */
export function addSkill(pluginSkillsDir: string, dataDir: string, folder: string, name: string): string {
  assertName(name)
  const base = skillBaseName(name)
  assertName(base)
  const src = join(pluginSkillsDir, base)
  if (!existsSync(join(src, 'SKILL.md'))) throw new Error(`"${name}" is not one of Silos' plugin skills — only plugin skills can be copied into a folder`)
  if (!containedIn(pluginSkillsDir, src)) throw new Error(`"${name}" resolves outside the plugin skills — refusing to copy it`)
  const root = skillsRootOf(folder)
  if (existsSync(join(realSkillsRoot(folder, false) ?? root, base))) throw new Error(`"${base}" is already in ${root}`)
  if (existsSync(join(heldStoreFor(dataDir, folder), base))) {
    throw new Error(`a held copy of "${base}" exists for this folder — turn it on instead of adding another`)
  }
  const dest = join(realSkillsRoot(folder, true)!, base)
  try {
    cpSync(src, dest, { recursive: true })
  } catch (err) {
    rmSync(dest, { recursive: true, force: true })
    throw err
  }
  return base
}

/** The held skills of a folder — name + description read tolerantly from
 *  the held SKILL.md's frontmatter (a copy without one still lists). */
export function heldSkills(dataDir: string, folder: string): HeldSkill[] {
  const dir = heldStoreFor(dataDir, folder)
  let names: string[]
  try {
    names = readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort()
  } catch {
    return []
  }
  const out: HeldSkill[] = []
  for (const name of names) {
    let description: string | undefined
    try {
      description = parseSkillMd(readFileSync(join(dir, name, 'SKILL.md'), 'utf8').slice(0, 8000)).description
    } catch {
      /* unreadable or missing SKILL.md: listed by name alone */
    }
    out.push({ name, ...(description !== undefined ? { description } : {}) })
  }
  return out
}

/** The held skill NAMES of a folder (no frontmatter reads). */
export function heldSkillNames(dataDir: string, folder: string): string[] {
  try {
    return readdirSync(heldStoreFor(dataDir, folder), { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort()
  } catch {
    return []
  }
}

/** The ACTIVE skills of a folder — what the engine will really load from
 *  <folder>/.claude/skills (a directory without SKILL.md is not a skill).
 *  This is what the chat turn's emphasis line derives from now, instead of
 *  the retired agent.skills declaration. */
// Silos' own skills (the plugin's): the ones every agent needs to work with
// the platform — the first a conversation's skill list names, before any
// cut (an alphabetical cut of 8 would drop skills like
// responsibility and team-plan).
const PLUGIN_SKILLS_DIR = join(import.meta.dirname, '..', '..', 'plugin', 'skills')

/** The skills shipped by Silos' plugin — read from plugin/skills (a dir
 *  carrying a SKILL.md); unreadable → none, never a guessed list. */
export function silosSkillNames(pluginSkillsDir: string = PLUGIN_SKILLS_DIR): string[] {
  try {
    return readdirSync(pluginSkillsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && existsSync(join(pluginSkillsDir, d.name, 'SKILL.md')))
      .map((d) => d.name)
      .sort()
  } catch {
    return []
  }
}

/** The names a new conversation's skill line lists: the folder's ACTIVE
 *  skills, Silos' own first, then the rest alphabetically, capped at `max`.
 *  `loads`: the skills the launch really loads (its engine's answer, every
 *  settings tier counted) — a folder copy it does not keep is never named,
 *  and is cut before the cap. */
export function preludeSkillNames(folder: string, max = 8, pluginSkillsDir: string = PLUGIN_SKILLS_DIR, loads?: readonly string[]): string[] {
  const kept = loads ? new Set(loads) : null
  const active = activeSkillNames(folder).filter((n) => kept === null || kept.has(n))
  const ours = new Set(silosSkillNames(pluginSkillsDir))
  return [...active.filter((n) => ours.has(n)), ...active.filter((n) => !ours.has(n))].slice(0, max)
}

export function activeSkillNames(folder: string): string[] {
  const root = skillsRootOf(folder)
  let names: string[]
  try {
    // a skill entry that is a symlink to a directory loads too (Claude Code
    // documents it; a repo may link its own skill instead of copying it)
    names = readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory() || d.isSymbolicLink())
      .map((d) => d.name)
      .sort()
  } catch {
    return []
  }
  return names.filter((n) => existsSync(join(root, n, 'SKILL.md')))
}
