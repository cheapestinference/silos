// loaded-at-start.ts — the pure derivations behind Knows & can › Loaded at
// start: the server's reading (GET /api/agents/:id/loaded) grouped the way
// the row draws it. Literal: one row per thing that injects (a plugin with
// two start hooks is ONE plugin; its sizes add up), sizes only when a
// transcript recorded them, nothing guessed. No React, no fetches.
import type { LoadedAtStart, LoadedInjection, LoadedInstruction, LoadedMcp } from './types'

export interface InjectionRow {
  key: string
  origin: LoadedInjection['origin']
  name: string
  /** a plugin the Claude account sends — its login, or null when unknown; absent = not the account's */
  account?: { login: string | null }
  hooks: number
  /** the union of when its hooks fire; [] = every start */
  on: string[]
  /** what its hooks added at their last observed run; null = never seen */
  chars: number | null
  /** the longest observed excerpt (the hook that says most) */
  excerpt: string
  failed: boolean
  /** none of its hooks was recorded in this many recent starts that recorded
   *  others — it runs and prints nothing; null = no such evidence */
  unseenIn: number | null
  outputStyle: boolean
  /** off in the conversations Silos starts (the agent's cockpit style) */
  offBySilos: boolean
  commands: string[]
  files: string[]
}

export function injectionRows(injections: LoadedInjection[]): InjectionRow[] {
  const byKey = new Map<string, InjectionRow>()
  const longest = new Map<string, number>()
  for (const i of injections) {
    const key = `${i.origin}␟${i.account ? `account:${i.account.login ?? ''}` : ''}␟${i.name}`
    let row = byKey.get(key)
    if (!row) {
      row = {
        key,
        origin: i.origin,
        name: i.name,
        ...(i.account ? { account: i.account } : {}),
        hooks: 0,
        on: [],
        chars: null,
        excerpt: '',
        failed: false,
        unseenIn: null,
        outputStyle: false,
        offBySilos: false,
        commands: [],
        files: [],
      }
      byKey.set(key, row)
    }
    row.hooks++
    // a hook that fires on every start makes the row fire on every start
    row.on = row.hooks === 1 ? [...i.on] : row.on.length === 0 || i.on.length === 0 ? [] : [...new Set([...row.on, ...i.on])]
    if (i.seen) {
      row.chars = (row.chars ?? 0) + i.seen.chars
      if (i.seen.failed) row.failed = true
      if (i.seen.chars > (longest.get(key) ?? -1)) {
        longest.set(key, i.seen.chars)
        row.excerpt = i.seen.excerpt
      }
    }
    if (i.unseenIn !== undefined) row.unseenIn = row.unseenIn === null ? i.unseenIn : Math.min(row.unseenIn, i.unseenIn)
    if (i.outputStyle) row.outputStyle = true
    if (i.offBySilos) row.offBySilos = true
    if (!row.commands.includes(i.command)) row.commands.push(i.command)
    if (!row.files.includes(i.file)) row.files.push(i.file)
  }
  return [...byKey.values()]
}

/** "202 chars", "3.4k chars", "12k chars". */
export function formatChars(n: number): string {
  if (n < 1000) return `${n} chars`
  const k = n / 1000
  return `${k < 10 ? k.toFixed(1).replace(/\.0$/, '') : Math.round(k)}k chars`
}

/** "2.1 KB", "512 B" — a file's size on disk. */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const kb = bytes / 1024
  return `${kb < 10 ? kb.toFixed(1).replace(/\.0$/, '') : Math.round(kb)} KB`
}

/** Instruction files split by when they load: at start, or when the session works under a path. */
export function instructionGroups(list: LoadedInstruction[]): { atStart: LoadedInstruction[]; onDemand: LoadedInstruction[] } {
  return { atStart: list.filter((i) => i.when === 'start'), onDemand: list.filter((i) => i.when === 'on-demand') }
}

export interface PluginServers {
  plugin: string
  servers: LoadedMcp[]
}

/** The account plugins of one login (null: a login Silos can't name). */
export interface AccountPlugins {
  login: string | null
  plugins: PluginServers[]
}

const byPlugin = (list: LoadedMcp[]): PluginServers[] => {
  const out = new Map<string, LoadedMcp[]>()
  for (const m of list) out.set(m.from, [...(out.get(m.from) ?? []), m])
  return [...out.entries()].map(([plugin, servers]) => ({ plugin, servers }))
}

/** MCP servers by where they come from, in the row's order. Plugins grouped
 *  by plugin — the machine's installed ones apart from the ones each Claude
 *  account login sends (their owner is the account). */
export function mcpGroups(list: LoadedMcp[]): {
  /** the agent's own (its plugin's .mcp.json) — only its conversations */
  own: LoadedMcp[]
  configured: LoadedMcp[]
  plugins: PluginServers[]
  accountPlugins: AccountPlugins[]
  account: LoadedMcp[]
} {
  const logins = new Map<string | null, LoadedMcp[]>()
  for (const m of list) if (m.source === 'plugin' && m.account) logins.set(m.account.login, [...(logins.get(m.account.login) ?? []), m])
  return {
    own: list.filter((m) => m.source === 'agent'),
    configured: list.filter((m) => m.source === 'project' || m.source === 'user'),
    plugins: byPlugin(list.filter((m) => m.source === 'plugin' && !m.account)),
    accountPlugins: [...logins.entries()].map(([login, servers]) => ({ login, plugins: byPlugin(servers) })),
    account: list.filter((m) => m.source === 'account'),
  }
}

/** What a plugin's servers really are: servers of their own, placeholders
 *  (no address — left to a connector), and copies of a server another
 *  entry already connects. */
export function serverCounts(servers: LoadedMcp[]): { own: number; placeholders: number; shared: number } {
  const placeholders = servers.filter((m) => m.placeholder).length
  const shared = servers.filter((m) => m.sameAs).length
  return { own: servers.length - placeholders - shared, placeholders, shared }
}

/** The total its injections added at their last observed runs; null when none was seen. */
export function observedTotal(rows: InjectionRow[]): number | null {
  // a hook Silos switches off adds nothing to the conversations it starts
  const seen = rows.filter((r) => r.chars !== null && !r.offBySilos)
  return seen.length === 0 ? null : seen.reduce((s, r) => s + (r.chars ?? 0), 0)
}

/** Whether there is anything to draw at all. */
export function isEmptyLoaded(l: LoadedAtStart): boolean {
  return l.instructions.length === 0 && l.injections.length === 0 && l.outputStyle === null && l.mcp.length === 0
}
