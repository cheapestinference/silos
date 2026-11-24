// beat-home.ts — the old check-in's one home: its own automation page
// (/automation/auto-resp-<id> — its runs, Pause and Run now live there).
// (The «In charge of» card it used to open is gone;
// its rhythm is set on the agent's Now, the control block's Heartbeat row.) Every door to a check-in goes through here so it never drifts.
//
// A beat is a door only while its agent is IN PLAY — listed by the web and
// not archived: an archived agent's beat is kept
// auto-paused by design and the store doesn't list the agent, so a door to
// its home selected an agent nobody has (and the agent page once
// fell back to a chat that started a real console for it). Every surface
// asks beatHomeOpen first and names the beat honestly when it is not.
import { useStore } from '../store'
import type { AgentView } from './types'

/** Is the agent in play — known to the web and not archived? */
export function agentInPlay(agents: readonly Pick<AgentView, 'id' | 'archived'>[], agentId: string): boolean {
  return agents.some((a) => a.id === agentId && !a.archived)
}

/** Does a beat of this agent have a home to open? */
export function beatHomeOpen(agentId: string, agents: readonly Pick<AgentView, 'id' | 'archived'>[] = useStore.getState().agents): boolean {
  return agentInPlay(agents, agentId)
}

/** The plain words for a beat whose agent is out of play. */
export const PAUSED_BEAT_WORDS = 'archived — its heartbeat stopped'

/** The automation id of an agent's heartbeat (server heartbeat.ts). */
export const checkInId = (agentId: string): string => `heartbeat-${agentId}`

export function openCheckIn(agentId: string): void {
  const st = useStore.getState()
  // never open a check-in of an agent the web doesn't have: the door is not
  // offered for one (beatHomeOpen), and a stale caller lands nowhere new
  if (!beatHomeOpen(agentId, st.agents)) return
  st.changePage({ kind: 'automation', id: checkInId(agentId) })
}
