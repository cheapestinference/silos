// active-trim.ts — a live transcript with no echo (a message getting
// visibly sent twice). During one's own turn, refetchDelta keeps painting
// turns as they get persisted to the JSONL, but the streaming block
// (`active`) accumulates ALL of the turn's text/tools — the same content
// stayed visible twice until chat-done. userTextPersisted already solved
// this for the user's bubble; this function generalizes it: it computes
// how much of the active block is ALREADY persisted, so the render only
// shows the pending tail.
//
// a FULL computation on every refetch (not incremental over the new ones):
// if a refetch lands a turn whose deltas hadn't arrived over WS yet (an
// 80ms-batch-vs-fetch race), the prefix doesn't match and less gets
// trimmed — the next refetch recomputes from scratch and self-heals.
// Always conservative: on any misalignment, trimming stops (duplicating an
// instant is ugly; eating un-persisted text would be a lie).
import { stripAgentContext } from './agent-context'
import type { Turn } from './types'

export interface ActiveTrim {
  chars: number // the prefix of active.text already persisted — the render omits it
  tools: number // the number of active.tools chips already persisted as turns
  echoed: boolean // the active turn's userText is already persisted (the optimistic bubble is hidden)
}

export const NO_TRIM: ActiveTrim = { chars: 0, tools: 0, echoed: false }

export function activeTrim(turns: readonly Turn[], userText: string, text: string): ActiveTrim {
  // the active turn's echo = the LAST real user turn (peer interSession
  // ones don't count) — if it doesn't match userText, whatever got
  // persisted after it belongs to ANOTHER exchange and nothing gets trimmed.
  let echoIndex = -1
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i]!
    if (t.role !== 'user' || t.interSession) continue
    if (stripAgentContext(t.text) === stripAgentContext(userText)) echoIndex = i
    break
  }
  if (echoIndex < 0) return NO_TRIM

  let chars = 0
  let tools = 0
  for (let i = echoIndex + 1; i < turns.length; i++) {
    const t = turns[i]!
    if (t.interSession) continue
    if (t.role !== 'assistant') break
    if (t.text.trim() === '') {
      // a tools-only turn (or a receipt marker, empty tools): live chips
      // match by POSITION, not by name — the server resolves names
      // ("skill:…") the raw WS event doesn't know about.
      tools += t.tools.length
      continue
    }
    // a text turn: it must match as a prefix of what's been streamed,
    // tolerating whitespace between messages (deltas concatenate with no
    // reliable separator).
    while (chars < text.length && /\s/.test(text[chars]!)) chars++
    const body = t.text.trim()
    if (!text.startsWith(body, chars)) break
    chars += body.length
  }
  return { chars, tools, echoed: true }
}
