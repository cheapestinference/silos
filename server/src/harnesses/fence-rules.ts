// harnesses/fence-rules.ts — the neutral vocabulary of the territory fence
// (territory.ts fenceFor writes Claude Code deny rules `Tool(pattern)`):
// the rule grammar, the tool → permission-kind map and the permission
// object shape a harness's fence dialect returns. No engine lives here, so
// each adapter can map a fence into its own dialect without importing
// another adapter (moved from opencode/fence.ts, unchanged).

export type PermissionAction = 'allow' | 'ask' | 'deny'
/** OpenCode v2 PermissionConfig: per tool, one action or `{ "<glob>": action }`. */
export type PermissionConfig = Partial<Record<string, PermissionAction | Record<string, PermissionAction>>>

/** Claude tool name → OpenCode permission key (Write folds into edit). */
export const TOOL_MAP: Readonly<Record<string, 'read' | 'edit' | 'bash'>> = { Read: 'read', Edit: 'edit', Write: 'edit', Bash: 'bash' }
/** A Claude deny rule `Tool(pattern)`. */
export const RULE_RE = /^([A-Za-z]+)\((.*)\)$/s
