// local-holds.ts — every settings FILE a launch does not read, carried into
// its flag tier for §3's keys of the scopes spec, in both directions (rule
// 14: the run loads what the screen says, and never more).
//
// An unattended turn launches with `settingSources: ['user']`, or
// `['user', 'project']` when its automation reads the project's settings —
// so the repository's `.claude/settings.json` and/or the project's local
// `.claude/settings.local.json` are never read, yet they are the project's
// place: the one Project › Tools and Skills show and switch («on here — off
// on the rest of this machine» is a first-class state). The turn must agree
// with the screen, so what those files say rides the turn's flag-tier
// `settings` (the documented Options.settings), never a write to any file —
// in the engine's own order, lowest first: the machine's file (only if a
// launch ever dropped `user`), the repository's, then the local one. A
// later file wins for an override kind; lists are joined.
//
// Only §3's keys ride, each in its known shapes; no other key of any file
// ever does (`permissions`, `hooks`, `env`, `enableAllProjectMcpServers`,
// `enabledMcpjsonServers`…):
//   · `enabledPlugins`            — booleans as written (an override kind)
//   · `skillOverrides`            — `on | name-only | user-invocable-only
//                                   | off` as written (an override kind)
//   · `disabledMcpjsonServers`    — names, joined
//   · `deniedMcpServers`          — its entries joined, one per server
//   · `claudeMdExcludes`          — its entries joined
//   · `autoMemoryEnabled`         — a boolean as written (an override
//                                   kind, spec memory-places §4); under
//                                   `onlyRemoves` only its `false`
//   · `syncClaudeAiPlugins: false`, `syncClaudeAiSkills: false`,
//     `disableClaudeAiConnectors: true` — off-only kinds: their «off» value
//     only (`syncClaudeAiSkills` never from the repository's file: the
//     engine does not read it there — loads/skills.ts)
//
// Never more:
//   · `onlyRemoves` — a heartbeat's sealed regime, with or without its
//     tools: only what removes rides (a plugin `false`, a restricting skill
//     value); an «on» would bring a plugin's skills, commands, subagent
//     types and styles into a turn sealed without them.
//   · a skill name two copies share (a personal skill and one the account
//     sends): a local entry reaches only the personal copy, an entry in the
//     flag tier reaches both (measured 23-11). So such a name is carried
//     only where its file's entry restricts, and then at the most
//     restrictive value any settings file gives that name: off >
//     user-invocable-only > name-only > on. The same rank applies to every
//     skill under `onlyRemoves`.
//   · an override value of a skipped file is not carried over a file the
//     turn DOES read at a higher precedence (the flag tier would lift it
//     above that file).
//
// A launch that STARTS in a worktree of a folder (the engine's own
// `<folder>/.claude/worktrees/<name>`) reads that worktree's local file, not
// the folder's: the folder's `claudeMdExcludes` ride too, each exact path
// under the folder also said for the worktree's root (`worktreeCarry`) —
// whatever the launch's sources.
//
// Read fresh at every launch (the config on disk is the truth); a file that
// does not parse carries nothing, exactly as the inventory reads it.
// Names are data: `__proto__` and `constructor` are entries like any other.
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { loginSkillBatch, personalSkillNames } from './loads/skills.js'
import { launchFolderOf } from './loads/launch-entries.js'

export type SkillState = 'on' | 'name-only' | 'user-invocable-only' | 'off'
const SKILL_RANK: Record<SkillState, number> = { on: 0, 'name-only': 1, 'user-invocable-only': 2, off: 3 }
const known = (v: unknown): v is SkillState => typeof v === 'string' && Object.prototype.hasOwnProperty.call(SKILL_RANK, v)
const rankOf = (v: unknown): number => (known(v) ? SKILL_RANK[v] : 0)

/** One `deniedMcpServers` entry, in the engine's three forms. */
export type DenyEntry = { serverName: string } | { serverUrl: string } | { serverCommand: string[] }

/** A settings file of the engine, by its precedence (lowest first). */
export type FileLayer = 'user' | 'project' | 'local'
const ORDER: readonly FileLayer[] = ['user', 'project', 'local']

/** What rides from the files a launch skips — §3's keys only. */
export interface FilesCarry {
  disabledMcpjsonServers?: string[]
  enabledPlugins?: Record<string, boolean>
  deniedMcpServers?: DenyEntry[]
  syncClaudeAiPlugins?: false
  syncClaudeAiSkills?: false
  disableClaudeAiConnectors?: true
  skillOverrides?: Record<string, SkillState>
  claudeMdExcludes?: string[]
  autoMemoryEnabled?: boolean
}

export interface CarryInput {
  /** the launch's settingSources: the files it reads */
  sources: readonly string[]
  /** the login's config dir (its `settings.json` is the user file); null = ~/.claude */
  configDir?: string | null
  home?: string
  /** a heartbeat: only what removes */
  onlyRemoves?: boolean
}

type Json = Record<string, unknown>
const readJson = (path: string): Json | null => {
  try {
    const raw: unknown = JSON.parse(readFileSync(path, 'utf8'))
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Json) : null
  } catch {
    return null
  }
}
const own = (o: Json | null, k: string): unknown => (o && Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined)
const has = (o: unknown, k: string): boolean => isMap(o) && Object.prototype.hasOwnProperty.call(o, k)
const isMap = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v)
/** An own data property even for `__proto__` (plain assignment would set the prototype). */
const put = (o: Json, k: string, v: unknown): void => {
  Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true })
}

function denyEntry(e: unknown): DenyEntry | null {
  if (!isMap(e)) return null
  const keys = Object.keys(e)
  if (keys.length !== 1) return null
  if (typeof e.serverName === 'string' && e.serverName !== '') return { serverName: e.serverName }
  if (typeof e.serverUrl === 'string' && e.serverUrl !== '') return { serverUrl: e.serverUrl }
  if (Array.isArray(e.serverCommand) && e.serverCommand.length > 0 && e.serverCommand.every((x) => typeof x === 'string'))
    return { serverCommand: [...(e.serverCommand as string[])] }
  return null
}
const denyKey = (e: unknown): string | null => {
  const d = denyEntry(e)
  return d === null ? null : JSON.stringify(d)
}

/** The files a launch with these sources does not read, lowest first. */
export function skippedFiles(sources: readonly string[]): FileLayer[] {
  return ORDER.filter((l) => !sources.includes(l))
}

function fileOf(layer: FileLayer, folder: string, input: CarryInput): Json | null {
  if (layer === 'user') return readJson(join(input.configDir ?? join(input.home ?? homedir(), '.claude'), 'settings.json'))
  return readJson(join(folder, '.claude', layer === 'project' ? 'settings.json' : 'settings.local.json'))
}

/** Skill names a personal skill and the login's account batch share. */
function sharedSkillNames(input: CarryInput): Set<string> {
  const home = input.home ?? homedir()
  const dir = input.configDir ?? join(home, '.claude')
  const personal = new Set(personalSkillNames(dir))
  const account = loginSkillBatch(dir, input.configDir ? join(input.configDir, '.claude.json') : join(home, '.claude.json'))?.skills.map((s) => s.name) ?? []
  return new Set(account.filter((n) => personal.has(n)))
}

/** What every file this launch skips carries into its flag tier, merged in
 *  the engine's order; {} when it reads every file or they say nothing. */
/** What a launch started in a worktree of a folder carries of that
 *  folder's local file: its `claudeMdExcludes`, an exact path under the
 *  folder said for the worktree's root too. [] anywhere else. */
export function worktreeCarry(cwd: string): string[] {
  const at = launchFolderOf(cwd)
  if (!at.worktree) return []
  const list = own(readJson(join(at.folder, '.claude', 'settings.local.json')), 'claudeMdExcludes')
  if (!Array.isArray(list)) return []
  const out: string[] = []
  const prefix = at.folder + '/'
  for (const e of list) {
    if (typeof e !== 'string' || e.trim() === '') continue
    out.push(e)
    if (e.startsWith(prefix) && !/[*?[\]{}!]/.test(e)) out.push(at.worktree + '/' + e.slice(prefix.length))
  }
  return [...new Set(out)]
}

export function filesCarry(folder: string, input: CarryInput): FilesCarry {
  const skipped = skippedFiles(input.sources)
  const worktree = worktreeCarry(folder)
  if (skipped.length === 0) return worktree.length > 0 ? { claudeMdExcludes: worktree } : {}
  const files = new Map<FileLayer, Json | null>(ORDER.map((l) => [l, fileOf(l, folder, input)]))
  const rank = (l: FileLayer): number => ORDER.indexOf(l)
  /** a file the turn reads, above `l`, that sets `name` under `key` */
  const readAbove = (l: FileLayer, key: string, name: string): boolean =>
    ORDER.some((r) => rank(r) > rank(l) && input.sources.includes(r) && has(own(files.get(r) ?? null, key), name))
  const out: Json = {}
  const mcpjson: string[] = []
  const denied: DenyEntry[] = []
  const deniedSeen = new Set<string>()
  const excludes: string[] = [...worktree]
  const plugins: Json = {}
  const skills: Json = {}
  let shared: Set<string> | null = null
  for (const l of skipped) {
    const o = files.get(l) ?? null
    if (o === null) continue
    const list = own(o, 'disabledMcpjsonServers')
    if (Array.isArray(list)) for (const n of list) if (typeof n === 'string' && n !== '') mcpjson.push(n)
    const p = own(o, 'enabledPlugins')
    if (isMap(p)) {
      for (const [k, v] of Object.entries(p)) {
        if (typeof v !== 'boolean' || (input.onlyRemoves && v) || readAbove(l, 'enabledPlugins', k)) continue
        put(plugins, k, v)
      }
    }
    const d = own(o, 'deniedMcpServers')
    if (Array.isArray(d)) {
      for (const e of d) {
        const k = denyKey(e)
        if (k === null || deniedSeen.has(k)) continue
        deniedSeen.add(k)
        denied.push(denyEntry(e)!)
      }
    }
    if (own(o, 'syncClaudeAiPlugins') === false) out.syncClaudeAiPlugins = false
    if (l !== 'project' && own(o, 'syncClaudeAiSkills') === false) out.syncClaudeAiSkills = false
    if (own(o, 'disableClaudeAiConnectors') === true) out.disableClaudeAiConnectors = true
    // auto memory: an override kind — a later file wins; never over a
    // file the turn reads above it; a heartbeat takes only «off»
    const am = own(o, 'autoMemoryEnabled')
    if (
      typeof am === 'boolean' &&
      !(input.onlyRemoves && am) &&
      !ORDER.some((r) => rank(r) > rank(l) && input.sources.includes(r) && own(files.get(r) ?? null, 'autoMemoryEnabled') !== undefined)
    )
      out.autoMemoryEnabled = am
    const ex = own(o, 'claudeMdExcludes')
    if (Array.isArray(ex)) for (const e of ex) if (typeof e === 'string' && e.trim() !== '') excludes.push(e)
    const s = own(o, 'skillOverrides')
    if (isMap(s)) {
      for (const [name, v] of Object.entries(s)) {
        if (!known(v) || readAbove(l, 'skillOverrides', name)) continue
        shared ??= sharedSkillNames(input)
        if (input.onlyRemoves || shared.has(name)) {
          // only where it restricts, at the most restrictive of the files
          if (rankOf(v) === 0) continue
          let best: SkillState = v
          for (const f of files.values()) {
            const theirs = own(isMap(own(f, 'skillOverrides')) ? (own(f, 'skillOverrides') as Json) : null, name)
            if (rankOf(theirs) > rankOf(best)) best = theirs as SkillState
          }
          if (rankOf(best) > rankOf(own(skills, name))) put(skills, name, best)
        } else {
          put(skills, name, v)
        }
      }
    }
  }
  if (mcpjson.length > 0) out.disabledMcpjsonServers = [...new Set(mcpjson)]
  if (Object.keys(plugins).length > 0) out.enabledPlugins = plugins
  if (denied.length > 0) out.deniedMcpServers = denied
  if (excludes.length > 0) out.claudeMdExcludes = [...new Set(excludes)]
  if (Object.keys(skills).length > 0) out.skillOverrides = skills
  return out as FilesCarry
}

/** The carry merged into a launch's flag-tier settings, after what it
 *  already carried (its style, hooks off): lists are joined, an override
 *  kind takes the file's value — under `onlyRemoves` a skill keeps the more
 *  restrictive state and nothing is turned on. Every key the launch carried
 *  is kept (the fence's `permissions` among them); an empty carry leaves
 *  `settings` exactly as it was. */
export function withFilesCarried(settings: Record<string, unknown>, carry: FilesCarry, opts: { onlyRemoves?: boolean } = {}): Record<string, unknown> {
  if (Object.keys(carry).length === 0) return settings
  const out = { ...settings }
  if (carry.disabledMcpjsonServers) {
    const prior = Array.isArray(out.disabledMcpjsonServers) ? (out.disabledMcpjsonServers as unknown[]) : []
    out.disabledMcpjsonServers = [...new Set([...prior, ...carry.disabledMcpjsonServers])]
  }
  if (carry.enabledPlugins) {
    const merged: Json = {}
    if (isMap(out.enabledPlugins)) for (const [k, v] of Object.entries(out.enabledPlugins)) put(merged, k, v)
    for (const [k, v] of Object.entries(carry.enabledPlugins)) if (!(opts.onlyRemoves && v)) put(merged, k, v)
    out.enabledPlugins = merged
  }
  if (carry.deniedMcpServers) {
    const prior = Array.isArray(out.deniedMcpServers) ? (out.deniedMcpServers as unknown[]) : []
    const seen = new Set(prior.map(denyKey).filter((k): k is string => k !== null))
    const joined = [...prior]
    for (const e of carry.deniedMcpServers) {
      const k = JSON.stringify(e)
      if (seen.has(k)) continue
      seen.add(k)
      joined.push(e)
    }
    out.deniedMcpServers = joined
  }
  if (carry.syncClaudeAiPlugins === false) out.syncClaudeAiPlugins = false
  if (carry.syncClaudeAiSkills === false) out.syncClaudeAiSkills = false
  if (carry.disableClaudeAiConnectors === true) out.disableClaudeAiConnectors = true
  if (carry.claudeMdExcludes) {
    const prior = Array.isArray(out.claudeMdExcludes) ? (out.claudeMdExcludes as unknown[]) : []
    out.claudeMdExcludes = [...new Set([...prior, ...carry.claudeMdExcludes])]
  }
  if (typeof carry.autoMemoryEnabled === 'boolean' && !(opts.onlyRemoves && carry.autoMemoryEnabled)) out.autoMemoryEnabled = carry.autoMemoryEnabled
  if (carry.skillOverrides) {
    const merged: Json = {}
    if (isMap(out.skillOverrides)) for (const [k, v] of Object.entries(out.skillOverrides)) put(merged, k, v)
    for (const [k, v] of Object.entries(carry.skillOverrides)) {
      if (opts.onlyRemoves && Object.prototype.hasOwnProperty.call(merged, k) && rankOf(merged[k]) >= rankOf(v)) continue
      put(merged, k, v)
    }
    out.skillOverrides = merged
  }
  return out
}
