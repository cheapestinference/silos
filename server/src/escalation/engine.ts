// escalation/engine.ts — the escalation, running (hierarchy phase 4, D5-D7).
// The glue between what is stuck (task mode's failed retries, the routed
// rows the producer did not clear), the pure evaluation (evaluate.ts), what
// Silos remembers (store.ts) and the machinery that already exists: the
// agents' inboxes (a hop is a normal message from Silos — SILOS_AUTHOR —,
// only to an agent whose next heartbeat falls in the window) and the plans silo's own
// verbs (the recovery note, the wait). It runs on the resident's tick, after
// task mode — no scheduler of its own.
//
//   task case  opened → a recovery note by Silos on the task («stalled:
//              <cause>; one wake on <time> changed nothing») and the task
//              blocked, waiting on the first hop (waitingOn {owner, action:
//              «unstick plan#tN»}). Each hop rewrites the wait's owner to the
//              one asked now (the owner hop: `owner`). Never reassigns, never
//              changes the task's owner. The case lives while the task stays
//              exactly as Silos left it (blocked, that wait): the moment
//              anyone moves it, the case closes. Silos' own writes that
//              did not land (the agent wrote the file meanwhile — 409) keep
//              the case open with `writesDue` and are tried again at each
//              tick: never read as «someone moved it», never a
//              second case with a second recovery note.
//   row case   a routed row still uncleared: after the window its producer's
//              chain is asked — one message per (silo, entry, agent) and
//              tick, however many rows — and then the owner, whose inbox
//              lists the row again (surfaces.ts reads `escalatedRow`).
//
// Without a chain relation installed the chain is empty: a task goes from
// its failed retry straight to the owner's Needs you, a row after its window.
// With the asks wired, a task hop to an AGENT is
// no message: it arms the same ask fact an agent's ask arms (task-asks.ts),
// the hop sees it at its start and in its packet, and its answer closes the
// case.
import { askedWords, evaluateEscalation, OWNER, type Case, type ChainView, type Subject } from './evaluate.js'
import type { EscalationStore } from './store.js'
import type { TaskSnap } from '../task-mode/evaluate.js'
import { SILOS_WAIT_PREFIX, STALL_WORDS } from '../task-mode/evaluate.js'
import { formatMoment } from '../silos/freshness.js'
import { SILOS_AUTHOR } from '../system-author.js'

const CLOSED = new Set(['done', 'cancelled'])

// a routed row as the board sees it (surfaces.ts routedRows)
export interface RoutedRow {
  silo: string
  siloName: string
  entry: number
  key: string
  text: string
  producer: string
  recordKind: string
  folder?: string
  file: string | null
}

export interface EscalationDeps {
  store: EscalationStore
  // task mode's view: the bound agents' tasks and the stalls whose one wake
  // changed nothing (task-mode/engine.ts). Absent: no task escalates.
  taskMode?: {
    tasks(now: number): TaskSnap[]
    retryFailed(now: number, tasks: TaskSnap[]): Array<{ task: TaskSnap; cause: string; since: string; wokeAt: string }>
    // the tasks whose agent's turn Silos could
    // not start, attempt after attempt (task-mode/engine.ts cannotStart) —
    // stuck the same way: nobody is working them. Absent: none.
    cannotStart?(now: number, tasks: TaskSnap[]): Array<{ task: TaskSnap; error: string; attempts: number; since: string }>
  }
  // the routed rows uncleared now (surfaces.ts). Absent: no row escalates.
  routedRows?(now: number): RoutedRow[]
  chain(): ChainView
  isAgent(id: string): boolean
  nameOf(id: string): string
  // the plans silo's verbs, as Silos itself (SILOS_AUTHOR)
  setField(key: string, field: string, value: unknown): { ok: boolean; reason?: string }
  appendNote(key: string, text: string): { ok: boolean; reason?: string }
  // a message from Silos (SILOS_AUTHOR) to an agent's inbox — a normal
  // message: its packet carries it
  message(to: string, text: string): void
  // a hop goes to an agent only when it is On its own
  // and its next heartbeat with a turn falls inside the window — otherwise
  // the chain skips it, and at the end the owner. Absent: every agent can.
  hopOk?(agentId: string, now: number, windowMs: number): boolean
  // a hop to an AGENT arms the same fact an
  // agent's ask arms (task-asks.ts): asked '', Silos' own action — the hop
  // sees it in its start briefing and its heartbeat packet INSTEAD of a
  // message, and answers it with POST /api/tasks/ask/answer (which closes
  // the case: the wait leaves the task). `writeHop` is the wait + blocked in
  // ONE write the stamper expects (H4). Absent: the hop is the message of
  // before and the wait goes through setField.
  asks?: {
    writeHop(key: string, to: string, action: string): boolean
    hopArmed(key: string, to: string, action: string): boolean
    armHop(key: string, to: string, action: string): void
  }
  now?: () => number
}

// Silos' own wait — one prefix, read back by task mode's reopen (isSilosWait)
const actionOf = (ref: string): string => `${SILOS_WAIT_PREFIX}${ref}`
const when = (iso: string | undefined): string => (iso ? formatMoment(iso) : 'earlier')

export class EscalationEngine {
  private now: () => number
  private ticking = false

  constructor(private d: EscalationDeps) {
    this.now = d.now ?? Date.now
  }

  get store(): EscalationStore {
    return this.d.store
  }

  // The subjects stuck now: every failed retry, every task case still exactly
  // as Silos left it, every routed row.
  subjects(now: number, tasks: TaskSnap[] = this.d.taskMode?.tasks(now) ?? []): Subject[] {
    const out: Subject[] = []
    const open = this.d.store.cases()
    if (this.d.taskMode) {
      const byKey = new Map(tasks.map((t) => [t.key, t]))
      const subjectOf = (t: TaskSnap, cause: string, since: string, wokeAt?: string, notStarted?: boolean): Subject => ({
        id: `task:${t.key}`,
        kind: 'task',
        key: t.key,
        ref: t.ref,
        title: t.title,
        who: t.owner,
        creator: creatorOf(t, this.d.isAgent),
        cause,
        since,
        folder: t.folder,
        file: t.file,
        ...(wokeAt ? { wokeAt } : {}),
        ...(notStarted ? { notStarted: true } : {}),
      })
      for (const f of this.d.taskMode.retryFailed(now, tasks)) out.push(subjectOf(f.task, STALL_WORDS[f.cause] ?? f.cause, f.since, f.wokeAt))
      for (const f of this.d.taskMode.cannotStart?.(now, tasks) ?? []) {
        if (out.some((s) => s.id === `task:${f.task.key}`)) continue
        out.push(
          subjectOf(f.task, `Silos could not start ${this.d.nameOf(f.task.owner)}'s turn on it (${f.attempts} tries: ${f.error})`, f.since, undefined, true),
        )
      }
      for (const c of Object.values(open)) {
        if (c.kind !== 'task' || out.some((s) => s.id === c.id)) continue
        const t = byKey.get(c.key)
        // still exactly as Silos left it: same owner, blocked, waiting on the
        // chain with Silos' own action — anything else is someone moving it.
        // A case whose writes did not land yet is Silos' own unfinished move:
        // kept while the task is open and still that owner's
        const asLeft = t && t.state === 'blocked' && t.waitingFor?.action === actionOf(c.ref)
        const unfinished = t && c.writesDue === true && !CLOSED.has(t.state)
        if (t && t.owner === c.who && (asLeft || unfinished)) out.push(subjectOf(t, c.cause, c.since, c.wokeAt, c.notStarted))
      }
    }
    const iso = new Date(now).toISOString()
    for (const r of this.d.routedRows?.(now) ?? []) {
      out.push({
        id: `row:${r.silo}:${r.entry}:${r.key}`,
        kind: 'row',
        key: r.key,
        ref: r.text,
        title: r.text,
        who: r.producer,
        creator: null,
        cause: 'not cleared',
        since: iso,
        silo: r.silo,
        siloName: r.siloName,
        entry: r.entry,
        folder: r.folder ?? null,
        file: r.file,
      })
    }
    return out
  }

  tick(now = this.now()): void {
    if (this.ticking) return // a write below re-enters through the plans event
    this.ticking = true
    try {
      const prev = this.d.store.cases()
      const tasks = this.d.taskMode?.tasks(now) ?? []
      const subjects = this.subjects(now, tasks)
      // strict baseline: the first look that can see routed rows
      // marks every row already routed — it never rises
      const baseline = this.d.routedRows !== undefined && this.d.store.routedBaselineAt() === undefined
      if (!baseline && subjects.length === 0 && Object.keys(prev).length === 0) return
      const windowMs = this.d.store.windowMs()
      const isAgent = (id: string): boolean => this.d.isAgent(id) && (this.d.hopOk ? this.d.hopOk(id, now, windowMs) : true)
      const ev = evaluateEscalation({ subjects, prev, now, windowMs, chain: this.d.chain(), isAgent, baseline })
      // a task case's writes (its wait, blocked) land BEFORE the case is
      // kept as Silos' move: each hop due now, and every earlier one whose
      // writes did not land (writesDue) — tried again until they do
      const byKey = new Map(tasks.map((t) => [t.key, t]))
      const fired = new Set(ev.fire.filter((f) => f.c.kind === 'task').map((f) => f.c.id))
      for (const c of Object.values(ev.cases)) {
        if (c.kind !== 'task') continue
        if (!fired.has(c.id) && c.writesDue !== true) continue
        const last = c.hops[c.hops.length - 1]
        if (!last) continue
        if (this.taskWrites(c, last.to, byKey.get(c.key))) delete c.writesDue
        else c.writesDue = true
      }
      // persist first: a hop is said once, even if its message fails below
      this.d.store.commit(ev.cases, ev.closed, now)
      if (baseline) this.d.store.markRoutedBaseline(now)
      for (const c of ev.opened) if (c.kind === 'task') this.recoveryNote(c)
      const rowHops = new Map<string, Array<{ c: Case; to: string }>>()
      for (const f of ev.fire) {
        if (f.c.kind === 'task') {
          this.taskHop(f.c, f.to)
          continue
        }
        if (f.to === OWNER) continue // the owner's inbox lists the row (surfaces.ts)
        const k = `${f.c.silo}|${f.c.entry}|${f.to}`
        rowHops.set(k, [...(rowHops.get(k) ?? []), { c: f.c, to: f.to }])
      }
      for (const group of rowHops.values()) this.rowMessage(group)
    } finally {
      this.ticking = false
    }
  }

  private recoveryNote(c: Case): void {
    const name = this.d.nameOf(c.who)
    const what = c.notStarted ? `stuck: ${c.cause}.` : `stalled: ${c.cause}; one wake on ${when(c.wokeAt)} changed nothing.`
    this.d.appendNote(c.key, `${what} Silos marks it blocked and asks for help — ${name} stays its owner.`)
  }

  // Silos' move on the task for the hop to `to`: the wait names who is asked
  // now, and the task is blocked (blocked = a dependsOn or a waitingOn — this
  // one). Only what is not so already is written. true: both landed.
  private taskWrites(c: Case, to: string, t: TaskSnap | undefined): boolean {
    const wait = { owner: to, action: actionOf(c.ref) }
    // (H10) an agent hop: the file's wait and the armed fact — `waitOk`
    // compares both; only what is not so already is written
    if (to !== OWNER && this.d.asks) {
      const fileOk = t?.waitingFor?.owner === wait.owner && t.waitingFor.action === wait.action && t.waitingFor.asked === undefined && t.state === 'blocked'
      if (!fileOk && !this.d.asks.writeHop(c.key, wait.owner, wait.action)) return false
      if (!this.d.asks.hopArmed(c.key, wait.owner, wait.action)) this.d.asks.armHop(c.key, wait.owner, wait.action)
      return true
    }
    const waitOk = t?.waitingFor?.owner === wait.owner && t.waitingFor.action === wait.action ? true : this.d.setField(c.key, 'waitingOn', wait).ok
    if (!waitOk) return false
    return t?.state === 'blocked' ? true : this.d.setField(c.key, 'status', 'blocked').ok
  }

  private taskHop(c: Case, to: string): void {
    if (to === OWNER) return // the owner's row is the escalation surface itself
    // (H10) an agent hop is told by the ask it was armed with — its start
    // briefing and its packet list it — never by a second message
    if (this.d.asks) return
    const owner = this.d.nameOf(c.who)
    const before = c.hops
      .slice(0, -1)
      .map((h) => h.to)
      .filter((t) => t !== OWNER)
    this.d.message(
      to,
      [
        `${c.ref} «${c.title}» is stuck: ${c.cause}. It is ${owner}'s; ${c.notStarted ? `Silos could not get ${owner} working on it` : `Silos woke ${owner} once${c.wokeAt ? ` (${when(c.wokeAt)})` : ''} and nothing changed`}${before.length > 0 ? `, then asked ${before.map(this.d.nameOf).join(', ')}` : ''}.`,
        `Could you help unstick it — a note on the task with the next step, or a word with ${owner}? It waits on you now (waitingOn: ${actionOf(c.ref)}); moving it in any way closes this. This is a normal message, not an assignment: ${owner} stays its owner.`,
      ].join('\n'),
    )
  }

  private rowMessage(group: Array<{ c: Case; to: string }>): void {
    const { c, to } = group[0]!
    const producer = this.d.nameOf(c.who)
    const n = group.length
    const sample = group.slice(0, 5).map((g) => `- ${g.c.title}`)
    this.d.message(
      to,
      [
        `${n === 1 ? 'A row' : `${n} rows`} of ${c.siloName ?? c.silo} ${n === 1 ? 'has' : 'have'} been with ${producer} past its window and ${n === 1 ? 'is' : 'are'} not cleared:`,
        ...sample,
        ...(n > sample.length ? [`- …and ${n - sample.length} more`] : []),
        `Could you help ${producer} clear ${n === 1 ? 'it' : 'them'}? This is a normal message, not an assignment.`,
      ].join('\n'),
    )
  }

  // The routed rows the escalation reached the owner with — surfaces.ts
  // lists them in the owner's inbox again, with who was asked.
  escalatedRow(silo: string, entry: number, key: string): { since: string; asked: string[] } | null {
    const c = this.d.store.cases()[`row:${silo}:${entry}:${key}`]
    if (!c || !c.hops.some((h) => h.to === OWNER)) return null
    return { since: c.openedAt, asked: c.hops.map((h) => h.to).filter((t) => t !== OWNER) }
  }

  // The task cases that reached the owner: ONE blocking Needs you row each,
  // «plan#t3 stalled since … — asked Builder, then Finance; nobody moved it».
  ownerRows(): Array<{ c: Case; text: string; at: string }> {
    return Object.values(this.d.store.cases())
      .filter((c) => c.kind === 'task' && c.hops.some((h) => h.to === OWNER))
      .map((c) => {
        const asked = askedWords(c, this.d.nameOf)
        const text = c.notStarted
          ? `${c.ref} stuck since ${when(c.since)} — Silos could not start ${this.d.nameOf(c.who)}'s turn on it${asked !== '' ? `; ${asked}` : ''}; nobody moved it`
          : `${c.ref} stalled since ${when(c.since)} — ${asked !== '' ? asked : `one wake to ${this.d.nameOf(c.who)} changed nothing`}; nobody moved it`
        return { c, text, at: c.hops.find((h) => h.to === OWNER)!.at }
      })
  }

  // what the page says: the window, the cases open and the last closed
  view(): { windowHours: number; open: Case[]; closed: ReadonlyArray<Case & { closedAt: string }> } {
    return { windowHours: this.d.store.windowHours(), open: Object.values(this.d.store.cases()), closed: this.d.store.closed().slice(-10) }
  }
}

// The task's creator: the author of its first note, when that is an agent.
// Unknown otherwise (a plan's tasks carry no author field) — step 3 is then
// skipped, never guessed. Silos' own notes are nobody's: signed SILOS_AUTHOR.
export function creatorOf(t: Pick<TaskSnap, 'notes'>, isAgent: (id: string) => boolean): string | null {
  const first = t.notes.find((n) => n.by !== '' && !isSystemNote(n))
  return first && first.by !== 'owner' && first.by !== 'agent' && isAgent(first.by) ? first.by : null
}

const isSystemNote = (n: { by: string }): boolean => n.by === SILOS_AUTHOR
