// unread.ts — durable unread state: lets you close the laptop and, on
// return, see what's awaiting a reply.
//
// The rule is a PURE function over REAL data (unread state is DERIVED, never
// invented): the JSONL's mtime, the role of the last conversational turn
// (parser, AccumulatorState.lastRole), and the persisted "last seen" mark
// (seen.json, SeenStore). Nothing marks it unread unless the conversation was
// actually opened.
import type { Role } from './types.js'

// RULE — a conversation is "unread" when:
//   1. the LAST conversational turn is from the AGENT (assistant): the agent
//      replied and it's the owner's turn. If the last turn is the owner's
//      (user), it's the AGENT's turn — it does NOT enter the owner's
//      "awaiting your reply" backlog.
//   2. AND there's new activity since the owner last saw it:
//        - never seen (lastSeen === null) + agent turn = unread.
//        - seen, but the JSONL changed AFTER that (mtime > lastSeen) = back
//          to unread (the agent wrote something new after the last look).
//        - seen with no changes since (lastSeen >= mtime) = up to date.
//
// `lastRole` undefined/null (session with no real turn yet) is never
// unread — there's nothing to reply to.
export function isUnread(lastRole: Role | null | undefined, mtime: number, lastSeen: number | null): boolean {
  if (lastRole !== 'assistant') return false
  if (lastSeen === null) return true
  return mtime > lastSeen
}
