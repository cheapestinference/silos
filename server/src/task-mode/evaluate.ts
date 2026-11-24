// task-mode/evaluate.ts — WHEN a task calls its owner. Adapted from
// Paperclip's doc/execution-semantics.md and its wake/rewake code
// (https://github.com/paperclipai/paperclip, MIT).
//
// Pure: the plans silo's tasks as snapshots, the agents bound to Task mode,
// the clock and what Silos saw last time → the wakes to make, the writes the
// events ask for (a next check, once it fired, is cleared) and what Silos
// saw this time. The owner's note that reopens a task is no event here: it
// reopens in the write of the note itself (silos/actions.ts appendItem, spec
// 2026-11-21 D17). Nothing here reads or
// writes a file; task-mode/engine.ts does, through the kernel's own verbs.
//
// The events, only for a task whose owner is BOUND (an unbound owner's task
// is not even looked at — zero behaviour change) and of the task's project
// (R3: an owner outside it — `ownerOutside` — is never moved; its task is
// forgotten like an unbound owner's, and reads owner-outside-project):
//   unblocked      every dependsOn is `done` (cancelled never resolves one),
//                  seen as a TRANSITION: the last look had one not done, with
//                  the same blockers. Key = the sorted blockers + the moment
//                  Silos first saw it blocked — one wake per ready state. A
//                  task its owner blocked over blockers already done (or whose
//                  blockers it rewrote) is a new baseline, never a wake at once.
//   children-done  every direct child (`parent`) done or cancelled — the
//                  transition again, key = the sorted children.
//   owner-note     a note by the owner Silos did not see at the last look —
//                  known by WHICH note it is (its moment and its text), never
//                  by a count: a note lost and another written between two
//                  looks still wakes («Dropped: …» is a disposition, not a
//                  message). Whether it reopened the task was decided in the
//                  note's own write (D17) — the wake only carries it. An
//                  agent's note never wakes. It skips the
//                  throttle. «By the owner» means Silos RECORDED the owner
//                  writing it (the engine marks every other note signed
//                  "owner" as an agent's before it gets here — owner-notes.ts).
//   next-check     nextCheckAt has passed: one shot — it wakes once per value
//                  and the engine clears the field (again at each look while
//                  the clear has not landed). One already past at the FIRST
//                  look fires once when it passed < CHECK_LATE_MS ago; older,
//                  it is cleared and said — never left in the file unseen.
//   stalled        (the stuck sweep) the task is the SEAT of a stall
//                  its owner can clear (task-flow.ts stallExit === 'wake':
//                  its own cause — in progress with
//                  nothing live, in review with no reviewer, blocked naming
//                  nothing — a dead link it declares (a cancelled or missing
//                  blocker), or a cycle it is a member of; never
//                  owner-cannot-run nor unowned, never a stall seated at
//                  another task: that one is its seat's). ONE wake per stall
//                  episode, key = cause + the moment Silos first saw it. The
//                  episode outlives a live turn (the wake's own turn makes the
//                  task live for a while) and an agent's note; it ends when
//                  the task's state, blockers (with their states — E10), wait
//                  or next check change, or the cause does. What follows a
//                  wake that changed nothing is the escalation's (escalation/).
//   assigned       never evaluated here: the owner's GESTURE —
//                  POST /api/tasks/assign → TaskModeEngine.assign — queues it
//                  (nothing wakes by inferring an assignment).
// Mentions are never read: they never wake and never assign.
//
// The first look at a task is a BASELINE — it records, it wakes nothing but
// a recent next check already due (like the silo journal's baseline); what Silos saw persists, so a
// transition that happened while Silos was down still wakes after a restart.

import { isSilosWait, SILOS_WAIT_PREFIX, stallExit } from '../silos/task-flow.js'
import { noteDigest } from './owner-notes.js'

// `answered`: another agent answered what this
// task's owner asked it through Silos (POST /api/tasks/ask/answer) — never
// evaluated here: the answer route queues it, under the day's ceiling
export type WakeReason = 'unblocked' | 'children-done' | 'owner-note' | 'next-check' | 'stalled' | 'assigned' | 'answered'

// readOutside: the note was written by an unattended run that read outside
// (S10-r5) — painted « — written after reading the web (<tool>)»
// `closes`: the owner wrote it with a verb that closed the task (approve,
// drop — owner-notes.ts OwnerSaid.closes): it reopens nothing, wakes nobody
export interface TaskNote {
  at: string
  by: string
  text: string
  readOutside?: string[]
  closes?: true
}

// one plan task as task mode reads it (task-mode/engine.ts builds it from
// the plans silo's reading)
export interface TaskSnap {
  key: string // the plans record key: `<plan key>/tasks/<id>`
  planKey: string
  planId: string
  id: string
  ref: string // plan#id
  title: string
  owner: string
  state: string
  dependsOn: string[]
  parent: string | null
  nextCheckAt: string | null
  waitingOn: boolean // it waits on someone (waitingOn with an owner)
  // that wait, as written — `asked` only when it asks something (B2: what
  // an ask's «linked» compares, task-flow.ts askLinked)
  waitingFor: { owner: string; action: string; asked?: string } | null
  // the kernel's stall of it (task-flow.ts), when the engine was given one:
  // its cause, the first stuck task down its chain and its seat (A2.5)
  stalledCause: string | null
  stalledBy: string | null
  stalledAt: string | null
  // the kernel's idle, waitsStart and live of it —
  // read, never derived again, by assign and the heartbeat's facts; absent
  // when the engine was given no flow
  idle?: boolean
  waitsStart?: boolean
  live?: boolean
  // Silos carries its wait on an agent — an ask linked
  // and in reach (flow.asked); absent when the engine was given no flow
  asked?: boolean
  notes: TaskNote[]
  conversations: string[] // every listed id — the history (the feed, the stall fingerprint)
  // plans 0.5.1 (R13): the releases[] marks as written, in order (absent:
  // none), and the listed ids still CURRENT — what the wakes, /talk, /work,
  // the door and the claim read (taskSnapshots' currentOf; without one, all)
  releases?: Array<{ session: string; released: boolean }>
  current: string[]
  file: string | null
  folder: string | null
  // (R3) its owner is an agent in play that does not work in this task's
  // project (project-scope.ts ownerOutside): Silos never moves it for that
  // agent — no wake, no packet line, no bearer verb. Absent: it does
  ownerOutside?: boolean
  // the `done` count of every SDD execution hung from this task —
  // absent: nobody asked the executions kind
  executionsDone?: number[]
  // the owner's notes Silos recorded on this task that the file no longer
  // holds (owner-notes.ts `lost`) — the engine says them on the task
  lostOwnerNotes?: Array<{ at: string; text: string }>
}

// what Silos saw of one task at its last look
export interface Observation {
  seenAt: string
  owner: string
  depsKey: string
  depsDone: boolean
  blockedSince: string | null
  kidsKey: string
  kidsDone: boolean
  // the owner's notes seen at this look, each by its identity (noteId)
  ownerSeen: string[]
  checkFired: string | null
  fired: string[] // dedup keys already fired (the last FIRED_KEEP)
  // the stall episode: its cause, when Silos first saw it, and the
  // task's visible shape then (stallShape) — a change of shape ends it
  stall?: { cause: string; since: string; shape: string } | null
}

export interface NewWake {
  agent: string
  task: string
  ref: string
  title: string
  reason: WakeReason
  says: string
  key: string // its dedup key
  notes: TaskNote[] // the owner's new notes it carries
  bypassThrottle: boolean
}

export interface Evaluation {
  observations: Record<string, Observation>
  wakes: NewWake[]
  clearCheck: string[] // task keys whose fired nextCheckAt is cleared
  // a nextCheckAt long past at the first look: cleared without a wake, said in a note
  staleCheck: Array<{ key: string; at: string }>
}

// a next check already past at the first look still fires when it passed
// less than this long ago; older, it is cleared and said
export const CHECK_LATE_MS = 24 * 3600_000

// a note signed "owner" in the file that Silos never recorded the owner
// writing (owner-notes.ts): the engine rewrites its `by` to this before
// anything reads it — an agent's note, said as such in a briefing
export const UNVERIFIED_OWNER = 'owner?'

export const FIRED_KEEP = 24
// a task Silos stopped seeing (its plan unreadable mid-write, the plan
// closed) keeps its observation this long, so a write that comes back does
// not re-baseline and lose a transition
export const OBSERVATION_KEEP_MS = 7 * 24 * 3600_000

const CLOSED = new Set(['done', 'cancelled'])
const isOpen = (s: string): boolean => !CLOSED.has(s)
// the owner's notes that speak to the task's agent: never one a closing verb
// wrote (`closes` — an approve is not undone by its own note, F8: a bound
// agent is not woken by it, it reads it on the task next time), and never a
// «Dropped:» one written outside the verb
export const ownerNotesOf = (t: Pick<TaskSnap, 'notes'>): TaskNote[] =>
  t.notes.filter((n) => n.by === 'owner' && n.closes !== true && !n.text.trimStart().startsWith('Dropped:'))
// a note's identity: its exact moment and its text (digested) — what Silos
// remembers of the owner's notes it saw (Observation.ownerSeen)
export const noteId = (n: Pick<TaskNote, 'at' | 'text'>): string => `${n.at}|${noteDigest(n.text).slice(0, 16)}`
// the notes of `notes` not among `seen` — counted, so a second note alike
// (same moment, same words) is a new one too
export function unseenNotes<N extends Pick<TaskNote, 'at' | 'text'>>(notes: readonly N[], seen: readonly string[]): N[] {
  const left = new Map<string, number>()
  for (const id of seen) left.set(id, (left.get(id) ?? 0) + 1)
  return notes.filter((n) => {
    const id = noteId(n)
    const k = left.get(id) ?? 0
    if (k > 0) {
      left.set(id, k - 1)
      return false
    }
    return true
  })
}

// Silos' own wait (silos/task-flow.ts, where the kernel reads it too)
export { isSilosWait, SILOS_WAIT_PREFIX }
const sortedKey = (ids: readonly string[]): string => [...new Set(ids)].sort().join(',')

// Task mode moves this task for its owner: the owner is bound AND of the
// task's project (R3 — an owner outside it is never woken on it, whatever
// the event). The ONE reading every wake path asks.
export function movesFor(t: Pick<TaskSnap, 'owner' | 'ownerOutside'>, bound: ReadonlySet<string>): boolean {
  return bound.has(t.owner) && t.ownerOutside !== true
}

// A stall Task mode wakes its (bound) owner for: the task is its own seat
// and the cause is one its owner can clear — task-flow.ts stallExit, the one
// reading (it replaced ownerCanClear, which woke for a
// cancelled blocker at any depth). `bound`: Task mode's bound agents.
export function wakesForStall(t: Pick<TaskSnap, 'id' | 'owner' | 'stalledCause' | 'stalledAt' | 'ownerOutside'>, bound: ReadonlySet<string>): boolean {
  if (t.ownerOutside === true) return false
  return (
    stallExit(
      { stalled: t.stalledCause !== null, stalledCause: t.stalledCause, stalledAt: t.stalledAt },
      { id: t.id, owner: t.owner, bound: (o) => bound.has(o) },
    ) === 'wake'
  )
}

// What ends a stall episode when it changes: the task's state, its blockers
// — with the state of each (E10: a chain cause that goes and comes back by
// another task's change opens a new episode; '?' for an id its plan lacks) —,
// its wait and its next check — never its notes (a comment is no
// disposition) nor its conversations (the wake's own turn adds one).
export function stallShape(
  t: Pick<TaskSnap, 'state' | 'dependsOn' | 'waitingFor' | 'nextCheckAt'>,
  stateOf: (id: string) => string | undefined = () => undefined,
): string {
  return JSON.stringify([
    t.state,
    [...new Set(t.dependsOn)].sort().map((d) => `${d}:${stateOf(d) ?? '?'}`),
    t.waitingFor ? [t.waitingFor.owner, t.waitingFor.action] : null,
    t.nextCheckAt,
  ])
}

// the words a `stalled` wake says, by cause (the seat's causes its owner can
// clear — A2.5); a cycle's names the other member (stallWords)
export const STALL_WORDS: Record<string, string> = {
  'in-progress-nothing-live': 'it is in progress and nothing is working it',
  'review-without-reviewer': 'it is in review with nobody reviewing it',
  'blocked-on-nothing': 'it is blocked and names nothing it waits on',
  'blocker-missing': 'it waits on a task its plan does not have',
  'blocker-cancelled': 'it waits on a cancelled task, which never resolves',
  'blocker-cycle': 'it and a task it depends on wait on each other',
}

// (E4) a member of a cycle is told the other: «it and <ref> wait on each
// other — <Owner> was told too; remove YOUR dependency only if it is the wrong
// one». <Owner>: the other member's owner when Task mode wakes it too, else
// the owner (its row in Needs you says it).
export function stallWords(
  t: Pick<TaskSnap, 'stalledCause' | 'stalledBy'>,
  other: Pick<TaskSnap, 'ref' | 'owner' | 'ownerOutside'> | undefined,
  bound: ReadonlySet<string>,
  nameOf: (id: string) => string,
): string {
  const cause = t.stalledCause ?? ''
  if (cause === 'blocker-cycle' && other) {
    const told = other.owner !== '' && movesFor(other, bound) ? nameOf(other.owner) : 'the owner'
    return `it and ${other.ref} wait on each other — ${told} was told too; remove YOUR dependency only if it is the wrong one`
  }
  return STALL_WORDS[cause] ?? cause
}

export function evaluateTaskWakes(input: {
  tasks: readonly TaskSnap[]
  bound: ReadonlySet<string>
  prev: Readonly<Record<string, Observation>>
  now: number
  // an agent's name as the house says it (a cycle's wake names the other's
  // owner); absent: its id
  nameOf?: (id: string) => string
}): Evaluation {
  const { tasks, bound, prev, now } = input
  const nameOf = input.nameOf ?? ((id: string): string => id)
  const iso = new Date(now).toISOString()
  const byPlan = new Map<string, Map<string, TaskSnap>>()
  for (const t of tasks) {
    const m = byPlan.get(t.planKey) ?? new Map<string, TaskSnap>()
    if (!m.has(t.id)) m.set(t.id, t)
    byPlan.set(t.planKey, m)
  }
  const out: Evaluation = { observations: {}, wakes: [], clearCheck: [], staleCheck: [] }
  const seen = new Set<string>()

  for (const t of tasks) {
    if (!movesFor(t, bound)) continue
    seen.add(t.key)
    const plan = byPlan.get(t.planKey)!
    const deps = [...new Set(t.dependsOn)]
    const depsKey = sortedKey(deps)
    const depsDone = deps.length > 0 && deps.every((d) => plan.get(d)?.state === 'done')
    const kids = [...plan.values()].filter((k) => k.parent === t.id && k.id !== t.id)
    const kidsKey = sortedKey(kids.map((k) => k.id))
    const kidsDone = kids.length > 0 && kids.every((k) => CLOSED.has(k.state))
    const ownerNotes = ownerNotesOf(t)
    const p = prev[t.key]
    // a new owner is a new task for task mode: baseline again
    const was = p && p.owner === t.owner ? p : null
    const blockedNow = isOpen(t.state) && deps.length > 0 && !depsDone
    const obs: Observation = {
      seenAt: iso,
      owner: t.owner,
      depsKey,
      depsDone,
      blockedSince: blockedNow ? (was && was.depsKey === depsKey && was.blockedSince ? was.blockedSince : iso) : (was?.blockedSince ?? null),
      kidsKey,
      kidsDone,
      ownerSeen: ownerNotes.map(noteId),
      checkFired: was?.checkFired ?? null,
      fired: [...(was?.fired ?? [])],
    }
    const fire = (reason: WakeReason, key: string, says: string, extra: { notes?: TaskNote[]; bypass?: boolean } = {}): void => {
      if (obs.fired.includes(key)) return
      obs.fired = [...obs.fired, key].slice(-FIRED_KEEP)
      out.wakes.push({
        agent: t.owner,
        task: t.key,
        ref: t.ref,
        title: t.title,
        reason,
        says,
        key,
        notes: extra.notes ?? [],
        bypassThrottle: extra.bypass === true,
      })
    }

    if (was) {
      // unblocked: the same blockers went from not-all-done to all done
      if (isOpen(t.state) && depsDone && !t.waitingOn && was.depsKey === depsKey && !was.depsDone) {
        fire('unblocked', `unblocked:${depsKey}@${was.blockedSince ?? '?'}`, `its blockers are done (${deps.join(', ')})`)
      }
      // children-done: the same children went from some open to all closed
      if (isOpen(t.state) && kidsDone && was.kidsKey === kidsKey && !was.kidsDone) {
        // closed counts cancelled too (grouping: nothing is left open under
        // it) — but a cancelled one is said as such, never as done
        const cut = kids.filter((k) => k.state === 'cancelled')
        fire(
          'children-done',
          `children-done:${kidsKey}`,
          cut.length === 0
            ? `its subtasks are done (${kids.map((k) => k.id).join(', ')})`
            : `its subtasks are closed (${kids.map((k) => `${k.id} ${k.state}`).join(', ')}) — ${cut.length === kids.length ? 'none' : 'not all'} of them done`,
        )
      }
      // owner-note: a note of the owner this look sees for the first time
      // (by identity — a count would miss one lost while another came)
      const fresh = unseenNotes(ownerNotes, was.ownerSeen ?? [])
      if (fresh.length > 0) {
        // keyed by the newest fresh note's identity: never a key fired before
        fire(
          'owner-note',
          `owner-note:${noteId(fresh[fresh.length - 1]!)}`,
          fresh.length === 1 ? 'a note from the owner' : `${fresh.length} notes from the owner`,
          { notes: fresh, bypass: true },
        )
      }
      // next-check: one shot per value, then cleared
      const at = t.nextCheckAt !== null ? Date.parse(t.nextCheckAt) : NaN
      if (isOpen(t.state) && !Number.isNaN(at) && at <= now && was.checkFired !== t.nextCheckAt) {
        obs.checkFired = t.nextCheckAt
        out.clearCheck.push(t.key)
        fire('next-check', `next-check:${t.nextCheckAt}`, 'its next check came')
      } else if (isOpen(t.state) && !Number.isNaN(at) && at <= now && was.checkFired === t.nextCheckAt) {
        // it fired and is still in the file: the clear did not land — again
        out.clearCheck.push(t.key)
      }
    } else if (t.nextCheckAt !== null && !Number.isNaN(Date.parse(t.nextCheckAt)) && Date.parse(t.nextCheckAt) <= now) {
      // a baseline over a check already past:
      // the file says something is scheduled, so it is never left there
      // silently — recent (CHECK_LATE_MS), it fires once like any check;
      // older, it is cleared and said (the engine writes a note)
      obs.checkFired = t.nextCheckAt
      if (isOpen(t.state)) {
        out.clearCheck.push(t.key)
        if (now - Date.parse(t.nextCheckAt) < CHECK_LATE_MS)
          fire('next-check', `next-check:${t.nextCheckAt}`, 'its next check came (it had passed when Silos first looked)')
        else out.staleCheck.push({ key: t.key, at: t.nextCheckAt })
      }
    }
    // the stall episode: kept while its cause holds, or while the
    // task's shape is unchanged (a live turn hides the stall, a note is no
    // disposition); ONE wake per episode — the second chance is the
    // escalation's, never another wake here
    const shape = stallShape(t, (id) => plan.get(id)?.state)
    const clearable = isOpen(t.state) && wakesForStall(t, bound)
    const prevStall = was?.stall ?? null
    let stall: Observation['stall'] = null
    if (clearable) stall = prevStall && prevStall.cause === t.stalledCause ? prevStall : { cause: t.stalledCause!, since: iso, shape }
    else if (prevStall && isOpen(t.state) && prevStall.shape === shape) stall = prevStall
    obs.stall = stall
    if (was && clearable && stall) {
      const other = t.stalledBy !== null ? plan.get(t.stalledBy) : undefined
      fire('stalled', `stalled:${stall.cause}@${stall.since}`, `it is stalled — ${stallWords(t, other, bound, nameOf)}; leave it with an explicit disposition`)
    }
    // an unblock fired leaves the blocked moment behind: the next block is a new state
    if (depsDone && obs.fired.some((k) => k.startsWith(`unblocked:${depsKey}@`))) obs.blockedSince = null
    out.observations[t.key] = obs
  }
  // what Silos no longer sees is kept a while (a plan mid-write comes back),
  // except a task whose owner is no longer bound (or no longer of its
  // project): leaving task mode forgets
  for (const [key, o] of Object.entries(prev)) {
    if (seen.has(key)) continue
    const stillThere = tasks.find((t) => t.key === key)
    if (stillThere) continue // its owner is unbound now: forgotten
    if (!bound.has(o.owner)) continue
    if (now - Date.parse(o.seenAt) < OBSERVATION_KEEP_MS) out.observations[key] = o
  }
  return out
}

// ── the no-progress throttle ──────────────────────────
//
// What «visible change» means: the task's own state, notes, blockers (with
// their states), children (with theirs), wait, next check and conversations,
// and the completed tasks of each SDD execution hung from it.
// A wake delivered over the SAME fingerprint as the previous wake counts a
// streak; from the 2nd consecutive one the next waits 2 min, doubling to 30.
export const THROTTLE_STREAK = 2
export const THROTTLE_BASE_MS = 2 * 60_000
export const THROTTLE_MAX_MS = 30 * 60_000

export function fingerprintOf(t: TaskSnap, siblings: readonly TaskSnap[]): string {
  const st = (id: string): string => siblings.find((s) => s.id === id)?.state ?? '?'
  const kids = siblings
    .filter((s) => s.parent === t.id)
    .map((k) => `${k.id}:${k.state}`)
    .sort()
  const base = [t.state, t.notes.length, [...t.dependsOn].sort().map((d) => `${d}:${st(d)}`), kids, t.waitingOn, t.nextCheckAt, t.conversations.length]
  // an execution's COMPLETED tasks are progress — never its fix
  // round nor its ledger's mtime, so a retry that completes nothing leaves the
  // fingerprint as it was and repeated retry wakes hit the backoff
  const withExec = t.executionsDone && t.executionsDone.length > 0 ? [...base, [...t.executionsDone].sort((a, b) => a - b)] : base
  // R13: a release or a revive is visible change — appended LAST and
  // labelled, and only when the task has any: a task without releases keeps
  // its fingerprint byte for byte (no streak restarts on deploy)
  return JSON.stringify(
    t.releases && t.releases.length > 0 ? [...withExec, ['releases', t.releases.map((r) => `${r.session}:${r.released ? 'released' : 'current'}`)]] : withExec,
  )
}

export interface ThrottleState {
  lastFp: string | null
  streak: number
  lastAt: string | null
}

// The streak a delivery over `fp` makes, and — when it is held — until when.
export function throttle(state: ThrottleState, fp: string, now: number): { streak: number; until: number | null } {
  const streak = state.lastFp !== null && state.lastFp === fp ? state.streak + 1 : 0
  if (streak < THROTTLE_STREAK || state.lastAt === null) return { streak, until: null }
  const wait = Math.min(THROTTLE_BASE_MS * 2 ** (streak - THROTTLE_STREAK), THROTTLE_MAX_MS)
  const until = Date.parse(state.lastAt) + wait
  return { streak, until: until > now ? until : null }
}
