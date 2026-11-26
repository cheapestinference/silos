// What a conversation started with, and what it carries now — measured from
// its own transcript (the first-turn logic is a port of a reference
// implementation verified on real transcripts).
//
// Claude Code records each request it sends, split across records before
// the reply: `api-request-shape` (system blocks and tool definitions; or
// `prompt_snapshot` on older SDKs), the instruction files, the skill and
// subagent listings (deltas), the deferred tool names (deltas), the session
// context and what each start hook injected. Each piece is sized in
// characters and given ONE owner.
//  · The FIRST TURN: the pieces recorded before the first reply with
//    non-zero usage after the first `api-request-shape`; its exact total
//    (input + cache_creation + cache_read) is split in proportion to the
//    sizes. Only this number is a pure «what it started with».
//  · NOW: the latest record of each kind (listings and tools replayed in
//    order), converted with this conversation's own chars-per-token ratio
//    from the first turn — approximate, and said so.
// Pure and tolerant: an unknown shape is skipped, never thrown on.
//
// Lengths are counted the way the reference counts them (Python): code
// points for text, `json.dumps` (ASCII-escaped, `, `/`: ` separators) for the
// pieces it serialises, so the numbers are the reference's numbers.

import { ASK_DECISIONS_NOTE } from '../../chat-service.js'
import { RUN_OUTCOME_INSTRUCTION } from '../../run-outcome.js'
import { nameResolver, pluginServerName, toolIdOf } from './loads/names.js'
import { InstructionsReplay } from './instructions-record.js'
import type {
  LoadsRow,
  StartedWith,
  StartedWithContext,
  StartedWithFeed,
  StartedWithMcpFailure,
  StartedWithOwner,
  StartedWithPart,
  StartedWithReading,
} from '../contract.js'

type Rec = Record<string, unknown>

const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
const strs = (v: unknown): string[] => arr(v).filter((x): x is string => typeof x === 'string')

/** Python's len(): code points, not UTF-16 units. */
export function cpLen(s: string): number {
  let pairs = 0
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1)
      if (d >= 0xdc00 && d <= 0xdfff) {
        pairs++
        i++
      }
    }
  }
  return s.length - pairs
}

function pyStr(s: string): string {
  let out = '"'
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c === 0x22) out += '\\"'
    else if (c === 0x5c) out += '\\\\'
    else if (c === 0x0a) out += '\\n'
    else if (c === 0x0d) out += '\\r'
    else if (c === 0x09) out += '\\t'
    else if (c === 0x08) out += '\\b'
    else if (c === 0x0c) out += '\\f'
    else if (c < 0x20 || c > 0x7e) out += '\\u' + c.toString(16).padStart(4, '0')
    else out += s[i]
  }
  return out + '"'
}

/** Python's json.dumps(v) with its defaults (ensure_ascii, ', ' and ': '). */
export function pyDumps(v: unknown): string {
  if (v === null || v === undefined) return 'null'
  if (typeof v === 'string') return pyStr(v)
  if (typeof v === 'boolean') return v ? 'true' : 'false'
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : v > 0 ? 'Infinity' : v < 0 ? '-Infinity' : 'NaN'
  if (Array.isArray(v)) return '[' + v.map(pyDumps).join(', ') + ']'
  if (typeof v === 'object')
    return (
      '{' +
      Object.entries(v as Rec)
        .map(([k, x]) => pyStr(k) + ': ' + pyDumps(x))
        .join(', ') +
      '}'
    )
  return 'null'
}

/** pyDumps(v).slice(0, n), serializing no further than n characters — a
 *  2 MB tool result asked for its first 200 characters costs 200. */
export function pyDumpsHead(v: unknown, n: number): string {
  let out = ''
  const full = (): boolean => out.length >= n
  const putStr = (x: string): boolean => {
    out += '"'
    for (let i = 0; i < x.length && !full(); i++) out += pyStr(x[i]!).slice(1, -1)
    if (full()) return true
    out += '"'
    return full()
  }
  const walk = (x: unknown): boolean => {
    if (typeof x === 'string') return putStr(x)
    if (Array.isArray(x)) {
      out += '['
      for (let i = 0; i < x.length; i++) {
        if (i > 0) out += ', '
        if (full() || walk(x[i])) return true
      }
      out += ']'
      return full()
    }
    if (x !== null && typeof x === 'object') {
      out += '{'
      let first = true
      for (const [k, y] of Object.entries(x as Rec)) {
        if (!first) out += ', '
        first = false
        if (full() || putStr(k)) return true
        out += ': '
        if (full() || walk(y)) return true
      }
      out += '}'
      return full()
    }
    out += pyDumps(x)
    return full()
  }
  walk(v)
  return out.slice(0, n)
}

const firstWords = (s: string, n: number): string => s.split(/\s+/).slice(0, n).join(' ')

/** Where Silos' append starts in a system block (chat-service.ts appendFor). */
const SILOS_MARKERS = [
  '# You are running inside Silos',
  '# Context files',
  // the automations note appends carried until 26-11 (one copy rides the
  // briefing now): transcripts born before still split on it
  'Scheduled or recurring work goes through Silos',
  firstWords(ASK_DECISIONS_NOTE, 8),
]
const AGENT_MEMORY = '# Agent memory'

interface Segment {
  owner: StartedWithOwner
  sub: 'engine' | 'charter' | 'agent-memory' | 'silos'
  text: string
}

/** One system block split by owner (reference split_system). */
export function splitSystem(text: string, charter: string | null): Segment[] {
  const cline = charter
    ? Array.from(charter.trim().split('\n')[0] ?? '')
        .slice(0, 80)
        .join('')
    : ''
  const markers = [...SILOS_MARKERS, AGENT_MEMORY]
  const starts = markers.map((m) => text.indexOf(m))
  if (cline) starts.push(text.indexOf(cline))
  const found = starts.filter((x) => x >= 0)
  if (found.length === 0) return [{ owner: 'engine', sub: 'engine', text }]
  const cut = Math.min(...found)
  const out: Segment[] = [{ owner: 'engine', sub: 'engine', text: text.slice(0, cut) }]
  let rest = text.slice(cut)
  // the charter (no fixed heading) runs until the first known marker after it
  if (cline && rest.startsWith(cline)) {
    const nxt = markers.map((m) => rest.indexOf(m)).filter((x) => x > 0)
    const end = nxt.length ? Math.min(...nxt) : rest.length
    out.push({ owner: 'agent', sub: 'charter', text: rest.slice(0, end) })
    rest = rest.slice(end)
  }
  const j = rest.indexOf(AGENT_MEMORY)
  if (j >= 0) {
    const k = SILOS_MARKERS.map((m) => rest.indexOf(m, j + 1)).filter((x) => x > j)
    const end = k.length ? Math.min(...k) : rest.length
    out.push({ owner: 'silos', sub: 'silos', text: rest.slice(0, j) })
    out.push({ owner: 'agent', sub: 'agent-memory', text: rest.slice(j, end) })
    out.push({ owner: 'silos', sub: 'silos', text: rest.slice(end) })
  } else {
    out.push({ owner: 'silos', sub: 'silos', text: rest })
  }
  return out.filter((s) => s.text.length > 0)
}

/** `mcp__<server>__tool` → server (the reference's non-greedy match). */
const mcpServer = (name: string): string | null => /^mcp__(.+?)__/.exec(name)?.[1] ?? null

/** Where a piece of the start belongs: its owner, its words and its row. */
interface Placed {
  owner: StartedWithOwner
  label: string
  item?: string
  group?: string
  loginBound?: true
  unsourced?: true
}

/** A row that loads: on, and not standing aside for another copy. */
const loadsHere = (r: LoadsRow): boolean => r.state === 'active' && !r.replacedBy
const ownerOfRow = (r: LoadsRow): StartedWithOwner => r.origin.owner ?? 'you'
const pick = (all: LoadsRow[]): LoadsRow | undefined => all.find(loadsHere) ?? all.find((r) => !r.replacedBy) ?? all[0]

/**
 * The ONE placer of a start's MCP servers and plugin pieces. A tool name
 * carries only the id of its server's name (loads/names.ts): the id of every
 * KNOWN name — the folder's inventory rows, what loads at start, the names
 * the transcript itself lists (server instructions, failed and pending
 * servers) — is computed and compared, never the other way. A known name
 * takes its row: of two copies of one plugin, the one that loads (the
 * inventory decides it: a reading that names the copy, else the installed
 * one when it is on, else the account's). An id no name has, or one two
 * names share, keeps the id as its label.
 */
export function startPlacer(ctx: StartedWithContext, listed: Iterable<string>) {
  const rows = ctx.loads ?? []
  const byKey = new Map(rows.map((r) => [r.key, r]))
  // the agent's own servers ride its plugin (agent-tools.ts): plugin:<id>:<name>
  const agentNames = new Set<string>()
  const loadedByName = new Map<string, NonNullable<StartedWithContext['loaded']>['mcp'][number]>()
  for (const m of ctx.loaded?.mcp ?? []) {
    if (m.source === 'agent') {
      if (m.from) agentNames.add(pluginServerName(m.from, m.name))
      continue
    }
    if (m.source === 'account') continue // an id as recorded, never a name
    loadedByName.set(m.engineName ?? (m.source === 'plugin' && m.from ? pluginServerName(m.from, m.name) : m.name), m)
  }
  const names = nameResolver([...rows.filter((r) => r.exact && r.kind !== 'plugin').map((r) => r.name), ...agentNames, ...loadedByName.keys(), ...listed])
  const pluginRow = (plugin: string): LoadsRow | undefined => pick(rows.filter((r) => r.kind === 'plugin' && r.label === plugin))

  const byName = (name: string): Placed => {
    if (agentNames.has(name)) return { owner: 'agent', label: name.slice(name.lastIndexOf(':') + 1) }
    const r = pick(rows.filter((x) => x.exact && x.name === name && x.kind !== 'plugin'))
    if (r) {
      const parent = r.parent ? byKey.get(r.parent) : undefined
      return {
        owner: ownerOfRow(r),
        label: r.label,
        item: r.key,
        ...(parent ? { group: parent.label } : {}),
        // a folder's server kept in the login's ~/.claude.json exists only on that login
        ...(r.key.startsWith('mcp:local:') ? { loginBound: true as const } : {}),
        ...(r.origin.owner === null ? { unsourced: true as const } : {}),
      }
    }
    const m = loadedByName.get(name)
    if (m) {
      if (m.source === 'plugin') return { owner: m.account ? 'account' : 'you', label: m.name, ...(m.from ? { group: m.from } : {}) }
      if (m.source === 'project') return { owner: 'project', label: m.name, ...(m.from?.includes('.claude.json') ? { loginBound: true as const } : {}) }
      return { owner: 'you', label: m.name }
    }
    // a name the transcript lists that nothing on disk declares
    if (name.startsWith('claude.ai ')) return { owner: 'account', label: name.slice('claude.ai '.length) }
    const pm = /^plugin:([^:]+):(.+)$/.exec(name)
    if (pm) {
      const pr = pluginRow(pm[1]!)
      return { owner: pr ? ownerOfRow(pr) : 'you', label: pm[2]!, group: pm[1]!, ...(pr ? { item: pr.key } : { unsourced: true as const }) }
    }
    return { owner: 'you', label: name, unsourced: true }
  }

  const nameOf = (id: string): string | null => {
    const r = names.resolve(id)
    return r.kind === 'name' ? r.name : null
  }
  return {
    /** the exact name a tool-name id resolves to, or null (unknown, or two names share it) */
    nameOf,
    byName,
    byId(id: string): Placed {
      const name = nameOf(id)
      if (name !== null) return byName(name)
      // unresolved: the id stays the label — a connector's id is the account's by structure
      const connector = id.startsWith('claude_ai_')
      return { owner: connector ? 'account' : 'you', label: id, ...(connector ? {} : { unsourced: true as const }) }
    },
    /** whether the inventory places a plugin of this name */
    pluginKnown(name: string): boolean {
      return pluginRow(name) !== undefined
    },
    /** a plugin by its name (`superpowers`), as the inventory places it */
    plugin(name: string, account?: { login: string | null }): { owner: StartedWithOwner; item?: string } {
      const r = pluginRow(name)
      if (r) return { owner: ownerOfRow(r), item: r.key }
      return { owner: account ? 'account' : 'you' }
    },
  }
}
type Placer = ReturnType<typeof startPlacer>

/** A start hook's shown name: the /loaded join, else the plugin segment of
 *  its command path, else its last word. */
export function hookName(command: string, ctx: StartedWithContext): string {
  const joined = ctx.loaded?.injections.find((i) => i.command === command)
  if (joined) return joined.name
  const cache = /plugins\/cache\/[^/"'\s]+\/([^/"'\s]+)/.exec(command)
  if (cache) return cache[1]!
  const market = /plugins\/marketplaces\/([^/"'\s]+)/.exec(command)
  if (market) return market[1]!
  const words = command.trim().split(/\s+/)
  const last = (words[words.length - 1] ?? '').replace(/^["']+|["']+$/g, '')
  return last.split('/').pop() || last || 'start hook'
}

// A hook Silos already knows (its /loaded injections) says its own origin —
// that wins over any path test: Silos' plugin lives inside the Silos repo,
// which is also a PROJECT (the Silos agent's), so «command under the project
// folder» would misread Silos' briefing as the project's (seen on the Silos
// agent). Paths are the fallback for hooks Silos can't name. A plugin's hook
// is its plugin's — the Claude account's when the account sends the copy
// that loads.
function hookOwner(command: string, ctx: StartedWithContext, place: Placer): { owner: StartedWithOwner; item?: string } {
  const joined = ctx.loaded?.injections.find((i) => i.command === command)
  if (joined?.origin === 'silos') return { owner: 'silos' }
  if (joined && (joined.origin === 'project' || joined.origin === 'local')) return { owner: 'project' }
  if (joined?.origin === 'plugin') return place.plugin(joined.name, joined.account)
  if (joined) return { owner: 'you' }
  if (ctx.silosPluginDir && command.includes(ctx.silosPluginDir)) return { owner: 'silos' }
  if (/\/silos\/plugin\/hooks\//.test(command)) return { owner: 'silos' }
  if (ctx.projectDir && command.includes(ctx.projectDir.replace(/\/+$/, '') + '/')) return { owner: 'project' }
  return { owner: 'you' }
}

// the MCP servers among the tool names in force, each placed as a start's
// MCP parts are
function mcpInForce(tools: Set<string>, place: Placer): NonNullable<StartedWith['now']>['mcp'] {
  const by = new Map<string, number>()
  for (const n of tools) {
    const srv = mcpServer(n)
    if (srv) by.set(srv, (by.get(srv) ?? 0) + 1)
  }
  return [...by]
    .map(([server, n]) => {
      const p = place.byId(server)
      return {
        server,
        label: p.group ? `${p.label} · ${p.group}` : p.label,
        owner: p.owner,
        tools: n,
        ...(p.loginBound ? { loginBound: true as const } : {}),
        ...(p.item ? { item: p.item } : {}),
        ...(p.group ? { group: p.group } : {}),
      }
    })
    .sort((x, y) => x.label.localeCompare(y.label))
}

const PERSISTED = /^<persisted-output>\s*Output too large \(([^)]*)\)\. Full output saved to: (\S+)/

/** The records that make up one request, gathered by kind. */
interface Gathered {
  shape: Rec | null
  snapshot: unknown[] | null
  files: Rec[]
  skillLines: string[]
  /** the names the listing records carry (`names[]`) */
  skillNames: string[]
  /** each listing as recorded: its lines (or whatever was there), its types */
  agentListings: { lines: unknown; types: string[]; builtIn: Set<string> | null }[]
  deferred: string[]
  contexts: unknown[]
  hooks: Rec[]
  hookCtx: string[]
  stubs: string[]
  first: Rec | null
  /** each server's instruction block, by the engine's exact name */
  mcpInstructions: [string, string][]
  /** the exact server names the records list (instructions, failed, pending) */
  listedNames: string[]
}

interface Draft extends Omit<StartedWithPart, 'tokens'> {
  text: string
}

/** Gathered records → sized, owned parts. `prefix` keeps refs apart (now-…). */
function draftsOf(g: Gathered, ctx: StartedWithContext, prefix: string): Draft[] {
  const drafts: Draft[] = []
  const groups = new Map<string, Draft>()
  const add = (key: string, base: Omit<Draft, 'chars' | 'text' | 'ref'>, chars: number, text: string): void => {
    const ref = prefix + key
    const d = groups.get(ref)
    if (d) {
      d.chars += chars
      d.text += (d.text ? '\n' : '') + text
      return
    }
    const nd: Draft = { ...base, chars, text, ref }
    groups.set(ref, nd)
    drafts.push(nd)
  }

  // the skills a Claude account sends are their own set: a personal skill
  // may carry the same name, and the catalog lists both
  const catalog = new Map<string, string | undefined>()
  const accountSkills = new Set<string>()
  for (const s of ctx.catalog) {
    if (s.source === 'account') accountSkills.add(s.name)
    else catalog.set(s.name, s.source)
  }
  // every MCP part is placed by ONE placer (startPlacer): its name resolved
  // from its tool-name id against the known names, its owner and label its
  // inventory row's — never an id cut apart
  const place = startPlacer(ctx, g.listedNames)
  const mcpAdd = (id: string, p: Placed, chars: number, text: string): void => {
    add(
      `mcp-${id}`,
      {
        owner: p.owner,
        kind: 'mcp',
        label: p.label,
        ...(p.item ? { item: p.item } : {}),
        ...(p.group ? { group: p.group } : {}),
        ...(p.unsourced ? { unsourced: true as const } : {}),
        ...(p.loginBound ? { loginBound: true as const } : {}),
      },
      chars,
      text,
    )
  }
  const mcpPart = (name: string, chars: number, text: string): boolean => {
    const srv = mcpServer(name)
    if (srv === null) return false
    mcpAdd(srv, place.byId(srv), chars, text)
    return true
  }

  // system blocks: the shape first, else the snapshot
  const hasShape = g.shape !== null && Object.keys(g.shape).length > 0
  const sysBlocks: string[] = hasShape
    ? arr(g.shape!.system).map((b) => (isRec(b) ? str(b.text) : ''))
    : (g.snapshot ?? []).map((b) => (typeof b === 'string' ? b : isRec(b) ? str(b.text) : ''))
  const SYS_LABEL = {
    engine: 'Claude Code system prompt',
    charter: 'Mission',
    'agent-memory': 'Agent memory',
    silos: 'Silos briefing (system prompt)',
  } as const
  for (const b of sysBlocks) {
    for (const s of splitSystem(b, ctx.charter)) {
      add(`system-${s.sub}`, { owner: s.owner, kind: 'system', label: SYS_LABEL[s.sub] }, cpLen(s.text), s.text)
    }
  }
  if (hasShape) {
    for (const tl of arr(g.shape!.tools)) {
      const d = pyDumps(tl)
      const name = isRec(tl) ? str(tl.name) : ''
      if (!mcpPart(name, d.length, d)) add('tools', { owner: 'engine', kind: 'tools', label: 'Built-in tools' }, d.length, d)
    }
  }

  g.files.forEach((f, i) => {
    const ty = str(f.type)
    const content = str(f.content)
    const owner: StartedWithOwner = ty === 'User' ? 'you' : 'project'
    const kind = ty === 'AutoMem' ? 'memory-index' : 'instructions'
    add(`file-${i}`, { owner, kind, label: str(f.path) || (kind === 'memory-index' ? 'Memory index' : 'Instructions') }, cpLen(content), content)
  })

  // a plugin skill's name has its own colon (`superpowers:brainstorming`):
  // the longest listed or catalogued name the line starts with names it
  const known2 = [...new Set([...g.skillNames, ...catalog.keys()])].sort((x, y) => y.length - x.length)
  for (const ln of g.skillLines) {
    const m = /^- ([^:]+):/.exec(ln)
    if (!m) continue
    const name = known2.find((n) => ln.startsWith(`- ${n}:`)) ?? m[1]!.trim()
    // a skill the Claude account sends: listed by the engine under a prefix
    // of its own (`- <x>:<name>:` — observed `anthropic-skills:`), never a
    // plugin the folder loads; or bare, when no personal skill has its name
    const prefixed = /^- ([^:]+):([^:]+):/.exec(ln)
    const asAccount =
      prefixed && !place.pluginKnown(prefixed[1]!) && accountSkills.has(prefixed[2]!)
        ? prefixed[2]!
        : !catalog.has(name) && accountSkills.has(name)
          ? name
          : null
    if (asAccount !== null) {
      add('skills-account', { owner: 'account', kind: 'skills', label: 'Skill listing · Claude account' }, cpLen(ln) + 1, ln)
      continue
    }
    // a plugin's skill (`plugin:skill`) the catalog doesn't list is not
    // flagged: the catalog does not cover every enabled plugin (claude-mem,
    // commit-commands… verified), so "not listed" ≠ "uninstalled"
    const known = catalog.has(name) || name.includes(':')
    // a plugin's skill is its plugin's: split per plugin, owned as the
    // inventory places that plugin (the Claude account's when it sends it)
    const plugin = name.includes(':') ? name.slice(0, name.indexOf(':')) : null
    if (plugin) {
      const pl = place.plugin(plugin)
      add(
        `skills-plugin-${plugin}`,
        { owner: pl.owner, kind: 'skills', label: `Skill listing · ${plugin} plugin`, group: plugin, ...(pl.item ? { item: pl.item } : {}) },
        cpLen(ln) + 1,
        ln,
      )
      continue
    }
    const owner: StartedWithOwner = known && catalog.get(name) === 'project' ? 'project' : 'you'
    const key = !known ? 'skills-stale' : `skills-${owner}`
    const label = !known ? 'Skill listing · no longer installed' : owner === 'project' ? 'Skill listing · project skills' : 'Skill listing'
    add(key, { owner, kind: 'skills', label, ...(!known ? { stale: true as const } : {}) }, cpLen(ln) + 1, ln)
  }

  const BUILT = { owner: 'engine' as const, kind: 'agents', label: 'Subagent listing · built-in' }
  const PLUG = { owner: 'you' as const, kind: 'agents', label: 'Subagent listing · plugins' }
  for (const l of g.agentListings) {
    // the reference sizes json.dumps(addedLines): each line's dump plus its
    // share of the separators and brackets (2) adds up to exactly that
    if (!Array.isArray(l.lines)) {
      add('agents-engine', BUILT, pyDumps(l.lines ?? '').length, '')
      continue
    }
    if (l.lines.length === 0) {
      add('agents-engine', BUILT, 2, '')
      continue
    }
    const types = [...l.types].sort((x, y) => y.length - x.length)
    for (const ln of l.lines) {
      const text = typeof ln === 'string' ? ln : pyDumps(ln)
      const ty = typeof ln === 'string' ? (types.find((x) => ln.startsWith(`- ${x}:`)) ?? /^- ([^:\s]+)/.exec(ln)?.[1] ?? null) : null
      const notBuiltIn = ty !== null && (l.builtIn ? !l.builtIn.has(ty) : ty.includes(':'))
      const size = pyDumps(ln).length + 2
      // a plugin's type (`plugin:type`) is its plugin's, split per plugin
      const plugin = notBuiltIn && ty !== null && ty.includes(':') ? ty.slice(0, ty.indexOf(':')) : null
      if (plugin) {
        const pl = place.plugin(plugin)
        add(
          `agents-plugin-${plugin}`,
          { owner: pl.owner, kind: 'agents', label: `Subagent listing · ${plugin} plugin`, group: plugin, ...(pl.item ? { item: pl.item } : {}) },
          size,
          text,
        )
      } else add(notBuiltIn ? 'agents-you' : 'agents-engine', notBuiltIn ? PLUG : BUILT, size, text)
    }
  }

  for (const n of g.deferred) {
    if (!mcpPart(n, cpLen(n) + 1, n)) add('deferred', { owner: 'engine', kind: 'deferred', label: 'Deferred built-in tools' }, cpLen(n) + 1, n)
  }

  // a server's instructions (mcp_instructions_delta) are its server's: they
  // join the part its tools are in, named by the engine's exact name
  for (const [name, block] of g.mcpInstructions) mcpAdd(toolIdOf(name), place.byName(name), cpLen(block), block)

  for (const c of g.contexts) {
    const d = pyDumps(c === undefined ? {} : c)
    add('context', { owner: 'engine', kind: 'context', label: 'Session context' }, d.length, d)
  }

  // hooks: the injected text in order of the hooks whose output carries
  // additionalContext; a stub (output too large) in order of those that
  // carry a systemMessage — the stub is what reached the model, not the output.
  const withCtx = g.hooks.filter((h) => str(h.stdout).includes('additionalContext'))
  const withMsg = g.hooks.filter((h) => str(h.stdout).includes('systemMessage'))
  const hookParts = new Map<Rec | number, Draft>()
  const hookPart = (h: Rec | null, stubN: number): Draft => {
    const k = h ?? stubN
    const existing = hookParts.get(k)
    if (existing) return existing
    const command = h ? str(h.command) : ''
    const who = h ? hookOwner(command, ctx, place) : { owner: 'you' as const }
    const d: Draft = {
      owner: who.owner,
      kind: 'hook',
      label: h ? hookName(command, ctx) : 'A start hook',
      chars: 0,
      text: '',
      ref: `${prefix}hook-${hookParts.size}`,
      ...(who.item ? { item: who.item } : {}),
    }
    const code = h?.exitCode
    if (typeof code === 'number' && code !== 0) d.exitCode = code
    hookParts.set(k, d)
    drafts.push(d)
    return d
  }
  withCtx.forEach((h, i) => {
    if (i >= g.hookCtx.length) return
    const d = hookPart(h, -1)
    d.chars += cpLen(g.hookCtx[i]!)
    d.text += g.hookCtx[i]!
  })
  g.stubs.forEach((s, i) => {
    const d = hookPart(withMsg[i] ?? null, i)
    d.chars += cpLen(s)
    d.text += (d.text ? '\n\n' : '') + s
    const m = PERSISTED.exec(s)
    d.truncated = { savedTo: m?.[2] ?? '', size: m?.[1] ?? '' }
  })
  // a start hook that exited non-zero and injected nothing is still said
  for (const h of g.hooks) {
    const code = h.exitCode
    if (typeof code === 'number' && code !== 0 && !hookParts.has(h)) hookPart(h, -1)
  }

  if (g.first) {
    const c = isRec(g.first.message) ? g.first.message.content : ''
    let text =
      typeof c === 'string'
        ? c
        : arr(c)
            .map((p) => (isRec(p) ? str(p.text) : ''))
            .join('')
    const pre = /^\[silos-context\][\s\S]*?\[\/silos-context\]\s*/.exec(text)
    if (pre) {
      add('prelude', { owner: 'silos', kind: 'prelude', label: 'Silos context' }, cpLen(pre[0]), pre[0])
      text = text.slice(pre[0].length)
    }
    const oi = text.lastIndexOf(RUN_OUTCOME_INSTRUCTION)
    if (oi >= 0) {
      let from = oi
      while (from > 0 && /\s/.test(text[from - 1]!)) from--
      const instr = text.slice(from, oi + RUN_OUTCOME_INSTRUCTION.length)
      add('outcome', { owner: 'silos', kind: 'outcome', label: 'Run outcome instruction' }, cpLen(instr), instr)
      text = text.slice(0, from) + text.slice(oi + RUN_OUTCOME_INSTRUCTION.length)
    }
    add('first', { owner: 'conversation', kind: 'first', label: 'First message' }, cpLen(text), text)
  }
  return drafts
}

/** The exact total split by size: each OWNER gets round(total × its chars /
 *  Σchars) and each part its owner's tokens in proportion, the rounding
 *  remainders landing on the largest part (and its owner). Owner sums are
 *  then the reference's per-owner numbers, bar the remainder. */
function apportion(total: number, drafts: Draft[]): StartedWithPart[] {
  const parts: StartedWithPart[] = drafts.map(({ text: _t, ...d }) => ({ ...d, tokens: 0 }))
  const sum = parts.reduce((s, p) => s + p.chars, 0)
  if (sum <= 0 || parts.length === 0) return parts
  let big = 0
  for (let i = 1; i < parts.length; i++) if (parts[i]!.chars > parts[big]!.chars) big = i
  const owners = new Map<StartedWithOwner, number[]>()
  parts.forEach((p, i) => {
    const l = owners.get(p.owner)
    if (l) l.push(i)
    else owners.set(p.owner, [i])
  })
  const ownerTokens = new Map<StartedWithOwner, number>()
  for (const [o, idx] of owners) ownerTokens.set(o, Math.round((total * idx.reduce((s, i) => s + parts[i]!.chars, 0)) / sum))
  const bigOwner = parts[big]!.owner
  ownerTokens.set(bigOwner, ownerTokens.get(bigOwner)! + total - [...ownerTokens.values()].reduce((s, x) => s + x, 0))
  for (const [o, idx] of owners) {
    const t = ownerTokens.get(o)!
    const chars = idx.reduce((s, i) => s + parts[i]!.chars, 0)
    let ob = idx[0]!
    for (const i of idx) {
      parts[i]!.tokens = chars > 0 ? Math.round((t * parts[i]!.chars) / chars) : 0
      if (parts[i]!.chars > parts[ob]!.chars) ob = i
    }
    const target = o === bigOwner ? big : ob
    parts[target]!.tokens += t - idx.reduce((s, i) => s + parts[i]!.tokens, 0)
  }
  return parts
}

const usageOf = (r: Rec): number => {
  const msg = isRec(r.message) ? r.message : {}
  const u = isRec(msg.usage) ? msg.usage : {}
  const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
  return n(u.input_tokens) + n(u.cache_creation_input_tokens) + n(u.cache_read_input_tokens)
}

const failuresOf = (v: unknown): StartedWithMcpFailure[] =>
  arr(v)
    .map((f) => (isRec(f) ? { name: str(f.name), error: str(f.error) } : { name: str(f), error: '' }))
    .filter((f) => f.name)

const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/

const emptyGathered = (): Gathered => ({
  shape: null,
  snapshot: null,
  files: [],
  skillLines: [],
  skillNames: [],
  agentListings: [],
  deferred: [],
  contexts: [],
  hooks: [],
  hookCtx: [],
  stubs: [],
  first: null,
  mcpInstructions: [],
  listedNames: [],
})

interface HeadState {
  g: Gathered
  /** the instruction files of the first turn: the ONE reader's replay
   *  (instructions-record.ts) up to its reply — a delta never doubles a set */
  instr: InstructionsReplay
  /** the last non-meta user record that is not a command record (/clear) */
  lastReal: Rec | null
  pending: string[]
  failed: StartedWithMcpFailure[]
  deltaSeen: boolean
}
const emptyHead = (): HeadState => ({ g: emptyGathered(), instr: new InstructionsReplay(), lastReal: null, pending: [], failed: [], deltaSeen: false })
const cloneHead = (h: HeadState): HeadState => ({
  g: {
    ...h.g,
    files: [...h.g.files],
    skillLines: [...h.g.skillLines],
    skillNames: [...h.g.skillNames],
    agentListings: [...h.g.agentListings],
    deferred: [...h.g.deferred],
    contexts: [...h.g.contexts],
    hooks: [...h.g.hooks],
    hookCtx: [...h.g.hookCtx],
    stubs: [...h.g.stubs],
    mcpInstructions: [...h.g.mcpInstructions],
    listedNames: [...h.g.listedNames],
  },
  instr: h.instr.clone(),
  lastReal: h.lastReal,
  pending: [...h.pending],
  failed: [...h.failed],
  deltaSeen: h.deltaSeen,
})

/**
 * A transcript's lines fed IN ORDER, in any slicing (all at once, or as the
 * file grows) → the reading: the first turn, what it carries now, its
 * context now and its account changes. `reading(ctx)` after feeding every
 * line equals what one pass over the whole file gives (readStartedWith is
 * exactly that), so a caller following a live transcript feeds only what
 * was appended since its last read (otherwise a live conversation's 40 MB
 * transcript was re-read whole on every request). The first turn is fixed
 * once its reply is seen; «now» is a fold over every record.
 */
export class TranscriptStartedWith implements StartedWithFeed {
  private modeDecided = false
  private mode: StartedWith['mode'] = null
  // the first turn: the first reply with non-zero usage after the first
  // api-request-shape (any reply, without one) — a reply seen before any
  // shape is only a CANDIDATE: a shape later in the file moves the turn
  private shapeSeen = false
  private head = emptyHead()
  private startRec: Rec | null = null
  private candidate: { rec: Rec; head: HeadState } | null = null
  // ── what is in force now: the latest record of each kind; listings and
  // tools replayed (a listing is a delta unless isInitial)
  private nowShape: Rec | null = null
  private nowSnapshot: unknown[] | null = null
  private nowSkillNames: string[] = []
  /** the instruction files in force now: the ONE reader's replay (base,
   *  then each delta's files and removed) — never a delta taken for the set */
  private nowInstr = new InstructionsReplay()
  private skills = new Map<string, string>()
  private agents = new Map<string, unknown>()
  private agentBuiltIn: Set<string> | null = null
  private tools = new Set<string>()
  private nowPending: string[] = []
  private nowFailed: StartedWithMcpFailure[] = []
  /** server instructions in force (replayed: a later block replaces, a removal drops) */
  private instructions = new Map<string, string>()
  private nowListed = new Set<string>()
  private lastContext: unknown
  private hasContext = false
  private batch = { hooks: [] as Rec[], stubs: [] as string[] }
  private lastBatch: { hooks: Rec[]; stubs: string[]; ctx: string[] } | null = null
  private accounts: { email: string; at: string | null }[] = []
  private contextNow: StartedWith['contextNow'] = null

  /** More lines, in file order (blank, cut, foreign and request-blob lines skipped). */
  feed(lines: readonly string[]): this {
    for (const line of lines) {
      if (!line || line.includes('"type":"api-request-blob"')) continue
      let r: unknown
      try {
        r = JSON.parse(line)
      } catch {
        continue
      }
      if (isRec(r)) this.record(r)
    }
    return this
  }

  private record(r: Rec): void {
    if (!this.modeDecided && typeof r.entrypoint === 'string') {
      this.modeDecided = true
      this.mode = r.entrypoint === 'cli' ? 'console' : r.entrypoint.startsWith('sdk') ? 'chat' : null
    }
    if (this.startRec === null) this.headRecord(r)
    this.nowRecord(r)
  }

  // ── the first turn's records: everything before that reply (the
  // reference's reading: the first shape/snapshot, the rest as recorded)
  private headRecord(r: Rec): void {
    if (r.type === 'api-request-shape') this.shapeSeen = true
    if (r.type === 'assistant' && usageOf(r) > 0) {
      if (this.shapeSeen) {
        this.startRec = r
        return
      }
      if (this.candidate === null) this.candidate = { rec: r, head: cloneHead(this.head) }
    }
    const h = this.head
    const start = h.g
    if (r.type === 'api-request-shape') {
      if (start.shape === null && isRec(r.shape)) start.shape = r.shape
      return
    }
    if (r.type === 'user' && !r.isMeta) {
      // the first message: the last non-meta user record before the reply
      // that is not a command record (/clear)
      if (!pyDumpsHead(isRec(r.message) ? (r.message.content ?? '') : '', 200).includes('<command-name>')) h.lastReal = r
      return
    }
    if (r.type !== 'attachment' || !isRec(r.attachment)) return
    const a = r.attachment
    switch (a.type) {
      case 'prompt_snapshot':
        if (start.snapshot === null && Array.isArray(a.systemPrompt)) start.snapshot = a.systemPrompt
        break
      case 'instructions':
        h.instr.attachment(a, typeof r.timestamp === 'string' ? r.timestamp : null)
        break
      case 'skill_listing':
        start.skillLines.push(...str(a.content).split('\n'))
        start.skillNames.push(...strs(a.names))
        break
      case 'agent_listing_delta':
        start.agentListings.push({
          lines: a.addedLines,
          types: strs(a.addedTypes),
          builtIn: Array.isArray(a.builtInTypes) ? new Set(strs(a.builtInTypes)) : null,
        })
        break
      case 'deferred_tools_delta':
        if (!h.deltaSeen) {
          h.deltaSeen = true
          h.pending = strs(a.pendingMcpServers)
          h.failed = failuresOf(a.failedMcpServers)
        }
        start.deferred.push(...strs(a.addedNames))
        start.listedNames.push(...strs(a.pendingMcpServers), ...failuresOf(a.failedMcpServers).map((f) => f.name))
        break
      case 'mcp_instructions_delta': {
        const blocks = arr(a.addedBlocks)
        strs(a.addedNames).forEach((n, i) => {
          start.listedNames.push(n)
          if (typeof blocks[i] === 'string') start.mcpInstructions.push([n, blocks[i] as string])
        })
        break
      }
      case 'session_context':
        start.contexts.push(a.context)
        break
      case 'hook_success':
        if (a.hookEvent === 'SessionStart') start.hooks.push(a)
        break
      case 'hook_additional_context':
        for (const c of arr(a.content)) start.hookCtx.push(typeof c === 'string' ? c : '')
        break
      case 'hook_system_message':
        if (a.hookEvent === 'SessionStart' && str(a.content).startsWith('<persisted-output>')) start.stubs.push(str(a.content))
        break
    }
  }

  private nowRecord(r: Rec): void {
    const at = typeof r.timestamp === 'string' ? r.timestamp : null
    if (r.type === 'api-request-shape' && isRec(r.shape)) {
      this.nowShape = r.shape
      return
    }
    if (r.type === 'assistant') {
      const u = usageOf(r)
      if (u > 0) this.contextNow = { tokens: u, at }
      return
    }
    if (r.type !== 'attachment' || !isRec(r.attachment)) return
    const a = r.attachment
    switch (a.type) {
      case 'prompt_snapshot':
        if (Array.isArray(a.systemPrompt)) this.nowSnapshot = a.systemPrompt
        break
      case 'instructions':
        this.nowInstr.attachment(a, at)
        break
      case 'skill_listing': {
        if (a.isInitial !== false) this.skills.clear()
        const names = strs(a.names).sort((x, y) => y.length - x.length)
        for (const ln of str(a.content).split('\n')) {
          const m = /^- ([^:]+):/.exec(ln)
          if (m) this.skills.set(names.find((n) => ln.startsWith(`- ${n}:`)) ?? m[1]!.trim(), ln)
        }
        this.nowSkillNames.push(...names)
        break
      }
      case 'agent_listing_delta': {
        if (a.isInitial !== false) this.agents.clear()
        for (const t of strs(a.removedTypes)) this.agents.delete(t)
        const types = strs(a.addedTypes)
        arr(a.addedLines).forEach((ln, i) => {
          const ty =
            typeof ln === 'string'
              ? ([...types].sort((x, y) => y.length - x.length).find((x) => ln.startsWith(`- ${x}:`)) ?? types[i] ?? ln)
              : (types[i] ?? String(i))
          this.agents.set(ty, ln)
        })
        if (Array.isArray(a.builtInTypes)) this.agentBuiltIn = new Set([...(this.agentBuiltIn ?? []), ...strs(a.builtInTypes)])
        break
      }
      case 'deferred_tools_delta':
        for (const n of strs(a.addedNames)) this.tools.add(n)
        for (const n of strs(a.removedNames)) this.tools.delete(n)
        for (const n of strs(a.readdedNames)) this.tools.add(n)
        if (Array.isArray(a.pendingMcpServers)) this.nowPending = strs(a.pendingMcpServers)
        if (Array.isArray(a.failedMcpServers)) this.nowFailed = failuresOf(a.failedMcpServers)
        for (const n of [...this.nowPending, ...this.nowFailed.map((f) => f.name)]) this.nowListed.add(n)
        break
      case 'mcp_instructions_delta': {
        for (const n of strs(a.removedNames)) this.instructions.delete(n)
        const blocks = arr(a.addedBlocks)
        strs(a.addedNames).forEach((n, i) => {
          this.nowListed.add(n)
          if (typeof blocks[i] === 'string') this.instructions.set(n, blocks[i] as string)
        })
        break
      }
      case 'session_context': {
        this.lastContext = a.context
        this.hasContext = true
        const m = EMAIL.exec(pyDumps(a.context ?? {}))
        if (m) {
          const email = m[0].replace(/\.+$/, '')
          if (this.accounts[this.accounts.length - 1]?.email !== email) this.accounts.push({ email, at })
        }
        break
      }
      case 'hook_success':
        if (a.hookEvent === 'SessionStart') this.batch.hooks.push(a)
        break
      case 'hook_system_message':
        if (a.hookEvent === 'SessionStart' && str(a.content).startsWith('<persisted-output>')) this.batch.stubs.push(str(a.content))
        break
      case 'hook_additional_context':
        this.lastBatch = { ...this.batch, ctx: arr(a.content).map((c) => (typeof c === 'string' ? c : '')) }
        this.batch = { hooks: [], stubs: [] }
        break
    }
  }

  /** The reading of everything fed so far, against today's `ctx`. Reads the
   *  fed state, never changes it: call it after every growth. */
  reading(ctx: StartedWithContext): StartedWithReading {
    // the first turn as the file stands: a reply after the first shape; else
    // (no shape at all) the first reply; else none — the whole file is head
    let startRec = this.startRec
    let h = this.head
    if (startRec === null && !this.shapeSeen && this.candidate) {
      startRec = this.candidate.rec
      h = this.candidate.head
    }
    const start: Gathered = { ...h.g, files: h.instr.filesInForce(), first: h.lastReal }

    const now = emptyGathered()
    now.shape = this.nowShape
    now.snapshot = this.nowSnapshot
    now.skillNames = [...this.nowSkillNames]
    now.files = this.nowInstr.filesInForce()
    now.skillLines = [...this.skills.values()]
    const agentTypes = [...this.agents.keys()]
    if (this.agents.size > 0) now.agentListings = [{ lines: [...this.agents.values()], types: agentTypes, builtIn: this.agentBuiltIn }]
    now.deferred = [...this.tools]
    if (this.hasContext) now.contexts = [this.lastContext]
    if (this.lastBatch) {
      now.hooks = this.lastBatch.hooks
      now.stubs = this.lastBatch.stubs
      now.hookCtx = this.lastBatch.ctx
    }
    now.mcpInstructions = [...this.instructions]
    now.listedNames = [...this.nowListed]

    const total = startRec !== null ? usageOf(startRec) : null
    const startAt = startRec !== null && typeof startRec.timestamp === 'string' ? startRec.timestamp : null
    const measured = total !== null && ((start.shape !== null && Object.keys(start.shape).length > 0) || start.snapshot !== null)
    const base = {
      totalTokens: total,
      at: startAt,
      mode: this.mode,
      pendingMcp: h.pending.length,
      pendingMcpServers: [...h.pending],
      failedMcpServers: [...h.failed],
      contextNow: this.contextNow,
      accounts: [...this.accounts],
      loadedNames: loadedNamesOf(start, ctx),
    }
    if (!measured || total === null) {
      return { summary: { ...base, measured: false, parts: [], now: null }, texts: {} }
    }

    const startDrafts = draftsOf(start, ctx, '')
    const parts = apportion(total, startDrafts)
    const startChars = startDrafts.reduce((s, d) => s + d.chars, 0)
    const texts: Record<string, string> = {}
    for (const d of startDrafts) if (d.ref) texts[d.ref] = d.text
    let nowOut: StartedWith['now'] = null
    if (startChars > 0 && total > 0) {
      const ratio = startChars / total
      const nowDrafts = draftsOf(now, ctx, 'now-')
      for (const d of nowDrafts) if (d.ref) texts[d.ref] = d.text
      nowOut = {
        approx: true,
        ratio,
        parts: nowDrafts.map(({ text: _t, ...d }) => ({ ...d, tokens: Math.round(d.chars / ratio) })),
        tools: this.tools.size,
        pendingMcpServers: [...this.nowPending],
        failedMcpServers: [...this.nowFailed],
        mcp: mcpInForce(this.tools, startPlacer(ctx, now.listedNames)),
      }
    }
    return { summary: { ...base, measured: true, parts, now: nowOut }, texts }
  }
}

/** The exact names of the servers a start carried: every MCP tool id (tool
 *  definitions, deferred names) a known name resolves to, and every server
 *  whose instructions it got. */
function loadedNamesOf(g: Gathered, ctx: StartedWithContext): string[] {
  const place = startPlacer(ctx, g.listedNames)
  const out = new Set<string>(g.mcpInstructions.map(([n]) => n))
  const ids = new Set<string>()
  const toolNames = [...(g.shape ? arr(g.shape.tools).map((t) => (isRec(t) ? str(t.name) : '')) : []), ...g.deferred]
  for (const t of toolNames) {
    const id = mcpServer(t)
    if (id) ids.add(id)
  }
  for (const id of ids) {
    const n = place.nameOf(id)
    if (n !== null) out.add(n)
  }
  return [...out].sort()
}

/** A transcript's lines (all of them) → the reading — one feed, all at once. */
export function readStartedWith(lines: readonly string[], ctx: StartedWithContext): StartedWithReading {
  return new TranscriptStartedWith().feed(lines).reading(ctx)
}

/** The measurement alone (the pure function the routes and tests call). */
export function startedWith(lines: readonly string[], ctx: StartedWithContext): StartedWith {
  return readStartedWith(lines, ctx).summary
}
