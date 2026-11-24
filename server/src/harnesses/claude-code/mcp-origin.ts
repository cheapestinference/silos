// harnesses/claude-code/mcp-origin.ts — where an MCP server a Claude Code
// conversation called comes from, read from the name Claude Code gives it
// (verified on real transcripts 02-11): `claude_ai_<X>` is a connector of the
// claude.ai account the conversation ran on; `plugin_<plugin>_<server>` a
// server a plugin ships; any other name one configured on this machine or in
// the project (.mcp.json, ~/.claude.json).
export function claudeMcpOrigin(server: string): string {
  if (server.startsWith('claude_ai_')) return 'the Claude account'
  if (server.startsWith('plugin_')) return 'a plugin'
  return 'configured (project or machine)'
}
