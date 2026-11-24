import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { backupCorruptJson } from './json-store.js'
import { USES_COLS, USES_ROWS } from './uses.js'
import { findHarness } from './harnesses/registry.js'

// prefs-store.ts — UI preferences persisted in ~/.silos/ui.json. Same pattern
// as overrides.json (SessionStore): loading tolerant of a missing/corrupt file,
// atomic write (tmp + rename). Unlike muted.json (seeded on startup), there is
// NO seed here — a missing file simply means "no preferences yet" ({}), and
// it's only created on the first PATCH.

export interface ProjectsPrefs {
  order?: string[]
  collapsed?: string[]
  pinned?: string[]
  inPool?: string[] // projects added to the pool by hand
  pins?: PinRef[] // multi-source pins: { source, ref } — the cross-cutting pinned tree
}

// A pinned item from any silo. `ref` is source-specific.
export interface PinRef {
  source: string
  ref: string
}

export type ConsoleThemeChoice = 'silos' | 'own'

export interface Prefs {
  projects?: ProjectsPrefs
  // the context column's open state on the agent page (ContextColumn) — a bare
  // boolean, no sub-shape.
  contextOpen?: boolean
  // "Browser notifications" toggle in SettingsPage › Notifications — doesn't
  // trigger anything yet (just persisted; the real Notification API comes
  // later). Same bare-boolean pattern as `contextOpen`.
  notifications?: boolean
  // each engine console's colours, by engine id (the descriptor's
  // ui.consoleColours row): 'silos' (default) follows Silos' light/dark like
  // the Claude console; 'own' leaves the engine's own theme alone (OpenCode:
  // harnesses/opencode/console-theme.ts). Merged per engine on PATCH.
  consoleTheme?: Record<string, ConsoleThemeChoice>
  // Height (px) of the terminal panel under the chat — its own sub-shape
  // (not a bare boolean) because it carries a numeric field.
  terminal?: TerminalPrefs
  // agentIds with their Sidebar row collapsed (chevron) — a SIBLING field to
  // `projects`, not nested inside it: it collapses AGENTS, not projects.
  collapsedAgents?: string[]
  // agentIds whose Automations category is collapsed in the Sidebar — the
  // same shape and criterion as collapsedAgents.
  collapsedAutomations?: string[]
  // the owner's manual order of agent rows in the Sidebar (drag), as a global
  // list of agentIds — a sibling of collapsedAgents.
  agentOrder?: string[]
  // the owner's manual order of CONVERSATION rows per agent (drag) —
  // agentId → chain keys "folder/id", top first. Nothing in the Sidebar
  // reorders on its own: a newborn is adopted on top, a
  // drag rewrites the list, a reload draws it as is. Total replacement of
  // the whole map on PATCH, like agentOrder.
  conversationOrder?: Record<string, string[]>
  // conversations the owner dragged to a FIXED position in an agent's list
  // (the rest flow by latest activity, newest first) —
  // agentId → [{ key: "folder/id", at: 0-based index }]. Merged per agent
  // on PATCH: a client sends only the agent it changed. Supersedes
  // conversationOrder, which no client reads any more.
  conversationSlots?: Record<string, { key: string; at: number }[]>
  // conversations the owner DETACHED from their chain by dragging (session
  // keys "folder/id"): the parent link is ignored in the Sidebar, so the
  // conversation is its own topic. Dragging it back onto its chain's head
  // removes it from here.
  detachedChains?: string[]
  // Setup zone of the context column: expanded or not — bare boolean. Absent =
  // collapsed (the column's operational-first default).
  setup?: boolean
  // How wide the context column's MACHINERY reaches: 'conversation' (the
  // default — the automation that produced what you are reading), 'agent',
  // 'project' or 'all'. Everything else in the column is already about the
  // open conversation; this dial is for the blocks that aren't.
  contextScope?: 'conversation' | 'agent' | 'project' | 'all'
  // Map › Uses: the axes and window last chosen (rows × columns, 7/30/all
  // days) — a view setting that IS a setting, not a gesture.
  uses?: UsesPrefs
}

export interface UsesPrefs {
  rows?: string
  cols?: string
  since?: string
}

export interface TerminalPrefs {
  height?: number
  // font size (px) of the real console / terminal panes — an integer in
  // [TERMINAL_FONT_MIN, TERMINAL_FONT_MAX]; set from Settings › Appearance.
  fontSize?: number
}

export const TERMINAL_FONT_MIN = 10
export const TERMINAL_FONT_MAX = 24

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

// ——— validation ———

// Validation for the `terminal` sub-shape — same pattern as validateProjectsPrefs.
export function validateTerminal(v: unknown): TerminalPrefs {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    throw new Error('terminal must be an object')
  }
  const o = v as Record<string, unknown>
  for (const key of Object.keys(o)) {
    if (key !== 'height' && key !== 'fontSize') throw new Error(`unknown field in terminal: ${key}`)
  }
  const out: TerminalPrefs = {}
  if ('height' in o) {
    if (typeof o.height !== 'number' || !Number.isFinite(o.height)) throw new Error('terminal.height must be a number')
    out.height = o.height
  }
  if ('fontSize' in o) {
    const n = o.fontSize
    if (typeof n !== 'number' || !Number.isInteger(n) || n < TERMINAL_FONT_MIN || n > TERMINAL_FONT_MAX) {
      throw new Error(`terminal.fontSize must be an integer between ${TERMINAL_FONT_MIN} and ${TERMINAL_FONT_MAX}`)
    }
    out.fontSize = n
  }
  return out
}

// Validation for the `uses` sub-shape — a total replacement, not a merge.
// A value the matrix no longer knows is dropped, not rejected (a tab built
// before an axis was renamed shouldn't get a 400 for it).
export function validateUses(v: unknown): UsesPrefs {
  if (!isObj(v)) throw new Error('uses must be an object')
  const out: UsesPrefs = {}
  if (typeof v.rows === 'string' && (USES_ROWS as readonly string[]).includes(v.rows)) out.rows = v.rows
  if (typeof v.cols === 'string' && (USES_COLS as readonly string[]).includes(v.cols)) out.cols = v.cols
  if (typeof v.since === 'string' && /^(all|\d{1,4})$/.test(v.since)) out.since = v.since
  return out
}

const PROJECTS_FIELDS = ['order', 'collapsed', 'pinned', 'inPool'] as const

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string')
}

function isStringArrayRecord(v: unknown): v is Record<string, string[]> {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && Object.values(v).every(isStringArray)
}

function isPinArray(v: unknown): v is PinRef[] {
  return (
    Array.isArray(v) && v.every((x) => typeof x === 'object' && x !== null && typeof (x as PinRef).source === 'string' && typeof (x as PinRef).ref === 'string')
  )
}

// Validation for the PATCH's `projects` sub-shape — throws a plain English
// message (the server forwards it as 400 as-is).
export function validateProjectsPrefs(v: unknown): ProjectsPrefs {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    throw new Error('projects must be an object')
  }
  const o = v as Record<string, unknown>
  const allowed = [...PROJECTS_FIELDS, 'pins']
  for (const key of Object.keys(o)) {
    if (!allowed.includes(key)) {
      throw new Error(`unknown field in projects: ${key}`)
    }
  }
  const out: ProjectsPrefs = {}
  for (const field of PROJECTS_FIELDS) {
    if (field in o) {
      if (!isStringArray(o[field])) throw new Error(`projects.${field} must be an array of strings`)
      out[field] = o[field] as string[]
    }
  }
  if ('pins' in o) {
    if (!isPinArray(o.pins)) throw new Error('projects.pins must be an array of { source, ref }')
    out.pins = o.pins
  }
  return out
}

export class PrefsStore {
  private file: string
  constructor(dataDir: string) {
    this.file = join(dataDir, 'ui.json')
  }

  private backedUpCorrupt = false

  read(): Prefs {
    // Only an unreadable FILE reads as empty (corrupt → {}, same as muted.json).
    if (!existsSync(this.file)) return {}
    let text: string
    try {
      text = readFileSync(this.file, 'utf8')
    } catch {
      return {}
    }
    let raw: unknown
    try {
      raw = JSON.parse(text)
    } catch {
      // corrupt → {} stays the contract, but the only copy is kept ONCE
      // (read() runs per request) before the next patch can write over it.
      if (!this.backedUpCorrupt) {
        this.backedUpCorrupt = true
        backupCorruptJson(this.file, text, 'ui prefs')
      }
      return {}
    }
    return isObj(raw) ? (raw as Prefs) : {}
  }

  // Shallow merge of the `projects` sub-shape: each field present in the patch
  // REPLACES the previous array entirely (no array merging) — a field absent
  // from the patch keeps its previous value.
  patchProjects(patch: unknown): Prefs {
    const validated = validateProjectsPrefs(patch)
    const current = this.read()
    const projects = { ...current.projects, ...validated }
    const next: Prefs = { ...current, projects }
    return this.write(next)
  }

  // contextOpen — same pattern as patchProjects, no sub-shape.
  patchContext(v: unknown): Prefs {
    if (typeof v !== 'boolean') throw new Error('contextOpen must be a boolean')
    const next: Prefs = { ...this.read(), contextOpen: v }
    return this.write(next)
  }

  // Setup zone of the context column — same pattern as patchContext (bare boolean).
  patchSetup(v: unknown): Prefs {
    if (typeof v !== 'boolean') throw new Error('setup must be a boolean')
    const next: Prefs = { ...this.read(), setup: v }
    return this.write(next)
  }

  // notifications — same pattern as patchContext.
  patchNotifications(v: unknown): Prefs {
    if (typeof v !== 'boolean') throw new Error('notifications must be a boolean')
    const next: Prefs = { ...this.read(), notifications: v }
    return this.write(next)
  }

  /** An engine console's colours (default 'silos': follow Silos' light/dark). */
  consoleThemeOf(harness: string): ConsoleThemeChoice {
    return this.read().consoleTheme?.[harness] ?? 'silos'
  }

  // consoleTheme — { <engine id>: 'silos' | 'own' }, merged per engine (a
  // client sends only the engine it changed); an id no engine registered, or
  // an engine without a Console colours setting (ui.consoleColours), is refused
  // — a choice nothing reads is never stored.
  patchConsoleTheme(v: unknown): Prefs {
    if (!isObj(v)) throw new Error('consoleTheme must be an object')
    for (const [id, choice] of Object.entries(v)) {
      const h = findHarness(id)
      if (!h) throw new Error(`consoleTheme: unknown engine '${id}'`)
      if (!h.ui.consoleColours) throw new Error(`consoleTheme: ${h.label} has no console colours setting`)
      if (choice !== 'silos' && choice !== 'own') throw new Error(`consoleTheme.${id} must be 'silos' or 'own'`)
    }
    const current = this.read()
    return this.write({ ...current, consoleTheme: { ...current.consoleTheme, ...(v as Record<string, ConsoleThemeChoice>) } })
  }

  // terminal.height/fontSize — shallow merge, same pattern as patchProjects.
  patchTerminal(patch: unknown): Prefs {
    const validated = validateTerminal(patch)
    const current = this.read()
    const terminal = { ...current.terminal, ...validated }
    const next: Prefs = { ...current, terminal }
    return this.write(next)
  }

  // collapsedAgents — bare array, total-replacement (no merge).
  patchCollapsedAgents(v: unknown): Prefs {
    if (!isStringArray(v)) throw new Error('collapsedAgents must be an array of strings')
    const next: Prefs = { ...this.read(), collapsedAgents: v }
    return this.write(next)
  }

  patchCollapsedAutomations(v: unknown): Prefs {
    if (!isStringArray(v)) throw new Error('collapsedAutomations must be an array of strings')
    const next: Prefs = { ...this.read(), collapsedAutomations: v }
    return this.write(next)
  }

  patchContextScope(v: unknown): Prefs {
    if (v !== 'conversation' && v !== 'agent' && v !== 'project' && v !== 'all') {
      throw new Error("contextScope must be 'conversation', 'agent', 'project' or 'all'")
    }
    const next: Prefs = { ...this.read(), contextScope: v }
    return this.write(next)
  }

  patchAgentOrder(v: unknown): Prefs {
    if (!isStringArray(v)) throw new Error('agentOrder must be an array of strings')
    const next: Prefs = { ...this.read(), agentOrder: v }
    return this.write(next)
  }

  patchConversationOrder(v: unknown): Prefs {
    if (!isStringArrayRecord(v)) throw new Error('conversationOrder must be an object of agentId → array of strings')
    // merged PER AGENT: a client sends only the agent whose
    // list changed; replacing the whole map let a tab holding a stale or
    // empty map erase every other agent's order.
    const current = this.read()
    const next: Prefs = { ...current, conversationOrder: { ...(current.conversationOrder ?? {}), ...v } }
    return this.write(next)
  }

  patchConversationSlots(v: unknown): Prefs {
    const ok =
      typeof v === 'object' &&
      v !== null &&
      !Array.isArray(v) &&
      Object.values(v).every(
        (list) =>
          Array.isArray(list) &&
          list.every(
            (s) =>
              typeof s === 'object' &&
              s !== null &&
              typeof (s as { key?: unknown }).key === 'string' &&
              Number.isInteger((s as { at?: unknown }).at) &&
              (s as { at: number }).at >= 0,
          ),
      )
    if (!ok) throw new Error('conversationSlots must be an object of agentId → array of { key, at }')
    const current = this.read()
    return this.write({ ...current, conversationSlots: { ...(current.conversationSlots ?? {}), ...(v as Record<string, { key: string; at: number }[]>) } })
  }

  patchDetachedChains(v: unknown): Prefs {
    if (!isStringArray(v)) throw new Error('detachedChains must be an array of strings')
    const next: Prefs = { ...this.read(), detachedChains: v }
    return this.write(next)
  }

  // uses — total replacement (no merge): a patch simply IS the value.
  patchUses(v: unknown): Prefs {
    const uses = validateUses(v)
    const next: Prefs = { ...this.read(), uses }
    return this.write(next)
  }

  private write(next: Prefs): Prefs {
    const tmp = this.file + '.tmp'
    writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n')
    renameSync(tmp, this.file)
    return next
  }
}
