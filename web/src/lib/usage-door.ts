// usage-door.ts — where «See today ›» goes: Usage
// (/usage), that agent, today. ONE function: the caps' rows and the agent's
// Measured all open the agent's day through it.
import type { Page } from '../store/types'

export function seeTodayDoor(agentId: string): Page {
  return { kind: 'usage', agent: agentId, period: 'today' }
}

/** Usage for the whole fleet — Home's Usage tile, Automations, Settings. */
export const usageDoor: Page = { kind: 'usage' }
