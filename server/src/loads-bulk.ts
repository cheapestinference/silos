// loads-bulk.ts — all / nothing, and «Only <agent>» (spec scopes §4, T11).
// Neutral: it reads each engine's inventory (Harness.loads) and its lines,
// asks the engine's own writers, and names no engine.
//
// «Turn all off / on» on a group's head (or the tab's) at ONE place — the
// project, the machine, one agent, one conversation (its column's «Turn all
// off here», keyed by the thread the server resolves) — writes ONE change there: the
// item-level entry of every row of the set that place can switch, through
// the engine's `switchMany` (one file written once, or one payload kept
// once). An account group uses its head key instead (an account row is
// never an item here: its origin's head is), which also covers what the
// account sends later. Before the click the preview counts what it will
// change, by kind, and what it cannot (decided elsewhere: a wider place,
// your organization, no exact name). A plugin's server comes and goes with
// its plugin: it is an item only where its plugin's own line leaves it to
// it (on where the plugin loads, off where the plugin can't be turned off).
//
// After the click the place's undo set is kept (loads-scopes.ts `undo`,
// one per place, replacing the one before): each item's entry before and
// after. «Undo» puts back exactly those entries — while the place still
// reads as the click left it; once it doesn't (another click, a hand edit)
// it is refused and dropped. A single switch needs none: it is its own undo.
//
// «Only <agent>» on an agent's line — «this tool is Builder's alone», the
// two-sided set, per family: an override kind (a plugin) off in the project
// and on for that agent — every other agent of the folder follows the
// project (an «on» of its own goes), so an agent added later won't load it;
// an off-only kind (a server, a connector — off anywhere wins, so it can't
// be turned on for one agent over a project «off») on in the project, off
// for every other agent of the folder, so an agent added later WILL load it.
// An agent that is not the folder's: 404, nothing written.
import {
  LoadsSwitchError,
  type Harness,
  type LoadsBulkSet,
  type LoadsLine,
  type LoadsOrigin,
  type LoadsOriginId,
  type LoadsRow,
  type LoadsSkillBulkItem,
  type LoadsSkillLine,
  type LoadsSwitchAt,
} from './harnesses/contract.js'
import {
  folderInputs,
  folderSkillPlaces,
  launchPlace,
  skillRecordKey,
  skillsInput,
  switchFolderLoad,
  type FolderConversation,
  type FolderLoadsDeps,
} from './folder-loads.js'
import { placeKey, type BulkUndoRecord, type UndoItem } from './loads-scopes.js'
import { originRecordKey } from './switch-proof.js'

/** A bulk click's place. */
export type BulkAt =
  | { scope: 'project' }
  | { scope: 'machine'; confirmed?: boolean }
  | { scope: 'agent'; agent: string }
  | { scope: 'conversation'; conversation: FolderConversation }

/** What a bulk click reaches, said before it and answered after it. */
export interface BulkPreview {
  to: 'on' | 'off'
  scope: BulkAt['scope']
  agent?: string
  /** the rows it changes, by kind — an account head's rows among them
   *  (`skill`: a click on skills, the skills it changes) */
  changes: { plugin: number; mcp: number; connector: number; skill?: number }
  /** the account heads it writes (the group's key instead of its rows) */
  heads: LoadsOriginId[]
  /** the rows of the set it can't change at this place: decided elsewhere */
  cannot: number
  /** a head's sentence the machine says first (its «off» waits for a yes) */
  asks?: string[]
}

/** A place's undo set as the screen shows it, while it still holds. */
export interface BulkUndoView {
  scope: BulkAt['scope']
  agent?: string
  group: string
  to: 'on' | 'off'
  at: number
  counts: Record<string, number>
  /** a click on skills (its head on Skills) */
  kind?: 'skills'
}

const ORIGIN_OF_KIND: Partial<Record<LoadsRow['kind'], LoadsOriginId>> = { plugin: 'plugins', connector: 'connectors' }

/** The line of a row (or a head, or a skill) for a place. */
function lineAt<L extends Pick<LoadsLine, 'place' | 'agent' | 'conversation'>>(at: readonly L[] | undefined, place: BulkAt): L | undefined {
  return at?.find((l) =>
    place.scope === 'agent'
      ? l.place === 'agent' && l.agent === place.agent
      : place.scope === 'conversation'
        ? l.place === 'conversation' && l.conversation === place.conversation.thread
        : l.place === place.scope,
  )
}

/** An account row's head: its origin's, where the engine has one. */
function headOf(r: LoadsRow, origins: readonly LoadsOrigin[]): LoadsOriginId | null {
  if (r.origin.owner !== 'account' || r.parent) return null
  const id = ORIGIN_OF_KIND[r.kind]
  return id && origins.some((o) => o.id === id) ? id : null
}

/** Whether a line takes the click at its place. */
function canTake(r: Pick<LoadsRow, 'family'>, l: LoadsLine, to: 'on' | 'off', place: BulkAt): boolean {
  if (l.door || l.place === 'fact' || !l.switch || l.locked || l.refused) return false
  // an off-only thing is turned on for one agent (or conversation) only by removing its own «off»
  if ((place.scope === 'agent' || place.scope === 'conversation') && r.family === 'off-only' && to === 'on' && l.entry !== 'off') return false
  return true
}

interface Plan {
  h: Harness
  set: LoadsBulkSet
  preview: BulkPreview
  before: { rows: Record<string, 'on' | 'off' | undefined>; origins: Record<string, 'on' | 'off' | undefined> }
}

/** What the click would do in the engine that lists most of the set. */
function planOf(
  deps: FolderLoadsDeps,
  folder: string,
  want: { keys: readonly string[]; origins: readonly LoadsOriginId[] },
  to: 'on' | 'off',
  place: BulkAt,
): Plan | null {
  const { engines, inputOf } = folderInputs(deps, folder, undefined, undefined, convOf(place))
  const keys = new Set(want.keys)
  let best: Plan | null = null
  let bestHits = 0
  for (const h of engines) {
    const input = inputOf(h)
    const inv = h.loads!.inventory(input)
    const origins = inv.origins ?? []
    const rows = inv.rows.filter((r) => keys.has(r.key))
    const hits = rows.length + want.origins.filter((o) => origins.some((x) => x.id === o)).length
    if (hits === 0 || hits <= bestHits) continue
    if (place.scope === 'agent' && !(input.carried?.agents ?? []).some((a) => a.id === place.agent)) {
      throw new LoadsSwitchError(`"${place.agent}" is not an agent of this project`, 404)
    }
    const byKey = new Map(inv.rows.map((r) => [r.key, r]))
    const preview: BulkPreview = {
      to,
      scope: place.scope,
      ...(place.scope === 'agent' ? { agent: place.agent } : {}),
      changes: { plugin: 0, mcp: 0, connector: 0 },
      heads: [],
      cannot: 0,
    }
    const set: LoadsBulkSet = { keys: [], origins: [] }
    const before: Plan['before'] = { rows: {}, origins: {} }
    // the account rows of the set go by their head
    const heads = new Set<LoadsOriginId>(want.origins.filter((o) => origins.some((x) => x.id === o)))
    for (const r of rows) {
      const id = headOf(r, origins)
      if (id) heads.add(id)
    }
    const resultOf = (r: LoadsRow): 'on' | 'off' => lineAt(r.at, place)?.result ?? (r.state === 'active' ? 'on' : 'off')
    // an account plugin's server comes and goes with its plugin, and its plugin with the head
    const items = rows.filter((r) => headOf(r, origins) === null && !(r.parent && byKey.get(r.parent) && headOf(byKey.get(r.parent)!, origins) !== null))
    // where a plugin ends at the place after the click: its servers are
    // items only where it ends on (off, they go with it)
    const ends = (key: string): 'on' | 'off' => {
      const p = byKey.get(key)
      if (!p) return 'on'
      const l = lineAt(p.at, place)
      const now = resultOf(p)
      return now !== to && keys.has(p.key) && l !== undefined && canTake(p, l, to, place) ? to : now
    }
    for (const r of items) {
      const l = lineAt(r.at, place)
      if (resultOf(r) === to) continue
      if (r.parent && ends(r.parent) === 'off') continue
      if (!l || !canTake(r, l, to, place)) {
        preview.cannot++
        continue
      }
      set.keys.push(r.key)
      before.rows[r.key] = l.entry
      preview.changes[r.kind]++
    }
    for (const id of [...heads].sort()) {
      const o = origins.find((x) => x.id === id)!
      const l = lineAt(o.at, place)
      // what the head reaches now: the origin's rows that would change
      const reached = inv.rows.filter(
        (r) =>
          headOf(r, origins) === id &&
          (lineAt(r.at, place)?.result ?? (r.state === 'active' ? 'on' : 'off')) !== to &&
          !(to === 'on' && lineAt(r.at, place)?.entry === 'off'),
      )
      if (!l) {
        preview.cannot += reached.length
        continue
      }
      if (l.result === to) continue
      if (!canTake({ family: 'off-only' }, l, to, place)) {
        preview.cannot += reached.length
        continue
      }
      set.origins.push(id)
      preview.heads.push(id)
      before.origins[id] = l.entry
      for (const r of reached) preview.changes[r.kind]++
      if (place.scope === 'machine' && to === 'off' && l.asks) (preview.asks ??= []).push(l.asks)
    }
    best = { h, set, preview, before }
    bestHits = hits
  }
  return best
}

const convOf = (place: BulkAt): FolderConversation | undefined => (place.scope === 'conversation' ? place.conversation : undefined)

const atOf = (place: BulkAt, payload?: unknown, agent?: string | null): LoadsSwitchAt =>
  place.scope === 'agent'
    ? { scope: 'agent', agent: place.agent, payload: payload ?? null }
    : place.scope === 'conversation'
      ? { scope: 'conversation', ...(agent ? { agent } : {}), payload: payload ?? null }
      : place.scope === 'machine'
        ? { scope: 'machine', ...(place.confirmed ? { confirmed: true as const } : {}) }
        : { scope: 'project' }

const keyOf = (folder: string, place: BulkAt): string =>
  place.scope === 'project'
    ? placeKey({ scope: 'project', folder })
    : place.scope === 'machine'
      ? placeKey({ scope: 'machine' })
      : place.scope === 'agent'
        ? placeKey({ scope: 'agent', agent: place.agent })
        : placeKey({ scope: 'conversation', thread: place.conversation.thread })

/** The engine's one bulk write at the place, and what Silos keeps of it. */
function write(deps: FolderLoadsDeps, folder: string, h: Harness, set: LoadsBulkSet, to: 'on' | 'off', place: BulkAt): void {
  if (!h.loads!.switchMany) throw new LoadsSwitchError(`${h.label} can't switch a whole group at once from Silos — switch each row`, 409)
  const input = folderInputs(deps, folder, undefined, h.id, convOf(place)).inputOf(h)
  const projectLaunch = place.scope === 'project' && launchPlace(h, 'project')
  if (place.scope === 'conversation') {
    if (!deps.loadsScopes?.recordMany) throw new LoadsSwitchError('nothing keeps what one conversation loads here', 409)
    if (!launchPlace(h, 'conversation')) throw new LoadsSwitchError(`${h.label} has no place for one conversation`, 409)
    const c = input.carried?.conversation
    if (!c) throw new LoadsSwitchError('no conversation here to switch for', 404)
    const answer = h.loads!.switchMany(input, set, to, atOf(place, c.payload, c.agent))
    if (answer)
      deps.loadsScopes.recordMany('conversations', c.id, h.id, answer, [
        ...answer.rows,
        ...answer.origins.map((o) => ({ key: originRecordKey(o.id), held: o.held })),
      ])
    return
  }
  if (place.scope === 'agent' || projectLaunch) {
    if (!deps.loadsScopes?.recordMany) throw new LoadsSwitchError('nothing keeps what one agent loads here', 409)
    if (place.scope === 'agent' && !launchPlace(h, 'agent')) throw new LoadsSwitchError(`${h.label} has no place for one agent`, 409)
    const payload =
      place.scope === 'agent' ? (input.carried?.agents.find((a) => a.id === place.agent)?.payload ?? null) : (input.carried?.folder?.payload ?? null)
    const answer = h.loads!.switchMany(input, set, to, place.scope === 'agent' ? atOf(place, payload) : { scope: 'project', payload })
    if (!answer) return
    const items = [...answer.rows, ...answer.origins.map((o) => ({ key: originRecordKey(o.id), held: o.held }))]
    if (place.scope === 'agent') deps.loadsScopes.recordMany('agents', place.agent, h.id, answer, items)
    else deps.loadsScopes.recordMany('folders', folder, h.id, answer, items)
    return
  }
  const machine = place.scope === 'machine'
  if (machine && !(h.loads!.scopes ?? []).some((s) => s.id === 'machine' && s.carrier === 'file'))
    throw new LoadsSwitchError(`${h.label} has no place "machine"`, 409)
  const changedAt = (): number | null => (machine ? h.loads!.machineChangedAt?.(deps.home) : h.loads!.switchesChangedAt?.(folder)) ?? null
  let before: number | null = null
  try {
    before = changedAt()
  } catch {
    before = null
  }
  h.loads!.switchMany(input, set, to, atOf(place))
  // each item's own switch time, as a single switch keeps it (switch-proof.ts)
  try {
    const after = changedAt()
    if (after !== null && after !== before) {
      for (const k of set.keys) deps.toolHealth?.noteSwitch?.(folder, k, to, after, undefined, machine ? 'machine' : 'project')
      if (!machine) for (const o of set.origins) deps.toolHealth?.noteSwitch?.(folder, originRecordKey(o), to, after)
    }
  } catch (err) {
    console.warn('tool-health: a bulk switch was not recorded:', err instanceof Error ? err.message : String(err))
  }
}

/** The entries now, at the place, of the items an undo set names. */
function entriesNow(
  deps: FolderLoadsDeps,
  folder: string,
  h: Harness,
  place: BulkAt,
): { rows: Map<string, LoadsLine | undefined>; origins: Map<string, LoadsLine | undefined> } {
  const inv = h.loads!.inventory(folderInputs(deps, folder, undefined, h.id, convOf(place)).inputOf(h))
  return {
    rows: new Map(inv.rows.map((r) => [r.key, lineAt(r.at, place)])),
    origins: new Map((inv.origins ?? []).map((o) => [o.id, lineAt(o.at, place)])),
  }
}

/** «Turn all off / on» at one place: the preview (`apply` false), or the
 *  click — one write — and its undo set kept. 404 an agent that is not the
 *  folder's; 409 the engine's own refusal (nothing written). */
export function bulkFolderLoads(
  deps: FolderLoadsDeps,
  folder: string,
  want: { keys: readonly string[]; origins: readonly LoadsOriginId[]; skills?: readonly SkillWant[] },
  to: 'on' | 'off',
  place: BulkAt,
  opts: { group: string; apply: boolean; now?: number },
): BulkPreview {
  if ((want.skills?.length ?? 0) > 0 || want.origins.includes('skills')) {
    if (want.keys.length > 0 || want.origins.some((o) => o !== 'skills')) throw new LoadsSwitchError('a click is on tools or on skills, not both', 409)
    return bulkFolderSkills(deps, folder, { skills: want.skills ?? [], head: want.origins.includes('skills') }, to, place, opts)
  }
  const plan = planOf(deps, folder, want, to, place)
  if (!plan)
    return {
      to,
      scope: place.scope,
      ...(place.scope === 'agent' ? { agent: place.agent } : {}),
      changes: { plugin: 0, mcp: 0, connector: 0 },
      heads: [],
      cannot: 0,
    }
  const { h, set, preview, before } = plan
  if (!opts.apply || (set.keys.length === 0 && set.origins.length === 0)) return preview
  write(deps, folder, h, set, to, place)
  // the undo set: each item's entry before and after, at this place
  if (deps.loadsScopes?.setUndo) {
    const now = entriesNow(deps, folder, h, place)
    const rows: Record<string, UndoItem> = {}
    const origins: Record<string, UndoItem> = {}
    const item = (b: 'on' | 'off' | undefined, a: 'on' | 'off' | undefined): UndoItem => ({ ...(b ? { before: b } : {}), ...(a ? { after: a } : {}) })
    for (const k of set.keys)
      Object.defineProperty(rows, k, { value: item(before.rows[k], now.rows.get(k)?.entry), enumerable: true, writable: true, configurable: true })
    for (const o of set.origins) origins[o] = item(before.origins[o], now.origins.get(o)?.entry)
    const rec: BulkUndoRecord = {
      engine: h.id,
      folder,
      group: opts.group,
      to,
      at: opts.now ?? Date.now(),
      rows,
      origins,
      counts: { ...preview.changes, ...(preview.heads.length > 0 ? { heads: preview.heads.length } : {}) },
    }
    deps.loadsScopes.setUndo(keyOf(folder, place), rec)
  }
  return preview
}

/** Whether the place still reads as the click left it. */
function holds(rec: BulkUndoRecord, now: ReturnType<typeof entriesNow>): boolean {
  for (const [k, it] of Object.entries(rec.rows)) {
    const l = now.rows.get(k)
    if (!l || l.entry !== it.after) return false
  }
  for (const [k, it] of Object.entries(rec.origins)) {
    const l = now.origins.get(k)
    if (!l || l.entry !== it.after) return false
  }
  return true
}

/** «Undo» on the head a bulk click was made on: exactly its entries back,
 *  in one write — 404 nothing to undo there; 409 the place no longer reads
 *  as the click left it (the set is dropped). Used: dropped. */
export function undoFolderBulk(deps: FolderLoadsDeps, folder: string, place: BulkAt, group: string): void {
  const store = deps.loadsScopes
  const key = keyOf(folder, place)
  const rec = store?.undoAt?.(key) ?? null
  if (!store?.setUndo || !rec || rec.folder !== folder || rec.group !== group) throw new LoadsSwitchError('nothing to undo here', 404)
  if (rec.kind === 'skills') {
    undoSkillBulk(deps, folder, place, key, rec)
    return
  }
  const { engines } = folderInputs(deps, folder, undefined, undefined, convOf(place))
  const h = engines.find((e) => e.id === rec.engine)
  if (!h) {
    store.setUndo(key, null)
    throw new LoadsSwitchError('nothing to undo here — its engine no longer reads this project', 409)
  }
  if (!holds(rec, entriesNow(deps, folder, h, place))) {
    store.setUndo(key, null)
    throw new LoadsSwitchError('changed since that click — nothing was undone', 409)
  }
  const back = rec.to === 'on' ? 'off' : 'on'
  write(deps, folder, h, { keys: Object.keys(rec.rows), origins: Object.keys(rec.origins) as LoadsOriginId[] }, back, place)
  store.setUndo(key, null)
}

/** The undo sets that still hold for a folder's page: its project's, the
 *  machine's when clicked here, and each agent's of `agents` clicked here.
 *  One that no longer holds is dropped. */
export function undoViews(deps: FolderLoadsDeps, folder: string, agents: readonly string[], conversation?: FolderConversation): BulkUndoView[] {
  const store = deps.loadsScopes
  if (!store?.undoAt || !store.setUndo) return []
  // a conversation's column: only its own place's set
  const places: BulkAt[] = conversation
    ? [{ scope: 'conversation', conversation }]
    : [{ scope: 'project' }, { scope: 'machine' }, ...agents.map((agent) => ({ scope: 'agent' as const, agent }))]
  const out: BulkUndoView[] = []
  let engines: Harness[] | null = null
  for (const place of places) {
    const key = keyOf(folder, place)
    const rec = store.undoAt(key)
    if (!rec || rec.folder !== folder) continue
    engines ??= folderInputs(deps, folder, undefined, undefined, conversation).engines
    const h = engines.find((e) => e.id === rec.engine)
    let ok = false
    try {
      ok = h !== undefined && (rec.kind === 'skills' ? skillsHold(deps, folder, h, place, rec) : holds(rec, entriesNow(deps, folder, h, place)))
    } catch {
      ok = false
    }
    if (!ok) {
      store.setUndo(key, null)
      continue
    }
    out.push({
      scope: place.scope,
      ...(place.scope === 'agent' ? { agent: place.agent } : {}),
      group: rec.group,
      to: rec.to,
      at: rec.at,
      counts: { ...rec.counts },
      ...(rec.kind ? { kind: rec.kind } : {}),
    })
  }
  return out
}

// ---- all / nothing on skills (spec scopes §4, T15)
//
// «Turn all off / on» on a head of Skills at ONE place: every skill of the
// group that place can switch gets its entry (`skillOverrides`, through the
// engine's `skillSwitchMany` — one file written once, or one payload kept
// once). «off» writes «off»; «on» removes the place's own entry, or writes
// «on» only where it must override a wider «off» (each as its own switch
// would). A folder's own copy has no machine line (it exists in one
// project): the machine's click never reaches it; its project place is
// Silos' held store — moved out, or back. The Claude account's skills go by
// their head (`skills`, the tools' head path), which also covers what the
// account sends later. A skill the engine locks (a plugin's, a name
// settings can't store), one a wider place or your organization decides:
// counted as decided elsewhere, never touched. Undo: the same one set per
// place (`kind: 'skills'`), each entry put back exactly as it was — any
// position, a value found by hand too.

/** A skill a click on Skills names: its name and where this copy comes from
 *  (a plugin's is never written: its lines are locked — counted, untouched). */
export interface SkillWant {
  name: string
  from: 'account' | 'personal' | 'project' | 'plugin'
}

const skillKeyOf = (w: SkillWant): string => `${w.from}:${w.name}`
const STORE = 'store:'
const loadsAt = (result: string): boolean => result !== 'off'

/** The engine that reads and switches the folder's skills at its places. */
function skillEngine(deps: FolderLoadsDeps, folder: string, place: BulkAt): Harness | null {
  return folderInputs(deps, folder, undefined, undefined, convOf(place)).engines.find((h) => h.loads?.skillPlaces && h.loads.skillSwitchMany) ?? null
}

/** Each wanted skill's lines now (a folder copy out in the store, as such). */
function skillLinesNow(deps: FolderLoadsDeps, folder: string, h: Harness, wants: readonly SkillWant[], place: BulkAt): Map<string, LoadsSkillLine[]> {
  const held = new Set(deps.skillStore?.held(folder) ?? [])
  const asks = wants.map((w) => ({ name: w.name, from: w.from, ...(w.from === 'project' && held.has(w.name) ? { held: true as const } : {}) }))
  const out = new Map<string, LoadsSkillLine[]>()
  for (const p of folderSkillPlaces(deps, folder, h.id, asks, convOf(place)) ?? []) {
    out.set(skillKeyOf({ name: p.name, from: p.from }), p.lines)
  }
  return out
}

interface SkillPlan {
  h: Harness
  entries: Extract<LoadsSkillBulkItem, { to: string }>[]
  store: string[]
  before: Record<string, string | undefined>
  head: Plan | null
  preview: BulkPreview
}

function planSkills(
  deps: FolderLoadsDeps,
  folder: string,
  want: { skills: readonly SkillWant[]; head: boolean },
  to: 'on' | 'off',
  place: BulkAt,
): SkillPlan | null {
  const h = skillEngine(deps, folder, place)
  if (!h) return null
  if (place.scope === 'agent' && !(skillsInput(deps, folder, h.id).carried?.agents ?? []).some((a) => a.id === place.agent)) {
    throw new LoadsSwitchError(`"${place.agent}" is not an agent of this project`, 404)
  }
  const preview: BulkPreview = {
    to,
    scope: place.scope,
    ...(place.scope === 'agent' ? { agent: place.agent } : {}),
    changes: { plugin: 0, mcp: 0, connector: 0, skill: 0 },
    heads: [],
    cannot: 0,
  }
  const lines = skillLinesNow(deps, folder, h, want.skills, place)
  const plan: SkillPlan = { h, entries: [], store: [], before: {}, head: null, preview }
  const seen = new Set<string>()
  let skills = 0
  let reached = 0
  for (const w of want.skills) {
    const k = skillKeyOf(w)
    if (seen.has(k)) continue
    seen.add(k)
    const l = lineAt(lines.get(k), place)
    // a folder copy has no machine line: the machine's click never reaches it
    if (!l) {
      if (!(place.scope === 'machine' && w.from === 'project')) preview.cannot++
      continue
    }
    if (loadsAt(l.result) === (to === 'on')) continue
    // the account's skills go by their head (also what it sends later)
    if (w.from === 'account' && want.head) {
      if (!(to === 'on' && l.entry === 'off')) reached++
      continue
    }
    if (w.from === 'plugin' || l.locked || l.refused || l.door || l.place === 'fact' || !l.positions?.includes(to)) {
      preview.cannot++
      continue
    }
    skills++
    if (l.store) {
      plan.store.push(w.name)
      plan.before[STORE + w.name] = to === 'off' ? undefined : 'off'
      continue
    }
    plan.entries.push({ name: w.name, from: w.from, to })
    plan.before[k] = l.entry
  }
  if (want.head) {
    const hp = planOf(deps, folder, { keys: [], origins: ['skills'] }, to, place)
    if (hp && hp.set.origins.includes('skills')) {
      plan.head = hp
      preview.heads = ['skills']
      skills += reached
      if (hp.preview.asks) preview.asks = hp.preview.asks
    } else preview.cannot += reached
  }
  preview.changes.skill = skills
  return plan
}

/** The engine's one bulk write of skill entries at the place, and what
 *  Silos keeps of a launch place's. */
function writeSkills(deps: FolderLoadsDeps, folder: string, h: Harness, items: LoadsSkillBulkItem[], place: BulkAt): void {
  if (items.length === 0) return
  const input = skillsInput(deps, folder, h.id, convOf(place))
  if (place.scope === 'conversation' || place.scope === 'agent') {
    if (!deps.loadsScopes?.recordMany) throw new LoadsSwitchError(`nothing keeps what one ${place.scope} loads here`, 409)
    if (!launchPlace(h, place.scope)) throw new LoadsSwitchError(`${h.label} has no place for one ${place.scope}`, 409)
    const c = place.scope === 'conversation' ? input.carried?.conversation : undefined
    if (place.scope === 'conversation' && !c) throw new LoadsSwitchError('no conversation here to switch for', 404)
    const at: LoadsSwitchAt = c
      ? { scope: 'conversation', ...(c.agent ? { agent: c.agent } : {}), payload: c.payload ?? null }
      : {
          scope: 'agent',
          agent: (place as { agent: string }).agent,
          payload: input.carried?.agents.find((a) => a.id === (place as { agent: string }).agent)?.payload ?? null,
        }
    const answer = h.loads!.skillSwitchMany!(input, items, at)
    if (!answer) return
    const kept = answer.rows.map((r) => ({ key: skillRecordKey(r.key), held: r.held }))
    if (c) deps.loadsScopes.recordMany('conversations', c.id, h.id, answer, kept)
    else deps.loadsScopes.recordMany('agents', (place as { agent: string }).agent, h.id, answer, kept)
    return
  }
  if (place.scope === 'machine') h.loads!.skillSwitchMany!(input, items, { scope: 'machine' })
  else h.loads!.skillSwitchMany!(input, items)
}

/** Folder copies out to Silos' held store, or back. */
function moveCopies(deps: FolderLoadsDeps, folder: string, names: readonly string[], to: 'on' | 'off'): void {
  if (names.length === 0) return
  const store = deps.skillStore
  if (!store) throw new LoadsSwitchError('this project’s own skills are moved by Silos’ held store — not here', 409)
  for (const n of names) {
    if (to === 'off') store.hold(folder, n)
    else store.activate(folder, n)
  }
}

/** «Turn all off / on» on a head of Skills at one place: the preview
 *  (`apply` false), or the click and its undo set kept. */
function bulkFolderSkills(
  deps: FolderLoadsDeps,
  folder: string,
  want: { skills: readonly SkillWant[]; head: boolean },
  to: 'on' | 'off',
  place: BulkAt,
  opts: { group: string; apply: boolean; now?: number },
): BulkPreview {
  const plan = planSkills(deps, folder, want, to, place)
  if (!plan)
    return {
      to,
      scope: place.scope,
      ...(place.scope === 'agent' ? { agent: place.agent } : {}),
      changes: { plugin: 0, mcp: 0, connector: 0, skill: 0 },
      heads: [],
      cannot: 0,
    }
  const { h, preview } = plan
  if (!opts.apply || (plan.entries.length === 0 && plan.store.length === 0 && !plan.head)) return preview
  // the machine head's «off» waits for its yes — before anything is written
  if (plan.head && place.scope === 'machine' && to === 'off' && preview.asks?.length && !place.confirmed) throw new LoadsSwitchError(preview.asks[0]!, 409)
  writeSkills(deps, folder, h, plan.entries, place)
  moveCopies(deps, folder, plan.store, to)
  if (plan.head) write(deps, folder, plan.head.h, plan.head.set, to, place)
  if (deps.loadsScopes?.setUndo) {
    const wants: SkillWant[] = plan.entries.map((e) => ({ name: e.name, from: e.from }))
    const now = skillLinesNow(deps, folder, h, wants, place)
    const held = new Set(deps.skillStore?.held(folder) ?? [])
    const rows: Record<string, UndoItem> = {}
    const item = (b: string | undefined, a: string | undefined): UndoItem => ({
      ...(b !== undefined ? { before: b } : {}),
      ...(a !== undefined ? { after: a } : {}),
    })
    // a name is data: an own property, never through a prototype setter
    const keep = (k: string, v: UndoItem): void => {
      Object.defineProperty(rows, k, { value: v, enumerable: true, writable: true, configurable: true })
    }
    for (const w of wants) keep(skillKeyOf(w), item(plan.before[skillKeyOf(w)], lineAt(now.get(skillKeyOf(w)), place)?.entry))
    for (const n of plan.store) keep(STORE + n, item(plan.before[STORE + n], held.has(n) ? 'off' : undefined))
    const origins: Record<string, UndoItem> = {}
    if (plan.head) origins.skills = item(plan.head.before.origins.skills, entriesNow(deps, folder, plan.head.h, place).origins.get('skills')?.entry)
    deps.loadsScopes.setUndo(keyOf(folder, place), {
      engine: h.id,
      folder,
      group: opts.group,
      to,
      at: opts.now ?? Date.now(),
      rows,
      origins,
      kind: 'skills',
      counts: { skill: preview.changes.skill ?? 0, ...(plan.head ? { heads: 1 } : {}) },
    })
  }
  return preview
}

/** a skill a click writes (never a plugin's) */
type WrittenSkill = SkillWant & { from: 'account' | 'personal' | 'project' }
/** The skills a skills undo set names (the folder copies' store keys aside). */
const wantsOf = (rec: BulkUndoRecord): WrittenSkill[] =>
  Object.keys(rec.rows)
    .filter((k) => !k.startsWith(STORE))
    .map((k) => {
      const i = k.indexOf(':')
      return { from: k.slice(0, i) as WrittenSkill['from'], name: k.slice(i + 1) }
    })

/** The engine that holds the account skills' head for the folder. */
function headEngine(deps: FolderLoadsDeps, folder: string, place: BulkAt): Harness | undefined {
  const { engines, inputOf } = folderInputs(deps, folder, undefined, undefined, convOf(place))
  return engines.find((e) => (e.loads!.inventory(inputOf(e)).origins ?? []).some((o) => o.id === 'skills'))
}

/** Whether the place still reads as a skills click left it. */
function skillsHold(deps: FolderLoadsDeps, folder: string, h: Harness, place: BulkAt, rec: BulkUndoRecord): boolean {
  const wants = wantsOf(rec)
  const now = skillLinesNow(deps, folder, h, wants, place)
  for (const w of wants) {
    const l = lineAt(now.get(skillKeyOf(w)), place)
    if (!l || l.entry !== rec.rows[skillKeyOf(w)]!.after) return false
  }
  const held = new Set(deps.skillStore?.held(folder) ?? [])
  for (const [k, it] of Object.entries(rec.rows)) if (k.startsWith(STORE) && (held.has(k.slice(STORE.length)) ? 'off' : undefined) !== it.after) return false
  if (rec.origins.skills) {
    const hh = headEngine(deps, folder, place)
    if (!hh || entriesNow(deps, folder, hh, place).origins.get('skills')?.entry !== rec.origins.skills.after) return false
  }
  return true
}

/** «Undo» of a skills click: each entry exactly back in one write, each
 *  copy moved back, the head back — while the place still reads as the
 *  click left it (409 otherwise, the set dropped). */
function undoSkillBulk(deps: FolderLoadsDeps, folder: string, place: BulkAt, key: string, rec: BulkUndoRecord): void {
  const store = deps.loadsScopes!
  const h = skillEngine(deps, folder, place)
  if (!h || h.id !== rec.engine) {
    store.setUndo!(key, null)
    throw new LoadsSwitchError('nothing to undo here — its engine no longer reads this project', 409)
  }
  if (!skillsHold(deps, folder, h, place, rec)) {
    store.setUndo!(key, null)
    throw new LoadsSwitchError('changed since that click — nothing was undone', 409)
  }
  writeSkills(
    deps,
    folder,
    h,
    wantsOf(rec).map((w) => ({ ...w, entry: rec.rows[skillKeyOf(w)]!.before ?? null })),
    place,
  )
  const back = rec.to === 'on' ? 'off' : 'on'
  moveCopies(
    deps,
    folder,
    Object.keys(rec.rows)
      .filter((k) => k.startsWith(STORE))
      .map((k) => k.slice(STORE.length)),
    back,
  )
  if (rec.origins.skills) {
    const hh = headEngine(deps, folder, place)
    // putting back what was there: the owner's own click, said by Undo
    if (hh) write(deps, folder, hh, { keys: [], origins: ['skills'] }, back, place.scope === 'machine' ? { scope: 'machine', confirmed: true } : place)
  }
  store.setUndo!(key, null)
}

/** «Only <agent>» — what the two-sided set writes, said before it. */
export interface OnlyAgentPlan {
  family: 'override' | 'off-only'
  agent: string
  /** the project's line: where it goes (null: it is there already) */
  project: 'on' | 'off' | null
  /** each agent of the folder the click writes, and to what */
  agents: { id: string; to: 'on' | 'off' }[]
  /** the other agents of the folder, by name — whom the set reaches */
  others: string[]
}

/** «Only <agent>» on a row's agent line: the plan (`apply` false), or the
 *  set written — the project's line first, then each agent's. 404 a row or
 *  an agent that is not the folder's; 409 a line the set can't move
 *  (nothing written). */
export function onlyAgentLoad(deps: FolderLoadsDeps, folder: string, key: string, agent: string, opts: { apply: boolean }): OnlyAgentPlan {
  const { engines, inputOf } = folderInputs(deps, folder)
  const names = new Map(deps.registry.list(true).map((a) => [a.id, a.name]))
  for (const h of engines) {
    const input = inputOf(h)
    const row = h.loads!.inventory(input).rows.find((r) => r.key === key)
    if (!row) continue
    const agents = (input.carried?.agents ?? []).map((a) => a.id)
    if (!agents.includes(agent)) throw new LoadsSwitchError(`"${agent}" is not an agent of this project`, 404)
    if (!row.at || !row.family) throw new LoadsSwitchError(`"${row.label}" has no places — it switches for this project only`, 409)
    if (!launchPlace(h, 'agent')) throw new LoadsSwitchError(`${h.label} has no place for one agent`, 409)
    const who = names.get(agent) ?? agent
    const project = row.at.find((l) => l.place === 'project')
    const mine = row.at.find((l) => l.place === 'agent' && l.agent === agent)
    if (!project || !mine) throw new LoadsSwitchError(`"${row.label}" has no line for ${who} here`, 409)
    const others = agents.filter((a) => a !== agent)
    const lineOf = (id: string): LoadsLine | undefined => row.at!.find((l) => l.place === 'agent' && l.agent === id)
    // a line the set's project write frees is not locked for it
    const freed = (l: LoadsLine | undefined): boolean => !!l && (!l.locked || (l.locked.why === 'wider' && l.locked.at === 'project'))
    const refuse = (why: string): never => {
      throw new LoadsSwitchError(`"${row.label}" can't be ${who}'s alone — ${why}`, 409)
    }
    const plan: OnlyAgentPlan = { family: row.family, agent, project: null, agents: [], others: others.map((a) => names.get(a) ?? a) }
    if (row.family === 'override') {
      // off in the project, on for this agent; the others follow the project
      if (project.result !== 'off') {
        if (!project.switch || project.locked)
          refuse(project.locked?.why === 'organization' ? 'your organization decides it' : 'the project’s line has no switch')
        plan.project = 'off'
      }
      if (!mine.switch && mine.result !== 'on') refuse(`${who}'s line has no switch`)
      if (mine.locked?.why === 'organization') refuse('your organization decides it')
      plan.agents.push({ id: agent, to: 'on' })
      for (const id of others) if (lineOf(id)?.entry === 'on') plan.agents.push({ id, to: 'off' })
    } else {
      // on in the project (off anywhere wins), off for every other agent
      if (project.result !== 'on') {
        if (project.locked || !project.switch)
          refuse(
            project.locked?.at === 'machine'
              ? 'it is off for this whole machine; turn it on for this machine first'
              : project.locked?.why === 'organization'
                ? 'your organization decides it'
                : 'the project’s line has no switch',
          )
        plan.project = 'on'
      }
      if (mine.entry === 'off') plan.agents.push({ id: agent, to: 'on' })
      else if (!freed(mine)) refuse(`${who}'s line is decided elsewhere`)
      for (const id of others) {
        const l = lineOf(id)
        if (l?.entry === 'off') continue
        if (!freed(l) || (!l!.switch && !l!.locked)) refuse(`${names.get(id) ?? id}'s line has no switch`)
        plan.agents.push({ id, to: 'off' })
      }
    }
    if (!opts.apply) return plan
    if (plan.project) switchFolderLoad(deps, folder, key, plan.project, { scope: 'project' })
    try {
      for (const a of plan.agents) switchFolderLoad(deps, folder, key, a.to, { scope: 'agent', agent: a.id })
    } catch (err) {
      // the set is whole or not at all: the project's line goes back
      if (plan.project) {
        try {
          switchFolderLoad(deps, folder, key, plan.project === 'on' ? 'off' : 'on', { scope: 'project' })
        } catch {
          /* said below */
        }
      }
      throw err
    }
    return plan
  }
  throw new LoadsSwitchError(`unknown row "${key}" — not among what this folder loads`, 404)
}

/** (D6) A project born with «what you set up on this machine» off: the
 *  project's own «Turn all off in this project» on the machine's groups —
 *  its tools (rows whose owner is you, a plugin's servers going with their
 *  plugin) and its personal skills — for what exists now; what is set up
 *  later loads. The project's place only: never the machine's file.
 *  Throws the engine's refusal (the seam says it as a warn). */
export function machineOffAtBirth(deps: FolderLoadsDeps, folder: string, engine: string): void {
  const { engines, inputOf } = folderInputs(deps, folder, undefined, engine)
  const h = engines.find((e) => e.id === engine)
  if (!h?.loads) return
  const keys = h.loads
    .inventory(inputOf(h))
    .rows.filter((r) => r.parent === undefined && r.origin.owner === 'you')
    .map((r) => r.key)
  if (keys.length > 0) bulkFolderLoads(deps, folder, { keys, origins: [] }, 'off', { scope: 'project' }, { group: 'machine', apply: true })
  let personal: string[] = []
  try {
    personal = h.loads.skills?.(skillsInput(deps, folder, h.id)).personal ?? []
  } catch {
    personal = []
  }
  if (personal.length > 0)
    bulkFolderLoads(
      deps,
      folder,
      { keys: [], origins: [], skills: [...new Set(personal)].map((name) => ({ name, from: 'personal' as const })) },
      'off',
      { scope: 'project' },
      { group: 'machine-skills', apply: true },
    )
}
