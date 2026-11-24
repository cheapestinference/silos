// plan-record.ts — a plan as the PLANS SILO reads it, in the shape the plan
// views draw (TeamPlan: PlanView, plan-layout, useExecutions). The silo
// is the reader and the writer: the column's PlanView and the FileViewer
// ask for the record by its FILE (GET /api/silos/plans/record?file=) and mark
// a task done through the owner's Done (lib/task-gesture.ts planTaskDone) —
// never by rewriting the file themselves.
//
// The record's `value` is the kernel's normalized reading: every task with
// its `state`, its `notes[]` ({at, by, text}) and its `conversations[]`
// (a session id, or {session}). Unknown fields ride along — except a loose
// `conversation`, which the view model derives from conversations[] alone.
import { api, ApiError } from './api'
import type { PlanStatus, TeamPlan, TeamPlanTask } from './team-plan'
import type { PlanHandoff, SiloRecordDetail } from './types'

// the built-in silo that reads plans/*.plan.json (server silos/native.ts)
export const PLANS_SILO = 'plans'

type Json = Record<string, unknown>
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)
const isStr = (v: unknown): v is string => typeof v === 'string'

const STATES: readonly PlanStatus[] = ['pending', 'in_progress', 'in_review', 'blocked', 'done', 'cancelled']

// The words of a task's notes as one text, oldest first — what the plan views
// paint under a task.
function notesText(v: unknown): string | undefined {
  const texts = (Array.isArray(v) ? v : [])
    .filter(isObj)
    .map((n) => (isStr(n.text) ? n.text : ''))
    .filter((t) => t !== '')
  return texts.length > 0 ? texts.join('\n') : undefined
}

// The session a task names: its first conversations[] entry.
function firstSession(v: unknown): string | undefined {
  for (const c of Array.isArray(v) ? v : []) {
    const s = isObj(c) ? c.session : c
    if (isStr(s) && s !== '') return s
  }
  return undefined
}

// Every session a task names (its conversations[], current and released).
function allSessions(v: unknown): string[] {
  return (Array.isArray(v) ? v : []).map((c) => (isObj(c) ? c.session : c)).filter((x): x is string => isStr(x) && x !== '')
}

// The kernel's record value → the TeamPlan the views draw. Tasks whose state
// is none of the six (the reader already said why) are left out.
export function planOfRecord(value: Json): TeamPlan {
  const tasks: TeamPlanTask[] = []
  for (const t of Array.isArray(value.tasks) ? value.tasks : []) {
    if (!isObj(t) || !isStr(t.id)) continue
    const status = (isStr(t.state) ? t.state : t.status) as PlanStatus
    if (!STATES.includes(status)) continue
    const { state: _s, stateLabel: _l, identity: _i, at: _a, updatedBy: _u, ready: _r, notes, conversations, conversation: _c, ...rest } = t
    const text = notesText(notes)
    const conversation = firstSession(conversations)
    tasks.push({
      ...rest,
      id: t.id,
      title: isStr(t.title) ? t.title : isStr(t.identity) ? t.identity : t.id,
      owner: isStr(t.owner) ? t.owner : '',
      status,
      dependsOn: Array.isArray(t.dependsOn) ? t.dependsOn.filter(isStr) : [],
      ...(text !== undefined ? { notes: text } : {}),
      ...(conversation !== undefined ? { conversation } : {}),
      sessions: allSessions(conversations),
    })
  }
  const { id: _id, identity, state: _st, stateLabel: _sl, at: _at, updatedBy: _ub, tasks: _t, ...extra } = value
  return {
    ...extra,
    title: isStr(value.title) ? value.title : isStr(identity) ? identity : '',
    ...(isStr(value.createdAt) ? { createdAt: value.createdAt } : {}),
    ...(isStr(value.updatedAt) ? { updatedAt: value.updatedAt } : {}),
    tasks,
  }
}

// A plan file as the silo reads it: the plan, its record key and the CAS
// version a write must name. `outside`: read by path outside every folder
// the silo reads («outside Silos' projects») — said, never written.
export interface LoadedPlan {
  path: string
  plan: TeamPlan
  key: string
  version: string | null
  outside: boolean
  // the reader's remarks on the plan (a task it could not build says
  // «tasks[N] is not read: <why>» — unreadTasksOf)
  remarks: string[]
}

export function loadedOf(path: string, d: SiloRecordDetail): LoadedPlan | null {
  if (!d.value) return null
  return {
    path,
    plan: planOfRecord(d.value),
    key: d.record.key,
    version: d.version,
    outside: d.outside === true,
    remarks: Array.isArray(d.record.remarks) ? d.record.remarks : [],
  }
}

// The tasks the file holds that the reader could not build (the same remark
// the server's «N tasks in <plan> can't be read» row reads): each with its id
// when the raw file gives one, and the reader's why. The plan view leaves
// them out — the file viewer says them, since the file is where they are fixed.
const NOT_READ = /^tasks\[(\d+)\] is not read: (.*)$/s
export function unreadTasksOf(remarks: readonly string[], rawText: string | null): Array<{ id: string | null; reason: string }> {
  let raw: unknown[] = []
  try {
    const v = rawText ? (JSON.parse(rawText) as { tasks?: unknown }) : null
    raw = Array.isArray(v?.tasks) ? v.tasks : []
  } catch {
    raw = []
  }
  const out: Array<{ id: string | null; reason: string }> = []
  for (const m of remarks) {
    const hit = NOT_READ.exec(m)
    if (!hit) continue
    const item = raw[Number(hit[1])] as { id?: unknown } | undefined
    out.push({ id: item && typeof item.id === 'string' && item.id !== '' ? item.id : null, reason: hit[2]! })
  }
  return out
}

// null when the silo does not read it as a plan (no such record, not active,
// unreadable) — the caller falls back to the raw file, never a guess.
export async function loadPlan(path: string): Promise<LoadedPlan | null> {
  try {
    return loadedOf(path, await api.silos.recordByFile(PLANS_SILO, path))
  } catch (e) {
    if (e instanceof ApiError) return null
    throw e
  }
}

// What a Done handed to agents, in the handoff's words (Home's toast, the
// line under the plan): each agent owner of a task the click made ready,
// with whether it will move — `wakes` is said only for agents in play.
export function handoffOf(nowReady: NonNullable<Awaited<ReturnType<typeof api.silos.setField>>['nowReady']>, nameOf: (id: string) => string): PlanHandoff[] {
  return nowReady.flatMap((t) => (t.wakes ? [{ agentId: t.owner, agentName: nameOf(t.owner), taskId: t.id, title: t.identity, wakes: t.wakes }] : []))
}
