// mission-review.ts — a mission proposal under review. Its row's
// «Review ›» parks the proposal here and opens the
// agent's mission; MissionHeader opens its editor preloaded with the
// proposed text and «Never» lines, the full diff above it, and its Save
// carries the proposal's id — the save resolves it. Cancel clears the park
// and the proposal stays pending. One proposal at a time, in memory: a
// reload leaves the row in Needs you, where Review opens it again.
import { useSyncExternalStore } from 'react'
import type { ProposalView } from './types'

export interface MissionReview {
  proposalId: string
  agentId: string
  reason: string
  before: { text: string; never: string[] } | null
  after: { text: string; never: string[] }
}

let current: MissionReview | null = null
const listeners = new Set<() => void>()

export function startMissionReview(p: ProposalView): MissionReview | null {
  if (p.kind !== 'mission' || !p.mission) return null
  current = { proposalId: p.id, agentId: p.by, reason: p.reason, before: p.mission.before, after: p.mission.after }
  for (const l of listeners) l()
  return current
}

export function endMissionReview(): void {
  if (current === null) return
  current = null
  for (const l of listeners) l()
}

export function useMissionReview(agentId: string): MissionReview | null {
  const r = useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => {
        listeners.delete(cb)
      }
    },
    () => current,
  )
  return r && r.agentId === agentId ? r : null
}

/** Line-level diff of a «Never» list: what stays, goes, comes. */
export function neverDiff(before: readonly string[], after: readonly string[]): Array<{ line: string; change: 'same' | 'removed' | 'added' }> {
  const out: Array<{ line: string; change: 'same' | 'removed' | 'added' }> = []
  for (const l of before) out.push({ line: l, change: after.includes(l) ? 'same' : 'removed' })
  for (const l of after) if (!before.includes(l)) out.push({ line: l, change: 'added' })
  return out
}
