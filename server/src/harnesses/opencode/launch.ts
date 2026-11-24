// harnesses/opencode/launch — what every OpenCode process Silos launches
// carries: its config (Silos plugin, context file + role prompt as
// instructions, fence as permissions, provider and model) as
// OPENCODE_CONFIG_CONTENT, its own database (OPENCODE_DB), and its identity
// env. All per process: the operator's opencode.json and global DB are never
// written. Pure builders; the only file written is the agent's context file,
// inside its own agent-state dir.

import { existsSync, realpathSync } from 'node:fs'
import { subdirContained, writeContained } from '../../safe-file.js'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { EXPORT_KEY_PLACEHOLDER, type ResolvedProvider } from '../../providers-store.js'
import { gatewayModelFor } from '../../provider-models.js'
import { assertNoBrace, type PermissionConfig } from './fence.js'
import { withOpencodeEntries } from './launch-entries.js'

export interface OpenCodeLaunch {
  argvBase: string[]
  env: Record<string, string>
  configContent: string
}

/** OpenCode `provider.<id>` entries Silos injects (filled from ResolvedProvider). */
export type ProviderInjection = Record<
  string,
  { npm?: string; name?: string; options: Record<string, string>; models?: Record<string, { name: string; limit?: { context?: number; output?: number } }> }
>

/** The provider key travels only in the env; the config names it. */
export const PROVIDER_KEY_ENV = 'SILOS_PROVIDER_KEY'
export const PROVIDER_KEY_REF = `{env:${PROVIDER_KEY_ENV}}`
const SUBSTITUTION_RE = /^\{(env|file):[^}]+\}$/

/** The `provider` entries a Silos provider becomes in an OpenCode config
 *  anthropic-compatible → its own `silos-<id>` provider on
 *  @ai-sdk/anthropic; harness-provider → the key for the id OpenCode already
 *  catalogues (it knows the endpoint and the models); harness-native and
 *  no Silos provider (a Claude account never runs here — providers-validate)
 *  → nothing: OpenCode's own login and defaults stand. The key itself is
 *  never here — only its {env:…} reference. */
export function providerInjection(p: ResolvedProvider | null): ProviderInjection | null {
  if (p?.kind === 'anthropic-compatible') {
    // the models the key reaches (provider.models, learned at connect) are
    // DECLARED on the provider: OpenCode lists a custom provider's models
    // only from its config, so without this `/models` in the TUI shows none
    // of them. No `limit` — unknown here; OpenCode treats a
    // missing context limit as "never compact".
    const models =
      p.models && p.models.length > 0
        ? {
            models: Object.fromEntries(
              p.models.map((m) => {
                const lim = p.modelLimits?.[m]
                // the limits the gateway publishes: OpenCode compacts a long
                // session only when it knows the context size — but its config
                // schema wants BOTH numbers (a `limit` with context alone is
                // ConfigInvalidError and the TUI exits at once, verified on
                // 1.19.4), so a half-known limit is left out
                const limit = lim && lim.context !== undefined && lim.output !== undefined ? { limit: { context: lim.context, output: lim.output } } : {}
                return [m, { name: m, ...limit }]
              }),
            ),
          }
        : {}
    return {
      [silosProviderId(p.id)]: {
        npm: '@ai-sdk/anthropic',
        name: p.label,
        options: { baseURL: sdkAnthropicBaseUrl(p.baseUrl), apiKey: PROVIDER_KEY_REF },
        ...models,
      },
    }
  }
  if (p?.kind === 'harness-provider') return { [p.providerId]: { options: { apiKey: PROVIDER_KEY_REF } } }
  return null
}

/** What "Copy config" hands the operator for an OpenCode agent (the
 *  export) — NEVER the key (a placeholder the operator fills in by hand): the
 *  `provider` fragment Silos itself injects (providerInjection) — or, for a
 *  passthrough, the OpenCode login command (there is nothing to configure).
 *  null: that provider has no OpenCode form. The Claude form lives in
 *  claude-code/export.ts. */
export function exportSnippet(p: ResolvedProvider): string | null {
  if (p.kind === 'harness-native') return `opencode auth login   # choose ${p.providerId}\n`
  const inj = providerInjection(p)
  if (!inj) return null
  for (const entry of Object.values(inj)) if ('apiKey' in entry.options) entry.options.apiKey = EXPORT_KEY_PLACEHOLDER
  return JSON.stringify({ provider: inj }, null, 2) + '\n'
}

/** A Silos gateway is stored the way Claude Code takes it (ANTHROPIC_BASE_URL
 *  = the root, Claude appends `/v1/messages`); the AI SDK's anthropic
 *  provider appends only `/messages` to its baseURL (its default is
 *  `https://api.anthropic.com/v1`). So OpenCode gets `<root>/v1` — with the
 *  root alone it called `…/anthropic/messages` and cheapestinference answered
 *  404 on every turn. A root already ending in `/v1` is kept. */
export function sdkAnthropicBaseUrl(baseUrl: string): string {
  const root = baseUrl.replace(/\/+$/, '')
  return /\/v1$/i.test(root) ? root : `${root}/v1`
}

function silosProviderId(id: string): string {
  return `silos-${id}`
}

/** Everything a provider puts on an OpenCode launch: the config's provider
 *  entries and model (`provider/model`), and the key for SILOS_PROVIDER_KEY
 *  (kinds that carry one; an invalidated '' key is left out). The model is
 *  the cockpit's, always under the provider's id (models.dev ids may hold a
 *  `/` themselves: openrouter/anthropic/…); with no provider of
 *  Silos's, only a `provider/model` id passes (a Claude alias left on the
 *  agent, like `opus`, would name nothing) and the operator's default stands. */
export function providerLaunch(
  p: ResolvedProvider | null,
  model: string | null,
): { provider: ProviderInjection | null; model: string | null; providerKey?: string } {
  const prefix =
    p?.kind === 'anthropic-compatible' ? silosProviderId(p.id) : p?.kind === 'harness-provider' || p?.kind === 'harness-native' ? p.providerId : null
  let m: string | null = null
  // a gateway: the pinned model when the key lists it (or nothing is known),
  // else the key's FIRST model (gatewayModelFor) — never no model, which
  // would send OpenCode to its own default provider's model (a silent swap
  // of accounts), never a model the pool dropped (every run would 404)
  const bare = p?.kind === 'anthropic-compatible' && prefix !== null && model && model.startsWith(`${prefix}/`) ? model.slice(prefix.length + 1) : model
  const effective = p?.kind === 'anthropic-compatible' ? gatewayModelFor(p.models, bare) : model
  if (effective) {
    if (prefix === null) m = effective.includes('/') ? effective : null
    else m = effective.startsWith(`${prefix}/`) ? effective : `${prefix}/${effective}`
  }
  // an invalidated key ('' — its endpoint or providerId changed without a
  // re-paste) fails CLOSED: an empty {env:…} could leave OpenCode to fill
  // the provider from the operator's own login, a silent swap of accounts
  if (p && 'apiKey' in p && p.apiKey === '') throw new Error(`provider ${p.label} has no key — paste it again in Settings › Accounts & providers`)
  const key = p && 'apiKey' in p ? p.apiKey : undefined
  return { provider: providerInjection(p), model: m, ...(key !== undefined ? { providerKey: key } : {}) }
}

/** plugin-opencode/silos.ts at the repo root (layout is fixed). */
export function defaultPluginPath(): string {
  return fileURLToPath(new URL('../../../../plugin-opencode/silos.ts', import.meta.url))
}

/** plugin/skills — Silos' own skills (heartbeat, team-plan, vault-secrets,
 *  support-inbox…). A Claude Code session gets them as copies in its
 *  folder's .claude/skills (added by the owner, kept current by
 *  skill-install.ts); OpenCode gets every one of them at each launch,
 *  declared as a `skills.paths` entry (scanned for <name>/SKILL.md). The
 *  operator's ~/.claude/skills are loaded by OpenCode itself, as Claude Code
 *  loads them. */
export function defaultSkillsPath(): string {
  return fileURLToPath(new URL('../../../../plugin/skills', import.meta.url))
}

// the briefing lives in ../briefing.ts (shared with Claude's unattended runs)
export { defaultBriefingDir, contextText } from '../briefing.js'

/** JSON for OPENCODE_CONFIG_CONTENT (merged by OpenCode over the operator's
 *  config). Null parts are left out so the operator's own value stands.
 *
 *  Merge order, verified in the 1.14.22 embedded source (Config
 *  loadInstanceState): global config › OPENCODE_CONFIG › project
 *  opencode.json(c) (cwd up to the worktree) › .opencode/ dirs ›
 *  OPENCODE_CONFIG_CONTENT (this) › remote org config › managed config ›
 *  OPENCODE_PERMISSION env. Each step is remeda mergeDeep(acc, next) =
 *  `{...acc, ...next}` per level: a key an earlier layer already holds KEEPS
 *  ITS POSITION (only the value is ours), and permission rules are
 *  last-match-wins in key order — so an earlier layer carrying one of our
 *  exact pattern keys could slip its own allow between our deny and a later
 *  match. A fenced agent is therefore launched with
 *  OPENCODE_DISABLE_PROJECT_CONFIG=1 (envFor `fenced`; no project layer at
 *  all — note it also skips project AGENTS.md discovery) and with edit
 *  denies on every OpenCode config file (fence.ts opencodeConfigDenies). A
 *  `bash` write to those files remains possible: the light fence's known
 *  limit, the same as for Claude's settings files.
 *
 *  Throws when a provider option other than `baseURL` is a plain string
 *  (only `{env:…}`/`{file:…}` substitutions: a literal key must never sit in
 *  a process's config), and when a path, permission pattern or other plain
 *  value carries `{` (OpenCode substitutes over the whole text). */
// the heartbeat's prevention in OpenCode's dialect — verified
// against the installed binary only by the smoke (scripts/opencode-heartbeat-
// smoke.sh); until it is green the prompt says subagents and connectors may
// not be blocked (opencode/index.ts traits.heartbeatBlocks)
export const HEARTBEAT_TOOLS_OFF = { webfetch: false, websearch: false, task: false } as const
export const HEARTBEAT_PERMISSION_DENY = { webfetch: 'deny', websearch: 'deny', task: 'deny' } as const
// a round WITH its tools: the regime of its
// runs — the web on — but never a subagent (R4: no round delegates)
export const ROUND_TOOLS_OFF = { task: false } as const
export const ROUND_PERMISSION_DENY = { task: 'deny' } as const

export function configContent(input: {
  pluginPath: string
  instructions: string[]
  permission: PermissionConfig | null
  provider: ProviderInjection | null
  model: string | null
  /** `skills.paths` (defaultSkillsPath for every Silos launch); absent = none. */
  skillsPaths?: string[]
  /** a heartbeat turn: no web fetch, no web search
   *  and no subagent (OpenCode's subagent IS the `task` tool, gated by
   *  `permission`) — in both the deprecated `tools` and its successor
   *  `permission` (singular: `permissions` aborts the launch in 1.19.x). */
  heartbeat?: boolean | 'tools'
  /** the agent's own MCP servers in OpenCode's dialect (ownMcpForOpencode) */
  mcp?: Record<string, OpencodeMcp>
  /** what Silos keeps for this launch's places, in overlay order — the
   *  folder's, the agent's, (T5) the thread's — each through the allowlist
   *  (launch-entries.ts), merged last: `mcp.<name>.enabled` over every
   *  layer, a skill's deny INTO `permission`. A heartbeat takes only what
   *  removes. Empty or absent: the content is what it was. */
  carried?: readonly unknown[]
}): string {
  assertNoBrace('plugin path', input.pluginPath)
  for (const d of input.skillsPaths ?? []) assertNoBrace('skills path', d)
  for (const f of input.instructions) assertNoBrace('instruction path', f)
  for (const rules of Object.values(input.permission ?? {})) {
    if (rules && typeof rules === 'object') for (const pattern of Object.keys(rules)) assertNoBrace('permission pattern', pattern)
  }
  if (input.model) assertNoBrace('model', input.model)
  for (const [id, p] of Object.entries(input.provider ?? {})) {
    assertNoBrace('provider id', id)
    if (p.npm) assertNoBrace('provider npm', p.npm)
    if (p.name) assertNoBrace('provider name', p.name)
    for (const [k, v] of Object.entries(p.options)) {
      if (k === 'baseURL') assertNoBrace('provider baseURL', v)
      else if (!SUBSTITUTION_RE.test(v))
        throw new Error(`opencode launch: provider ${id} option ${k} must be an {env:…}/{file:…} substitution (e.g. ${PROVIDER_KEY_REF}), never a literal`)
    }
  }
  const cfg: Record<string, unknown> = { plugin: [input.pluginPath], instructions: input.instructions }
  if (input.skillsPaths && input.skillsPaths.length > 0) cfg.skills = { paths: input.skillsPaths }
  if (input.permission) cfg.permission = input.permission
  if (input.heartbeat === 'tools') {
    cfg.tools = { ...ROUND_TOOLS_OFF }
    cfg.permission = { ...(input.permission ?? {}), ...ROUND_PERMISSION_DENY }
  } else if (input.heartbeat) {
    cfg.tools = { ...HEARTBEAT_TOOLS_OFF }
    cfg.permission = { ...(input.permission ?? {}), ...HEARTBEAT_PERMISSION_DENY }
  }
  if (input.provider) cfg.provider = input.provider
  if (input.model) cfg.model = input.model
  if (input.mcp && Object.keys(input.mcp).length > 0) {
    // OpenCode substitutes braces over the whole text: only {env:NAME} here
    const strings = (v: unknown): string[] =>
      typeof v === 'string' ? [v] : Array.isArray(v) ? v.flatMap(strings) : v && typeof v === 'object' ? Object.values(v).flatMap(strings) : []
    for (const [name, server] of Object.entries(input.mcp)) {
      assertNoBrace('mcp server name', name)
      for (const str of strings(server)) assertNoBrace(`mcp ${name}`, str.replace(/\{env:[A-Z][A-Z0-9_]*\}/g, ''))
    }
    cfg.mcp = input.mcp
  }
  return JSON.stringify(withOpencodeEntries(cfg, input.carried, { onlyRemoves: input.heartbeat !== undefined && input.heartbeat !== false }))
}

/** An `mcp` entry of an OpenCode config (verified on 1.19.6 with
 *  `opencode debug config`): a local process or a remote endpoint. */
export type OpencodeMcp =
  | { type: 'local'; command: string[]; environment?: Record<string, string>; enabled: true }
  | { type: 'remote'; url: string; headers?: Record<string, string>; enabled: true }

/** The agent's own servers (agent-tools.ts, Claude's .mcp.json shape) in
 *  OpenCode's dialect: keyed `<agentId>_<name>` — namespaced like Claude's
 *  `plugin:<id>:<name>`, so the operator's own opencode.json names are never
 *  shadowed — and every `${NAME}` as `{env:NAME}`. An entry that is not a
 *  well-formed config (a hand edit) is skipped, never guessed. */
export function ownMcpForOpencode(agentId: string, servers: Record<string, unknown>): Record<string, OpencodeMcp> {
  const ref = (s: string): string => s.replace(/\$\{([A-Z][A-Z0-9_]*)\}/g, '{env:$1}')
  const strMap = (v: unknown): Record<string, string> | undefined => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined
    const out: Record<string, string> = {}
    for (const [k, x] of Object.entries(v)) if (typeof x === 'string') out[k] = ref(x)
    return Object.keys(out).length > 0 ? out : undefined
  }
  const out: Record<string, OpencodeMcp> = {}
  for (const [name, raw] of Object.entries(servers)) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
    const c = raw as Record<string, unknown>
    const key = `${agentId}_${name}`
    if ((c.type === 'http' || c.type === 'sse') && typeof c.url === 'string') {
      const headers = strMap(c.headers)
      out[key] = { type: 'remote', url: ref(c.url), ...(headers ? { headers } : {}), enabled: true }
    } else if ((c.type === undefined || c.type === 'stdio') && typeof c.command === 'string') {
      const args = Array.isArray(c.args) ? c.args.filter((a): a is string => typeof a === 'string') : []
      const environment = strMap(c.env)
      out[key] = { type: 'local', command: [c.command, ...args].map(ref), ...(environment ? { environment } : {}), enabled: true }
    }
  }
  return out
}

const RESERVED_ENV = new Set(['SILOS_SESSION_ID', 'SILOS_TURN', 'SILOS_CONSOLE_KEY', 'SILOS_API', 'SILOS_ASKS_REPLIES', PROVIDER_KEY_ENV])

/** The agent's own env (Vault + agent-state, owner-controlled) may not name
 *  what steers OpenCode itself or Silos' wiring — refused, never silently
 *  overridden or let through. Both engines: envFor (headless, console) and
 *  assemble.ts (before the console's env is merged and taken apart). */
export function assertAgentEnv(env: Record<string, string>): void {
  for (const k of Object.keys(env)) {
    if (k.startsWith('OPENCODE_') || RESERVED_ENV.has(k))
      throw new Error(`opencode launch: ${k} is set by Silos for an OpenCode process — rename that Vault entry`)
  }
}

/** The project instruction files OpenCode itself would load, as absolute
 *  paths — for a fenced launch, where OPENCODE_DISABLE_PROJECT_CONFIG turns
 *  OpenCode's own discovery off and Silos lists them in `instructions`
 *  instead (absolute entries still load). Same rule as 1.14.22
 *  (Instruction.systemPaths): names AGENTS.md, CLAUDE.md, CONTEXT.md in that
 *  order; for the FIRST name found anywhere from cwd up to the worktree,
 *  every match (nearest first); the other names are then skipped. */
export function projectInstructions(cwd: string, worktree: string): string[] {
  for (const name of ['AGENTS.md', 'CLAUDE.md', 'CONTEXT.md']) {
    const found: string[] = []
    let dir: string
    try {
      dir = realpathSync(cwd)
    } catch {
      dir = cwd
    }
    for (;;) {
      const f = join(dir, name)
      if (existsSync(f)) found.push(f)
      if (dir === worktree) break
      const up = dirname(dir)
      if (up === dir) break
      dir = up
    }
    if (found.length > 0) return found
  }
  return []
}

/** The process env Silos adds for an OpenCode agent. `agentStateEnv` is
 *  AgentStateStore.envFor(agentId) (SILOS_AGENT_ID, SILOS_AGENT_STATE,
 *  SILOS_AGENT_TOKEN when enabled). */
export function envFor(input: {
  agentId: string
  agentDb: string
  consoleKey?: string
  sessionId?: string
  /** SILOS_TURN: the turn token of an `opencode run` (live-turns.ts)
   *  — a console gets its own from TerminalService. */
  turn?: string
  silosApi: string
  agentStateEnv: Record<string, string>
  providerKey?: string
  configContent: string
  /** The agent's fence is enabled: no project config layer (see configContent). */
  fenced?: boolean
  /** Basic-auth password for the process's HTTP server (OPENCODE_SERVER_PASSWORD, user `silos`). */
  serverPassword?: string
  /** SILOS_ASKS_REPLIES: the Silos-owned dir the plugin polls for the
   *  owner's answers to its permission asks (asks-store.ts asksRepliesDir). */
  asksReplies?: string
}): Record<string, string> {
  const named = input.agentStateEnv.SILOS_AGENT_ID
  if (named !== undefined && named !== input.agentId) throw new Error(`opencode launch: agent-state env is ${named}'s, not ${input.agentId}'s`)
  // agentStateEnv carries the Vault too (owner-controlled)
  assertAgentEnv(input.agentStateEnv)
  const env: Record<string, string> = {
    OPENCODE_DB: input.agentDb,
    OPENCODE_CONFIG_CONTENT: input.configContent,
    SILOS_API: input.silosApi,
    ...input.agentStateEnv,
    SILOS_AGENT_ID: input.agentId,
  }
  if (input.consoleKey) env.SILOS_CONSOLE_KEY = input.consoleKey
  if (input.sessionId) env.SILOS_SESSION_ID = input.sessionId
  if (input.turn) env.SILOS_TURN = input.turn
  if (input.providerKey) env[PROVIDER_KEY_ENV] = input.providerKey
  if (input.asksReplies) env.SILOS_ASKS_REPLIES = input.asksReplies
  if (input.fenced) env.OPENCODE_DISABLE_PROJECT_CONFIG = '1'
  if (input.serverPassword) {
    env.OPENCODE_SERVER_USERNAME = 'silos'
    env.OPENCODE_SERVER_PASSWORD = input.serverPassword
  }
  return env
}

/** Writes `<dir>/opencode/context.md` (dir = the agent's agent-state dir)
 *  atomically and returns its path. */
export function writeContextFile(dir: string, text: string): string {
  return writeOpencodeFile(dir, 'context.md', text)
}

/** Writes `<dir>/opencode/role.md` — the agent's role prompt (the same
 *  system-prompt append Claude's console gets: mission, its memory, the
 *  platform notes), listed second in `instructions` — and returns its path.
 *  Per agent, not per console: every console of the agent reads the same. */
export function writeRoleFile(dir: string, text: string): string {
  return writeOpencodeFile(dir, 'role.md', text)
}

// `dir` is the agent's state dir AS VERIFIED (AgentStateStore
// containedDirFor); `opencode/` is looked up and made INSIDE that pinned
// dir (safe-file.ts subdirContained), never by resolving `dir` again —
// seventh review round: a containedDir rooted at `dir` re-realpath'd it, so
// alice's dir swapped for a link to bob's in between wrote alice's briefing
// and role prompt (her memory) into bob's opencode/. The file goes through
// safe-file.ts — the agent's Bash can plant links there, and a link at
// opencode/ or at the file (or at a predictable temp name) must never get
// the briefing written through it (sixth review round). Throws
// ContainmentError on a refusal: the launch says so instead of writing.
function writeOpencodeFile(dir: string, name: string, text: string): string {
  const ocDir = subdirContained(dir, 'opencode', { create: true, mode: 0o700 })!
  writeContained(ocDir, name, text, { mode: 0o600 })
  return join(ocDir, name)
}
