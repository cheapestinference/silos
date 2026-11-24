// routes.ts — TWO families of pure helpers, no runtime dependencies:
//
//  1. basename(): a FILE path helper (POSIX-style basename, no node:path
//     since this runs in the browser). Imported by ~10 modules.
//
//  2. Silos's URL router: "all navigable state lives in the URL —
//     deep-linkable, refresh-restorable, back/forward". `stateToRoute`
//     serializes the navigation state to a path; `routeToState` parses it
//     back into a structured intent that the sync layer (lib/router.ts)
//     applies via the store's actions. BOTH are pure and fully tested
//     (test/routes.test.ts) — the bridge with the store and history lives
//     separately.
//
// URL schema — exactly what parses (no aliases; a retired address is
// an unknown path, and an unknown path lands on Home):
//   /                  ?sheet=<sheet>         Home; with a sheet, one tile's list open over it (HOME_SHEETS)
//   /tasks?view=&layout=&agent=&project=&plan=&from=  Tasks — every plan task. The URL names the view
//                                              (view: TaskPreset — mine|open|untouched|done, and the
//                                              tab-less idle|start that narrow Open; layout; facets,
//                                              which may repeat); what it leaves out falls back to the
//                                              viewer's remembered choice
//   /task/<planKey>/<taskId>[?from=<origin>]  one task's page (the plan's record key in the
//                                              Plans silo, encoded as ONE segment, + the task id);
//                                              `from` is the list it was opened from (TaskOrigin)
//   /automations[?agent=<id>]                 every automation, one list (optionally narrowed to one
//                                              agent — a removable chip, Tasks' grammar)
//   /automation/<id>                          one automation
//   /automation/new[?template=&proposal=&agent=]  the automation editor, creating one
//   /usage?period=&by=&agent=                  Usage — what the fleet spent
//   /background                               background work (subagents) across conversations
//   /map              /map/org                the Map (view: absent = Uses, the usage matrix
//                                              counted from transcripts; Org who reports to whom)
//   /system                                   System's landing: the machine's vitals (disk, memory, fleet, runs)
//   /files[?path=<file>][&folder=<folder>]    Files, optionally with one file open or rooted at a folder
//   /vault[?sign=<taskKey>|?entry=<id>]       the Vault (the fleet's keyring); sign = a task whose
//                                              binding ask opens prefilled; entry = one entry open
//   /settings         /settings/<tab>         Settings (tab: SettingsTab — its label in kebab-case;
//                                              /settings/silos manages the silos: their one address)
//   /silo/<id>                                an installed silo's page (its `list` archetype, or its
//                                              tree when it holds only a relation)
//   /silo/<id>/r/<key>                        one record's page (the key — 'agent:finance/a1' — is
//                                              one encoded segment)
//   /silo/<id>/review                         the install dialog of its pending submission
//   /silo/<id>/v/<view>                       the same page on another of its list views (System: worktrees)
//   /agent/<id>                               the agent page (landing = Now, the 'threads' facet)
//   /agent/<id>/<facet>                       the agent page on a tab (Tab: memory|inbox|context|…)
//   /agent/<id>/<files facet>/artifacts       its Files tab on Artifacts (FilesPart)
//   /agent/<id>/settings  /agent/<id>/secrets  the tabs addressed by their name — facets 'identity'
//                                              and 'vault' (never by those ids)
//   /agent/<id>/control                       its Automations tab (control, heartbeat, limits, automations — set)
//   /agent/<id>[/<facet>]?from=<folder>/<sessionId>  the agent page reached from a conversation
//                                              (its `‹ <title>` return chip)
//   /agent/<id>/new                           the agent's new chat (newChatOpen)
//   /agent/<id>/c/<folder>/<sessionId>        an open conversation
//   /project/<folder>  /project/<folder>/<tab>   project (tab: ProjectTab — now·memory·files·skills·tools·map,
//                                                 landing 'now' omitted); /files/artifacts = Files on Artifacts
//   /project/<folder>?sheet=<sheet>           a tile's list over a project's Now — a sheet is an
//                                              address, so Back from a task lands on its list
//   <any page but Files>?file=<path>          a file open in the one viewer over that page
//
// Notes:
//  - Every dynamic segment (id/folder/sessionId) is encoded with
//    encodeURIComponent, so a POSIX folder ('/home/u/x') is a SINGLE
//    segment and doesn't break the split.
//  - The master agent is /agent/master (its reserved id, no special case).
//  - An unknown/invalid path falls back to home (page null) — it never crashes.
//  - chosenProject deliberately does NOT go in the URL: it's a transient
//    detail of composing master's new chat (which folder is being picked),
//    not navigable state in its own right — it's not deep-linkable and
//    makes no sense to restore after a refresh.
export function basename(path: string): string {
  return path.split('/').filter(Boolean).pop() ?? path
}

import type { Page, Tab, ProjectTab, FilesPart, SettingsTab } from '../store'
import type { TaskLayout, TaskPreset } from './tasks'

// A Tasks view as an address. Absent = not said by the URL (the view falls
// back to what the viewer last chose).
export interface TasksQuery {
  view?: TaskPreset
  layout?: TaskLayout
  agent?: readonly string[]
  project?: readonly string[]
  plan?: readonly string[]
  // what the view itself was opened from («‹ Org» on its head)
  from?: TaskOrigin
}

// Where a task's page — or a filtered Tasks view — was opened from: the back
// link's words, Esc's destination and the list previous/next walk.
export type TaskOrigin =
  | { kind: 'needs-you'; folder?: string }
  | { kind: 'yours'; folder?: string }
  | { kind: 'tasks'; query: TasksQuery }
  | { kind: 'org' }
  | { kind: 'silo'; id: string }
  | { kind: 'conversation'; folder: string; id: string }

// the lists Home (and a project's Now) opens over its board, by address
export const HOME_SHEETS = ['needs-you', 'yours', 'working', 'digest', 'quiet', 'since'] as const
export type HomeSheet = (typeof HOME_SHEETS)[number]
const isHomeSheet = (s: string | null | undefined): s is HomeSheet => (HOME_SHEETS as readonly string[]).includes(s ?? '')

const TASK_VIEWS: readonly TaskPreset[] = ['mine', 'open', 'untouched', 'done', 'idle', 'start']
const TASK_LAYOUTS: readonly TaskLayout[] = ['list', 'board', 'tree']

// valid sets at runtime (the store's `type`s only exist at compile time):
// a segment not found here is rejected and the route falls back to home.
const FACETS: readonly Tab[] = ['identity', 'memory', 'vault', 'threads', 'control', 'skills', 'context', 'mission', 'loaded', 'tools', 'inbox']
// the project's tabs, by name — the agent page's nouns
const PROJECT_TABS: readonly ProjectTab[] = ['now', 'memory', 'files', 'skills', 'tools', 'map']
// the Files tab's second part: …/files/artifacts on both pages
const ARTIFACTS = 'artifacts'
const SETTINGS_TABS: readonly SettingsTab[] = [
  'access',
  'appearance',
  'notifications',
  'accounts',
  'engines',
  'territory',
  'archived',
  'memories',
  'skills',
  'silos',
  'maintenance',
  'about',
]

// the two facets whose address is their tab's NAME, not their id: the
// URL says what the owner reads on the tab (Settings, Secrets)
const FACET_PATH: Partial<Record<Tab, string>> = { identity: 'settings', vault: 'secrets' }
const FACET_OF_PATH: Readonly<Record<string, Tab>> = { settings: 'identity', secrets: 'vault' }

function isFacet(s: string): s is Tab {
  return (FACETS as readonly string[]).includes(s)
}
// a path segment → its facet: the tab's name where it has one, never the id
function facetOf(seg: string): Tab | null {
  if (Object.hasOwn(FACET_OF_PATH, seg)) return FACET_OF_PATH[seg]!
  return isFacet(seg) && FACET_PATH[seg] === undefined ? seg : null
}
function isProjectTab(s: string): s is ProjectTab {
  return (PROJECT_TABS as readonly string[]).includes(s)
}
function isSettingsTab(s: string): s is SettingsTab {
  return (SETTINGS_TABS as readonly string[]).includes(s)
}

// what `stateToRoute` needs from the store — the whole navigation slice.
export interface RouteSnapshot {
  page: Page
  selected: { folder: string; id: string } | null
  newChatOpen: boolean
  tab: Tab
  projectTab: ProjectTab
  // the conversation the agent page was reached from (State.agentFrom)
  from?: { folder: string; id: string } | null
  // the tile's list open over Home or a project's Now (State.homeSheet)
  sheet?: HomeSheet | null
  // the file open in the one viewer over this page (State.viewingFile)
  file?: string | null
  // the Files tab's part, on the agent page and the project page (State.filesPart)
  filesPart?: FilesPart
}

// the structured intent `routeToState` returns — the sync layer applies it
// via the store's actions (selectAgent/openSession/openDossier/…).
export interface RouteIntent {
  page: Page
  // the open conversation (only with page.kind==='agent')
  session?: { folder: string; id: string }
  // the dossier's tab (if there's a conversation, it's the facet covering
  // it; otherwise, the dossier landing's tab)
  facet?: Tab
  // the agent's new chat (newChatOpen)
  newChat?: boolean
  // ProjectPage's tab (only with page.kind==='project')
  projectTab?: ProjectTab
  // the agent page's return chip (?from=<folder>/<id>, only on the agent page)
  from?: { folder: string; id: string }
  // the list open over Home or a project's Now (?sheet=)
  sheet?: HomeSheet
  // the file open over the page (?file=<path>, any page but Files)
  file?: string
  // the Files tab on its Artifacts part (agent or project page)
  filesPart?: FilesPart
}

// ?from=<folder>/<id> — each part encoded, so the LAST '/' splits them
function fromQuery(f: { folder: string; id: string }): string {
  return `?from=${enc(f.folder)}/${enc(f.id)}`
}
function parseFrom(raw: string | null | undefined): { folder: string; id: string } | undefined {
  if (!raw) return undefined
  const cut = raw.lastIndexOf('/')
  if (cut <= 0 || cut === raw.length - 1) return undefined
  return { folder: raw.slice(0, cut), id: raw.slice(cut + 1) }
}

const enc = encodeURIComponent

// ── a Tasks view and a task's origin as text ──────────────────────────────

// the query string of a Tasks view, fixed order, '' when it says nothing
export function tasksQueryString(q: TasksQuery): string {
  const out = new URLSearchParams()
  if (q.view) out.set('view', q.view)
  if (q.layout) out.set('layout', q.layout)
  for (const v of q.agent ?? []) out.append('agent', v)
  for (const v of q.project ?? []) out.append('project', v)
  for (const v of q.plan ?? []) out.append('plan', v)
  if (q.from) out.set('from', taskOriginToken(q.from))
  return out.toString()
}

export function parseTasksQuery(params: URLSearchParams | null): TasksQuery {
  if (!params) return {}
  const q: TasksQuery = {}
  const view = params.get('view')
  if ((TASK_VIEWS as readonly (string | null)[]).includes(view)) q.view = view as TaskPreset
  const layout = params.get('layout')
  if ((TASK_LAYOUTS as readonly (string | null)[]).includes(layout)) q.layout = layout as TaskLayout
  for (const facet of ['agent', 'project', 'plan'] as const) {
    const values = params.getAll(facet)
    if (values.length > 0) q[facet] = values
  }
  const from = parseTaskOrigin(params.get('from'))
  if (from) q.from = from
  return q
}

// `from`'s value: a word, a word and its one argument, or a Tasks view's own
// query string — never anything that only this session could resolve
export function taskOriginToken(o: TaskOrigin): string {
  switch (o.kind) {
    case 'needs-you':
    case 'yours':
      return o.folder !== undefined ? `${o.kind}:${o.folder}` : o.kind
    case 'tasks':
      return `tasks:${tasksQueryString(o.query)}`
    case 'org':
      return 'org'
    case 'silo':
      return `silo:${o.id}`
    case 'conversation':
      return `conversation:${enc(o.folder)}/${enc(o.id)}`
  }
}

export function parseTaskOrigin(raw: string | null | undefined): TaskOrigin | undefined {
  if (!raw) return undefined
  const cut = raw.indexOf(':')
  const word = cut < 0 ? raw : raw.slice(0, cut)
  const arg = cut < 0 ? null : raw.slice(cut + 1)
  switch (word) {
    case 'needs-you':
    case 'yours':
      return arg ? { kind: word, folder: arg } : { kind: word }
    case 'tasks':
      return { kind: 'tasks', query: parseTasksQuery(new URLSearchParams(arg ?? '')) }
    case 'org':
      return arg === null ? { kind: 'org' } : undefined
    case 'silo':
      return arg ? { kind: 'silo', id: arg } : undefined
    case 'conversation': {
      const split = arg ? parseFrom(arg) : undefined
      if (!split) return undefined
      try {
        return { kind: 'conversation', folder: decodeURIComponent(split.folder), id: decodeURIComponent(split.id) }
      } catch {
        return undefined
      }
    }
    default:
      return undefined
  }
}

const withQuery = (path: string, query: string): string => (query ? `${path}?${query}` : path)

// state -> path. Pivots on `page.kind` as the top-level dimension; the
// rest of the fields (selected/newChat/dossier/tab) only matter when
// the page is of type 'agent'.
// A file open in the one viewer rides ANY page as ?file=<path>: a file is
// a sheet over the place you are in, never a change of
// place. Files mode carries its own open file as ?path= and takes no sheet.
export function stateToRoute(s: RouteSnapshot): string {
  const base = placeRoute(s)
  if (!s.file || s.page?.kind === 'files') return base
  return `${base}${base.includes('?') ? '&' : '?'}file=${enc(s.file)}`
}

function placeRoute(s: RouteSnapshot): string {
  const p = s.page
  if (p === null) return s.sheet ? `/?sheet=${s.sheet}` : '/'
  switch (p.kind) {
    case 'agent': {
      const base = `/agent/${enc(p.id)}`
      // nothing covers a conversation any more:
      // a conversation's URL is the conversation alone.
      if (s.selected) return `${base}/c/${enc(s.selected.folder)}/${enc(s.selected.id)}`
      if (s.newChatOpen) return `${base}/new`
      // dossier: 'threads' is the canonical landing => omitted from the path.
      const tabbed = s.tab && s.tab !== 'threads' ? `${base}/${FACET_PATH[s.tab] ?? s.tab}` : base
      const page = s.tab === 'context' && s.filesPart === 'artifacts' ? `${tabbed}/${ARTIFACTS}` : tabbed
      return s.from ? page + fromQuery(s.from) : page
    }
    case 'project': {
      const base = `/project/${enc(p.folder)}`
      if (s.projectTab === 'files' && s.filesPart === 'artifacts') return `${base}/files/${ARTIFACTS}`
      if (s.projectTab && s.projectTab !== 'now') return `${base}/${s.projectTab}`
      return s.sheet ? `${base}?sheet=${s.sheet}` : base
    }
    case 'settings':
      return p.tab ? `/settings/${p.tab}` : '/settings'
    case 'automation':
      // /automation/new is the editor creating one; the agent it starts
      // with rides as a query value (?agent=<id>), like Files' open file.
      if (p.id === 'new') {
        // a template being filled in rides as ?template=<id>, next to ?agent
        // …and a proposal under review as ?proposal=<id>
        const q = [p.template ? `template=${enc(p.template)}` : '', p.proposal ? `proposal=${enc(p.proposal)}` : '', p.agent ? `agent=${enc(p.agent)}` : '']
          .filter(Boolean)
          .join('&')
        return q ? `/automation/new?${q}` : '/automation/new'
      }
      return `/automation/${enc(p.id)}`
    case 'automations':
      return p.agent ? `/automations?agent=${enc(p.agent)}` : '/automations'
    case 'tasks':
      return withQuery('/tasks', tasksQueryString(p))
    case 'task':
      // `give=1`: it opens on «Give to…» (a task whose owner works in another project)
      return withQuery(
        `/task/${enc(p.plan)}/${enc(p.task)}`,
        [p.from ? `from=${enc(taskOriginToken(p.from))}` : '', p.give ? 'give=1' : ''].filter(Boolean).join('&'),
      )
    case 'background':
      return '/background'
    case 'usage':
      return withQuery(
        '/usage',
        [p.period && p.period !== 'today' ? `period=${p.period}` : '', p.by && p.by !== 'agent' ? `by=${p.by}` : '', p.agent ? `agent=${enc(p.agent)}` : '']
          .filter(Boolean)
          .join('&'),
      )
    case 'map':
      // an absent `view` is Uses, the landing — Org gets a segment
      return p.view === 'org' ? '/map/org' : '/map'
    case 'system':
      return '/system'
    case 'files':
      // the open file rides along as a query param — it can be any absolute
      // path, so it's a query value, not a path segment. Absent → just
      // "you're in Files mode".
      return withQuery('/files', [p.folder ? `folder=${enc(p.folder)}` : '', p.path ? `path=${enc(p.path)}` : ''].filter(Boolean).join('&'))
    case 'vault':
      // an ask's door: the task whose proposed binding opens prefilled;
      // an agent's Secrets row «in the Vault ›»: that entry, open
      // «Add a secret» opened from a place starts on it: add=project:<folder> · add=agent:<id>
      return p.sign ? `/vault?sign=${enc(p.sign)}` : p.entry ? `/vault?entry=${enc(p.entry)}` : p.add ? `/vault?add=${enc(p.add)}` : '/vault'
    case 'silo':
      // the record key ('agent:finance/a1') holds '/' and ':' — encoded, it is a
      // single segment under /r/, same criterion as a project folder.
      // /review is the install dialog of its pending submission
      // /v/<view> is one of its list views, when not the first
      return p.recordKey
        ? `/silo/${enc(p.id)}/r/${enc(p.recordKey)}`
        : p.review
          ? `/silo/${enc(p.id)}/review`
          : p.view
            ? `/silo/${enc(p.id)}/v/${enc(p.view)}`
            : `/silo/${enc(p.id)}`
  }
}

// path -> intent. A pure parse; anything that doesn't fit the schema falls
// back to home (page null) without throwing.
export function routeToState(path: string): RouteIntent {
  const intent = placeIntent(path)
  if (intent.page?.kind === 'files') return intent
  const q = path.indexOf('?')
  const file = q >= 0 ? new URLSearchParams(path.slice(q + 1).split('#')[0]).get('file') : null
  return file ? { ...intent, file } : intent
}

function placeIntent(path: string): RouteIntent {
  const HOME: RouteIntent = { page: null }
  // the query string / hash are not part of the PATH schema — split them off.
  // The query is still parsed for the few routes that carry a value there
  // (Files' open file), never as a path segment.
  const qIndex = path.indexOf('?')
  const query = qIndex >= 0 ? new URLSearchParams(path.slice(qIndex + 1).split('#')[0]) : null
  const clean = path.split('?')[0]!.split('#')[0]!
  const segments = clean
    .split('/')
    .filter(Boolean)
    .map((s) => {
      try {
        return decodeURIComponent(s)
      } catch {
        return s // a corrupt %-encoding is left raw rather than crashing
      }
    })
  const sheetParam = query?.get('sheet')
  const sheet = isHomeSheet(sheetParam) ? { sheet: sheetParam } : {}
  if (segments.length === 0) return { ...HOME, ...sheet }

  switch (segments[0]) {
    case 'agent': {
      const id = segments[1]
      if (!id) return HOME
      const page: Page = { kind: 'agent', id }
      const rest = segments.slice(2)
      const from = parseFrom(query?.get('from'))
      if (rest.length === 0) return from ? { page, from } : { page } // dossier landing
      if (rest[0] === 'new') return rest.length === 1 ? { page, newChat: true } : HOME
      if (rest[0] === 'c') {
        const folder = rest[1]
        const sessionId = rest[2]
        if (rest.length !== 3 || !folder || !sessionId) return HOME
        return { page, session: { folder, id: sessionId } }
      }
      // /agent/<id>/<facet>, and its Files tab on Artifacts
      const facet = rest.length === 1 ? facetOf(rest[0]!) : null
      if (facet) return from ? { page, facet, from } : { page, facet }
      if (rest.length === 2 && facetOf(rest[0]!) === 'context' && rest[1] === ARTIFACTS) {
        const files: RouteIntent = { page, facet: 'context', filesPart: 'artifacts' }
        return from ? { ...files, from } : files
      }
      return HOME
    }
    case 'project': {
      const folder = segments[1]
      if (!folder) return HOME
      const page: Page = { kind: 'project', folder }
      const rest = segments.slice(2)
      if (rest.length === 0) return { page, ...sheet }
      if (rest.length === 1 && isProjectTab(rest[0]!)) return { page, projectTab: rest[0] }
      if (rest.length === 2 && rest[0] === 'files' && rest[1] === ARTIFACTS) return { page, projectTab: 'files', filesPart: 'artifacts' }
      return HOME
    }
    case 'settings': {
      const rest = segments.slice(1)
      if (rest.length === 0) return { page: { kind: 'settings' } }
      if (rest.length === 1 && isSettingsTab(rest[0]!)) return { page: { kind: 'settings', tab: rest[0] } }
      return HOME
    }
    case 'automation': {
      const id = segments[1]
      if (!id || segments.length !== 2) return HOME
      if (id === 'new') {
        const agent = query?.get('agent')
        const template = query?.get('template')
        const proposal = query?.get('proposal')
        return { page: { kind: 'automation', id, ...(agent ? { agent } : {}), ...(template ? { template } : {}), ...(proposal ? { proposal } : {}) } }
      }
      return { page: { kind: 'automation', id } }
    }
    case 'automations': {
      // every automation as one list; ?agent=<id> narrows it to one agent
      if (segments.length !== 1) return HOME
      const agent = query?.get('agent')
      return { page: agent ? { kind: 'automations', agent } : { kind: 'automations' } }
    }
    case 'tasks':
      // every plan task
      return segments.length === 1 ? { page: { kind: 'tasks', ...parseTasksQuery(query) } } : HOME
    case 'task': {
      // one task: /task/<plan key>/<task id> — the plan key holds '/' and
      // ':' ('folder:/home/u/proj/ship'), encoded as one segment
      if (segments.length !== 3 || !segments[1] || !segments[2]) return HOME
      const from = parseTaskOrigin(query?.get('from'))
      return {
        page: { kind: 'task', plan: segments[1], task: segments[2], ...(from ? { from } : {}), ...(query?.get('give') === '1' ? { give: true as const } : {}) },
      }
    }
    case 'background':
      // the global background-work view
      return segments.length === 1 ? { page: { kind: 'background' } } : HOME
    case 'usage': {
      // what the fleet spent; the view rides the query
      if (segments.length !== 1) return HOME
      const period = query?.get('period')
      const by = query?.get('by')
      const agent = query?.get('agent')
      return {
        page: {
          kind: 'usage',
          ...(period === '7d' || period === '30d' || period === 'today' ? { period } : {}),
          ...(by === 'agent' || by === 'task' || by === 'automation' || by === 'conversation' || by === 'account' ? { by } : {}),
          ...(agent ? { agent } : {}),
        },
      }
    }
    case 'map': {
      const rest = segments.slice(1)
      if (rest.length === 0) return { page: { kind: 'map' } }
      if (rest.length === 1 && rest[0] === 'org') return { page: { kind: 'map', view: 'org' } }
      return HOME
    }
    case 'system':
      return segments.length === 1 ? { page: { kind: 'system' } } : HOME
    case 'files': {
      if (segments.length !== 1) return HOME
      const filePath = query?.get('path') || undefined
      const folder = query?.get('folder') || undefined
      return { page: { kind: 'files', ...(folder ? { folder } : {}), path: filePath } }
    }
    case 'vault': {
      if (segments.length !== 1) return HOME
      const sign = query?.get('sign') || undefined
      const entry = query?.get('entry') || undefined
      const add = query?.get('add') || undefined
      return { page: sign ? { kind: 'vault', sign } : entry ? { kind: 'vault', entry } : add ? { kind: 'vault', add } : { kind: 'vault' } }
    }
    case 'silo': {
      const id = segments[1]
      if (!id) return HOME
      if (segments.length === 2) return { page: { kind: 'silo', id } }
      if (segments.length === 3 && segments[2] === 'review') return { page: { kind: 'silo', id, review: true } }
      if (segments.length === 4 && segments[2] === 'r' && segments[3]) return { page: { kind: 'silo', id, recordKey: segments[3] } }
      if (segments.length === 4 && segments[2] === 'v' && segments[3]) return { page: { kind: 'silo', id, view: segments[3] } }
      return HOME
    }
    default:
      return HOME
  }
}

// bridge: reconstructs the canonical RouteSnapshot that corresponds to an
// intent — used by the round-trip test
// (stateToRoute(intentToSnapshot(routeToState(p)))===p) and as a
// convenient way to derive the route of an already-parsed intent.
export function intentToSnapshot(i: RouteIntent): RouteSnapshot {
  const isAgent = i.page?.kind === 'agent'
  return {
    page: i.page,
    selected: i.session ?? null,
    newChatOpen: i.newChat ?? false,
    tab: isAgent && !i.session && !i.newChat ? (i.facet ?? 'threads') : 'threads',
    projectTab: i.projectTab ?? 'now',
    from: isAgent && !i.session && !i.newChat ? (i.from ?? null) : null,
    sheet: i.sheet ?? null,
    file: i.file ?? null,
    filesPart: i.filesPart ?? 'files',
  }
}

// ── the history's grammar ──────────────────────────────────────────────────
// The browser's history is the ONLY stack. Two routes are the same STOP when
// they differ only in a filter, an order, a view of a list or a value that
// rides along (an agent picked in the editor); the sync layer then REPLACES
// the entry. A different stop — another place, another tab of a place, a
// sheet opened over a page, a record/file/template opened over its list —
// PUSHES, so Back returns (and closes the sheet).
//
//   - tabs of a place (agent, project, Settings sections incl. Silos): a stop each
//   - a sheet over Home / a project's Now: a stop; Back closes it
//   - Automations: one list; ?agent=<id> is a filter (one stop)
//   - Map views (Uses·Org): views of one map → replace
//   - Tasks view/layout/facets: → replace
//   - Files: the open file is a stop (opened over the explorer)
//   - the editor: ?agent= is a field (replace), ?template= a stop
//   - a file over any page (?file=): a stop; Back closes it
export function contextKey(path: string): string {
  const i = routeToState(path)
  const place = placeContextKey(i)
  return i.file ? `${place}|file:${i.file}` : place
}

function placeContextKey(i: RouteIntent): string {
  const p = i.page
  if (p === null) return i.sheet ? `home:${i.sheet}` : 'home'
  switch (p.kind) {
    case 'agent':
      // a conversation is one stop whichever agent the URL names (the
      // canonicalization to its real owner is the same stop)
      if (i.session) return `conv:${i.session.folder}:${i.session.id}`
      if (i.newChat) return `agent:${p.id}:new`
      // ?from= is the return chip, not a place: the same tab with or
      // without it is one stop
      return `agent:${p.id}:${i.facet ?? 'threads'}${i.filesPart === 'artifacts' ? `:${ARTIFACTS}` : ''}`
    case 'project': {
      const tab = i.projectTab ?? 'now'
      return `project:${p.folder}:${tab}${tab === 'now' && i.sheet ? `:${i.sheet}` : ''}${i.filesPart === 'artifacts' ? `:${ARTIFACTS}` : ''}`
    }
    case 'settings':
      return `settings:${settingsSection(p.tab)}`
    case 'automations':
      // narrowed to one agent or not, it is one list: one stop
      return 'automations'
    case 'tasks':
      return 'tasks'
    case 'task':
      return `task:${p.plan}:${p.task}`
    case 'background':
      return 'background'
    case 'system':
      return 'system'
    case 'usage':
      // one stop whatever its period, view or agent
      return 'usage'
    case 'automation':
      if (p.id === 'new') return p.template ? `automation:new:${p.template}` : p.proposal ? `automation:new:proposal:${p.proposal}` : 'automation:new'
      return `automation:${p.id}`
    case 'map':
      // unchanged by `view` — Uses/Org are views of one map
      return 'map'
    case 'files':
      return `files:${p.path ?? ''}`
    case 'vault':
      return 'vault'
    case 'silo':
      // the record page is a real stop (list → record → Back returns to
      // the list). The dialog too: Back from it returns to where it was opened
      return p.recordKey ? `silo:${p.id}:${p.recordKey}` : p.review ? `silo:${p.id}:review` : p.view ? `silo:${p.id}:v:${p.view}` : `silo:${p.id}`
  }
}

// the Settings section a tab paints: a bare /settings paints the first
// one, Access (no aliases)
export function settingsSection(t: SettingsTab | undefined): SettingsTab {
  return t ?? 'access'
}

// the PLACE a route is in — coarser than a stop: the tabs, sheets and open
// file of one place are one place; stepping task to task (‹ n of N ›) stays
// on «a task's page». A UI «back» link walks back over entries of its own
// place only (returnSteps).
export function placeKey(path: string): string {
  const i = routeToState(path)
  const p = i.page
  if (p === null) return 'home'
  switch (p.kind) {
    case 'agent':
      if (i.session) return `conv:${i.session.folder}:${i.session.id}`
      return i.newChat ? `agent:${p.id}:new` : `agent:${p.id}:dossier`
    case 'project':
      return `project:${p.folder}`
    case 'settings':
      return 'settings'
    case 'automations':
      return 'automations'
    case 'task':
      return 'task'
    case 'automation':
      return p.id === 'new' ? 'automation:new' : `automation:${p.id}`
    case 'files':
      return 'files'
    case 'silo':
      return contextKey(path)
    default:
      return p.kind
  }
}

// where a task's origin link leads, as a route — its «back» target. No
// origin = the Tasks list. A conversation is one stop whichever agent the
// URL names, so the owner is not needed to recognise it below.
export function taskOriginRoute(o: TaskOrigin | undefined): string {
  const base: RouteSnapshot = { page: null, selected: null, newChatOpen: false, tab: 'threads', projectTab: 'now' }
  switch (o?.kind) {
    case undefined:
      return stateToRoute({ ...base, page: { kind: 'tasks' } })
    case 'needs-you':
    case 'yours':
      return stateToRoute({ ...base, page: o.folder !== undefined ? { kind: 'project', folder: o.folder } : null, sheet: o.kind })
    case 'tasks':
      return stateToRoute({ ...base, page: { kind: 'tasks', ...o.query } })
    case 'org':
      return stateToRoute({ ...base, page: { kind: 'map', view: 'org' } })
    case 'silo':
      return stateToRoute({ ...base, page: { kind: 'silo', id: o.id } })
    case 'conversation':
      return stateToRoute({ ...base, page: { kind: 'agent', id: 'master' }, selected: { folder: o.folder, id: o.id } })
  }
}

// How many entries Back must walk for a UI «back» link («‹ conversation»,
// a task's «‹ Needs you», «‹ silo», a sheet's ✕) to land on `target` — the
// browser's own stack, never a new entry on top. `trail` is the URLs below
// the current entry, oldest first (the router keeps it in history.state).
// It walks back over entries of the CURRENT place only (the tabs visited on
// the agent page, the tasks stepped through): the first entry that is the
// target's stop answers; anything else — another place, a cold entry (a
// pasted link, a push notification) — answers 0: the link navigates
// instead, replacing, so it never stacks.
export function returnSteps(trail: readonly string[], current: string, target: string): number {
  const want = contextKey(target)
  const here = placeKey(current)
  for (let j = trail.length - 1, n = 1; j >= 0; j--, n++) {
    const entry = trail[j]!
    if (contextKey(entry) === want) return n
    if (placeKey(entry) !== here) return 0
  }
  return 0
}
