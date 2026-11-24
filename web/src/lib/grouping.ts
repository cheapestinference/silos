// grouping.ts — groups consecutive "tools-only" (no text) assistant turns
// into runs to compact the transcript view. Applied to the turns visible
// AFTER the Transcript's window cap, before rendering.
//
// this file also hosts `sortGroups`, the pure function that decides the
// order/demote of the Sidebar's per-folder groups — the same "group pure,
// DOM-free testable things" criterion as groupTurns, even though the
// domain has nothing to do with it.
import type { SessionView, Turn } from './types'

export type Block = { kind: 'turn'; turn: Turn } | { kind: 'streak'; turns: Turn[] }

export function groupTurns(turns: Turn[]): Block[] {
  const out: Block[] = []
  for (const t of turns) {
    // a plan-mode plan (ExitPlanMode) is a document, never folded into a streak
    const toolsOnly = t.role === 'assistant' && t.text.trim() === '' && t.tools.length > 0 && !t.toolUses?.some((u) => u.plan)
    const prev = out[out.length - 1]
    if (toolsOnly && prev?.kind === 'streak') prev.turns.push(t)
    else if (toolsOnly) out.push({ kind: 'streak', turns: [t] })
    else out.push({ kind: 'turn', turn: t })
  }
  return out
}

// --- project menu ordering --------------------------------------------

// the "recent" window splitRecent uses for topics inside an agent (7 days).
export const INACTIVE_MS = 7 * 24 * 3600_000

// a mirror of the `{ projects: {...} }` shape the server persists in
// ui.json (see server/src/prefs-store.ts) — the same field names, not translated.
export interface ProjectsPrefs {
  order?: string[]
  collapsed?: string[]
  pinned?: string[]
  inPool?: string[] // projects the owner put in the tray BY HAND (drag); inactive ones drop in on their own
}

// a group's stable key — folder===null (agents with no folder) uses '',
// same as the old groupByFolder already did internally before this scheme.
export function groupKey(folder: string | null): string {
  return folder ?? ''
}

export interface SortableGroup {
  folder: string | null
}

export interface SortResult<T> {
  active: T[]
  inactive: T[]
}

// binding order: MANUAL only (never reorder agents or projects on their
// own). Pinned groups (pinned) go first, in the
// persisted drag order (`order`); everything else keeps the order it
// arrived in (the registry's, which is stable) — no jump for live
// activity, no jump for recent mtime. The tray is manual too: a group is
// `inactive` ONLY if the owner dragged it there (inPool).
export function sortGroups<T extends SortableGroup>(groups: readonly T[], prefs: ProjectsPrefs): SortResult<T> {
  const pinned = new Set(prefs.pinned ?? [])
  const inTray = new Set(prefs.inPool ?? [])
  const orderIndex = new Map((prefs.order ?? []).map((key, i) => [key, i]))

  const rank = (g: T): number => {
    const key = groupKey(g.folder)
    if (!pinned.has(key)) return Number.POSITIVE_INFINITY
    return orderIndex.get(key) ?? Number.MAX_SAFE_INTEGER
  }
  // Array.prototype.sort is stable: equal ranks (all the unpinned) keep
  // their incoming order.
  const sorted = [...groups].sort((a, b) => rank(a) - rank(b))
  const active: T[] = []
  const inactive: T[] = []
  for (const g of sorted) (inTray.has(groupKey(g.folder)) ? inactive : active).push(g)
  return { active, inactive }
}

// --- chains: sessions born from one another (fork/rotation) -----------

// a chain is ONE conversation in the sidebar: the most recent session
// (head) plus the sessions it continued through (earlier), both ordered by
// mtime desc. A console `/clear` starts a NEW conversation:
// its link never joins a chain — the child heads its own. With no known
// ancestors IN THIS SET, the chain is just its head — the normal case.
export interface Chain {
  head: SessionView
  earlier: SessionView[]
}

function sessionKey(s: SessionView): string {
  return `${s.folder}/${s.id}`
}

// groups by connected components of the parentKey graph (child->parent),
// restricted to the given sessions — a fork's parent may belong to
// ANOTHER agent or have been deleted; if it's not in `sessions`, that link
// simply joins nothing here (the source session isn't "inherited"). A
// union-find can't cycle (every union points one side's root at the
// other's root, never backwards), so no anti-cycle guard is needed here —
// that guard lives in LineageStore.chainOf (server), which does resolve
// the on-disk file directly.
// `detached`: session keys the owner pulled out of their chain by drag
// (prefs.detachedChains) — their parent link is ignored here, so each one
// heads its own chain (its own ancestors, if any, still hang from it).
export function groupChains(sessions: readonly SessionView[], detached: ReadonlySet<string> = new Set()): Chain[] {
  const keys = new Set(sessions.map(sessionKey))
  const parent = new Map<string, string>()
  const root = (k: string): string => {
    let r = k
    while (parent.has(r)) r = parent.get(r) as string
    return r
  }
  const union = (a: string, b: string): void => {
    if (a === b) return
    const ra = root(a)
    const rb = root(b)
    if (ra !== rb) parent.set(ra, rb)
  }
  for (const s of sessions) {
    if (s.parentKey && s.parentKind !== 'clear' && keys.has(s.parentKey) && !detached.has(sessionKey(s))) union(sessionKey(s), s.parentKey)
  }

  const groups = new Map<string, SessionView[]>()
  for (const s of sessions) {
    const r = root(sessionKey(s))
    const arr = groups.get(r)
    if (arr) arr.push(s)
    else groups.set(r, [s])
  }

  const chains: Chain[] = []
  for (const members of groups.values()) {
    const [head, ...earlier] = [...members].sort((a, b) => b.mtime - a.mtime)
    if (head) chains.push({ head, earlier })
  }
  return chains.sort((a, b) => b.head.mtime - a.head.mtime)
}

// --- archived: what a /clear left behind ---------------------------------

// A console /clear starts a NEW conversation (groupChains never joins it);
// the conversation it left behind is done by the owner's own hand — it is
// ARCHIVED: never listed in the sidebar, not even under a fold (archived
// ones must not pile up there). It stays findable by search — the command palette and the
// sidebar's text filter, where it carries an "archived" mark — and from
// the new conversation's "continues from"; opening it reads as a
// read-only transcript with the way to the current conversation. Nothing
// is deleted.

// the keys of the sessions a /clear child left behind, among `sessions`
export function clearedKeys(sessions: readonly SessionView[]): Set<string> {
  const cleared = new Set<string>()
  for (const s of sessions) if (s.parentKey && s.parentKind === 'clear') cleared.add(s.parentKey)
  return cleared
}

// a chain is archived when any of its members was cleared away — the whole
// thread that led up to the /clear goes with it
export function splitArchived<T extends { head: { folder: string; id: string }; earlier: readonly { folder: string; id: string }[] }>(
  chains: readonly T[],
  sessions: readonly SessionView[],
): { live: T[]; archived: T[] } {
  const cleared = clearedKeys(sessions)
  const live: T[] = []
  const archived: T[] = []
  for (const c of chains) {
    const gone = cleared.has(`${c.head.folder}/${c.head.id}`) || c.earlier.some((e) => cleared.has(`${e.folder}/${e.id}`))
    ;(gone ? archived : live).push(c)
  }
  return { live, archived }
}

// --- conversation: recent vs older ---

// within an agent, between 3 and 5 topics are shown by recent activity;
// the rest folds into "▸ N older". The floor of 3 keeps the list from
// feeling empty when almost nothing is "active" (uses the SAME window as
// the project tray, INACTIVE_MS) — the ceiling of 5 keeps a recent burst
// of activity from leaving the list permanently unfolded.
export const MIN_RECENT_TOPICS = 3
export const MAX_RECENT_TOPICS = 5

export interface TopicsSplit<T> {
  recent: T[]
  old: T[]
}

// `chains` already arrives sorted by the head's mtime desc (see
// groupChains) — this function only decides WHERE to cut, it never reorders.
export function splitRecent<T extends { head: { mtime: number } }>(chains: readonly T[], now: number): TopicsSplit<T> {
  const active = chains.filter((c) => now - c.head.mtime < INACTIVE_MS).length
  const cut = Math.min(MAX_RECENT_TOPICS, Math.max(MIN_RECENT_TOPICS, active), chains.length)
  return { recent: chains.slice(0, cut), old: chains.slice(cut) }
}

// --- chains: where a conversation is now ----------------------------------

// Where a conversation actually IS now: the most recently active session
// among the session ITSELF and its descendants along parentKey links.
// Claude Code forks on `--resume` (a console reopened over X writes to Y,
// Y's over Z…): opening X should land on Z, with X and Y as "earlier". A
// descendant OLDER than the session never wins — a stale child (an SDK fork
// born at once by an old bug) under a console written every minute is not
// where the thread continues. A tie goes to the descendant
// (a /clear child written in the same instant is the continuation), as
// lineage.recentTipOf on the server.
// Bounded, cycle-safe; the session itself when nothing newer continues it
// (or it isn't in `sessions` and nothing continues it).
// `continuation`: follow only the links that continue the conversation —
// never a /clear, which starts a new one. Navigation uses it (opening a
// cleared conversation reads THAT conversation); the console's owner — the
// whole thread, /clears included — does not.
export function chainTip(sessions: readonly SessionView[], folder: string, id: string, opts: { continuation?: boolean } = {}): { folder: string; id: string } {
  // every descendant (BFS over parentKey), then the most recently active
  // one — a side branch that moved later than the deeper one IS where the
  // conversation is now.
  const seen = new Set<string>([`${folder}/${id}`])
  const queue = [`${folder}/${id}`]
  const self = sessions.find((s) => s.folder === folder && s.id === id) ?? null
  let best: SessionView | null = self
  while (queue.length > 0 && seen.size < 64) {
    const key = queue.shift() as string
    for (const s of sessions) {
      if (s.parentKey !== key) continue
      if (opts.continuation && s.parentKind === 'clear') continue
      const k = `${s.folder}/${s.id}`
      if (seen.has(k)) continue
      seen.add(k)
      queue.push(k)
      if (!best || s.mtime >= best.mtime) best = s
    }
  }
  return best ? { folder: best.folder, id: best.id } : { folder, id }
}

// --- conversations: the owner's order — nothing moves on its own ----------

export interface OrderedChain {
  head: { folder: string; id: string; mtime: number }
  earlier: readonly { folder: string; id: string }[]
}
const keyOf = (s: { folder: string; id: string }): string => `${s.folder}/${s.id}`
const membersOf = (c: OrderedChain): string[] => [keyOf(c.head), ...c.earlier.map(keyOf)]

// A stored slot names a session, but the pin belongs to the conversation
// where that thread lives NOW — resolved through the lineage, /clears
// included (the owner pinned a place for the work, not a session id: after
// a /clear the live terminal keeps the place and the cleared-away
// transcript goes back to flowing by activity). Resolution
// at read time: stored prefs stay as written, no migration.
function resolveSlotKey(sessions: readonly SessionView[], key: string): string {
  const cut = key.indexOf('/')
  if (cut < 0 || sessions.length === 0) return key
  const tip = chainTip(sessions, key.slice(0, cut), key.slice(cut + 1))
  return `${tip.folder}/${tip.id}`
}

// The conversation list (replacing an older drag-only order): every
// conversation follows by latest activity, newest first —
// except the ones the owner DRAGGED, which stay FIXED at the position they
// were dropped at ("pinned to a concrete position"); the others flow
// around them. A slot is { key, at }: a chain key and its 0-based index in
// the agent's list. A chain is fixed when any of its members is — a
// rotation (/clear) keeps the place its old head earned.
export interface ConversationSlot {
  key: string
  at: number
}

function slotIndex<T extends OrderedChain>(chains: readonly T[], slots: readonly ConversationSlot[], sessions: readonly SessionView[] = []): Map<T, number> {
  const byMember = new Map<string, T>()
  for (const c of chains) for (const k of membersOf(c)) if (!byMember.has(k)) byMember.set(k, c)
  const out = new Map<T, number>()
  for (const s of slots) {
    // the resolved conversation first (the /clear successor owns the pin
    // when both are drawn); the raw key when the successor isn't among
    // `chains` (filtered out, detached) — a pin never evaporates.
    const home = byMember.get(resolveSlotKey(sessions, s.key)) ?? byMember.get(s.key)
    if (home && !out.has(home)) out.set(home, s.at)
  }
  return out
}

// the full order: fixed chains at their index (a clash or an index past
// the end takes the next free place), the rest by activity in the gaps.
export function orderWithSlots<T extends OrderedChain>(
  chains: readonly T[],
  slots: readonly ConversationSlot[],
  sessions: readonly SessionView[] = [],
): { ordered: T[]; fixed: Set<T> } {
  const at = slotIndex(chains, slots, sessions)
  // ties on `at` break by the slots' own order (the later drop listed first by fixAt)
  const listed = (c: T): number => slots.findIndex((s) => membersOf(c).includes(resolveSlotKey(sessions, s.key)) || membersOf(c).includes(s.key))
  const fixed = [...at.entries()].sort((a, b) => a[1] - b[1] || listed(a[0]) - listed(b[0]))
  const flowing = chains.filter((c) => !at.has(c)).sort((a, b) => b.head.mtime - a.head.mtime)
  const out: (T | undefined)[] = new Array(chains.length).fill(undefined)
  for (const [c, want] of fixed) {
    let i = Math.min(Math.max(0, want), chains.length - 1)
    while (out[i] !== undefined && i < chains.length - 1) i++
    while (out[i] !== undefined) i-- // the tail is full: the last free place
    out[i] = c
  }
  let f = 0
  for (let i = 0; i < out.length; i++) if (out[i] === undefined) out[i] = flowing[f++]
  return { ordered: out as T[], fixed: new Set(at.keys()) }
}

// dropping `dragged` at index `at` of the drawn list: it is fixed there;
// fixed ones in the way (from `at` down, contiguous) move one place down,
// so a drop never swaps two fixed conversations by surprise. Slots of
// conversations this view doesn't draw are left untouched.
export function fixAt(slots: readonly ConversationSlot[], dragged: OrderedChain, at: number, sessions: readonly SessionView[] = []): ConversationSlot[] {
  const mine = new Set(membersOf(dragged))
  // a slot keyed to a conversation this one cleared away is also "mine":
  // one thread, one pin (see resolveSlotKey).
  const owns = (k: string): boolean => mine.has(k) || mine.has(resolveSlotKey(sessions, k))
  const others = slots.filter((s) => !owns(s.key)).map((s) => ({ ...s }))
  const taken = new Set(others.map((s) => s.at))
  let end = at
  while (taken.has(end)) end++
  for (const s of others) if (s.at >= at && s.at < end) s.at += 1
  return [...others, { key: keyOf(dragged.head), at }].sort((a, b) => a.at - b.at)
}

// the chain goes back to flowing by activity.
export function releaseSlot(slots: readonly ConversationSlot[], chain: OrderedChain, sessions: readonly SessionView[] = []): ConversationSlot[] {
  const mine = new Set(membersOf(chain))
  return slots.filter((s) => !mine.has(s.key) && !mine.has(resolveSlotKey(sessions, s.key)))
}

// --- agents: the owner's drag order -----------------------------------------

// agents known to `order` (agentOrder, a global list of ids) come first,
// in that order; the rest keep their incoming (registry) order after them.
// Stable — nothing reorders on its own. Applied BEFORE grouping by folder,
// so inside each project the rows follow the same list.
export function applyAgentOrder<T extends { id: string }>(agents: readonly T[], order: readonly string[]): T[] {
  const rank = new Map(order.map((id, i) => [id, i]))
  return [...agents].sort((a, b) => (rank.get(a.id) ?? Number.POSITIVE_INFINITY) - (rank.get(b.id) ?? Number.POSITIVE_INFINITY))
}

// the new order after dropping `dragged` onto `target`: `visible` is the
// current display order of ALL rows (agent ids, or conversation keys);
// dragged is removed and inserted right before target. Unknown ids →
// unchanged. Shared by agent rows and conversation rows.
export function moveBefore(visible: readonly string[], dragged: string, target: string): string[] {
  if (dragged === target || !visible.includes(dragged) || !visible.includes(target)) return [...visible]
  const without = visible.filter((id) => id !== dragged)
  const idx = without.indexOf(target)
  return [...without.slice(0, idx), dragged, ...without.slice(idx)]
}

// A session is SUPERSEDED when a MORE RECENTLY ACTIVE descendant continues
// it (chainTip lands elsewhere): its console belongs to the chain's tip, so the
// conversation view must show its transcript, never the live console
// (opening an old rotation painted the SAME live console under every row
// of the chain). Derived from data the client already has.
export function isSuperseded(allSessions: readonly SessionView[], key: { folder: string; id: string }): boolean {
  // measured from the thread's ROOT, not from this session: a stale fork
  // hanging off the thread (an older child, like a bug-born SDK twin) has
  // no newer descendant of its own, yet the live console belongs
  // to the thread's tip — showing it under the fork's row painted the same
  // conversation twice.
  const byKey = new Map(allSessions.map((s) => [sessionKey(s), s]))
  let root = byKey.get(`${key.folder}/${key.id}`)
  const seen = new Set<string>()
  while (root?.parentKey && byKey.has(root.parentKey) && !seen.has(root.parentKey)) {
    seen.add(root.parentKey)
    root = byKey.get(root.parentKey)
  }
  const from = root ?? key
  const tip = chainTip(allSessions, from.folder, from.id)
  return tip.folder !== key.folder || tip.id !== key.id
}
