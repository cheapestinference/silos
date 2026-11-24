// project-scope.ts — the ONE definition of «same project» and «knows»
// (docs/architecture.md «Project boundary»). An agent knows and reaches only
// its own projects: the folders it works in, the agents that work there with
// it, and what lives in them. Every reach that bounds an agent — the roster
// it is told, the messages served to it, the asks and task verbs it may use,
// the plan keys it may append to, the routes its bearer reads — calls this
// module; none keeps a private copy of the rule.
//
//  · A project is a folder; folders that NEST are one project
//    (`/home/user/acme` and `/home/user/acme/docs`), siblings that share a
//    prefix are not (`/home/user/acme` · `/home/user/acme-web`).
//  · Membership is the folders the owner declared (`folder` + `folders[]`),
//    compared as TEXT on a segment boundary. Nothing an agent can write is
//    read: no `.git`, no symlink, no disk at all — a one-line `.git` file in
//    an agent's own folder never joins it to another project.
//  · Two agents KNOW each other when both are in play and some folder of one
//    is the same project as some folder of the other. Symmetric, NOT
//    transitive: an agent of two projects is a bridge the owner opened; the
//    agents of each side still know nothing of the other.
//  · `master` (the owner's desk), an agent without a folder and an archived
//    agent know nobody. Where the owner's desk acts as the owner (it reaches
//    and reads everything), the CALLER says so — `seesAll`.
//
// Pure: no I/O, no registry. The plugin's roster.py carries a twin of
// sameProject/knows (it must filter a raw agents.json);
// server/test/roster-text.test.ts compares the two renderers byte for byte.
// A leaf: the web imports it as is (web/src/lib/home.ts memberOf), so it
// imports nothing but another leaf.
import { SILOS_AUTHOR } from './system-author.js'

/** The owner's desk — agent-registry.ts MASTER_ID (that module is not a
 *  leaf; project-scope.test.ts pins the two together). */
export const OWNERS_DESK = 'master'
const MASTER_ID = OWNERS_DESK

export interface Member {
  id: string
  folder?: string | null
  folders?: readonly string[] | null
  archived?: boolean
}

const strip = (p: string): string => (p.length > 1 ? p.replace(/\/+$/, '') || '/' : p)

/** The agent's declared folders, absolute, without a trailing slash, each once. */
export function foldersOf(a: Pick<Member, 'folder' | 'folders'>): string[] {
  const out: string[] = []
  for (const p of [a.folder, ...(a.folders ?? [])]) {
    if (typeof p !== 'string' || !p.startsWith('/')) continue
    const f = strip(p)
    if (f !== '/' && !out.includes(f)) out.push(f)
  }
  return out
}

/** f is g, or one lies inside the other (segment boundary, text only). */
export function sameProject(f: string, g: string): boolean {
  if (typeof f !== 'string' || typeof g !== 'string' || !f.startsWith('/') || !g.startsWith('/')) return false
  const a = strip(f)
  const b = strip(g)
  if (a === '/' || b === '/') return false
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`)
}

/** Some folder of one list is the same project as some folder of the other. */
export function foldersShareProject(fa: readonly string[], fb: readonly string[]): boolean {
  return fa.some((f) => fb.some((g) => sameProject(f, g)))
}

/** In play for the rule: not archived, not the owner's desk, with a folder. */
export function inProjects(a: Member | null | undefined): a is Member {
  return !!a && a.id !== MASTER_ID && a.archived !== true && foldersOf(a).length > 0
}

/** Some folder of the agent is the same project as `folder`. */
export function ofProject(a: Member | null | undefined, folder: string | null | undefined): boolean {
  if (!inProjects(a) || typeof folder !== 'string') return false
  return foldersOf(a).some((f) => sameProject(f, folder))
}

/** Both in play, and some folder of `a` is the same project as some folder of `b`. */
export function knows(a: Member | null | undefined, b: Member | null | undefined): boolean {
  if (!inProjects(a) || !inProjects(b)) return false
  return foldersShareProject(foldersOf(a), foldersOf(b))
}

/** The agents `a` knows (never itself), in the order given. */
export function agentsOf<T extends Member>(a: Member | null | undefined, all: readonly T[]): T[] {
  if (!inProjects(a)) return []
  return all.filter((b) => b.id !== a.id && knows(a, b))
}

/** The agents of `folder`'s project, in the order given. */
export function agentsAt<T extends Member>(folder: string | null | undefined, all: readonly T[]): T[] {
  if (typeof folder !== 'string') return []
  return all.filter((b) => ofProject(b, folder))
}

/** Those of `b`'s folders that are `a`'s projects too — what a roster row
 *  prints (its other folders are not the reader's to see). */
export function sharedFolders(a: Member, b: Member): string[] {
  const fa = foldersOf(a)
  return foldersOf(b).filter((g) => fa.some((f) => sameProject(f, g)))
}

/** The reader sees the whole install: the owner (null) or the owner's desk. */
export function seesAll(reader: string | null | undefined): boolean {
  return reader === null || reader === undefined || reader === MASTER_ID
}

/** Ids every reader may see named: the owner, Silos, the owner's desk. */
const ALWAYS_NAMED = new Set(['owner', SILOS_AUTHOR, MASTER_ID])

/** May `reader` (an agent id; null = the owner) see `id` named — its name,
 *  its conversations' facts? Yes for itself, the owner, Silos, the owner's
 *  desk and an agent it knows NOW; the owner and the owner's desk see all. */
export function mayName(reader: string | null | undefined, id: string, all: readonly Member[]): boolean {
  if (seesAll(reader) || id === reader || ALWAYS_NAMED.has(id)) return true
  const r = all.find((a) => a.id === reader)
  const b = all.find((a) => a.id === id)
  return knows(r, b)
}

/** The name of `id` for `reader` (null = the owner): `nameOf(id)` when the
 *  reader may see it named (mayName), otherwise the id exactly as written —
 *  never decorated with a name, a title or a path. */
export function nameFor(reader: string | null | undefined, id: string, all: readonly Member[], nameOf: (id: string) => string): string {
  return mayName(reader, id, all) ? nameOf(id) : id
}

/** A message (or an ask's line) from `from` is served to `recipient` when
 *  the sender is the owner, the owner's desk, Silos, or an agent the
 *  recipient knows NOW. Anything else stays as it is — unread, unmarked,
 *  unserved; nothing is written on a read — and shows to the owner through
 *  the unread-messages row with its why (inbox.ts). If the two later share a
 *  project, it is served. */
export function servable(recipient: string, from: string, all: readonly Member[]): boolean {
  return mayName(recipient, from, all)
}

/** Does `reader` (an agent id; null = the owner) reach `folder` — a task's
 *  project, a plan key's location? The owner and the owner's desk reach
 *  everything; an agent its projects. */
export function reaches(reader: string | null | undefined, folder: string | null | undefined, all: readonly Member[]): boolean {
  if (seesAll(reader)) return true
  return ofProject(
    all.find((a) => a.id === reader),
    folder,
  )
}

/** Is `a` of a silo record's LOCATION — `folder:<f>`: of f's project;
 *  `agent:<id>`: that agent itself? What Silos moves on its own (a wake, an
 *  escalation hop, a routed row) goes only to an agent of the location the
 *  thing lives in (R3). A location that is no project's and no agent's (the
 *  platform's kernel records, a file read from outside) bounds nobody. */
export function ofLocation(a: Member | null | undefined, location: string | null | undefined): boolean {
  if (typeof location !== 'string') return true
  if (location.startsWith('folder:')) return ofProject(a, location.slice('folder:'.length))
  if (location.startsWith('agent:')) return !!a && a.archived !== true && a.id === location.slice('agent:'.length)
  return true
}

/** The owner of a thing at `location` (a plan task) is an agent in play that
 *  is NOT of it: Silos never moves it for that owner — no wake, no packet
 *  line, no bearer verb; to the owner it is a stall of its own
 *  (`owner-outside-project`). The owner, a person, the owner's desk, an
 *  archived agent or one without a folder are other cases. */
export function ownerOutside(a: Member | null | undefined, location: string | null | undefined): boolean {
  return inProjects(a) && !ofLocation(a, location)
}

/** The project a PATH lies in — the outermost of `folders` (every agent's
 *  in play) that is the path or holds it; null: in no project (a home
 *  dotfile, an engine's store, Silos' data). A folder merely INSIDE the path
 *  is not its project: the home folder is no project's file even though
 *  every project nests in it. */
export function projectOfPath(path: string, folders: readonly string[]): string | null {
  if (typeof path !== 'string' || !path.startsWith('/')) return null
  const p = strip(path)
  const holding = folders.map(strip).filter((f) => f !== '/' && (p === f || p.startsWith(`${f}/`)))
  if (holding.length === 0) return null
  return holding.sort((a, b) => a.length - b.length)[0]!
}
