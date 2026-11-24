// silos/task-flow.ts — the ONE kernel function behind a task's flow.
// A sub-kind that declares `roles.task` names which of its
// fields are the task's owner, its dependencies, what it waits on, its next
// check and the conversations working it; the kernel then computes, for
// each such record, five names a predicate can read like any field:
//
//   waiting       it waits on someone (`waitingOn` with an owner) or on a
//                 moment still ahead (`nextCheckAt` in the future)
//   gate          an agent's open task waits on it DIRECTLY (finishing it
//                 hands work to an agent) — `unblocks` (not a predicate
//                 name: a list) says WHICH tasks and whose, so a row can say
//                 «unblocks 2 tasks of Writer» like the native plan row did
//   stalled       it is open and NOTHING guards its next step — the
//                 central rule: every open task has a live conversation, a
//                 wake on the way, a human owner, a healthy blocker chain, a
//                 wait with an owner, or a next check
//   stalledCause  why, in one of nine words (STALLED_CAUSES)
//   stalledBy     the FIRST stuck task down the blocker chain — the one to
//                 fix («blocked by parked work: finance#t4»), not the one on top
//                 (a dead link: the id it names; a cycle's member: the next
//                 member, through which it loops back)
//   stalledAt     the SEAT of the stall, by position:
//                 the task whose own situation is the cause — stalledBy; for a
//                 dead link (blocker-missing, blocker-cancelled) the task that
//                 DECLARES it; in a cycle every member is its own seat and a
//                 task reaching one sits at the first member reached; a
//                 blocker waiting for its start is the seat of what it parks
//                 (and is not stalled itself). The seat of a seat is itself, or
//                 is not stalled. Not a predicate name: stallExit() reads it —
//                 a task whose seat is another has that seat's way out
//   waitsStart    an agent that only runs when someone opens a
//                 conversation ('never'), in play with a folder, holds this
//                 open task — pending or in progress, nothing blocking it, no
//                 live thread: it is the OWNER's turn to start (or continue)
//                 it there. Never a stall (nothing is broken: the door is the
//                 action); a task blocked on it is `blocker-parked` by it.
//   idle          ready and nobody on it: pending, its
//                 dependencies done, no wait, no conversation of it LIVE
//                 (a current one that stopped moving
//                 is nobody on it — the same reading own() makes), its
//                 owner in task mode ('task') and no wake on the way — a
//                 surface («Not started — nobody is on it»), never a wake
//
// The live facts enter at request time (G4): `isLive(session)` and
// `wakes(agent)` ('task' it is On its own: its task's events start it ·
// 'never' it runs only when someone opens a conversation). Without
// them nothing is live and nobody wakes — never a guess. This reading never
// writes: a stalled task is SAID, with its cause (what Silos does write in a
// plan — claim, release, the owner's gestures, Task mode's reopen and cleared
// nextCheckAt, an escalated stall — is listed in team-plan's «Silos writes
// in these files too»).
//
// The role reads the states by their standard names: pending, in_progress,
// in_review, blocked, done, cancelled — `done` alone resolves a dependency
// (a cancelled blocker must be removed or replaced).
// The walk has no depth cap and is linear (A2.7): each task is looked at once
// per call — a healthy verdict is remembered, any other ends the walk — and a
// cycle is a cause of its own (blocker-cycle), never a silence.
import type { EvalRecord, FieldDict } from './expressions.js'
import { conversationIdsOf } from '../task-threads.js'
import { passGeneration } from '../pass.js'
import { ASK_REACH_MS } from '../limits.js'

// one cause, one meaning — nine. Computed by the
// kernel, never declared by a manifest: they may change within v0.
export const STALLED_CAUSES = [
  'unowned', // nobody owns it (stalledBy === its id) — or a task down its chain nobody owns
  'blocked-on-nothing', // blocked, naming no dependency and no wait (or a task down its chain is)
  'blocker-missing', // a dependency names an id its plan does not have (a readable plan's: an unreadable id is A1.8's row)
  'blocker-cycle', // its dependencies reach a cycle — it is a member, or it waits on one
  'blocker-parked', // blocked by parked work: in progress with nothing live, in review with nobody reviewing, an agent waiting for its start
  'blocker-cancelled', // blocked by a cancelled task — it never resolves
  'owner-cannot-run', // its owner (or its blocker's) is an agent that never wakes and can't be started (out of play, no folder)
  'review-without-reviewer', // in review, an agent's, with no waitingOn naming someone else (a next check is no reviewer — B1a)
  'in-progress-nothing-live', // in progress, no conversation live, its owner in task mode (a 'never' agent's is waitsStart)
] as const
export type StalledCause = (typeof STALLED_CAUSES)[number]

export const TASK_FLOW_NAMES: ReadonlySet<string> = new Set([
  'waiting',
  'gate',
  'stalled',
  'stalledCause',
  'stalledBy',
  'waitsOnHuman',
  'waitsOnRelay',
  'waitsStart',
  'idle',
])

// Silos' own wait — the escalation's «unstick <ref>» (escalation/engine.ts):
// the owner's word answers it (task-mode/evaluate.ts reopens over it), and it
// is never a wait the owner has to relay (waitsOnRelay)
export const SILOS_WAIT_PREFIX = 'unstick '
export const isSilosWait = (w: { action: string } | null): boolean => w !== null && w.action.startsWith(SILOS_WAIT_PREFIX)

// an AGENT's task in review is guarded only by a
// reviewer it names: a waitingOn whose owner is someone other than the task's
// owner (the owner, a person, another agent — B1d's relay). A next check
// reviews nothing; a wait naming the owner itself is no reviewer (F12 — it is
// `review-without-reviewer`, never a relay row). Silos' own wait (`unstick …`)
// guards it as it always did. Read by own() and by the release's dispose
// (silos/actions.ts appendRelease, B1b/F6) — one rule.
export function reviewerNamed(owner: string, wait: unknown): boolean {
  if (!isObj(wait) || !nonBlank(wait.owner)) return false
  if (isSilosWait({ action: nonBlank(wait.action) ? wait.action : '' })) return true
  return wait.owner.trim() !== owner.trim()
}

// the ask a task's owner armed through Silos (POST
// /api/tasks/ask) — the ONE fact Task mode's store keeps for the task, with
// `seenBy`: when the asked agent's next heartbeat falls, counted from `at`
// (period.ts nextSlot — computed from the fact, never from the clock: it does
// not flicker), null when none is in reach (not bound, no period, asleep past
// it, archived). The text is the store's, never the file's.
export interface AskFact {
  to: string
  action: string
  asked: string
  at: string
  seenBy: number | null
}

// (B2.3, H5) «linked» is DERIVED at read time: the file's wait matches the
// fact — its owner, action and question (`asked ?? ''`), trimmed; `options`
// never count. A wait that does not match (written by hand, edited, the
// store reset) is simply not linked: nothing to keep in step, nothing to
// reconcile, and a read that fails changes nothing.
export function askLinked(fact: Pick<AskFact, 'to' | 'action' | 'asked'>, wait: unknown): boolean {
  if (!isObj(wait) || !nonBlank(wait.owner)) return false
  const t = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')
  return wait.owner.trim() === fact.to.trim() && t(wait.action) === fact.action.trim() && t(wait.asked) === fact.asked.trim()
}

// (B2.5, H8) the asked agent sees it by itself: its next heartbeat counted
// from `at` falls within ASK_REACH_MS — and only until then. Past it, or with
// no beat in reach from minute zero, the owner relays it.
export function askReaches(f: Pick<AskFact, 'at' | 'seenBy'>, now: number): boolean {
  const at = Date.parse(f.at)
  if (Number.isNaN(at) || f.seenBy === null) return false
  return f.seenBy <= at + ASK_REACH_MS && now < at + ASK_REACH_MS
}

// 'task': in task mode — its task's events wake it (agent-wakes.ts)
export type Wakes = 'task' | 'never'
export interface TaskEnv {
  isLive(sessionId: string): boolean
  // some conversation of the THREAD these listed ids name is live — after a
  // /clear the live session is a descendant nobody listed (task-threads.ts,
  // the one membership rule). Absent: only the listed ids are asked.
  threadLive?(sessionIds: readonly string[]): boolean
  wakes(agentId: string): Wakes
  // the CURRENT conversations of a task (plans 0.5.1, R13): the listed ids
  // minus the threads its releases[] let go — computed on the server in ONE
  // place (task-threads.ts currentConversationIdsOf). Absent: every listed id
  // is current (like threadLive above).
  currentOf?(listed: string[], releases: unknown): string[]
  // the agent can be started on a task through its door: in
  // play, with a folder. Absent: every agent can. An agent that can't keeps
  // `owner-cannot-run`.
  startable?(agentId: string): boolean
  // a task-mode wake is on its way for this task — queued for
  // its owner, or its task turn running. `key` is the task's record key when
  // the caller knows it; without it the owner and the task id say it (a
  // queued wake of that owner on a task of that id, in any plan). Absent:
  // none is.
  wakeOnTheWay?(q: { key: string | null; owner: string; id: string }): boolean
  // a conversation's title and last activity (ms) — the
  // turn's «last in «title» 2 min ago». Absent or null: unknown.
  titleOf?(sessionId: string): { title: string | null; at: number | null } | null
  // the ask armed on the task of this record key
  // (AskFact). Absent, or a reader without the key: no ask — a wait on an
  // agent is the owner's relay, as before (H5)
  askOf?(key: string): AskFact | null
}

// a task's conversations live — the thread when the env knows it (taskLive
// is what task-flow and turn.ts both read: they can never disagree)
export function taskLive(env: TaskEnv | undefined, conversations: unknown, releases?: unknown): boolean {
  if (!env) return false
  const ids = currentConversations(env, conversations, releases)
  if (ids.length === 0) return false
  return env.threadLive ? env.threadLive(ids) : ids.some((id) => env.isLive(id))
}

// a task's current conversations: the env's rule when it has one, else all
export function currentConversations(env: TaskEnv | undefined, conversations: unknown, releases: unknown): string[] {
  const all = conversationIdsOf(conversations)
  return env?.currentOf ? env.currentOf(all, releases) : all
}

// What still holds a BLOCKED task (the one rule): every
// dependency not done (a missing one too: it never resolves by itself), a
// wait naming someone, a next check still ahead (flow.waiting's two halves).
// Empty: nothing holds it — a blocked task with nothing left to wait on.
// Read by the owner's note that reopens (silos/actions.ts reopenVerdict),
// by the claim's `keep` (silos/actions.ts claimKeepOf),
// and by the owner's gestures (silos/actions.ts taskGesture: answer, reopen,
// resume, remove-dependency — and the `holds` their answer carries).
export function blockedHolds(o: {
  deps: readonly string[]
  stateOf: (id: string) => string | undefined
  wait: { owner: string; action: string } | null
  nextCheckAt: string | null
  now: number
}): string[] {
  const out: string[] = []
  if (o.wait && o.wait.owner.trim() !== '') out.push(`${o.wait.owner.trim()}${o.wait.action.trim() !== '' ? ` (${o.wait.action.trim()})` : ''}`)
  for (const d of new Set(o.deps)) if (o.stateOf(d) !== 'done') out.push(d)
  const at = o.nextCheckAt !== null && o.nextCheckAt !== '' ? Date.parse(o.nextCheckAt) : NaN
  if (!Number.isNaN(at) && at > o.now) out.push(`its next check (${o.nextCheckAt})`)
  return out
}

// A BLOCKED task that declares dependencies, every
// one of them done, with no wait naming someone and no next check ahead:
// nothing holds it — it reads as `pending` in EVERY reader (the flow's own,
// its idle and waitsStart, the turn sentence — silos/turn.ts —, the owner's
// assign — task-mode/engine.ts — and the owner's link — routes/console.ts).
// A blocked task that declares neither a dependency nor a wait is
// `blocked-on-nothing` (A2.4). A past next check is no hold (blockedHolds).
export function blockedReadsPending(o: {
  state: string
  deps: readonly string[]
  stateOf: (id: string) => string | undefined
  wait: { owner: string; action: string } | null
  nextCheckAt: string | null
  now: number
}): boolean {
  return o.state === 'blocked' && o.deps.length > 0 && blockedHolds(o).length === 0
}

// A task RECORD's state as every reader reads it (A1.5): its own, except a
// blocked one nothing holds — pending. `sibling` finds a dependency by id.
export function taskStateRead(t: EvalRecord, sibling: (id: string) => EvalRecord | undefined, role: TaskRole, now: number): string {
  const st = String(t.state)
  if (st !== 'blocked') return st
  const deps = Array.isArray(t[role.dependsOn]) ? (t[role.dependsOn] as unknown[]).filter((d): d is string => typeof d === 'string') : []
  const w = role.waitingOn ? t[role.waitingOn] : undefined
  const nc = role.nextCheckAt ? t[role.nextCheckAt] : undefined
  const wait = isObj(w) && nonBlank(w.owner) ? { owner: w.owner, action: nonBlank(w.action) ? w.action : '' } : null
  const stateOf = (id: string): string | undefined => {
    const b = sibling(id)
    return b ? String(b.state) : undefined
  }
  return blockedReadsPending({ state: st, deps, stateOf, wait, nextCheckAt: typeof nc === 'string' && nc !== '' ? nc : null, now }) ? 'pending' : st
}

// the role's field names, as the manifest declares them
// releases (plans 0.5.1): the sister collection the release verb marks — a
// thread whose last mark is released: true is history, not current
export interface TaskRole {
  owner: string
  dependsOn: string
  waitingOn?: string
  nextCheckAt?: string
  conversations?: string
  releases?: string
}

export interface TaskFlow {
  waiting: boolean
  gate: boolean
  // the open agent tasks that wait on it directly, in the plan's order
  unblocks: Array<{ id: string; owner: string }>
  stalled: boolean
  stalledCause: StalledCause | null
  stalledBy: string | null
  // (A2.5) the seat of the stall (see the header) — null when not stalled
  stalledAt: string | null
  // a declared waitingOn {owner, action, asked?, options?} — who it waits
  // on, in the file's words; `asked` the question (a non-blank string),
  // `options` 1–4 answers of ≤40 characters — read raw from
  // the object, a shape outside that is ignored, never a reason to refuse
  waitsOn: { owner: string; action: string; asked?: string; options?: string[] } | null
  // that wait names a HUMAN (the owner, a reviewer): the task is stopped on a
  // person — what admits it into Needs you (an agent's task waiting on you
  // was invisible there for a while: Writer sat stopped on a decision for days)
  waitsOnHuman: boolean
  // that wait names an AGENT —
  // bound, told, archived, the task's own owner — is not Silos' own
  // (`unstick …`), and Silos does not carry it there (`asked` below is null):
  // the wait is the OWNER's to relay — never waitsOnHuman (the owner does not
  // answer for it). The task stays guarded (it waits); Needs you says «X
  // waits on Y». A task of the owner (or of a person) waiting on an agent is
  // always relay: only an agent's bearer arms an ask (H11).
  waitsOnRelay: boolean
  // (B2.5) the ask Silos carries to the agent the wait names: an agent's
  // task, its wait LINKED to the armed fact (askLinked), the asked agent's
  // next beat in reach (askReaches) — a guard (G4), and no relay row. null
  // otherwise (and for Silos' own wait, which the escalation guards — H10)
  asked: { to: string; at: string; seenBy: number } | null
  // the listed conversations still CURRENT on the task (R13) — what the
  // web's taskOfRow reads (conversations[] keeps every id: the history)
  currentConversations: string[]
  // the owner's turn to start its 'never' agent on it, and ready
  // with nobody on it (see the header)
  waitsStart: boolean
  idle: boolean
  // a current conversation of it is live (taskLive — the 2 h rule of
  // conversation-live.ts): what `own()` reads, carried for the readers that
  // must say the same (Task mode's assign). Not a
  // predicate name.
  live: boolean
}

type Json = Record<string, unknown>
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)
const nonBlank = (v: unknown): v is string => typeof v === 'string' && v.trim() !== ''
const OPEN_END = new Set(['done', 'cancelled'])

// `unreadableSiblings`: the ids of the tasks the
// plan's FILE holds that the reader could not build — a dependency on one is
// guarded by A1.8's row (the plan can't be read), never a blocker-missing
// stall nor a wake. Absent: none (a dependency naming no readable task is
// blocker-missing, as before).
type FlowEnv = { now: number; isAgent?: (v: string) => boolean; taskEnv?: TaskEnv; key?: string; unreadableSiblings?: readonly string[] }

// One evaluation of a task's flow per synchronous pass (pass.ts), shared by
// every reader that asks with the same inputs — the inbox's flow, turn and
// `ready`, a records page's cells and folds, the board's predicates, Task
// mode's snapshots. The inputs are the reading's own objects (the record,
// its siblings — a kernel refresh makes new ones), the role's field names,
// the clock, the agent test, the live facts, the key and the unreadable
// siblings (by CONTENT: each reader builds its base records, so the array is
// a new one per reader — absent and empty are the same answer); a writer of those
// facts ends the pass (pass.ts endPass). The answer is frozen: shared, it is
// never a reader's to change.
type FlowMemo = {
  gen: number
  siblings: readonly EvalRecord[]
  role: string
  now: number
  isAgent: FlowEnv['isAgent']
  taskEnv: TaskEnv | undefined
  key: string | undefined
  unreadable: string
  flow: TaskFlow
}
const flowMemo = new WeakMap<EvalRecord, FlowMemo[]>()
const roleKeys = new WeakMap<TaskRole, string>()
const roleKeyOf = (role: TaskRole): string => {
  let k = roleKeys.get(role)
  if (k === undefined) {
    k = JSON.stringify([role.owner, role.dependsOn, role.waitingOn ?? null, role.nextCheckAt ?? null, role.conversations ?? null, role.releases ?? null])
    roleKeys.set(role, k)
  }
  return k
}
let flowEvaluations = 0
/** How many flows were evaluated (not answered from the pass) — the work a test counts. */
export function taskFlowEvaluations(): number {
  return flowEvaluations
}

export function taskFlow(task: EvalRecord, siblings: readonly EvalRecord[], dict: Pick<FieldDict, 'task'>, env: FlowEnv): TaskFlow {
  const role = dict.task
  if (!role) return evaluateTaskFlow(task, siblings, dict, env)
  const gen = passGeneration()
  const rk = roleKeyOf(role)
  const unreadable = env.unreadableSiblings && env.unreadableSiblings.length > 0 ? env.unreadableSiblings.join('\0') : ''
  const kept = (flowMemo.get(task) ?? []).filter((m) => m.gen === gen)
  const hit = kept.find(
    (m) =>
      m.siblings === siblings &&
      m.role === rk &&
      m.now === env.now &&
      m.isAgent === env.isAgent &&
      m.taskEnv === env.taskEnv &&
      m.key === env.key &&
      m.unreadable === unreadable,
  )
  if (hit) return hit.flow
  const flow = freezeFlow(evaluateTaskFlow(task, siblings, dict, env))
  // a writer inside the evaluation (none should) ended the pass: not kept
  if (passGeneration() === gen) kept.push({ gen, siblings, role: rk, now: env.now, isAgent: env.isAgent, taskEnv: env.taskEnv, key: env.key, unreadable, flow })
  flowMemo.set(task, kept)
  return flow
}

function freezeFlow(f: TaskFlow): TaskFlow {
  for (const u of f.unblocks) Object.freeze(u)
  Object.freeze(f.unblocks)
  Object.freeze(f.currentConversations)
  if (f.waitsOn) {
    if (f.waitsOn.options) Object.freeze(f.waitsOn.options)
    Object.freeze(f.waitsOn)
  }
  if (f.asked) Object.freeze(f.asked)
  return Object.freeze(f)
}

function evaluateTaskFlow(task: EvalRecord, siblings: readonly EvalRecord[], dict: Pick<FieldDict, 'task'>, env: FlowEnv): TaskFlow {
  flowEvaluations++
  const role = dict.task
  if (!role)
    return {
      waiting: false,
      gate: false,
      unblocks: [],
      stalled: false,
      stalledCause: null,
      stalledBy: null,
      stalledAt: null,
      waitsOn: null,
      waitsOnHuman: false,
      waitsOnRelay: false,
      asked: null,
      currentConversations: [],
      waitsStart: false,
      idle: false,
      live: false,
    }
  const isAgent = env.isAgent ?? (() => false)
  const wakes = env.taskEnv?.wakes ?? ((): Wakes => 'never')
  const byId = new Map<string, EvalRecord>()
  for (const s of siblings) if (typeof s.id === 'string' && !byId.has(s.id)) byId.set(s.id, s)
  const unreadable = new Set(env.unreadableSiblings ?? [])

  const owner = (t: EvalRecord): string => (nonBlank(t[role.owner]) ? (t[role.owner] as string).trim() : '')
  const deps = (t: EvalRecord): string[] =>
    Array.isArray(t[role.dependsOn]) ? (t[role.dependsOn] as unknown[]).filter((d): d is string => typeof d === 'string') : []
  const human = (t: EvalRecord): boolean => owner(t) !== '' && !isAgent(owner(t))
  const checkAt = (t: EvalRecord): number | null => {
    const v = role.nextCheckAt ? t[role.nextCheckAt] : undefined
    const ms = typeof v === 'string' && v !== '' ? Date.parse(v) : NaN
    return Number.isNaN(ms) ? null : ms
  }
  const waitsOnSomeone = (t: EvalRecord): boolean => {
    const w = role.waitingOn ? t[role.waitingOn] : undefined
    return isObj(w) && nonBlank(w.owner)
  }
  const checkAhead = (t: EvalRecord): boolean => {
    const at = checkAt(t)
    return at !== null && at > env.now
  }
  const waiting = (t: EvalRecord): boolean => waitsOnSomeone(t) || checkAhead(t)
  const convs = (t: EvalRecord): unknown => (role.conversations ? t[role.conversations] : undefined)
  const rels = (t: EvalRecord): unknown => (role.releases ? t[role.releases] : undefined)
  // asked once per task per call (A2.7: each task is looked at once)
  const liveSeen = new Map<EvalRecord, boolean>()
  const live = (t: EvalRecord): boolean => {
    let v = liveSeen.get(t)
    if (v === undefined) {
      v = taskLive(env.taskEnv, convs(t), rels(t))
      liveSeen.set(t, v)
    }
    return v
  }
  // the state as every reader reads it: a blocked task nothing holds is
  // pending (A1.5 — blockedReadsPending)
  const stateOf = (t: EvalRecord): string => taskStateRead(t, (id) => byId.get(id), role, env.now)
  // a dependency still open: not done — an id naming no readable task too
  // (it never resolves by itself; the walk tells a missing one from one the
  // file holds but can't build, which A1.8's row guards — A2.5)
  const openDep = (d: string): boolean => byId.get(d)?.state !== 'done'

  // an agent the owner's door can start (F11): in play, with a folder — only
  // asked when the request's live facts are there (without them nobody wakes
  // and nothing is said startable: the old reading)
  const startable = (o: string): boolean => (env.taskEnv ? (env.taskEnv.startable?.(o) ?? true) : false)
  // bound: an agent Silos wakes on its tasks (Task mode) — the ONE reading
  const bound = (o: string): boolean => o !== '' && isAgent(o) && wakes(o) === 'task'

  // x's own reason, its dependencies aside: 'ok', 'deps' (look at them),
  // 'start' (its 'never' agent waits for the owner to open it — no stall), or
  // a cause. Written ONCE, in order:
  //   1 closed → ok
  //   2 live → ok; in review and an agent's: a reviewer named (B1a —
  //     reviewerNamed) → ok, else review-without-reviewer; a wait naming
  //     someone, or a next check still AHEAD → ok
  //   3 nobody owns it → unowned (a past check guards nobody's task — E3
  //     amends A1.4's «a task nobody owns: unchanged»)
  //   4 a PAST check of a bound owner → ok (Task mode fires or clears it,
  //     A1.4); any other's past check is nobody's
  //   5 in review: a person's → ok (an agent's was said at step 2)
  //   6 open dependencies → deps: the chain is walked — a person's too (A2.6:
  //     G3 is not trivial), except without the request's live facts (no
  //     taskEnv: nothing is startable there, so an agent's pending task would
  //     read owner-cannot-run and drag the owner's down) — then a person's is
  //     ok, as before
  //   7 a person's → ok (G3)
  //   8 blocked (nothing it names, A1.5 read) → blocked-on-nothing
  //   9 the agent's own: its 'never' agent waits for its start (or cannot
  //     run); a bound one in progress with nothing live
  type Own = 'ok' | 'deps' | 'start' | StalledCause
  const ownOf = (x: EvalRecord): Own => {
    if (OPEN_END.has(String(x.state))) return 'ok'
    if (live(x)) return 'ok'
    const o = owner(x)
    if (x.state === 'in_review' && o !== '' && isAgent(o))
      return reviewerNamed(o, role.waitingOn ? x[role.waitingOn] : undefined) ? 'ok' : 'review-without-reviewer'
    if (waitsOnSomeone(x) || checkAhead(x)) return 'ok'
    if (o === '') return 'unowned'
    if (checkAt(x) !== null && bound(o)) return 'ok'
    if (x.state === 'in_review') return human(x) ? 'ok' : 'review-without-reviewer'
    if (deps(x).some(openDep)) return human(x) && !env.taskEnv ? 'ok' : 'deps'
    if (human(x)) return 'ok'
    const st = stateOf(x)
    if (st === 'blocked') return 'blocked-on-nothing'
    const w = wakes(o)
    // an agent that only runs when someone opens it: the owner's turn to
    // start it there (E6) — or, when it can't be started (archived, no
    // folder), an owner that cannot run
    if (w === 'never') return (st === 'pending' || st === 'in_progress') && startable(o) ? 'start' : 'owner-cannot-run'
    // task mode wakes a task on its events — never an in-progress one that
    // nothing is working («in progress with nothing live»)
    if (w === 'task' && st === 'in_progress') return 'in-progress-nothing-live'
    return 'ok'
  }
  const ownSeen = new Map<EvalRecord, Own>()
  const own = (x: EvalRecord): Own => {
    let v = ownSeen.get(x)
    if (v === undefined) {
      v = ownOf(x)
      ownSeen.set(x, v)
    }
    return v
  }

  // The walk (A2.7): depth-first along the open dependencies, the path held
  // as a stack (a cycle is a dependency already ON it), no depth cap — the
  // path never holds a task twice, so it is at most the plan's size. Only
  // HEALTHY verdicts are remembered: they never touch the path, and any other
  // verdict ends the whole walk — so each task is looked at once per call.
  type Stuck = { cause: StalledCause; by: string; at: string }
  const healthy = new Set<string>()
  const path: string[] = []
  const onPath = new Map<string, number>()
  const stalledOf = (x: EvalRecord): Stuck | null => {
    const xid = String(x.id)
    if (healthy.has(xid)) return null
    const o = own(x)
    if (o === 'ok' || o === 'start') {
      healthy.add(xid)
      return null
    }
    if (o !== 'deps') return { cause: o, by: xid, at: xid }
    onPath.set(xid, path.length)
    path.push(xid)
    try {
      for (const d of deps(x)) {
        if (!openDep(d)) continue
        const b = byId.get(d)
        // an id the file holds that the reader could not build: guarded by
        // A1.8's row («N tasks in <plan> can't be read») — no stall, no wake
        if (!b && unreadable.has(d)) continue
        // a dead link: its seat is the task that DECLARES it (A2.5)
        if (!b) return { cause: 'blocker-missing', by: d, at: xid }
        if (b.state === 'cancelled') return { cause: 'blocker-cancelled', by: d, at: xid }
        const i = onPath.get(d)
        if (i !== undefined) {
          // a cycle (E4): its members are the path from d to here. The task
          // asked about is a member when the cycle runs through it — its own
          // seat, stalledBy the next member; otherwise it waits on the cycle,
          // seated at the first member it reaches
          if (i === 0) return { cause: 'blocker-cycle', by: path[1] ?? path[0]!, at: path[0]! }
          return { cause: 'blocker-cycle', by: path[i]!, at: path[i]! }
        }
        // a blocker waiting for the owner to start its agent parks this one,
        // and it is the one to fix (E6: «blocked by parked work: <it>») —
        // the seat, never stalled itself (its line: «opens with you»)
        if (own(b) === 'start') return { cause: 'blocker-parked', by: d, at: d }
        const r = stalledOf(b)
        if (r === null) continue
        if (r.by === d && r.at === d)
          return { cause: r.cause === 'in-progress-nothing-live' || r.cause === 'review-without-reviewer' ? 'blocker-parked' : r.cause, by: d, at: d }
        return r
      }
      healthy.add(xid)
      return null
    } finally {
      path.pop()
      onPath.delete(xid)
    }
  }

  const id = String(task.id)
  const unblocks = siblings
    .filter((s) => s !== task && !OPEN_END.has(String(s.state)) && owner(s) !== '' && isAgent(owner(s)) && deps(s).includes(id))
    .map((s) => ({ id: String(s.id), owner: owner(s) }))
  const s = stalledOf(task)
  const w = role.waitingOn ? task[role.waitingOn] : undefined
  const opts =
    isObj(w) && Array.isArray(w.options) && w.options.length >= 1 && w.options.length <= 4 && w.options.every((o) => nonBlank(o) && o.trim().length <= 40)
      ? (w.options as string[]).map((o) => o.trim())
      : null
  const waitsOn =
    isObj(w) && nonBlank(w.owner)
      ? {
          owner: (w.owner as string).trim(),
          action: nonBlank(w.action) ? (w.action as string).trim() : '',
          ...(nonBlank(w.asked) ? { asked: (w.asked as string).trim() } : {}),
          ...(opts ? { options: opts } : {}),
        }
      : null
  const current = currentConversations(env.taskEnv, convs(task), rels(task))
  const o = owner(task)
  // ready, nobody on it (G2): only an agent Silos wakes on its tasks — a
  // beat's check-in picks it up, a 'never' one is waitsStart
  const idle =
    stateOf(task) === 'pending' &&
    o !== '' &&
    isAgent(o) &&
    env.taskEnv !== undefined &&
    !waiting(task) &&
    deps(task).every((d) => byId.get(d)?.state === 'done') &&
    !live(task) &&
    wakes(o) === 'task' &&
    env.taskEnv.wakeOnTheWay?.({ key: env.key ?? null, owner: o, id }) !== true
  // (B2.5) the wait on an agent that Silos carries: an agent's open task, its
  // wait linked to the armed fact, the asked agent's beat in reach
  const open = !OPEN_END.has(String(task.state))
  const fact =
    open && waitsOn !== null && o !== '' && isAgent(o) && isAgent(waitsOn.owner) && !isSilosWait(waitsOn) && env.key !== undefined
      ? (env.taskEnv?.askOf?.(env.key) ?? null)
      : null
  const asked = fact && askLinked(fact, w) && askReaches(fact, env.now) && fact.seenBy !== null ? { to: fact.to, at: fact.at, seenBy: fact.seenBy } : null
  return {
    waiting: waiting(task),
    gate: unblocks.length > 0,
    unblocks,
    stalled: s !== null,
    stalledCause: s?.cause ?? null,
    stalledBy: s?.by ?? null,
    stalledAt: s?.at ?? null,
    waitsOn,
    waitsOnHuman: waitsOn !== null && !OPEN_END.has(String(task.state)) && !isAgent(waitsOn.owner),
    // (F12) an agent's review waiting on its own owner is no relay: it is
    // review-without-reviewer, and the stall is its one line
    waitsOnRelay:
      waitsOn !== null &&
      open &&
      isAgent(waitsOn.owner) &&
      !isSilosWait(waitsOn) &&
      !(task.state === 'in_review' && waitsOn.owner === o && isAgent(o)) &&
      asked === null,
    asked,
    currentConversations: current,
    waitsStart: own(task) === 'start',
    idle,
    live: live(task),
  }
}

// A stall's ONE way out, read through its seat —
// by Task mode (a wake) and by Needs you (the row of seats nobody wakes):
//   'wake'  the task is its own seat, its owner is bound (`bound`: Task mode
//           wakes it on its tasks — taskEnv.wakes(owner) === 'task') and the
//           cause is one its owner can clear (not owner-cannot-run, not
//           unowned): Task mode wakes it; nothing changing, the escalation
//   'row'   the task is its own seat and nobody is woken for it (nobody owns
//           it, a person's, an agent not bound, owner-cannot-run): one of the
//           distinct seats tasksStalled counts
//   'seat'  its seat is another task: that seat's exit is its way out (a
//           wake, the row, or — a blocker waiting for its start — the «opens
//           with you» line); this task gets no wake and is not counted
// null: not stalled.
export type StallExit = 'wake' | 'row' | 'seat'
export function stallExit(
  flow: { stalled: boolean; stalledCause: string | null; stalledAt: string | null },
  t: { id: string; owner: string; bound: (owner: string) => boolean },
): StallExit | null {
  if (!flow.stalled || !flow.stalledCause) return null
  if (flow.stalledAt !== t.id) return 'seat'
  if (t.owner !== '' && t.bound(t.owner) && flow.stalledCause !== 'owner-cannot-run' && flow.stalledCause !== 'unowned') return 'wake'
  return 'row'
}

// the one reading of «bound» for stallExit outside Task mode: the request's
// live facts say Task mode wakes this agent on its tasks
export const boundIn =
  (taskEnv: TaskEnv | undefined) =>
  (o: string): boolean =>
    taskEnv?.wakes(o) === 'task'
