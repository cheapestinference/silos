// loads-check-view.ts — the words of «Check now» and «See what it sends»
// on a project's Tools (GET/POST /api/folders/:folder/loads/check, server
// loads-check.ts). Pure: the screen only lays them out.
import type { FolderLoads, LoadsCheckRun, LoadsCheckTarget } from './types'
import { relTime } from './rel-time'

/** The login a button names: its email when known, else its provider's name. */
export const loginName = (t: LoadsCheckTarget): string => t.login ?? t.label

/** «5 connected · 1 didn't start · 14 need your sign-in» — the worst first. */
export function countsWords(c: LoadsCheckRun['counts']): string {
  if (!c) return ''
  const total = c.connected + c.failed + c.needsAuth + c.other
  if (total === 0) return 'no server here'
  return [
    c.failed ? `${c.failed} didn’t start` : '',
    c.needsAuth ? `${c.needsAuth} ${c.needsAuth === 1 ? 'needs' : 'need'} your sign-in` : '',
    c.connected ? `${c.connected} connected` : '',
    c.other ? `${c.other} still connecting or off` : '',
  ]
    .filter(Boolean)
    .join(' · ')
}

/** The line under the button: when it last ran and what it found. */
export function lastWords(t: LoadsCheckTarget, now: number): string {
  const last = t.last
  if (!last || last.withoutLocal) return 'never checked here'
  const found = countsWords(last.counts)
  return [`checked ${relTime(last.at, now)}`, found, last.incomplete ? 'some were still connecting at 20 s' : ''].filter(Boolean).join(' · ')
}

/** While it runs: what it is doing now, by the seconds it has run. */
export function runningWords(seconds: number, withoutLocal: boolean): string {
  if (withoutLocal) return seconds < 2 ? 'starting Claude without this project’s local settings' : 'asking what your Claude account sends'
  return seconds < 2 ? 'starting Claude in this folder' : seconds < 6 ? 'dialing every server once' : 'waiting for the last ones to answer'
}

/** The logins whose account group is off here with nothing to list: their
 *  account sends things, this folder doesn't fetch them, and no row of the
 *  inventory is that login's. */
export function sendsOffers(targets: LoadsCheckTarget[], loads: FolderLoads | null): LoadsCheckTarget[] {
  return targets.filter(
    (t) => t.account && !t.sendsHere && !(loads?.rows ?? []).some((r) => r.origin.owner === 'account' && (t.login === null || r.origin.login === t.login)),
  )
}

/** What a login sends, once a reading said it: «sends 4 connectors — Drive, Gmail, …». */
export function sendsWords(connectors: string[]): string {
  if (connectors.length === 0) return 'sends no connector'
  const names = connectors.map((n) => (n.startsWith('claude.ai ') ? n.slice('claude.ai '.length) : n))
  const shown = names.slice(0, 4).join(', ')
  return `sends ${connectors.length} ${connectors.length === 1 ? 'connector' : 'connectors'} — ${shown}${names.length > 4 ? `, +${names.length - 4}` : ''}`
}
