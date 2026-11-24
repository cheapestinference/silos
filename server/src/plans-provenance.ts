// plans-provenance.ts — the plans reader STAMPS and JUDGES (the
// house of the verdict). Agents create tasks two ways — the
// API (append-item) and editing plans/*.plan.json with their file tools —
// and both are worth the same: a limit one path can skip is no limit. So
// the piece that applies the limits is the one that READS the plans:
//
//   judgeCreation   ONE source of the rules a creation is judged by (signal
//                   by turn class; quotas per signal class;
//                   the cut) — called by appendItem before writing and
//                   by the stamper when it adopts
//   judgeBirth      the allow-list at BIRTH of a task created for another
//                   owner
//   judgeTransition the allow-list of an unattended change on a task that is
//                   NOT the actor's: only appending notes
//                   survives
//   writesFile      attribution by WRITE mention only: Write/Edit's
//                   file paths and the shell commands that write the path —
//                   never a read, never an mtime
//   PlansProvenance the stamper: consumes the kernel's journal of the plans
//                   convention (cursor in ~/.silos/plans-provenance.json),
//                   diffs every reading (kernel.onReading — a rewrite that
//                   only loses a mirror field emits no journal line),
//                   attributes, adopts or cancels, reverts, re-stamps the
//                   mirror fields, and judges the restoration of what Silos
//                   cancelled or the owner undid (race (c)).
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, posix } from 'node:path'
import type { Creation, CreationsStore } from './creations.js'
import { counted } from './creations.js'
import type { Cut } from './control.js'
import { shellWriteTargets } from './heartbeat-audit.js'
import type { ToolCallRecord } from './harnesses/contract.js'
import { INITIATIVES_OPEN_MAX, INITIATIVES_PER_WEEK, PROACTIVE_OPEN_MAX } from './limits.js'
import type { LiveTurn, SealedRegime, TurnClass } from './live-turns.js'
import {
  dayMaxWakeWords,
  dayMaxWords,
  duplicateOf,
  duplicateOpenWords,
  duplicateUndoneWords,
  madeFromMissionToday,
  missionOpen,
  missionUndone,
  noteReopenRefused,
  OWN_MESSAGE_NO_SIGNAL,
  openFromMissionRoot,
  openMaxWords,
  ROUND_TASK_IS_YOURS,
  ROUND_TASK_NO_WAIT,
  type TaskNow,
} from './proactive.js'
import { runOfTurn } from './live-turns.js'
import type { Candidate, Origin, PlansOrigins } from './plans-origins.js'
import { sealHooks } from './seal-hooks.js'
import { SILOS_AUTHOR } from './system-author.js'

type Json = Record<string, unknown>
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)
const isStr = (v: unknown): v is string => typeof v === 'string'
const WEEK_MS = 7 * 24 * 3600_000
const TERMINAL = new Set(['done', 'cancelled'])

// ── the words (one source: the API's answers and the cancellation notes) ──

export const SIGNAL_REQUIRED_HEARTBEAT =
  'say what this answers: signal must name an item of your heartbeat (message:<id>, run:<id>, row:<key>, task:<key>, proposal:<id>, ask:<key>) — or "mission" in your weekly think'
// a wake or a run must name `task:<key>` or `run:<id>` — the heartbeat's
// refusal, said for these classes
export const SIGNAL_REQUIRED_TURN = "say what this answers: signal must name this turn's task (task:<key>) or run (run:<id>)"
export const MISSION_OUTSIDE_THINK = 'a mission initiative is decided in your weekly think, not here'
// the note a file-path creation the reader cancels gets: «the same phrase»
// as the API's refusal
export const noteCancelled = (words: string): string => `Silos cancelled it: ${words}`
export const weekWords = (date: string): string => `one initiative a week: you created one on ${date} — do not retry in this heartbeat`
export const OPEN_MAX_WORDS = `you have ${INITIATIVES_OPEN_MAX} things of your own from your mission open already — finish or withdraw one first`
export const cutWords = (since: string, why: string): string => `creating work of your own is stopped since ${since}: ${why} — the owner can allow it again`

export const NOTE_NO_SIGNAL =
  'Silos cancelled it: it names no signal from this turn — write "signal": "message:<id>" (or decide it in your weekly think) and create it again'
export const noteOverWeek = (date: string): string =>
  `Silos cancelled it: over your weekly initiative — you created one on ${date}. Propose it instead (POST /api/proposals)`
export const NOTE_OPEN_MAX = `Silos cancelled it: ${OPEN_MAX_WORDS}`
export const NOTE_MISSION_OUTSIDE_THINK = `Silos cancelled it: ${MISSION_OUTSIDE_THINK}`
export const noteCut = (name: string, why: string): string => `Silos cancelled it: creating work of ${name}'s own is stopped — ${why}`
export const noteTainted = (tools: string[]): string => `Undone by Silos: created after reading outside (${tools.join(', ')})`
export const noteRestored = (actor: string, owner: string): string => `Silos restored it: ${actor} changed it in an unattended turn — it is ${owner}'s task`
// the fields discarded at birth, with Silos' note
export const noteBirthCleared = (fields: string[], owner: string): string =>
  `Silos cleared ${fields.join(', ')}: a task created for ${owner} is born pending and clean — the rest is ${owner}'s to set`
export const UNATTRIBUTED_LINE = (plan: string): string => `a task appeared in ${plan} during this turn — unattributed`
export const CUT_RESTORED_CANCELLED = 'restored work Silos had cancelled'
export const CUT_RESTORED_UNDONE = 'restored work the owner had undone'

const ymd = (iso: string): string => iso.slice(0, 10)

// ── judgeCreation ──────────────────────────────────────────────────────

export interface JudgeTurn {
  class: TurnClass
  unattended: boolean
  kind?: 'look' | 'think' | 'round'
  packetKeys?: string[]
  /** a proactive heartbeat's sealed regime */
  regime?: SealedRegime
  taskKey?: string
  automationId?: string
  runId?: string
}

export interface CreationInput {
  agent: { id: string; name: string; cut?: Cut | null }
  turn: JudgeTurn
  signal?: string | undefined
  /** the agent's ledger (creations.json) */
  ledger: Creation[]
  now: number
  /** is a ledger task still open (not done, not cancelled)? */
  openTask: (ref: string) => boolean
  /** its own recurring work alive, WITHOUT acceptedFrom (INITIATIVES_OPEN_MAX
   *  counts them) */
  selfRecurrentLive: number
  // ── the proactive mode ──
  /** the root of what a non-mission signal answers: a task's (by
   *  plans-origins, whoever owns it now) or a message's. Absent: none. */
  rootOf?: (signal: string) => 'mission' | null
  /** who sent a message (a message of its own is no signal). */
  messageFrom?: (id: string) => string | null
  /** outside a heartbeat (a wake, a run — no sealed regime): whether the
   *  creating agent is proactive AT THIS MOMENT, and its count */
  proactiveNow?: SealedRegime | null
  /** the task's own fields (owner, waitingOn, title) — a task creation */
  task?: { title?: unknown; owner?: unknown; waitingOn?: unknown }
  /** the tasks' state now (open / undone blocks, the literal duplicate) */
  taskNow?: (key: string) => TaskNow | null
}

export type CreationVerdict =
  | { ok: true; judged: boolean; mission: boolean; root?: 'mission' }
  | {
      ok: false
      code: 400 | 403 | 409 | 429
      error: string
      note: string
      reason: 'cut' | 'signal' | 'mission-here' | 'week' | 'open-max' | 'own-message' | 'not-yours' | 'waits' | 'duplicate' | 'day'
    }

/** Does a non-mission signal name something of THIS turn? A
 *  heartbeat: an item of its packet. A wake: its task. A run: its run. */
export function signalMatches(turn: JudgeTurn, signal: string): boolean {
  if (turn.class === 'heartbeat') return (turn.packetKeys ?? []).includes(signal)
  if (turn.class === 'wake') return turn.taskKey !== undefined && signal === `task:${turn.taskKey}`
  if (turn.class === 'run') {
    if (!turn.automationId) return false
    return signal === `run:${turn.automationId}` || (turn.runId !== undefined && signal === `run:${turn.automationId}/${turn.runId}`)
  }
  return false
}

/** The mission initiatives that still count this week (oldest first). */
function missionThisWeek(ledger: Creation[], now: number): Creation[] {
  return ledger.filter((c) => counted(c) && c.signal === 'mission' && now - (Date.parse(c.createdAt) || 0) < WEEK_MS)
}

/** INITIATIVES_OPEN_MAX (the ONE definition): tasks CREATED by it,
 *  open, with signal mission + its own recurring work alive without
 *  acceptedFrom. Reactive work never counts here. */
export function openFromMission(ledger: Creation[], openTask: (ref: string) => boolean, selfRecurrentLive: number): number {
  const tasks = ledger.filter((c) => c.kind === 'task' && counted(c) && c.signal === 'mission' && !c.undoneAt && openTask(c.ref)).length
  return tasks + selfRecurrentLive
}

export function judgeCreation(i: CreationInput): CreationVerdict {
  // attended (console/chat with the owner in front): stamped, never judged
  if (!i.turn.unattended) return { ok: true, judged: false, mission: false }
  const cut = i.agent.cut
  if (cut) return { ok: false, code: 403, reason: 'cut', error: cutWords(ymd(cut.at), cut.why), note: noteCut(i.agent.name, cut.why) }
  const signal = typeof i.signal === 'string' ? i.signal.trim() : ''
  const required = i.turn.class === 'heartbeat' ? SIGNAL_REQUIRED_HEARTBEAT : SIGNAL_REQUIRED_TURN
  if (signal === '') return { ok: false, code: 403, reason: 'signal', error: required, note: NOTE_NO_SIGNAL }
  // the sealed regime of a proactive heartbeat; outside a heartbeat, the
  // agent's proactive mode at this moment
  const regime = i.turn.class === 'heartbeat' ? (i.turn.regime ?? null) : (i.proactiveNow ?? null)
  let root: 'mission' | null = null
  if (signal === 'mission') {
    // `mission` holds in a think and in a round; in a look, today's 403
    const here = i.turn.class === 'heartbeat' && (i.turn.kind === 'think' || i.turn.kind === 'round')
    if (!here) return { ok: false, code: 403, reason: 'mission-here', error: MISSION_OUTSIDE_THINK, note: NOTE_MISSION_OUTSIDE_THINK }
    root = 'mission'
    if (!regime) {
      // On its own, not proactive: the ONE weekly initiative, as before
      const week = missionThisWeek(i.ledger, i.now)
      if (week.length >= INITIATIVES_PER_WEEK) {
        const d = ymd(week[0]!.createdAt)
        return { ok: false, code: 429, reason: 'week', error: weekWords(d), note: noteOverWeek(d) }
      }
      if (openFromMission(i.ledger, i.openTask, i.selfRecurrentLive) >= INITIATIVES_OPEN_MAX)
        return { ok: false, code: 429, reason: 'open-max', error: OPEN_MAX_WORDS, note: NOTE_OPEN_MAX }
      return { ok: true, judged: true, mission: true, root }
    }
  } else {
    // a message of its own is no signal: its own words never launder
    // a creation out of the day's count
    if (signal.startsWith('message:') && i.messageFrom?.(signal.slice('message:'.length)) === i.agent.id) {
      return { ok: false, code: 403, reason: 'own-message', error: OWN_MESSAGE_NO_SIGNAL, note: noteCancelled(OWN_MESSAGE_NO_SIGNAL) }
    }
    // reactive: its first limit is the validity of its signal
    if (!signalMatches(i.turn, signal)) return { ok: false, code: 403, reason: 'signal', error: required, note: NOTE_NO_SIGNAL }
    root = i.rootOf?.(signal) ?? null
    // what is reactive at first hand has no count; a root mission
    // is stored — and charged only to a creator proactive by its regime
    if (root !== 'mission' || !regime) return { ok: true, judged: true, mission: false, ...(root ? { root } : {}) }
  }
  // ── root mission under a proactive regime ──
  const v = judgeMissionRoot(i, regime!)
  return v ?? { ok: true, judged: true, mission: signal === 'mission', root: 'mission' }
}

/** The proactive rules on a creation whose root is mission: on a round it
 *  is ITS task and waits on nobody; never a literal duplicate of what it
 *  has open or what was undone; within its day's count and its open cap. */
function judgeMissionRoot(i: CreationInput, regime: SealedRegime): Extract<CreationVerdict, { ok: false }> | null {
  const isTask = i.task !== undefined
  const onRound = i.turn.class === 'heartbeat'
  if (isTask && onRound) {
    const owner = i.task!.owner
    if (typeof owner === 'string' && owner !== '' && owner !== i.agent.id)
      return { ok: false, code: 403, reason: 'not-yours', error: ROUND_TASK_IS_YOURS, note: noteCancelled(ROUND_TASK_IS_YOURS) }
    if (i.task!.waitingOn !== undefined && i.task!.waitingOn !== null)
      return { ok: false, code: 400, reason: 'waits', error: ROUND_TASK_NO_WAIT, note: noteCancelled(ROUND_TASK_NO_WAIT) }
  }
  if (isTask && typeof i.task!.title === 'string' && i.taskNow) {
    // against the WHOLE ledger — every open one, every undo in 30 days —
    // never the prompt's truncated block
    const dup = duplicateOf(i.task!.title, missionOpen(i.ledger, i.taskNow), missionUndone(i.ledger, i.taskNow, i.now))
    if (dup) {
      const error = 'open' in dup ? duplicateOpenWords(dup.open.ref) : duplicateUndoneWords(dup.undone.ref)
      return { ok: false, code: 409, reason: 'duplicate', error, note: noteCancelled(error) }
    }
  }
  const made = madeFromMissionToday(i.ledger, i.now)
  if (made >= regime.perDay) {
    const error = onRound ? dayMaxWords(made) : dayMaxWakeWords(made)
    return { ok: false, code: 429, reason: 'day', error, note: noteCancelled(error) }
  }
  if (isTask) {
    const open = openFromMissionRoot(i.ledger, i.openTask)
    if (open >= PROACTIVE_OPEN_MAX) {
      const error = openMaxWords(open)
      return { ok: false, code: 429, reason: 'open-max', error, note: noteCancelled(error) }
    }
  }
  return null
}

// ── judgeBirth ─────────────────────────────────────────────────

/** What survives the birth of an unattended creation for ANOTHER owner:
 *  title, dependsOn, signal, notes — and the identity and mirror fields. */
export const BIRTH_ALLOWED: ReadonlySet<string> = new Set(['id', 'title', 'owner', 'status', 'dependsOn', 'signal', 'notes', 'createdBy', 'origin', 'run'])

/** The fields to drop (and the status to reset) of a task an unattended turn
 *  created for another owner: born `pending` and clean. Empty: nothing to do. */
export function judgeBirth(task: Json, creator: string): string[] {
  if (!isStr(task.owner) || task.owner === creator) return []
  const out: string[] = []
  for (const k of Object.keys(task)) if (!BIRTH_ALLOWED.has(k)) out.push(k)
  if (task.status !== undefined && task.status !== 'pending') out.push('status')
  return out
}

// ── judgeTransition ─────────────────────────────────────

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)

/** Notes only appended: every note before is still there, in order, first. */
export function notesAppendedOnly(before: unknown, after: unknown): boolean {
  const b = Array.isArray(before) ? before : []
  const a = Array.isArray(after) ? after : []
  if (a.length < b.length) return false
  return b.every((n, i) => same(n, a[i]))
}

export type TransitionVerdict =
  | { judge: false } // its own task (owner before AND after), nothing to judge
  | { judge: true; revert: false } // only notes appended — survives
  | { judge: true; revert: true; fields: string[]; removed: boolean }

/** An unattended change on a task by `actor`. «Its own» needs the actor to be
 *  the owner BEFORE and AFTER (a gift self→Y is judged). Everything
 *  but appending notes is reverted: state (any), owner, dependsOn,
 *  waitingOn/asked, nextCheckAt, title, a field's deletion, the task's
 *  removal. */
export function judgeTransition(before: Json, after: Json | null, actor: string): TransitionVerdict {
  if (after !== null && before.owner === actor && after.owner === actor) return { judge: false }
  if (after === null) return { judge: true, revert: true, fields: [], removed: true }
  const fields: string[] = []
  for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (k === 'notes') {
      if (!notesAppendedOnly(before.notes, after.notes)) fields.push(k)
      continue
    }
    if (!same(before[k], after[k])) fields.push(k)
  }
  return fields.length === 0 ? { judge: true, revert: false } : { judge: true, revert: true, fields, removed: false }
}

/** The task restored: `before`, with the notes appended since kept (they
 *  survive — they carry their provenance) — unless the notes themselves
 *  were rewritten, then before's notes. What a REMOVED task comes back as. */
export function restoredTask(before: Json, after: Json | null): Json {
  const out: Json = JSON.parse(JSON.stringify(before)) as Json
  if (after && notesAppendedOnly(before.notes, after.notes) && Array.isArray(after.notes)) out.notes = JSON.parse(JSON.stringify(after.notes)) as unknown[]
  return out
}

/** A verdict restores ONLY the fields it judged —
 *  each back to its value in `before` (absent there: removed) — over the task
 *  AS IT IS NOW: what was written after the judged change (the owner's
 *  hand, a Done, an answer through Silos) stays. Notes rewritten come back
 *  as before's; appended ones are kept (restoredTask's rule). */
export function restoredFields(before: Json, now: Json, fields: readonly string[]): Json {
  const out: Json = JSON.parse(JSON.stringify(now)) as Json
  for (const f of fields) {
    if (f === 'notes') {
      if (!notesAppendedOnly(before.notes, now.notes)) {
        if (before.notes === undefined) delete out.notes
        else out.notes = JSON.parse(JSON.stringify(before.notes)) as unknown
      }
      continue
    }
    if (before[f] === undefined) delete out[f]
    else out[f] = JSON.parse(JSON.stringify(before[f])) as unknown
  }
  return out
}

// ── attribution by WRITE ───────────────────────────────────────

/** Did these calls WRITE `file`? Write/Edit's paths (`writes`), and shell
 *  commands writing it (redirection, tee, cp/mv destination, sed -i …) —
 *  best effort, declared as such. A read (cat, grep, the `disk` counter of
 *  attributePlanMentions) never attributes. */
export function writesFile(calls: ToolCallRecord[], file: string, cwd: string, home: string): boolean {
  const abs = (p: string): string => {
    let s = p
    if (s === '~' || s.startsWith('~/')) s = home + s.slice(1)
    s = s.replace(/^\$\{HOME\}|^\$HOME\b/, home)
    return posix.resolve(cwd, s)
  }
  for (const c of calls) {
    for (const w of c.writes ?? []) if (abs(w) === file) return true
    if (c.command) for (const w of shellWriteTargets(c.command)) if (abs(w) === file) return true
  }
  return false
}

// ── the stamper ────────────────────────────────────────────────────────

export interface TaskView {
  key: string
  file: string
  /** the folder the plan belongs to (the project) */
  location: string
  raw: Json
}

/** One reading of the plans silo, flattened to its tasks. */
export interface PlansSnapshot {
  tasks: Map<string, TaskView>
  complete: boolean
}

export interface ProvenanceAgent {
  id: string
  name: string
  cut?: Cut | null
  folders: string[]
}

export interface WriterProbe {
  /** did this candidate's transcript WRITE `file`? null: unreadable */
  wrote(c: Candidate, file: string): Promise<boolean | null>
}

export interface ProvenanceDeps {
  origins: PlansOrigins
  creations: CreationsStore
  /** <dataDir>/plans-provenance.json */
  cursorFile: string
  agents: () => ProvenanceAgent[]
  /** everything live of an agent (live-turns.ts liveOf) */
  liveOf: (agentId: string) => LiveTurn[]
  probe: WriterProbe
  /** Silos' own writes on a task (SiloActions.silosWriteChild) */
  write: (key: string, mutate: (child: Json | null, list: unknown[]) => { write: boolean } | string, text: string) => { ok: boolean; reason?: string }
  /** the journal lines of the plans convention from a cursor */
  journal: () => Array<{
    dir: string
    read: (n: number) => { lines: Array<{ at: string; event: string; key?: string; kind?: string; from?: string | null; to?: string | null }>; next: number }
  }>
  /** the run's verdict once its turn ended (its audit written): tainted ⇒
   *  the creation is undone at adoption. null: not ended / unknown */
  runVerdict: (agentId: string, run: string) => { tainted: boolean; readOutside: string[] } | null
  /** its own live recurring work without acceptedFrom */
  selfRecurrentLive: (agentId: string) => number
  /** the cut of an agent */
  cut: (agentId: string, why: string, run: string | undefined) => void
  /** a line in a run's record (unattributed appearances) */
  noteRun?: (c: Candidate, text: string) => void
  /** the readOutside of a run whose audit is already written (any class), or null */
  runReadOutside?: (agentId: string, run: string) => string[] | null
  /** an owner steal reverted: cancel what it started — the turns
   *  and queued wakes of anyone but `owner`, the owner restored (J3, K5) */
  ownerRestored?: (key: string, owner: string) => void
  // ── the proactive mode — the same rules as the API ──
  /** the root of a non-mission signal of this agent's turn */
  rootOf?: (agentId: string, signal: string) => 'mission' | null
  /** who sent a message (a message of its own is no signal) */
  messageFrom?: (agentId: string, id: string) => string | null
  /** the agent's proactive mode NOW (a wake or a run — no sealed regime) */
  proactiveNow?: (agentId: string) => SealedRegime | null
  /** a task's state now: the open / undone blocks and the literal duplicate */
  taskNow?: (key: string) => TaskNow | null
  /** when the OWNER dropped the task (the last recorded status event is the
   *  owner's cancel — task-cancellations.ts), or null */
  ownerDrop?: (key: string) => string | null
  now?: () => number
}

interface Pending {
  key: string
  file: string
  kind: 'appeared' | 'transition' | 'removed' | 'resurrected'
  before: Json | null
  after: Json | null
  candidates: Candidate[]
  since: string
}

/** The candidate turns of a change in `file`: everything live of each agent
 *  whose folders hold the file. */
function candidatesFor(deps: ProvenanceDeps, file: string, unattended: boolean, now: number): Candidate[] {
  const out: Candidate[] = []
  for (const a of deps.agents()) {
    if (!a.folders.some((f) => file === f || file.startsWith(f.endsWith('/') ? f : `${f}/`))) continue
    for (const t of deps.liveOf(a.id)) {
      if (t.unattended !== unattended) continue
      out.push(candidateOf(t, now))
    }
  }
  return out
}

/** What the judge knows of a live turn — its class, kind, packet keys and
 *  SEALED regime, never the agent's mode now. */
export function judgeTurnOf(t: Pick<LiveTurn, 'class' | 'unattended' | 'kind' | 'packetKeys' | 'regime' | 'taskKey' | 'automationId' | 'runId'>): JudgeTurn {
  return {
    class: t.class,
    unattended: t.unattended,
    ...(t.kind ? { kind: t.kind } : {}),
    ...(t.packetKeys ? { packetKeys: t.packetKeys } : {}),
    ...(t.regime ? { regime: { tools: t.regime.tools, perDay: t.regime.perDay } } : {}),
    ...(t.taskKey ? { taskKey: t.taskKey } : {}),
    ...(t.automationId ? { automationId: t.automationId } : {}),
    ...(t.runId ? { runId: t.runId } : {}),
  }
}

function candidateOf(t: LiveTurn, now: number): Candidate & { turn: JudgeTurn } {
  return {
    agentId: t.agentId,
    run: runOfTurn(t),
    turnId: t.turnId,
    startedAt: t.at || new Date(now).toISOString(),
    ...(t.sessionId !== undefined ? { sessionId: t.sessionId } : {}),
    turn: judgeTurnOf(t),
  }
}

const turnOf = (c: Candidate): JudgeTurn => (c as Candidate & { turn?: JudgeTurn }).turn ?? { class: 'wake', unattended: true }

export class PlansProvenance {
  private snap: Map<string, TaskView> | null = null
  private pending: Pending[] = []
  // what Silos itself just wrote on a key: the next reading that shows it is
  // ours, never judged
  private expected = new Map<string, string>()
  // the folders whose first watch (baseline) left unknown tasks
  private cursors: Record<string, number>
  private busy = false

  constructor(private deps: ProvenanceDeps) {
    this.cursors = this.loadCursors()
    // the verdicts that were waiting for their turns' end when the server
    // stopped: a restart kills every SDK turn, so the first settle reads
    // their transcripts and judges them — nothing is lost by a restart
    this.pending = this.loadPending()
    this.savedPending = JSON.stringify(this.pending)
  }
  private savedPending = '[]'

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  // ---- cursor ---------------------------------------------------------

  private loadCursors(): Record<string, number> {
    try {
      if (!existsSync(this.deps.cursorFile)) return {}
      const raw = JSON.parse(readFileSync(this.deps.cursorFile, 'utf8')) as { cursors?: unknown }
      return isObj(raw.cursors) ? (Object.fromEntries(Object.entries(raw.cursors).filter(([, v]) => typeof v === 'number')) as Record<string, number>) : {}
    } catch {
      return {}
    }
  }

  private loadPending(): Pending[] {
    try {
      if (!existsSync(this.deps.cursorFile)) return []
      const raw = JSON.parse(readFileSync(this.deps.cursorFile, 'utf8')) as { pending?: unknown }
      return Array.isArray(raw.pending)
        ? raw.pending.filter((p): p is Pending => isObj(p) && isStr(p.key) && isStr(p.file) && isStr(p.kind) && Array.isArray(p.candidates))
        : []
    } catch {
      return []
    }
  }

  /** persist the pending verdicts when they changed */
  private savePending(): void {
    const now = JSON.stringify(this.pending)
    if (now === this.savedPending) return
    this.savedPending = now
    this.saveCursors()
  }

  private saveCursors(): void {
    const f = this.deps.cursorFile
    const text = `${JSON.stringify({ cursors: this.cursors, pending: this.pending }, null, 2)}\n`
    mkdirSync(dirname(f), { recursive: true, mode: 0o700 })
    if (sealHooks().write?.(f, text) === true) return
    const tmp = `${f}.tmp`
    writeFileSync(tmp, text, { mode: 0o600 })
    renameSync(tmp, f)
  }

  // ---- API-path registration -------------------------------------------

  /** The origin of a task created through Silos' own paths, registered
   *  BEFORE the file write (its reading then finds it known — case (1)). */
  expectOrigin(key: string, o: Origin): void {
    this.deps.origins.set(key, o)
  }

  /** Silos is about to write this task to this shape (its own write). */
  private expect(key: string, task: Json | null): void {
    this.expected.set(key, task === null ? 'null' : JSON.stringify(task))
  }

  /** Silos' OWN write of a task through an API
   *  route (an ask armed, an ask answered, the escalation's hop): the shape
   *  it writes is expected — the reading that shows it is ours, never judged
   *  — AND it becomes the snapshot's base for that key, so an agent that
   *  touches the same task before the next reading (a note of its own) is
   *  judged against what Silos wrote, never against the shape before it: an
   *  unattended turn that answers and edits the same plan never reverts
   *  Silos' write. Called inside the write's mutator, before the file is
   *  replaced; the answer UNDOES the registration when the write did not
   *  land (call it then). */
  ownWrite(key: string, shape: Json): () => void {
    const raw = JSON.parse(JSON.stringify(shape)) as Json
    const prevExpected = this.expected.get(key)
    const prevSnap = this.snap?.get(key)
    this.expect(key, raw)
    const view = prevSnap ?? this.latest?.tasks.get(key)
    if (this.snap && view) this.snap.set(key, { ...view, raw })
    return () => {
      if (this.expected.get(key) === JSON.stringify(raw)) {
        if (prevExpected === undefined) this.expected.delete(key)
        else this.expected.set(key, prevExpected)
      }
      if (this.snap && prevSnap && this.snap.get(key)?.raw === raw) this.snap.set(key, prevSnap)
    }
  }

  // ---- the reading -----------------------------------------------------

  /** kernel.onReading for the plans silo. Never throws. */
  onReading(snapshot: PlansSnapshot): void {
    if (this.busy) {
      this.latest = snapshot
      return
    }
    this.busy = true
    try {
      let s: PlansSnapshot | null = snapshot
      while (s) {
        this.latest = null
        this.process(s)
        s = this.latest
      }
    } catch (err) {
      console.warn('plans-provenance: a reading could not be judged —', err instanceof Error ? err.message : err)
    } finally {
      this.busy = false
    }
  }
  private latest: PlansSnapshot | null = null

  private process(s: PlansSnapshot): void {
    const now = this.now()
    const before = this.snap
    // 1. the journal: appeared / baseline / removed / transitions, from the cursor
    const appearedKeys = new Set<string>()
    const baselineKeys = new Set<string>()
    for (const j of this.deps.journal()) {
      const cur = this.cursors[j.dir] ?? 0
      const { lines, next } = j.read(cur)
      for (const l of lines) {
        if (l.kind !== 'plan/task' || !l.key) continue
        if (l.event === 'baseline') baselineKeys.add(l.key)
        if (l.event === 'appeared') appearedKeys.add(l.key)
      }
      if (next !== cur) {
        this.cursors[j.dir] = next
        this.saveCursors()
      }
    }
    for (const key of baselineKeys) {
      if (this.deps.origins.get(key)) continue
      const t = s.tasks.get(key)
      this.deps.origins.set(key, { by: 'unknown', how: 'baseline', at: new Date(now).toISOString(), ...(t ? { file: t.file, title: titleOf(t.raw) } : {}) })
    }
    // 2. diff the reading against the last one (every field — a rewrite
    //    losing a mirror field emits no journal line)
    for (const [key, t] of s.tasks) {
      const exp = this.expected.get(key)
      if (exp !== undefined) {
        if (exp === JSON.stringify(t.raw)) {
          this.expected.delete(key)
          continue
        }
      }
      const prev = before?.get(key)
      const isNew = appearedKeys.has(key) || (before !== null && !prev && !baselineKeys.has(key))
      if (isNew && !baselineKeys.has(key)) {
        this.appeared(t, now)
        continue
      }
      if (prev && !same(prev.raw, t.raw)) this.changed(prev, t, now)
      this.restampMirror(t)
    }
    if (before && s.complete) {
      for (const [key, prev] of before) {
        if (s.tasks.has(key)) continue
        if (this.expected.get(key) === 'null') {
          this.expected.delete(key)
          continue
        }
        this.queue({ key, file: prev.file, kind: 'removed', before: prev.raw, after: null }, now)
      }
    }
    this.snap = new Map(s.tasks)
    this.savePending()
    void this.settle()
  }

  // ---- appeared ------------------------------------------------------------

  private appeared(t: TaskView, now: number): void {
    const known = this.deps.origins.get(t.key)
    if (known && !known.provisional) {
      // (1) the API path registered it before the file write
      if (known.creation) this.birthClean(t, known.creation.agent)
      return
    }
    const unattended = candidatesFor(this.deps, t.file, true, now)
    if (unattended.length > 0) {
      // ONE or several candidates: provisional, no verdict — it waits for
      // the turns' end and a WRITE in their transcript
      this.deps.origins.set(t.key, {
        by: 'unknown',
        how: 'unclaimed',
        at: new Date(now).toISOString(),
        file: t.file,
        title: titleOf(t.raw),
        provisional: { candidates: unattended, since: new Date(now).toISOString() },
      })
      this.pending.push({ key: t.key, file: t.file, kind: 'appeared', before: null, after: t.raw, candidates: unattended, since: new Date(now).toISOString() })
      return
    }
    // (3) no unattended turn live: an attended conversation of an agent that
    // WROTE the plan claims it (post hoc, never by a read); else unknown
    this.deps.origins.set(t.key, { by: 'unknown', how: 'unclaimed', at: new Date(now).toISOString(), file: t.file, title: titleOf(t.raw) })
    const attended = candidatesFor(this.deps, t.file, false, now)
    if (attended.length > 0)
      this.pending.push({ key: t.key, file: t.file, kind: 'appeared', before: null, after: t.raw, candidates: attended, since: new Date(now).toISOString() })
  }

  // ---- a change on a known task -----------------------------------------

  private changed(prev: TaskView, t: TaskView, now: number): void {
    const from = isStr(prev.raw.status) ? prev.raw.status : ''
    const to = isStr(t.raw.status) ? t.raw.status : ''
    // race (c): a ref Silos cancelled or the owner undid comes back alive
    if (from === 'cancelled' && !TERMINAL.has(to) && this.resurrectable(t.key)) {
      this.queue({ key: t.key, file: t.file, kind: 'resurrected', before: prev.raw, after: t.raw }, now)
      return
    }
    this.queue({ key: t.key, file: t.file, kind: 'transition', before: prev.raw, after: t.raw }, now)
  }

  private queue(p: Omit<Pending, 'candidates' | 'since'>, now: number): void {
    const unattended = candidatesFor(this.deps, p.file, true, now)
    const attended = p.kind === 'resurrected' ? candidatesFor(this.deps, p.file, false, now) : []
    if (unattended.length === 0 && attended.length === 0) {
      // nobody to attribute it to: it stays (it may be human) — and a
      // restoration nobody claims is the owner's: adopted
      if (p.kind === 'resurrected') this.adoptRestored(p.key, p.after, 'kept by the owner')
      return
    }
    this.pending.push({ ...p, candidates: [...unattended, ...attended], since: new Date(now).toISOString() })
  }

  /** The ledger entry and the origin of a ref that was rejected or undone —
   *  or, a task it created from its mission, that the OWNER dropped (what
   *  the owner undid stays undone, whatever the way). */
  private resurrectable(key: string): { agent: string; entry: Creation | null; origin: Origin | null; undone: boolean } | null {
    const o = this.deps.origins.get(key)
    if (o?.creation) {
      const c = this.deps.creations.byRef(o.creation.agent, key)
      if (c && ((c.rejected && !c.adopted) || c.undoneAt)) return { agent: o.creation.agent, entry: c, origin: o, undone: !!c.undoneAt || !!o.undoneAt }
      const drop = c && c.root === 'mission' && counted(c) ? (this.deps.ownerDrop?.(key) ?? null) : null
      // the owner's Drop since the last time a restoration was adopted
      if (c && drop !== null && (!c.adopted || (Date.parse(c.adopted.at) || 0) < (Date.parse(drop) || 0)))
        return { agent: o.creation.agent, entry: c, origin: o, undone: true }
    }
    if (o?.undoneAt) return { agent: '', entry: null, origin: o, undone: true }
    return null
  }

  /** A task of its own created from its mission, done or cancelled, that its
   *  creator reopens in a proactive turn (its sealed regime; a wake or a run:
   *  its mode now) is a creation of that day: it
   *  spends the day's count — over the count or the open cap it goes back
   *  to what it was, with the API's own phrase. true: it was set back. */
  private reopenOverCount(p: Pending, actor: Candidate, now: number): boolean {
    const from = isStr(p.before?.status) ? p.before!.status : ''
    const to = isStr(p.after?.status) ? p.after!.status : ''
    if (!p.after || !TERMINAL.has(from) || TERMINAL.has(to)) return false
    if (this.deps.origins.get(p.key)?.creation?.agent !== actor.agentId) return false
    const c = this.deps.creations.byRef(actor.agentId, p.key)
    if (!c || c.kind !== 'task' || c.root !== 'mission' || !counted(c)) return false
    const turn = turnOf(actor)
    const regime = turn.class === 'heartbeat' ? (turn.regime ?? null) : (this.deps.proactiveNow?.(actor.agentId) ?? null)
    if (!regime) return false
    const ledger = this.deps.creations.list(actor.agentId)
    const made = madeFromMissionToday(ledger, now)
    let words: string | null = null
    if (made >= regime.perDay) words = turn.class === 'heartbeat' ? dayMaxWords(made) : dayMaxWakeWords(made)
    else {
      const open = openFromMissionRoot(ledger, (ref) => ref !== p.key && this.isOpen(ref))
      if (open >= PROACTIVE_OPEN_MAX) words = openMaxWords(open)
    }
    if (words === null) {
      this.deps.creations.update(actor.agentId, c.id, { reopenedAt: [...(c.reopenedAt ?? []), new Date(now).toISOString()] })
      return false
    }
    const note = noteReopenRefused(from, words)
    this.writeTask(
      p.key,
      (child) => {
        if (!child) return { write: false }
        child.status = from
        pushNote(child, note, now)
        return { write: true }
      },
      note,
    )
    return true
  }

  // ---- settle: the verdicts whose turns ended ----------------------------

  /** Judge every pending change whose candidate turns all ended. Called on
   *  each reading and by the server's tick. */
  async settle(): Promise<void> {
    if (this.settling) return
    this.settling = true
    try {
      const now = this.now()
      const keep: Pending[] = []
      const ready: Pending[] = []
      for (const p of this.pending) {
        const live = p.candidates.some((c) => this.deps.liveOf(c.agentId).some((t) => t.turnId === c.turnId))
        ;(live ? keep : ready).push(p)
      }
      this.pending = keep
      for (const p of ready) {
        const writers: Candidate[] = []
        for (const c of p.candidates) if ((await this.deps.probe.wrote(c, p.file).catch(() => null)) === true) writers.push(c)
        this.verdict(p, writers, now)
      }
      this.savePending()
    } finally {
      this.settling = false
    }
  }
  private settling = false

  private verdict(p: Pending, writers: Candidate[], now: number): void {
    const unattended = writers.filter((c) => turnOf(c).unattended)
    const attended = writers.filter((c) => !turnOf(c).unattended)
    if (p.kind === 'appeared') {
      if (unattended.length === 1 && attended.length === 0) {
        this.adopt(p, unattended[0]!, now)
        return
      }
      if (unattended.length === 0 && attended.length === 1 && p.candidates.every((c) => !turnOf(c).unattended)) {
        const c = attended[0]!
        this.deps.origins.set(p.key, { by: c.agentId, how: 'attended', at: new Date(now).toISOString(), file: p.file, title: titleOf(p.after ?? {}) })
        return
      }
      // none or a tie: unknown, no quota against anybody, a line in each
      // candidate run's record; the task stays (it may be the owner's)
      this.deps.origins.patch(p.key, { by: 'unknown', how: 'unclaimed', clear: ['provisional'] })
      if (p.candidates.some((c) => turnOf(c).unattended))
        for (const c of p.candidates) if (turnOf(c).unattended) this.deps.noteRun?.(c, UNATTRIBUTED_LINE(posix.basename(p.file)))
      return
    }
    if (p.kind === 'resurrected') {
      const r = this.resurrectable(p.key)
      if (!r) return
      // attributable to an unattended turn of the agent ⇒ re-cancel + cut
      const culprit = unattended.length === 1 ? unattended[0]! : null
      if (culprit) {
        const why = r.undone ? CUT_RESTORED_UNDONE : CUT_RESTORED_CANCELLED
        this.writeTask(
          p.key,
          (child) => {
            if (!child) return { write: false }
            child.status = 'cancelled'
            pushNote(child, `Silos cancelled it again: ${why}`, now)
            return { write: true }
          },
          `cancelled again: ${why}`,
        )
        this.deps.cut(culprit.agentId, why, culprit.run)
        return
      }
      const label = attended.length === 1 && r.agent !== '' && attended[0]!.agentId === r.agent ? 'restored in an attended conversation' : 'kept by the owner'
      this.adoptRestored(p.key, p.after, label)
      return
    }
    // a transition / removal: judged only when ONE unattended writer did it
    if (unattended.length !== 1 || !p.before) return
    const actor = unattended[0]!
    if (this.reopenOverCount(p, actor, now)) return
    const v = judgeTransition(p.before, p.after, actor.agentId)
    // what survives and is read as context carries its run
    if (!v.judge || !v.revert) this.markRun(p, actor, v.judge)
    if (!v.judge || !v.revert) return
    const owner = isStr(p.before.owner) ? p.before.owner : 'its owner'
    const actorName = this.nameOf(actor.agentId)
    // (K1) only the fields judged, over the task as it is now — the whole
    // task only when it was removed (or is gone now)
    const current = this.currentRaw(p.key)
    const restored = v.removed || current === null ? restoredTask(p.before, current) : restoredFields(p.before, current, v.fields)
    pushNote(restored, noteRestored(actorName, owner === 'owner' ? 'the owner' : this.nameOf(owner)), now)
    this.writeTask(
      p.key,
      (child, list) => {
        if (child) {
          for (const k of Object.keys(child)) delete child[k]
          Object.assign(child, restored)
        } else list.push(restored)
        return { write: true }
      },
      `restored: ${actorName} changed it in an unattended turn`,
    )
    this.deps.creations.add(actor.agentId, {
      kind: 'task',
      ref: p.key,
      title: titleOf(p.before),
      createdAt: new Date(now).toISOString(),
      run: actor.run,
      by: actor.agentId,
      rejected: {
        at: new Date(now).toISOString(),
        why: `changed ${owner === 'owner' ? "the owner's" : `${this.nameOf(owner)}'s`} task in an unattended turn — Silos restored it`,
      },
    })
    // (J3, K5) what the steal started is cancelled — never the restored
    // owner's own turns nor its queued wakes
    if (v.fields.includes('owner')) this.deps.ownerRestored?.(p.key, isStr(p.before.owner) ? p.before.owner : '')
  }

  /** A note appended on a task of another owner, or a question asked to the
   *  owner on its own task, by an unattended run: marked with its run. */
  private markRun(p: Pending, actor: Candidate, foreign: boolean): void {
    if (!p.after) return
    const at = new Date(this.now()).toISOString()
    const known = this.deps.runReadOutside?.(actor.agentId, actor.run) ?? null
    const mark = (kind: 'note' | 'ask', noteAts?: string[]): void =>
      this.deps.origins.addMark(p.key, {
        kind,
        at,
        run: actor.run,
        agent: actor.agentId,
        ...(known && known.length > 0 ? { readOutside: known } : {}),
        ...(noteAts ? { noteAts } : {}),
      })
    const before = Array.isArray(p.before?.notes) ? (p.before!.notes as unknown[]).length : 0
    const added = (Array.isArray(p.after.notes) ? (p.after.notes as unknown[]) : [])
      .slice(before)
      .filter(isObj)
      .filter((n) => n.by === actor.agentId && isStr(n.at))
      .map((n) => n.at as string)
    if (foreign && added.length > 0) mark('note', added)
    const asked = (t: Json | null): unknown => (t && isObj(t.waitingOn) ? t.waitingOn.asked : undefined)
    if (!foreign && asked(p.after) !== undefined && !same(asked(p.before), asked(p.after))) mark('ask')
  }

  // ---- adoption -------------------------------------------------------------

  private adopt(p: Pending, c: Candidate, now: number): void {
    const raw = this.currentRaw(p.key) ?? p.after ?? {}
    const agent = this.deps.agents().find((a) => a.id === c.agentId)
    const ledger = this.deps.creations.list(c.agentId)
    const signal = isStr(raw.signal) ? raw.signal : undefined
    const v = judgeCreation({
      agent: { id: c.agentId, name: agent?.name ?? c.agentId, cut: agent?.cut ?? null },
      turn: turnOf(c),
      signal,
      ledger,
      now,
      openTask: (ref) => this.isOpen(ref),
      selfRecurrentLive: this.deps.selfRecurrentLive(c.agentId),
      // the same proactive rules as append-item: by
      // file, the reader cancels a duplicate, a foreign owner and a wait
      // with the API's own phrase
      ...(this.deps.rootOf ? { rootOf: (sig: string) => this.deps.rootOf!(c.agentId, sig) } : {}),
      ...(this.deps.messageFrom ? { messageFrom: (id: string) => this.deps.messageFrom!(c.agentId, id) } : {}),
      proactiveNow: this.deps.proactiveNow?.(c.agentId) ?? null,
      task: { title: raw.title, owner: raw.owner, waitingOn: raw.waitingOn },
      ...(this.deps.taskNow ? { taskNow: this.deps.taskNow } : {}),
    })
    const at = new Date(now).toISOString()
    // the run's readOutside goes on what it adopts, ALWAYS: the
    // adoption comes after the end-of-turn re-stamp and would
    // otherwise lose the mark — a round with its tools marks, never undoes
    const outside = this.deps.runReadOutside?.(c.agentId, c.run) ?? null
    const entry = this.deps.creations.add(c.agentId, {
      kind: 'task',
      ref: p.key,
      title: titleOf(raw),
      createdAt: at,
      run: c.run,
      by: c.agentId,
      ...(signal ? { signal } : {}),
      ...(v.ok && v.root ? { root: v.root } : {}),
      ...(outside && outside.length > 0 ? { readOutside: [...outside] } : {}),
      ...(v.ok ? {} : { rejected: { at, why: v.error } }),
    })
    this.deps.origins.set(p.key, { by: c.agentId, how: 'creation', at, file: p.file, title: titleOf(raw), creation: { agent: c.agentId, id: entry.id } })
    if (!v.ok) {
      this.cancelWith(p.key, v.note, now)
      return
    }
    // the verdict of its run, if its turn already ended
    const verdict = this.deps.runVerdict(c.agentId, c.run)
    if (verdict?.tainted) {
      this.deps.creations.update(c.agentId, entry.id, { rejected: { at, why: noteTainted(verdict.readOutside) }, readOutside: verdict.readOutside })
      this.cancelWith(p.key, noteTainted(verdict.readOutside), now)
      return
    }
    this.birthClean({ key: p.key, file: p.file, location: '', raw }, c.agentId)
    this.restampMirror({ key: p.key, file: p.file, location: '', raw: this.currentRaw(p.key) ?? raw })
  }

  /** a restoration nobody punishes — adopted with its real
   *  author's label; consumes its class's quota (counted() says so). */
  private adoptRestored(key: string, _after: Json | null, label: 'kept by the owner' | 'restored in an attended conversation'): void {
    const r = this.resurrectable(key)
    if (!r) return
    const at = new Date(this.now()).toISOString()
    if (r.entry)
      this.deps.creations.update(r.agent, r.entry.id, {
        adopted: { at, label },
        ...(r.entry.undoneAt ? { keptAt: at } : {}),
        clear: r.entry.undoneAt ? ['undoneAt', 'undoneBy'] : [],
      })
    if (r.origin?.undoneAt) this.deps.origins.patch(key, { keptAt: at, clear: ['undoneAt', 'undoneBy'] })
  }

  // ---- writes -------------------------------------------------------------

  private cancelWith(key: string, note: string, now: number): void {
    this.writeTask(
      key,
      (child) => {
        if (!child) return { write: false }
        child.status = 'cancelled'
        pushNote(child, note, now)
        return { write: true }
      },
      note,
    )
  }

  /** a creation for another owner is born pending and clean. */
  private birthClean(t: TaskView, creator: string): void {
    const raw = this.currentRaw(t.key) ?? t.raw
    const drop = judgeBirth(raw, creator)
    if (drop.length === 0) return
    const owner = isStr(raw.owner) ? raw.owner : ''
    const note = noteBirthCleared(drop, owner === 'owner' ? 'the owner' : this.nameOf(owner))
    this.writeTask(
      t.key,
      (child) => {
        if (!child) return { write: false }
        for (const k of drop) if (k !== 'status') delete child[k]
        child.status = 'pending'
        pushNote(child, note, this.now())
        return { write: true }
      },
      note,
    )
  }

  /** (a) the ledger is the truth: the mirror fields come back after a rewrite. */
  private restampMirror(t: TaskView): void {
    const o = this.deps.origins.get(t.key)
    if (!o || o.provisional) return
    const want: Json = {}
    if (o.creation) {
      const c = this.deps.creations.byRef(o.creation.agent, t.key)
      if (!c) return
      want.createdBy = c.by
      want.origin = 'self'
      if (c.run) want.run = c.run
      if (c.signal) want.signal = c.signal
    } else if (o.by === 'owner' || (o.how === 'attended' && o.by !== 'unknown')) {
      want.createdBy = o.by
    } else return
    const raw = t.raw
    if (Object.entries(want).every(([k, v]) => raw[k] === v)) return
    this.writeTask(
      t.key,
      (child) => {
        if (!child) return { write: false }
        let changed = false
        for (const [k, v] of Object.entries(want))
          if (child[k] !== v) {
            child[k] = v
            changed = true
          }
        return { write: changed }
      },
      're-stamped its origin',
    )
  }

  private writeTask(key: string, mutate: (child: Json | null, list: unknown[]) => { write: boolean } | string, text: string): void {
    let after: Json | null = null
    const r = this.deps.write(
      key,
      (child, list) => {
        const out = mutate(child, list)
        if (typeof out !== 'string' && out.write)
          after = (child ?? list.filter(isObj).find((x) => x.id === key.slice(key.lastIndexOf('/') + 1)) ?? null) as Json | null
        if (typeof out !== 'string' && out.write) this.expect(key, after ? (JSON.parse(JSON.stringify(after)) as Json) : null)
        return out
      },
      text,
    )
    if (!r.ok && r.reason) console.warn(`plans-provenance: could not write ${key} — ${r.reason}`)
  }

  // ---- helpers -------------------------------------------------------------

  private currentRaw(key: string): Json | null {
    return this.latest?.tasks.get(key)?.raw ?? this.snap?.get(key)?.raw ?? null
  }

  private isOpen(ref: string): boolean {
    const t = this.currentRaw(ref)
    return t !== null && !TERMINAL.has(String(t.status ?? ''))
  }

  private nameOf(id: string): string {
    return this.deps.agents().find((a) => a.id === id)?.name ?? id
  }

  /** The changes still waiting for their turns' end (tests, the screen). */
  waiting(): Array<{ key: string; kind: string; candidates: number }> {
    return this.pending.map((p) => ({ key: p.key, kind: p.kind, candidates: p.candidates.length }))
  }
}

function titleOf(t: Json): string {
  return isStr(t.title) ? t.title : ''
}

function pushNote(child: Json, text: string, now: number): void {
  const notes = Array.isArray(child.notes) ? child.notes : []
  child.notes = [...notes, { at: new Date(now).toISOString(), by: SILOS_AUTHOR, text }]
}

/** The tasks of a plans reading, keyed like the journal and Task mode. */
export function plansSnapshotOf(
  records: Array<{ kind: string; location: string; record: { id: string }; file: string; raw: unknown; partial?: string[] }>,
): PlansSnapshot {
  const tasks = new Map<string, TaskView>()
  let complete = true
  for (const r of records) {
    if (r.kind !== 'plan' || !isObj(r.raw)) continue
    if (r.partial?.includes('tasks')) complete = false
    const list = Array.isArray(r.raw.tasks) ? r.raw.tasks : []
    for (const t of list) {
      if (!isObj(t) || !isStr(t.id)) continue
      const key = `${r.location}/${r.record.id}/tasks/${t.id}`
      tasks.set(key, { key, file: r.file, location: r.location, raw: JSON.parse(JSON.stringify(t)) as Json })
    }
  }
  return { tasks, complete }
}
