// project-reach.ts — what the owner reads about an agent's projects on its
// Profile: who it works with in each of its folders, and what a change of
// folders opens or closes before it is saved. Both are the server's one
// resolver (server/src/project-scope.ts), read here exactly as the server
// reads it — never a private copy of «same project» or «knows».
import { agentsAt, foldersOf, knows, sameProject } from '../../../server/src/project-scope'
import type { AgentView } from './types'

type Who = Pick<AgentView, 'id' | 'name' | 'folder' | 'folders' | 'archived'>

/** Each of the agent's folders with the agents of that project (never
 *  itself), in the order the install lists them. Empty for an agent with no
 *  folder (the owner's desk, «any project»). */
export function worksWith<A extends Who>(agent: Who, all: readonly A[]): Array<{ folder: string; agents: A[] }> {
  return foldersOf(agent).map((folder) => ({ folder, agents: agentsAt(folder, all).filter((b) => b.id !== agent.id) }))
}

export interface FolderChange<A> {
  /** folders that join a project it was not of, with the agents it will
   *  come to know there (those it already knows elsewhere are left out) */
  added: Array<{ folder: string; agents: A[] }>
  /** projects it leaves, with the agents that will no longer know it */
  removed: Array<{ folder: string; agents: A[] }>
  /** where its conversations start after the change */
  startsIn: string | null
}

/** What a change of folders does, before Save: null when it changes no
 *  project (a folder moved inside the same project, a line reordered). */
export function folderChange<A extends Who>(
  agent: Who,
  next: { folder: string | null; folders: readonly string[] },
  all: readonly A[],
): FolderChange<A> | null {
  const before = foldersOf(agent)
  const after = foldersOf(next)
  const others = all.filter((b) => b.id !== agent.id)
  const nextAgent = { ...agent, folder: next.folder, folders: [...next.folders] }
  const added = after
    .filter((f) => !before.some((g) => sameProject(f, g)))
    .map((folder) => ({ folder, agents: agentsAt(folder, others).filter((b) => !knows(agent, b)) }))
  const removed = before
    .filter((f) => !after.some((g) => sameProject(f, g)))
    .map((folder) => ({ folder, agents: agentsAt(folder, others).filter((b) => !knows(nextAgent, b)) }))
  if (added.length === 0 && removed.length === 0) return null
  return { added, removed, startsIn: after[0] ?? null }
}
