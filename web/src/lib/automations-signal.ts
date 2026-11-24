// automations-signal.ts — ONE reading of "do this agent's automations need
// the owner?", shared by every place that shows a ⚡ for them: the glyph on
// the agent's row in the sidebar, the global Automations entry in the rail.
//
// The vocabulary is the sidebar's two-state dot (SessionDot): `needs-you`
// when a last run failed or a run waits for approval (solid), `working`
// while one runs and nothing needs the owner (blinking), null otherwise.
// Counting lives here so the two carriers can never disagree.
import type { Automation, Run } from './types'

// An agent's heartbeat (server heartbeat.ts: heartbeat-<agentId>, derived
// from its control and rhythm). The beat LEAVES every
// automations enumeration — the Automations page's list, the agent page's
// automations row on Now, and this signal — because its home is the agent's
// Now (its Control and Heartbeat rows). The id prefix
// is the one mark every surface can read (origin isn't carried everywhere a
// bare {id} is); ONE shared predicate, never scattered string checks.
export function isBeatAutomation(a: { id: string }): boolean {
  return a.id.startsWith('heartbeat-')
}

export type AutomationsState = 'needs-you' | 'working' | null

export interface AutomationsSignal {
  count: number
  failed: number
  waiting: number
  running: number
  state: AutomationsState
  // plain words for a title/aria-label: "9 automations · 1 failed, 2 running"
  label: string
}

export function automationsSignal(automations: readonly Automation[], pending: readonly Pick<Run, 'automationId'>[], agentId?: string): AutomationsSignal {
  // Beats stay out of the ⚡ too: a beat's failed runs already
  // reach Needs you as the inbox's failed-run rows, and its Heartbeat row on
  // the agent's Now says its last skip — a terracotta bolt here would be a
  // second, vaguer door to the same fact.
  const visible = automations.filter((a) => !isBeatAutomation(a))
  const mine = agentId === undefined ? visible : visible.filter((a) => a.agentId === agentId)
  const ids = new Set(mine.map((a) => a.id))
  const waiting = new Set(pending.filter((r) => ids.has(r.automationId)).map((r) => r.automationId)).size
  const failed = mine.filter((a) => a.lastRun?.status === 'failed').length
  const running = mine.filter((a) => a.lastRun?.status === 'running').length
  const state: AutomationsState = failed > 0 || waiting > 0 ? 'needs-you' : running > 0 ? 'working' : null
  const count = mine.length
  const detail = [
    failed > 0 ? `${failed} failed` : null,
    waiting > 0 ? `${waiting} waiting for your approval` : null,
    running > 0 ? `${running} running` : null,
  ].filter(Boolean)
  const head = `${count} ${count === 1 ? 'automation' : 'automations'}`
  return { count, failed, waiting, running, state, label: detail.length ? `${head} · ${detail.join(', ')}` : head }
}

// What the Automations page shows (BoardPage AutomationsTab), as data: the
// listed automations (beats never enumerate) and the agents whose beat the
// page must still name with its doors (its runs, its rhythm) — that agent's alone
// when filtered, EVERY agent's with a beat on the whole list. A Needs you row
// that stopped the beats of several agents lands on the whole list
// (inbox-destination.ts), so a beat must never vanish there (doors are
// never dead ends). `empty`: 'beats' when the only automations in
// scope are heartbeats («No automations yet» would be a lie), 'none' when
// there is truly nothing, null when something is listed.
//
// A beat is a door only while its agent is in play (`inPlay`, beat-home.ts
// beatHomeOpen): an archived — or unknown — agent's beat is kept paused by
// design and has no page to open, so it goes to `pausedBeatAgentIds`,
// named in plain words with no door ('paused' when it is all there is).
export interface AutomationsPageView<A extends { id: string; agentId: string }> {
  listed: A[]
  beatAgentIds: string[]
  pausedBeatAgentIds: string[]
  empty: 'none' | 'beats' | 'paused' | null
}
export function automationsPageView<A extends { id: string; agentId: string }>(
  all: readonly A[],
  agentId?: string,
  inPlay: (agentId: string) => boolean = () => true,
): AutomationsPageView<A> {
  const inScope = agentId === undefined ? all : all.filter((a) => a.agentId === agentId)
  const listed = inScope.filter((a) => !isBeatAutomation(a))
  const withBeat = [...new Set(inScope.filter(isBeatAutomation).map((a) => a.agentId))]
  const beatAgentIds = withBeat.filter(inPlay)
  const pausedBeatAgentIds = withBeat.filter((id) => !inPlay(id))
  const empty = listed.length > 0 ? null : beatAgentIds.length > 0 ? 'beats' : pausedBeatAgentIds.length > 0 ? 'paused' : 'none'
  return { listed, beatAgentIds, pausedBeatAgentIds, empty }
}
