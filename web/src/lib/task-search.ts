// task-search.ts — ⌘K finds tasks (handing out work starts by finding the
// thing). A pure search over the tasks
// the web already holds: by title, by its reference or its label (plan#id,
// <project>#id) or #id, and the operators that map onto views
// that exist — is:stalled, is:mine, is:idle (ready, nobody on it), owner:<agent>.
// Nothing else: no priority:, no label:, because a task has neither.
//
// Ranking: the exact reference, then #id, then a title's start, a word's start,
// anywhere in the title, then the reference or the plan's name; open work
// before finished. Accents never matter («cafe» finds «Café»).
import type { TasksQuery } from './routes'
import { byActivity, inPreset, isYou, YOU_FACET, type PresetContext, type TaskView } from './tasks'
import { isFinished } from './team-plan'
import type { AgentView } from './types'

const fold = (s: string): string => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()

export interface TaskOperators {
  stalled: boolean
  mine: boolean
  idle: boolean
  owner: string | null // as typed
  text: string // what is left, to match against titles
}

export function parseTaskOperators(raw: string): TaskOperators {
  const out: TaskOperators = { stalled: false, mine: false, idle: false, owner: null, text: '' }
  const rest: string[] = []
  for (const word of raw.trim().split(/\s+/).filter(Boolean)) {
    const low = word.toLowerCase()
    if (low === 'is:untouched') out.stalled = true
    else if (low === 'is:mine') out.mine = true
    else if (low === 'is:idle') out.idle = true
    else if (low.startsWith('owner:') && low.length > 'owner:'.length) out.owner = word.slice('owner:'.length)
    else rest.push(word)
  }
  out.text = rest.join(' ')
  return out
}

export const hasOperators = (o: TaskOperators): boolean => o.stalled || o.mine || o.idle || o.owner !== null

// owner:<x> → the agent facet's value: an agent by id or name, its start if
// only one fits; me/you → the owner; null when nobody fits (nothing is guessed)
export function resolveOwner(name: string, agents: readonly AgentView[]): string | null {
  const n = fold(name)
  if (n === 'me' || n === 'you') return YOU_FACET
  const exact = agents.find((a) => fold(a.id) === n || fold(a.name) === n)
  if (exact) return exact.id
  const starts = agents.filter((a) => fold(a.id).startsWith(n) || fold(a.name).startsWith(n))
  return starts.length === 1 ? starts[0]!.id : null
}

// how well a task answers the text: lower is better, null is no answer
export function taskRank(t: Pick<TaskView, 'id' | 'ref' | 'title' | 'planTitle'> & { label?: string }, rawText: string): number | null {
  const q = fold(rawText.trim())
  if (q === '') return null
  const ref = fold(t.ref)
  const label = fold(t.label ?? t.ref)
  if (ref === q || label === q) return 0
  if (q === `#${fold(t.id)}`) return 1
  if (q.includes('#') && (ref.startsWith(q) || label.startsWith(q))) return 2
  const title = fold(t.title)
  if (title.startsWith(q)) return 3
  if (title.split(/[^\p{L}\p{N}]+/u).some((w) => w.startsWith(q))) return 4
  if (title.includes(q)) return 5
  if (ref.includes(q) || label.includes(q) || fold(t.planTitle).includes(q)) return 6
  const words = q.split(/\s+/)
  return words.length > 1 && words.every((w) => title.includes(w)) ? 7 : null
}

export interface TaskSearchResult {
  // the operators' view, as an address — only when no free text narrows it
  // further (a URL can say the operators, not the words)
  view: { query: TasksQuery; words: string } | null
  tasks: TaskView[]
}

function viewOf(o: TaskOperators, ownerValue: string | null, agents: readonly AgentView[]): { query: TasksQuery; words: string } {
  const view = o.idle ? 'idle' : o.stalled ? 'untouched' : o.mine ? 'mine' : 'open'
  const agent = ownerValue ?? (o.stalled && o.mine ? YOU_FACET : null)
  const who = agent === YOU_FACET ? 'Your' : agent ? `${agents.find((a) => a.id === agent)?.name ?? agent}'s` : o.mine ? 'Your' : null
  const what = o.idle ? 'tasks not started, nobody on them' : o.stalled ? 'untouched tasks' : 'open tasks'
  return { query: { view, ...(agent ? { agent: [agent] } : {}) }, words: who ? `${who} ${what}` : `All ${what}` }
}

export function searchTasks(all: readonly TaskView[], raw: string, ctx: PresetContext, agents: readonly AgentView[], now: number): TaskSearchResult {
  const o = parseTaskOperators(raw)
  const ops = hasOperators(o)
  const ownerValue = o.owner !== null ? resolveOwner(o.owner, agents) : null
  // an owner nobody fits answers nothing, rather than every task
  if (o.owner !== null && ownerValue === null) return { view: null, tasks: [] }
  const base = ops
    ? all.filter((t) => {
        if (o.stalled && !inPreset(t, 'untouched', ctx)) return false
        if (o.mine && !inPreset(t, 'mine', ctx)) return false
        if (o.idle && !inPreset(t, 'idle', ctx)) return false
        if (ownerValue === YOU_FACET ? !isYou(t.owner) : ownerValue !== null && t.owner !== ownerValue) return false
        return !isFinished(t.state)
      })
    : all
  if (o.text === '') return ops ? { view: viewOf(o, ownerValue, agents), tasks: byActivity(base, agents, now) } : { view: null, tasks: [] }
  const ranked = base.flatMap((t) => {
    const r = taskRank(t, o.text)
    return r === null ? [] : [{ t, r }]
  })
  ranked.sort((a, b) => a.r - b.r || Number(isFinished(a.t.state)) - Number(isFinished(b.t.state)) || a.t.ref.localeCompare(b.t.ref))
  return { view: null, tasks: ranked.map((x) => x.t) }
}
