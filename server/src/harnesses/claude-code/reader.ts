// harnesses/claude-code/reader.ts — Claude Code's sessions as a harness
// reader: the JSONL transcripts under <root>/<folder>/<id>.jsonl, parsed
// incrementally, with the persistent parse cache and the subagent
// heartbeat. SessionIndex merges it with the other harnesses' readers;
// emission ('session'/'removed') is the index's — this reader only signals
// through watch() what the index cannot see: the heartbeat ('updated') and
// a file found gone or muted inside refresh() ('removed').

import { openSync, readSync, closeSync, readFileSync, existsSync, statSync } from 'node:fs'
import { readdir, stat, writeFile, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { TranscriptAccumulator, conversationalMessage, type AccumulatorState } from './parser.js'
import { sliceLines, sliceWholeFile, releaseLoop, SLICE_BYTES } from '../../jsonl-lines.js'
import { ContextAccumulator } from './context.js'
import { isEphemeralFolder } from '../../ephemeral.js'
import type { SessionMeta, TranscriptTurn, SessionContext, DiskSubagent } from '../../types.js'
import type { FileBackedReader, SessionRef, SessionToolCalls, UsageRecord } from '../contract.js'
import { claudeToolCallsOfLines } from './tool-calls.js'
import { UsageFileCache, subagentBill } from './usage-records.js'
import { buriedPath } from './trash.js'
import { tmpdir } from 'node:os'
import { mungePath } from '../../agent-registry.js'
import { TITLER_TMP_PREFIX } from '../../titler.js'
import { harnessForId } from '../registry.js'
import { TOOL_MAX_MS } from '../../work-live.js'
import { SessionIndex } from '../../session-index.js'

interface FileState {
  folder: string
  id: string
  lineOffset: number
  mtime: number
  size: number
  acc: TranscriptAccumulator
  ctx: ContextAccumulator
  // Newest mtime under root/folder/id/subagents/*.jsonl — a subagent's
  // work IS this conversation's activity, but it never touches the main
  // transcript, so the row went "Idle" after LIVE_MS while a Task ran.
  // Folded into mtime only while the turn is open; emitted
  // raw in the meta too, because a BACKGROUND agent (the Agent tool spawns
  // detached) keeps working after the main turn closes and the client needs
  // its recency for the blink. Refreshed by refresh() and by
  // the heartbeat (pollSubagentActivity). Not cached.
  subMtime: number
  // The newest tool still in flight in any subagent transcript under that
  // dir (0: none) — a subagent running a long command writes nothing until
  // it returns, so subMtime alone read a working conversation as idle.
  // Computed by the SAME accumulator as the main transcript's
  // toolSince, one per fresh subagent file (subTracks). Not cached.
  subToolSince: number
  // relative path under subagents/ → the incremental parse of that file.
  // Only FRESH files are tracked (written within TOOL_MAX_MS: an older one
  // can hold no tool in flight within the bound); a stale one is dropped.
  subTracks: Map<string, SubTrack>
  // The transcript's birthtime ms (stat) — when this conversation started.
  // 0 when the filesystem doesn't report one (then startedAt is omitted).
  // Read from every stat, never cached.
  birthtime: number
  // WHAT READERS SEE. A large read feeds acc/ctx slice by slice with
  // the event loop released between slices (jsonl-lines.ts), so mid-read the
  // accumulators hold a PREFIX of the file. Readers never see that: they
  // read the state PUBLISHED at the end of the last complete read —
  // `meta` (null until the first read completes: the session is not listed
  // and getMeta/getContext answer null, as before it was known), `hidden`
  // (isBookkeepingOnly at that moment), and, while a read is in flight,
  // `frozenCtx` (the context as it was when the read began). A caller that
  // needs the new state awaits refresh().
  meta: SessionMeta | null
  hidden: boolean
  reading: boolean
  frozenCtx: SessionContext | null
  // this file's cache entry, serialized — null when it changed since (flush
  // re-serializes only those)
  cacheEntry: string | null
}

// One subagent transcript followed incrementally — the main transcript's
// own accumulator, so «a tool in flight» means the same thing at every depth.
// `toolSince` is the accumulator's, published once a read completes (a
// reader never sees a half-fed track).
interface SubTrack {
  offset: number
  acc: TranscriptAccumulator
  toolSince: number | null
}

// Nested layouts (workflow agents) live in subfolders of subagents/; a
// bounded walk — the dir is Claude Code's, never deeper than this in practice.
const SUBAGENT_DIR_DEPTH = 3

// Cache version history (each bump forces a full re-parse instead of
// trusting a stale cache entry whose shape no longer matches):
// 1 → 2 — AccumulatorState gained contextTokens/model/queue; a v1 cache
// restored as-is would leave those fields `undefined` instead of null/[]
// (TranscriptAccumulator's constructor doesn't initialize them separately),
// violating the type and silently losing the data.
// 2 → 3 — each cache entry gained `context` (ContextAccumulator.state, see
// context.ts), fed in parallel to `state` from the same lines. A v2 cache
// lacks that field: it won't match and gets re-parsed from scratch.
// 3 → 4 — the parser emits new turns (system/turn_duration markers) and
// corrects model/contextTokens on "<synthetic>" entries; a turnCount/model
// cached under v3 no longer matches what an incremental tail would keep emitting.
// 4 → 5 — the parser emits new turns (cross-session messages, previously
// swallowed by isMeta/isNoise); a turnCount cached under v4 no longer matches.
// 5 → 6 — a user turn that's only an image (no text) now emits a turn
// (previously swallowed by the noise/empty gates); same criterion as
// always: the cached turnCount no longer matches.
// 6 → 7 — AccumulatorState gained `lastRole` (the role of the last
// conversational turn, `unread`'s input); a v6 cache would leave it
// undefined and every session would read as "not unread" until the next new turn.
// 7 → 8 — mtime became CONTENT activity (acc.lastTs) instead of the file's
// mtime — forces a rescan.
// 8 → 9 — AccumulatorState gained `turnOpen` (the sidebar dot's blink input).
// 9 → 10 — AccumulatorState gained `toolSince` (tool in flight → working).
// 10 → 11 — AccumulatorState gained `resumedFrom` (Claude Code forks on
// `--resume`: the new file's records carry the origin's id — the chain link).
// 11 → 12 — ContextAccumulator counts SendUserFile deliveries (files.sent);
// cached contexts never saw those tool_use lines.
// 12 → 13 — files entries gained `disk` (a plan path cited in a tool's
// input, context.ts attributePlanMentions — the mtime correlation of that
// version is retired: no clocks).
// 13 → 14 — artifacts are upserted by URL with the page title (context.ts
// resolveArtifact); a v13 cache built between two hot-reloads carried
// pre-lister contexts (disk always 0) and duplicated artifact rows.
// 14 → 15 — orphan turn windows (no receipt) now close at their last
// activity (context.ts): a v14 cache attributed a folder's plans to a
// 13-day orphan.
// 15 → 16 — a >30 min silence splits an open turn's window (context.ts
// TURN_GAP_MS); v15 still attributed a resumed session's 13-day gap.
// 17 → 18 — disk attribution is now MENTION-based (context.ts: a tool
// call's input names the plan path); the clock-correlation rules (turn
// windows, tool spans) misattributed concurrent sessions' writes.
// 18 → 19 — a mention only counts when the file exists (commands that
// write tests/docs cite phantom plan paths).
// 19 → 20 — mentions also cover context/<scope>/<file> (t11: a
// Bash-generated PDF in context/shared was invisible to Files).
// 23 → 24 — api-request-blob records (newer Claude Code) are no longer
// conversation: caches built before counted their replayed messages as
// turns, tool calls and documents.
// 24 → 25 — AccumulatorState gained `startedByClear` (a console /clear
// starts a new conversation; old caches never saw the hook record).
// 26 → 27 — SessionContext gained `fenceRefusals` (tool results the
// territory fence refused).
const CACHE_VERSION = 51 // 51: resumedFrom read from Claude Code's derived-from record (via fork) — every transcript re-read so a console's --resume twin joins its thread // 50: context.background — awaited background commands with their labels (the column’s «In the background») // 49: context.start is the NEWEST start's notice (a later start without a failure clears it) // 48: context.start — the start notice (failed servers, sign-ins; a console's authenticate pair kept as ids) // 47: outbound inter-agent messages are kind 'message' // 46: parking tools (Monitor, wakeup, workflow) are not a tool in flight; shells (background commands awaited) // 45: context.pending carries its AskUserQuestion's toolUseId (an answer after a restart closes it) // 44: SessionMeta.console (entrypoint cli — «Open» goes to a console only when the agent has one, §9.2) // 43: 43: the flat .superpowers/sdd/progress.md is no SDD ledger (only <plan>/progress.md) // 42: commands (programs launched) removed — the Uses matrix maps visibility, not activity; envRefs stay // 41: a reply to a session wait closes it by from= too, not only from-name // 40: outbound (SendMessage waits + inter-agent messages sent — proof of life) // 39: planMode + ExitPlanMode plans (c6) // bump = every session's context is re-fed from disk on the next start (27: fenceRefusals — tool calls the territory fence refused) // 28: SessionMeta.harness // 29: OpenCode errored turns close + flags.model // 30: ledger mentions (.superpowers/sdd/**/progress.md) in context.files // 31: SessionMeta.requestedModel (OpenCode) // 32: context/<scope>/** and agent-state mentions in context.files // 33: content activity = allow-list of real records (resume bookkeeping never counts) // 34: allow-list tightened // 35: pending carries every AskUserQuestion question (more, multiSelect) // 36: flags.accountEmail (session_context — the login it last ran on) // 37: commands + envRefs (Bash programs, env var names — Map › Uses) // 38: commands skip heredoc bodies and quoted code

// How often open-turn sessions get their subagents dir stat'ed (see
// pollSubagentActivity) — well inside the client's LIVE_MS (120 s).
const SUBAGENT_POLL_MS = 10_000

// With the turn CLOSED, the heartbeat keeps watching only while the last
// known subagent activity is this recent — same rationale as the client's
// TOOL_MAX_MS: past it, the session is dead, not busy. (A NEW background
// agent always writes its spawn to the main transcript first, so the
// watcher re-arms this via refresh().)
const SUBAGENT_WATCH_MS = 30 * 60_000

// listSubagents helpers — a subagent's transcript can be large; only the
// tail matters for "doing now", and only while the file is FRESH (past
// this, the agent is finished or dead — history needs no tail read).
const SUBAGENT_TAIL_MS = 2 * 60_000
const SUBAGENT_TAIL_BYTES = 65_536

// cache entries serialized between two releases of the loop (flush)
const FLUSH_BATCH = 100

const readJson = async (path: string): Promise<Record<string, unknown> | null> => {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  } catch {
    return null
  }
}

// Last window of a file, decoded leniently (the first line of the window
// may be cut — dropped by the parse loop below).
const readTail = (path: string, bytes: number): string => {
  try {
    const size = statSync(path).size
    const start = Math.max(0, size - bytes)
    const buf = Buffer.alloc(size - start)
    const fd = openSync(path, 'r')
    try {
      readSync(fd, buf, 0, buf.length, start)
    } finally {
      closeSync(fd)
    }
    return buf.toString('utf8')
  } catch {
    return ''
  }
}

// Newest tool_use in a tail window: name + its own description/command —
// the closest thing to "what the agent is doing right now".
const lastToolUse = (tail: string): { name: string; detail?: string } | null => {
  let found: { name: string; detail?: string } | null = null
  for (const line of tail.split('\n')) {
    if (!line.includes('"tool_use"')) continue
    try {
      const content = conversationalMessage(JSON.parse(line) as Record<string, unknown>)?.content
      if (!Array.isArray(content)) continue
      for (const b of content as { type?: string; name?: string; input?: Record<string, unknown> }[]) {
        if (b.type !== 'tool_use' || typeof b.name !== 'string') continue
        const input = b.input ?? {}
        const detail = [input.description, input.file_path, input.pattern, input.prompt, input.command].find(
          (v): v is string => typeof v === 'string' && v.trim() !== '',
        )
        found = { name: b.name }
        if (detail !== undefined) found.detail = detail.slice(0, 200)
      }
    } catch {
      /* cut or foreign line — skip */
    }
  }
  return found
}

interface CacheShape {
  version: typeof CACHE_VERSION
  files: Record<string, { lineOffset: number; mtime: number; size: number; state: AccumulatorState; context: SessionContext }>
}

export class ClaudeReader implements FileBackedReader {
  readonly harness = 'claude-code' as const
  private files = new Map<string, FileState>()
  private ready = false
  private muted: Set<string>
  private listeners = new Set<(ref: SessionRef, kind: 'created' | 'updated' | 'removed') => void>()
  // bumped on every change list() would show (publish/remove): the index
  // keeps its rows between bumps (contract.ts revision)
  private rev = 0
  private listed: { rev: number; rows: SessionMeta[] } | null = null
  // one read of a file at a time, at most one more queued (serial)
  private chains = new Map<string, { tail: Promise<unknown>; queued: Promise<unknown> | null }>()
  // Munged prefix of the OS tmpdir (or null if not applicable) — folders
  // hanging off it are ephemeral noise (smokes/scratchpads/repros), joined
  // into the same skip-set as muted.json's folders. See ephemeral.ts.
  constructor(
    private rootDir: string,
    private cachePath: string,
    muted: readonly string[] = [],
    private ephemeralPrefix: string | null = null,
    // <dataDir>/trash: Usage reads a trashed conversation's records there
    // while it is (trash.ts buriedPath) — a past day never changes
    private trashDir: string | null = null,
  ) {
    this.muted = new Set(muted)
  }

  get root(): string {
    return this.rootDir
  }

  ownsId(id: string): boolean {
    return harnessForId(id) === 'claude-code'
  }

  watch(onChange: (ref: SessionRef, kind: 'created' | 'updated' | 'removed') => void): () => void {
    this.listeners.add(onChange)
    return () => {
      this.listeners.delete(onChange)
    }
  }
  private notify(folder: string, id: string, kind: 'updated' | 'removed'): void {
    for (const cb of this.listeners) cb({ harness: 'claude-code', folder, id }, kind)
  }

  transcriptPath(folder: string, id: string): string {
    return join(this.rootDir, folder, id + '.jsonl')
  }

  isReady(): boolean {
    return this.ready
  }

  // Combined skip-set: hand-muted folders (muted.json) + ephemeral folders
  // derived from the OS tmpdir. A single source of truth consumed by
  // init() and refresh() (and its mirror in watcher.ts) so no path can
  // index or resurrect either category.
  private shouldSkip(folder: string): boolean {
    if (this.muted.has(folder)) return true
    if (this.ephemeralPrefix !== null && isEphemeralFolder(folder, this.ephemeralPrefix)) return true
    return false
  }

  async init(): Promise<void> {
    let cached: CacheShape['files'] = {}
    try {
      if (existsSync(this.cachePath)) {
        const raw = JSON.parse(readFileSync(this.cachePath, 'utf8')) as CacheShape
        if (raw.version === CACHE_VERSION) cached = raw.files
      }
    } catch {
      /* corrupt cache → re-parse */
    }

    const dirs = await readdir(this.rootDir, { withFileTypes: true }).catch(() => [])
    for (const dir of dirs) {
      if (!dir.isDirectory()) continue
      if (this.shouldSkip(dir.name)) continue // muted or ephemeral: not even readdir'd
      const entries = await readdir(join(this.rootDir, dir.name), { withFileTypes: true }).catch(() => [])
      for (const f of entries) {
        if (!f.isFile() || !f.name.endsWith('.jsonl')) continue
        const folder = dir.name
        const id = f.name.slice(0, -'.jsonl'.length)
        const key = `${folder}/${id}`
        const st = await stat(this.transcriptPath(folder, id)).catch(() => null)
        if (!st) continue
        const hit = cached[key]
        if (hit && hit.mtime === st.mtimeMs && hit.size === st.size && !this.files.has(key)) {
          const s: FileState = {
            ...blankState(folder, id),
            lineOffset: hit.lineOffset,
            mtime: hit.mtime,
            size: hit.size,
            birthtime: st.birthtimeMs,
            acc: new TranscriptAccumulator(hit.state),
            ctx: new ContextAccumulator(hit.context),
          }
          this.files.set(key, s)
          this.publish(s)
          // subMtime is not cached: without this look a background agent
          // running across a server restart would read as idle until the
          // next main-file event (mostly ENOENT — one syscall per session).
          await this.subagentActivity(s)
        } else {
          await this.refresh(folder, id)
        }
      }
    }
    this.ready = true
    this.startHeartbeat()
    await this.flush()
  }

  // The published rows, one array kept until the next change (revision).
  list(): SessionMeta[] {
    if (this.listed?.rev === this.rev) return this.listed.rows
    const rows: SessionMeta[] = []
    for (const s of this.files.values()) if (s.meta && !s.hidden) rows.push(s.meta)
    this.listed = { rev: this.rev, rows }
    return rows
  }

  revision(): number {
    return this.rev
  }

  // Known by id but not a conversation (see isBookkeepingOnly): list()
  // already leaves it out; the index must not emit it on refresh().
  hidden(folder: string, id: string): boolean {
    const s = this.files.get(`${folder}/${id}`)
    return s ? s.hidden : false
  }

  getMeta(folder: string, id: string): SessionMeta | null {
    return this.files.get(`${folder}/${id}`)?.meta ?? null
  }

  // Conversation context (plan/subagents/pending/links/events/files/tools/
  // flags/waiting) — see context.ts. Always cheap: it's state already
  // accumulated in memory, nothing gets re-parsed. Mid-read: the context
  // as it was when the read began (FileState.frozenCtx).
  getContext(folder: string, id: string): SessionContext | null {
    const s = this.files.get(`${folder}/${id}`)
    if (!s?.meta) return null
    return s.frozenCtx ?? s.ctx.state
  }

  // What readers see, recomputed from the accumulators — only ever between
  // reads (a read in flight publishes when it completes).
  private publish(s: FileState): void {
    if (s.reading) return
    s.frozenCtx = null
    s.meta = this.metaOf(s)
    s.hidden = isBookkeepingOnly(s)
    this.rev++
  }

  // One run of `fn` per key at a time; a call while one runs queues ONE
  // more (later calls share it: it starts after them, so it sees what they
  // would). A watcher event, a request and warm-up asking for the same
  // transcript never parse it twice at once.
  private serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const slot = this.chains.get(key)
    if (slot?.queued) return slot.queued as Promise<T>
    let p: Promise<T>
    if (!slot) {
      p = fn()
      this.chains.set(key, { tail: p, queued: null })
    } else {
      p = slot.tail
        .then(
          () => undefined,
          () => undefined,
        )
        .then(() => {
          slot.queued = null
          return fn()
        })
      slot.queued = p
      slot.tail = p
    }
    const settle = (): void => {
      if (this.chains.get(key)?.tail === p) this.chains.delete(key)
    }
    p.then(settle, settle)
    return p
  }

  // Root directory of a session (root/folder/id) — used by the subagents
  // route to build and validate (realpath) its transcript path
  // (root/folder/id/subagents/agent-<agentId>.jsonl).
  sessionDir(folder: string, id: string): string {
    return join(this.rootDir, folder, id)
  }

  refresh(folder: string, id: string): Promise<SessionMeta | null> {
    return this.serial(`${folder}/${id}`, () => this.doRefresh(folder, id))
  }

  private async doRefresh(folder: string, id: string): Promise<SessionMeta | null> {
    // Belt and suspenders: even though the watcher already filters, no path
    // (rename, a stray fs event, whatever) should be able to resurrect a
    // muted or ephemeral folder.
    if (this.shouldSkip(folder)) {
      if (this.remove(folder, id)) this.notify(folder, id, 'removed')
      return null
    }
    const key = `${folder}/${id}`
    const path = this.transcriptPath(folder, id)
    const st = await stat(path).catch(() => null)
    if (!st) {
      if (this.remove(folder, id)) this.notify(folder, id, 'removed')
      return null
    }
    let s = this.files.get(key)
    if (!s) {
      s = blankState(folder, id)
      this.files.set(key, s)
    }
    const rewritten = st.size < s.lineOffset // truncated or rewritten
    if (rewritten || st.size > s.lineOffset) {
      // readers keep the published state until the read completes (publish
      // is held while `reading`; a read that fails part-way keeps holding
      // it — the accumulators hold a prefix — until a later read completes)
      s.reading = true
      if (!s.frozenCtx && s.meta && st.size - (rewritten ? 0 : s.lineOffset) > SLICE_BYTES) s.frozenCtx = s.ctx.state
      if (rewritten) {
        s.lineOffset = 0
        s.acc = new TranscriptAccumulator()
        s.ctx = new ContextAccumulator()
      }
      const target = s
      const { acc, ctx } = target
      // each line parsed ONCE, the same record fed to both accumulators;
      // the offset advances with every slice fed (jsonl-lines.ts)
      await sliceLines(path, s.lineOffset, st.size, (lines, bytes) => {
        for (const line of lines) {
          const e = parseRecord(line)
          if (e === null) continue
          acc.feedRecord(e)
          ctx.feedRecord(e)
        }
        target.lineOffset += bytes
      })
    }
    s.cacheEntry = null // offset, state, mtime or size moved: re-serialized on the next flush
    s.mtime = st.mtimeMs
    s.size = st.size
    s.birthtime = st.birthtimeMs
    await this.subagentActivity(s)
    // removed (or rewritten under another state) while it was read: the
    // read answers nothing
    if (this.files.get(key) !== s) return null
    s.reading = false
    this.publish(s)
    this.scheduleCacheFlush()
    return s.meta
  }

  // The audit's read (contract.ts toolCalls): the session's transcript and
  // every subagent transcript under <session>/subagents — read whole, from
  // disk, never through the incremental caches. null = no transcript.
  async toolCalls(folder: string, id: string): Promise<SessionToolCalls | null> {
    // sliced (jsonl-lines.ts): a record's tool calls depend on that line alone
    const callsOf = async (path: string, session: string): Promise<SessionToolCalls['calls'] | null> => {
      const out: SessionToolCalls['calls'] = []
      const ok = await sliceWholeFile(path, (lines) => {
        for (const c of claudeToolCallsOfLines(lines, session)) out.push(c)
      }).then(
        () => true,
        () => false,
      )
      return ok ? out : null
    }
    const calls = await callsOf(this.transcriptPath(folder, id), id)
    if (calls === null) return null
    const children: string[] = []
    const dir = join(this.rootDir, folder, id, 'subagents')
    for (const n of (await readdir(dir).catch(() => [] as string[])).sort()) {
      const agentId = /^agent-([\w-]+)\.jsonl$/.exec(n)?.[1]
      if (agentId === undefined) continue
      const sub = await callsOf(join(dir, n), `agent-${agentId}`)
      if (sub === null) continue
      children.push(`agent-${agentId}`)
      for (const c of sub) calls.push(c)
    }
    return { calls, children }
  }

  // Usage's read (contract.ts usageRecords): the
  // session's transcript and every subagent transcript under
  // <session>/subagents, incrementally (usage-records.ts) — by its own
  // {folder, id}, listed or not (a muted or ephemeral folder), and from the
  // trash while it is there. null = no transcript anywhere.
  private usageFiles = new UsageFileCache()
  async usageRecords(folder: string, id: string): Promise<UsageRecord[] | null> {
    let main = await this.usageFiles.read(this.transcriptPath(folder, id), id)
    let subRoot = join(this.rootDir, folder, id)
    if (main === null && this.trashDir) {
      const buried = buriedPath(this.trashDir, folder, id)
      if (buried) {
        main = await this.usageFiles.read(buried.path, id)
        subRoot = buried.subDir
      }
    }
    if (main === null) return null
    const out = [...main]
    // every subagent file the census lists (subagentTranscripts: nested
    // layouts too) — the column's «N agents · X tokens» and this
    // conversation's Usage row sum the same files through the same cache
    const dir = join(subRoot, 'subagents')
    for (const rel of (await subagentTranscripts(dir)).sort()) {
      const agentId = /(?:^|\/)agent-([\w-]+)\.jsonl$/.exec(rel)?.[1]
      if (agentId === undefined) continue
      const sub = await this.usageFiles.read(join(dir, rel), `agent-${agentId}`)
      if (sub) out.push(...sub)
    }
    return out
  }

  // «Silos itself» (contract.ts silosOwnUsage): the titler's one-shot turns
  // run in a fresh tmp folder (titler-sdk.ts, TITLER_TMP_PREFIX) — an
  // ephemeral folder the index never lists, so they are read here by name:
  // <root>/<munged tmp>/<id>.jsonl, folders touched since `sinceMs`.
  async silosOwnUsage(sinceMs: number): Promise<UsageRecord[]> {
    const prefix = mungePath(join(tmpdir(), TITLER_TMP_PREFIX))
    const out: UsageRecord[] = []
    const dirs = await readdir(this.rootDir, { withFileTypes: true }).catch(() => [])
    for (const d of dirs) {
      if (!d.isDirectory() || !d.name.startsWith(prefix)) continue
      const dirPath = join(this.rootDir, d.name)
      const st = await stat(dirPath).catch(() => null)
      if (!st || st.mtimeMs < sinceMs) continue
      for (const f of await readdir(dirPath).catch(() => [] as string[])) {
        if (!f.endsWith('.jsonl')) continue
        const recs = await this.usageFiles.read(join(dirPath, f), f.slice(0, -'.jsonl'.length))
        if (recs) out.push(...recs.filter((r) => r.at >= sinceMs))
      }
    }
    return out
  }

  // contract.ts worktreeSessions: a session whose transcript lives under the
  // worktree's own folder key (the CLI moves it there when its conversation
  // enters the worktree), and the session whose subagent was spawned into it
  // (agent-<id>.meta.json `worktreePath`, under the project's folder). A
  // session whose subagents dir has not moved since `sinceMs` is not opened;
  // the sidecars read are kept by that dir's mtime.
  private worktreeMetas = new Map<string, { mtime: number; paths: string[] }>()
  async worktreeSessions(project: string, dirs: readonly string[], sinceMs: number): Promise<Map<string, string[]>> {
    const out = new Map(dirs.map((d) => [d, [] as string[]]))
    const add = (dir: string, id: string): void => {
      const l = out.get(dir)
      if (l && !l.includes(id)) l.push(id)
    }
    // the folder key of a path: every character outside [A-Za-z0-9] is '-' (mungePath is its '/' and '.' half)
    const byKey = new Map(
      dirs.flatMap(
        (d) =>
          [
            [mungePath(d), d],
            [d.replace(/[^A-Za-z0-9]/g, '-'), d],
          ] as Array<[string, string]>,
      ),
    )
    for (const m of this.list()) {
      const d = byKey.get(m.folder)
      if (d) add(d, m.id)
    }
    for (const key of new Set([mungePath(project), project.replace(/[^A-Za-z0-9]/g, '-')])) {
      const base = join(this.rootDir, key)
      for (const e of await readdir(base, { withFileTypes: true }).catch(() => [])) {
        if (!e.isDirectory()) continue
        const sub = join(base, e.name, 'subagents')
        const st = await stat(sub).catch(() => null)
        if (!st || st.mtimeMs < sinceMs) continue
        let hit = this.worktreeMetas.get(sub)
        if (!hit || hit.mtime !== st.mtimeMs) {
          const paths: string[] = []
          for (const rel of await subagentTranscripts(sub)) {
            const slash = rel.lastIndexOf('/')
            const agentId = /^agent-([\w-]+)\.jsonl$/.exec(slash === -1 ? rel : rel.slice(slash + 1))?.[1]
            if (agentId === undefined) continue
            const meta = await readJson(join(slash === -1 ? sub : join(sub, rel.slice(0, slash)), `agent-${agentId}.meta.json`))
            if (meta && typeof meta.worktreePath === 'string' && meta.worktreePath !== '') paths.push(meta.worktreePath)
          }
          hit = { mtime: st.mtimeMs, paths }
          this.worktreeMetas.set(sub, hit)
        }
        for (const p of hit.paths) add(p, e.name)
      }
    }
    return out
  }

  // Full census of the session's subagents dir — one entry per
  // agent-<id>.jsonl, merged with its .meta.json / .forked-skill.json
  // sidecars, newest first. Only RECENT transcripts (subagent still at
  // work) get their tail read for "what is it doing now" — history is
  // listed from metadata alone; each row's tokens are Usage's records for its file. Served by the session detail route; the
  // column is its only consumer, so the cost is one readdir + a few small
  // reads per open conversation.
  async listSubagents(folder: string, id: string): Promise<DiskSubagent[]> {
    const root = join(this.rootDir, folder, id, 'subagents')
    // the open tool calls first (the session's tracks, refreshed now): a row
    // silent inside a long command is still at work (DiskSubagent.toolSince)
    const s = this.files.get(`${folder}/${id}`)
    // a move seen here is announced like the heartbeat's: the dot reads the meta
    if (s && (await this.subagentActivity(s))) this.notify(folder, id, 'updated')
    const out: DiskSubagent[] = []
    for (const rel of await subagentTranscripts(root)) {
      const slash = rel.lastIndexOf('/')
      const dir = slash === -1 ? root : join(root, rel.slice(0, slash))
      const n = slash === -1 ? rel : rel.slice(slash + 1)
      const agentId = /^agent-([\w-]+)\.jsonl$/.exec(n)?.[1]
      if (agentId === undefined) continue
      const st = await stat(join(dir, n)).catch(() => null)
      if (!st) continue
      const sub: DiskSubagent = { id: agentId, description: null, type: null, mtime: st.mtimeMs }
      const inFlight = s?.subTracks.get(rel)?.toolSince ?? null
      if (inFlight !== null) sub.toolSince = inFlight
      if (st.birthtimeMs > 0) sub.startedAt = st.birthtimeMs
      const meta = await readJson(join(dir, `agent-${agentId}.meta.json`))
      if (meta) {
        if (typeof meta.description === 'string') sub.description = meta.description
        if (typeof meta.agentType === 'string') sub.type = meta.agentType
        if (typeof meta.model === 'string') sub.model = meta.model
        if (typeof meta.parentAgentId === 'string') sub.parentId = meta.parentAgentId
        if (typeof meta.spawnDepth === 'number') sub.depth = meta.spawnDepth
      }
      const skill = await readJson(join(dir, `agent-${agentId}.forked-skill.json`))
      if (skill) {
        if (typeof skill.skillName === 'string') sub.skill = skill.skillName
        if (typeof skill.effort === 'string') sub.effort = skill.effort
      }
      // the bill: model + tokens from the transcript itself. An inherited
      // launch writes no model to meta.json (launchedWithDefaults), so the
      // transcript's assistant messages are the truth of what actually ran.
      // Read through Usage's own cache (usageFiles, usage-records.ts): the
      // SAME records the Usage page sums for this conversation — one message
      // id once per file, the four kinds of tokens — so the census and Usage
      // never disagree, and the file is parsed once for both (incremental: a
      // finished file is remembered by bytes+mtime, a live one pays only for
      // what was appended).
      const recs = (await this.usageFiles.read(join(dir, n), `agent-${agentId}`)) ?? []
      const bill = subagentBill(recs)
      if (bill) sub.usage = bill
      if (sub.model === undefined && recs.length > 0) sub.model = recs[0]!.model
      if (Date.now() - st.mtimeMs < SUBAGENT_TAIL_MS || inFlight !== null) {
        const tail = readTail(join(dir, n), SUBAGENT_TAIL_BYTES)
        const tool = lastToolUse(tail)
        if (tool) {
          sub.lastTool = tool.name
          if (tool.detail) sub.lastToolDetail = tool.detail
        }
      }
      out.push(sub)
    }
    out.sort((a, b) => b.mtime - a.mtime)
    return out
  }

  // The session's background work, read from its subagents dir at any depth:
  // s.subMtime = the newest *.jsonl mtime (0 if none), s.subToolSince = the
  // newest tool still in flight in a FRESH transcript (0 if none) — each fresh
  // file fed incrementally to its own TranscriptAccumulator (the main
  // transcript's toolSince rule, verbatim). Returns whether either moved.
  // One look at a time per session (serial): the heartbeat, a refresh and
  // the subagents route never feed the same track twice.
  private subagentActivity(s: FileState): Promise<boolean> {
    return this.serial(`sub:${s.folder}/${s.id}`, () => this.lookAtSubagents(s))
  }

  private async lookAtSubagents(s: FileState): Promise<boolean> {
    const root = join(this.rootDir, s.folder, s.id, 'subagents')
    const now = Date.now()
    let max = 0
    let since = 0
    const seen = new Set<string>()
    for (const rel of await subagentTranscripts(root)) {
      const path = join(root, rel)
      const st = await stat(path).catch(() => null)
      if (!st) continue
      if (st.mtimeMs > max) max = st.mtimeMs
      // a file silent past the bound holds no tool in flight within it
      if (now - st.mtimeMs >= TOOL_MAX_MS) continue
      seen.add(rel)
      let t = s.subTracks.get(rel)
      if (!t || st.size < t.offset) {
        t = { offset: 0, acc: new TranscriptAccumulator(), toolSince: null }
        s.subTracks.set(rel, t)
      }
      if (st.size > t.offset) {
        const track = t
        await sliceLines(path, t.offset, st.size, (lines, bytes) => {
          track.acc.feedLines(lines)
          track.offset += bytes
        }).catch(() => 0) // vanished mid-read: the next look retries
        t.toolSince = t.acc.toolSince
      }
      const open = t.toolSince
      if (open !== null && open > since) since = open
    }
    for (const rel of [...s.subTracks.keys()]) if (!seen.has(rel)) s.subTracks.delete(rel)
    const moved = max !== s.subMtime || since !== s.subToolSince
    s.subMtime = max
    s.subToolSince = since
    if (moved && s.meta) this.publish(s) // the meta carries both
    return moved
  }

  // The heartbeat's body: for every session with an OPEN turn (few) — or a
  // CLOSED one whose background agent was recently at work — look at its
  // subagents dir; if it moved on since the last look, re-emit the meta so
  // the sidebar/context keep it "working". The watcher can't do this —
  // it's depth 1 (root/folder/*.jsonl) on purpose, and subagent files live
  // three levels down.
  async pollSubagentActivity(): Promise<void> {
    const now = Date.now()
    for (const s of this.files.values()) {
      const subRecent = s.subMtime > 0 && now - s.subMtime < SUBAGENT_WATCH_MS
      if (!s.acc.turnOpen && !subRecent) continue
      if (await this.subagentActivity(s)) this.notify(s.folder, s.id, 'updated')
    }
  }

  private heartbeat: NodeJS.Timeout | null = null
  startHeartbeat(intervalMs = SUBAGENT_POLL_MS): void {
    if (this.heartbeat) return
    // Same fire-and-forget rule as server.ts's turn-completion IIFE and
    // resident.ts's tick: pollSubagentActivity reads transcript files that can
    // vanish mid-poll (ENOENT), and an unhandled rejection from a setInterval
    // callback would crash the process. Swallow-and-log — a transient poll
    // failure must never take the server down.
    this.heartbeat = setInterval(() => {
      void this.pollSubagentActivity().catch((err) => console.error('[subagent heartbeat]', err instanceof Error ? err.message : err))
    }, intervalMs)
    this.heartbeat.unref?.()
  }
  stop(): void {
    if (this.heartbeat) clearInterval(this.heartbeat)
    this.heartbeat = null
  }

  // Returns whether the id was indexed: false = nothing to announce.
  remove(folder: string, id: string): boolean {
    if (this.files.delete(`${folder}/${id}`)) {
      this.rev++
      this.scheduleCacheFlush()
      return true
    }
    return false
  }

  async readTurns(folder: string, id: string): Promise<TranscriptTurn[]> {
    return readTurnsOf(this.transcriptPath(folder, id))
  }

  private metaOf(s: FileState): SessionMeta {
    const meta: SessionMeta = {
      id: s.id,
      folder: s.folder,
      harness: 'claude-code',
      title: s.acc.title ?? '(untitled)',
      skills: s.acc.skills,
      cwd: s.acc.cwd,
      // mtime = CONTENT activity (the transcript's last timestamp), not the
      // FILE's mtime: an external process can bump the file without adding
      // anything, which made yesterday's conversations show up as "just
      // now". Falls back to the file's mtime if there's no valid timestamp.
      // While the turn is open, a working subagent's transcript counts too
      // (FileState.subMtime).
      mtime: Math.max(s.acc.lastTs ?? s.mtime, s.acc.turnOpen ? s.subMtime : 0),
      size: s.size,
      turnCount: s.acc.turnCount,
    }
    // Present only when there's data — undefined (not null) is what makes
    // `key in meta` === false and lets JSON.stringify omit them.
    if (s.acc.contextTokens !== null) meta.contextTokens = s.acc.contextTokens
    if (s.acc.model !== null) meta.model = s.acc.model
    if (s.acc.queue.length > 0) meta.queue = s.acc.queue
    if (s.acc.lastRole !== null) meta.lastRole = s.acc.lastRole // unread state input
    if (s.acc.lastRole !== null) meta.turnOpen = s.acc.turnOpen // the dot's blink input (see parser.ts)
    if (s.acc.turnOpen && s.acc.toolSince !== null) meta.toolSince = s.acc.toolSince
    if (s.acc.shellSince !== null) meta.shellSince = s.acc.shellSince // a background command it awaits (work-live.ts)
    if (s.birthtime > 0) meta.startedAt = s.birthtime // same rule as DiskSubagent.startedAt
    if (s.subMtime > 0) meta.subMtime = s.subMtime // background subagents: the blink with the turn closed (live.ts)
    if (s.subToolSince > 0) meta.subToolSince = s.subToolSince // …and while one of them runs a silent tool (work-live.ts)
    if (s.ctx.hasPendingAsk) meta.pendingAsk = true // solid dot: the agent asked and waits
    if (s.acc.resumedFrom) meta.resumedFrom = s.acc.resumedFrom // a continuation: Claude Code forks on --resume
    if (s.acc.startedByClear) meta.startedByClear = true // a /clear: a new conversation, not a continuation
    if (s.acc.console) meta.console = true // written by the engine's console (entrypoint cli)
    return meta
  }

  private flushTimer: NodeJS.Timeout | null = null
  private scheduleCacheFlush(): void {
    if (this.flushTimer) return
    this.flushTimer = setTimeout(() => {
      this.flush().catch((err) => console.error('failed to persist the session cache:', err))
    }, 2000)
    this.flushTimer.unref()
  }

  // The cache file, rebuilt from each file's kept entry: only the entries
  // that changed since the last flush are serialized again (with the loop
  // released every FLUSH_BATCH of them), and the file is written without
  // blocking. Same document as one JSON.stringify of CacheShape. A file whose
  // first read hasn't completed has no entry yet; one mid-read keeps the
  // entry of its last complete read (offset and state always agree).
  flush(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    return this.serial('flush', () => this.writeCache())
  }

  private async writeCache(): Promise<void> {
    const parts: string[] = []
    let fresh = 0
    for (const [key, s] of [...this.files]) {
      if (!s.meta) continue
      if (s.cacheEntry === null) {
        if (s.reading) continue // its previous entry was dropped with the change: the next flush has it
        const entry: CacheShape['files'][string] = { lineOffset: s.lineOffset, mtime: s.mtime, size: s.size, state: s.acc.state, context: s.ctx.state }
        s.cacheEntry = JSON.stringify(entry)
        if (++fresh % FLUSH_BATCH === 0) await releaseLoop()
      }
      parts.push(`${JSON.stringify(key)}:${s.cacheEntry}`)
    }
    const tmp = this.cachePath + '.tmp'
    await writeFile(tmp, `{"version":${CACHE_VERSION},"files":{${parts.join(',')}}}`)
    await rename(tmp, this.cachePath)
  }
}

/** The index with Claude Code as its fallback reader — what index.ts builds,
 *  minus the extra readers it adds after. */
export function claudeSessionIndex(root: string, cachePath: string, muted?: readonly string[], ephemeralPrefix?: string | null): SessionIndex {
  return new SessionIndex(new ClaudeReader(root, cachePath, muted, ephemeralPrefix))
}

// A transcript with no timestamped record, no turns and nothing queued is
// bookkeeping, not a conversation: a dying `claude` writes a fresh stub
// JSONL (last-prompt/ai-title/mode/bridge-session, none with a timestamp)
// whose only "activity" would be the file's mtime — a mass process-kill
// made a batch of them all read "1m ago" at once. Hidden from
// allSessions() and the live emit; getMeta/getContext by id still answer
// (trash, lineage and console lookups must keep seeing them), and the
// first real content surfaces the session normally.
function isBookkeepingOnly(s: FileState): boolean {
  return s.acc.lastTs === null && s.acc.turnCount === 0 && s.acc.queue.length === 0
}

// Every *.jsonl under a session's subagents dir, as paths relative to it —
// the flat agent-<id>.jsonl files (nested agents too: Claude Code writes them
// flat with parentAgentId/spawnDepth in the sidecar) and any subfolder
// (workflow agents), SUBAGENT_DIR_DEPTH deep. [] when there is no dir.
async function subagentTranscripts(root: string): Promise<string[]> {
  const out: string[] = []
  const walk = async (rel: string, depth: number): Promise<void> => {
    const entries = await readdir(rel === '' ? root : join(root, rel), { withFileTypes: true }).catch(() => [])
    for (const e of entries) {
      const r = rel === '' ? e.name : `${rel}/${e.name}`
      if (e.isFile() && e.name.endsWith('.jsonl')) out.push(r)
      else if (e.isDirectory() && depth < SUBAGENT_DIR_DEPTH) await walk(r, depth + 1)
    }
  }
  await walk('', 0)
  return out
}

function blankState(folder: string, id: string): FileState {
  return {
    folder,
    id,
    lineOffset: 0,
    mtime: 0,
    size: 0,
    subMtime: 0,
    subToolSince: 0,
    subTracks: new Map(),
    birthtime: 0,
    acc: new TranscriptAccumulator(),
    ctx: new ContextAccumulator(),
    meta: null,
    hidden: false,
    reading: false,
    frozenCtx: null,
    cacheEntry: null,
  }
}

// A transcript line as a record, or null (blank, cut or foreign) — the same
// gate as TranscriptAccumulator/ContextAccumulator.feedLines.
function parseRecord(line: string): Record<string, unknown> | null {
  if (!line.trim()) return null
  try {
    const e = JSON.parse(line) as unknown
    return e !== null && typeof e === 'object' ? (e as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/** A transcript's turns, read whole and sliced (jsonl-lines.ts) — what the
 *  conversation view and the subagent route render. Rejects when the file
 *  can't be read. */
export async function readTurnsOf(path: string): Promise<TranscriptTurn[]> {
  const acc = new TranscriptAccumulator()
  const turns: TranscriptTurn[] = []
  await sliceWholeFile(path, (lines) => {
    for (const t of acc.feedLines(lines)) turns.push(t)
  })
  return turns
}
