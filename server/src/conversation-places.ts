// conversation-places.ts — ONE conversation as a place of «Where it loads»
// (spec scopes §2, §6): which conversation a session is, and which of a
// folder's conversations keep an entry. Neutral: the index, the thread
// resolver and the owner resolver are handed in.
//
// The key is the conversation's thread ROOT, resolved by the server from
// the session id the web holds (`threadIdOf`, task-threads.ts — the one
// resolver conversation files use): a resume, a sleep and wake, a console's
// `/clear` and a branch in the same project are the same thread, so they
// read the same entries; a fork into another project is another thread.
// The web never computes it.
import type { SessionMeta } from './types.js'
import type { ThreadIdOf } from './task-threads.js'

export interface ConversationPlace {
  /** the conversation's working folder (the project it is a conversation of) */
  cwd: string | null
  thread: string
  agent: string | null
  /** the thread's sessions in that folder (their starts prove its
   *  entries) — the asked one always; only for a thread with an entry */
  sessions: string[]
}

export interface ConversationPlacesDeps {
  metaById: (id: string) => SessionMeta | null
  allSessions: () => SessionMeta[]
  threadIdOf: ThreadIdOf
  agentOf: (m: SessionMeta) => string | null
  /** the thread ids Silos keeps an entry for, and each one's oldest row time */
  kept: () => { thread: string; oldest: number }[]
}

export function makeConversationPlaces(d: ConversationPlacesDeps): {
  conversationOf(sessionId: string): ConversationPlace | null
  threadsHere(folder: string): { thread: string; agent: string | null; tip: { folder: string; id: string; title: string } }[]
} {
  // the thread's sessions in a folder (never filtered by the index's mtime:
  // it can lag the transcript, and a start it missed would read «pending»)
  const sessionsOf = (thread: string, cwd: string | null): SessionMeta[] =>
    d.allSessions().filter((m) => m.cwd === cwd && (m.id === thread || d.threadIdOf(m.id) === thread))
  return {
    conversationOf(sessionId) {
      const m = d.metaById(sessionId)
      if (!m) return null
      const thread = d.threadIdOf(sessionId)
      // only a thread with an entry has anything to prove
      const sessions = d.kept().some((k) => k.thread === thread) ? sessionsOf(thread, m.cwd).map((x) => x.id) : []
      if (!sessions.includes(sessionId)) sessions.push(sessionId)
      return { cwd: m.cwd, thread, agent: d.agentOf(m), sessions }
    },
    threadsHere(folder) {
      const out: { thread: string; agent: string | null; tip: { folder: string; id: string; title: string } }[] = []
      for (const k of d.kept()) {
        // its root when the index has it; its newest session here is the
        // door (the thread continues there)
        const root = d.metaById(k.thread)
        if (!root || root.cwd !== folder) continue
        const tip = sessionsOf(k.thread, folder).sort((a, b) => b.mtime - a.mtime)[0] ?? root
        out.push({ thread: k.thread, agent: d.agentOf(root), tip: { folder: tip.folder, id: tip.id, title: tip.title } })
      }
      return out
    },
  }
}
