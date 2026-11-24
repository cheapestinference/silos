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
import { existsSync, realpathSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { registeredHarnesses } from './harnesses/registry.js'
import { machineMustReach, SILOS_CHECKOUT, silosMustReach, stripTrailingSlash, type MustReach } from './territory.js'

/** Silos' code as an installed package (npm's node_modules, no git) —
 *  Silos' own, unlike a git checkout, which is a project like any other. */
export function isPackageInstall(dir: string): boolean {
  return /(^|\/)node_modules\//.test(`${stripTrailingSlash(dir)}/`) && !existsSync(join(dir, '.git'))
}

/** Where new projects are born: `<home>/Silos/<project>`. */
export const projectsFolderOf = (home: string): string => join(home, 'Silos')

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

/** The places a check is made against: the machine's home (the server's,
 *  cfg.home), Silos' data dir, and the Projects folder (default
 *  `<home>/Silos`). */
export interface FolderPlaces {
  home: string
  dataDir: string
  projectsFolder?: string
}

export type FolderVerdict =
  | { ok: true; path: string }
  /** `conflict`: refused because of another project (409), not because the
   *  folder can never be one (400) */
  | { ok: false; reason: string; conflict: boolean }

/** Every place no project may be, hold, or (when `own`) sit inside. */
export function refusedPlaces(places: FolderPlaces): MustReach[] {
  const home = stripTrailingSlash(places.home)
  const engines: MustReach[] = registeredHarnesses().flatMap((h) =>
    (h.ownDirs?.(home) ?? []).map((path) => ({ path, what: `${h.label}'s own folder`, own: true })),
  )
  return [
    { path: home, what: 'your home folder' },
    { path: places.projectsFolder ?? projectsFolderOf(home), what: 'the Projects folder (each project is a folder inside it)' },
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
  if (real === '/') return never("is the whole machine's root")
  for (const place of refusedPlaces(places)) {
    const p = real_(place.path)
    if (real === p) return never(`is ${place.what}`)
    if (at(real, p)) return never(`holds ${place.what}`)
    if (place.own === true && at(p, real)) return never(`is inside ${place.what}`)
  }
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
