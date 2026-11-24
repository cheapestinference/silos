export function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter(
      (c): c is { type: 'text'; text: string } =>
        !!c && typeof c === 'object' && (c as { type?: unknown }).type === 'text' && typeof (c as { text?: unknown }).text === 'string',
    )
    .map((c) => c.text)
    .join('\n')
}

export interface ToolRef {
  name: string
  skill: string | null
}

export function toolsOf(content: unknown): ToolRef[] {
  if (!Array.isArray(content)) return []
  const out: ToolRef[] = []
  for (const c of content) {
    if (!c || typeof c !== 'object' || (c as { type?: unknown }).type !== 'tool_use') continue
    const name = typeof (c as { name?: unknown }).name === 'string' ? (c as { name: string }).name : '?'
    const input = (c as { input?: { skill?: unknown } }).input
    const skill = name === 'Skill' && typeof input?.skill === 'string' ? input.skill : null
    out.push({ name, skill })
  }
  return out
}

export function thinkingOf(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content
    .filter(
      (c): c is { type: 'thinking'; thinking: string } =>
        !!c && typeof c === 'object' && (c as { type?: unknown }).type === 'thinking' && typeof (c as { thinking?: unknown }).thinking === 'string',
    )
    .map((c) => c.thinking)
    .join('\n\n')
}

// c6 — plan mode. Verified on a real transcript (CLI 2.1.316, fixture
// plan-mode.jsonl): the CLI fills ExitPlanMode's tool_use input with
// { plan, planFilePath } (what went over the wire was {}), and an approval's
// toolUseResult is { plan, isAgent, filePath } with a result text that
// starts "User has approved your plan".
export const PLAN_TEXT_CAP = 20000
export function planProposalOf(input: unknown): PlanProposal | null {
  const i = input as { plan?: unknown; planFilePath?: unknown } | null
  if (!i || typeof i !== 'object' || typeof i.plan !== 'string' || i.plan.trim() === '') return null
  const out: PlanProposal = { text: i.plan.slice(0, PLAN_TEXT_CAP), state: 'proposed' }
  if (typeof i.planFilePath === 'string') out.file = i.planFilePath
  return out
}
export function planApproved(resultText: string, toolUseResult: unknown): boolean {
  const r = toolUseResult as { plan?: unknown } | null | undefined
  return (r !== null && typeof r === 'object' && typeof r.plan === 'string') || resultText.startsWith('User has approved your plan')
}

export function toolUseDetailsOf(content: unknown): { id: string | null; detail: ToolUseDetail }[] {
  if (!Array.isArray(content)) return []
  const out: { id: string | null; detail: ToolUseDetail }[] = []
  for (const c of content) {
    if (!c || typeof c !== 'object' || (c as { type?: unknown }).type !== 'tool_use') continue
    const name = typeof (c as { name?: unknown }).name === 'string' ? (c as { name: string }).name : '?'
    const input = (c as { input?: { skill?: unknown } }).input
    const skill = name === 'Skill' && typeof input?.skill === 'string' ? input.skill : null
    const id = typeof (c as { id?: unknown }).id === 'string' ? (c as { id: string }).id : null
    const plan = name === 'ExitPlanMode' ? planProposalOf(input) : null
    if (plan) {
      // the plan rides `plan` whole; the raw input keeps only the rest
      const { plan: _text, ...rest } = input as Record<string, unknown>
      out.push({ id, detail: { name, skill, input: JSON.stringify(rest).slice(0, 2000), result: null, plan } })
      continue
    }
    out.push({ id, detail: { name, skill, input: JSON.stringify(input ?? {}).slice(0, 2000), result: null } })
  }
  return out
}

// ── multimedia ─────────────────────────────────────────────────────────
// The real corpus carries 176 images (all base64, PNG/JPEG) and ALL of
// them inside tool_results (a Read of a PNG, Playwright screenshots…);
// images pasted by the user: 0 today, but they share a shape (a
// type:'image' block with source.base64) and are covered by the same
// path. MEMORY RULE: the parser NEVER copies the base64 — it only
// measures its length and looks at a 44-char prefix to pull the PNG
// header's dimensions. The heavy data stays in the JSONL and the
// /media/:ref route re-extracts it on demand (see media.ts).

// Defensive cap on images per entry — the real corpus max is 1 per
// tool_result; 12 covers any legitimate use without letting a
// corrupt/adversarial JSONL inflate turns without limit.
const IMAGES_CAP = 12

// PNG dimensions by reading ONLY the IHDR header: the first 33 bytes (44
// base64 chars) contain the signature + IHDR with big-endian width/height
// at offsets 16..24. JPEG would require scanning SOF segments (a fixed
// prefix won't do) → returns null and the UI uses a fixed-size box.
export function pngDims(base64: string): { w: number; h: number } | null {
  if (base64.length < 44) return null
  let buf: Buffer
  try {
    buf = Buffer.from(base64.slice(0, 44), 'base64')
  } catch {
    return null
  }
  if (buf.length < 24) return null
  // PNG signature: 89 50 4E 47 0D 0A 1A 0A
  if (buf.readUInt32BE(0) !== 0x89504e47 || buf.readUInt32BE(4) !== 0x0d0a1a0a) return null
  const w = buf.readUInt32BE(16)
  const h = buf.readUInt32BE(20)
  if (w === 0 || h === 0 || w > 100_000 || h > 100_000) return null
  return { w, h }
}

// Security: allowlist of RASTER types — a scriptable media_type
// (image/svg+xml) navigated to directly at /media/:ref would be a
// document in Silos' own origin with access to the token/transcripts. The
// block doesn't even get turned into a TurnImage (belt); media.ts serves
// anything outside this list as application/octet-stream + nosniff
// (suspenders). Exact mirror in media.ts's RASTER_TYPES.
const RASTER_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])

export interface ImageMeta {
  mediaType: string
  bytes: number
  w?: number
  h?: number
  // Position of the block among ALL type:'image' blocks in its content —
  // the ref is minted with THIS index, not the position in the filtered
  // array, so nthImage (media.ts, which counts every image block) can
  // never resolve a ref to the wrong block when the allowlist (or an
  // unusable source) skipped one along the way.
  blockIdx: number
}

// Metadata for a type:'image' block with a base64 source — null if the
// block doesn't carry usable data (a url-type source, not seen in the
// corpus) or its media_type isn't an allowlisted raster (never an svg
// TurnImage).
function imageMetaOf(block: unknown, blockIdx: number): ImageMeta | null {
  if (!block || typeof block !== 'object') return null
  const src = (block as { source?: { type?: unknown; data?: unknown; media_type?: unknown } }).source
  if (!src || src.type !== 'base64' || typeof src.data !== 'string' || src.data === '') return null
  const mediaType = typeof src.media_type === 'string' ? src.media_type : 'image/png'
  if (!RASTER_TYPES.has(mediaType)) return null
  const meta: ImageMeta = { mediaType, bytes: Math.floor(src.data.length * 0.75), blockIdx }
  const dims = pngDims(src.data)
  if (dims) {
    meta.w = dims.w
    meta.h = dims.h
  }
  return meta
}

// Walks a content's type:'image' blocks in order, minting the universal
// blockIdx (counts ALL of them, including ones the allowlist discards) —
// a single collector for both forms (direct and tool_result-nested).
function collectImages(blocks: unknown): ImageMeta[] {
  if (!Array.isArray(blocks)) return []
  const out: ImageMeta[] = []
  let blockIdx = 0
  for (const b of blocks) {
    if (!b || typeof b !== 'object' || (b as { type?: unknown }).type !== 'image') continue
    const meta = imageMetaOf(b, blockIdx)
    blockIdx++
    if (meta) out.push(meta)
    if (out.length >= IMAGES_CAP) break
  }
  return out
}

// DIRECT image blocks in the content (an image pasted by the user) —
// never the ones nested in a tool_result (those go through toolResultsOf).
export function imagesOf(content: unknown): ImageMeta[] {
  return collectImages(content)
}

export function toolResultsOf(content: unknown): { toolUseId: string; text: string; images: ImageMeta[]; isError: boolean }[] {
  if (!Array.isArray(content)) return []
  const out: { toolUseId: string; text: string; images: ImageMeta[]; isError: boolean }[] = []
  for (const c of content) {
    if (!c || typeof c !== 'object' || (c as { type?: unknown }).type !== 'tool_result') continue
    const toolUseId = typeof (c as { tool_use_id?: unknown }).tool_use_id === 'string' ? (c as { tool_use_id: string }).tool_use_id : null
    if (!toolUseId) continue
    // Images NESTED in a tool_result's content (a Read of a PNG, a
    // screenshot…) — where 100% of the corpus' images live.
    const inner = (c as { content?: unknown }).content
    out.push({ toolUseId, text: textOf(inner), images: collectImages(inner), isError: (c as { is_error?: unknown }).is_error === true })
  }
  return out
}

// The prelude that ClaudeHeadless.withSkillsPrelude prepends to a new
// session's first message ("[silos-context] ... [/silos-context]")
// stays in the real JSONL (the SDK treats it as regular user text): TITLE
// derivation skips it BEFORE the slice(0,90) so it isn't shown, but the
// emitted turn keeps the full text — only presentation changes. Mirrors
// the web/src/lib/agent-context.ts helper (stripAgentContext).
//
// The composer's memory mode client-side prepends a
// "[silos-memory path=...] ... [/silos-memory]" block — same title
// treatment. Both markers can stack at the start of the same message, so
// the strip is a loop (see the twin comment in agent-context.ts).
const AGENT_BLOCK_RE = /^\[silos-(context|memory)[^\]]*\][\s\S]*?\[\/silos-\1\]\s*/

export function stripAgentContextForTitle(text: string): string {
  let out = text
  let m: RegExpMatchArray | null
  while ((m = out.match(AGENT_BLOCK_RE))) {
    out = out.slice(m[0].length)
  }
  return out
}

// Rescuing mid-turn interjections: the Claude Agent SDK's harness persists
// messages the owner types WHILE a turn is still running wrapped INSIDE
// the tool_result block of the tool that was running at that moment —
// never as a normal 'user' entry. Without this rescue, those messages
// disappear forever from view: the ingest below completely discards a
// 'user' entry that's only a tool_result (no 'text' blocks), so its real
// text (the owner's message) never made it into any turn — a permanent
// loss, not a UI bug.
//
// FRAGILE HEURISTIC: the exact literal below is INTERNAL harness format
// (undocumented, unversioned, not a stable SDK contract). If the harness
// changes the wording of the opening MARKER, this regex stops matching —
// behavior then reverts to EXACTLY what it was before this rescue existed:
// the message is lost the way it always was, no exception or corrupt turn
// (interjectionsOf returns `[]`, zero difference from the pre-rescue
// code). If this ever stops rescuing anything in new sessions, that's the
// first sign the SDK changed the format.
//
// That "fails closed" is NO LONGER universal now that closing depends on
// the boilerplate too — it only covers a change to the opening MARKER. If
// the harness changes only the CLOSING boilerplate's wording ("This is how
// Claude Code surfaces...") while keeping the opening marker intact, the
// boilerplate lookahead stops matching but the opening marker still does:
// the lazy capture then expands to the next marker or, if there isn't one,
// to the end of the text — a silent over-capture (it drags along the new,
// unrecognized boilerplate as if it were part of the message), not a clean
// `[]`. Still better than the total loss from before this rescue existed,
// but it's no longer "zero difference": if the rescue starts returning
// suspiciously long interjections or ones with boilerplate text mixed in,
// that's the signal the closing (not the opening) changed.
//
// The original closing ('\n\n' or end of text) assumed an interjection
// never contains a paragraph break of its own — false: the owner can write
// several blank-line-separated lines within the SAME interjected message.
// Any '\n\n' would cut that interjection in half, losing the rest. The
// correct close stops at whichever comes FIRST: the real boilerplate the
// harness prepends after each interjected block, or the next opening
// marker (two interjections can share a single trailing boilerplate, with
// none of their own in between — without this second alternative the
// first capture would swallow the literal marker and the second one's
// text, merging them into one corrupted blob), or the end of the text if
// neither is there. A lookahead in all three cases (not consumed), so the
// next marker in the same string still matches with matchAll.
const INTERJECTION_MARKER = 'The user sent a new message while you were working:'
const INTERJECTION_RE =
  /The user sent a new message while you were working:\n([\s\S]*?)(?=\n\nThis is how Claude Code surfaces|\n\nThe user sent a new message while you were working:|$)/g

export function interjectionsOf(text: string): string[] {
  if (!text.includes(INTERJECTION_MARKER)) return []
  const out: string[] = []
  for (const m of text.matchAll(INTERJECTION_RE)) {
    const rescued = m[1]?.trim()
    if (rescued) out.push(rescued)
  }
  return out
}

// CROSS-SESSION messages: another Claude session can send this one a
// message via the harness's peer-messaging. In the JSONL they land as a
// user entry with isMeta:true, a structured `origin` object
// ({kind:'peer', name, from, body, …}), and content as a string:
//
//   Another Claude session sent a message:
//   <cross-session-message from="uds:/tmp/cc-socks/N.sock" from-name="X" from-mode="bypass">
//   …body (multiline)…
//   </cross-session-message>
//
//   This came from another Claude session — …security boilerplate…
//
// (real shapes from the corpus: 3 sessions in ~/.claude/projects; the
// attributes seen are from/from-name/from-mode and sometimes hop-chain).
// Without this rescue they were invisible: isMeta:true discarded them
// whole (and the raw content of their queue-operation copies starts with
// '<' → isNoise).
//
// Two detection paths, in order:
//   1. Structured `origin` (kind:'peer' + a body string) — the
//      authoritative one: body is the ALREADY clean body and name is the
//      friendly sender.
//   2. Parsing the tag in the text — a defensive fallback in case some
//      old/future entry doesn't carry origin. TWO guards: the tag must be
//      AT THE START of the text (after the harness's optional prefix) —
//      an owner message that only MENTIONS the tag mid-text is NOT a
//      cross-session message — AND the entry must carry the harness's
//      meta markers (isMeta:true or promptSource:'system'): a message the
//      owner types/pastes STARTING with the literal tag (a JSONL snippet
//      while debugging, say) can't be reclassified as a third voice.
//      Without those markers it follows the normal user treatment as
//      always (and the current noise rule filters it, like any '<' paste
//      from the owner).
const CROSS_SESSION_PREFIX = 'Another Claude session sent a message:'
const CROSS_SESSION_OPEN_RE = /^<cross-session-message\s+([^>]*)>/
const CROSS_SESSION_CLOSE = '</cross-session-message>'

export interface InterSessionMsg {
  from: string
  text: string
}

export function interSessionOf(content: unknown, origin?: unknown, entry?: { isMeta?: unknown; promptSource?: unknown }): InterSessionMsg | null {
  // path 1: the harness's structured origin
  if (origin && typeof origin === 'object') {
    const o = origin as { kind?: unknown; body?: unknown; name?: unknown; from?: unknown }
    if (o.kind === 'peer' && typeof o.body === 'string' && o.body.trim() !== '') {
      const from = typeof o.name === 'string' && o.name.trim() !== '' ? o.name : typeof o.from === 'string' && o.from.trim() !== '' ? o.from : 'peer'
      return { from, text: o.body.trim() }
    }
  }
  // path 2: a tag at the start of the text (after the optional prefix) —
  // only if the entry carries the harness's meta markers (see comment above)
  if (!(entry?.isMeta === true || entry?.promptSource === 'system')) return null
  let s = textOf(content).trim()
  if (s.startsWith(CROSS_SESSION_PREFIX)) s = s.slice(CROSS_SESSION_PREFIX.length).trimStart()
  const open = s.match(CROSS_SESSION_OPEN_RE)
  if (!open) return null
  const attrs = open[1] ?? ''
  const fromName = attrs.match(/(?:^|\s)from-name="([^"]*)"/)
  const fromRaw = attrs.match(/(?:^|\s)from="([^"]*)"/)
  const from = fromName?.[1]?.trim() || fromRaw?.[1]?.trim() || 'peer'
  const rest = s.slice(open[0].length)
  const close = rest.indexOf(CROSS_SESSION_CLOSE)
  // no closing tag (truncated): take the whole rest — a visible truncated
  // body beats going back to the invisibility from before this rescue.
  const body = (close === -1 ? rest : rest.slice(0, close)).trim()
  if (body === '') return null
  return { from, text: body }
}

export function isNoise(text: string): boolean {
  const s = text.trim()
  return s === '' || s.startsWith('<') || s.startsWith('Caveat:') || s.startsWith('[Request interrupted')
}

// Content activity is an ALLOW-LIST: a record moves lastTs only when
// somebody did something — the owner wrote (or queued) a message, the model
// replied, a tool came back, a turn closed. Everything else the harness
// files on its own never counts, including record kinds that don't exist
// yet. The bug this closes (systematically, so it
// cannot happen): on `--resume` Claude Code stamps NOW on a "[Tool call
// interrupted…]" tool_result, a synthetic "No response requested." and a
// task-notification for a background job that died with the old process —
// waking yesterday's conversation made it "2h" and unread. A deny-list of
// those three would break again on the next record the harness invents.
// A live task-notification is followed by the model's reply, which carries
// the activity itself.
export function isActivity(e: Record<string, unknown>): boolean {
  if (e.type === 'queue-operation') return e.operation === 'enqueue' && typeof e.content === 'string' && !isNoise(e.content)
  if (e.type === 'system') return e.subtype === 'turn_duration'
  const msg = conversationalMessage(e)
  if (!msg) return false
  if (msg.role === 'assistant') return msg.model !== '<synthetic>'
  const origin = (e.origin as { kind?: unknown } | undefined)?.kind
  if (origin === 'task-notification' || (e.promptSource === 'system' && origin !== 'peer')) return false
  const results = toolResultsOf(msg.content)
  if (results.length > 0 && results.every((r) => r.text.trimStart().startsWith('[Tool call interrupted'))) return false
  return true
}

// The one rule for "is this JSONL record a message of the conversation":
// the RECORD's own `type` is 'user' | 'assistant' and its message's role
// agrees. Newer Claude Code also writes `api-request-blob` records (the
// request body it sent: system/user/assistant messages replayed with a
// `message.role`) — classifying by `message.role` alone painted each of
// them as an extra turn (a reply and its tool chips twice). Every reader
// that walks transcript records goes through here, never `message.role`.
export interface ConversationalMessage {
  role: 'user' | 'assistant'
  content?: unknown
  model?: unknown
}
export function conversationalMessage(e: Record<string, unknown>): ConversationalMessage | null {
  if (e.type !== 'user' && e.type !== 'assistant') return null
  const msg = e.message as { role?: unknown } | undefined
  if (!msg || typeof msg !== 'object' || msg.role !== e.type) return null
  return msg as ConversationalMessage
}

export function splitCompleteLines(buf: Buffer): { lines: string[]; consumed: number } {
  const idx = buf.lastIndexOf(0x0a)
  if (idx === -1) return { lines: [], consumed: 0 }
  return { lines: buf.subarray(0, idx).toString('utf8').split('\n'), consumed: idx + 1 }
}

import type { TranscriptTurn, ToolUseDetail, TurnImage, Role, PlanProposal } from '../../types.js'

// Dimensions the harness leaves at the ENTRY level when a tool returns an
// image (toolUseResult.file.dimensions — verified against the corpus:
// displayWidth/Height describe the base64 traveling in the content, which
// can come rescaled from the original). Only applicable when the
// tool_result carries ONE image (the field is singular).
function toolUseResultDims(e: Record<string, unknown>): { w: number; h: number } | null {
  const file = (e.toolUseResult as { file?: { dimensions?: Record<string, unknown> } } | undefined)?.file
  const d = file?.dimensions
  if (!d) return null
  const w = typeof d.displayWidth === 'number' ? d.displayWidth : typeof d.originalWidth === 'number' ? d.originalWidth : null
  const h = typeof d.displayHeight === 'number' ? d.displayHeight : typeof d.originalHeight === 'number' ? d.originalHeight : null
  if (w === null || h === null || w <= 0 || h <= 0) return null
  return { w, h }
}

export interface AccumulatorState {
  title: string | null
  titleSource: 'ai' | 'user' | null
  skills: string[]
  cwd: string | null
  turnCount: number
  contextTokens: number | null // input+cache_creation+cache_read from the last assistant usage seen
  model: string | null // message.model from the last assistant usage seen
  queue: string[] // external queue rebuilt from queue-operation entries
  // Role of the LAST turn with REAL CONTENT — the one that decides whether
  // a conversation is "unread". Only set by genuine conversational turns
  // (an owner message or an agent reply): NOT marker turns (turn_duration,
  // compact), NOT the harness's synthetic notices (rate limits/errors: the
  // agent didn't actually reply), NOT messages from another session
  // (interSession, the third voice). null = a session with no
  // conversational turn yet. See unread.ts (isUnread).
  lastRole: Role | null
  // The session's REAL activity: ms of the LAST timestamp seen in the
  // transcript. Used as "content" mtime instead of the FILE's mtime, which
  // an external process (e.g. claude-auto-retry rewriting its JSONL) bumps
  // without adding anything — that made yesterday's conversation show up
  // as "just now" and jump to the top. null = no entry with a valid timestamp.
  lastTs: number | null
  // The session this transcript CONTINUES: Claude Code (2.1.207+) does not
  // append to <id>.jsonl on `--resume <id>` — it opens a NEW file and
  // stamps every record with `session_id` = the origin and `sessionId` =
  // the file. First such origin seen, null when the file is its own start.
  resumedFrom?: string | null
  // This transcript was STARTED by a console `/clear`: Claude Code files the
  // SessionStart hooks' output with hookName "SessionStart:clear" at the top
  // of the new file. A /clear is a new conversation — the
  // sidebar gives it its own row instead of folding it under the cleared
  // one. Absent in old caches → false.
  startedByClear?: boolean
  // This transcript was written by the engine's CONSOLE (the interactive
  // CLI): Claude Code stamps every record with `entrypoint` — "cli" for the
  // terminal, "sdk-…" for the Agent SDK. The first one seen decides. What
  // «Open» reads: an agent with a console in the
  // index opens in its console, else in chat. null = no entrypoint seen yet
  // (absent in old caches).
  console?: boolean | null
  // Is the agent's turn still OPEN? true from the owner's real message
  // until the CLI receipt (system/turn_duration) or an assistant message
  // with stop_reason "end_turn" (SDK sessions carry no receipt). The
  // sidebar dot blinks on THIS, not on lastRole: mid-turn the agent's
  // intermediate messages (tool calls) already flip lastRole to
  // 'assistant' and light the durable unread, and the owner wants the
  // blink for as long as it's working. Absent in old caches →
  // false (the client falls back to lastRole).
  turnOpen: boolean
  // ms timestamp of the last assistant tool_use that has no tool_result
  // yet, null when nothing is in flight. A long tool (a 5-minute Bash)
  // writes NOTHING to the transcript until it returns, so activity went
  // cold and the row read "Idle" mid-work. The client
  // treats an open turn with a tool in flight as working, up to a cap
  // (TOOL_MAX_MS in web/lib/live.ts) so a dead session can't blink forever.
  toolSince: number | null
  // background commands this conversation launched and still awaits: a Bash
  // run in the background answers at once («running in background», its
  // toolUseResult.backgroundTaskId) and the engine re-opens the conversation
  // when it ends (a <task-notification> naming that id). Between the two the
  // conversation WORKS with its turn closed (working while a
  // shell runs) — [id, ms it started], bounded by SHELL_MAX_MS
  // (work-live.ts) since a notification may never come (the engine died).
  shells?: [string, number][]
}

// Tools that PARK a conversation instead of computing: their open tool_use
// is «waiting on something» (context.ts names what), never a tool in flight
// — or a parked conversation would read as working.
export const PARKING_KIND: Readonly<Record<string, 'monitor' | 'wakeup' | 'workflow'>> = { Monitor: 'monitor', ScheduleWakeup: 'wakeup', Workflow: 'workflow' }
export const PARKING_TOOLS: ReadonlySet<string> = new Set(Object.keys(PARKING_KIND))
const MAX_SHELLS = 50
const TASK_NOTIFICATION_ID_RE = /<task-notification>\s*<task-id>([^<\s]+)<\/task-id>/g

// Defensive cap on the external queue — a corrupt/adversarial JSONL with
// thousands of queue-operation entries must not grow the state unbounded.
const QUEUE_CAP = 20

export class TranscriptAccumulator {
  title: string | null = null
  titleSource: 'ai' | 'user' | null = null
  cwd: string | null = null
  turnCount = 0
  contextTokens: number | null = null
  model: string | null = null
  lastRole: Role | null = null // unread state input, see AccumulatorState.lastRole
  lastTs: number | null = null // content activity, see AccumulatorState.lastTs
  turnOpen = false // see AccumulatorState.turnOpen
  toolSince: number | null = null // see AccumulatorState.toolSince
  private shellMap = new Map<string, number>() // see AccumulatorState.shells
  resumedFrom: string | null = null // see AccumulatorState.resumedFrom
  startedByClear = false // see AccumulatorState.startedByClear
  console: boolean | null = null // see AccumulatorState.console
  private queueArr: string[] = []
  private skillSet = new Set<string>()
  private pendingTools = new Map<string, ToolUseDetail>()

  constructor(state?: AccumulatorState) {
    if (state) {
      this.title = state.title
      this.titleSource = state.titleSource
      this.cwd = state.cwd
      this.turnCount = state.turnCount
      this.skillSet = new Set(state.skills)
      this.contextTokens = state.contextTokens
      this.model = state.model
      this.queueArr = [...state.queue]
      this.lastRole = state.lastRole ?? null // tolerant of old caches missing the field
      this.lastTs = state.lastTs ?? null // same — an old cache with no lastTs falls back to the file's mtime
      this.turnOpen = state.turnOpen ?? false
      this.toolSince = state.toolSince ?? null
      this.shellMap = new Map(state.shells ?? [])
      this.resumedFrom = state.resumedFrom ?? null
      this.startedByClear = state.startedByClear ?? false
      this.console = state.console ?? null
    }
  }

  get skills(): string[] {
    return [...this.skillSet]
  }

  get queue(): string[] {
    return [...this.queueArr]
  }

  get state(): AccumulatorState {
    return {
      title: this.title,
      titleSource: this.titleSource,
      skills: this.skills,
      cwd: this.cwd,
      turnCount: this.turnCount,
      contextTokens: this.contextTokens,
      model: this.model,
      queue: this.queue,
      lastRole: this.lastRole,
      lastTs: this.lastTs,
      turnOpen: this.turnOpen,
      toolSince: this.toolSince,
      ...(this.shellMap.size > 0 ? { shells: [...this.shellMap] } : {}),
      resumedFrom: this.resumedFrom,
      startedByClear: this.startedByClear,
      console: this.console,
    }
  }

  feedLines(lines: string[]): TranscriptTurn[] {
    const fresh: TranscriptTurn[] = []
    for (const line of lines) {
      if (!line.trim()) continue
      let e: Record<string, unknown>
      try {
        e = JSON.parse(line) as Record<string, unknown>
      } catch {
        continue
      }
      this.ingest(e, fresh)
    }
    return fresh
  }

  // One already-parsed record, its turns discarded — the reader's path: it
  // parses each line ONCE and hands the same record to this accumulator and
  // to the ContextAccumulator (neither mutates a record).
  feedRecord(e: Record<string, unknown>): void {
    this.ingest(e, this.discard)
    this.discard.length = 0
  }
  private discard: TranscriptTurn[] = []

  /** ms the newest background command still awaited started, null = none. */
  get shellSince(): number | null {
    let newest: number | null = null
    for (const ms of this.shellMap.values()) if (newest === null || ms > newest) newest = ms
    return newest
  }
  // a <task-notification> for a command we track: it ended (or was stopped)
  private shellsEnded(text: string): void {
    if (this.shellMap.size === 0 || !text.includes('<task-notification>')) return
    for (const m of text.matchAll(TASK_NOTIFICATION_ID_RE)) this.shellMap.delete(m[1]!)
  }

  private ingest(e: Record<string, unknown>, out: TranscriptTurn[]): void {
    if (this.cwd === null && typeof e.cwd === 'string') this.cwd = e.cwd
    if (this.resumedFrom === null && typeof e.session_id === 'string' && typeof e.sessionId === 'string' && e.session_id !== e.sessionId) {
      this.resumedFrom = e.session_id
    }
    if (this.console === null && typeof e.entrypoint === 'string') this.console = e.entrypoint === 'cli'
    if (!this.startedByClear) {
      const a = e.attachment as { hookName?: unknown } | undefined
      if (a && a.hookName === 'SessionStart:clear') this.startedByClear = true
    }
    // Content activity: the most recent timestamp of a REAL entry —
    // "when something real happened", not when the file was touched.
    // Robust to entries with no timestamp or an invalid date. Only records
    // somebody produced count (isActivity, an allow-list).
    if (typeof e.timestamp === 'string' && isActivity(e)) {
      const t = Date.parse(e.timestamp)
      if (Number.isFinite(t) && (this.lastTs === null || t > this.lastTs)) this.lastTs = t
    }
    if (e.type === 'ai-title' && typeof e.aiTitle === 'string' && e.aiTitle.trim() !== '') {
      this.title = e.aiTitle.trim().slice(0, 120)
      this.titleSource = 'ai'
      return
    }
    // External terminal queue — queue-operation entries have no `message`
    // (they'd be discarded by the role gate below), so they're handled
    // separately. remove drops only the first match (queue semantics: the
    // owner canceled THAT specific queued message, not every copy of it).
    // CLI turn receipt: the harness writes system/turn_duration with
    // durationMs when closing each turn (verified in the corpus: only for
    // entrypoint "cli"; SDK sessions don't carry it, so it never
    // duplicates the live receipt the web store keeps). Emitted as a
    // marker turn (text '', same pattern as compact) — the UI paints it
    // "✻ Worked for X" inline. system entries of other subtypes emit
    // nothing (the long-standing behavior: with no `message`, they fell
    // through to the role gate below).
    if (e.type === 'system') {
      if (e.subtype === 'turn_duration' && typeof e.durationMs === 'number' && e.durationMs >= 0) {
        out.push({
          index: this.turnCount++,
          role: 'assistant',
          text: '',
          tools: [],
          ts: typeof e.timestamp === 'string' ? e.timestamp : null,
          durationMs: e.durationMs,
        })
        this.turnOpen = false // the CLI's receipt: the turn is closed
        this.toolSince = null
      }
      return
    }
    if (e.type === 'queue-operation') {
      if (typeof e.content === 'string') this.shellsEnded(e.content)
      const operation = e.operation
      const content = typeof e.content === 'string' ? e.content : undefined
      // Same noise criterion as turns: harness notifications
      // (<task-notification>, <system…>) aren't user messages
      if (operation === 'enqueue' && content !== undefined && !isNoise(content)) {
        this.queueArr.push(content)
        if (this.queueArr.length > QUEUE_CAP) this.queueArr.shift()
      } else if (operation === 'remove' && content !== undefined) {
        const idx = this.queueArr.indexOf(content)
        if (idx !== -1) this.queueArr.splice(idx, 1)
      } else if (operation === 'dequeue') {
        this.queueArr.shift()
      } else if (operation === 'popAll') {
        this.queueArr = []
      }
      return
    }
    const msg = conversationalMessage(e)
    if (!msg) return
    const role = msg.role
    // Link a tool_result to its pending tool_use BEFORE any noise/empty
    // discard: these 'user'-role entries never emit a turn on their own.
    if (role === 'user') {
      if (this.shellMap.size > 0) this.shellsEnded(typeof msg?.content === 'string' ? msg.content : textOf(msg?.content))
      for (const r of toolResultsOf(msg?.content)) {
        this.toolSince = null // the tool came back — nothing in flight (a parallel batch re-arms on its next tool_use)
        const pending = this.pendingTools.get(r.toolUseId)
        // a Bash sent to the background: awaited until its notification
        const bg = (e.toolUseResult as { backgroundTaskId?: unknown } | undefined)?.backgroundTaskId
        if (pending?.name === 'Bash' && typeof bg === 'string' && bg !== '' && typeof e.timestamp === 'string') {
          const ms = Date.parse(e.timestamp)
          if (Number.isFinite(ms)) {
            this.shellMap.set(bg, ms)
            while (this.shellMap.size > MAX_SHELLS) this.shellMap.delete(this.shellMap.keys().next().value!)
          }
        }
        if (pending) {
          pending.result = r.text.slice(0, 2000)
          if (r.isError) pending.isError = true // a failed tool call — the UI tints it
          if (pending.plan) pending.plan.state = planApproved(r.text, e.toolUseResult) ? 'approved' : 'not_approved'
          // Metadata for the tool_result's images — the ref
          // (`t.<toolUseId>.<n>`) is what the /media/:ref route
          // re-extracts from the JSONL on demand; the base64 is never
          // copied here. Dimension fallback: toolUseResult.file.dimensions
          // (a real harness field on image Reads) covers JPEGs, whose
          // header can't be read with a fixed prefix like the PNG's IHDR.
          if (r.images.length > 0) {
            const dims = toolUseResultDims(e)
            // The ref carries im.blockIdx (position among ALL image
            // blocks in the content), not the position in the already
            // filtered array — see the ImageMeta.blockIdx comment.
            pending.images = r.images.map((im) => {
              const img: TurnImage = { ref: `t.${r.toolUseId}.${im.blockIdx}`, mediaType: im.mediaType, bytes: im.bytes }
              const w = im.w ?? (r.images.length === 1 ? dims?.w : undefined)
              const h = im.h ?? (r.images.length === 1 ? dims?.h : undefined)
              if (w !== undefined && h !== undefined) {
                img.w = w
                img.h = h
              }
              return img
            })
          }
        }
        // Rescues each wrapped message ("interjection") inside THIS
        // tool_result as its own user turn — there can be more than one
        // if the owner sent several messages in a row while the same turn
        // was running. See interjectionsOf's big comment (a fragile
        // heuristic, zero regression if it doesn't match).
        for (const rescued of interjectionsOf(r.text)) {
          out.push({
            index: this.turnCount++,
            role: 'user',
            text: rescued,
            tools: [],
            ts: typeof e.timestamp === 'string' ? e.timestamp : null,
            interjection: true,
          })
          // An interjection IS the owner talking (a message sent while a
          // turn was in progress) — it counts as the last conversational role.
          this.lastRole = 'user'
          this.turnOpen = true
        }
      }
    }
    // Cross-session messages — BEFORE the isMeta gate (peer entries arrive
    // with isMeta:true) and before the title/noise logic (a message from
    // another session never sets this session's title). Emitted as a user
    // turn with `interSession` — the UI paints it as a third voice, never
    // as the owner's own bubble (the owner didn't write it).
    if (role === 'user') {
      const inter = interSessionOf(msg?.content, e.origin, e)
      if (inter) {
        out.push({
          index: this.turnCount++,
          role: 'user',
          text: inter.text.slice(0, 8000),
          tools: [],
          ts: typeof e.timestamp === 'string' ? e.timestamp : null,
          interSession: { from: inter.from },
        })
        return
      }
    }
    if (e.isMeta === true) return
    // Compact summary — a user entry with isCompactSummary:true whose
    // content is the long summary the harness generates on compaction
    // ("This session is being continued from a previous conversation…").
    // An empty marker turn is emitted (never the summary's text), and this
    // returns BEFORE the title/noise logic below: a compact summary as the
    // session's first 'user' must not set the title.
    if (e.isCompactSummary === true && role === 'user') {
      out.push({
        index: this.turnCount++,
        role: 'user',
        text: '',
        tools: [],
        ts: typeof e.timestamp === 'string' ? e.timestamp : null,
        compact: true,
      })
      return
    }
    const text = textOf(msg?.content)
    // Images pasted by the user — DIRECT image blocks in the content (0 in
    // today's corpus, but the same shape as the tool ones: covered in case
    // the composer/CLI produces them tomorrow). The ref needs the entry's
    // uuid (`u.<uuid>.<n>`): without a uuid there's no stable way to
    // re-extract the base64 → they're skipped (lost metadata, never a crash).
    const entryUuid = typeof e.uuid === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(e.uuid) ? e.uuid : null
    const directImages: TurnImage[] =
      role === 'user' && entryUuid !== null
        ? imagesOf(msg?.content).map((im) => {
            const img: TurnImage = { ref: `u.${entryUuid}.${im.blockIdx}`, mediaType: im.mediaType, bytes: im.bytes }
            if (im.w !== undefined && im.h !== undefined) {
              img.w = im.w
              img.h = im.h
            }
            return img
          })
        : []
    const tools = role === 'assistant' ? toolsOf(msg?.content) : []
    for (const t of tools) if (t.skill) this.skillSet.add(t.skill)
    const thinking = role === 'assistant' ? thinkingOf(msg?.content).slice(0, 4000) : ''
    const toolUseDetails = role === 'assistant' ? toolUseDetailsOf(msg?.content) : []
    // message.usage.output_tokens — a real JSONL field on assistant
    // entries, captured by the external status monitor (ExternalStatus).
    const rawUsage = (
      msg as
        | {
            usage?: {
              output_tokens?: unknown
              input_tokens?: unknown
              cache_creation_input_tokens?: unknown
              cache_read_input_tokens?: unknown
            }
          }
        | undefined
    )?.usage
    const outputTokens = role === 'assistant' && typeof rawUsage?.output_tokens === 'number' ? rawUsage.output_tokens : undefined
    // Context/model — captured only on assistant entries. Context is the
    // SUM of the three usage line items present (not all have to be
    // there: a partial usage only sums what's there); each new assistant
    // OVERWRITES the previous accumulated value, it doesn't add up across
    // turns — it's a snapshot of the context window at THAT point in the
    // conversation. message.model === "<synthetic>" marks the notices the
    // harness injects as assistant entries (rate limits, API errors,
    // "Prompt is too long", "No response requested."). These aren't a
    // model reply: they neither set meta.model (previously "<synthetic>"
    // would overwrite the session's real model) nor touch the accumulated
    // context (their usage comes in all-zero — it used to add up and
    // RESET the gauge to 0%).
    const msgModel = (msg as { model?: unknown } | undefined)?.model
    const isSynthetic = role === 'assistant' && msgModel === '<synthetic>'
    if (role === 'assistant' && !isSynthetic) {
      if (typeof msgModel === 'string' && msgModel.trim() !== '') this.model = msgModel
      const parts = [rawUsage?.input_tokens, rawUsage?.cache_creation_input_tokens, rawUsage?.cache_read_input_tokens].filter(
        (n): n is number => typeof n === 'number',
      )
      if (parts.length > 0) this.contextTokens = parts.reduce((a, b) => a + b, 0)
    }
    if (toolUseDetails.some((d) => !PARKING_TOOLS.has(d.detail.name)) && typeof e.timestamp === 'string') {
      const ms = Date.parse(e.timestamp)
      if (Number.isFinite(ms)) this.toolSince = ms
    }
    for (const d of toolUseDetails) {
      if (!d.id) continue
      this.pendingTools.set(d.id, d.detail)
      while (this.pendingTools.size > 200) {
        const oldest = this.pendingTools.keys().next().value
        if (oldest === undefined) break
        this.pendingTools.delete(oldest)
      }
    }
    if (role === 'user' && this.titleSource === null && !isNoise(text)) {
      // A first message that's ONLY the skills prelude strips to '' — the
      // title/titleSource must not be set in that case, or a later real
      // user turn could never correct it (and '' doesn't trigger
      // reader.ts metaOf's '(untitled)' fallback, which only looks at null).
      const withoutPrelude = stripAgentContextForTitle(text).trim()
      if (withoutPrelude !== '') {
        this.title = withoutPrelude.slice(0, 90)
        this.titleSource = 'user'
      }
    }
    // A user turn that's ONLY an image (no text) isn't noise — it used to
    // be discarded by the two gates below and the image would disappear
    // from the transcript.
    if (role === 'user' && isNoise(text) && directImages.length === 0) return
    // "No response requested." is pure harness bookkeeping (marks a
    // queued message with no response requested) — it informs of NOTHING,
    // so it's discarded entirely (not as a notice, not as a turn). The
    // rest of the synthetic notices (limits, errors) are real notices and
    // keep being emitted.
    if (isSynthetic && text.trim() === 'No response requested.') return
    if (text.trim() === '' && tools.length === 0 && directImages.length === 0) return
    const turn: TranscriptTurn = {
      index: this.turnCount++,
      role,
      text: text.slice(0, 8000),
      tools: tools.map((t) => (t.skill ? `skill:${t.skill}` : t.name)),
      ts: typeof e.timestamp === 'string' ? e.timestamp : null,
    }
    if (thinking !== '') turn.thinking = thinking
    if (directImages.length > 0) turn.images = directImages
    if (toolUseDetails.length > 0) turn.toolUses = toolUseDetails.map((d) => d.detail)
    if (outputTokens !== undefined) turn.outputTokens = outputTokens
    if (isSynthetic) turn.synthetic = true
    // Working ≠ live: the API message's stop_reason — "end_turn" only on
    // the turn's FINAL message (verified in the corpus: intermediate ones,
    // including text between tool calls, carry "tool_use"). An honest
    // close signal for SDK sessions with no turn_duration marker. A
    // synthetic notice never claims it.
    if (role === 'assistant' && !isSynthetic && (msg as { stop_reason?: unknown } | undefined)?.stop_reason === 'end_turn') {
      turn.turnEnded = true
      this.turnOpen = false
      this.toolSince = null
    } else if (role === 'assistant' && !isSynthetic && (msg as { stop_reason?: unknown } | undefined)?.stop_reason === 'tool_use') {
      // The agent asked for a tool: the harness will run it and call the
      // model again — the turn is open by definition, whoever woke it. Not
      // every turn starts with an owner's user record: a background
      // subagent's <task-notification> (noise, returns above), a queued
      // command delivered as an `attachment`, a peer message. Without this
      // a woken conversation worked a whole turn with no blink.
      this.turnOpen = true
    }
    out.push(turn)
    // Only turns with REAL conversational content set the last role. A
    // synthetic harness notice (rate limit, error) is NOT a reply from the
    // agent — it's emitted as a system band but doesn't set lastRole to
    // 'assistant' (if the owner wrote something and the harness replied
    // with a limit, it's still "the agent's turn", not "unread").
    if (!isSynthetic) {
      this.lastRole = role
      if (role === 'user') {
        this.turnOpen = true
        this.toolSince = null
      }
    }
  }
}
