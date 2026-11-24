// harnesses/claude-code/loads/names.ts — the ONE place a Claude Code MCP
// server's name meets the id its tool names carry.
//
// The engine names a server exactly — `plugin:<plugin>:<server>` for a
// plugin's, `claude.ai <Name>` for an account connector, the config key for
// one of ~/.claude.json or .mcp.json — and its tools are called
// `mcp__<id>__<tool>`, where <id> is that name with everything outside
// [A-Za-z0-9_-] turned into `_` (`plugin:design:google calendar` →
// `plugin_design_google_calendar`, `claude.ai Google Drive` →
// `claude_ai_Google_Drive`). That rewrite loses information (a space, a dot,
// a colon and an underscore all become `_`), so it runs in ONE direction
// only: the id of every KNOWN name is computed and compared. An id is never
// split or turned back into a name; two known names with one id stay
// unresolved, and say which they are. Names are data: every table is a Map.

/** The tool-name id the engine derives from a server's name. */
export function toolIdOf(name: string): string {
  return name.replace(/[^A-Za-z0-9_-]/g, '_')
}

/** The engine's name for a server a plugin ships. */
export function pluginServerName(plugin: string, server: string): string {
  return `plugin:${plugin}:${server}`
}

/** The form of the engine's name for a claude.ai account connector. */
export const CONNECTOR_PREFIX = 'claude.ai '

/** The engine's name for a claude.ai account connector. */
export function connectorName(name: string): string {
  return `${CONNECTOR_PREFIX}${name}`
}

export type IdResolution =
  | { kind: 'name'; name: string }
  /** two or more known names share this id: none is chosen */
  | { kind: 'ambiguous'; names: string[] }
  /** no known name has this id: only the id is known */
  | { kind: 'unknown' }

export interface NameResolver {
  resolve(id: string): IdResolution
}

/** A resolver over the names known now (from disk, a status reading, a
 *  notice's name lists). */
export function nameResolver(known: Iterable<string>): NameResolver {
  const byId = new Map<string, string[]>()
  for (const name of known) {
    const id = toolIdOf(name)
    const list = byId.get(id)
    if (!list) byId.set(id, [name])
    else if (!list.includes(name)) list.push(name)
  }
  return {
    resolve(id: string): IdResolution {
      const names = byId.get(id)
      if (!names) return { kind: 'unknown' }
      if (names.length === 1) return { kind: 'name', name: names[0]! }
      return { kind: 'ambiguous', names: [...names].sort() }
    },
  }
}
