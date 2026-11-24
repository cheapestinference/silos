// inbox-destination.ts — where a Needs you row about automations lands, in
// ONE place, so a door is never a dead end.
//
// The heartbeat (heartbeat-<agent>) left every automations enumeration:
// its home is the agent's Now (the control block's Heartbeat row).
// So, for the whole class of rows:
//   - a row about a beat opens the beat's home — the agent page focused on
//     responsibility (/agent/<id>/responsibility) — or, where the beat's
//     automation is the row's own subject (a failed run, a missed retry),
//     its page /automation/heartbeat-<id>, where its runs are;
//   - a row covering several automations lands where all of them are
//     visible: one agent's filtered Automations page (which names its beat
//     with its doors), or the whole list for several agents —
//     which names EVERY agent's beat with a door per agent
//     (automationsPageView), so a limit that stopped Builder's and Finance's beats
//     still shows both (inbox-destination.test.ts);
import type { Page } from '../store'
import { isBeatAutomation } from './automations-signal'
import type { InboxRow } from './types'
import { checkInId } from './beat-home'
import { taskPageOfKey } from './task-origin'

export type InboxDestination = { kind: 'page'; page: Page }
// the agent page focused on its «In charge of» card

//
// `inPlay` (beat-home.ts agentInPlay over the web's agents): a beat's home
// exists only for an agent in play — an archived or unknown agent's beat is
// paused and has no home, so it never decides a landing (the server raises
// no row for an archived agent; this keeps a stale row from opening one).
export function inboxDestination(row: InboxRow, inPlay: (agentId: string) => boolean = () => true): InboxDestination | null {
  switch (row.kind) {
    case 'failedRun':
    case 'missedRetry':
      // the automation is the row's own subject — beat or not, its page
      return { kind: 'page', page: { kind: 'automation', id: row.automation.id } }
    case 'accountLimit': {
      const autos = row.automations.filter((a) => inPlay(a.agentId))
      if (autos.length === 0) return { kind: 'page', page: { kind: 'automations' } }
      const agentIds = [...new Set(autos.map((a) => a.agentId))]
      // it stopped only a check-in: the check-in's own page
      if (autos.length > 0 && autos.every(isBeatAutomation) && agentIds.length === 1)
        return { kind: 'page', page: { kind: 'automation', id: checkInId(agentIds[0]!) } }
      if (agentIds.length === 1) return { kind: 'page', page: { kind: 'automations', agent: agentIds[0]! } }
      return { kind: 'page', page: { kind: 'automations' } }
    }
    case 'agentSummary':
      // several failing automations of one agent: its filtered list, which
      // also names its beat (BoardPage AutomationsTab); else the agent
      return row.runsOnly || !inPlay(row.agentId)
        ? { kind: 'page', page: { kind: 'automations', agent: row.agentId } }
        : { kind: 'page', page: { kind: 'agent', id: row.agentId } }
    case 'auditUnreadable': {
      // a task turn: its task's page; a run: its automation's page
      if (row.task) {
        const p = taskPageOfKey(row.task.key)
        return p ? { kind: 'page', page: p } : null
      }
      return row.automation ? { kind: 'page', page: { kind: 'automation', id: row.automation.id } } : null
    }
    case 'territoryOff':
    case 'folderRefused':
    case 'cut':
      // its control lives on its page
      return inPlay(row.agentId) ? { kind: 'page', page: { kind: 'agent', id: row.agentId } } : null
    case 'escalated':
      return inPlay(row.agentId) ? { kind: 'page', page: { kind: 'automation', id: checkInId(row.agentId) } } : null
    default:
      return null
  }
}
