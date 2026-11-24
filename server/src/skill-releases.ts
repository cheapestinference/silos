// skill-releases.ts — plugin/skills/releases.json, read: for every skill
// Silos ships, the hash of every version of that skill it ever shipped
// (`"team-plan": ["<sha256>", …]`). Written by scripts/skill-releases.mjs.
// No imports beyond node: the catalog (complete-service.ts) reads it too.
//
// What a hash covers is the whole skill DIRECTORY — what skill-install.ts
// replaces when it brings a copy current — never SKILL.md alone: a skill
// that ships a script or a reference file next to its SKILL.md must not
// have an operator's edit to that file overwritten, nor an old copy of it
// kept, because only SKILL.md was compared (skillTreeHash).
import { createHash } from 'node:crypto'
import { lstatSync, readdirSync, readFileSync, readlinkSync } from 'node:fs'
import { join } from 'node:path'

/** name → every skill hash Silos shipped. */
export type Releases = Map<string, Set<string>>

/** Missing/unreadable manifest = nothing is recognised, so nothing is ever
 *  overwritten. */
export function readReleases(pluginSkillsDir: string): Releases {
  const out: Releases = new Map()
  let raw: Record<string, unknown>
  try {
    raw = JSON.parse(readFileSync(join(pluginSkillsDir, 'releases.json'), 'utf8')) as Record<string, unknown>
  } catch {
    return out
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out
  for (const [name, entry] of Object.entries(raw)) {
    if (Array.isArray(entry)) out.set(name, new Set(entry.filter((h): h is string => typeof h === 'string')))
  }
  return out
}

const sha256 = (data: Buffer | string): string => createHash('sha256').update(data).digest('hex')

/** One entry of a skill directory: its path relative to the skill's root
 *  ('/'-separated) and the sha256 of its bytes (a symlink: of `symlink:` +
 *  its target, so a link never reads as the file it points at). */
export interface TreeEntry {
  path: string
  hash: string
}

/**
 * THE definition of a skill's hash (scripts/skill-releases.mjs computes the
 * same from git objects; server/test/skill-releases.test.ts holds them
 * equal). A skill that is only its SKILL.md hashes to the sha256 of that
 * file — exactly the value every release and every written record held
 * before the hash covered the directory, so no existing install changes
 * state with the switch. Any other tree hashes its sorted `path\0hash\n`
 * lines: a file added, removed, renamed or edited anywhere in it changes it.
 */
export function treeHashOf(entries: readonly TreeEntry[]): string {
  if (entries.length === 1 && entries[0]!.path === 'SKILL.md') return entries[0]!.hash
  return sha256(
    [...entries]
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
      .map((e) => `${e.path}\0${e.hash}\n`)
      .join(''),
  )
}

/** The hash of the skill directory `dir` (treeHashOf over every file and
 *  link under it, directories walked, nothing skipped); null when it has no
 *  SKILL.md or cannot be read. */
export function skillTreeHash(dir: string): string | null {
  const entries: TreeEntry[] = []
  const walk = (abs: string, rel: string): void => {
    for (const name of readdirSync(abs)) {
      const p = join(abs, name)
      const r = rel === '' ? name : `${rel}/${name}`
      const st = lstatSync(p)
      if (st.isDirectory()) walk(p, r)
      else if (st.isSymbolicLink()) entries.push({ path: r, hash: sha256(`symlink:${readlinkSync(p)}`) })
      else if (st.isFile()) entries.push({ path: r, hash: sha256(readFileSync(p)) })
    }
  }
  try {
    if (!lstatSync(join(dir, 'SKILL.md')).isFile()) return null
    walk(dir, '')
  } catch {
    return null
  }
  return treeHashOf(entries)
}
