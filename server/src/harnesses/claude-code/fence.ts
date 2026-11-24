// harnesses/claude-code/fence.ts — the territory fence the way Claude Code
// enforces it: its own deny rules (territory.ts fenceFor writes them in
// Claude's grammar), grouped by the same tool kinds Settings › Territory
// names (Read → read, Edit/Write → edit, Bash → bash). Claude Code's
// Harness.fencePermission (registry.ts fencePermissionFor asks each engine).

import type { FenceOverlay } from '../../territory.js'
import { RULE_RE, TOOL_MAP, type PermissionConfig } from '../fence-rules.js'

export function claudeFencePermission(fence: FenceOverlay): PermissionConfig {
  const out: Record<string, Record<string, 'deny'>> = {}
  for (const rule of fence.permissions.deny) {
    const m = RULE_RE.exec(rule)
    const kind = m && Object.hasOwn(TOOL_MAP, m[1]!) ? TOOL_MAP[m[1]!] : undefined
    if (kind && m) (out[kind] ??= {})[m[2]!] = 'deny'
  }
  return out
}
