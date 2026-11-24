// initiative.ts — the words and doors of what an agent created on its own
// (Decided/Measured, lone acts, Undo, Measures, baseline). Pure: the agent
// page, Home and Usage paint
// from here, so a word is said once.
import type { Creation, Measures } from './types'

/** The one sentence said when Undo is pressed. */
export const UNDO_SAYS = "Undo stops it. It doesn't undo what it did."

/** The door a Decided row carries: Undo a decision, Restore a withdrawal
 *  (m4-r7), Unpause a pause (m7 — the owner's, whoever paused it). */
export type DecidedDoor = 'undo' | 'restore' | 'unpause'

export interface DecidedRow {
  id: string
  text: string
  door: DecidedDoor
  // « — after reading <tool>» — the provenance mark
  outside: string | null
}

/** A ledger entry as its Decided row: «X decided: <title> ·
 *  Undo» · «X withdrew: <name> · Restore ›» · «X paused: <name> · Unpause». */
export function decidedRow(c: Creation, name: string): DecidedRow {
  const outside = c.readOutside && c.readOutside.length > 0 ? ` — after reading ${c.readOutside.join(', ')}` : null
  if (c.action === 'withdrew') return { id: c.id, text: `${name} withdrew: ${c.title}`, door: 'restore', outside }
  if (c.action === 'paused') return { id: c.id, text: `${name} paused: ${c.title}`, door: 'unpause', outside }
  return { id: c.id, text: `${name} decided: ${c.title}`, door: 'undo', outside }
}

/** The words on a door's button. */
export function doorWords(d: DecidedDoor): string {
  return d === 'undo' ? 'Undo' : d === 'restore' ? 'Restore ›' : 'Unpause'
}

/** The reactive tail folded in one line (m12): the inbox's abundance never
 *  buries the weekly decision and its Undo. null when there is none. */
export function reactiveFold(n: number): string | null {
  if (n <= 0) return null
  return `…and ${n} ${n === 1 ? 'task' : 'tasks'} from its inbox ›`
}

/** What Undo posts: a task by its key, an automation by its id. */
export function undoTarget(c: Creation): { task: string } | { automation: string } {
  return c.kind === 'task' ? { task: c.ref } : { automation: c.ref }
}

/** «Last 30 days: 3 initiatives · 2 kept · 1 undone» — the
 *  initiatives (signal mission) only; null when it took none: an empty
 *  measure is no line (Decided's rule — empty is nothing, no box). */
export function measuredLine(m: Measures | null | undefined): string | null {
  if (!m || m.initiatives.created === 0) return null
  const i = m.initiatives
  return `Last 30 days: ${i.created} ${i.created === 1 ? 'initiative' : 'initiatives'} · ${i.kept} kept · ${i.undone} undone`
}

// how many times, as Measured says it: «once», «twice», «3 times»
const times = (n: number): string => (n === 1 ? 'once' : n === 2 ? 'twice' : `${n} times`)

/** The class of a heartbeat's turn Measured counts apart from the max:
 *  «Heartbeat: looked twice today», «Heartbeat: 5 rounds
 *  today» — one entry per class. */
export type BeatClass = 'look' | 'think' | 'round'
const BEAT_WORDS: Record<BeatClass, (n: number) => string> = {
  look: (n) => `looked ${times(n)} today`,
  think: (n) => `thought ${times(n)} today`,
  round: (n) => `${n} ${n === 1 ? 'round' : 'rounds'} today`,
}
const BEAT_FIELD: Record<BeatClass, 'looks' | 'thinks' | 'rounds'> = { look: 'looks', think: 'thinks', round: 'rounds' }

/** Measured's heartbeat line, apart from «Started N times today · max C»:
 *  what its heartbeat did today, by class; null when it took no turn
 *  (empty is no line). */
export function heartbeatDayLine(b: { looks: number; thinks?: number; rounds?: number } | null | undefined): string | null {
  if (!b) return null
  const parts = (Object.keys(BEAT_WORDS) as BeatClass[]).filter((k) => (b[BEAT_FIELD[k]] ?? 0) > 0).map((k) => BEAT_WORDS[k](b[BEAT_FIELD[k]] ?? 0))
  return parts.length > 0 ? `Heartbeat: ${parts.join(' · ')}` : null
}

/** The baseline row: «<n> tasks existed before Silos watched this
 *  folder — Keep them all ›». */
export function baselineWords(n: number): string {
  return `${n} ${n === 1 ? 'task' : 'tasks'} existed before Silos watched this folder`
}

/** The sheet's button: «Keep them all» while none is left out, else the
 *  count it keeps. */
export function baselineKeepWords(total: number, excluded: number): string {
  return excluded === 0 ? 'Keep them all' : `Keep ${total - excluded} of ${total}`
}
