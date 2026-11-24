// escalation/evaluate.ts — WHO is asked next about something stuck, and
// WHEN (hierarchy phase 4, D6 + D7).
//
// Pure: the things stuck now (subjects), what Silos remembers of them
// (cases), the clock, the window and the chain the kernel walks → the hops
// to make now and the cases that closed. Nothing here reads or writes; the
// engine (engine.ts) does, through the existing messages and the plans
// silo's own verbs.
//
// Two kinds of subject, one engine:
//   task  a bound agent's task whose ONE stalled wake changed nothing
//         (task-mode/engine.ts retryFailed) — or, once Silos marked it
//         blocked waiting on the chain, that same task while nobody moved it.
//         Hop 0 fires when the case opens; each next hop one window after
//         the previous one.
//   row   a needs-you row the operator routed to its producer (audience:
//         producer-agent) still uncleared — the producer had the first
//         window; each next hop one window after the previous one.
//
// The chain, in order: the task's owner already had its retry →
// 2 its chain up, one hop at a time → 3 the creator (the author of the
// task's first note, when it is an agent) and its chain → 4 the root →
// 5 the human owner. A row's chain: its producer's chain up, its root, the
// owner. Without a chain relation installed, steps 2-4 are skipped: the next
// (and only) hop is the owner. A hop to an agent is a message, never a wake
// «by chain of command» — a reporting line gives no authority: a normal
// message, and only to an agent On its own whose next heartbeat with a turn
// falls inside the window (engine.ts hopOk); the
// others are skipped. The owner hop is one Needs you row, blocking, and the last.
//
// A case closes when its subject is no longer stuck — the task moved (its
// state, its wait), the row cleared. Never reassigns, never changes owners.

export const OWNER = 'owner' // the human owner, as the last hop names it
export const DEFAULT_WINDOW_HOURS = 24
export const MIN_WINDOW_HOURS = 1
export const MAX_WINDOW_HOURS = 24 * 14

export interface Subject {
  id: string // task:<key> · row:<silo>:<entry>:<key>
  kind: 'task' | 'row'
  key: string // the task's or the record's key
  ref: string // plan#t3 · the row's identity
  title: string
  who: string // the agent it is with: the task's owner, the row's producer
  creator: string | null // task: the agent that wrote its first note
  cause: string // plain words: why it is stuck
  since: string // when it got stuck (the stall's start, the row's first routing)
  silo?: string
  siloName?: string
  entry?: number
  wokeAt?: string // task: when its one wake was delivered
  notStarted?: true // task: Silos could not start its agent's turn at all (task-mode cannotStart)
  folder?: string | null
  file?: string | null
}

export interface Hop {
  to: string
  at: string
}

export interface Case extends Subject {
  openedAt: string
  hops: Hop[]
  // a row already routed when the engine first looked (strict baseline):
  // it never rises; leaving the routing and coming back opens a
  // fresh case with the window
  baseline?: true
  // a task case whose last hop's writes (the wait, blocked) did not land:
  // the engine tries them again at each tick (engine.ts taskWrites)
  writesDue?: true
}

export interface ChainView {
  // the agents above `agent`, nearest first (live edges only); [] without a chain relation
  up(agent: string): string[]
  // is there a chain relation installed at all
  installed: boolean
}

export interface EscalationEval {
  cases: Record<string, Case>
  opened: Case[] // new this time (a task case: the engine writes its recovery note)
  fire: Array<{ c: Case; to: string; hop: number }> // hops due now, one per case
  closed: Case[]
}

// Who is asked about a subject, in order — agents first, the owner last.
// The subject's own agent is never asked about its own thing (it had its
// retry, or it is the producer the row was with); duplicates keep their
// first place.
export function hopTargets(s: Pick<Subject, 'kind' | 'who' | 'creator'>, chain: ChainView, isAgent: (id: string) => boolean = () => true): string[] {
  const out: string[] = []
  const add = (id: string | null): void => {
    if (!id || id === s.who || id === OWNER || out.includes(id) || !isAgent(id)) return
    out.push(id)
  }
  if (chain.installed) {
    const up = chain.up(s.who)
    for (const a of up) add(a) // 2 — its chain, one hop at a time
    if (s.kind === 'task' && s.creator) {
      add(s.creator)
      for (const a of chain.up(s.creator)) add(a)
    } // 3 — the creator's chain
    add(up.length > 0 ? up[up.length - 1]! : null) // 4 — the root (already there when the chain reached it)
  }
  return [...out, OWNER]
}

export function evaluateEscalation(input: {
  subjects: readonly Subject[]
  prev: Readonly<Record<string, Case>>
  now: number
  windowMs: number
  chain: ChainView
  isAgent?: (id: string) => boolean
  // the engine's FIRST look at routed rows: every row case it holds or opens
  // now is baseline — only rows routed afterwards get the window
  baseline?: boolean
}): EscalationEval {
  const { subjects, prev, now, windowMs, chain } = input
  const iso = new Date(now).toISOString()
  const out: EscalationEval = { cases: {}, opened: [], fire: [], closed: [] }
  const present = new Set<string>()
  for (const s of subjects) {
    if (present.has(s.id)) continue
    present.add(s.id)
    const was = prev[s.id]
    // the subject's words move with it (a renamed task, a row's new text);
    // its moment, its hops and its CREATOR stay the case's — the creator is
    // read once, when the case opens: the notes written since (Silos' own
    // recovery note among them) never change who is asked (revision
    // finding 5).
    const c: Case = was
      ? { ...was, ...s, creator: was.creator, since: was.since, openedAt: was.openedAt, hops: [...was.hops] }
      : { ...s, openedAt: iso, hops: [] }
    if (!was) out.opened.push(c)
    if (input.baseline && c.kind === 'row' && c.hops.length === 0) c.baseline = true
    out.cases[s.id] = c
    if (c.baseline) continue
    if (c.hops.some((h) => h.to === OWNER)) continue // the owner was the last hop
    // when the next hop is due: a task asks at once, a row after the
    // producer's own window; then one window after the previous hop
    const last = c.hops.length > 0 ? Date.parse(c.hops[c.hops.length - 1]!.at) : null
    const due = last !== null ? last + windowMs : c.kind === 'task' ? Date.parse(c.openedAt) : Date.parse(c.openedAt) + windowMs
    if (Number.isNaN(due) || now < due) continue
    const asked = new Set(c.hops.map((h) => h.to))
    const next = hopTargets(c, chain, input.isAgent).find((t) => !asked.has(t))
    if (!next) continue
    c.hops.push({ to: next, at: iso })
    out.fire.push({ c, to: next, hop: c.hops.length - 1 })
  }
  for (const [id, c] of Object.entries(prev)) if (!present.has(id)) out.closed.push(c)
  return out
}

// The words of a case, as the owner's row says them: «plan#t3 stalled since
// Nov 3, 09:12 — asked Builder, then Finance; nobody moved it».
export function askedWords(c: Pick<Case, 'hops'>, nameOf: (id: string) => string): string {
  const agents = c.hops
    .map((h) => h.to)
    .filter((t) => t !== OWNER)
    .map(nameOf)
  if (agents.length === 0) return ''
  if (agents.length === 1) return `asked ${agents[0]}`
  return `asked ${agents.slice(0, -1).join(', then ')}, then ${agents[agents.length - 1]}`
}
