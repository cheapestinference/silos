// task-origin.ts — a task's page remembers where you came from (dispatching
// 13 decisions is not 26 round trips).
// The origin rides the URL (lib/routes.ts TaskOrigin, it survives a refresh);
// from it come the back link's words and the list previous/next walk — always
// recomputed from the truth (the plans' reading, the server's inbox), never a
// remembered snapshot of what the row list said.
import { MASTER_ID } from './constants'
import { applyFilter } from './facets'
import { isWaiting, scopeInbox, scopeToFolder } from './home'
import { groupPlans, isTaskRow } from './home-projects'
import { basename, type TaskOrigin, type TasksQuery } from './routes'
import {
  TASK_PRESETS,
  boardColumns,
  byActivity,
  chainFacts,
  filterOfQuery,
  inPreset,
  ownerSessionIds,
  readBlocked,
  siblingsOf,
  taskFacets,
  taskTree,
  YOU_FACET,
  type TaskLayout,
  type TaskView,
  type TreeNode,
} from './tasks'
import type { AgentView, InboxRow } from './types'

// ── the words ─────────────────────────────────────────────────────────────

export interface OriginNames {
  agent: (id: string) => string | undefined
  plan: (key: string) => string | undefined
  silo: (id: string) => string | undefined
  conversation: (folder: string, id: string) => string | undefined
}

function viewWords(q: TasksQuery, names: OriginNames): string {
  const parts = ['Tasks']
  const preset = TASK_PRESETS.find((p) => p.id === q.view)
  if (preset) parts.push(preset.label)
  for (const a of q.agent ?? []) parts.push(a === YOU_FACET ? 'You' : (names.agent(a) ?? a))
  for (const f of q.project ?? []) parts.push(f ? basename(f) : 'outside projects')
  for (const p of q.plan ?? []) parts.push(names.plan(p) ?? 'one plan')
  return parts.join(' · ')
}

// what the back link says. No origin: the plain way back, Tasks.
export function originWords(o: TaskOrigin | undefined, names: OriginNames): string {
  switch (o?.kind) {
    case undefined:
      return 'Tasks'
    case 'needs-you':
      return 'Needs you'
    case 'yours':
      return 'Yours to do'
    case 'tasks':
      return viewWords(o.query, names)
    case 'org':
      return 'Org'
    case 'silo':
      return names.silo(o.id) ?? o.id
    case 'conversation':
      return names.conversation(o.folder, o.id) ?? 'Conversation'
  }
}

// ── the list it came from ─────────────────────────────────────────────────

// A view's tasks in the order its layout draws them: last activity, the Board's
// columns left to right, the tree's depth first
export function drawnOrder(shown: TaskView[], layout: TaskLayout | undefined, all: readonly TaskView[], agents: readonly AgentView[], now: number): TaskView[] {
  if (layout === 'board') {
    const facts = chainFacts(agents, now)
    return boardColumns(shown, (t) => readBlocked(t, siblingsOf(all, t.planKey), facts)).flatMap((c) => c.tasks)
  }
  if (layout === 'tree') {
    const depthFirst = (nodes: readonly TreeNode[]): TaskView[] => nodes.flatMap((n) => [n.task, ...depthFirst(n.children)])
    return taskTree(shown).flatMap((p) => [...depthFirst(p.loose), ...p.plans.flatMap((plan) => depthFirst(plan.nodes))])
  }
  return shown
}

export function viewTasks(all: readonly TaskView[], q: TasksQuery, agents: readonly AgentView[], now: number): TaskView[] {
  const ctx = { agentIds: new Set(agents.map((a) => a.id)), ownerSessions: ownerSessionIds(agents) }
  const preset = q.view ?? 'mine'
  const shown = byActivity(
    applyFilter(
      all.filter((t) => inPreset(t, preset, ctx)),
      taskFacets(agents),
      filterOfQuery(q),
    ),
    agents,
    now,
  )
  return drawnOrder(shown, q.layout, all, agents, now)
}

// the task key a row of the inbox opens, if it opens one (a plan's task, an
// escalated one)
export function inboxTaskKey(r: InboxRow): string | null {
  if (r.kind === 'waitsOnRelay') return r.task.key // its door is the task
  return r.kind === 'silo' && r.item.key.lastIndexOf('/tasks/') > 0 ? r.item.key : null
}

// what Home's two lists hold, on Home or on a project's Now, in their order
function inboxKeys(kind: 'needs-you' | 'yours', folder: string | undefined, rows: readonly InboxRow[], agents: readonly AgentView[]): string[] {
  let scoped = rows
  if (folder !== undefined) {
    const members = scopeToFolder({ agents: [...agents], cards: [], needsYou: [], pending: [], automations: [] }, folder, MASTER_ID).agents
    scoped = scopeInbox(rows, folder, new Set(members.map((a) => a.id)), MASTER_ID)
  }
  if (kind === 'needs-you') return scoped.filter(isWaiting).flatMap((r) => inboxTaskKey(r) ?? [])
  return groupPlans(scoped.filter((r) => !isWaiting(r)).filter(isTaskRow)).flatMap((g) => g.tasks.map((t) => t.item.key))
}

export interface OriginSources {
  all: readonly TaskView[]
  // the server's inbox; null until it is read
  inbox: readonly InboxRow[] | null
  agents: readonly AgentView[]
  now: number
}

// The keys of the tasks previous/next walk, or null when the origin is not a
// list (Org, a silo's page, a conversation) or its list is not read yet.
export function originList(o: TaskOrigin | undefined, s: OriginSources): string[] | null {
  switch (o?.kind) {
    case 'tasks':
      return viewTasks(s.all, o.query, s.agents, s.now).map((t) => t.key)
    case 'needs-you':
    case 'yours':
      return s.inbox ? inboxKeys(o.kind, o.folder, s.inbox, s.agents) : null
    default:
      return null
  }
}

export const originReadsInbox = (o: TaskOrigin | undefined): boolean => o?.kind === 'needs-you' || o?.kind === 'yours'

export interface Neighbours {
  index: number
  total: number
  prev: string | null
  next: string | null
}

// where a task stands in its list; null when it is not in it (it was just
// finished, or a hop to a related task left the list): nothing to count
export function neighbours(list: readonly string[] | null, key: string): Neighbours | null {
  if (!list) return null
  const index = list.indexOf(key)
  if (index < 0) return null
  return { index, total: list.length, prev: list[index - 1] ?? null, next: list[index + 1] ?? null }
}

// a task's page from its record key (<plan key>/tasks/<id>)
export function taskPageOfKey(key: string): { kind: 'task'; plan: string; task: string } | null {
  const cut = key.lastIndexOf('/tasks/')
  return cut > 0 ? { kind: 'task', plan: key.slice(0, cut), task: key.slice(cut + '/tasks/'.length) } : null
}
