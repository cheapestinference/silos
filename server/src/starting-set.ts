// starting-set.ts — THE birth seam (spec tools-origin §8): a project is
// born when a folder is first given to an agent of an engine — as its
// folder or an extra one, a directory Silos made or one that already
// existed. At that moment, and only then, the folder gets the starting set:
// for each class its engine declares (Harness.loads.startingSet), the
// user's choice (~/.silos/settings.json, platform-settings.ts) or else
// Silos' recommendation; the engine writes each «off» key only where the
// folder's own file does not set it already (a choice on disk wins).
//
// Called where an agent gets folders: POST /api/agents and the role-pack
// install (right after the fence's enableAtBirth), and PATCH /api/agents/:id
// when it changes the folder, the extra folders or the engine. A folder
// another agent of that engine has or had — archived agents included — is
// no birth: an existing project is never touched (no migration). Never
// blocks the birth: a folder it cannot write (a home folder, a file it
// can't read or write) comes back as a warn, said on the agent's page.
// The server wires it with the install's settings store (always, in
// index.ts); a server built without that store has no seam.
// Neutral: it reads classes and names no engine.
import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { findHarness, harnessOf } from './harnesses/registry.js'
import type { LoadsRow, LoadsSkills, StartingSetClass } from './harnesses/contract.js'
import type { Agent } from './types.js'

export interface StartingSetDeps {
  registry: { list(includeArchived?: boolean): Agent[] }
  home: string
  /** the user's choices per engine (a class absent: Recommended) */
  settings: { startingSet(engine: string): Record<string, boolean> }
}

type AgentFolders = Pick<Agent, 'id' | 'folder' | 'folders' | 'framework' | 'archived'>

const canon = (p: string): string => {
  try {
    return realpathSync(p)
  } catch {
    return resolve(p)
  }
}
const foldersOf = (a: Pick<Agent, 'folder' | 'folders'>): string[] => [
  ...new Set([a.folder, ...(a.folders ?? [])].filter((f): f is string => typeof f === 'string' && f !== '').map(canon)),
]
const engineOf = (a: Pick<Agent, 'framework'>): string | null => {
  try {
    return harnessOf(a)
  } catch {
    return null
  }
}

/** The set a new project of `engine` starts with: each declared class, on
 *  or off — the user's choice, else Recommended. [] for an engine with no
 *  class. */
export function startingSetFor(engine: string, settings: StartingSetDeps['settings'] | undefined): (StartingSetClass & { on: boolean })[] {
  const classes = findHarness(engine)?.loads?.startingSet?.classes ?? []
  const chosen = settings?.startingSet(engine) ?? {}
  return classes.map((c) => ({ ...c, on: Object.prototype.hasOwnProperty.call(chosen, c.id) ? chosen[c.id] === true : c.recommended }))
}

/** The agents of `engine` (archived included) other than `selfId` that
 *  have `folder` as their folder or an extra one. */
export function projectAgents<T extends AgentFolders>(all: readonly T[], engine: string, folder: string, selfId?: string): T[] {
  const f = canon(folder)
  return all.filter((a) => a.id !== selfId && engineOf(a) === engine && foldersOf(a).includes(f))
}

/** The folders `after` is born into: each of its folders that it did not
 *  have on this same engine `before`, and that no OTHER agent of that
 *  engine has or had (archived included). An archived agent is born
 *  nowhere. */
export function bornFolders(after: AgentFolders, before: AgentFolders | null, all: readonly AgentFolders[]): string[] {
  if (after.archived) return []
  const engine = engineOf(after)
  if (engine === null) return []
  const had = before && engineOf(before) === engine ? new Set(foldersOf(before)) : new Set<string>()
  return foldersOf(after).filter((f) => !had.has(f) && projectAgents(all, engine, f, after.id).length === 0)
}

/** The seam: writes the starting set in every folder `after` is born
 *  into. Never throws. Returns the owner-facing warn when a folder could
 *  not be set (the agent exists either way). */
export function applyStartingSet(deps: StartingSetDeps, after: AgentFolders & Pick<Agent, 'name'>, before: AgentFolders | null): string | undefined {
  let born: string[]
  try {
    born = bornFolders(after, before, deps.registry.list(true))
  } catch (err) {
    console.warn(`starting-set: could not read the agents for ${after.id}:`, err)
    return undefined
  }
  if (born.length === 0) return undefined
  const engine = engineOf(after)
  const h = engine !== null ? findHarness(engine) : undefined
  const ss = h?.loads?.startingSet
  if (!ss || engine === null) return undefined
  const set = Object.fromEntries(startingSetFor(engine, deps.settings).map((c) => [c.id, c.on]))
  const failed: { folder: string; cause: string }[] = []
  for (const folder of born) {
    try {
      ss.apply({ folder, home: deps.home }, set)
    } catch (err) {
      const cause = err instanceof Error ? err.message : String(err)
      console.warn(`starting-set: could not set what ${folder} starts with:`, cause)
      failed.push({ folder, cause })
    }
  }
  if (failed.length === 0) return undefined
  const off = startingSetFor(engine, deps.settings).filter((c) => !c.on)
  const what = `The ${listWords(off.map((c) => c.what))} from ${off[0]?.from ?? 'elsewhere'}`
  return failed.map((f) => `${what} load in ${f.folder} — Silos couldn’t keep them off: ${f.cause.replace(/\.$/, '')}.`).join(' ')
}

const listWords = (xs: string[]): string => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`)

/** What the first run's «At start» and the New agent form say as facts (spec
 *  tools-origin §8, scopes §5): what you set up on this machine, counted —
 *  what a new project loads apart from what this machine keeps off —
 *  and, per class, the names its origin sends when the disk or the login's
 *  list says them ([] = nothing known yet: the step names nothing). Read
 *  from the engine's own inventory and skills (folder-loads.ts wouldLoad);
 *  a plugin's servers are counted with their plugin, never on their own. */
export interface StartingFacts {
  /** per kind: `n` what a new project loads of it, `off` the names this
   *  machine keeps off (its line «This machine» is off) — counted apart,
   *  never «always on» */
  machine: { what: 'plugins' | 'MCP servers' | 'skills'; n: number; off: string[] }[]
  sends: Record<string, string[]>
}

/** the machine keeps it off: its «This machine» line is off, and nothing
 *  above the machine (the organization) decides it */
const offOnMachine = (r: LoadsRow): boolean => {
  const m = r.at?.find((l) => l.place === 'machine')
  return m !== undefined && m.result === 'off' && m.locked?.why !== 'organization' && r.state !== 'active'
}

export function startingFacts(classes: readonly StartingSetClass[], read: { rows: readonly LoadsRow[]; skills: LoadsSkills | null }): StartingFacts {
  const top = read.rows.filter((r) => r.parent === undefined)
  const yours = (kind: LoadsRow['kind']): LoadsRow[] => top.filter((r) => r.origin.owner === 'you' && r.kind === kind)
  const count = (what: 'plugins' | 'MCP servers', kind: LoadsRow['kind']): StartingFacts['machine'][number] => {
    const rows = yours(kind)
    const off = rows.filter(offOnMachine)
    return { what, n: rows.length - off.length, off: [...new Set(off.map((r) => r.label))].sort((a, b) => a.localeCompare(b)) }
  }
  const machine: StartingFacts['machine'] = [
    count('plugins', 'plugin'),
    count('MCP servers', 'mcp'),
    { what: 'skills' as const, n: new Set(read.skills?.personal ?? []).size, off: [] },
  ].filter((m) => m.n > 0 || m.off.length > 0)
  const sends: Record<string, string[]> = {}
  for (const c of classes) {
    const names =
      c.covers === 'skill'
        ? (read.skills?.accounts ?? []).flatMap((a) => a.skills.map((x) => x.name))
        : top.filter((r) => r.origin.owner === 'account' && r.kind === c.covers).map((r) => r.label)
    sends[c.id] = [...new Set(names)].sort((a, b) => a.localeCompare(b))
  }
  return { machine, sends }
}
