// What an agent (identified by its bearer token — agent-tokens.ts) may do
// on the API. Agents are NOT general readers: reads are an allow-list (the
// roster, the agent's own things, automations — agentMayRead); writes are a short allow-list of routes that act on the
// agent's OWN things (creating and editing its automations) or talk to another agent (agentMayWrite). Everything
// else (transcripts, files, the board, secrets, editing agents, sessions,
// settings, rotating tokens…) is the owner's.
//
// Both judge the DECODED path segments — Fastify routes `/api/%62oard` as
// `/api/board`, so a check on the raw url could be bypassed by encoding one
// character. A segment that fails to decode, still holds `%` after
// decoding, is empty where it matters, or is `.`/`..` → deny.

import type { LiveTurn } from './live-turns.js'

declare module 'fastify' {
  interface FastifyRequest {
    // set by the auth hook when a valid `Authorization: Bearer` is present
    agentId?: string
    // set by the auth hook when the request carries the OWNER's credential
    // (the static token — x-token or ?token= — or a login session). Neither
    // set = unknown: it reads (locally), never writes
    ownerCredential?: boolean
    // set for a bearer write once its turn token is classified (live-turns.ts):
    // the class of the turn it comes from
    turn?: LiveTurn
  }
}

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

export function isMutating(method: string): boolean {
  return !READ_METHODS.has(method.toUpperCase())
}

// The url's path (query stripped) as decoded segments after the leading
// '/': ['api', ...]. null when any segment is undecodable, still carries a
// '%' once decoded (double encoding), or is empty (`//`, trailing '/') —
// the callers deny on null.
function decodedSegments(url: string): string[] | null {
  const path = url.split('?')[0] ?? ''
  if (!path.startsWith('/')) return null
  const raw = path.slice(1).split('/')
  const out: string[] = []
  for (const r of raw) {
    let d: string
    try {
      d = decodeURIComponent(r)
    } catch {
      return null
    }
    if (d === '' || d === '.' || d === '..' || d.includes('%') || d.includes('/')) return null
    out.push(d)
  }
  return out
}

// The signer's route: `/api/egress/<NAME>[/…]`. Only
// its first three segments are Silos' to judge — the rest is the agent's
// path on the bound service (it may hold `//`, a trailing `/`, an encoded
// `%2F`), judged by the route itself (routes/egress.ts). Decided on the
// DECODED segments, so `/%61pi/egress/…` is the same route.
export function isEgressPath(url: string): boolean {
  const path = url.split('?')[0] ?? ''
  if (!path.startsWith('/')) return false
  const raw = path.slice(1).split('/')
  if (raw.length < 3) return false
  const head: string[] = []
  for (const r of raw.slice(0, 3)) {
    try {
      head.push(decodeURIComponent(r))
    } catch {
      return false
    }
  }
  return head[0] === 'api' && head[1] === 'egress' && head[2] !== '' && !head[2]!.includes('%') && !head[2]!.includes('/')
}

// The class of a request: a WRITE whenever its verb mutates — and ALWAYS on
// the signer's route, whatever the verb: a signed GET acts on the world with
// a credential, so it is never a «local read without a token».
export function isWriteClass(method: string, url: string): boolean {
  return isMutating(method) || isEgressPath(url)
}

export function agentMayWrite(agentId: string, method: string, url: string): boolean {
  const m = method.toUpperCase()
  // every verb on /api/egress/<NAME>/… — the route signs only with an entry
  // the agent already sees (VaultStore.signerFor over its folders)
  if (isEgressPath(url)) return true
  if (!isMutating(m)) return true
  const seg = decodedSegments(url)
  if (seg === null || seg[0] !== 'api') return false
  // POST /api/agents/:any/messages — write to any agent's inbox
  if (m === 'POST' && seg.length === 4 && seg[1] === 'agents' && seg[3] === 'messages') return true
  // PATCH /api/agents/<self>/messages/:mid — mark own messages
  if (m === 'PATCH' && seg.length === 5 && seg[1] === 'agents' && seg[2] === agentId && seg[3] === 'messages') return true
  // its own scope in the Vault: POST /api/agents/<self>/vault (write a
  // secret only it sees) and DELETE /api/agents/<self>/vault/:eid (the
  // store refuses any entry it did not write itself)
  if (m === 'POST' && seg.length === 4 && seg[1] === 'agents' && seg[2] === agentId && seg[3] === 'vault') return true
  if (m === 'DELETE' && seg.length === 5 && seg[1] === 'agents' && seg[2] === agentId && seg[3] === 'vault') return true
  // POST /api/automations — the route checks body.agentId === self
  if (m === 'POST' && seg.length === 2 && seg[1] === 'automations') return true
  // POST /api/proposals — propose an automation, a skill or a change to its
  // own mission.
  // And POST /api/proposals/:id/dismiss — withdraw its OWN proposal (the
  // route checks whose it is). Accepting one is the owner's alone.
  if (m === 'POST' && seg[1] === 'proposals') {
    if (seg.length === 2) return true
    if (seg.length === 4 && seg[3] === 'dismiss') return true
    return false
  }
  // POST /api/automations/templates/:tid/{preview,use} — a template filled
  // in goes through the create path, which checks agentId === self and
  // refuses an exec; importing, exporting and deleting stay the owner's
  if (m === 'POST' && seg.length === 5 && seg[1] === 'automations' && seg[2] === 'templates' && (seg[4] === 'use' || seg[4] === 'preview')) return true
  // PATCH /api/automations/:id — the route checks it is the agent's own and
  // leaves the owner's gates (approval, budget, agent, account) alone
  if (m === 'PATCH' && seg.length === 3 && seg[1] === 'automations') return true
  // DELETE /api/automations/:id — withdrawing its OWN recurring work:
  // the route lets only origin:'self' of the caller
  // through, to the trash; the turn rides the x-silos-turn header
  if (m === 'DELETE' && seg.length === 3 && seg[1] === 'automations') return true
  // POST /api/tasks/claim — taking a task of its own:
  // the route checks the task's owner and the session are the agent's
  if (m === 'POST' && seg.length === 3 && seg[1] === 'tasks' && seg[2] === 'claim') return true
  // POST /api/tasks/release — letting one of its conversations go from a task
  // of its own: the same checks as the claim
  if (m === 'POST' && seg.length === 3 && seg[1] === 'tasks' && seg[2] === 'release') return true
  // POST /api/tasks/assign — starting ITS OWN task:
  // the route checks t.owner === self and that it is On its own
  if (m === 'POST' && seg.length === 3 && seg[1] === 'tasks' && seg[2] === 'assign') return true
  // POST /api/tasks/ask — asking another agent on a
  // task of ITS OWN (the route checks the task's owner is self) — and POST
  // /api/tasks/ask/answer — answering what it was asked (the route checks
  // the ask names self). Both name their turn, like every bearer write
  if (m === 'POST' && seg.length === 3 && seg[1] === 'tasks' && seg[2] === 'ask') return true
  if (m === 'POST' && seg.length === 4 && seg[1] === 'tasks' && seg[2] === 'ask' && seg[3] === 'answer') return true
  // its heartbeat's two verbs: POST /api/agents/<self>/considered and
  // POST /api/agents/<self>/heartbeat/sleep — the routes check the turn is
  // a heartbeat's
  if (m === 'POST' && seg.length === 4 && seg[1] === 'agents' && seg[2] === agentId && seg[3] === 'considered') return true
  if (m === 'POST' && seg.length === 5 && seg[1] === 'agents' && seg[2] === agentId && seg[3] === 'heartbeat' && seg[4] === 'sleep') return true
  // POST /api/silos/:id/record/append — append-item:
  // the kernel validates ROLES (producer ∈ by, plans 0.8.0), the
  // actions layer the IDENTITY (by from the bearer, its turn classified)
  if (m === 'POST' && seg.length === 5 && seg[1] === 'silos' && seg[3] === 'record' && seg[4] === 'append') return true
  // POST /api/silos/validate — the validator's checks over a manifest or
  // the agent's own draft: it costs nothing and decides nothing, so an
  // author agent can check BEFORE submitting
  if (m === 'POST' && seg.length === 3 && seg[1] === 'silos' && seg[2] === 'validate') return true
  // POST /api/silos/submissions — submitting a silo is an agent's own gesture
  // (it always lands pending; approving is the owner's)
  if (m === 'POST' && seg.length === 3 && seg[1] === 'silos' && seg[2] === 'submissions') return true
  // a silo's producer: PUT /api/silos/:id/agents/<self>/records/:rid (its own
  // record, agent-record-write) and POST /api/silos/:id/agents/<self>/proposals
  if (seg[1] === 'silos' && seg[3] === 'agents' && seg[4] === agentId) {
    if (m === 'PUT' && seg.length === 7 && seg[5] === 'records') return true
    if (m === 'POST' && seg.length === 6 && seg[5] === 'proposals') return true
  }
  return false
}

// Every bearer write that agentMayWrite lets through must name its turn
// (the NORMATIVE list — assign, record/append,
// proposals and their dismiss, messages and their PATCH, heartbeat sleep,
// considered, automations create/PATCH/DELETE, claim/release — is a SUBSET:
// a new bearer route enters by default). The exemptions are an explicit
// list, empty on purpose: a route that could not carry `turn` is a gap
// to raise, never a silent exemption here.
export const TURN_EXEMPT_WRITES: readonly ((method: string, seg: readonly string[]) => boolean)[] = []

// A signed call is a write of any verb (isWriteClass): it names its turn too —
// in the x-silos-turn header, since its body is the service's, byte for byte.
export function agentWriteNeedsTurn(method: string, url: string): boolean {
  const m = method.toUpperCase()
  if (!isWriteClass(m, url)) return false
  if (isEgressPath(url)) return true
  const seg = decodedSegments(url)
  if (seg === null) return true
  return !TURN_EXEMPT_WRITES.some((exempt) => exempt(m, seg))
}

// Reads by an agent bearer: an ALLOW-list (controller ruling, Task 6
// review round 2) — the roster (`/api/agents` exactly), the agent's own
// subtree (`/api/agents/<self>/**`), automations (`/api/automations/**`)
// and, as a silo's producer, its own merged view and proposals (support's
// cases included, now a silo — /api/support is gone). Everything
// else under /api is the owner's. Paths outside /api (the static web app,
// /healthz) are not this check's business.
export function agentMayRead(agentId: string, url: string): boolean {
  if ((url.split('?')[0] ?? '') === '/') return true // the web app's root
  const seg = decodedSegments(url)
  if (seg === null) return false
  if (seg[0] !== 'api') return true
  if (seg[1] === 'agents') return seg.length === 2 || seg[2] === agentId
  // automations — but never a command run's log (the output of an exec the
  // fence never saw: /api/automations/:id/runs/:runId/log is the owner's)
  if (seg[1] === 'automations') return !(seg.length === 6 && seg[3] === 'runs' && seg[5] === 'log')
  // a silo's producer reads the merged view and its own proposals — under
  // /agents/<self>/ only; the rest of /api/silos is the owner's
  if (seg[1] === 'silos') return seg.length === 6 && seg[3] === 'agents' && seg[4] === agentId && (seg[5] === 'merged' || seg[5] === 'proposals')
  // which tasks a conversation is on: GET
  // /api/tasks/by-session and GET /api/sessions/:folder/:id/tasks — the
  // routes answer only about the agent's OWN conversations (403 / filtered)
  if (seg.length === 3 && seg[1] === 'tasks' && seg[2] === 'by-session') return true
  if (seg.length === 5 && seg[1] === 'sessions' && seg[4] === 'tasks') return true
  return false
}
