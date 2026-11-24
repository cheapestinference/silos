// role-plugin.ts — a role's own skills: one plugin per agent under its state
// dir (`agent-state/<id>/plugin`), skills only in phase 1.
// The state dir is the one corner of
// the data dir the fence leaves open to its own agent and already travels as
// an additionalDirectory, so other agents' role skills are denied with no new
// rule. Its own plugin is NOT its to write (territory.ts OWN_PLUGIN_DIR):
// Silos writes it, the agent proposes. Every launch path consumes the same
// resolver: console `--plugin-dir`, SDK `plugins: [{ type: 'local' }]`,
// OpenCode `skills.paths` (the adapters read it off the LaunchSpec).
// It also carries the agent's OWN MCP servers (agent-tools.ts): its root `.mcp.json`, which Claude Code
// reads from every plugin it loads (SDK `skipMcpDiscovery` unset).

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SkillLoad } from './complete-service.js'
import { sealHooks } from './seal-hooks.js'

export function rolePluginDir(agentStateDir: string): string {
  return join(agentStateDir, 'plugin')
}

export function roleSkillsDir(agentStateDir: string): string {
  return join(rolePluginDir(agentStateDir), 'skills')
}

/** The plugin's engine-read MCP file (active own servers) and Silos' held twin. */
export const OWN_MCP_FILE = '.mcp.json'
export const OWN_HELD_MCP_FILE = '.silos-held.mcp.json'

/** The ACTIVE own server names: keys of `plugin/.mcp.json` `mcpServers`. */
export function ownMcpServerNames(agentStateDir: string): string[] {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(rolePluginDir(agentStateDir), OWN_MCP_FILE), 'utf8'))
    const list = typeof parsed === 'object' && parsed !== null ? (parsed as { mcpServers?: unknown }).mcpServers : undefined
    return typeof list === 'object' && list !== null && !Array.isArray(list) ? Object.keys(list).sort() : []
  } catch {
    return [] // no file, or not JSON: no own server loads
  }
}

/** The role's skill names: entries of `plugin/skills/` holding a SKILL.md. */
export function roleSkillNames(agentStateDir: string): string[] {
  const dir = roleSkillsDir(agentStateDir)
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && existsSync(join(dir, e.name, 'SKILL.md')))
      .map((e) => e.name)
      .sort()
  } catch {
    return [] // no plugin yet: the role has no skills of its own
  }
}

/** The plugin dir a launch passes, or null: no skill and no active own
 *  server yet (putting one there IS the switch — same grammar as a folder's
 *  `.claude/skills` and `.mcp.json`), no state dir, or an id no plugin name
 *  can carry. */
export function rolePluginFor(agentId: string, agentStateDir: string | null): string | null {
  if (agentStateDir === null || !/^[\w-]+$/.test(agentId)) return null
  return roleSkillNames(agentStateDir).length > 0 || ownMcpServerNames(agentStateDir).length > 0 ? rolePluginDir(agentStateDir) : null
}

/** The engine's SkillLoad with the role's skills appended as one more
 *  launch-handed root (plugin = the agent id, so the catalog names them
 *  `<id>:<skill>` — the same name the console shows). The catalog's truth
 *  and the launches read the SAME disk, never intent. */
export function withRoleSkills(load: SkillLoad, agentId: string, agentStateDir: string | null): SkillLoad {
  if (agentStateDir === null || rolePluginFor(agentId, agentStateDir) === null || roleSkillNames(agentStateDir).length === 0) return load
  return { ...load, roots: [...(load.roots ?? []), { plugin: agentId, dir: roleSkillsDir(agentStateDir) }] }
}

/** `.claude-plugin/plugin.json`, written when missing so the engine accepts
 *  the dir — named as the agent (skills read `<id>:<skill>`). Never
 *  overwritten: this is Silos' own state dir, but whoever edited the
 *  manifest meant it. */
export function ensureRolePluginManifest(pluginDir: string, agentId: string, agentName?: string): void {
  const manifest = join(pluginDir, '.claude-plugin', 'plugin.json')
  if (existsSync(manifest)) return
  mkdirSync(join(pluginDir, '.claude-plugin'), { recursive: true })
  writeFileSync(manifest, JSON.stringify({ name: agentId, description: `Role skills of ${agentName ?? agentId}`, version: '0.1.0' }, null, 2) + '\n')
  // Silos' own write: the plugin's tree seal follows (seals.ts)
  sealHooks().pluginWritten?.(pluginDir)
}
