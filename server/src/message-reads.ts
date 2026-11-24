// message-reads.ts — «read» is marked by the server, BY THE CLASS of the
// turn that was served. One place for every
// surface and both engines:
//
//   console / the owner's chat (attended classes)  → marked at serving: the
//     SessionStart fetch (inbox.py, its $SILOS_TURN), an attended OpenCode
//     launch composing its context (assemble — composing IS serving), a
//     hookless attended turn's briefing
//   heartbeat / wake / run (unattended)            → served WITHOUT marking:
//     the serving is NOTED on the live turn (its briefing, its packet, a GET
//     mid-turn) and everything noted is marked when the turn ends WITH
//     output — a dead turn eats no message
//   a bare bearer, an unknown token, the owner, an unknown local reader →
//     served, never marked (reading fabricates nothing)
import type { LiveTurn, LiveTurns } from './live-turns.js'
import type { MessageStore } from './messages.js'
import { inboxText, LIST_MAX } from './harnesses/inbox-text.js'
import type { AskLine } from './task-asks.js'

/** How a recipient was served: its turn token, or an attended launch that
 *  has no token yet (an OpenCode console is composed before its tmux). */
export type ServedBy = { turn?: string | null } | 'attended'

export class MessageReads {
  // `asksFor`: the asks other agents left the
  // recipient through Silos — listed after its messages, as inbox.py does
  constructor(
    private messages: Pick<MessageStore, 'list' | 'markRead'>,
    private liveTurns: Pick<LiveTurns, 'get' | 'noteServed'>,
    private asksFor?: (agentId: string) => readonly AskLine[],
  ) {}

  /** The recipient `agentId` was served these messages: mark them (attended),
   *  note them on the turn (unattended), or nothing. */
  served(agentId: string, ids: readonly string[], by: ServedBy): 'marked' | 'noted' | 'none' {
    if (ids.length === 0) return 'none'
    if (by === 'attended') {
      this.messages.markRead(agentId, ids)
      return 'marked'
    }
    const token = by.turn
    if (typeof token !== 'string' || token === '') return 'none'
    const t = this.liveTurns.get(token)
    if (!t || t.agentId !== agentId) return 'none'
    if (!t.unattended) {
      this.messages.markRead(agentId, ids)
      return 'marked'
    }
    this.liveTurns.noteServed(token, ids)
    return 'noted'
  }

  /** «Your Silos inbox» for a turn without hooks (or an OpenCode launch),
   *  composed from the store — the serving is recorded as above. */
  inboxFor(agentId: string, by: ServedBy): string {
    let fresh
    try {
      fresh = this.messages.list(agentId, 'new')
    } catch {
      return ''
    }
    let asks: readonly AskLine[] = []
    try {
      asks = this.asksFor?.(agentId) ?? []
    } catch {
      asks = []
    }
    const text = inboxText(fresh, asks)
    if (fresh.some((m) => m.state === 'new')) {
      try {
        this.served(
          agentId,
          [...fresh]
            .sort((a, b) => a.at.localeCompare(b.at))
            .slice(0, LIST_MAX)
            .map((m) => m.id),
          by,
        )
      } catch {
        /* the inbox still reaches the turn */
      }
    }
    return text
  }

  /** The turn ended: an unattended one WITH output marks what it was served
   *  — its notes and its heartbeat packet's messages. The ids marked. */
  turnEnded(t: LiveTurn, output: boolean): string[] {
    if (!t.unattended || !output) return []
    const ids = new Set(t.servedMessages ?? [])
    for (const k of t.packetKeys ?? []) if (k.startsWith('message:')) ids.add(k.slice('message:'.length))
    if (ids.size === 0) return []
    return this.messages.markRead(t.agentId, ids)
  }
}
