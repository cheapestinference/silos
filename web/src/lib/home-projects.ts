// Home by project (a Home mixing every project without context, in very
// long lists, reads as noise). Needs you stays one list on top —
// urgency outranks place — but everything else is said INSIDE its project:
// the project's agents (the fleet rows) and what is yours in its plans,
// one row per PLAN (not per task: the fiscal plan alone was 5 rows), a few
// plans in view and the rest folded. Pure derivations; HomePage paints.

import { basename } from './routes'
import type { FleetRow } from './home'
import type { AgentView, InboxRow as InboxItem } from './types'

// A row of yours that is a TASK of something bigger — a sub-kind's row of
// an active silo (a plan's task: `parent` set, server silos/surfaces.ts).
// Grouped by what it belongs to, never one row each (the plans silo is
// built in; there is no native plan row).
export type TaskItem = Extract<InboxItem, { kind: 'silo' }> & { item: { parent: NonNullable<Extract<InboxItem, { kind: 'silo' }>['item']['parent']> } }

export function isTaskRow(i: InboxItem): i is TaskItem {
  return i.kind === 'silo' && i.item.parent !== undefined
}

// what a task row says of itself: its own title, the file it lives in (the
// row opens it), the group it belongs to and that group's moment
export function taskTitle(i: TaskItem): string {
  return i.item.identity ?? i.item.text
}
export function taskFile(i: TaskItem): string | null {
  return i.item.file
}

// its reference — what the row says beside its title (the plan's name rides
// the tooltip and the page): `<plan>#t3`, or `<project>#t3` on the project's
// list, never the file's `tasks#t3`; null when the key is
// not a plan task's. A label the reading holds wins (lib/tasks.ts labelOfKey).
export function taskRefOf(i: TaskItem): string | null {
  const page = taskPageOf(i)
  if (!page) return null
  const folder = i.item.folder ?? null
  return isStandingParent(i) && folder ? `${basename(folder)}#${page.task}` : `${page.plan.slice(page.plan.lastIndexOf('/') + 1)}#${page.task}`
}

// the task's own page (Needs you's plan-task rows «open
// task»): its parent's key + its id — the record key is
// <parent key>/<collection>/<id>; null when the key does not say so
export function taskPageOf(i: TaskItem): { kind: 'task'; plan: string; task: string } | null {
  const p = i.item.parent.key
  if (!i.item.key.startsWith(`${p}/`)) return null
  const rest = i.item.key.slice(p.length + 1).split('/')
  return rest.length === 2 && rest[1] ? { kind: 'task', plan: p, task: rest[1] } : null
}

// the row's parent is its project's list: the server says it
export function isStandingParent(i: TaskItem): boolean {
  return i.item.parent.standingList === true
}

export interface PlanGroup {
  key: string // the parent record's key
  folder: string
  file: string | null // the file the group opens (the plan)
  kind: string // the parent's kind in the house's words: 'plan'
  title: string // '' for the project's list — it has no name on screen
  // the project's list: no plan — its tasks are said straight
  // under the project, never as a plan row, and never counted as a plan
  standing: boolean
  updatedAt: number | null
  tasks: TaskItem[]
}

export interface ProjectSection {
  // null = Anywhere (agents without a folder)
  folder: string | null
  name: string
  rows: FleetRow[] // the project's agents with something to say
  quiet: FleetRow[] // its agents with nothing right now
  plans: PlanGroup[] // ordered: most yours first, then most recently moved
  asks: number // Needs you rows that belong here (for ordering and the count line)
  working: number
  lastActive: number
}

// plans in view per project; the rest under one fold
export const PLANS_IN_VIEW = 3
// a plan nobody moved in this long sorts last and the fold says "idle"
export const IDLE_PLAN_MS = 14 * 86_400_000

function groupOf(i: TaskItem): Omit<PlanGroup, 'tasks'> {
  const p = i.item.parent
  const t = p.at ? Date.parse(p.at) : NaN
  const standing = isStandingParent(i)
  return {
    key: p.key,
    folder: i.item.folder ?? '',
    file: i.item.file,
    kind: p.kind.split('/').pop() ?? p.kind,
    title: standing ? '' : p.identity,
    standing,
    updatedAt: Number.isNaN(t) ? null : t,
  }
}

export function groupPlans(items: readonly TaskItem[]): PlanGroup[] {
  const by = new Map<string, PlanGroup>()
  for (const i of items) {
    const head = groupOf(i)
    let g = by.get(head.key)
    if (!g) {
      g = { ...head, tasks: [] }
      by.set(head.key, g)
    }
    g.tasks.push(i)
  }
  return [...by.values()].sort((a, b) => b.tasks.length - a.tasks.length || (b.updatedAt ?? 0) - (a.updatedAt ?? 0) || a.title.localeCompare(b.title))
}

// in view vs folded: the first PLANS_IN_VIEW plans that are not idle; idle
// ones always fold (they sort after the live ones within the fold).
export function splitPlans(plans: readonly PlanGroup[], now: number): { shown: PlanGroup[]; folded: PlanGroup[]; idle: number } {
  const isIdle = (p: PlanGroup): boolean => p.updatedAt !== null && now - p.updatedAt > IDLE_PLAN_MS
  const live = plans.filter((p) => !isIdle(p))
  const idle = plans.filter(isIdle)
  return { shown: live.slice(0, PLANS_IN_VIEW), folded: [...live.slice(PLANS_IN_VIEW), ...idle], idle: idle.length }
}

// the project an agent lives in: its folder (Anywhere = null)
function homeOf(a: AgentView): string | null {
  return a.folder ?? null
}

// the project a Needs you row belongs to — for the eyebrow and the ordering.
// null when the row is machine-wide (an account limit, a silo summary…).
export function folderOfRow(i: InboxItem, agents: readonly AgentView[]): string | null {
  const agentFolder = (id: string | undefined): string | null => (id ? (agents.find((a) => a.id === id)?.folder ?? null) : null)
  switch (i.kind) {
    case 'ask':
      return agentFolder(i.agentId) ?? i.cwd ?? null
    case 'silo':
      return i.item.folder ?? agentFolder(i.item.agentId)
    // a summary over several agents belongs to a project only when they
    // all live in the same one
    case 'siloSummary':
      return oneOf([...i.folders, ...i.agentIds.map(agentFolder)])
    // a folder's baseline names its folder
    case 'plansBaseline':
      return i.folder
    // a task's plan folder; a plan's folder; the closed plans' one folder
    case 'waitsOnRelay': {
      const k = i.task.key
      const cut = k.lastIndexOf('/tasks/')
      const plan = k.startsWith('folder:') && cut > 0 ? k.slice('folder:'.length, cut) : ''
      const slash = plan.lastIndexOf('/')
      return slash > 0 ? plan.slice(0, slash) : null
    }
    case 'tasksUnreadable':
      return i.plan.folder
    // the conversation's folder, else its agent's
    case 'consoleIdle':
      return i.session.folder ?? agentFolder(i.agentId)
    case 'closedPlansOpen':
      return oneOf(i.plans.map((p) => p.folder))
    default: {
      const r = i as { agentId?: string }
      return agentFolder(r.agentId)
    }
  }
}

function oneOf(folders: readonly (string | null)[]): string | null {
  const set = new Set(folders)
  if (set.size !== 1) return null
  return [...set][0] ?? null
}

function isLiveRow(r: FleetRow): boolean {
  return (
    r.asks.length > 0 ||
    r.working.length > 0 ||
    r.nested.length > 0 ||
    r.done.length > 0 ||
    r.siloDone.length > 0 ||
    (r.agent.mission?.text ?? '').trim() !== ''
  )
}

// One section per project that has an agent or a plan of yours. Ordered by
// what deserves the eye: something waiting on you there, then work in
// motion, then the most of yours to do, then the most recent activity.
export function projectSections(input: {
  rows: readonly FleetRow[]
  planItems: readonly TaskItem[]
  waiting: readonly InboxItem[]
  agents: readonly AgentView[]
}): ProjectSection[] {
  const sections = new Map<string, ProjectSection>()
  const keyOf = (f: string | null): string => f ?? ''
  const get = (folder: string | null): ProjectSection => {
    const k = keyOf(folder)
    let s = sections.get(k)
    if (!s) {
      s = { folder, name: folder ? basename(folder) : 'Anywhere', rows: [], quiet: [], plans: [], asks: 0, working: 0, lastActive: 0 }
      sections.set(k, s)
    }
    return s
  }
  for (const r of input.rows) {
    const s = get(homeOf(r.agent))
    ;(isLiveRow(r) ? s.rows : s.quiet).push(r)
    s.working += r.working.length + r.nested.length
    s.lastActive = Math.max(s.lastActive, r.lastActive)
  }
  for (const g of groupPlans(input.planItems)) {
    // a plan lives in the project that holds it, or in the nearest one
    // above it (a plan inside a project's subfolder belongs to it)
    const owner = [...sections.values()].find((s) => s.folder !== null && (g.folder === s.folder || g.folder.startsWith(s.folder + '/')))
    const s = owner ?? get(g.folder || null)
    s.plans.push(g)
    s.lastActive = Math.max(s.lastActive, g.updatedAt ?? 0)
  }
  for (const i of input.waiting) {
    const f = folderOfRow(i, input.agents)
    const s = f === null ? undefined : sections.get(f)
    if (s) s.asks += 1
  }
  for (const s of sections.values()) {
    s.plans.sort((a, b) => b.tasks.length - a.tasks.length || (b.updatedAt ?? 0) - (a.updatedAt ?? 0) || a.title.localeCompare(b.title))
  }
  const yours = (s: ProjectSection): number => s.plans.reduce((n, p) => n + p.tasks.length, 0)
  return [...sections.values()].sort(
    (a, b) => b.asks - a.asks || b.working - a.working || yours(b) - yours(a) || b.lastActive - a.lastActive || a.name.localeCompare(b.name),
  )
}

// the named plans among a section's groups — the project's list is no plan
export function namedPlans(plans: readonly PlanGroup[]): PlanGroup[] {
  return plans.filter((p) => !p.standing)
}

// «14 to do», «… in 6 plans» only when named plans hold some (the
// project's list is no plan, so a project whose work is all loose says
// no plan count at all)
export function toDoWords(plans: readonly PlanGroup[]): string | null {
  const yours = plans.reduce((n, p) => n + p.tasks.length, 0)
  if (yours === 0) return null
  const named = namedPlans(plans)
  const noun = named[0]?.kind ?? 'plan'
  return `${yours} to do${named.length > 0 ? ` in ${named.length} ${noun}${named.length === 1 ? '' : 's'}` : ''}`
}

// the count line under a project's name, only what is true and non-zero:
// "1 needs you · 2 working · 14 to do in 6 plans"
export function sectionCounts(s: ProjectSection): string {
  const parts: string[] = []
  if (s.asks > 0) parts.push(`${s.asks} need${s.asks === 1 ? 's' : ''} you`)
  if (s.working > 0) parts.push(`${s.working} working`)
  const todo = toDoWords(s.plans)
  if (todo) parts.push(todo)
  return parts.join(' · ')
}
