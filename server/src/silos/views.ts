// silos/views.ts — the records of a silo as the web paints them (the routes
// Task 8's list and record pages read). Shapes are
// descriptors: everything a page needs to draw comes in the answer — the
// kind's states with their words, the columns, the facets with their counts
// — so the page never asks for a silo by name.
//
// Honesty: server-side pagination, every count over the WHOLE set,
// and a cut said in words («showing 50 of 614»). Folded records are flagged
// and sorted last — folding never hides.
//
// A list view may also declare (catalogs.md `list`): `first` — the
// records that come first (the mirror of fold: a predicate, never a hidden
// sort); `groupBy` — one dimension whose records stay together under a
// heading, every group counted over the whole matching set, the records with
// no value in a group of their own, LAST and named («No conversation»).
// Groups are contiguous across pages (the order is total: the group's value
// breaks every tie). And a search (`q`) over the identity and the cells the
// view shows — an explicit ask, counted honestly like any filter.
import { createHash } from 'node:crypto'
import { readContained } from '../safe-file.js'
import { RECORD_MAX_BYTES, recordPlace } from './files-source.js'
import type { SiloEntry } from './registry.js'
import type { SiloReading, SiloRecord } from './reader.js'
import type { JournalLine, TransitionJournal } from './journal.js'
import type { TaskFlow } from './task-flow.js'
import { turnOf, type TaskTurn } from './turn.js'
import { standingIdsOf } from './manifest.js'
import { taskRefOf } from './task-ref.js'
import { kernelKindFor, kernelVerb } from './kernel-kinds.js'
import {
  baseRecordOf,
  cell,
  childColumn,
  flowOf,
  holds,
  kindsOf,
  labelOfField,
  labelOne,
  needsYouKind,
  recordsOfKind,
  rowOf,
  terminalsOf,
  type KindInfo,
  type KindRecord,
  type Voice,
} from './voice.js'

type Json = Record<string, unknown>
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)
const isStr = (v: unknown): v is string => typeof v === 'string'

export const RECORDS_PAGE_DEFAULT = 50
export const RECORDS_PAGE_MAX = 200

export interface GroupDoor {
  hub: 'agent' | 'folder' | 'conversation'
  value: string
}

export interface StateWord {
  value: string
  one: string
  many: string
  terminal: boolean
}

export interface KindDescriptor {
  name: string // qualified: invoices/invoice
  states: StateWord[]
  columns: string[]
  // the declared type of each column that is a typed field of the kind
  // ('money', 'timestamp', 'state'…) — what a page needs to set a column
  // (money right-aligned). A column the kind does not type is absent.
  columnTypes: Record<string, string>
  // the plain words of a column whose field declares a `label` (fieldSpec)
  // — `at` by the field the envelope maps it to. Absent: the page's
  // own words for it (the column's name, said plainly)
  columnLabels: Record<string, string>
  // the view's group dimension (list `groupBy`): rows carry their `group`
  groupBy: { field: string; label: string } | null
  facets: Array<{ name: string; values: Array<{ value: string; label: string; count: number }> }>
  // the kernel-verbs the manifest declares on this kind (catalogs.md
  // «Kernel-verbs»): each with the catalog's word for its door and its
  // guard field; every row then says in `verbs` which of them hold for it
  // (its declared `when`). Absent: the kind declares none.
  verbs?: Array<{ name: string; says: string; pending: string; guard: string }>
  // the list view's fold (list `fold`): its `label` — what the folded
  // records are, in a few words («ended or another user's») — or null when
  // the view folds without saying (the page says «N more»); the whole
  // field is null when the view declares no fold
  fold: { label: string | null } | null
  // the state is a field the owner may set (a set-field action lists it):
  // the list paints it as a select on every row — the same set-field the
  // record page dispatches. null = read-only.
  stateEdit: { field: string; values: string[] } | null
  // a kind presenting kernel data: what the kernel reads for it, in the
  // catalog's words (the empty list says «Silos keeps them here from …»)
  reads?: string
}

export interface RecordRow {
  key: string
  id: string
  identity: string
  state: string | null
  stateLabel: string
  at: string | null
  anchors: Json
  cells: Array<{ column: string; text: string }>
  row: string // the one-line voice (identity — state · due …)
  folded: boolean
  first: boolean // the view's `first` predicate holds: it comes first, and the page lets it draw the eye
  // the view's group (list `groupBy`): its value (null: no value — the last
  // group, named by `label`) and how many MATCHING records it holds, over
  // the whole set (a page may show only part of it: the page says so)
  // `opens`: the group's value names something the pages open — an agent,
  // a folder, a conversation (`<folder>/<id>`, a kernel kind's `refs`) —
  // and every record of the group names the same one: its heading is that
  // door. Absent: words only (a deleted conversation, «No conversation»)
  group?: { value: string | null; label: string; count: number; opens?: GroupDoor }
  needsYou: boolean // a needs-you entry holds for it right now (and is not cleared)
  overlay: boolean // the owner's change stands over the source
  conflict: boolean
  remarks: string[]
  file: string | null
  // a sub-kind's row: the record it lives in (a plan's task → its plan)
  // standingList: the parent is a standing record (an ensure-record id of
  // its kind — plans: the project's list), shown with no title (R1)
  parent?: { key: string; identity: string; at: string | null; standingList?: true }
  // the record ITSELF is a standing one (m3 — plans: the project's list's
  // row in the plans list, the list's own page): said with no title
  standingList?: true
  // a task's label (E7): what the row PAINTS — `<project>#t3` for a
  // the project's list's task (`<project>/tasks#t3` when the project also has a
  // plan named like it), `<plan>#t3` otherwise. Never an address: the ref
  // stays `<plan>#<id>` in the API, the hook, the claim and the URLs
  label?: string
  // the kernel's task flow, when the kind declares roles.task (task-flow.ts)
  // — at request time, with the live facts: what a task view paints
  flow?: TaskFlow
  // whose turn it is, in one server-composed sentence (turn.ts) — the task
  // page's banner and any surface that wants the reading say THIS, so they
  // cannot drift apart
  turn?: TaskTurn
  // ?values=1: the record as the kernel reads it (lifted children included)
  // and the last moment the journal saw it appear or change state
  value?: Json
  moved?: string | null
  // the kernel-verbs whose `when` holds for this record now (by name) —
  // only on a kind that declares any (KindDescriptor.verbs). The kernel
  // re-checks at the gesture, whatever the page showed.
  verbs?: string[]
}

// The kernel-verbs a manifest declares on a kind, each with the closed
// catalog's word (`says`) and guard. A name the catalog does not know never
// reaches here (the validator refuses the manifest).
export interface DeclaredKernelVerb {
  name: string
  says: string
  pending: string
  guard: string
  when: unknown
}
export function kernelVerbsOf(manifest: Json, kind: string): DeclaredKernelVerb[] {
  const actions = Array.isArray((manifest.spec as Json | undefined)?.actions) ? ((manifest.spec as Json).actions as unknown[]).filter(isObj) : []
  return actions.flatMap((a) => {
    if (a.verb !== 'kernel-verb' || a.kind !== kind || !isStr(a.name)) return []
    const kv = kernelVerb(a.name)
    return kv ? [{ name: a.name, says: kv.says, pending: kv.pending, guard: kv.guard, when: a.when }] : []
  })
}

export interface RecordsPage {
  silo: { id: string; name: string | null; state: string; freshness: string | null }
  kind: KindDescriptor
  total: number // every readable record of the kind
  matching: number // after the filters
  offset: number
  limit: number
  said: string | null // «showing 50 of 614» when the page is not the whole set
  unreadable: { count: number; items: Array<{ file: string; rel: string; reason: string }> }
  records: RecordRow[]
}

export interface RecordsQuery {
  kind?: string
  id?: string // one record id (a deep link that knows the id, not the key)
  file?: string // the record read from this absolute path (a page that knows the file — plans, G9)
  // 'needs-you': the records a needs-you entry holds for first, then by at —
  // the agent page's compact section (waiting on you first)
  rank?: 'needs-you'
  state?: string
  facets?: Record<string, string>
  folded?: 'include' | 'exclude' | 'only'
  // words to find: every whitespace-separated term must appear (any case)
  // in the identity, a cell the view shows, or the record's group
  q?: string
  offset?: number
  limit?: number
  // each row carries its record as read and its journal moment (a view that
  // draws records its own way — the Tasks view)
  values?: boolean
}

// a field name said plainly: customerEmail → «customer email», total.currency → «currency»
function plainWords(name: string): string {
  return (name.split('.').pop() ?? name).replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase()
}

function statesOf(info: KindInfo): StateWord[] {
  return (Array.isArray(info.spec.states) ? info.spec.states : []).filter(isObj).map((s) => {
    const l = isObj(s.label) ? s.label : {}
    return {
      value: String(s.value),
      one: isStr(l.one) ? l.one : String(s.value),
      many: isStr(l.many) ? l.many : String(s.value),
      terminal: s.terminal === true,
    }
  })
}

// the view the manifest declares for this kind (a list first), if any
function viewOf(manifest: Json, kind: string): Json | null {
  const views = (Array.isArray((manifest.spec as Json).views) ? ((manifest.spec as Json).views as unknown[]) : []).filter(isObj)
  return views.find((v) => v.kind === kind && v.archetype === 'list') ?? views.find((v) => v.kind === kind) ?? null
}

// a project facet: the anchored agent's folder (catalog extension)
export type FolderOf = (agentId: string) => string | null

function facetValue(name: string, r: KindRecord, folderOf?: FolderOf): string | null {
  if (name === 'agent' || name === 'folder')
    return isStr(r.anchors[name]) ? (r.anchors[name] as string) : isStr(r.rec[name]) && r.rec[name] !== '' ? (r.rec[name] as string) : null
  // the anchored agent's folder — else the record's own `project` (a kernel
  // kind that names its main checkout: worktree)
  if (name === 'project')
    return isStr(r.anchors.agent) ? (folderOf?.(r.anchors.agent) ?? null) : isStr(r.rec.project) && r.rec.project !== '' ? (r.rec.project as string) : null
  const v = name.split('.').reduce<unknown>((cur, seg) => (isObj(cur) ? cur[seg] : undefined), r.rec)
  return isStr(v) || typeof v === 'number' || typeof v === 'boolean' ? String(v) : null
}

interface Context {
  entry: SiloEntry
  reading: SiloReading | null
  voice: Voice
  overlayKeys: Set<string>
  conflictKeys: Set<string>
  needsYou?: (r: KindRecord) => boolean
  values?: boolean
  journal?: TransitionJournal
  notes?: NoteProvenance
  verbs?: DeclaredKernelVerb[]
}

function baseOf(reading: SiloReading | null): KindRecord[] {
  return (reading?.records ?? []).map((r) => baseRecordOf(r, { source: true }))
}

// the last moment the journal saw this record appear or move (its own key's
// story); null when it has none — never the file's mtime, which any write
// moves, and never the baseline: that is when Silos first LOOKED, not when the
// record did anything
function movedOf(ctx: Context, r: KindRecord): string | null {
  if (!ctx.journal || r.source === undefined) return null
  const conv = ctx.entry.status.conventions.find((c) => c.source === r.source)
  if (!conv) return null
  const lines = ctx.journal.history(conv.dir, r.key).filter((l) => l.event === 'appeared' || l.event === 'transition')
  return lines.at(-1)?.at ?? null
}

// ── who wrote a task's note, as screens say it (A4) ──
// The check task mode reads (task-mode/owner-notes.ts through
// TaskModeEngine.ownerNoteCheck): per note signed "owner", whether Silos
// recorded the owner writing it.
export type NoteProvenance = (taskKey: string, notes: ReadonlyArray<{ at: string; text: string }>) => { fromOwner: boolean[] }
const NOTES = 'notes'

// (S10-r5) a note an unattended run left on a task of
// another owner, after reading outside: its marks live in plans-origins.json
// and are stamped here as `readOutside` — the task page paints « — written
// after reading the web (<tool>)» where the owner reads the note. Set once at
// boot (index.ts); absent, nothing is stamped.
let noteOutside: ((taskKey: string, note: { at: string; by: string }) => string[] | null) | null = null
export function setNoteOutside(fn: typeof noteOutside): void {
  noteOutside = fn
}

// A record's value (a task, or a record holding tasks — a plan) with
// `fromOwner: boolean` on every note of every task in it: true only for a
// note signed "owner" that the check vouches for. The web paints «You» from
// this field alone — the file's `by` is whatever an agent wrote. Never
// mutates the reading (a copy where it stamps).
export function withNoteProvenance(manifest: Json | null | undefined, kindName: string, key: string, value: Json, check: NoteProvenance): Json {
  if (!manifest) return value
  const kinds = kindsOf(manifest)
  const info = kinds.get(kindName)
  if (!info) return value
  const stampTask = (taskKey: string, task: Json): Json => {
    const notes = task[NOTES]
    if (!Array.isArray(notes)) return task
    const signed = notes.filter((n): n is Json => isObj(n) && n.by === 'owner')
    const m =
      signed.length > 0
        ? check(
            taskKey,
            signed.map((n) => ({ at: isStr(n.at) ? n.at : '', text: isStr(n.text) ? n.text : '' })),
          )
        : { fromOwner: [] }
    let i = 0
    return {
      ...task,
      [NOTES]: notes.map((n) => {
        if (!isObj(n)) return n
        const out = noteOutside?.(taskKey, { at: isStr(n.at) ? n.at : '', by: isStr(n.by) ? n.by : '' }) ?? null
        return { ...n, fromOwner: n.by === 'owner' ? m.fromOwner[i++] === true : false, ...(out ? { readOutside: out } : {}) }
      }),
    }
  }
  if (info.dict.task) return stampTask(key, value)
  let out = value
  for (const k of kinds.values()) {
    const coll = k.coll
    if (k.parent !== info || !k.dict.task || !coll || !Array.isArray(value[coll])) continue
    out = {
      ...out,
      [coll]: (value[coll] as unknown[]).map((t) =>
        isObj(t) && (isStr(t.id) || typeof t.id === 'number') ? stampTask(`${key}/${coll}/${String(t.id)}`, t) : t,
      ),
    }
  }
  return out
}

// The label a task row PAINTS (E7, S4/B2) — never an address.
// The project's list's task is said by its project: `<basename>#t3`, or
// `<basename>/<list>#t3` when the same location also holds a record named
// like its basename (the two would read alike); any other parent:
// `<parent id>#<id>`, the ref as people say it.
export function taskLabelOf(
  manifest: Json | null | undefined,
  info: KindInfo,
  location: string,
  parentId: string,
  childId: string,
  idsHere: () => Iterable<string>,
): string {
  const standing = !!manifest && !!info.parent && standingIdsOf(manifest, info.parent.name).has(parentId)
  return taskRefOf({ parentId, id: childId, place: location.slice(location.indexOf(':') + 1), standing, idsHere })
}

function rowLabelOf(ctx: Context, info: KindInfo, r: KindRecord): string {
  return siblingRefOf(ctx.entry.manifest, info, r, ctx.reading?.records ?? [])(String(r.rec.id))
}

// The ref of any task beside `r` (its siblings, itself) in the one form
// (task-ref.ts): what a task's sentence says its blockers by (turn.ts), the
// label rows paint, Needs you's task lines. A record with no parent: by its id.
export function siblingRefOf(
  manifest: Json | null | undefined,
  info: KindInfo,
  r: Pick<KindRecord, 'parent' | 'parentKey'>,
  records: readonly SiloRecord[],
): (id: string) => string {
  if (!r.parent || r.parentKey === undefined || !info.parent) return (id) => id
  const parentId = String(r.parent.id)
  const pk = r.parentKey
  const location = pk.endsWith(`/${parentId}`) ? pk.slice(0, pk.length - parentId.length - 1) : pk
  const top = info.parent.parent ? null : info.parent.name
  const idsHere = (): string[] => records.filter((x) => x.location === location && (top === null || x.kind === top)).map((x) => String(x.record.id))
  return (id) => taskLabelOf(manifest, info, location, parentId, id, idsHere)
}

// { standingList: true } when the parent record is a standing one of its
// kind (manifest.ts standingIdsOf — an ensure-record id), else nothing
export function standingOf(manifest: Json | null | undefined, info: KindInfo, parent: Json): { standingList?: true } {
  if (!manifest || !info.parent) return {}
  return standingIdsOf(manifest, info.parent.name).has(String(parent.id)) ? { standingList: true } : {}
}

function rowFor(
  r: KindRecord,
  info: KindInfo,
  columns: string[],
  folded: boolean,
  ctx: Context,
  remarks: string[],
  extra: { first?: boolean; group?: RecordRow['group'] } = {},
): RecordRow {
  const flow = flowOf(info, r, ctx.voice)
  const turn = info.dict.task
    ? turnOf(r.rec, r.siblings ?? [], info.dict, siblingRefOf(ctx.entry.manifest, info, r, ctx.reading?.records ?? []), {
        now: ctx.voice.now,
        key: r.key,
        ...(r.location !== undefined ? { location: r.location } : {}),
        ...(ctx.voice.isAgent ? { isAgent: ctx.voice.isAgent } : {}),
        ...(ctx.voice.taskEnv ? { taskEnv: ctx.voice.taskEnv } : {}),
        ...(ctx.voice.nameOf ? { nameOf: ctx.voice.nameOf } : {}),
        ...(r.unreadableSiblings ? { unreadableSiblings: r.unreadableSiblings } : {}),
      })
    : null
  return {
    key: r.key,
    id: String(r.rec.id),
    identity: isStr(r.rec.identity) ? r.rec.identity : '',
    state: isStr(r.rec.state) ? r.rec.state : null,
    stateLabel: labelOne(r.rec),
    at: isStr(r.rec.at) && r.rec.at !== '' ? r.rec.at : null,
    anchors: r.anchors,
    cells: columns.map((c) => ({ column: c, text: cell(c, r.rec, info, r.anchors) })),
    row: rowOf(r.rec, info, flow ? { gate: flow.gate, unblocks: flow.unblocks, waitsOn: flow.waitsOn } : undefined, ctx.voice.nameOf, ctx.voice.isAgent),
    folded,
    first: extra.first ?? false,
    ...(extra.group ? { group: extra.group } : {}),
    needsYou: ctx.needsYou?.(r) ?? false,
    overlay: ctx.overlayKeys.has(r.key),
    conflict: ctx.conflictKeys.has(r.key),
    remarks,
    file: r.file,
    ...(r.parent && r.parentKey !== undefined
      ? {
          parent: {
            key: r.parentKey,
            identity: isStr(r.parent.identity) ? r.parent.identity : '',
            at: isStr(r.parent.at) && r.parent.at !== '' ? r.parent.at : null,
            ...standingOf(ctx.entry.manifest, info, r.parent),
          },
        }
      : {}),
    ...(!info.parent && ctx.entry.manifest && standingIdsOf(ctx.entry.manifest, info.name).has(String(r.rec.id)) ? { standingList: true as const } : {}),
    ...(info.dict.task && info.parent && r.parent && r.parentKey !== undefined ? { label: rowLabelOf(ctx, info, r) } : {}),
    ...(flow ? { flow } : {}),
    ...(turn ? { turn } : {}),
    ...(ctx.values ? { value: ctx.notes ? withNoteProvenance(ctx.entry.manifest, info.name, r.key, r.rec, ctx.notes) : r.rec, moved: movedOf(ctx, r) } : {}),
    ...(ctx.verbs && ctx.verbs.length > 0 ? { verbs: ctx.verbs.filter((v) => holds(v.when, info, r, ctx.voice)).map((v) => v.name) } : {}),
  }
}

// Does a needs-you entry of the manifest hold for this record (and not its
// clears)? The same reading the board and the record page make.
function needsYouOf(manifest: Json, info: KindInfo, voice: Voice): (r: KindRecord) => boolean {
  if (needsYouKind(manifest) !== info.name) return () => false
  const surfaces = isObj((manifest.spec as Json).surfaces) ? ((manifest.spec as Json).surfaces as Json) : {}
  const entries = (Array.isArray(surfaces['needs-you']) ? surfaces['needs-you'] : []).filter(isObj)
  const term = terminalsOf(info)
  return (r) => !term.has(String(r.rec.state)) && entries.some((n) => holds(n.when, info, r, voice) && !(isStr(n.clears) && holds(n.clears, info, r, voice)))
}

// The state field the owner may set, with the kind's state values.
function stateEditOf(manifest: Json, info: KindInfo): { field: string; values: string[] } | null {
  const env = isObj(info.spec.envelope) ? info.spec.envelope : {}
  const field = isObj(env.state) && isStr(env.state.field) ? env.state.field : null
  if (!field) return null
  const writable = (Array.isArray((manifest.spec as Json).actions) ? ((manifest.spec as Json).actions as unknown[]) : [])
    .filter(isObj)
    .some(
      (a) => a.verb === 'set-field' && a.kind === info.name && isObj(a.fields) && isObj(a.fields[field]) && (a.fields[field] as Json).writableBy === 'owner',
    )
  return writable ? { field, values: statesOf(info).map((st) => st.value) } : null
}

export function recordsPage(
  entry: SiloEntry,
  reading: SiloReading | null,
  extras: { voice: Voice; overlayKeys: Set<string>; conflictKeys: Set<string>; folderOf?: FolderOf; journal?: TransitionJournal; notes?: NoteProvenance },
  q: RecordsQuery,
): RecordsPage | { error: string } {
  const manifest = entry.manifest
  if (!manifest) return { error: `${entry.id} can't be read: ${entry.status.reason}` }
  const kinds = kindsOf(manifest)
  const top = [...kinds.values()].find((k) => !k.parent)
  const kindName = q.kind ?? top?.name
  const info = kindName ? kinds.get(kindName) : undefined
  if (!info) return { error: `${q.kind} is not a kind of ${entry.id} (${[...kinds.keys()].join(', ')})` }
  const verbs = kernelVerbsOf(manifest, info.name)
  const ctx: Context = {
    entry,
    reading,
    voice: extras.voice,
    overlayKeys: extras.overlayKeys,
    conflictKeys: extras.conflictKeys,
    needsYou: needsYouOf(manifest, info, extras.voice),
    ...(verbs.length > 0 ? { verbs } : {}),
    ...(q.values ? { values: true } : {}),
    ...(extras.journal ? { journal: extras.journal } : {}),
    ...(extras.notes ? { notes: extras.notes } : {}),
  }
  const view = viewOf(manifest, info.name)
  const columns = view && Array.isArray(view.columns) && view.columns.length > 0 ? (view.columns as unknown[]).filter(isStr) : ['identity', 'state', 'at']
  const facetNames = view && Array.isArray(view.facets) ? (view.facets as unknown[]).filter(isStr) : ['state']
  const all = recordsOfKind(kinds, baseOf(reading), info.name)
  const remarksOf = new Map((reading?.records ?? []).map((r) => [`${r.location}/${r.record.id}`, r.remarks]))
  const foldWhen = view && isObj(view.fold) ? view.fold.when : undefined
  const isFolded = (r: KindRecord): boolean => foldWhen !== undefined && holds(foldWhen, info, r, extras.voice)
  const firstWhen = view && isObj(view.first) ? view.first.when : undefined
  const isFirst = (r: KindRecord): boolean => firstWhen !== undefined && holds(firstWhen, info, r, extras.voice)
  const states = statesOf(info)
  const groupField = view && view.archetype === 'list' && isStr(view.groupBy) && view.groupBy !== '' ? view.groupBy : null
  const groupOf = (r: KindRecord): string | null => {
    if (groupField === null) return null
    const v = groupField === 'state' ? (isStr(r.rec.state) ? r.rec.state : null) : facetValue(groupField, r, extras.folderOf)
    return v === null || v === '' ? null : v
  }
  // what a record's group value opens, when it names something (GroupDoor)
  const groupRef = groupField !== null ? (kernelKindFor(manifest, info.name)?.refs?.[groupField] ?? null) : null
  const doorOf = (r: KindRecord, v: string | null): GroupDoor | null => {
    if (v === null) return null
    if (groupField === 'agent') return { hub: 'agent', value: v }
    if (groupField === 'folder' || groupField === 'project') return { hub: 'folder', value: v }
    if (!groupRef) return null
    const folder = r.rec[groupRef.folder]
    const id = r.rec[groupRef.id]
    return isStr(folder) && folder !== '' && isStr(id) && id !== '' ? { hub: groupRef.hub, value: `${folder}/${id}` } : null
  }
  const groupWords = groupField === null ? '' : (labelOfField(info, groupField) ?? plainWords(groupField))
  const groupLabel = (v: string | null): string => {
    if (v === null) return `No ${groupWords}`
    if (groupField === 'state') return states.find((s) => s.value === v)?.one ?? v
    if (groupField === 'agent') return extras.voice.nameOf?.(v) ?? v
    if (groupField === 'project') return v.split('/').filter(Boolean).pop() ?? v
    return v
  }
  // the search: every term in the record's words as the page shows them
  const terms = (q.q ?? '')
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t !== '')
    .slice(0, 12)
  const wordsOf = (r: KindRecord): string =>
    [
      isStr(r.rec.identity) ? r.rec.identity : '',
      ...columns.map((c) => cell(c, r.rec, info, r.anchors)),
      ...(isStr(r.anchors.agent) && extras.voice.nameOf ? [extras.voice.nameOf(r.anchors.agent)] : []),
      ...(groupField !== null ? [groupLabel(groupOf(r))] : []),
    ]
      .join('\n')
      .toLowerCase()

  // facets: counted over the whole set, never over the page
  const facets = facetNames.map((name) => {
    const counts = new Map<string, number>()
    for (const r of all) {
      const v = name === 'state' ? (isStr(r.rec.state) ? r.rec.state : null) : facetValue(name, r, extras.folderOf)
      if (v !== null) counts.set(v, (counts.get(v) ?? 0) + 1)
    }
    return {
      name,
      values: [...counts.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([value, count]) => ({
          value,
          count,
          label:
            name === 'state'
              ? (states.find((s) => s.value === value)?.one ?? value)
              : name === 'project'
                ? (value.split('/').filter(Boolean).pop() ?? value)
                : value,
        })),
    }
  })

  const filtered = all.filter((r) => {
    if (q.state !== undefined && r.rec.state !== q.state) return false
    if (q.id !== undefined && String(r.rec.id) !== q.id) return false
    if (q.file !== undefined && r.file !== q.file) return false
    for (const [f, val] of Object.entries(q.facets ?? {}))
      if ((f === 'state' ? (isStr(r.rec.state) ? r.rec.state : null) : facetValue(f, r, extras.folderOf)) !== val) return false
    const folded = isFolded(r)
    if (q.folded === 'exclude' && folded) return false
    if (q.folded === 'only' && !folded) return false
    if (terms.length > 0) {
      const w = wordsOf(r)
      if (!terms.every((t) => w.includes(t))) return false
    }
    return true
  })
  const t = (r: KindRecord): number => (isStr(r.rec.at) ? Date.parse(r.rec.at) : NaN)
  const newer = (a: number, b: number): number => (Number.isNaN(b) ? (Number.isNaN(a) ? 0 : -1) : Number.isNaN(a) ? 1 : b - a)
  const ranked = q.rank === 'needs-you' ? ctx.needsYou! : (): boolean => false
  const withFold = filtered.map((r) => ({ r, folded: isFolded(r), first: isFirst(r), ranked: ranked(r), at: t(r), group: groupOf(r) }))
  // a group is told apart per side of the fold (folded records regroup in
  // the folded tail): its count, whether it holds a `first` record, its newest
  const gkey = (x: { folded: boolean; group: string | null }): string => `${x.folded ? 1 : 0}\u0000${x.group ?? ''}\u0000${x.group === null ? 1 : 0}`
  // `opens`: undefined until a record says one; null once two disagree
  const groups = new Map<string, { count: number; first: boolean; newest: number; opens: GroupDoor | null | undefined }>()
  if (groupField !== null) {
    for (const x of withFold) {
      const g = groups.get(gkey(x)) ?? { count: 0, first: false, newest: NaN, opens: undefined }
      g.count++
      g.first ||= x.first
      const door = doorOf(x.r, x.group)
      g.opens = g.opens === undefined ? door : g.opens !== null && door !== null && g.opens.hub === door.hub && g.opens.value === door.value ? g.opens : null
      if (!Number.isNaN(x.at) && (Number.isNaN(g.newest) || x.at > g.newest)) g.newest = x.at
      groups.set(gkey(x), g)
    }
  }
  withFold.sort((a, b) => {
    const fold = Number(a.folded) - Number(b.folded)
    if (fold !== 0) return fold
    if (groupField !== null) {
      const ga = groups.get(gkey(a))!,
        gb = groups.get(gkey(b))!
      const byGroup =
        Number(a.group === null) - Number(b.group === null) ||
        Number(gb.first) - Number(ga.first) ||
        newer(ga.newest, gb.newest) ||
        (a.group ?? '').localeCompare(b.group ?? '')
      if (byGroup !== 0) return byGroup
    }
    return Number(b.first) - Number(a.first) || Number(b.ranked) - Number(a.ranked) || newer(a.at, b.at) || a.r.key.localeCompare(b.r.key)
  })
  const limit = Math.max(1, Math.min(RECORDS_PAGE_MAX, Math.floor(q.limit ?? RECORDS_PAGE_DEFAULT)))
  const offset = Math.max(0, Math.floor(q.offset ?? 0))
  const page = withFold.slice(offset, offset + limit)
  const unreadable = reading?.unreadable ?? []
  return {
    silo: { id: entry.id, name: entry.status.manifest.name, state: entry.status.state, freshness: entry.status.freshness?.term ?? null },
    kind: {
      name: `${entry.id}/${info.name}`,
      states,
      columns,
      columnTypes: Object.fromEntries(
        columns.flatMap((c) => {
          const t = childColumn(c)?.agg === 'count' ? 'number' : info.dict.fields[c]?.type
          return t ? [[c, t]] : []
        }),
      ),
      columnLabels: Object.fromEntries(
        columns.flatMap((c) => {
          const l = labelOfField(info, c)
          return l !== null ? [[c, l]] : []
        }),
      ),
      groupBy: groupField !== null ? { field: groupField, label: groupWords } : null,
      facets,
      stateEdit: stateEditOf(manifest, info),
      fold:
        foldWhen !== undefined ? { label: isObj(view?.fold) && isStr(view.fold.label) && view.fold.label.trim() !== '' ? view.fold.label.trim() : null } : null,
      ...(verbs.length > 0 ? { verbs: verbs.map(({ name, says, pending, guard }) => ({ name, says, pending, guard })) } : {}),
      ...((kk) => (kk ? { reads: kk.reads } : {}))(kernelKindFor(manifest, info.name)),
    },
    total: all.length,
    matching: filtered.length,
    offset,
    limit,
    said: page.length < filtered.length ? `showing ${page.length} of ${filtered.length}` : null,
    unreadable: { count: unreadable.length, items: unreadable.slice(0, 20).map((u) => ({ file: u.file || u.rel, rel: u.rel, reason: u.reason })) },
    records: page.map((x) =>
      rowFor(x.r, info, columns, x.folded, ctx, remarksOf.get(x.r.key) ?? [], {
        first: x.first,
        ...(groupField !== null
          ? { group: ((g) => ({ value: x.group, label: groupLabel(x.group), count: g.count, ...(g.opens ? { opens: g.opens } : {}) }))(groups.get(gkey(x))!) }
          : {}),
      }),
    ),
  }
}

export interface RecordDetail {
  silo: { id: string; name: string | null; state: string }
  kind: { name: string; states: StateWord[] }
  record: RecordRow
  version: string | null // sha256 of the file as read — the CAS token for writes
  fields: Array<{ name: string; label?: string; type: string; value: unknown; text: string }>
  extra: Json // fields the file carries that the kind does not declare (preserved)
  // each child with its own envelope; `url`: the first url-typed field it
  // carries (the identity links there); `by`: who wrote it (its updatedBy).
  // `append`: the fields the owner fills to add one (append-item); `move`:
  // the sibling records a child may move to (move-item) — both only when the
  // manifest declares the verb for that sub-kind
  children: Array<{
    kind: string
    collection: string
    rows: Array<{ id: string; identity: string; stateLabel: string; at: string | null; url?: string; by?: string }>
    append?: { fields: Array<{ name: string; required: boolean; max: number | null }> }
    move?: { targets: Array<{ key: string; label: string }> }
  }>
  overlay: Json | null
  needsYou: Array<{ entry: number; urgency: string; clears: string | null; actions: string[] }>
  // a kernel-verb carries its catalog name, the door's word (`says`), its
  // guard field and whether its `when` holds for THIS record now (`applies`)
  actions: Array<{
    verb: string
    fields?: Array<{ name: string; values?: string[]; clearable?: boolean }>
    templates?: string[]
    name?: string
    says?: string
    pending?: string
    guard?: string
    applies?: boolean
  }>
  history: JournalLine[]
  events: unknown[] // the kernel's events about this record (Task 10)
  // the record as the kernel reads it — envelope, declared fields, children
  // (lifted, nested) and computed values: what a page that draws the record
  // its own way reads (plans: the PlanView, web/src/lib/plan-record.ts)
  value: Json
  // read by its path OUTSIDE every location the silo reads (G12): said, never
  // written — no version, no actions
  outside?: true
  // read from plans/closed/ by the key it had while open (plans-closed.ts):
  // outside too, and said as closed — the plan was finished, not misplaced
  closed?: true
  // a sub-kind's record (a plan's task, by <plan key>/tasks/<id>): the record
  // it lives in — its version above is that file's, the one a write names
  parent?: { key: string; kind: string; identity: string; at: string | null; standingList?: true }
  // the kernel's task flow, when the kind declares roles.task
  flow?: TaskFlow
}

// A sibling record in a «move to…» list: its first declared text field the
// list view paints (support: the customer), then its identity.
function siblingLabel(rec: Json, info: KindInfo): string {
  const fields = isObj(info.spec.fields) ? info.spec.fields : {}
  // the fields the identity already says are not said twice
  const env = isObj(info.spec.envelope) ? info.spec.envelope : {}
  const tpl = isObj(env.identity) && isStr(env.identity.template) ? env.identity.template : ''
  const inIdentity = new Set([...tpl.matchAll(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]!))
  const first = Object.entries(fields).find(
    ([n, f]) => isObj(f) && (f.type === 'email' || f.type === 'string') && isStr(rec[n]) && rec[n] !== '' && !inIdentity.has(n),
  )
  const identity = isStr(rec.identity) ? rec.identity : ''
  const parts = [first ? String(rec[first[0]]) : null, identity !== '' ? (identity.length > 40 ? `${identity.slice(0, 39)}…` : identity) : null].filter(
    (x): x is string => x !== null,
  )
  return parts.length > 0 ? parts.join(' · ') : String(rec.id)
}

const ENVELOPE = new Set(['id', 'identity', 'state', 'at', 'updatedBy', 'stateLabel'])

// The CAS version of a record's file (sha256 of its bytes), read through
// safe-file.ts the way the write that checks it will read (actions.ts
// recordBytes): a refused or missing file has no version.
export function fileVersion(sr: Pick<SiloRecord, 'file' | 'rel' | 'location'>): string | null {
  if (!sr.file) return null
  try {
    const place = recordPlace(sr.file, sr.rel, sr.location)
    const r = place === null ? null : readContained(place.dir, place.name, { maxBytes: RECORD_MAX_BYTES })
    return r === null ? null : createHash('sha256').update(r.data).digest('hex')
  } catch {
    return null
  }
}

// The key of the record read from `file` (an absolute path, compared as
// written — the reading's own paths, never a lookup on disk); null when no
// record of this silo is read from it.
export function recordKeyOfFile(reading: SiloReading | null, file: string): string | null {
  const r = (reading?.records ?? []).find((x) => x.file !== '' && x.file === file)
  return r ? `${r.location}/${r.record.id}` : null
}

export function recordDetail(
  entry: SiloEntry,
  reading: SiloReading | null,
  key: string,
  extras: { voice: Voice; journal?: TransitionJournal; events?: (key: string) => unknown[]; notes?: NoteProvenance },
): RecordDetail | null {
  const manifest = entry.manifest
  if (!manifest) return null
  const kinds = kindsOf(manifest)
  const hit = findRecord(kinds, reading, key)
  if (!hit) return null
  const { sr, info, r } = hit
  const sub = info.parent !== undefined
  const fieldsSpec = isObj(info.spec.fields) ? info.spec.fields : {}
  const declared = new Set([...Object.keys(fieldsSpec), ...Object.keys(info.dict.collections), ...Object.keys(info.dict.computed)])
  const raw = sub ? r.rec : isObj(sr.raw) ? sr.raw : {}
  const env = isObj(info.spec.envelope) ? info.spec.envelope : {}
  const envFields = new Set(
    [env.state, env.at, env.updatedBy, env.id]
      .filter(isObj)
      .map((x) => x.field)
      .filter(isStr),
  )
  const conv = entry.status.conventions.find((c) => c.source === sr.source)
  const nyKind = (() => {
    const s = (manifest.spec as Json).surfaces as Json | undefined
    return s && isObj(s.pulse) && isStr(s.pulse.kind) ? s.pulse.kind : [...kinds.values()].find((k) => !k.parent)?.name
  })()
  const term = terminalsOf(info)
  const surfaces = isObj((manifest.spec as Json).surfaces) ? ((manifest.spec as Json).surfaces as Json) : {}
  const needsYou =
    nyKind === info.name && !term.has(String(r.rec.state))
      ? (Array.isArray(surfaces['needs-you']) ? surfaces['needs-you'] : [])
          .filter(isObj)
          .flatMap((n, i) =>
            holds(n.when, info, r, extras.voice) && !(isStr(n.clears) && holds(n.clears, info, r, extras.voice))
              ? [
                  {
                    entry: i,
                    urgency: String(n.urgency),
                    clears: isStr(n.clears) ? n.clears : null,
                    actions: Array.isArray(n.actions) ? (n.actions as unknown[]).filter(isStr) : [],
                  },
                ]
              : [],
          )
      : []
  const allActions = (Array.isArray((manifest.spec as Json).actions) ? ((manifest.spec as Json).actions as unknown[]) : []).filter(isObj)
  const actions = allActions
    .filter((a) => (a.kind === undefined && a.subKind === undefined ? true : sub ? a.subKind === info.name : a.kind === info.name))
    .map((a) => ({
      verb: String(a.verb),
      ...(isObj(a.fields)
        ? {
            fields: Object.entries(a.fields).map(([name, f]) => {
              const isState = name === 'state' || (isObj(env.state) && env.state.field === name)
              return {
                name,
                ...(isState ? { values: statesOf(info).map((s) => s.value) } : {}),
                ...(isObj(f) && f.clearable === true ? { clearable: true } : {}),
              }
            }),
          }
        : {}),
      ...(Array.isArray(a.templates) ? { templates: (a.templates as unknown[]).filter(isStr) } : {}),
      ...((): { name?: string; says?: string; pending?: string; guard?: string; applies?: boolean } => {
        if (a.verb !== 'kernel-verb' || !isStr(a.name)) return {}
        const kv = kernelVerb(a.name)
        return kv ? { name: a.name, says: kv.says, pending: kv.pending, guard: kv.guard, applies: !sub && holds(a.when, info, r, extras.voice) } : {}
      })(),
    }))
  return {
    silo: { id: entry.id, name: entry.status.manifest.name, state: entry.status.state },
    kind: { name: `${entry.id}/${info.name}`, states: statesOf(info) },
    record: rowFor(
      r,
      info,
      ['identity', 'state', 'at'],
      false,
      {
        entry,
        reading,
        voice: extras.voice,
        overlayKeys: new Set(!sub && sr.overlay ? [key] : []),
        conflictKeys: new Set(!sub && Object.values(sr.overlay ?? {}).some((f) => f.conflict) ? [key] : []),
      },
      sub ? [] : sr.remarks,
    ),
    version: fileVersion(sr),
    fields: Object.entries(fieldsSpec).map(([name, f]) => ({
      name,
      ...(isObj(f) && isStr(f.label) && f.label.trim() !== '' ? { label: f.label } : {}),
      type: isObj(f) && isStr(f.type) ? f.type : 'string',
      value: r.rec[name] ?? null,
      text: cell(name, r.rec, info, r.anchors),
    })),
    extra: Object.fromEntries(Object.entries(raw).filter(([k]) => !declared.has(k) && !ENVELOPE.has(k) && !envFields.has(k))),
    // roles.task.releases is the history of which conversations are current
    // (R13) — not content: the header and the feed already say it
    children: Object.entries(info.dict.collections)
      .filter(([coll]) => coll !== info.dict.task?.releases)
      .map(([coll, d]) => {
        const kids = (Array.isArray(r.rec[coll]) ? r.rec[coll] : []) as Json[]
        const child = [...kinds.values()].find((k) => k.parent === info && k.coll === coll)
        const cfields = child && isObj(child.spec.fields) ? child.spec.fields : {}
        const urlField = Object.entries(cfields).find(([, f]) => isObj(f) && f.type === 'url')?.[0] ?? null
        const verbOf = (verb: string): Json | undefined => (child ? allActions.find((a) => a.verb === verb && a.subKind === child.name) : undefined)
        const append = verbOf('append-item')
        const appendByOwner = append && (Array.isArray(append.by) ? append.by.includes('owner') : append.by === 'owner')
        const move = verbOf('move-item')
        return {
          kind: `${entry.id}/${d.kind}`,
          collection: coll,
          rows: kids.filter(isObj).map((k) => ({
            id: String(k.id),
            identity: isStr(k.identity) ? k.identity : '',
            stateLabel: labelOne(k),
            at: isStr(k.at) && k.at !== '' ? k.at : null,
            ...(urlField && isStr(k[urlField]) && /^https?:\/\//i.test(k[urlField] as string) ? { url: k[urlField] as string } : {}),
            ...(isStr(k.updatedBy) && k.updatedBy !== '' ? { by: k.updatedBy } : {}),
          })),
          ...(appendByOwner
            ? {
                append: {
                  fields: Object.entries(cfields)
                    .filter(([, f]) => isObj(f) && (f.type === undefined || f.type === 'string'))
                    .map(([name, f]) => ({ name, required: isObj(f) && f.required === true, max: isObj(f) && typeof f.max === 'number' ? f.max : null })),
                },
              }
            : {}),
          ...(move && move.betweenParents === true
            ? {
                move: {
                  targets: (reading?.records ?? [])
                    .filter((o) => o !== sr && o.kind === sr.kind && o.location === sr.location)
                    .map((o) => ({ key: `${o.location}/${o.record.id}`, label: siblingLabel(o.record, info) })),
                },
              }
            : {}),
        }
      }),
    overlay: !sub && sr.overlay ? (sr.overlay as Json) : null,
    needsYou,
    actions,
    history: conv && extras.journal ? extras.journal.history(conv.dir, key) : [],
    events: extras.events?.(key) ?? [],
    value: extras.notes ? withNoteProvenance(manifest, info.name, key, r.rec, extras.notes) : r.rec,
    ...(sub && r.parent && r.parentKey !== undefined
      ? {
          parent: {
            key: r.parentKey,
            kind: info.parent!.name,
            identity: isStr(r.parent.identity) ? r.parent.identity : '',
            at: isStr(r.parent.at) && r.parent.at !== '' ? r.parent.at : null,
            ...standingOf(entry.manifest, info, r.parent),
          },
        }
      : {}),
    ...((): { flow?: TaskFlow } => {
      const f = flowOf(info, r, extras.voice)
      return f ? { flow: f } : {}
    })(),
  }
}

// The record a key names: a top-level one (<location>/<id>), or a sub-kind's
// (<location>/<id>/<collection>/<child id>, depth ≤ 2) — found through the
// same recordsOfKind every surface reads, so it carries its parent, siblings
// and source. `sr`: the top-level record it lives in (its file, its version).
function findRecord(kinds: Map<string, KindInfo>, reading: SiloReading | null, key: string): { sr: SiloRecord; info: KindInfo; r: KindRecord } | null {
  const records = reading?.records ?? []
  const top = records.find((x) => `${x.location}/${x.record.id}` === key)
  if (top)
    return {
      sr: top,
      info: kinds.get(top.kind)!,
      r: { rec: top.record, anchors: top.anchors as Json, key, location: top.location, file: top.file || null, source: top.source },
    }
  for (const sr of records) {
    const topKey = `${sr.location}/${sr.record.id}`
    if (!key.startsWith(`${topKey}/`)) continue
    const base: KindRecord[] = [{ rec: sr.record, anchors: sr.anchors as Json, key: topKey, location: sr.location, file: sr.file || null, source: sr.source }]
    for (const info of kinds.values()) {
      let root: KindInfo = info
      while (root.parent) root = root.parent
      if (info === root || root.name !== sr.kind) continue
      const r = recordsOfKind(kinds, base, info.name).find((x) => x.key === key)
      if (r) return { sr, info, r }
    }
  }
  return null
}

// A record read OUTSIDE the silo's locations (reader.ts readOutside), said
// like any record but read-only: no version (nothing to write against), no
// actions, no needs-you, no story. `key`: a child of it (a closed plan's
// task, by the key it had while open) — the record's own key otherwise.
export function outsideDetail(
  entry: SiloEntry,
  sr: SiloRecord,
  voice: Voice,
  key = `${sr.location}/${sr.record.id}`,
  notes?: NoteProvenance,
): RecordDetail | null {
  const reading: SiloReading = { records: [sr], unreadable: [], lastWrite: null, sources: {}, truncated: [], problems: [] }
  const d = recordDetail(entry, reading, key, { voice, ...(notes ? { notes } : {}) })
  return d ? { ...d, version: null, actions: [], needsYou: [], children: d.children.map(({ append: _a, move: _m, ...c }) => c), outside: true } : null
}
