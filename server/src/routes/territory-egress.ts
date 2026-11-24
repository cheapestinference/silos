// routes/territory-egress.ts — the network surface of the territory:
// each agent's egress policy and the proxy's refusals.
// Owner-only: the agent read/write policy (agent-authz.ts) refuses
// /api/territory/** to bearers; the refusals' rows additionally need the
// owner's CREDENTIAL (local or not) — the same rule as the signer's rows.
//
//   GET   /api/territory/egress             every agent's policy + its engine's own hosts + the proxy port
//   PATCH /api/territory/egress/:agentId    { mode?, hosts? } — validated before anything is saved
//   GET   /api/territory/egress/rejections  ?agent=&limit= — newest first
//   GET   /api/territory/refused            the file fence's refusals today, per agent and project (fence-refusals.ts)
import type { FastifyInstance } from 'fastify'
import { MASTER_ID, type AgentRegistry } from '../agent-registry.js'
import { normalizeEgressHosts, type EgressPolicy, type TerritoryStore } from '../territory-store.js'
import { engineHostsOf } from '../egress-proxy.js'
import type { EgressRejectLog } from '../egress-log.js'
import type { Agent } from '../types.js'
import type { RefusedAgent } from '../fence-refusals.js'

export interface TerritoryEgressCtx {
  territoryStore: TerritoryStore
  registry: AgentRegistry
  rejections: EgressRejectLog | null
  /** the egress proxy's stable port (egress-proxy.ts egressProxyPort), when known */
  proxyPort?: number
  /** the file fence's refusals since `since` (ms), per agent and project */
  refused?: (since: number) => RefusedAgent[]
}

export function territoryEgressRoutes(app: FastifyInstance, ctx: TerritoryEgressCtx): void {
  const { territoryStore, registry, rejections } = ctx

  const view = (
    a: Agent,
  ): { id: string; name: string } & EgressPolicy & { engine: { source: string; hosts: { host: string; optional?: true; reason: string }[] } | null } => {
    const engine = engineHostsOf(a)
    return {
      id: a.id,
      name: a.name,
      ...territoryStore.egressOf(a.id),
      engine: engine ? { source: engine.source, hosts: engine.hosts.map((h) => ({ ...h })) } : null,
    }
  }
  // the same set the fence toggles cover: not master, not archived
  const egressAgent = (id: string): Agent | null => {
    if (id === MASTER_ID) return null
    const a = registry.get(id)
    return a && !a.archived ? a : null
  }

  app.get('/api/territory/egress', async () => ({
    proxyPort: ctx.proxyPort ?? null,
    agents: registry
      .list()
      .filter((a) => a.id !== MASTER_ID && !a.archived)
      .map(view),
  }))

  app.patch<{ Params: { agentId: string }; Body: { mode?: unknown; hosts?: unknown } }>('/api/territory/egress/:agentId', async (req, reply) => {
    const agent = egressAgent(req.params.agentId)
    if (!agent) return reply.code(404).send({ error: `not an agent whose egress can be set: ${req.params.agentId}` })
    const body = req.body ?? {}
    if (body.mode === undefined && body.hosts === undefined) return reply.code(400).send({ error: 'mode or hosts is required' })
    if (body.mode !== undefined && body.mode !== 'open' && body.mode !== 'allowlist') return reply.code(400).send({ error: 'mode must be open or allowlist' })
    const current = territoryStore.egressOf(agent.id)
    let hosts = current.hosts
    if (body.hosts !== undefined) {
      const n = normalizeEgressHosts(body.hosts)
      if (typeof n === 'string') return reply.code(400).send({ error: n })
      hosts = n
    }
    try {
      territoryStore.setEgress(agent.id, { mode: (body.mode as EgressPolicy['mode'] | undefined) ?? current.mode, hosts })
    } catch (err) {
      return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) })
    }
    return { proxyPort: ctx.proxyPort ?? null, agent: view(agent) }
  })

  app.get<{ Querystring: { agent?: string; limit?: string } }>('/api/territory/egress/rejections', async (req, reply) => {
    if (req.ownerCredential !== true) return reply.code(401).send({ error: "the egress proxy's refusals are the owner's to read" })
    const limit = Number(req.query.limit)
    return {
      rows:
        rejections?.read({
          ...(typeof req.query.agent === 'string' && req.query.agent !== '' ? { agentId: req.query.agent } : {}),
          ...(Number.isFinite(limit) && limit > 0 ? { limit } : {}),
        }) ?? [],
    }
  })

  // the owner's own read (paths and conversations): its credential, like the
  // proxy's rows. «Today» is the server's local day, as the network count.
  app.get('/api/territory/refused', async (req, reply) => {
    if (req.ownerCredential !== true) return reply.code(401).send({ error: "the fence's refusals are the owner's to read" })
    const midnight = new Date()
    midnight.setHours(0, 0, 0, 0)
    return { since: midnight.toISOString(), agents: ctx.refused?.(midnight.getTime()) ?? [] }
  })
}
