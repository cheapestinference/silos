// first-meeting.ts — the agent just created, in this tab: its page opens
// on the proof of life — «<Name> is reading its
// mission…», the card of what it understood, then «What should <Name> do
// first?». A per-tab fact (a reload lands on the plain page), so a tiny
// store of its own, not the app's.
import { useSyncExternalStore } from 'react'

export interface FirstMeeting {
  agentId: string
  // the territory that could not be turned on at birth (the create's warn): the
  // agent stays Only when told and the card says so, with its door
  warn?: string
  // a folder whose starting set could not be written at birth (the
  // create's startWarn, starting-set.ts): what loads there instead, said
  // with the door to the project's Tools
  startWarn?: string
  // the attended chat turn reading the mission, once sent
  turnId?: string
  // why that turn could not start
  failed?: string
}

let current: FirstMeeting | null = null
const listeners = new Set<() => void>()
const emit = (): void => {
  for (const l of listeners) l()
}

export function startFirstMeeting(m: FirstMeeting): void {
  current = m
  emit()
}
export function updateFirstMeeting(patch: Partial<FirstMeeting>): void {
  if (current) {
    current = { ...current, ...patch }
    emit()
  }
}
export function endFirstMeeting(): void {
  current = null
  emit()
}
export function firstMeetingNow(): FirstMeeting | null {
  return current
}

export function useFirstMeeting(agentId: string): FirstMeeting | null {
  const m = useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => {
        listeners.delete(l)
      }
    },
    () => current,
  )
  return m && m.agentId === agentId ? m : null
}

/** The turn's ask: what it will look after and what it won't, in two
 *  lines — painted as it comes back, never parsed into a decision (m7). */
export const FIRST_READ_PROMPT =
  'You were just created in Silos. Read your mission in your instructions and tell me, in two short lines and nothing else: "I\'ll look after: …" and "I won\'t: …".'
