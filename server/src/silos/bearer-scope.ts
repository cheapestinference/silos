// silos/bearer-scope.ts — the ONE bound on what a silo route reads or renders
// on behalf of a bearer: an agent's token never makes the
// server read another agent's state, drafts or project folders, and never
// returns their content — before or after the owner approved anything. The
// owner's credential keeps its full view.
//
// An agent reads: its own state (`agent:<self>`) and the project folders
// inside its territories (`folder:<f>` with f its territory or under it).
// Nothing else — not another agent's state, not a folder outside its
// territories, not platform (kernel) data.
import type { SiloLocations } from './files-source.js'

export type TerritoriesOf = (agentId: string) => readonly string[]

const inside = (folder: string, territories: readonly string[]): boolean => territories.some((t) => folder === t || folder.startsWith(`${t}/`))

// The locations a reader sees for this bearer: the owner every one; an agent
// its own state and the project folders inside its territories.
export function bearerLocations(all: SiloLocations, by: string, territoriesOf: TerritoriesOf): SiloLocations {
  if (by === 'owner') return all
  return {
    agentStates: () => all.agentStates().filter((a) => a.agentId === by),
    projects: () => {
      const terr = territoriesOf(by)
      return all.projects().filter((f) => inside(f, terr))
    },
  }
}

// One record location (`agent:<id>`, `folder:<path>`, …) against the bearer.
export function bearerMayReadLocation(by: string, location: string, territoriesOf: TerritoriesOf): boolean {
  if (by === 'owner') return true
  if (location === `agent:${by}`) return true
  if (!location.startsWith('folder:')) return false
  return inside(location.slice('folder:'.length), territoriesOf(by))
}

// A record KEY (`<location>/<record id>[/<collection>/<child id>…]`) against
// the bearer, judged from the key alone — before anything is looked up, so a
// refusal reads the same whether the record exists or not. Some prefix of
// the key, cut at a `/`, must be a location the bearer reads (a folder path
// holds `/` itself; every such prefix of a folder inside a territory is
// inside it too).
export function bearerMayReadKey(by: string, key: string, mayRead: (location: string) => boolean): boolean {
  if (by === 'owner') return true
  for (let i = key.indexOf('/'); i > 0; i = key.indexOf('/', i + 1)) {
    if (mayRead(key.slice(0, i))) return true
  }
  return false
}
