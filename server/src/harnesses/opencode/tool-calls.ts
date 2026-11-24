// harnesses/opencode/tool-calls — an OpenCode session's `tool` parts in the
// engine-neutral shape the unattended-turn audit reads (contract.ts
// ToolCallRecord; heartbeat-audit.ts). Pure over the
// parts the reader gets from the DB (db.ts, read-only). OpenCode's own tool
// names live here and nowhere in the audit:
//   · webfetch / websearch read the web, and so does codesearch (it queries
//     a remote code-search service, never the folder);
//   · an MCP server's tool has no fixed prefix: OpenCode names it
//     `<server>_<tool>`, each part sanitised to [a-zA-Z0-9_-] (verified in
//     the 1.19.4 binary: `v0(server)+"_"+v0(tool)`), so EVERY MCP tool name
//     carries an underscore. Its built-in tools are single words except the
//     few listed below — any other name with an underscore is read as an MCP
//     tool (fails towards marking, as the audit's heuristics do);
//   · bash carries `command`; write/edit/multiedit carry `filePath`;
//     patch/apply_patch name their files inside `patchText`.

import type { ToolCallRecord } from '../contract.js'
import type { PartRow } from './db.js'

const WEB_TOOLS = new Set(['webfetch', 'websearch', 'codesearch'])
/** Built-ins whose id has an underscore (1.19.4 binary) — never MCP. */
export const OPENCODE_UNDERSCORE_BUILTINS = new Set(['apply_patch', 'plan_enter', 'plan_exit'])
const PATH_TOOLS = new Set(['write', 'edit', 'multiedit'])
const PATCH_TOOLS = new Set(['patch', 'apply_patch'])

/** The files a patch text adds, updates, deletes or moves to. */
function patchFiles(text: string): string[] {
  const out: string[] = []
  for (const m of text.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$|^\*\*\* Move to: (.+)$/gm)) {
    const p = (m[1] ?? m[2] ?? '').trim()
    if (p !== '') out.push(p)
  }
  return out
}

export function opencodeIsMcpTool(name: string): boolean {
  return name.includes('_') && !OPENCODE_UNDERSCORE_BUILTINS.has(name)
}

/** The tool parts of one session, in the order given. */
export function opencodeToolCalls(parts: readonly PartRow[], session: string): ToolCallRecord[] {
  const out: ToolCallRecord[] = []
  for (const p of parts) {
    if (p.data.type !== 'tool' || typeof p.data.tool !== 'string') continue
    const name = p.data.tool
    const rec: ToolCallRecord = { name, session }
    const at = p.data.state?.time?.start ?? p.time_created
    if (typeof at === 'number' && Number.isFinite(at)) rec.at = at
    const input = (p.data.state?.input && typeof p.data.state.input === 'object' ? p.data.state.input : {}) as Record<string, unknown>
    if (WEB_TOOLS.has(name)) rec.outside = 'web'
    else if (opencodeIsMcpTool(name)) rec.outside = 'mcp'
    else if (name === 'bash' && typeof input.command === 'string') rec.command = input.command
    else if (PATH_TOOLS.has(name) && typeof input.filePath === 'string' && input.filePath !== '') rec.writes = [input.filePath]
    else if (PATCH_TOOLS.has(name) && typeof input.patchText === 'string') {
      const files = patchFiles(input.patchText)
      if (files.length > 0) rec.writes = files
    }
    out.push(rec)
  }
  return out
}
