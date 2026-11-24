// routes/proposals.ts — /api/proposals (replaces
// /api/automations/proposals). An agent proposes for itself, by bearer, from
// inside a turn (the auth hook classified its `turn` into req.turn —
// the `run` it is stamped with comes from there, never from the body); the
// owner reads, accepts and dismisses; the agent may withdraw its own.
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { AgentRegistry } from '../agent-registry.js'
import type { AgentStateStore } from '../agent-state.js'
import { PROPOSALS_PENDING_MAX } from '../limits.js'
import { runOfTurn } from '../live-turns.js'
import type { ProvidersStore } from '../providers-store.js'
import {
  ALREADY_ERROR,
  CHANGED_ERROR,
  COMMAND_REVIEW_ERROR,
  KIND_ERROR,
  MISSION_REVIEW_ERROR,
  PENDING_MAX_ERROR,
  PROPOSAL_DISMISS_REASON_MAX,
  PROPOSAL_ID,
  PROPOSAL_INPUT_MAX_BYTES,
  inputHashOf,
  isProposalKind,
  missionProposalInput,
  proposalReason,
  runsACommand,
  type ProposalsStore,
} from '../proposals.js'
import { proposalView } from '../proposals-view.js'
import { acceptProposedSkill, readProposedFile, readProposedSkill } from '../skill-accept.js'
import type { AutomationCreateApi } from './automations.js'

export interface ProposalRoutesCtx {
  proposals: ProposalsStore
  registry: AgentRegistry
  /** the create path of routes/automations.ts — absent: automation proposals
   *  cannot be validated nor accepted (no automations in this server) */
  automationCreate: AutomationCreateApi | null
  agentState?: AgentStateStore
  providers?: ProvidersStore
  // the install's unattended provider — the brake's words follow it
  unattendedProvider?: () => string | null
  territoryOn?: (agentId: string) => boolean
  dataDir?: string
  checkInbox: () => void
}

export function proposalRoutes(app: FastifyInstance, ctx: ProposalRoutesCtx): void {
  const { proposals, registry } = ctx
  const viewDeps = {
    registry,
    ...(ctx.providers ? { providers: ctx.providers } : {}),
    ...(ctx.unattendedProvider ? { unattendedProvider: ctx.unattendedProvider } : {}),
    ...(ctx.territoryOn ? { territoryOn: ctx.territoryOn } : {}),
    ...(ctx.agentState ? { agentState: ctx.agentState } : {}),
  }
  const nudge = (): void => {
    setImmediate(() => ctx.checkInbox())
  }
  const ownerOnly = (req: FastifyRequest, what: string): string | null =>
    req.agentId !== undefined ? `agent ${req.agentId} may not ${what} — only the owner can` : null

  // ---- propose (bearer) ------------------------------------------------------
  app.post<{ Body: unknown }>('/api/proposals', async (req, reply) => {
    // an agent proposes; the owner decides — never the other way round
    if (req.agentId === undefined) return reply.code(403).send({ error: 'only an agent proposes — the owner creates it directly' })
    const by = req.agentId
    const b = req.body
    if (typeof b !== 'object' || b === null || Array.isArray(b)) return reply.code(400).send({ error: 'invalid body: { kind, reason, input, turn }' })
    const { kind, reason: rawReason, input } = b as { kind?: unknown; reason?: unknown; input?: unknown }
    if (!isProposalKind(kind)) return reply.code(400).send({ error: KIND_ERROR })
    const r = proposalReason(rawReason)
    if ('error' in r) return reply.code(400).send({ error: r.error })
    if (typeof input !== 'object' || input === null || Array.isArray(input))
      return reply
        .code(400)
        .send({ error: 'input required: the body you would POST to /api/automations, { name } of a skill, or { text, never } of your mission' })
    if (JSON.stringify(input).length > PROPOSAL_INPUT_MAX_BYTES)
      return reply.code(400).send({ error: `input too large (over ${PROPOSAL_INPUT_MAX_BYTES} bytes)` })
    let stored: Record<string, unknown>
    let contentHash: string | undefined
    if (kind === 'automation') {
      // an agent proposes only for itself
      const bodyAgent = (input as { agentId?: unknown }).agentId
      if (bodyAgent !== by) return reply.code(403).send({ error: `agent ${by} may not propose automations for ${String(bodyAgent)}` })
      if (!ctx.automationCreate) return reply.code(400).send({ error: 'automations are not available on this server' })
      // validated as the owner would create it (the owner is who will): the
      // same judge and the same words as POST /api/automations
      const prepared = ctx.automationCreate.prepare(undefined, input)
      if ('error' in prepared) return reply.code(prepared.code).send({ error: prepared.error })
      stored = input as Record<string, unknown>
    } else if (kind === 'skill') {
      const name = (input as { name?: unknown }).name
      if (!ctx.agentState) return reply.code(400).send({ error: 'skills cannot be proposed on this server' })
      const tree = readProposedSkill(ctx.agentState.pathFor(by), name)
      if (!tree.ok) return reply.code(tree.code).send({ error: tree.error })
      stored = { name: name as string }
      contentHash = tree.contentHash
    } else {
      const m = missionProposalInput(input)
      if ('error' in m) return reply.code(400).send({ error: m.error })
      stored = m.input
    }
    const twin = proposals.pendingTwin(by, kind, inputHashOf(stored))
    if (twin) return reply.code(200).send({ proposal: twin })
    if (proposals.pendingCount(by) >= PROPOSALS_PENDING_MAX) return reply.code(429).send({ error: PENDING_MAX_ERROR(PROPOSALS_PENDING_MAX) })
    // `run`: the unattended turn's run, from the token the auth hook
    // classified — an attended turn (chat, console) has no run to audit
    const turn = req.turn
    const run = turn && turn.unattended ? runOfTurn(turn) : undefined
    const proposal = proposals.add({
      by,
      kind,
      reason: r.reason,
      input: stored,
      ...(run !== undefined ? { run } : {}),
      ...(contentHash !== undefined ? { contentHash } : {}),
    })
    nudge()
    return reply.code(201).send({ proposal })
  })

  // ---- read (owner) ------------------------------------------------------------
  app.get('/api/proposals', async (req, reply) => {
    const no = ownerOnly(req, 'read the proposals')
    if (no) return reply.code(403).send({ error: no })
    return { proposals: proposals.list().map((p) => proposalView(p, viewDeps)) }
  })

  // one file of a proposed skill (each file of the sheet is openable)
  app.get<{ Params: { id: string }; Querystring: { path?: string } }>('/api/proposals/:id/file', async (req, reply) => {
    const no = ownerOnly(req, 'read a proposed skill')
    if (no) return reply.code(403).send({ error: no })
    const p = PROPOSAL_ID.test(req.params.id) ? proposals.get(req.params.id) : null
    if (!p || p.kind !== 'skill' || !ctx.agentState) return reply.code(404).send({ error: 'proposal not found' })
    const rel = req.query.path
    if (typeof rel !== 'string' || rel === '') return reply.code(400).send({ error: 'path required' })
    const text = readProposedFile(ctx.agentState.pathFor(p.by), String(p.input.name), rel)
    if (text === null) return reply.code(404).send({ error: 'no such file in the proposed skill' })
    return { path: rel, text }
  })

  // ---- accept (owner) ----------------------------------------------------------
  app.post<{ Params: { id: string }; Body: unknown }>('/api/proposals/:id/accept', async (req, reply) => {
    const no = ownerOnly(req, 'accept a proposal')
    if (no) return reply.code(403).send({ error: no })
    if (!PROPOSAL_ID.test(req.params.id)) return reply.code(400).send({ error: 'invalid id' })
    const p = proposals.get(req.params.id)
    if (!p) return reply.code(404).send({ error: 'proposal not found' })
    if (p.state !== 'pending') return reply.code(409).send({ error: ALREADY_ERROR(p.state) })
    // the mission is the owner's text; a command is code on a clock — both
    // are reviewed in their editor, never accepted in one touch (S5, S6)
    if (p.kind === 'mission') return reply.code(409).send({ error: MISSION_REVIEW_ERROR })
    if (p.kind === 'automation' && runsACommand(p.input)) return reply.code(409).send({ error: COMMAND_REVIEW_ERROR })
    // S1-r4: what is created is what was stamped — and, when the sheet sends
    // the hash it painted, what the owner read
    const seen = (req.body as { inputHash?: unknown } | null)?.inputHash
    if (!proposals.inputIntact(p) || (typeof seen === 'string' && seen !== p.inputHash)) return reply.code(409).send({ error: CHANGED_ERROR })
    const agent = registry.get(p.by)
    if (!agent || agent.archived)
      return reply.code(409).send({ error: `${agent?.name ?? p.by} is ${agent ? 'archived' : 'gone'} — there is no agent to accept this for` })
    if (p.kind === 'automation') {
      if (!ctx.automationCreate) return reply.code(409).send({ error: 'automations are not available on this server' })
      // the SAME path as the owner's create, stamped with its proposer: not
      // subject to the self-creation limits (the owner is the quota) and no
      // creation of its own
      const made = ctx.automationCreate.createStamped(p.input, { createdBy: p.by, origin: 'self', acceptedFrom: p.id })
      if ('error' in made) return reply.code(made.code).send({ error: made.error })
      const proposal = proposals.decide(p.id, 'accepted', 'owner', made.automation.id)
      nudge()
      // a secret generated now is the owner's to see, at create
      return reply.code(201).send({ automation: made.automation, ...(made.generatedSecret ? { generatedSecret: made.generatedSecret } : {}), proposal })
    }
    if (!ctx.agentState || !ctx.dataDir) return reply.code(409).send({ error: 'skills cannot be accepted on this server' })
    const res = acceptProposedSkill({
      agentStateDir: ctx.agentState.pathFor(p.by),
      dataDir: ctx.dataDir,
      agentId: p.by,
      agentName: agent.name,
      name: p.input.name,
      contentHash: p.contentHash,
    })
    if (!res.ok) return reply.code(res.code).send({ error: res.error })
    proposals.decide(p.id, 'accepted', 'owner', res.skill)
    nudge()
    return reply.code(200).send({ skill: res.skill, loadsAt: 'next conversation' })
  })

  // ---- dismiss (owner, or the agent withdrawing its own) ----------------------
  app.post<{ Params: { id: string }; Body: unknown }>('/api/proposals/:id/dismiss', async (req, reply) => {
    if (!PROPOSAL_ID.test(req.params.id)) return reply.code(400).send({ error: 'invalid id' })
    const p = proposals.get(req.params.id)
    if (!p) return reply.code(404).send({ error: 'proposal not found' })
    if (req.agentId !== undefined && p.by !== req.agentId) return reply.code(403).send({ error: `agent ${req.agentId} may not dismiss ${p.by}'s proposal` })
    if (p.state !== 'pending') return reply.code(409).send({ error: ALREADY_ERROR(p.state) })
    const raw = (req.body as { reason?: unknown } | null)?.reason
    let reason: string | undefined
    if (raw !== undefined && raw !== null) {
      if (typeof raw !== 'string') return reply.code(400).send({ error: `reason must be up to ${PROPOSAL_DISMISS_REASON_MAX} characters` })
      reason = raw.replace(/\s+/g, ' ').trim()
      if (reason.length > PROPOSAL_DISMISS_REASON_MAX) return reply.code(400).send({ error: `reason must be up to ${PROPOSAL_DISMISS_REASON_MAX} characters` })
    }
    // the reason travels to the agent's next packet (decidedWords)
    const proposal = proposals.decide(p.id, 'dismissed', req.agentId ?? 'owner', reason)
    nudge()
    return { proposal }
  })
}
