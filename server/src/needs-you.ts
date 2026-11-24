// needs-you.ts — the SECOND source of "needs you" signals, alongside each
// session's own context.pending (see board.ts#boardStateOf). The console
// engine answers AskUserQuestion inline in the terminal — question and
// answer land together in the same JSONL turn — so context.pending is
// blind to it, and console is the default engine. These sources fill that
// gap with FILE-BORNE signals that exist independent of which engine drove
// the conversation: $SILOS_AGENT_STATE/status.json (the responsibility skill), the
// agents' messages, and OpenCode agents' permission questions (asks-store.ts),
// answered from Home with Allow / Deny. Support cases and the plans'
// tasks of the owner are built-in silos (support.silo.json,
// plans.silo.json): they ride the silo pipe (silos/surfaces.ts), never this
// file.
import type { Agent } from './types.js'
import type { MessageStore } from './messages.js'
import { askLine, type PendingAsk } from './asks-store.js'
import type { SiloNeedsYou } from './silos/surfaces.js'

export interface EscalatedNeedsYou {
  kind: 'escalated'
  agentId: string
  summary: string
  at: string
}

// A message between agents the recipient marked `needs_owner` (messages.ts):
// agentId is the recipient (whose inbox holds it), from the sender.
export interface MessageNeedsYou {
  kind: 'message'
  agentId: string
  from: string
  messageId: string
  text: string
  at: string
}

// An OpenCode agent waiting on a permission (asks-store.ts): `folder` is the
// conversation's folder key (so Home folds it into that conversation's
// row), `title` the line to show when there is no pattern to quote.
export interface AskNeedsYou {
  kind: 'ask'
  agentId: string
  sessionId: string
  folder: string
  id: string
  title: string
  pattern: string | null
  type: string
  at: string
}

// the SIXTH source: an active silo's needs-you entry, overlay conflict or
// pending proposal (silos/surfaces.ts)
export type { SiloNeedsYou }
export type NeedsYouItem = EscalatedNeedsYou | MessageNeedsYou | AskNeedsYou | SiloNeedsYou

// Messages the recipient handed to the owner (state needs_owner) — one row
// each, gone the moment someone marks it read or answered.
export function messagesNeedsYou(agents: readonly Agent[], messages: MessageStore): MessageNeedsYou[] {
  const out: MessageNeedsYou[] = []
  for (const agent of agents) {
    let inbox
    try {
      inbox = messages.list(agent.id, 'needs_owner')
    } catch {
      continue
    }
    for (const m of inbox) out.push({ kind: 'message', agentId: agent.id, from: m.from, messageId: m.id, text: m.text, at: m.at })
  }
  return out.sort((a, b) => b.at.localeCompare(a.at))
}

// Pending permission asks, newest first — only an ask whose session the
// server resolves to the agent whose directory holds it (an agent can write
// any file under its own state dir, including an ask naming a peer's
// session: that must never become a row on the owner's Home). `ownerOf` is
// the server's one authority (session-owner.ts); a session it cannot see
// (null) is dropped too — not actionable from Home, and OpenCode's own
// dialog still shows in the console. Each dropped ask is warned once.
const warnedAsks = new Set<string>()
export function asksNeedsYou(
  agents: readonly Agent[],
  asks: readonly PendingAsk[],
  sessions: { ownerOf: (sessionId: string) => string | null; folderOf: (sessionId: string) => string | null },
): AskNeedsYou[] {
  const known = new Set(agents.map((a) => a.id))
  const out: AskNeedsYou[] = []
  for (const a of asks) {
    if (!known.has(a.agentId)) continue
    // a question is not Allow/Deny: it lights its conversation's pendingAsk
    // and reads as that conversation's question (the reader's pendingOf)
    if (a.type === 'question') continue
    const owner = sessions.ownerOf(a.sessionId)
    const folder = sessions.folderOf(a.sessionId)
    if (owner !== a.agentId || folder === null) {
      const key = `${a.agentId}/${a.sessionId}/${a.id}`
      if (!warnedAsks.has(key)) {
        warnedAsks.add(key)
        console.warn(`[asks] ignoring ask ${a.id} from ${a.agentId}: session ${a.sessionId} ${owner === null ? 'is unknown' : `belongs to ${owner}`}`)
      }
      continue
    }
    out.push({ kind: 'ask', agentId: a.agentId, sessionId: a.sessionId, folder, id: a.id, title: askLine(a), pattern: a.pattern, type: a.type, at: a.askedAt })
  }
  return out.sort((x, y) => y.at.localeCompare(x.at))
}
