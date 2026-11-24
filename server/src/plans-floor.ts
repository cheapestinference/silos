// plans-floor.ts — the floor's few questions to the PLANS SILO (plans phase 1,
// B2): what Silos itself must keep doing with plans that no manifest can
// declare — wake an agent whose task became ready, count a mission's
// progress. Before the kernelectomy they
// read the plan files on their own (team-plan-reader.ts, since deleted); now
// they read the silo's reading — the kernel is the only reader, so the inbox,
// the triggers and the progress can never disagree about a plan.
//
// Pure over a reading (silos/reader.ts) and the manifest; the caller hands
// in the clock and who is an agent. Nothing here reads a file, except the
// plans an agent AUTHORED outside every folder the silo reads (G12), read by
// path through the kernel's own readOutside.
import { basename } from 'node:path'
import { statSync } from 'node:fs'
import { mainCheckoutOf } from './execution-plan-join.js'
import { readOutside, type SiloReading, type SiloRecord } from './silos/reader.js'
import { baseRecordOf, holds, kindsOf, recordsOfKind, type KindRecord, type Voice } from './silos/voice.js'

type Json = Record<string, unknown>
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)
const isStr = (v: unknown): v is string => typeof v === 'string'

// the built-in silo that reads plans/*.plan.json (silos/native.ts)
export const PLANS_SILO = 'plans'

export interface PlansSilo {
  manifest: Json
  reading: SiloReading
}

// A plausible session id: a Claude Code uuid or an OpenCode `ses_…` — never
// a path or anything with a separator (the web opens it as folder + id).
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/

// the conversation a task names: its first conversations[] entry
export function taskConversation(t: Json): string | null {
  for (const c of Array.isArray(t.conversations) ? t.conversations : []) {
    const v = isObj(c) ? c.session : c
    if (isStr(v) && SESSION_ID.test(v)) return v
  }
  return null
}

// a folder's records: the silo reads every folder as its main checkout
const recordsIn = (reading: SiloReading, folder: string): SiloRecord[] => {
  const loc = `folder:${mainCheckoutOf(folder)}`
  return reading.records.filter((r) => r.location === loc)
}

export interface ReadyState {
  file: string // the plan file's NAME (the watch fingerprint's key, as always)
  readyTaskIds: string[]
  // the ready tasks' conversation (the session working each), by task id —
  // only for the tasks that name one
  conversations: Record<string, string>
}

// The tasks of `ownerId` READY in `folder`'s plans — the manifest's own
// `ready` (an open state, every dependency done, not waiting), evaluated at
// `voice.now`: what wakes a standing agent (autonomy-triggers.ts).
export function readyTasksOf(silo: PlansSilo, folder: string, ownerId: string, voice: Voice): ReadyState[] {
  const kinds = kindsOf(silo.manifest)
  const task = kinds.get('plan/task')
  if (!task) return []
  const base: KindRecord[] = recordsIn(silo.reading, folder).map((r) => baseRecordOf(r))
  const byFile = new Map<string, ReadyState>()
  for (const kr of recordsOfKind(kinds, base, task.name)) {
    if (kr.rec.owner !== ownerId || !kr.file || !holds('ready', task, kr, voice)) continue
    const name = basename(kr.file)
    const s = byFile.get(name) ?? { file: name, readyTaskIds: [], conversations: {} }
    const id = String(kr.rec.id)
    s.readyTaskIds.push(id)
    const c = taskConversation(kr.rec)
    if (c) s.conversations[id] = c
    byFile.set(name, s)
  }
  return [...byFile.values()]
}

export interface PlanProgress {
  done: number
  total: number
}

// The NEWEST plan (by its file's mtime) reduced to done/total for the mission
// view — among `folder`'s plans and the plans the agent's conversations
// AUTHORED wherever they live (authorship over territory); an
// authored plan no folder of the silo holds is read by path (G12, «outside
// Silos' projects»). No plan, or a newest one that does not read: null —
// «no plan yet» is absence, never a fake zero.
export function planProgressOf(
  silo: PlansSilo,
  folder: string,
  authored: readonly string[],
  env: { now: number; isAgent?: (v: string) => boolean },
): PlanProgress | null {
  const candidates = new Map<string, { mtimeMs: number; record: Json | null }>()
  for (const r of recordsIn(silo.reading, folder)) candidates.set(r.file, { mtimeMs: r.mtimeMs, record: r.record })
  const byFile = new Map(silo.reading.records.map((r) => [r.file, r]))
  for (const unread of silo.reading.unreadable)
    if (unread.file.startsWith(`${mainCheckoutOf(folder)}/plans/`)) candidates.set(unread.file, { mtimeMs: mtimeOf(unread.file), record: null })
  for (const path of authored) {
    if (!path.endsWith('.plan.json') || candidates.has(path)) continue
    const r = byFile.get(path)
    if (r) {
      candidates.set(path, { mtimeMs: r.mtimeMs, record: r.record })
      continue
    }
    if (silo.reading.unreadable.some((u) => u.file === path)) {
      candidates.set(path, { mtimeMs: mtimeOf(path), record: null })
      continue
    }
    const o = readOutside(PLANS_SILO, silo.manifest, path, env)
    if (o === null) continue // gone, or not a plan file
    candidates.set(path, 'unreadable' in o ? { mtimeMs: mtimeOf(path), record: null } : { mtimeMs: o.mtimeMs, record: o.record })
  }
  let newest: { mtimeMs: number; record: Json | null } | null = null
  for (const c of candidates.values()) if (!newest || c.mtimeMs > newest.mtimeMs) newest = c
  if (!newest || !newest.record) return null
  const tasks = (Array.isArray(newest.record.tasks) ? newest.record.tasks : []).filter(isObj)
  return { done: tasks.filter((t) => t.state === 'done').length, total: tasks.length }
}

function mtimeOf(path: string): number {
  try {
    return statSync(path).mtimeMs
  } catch {
    return 0
  }
}
