// project-folder.ts — the ONE check every door that gives an agent a folder
// goes through (docs/product.md «Where projects live»): Welcome and New
// agent (birth-project.ts), the agent's Profile (PATCH folder/folders[]), a
// role pack's install, an archived agent brought back. AgentRegistry.create
// and update call it, so no door writes agents.json around it.
//
// It judges the folder's REAL path (symlinks resolved; a folder not made
// yet is its nearest existing ancestor's real path plus the rest), and
// refuses:
//   - `/`, the home folder and the Projects folder itself (or a folder that
//     holds one of them);
//   - every place the fence keeps open for every agent (territory.ts
//     silosMustReach / machineMustReach: Silos' data dir, the engine's config
//     dir, the temp dir) — never the place itself nor a folder holding it;
//     and when the place is Silos' or an engine's OWN (MustReach.own,
//     Harness.ownDirs), nothing inside it either. Silos' CODE is the one
//     keep-open place that is not refused: a git checkout of Silos is a code
//     folder like any other project (contributors develop Silos with Silos);
//     only an installed package (under node_modules, no .git) is Silos' own;
//   - a folder that holds another registered project, or sits inside one: an
//     agent works in its project's folder, never a subfolder of it (working
//     in two projects is folders[] with each project's folder).
// The very folder of a registered project is fine: that is joining it.
// What a project is comes from Silos' record (the agents' folders), never
// from what is on disk.
import { existsSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { registeredHarnesses } from './harnesses/registry.js'
import { machineMustReach, SILOS_CHECKOUT, silosMustReach, stripTrailingSlash, type MustReach } from './territory.js'

/** Silos' code as an installed package (npm's node_modules, no git) —
 *  Silos' own, unlike a git checkout, which is a project like any other. */
export function isPackageInstall(dir: string): boolean {
  return /(^|\/)node_modules\//.test(`${stripTrailingSlash(dir)}/`) && !existsSync(join(dir, '.git'))
}

/** The Projects folder — where the next NEW project is born
 *  (`<Projects folder>/<project>`): the install's `projectsDir`
 *  (platform-settings.ts, Settings › Territory) when one is chosen, else
 *  `<home>/Silos`. The ONE source: births, the folder check and the fence
 *  read it here, per use (a change needs no restart). It only says where
 *  the next project is born — changing it moves nothing; every existing
 *  project stays where its agents' records say. */
export function projectsFolderOf(home: string, settings?: { projectsDir(): string | null } | null): string {
  return settings?.projectsDir() ?? join(stripTrailingSlash(home), 'Silos')
}

/** The folder's real path. A path not on disk yet resolves through its
 *  nearest existing ancestor (a new project under a symlinked Projects
 *  folder is judged, and stored, where it will really be). Never throws. */
export function realFolder(p: string): string {
  const abs = resolve(p)
  const rest: string[] = []
  let cur = abs
  for (;;) {
    try {
      const real = realpathSync(cur)
      return rest.length === 0 ? real : join(real, ...rest.reverse())
    } catch {
      /* not there (or unreadable): one level up */
    }
    const parent = dirname(cur)
    if (parent === cur) return abs
    rest.push(basename(cur))
    cur = parent
  }
}

/** The Projects folder the check and the fence use: the configured one,
 *  else `<home>/Silos`. */
export const projectsFolderIn = (places: FolderPlaces): string => stripTrailingSlash(places.projectsFolder ?? projectsFolderOf(places.home))

/** The places a check is made against: the machine's home (the server's,
 *  cfg.home), Silos' data dir, and the Projects folder (default
 *  `<home>/Silos`; the server passes a getter over projectsFolderOf, so a
 *  changed setting is judged at once). */
export interface FolderPlaces {
  home: string
  dataDir: string
  readonly projectsFolder?: string
}

export type FolderVerdict =
  | { ok: true; path: string }
  /** `conflict`: refused because of another project (409), not because the
   *  folder can never be one (400) */
  | { ok: false; reason: string; conflict: boolean }

/** Every place no project may be, hold, or (when `own`) sit inside. The
 *  Projects folder among them — but not when judging a Projects folder
 *  (`withProjectsFolder: false`, checkProjectsDir). */
export function refusedPlaces(places: FolderPlaces, o: { withProjectsFolder?: boolean } = {}): MustReach[] {
  const home = stripTrailingSlash(places.home)
  const engines: MustReach[] = registeredHarnesses().flatMap((h) =>
    (h.ownDirs?.(home) ?? []).map((path) => ({ path, what: `${h.label}'s own folder`, own: true })),
  )
  return [
    { path: home, what: 'your home folder' },
    ...(o.withProjectsFolder === false
      ? []
      : [{ path: places.projectsFolder ?? projectsFolderOf(home), what: 'the Projects folder (each project is a folder inside it)' }]),
    ...silosMustReach(home, places.dataDir),
    // Silos' code: refused only as an installed package (see above)
    ...machineMustReach().filter((p) => p.path !== SILOS_CHECKOUT || isPackageInstall(SILOS_CHECKOUT)),
    ...engines,
  ]
}

const at = (outer: string, p: string): boolean => p === outer || p.startsWith(outer === '/' ? '/' : `${outer}/`)

/** The check. `projects`: the folders of the registered projects the folder
 *  must not hold nor sit inside (the asking agent's own other folders
 *  included); one of them exactly is fine — joining that project. */
export function checkProjectFolder(
  folder: string,
  places: FolderPlaces,
  projects: readonly string[],
  real_: (p: string) => string = realFolder,
): FolderVerdict {
  if (typeof folder !== 'string' || !folder.startsWith('/')) return { ok: false, reason: 'the folder must be an absolute path', conflict: false }
  const asked = stripTrailingSlash(folder)
  const real = real_(asked)
  const shown = real === asked ? asked : `${asked} (really ${real})`
  const never = (why: string): FolderVerdict => ({ ok: false, reason: `${shown} ${why} — a project needs a folder of its own`, conflict: false })
  const placed = refusedAt(real, refusedPlaces(places), real_)
  if (placed !== null) return never(placed)
  const known = [...new Set(projects.filter((f) => typeof f === 'string' && f.startsWith('/')).map((f) => real_(f)))]
  if (known.includes(real)) return { ok: true, path: real }
  const held = known.find((p) => at(real, p))
  if (held !== undefined) return { ok: false, reason: `${shown} holds the project at ${held} — a project never holds another one`, conflict: true }
  const holder = known.find((p) => at(p, real))
  if (holder !== undefined)
    return {
      ok: false,
      reason: `${shown} is inside the project at ${holder} — an agent works in its project's folder: give it ${holder} itself`,
      conflict: true,
    }
  return { ok: true, path: real }
}

/** Why `real` may never be a project (nor the Projects folder): the
 *  machine's root, or being / holding / (for an own place) sitting inside
 *  one of `refused`. Null: none of them. */
function refusedAt(real: string, refused: readonly MustReach[], real_: (p: string) => string): string | null {
  if (real === '/') return "is the whole machine's root"
  for (const place of refused) {
    const p = real_(place.path)
    if (real === p) return `is ${place.what}`
    if (at(real, p)) return `holds ${place.what}`
    if (place.own === true && at(p, real)) return `is inside ${place.what}`
  }
  return null
}

const isDirectory = (p: string): boolean => {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

/** The check for a new Projects folder (PATCH /api/settings `projectsDir`):
 *  the same refused places as a project's folder — never `/`, the home
 *  folder, Silos' or an engine's own folders — but it MAY hold projects
 *  (that is what it is for). It may not be a registered project nor sit
 *  inside one (a new project would be born inside another), and it must be
 *  a folder already on this machine: a chosen place is never made, so a
 *  disk that is not mounted is said, never papered over. `projects`: every
 *  registered project's folder. The verdict's path is the real one — what
 *  is stored. */
export function checkProjectsDir(
  folder: string,
  places: FolderPlaces,
  projects: readonly string[],
  real_: (p: string) => string = realFolder,
  isDir: (p: string) => boolean = isDirectory,
): FolderVerdict {
  if (typeof folder !== 'string' || !folder.trim().startsWith('/'))
    return { ok: false, reason: 'the Projects folder must be an absolute path', conflict: false }
  const asked = stripTrailingSlash(folder.trim())
  const real = real_(asked)
  const shown = real === asked ? asked : `${asked} (really ${real})`
  const placed = refusedAt(real, refusedPlaces(places, { withProjectsFolder: false }), real_)
  if (placed !== null) return { ok: false, reason: `${shown} ${placed} — new projects need a folder of their own to be born in`, conflict: false }
  const known = [...new Set(projects.filter((f) => typeof f === 'string' && f.startsWith('/')).map((f) => real_(f)))]
  if (known.includes(real))
    return { ok: false, reason: `${shown} is a project — new projects are never born inside one: pick the folder that holds it, or another`, conflict: true }
  const holder = known.find((p) => at(p, real))
  if (holder !== undefined)
    return { ok: false, reason: `${shown} is inside the project at ${holder} — a new project is never born inside another`, conflict: true }
  if (!isDir(real))
    return { ok: false, reason: `${shown} is not a folder on this machine — make it first (or mount its disk), then choose it`, conflict: false }
  return { ok: true, path: real }
}

/** One agent folder that breaks the rule today (the boot audit). */
export interface FolderOffence {
  agentId: string
  folder: string
  reason: string
}

/** Every in-play agent's folders, judged by the same check against every
 *  other registered project (its own other folders included). Said, never
 *  fixed: the audit changes nothing. Archived agents are out of play. */
export function auditProjectFolders(
  agents: readonly { id: string; folder: string | null; folders?: string[]; archived?: boolean }[],
  places: FolderPlaces,
): FolderOffence[] {
  const live = agents.filter((a) => !a.archived && a.folder !== null)
  const lands = (a: (typeof live)[number]): string[] => [
    ...new Set([a.folder, ...(a.folders ?? [])].filter((f): f is string => typeof f === 'string' && f.startsWith('/')).map(stripTrailingSlash)),
  ]
  // one disk reading per path for the whole pass
  const seen = new Map<string, string>()
  const real = (p: string): string => {
    let r = seen.get(p)
    if (r === undefined) {
      r = realFolder(p)
      seen.set(p, r)
    }
    return r
  }
  const out: FolderOffence[] = []
  for (const a of live) {
    const mine = lands(a)
    for (const f of mine) {
      const others = [...live.filter((b) => b.id !== a.id).flatMap(lands), ...mine.filter((m) => m !== f)]
      const v = checkProjectFolder(f, places, others, real)
      if (!v.ok) out.push({ agentId: a.id, folder: f, reason: v.reason })
    }
  }
  return out
}

/** How many files one pattern may report (a `**` folder can hold many). */
const MATCHES_PER_PATTERN = 20

/** The files on disk an engine's pattern names (Harness.loadedFromAbove):
 *  a literal path, a `*` inside one segment, a trailing `**` (every file
 *  below). Nothing else is a pattern there. Never throws; at most
 *  MATCHES_PER_PATTERN files. */
export function filesMatching(pattern: string): string[] {
  const segs = pattern.split('/').filter((s) => s !== '')
  const isFile = (p: string): boolean => {
    try {
      return statSync(p).isFile()
    } catch {
      return false
    }
  }
  const isDir = (p: string): boolean => {
    try {
      return statSync(p).isDirectory()
    } catch {
      return false
    }
  }
  const list = (p: string): string[] => {
    try {
      return readdirSync(p).sort()
    } catch {
      return []
    }
  }
  const out: string[] = []
  const below = (dir: string, depth: number): void => {
    if (depth > 8) return
    for (const n of list(dir)) {
      if (out.length >= MATCHES_PER_PATTERN) return
      const p = join(dir, n)
      if (isFile(p)) out.push(p)
      else if (isDir(p)) below(p, depth + 1)
    }
  }
  const walk = (base: string, i: number): void => {
    if (out.length >= MATCHES_PER_PATTERN) return
    const seg = segs[i]!
    const last = i === segs.length - 1
    if (seg === '**' && last) {
      if (isDir(base)) below(base, 0)
      return
    }
    const names = seg.includes('*')
      ? list(base).filter((n) =>
          new RegExp(
            `^${seg
              .split('*')
              .map((x) => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
              .join('[^/]*')}$`,
          ).test(n),
        )
      : [seg]
    for (const n of names) {
      const p = join(base, n)
      if (last) {
        if (isFile(p) && out.length < MATCHES_PER_PATTERN) out.push(p)
      } else if (isDir(p)) walk(p, i + 1)
    }
  }
  if (pattern.startsWith('/') && segs.length > 0) walk('/', 0)
  return out
}

/** The files found right in the Projects folder that a registered engine
 *  could load into every project inside it (Harness.loadedFromAbove) —
 *  nothing but projects belongs there, and the folder reaches every project
 *  born after. Said, never fixed: the owner decides (a Needs you row). */
export function loadablesInProjectsFolder(places: FolderPlaces): string[] {
  const dir = projectsFolderIn(places)
  const home = stripTrailingSlash(places.home)
  const out = new Set<string>()
  for (const h of registeredHarnesses()) {
    for (const p of h.loadedFromAbove?.(dir, home) ?? []) for (const f of filesMatching(p)) out.add(f)
  }
  return [...out].sort()
}
