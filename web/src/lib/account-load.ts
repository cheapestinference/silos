// account-load.ts — Home's "who is on my Claude subscription right now":
// the server counts every `claude`
// process from /proc; these pure builders turn its counts into one plain
// line per account in use and, unfolded, the groups behind it. Counts of
// 0 are never said; nothing running → no line at all.
import type { AccountLoad, AccountLoadEntry } from './types'

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`

// "10 consoles · 1 chat or run · 2 outside Silos (claude-mem plugin)"
export function accountLoadParts(e: AccountLoadEntry): string[] {
  const parts: string[] = []
  if (e.bySource.console > 0) parts.push(plural(e.bySource.console, 'console', 'consoles'))
  if (e.bySource.silos > 0) parts.push(plural(e.bySource.silos, 'chat or run', 'chats or runs'))
  if (e.bySource.nested > 0) parts.push(plural(e.bySource.nested, 'nested run', 'nested runs'))
  if (e.bySource.outside > 0) {
    const labels = e.outside.length === 1 ? e.outside[0]!.label : e.outside.map((o) => `${o.count} ${o.label}`).join(', ')
    parts.push(`${e.bySource.outside} outside Silos${labels ? ` (${labels})` : ''}`)
  }
  return parts
}

// One line per account in use. The machine's own login is "your Claude
// subscription" (with "now" when it is the only one in use); every other
// account is named. A scan that hit its cap says "· partial".
export function accountLoadLines(load: AccountLoad | null | undefined): Array<{ account: string; text: string }> {
  if (!load || !load.supported) return []
  const used = load.accounts.filter((a) => a.total > 0 && accountLoadParts(a).length > 0)
  const alone = used.length === 1
  const partial = load.truncated ? ' · partial' : ''
  return used.map((a) => {
    const who = a.account === 'default' ? `On your Claude subscription${alone ? ' now' : ''}` : `On ${a.account}`
    return { account: a.account, text: `${who}: ${accountLoadParts(a).join(' · ')}${partial}` }
  })
}

export interface AccountLoadGroup {
  key: string
  label: string // who: an agent's name, "Silos chats and runs", a plugin…
  what: string // the count in words: "2 consoles"
  agentId?: string // a console group opens its agent
}

// The unfolded list: consoles by agent, Silos' own chats and runs, nested
// runs, then every outside launcher by its label.
export function accountLoadGroups(e: AccountLoadEntry, agentName: (id: string) => string | null): AccountLoadGroup[] {
  const out: AccountLoadGroup[] = []
  for (const c of e.consoles) {
    const name = c.agentId ? (agentName(c.agentId) ?? c.agentId) : 'no agent'
    out.push({ key: `console:${c.agentId ?? ''}`, label: name, what: plural(c.count, 'console', 'consoles'), ...(c.agentId ? { agentId: c.agentId } : {}) })
  }
  if (e.bySource.silos > 0) out.push({ key: 'silos', label: 'Silos', what: plural(e.bySource.silos, 'chat or run', 'chats or runs') })
  if (e.bySource.nested > 0) out.push({ key: 'nested', label: 'agents’ own claude -p', what: plural(e.bySource.nested, 'nested run', 'nested runs') })
  for (const o of e.outside) out.push({ key: `outside:${o.label}`, label: o.label, what: `${o.count} outside Silos` })
  return out
}
