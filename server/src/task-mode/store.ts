// task-mode/store.ts — what task mode remembers, in Silos' OWN data dir
// (<dataDir>/task-mode/state.json, through safe-file.ts — never in a plan
// file beyond the fields the format already has):
//
//   observations  what Silos saw of each bound task at its last look (the
//                 dedup keys fired, the blocked moment, the note count…) —
//                 task-mode/evaluate.ts
//   throttle      per (agent, task): the fingerprint at the last delivered
//                 wake, the no-progress streak, when
//   budget        delivered wakes per agent per local day (the ceiling —
//                 the agent's taskWakesPerDay, default 30)
//   wakes         the last WAKES_KEEP wakes, each queued → delivered |
//                 superseded — the kernel kind `task-wake` the Task mode silo
//                 presents (KernelRecordSource), and the task page's history
//   armed         ONE fact per task: what its owner asked
//                 another agent through Silos (POST /api/tasks/ask) — to whom,
//                 the action and the question as written to the file, when.
//                 «Linked» is never stored: a reader derives it, the file's
//                 wait against this fact (task-flow.ts askLinked). A fact
//                 goes only when it is answered, replaced by the task's next
//                 ask, or WAKE_KEEP_MS old — never by comparison (H2)
//   armsToday     asks armed per agent per local day (the daily cap, H11)
//
// A corrupt file is set aside (backupCorruptJson) and task mode starts from a
// baseline — it wakes nothing it cannot prove, never twice what it fired.
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { readContainedTextOrNull, writeContained } from '../safe-file.js'
import { backupCorruptJson } from '../json-store.js'
import type { KernelRecord, KernelRecordSource } from '../silos/kernel-kinds.js'
import type { Observation, TaskNote, ThrottleState, WakeReason } from './evaluate.js'
import { TRANSCRIPT_UNREADABLE, type RunAudit } from '../heartbeat-audit.js'
import { endPass } from '../pass.js'

export const STATE_MAX_BYTES = 4 * 1024 * 1024
export const WAKES_KEEP = 400
export const WAKE_KEEP_MS = 30 * 24 * 3600_000

export type WakeState = 'queued' | 'delivered' | 'superseded'
// what holds a queued wake, as a class beside its
// words: the account's usage limit · its engine refused · the agent's day on
// its own (its ceiling or its spend cap) · the no-progress throttle · a
// console on its conversation · a turn on it · a live cap's slot · a failed
// start's retry · its task not found. Readers read the class, never the words.
export type HoldClass = 'limit' | 'engine' | 'ceiling' | 'throttle' | 'console' | 'turn' | 'slot' | 'backoff' | 'missing'

// (B2) what an agent asked another through Silos, for one task — the text
// is the store's, never the file's (what `to` is shown comes from here)
// `by`: the agent that asked (the task's owner then:
// a task handed on keeps the fact, and its answer names who asked)
export interface ArmedAsk {
  to: string
  action: string
  asked: string
  at: string
  by?: string
}

export interface Wake {
  id: string
  agent: string
  task: string // the plans record key
  ref: string
  title: string
  reason: WakeReason
  says: string
  at: string
  state: WakeState
  deliveredAt?: string
  session?: string
  held?: string // why it waits, plain words
  holdClass?: HoldClass // …and its class (A1.10) — set with every hold, gone with it
  until?: string // when the hold lifts on its own (throttle, budget)
  // internal: the owner's notes it carries, whether it skips the throttle
  notes: TaskNote[]
  bypassThrottle: boolean
  via?: 'wake' | 'work' | 'talk' | 'claim' // delivered by a wake turn, folded into «Work on this», into an «Open chat ›» chat turn, or into a claim's answer
  key?: string // its dedup key (evaluate.ts) — the stuck sweep finds its stall's wake by it
  // the turn that delivered it (via 'wake') and what that turn
  // cost, as its engine priced it when it ended (null: the engine said none)
  turnId?: string
  costUsd?: number | null
  model?: string // the model its turn ran (chat-init)
  priced?: boolean // its turn's provider prices (chat-done) — false keeps its cost out of the spend cap
  // a wake handed to a turn that has not
  // started working yet: it is charged — the day's ceiling, the throttle —
  // only once the turn produces something (startedAt). A turn that never
  // started (a usage limit, an engine that failed) puts it back in the queue,
  // uncharged, held until `until`; `attempts` counts those starts.
  starting?: true
  startedAt?: string
  attempts?: number
  // START_ATTEMPTS_MAX starts failed: when it
  // gave up waiting quietly and the last error — the escalation's subject
  // (engine.ts cannotStart). Cleared the moment a turn starts.
  gaveUp?: { at: string; error: string }
  // (finding 3) the first moment Silos did not find its task in the plans it
  // reads — kept queued a while (a plan mid-write, unreadable for a moment)
  missingSince?: string
  // a hold of class `console`: the conversation
  // whose open console holds it (absent when the console probe failed — not
  // known open), and the first pass that held it with that class — carried
  // from pass to pass like missingSince (also over a pass that stops earlier
  // at the engine, a retry or the limit), gone with any other decision. What
  // Needs you's «console … is open and idle» row reads, from the store alone.
  holdSession?: string
  heldSince?: string
  // (A2.9, E8) the first pass whose engine read (engineRefusal) failed while
  // the wake was held by its engine — the hold is kept at most LIMIT_RETRY_MS
  // from it; gone the moment the engine answers
  engineUnreadSince?: string
  // born of an owner's gesture (an owner's note, the owner's assign):
  // never held by a ceiling or a throttle, never charged to
  // the agent's day, ahead of every inferred wake in the live caps' queue
  gesture?: true
  // the transcript audit of the turn that delivered it
  audit?: RunAudit
  // an `answered` wake: the agent that answered —
  // what the arm-time cap counts (H9, ANSWERS_PER_TASK_DAY)
  answeredBy?: string
  // (H3) the answer came from an UNATTENDED turn: held with class `turn`
  // until that turn's audit is registered; `endedAt` the first pass that saw
  // the turn no longer live — MISSING_KEEP_MS after it with no audit, it goes
  // marked «transcript unreadable». Gone once its notes carry the mark
  answeredIn?: { agent: string; run: string; endedAt?: string }
}

// The newest audited turn on a task: the TASK is the record of its
// wake and talk turns, as a run is an automation's — what the Needs you row
// «transcript unreadable» hangs from (inbox.ts taskAuditUnreadableRow)
export interface TaskTurnAudit {
  agent: string
  ref: string
  title: string
  session: string
  turnId: string
  at: string
  audit: RunAudit
}

export interface TaskModeState {
  version: 1
  seq: number
  observations: Record<string, Observation>
  throttle: Record<string, ThrottleState> // `${agent}|${task}`
  budget: Record<string, { day: string; used: number }>
  wakes: Wake[]
  // by task key: its newest audited turn
  audits?: Record<string, TaskTurnAudit>
  // (B2) by task key: the ONE ask its owner armed (see the header)
  armed: Record<string, ArmedAsk>
  // (B2.1, H11) asks armed per agent per local day — like `budget`
  armsToday: Record<string, { day: string; used: number }>
}

const empty = (): TaskModeState => ({ version: 1, seq: 0, observations: {}, throttle: {}, budget: {}, wakes: [], armed: {}, armsToday: {} })
const isStr = (v: unknown): v is string => typeof v === 'string'
// an armed fact as the store's file may hold it — anything else is dropped
const armedOf = (raw: unknown): Record<string, ArmedAsk> => {
  const out: Record<string, ArmedAsk> = {}
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return out
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v !== 'object' || v === null) continue
    const a = v as Record<string, unknown>
    if (isStr(a.to) && a.to !== '' && isStr(a.action) && isStr(a.asked) && isStr(a.at))
      out[k] = { to: a.to, action: a.action, asked: a.asked, at: a.at, ...(isStr(a.by) && a.by !== '' ? { by: a.by } : {}) }
  }
  return out
}
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

export class TaskModeStore implements KernelRecordSource {
  readonly dir: string
  private state: TaskModeState = empty()
  private writtenAt: number | null = null

  constructor(
    dataDir: string,
    private onChange?: () => void,
  ) {
    this.dir = join(dataDir, 'task-mode')
    this.load()
  }

  private load(): void {
    let text: string | null = null
    try {
      mkdirSync(this.dir, { recursive: true, mode: 0o700 })
      text = readContainedTextOrNull(this.dir, 'state.json', { maxBytes: STATE_MAX_BYTES })
      if (text === null) return
      const raw = JSON.parse(text) as unknown
      if (!isObj(raw) || raw.version !== 1) throw new Error('not a task-mode state')
      this.state = {
        version: 1,
        seq: typeof raw.seq === 'number' ? raw.seq : 0,
        observations: isObj(raw.observations) ? (raw.observations as Record<string, Observation>) : {},
        throttle: isObj(raw.throttle) ? (raw.throttle as Record<string, ThrottleState>) : {},
        budget: isObj(raw.budget) ? (raw.budget as Record<string, { day: string; used: number }>) : {},
        wakes: Array.isArray(raw.wakes) ? (raw.wakes as Wake[]).filter((w) => isObj(w) && typeof w.id === 'string') : [],
        ...(isObj(raw.audits) ? { audits: raw.audits as Record<string, TaskTurnAudit> } : {}),
        // (B2, H11) copied field by field like the rest: a field left out
        // here is lost at the next restart
        armed: armedOf(raw.armed),
        armsToday: isObj(raw.armsToday) ? (raw.armsToday as Record<string, { day: string; used: number }>) : {},
      }
    } catch {
      if (text !== null && text !== '') {
        try {
          backupCorruptJson(join(this.dir, 'state.json'), text, 'task mode', { mode: 0o600 })
        } catch {
          /* set aside or not, start clean */
        }
      }
      this.state = empty()
    }
  }

  private save(now = Date.now()): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 })
    writeContained(this.dir, 'state.json', JSON.stringify(this.state), { mode: 0o600 })
    this.writtenAt = now
    try {
      this.onChange?.()
    } catch {
      /* the silo re-reads on its own timer */
    }
  }

  // ── reads ──
  observations(): Record<string, Observation> {
    return this.state.observations
  }
  throttleOf(agent: string, task: string): ThrottleState {
    return this.state.throttle[`${agent}|${task}`] ?? { lastFp: null, streak: 0, lastAt: null }
  }
  usedToday(agent: string, day: string): number {
    const b = this.state.budget[agent]
    return b && b.day === day ? b.used : 0
  }
  /** (B2) the ask armed on a task, or null — a fact, never «linked» */
  armedOf(task: string): ArmedAsk | null {
    return this.state.armed[task] ?? null
  }
  /** (B2) every armed fact, by task key */
  armed(): Readonly<Record<string, ArmedAsk>> {
    return this.state.armed
  }
  /** (B2.1) asks `agent` armed on the local `day` */
  armsToday(agent: string, day: string): number {
    const b = this.state.armsToday[agent]
    return b && b.day === day ? b.used : 0
  }
  wakes(): readonly Wake[] {
    return this.state.wakes
  }
  queued(): Wake[] {
    return this.state.wakes.filter((w) => w.state === 'queued')
  }
  wakesOf(task: string): Wake[] {
    return this.state.wakes.filter((w) => w.task === task)
  }
  /** The audit of a task turn by its turn id (the newest kept per task), or null. */
  auditOfTurn(turnId: string): TaskTurnAudit['audit'] | null {
    for (const a of Object.values(this.state.audits ?? {})) if (isObj(a) && a.turnId === turnId) return a.audit
    return null
  }
  /** The tasks whose NEWEST audited turn could not be read (fail closed). */
  unreadableAudits(): Array<TaskTurnAudit & { task: string }> {
    return Object.entries(this.state.audits ?? {})
      .filter(([, a]) => isObj(a) && Array.isArray(a.audit?.readOutside) && a.audit.readOutside.includes(TRANSCRIPT_UNREADABLE))
      .map(([task, a]) => ({ ...a, task }))
  }

  // ── writes (each one saves) ──
  update(fn: (s: TaskModeState) => boolean | void, now = Date.now()): void {
    // the wakes on their way change: a task's flow is read again (pass.ts)
    endPass()
    const changed = fn(this.state)
    if (changed === false) return
    // the history keeps its last WAKES_KEEP settled wakes, within
    // WAKE_KEEP_MS; a QUEUED wake is never dropped — not for age, not for
    // the count (a stall's wake lost there is an escalation that never comes)
    const keepFrom = now - WAKE_KEEP_MS
    const settled = this.state.wakes.filter((w) => w.state !== 'queued' && Date.parse(w.at) >= keepFrom)
    const keep = new Set(settled.slice(-WAKES_KEEP))
    this.state.wakes = this.state.wakes.filter((w) => w.state === 'queued' || keep.has(w))
    // the throttle of a task nobody woke within WAKE_KEEP_MS: any hold it
    // made expired long ago (evaluate.ts THROTTLE_MAX_MS) — pruned; a wake
    // after a month starts a fresh streak
    for (const [k, th] of Object.entries(this.state.throttle)) {
      const last = th.lastAt !== null ? Date.parse(th.lastAt) : NaN
      if (!(last >= keepFrom)) delete this.state.throttle[k]
    }
    // (B2, H2) an ask fact goes by AGE alone here (answered and replaced go
    // where they happen) — never because the file's wait stopped matching
    for (const [k, a] of Object.entries(this.state.armed)) if (!(Date.parse(a.at) >= keepFrom)) delete this.state.armed[k]
    this.save(now)
  }

  nextId(agent: string, ref: string, reason: WakeReason): string {
    this.state.seq += 1
    return `${agent}~${ref.replace('#', '~')}~${reason}~${this.state.seq}`
  }

  // ── KernelRecordSource: the kind `task-wake` ──
  records(): KernelRecord[] {
    return this.state.wakes.map((w) => ({
      id: w.id,
      value: {
        id: w.id,
        agent: w.agent,
        task: w.task,
        ref: w.ref,
        title: w.title,
        reason: w.reason,
        says: w.says,
        at: w.at,
        state: w.state,
        updatedBy: 'kernel',
        ...(w.deliveredAt ? { deliveredAt: w.deliveredAt } : {}),
        ...(w.session ? { session: w.session } : {}),
        ...(w.held && w.state === 'queued' ? { held: w.held } : {}),
      },
      writtenAt: Date.parse(w.deliveredAt ?? w.at) || 0,
    }))
  }

  lastWrite(): number | null {
    return this.writtenAt
  }
}
