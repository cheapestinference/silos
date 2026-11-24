// since.ts — the words of Home's «Since …» band and of the plan's usage
// line. Pure: Home and the agent page paint from
// here, so a word is said once. The moment served: coming back to Home and
// seeing, in one sentence, what moved without you — above all what an agent
// decided alone, its Undo one touch away.
import type { Creation } from './types'

export interface HomeSince {
  from: string
  done: number
  automations: { ran: number; of: number }
  stuck: number
  decided: Creation[]
  needsYou: number
  usage: { percent: number; account: string; agents?: number } | null
  cost: { usd: number } | null
}

const DAY = 24 * 3600_000

/** The band shows after more than a day away — or whenever something was
 *  decided since the last visit: the one who opens Home every morning must
 *  see what an agent decided. */
export function sinceShows(s: HomeSince | null, now: number): boolean {
  if (!s) return false
  return s.decided.length > 0 || now - Date.parse(s.from) > DAY
}

/** «Since Tuesday» · «Since yesterday» · «Since 09:14» · «Since Nov 3». */
export function sinceWhen(from: string, now: number): string {
  const f = new Date(from)
  const n = new Date(now)
  const startOf = (d: Date): number => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const days = Math.round((startOf(n) - startOf(f)) / DAY)
  if (days <= 0) return `Since ${f.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })}`
  if (days === 1) return 'Since yesterday'
  if (days < 7) return `Since ${f.toLocaleDateString('en-US', { weekday: 'long' })}`
  return `Since ${f.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`
}

const n = (k: number, one: string, many: string): string => `${k} ${k === 1 ? one : many}`

/** Who decided, in the band's fixed words: «X decided 2 things» —
 *  with several deciders «3 agents decided 5 things». null: nothing decided. */
export function decidedWords(decided: readonly Creation[], nameOf: (id: string) => string): string | null {
  if (decided.length === 0) return null
  const who = [...new Set(decided.map((c) => c.by))]
  const things = n(decided.length, 'thing', 'things')
  return who.length === 1 ? `${nameOf(who[0]!)} decided ${things}` : `${who.length} agents decided ${things}`
}

/** «Since Tuesday: 9 done, 1 automation ran 7 times, 1 stuck, X decided 2
 *  things» — each clause only when it has something; the decided clause is
 *  returned apart: it is the band's door (its sheet, Undo per row). */
export function sinceWords(s: HomeSince, now: number, nameOf: (id: string) => string): { head: string; decided: string | null } {
  const parts: string[] = []
  if (s.done > 0) parts.push(`${s.done} done`)
  if (s.automations.ran > 0) parts.push(`${n(s.automations.of, 'automation', 'automations')} ran ${n(s.automations.ran, 'time', 'times')}`)
  if (s.stuck > 0) parts.push(`${s.stuck} stuck`)
  const decided = decidedWords(s.decided, nameOf)
  const when = sinceWhen(s.from, now)
  if (parts.length === 0 && !decided) return { head: `${when}: nothing moved.`, decided: null }
  return { head: `${when}: ${parts.join(', ')}${parts.length > 0 && decided ? ', ' : ''}`, decided }
}

/** The agent page's Measured line: the account is shared — said, never
 *  attributed to the agent: «34% of <account>'s weekly window used · shared by
 *  3 agents». */
export function agentPlanLine(percent: number, account: string, agents: number): string {
  return `${percent}% of ${account}'s weekly window used${agents > 1 ? ` · shared by ${agents} agents` : ''}`
}

/** With an API key that prices its turns: «~$2.10
 *  today» and «+ 4 unpriced» when some turns had no price row; without a
 *  price, the $ cap «applies when its provider prices turns». */
export function agentSpendLine(today: { costUsd: number; unpriced: number; priced?: boolean }): string {
  if (today.priced === false) return 'Its spend cap applies when its provider prices turns'
  return `~$${today.costUsd.toFixed(2)} today${today.unpriced > 0 ? ` + ${today.unpriced} unpriced` : ''}`
}

/** The weekly window of a plan-usage reading (the account-wide one first). */
export function weeklyPercent(windows: ReadonlyArray<{ kind: string; label: string; percent: number; windowMs: number | null }>): number | null {
  const weekly = windows.filter((w) => w.windowMs === 7 * DAY)
  const all = weekly.find((w) => w.label === 'Week' || w.kind === 'weekly_all' || w.kind === 'seven_day')
  if (all) return Math.round(all.percent)
  return weekly.length > 0 ? Math.round(Math.max(...weekly.map((w) => w.percent))) : null
}

/** «Next: Mon 09:00, X's heartbeat» — the pulse's tail when all is quiet and
 *  something is coming; null when nothing is (then «All quiet.» alone). */
export function nextWords(next: { at: number; what: string } | null, now: number): string | null {
  if (!next) return null
  const d = new Date(next.at)
  const sameDay = new Date(now).toDateString() === d.toDateString()
  const hm = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
  const day = sameDay ? 'today' : d.toLocaleDateString('en-US', { weekday: 'short' })
  return `Next: ${day} ${hm}, ${next.what}`
}
