// silos/files-source.ts — WHERE a `files` source reads, and nothing else
// (Silo Standard v0: «Sources, freshness and writing»; conformance.md §3
// «Source confinement»).
//
// A source names a root CLASS and a glob inside it:
//   agent-state  the glob runs under <dataDir>/agent-state/<agent>/ of EVERY
//                agent that has a state folder (SupportStore.agentsWithCases
//                pattern). It must live under the reserved `silos/` namespace
//                — the only exceptions are the kernel's CLOSED legacy list
//                below, never a manifest field.
//   project      the glob runs under every project folder Silos knows (the
//                agents' territories); a worktree resolves to its main
//                checkout. A glob on the project root itself does not validate.
//
// Confinement (the FIFO lesson, generalized): the static folder resolves —
// realpath — strictly inside its location; no `..`; wildcards never descend
// into dot-entries or node_modules; a symlinked folder is never followed and
// a symlinked record file is never read (seventh review round: following it
// re-resolved a verified path); only regular files; size and count caps. What a cap stops is SAID
// (`truncated`), never silently dropped.
import { lstatSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { basename, dirname, join, sep } from 'node:path'
import { containedAgentDir, containedDir, ContainmentError } from '../contained-dir.js'
import type { AgentStateStore } from '../agent-state.js'
import type { AgentRegistry } from '../agent-registry.js'
import { territoriesOf } from '../territory.js'
import { mainCheckoutOf } from '../execution-plan-join.js'

// Conventions that predate the `silos/` namespace and stay where they are
// (support's cases). Closed: a new silo writes under silos/<id>/.
export const LEGACY_AGENT_STATE_CONVENTIONS: readonly string[] = ['support/cases']

export const RECORD_MAX_BYTES = 1024 * 1024
export const MAX_FILES_PER_SOURCE = 5000 // over every location of one source
export const MAX_DIR_ENTRIES = 20000 // directory entries looked at, per source
export const MAX_GLOB_DEPTH = 8 // levels a ** may descend

export interface Location {
  key: string // 'agent:<id>' | 'folder:<abs path>' — stable, journal-safe
  agentId?: string
  folder?: string
  dir: string // the absolute base the glob is relative to
}

export interface SiloLocations {
  agentStates(): Array<{ agentId: string; dir: string }>
  projects(): string[]
}

// The house's own enumeration: agent-state folders that exist on disk, and
// the territories of every non-archived agent (main checkouts).
export function houseLocations(agentState: Pick<AgentStateStore, 'agentIdsOnDisk' | 'pathFor'>, registry: Pick<AgentRegistry, 'list'>): SiloLocations {
  return {
    agentStates: () => agentState.agentIdsOnDisk().map((agentId) => ({ agentId, dir: agentState.pathFor(agentId) })),
    projects: () =>
      [
        ...new Set(
          registry
            .list()
            .flatMap((a) => territoriesOf(a))
            .map((f) => mainCheckoutOf(f)),
        ),
      ].sort(),
  }
}

export interface SourceSpec {
  id: string
  root: 'agent-state' | 'project'
  glob: string
  parser: 'json' | 'md-frontmatter'
}

export interface MatchedFile {
  location: Location
  path: string // absolute, as reached (inside the location)
  rel: string // relative to the location's base, '/'-separated
  stem: string // what the file pattern's wildcard matched — the id from the file name
  size: number
  mtimeMs: number
}

export interface UnreadableFile {
  location: Location
  path: string
  rel: string
  reason: string
  stem?: string
}

export interface SourceScan {
  files: MatchedFile[]
  unreadable: UnreadableFile[] // matched by name but refused (not regular, too large, escapes)
  truncated: string | null // a cap stopped the walk — in plain words
}

const WILD = /[*?]/

// Static checks of a source's glob, before any disk is touched. null = fine.
export function confineGlob(source: { id: string; root: string; glob: string }): string | null {
  const { id, root, glob } = source
  if (glob.startsWith('/') || glob.includes('\\') || /^[A-Za-z]:/.test(glob))
    return `source ${id}: the glob ${JSON.stringify(glob)} must be relative to its ${root} root`
  const segs = glob.split('/').filter((s) => s !== '' && s !== '.')
  if (segs.includes('..')) return `source ${id}: the glob ${JSON.stringify(glob)} climbs out of its ${root} root with ".."`
  if (/[[\]{}!]/.test(glob)) return `source ${id}: the glob ${JSON.stringify(glob)} uses a pattern this reader does not know — only *, ? and ** are read`
  const file = segs[segs.length - 1] ?? ''
  if (file === '**' || file === '') return `source ${id}: the glob ${JSON.stringify(glob)} must end in a file pattern (e.g. *.json)`
  const prefix = staticPrefix(segs)
  if (prefix.length === 0)
    return `source ${id}: the glob ${JSON.stringify(glob)} names no folder of its own under ${root} — a source's records live in a named folder`
  if (root === 'agent-state') {
    const p = prefix.join('/')
    const legacy = LEGACY_AGENT_STATE_CONVENTIONS.some((l) => p === l || p.startsWith(l + '/'))
    if (!legacy && (prefix[0] !== 'silos' || prefix.length < 2))
      return `source ${id}: under agent-state a silo's records live in silos/<silo>/ — ${JSON.stringify(glob)} is outside it`
  }
  return null
}

function staticPrefix(segs: string[]): string[] {
  const out: string[] = []
  for (const s of segs.slice(0, -1)) {
    if (WILD.test(s)) break
    out.push(s)
  }
  return out
}

export function segmentRe(seg: string): RegExp {
  const body = seg
    .replace(/[.+^${}()|\\]/g, '\\$&')
    .replace(/\*/g, '([^/]*)')
    .replace(/\?/g, '[^/]')
  return new RegExp(`^${body}$`)
}

// The part of a file name its pattern's wildcard matched: `*.plan.json` on
// `month-end.plan.json` → `month-end`. A pattern without exactly one `*` keeps the
// name minus its last extension.
export function stemOf(filePattern: string, name: string): string {
  const stars = filePattern.split('*').length - 1
  if (stars === 1 && !filePattern.includes('?')) {
    const m = segmentRe(filePattern).exec(name)
    if (m) return m[1]!
  }
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(0, dot) : name
}

const isInside = (parent: string, p: string): boolean => p === parent || p.startsWith(parent + sep)

export function locationsFor(root: 'agent-state' | 'project', locs: SiloLocations): Location[] {
  if (root === 'agent-state') return locs.agentStates().map((a) => ({ key: `agent:${a.agentId}`, agentId: a.agentId, dir: a.dir }))
  return locs.projects().map((f) => ({ key: `folder:${f}`, folder: f, dir: f }))
}

// The folders a source's records live under, one per location: the location
// plus the glob's static prefix (agent-state:support/cases → <state>/<agent>/
// support/cases). What the kernel's file watch covers (kernel.ts
// watchedFolders): a write under one of them is a write to that source.
// Folders that don't exist yet are listed too — a watcher anchors at the
// nearest existing ancestor.
export function conventionFolders(source: { root: string; glob: string }, locs: SiloLocations): string[] {
  if (source.root !== 'agent-state' && source.root !== 'project') return []
  const prefix = staticPrefix(source.glob.split('/').filter((s) => s !== '' && s !== '.'))
  if (prefix.length === 0 || prefix.includes('..')) return []
  return locationsFor(source.root, locs).map((l) => join(l.dir, ...prefix))
}

// Where a record file lives, as a VERIFIED real dir + one name, for
// safe-file.ts (sixth review round — the scan checks, the read/write that
// follows must not trust the path it checked). `file` is the record's
// absolute path as reached, `rel` its path relative to the location's base,
// `locationKey` 'agent:<id>' | 'folder:<abs>'. An agent location roots at
// the AGENT's dir, which is never a link (containedAgentDir); a folder at the
// folder. The name is the record's OWN name, never a link's target: a record
// file that is a link is not read at all (seventh review round — following
// one meant a realpath of the LEXICAL path after the dir was verified, and a
// swap in between filed another agent's record as this agent's). Writes and
// the CAS version never followed links; reads now don't either — one rule,
// and the scan refuses a linked record up front (RECORD_LINK_REFUSED).
// Throws ContainmentError; null when the folder is gone.
export function recordPlace(file: string, rel: string, locationKey: string): { dir: string; name: string } | null {
  const relSegs = rel.split('/')
  if (relSegs.length === 0 || relSegs.some((x) => x === '' || x === '.' || x === '..') || !file.endsWith(sep + relSegs.join(sep))) {
    throw new ContainmentError(`${file} is not where its record says it is`)
  }
  const root = file.slice(0, file.length - relSegs.join(sep).length - 1)
  const name = relSegs.pop()!
  const dir = locationKey.startsWith('agent:')
    ? containedAgentDir(dirname(root), basename(root), relSegs, { create: false })
    : containedDir(root, relSegs, { create: false })
  if (dir === null) return null
  return { dir, name }
}

export const RECORD_LINK_REFUSED = 'a link — a record is read only from a regular file, never through a link'

// Walk one source over all its locations.
export function scanSource(source: SourceSpec, locs: SiloLocations): SourceScan {
  const segs = source.glob.split('/').filter((s) => s !== '' && s !== '.')
  const prefix = staticPrefix(segs)
  const rest = segs.slice(prefix.length)
  const filePattern = segs[segs.length - 1]!
  const out: SourceScan = { files: [], unreadable: [], truncated: null }
  let entries = 0
  const stop = (why: string): void => {
    if (out.truncated === null) out.truncated = why
  }

  for (const location of locationsFor(source.root, locs)) {
    if (out.truncated) break
    let baseReal: string
    let locReal: string
    try {
      locReal = realpathSync(location.dir)
      baseReal = realpathSync(join(location.dir, ...prefix))
    } catch {
      continue // the convention's folder does not exist here: nothing to read
    }
    // the static folder (or a symlink on its way) must stay inside the location
    if (!isInside(locReal, baseReal) || baseReal === locReal) {
      out.unreadable.push({
        location,
        path: join(location.dir, ...prefix),
        rel: prefix.join('/'),
        reason: `${prefix.join('/')} leads outside ${location.agentId ? `${location.agentId}'s agent state` : location.folder} — it is not read`,
      })
      continue
    }
    try {
      if (!statSync(baseReal).isDirectory()) continue
    } catch {
      continue
    }
    const base = join(location.dir, ...prefix)

    const visit = (dir: string, relParts: string[], patIdx: number, depth: number): void => {
      if (out.truncated) return
      const pat = rest[patIdx]
      if (pat === undefined) return
      let names: string[]
      try {
        names = readdirSync(dir).sort()
      } catch {
        return
      }
      entries += names.length
      if (entries > MAX_DIR_ENTRIES) {
        stop(`stopped after looking at ${MAX_DIR_ENTRIES} folder entries for source ${source.id}`)
        return
      }
      const isLast = patIdx === rest.length - 1
      if (pat === '**') {
        // ** = zero or more folders: try the next pattern here, then descend
        visit(dir, relParts, patIdx + 1, depth)
        if (depth >= MAX_GLOB_DEPTH) return
        for (const n of names) {
          if (n.startsWith('.') || n === 'node_modules') continue
          const p = join(dir, n)
          let st
          try {
            st = lstatSync(p)
          } catch {
            continue
          }
          if (st.isDirectory()) visit(p, [...relParts, n], patIdx, depth + 1) // never through a symlink
        }
        return
      }
      const re = segmentRe(pat)
      for (const n of names) {
        if (out.truncated) return
        if (WILD.test(pat) && n.startsWith('.')) continue // wildcards never match dot-entries
        if (n.endsWith('.tmp')) continue // an in-flight atomic write
        if (!re.test(n)) continue
        const p = join(dir, n)
        const rel = [...relParts, n].join('/')
        let st
        try {
          st = lstatSync(p)
        } catch {
          continue
        }
        if (!isLast) {
          if (st.isDirectory() && n !== 'node_modules') visit(p, [...relParts, n], patIdx + 1, depth + 1)
          continue
        }
        const relFull = [...prefix, rel].join('/')
        const refuse = (reason: string): void => {
          out.unreadable.push({ location, path: p, rel: relFull, reason, stem: stemOf(filePattern, n) })
        }
        if (st.isSymbolicLink()) {
          // said plainly: one leading outside is the worse news
          let real: string | null = null
          try {
            real = realpathSync(p)
          } catch {
            /* a link to nothing */
          }
          if (real === null) {
            refuse('a link to nothing')
            continue
          }
          if (!isInside(baseReal, real)) {
            refuse('a link that leads outside its folder — it is not read')
            continue
          }
          refuse(RECORD_LINK_REFUSED)
          continue
        }
        if (!st.isFile()) {
          refuse(st.isDirectory() ? 'a folder where a record file was expected' : 'not a regular file')
          continue
        }
        if (st.size > RECORD_MAX_BYTES) {
          refuse(`larger than ${RECORD_MAX_BYTES / 1024} KB — not read`)
          continue
        }
        if (out.files.length >= MAX_FILES_PER_SOURCE) {
          stop(`stopped at ${MAX_FILES_PER_SOURCE} files for source ${source.id}`)
          return
        }
        out.files.push({ location, path: p, rel: relFull, stem: stemOf(filePattern, n), size: st.size, mtimeMs: st.mtimeMs })
      }
    }
    visit(base, [], 0, 0)
  }
  return out
}
