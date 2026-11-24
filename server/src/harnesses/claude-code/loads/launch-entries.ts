// harnesses/claude-code/loads/launch-entries.ts — what Silos keeps for
// Claude Code's LAUNCH places (an agent; a conversation, T5) and how it rides
// a launch (spec scopes §3, §6).
//
// A payload is a settings fragment the engine reads from its flag tier
// (`--settings` / SDK `Options.settings`) — the SAME object the territory
// fence rides. So a payload is never trusted whole: `cleanEntries` is the
// allowlist, key by key and shape by shape, applied at a switch (on the way
// in) AND at every launch (on the way out); everything else is dropped:
//
//   · `enabledPlugins`          — `{"<id>": true | false}`, booleans only
//   · `deniedMcpServers`        — `{"serverName": "<name>"}` entries only
//   · `disabledMcpjsonServers`  — names
//   · `skillOverrides`          — `"off" | "name-only" | "on"`
//   · `syncClaudeAiPlugins: false`, `syncClaudeAiSkills: false`,
//     `disableClaudeAiConnectors: true` — only their «off» value
//   · `personalInstructions: "off"` — the CHOICE (spec scopes §3, §6, T10),
//     never a path: it is not an engine key and never rides as itself. At
//     each launch it becomes `claudeMdExcludes` with the exact entries of
//     EVERY login dir known then (`personalEntries`), so a login added
//     after the click is covered. A `claudeMdExcludes` in a payload is
//     dropped: the only paths a launch place can exclude are those.
//   · `instructionsOff` — ONE instruction file off at this place (spec
//     memory-places §4, T4): the CHOICE, never a login path —
//     `{personal: "<path under a login dir>"}` (a login's CLAUDE.md or a
//     file under its rules/) or `{in: "<folder>", file: "<path under it>"}`.
//     An entry survives, in and out, only when its path is relative,
//     normalized, without `..` or a glob character, and names one of the
//     files the engine loads (§2); `in` must be exactly one of the
//     context's `folders` (the agent's). Without that context
//     (`cleanEntries(payload)`) every instruction entry is dropped. At a
//     launch an entry becomes `claudeMdExcludes` — a personal one for every
//     login dir known then, a folder's for the folder the launch starts in
//     and, when it starts in a worktree of it, that worktree's root too.
//     A write of ANOTHER entry keeps them as found (`keptEntries`, by shape).
//     One more shape (spec memory-places T5, the T4 open question): `{in:
//     "<folder>", above: "<absolute path>"}` — a file in a FOLDER ABOVE
//     the folder, the one file outside both the folder and every login dir
//     a launch place may name. It is admitted only as the scan lists such a
//     file (instructions.ts «every folder above»): absolute and normalized
//     (never `..`, never a glob), in a strict ancestor of `in` other than
//     `/`, under one of the names the engine reads there (`CLAUDE.md`,
//     `CLAUDE.local.md`, `AGENTS.md`, `.claude/CLAUDE.md`,
//     `.claude/rules/**.md`), never under a login dir — and judged again at
//     every launch against the folder it starts in, riding only while the
//     file is there. An IMPORT from outside the folder stays the project's
//     line alone: what makes it load is another file's text, which a launch
//     would have to read again to judge.
//   · `autoMemoryEnabled` — a boolean (an override kind); a heartbeat
//     (`onlyRemoves`) takes only its `false`.
//
// `permissions`, `hooks`, `env` or any other key changes nothing: the fence
// is never touched by the overlay (it is a key the allowlist never lets in).
//
// The overlay (`withLaunchEntries`), in order, later wins for an override
// kind (a plugin, a skill), lists are joined: what the launch already
// carried (the style, hooks off, an unattended turn's holds), then each
// payload — the agent's, then (T5) the conversation's. `onlyRemoves` (a
// heartbeat's sealed regime, rule 14): only what removes rides — no plugin
// «on», no skill lifted.
//
// Names are data: `__proto__` and `constructor` are entries like any other.
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, posix, resolve } from 'node:path'

type Json = Record<string, unknown>

const isMap = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v)
const own = (o: Json, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k)
/** An own data property even for `__proto__` (plain assignment would set the prototype). */
const put = (o: Json, k: string, v: unknown): void => {
  Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true })
}

export type SkillPosition = 'off' | 'name-only' | 'on'
const SKILL_POSITIONS: readonly string[] = ['off', 'name-only', 'on']
const SKILL_RANK: Record<string, number> = { on: 0, 'name-only': 1, 'user-invocable-only': 2, off: 3 }
const rankOf = (v: unknown): number => (typeof v === 'string' && own(SKILL_RANK, v) ? SKILL_RANK[v]! : 0)

/** The fragment a launch place keeps: §3's keys only. */
export interface LaunchEntries {
  enabledPlugins?: Record<string, boolean>
  deniedMcpServers?: { serverName: string }[]
  disabledMcpjsonServers?: string[]
  skillOverrides?: Record<string, SkillPosition>
  syncClaudeAiPlugins?: false
  syncClaudeAiSkills?: false
  disableClaudeAiConnectors?: true
  /** your personal instructions off at this place: the choice, never a path */
  personalInstructions?: 'off'
  /** single instruction files off at this place: the choice, never a login path */
  instructionsOff?: InstructionEntry[]
  /** auto memory at this place (an override kind) */
  autoMemoryEnabled?: boolean
}

/** One instruction file a launch place keeps out: a personal file by its
 *  path under a login dir, or a folder's file by its path under the folder. */
export type InstructionEntry = { personal: string } | { in: string; file: string } | { in: string; above: string }

/** What an instruction entry is judged against (spec memory-places §4):
 *  every login dir known now, and the folders the place may name (an
 *  agent's own). */
export interface EntryContext {
  loginDirs: readonly string[]
  folders: readonly string[]
}

/** The launch place's key for single instruction files. */
export const INSTRUCTIONS_KEY = 'instructionsOff'

const GLOB_CHARS = /[*?[\]{}!\\#]/
const plainPart = (p: string): boolean => p !== '' && !p.startsWith('.') && p !== 'node_modules'

/** A path relative to its root as an entry may carry it: relative,
 *  normalized, no `..`, no glob character (an entry is a path, never a
 *  pattern), no empty or dot segment. */
function relOk(rel: unknown): rel is string {
  if (typeof rel !== 'string' || rel === '' || rel.length > 512 || rel.includes('\0')) return false
  if (rel.startsWith('/') || isAbsolute(rel) || GLOB_CHARS.test(rel)) return false
  if (posix.normalize(rel) !== rel) return false
  return rel.split('/').every((p) => p !== '' && p !== '.' && p !== '..')
}

/** A file under a login dir the engine loads: its CLAUDE.md, or a `.md`
 *  under its rules/ (§2 «Personal», «Personal rule»). */
export function personalFileOk(rel: unknown): rel is string {
  if (!relOk(rel)) return false
  if (rel === 'CLAUDE.md') return true
  const parts = rel.split('/')
  return parts[0] === 'rules' && parts.length >= 2 && rel.endsWith('.md') && parts.slice(1).every(plainPart)
}

/** A file under a folder the engine loads (§2): `CLAUDE.md`,
 *  `CLAUDE.local.md`, `AGENTS.md`, an import (a `.md`), each in the folder
 *  or a subfolder; `.claude/CLAUDE.md` and `.claude/rules/**.md` beside
 *  them. Never inside another dot folder (`.git`, a worktree) nor
 *  `node_modules`. */
export function folderFileOk(rel: unknown): rel is string {
  if (!relOk(rel) || !rel.endsWith('.md')) return false
  const parts = rel.split('/')
  const dot = parts.findIndex((p) => !plainPart(p))
  if (dot === -1) return true
  if (parts[dot] !== '.claude') return false
  const rest = parts.slice(dot + 1)
  return (rest.length === 1 && rest[0] === 'CLAUDE.md') || (rest[0] === 'rules' && rest.length >= 2 && rest.slice(1).every(plainPart))
}

const folderOk = (f: unknown): f is string => typeof f === 'string' && f.length <= 4096 && isAbsolute(f) && resolve(f) === f

/** The folder above a file lies in, when the file is one the engine reads
 *  in a folder above (§2 «Folder above»): `<D>/CLAUDE.md`,
 *  `<D>/CLAUDE.local.md`, `<D>/AGENTS.md`, `<D>/.claude/CLAUDE.md`,
 *  `<D>/.claude/rules/**.md`. null: any other path, a relative one, one
 *  with `..`, a glob character or an empty or dot segment. */
export function aboveDirOf(path: unknown): string | null {
  if (!folderOk(path) || path.length > 4096 || path.includes('\0') || GLOB_CHARS.test(path) || posix.normalize(path) !== path) return null
  const parts = path.split('/').slice(1)
  if (parts.some((p) => p === '' || p === '.' || p === '..')) return null
  const name = parts[parts.length - 1]!
  const up = (n: number): string => `/${parts.slice(0, parts.length - n).join('/')}`
  if (parts.length >= 2 && (name === 'CLAUDE.md' || name === 'CLAUDE.local.md' || name === 'AGENTS.md') && parts[parts.length - 2] !== '.claude') return up(1)
  if (parts.length >= 3 && name === 'CLAUDE.md' && parts[parts.length - 2] === '.claude') return up(2)
  const at = parts.indexOf('.claude')
  if (at >= 1 && parts[at + 1] === 'rules' && parts.length >= at + 3 && name.endsWith('.md') && parts.slice(at + 2).every(plainPart))
    return `/${parts.slice(0, at).join('/')}`
  return null
}

/** A file in a folder above `folder` that a launch place may keep out:
 *  its folder a strict ancestor of `folder` (never `/`), never under a
 *  login dir. */
export function aboveFileOk(path: unknown, folder: string, loginDirs: readonly string[]): path is string {
  const dir = aboveDirOf(path)
  if (dir === null || dir === '/' || dir === folder || !folder.startsWith(`${dir}/`)) return false
  return !loginDirs.some((d) => {
    const r = resolve(d)
    return (path as string).startsWith(`${r}/`)
  })
}

/** The instruction entries of a payload that pass: by context, or (`keep`)
 *  by shape alone — what a write of ANOTHER entry keeps as it found it. */
function instructionEntries(raw: unknown, ctx: EntryContext | 'keep'): InstructionEntry[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const out: InstructionEntry[] = []
  for (const e of raw as unknown[]) {
    if (!isMap(e)) continue
    let entry: InstructionEntry | null = null
    const keys = Object.keys(e)
    if (keys.length === 1 && own(e, 'personal') && personalFileOk(e.personal)) entry = { personal: e.personal }
    else if (keys.length === 2 && own(e, 'in') && own(e, 'file') && folderOk(e.in) && folderFileOk(e.file) && (ctx === 'keep' || ctx.folders.includes(e.in)))
      entry = { in: e.in, file: e.file }
    else if (
      keys.length === 2 &&
      own(e, 'in') &&
      own(e, 'above') &&
      folderOk(e.in) &&
      (ctx === 'keep' ? aboveDirOf(e.above) !== null : ctx.folders.includes(e.in) && aboveFileOk(e.above, e.in, ctx.loginDirs))
    )
      entry = { in: e.in, above: e.above as string }
    if (!entry) continue
    const k = JSON.stringify(entry)
    if (seen.has(k)) continue
    seen.add(k)
    out.push(entry)
  }
  return out
}

/** The folder a launch starting in `cwd` reads its project files for, and
 *  its own root when that is a worktree of it (the engine's own worktree
 *  folder, `<folder>/.claude/worktrees/<name>`). */
export function launchFolderOf(cwd: string): { folder: string; worktree?: string } {
  const c = resolve(cwd)
  const m = /^(.+?)\/\.claude\/worktrees\/([^/]+)(?:\/.*)?$/.exec(c)
  return m ? { folder: m[1]!, worktree: `${m[1]!}/.claude/worktrees/${m[2]!}` } : { folder: c }
}

/** The exact paths one entry keeps out at a launch: a personal file under
 *  every login dir; a folder's file under the launch's folder (and its
 *  worktree root) — none for another folder's. */
export function instructionExcludes(e: InstructionEntry, loginDirs: readonly string[], launch?: { folder: string; worktree?: string }): string[] {
  if ('personal' in e) return [...new Set(loginDirs.map((d) => resolve(d)))].map((d) => join(d, e.personal))
  if (!launch || e.in !== launch.folder) return []
  // a folder above: judged again against this launch, while the file is there
  if ('above' in e) return aboveFileOk(e.above, launch.folder, loginDirs) && existsSync(e.above) ? [e.above] : []
  return [join(e.in, e.file), ...(launch.worktree ? [join(launch.worktree, e.file)] : [])]
}

/** The launch place's key for personal instructions (the choice it keeps). */
export const PERSONAL_KEY = 'personalInstructions'

/** What «personal instructions off» excludes for these logins: each login's
 *  CLAUDE.md and every file under its rules/ — absolute, each dir once,
 *  in the engine's forward-slash form. */
export function personalEntries(loginDirs: readonly string[]): string[] {
  return [...new Set(loginDirs.map((d) => resolve(d)))].flatMap((d) => [join(d, 'CLAUDE.md'), `${join(d, 'rules')}/**`])
}

/** The allowlist: what of `payload` may ride a launch, every other key and
 *  shape dropped; null when nothing is left. An instruction entry needs
 *  `ctx` (the logins and folders it is judged against): without it, every
 *  one is dropped. */
export function cleanEntries(payload: unknown, ctx?: EntryContext): LaunchEntries | null {
  return clean(payload, ctx ?? null)
}

/** The payload as a WRITE of one entry keeps it: every other entry by its
 *  shape (an instruction entry of another folder of the agent included) —
 *  judged again with its context at every launch. */
export function keptEntries(payload: unknown): LaunchEntries | null {
  return clean(payload, 'keep')
}

function clean(payload: unknown, ctx: EntryContext | 'keep' | null): LaunchEntries | null {
  if (!isMap(payload)) return null
  const out: Json = {}
  if (own(payload, 'enabledPlugins') && isMap(payload.enabledPlugins)) {
    const m: Json = {}
    for (const [k, v] of Object.entries(payload.enabledPlugins)) if (k !== '' && typeof v === 'boolean') put(m, k, v)
    if (Object.keys(m).length > 0) out.enabledPlugins = m
  }
  if (own(payload, 'deniedMcpServers') && Array.isArray(payload.deniedMcpServers)) {
    const seen = new Set<string>()
    const list: { serverName: string }[] = []
    for (const e of payload.deniedMcpServers as unknown[]) {
      if (!isMap(e) || Object.keys(e).length !== 1 || typeof e.serverName !== 'string' || e.serverName === '' || seen.has(e.serverName)) continue
      seen.add(e.serverName)
      list.push({ serverName: e.serverName })
    }
    if (list.length > 0) out.deniedMcpServers = list
  }
  if (own(payload, 'disabledMcpjsonServers') && Array.isArray(payload.disabledMcpjsonServers)) {
    const list = [...new Set((payload.disabledMcpjsonServers as unknown[]).filter((n): n is string => typeof n === 'string' && n !== ''))]
    if (list.length > 0) out.disabledMcpjsonServers = list
  }
  if (own(payload, 'skillOverrides') && isMap(payload.skillOverrides)) {
    const m: Json = {}
    for (const [k, v] of Object.entries(payload.skillOverrides)) if (k !== '' && typeof v === 'string' && SKILL_POSITIONS.includes(v)) put(m, k, v)
    if (Object.keys(m).length > 0) out.skillOverrides = m
  }
  if (own(payload, 'syncClaudeAiPlugins') && payload.syncClaudeAiPlugins === false) out.syncClaudeAiPlugins = false
  if (own(payload, 'syncClaudeAiSkills') && payload.syncClaudeAiSkills === false) out.syncClaudeAiSkills = false
  if (own(payload, 'disableClaudeAiConnectors') && payload.disableClaudeAiConnectors === true) out.disableClaudeAiConnectors = true
  if (own(payload, PERSONAL_KEY) && payload[PERSONAL_KEY] === 'off') out[PERSONAL_KEY] = 'off'
  if (ctx !== null && own(payload, INSTRUCTIONS_KEY)) {
    const list = instructionEntries(payload[INSTRUCTIONS_KEY], ctx)
    if (list.length > 0) out[INSTRUCTIONS_KEY] = list
  }
  if (own(payload, 'autoMemoryEnabled') && typeof payload.autoMemoryEnabled === 'boolean') out.autoMemoryEnabled = payload.autoMemoryEnabled
  return Object.keys(out).length > 0 ? (out as LaunchEntries) : null
}

/** Only what removes (a heartbeat): no plugin «on», no skill «on». */
function removalsOf(e: LaunchEntries): LaunchEntries | null {
  const out: LaunchEntries = { ...e }
  if (e.enabledPlugins) {
    const m: Json = {}
    for (const [k, v] of Object.entries(e.enabledPlugins)) if (v === false) put(m, k, false)
    if (Object.keys(m).length > 0) out.enabledPlugins = m as Record<string, boolean>
    else delete out.enabledPlugins
  }
  if (e.skillOverrides) {
    const m: Json = {}
    for (const [k, v] of Object.entries(e.skillOverrides)) if (v !== 'on') put(m, k, v)
    if (Object.keys(m).length > 0) out.skillOverrides = m as Record<string, SkillPosition>
    else delete out.skillOverrides
  }
  // auto memory «on» would bring notes into a turn sealed without them
  if (out.autoMemoryEnabled === true) delete out.autoMemoryEnabled
  return Object.keys(out).length > 0 ? out : null
}

/** The launch's flag-tier settings with each payload merged in, in order.
 *  Every key the launch carried is kept (the fence's `permissions`, its
 *  hooks, the style's plugin entries); a payload with nothing allowed —
 *  or none at all — leaves `settings` exactly as it was. `loginDirs`:
 *  every login's config dir known at THIS launch — what a personal-
 *  instructions «off» excludes (absent: the machine's own ~/.claude).
 *  `cwd`: where the launch starts — a folder's instruction entries ride
 *  only for that folder (and its worktree root); absent, none does. */
export function withLaunchEntries(
  settings: Record<string, unknown>,
  payloads: readonly unknown[] | undefined,
  opts: { onlyRemoves?: boolean; loginDirs?: readonly string[]; cwd?: string } = {},
): Record<string, unknown> {
  let out = settings
  const dirs = opts.loginDirs && opts.loginDirs.length > 0 ? opts.loginDirs : [join(homedir(), '.claude')]
  const launch = opts.cwd ? launchFolderOf(opts.cwd) : undefined
  const ctx: EntryContext = { loginDirs: dirs, folders: launch ? [launch.folder] : [] }
  for (const p of payloads ?? []) {
    const clean = cleanEntries(p, ctx)
    const e = clean && opts.onlyRemoves ? removalsOf(clean) : clean
    if (!e) continue
    if (out === settings) out = { ...settings }
    if (e.enabledPlugins) {
      const m: Json = {}
      if (isMap(out.enabledPlugins)) for (const [k, v] of Object.entries(out.enabledPlugins)) put(m, k, v)
      for (const [k, v] of Object.entries(e.enabledPlugins)) put(m, k, v)
      out.enabledPlugins = m
    }
    if (e.deniedMcpServers) {
      const prior = Array.isArray(out.deniedMcpServers) ? (out.deniedMcpServers as unknown[]) : []
      const has = (n: string): boolean => prior.some((x) => isMap(x) && Object.keys(x).length === 1 && x.serverName === n)
      out.deniedMcpServers = [...prior, ...e.deniedMcpServers.filter((d) => !has(d.serverName))]
    }
    if (e.disabledMcpjsonServers) {
      const prior = Array.isArray(out.disabledMcpjsonServers) ? (out.disabledMcpjsonServers as unknown[]) : []
      out.disabledMcpjsonServers = [...new Set([...prior, ...e.disabledMcpjsonServers])]
    }
    if (e.skillOverrides) {
      const m: Json = {}
      if (isMap(out.skillOverrides)) for (const [k, v] of Object.entries(out.skillOverrides)) put(m, k, v)
      for (const [k, v] of Object.entries(e.skillOverrides)) {
        // a heartbeat only loses: a skill keeps the more restrictive state
        if (opts.onlyRemoves && own(m, k) && rankOf(m[k]) >= rankOf(v)) continue
        put(m, k, v)
      }
      out.skillOverrides = m
    }
    if (e.syncClaudeAiPlugins === false) out.syncClaudeAiPlugins = false
    if (e.syncClaudeAiSkills === false) out.syncClaudeAiSkills = false
    if (e.disableClaudeAiConnectors === true) out.disableClaudeAiConnectors = true
    if (e.personalInstructions === 'off') {
      // computed now, for every login this launch could run on
      const prior = Array.isArray(out.claudeMdExcludes) ? (out.claudeMdExcludes as unknown[]) : []
      out.claudeMdExcludes = [...new Set([...prior, ...personalEntries(dirs)])]
    }
    if (e.instructionsOff) {
      const paths = e.instructionsOff.flatMap((x) => instructionExcludes(x, dirs, launch))
      if (paths.length > 0) {
        const prior = Array.isArray(out.claudeMdExcludes) ? (out.claudeMdExcludes as unknown[]) : []
        out.claudeMdExcludes = [...new Set([...prior, ...paths])]
      }
    }
    // an override kind: the later payload (the narrower place) wins
    if (typeof e.autoMemoryEnabled === 'boolean') out.autoMemoryEnabled = e.autoMemoryEnabled
  }
  return out
}

/** The login dirs a launch computes against, read NOW (a provider that
 *  fails gives none: the machine's default stands). */
export function loginDirsNow(of: (() => string[]) | undefined): { loginDirs?: string[] } {
  if (!of) return {}
  try {
    const dirs = of()
    return dirs.length > 0 ? { loginDirs: dirs } : {}
  } catch {
    return {}
  }
}

/** A payload's own personal-instructions entry: «off», or none. */
export function personalEntryOf(payload: unknown): 'off' | undefined {
  return cleanEntries(payload)?.personalInstructions
}

/** The payload with the personal-instructions choice set (`off`) or removed
 *  (null), every other entry kept; byte for byte the same when nothing changed. */
export function setPersonalEntry(payload: unknown, to: 'off' | null): { payload: LaunchEntries | null; changed: boolean } {
  const prior = keptEntries(payload)
  const e: Json = { ...(prior ?? {}) }
  if (to === 'off') e[PERSONAL_KEY] = 'off'
  else delete e[PERSONAL_KEY]
  const clean = keptEntries(e)
  if (canonical(clean) === canonical(prior)) return { payload: prior, changed: false }
  return { payload: clean, changed: true }
}

/** How one row is written at a launch place: its key and its exact names. */
export type LaunchKey =
  | { key: 'enabledPlugins'; id: string }
  | { key: 'deniedMcpServers'; names: string[] }
  | { key: 'disabledMcpjsonServers'; name: string }
  /** an account origin's head: its key, only ever in its «off» value */
  | { key: 'head'; name: HeadKey }

/** The three heads of what an account sends, and the value that turns each off. */
export type HeadKey = 'syncClaudeAiPlugins' | 'syncClaudeAiSkills' | 'disableClaudeAiConnectors'
export const HEAD_OFF: Readonly<Record<HeadKey, boolean>> = { syncClaudeAiPlugins: false, syncClaudeAiSkills: false, disableClaudeAiConnectors: true }

/** A row's own entry in a payload: on/off for a plugin, off for a server
 *  denied (or disabled) by its own name — absent: none. */
export function entryOf(payload: unknown, k: LaunchKey, ownName?: string): 'on' | 'off' | undefined {
  const e = cleanEntries(payload)
  if (!e) return undefined
  if (k.key === 'head') return (e as Json)[k.name] === HEAD_OFF[k.name] ? 'off' : undefined
  if (k.key === 'enabledPlugins') {
    const m = e.enabledPlugins
    return m && own(m, k.id) ? (m[k.id] ? 'on' : 'off') : undefined
  }
  const name = ownName ?? (k.key === 'deniedMcpServers' ? k.names[0] : k.name)
  if (name === undefined) return undefined
  if ((e.deniedMcpServers ?? []).some((d) => d.serverName === name)) return 'off'
  if (k.key === 'disabledMcpjsonServers' && (e.disabledMcpjsonServers ?? []).includes(name)) return 'off'
  return undefined
}

/** The payload with the row's entry set (`to`) or removed (null), keeping
 *  every other entry; returns the cleaned payload (null: nothing left) and
 *  whether anything changed. Only the switch's own entries are touched. */
export function setEntry(payload: unknown, k: LaunchKey, to: 'on' | 'off' | null): { payload: LaunchEntries | null; changed: boolean } {
  const prior = keptEntries(payload)
  const e: Json = { ...(prior ?? {}) }
  if (k.key === 'head') {
    // only «off» is a state of a head: anything else removes it
    if (to === 'off') e[k.name] = HEAD_OFF[k.name]
    else delete e[k.name]
  } else if (k.key === 'enabledPlugins') {
    const m: Json = {}
    if (isMap(e.enabledPlugins)) for (const [n, v] of Object.entries(e.enabledPlugins)) if (n !== k.id) put(m, n, v)
    if (to !== null) put(m, k.id, to === 'on')
    if (Object.keys(m).length > 0) e.enabledPlugins = m
    else delete e.enabledPlugins
  } else if (k.key === 'deniedMcpServers') {
    const kept = ((e.deniedMcpServers as { serverName: string }[] | undefined) ?? []).filter((d) => !k.names.includes(d.serverName))
    const list = to === 'off' ? [...kept, ...k.names.map((serverName) => ({ serverName }))] : kept
    if (list.length > 0) e.deniedMcpServers = list
    else delete e.deniedMcpServers
  } else {
    const kept = ((e.disabledMcpjsonServers as string[] | undefined) ?? []).filter((n) => n !== k.name)
    const list = to === 'off' ? [...kept, k.name] : kept
    if (list.length > 0) e.disabledMcpjsonServers = list
    else delete e.disabledMcpjsonServers
  }
  const clean = keptEntries(e)
  // a click that changes nothing keeps the payload as it was, byte for byte
  if (canonical(clean) === canonical(prior)) return { payload: prior, changed: false }
  return { payload: clean, changed: true }
}

/** One form per meaning: keys sorted, lists sorted (order says nothing here). */
function canonical(v: unknown): string {
  const norm = (x: unknown): unknown =>
    Array.isArray(x)
      ? x
          .map(norm)
          .map((y) => JSON.stringify(y))
          .sort()
      : isMap(x)
        ? Object.keys(x)
            .sort()
            .map((k) => [k, norm(x[k])])
        : x
  return JSON.stringify(norm(v ?? null))
}

/** A skill's own position in a payload (`skillOverrides`), absent: none. */
export function skillEntryOf(payload: unknown, name: string): SkillPosition | undefined {
  const m = cleanEntries(payload)?.skillOverrides
  return m && own(m, name) ? m[name] : undefined
}

/** The payload with one skill's position set (`to`) or removed (null),
 *  every other entry kept; cleaned by the allowlist, byte for byte the same
 *  when nothing changed. */
export function setSkillEntry(payload: unknown, name: string, to: SkillPosition | null): { payload: LaunchEntries | null; changed: boolean } {
  const prior = keptEntries(payload)
  const e: Json = { ...(prior ?? {}) }
  const m: Json = {}
  if (isMap(e.skillOverrides)) for (const [n, v] of Object.entries(e.skillOverrides)) if (n !== name) put(m, n, v)
  if (to !== null) put(m, name, to)
  if (Object.keys(m).length > 0) e.skillOverrides = m
  else delete e.skillOverrides
  const clean = keptEntries(e)
  if (canonical(clean) === canonical(prior)) return { payload: prior, changed: false }
  return { payload: clean, changed: true }
}

/** One instruction file's own entry in a payload, judged with `ctx`:
 *  «off», or none. */
export function instructionEntryOf(payload: unknown, entry: InstructionEntry, ctx: EntryContext): 'off' | undefined {
  const k = JSON.stringify(entry)
  return (cleanEntries(payload, ctx)?.instructionsOff ?? []).some((x) => JSON.stringify(x) === k) ? 'off' : undefined
}

/** Whether a place may name this entry (`ctx`: the logins and the folders
 *  of the agent whose place it is). */
export function instructionEntryOk(entry: InstructionEntry, ctx: EntryContext): boolean {
  return instructionEntries([entry], ctx).length === 1
}

/** The payload with one instruction file's entry set (`off`) or removed
 *  (null), every other entry kept as found; byte for byte the same when
 *  nothing changed. Throws for an entry `ctx` does not admit. */
export function setInstructionEntry(
  payload: unknown,
  entry: InstructionEntry,
  to: 'off' | null,
  ctx: EntryContext,
): { payload: LaunchEntries | null; changed: boolean } {
  if (!instructionEntryOk(entry, ctx)) throw new Error('not an instruction file this place can name')
  const prior = keptEntries(payload)
  const k = JSON.stringify(entry)
  const list = (prior?.instructionsOff ?? []).filter((x) => JSON.stringify(x) !== k)
  if (to === 'off') list.push(entry)
  const e: Json = { ...(prior ?? {}) }
  if (list.length > 0) e[INSTRUCTIONS_KEY] = list
  else delete e[INSTRUCTIONS_KEY]
  const next = keptEntries(e)
  if (canonical(next) === canonical(prior)) return { payload: prior, changed: false }
  return { payload: next, changed: true }
}

/** Auto memory's own entry in a payload: on, off, or none. */
export function autoMemoryEntryOf(payload: unknown): 'on' | 'off' | undefined {
  const v = cleanEntries(payload)?.autoMemoryEnabled
  return v === undefined ? undefined : v ? 'on' : 'off'
}

/** The payload with auto memory set on, off, or removed (null), every
 *  other entry kept as found. */
export function setAutoMemoryEntry(payload: unknown, to: 'on' | 'off' | null): { payload: LaunchEntries | null; changed: boolean } {
  const prior = keptEntries(payload)
  const e: Json = { ...(prior ?? {}) }
  if (to === null) delete e.autoMemoryEnabled
  else e.autoMemoryEnabled = to === 'on'
  const next = keptEntries(e)
  if (canonical(next) === canonical(prior)) return { payload: prior, changed: false }
  return { payload: next, changed: true }
}
