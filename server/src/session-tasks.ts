// session-tasks.ts — which tasks a CONVERSATION is on:
// the inverse of a task's conversations[], closed over rotations by the
// thread (task-threads.ts threadKey: the task may list an ancestor while the
// owner looks at the tip, or an OpenCode console key beside its `ses_…`).
// ONE function behind the conversation header (GET /api/sessions/:folder/
// :id/tasks) and the sidebar / the /clear hook (GET /api/tasks/by-session) —
// the two can never disagree. Each task says `current`: whether this
// conversation's thread is still current on it (its releases[] did not let
// it go) — «☑ Working on» vs «Worked on ✓».
import type { SessionMeta } from './types.js'
import type { SiloReading, SiloRecord } from './silos/reader.js'
import type { TaskThreads } from './task-threads.js'
import { conversationIdsOf } from './task-threads.js'
import { baseRecordOf, kindsOf, recordsOfKind, terminalsOf, type KindInfo, type KindRecord } from './silos/voice.js'
import { standingIdsOf } from './silos/manifest.js'
import { taskRefOf } from './silos/task-ref.js'

type Json = Record<string, unknown>

// `file`: the plan file holding the task — the conversation column paints
// the plans of the tasks a conversation works (its Plan block)
export interface SessionTask {
  key: string
  ref: string
  title: string
  state: string
  current: boolean
  closed?: true
  file?: string
}

export interface SessionTasksInput {
  metas: readonly SessionMeta[]
  reading: SiloReading | null
  manifest: Json | null
  // the closed plans' records (plans-closed.ts) — resolved, said `closed`; a
  // key the open reading holds wins (a reopened plan)
  closedPlans?: readonly SiloRecord[]
  threads: Pick<TaskThreads, 'threadKey' | 'currentOf' | 'sessionsOf'>
}

const baseOf = (records: readonly SiloRecord[]): KindRecord[] => records.map((r) => baseRecordOf(r))

function taskKind(manifest: Json | null): { kinds: ReturnType<typeof kindsOf>; info: KindInfo } | null {
  if (!manifest) return null
  const kinds = kindsOf(manifest)
  const info = [...kinds.values()].find((k) => k.dict.task)
  return info ? { kinds, info } : null
}

// the ref is the one form a task is said by (silos/task-ref.ts): the
// project's list's task as `<project>#t3` — what the /clear reminder fills
// the release recipe with, and what the release route reads back
function said(info: KindInfo, r: KindRecord, current: boolean, closed: boolean, ctx: RefCtx): SessionTask {
  const planId = String((r.parent as Json | undefined)?.id ?? r.key.split('/').slice(-3)[0] ?? '')
  const pk = r.parentKey ?? ''
  const location = pk.endsWith(`/${planId}`) ? pk.slice(0, pk.length - planId.length - 1) : null
  const ref =
    location !== null
      ? taskRefOf({
          parentId: planId,
          id: String(r.rec.id),
          place: location.slice(location.indexOf(':') + 1),
          standing: ctx.standing.has(planId),
          idsHere: () => ctx.idsAt(location),
        })
      : `${planId}#${String(r.rec.id)}`
  return {
    key: r.key,
    ref,
    title: typeof r.rec.identity === 'string' ? r.rec.identity : String(r.rec.id),
    state: String(r.rec.state),
    current,
    ...(closed ? { closed: true as const } : {}),
    ...(r.file ? { file: r.file } : {}),
  }
}

interface RefCtx {
  standing: ReadonlySet<string>
  idsAt: (location: string) => string[]
}
function refCtx(info: KindInfo, manifest: Json | null, records: readonly SiloRecord[]): RefCtx {
  const top = info.parent && !info.parent.parent ? info.parent.name : null
  return {
    standing: manifest && info.parent ? standingIdsOf(manifest, info.parent.name) : new Set<string>(),
    idsAt: (location) => records.filter((x) => x.location === location && (top === null || x.kind === top)).map((x) => String(x.record.id)),
  }
}

const listedOf = (info: KindInfo, rec: Json): string[] => conversationIdsOf(info.dict.task?.conversations ? rec[info.dict.task.conversations] : null)
const releasesOf = (info: KindInfo, rec: Json): unknown => (info.dict.task?.releases ? rec[info.dict.task.releases] : undefined)

// the tasks `meta` is on, open plans first, then the closed ones
export function sessionTasks(o: SessionTasksInput, meta: SessionMeta): SessionTask[] {
  const tk = taskKind(o.manifest)
  if (!tk || !o.reading) return []
  const { kinds, info } = tk
  const mine = o.threads.threadKey(meta.id)
  const on = (ids: readonly string[]): boolean => ids.some((id) => id === meta.id || o.threads.threadKey(id) === mine)
  const base = baseOf(o.reading.records)
  const openKeys = new Set(base.map((b) => b.key))
  const closedBase = baseOf(o.closedPlans ?? []).filter((b) => !openKeys.has(b.key))
  const ctx = refCtx(info, o.manifest, o.reading.records)
  const pass = (b: KindRecord[], closed: boolean): SessionTask[] =>
    recordsOfKind(kinds, b, info.name).flatMap((r) => {
      const ids = listedOf(info, r.rec)
      if (!on(ids)) return []
      return [said(info, r, on(o.threads.currentOf(ids, releasesOf(info, r.rec))), closed, ctx)]
    })
  return [...pass(base, false), ...pass(closedBase, true)]
}

// every conversation → its tasks, computed the other way round: for each
// OPEN task, the indexed members of its CURRENT thread (the sidebar paints ☑
// only for those). `?session=` callers use sessionTasks instead.
export function sessionTasksBySession(o: SessionTasksInput): Record<string, SessionTask[]> {
  const tk = taskKind(o.manifest)
  if (!tk || !o.reading) return {}
  const { kinds, info } = tk
  const term = terminalsOf(info)
  const out: Record<string, SessionTask[]> = {}
  const ctx = refCtx(info, o.manifest, o.reading.records)
  for (const r of recordsOfKind(kinds, baseOf(o.reading.records), info.name)) {
    if (term.has(String(r.rec.state))) continue
    const current = o.threads.currentOf(listedOf(info, r.rec), releasesOf(info, r.rec))
    if (current.length === 0) continue
    for (const m of o.threads.sessionsOf(current)) (out[m.id] ??= []).push(said(info, r, true, false, ctx))
  }
  return out
}
