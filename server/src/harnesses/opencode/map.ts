// harnesses/opencode/map — pure mapping from OpenCode rows (db.ts) to the
// records the Silos UI already consumes for Claude Code: SessionMeta for the
// index, TranscriptTurn[] for the conversation, SessionContext for the
// context column. No I/O here; same caps as claude-code/parser.ts and claude-code/context.ts so an
// OpenCode turn is indistinguishable in size from a Claude one.

import type { PlanTask, SessionContext, SessionMeta, ToolUseDetail, TranscriptTurn } from '../../types.js'
import { mungePath } from '../../agent-registry.js'
import type { MessageData, MessageRow, PartData, PartRow, SessionRow, TodoRow } from './db.js'

const TEXT_CAP = 8000 // claude-code/parser.ts: turn text
const THINKING_CAP = 4000
const TOOL_IO_CAP = 2000
const FILES_CAP = 200 // claude-code/context.ts
const EVENTS_CAP = 50

type Assistant = Extract<MessageData, { role: 'assistant' }>
type ToolPart = Extract<PartData, { type: 'tool' }>

const modelOf = (a: Assistant): string => `${a.providerID}/${a.modelID}`

// An assistant message the provider refused: OpenCode stores the failure on
// the message itself (`error`, no `finish`). It is the end of that turn —
// nothing else will arrive — and the UI must say WHY, not blink "Working".
// "zai: Insufficient balance or no resource package. Please recharge. (429)"
const errorOf = (a: Assistant): string | null => {
  if (!a.error) return null
  const msg = a.error.data?.message ?? a.error.name ?? 'error'
  const code = a.error.data?.statusCode
  return `${a.providerID}: ${msg}${code !== undefined ? ` (${code})` : ''}`.slice(0, ERROR_CAP)
}
const ERROR_CAP = 600
const iso = (ms: number): string => new Date(ms).toISOString()
const createdOf = (m: MessageRow): number => m.data.time?.created ?? m.time_created
const isAssistant = (m: MessageRow): m is MessageRow & { data: Assistant } => m.data.role === 'assistant'

// A malformed or older row may lack `tokens` (or its `cache`): read as zeros,
// never throw — one bad row must not hide the conversation.
interface TokenCounts {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}
function tokensOf(a: Assistant): TokenCounts {
  const t = (a.tokens ?? {}) as Partial<Assistant['tokens']>
  const n = (v: unknown): number => (typeof v === 'number' ? v : 0)
  return { input: n(t.input), output: n(t.output), cacheRead: n(t.cache?.read), cacheWrite: n(t.cache?.write) }
}

function partsByMessage(parts: PartRow[]): Map<string, PartData[]> {
  const out = new Map<string, PartData[]>()
  for (const p of parts) {
    const list = out.get(p.message_id)
    if (list) list.push(p.data)
    else out.set(p.message_id, [p.data])
  }
  return out
}

export function metaOf(s: SessionRow, msgs: MessageRow[], parts: PartRow[], _opts: { harnessAgent?: string }): SessionMeta {
  const meta: SessionMeta = {
    id: s.id,
    folder: mungePath(s.directory),
    title: s.title || '(untitled)',
    skills: [],
    cwd: s.directory,
    mtime: s.time_updated,
    // No file to stat: the size of the stored rows' JSON stands in for the
    // transcript's bytes (Settings › Maintenance's "empty" filter reads it).
    size: [...msgs, ...parts].reduce((n, r) => n + JSON.stringify(r.data).length, 0),
    turnCount: msgs.filter((m) => m.data.role === 'user').length,
    startedAt: s.time_created,
    harness: 'opencode',
  }
  if (s.parent_id) meta.resumedFrom = s.parent_id
  const lastAssistant = msgs.filter(isAssistant).at(-1)
  if (lastAssistant) {
    meta.model = modelOf(lastAssistant.data)
    const t = tokensOf(lastAssistant.data)
    meta.contextTokens = t.input + t.cacheRead
  }
  const last = msgs.at(-1)
  if (last) {
    meta.lastRole = last.data.role
    meta.turnOpen = last.data.role === 'user' || (last.data.finish !== 'stop' && !last.data.error)
    // a tool in flight in the open turn — OpenCode writes nothing while a long
    // command (or a `task` subagent, which runs INSIDE its parent's tool call)
    // works; the same bound as Claude Code's toolSince (work-live.ts)
    if (meta.turnOpen && isAssistant(last)) {
      let since = 0
      for (const p of parts) {
        if (p.message_id !== last.id || p.data.type !== 'tool') continue
        const { status, time } = p.data.state
        if ((status === 'running' || status === 'pending') && time && time.start > since) since = time.start
      }
      if (since > 0) meta.toolSince = since
    }
  }
  // the model the TUI will run next: the last user message's (its /models
  // pick travels on every prompt) — the pin follower reads it
  const lastUser = msgs.filter((m) => m.data.role === 'user').at(-1)
  if (lastUser && lastUser.data.role === 'user' && lastUser.data.model) {
    meta.requestedModel = `${lastUser.data.model.providerID}/${lastUser.data.model.modelID}`
    meta.requestedModelAt = createdOf(lastUser)
  }
  return meta
}

function toolUseOf(p: ToolPart): ToolUseDetail {
  const { status } = p.state
  const done = status === 'completed' || status === 'error'
  const result = done ? (p.state.output ?? p.state.error ?? '') : null
  return {
    name: p.tool,
    skill: null,
    input: JSON.stringify(p.state.input ?? {}).slice(0, TOOL_IO_CAP),
    result: result === null ? null : result.slice(0, TOOL_IO_CAP),
    isError: status === 'error',
  }
}

export function turnsOf(msgs: MessageRow[], parts: PartRow[]): TranscriptTurn[] {
  const byMsg = partsByMessage(parts)
  const turns: TranscriptTurn[] = []
  for (const m of msgs) {
    const ps = byMsg.get(m.id) ?? []
    const ts = iso(createdOf(m))
    // A compaction part marks where OpenCode summarized the history.
    for (const p of ps) {
      if (p.type === 'compaction') turns.push({ index: turns.length, role: m.data.role, text: '', tools: [], ts, compact: true })
    }
    const text = ps
      .flatMap((p) => (p.type === 'text' ? [p.text] : []))
      .join('\n')
      .slice(0, TEXT_CAP)
    const thinking = ps
      .flatMap((p) => (p.type === 'reasoning' ? [p.text] : []))
      .join('\n\n')
      .slice(0, THINKING_CAP)
    const toolUses = ps.flatMap((p) => (p.type === 'tool' ? [toolUseOf(p)] : []))
    const turn: TranscriptTurn = { index: turns.length, role: m.data.role, text, tools: toolUses.map((t) => t.name), ts }
    if (thinking) turn.thinking = thinking
    if (toolUses.length) turn.toolUses = toolUses
    if (m.data.role === 'assistant') {
      turn.outputTokens = tokensOf(m.data).output
      turn.turnEnded = m.data.finish === 'stop'
      const err = errorOf(m.data)
      if (err !== null) {
        // the same system band Claude's "<synthetic>" warnings get
        if (turn.text === '') turn.text = err
        turn.synthetic = true
        turn.turnEnded = true
      }
    }
    turns.push(turn)
  }
  return turns
}

type FileRow = SessionContext['files'][number]

// The Checklist from OpenCode's `todo` rows (already in position order).
// Its states map one to one; `cancelled` is omitted — neither a step to do
// nor one done. No rows (or only cancelled ones) → null, like Claude's.
const TODO_STATUS: Record<string, PlanTask['status']> = { pending: 'pending', in_progress: 'in_progress', completed: 'completed' }
export function planOfTodos(todos: TodoRow[]): SessionContext['plan'] {
  const tasks: PlanTask[] = []
  for (const t of todos) {
    const status = TODO_STATUS[t.status]
    if (!status) continue
    tasks.push({ id: String(t.position), subject: t.content, status, createdAt: '', agents: [] })
  }
  if (tasks.length === 0) return null
  return { tasks, done: tasks.filter((t) => t.status === 'completed').length, total: tasks.length }
}

export function contextOf(
  s: SessionRow,
  msgs: MessageRow[],
  parts: PartRow[],
  pending: SessionContext['pending'] | null,
  todos: TodoRow[] = [],
): SessionContext {
  const byMsg = partsByMessage(parts)
  const files = new Map<string, FileRow>()
  const touch = (path: string, field: 'reads' | 'edits' | 'writes') => {
    let row = files.get(path)
    if (!row) {
      if (files.size >= FILES_CAP) return
      row = { path, edits: 0, writes: 0, reads: 0, sent: 0, disk: 0 }
      files.set(path, row)
    }
    row[field]++
  }
  const tools = new Map<string, SessionContext['tools'][number]>()
  const events: SessionContext['events'] = []
  const pushEvent = (e: SessionContext['events'][number]) => {
    events.push(e)
    if (events.length > EVENTS_CAP) events.shift()
  }
  const byModel = new Map<string, NonNullable<SessionContext['cost']>['byModel'][number]>()
  // planPriced reads FINISHED messages only: a streaming one reports $0 until it completes.
  let finished = 0
  let allZero = true
  let prevModel: string | null = null

  for (const m of msgs) {
    const ts = iso(createdOf(m))
    if (isAssistant(m)) {
      const a = m.data
      const model = modelOf(a)
      if (prevModel !== null && model !== prevModel) pushEvent({ ts, kind: 'model', text: model })
      prevModel = model
      if (a.time?.completed) {
        finished++
        if (typeof a.cost === 'number' && a.cost !== 0) allZero = false
      }
      const t = tokensOf(a)
      const row = byModel.get(model) ?? { model, usd: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 }
      row.usd += typeof a.cost === 'number' ? a.cost : 0
      row.inputTokens += t.input
      row.outputTokens += t.output
      row.cacheReadTokens += t.cacheRead
      row.cacheCreationTokens += t.cacheWrite
      byModel.set(model, row)
    }
    // edit/write tools already name the file; a patch part listing the same
    // path in the same message is that write, not a second one.
    const toolWritten = new Set<string>()
    const ps = byMsg.get(m.id) ?? []
    for (const p of ps) {
      if (p.type === 'compaction') pushEvent({ ts, kind: 'compact', text: '' })
      if (p.type !== 'tool') continue
      const t = tools.get(p.tool) ?? { name: p.tool, server: null, count: 0 }
      t.count++
      tools.set(p.tool, t)
      const input = p.state.input as { filePath?: unknown; path?: unknown } | undefined
      const path = typeof input?.filePath === 'string' ? input.filePath : typeof input?.path === 'string' ? input.path : null
      if (!path) continue
      if (p.tool === 'read') touch(path, 'reads')
      else if (p.tool === 'edit') {
        touch(path, 'edits')
        toolWritten.add(path)
      } else if (p.tool === 'write') {
        touch(path, 'writes')
        toolWritten.add(path)
      }
    }
    for (const p of ps) {
      if (p.type !== 'patch' || !Array.isArray(p.files)) continue
      for (const f of p.files) if (typeof f === 'string' && !toolWritten.has(f)) touch(f, 'writes')
    }
  }

  let cost: SessionContext['cost'] = null
  if (byModel.size > 0) {
    const list = [...byModel.values()]
    cost = { totalUsd: list.reduce((n, r) => n + r.usd, 0), unknownModels: false, byModel: list }
    if (finished > 0 && allZero) cost.planPriced = true
  }

  return {
    plan: planOfTodos(todos),
    agents: [],
    pending,
    links: { prs: [], artifacts: [], worktree: null },
    events,
    files: [...files.values()],
    tools: [...tools.values()],
    // the model OpenCode last answered with — the column's runs-on line reads
    // this flag, not SessionMeta.model (an errored message still names it)
    flags: { remote: false, permissionMode: null, gitBranch: null, effort: null, model: prevModel },
    waiting: null,
    cost,
    documents: [],
    fileHistory: [],
  }
}
