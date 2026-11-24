// routes/vault.ts — the composer's `!command` exec, account-login
// terminals, /api/search and the Vault (owner CRUD + each agent's own
// scope), moved VERBATIM out of server.ts (split the
// monoliths by domain, behavior unchanged). The agents' messages live in
// routes/messages.ts.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { maskEntry, underFolder, type SigningIdentity, type VaultEntry, type VaultStore } from '../vault-store.js'
import type { BindingAsk, Resolution } from '../binding-asks.js'
import { territoriesOf } from '../territory.js'
import { searchTranscripts } from '../harnesses/claude-code/search.js'
import { harnessForId } from '../harnesses/registry.js'
import type { HarnessId } from '../harnesses/contract.js'
import type { ExecService } from '../exec-service.js'
import type { TerminalService } from '../terminal-service.js'
import type { SessionIndex } from '../session-index.js'
import { MASTER_ID } from '../agent-registry.js'
import type { SessionStore } from '../session-store.js'
import type { SessionOwners } from '../session-owner.js'
import type { AgentRegistry } from '../agent-registry.js'
import type { ChatService } from '../chat-service.js'
import type { AgentStateStore } from '../agent-state.js'
import type { SessionMeta } from '../types.js'

export interface VaultRoutesCtx {
  exec: ExecService
  terminals: TerminalService
  vault: VaultStore | undefined
  index: SessionIndex
  store: SessionStore
  registry: AgentRegistry
  chat: ChatService
  owners: SessionOwners
  agentState: AgentStateStore | undefined
  classifyAgentId: (m: SessionMeta) => string
  broadcast: (msg: unknown) => void
  // the bindings agents propose in their asks (binding-asks.ts): the live
  // ones, and the resolution a SUCCESSFUL save of an entry's binding runs
  bindingAsks?: { list: () => BindingAsk[]; resolve: (saved: VaultEntry) => Resolution }
}

export function vaultRoutes(app: FastifyInstance, ctx: VaultRoutesCtx): void {
  const { exec, terminals, vault, index, registry, broadcast, bindingAsks } = ctx
  app.post<{ Params: { id: string }; Body: { command?: string } }>('/api/agents/:id/exec', async (req, reply) => {
    const command = typeof req.body?.command === 'string' ? req.body.command : ''
    if (command.trim() === '') return reply.code(400).send({ error: 'command required' })
    try {
      return await exec.run(req.params.id, command)
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) })
    }
  })

  // Terminal under the chat — a real PTY in an active agent's folder
  // (agentId) or the cwd of a session already seen (cwd) — never a free
  // path, see TerminalService.validateCwd. The streaming WS is separate,
  // at /ws/terminal/:id (the same @fastify/websocket scope below): that
  // route's token auth is already covered by the generic onRequest hook
  // above (it runs for any /ws*, not just plain /ws).
  app.post<{ Body: { agentId?: string; cwd?: string } }>('/api/terminals', async (req, reply) => {
    try {
      return reply.code(201).send(terminals.create({ agentId: req.body?.agentId, cwd: req.body?.cwd }))
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) })
    }
  })

  app.delete<{ Params: { id: string } }>('/api/terminals/:id', async (req) => {
    terminals.kill(req.params.id)
    return { ok: true }
  })

  // Full-text search across all conversations — a streamed scan of the
  // transcripts (message text only, see harnesses/claude-code/search.ts). The
  // client resolves titles/agents from the overview it already holds. Only
  // file-backed sessions are scanned; `unsearched` counts the rest (an
  // engine whose sessions live in a database — today OpenCode's), and
  // `unsearchedBy` splits that count by engine id, so the answer never
  // pretends and the palette names each engine.
  app.get<{ Querystring: { q?: string } }>('/api/search', async (req) => {
    const q = (req.query.q ?? '').trim()
    if (q.length < 3) return { hits: [], scanned: 0, truncated: false, unsearched: 0, unsearchedBy: {} }
    const all = index.allSessions()
    const files = all.filter((m) => index.hasTranscriptFile(m.id))
    const sessions = files.map((m) => ({ folder: m.folder, id: m.id, mtime: m.mtime, path: index.pathOf(m.folder, m.id) }))
    const unsearchedBy: Record<HarnessId, number> = {}
    for (const m of all)
      if (!index.hasTranscriptFile(m.id)) {
        const h = harnessForId(m.id)
        unsearchedBy[h] = (unsearchedBy[h] ?? 0) + 1
      }
    return { ...(await searchTranscripts(sessions, q)), unsearched: all.length - files.length, unsearchedBy }
  })

  // The Vault: env credentials for agent processes. Values NEVER leave the
  // server unmasked — every response goes through maskEntry (the same
  // discipline as providers.json).
  if (vault) {
    // Who can sign: a live agent — every one holds its
    // bearer; an archived or unknown id never
    // signs. A folder/global entry reaches the live agents working at or
    // under its folder / all of them.
    const identity: SigningIdentity = {
      hasIdentity: (id) => {
        const a = registry.get(id)
        return a !== null && !a.archived
      },
      agentsSeeing: (scope) => {
        if (scope.type === 'agents') return scope.agentIds
        const live = registry.list()
        if (scope.type === 'global') return live.map((a) => a.id)
        return live.filter((a) => territoriesOf(a).some((f) => underFolder(f, scope.folder))).map((a) => a.id)
      },
    }
    // `asks`: the live binding proposals (binding-asks.ts) — the Vault says
    // what a signature will unblock BEFORE the gesture. Never a value.
    const asksNow = (): BindingAsk[] => {
      try {
        return bindingAsks?.list() ?? []
      } catch {
        return []
      }
    }
    app.get('/api/vault', async () => ({ entries: vault.list().map(maskEntry), asks: asksNow() }))
    app.get('/api/vault/asks', async () => ({ asks: asksNow() }))
    // A save of a binding (not its removal) answers every open ask on that
    // entry — whatever values were saved.
    // Only after the store accepted it: a refused save resolves nothing.
    const resolveAsks = (entry: VaultEntry): Resolution | undefined => {
      if (!bindingAsks || !entry.binding) return undefined
      try {
        const r = bindingAsks.resolve(entry)
        if (r.resolved.length > 0 || r.failed.length > 0) broadcast({ ev: 'silos' })
        return r
      } catch {
        return undefined
      }
    }
    // `binding` signs the entry from birth; `warnings` names the agents that
    // would see it without being able to sign (never a silent lockout)
    app.post<{ Body: { name?: unknown; value?: unknown; scope?: unknown; public?: unknown; binding?: unknown } }>('/api/vault', async (req, reply) => {
      try {
        const warnings: string[] = []
        const entry = vault.create(req.body ?? {}, identity, warnings)
        const resolved = resolveAsks(entry)
        return reply.code(201).send({ entry: maskEntry(entry), ...(warnings.length > 0 ? { warnings } : {}), ...(resolved ? { resolved } : {}) })
      } catch (err) {
        return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) })
      }
    })
    // Visibility is manageable in place: PATCH changes WHO
    // sees an entry without re-pasting the value. The value itself never
    // changes here — replacing it stays delete + create.
    // `public`: the owner's judgement that it is plain configuration, not a
    // secret (vault-store.ts) — also in place, also never the value.
    // `binding`: delivered ⇄ signed in place — an
    // object signs it, null hands it over again; never the value.
    app.patch<{ Params: { id: string }; Body: { scope?: unknown; public?: unknown; binding?: unknown } }>('/api/vault/:id', async (req, reply) => {
      try {
        const b = req.body ?? {}
        if (b.scope === undefined && b.public === undefined && b.binding === undefined)
          return reply.code(400).send({ error: 'scope, public or binding is required' })
        const warnings: string[] = []
        let entry = b.scope !== undefined ? vault.setScope(req.params.id, b.scope, identity, warnings) : null
        if (b.public !== undefined) entry = vault.setPublic(req.params.id, b.public)
        if (b.binding !== undefined) entry = vault.setBinding(req.params.id, b.binding, identity, warnings)
        const resolved = b.binding !== undefined && b.binding !== null ? resolveAsks(entry!) : undefined
        return { entry: maskEntry(entry!), ...(warnings.length > 0 ? { warnings: [...new Set(warnings)] } : {}), ...(resolved ? { resolved } : {}) }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return reply.code(msg === 'entry not found' ? 404 : 400).send({ error: msg })
      }
    })
    app.delete<{ Params: { id: string } }>('/api/vault/:id', async (req, reply) => {
      if (!vault.remove(req.params.id)) return reply.code(404).send({ error: 'entry not found' })
      return { ok: true }
    })

    // The agent's OWN scope in the Vault. An agent reads what
    // reaches its env (masked — the values are already in its env) and
    // writes/deletes secrets visible to itself alone; the store refuses any
    // entry it did not write (vault-store.ts writeOwn/removeOwn). A bearer
    // may only touch its own id (agent-authz); the owner, and unfenced
    // agents without a bearer, speak for the agent in the path.
    const vaultAgent = (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const agent = registry.get(req.params.id)
      if (!agent || agent.archived) {
        void reply.code(404).send({ error: 'agent not found' })
        return null
      }
      if (req.agentId !== undefined && req.agentId !== agent.id) {
        void reply.code(403).send({ error: 'not your vault' })
        return null
      }
      return agent
    }
    app.get<{ Params: { id: string } }>('/api/agents/:id/vault', async (req, reply) => {
      const agent = vaultAgent(req, reply)
      if (!agent) return reply
      const folders = [agent.folder, ...(agent.folders ?? [])].filter((f): f is string => typeof f === 'string')
      const entries = vault.viewFor(agent.id, folders)
      if (req.agentId === undefined || req.agentId === MASTER_ID) return { entries }
      // to its bearer, an entry shared with other agents says «shared» —
      // never their ids (they may be of another project); who wrote it is
      // said only when it is itself
      return {
        entries: entries.map(({ createdBy, scope, ...e }) => ({
          ...e,
          scope: scope.type === 'agents' && scope.agentIds.some((x) => x !== agent.id) ? { type: 'shared' as const } : scope,
          ...(createdBy === agent.id ? { createdBy } : {}),
        })),
      }
    })
    // `binding` signs what it wrote (writeOwn may bind
    // its own) — the next call goes through /api/egress/<NAME>/…
    app.post<{ Params: { id: string }; Body: { name?: unknown; value?: unknown; binding?: unknown } }>('/api/agents/:id/vault', async (req, reply) => {
      const agent = vaultAgent(req, reply)
      if (!agent) return reply
      try {
        const { entry, replaced } = vault.writeOwn(agent.id, req.body ?? {})
        return reply
          .code(replaced ? 200 : 201)
          .send({ entry: maskEntry(entry), replaced, note: 'reaches your env in your next conversation (a new or resumed one), not this running one' })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return reply.code(msg.includes('only the owner') ? 409 : 400).send({ error: msg })
      }
    })
    app.delete<{ Params: { id: string; eid: string } }>('/api/agents/:id/vault/:eid', async (req, reply) => {
      const agent = vaultAgent(req, reply)
      if (!agent) return reply
      const r = vault.removeOwn(agent.id, req.params.eid)
      if (r === 'not-found') return reply.code(404).send({ error: 'entry not found' })
      if (r === 'not-yours') return reply.code(403).send({ error: 'only secrets you wrote in your own scope can be deleted by you' })
      return { ok: true }
    })
  }
}
