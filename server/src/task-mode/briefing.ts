// task-mode/briefing.ts — the first words of a task-mode turn (task-view
// phase 3, «the wake briefing»). Two shapes, one voice:
//
//   wakeBriefing   Silos woke the owner for ONE task: «this turn is about
//                  plan#t4; don't switch tasks», why (each reason in plain
//                  words), the owner's new notes, and «acknowledge the latest
//                  note first and say how it changes your next action».
//   workBriefing   the owner pressed «Work on this»: the same scope, the task
//                  as it stands, its latest notes, and whatever wakes were
//                  waiting for this conversation.
//
// Plain text, capped (BRIEFING_MAX): it travels as the console's first
// prompt (one argv element) or as a headless turn's text. Notes are the
// owner's and the agents' words, quoted as notes — never instructions above
// the task.
import { UNVERIFIED_OWNER, type TaskNote, type TaskSnap } from './evaluate.js'

export const BRIEFING_MAX = 4000
const NOTE_MAX = 600

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s)
// a note signed "owner" that the owner did not write in Silos is an agent's:
// never «the owner» in a briefing
const who = (by: string, nameOf: (id: string) => string): string =>
  by === 'owner'
    ? 'the owner'
    : by === UNVERIFIED_OWNER
      ? 'an agent (signed «owner» — not written by the owner in Silos)'
      : by === 'agent' || by === ''
        ? 'an agent'
        : nameOf(by)
const noteLine = (n: TaskNote, nameOf: (id: string) => string): string =>
  `- ${who(n.by, nameOf)}${n.at ? ` (${n.at})` : ''}: ${clip(n.text.replace(/\s+/g, ' ').trim(), NOTE_MAX)}${n.readOutside && n.readOutside.length > 0 ? ` — written after reading the web (${n.readOutside.join(', ')})` : ''}`

function where(t: Pick<TaskSnap, 'file' | 'id'>): string {
  return t.file
    ? `The task lives in ${t.file} (task ${t.id}). Read the plan before you write, and read it back after.`
    : `Task ${t.id} — read its plan before you write, and read it back after.`
}

// The LAST line (R6 — the feed recognises a briefing by its FIRST): an agent
// bound to Task mode has the protocol; one that is not is told the
// dispositions in so many words.
export const DISPOSITION_BOUND = 'Leave the task with an explicit disposition (your task-mode protocol).'
export const DISPOSITION_UNBOUND =
  'Leave the task with an explicit disposition: done (finished and verified) · in_review only with a real reviewer · blocked with dependsOn or waitingOn · in_progress only while you keep working here.'
const disposition = (bound: boolean | undefined): string => (bound === false ? DISPOSITION_UNBOUND : DISPOSITION_BOUND)

function cap(lines: string[]): string {
  const text = lines.join('\n')
  return text.length > BRIEFING_MAX ? `${text.slice(0, BRIEFING_MAX - 1)}…` : text
}

export function wakeBriefing(
  t: Pick<TaskSnap, 'ref' | 'title' | 'file' | 'id'> & { key?: string },
  reasons: ReadonlyArray<{ says: string }>,
  notes: readonly TaskNote[],
  nameOf: (id: string) => string = (id) => id,
): string {
  const lines = [
    `Silos woke you for ONE task — this turn is about ${t.ref} «${t.title}». Don't switch tasks: your other tasks get turns of their own.`,
    `Why: ${[...new Set(reasons.map((r) => r.says))].join('; ')}.`,
  ]
  if (notes.length > 0) {
    lines.push(
      '',
      'New notes on it:',
      ...notes.map((n) => noteLine(n, nameOf)),
      '',
      'Acknowledge the latest note first and say how it changes your next action.',
    )
  }
  // what a task this turn creates must say it answers: the exact form the
  // server matches
  lines.push(
    '',
    where(t),
    ...(t.key
      ? [`A task you create in this turn says "signal":"task:${t.key}" — that is this task's key in Silos, copied as it is; it is not a path on disk.`]
      : []),
    DISPOSITION_BOUND,
  )
  return cap(lines)
}

// claimBriefing — the answer to an agent's own claim:
// the same scope as the work briefing, in the agent's voice of the
// gesture («you claimed»), its latest notes, and who else worked it — the
// conversations of its thread outside this one, said by agent, title and
// how long ago they moved. `queued`: the wakes of a bound owner that were
// waiting for it (TaskModeEngine.claimWakes) — they reach it here; `bound`
// picks the last line (R6).
export function claimBriefing(
  t: Pick<TaskSnap, 'ref' | 'title' | 'file' | 'id' | 'notes'>,
  others: ReadonlyArray<{ says: string }>,
  opts: {
    linked: boolean
    tookOver: boolean
    queued?: ReadonlyArray<{ says: string; notes: readonly TaskNote[] }>
    bound?: boolean
    state?: string
    kept?: boolean
  },
  nameOf: (id: string) => string = (id) => id,
): string {
  // the state the claim left (`kept`: the verb's keep held it — still waiting)
  const state = (opts.state ?? 'in_progress').replace(/_/g, ' ')
  const lines = [
    `You claimed ONE task — ${t.ref} «${t.title}». It ${opts.kept ? `stays ${state} (what it waits on is still open)` : `is ${state}`}${opts.linked ? ' and this conversation is linked to it' : ''}. Stay on it; your other tasks get turns of their own.`,
  ]
  if (others.length > 0) lines.push('', `${opts.tookOver ? 'You took it over from' : 'Also worked by'}: ${others.map((o) => o.says).join('; ')}.`)
  const queued = opts.queued ?? []
  if (queued.length > 0) lines.push('', `Waiting for you on it: ${[...new Set(queued.map((q) => q.says))].join('; ')}.`)
  const waiting = queued.flatMap((q) => q.notes)
  const latest = waiting.length > 0 ? waiting : t.notes.slice(-3)
  if (latest.length > 0) lines.push('', waiting.length > 0 ? 'New notes on it:' : 'Its latest notes:', ...latest.map((n) => noteLine(n, nameOf)))
  lines.push('', where(t), disposition(opts.bound))
  return cap(lines)
}

export function workBriefing(
  t: Pick<TaskSnap, 'ref' | 'title' | 'file' | 'id' | 'state' | 'notes'>,
  queued: ReadonlyArray<{ says: string; notes: readonly TaskNote[] }>,
  nameOf: (id: string) => string = (id) => id,
  opts: { bound?: boolean } = {},
): string {
  const lines = [
    `The owner opened this conversation to work ONE task — ${t.ref} «${t.title}» (${t.state.replace('_', ' ')}). Stay on it; your other tasks get turns of their own.`,
  ]
  const waiting = queued.flatMap((q) => q.notes)
  if (queued.length > 0) lines.push(`Waiting for you on it: ${[...new Set(queued.map((q) => q.says))].join('; ')}.`)
  const latest = waiting.length > 0 ? waiting : t.notes.slice(-3)
  if (latest.length > 0) {
    lines.push('', waiting.length > 0 ? 'New notes on it:' : 'Its latest notes:', ...latest.map((n) => noteLine(n, nameOf)))
    if (waiting.length > 0 || latest.some((n) => n.by === 'owner')) lines.push('', 'Acknowledge the latest note first and say how it changes your next action.')
  }
  lines.push('', where(t), disposition(opts.bound))
  return cap(lines)
}
