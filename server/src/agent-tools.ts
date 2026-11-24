// agent-tools.ts — an agent's OWN MCP servers:
// servers no other agent of its folder gets. They live in
// the agent's own plugin, the one every launch path already passes
// (role-plugin.ts rolePluginFor):
//
//   agent-state/<id>/plugin/.mcp.json             ACTIVE — the file Claude
//       Code reads from a plugin (SDK sdk.d.ts SdkPluginConfig: «.mcp.json or
//       manifest mcpServers», read unless skipMcpDiscovery);
//   agent-state/<id>/plugin/.silos-held.mcp.json   HELD — same shape, read by
//       no engine. Hold = move the entry out of .mcp.json (a real block on
//       every engine and permission mode); Turn on = move it back.
//
// The same grammar as a folder's servers (harnesses/claude-code/loads/): active / held,
// nothing else. The files on disk are the truth — every call reads fresh, a
// hand edit wins the moment it lands. Silos' writes go through safe-file.ts
// (never through a link the agent planted in its state) and re-seal the
// plugin tree, as role skills do. The fence needs no new rule: other agents'
// state dirs are denied whole, the agent's own plugin is denied Edit
// (territory.ts OWN_PLUGIN_DIR).
//
// A config never holds a secret VALUE: env values are `${NAME}`, header values
// `${NAME}` after an optional scheme word, and every NAME is a Vault name
// (vault-store.ts validateEntryName — never SILOS_*, CLAUDE*, ANTHROPIC_*).
// The engine expands them from the process env the Vault already fills
// (agent-env.ts); OpenCode gets the same servers as `{env:NAME}`.
import type { AgentStateStore } from './agent-state.js'
import { writeContained } from './safe-file.js'
import { sealHooks } from './seal-hooks.js'
import { ensureRolePluginManifest, OWN_HELD_MCP_FILE, OWN_MCP_FILE } from './role-plugin.js'
import { validateEntryName } from './vault-store.js'

export type OwnToolTransport = 'stdio' | 'http' | 'sse'

/** One server's config, as the engine reads it in a .mcp.json. */
export type OwnToolConfig =
  { type?: 'stdio'; command: string; args?: string[]; env?: Record<string, string> } | { type: 'http' | 'sse'; url: string; headers?: Record<string, string> }

export interface OwnToolRow {
  name: string
  kind: 'mcp'
  scope: 'agent'
  state: 'active' | 'held'
  transport: OwnToolTransport
  /** display only: the command or the url */
  detail: string
  /** every Vault name the config refers to */
  refs: string[]
  /** the refs the agent's Vault does not give it today (filled by the caller) */
  needs: string[]
}

export class AgentToolError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409,
  ) {
    super(message)
  }
}

type Servers = Record<string, unknown>
const MAX_BYTES = 256 * 1024

// names are DATA: own-property lookups over null-prototype maps only
const own = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k)
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

export const OWN_TOOL_NAME_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/
const REF_RE = /\$\{([^}]*)\}/g
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/
const HEADER_NAME_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/
const HEADER_VALUE_RE = /^(?:[A-Za-z]{1,16} )?\$\{[^}]+\}$/
const CONTROL_RE = /[\u0000-\u001f\u007f]/

/** Every `${NAME}` in a string, each NAME a Vault name; any other brace refused. */
function refsIn(where: string, s: string): string[] {
  if (CONTROL_RE.test(s)) throw new AgentToolError(`${where}: no control characters`, 400)
  const names: string[] = []
  for (const m of s.matchAll(REF_RE)) {
    const name = m[1] ?? ''
    const bad = validateEntryName(name)
    if (bad !== null) throw new AgentToolError(`${where}: \${${name}} — ${bad}; refer to a Vault entry`, 400)
    names.push(name)
  }
  // OpenCode substitutes braces over its whole config text: nothing but refs
  if (/[{}]/.test(s.replace(REF_RE, ''))) throw new AgentToolError(`${where}: braces only as \${NAME}`, 400)
  return names
}

/** The config an Add may write, checked; throws AgentToolError(400). */
export function checkOwnToolConfig(input: unknown): OwnToolConfig {
  if (!isObject(input)) throw new AgentToolError('config must be an object', 400)
  const type = input.type ?? 'stdio'
  if (type === 'stdio') {
    const command = input.command
    if (typeof command !== 'string' || command.trim() === '' || command.length > 1024) throw new AgentToolError('command required', 400)
    refsIn('command', command)
    const args = input.args ?? []
    if (!Array.isArray(args) || args.length > 64 || args.some((a) => typeof a !== 'string' || a.length > 2048))
      throw new AgentToolError('args must be a list of strings', 400)
    args.forEach((a, i) => refsIn(`args[${i}]`, a as string))
    const env = checkMap('env', input.env, ENV_KEY_RE, (k, v) => {
      if (!/^\$\{[^}]+\}$/.test(v)) throw new AgentToolError(`env ${k}: the value is a Vault name as \${NAME}, never the secret itself`, 400)
      refsIn(`env ${k}`, v)
    })
    return { command, ...(args.length > 0 ? { args: args as string[] } : {}), ...(env ? { env } : {}) }
  }
  if (type === 'http' || type === 'sse') {
    const url = input.url
    if (typeof url !== 'string' || url.length > 2048) throw new AgentToolError('url required', 400)
    let parsed: URL
    try {
      parsed = new URL(url.replace(REF_RE, 'x'))
    } catch {
      throw new AgentToolError('url is not a URL', 400)
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new AgentToolError('url must be http(s)', 400)
    refsIn('url', url)
    const headers = checkMap('headers', input.headers, HEADER_NAME_RE, (k, v) => {
      if (!HEADER_VALUE_RE.test(v))
        throw new AgentToolError(`header ${k}: the value is a Vault name as \${NAME} (optionally after Bearer/Basic/Token), never the secret itself`, 400)
      refsIn(`header ${k}`, v)
    })
    return { type, url, ...(headers ? { headers } : {}) }
  }
  throw new AgentToolError("type must be 'stdio', 'http' or 'sse'", 400)
}

function checkMap(field: string, v: unknown, keyRe: RegExp, check: (k: string, v: string) => void): Record<string, string> | null {
  if (v === undefined) return null
  if (!isObject(v)) throw new AgentToolError(`${field} must be an object`, 400)
  const out = Object.create(null) as Record<string, string>
  const entries = Object.entries(v)
  if (entries.length > 64) throw new AgentToolError(`${field}: too many entries`, 400)
  for (const [k, val] of entries) {
    if (!keyRe.test(k)) throw new AgentToolError(`${field}: bad name ${JSON.stringify(k)}`, 400)
    if (typeof val !== 'string') throw new AgentToolError(`${field} ${k}: must be a string`, 400)
    check(k, val)
    out[k] = val
  }
  return entries.length > 0 ? { ...out } : null
}

/** The Vault names one stored config refers to (tolerant: a hand edit may be anything). */
function refsOf(cfg: unknown): string[] {
  const out = new Set<string>()
  const walk = (v: unknown): void => {
    if (typeof v === 'string') for (const m of v.matchAll(REF_RE)) out.add(m[1] ?? '')
    else if (Array.isArray(v)) v.forEach(walk)
    else if (isObject(v)) Object.values(v).forEach(walk)
  }
  walk(cfg)
  return [...out].filter((n) => n !== '').sort()
}

function transportOf(cfg: unknown): OwnToolTransport {
  const t = isObject(cfg) ? cfg.type : undefined
  return t === 'http' || t === 'sse' ? t : 'stdio'
}

function detailOf(cfg: unknown): string {
  if (!isObject(cfg)) return ''
  if (typeof cfg.url === 'string') return cfg.url
  return typeof cfg.command === 'string' ? cfg.command : ''
}

export class AgentTools {
  constructor(private state: Pick<AgentStateStore, 'readOwnText' | 'containedDirFor'>) {}

  /** a file's servers, tolerant: missing, unparsable or odd = none */
  private servers(agentId: string, file: string): Servers {
    const out = Object.create(null) as Servers
    let raw: string | null = null
    try {
      raw = this.state.readOwnText(agentId, ['plugin'], file, { maxBytes: MAX_BYTES })
    } catch {
      raw = null
    }
    if (raw === null) return out
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return out
    }
    const list = isObject(parsed) ? parsed.mcpServers : undefined
    if (!isObject(list)) return out
    for (const [k, v] of Object.entries(list)) out[k] = v
    return out
  }

  /** the ACTIVE servers' configs, as the engine reads them (OpenCode's assembly) */
  activeConfigs(agentId: string): Record<string, unknown> {
    return { ...this.servers(agentId, OWN_MCP_FILE) }
  }

  list(agentId: string, vaultNames?: ReadonlySet<string>): OwnToolRow[] {
    const rows: OwnToolRow[] = []
    for (const [file, state] of [
      [OWN_MCP_FILE, 'active'],
      [OWN_HELD_MCP_FILE, 'held'],
    ] as const) {
      const servers = this.servers(agentId, file)
      for (const name of Object.keys(servers).sort()) {
        // a name in both files (a hand edit): the active one is what loads
        if (state === 'held' && rows.some((r) => r.name === name)) continue
        const cfg = servers[name]
        const refs = refsOf(cfg)
        rows.push({
          name,
          kind: 'mcp',
          scope: 'agent',
          state,
          transport: transportOf(cfg),
          detail: detailOf(cfg),
          refs,
          needs: vaultNames ? refs.filter((r) => !vaultNames.has(r)) : [],
        })
      }
    }
    return rows
  }

  add(agentId: string, agentName: string, name: string, config: unknown): void {
    if (!OWN_TOOL_NAME_RE.test(name)) throw new AgentToolError('name: a letter, then letters, digits, - or _ (64 at most)', 400)
    const cfg = checkOwnToolConfig(config)
    const active = this.servers(agentId, OWN_MCP_FILE)
    if (own(active, name) || own(this.servers(agentId, OWN_HELD_MCP_FILE), name)) throw new AgentToolError(`${name} is already one of its tools`, 409)
    active[name] = cfg
    this.write(agentId, agentName, OWN_MCP_FILE, active)
  }

  hold(agentId: string, agentName: string, name: string): void {
    this.move(agentId, agentName, name, OWN_MCP_FILE, OWN_HELD_MCP_FILE)
  }
  activate(agentId: string, agentName: string, name: string): void {
    this.move(agentId, agentName, name, OWN_HELD_MCP_FILE, OWN_MCP_FILE)
  }

  remove(agentId: string, agentName: string, name: string): void {
    for (const file of [OWN_MCP_FILE, OWN_HELD_MCP_FILE]) {
      const servers = this.servers(agentId, file)
      if (!own(servers, name)) continue
      delete servers[name]
      this.write(agentId, agentName, file, servers)
      return
    }
    throw new AgentToolError(`${name} is not one of its tools`, 404)
  }

  private move(agentId: string, agentName: string, name: string, from: string, to: string): void {
    const src = this.servers(agentId, from)
    const dst = this.servers(agentId, to)
    if (!own(src, name)) {
      if (own(dst, name)) return // already there — idempotent
      throw new AgentToolError(`${name} is not one of its tools`, 404)
    }
    // the target first: a crash between the two writes leaves it in both,
    // read as active (list) — never lost
    dst[name] = src[name]
    this.write(agentId, agentName, to, dst)
    delete src[name]
    this.write(agentId, agentName, from, src)
  }

  private write(agentId: string, agentName: string, file: string, servers: Servers): void {
    const dir = this.state.containedDirFor(agentId, ['plugin'], true)
    if (dir === null) throw new AgentToolError('the agent has no state folder', 409)
    // the engine accepts the dir only with a manifest (role-plugin.ts)
    ensureRolePluginManifest(dir, agentId, agentName)
    writeContained(dir, file, JSON.stringify({ mcpServers: { ...servers } }, null, 2) + '\n')
    sealHooks().pluginWritten?.(dir)
  }
}
