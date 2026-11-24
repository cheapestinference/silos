// Territory fence: constants pinned from scripts/territory-smoke.sh on the real binary.

/** tool_result text Claude Code writes when a Read/Edit deny rule refuses a call
 *  (Read tool: "File is in a directory that is denied by your permission settings.";
 *  Bash: "Permission to use Bash with command ... has been denied."). */
export const FENCE_REFUSAL_RE = /denied by your permission settings|Permission to use \w+ with command .* has been denied/i

export const FENCE_SMOKE_NOTE =
  'Claude Code 2.1.308, 2026-10-23: Read -> "<tool_use_error>File is in a directory that is denied by your permission settings.</tool_use_error>"; Bash cat -> "Permission to use Bash with command cat <path> has been denied."'

import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Agent } from './types.js'
// runtime-safe: the registry is a leaf (it imports this module's types only)
import { registeredHarnesses } from './harnesses/registry.js'

export interface FenceInput {
  agent: Agent
  agents: Agent[]
  privatePaths: string[]
  home: string
  dataDir: string
  agentStateDir: string
  /** Top-level entries found on disk in dataDir (the adapter reads them),
   *  denied on top of the fixed lists — never `agent-state`. */
  dataDirEntries?: { dirs: string[]; files: string[] }
  /** Directory names found on disk under dataDir/agent-state: the state of
   *  deleted agents is denied like the state of live ones. */
  stateDirIds?: string[]
  /** Absolute paths of files holding an ENGINE's own login secrets
   *  (Harness.secretFiles — e.g. OpenCode's auth.json): denied read and
   *  edit for every agent, whatever engine it runs on. The adapter fills it
   *  from every registered harness; a non-absolute entry is ignored. */
  engineSecretFiles?: string[]
  /** Each registered engine's configFiles(folder, home) (Harness.configFiles):
   *  files an engine loads executable behaviour from (MCP servers, its own
   *  config). Called once per territory; every agent is denied Edit on the
   *  union, whatever engine it runs on. A non-absolute entry is ignored. */
  engineConfigFiles?: (folder: string) => string[]
}

/** Top-level FILES of the data dir, by name or pattern. Never a bare `*`:
 *  Claude Code matches deny rules gitignore-style, so `<dataDir>/*` also
 *  matches the `agent-state` DIRECTORY and with it the agent's own state
 *  (verified on 2.1.309: Read of agent-state/me/status.json refused
 *  under `Read(//d/*)`; allowed under `d/token` + `d/*.json`). */
export const DATA_DIR_FILES_DENIED = ['token', '.*', '*.json', '*.env', '*.json.*', '*.jsonl', '*.jsonl.*', '*.log', '*.lock', '*.tmp', '*.bak*'] as const

/** Every top-level directory of the data dir an agent's tools must never
 *  touch — everything but `agent-state`, which the per-agent rules govern
 *  (own dir allowed, every other agent's denied), and `claude-accounts`,
 *  fenced file by file like `~/.claude` (CLAUDE_CONFIG_DENIED). Fixed here
 *  so a dir that does not exist yet is fenced before it is created; the
 *  adapter adds whatever else is on disk at launch. */
export const DATA_DIR_DENIED = [
  'agents',
  'accounts',
  'trash',
  'consoles',
  'console-env',
  'console-append',
  'console-rotations',
  'claude-settings-backups',
  'backups',
  'file-backups',
  'cache',
  'logs',
  'runs',
  // the owner's answers to OpenCode permission asks (asks-store.ts): an agent
  // that could write here could approve its own asks
  'asks-replies',
  // the heartbeat ledger and what an agent considered: read back into quotas
  // and prompts — never the agent's to write
  'heartbeats',
  // the agents' messages (messages.ts): «read» is the
  // server's word only if no agent can mark, delete or forge one by file —
  // agents read their inbox through the API, never here
  'messages',
  // the seal's copies (a credential's copy is its hash; the others are the
  // literal bytes Silos wrote — vault.json and providers.json among them) and
  // the quarantine of what changed outside Silos (seals.ts)
  'seals',
  'held',
  // a proposed skill while its accept validates WHAT WAS MOVED (skill-accept.ts):
  // a live turn must never reach the staged tree
  'skill-staging',
  // the windows of Usage (usage-ledger.ts): who and
  // why each turn ran — what the caps' breakdown and Usage attribute by; an
  // agent that could write here could move its spend onto another's row
  'usage',
  // the signer's rows (egress-log.ts): the paths every
  // agent called with a signed credential — the owner's to read, no agent's
  'egress',
  // the servers' status readings (tool-health.ts): what the screen says of
  // each server's health — no agent's to write, or forge
  'tool-health',
] as const

/** The data dir's extra Claude Code accounts: one CLAUDE_CONFIG_DIR each. */
export const CLAUDE_ACCOUNTS_DIR = 'claude-accounts'

/** What an agent's tools may never touch inside a Claude Code config dir —
 *  `~/.claude` and every extra account alike (`claude-accounts/<name>`):
 *  the login, the settings (hooks, the fence itself), the prompt history,
 *  and the account's state file with its backups. The rest of a config dir
 *  is the engine's working memory: an account's `projects/` holds the auto
 *  memory (`<config dir>/projects/<project>/memory/`, where Claude Code
 *  writes it under CLAUDE_CONFIG_DIR). Denying the whole account dir (as
 *  it once did) denied an agent its OWN memory on every turn that fell back
 *  to that account — deny rules outrank any allow, so
 *  the fence names files instead. `read` entries are denied Read only. */
export const CLAUDE_CONFIG_DENIED: readonly { glob: string; read?: true; edit?: true }[] = [
  { glob: '.credentials.json' },
  { glob: 'settings*.json' },
  { glob: 'history.jsonl', read: true },
  { glob: 'backups/**' },
  // the user memory every conversation of the machine loads
  { glob: 'CLAUDE.md' },
  // the home layer the engine LOADS behaviour from in every session, the
  // owner's consoles included — a planted skill, command, subagent, plugin
  // or output style would act everywhere.
  // Edit only, on purpose: a skill's supporting files are read with the
  // Read tool, so a Read deny here broke every personal and marketplace
  // skill that ships a reference file (smoke on Claude Code 2.1.3xx:
  // the Skill tool loaded, the Read of its reference.md was refused).
  { glob: 'skills/**', edit: true },
  { glob: 'commands/**', edit: true },
  { glob: 'agents/**', edit: true },
  { glob: 'plugins/**', edit: true },
  { glob: 'output-styles/**', edit: true },
]

/** Inside each territory: the folder's engine settings (permission rules,
 *  hooks, Claude Code's own «Always allow») are neither read nor written by
 *  an agent; its skills are not written (a skill is
 *  proposed, never planted). Paths relative to the territory root. */
export const TERRITORY_DENIED: readonly { glob: string; edit?: true }[] = [{ glob: '.claude/settings*.json' }, { glob: '.claude/skills/**', edit: true }]

/** The agent's own plugin dir (role-plugin.ts rolePluginDir), relative to its
 *  state dir: everything an engine loads from a plugin — skills, commands,
 *  agents, hooks, .mcp.json, .claude-plugin — is written by Silos (and the
 *  owner's own hand), never by the agent. The rest of its state dir stays
 *  open. */
export const OWN_PLUGIN_DIR = 'plugin'

/** Every process's environment: a turn token or bearer read off another
 *  process. File tools and `cat`; an interpreter is not
 *  covered. Both forms: the pid level and the per-thread one. */
export const PROC_ENVIRON_DENIED = ['/proc/*/environ', '/proc/**/environ'] as const

export interface FenceOverlay {
  permissions: { deny: string[]; additionalDirectories: string[] }
  /** On-disk entries of the data dir that were NOT written as a rule, with
   *  why (a glob character in the name — globSkipReason). Absent when none.
   *  Never sent to an engine: the launches pass `permissions` only. */
  skipped?: { path: string; reason: string }[]
}

/** Characters with glob meaning in at least one engine's deny patterns:
 *  Claude Code reads Read/Edit rules gitignore-style (`*`, `?`, `[…]`,
 *  leading `!`, `\` escapes; braces in some matchers); OpenCode compiles
 *  `*`→`.*`, `?`→`.` with NO escape, and substitutes `{…}` over its whole
 *  config text (assertNoBrace aborts the launch on `{`). */
export const GLOB_CHARS = ['*', '?', '[', ']', '{', '}', '!', '\\'] as const

/** Why a NAME found on disk cannot become a literal path in a deny rule, or
 *  null when it can. There is no escape both engines read the same way, so
 *  a rule built from it would match more or less than that one entry (an
 *  `agent-stat?` dir would deny every agent its own state): the entry is
 *  skipped and reported, never guessed. */
export function globSkipReason(name: string): string | null {
  const c = GLOB_CHARS.find((g) => name.includes(g))
  return c === undefined
    ? null
    : `name holds the glob character ${JSON.stringify(c)}: no deny rule matches exactly that entry in both engines, so none is written`
}

/** Trailing slashes off (never `/` itself) — the stored/compared form of a territory. */
export const stripTrailingSlash = (p: string): string => (p.length > 1 ? p.replace(/\/+$/, '') || '/' : p)

/** [folder, ...folders]: absolute only, trailing slashes stripped (not `/`
 *  itself), deduplicated after stripping, primary first. */
export function territoriesOf(agent: Pick<Agent, 'folder' | 'folders'>): string[] {
  const out: string[] = []
  for (const p of [agent.folder, ...(agent.folders ?? [])]) {
    if (typeof p !== 'string' || !p.startsWith('/')) continue
    const t = stripTrailingSlash(p)
    if (!out.includes(t)) out.push(t)
  }
  return out
}

const strip = stripTrailingSlash
const abs = (p: string): string => `//${strip(p).replace(/^\/+/, '')}`
const expandHome = (p: string, home: string): string => (p === '~' ? home : p.startsWith('~/') ? `${strip(home)}/${p.slice(2)}` : p)

/** The per-agent permissions overlay. null = no fence (master, archived). */
export function fenceFor(input: FenceInput): FenceOverlay | null {
  const { agent, agents, home, dataDir, agentStateDir } = input
  if (agent.id === 'master' || agent.folder == null || agent.archived) return null
  const deny: string[] = []
  const both = (p: string): void => {
    deny.push(`Read(${abs(p)})`, `Edit(${abs(p)})`)
  }

  // (a) Silos state — every top-level FILE of the data dir (token,
  // agents.json, vault.json, sessions.json…) and every top-level directory
  // but agent-state — and Claude credentials/settings.
  const silosDir = strip(dataDir)
  const segment = (n: string): boolean => n !== '' && !n.includes('/') && n !== '.' && n !== '..' && n !== 'agent-state'
  // Names read from DISK are literal: one with a glob character is skipped
  // (globSkipReason). The fixed lists above are patterns on purpose.
  const skipped: { path: string; reason: string }[] = []
  const literal = (name: string, path: string): boolean => {
    const reason = globSkipReason(name)
    if (reason !== null) skipped.push({ path, reason })
    return reason === null
  }
  const fixedFiles = new Set<string>(DATA_DIR_FILES_DENIED)
  for (const f of new Set<string>([...DATA_DIR_FILES_DENIED, ...(input.dataDirEntries?.files ?? [])])) {
    if (segment(f) && (fixedFiles.has(f) || literal(f, `${silosDir}/${f}`))) both(`${silosDir}/${f}`)
  }
  const fixedDirs = new Set<string>(DATA_DIR_DENIED)
  for (const d of new Set<string>([...DATA_DIR_DENIED, ...(input.dataDirEntries?.dirs ?? [])])) {
    if (d === CLAUDE_ACCOUNTS_DIR) continue // file by file, below
    if (segment(d) && (fixedDirs.has(d) || literal(d, `${silosDir}/${d}`))) both(`${silosDir}/${d}/**`)
  }
  // Claude Code's config dirs: ~/.claude (its state file sits beside it,
  // ~/.claude.json) and every extra account (its state file inside: an
  // account dir is a whole CLAUDE_CONFIG_DIR) — one pattern for all accounts,
  // so one created after launch is fenced too
  const configDir = (dir: string): void => {
    for (const { glob, read, edit } of CLAUDE_CONFIG_DENIED) {
      if (read) deny.push(`Read(${abs(`${dir}/${glob}`)})`)
      else if (edit) deny.push(`Edit(${abs(`${dir}/${glob}`)})`)
      else both(`${dir}/${glob}`)
    }
  }
  configDir(`${strip(home)}/.claude`)
  both(`${strip(home)}/.claude.json`)
  configDir(`${silosDir}/${CLAUDE_ACCOUNTS_DIR}/*`)
  both(`${silosDir}/${CLAUDE_ACCOUNTS_DIR}/*/.claude.json`)
  // other engines' login secrets (Harness.secretFiles) — same rank as
  // Claude's credentials above, declared by each adapter instead of here.
  for (const raw of input.engineSecretFiles ?? []) {
    const p = strip(raw)
    if (p.startsWith('/')) both(p)
  }
  for (const p of PROC_ENVIRON_DENIED) deny.push(`Read(${abs(p)})`)

  // (b) other agents' state dirs — live, archived, master, and any left on
  // disk by an agent no longer in the registry. Never one's own.
  const stateIds = new Set<string>([...agents.map((a) => a.id), ...(input.stateDirIds ?? [])])
  stateIds.delete(agent.id)
  for (const id of stateIds) {
    if (segment(id) && literal(id, `${silosDir}/agent-state/${id}`)) both(`${silosDir}/agent-state/${id}/**`)
  }
  const others = agents.filter((a) => a.id !== agent.id && a.id !== 'master' && !a.archived)

  // (c) other roles' context/ inside shared territories.
  const mine = territoriesOf(agent)
  // (c') each territory's engine settings and skills, and the files every
  // registered engine loads behaviour from there (Harness.configFiles) — in
  // EVERY folder of EVERY agent Silos knows (archived included), not only
  // its own: a hook in another agent's .claude/settings.local.json, or a
  // skill/.mcp.json planted there, would run as that agent — the unfenced
  // one included (privilege escalation). Same per-file
  // shapes as its own folders; a folder shared by several agents is listed
  // once.
  const conductFolders = new Set<string>(mine)
  for (const a of agents) for (const t of territoriesOf(a)) conductFolders.add(t)
  for (const t of conductFolders) {
    for (const { glob, edit } of TERRITORY_DENIED) {
      if (edit) deny.push(`Edit(${abs(`${t}/${glob}`)})`)
      else both(`${t}/${glob}`)
    }
    for (const raw of input.engineConfigFiles?.(t) ?? []) {
      const p = strip(raw)
      if (p.startsWith('/')) deny.push(`Edit(${abs(p)})`)
    }
  }
  // the agent's own plugin, whole — its state dir stays an additional dir
  // and the deny outranks it
  if (input.agentStateDir !== '') deny.push(`Edit(${abs(`${input.agentStateDir}/${OWN_PLUGIN_DIR}/**`)})`)
  for (const t of mine) {
    for (const o of others) {
      if (territoriesOf(o).includes(t)) deny.push(`Edit(${abs(`${strip(t)}/context/${o.id}/**`)})`)
    }
  }

  // (d) private paths, unless inside or containing one of my territories.
  for (const raw of input.privatePaths) {
    const p = strip(expandHome(raw, home))
    if (!p.startsWith('/')) continue
    if (mine.some((t) => t === p || t.startsWith(`${p}/`) || p.startsWith(`${t}/`))) continue
    // the path itself too: a private FILE (~/.npmrc) is not matched by `/**`
    both(p)
    both(`${p}/**`)
  }

  return {
    permissions: {
      deny: [...new Set(deny)],
      additionalDirectories: [...mine.slice(1), agentStateDir],
    },
    ...(skipped.length > 0 ? { skipped } : {}),
  }
}

/** What both engines and the routes ask: an agent's fence, or null. */
export interface TerritoryAdapter {
  fenceFor(agentId: string): FenceOverlay | null
  /** The fence this agent WOULD get once enabled (rollout gate ignored) —
   *  Settings › Territory describes it before the owner turns it on. */
  fenceWhenOn?(agentId: string): FenceOverlay | null
  /** fenceWhenOn read back as places (fenceScope), against the SAME home and
   *  data dir the fence was built from. null = no fence (master, archived). */
  scopeWhenOn?(agentId: string): FenceScope | null
}

function entriesOf(dir: string): { dirs: string[]; files: string[] } {
  const out = { dirs: [] as string[], files: [] as string[] }
  try {
    for (const e of readdirSync(dir, { withFileTypes: true })) (e.isDirectory() ? out.dirs : out.files).push(e.name)
  } catch {
    /* missing dir: the fixed lists still apply */
  }
  return out
}

/** THE adapter (index.ts builds one; tests build theirs the same way).
 *  Unknown agent → no fence; an agent the owner has not enabled yet
 *  (TerritoryStore.enabled, the rollout gate) → no fence; an id the state
 *  store rejects keeps the deny rules, just without its state dir. The data
 *  dir is read at every call so whatever exists there at launch is fenced. */
export function makeTerritory(d: {
  registry: { get(id: string): Agent | null; list(includeArchived?: boolean): Agent[] }
  /** The agent's state dir PATH — never created here (AgentStateStore.pathFor):
   *  computing a fence is a read (Settings › Territory computes one for every
   *  fenceable agent); the launches create the dir when they write into it. */
  agentState: { pathFor(agentId: string): string }
  store: { privatePaths(): string[]; isEnabled(agentId: string): boolean }
  home: string
  dataDir: string
}): TerritoryAdapter {
  const compute = (agentId: string, gated: boolean): FenceOverlay | null => {
    const agent = d.registry.get(agentId)
    if (!agent || (gated && !d.store.isEnabled(agentId))) return null
    let stateDir: string | null = null
    try {
      stateDir = d.agentState.pathFor(agentId)
    } catch {
      /* unsafe id: no state dir */
    }
    const fence = fenceFor({
      agent,
      agents: d.registry.list(true),
      privatePaths: d.store.privatePaths(),
      home: d.home,
      dataDir: d.dataDir,
      agentStateDir: stateDir ?? '',
      dataDirEntries: entriesOf(d.dataDir),
      stateDirIds: entriesOf(join(d.dataDir, 'agent-state')).dirs,
      engineSecretFiles: registeredHarnesses().flatMap((h) => h.secretFiles?.(d.home) ?? []),
      engineConfigFiles: (folder) => registeredHarnesses().flatMap((h) => h.configFiles?.(folder, d.home) ?? []),
    })
    if (fence && stateDir === null) fence.permissions.additionalDirectories = fence.permissions.additionalDirectories.filter((x) => x !== '')
    return fence
  }
  return {
    fenceFor: (agentId) => compute(agentId, true),
    fenceWhenOn: (agentId) => compute(agentId, false),
    scopeWhenOn: (agentId) => {
      const agent = d.registry.get(agentId)
      const fence = agent ? compute(agentId, false) : null
      return agent && fence ? fenceScope(fence, territoriesOf(agent), { home: d.home, dataDir: d.dataDir }) : null
    },
  }
}

/** The private paths ACTUALLY denied by an overlay — a configured path
 *  inside or containing one of the agent's territories is not. Machinery
 *  shows this number, never the configured count. */
export function appliedPrivatePaths(fence: FenceOverlay | null, privatePaths: string[], home: string): string[] {
  if (fence === null) return []
  const deny = new Set(fence.permissions.deny)
  return privatePaths.filter((raw) => {
    const p = strip(expandHome(raw, home))
    return p.startsWith('/') && deny.has(`Read(${abs(p)}/**)`)
  })
}

/** What a fence means, in places a person recognizes — read back from the
 *  overlay's own rules (never a second description of the policy):
 *  `readOnly` = other roles' context/ it may read but not edit,
 *  `noChange` = the rest it may read but not edit — what its engine loads
 *  (skills, plugins, MCP and engine config, its own plugin),
 *  `blocked` = groups it may neither read nor edit. Its territories and its
 *  own state dir are open (a fence only denies). Home is shown as `~`. */
export interface FenceScope {
  works: string[]
  state: string | null
  readOnly: string[]
  noChange: string[]
  blocked: { kind: 'silos' | 'claude' | 'agents' | 'private'; paths: string[] }[]
}

export function fenceScope(fence: FenceOverlay, territories: string[], o: { home: string; dataDir: string }): FenceScope {
  const home = strip(o.home)
  const data = strip(o.dataDir)
  const tilde = (p: string): string => (p === home ? '~' : p.startsWith(`${home}/`) ? `~${p.slice(home.length)}` : p)
  const rules = new Map<string, { read: boolean; edit: boolean }>()
  for (const r of fence.permissions.deny) {
    const m = /^(Read|Edit)\(\/\/(.*)\)$/.exec(r)
    if (!m) continue
    const path = `/${m[2]!.replace(/\/\*\*$/, '')}`
    const e = rules.get(path) ?? { read: false, edit: false }
    if (m[1] === 'Read') e.read = true
    else e.edit = true
    rules.set(path, e)
  }
  const readOnly: string[] = []
  const noChange: string[] = []
  const groups = { silos: [] as string[], claude: [] as string[], agents: [] as string[], private: [] as string[] }
  for (const [path, e] of rules) {
    if (!e.read) {
      if (e.edit) (/\/context\/[^/]+$/.test(path) ? readOnly : noChange).push(tilde(path))
      continue
    }
    if (path.startsWith(`${data}/agent-state/`)) groups.agents.push(path.slice(data.length + '/agent-state/'.length))
    // every process's environment carries Silos' tokens (PROC_ENVIRON_DENIED)
    else if (path === data || path.startsWith(`${data}/`) || path.startsWith('/proc/')) groups.silos.push(tilde(path))
    else if (path === `${home}/.claude.json` || path.includes('/.claude/')) groups.claude.push(tilde(path))
    else groups.private.push(tilde(path))
  }
  const state = fence.permissions.additionalDirectories.at(-1) ?? ''
  return {
    works: territories.map(tilde),
    state: state === '' || territories.includes(state) ? null : tilde(state),
    readOnly: readOnly.sort(),
    noChange: noChange.sort(),
    blocked: (['silos', 'claude', 'agents', 'private'] as const).filter((k) => groups[k].length > 0).map((kind) => ({ kind, paths: groups[kind].sort() })),
  }
}
