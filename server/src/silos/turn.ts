// silos/turn.ts — WHOSE turn a task is, in one sentence, composed on the
// server (the «turn sentence»). One function for
// every surface — the task page's banner, a row that wants the reading, the
// digest — so they cannot drift apart (the inbox's own rule: composed on the
// server so Home can never disagree). Derived ONLY from the record, its
// siblings and the request's live facts (taskFlow + taskEnv), never stored.
//
// The kinds, in the order they are decided:
//   done     settled — pages hide the banner, lists read the state word
//   waiting  a declared waitingOn, or unfinished dependencies: the sentence
//            names who it waits on, in the file's words, and whose turn
//            comes after
//   parked   a PERSON's future nextCheckAt: out of Needs you until the date
//            (an agent's future check stays `waiting` with its own words)
//   stalled  the kernel's stall (task-flow): said with its cause — the task
//            page keeps its richer stalled/waking banner on top of this
//   yours    ready and a person's: what finishing it hands out
//   start    an agent that only runs when opened holds it: the
//            owner's turn to start — or continue — it there (the door is the
//            action: «Not started — it opens with Writer and you»)
//   idle     ready and nobody on it, its agent in task mode
//            and no wake on the way: «Ready — nobody is on it» (the page
//            offers «Start X ›» and the door)
//   theirs   ready and an agent's: working now, or how it wakes
//
// The wake clauses say the SAME words as the web's wakesWords — one voice,
// pinned by test here (the server owns them; the web renders them).
import { taskFlow, taskLive, taskStateRead, type StalledCause, type TaskEnv, type Wakes } from './task-flow.js'
import type { EvalRecord, FieldDict } from './expressions.js'
import { unblocksWords } from './voice.js'
import { conversationIdsOf } from '../task-threads.js'

export type TurnKind = 'done' | 'waiting' | 'parked' | 'stalled' | 'yours' | 'start' | 'idle' | 'theirs'
export interface TaskTurn {
  kind: TurnKind
  sentence: string
}

type Json = Record<string, unknown>
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)
const isStr = (v: unknown): v is string => typeof v === 'string'
const FINISHED = new Set(['done', 'cancelled'])

// the stall causes in surface words, said so they are TRUE beside every
// status. THE OTHER HALF is web/src/lib/tasks.ts
// `causeWords` (CAUSE_ON_CHAIN / CAUSE_OF_ITS_OWN): the same rule and the same
// words — change one, change both. A cause down the chain (the kernel's
// stalledBy is another task) is said with «waits on …»; a cause that is the
// task's own (stalledBy absent or itself) says what is wrong with IT.
const STALL_ON_CHAIN: Record<StalledCause, string> = {
  unowned: 'waits on a task nobody owns',
  'blocked-on-nothing': 'waits on a blocked task that names nothing it waits on',
  'blocker-missing': "waits on a task its plan doesn't have",
  'blocker-cycle': 'waits on tasks that wait on each other',
  'blocker-parked': 'waits on untouched work',
  'blocker-cancelled': 'waits on a dropped task',
  'owner-cannot-run': 'waits on a task whose owner never wakes on its own',
  // never down the chain: the kernel says a blocker in these as untouched work
  'review-without-reviewer': 'waits on untouched work',
  'in-progress-nothing-live': 'waits on untouched work',
}
const STALL_OF_ITS_OWN: Record<StalledCause, string> = {
  unowned: 'nobody owns it',
  'blocked-on-nothing': 'blocked, and it names nothing it waits on',
  'blocker-missing': "waits on a task its plan doesn't have",
  'blocker-cycle': 'waits on a task that waits back on it',
  'blocker-parked': 'waits on untouched work',
  'blocker-cancelled': 'waits on a dropped task',
  'owner-cannot-run': 'its owner never wakes on its own',
  'review-without-reviewer': 'in review — nobody is reviewing it',
  'in-progress-nothing-live': 'in progress, but nothing is working on it',
}

// an agent's task set aside until a date (P8): what happens then depends on
// how it moves — only Task mode acts on the date itself
function notNowWords(w: string, day: string): string {
  if (w === 'task') return `Not now — Silos wakes its owner on it on ${day}.`
  return `Not now — on ${day} it is back with you to start.`
}

// how an agent moves, as a clause after «it wakes …» — the web's wakesWords
function wakeClause(w: Wakes): string {
  switch (w) {
    case 'task':
      return 'when its task moves — Silos wakes it'
    default:
      return 'only when someone talks to it'
  }
}

// «Nov 21» — absolute, so a composed sentence does not tick stale
function dayWords(iso: string): string {
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return iso
  return new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

export interface TurnVoice {
  now: number
  isAgent?: (v: string) => boolean
  taskEnv?: TaskEnv
  nameOf?: (id: string) => string
  // the task's record key, when the caller has it (a wake on the way is
  // asked by it — task-flow's wakeOnTheWay)
  key?: string
  // the ids of the tasks its plan's file holds that the
  // reader could not build (voice.ts KindRecord.unreadableSiblings)
  unreadableSiblings?: readonly string[]
}

// «just now», «2 min ago», «3 h ago», «2 d ago» — a relative moment, said at
// request time (the sentence is composed per request, never stored)
export function agoWords(ms: number, now: number): string {
  const m = Math.max(0, Math.floor((now - ms) / 60_000))
  if (m < 1) return 'just now'
  if (m < 60) return `${m} min ago`
  const h = Math.floor(m / 60)
  return h < 24 ? `${h} h ago` : `${Math.floor(h / 24)} d ago`
}

// « — last in «title» 2 min ago» over a task's listed conversations (the
// newest the env can date, else the last listed); '' when the env knows none
function lastWords(env: TaskEnv | undefined, ids: readonly string[], now: number): string {
  if (!env?.titleOf || ids.length === 0) return ''
  let best: { title: string | null; at: number | null } | null = null
  for (const id of ids) {
    const t = env.titleOf(id)
    if (!t) continue
    if (best === null || (t.at ?? -1) >= (best.at ?? -1)) best = t
  }
  if (!best || (best.title === null && best.at === null)) return ''
  const when = best.at !== null ? ` ${agoWords(best.at, now)}` : ''
  return best.title ? ` — last in «${best.title}»${when}` : ` — last${when}`
}

// `task` and `siblings` as the kernel reads them (normalized); `dict` the
// sub-kind's dictionary (roles.task resolved); `refOf` says a sibling's ref
// in the one form (task-ref.ts — views.ts siblingRefOf): `<project>#t3` for
// the project's list, `<plan>#t3` otherwise.
export function turnOf(
  task: EvalRecord,
  siblings: readonly EvalRecord[],
  dict: Pick<FieldDict, 'task'>,
  refOf: (id: string) => string,
  v: TurnVoice,
): TaskTurn | null {
  const role = dict.task
  if (!role) return null
  const isAgent = v.isAgent ?? (() => false)
  const name = (id: string): string => (v.nameOf ? v.nameOf(id) : id)
  const who = (id: string): string => (id === 'owner' ? 'you' : isAgent(id) ? name(id) : id)
  const ownerOf = (t: EvalRecord): string => (isStr(t[role.owner]) && (t[role.owner] as string).trim() !== '' ? (t[role.owner] as string).trim() : '')
  const owner = ownerOf(task)
  const human = owner !== '' && !isAgent(owner)
  // a blocked task nothing holds reads as pending (A1.5 — task-flow.ts
  // taskStateRead, the one rule)
  const state = taskStateRead(task, (id) => siblings.find((s) => String(s.id) === id), role, v.now)
  const ref = (t: EvalRecord): string => refOf(String(t.id))

  if (FINISHED.has(state)) return { kind: 'done', sentence: '' }

  const flow = taskFlow(task, siblings, dict, {
    now: v.now,
    isAgent,
    ...(v.taskEnv ? { taskEnv: v.taskEnv } : {}),
    ...(v.key ? { key: v.key } : {}),
    ...(v.unreadableSiblings ? { unreadableSiblings: v.unreadableSiblings } : {}),
  })
  // (E1) the stall is said first only by the task that is its own SEAT — a
  // task waiting on another's stall keeps «Waiting — waits on …»
  const seat = flow.stalled && flow.stalledCause !== null && flow.stalledAt === String(task.id)
  const ownStall = !flow.stalledBy || flow.stalledBy === String(task.id)
  const stallSentence = (cause: StalledCause): TaskTurn => ({
    kind: 'stalled',
    sentence: `${cause === 'blocker-cancelled' ? 'Blocked' : 'Sits untouched'} — ${(ownStall ? STALL_OF_ITS_OWN : STALL_ON_CHAIN)[cause]}.`,
  })

  // a declared wait on someone — the file's own words win
  if (flow.waitsOn) {
    const w = task[role.waitingOn ?? ''] as Json | undefined
    const asked = isObj(w) && isStr(w.asked) && w.asked !== '' ? w.asked : null
    const tail = asked ? `: «${asked}»` : flow.waitsOn.action !== '' ? `: ${flow.waitsOn.action}` : ''
    return { kind: 'waiting', sentence: `Waiting on ${who(flow.waitsOn.owner)}${tail}.` }
  }

  // a future next check: a person's is a park, an agent's is its own rhythm
  const checkIso = role.nextCheckAt && isStr(task[role.nextCheckAt]) ? (task[role.nextCheckAt] as string) : null
  const checkMs = checkIso ? Date.parse(checkIso) : NaN
  if (checkIso && !Number.isNaN(checkMs) && checkMs > v.now) {
    return human
      ? { kind: 'parked', sentence: `Parked — out of Needs you; back on ${dayWords(checkIso)}.` }
      : { kind: 'waiting', sentence: notNowWords(v.taskEnv ? v.taskEnv.wakes(String(task[role.owner] ?? '')) : 'never', dayWords(checkIso)) }
  }

  // unfinished dependencies: name the direct blockers and whose turn follows
  const byId = new Map(siblings.map((s) => [String(s.id), s]))
  const deps = Array.isArray(task[role.dependsOn]) ? (task[role.dependsOn] as unknown[]).filter(isStr) : []
  // a dropped (cancelled) blocker never resolves (done alone does — the
  // kernel's rule): said first, for a person's task too — the kernel never
  // stalls a person's, and «Your turn» on work that waits on nothing that
  // will ever finish was a lie. The way out is on the page:
  // remove that dependency, or reopen it.
  const dead = deps.map((d) => byId.get(d)).filter((b): b is EvalRecord => b !== undefined && String(b.state) === 'cancelled')
  if (dead.length > 0) {
    return {
      kind: 'stalled',
      sentence: `Blocked — waits on ${ref(dead[0]!)}, which was dropped${dead.length > 1 ? ` (and ${dead.length - 1} more)` : ''}; it never resolves — remove that dependency or reopen it.`,
    }
  }
  const open = deps.map((d) => byId.get(d)).filter((b): b is EvalRecord => b !== undefined && !FINISHED.has(String(b.state)))
  // (E6) a dependency the plan's file holds but the reader could not build
  const unread = deps.filter((d) => !byId.has(d) && (v.unreadableSiblings ?? []).includes(d))
  if (open.length > 0 || unread.length > 0 || state === 'blocked') {
    // the stall before the dependencies — for its seat only (A2.6, E1)
    if (seat) return stallSentence(flow.stalledCause!)
    const first = open[0]
    const waits = first
      ? `waits on ${ref(first)} (${who(ownerOf(first))})${open.length > 1 ? ` and ${open.length - 1} more` : ''}`
      : unread.length > 0
        ? `waits on ${refOf(unread[0]!)}, which Silos can't read`
        : 'waits on a task its plan no longer has'
    const wakes = v.taskEnv && !human && owner !== '' ? v.taskEnv.wakes(owner) : null
    const then =
      owner === ''
        ? ''
        : ` Then it is ${human ? (owner === 'owner' ? 'your' : `${owner}'s`) : `${name(owner)}'s`} turn${wakes === 'task' ? ' — Silos wakes it then' : ''}.`
    return { kind: 'waiting', sentence: `Waiting — ${waits}.${then}` }
  }

  // the kernel's stall outranks a bare «their turn» — said with its cause
  if (flow.stalled && flow.stalledCause) return stallSentence(flow.stalledCause)

  if (human) {
    const hand = flow.unblocks.length > 0 ? `finishing it unblocks ${unblocksWords(flow.unblocks, name)}` : 'nothing here waits on anyone else'
    // (A2.3) another person's task names them — «Your turn» is the owner's
    const whose = owner === 'owner' ? 'Your' : `${owner.charAt(0).toUpperCase()}${owner.slice(1)}'s`
    return { kind: 'yours', sentence: `${whose} turn — ${hand}.` }
  }

  if (owner === '') return { kind: 'theirs', sentence: 'Nobody owns this task yet.' }

  const listed = conversationIdsOf(role.conversations ? task[role.conversations] : undefined)
  const live = taskLive(v.taskEnv, role.conversations ? task[role.conversations] : undefined, role.releases ? task[role.releases] : undefined)
  if (live) return { kind: 'theirs', sentence: `${name(owner)} is working on it now.` }
  // the owner's turn to open its 'never' agent on it (E6) — the door is the action
  if (flow.waitsStart) {
    return state === 'in_progress'
      ? { kind: 'start', sentence: `Waiting for you to continue ${name(owner)} on it${lastWords(v.taskEnv, listed, v.now)}.` }
      : { kind: 'start', sentence: `Not started — it opens with ${name(owner)} and you.` }
  }
  // «Not started»: Start = without you — its door
  if (flow.idle) return { kind: 'idle', sentence: `Not started — nobody is on it${lastWords(v.taskEnv, listed, v.now)}.` }
  const w = v.taskEnv ? v.taskEnv.wakes(owner) : 'never'
  // its conversations were all let go (A3): nobody works it now
  if (listed.length > 0 && flow.currentConversations.length === 0) {
    return { kind: 'theirs', sentence: `Nobody works it now${lastWords(v.taskEnv, listed, v.now) || ''}; it wakes ${wakeClause(w)}.` }
  }
  // «no conversation yet» only when there is none at all (E5)
  return {
    kind: 'theirs',
    sentence:
      listed.length === 0 ? `${name(owner)}'s turn — no conversation yet; it wakes ${wakeClause(w)}.` : `${name(owner)}'s turn — it wakes ${wakeClause(w)}.`,
  }
}
