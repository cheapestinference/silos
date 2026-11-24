// routes/messages.ts — the agents' messages:
// send, read, settle. No message wakes anyone (R9): there is no `urgent` and
// no `wake` — a message is read at the recipient's next conversation.
//
// `from` is the caller's identity (author.ts: the bearer's agent; under the
// owner's credential a valid X-Silos-Agent, else the owner). Anyone may write
// to any known agent; only the owner or the recipient may read or mark its
// inbox (agentMayWrite refuses another agent's PATCH; the GET check lives
// here). A bearer's POST/PATCH carry its turn (`turn`, checked by the
// server's preHandler — live-turns.ts) and a message is stamped with
// that turn's run, never with anything the body says.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { MASTER_ID, type AgentRegistry } from '../agent-registry.js'
import { isMessageState, normalizeAnswer, replyToIsValid, ANSWER_MAX, type MessageStore } from '../messages.js'
import { runOfTurn, TURN_HEADER } from '../live-turns.js'
import type { MessageReads } from '../message-reads.js'
import { authorOf } from '../author.js'
import { initiativeNow } from '../initiative.js'

export const URGENT_GONE =
  "messages have no urgency any more: to move work now, assign your own task (POST /api/tasks/assign) or leave it to the owner's gesture"
export const REPLY_TO_NOT_YOURS = 'replyTo names no message of yours'

export interface MessageRoutesCtx {
  messages: MessageStore
  reads: MessageReads
  registry: AgentRegistry
  checkInbox: () => void
}

export function messageRoutes(app: FastifyInstance, ctx: MessageRoutesCtx): void {
  const { messages, reads, registry } = ctx
  const knownAgent = (id: string): boolean => registry.list(true).some((a) => a.id === id)
  const ownerOrSelf = (req: FastifyRequest, id: string): boolean => req.agentId === undefined || req.agentId === id

  app.post<{ Params: { id: string }; Body: { text?: unknown; urgent?: unknown; replyTo?: unknown } }>(
    '/api/agents/:id/messages',
    async (req, reply: FastifyReply) => {
      const to = req.params.id
      const b = req.body ?? {}
      // a 400, never a silence: an old skill that still sends it learns why
      if (b.urgent !== undefined) return reply.code(400).send({ error: URGENT_GONE })
      if (!knownAgent(to)) return reply.code(404).send({ error: 'agent not found' })
      // Anywhere (master) is the owner's own desk: no conversation lists its
      // inbox, so a message there is read by nobody. The refusal
      // says the two ways that DO reach someone.
      if (to === MASTER_ID) {
        return reply.code(409).send({
          error:
            'Anywhere has no inbox reader — a message there reaches nobody. To reply to a message, close it with PATCH /api/agents/<your id>/messages/<id> {"state":"answered","answer":"…"} (a long report goes in a file in a subfolder of context/<your id>/, named in the answer). To reach the owner, mark the message "needs_owner" or ask with your question tool (it lands in Needs you).',
        })
      }
      if (typeof b.text !== 'string' || b.text.trim() === '') return reply.code(400).send({ error: 'text required' })
      if (b.replyTo !== undefined && typeof b.replyTo !== 'string') return reply.code(400).send({ error: 'replyTo must be a string' })
      // authorship only (author.ts) — the header grants nothing
      const from = authorOf(req, registry)
      // a reply names a message the replier RECEIVED
      if (typeof b.replyTo === 'string' && !replyToIsValid(messages, from, b.replyTo)) return reply.code(400).send({ error: REPLY_TO_NOT_YOURS })
      const turn = req.turn
      let message
      try {
        message = messages.send({
          from,
          to,
          text: b.text,
          ...(typeof b.replyTo === 'string' ? { replyTo: b.replyTo } : {}),
          ...(turn ? { run: runOfTurn(turn) } : {}),
          // the root of the turn it is sent from: a task
          // made of this message inherits it — stamped by the server, from the
          // turn token, never from the body
          ...(turn && req.agentId !== undefined && initiativeNow()?.rootOfTurn(turn) === 'mission' ? { root: 'mission' as const } : {}),
        })
      } catch (err) {
        // the store can't take it: said in plain words, never a bare 500
        return reply.code(409).send({ error: err instanceof Error ? err.message : String(err) })
      }
      // a message enters an inbox: the open page hears it now
      setImmediate(() => ctx.checkInbox())
      return reply.code(201).send({ message })
    },
  )

  // The recipient's own GET carries its turn (`?turn=` or the
  // x-silos-turn header) — the serving marks `read` only for a console or
  // the owner's chat; an unattended turn's serving is noted and marked when
  // it ends with output; no token, the owner or an unknown reader: served,
  // never marked. The answer is what was served (state as it was).
  app.get<{ Params: { id: string }; Querystring: { state?: string; turn?: string } }>('/api/agents/:id/messages', async (req, reply) => {
    const id = req.params.id
    if (!knownAgent(id)) return reply.code(404).send({ error: 'agent not found' })
    if (!ownerOrSelf(req, id)) return reply.code(403).send({ error: `agent ${req.agentId} may not read ${id}'s inbox` })
    const state = req.query.state
    if (state !== undefined && !isMessageState(state)) return reply.code(400).send({ error: 'state must be one of new/read/answered/needs_owner' })
    const list = messages.list(id, state)
    if (req.agentId === id) {
      const header = req.headers[TURN_HEADER]
      const token = typeof req.query.turn === 'string' ? req.query.turn : typeof header === 'string' ? header.trim() : null
      const fresh = list.filter((m) => m.state === 'new').map((m) => m.id)
      try {
        if (reads.served(id, fresh, { turn: token }) === 'marked') setImmediate(() => ctx.checkInbox())
      } catch (err) {
        req.log.warn({ err }, `messages: marking ${id}'s inbox read failed`)
      }
    }
    return { messages: list }
  })

  // What this agent SENT, across every recipient's inbox, with each one's live
  // state and answer. Same readers as its inbox (owner or the agent itself);
  // a pure read — it marks nothing, the recipients' inboxes stay theirs.
  app.get<{ Params: { id: string } }>('/api/agents/:id/messages/sent', async (req, reply) => {
    const id = req.params.id
    if (!knownAgent(id)) return reply.code(404).send({ error: 'agent not found' })
    if (!ownerOrSelf(req, id)) return reply.code(403).send({ error: `agent ${req.agentId} may not read what ${id} sent` })
    return { messages: messages.sentBy(id) }
  })

  app.patch<{ Params: { id: string; mid: string }; Body: { state?: unknown; answer?: unknown } }>('/api/agents/:id/messages/:mid', async (req, reply) => {
    const id = req.params.id
    if (!knownAgent(id)) return reply.code(404).send({ error: 'agent not found' })
    if (!ownerOrSelf(req, id)) return reply.code(403).send({ error: `agent ${req.agentId} may not mark ${id}'s messages` })
    const state = req.body?.state
    if (!isMessageState(state)) return reply.code(400).send({ error: 'state must be one of new/read/answered/needs_owner' })
    // what the recipient says when it closes it: one paragraph, ≤ ANSWER_MAX
    const rawAnswer = req.body?.answer
    const answer = rawAnswer === undefined ? undefined : normalizeAnswer(rawAnswer)
    if (answer === null) return reply.code(400).send({ error: `answer must be a non-empty string of at most ${ANSWER_MAX} characters` })
    const message = messages.setState(id, req.params.mid, state, answer)
    if (!message) return reply.code(404).send({ error: 'message not found' })
    setImmediate(() => ctx.checkInbox())
    return { message }
  })
}
