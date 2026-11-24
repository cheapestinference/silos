// harnesses/claude-code/loads/plugin-servers.ts — the MCP server entries a
// Claude Code plugin declares, and the two readings of them that are not
// servers of their own:
//
//  · a PLACEHOLDER — an entry with no address (no `url`, no `command`): the
//    plugin leaves that tool to an account connector of the same name. The
//    engine reports it `failed` «No URL configured for this server»; it is
//    recognised by structure only, never by its name;
//  · the SAME SERVER as another — entries (of one plugin or several) that
//    name one `url` are one server: the engine connects it once, under the
//    first. Stdio entries are separate processes and never shared.
//
// Read-only and tolerant: an entry that is not an object is skipped.
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

export interface PluginServerEntry {
  /** the key in the plugin's mcpServers */
  server: string
  /** the remote address, when the entry has one */
  url: string | null
  /** a stdio entry's command, when it has one */
  command: string | null
  /** no url and no command */
  placeholder: boolean
}

type Json = Record<string, unknown>
const asObject = (v: unknown): Json | null => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Json) : null)
const readJson = (path: string): Json | null => {
  try {
    return asObject(JSON.parse(readFileSync(path, 'utf8')))
  } catch {
    return null
  }
}
const nonEmpty = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null)

/** The entries a plugin declares: the manifest's `mcpServers` (a path, or
 *  the map inline), else its `.mcp.json`. In key order. */
export function pluginServerEntries(pluginDir: string, manifest: Json | null): PluginServerEntry[] {
  const declared = manifest?.mcpServers
  const file =
    typeof declared === 'string'
      ? readJson(resolve(pluginDir, declared))
      : asObject(declared)
        ? { mcpServers: declared }
        : readJson(join(pluginDir, '.mcp.json'))
  const map = asObject(file?.mcpServers)
  if (!map) return []
  const out: PluginServerEntry[] = []
  for (const server of Object.keys(map).sort()) {
    const e = asObject(map[server])
    if (!e) continue
    const url = nonEmpty(e.url)
    const command = nonEmpty(e.command)
    out.push({ server, url, command, placeholder: url === null && command === null })
  }
  return out
}

/** For entries in the engine's order (`name` its engine name): each name
 *  that shares its url with an earlier entry → that earlier entry's name.
 *  Placeholders and stdio entries share nothing. */
export function sameServerAs(entries: { name: string; url: string | null }[]): Map<string, string> {
  const firstByUrl = new Map<string, string>()
  const out = new Map<string, string>()
  for (const e of entries) {
    if (e.url === null) continue
    const first = firstByUrl.get(e.url)
    if (first === undefined) firstByUrl.set(e.url, e.name)
    else if (first !== e.name) out.set(e.name, first)
  }
  return out
}
