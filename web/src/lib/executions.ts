// executions.ts — the SDD executions as the web reads them: the built-in
// Executions silo's records (the kernel kind `execution`,
// server/src/silos/executions.ts), each hung from the plan task it executes.
// The moment they serve (docs/product.md): «what's happening?» inside a task —
// how far its execution got — without opening the conversation that ran it.
//
// One line says an execution everywhere it is drawn (a task's page, the
// Tasks tree, the PlanView's row and header): «3 of 7 done · Task 4 fixing —
// round 1 · updated 2h ago · worktree removed» — the words the PlanView has
// said since the execution record. Pure functions; the hook
// (hooks/useExecutions.ts) fetches, the components paint.
import { relTime } from './rel-time'
import { sessionSignal } from './live'
import type { AgentView, SessionView, SiloRecordRow } from './types'

// the built-in silo that presents them (server/src/silos/native.ts)
export const EXECUTIONS_SILO = 'executions'

type Json = Record<string, unknown>
const isStr = (v: unknown): v is string => typeof v === 'string' && v !== ''
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

export type ExecutionState = 'running' | 'fixing' | 'stopped' | 'done'

export interface ExecutionView {
  key: string // the record key in the Executions silo
  id: string
  state: ExecutionState
  title: string
  updatedAt: number // the ledger's last write (ms)
  done: number
  total: number
  totalFrom: 'document' | 'ledger'
  gone: boolean // the worktree was removed: Silos' copy speaks
  ledger: string
  session: string | null // the conversation that wrote it
  folder: string | null
  agent: string | null
  project: string | null
  doc: string | null // the document, inside its main checkout
  fixingTask: number | null
  round: number | null
  task: string | null // the plan task it hangs from (plans record key)
  taskRef: string | null
  edge: 'conversation' | 'document' | null
  otherLedgers: number // ledgers of the same document folded into this row
  otherLedgersSay: string | null // which, and how far each got
}

const STATES: readonly ExecutionState[] = ['running', 'fixing', 'stopped', 'done']

// a records row of the Executions silo (read with ?values=1) → the view
export function executionOfRow(r: SiloRecordRow): ExecutionView | null {
  const v: Json = r.value ?? {}
  const state = (isStr(v.state) ? v.state : r.state) as ExecutionState
  if (!STATES.includes(state)) return null
  const at = Date.parse(isStr(v.updatedAt) ? v.updatedAt : (r.at ?? ''))
  const edge = v.edge === 'conversation' || v.edge === 'document' ? v.edge : null
  return {
    key: r.key,
    id: r.id,
    state,
    title: r.identity || (isStr(v.title) ? v.title : r.id),
    updatedAt: Number.isNaN(at) ? 0 : at,
    done: isNum(v.done) ? v.done : 0,
    total: isNum(v.total) ? v.total : 0,
    totalFrom: v.totalFrom === 'ledger' ? 'ledger' : 'document',
    gone: v.gone === true,
    ledger: isStr(v.ledger) ? v.ledger : '',
    session: isStr(v.session) ? v.session : null,
    folder: isStr(v.folder) ? v.folder : null,
    agent: isStr(v.agent) ? v.agent : null,
    project: isStr(v.project) ? v.project : null,
    doc: isStr(v.doc) ? v.doc : null,
    fixingTask: isNum(v.fixingTask) ? v.fixingTask : null,
    round: isNum(v.round) ? v.round : null,
    task: isStr(r.anchors.task) ? r.anchors.task : isStr(v.task) ? v.task : null,
    taskRef: isStr(v.taskRef) ? v.taskRef : null,
    edge,
    otherLedgers: isNum(v.otherLedgers) ? v.otherLedgers : 0,
    otherLedgersSay: isStr(v.otherLedgersSay) ? v.otherLedgersSay : null,
  }
}

/** The one line an execution says: «3 of 7 done · Task 4 fixing — round 1 ·
 *  updated 2h ago · worktree removed»; with nothing running it, «16 of 17 done
 *  · stopped · updated 5d ago». */
export function executionLine(
  e: Pick<ExecutionView, 'done' | 'total' | 'fixingTask' | 'round' | 'updatedAt' | 'gone'> & Partial<Pick<ExecutionView, 'state' | 'otherLedgers'>>,
  now: number,
): string {
  const parts: string[] = [e.done >= e.total && e.total > 0 ? `all ${e.total} done` : `${e.done} of ${e.total} done`]
  const round = e.round !== null ? ` — round ${e.round}` : ''
  if (e.state === 'stopped') parts.push(e.fixingTask !== null ? `stopped fixing Step ${e.fixingTask}${round}` : 'stopped')
  else if (e.fixingTask !== null && e.done < e.total) parts.push(`Step ${e.fixingTask} fixing${round}`)
  parts.push(`updated ${relTime(e.updatedAt, now)}`)
  if (e.gone) parts.push('worktree removed')
  if (e.otherLedgers) parts.push(`${e.otherLedgers} other ${e.otherLedgers === 1 ? 'ledger' : 'ledgers'}`)
  return parts.join(' · ')
}

// the document's file name, else the ledger's plan folder — what a row names
export function docName(e: Pick<ExecutionView, 'doc' | 'ledger'>): string {
  if (e.doc) return e.doc.slice(e.doc.lastIndexOf('/') + 1)
  const m = /\/\.superpowers\/sdd\/([^/]+)\/progress\.md$/.exec(e.ledger)
  return m?.[1] ?? 'progress.md'
}

// the executions hung from a task, newest first
export function executionsOfTask(all: readonly ExecutionView[], taskKey: string): ExecutionView[] {
  return all.filter((e) => e.task === taskKey).sort((a, b) => b.updatedAt - a.updatedAt || a.key.localeCompare(b.key))
}

// executions by their task, each list newest first
export function executionsByTask(all: readonly ExecutionView[]): Map<string, ExecutionView[]> {
  const out = new Map<string, ExecutionView[]>()
  for (const e of [...all].sort((a, b) => b.updatedAt - a.updatedAt || a.key.localeCompare(b.key))) {
    if (!e.task) continue
    out.set(e.task, [...(out.get(e.task) ?? []), e])
  }
  return out
}

// the executions no task holds — counted beside «N conversations without a
// task», never hidden
export function executionsWithoutTask(all: readonly ExecutionView[]): ExecutionView[] {
  return all.filter((e) => !e.task).sort((a, b) => b.updatedAt - a.updatedAt || a.key.localeCompare(b.key))
}

// The conversation that wrote it, in the census the web holds, with its live
// state — ● working is the sidebar's own blink. `gone`: Silos no longer lists
// it (or the execution has no conversation at all).
export function executionConversation(
  e: Pick<ExecutionView, 'session' | 'folder'>,
  agents: readonly AgentView[],
  now: number,
): { session: SessionView | null; agentId: string | null; working: boolean } {
  if (!e.session) return { session: null, agentId: null, working: false }
  for (const a of agents) {
    const s = a.sessions.find((x) => x.id === e.session && (e.folder === null || x.folder === e.folder)) ?? a.sessions.find((x) => x.id === e.session)
    if (s) return { session: s, agentId: a.id, working: sessionSignal(s, now, false) === 'working' }
  }
  return { session: null, agentId: null, working: false }
}
