// tasks.ts — every plan task as the Tasks view and a task's page read it.
// The moment it serves (docs/product.md): «what's happening?»
// across plans — «where does each thing stand?» — without opening conversations,
// and moment 2's plan tasks on the owner, one click from Needs you.
//
// The truth is the Plans silo's (built in): its records route, read whole
// with ?values=1 — each task with its plan, the record as read and the
// kernel's task flow (waiting, gate, unblocks, stalled + cause + the FIRST
// stuck task). The live state of a linked conversation is the store's
// session census (sessionSignal), the same dot the sidebar blinks. Pure
// functions; the hook (hooks/useTasks.ts) fetches, the components paint.
import { chainTip } from './grouping'
import { ESCALATION_ACTION } from './org'
import { sessionSignal } from './live'
import { relTime } from './rel-time'
import { basename, type TasksQuery } from './routes'
import { isClosedPlanPath, isFinished, planProgress as statesProgress, type PlanStatus } from './team-plan'
import type { ActiveFilter, FacetExtractor } from './facets'
import type { AgentView, ClosedPlanEntry, SessionTaskLine, SessionView, SiloRecordRow, SiloStalledCause, SiloTaskFlow, SiloTaskTurn } from './types'

const STATES: readonly PlanStatus[] = ['pending', 'in_progress', 'in_review', 'blocked', 'done', 'cancelled']

type Json = Record<string, unknown>
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)
const isStr = (v: unknown): v is string => typeof v === 'string'

// `fromOwner`: the server saw the owner write it (POST from the owner's
// session) — the ONLY note said «You»; a note merely signed «owner» is not
// readOutside: written by an unattended run that read outside — the server's stamp
export interface TaskNote {
  at: string
  by: string
  text: string
  fromOwner: boolean
  readOutside?: string[]
}

// who wrote a note, in words: «You» only when the server says so, an agent
// by its name, an unsigned one «An agent», any other signature as signed
export function noteAuthorWords(n: Pick<TaskNote, 'by' | 'fromOwner'>, agents: readonly Pick<AgentView, 'id' | 'name'>[]): string {
  if (n.fromOwner) return 'You'
  const agent = agents.find((a) => a.id === n.by)
  if (agent) return agent.name
  if (n.by === 'agent' || n.by === '') return 'An agent'
  return `Signed «${n.by}»`
}

export interface TaskView {
  key: string // the task's record key: <plan key>/tasks/<id>
  planKey: string
  planId: string // the plan's record id (its file's slug)
  planTitle: string // '' for the project's list — it has no name on screen
  // the task lives in its project's list (plans/tasks.plan.json),
  // not in a named plan: it hangs straight from the project
  standingList: boolean
  planAt: string | null
  id: string
  ref: string // plan#id — the quiet reference (spec «Identifier»): the API's, the URLs', the notes'
  // what a screen paints: `<project>#t3` for a task of the
  // project's list (`<project>/tasks#t3` when the project also has a named
  // plan called like it), `<plan>#t3` for a named plan's. Never sent back.
  label: string
  title: string
  state: PlanStatus
  stateLabel: string
  owner: string
  parent: string | null
  dependsOn: string[]
  conversations: string[] // session ids (conversations[] + the old loose `conversation`, lifted by the silo)
  // when each listed session was let go: the last `released: true` mark of
  // releases[] («unlinked · <date>»), by session id
  releasedAt: Record<string, string>
  // the ones still CURRENT on it — the kernel's reading of releases[]
  // (an unlinked thread is history, never a holder)
  currentConversations: string[]
  notes: TaskNote[]
  due: string | null
  // `asked` (the agent's question verbatim) and `options` (its closed
  // choices) are an optional convention the producer may write beside
  // owner/action — the page quotes the ask and offers the choices as chips
  // `binding`: the Vault entry an ask on the owner wants signed —
  // only its name here; the proposal itself, checked against the Vault,
  // comes from /api/vault/asks (lib/binding-asks.ts)
  waitingOn: { owner: string; action: string; asked?: string; options?: string[]; binding?: { entry: string } } | null
  nextCheckAt: string | null
  folder: string | null // the project folder the plan lives in
  file: string | null
  flow: SiloTaskFlow | null
  // whose turn it is, in the SERVER's one sentence (silos/turn.ts, layer 2 s1)
  // — the page renders it so page, rows and digest cannot drift apart
  turn: SiloTaskTurn | null
  moved: number | null // the last time the journal saw it move
}

// The plan's record id from its key ('folder:/home/u/proj/ship' → 'ship').
export function planIdOf(planKey: string): string {
  return planKey.slice(planKey.lastIndexOf('/') + 1)
}

// The project's list (plans 0.5.0, «a task never needs a plan»):
// the reserved plans/tasks.plan.json every project may have — always
// active, never archived. Its UI name is none: a task in it lives in the
// project, and the crumb is just the project.
export const STANDING_PLAN = 'tasks'
export const standingKeyOf = (folder: string): string => `folder:${folder}/${STANDING_PLAN}`
// a plan FILE ('/p/proj/plans/tasks.plan.json') — or a key the web builds
// itself ('folder:/p/proj/tasks') — names the project's list; a record the
// server read says it itself (`standingList`)
export function isStandingPlan(planKeyOrFile: string): boolean {
  if (planKeyOrFile.startsWith('folder:')) return planIdOf(planKeyOrFile) === STANDING_PLAN
  return planKeyOrFile.endsWith(`/plans/${STANDING_PLAN}.plan.json`)
}
// the project a project's list belongs to, by its key or its file ('' unknown)
export function standingProjectOf(planKeyOrFile: string): string {
  if (planKeyOrFile.startsWith('folder:')) {
    const k = planKeyOrFile.slice('folder:'.length)
    return k.slice(0, Math.max(0, k.lastIndexOf('/')))
  }
  const cut = planKeyOrFile.lastIndexOf('/plans/')
  return cut > 0 ? planKeyOrFile.slice(0, cut) : ''
}
// what the project's list is called where a heading is unavoidable (a plan
// file's viewer, the column's card, the plans list): «Tasks of <project>»
export function standingTitle(planKeyOrFile: string): string {
  const folder = standingProjectOf(planKeyOrFile)
  return folder ? `Tasks of ${basename(folder)}` : 'Tasks of this project'
}
// a record's identity where it is drawn: its own words; empty, the standing
// list's words when it is one (the server says it), else «(untitled)» —
// never a bare id
export function identityWords(r: { identity: string; key: string; standingList?: true }): string {
  if (r.identity) return r.identity
  return r.standingList === true ? standingTitle(r.key) : '(untitled)'
}
// a plan file's heading (PlanView, the column's cards): the project's list is
// «Tasks of <project>» whatever its title says (seeded ''); a named one
// keeps its own
export function planHeading(title: string, file: string | null | undefined): string {
  return file && isStandingPlan(file) ? standingTitle(file) : title
}

// a records row of plans/plan/task (read with ?values=1) → the task the views
// draw; null when the row is not a task of a plan
export function taskOfRow(r: SiloRecordRow): TaskView | null {
  if (!r.parent) return null
  const v = r.value ?? {}
  const state = (isStr(v.state) ? v.state : r.state) as PlanStatus
  if (!STATES.includes(state)) return null
  const notes = (Array.isArray(v.notes) ? v.notes : [])
    .filter(isObj)
    .map((n) => ({
      at: isStr(n.at) ? n.at : '',
      by: isStr(n.by) ? n.by : '',
      text: isStr(n.text) ? n.text : '',
      fromOwner: n.fromOwner === true,
      ...(Array.isArray(n.readOutside) && n.readOutside.length > 0 ? { readOutside: n.readOutside.filter(isStr) } : {}),
    }))
    .filter((n) => n.text !== '')
  const conversations = (Array.isArray(v.conversations) ? v.conversations : [])
    .map((c) => (isObj(c) ? c.session : c))
    .filter((s): s is string => isStr(s) && s !== '')
  const w =
    isObj(v.waitingOn) && isStr(v.waitingOn.owner) && v.waitingOn.owner !== ''
      ? {
          owner: v.waitingOn.owner,
          action: isStr(v.waitingOn.action) ? v.waitingOn.action : '',
          ...(isStr(v.waitingOn.asked) && v.waitingOn.asked !== '' ? { asked: v.waitingOn.asked } : {}),
          ...(Array.isArray(v.waitingOn.options) && v.waitingOn.options.some(isStr) ? { options: v.waitingOn.options.filter(isStr) } : {}),
          ...(isObj(v.waitingOn.binding) && isStr(v.waitingOn.binding.entry) ? { binding: { entry: v.waitingOn.binding.entry } } : {}),
        }
      : null
  const planId = planIdOf(r.parent.key)
  // the server says it (the manifest's ensure-record id)
  const standingList = r.parent.standingList === true
  const currentConversations = (r.flow?.currentConversations ?? []).filter((s): s is string => isStr(s) && s !== '')
  const movedMs = r.moved ? Date.parse(r.moved) : NaN
  const folder = isStr(r.anchors.folder) ? r.anchors.folder : null
  // the server's word for what to paint (views.ts taskLabelOf)
  const served = r.label
  // a task of the project's list archived by month (plans/closed/tasks-
  // YYYY-MM) is still the project's: said `<project>#t3` as it was while
  // open, never `tasks-2026-10#t3`
  const archived = folder !== null && ARCHIVE_FILE.test(r.file ?? '')
  const label = archived ? `${basename(folder)}#${r.id}` : isStr(served) && served !== '' ? served : `${planId}#${r.id}`
  const releasedAt: Record<string, string> = {}
  for (const m of Array.isArray(v.releases) ? v.releases : []) {
    if (!isObj(m) || !isStr(m.session)) continue
    if (m.released === true) releasedAt[m.session] = isStr(m.at) ? m.at : (releasedAt[m.session] ?? '')
    else delete releasedAt[m.session]
  }
  return {
    key: r.key,
    planKey: r.parent.key,
    planId,
    planTitle: standingList ? '' : r.parent.identity || planId,
    standingList,
    planAt: r.parent.at,
    id: r.id,
    ref: `${planId}#${r.id}`,
    label,
    releasedAt,
    title: r.identity || (isStr(v.title) ? v.title : r.id),
    // the state's word is the STATE's, never a note's:
    // cancelled is «dropped» on every screen — the server's label says so
    state,
    stateLabel: r.stateLabel,
    owner: isStr(v.owner) ? v.owner : '',
    parent: isStr(v.parent) && v.parent !== '' ? v.parent : null,
    dependsOn: Array.isArray(v.dependsOn) ? v.dependsOn.filter(isStr) : [],
    conversations,
    currentConversations,
    notes,
    due: isStr(v.due) && v.due !== '' ? v.due : null,
    waitingOn: w,
    nextCheckAt: isStr(v.nextCheckAt) && v.nextCheckAt !== '' ? v.nextCheckAt : null,
    folder,
    file: r.file,
    flow: r.flow ?? null,
    turn: r.turn ?? null,
    moved: Number.isNaN(movedMs) ? null : movedMs,
  }
}

// ── who, and what is live ─────────────────────────────────────────────────

// a task is the owner's when its owner is not a known agent — the registry
// is the only honest way to tell «finance» from «sam» (team-plan.ts humanTasks)
export function isHumanOwner(owner: string, agentIds: ReadonlySet<string>): boolean {
  return owner !== '' && !agentIds.has(owner)
}

// «you» is the OWNER and nobody else: `owner` in a plan is
// the one person the house speaks to; any other person is said by name
export const OWNER_ID = 'owner'
export const isYou = (owner: string): boolean => owner === OWNER_ID

// a wait on an agent is one of two, as the kernel
// read it: Silos carries it there — an ask linked to it, the agent's next
// heartbeat in reach (flow.asked) — or the owner relays it
// (flow.waitsOnRelay). Null: not a wait on an agent, or neither was said.
export type WaitCarry = { kind: 'beat'; to: string; seenBy: number } | { kind: 'relay' }
export function waitCarry(t: Pick<TaskView, 'flow'>): WaitCarry | null {
  const a = t.flow?.asked
  if (a && typeof a.to === 'string' && typeof a.seenBy === 'number') return { kind: 'beat', to: a.to, seenBy: a.seenBy }
  return t.flow?.waitsOnRelay === true ? { kind: 'relay' } : null
}
// a task's owner in words: you · an agent's name · a person's name · nobody
export function ownerWords(owner: string, nameOf: (agentId: string) => string | undefined): string {
  if (owner === '') return 'nobody'
  if (isYou(owner)) return 'you'
  return nameOf(owner) ?? owner
}
// «your» / «Sam's» / «Writer's» — whose turn it is
export function ownerPossessive(owner: string, nameOf: (agentId: string) => string | undefined): string {
  return isYou(owner) ? 'your' : `${ownerWords(owner, nameOf)}'s`
}

export type ConversationState = 'working' | 'waiting' | 'idle' | 'gone'
export interface LinkedConversation {
  id: string
  state: ConversationState
  session: SessionView | null
  agentId: string | null
}

// The conversations a task names, each found in the census the web holds
// (every agent's session list) with its live state: working (a turn open and
// moving — the sidebar's blink), waiting for you (it asked, or replied and you
// haven't looked), idle, or gone (the index no longer has it — said, never a
// dead link). The owner's session in the plan's project first, like the
// column's PlanView (team-plan.ts taskConversationTarget).
export function linkedConversations(t: Pick<TaskView, 'conversations' | 'owner' | 'folder'>, agents: readonly AgentView[], now: number): LinkedConversation[] {
  const munged = t.folder ? t.folder.replace(/[^A-Za-z0-9]/g, '-') : null
  const owner = agents.find((a) => a.id === t.owner)
  const all = agents.flatMap((a) => a.sessions.map((s) => ({ s, agentId: a.id })))
  return t.conversations.map((id) => {
    const hit = (owner && munged ? owner.sessions.find((s) => s.id === id && s.folder === munged) : undefined) ?? owner?.sessions.find((s) => s.id === id)
    const found = hit ? { s: hit, agentId: owner!.id } : all.find((x) => x.s.id === id)
    if (!found) return { id, state: 'gone' as const, session: null, agentId: null }
    // …walked to its thread's TIP (chainTip over parentKey, /clears excluded —
    // the same closure as the server's threadRootKey):
    // after a rotation the task still lists the ancestor, but the blink and
    // the door live in the newest session of the thread. Only the same
    // agent's sessions are walked — the server's ownership guard.
    const mine = agents.find((a) => a.id === found.agentId)?.sessions ?? []
    const tipRef = chainTip(mine, found.s.folder, found.s.id, { continuation: true })
    const tip = mine.find((s) => s.folder === tipRef.folder && s.id === tipRef.id) ?? found.s
    const sig = sessionSignal(tip, now, false)
    return { id, state: sig === 'working' ? 'working' : sig === 'attention' ? 'waiting' : 'idle', session: tip, agentId: found.agentId }
  })
}

// THE conversation a one-line door names (the plan view's «Conversation ›»,
// not the task's FIRST listed one, its oldest):
// among the CURRENT ones (the kernel's currentConversations), the one
// working now, else the one last active; when every one was let go, the last
// active of its history; a task whose every conversation is gone says gone.
// Null when it lists none.
export function currentConversationOf(
  t: Pick<TaskView, 'conversations' | 'currentConversations' | 'owner' | 'folder'>,
  agents: readonly AgentView[],
  now: number,
): LinkedConversation | null {
  if (t.conversations.length === 0) return null
  const pick = (ids: string[]): LinkedConversation | null => {
    const found = linkedConversations({ ...t, conversations: ids }, agents, now).filter((c) => c.session)
    return found.find((c) => c.state === 'working') ?? [...found].sort((a, b) => b.session!.mtime - a.session!.mtime)[0] ?? null
  }
  return (
    pick(t.currentConversations) ?? pick(t.conversations) ?? { id: t.conversations[t.conversations.length - 1]!, state: 'gone', session: null, agentId: null }
  )
}

// live = a CURRENT conversation is working it (an unlinked one working on
// something else is not this task's life — the kernel's taskLive)
export function isLiveTask(
  t: Pick<TaskView, 'conversations' | 'owner' | 'folder'> & { currentConversations?: string[] },
  agents: readonly AgentView[],
  now: number,
): boolean {
  return linkedConversations({ ...t, conversations: t.currentConversations ?? t.conversations }, agents, now).some((c) => c.state === 'working')
}

// The kernel computes a task's flow when the plans are read; the live facts
// it reads then (a conversation's activity) can be older than the census the
// web holds over its socket. A task the census sees WORKING is not «in
// progress, but nothing is working on it», and a chain parked on it is not
// parked: those two causes clear here — every other cause stands (a live
// conversation does not un-cancel a blocker).
export function withLiveFlow(tasks: readonly TaskView[], agents: readonly AgentView[], now: number): TaskView[] {
  const live = new Set(tasks.filter((t) => t.flow?.stalled && isLiveTask(t, agents, now)).map((t) => t.key))
  if (live.size === 0) return tasks as TaskView[]
  const keyOf = (t: TaskView, id: string): string => `${t.planKey}/tasks/${id}`
  return tasks.map((t) => {
    const f = t.flow
    if (!f?.stalled || !f.stalledBy) return t
    const by = keyOf(t, f.stalledBy)
    const clears = (f.stalledCause === 'in-progress-nothing-live' && live.has(t.key)) || (f.stalledCause === 'blocker-parked' && live.has(by))
    return clears ? { ...t, flow: { ...f, stalled: false, stalledCause: null, stalledBy: null, stalledAt: null } } : t
  })
}

// ── presets ───────────────────────────────────────────────────────────────

// `idle` is an address, not a tab: Home's «N tasks ready,
// nobody on them ›» opens it
// `start`: its agent waits for you to start it (the server's waitsStart door)
// One word per set: «Open» is every task not finished — the tab, the
// sidebar's «N open», a plan's «N open» and Org's counts all say it; «Untouched»
// is the kernel's stalled flow — its address says it too.
export type TaskPreset = 'mine' | 'open' | 'untouched' | 'done' | 'idle' | 'start'
// «Yours to do» (not «Mine», not «Yours»): ONE label with Home's — and its
// criterion is exactly your open tasks (it once counted agent
// tasks an owner conversation had touched, so the number matched nothing else)
export const TASK_PRESETS: ReadonlyArray<{ id: TaskPreset; label: string }> = [
  { id: 'mine', label: 'Yours to do' },
  { id: 'open', label: 'Open' },
  { id: 'untouched', label: 'Untouched' },
  { id: 'done', label: 'Done' },
]
const OPEN: ReadonlySet<PlanStatus> = new Set(['pending', 'in_progress', 'in_review', 'blocked'])

export interface PresetContext {
  agentIds: ReadonlySet<string>
  // the owner's own conversations (not an automation run, a nested run or a
  // message conversation) — a task one of them works is «mine» too
  ownerSessions: ReadonlySet<string>
}

// the owner's conversations in the census: born of the owner, never of a run
export function ownerSessionIds(agents: readonly AgentView[]): Set<string> {
  return new Set(agents.flatMap((a) => a.sessions.filter((s) => !s.origin).map((s) => s.id)))
}

export function inPreset(t: TaskView, preset: TaskPreset, _ctx: PresetContext): boolean {
  switch (preset) {
    case 'mine':
      // yours: `owner` only — another person's task is theirs
      return !isFinished(t.state) && isYou(t.owner)
    case 'open':
      return OPEN.has(t.state)
    case 'untouched':
      // the task that is its own stall's SEAT — what
      // Home's «N tasks sit untouched» counts; one waiting on another's
      // stall is that seat's
      return !isFinished(t.state) && t.flow?.stalled === true && isOwnSeat(t)
    case 'done':
      return isFinished(t.state)
    case 'idle':
      // the kernel's flow name: ready, nobody on it, no wake coming
      return !isFinished(t.state) && t.flow?.idle === true
    case 'start':
      // its owner only moves when you start it
      return !isFinished(t.state) && t.flow?.waitsStart === true
  }
}

export function presetCounts(tasks: readonly TaskView[], ctx: PresetContext): Record<TaskPreset, number> {
  const out: Record<TaskPreset, number> = { mine: 0, open: 0, untouched: 0, done: 0, idle: 0, start: 0 }
  for (const t of tasks) for (const p of [...TASK_PRESETS.map((x) => x.id), 'idle' as const, 'start' as const]) if (inPreset(t, p, ctx)) out[p] += 1
  // the Done tab's number is the done ones — the dropped ones it also lists
  // are said apart in its header («3 done, 1 dropped», doneWords), so the tab
  // and the header never give two numbers
  out.done = tasks.filter((t) => t.state === 'done').length
  return out
}

// ── order: by last activity ───────────────────────────────────────────────

// The last thing that happened to a task: the journal saw it move, a note
// was added, a conversation working it moved — else its plan's moment.
export function activityOf(t: TaskView, agents: readonly AgentView[], now: number): number {
  const times = [t.moved ?? 0, ...t.notes.map((n) => Date.parse(n.at) || 0), ...linkedConversations(t, agents, now).map((c) => c.session?.mtime ?? 0)]
  const best = Math.max(0, ...times)
  return best > 0 ? best : t.planAt ? Date.parse(t.planAt) || 0 : 0
}

export function byActivity(tasks: readonly TaskView[], agents: readonly AgentView[], now: number): TaskView[] {
  const at = new Map(tasks.map((t) => [t.key, activityOf(t, agents, now)]))
  return [...tasks].sort((a, b) => at.get(b.key)! - at.get(a.key)! || a.ref.localeCompare(b.ref))
}

// ── what a row says ───────────────────────────────────────────────────────

// the task is the seat of its own stall (the server's stalledAt)
export function isOwnSeat(t: Pick<TaskView, 'id' | 'flow'>): boolean {
  return t.flow?.stalled === true && t.flow.stalledAt === t.id
}

// the nine causes in the house's words, said so they
// are TRUE beside every status they come with (a pending row must never
// read «pending · blocked by untouched work»). A cause that lives down
// the chain is said with «waits on», which is true of a pending, an
// in-progress and a blocked task alike; a cause that is the task's own (the
// kernel's stalledBy is itself) says what is wrong with IT.
const CAUSE_ON_CHAIN: Record<SiloStalledCause, string> = {
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
const CAUSE_OF_ITS_OWN: Record<SiloStalledCause, string> = {
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
export function causeWords(t: Pick<TaskView, 'id' | 'owner' | 'state' | 'flow'>): string | null {
  const cause = t.flow?.stalled ? t.flow.stalledCause : null
  if (!cause) return null
  const own = !t.flow!.stalledBy || t.flow!.stalledBy === t.id
  if (!own) return CAUSE_ON_CHAIN[cause]
  return CAUSE_OF_ITS_OWN[cause]
}

// the label over a task's dependencies: «Blocked by» only for a task whose
// state IS blocked; any other open or closed task comes «After» them (a
// pending task with an open dependency is not blocked). Never «Waits on»:
// «Waiting on» is the declared wait (`waitingOn`), a different fact. One
// label, one rule — every place that prints dependencies asks here.
export function dependsLabel(t: { state: string }): 'Blocked by' | 'After' {
  return t.state === 'blocked' ? 'Blocked by' : 'After'
}

// the tasks of one plan by id
export function siblingsOf(tasks: readonly TaskView[], planKey: string): Map<string, TaskView> {
  return new Map(tasks.filter((t) => t.planKey === planKey).map((t) => [t.id, t]))
}

// «Blocked by X»: the FIRST stuck task down the chain (the kernel's
// stalledBy) when it is another task; null when the task is stuck on itself
// (its cause says why) or not stuck. `title` null: the id names no task.
export function blockedBy(t: TaskView, plan: ReadonlyMap<string, TaskView>): { id: string; ref: string; title: string | null; key: string | null } | null {
  const by = t.flow?.stalled ? t.flow.stalledBy : null
  if (!by || by === t.id) return null
  const b = plan.get(by)
  return { id: by, ref: b?.label ?? labelOf(t, by), title: b?.title ?? null, key: b?.key ?? null }
}

// a sibling's label by its id when the reading does not hold it: the same
// prefix this task is painted with (`<project>#t4` on the project's list,
// `<plan>#t4` on a named plan — never the raw `tasks#t4`)
export function labelOf(t: Pick<TaskView, 'label'>, id: string): string {
  const cut = t.label.lastIndexOf('#')
  return `${cut >= 0 ? t.label.slice(0, cut) : t.label}#${id}`
}

// a task's label by its key, from the reading — else its sibling's prefix
// (labelOf), never a file's basename like `tasks#t3`.
// `near`: the key of a task in the same plan, when the reading lacks it too.
export function labelOfKey(all: readonly Pick<TaskView, 'key' | 'label'>[], key: string, near: string = key): string {
  const hit = all.find((x) => x.key === key)
  if (hit) return hit.label
  const id = key.slice(key.lastIndexOf('/tasks/') + 7)
  const sib = all.find((x) => x.key === near) ?? all.find((x) => x.key.startsWith(`${key.slice(0, key.lastIndexOf('/tasks/'))}/tasks/`))
  if (sib) return labelOf(sib, id)
  const plan = key.slice(0, key.lastIndexOf('/tasks/'))
  const pid = planIdOf(plan)
  // the project's list is said by its project
  return pid === STANDING_PLAN ? `${basename(plan.slice(plan.indexOf(':') + 1, plan.lastIndexOf('/')))}#${id}` : `${pid}#${id}`
}

// The dependencies of `t` that were dropped (cancelled): they never resolve
// — done alone does (the kernel's rule) — so the task is stuck on them until
// the owner removes the dependency or reopens the dropped task. Direct ones
// only: those are what THIS task's page can remove.
export function droppedDependencies(t: Pick<TaskView, 'dependsOn' | 'state'>, plan: ReadonlyMap<string, TaskView>): TaskView[] {
  if (isFinished(t.state)) return []
  return t.dependsOn.map((d) => plan.get(d)).filter((b): b is TaskView => b !== undefined && b.state === 'cancelled')
}

// What a Drop leaves hanging: the OPEN tasks that depend
// on this one. A dropped blocker never resolves, so each stalls until
// someone removes the dependency: «2 tasks of Builder wait on this — they'll
// stall». null when nothing open waits on it.
export function dropHangs(t: TaskView, all: readonly TaskView[], nameOf: (agentId: string) => string | undefined): { tasks: TaskView[]; words: string } | null {
  const waiting = blocksOf(t, all).filter((x) => !isFinished(x.state))
  if (waiting.length === 0) return null
  const whose = [...new Set(waiting.map((x) => (isYou(x.owner) ? 'yours' : ownerWords(x.owner, nameOf))))]
  const n = waiting.length === 1 ? '1 task' : `${waiting.length} tasks`
  return {
    tasks: waiting,
    words: `${n} of ${whose.join(' and ')} ${waiting.length === 1 ? 'waits' : 'wait'} on this — ${waiting.length === 1 ? 'it stalls' : 'they stall'} until someone removes the dependency`,
  }
}

// Everything a Drop leaves as it is, said BEFORE it: the
// open tasks that wait on it (dropHangs), its open subtasks (a Drop moves
// this task alone), and a conversation working it right now — nobody tells
// that conversation, so it keeps going until someone opens it.
export interface DropWarnings {
  lines: string[]
  live: LinkedConversation | null
  liveWords: string | null
}
export function dropWarnings(t: TaskView, all: readonly TaskView[], agents: readonly AgentView[], now: number): DropWarnings {
  const nameOf = (id: string): string | undefined => agents.find((a) => a.id === id)?.name
  const lines: string[] = []
  const hangs = dropHangs(t, all, nameOf)
  if (hangs) lines.push(hangs.words)
  const open = childrenOf(t, all).filter((c) => !isFinished(c.state))
  if (open.length > 0) lines.push(`${open.length === 1 ? '1 subtask stays' : `${open.length} subtasks stay`} open — a Drop moves this task alone`)
  const live = linkedConversations({ ...t, conversations: t.currentConversations }, agents, now).find((c) => c.state === 'working') ?? null
  const who = live ? (live.agentId ? (nameOf(live.agentId) ?? live.agentId) : 'A conversation') : null
  return { lines, live, liveWords: who ? `${who} is working on it now — it isn't told` : null }
}

// The stall in one line: «blocked by a cancelled task: ship#t4 Video», or the
// cause alone when the task itself is the stuck one.
export function stallLine(t: TaskView, plan: ReadonlyMap<string, TaskView>): string | null {
  const words = causeWords(t)
  if (!words) return null
  const b = blockedBy(t, plan)
  if (!b) return words
  // the task it waits on is not untouched: its agent opens with you (it
  // lives in Start, not in Untouched), so the line says that
  const said = plan.get(b.id)?.flow?.waitsStart === true ? 'waits on a task not started' : words
  return `${said}: ${b.ref}${b.title ? ` ${b.title}` : ''}`
}

// ── blocked: covered, or in need of you ───────────────────────────────────

// A blocked task says WHICH blocked it is, one grammar on every surface
// («blocked covered» vs «blocked that needs attention»): `covered` — its
// chain ends in an agent that is working, or will
// wake (the kernel found it guarded) —, `on-you` — it ends in a person —,
// `stuck` — the kernel's stalled, or a stalled task in its chain. The kernel's
// flow decides stuck; this only walks the chain to name where it ends, and a
// walk with a cycle stops, never hangs.
export type BlockedTone = 'covered' | 'on-you' | 'stuck'
// `fromWait`: the words are the task's own declared wait (`waitingOn`), so a
// row that says the reading has said the wait too
export interface BlockedReading {
  tone: BlockedTone
  why: string
  fromWait?: true
}
export interface ChainFacts {
  agentIds: ReadonlySet<string>
  isLive: (t: TaskView) => boolean
  nameOf: (agentId: string) => string
}

export function chainFacts(agents: readonly AgentView[], now: number): ChainFacts {
  return {
    agentIds: new Set(agents.map((a) => a.id)),
    isLive: (t) => isLiveTask(t, agents, now),
    nameOf: (id) => agents.find((a) => a.id === id)?.name ?? id,
  }
}

// «and 2 more» when a chain ends in several places
const andMore = (n: number): string => (n > 0 ? ` and ${n} more` : '')

export function readBlocked(t: TaskView, plan: ReadonlyMap<string, TaskView>, facts: ChainFacts): BlockedReading | null {
  if (t.state !== 'blocked') return null
  const own = stallLine(t, plan)
  if (own) return { tone: 'stuck', why: own }
  // every open task the chain passes through, and where it ends
  const seen = new Set<string>([t.id])
  const ends: TaskView[] = []
  const walk = (x: TaskView): { stuck: BlockedReading } | null => {
    for (const d of x.dependsOn) {
      if (seen.has(d)) continue
      seen.add(d)
      const b = plan.get(d)
      if (!b) return { stuck: { tone: 'stuck', why: `waits on ${labelOf(x, d)}, which no task has` } }
      if (b.state === 'done') continue
      if (b.state === 'cancelled') return { stuck: { tone: 'stuck', why: `waits on ${b.label}, which was dropped` } }
      const line = stallLine(b, plan)
      if (line) return { stuck: { tone: 'stuck', why: `waits on ${b.label}: ${line}` } }
      const before = ends.length
      const below = walk(b)
      if (below) return below
      if (ends.length === before) ends.push(b)
    }
    return null
  }
  const stuck = walk(t)
  if (stuck) return stuck.stuck
  // a person at the end needs that person, whatever else is moving
  const onPerson = ends.filter((e) => isHumanOwner(e.owner, facts.agentIds))
  if (onPerson.length > 0)
    return { tone: 'on-you', why: `waits on ${onPerson[0]!.label} (${isYou(onPerson[0]!.owner) ? 'you' : onPerson[0]!.owner})${andMore(onPerson.length - 1)}` }
  const w = t.waitingOn
  if (w && isHumanOwner(w.owner, facts.agentIds)) return { tone: 'on-you', why: waitWords(w, facts), fromWait: true }
  if (ends.length > 0) {
    const live = ends.filter((e) => facts.isLive(e))
    const e = live[0] ?? ends[0]!
    return {
      tone: 'covered',
      why: `waits on ${e.label}, ${live.length > 0 ? 'working now' : e.owner ? `with ${facts.nameOf(e.owner)}` : 'with nobody yet'}${andMore(ends.length - 1)}`,
    }
  }
  if (w) return { tone: 'covered', why: waitWords(w, facts), fromWait: true }
  // nothing to wait on: it is its owner's to unblock
  if (isHumanOwner(t.owner, facts.agentIds)) return { tone: 'on-you', why: isYou(t.owner) ? 'yours to unblock' : `${t.owner}'s to unblock` }
  return { tone: 'covered', why: t.nextCheckAt ? 'its owner looks at it again' : 'its conversation is on it' }
}

// «waits on you: …» / «waits on Builder: …» — a declared wait in words, the
// same words wherever it is said: «you», an agent by its name, any other
// person by the name the plan gives them
const waiterWords = (owner: string, facts: Pick<ChainFacts, 'agentIds' | 'nameOf'>): string =>
  isYou(owner) ? 'you' : facts.agentIds.has(owner) ? facts.nameOf(owner) : owner
export function waitWords(w: NonNullable<TaskView['waitingOn']>, facts: Pick<ChainFacts, 'agentIds' | 'nameOf'>): string {
  return `waits on ${waiterWords(w.owner, facts)}${w.action ? `: ${w.action}` : ''}`
}

// What a row says of why it waits, each fact once. `accent`: it needs a
// person (the reading's on-you/stuck, an escalation). One rule for every
// variant — a wait on you, on a teammate, on an agent, a chain of
// dependsOn: a declared wait the blocked reading already said is not said
// again, and a stall says the whole story on its own (the row's StallText).
export interface WaitFact {
  accent: boolean
  words: string
}
export function waitFacts(t: TaskView, plan: ReadonlyMap<string, TaskView>, facts: ChainFacts): WaitFact[] {
  if (!isFinished(t.state) && stallLine(t, plan)) return []
  const w = t.waitingOn
  // the escalation's own wait (escalation/): who is asked now, said as such
  if (w && ESCALATION_ACTION.test(w.action)) return [{ accent: true, words: `escalated · asks ${waiterWords(w.owner, facts)}` }]
  const blocked = readBlocked(t, plan, facts)
  const said = blocked && blocked.tone !== 'covered' ? blocked : null
  const out: WaitFact[] = said ? [{ accent: true, words: said.why }] : []
  if (w && !said?.fromWait) out.push({ accent: false, words: waitWords(w, facts) })
  return out
}

// «blocked · waits on …» for the glyph's tooltip; a kernel line already says
// «blocked by …» on its own
export function blockedLabel(r: BlockedReading): string {
  return r.why.startsWith('blocked') ? r.why : `blocked · ${r.why}`
}

// «in review — nobody is reviewing it»: an in_review task with no human
// owner, no waitingOn and no nextCheckAt (the kernel's cause)
export function reviewWithoutReviewer(t: TaskView): boolean {
  return t.state === 'in_review' && t.flow?.stalledCause === 'review-without-reviewer'
}

// direct subtasks (parent = this id, same plan), in the plan's order
export function childrenOf(t: Pick<TaskView, 'id' | 'planKey'>, tasks: readonly TaskView[]): TaskView[] {
  return tasks.filter((c) => c.planKey === t.planKey && c.parent === t.id)
}

// «N running below»: subtasks in progress or with a conversation working now
export function runningBelow(t: TaskView, tasks: readonly TaskView[], agents: readonly AgentView[], now: number): number {
  return childrenOf(t, tasks).filter((c) => c.state === 'in_progress' || isLiveTask(c, agents, now)).length
}

// the tasks that wait on this one (dependsOn names it), in the plan's order
export function blocksOf(t: TaskView, tasks: readonly TaskView[]): TaskView[] {
  return tasks.filter((x) => x.planKey === t.planKey && x.dependsOn.includes(t.id))
}

// «due Nov 6» / «overdue since Nov 1»; null without a date. A date that does
// not parse is said as written — never dropped.
export function dueWords(due: string | null, now: number): string | null {
  if (!due) return null
  const ms = Date.parse(due.length === 10 ? `${due}T00:00:00` : due)
  if (Number.isNaN(ms)) return `due ${due}`
  const d = new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  const today = new Date(now)
  today.setHours(0, 0, 0, 0)
  return ms < today.getTime() ? `overdue since ${d}` : `due ${d}`
}

// ── layouts ───────────────────────────────────────────────────────────────

export type TaskLayout = 'list' | 'board' | 'tree'
export const TASK_LAYOUTS: readonly TaskLayout[] = ['list', 'board', 'tree']

// board: one column per state in the flow's order; done and cancelled
// start collapsed; BOARD_PAGE cards a column before «show more»
export const BOARD_PAGE = 10
// `tasks` in the order the column reads; `covered` is the part of it that folds
export interface BoardColumn {
  state: PlanStatus
  label: string
  tasks: TaskView[]
  covered: TaskView[]
  collapsed: boolean
}
// cancelled is «Dropped» on screen — ONE word with the owner's Drop and the
// «Dropped:» note
const STATE_LABEL: Record<PlanStatus, string> = {
  pending: 'Pending',
  in_progress: 'In progress',
  in_review: 'In review',
  blocked: 'Blocked',
  done: 'Done',
  cancelled: 'Dropped',
}
export function stateLabel(s: PlanStatus): string {
  return STATE_LABEL[s]
}
// The Blocked column reads what needs you first and folds what is covered
// (`read`: lib readBlocked over the task's plan) — it folds, it never hides.
export function boardColumns(tasks: readonly TaskView[], read: (t: TaskView) => BlockedReading | null = () => null): BoardColumn[] {
  return STATES.map((state) => {
    const here = tasks.filter((t) => t.state === state)
    const covered = state === 'blocked' ? here.filter((t) => read(t)?.tone === 'covered') : []
    const folded = new Set(covered)
    return { state, label: STATE_LABEL[state], tasks: [...here.filter((t) => !folded.has(t)), ...covered], covered, collapsed: isFinished(state) }
  }).filter((c) => c.tasks.length > 0 || !c.collapsed)
}

// tree: project → plan → task, subtasks nested under their parent (a
// parent outside the filtered set leaves its child a root — never hidden).
// The project's list is no plan: its tasks are the project's
// `loose` nodes, hung straight from it with no group head —
// drawn before the named plans.
export interface TreeNode {
  task: TaskView
  children: TreeNode[]
}
export interface TreePlan {
  planKey: string
  title: string
  ref: string
  nodes: TreeNode[]
  count: number
}
export interface TreeProject {
  folder: string | null
  name: string
  loose: TreeNode[]
  plans: TreePlan[]
}
function treeOf(mine: readonly TaskView[]): TreeNode[] {
  const ids = new Set(mine.map((t) => `${t.planKey}#${t.id}`))
  const build = (t: TaskView, seen: Set<string>): TreeNode => ({
    task: t,
    children: mine.filter((c) => c.planKey === t.planKey && c.parent === t.id && !seen.has(c.id)).map((c) => build(c, new Set(seen).add(c.id))),
  })
  return mine.filter((t) => !t.parent || !ids.has(`${t.planKey}#${t.parent}`) || t.parent === t.id).map((t) => build(t, new Set([t.id])))
}
export function taskTree(tasks: readonly TaskView[]): TreeProject[] {
  const projects = new Map<string, TreeProject>()
  const loose = new Map<string, TaskView[]>()
  for (const t of tasks) {
    const pk = t.folder ?? ''
    let p = projects.get(pk)
    if (!p) projects.set(pk, (p = { folder: t.folder, name: t.folder ? basename(t.folder) : 'Outside Silos’ projects', loose: [], plans: [] }))
    if (t.standingList) {
      loose.set(pk, [...(loose.get(pk) ?? []), t])
      continue
    }
    let plan = p.plans.find((x) => x.planKey === t.planKey)
    if (!plan) p.plans.push((plan = { planKey: t.planKey, title: t.planTitle, ref: t.planId, nodes: [], count: 0 }))
    plan.count += 1
  }
  for (const [pk, p] of projects) {
    p.loose = treeOf(loose.get(pk) ?? [])
    for (const plan of p.plans) plan.nodes = treeOf(tasks.filter((t) => t.planKey === plan.planKey))
  }
  return [...projects.values()]
}

// Tasks › Done's count: what was done, and what was dropped, apart — a
// dropped task is finished, never done
export function doneWords(tasks: readonly Pick<TaskView, 'state'>[]): string {
  const dropped = tasks.filter((t) => t.state === 'cancelled').length
  return doneCountWords(tasks.length - dropped, dropped)
}
// the same words from counts (a closed plan's line in Done's Plans strip)
export function doneCountWords(done: number, dropped: number): string {
  return dropped === 0 ? `${done} done` : done === 0 ? `${dropped} dropped` : `${done} done, ${dropped} dropped`
}

// Done, folded by age: this week in view, the rest behind its own fold
export interface AgeFold {
  label: string
  tasks: TaskView[]
}
// `ordered`: the tasks already stand in the order to draw (a held list)
export function foldByAge(tasks: readonly TaskView[], agents: readonly AgentView[], now: number, ordered = false): AgeFold[] {
  const week = now - 7 * 86_400_000
  const month = now - 30 * 86_400_000
  const at = (t: TaskView): number => activityOf(t, agents, now)
  const sorted = ordered ? tasks : byActivity(tasks, agents, now)
  return [
    { label: 'This week', tasks: sorted.filter((t) => at(t) >= week) },
    { label: 'This month', tasks: sorted.filter((t) => at(t) < week && at(t) >= month) },
    { label: 'Older', tasks: sorted.filter((t) => at(t) < month) },
  ].filter((f) => f.tasks.length > 0)
}

// The project's list's monthly archive: what was done before
// this month lives in plans/closed/tasks-<YYYY-MM>.plan.json, under the
// title «<project> — closed <YYYY-MM>». Tasks › Done folds it by month —
// «Archived · Oct ›» — never mixed into the age folds. `month`: 'YYYY-MM'.
const ARCHIVE_FILE = /\/plans\/closed\/tasks-(\d{4})-(\d{2})\.plan\.json$/
export function archiveMonthOf(t: Pick<TaskView, 'file'>): string | null {
  const m = t.file ? ARCHIVE_FILE.exec(t.file) : null
  return m ? `${m[1]}-${m[2]}` : null
}
export interface ArchiveFold {
  month: string
  label: string
  tasks: TaskView[]
}
// the archived tasks by month, newest month first; «Archived · Oct», with
// the year when it is not the current one («Archived · Dec 2025»)
export function archiveFolds(tasks: readonly TaskView[], now: number): ArchiveFold[] {
  const by = new Map<string, TaskView[]>()
  for (const t of tasks) {
    const m = archiveMonthOf(t)
    if (m) by.set(m, [...(by.get(m) ?? []), t])
  }
  const year = new Date(now).getUTCFullYear()
  return [...by.entries()]
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([month, list]) => {
      const [y, mo] = month.split('-').map(Number) as [number, number]
      const name = new Date(Date.UTC(y, mo - 1, 1)).toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' })
      return { month, label: `Archived · ${name}${y === year ? '' : ` ${y}`}`, tasks: list }
    })
}

// ── facets (lib/facets.ts engine): project, agent and plan ────────────────

// the agent facet's value for tasks on a person — never an agent's id
export const YOU_FACET = '__you__'
// the plan facet's value for a task in a project's list: «No plan», one value
// across projects (the Project facet tells them apart)
export const NO_PLAN_FACET = '__no-plan__'

export function taskFacets(agents: readonly AgentView[]): FacetExtractor<TaskView>[] {
  const ids = new Set(agents.map((a) => a.id))
  const nameOf = (id: string): string => agents.find((a) => a.id === id)?.name ?? id
  return [
    {
      id: 'project',
      label: 'Project',
      valuesOf: (t) => [t.folder ? { value: t.folder, label: basename(t.folder) } : { value: '', label: 'outside projects' }],
    },
    // «you» is the owner alone; another person is a value of their own, by name
    {
      id: 'agent',
      label: 'Agent',
      valuesOf: (t) => [
        isYou(t.owner)
          ? { value: YOU_FACET, label: 'you' }
          : isHumanOwner(t.owner, ids)
            ? { value: t.owner, label: t.owner }
            : t.owner === ''
              ? { value: '', label: 'nobody' }
              : { value: t.owner, label: nameOf(t.owner) },
      ],
    },
    { id: 'plan', label: 'Plan', valuesOf: (t) => [t.standingList ? { value: NO_PLAN_FACET, label: 'No plan' } : { value: t.planKey, label: t.planTitle }] },
  ]
}

// a Tasks view's facets ⇄ its address (lib/routes.ts TasksQuery)
const FACET_IDS = ['project', 'agent', 'plan'] as const
export function filterOfQuery(q: TasksQuery): ActiveFilter {
  const out: Record<string, ReadonlySet<string>> = {}
  for (const id of FACET_IDS) if (q[id]?.length) out[id] = new Set(q[id])
  return out
}
export function queryOfFilter(f: ActiveFilter): Pick<TasksQuery, 'project' | 'agent' | 'plan'> {
  const out: Pick<TasksQuery, 'project' | 'agent' | 'plan'> = { project: undefined, agent: undefined, plan: undefined }
  for (const id of FACET_IDS) if (f[id]?.size) out[id] = [...f[id]!]
  return out
}

// ── the other way: conversations ↔ tasks ──────────────────────────────────

// the tasks a conversation works (conversations[] or the old loose field,
// lifted by the silo), open ones first
export function tasksOfSession(tasks: readonly TaskView[], sessionId: string): TaskView[] {
  return tasks.filter((t) => t.conversations.includes(sessionId)).sort((a, b) => Number(isFinished(a.state)) - Number(isFinished(b.state)))
}

// the tasks a conversation is CURRENTLY on (listed and not let go):
// the ones ⌘K leaves out of «Link…» and offers to «Unlink…»
export function currentTasksOfSession(tasks: readonly TaskView[], sessionId: string): TaskView[] {
  return tasks.filter((t) => t.currentConversations.includes(sessionId))
}

// ── the link on both sides ─────────────────────
// A conversation says the task it works — «☑ Working on «title» ›» — and a
// sidebar row carries the same ☑. One reading of «which task», here.

// a task a conversation works, as the header reads it: the reading's own
// task when it holds it, else what the server resolved (a closed plan's
// task: read-only, never in the lists — plans-closed.ts)
export interface WorkedTask {
  key: string
  ref: string
  title: string
  state: PlanStatus
  closed: boolean
  // the conversation is still on it: false once it was unlinked —
  // the header then says «Worked on ✓», never «Working on»
  current: boolean
  view: TaskView | null
  // the plan file holding it (the column's Plan block paints that plan)
  file: string | null
}

const WORK_RANK: Record<PlanStatus, number> = { in_progress: 0, in_review: 1, blocked: 2, pending: 3, done: 4, cancelled: 4 }

// still being worked HERE: open, its plan not closed, and the conversation
// still current on it (an unlinked thread worked on it — history)
export function isOpenWork(t: Pick<WorkedTask, 'state' | 'closed'> & { current?: boolean }): boolean {
  return !t.closed && !isFinished(t.state) && t.current !== false
}

// The header's chip: the task it leads with — an OPEN one first (in progress
// before in review, blocked, pending), else the finished ones — whether it
// is still being worked («Working on») or was («Worked on ✓»), and the rest
// the «+N» peek lists. Null when no task names the conversation.
export function conversationWork(tasks: readonly WorkedTask[]): { lead: WorkedTask; working: boolean; rest: WorkedTask[] } | null {
  if (tasks.length === 0) return null
  const rank = (t: WorkedTask): number => (isOpenWork(t) ? WORK_RANK[t.state] : 10)
  const sorted = tasks
    .map((t, i) => ({ t, i }))
    .sort((a, b) => rank(a.t) - rank(b.t) || a.i - b.i)
    .map((x) => x.t)
  const lead = sorted[0]!
  return { lead, working: isOpenWork(lead), rest: sorted.slice(1) }
}

// The header's words for its lead task:
//   open and current ........ «☑ Working on «x» ›»
//   current, blocked/review .. «Linked to «x»» (the owner's link keeps its state)
//   let go, still open ....... «Worked on «x» · pending» — no ✓: it is not done
//   done (or its plan closed)  «Worked on «x» ✓»
export type WorkWord = 'working' | 'linked' | 'worked' | 'done'
export function workWord(t: Pick<WorkedTask, 'state' | 'closed' | 'current'>): { word: WorkWord; lead: string; state: string | null } {
  // dropped is finished but not done: no ✓, its word instead
  if (t.state === 'cancelled') return { word: 'worked', lead: 'Worked on', state: 'dropped' }
  if (t.closed || isFinished(t.state)) return { word: 'done', lead: 'Worked on', state: null }
  if (!t.current) return { word: 'worked', lead: 'Worked on', state: t.state.replace('_', ' ') }
  if (t.state === 'blocked' || t.state === 'in_review') return { word: 'linked', lead: 'Linked to', state: null }
  return { word: 'working', lead: 'Working on', state: null }
}

const asState = (s: string): PlanStatus => (STATES.includes(s as PlanStatus) ? (s as PlanStatus) : 'pending')

// The tasks a conversation works, as the header has them: the server's
// inverse (closed over rotations and closed plans, each marked `current`)
// when it answered, each matched to the reading's task; the reading's
// direct match while its answer is on its way.
export function workedTasks(server: ReadonlyArray<SessionTaskLine> | null, reading: readonly TaskView[], sessionId: string): WorkedTask[] {
  const of = (v: TaskView, current: boolean): WorkedTask => ({
    key: v.key,
    ref: v.ref,
    title: v.title,
    state: v.state,
    closed: false,
    current,
    view: v,
    file: v.file,
  })
  if (server === null) return tasksOfSession(reading, sessionId).map((v) => of(v, v.currentConversations.includes(sessionId)))
  return server.flatMap((s) => {
    const v = reading.find((x) => x.key === s.key)
    if (v) return [of(v, s.current === true)]
    // a task the reading does not hold: the server's own words, if closed
    // (an open one missing from the reading is a stale answer — skipped)
    return s.closed
      ? [{ key: s.key, ref: s.ref, title: s.title, state: asState(s.state), closed: true, current: s.current === true, view: null, file: s.file ?? null }]
      : []
  })
}

// Every conversation CURRENT on an OPEN task, with those tasks — the
// sidebar's ☑ while the server's by-session answer is on its way: computed ONCE over the reading and the census the web
// already holds (no per-row fetch). The thread rule is the server's
// (task-threads.ts threadMembership): a session is a member when the task
// lists it, an ancestor of it, or a session of the same thread root —
// rotations (a /clear, a keep thread) walked through parentKey, inside one
// agent's sessions. Only the current conversations count: an unlinked
// thread carries no ☑. Keyed by session id.
export function openTasksBySession(agents: readonly AgentView[], tasks: readonly TaskView[]): Map<string, TaskView[]> {
  const out = new Map<string, TaskView[]>()
  const open = tasks.filter((t) => !isFinished(t.state) && t.currentConversations.length > 0)
  if (open.length === 0) return out
  const add = (id: string, t: TaskView): void => {
    const l = out.get(id)
    if (!l) out.set(id, [t])
    else if (!l.includes(t)) l.push(t)
  }
  // a listed id's thread root, by agent; ids the census lacks are their own root
  const rootOf = new Map<string, string>()
  const byRoot = new Map<string, string[]>()
  for (const a of agents) {
    const byKey = new Map(a.sessions.map((s) => [`${s.folder}/${s.id}`, s]))
    for (const s of a.sessions) {
      let cur = s
      const seen = new Set<string>([s.id])
      while (cur.parentKey && seen.size < 64) {
        const up = byKey.get(cur.parentKey)
        if (!up || seen.has(up.id)) break
        seen.add(up.id)
        cur = up
      }
      rootOf.set(s.id, cur.id)
      const l = byRoot.get(cur.id)
      if (l) l.push(s.id)
      else byRoot.set(cur.id, [s.id])
    }
  }
  for (const t of open) {
    for (const id of t.currentConversations) {
      add(id, t)
      for (const member of byRoot.get(rootOf.get(id) ?? id) ?? []) add(member, t)
    }
  }
  return out
}

// ⌘K «Link this conversation to a task…»: the tasks this conversation could
// be working — its AGENT's open ones (a conversation is the agent's; linking
// it to another agent's task would make the wrong agent its worker), the
// conversation's PROJECT first (cwd inside the plan's folder — a worktree
// counts), then by last activity; the ones it already works left out.
// `q` narrows by title or plan#id.
export function linkCandidates(
  tasks: readonly TaskView[],
  ctx: { agentId: string; cwd: string | null; linked: ReadonlySet<string>; agents: readonly AgentView[]; now: number },
  q = '',
): TaskView[] {
  const words = q.trim().toLowerCase()
  const inProject = (t: TaskView): boolean => !!t.folder && !!ctx.cwd && (ctx.cwd === t.folder || ctx.cwd.startsWith(`${t.folder}/`))
  const open = tasks.filter(
    (t) =>
      t.owner === ctx.agentId &&
      !isFinished(t.state) &&
      !ctx.linked.has(t.key) &&
      (words === '' || t.title.toLowerCase().includes(words) || t.ref.toLowerCase().includes(words)),
  )
  const ordered = byActivity(open, ctx.agents, ctx.now)
  return [...ordered.filter(inProject), ...ordered.filter((t) => !inProject(t))]
}

// The owner's conversations no task names — counted, never hidden (spec B:
// «N conversations without a task»). Over the census the sidebar lists.
export function conversationsWithoutTask(agents: readonly AgentView[], tasks: readonly TaskView[]): number {
  const linked = new Set(tasks.flatMap((t) => t.conversations))
  return agents.reduce((n, a) => n + a.sessions.filter((s) => !s.origin && !linked.has(s.id)).length, 0)
}

// The page's route for a task
export function taskPage(t: Pick<TaskView, 'planKey' | 'id'>): { kind: 'task'; plan: string; task: string } {
  return { kind: 'task', plan: t.planKey, task: t.id }
}

// A plan's HOUSE (one door per thing): its name opens
// Tasks narrowed to it (product.md: a named plan shows as a crumb, a fold in
// the sidebar and the Tree's groups; nowhere else does it earn a surface).
// Its file is reached from there by an explicit «Open file», never by the name.
export function planHouse(planKey: string): { kind: 'tasks'; view: 'open'; plan: string[] } {
  return { kind: 'tasks', view: 'open', plan: [planKey] }
}

// A plan's DOOR — the one rule for where a plan's name or row lands:
// an OPEN plan opens its house (planHouse — Tasks narrowed to it); a CLOSED
// plan is in no task list and a plan whose tasks CAN'T BE READ is fixed only
// in its file, so either opens its read-only file (the file viewer); so does
// a plan outside Silos' projects (it has no house). A file under
// `plans/closed/` is a closed plan. Without a file to open, such a plan has
// no door (null).
export type PlanDoor = { kind: 'house'; page: ReturnType<typeof planHouse> } | { kind: 'file'; path: string }
export function planDoor(p: { key: string; file?: string | null; closed?: boolean; unreadable?: boolean; outside?: boolean }): PlanDoor | null {
  const closed = p.closed === true || isClosedPlanPath(p.file ?? '')
  if (closed || p.unreadable || p.outside) return p.file ? { kind: 'file', path: p.file } : null
  return { kind: 'house', page: planHouse(p.key) }
}

// A conversation's OWN loose tasks — the rows its column's Plan block paints
// beside its plans: tasks of a project's list (no plan) it still holds
// (current — a let-go link is history) that are still open. A named plan's
// task never; a finished or closed one never.
export function ownLooseTasks(work: readonly WorkedTask[]): WorkedTask[] {
  const loose = (t: WorkedTask): boolean => t.view?.standingList ?? (t.file !== null && isStandingPlan(t.file))
  return work.filter((t) => loose(t) && t.current && !t.closed && !isFinished(t.state))
}

// a task's key from its plan's key and id (the silo's sub-kind key)
export function taskKeyOf(planKey: string, taskId: string): string {
  return `${planKey}/tasks/${taskId}`
}

// a note's moment in words («2h ago»), '' when the note carries none (a
// string note of before, lifted with no date)
export function noteWhen(n: TaskNote, now: number): string {
  const ms = Date.parse(n.at)
  return Number.isNaN(ms) ? '' : relTime(ms, now)
}

// ── the sidebar's tasks: «Now» on top, every plan folded (navigation) ─────

// A task the owner can act on right now: theirs, open, not blocked and with
// every blocker done (a gate counts — it is theirs to decide)
export function isReadyOnOwner(t: TaskView, plan: ReadonlyMap<string, TaskView>, agentIds: ReadonlySet<string>): boolean {
  if (!isHumanOwner(t.owner, agentIds) || !isYou(t.owner) || isFinished(t.state) || t.state === 'blocked') return false
  return t.dependsOn.every((d) => plan.get(d)?.state === 'done')
}

export const NOW_CAP = 5
// «Now»: the open tasks a conversation is working (live), then the owner's
// ready ones — each group by last activity. Live ones are never capped (they
// are bounded by what runs); the cap trims the ready ones, and `more` counts
// only those — every one of them is in Yours to do, the view «more» opens
// (the section and its door say the same set).
export function nowTasks(all: readonly TaskView[], agents: readonly AgentView[], now: number, cap = NOW_CAP): { shown: TaskView[]; more: number } {
  const agentIds = new Set(agents.map((a) => a.id))
  const plans = new Map<string, Map<string, TaskView>>()
  for (const t of all) {
    const m = plans.get(t.planKey) ?? new Map<string, TaskView>()
    m.set(t.id, t)
    plans.set(t.planKey, m)
  }
  const open = all.filter((t) => !isFinished(t.state))
  const live = byActivity(
    open.filter((t) => isLiveTask(t, agents, now)),
    agents,
    now,
  )
  const liveKeys = new Set(live.map((t) => t.key))
  const ready = byActivity(
    open.filter((t) => !liveKeys.has(t.key) && isReadyOnOwner(t, plans.get(t.planKey)!, agentIds)),
    agents,
    now,
  )
  const room = Math.max(0, cap - live.length)
  return { shown: [...live, ...ready.slice(0, room)], more: Math.max(0, ready.length - room) }
}

// A plan's ONE fraction (work-photograph §3.2): done over what is still meant
// to be done, over ALL its tasks — finished ones included, a dropped one
// leaving the total (team-plan.ts's rule). The sidebar's plan unit, the plan
// view's head and the column's plan card say this number, never their own.
// Takes Silos' tasks (`state`) or a team plan's (`status`).
export function planProgress(tasks: ReadonlyArray<{ state: PlanStatus } | { status: PlanStatus }>): { done: number; total: number } {
  return statesProgress(tasks.map((t) => ('state' in t ? t.state : t.status)))
}

// one plan's unit (the sidebar): its fraction over ALL its tasks
// (planProgress), its open tasks, how many of those are the owner's (the
// Yours-to-do word), whether a conversation works one now
export interface PlanFold {
  open: number
  onYou: number
  live: boolean
  done: number
  total: number
}
export function planFold(planAll: readonly TaskView[], agents: readonly AgentView[], now: number): PlanFold {
  const agentIds = new Set(agents.map((a) => a.id))
  const open = planAll.filter((t) => !isFinished(t.state))
  return {
    open: open.length,
    onYou: open.filter((t) => isHumanOwner(t.owner, agentIds) && isYou(t.owner)).length,
    live: open.some((t) => isLiveTask(t, agents, now)),
    ...planProgress(planAll),
  }
}

// Tasks › Done's Plans strip: the finished plans (plans/closed/), the current
// month in view, each earlier month behind its own fold — like the archives.
// `month` 'YYYY-MM' (UTC), newest first; `label` null for the current month
// (it shows open, no head of its own), «Oct» / «Dec 2025» for the others.
export interface ClosedPlanFold {
  month: string
  label: string | null
  plans: ClosedPlanEntry[]
}
export function closedPlanFolds(plans: readonly ClosedPlanEntry[], now: number): ClosedPlanFold[] {
  const monthOf = (ms: number): string => new Date(ms).toISOString().slice(0, 7)
  const current = monthOf(now)
  const year = new Date(now).getUTCFullYear()
  const by = new Map<string, ClosedPlanEntry[]>()
  for (const p of [...plans].sort((a, b) => b.mtime - a.mtime)) {
    const m = monthOf(p.mtime)
    by.set(m, [...(by.get(m) ?? []), p])
  }
  return [...by.entries()]
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([month, list]) => {
      if (month >= current) return { month, label: null, plans: list }
      const [y, mo] = month.split('-').map(Number) as [number, number]
      const name = new Date(Date.UTC(y, mo - 1, 1)).toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' })
      return { month, label: `${name}${y === year ? '' : ` ${y}`}`, plans: list }
    })
}

// The sidebar's foot door «Finished plans ›»: Tasks › Done, unnarrowed —
// the one house of finished plans (its Plans strip)
export function finishedPlansPage(): { kind: 'tasks'; view: 'done' } {
  return { kind: 'tasks', view: 'done' }
}
