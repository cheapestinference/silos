// answer-wait.ts — what an answer IS on a task the owner is shown: ONE
// pure choice over the task as the
// surface painted it, the same call that gives the button its label.
//   gate  a task of a person's (the owner's) that agents' open tasks wait on
//         directly — «Answer & done»: `respond` lands the text on each waiter
//         and closes the gate
//   wait  anything else waiting on someone — «Answer» (on a review, «Send
//         back»): the verb `answer` (lib/task-gesture.ts act), ONE write —
//         the note, the wait out, the state (in review → pending; blocked →
//         pending when nothing else holds it)
// What still holds a task after its answer comes back from the server
// (`holds`, task-flow.ts blockedHolds); a dropped dependency among them is
// said with its labels and its door (stuckWords): the row
// never vanishes as if it moved.
import { api } from './api'
import { act } from './task-gesture'
import { isHumanOwner, type TaskView } from './tasks'

type Wait = { owner: string; action: string; asked?: string; options?: string[] }
type Painted = {
  key: string
  owner: string
  state: string
  waitingOn: Wait | null
  flow?: { unblocks?: Array<{ id: string; owner: string }>; waitsOn?: Wait | null } | null
}

export type AnswerKind = 'gate' | 'wait'
export function answerKind(t: Pick<Painted, 'owner' | 'flow'>, agentIds: ReadonlySet<string>): AnswerKind {
  return isHumanOwner(t.owner, agentIds) && (t.flow?.unblocks?.length ?? 0) > 0 ? 'gate' : 'wait'
}

// the question the surface painted — the kernel's reading of the wait when
// the row carries it, else the file's — '' when it asked none (what
// `answer` and `approve` send as `asked`)
export function paintedAsked(t: Pick<Painted, 'waitingOn' | 'flow'>): string {
  const w = t.flow?.waitsOn !== undefined ? t.flow.waitsOn : t.waitingOn
  return (w?.asked ?? '').trim()
}

// an AGENT's task in review that waits on YOU: its door is Approve and Send
// back — never left in review without a wait
export function reviewWaitsOnYou(t: Pick<Painted, 'owner' | 'state' | 'waitingOn' | 'flow'>, agentIds: ReadonlySet<string>): boolean {
  const w = t.flow?.waitsOn !== undefined ? t.flow.waitsOn : t.waitingOn
  return t.state === 'in_review' && agentIds.has(t.owner) && w?.owner === 'owner'
}

// a dropped dependency an answer cannot clear
export interface StuckOn {
  id: string
  key: string | null
  title: string | null
}
// «it still waits on proj#t3 «Video», which was dropped — that never
// resolves: remove the dependency or reopen it». `label`: how the caller
// paints a sibling by id (lib/tasks.ts labelOf — never the raw id); where
// to do it is the caller's door (the task's page holds both ways out).
export function stuckWords(stuck: readonly StuckOn[], label: (id: string) => string): string {
  const one = stuck.length === 1
  const names = stuck.map((s) => `${label(s.id)}${s.title ? ` «${s.title}»` : ''}`).join(', ')
  return `it still waits on ${names}, which ${one ? 'was' : 'were'} dropped — that never resolves: remove the dependency or reopen ${one ? 'it' : 'them'}`
}
// the dropped dependencies among what still holds it (`holds` from the
// answer), read from the siblings the surface already has
export function droppedOf(
  holds: readonly string[],
  t: Pick<TaskView, 'planKey'>,
  siblings: readonly Pick<TaskView, 'key' | 'id' | 'planKey' | 'state' | 'title'>[],
): StuckOn[] {
  return holds.flatMap((id) => {
    const s = siblings.find((x) => x.planKey === t.planKey && x.id === id)
    return s && s.state === 'cancelled' ? [{ id, key: s.key, title: s.title || null }] : []
  })
}

export interface AnswerApi {
  respond(silo: string, body: { key: string; text: string; state: string }): Promise<{ notified?: Array<{ key: string; owner: string }> }>
  answer(key: string, text: string, asked: string): Promise<{ holds: string[] }>
}
const defaultApi: AnswerApi = {
  respond: (s, b) => api.silos.respond(s, b),
  answer: (key, text, asked) => act(key, 'answer', { text, asked }),
}

// The owner's answer to the task as painted: the gate's respond, or the
// verb answer with the question painted. Throws the server's refusal.
export async function answerTask(
  t: Painted,
  text: string,
  agentIds: ReadonlySet<string>,
  deps: AnswerApi = defaultApi,
): Promise<{ closed: boolean; notified: Array<{ key: string; owner: string }>; holds: string[] }> {
  const words = text.trim()
  if (words === '') throw new Error('an empty answer says nothing')
  if (answerKind(t, agentIds) === 'gate') {
    const r = await deps.respond('plans', { key: t.key, text: words, state: t.state })
    return { closed: true, notified: r.notified ?? [], holds: [] }
  }
  const r = await deps.answer(t.key, words, paintedAsked(t))
  return { closed: false, notified: [], holds: r.holds }
}
