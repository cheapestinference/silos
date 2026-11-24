// silos/bearer-scope.ts — the ONE bound on what a silo route reads or renders
// on behalf of a bearer: an agent's token never makes the
// server read another agent's state, drafts or another project's folders,
// and never returns their content — before or after the owner approved
// anything. The owner's credential keeps its full view.
//
// An agent reads: its own state (`agent:<self>`) and the project folders of
// its projects (`folder:<f>` with f the same project as one of its
// territories — project-scope.ts sameProject: f at, inside, or around one of
// its folders; a folder around it is common ground). Nothing else — not
// another agent's state, not another project's folder, not platform
// (kernel) data.
import type { SiloLocations } from './files-source.js'
import { sameProject } from '../project-scope.js'

export type TerritoriesOf = (agentId: string) => readonly string[]

const ofProjects = (folder: string, territories: readonly string[]): boolean => territories.some((t) => sameProject(folder, t))

// The locations a reader sees for this bearer: the owner every one; an agent
// its own state and the project folders of its projects.
export function bearerLocations(all: SiloLocations, by: string, territoriesOf: TerritoriesOf): SiloLocations {
  if (by === 'owner') return all
  return {
    agentStates: () => all.agentStates().filter((a) => a.agentId === by),
    projects: () => {
      const terr = territoriesOf(by)
      return all.projects().filter((f) => ofProjects(f, terr))
    },
  }
}

// One record location (`agent:<id>`, `folder:<path>`, …) against the bearer.
export function bearerMayReadLocation(by: string, location: string, territoriesOf: TerritoriesOf): boolean {
  if (by === 'owner') return true
  if (location === `agent:${by}`) return true
  if (!location.startsWith('folder:')) return false
  return ofProjects(location.slice('folder:'.length), territoriesOf(by))
}

// A segment no folder can be named (a NUL): `<P>/<it>` is of the bearer's
// projects exactly when P is AT or INSIDE one of its folders — never when P
// only holds one (an ancestor's other children are other projects).
const NO_FOLDER = '\u0000'

// A record KEY (`<location>/<record id>[/<collection>/<child id>…]`) against
// the bearer, judged from the key alone — before anything is looked up, so a
// refusal reads the same whether the record exists or not. True when some
// prefix of the key, cut at a `/`, is `agent:<self>` or a folder at or
// inside one of its folders: whatever location the key resolves to is then
// of its projects (a longer prefix lies inside that folder, a shorter one
// holds it). A key that only passes through a folder AROUND its own (common
// ground: its `plans/` are of every project below it) is not judged here:
// the caller looks the record up and judges the location it resolves to
// (bearerMayReadLocation), answering a record outside — or none — alike.
export function bearerMayReadKey(by: string, key: string, mayRead: (location: string) => boolean): boolean {
  if (by === 'owner') return true
  for (let i = key.indexOf('/'); i > 0; i = key.indexOf('/', i + 1)) {
    const p = key.slice(0, i)
    if (p.startsWith('folder:') ? mayRead(`${p}/${NO_FOLDER}`) : mayRead(p)) return true
  }
  return false
}
