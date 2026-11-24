// helpers/mcp-rows.ts — the inventory's rows (harnesses/claude-code/loads/
// inventory.ts) in the narrow shape the switch tests assert on: a folder's
// .mcp.json servers, its installed plugins and the operator's ~/.claude.json
// servers, with which file holds each (the words today's switches answer
// in). The inventory is the one reader; this only reshapes it.
import { join } from 'node:path'
import { claudeLoadsInventory } from '../../src/harnesses/claude-code/loads/inventory.js'

export interface McpRow {
  name: string
  kind: 'mcp' | 'plugin'
  scope: 'project' | 'user'
  state: 'active' | 'held'
  heldBy?: 'local' | 'project-settings' | 'user' | 'managed' | 'plugin-default'
  forcedBy?: 'managed'
  detail?: string
}

/** `home` holds .claude.json and .claude/; no managedDir = no managed layer. */
export function mcpRowsOf(folder: string, home: string, managedDir: string = join(home, 'no-managed-settings')): McpRow[] {
  const inv = claudeLoadsInventory({ folder, home, managedDir, recentTranscripts: [], seenToolIds: [], readings: [] })
  return inv.rows
    .filter((r) => !r.parent && r.origin.owner !== 'account' && !r.observed)
    .map((r) => {
      const d = r.decidedBy
      const heldBy =
        r.state !== 'held'
          ? undefined
          : !d
            ? ('local' as const)
            : d.key === 'defaultEnabled'
              ? ('plugin-default' as const)
              : d.file === 'managed settings'
                ? ('managed' as const)
                : d.file === '.claude/settings.json'
                  ? ('project-settings' as const)
                  : ('user' as const)
      return {
        name: r.name,
        kind: r.kind === 'plugin' ? ('plugin' as const) : ('mcp' as const),
        scope: r.kind === 'plugin' || r.origin.owner === 'project' ? ('project' as const) : ('user' as const),
        state: r.state === 'active' ? ('active' as const) : ('held' as const),
        ...(heldBy ? { heldBy } : {}),
        ...(r.state === 'active' && d?.file === 'managed settings' ? { forcedBy: 'managed' as const } : {}),
        ...(r.detail && r.kind !== 'plugin' ? { detail: r.detail } : {}),
      }
    })
}
