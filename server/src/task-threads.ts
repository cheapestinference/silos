// Which sessions belong to a task's thread — the ONE membership rule, shared
// by GET /api/sessions/:folder/:id/tasks (session→tasks) and the task feed
// (task→sessions). A task's conversations[] lists the session each thread was
// born in; rotations (/clear, keep-thread) are reached through lineage, and a
// listed session may itself be trashed (unindexed). A session is a member when
//   - it is listed, or
//   - a listed id appears in its ancestor chain, or
//   - it shares a thread ROOT id with a listed id.
// Roots compare as bare ids (a trashed listed id resolves to no folder/key)
// and the walk is deep (THREAD_WALK — threadRootKey's default of 8 loses tips
// on real chains, which reach 25; ancestry walks pass through the trash on
// purpose).
import type { SessionMeta } from './types.js'
import type { LineageStore } from './lineage.js'
import { makeAncestry, type Ancestry } from './ancestry.js'

const THREAD_WALK = 64

// conversations[] entries are string | {session} | {id}; the writer writes
// {session} (siloActions.appendItem), so session wins over id — the one
// precedence everywhere (task-mode engine already reads it this way).
export function conversationIdsOf(list: unknown): string[] {
  if (!Array.isArray(list)) return []
  return list.flatMap((c) => {
    if (typeof c === 'string') return c !== '' ? [c] : []
    if (typeof c === 'object' && c !== null) {
      const o = c as { session?: unknown; id?: unknown }
      const v = typeof o.session === 'string' && o.session !== '' ? o.session : typeof o.id === 'string' && o.id !== '' ? o.id : null
      return v ? [v] : []
    }
    return []
  })
}

// releases[] entries (plans 0.5.1, R13): {session, released} — the order is
// the array's (the kernel always appends); an entry without a session id or
// a boolean `released` is not one. `at`/`by` are good practice, never a
// condition: a hand-written {session, released: false} without them reads.
export interface ReleaseMark {
  session: string
  released: boolean
}
export function releasesOf(list: unknown): ReleaseMark[] {
  if (!Array.isArray(list)) return []
  return list.flatMap((r) => {
    if (typeof r !== 'object' || r === null) return []
    const o = r as { session?: unknown; released?: unknown }
    return typeof o.session === 'string' && o.session !== '' && typeof o.released === 'boolean' ? [{ session: o.session, released: o.released }] : []
  })
}

// An id's ancestor chain on its thread, nearest first, THREAD_WALK deep:
// through the ancestry when the id is indexed, through lineage links alone
// when it is not (a trashed listed id, a conversation born a moment ago).
function threadChainOf(id: string, m: SessionMeta | null, ancestry: Ancestry, lineage: LineageStore | null): string[] {
  if (m) return ancestry.ancestorIdsOf(m, true, THREAD_WALK)
  const chain: string[] = []
  const seen = new Set<string>([id])
  let cur = id
  while (chain.length < THREAD_WALK) {
    const next = lineage?.continuationParentIdOf(cur) ?? null
    if (!next || seen.has(next)) break
    seen.add(next)
    chain.push(next)
    cur = next
  }
  return chain
}

// THE resolver of «which conversation is this session?» for anything keyed
// by conversation rather than by session (conversation files): the thread ROOT id — the same walk the task feed's membership
// uses, never ancestry's default of 8, never the liveness-dependent console
// key. Every route and caller asks this one function.
export type ThreadIdOf = (sessionId: string) => string
export function makeThreadIdOf(o: { lineage: LineageStore | null | undefined; metaById: (id: string) => SessionMeta | null }): ThreadIdOf {
  const lineage = o.lineage ?? null
  const ancestry = makeAncestry({ lineage, metaById: o.metaById })
  return (id) => {
    const chain = threadChainOf(id, o.metaById(id), ancestry, lineage)
    return chain.length > 0 ? chain[chain.length - 1]! : id
  }
}

export interface ThreadMembership {
  belongs(m: SessionMeta, listed: readonly string[]): boolean
  sessionsOf(listed: readonly string[]): SessionMeta[]
  // the thread ROOT id of an id (itself when it has no known ancestor)
  rootOf(id: string): string
  // the thread an id is on: its root, after the console key → native id
  // step (an OpenCode key and its `ses_…` are ONE thread — R13)
  threadKey(id: string): string
}

// `nativeIdOf` (R13): a console key → the id its engine sealed (OpenCode's
// `ses_…`); absent, an id is its own (Claude: the key IS the id).
export function threadMembership(
  metas: readonly SessionMeta[],
  lineage: LineageStore | null,
  opts: { nativeIdOf?: (id: string) => string | null } = {},
): ThreadMembership {
  const byId = new Map(metas.map((m) => [m.id, m]))
  const ancestry = makeAncestry({ lineage, metaById: (id) => byId.get(id) ?? null })
  const chains = new Map<string, string[]>() // id → ancestor ids, nearest first
  const chainOf = (id: string): string[] => {
    const hit = chains.get(id)
    if (hit) return hit
    const chain = threadChainOf(id, byId.get(id) ?? null, ancestry, lineage)
    chains.set(id, chain)
    return chain
  }
  const rootOf = (id: string): string => {
    const chain = chainOf(id)
    return chain.length > 0 ? chain[chain.length - 1]! : id
  }
  const threadKey = (id: string): string => rootOf(opts.nativeIdOf?.(id) ?? id)
  const belongs = (m: SessionMeta, listed: readonly string[]): boolean => {
    if (listed.length === 0) return false
    const set = new Set(listed)
    if (set.has(m.id)) return true
    if (chainOf(m.id).some((id) => set.has(id))) return true
    const mine = threadKey(m.id)
    return listed.some((id) => threadKey(id) === mine)
  }
  // `belongs` read the other way round, for every meta at once — the SAME
  // three clauses, indexed: a meta is a member of `listed` when its own id
  // is listed (byId), a listed id is on its ancestor chain (descendants of
  // that id), or its thread key is a listed id's (byKey). Built on the first
  // question and kept for this membership's life (the chains already are),
  // so a pass asking about every task walks the index once, not once per
  // task.
  let index: { pos: Map<SessionMeta, number>; descendants: Map<string, SessionMeta[]>; byKey: Map<string, SessionMeta[]> } | null = null
  const indexOf = (): NonNullable<typeof index> => {
    if (index) return index
    const pos = new Map<SessionMeta, number>()
    const descendants = new Map<string, SessionMeta[]>()
    const byKey = new Map<string, SessionMeta[]>()
    const push = (map: Map<string, SessionMeta[]>, k: string, m: SessionMeta): void => {
      const l = map.get(k)
      if (l) l.push(m)
      else map.set(k, [m])
    }
    metas.forEach((m, i) => {
      pos.set(m, i)
      for (const a of new Set(chainOf(m.id))) push(descendants, a, m)
      push(byKey, threadKey(m.id), m)
    })
    index = { pos, descendants, byKey }
    return index
  }
  const sessionsOf = (listed: readonly string[]): SessionMeta[] => {
    if (listed.length === 0) return []
    const ix = indexOf()
    const out = new Set<SessionMeta>()
    for (const id of listed) {
      const own = byId.get(id)
      if (own) out.add(own)
      for (const m of ix.descendants.get(id) ?? []) out.add(m)
      for (const m of ix.byKey.get(threadKey(id)) ?? []) out.add(m)
    }
    // in the index's order, as a filter over the metas would give them
    return [...out].sort((a, b) => ix.pos.get(a)! - ix.pos.get(b)!)
  }
  return { belongs, sessionsOf, rootOf, threadKey }
}

// The CURRENT conversations of a task (R13 — one rule of validity): its
// listed ids grouped into threads by threadKey; for each thread the LAST
// entry of releases[] on it, by position, decides — none, or released:
// false, the thread is current; released: true, it is history. Entries on no
// listed thread are ignored. conversationIdsOf stays the history (every id).
export function currentConversationIdsOf(task: { conversations: unknown; releases?: unknown }, member: Pick<ThreadMembership, 'threadKey'>): string[] {
  const listed = conversationIdsOf(task.conversations)
  const marks = releasesOf(task.releases)
  if (marks.length === 0) return listed
  const last = new Map<string, boolean>()
  for (const r of marks) last.set(member.threadKey(r.session), r.released)
  return listed.filter((id) => last.get(member.threadKey(id)) !== true)
}

// The task-mode reads of a task's thread, through the SAME membership rule
// (the server used to look only at the LISTED
// ids, so after a /clear the working tip was invisible: the task read
// stalled, a wake resumed the ancestor and forked the thread, and the busy
// check never saw the tip busy):
//   tipOf(agent, listed)     the (agent, task) conversation: the NEWEST
//                            member of the thread that `agent` owns — its tip
//   holdersOf(agent, listed) the sessions whose busy holds THAT agent's wake:
//                            its own members, plus listed ids Silos does not
//                            index yet (a console «Work on this» just opened
//                            is listed before the index knows it). Another
//                            agent's conversation never holds it.
//   anyLive(listed, isLive)  some conversation of the thread is live
//   threadKey(id)            the thread an id is on (ThreadMembership's)
//   currentOf(listed, rel)   the listed ids still current (R13)
// Callers hand them the task's CURRENT ids (currentOf), never the history.
// Only tipOf filters by `continuable` (R5 — the door, /work, the wakes and
// /talk resume a conversation only when it can be continued: not a run's
// transcript, and the recent tip of its lineage thread); a run is still a
// member, a holder and live.
export interface TaskThreads {
  tipOf(agent: string, listed: readonly string[]): { sessionId: string; folder: string } | null
  holdersOf(agent: string, listed: readonly string[]): string[]
  anyLive(listed: readonly string[], isLive: (sessionId: string) => boolean): boolean
  threadKey(id: string): string
  currentOf(listed: readonly string[], releases: unknown): string[]
  // the indexed members of the thread these ids name (ThreadMembership's)
  sessionsOf(listed: readonly string[]): SessionMeta[]
}

export function taskThreads(o: {
  metas: readonly SessionMeta[]
  lineage: LineageStore | null
  ownerOf: (m: SessionMeta) => string | null
  nativeIdOf?: (id: string) => string | null
  continuable?: (m: SessionMeta) => boolean
}): TaskThreads {
  const member = threadMembership(o.metas, o.lineage, o.nativeIdOf ? { nativeIdOf: o.nativeIdOf } : {})
  const indexed = new Set(o.metas.map((m) => m.id))
  const owned = (agent: string, listed: readonly string[]): SessionMeta[] =>
    member
      .sessionsOf(listed)
      .filter((m) => o.ownerOf(m) === agent)
      .sort((a, b) => b.mtime - a.mtime)
  return {
    tipOf: (agent, listed) => {
      const tip = owned(agent, listed).find((m) => !o.continuable || o.continuable(m))
      return tip ? { sessionId: tip.id, folder: tip.folder } : null
    },
    holdersOf: (agent, listed) => [...new Set([...owned(agent, listed).map((m) => m.id), ...listed.filter((id) => !indexed.has(id))])],
    // the thread's members asked, not every meta (sessionsOf is belongs indexed)
    anyLive: (listed, isLive) => listed.length > 0 && (listed.some(isLive) || member.sessionsOf(listed).some((m) => isLive(m.id))),
    threadKey: (id) => member.threadKey(id),
    currentOf: (listed, releases) => currentConversationIdsOf({ conversations: [...listed], releases }, member),
    sessionsOf: (listed) => member.sessionsOf(listed),
  }
}
