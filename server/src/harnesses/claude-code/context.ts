// ContextAccumulator — a second accumulator, fed LINE BY LINE from the same
// ClaudeReader split as TranscriptAccumulator (same incremental path, same
// persistent cache — see reader.ts). Extracts the "conversation
// context" (plan/subagents/pending question/links/events/files/tools/flags/
// waiting) that feeds the context column, the Board, and live state.
// Deliberately independent of TranscriptAccumulator: neither class knows
// about the other.
//
// Input formats verified against real ~/.claude/projects sessions — don't
// reinvent without re-checking against real JSONL.
import { existsSync } from 'node:fs'
import { basename, join } from 'node:path'
import { homedir } from 'node:os'
import { textOf, toolResultsOf, isNoise, conversationalMessage, planProposalOf, planApproved, PARKING_KIND, TASK_NOTIFICATION_ID_RE } from './parser.js'
import { SHELL_MAX_MS } from '../../work-live.js'
import { modelsWithoutPrice, priceUsage } from './model-prices.js'
import { scrubReason } from '../../tool-health.js'
import { FENCE_REFUSAL_WHOLE_RE, normalizeToolError, refusedPathOf, REFUSED_CAP } from '../../territory.js'
import type { SessionContext, PlanTask, SubagentRef, StartNotice } from '../../types.js'

// EPHEMERAL bookkeeping (doesn't travel in `state`, same as `pendingTools`
// in TranscriptAccumulator): links a tool_use to its future tool_result.
// Lost on a process restart landing exactly between those two lines — a
// tiny window (tool_use and tool_result are almost always consecutive
// lines), same accepted risk criterion as the rest of the parser.
interface PendingCreate {
  subject: string
  description?: string
  activeForm?: string
  ts: string
}
interface PendingAgent {
  description: string
  type: string
  model?: string
  background: boolean
  ts: string
  assignedTaskId?: string
}

// the tools that park a conversation — one list, the parser's (they are
// not a tool in flight there, and what it waits on is said here)
const WAITING_KIND = PARKING_KIND

// outbound sends (SessionContext.outbound): at most this many of each kind
const OUTBOUND_CAP = 5
const OUTBOUND_SUMMARY_MAX = 80

// An inter-agent message (kind 'message') POSTed through the API door (POST /api/agents/<id>/messages).
// The URL alone is not enough — briefs and docs QUOTE it constantly — so the
// command must also carry a request-with-body marker (an explicit POST, or
// curl's data flags, which imply one), and the send only counts once its
// tool_result shows the stored message (resolveSend). The trailing
// lookahead keeps PATCH …/messages/<mid> out.
const MESSAGE_URL_RE = /\/api\/agents\/([A-Za-z0-9_-]+)\/messages(?![/\w])/
function messagePostOf(cmd: string): { to: string; summary: string } | null {
  // an encoded path (/api/agents/c%66o/…) reaches the same door — the same
  // habit the auth layer guards against; decoded for the match only
  const m = MESSAGE_URL_RE.exec(cmd.replace(/%([0-9A-Fa-f]{2})/g, (_, h: string) => String.fromCharCode(Number.parseInt(h, 16))))
  if (!m) return null
  if (!/\bPOST\b/.test(cmd) && !/(^|\s)(-d|--data(?:-raw|-binary)?|--json)\b/.test(cmd)) return null
  // the message's own words, from the JSON body in the command (best effort)
  const t = /"text"\s*:\s*"((?:[^"\\]|\\.)+)"/.exec(cmd)
  const summary = t ? t[1]!.replace(/\\n/g, ' ').replace(/\\(.)/g, '$1').slice(0, OUTBOUND_SUMMARY_MAX) : ''
  return { to: m[1]!, summary }
}

const FILES_CAP = 200
const EVENTS_CAP = 50
const DOCS_CAP = 20
const BACKGROUND_CAP = 20
// File PATHS as they appear inside a tool call's input — relative,
// absolute, or ~-prefixed. The transcript naming the file IS the
// attribution signal: no clocks, no mtime correlation. A WHITELIST of the
// project surfaces Silos reasons about (t11: never a full walk):
//   - plans/*.plan.json — the shared team plans
//   - context/<scope>/**/<file> — the agent's context uploads/deliverables,
//     at any depth (a Bash-generated PDF in context/shared was invisible;
//     the deliverables convention files into subfolders);
//     never under a node_modules/ segment (a library's own context/ dir)
//   - .superpowers/sdd/<plan>/progress.md — the SDD ledger: the executor
//     appends to it with `cat >>`, never Write/Edit, so only the mention
//     says this session keeps it (execution-record.ts reads it)
//   - …/agent-state/<id>/**/<file> — the agent's own state folder, the
//     convention's place for what belongs to no project. Absolute or ~/
//     only: an agent-state folder is never relative to a project. An
//     unexpanded `$SILOS_AGENT_STATE/x` is NOT resolved — the accumulator
//     knows no agent — and the agent page lists that folder itself.
// Shape: ONE path-token regex over the text, then each token is classified
// by its '/'-split segments. Why: linear time. Per-shape regexes with
// stacked `(?:seg/)*` groups backtracked cubically (an 8 KB
// `context/a/context/a/…` input took 40 s, synchronously, while indexing).
// The token regex has a left boundary, so a token never starts mid-word and
// every segment boundary is a '/', which the segment class excludes.
const PATH_TOKEN_RE = /(?<![\w.@-])(?:~\/|\.\/|\/)?[\w.@-]+(?:\/[\w.@-]+)+/g
const HAS_EXT_RE = /\.\w+$/

// The whitelist, applied to one token. True when the token names one of the
// convention's places.
function isMentionedPlace(token: string): boolean {
  const segs = token.split('/')
  const n = segs.length
  const last = segs[n - 1] ?? ''
  // plans/<name>.plan.json
  if (n >= 2 && segs[n - 2] === 'plans' && last.length > '.plan.json'.length && last.endsWith('.plan.json')) return true
  // .superpowers/sdd/<plan>/progress.md
  if (last === 'progress.md') {
    if (n >= 4 && segs[n - 4] === '.superpowers' && segs[n - 3] === 'sdd' && segs[n - 2] !== '') return true
  }
  if (!HAS_EXT_RE.test(last)) return false
  // context/<scope>/**/<file> — a context segment with a scope and a file after it
  if (!segs.includes('node_modules')) {
    for (let i = 0; i <= n - 3; i++) if (segs[i] === 'context' && segs[i + 1] !== '') return true
  }
  // /…/agent-state/<id>/**/<file> — absolute or ~/ only
  if (token.startsWith('/') || token.startsWith('~/')) {
    for (let i = 1; i <= n - 3; i++) if (segs[i] === 'agent-state' && segs[i + 1] !== '') return true
  }
  return false
}

// Every string inside a tool input, joined by real newlines — a JSON dump
// would turn a heredoc's newline into a literal `\n` glued to the next path.
function inputStrings(v: unknown, out: string[], depth = 0): void {
  if (depth > 8) return
  if (typeof v === 'string') out.push(v)
  else if (Array.isArray(v)) for (const x of v) inputStrings(x, out, depth + 1)
  else if (v !== null && typeof v === 'object') for (const x of Object.values(v)) inputStrings(x, out, depth + 1)
}

type AskQuestion = Omit<NonNullable<SessionContext['pending']>, 'askedAt' | 'more'>

// One AskUserQuestion question as the context carries it; null when it has
// no question text.
function askQuestionOf(raw: unknown): AskQuestion | null {
  const q = raw as { question?: unknown; header?: unknown; options?: unknown; multiSelect?: unknown } | null
  if (!q || typeof q !== 'object' || typeof q.question !== 'string') return null
  const options = Array.isArray(q.options)
    ? q.options
        .filter((o): o is { label: unknown; description?: unknown } => !!o && typeof o === 'object' && typeof (o as { label?: unknown }).label === 'string')
        .map((o) => {
          const opt: { label: string; description?: string } = { label: o.label as string }
          if (typeof o.description === 'string') opt.description = o.description
          return opt
        })
    : []
  const out: AskQuestion = { question: q.question, options }
  if (typeof q.header === 'string') out.header = q.header
  if (q.multiSelect === true) out.multiSelect = true
  return out
}

// variables every shell has — not something an agent reached
const ENV_NOISE = new Set([
  'HOME',
  'PATH',
  'PWD',
  'USER',
  'SHELL',
  'TERM',
  'LANG',
  'TMPDIR',
  'OLDPWD',
  'HOSTNAME',
  'PPID',
  'RANDOM',
  'SECONDS',
  'LINENO',
  'IFS',
  'UID',
  'EUID',
])

export class ContextAccumulator {
  private tasksMap = new Map<string, PlanTask>()
  private taskOrder: string[] = []
  private agentsArr: SubagentRef[] = []
  private pendingObj: SessionContext['pending'] = null
  // c6: the latest ExitPlanMode plan + the tool use it waits on (ephemeral id)
  private planModeObj: SessionContext['planMode'] = undefined
  private planToolUseId: string | null = null
  // headless plan mode (`-p` / SDK turns have no ExitPlanMode): the
  // `plan_mode` attachment names the plan file (it lives under the
  // ACCOUNT's config dir — never opened); a Write/Edit of that path in
  // this transcript IS the proposal. An ExitPlanMode since the latest
  // attachment wins over any later write. Ephemeral, like pendingCreates:
  // a restart between attachment and write loses one proposal — and errs
  // on the quiet side (no path → nothing proposed).
  private planFilePath: string | null = null
  private planExitSeen = false
  private linksObj: SessionContext['links'] = { prs: [], artifacts: [], worktree: null }
  private eventsArr: SessionContext['events'] = []
  private filesMap = new Map<string, SessionContext['files'][number]>()
  private toolsMap = new Map<string, SessionContext['tools'][number]>()
  // which environment variables its Bash calls named (Map › Uses: Vault
  // secrets by NAME — never a value)
  private envRefsMap = new Map<string, number>()
  // refused tool calls (SessionContext.refused): when + the path the call
  // named. The refusal's own text is never kept (f9284902: a raw denial is
  // a log line, not a fact) — only what Territory counts.
  private refusedArr: { at: string; path: string | null }[] = []
  // EPHEMERAL: tool_use id → the path its input named, until its result
  // (bounded — a result that never comes leaves nothing behind for long)
  private pendingPaths = new Map<string, string | null>()
  private flagsObj: SessionContext['flags'] = { remote: false, permissionMode: null, gitBranch: null, effort: null, model: null }
  private waitingObj: SessionContext['waiting'] = null
  // awaited background commands (SessionContext.background): label learned
  // at the tool_use, the id at its result, the end at the <task-notification>
  private pendingShells = new Map<string, string>()
  private backgroundArr: { id: string; since: string; label: string }[] = []
  // outbound sends still shown (proof of life) — see types.ts
  private outboundArr: NonNullable<SessionContext['outbound']> = []
  // cost, computed from each assistant message's real usage × API list
  // prices (model-prices.ts) — the only source: the Claude Code Silos runs
  // (≥ its minimum, version.ts) writes no cost-state aggregate during live
  // sessions. unknownModels marks usage priced at $0 for lack of a row.
  private costMap = new Map<string, NonNullable<SessionContext['cost']>['byModel'][number]>()
  private costUnknownModels = false
  private docsArr: SessionContext['documents'] = []
  private fhMap = new Map<string, { versions: number; lastAt: string }>()
  // the start notice (SessionContext.start): the NEWEST start's record —
  // the first deferred-tools delta until a later start replaces it
  private startObj: StartNotice | null = null
  // the delta of the start being written: a start's records (delta, then
  // its initial skill listing) come together, before any reply. Ephemeral,
  // like pendingCreates (the window is two lines of one start).
  private startDelta: StartNotice | null = null
  private entrypoint: string | null = null

  // Ephemeral — see comment above.
  private pendingCreates = new Map<string, PendingCreate>()
  private pendingAgents = new Map<string, PendingAgent>()
  // an outbound send in flight (SendMessage, or a Bash message POST): its
  // tool_result decides whether it counts (an error — or, for a message, a
  // result without the stored message — opens nothing)
  private pendingSends = new Map<string, { kind: 'session' | 'message'; to: string; summary: string; ts: string }>()
  private waitingToolUseId: string | null = null
  // the tool_use id of the open AskUserQuestion: its tool_result IS the
  // answer, so pending closes the moment it lands (not only on the next
  // typed user turn — that made "Needs you" linger long after answering).
  private pendingToolUseId: string | null = null
  // the LAST assistant message.id whose usage was counted: the harness
  // writes one line per content block, all carrying the same id and the
  // same usage, and those lines are consecutive — so remembering one id is
  // enough to count each message once. Ephemeral (same accepted restart
  // risk as pendingTools: the window is between two lines of one message).
  private countedMessageId: string | null = null
  private lastInProgressTaskId: string | null = null
  // an Artifact publish in flight: tool_use id → the file it published.
  // Its tool_result carries the page title (toolUseResult.title) and the
  // URL — merged into links.artifacts (frame-link gives path+url only).
  private pendingArtifacts = new Map<string, string>()

  // DISK ATTRIBUTION (option B; deterministic, no clocks). The Read/Write/Edit rule above is blind to
  // a plan written by a Bash heredoc, a script or a subagent — but the
  // session's OWN transcript names the file: the Bash command carries the
  // path, a subagent's prompt carries the path. Any tool_use whose input
  // mentions a plans/*.plan.json path counts that plan as touched
  // ('disk'), resolved against the session's cwd. Two earlier rules
  // correlated mtimes with turn windows / tool spans and misattributed
  // concurrent sessions' writes in the same folder (observed in
  // practice) — mention-based attribution has no such residual: what a
  // session never named is never its.
  // A mention only counts if the file is real: commands also WRITE CODE
  // that cites plan paths (tests, docs) and a phantom path must not enter
  // the column. Injectable so unit tests stay fs-free.
  pathExists: (path: string) => boolean = existsSync

  private cwd: string | null = null // top-level `cwd` on JSONL entries

  // resolve a mentioned path against the session's cwd / the home dir.
  // Without a cwd yet, a relative mention can't be resolved honestly → skipped.
  private resolvePlanPath(raw: string): string | null {
    if (raw.startsWith('/')) return raw
    if (raw.startsWith('~/')) return join(homedir(), raw.slice(2))
    if (this.cwd === null) return null
    return join(this.cwd, raw.startsWith('./') ? raw.slice(2) : raw)
  }

  // one touch per plan per tool_use, however often the input repeats it.
  private attributePlanMentions(name: string, input: Record<string, unknown>): void {
    // Read/Write/Edit are already counted precisely by file_path above —
    // scanning their inputs would double-count the same touch.
    if (name === 'Read' || name === 'Write' || name === 'Edit') return
    const parts: string[] = []
    inputStrings(input, parts)
    const text = parts.join('\n')
    if (!text.includes('.plan.json') && !text.includes('context/') && !text.includes('progress.md') && !text.includes('agent-state/')) return // cheap gate before the regexes
    const seen = new Set<string>()
    for (const raw of text.match(PATH_TOKEN_RE) ?? []) {
      // a Claude-style file citation (`@context/builder/x.md` in an Agent
      // prompt) names the same file: one leading @ is not part of the path
      let token = raw.startsWith('@') ? raw.slice(1) : raw
      while (token.endsWith('.')) token = token.slice(0, -1) // a sentence's full stop is not part of the path
      if (!isMentionedPlace(token)) continue
      const path = this.resolvePlanPath(token)
      if (path !== null) seen.add(path)
    }
    for (const path of seen) {
      let real = false
      try {
        real = this.pathExists(path)
      } catch {
        real = false
      }
      if (real) this.touchFile(path, 'disk')
    }
  }

  constructor(state?: SessionContext) {
    if (!state) return
    if (state.plan) {
      for (const t of state.plan.tasks) {
        this.tasksMap.set(t.id, { ...t, agents: [...t.agents] })
        this.taskOrder.push(t.id)
      }
    }
    this.agentsArr = state.agents.map((a) => ({ ...a }))
    this.pendingObj = state.pending
      ? {
          ...state.pending,
          options: state.pending.options.map((o) => ({ ...o })),
          ...(state.pending.more ? { more: state.pending.more.map((q) => ({ ...q, options: q.options.map((o) => ({ ...o })) })) } : {}),
        }
      : null
    // the answer (its tool_result) closes the question after a restart too
    this.pendingToolUseId = state.pending?.toolUseId ?? null
    this.linksObj = {
      prs: state.links.prs.map((p) => ({ ...p })),
      artifacts: state.links.artifacts.map((a) => ({ ...a })),
      worktree: state.links.worktree ? { ...state.links.worktree } : null,
    }
    this.eventsArr = state.events.map((ev) => ({ ...ev }))
    for (const f of state.files) this.filesMap.set(f.path, { ...f, disk: f.disk ?? 0 }) // caches < v13 carry no disk
    for (const t of state.tools) this.toolsMap.set(this.toolKey(t.server, t.name), { ...t })
    // caches < v37 carry no envRefs
    for (const c of state.envRefs ?? []) this.envRefsMap.set(c.name, c.count)
    // caches before the refused list carry none (no bump: counted from the lines read since)
    this.refusedArr = (state.refused ?? []).map((r) => ({ at: r.at, path: r.path }))
    this.flagsObj = { ...state.flags }
    this.waitingObj = state.waiting ? { ...state.waiting } : null
    // caches < v50 carry no background
    this.backgroundArr = (state.background ?? []).map((b) => ({ ...b }))
    // caches < v40 carry no outbound; live-joined fields (state/answer) are
    // never the accumulator's — kept out even if a caller cached them
    this.outboundArr = (state.outbound ?? []).map(({ kind, to, summary, since, messageId }) => ({
      kind,
      to,
      summary,
      since,
      ...(messageId !== undefined ? { messageId } : {}),
    }))
    if (state.cost) {
      for (const m of state.cost.byModel) this.costMap.set(m.model, { ...m })
      this.costUnknownModels = state.cost.unknownModels
    }
    // caches < v22 carry no documents
    this.docsArr = (state.documents ?? []).map((d) => ({ ...d }))
    // caches < v23 carry no fileHistory
    for (const f of state.fileHistory ?? []) this.fhMap.set(f.path, { versions: f.versions, lastAt: f.lastAt })
    if (state.planMode) {
      this.planModeObj = { ...state.planMode }
      this.planToolUseId = state.planMode.toolUseId ?? null
    }
    // caches < v48 carry no start notice
    if (state.start)
      this.startObj = {
        ...state.start,
        failed: state.start.failed.map((f) => ({ ...f })),
        needsAuth: [...state.start.needsAuth],
        ...(state.start.needsAuthIds ? { needsAuthIds: [...state.start.needsAuthIds] } : {}),
      }
  }

  // cheap accessor for the overview/session meta (metaOf): whether an
  // AskUserQuestion is open, without building the whole SessionContext.
  get hasPendingAsk(): boolean {
    // a plan waiting for approval is the agent waiting on the owner, too
    return this.pendingObj !== null || this.planModeObj?.state === 'proposed'
  }

  get state(): SessionContext {
    return {
      plan:
        this.taskOrder.length > 0
          ? {
              tasks: this.taskOrder.map((id) => this.tasksMap.get(id)!),
              done: this.taskOrder.filter((id) => this.tasksMap.get(id)!.status === 'completed').length,
              total: this.taskOrder.length,
            }
          : null,
      agents: [...this.agentsArr],
      pending: this.pendingObj,
      links: {
        prs: [...this.linksObj.prs],
        artifacts: [...this.linksObj.artifacts],
        worktree: this.linksObj.worktree,
      },
      events: [...this.eventsArr],
      files: [...this.filesMap.values()],
      tools: [...this.toolsMap.values()],
      flags: { ...this.flagsObj },
      waiting: this.waitingObj,
      ...((): Partial<Pick<SessionContext, 'background'>> => {
        // an entry whose notification never came (the engine died) leaves
        // the serving after SHELL_MAX_MS — and the next flush drops it
        const fresh = this.backgroundArr.filter((b) => {
          const t = Date.parse(b.since)
          return !Number.isFinite(t) || Date.now() - t < SHELL_MAX_MS
        })
        return fresh.length > 0 ? { background: fresh.map((b) => ({ ...b })) } : {}
      })(),
      cost:
        this.costMap.size > 0
          ? {
              totalUsd: [...this.costMap.values()].reduce((sum, m) => sum + m.usd, 0),
              unknownModels: this.costUnknownModels,
              ...(this.costUnknownModels ? { unpricedModels: modelsWithoutPrice(this.costMap.keys()) } : {}),
              byModel: [...this.costMap.values()].map((m) => ({ ...m })),
            }
          : null,
      documents: this.docsArr.map((d) => ({ ...d })),
      fileHistory: [...this.fhMap.entries()].map(([path, v]) => ({ path, ...v })).sort((a, b) => (a.lastAt < b.lastAt ? 1 : a.lastAt > b.lastAt ? -1 : 0)),
      ...(this.planModeObj ? { planMode: { ...this.planModeObj } } : {}),
      ...(this.refusedArr.length > 0 ? { refused: this.refusedArr.map((r) => ({ ...r })) } : {}),
      ...(this.envRefsMap.size > 0 ? { envRefs: [...this.envRefsMap].map(([name, count]) => ({ name, count })) } : {}),
      ...(this.outboundArr.length > 0 ? { outbound: this.outboundArr.map((o) => ({ ...o })) } : {}),
      ...(this.startObj
        ? {
            start: {
              ...this.startObj,
              failed: this.startObj.failed.map((f) => ({ ...f })),
              needsAuth: [...this.startObj.needsAuth],
              ...(this.startObj.needsAuthIds ? { needsAuthIds: [...this.startObj.needsAuthIds] } : {}),
            },
          }
        : {}),
    }
  }

  feedLines(lines: string[]): void {
    for (const line of lines) {
      if (!line.trim()) continue
      let e: Record<string, unknown>
      try {
        e = JSON.parse(line) as Record<string, unknown>
      } catch {
        continue
      }
      this.ingest(e)
    }
  }

  // One already-parsed record (the reader parses each line once and feeds
  // the same record to TranscriptAccumulator.feedRecord too).
  feedRecord(e: Record<string, unknown>): void {
    this.ingest(e)
  }

  private toolKey(server: string | null, name: string): string {
    // a visible separator that never appears in tool names — NOT \0: git treated the file as binary
    return `${server ?? ''}␟${name}`
  }

  private ingest(e: Record<string, unknown>): void {
    // gitBranch/effort travel as top-level fields on (almost) any entry
    // type — captured unconditionally, regardless of type.
    if (typeof e.cwd === 'string' && e.cwd.startsWith('/')) this.cwd = e.cwd
    if (this.entrypoint === null && typeof e.entrypoint === 'string') this.entrypoint = e.entrypoint
    if (typeof e.gitBranch === 'string') this.flagsObj.gitBranch = e.gitBranch
    if (typeof e.effort === 'string') this.flagsObj.effort = e.effort

    const ts = typeof e.timestamp === 'string' ? e.timestamp : null
    // a reply closes the start being written: a delta after it is the
    // tool set changing mid-conversation, never a start's
    if (e.type === 'assistant') this.startDelta = null
    switch (e.type) {
      case 'pr-link': {
        const { prNumber, prUrl, prRepository } = e as { prNumber?: unknown; prUrl?: unknown; prRepository?: unknown }
        if (typeof prNumber === 'number' && typeof prUrl === 'string' && typeof prRepository === 'string') {
          this.linksObj.prs.push({ number: prNumber, url: prUrl, repo: prRepository, ts: ts ?? '' })
        }
        return
      }
      case 'frame-link': {
        const { path, frameUrl } = e as { path?: unknown; frameUrl?: unknown }
        if (typeof path === 'string' && typeof frameUrl === 'string') this.upsertArtifact({ path, url: frameUrl, ts: ts ?? '' })
        return
      }
      case 'worktree-state': {
        const ws = (e.worktreeSession ?? {}) as { worktreePath?: unknown; worktreeName?: unknown }
        if (typeof ws.worktreePath === 'string' && typeof ws.worktreeName === 'string') {
          this.linksObj.worktree = { path: ws.worktreePath, name: ws.worktreeName }
        }
        return
      }
      case 'bridge-session':
        this.flagsObj.remote = true
        return
      case 'attachment': {
        // session_context: written at each start (and when it changes) with
        // the login's email — the last one is the account the conversation
        // last ran on
        const a = e.attachment as { type?: unknown; context?: { userEmail?: unknown }; planFilePath?: unknown } | undefined
        if (a?.type === 'deferred_tools_delta') {
          const n = startNoticeOf(e.attachment as Record<string, unknown>, ts, typeof e.entrypoint === 'string' ? e.entrypoint : this.entrypoint)
          if (this.startObj === null) this.startObj = n
          this.startDelta = n
          return
        }
        // a start (a console restarted, a chat resumed): each process
        // writes its initial skill listing once. The notice becomes THIS
        // start's — its own delta, or, with none, a clean one: a start that
        // wrote no failure record has none (the old failure does not carry
        // over)
        if (a?.type === 'skill_listing' && (a as { isInitial?: unknown }).isInitial !== false) {
          if (this.startObj !== null) {
            const mode = this.startObj.mode
            this.startObj = this.startDelta ?? {
              at: ts,
              mode: typeof e.entrypoint === 'string' ? (e.entrypoint === 'cli' ? 'console' : e.entrypoint.startsWith('sdk') ? 'chat' : mode) : mode,
              failed: [],
              needsAuth: [],
            }
          }
          this.startDelta = null
          return
        }
        if (a?.type === 'plan_mode') {
          if (typeof a.planFilePath === 'string' && a.planFilePath !== '') {
            this.planFilePath = a.planFilePath
            this.planExitSeen = false
          }
          return
        }
        if (a?.type !== 'session_context' || typeof a.context?.userEmail !== 'string') return
        const m = a.context.userEmail.match(/[^\s@]+@[^\s@]+\.[^\s@.]+/)
        if (m) this.flagsObj.accountEmail = m[0].replace(/[.,;]+$/, '')
        return
      }
      case 'file-history-delta': {
        // a /rewind checkpoint: one file, one version. Snapshot lines carry
        // an empty trackedFileBackups map in the real corpus — the deltas
        // are the signal. Grouped per file; the count is versions seen.
        const { trackingPath, backup } = e as { trackingPath?: unknown; backup?: { backupTime?: unknown } }
        if (typeof trackingPath !== 'string' || trackingPath === '') return
        const at = typeof backup?.backupTime === 'string' ? backup.backupTime : (ts ?? '')
        const prev = this.fhMap.get(trackingPath)
        this.fhMap.set(trackingPath, { versions: (prev?.versions ?? 0) + 1, lastAt: at > (prev?.lastAt ?? '') ? at : (prev?.lastAt ?? at) })
        return
      }
      // 'cost-state' (an older CLI's cumulative aggregate) is not read:
      // every Claude Code Silos runs is past the release that stopped
      // writing it live, so cost is computed from assistant usage
      // (ingestAssistant) — one source of truth, not two.
      case 'permission-mode':
        if (typeof e.permissionMode === 'string') this.flagsObj.permissionMode = e.permissionMode
        return
      case 'system':
        this.ingestSystem(e, ts)
        return
      default:
        break
    }

    const msg = conversationalMessage(e)
    const role = msg?.role
    if (role === 'assistant') {
      this.ingestAssistant(msg as { content?: unknown; model?: unknown; id?: unknown; usage?: unknown }, ts)
    } else if (role === 'user') {
      this.ingestUser(e, msg as { content?: unknown } | undefined, ts)
    }
  }

  private ingestSystem(e: Record<string, unknown>, ts: string | null): void {
    const content = typeof e.content === 'string' ? e.content : ''
    let kind: SessionContext['events'][number]['kind']
    let text = content
    switch (e.subtype) {
      case 'model_consent_fallback':
        kind = 'model'
        break
      case 'model_refusal_fallback':
        kind = 'refusal'
        break
      case 'compact_boundary':
        kind = 'compact'
        text = 'Conversation compacted'
        break
      case 'scheduled_task_fire':
        kind = 'loop'
        break
      case 'bridge_status':
        kind = 'remote'
        break
      case 'informational':
        kind = 'info'
        break
      default:
        return // turn_duration and any unrecognized subtype: not an event
    }
    this.eventsArr.push({ ts: ts ?? '', kind, text })
    if (this.eventsArr.length > EVENTS_CAP) this.eventsArr.shift()
  }

  private ingestAssistant(msg: { content?: unknown; model?: unknown; stop_reason?: unknown; id?: unknown; usage?: unknown }, ts: string | null): void {
    if (typeof msg.model === 'string' && msg.model.trim() !== '') this.flagsObj.model = msg.model

    this.countUsage(msg)

    const content = msg.content
    if (!Array.isArray(content)) return
    for (const c of content) {
      if (!c || typeof c !== 'object' || (c as { type?: unknown }).type !== 'tool_use') continue
      const block = c as { id?: unknown; name?: unknown; input?: unknown }
      const id = typeof block.id === 'string' ? block.id : null
      const name = typeof block.name === 'string' ? block.name : '?'
      const input = block.input && typeof block.input === 'object' ? (block.input as Record<string, unknown>) : {}

      this.registerTool(name)
      this.attributePlanMentions(name, input)
      if (id) {
        this.pendingPaths.set(id, refusedPathOf(name, input))
        if (this.pendingPaths.size > 500) this.pendingPaths.delete(this.pendingPaths.keys().next().value!)
      }
      if (name === 'Bash' && typeof input.command === 'string') {
        this.registerCommand(input.command)
        // a message POST to an agent's inbox — pending until its result
        // shows the stored message (see messagePostOf)
        if (id) {
          const rec = messagePostOf(input.command)
          if (rec) this.pendingSends.set(id, { kind: 'message', ...rec, ts: ts ?? '' })
        }
      }

      // an outbound message to another session/subagent: a wait until that
      // name answers (<cross-session-message>/task-notification) or the
      // owner's next typed turn
      if (name === 'SendMessage' && id && typeof input.to === 'string' && input.to.trim() !== '') {
        const summary =
          typeof input.summary === 'string' && input.summary.trim() !== ''
            ? input.summary.trim().slice(0, OUTBOUND_SUMMARY_MAX)
            : typeof input.message === 'string'
              ? input.message.trim().slice(0, OUTBOUND_SUMMARY_MAX)
              : ''
        this.pendingSends.set(id, { kind: 'session', to: input.to.trim(), summary, ts: ts ?? '' })
      }

      if ((name === 'Edit' || name === 'Write' || name === 'Read') && typeof input.file_path === 'string') {
        this.touchFile(input.file_path, name)
      }
      if ((name === 'Write' || name === 'Edit') && this.planFilePath !== null && !this.planExitSeen && input.file_path === this.planFilePath) {
        this.proposeWrittenPlan(name === 'Write' ? input.content : input.new_string, ts)
      }
      // files HANDED to the owner (SendUserFile: PDFs, CSVs, screenshots
      // built in a scratchpad via Bash) — the deliverables of a conversation,
      // invisible to the Read/Write/Edit rule.
      if (name === 'SendUserFile' && Array.isArray(input.files)) {
        for (const f of input.files) if (typeof f === 'string') this.touchFile(f, name)
      }

      // a PUBLISH (the default action) of the Artifact tool — read/list/
      // comments/watch publish nothing.
      if (name === 'Artifact' && id && typeof input.file_path === 'string' && (input.action === undefined || input.action === 'publish')) {
        this.pendingArtifacts.set(id, input.file_path)
      }

      if (name === 'TaskCreate' && id) {
        const pc: PendingCreate = { subject: typeof input.subject === 'string' ? input.subject : '', ts: ts ?? '' }
        if (typeof input.description === 'string') pc.description = input.description
        if (typeof input.activeForm === 'string') pc.activeForm = input.activeForm
        this.pendingCreates.set(id, pc)
      }

      if (name === 'TaskUpdate') this.applyTaskUpdate(input, ts)

      // TodoWrite (the legacy checklist, CLAUDE_CODE_ENABLE_TASKS=0): every
      // call is a snapshot of the WHOLE list, with no ids — it replaces it
      if (name === 'TodoWrite' && Array.isArray(input.todos)) this.applyTodoWrite(input.todos, ts)

      if (name === 'Agent' && id) {
        const pa: PendingAgent = {
          description: typeof input.description === 'string' ? input.description : '',
          type: typeof input.subagent_type === 'string' ? input.subagent_type : '',
          background: input.run_in_background === true,
          ts: ts ?? '',
        }
        if (typeof input.model === 'string') pa.model = input.model
        if (this.lastInProgressTaskId !== null) pa.assignedTaskId = this.lastInProgressTaskId
        this.pendingAgents.set(id, pa)
      }

      if (name === 'ExitPlanMode') {
        const plan = planProposalOf(input)
        if (plan) {
          const heading = /^#{1,6}\s+(.+)$/m.exec(plan.text)?.[1]?.trim()
          const title = (heading ?? plan.text.trim().split('\n')[0] ?? '').slice(0, 120)
          this.planModeObj = { state: 'proposed', title, at: ts ?? '', ...(plan.file ? { file: plan.file } : {}), ...(id ? { toolUseId: id } : {}) }
          this.planToolUseId = id
          this.planExitSeen = true
        }
      }

      if (name === 'AskUserQuestion') {
        this.applyAskUserQuestion(input, ts, id)
        this.pendingToolUseId = id
      }

      // a Bash sent to the background: the result answers at once with a
      // task id while the command keeps running — an «In the background» row
      if (name === 'Bash' && id && input.run_in_background === true) {
        const label =
          typeof input.description === 'string' && input.description !== ''
            ? input.description
            : typeof input.command === 'string'
              ? (input.command.split('\n')[0] ?? '').slice(0, 120)
              : ''
        this.pendingShells.set(id, label)
      }

      if ((name === 'Monitor' || name === 'ScheduleWakeup' || name === 'Workflow') && id) {
        const label =
          typeof input.description === 'string'
            ? input.description
            : typeof input.reason === 'string'
              ? input.reason
              : typeof (input.meta as { name?: unknown } | undefined)?.name === 'string'
                ? (input.meta as { name: string }).name
                : ''
        this.waitingObj = { kind: WAITING_KIND[name]!, since: ts ?? '', label }
        this.waitingToolUseId = id
      }
    }
  }

  // One assistant message = one API response = one usage bill, however
  // many lines its content blocks occupy (verified: every repeat of an id
  // carries IDENTICAL usage). '<synthetic>' (harness error placeholders)
  // and zero-usage messages never create a row — no invented $0.
  private countUsage(msg: { model?: unknown; id?: unknown; usage?: unknown }): void {
    if (typeof msg.id !== 'string' || msg.id === this.countedMessageId) return
    if (typeof msg.model !== 'string' || msg.model === '<synthetic>') return
    const u = msg.usage as
      | {
          input_tokens?: unknown
          output_tokens?: unknown
          cache_read_input_tokens?: unknown
          cache_creation_input_tokens?: unknown
          cache_creation?: { ephemeral_5m_input_tokens?: unknown; ephemeral_1h_input_tokens?: unknown }
        }
      | undefined
    if (!u || typeof u !== 'object') return
    const n = (v: unknown): number => (typeof v === 'number' && v > 0 ? v : 0)
    const input = n(u.input_tokens)
    const output = n(u.output_tokens)
    const cacheRead = n(u.cache_read_input_tokens)
    const cacheWrite = n(u.cache_creation_input_tokens)
    if (input + output + cacheRead + cacheWrite === 0) return
    this.countedMessageId = msg.id

    // the TTL split decides the write rate; without it, 5m (lower bound).
    const write1h = Math.min(n(u.cache_creation?.ephemeral_1h_input_tokens), cacheWrite)
    const usd = priceUsage(msg.model, { input, output, cacheRead, cacheWrite5m: cacheWrite - write1h, cacheWrite1h: write1h })
    if (usd === null) this.costUnknownModels = true

    let row = this.costMap.get(msg.model)
    if (!row) {
      row = { model: msg.model, usd: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 }
      this.costMap.set(msg.model, row)
    }
    row.usd += usd ?? 0
    row.inputTokens += input
    row.outputTokens += output
    row.cacheReadTokens += cacheRead
    row.cacheCreationTokens += cacheWrite
  }

  // a Bash command: the environment variables it names ($X, ${X},
  // environ['X'], getenv, process.env.X) — names only, never a value. The
  // programs-launched sibling was removed (the matrix maps visibility, not
  // activity).
  private registerCommand(cmd: string): void {
    const text = cmd.slice(0, 20_000)
    const vars = new Set<string>()
    for (const m of text.matchAll(
      /\$\{?([A-Z][A-Z0-9_]{2,})|environ(?:\.get\(|\[)\s*['"]([A-Z][A-Z0-9_]{2,})['"]|getenv\(\s*['"]([A-Z][A-Z0-9_]{2,})['"]|process\.env\.([A-Z][A-Z0-9_]{2,})/g,
    )) {
      const v = m[1] ?? m[2] ?? m[3] ?? m[4]
      if (v && !ENV_NOISE.has(v)) vars.add(v)
    }
    for (const v of vars) this.envRefsMap.set(v, (this.envRefsMap.get(v) ?? 0) + 1)
  }

  private registerTool(name: string): void {
    const m = /^mcp__(.+?)__(.+)$/.exec(name)
    const server = m ? m[1]! : null
    const toolName = m ? m[2]! : name
    const key = this.toolKey(server, toolName)
    const existing = this.toolsMap.get(key)
    if (existing) existing.count += 1
    else this.toolsMap.set(key, { name: toolName, server, count: 1 })
  }

  private touchFile(path: string, name: string): void {
    let entry = this.filesMap.get(path)
    if (!entry) {
      if (this.filesMap.size >= FILES_CAP) {
        const oldest = this.filesMap.keys().next().value
        if (oldest !== undefined) this.filesMap.delete(oldest)
      }
      entry = { path, edits: 0, writes: 0, reads: 0, sent: 0, disk: 0 }
      this.filesMap.set(path, entry)
    }
    if (name === 'Edit') entry.edits += 1
    else if (name === 'Write') entry.writes += 1
    else if (name === 'Read') entry.reads += 1
    else if (name === 'SendUserFile') entry.sent += 1
    else if (name === 'disk') entry.disk += 1
  }

  // headless plan mode: the plan file written (Write content / Edit
  // new_string) is the proposal — `proposed` with NO toolUseId (no
  // tool_result will ever approve it in `-p`). title = the first «# »
  // heading of what was written; an Edit without one keeps the title it
  // had for the same file, else the file's name.
  private proposeWrittenPlan(text: unknown, ts: string | null): void {
    const file = this.planFilePath!
    const heading = typeof text === 'string' ? /^#\s+(.+)$/m.exec(text)?.[1]?.trim() : undefined
    const prior = this.planModeObj?.file === file ? this.planModeObj.title : undefined
    const title = (heading || prior || basename(file).replace(/\.md$/, '')).slice(0, 120)
    this.planModeObj = { state: 'proposed', title, at: ts ?? '', file }
    this.planToolUseId = null
  }

  private applyTodoWrite(todos: unknown[], ts: string | null): void {
    this.tasksMap.clear()
    this.taskOrder = []
    this.lastInProgressTaskId = null
    todos.forEach((t, i) => {
      if (!t || typeof t !== 'object') return
      const todo = t as { content?: unknown; status?: unknown; activeForm?: unknown }
      const id = String(i + 1)
      const status = todo.status === 'in_progress' || todo.status === 'completed' ? todo.status : 'pending'
      const task: PlanTask = { id, subject: typeof todo.content === 'string' ? todo.content : '', status, createdAt: ts ?? '', agents: [] }
      if (typeof todo.activeForm === 'string') task.activeForm = todo.activeForm
      this.tasksMap.set(id, task)
      this.taskOrder.push(id)
      if (status === 'in_progress' && this.lastInProgressTaskId === null) this.lastInProgressTaskId = id
    })
  }

  private applyTaskUpdate(input: Record<string, unknown>, ts: string | null): void {
    const taskId = typeof input.taskId === 'string' ? input.taskId : null
    if (!taskId) return
    const status = typeof input.status === 'string' ? input.status : undefined

    if (status === 'deleted') {
      this.tasksMap.delete(taskId)
      this.taskOrder = this.taskOrder.filter((id) => id !== taskId)
      if (this.lastInProgressTaskId === taskId) this.lastInProgressTaskId = this.anotherInProgress(taskId)
      return
    }

    const task = this.tasksMap.get(taskId)
    if (!task) return // a TaskUpdate whose TaskCreate hasn't resolved yet (corrupt/out-of-order line) — no-op

    if (typeof input.subject === 'string') task.subject = input.subject
    if (typeof input.description === 'string') task.description = input.description
    if (typeof input.activeForm === 'string') task.activeForm = input.activeForm

    if (status === 'pending' || status === 'in_progress' || status === 'completed') {
      task.status = status
      if (status === 'in_progress') {
        if (ts) task.startedAt = ts
        this.lastInProgressTaskId = taskId
      } else if (status === 'completed') {
        if (ts) task.completedAt = ts
        const start = task.startedAt ?? task.createdAt
        if (task.completedAt && start) task.durationMs = Date.parse(task.completedAt) - Date.parse(start)
        if (this.lastInProgressTaskId === taskId) this.lastInProgressTaskId = this.anotherInProgress(taskId)
      }
    }
  }

  // If other tasks are still in_progress (plans with parallelism), the
  // "current" one becomes whichever entered progress most recently — never null.
  private anotherInProgress(except: string): string | null {
    let best: { id: string; t: number } | null = null
    for (const id of this.taskOrder) {
      if (id === except) continue
      const t = this.tasksMap.get(id)
      if (!t || t.status !== 'in_progress') continue
      const start = t.startedAt ? Date.parse(t.startedAt) : 0
      if (!best || start >= best.t) best = { id, t: start }
    }
    return best ? best.id : null
  }

  // Every question of the call, not just the first (with two questions the
  // column once showed one) — the first stays in the flat fields,
  // the rest ride `more`.
  private applyAskUserQuestion(input: Record<string, unknown>, ts: string | null, toolUseId: string | null): void {
    const questions = (Array.isArray(input.questions) ? input.questions : []).map(askQuestionOf).filter((q) => q !== null)
    const [q0, ...rest] = questions
    if (!q0) return
    const pending: NonNullable<SessionContext['pending']> = { ...q0, askedAt: ts ?? '', ...(toolUseId ? { toolUseId } : {}) }
    if (rest.length > 0) pending.more = rest
    this.pendingObj = pending
  }

  private ingestUser(e: Record<string, unknown>, msg: { content?: unknown } | undefined, ts: string | null): void {
    const content = msg?.content

    // task-notification: closes a background subagent (<task-id> IS the
    // agentId). Not a real user turn: it doesn't close `pending` and
    // doesn't go through the rest of the logic below.
    if (typeof content === 'string' && content.includes('<task-notification>')) {
      const m = /<task-id>([a-f0-9]+)<\/task-id>/.exec(content)
      if (m) {
        const ref = this.agentsArr.find((a) => a.id === m[1])
        if (ref && ts) ref.endedAt = ts
        // a subagent messaged by its id answered — its wait is over
        this.outboundArr = this.outboundArr.filter((o) => !(o.kind === 'session' && o.to === m[1]))
      }
      // a notification naming a background command's id ends its row (the
      // parser's same marker; ids are not hex — a task id is the engine's)
      for (const bm of content.matchAll(TASK_NOTIFICATION_ID_RE)) this.backgroundArr = this.backgroundArr.filter((b) => b.id !== bm[1])
      return
    }

    // an incoming cross-session message: whoever it names answered — their
    // wait is over (the line itself starts with '<', so it is isNoise and
    // never counts as the owner's turn below)
    if (typeof content === 'string' && content.includes('<cross-session-message')) {
      // a send can name the peer (`to: "silos-1a"`) or reply to its address
      // (`to: "uds:/tmp/cc-socks/….sock"`, the from= attribute) — the reply
      // carries BOTH, so either one closes the wait (seen live: a wait
      // keyed to the address never matched from-name alone)
      for (const mm of content.matchAll(/<cross-session-message\b([^>]*)>/g)) {
        const names = new Set<string>()
        for (const a of mm[1]!.matchAll(/\bfrom(?:-name)?="([^"]+)"/g)) names.add(a[1]!)
        if (names.size > 0) this.outboundArr = this.outboundArr.filter((o) => !(o.kind === 'session' && names.has(o.to)))
      }
    }

    // documents pasted into the conversation (c7): a user
    // message whose content carries document blocks. No filename exists in
    // the real shape — type/size/when only; bytes ≈ base64 length × 3/4.
    if (Array.isArray(content)) {
      for (const c of content) {
        if (typeof c !== 'object' || c === null) continue
        const b = c as { type?: unknown; source?: { media_type?: unknown; data?: unknown } }
        if (b.type !== 'document' || typeof b.source?.media_type !== 'string') continue
        const data = typeof b.source.data === 'string' ? b.source.data : ''
        this.docsArr.push({ mediaType: b.source.media_type, bytes: Math.floor((data.length * 3) / 4), ts: ts ?? '' })
        if (this.docsArr.length > DOCS_CAP) this.docsArr.shift()
      }
    }

    for (const r of toolResultsOf(content)) {
      // a refused call: only an is_error result whose WHOLE text is a pinned
      // refusal shape — a Read of a file quoting the phrase is not one
      const path = this.pendingPaths.get(r.toolUseId)
      this.pendingPaths.delete(r.toolUseId)
      if (r.isError && FENCE_REFUSAL_WHOLE_RE.test(normalizeToolError(r.text))) {
        this.refusedArr.push({ at: ts ?? '', path: path ?? null })
        if (this.refusedArr.length > REFUSED_CAP) this.refusedArr.splice(0, this.refusedArr.length - REFUSED_CAP)
      }
      this.resolveTaskCreate(r.toolUseId, r.text)
      this.resolveArtifact(r.toolUseId, r.text, e.toolUseResult as { url?: unknown; path?: unknown; title?: unknown } | undefined, ts)
      this.resolveAgent(r.toolUseId, r.text, e.toolUseResult as { agentId?: unknown } | undefined, ts)
      const send = this.pendingSends.get(r.toolUseId)
      if (send) {
        this.pendingSends.delete(r.toolUseId)
        if (!r.isError) this.resolveSend(send, r.text)
      }
      const shellLabel = this.pendingShells.get(r.toolUseId)
      if (shellLabel !== undefined) {
        this.pendingShells.delete(r.toolUseId)
        const bg = (e.toolUseResult as { backgroundTaskId?: unknown } | undefined)?.backgroundTaskId
        if (typeof bg === 'string' && bg !== '' && !r.isError) {
          this.backgroundArr.push({ id: bg, since: ts ?? '', label: shellLabel })
          if (this.backgroundArr.length > BACKGROUND_CAP) this.backgroundArr.shift()
        }
      }
      if (this.waitingToolUseId === r.toolUseId) {
        this.waitingObj = null
        this.waitingToolUseId = null
      }
      if (this.planToolUseId !== null && this.planToolUseId === r.toolUseId && this.planModeObj) {
        const { toolUseId: _answered, ...rest } = this.planModeObj
        this.planModeObj = { ...rest, state: planApproved(r.text, e.toolUseResult) ? 'approved' : 'not_approved' }
        this.planToolUseId = null
      }
      if (this.pendingToolUseId !== null && this.pendingToolUseId === r.toolUseId) {
        this.pendingObj = null
        this.pendingToolUseId = null
      }
    }

    if (e.isCompactSummary === true) return
    const text = textOf(content)
    if (text.trim() !== '' && !isNoise(text)) {
      this.pendingObj = null
      // the owner's typed turn moves the conversation on: whatever it was
      // waiting on from other sessions, it no longer is (inter-agent messages keep their
      // own live state and stay)
      if (this.outboundArr.some((o) => o.kind === 'session')) this.outboundArr = this.outboundArr.filter((o) => o.kind !== 'session')
    }
  }

  // the send's tool_result arrived without an error: the wait (or the sent
  // message) enters the column. A message only counts when the result shows
  // the STORED message (its id in the store's shape) — a command that merely
  // quoted the URL never does; `to` is read back from the response when
  // present (the URL capture is the fallback). One open wait per recipient:
  // a second message to the same name re-stamps it.
  private resolveSend(send: { kind: 'session' | 'message'; to: string; summary: string; ts: string }, text: string): void {
    if (send.kind === 'message') {
      const id = /"id"\s*:\s*"([0-9a-z]+-[0-9a-z]{6})"/.exec(text)?.[1]
      if (!id) return
      const to = /"to"\s*:\s*"([A-Za-z0-9_-]+)"/.exec(text)?.[1] ?? send.to
      this.outboundArr = this.outboundArr.filter((o) => !(o.kind === 'message' && o.messageId === id))
      this.outboundArr.push({ kind: 'message', to, summary: send.summary, since: send.ts, messageId: id })
    } else {
      this.outboundArr = this.outboundArr.filter((o) => !(o.kind === 'session' && o.to === send.to))
      this.outboundArr.push({ kind: 'session', to: send.to, summary: send.summary, since: send.ts })
    }
    for (const kind of ['session', 'message'] as const) {
      while (this.outboundArr.filter((o) => o.kind === kind).length > OUTBOUND_CAP) {
        const oldest = this.outboundArr.find((o) => o.kind === kind)!
        this.outboundArr = this.outboundArr.filter((o) => o !== oldest)
      }
    }
  }

  // One row per URL: the harness re-emits a frame-link on every redeploy
  // of the same page (verified in the corpus) — a republish updates the
  // row (path/ts/title) in place rather than appending a duplicate.
  private upsertArtifact(a: { path: string; url: string; ts: string; title?: string }): void {
    const existing = this.linksObj.artifacts.find((x) => x.url === a.url)
    if (!existing) {
      this.linksObj.artifacts.push(a)
      return
    }
    existing.path = a.path
    if (a.ts) existing.ts = a.ts
    if (a.title !== undefined) existing.title = a.title
  }

  private resolveArtifact(toolUseId: string, text: string, top: { url?: unknown; path?: unknown; title?: unknown } | undefined, ts: string | null): void {
    const filePath = this.pendingArtifacts.get(toolUseId)
    if (filePath === undefined) return
    this.pendingArtifacts.delete(toolUseId)
    // the structured result first; the human line "Published <path> at
    // <url>" as the fallback (older harnesses wrote only that).
    let url = top && typeof top.url === 'string' ? top.url : null
    if (!url) {
      const m = /Published .+? at (https?:\/\/\S+)/.exec(text)
      if (m) url = m[1]!
    }
    if (!url) return
    const path = top && typeof top.path === 'string' ? top.path : filePath
    const entry: { path: string; url: string; ts: string; title?: string } = { path, url, ts: ts ?? '' }
    if (top && typeof top.title === 'string' && top.title.trim() !== '') entry.title = top.title
    this.upsertArtifact(entry)
  }

  private resolveTaskCreate(toolUseId: string, text: string): void {
    const pending = this.pendingCreates.get(toolUseId)
    if (!pending) return
    this.pendingCreates.delete(toolUseId)
    const m = /Task #(\d+) created successfully/.exec(text)
    const id = m ? m[1]! : toolUseId
    const task: PlanTask = { id, subject: pending.subject, status: 'pending', createdAt: pending.ts, agents: [] }
    if (pending.description !== undefined) task.description = pending.description
    if (pending.activeForm !== undefined) task.activeForm = pending.activeForm
    this.tasksMap.set(id, task)
    this.taskOrder.push(id)
  }

  private resolveAgent(toolUseId: string, text: string, toolUseResultTop: { agentId?: unknown } | undefined, ts: string | null): void {
    const pending = this.pendingAgents.get(toolUseId)
    if (!pending) return
    this.pendingAgents.delete(toolUseId)

    let agentId: string | null = null
    if (toolUseResultTop && typeof toolUseResultTop.agentId === 'string') agentId = toolUseResultTop.agentId
    if (!agentId) {
      const m = /agentId:\s*([a-f0-9]+)/.exec(text)
      if (m) agentId = m[1]!
    }
    if (!agentId) return // without an id we can't identify the subagent — discarded

    const ref: SubagentRef = { id: agentId, description: pending.description, type: pending.type, background: pending.background, startedAt: pending.ts }
    if (pending.model !== undefined) ref.model = pending.model
    if (pending.assignedTaskId !== undefined) ref.taskId = pending.assignedTaskId
    if (!pending.background && ts) ref.endedAt = ts
    this.agentsArr.push(ref)

    if (pending.assignedTaskId !== undefined) {
      const task = this.tasksMap.get(pending.assignedTaskId)
      if (task) task.agents.push(agentId)
    }
  }
}

// The start notice of a conversation: its newest start's deferred-tools
// delta — what Claude Code told the model about its MCP servers at start. A chat's delta
// names the servers waiting for a sign-in (needsAuthMcpServers); a console's
// does not, and instead carries each such server's `authenticate` /
// `complete_authentication` tool pair, whose names give only the server's
// tool-name id (`mcp__<id>__authenticate`): the id is kept as it is — the
// known prefix and suffix cut, never the id split — and the inventory
// resolves it (loads/names.ts). Failures keep the engine's message, cleaned
// as the ledger cleans it.
const AUTH = '__authenticate'
const AUTH_DONE = '__complete_authentication'
function startNoticeOf(a: Record<string, unknown>, ts: string | null, entrypoint: string | null): StartNotice {
  const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x !== '') : [])
  const failed: StartNotice['failed'] = []
  for (const f of Array.isArray(a.failedMcpServers) ? a.failedMcpServers : []) {
    const o = typeof f === 'object' && f !== null ? (f as Record<string, unknown>) : null
    const name = typeof f === 'string' ? f : typeof o?.name === 'string' ? o.name : ''
    if (!name || failed.some((x) => x.name === name)) continue
    failed.push({ name, reason: typeof o?.error === 'string' ? scrubReason(o.error) : '' })
  }
  const needsAuth = [...new Set(strs(a.needsAuthMcpServers))]
  const added = new Set(strs(a.addedNames))
  const ids: string[] = []
  for (const n of added) {
    if (!n.startsWith('mcp__') || !n.endsWith(AUTH)) continue
    const prefix = n.slice(0, -AUTH.length)
    if (prefix.length > 'mcp__'.length && added.has(prefix + AUTH_DONE)) ids.push(prefix.slice('mcp__'.length))
  }
  const mode = entrypoint === 'cli' ? 'console' : entrypoint?.startsWith('sdk') ? 'chat' : null
  return { at: ts, mode, failed, needsAuth, ...(ids.length > 0 ? { needsAuthIds: [...new Set(ids)].sort() } : {}) }
}
