// proactive.ts — the proactive mode's counts and words around the ledger
// PURE — the ledger and the tasks' state in, the
// answer out. One source for the judge (plans-provenance.ts judgeCreation,
// by API and by file alike), the round's packet blocks («Yours, open»,
// «Yours, undone») and the account margin a round waits on.
//
//   root      a creation's root is `mission` when its signal is `mission`,
//             or it answers a task or a message whose root is — the
//             day's count and the open tasks are counted by root, so what
//             an initiative creates in turn (in a wake, or through a
//             colleague's message) spends the same count
//   day       creations with root mission in the local day ≤ perDay; one
//             undone gives nothing back (Silos' taint undo included)
//   open      its open TASKS with root mission ≤ PROACTIVE_OPEN_MAX
//   undone    what it created so and, in the last 30 days, the owner undid,
//             Silos undid as tainted, or it withdrew — never what never
//             existed (a 429, a 403: `rejected` refusals)
//   duplicate a title (trimmed, case-insensitive) equal to one open or one
//             undone — literal equality only (no fuzzy likeness)
import type { Creation } from './creations.js'
import { counted } from './creations.js'
import { localYmd } from './control.js'
import { PROACTIVE_OPEN_MAX, ROUND_ACCOUNT_HEADROOM, ROUND_USAGE_FRESH_MS } from './limits.js'

const DAY_MS = 24 * 3600_000
export const UNDONE_WINDOW_MS = 30 * DAY_MS
const TAINT_UNDO = 'Undone by Silos'

/** A task as the plans reading has it now. */
/** A task as the plans reading has it now — and, cancelled, who cancelled
 *  it and when (task-cancellations.ts: the owner only when Silos recorded
 *  the owner's gesture; `at` from the journal, null when unknown). */
export interface TaskNow {
  status: string
  title: string
  ref?: string
  at?: number
  cancel?: { at: string | null; byOwner: boolean }
}
const OPEN = (t: TaskNow | null): boolean => t !== null && t.status !== 'done' && t.status !== 'cancelled'

/** Silos undid it as tainted (its `rejected` is the undo, not a refusal). */
export function taintUndone(c: Creation): boolean {
  return !!c.rejected && !c.adopted && c.rejected.why.startsWith(TAINT_UNDO)
}

/** A creation that was MADE (it existed): counted, or undone by Silos'
 *  taint — an undo never gives the count back. */
export function wasMade(c: Creation): boolean {
  return !c.action && (counted(c) || taintUndone(c))
}

/** Its TASKS with root mission made in the local day of `now` — and each
 *  reopen of one of them that day (a reopen is a creation of its day, so
 *  editing an old task never skips the count). Its own recurring work has
 *  its own weekly counter and never spends the day's count. */
export function madeFromMissionToday(ledger: readonly Creation[], now: number): number {
  const day = localYmd(now)
  const onDay = (at: string): boolean => localYmd(Date.parse(at) || 0) === day
  let n = 0
  for (const c of ledger) {
    if (c.kind !== 'task' || c.root !== 'mission' || !wasMade(c)) continue
    if (onDay(c.createdAt)) n++
    n += (c.reopenedAt ?? []).filter(onDay).length
  }
  return n
}

export interface OpenItem {
  ref: string
  key: string
  title: string
  status: string
  createdAt: string
}
export interface UndoneItem {
  ref: string
  key: string
  title: string
  by: 'the owner' | 'Silos' | 'you'
  why: string
  at: string
}

/** «Yours, open»: its open tasks with root mission, oldest first —
 *  the WHOLE list (the prompt truncates, the duplicate check never does). */
export function missionOpen(ledger: readonly Creation[], task: (key: string) => TaskNow | null): OpenItem[] {
  const out: OpenItem[] = []
  for (const c of ledger) {
    if (c.kind !== 'task' || c.root !== 'mission' || !counted(c) || c.undoneAt) continue
    const t = task(c.ref)
    if (!OPEN(t)) continue
    out.push({ ref: t!.ref ?? c.ref, key: c.ref, title: t!.title || c.title, status: t!.status, createdAt: c.createdAt })
  }
  return out
}

/** «Yours, undone»: what it created with root mission and, in the
 *  last 30 days, the owner undid, Silos undid as tainted, or it withdrew
 *  (the task cancelled with no undo of anyone — the only canceller left is
 *  — the task cancelled with no undo: «undone by the owner» when Silos
 *  recorded the owner's Drop, else «withdrawn by you»; the 30 days counted
 *  from the cancellation when it is known, else from the creation). Never a
 *  refusal. */
export function missionUndone(ledger: readonly Creation[], task: (key: string) => TaskNow | null, now: number): UndoneItem[] {
  const out: UndoneItem[] = []
  for (const c of ledger) {
    if (c.kind !== 'task' || c.root !== 'mission' || c.action) continue
    const t = task(c.ref)
    const ref = t?.ref ?? c.ref
    const title = t?.title || c.title
    if (c.undoneAt) {
      if (now - (Date.parse(c.undoneAt) || 0) <= UNDONE_WINDOW_MS) out.push({ ref, key: c.ref, title, by: 'the owner', why: 'undone', at: c.undoneAt })
    } else if (taintUndone(c)) {
      if (now - (Date.parse(c.rejected!.at) || 0) <= UNDONE_WINDOW_MS)
        out.push({ ref, key: c.ref, title, by: 'Silos', why: c.rejected!.why, at: c.rejected!.at })
    } else if (counted(c) && t !== null && t.status === 'cancelled') {
      const at = t.cancel?.at ?? c.createdAt
      if (now - (Date.parse(at) || 0) > UNDONE_WINDOW_MS) continue
      if (t.cancel?.byOwner) out.push({ ref, key: c.ref, title, by: 'the owner', why: 'dropped', at })
      else out.push({ ref, key: c.ref, title, by: 'you', why: 'withdrawn', at })
    }
  }
  return out
}

const norm = (s: string): string => s.trim().toLowerCase()

/** A literal duplicate: the open one first, then the undone one. */
export function duplicateOf(title: string, open: readonly OpenItem[], undone: readonly UndoneItem[]): { open: OpenItem } | { undone: UndoneItem } | null {
  const t = norm(title)
  if (t === '') return null
  const o = open.find((x) => norm(x.title) === t)
  if (o) return { open: o }
  const u = undone.find((x) => norm(x.title) === t)
  if (u) return { undone: u }
  return null
}

// ── the words (exact) ──
export const dayMaxWords = (n: number): string => `you created ${n} things from your mission today — your max; do not retry in this heartbeat`
// in a task wake (no sealed regime): the same count, said for a wake
export const dayMaxWakeWords = (n: number): string => `you created ${n} things from your mission today — your max; leave it as a note on your task`
export const openMaxWords = (n: number): string => `you have ${n} things of your own from your mission open already — finish or withdraw one first`
export const duplicateOpenWords = (ref: string): string => `you have this open already: ${ref}`
export const duplicateUndoneWords = (ref: string): string => `this was undone: ${ref} — propose it if it matters`
export const OWN_MESSAGE_NO_SIGNAL = 'a message of your own is no signal'
export const ROUND_TASK_IS_YOURS = 'a task you create on a round is yours — leave another agent a message'
export const ROUND_TASK_NO_WAIT = "a task you create on a round can't wait on someone — leave it pending with a note"
// a reopen over its count, by file: the task goes back to what it was
export const noteReopenRefused = (status: string, words: string): string => `Silos set it back to ${status}: ${words}`
export const ROUND_RECURRING_PROPOSED = 'on a round with your tools, scheduled work of your own is proposed — POST /api/proposals'

/** The open cap for a proactive agent. */
export const openCapReached = (open: number): boolean => open >= PROACTIVE_OPEN_MAX

/** The packet's state blocks, one line per item, ≤ `max` each. */
export function openLines(items: readonly OpenItem[], now: number, max: number): string[] {
  return items.slice(-max).map((x) => `${x.ref} — ${x.title} — ${x.status} — ${ageWords(now - (Date.parse(x.createdAt) || now))}`)
}
export function undoneLines(items: readonly UndoneItem[], max: number): string[] {
  return items.slice(-max).map((x) => `${x.ref} — ${x.title} — ${x.by === 'you' ? 'withdrawn by you' : `by ${x.by}`}, ${x.why}`)
}
function ageWords(ms: number): string {
  const h = Math.max(0, Math.floor(ms / 3600_000))
  if (h < 1) return 'under an hour old'
  if (h < 48) return `${h} hour${h === 1 ? '' : 's'} old`
  return `${Math.floor(h / 24)} days old`
}

// ── the account margin ──

/** A plan reading as plan-usage gives it (the fields the margin reads). */
export type MarginReading =
  | {
      ok: true
      at: number
      windows: ReadonlyArray<{ kind: string; label: string; percent: number; windowMs: number | null; resetsAt: string | null; active: boolean }>
    }
  | { ok: false; at: number }

export interface Margin {
  /** a reading younger than ROUND_USAGE_FRESH_MS, by its hour (never `stale`) */
  fresh: boolean
  /** the fullest window at or past ROUND_ACCOUNT_HEADROOM, if any */
  over: { percent: number; window: '5-hour' | 'weekly' } | null
}

/** «5-hour» for the session window, «weekly» for any other (the weekly ones
 *  per model included — every weekly window counts). */
export function windowWord(w: { kind: string; windowMs: number | null }): '5-hour' | 'weekly' {
  return w.kind === 'session' || w.kind === 'five_hour' || w.windowMs === 5 * 3600_000 ? '5-hour' : 'weekly'
}

export function marginOf(reading: MarginReading | null, now: number): Margin {
  if (!reading || !reading.ok || now - reading.at >= ROUND_USAGE_FRESH_MS) return { fresh: false, over: null }
  let over: Margin['over'] = null
  for (const w of reading.windows) {
    if (w.percent < ROUND_ACCOUNT_HEADROOM) continue
    if (!over || w.percent > over.percent) over = { percent: Math.round(w.percent), window: windowWord(w) }
  }
  return { fresh: true, over }
}

export const headroomWords = (name: string, o: NonNullable<Margin['over']>): string =>
  `${name}'s account is at ${o.percent}% of its ${o.window} window — rounds wait so there is room for you`
export const unreadableWords = (name: string): string => `Silos can't read ${name}'s account usage right now — rounds wait`
export const unmeasuredWords = (name: string, n: number): string => `Silos can't measure this provider — ${name} made its ${n} rounds for today`
export const runNowMarginWords = (name: string, o: NonNullable<Margin['over']>): string =>
  `${name}'s account is at ${o.percent}% of its ${o.window} window — run it later`
export const shareWords = (name: string): string => `${name} spent half its day's cap — rounds wait, its tasks go on`
export const quotaWords = (n: number): string => `made its ${n} creations today and nothing arrived`

/** The account at its limit (step 5), from the same reading as the margin
 *  (the account the turn will run on): a window at 100 % — with its reset
 *  when the reading says it, null when it does not (still at its limit: it
 *  waits for its next slot) — or null when no window is. */
export function limitOf(reading: MarginReading | null, now: number): { resetsAt: string | null } | null {
  if (!reading || !reading.ok) return null
  const at = reading.windows.filter((w) => w.percent >= 100 && (w.resetsAt === null || Date.parse(w.resetsAt) > now))
  if (at.length === 0) return null
  const w = at.find((x) => x.active) ?? at[0]!
  return { resetsAt: w.resetsAt }
}

/** The open count of tasks with root mission. */
export function openFromMissionRoot(ledger: readonly Creation[], open: (ref: string) => boolean): number {
  return ledger.filter((c) => c.kind === 'task' && c.root === 'mission' && counted(c) && !c.undoneAt && !c.handedAt && open(c.ref)).length
}

/** A proactive agent's own recurring work created this week (its own
 *  counter, SELF_RECURRENT_PER_WEEK): automations it made with
 *  signal mission in 7 sliding days. */
export function selfRecurrentThisWeek(ledger: readonly Creation[], now: number): Creation[] {
  return ledger.filter((c) => c.kind === 'automation' && c.signal === 'mission' && wasMade(c) && now - (Date.parse(c.createdAt) || 0) < 7 * DAY_MS)
}
