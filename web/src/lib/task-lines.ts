// task-lines.ts — the quiet task lines the server composes beside Needs you
// (inbox.ts from inbox-source's taskFlows) and the two rows
// that do stop work (the aggregated stalls of agents nobody wakes, an agent
// at its daily wake ceiling). The moment they serve: Home's «what's mine,
// what's coming» — said once, a door each, never counted in the pulse.
//   waitsStart  «2 tasks wait for you to start their agent ›»  Yours to do
//   comingToYou «Coming to you · 1»                            Yours to do (a still fold)
//   idle        «1 task ready, nobody on it ›»                 last line of Working now
// Pure: HomePage paints, the tests read.
import type { InboxRow } from './types'

export type TaskLineRow = Extract<InboxRow, { kind: 'taskLine' }>
export type StalledTasksRow = Extract<InboxRow, { kind: 'tasksStalled' }>
export type OwnTurnsCeilingRow = Extract<InboxRow, { kind: 'ownTurnsCeiling' }>

const n = (count: number, one: string, many: string): string => `${count} ${count === 1 ? one : many}`

// the server's voice when it sent one (inbox.ts taskLineRows — the same
// words the digest and the bell say), else the web's own; the door's ›
// is the web's (where a line opens is drawn, not said)
const served = (voice: string | undefined, door: boolean): string | null =>
  typeof voice === 'string' && voice.trim() !== '' ? `${voice.trim()}${door ? ' ›' : ''}` : null

export function taskLineWords(r: Pick<TaskLineRow, 'line' | 'count'> & { voice?: string }): string {
  const v = served(r.voice, r.line !== 'comingToYou')
  if (v !== null) return v
  switch (r.line) {
    case 'waitsStart':
      return `${n(r.count, 'task', 'tasks')} not started — ${r.count === 1 ? 'it opens' : 'they open'} with you ›`
    case 'comingToYou':
      return `Coming to you · ${r.count}`
    case 'idle':
      return `${n(r.count, 'task', 'tasks')} not started — nobody is on ${r.count === 1 ? 'it' : 'them'} ›`
  }
}

// where a line opens: the server's door, else the view that lists those tasks
export function taskLineDoor(r: Pick<TaskLineRow, 'line' | 'door'>): string {
  if (r.door) return r.door
  return r.line === 'idle' ? '/tasks?view=idle' : r.line === 'waitsStart' ? '/tasks?view=start' : '/tasks?view=mine'
}

export function stalledTasksWords(r: Pick<StalledTasksRow, 'count'> & { voice?: string }): string {
  return served(r.voice, true) ?? `${n(r.count, 'task sits', 'tasks sit')} untouched — nobody is moving ${r.count === 1 ? 'it' : 'them'} ›`
}
export function stalledTasksDoor(r: Pick<StalledTasksRow, 'door'>): string {
  return r.door || '/tasks?view=untouched'
}

// «Writer started 10 times without you today — its max · 3 wait for tomorrow»
// — the server's voice when it sent one
export function wakeCeilingWords(r: Pick<OwnTurnsCeilingRow, 'used' | 'perDay' | 'waiting'> & { voice?: string }, name: string): string {
  const v = served(r.voice, false)
  if (v !== null) return v
  const waiting = r.waiting ?? 0
  return `${name} started ${r.perDay} times without you today — its max${waiting > 0 ? ` · ${waiting} wait for tomorrow` : ''}`
}

// An agent's task that waits on YOU (waitingOn.owner = 'owner'), as Needs
// you says it: its question is the row — «Finance asks: publish today?»
// — with its closed choices as buttons; no question, its action; neither,
// «waits on you — it didn't say for what» (`silent`: the row's door is all).
// The SERVER's words win: `voice` is the row's own sentence
// (silos/voice.ts rowOf — what the digest and the bell say too), and the
// options are the kernel's `flow.waitsOn.options`, already held to the
// convention's shape (1–4 strings of ≤40 chars, task-flow.ts). The web's
// reading below is only for a server that sends neither — the same shape
// test (trimmed, as the kernel measures). Null when the wait is not on you.
export interface AskWords {
  text: string
  options: string[]
  silent: boolean
}
type Wait = { owner: string; action: string; asked?: string; options?: string[] }
export function waitOptions(t: { waitingOn: Wait | null; flow?: { waitsOn?: Wait | null } | null }): string[] {
  const kernel = t.flow?.waitsOn
  if (kernel !== undefined) return Array.isArray(kernel?.options) ? kernel.options : []
  const raw = Array.isArray(t.waitingOn?.options) ? t.waitingOn.options : []
  return raw.length >= 1 && raw.length <= 4 && raw.every((o) => typeof o === 'string' && o.trim() !== '' && o.trim().length <= 40) ? raw : []
}
export function askWords(t: { waitingOn: Wait | null; flow?: { waitsOn?: Wait | null } | null }, ownerName: string, voice?: string | null): AskWords | null {
  const w = t.flow?.waitsOn !== undefined ? t.flow.waitsOn : t.waitingOn
  if (!w || w.owner !== 'owner') return null
  const options = waitOptions(t)
  const silent = !(w.asked && w.asked.trim() !== '') && !(w.action && w.action.trim() !== '')
  if (voice && voice.trim() !== '') return { text: voice.trim(), options: silent ? [] : options, silent }
  if (w.asked && w.asked.trim() !== '') return { text: `${ownerName} asks: ${w.asked.trim()}`, options, silent: false }
  if (w.action && w.action.trim() !== '') return { text: `${ownerName} waits on you: ${w.action.trim()}`, options, silent: false }
  return { text: `${ownerName} waits on you — it didn't say for what`, options: [], silent: true }
}

// ⌘K «Answer «<asked>»»: the open agent tasks that wait on
// YOU with something to answer (a question, else its action) — the ones on
// screen first (`first`: the task page's, the conversation's), the rest in
// the reading's order. The words are the wait's; the choices, its options
// (waitOptions). A wait that didn't say for what is no row here — its page
// is its door.
export interface AskableTask<T> {
  task: T
  asked: string
  options: string[]
}
export function askableTasks<T extends { key: string; owner: string; state: string; waitingOn: Wait | null; flow?: { waitsOn?: Wait | null } | null }>(
  tasks: readonly T[],
  isAgent: (id: string) => boolean,
  first: ReadonlySet<string> = new Set(),
): Array<AskableTask<T>> {
  const out: Array<AskableTask<T>> = []
  for (const t of tasks) {
    if (t.state === 'done' || t.state === 'cancelled' || !isAgent(t.owner)) continue
    const w = t.flow?.waitsOn !== undefined ? t.flow.waitsOn : t.waitingOn
    if (!w || w.owner !== 'owner') continue
    const asked = (w.asked ?? '').trim() || (w.action ?? '').trim()
    if (asked === '') continue
    out.push({ task: t, asked, options: waitOptions(t) })
  }
  return [...out.filter((a) => first.has(a.task.key)), ...out.filter((a) => !first.has(a.task.key))]
}

// the lines of one kind, in the server's order (one row per line, keyed fixed)
export function linesOf(rows: readonly InboxRow[], line: TaskLineRow['line']): TaskLineRow[] {
  return rows.filter((r): r is TaskLineRow => r.kind === 'taskLine' && r.line === line && r.count > 0)
}
