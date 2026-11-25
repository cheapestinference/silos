// Territory fence: constants pinned from scripts/territory-smoke.sh and
// scripts/territory-smoke-files.mts on the real binary.

/** tool_result text Claude Code writes when a deny rule refuses a call
 *  (Read tool: "File is in a directory that is denied by your permission
 *  settings."; Read through a symlink: "Permission to read <path> has been
 *  denied."; Write through a symlink into a Read-denied folder: "File is
 *  covered by a Read deny rule in your permission settings and cannot be
 *  written."; Bash: "Permission to use Bash with command ... has been
 *  denied."). */
export const FENCE_REFUSAL_RE =
  /denied by your permission settings|covered by a \w+ deny rule in your permission settings|Permission to (use \w+ with command .*|read .*) has been denied/i

/** A tool_result's text as the harness meant it: the `<tool_use_error>`
 *  wrapper off, whitespace collapsed, trimmed. */
export function normalizeToolError(text: string): string {
  return text
    .replace(/<\/?tool_use_error>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** The WHOLE (normalized, is_error) tool_result is one of the pinned refusal
 *  shapes above — never a file or an output that merely quotes them. The
 *  readers record a refused call with this (SessionContext.refused). */
export const FENCE_REFUSAL_WHOLE_RE =
  /^(?:File is in a directory that is denied by your permission settings\.?|File is covered by a \w+ deny rule in your permission settings and cannot be written\.?|Permission to use \w+ with command .+ has been denied\.?|Permission to read .+ has been denied\.?)$/i

const REFUSED_PATH_MAX = 512

/** The path a refused call reached for — from the call's OWN input (a
 *  refusal's text does not always name it), nothing else: a file tool's
 *  path, a search's folder, the first absolute path a command names. Never
 *  the command, a pattern, contents or output (they can carry secrets).
 *  null: the call named no absolute path. */
export function refusedPathOf(tool: string, input: Record<string, unknown>): string | null {
  const s = (v: unknown): string | null => (typeof v === 'string' && v.startsWith('/') ? v : null)
  const direct = s(input.file_path) ?? s(input.filePath) ?? s(input.notebook_path) ?? s(input.path)
  let p = direct
  if (p === null && typeof input.command === 'string' && /^bash$/i.test(tool)) {
    const m = /(?:^|[\s'"=])(\/[^\s'"`;|&<>()]+)/.exec(input.command)
    p = m ? m[1]! : null
  }
  if (p === null) return null
  const clean = p.replace(/\/+$/, '') || '/'
  return clean.length > REFUSED_PATH_MAX ? null : clean
}

/** How many refused calls one conversation keeps (the newest). */
export const REFUSED_CAP = 50

export const FENCE_SMOKE_NOTE =
  'Claude Code 2.1.308, 2026-10-23: Read -> "<tool_use_error>File is in a directory that is denied by your permission settings.</tool_use_error>"; Bash cat -> "Permission to use Bash with command cat <path> has been denied." Claude Code 2.1.331, 2026-11-24 (territory-smoke-files.mts): Read through a symlink -> "Permission to read <path> has been denied."; Write through a symlink -> "File is covered by a Read deny rule in your permission settings and cannot be written."'

import { readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Agent } from './types.js'
import type { ProjectStore } from './harnesses/contract.js'
// runtime-safe: the registry is a leaf (it imports this module's types only)
import { registeredHarnesses } from './harnesses/registry.js'
import { canonicalFolder } from './folder-identity.js'
import { knows, sameProject } from './project-scope.js'

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
  /** The territory switch (TerritoryStore.enabled). false keeps only the two
   *  groups every agent with a folder carries whatever the switch says —
   *  other projects, and the credentials Silos keeps. Default true. */
  on?: boolean
  /** Each registered engine's stores of a folder (Harness.projectStores),
   *  asked for every folder of another project; `own` = this agent's folders. */
  projectStores?: (folder: string, own: readonly string[]) => ProjectStore[]
  /** The linked worktrees git lists for a folder: closed with it. */
  worktreesOf?: (folder: string) => string[]
  /** The cwds of the conversations Silos knows: one under a closed folder
   *  has stores of its own name, closed with it. */
  sessionCwds?: readonly string[]
  /** The disk's reading of a path (folder-identity.ts canonicalFolder). It
   *  only ever REMOVES a deny — a folder that is one of the agent's own under
   *  another spelling stays open; membership stays the declared text. */
  canonical?: (path: string) => string
  /** Places every agent must reach besides the data dir and the engine's
   *  config dir (which fenceFor adds itself): a folder that holds one is
   *  never closed, and says so in `skipped`. */
  mustReach?: readonly MustReach[]
  /** Each registered engine's loadedFromAbove(dir, home)
   *  (Harness.loadedFromAbove): what it could load into a project from a
   *  folder above it. Every agent is denied Edit on the union in every
   *  folder above a known agent's folder and in the Projects folder and
   *  above it — the «other projects» rank (switch on or off). */
  loadedFromAbove?: (dir: string) => string[]
  /** The Projects folder (project-folder.ts projectsFolderOf, or the
   *  setting): it and every folder above it carry the rule above, so an
   *  empty install is covered and a project born later inherits it. */
  projectsFolder?: string
}

/** The credentials Silos keeps, relative to the data dir: the owner's
 *  token, the web sessions, the turn tokens, every agent's bearer
 *  (`agents/<id>/token`), the Vault and the providers file — and every place
 *  that holds a copy of one (the consoles' env files, the seal's copies, the
 *  quarantine), the push keys, this install's Silos ID key. No agent's work
 *  needs them; with them an agent could speak as any other agent or as the
 *  owner. Denied to every agent with a folder, its territory on or off. */
export const SILOS_CREDENTIALS: { files: readonly string[]; dirs: readonly string[] } = {
  files: ['token', 'sessions.json', 'live-turns.json', 'vault.json', 'providers.json', 'silos-id.json', 'server.env'],
  dirs: ['agents', 'console-env', 'seals', 'held', 'push'],
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
  // the user rules every session of the machine loads, like CLAUDE.md —
  // Edit only, as the layer above
  { glob: 'rules/**', edit: true },
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

/** Every process's command line (D8): a launch's argv once carried its
 *  fence — the map of every other project. The fence now rides a 0600 file
 *  named on argv, and command lines stay closed besides: a reduction, not a
 *  wall (an interpreter reads /proc). */
export const PROC_CMDLINE_DENIED = ['/proc/*/cmdline', '/proc/**/cmdline'] as const

/** A territory-on agent's shell never drives Silos' tmux server — the one
 *  every console runs in, where a `tmux send-keys` types into another
 *  project's console (D8). Claude Code checks each part of a compound
 *  command; OpenCode matches the same `tmux *` pattern. A reduction, not a
 *  wall: `/usr/bin/tmux`, `env tmux` or an interpreter is not matched. */
export const TMUX_DENIED = ['Bash(tmux)', 'Bash(tmux *)'] as const

/** The Silos checkout: the briefing sends every agent to its
 *  plugin/context (harnesses/briefing.ts), so a folder holding it is never
 *  closed. */
export const SILOS_CHECKOUT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

export interface FenceOverlay {
  permissions: { deny: string[]; additionalDirectories: string[] }
  /** On-disk entries of the data dir that were NOT written as a rule, with
   *  why (a glob character in the name — globSkipReason). Absent when none.
   *  Never sent to an engine: the launches pass `permissions` only. */
  skipped?: { path: string; reason: string }[]
  /** The «other projects» group, for fenceScope: the folders closed and
   *  every rule the group wrote (folders, worktrees, engine stores). Absent
   *  when there is no other project. Never sent to an engine. */
  projects?: { folders: string[]; rules: string[] }
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

/** A place every agent must reach. `own`: the place is Silos' or an
 *  engine's own — nothing of a project goes inside it either (the project
 *  folder check, project-folder.ts, refuses a folder there). */
export interface MustReach {
  path: string
  what: string
  own?: boolean
}

/** What fenceFor always keeps reachable: Silos' data dir and the engine's
 *  config dir. The project folder check derives its refusals from these and
 *  machineMustReach, so a folder the fence must keep open is never a project. */
export function silosMustReach(home: string, dataDir: string): MustReach[] {
  return [
    { path: stripTrailingSlash(dataDir), what: "Silos' data dir (every agent's own state is in it)", own: true },
    { path: `${stripTrailingSlash(home)}/.claude`, what: "the engine's config dir (the skills every agent loads)", own: true },
  ]
}

/** The machine's places every fence keeps open besides those (makeTerritory). */
export function machineMustReach(): MustReach[] {
  return [
    { path: SILOS_CHECKOUT, what: 'Silos itself (the briefing files every agent reads)', own: true },
    { path: tmpdir(), what: 'the temp dir' },
  ]
}

/** Every folder above `folder`, nearest first, down to the first folder
 *  below `/` (never `/` itself) — where an engine looks for what it loads
 *  from above a project (Harness.loadedFromAbove). */
export function foldersAbove(folder: string): string[] {
  const out: string[] = []
  if (typeof folder !== 'string' || !folder.startsWith('/')) return out
  for (let d = dirname(stripTrailingSlash(folder)); dirname(d) !== d; d = dirname(d)) out.push(d)
  return out
}

/** The folders that carry the rule «no agent writes what an engine loads
 *  from above a project»: every folder above each known agent's folders,
 *  and the Projects folder with every folder above it. Never a folder that
 *  is a known agent's own or sits inside one (its files are that project's,
 *  governed by TERRITORY_DENIED) — the project folder check never lets a
 *  project hold another, so that only drops what a registry without the
 *  check could hold. */
export function aboveProjectFolders(agents: readonly Pick<Agent, 'folder' | 'folders'>[], projectsFolder?: string): string[] {
  const owned = new Set<string>()
  for (const a of agents) for (const t of territoriesOf(a)) owned.add(t)
  const inOwned = (d: string): boolean => [...owned].some((t) => d === t || d.startsWith(`${t}/`))
  const out = new Set<string>()
  const pf = typeof projectsFolder === 'string' && projectsFolder.startsWith('/') ? stripTrailingSlash(projectsFolder) : null
  if (pf !== null && pf !== '/') for (const d of [pf, ...foldersAbove(pf)]) if (!inOwned(d)) out.add(d)
  for (const t of owned) for (const d of foldersAbove(t)) if (!inOwned(d)) out.add(d)
  return [...out]
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

/** The per-agent permissions overlay. null = no fence (master, an agent
 *  without a folder, archived). Two groups hold whatever the territory
 *  switch says (`on` false keeps only them): (1) OTHER PROJECTS — every
 *  folder Silos knows as some agent's that is not the same project as one
 *  of this agent's (project-scope.ts), the worktrees git lists for it, and
 *  every engine's stores of it; (2) the CREDENTIALS Silos keeps. On adds
 *  the rest: Silos' other data, the engine's login and settings, other
 *  agents' state, what engines load, other roles' notes, the private paths
 *  and the tmux server. */
export function fenceFor(input: FenceInput): FenceOverlay | null {
  const { agent, agents, home, dataDir, agentStateDir } = input
  if (agent.id === 'master' || agent.folder == null || agent.archived) return null
  const on = input.on !== false
  const deny: string[] = []
  const both = (p: string): void => {
    deny.push(`Read(${abs(p)})`, `Edit(${abs(p)})`)
  }

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
  const mine = territoriesOf(agent)

  // (1) Other projects. Membership is the declared text (project-scope.ts);
  // the disk's reading (canonical) only ever leaves a folder open.
  const canon = input.canonical
  const mineCanon = canon ? mine.map(canon) : []
  const ofMine = (f: string): boolean => mine.some((m) => sameProject(m, f)) || (canon !== undefined && mineCanon.some((m) => sameProject(m, canon(f))))
  const mustReach = [...silosMustReach(home, dataDir), ...(input.mustReach ?? [])].map((r) => ({ ...r, path: strip(r.path) }))
  const at = (x: string, y: string): boolean => x === y || y.startsWith(`${x}/`)
  const holds = (f: string): { what: string } | undefined => mustReach.find((r) => at(f, r.path) || (canon !== undefined && at(canon(f), canon(r.path))))
  const candidates: string[] = []
  const add = (f: string): void => {
    const t = strip(f)
    if (t.startsWith('/') && t !== '/' && !candidates.includes(t) && !ofMine(t)) candidates.push(t)
  }
  for (const a of agents) {
    if (a.id === agent.id) continue
    for (const t of territoriesOf(a)) {
      add(t)
      for (const w of input.worktreesOf?.(t) ?? []) add(w)
    }
  }
  const projectRules: string[] = []
  const closedFolders: string[] = []
  const close = (p: string): void => {
    for (const r of [`Read(${abs(p)})`, `Edit(${abs(p)})`]) {
      deny.push(r)
      projectRules.push(r)
    }
  }
  const literalFolders: string[] = []
  for (const f of candidates) {
    const reason = globSkipReason(f)
    if (reason !== null) {
      skipped.push({ path: f, reason })
      continue
    }
    literalFolders.push(f)
    const held = holds(f)
    if (held) {
      skipped.push({ path: f, reason: `another project's folder that holds ${held.what}, which every agent must reach: it stays open` })
      continue
    }
    // a folder inside one already closed adds nothing
    if (closedFolders.some((c) => at(c, f))) continue
    closedFolders.push(f)
    close(f)
    close(`${f}/**`)
  }
  // every engine's stores of those folders, and of the conversations Silos
  // knows that started below one — closed even where the folder itself is
  // held open by a guard
  const storeFolders = [...literalFolders]
  for (const c of input.sessionCwds ?? []) {
    if (typeof c !== 'string' || globSkipReason(c) !== null) continue
    const t = strip(c)
    if (!storeFolders.includes(t) && literalFolders.some((f) => t.startsWith(`${f}/`)) && !ofMine(t)) storeFolders.push(t)
  }
  const partly = new Set<string>()
  for (const f of storeFolders) {
    for (const store of input.projectStores?.(f, mine) ?? []) {
      for (const p of store.deny) close(p)
      if (store.partly !== undefined && !partly.has(store.path)) {
        partly.add(store.path)
        skipped.push({ path: store.path, reason: store.partly })
      }
    }
  }
  // what every engine could load from a folder above a project: never
  // written by an agent, in every folder above any known agent's and in the
  // Projects folder and above it. Edit only (a file already there is the
  // owner's: read, shown in Memory). Never inside a place every agent must
  // reach (the engine's config dir is fenced file by file, below).
  if (input.loadedFromAbove) {
    for (const d of aboveProjectFolders([agent, ...agents], input.projectsFolder)) {
      const reason = globSkipReason(d)
      if (reason !== null) {
        skipped.push({ path: d, reason })
        continue
      }
      const real = canon ? canon(d) : d
      const insideReach = (p: string): boolean =>
        mustReach.some((r) => at(r.path, p) || (canon !== undefined && at(canon(r.path), `${real}${p.slice(d.length)}`)))
      for (const raw of input.loadedFromAbove(d)) {
        const p = strip(raw)
        if (!p.startsWith(`${d}/`) || insideReach(p)) continue
        deny.push(`Edit(${abs(p)})`)
      }
    }
  }

  // (2) The credentials Silos keeps, and every process's environment (it
  // carries the tokens) and command line.
  for (const f of SILOS_CREDENTIALS.files) both(`${silosDir}/${f}`)
  for (const d of SILOS_CREDENTIALS.dirs) both(`${silosDir}/${d}/**`)
  for (const p of PROC_ENVIRON_DENIED) deny.push(`Read(${abs(p)})`)
  for (const p of PROC_CMDLINE_DENIED) deny.push(`Read(${abs(p)})`)

  if (on) {
    // (a) Silos state — every top-level FILE of the data dir (token,
    // agents.json, vault.json, sessions.json…) and every top-level directory
    // but agent-state — and Claude credentials/settings.
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

    // (b) other agents' state dirs — live, archived, master, and any left on
    // disk by an agent no longer in the registry. Never one's own.
    const stateIds = new Set<string>([...agents.map((a) => a.id), ...(input.stateDirIds ?? [])])
    stateIds.delete(agent.id)
    for (const id of stateIds) {
      if (segment(id) && literal(id, `${silosDir}/agent-state/${id}`)) both(`${silosDir}/agent-state/${id}/**`)
    }

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
    // (c) the notes of the agents it knows (project-scope.ts knows), in each
    // of their folders it reaches: readable, never edited
    for (const o of agents) {
      if (o.id === agent.id || !knows(agent, o)) continue
      for (const f of territoriesOf(o)) {
        if (mine.some((m) => sameProject(m, f))) deny.push(`Edit(${abs(`${f}/context/${o.id}/**`)})`)
      }
    }

    // (d) private paths, unless the same project as one of its territories
    // (inside or around one).
    for (const raw of input.privatePaths) {
      const p = strip(expandHome(raw, home))
      if (!p.startsWith('/')) continue
      if (mine.some((t) => t === p || sameProject(t, p))) continue
      // the path itself too: a private FILE (~/.npmrc) is not matched by `/**`
      both(p)
      both(`${p}/**`)
    }

    // (e) Silos' tmux server (D8)
    deny.push(...TMUX_DENIED)
  }

  return {
    permissions: {
      deny: [...new Set(deny)],
      additionalDirectories: [...mine.slice(1), agentStateDir],
    },
    ...(skipped.length > 0 ? { skipped } : {}),
    ...(projectRules.length > 0 ? { projects: { folders: closedFolders, rules: [...new Set(projectRules)] } } : {}),
  }
}

/** The linked worktrees git lists for a folder — read from its own
 *  `.git/worktrees/<name>/gitdir` (the file `git worktree list` reads), so
 *  computing a fence runs no process. Only ever ADDS a folder to close for
 *  another project's agents; never one of theirs (fenceFor's ofMine). */
export function gitWorktreesOf(folder: string): string[] {
  const dir = join(folder, '.git', 'worktrees')
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  const out: string[] = []
  for (const n of names) {
    try {
      const g = readFileSync(join(dir, n, 'gitdir'), 'utf8').trim()
      if (g.startsWith('/')) out.push(g.replace(/\/\.git\/?$/, ''))
    } catch {
      /* a half-made or pruned worktree: nothing to close */
    }
  }
  return out
}

/** What both engines and the routes ask: an agent's fence, or null. */
export interface TerritoryAdapter {
  /** The fence its launches carry: the whole fence when its territory is
   *  on, the two always-on groups when it is off; null = none (master, no
   *  folder, archived, unknown). */
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
 *  Unknown agent → no fence; an agent whose territory is off
 *  (TerritoryStore.enabled) → the two always-on groups only; an id the state
 *  store rejects keeps the deny rules, just without its state dir. The data
 *  dir, the folders' worktrees and the conversations Silos knows are read
 *  at every call, so whatever exists at launch is fenced. */
export function makeTerritory(d: {
  registry: { get(id: string): Agent | null; list(includeArchived?: boolean): Agent[] }
  /** The agent's state dir PATH — never created here (AgentStateStore.pathFor):
   *  computing a fence is a read (Settings › Territory computes one for every
   *  fenceable agent); the launches create the dir when they write into it. */
  agentState: { pathFor(agentId: string): string }
  store: { privatePaths(): string[]; isEnabled(agentId: string): boolean }
  home: string
  dataDir: string
  /** The cwds of the conversations Silos knows (the session index). */
  sessionCwds?: () => readonly (string | null)[]
  /** The Projects folder, read at every call (FenceInput.projectsFolder). */
  projectsFolder?: () => string | null
}): TerritoryAdapter {
  const compute = (agentId: string, gated: boolean): FenceOverlay | null => {
    const agent = d.registry.get(agentId)
    if (!agent) return null
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
      on: !gated || d.store.isEnabled(agentId),
      projectStores: (folder, own) => registeredHarnesses().flatMap((h) => h.projectStores?.(folder, { home: d.home, dataDir: d.dataDir, own }) ?? []),
      worktreesOf: gitWorktreesOf,
      sessionCwds: (d.sessionCwds?.() ?? []).filter((c): c is string => typeof c === 'string'),
      canonical: canonicalFolder,
      mustReach: machineMustReach(),
      loadedFromAbove: (dir) => registeredHarnesses().flatMap((h) => h.loadedFromAbove?.(dir, d.home) ?? []),
      ...(d.projectsFolder?.() ? { projectsFolder: d.projectsFolder()! } : {}),
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
  /** `projects`: the folders of other projects (their conversations and
   *  memory closed with them) — closed whether the territory is on or off. */
  blocked: { kind: 'projects' | 'silos' | 'claude' | 'agents' | 'private'; paths: string[] }[]
  /** What the fence could not close, or closed only partly, with why
   *  (FenceOverlay.skipped) — said, never silently open. */
  open: { path: string; reason: string }[]
}

export function fenceScope(fence: FenceOverlay, territories: string[], o: { home: string; dataDir: string }): FenceScope {
  const home = strip(o.home)
  const data = strip(o.dataDir)
  const tilde = (p: string): string => (p === home ? '~' : p.startsWith(`${home}/`) ? `~${p.slice(home.length)}` : p)
  const rules = new Map<string, { read: boolean; edit: boolean }>()
  const ofProjects = new Set(fence.projects?.rules ?? [])
  for (const r of fence.permissions.deny) {
    if (ofProjects.has(r)) continue
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
  const groups = {
    projects: (fence.projects?.folders ?? []).map(tilde),
    silos: [] as string[],
    claude: [] as string[],
    agents: [] as string[],
    private: [] as string[],
  }
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
    blocked: (['projects', 'silos', 'claude', 'agents', 'private'] as const)
      .filter((k) => groups[k].length > 0)
      .map((kind) => ({ kind, paths: groups[kind].sort() })),
    open: (fence.skipped ?? []).map((u) => ({ path: tilde(u.path), reason: u.reason })),
  }
}
