// messages-view.ts — the agent page's Messages tab as data: what it received
// (its inbox) and what it sent (GET …/messages/sent), merged into ONE list
// with a direction, narrowed by the tab's filters, cut in date bands and pages.
// Pure: the component only draws what this returns.
import type { AgentMessage, AgentMessageState } from './types'

export type Direction = 'received' | 'sent'
export interface MessageRow {
  m: AgentMessage
  dir: Direction
  /** the other agent (or 'owner') */ with: string
}

export type DirFilter = 'all' | Direction
export type StateFilter = 'any' | 'open' | 'answered'
export interface MessageFilters {
  dir: DirFilter
  state: StateFilter
  with: string | null
  q: string
}
export const NO_FILTERS: MessageFilters = { dir: 'all', state: 'any', with: null, q: '' }

/** One list, newest first. A message the agent sent to itself is in both
 *  feeds — it shows once, as received. */
export function mergeMessages(agentId: string, inbox: readonly AgentMessage[], sent: readonly AgentMessage[]): MessageRow[] {
  const seen = new Set<string>()
  const rows: MessageRow[] = []
  for (const m of inbox) {
    seen.add(m.id)
    rows.push({ m, dir: 'received', with: m.from })
  }
  for (const m of sent) if (!seen.has(m.id) && m.from === agentId) rows.push({ m, dir: 'sent', with: m.to })
  return rows.sort((a, b) => b.m.at.localeCompare(a.m.at) || b.m.id.localeCompare(a.m.id))
}

/** open = not answered yet, whatever side it is on */
export const isOpen = (s: AgentMessageState): boolean => s !== 'answered'

/** what waits on the OWNER: handed to you (needs_owner), in either direction */
export const waitsOnOwner = (r: MessageRow): boolean => r.m.state === 'needs_owner'

export function applyFilters(rows: readonly MessageRow[], f: MessageFilters, nameOf: (id: string) => string): MessageRow[] {
  const q = f.q.trim().toLowerCase()
  return rows.filter(
    (r) =>
      (f.dir === 'all' || r.dir === f.dir) &&
      (f.state === 'any' || (f.state === 'open') === isOpen(r.m.state)) &&
      (f.with === null || r.with === f.with) &&
      (q === '' || r.m.text.toLowerCase().includes(q) || (r.m.answer ?? '').toLowerCase().includes(q) || nameOf(r.with).toLowerCase().includes(q)),
  )
}

/** The counts each control shows: every segment counted under the OTHER
 *  filters (so a number says what a click would leave), and the people this
 *  agent talks with, busiest first. */
export function tallies(rows: readonly MessageRow[], f: MessageFilters, nameOf: (id: string) => string) {
  const count = (g: Partial<MessageFilters>): number => applyFilters(rows, { ...f, ...g }, nameOf).length
  const people = new Map<string, number>()
  for (const r of applyFilters(rows, { ...f, with: null }, nameOf)) people.set(r.with, (people.get(r.with) ?? 0) + 1)
  return {
    dir: { all: count({ dir: 'all' }), received: count({ dir: 'received' }), sent: count({ dir: 'sent' }) },
    state: { any: count({ state: 'any' }), open: count({ state: 'open' }), answered: count({ state: 'answered' }) },
    people: [...people].map(([id, n]) => ({ id, n })).sort((a, b) => b.n - a.n || nameOf(a.id).localeCompare(nameOf(b.id))),
  }
}

/** Date bands, newest first: Today · Yesterday · This week · then one per
 *  month («November 2026»). Rows keep their order inside a band. */
export function bands(rows: readonly MessageRow[], now: number): { label: string; rows: MessageRow[] }[] {
  const day = new Date(now)
  day.setHours(0, 0, 0, 0)
  const today = day.getTime()
  const yesterday = today - 86_400_000
  const week = today - 6 * 86_400_000
  const out: { label: string; rows: MessageRow[] }[] = []
  for (const r of rows) {
    const t = Date.parse(r.m.at) || 0
    const label =
      t >= today
        ? 'Today'
        : t >= yesterday
          ? 'Yesterday'
          : t >= week
            ? 'This week'
            : new Date(t).toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
    const last = out[out.length - 1]
    if (last && last.label === label) last.rows.push(r)
    else out.push({ label, rows: [r] })
  }
  return out
}

/** where a message stands, said from this agent's side */
export function stateWord(r: MessageRow): string {
  switch (r.m.state) {
    case 'new':
      return 'unread'
    case 'read':
      return r.dir === 'sent' ? 'read, not answered' : 'read'
    case 'needs_owner':
      return 'handed to you'
    case 'answered':
      return 'answered'
  }
}

/** the one sentence under the controls: what the list below is */
export function caption(shown: number, total: number, f: MessageFilters, agentName: string, nameOf: (id: string) => string): string {
  if (total === 0) return `${agentName} hasn’t sent or received a message yet.`
  const noun = f.dir === 'received' ? 'received' : f.dir === 'sent' ? 'sent' : 'sent and received'
  const parts = [
    f.state === 'open' ? 'not answered yet' : f.state === 'answered' ? 'answered' : null,
    f.with !== null ? `${f.dir === 'sent' ? 'to' : f.dir === 'received' ? 'from' : 'with'} ${nameOf(f.with)}` : null,
    f.q.trim() !== '' ? `matching “${f.q.trim()}”` : null,
  ].filter(Boolean)
  const head = shown === total ? `All ${total} messages ${agentName} ${noun}` : `${shown} of ${total} messages — ${noun}`
  return `${head}${parts.length ? `, ${parts.join(', ')}` : ''}.`
}
