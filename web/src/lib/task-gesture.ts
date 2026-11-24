// task-gesture.ts — the owner's gestures on ONE task, ONE implementation per
// gesture: every surface — the task page, Home's rows,
// Tasks' `d`, ⌘K, the conversation's column and the plan viewer — calls
// `act(key, verb, args)`, which is POST /api/tasks/act: the server judges the
// verb's condition on the file as it is now and writes the task ONCE (no
// «answered, but…» half to retry). What the owner SAW rides with it:
// `asked` for answer/approve, `state` for done/drop. The owner's own change
// is not news to the owner: the task is marked seen here.
import { api, ApiError } from './api'
import { markTaskSeen } from '../hooks/useTaskSeen'
import type { LoadedPlan } from './plan-record'
import type { TaskActAnswer, TaskActArgs, TaskActVerb } from './types'

type Json = Record<string, unknown>
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)

export interface ActApi {
  act(body: { key: string; verb: TaskActVerb } & TaskActArgs): Promise<TaskActAnswer>
}
const defaultApi: ActApi = { act: (b) => api.tasksAct(b) }

// the task's state in the answer's record (its plan, as written)
export function stateIn(r: Pick<TaskActAnswer, 'record'>, key: string): string | null {
  const id = key.slice(key.lastIndexOf('/') + 1)
  const tasks = isObj(r.record) && Array.isArray(r.record.tasks) ? r.record.tasks : []
  const t = tasks.filter(isObj).find((x) => x.id === id)
  return t && typeof t.state === 'string' ? t.state : null
}

export async function act(key: string, verb: TaskActVerb, args: TaskActArgs = {}, deps: ActApi = defaultApi): Promise<TaskActAnswer> {
  const r = await deps.act({ key, verb, ...args })
  const st = stateIn(r, key)
  if (st) markTaskSeen(key, st)
  return r
}

// Done on a task of a plan the column or the viewer shows (what
// markPlanTaskDone was): a plan outside Silos' projects is read, never
// written — said before anything is sent
export async function planTaskDone(p: LoadedPlan, taskId: string, deps: ActApi = defaultApi): Promise<TaskActAnswer> {
  if (p.outside || p.version === null) throw new Error("this plan lives outside Silos' projects — open the file to change it")
  const t = p.plan.tasks.find((x) => x.id === taskId)
  return act(`${p.key}/tasks/${taskId}`, 'done', { state: t?.status ?? '' }, deps)
}

// a refused gesture in words, beside the control that caused it (C15c): a
// 409 is the verb's own sentence («it asks something else now»)
export function actError(e: unknown): string {
  if (e instanceof ApiError) return e.message
  return e instanceof Error ? e.message : String(e)
}
