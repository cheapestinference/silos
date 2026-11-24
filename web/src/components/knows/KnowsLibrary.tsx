// KnowsLibrary.tsx — everything an agent knows, browsable, usable and
// schematic. One component, two widths:
//   wide  (the agent page): kinds rail · list · the open item, side by side;
//   narrow (the conversation's drawer): kinds as tabs over the list, the
//          open item replacing the list with a way back — so some
//          transcript always stays visible beside it.
// Each kind is grouped by what decides how it reaches the agent, never by
// a scope that 99 % of the items share: memory = what is always in its head
// (instruction files, the index) then the notes by when they were learned;
// skills = on / off / could add; context = shared / its own; tools = the
// MCP servers (and, for a folder, its plugins) by owner. Filters are
// facets that actually split the list (a note's type, in or out of the
// index, learned recently), with honest counts. A note says where it was
// learned — the conversation that wrote it — and whether its index names it.
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { api } from '../../lib/api'
import type { SessionContext } from '../../lib/types'
import { ChevronDown, ChevronLeft, ChevronRight, Plus, Search, Sparkle, X } from 'lucide-react'
import { useStore } from '../../store'
import { contextItems, skillScope, type KnowsItem } from '../../lib/knows'
import { approxTokens, ERA_LABEL, eraOf, memoryIndex, memoryNotes, noteTitle, writtenAt, type Era } from '../../lib/knows-anatomy'
import { relTime } from '../../lib/rel-time'
import { MemoryDetail, SkillDetail, ContextDetail } from './KnowsDetail'
import { LoadedAtStartRow } from '../agent/LoadedAtStartRow'
import { FileViewer } from '../FileViewer'
import { KnowsAdd } from './KnowsAdd'
import { WriteInstructions } from './WriteInstructions'
import { SubNav } from '../SubNav'
import type {
  AgentView,
  BulkSkill,
  ContextFile,
  FolderLoads,
  FolderLoadsWeight,
  LoadsLine,
  LoadsOrigin,
  LoadsRow,
  MemoryFileInfo,
  MemoryRow,
  OwnToolRow,
  SkillCatalogEntry,
  SkillPosition,
} from '../../lib/types'
import { memoryOwner, memoryQualifier, memoryReachWords, memoryWeightWords, QUALIFIER_ORDER, saveWords } from '../../lib/memory-rows'
import { shortTokens, weightOf, type RowWeight } from '../../lib/loads-weight'
import {
  ACCOUNT_GROUP,
  agentLineOf,
  agentRows,
  heldByAgent,
  loadsFor,
  carriesWords,
  childrenOf,
  sharedLink,
  signInDoorOf,
  type SignInDoorOf,
  engineLimitWords,
  engineSwitchesNothing,
  focusCheckNow,
  footCounts,
  groupOf,
  healthOf,
  loginOfGroup,
  needsSignIn,
  noticesOnlyWords,
  pluginRowOf,
  ownerOfToolGroup,
  pluginHealth,
  placeProofWords,
  proofWords,
  refusedWords,
  rowWords,
  SEEN,
  topLevel,
  type HealthWords,
  type ProofWords,
  addWords,
  originHeadOf,
  originOfRow,
  ORIGIN_WHAT,
  switchSentence,
  switchVerb,
} from '../../lib/loads-view'
import { SignInDoor } from './SignInDoor'
import { OriginHead, SwitchRefused } from './OriginHead'
import { HealthLine } from './HealthLine'
import { NarrowChip } from '../FacetBar'
import { OwnToolAdd } from './OwnToolAdd'
import { basename } from '../../lib/routes'
import { knowsDoors, subjectFolder } from './KnowsAnatomy'
import type { FromConversation, KnowsSources, LibraryFocus, LibraryKind } from './KnowsAnatomy'
import { byOwnerOrder, ownerOriginText, ownerText, type Owner, type OwnerContext } from '../../lib/owners'
import { fromOrigin, originTally, showsOriginRow } from '../../lib/origin-filter'
import { signInAgentOf, startsIn } from '../../lib/home'
import { useGoHome } from './go-home'
import { OwnerLabel } from '../OwnerLabel'
import { OriginFilter } from '../OwnerFilter'
import { CheckHead, SendsLine, SendsOffers, sendsTargetOf, useLoadsCheck } from './ToolsCheck'
import { personalAgentView, personalLineOf, personalWords, usePersonal } from './PersonalSwitch'
import { WhereItLoads, WhereToggle } from './WhereItLoads'
import { instructionFact, instructionView, useInstructionPlaces, type InstructionView } from './InstructionPlaces'
import { BulkHead, bulkSkillOf, type BulkPlaceOption } from './BulkHead'
import { SkillPlaces } from './SkillPlaces'
import { conversationLabel, placesPhrase, skillPlacesPhrase, type PlacesFrom, type PlacesPage } from '../../lib/loads-places'

const KIND_LABEL: Record<LibraryKind, string> = {
  memory: 'Memory',
  skills: 'Skills',
  context: 'Files',
  produced: 'Working files',
  start: 'At start',
  files: 'Files',
  tools: 'Tools',
}

// one row of any kind — what the list shows and what opens on the right
interface Row {
  key: string
  kind: LibraryKind
  title: string
  sub?: string
  mtime?: number
  mono?: boolean
  marker?: 'outside' | 'new' | null
  group: string
  /** who owns it (lib/owners.ts) — the agent, the project, Silos, your machine, the Claude account */
  owner: Owner
  memory?: MemoryFileInfo & { layer: string; row?: MemoryRow }
  /** a Memory row's head qualifier (memory-rows.ts) and its place in the engine's load order */
  qual?: string
  order?: number
  /** a Memory row's weight, said beside it — amber over the engine's warning */
  weigh?: { text: string; amber: boolean }
  skill?: SkillCatalogEntry
  file?: ContextFile
  tool?: { name: string; source: string; from: string }
  /** a thing the folder's conversations load (the inventory): a plugin, an
   *  MCP server, a connector — with its origin and state */
  load?: LoadsRow
  /** an inventory row's health line (loads-view.ts healthOf / pluginHealth) */
  health?: HealthWords
  /** where its places disagree, in one phrase — a door to its «Where it loads» */
  phrase?: string
  /** a plugin's own servers, drawn under it */
  children?: Row[]
  /** one of the agent's OWN MCP servers, with its state (agent-tools.ts) */
  own?: OwnToolRow
  search: string
}

const AMBER = 'text-[var(--health-amber)]'

// which memory a library shows: 'project' leaves out an agent's own memory
// file (the project page); 'agent' and 'all' show everything the agent
// reads — its own file, the project's, yours — each row with its owner
export type MemoryScope = 'agent' | 'project' | 'all'
const LAYER_OWNER: Record<string, Owner> = { agent: 'agent', project: 'project', index: 'project', auto: 'project', global: 'you' }

/** The folder a Memory file is judged for: the subject's own (a project
 *  page), else the agent's folder. */
const memoryFolderOf = (a: AgentView): string | null => subjectFolder(a) ?? a.folder ?? null

/** The layer a listed instruction row keeps (what its switch and editor
 *  are): the machine's own CLAUDE.md is «Your personal instructions» (its
 *  head switch), the folder's CLAUDE.md, the index, the agent's own file;
 *  every other file an `instr` row. */
function layerOf(r: MemoryRow, m: NonNullable<KnowsSources['memory']>): string {
  if (r.kind === 'agent') return 'agent'
  if (r.kind === 'auto-index') return 'index'
  if (r.kind === 'personal' && (r.path === m.global.path || r.real === m.global.path)) return 'global'
  if (r.kind === 'project' && r.rel === 'CLAUDE.md') return 'project'
  return 'instr'
}

function memoryRows(
  src: KnowsSources,
  hereId: string | undefined,
  now: number,
  scope: MemoryScope,
  agentId: string,
  nameOf: (id: string) => string,
  agentName = 'this agent',
): Row[] {
  const m = src.memory
  if (!m) return []
  const out: Row[] = []
  if (m.rows) {
    // every instruction file a conversation here loads (spec memory-places
    // §3): one row per real file, in the engine's load order; the notes
    // beside the index are drawn below as before
    m.rows.forEach((r, i) => {
      if (r.kind === 'auto-note' || (scope === 'project' && r.kind === 'agent')) return
      const layer = layerOf(r, m)
      const title = layer === 'global' ? 'Your personal instructions' : layer === 'agent' ? 'Its own memory' : layer === 'index' ? 'Memory index' : r.rel
      const reach = memoryReachWords(r, agentName)
      out.push({
        key: r.path,
        kind: 'memory',
        title,
        sub: reach,
        mtime: r.mtime || undefined,
        group: 'Always in its head',
        owner: memoryOwner(r),
        ...(memoryQualifier(r) ? { qual: memoryQualifier(r)! } : {}),
        order: i,
        weigh: memoryWeightWords(r),
        memory: {
          name: r.rel,
          path: r.path,
          scope: layer === 'agent' ? 'agent' : layer === 'global' ? 'global' : layer === 'index' ? 'auto' : 'project',
          mtime: r.mtime,
          exists: true,
          size: r.bytes,
          layer,
          row: r,
        },
        search: `${title} ${r.rel} ${reach}`.toLowerCase(),
      })
    })
  } else {
    // always in its head: the instruction layers that exist + the index
    const layers: [string, MemoryFileInfo | null, string][] = (
      [
        ['agent', m.agent, 'Its own memory'],
        // the head says whose: no scope words in a title
        ['project', m.project, 'CLAUDE.md'],
        ['global', m.global, 'Your personal instructions'],
      ] as [string, MemoryFileInfo | null, string][]
    ).filter(([layer]) => scope !== 'project' || layer !== 'agent')
    const seen = new Set<string>()
    for (const [layer, f, title] of layers) {
      if (!f || !f.exists || seen.has(f.path)) continue
      seen.add(f.path)
      out.push({
        key: f.path,
        kind: 'memory',
        title,
        sub: f.size !== undefined ? `≈ ${approxTokens(f.size)} tokens · read at every start` : undefined,
        mtime: f.mtime,
        group: 'Always in its head',
        owner: LAYER_OWNER[layer]!,
        memory: { ...f, layer },
        search: `${title} ${f.path}`.toLowerCase(),
      })
    }
    const idx = memoryIndex(m)
    if (idx)
      out.push({
        key: idx.path,
        kind: 'memory',
        title: 'Memory index',
        sub: `${idx.lines ?? '?'} lines · ≈ ${approxTokens(idx.size ?? 0)} tokens · read at every start`,
        mtime: idx.mtime,
        group: 'Always in its head',
        owner: 'project',
        memory: { ...idx, layer: 'index' },
        search: 'memory index',
      })
  }
  for (const n of memoryNotes(m)) {
    void agentId
    const at = writtenAt(n)
    // new = born in THIS conversation (the note's own origin), never a guess by date
    const isNew = hereId !== undefined && n.origin === hereId
    out.push({
      key: n.path,
      kind: 'memory',
      title: noteTitle(n.name),
      sub: n.author ? `${nameOf(n.author)} · ${n.description ?? ''}` : n.description,
      mtime: at,
      marker: isNew ? 'new' : n.inIndex === false ? 'outside' : null,
      group: ERA_LABEL[eraOf(at, now)],
      // born in THIS conversation → its own, the first group of the scoped list
      owner: isNew ? 'conversation' : 'project',
      ...(isNew || !m.rows ? {} : { qual: 'auto memory' }),
      memory: { ...n, layer: 'auto' },
      search: `${n.name} ${n.description ?? ''} ${n.type ?? ''} ${n.author ? nameOf(n.author) : ''}`.toLowerCase(),
    })
  }
  return out
}

// skills by where they come from and whether the engine loads them — the
// three ON groups are all in every conversation (as name + description).
// "Could add" is exactly what Add can do: Silos' own skills the folder
// doesn't load yet. A skill merely SEEN elsewhere (a transcript, another
// agent's folder, a plugin that is off here) is neither this agent's nor the
// folder's — it isn't listed here (Settings › Skills keeps the inventory).
const SKILL_GROUP = {
  role: 'From Agent — role skills',
  own: 'From Project — its folder',
  personal: 'From This machine',
  plugin: 'From This machine — plugins',
  account: 'From Your Claude account',
  held: 'Turned off',
  available: 'From Silos platform — could add',
} as const
/** the scoped group of a skill the Claude account sends: its login (the Tools grammar, loads-view.ts groupOf) */
const accountGroup = (s: SkillCatalogEntry): string => `account:${s.account?.unmatched ? '?' : (s.account?.login ?? '')}`
const SKILL_ORDER: string[] = Object.values(SKILL_GROUP)

export function skillRows(src: KnowsSources, agentId?: string): Row[] {
  const stateOf = (s: SkillCatalogEntry): NonNullable<SkillCatalogEntry['state']> =>
    s.state ?? (s.source === 'project' || s.source === 'user' || s.source === 'plugin' || s.shadowed !== undefined ? 'active' : 'seen')
  return (src.catalog ?? [])
    .filter((s) => stateOf(s) !== 'seen')
    .map((s) => {
      const state = stateOf(s)
      // the role's own skills travel as a launch root named after the agent
      // (role-plugin.ts): the one skills group the AGENT owns
      const role = s.source === 'plugin' && agentId !== undefined && s.plugin === agentId
      const group =
        s.source === 'account'
          ? SKILL_GROUP.account
          : state === 'held'
            ? SKILL_GROUP.held
            : state === 'available'
              ? SKILL_GROUP.available
              : role
                ? SKILL_GROUP.role
                : s.source === 'plugin'
                  ? SKILL_GROUP.plugin
                  : s.source === 'user'
                    ? SKILL_GROUP.personal
                    : SKILL_GROUP.own
      // a plugin skill's name carries its plugin ("superpowers:brainstorming")
      // the folder's copies (and what is held out) are the project's; what
      // could be added comes from Silos — never «from this project» before it
      // is added; personal and plugin skills are this machine's
      const owner: Owner =
        s.source === 'account'
          ? 'account'
          : role
            ? 'agent'
            : state === 'available'
              ? 'silos'
              : s.source === 'user' || (s.source === 'plugin' && state === 'active')
                ? 'you'
                : 'project'
      // a name can list twice (a personal skill + this folder's held copy, an
      // account's copy per login)
      return {
        key: s.source === 'account' ? `skill:account:${accountGroup(s)}:${s.name}` : `skill:${state}:${s.name}`,
        kind: 'skills' as const,
        title: s.name,
        sub: s.description,
        mono: true,
        group,
        owner,
        skill: s,
        search: `${s.name} ${s.description ?? ''}`.toLowerCase(),
      }
    })
}

// `here`: the paths THIS conversation wrote (its transcript) — a file of the
// agent's that this conversation wrote is listed as the conversation's own,
// beside what the owner gave it alone (scope 'conversation').
const HERE_GROUP = 'From This conversation'
// The agent's files below the top level of its context: the papers its
// conversations produced. Still the agent's own, but told to NO conversation
// at start (only the top level is) — so they are their own group, after it.
const PAPERS = 'agent:papers'
const isPaper = (r: Row): boolean => r.owner === 'agent' && r.file?.scope === 'agent' && r.file.rel.includes('/')
// a Memory group whose owner makes two (spec memory-places §3): `<owner>|<qualifier>`
const qualOfGroup = (g: string): string => (g.includes('|') ? g.slice(g.indexOf('|') + 1) : '')
const ownerOfGroup = (g: string): Owner =>
  g === PAPERS ? 'agent' : g.includes('|') ? (g.slice(0, g.indexOf('|')) as Owner) : g.startsWith('account:') || g === SEEN ? ownerOfToolGroup(g) : (g as Owner)
/** the heads' order, and so the «From» chips': by origin, the subject first */
const originOrder = (a: string, b: string): number =>
  byOwnerOrder(ownerOfGroup(a), ownerOfGroup(b)) ||
  (a === PAPERS ? 1 : b === PAPERS ? -1 : 0) ||
  QUALIFIER_ORDER.indexOf(qualOfGroup(a)) - QUALIFIER_ORDER.indexOf(qualOfGroup(b)) ||
  a.localeCompare(b)
function fileRows(
  files: ContextFile[],
  kind: 'context' | 'produced' | 'files',
  groupOf: (f: ContextFile) => string,
  working = false,
  here?: ReadonlySet<string>,
): Row[] {
  return files.map((f) => ({
    key: f.path,
    kind,
    title: f.scope === 'conversation' ? f.name : f.rel,
    mono: true,
    mtime: f.mtime,
    group: f.scope === 'conversation' || here?.has(f.path) ? HERE_GROUP : groupOf(f),
    owner: (f.scope === 'conversation' || here?.has(f.path) ? 'conversation' : f.scope === 'shared' ? 'project' : 'agent') as Owner,
    sub: working ? 'working file' : undefined,
    file: f,
    search: f.rel.toLowerCase(),
  }))
}

// the MCP servers a conversation starts with (the engine's own reading):
// the folder's .mcp.json is the project's; your settings and plugins are
// your machine's; claude.ai connectors are the Claude account's.
// Where the folder is a project, Tools are its INVENTORY instead
// (src.loads): every plugin, MCP server and connector its conversations
// load, grouped by owner (the Claude account per login), a plugin holding
// its servers. The project's page shows every row with its state; the
// agent's shows what loads for it (and what it alone holds, in place), its
// plain switch only that agent's line, and counts the rest at the foot.
function ownToolSub(r: OwnToolRow, agentName: string): string {
  const needs = r.needs.length > 0 ? ` · needs ${r.needs.join(', ')} in Secrets` : ''
  if (r.state === 'held') return `off — new conversations of ${agentName} won't load it${needs}`
  return `${r.detail}${needs}`
}

/** the inventory's rows as the list draws them: one per top-level thing, a
 *  plugin carrying its servers (`scope` agent: what loads for that agent and
 *  what it alone holds, kept in place — the project's own switch stripped:
 *  the agent's page switches the agent's line) */
const readOnly = (r: LoadsRow): LoadsRow => {
  const { switch: _sw, refused: _rf, ...rest } = r
  void _sw
  void _rf
  return rest
}
export function inventoryRows(loads: FolderLoads, scope: 'agent' | 'project' | undefined, now: number = Date.now(), page: PlacesPage | null = null): Row[] {
  const me = page?.scope === 'agent' ? page.agentId : undefined
  const rows = scope === 'agent' ? agentRows(loads.rows, me) : loads.rows
  const many = loads.engines.length > 1
  // on, then off, then could add — the project's management order; on an
  // agent's page a row it turns on (or alone holds) keeps its place among what loads
  const rank = (r: LoadsRow): number =>
    me !== undefined && (loadsFor(r, me) || heldByAgent(r, me)) ? 0 : r.state === 'active' ? (r.replacedBy ? 1 : 0) : r.state === 'held' ? 2 : 3
  // the Claude account's rows by origin first (plugins, then connectors —
  // each under its head on the project's Tools)
  const kindOrder = (a: LoadsRow, b: LoadsRow): number =>
    a.kind === b.kind ? 0 : a.kind === 'plugin' ? -1 : b.kind === 'plugin' ? 1 : a.kind === 'connector' ? 1 : -1
  const byOrigin = (a: LoadsRow, b: LoadsRow): number =>
    scope === 'project' && a.origin.owner === 'account' && b.origin.owner === 'account' ? kindOrder(a, b) : 0
  const order = (a: LoadsRow, b: LoadsRow): number =>
    byOrigin(a, b) || rank(a) - rank(b) || (a.kind === b.kind ? 0 : a.kind === 'plugin' ? -1 : 1) || a.label.localeCompare(b.label)
  const toRow = (r: LoadsRow): Row => {
    const group = groupOf(r)
    // a row this agent holds does not load for it: no health on its page
    const health = heldByAgent(r, me) ? null : (healthOf(r, loads, now) ?? pluginHealth(r, loads, now))
    // where the places disagree: the phrase — and on a row that does not
    // load, it IS what the row says (a dead «decided by» never stands in its place)
    const phrase = page ? placesPhrase(r, page) : null
    return {
      ...(health ? { health } : {}),
      ...(phrase ? { phrase } : {}),
      key: r.key,
      kind: 'tools',
      title: r.label,
      mono: true,
      group,
      owner: ownerOfToolGroup(group),
      // Agent › Tools switches the agent's own line, never the project's
      // a row its engine can't switch names its file — on the project's
      // Tools in the button's place, on the agent's (no buttons) in its line
      sub:
        phrase && r.state !== 'active'
          ? many
            ? r.engine
            : ''
          : `${rowWords(r, loads)}${scope === 'agent' && r.state === 'active' && r.decidedBy && engineSwitchesNothing(r, loads) ? ` · ${r.decidedBy.file}` : ''}${many ? ` · ${r.engine}` : ''}`,
      load: scope === 'agent' ? readOnly(r) : r,
      search: `${r.label} ${r.name} ${r.origin.carrier} ${r.origin.login ?? ''}`.toLowerCase(),
    }
  }
  return topLevel(rows)
    .sort(order)
    .map((r) => {
      const row = toRow(r)
      const kids = childrenOf(rows, r.key).sort(order).map(toRow)
      return kids.length ? { ...row, children: kids, search: `${row.search} ${kids.map((k) => k.search).join(' ')}` } : row
    })
}

function toolRows(src: KnowsSources, agentName: string, scope: 'agent' | 'project' | undefined, agentId = ''): Row[] {
  // an agent's own servers come with their state from their own read; what
  // loads lists the active ones too — counted once, from the stateful read
  const own: Row[] =
    scope === 'project'
      ? []
      : (src.ownTools ?? []).map((r) => ({
          key: `own:${r.name}`,
          kind: 'tools' as const,
          title: r.name,
          mono: true,
          group: 'agent',
          owner: 'agent' as Owner,
          sub: ownToolSub(r, agentName),
          own: r,
          search: `${r.name} ${r.detail} ${r.refs.join(' ')}`.toLowerCase(),
        }))
  const page: PlacesPage | null = scope === 'project' ? { scope: 'project' } : scope === 'agent' ? { scope: 'agent', agentId, agentName } : null
  if (src.loads && src.loads.engines.length > 0) return [...own, ...inventoryRows(src.loads, scope, Date.now(), page)]
  if (scope === 'project') return []
  return [
    ...own,
    ...(src.loaded?.mcp ?? [])
      .filter((m) => src.ownTools === null || m.source !== 'agent')
      .map((m) => ({
        key: `mcp:${m.source}:${m.engineName ?? m.name}`,
        kind: 'tools' as const,
        title: m.name,
        mono: true,
        group: m.source,
        // a server of a plugin the Claude account sends is the account's, not the machine's
        owner: (m.source === 'agent' ? 'agent' : m.source === 'project' ? 'project' : m.source === 'account' || m.account ? 'account' : 'you') as Owner,
        sub:
          m.source === 'agent'
            ? `only ${agentName}`
            : m.source === 'project'
              ? 'in the folder’s .mcp.json'
              : m.source === 'plugin'
                ? // the group already names the owner (Claude account): the row says the plugin, and what is not a server of its own
                  `${m.placeholder ? 'a placeholder, left to a connector · ' : m.sameAs ? `the same server as ${m.sameAs} · ` : ''}from the ${m.from} plugin`
                : m.source === 'account'
                  ? 'a claude.ai connector its conversations used'
                  : 'in your ~/.claude.json',
        tool: m,
        search: `${m.name} ${m.from}`.toLowerCase(),
      })),
  ]
}

// the facets of a kind — each a predicate with a label; counts are computed
// over the rows that pass the search, so a chip never promises what it
// can't show
// `flat`: tested over every row, a plugin's servers included, and shown flat
/** a row's sign-in door, with what its clicks do */
interface SignInView {
  door: SignInDoorOf
  onConsole: ((draft: string) => void) | null
  onUnfold: () => void
  title?: string
  agentName: string | null
}

interface Facet {
  id: string
  label: string
  test: (r: Row) => boolean
  flat?: true
}
function facetsFor(
  kind: LibraryKind,
  rows: Row[],
  nameOf: (id: string) => string,
  byAuthor: boolean,
  me?: { id: string; name: string },
  scoped = false,
  here?: { thread: string; title: string },
): Facet[] {
  // opened from a conversation: what it keeps its own way — shown, never
  // pre-selected (spec scope-ui-review §4.3)
  const inHere = (at: readonly { place: string; conversation?: string; entry?: unknown }[] | undefined): boolean =>
    here !== undefined && (at ?? []).some((l) => l.place === 'conversation' && l.conversation === here.thread && l.entry !== undefined)
  const different: Facet[] = here
    ? [{ id: 'here-different', label: `different in «${here.title}»`, test: (r: Row) => inHere(r.load?.at ?? r.skill?.at), flat: true }]
    : []
  if (kind === 'memory') {
    const types = new Map<string, number>()
    const authors = new Map<string, number>()
    for (const r of rows) {
      if (r.memory?.layer === 'auto' && r.memory.type) types.set(r.memory.type, (types.get(r.memory.type) ?? 0) + 1)
      if (r.memory?.layer === 'auto' && r.memory.author) authors.set(r.memory.author, (authors.get(r.memory.author) ?? 0) + 1)
    }
    const unknown = rows.some((r) => r.memory?.layer === 'auto' && !r.memory.author)
    return [
      // the project's memory: who learned what (each agent's share of it).
      // Authorship is not ownership — a note learned by Builder is the
      // project's — and Silos knows the author only for conversations it
      // saw start, so the rest say so
      ...(byAuthor
        ? [...authors].sort((a, b) => b[1] - a[1]).map(([a]) => ({ id: `by:${a}`, label: `learned by ${nameOf(a)}`, test: (r: Row) => r.memory?.author === a }))
        : []),
      ...(byAuthor && unknown && authors.size > 0
        ? [{ id: 'by:unknown', label: 'author unknown', test: (r: Row) => r.memory?.layer === 'auto' && !r.memory.author }]
        : []),
      // a note's TYPE, said as one — never read as an origin («project»)
      ...[...types].sort((a, b) => b[1] - a[1]).map(([t]) => ({ id: `type:${t}`, label: `type: ${t}`, test: (r: Row) => r.memory?.type === t })),
      // scoped, what this conversation learned is an origin (its «From» chip)
      ...(scoped ? [] : [{ id: 'here', label: 'this conversation', test: (r: Row) => r.marker === 'new' }]),
      { id: 'outside-index', label: 'not in its index', test: (r) => r.memory?.inIndex === false },
      { id: 'recent', label: 'this week', test: (r) => r.memory?.layer === 'auto' && (r.mtime ?? 0) >= Date.now() - 7 * 86_400_000 },
    ]
  }
  // Tools: what waits for your sign-in — the servers themselves, flat (a
  // door from a conversation's alert opens on it; removable like any chip)
  // — and on an agent's page, what it alone keeps off (the foot's door)
  if (kind === 'tools')
    return [
      ...different,
      { id: 'sign-in', label: 'need your sign-in', test: (r) => r.load !== undefined && needsSignIn(r.load), flat: true },
      ...(me
        ? [{ id: 'agent-off', label: `off for ${me.name}`, test: (r: Row) => r.load !== undefined && heldByAgent(r.load, me.id), flat: true as const }]
        : []),
      // what a wider or a narrower place holds (spec scopes §4): the machine's
      // own «off», and any agent's of the project
      {
        id: 'machine-off',
        label: 'off on this machine',
        test: (r) => r.load?.at?.some((l) => l.place === 'machine' && l.entry === 'off') === true,
        flat: true,
      },
      ...(me
        ? []
        : [
            {
              id: 'any-agent-off',
              label: 'off for an agent',
              test: (r: Row) => r.load?.at?.some((l) => l.place === 'agent' && l.entry === 'off') === true,
              flat: true as const,
            },
          ]),
    ]
  if (kind === 'skills')
    return [
      ...different,
      {
        id: 'machine-off',
        label: 'off on this machine',
        test: (r) => r.skill?.at?.some((l) => l.place === 'machine' && l.entry === 'off') === true,
        flat: true,
      },
      {
        id: 'any-agent-off',
        label: me ? `off for ${me.name}` : 'off for an agent',
        test: (r) => r.skill?.at?.some((l) => l.place === 'agent' && l.entry === 'off' && (!me || l.agent === me.id)) === true,
        flat: true,
      },
    ]
  return []
}

// on, then held, then could-add — the project's management order
const skillRank = (r: Row): number => (({ active: 0, held: 1, available: 2 }) as Record<string, number>)[r.skill?.state ?? 'active'] ?? 0

const ERA_ORDER: string[] = ['Always in its head', ...(['today', 'week', 'month', 'earlier'] as Era[]).map((e) => ERA_LABEL[e])]

const NO_DIRTY = (): void => {}
const LEAVE = (leave: () => void): void => leave()

export function KnowsLibrary({
  agent,
  src,
  focus,
  wide,
  kinds: only,
  bare = false,
  onKindChange,
  memoryScope = 'all',
  filesScope = 'all',
  scoped,
  hereId,
  hereFolder,
  fromConversation,
  from,
  onClose,
  onDirty = NO_DIRTY,
  guard = LEAVE,
}: {
  agent: AgentView
  src: KnowsSources
  focus: LibraryFocus
  wide: boolean
  /** the kinds this library shows (a section of the agent page shows its own) */
  kinds?: LibraryKind[]
  /** no kinds row — the section already names what this is */
  bare?: boolean
  /** the operator moved to another kind (the page writes it to the URL) */
  onKindChange?: (k: LibraryKind) => void
  /** which memory: the agent's own + what it learned, the project's, or all */
  memoryScope?: MemoryScope
  /** which context files: the agent's deliverables, the folder's shared ones, or all */
  filesScope?: 'agent' | 'project' | 'all'
  /** the page this library sits on: rows group by OWNER with a filter over them; each inherited
   *  group says whom else it reaches and links to its house, and switches
   *  only appear where the page IS the house */
  scoped?: 'agent' | 'project'
  /** the open conversation: a note it wrote is marked new */
  hereId?: string
  // the transcript folder of that conversation — given when the library is
  // NOT inside it (the agent page), so what it wrote can still be read
  hereFolder?: string
  /** opened from a conversation (the drawer): Upload offers «This conversation» */
  fromConversation?: FromConversation
  /** an agent's page opened from one of its conversations (spec
   *  scope-ui-review §4.3): each row's «Where it loads» gains that
   *  conversation's line, with its switch — the rows already carry it */
  from?: PlacesFrom
  onClose?: () => void
  /** an editor in it holds an unsaved draft (the drawer asks before dropping it) */
  onDirty?: (dirty: boolean) => void
  /** run a step that would drop the draft only once the owner said so */
  guard?: (leave: () => void) => void
}) {
  const [kind, setKind] = useState<LibraryKind>(focus.kind)
  const [query, setQuery] = useState('')
  const [facet, setFacet] = useState<string | null>(focus.filter ?? null)
  const [sort, setSort] = useState<'recent' | 'az'>('recent')
  const [openKey, setOpenKey] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  // "+ Write a note" / "+ Upload": the add form takes the open item's place
  const [adding, setAdding] = useState(false)
  const [now] = useState(() => Date.now())
  // a new focus from outside (a click on the anatomy, a door naming one
  // item) re-aims the library
  const [wanted, setWanted] = useState<string | null>(focus.item ?? null)
  useEffect(() => {
    setKind(focus.kind)
    setFacet(focus.filter ?? null)
    setOpenKey(null)
    setQuery('')
    setAdding(false)
    setWanted(focus.item ?? null)
  }, [focus.kind, focus.filter, focus.item])
  useEffect(() => {
    setAdding(false)
  }, [kind])
  // «+ Write instructions» (spec memory-places §5): its own pane, the place picker
  const [writing, setWriting] = useState(false)
  useEffect(() => {
    setWriting(false)
  }, [kind, agent.id])

  const agents = useStore((s) => s.agents)
  const nameOf = (id: string): string => agents.find((a) => a.id === id)?.name ?? id
  // opened from a conversation: what the owner gave it alone (its thread's
  // folder) and what it wrote come first, as «This conversation»
  const contextVersion = useStore((s) => s.knowsVersion.context)
  const [givenHere, setGivenHere] = useState<ContextFile[]>([])
  const [givenTick, setGivenTick] = useState(0)
  useEffect(() => {
    if (hereId === undefined || !agent.folder) {
      setGivenHere([])
      return
    }
    let cancelled = false
    Promise.resolve()
      .then(() => api.context.list(agent.id, hereId))
      .then((v) => {
        if (!cancelled) setGivenHere(v?.conversation ?? [])
      })
      .catch(() => {
        if (!cancelled) setGivenHere([])
      })
    return () => {
      cancelled = true
    }
  }, [agent.id, agent.folder, hereId, contextVersion, givenTick])
  const liveFiles = useStore((s) => (hereId !== undefined && s.detail?.meta.id === hereId ? s.detail.context?.files : undefined))
  const [readFiles, setReadFiles] = useState<SessionContext['files'] | undefined>(undefined)
  const needsRead = hereId !== undefined && hereFolder !== undefined && liveFiles === undefined
  useEffect(() => {
    setReadFiles(undefined)
    if (!needsRead) return
    let cancelled = false
    Promise.resolve()
      .then(() => api.sessionDetail(hereFolder!, hereId!, Number.MAX_SAFE_INTEGER))
      .then((d) => {
        if (!cancelled) setReadFiles(d?.context?.files ?? [])
      })
      .catch(() => {
        if (!cancelled) setReadFiles([])
      })
    return () => {
      cancelled = true
    }
  }, [hereId, hereFolder, needsRead])
  const writtenFiles = liveFiles ?? readFiles
  const writtenHere = useMemo(() => new Set((writtenFiles ?? []).filter((f) => f.writes + f.edits > 0).map((f) => f.path)), [writtenFiles])
  const all = useMemo<Record<LibraryKind, Row[]>>(
    () => ({
      memory: memoryRows(src, hereId, now, memoryScope, agent.id, nameOf, agent.name),
      skills: skillRows(src, agent.id),
      // context files: what the agent wrote for you (context/<agent>) vs what
      // the folder shares (context/shared) — never "what you gave it" for both
      context: fileRows(
        [...givenHere, ...(filesScope !== 'agent' ? (src.context?.shared ?? []) : []), ...(filesScope !== 'project' ? (src.context?.agent ?? []) : [])],
        'context',
        (f) => (f.scope === 'shared' ? 'From Project' : `From Agent · ${agent.name}`),
        false,
        writtenHere,
      ),
      produced: fileRows(src.produced ?? [], 'produced', (f) => (f.rel.includes('/') ? `${f.rel.slice(0, f.rel.indexOf('/'))}/` : 'Top level')),
      start: [],
      // every file the agent reaches: its own, its working files, the shared
      files: [
        ...fileRows(
          [
            ...givenHere,
            ...(filesScope !== 'agent' || scoped ? (src.context?.shared ?? []) : []),
            ...(filesScope !== 'project' ? (src.context?.agent ?? []) : []),
          ],
          'files',
          () => '',
          false,
          writtenHere,
        ),
        ...(filesScope !== 'project' ? fileRows(src.produced ?? [], 'files', () => '', true, writtenHere) : []),
      ],
      tools: toolRows(src, agent.name, scoped, agent.id),
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [src, hereId, now, agent.name, agent.id, memoryScope, filesScope, scoped, agents, givenHere, writtenHere],
  )

  const counts: Record<LibraryKind, number> = {
    memory: all.memory.filter((r) => r.memory?.layer === 'auto').length,
    skills: (src.catalog ?? []).filter((s) => (s.state ?? 'active') === 'active').length,
    context: all.context.length,
    produced: all.produced.length,
    start: (src.loaded?.injections.length ?? 0) + (src.loaded?.instructions.filter((i) => i.when === 'start').length ?? 0),
    files: all.files.length,
    tools: all.tools.length,
  }

  // a plugin's servers sit under it: lookups see them too, and an opened
  // server unfolds its plugin
  const flat = (rows: Row[]): Row[] => rows.flatMap((r) => [r, ...(r.children ?? [])])
  const [unfolded, setUnfolded] = useState<ReadonlySet<string>>(new Set())
  // the rows whose «Where it loads» is open (▾, or the phrase)
  const [whereOpen, setWhereOpen] = useState<ReadonlySet<string>>(new Set())
  const toggleWhere = (key: string): void =>
    setWhereOpen((u) => {
      const n = new Set(u)
      if (n.has(key)) n.delete(key)
      else n.add(key)
      return n
    })
  // the names its block's labels carry: «Project · acme», «Agent · 🛠 Builder», «Conversation · title»
  const placeNames = {
    project: agent.folder ? basename(agent.folder) : null,
    conversation: from?.title ?? null,
    emojiOf: (id: string) => agents.find((a) => a.id === id)?.emoji,
  }
  const placesPage: PlacesPage | null =
    scoped === 'project'
      ? { scope: 'project', names: placeNames }
      : scoped === 'agent'
        ? { scope: 'agent', agentId: agent.id, agentName: agent.name, names: placeNames, ...(from ? { from } : {}) }
        : null
  // the measured weight of each Tools row: the newest measured start in the
  // folder (one read per folder, beside its inventory)
  const weightFolder = src.loads && src.loads.engines.length > 0 ? src.loads.folder : null
  const [weight, setWeight] = useState<FolderLoadsWeight | null>(null)
  useEffect(() => {
    let cancelled = false
    setWeight(null)
    if (!weightFolder) return
    Promise.resolve()
      .then(() => api.folders.loadsWeight(weightFolder))
      .then(
        (w) => {
          if (!cancelled) setWeight(w ?? null)
        },
        () => {
          /* no weight shown */
        },
      )
    return () => {
      cancelled = true
    }
  }, [weightFolder, src.loads])
  // your personal instructions (the «Your machine» CLAUDE.md row): on, or
  // off in this project on the project's Memory; on an agent's Memory, for
  // THAT agent only (spec scopes T10) — ▾ opens where they load
  const personalFolder = kind !== 'memory' ? null : scoped === 'project' ? subjectFolder(agent) : scoped === 'agent' ? (agent.folder ?? null) : null
  const personal = usePersonal(personalFolder, src.memory, scoped === 'agent' ? { agent: agent.id } : undefined)
  const personalAgentLine = scoped === 'agent' ? personalLineOf(personal.fp, 'agent', agent.id) : null
  // opened from a conversation: its own line, read as that conversation sees them
  const personalHere = usePersonal(personalFolder && from ? from.cwd : null, src.memory, from ? { conversation: from.id } : undefined)
  const personalHereLine = from ? personalLineOf(personalHere.fp, 'conversation') : null
  const personalSubject =
    personal.subject && personalHereLine
      ? { ...personal.subject, at: [...(personal.subject.at ?? []).filter((l) => l.place !== 'conversation'), personalHereLine] }
      : personal.subject
  const personalOf = (r: Row) =>
    r.memory?.layer !== 'global'
      ? null
      : scoped === 'agent'
        ? personalAgentLine
          ? personalAgentView(personalAgentLine, personal.view, agent.name)
          : null
        : personal.view
  const [personalBusy, setPersonalBusy] = useState<string | null>(null)
  // every other instruction file's places (spec memory-places T4): the
  // folder's CLAUDE.md and auto memory (its index) — the plain switch is
  // the page's own place, ▾ the rest; the agent's own memory has none
  const instr = useInstructionPlaces(personalFolder, src.memory, scoped === 'agent' ? { agent: agent.id } : undefined)
  // opened from a conversation: that conversation's line of each file (spec
  // memory-places T5 — the column has no switches; its line lives here)
  const instrHere = useInstructionPlaces(personalFolder && from ? from.cwd : null, src.memory, from ? { conversation: from.id } : undefined)
  const instrOf = (r: Row): InstructionView | null =>
    r.memory && placesPage && (r.memory.layer === 'project' || r.memory.layer === 'index' || r.memory.layer === 'instr')
      ? instructionView(instr.fp, r.memory.path, r.title, placesPage, from ? instrHere.fp : null)
      : null
  const inertOf = (r: Row): string | null =>
    r.memory?.layer === 'agent' && placesPage ? `Silos adds it to every conversation it starts for ${agent.name} — it has no switch` : null
  async function instrAction(path: string, title: string, to: 'on' | 'off', at: Parameters<typeof instr.turn>[2]): Promise<void> {
    setActionError(null)
    try {
      await instr.turn(path, to, at)
    } catch (e) {
      setActionError(`${title}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  const weighs = (r: Row): RowWeight | null => (r.load && src.loads ? weightOf(r.load, src.loads.rows, weight) : null)
  const unfold = (key: string, on: boolean): void =>
    setUnfolded((u) => {
      const n = new Set(u)
      if (on) n.add(key)
      else n.delete(key)
      return n
    })
  // a door that named one item (a live write's file, a Tools row): once
  // the rows are read it opens — by key, else (a file, a note, a skill) by
  // the name it answers to. A Tools row opens by its exact key only: the
  // inventory made it, and a name the screen matched could be another copy
  // (the dead door, spec tools-origin §9)
  useEffect(() => {
    if (wanted === null || !src.ready) return
    // a door to the account's groups as a whole (the first minute's «Tools
    // from your Claude account ›»): the first one, its head in reach
    if (wanted === ACCOUNT_GROUP) {
      const section = document.querySelector<HTMLElement>('[data-group^="account:"]')
      section?.scrollIntoView({ block: 'start' })
      section?.querySelector<HTMLElement>('[data-origin-head]')?.focus({ preventScroll: true })
      setWanted(null)
      return
    }
    const rows = flat(all[kind])
    const bare = (x: string): string => x.slice(x.lastIndexOf('/') + 1)
    const inScope =
      focus.scope !== undefined
        ? rows.filter((r) =>
            r.memory ? r.memory.layer === focus.scope || (focus.scope === 'auto' && r.memory.layer === 'auto') : r.file ? r.file.scope === focus.scope : true,
          )
        : rows
    const hit =
      rows.find((r) => r.key === wanted) ??
      (kind === 'tools' ? undefined : (inScope.find((r) => r.file?.rel === wanted || r.title === wanted) ?? inScope.find((r) => bare(r.key) === wanted)))
    if (hit) {
      setOpenKey(hit.key)
      if (hit.load?.parent) unfold(hit.load.parent, true)
    }
    setWanted(null)
  }, [wanted, src.ready, all, kind, focus.scope])
  const kinds: LibraryKind[] =
    only ??
    (['memory', 'skills', 'context', ...(all.produced.length ? (['produced'] as const) : []), ...(src.loaded ? (['start'] as const) : [])] as LibraryKind[])

  // a link to a kind this agent doesn't have (At start on an engine that
  // can't say) lands on its first kind instead of an empty pane
  useEffect(() => {
    if (src.ready && kinds.length > 0 && !kinds.includes(kind)) setKind(kinds[0]!)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `kinds` is rebuilt each render; its joined names are the real input
  }, [src.ready, kinds.join(','), kind])

  // on the agent page Skills are what loads — the folder's held or
  // addable copies are managed on the project page
  const base = scoped === 'agent' && kind === 'skills' ? all.skills.filter((r) => (r.skill?.state ?? 'active') === 'active') : all[kind]
  const searched = base.filter((r) => !query || r.search.includes(query.toLowerCase()))
  // the page's own owner: its origin comes first
  const own: Owner = scoped ?? 'agent'
  // the ONE scope filter («From», spec scope-ui-review §3.3): a group key
  // or none; «Only» (a condition, `facet`) composes with it — each row's
  // counts are taken with the OTHER row's choice applied
  const [chosenOrigin, setChosenOrigin] = useState<string | null>(null)
  useEffect(() => {
    setChosenOrigin(null)
  }, [kind, agent.id])
  const groupKey = (r: Row): string =>
    scoped
      ? isPaper(r)
        ? PAPERS
        : r.load
          ? r.group
          : r.skill?.source === 'account'
            ? accountGroup(r.skill)
            : r.qual
              ? `${r.owner}|${r.qual}`
              : r.owner
      : sort === 'az' && kind === 'memory' && r.memory?.layer === 'auto'
        ? 'Notes, A–Z'
        : r.group
  const facets = facetsFor(
    kind,
    searched,
    nameOf,
    scoped !== undefined || memoryScope === 'project',
    scoped === 'agent' && src.loads ? { id: agent.id, name: agent.name } : undefined,
    scoped !== undefined,
    from ? { thread: from.thread, title: from.title } : undefined,
  )
  const active = facets.find((f) => f.id === facet) ?? null
  const byFrom = scoped ? fromOrigin(searched, groupKey, chosenOrigin) : searched
  // a flat facet weighs every row, a plugin's servers as rows of their own
  const poolOf = (f: Facet, rows: Row[] = byFrom): Row[] =>
    f.flat
      ? flat(rows).map(({ children: _c, ...r }) => {
          void _c
          return r
        })
      : rows
  // what passes «Only» (whatever the origin): the «From» chips count it
  const passOnly = active ? poolOf(active, searched).filter(active.test) : searched
  const shown = scoped ? fromOrigin(passOnly, groupKey, chosenOrigin) : passOnly
  const folder = agent.folder
  // the agent's own tools are added where they are listed — its own page
  const addsTool = kind === 'tools' && scoped === 'agent' && subjectFolder(agent) === null
  // the folder's own things reach the agents that START in it (their primary
  // folder) — a declared territory or a subfolder is not where they start
  const projectAgents = folder ? agents.filter((a) => a.id !== 'master' && startsIn(a, folder)) : []
  const ctx: OwnerContext = { agentName: agent.name, agentEmoji: agent.emoji, folder }
  // whom it reaches by default — said on the opened item, never on a group
  // head (there it would read as the head's button's reach)
  const reach = (o: Owner): string => {
    if (o === 'agent') return `only ${agent.name}`
    if (o === 'you') return 'every agent on this machine'
    if (o === 'silos') return kind === 'skills' ? 'added to a folder from its Skills' : 'every agent Silos starts'
    if (o === 'account') return 'every conversation on that Claude account'
    if (o === 'engine') return 'every conversation'
    if (o === 'conversation') return 'only this conversation'
    const names = projectAgents.map((a) => a.name)
    return names.length === 0 ? 'every agent working in this folder' : `every agent in this folder: ${names.join(' · ')}`
  }
  // a Claude account group names its login; the seen group names no owner
  const groupCtx = (g: string): OwnerContext => {
    const login = loginOfGroup(g)
    if (login === null) return ctx
    return { ...ctx, accountName: login === '?' ? 'login not matched yet' : login === '' ? 'login not recorded' : login }
  }
  const groupReach = (g: string): string => {
    const login = loginOfGroup(g)
    if (g === SEEN) return 'Silos can’t tell where it comes from'
    if (login === null) return reach(ownerOfGroup(g))
    if (login === '?') return 'listed by its login once a conversation here records it'
    return login === '' ? 'conversations on a login no start recorded' : 'only conversations on this login'
  }
  // what a head says after its label — only where one origin makes two
  // groups (Files), or the group has no plain origin (Seen loading, an
  // unmatched login): never a reach
  const headQualifier = (g: string): string | null => {
    if (g === PAPERS) return 'papers of its conversations, told to none'
    if (qualOfGroup(g)) return qualOfGroup(g)
    if ((kind === 'files' || kind === 'context') && g === 'agent' && all[kind].some(isPaper)) return 'told at every start'
    if (g === SEEN || loginOfGroup(g) === '?') return groupReach(g)
    return null
  }
  // a group's label, the same words on its head (after «From») and its chip
  const groupLabel = (g: string): string =>
    g === SEEN ? 'Seen loading' : `${ownerText(ownerOfGroup(g), groupCtx(g))}${g === PAPERS ? ' · papers' : qualOfGroup(g) ? ` · ${qualOfGroup(g)}` : ''}`
  const goHome = useGoHome()
  // «Sign in ›» on a row that waits for your sign-in: a new real console
  // of an agent that starts in the folder (the one whose conversation read
  // it, when it is one), the row's sentence beside it — never sent or typed
  // for you. No agent starts there: no door.
  const askSignIn = useStore((s) => s.askSignIn)
  const signInFolder = src.loads?.folder ?? null
  // every row whose line says it waits has its door, folded or flat (a
  // plugin's: its waiting server's, or unfolds to them) — the engine's way
  const signIn = (l: LoadsRow): SignInView | null => {
    const all = src.loads?.rows ?? []
    const door = signInDoorOf(l, all)
    if (!door) return null
    const reader = (l.kind === 'plugin' ? childrenOf(all, l.key).find(needsSignIn) : l)?.health?.read.agent
    const pick = signInFolder !== null ? signInAgentOf(agents, signInFolder, reader) : null
    return {
      door,
      onConsole:
        pick && signInFolder
          ? (draft) => {
              askSignIn(signInFolder, draft, reader)
            }
          : null,
      onUnfold: () => unfold(l.key, true),
      agentName: pick?.name ?? null,
      ...(pick ? { title: `Opens a console of ${pick.name}` } : {}),
    }
  }
  // «Check now» lives in the project's Tools head (ToolsCheck.tsx); its
  // reading lands on the rows, read again when it ends
  // — and on an agent's page (not a folder's), as that agent: its login,
  // started with its own switches, read as its
  const agentPage = scoped === 'agent' && subjectFolder(agent) === null
  const toolsCheck = useLoadsCheck(
    kind === 'tools' && (scoped === 'project' || agentPage) && src.loads ? folder : null,
    src.reload,
    agentPage ? agent.id : undefined,
  )
  const projectName = folder ? basename(folder) : null
  // the project's tab a kind lives on (its house there)
  const projectTab =
    kind === 'memory' ? 'memory' : kind === 'files' || kind === 'context' || kind === 'produced' ? 'files' : kind === 'skills' ? 'skills' : 'tools'
  const TAB_WORD = { memory: 'Memory', files: 'Files', skills: 'Skills', tools: 'Tools' } as const
  // a group's door to its house, in words that say what is there. Unscoped
  // (the conversation's drawer) every owner but the agent/Silos points
  // home; scoped pages point home only for what they don't own. Your
  // machine's skills land on the inventory (it lists, never switches);
  // your machine's MCP servers have no door — ~/.claude.json is a fact.
  const door = (o: Owner): { label: string; go: () => void } | null => {
    if (o === scoped || o === 'agent' || o === 'silos') return null
    if (o === 'project')
      return folder ? { label: `${TAB_WORD[projectTab]} in ${projectName} ›`, go: () => goHome({ kind: 'project', folder, tab: projectTab }) } : null
    if (o === 'you' && kind === 'memory') return { label: 'Memories in Settings ›', go: () => goHome({ kind: 'settings', tab: 'memories' }) }
    if (o === 'you' && kind === 'skills') return { label: 'Inventory ›', go: () => goHome({ kind: 'settings', tab: 'skills' }) }
    // the Claude account's skills switch in the project's Skills
    if (o === 'account' && kind === 'skills' && scoped !== 'project')
      return folder ? { label: `Skills in ${projectName} ›`, go: () => goHome({ kind: 'project', folder, tab: 'skills' }) } : null
    return null
  }
  // what the folder holds back from the agent: the folder's own skills
  // turned off or still to add, and its servers and plugins turned off —
  // said at the foot of the agent's Skills and Tools even when every row
  // is off (the list shows only what loads), with the door to switch them
  const heldSkills = scoped === 'agent' ? all.skills.filter((r) => r.skill?.state === 'held').length : 0
  const addable = scoped === 'agent' ? all.skills.filter((r) => r.skill?.state === 'available').length : 0
  // the folder's tools that don't load here: turned off, or the Claude
  // account's not added — each thing once (loads-view.ts footCounts)
  const toolsFoot = scoped === 'agent' && src.loads ? footCounts(src.loads.rows, agent.id) : { off: 0, couldAdd: 0, agentOff: 0 }
  const inProject = folder ? ` in ${basename(folder)}` : ''
  const footParts =
    kind === 'skills'
      ? [heldSkills > 0 ? `${heldSkills} turned off${inProject}` : '', addable > 0 ? `${addable} could be added${inProject}` : ''].filter(Boolean)
      : kind === 'tools'
        ? [
            toolsFoot.off > 0 ? `${toolsFoot.off} turned off${inProject}` : '',
            toolsFoot.couldAdd > 0 ? `${toolsFoot.couldAdd} could be added${inProject}` : '',
          ].filter(Boolean)
        : []
  const foot =
    scoped === 'agent' && folder && (footParts.length > 0 || (kind === 'tools' && toolsFoot.agentOff > 0)) && (kind === 'skills' || kind === 'tools') ? (
      <div className="flex shrink-0 items-baseline gap-1.5 border-t border-line px-4 py-2 text-[11.5px] text-ink-2" data-testid="library-foot">
        <span className="min-w-0 truncate">{footParts.join(' · ')}</span>
        {kind === 'tools' && toolsFoot.agentOff > 0 ? (
          // what this agent alone keeps off — kept in place, listed by its chip
          <button
            type="button"
            data-testid="foot-agent-off"
            onClick={() => {
              setFacet(facet === 'agent-off' ? null : 'agent-off')
              setOpenKey(null)
            }}
            aria-pressed={facet === 'agent-off'}
            className="min-w-0 shrink truncate text-ink-2 hover:text-terracotta"
          >
            {footParts.length > 0 ? '· ' : ''}
            {toolsFoot.agentOff} off for {agent.name} ›
          </button>
        ) : null}
        <button
          type="button"
          onClick={() => goHome({ kind: 'project', folder, tab: kind })}
          className="ml-auto shrink-0 text-[11px] text-ink-2 hover:text-terracotta"
        >
          {TAB_WORD[kind]} in {projectName} ›
        </button>
      </div>
    ) : null
  // groups: memory by era (sort recent) or one A–Z list; skills by state;
  // files by scope / top folder
  const grouped = useMemo(() => {
    const rows = [...shown]
    if (kind === 'tools' && src.loads) {
      /* the inventory's own order: on, off, could add */
    } else if (sort === 'az' && kind !== 'skills') rows.sort((a, b) => a.title.localeCompare(b.title))
    else rows.sort((a, b) => (b.mtime ?? 0) - (a.mtime ?? 0))
    const byGroup = new Map<string, Row[]>()
    for (const r of rows) {
      // scoped: one group per origin (its head says where it comes from);
      // within the project's skills on the project page, what is on first
      const g = groupKey(r)
      byGroup.set(g, [...(byGroup.get(g) ?? []), r])
    }
    if (scoped) {
      if (kind === 'skills') for (const [, rs] of byGroup) rs.sort((a, b) => skillRank(a) - skillRank(b))
      // instruction files in the engine's load order, notes after them
      if (kind === 'memory')
        for (const [, rs] of byGroup)
          rs.sort(
            (a, b) =>
              (a.memory?.layer === 'auto' ? 1 : 0) - (b.memory?.layer === 'auto' ? 1 : 0) ||
              (a.order !== undefined && b.order !== undefined ? a.order - b.order : 0),
          )
      return [...byGroup].sort(([a], [b]) => originOrder(a, b))
    }
    const order = kind === 'memory' ? [...ERA_ORDER, 'Notes, A–Z'] : kind === 'skills' ? SKILL_ORDER : null
    return [...byGroup].sort(([a], [b]) => (a === HERE_GROUP ? -1 : b === HERE_GROUP ? 1 : order ? order.indexOf(a) - order.indexOf(b) : a.localeCompare(b)))
    // eslint-disable-next-line react-hooks/exhaustive-deps -- groupKey reads only sort, kind and scoped
  }, [shown, sort, kind, scoped, src.loads])
  const tally = scoped ? originTally(passOnly, groupKey, originOrder, chosenOrigin) : null

  const open = openKey ? (flat(all[kind]).find((r) => r.key === openKey) ?? null) : null
  // wide: the first row opens by itself, so the right pane is never a void
  const firstKey = grouped[0]?.[1][0]?.key ?? null
  // (a flat facet's first row may be a plugin's server)
  const effective = adding ? null : (open ?? (wide && kind !== 'start' ? (flat(all[kind]).find((r) => r.key === firstKey) ?? null) : null))

  // a refusal is the server's own words, said where the click happened —
  // never swallowed (the list stays as it was, and says why)
  const [actionError, setActionError] = useState<string | null>(null)
  useEffect(() => {
    setActionError(null)
  }, [kind, agent.id])
  // a click that reaches more than its row (a server several plugins ship,
  // a namesake) says so first and waits for its confirmation
  const [confirming, setConfirming] = useState<string | null>(null)
  async function toolAction(r: LoadsRow, action: 'hold' | 'activate'): Promise<void> {
    const f = subjectFolder(agent)
    if (f === null || !r.switch) return
    setBusy(r.key)
    setActionError(null)
    setConfirming(null)
    try {
      await api.folders.loadsSwitch(f, r.key, action === 'hold' ? 'off' : 'on')
      src.reload()
    } catch (e) {
      setActionError(`${r.label}: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusy(null)
    }
  }
  // an agent's own line of a row's «Where it loads» (Project › Tools):
  // only that agent's launches change; the project's file is not written —
  // on Agent › Tools, the plain switch: the folder its rows were read for
  async function agentLineAction(r: LoadsRow, l: LoadsLine, to: 'on' | 'off'): Promise<void> {
    const f = subjectFolder(agent) ?? (agentPage ? (src.loads?.folder ?? null) : null)
    if (f === null || !l.agent) return
    setBusy(`line:${r.key}:${l.agent}`)
    setActionError(null)
    try {
      await api.folders.loadsSwitch(f, r.key, to, l.agent)
      src.reload()
    } catch (e) {
      setActionError(`${r.label} for ${l.agentName ?? l.agent}: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusy(null)
    }
  }
  async function personalAction(action: 'hold' | 'activate'): Promise<void> {
    setActionError(null)
    try {
      if (scoped === 'agent') await personalForAgent(agent.id, action === 'hold' ? 'off' : 'on')
      else await personal.turn(action === 'hold' ? 'off' : 'on')
    } catch (e) {
      setActionError(`Your CLAUDE.md: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  // one agent's line: kept by Silos, carried into that agent's launches
  async function personalForAgent(agentId: string, to: 'on' | 'off'): Promise<void> {
    setPersonalBusy(agentId)
    try {
      await personal.turnAt(to, { scope: 'agent', agent: agentId })
    } finally {
      setPersonalBusy(null)
    }
  }
  // the agent's own servers: switched here, the page that is their house
  async function ownToolAction(r: OwnToolRow, action: 'hold' | 'activate'): Promise<void> {
    setBusy(`own:${r.name}`)
    setActionError(null)
    try {
      await api.agents.tools.act(agent.id, r.name, action)
      src.reload()
    } catch (e) {
      setActionError(`${r.name}: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusy(null)
    }
  }
  // an account or personal skill's position, and the account's head — the
  // folder's own settings, on the project's Skills only. A click that
  // reaches more than its row (adding one while the account's skills are
  // off; a name a personal and an account skill share) says so first.
  const [positioning, setPositioning] = useState<{ key: string; to: SkillPosition } | null>(null)
  async function positionAction(r: Row, to: SkillPosition): Promise<void> {
    const f = subjectFolder(agent)
    const s = r.skill
    if (f === null || !s) return
    setBusy(r.key)
    setActionError(null)
    setPositioning(null)
    try {
      await api.folders.skillPosition(f, s.name, s.source === 'account' ? 'account' : 'personal', to)
      src.reload()
    } catch (e) {
      setActionError(`${s.name}: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusy(null)
    }
  }
  async function originAction(group: string, to: 'on' | 'off'): Promise<void> {
    const f = subjectFolder(agent)
    if (f === null) return
    setBusy(`origin:${group}`)
    setActionError(null)
    try {
      await api.folders.skillsOrigin(f, to)
      src.reload()
    } catch (e) {
      setActionError(`Skills from your Claude account: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusy(null)
    }
  }
  // the head of the plugins or connectors the Claude account sends (Tools):
  // only the origin's key, for every login of the project
  async function loadsOriginAction(origin: 'plugins' | 'connectors', to: 'on' | 'off'): Promise<void> {
    const f = subjectFolder(agent)
    if (f === null) return
    setBusy(`origin:${origin}`)
    setActionError(null)
    try {
      await api.folders.loadsOrigin(f, origin, to)
      src.reload()
    } catch (e) {
      setActionError(`${origin === 'plugins' ? 'Plugins' : 'Connectors'} from your Claude account: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusy(null)
    }
  }
  // a head's own line for one agent of its «Where it loads» (Project ›
  // Tools · Skills): that agent's launches only, its head key
  async function headAgentAction(origin: LoadsOrigin['id'], l: LoadsLine, to: 'on' | 'off'): Promise<void> {
    const f = subjectFolder(agent)
    if (f === null || !l.agent) return
    setBusy(`line:head:${origin}:${l.agent}`)
    setActionError(null)
    try {
      await api.folders.loadsOriginAt(f, origin, to, { scope: 'agent', agent: l.agent })
      src.reload()
    } catch (e) {
      setActionError(`${ORIGIN_WHAT[origin]} for ${l.agentName ?? l.agent}: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusy(null)
    }
  }
  const headOf = (origin: LoadsOrigin['id']): LoadsOrigin | undefined => src.loads?.origins?.find((x) => x.id === origin)
  const headWhereKey = (origin: LoadsOrigin['id']): string => `head:${origin}`
  const toolsHead = (origin: LoadsOrigin['id'], className?: string): ReactNode => {
    const o = headOf(origin)
    if (!o) return null
    const places = o.at && placesPage?.scope === 'project'
    return (
      <OriginHead
        head={originHeadOf(o)}
        what={ORIGIN_WHAT[origin]}
        busy={busy === `origin:${origin}`}
        onAct={(to) => void (origin === 'skills' ? originAction(`account:${origin}`, to) : loadsOriginAction(origin, to))}
        onUpdate={() => goHome({ kind: 'settings', tab: 'engines' })}
        {...(className ? { className } : {})}
        {...(places ? { where: { open: whereOpen.has(headWhereKey(origin)), onToggle: () => toggleWhere(headWhereKey(origin)) } } : {})}
      />
    )
  }
  // a head's «Where it loads», opened by its ▾: its key at every place
  const headBlock = (origin: LoadsOrigin['id']): ReactNode => {
    const o = headOf(origin)
    if (!o?.at || placesPage?.scope !== 'project' || !whereOpen.has(headWhereKey(origin))) return null
    const label = ORIGIN_WHAT[origin].replace(/^the /, '')
    const prefix = `line:head:${origin}:`
    return (
      <WhereItLoads
        row={{ key: headWhereKey(origin), label, kind: 'head', engine: o.engine, at: o.at }}
        head={origin}
        page={placesPage}
        indent={false}
        folder={src.loads?.folder ?? null}
        onChanged={() => src.reload()}
        busy={busy?.startsWith(prefix) ? busy.slice(prefix.length) : null}
        onSwitch={(l, to) => void headAgentAction(origin, l, to)}
      />
    )
  }
  // the account groups of the project's Tools carry their origins' heads
  const heads = (g: string): boolean => kind === 'tools' && scoped === 'project' && src.loads !== undefined && src.loads !== null && g.startsWith('account:')
  // «Turn all off ▾ / on ▾» (spec scopes §4): the page's own place first,
  // then the block's other places with its reach words
  const bulkFolder = kind === 'tools' && placesPage && src.loads && src.loads.engines.some((e) => e.scopes && e.scopes.length > 0) ? src.loads.folder : null
  // Skills (T15): the same head and places, where the catalog says its skills' places
  const skillsBulkFolder =
    kind === 'skills' && placesPage && src.loads && src.loads.engines.some((e) => e.scopes && e.scopes.length > 0) && (src.catalog ?? []).some((s) => s.at)
      ? src.loads.folder
      : null
  const bulkPlaces: BulkPlaceOption[] = (() => {
    if (!(bulkFolder ?? skillsBulkFolder) || !src.loads) return []
    const hasMachine = src.loads.engines.some((e) => e.scopes?.some((x) => x.id === 'machine' && x.carrier === 'file'))
    // the block's labels and reach words (loads-places.ts lineWords), one wording
    const names = projectAgents.map((a) => a.name)
    const project: BulkPlaceOption = {
      place: { scope: 'project' },
      label: ownerText('project', { folder }),
      where: placesPage?.scope === 'project' ? 'in this project' : `in ${projectName ?? 'its project'}`,
      reach: `${names.length > 0 ? `${names.join(' · ')}, and` : 'every conversation in this folder, and'} what you start here by hand`,
    }
    const machine: BulkPlaceOption[] = hasMachine
      ? [
          {
            place: { scope: 'machine' },
            label: 'This machine',
            where: 'on this machine',
            reach: 'every project and every claude on this machine, on every login Silos connects',
          },
        ]
      : []
    const only = (a: { id: string; name: string; emoji?: string }): BulkPlaceOption => ({
      place: { scope: 'agent', agent: a.id },
      label: ownerText('agent', { agentName: a.name, ...(a.emoji ? { agentEmoji: a.emoji } : {}) }),
      where: `for ${a.name}`,
      reach: `the conversations Silos starts for ${a.name} — not one started by hand`,
    })
    // opened from a conversation: it too, the narrowest
    const here: BulkPlaceOption[] = from
      ? [
          {
            place: { scope: 'conversation', conversation: from.id },
            label: conversationLabel(from.title),
            where: `in «${from.title}»`,
            reach: 'only this conversation',
          },
        ]
      : []
    if (placesPage?.scope === 'agent') return [only(agent), project, ...machine, ...here]
    return [project, ...machine, ...projectAgents.slice(0, 5).map(only)]
  })()
  const bulkHead = (group: string, rows: Row[], className?: string): ReactNode => {
    if (!bulkFolder || !src.loads || bulkPlaces.length === 0) return null
    const loadRows = flat(rows)
      .map((r) => r.load)
      .filter((l): l is LoadsRow => l !== undefined)
    if (loadRows.length === 0) return null
    const origins = [
      ...new Set(loadRows.map((l) => originOfRow(l, src.loads!)?.id).filter((id): id is 'plugins' | 'connectors' => id === 'plugins' || id === 'connectors')),
    ]
    const anyOn = loadRows.some((l) => (placesPage?.scope === 'agent' ? loadsFor(l, agent.id) : l.state === 'active'))
    return (
      <BulkHead
        folder={bulkFolder}
        group={group}
        keys={loadRows.map((l) => l.key)}
        origins={origins}
        anyOn={anyOn}
        places={bulkPlaces}
        undo={src.loads.undo ?? []}
        onChanged={() => src.reload()}
        className={className}
      />
    )
  }
  // a head of Skills: the group's skills that have places (a plugin's and
  // one Silos could add have none); the Claude account's go by their head
  const skillsBulkHead = (group: string, rows: Row[], className?: string): ReactNode => {
    if (!skillsBulkFolder || !src.loads || bulkPlaces.length === 0) return null
    const skills = rows.map((r) => (r.skill?.at ? bulkSkillOf(r.skill) : null)).filter((s): s is BulkSkill => s !== null)
    if (skills.every((s) => s.from === 'plugin')) return null
    const lineHere = (s: SkillCatalogEntry) =>
      s.at?.find((l) => (placesPage?.scope === 'agent' ? l.place === 'agent' && l.agent === agent.id : l.place === 'project'))
    const anyOn = rows.some((r) => r.skill && (lineHere(r.skill) ? lineHere(r.skill)!.result !== 'off' : r.skill.state === 'active'))
    return (
      <BulkHead
        folder={skillsBulkFolder}
        group={`skills:${group}`}
        keys={[]}
        origins={skills.some((s) => s.from === 'account') ? ['skills'] : []}
        skills={skills}
        anyOn={anyOn}
        places={bulkPlaces}
        undo={src.loads.undo ?? []}
        onChanged={() => src.reload()}
        className={className}
      />
    )
  }
  const accountShared = all.skills.filter((x) => x.skill?.source === 'account' && x.skill.sameName).map((x) => x.skill!.name)
  const positionReach = (r: Row, to: SkillPosition): string | null => {
    const s = r.skill
    if (!s) return null
    const parts: string[] = []
    if (s.source === 'account' && s.origin && !s.origin.on && to !== 'off') {
      const along = accountShared.filter((n) => n !== s.name)
      parts.push(
        `Adds only ${s.name} — the others your Claude account sends stay off${along.length ? ` (except ${along.join(', ')}, named like your personal skill${along.length > 1 ? 's' : ''})` : ''}; what it sends later will load here`,
      )
    }
    if (s.sameName) parts.push(sameNameWords(s))
    return parts.length ? parts.join('. ') : null
  }
  // a skill's «This project» line in its «Where it loads» (Project › Skills):
  // a folder copy holds or comes back; any other, its project position —
  // with the same asks as the row's own control
  function projectLineAction(r: Row, to: SkillPosition): void {
    const s = r.skill
    if (!s) return
    if (s.source !== 'account' && s.source !== 'user') {
      void skillAction(s, to === 'off' ? 'hold' : 'activate')
      return
    }
    if (positionReach(r, to) && positioning?.key !== r.key) setPositioning({ key: r.key, to })
    else void positionAction(r, to)
  }
  async function skillAction(s: SkillCatalogEntry, action: 'hold' | 'activate' | 'add'): Promise<void> {
    setBusy(s.name)
    setActionError(null)
    try {
      await knowsDoors.skillState(agent, s.name, action)
      src.reload()
    } catch (e) {
      setActionError(`${s.name}: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusy(null)
    }
  }

  // «Check now ›» on the notices-only line is a door to the Tools head's
  // own control (it names the login and says its cost before the click):
  // brought into view and focused, never clicked for him
  const toCheckNow = focusCheckNow

  const header = (
    <div className="flex shrink-0 items-center gap-2 border-b border-line px-4 py-2.5">
      <p className="min-w-0 flex-1 truncate text-sm">
        <span className="font-medium text-ink">What {agent.name} knows</span>
      </p>
      {onClose ? (
        <>
          <kbd className="shrink-0 rounded border border-line px-1 font-mono text-[10px] text-ink-2">Esc</kbd>
          <button type="button" aria-label="Close" onClick={onClose} className="shrink-0 rounded-md p-1 text-ink-2 hover:bg-panel hover:text-ink">
            <X size={15} aria-hidden="true" />
          </button>
        </>
      ) : null}
    </div>
  )

  // the kinds: inside a section (wide) a segmented control — the second
  // level; in the drawer (narrow) the library IS the top level, so tabs
  const kindNav = wide ? (
    <div className="flex shrink-0 items-center border-b border-line px-3 py-2">
      <SubNav
        label="Kinds"
        value={kind}
        onChange={(k) =>
          guard(() => {
            setKind(k)
            setFacet(null)
            setOpenKey(null)
            onKindChange?.(k)
          })
        }
        items={kinds.map((k) => [
          k,
          <>
            {KIND_LABEL[k]} <span className="font-mono text-[10.5px] tabular-nums text-ink-3">{counts[k]}</span>
          </>,
        ])}
      />
    </div>
  ) : (
    <nav aria-label="Kinds" className="flex shrink-0 gap-4 overflow-x-auto border-b border-line px-4">
      {kinds.map((k) => (
        <button
          key={k}
          type="button"
          onClick={() =>
            guard(() => {
              setKind(k)
              setFacet(null)
              setOpenKey(null)
              onKindChange?.(k)
            })
          }
          aria-current={k === kind || undefined}
          className={`-mb-px whitespace-nowrap border-b-2 py-2 text-[12.5px] ${k === kind ? 'border-terracotta text-ink' : 'border-transparent text-ink-2 hover:text-ink'}`}
        >
          {KIND_LABEL[k]} <span className="font-mono text-[10.5px] text-ink-3">{counts[k]}</span>
        </button>
      ))}
    </nav>
  )

  // an agent without a folder has nowhere to keep context files: say so,
  // and offer neither a search over nothing nor an Upload that cannot land
  const noFolder = kind === 'context' && !agent.folder
  const list = noFolder ? (
    <div className="min-h-0 flex-1 overflow-y-auto px-4 py-6 text-sm text-ink-2">
      <p className="text-ink">No project folder</p>
      <p className="mt-1">
        Context files live in a project folder, and {agent.name} works without one — there is nowhere to keep them. Give the agent a folder to add context
        files.
      </p>
    </div>
  ) : kind === 'start' ? (
    <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
      {src.loaded ? (
        <LoadedAtStartRow
          loaded={src.loaded}
          agentName={agent.name}
          folder={agent.folder}
          onOpenMemory={() => {
            setKind('memory')
            setFacet(null)
            setOpenKey(null)
            onKindChange?.('memory')
          }}
        />
      ) : null}
    </div>
  ) : (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 space-y-2 px-3 pb-2 pt-3">
        <label className="flex items-center gap-2 rounded-md border border-line bg-canvas px-2.5 py-1.5 focus-within:border-ink-3">
          <Search size={13} aria-hidden="true" className="text-ink-3" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={`Search ${KIND_LABEL[kind].toLowerCase()}`}
            className="min-w-0 flex-1 bg-transparent text-[13px] text-ink outline-none placeholder:text-ink-3"
          />
        </label>
        {kind === 'tools' && (scoped === 'project' || agentPage) && src.loads ? (
          <CheckHead check={toolsCheck} {...(agentPage ? { agentName: agent.name } : {})} />
        ) : null}
        {tally && searched.length > 0 && showsOriginRow(tally) ? (
          <OriginFilter
            tally={tally}
            labelOf={groupLabel}
            value={chosenOrigin}
            onChange={(g) => {
              setChosenOrigin(g)
              setOpenKey(null)
            }}
          />
        ) : null}
        {(kind === 'skills' ? facets.some((f) => facet === f.id || poolOf(f).some(f.test)) : facets.length > 0) ||
        kind === 'memory' ||
        kind === 'context' ||
        kind === 'produced' ||
        kind === 'files' ||
        addsTool ? (
          <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Only">
            {/* «Only»: a condition, the second axis — its lead only while a chip shows */}
            {facets.some((f) => facet === f.id || poolOf(f).some(f.test)) ? <span className="mr-0.5 font-mono text-[10.5px] text-ink-3">Only</span> : null}
            {facets.map((f) => {
              const n = poolOf(f).filter(f.test).length
              if (n === 0 && facet !== f.id) return null
              const on = facet === f.id
              // the sign-ins all at one outside page (connectors only): that
              // page beside the chip — a mixed set, each row its own door
              const link =
                f.id === 'sign-in'
                  ? sharedLink(
                      poolOf(f)
                        .filter(f.test)
                        .map((r) => r.load?.signIn),
                    )
                  : null
              const beside = link ? <SignInDoor key={`${f.id}-door`} door={link} onConsole={null} testId="sign-in-all" className="text-[11px]" /> : null
              // a door narrowed the list (a flat facet): Tasks' removable chip
              if (on && f.flat)
                return [<NarrowChip key={f.id} testId={`facet-${f.id}`} label={f.label} value={String(n)} onClear={() => setFacet(null)} />, beside]
              return [
                <button
                  key={f.id}
                  type="button"
                  aria-pressed={on}
                  onClick={() => setFacet(on ? null : f.id)}
                  className={`rounded-full border px-2 py-0.5 font-mono text-[10.5px] tabular-nums ${on ? 'border-ink bg-ink text-canvas' : f.id === 'outside-index' ? `border-line ${AMBER} hover:border-current` : 'border-line text-ink-2 hover:border-ink-3 hover:text-ink'}`}
                >
                  {f.label} {n}
                </button>,
                beside,
              ]
            })}
            {kind !== 'skills' ? (
              <span className="ml-auto flex items-center gap-2 font-mono text-[10.5px] text-ink-3">
                {kind === 'memory' && scoped && (src.memory?.places?.length ?? 0) > 0 ? (
                  <button
                    type="button"
                    data-testid="write-instructions-open"
                    onClick={() =>
                      guard(() => {
                        setWriting(true)
                        setAdding(false)
                        setOpenKey(null)
                      })
                    }
                    className="flex items-center gap-0.5 rounded-full border border-line px-2 py-0.5 font-sans text-[11px] text-ink-2 hover:border-terracotta hover:text-terracotta"
                  >
                    <Plus size={10} aria-hidden="true" />
                    Write instructions
                  </button>
                ) : null}
                {kind === 'memory' || kind === 'context' || kind === 'files' || addsTool ? (
                  <button
                    type="button"
                    onClick={() =>
                      guard(() => {
                        setAdding(true)
                        setWriting(false)
                        setOpenKey(null)
                      })
                    }
                    className="mr-1 flex items-center gap-0.5 rounded-full border border-line px-2 py-0.5 font-sans text-[11px] text-ink-2 hover:border-terracotta hover:text-terracotta"
                  >
                    <Plus size={10} aria-hidden="true" />
                    {kind === 'memory' ? 'Write a note' : addsTool ? 'Add a tool' : 'Upload'}
                  </button>
                ) : null}
                {/* the inventory keeps its own order (on, off, could add) */}
                {(kind === 'tools' && src.loads ? [] : (['recent', 'az'] as const)).map((s) => (
                  <button key={s} type="button" aria-pressed={sort === s} onClick={() => setSort(s)} className={sort === s ? 'text-ink' : 'hover:text-ink'}>
                    {s === 'recent' ? 'recent' : 'a–z'}
                  </button>
                ))}
              </span>
            ) : null}
          </div>
        ) : null}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto pb-3">
        {kind === 'skills' && scoped === 'project' && shown.some((r) => r.skill?.switches) ? (
          <p className="px-4 pb-1 text-[11.5px] leading-snug text-ink-3" data-testid="positions-legend">
            <span className="text-ink-2">name only</span> lists a skill without its description — lighter, still callable.
          </p>
        ) : null}
        {/* what a plain switch here reaches, said once for the tab (never a pill per row) */}
        {kind === 'tools' && agentPage && src.loads?.rows.some((x) => agentLineOf(x, agent.id)?.switch) ? (
          <p className="px-4 pt-2 text-[11.5px] leading-snug text-ink-3" data-testid="switch-reach">
            <span className="text-ink-2">A switch here is for {agent.name}.</span> <ChevronDown size={11} aria-label="▾" className="inline -mt-px" /> on a row:
            this machine, its project{from ? <>, or «{from.title}»</> : null}. New conversations only.
          </p>
        ) : null}
        {/* an agent that reaches other folders (spec memory-places §5): one
            line, no rows — the engine reads instructions only from the
            folder a conversation starts in */}
        {kind === 'memory' && agentPage && (src.memory?.alsoWorksIn?.length ?? 0) > 0 ? (
          <p className="px-4 pt-2 text-[11.5px] leading-snug text-ink-3" data-testid="memory-also-works-in">
            <span className="text-ink-2">
              {agent.name} also works in {src.memory!.alsoWorksIn!.map((f) => basename(f)).join(', ')}
            </span>{' '}
            — instruction files there do not load; they are read from the folder a conversation starts in.
          </p>
        ) : null}
        {actionError ? (
          <p role="alert" className="mx-4 mt-2 rounded-md border border-terracotta/40 px-2.5 py-1.5 text-[12px] leading-snug text-terracotta">
            {actionError}
          </p>
        ) : null}
        {kind === 'tools' && scoped && src.loads && engineLimitWords(src.loads).length > 0 ? (
          // an engine with the inventory alone: why its rows have no switch
          // and no health, said once
          <div className="mx-4 mt-2 space-y-0.5 text-[11.5px] leading-snug text-ink-3" data-testid="loads-engine-limits">
            {engineLimitWords(src.loads).map((w) => (
              <p key={w}>{w}</p>
            ))}
          </div>
        ) : null}
        {kind === 'tools' && scoped === 'project' && src.loads && noticesOnlyWords(src.loads) ? (
          // no status reading here yet: what the health rests on, and the
          // one way to read it whole — the Tools head's «Check now»
          <p className="mx-4 mt-2 flex flex-wrap items-baseline gap-x-2 text-[11.5px] leading-snug text-ink-3" data-testid="loads-notices-only">
            <span className="min-w-0">{noticesOnlyWords(src.loads)}</span>
            <button type="button" onClick={toCheckNow} className="shrink-0 text-ink-2 hover:text-terracotta">
              Check now ›
            </button>
          </p>
        ) : null}
        {!src.ready && shown.length === 0 ? <p className="px-4 py-3 text-[13px] text-ink-2">Reading…</p> : null}
        {src.ready && shown.length === 0 ? (
          <p className="px-4 py-3 text-[13px] text-ink-2">
            {query || active
              ? 'Nothing matches.'
              : kind === 'tools' && src.loads
                ? scoped === 'agent'
                  ? 'Nothing loads here — no MCP server, plugin or connector.'
                  : src.loads.engines.every((e) => !e.switches)
                    ? 'Nothing configured here — no MCP server in this project’s config or yours.'
                    : 'Nothing configured here — no .mcp.json in the folder, no plugins installed, nothing from your Claude account yet.'
                : `No ${KIND_LABEL[kind].toLowerCase()} yet.`}
          </p>
        ) : null}
        {/* the tab's own head: every row it lists, at the page's place or ▾ another */}
        {kind === 'tools' && bulkFolder && !query && !active && shown.length > 0 ? (
          <div className="flex flex-wrap items-baseline gap-x-2 px-4 pt-2.5 text-[11.5px] text-ink-3" data-testid="tab-head">
            <span className="min-w-0 truncate">
              Everything listed here <span className="font-mono text-[10.5px] tabular-nums">{shown.length}</span>
            </span>
            {bulkHead('tab', shown, 'ml-auto')}
          </div>
        ) : null}
        {grouped.map(([g, rows]) => (
          <section
            key={g}
            data-group={g}
            aria-label={
              scoped
                ? g === SEEN
                  ? 'Seen loading'
                  : `${ownerOriginText(ownerOfGroup(g), groupCtx(g))}${g === PAPERS ? ' — papers' : qualOfGroup(g) ? ` — ${qualOfGroup(g)}` : ''}`
                : g
            }
          >
            {scoped ? (
              // the origin, said once per group and nothing else: «From ·
              // label · count» and one control — the bulk button where the tab
              // switches, the door to its house where it doesn't. No reach
              // words (they would read as the button's reach); an open menu
              // lifts its head over the next sticky one
              <div
                className="sticky top-0 z-[1] flex flex-wrap items-baseline gap-1.5 bg-panel/95 px-4 pb-1.5 pt-3 backdrop-blur-sm focus-within:z-[3] has-[[role=menu]]:z-[3]"
                data-testid="owner-header"
              >
                {g === SEEN ? (
                  <span className="min-w-0 shrink truncate text-[11.5px] font-medium text-ink">Seen loading</span>
                ) : (
                  <OwnerLabel owner={ownerOfGroup(g)} ctx={groupCtx(g)} size="sm" className="min-w-0 shrink font-medium" from />
                )}
                <span className="font-mono text-[10.5px] tabular-nums text-ink-3">{rows.length}</span>
                {headQualifier(g) ? <span className="min-w-0 truncate text-[11px] text-ink-3">· {headQualifier(g)}</span> : null}
                {kind === 'skills' && scoped === 'project' && rows[0]?.skill?.source === 'account' && rows[0].skill.origin ? (
                  <OriginHead
                    head={{
                      on: rows[0].skill.origin.on,
                      switches: rows[0].skill.origin.switches === true,
                      refused: rows[0].skill.origin.decidedBy ? decidedWords(rows[0].skill.origin.decidedBy) : null,
                      ...(headOf('skills') ? { offWhere: originHeadOf(headOf('skills')!).offWhere } : {}),
                    }}
                    what="the skills your Claude account sends"
                    busy={busy === `origin:${g}`}
                    onAct={(to) => void originAction(g, to)}
                    {...(headOf('skills')?.at
                      ? { where: { open: whereOpen.has(headWhereKey('skills')), onToggle: () => toggleWhere(headWhereKey('skills')) } }
                      : {})}
                    bare={skillsBulkHead(g, rows) !== null}
                  />
                ) : null}
                {kind === 'skills' && skillsBulkFolder && g !== SEEN && skillsBulkHead(g, rows) !== null ? (
                  skillsBulkHead(
                    g,
                    rows,
                    kind === 'skills' && scoped === 'project' && rows[0]?.skill?.source === 'account' && rows[0].skill.origin ? '' : 'ml-auto',
                  )
                ) : kind === 'skills' && scoped === 'project' && rows[0]?.skill?.source === 'account' && rows[0].skill.origin ? null : kind === 'tools' &&
                  bulkFolder &&
                  g !== SEEN ? (
                  bulkHead(g, rows, 'ml-auto')
                ) : door(ownerOfGroup(g)) ? (
                  <button type="button" onClick={door(ownerOfGroup(g))!.go} className="ml-auto shrink-0 text-[11px] text-ink-2 hover:text-terracotta">
                    {door(ownerOfGroup(g))!.label}
                  </button>
                ) : null}
              </div>
            ) : (
              <h4 className="sticky top-0 z-[1] flex items-baseline gap-2 bg-inherit px-4 pb-1 pt-3 font-mono text-[10.5px] text-ink-3 backdrop-blur-sm">
                <span>{g}</span>
                <span className="tabular-nums">{rows.length}</span>
              </h4>
            )}
            {kind === 'skills' && scoped === 'project' && rows[0]?.skill?.source === 'account' && rows[0].skill.origin ? headBlock('skills') : null}
            <ul>
              {rows
                .flatMap((r) => [
                  r,
                  ...(r.children && (unfolded.has(r.key) || (query !== '' && r.children.some((c) => c.search.includes(query.toLowerCase()))))
                    ? r.children
                    : []),
                ])
                .flatMap((r) => {
                  const sel = effective?.key === r.key
                  const child = r.load?.parent !== undefined && rows.every((top) => top.key !== r.key)
                  const pv = personalOf(r)
                  const pw = pv ? personalWords(pv) : null
                  const iv = instrOf(r)
                  const inert = inertOf(r)
                  // on an agent's page a row is dim where it does not load for THAT agent
                  const dim =
                    (r.load && (placesPage?.scope === 'agent' ? !loadsFor(r.load, agent.id) : r.load.state !== 'active')) ||
                    r.load?.replacedBy ||
                    r.skill?.state === 'held' ||
                    (r.skill?.source === 'account' && r.skill.state === 'available') ||
                    pv?.state === 'off' ||
                    iv?.line?.result === 'off'
                  // the Claude account's plugins and connectors each under their
                  // origin's head (Project › Tools): the first row of each opens it
                  const origin = heads(g) && r.load && !child ? originOfRow(r.load, src.loads!) : undefined
                  const opens = origin && rows.find((x) => x.load && originOfRow(x.load, src.loads!)?.id === origin.id)?.key === r.key
                  return [
                    ...(opens
                      ? [
                          <OriginSection
                            key={`origin:${origin.id}`}
                            id={origin.id}
                            count={rows.filter((x) => x.load && originOfRow(x.load, src.loads!)?.id === origin.id).length}
                            head={toolsHead(origin.id)}
                          />,
                        ]
                      : []),
                    ...(opens && headBlock(origin.id) ? [<li key={`origin-where:${origin.id}`}>{headBlock(origin.id)}</li>] : []),
                    <li key={r.key} className={child ? 'border-l border-line/80 ml-[22px]' : undefined}>
                      <div
                        className={`group/row flex items-start gap-2 ${child ? 'pl-3 pr-4' : 'px-4'} py-1.5 ${sel ? 'bg-canvas shadow-[inset_2px_0_0_var(--terracotta)]' : 'hover:bg-canvas/60'}`}
                      >
                        {r.children ? (
                          // a plugin holds its servers: unfolded in place
                          <button
                            type="button"
                            aria-expanded={unfolded.has(r.key)}
                            aria-label={`${unfolded.has(r.key) ? 'Fold' : 'Unfold'} ${r.title}’s servers`}
                            onClick={() => unfold(r.key, !unfolded.has(r.key))}
                            className="mt-[3px] -ml-1 shrink-0 rounded p-px text-ink-3 hover:text-ink"
                          >
                            <ChevronRight size={11} aria-hidden="true" className={`transition-transform ${unfolded.has(r.key) ? 'rotate-90' : ''}`} />
                          </button>
                        ) : null}
                        <button
                          type="button"
                          onClick={() =>
                            guard(() => {
                              setOpenKey(r.key)
                              setAdding(false)
                              setWriting(false)
                            })
                          }
                          className="flex min-w-0 flex-1 items-start gap-2 text-left"
                        >
                          {r.children || child ? null : (
                            <span aria-hidden="true" className="mt-[5px] flex w-2.5 shrink-0 justify-center">
                              {r.marker === 'new' ? (
                                <Sparkle size={10} className="text-terracotta" />
                              ) : r.marker === 'outside' ? (
                                <span className={`inline-block h-[7px] w-[7px] rounded-full border ${AMBER} border-current`} />
                              ) : r.kind === 'memory' && r.memory?.layer === 'auto' ? (
                                <span className="inline-block h-[5px] w-[5px] rounded-full bg-ink-3/60" />
                              ) : null}
                            </span>
                          )}
                          <span className="min-w-0 flex-1">
                            <span
                              className={`block truncate ${r.mono ? 'font-mono text-[12px]' : 'text-[13px]'} ${sel ? 'text-ink' : dim ? 'text-ink-2 group-hover/row:text-terracotta' : 'text-ink group-hover/row:text-terracotta'}`}
                            >
                              {r.title}
                              {r.children ? (
                                <span className="ml-1.5 font-sans text-[10.5px] text-ink-3">
                                  {r.children.length} {r.children.length === 1 ? 'server' : 'servers'}
                                </span>
                              ) : null}
                            </span>
                            {pw ? (
                              <span data-testid="personal-state" className={`block truncate text-[11.5px] ${pv?.state === 'partly' ? AMBER : 'text-ink-2'}`}>
                                {pw}
                              </span>
                            ) : r.sub ? (
                              <span className="block truncate text-[11.5px] text-ink-2">{r.sub}</span>
                            ) : null}
                            {r.skill?.sameName && scoped === 'project' ? (
                              <span title={sameNameWords(r.skill)} className="block truncate text-[11px] text-ink-3">
                                {r.skill.source === 'account' ? 'named like your personal skill' : 'named like an account skill'} — one name, two copies
                              </span>
                            ) : null}
                            {r.health ? <HealthLine h={r.health} /> : null}
                          </span>
                          {r.weigh ? (
                            <span
                              data-testid="memory-weight"
                              title={
                                r.memory?.row?.weight.as === 'loaded'
                                  ? 'As the newest start here loaded it'
                                  : 'No start here has named it yet — its size on disk'
                              }
                              className={`shrink-0 pt-px font-mono text-[10.5px] tabular-nums ${r.weigh.amber ? AMBER : 'text-ink-3'}`}
                            >
                              {r.weigh.text}
                            </span>
                          ) : r.mtime ? (
                            <span className="shrink-0 pt-px font-mono text-[10.5px] text-ink-3">{relTime(r.mtime, now)}</span>
                          ) : null}
                          {/* what it took at the newest measured start here — measured, never estimated */}
                          {(() => {
                            const w = weighs(r)
                            return w ? (
                              <span
                                data-testid="tool-weight"
                                title={`${w.tokens.toLocaleString('en-US')} tokens it put in the context at the newest start here — paid by every conversation that loads it`}
                                className="shrink-0 pt-px font-mono text-[10.5px] tabular-nums text-ink-3"
                              >
                                {shortTokens(w.tokens)} tok
                              </span>
                            ) : null
                          })()}
                        </button>
                        {(() => {
                          const v = r.load ? signIn(r.load) : null
                          return v ? <SignInDoor {...v} className="max-w-[45%] shrink-0 truncate pt-px text-[11px]" /> : null
                        })()}
                        {/* switches live only on the owner's page; the drawer points there */}
                        {iv ? (
                          (() => {
                            // the page's own place: this project, or this agent only
                            const f = instructionFact(iv)
                            if (f)
                              return (
                                <SwitchRefused
                                  words={f}
                                  onUpdate={() => {
                                    if (!whereOpen.has(r.key)) toggleWhere(r.key)
                                  }}
                                />
                              )
                            const l = iv.line!
                            const to: 'on' | 'off' = l.result === 'on' ? 'off' : 'on'
                            return (
                              <ToolToggle
                                on={l.result === 'on'}
                                busy={instr.busy === r.memory!.path}
                                onAct={() =>
                                  void instrAction(r.memory!.path, r.title, to, scoped === 'agent' ? { scope: 'agent', agent: agent.id } : { scope: 'project' })
                                }
                              />
                            )
                          })()
                        ) : pv ? (
                          pv.fact ? (
                            <SwitchRefused
                              words={pv.fact}
                              onUpdate={() => {
                                if (personal.subject && !whereOpen.has(r.key)) toggleWhere(r.key)
                              }}
                            />
                          ) : (
                            <ToolToggle on={pv.state !== 'off'} pressed={pv.state === 'partly'} busy={personal.busy} onAct={(a) => void personalAction(a)} />
                          )
                        ) : r.skill &&
                          scoped === 'project' &&
                          (r.skill.source === 'account' || r.skill.source === 'user') &&
                          (r.skill.switches || r.skill.decidedBy) ? (
                          <SkillPositions
                            s={r.skill}
                            busy={busy === r.key}
                            pending={positioning?.key === r.key ? positioning.to : null}
                            onPick={(to) => {
                              if (positionReach(r, to) && positioning?.key !== r.key) setPositioning({ key: r.key, to })
                              else void positionAction(r, to)
                            }}
                          />
                        ) : r.skill && scoped && (r.owner === own || (scoped === 'project' && r.skill.state === 'available')) ? (
                          <SkillToggle s={r.skill} busy={busy === r.skill.name} onAct={(a) => void skillAction(r.skill!, a)} />
                        ) : r.load?.switch && scoped === 'project' ? (
                          <ToolToggle
                            on={r.load.state === 'active'}
                            verb={switchVerb(r.load)}
                            busy={busy === r.load.key}
                            pressed={confirming === r.load.key}
                            onAct={(a) => {
                              const l = r.load!
                              if (src.loads && switchSentence(l, src.loads) && confirming !== l.key) setConfirming(l.key)
                              else void toolAction(l, a)
                            }}
                          />
                        ) : r.load && scoped === 'project' && refusedWords(r.load) ? (
                          <SwitchRefused words={refusedWords(r.load)!} onUpdate={() => goHome({ kind: 'settings', tab: 'engines' })} />
                        ) : r.load && scoped === 'agent' && placesPage?.scope === 'agent' && agentLineOf(r.load, agent.id)?.switch ? (
                          (() => {
                            // the plain switch on an agent's page: only this agent (its line
                            // of «Where it loads»); a line a wider place locks opens the block
                            const l = agentLineOf(r.load!, agent.id)!
                            const to: 'on' | 'off' = l.result === 'on' ? 'off' : 'on'
                            return (
                              <ToolToggle
                                on={l.result === 'on'}
                                busy={busy === `line:${r.key}:${agent.id}`}
                                pressed={confirming === `line:${r.key}`}
                                onAct={() => {
                                  if (l.locked) {
                                    if (!whereOpen.has(r.key)) toggleWhere(r.key)
                                  } else if ((l.switch?.reaches?.length ?? 0) > 0 && confirming !== `line:${r.key}`) setConfirming(`line:${r.key}`)
                                  else void agentLineAction(r.load!, l, to)
                                }}
                              />
                            )
                          })()
                        ) : r.own && scoped === 'agent' ? (
                          <ToolToggle on={r.own.state === 'active'} busy={busy === `own:${r.own.name}`} onAct={(a) => void ownToolAction(r.own!, a)} />
                        ) : r.skill && !scoped && door(r.owner) ? (
                          <button type="button" onClick={door(r.owner)!.go} className="shrink-0 pt-px text-[11px] text-ink-2 hover:text-terracotta">
                            {door(r.owner)!.label}
                          </button>
                        ) : null}
                        {(r.load?.at || r.skill?.at || (pv && personal.subject) || (iv && (iv.places.at.length > 0 || iv.places.inert)) || inert) &&
                        placesPage ? (
                          <WhereToggle open={whereOpen.has(r.key)} label={r.title} onToggle={() => toggleWhere(r.key)} />
                        ) : null}
                      </div>
                      {/* the places disagree: one phrase, a door to the block */}
                      {(() => {
                        const phrase = r.phrase ?? (r.skill?.at && placesPage ? skillPlacesPhrase(r.skill.at, placesPage) : null) ?? iv?.phrase ?? null
                        return phrase && !whereOpen.has(r.key) ? (
                          <div className={`-mt-1 pb-1.5 ${child ? 'pl-3 pr-4' : 'pl-[34px] pr-4'}`}>
                            <button
                              type="button"
                              data-testid="places-phrase"
                              onClick={() => toggleWhere(r.key)}
                              aria-label={`${phrase} — where ${r.title} loads`}
                              className="max-w-full truncate text-left text-[11.5px] text-ink-2 underline decoration-ink-3/40 decoration-dotted underline-offset-[3px] hover:text-terracotta"
                            >
                              {phrase}
                            </button>
                          </div>
                        ) : null
                      })()}
                      {r.skill?.at && placesPage && whereOpen.has(r.key) ? (
                        <SkillPlaces
                          skill={r.skill}
                          page={placesPage}
                          indent={child}
                          folder={subjectFolder(agent) ?? from?.cwd ?? agent.folder ?? null}
                          onChanged={() => src.reload()}
                          {...(scoped === 'project' ? { onProject: (to: SkillPosition) => projectLineAction(r, to) } : {})}
                        />
                      ) : null}
                      {pv && personal.subject && placesPage && whereOpen.has(r.key) ? (
                        <WhereItLoads
                          row={personalSubject ?? personal.subject}
                          page={placesPage}
                          indent={false}
                          folder={personalFolder}
                          busy={personalBusy}
                          {...(scoped === 'project' ? { onFile: (to: 'on' | 'off') => personal.turn(to) } : {})}
                          {...(from && personalHereLine
                            ? { onConversation: (to: 'on' | 'off') => personalHere.turnAt(to, { scope: 'conversation', conversation: from.id }) }
                            : {})}
                          onSwitch={(l: LoadsLine, to: 'on' | 'off') => {
                            if (l.agent)
                              void personalForAgent(l.agent, to).catch((e: unknown) =>
                                setActionError(`Your CLAUDE.md for ${l.agentName ?? l.agent}: ${e instanceof Error ? e.message : String(e)}`),
                              )
                          }}
                        />
                      ) : null}
                      {iv && placesPage && whereOpen.has(r.key) && iv.places.at.length > 0 ? (
                        <WhereItLoads
                          row={iv.subject}
                          page={placesPage}
                          indent={false}
                          folder={personalFolder}
                          busy={null}
                          onFile={(to: 'on' | 'off', scope: 'machine' | 'project', confirmed: boolean) =>
                            instr.turn(
                              r.memory!.path,
                              to,
                              scope === 'machine' ? { scope: 'machine', ...(confirmed ? { confirmed: true as const } : {}) } : { scope: 'project' },
                            )
                          }
                          {...(from && iv.places.at.some((l) => l.place === 'conversation')
                            ? { onConversation: (to: 'on' | 'off') => instrHere.turn(r.memory!.path, to, { scope: 'conversation', conversation: from.id }) }
                            : {})}
                          onSwitch={(l: LoadsLine, to: 'on' | 'off') => {
                            if (l.agent) void instrAction(r.memory!.path, `${r.title} for ${l.agentName ?? l.agent}`, to, { scope: 'agent', agent: l.agent })
                          }}
                        />
                      ) : null}
                      {/* a row with no place (or none at a launch place): why, in its block */}
                      {placesPage && whereOpen.has(r.key) && (iv?.places.inert || inert) ? (
                        <p data-testid="where-inert" className="pb-2.5 pl-[34px] pr-4 text-[11px] leading-snug text-ink-3">
                          {iv?.places.inert ?? inert}
                        </p>
                      ) : null}
                      {r.load?.at && placesPage && whereOpen.has(r.key) ? (
                        <WhereItLoads
                          row={r.load}
                          page={placesPage}
                          indent={child}
                          {...(src.loads?.conversations ? { conversations: src.loads.conversations } : {})}
                          folder={src.loads?.folder ?? null}
                          scopes={src.loads?.engines.find((e) => e.label === r.load!.engine)?.scopes}
                          onChanged={() => src.reload()}
                          busy={busy?.startsWith(`line:${r.key}:`) ? busy.slice(`line:${r.key}:`.length) : null}
                          {...(scoped === 'project' || agentPage ? { onSwitch: (l: LoadsLine, to: 'on' | 'off') => void agentLineAction(r.load!, l, to) } : {})}
                        />
                      ) : null}
                      {r.load && scoped === 'project' && proofWords(r.load, now) ? <ProofLine words={proofWords(r.load, now)!} indent={child} /> : null}
                      {/* a place's own entry that didn't take, naming the place (the machine, an agent) */}
                      {r.load && scoped
                        ? placeProofWords(r.load, now, scoped === 'agent' ? { agent: agent.id } : {}).map((w) => (
                            <ProofLine key={w.key} words={w} indent={child} />
                          ))
                        : null}
                      {r.skill && positioning?.key === r.key ? (
                        <SwitchConfirm
                          sentence={positionReach(r, positioning.to) ?? ''}
                          verb={POSITION_VERB[positioning.to]}
                          indent={false}
                          busy={busy === r.key}
                          onYes={() => void positionAction(r, positioning.to)}
                          onNo={() => setPositioning(null)}
                        />
                      ) : null}
                      {r.load && confirming === `line:${r.key}`
                        ? (() => {
                            const l = agentLineOf(r.load!, agent.id)
                            if (!l) return null
                            const n = l.switch?.reaches?.length ?? 0
                            const to = l.result === 'on' ? 'off' : 'on'
                            return (
                              <SwitchConfirm
                                sentence={`For ${agent.name} only — the same name ${to === 'off' ? 'turns off' : 'turns on'} ${n === 1 ? 'one other row' : `${n} other rows`} with it`}
                                on={l.result === 'on'}
                                indent={child}
                                busy={busy === `line:${r.key}:${agent.id}`}
                                onYes={() => {
                                  setConfirming(null)
                                  void agentLineAction(r.load!, l, to)
                                }}
                                onNo={() => setConfirming(null)}
                              />
                            )
                          })()
                        : null}
                      {r.load && confirming === r.load.key && src.loads ? (
                        <SwitchConfirm
                          sentence={switchSentence(r.load, src.loads) ?? ''}
                          on={r.load.state === 'active'}
                          {...(addWords(r.load, src.loads) ? { verb: 'Add' } : {})}
                          indent={child}
                          busy={busy === r.load.key}
                          onYes={() => void toolAction(r.load!, r.load!.state === 'active' ? 'hold' : 'activate')}
                          onNo={() => setConfirming(null)}
                        />
                      ) : null}
                    </li>,
                  ]
                })}
              {/* an account group with no connector row: their head all the
                  same, and while they are off here with nothing to list,
                  «See what it sends ›» */}
              {heads(g) && src.loads?.origins?.some((o) => o.id === 'connectors') && !rows.some((x) => x.load?.kind === 'connector')
                ? (() => {
                    const o = src.loads!.origins!.find((x) => x.id === 'connectors')!
                    const t = !o.on ? sendsTargetOf(toolsCheck, loginOfGroup(g) || null) : undefined
                    return [
                      <OriginSection key="origin:connectors" id="connectors" count={0} head={toolsHead('connectors')} />,
                      ...(headBlock('connectors') ? [<li key="origin-where:connectors">{headBlock('connectors')}</li>] : []),
                      ...(t
                        ? [
                            <li key="sends">
                              <SendsLine check={toolsCheck} target={t} />
                            </li>,
                          ]
                        : []),
                    ]
                  })()
                : null}
            </ul>
          </section>
        ))}
        {kind === 'tools' && scoped === 'project' && src.loads ? <SendsOffers check={toolsCheck} loads={src.loads} head={toolsHead('connectors')} /> : null}
        {kind === 'tools' && scoped === 'project' && src.loads && src.loads.notes.length > 0 ? (
          <div className="mx-4 mt-3 space-y-0.5 border-t border-line/70 pt-2 text-[11.5px] leading-snug text-ink-3" data-testid="loads-notes">
            {src.loads.notes.map((n) => (
              <p key={n}>{n}</p>
            ))}
          </div>
        ) : null}
      </div>
      {foot}
    </div>
  )

  const detail =
    writing && kind === 'memory' && src.memory?.places ? (
      <WriteInstructions
        places={src.memory.places}
        agentName={agent.name}
        projectName={folder ? basename(folder) : null}
        folder={personalFolder ?? memoryFolderOf(agent)}
        onBack={() => setWriting(false)}
        onWritten={(path) => {
          setWriting(false)
          src.reload()
          setOpenKey(path)
        }}
        onOpen={(path) => {
          setWriting(false)
          setOpenKey(path)
        }}
      />
    ) : adding && addsTool ? (
      <OwnToolAdd
        agent={agent}
        onBack={() => setAdding(false)}
        onAdded={(name) => {
          setAdding(false)
          setOpenKey(`own:${name}`)
          src.reload()
        }}
      />
    ) : adding && (kind === 'memory' || kind === 'context' || kind === 'files') ? (
      <KnowsAdd
        agent={agent}
        kind={kind === 'files' ? 'context' : kind}
        label={kind === 'memory' ? 'Write a note' : 'Upload a file'}
        prefer={scoped === 'agent' ? 'agent' : 'shared'}
        {...(fromConversation ? { conversation: fromConversation } : {})}
        onBack={() => guard(() => setAdding(false))}
        onDirty={onDirty}
        onChanged={src.reload}
        onOpenItem={(key) => {
          setAdding(false)
          setOpenKey(key)
        }}
        guard={guard}
      />
    ) : effective ? (
      <Detail
        agent={agent}
        row={effective}
        now={now}
        conversation={hereId}
        memoryFolder={personalFolder ?? memoryFolderOf(agent)}
        weight={weighs(effective)}
        weightAt={weight?.at ?? null}
        loadsFolder={weightFolder}
        onChanged={() => {
          src.reload()
          setGivenTick((t) => t + 1)
        }}
        onDirty={onDirty}
        guard={guard}
        owner={
          scoped
            ? {
                owner: effective.owner,
                ctx: effective.load ? groupCtx(effective.group) : ctx,
                reach: effective.load ? groupReach(effective.group) : reach(effective.owner),
              }
            : null
        }
        onOpenRow={(key) => {
          const hit = flat(all[kind]).find((r) => r.key === key)
          if (hit) {
            setOpenKey(key)
            if (hit.load?.parent) unfold(hit.load.parent, true)
          }
        }}
        signIn={signIn}
        // a plugin skill's door lands on its plugin's row — by the key the
        // inventory made (the copy that loads), never by its name
        onPlugin={
          folder
            ? {
                label: `Tools in ${projectName}`,
                go: (plugin) => {
                  const row = src.loads ? pluginRowOf(src.loads.rows, plugin) : undefined
                  goHome({ kind: 'project', folder, tab: 'tools', ...(row ? { item: row.key } : {}) })
                },
              }
            : null
        }
      />
    ) : null

  if (wide) {
    return (
      <div className="flex h-[calc(100vh-18rem)] min-h-[480px] flex-col overflow-hidden rounded-lg border border-line bg-panel" data-testid="knows-library">
        {bare ? null : kindNav}
        {/* list beside the open item from sm up; on a phone they stack —
            the list over the item, each scrolling on its own */}
        <div
          data-testid="knows-library-panes"
          className={`grid min-h-0 flex-1 ${kind === 'start' ? 'grid-cols-1' : 'grid-cols-1 grid-rows-[minmax(0,1fr)_minmax(0,1.1fr)] sm:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)] sm:grid-rows-1'}`}
        >
          <div className={`flex min-h-0 flex-col border-line ${kind === 'start' ? '' : 'border-b sm:border-b-0 sm:border-r'}`}>{list}</div>
          {kind !== 'start' ? <div className="min-h-0 overflow-y-auto bg-canvas">{detail}</div> : null}
        </div>
      </div>
    )
  }
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="knows-library">
      {header}
      {open || adding ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <button
            type="button"
            onClick={() =>
              guard(() => {
                setOpenKey(null)
                setAdding(false)
              })
            }
            className="flex shrink-0 items-center gap-0.5 px-3 pt-2.5 text-xs text-ink-2 hover:text-ink"
          >
            <ChevronLeft size={12} aria-hidden="true" /> {KIND_LABEL[kind]}
          </button>
          <div className="min-h-0 flex-1 overflow-y-auto">{detail}</div>
        </div>
      ) : (
        <>
          {kindNav}
          {list}
        </>
      )}
    </div>
  )
}

// The one switch a skill row can carry, and only where it changes something
// real: a folder copy turns off (moved to the held store), a held one turns
// on, an available one (Silos' own, not here yet) is added. A personal or
// plugin skill has no switch here — its group header already says what it
// is (never a tag repeated on every row) and the opened item says where it
// is governed.
function SkillToggle({ s, busy, onAct }: { s: SkillCatalogEntry; busy: boolean; onAct: (a: 'hold' | 'activate' | 'add') => void }) {
  const state = s.state ?? 'active'
  // a shadowed copy has no switch: its personal twin loads either way
  if (state === 'active' && s.source !== 'project') return null
  if (state === 'seen') return null
  const [label, action] =
    state === 'active' ? (['Turn off', 'hold'] as const) : state === 'held' ? (['Turn on', 'activate'] as const) : (['Add', 'add'] as const)
  return (
    <button
      type="button"
      disabled={busy}
      onClick={() => onAct(action)}
      className={`shrink-0 rounded-full border px-2 py-px text-[11px] disabled:opacity-50 ${state === 'active' ? 'border-line text-ink-2 hover:text-ink' : 'border-terracotta/50 text-terracotta hover:bg-terracotta/10'}`}
    >
      {busy ? '…' : label}
    </button>
  )
}

// A folder's MCP server or plugin switch — only on the project's Tools, and
// only where the folder's local settings decide it (governable). Always
// visible (owner 24-11: a switch shown only on hover reads as «no switch»).
function ToolToggle({
  on,
  busy,
  onAct,
  pressed = false,
  verb,
}: {
  on: boolean
  busy: boolean
  onAct: (a: 'hold' | 'activate') => void
  pressed?: boolean
  verb?: string
}) {
  return (
    <button
      type="button"
      disabled={busy}
      aria-expanded={pressed || undefined}
      onClick={() => onAct(on ? 'hold' : 'activate')}
      className={`shrink-0 rounded-full border px-2 py-px text-[11px] disabled:opacity-50 ${on ? 'border-line text-ink-2 hover:text-ink' : 'border-terracotta/50 text-terracotta hover:bg-terracotta/10'}`}
    >
      {busy ? '…' : (verb ?? (on ? 'Turn off' : 'Turn on'))}
    </button>
  )
}

// One origin of the Claude account inside its group — plugins, connectors:
// its name, how many it sends here, and its head (OriginHead).
function OriginSection({ id, count, head }: { id: LoadsOrigin['id']; count: number; head: ReactNode }) {
  return (
    <li className="flex items-baseline gap-1.5 px-4 pb-0.5 pt-2 pl-[34px]" data-testid={`origin-${id}`}>
      <span className="shrink-0 text-[11.5px] text-ink-2">{id === 'plugins' ? 'Plugins' : id === 'skills' ? 'Skills' : 'Connectors'}</span>
      {count > 0 ? <span className="font-mono text-[10.5px] tabular-nums text-ink-3">{count}</span> : null}
      {head}
    </li>
  )
}

const POSITIONS: { to: SkillPosition; word: string; hint: string }[] = [
  { to: 'on', word: 'on', hint: 'listed with its description in every new conversation' },
  { to: 'name-only', word: 'name only', hint: 'listed without its description — lighter, still callable' },
  { to: 'off', word: 'off', hint: 'not loaded in new conversations here' },
]
const POSITION_VERB: Record<SkillPosition, string> = { on: 'Turn on', 'name-only': 'Name only', off: 'Turn off' }

/** the words for a name a personal skill and an account skill share */
function sameNameWords(s: SkillCatalogEntry): string {
  const other = s.source === 'account' ? 'your personal skill' : 'a skill your Claude account sends'
  return `Shares its name with ${other} — this project’s position hides only your personal copy; an agent’s hides both (▾ says it per place)`
}

/** what an account or personal skill's position is decided by, when not here */
function decidedWords(d: NonNullable<SkillCatalogEntry['decidedBy']>): { short: string; long: string } {
  return d === 'home'
    ? {
        short: 'Claude Code’s own folder',
        long: 'this folder’s .claude is Claude Code’s own config folder — its settings reach every project, so Silos doesn’t switch anything here',
      }
    : { short: `set in ${d.file}`, long: `decided by ${d.key} in ${d.file} — change it in that file; Silos only writes this project’s local settings` }
}

// An account or personal skill's three positions — on · name only · off —
// all three visible, the current one drawn in ink: readable at a glance.
// The account's origin being off reads as off (nothing of it loads); a
// value Silos doesn't write is shown in its place and kept until a
// position is picked here.
function SkillPositions({
  s,
  busy,
  pending,
  onPick,
}: {
  s: SkillCatalogEntry
  busy: boolean
  pending: SkillPosition | null
  onPick: (to: SkillPosition) => void
}) {
  if (s.decidedBy) return <SwitchRefused words={decidedWords(s.decidedBy)} onUpdate={() => undefined} />
  const value = s.position ?? 'on'
  const known = POSITIONS.some((p) => p.to === value)
  const current: string = s.source === 'account' && s.origin && !s.origin.on ? 'off' : value
  return (
    <span
      role="radiogroup"
      aria-label={`${s.name} in this project`}
      data-testid="skill-positions"
      className="flex shrink-0 items-baseline gap-px rounded-full border border-line px-0.5 py-px text-[11px]"
    >
      {!known ? (
        <span
          title={`set to "${value}" by hand — kept until you pick a position`}
          className="max-w-[9rem] truncate rounded-full bg-canvas px-1.5 font-mono text-[10.5px] text-ink"
        >
          {value}
        </span>
      ) : null}
      {POSITIONS.map((p) => {
        const on = p.to === current
        const asked = pending === p.to
        return (
          <button
            key={p.to}
            type="button"
            role="radio"
            aria-checked={on}
            disabled={busy || on}
            title={p.hint}
            onClick={() => onPick(p.to)}
            className={`rounded-full px-1.5 leading-[18px] transition-colors disabled:cursor-default ${on ? (p.to === 'off' ? 'bg-ink-3/15 text-ink' : 'bg-ink text-canvas') : asked ? 'text-terracotta' : 'text-ink-3 hover:text-ink'}`}
          >
            {busy && asked ? '…' : p.word}
          </button>
        )
      })}
    </span>
  )
}

// A switch that didn't take (rule 7): the amber line under its row — what
// is wrong, where it was read, and the way out, never a fix made for him.
// An account item turned off by name: its group's head (depends on no
// name); anything else: a fresh reading, the Tools head's «Check now».
function ProofLine({ words, indent }: { words: ProofWords; indent: boolean }) {
  const toHead = (el: HTMLElement): void => {
    const section = el.closest('section')
    const head = section?.querySelector<HTMLElement>('[data-origin-head]') ?? section?.querySelector<HTMLElement>('[data-testid="owner-header"]')
    head?.scrollIntoView({ block: 'nearest' })
    if (head?.matches('[data-origin-head]')) head.focus()
  }
  return (
    <div
      data-testid="switch-proof"
      className={`flex flex-wrap items-baseline gap-x-2 pb-1.5 ${indent ? 'pl-3 pr-4' : 'pl-[34px] pr-4'} -mt-1 text-[11px] leading-snug`}
    >
      <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
        <span aria-hidden="true" className="inline-block h-[6px] w-[6px] shrink-0 translate-y-[-1px] rounded-full bg-[var(--health-amber)]" />
        <span className="min-w-0">
          <span className={AMBER}>{words.line}</span>
          <span className="text-ink-3"> · {words.how}</span>
        </span>
      </span>
      {words.wayOut === 'origin' ? (
        <button type="button" onClick={(e) => toHead(e.currentTarget)} className="shrink-0 text-ink-2 hover:text-terracotta">
          Turn off at the head ›
        </button>
      ) : null}
      <button type="button" onClick={focusCheckNow} className="shrink-0 text-ink-2 hover:text-terracotta">
        Check now ›
      </button>
    </div>
  )
}

// What a click reaches beyond its row, said before it happens: one line
// under the row, the confirming verb naming the whole reach.
function SwitchConfirm({
  sentence,
  on = false,
  verb: given,
  indent,
  busy,
  onYes,
  onNo,
}: {
  sentence: string
  on?: boolean
  verb?: string
  indent: boolean
  busy: boolean
  onYes: () => void
  onNo: () => void
}) {
  const all = given ? null : /— (turns (?:off|on)) (both|all \w+)$/.exec(sentence)
  const verb = given ?? (on ? 'Turn off' : 'Turn on')
  return (
    <div
      role="group"
      aria-label="Confirm the switch"
      data-testid="switch-confirm"
      className={`flex flex-wrap items-baseline gap-x-2 gap-y-1 pb-2 ${indent ? 'pl-3 pr-4' : 'pl-[34px] pr-4'} text-[11.5px] leading-snug`}
    >
      <span className="min-w-0 flex-1 text-ink-2">
        {sentence}
        <span className="text-ink-3"> — new conversations only.</span>
      </span>
      <span className="flex shrink-0 items-baseline gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={onYes}
          className="rounded-full border border-terracotta/50 px-2 py-px text-[11px] text-terracotta hover:bg-terracotta/10 disabled:opacity-50"
        >
          {busy ? '…' : all ? `${verb} ${all[2]}` : verb}
        </button>
        <button type="button" onClick={onNo} className="text-[11px] text-ink-2 hover:text-ink">
          Keep
        </button>
      </span>
    </div>
  )
}

// the open item: the facts first (what it is, where it came from, whether
// the agent sees it on its own), then the thing itself
function Detail({
  agent,
  row,
  now,
  onChanged,
  onDirty,
  guard,
  owner,
  onPlugin,
  conversation,
  onOpenRow,
  weight = null,
  weightAt = null,
  loadsFolder = null,
  signIn = null,
  memoryFolder = null,
}: {
  memoryFolder?: string | null
  signIn?: ((l: LoadsRow) => SignInView | null) | null
  weight?: RowWeight | null
  weightAt?: string | null
  loadsFolder?: string | null
  conversation?: string | undefined
  agent: AgentView
  row: Row
  now: number
  onChanged: () => void
  onDirty: (d: boolean) => void
  guard: (leave: () => void) => void
  owner: { owner: Owner; ctx: OwnerContext; reach: string } | null
  onPlugin: { label: string; go: (plugin: string) => void } | null
  onOpenRow: (key: string) => void
}) {
  const agents = useStore((s) => s.agents)
  const openSession = useStore((s) => s.openSession)
  const facts: ReactNode[] = []
  if (row.memory) {
    const m = row.memory
    if (m.layer === 'auto') {
      if (m.type) facts.push(<span key="t">{m.type}</span>)
      // a past time reads relative; the exact moment on hover
      facts.push(
        <span key="d" title={new Date(m.mtime).toLocaleString()}>
          written {relTime(m.mtime, now)}
        </span>,
      )
      if (m.origin) {
        // the conversation lives in the same project folder as the memory
        // (…/projects/<folder>/memory/<note>.md); its title when it is listed
        const folder = m.path.split('/').at(-3) ?? ''
        const s = agents.flatMap((a) => a.sessions).find((x) => x.id === m.origin)
        const origin = m.origin
        facts.push(
          <button
            key="o"
            type="button"
            onClick={() => void openSession(s?.folder ?? folder, origin)}
            className="text-ink underline decoration-line underline-offset-2 hover:text-terracotta"
          >
            learned{m.author ? ` by ${agents.find((a) => a.id === m.author)?.name ?? m.author}` : ''} in {s?.title ? `«${s.title}»` : 'an earlier conversation'}{' '}
            ›
          </button>,
        )
      }
    } else {
      facts.push(<span key="a">read at the start of every conversation</span>)
      if (m.size !== undefined) facts.push(<span key="s">≈ {approxTokens(m.size)} tokens</span>)
    }
  }
  const working = row.kind === 'produced' || row.file?.scope === 'own'
  if (row.file) {
    if (!owner)
      facts.push(<span key="f">{row.file.scope === 'shared' ? 'shared with the folder' : working ? `written by ${agent.name}` : `only ${agent.name}`}</span>)
    else if (working) facts.push(<span key="w">its working file</span>)
    facts.push(<span key="z">{(row.file.size / 1024).toFixed(row.file.size < 10_240 ? 1 : 0)} KB</span>)
  }
  if (row.tool) facts.push(<span key="t">{row.sub}</span>, <span key="l">its tool list is in every conversation</span>)
  if (row.load) {
    const l = row.load
    facts.push(<span key="k">{l.kind === 'plugin' ? 'plugin' : l.kind === 'connector' ? 'connector' : l.placeholder ? 'placeholder' : 'MCP server'}</span>)
    if (l.origin.owner !== null && l.kind !== 'plugin') facts.push(<span key="c">{l.origin.carrier}</span>)
    if (l.detail && l.kind !== 'plugin')
      facts.push(
        <span key="d" className="break-all">
          {l.detail}
        </span>,
      )
    if (l.kind === 'plugin' && l.detail) facts.push(<span key="v">version {l.detail}</span>)
  }
  if (row.own) {
    facts.push(
      <span key="k">{row.own.transport === 'stdio' ? 'MCP server · a command' : `MCP server · ${row.own.transport} url`}</span>,
      <span key="d">{row.own.detail}</span>,
    )
    if (row.own.state === 'active') facts.push(<span key="l">in every new conversation of {agent.name}</span>)
  }
  if (row.skill && (row.skill.source === 'account' || row.skill.source === 'user') && (row.skill.position !== undefined || row.skill.switches)) {
    const v = row.skill.position ?? 'on'
    facts.push(
      <span key="p">
        {row.skill.source === 'account' && row.skill.origin && !row.skill.origin.on
          ? 'off in this project, with all your Claude account sends'
          : v === 'name-only'
            ? 'name only here — listed without its description, lighter, still callable'
            : v === 'off'
              ? 'off in this project'
              : v === 'on'
                ? 'on in this project'
                : `"${v}" here — set by hand, kept`}
      </span>,
    )
    if (row.skill.sameName) facts.push(<span key="n">{sameNameWords(row.skill)}</span>)
  } else if (row.skill)
    facts.push(
      <span key="k">
        {row.skill.state === 'held'
          ? row.skill.stillLoads === 'personal'
            ? 'this folder’s copy is off — your personal one still loads'
            : 'turned off — the engine doesn’t see it'
          : row.skill.state === 'available'
            ? 'not in its folder yet'
            : 'its description is in every conversation; the body loads when used'}
      </span>,
    )
  // a mixed folder: where another engine starting here sees it differently
  for (const [i, e] of (row.skill?.engines ?? []).entries()) facts.push(<span key={`e${i}`}>{e}</span>)

  const item: KnowsItem | null = row.file
    ? (contextItems({ shared: row.file.scope === 'shared' ? [row.file] : [], agent: row.file.scope === 'shared' ? [] : [row.file] })[0] ?? null)
    : row.skill
      ? { kind: 'skills', name: row.skill.name, scope: skillScope(row.skill.source), rawScope: row.skill.source ?? 'agent', description: row.skill.description }
      : null

  return (
    <div className="flex min-h-full flex-col" key={row.key}>
      <div className="px-5 pb-2 pt-4">
        <p className={`${row.mono ? 'font-mono text-[13px]' : 'font-display text-[18px] leading-snug'} text-ink`}>{row.title}</p>
        {owner ? (
          // where it comes from — its group's words — and, here only, whom
          // that origin reaches by default
          <p className="mt-1 flex min-w-0 items-baseline gap-1.5 text-[11.5px] text-ink-2" data-testid="item-owner">
            <OwnerLabel owner={owner.owner} ctx={owner.ctx} size="sm" className="min-w-0 shrink" from />
            <span className="min-w-0 truncate text-ink-3">— {owner.reach}</span>
          </p>
        ) : null}
        {facts.length ? (
          <p className="mt-1 flex flex-wrap gap-x-2 font-mono text-[11px] text-ink-2">
            {facts.map((f, i) => (
              <span key={i} className="flex gap-2">
                {i > 0 ? (
                  <span aria-hidden="true" className="text-ink-3">
                    ·
                  </span>
                ) : null}
                {f}
              </span>
            ))}
          </p>
        ) : null}
        {row.load ? <LoadFacts row={row.load} sub={row.sub ?? ''} onOpen={onOpenRow} weight={weight} weightAt={weightAt} folder={loadsFolder} /> : null}
        {row.health ? (
          <div className="mt-2">
            <HealthLine h={row.health} full />
          </div>
        ) : null}
        {row.load && proofWords(row.load, Date.now())
          ? (() => {
              const w = proofWords(row.load, Date.now())!
              return (
                <div className="mt-2 text-[12px] leading-snug" data-testid="switch-proof-full">
                  <p className={AMBER}>{w.line}</p>
                  <p className="mt-0.5 font-mono text-[11px] text-ink-2">
                    {w.listed} <span className="font-sans text-ink-3">· {w.how}</span>
                  </p>
                  <p className="mt-1 text-ink-3">
                    {w.long}{' '}
                    <button type="button" onClick={focusCheckNow} className="text-ink-2 hover:text-terracotta">
                      Check now ›
                    </button>
                  </p>
                </div>
              )
            })()
          : null}
        {(() => {
          const v = row.load && signIn ? signIn(row.load) : null
          if (!v) return null
          // the engine's own way: a real console (its sign-in tools live
          // there, never in a chat) for a waiting server, a page outside
          // Silos for a connector — Silos never sees a credential
          const d = v.door
          return (
            <p className="mt-2 text-[12px] leading-snug text-ink-3" data-testid="sign-in-detail">
              <SignInDoor {...v} className="mr-1.5" />
              {d.via === 'console' ? (
                v.agentName ? (
                  <>
                    opens a console of {v.agentName} — Claude gives you a link; if your browser ends on a connection error, paste its address back into the
                    console.{d.menu ? ' Silos knows it only by the id its tools carry: pick it in that menu.' : ''}
                  </>
                ) : (
                  'from a console of an agent that starts here — none does yet.'
                )
              ) : d.via === 'link' ? (
                <>— connected in {d.where}, in your account’s settings, never from a conversation here; new conversations load it once it is.</>
              ) : (
                <>shows each of its servers that waits, with its own door.</>
              )}
            </p>
          )
        })()}
        {row.load?.switch || row.own ? (
          <p className="mt-2 text-[12px] leading-snug text-ink-3">
            Turning it off or on reaches new conversations only — a console already running keeps what it loaded.
          </p>
        ) : null}
        {row.own ? <OwnToolFacts agent={agent} row={row.own} onChanged={onChanged} /> : null}
        {row.skill?.source === 'plugin' && row.skill.plugin && row.skill.plugin !== agent.id && row.skill.plugin !== 'silos' && onPlugin ? (
          // a plugin skill turns on and off with its plugin — the door lands on that plugin's row
          <button type="button" onClick={() => onPlugin.go(row.skill!.plugin!)} className="mt-2 block text-[12px] text-ink-2 hover:text-terracotta">
            {onPlugin.label} ›
          </button>
        ) : null}
        {row.memory?.layer === 'auto' && row.memory.inIndex === false ? (
          <p className={`mt-2 text-[12px] leading-snug ${AMBER}`}>
            Its index doesn’t name this note, so it isn’t in front of {agent.name} — it surfaces only if it searches its memory.
          </p>
        ) : row.memory?.layer === 'auto' && row.memory.inIndex ? (
          <p className="mt-2 text-[12px] text-ink-3">Named in its index — {agent.name} sees the title and the gist in every conversation.</p>
        ) : null}
      </div>
      {/* the reading size of a side pane, not of a chat turn */}
      <div className="min-h-0 flex-1 border-t border-line/70 [&_.turn-md]:text-[13.5px] [&_.turn-md_h1]:text-[17px] [&_.turn-md_h2]:text-[15px] [&_.turn-md_h3]:text-[14px]">
        {row.memory ? (
          <MemoryDetail
            key={row.key}
            path={row.memory.path}
            name={row.title}
            onDirty={onDirty}
            onSaved={onChanged}
            guard={guard}
            folder={memoryFolder}
            {...(row.memory.row && !row.memory.row.editable ? { readOnly: row.memory.row.readOnly ?? 'Silos doesn’t write this file' } : {})}
            {...(row.memory.row ? { saveLabel: saveWords(row.memory.row, agent.name) } : {})}
          />
        ) : row.skill && item ? (
          <SkillDetail agent={agent} item={item} entry={row.skill} />
        ) : row.file && item ? (
          working ? (
            <FileViewer key={row.key} path={row.file.path} inline />
          ) : (
            <ContextDetail
              agent={agent}
              item={item}
              onDirty={onDirty}
              onRemoved={onChanged}
              whose={owner === null}
              {...(conversation ? { conversation } : {})}
            />
          )
        ) : null}
      </div>
    </div>
  )
}

// an inventory row, opened: why it is in its state (the row's own line),
// what decides it, and — for a plugin — what it carries, its servers each a
// way to their own row; a server leads back to its plugin
function LoadFacts({
  row,
  sub,
  onOpen,
  weight,
  weightAt,
  folder,
}: {
  row: LoadsRow
  sub: string
  onOpen: (key: string) => void
  weight: RowWeight | null
  weightAt: string | null
  folder: string | null
}) {
  const goHome = useGoHome()
  const projected = useProjected(folder, row, weight !== null)
  const c = row.carries
  const list = (label: string, names: string[]): ReactNode =>
    names.length === 0 ? null : (
      <div key={label} className="grid grid-cols-[7.5rem_minmax(0,1fr)] gap-2 py-1">
        <dt className="text-ink-3">
          {label} <span className="font-mono text-[10.5px] tabular-nums">{names.length}</span>
        </dt>
        <dd className="min-w-0 font-mono text-[11.5px] leading-relaxed text-ink-2">{names.join(' · ')}</dd>
      </div>
    )
  return (
    <div className="mt-2 space-y-2 text-[12px]" data-testid="load-facts">
      {sub !== row.detail ? <p className={`leading-snug ${row.state === 'active' && !row.replacedBy ? 'text-ink-2' : 'text-ink'}`}>{sub}</p> : null}
      {row.decidedBy ? (
        <p className="leading-snug text-ink-3">
          Decided by <span className="font-mono text-ink-2">{row.decidedBy.key}</span> in <span className="font-mono text-ink-2">{row.decidedBy.file}</span> —{' '}
          {row.switch ? 'this project’s switch turns it on here over it.' : 'changed in that file, or in its «Where it loads».'}
        </p>
      ) : null}
      {row.origin.owner === 'account' ? (
        <p className="leading-snug text-ink-3">It loads only in conversations that run on {row.origin.login ? row.origin.login : 'that Claude login'}.</p>
      ) : null}
      {weight ? (
        // measured at one start: the newest here — what each piece took
        <p className="leading-snug text-ink-2" data-testid="tool-weight-detail">
          Took <span className="font-mono tabular-nums text-ink">{weight.tokens.toLocaleString('en-US')}</span> tokens at the newest start here
          {weightAt ? ` (${new Date(weightAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })})` : ''}
          {weight.parts.length > 1 ? (
            <span className="text-ink-3">
              {' '}
              —{' '}
              {weight.parts
                .slice(0, 4)
                .map((p) => `${p.label} ${shortTokens(p.tokens)}`)
                .join(', ')}
              {weight.parts.length > 4 ? ', …' : ''}
            </span>
          ) : null}
          .
        </p>
      ) : null}
      {projected.tokens !== null ? (
        // the engine's own estimate, never beside a measurement of this row
        <p
          className="leading-snug text-ink-2"
          data-testid="tool-projected"
          title={`${projected.tokens.toLocaleString('en-US')} tokens, by the engine’s own count — not measured here`}
        >
          Would add about <span className="font-mono tabular-nums text-ink">{shortTokens(projected.tokens)}</span> tokens to every start
          <span className="text-ink-3"> — {projected.by ?? 'the engine’s estimate'}.</span>
        </p>
      ) : projected.asking ? (
        <p className="leading-snug text-ink-3" data-testid="tool-projected-asking">
          Asking for an estimate of what it would add…
        </p>
      ) : null}
      {!row.exact ? <p className="leading-snug text-ink-3">Only the name its tools carry is known — no switch until a reading gives its exact name.</p> : null}
      {refusedWords(row)?.long ? (
        <p className="leading-snug text-ink-3">
          {refusedWords(row)!.long}
          {refusedWords(row)!.update ? (
            <>
              {' '}
              <button type="button" onClick={() => goHome({ kind: 'settings', tab: 'engines' })} className="text-ink-2 hover:text-terracotta">
                Update in Settings › Engines ›
              </button>
            </>
          ) : null}
        </p>
      ) : null}
      {row.switch && row.switch.names.length > 1 ? (
        <p className="leading-snug text-ink-2">
          {row.switch.names.length} plugins ship this server at one address, and Claude Code connects it once — its switch turns every copy off or on together:{' '}
          <span className="font-mono text-[11px]">{row.switch.names.join(' · ')}</span>.
        </p>
      ) : row.switch?.reaches?.length ? (
        <p className="leading-snug text-ink-2">
          Its switch goes by name, so it reaches {row.switch.reaches.length === 1 ? 'one more row' : `${row.switch.reaches.length} more rows`} with the same
          name.
        </p>
      ) : null}
      {row.parent ? (
        <button type="button" onClick={() => onOpen(row.parent!)} className="block text-ink-2 hover:text-terracotta">
          Its plugin ›
        </button>
      ) : null}
      {c && carriesWords(c) ? (
        <div className="border-t border-line/70 pt-2">
          <p className="font-display text-[14px] text-ink">{row.state === 'available' ? 'What adding it brings' : 'What it carries'}</p>
          <dl className="mt-1 divide-y divide-line/60">
            {list('Skills', c.skills)}
            {list('Commands', c.commands)}
            {list('Subagent types', c.agents)}
            {c.hooks.count > 0 ? (
              <div className="grid grid-cols-[7.5rem_minmax(0,1fr)] gap-2 py-1">
                <dt className="text-ink-3">
                  Hooks <span className="font-mono text-[10.5px] tabular-nums">{c.hooks.count}</span>
                </dt>
                <dd className="min-w-0 font-mono text-[11.5px] text-ink-2">on {c.hooks.events.join(' · ')}</dd>
              </div>
            ) : null}
            {c.mcp + c.placeholders > 0 ? (
              <div className="grid grid-cols-[7.5rem_minmax(0,1fr)] gap-2 py-1">
                <dt className="text-ink-3">
                  MCP servers <span className="font-mono text-[10.5px] tabular-nums">{c.mcp}</span>
                </dt>
                <dd className="min-w-0 text-ink-2">
                  {c.placeholders > 0 ? `and ${c.placeholders} ${c.placeholders === 1 ? 'placeholder' : 'placeholders'} — ` : ''}each a row under it, unfold it
                  in the list
                </dd>
              </div>
            ) : null}
            {list('LSP servers', c.lsp)}
            {list('Output styles', c.outputStyles)}
          </dl>
        </div>
      ) : null}
    </div>
  )
}

// a plugin this project does not load, opened: its engine's estimate of what
// it would add to every start (POST …/loads/projected — the engine runs its
// CLI once per plugin version). Never for a row this project loads or one
// with a measured weight. «asking» only once the answer is slow to come, so
// a quick «can't say» never flickers.
function useProjected(folder: string | null, row: LoadsRow, measured: boolean): { tokens: number | null; by?: string; asking: boolean } {
  const ask = folder !== null && row.kind === 'plugin' && row.state !== 'active' && !measured
  const [got, setGot] = useState<{ key: string; tokens: number | null; by?: string } | null>(null)
  const [slow, setSlow] = useState(false)
  useEffect(() => {
    setGot(null)
    setSlow(false)
    if (!ask) return
    let cancelled = false
    const t = setTimeout(() => {
      if (!cancelled) setSlow(true)
    }, 400)
    api.folders
      .loadsProjected(folder!, row.key)
      .then(
        (r) => {
          if (!cancelled) setGot(r)
        },
        () => {
          if (!cancelled) setGot({ key: row.key, tokens: null })
        },
      )
      .finally(() => clearTimeout(t))
    return () => {
      cancelled = true
      clearTimeout(t)
    }
  }, [ask, folder, row.key])
  const mine = ask && got?.key === row.key ? got : null
  return { tokens: mine?.tokens ?? null, ...(mine?.by ? { by: mine.by } : {}), asking: ask && got === null && slow }
}

// an own server's Secrets (by name — the values stay in the Vault) and its
// Remove, on its own page: the one house where it is edited
function OwnToolFacts({ agent, row, onChanged }: { agent: AgentView; row: OwnToolRow; onChanged: () => void }) {
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    setConfirm(false)
    setError(null)
  }, [row.name])
  async function remove(): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      await api.agents.tools.remove(agent.id, row.name)
      onChanged()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }
  return (
    <div className="mt-3 space-y-2 text-[12px]" data-testid="own-tool-facts">
      {row.refs.length > 0 ? (
        <p className="leading-snug text-ink-2">
          Takes{' '}
          {row.refs.map((r, i) => (
            <span key={r}>
              {i > 0 ? ', ' : ''}
              <span className={`font-mono ${row.needs.includes(r) ? AMBER : 'text-ink'}`}>{r}</span>
            </span>
          ))}{' '}
          from {agent.name}’s Secrets
          {row.needs.length > 0
            ? ` — ${row.needs.length === 1 ? 'one isn’t' : `${row.needs.length} aren’t`} there yet, so the server starts without ${row.needs.length === 1 ? 'it' : 'them'}.`
            : '.'}
        </p>
      ) : (
        <p className="text-ink-3">No secrets — it starts with nothing from the Vault.</p>
      )}
      {error ? (
        <p role="alert" className="text-terracotta">
          {error}
        </p>
      ) : null}
      {confirm ? (
        <p className="flex items-center gap-2">
          <span className="text-ink-2">
            Remove {row.name} from {agent.name}?
          </span>
          <button
            type="button"
            disabled={busy}
            onClick={() => void remove()}
            className="rounded-full border border-terracotta/50 px-2 py-px text-[11px] text-terracotta hover:bg-terracotta/10 disabled:opacity-50"
          >
            {busy ? '…' : 'Remove'}
          </button>
          <button type="button" onClick={() => setConfirm(false)} className="text-[11px] text-ink-2 hover:text-ink">
            Keep
          </button>
        </p>
      ) : (
        <button type="button" onClick={() => setConfirm(true)} className="text-[11.5px] text-ink-2 hover:text-terracotta">
          Remove from {agent.name}
        </button>
      )}
    </div>
  )
}
