// harnesses/claude-code/tool-calls — a Claude Code transcript's tool calls in
// the engine-neutral shape the unattended-turn audit reads
// (contract.ts ToolCallRecord; heartbeat-audit.ts).
// Pure over the JSONL lines; the reader feeds it the session's transcript
// and every subagent transcript under <session>/subagents/agent-*.jsonl.
// Claude Code's own tool names live here and nowhere in the audit:
//   · WebFetch / WebSearch (and any API server tool) read the web;
//   · mcp__<server>__<tool> is an MCP server's tool;
//   · Bash carries `command`; Write/Edit/MultiEdit carry `file_path`,
//     NotebookEdit `notebook_path`.

import type { ToolCallRecord } from '../contract.js'

const WEB_TOOLS = new Set(['WebFetch', 'WebSearch'])
const SHELL_TOOLS = new Set(['Bash'])
const WRITE_TOOLS: Record<string, string> = { Write: 'file_path', Edit: 'file_path', MultiEdit: 'file_path', NotebookEdit: 'notebook_path' }

/** One tool_use block as a record (null: not a tool call). */
export function claudeToolCall(block: unknown, session: string, at?: number): ToolCallRecord | null {
  if (!block || typeof block !== 'object') return null
  const b = block as { type?: unknown; name?: unknown; input?: unknown }
  if ((b.type !== 'tool_use' && b.type !== 'server_tool_use') || typeof b.name !== 'string') return null
  const rec: ToolCallRecord = { name: b.name, session }
  if (at !== undefined) rec.at = at
  const input = (b.input && typeof b.input === 'object' ? b.input : {}) as Record<string, unknown>
  // an API server tool (web search / fetch run by the API itself) reads outside too
  if (b.type === 'server_tool_use' || WEB_TOOLS.has(b.name)) rec.outside = 'web'
  else if (b.name.startsWith('mcp__')) rec.outside = 'mcp'
  else if (SHELL_TOOLS.has(b.name) && typeof input.command === 'string') rec.command = input.command
  else {
    const key = WRITE_TOOLS[b.name]
    const p = key ? input[key] : undefined
    if (typeof p === 'string' && p !== '') rec.writes = [p]
  }
  return rec
}

/** Every tool call of one transcript's lines, in order. Unparseable lines are skipped. */
export function claudeToolCallsOfLines(lines: Iterable<string>, session: string): ToolCallRecord[] {
  const out: ToolCallRecord[] = []
  for (const line of lines) {
    if (!line.includes('tool_use')) continue
    let e: unknown
    try {
      e = JSON.parse(line)
    } catch {
      continue
    }
    if (!e || typeof e !== 'object') continue
    const o = e as { type?: unknown; message?: { content?: unknown }; timestamp?: unknown }
    if (o.type !== 'assistant' || !Array.isArray(o.message?.content)) continue
    const ms = typeof o.timestamp === 'string' ? Date.parse(o.timestamp) : NaN
    for (const block of o.message.content) {
      const rec = claudeToolCall(block, session, Number.isFinite(ms) ? ms : undefined)
      if (rec) out.push(rec)
    }
  }
  return out
}
