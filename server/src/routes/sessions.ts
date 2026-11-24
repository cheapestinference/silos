// routes/sessions.ts — the conversations' own surface: the overview, a
// session's detail/documents/started-with refs, the machine account,
// claude-settings (retention + the Silos hooks install), and the four
// session gestures (answer, rename, move owner, trash), moved VERBATIM
// out of server.ts (split the monoliths by domain,
// behavior unchanged). The session vocabulary (view, validParams,
// threadHistoryOf, absorbRotations, countsNow, consoleKeyFor,
// threadRootKey, enrichInterSession) stays in buildServer — the WS scope
// and console routes share it — and rides the ctx. SessionView still
// lives in server.ts: importing it back type-only is cycle-safe (erased
// at emit).
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { join, sep } from 'node:path'
import type { FastifyInstance, FastifyReply } from 'fastify'
import { capSessionsByKind } from '../overview-cap.js'
import { countSessions, emptyCounts, type SessionCounts } from '../session-counts.js'
import { conversationalMessage } from '../harnesses/claude-code/parser.js'
import { readTurnsOf } from '../harnesses/claude-code/reader.js'
import { sliceWholeFile } from '../jsonl-lines.js'
import { describeHolders, isSilosConsole, type SessionHolder } from '../harnesses/claude-code/holders.js'
import { extractImage, MEDIA_REF_RE } from '../harnesses/claude-code/media.js'
import {
  readClaudeSettings,
  writeCleanupPeriodDays,
  writeAgentPushNotif,
  writeTodoTools,
  installSilosHooks,
  uninstallSilosHooks,
  KEEP_FOREVER_DAYS,
} from '../harnesses/claude-code/settings.js'
import { PLUGIN_HOOKS_DIR } from '../repo-paths.js'
import { ledgerPathsOf } from '../execution-store.js'
import { inboxCounts, type MessageStore } from '../messages.js'
import { runCauseIndex } from '../run-cause.js'
import { openFactsOf } from '../open-surface.js'
import { harnessById, harnessForId } from '../harnesses/registry.js'
import type { HarnessId, HarnessServerHooks } from '../harnesses/contract.js'
import type { ExecutionsSource } from '../silos/executions.js'
import type { WorktreeRecords } from '../silos/worktrees.js'
import type { PendingResumesStore } from '../pending-resumes-store.js'
import type { AutomationsStore } from '../automations-store.js'
import type { TranscriptTurn, AgentMessage, SessionContext, SessionMeta } from '../types.js'
import type { SessionView, ConversationProcess } from '../server.js'
import type { StopResult } from '../silos/processes.js'
import type { SessionIndex } from '../session-index.js'
import type { SessionStore } from '../session-store.js'
import type { SessionOwners } from '../session-owner.js'
import type { LineageStore } from '../lineage.js'
import type { NativeStore } from '../native-store.js'
import type { AgentRegistry } from '../agent-registry.js'
import type { ChatService } from '../chat-service.js'
import type { TerminalService } from '../terminal-service.js'
import type { AccountsService } from '../harnesses/claude-code/accounts.js'
import type { ThreadIdOf } from '../task-threads.js'
import { dropContextNews } from '../context-news.js'

type SessionParams = { folder: string; id: string }

export interface SessionRoutesCtx {
  /** the servers' status readings (tool-health.ts): a trashed conversation is not counted */
  toolHealth?: { forget(conversation: string, folder?: string): void }
  index: SessionIndex
  store: SessionStore
  registry: AgentRegistry
  owners: SessionOwners
  lineage: LineageStore | undefined
  native: NativeStore
  chat: ChatService
  terminals: TerminalService
  // the one «which conversation is this session?» resolver (task-threads.ts)
  // and the data dir: a deleted conversation drops its queued context news
  threadIdOf: ThreadIdOf
  dataDir: string | undefined
  accounts: AccountsService | undefined
  messages: MessageStore | undefined
  pendingResumes: PendingResumesStore | undefined
  automations: AutomationsStore | undefined
  executions: Pick<ExecutionsSource, 'forSession'> | undefined
  // the System silo's worktree records: the header's branch state (merged / N
  // not in the default branch), read from the table in memory. Absent: none.
  worktrees?: Pick<WorktreeRecords, 'branchStateFor'>
  hooks: (id: HarnessId) => HarnessServerHooks
  view: (
    m: SessionMeta,
    now: number,
    resolve?: ReturnType<SessionStore['titleResolver']>,
    causeOf?: (sessionId: string, born: { automationId: string; runId: string } | null) => string | null,
  ) => SessionView
  validParams: (p: SessionParams, reply: FastifyReply) => boolean
  threadHistoryOf: (m: SessionMeta) => SessionMeta[]
  threadRootKey: (m: SessionMeta) => string
  enrichInterSession: (t: TranscriptTurn) => TranscriptTurn
  absorbRotations: () => void
  countsNow: () => Record<string, SessionCounts>
  consoleKeyFor: (m: SessionMeta) => Promise<string>
  // live Claude Code sessions' names (`silos-35`) → their conversation
  peers?: { bySession(): Map<string, { name: string; sessionId: string }> }
  classifyAgentId: (m: SessionMeta) => string
  broadcast: (msg: unknown) => void
  claudeSettingsPath: string
  backupsDir: string
  webDist: string | undefined
  // the home this server works in (server.ts machineHome: SILOS_HOME, else
  // the OS home) — reported to the web, which roots the Files page at it
  home: string
  // the DERIVED control of an agent (control.ts controlOf) — the overview
  // carries it as `controlNow`, the one the web's doors read (give.ts)
  controlOf?: (agentId: string) => 'told' | 'own'
  // the three positions: the roster's marker
  positionOf?: (agentId: string) => 'told' | 'own' | 'proactive'
  // a conversation's processes (the System silo, server.ts): the live
  // records of its thread, and the one engine call that stops a record
  processes?: {
    of(m: SessionMeta): ConversationProcess[]
    stop(recordId: string, by: string): Promise<StopResult>
  }
}

// What the trash's «also stop» did, said: each record stopped (its words),
// each not stopped (why), and one line for the whole.
export interface StopTheirs {
  stopped: Array<{ id: string; key: string; command: string; outcome: string; says: string }>
  notStopped: Array<{ id: string; key: string; command: string; why: string }>
  says: string
}

export function sessionRoutes(app: FastifyInstance, ctx: SessionRoutesCtx): void {
  // every stoppable record at once (each stop awaits its own short grace);
  // a record the engine refuses is said with its reason
  const stopTheirs = async (recs: ConversationProcess[], o: { tip: boolean; engine: boolean }): Promise<StopTheirs> => {
    if (!o.engine) return { stopped: [], notStopped: [], says: 'nothing stopped — this Silos reads no processes here' }
    if (!o.tip)
      return { stopped: [], notStopped: [], says: 'nothing stopped — this is not where its thread continues, and burying history never stops live work' }
    const out: StopTheirs = { stopped: [], notStopped: [], says: '' }
    await Promise.all(
      recs.map(async (p) => {
        if (!p.stoppable) {
          out.notStopped.push({
            id: p.id,
            key: p.key,
            command: p.command,
            why: p.origin === 'silos' ? 'it is Silos itself' : p.origin === 'other-user' ? 'it runs as another user' : 'Silos may not stop it',
          })
          return
        }
        const r = await ctx.processes!.stop(p.id, 'owner')
        if (!r.ok) out.notStopped.push({ id: p.id, key: p.key, command: p.command, why: r.reason })
        else if (r.value.outcome === 'partial') out.notStopped.push({ id: p.id, key: p.key, command: p.command, why: r.value.says })
        else out.stopped.push({ id: p.id, key: p.key, command: p.command, outcome: r.value.outcome, says: r.value.says })
      }),
    )
    const n = (k: number, w: string): string => `${k} ${w}${k === 1 ? '' : 'es'}`
    out.says =
      recs.length === 0
        ? 'it had no processes running'
        : [
            out.stopped.length > 0 ? `stopped ${n(out.stopped.length, 'process')}` : 'stopped nothing',
            ...(out.notStopped.length > 0 ? [`${out.notStopped.length} not stopped: ${out.notStopped.map((x) => `${x.command} — ${x.why}`).join('; ')}`] : []),
          ].join(' · ')
    return out
  }
  const {
    index,
    store,
    registry,
    owners,
    lineage,
    native,
    chat,
    terminals,
    threadIdOf,
    accounts,
    messages,
    pendingResumes,
    automations,
    executions,
    worktrees,
    hooks,
    view,
    validParams,
    threadHistoryOf,
    threadRootKey,
    enrichInterSession,
    absorbRotations,
    countsNow,
    consoleKeyFor,
    classifyAgentId,
    broadcast,
    claudeSettingsPath,
    backupsDir,
    webDist,
    home,
  } = ctx
  // a trashed conversation leaves the tool-health counts (its reading, what
  // it gave a failing run); its start notice leaves with its listing
  const forgetHealth = (id: string, cwd?: string): void => {
    try {
      ctx.toolHealth?.forget(id, cwd)
    } catch (err) {
      console.warn('tool-health: a trashed conversation was not forgotten:', err instanceof Error ? err.message : String(err))
    }
  }
  const { ancestorIdsOf } = owners.ancestry
  // A conversation as the owner knows it — its TITLE — from what agents
  // write about it: a Claude Code session name (`silos-35`, live sessions
  // only) or a session id. The web links each one it can resolve and shows
  // the title instead of the bare token (the owner reads the conversation's
  // title, never a dull session id). Unknown tokens are
  // simply absent: nothing is linked to a conversation that isn't there.
  const REF_NAME = /^[a-z0-9][a-z0-9_.-]{0,80}$/
  // the shape of any session id a task may hold — the same neutral form the
  // claim validates (routes/console.ts CLAIM_SESSION_ID): never one
  // engine's prefix, so a second engine's ids resolve too. The lookup is a
  // Map over the index; a wider shape opens nothing.
  const REF_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/
  app.get<{ Querystring: { names?: string; ids?: string } }>('/api/conversation-refs', async (req) => {
    const list = (raw: string | undefined, re: RegExp): string[] =>
      [
        ...new Set(
          (raw ?? '')
            .split(',')
            .map((x) => x.trim())
            .filter((x) => re.test(x)),
        ),
      ].slice(0, 100)
    const names = list(req.query.names, REF_NAME)
    const ids = list(req.query.ids, REF_ID)
    const metas = new Map<string, SessionMeta>()
    if (names.length + ids.length > 0) for (const m of index.allSessions()) metas.set(m.id, m)
    // the title the sidebar shows: a rename, else the auto title, else the raw one
    const resolve = names.length + ids.length > 0 ? store.titleResolver() : null
    const describe = (sessionId: string, live: boolean) => {
      const m = metas.get(sessionId)
      return m && resolve ? { sessionId, folder: m.folder, agentId: classifyAgentId(m), title: resolve(m.folder, m.id, m.title).title, live } : null
    }
    const refs: Record<string, ReturnType<typeof describe>> = {}
    if (names.length > 0) {
      // the same address book the sidebar's hover uses (peer-registry.ts)
      const named = new Map<string, { sessionId: string }>()
      try {
        for (const p of ctx.peers?.bySession().values() ?? []) named.set(p.name, { sessionId: p.sessionId })
      } catch {
        /* no locks readable */
      }
      for (const n of names) {
        const hit = named.get(n)
        const r = hit ? describe(hit.sessionId, true) : null
        if (r) refs[n] = r
      }
    }
    for (const id of ids) {
      const r = describe(id, false)
      if (r) refs[id] = r
    }
    return { refs }
  })

  app.get('/api/overview', async () => {
    absorbRotations()
    const now = Date.now()
    const resolve = store.titleResolver() // a single overrides.json read for every session
    // Providers v1: onFallback travels with the agent in the overview — the
    // "on fallback · resumes HH:MM" badge in the conversation and the
    // Board derives from here (ChatService's in-memory state, an optional
    // call for fakes).
    const agents = registry.list().map((a) => {
      const onFallback = chat.fallbackStateOf?.(a.id) ?? null
      // what waits in its inbox (messages.ts): `new` unread
      const inbox = messages ? inboxCounts(messages.list(a.id, 'new')) : null
      return {
        ...a,
        ...(onFallback ? { onFallback } : {}),
        ...(inbox ? { inbox } : {}),
        sessions: [] as SessionView[],
        liveCount: 0,
        sessionCount: 0,
        counts: emptyCounts(),
      }
    })
    const byId = new Map(agents.map((a) => [a.id, a]))
    const all: SessionView[] = []
    const causeOf = automations ? runCauseIndex(automations) : undefined // one automations scan per overview
    // who has a console in the index (open-surface.ts): «Open» goes there
    const consoles = new Set<string>()
    for (const m of index.allSessions()) {
      const v = view(m, now, resolve, causeOf)
      all.push(v)
      byId.get(v.agentId)?.sessions.push(v)
      if (m.console === true) consoles.add(v.agentId)
    }
    // totals BEFORE the cap (session-counts.ts): every surface that prints
    // "N conversations" / "N runs" reads these, never a capped list's length
    const counts = countSessions(all, new Set(all.map((v) => v.id)))
    for (const a of agents) {
      a.sessions.sort((x, y) => y.mtime - x.mtime)
      a.counts = counts.get(a.id) ?? emptyCounts()
      a.sessionCount = a.counts.conversations + a.counts.runs + (a.counts.messageConversations ?? 0)
      a.liveCount = a.sessions.filter((s) => s.live).length
      // trimmed by KIND (overview-cap.ts): one cap over the newest 40 let an
      // hourly automation's runs push every human conversation off the end.
      a.sessions = capSessionsByKind(a.sessions)
    }
    // where «Open» goes and the DERIVED control — the
    // facts the web's doors say their words from (give.ts), one source
    const out = agents.map((a) => ({
      ...a,
      open: openFactsOf(a, consoles),
      ...(ctx.controlOf ? { controlNow: ctx.controlOf(a.id) } : {}),
      ...(ctx.positionOf ? { positionNow: ctx.positionOf(a.id) } : {}),
    }))
    // the stale-tab banner's server half: announce which build the static
    // dist is, re-read per request (same per-request rule as the assets —
    // a new `vite build` lands under a running server, no restart). The
    // client compares against the id its own bundle was stamped with
    // (web/src/lib/build.ts) and offers a reload on mismatch.
    const build = servedBuildId()
    return { agents: out, now, warming: !index.isReady(), home, ...(build ? { build } : {}) }
  })

  function servedBuildId(): string | null {
    if (!webDist) return null
    try {
      const raw = JSON.parse(readFileSync(join(webDist, 'build-id.json'), 'utf8')) as { id?: unknown }
      return typeof raw.id === 'string' ? raw.id : null
    } catch {
      return null // no file (old build, tests) → the field just stays absent
    }
  }

  app.get<{ Params: SessionParams; Querystring: { since?: string } }>('/api/sessions/:folder/:id', async (req, reply) => {
    if (!validParams(req.params, reply)) return
    const meta = index.getMeta(req.params.folder, req.params.id)
    if (!meta) return reply.code(404).send({ error: 'session not found' })
    const since = Number.parseInt(req.query.since ?? '0', 10) || 0
    const all: TranscriptTurn[] = await index.readTurns(req.params.folder, req.params.id)
    const ctx = enrichOutbound(index.getContext(req.params.folder, req.params.id))
    const ex = executions?.forSession(req.params.folder, req.params.id, ledgerPathsOf(ctx?.files ?? []), meta.cwd ? [meta.cwd] : []) ?? null
    // The context (plan/subagents/pending/...) always goes in full — it's
    // cheap (state already accumulated in memory, `since` only filters turns).
    return {
      meta: view(meta, Date.now()),
      turns: all.filter((t) => t.index >= since).map(enrichInterSession),
      total: all.length,
      context: ctx,
      // the execution record: the ledger this session wrote or named, read
      // (or Silos' copy of it once the worktree is gone) with its plan doc —
      // the SAME record the Executions silo lists for this conversation —
      // and the plan task it hangs from
      execution: ex?.record ?? null,
      executionTask: ex?.task ?? null,
      // its branch, judged by the worktree record it works in: is its work in
      // the default branch? null: no record (the main checkout…) — the
      // header shows the branch alone
      branchState: worktrees?.branchStateFor({ session: req.params.id, cwd: meta.cwd ?? null, branch: ctx?.flags.gitBranch ?? null }) ?? null,
      // the disk census of background work (subagents dir) — the context's
      // own agents tracking misses a backgrounded skill's children, see
      // DiskSubagent in types.ts.
      subagents: await index.listSubagents(req.params.folder, req.params.id),
      // the claudes holding this conversation open RIGHT NOW and the account
      // each one really spends (its live CLAUDE_CONFIG_DIR) — the truth the
      // column shows beside the pinned account; two = open twice
      running: runningOf(req.params.id),
      // the provider the install's unattended switch ran this conversation's
      // last unattended turn on — the column's «on <provider> ·
      // unattended setting»; null: its last unattended turn ran on the
      // agent's own (or none ran since the server started)
      unattendedOn: chat.unattendedProviderOf?.(req.params.id) ?? null,
    }
  })

  // an inter-agent message's LIVE state (proof of life): the column says
  // whether the inbox message this conversation POSTed is still unread —
  // joined here at read time from the message store, on a COPY, never
  // written into the cached context. 'gone' = the stored message no longer
  // exists (inboxes prune delivered messages after 30 days).
  function enrichOutbound(ctx: SessionContext | null): SessionContext | null {
    if (!ctx?.outbound?.length || !messages) return ctx
    return {
      ...ctx,
      outbound: ctx.outbound.map((o) => {
        if (o.kind !== 'message' || o.messageId === undefined) return { ...o }
        let m: AgentMessage | null = null
        try {
          m = messages.get(o.to, o.messageId)
        } catch {
          m = null
        }
        return { ...o, state: m?.state ?? 'gone', ...(m?.answer !== undefined ? { answer: m.answer } : {}) }
      }),
    }
  }

  // a holder's account: its CLAUDE_CONFIG_DIR matched against the known
  // account dirs (unset = the machine's own login). An unknown dir is said
  // as itself — never folded into an account it is not.
  function runningOf(sessionId: string): Array<{ pid: number; providerId: string | null; configDir: string | null; silos: boolean; tmux: string | null }> {
    let holders: SessionHolder[]
    try {
      holders = terminals.holderDetailsOf(sessionId)
    } catch {
      return []
    }
    if (holders.length === 0) return []
    const real = (p: string): string => {
      try {
        return realpathSync(p)
      } catch {
        return p
      }
    }
    const dirs = (accounts?.configDirs() ?? []).map((a) => ({ id: a.name === 'default' ? 'default' : `account:${a.name}`, dir: real(a.configDir) }))
    return holders.map((h) => {
      const dir = h.configDir === null ? null : real(h.configDir)
      const match = dir === null ? dirs.find((d) => d.id === 'default') : dirs.find((d) => d.dir === dir)
      return { pid: h.pid, providerId: match ? match.id : dir === null ? 'default' : null, configDir: dir, silos: isSilosConsole(h), tmux: h.tmux }
    })
  }

  // Media types a pasted document may render INLINE as (c7): inert formats
  // only — never text/html or anything scriptable, because the value comes
  // from the transcript (untrusted). Everything else is served as an
  // opaque download.
  const INERT_DOC_TYPES = new Set(['application/pdf', 'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'text/plain'])

  // Raw document viewer (c7) — the idx-th document block pasted into the
  // conversation, decoded, served with its real media type so the browser
  // renders it (PDFs natively). The transcript carries NO filename: the
  // order of appearance is the address, the same order ContextAccumulator
  // lists in SessionContext.documents. Read-only over the session's own
  // JSONL — validParams closes traversal, the index bound closes scans.
  app.get<{ Params: SessionParams & { idx: string } }>('/api/sessions/:folder/:id/documents/:idx', async (req, reply) => {
    if (!validParams(req.params, reply)) return
    if (!/^\d{1,3}$/.test(req.params.idx)) return reply.code(400).send({ error: 'invalid document index' })
    const idx = Number.parseInt(req.params.idx, 10)
    const file = index.sessionDir(req.params.folder, req.params.id) + '.jsonl'
    if (!existsSync(file)) return reply.code(404).send({ error: 'session not found' })
    let seen = 0
    // read in slices (jsonl-lines.ts): a long transcript never freezes the loop
    let found: { media_type: string; data: string } | null = null
    await sliceWholeFile(file, (lines) => {
      if (found) return
      for (const line of lines) {
        if (!line.includes('"document"')) continue
        let e: Record<string, unknown>
        try {
          e = JSON.parse(line) as Record<string, unknown>
        } catch {
          continue
        }
        const content = conversationalMessage(e)?.content // same records ContextAccumulator numbers — a request blob never shifts the index
        if (!Array.isArray(content)) continue
        for (const b of content) {
          if (typeof b !== 'object' || b === null) continue
          const d = b as { type?: unknown; source?: { media_type?: unknown; data?: unknown } }
          if (d.type !== 'document' || typeof d.source?.media_type !== 'string' || typeof d.source.data !== 'string') continue
          if (seen === idx) {
            found = { media_type: d.source.media_type, data: d.source.data }
            return
          }
          seen++
        }
      }
    })
    const d = found as { media_type: string; data: string } | null
    if (d) {
      // the media_type comes from the TRANSCRIPT — untrusted content.
      // Echoing it verbatim would let a text/html document execute as
      // the Silos origin (XSS). Only inert types render inline; any
      // other type downloads as an opaque attachment. nosniff + a
      // sandboxing CSP on every response, rendered or not.
      const mediaType = INERT_DOC_TYPES.has(d.media_type) ? d.media_type : 'application/octet-stream'
      void reply.header('x-content-type-options', 'nosniff').header('content-security-policy', "default-src 'none'; sandbox")
      if (mediaType === 'application/octet-stream') void reply.header('content-disposition', 'attachment')
      return reply.header('content-type', mediaType).send(Buffer.from(d.data, 'base64'))
    }
    return reply.code(404).send({ error: 'document not found' })
  })

  // Transcript of a subagent (Agent tool) — root/folder/id/subagents/
  // agent-<agentId>.jsonl. agentId validated by regex (can never smuggle
  // '/' or '..') and, in addition, the resolved path is checked by
  // REALPATH against the session directory (defense in depth against symlinks).
  const AGENT_ID = /^[a-f0-9]{8,32}$/
  // Resolve a subagent's transcript file, validating params + agentId and — the
  // security-relevant part — checking the REALPATH is contained in the session
  // directory (defense in depth against symlinks). Returns the resolved real
  // path, or null AFTER sending the right error. The transcript and media
  // subagent routes share it verbatim; a fix to this guard now lands in one place.
  const resolveSubagentFile = (params: SessionParams & { agentId: string }, reply: FastifyReply): string | null => {
    if (!validParams(params, reply)) return null
    if (!AGENT_ID.test(params.agentId)) {
      void reply.code(400).send({ error: 'invalid agentId' })
      return null
    }
    if (!index.getMeta(params.folder, params.id)) {
      void reply.code(404).send({ error: 'session not found' })
      return null
    }
    const sessionDir = index.sessionDir(params.folder, params.id)
    const filePath = findSubagentFile(join(sessionDir, 'subagents'), `agent-${params.agentId}.jsonl`)
    if (filePath === null) {
      void reply.code(404).send({ error: 'subagent not found' })
      return null
    }
    let realFile: string, realDir: string
    try {
      realFile = realpathSync(filePath)
      realDir = realpathSync(sessionDir)
    } catch {
      void reply.code(404).send({ error: 'subagent not found' })
      return null
    }
    if (realFile !== realDir && !realFile.startsWith(realDir + sep)) {
      void reply.code(400).send({ error: 'path outside the session directory' })
      return null
    }
    return realFile
  }
  app.get<{ Params: SessionParams & { agentId: string } }>('/api/sessions/:folder/:id/subagents/:agentId', async (req, reply) => {
    const realFile = resolveSubagentFile(req.params, reply)
    if (!realFile) return reply
    const turns = (await readTurnsOf(realFile)).map(enrichInterSession)
    return { turns }
  })

  // On-demand turn image: the parser emits only METADATA with a ref
  // (`t.<toolUseId>.<n>` / `u.<uuid>.<n>`) and this route re-extracts the
  // base64 from the JSONL when the browser's lazy <img> requests it (see
  // harnesses/claude-code/media.ts, the full data path). Immutable response: the JSONL is
  // append-only, an already-written ref's content never changes — the
  // browser caches it and a second scroll re-scans nothing.
  const serveMedia = async (filePath: string, ref: string, reply: FastifyReply): Promise<unknown> => {
    if (!MEDIA_REF_RE.test(ref)) return reply.code(400).send({ error: 'invalid ref' })
    const img = await extractImage(filePath, ref)
    if (!img) return reply.code(404).send({ error: 'image not found' })
    // nosniff as defense in depth — harnesses/claude-code/media.ts's raster allowlist is the
    // layer that backs this guarantee up (a declared scriptable
    // content-type isn't "sniffed", it's ASSERTED: nosniff alone wouldn't
    // be enough), this also stops the browser from reinterpreting a
    // non-raster block's octet-stream.
    return reply
      .header('content-type', img.mediaType)
      .header('x-content-type-options', 'nosniff')
      .header('cache-control', 'private, max-age=31536000, immutable')
      .send(img.buf)
  }

  app.get<{ Params: SessionParams & { ref: string } }>('/api/sessions/:folder/:id/media/:ref', async (req, reply) => {
    if (!validParams(req.params, reply)) return
    if (!index.getMeta(req.params.folder, req.params.id)) return reply.code(404).send({ error: 'session not found' })
    return serveMedia(index.pathOf(req.params.folder, req.params.id), req.params.ref, reply)
  })

  // Same extraction for a SUBAGENT's transcript — 21 of the real corpus'
  // 31 files with images are subagents/*.jsonl (E2E agent screenshots), so
  // this path matters MORE than the main session's. Same path defenses as
  // the subagents route.
  app.get<{ Params: SessionParams & { agentId: string; ref: string } }>('/api/sessions/:folder/:id/subagents/:agentId/media/:ref', async (req, reply) => {
    const realFile = resolveSubagentFile(req.params, reply)
    if (!realFile) return reply
    return serveMedia(realFile, req.params.ref, reply)
  })

  // Who the machine's own Claude account is signed in as — Claude's answer
  // to `claude auth status --json` (auth-status.ts), kept a short while.
  // null = signed out (or no accounts service: nothing to ask).
  app.get('/api/account', async () => {
    const id = await accounts?.machineIdentity()
    return id?.loggedIn ? { email: id.email, plan: id.plan, organizationName: id.organizationName } : null
  })

  // Claude Code transcript retention. Only ONE editable key; the rest of
  // the file is untouched.
  app.get('/api/claude-settings', async () => ({ ...readClaudeSettings(claudeSettingsPath), keepForeverDays: KEEP_FOREVER_DAYS }))
  app.put<{ Body: { cleanupPeriodDays?: unknown; agentPushNotifEnabled?: unknown; todoTools?: unknown } }>('/api/claude-settings', async (req, reply) => {
    const v = req.body?.cleanupPeriodDays
    const push = req.body?.agentPushNotifEnabled
    const todo = req.body?.todoTools
    try {
      if (typeof push === 'boolean') return writeAgentPushNotif(claudeSettingsPath, push, backupsDir)
      if (typeof todo === 'boolean') return writeTodoTools(claudeSettingsPath, todo, backupsDir)
      if (typeof v === 'number') return writeCleanupPeriodDays(claudeSettingsPath, v, backupsDir)
      return reply.code(400).send({ error: 'cleanupPeriodDays, agentPushNotifEnabled or todoTools required' })
    } catch (e) {
      return reply.code(400).send({ error: e instanceof Error ? e.message : 'could not write settings.json' })
    }
  })

  // Wires the Silos hooks (SessionStart briefing + CronCreate gate) into
  // ~/.claude/settings.json — additive and idempotent; scripts live in
  // this repo's plugin/hooks.
  app.post('/api/claude-settings/hooks', async (_req, reply) => {
    try {
      return installSilosHooks(claudeSettingsPath, backupsDir, PLUGIN_HOOKS_DIR)
    } catch (e) {
      return reply.code(400).send({ error: e instanceof Error ? e.message : 'could not write settings.json' })
    }
  })

  // The way out: removes those two entries and nothing else (a backup
  // first). Without it, deleting the Silos folder left every Claude Code
  // session on the machine logging a hook error.
  app.delete('/api/claude-settings/hooks', async (_req, reply) => {
    try {
      return uninstallSilosHooks(claudeSettingsPath, backupsDir)
    } catch (e) {
      return reply.code(400).send({ error: e instanceof Error ? e.message : 'could not write settings.json' })
    }
  })

  // Answer an open AskUserQuestion — ONE action, the server picks the
  // engine (the razor, docs/product.md): a conversation with a running
  // console gets the option typed into its claude (digit + Enter, the TUI's
  // own gesture); otherwise the caller sends the label as a chat turn.
  // `answers` (optional): the form's picks for a question with several
  // parts or several answers — one label list per question. A harness that
  // answers in place takes them (OpenCode's question tool); without one,
  // they go as a chat turn (`engine: 'chat'`, the client composes it):
  // digits typed into a console answer one question only.
  app.post<{ Params: SessionParams; Body: { index?: unknown; answers?: unknown } }>('/api/sessions/:folder/:id/answer', async (req, reply) => {
    const { folder, id } = req.params
    const opt = req.body?.index
    if (typeof opt !== 'number' || !Number.isInteger(opt) || opt < 0 || opt > 8) return reply.code(400).send({ error: 'index must be 0–8' })
    const raw = req.body?.answers
    if (
      raw !== undefined &&
      !(
        Array.isArray(raw) &&
        raw.length > 0 &&
        raw.length <= 10 &&
        raw.every((a) => Array.isArray(a) && a.length > 0 && a.length <= 20 && a.every((x) => typeof x === 'string' && x.trim() !== '' && x.length <= 2000))
      )
    ) {
      return reply.code(400).send({ error: 'answers must be one non-empty list of labels per question' })
    }
    const answers = raw as string[][] | undefined
    const meta = index.getMeta(folder, id)
    if (!meta) return reply.code(404).send({ error: 'session not found' })
    // A harness with its own way of answering (Harness.server answer —
    // OpenCode's permission asks, answered through the ask file its plugin
    // polls) takes it: the session's harness, else its live console's.
    const answerOf = (h: HarnessId | undefined) => (h === undefined ? undefined : hooks(h).answer)
    const answer = answerOf(meta.harness) ?? answerOf(terminals.consoleRecord(terminals.keyOfNativeId(id) ?? id)?.harness)
    if (answer) {
      const r = await answer(meta, id, opt, answers)
      return reply.code(r.code).send(r.body)
    }
    if (answers !== undefined) return { engine: 'chat' as const }
    const key = await consoleKeyFor(meta)
    if (!(await terminals.hasConsole(key))) return { engine: 'chat' as const }
    await terminals.consoleSendKeys(key, [String(opt + 1), 'Enter'])
    return { engine: 'console' as const, key }
  })

  app.post<{ Params: SessionParams; Body: { title?: string } }>('/api/sessions/:folder/:id/rename', async (req, reply) => {
    if (!validParams(req.params, reply)) return
    if (!index.getMeta(req.params.folder, req.params.id)) return reply.code(404).send({ error: 'session not found' })
    const title = typeof req.body?.title === 'string' ? req.body.title : ''
    store.rename(req.params.folder, req.params.id, title)
    index
      .refresh(req.params.folder, req.params.id) // re-emits meta → WS
      .catch(() => {}) // the file can disappear between the rename and the refresh; the next fs event reconciles
    return { ok: true, title }
  })

  // `{ thread: true }` (the sidebar's Delete) buries the whole thread —
  // see threadHistoryOf. Without it, one session moves: Settings ›
  // Maintenance buries history one row at a time, on purpose.
  // Move a thread to another agent — an OPERATOR door with no UI on
  // purpose (review: it is a rare repair gesture, one wrong-agent
  // console every few weeks; a visible button would invite re-labelling
  // history). The documented way to use it is by hand:
  //   curl -X POST 127.0.0.1:3210/api/sessions/<folder>/<id>/owner \
  //        -H 'content-type: application/json' -d '{"agentId":"finance"}'
  // Writes the birth record, which outranks classify-by-transcript in
  // session-owner.ts; descendants already stamped in lineage keep their
  // owner (same rule as everywhere else). Owner-only: agent bearers never
  // reach a non-allowlisted write.
  app.post<{ Params: SessionParams; Body?: { agentId?: unknown } }>('/api/sessions/:folder/:id/owner', async (req, reply) => {
    if (!validParams(req.params, reply)) return
    const agentId = typeof req.body?.agentId === 'string' ? req.body.agentId : ''
    const agent = registry.get(agentId)
    if (!agent || agent.archived) return reply.code(404).send({ error: `unknown agent: ${agentId || '(none)'}` })
    const meta = index.allSessions().find((m) => m.folder === req.params.folder && m.id === req.params.id)
    if (!meta) return reply.code(404).send({ error: 'session not found' })
    native.register(req.params.folder, req.params.id, { agentId, createdAt: new Date().toISOString() })
    broadcast({ ev: 'session', meta: view(meta, Date.now()), counts: countsNow() })
    return { ok: true, agentId }
  })
  // GET /api/sessions/:folder/:id/processes — what this conversation left
  // running on the machine (the System silo's kernel kind `process`): the
  // live (running, left) records of its WHOLE thread — a /clear rotates the
  // id, the processes keep the one they were born with —, each with its
  // record key (the record page), its state in words, its numbers at most
  // one scan old, and whether it may be stopped. The conversation's column
  // and the delete dialog read it. The owner's, like every session read
  // (an agent bearer is refused by agent-authz.ts).
  app.get<{ Params: SessionParams }>('/api/sessions/:folder/:id/processes', async (req, reply) => {
    if (!validParams(req.params, reply)) return
    const meta = index.getMeta(req.params.folder, req.params.id)
    if (!meta) return reply.code(404).send({ error: 'no such conversation' })
    return { processes: ctx.processes ? ctx.processes.of(meta) : [] }
  })
  // Deleting a conversation, on every engine. What deleting MEANS is the
  // engine's (`traits.deletion`): the fallback's JSONL moves to the trash;
  // another engine's session lives in a database Silos never writes, so it
  // is HIDDEN (harnesses/opencode/hidden.ts). The rest is neutral and keyed
  // by the conversation, the same on both paths (the hide path used
  // to return before it, so a ticked «Also stop them» did nothing and its
  // console kept running):
  //   · the thread's tip is measured once (isThreadTipOf);
  //   · its live Silos console(s) close — rule: no live console for a
  //     deleted conversation (closeConsolesOf);
  //   · the processes to stop are named while the index still knows the
  //     conversation, and stopped only after the delete succeeded (a refused
  //     or failed delete stops nothing).
  // "the tip" is the thread's most recently ACTIVE session, measured from
  // its root (the console key): a stale fork with no descendant of its own
  // is NOT the tip, and trashing it killed the thread's live console — the
  // owner's own, about to happen with the bug-born twin "hi".
  // Without lineage, the no-descendant rule stands. A session no thread
  // continues from (no lineage) is its own tip.
  const isThreadTipOf = (id: string, meta: SessionMeta | null): boolean => {
    const hasDescendant = index.allSessions().some((m2) => m2.id !== id && ancestorIdsOf(m2, true).includes(id))
    if (hasDescendant) return false
    if (!meta || !lineage) return true
    const mtimes = new Map(index.allSessions().map((m) => [`${m.folder}/${m.id}`, m.mtime]))
    return lineage.recentTipOf(threadRootKey(meta), (k) => mtimes.get(k) ?? null) === `${meta.folder}/${meta.id}`
  }
  // Every live console that writes this conversation: keyed by its own id,
  // by the ancestor whose console continued into it after a /clear
  // (consoleKeyFor), or by a Silos key bound to its native id (an engine
  // that mints its own session ids — the console is born before the id).
  const closeConsolesOf = async (id: string, meta: SessionMeta | null): Promise<void> => {
    const bound = terminals.keyOfNativeId(id)
    const keys = new Set([id, ...(meta ? [await consoleKeyFor(meta)] : []), ...(bound ? [bound] : [])])
    for (const k of keys) await terminals.killConsoleAndWait(k)
  }
  // a deleted conversation's pending context news (context-news.ts) goes with it
  const dropNewsOf = (id: string): void => {
    if (ctx.dataDir !== undefined) dropContextNews(ctx.dataDir, threadIdOf(id))
  }
  app.post<{ Params: SessionParams; Body?: { thread?: boolean; closeHolders?: boolean; stopProcesses?: boolean } }>(
    '/api/sessions/:folder/:id/trash',
    async (req, reply) => {
      if (!validParams(req.params, reply)) return
      // «Also stop its processes» — explicit, never automatic. Only the delete
      // that tears the conversation down (its thread's tip) stops anything;
      // burying an ancestor row stops nothing.
      const stopAsked = req.body?.stopProcesses === true
      const namedToStop = (tip: boolean, meta: SessionMeta | null): ConversationProcess[] =>
        stopAsked && tip && meta && ctx.processes ? ctx.processes.of(meta) : []
      const stopAfter = async (tip: boolean, recs: ConversationProcess[]) =>
        stopAsked ? { processes: await stopTheirs(recs, { tip, engine: ctx.processes !== undefined }) } : {}
      if (harnessById(harnessForId(req.params.id)).traits.deletion !== 'trash') {
        // HIDE: no JSONL to move, no claude lock — nothing writes it back.
        const meta = index.getMeta(req.params.folder, req.params.id)
        if (!meta) return reply.code(404).send({ error: 'session not found' })
        const tip = isThreadTipOf(req.params.id, meta)
        if (tip) await closeConsolesOf(req.params.id, meta)
        if (tip) dropNewsOf(req.params.id)
        const toStop = namedToStop(tip, meta)
        index.remove(req.params.folder, req.params.id)
        pendingResumes?.remove(req.params.folder, req.params.id)
        return { ok: true, hidden: true, ...(await stopAfter(tip, toStop)) }
      }
      const wholeThread = req.body?.thread === true
      try {
        // tear down every live console that writes this conversation BEFORE
        // moving the file, and wait for its claude to be gone: on shutdown
        // claude appends a `last-prompt` line to its JSONL, and doing it the
        // other way round resurrected an empty session at the old path
        // too. After a /clear rotation the running claude is keyed by an
        // ANCESTOR id (consoleKeyFor) — killing only the raw id left it
        // alive, appending, and the "deleted" JSONL came straight back
        // (Settings › Maintenance). Rule: no live console may keep
        // writing a trashed session.
        // …and its dual: burying HISTORY never stops live work. A console
        // writes only the TIP of its chain, so consoles die only when the
        // trashed session IS that tip (isThreadTipOf); an ancestor row from
        // Maintenance kills nothing — its file has no writer left, so it
        // cannot resurrect either.
        // The SDK dual of the console rule: a CHAT-engine turn (interactive,
        // resident, or mission) appends to this JSONL by sessionId. Moving the
        // file while a turn is live lets the running claude recreate it at the
        // old path on its next write, and the watcher re-indexes it as a ghost.
        // Refuse (409) rather than corrupt — the owner cancels the turn first.
        if (chat.isSessionActive(req.params.id)) {
          return reply.code(409).send({ error: 'a turn is in progress for this conversation — cancel it before trashing' })
        }
        const trashMeta = index.getMeta(req.params.folder, req.params.id)
        const isThreadTip = isThreadTipOf(req.params.id, trashMeta)
        if (isThreadTip) await closeConsolesOf(req.params.id, trashMeta)
        // Third variant of the live-writer rule: a claude OUTSIDE Silos'
        // consoles (launched by hand, by claude-auto-retry, or orphaned from
        // a dead pane) still holds this id via its ~/.claude/sessions lock
        // file and would recreate the JSONL at the old path on its next write
        // — the watcher would re-index the "deleted" session as a ghost.
        // Refuse honestly, naming WHERE it lives (its lock says: tmux session,
        // derived name, idle time — harnesses/claude-code/holders.ts), instead of trashing
        // a file that comes right back. "a live claude (pid N)" read as
        // "another conversation is running". The owner may ask
        // Silos to close them first (`closeHolders`): SIGHUP, the same clean
        // shutdown `tmux kill-session` triggers, then the move. The refusal
        // carries the holders structured so the client can offer exactly that.
        let holders = terminals.holderDetailsOf(req.params.id)
        const closed: number[] = []
        if (holders.length > 0 && req.body?.closeHolders === true) {
          closed.push(...(await terminals.closeHoldersAndWait(req.params.id)))
          holders = terminals.holderDetailsOf(req.params.id)
        }
        if (holders.length > 0) {
          const why = closed.length > 0 || req.body?.closeHolders === true ? 'it did not exit when asked' : 'close it before trashing'
          return reply.code(409).send({ error: `${describeHolders(holders, Date.now())} — ${why}`, holders, canClose: true })
        }
        // the records are named NOW, while the index still knows the thread;
        // they are stopped after the move (a refused or failed move stops nothing)
        const toStop = namedToStop(isThreadTip, trashMeta)
        // Burying history never changes who a thread belongs to: write the
        // owner down for every descendant while the origin is still readable
        // (session-owner.ts — a mass trash of Writer's history took a Builder
        // thread's root with it and the thread turned Writer).
        owners.stampDescendantsOf(req.params.id)
        // resolved while the index still knows the thread
        const newsThread = isThreadTip ? threadIdOf(req.params.id) : null
        const dest = await store.trash(req.params.folder, req.params.id)
        index.remove(req.params.folder, req.params.id)
        forgetHealth(req.params.id, trashMeta?.cwd ?? undefined)
        // a deleted conversation leaves its given files (they are the
        // owner's) but its pending context news goes with it
        if (newsThread !== null && ctx.dataDir !== undefined) dropContextNews(ctx.dataDir, newsThread)
        // Drop any armed auto-resume for this conversation: the resident must
        // never resume a trashed session (chat.send({resume}) would recreate the
        // transcript at its old path, outside trash — the SDK dual of the
        // console-resurrection rule, invariant 3). The orphan sweep is the
        // belt; removing it here is the suspenders, so it never even ticks.
        pendingResumes?.remove(req.params.folder, req.params.id)
        // The thread's history goes with its tip. An ancestor has no console
        // of its own (a console writes only the tip, killed above), but a
        // claude outside Silos may still hold one — skip it rather than trash
        // a file that comes right back; the tip is already gone, honestly.
        const buried: string[] = []
        if (wholeThread && trashMeta) {
          for (const m of threadHistoryOf(trashMeta)) {
            if (chat.isSessionActive(m.id) || terminals.holdersOf(m.id).length > 0) continue
            owners.stampDescendantsOf(m.id) // same rule as above, for every file that moves
            try {
              await store.trash(m.folder, m.id)
            } catch {
              continue // gone between the index and the move; the next fs event reconciles
            }
            index.remove(m.folder, m.id)
            forgetHealth(m.id, m.cwd ?? undefined)
            pendingResumes?.remove(m.folder, m.id)
            buried.push(`${m.folder}/${m.id}`)
          }
        }
        return { ok: true, dest, buried, closed, ...(await stopAfter(isThreadTip, toStop)) }
      } catch (err) {
        const message = String(err instanceof Error ? err.message : err)
        const code = message.includes('not found') ? 404 : 500
        return reply.code(code).send({ error: message })
      }
    },
  )
}

// A subagent's transcript under <session>/subagents/: flat (agent-<id>.jsonl,
// nested agents included) or in a subfolder (workflow agents) — the census
// (reader.ts subagentTranscripts) lists both, so each row opens. Same bounded
// depth; the caller's realpath check still confines the result.
function findSubagentFile(root: string, name: string, depth = 0): string | null {
  const flat = join(root, name)
  if (existsSync(flat)) return flat
  if (depth >= 3) return null
  let dirs: string[]
  try {
    dirs = readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort()
  } catch {
    return null
  }
  for (const d of dirs) {
    const hit = findSubagentFile(join(root, d), name, depth + 1)
    if (hit !== null) return hit
  }
  return null
}
