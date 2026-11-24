// silos/executions.ts — the kernel kind `execution` (task-view
// phase 5): the SDD
// executions the kernel already reads, as records a silo presents, each hung
// from the plan task it executes.
//
// WHAT IS AN EXECUTION. One SDD ledger (`.superpowers/sdd/<plan>/progress.md`,
// execution-record.ts reads it with its plan document):
//   - the copy a conversation's ledger left in <dataDir>/executions/<folder>/
//     <session>.json (execution-store.ts — it outlives the worktree): id
//     `<folder>~<session>`, with that session, its folder and its agent;
//   - a LIVE ledger in a managed folder's checkouts (the main checkout and
//     every registered worktree) that no saved copy names: id
//     `ledger~<its path, munged>`, no session — nobody is known to have
//     written it, so it hangs only by its document.
// A saved copy whose live ledger moved on since is read from the live file
// (never saved from here: the kernel's sweep writes nothing).
//
// THE EDGE TO ITS TASK (D2) — two real edges, literal, in this order:
//   (a) conversation: the session that wrote the ledger is in a task's
//       conversations[] (the conversation that worked the task executed it);
//   (b) document: the task's `source` names the same document — same main
//       checkout, same path inside it (execution-plan-join.ts checkoutKeyOf,
//       the key the PlanView's join used).
// Several tasks on one edge: the one that ALSO holds the other edge, then an
// open one, then the plan's own order. Nothing else — no title matching, no
// guessing. An execution no task holds is listed all the same (the Tasks
// view says «N executions without a task»).
//
// STATES: running · fixing (a task is in a fix round) — both only while
// something runs it: its conversation is at work, or the ledger was written
// within the live window · stopped (unfinished and nothing runs it — a ledger
// left half way says nothing about being alive) · done (terminal: every task
// counted is complete, done ≥ total > 0). The total is the document's task
// count; without a document, the tasks the ledger names — the same count the
// PlanView's line has always said («all 3 done»).
//
// ONE DOCUMENT, ONE ROW, when nobody is known to have written it: ledgers
// without a conversation that name the same document (a main checkout and a
// worktree each left one) are one execution — the newest speaks and names the
// others. A conversation's ledger is never folded: two conversations that
// executed one document are two executions.
import { existsSync, realpathSync } from 'node:fs'
import { buildRecord } from '../execution-record.js'
import { checkoutKeyOf, checkoutsOf, ledgersIn, sameKey, type CheckoutKey } from '../execution-plan-join.js'
import type { ExecutionSnapshot, ExecutionStore } from '../execution-store.js'
import type { ExecutionRecord } from '../types.js'
import type { KernelRecord, KernelRecordSource } from './kernel-kinds.js'
import type { SiloReading } from './reader.js'
import { taskRefOf } from './task-ref.js'

type Json = Record<string, unknown>
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)
const isStr = (v: unknown): v is string => typeof v === 'string'

// the built-in silo that presents this kind (docs/standard/reference/executions.silo.json)
export const EXECUTIONS_SILO = 'executions'

export type ExecutionState = 'running' | 'fixing' | 'stopped' | 'done'
export type ExecutionEdge = 'conversation' | 'document'

// a plan task as the edge resolver reads it (from the plans silo's reading)
export interface ExecutionTaskRef {
  key: string // the plans record key: <plan key>/tasks/<id>
  ref: string // plan#id
  conversations: string[]
  source: string | null // the task's `source`, as written
  file: string | null // the plan file the task lives in
  open: boolean // not done, not cancelled
}

export interface ExecutionTaskEdge {
  key: string
  ref: string
  edge: ExecutionEdge
}

export interface Execution {
  id: string
  record: ExecutionRecord
  session: string | null
  folder: string | null
  agent: string | null
  docKey: CheckoutKey | null
  task: ExecutionTaskEdge | null
  live: boolean // something runs it now: its conversation at work, or a ledger just written
  others: ExecutionOtherLedger[] // ledgers of the same document folded into this one
}

export interface ExecutionOtherLedger {
  ledger: string
  done: number
  total: number
}

// ── pure pieces ─────────────────────────────────────────────────────────────

// the count «done» is measured against: the document's, else the ledger's tasks
export function totalOf(rec: Pick<ExecutionRecord, 'total' | 'tasks'>): { total: number; from: 'document' | 'ledger' } {
  return rec.total !== null ? { total: rec.total, from: 'document' } : { total: rec.tasks.length, from: 'ledger' }
}

export function executionState(rec: Pick<ExecutionRecord, 'total' | 'tasks' | 'done'>, live: boolean): ExecutionState {
  const { total } = totalOf(rec)
  if (total > 0 && rec.done >= total) return 'done'
  if (!live) return 'stopped'
  return rec.tasks.some((t) => t.state === 'fixing') ? 'fixing' : 'running'
}

// Is this conversation at work? The one rule (work-live.ts): its turn is open
// and it writes or runs a tool, a background agent of its own writes or runs a
// tool, or it waits on the owner's answer (held, not abandoned). A closed,
// quiet conversation runs nothing.
export { sessionAtWork, type WorkSignals as SessionLiveness } from '../work-live.js'

// Ledgers no conversation is known to have written that name one document →
// one execution: the newest speaks (most done on a tie), the others are named.
export function foldSameDocument(execs: readonly Execution[]): Execution[] {
  const heads = new Map<string, Execution[]>()
  const out: Execution[] = []
  for (const e of execs) {
    if (e.session !== null || e.docKey === null) {
      out.push(e)
      continue
    }
    const k = `${e.docKey.main}\0${e.docKey.rel}`
    heads.set(k, [...(heads.get(k) ?? []), e])
  }
  for (const group of heads.values()) {
    const [head, ...rest] = [...group].sort((a, b) => b.record.updatedAt - a.record.updatedAt || b.record.done - a.record.done)
    out.push({
      ...head!,
      live: group.some((e) => e.live),
      others: rest.map((e) => ({ ledger: e.record.ledgerPath, done: e.record.done, total: totalOf(e.record).total })),
    })
  }
  return out
}

// a path as a record-id segment: every character outside [A-Za-z0-9] → '-'
export function mungePath(p: string): string {
  return p.replace(/[^A-Za-z0-9]/g, '-')
}

const CLOSED = new Set(['done', 'cancelled'])

// the plans silo's reading → the tasks the edges read (plan record → tasks[]),
// each said in the one ref form (task-ref.ts): `standing` names the plan ids
// the manifest reserves (the project's list — `<project>#t3`)
export function taskRefsOf(reading: SiloReading | null, standing: ReadonlySet<string>): ExecutionTaskRef[] {
  const out: ExecutionTaskRef[] = []
  const plansIn = new Map<string, string[]>()
  for (const r of reading?.records ?? []) if (r.kind === 'plan') plansIn.set(r.location, [...(plansIn.get(r.location) ?? []), String(r.record.id)])
  for (const r of reading?.records ?? []) {
    if (r.kind !== 'plan') continue
    const planKey = `${r.location}/${r.record.id}`
    const planId = String(r.record.id)
    const place = r.location.startsWith('folder:') ? r.location.slice('folder:'.length) : null
    for (const t of (Array.isArray(r.record.tasks) ? r.record.tasks : []).filter(isObj)) {
      if (!isStr(t.id) || t.id === '') continue
      const conversations = (Array.isArray(t.conversations) ? t.conversations : [])
        .map((c) => (isObj(c) ? (c.session ?? c.id) : c))
        .filter((c): c is string => isStr(c) && c !== '')
      const state = isStr(t.state) ? t.state : isStr(t.status) ? t.status : ''
      out.push({
        key: `${planKey}/tasks/${t.id}`,
        ref: taskRefOf({ parentId: planId, id: t.id, place, standing: standing.has(planId), idsHere: () => plansIn.get(r.location) ?? [] }),
        conversations,
        source: isStr(t.source) && t.source !== '' ? t.source : null,
        file: r.file || null,
        open: !CLOSED.has(state),
      })
    }
  }
  return out
}

// Where a task's `source` points: relative to the project folder that holds
// the plan's plans/ directory, or absolute as written; markdown only. null
// when the plan is not under a plans/ folder or the source climbs out.
export function sourceDocOf(planFile: string | null, source: string | null): string | null {
  if (!source || !source.endsWith('.md')) return null
  if (source.startsWith('/')) return source
  if (!planFile) return null
  const i = planFile.lastIndexOf('/plans/')
  if (i < 0) return null
  const parts = source.split('/').filter((s) => s !== '' && s !== '.')
  if (parts.some((s) => s === '..')) return null
  return `${planFile.slice(0, i)}/${parts.join('/')}`
}

// the document's checkout key, followed through a link when it exists (a gone
// document keys lexically) — the join's own rule
export function docKeyOf(path: string | null): CheckoutKey | null {
  if (!path) return null
  let real = path
  try {
    real = realpathSync(path)
  } catch {
    /* gone: lexical */
  }
  return checkoutKeyOf(real)
}

// D2: each execution's task — conversation first, then document; ties go to
// the task that holds both edges, then an open one, then the plan's order.
export function resolveTaskEdges(
  execs: ReadonlyArray<Pick<Execution, 'id' | 'session' | 'docKey'>>,
  tasks: readonly ExecutionTaskRef[],
  sourceKey: (t: ExecutionTaskRef) => CheckoutKey | null = (t) => docKeyOf(sourceDocOf(t.file, t.source)),
): Map<string, ExecutionTaskEdge> {
  const keys = new Map<string, CheckoutKey | null>()
  const keyOf = (t: ExecutionTaskRef): CheckoutKey | null => {
    if (!keys.has(t.key)) keys.set(t.key, sourceKey(t))
    return keys.get(t.key)!
  }
  const pick = (cands: ExecutionTaskRef[], also: (t: ExecutionTaskRef) => boolean): ExecutionTaskRef | null => {
    if (cands.length === 0) return null
    return cands.find((t) => also(t) && t.open) ?? cands.find(also) ?? cands.find((t) => t.open) ?? cands[0]!
  }
  const out = new Map<string, ExecutionTaskEdge>()
  for (const e of execs) {
    const byDoc = (t: ExecutionTaskRef): boolean => e.docKey !== null && sameKey(keyOf(t), e.docKey)
    const conv = e.session ? tasks.filter((t) => t.conversations.includes(e.session!)) : []
    const a = pick(conv, byDoc)
    if (a) {
      out.set(e.id, { key: a.key, ref: a.ref, edge: 'conversation' })
      continue
    }
    const b = pick(e.docKey ? tasks.filter(byDoc) : [], () => false)
    if (b) out.set(e.id, { key: b.key, ref: b.ref, edge: 'document' })
  }
  return out
}

// the kernel record's value (the catalog's fields + the envelope's)
export function executionValue(e: Execution): Json {
  const r = e.record
  const { total, from } = totalOf(r)
  const state = executionState(r, e.live)
  const fixing = state !== 'done' ? r.tasks.find((t) => t.state === 'fixing') : undefined
  const title = r.planTitle ?? (r.planPath ? r.planPath.slice(r.planPath.lastIndexOf('/') + 1) : null) ?? ledgerName(r.ledgerPath)
  return {
    id: e.id,
    state,
    updatedAt: new Date(r.updatedAt).toISOString(),
    updatedBy: 'kernel',
    title,
    done: r.done,
    total,
    totalFrom: from,
    gone: r.gone,
    ledger: r.ledgerPath,
    ...(e.session ? { session: e.session } : {}),
    ...(e.folder ? { folder: e.folder } : {}),
    ...(e.agent ? { agent: e.agent } : {}),
    ...(e.docKey ? { project: e.docKey.main, doc: e.docKey.rel } : {}),
    ...(fixing ? { fixingTask: fixing.n, ...(fixing.round !== undefined ? { round: fixing.round } : {}) } : {}),
    ...(e.task ? { task: e.task.key, taskRef: e.task.ref, edge: e.task.edge } : {}),
    ...(e.others.length > 0
      ? { otherLedgers: e.others.length, otherLedgersSay: e.others.map((o) => `${o.ledger} (${o.done} of ${o.total} done)`).join(' · ') }
      : {}),
  }
}

// `.superpowers/sdd/<plan>/progress.md` → <plan>
function ledgerName(p: string): string {
  const m = /\/\.superpowers\/sdd\/([^/]+)\/progress\.md$/.exec(p)
  return m?.[1] ?? 'progress'
}

// ── the source ──────────────────────────────────────────────────────────────

export interface ExecutionSessionRef {
  folder: string
  id: string
  cwd: string | null
  ledgerPaths: string[]
}

export interface ExecutionsDeps {
  store: Pick<ExecutionStore, 'saved' | 'capture' | 'peek' | 'liveMtime'>
  // the conversations whose context names a ledger (the index, in memory):
  // captured before listing, so a ledger a conversation wrote is that
  // conversation's. Absent: only what was saved.
  sessions?: () => ExecutionSessionRef[]
  // the main checkouts of the managed folders — where live ledgers are swept
  checkouts: () => string[]
  agentOf: (folder: string, session: string) => string | null
  // the plans silo's tasks (null: it is not active — nothing hangs)
  tasks: () => ExecutionTaskRef[] | null
  // is the conversation at work now (sessionAtWork over the index's meta)?
  sessionLive?: (folder: string, session: string, now: number) => boolean
  // how recent a ledger write still proves something runs it. Absent: never.
  liveMs?: number
  now?: () => number
}

// how long one listing serves the readers that ask in a burst (the kernel's
// read, task mode's look, a page): a ledger is not a stopwatch
const LIST_TTL_MS = 5_000

export class ExecutionsSource implements KernelRecordSource {
  private cache: { at: number; list: Execution[] } | null = null

  constructor(private d: ExecutionsDeps) {}

  private now(): number {
    return this.d.now?.() ?? Date.now()
  }

  /** Forget the last listing (a ledger or a plan just moved). */
  invalidate(): void {
    this.cache = null
  }

  list(now = this.now()): Execution[] {
    if (this.cache && now - this.cache.at < LIST_TTL_MS && now >= this.cache.at) return this.cache.list
    const list = this.compute(now)
    this.cache = { at: now, list }
    return list
  }

  private compute(now: number): Execution[] {
    const { store } = this.d
    const cwdOf = new Map<string, string>()
    for (const s of this.d.sessions?.() ?? []) {
      if (s.ledgerPaths.length === 0) continue
      if (s.cwd) cwdOf.set(`${s.folder}~${s.id}`, s.cwd)
      try {
        store.capture(s.folder, s.id, s.ledgerPaths, s.cwd ? [s.cwd] : [])
      } catch {
        /* best effort, like the index's own capture */
      }
    }
    type Draft = Omit<Execution, 'task' | 'record' | 'docKey' | 'live' | 'others'> & { snap: Omit<ExecutionSnapshot, 'savedAt'> }
    const drafts: Draft[] = []
    const byLedger = new Map<string, Draft[]>()
    const realOf = (p: string): string => {
      try {
        return realpathSync(p)
      } catch {
        return p
      }
    }
    for (const { folder, id, snap } of store.saved()) {
      const d: Draft = { id: `${folder}~${id}`, session: id, folder, agent: this.d.agentOf(folder, id), snap }
      drafts.push(d)
      for (const k of new Set([snap.ledgerPath, realOf(snap.ledgerPath)])) byLedger.set(k, [...(byLedger.get(k) ?? []), d])
    }
    // the sweep: live ledgers in every checkout of every managed folder
    const seen = new Set<string>()
    for (const main of new Set(this.d.checkouts())) {
      let roots: string[] = []
      try {
        roots = checkoutsOf(main)
      } catch {
        continue
      }
      for (const root of roots) {
        for (const p of ledgersIn(root)) {
          const real = realOf(p)
          if (seen.has(real)) continue
          seen.add(real)
          const mtime = store.liveMtime(p)
          if (mtime === null) continue
          const saved = byLedger.get(p) ?? byLedger.get(real)
          if (saved) {
            // the copy is behind its live ledger: the live file speaks (read, never saved here)
            for (const d of saved) {
              if (mtime <= d.snap.ledgerMtime) continue
              const cwd = cwdOf.get(d.id)
              const live = store.peek(d.snap.ledgerPath, cwd ? [cwd] : [])
              if (live) d.snap = live
            }
            continue
          }
          const live = store.peek(p)
          if (live) drafts.push({ id: `ledger~${mungePath(p)}`, session: null, folder: null, agent: null, snap: live })
        }
      }
    }
    const { liveMs, sessionLive } = this.d
    const execs: Execution[] = foldSameDocument(
      drafts.map((d) => {
        const record = buildRecord({ ...d.snap, gone: !existsSync(d.snap.ledgerPath) })
        return {
          id: d.id,
          session: d.session,
          folder: d.folder,
          agent: d.agent,
          record,
          docKey: d.snap.planPath ? checkoutKeyOf(d.snap.planPath) : null,
          task: null,
          others: [],
          live:
            !record.gone &&
            ((liveMs !== undefined && now - record.updatedAt < liveMs) ||
              (d.session !== null && d.folder !== null && sessionLive?.(d.folder, d.session, now) === true)),
        }
      }),
    )
    const tasks = this.d.tasks()
    if (tasks && tasks.length > 0) {
      const edges = resolveTaskEdges(execs, tasks)
      for (const e of execs) e.task = edges.get(e.id) ?? null
    }
    return execs.sort((a, b) => b.record.updatedAt - a.record.updatedAt || a.id.localeCompare(b.id))
  }

  // ── KernelRecordSource ──
  records(now: number): KernelRecord[] {
    return this.list(now).map((e) => ({ id: e.id, value: executionValue(e), writtenAt: e.record.updatedAt }))
  }

  lastWrite(): number | null {
    const list = this.cache?.list ?? this.list()
    return list.length > 0 ? Math.max(...list.map((e) => e.record.updatedAt)) : null
  }

  // ── what the rest of the kernel asks ──

  /** A conversation's execution, captured now (the conversation's detail —
   *  the Executing block), with the task it hangs from. The SAME record the
   *  kind lists for that conversation. */
  forSession(
    folder: string,
    id: string,
    ledgerPaths: readonly string[],
    roots: readonly string[],
  ): { record: ExecutionRecord; task: ExecutionTaskEdge | null } | null {
    const snap = this.d.store.capture(folder, id, ledgerPaths, roots)
    if (!snap) return null
    const execId = `${folder}~${id}`
    const listed = this.list().find((e) => e.id === execId)
    // a capture newer than the listing (the conversation just wrote it): the
    // record from the capture, the edge from the listing (forget it: the
    // next reader lists again)
    if (listed && listed.record.updatedAt >= snap.ledgerMtime) return { record: listed.record, task: listed.task }
    this.invalidate()
    const e = this.list().find((x) => x.id === execId)
    const record = e?.record ?? buildRecord({ ...snap, gone: !existsSync(snap.ledgerPath) })
    return { record, task: e?.task ?? null }
  }

  /** The done count of every execution hung from each task — what task
   *  mode's no-progress fingerprint reads (D5). */
  doneByTask(now = this.now()): Map<string, number[]> {
    const out = new Map<string, number[]>()
    for (const e of this.list(now)) {
      if (!e.task) continue
      out.set(e.task.key, [...(out.get(e.task.key) ?? []), e.record.done])
    }
    return out
  }
}
