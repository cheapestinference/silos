// team-plan.ts — the plan as the plan views draw it (TeamPlan: PlanView,
// plan-layout, useExecutions) and the pure questions they ask of it
// (ready, a human's, what a Done unblocks, the task's conversation). The
// `plans/<slug>.plan.json` files the team-plan skill maintains are READ and
// WRITTEN by the built-in Plans silo:
// lib/plan-record.ts turns its record into a TeamPlan, and a Done is the
// silo's set-field — the web neither parses nor rewrites a plan file.
import { sessionSignal } from './live'
import { relTime } from './rel-time'
import type { SessionView } from './types'

// the team-plan v-next states (plans 0.2.0): in_review waits on a reviewer,
// cancelled is terminal and — unlike done — resolves no dependency
export type PlanStatus = 'pending' | 'in_progress' | 'in_review' | 'blocked' | 'done' | 'cancelled'

// finished: nothing more will happen to it (done, or cancelled)
export function isFinished(status: PlanStatus): boolean {
  return status === 'done' || status === 'cancelled'
}

// a plan's (or a parent's subtasks') progress: done over what is still meant
// to be done — a dropped (cancelled) task leaves the total instead of
// counting as unfinished work (4 done + 1 dropped is 4/4)
export function planProgress(states: readonly PlanStatus[]): { done: number; total: number } {
  return { done: states.filter((s) => s === 'done').length, total: states.filter((s) => s !== 'cancelled').length }
}

export interface TeamPlanTask {
  id: string
  title: string
  owner: string
  status: PlanStatus
  dependsOn: string[]
  notes?: string
  // the session id of the conversation working on it (team-plan skill: the
  // agent writes its $SILOS_SESSION_ID when it picks the task up). Read
  // through taskConversation — anything implausible reads as none.
  conversation?: unknown
  // every session its conversations[] names (plan-record.ts)
  sessions?: string[]
  // unknown fields ride along untouched (index signature keeps them typed).
  [extra: string]: unknown
}

export interface TeamPlan {
  title: string
  createdAt?: string
  updatedAt?: string
  tasks: TeamPlanTask[]
  [extra: string]: unknown
}

// Is this plan a conversation's own, for that conversation's column (never
// another conversation's plan — only THIS one's)? Yes when
// the conversation holds (or held) one of its tasks. A plan it only wrote to
// — a note left on someone's task, a file named in a command — is its own
// ONLY while no conversation holds any of its tasks (the plan it just
// created); once another conversation works it, writing there is a visit.
// Reading a plan never makes it yours.
export function planIsOf(plan: Pick<TeamPlan, 'tasks'>, session: string, wrote: boolean): boolean {
  const held = plan.tasks.flatMap((t) => t.sessions ?? [])
  if (held.includes(session)) return true
  return wrote && held.length === 0
}

export function isPlanFile(name: string): boolean {
  return name.endsWith('.plan.json')
}

// A plausible session id: a Claude Code uuid or an OpenCode `ses_…` —
// letters, digits, '-' and '_', 8–128 long, never a path.
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/

// The task's `conversation`, when it is a plausible session id; else null.
export function taskConversation(task: Pick<TeamPlanTask, 'conversation'>): string | null {
  return typeof task.conversation === 'string' && SESSION_ID.test(task.conversation) ? task.conversation : null
}

// The project folder a plan path belongs to (the segment before /plans/ —
// also for plans/closed/…); '' when the path is not under a plans/ folder.
export function planProjectFolder(path: string): string {
  const i = path.lastIndexOf('/plans/')
  return i >= 0 ? path.slice(0, i) : ''
}

// A plan file the protocol moved to `<project>/plans/closed/`: a FINISHED
// plan of that project — its own, read only. Never «outside Silos'
// projects»: the reader leaves plans/closed/ out of its locations on purpose
// (closed plans are in no task list), not because the file is foreign.
export function isClosedPlanPath(path: string): boolean {
  return path.includes('/plans/closed/')
}

// The home a plan line names, from the conversation sitting in `cwd`: a
// plan read outside every Silos project says so; a plan of ANOTHER project
// (open or closed) names it («in <project>»); this project's own plans need
// no home. A closed plan is its project's, wherever it moved inside it.
export function planHomeWords(p: { path: string; outside: boolean; closed?: boolean }, cwd: string | null): string | null {
  const closed = p.closed === true || isClosedPlanPath(p.path)
  if (p.outside && !closed) return "outside Silos' projects"
  const folder = planProjectFolder(p.path)
  return folder !== '' && folder !== cwd ? `in ${folder.slice(folder.lastIndexOf('/') + 1)}` : null
}

// Where a task's conversation lives in the index the web holds (each
// agent's session list), or null when it is not there — a link that opened
// nothing would be a lie. The task's OWNER's session in the plan's project
// folder first (Claude Code's munged name: every non-alphanumeric → '-');
// then that owner's session of that id anywhere (a worktree's folder); then
// anyone's (the thread changed hands).
export function taskConversationTarget<S extends { id: string; folder: string }>(
  task: Pick<TeamPlanTask, 'conversation' | 'owner'>,
  planPath: string | undefined,
  agents: ReadonlyArray<{ id: string; sessions: ReadonlyArray<S> }>,
): S | null {
  const id = taskConversation(task)
  if (!id) return null
  const project = planPath ? planProjectFolder(planPath) : ''
  const munged = project ? project.replace(/[^A-Za-z0-9]/g, '-') : null
  const owner = agents.find((a) => a.id === task.owner)
  const pick = (pool: ReadonlyArray<S>, folder: string | null) => pool.find((s) => s.id === id && (folder === null || s.folder === folder))
  const hit =
    (owner && munged ? pick(owner.sessions, munged) : undefined) ??
    (owner ? pick(owner.sessions, null) : undefined) ??
    pick(
      agents.flatMap((a) => a.sessions),
      null,
    )
  return hit ?? null
}

// What the task's «Conversation ›» says about it:
// working now (a live turn), its last activity («2h ago»), or — the task
// names a conversation the index doesn't know — gone, said as plain text
// with no link. Null when the task names none.
export type TaskConversationLine =
  { state: 'working'; folder: string; id: string } | { state: 'idle'; folder: string; id: string; ago: string } | { state: 'gone' }
export function taskConversationLine(
  task: Pick<TeamPlanTask, 'conversation' | 'owner'>,
  planPath: string | undefined,
  agents: ReadonlyArray<{ id: string; sessions: ReadonlyArray<SessionView> }>,
  now: number,
): TaskConversationLine | null {
  if (!taskConversation(task)) return null
  const hit = taskConversationTarget(task, planPath, agents)
  if (!hit) return { state: 'gone' }
  if (sessionSignal(hit, now, false) === 'working') return { state: 'working', folder: hit.folder, id: hit.id }
  return { state: 'idle', folder: hit.folder, id: hit.id, ago: relTime(hit.mtime, now) }
}

// A task's dependencies are met when every referenced task is done.
// References to unknown ids count as unmet — the file is lying, and the
// honest reading is "waiting on something we can't see".
function depsMet(task: TeamPlanTask, byId: Map<string, TeamPlanTask>): boolean {
  return task.dependsOn.every((id) => byId.get(id)?.status === 'done')
}

// Ready = actionable right now: open (not finished, not waiting on a
// review), all dependencies DONE (a cancelled one resolves nothing). These
// can run in parallel with each other by definition.
export function readyTasks(plan: TeamPlan): TeamPlanTask[] {
  const byId = new Map(plan.tasks.map((t) => [t.id, t]))
  return plan.tasks.filter((t) => !isFinished(t.status) && t.status !== 'in_review' && depsMet(t, byId))
}

// A task belongs to a human when its owner is not a known agent id — the
// registry is the only honest way to tell "finance" from "sam".
export function humanTasks(plan: TeamPlan, agentIds: ReadonlySet<string>): TeamPlanTask[] {
  return plan.tasks.filter((t) => !agentIds.has(t.owner))
}

// Ready AND on a human — so ContextColumn's live plan strip accents ONLY
// when there's something genuinely actionable, not merely
// assigned-but-blocked (the plans silo's needs-you says the same cut).
export function humanReadyTasks(plan: TeamPlan, agentIds: ReadonlySet<string>): TeamPlanTask[] {
  const ready = new Set(readyTasks(plan).map((t) => t.id))
  return humanTasks(plan, agentIds).filter((t) => ready.has(t.id))
}

// What completing `id` would unblock: tasks whose ONLY unmet dependency is it.
export function unblocksOf(plan: TeamPlan, id: string): TeamPlanTask[] {
  const byId = new Map(plan.tasks.map((t) => [t.id, t]))
  return plan.tasks.filter((t) => !isFinished(t.status) && t.dependsOn.includes(id) && t.dependsOn.every((d) => d === id || byId.get(d)?.status === 'done'))
}
