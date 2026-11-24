// task-mode/engine.ts — Task mode, running. The glue
// between the plans silo's reading, the pure evaluation (evaluate.ts), what
// Silos remembers (store.ts) and the turn machinery the resident already has
// (no new scheduler: it runs on the `plans` event and on the resident's
// 30 s tick).
//
//   look(now)     the bound agents' tasks → evaluate → new wakes queued; the
//                 writes the events ask for go through the plans silo's own
//                 verbs (set-field nextCheckAt → cleared once it fired — an
//                 owner's note reopens its task in the note's OWN write,
//                 silos/actions.ts appendItem: Task
//                 mode no longer writes a reopen); an owner's note the file lost is said on
//                 its task — then deliver().
//   deliver(now)  every queued wake, grouped by (agent, task): superseded when
//                 the task moved on (closed, another owner, its agent out of
//                 task mode); HELD — never injected mid-turn — while its
//                 conversation has a turn running, a console holds it, or the
//                 throttle / the day's ceiling say wait; otherwise ONE
//                 headless turn on the (agent, task) conversation (resume,
//                 append) or a new one whose id joins the task's
//                 conversations[].
//   work(key)     the task's door, console side: the scoped briefing for the
//                 console the owner opens (any agent owner), with the wakes
//                 that were waiting folded in.
//   assign(key)   the owner's GESTURE «wake X on it»: one
//                 `assigned` wake through the same pipe (queued → deliver:
//                 held, the day's ceiling, one task per wake) — never a
//                 second one while a wake is on its way.
//
// Only agents BOUND to the Task mode silo (operator producers of an active
// task-mode silo, in play) are ever looked at: everyone else's tasks are not
// observed, not woken, not written — zero change.
import type { SiloReading } from '../silos/reader.js'
import { recordKey } from '../silos/journal.js'
import {
  evaluateTaskWakes,
  fingerprintOf,
  noteId,
  OBSERVATION_KEEP_MS,
  ownerNotesOf,
  wakesForStall,
  throttle,
  UNVERIFIED_OWNER,
  type NewWake,
  type Observation,
  type TaskNote,
  type TaskSnap,
} from './evaluate.js'
import type { OwnerNoteCheck } from './owner-notes.js'
import { SILOS_AUTHOR } from '../system-author.js'
import { workBriefing, wakeBriefing } from './briefing.js'
import { releasesOf } from '../task-threads.js'
import { blockedReadsPending } from '../silos/task-flow.js'
import { taskRefOf } from '../silos/task-ref.js'
import type { HoldClass, TaskModeStore, Wake } from './store.js'
import { ENGINE_RETRY_MS } from '../harness-run.js'
import { OWN_TURNS_LIVE } from '../limits.js'
import { heldWords, type TurnSlots } from '../turn-slots.js'
import { ownCapHold, type OwnCapHit, type OwnTurnsToday, type WakesToday } from '../own-turns.js'
import type { TurnDeclaration } from '../live-turns.js'
import { TRANSCRIPT_UNREADABLE, type RunAudit } from '../heartbeat-audit.js'
import { endPass } from '../pass.js'

export const TASK_MODE_SILO = 'task-mode'
// a queued wake whose task Silos does not find:
// kept this long when its plan is simply not there (a rename mid-write, a
// move) and OBSERVATION_KEEP_MS when its plan file is there but unreadable —
// then superseded, said; never dropped at the first look that misses it
export const MISSING_KEEP_MS = 10 * 60_000
// (finding 1) a turn that never started: back in the queue, retried after
// this (doubling per attempt, at most an hour); a usage limit whose reset
// nobody said waits LIMIT_RETRY_MS
export const START_RETRY_BASE_MS = 60_000
export const START_RETRY_MAX_MS = 3600_000
export const LIMIT_RETRY_MS = 15 * 60_000
// a wake whose turn could not start this many
// times in a row GIVES UP waiting quietly: it stays queued (retried at the
// backoff's ceiling — a fixed cause delivers it on its own) and its task
// becomes a subject of the escalation (cannotStart) — the chain, then the
// owner's Needs you, once. A refused engine or a usage limit never counts:
// the engineCompat row and the limit hold say those.
export const START_ATTEMPTS_MAX = 5
// the head of the hold an engine refusal leaves on a wake — the live line's
// «couldn't start» reads it to offer the engine's door (liveOf)
export const ENGINE_HOLD = "its engine can't run"
// «it goes at 14:00» — the machine's clock (times follow
// this machine), the words of the account refusal
const hhmmLocal = (iso: string): string => {
  const d = new Date(iso)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
// what busyWhy says of a conversation an open console holds (index.ts) — the
// live line's «Your console is on it · Open ›» (liveOf)
export const CONSOLE_BUSY = 'a console has its conversation open'
// …and of one whose console probe FAILED (tmux did not answer): it may be
// open — held all the same (consoleState: unknown is never gone), but never
// said «open and idle»: the hold carries no holdSession
export const CONSOLE_UNSURE = 'a console may have its conversation open (tmux did not answer)'
export const isConsoleBusy = (why: string | null): boolean => why === CONSOLE_BUSY || why === CONSOLE_UNSURE
// (A2.9) the words of an engine hold kept over an engine Silos could not read
export const ENGINE_UNREAD = "Silos couldn't read its engine"
const startRetryMs = (attempts: number): number => Math.min(START_RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1), START_RETRY_MAX_MS)

// How a task turn ended, as the resident's turn machinery says it
// (resident/task-turns.ts openTaskTurn). `started`: it produced something (the
// moment it is charged); false with `limitedUntil` — the account was at its
// usage limit; false with `error` — it failed before doing anything.
// `refused`: the engine's compat gate refused it (outdated, missing).
export interface TaskTurnEnd {
  costUsd?: number | null
  model?: string
  priced?: boolean
  started?: boolean
  limitedUntil?: string | null
  error?: string
  refused?: string
}

type Json = Record<string, unknown>
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)
const isStr = (v: unknown): v is string => typeof v === 'string'
const CLOSED = new Set(['done', 'cancelled'])

export interface TaskModeDeps {
  store: TaskModeStore
  // the end of a wake turn's audit: its creations,
  // proposals and messages re-stamped with readOutside; the owner's
  // credential used cuts (initiative.ts afterAudit). The wake's run is its turn id.
  afterAudit?: (agentId: string, turnId: string, audit: RunAudit) => void
  // the readOutside of a note by its run's mark (plans-origins.ts), or null
  noteReadOutside?: (key: string, note: TaskNote) => string[] | null
  // the plans silo's reading — null while it is not active
  // standing: the plan ids the manifest reserves (ensure-record — plans: the
  // project's list); its tasks' ref is the one the screen shows, `<project>#t3`
  plans(): { reading: SiloReading; standing?: ReadonlySet<string> } | null
  // the kernel's flow of the plan tasks, by task key (task-flow.ts via
  // voice.taskFlowRecords, the live facts at `now`): its stall (cause null:
  // none) — absent, the stuck sweep sees no stall and never wakes for one —
  // and idle, waitsStart and live, which the snapshots
  // carry for their readers; a task the map leaves out carries none of them
  stalled?(now: number): ReadonlyMap<string, TaskFlowSnap>
  // the agents bound to Task mode, in play (empty: the silo is not active)
  bound(): ReadonlySet<string>
  // the session index is warm: before it, conversationOf() can't see the
  // task's conversations — a wake sent then would open a NEW conversation,
  // split the task's history and walk past a console holding the old one.
  // Nothing is sent until it is (wakes stay queued; the supersede pass runs).
  ready(): boolean
  // the plans silo's verbs, as Silos acting on the owner's gesture
  setField(key: string, field: string, value: unknown): { ok: boolean; reason?: string }
  appendConversation(key: string, sessionId: string): { ok: boolean; reason?: string }
  // the (agent, task) conversation: the newest member of the THREAD these
  // listed ids name that `agent` owns — its tip after a /clear or a
  // keep-thread rotation (task-threads.ts taskThreads.tipOf)
  conversationOf(agent: string, sessionIds: readonly string[]): { sessionId: string; folder: string } | null
  // the sessions whose busy holds `agent`'s wake on this task: its members
  // of the thread, plus listed ids not indexed yet (a console opened by
  // «Work on this» is listed before the index knows it) — never another
  // agent's conversation (task-threads.ts taskThreads.holdersOf)
  holdersOf(agent: string, sessionIds: readonly string[]): readonly string[]
  // why a conversation can't take a turn now (a turn runs on it, a console
  // holds it) — null when it can. Asked of every holder
  busyWhy(sessionId: string): string | null
  // one headless turn of `agent` (the resident's chat machinery, unattended);
  // `done` may settle with what the turn cost, as its engine priced it
  // `onStarted` hears the turn's first output (the moment it is charged)
  // `origin` (a wake turn): the task it works — its new conversation's birth
  // `turn`: the class its token carries (live-turns.ts) — a task's turn is a wake
  send(input: {
    agentId: string
    text: string
    resume: string | null
    onSession(sessionId: string): void
    onStarted?(): void
    onAudit?(audit: RunAudit, at: { sessionId: string }): void
    origin?: { task: string; ref: string }
    turn: TurnDeclaration
  }): { turnId: string; done: Promise<void | TaskTurnEnd> }
  // which of a task's notes
  // signed "owner" Silos recorded the OWNER writing, one event per note, and
  // which recorded ones the file lost (owner-notes.ts). Asked once per
  // reading; a note signed "owner" it did not record is an agent's. Absent:
  // every note signed "owner" is the owner's, and none is ever lost
  ownerNotes?(): OwnerNoteCheck
  // (finding 1) until when the agent's account sits at its usage limit (ISO)
  // — null/absent: it does not. A wake waits for the reset, uncharged
  limitedUntil?(agentId: string): string | null
  // why the agent's engine refuses its turns
  // right now (harness.ts peekRefusal), or null — a wake waits for the
  // engine, uncharged, no attempt counted, and goes once it reads ok
  engineRefusal?(agentId: string): string | null
  // (finding 4) a note by Silos on a task (a next check cleared unseen)
  appendNote?(key: string, text: string): { ok: boolean; reason?: string }
  // what holds a wake that is NOT an owner's gesture from starting now:
  // the agent's day on its own — its ceiling (R7) or its
  // spend cap — said with its count; null: nothing. Absent: nothing holds.
  ownToday?(agentId: string, now: number): OwnTurnsToday
  // the live caps shared with the resident's runs (turn-slots.ts): absent,
  // OWN_TURNS_LIVE per agent is checked here alone
  slots?: TurnSlots
  nameOf?(agentId: string): string
  // the done counts of the SDD executions hung from each task (silos/executions.ts
  // doneByTask); absent: none
  executionsDone?(): ReadonlyMap<string, number[]>
  // the CURRENT conversations of a task (R13 — task-threads.ts
  // currentConversationIdsOf over the thread reading): absent, every listed
  // id is current
  currentOf?(listed: string[], releases: unknown): string[]
  // the turn an `answered` wake's answer came from
  // (an unattended one): whether it still runs, and the readOutside its audit
  // registered — null while no audit is there. Absent: never live, never
  // audited (the wake goes marked «transcript unreadable» after MISSING_KEEP_MS)
  answeredTurn?: { live(agentId: string, run: string): boolean; readOutside(agentId: string, run: string): string[] | null }
  // SILOS_NO_TASK_WAKE_DELIVERY=1 (the e2e harness): evaluate and keep the
  // history, never send a turn
  deliveryOff?: boolean
  now?: () => number
}

export function localDay(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
function nextMidnight(ms: number): number {
  const d = new Date(ms)
  d.setHours(24, 0, 0, 0)
  return d.getTime()
}

// After a `stalled` wake was delivered and its turn ended, how long Silos
// waits before reading «nothing changed» — one tick of the resident.
export const RETRY_GRACE_MS = 60_000

// An owner's note the file does not hold is said lost only once it is this
// old: the plans reading may lag a moment behind the log (the event is
// written right after the file).
export const LOST_NOTE_GRACE_MS = 2 * 60_000
// the words Silos says a lost owner note with — `at` exact, so the note on
// the task is its own record that it was said (nothing else remembers it)
export const lostNoteMark = (at: string): string => `The owner's note of ${at} `
export const lostNoteWords = (n: { at: string; text: string }): string =>
  `${lostNoteMark(n.at)}is no longer in this task's notes — a write replaced the plan file without it. It said: «${n.text}». Owner: write it again if it still stands.`

// The plans silo's reading → the tasks as task mode reads them (with the
// kernel's stall of each, when given).
// what the kernel's flow says of one task (voice.ts TaskFlowFacts; a stall
// alone is enough — the other facts are absent then)
export type TaskFlowSnap = { cause: string | null; by: string | null; at: string | null; idle?: boolean; waitsStart?: boolean; live?: boolean; asked?: boolean }

export function taskSnapshots(
  reading: SiloReading,
  stalled?: ReadonlyMap<string, TaskFlowSnap>,
  currentOf?: (listed: string[], releases: unknown) => string[],
  standing?: ReadonlySet<string>,
): TaskSnap[] {
  const out: TaskSnap[] = []
  // the ref people and agents say: `<plan>#t3`; a task of the project's own
  // list reads as the screen paints it, `<project>#t3` (views.ts
  // taskLabelOf — `<project>/<id>#t3` when a plan is named like the project)
  const plansIn = new Map<string, Set<string>>()
  for (const r of reading.records)
    if (r.kind === 'plan') {
      const s = plansIn.get(r.location) ?? new Set<string>()
      s.add(String(r.record.id))
      plansIn.set(r.location, s)
    }
  const refOf = (planId: string, location: string, folder: string | null, id: string): string =>
    taskRefOf({ parentId: planId, id, place: folder, standing: standing?.has(planId) === true, idsHere: () => plansIn.get(location) ?? [] })
  for (const r of reading.records) {
    if (r.kind !== 'plan') continue
    const planKey = recordKey(r)
    const planId = String(r.record.id)
    const folder = r.location.startsWith('folder:') ? r.location.slice('folder:'.length) : null
    for (const t of (Array.isArray(r.record.tasks) ? r.record.tasks : []).filter(isObj)) {
      if (!isStr(t.id) || t.id === '') continue
      const notes: TaskNote[] = (Array.isArray(t.notes) ? t.notes : [])
        .filter(isObj)
        .map((n) => ({ at: isStr(n.at) ? n.at : '', by: isStr(n.by) ? n.by : isStr(n.updatedBy) ? n.updatedBy : '', text: isStr(n.text) ? n.text : '' }))
      const conversations = (Array.isArray(t.conversations) ? t.conversations : [])
        .map((c) => (isObj(c) ? (c.session ?? c.id) : c))
        .filter((c): c is string => isStr(c) && c !== '')
      const key = `${planKey}/tasks/${t.id}`
      const st = stalled?.get(key) ?? null
      const releases = releasesOf(t.releases)
      let current = conversations
      try {
        if (currentOf) current = currentOf(conversations, t.releases)
      } catch {
        current = conversations
      }
      out.push({
        key,
        planKey,
        planId,
        id: t.id,
        ref: refOf(planId, r.location, folder, t.id),
        title: isStr(t.title) ? t.title : t.id,
        owner: isStr(t.owner) ? t.owner.trim() : '',
        state: isStr(t.state) ? t.state : isStr(t.status) ? t.status : '',
        dependsOn: (Array.isArray(t.dependsOn) ? t.dependsOn : []).filter(isStr),
        parent: isStr(t.parent) && t.parent !== '' ? t.parent : null,
        nextCheckAt: isStr(t.nextCheckAt) && t.nextCheckAt !== '' ? t.nextCheckAt : null,
        waitingOn: isObj(t.waitingOn) && isStr(t.waitingOn.owner) && t.waitingOn.owner.trim() !== '',
        waitingFor:
          isObj(t.waitingOn) && isStr(t.waitingOn.owner) && t.waitingOn.owner.trim() !== ''
            ? {
                owner: t.waitingOn.owner.trim(),
                action: isStr(t.waitingOn.action) ? t.waitingOn.action : '',
                ...(isStr(t.waitingOn.asked) && t.waitingOn.asked.trim() !== '' ? { asked: t.waitingOn.asked } : {}),
              }
            : null,
        stalledCause: st?.cause ?? null,
        stalledBy: st?.cause ? (st.by ?? null) : null,
        stalledAt: st?.cause ? st.at : null,
        ...(st?.idle !== undefined ? { idle: st.idle } : {}),
        ...(st?.waitsStart !== undefined ? { waitsStart: st.waitsStart } : {}),
        ...(st?.live !== undefined ? { live: st.live } : {}),
        ...(st?.asked !== undefined ? { asked: st.asked } : {}),
        notes,
        conversations,
        ...(releases.length > 0 ? { releases } : {}),
        current,
        file: r.file || null,
        folder,
      })
    }
  }
  return out
}

// the tasks a plan file holds that the reader could
// not build — each left out of its plan's tasks with a remark «tasks[i] is
// not read: <why>» (reader.ts buildChildren) — per plan, with the id the
// file gives it (null when its entry names none) and the reader's own why.
// Read, never repaired: the reader keeps deciding what it accepts.
export interface UnreadablePlanTasks {
  key: string
  id: string
  title: string
  folder: string | null
  file: string
  tasks: Array<{ id: string | null; reason: string }>
}
const NOT_READ = /^tasks\[(\d+)\] is not read: (.*)$/s
export function unreadableTasksOf(reading: SiloReading): UnreadablePlanTasks[] {
  const out: UnreadablePlanTasks[] = []
  for (const r of reading.records) {
    if (r.kind !== 'plan') continue
    const raw = isObj(r.raw) && Array.isArray(r.raw.tasks) ? r.raw.tasks : []
    const tasks: Array<{ id: string | null; reason: string }> = []
    for (const m of r.remarks) {
      const hit = NOT_READ.exec(m)
      if (!hit) continue
      const item = raw[Number(hit[1])]
      tasks.push({ id: isObj(item) && isStr(item.id) && item.id !== '' ? item.id : null, reason: hit[2]! })
    }
    if (tasks.length === 0) continue
    out.push({
      key: recordKey(r),
      id: String(r.record.id),
      title: isStr(r.record.title) ? r.record.title : String(r.record.id),
      folder: r.location.startsWith('folder:') ? r.location.slice('folder:'.length) : null,
      file: r.file,
      tasks,
    })
  }
  return out
}

// A snapshot's state as every reader reads it
// (silos/task-flow.ts blockedReadsPending, the one rule): a blocked task that
// declares dependencies, all done, with no wait and no next check ahead, is
// pending. `tasks`: the snapshots of its plan (any others are ignored).
export function snapStateRead(
  t: Pick<TaskSnap, 'state' | 'planKey' | 'dependsOn' | 'waitingFor' | 'nextCheckAt'>,
  tasks: readonly TaskSnap[],
  now: number,
): string {
  if (t.state !== 'blocked') return t.state
  const stateOf = (id: string): string | undefined => tasks.find((x) => x.planKey === t.planKey && x.id === id)?.state
  return blockedReadsPending({ state: t.state, deps: t.dependsOn, stateOf, wait: t.waitingFor, nextCheckAt: t.nextCheckAt, now }) ? 'pending' : t.state
}

export interface TaskModeView {
  bound: boolean
  owner: string
  history: Array<Pick<Wake, 'id' | 'reason' | 'says' | 'at' | 'state' | 'deliveredAt' | 'session' | 'held' | 'until' | 'via'>>
  // what would hold a wake RIGHT NOW (a live turn, an open console) — said
  // BEFORE the owner sends, beside the note box, not only in the wake panel
  // after (the box promised «a note here wakes it»
  // while a forgotten console held everything)
  heldNow: string | null
  // the live line's facts: what is
  // happening to a start on this task RIGHT NOW (liveOf) — null when nothing is
  live: TaskLive | null
}

// What the task's live line paints (the web's give.ts liveLine says the
// words; TaskLive.tsx adds what the WS stream knows of a running turn):
//   running   turns of the task in flight — `started`: a wake turn produced
//             output (it is charged then); a chat turn says nothing here —
//             the stream does
//   queued    held by a live cap: the agent's own (OWN_TURNS_LIVE) or the
//             fleet's (UNATTENDED_TURNS_LIVE_GLOBAL) — with how many run there
//   failed    its turn did not start: back in the queue, retried — the hold
//             in its words (an engine refused, the account at its limit, an error)
//   held      queued for another reason (a turn or a console on its
//             conversation, the throttle, the day's ceiling) — its words
//   starting  queued, nothing holds it: it goes at the next pass
export type TaskLive =
  | { kind: 'running'; turns: Array<{ turnId: string; sessionId: string | null; started: boolean; agent: string }> }
  | { kind: 'queued'; cap: 'agent' | 'global'; running: number }
  | { kind: 'failed'; why: string; engine?: true }
  | { kind: 'held'; why: string }
  | { kind: 'starting' }
  // nothing of Silos' runs: an open console holds the task's conversation —
  // yours, so no Stop
  | { kind: 'console'; sessionId: string }

// GET /api/task-mode/today — one agent's task wakes today (TaskModeEngine.today)
export interface TaskWakesToday {
  agent: string
  day: string // local YYYY-MM-DD
  woke: number // wakes delivered by a wake turn today (the ceiling's count)
  costUsd: number | null // summed over the turns whose engine priced them; null: none did
  unpriced: number // turns that ended without a price
  running: number // turns still going
  ceiling: number // the agent's ownTurnsPerDay (default OWN_TURNS_PER_DAY)
  heldByCeiling: number // wakes the ceiling holds now
  // the agent's whole day ON ITS OWN (own-turns.ts): wakes + heartbeats +
  // its own recurring work — «Started N times today · max C»
  started?: number
  spentUsd?: number
  spendCap?: number
  exempt?: boolean
}

export class TaskModeEngine {
  private now: () => number
  // task turns in flight: turnId → whose, for which task
  // `charged`: false for a wake turn not charged yet (the ceiling counts it
  // as spent until it says otherwise); talk turns carry none
  private live = new Map<string, { agent: string; task: string; sessionId: string | null; charged?: boolean; gesture?: boolean }>()
  // the plan keys unreadable at the last reading, with why
  private unreadable = new Map<string, string>()
  // wake ids being handed to a turn right now (inside start(), before its
  // turn id is known) — never orphans
  private handing = new Set<string>()
  private looking = false

  constructor(private d: TaskModeDeps) {
    this.now = d.now ?? Date.now
  }

  get store(): TaskModeStore {
    return this.d.store
  }

  isBound(agentId: string): boolean {
    return this.d.bound().has(agentId)
  }
  // the wakes still queued, as the store keeps them — Needs you's idle-console
  // row reads their hold (A2.8), never asks a console itself
  queuedWakes(): readonly Wake[] {
    return this.d.store.queued()
  }
  boundAgents(): ReadonlySet<string> {
    return this.d.bound()
  }

  private snapshots(now = this.now()): TaskSnap[] {
    const p = this.d.plans()
    if (!p) return []
    const snaps = taskSnapshots(p.reading, this.d.stalled?.(now), this.d.currentOf ? (l, r) => this.d.currentOf!(l, r) : undefined, p.standing)
    this.unreadable = new Map((p.reading.unreadable ?? []).filter((u) => u.kind === 'plan' && u.id).map((u) => [`${u.location}/${u.id}`, u.reason]))
    // a note signed "owner" that Silos never recorded the owner writing is
    // an agent's: it wakes nobody, reopens nothing, skips nothing. The same
    // matching says which of the owner's recorded notes the file lost
    const check = this.ownerNoteCheck()
    for (const t of snaps) {
      const signed = t.notes.filter((n) => n.by === 'owner')
      const m = check(t.key, signed)
      if (m.lost.length > 0) t.lostOwnerNotes = m.lost.map(({ at, text }) => ({ at, text }))
      if (signed.length === 0) continue
      let i = 0
      // a note the owner wrote with a verb that CLOSES the task (approve,
      // drop) is sealed `closes`: ownerNotesOf leaves it out (C14a/F8)
      t.notes = t.notes.map((n) => {
        if (n.by !== 'owner') return n
        const j = i++
        return m.fromOwner[j] === true ? (m.closes[j] === true ? { ...n, closes: true as const } : n) : { ...n, by: UNVERIFIED_OWNER }
      })
    }
    let done: ReadonlyMap<string, number[]> | undefined
    try {
      done = this.d.executionsDone?.()
    } catch {
      done = undefined
    }
    if (done && done.size > 0)
      for (const t of snaps) {
        const d = done.get(t.key)
        if (d) t.executionsDone = d
      }
    // a note an unattended run left after reading outside carries its mark (S10-r5)
    if (this.d.noteReadOutside)
      for (const t of snaps)
        t.notes = t.notes.map((n) => {
          const r = this.d.noteReadOutside!(t.key, n)
          return r ? { ...n, readOutside: r } : n
        })
    return snaps
  }

  // THE check of which notes signed "owner" are the owner's (owner-notes.ts):
  // task mode's snapshots read it, and so does every screen that paints a
  // note's author (silos/views.ts withNoteProvenance → `fromOwner`). Without
  // a ledger every note signed "owner" is the owner's; a ledger that can't be
  // read vouches for none.
  ownerNoteCheck(): OwnerNoteCheck {
    if (!this.d.ownerNotes) return (_k, notes) => ({ fromOwner: notes.map(() => true), closes: notes.map(() => false), lost: [] })
    try {
      return this.d.ownerNotes()
    } catch {
      return (_k, notes) => ({ fromOwner: notes.map(() => false), closes: notes.map(() => false), lost: [] })
    }
  }

  // the tasks as task mode reads them, stalls included — what the
  // escalation engine reads (it never re-derives a task)
  tasks(now = this.now()): TaskSnap[] {
    return this.snapshots(now)
  }

  // (A1.8) the tasks the plans' files hold that the reader could not build
  unreadableTasks(): UnreadablePlanTasks[] {
    const p = this.d.plans()
    return p ? unreadableTasksOf(p.reading) : []
  }

  // The stalls whose ONE wake changed nothing (D5): the task of a bound
  // agent is still stalled with the cause of the episode the wake was for,
  // the wake was delivered, its turn is over, and a tick has passed since.
  // What escalation/engine.ts opens a case on. Recomputed at each call.
  retryFailed(now = this.now(), tasks = this.snapshots(now)): Array<{ task: TaskSnap; cause: string; since: string; wokeAt: string }> {
    const bound = this.d.bound()
    const obs = this.d.store.observations()
    const out: Array<{ task: TaskSnap; cause: string; since: string; wokeAt: string }> = []
    for (const t of tasks) {
      if (!bound.has(t.owner) || CLOSED.has(t.state)) continue
      const st = obs[t.key]?.stall
      if (!st || t.stalledCause !== st.cause || !wakesForStall(t, bound)) continue
      const key = `stalled:${st.cause}@${st.since}`
      const wake = this.d.store.wakesOf(t.key).find((w) => w.key === key)
      // only a wake whose turn really STARTED changed nothing (finding 1): a
      // turn the account's limit refused is back in the queue, not here
      if (!wake || wake.state !== 'delivered' || !wake.deliveredAt || wake.starting) continue
      if ([...this.live.values()].some((l) => l.task === t.key)) continue
      if (now - Date.parse(wake.deliveredAt) < RETRY_GRACE_MS) continue
      out.push({ task: t, cause: st.cause, since: st.since, wokeAt: wake.deliveredAt })
    }
    return out
  }

  // ── the look ──
  look(now = this.now()): void {
    if (this.looking) return // a write below re-enters through the plans event
    this.looking = true
    try {
      const bound = this.d.bound()
      const tasks = this.snapshots(now)
      // the owner's lost notes are said for every task, task mode or not
      this.sayLostOwnerNotes(tasks, now)
      // nobody bound and nothing remembered: task mode is off, nothing to do
      if (bound.size === 0 && Object.keys(this.d.store.observations()).length === 0 && this.d.store.queued().length === 0) return
      const ev = evaluateTaskWakes({ tasks, bound, prev: this.d.store.observations(), now, ...(this.d.nameOf ? { nameOf: this.d.nameOf } : {}) })
      const iso = new Date(now).toISOString()
      this.d.store.update((s) => {
        // seenAt moves at every look: it alone is no change worth a write
        // (state.json + the kernel's refresh every 30 s otherwise) — kept in
        // memory, written with the next real change or once it is stale
        const changed = ev.wakes.length > 0 || observationsDiffer(s.observations, ev.observations, now)
        s.observations = ev.observations
        for (const w of ev.wakes) s.wakes.push(this.queuedWake(w, iso))
        return changed
      }, now)
      for (const key of ev.clearCheck) this.d.setField(key, 'nextCheckAt', null)
      for (const c of ev.staleCheck)
        this.d.appendNote?.(
          c.key,
          `nextCheckAt ${c.at} had passed long before Silos first looked at this task — cleared without a wake. Set a new one if it still needs a check.`,
        )
    } finally {
      this.looking = false
    }
    this.deliver(now)
  }

  // The owner's notes Silos recorded on a task that its file no longer holds
  // (an agent's write from an old copy replaced it): said ONCE
  // on the task, by Silos, with the words the log kept — the note itself is
  // the record that it was said (lostNoteMark carries the exact moment). For
  // EVERY task, bound owner or not: the owner believes they answered.
  private sayLostOwnerNotes(tasks: readonly TaskSnap[], now: number): void {
    if (!this.d.appendNote) return
    for (const t of tasks) {
      for (const n of t.lostOwnerNotes ?? []) {
        const at = Date.parse(n.at)
        if (Number.isNaN(at) || now - at < LOST_NOTE_GRACE_MS) continue
        if (t.notes.some((x) => x.by === SILOS_AUTHOR && x.text.startsWith(lostNoteMark(n.at)))) continue
        this.d.appendNote(t.key, lostNoteWords(n))
      }
    }
  }

  // An owner's note is the owner's gesture (R1: Write wakes `own`, past the
  // throttle and the ceiling); `assigned` is one only when the owner assigned
  private queuedWake(w: NewWake, at: string, gesture = w.reason === 'owner-note'): Wake {
    return {
      id: this.d.store.nextId(w.agent, w.ref, w.reason),
      agent: w.agent,
      task: w.task,
      ref: w.ref,
      title: w.title,
      reason: w.reason,
      says: w.says,
      at,
      state: 'queued',
      notes: w.notes,
      bypassThrottle: w.bypassThrottle,
      key: w.key,
      ...(gesture ? { gesture: true } : {}),
    }
  }

  /** The flip to Only when told: every queued wake of the
   *  agent is superseded at once — a wake held until midnight never fires
   *  hours later against R2. Returns how many. */
  supersedeAgent(agentId: string, why: string, now = this.now()): number {
    let n = 0
    this.d.store.update((s) => {
      for (const w of s.wakes) {
        if (w.agent !== agentId || w.state !== 'queued') continue
        w.state = 'superseded'
        w.held = why
        delete w.holdClass
        delete w.until
        n++
        this.d.slots?.forget(`wake:${w.agent}|${w.task}`)
      }
      return n > 0
    }, now)
    return n
  }

  /** Undo and a reverted owner steal: every queued wake
   *  of the task is superseded now, and the ids of its live turns come back
   *  for the caller to cancel (chat.cancel). `keep`: an
   *  agent whose wakes and turns are left alone — the owner Silos restored. */
  stopTask(key: string, why: string, opts: { keep?: string } = {}, now = this.now()): string[] {
    const keep = opts.keep !== undefined && opts.keep !== '' ? opts.keep : null
    this.d.store.update((s) => {
      let n = 0
      for (const w of s.wakes) {
        if (w.task !== key || w.state !== 'queued' || w.agent === keep) continue
        w.state = 'superseded'
        w.held = why
        delete w.holdClass
        delete w.until
        n++
        this.d.slots?.forget(`wake:${w.agent}|${w.task}`)
      }
      return n > 0
    }, now)
    return [...this.live.entries()].filter(([, l]) => l.task === key && l.agent !== keep).map(([turnId]) => turnId)
  }

  /** The agent's wake turns running now (the «Only when told» sheet's
   *  «Running now: <task> — Let it finish · Stop»). */
  liveTurnsOf(agentId: string): Array<{ turnId: string; what: string }> {
    const tasks = new Map(this.snapshots().map((t) => [t.key, t]))
    return [...this.live.entries()].filter(([, l]) => l.agent === agentId).map(([turnId, l]) => ({ turnId, what: tasks.get(l.task)?.title ?? l.task }))
  }

  /** Whether a live wake turn is an owner's gesture (Usage's window)
   *  — undefined: not a wake turn of this engine. */
  gestureOfTurn(turnId: string): boolean | undefined {
    const l = this.live.get(turnId)
    return l ? l.gesture === true : undefined
  }

  /** «One money»: a wake turn that ended without
   *  saying its price gets the one its transcript says, on the wakes it
   *  delivered — never over a price its engine said. 'later' while the turn
   *  still runs here (its end writes first). */
  costFromTranscript(turnId: string, cost: { costUsd: number; model?: string; priced: boolean }): 'done' | 'later' | 'skip' {
    if (this.live.has(turnId)) return 'later'
    const mine = this.d.store.wakes().filter((w) => w.turnId === turnId && w.state === 'delivered' && w.via === 'wake')
    if (mine.length === 0) return 'skip'
    if (!mine.some((w) => w.costUsd === null || w.costUsd === undefined)) return 'skip'
    this.d.store.update((s) => {
      for (const w of s.wakes) {
        if (w.turnId !== turnId || (w.costUsd !== null && w.costUsd !== undefined)) continue
        w.costUsd = cost.costUsd
        if (cost.model && !w.model) w.model = cost.model
        w.priced = cost.priced
      }
    })
    return 'done'
  }

  /** The agent's wakes of a local day that count ON ITS OWN (own-turns.ts):
   *  charged and not an owner's gesture — with what they cost. */
  wakesToday(agentId: string, day: string): WakesToday {
    const turns = new Map<string, number | null | undefined>()
    const models = new Map<string, string>()
    // turns on a plan (priced false): charged, but no money the cap brakes
    const plan = new Set<string>()
    for (const w of this.d.store.wakes()) {
      if (w.agent !== agentId || w.state !== 'delivered' || w.via !== 'wake' || !w.startedAt || !w.turnId || w.gesture) continue
      if (localDay(Date.parse(w.startedAt)) !== day) continue
      if (!turns.has(w.turnId) || turns.get(w.turnId) === undefined) turns.set(w.turnId, w.costUsd)
      if (w.model) models.set(w.turnId, w.model)
      if (w.priced === false) plan.add(w.turnId)
    }
    let costUsd = 0
    let unpriced = 0
    const unpricedModels = new Set<string>()
    for (const [t, c] of turns) {
      if (plan.has(t)) continue
      if (typeof c === 'number') costUsd += c
      else if (c === null) {
        unpriced++
        const m = models.get(t)
        if (m) unpricedModels.add(m)
      }
    }
    return { charged: turns.size, costUsd, unpriced, unpricedModels: [...unpricedModels], turnIds: [...turns.keys()] }
  }

  // ── delivery ──
  deliver(now = this.now()): void {
    this.requeueOrphans(now)
    this.settleAnswered(now)
    const queued = this.d.store.queued()
    if (queued.length === 0) return
    const bound = this.d.bound()
    const ready = this.d.ready()
    const tasks = this.snapshots()
    const byKey = new Map(tasks.map((t) => [t.key, t]))
    const groups = new Map<string, Wake[]>()
    for (const w of queued) {
      const k = `${w.agent}|${w.task}`
      groups.set(k, [...(groups.get(k) ?? []), w])
    }
    // TWO classes (G1-r6): a group carrying an owner's gesture goes ahead of
    // every inferred one, FIFO inside each class
    const ordered = [...groups.values()]
      .map((g) => ({ g, gesture: g.some((w) => w.gesture === true), at: Math.min(...g.map((w) => Date.parse(w.at) || 0)) }))
      .sort((a, b) => (a.gesture !== b.gesture ? (a.gesture ? -1 : 1) : a.at - b.at))
      .map((x) => x.g)
    const iso = new Date(now).toISOString()
    const decisions = new Map<string, Partial<Wake> & { state: Wake['state'] }>()
    const deliveries: Array<{ group: Wake[]; t: TaskSnap; resume: { sessionId: string } | null; fp: string; streak: number }> = []
    const liveOf = (agent: string): number => [...this.live.values()].filter((l) => l.agent === agent).length
    // wake turns on their way that have not been charged yet: the ceiling
    // counts them as spent until they say otherwise
    const unchargedOf = (agent: string): number => [...this.live.values()].filter((l) => l.agent === agent && l.charged === false && !l.gesture).length
    const planned = new Map<string, number>()
    const slots = new Map<string, { release: () => void }>()
    for (let group of ordered) {
      const w0 = group[0]!
      const t = byKey.get(w0.task)
      const onlyNotes = group.every((w) => w.reason === 'owner-note')
      // the task moved on before the wake could reach it
      if (!t) {
        // not found: its plan unreadable for a moment, or mid-move — kept
        // (with the moment Silos first missed it) until it reads again or
        // the keep runs out; then superseded, said (finding 3)
        const planKey = w0.task.includes('/tasks/') ? w0.task.slice(0, w0.task.lastIndexOf('/tasks/')) : w0.task
        const why = this.unreadable.get(planKey)
        const since = Math.min(...group.map((w) => Date.parse(w.missingSince ?? iso) || now))
        if (now - since < (why !== undefined ? OBSERVATION_KEEP_MS : MISSING_KEEP_MS)) {
          const held =
            why !== undefined
              ? `its plan can't be read right now (${why}) — kept until it reads again`
              : 'its task is not in the plans Silos reads right now — kept a while in case it comes back'
          for (const w of group) decisions.set(w.id, { state: 'queued', held, holdClass: 'missing', until: undefined, missingSince: w.missingSince ?? iso })
          continue
        }
        const held = `its task is no longer in a plan Silos reads${onlyNotes ? " — the owner's note stays in the plan file" : ''}`
        for (const w of group) decisions.set(w.id, { state: 'superseded', held, holdClass: undefined, until: undefined, missingSince: undefined })
        continue
      }
      const gone =
        t.owner !== w0.agent
          ? `the task is ${t.owner || 'nobody'}'s now`
          : !bound.has(w0.agent)
            ? `${w0.agent} is no longer in task mode`
            : CLOSED.has(t.state) && !onlyNotes
              ? `the task is ${t.state} already`
              : null
      if (gone) {
        for (const w of group) decisions.set(w.id, { state: 'superseded', held: gone, holdClass: undefined, until: undefined, missingSince: undefined })
        continue
      }
      // a `stalled` wake is never delivered over an
      // episode that no longer exists: the task's observation has no stall
      // episode now, or not THIS one (its key, stalled:<cause>@<since>) —
      // the task moved on first. An episode that holds (a moved conversation
      // hides the stall, its shape unchanged) delivers as always. Per wake:
      // the group's other wakes go on
      const episode = this.d.store.observations()[t.key]?.stall ?? null
      const stale = group.filter((w) => w.reason === 'stalled' && (episode === null || w.key !== `stalled:${episode.cause}@${episode.since}`))
      if (stale.length > 0) {
        for (const w of stale)
          decisions.set(w.id, { state: 'superseded', held: 'the task moved on first', holdClass: undefined, until: undefined, missingSince: undefined })
        group = group.filter((w) => !stale.includes(w))
        if (group.length === 0) continue
      }
      // every hold says its class beside its words.
      // A2.8/E7: a console hold writes the conversation holding it and the
      // first pass held with that class; a pass that stops earlier — the
      // engine, a retry's backoff, the limit — carries both; any other
      // decision clears them. E8: engineUnreadSince rides only an engine hold
      // kept over a failed read.
      const hold = (holdClass: HoldClass, held: string, until?: number, extra: { holdSession?: string; engineUnreadSince?: string } = {}): void => {
        for (const w of group) {
          const carries = holdClass === 'engine' || holdClass === 'backoff' || holdClass === 'limit'
          const heldSince = holdClass === 'console' ? (w.heldSince ?? iso) : carries ? w.heldSince : undefined
          const holdSession = holdClass === 'console' ? extra.holdSession : carries ? w.holdSession : undefined
          decisions.set(w.id, {
            state: 'queued',
            held,
            holdClass,
            until: until !== undefined ? new Date(until).toISOString() : undefined,
            missingSince: undefined,
            heldSince,
            holdSession,
            engineUnreadSince: extra.engineUnreadSince,
          })
        }
      }
      // delivery off (the e2e harness): kept exactly as it is — never sent
      if (this.d.deliveryOff) continue
      // the index is not warm yet: kept as it is, sent once it is
      if (!ready) continue
      if ([...this.live.values()].some((l) => l.task === t.key && l.agent === w0.agent)) {
        hold('turn', 'its turn is running — it gets this at its next turn')
        continue
      }
      // (B2, H3) an answer an unattended turn gave waits for that turn's
      // audit — the existing `turn` class (A1.10's list is closed)
      const auditDue = group.find((w) => w.answeredIn !== undefined)?.answeredIn
      if (auditDue) {
        const who = this.d.nameOf?.(auditDue.agent) ?? auditDue.agent
        let live = false
        try {
          live = this.d.answeredTurn?.live(auditDue.agent, auditDue.run) ?? false
        } catch {
          live = false
        }
        hold(
          'turn',
          live
            ? `${who}'s turn that answered is still running — it goes once that turn is audited`
            : `the audit of ${who}'s turn that answered is not in yet — it goes once it is`,
        )
        continue
      }
      // the agent's engine is refused: it waits for the engine — uncharged,
      // no attempt counted — and goes the moment it reads ok again
      let refused: string | null = null
      let unread = false
      try {
        refused = this.d.engineRefusal?.(w0.agent) ?? null
      } catch {
        refused = null
        unread = true
      }
      if (refused !== null) {
        hold('engine', `${ENGINE_HOLD}: ${refused} — it goes once the engine is updated`)
        continue
      }
      // (A2.9) a read that fails does not let go of an engine hold: kept at
      // most LIMIT_RETRY_MS from the first failed read, then it goes on
      if (unread && group.some((w) => w.holdClass === 'engine')) {
        const since = Math.min(...group.map((w) => Date.parse(w.engineUnreadSince ?? iso) || now))
        if (now - since < LIMIT_RETRY_MS) {
          hold('engine', `${ENGINE_UNREAD} — it tries again`, undefined, { engineUnreadSince: new Date(since).toISOString() })
          continue
        }
      }
      // a turn that could not start waits out its retry (findings 1/7)
      const retry = group.find((w) => w.attempts !== undefined && w.until !== undefined && Date.parse(w.until) > now)
      if (retry) {
        hold(retry.holdClass ?? 'backoff', retry.held ?? 'its last turn could not start', Date.parse(retry.until!))
        continue
      }
      // the agent's account at its usage limit: it waits for the reset —
      // uncharged, nothing «delivered» (finding 1)
      let limited: string | null = null
      let limitUnread = false
      try {
        limited = this.d.limitedUntil?.(w0.agent) ?? null
      } catch {
        limited = null
        limitUnread = true
      }
      if (limited !== null && Date.parse(limited) > now) {
        hold('limit', `its account is at its usage limit — it goes at ${hhmmLocal(limited)}`, Date.parse(limited))
        continue
      }
      // (A2.9) a limit read that fails keeps a limit hold still ahead —
      // bounded by its own until
      const keptLimit = limitUnread ? group.find((w) => w.holdClass === 'limit' && w.until !== undefined && Date.parse(w.until) > now) : undefined
      if (keptLimit) {
        hold('limit', keptLimit.held ?? 'its account is at its usage limit', Date.parse(keptLimit.until!))
        continue
      }
      const conv = this.d.conversationOf(w0.agent, t.current)
      // any of ITS conversations of the thread busy holds it — not only the
      // one a wake would resume (a fresh console isn't indexed yet)
      const busy = this.busyOf(w0.agent, t, conv)
      if (busy) {
        hold(
          isConsoleBusy(busy.why) ? 'console' : 'turn',
          `${busy.why} — it gets this at its next turn`,
          undefined,
          busy.why === CONSOLE_BUSY ? { holdSession: busy.sessionId } : {},
        )
        continue
      }
      const bypass = group.some((w) => w.bypassThrottle)
      // an owner's gesture is never held by a ceiling nor a throttle (R1, I4)
      const gesture = group.some((w) => w.gesture === true)
      const siblings = tasks.filter((x) => x.planKey === t.planKey)
      const fp = fingerprintOf(t, siblings)
      const th = throttle(this.d.store.throttleOf(w0.agent, t.key), fp, now)
      if (!bypass && !gesture && th.until !== null) {
        hold('throttle', `started ${th.streak} times with no visible change — it waits a little`, th.until)
        continue
      }
      if (!gesture) {
        // the agent's day on its own: its ceiling, then its spend cap
        // — counting the turns already handed out and the ones this pass plans
        const own = this.d.ownToday?.(w0.agent, now)
        if (own) {
          const planCount = unchargedOf(w0.agent) + (planned.get(w0.agent) ?? 0)
          const cap = ownCapHold({ ...own, used: own.used + planCount })
          if (cap === 'ceiling') {
            hold('ceiling', `started ${own.ceiling} times without you today — it waits for tomorrow`, nextMidnight(now))
            continue
          }
          if (cap === 'spend') {
            hold('ceiling', `spent $${own.costUsd.toFixed(2)} without you today — its cap · it waits for tomorrow`, nextMidnight(now))
            continue
          }
        }
      }
      const name = this.d.nameOf?.(w0.agent) ?? w0.agent
      if (this.d.slots) {
        const ans = this.d.slots.tryAcquire({
          id: `wake:${w0.agent}|${t.key}`,
          agentId: w0.agent,
          gesture,
          at: Math.min(...group.map((w) => Date.parse(w.at) || now)),
        })
        if (!ans.ok) {
          hold('slot', heldWords(ans.cap, ans.running, name))
          continue
        }
        slots.set(`${w0.agent}|${t.key}`, ans)
      } else if (liveOf(w0.agent) + (planned.get(w0.agent) ?? 0) >= OWN_TURNS_LIVE) {
        hold('slot', heldWords('agent', liveOf(w0.agent) + (planned.get(w0.agent) ?? 0), name))
        continue
      }
      planned.set(w0.agent, (planned.get(w0.agent) ?? 0) + 1)
      deliveries.push({ group, t, resume: conv, fp, streak: bypass ? 0 : th.streak })
      for (const w of group)
        decisions.set(w.id, {
          state: 'delivered',
          deliveredAt: iso,
          held: undefined,
          holdClass: undefined,
          until: undefined,
          missingSince: undefined,
          via: 'wake',
          starting: true,
          ...(conv ? { session: conv.sessionId } : {}),
        })
    }
    this.d.store.update((s) => {
      let changed = false
      // the hold's fields: a decision that leaves one out (or undefined) clears it
      const HOLD_FIELDS = ['held', 'holdClass', 'until', 'missingSince', 'heldSince', 'holdSession', 'engineUnreadSince'] as const
      for (const w of s.wakes) {
        const dec = decisions.get(w.id)
        if (!dec) continue
        if (dec.state !== 'delivered' && w.state === dec.state && HOLD_FIELDS.every((k) => w[k] === dec[k])) continue
        Object.assign(w, dec)
        for (const k of HOLD_FIELDS) if (dec[k] === undefined) delete w[k]
        changed = true
      }
      return changed
    }, now)
    for (const x of deliveries) this.start(x.group, x.t, x.resume, x.fp, x.streak, slots.get(`${x.group[0]!.agent}|${x.t.key}`) ?? null)
    // a slot granted to a group that did not start (none: every grant is
    // delivered just above) is never left held
  }

  // An `answered` wake whose answer came from an
  // unattended turn carries that turn (answeredIn) and is held — class `turn`
  // — until the turn's audit is registered: then its notes carry the mark the
  // audit left (readOutside — «written after reading the web») and it goes.
  // The first pass that sees the turn no longer live writes `endedAt`; with
  // no audit MISSING_KEEP_MS after it (a restart cut the audit, a transcript
  // nobody can read), it goes marked «transcript unreadable» — closed by
  // default, never unmarked.
  private settleAnswered(now: number): void {
    const due = this.d.store.queued().filter((w) => w.answeredIn !== undefined)
    if (due.length === 0) return
    const iso = new Date(now).toISOString()
    const mark = (notes: TaskNote[], tools: string[]): TaskNote[] =>
      tools.length === 0 ? notes : notes.map((n) => ({ ...n, readOutside: [...new Set([...(n.readOutside ?? []), ...tools])] }))
    this.d.store.update((s) => {
      let changed = false
      for (const w of s.wakes) {
        if (w.state !== 'queued' || !w.answeredIn) continue
        const { agent, run } = w.answeredIn
        let live = false
        let seen: string[] | null = null
        try {
          live = this.d.answeredTurn?.live(agent, run) ?? false
        } catch {
          live = false
        }
        if (live) continue
        try {
          seen = this.d.answeredTurn?.readOutside(agent, run) ?? null
        } catch {
          seen = null
        }
        if (seen !== null) {
          w.notes = mark(w.notes, seen)
          delete w.answeredIn
          changed = true
          continue
        }
        if (w.answeredIn.endedAt === undefined) {
          w.answeredIn.endedAt = iso
          changed = true
          continue
        }
        if (now - (Date.parse(w.answeredIn.endedAt) || now) >= MISSING_KEEP_MS) {
          w.notes = mark(w.notes, [TRANSCRIPT_UNREADABLE])
          delete w.answeredIn
          changed = true
        }
      }
      return changed
    }, now)
  }

  // Wakes handed to a turn this process no longer runs that never started
  // (a restart between the hand-over and the turn's first output): back in
  // the queue, uncharged — never «delivered» by a turn that did nothing.
  private requeueOrphans(now: number): void {
    this.settleEnded(now)
    const orphans = this.d.store
      .wakes()
      .filter((w) => w.state === 'delivered' && w.starting && !this.handing.has(w.id) && !(w.turnId && this.live.has(w.turnId)))
    if (orphans.length === 0) return
    const ids = new Set(orphans.map((w) => w.id))
    this.d.store.update((s) => {
      for (const w of s.wakes) if (ids.has(w.id)) this.backToQueue(w, 'turn', 'its turn ended before it started — it goes again', null)
    }, now)
  }

  // A wake turn that STARTED and is no longer
  // running in this process yet never said its price — a restart cut its
  // end, or its promise failed: it ended, unpriced (null), never «running»
  // all day. Its engine's price is not knowable here without reading the
  // engine's own transcript pricing, which lives with the engine.
  private settleEnded(now: number): void {
    const ended = (w: Wake): boolean =>
      w.state === 'delivered' &&
      w.via === 'wake' &&
      !w.starting &&
      w.turnId !== undefined &&
      w.costUsd === undefined &&
      !this.live.has(w.turnId) &&
      !this.handing.has(w.id)
    if (!this.d.store.wakes().some(ended)) return
    this.d.store.update((s) => {
      for (const w of s.wakes) if (ended(w)) w.costUsd = null
    }, now)
  }

  // a wake whose turn never started: queued again, uncharged, held as said
  private backToQueue(w: Wake, holdClass: HoldClass, held: string, until: string | null): void {
    w.state = 'queued'
    w.held = held
    w.holdClass = holdClass
    if (until !== null) w.until = until
    else delete w.until
    delete w.deliveredAt
    delete w.starting
    delete w.turnId
    delete w.via
    delete w.costUsd
  }

  private start(
    group: Wake[],
    t: TaskSnap,
    resume: { sessionId: string } | null,
    fp: string,
    streak: number,
    slot: { release: () => void } | null = null,
  ): void {
    const agent = group[0]!.agent
    const gesture = group.some((w) => w.gesture === true)
    const text = wakeBriefing(
      t,
      group,
      group.flatMap((w) => w.notes),
      (id) => this.d.nameOf?.(id) ?? id,
    )
    const ids = new Set(group.map((w) => w.id))
    let turnId = ''
    let charged = false
    // charged ONCE, when the turn starts working (findings 1/7): the
    // throttle's streak and the day's ceiling — the «woke X N times» row
    // counts only turns that ran
    const charge = (): void => {
      if (charged) return
      charged = true
      const l = this.live.get(turnId)
      if (l) l.charged = true
      const at = this.now()
      const iso = new Date(at).toISOString()
      this.d.store.update((s) => {
        let mine = false
        for (const w of s.wakes)
          if (ids.has(w.id) && w.starting) {
            delete w.starting
            delete w.gaveUp
            w.startedAt = iso
            mine = true
          }
        if (!mine) return false
        s.throttle[`${agent}|${t.key}`] = { lastFp: fp, streak, lastAt: iso }
        // an owner's gesture is never charged to the agent's day (R1)
        if (gesture) return
        const day = localDay(at)
        const b = s.budget[agent]
        s.budget[agent] = b && b.day === day ? { day, used: b.used + 1 } : { day, used: 1 }
      }, at)
    }
    for (const id of ids) this.handing.add(id)
    try {
      const turn = this.d.send({
        agentId: agent,
        text,
        resume: resume?.sessionId ?? null,
        origin: { task: t.key, ref: t.ref },
        turn: { class: 'wake', taskKey: t.key },
        onStarted: () => {
          try {
            charge()
          } catch {
            /* its end charges it */
          }
        },
        onAudit: (audit, at) => this.recordAudit(t, agent, ids, turnId, audit, at.sessionId),
        onSession: (sessionId) => {
          const l = this.live.get(turnId)
          if (l) l.sessionId = sessionId
          // a new conversation for the task: it joins conversations[] at once
          if (!resume) {
            this.d.appendConversation(t.key, sessionId)
            this.d.store.update((s) => {
              for (const w of s.wakes) if (ids.has(w.id)) w.session = sessionId
            })
          }
        },
      })
      turnId = turn.turnId
      this.live.set(turnId, { agent, task: t.key, sessionId: resume?.sessionId ?? null, charged, gesture })
      endPass() // its turn is on the way now (wakeOnTheWay): read the flows again
      const tid = turnId
      this.d.store.update((s) => {
        for (const w of s.wakes) if (ids.has(w.id)) w.turnId = tid
      })
      for (const id of ids) this.handing.delete(id)
      // what the turn cost (MovesControl's «~$X today»): said by its engine at
      // its end, recorded on the wakes it delivered — or, when it never
      // started, its wakes go back to the queue uncharged
      turn.done.then(
        () => slot?.release(),
        () => slot?.release(),
      )
      void turn.done
        .then(
          (r) => {
            this.live.delete(tid)
            const end: TaskTurnEnd = r && typeof r === 'object' ? r : {}
            if (end.started === false && !charged) {
              this.notStarted(ids, end)
              return
            }
            // an engine that says nothing of its start ran: charged at its end
            charge()
            const cost = typeof end.costUsd === 'number' && Number.isFinite(end.costUsd) ? end.costUsd : null
            this.d.store.update((s) => {
              for (const w of s.wakes)
                if (ids.has(w.id)) {
                  w.costUsd = cost
                  if (end.model) w.model = end.model
                  if (end.priced !== undefined) w.priced = end.priced
                }
            })
          },
          () => {
            this.live.delete(tid)
            charge() /* a failed promise: priced as nothing said */
          },
        )
        .finally(() => {
          this.live.delete(tid)
        })
    } catch (err) {
      slot?.release()
      for (const id of ids) this.handing.delete(id)
      // it never started: back to the queue, uncharged, retried later
      this.notStarted(ids, { started: false, error: err instanceof Error ? err.message : String(err) })
    }
  }

  // The turn never worked (findings 1/7): its wakes go back to the queue,
  // nothing charged — held until the account's reset (a usage limit) or a
  // retry that doubles per attempt (an engine that failed to start).
  // A refused engine and a usage limit are
  // holds, not failures: no attempt counted. Any other failure counts one;
  // at START_ATTEMPTS_MAX the wake gives up waiting quietly (gaveUp) — it
  // stays queued, retried at the backoff's ceiling, and its task becomes a
  // subject of the escalation (cannotStart): said once, up the chain.
  private notStarted(ids: ReadonlySet<string>, end: TaskTurnEnd): void {
    const now = this.now()
    this.d.store.update((s) => {
      for (const w of s.wakes) {
        if (!ids.has(w.id)) continue
        if (end.refused !== undefined) {
          w.attempts ??= 0
          this.backToQueue(w, 'engine', `${ENGINE_HOLD}: ${end.refused} — it goes once the engine is updated`, new Date(now + ENGINE_RETRY_MS).toISOString())
        } else if (end.error === undefined || (end.limitedUntil !== undefined && end.limitedUntil !== null)) {
          w.attempts ??= 0
          const until = end.limitedUntil && Date.parse(end.limitedUntil) > now ? end.limitedUntil : new Date(now + LIMIT_RETRY_MS).toISOString()
          this.backToQueue(w, 'limit', `its account is at its usage limit — it goes at ${hhmmLocal(until)}`, until)
        } else {
          w.attempts = (w.attempts ?? 0) + 1
          if (w.attempts >= START_ATTEMPTS_MAX && !w.gaveUp) w.gaveUp = { at: new Date(now).toISOString(), error: end.error }
          if (w.gaveUp) w.gaveUp.error = end.error
          const asked = w.gaveUp ? ' — Silos asked for help, and keeps trying' : ' — Silos tries again'
          this.backToQueue(
            w,
            'backoff',
            `its turn could not start (${w.attempts} ${w.attempts === 1 ? 'try' : 'tries'}): ${end.error}${asked}`,
            new Date(now + startRetryMs(w.attempts)).toISOString(),
          )
        }
      }
    }, now)
  }

  // The tasks Silos can't start their agent's
  // turn on: a queued wake of the task's bound owner that gave up
  // (START_ATTEMPTS_MAX failed starts). What escalation/engine.ts opens a
  // case on — the same path a stall whose one wake changed nothing takes;
  // a `stalled` wake that never started included. It leaves the moment a
  // turn starts (gaveUp cleared) or the wake leaves the queue.
  cannotStart(now = this.now(), tasks = this.snapshots(now)): Array<{ task: TaskSnap; error: string; attempts: number; since: string }> {
    const bound = this.d.bound()
    const byKey = new Map(tasks.map((t) => [t.key, t]))
    const out = new Map<string, { task: TaskSnap; error: string; attempts: number; since: string }>()
    for (const w of this.d.store.queued()) {
      if (!w.gaveUp) continue
      const t = byKey.get(w.task)
      if (!t || t.owner !== w.agent || !bound.has(t.owner) || CLOSED.has(t.state)) continue
      const prev = out.get(t.key)
      if (!prev || Date.parse(w.gaveUp.at) < Date.parse(prev.since))
        out.set(t.key, { task: t, error: w.gaveUp.error, attempts: w.attempts ?? START_ATTEMPTS_MAX, since: w.gaveUp.at })
    }
    return [...out.values()]
  }

  // the wakes the day counts for the agent: the turns that started, plus the
  // ones handed over and not started yet (they leave the count again when
  // they never start — a usage limit, an engine failure)
  private usedNow(agentId: string, day: string): number {
    return this.d.store.usedToday(agentId, day) + [...this.live.values()].filter((l) => l.agent === agentId && l.charged === false && !l.gesture).length
  }

  // A wake on its way for this task (G1/G2): one QUEUED for its owner, of any
  // reason, or a task turn of that owner running on it. Asked by key, or —
  // when the caller has no key (a predicate over one record) — by the owner
  // and the task's id in any plan.
  wakeOnTheWay(q: { key: string | null; owner: string; id: string }): boolean {
    const match = (task: string): boolean => (q.key !== null ? task === q.key : task.endsWith(`/tasks/${q.id}`))
    if (this.d.store.queued().some((w) => w.agent === q.owner && match(w.task))) return true
    return [...this.live.values()].some((l) => l.agent === q.owner && match(l.task))
  }

  // ── the owner's gesture: «Give to X» / «Start X ›» ──
  // ONE `assigned` wake for the task's bound owner, through the pipe every
  // wake takes (queuedWake → store.update → deliver). Nothing is queued — and
  // `why` says so — when the task is not open and ready, a conversation is on
  // it already (for the owner's gesture: a LIVE one — A1.2), or a wake is on
  // its way (any reason, or its turn running:
  // New task's description note already woke it). The wake carries the
  // owner's notes no delivered wake carried yet; in the same write the
  // task's observation takes their count (a baseline when there was none),
  // so no later look fires owner-note for them. Whether the owner moves by
  // task mode at all (wakes === 'task') is the route's to check, in T4's words.
  // `ownerGesture`: the owner's assign skips the
  // day's ceiling and the throttle — never the live caps, where it queues
  // ahead of what Silos inferred; a bearer's assign takes the normal pipe.
  assign(key: string, now = this.now(), opts: { ownerGesture?: boolean } = {}): { queued: boolean; why?: string; held?: string } {
    const tasks = this.snapshots(now)
    const t = tasks.find((x) => x.key === key)
    if (!t) return { queued: false, why: 'no such task in the plans Silos reads' }
    const name = this.d.nameOf?.(t.owner) ?? t.owner
    const gesture = opts.ownerGesture === true
    if (!this.d.bound().has(t.owner)) return { queued: false, why: `${name || 'nobody'} is Only when told — open it on the task` }
    // «the task is done already» / «…cancelled already»
    if (CLOSED.has(t.state)) return { queued: false, why: `the task is ${t.state} already` }
    const siblings = tasks.filter((x) => x.planKey === t.planKey)
    // a dropped (cancelled) blocker never resolves: no promise to wake when
    // it is done — the way out is to remove that dependency or reopen it
    const dead = t.dependsOn.filter((d) => siblings.find((x) => x.id === d)?.state === 'cancelled')
    if (dead.length > 0)
      return {
        queued: false,
        why: `it waits on ${dead.join(', ')} which ${dead.length === 1 ? 'was' : 'were'} dropped — remove the dependency or reopen ${dead.length === 1 ? 'it' : 'them'} first`,
      }
    const open = t.dependsOn.filter((d) => siblings.find((x) => x.id === d)?.state !== 'done')
    // a blocked task nothing holds is pending (A1.5): the owner's Start goes
    if (snapStateRead(t, siblings, now) === 'blocked' || open.length > 0)
      return {
        queued: false,
        why:
          open.length > 0
            ? `it waits on ${open.join(', ')} — Silos wakes ${name} when ${open.length === 1 ? 'it is' : 'they are'} done`
            : 'it is blocked — unblock it first',
      }
    if (t.waitingOn) return { queued: false, why: `it waits on ${t.waitingFor?.owner === 'owner' ? 'you' : (t.waitingFor?.owner ?? 'someone')}` }
    if (this.wakeOnTheWay({ key, owner: t.owner, id: t.id })) return { queued: false, why: 'it is already on its way' }
    // a conversation on it: a bearer's assign keeps its lock (any current
    // one); the OWNER's gesture is refused only by one that is LIVE (spec
    // 2026-11-21 A1.2 — the kernel's word, carried on the snapshot): one that
    // stopped moving is resumed by the wake, and deliver() holds it while a
    // turn or a console is on it. Without the kernel's word (no flow given)
    // the lock stands — never a guess
    const lock = gesture && t.live !== undefined ? t.live : t.current.length > 0
    if (lock) return { queued: false, why: `${name} is on it already — open it` }
    const carried = this.d.store
      .wakesOf(key)
      .filter((w) => w.agent === t.owner && w.state === 'delivered')
      .flatMap((w) => w.notes)
      .map(noteId)
    const ownerNotes = ownerNotesOf(t)
    const fresh = ownerNotes.filter((n) => !carried.includes(noteId(n)))
    const iso = new Date(now).toISOString()
    const wake: NewWake = {
      agent: t.owner,
      task: key,
      ref: t.ref,
      title: t.title,
      reason: 'assigned',
      says: gesture ? 'the owner handed it to you' : 'you started it yourself',
      key: `assigned:${key}:${t.owner}:${iso}`,
      notes: fresh,
      bypassThrottle: gesture,
    }
    const baseline = evaluateTaskWakes({ tasks: siblings, bound: new Set([t.owner]), prev: {}, now }).observations[key]
    let id = ''
    this.d.store.update((s) => {
      const w = this.queuedWake(wake, iso, gesture)
      id = w.id
      s.wakes.push(w)
      const prev = s.observations[key]
      const obs = prev && prev.owner === t.owner ? prev : baseline
      if (obs) s.observations[key] = { ...obs, ownerSeen: ownerNotes.map(noteId) }
    }, now)
    this.deliver(now)
    const after = this.d.store.wakes().find((w) => w.id === id)
    return { queued: true, ...(after?.state === 'queued' && after.held ? { held: after.held } : {}) }
  }

  // What the agent's task wakes did today (MovesControl, E6): how many were
  // delivered (the ceiling's count), what their turns cost as each engine
  // priced them (summed over the turns that said a price; `unpriced` = turns
  // that ended without one, `running` = turns still going), the ceiling, and
  // how many wakes the ceiling holds now.
  today(agentId: string, now = this.now()): TaskWakesToday {
    const day = localDay(now)
    const turns = new Map<string, number | null | undefined>()
    const plan = new Set<string>()
    for (const w of this.d.store.wakes()) {
      if (w.agent !== agentId || w.state !== 'delivered' || w.via !== 'wake' || !w.deliveredAt || !w.turnId) continue
      if (localDay(Date.parse(w.deliveredAt)) !== day) continue
      if (!turns.has(w.turnId) || turns.get(w.turnId) === undefined) turns.set(w.turnId, w.costUsd)
      if (w.priced === false) plan.add(w.turnId)
    }
    let cost: number | null = null
    let unpriced = 0
    let running = 0
    for (const [t, c] of turns) {
      if (c === undefined) running += 1
      // a turn on a plan has no price to miss («unpriced» is a model
      // without a price on a provider that prices)
      else if (c === null) {
        if (!plan.has(t)) unpriced += 1
      } else cost = (cost ?? 0) + c
    }
    // the class, never the words: the agent's day on
    // its own — its ceiling or its spend cap — holds them
    const heldByCeiling = this.d.store.queued().filter((w) => w.agent === agentId && w.holdClass === 'ceiling').length
    const own = this.d.ownToday?.(agentId, now)
    return {
      agent: agentId,
      day,
      woke: this.usedNow(agentId, day),
      costUsd: cost,
      unpriced,
      running,
      ceiling: own?.ceiling ?? 0,
      heldByCeiling,
      ...(own ? { started: own.used, spentUsd: own.costUsd, spendCap: own.spendCap, exempt: own.exempt } : {}),
    }
  }

  // The bound agents whose ceiling the day touched (E6: a `due` row in Needs
  // you, beside messageBudget) — with how many wakes wait and until when.
  // With the breakdown the row says: what the count
  // and the money were made of.
  ceilingHits(now = this.now()): OwnCapHit[] {
    const day = localDay(now)
    const out: OwnCapHit[] = []
    for (const agent of this.d.bound()) {
      const base = this.d.ownToday?.(agent, now)
      if (!base) continue
      // the turns handed out and not started yet count as spent (as deliver
      // counts them) — task starts, in the breakdown too
      const handed = [...this.live.values()].filter((l) => l.agent === agent && l.charged === false && !l.gesture).length
      const own = { ...base, used: base.used + handed }
      const cap = ownCapHold(own)
      if (!cap) continue
      const waiting = this.d.store.queued().filter((w) => w.agent === agent && !w.gesture).length
      out.push({
        agent,
        used: own.used,
        perDay: own.ceiling,
        waiting,
        until: new Date(nextMidnight(now)).toISOString(),
        day,
        cap,
        spentUsd: own.costUsd,
        ...(base.starts ? { starts: { ...base.starts, wakes: base.starts.wakes + handed } } : {}),
        ...(base.spent ? { spent: base.spent } : {}),
      })
    }
    return out
  }

  // ── the task's door, console side («Continue in X's console ›») ──
  // The briefing for the console the owner opens on `key`, with the wakes
  // that waited folded in (they reach the agent there — marked delivered,
  // `via: work`). For ANY owner: an unbound agent
  // has no wakes, so its briefing folds none in. null: no such task. Whether
  // the owner is an agent at all is the route's to say.
  work(key: string): { task: TaskSnap; briefing: string; folded: string[] } | null {
    const t = this.snapshots().find((x) => x.key === key)
    if (!t) return null
    const waiting = this.d.bound().has(t.owner) ? this.d.store.queued().filter((w) => w.task === key && w.agent === t.owner) : []
    const briefing = workBriefing(t, waiting, (id) => this.d.nameOf?.(id) ?? id, { bound: this.d.bound().has(t.owner) })
    return { task: t, briefing, folded: waiting.map((w) => w.id) }
  }

  // The wakes waiting for `agent` on `key` that a CLAIM delivers (the same
  // filter as openTalk: only a bound owner's, queued, of this task) — the
  // lines its claim briefing folds in, and their ids for markWorked(…,
  // 'claim'). Nothing for an agent that is not the task's bound owner.
  claimWakes(key: string, agent: string): { lines: Array<{ says: string; notes: TaskNote[] }>; ids: string[] } {
    const t = this.snapshots().find((x) => x.key === key)
    if (!t || t.owner !== agent || !this.d.bound().has(agent)) return { lines: [], ids: [] }
    const waiting = this.d.store.queued().filter((w) => w.task === key && w.agent === agent)
    return { lines: waiting.map((w) => ({ says: w.says, notes: w.notes })), ids: waiting.map((w) => w.id) }
  }

  // the folded wakes reached the agent through the owner's console (or, with
  // via 'talk', through the chat turn «Open chat ›» opened; 'claim',
  // through the answer to the agent's own claim)
  markWorked(ids: readonly string[], sessionId: string, now = this.now(), via: 'work' | 'talk' | 'claim' = 'work'): void {
    if (ids.length === 0) return
    const set = new Set(ids)
    const iso = new Date(now).toISOString()
    this.d.store.update((s) => {
      for (const w of s.wakes)
        if (set.has(w.id) && w.state === 'queued') {
          w.state = 'delivered'
          w.deliveredAt = iso
          w.session = sessionId
          w.via = via
          delete w.held
          delete w.holdClass
          delete w.until
        }
    }, now)
  }

  // ── what the task page says ──
  view(key: string, limit = 8): TaskModeView | null {
    const t = this.snapshots().find((x) => x.key === key)
    if (!t) return null
    const history = this.d.store
      .wakesOf(key)
      .slice(-limit)
      .reverse()
      .map(({ id, reason, says, at, state, deliveredAt, session, held, until, via }) => ({
        id,
        reason,
        says,
        at,
        state,
        ...(deliveredAt ? { deliveredAt } : {}),
        ...(session ? { session } : {}),
        ...(held ? { held } : {}),
        ...(until ? { until } : {}),
        ...(via ? { via } : {}),
      }))
    return { bound: this.d.bound().has(t.owner), owner: t.owner, history, heldNow: this.heldNow(t), live: this.liveOf(t) }
  }

  /** The live line's facts for one task (TaskLive above) — read, never
   *  written: the turns in flight, else what its owner's queued wake waits
   *  on (the live caps asked where it stands, turn-slots.ts standing). */
  liveOf(t: Pick<TaskSnap, 'key' | 'owner' | 'current'>): TaskLive | null {
    const turns = [...this.live.entries()]
      .filter(([, l]) => l.task === t.key)
      .map(([turnId, l]) => ({ turnId, sessionId: l.sessionId, started: l.charged === true, agent: l.agent }))
    if (turns.length > 0) return { kind: 'running', turns }
    const queued = this.d.store.queued().filter((w) => w.task === t.key && w.agent === t.owner)
    if (queued.length === 0) {
      const conv = this.d.conversationOf(t.owner, t.current)
      for (const id of new Set([...(conv ? [conv.sessionId] : []), ...this.d.holdersOf(t.owner, t.current)])) {
        if (isConsoleBusy(this.d.busyWhy(id))) return { kind: 'console', sessionId: id }
      }
      return null
    }
    const slot = this.d.slots?.standing(`wake:${t.owner}|${t.key}`) ?? null
    if (slot) return { kind: 'queued', cap: slot.cap, running: slot.running }
    // a start that did not start (notStarted: attempts counted, or a hold
    // for the engine or the account) — its words
    // — or an engine refused before any attempt
    const failed = queued.find((w) => w.held && (w.attempts !== undefined || w.held.startsWith(ENGINE_HOLD)))
    if (failed) return { kind: 'failed', why: failed.held!, ...(failed.held!.startsWith(ENGINE_HOLD) ? { engine: true as const } : {}) }
    const held = queued.find((w) => w.held)
    if (held) return { kind: 'held', why: held.held! }
    return { kind: 'starting' }
  }

  // ── «Open chat ›» ──
  // The chat-lane twin of «Work on this»: ONE turn with the work briefing on
  // the task's own thread, for ANY agent owner — bound or not (the unbound
  // agent's only door used to be a dead end). Resolves the conversation the
  // way deliver() does (conversationOf walks the thread's tip), sends through
  // the same resident lane, appends a NEW conversation to the task at once,
  // and folds the queued wakes in (via 'talk') — marked delivered when the
  // turn STARTS (its first output, onStarted), never
  // when it is asked: a turn that never starts leaves them queued, and
  // deliver() sends them once it is over. A refusal of the resident lane (no
  // agent in play, no folder) is a 409 in its own words, never a 500.
  // Returns once the session is known (chat-init), while the turn goes on.
  async openTalk(
    key: string,
  ): Promise<
    { ok: true; agent: string; folder: string | null; sessionId: string; isNew: boolean; folded: string[] } | { ok: false; code: number; reason: string }
  > {
    const t = this.snapshots().find((x) => x.key === key)
    if (!t) return { ok: false, code: 404, reason: 'no such task in the plans Silos reads' }
    const bound = this.d.bound().has(t.owner)
    const waiting = bound ? this.d.store.queued().filter((w) => w.task === key && w.agent === t.owner) : []
    const briefing = workBriefing(t, waiting, (id) => this.d.nameOf?.(id) ?? id, { bound })
    const conv = this.d.conversationOf(t.owner, t.current)
    const busy = this.busyOf(t.owner, t, conv)?.why ?? null
    if (busy) return { ok: false, code: 409, reason: `${busy} — open it instead; your words land there` }
    let announced: (v: { sessionId: string }) => void
    const first = new Promise<{ sessionId: string }>((r) => {
      announced = r
    })
    let turnId = ''
    let sid: string | null = conv?.sessionId ?? null
    const folded = waiting.map((w) => w.id)
    let turn: ReturnType<TaskModeDeps['send']>
    try {
      turn = this.d.send({
        agentId: t.owner,
        text: briefing,
        resume: conv?.sessionId ?? null,
        turn: { class: 'wake', taskKey: t.key },
        onAudit: (audit, at) => this.recordAudit(t, t.owner, new Set(folded), turnId, audit, at.sessionId),
        onSession: (sessionId) => {
          sid = sessionId
          const l = this.live.get(turnId)
          if (l) l.sessionId = sessionId
          if (!conv) this.d.appendConversation(t.key, sessionId)
          announced({ sessionId })
        },
        // the folded wakes reached the agent the moment its turn works
        onStarted: () => {
          try {
            this.markWorked(folded, sid ?? '', this.now(), 'talk')
          } catch {
            /* they stay queued: deliver sends them */
          }
        },
      })
    } catch (err) {
      return { ok: false, code: 409, reason: err instanceof Error ? err.message : String(err) }
    }
    turnId = turn.turnId
    this.live.set(turnId, { agent: t.owner, task: t.key, sessionId: conv?.sessionId ?? null })
    endPass() // its turn is on the way now (wakeOnTheWay): read the flows again
    void turn.done.finally(() => {
      this.live.delete(turnId)
    })
    if (conv) announced!({ sessionId: conv.sessionId })
    const { sessionId } = await Promise.race([first, turn.done.then(() => ({ sessionId: conv?.sessionId ?? '' }))])
    if (sessionId === '') return { ok: false, code: 502, reason: 'the turn ended without a session — the engine said nothing' }
    return { ok: true, agent: t.owner, folder: conv?.folder ?? null, sessionId, isNew: !conv, folded }
  }

  // the audit of a task turn, recorded on the TASK (its newest audited
  // turn) and on the wakes it delivered — an unreadable transcript arrives as
  // `transcript unreadable` and its Needs you row hangs from the task
  private recordAudit(t: TaskSnap, agent: string, wakeIds: ReadonlySet<string>, turnId: string, audit: RunAudit, session: string): void {
    const at = this.now()
    this.d.store.update((s) => {
      for (const w of s.wakes) if (wakeIds.has(w.id)) w.audit = audit
      s.audits = { ...(s.audits ?? {}), [t.key]: { agent, ref: t.ref, title: t.title, session, turnId, at: new Date(at).toISOString(), audit } }
    }, at)
    try {
      this.d.afterAudit?.(agent, turnId, audit)
    } catch (err) {
      console.warn('task-mode: the audit verdict failed —', err instanceof Error ? err.message : err)
    }
  }

  /** The tasks whose newest audited turn could not be read (inbox rows). */
  unreadableAudits(): ReturnType<TaskModeStore['unreadableAudits']> {
    return this.d.store.unreadableAudits()
  }

  // the SAME checks deliver() applies, asked at read time: what would hold a
  // wake on this task right now — null when nothing would
  private heldNow(t: TaskSnap): string | null {
    if ([...this.live.values()].some((l) => l.task === t.key)) return 'its turn is running'
    return this.busyOf(t.owner, t, this.d.conversationOf(t.owner, t.current))?.why ?? null
  }

  // the first of `agent`'s thread conversations that can't take a turn now —
  // its words and which conversation it is (E7: a console hold names it)
  private busyOf(agent: string, t: TaskSnap, conv: { sessionId: string } | null): { why: string; sessionId: string } | null {
    for (const id of new Set([...(conv ? [conv.sessionId] : []), ...this.d.holdersOf(agent, t.current)])) {
      const busy = this.d.busyWhy(id)
      if (busy) return { why: busy, sessionId: id }
    }
    return null
  }
}

// Observations differ when anything but seenAt does — or when a seenAt on
// disk is older than SEEN_REFRESH_MS (it decides how long a task Silos stops
// seeing keeps its observation, so it can't go stale for days).
export const SEEN_REFRESH_MS = 6 * 3600_000
export function observationsDiffer(prev: Readonly<Record<string, Observation>>, next: Readonly<Record<string, Observation>>, now: number): boolean {
  const a = Object.keys(prev),
    b = Object.keys(next)
  if (a.length !== b.length) return true
  for (const k of b) {
    const p = prev[k],
      n = next[k]!
    if (!p) return true
    const { seenAt: ps, ...pr } = p
    const { seenAt: ns, ...nr } = n
    if (JSON.stringify(pr) !== JSON.stringify(nr)) return true
    if (ps !== ns && now - (Date.parse(ps) || 0) >= SEEN_REFRESH_MS) return true
  }
  return false
}
