// turn-pulse.ts — what the WS stream says of every engine turn, by turnId:
// its last tool, when it last said
// anything, how it ended. The server already emits chat-* for every turn it
// runs (the owner's chats, Task mode's wakes, the chat door); the live line
// reads this beside the server's facts — it never asks the server again for
// what the stream already told.
import type { ChatEvent } from '../store/helpers'
import type { TurnPulse } from '../store/state'

// a pulse nobody spoke of for this long is history: dropped at the next event
export const PULSE_KEEP_MS = 15 * 60_000
export const PULSE_MAX = 200
// what a pulse keeps of the turn's text (a first reply, never a transcript)
export const PULSE_SAID_MAX = 4000

export function pulseOf(prev: Readonly<Record<string, TurnPulse>>, ev: ChatEvent, now: number): Record<string, TurnPulse> {
  const old = prev[ev.turnId]
  let next: TurnPulse
  const said = old?.said !== undefined ? { said: old.said } : {}
  switch (ev.ev) {
    case 'chat-tool':
      next = { tool: ev.name, lastAt: now, ...said }
      break
    case 'chat-done':
      next = {
        ...said,
        tool: old?.tool ?? null,
        lastAt: now,
        ended: ev.subtype.startsWith('error') ? 'error' : 'done',
        ...(ev.subtype.startsWith('error') ? { error: ev.subtype } : {}),
      }
      break
    case 'chat-error':
      next = { ...said, tool: old?.tool ?? null, lastAt: now, ended: 'error', error: ev.error }
      break
    case 'chat-delta':
      if (ev.text === '') return prev as Record<string, TurnPulse>
      next = { tool: old?.tool ?? null, lastAt: now, said: ((old?.said ?? '') + ev.text).slice(0, PULSE_SAID_MAX) }
      break
    case 'chat-thinking':
      if (ev.text === '') return prev as Record<string, TurnPulse>
      next = { tool: old?.tool ?? null, lastAt: now, ...said }
      break
    case 'chat-usage':
      if (ev.outputTokens <= 0) return prev as Record<string, TurnPulse>
      next = { tool: old?.tool ?? null, lastAt: now, ...said }
      break
    // init / rate limit: the turn exists, it has not said anything yet
    default:
      if (old) return prev as Record<string, TurnPulse>
      next = { tool: null, lastAt: 0 }
      break
  }
  const out: Record<string, TurnPulse> = {}
  const kept = Object.entries(prev)
    .filter(([id, p]) => id !== ev.turnId && (p.lastAt === 0 || now - p.lastAt < PULSE_KEEP_MS))
    .slice(-(PULSE_MAX - 1))
  for (const [id, p] of kept) out[id] = p
  out[ev.turnId] = next
  return out
}
