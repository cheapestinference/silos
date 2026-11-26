// home.ts — pure derivations for Home (docs/product.md, moments 1 + 2):
// the PULSE (who is working, what finished today, who is in charge) and
// THE INBOX — every "needs you" signal in one list, engine-independent.
// The inbox is composed by the SERVER (server/src/inbox.ts, GET /api/board
// `inbox`) so Home, the daily digest and the phone's doorbell can never
// disagree. Every row speaks the silo standard's
// urgency (blocking | due | routine) and cites the fact that makes it true:
//  · ask, approval, escalated, message, silo (a plan's tasks among them), siloSummary —
//    as before
//  · failedRun      — an automation failing in a way that won't heal alone
//  · missedRetry    — a retry on a usage limit that never happened
//  · territoryOff / cut — an own agent without territory; one Silos stopped
//  · unreadMessages — messages from one sender their recipient hasn't read
//                     past its next chance (no message wakes anyone)
//  · agentSummary   — one agent's foldable rows past its budget, as one line
//  · proposal       — what an agent proposed: an automation, a skill, a mission
//                     (Accept | Dismiss, or Review › | Dismiss)
//  · proposalSummary — one agent's proposals past its budget, as one line
//  · plansBaseline  — a folder's tasks from before Silos watched it (Keep them all ›)
// What stays here is the page's own business: scoping to a project folder,
// hiding what the owner just answered (optimistic), and the words.
// Tested on its own (test/home.test.ts).
import { agentAtWork, parkedWords, sessionSignal } from './live'
import { executionWord } from './execution'
import { countsOf } from './counts'
import { territoriesOf } from './territory'
import { sameProject } from '../../../server/src/project-scope'
import { baselineWords } from './initiative'
import { isStandingParent, isTaskRow, taskTitle } from './home-projects'
import type {
  AgentView,
  Automation,
  BoardCard,
  EngineCompat,
  InboxRow,
  NeedsYouItem,
  PlanHandoff,
  Run,
  SessionCounts,
  SessionView,
  SiloDoneItem,
  SiloGrowthTerm,
  SiloPulseTerm,
  SiloWithProducer,
  TasksSession,
} from './types'

export type InboxItem = InboxRow

export function inboxKey(i: InboxItem): string {
  return i.key
}

// a row hidden here on the owner's gesture stays hidden only while the
// server still lists it: once it left, the key is forgotten — the same task
// asking AGAIN (the agent woke on the answer and has a second question) is a
// new row and shows
export function stillListed(hidden: Set<string>, rows: readonly InboxItem[]): Set<string> {
  if (hidden.size === 0) return hidden
  const listed = new Set(rows.map(inboxKey))
  const next = new Set([...hidden].filter((k) => listed.has(k)))
  return next.size === hidden.size ? hidden : next
}

// The server's rows, scoped to a project folder (the project page is Home
// with a folder, docs/product.md): the same "inside" rule scopeToFolder
// applies to the input — `agentIds` is the scoped agents' set (scopeToFolder's
// own output, Anywhere included). A conversation's ask by its cwd when it is
// Anywhere's; plan tasks by their plan's folder; silo rows by their folder
// anchor, else their agent; a silo summary counts only the folder's agents'
// rows when it says them per agent; everything else by its agent.
export function scopeInbox(rows: readonly InboxItem[], folder: string, agentIds: ReadonlySet<string>, masterId: string): InboxItem[] {
  const out: InboxItem[] = []
  for (const r of rows) {
    switch (r.kind) {
      case 'silo':
        if (r.item.folder ? inFolder(folder, r.item.folder) : r.item.agentId !== undefined && agentIds.has(r.item.agentId)) out.push(r)
        break
      case 'siloSummary': {
        // counted per agent (an agent-anchored silo, like support): the
        // folder sees only its agents' rows, as the native summary did
        if (r.byAgent && r.folders.length === 0) {
          const count = Object.entries(r.byAgent).reduce((n, [a, c]) => n + (agentIds.has(a) ? c : 0), 0)
          if (count > 0) out.push({ ...r, count, agentIds: r.agentIds.filter((a) => agentIds.has(a)) })
        } else if (r.folders.some((f) => inFolder(folder, f)) || r.agentIds.some((a) => agentIds.has(a))) out.push(r)
        break
      }
      case 'ask':
        if ((r.agentId !== masterId && agentIds.has(r.agentId)) || inFolder(folder, r.cwd)) out.push(r)
        break
      case 'approval':
        if (r.agentId !== null && agentIds.has(r.agentId)) out.push(r)
        break
      // an account is machine-wide: a project sees it only through its own
      // automations, and counts only those
      case 'accountLimit': {
        const automations = r.automations.filter((a) => agentIds.has(a.agentId))
        if (automations.length > 0) out.push({ ...r, automations, agentIds: r.agentIds.filter((a) => agentIds.has(a)) })
        break
      }
      // the task lines: their tasks by their plans' folder
      case 'taskLine':
      case 'tasksStalled': {
        const keys = r.keys.filter((k) => inFolder(folder, taskKeyFolder(k)))
        const items = 'items' in r && Array.isArray(r.items) ? { items: r.items.filter((x) => keys.includes(x.key)) } : {}
        if (keys.length > 0) out.push({ ...r, keys, count: keys.length, ...items })
        break
      }
      // an engine is machine-wide: a project sees it only through its own
      // agents on it, and names only those
      case 'engineCompat': {
        const engines = r.engines.flatMap((e) => {
          const ids = e.agentIds.filter((a) => agentIds.has(a))
          return ids.length > 0 ? [{ ...e, agentIds: ids }] : []
        })
        if (engines.length > 0) out.push({ ...r, engines, agentIds: r.agentIds.filter((a) => agentIds.has(a)) })
        break
      }
      // a seal's row about no agent (a credential, a home-layer file) is machine-wide
      // the wiring is machine-wide, seen through the project's agents on it
      case 'engineUnwired':
        if (r.agentIds.some((a) => agentIds.has(a))) out.push({ ...r, agentIds: r.agentIds.filter((a) => agentIds.has(a)) })
        break
      // a newer Silos is the install's, not a project's: the global Home says it once
      case 'silosUpdate':
        break
      case 'integrity':
        if (r.agentId === null || agentIds.has(r.agentId)) out.push(r)
        break
      // a folder's baseline is its project's
      case 'plansBaseline':
        if (inFolder(folder, r.folder)) out.push(r)
        break
      // a task's wait by its plan's folder; a
      // plan's unreadable tasks by its folder; the closed plans, only the folder's
      case 'waitsOnRelay':
        if (inFolder(folder, taskKeyFolder(r.task.key))) out.push(r)
        break
      case 'tasksUnreadable':
        if (inFolder(folder, r.plan.folder)) out.push(r)
        break
      // a file in the Projects folder reaches every project inside it: this
      // one's door is its own Memory
      case 'projectsFolderFile':
        if (inFolder(r.projectsFolder, folder) && folder !== r.projectsFolder) out.push({ ...r, projects: [folder] })
        break
      case 'closedPlansOpen': {
        const plans = r.plans.filter((p) => inFolder(folder, p.folder))
        if (plans.length > 0) out.push({ ...r, plans, count: plans.length })
        break
      }
      default:
        if (agentIds.has(r.agentId)) out.push(r)
    }
  }
  return out
}

// the project folder a task key lives in ('folder:/p/proj/plan/tasks/t3' → '/p/proj')
export function taskKeyFolder(key: string): string | null {
  if (!key.startsWith('folder:')) return null
  const cut = key.lastIndexOf('/tasks/')
  const plan = cut > 0 ? key.slice('folder:'.length, cut) : key.slice('folder:'.length)
  const slash = plan.lastIndexOf('/')
  return slash > 0 ? plan.slice(0, slash) : null
}

// A folded silo summary in words: the kind's noun when the manifest says it
// («13 support tickets wait on you»), else the silo's items.
export function siloSummaryWords(r: { count: number; siloName: string; noun?: { one: string; many: string } }): string {
  const n = r.count
  if (r.noun) return `${n} ${n === 1 ? r.noun.one : r.noun.many} ${n === 1 ? 'waits' : 'wait'} on you`
  return `${n} ${r.siloName} item${n === 1 ? ' waits' : 's wait'} on you`
}

// The inbox ceiling health line — the server's
// inboxCeiling over what this page shows: past INBOX_CEILING unfolded
// blocking + due rows the inbox says so once, under its label. Said, not
// hidden. Null under the ceiling.
export const INBOX_CEILING = 12
export function ceilingLine(rows: readonly Pick<InboxItem, 'urgency' | 'at'>[], now: number): string | null {
  const loud = rows.filter((r) => r.urgency === 'blocking' || r.urgency === 'due')
  if (loud.length <= INBOX_CEILING) return null
  const ats = loud.map((r) => r.at).filter((t) => t > 0)
  const head = `${loud.length} rows — more than anyone reads`
  if (ats.length === 0) return head
  const waited = Math.max(0, now - Math.min(...ats))
  const days = Math.floor(waited / 86_400_000)
  const hours = Math.floor(waited / 3_600_000)
  const span = days >= 1 ? `${days} day${days === 1 ? '' : 's'}` : hours >= 1 ? `${hours} hour${hours === 1 ? '' : 's'}` : 'minutes'
  return `${head}; the oldest have waited ${span}`
}

// A failure streak in words: failed · failed twice · failed 3 times in a row
// An account's limit in the words of the inbox (server inbox.ts accountLimitRows):
// «Your Claude account: Fable at 100% — resets tomorrow at 06:00», or, with
// no reading of its windows, «Your Claude account hit its usage limit».
export function limitWords(r: { account: string; window: { label: string; percent: number; resetsAt: string | null } | null }, now: number): string {
  if (!r.window) return `${r.account} hit its usage limit`
  return `${r.account}: ${r.window.label} at ${r.window.percent}%${r.window.resetsAt ? ` — resets ${resetWords(r.window.resetsAt, now)}` : ''}`
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const dayKey = (d: Date): string => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`
// «at 06:00» today, «tomorrow at 06:00», else «Sat at 06:00» — local time
export function resetWords(iso: string, now: number): string {
  const d = new Date(Date.parse(iso))
  const at = `at ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  if (dayKey(d) === dayKey(new Date(now))) return at
  if (dayKey(d) === dayKey(new Date(now + 86_400_000))) return `tomorrow ${at}`
  return `${WEEKDAYS[d.getDay()]} ${at}`
}

// «Nightly backup couldn't run» · «3 automations couldn't run: A, B and 1 more»
export function stoppedWords(names: readonly string[]): string {
  if (names.length === 1) return `${names[0]} couldn't run`
  const list = names.length <= 2 ? names.join(' and ') : `${names.slice(0, 2).join(', ')} and ${names.length - 2} more`
  return `${names.length} automations couldn't run: ${list}`
}

export function failedTimes(streak: number): string {
  return streak <= 1 ? 'failed' : streak === 2 ? 'failed twice' : `failed ${streak} times in a row`
}

// how long something has waited (server inbox.ts waitedWords, the voice of
// the same rows): «40 min», «3 h», «2 d»
export function waitedWords(ms: number): string {
  const m = Math.max(0, Math.floor(ms / 60_000))
  if (m < 60) return `${m} min`
  const h = Math.floor(m / 60)
  return h < 24 ? `${h} h` : `${Math.floor(h / 24)} d`
}

// Permission asks the owner answered here, by permission id → when (Home's
// optimistic removal). The plugin deletes the ask once it has told OpenCode;
// when that fails it deletes only the reply and the ask stays. So an answer
// hides its row only for ANSWER_GRACE_MS, and only while the board still
// lists it: once a load no longer does, the id is dropped (pruneAnswered),
// and a later re-appearance shows at once.
export const ANSWER_GRACE_MS = 15_000
export function answerHidden(answered: ReadonlyMap<string, number>, id: string, now: number): boolean {
  const at = answered.get(id)
  return at !== undefined && now - at < ANSWER_GRACE_MS
}
export function pruneAnswered(answered: Map<string, number>, needsYou: readonly NeedsYouItem[]): Map<string, number> {
  if (answered.size === 0) return answered
  const listed = new Set(needsYou.flatMap((n) => (n.kind === 'ask' ? [n.id] : [])))
  const next = new Map([...answered].filter(([id]) => listed.has(id)))
  return next.size === answered.size ? answered : next
}

// Needs you vs. «yours to do»: a task of yours (a plan's)
// waits in Needs you when the server made it `due` — a gate an agent's task
// waits on, or a due date a week away or past (plans.silo.json's first
// needs-you entry); a routine one stays in its project's «yours to do»,
// grouped by its plan.
// A task line (waitsStart, comingToYou, idle) never waits: it is
// Yours to do's and Working now's quiet line, never Needs you's lead.
// An engine row waits only when Silos refuses something on it (server
// engineCompatRow: `due`); an engine newer than Silos was built for stops
// nothing — a quiet note beside the pulse (aheadEngines), never «stops work».
export function isWaiting(i: InboxItem): boolean {
  if (i.kind === 'taskLine') return false
  if (i.kind === 'engineCompat') return i.urgency !== 'routine'
  // an unwired engine stops nothing either: a quiet row with its door
  if (i.kind === 'engineUnwired') return false
  // a newer Silos stops nothing: the date line's quiet chip, never Needs you
  if (i.kind === 'silosUpdate') return false
  return !isTaskRow(i) || i.urgency !== 'routine'
}

// Home's ONE list («yours to do» and «needs you» are the same thing):
// «Needs you» holds first what holds someone up — every waiting
// row, in the server's order — then the owner's own tasks, in their
// projects' order. The first rows that hold someone up AND carry a question
// (at most HOME_CARDS) are drawn large; the list shows HOME_LIST_MAX rows
// and counts what it leaves for its doors (the Needs you sheet, the owner's
// own list) by kind — nothing is dropped, only folded behind a door.
export const HOME_LIST_MAX = 7
export const HOME_CARDS = 2
export interface HomeListRow<T> {
  item: T
  holds: boolean
  card: boolean
}
export interface HomeList<T> {
  rows: Array<HomeListRow<T>>
  holds: number
  yours: number
  hiddenHolds: number
  hiddenYours: number
}
export function homeList<T>(holding: readonly T[], yours: readonly T[], asks: (i: T) => boolean, max = HOME_LIST_MAX): HomeList<T> {
  let cards = 0
  const all: Array<HomeListRow<T>> = [
    ...holding.map((item, i) => {
      const card = i < max && cards < HOME_CARDS && asks(item)
      if (card) cards++
      return { item, holds: true, card }
    }),
    ...yours.map((item) => ({ item, holds: false, card: false })),
  ]
  const rows = all.slice(0, max)
  const shownHolds = rows.filter((r) => r.holds).length
  return { rows, holds: holding.length, yours: yours.length, hiddenHolds: holding.length - shownHolds, hiddenYours: yours.length - (rows.length - shownHolds) }
}

// What is true of one engine verdict, in a few words: who has to act.
// `ahead` is Silos' own update (its client library), never the engine's.
export function engineHead(e: Pick<EngineCompat, 'name' | 'state' | 'installed'>): string {
  switch (e.state) {
    case 'missing':
      return `Silos can't find ${e.name}`
    case 'outdated':
      return `${e.name} needs an update`
    case 'ahead':
      return `Silos needs an update — ${e.name}${e.installed ? ` ${e.installed}` : ''} is newer than it was built for`
    case 'ok':
      return `${e.name} is up to date`
  }
}
// the engines Silos refuses (the waiting row's), and the ones it only has to
// catch up with (the quiet note's) — each said once
export function refusingEngines<E extends EngineCompat>(engines: readonly E[]): E[] {
  return engines.filter((e) => e.refuses.length > 0)
}
export function aheadEngines(inbox: readonly InboxItem[]): EngineCompat[] {
  return inbox.flatMap((i) => (i.kind === 'engineCompat' ? i.engines.filter((e) => e.refuses.length === 0 && e.state === 'ahead') : []))
}
// a newer published Silos (inbox.ts silosUpdateRow): the date line's second
// quiet chip, its door Settings › About (where the update line is written out)
export function silosUpdateOf(inbox: readonly InboxItem[]): Extract<InboxItem, { kind: 'silosUpdate' }> | null {
  return inbox.find((i): i is Extract<InboxItem, { kind: 'silosUpdate' }> => i.kind === 'silosUpdate') ?? null
}

// A silo task row's why, read off the server's one row (voice.ts sayRow:
// «<task> — <state> · unblocks 1 task of Writer · due Nov 6»): what follows its
// state — « — unblocks 1 task of Writer», « — due Nov 6» — or ''. The state
// itself is not repeated: the row is yours because it is ready.
export function taskWhy(i: Extract<InboxItem, { kind: 'silo' }>): string {
  const id = i.item.identity
  if (!id || !i.item.text.startsWith(`${id} — `)) return ''
  const parts = i.item.text.slice(id.length + 3).split(' · ')
  return parts.length > 1 ? ` — ${parts.slice(1).join(' — ')}` : ''
}

// c1: Home learns about background work — per-conversation live/total
// subagent counts from the /api/tasks payload (the same census the Tasks
// page and the context column trust). Key = `folder/id`.
export interface BackgroundWork {
  live: number
  total: number
  // a plan executed with subagents (lib/execution.ts): the newest live
  // step, "Task 12 · reviewing"; null when the session isn't doing that
  execution: string | null
}
export function backgroundBySession(sessions: readonly TasksSession[], now: number): Map<string, BackgroundWork> {
  const out = new Map<string, BackgroundWork>()
  for (const s of sessions) {
    out.set(`${s.folder}/${s.id}`, {
      live: s.subagents.filter((a) => agentAtWork(a, now)).length,
      total: s.subagents.length,
      execution: executionWord(s.subagents, now),
    })
  }
  return out
}

export interface WorkingRow {
  agent: AgentView
  s: SessionView
}
export function workingNow(agents: readonly AgentView[], now: number): WorkingRow[] {
  const out: WorkingRow[] = []
  for (const agent of agents) {
    for (const s of agent.sessions) {
      if (sessionSignal(s, now, false) === 'working') out.push({ agent, s })
    }
  }
  return out.sort((a, b) => b.s.mtime - a.s.mtime)
}

// the secondary word of a Working now line: "working"; live background
// subagents still say so. A conversation executing a plan step by step
// says WHICH step instead ("Task 12 · reviewing") — that live subagent is
// the background, so the count would only repeat it.
export function workingWord(liveBackground: number, execution: string | null = null): string {
  if (execution) return execution
  return liveBackground > 0 ? `working · ${liveBackground} subagent${liveBackground === 1 ? '' : 's'}` : 'working'
}

// Conversations parked on something outside them — a Monitor, a scheduled
// wakeup, a workflow (the server's 'waiting' cut, server/src/board.ts) —
// newest first. Not working, not waiting on you: they will move by
// themselves. Home's Working now says them after the working ones (the
// Board's former Waiting column).
export function waitingNow(cards: readonly BoardCard[]): BoardCard[] {
  return cards.filter((c) => c.state === 'waiting').sort((a, b) => b.mtime - a.mtime)
}
// the working rows minus the parked ones: a Monitor, a wakeup or a
// workflow never counts as a tool in flight (the parser skips
// PARKING_TOOLS), and the server knows what that tool is — waiting, said
// once, as waiting
export function notParked(working: readonly WorkingRow[], parked: readonly BoardCard[]): WorkingRow[] {
  const keys = new Set(parked.map((c) => `${c.folder}/${c.id}`))
  return working.filter((w) => !keys.has(`${w.s.folder}/${w.s.id}`))
}

// what a waiting conversation waits on — one voice with the context
// column's status (lib/live.ts parkedWords)
export function waitingOnWords(c: BoardCard): string {
  if (!c.waiting) return 'waiting'
  return parkedWords(c.waiting.kind, c.waiting.label)
}

// touched today and no longer live — the server's 'done_today' cut.
export function doneToday(cards: readonly BoardCard[]): BoardCard[] {
  return cards.filter((c) => c.state === 'done_today').sort((a, b) => b.mtime - a.mtime)
}

// The fleet — one row per agent, what is true of it right now: its live
// conversations (asks first, then working), what it finished today, its
// standing duty. Rows are ordered by what deserves the eye: someone
// waiting on you, then work in motion, then a duty held, then the rest by
// last activity. Archived agents never appear; Anywhere only when it has
// something to say.
export interface FleetRow {
  agent: AgentView
  asks: SessionView[]
  working: SessionView[]
  // live nested runs (births — an agent's own `claude -p`): the agent is
  // working, but they are not its conversations — one line, not a row each.
  nested: SessionView[]
  done: BoardCard[]
  // records an active silo saw close today, anchored to this agent (or
  // produced by it): «F2026-0412 · Acme SL paid»
  siloDone: SiloDoneItem[]
  lastActive: number
}
export function fleet(
  agents: readonly AgentView[],
  cards: readonly BoardCard[],
  now: number,
  masterId: string,
  siloDone: readonly SiloDoneItem[] = [],
): FleetRow[] {
  const rows: FleetRow[] = []
  // parked on a Monitor / wakeup / workflow: waiting, not working — the same
  // cut Working now makes (notParked), so the tiles never disagree
  const parked = new Set(cards.filter((c) => c.state === 'waiting').map((c) => `${c.folder}/${c.id}`))
  for (const agent of agents) {
    if (agent.archived) continue
    const asks: SessionView[] = []
    const working: SessionView[] = []
    const nested: SessionView[] = []
    for (const s of agent.sessions) {
      if (s.pendingAsk === true) asks.push(s)
      else if (sessionSignal(s, now, false) === 'working' && !parked.has(`${s.folder}/${s.id}`)) (s.origin?.kind === 'nested' ? nested : working).push(s)
    }
    const done = cards.filter((c) => c.agentId === agent.id && c.state === 'done_today').sort((a, b) => b.mtime - a.mtime)
    const mineDone = siloDone.filter((d) => d.agentId === agent.id)
    const lastActive = agent.sessions.reduce((m, s) => Math.max(m, s.mtime), 0)
    const quiet =
      asks.length === 0 && working.length === 0 && nested.length === 0 && done.length === 0 && mineDone.length === 0 && !(agent.mission?.text ?? '').trim()
    if (agent.id === masterId && quiet) continue
    rows.push({ agent, asks, working, nested, done, siloDone: mineDone, lastActive })
  }
  const rank = (r: FleetRow): number =>
    r.asks.length > 0
      ? 0
      : r.working.length > 0 || r.nested.length > 0
        ? 1
        : (r.agent.mission?.text ?? '').trim()
          ? 2
          : r.done.length > 0 || r.siloDone.length > 0
            ? 3
            : 4
  return rows.sort((a, b) => rank(a) - rank(b) || b.lastActive - a.lastActive)
}

// The headline: not a count of everything, the ONE thing that matters
// most right now, in words — who is waiting on you and since when; else
// who is working; else that it is quiet. Composed only from real rows.
export function headline(input: {
  inbox: readonly InboxItem[]
  working: readonly WorkingRow[]
  agentName: (id: string) => string
  now: number
  ago: (t: number, now: number) => string
  // the active silos' pulse terms («Invoices: €12,400 outstanding»), said
  // after the headline; absent or empty = the headline as it always was
  silos?: readonly SiloPulseTerm[]
}): string {
  const s = siloPulseClause(input.silos)
  return s ? `${headlineCore(input)} ${s}` : headlineCore(input)
}
// Records an UNINSTALLED silo's producers keep writing (the board's
// `silos.growth`, installer.ts): files no surface shows — the silent lie the
// standard's freshness exists to prevent. Said verbatim, one line per
// silo, beside the pulse; never folded into the headline, which speaks of
// what waits on you. Absent or empty = no line at all.
export function siloGrowthLines(growth: readonly SiloGrowthTerm[] | undefined): Array<{ silo: string; text: string }> {
  if (!growth) return []
  const seen = new Set<string>()
  const out: Array<{ silo: string; text: string }> = []
  for (const g of growth) {
    if (seen.has(g.silo) || g.records <= 0 || g.term.trim() === '') continue
    seen.add(g.silo)
    out.push({ silo: g.silo, text: g.term })
  }
  return out
}

// Needs-you entries the operator routed to the producer (audience:
// producer-agent): the inbox never lists their rows — Home says this one line
// per silo+entry, with the producer's closures counted from Done today
// («674 invoices are with the Finance · 3 closed today»).
export function siloWithProducerLines(
  withProducer: readonly SiloWithProducer[] | undefined,
  done: readonly SiloDoneItem[] | undefined,
  nameOf: (agentId: string) => string,
): Array<{ silo: string; agentId: string; text: string }> {
  if (!withProducer) return []
  return withProducer
    .filter((w) => w.count > 0 || (w.escalated ?? 0) > 0)
    .map((w) => {
      const closed = (done ?? []).filter((d) => d.silo === w.silo && d.recordKind === w.recordKind).length
      const kind = w.count === 1 ? w.recordKind : `${w.recordKind}s`
      // the ones that rose to the owner past the window are listed in Needs
      // you; the line counts them («· 3 escalated to you»)
      const rose = w.escalated ?? 0
      return {
        silo: w.silo,
        agentId: w.agentId,
        text: `${w.count > 0 ? `${w.count} ${kind} ${w.count === 1 ? 'is' : 'are'} with ${nameOf(w.agentId)}` : `none left with ${nameOf(w.agentId)}`}${rose > 0 ? ` · ${rose} escalated to you` : ''}${closed > 0 ? ` · ${closed} closed today` : ''}`,
      }
    })
}

// Records a silo saw close today that belong to NO agent and no folder —
// platform data (a kernel source: a subscription window that reset). The
// fleet's rows are per agent, so these have no row there; Home says them in
// one line beside the pulse («done today — Fable week · kai reset»; items
// joined by commas, since an identity may itself carry «·»), on the
// unscoped Home only (a project page has no platform share).
export function platformDoneLine(done: readonly SiloDoneItem[] | undefined): { silo: string; text: string } | null {
  const mine = (done ?? []).filter((d) => d.agentId === undefined && d.folder === undefined)
  if (mine.length === 0) return null
  return { silo: mine[0]!.silo, text: `done today — ${mine.map((d) => `${d.identity} ${d.toLabel}`).join(', ')}` }
}

export function siloPulseClause(terms: readonly SiloPulseTerm[] | undefined): string {
  if (!terms || terms.length === 0) return ''
  return terms.map((t) => `${t.siloName}: ${t.term}`).join(' · ') + '.'
}
function headlineCore(input: {
  inbox: readonly InboxItem[]
  working: readonly WorkingRow[]
  agentName: (id: string) => string
  now: number
  ago: (t: number, now: number) => string
}): string {
  const { working, agentName, now, ago } = input
  // agents waiting on you (asks, escalations, approvals) vs. plan tasks
  // that are yours to DO — two different things: the
  // headline speaks of the first; the second gets its own clause.
  // Home is a board: its tiles carry the counts (Needs you,
  // Yours to do, Working now), so the pulse no longer repeats them — it
  // names the ONE thing that matters most, or, when nothing waits, who is
  // working. Plan tasks are the Yours to do tile's.
  const waiting = input.inbox.filter(isWaiting)
  if (waiting.length > 0) {
    const top = waiting[0]!
    const tail = '.'
    let head = ''
    switch (top.kind) {
      case 'ask':
        head = `${agentName(top.agentId)} has a question for you (${ago(top.at, now)})${tail}`
        break
      case 'escalated':
        head = `${agentName(top.item.agentId)} escalated to you${top.at ? ` ${ago(top.at, now)}` : ''}${tail}`
        break
      case 'message':
        head = `${agentName(top.item.agentId)} needs you about a message from ${top.item.from === 'owner' ? 'you' : agentName(top.item.from)}${tail}`
        break
      case 'approval':
        head = `${agentName(top.automation?.agentId ?? '')} wants your go to run ${top.automation?.name ?? 'an automation'}${tail}`
        break
      case 'proposal':
        head = `${agentName(top.agentId)} ${top.proposalKind === 'skill' ? (top.skillOf ? `changed a skill of ${top.skillOf}` : 'wrote a skill') : 'suggests'}: ${top.title}${tail}`
        break
      case 'proposalSummary':
        head = `${agentName(top.agentId)} suggests ${top.count} things${tail}`
        break
      case 'silo':
        head = isTaskRow(top)
          ? `${taskTitle(top)} is yours${taskWhy(top) || (isStandingParent(top) ? '' : ` in “${top.item.parent.identity}”`)}${tail}`
          : `${top.item.siloName}: ${top.item.text}${tail}`
        break
      case 'siloSummary':
        head = `${siloSummaryWords(top)}${tail}`
        break
      case 'failedRun':
        head = `${agentName(top.agentId)}'s ${top.automation.name} ${failedTimes(top.streak)}: ${top.failure.text}${tail}`
        break
      case 'accountLimit':
        head = `${limitWords(top, now)}${tail}`
        break
      case 'missedRetry':
        head = `${agentName(top.agentId)}'s ${top.automation.name} was due to retry ${ago(Date.parse(top.dueAt), now)} and didn't${tail}`
        break
      case 'territoryOff':
        head = `${agentName(top.agentId)}'s territory turned off — it is Only when told${tail}`
        break
      case 'cut':
        head = `Silos stopped ${agentName(top.agentId)} from creating work on its own${tail}`
        break
      case 'folderRefused':
        head = `${top.voice}${tail}`
        break
      case 'projectsFolderFile':
        head = `${top.voice}${tail}`
        break
      case 'auditUnreadable':
        head = `Silos couldn't read the transcript of ${agentName(top.agentId)}'s ${top.heartbeat ? 'heartbeat' : top.task ? `turn on ${top.task.ref}` : (top.automation?.name ?? 'run')}${tail}`
        break
      case 'unreadMessages':
        head =
          top.why === 'noProject'
            ? `${top.from === 'owner' ? 'You' : agentName(top.from)} wrote to ${agentName(top.agentId)} — they share no project${tail}`
            : `${agentName(top.agentId)} hasn't read ${top.count === 1 ? 'a message' : `${top.count} messages`} from ${top.from === 'owner' ? 'you' : agentName(top.from)}${tail}`
        break
      case 'agentSummary':
        head = `${agentName(top.agentId)}: ${top.count} ${top.runsOnly ? 'automations failing' : 'things need you'}${tail}`
        break
      case 'tasksStalled':
        head = `${top.count} ${top.count === 1 ? 'task sits' : 'tasks sit'} untouched — nobody is moving ${top.count === 1 ? 'it' : 'them'}${tail}`
        break
      case 'ownTurnsCeiling':
        head =
          top.cap === 'spend'
            ? `${agentName(top.agentId)} reached its spend cap for today${tail}`
            : `${agentName(top.agentId)} started ${top.perDay} times without you today — its max${tail}`
        break
      case 'engineCompat':
        head = `${refusingEngines(top.engines).map(engineHead).join('; ')}${tail}`
        break
      case 'integrity':
        head = `${top.voice}${tail}`
        break
      case 'engineUnwired':
        head = `${top.voice}${tail}`
        break
      case 'silosUpdate':
        head = `${top.voice}${tail}`
        break
      case 'plansBaseline':
        head = `${baselineWords(top.tasks.length)}${tail}`
        break
      case 'waitsOnRelay':
        head = `${top.voice}${tail}`
        break // the server's sentence, one source (a self-wait reads «X wrote a wait on itself»)
      case 'closedPlansOpen':
        head = `${top.count} closed ${top.count === 1 ? 'plan still has' : 'plans still have'} open tasks${tail}`
        break
      case 'tasksUnreadable':
        head = `${top.count} ${top.count === 1 ? 'task' : 'tasks'} in ${top.plan.title} can't be read${tail}`
        break
      case 'consoleIdle':
        head = `${agentName(top.agentId)}'s console is open and idle — ${top.count} ${top.count === 1 ? 'wake waits' : 'wakes wait'} for it${tail}`
        break
    }
    return head
  }
  // the pulse by priority: who needs you, then who is
  // working on what, then — said by Home beside this — what was decided
  // without you, then «All quiet.» (with what comes next, when something does)
  if (working.length > 0) {
    const names = [...new Set(working.map((w) => agentName(w.agent.id)))]
    if (names.length === 1) {
      const title = working[0]!.s.title.trim()
      return title ? `${names[0]} is working on ${title}.` : `${names[0]} is working.`
    }
    const who = names.length === 2 ? `${names[0]} and ${names[1]}` : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
    return `${who} are working.`
  }
  return 'All quiet.'
}

// --- a folder scope --------------------------------------------------------
//
// The project page is the Home scoped to a folder (docs/product.md, the
// surface map): the SAME inbox, fleet and pulse, fed only what belongs to
// the folder. Scoping happens on the INPUT, once, so none of the
// derivations above learn about projects. "Belongs" is one criterion
// everywhere — the ProjectPage's exact cwd rule: the folder itself or
// anything hanging off it (a monorepo's subfolders count).
//  · agents: the project's own (their folder inside), whole; Anywhere
//    (master) only with its sessions whose cwd is inside — those are the
//    folder's orphans; every other agent is out.
//  · cards: by cwd. Plan tasks: by their plan's folder. Escalations and
//    approvals: by the agent/automation belonging to the project.
export interface HomeInput {
  agents: readonly AgentView[]
  cards: readonly BoardCard[]
  needsYou: readonly NeedsYouItem[]
  pending: readonly Run[]
  automations: readonly Automation[]
}
export function inFolder(folder: string, path: string | null | undefined): boolean {
  return typeof path === 'string' && (path === folder || path.startsWith(folder + '/'))
}
// Does Silos know anything at this folder? The same "inside" rule as the
// scope: an agent whose folder is it (or hangs off it), or any session —
// any agent's, Anywhere's orphans included — whose cwd does. A folder that
// matches nothing (a mistyped /project link) is not a quiet
// project; the page says so instead of scoping to nothing.
// Member of a folder's project: ANY territory (folder or folders[]) that is
// the same project as it — the server's one resolver (project-scope.ts
// sameProject): folders that nest are one project, both ways, so an agent
// whose folder is AROUND this one is of it too; a sibling prefix is not.
export function memberOf(a: Pick<AgentView, 'folder' | 'folders'>, folder: string): boolean {
  return territoriesOf(a).some((t) => sameProject(t, folder))
}
// The folder AROUND `folder` through which an agent is of its project — when
// none of its folders is `folder` itself or inside it (it works in acme, the
// page is acme/web): the project page says «from acme». null: it works here.
export function aroundFolder(a: Pick<AgentView, 'folder' | 'folders'>, folder: string): string | null {
  const mine = territoriesOf(a).filter((t) => sameProject(t, folder))
  if (mine.length === 0 || mine.some((t) => t === folder || t.startsWith(`${folder}/`))) return null
  return mine.sort((x, y) => y.length - x.length)[0] ?? null
}
// Starts in a folder: its PRIMARY folder is exactly it — the agents a
// folder's skills, MCP servers and memory actually reach (the engine loads
// what the folder a conversation STARTS in holds; a declared territory or a
// subfolder is not where it starts).
export function startsIn(a: Pick<AgentView, 'folder'>, folder: string): boolean {
  return territoriesOf({ folder: a.folder }).includes(folder)
}
// The agent whose console signs a folder's waiting server in: one that
// STARTS there (its conversations load the folder's tools) — `prefer`, the
// agent whose conversation read it, when it is one — archived and the
// inbox never; null: no agent starts there (no door).
export function signInAgentOf<A extends Pick<AgentView, 'id' | 'folder' | 'archived'>>(agents: readonly A[], folder: string, prefer?: string): A | null {
  const here = agents.filter((a) => a.id !== 'master' && !a.archived && startsIn(a, folder))
  return here.find((a) => a.id === prefer) ?? here[0] ?? null
}
// A folder Silos may act on by path: some (non-archived) agent's folder or
// declared territory — the server's managed-folder.ts rule, so the project
// page offers the folder's own doors only where the server will answer.
export function managesFolder(agents: readonly AgentView[], folder: string): boolean {
  return agents.some((a) => a.id !== 'master' && !a.archived && territoriesOf(a).includes(folder))
}
export function knowsFolder(agents: readonly AgentView[], folder: string): boolean {
  return agents.some((a) => memberOf(a, folder) || a.sessions.some((s) => inFolder(folder, s.cwd)))
}
// Claude Code's own name for a folder under ~/.claude/projects: every
// character outside [A-Za-z0-9] becomes '-' (/home/u/x → -home-u-x).
// Lossy on purpose — hence the resolver below only ever maps it BACK onto a
// folder Silos already knows, never invents one.
export function mungeFolder(path: string): string {
  return path.replace(/[^A-Za-z0-9]/g, '-')
}
// The folder a /project link means. A real path Silos knows is itself; the
// munged session-folder form (/project/-home-u-acme, the
// name sessions carry) is an alias of the ONE known folder — an agent's
// folder or a session's cwd — that munges to it. No match, or two known
// folders that munge alike (/a/b-c and /a/b/c), is null: the page then
// says it knows no project rather than guessing.
export function resolveProjectFolder(agents: readonly AgentView[], folder: string): string | null {
  if (knowsFolder(agents, folder)) return folder
  if (folder.startsWith('/')) return null
  const hits = new Set<string>()
  for (const a of agents) {
    for (const t of territoriesOf(a)) if (mungeFolder(t) === folder) hits.add(t)
    for (const s of a.sessions) if (s.cwd && mungeFolder(s.cwd) === folder) hits.add(s.cwd)
  }
  return hits.size === 1 ? [...hits][0]! : null
}
// An agent's share inside one folder (session cwd at or under it), from the
// server's uncapped per-cwd totals — how a project counts Anywhere's
// conversations without owning the agent (lib/counts.ts).
export function countsInFolder(a: AgentView, folder: string): SessionCounts {
  const all = countsOf(a)
  const out: SessionCounts = { conversations: 0, runs: 0, runsByAutomation: all.runsByAutomation, byCwd: {} }
  for (const [cwd, c] of Object.entries(all.byCwd)) {
    if (!inFolder(folder, cwd)) continue
    out.conversations += c.conversations
    out.runs += c.runs
    out.byCwd[cwd] = c
  }
  return out
}
// silo Done-today lines inside a folder: by their folder anchor, else by
// the agent they belong to.
export function siloDoneInFolder(done: readonly SiloDoneItem[], folder: string, agentIds: ReadonlySet<string>): SiloDoneItem[] {
  return done.filter((d) => (d.folder ? inFolder(folder, d.folder) : d.agentId !== undefined && agentIds.has(d.agentId)))
}
export function scopeToFolder(input: HomeInput, folder: string, masterId: string): HomeInput {
  const agents: AgentView[] = []
  for (const a of input.agents) {
    if (a.id === masterId) {
      const sessions = a.sessions.filter((s) => inFolder(folder, s.cwd))
      const counts = countsInFolder(a, folder)
      agents.push({ ...a, sessions, counts, sessionCount: counts.conversations + counts.runs, liveCount: sessions.filter((s) => s.live).length })
    } else if (memberOf(a, folder)) {
      agents.push(a)
    }
  }
  const ids = new Set(agents.map((a) => a.id))
  const automations = input.automations.filter((au) => ids.has(au.agentId))
  const autoIds = new Set(automations.map((au) => au.id))
  return {
    agents,
    cards: input.cards.filter((c) => inFolder(folder, c.cwd)),
    needsYou: input.needsYou.filter((n) =>
      n.kind === 'silo' ? (n.folder ? inFolder(folder, n.folder) : n.agentId !== undefined && ids.has(n.agentId)) : ids.has(n.agentId),
    ),
    pending: input.pending.filter((r) => autoIds.has(r.automationId)),
    automations,
  }
}

// The line under Needs you after a Done/Drop handed work to agents — one
// sentence per agent, and the plain truth about whether it will move.
export function handoffWords(h: readonly PlanHandoff[]): { agentId: string; text: string; open: boolean }[] {
  const by = new Map<string, PlanHandoff[]>()
  for (const x of h) by.set(x.agentId, [...(by.get(x.agentId) ?? []), x])
  return [...by.values()].map((xs) => {
    const a = xs[0]!
    const what = xs.length === 1 ? `“${a.title}”` : `${xs.length} tasks`
    const move = a.wakes === 'task' ? `${a.agentName} starts on it now — it is On its own.` : `${a.agentName} is Only when told — open it on it to continue.`
    return { agentId: a.agentId, text: `Unblocked for ${a.agentName}: ${what}. ${move}`, open: a.wakes === 'never' }
  })
}
