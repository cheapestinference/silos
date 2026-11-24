// execution.ts — reading an agent's PLAN EXECUTION out of its subagent
// census. A session that executes a plan with subagent-driven development
// (superpowers) dispatches one subagent per step and names each one by a
// fixed pattern (the skill's prompt templates):
//
//   "Implement Task 12: OpenCode console route"   → implement, task 12, title
//   "Review Task 12 (spec + quality)"              → review,    task 12
//   "Re-review Task 9 fix round 2"                 → re-review, task 9, round 2
//
// The skill does not use the CLI's task list, but its controller keeps a
// LEDGER (progress.md) beside the plan document it executes; the server
// reads both into an ExecutionRecord (detail.execution). That record is now
// the FIRST source of done/total and of task titles:
// it is what the executor itself wrote down — the same record the Executions
// silo lists. The census stays the live overlay — which
// step runs now, its last tool — grouped by task number as a literal view,
// no inference beyond the pattern itself. Without a record there is no
// done/total (there is no plans/*.plan.json fallback).
// Rows that don't match stay ordinary subagents. Pure functions; the column
// and Home share them.
import type { DiskSubagent, ExecutionRecord, ExecutionTaskState } from './types'
import { agentAtWork } from './live'

export type ExecutionRole = 'implement' | 'review' | 're-review'

export interface ExecutionStep {
  sub: DiskSubagent
  role: ExecutionRole
  round?: number
  live: boolean
  // descendants of this subagent in the census (a reviewer's finders…)
  kin: DiskSubagent[]
}

export interface ExecutionTask {
  n: number
  title: string | null
  steps: ExecutionStep[] // chronological
  live: boolean
  mtime: number // newest activity across its steps (the ledger's mtime for a record-only row)
  detail?: string // the ledger's own words for the task (completion, fix round)
  state?: ExecutionTaskState // what the record says of it, when there is a record
  round?: number // the record's fix round, when it is fixing
}

export interface ParsedRole {
  role: ExecutionRole
  task: number
  title?: string
  round?: number
}

const IMPLEMENT_RE = /^Implement Task (\d+)(?:\s*:\s*(.+))?$/i
const RE_REVIEW_RE = /^Re-review Task (\d+)\b(?:.*?\bround (\d+))?/i
const REVIEW_RE = /^Review Task (\d+)\b/i

export function parseExecutionRole(description: string | null | undefined): ParsedRole | null {
  const d = (description ?? '').trim()
  if (!d) return null
  let m = IMPLEMENT_RE.exec(d)
  if (m) {
    const out: ParsedRole = { role: 'implement', task: Number(m[1]) }
    const title = m[2]?.trim()
    if (title) out.title = title
    return out
  }
  m = RE_REVIEW_RE.exec(d)
  if (m) {
    const out: ParsedRole = { role: 're-review', task: Number(m[1]) }
    if (m[2]) out.round = Number(m[2])
    return out
  }
  m = REVIEW_RE.exec(d)
  if (m) return { role: 'review', task: Number(m[1]) }
  return null
}

// The word a step reads as, in the voice of the rest of the app ("working",
// "asks you"): what the subagent is doing, not what it is.
export function stepWord(step: Pick<ExecutionStep, 'role' | 'round'>, tense: 'noun' | 'ing' = 'noun'): string {
  if (step.role === 'implement') return tense === 'ing' ? 'implementing' : 'implement'
  if (step.role === 'review') return tense === 'ing' ? 'reviewing' : 'review'
  const r = step.round !== undefined ? ` round ${step.round}` : ''
  return (tense === 'ing' ? 're-reviewing' : 're-review') + r
}

const startOf = (a: DiskSubagent): number => a.startedAt ?? a.mtime

// Groups the census into execution tasks. Returns [] when no row matches
// and there is no record — the caller then knows this session is not
// executing a plan this way. `claimed` lists every census id the grouping
// absorbed (steps AND their descendants) so the plain Subagents block can show
// only the rest. With a record, a task the ledger says ran (complete or
// fixing) but whose subagents left no census row — rotated away, another
// session — still gets its row, with no steps; pending ones stay out (the
// progress line already counts them). The record's title and words fill in
// what the census can't say.
export function groupExecution(
  census: readonly DiskSubagent[],
  now: number,
  record?: ExecutionRecord | null,
): { tasks: ExecutionTask[]; claimed: Set<string> } {
  const ids = new Set(census.map((a) => a.id))
  const kids = new Map<string, DiskSubagent[]>()
  for (const a of census) {
    if (a.parentId !== undefined && ids.has(a.parentId)) {
      const k = kids.get(a.parentId) ?? []
      k.push(a)
      kids.set(a.parentId, k)
    }
  }
  const descendants = (id: string, out: DiskSubagent[] = []): DiskSubagent[] => {
    for (const c of kids.get(id) ?? []) {
      out.push(c)
      descendants(c.id, out)
    }
    return out
  }

  const byTask = new Map<number, ExecutionTask>()
  const claimed = new Set<string>()
  for (const a of census) {
    // only ROOT rows name a step: a step's own children are its helpers
    if (a.parentId !== undefined && ids.has(a.parentId)) continue
    const p = parseExecutionRole(a.description)
    if (!p) continue
    const kin = descendants(a.id)
    const live = agentAtWork(a, now) || kin.some((c) => agentAtWork(c, now))
    const step: ExecutionStep = { sub: a, role: p.role, live, kin }
    if (p.round !== undefined) step.round = p.round
    claimed.add(a.id)
    for (const c of kin) claimed.add(c.id)
    const mtime = Math.max(a.mtime, ...kin.map((c) => c.mtime))
    const t = byTask.get(p.task)
    if (t) {
      t.steps.push(step)
      t.live = t.live || live
      t.mtime = Math.max(t.mtime, mtime)
      if (t.title === null && p.title) t.title = p.title
    } else {
      byTask.set(p.task, { n: p.task, title: p.title ?? null, steps: [step], live, mtime })
    }
  }
  const updatedAt = record?.updatedAt ?? 0
  for (const r of record?.tasks ?? []) {
    const t = byTask.get(r.n)
    const fill = (t: ExecutionTask): void => {
      if (r.detail !== undefined) t.detail = r.detail
      t.state = r.state
      if (r.round !== undefined) t.round = r.round
    }
    if (t) {
      if (t.title === null && r.title !== null) t.title = r.title
      fill(t)
    } else if (r.state !== 'pending') {
      const row: ExecutionTask = { n: r.n, title: r.title, steps: [], live: false, mtime: updatedAt }
      fill(row)
      byTask.set(r.n, row)
    }
  }
  const tasks = [...byTask.values()]
  for (const t of tasks) t.steps.sort((x, y) => startOf(x.sub) - startOf(y.sub))
  // live tasks first (the work), then the rest by task number descending —
  // the newest task is the one the reader wants; earlier ones fold.
  tasks.sort((x, y) => (x.live === y.live ? y.n - x.n : x.live ? -1 : 1))
  return { tasks, claimed }
}

// Home's one line about a conversation executing a plan: the newest LIVE
// step — "Task 12 · implementing". Null when nothing of the kind is live
// (the line then falls back to its usual "working").
export function executionWord(census: readonly DiskSubagent[], now: number): string | null {
  const { tasks } = groupExecution(census, now)
  let best: { t: ExecutionTask; s: ExecutionStep; at: number } | null = null
  for (const t of tasks) {
    for (const s of t.steps) {
      if (!s.live) continue
      const at = Math.max(s.sub.mtime, ...s.kin.map((c) => c.mtime))
      if (!best || at > best.at) best = { t, s, at }
    }
  }
  if (!best) return null
  // on screen a document's step is a STEP (product.md): «Task» names only a Silos task
  return `Step ${best.t.n} · ${stepWord(best.s, 'ing')}`
}

// --- progress against the plan ---------------------------------------------
//
// The execution's steps carry no "done" of their own (a finished reviewer
// may have rejected); "done" is what the executor WROTE DOWN. So: done/total
// come from the execution record (the ledger's complete tasks against the
// plan document's count). Time is counted only where it is honest: how long
// the LIVE step has been running, and a pace built from the WORK time of
// finished tasks — the sum of their steps' durations, never first start to
// last end, which would count the night between an implementer and its
// reviewer. A wall-clock total since the first step ("66 h in") was tried
// and read as madness: it counted days of pauses.
export interface ExecutionProgress {
  done: number
  total: number | null // null: no plan file to count against
  // the live step, and for how long — null when nothing is running
  current: { task: number; word: string; forMs: number } | null
  remainingMs: number | null // (total − done) × the mean work time of finished tasks
}

// where done/total come from
export interface ProgressSource {
  done: Set<number>
  total: number | null
}

// The execution record (the SDD ledger with its document), the same count
// the Executions silo lists for this conversation: with
// a document, done counts only the tasks it names — a document task always
// has a title, a ledger-only one ("Task 0: baseline") has none; without a
// document, the tasks the ledger names are the total. No record, no source
// (there is no plans/*.plan.json fallback).
export function progressSource(record: ExecutionRecord | null | undefined): ProgressSource | null {
  if (!record) return null
  const complete = record.tasks.filter((t) => t.state === 'complete')
  if (record.total !== null) return { done: new Set(complete.filter((t) => t.title !== null).map((t) => t.n)), total: record.total }
  return { done: new Set(complete.map((t) => t.n)), total: record.tasks.length }
}

const stepStart = (s: ExecutionStep): number => s.sub.startedAt ?? s.sub.mtime
const stepEnd = (s: ExecutionStep): number => Math.max(s.sub.mtime, ...s.kin.map((k) => k.mtime))
// work time of a task: its steps' own durations, summed
const workMs = (t: ExecutionTask): number => t.steps.reduce((n, s) => n + Math.max(0, stepEnd(s) - stepStart(s)), 0)

export function executionProgress(tasks: readonly ExecutionTask[], source: ProgressSource | null, now: number): ExecutionProgress {
  let current: ExecutionProgress['current'] = null
  let newest = -Infinity
  for (const t of tasks) {
    for (const s of t.steps) {
      if (!s.live) continue
      const at = stepEnd(s)
      if (at > newest) {
        newest = at
        current = { task: t.n, word: stepWord(s, 'ing'), forMs: Math.max(0, now - stepStart(s)) }
      }
    }
  }
  if (!source) {
    return { done: tasks.filter((t) => !t.live).length, total: null, current, remainingMs: null }
  }
  const doneNumbers = source.done
  const done = doneNumbers.size
  const total = source.total
  const spans = tasks
    .filter((t) => doneNumbers.has(t.n) && !t.live)
    .map(workMs)
    .filter((ms) => ms > 0)
  const remainingMs =
    total !== null && spans.length >= 2 && total > done ? Math.round((spans.reduce((a, b) => a + b, 0) / spans.length) * (total - done)) : null
  return { done, total, current, remainingMs }
}

// An execution is OVER when nothing runs and there is nothing left to run:
// the plan calls every task done — or there is no plan to say what is
// left, in which case a quiet census is all there is. A paused execution
// (plan unfinished, nothing live) is NOT over: the block keeps showing
// where it stopped. Over, the column folds the block out of the top (tasks
// left behind are history, not state).
export function executionOver(tasks: readonly ExecutionTask[], progress: Pick<ExecutionProgress, 'done' | 'total'>): boolean {
  if (tasks.length === 0) return false
  if (tasks.some((t) => t.live)) return false
  return progress.total === null || progress.done >= progress.total
}

// "2 h 10 min", "40 min", "under a minute" — the column's duration voice
export function spanWord(ms: number): string {
  if (ms < 60_000) return 'under a minute'
  const min = Math.round(ms / 60_000)
  if (min < 60) return `${min} min`
  const h = Math.floor(min / 60)
  const m = min % 60
  return m === 0 ? `${h} h` : `${h} h ${m} min`
}
