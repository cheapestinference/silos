// author.ts — WHO wrote it, for the record: an agent bearer names its
// agent; under the OWNER's credential (req.ownerCredential: the static token
// or a login session), `X-Silos-Agent` names the author when it is a valid,
// unarchived agent — else the owner. Without either it is UNKNOWN: «owner»
// is never fabricated. AUTHORSHIP only: the `by`
// of a message, a journal line, a note. The header never grants a
// permission — what a request may do is decided by its credential alone.
// Used by the messages route (routes/vault.ts) and by claim/release.
import type { FastifyRequest } from 'fastify'
import type { AgentRegistry } from './agent-registry.js'

export const UNKNOWN_AUTHOR = 'unknown'

export function authorOf(req: Pick<FastifyRequest, 'headers'> & { agentId?: string; ownerCredential?: boolean }, agents: Pick<AgentRegistry, 'get'>): string {
  if (req.agentId !== undefined) return req.agentId
  if (req.ownerCredential !== true) return UNKNOWN_AUTHOR
  const named = req.headers['x-silos-agent']
  const claimed = typeof named === 'string' && named.trim() !== '' ? agents.get(named.trim()) : null
  return claimed && !claimed.archived ? claimed.id : 'owner'
}
