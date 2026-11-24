// routes/board.ts — Home's reading surfaces: the digest band, push
// devices, GET /api/board, the OpenCode ask reply, the needs-you ack,
// /api/tasks (background work), /api/tools and /api/artifacts, moved
// VERBATIM out of server.ts (split the monoliths by
// domain, behavior unchanged). composeBoard / warmInboxReadings / checkInbox
// stay in buildServer (one derivation for board+inbox+digest+doorbell);
// they arrive through the ctx, checkInbox as a thunk (declared later).
import { statSync } from 'node:fs'
import type { FastifyInstance } from 'fastify'
import type { InboxRow } from '../inbox.js'
import { localDay, isDigestHour, type DigestStore, type NotificationPrefsStore } from '../digest-job.js'
import { validSubscription, type PushSubscriptionsStore, type WebPushDoorbell } from '../web-push.js'
import { ASK_ID, type AsksStore } from '../asks-store.js'
import { isAckKind, type NeedsYouAcksStore } from '../needs-you-acks.js'
import type { NeedsYouItem } from '../needs-you.js'
import type { SiloBoard } from '../silos/surfaces.js'
import { aggregateTools } from '../tools-aggregate.js'
import { aggregateArtifacts } from '../artifacts-aggregate.js'
import { PARAM, PURE_DOTS } from '../segments.js'
import type { AgentRegistry } from '../agent-registry.js'
import type { SessionIndex } from '../session-index.js'
import type { SessionStore } from '../session-store.js'
import type { BoardCard, SessionMeta } from '../types.js'
import type { HomeSince } from '../home-since.js'

export interface BoardRoutesCtx {
  index: SessionIndex
  store: SessionStore
  registry: AgentRegistry
  digests: DigestStore | undefined
  notificationPrefs: NotificationPrefsStore | undefined
  push: { doorbell: WebPushDoorbell; devices: PushSubscriptionsStore } | undefined
  asks: AsksStore | undefined
  needsYouAcks: NeedsYouAcksStore | undefined
  classifyAgentId: (m: SessionMeta) => string
  composeBoard: (now: number) => { cards: BoardCard[]; needsYou: NeedsYouItem[]; inbox: InboxRow[]; silo: SiloBoard | undefined }
  warmInboxReadings: () => Promise<unknown>
  checkInbox: () => void
  // Home's «Since …» (home-since.ts): counted from the owner's previous visit
  homeSince?: (req: { ownerCredential?: boolean; agentId?: string }) => HomeSince
}

export function boardRoutes(app: FastifyInstance, ctx: BoardRoutesCtx): void {
  const { index, store, registry, asks, needsYouAcks, classifyAgentId, composeBoard, warmInboxReadings } = ctx
  const checkInbox = (): void => ctx.checkInbox()
  // The daily digest, as Home reads it: every unread digest summed into one
  // band (digest.ts sumDigests), and the owner's hour. Seen acknowledges the
  // newest date shown — a later digest is unread again on its own.
  if (ctx.digests && ctx.notificationPrefs) {
    const digests = ctx.digests
    const nprefs = ctx.notificationPrefs
    const DAY = /^\d{4}-\d{2}-\d{2}$/
    app.get('/api/digest', async () => {
      const p = nprefs.get()
      const seen = needsYouAcks?.ackedVersion('digest', 'home') ?? null
      return { hour: p.digestHour, band: digests.unread(seen, localDay(Date.now(), p.digestTz)) }
    })
    app.post<{ Body: { through?: unknown } }>('/api/digest/seen', async (req, reply) => {
      const through = req.body?.through
      if (typeof through !== 'string' || !DAY.test(through) || !digests.has(through)) return reply.code(400).send({ error: 'no digest for that day' })
      if (!needsYouAcks) return reply.code(501).send({ error: 'acks are not kept on this server' })
      const seen = needsYouAcks.ackedVersion('digest', 'home')
      if (seen === null || through > seen) needsYouAcks.ack('digest', 'home', through)
      return reply.code(204).send()
    })
    app.put<{ Body: { hour?: unknown } }>('/api/digest/hour', async (req, reply) => {
      const hour = req.body?.hour
      if (!isDigestHour(hour)) return reply.code(400).send({ error: 'the hour reads HH:MM, 00:00 to 23:59' })
      return { hour: nprefs.setDigestHour(hour).digestHour }
    })
  }

  // The doorbell's devices (web-push.ts). A device subscribes from Settings ›
  // Notifications; its endpoint is a capability URL, so it goes back only to
  // the owner (agents read nothing here — agent-authz.ts). The push itself
  // carries counts and kinds only (doorbell.ts).
  if (ctx.push) {
    const { doorbell, devices } = ctx.push
    const view = (d: ReturnType<PushSubscriptionsStore['list']>[number]) => ({
      id: d.id,
      label: d.label,
      endpoint: d.endpoint,
      createdAt: d.createdAt,
      ...(d.lastAcceptedAt ? { lastAcceptedAt: d.lastAcceptedAt } : {}),
      ...(d.lastError ? { lastError: d.lastError } : {}),
    })
    app.get('/api/push', async () => ({ publicKey: doorbell.publicKey, devices: devices.list().map(view) }))
    app.post<{ Body: { subscription?: unknown; label?: unknown } }>('/api/push/devices', async (req, reply) => {
      const sub = validSubscription(req.body?.subscription)
      if (!sub) return reply.code(400).send({ error: 'not a push subscription this server can use' })
      const rawLabel =
        typeof req.body?.label === 'string'
          ? req.body.label
              .replace(/[\u0000-\u001f\u007f]/g, '')
              .trim()
              .slice(0, 60)
          : ''
      const origin = typeof req.headers.origin === 'string' && /^https?:\/\/[^/\s]+$/.test(req.headers.origin) ? req.headers.origin : ''
      const d = devices.add(sub, rawLabel || 'A browser', origin, new Date())
      return reply.code(201).send(view(d))
    })
    app.delete<{ Params: { id: string } }>('/api/push/devices/:id', async (req, reply) => {
      if (!PARAM.test(req.params.id) || !devices.remove(req.params.id)) return reply.code(404).send({ error: 'no such device' })
      return reply.code(204).send()
    })
    app.post<{ Params: { id: string } }>('/api/push/devices/:id/test', async (req, reply) => {
      if (!PARAM.test(req.params.id)) return reply.code(404).send({ error: 'no such device' })
      const r = await doorbell.ringDevice(req.params.id, { title: 'Silos', body: 'Notifications work on this device', tag: 'silos-test', url: '/' })
      if (!r) return reply.code(404).send({ error: 'no such device' })
      const d = devices.list().find((x) => x.id === req.params.id)
      return { status: r.status, device: d ? view(d) : null }
    })
  }

  // GET /api/home/since: Home's band, from the owner's
  // previous visit; reading it under the owner's credential stamps the visit;
  // an unknown local GET reads without effects
  if (ctx.homeSince) {
    const since = ctx.homeSince
    app.get('/api/home/since', async (req) => since(req))
  }

  app.get('/api/board', async () => {
    // the limit row names its window, and the engine row a fresh verdict,
    // when a reading can be had quickly
    await Promise.race([warmInboxReadings(), new Promise((r) => setTimeout(r, 2000))])
    const { cards, needsYou, silo, inbox } = composeBoard(Date.now())
    return silo && (silo.pulse.length > 0 || silo.done.length > 0 || silo.needsYou.length > 0 || silo.growth.length > 0 || silo.withProducer.length > 0)
      ? {
          cards,
          needsYou,
          inbox,
          silos: {
            pulse: silo.pulse,
            done: silo.done,
            ...(silo.growth.length > 0 ? { growth: silo.growth } : {}),
            ...(silo.withProducer.length > 0 ? { withProducer: silo.withProducer } : {}),
          },
        }
      : { cards, needsYou, inbox }
  })

  // The owner answers an OpenCode agent's permission ask from Home: the
  // reply file the plugin polls for (asks-store.ts). Owner-only: agent
  // bearers never reach a non-allowlisted write (agent-authz.ts). All three
  // segments are path segments — the plugin's own id rule, 400 otherwise;
  // an ask that is gone (answered in the TUI, timed out) is 404 and nothing
  // is written; a second answer while the first still waits is 409.
  if (asks) {
    app.post<{ Params: { agentId: string; sessionId: string; permissionId: string }; Body?: { status?: unknown } }>(
      '/api/asks/:agentId/:sessionId/:permissionId/reply',
      async (req, reply) => {
        const { agentId, sessionId, permissionId } = req.params
        if (![agentId, sessionId, permissionId].every((s) => ASK_ID.test(s))) return reply.code(400).send({ error: 'invalid ask id' })
        const status = req.body?.status
        if (status !== 'allow' && status !== 'deny') return reply.code(400).send({ error: "status must be 'allow' or 'deny'" })
        const result = asks.reply(agentId, sessionId, permissionId, status)
        if (result === 'missing') return reply.code(404).send({ error: 'no such ask — already answered or gone' })
        if (result === 'answered') return reply.code(409).send({ error: 'already answered' })
        if (result === 'invalid') return reply.code(400).send({ error: 'invalid ask' })
        return { ok: true }
      },
    )
  }

  // The owner's Seen on an inbox row: «I know about THIS version».
  // Every row that can be Seen carries `ack: { kind, key,
  // version }` and the page posts it back as is; a changed row (a newer
  // escalation, a new failed run, another day, another message) comes back on
  // its own. Only these kinds are ackable: plan tasks are done in the plan,
  // a silo's records on its page, asks and approvals by answering them.
  // The original body `{ kind: 'escalated', agentId, at }` is still accepted.
  if (needsYouAcks) {
    const ACK_TEXT = /^[^\u0000-\u001f\u007f]+$/
    app.post<{ Body: { kind?: unknown; agentId?: unknown; at?: unknown; key?: unknown; version?: unknown } }>('/api/needs-you/ack', async (req, reply) => {
      const b = req.body ?? {}
      const kind = b.kind
      const key = b.key !== undefined ? b.key : kind === 'escalated' ? b.agentId : undefined
      const version = b.version !== undefined ? b.version : kind === 'escalated' ? b.at : undefined
      if (
        !isAckKind(kind) ||
        typeof key !== 'string' ||
        key === '' ||
        key.length > 300 ||
        !ACK_TEXT.test(key) ||
        typeof version !== 'string' ||
        version === '' ||
        version.length > 64 ||
        !ACK_TEXT.test(version)
      ) {
        return reply.code(400).send({ error: 'invalid ack' })
      }
      // keys name agents, automations or <recipient>/<message>: each segment
      // is a path-segment id
      const segments = key.split('/')
      if (segments.length > (kind === 'message' ? 2 : 1) || segments.some((s) => !PARAM.test(s) || PURE_DOTS.test(s))) {
        return reply.code(400).send({ error: 'invalid ack' })
      }
      needsYouAcks.ack(kind, key, version)
      setImmediate(() => checkInbox())
      return reply.code(204).send()
    })
  }

  // Tasks — the GLOBAL background-work view (c1): every recent
  // session's subagents in one call, so "what is my fleet doing right now"
  // never requires knowing which conversation the work hides in. Bounded to
  // recent sessions (48h) — the census is a readdir per session, and
  // background work older than that isn't "now". Only sessions that HAVE
  // subagents appear; newest background activity first. The per-session
  // census is the same listSubagents the context column already trusts.
  const TASKS_RECENT_MS = 48 * 3600_000
  app.get('/api/tasks', async () => {
    const now = Date.now()
    const resolve = store.titleResolver()
    // recency means BACKGROUND-WORK recency, not conversation recency: an
    // old conversation can host fresh subagents (meta.mtime is the
    // transcript's own content time). A session is a candidate when its
    // transcript OR its subagents dir moved inside the window — one cheap
    // statSync per session, readdir only for candidates.
    const recent = index.allSessions().filter((m) => {
      if (now - m.mtime < TASKS_RECENT_MS) return true
      try {
        return now - statSync(index.sessionDir(m.folder, m.id) + '/subagents').mtimeMs < TASKS_RECENT_MS
      } catch {
        return false // no subagents dir — nothing to list anyway
      }
    })
    const sessions = (
      await Promise.all(
        recent.map(async (m) => {
          const subagents = await index.listSubagents(m.folder, m.id)
          if (subagents.length === 0) return null
          subagents.sort((a, b) => b.mtime - a.mtime)
          const { title } = resolve(m.folder, m.id, m.title)
          return { folder: m.folder, id: m.id, title, agentId: classifyAgentId(m), cwd: m.cwd, mtime: m.mtime, subagents }
        }),
      )
    ).filter((s): s is NonNullable<typeof s> => s !== null)
    sessions.sort((a, b) => (b.subagents[0]?.mtime ?? 0) - (a.subagents[0]?.mtime ?? 0))
    return { sessions }
  })

  // Tools dimension (read) — the global catalog of tools/MCP servers seen
  // across ALL sessions, with who used them. Same single pass as /api/board.
  app.get('/api/tools', async () => {
    const entries = index.allSessions().map((m) => ({
      agentId: classifyAgentId(m),
      tools: index.getContext(m.folder, m.id)?.tools ?? [],
    }))
    return { tools: aggregateTools(entries) }
  })

  // Aggregated artifacts list: what the indexed sessions have PRODUCED
  // (frame-link entries already accumulated by ContextAccumulator, see
  // harnesses/claude-code/context.ts) — the same single in-memory pass as /api/board and
  // /api/tools, no re-parsing. ?agent= scopes to an agent (real
  // classification, native-owner included); ?folder= scopes to a project
  // by its REAL path (the session's cwd inside the folder — same
  // semantics as the ProjectPage); no params = everything. A capped
  // response (200 most recent) with an honest `total` on the side.
  app.get<{ Querystring: { agent?: string; folder?: string } }>('/api/artifacts', async (req, reply) => {
    const { agent, folder } = req.query
    if (agent !== undefined && registry.get(agent) === null) {
      return reply.code(404).send({ error: 'agent not found' })
    }
    if (folder !== undefined && !folder.startsWith('/')) {
      return reply.code(400).send({ error: 'invalid folder (absolute path required)' })
    }
    const resolve = store.titleResolver()
    const entries = index.allSessions().map((m) => ({
      folder: m.folder,
      id: m.id,
      cwd: m.cwd,
      agentId: classifyAgentId(m),
      sessionTitle: resolve(m.folder, m.id, m.title).title,
      artifacts: index.getContext(m.folder, m.id)?.links.artifacts ?? [],
    }))
    return aggregateArtifacts(entries, { agent, folder })
  })
}
