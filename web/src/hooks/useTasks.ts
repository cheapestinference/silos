// useTasks — every plan task, read from the Plans silo's records route with
// ?values=1 (lib/tasks.ts turns each row into a task). ONE shared reading
// for every surface that names tasks (the Tasks view, the sidebar's Tasks
// list, a task's page, a conversation's header): fetched once per `silos`
// WS tick (store.siloTick — an active silo's records changed), deduplicated
// while in flight, every page of the set read (the route caps a page at 200).
//
// Honest states (never misleading functionality):
// 'loading' before the first answer — a view never says «nothing» before
// data arrives —, 'absent' when the Plans silo is not installed or active
// (its uninstall takes the tasks with it), 'error' with the server's words.
import { useEffect, useReducer, useState } from 'react'
import { useStore } from '../store'
import { api, ApiError } from '../lib/api'
import { PLANS_SILO } from '../lib/plan-record'
import { openTasksBySession, taskOfRow, type TaskView } from '../lib/tasks'
import type { AgentView } from '../lib/types'

export type TasksReading =
  | { state: 'loading'; tasks: TaskView[] }
  | { state: 'ready'; tasks: TaskView[]; unreadable: number }
  | { state: 'absent'; tasks: TaskView[]; reason: string }
  | { state: 'error'; tasks: TaskView[]; error: string }

const PAGE = 200
const MAX_PAGES = 25 // 5,000 tasks — a bound, said if ever reached (never silently cut)

let cache: { tick: number; reading: TasksReading } | null = null
let inflight: { tick: number; promise: Promise<TasksReading> } | null = null
const listeners = new Set<(r: TasksReading) => void>()

async function readAll(): Promise<TasksReading> {
  try {
    const tasks: TaskView[] = []
    let offset = 0
    let unreadable = 0
    for (let i = 0; i < MAX_PAGES; i++) {
      const page = await api.silos.records(PLANS_SILO, { kind: 'plan/task', values: true, offset, limit: PAGE })
      unreadable = page.unreadable.count
      for (const r of page.records) {
        const t = taskOfRow(r)
        if (t) tasks.push(t)
      }
      offset += page.records.length
      if (page.records.length === 0 || offset >= page.matching) break
    }
    return { state: 'ready', tasks, unreadable }
  } catch (e) {
    if (e instanceof ApiError && (e.status === 404 || e.status === 400)) return { state: 'absent', tasks: [], reason: e.message }
    return { state: 'error', tasks: cache?.reading.tasks ?? [], error: e instanceof Error ? e.message : String(e) }
  }
}

function load(tick: number): Promise<TasksReading> {
  if (inflight && inflight.tick === tick) return inflight.promise
  const promise = readAll().then((r) => {
    cache = { tick, reading: r }
    if (inflight?.promise === promise) inflight = null
    for (const l of listeners) l(r)
    return r
  })
  inflight = { tick, promise }
  return promise
}

// re-read now (after the owner's own write — the WS tick confirms later)
export function refreshTasks(): void {
  void load(Date.now() + Math.random())
}

// `enabled` false: subscribes to nothing and reads nothing — a surface that is
// always mounted (⌘K) asks only while it is open
export function useTasks(enabled = true): TasksReading {
  const tick = useStore((s) => s.siloTick)
  const [reading, setReading] = useState<TasksReading>(() => cache?.reading ?? { state: 'loading', tasks: [] })
  useEffect(() => {
    if (!enabled) return
    listeners.add(setReading)
    // a cached ERROR never satisfies a mount: without this, one transient
    // failure stuck until the next WS tick — reopening the view retries
    if (!cache || cache.tick !== tick || cache.reading.state === 'error') void load(tick)
    else setReading(cache.reading)
    return () => {
      listeners.delete(setReading)
    }
  }, [tick, enabled])
  return reading
}

// tests: forget the shared reading between cases
export function resetTasksCache(): void {
  cache = null
  inflight = null
}

// The sidebar's ☑: every conversation
// CURRENT on an open task. The server's answer (GET /api/tasks/by-session —
// the header's own sessionTasks, over the lineage the web does not hold) is
// the truth, read once for every row and again on the Plans reading's WS tick
// and whenever the census gains or loses a conversation (a /clear's
// rotation); while it is on its way the reading's own walk (lib/tasks.ts
// openTasksBySession, current conversations only) answers. No per-row fetch, no per-row walk. `enabled` as useTasks'.
export interface SessionWork {
  key: string
  ref: string
  title: string
}
type Served = { sig: string; map: Map<string, SessionWork[]> }
let served: Served | null = null
let servedInflight: string | null = null
const servedListeners = new Set<() => void>()

// the census's conversations, as one string (cached per agents array)
let censusMemo: { agents: readonly AgentView[]; sig: string } | null = null
function censusSig(agents: readonly AgentView[]): string {
  if (censusMemo?.agents !== agents)
    censusMemo = {
      agents,
      sig: agents
        .flatMap((a) => a.sessions.map((s) => s.id))
        .sort()
        .join(','),
    }
  return censusMemo.sig
}

const OPEN_STATES = new Set(['pending', 'in_progress', 'in_review', 'blocked'])
function loadServed(sig: string): void {
  if (servedInflight === sig) return
  // tests mock the api piecemeal — a missing method means «no answer», and
  // the reading's walk stands
  const call = (api as { tasksBySession?: typeof api.tasksBySession }).tasksBySession
  const p = call?.()
  if (!p || typeof p.then !== 'function') return
  servedInflight = sig
  p.then((r) => {
    const map = new Map<string, SessionWork[]>()
    for (const [id, lines] of Object.entries(r ?? {})) {
      const on = (Array.isArray(lines) ? lines : [])
        .filter((l) => l.current !== false && !l.closed && OPEN_STATES.has(l.state))
        .map((l) => ({ key: l.key, ref: l.ref, title: l.title }))
      if (on.length > 0) map.set(id, on)
    }
    served = { sig, map }
  })
    .catch(() => {
      /* the walk keeps answering; the next tick asks again */
    })
    .finally(() => {
      if (servedInflight === sig) servedInflight = null
      for (const l of servedListeners) l()
    })
}

// after the owner's own link / unlink (the WS tick confirms later)
export function refreshTasksBySession(): void {
  loadServed(`now:${Date.now()}:${Math.random()}`)
}

let walked: { tasks: readonly TaskView[]; agents: readonly AgentView[]; map: Map<string, TaskView[]> } | null = null
export function useOpenTasksBySession(enabled = true): ReadonlyMap<string, SessionWork[]> {
  const reading = useTasks(enabled)
  const agents = useStore((s) => s.agents)
  const tick = useStore((s) => s.siloTick)
  const sig = `${tick}|${censusSig(agents)}`
  const [, bump] = useReducer((x: number) => x + 1, 0)
  useEffect(() => {
    if (!enabled) return
    servedListeners.add(bump)
    if (served?.sig !== sig) loadServed(sig)
    return () => {
      servedListeners.delete(bump)
    }
  }, [sig, enabled])
  if (served) return served.map
  if (!walked || walked.tasks !== reading.tasks || walked.agents !== agents) {
    walked = { tasks: reading.tasks, agents, map: openTasksBySession(agents, reading.tasks) }
  }
  return walked.map
}

// tests: forget the server's answer between cases
export function resetTasksBySessionCache(): void {
  served = null
  servedInflight = null
  walked = null
}
