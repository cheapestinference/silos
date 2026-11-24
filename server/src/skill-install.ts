// Consent-first: installing only ever runs because the owner clicked install.
// After that, a copy is Silos' to keep current ONLY while nobody has edited
// it: plugin/skills/releases.json lists the hash of every version of each
// skill Silos ever shipped — the whole skill directory, which is what a
// sync replaces (skill-releases.ts skillTreeHash) — so a copy whose tree is
// one of them is an untouched older release and is replaced with the
// current one; any other tree is the operator's and is never overwritten
// (reported as `edited`). A skill that is only a SKILL.md hashes as that
// file did before the hash covered the directory: no install changed state
// with the switch.
//
// Why this exists (28-10): copies were made once and never refreshed, so the
// agents of one project ran a team-plan skill two months old — every
// later rule about keeping plans honest never reached them.
import { cpSync, existsSync, lstatSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { containedDir } from './contained-dir.js'
import { join } from 'node:path'
import { heldDirFor } from './skill-states.js'
import { readReleases, skillTreeHash } from './skill-releases.js'

export { readReleases } from './skill-releases.js'

/** current: same text Silos ships now · updated: was an untouched older
 *  release, now current · edited: someone changed it, left alone */
export type SkillCopyState = 'current' | 'updated' | 'edited'

export interface SkillCopy {
  name: string
  state: SkillCopyState
  where?: 'held'
}

function isLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink()
  } catch {
    return false
  }
}

function replaceCopy(src: string, dest: string): void {
  rmSync(dest, { recursive: true, force: true })
  cpSync(src, dest, { recursive: true })
}

/** Brings every Silos skill already present in `<agentFolder>/.claude/skills`
 *  up to the current text when it is an untouched older release. Skills
 *  that are not there are not installed (that stays the owner's click).
 *  With `dataDir`, the folder's HELD copies (turned off, skill-states.ts)
 *  follow too — reported with `where: 'held'` — so turning one back on
 *  never brings an old text back to life. */
export function syncSkillCopies(pluginSkillsDir: string, agentFolder: string, dataDir?: string): SkillCopy[] {
  const releases = readReleases(pluginSkillsDir)
  let names: string[]
  try {
    names = readdirSync(pluginSkillsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort()
  } catch {
    return []
  }
  // the folder's REAL .claude/skills (contained-dir.ts): a link leading
  // outside the folder is never written through — nothing is synced there
  let root: string | null
  try {
    root = containedDir(agentFolder, ['.claude', 'skills'], { create: false })
  } catch {
    root = null
  }
  // what Silos itself last wrote in each copy (<dataDir>/skill-copies-written.json,
  // keyed by the copy's SKILL.md path, valued by its tree hash): a version it
  // synced while a skill was being edited is in no release, yet it is still
  // Silos' own — never the operator's
  const written = dataDir !== undefined ? readWritten(dataDir) : null
  const out = root !== null ? syncCopiesIn(pluginSkillsDir, root, names, releases, written) : []
  // the held store is Silos' own (<dataDir>/skills-held/<folderKey>)
  if (dataDir !== undefined) {
    const held = heldDirFor(dataDir, agentFolder)
    if (existsSync(held)) for (const c of syncCopiesIn(pluginSkillsDir, held, names, releases, written)) out.push({ ...c, where: 'held' })
  }
  if (dataDir !== undefined && written?.changed) saveWritten(dataDir, written)
  return out
}

interface Written {
  map: Record<string, string>
  changed: boolean
}
const WRITTEN_FILE = 'skill-copies-written.json'
function readWritten(dataDir: string): Written {
  try {
    const raw = JSON.parse(readFileSync(join(dataDir, WRITTEN_FILE), 'utf8')) as unknown
    if (raw && typeof raw === 'object' && !Array.isArray(raw))
      return {
        map: Object.fromEntries(Object.entries(raw as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === 'string')),
        changed: false,
      }
  } catch {
    /* none yet */
  }
  return { map: {}, changed: false }
}
function saveWritten(dataDir: string, w: Written): void {
  try {
    const file = join(dataDir, WRITTEN_FILE)
    const tmp = `${file}.tmp-${process.pid}`
    writeFileSync(tmp, JSON.stringify(w.map, null, 2) + '\n')
    renameSync(tmp, file)
  } catch {
    /* the next pass writes it */
  }
}

function syncCopiesIn(
  pluginSkillsDir: string,
  root: string,
  names: readonly string[],
  releases: ReturnType<typeof readReleases>,
  written: Written | null = null,
): SkillCopy[] {
  const out: SkillCopy[] = []
  for (const name of names) {
    const shipped = releases.get(name) ?? new Set<string>()
    const src = join(pluginSkillsDir, name)
    const dest = join(root, name)
    const have = skillTreeHash(dest)
    const now = skillTreeHash(src)
    if (have === null || now === null) continue // not installed here, or not shipped in this build
    const file = join(dest, 'SKILL.md')
    if (have === now) {
      out.push({ name, state: 'current' })
      if (written && written.map[file] !== now) {
        written.map[file] = now
        written.changed = true
      }
    } else if (isLink(dest)) {
      // a skill the operator LINKED (a repo linking the skill it ships, a
      // worktree at another commit) is not a copy Silos made: replacing it
      // would turn the link into a directory. It follows whatever it points
      // at, never Silos — reported like any copy Silos leaves alone.
      out.push({ name, state: 'edited' })
    } else if (shipped.has(have) || written?.map[file] === have) {
      try {
        replaceCopy(src, dest)
        if (written) {
          written.map[file] = now
          written.changed = true
        }
        out.push({ name, state: 'updated' })
      } catch {
        out.push({ name, state: 'edited' }) // unwritable: keep reporting what is there
      }
    } else out.push({ name, state: 'edited' })
  }
  return out
}

/** A copy Silos may NOT write (an account's personal `<config dir>/skills/
 *  <name>` — Claude Code's own, sacred) whose text is an older Silos
 *  release: it is only NAMED for the owner. */
export interface StaleCopy {
  name: string
  dir: string
}

/** The Silos skills under each of `roots` (personal skill dirs) whose text
 *  is a release Silos shipped but not the current one. Read-only: nothing
 *  is ever written there. A text Silos never shipped is the operator's own
 *  skill and is not judged. Roots that resolve to the same dir (an account
 *  following ~/.claude) are read once. */
export function staleSkillCopies(pluginSkillsDir: string, roots: readonly string[]): StaleCopy[] {
  const releases = readReleases(pluginSkillsDir)
  const out: StaleCopy[] = []
  const seen = new Set<string>()
  const names = [...releases.keys()].sort()
  for (const r of roots) {
    let real: string
    try {
      real = realpathSync(r)
    } catch {
      continue
    }
    if (seen.has(real)) continue
    seen.add(real)
    for (const name of names) {
      const h = skillTreeHash(join(r, name))
      const now = skillTreeHash(join(pluginSkillsDir, name))
      if (h === null || now === null) continue
      if (h !== now && releases.get(name)!.has(h)) out.push({ name, dir: join(r, name) })
    }
  }
  return out
}

/** What a release of plugin/skills looks like from outside, cheaply: the
 *  size + mtime of releases.json and of every file in every skill directory
 *  (the hash covers all of them). A merge (or an edit) that changes any of
 *  them changes it; computing it opens no file. */
export function skillReleaseStamp(pluginSkillsDir: string): string {
  const stamp = (p: string): string => {
    try {
      const st = statSync(p)
      return `${st.size}:${st.mtimeMs}`
    } catch {
      return '-'
    }
  }
  const filesUnder = (dir: string, rel = ''): string[] => {
    const out: string[] = []
    try {
      for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
        const r = rel === '' ? e.name : `${rel}/${e.name}`
        if (e.isDirectory()) out.push(...filesUnder(join(dir, e.name), r))
        else out.push(r)
      }
    } catch {
      /* gone meanwhile */
    }
    return out
  }
  const parts = [`releases.json=${stamp(join(pluginSkillsDir, 'releases.json'))}`]
  try {
    for (const d of readdirSync(pluginSkillsDir, { withFileTypes: true })
      .filter((x) => x.isDirectory())
      .map((x) => x.name)
      .sort()) {
      for (const f of filesUnder(join(pluginSkillsDir, d))) parts.push(`${d}/${f}=${stamp(join(pluginSkillsDir, d, f))}`)
    }
  } catch {
    /* no plugin skills */
  }
  return parts.join('|')
}

export interface SkillFollowerOpts {
  pluginSkillsDir: string
  dataDir: string
  /** the agents' folders now (read on every tick: a new agent's folder joins) */
  folders: () => readonly string[]
  /** the personal skill dirs Silos only reads (each account's `<config>/skills`) */
  personalRoots?: () => readonly string[]
  log?: (line: string) => void
}

/** Silos skill copies follow the plugin — at boot AND when a release lands
 *  without a restart (a merge: `tsx watch` does not always reload). `tick()`
 *  is cheap (skillReleaseStamp + the folder list) and runs the whole pass
 *  only when either changed: sync every
 *  folder's copies (held ones too), name the edited ones, and name the
 *  stale personal copies Silos may not write. A line that only names
 *  (edited, stale) is logged once, not on every pass. */
export class SkillCopyFollower {
  private last: string | null = null
  private said = new Set<string>()
  constructor(private o: SkillFollowerOpts) {}

  /** true when it ran a pass. */
  tick(): boolean {
    const folders = [...new Set(this.o.folders().filter((f) => typeof f === 'string' && f !== ''))].sort()
    const key = `${skillReleaseStamp(this.o.pluginSkillsDir)}#${folders.join('|')}`
    if (key === this.last) return false
    this.last = key
    this.pass(folders)
    return true
  }

  private pass(folders: readonly string[]): void {
    const log = this.o.log ?? console.log
    const once = (line: string): void => {
      if (this.said.has(line)) return
      this.said.add(line)
      log(line)
    }
    const label = (c: SkillCopy): string => `${c.name}${c.where === 'held' ? ' (held)' : ''}`
    for (const folder of folders) {
      try {
        const copies = syncSkillCopies(this.o.pluginSkillsDir, folder, this.o.dataDir)
        const updated = copies.filter((c) => c.state === 'updated').map(label)
        const edited = copies.filter((c) => c.state === 'edited').map(label)
        if (updated.length > 0) log(`skills updated in ${folder}: ${updated.join(', ')}`)
        if (edited.length > 0) once(`skills edited in ${folder}, left as they are: ${edited.join(', ')}`)
      } catch (err) {
        log(`skills: could not follow the plugin in ${folder}: ${(err as Error).message}`)
      }
    }
    for (const s of staleSkillCopies(this.o.pluginSkillsDir, this.o.personalRoots?.() ?? [])) {
      once(
        `skills: ${s.dir} is an older Silos release of ${s.name}, left as it is (Silos never writes personal skills) — it is what that account's sessions load as ${s.name}: delete it, or copy plugin/skills/${s.name} over it`,
      )
    }
  }
}
