// harnesses/claude-code/loaded-at-start — what every Claude Code session of
// an agent receives before its first message, read from disk (Knows & can ›
// Loaded at start). Observed, never executed, never written:
//
//  · instruction files beyond the memory layers Silos already shows (global
//    ~/.claude/CLAUDE.md and <folder>/CLAUDE.md): CLAUDE.local.md and
//    .claude/CLAUDE.md in the folder, CLAUDE.md / CLAUDE.local.md in every
//    parent directory up to /, .claude/rules/*.md, CLAUDE.md in
//    SUBFOLDERS (Claude Code reads those on demand, when the session works in
//    that subtree) and every `@path` import any of them names (up to five
//    hops, the engine's own limit) — imports listed only when the file
//    exists, so prose like "@finance" never reads as an import;
//  · SessionStart hooks: the operator's settings, the folder's
//    .claude/settings*.json, managed settings, and every ENABLED plugin's
//    hooks/hooks.json (installed_plugins.json names the live version, as the
//    claude-plugins graph silo reads it). Silos' own briefing is named as
//    Silos'. What a hook really added is read from the agent's newest
//    transcripts (`hook_success` records keep the hook's stdout) — a size and
//    an excerpt, never a guess; a command two hooks share is attributed to
//    neither;
//  · the output style (`outputStyle`), and a plugin standing in for one;
//  · MCP servers: the folder's INVENTORY (loads/inventory.ts — the one list
//    of what a folder loads, with every settings layer and its readings),
//    the rows that load on the agent's login: ~/.claude.json (the
//    operator's, read-only — invariant 3), the folder's .mcp.json, enabled
//    plugins' servers (an installed plugin's, or the Claude account's;
//    placeholders and servers sharing an address said as such), and
//    claude.ai connectors as read or seen (they are not on disk); then the
//    agent's own (agent-tools.ts).
//
// Which plugins load is asked of the ONE resolver (plugin-enablement.ts):
// a plugin no settings file mentions loads, as the engine loads it.
//
// Bounded: subfolder walk depth 6, 2000 directories, 60 files; symlinked
// directories are never followed (no loops); dot-entries and node_modules
// skipped; a transcript is read only in its first 256 KB.
import { readFileSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { LoadedAtStart, LoadedAtStartInput, LoadedInjection, LoadedInstruction, LoadedMcp, LoadsInventory } from '../contract.js'
import { claudeLoadsInventory } from './loads/inventory.js'
import { scanInstructions, type Scan } from './instructions.js'
import { startLogin, transcriptHead } from './loads/start-logins.js'

// shared with the inventory (loads/start-logins.ts holds them: no import cycle)
export { startLogin, startLogins } from './loads/start-logins.js'
import { OUTPUT_STYLE_PLUGINS } from './output-styles.js'
import { pluginResolver } from '../../plugin-enablement.js'
import { ownMcpServerNames } from '../../role-plugin.js'
import { matchBatches, readAccountBatches } from './loads/account-batches.js'

// the instruction files are Harness.instructions' scan (instructions.ts), projected
export { IMPORT_MAX_HOPS, SUBFOLDER_DEPTH, SUBFOLDER_MAX_DIRS, SUBFOLDER_MAX_FILES, parseImports, resolveImport } from './instructions.js'
const EXCERPT_CHARS = 160

type Json = Record<string, unknown>

function asObject(v: unknown): Json | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Json) : null
}

function readJson(path: string): Json | null {
  try {
    return asObject(JSON.parse(readFileSync(path, 'utf8')))
  } catch {
    return null
  }
}

/** A SessionStart matcher in words: "startup|clear" → ['startup', 'clear'];
 *  absent, empty or '*' → [] (fires on every start). */
export function matcherWords(matcher: unknown): string[] {
  if (typeof matcher !== 'string') return []
  const t = matcher.trim()
  if (t === '' || t === '*') return []
  return t
    .split('|')
    .map((w) => w.trim())
    .filter((w) => w !== '')
}

/** The SessionStart hooks one hooks map declares: one per inner hook, its
 *  command as the transcript records it (command, then args, space-joined). */
export function sessionStartHooks(hooksMap: unknown): { on: string[]; command: string }[] {
  const entries = asObject(hooksMap)?.SessionStart
  if (!Array.isArray(entries)) return []
  const out: { on: string[]; command: string }[] = []
  for (const entry of entries) {
    const e = asObject(entry)
    if (!e || !Array.isArray(e.hooks)) continue
    const on = matcherWords(e.matcher)
    for (const h of e.hooks) {
      const hook = asObject(h)
      if (!hook) continue
      if (typeof hook.command === 'string') {
        const args = Array.isArray(hook.args) ? hook.args.filter((a): a is string => typeof a === 'string') : []
        out.push({ on, command: [hook.command, ...args].join(' ') })
      } else if (typeof hook.type === 'string') {
        out.push({ on, command: `(${hook.type} hook)` })
      }
    }
  }
  return out
}

/** What a hook's stdout adds to the context: hookSpecificOutput.additionalContext
 *  when the stdout is that JSON, else the plain stdout itself. */
export function injectedText(stdout: string): string {
  const t = stdout.trim()
  if (t.startsWith('{')) {
    try {
      const parsed = asObject(JSON.parse(t))
      const ctx = asObject(parsed?.hookSpecificOutput)?.additionalContext
      return typeof ctx === 'string' ? ctx : ''
    } catch {
      /* not JSON: plain text */
    }
  }
  return t
}

function excerptOf(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > EXCERPT_CHARS ? `${flat.slice(0, EXCERPT_CHARS - 1)}…` : flat
}

export type Observed = NonNullable<LoadedInjection['seen']>

/** The SessionStart runs a transcript's lines record, by command — the last
 *  record of each command wins (a /clear after the startup). */
export function observedStarts(lines: string[]): Map<string, Observed> {
  const out = new Map<string, Observed>()
  for (const line of lines) {
    if (!line.includes('SessionStart')) continue
    let r: Json | null
    try {
      r = asObject(JSON.parse(line))
    } catch {
      continue
    }
    const a = asObject(r?.attachment)
    if (!a || a.hookEvent !== 'SessionStart' || typeof a.command !== 'string') continue
    if (a.type !== 'hook_success' && a.type !== 'hook_error' && a.type !== 'hook_non_blocking_error') continue
    const ts = typeof r?.timestamp === 'string' ? Date.parse(r.timestamp) : NaN
    const text = a.type === 'hook_success' && typeof a.stdout === 'string' ? injectedText(a.stdout) : ''
    const exit = Number(a.exitCode ?? 0)
    const failed = a.type !== 'hook_success' || (Number.isFinite(exit) && exit !== 0)
    out.set(a.command, {
      chars: text.length,
      excerpt: excerptOf(text),
      at: Number.isFinite(ts) ? ts : 0,
      ...(failed ? { failed: true as const } : {}),
    })
  }
  return out
}

// --------------------------------------------------------------- the reader

const LEGACY_RANK: Record<LoadedInstruction['kind'], number> = { local: 0, project: 1, parent: 2, global: 3, rules: 4, subfolder: 5, import: 6, silos: 7 }

/** The scan's files as At start lists them: beyond the two Memory layers
 *  (the machine's CLAUDE.md, the folder's CLAUDE.md), without the
 *  organization's or auto memory; nearest folder above first. */
export function loadedInstructions(scan: Scan, folder: string, name: (p: string) => string): LoadedInstruction[] {
  const out: { rank: number; depth: number; i: number; item: LoadedInstruction }[] = []
  scan.found.forEach((f, i) => {
    let kind: LoadedInstruction['kind']
    switch (f.kind) {
      case 'private':
        kind = 'local'
        break
      case 'project':
        if (f.path === join(folder, 'CLAUDE.md')) return
        kind = 'project'
        break
      case 'agents':
        kind = f.through === 'import' ? 'import' : 'project'
        break
      case 'above':
        kind = 'parent'
        break
      case 'personal-rule':
        kind = 'global'
        break
      case 'project-rule':
        kind = 'rules'
        break
      case 'subfolder':
        kind = 'subfolder'
        break
      case 'import':
        kind = 'import'
        break
      default:
        return
    }
    let bytes = 0
    try {
      bytes = statSync(f.path).size
    } catch {
      return
    }
    const under = f.when.under ?? f.paths
    out.push({
      rank: LEGACY_RANK[kind],
      depth: f.above?.depth ?? 0,
      i,
      item: {
        path: f.path,
        rel: name(f.path),
        kind,
        when: f.when.at,
        ...(under ? { under } : {}),
        ...(f.importedBy ? { importedBy: name(f.importedBy) } : {}),
        bytes,
      },
    })
  })
  return out.sort((a, b) => a.rank - b.rank || a.depth - b.depth || a.i - b.i).map((x) => x.item)
}

export function silosPluginDir(): string {
  return fileURLToPath(new URL('../../../../plugin', import.meta.url))
}

export interface ClaudeLoadedPaths {
  /** ~/.claude — settings.json, CLAUDE.md, plugins/ */
  claudeDir?: string
  /** ~/.claude.json */
  claudeJson?: string
  managedSettings?: string
  silosPlugin?: string
}

const shown = (path: string, folder: string, home: string): string => {
  const r = relative(folder, path)
  if (r !== '' && !r.startsWith('..') && !isAbsolute(r)) return r
  const h = relative(home, path)
  if (h !== '' && !h.startsWith('..') && !isAbsolute(h)) return `~/${h}`
  return path
}

/** Rank of a server in the list: the operator's, the folder's, plugins', the account's. */
const MCP_RANK: Record<string, number> = { user: 0, 'user-folder': 1, project: 2, plugin: 3, account: 4 }

/** The inventory's MCP servers and connectors that load (on, not standing
 *  aside for another copy), as Loaded at start lists them. An account's row
 *  loads only on its login: the agent's (`login`, its starts' email) when
 *  known; a batch no start matched only when it is the only one (the login
 *  is then the only one there is). A row Silos can't place is left out. */
export function mcpOfInventory(inv: Pick<LoadsInventory, 'rows' | 'logins'>, login: string | null): LoadedMcp[] {
  const byKey = new Map(inv.rows.map((r) => [r.key, r]))
  const onlyBatch = inv.logins.length === 1
  const out: { rank: number; m: LoadedMcp }[] = []
  for (const r of inv.rows) {
    if (r.kind === 'plugin' || r.state !== 'active' || r.replacedBy) continue
    const parent = r.parent ? byKey.get(r.parent) : undefined
    if (parent && (parent.state !== 'active' || parent.replacedBy)) continue
    const account = r.origin.owner === 'account'
    if (account && r.origin.unmatched && !onlyBatch) continue
    if (account && login !== null && r.origin.login != null && r.origin.login !== login) continue
    const accountOf = account && r.kind !== 'connector' ? { account: { login: r.origin.unmatched ? null : (r.origin.login ?? null) } } : {}
    if (parent) {
      const first = r.sameAs ? byKey.get(r.sameAs)?.name : undefined
      out.push({
        rank: MCP_RANK.plugin!,
        m: {
          name: r.label,
          source: 'plugin',
          from: parent.label,
          engineName: r.name,
          ...accountOf,
          ...(r.placeholder ? { placeholder: true as const } : {}),
          ...(first ? { sameAs: first } : {}),
        },
      })
    } else if (r.kind === 'connector') {
      out.push({ rank: MCP_RANK.account!, m: { name: r.name, source: 'account', from: 'claude.ai' } })
    } else if (r.origin.owner === 'project') {
      out.push({ rank: MCP_RANK.project!, m: { name: r.name, source: 'project', from: r.origin.carrier } })
    } else if (r.origin.owner === 'you') {
      out.push({
        rank: r.key.startsWith('mcp:local:') ? MCP_RANK['user-folder']! : MCP_RANK.user!,
        m: { name: r.name, source: 'user', from: r.origin.carrier },
      })
    }
  }
  return out
    .map((x, i) => ({ ...x, i }))
    .sort((a, b) => a.rank - b.rank || a.i - b.i)
    .map((x) => x.m)
}

export function readClaudeLoadedAtStart(input: LoadedAtStartInput, paths: ClaudeLoadedPaths = {}): LoadedAtStart {
  const { folder, home } = input
  const claudeDir = paths.claudeDir ?? join(home, '.claude')
  const managedPath = paths.managedSettings ?? '/etc/claude-code/managed-settings.json'
  const silosDir = paths.silosPlugin ?? silosPluginDir()
  const notes: string[] = []
  const name = (p: string): string => shown(p, folder, home)

  // ---- settings layers (low → high precedence for scalar keys)
  const layers: { origin: 'user' | 'project' | 'local' | 'managed'; path: string; json: Json | null }[] = [
    { origin: 'user', path: join(claudeDir, 'settings.json'), json: null },
    { origin: 'project', path: join(folder, '.claude', 'settings.json'), json: null },
    { origin: 'local', path: join(folder, '.claude', 'settings.local.json'), json: null },
    { origin: 'managed', path: managedPath, json: null },
  ]
  for (const l of layers) l.json = readJson(l.path)

  // ---- instructions: the ONE scan (Harness.instructions, instructions.ts),
  // projected onto At start's list — the files beyond the Memory layers it
  // already shows (the machine's and the folder's CLAUDE.md), the
  // organization's and auto memory left to Memory
  const scan = scanInstructions({ folder, home, loginDirs: [claudeDir], managedDir: dirname(managedPath) })
  const instructions = loadedInstructions(scan, folder, name)
  notes.push(...scan.notes)

  // ---- plugins: the machine's installed ones (live version) and the ones
  // the Claude account sends, each asked of the ONE resolver
  // (plugin-enablement.ts): an explicit entry by precedence, else the
  // manifest's defaultEnabled, else ON — a plugin no file mentions loads
  const installedFile = join(claudeDir, 'plugins', 'installed_plugins.json')
  const installed = asObject(readJson(installedFile)?.plugins) ?? {}
  const login = startLogin(input.recentTranscripts)
  const batches = readAccountBatches(join(claudeDir, 'plugins', 'synced'))
  const matches = matchBatches(batches, [{ key: 'start', accountUuid: login?.accountUuid ?? null }])
  const sent = batches.flatMap((b, i) => (matches[i] ? b.plugins : []))
  const resolver = pluginResolver(
    folder,
    { userSettingsPath: join(claudeDir, 'settings.json'), installedPluginsPath: installedFile, managedDir: dirname(managedPath) },
    new Map(sent.map((p) => [p.id, p.dir])),
  )
  const plugins: { key: string; name: string; dir: string; manifest: Json | null; account?: { login: string | null } }[] = []
  for (const key of Object.keys(installed).sort()) {
    if (!resolver.resolve(key).enabled) continue
    const entries = Array.isArray(installed[key]) ? (installed[key] as unknown[]).map(asObject).filter((e): e is Json => e !== null) : []
    const entry = entries.find((e) => e.projectPath === folder) ?? entries.find((e) => typeof e.projectPath !== 'string') ?? entries[0]
    const dir = entry?.installPath
    if (typeof dir !== 'string') continue
    plugins.push({ key, name: key.split('@')[0]!, dir, manifest: readJson(join(dir, '.claude-plugin', 'plugin.json')) })
  }
  // «a plugin you installed with the same name takes precedence» (the
  // engine's schema): an account copy loads only where no installed copy of
  // its name is on
  const onByName = new Set(plugins.map((p) => p.name))
  for (const p of sent) {
    if (!resolver.resolve(p.id).enabled || onByName.has(p.name)) continue
    plugins.push({
      key: p.id,
      name: p.name,
      dir: p.dir,
      manifest: readJson(join(p.dir, '.claude-plugin', 'plugin.json')),
      account: { login: login?.email ?? null },
    })
  }
  const accountOff = resolver.layers.accountPluginsOff
  if (accountOff && batches.some((b) => b.plugins.length > 0)) {
    notes.push(
      `Plugins your Claude account sends are off here — syncClaudeAiPlugins in ${accountOff === 'managed' ? 'managed settings' : accountOff === 'local' ? '.claude/settings.local.json' : '~/.claude/settings.json'}.`,
    )
  }
  const unmatched = batches.filter((b, i) => !matches[i] && b.plugins.length > 0).length
  if (unmatched > 0 && !accountOff) {
    notes.push(
      `${unmatched === 1 ? 'One Claude login' : `${unmatched} Claude logins`} Silos can't match yet ${unmatched === 1 ? 'sends' : 'send'} plugins — not listed until a conversation here records its login.`,
    )
  }

  // ---- injections
  const injections: LoadedInjection[] = []
  const disableAll = layers.some((l) => l.json?.disableAllHooks === true)
  if (disableAll) {
    notes.push('disableAllHooks is set — no start hook runs.')
  } else {
    const isSilos = (command: string): boolean => command.includes(`${silosDir}/hooks/`) || /\/plugin\/hooks\/session-start\.sh\b/.test(command)
    for (const l of layers) {
      if (!l.json) continue
      for (const h of sessionStartHooks(l.json.hooks)) {
        const silos = isSilos(h.command)
        injections.push({ origin: silos ? 'silos' : l.origin, name: silos ? 'Silos briefing' : name(l.path), on: h.on, command: h.command, file: l.path })
      }
    }
    for (const p of plugins) {
      // the manifest may point its hooks elsewhere, or inline them
      const declared = p.manifest?.hooks
      const file = typeof declared === 'string' ? resolve(p.dir, declared) : join(p.dir, 'hooks', 'hooks.json')
      const map = asObject(declared) ? (asObject(declared)!.hooks ?? declared) : readJson(file)?.hooks
      const silos = p.name === 'silos' && !p.account
      for (const h of sessionStartHooks(map)) {
        injections.push({
          origin: silos ? 'silos' : 'plugin',
          name: silos ? 'Silos briefing' : p.name,
          on: h.on,
          command: h.command,
          file: asObject(declared) ? join(p.dir, '.claude-plugin', 'plugin.json') : file,
          ...(p.account ? { account: p.account } : {}),
          ...(/-output-style$/.test(p.name) ? { outputStyle: true as const } : {}),
        })
      }
    }
    // what each one added, from the newest transcript that recorded it —
    // a command two hooks share can't be told apart: attributed to neither
    const shared = new Set<string>()
    const seenCommands = new Set<string>()
    for (const i of injections) (seenCommands.has(i.command) ? shared : seenCommands).add(i.command)
    const pending = new Set(injections.map((i) => i.command).filter((c) => !shared.has(c)))
    let starts = 0 // transcripts whose start recorded any start hook
    for (const t of input.recentTranscripts) {
      if (pending.size === 0) break
      const obs = observedStarts(transcriptHead(t))
      if (obs.size > 0) starts++
      for (const i of injections) {
        if (!pending.has(i.command) || i.seen) continue
        const o = obs.get(i.command)
        if (o) i.seen = o
      }
      for (const c of [...pending]) if (obs.has(c)) pending.delete(c)
    }
    // read every start and still absent: it ran and printed nothing (only a
    // hook that fires on a fresh start — one on resume/compact just didn't fire)
    if (starts > 0) {
      for (const i of injections) {
        if (i.seen || !pending.has(i.command)) continue
        if (i.on.length === 0 || i.on.includes('startup')) i.unseenIn = starts
      }
    }
  }

  // automation runs and message turns start isolated (resident.ts: hooks off
  // unless the automation inherits them) — said, so "every session" stays true
  if (injections.length > 0) notes.push('Automation runs start without these hooks, unless an automation is set to inherit them.')

  // ---- output style (highest layer that sets one)
  let outputStyle: LoadedAtStart['outputStyle'] = null
  for (const l of layers) {
    const v = l.json?.outputStyle
    if (typeof v === 'string' && v.trim() !== '') outputStyle = { name: v, from: name(l.path) }
  }
  // the agent's cockpit style outranks the files for every conversation
  // Silos starts (output-styles.ts outputStyleSettings: native outputStyle +
  // the style plugins off per process) — said as such, never as the files' word
  const cockpit = typeof input.agent.outputStyle === 'string' && input.agent.outputStyle.trim() !== '' ? input.agent.outputStyle.trim() : null
  if (cockpit) {
    outputStyle = { name: cockpit, from: "Silos — the agent's default", silos: true }
    for (const i of injections)
      if (i.outputStyle && i.origin === 'plugin' && OUTPUT_STYLE_PLUGINS.some((id) => id.split('@')[0] === i.name)) i.offBySilos = true
  }

  // ---- MCP servers: the folder's inventory (loads/inventory.ts — the ONE
  // list of what a folder loads; the server hands it in as it read it, with
  // its readings), the ones that load here on this agent's login; then its
  // own servers (agent-tools.ts), which the inventory never lists
  const mcp: LoadedMcp[] = []
  if (input.agentStateDir !== null) for (const n of ownMcpServerNames(input.agentStateDir)) mcp.push({ name: n, source: 'agent', from: input.agent.id })
  const inventory =
    input.loads ??
    claudeLoadsInventory({
      folder,
      home,
      managedDir: dirname(managedPath),
      recentTranscripts: input.recentTranscripts,
      seenToolIds: input.seenMcpServers,
      readings: [],
    })
  mcp.push(...mcpOfInventory(inventory, login?.email ?? null))
  notes.push("claude.ai account connectors aren't on disk — listed only when its conversations used one.")

  return { engine: 'Claude Code', folder, instructions, injections, outputStyle, mcp, toolsDoor: true, notes }
}
