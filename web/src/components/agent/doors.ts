// doors.ts — the agent page's doors that other surfaces open by name: one
// function per door, so a tab that moves is re-aimed in one place.
import { useStore } from '../../store'

/** The agent's Profile tab — its mission, who it is, what it runs on, its territory. */
export function openAgentSettings(agentId: string): void {
  useStore.getState().changePage({ kind: 'agent', id: agentId })
  useStore.getState().changeTab('identity')
}

/** The agent's Automations tab — what it does without you: the ladder, its
 *  heartbeat's rhythm, Proactive, its limits, its automations. */
export function openAgentControl(agentId: string): void {
  useStore.getState().changePage({ kind: 'agent', id: agentId })
  useStore.getState().changeTab('control')
}

/** The agent's Secrets tab — what of the Vault reaches it, and why. */
export function openAgentSecrets(agentId: string): void {
  useStore.getState().changePage({ kind: 'agent', id: agentId })
  useStore.getState().changeTab('vault')
}
