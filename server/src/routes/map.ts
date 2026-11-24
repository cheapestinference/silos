// routes/map.ts — the Map's read: /api/uses (the usage matrix), moved out
// of server.ts (split the monoliths by domain). (/api/map —
// the five-lane view —, /api/infra — a hand-declared inventory nothing
// used — and /api/graph — the Wiring view — are retired.)
import { isAbsolute, basename } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { claudeMcpOrigin } from '../harnesses/claude-code/mcp-origin.js'
import { gatewayAutoLabel } from '../provider-models.js'
import { buildUses, projectOf, USES_COLS, USES_ROWS, type UsesColKind, type UsesName, type UsesRowKind, type UsesSession } from '../uses.js'
import type { SessionIndex } from '../session-index.js'
import type { SessionStore } from '../session-store.js'
import type { SessionOwners } from '../session-owner.js'
import type { SessionOriginsStore } from '../session-origins.js'
import type { ConversationPrefsStore } from '../conversation-prefs.js'
import type { AgentRegistry } from '../agent-registry.js'
import type { AutomationsStore } from '../automations-store.js'
import type { ProvidersStore } from '../providers-store.js'
import type { AccountsService } from '../harnesses/claude-code/accounts.js'
import type { VaultStore } from '../vault-store.js'
import type { SessionContext, SessionMeta } from '../types.js'

export interface MapRoutesCtx {
  index: SessionIndex
  store: SessionStore
  registry: AgentRegistry
  owners: SessionOwners
  origins: SessionOriginsStore | undefined
  convPrefs: ConversationPrefsStore | undefined
  providers: ProvidersStore | undefined
  accounts: AccountsService | undefined
  automations: AutomationsStore | undefined
  vault: VaultStore | undefined
  classifyAgentId: (m: SessionMeta) => string
  home: string // the home this server works in (server.ts machineHome)
}

export function mapRoutes(app: FastifyInstance, c: MapRoutesCtx): void {
  const { index, store, registry, owners, origins, convPrefs, providers, accounts, automations, vault, classifyAgentId, home } = c

  // Map › Uses — the usage matrix (uses.ts), the Map's landing:
  // what agents/projects/conversations ACTUALLY used, counted from each
  // session's own context. One in-memory pass over the
  // overview's set of sessions (allSessions already leaves trashed, hidden
  // and ephemeral ones out). Owner-only: it names every conversation and file.
  app.get<{ Querystring: { rows?: string; cols?: string; since?: string; runs?: string; min?: string; folder?: string } }>('/api/uses', async (req, reply) => {
    if (req.agentId !== undefined) return reply.code(403).send({ error: `agent ${req.agentId} may not read /api/uses` })
    const q = req.query
    for (const k of ['rows', 'cols', 'since', 'runs', 'min', 'folder'] as const) {
      if (q[k] !== undefined && typeof q[k] !== 'string') return reply.code(400).send({ error: `${k} must be a string` })
    }
    const rows = (q.rows ?? 'agent') as UsesRowKind
    const cols = (q.cols ?? 'model') as UsesColKind
    if (!USES_ROWS.includes(rows)) return reply.code(400).send({ error: `rows must be one of ${USES_ROWS.join(', ')}` })
    if (!USES_COLS.includes(cols)) return reply.code(400).send({ error: `cols must be one of ${USES_COLS.join(', ')}` })
    const since = q.since ?? '30'
    if (since !== 'all' && !/^\d{1,4}$/.test(since)) return reply.code(400).send({ error: 'since must be a number of days or all' })
    const min = q.min === undefined ? 1 : Number.parseInt(q.min, 10)
    if (!Number.isInteger(min) || min < 1 || min > 99) return reply.code(400).send({ error: 'min must be 1..99' })
    if (q.folder !== undefined && !isAbsolute(q.folder)) return reply.code(400).send({ error: 'folder must be absolute' })
    const now = Date.now()
    const resolve = store.titleResolver()
    const agents = registry.list(true)
    const agentById = new Map(agents.map((a) => [a.id, a]))
    const known = agents.flatMap((a) => [a.folder, ...(a.folders ?? [])]).filter((f): f is string => typeof f === 'string' && f !== '')
    // a Claude account reads as its email when Claude knows it (the owner
    // can't tell 'default' from 'kai'); what it is goes underneath
    const accountName = (name: string, machine: boolean): string => (machine ? 'Claude · this machine' : `Claude · ${name}`)
    const accountViews = (await accounts?.list()) ?? []
    const accountLabels = new Map<string, UsesName>(
      accountViews.map((a) => {
        const what = accountName(a.name, a.providerId === 'default')
        return [a.providerId, a.email ? { label: a.email, sub: what } : { label: what }]
      }),
    )
    // the account a conversation RAN on: its transcript's own login email
    // (flags.accountEmail) beats the account it was set to — they differ
    // when the account changed under a live console. A key is never
    // replaced: it rides the machine's login dir with its own endpoint.
    const accountByEmail = new Map(accountViews.filter((a) => a.email).map((a) => [a.email!.toLowerCase(), a.providerId]))
    const claudeAccountIds = new Set([...accountLabels.keys(), 'default'])
    const ranOn = (set: string, ctx: SessionContext | null): string => {
      if (!claudeAccountIds.has(set)) return set
      const email = ctx?.flags.accountEmail?.toLowerCase()
      return (email && accountByEmail.get(email)) || set
    }
    const sessions: UsesSession[] = index.allSessions().map((m) => {
      const agentId = classifyAgentId(m)
      const ctx = index.getContext(m.folder, m.id)
      return {
        folder: m.folder,
        id: m.id,
        title: resolve(m.folder, m.id, m.title).title,
        agentId,
        project: projectOf(m.cwd, known),
        cwd: m.cwd,
        mtime: m.mtime,
        run: Boolean(origins?.get(`${m.folder}/${m.id}`)) || owners.nestedBirthOf(m) !== null,
        automationId: ((o) => (o && typeof (o as { automationId?: unknown }).automationId === 'string' ? (o as { automationId: string }).automationId : null))(
          origins?.get(`${m.folder}/${m.id}`),
        ),
        skills: m.skills,
        provider: ranOn(convPrefs?.get(m.folder, m.id)?.provider ?? agentById.get(agentId)?.provider ?? 'default', ctx),
        ctx,
      }
    })
    return buildUses(
      sessions,
      {
        rows,
        cols,
        sinceMs: since === 'all' ? null : now - Number(since) * 86_400_000,
        runs: q.runs !== '0',
        minRows: min,
        ...(q.folder !== undefined ? { folder: q.folder } : {}),
      },
      {
        agent: (id) => agentById.get(id)?.name ?? id,
        provider: (id): UsesName => {
          const account = accountLabels.get(id)
          if (account) return account
          // an account Silos no longer lists still reads as one (its id names it)
          if (id === 'default') return { label: accountName('', true) }
          if (id.startsWith('account:')) return { label: accountName(id.slice('account:'.length), false) }
          const p = providers?.get(id)
          if (!p) return { label: id }
          // a key Silos named itself ("cheapestinference · kimi-k3, qwen3.8-max")
          // reads as its gateway with the models it reaches underneath, and as
          // the gateway alone beside a model that already names itself
          const head = p.kind === 'anthropic-compatible' ? gatewayAutoLabel(p.baseUrl, []) : null
          return head !== null && p.label.startsWith(`${head} · `)
            ? { label: head, sub: p.label.slice(head.length + ' · '.length), short: head }
            : { label: p.label }
        },
        home: home,
        projects: known,
        automation: (id) => automations?.get(id)?.name ?? id,
        mcpOrigin: claudeMcpOrigin,
        // a Vault secret's reach, in the scope words the Vault page uses
        secret: (name) => {
          const e = (vault?.list() ?? []).find((x) => x.name === name)
          if (!e) return null
          const sc = e.scope as { type: string; folder?: string; agents?: string[] }
          if (sc.type === 'folder' && sc.folder) return `Vault · ${basename(sc.folder)}`
          if (sc.type === 'agents' && sc.agents) return `Vault · only ${sc.agents.map((a) => agentById.get(a)?.name ?? a).join(', ')}`
          return 'Vault · every agent'
        },
      },
      now,
    )
  })
}
