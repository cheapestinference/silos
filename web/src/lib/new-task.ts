// «New task» outside /tasks: the words a door hands
// to the ONE dialog (components/tasks/GiveDialog.tsx) — never a second way
// to create. ⌘K reads «new task: <title> @agent»; the agent page hands its own
// id. Pure: the palette, the dialog and the tests share it.
import type { AgentView } from './types'
import { resolveOwner } from './task-search'
import { standingKeyOf, YOU_FACET, type TaskView } from './tasks'
import { territoriesOf } from './territory'
import { basename } from './routes'
import { isFinished } from './team-plan'

export interface TaskDraft {
  title: string
  // an agent id, 'owner' for you, or null when nobody was named
  owner: string | null
}

// «new task», «new task:», «New Task: ship it @finance» — the verb first, the
// title after; one @word names the owner (resolved like owner:, nothing
// guessed: an @word that fits nobody stays in the title as typed)
export function parseNewTask(raw: string, agents: readonly AgentView[]): TaskDraft | null {
  const m = /^\s*new\s+task\b\s*:?\s*(.*)$/is.exec(raw)
  if (!m) return null
  let owner: string | null = null
  const words: string[] = []
  for (const word of (m[1] ?? '').split(/\s+/).filter(Boolean)) {
    if (owner === null && word.startsWith('@') && word.length > 1) {
      const who = resolveOwner(word.slice(1), agents)
      if (who !== null) {
        owner = who === YOU_FACET ? 'owner' : who
        continue
      }
    }
    words.push(word)
  }
  return { title: words.join(' '), owner }
}

// ── where the task lands (a task never needs a
// plan). The dialog asks WHAT and WHO; the project derives from the owner —
// an agent's task lives in its own folder(s), yours in a project you pick —
// and the plan is a folded default: the project's list (made on
// create when it is not there yet), a named plan only when chosen or when New
// task opened from it. Never a finished plan, never another project's.

// the projects a task for `owner` may live in: an agent's territories
// (primary first); for you (or a person), every in-play agent's
type Agentish = Pick<AgentView, 'id' | 'folder' | 'folders' | 'archived'>
export function projectsFor(owner: string, agents: readonly Agentish[]): string[] {
  const inPlay = agents.filter((a) => !a.archived)
  const a = inPlay.find((x) => x.id === owner)
  if (a) return territoriesOf(a)
  return [...new Set(inPlay.flatMap((x) => territoriesOf(x)))].sort((x, y) => basename(x).localeCompare(basename(y)))
}

// `standingList` as taskOfRow reads it (the server's word, the reserved id
// as the fallback); absent here → the reserved id decides
type TaskLite = Pick<TaskView, 'planKey' | 'planTitle' | 'folder' | 'owner' | 'state' | 'standingList'>

// the project a task of YOURS lands in (an agent's lands in its primary
// folder — the dialog's rule): the last project you used when it is still
// offered, else the one holding most of your open tasks, else the first
export function defaultProject(owner: string, projects: readonly string[], tasks: readonly TaskLite[], lastUsed: string | null): string {
  if (projects.length === 0) return ''
  if (lastUsed && projects.includes(lastUsed)) return lastUsed
  const counts = new Map<string, number>()
  for (const t of tasks)
    if (t.owner === owner && t.folder && !isFinished(t.state) && projects.includes(t.folder)) counts.set(t.folder, (counts.get(t.folder) ?? 0) + 1)
  const busiest = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]
  return busiest ? busiest[0] : projects[0]!
}

export interface PlanChoice {
  planKey: string
  title: string // '' for the project's list — it has no name in the UI
  standing: boolean
  mine: number // the owner's open tasks in it
}

// The plans a task in `folder` may join: the project's list first
// (always offered — it is made on create), then its OPEN named plans (a plan
// whose every task is finished is never offered). Another project's plans
// never appear.
export function planChoices(tasks: readonly TaskLite[], folder: string, owner: string): PlanChoice[] {
  const plans = new Map<string, { title: string; standing: boolean; open: number; mine: number }>()
  for (const t of tasks) {
    if (t.folder !== folder) continue
    let p = plans.get(t.planKey)
    if (!p) plans.set(t.planKey, (p = { title: t.planTitle, standing: t.standingList, open: 0, mine: 0 }))
    if (isFinished(t.state)) continue
    p.open += 1
    if (t.owner === owner) p.mine += 1
  }
  const standing = standingKeyOf(folder)
  const named = [...plans.entries()]
    .filter(([, p]) => !p.standing && p.open > 0)
    .map(([planKey, p]) => ({ planKey, title: p.title, standing: false, mine: p.mine }))
    .sort((a, b) => a.title.localeCompare(b.title))
  return [{ planKey: standing, title: '', standing: true, mine: plans.get(standing)?.mine ?? 0 }, ...named]
}

// the folded default is ALWAYS the project's list (guessing the owner's
// busiest plan put loose tasks into named plans);
// a named plan only when New task was opened from that plan, or picked
export function defaultPlan(choices: readonly PlanChoice[], openedFrom?: string | null): string {
  if (openedFrom && choices.some((c) => c.planKey === openedFrom)) return openedFrom
  return choices.find((c) => c.standing)?.planKey ?? ''
}

// a named plan's id in its project, from its key (`folder:<project>/<plan>`)
// — what POST /api/tasks/new names (the server assigns the task's id —
// the web never computes one)
export function planIdOf(planKey: string, folder: string): string {
  const prefix = `folder:${folder}/`
  return planKey.startsWith(prefix) ? planKey.slice(prefix.length) : planKey.slice(planKey.lastIndexOf('/') + 1)
}

// «For: X ▾»: who a new task is for when the door
// named nobody — the agent you gave to last (still in play), else the only
// agent, else the house's default agent, else the first; with no agent, you.
// A door that names someone (an agent page, ⌘K «@agent», «you») wins.
export function giveFor(o: {
  named: string | null | undefined
  last: string | null
  agents: readonly Pick<AgentView, 'id' | 'folder' | 'archived' | 'default'>[]
}): string {
  if (o.named) return o.named
  const inPlay = o.agents.filter((a) => !a.archived && a.folder)
  if (o.last && inPlay.some((a) => a.id === o.last)) return o.last
  return (inPlay.find((a) => a.default) ?? inPlay[0])?.id ?? 'owner'
}
