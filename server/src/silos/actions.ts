// silos/actions.ts — the v0 actions (Silo Standard catalogs.md «Actions»;
// step 1 Task 10). An action is a declared invocation of a kernel primitive:
// the manifest names the verb and its fields, the kernel does the work. Every
// action exists only on an ACTIVE silo.
//
//   set-field           the owner moves a listed field. On a SYNC source it
//                       writes the overlay (never the file — the next sync
//                       would erase it); on an agent source it writes the
//                       FILE: re-read + merge + atomic replace with CAS (the
//                       version the owner saw must still be the file's).
//   ack                 «seen»: the row leaves Needs you until the record
//                       changes (needs-you-acks pattern) — silos/acks.json
//   open                navigation only — the record answer carries the file
//   message-agent       a message to the producer composed from a declared
//                       template with the record's fields, delivered through
//                       the agents' inboxes (messages.ts), with its provenance
//   ensure-record       the owner makes sure ONE reserved record exists in a
//                       known project folder (plans 0.5.0: the project's
//                       list, plans/tasks.plan.json) — born from
//                       the manifest's seed when missing, never over one
//                       that exists — and, with `rotate`, its old finished
//                       children leave monthly for a dated archive the
//                       source never reads (written BEFORE they leave).
//   kernel-verb         the owner asks the KERNEL to mutate one of its own
//                       records (catalog kernel-kinds.ts KERNEL_VERBS, closed:
//                       stop-process). Declared by name over a kernel source
//                       whose kind admits it; the work is the kernel engine's
//                       (the impl the server wires); the event says it.
//   agent-record-write  the producer writes a record in ITS OWN agent state,
//                       with its bearer; appendOnly sub-kinds merge by their
//                       declared writeMerge. And reads the merged view — only
//                       what its location already lets it read on disk.
//
// PROPOSALS (annex piece this step debuts): over a sync source the producer
// does not move an owner field itself — it proposes; the kernel keeps the
// proposal pending (silos/proposals/<id>.json) with its literal diff, the
// owner approves (the action runs) or rejects (it stays said).
//
// Every action, approval and rejection is an EVENT, appended to
// silos/events.jsonl (silo + record key) and shown in the record's story.
import { createHash, randomUUID } from 'node:crypto'
import { bearerMayReadKey } from './bearer-scope.js'
import { seesAll } from '../project-scope.js'
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { basename, join } from 'node:path'
import { atomicWriteJson } from '../json-store.js'
import { agentDir, AlreadyExistsError, ContainmentError, readContained, writeContained } from '../safe-file.js'
import { containedDir } from '../contained-dir.js'
import { childDigest } from './child-digest.js'
import { blockedHolds, isSilosWait, reviewerNamed } from './task-flow.js'
import { RECORD_MAX_BYTES, recordPlace, segmentRe, type SiloLocations } from './files-source.js'
import type { SiloRegistry, SiloEntry } from './registry.js'
import type { SiloKernel, SetFieldResult } from './kernel.js'
import { collectionItems, fieldValueProblem, readRecordValue, rederiveAt, renderTemplate, PLATFORM_LOCATION, type SiloRecord } from './reader.js'
import { kernelKind, kernelVerb } from './kernel-kinds.js'
import { recordKey } from './journal.js'
import { kindsOf, formatMoney, terminalsOf, type KindInfo } from './voice.js'
import type { SiloNeedsYou, SiloAcksView } from './surfaces.js'
import { recordProducer } from './surfaces.js'
import { isMoney, parse as parseExpr, test as testExpr } from './expressions.js'

type Json = Record<string, unknown>
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)
const isStr = (v: unknown): v is string => typeof v === 'string'

export type ActionResult<T = unknown> = { ok: true; value: T } | { ok: false; code: number; reason: string; detail?: unknown }
const fail = (code: number, reason: string, detail?: unknown): ActionResult<never> => ({ ok: false, code, reason, ...(detail !== undefined ? { detail } : {}) })
// make-task's list: the Plans silo's standing record of a project
const PLANS_SILO_ID = 'plans'
const STANDING_TASKS = 'tasks'

// ── events ──────────────────────────────────────────────────────────────────

export interface SiloEvent {
  at: string
  silo: string
  key?: string
  verb: string // set-field | ack | message-agent | agent-record-write | proposal | proposal-approved | proposal-rejected | conflict-resolved
  by: string // 'owner', an agent id, or Silos itself (SILOS_AUTHOR)
  text: string // the line said: «set-field state: open → paid · proposed by finance · approved by owner»
  detail?: Json
}

export class SiloEvents {
  // the log carries the words of notes: the owner's alone (0600) — `mode`
  // only counts when a file is created, so one born wider is narrowed here,
  // once, when Silos starts
  constructor(private root: string) {
    try {
      if (existsSync(this.file)) chmodSync(this.file, 0o600)
    } catch {
      /* not ours to fix: said by nothing, read as before */
    }
  }
  private get file(): string {
    return join(this.root, 'events.jsonl')
  }
  append(e: Omit<SiloEvent, 'at'>, now = new Date()): SiloEvent {
    const ev: SiloEvent = { at: now.toISOString(), ...e }
    mkdirSync(this.root, { recursive: true, mode: 0o700 })
    appendFileSync(this.file, JSON.stringify(ev) + '\n', { mode: 0o600 })
    return ev
  }
  list(silo?: string, key?: string): SiloEvent[] {
    if (!existsSync(this.file)) return []
    const out: SiloEvent[] = []
    for (const line of readFileSync(this.file, 'utf8').split('\n')) {
      if (line.trim() === '') continue
      try {
        const e = JSON.parse(line) as SiloEvent
        if ((silo === undefined || e.silo === silo) && (key === undefined || e.key === key)) out.push(e)
      } catch {
        /* an unreadable line is skipped, never fatal */
      }
    }
    return out
  }
}

// ── acks ────────────────────────────────────────────────────────────────────

export class SiloAcks implements SiloAcksView {
  constructor(private root: string) {}
  private get file(): string {
    return join(this.root, 'acks.json')
  }
  private read(): Record<string, { state: unknown; at: unknown; ackedAt: string }> {
    try {
      const v = JSON.parse(readFileSync(this.file, 'utf8')) as unknown
      return isObj(v) ? (v as Record<string, { state: unknown; at: unknown; ackedAt: string }>) : {}
    } catch {
      return {}
    }
  }
  // acked while the record still has the state and moment it had when seen
  isAcked(silo: string, key: string, state: unknown, at: unknown): boolean {
    const a = this.read()[`${silo}|${key}`]
    return a !== undefined && a.state === state && a.at === at
  }
  ack(silo: string, key: string, state: unknown, at: unknown, now = new Date()): void {
    const all = this.read()
    all[`${silo}|${key}`] = { state, at, ackedAt: now.toISOString() }
    mkdirSync(this.root, { recursive: true, mode: 0o700 })
    atomicWriteJson(this.file, all, { mode: 0o600 })
  }
}

// ── proposals ───────────────────────────────────────────────────────────────

export interface SiloProposal {
  id: string
  silo: string
  key: string
  verb: 'set-field'
  field: string
  from: unknown
  to: unknown
  by: string // the proposing agent
  note: string | null
  at: string
  status: 'pending' | 'approved' | 'rejected' | 'failed'
  decidedAt?: string
  reason?: string // rejected: the owner's words; failed: why the approved action could not run
}

export class SiloProposals {
  constructor(private root: string) {}
  private get dir(): string {
    return join(this.root, 'proposals')
  }
  create(p: Omit<SiloProposal, 'id' | 'at' | 'status'>, now = new Date()): SiloProposal {
    const full: SiloProposal = { ...p, id: randomUUID(), at: now.toISOString(), status: 'pending' }
    mkdirSync(this.dir, { recursive: true, mode: 0o700 })
    atomicWriteJson(join(this.dir, `${full.id}.json`), full, { mode: 0o600 })
    return full
  }
  get(id: string): SiloProposal | null {
    if (!/^[0-9a-f-]{36}$/.test(id)) return null
    try {
      return JSON.parse(readFileSync(join(this.dir, `${id}.json`), 'utf8')) as SiloProposal
    } catch {
      return null
    }
  }
  save(p: SiloProposal): void {
    atomicWriteJson(join(this.dir, `${p.id}.json`), p, { mode: 0o600 })
  }
  list(silo?: string): SiloProposal[] {
    if (!existsSync(this.dir)) return []
    const out: SiloProposal[] = []
    for (const n of readdirSync(this.dir)) {
      if (!n.endsWith('.json')) continue
      try {
        const p = JSON.parse(readFileSync(join(this.dir, n), 'utf8')) as SiloProposal
        if (silo === undefined || p.silo === silo) out.push(p)
      } catch {
        /* skipped */
      }
    }
    return out.sort((a, b) => b.at.localeCompare(a.at))
  }
}

// ── the actions ─────────────────────────────────────────────────────────────

export interface SiloActionsOptions {
  // `list`: the daily sweep (rotateSweep) walks the silos it names
  registry: Pick<SiloRegistry, 'get'> & Partial<Pick<SiloRegistry, 'list'>>
  // sinceFor (plans 0.5.2, E7): a rotation's `when` reads since(…) from the
  // journal over the SAME record objects the last reading holds (the
  // kernel's sinceResolver WeakMap); absent → since is null
  kernel: Pick<SiloKernel, 'reading' | 'refresh' | 'setOwnerField' | 'resolveConflict' | 'mergedView'> &
    Partial<Pick<SiloKernel, 'refreshSoon' | 'flush' | 'sinceFor'>>
  events: SiloEvents
  acks: SiloAcks
  proposals: SiloProposals
  messages?: { send(m: { from: string; to: string; text: string }): { id: string } }
  agentStateBase: string
  isAgent: (v: string) => boolean
  // may this agent read records at this location on disk? (its own agent
  // state; a project folder inside its territories)
  agentMayReadLocation: (agentId: string, location: string) => boolean
  // the producer binding fixed at approval (operator.json); null = never bound
  producersOf?: (siloId: string) => string[] | null
  // (R3) the agent is of a record's location (project-scope.ts ofLocation):
  // a record is handed only to a producer of the location it lives in
  // (surfaces.ts recordProducer). Absent: every producer is
  ofLocation?: (agentId: string, location: string) => boolean
  // an agent in play (listed, not archived) — an archived producer is no
  // producer: nothing is messaged to it, it writes nothing (surfaces.ts' rule)
  inPlay?: (v: string) => boolean
  // the project folders a `project` source reads (files-source.ts) — where
  // ensure-record may make a record; absent = it makes none
  locations?: Pick<SiloLocations, 'projects'>
  // the thread a conversation id is on (plans 0.5.1, R13 — task-threads.ts
  // threadKey: lineage root, an OpenCode key with its `ses_…`): what groups
  // releases[] entries. Absent (tests): an entry's thread is its own session.
  threadKey?: (id: string) => string
  // the CURRENT conversations of a task (task-threads.ts currentOf — R13):
  // the listed ids minus the threads releases[] let go. What a release with
  // `dispose` asks («was this the last current thread?»). Absent: the same
  // rule over threadKey (an id's thread's last mark, by position).
  currentOf?: (listed: string[], releases: unknown) => string[]
  // the plans stamper's ownWrite: EVERY write of
  // the owner on a task — a gesture (taskGesture, hand included), a note
  // (and the reopen it carries), a release (with or without its wait), the
  // owner's link, a set-field, a task born by `new` — registers the shape
  // it writes, from INSIDE its mutator, so an unattended turn that touched
  // the same plan never has it reverted as its own; the answer undoes the
  // registration when the write did not land. Absent: nothing registered.
  ownWrite?: (silo: string, key: string, shape: Json) => () => void
  now?: () => Date
}

// release's answer (plans 0.5.2, E4): `written` the mark landed; `state` the
// task's state after; `disposed` the state the release left (dispose applied
// in the SAME write); `kept` the state it did not touch — another thread is
// still current, the task was not in dispose.from, the mark was already
// there (`already: 'released'`), or the verb declares no dispose
// a kernel-verb's impl (wired by the server: stop-process → the process
// engine): the kernel record's id and who asked; says what happened in words
export type KernelVerbImpl = (recordId: string, by: string) => Promise<ActionResult<{ says: string } & Record<string, unknown>>>
export type KernelVerbAnswer = { says: string; name: string; key: string } & Record<string, unknown>

export interface ReleaseAnswer {
  written: boolean
  state: string
  disposed?: string
  kept?: string
  already?: 'released'
  wait?: Record<string, unknown>
}

// the wait the OWNER's release to `blocked`
// writes in the same write: on whom and what for (and the question)
export interface ReleaseWait {
  owner: string
  action: string
  asked?: string
}

// the owner's gestures on one task:
// taskGesture's verbs, their arguments and what the answer adds to the record
export const TASK_VERBS = ['answer', 'done', 'drop', 'reopen', 'park', 'resume', 'remove-dependency', 'approve', 'hand'] as const
export type TaskVerb = (typeof TASK_VERBS)[number]
export interface TaskGestureArgs {
  text?: string // answer (required), approve (optional — «Approved.»), drop (its reason)
  asked?: string | null // answer, approve: the question the owner saw ('' — none); absent: not judged
  state?: string | null // done, drop: the state the owner saw; absent: not judged
  until?: string // park: the moment it comes back (ISO, ahead)
  day?: string // park: the day its note says («Parked until <day>.»)
  dep?: string // remove-dependency: the dependency's id
  // hand: who it goes to ('owner':
  // you), the owner the page painted ('' — nobody), the CURRENT
  // conversations the route judged (`judged`) and, of them, the ones that
  // are `to`'s own and stay (`keep`); `text` is its note («Handed from X to Y.»)
  to?: string
  owner?: string
  keep?: string[]
  judged?: string[]
}
// `already`: the task was already as the verb leaves it — nothing written
// (F3); `holds`: what still holds it after (task-flow.ts blockedHolds — the
// web's «Answered — but it still waits on …», F2)
export interface TaskGestureAnswer {
  already: boolean
  holds: string[]
  nowReady?: NowReady[]
  released?: string[]
}

// who asks for a claim/release: an agent bearer (agentId), else the owner
export interface ActionActor {
  agentId?: string | null
}

type ChildRef = { coll: string; id: string; info: KindInfo }
// `child`: the record's child the key names — or, at depth 2, the
// grandchild, with `via` the child it lives in (a task's note:
// <plan key>/tasks/<task>/notes/<index>)
interface Located {
  entry: SiloEntry
  manifest: Json
  sr: SiloRecord
  info: KindInfo
  child: ChildRef | null
  via?: ChildRef
}

const sha = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex')

// a task that became ready by a set-field: its key, id, identity and owner
export interface NowReady {
  key: string
  id: string
  identity: string
  owner: string
}

// The siblings of `child` whose `ready` is true in `after` and was not in
// `before` (the edited task itself aside) — only for a sub-kind declaring
// roles.task and a computed `ready`; null otherwise (nothing to say).
function nowReadyOf(child: ChildRef, before: Json, after: Json, recordKeyOf: string): NowReady[] | null {
  const role = child.info.dict.task
  if (!role || !child.info.dict.computed.ready) return null
  const readyIds = (rec: Json): Set<string> =>
    new Set(
      (Array.isArray(rec[child.coll]) ? (rec[child.coll] as unknown[]) : [])
        .filter(isObj)
        .filter((t) => t.ready === true)
        .map((t) => String(t.id)),
    )
  const was = readyIds(before)
  const kids = (Array.isArray(after[child.coll]) ? (after[child.coll] as unknown[]) : []).filter(isObj)
  return kids
    .filter((t) => t.ready === true && !was.has(String(t.id)) && String(t.id) !== child.id)
    .map((t) => ({
      key: `${recordKeyOf}/${child.coll}/${String(t.id)}`,
      id: String(t.id),
      identity: isStr(t.identity) ? t.identity : '',
      owner: isStr(t[role.owner]) ? (t[role.owner] as string) : '',
    }))
}

// the normalized child (or grandchild) a location names, in a read record
function normChild(record: Json, l: Pick<Located, 'child' | 'via'>): Json | null {
  const find = (rec: Json, c: ChildRef): Json | null =>
    Array.isArray(rec[c.coll]) ? ((rec[c.coll] as unknown[]).filter(isObj).find((x) => x.id === c.id) ?? null) : null
  if (!l.child) return record
  const parent = l.via ? find(record, l.via) : record
  return parent ? find(parent, l.child) : null
}

// An IDENTITY sub-kind (append-item's rule): its only field is its id and
// its lift reads a bare string as that id — a task's conversations[]. The
// id field's name, or null.
export function identityFieldOf(child: KindInfo): string | null {
  const env = isObj(child.spec.envelope) ? child.spec.envelope : {}
  const fields = isObj(child.spec.fields) ? child.spec.fields : {}
  const idField = isObj(env.id) && isStr(env.id.field) ? env.id.field : null
  const synth = isObj(child.spec.lift) && isObj(child.spec.lift.synthesize) ? child.spec.lift.synthesize : null
  return idField && synth && Object.keys(synth).length === 1 && isStr(synth[idField]) && Object.keys(fields).every((f) => f === idField) ? idField : null
}

// An identity child appended in the raw value: strings stay strings (never
// materialized to objects), a list of objects gets an object, a loose field
// the sub-kind's lift reads (support's `threadId`) becomes the list with both; an id
// already there is left alone. The reason it can't, or null.
function appendIdentityIn(target: Json, coll: string, v: string, idField: string, child: KindInfo): string | null {
  const list = target[coll]
  if (Array.isArray(list)) {
    if (list.some((c) => c === v || (isObj(c) && c[idField] === v))) return null
    target[coll] = [...list, list.length > 0 && list.every(isObj) ? { [idField]: v } : v]
  } else {
    if (list !== undefined && list !== null && !isStr(list)) return `${coll} in the file is not a list the kernel can append to`
    const lifted = collectionItems(child.spec, coll, target, target)
    const ids = lifted.ok ? lifted.items.map((c) => (isObj(c) ? c[idField] : c)).filter(isStr) : []
    target[coll] = [...ids.filter((x) => x !== v), v]
  }
  return null
}

// The release collection of a task sub-kind (roles.task.releases) and the
// conversations collection it marks — null when the kind declares none.
function releaseRoleOf(info: KindInfo): { conversations: string; releases: string } | null {
  const t = info.dict.task
  return t && t.conversations && t.releases ? { conversations: t.conversations, releases: t.releases } : null
}

function valueWords(v: unknown): string {
  if (isMoney(v)) return formatMoney(v)
  if (v === undefined || v === null || v === '') return 'nothing'
  return isStr(v) || typeof v === 'number' || typeof v === 'boolean' ? String(v) : JSON.stringify(v)
}

// the one refusal of a key outside the bearer's territory (bearer-scope.ts)
function outsideTerritory(agentId: string, key: string): string {
  return `${agentId} may only act on records in its own territory — ${key} is not`
}

export class SiloActions {
  constructor(private o: SiloActionsOptions) {}

  // (J3, K4) inside a mutator: the owner's write of task `key` registered
  // with the stamper as the shape `target` holds now; `held.undo` is what
  // the caller calls when the write did not land
  private ownWriteIn(id: string, key: string, target: Json, held: { undo: (() => void) | null }): void {
    held.undo?.()
    held.undo = this.o.ownWrite ? this.o.ownWrite(id, key, target) : null
  }
  private isTaskChild(l: Located): boolean {
    return !!l.child && !l.via && !!l.child.info.dict.task
  }

  private active(id: string): { entry: SiloEntry; manifest: Json } | ActionResult<never> {
    const entry = this.o.registry.get(id)
    if (!entry) return fail(404, `no silo ${id}`)
    if (entry.status.state !== 'active' || !entry.manifest)
      return fail(409, `${id} is not active (${entry.status.reason}) — actions exist only on an active silo`)
    return { entry, manifest: entry.manifest }
  }

  // A record (or a child: '<record key>/<collection>/<child id>', or a
  // grandchild one pair deeper — depth ≤ 2) of the last reading.
  // A bearer's key outside its projects → the one 403, whether the record
  // exists or not (bearer-scope.ts): judged on the key first; a key that only
  // passes through a folder around its own is looked up and judged on the
  // location it resolves to — a record outside and no record answer alike.
  private outsideBearer(id: string, agentId: string, key: string): ActionResult<never> | null {
    const may = (loc: string): boolean => this.o.agentMayReadLocation(agentId, loc)
    if (bearerMayReadKey(agentId, key, may)) return null
    const l = this.locate(id, key)
    if (!('ok' in l) && may(l.sr.location)) return null
    return fail(403, outsideTerritory(agentId, key))
  }

  private locate(id: string, key: string): Located | ActionResult<never> {
    const a = this.active(id)
    if ('ok' in a) return a
    const kinds = kindsOf(a.manifest)
    const records = this.o.kernel.reading(id)?.records ?? []
    const direct = records.find((r) => recordKey(r) === key)
    if (direct) return { ...a, sr: direct, info: kinds.get(direct.kind)!, child: null }
    for (const r of records) {
      const k = recordKey(r)
      if (!key.startsWith(k + '/')) continue
      const [coll, childId, ...rest] = key.slice(k.length + 1).split('/')
      const info = kinds.get(r.kind)!
      const childInfo = [...kinds.values()].find((x) => x.parent === info && x.coll === coll)
      if (childInfo && childId && rest.length === 0) return { ...a, sr: r, info, child: { coll: coll!, id: childId, info: childInfo } }
      const [coll2, id2, ...more] = rest
      const grandInfo = childInfo ? [...kinds.values()].find((x) => x.parent === childInfo && x.coll === coll2) : undefined
      if (childInfo && childId && grandInfo && id2 && more.length === 0)
        return { ...a, sr: r, info, child: { coll: coll2!, id: id2, info: grandInfo }, via: { coll: coll!, id: childId, info: childInfo } }
    }
    return fail(404, `no record ${key} in ${id}`)
  }

  private actionsOf(manifest: Json, verb: string): Json[] {
    return (Array.isArray((manifest.spec as Json).actions) ? ((manifest.spec as Json).actions as unknown[]) : []).filter(isObj).filter((x) => x.verb === verb)
  }

  private sourceOf(manifest: Json, sourceId: string): Json | null {
    return (
      (Array.isArray((manifest.spec as Json).sources) ? ((manifest.spec as Json).sources as unknown[]) : []).filter(isObj).find((s) => s.id === sourceId) ??
      null
    )
  }

  private isSync(manifest: Json, sourceId: string): boolean {
    const s = this.sourceOf(manifest, sourceId)
    return !!s && isObj(s.expects) && s.expects.producer === 'sync'
  }

  // set-field: what the manifest lets the owner write, where it must go.
  // On a task (a sub-kind declaring roles.task with a `ready`), the answer
  // also names `nowReady`: the sibling tasks ready AFTER the write and not
  // before (what the native Done/Drop called
  // `unblocked`); the route adds whether each owner will move. Nothing is
  // recomputed into the file: only the field the owner set is written.
  setField(
    id: string,
    key: string,
    field: string,
    value: unknown,
    opts: { version?: string | null; by?: string; quiet?: boolean } = {},
  ): ActionResult<SiloRecord & { nowReady?: NowReady[] }> {
    const l = this.locate(id, key)
    if ('ok' in l) return l
    const target = l.child ? l.child.info.name : l.info.name
    const action = this.actionsOf(l.manifest, 'set-field').find((x) => (isStr(x.subKind) ? x.subKind : x.kind) === target)
    const spec = action && isObj(action.fields) && isObj(action.fields[field]) ? (action.fields[field] as Json) : null
    if (!spec || spec.writableBy !== 'owner') return fail(403, `${field} is not a field the owner may set on ${target}`)
    if (value === null && spec.clearable !== true) return fail(400, `${field} can't be cleared`)
    // a field the kind declares is judged by the reader's own rule before
    // anything is written (a task's dependsOn: a list of ids — and, when the
    // field is `withinParent`, ids of its own siblings: the owner removes a
    // dropped blocker, never invents one)
    const declared = l.child && isObj(l.child.info.spec.fields) && isObj(l.child.info.spec.fields[field]) ? (l.child.info.spec.fields[field] as Json) : null
    if (declared && value !== null) {
      const bad = fieldValueProblem(field, declared, value)
      if (bad) return fail(400, bad)
      if (declared.withinParent === true && Array.isArray(value) && !l.via) {
        const here = l.sr.record[l.child!.coll]
        const ids = new Set((Array.isArray(here) ? here : []).filter(isObj).map((c) => String(c.id)))
        const stray = (value as string[]).filter((v) => !ids.has(v) || v === l.child!.id)
        if (stray.length > 0) return fail(400, `${field} names ${stray.join(', ')} — not another task of this plan`)
      }
    }
    let r: ActionResult<SiloRecord>
    if (this.isSync(l.manifest, l.sr.source)) {
      if (l.child) return fail(400, "over a sync source only the record's own fields can be held — not a child's")
      const o: SetFieldResult = this.o.kernel.setOwnerField(id, key, field, value)
      if (!o.ok) return fail(400, o.reason)
      r = { ok: true, value: o.record }
    } else {
      // the owner's set-field on a task is the owner's write (K4)
      const owned = (opts.by ?? 'owner') === 'owner' && this.isTaskChild(l)
      const held: { undo: (() => void) | null } = { undo: null }
      r = this.writeFile(
        l,
        (raw) => {
          const target = this.childIn(raw, l)
          if (!target) return 'the child is no longer in the file'
          if (value === null) delete target[field]
          else target[field] = value
          if (!l.child) this.stampOwner(l.info, raw)
          if (owned) this.ownWriteIn(id, key, target, held)
          return null
        },
        opts.version ?? null,
      )
      if (!r.ok) {
        held.undo?.()
        return r
      }
    }
    const before = l.child ? normChild(l.sr.record, l)?.[field] : isObj(l.sr.raw) ? l.sr.raw[field] : undefined
    if (!opts.quiet)
      this.o.events.append({
        silo: id,
        key,
        verb: 'set-field',
        by: opts.by ?? 'owner',
        text: `set-field ${field}: ${valueWords(before)} → ${valueWords(value)}${this.isSync(l.manifest, l.sr.source) ? ' (held over the sync)' : ''}`,
      })
    const ready = l.child && !l.via ? nowReadyOf(l.child, l.sr.record, r.value.record, recordKey(l.sr)) : null
    return ready ? { ok: true, value: { ...r.value, nowReady: ready } } : r
  }

  // the raw child (or grandchild) a location names, in the file's value
  private childIn(raw: Json, l: Pick<Located, 'child' | 'via'>): Json | null {
    if (!l.child) return raw
    const parent = l.via ? this.itemIn(raw, l.via) : raw
    return parent ? this.itemIn(parent, l.child) : null
  }

  private itemIn(raw: Json, child: ChildRef): Json | null {
    const list = raw[child.coll]
    const env = isObj(child.info.spec.envelope) ? child.info.spec.envelope : {}
    const idField = isObj(env.id) && isStr(env.id.field) ? env.id.field : 'id'
    return Array.isArray(list) ? (list.filter(isObj).find((c) => c[idField] === child.id) ?? null) : null
  }

  // the envelope's updatedBy field says the owner, when its values allow it;
  // its `stamp` (catalog extension) names the timestamp written with
  // it — support's updatedAt, which the producer's reopen rule reads
  private stampOwner(info: KindInfo, raw: Json, now: string = new Date().toISOString()): void {
    const env = isObj(info.spec.envelope) ? info.spec.envelope : {}
    const ub = isObj(env.updatedBy) ? env.updatedBy : null
    if (!ub || !isStr(ub.field) || ub.absent === 'unknown') return
    if (Array.isArray(ub.values) && !ub.values.includes('owner')) return
    raw[ub.field] = 'owner'
    if (isStr(ub.stamp) && ub.stamp !== '') raw[ub.stamp] = now
  }

  // The sub-kind an action names ('case/note') on this record's kind, with
  // the action itself — null when the manifest declares no such verb there.
  private subAction(manifest: Json, parent: KindInfo, verb: 'append-item' | 'move-item', coll: string): { action: Json; child: KindInfo } | null {
    const kinds = kindsOf(manifest)
    const child = [...kinds.values()].find((k) => k.parent?.name === parent.name && k.coll === coll)
    if (!child) return null
    const action = this.actionsOf(manifest, verb).find((x) => x.subKind === child.name)
    return action ? { action, child } : null
  }

  // A sub-kind's collection in the raw file as a list the kernel can write —
  // exactly the items the reader sees (reader.ts collectionItems): an array
  // as it is (a string item lifted by the sub-kind's `lift` when that lift
  // uses the string — support's freehand notes — materialized; any other
  // string item, unread, written back untouched), a whole-list string
  // lifted, and with no
  // list at all the item the reader LIFTS from the parent's loose fields
  // (support's `threadId`/`thread_id`): writing `[moved]` over a case whose
  // own thread was loose would hide that thread. The parent record the lift
  // templates read is built from the same raw value. null = it can't be.
  private rawCollection(manifest: Json, sr: SiloRecord, raw: Json, coll: string, child: KindInfo): unknown[] | null {
    const b = readRecordValue(manifest, sr.kind, raw, String(sr.record.id))
    const r = collectionItems(child.spec, coll, raw, b.ok ? b.record : raw)
    return r.ok ? r.items : null
  }

  // append-item: the owner adds a child to an appendOnly sub-kind (support:
  // a note) — on a record, or on one of its children (a plan task's note,
  // depth 2). Only the sub-kind's declared fields are taken from `values`
  // (text trimmed); the child's `at` is now and its updatedBy the owner.
  // Written like set-field: re-read + merge + atomic replace, CAS when given.
  appendItem(
    id: string,
    key: string,
    coll: string,
    values: unknown,
    opts: { version?: string | null; by?: string; revive?: false; actor?: ActionActor } = {},
  ): ActionResult<SiloRecord & { reopened?: string }> {
    // an agent never writes into, nor gets back, ANOTHER agent's state nor
    // another project's plans (silos/bearer-scope.ts, project-scope.ts) —
    // the same refusal whether the record exists or not. Inside its
    // projects plan files are shared by convention (architecture.md «Silos
    // writes in plan files too»). The owner's desk reaches every project.
    const actorId = opts.actor?.agentId ?? null
    const outside = actorId !== null && !seesAll(actorId) ? this.outsideBearer(id, actorId, key) : null
    if (outside) return outside
    const l = this.locate(id, key)
    if ('ok' in l) return l
    if (l.via) return fail(400, 'append to a record or to one of its children — nothing nests deeper')
    if (l.child && !normChild(l.sr.record, l)) return fail(404, `no record ${key} in ${id}`)
    const parent = l.child ? l.child.info : l.info
    const sub = this.subAction(l.manifest, parent, 'append-item', coll)
    if (!sub) return fail(403, `${parent.name} declares no append-item for ${coll}`)
    const by = sub.action.by
    // the kernel validates ROLES (plans 0.8.0): an
    // agent's bearer appends as a producer — `producer` ∈ by, and the agent a
    // producer of the silo (plans: every agent — its producer role is
    // any-agent); the owner as the owner. The IDENTITY is the request's
    // credential (the route passes actor.agentId from the bearer, never the body)
    const agentActor = opts.actor?.agentId ?? null
    const role = agentActor ? 'producer' : 'owner'
    if (!(Array.isArray(by) ? by.includes(role) : by === role))
      return fail(403, agentActor ? `an agent may not append to ${coll}` : `the owner may not append to ${coll}`)
    if (agentActor && !this.isProducer(id, l.manifest, agentActor) && !anyAgentProduces(l.manifest))
      return fail(403, `${agentActor} is not a producer of ${id}`)
    if (!isObj(values)) return fail(400, "send the child's fields as an object")
    const fields = isObj(sub.child.spec.fields) ? sub.child.spec.fields : {}
    const env = isObj(sub.child.spec.envelope) ? sub.child.spec.envelope : {}
    const now = new Date().toISOString()
    const item: Json = {}
    for (const [name, f] of Object.entries(fields)) {
      let v = values[name]
      if (isStr(v)) v = v.trim()
      if (v === undefined || v === null || v === '') {
        if (isObj(f) && f.required === true) return fail(400, `${name} is required`)
        continue
      }
      // judged BEFORE anything is written, by the reader's own rule: a
      // number, an object or a list where the sub-kind declares text never
      // reaches the file (a child that would not read is a child lost)
      if (isObj(f) && typeof f.max === 'number' && isStr(v) && v.length > f.max) return fail(400, `${name} must be 1–${f.max} characters`)
      const bad = fieldValueProblem(name, isObj(f) ? f : {}, v)
      if (bad) return fail(400, bad)
      item[name] = v
    }
    // An IDENTITY child — a sub-kind whose only field is its id and whose
    // lift reads a bare string as that id (a task's conversations[]: the
    // skill writes session ids as strings) — is written as its id, in the
    // shape the list already speaks: strings stay strings (never materialized
    // to objects), a list of objects gets an object. Idempotent: an id
    // already there is not added twice (and nothing is written).
    const idField = identityFieldOf(sub.child)
    if (idField && isStr(item[idField])) {
      const v = item[idField] as string
      const cur = l.child ? normChild(l.sr.record, l) : l.sr.record
      const have = cur && Array.isArray(cur[coll]) ? (cur[coll] as unknown[]) : []
      const listed = have.some((c) => isObj(c) && (c.id === v || c[idField] === v))
      // a conversation whose thread was released comes back current in the
      // SAME write (R13 revive) — ⌘K Link, /work, the engine's appendConversation
      // revive:false — a write that is not a gesture (sealing an engine's id
      // onto a key already listed) never undoes a release
      const revive = opts.revive === false ? null : this.reviveOf(l, parent, coll)
      const reviveNeeded = revive !== null && this.releasedNow(revive.raw, revive.releases, v)
      if (listed && !reviveNeeded) return { ok: true, value: l.sr }
      const writer = opts.by ?? 'owner'
      let revived = false
      const owned = writer === 'owner' && agentActor === null && this.isTaskChild(l)
      const held: { undo: (() => void) | null } = { undo: null }
      const r = this.writeFile(
        l,
        (raw) => {
          const target = this.childIn(raw, l)
          if (!target) return 'the child is no longer in the file'
          const err = appendIdentityIn(target, coll, v, idField, sub.child)
          if (err) return err
          if (revive) {
            const rv = this.reviveIn(target, revive.releases, v, writer)
            if (typeof rv === 'string') return rv
            revived = rv
          }
          if (owned) this.ownWriteIn(id, key, target, held)
          return null
        },
        opts.version ?? null,
      )
      if (!r.ok) {
        held.undo?.()
        return r
      }
      if (!listed) this.o.events.append({ silo: id, key, verb: 'append-item', by: writer, text: `added to ${coll}: ${v}` })
      if (revived) this.o.events.append({ silo: id, key, verb: 'release', by: writer, text: `${v} is current again on it` })
      return r
    }
    // a sub-kind whose envelope maps id/state to FIELDS can be born whole
    // (a plan task needs id and status, which are not
    // declared `fields` — without them the engine skips the child): the id is
    // required and must be new among its siblings; the state must be one the
    // kind declares, and defaults to the first declared (a task is born
    // pending). An identity child (handled above) never reaches here.
    const envIdField = isObj(env.id) && isStr(env.id.field) ? env.id.field : null
    if (envIdField) {
      const v = isStr(values[envIdField]) ? (values[envIdField] as string).trim() : ''
      if (v === '') return fail(400, `${envIdField} is required — a ${sub.child.name} without one is invisible`)
      const cur = l.child ? normChild(l.sr.record, l) : l.sr.record
      const siblings = cur && Array.isArray(cur[coll]) ? (cur[coll] as unknown[]) : []
      if (siblings.some((c) => isObj(c) && c[envIdField] === v)) return fail(409, `${coll} already has ${envIdField} «${v}» — ids are never reused`)
      // a standing record's rotated children left their ids behind (retired)
      if (!l.child && this.retiredOf(l.manifest, l.info.name, coll, l.sr.record).has(v))
        return fail(409, `${envIdField} «${v}» belonged to a ${sub.child.name} that rotated out — ids are never reused`)
      item[envIdField] = v
    }
    const envState = isObj(env.state) && isStr(env.state.field) ? env.state.field : null
    if (envState) {
      const states = (Array.isArray(sub.child.spec.states) ? sub.child.spec.states : []).filter(isObj).map((x) => String(x.value))
      const v = isStr(values[envState]) ? (values[envState] as string).trim() : ''
      if (v !== '' && !states.includes(v)) return fail(400, `${envState} must be one of ${states.join(', ')}`)
      item[envState] = v !== '' ? v : (states[0] ?? '')
    }
    const atField = isObj(env.at) && isStr(env.at.field) ? env.at.field : null
    if (atField) item[atField] = now
    const ub = isObj(env.updatedBy) && isStr(env.updatedBy.field) ? env.updatedBy : null
    // `by`: who writes it — the agent a request names, Silos itself
    // (SILOS_AUTHOR: the escalation's recovery note, a takeover); the owner
    // otherwise
    const writer = opts.by ?? 'owner'
    if (ub && (!Array.isArray(ub.values) || ub.values.includes(writer))) item[ub.field as string] = writer
    // A doubled send: the SAME author appending the SAME declared fields
    // within two minutes is one gesture arriving twice (the task page and the
    // record page both offer the box — the same word arrived twice
    // live, 15s apart). Idempotent no-op, like the identity child above. Never for
    // id'd children (ids already answer 409), and only when the sub-kind
    // stamps `at` — without it, freshness cannot be judged.
    // the owner's note that reopens its task — judged
    // here on the reading (the dedupe below never swallows one, J10.18) and
    // again inside the write, on the file as it is then
    const reopen = this.noteReopenOf(l, coll, writer, agentActor, item.text)
    const readNow = reopen && l.child ? normChild(l.sr.record, l) : null
    const wouldReopen = reopen !== null && readNow !== null && this.reopenVerdict(reopen, readNow, this.siblingsIn(l.sr.record, l)) !== null
    if (!envIdField && atField && !wouldReopen) {
      const cur = l.child ? normChild(l.sr.record, l) : l.sr.record
      const have = cur && Array.isArray(cur[coll]) ? (cur[coll] as unknown[]) : []
      const fieldNames = Object.keys(fields)
      const doubled = have.some((c) => {
        if (!isObj(c)) return false
        if (ub && c[ub.field as string] !== writer) return false
        const at = c[atField]
        if (!isStr(at)) return false
        const ms = Date.parse(at)
        if (Number.isNaN(ms) || Math.abs(Date.parse(now) - ms) > 120_000) return false
        return fieldNames.every((f) => c[f] === item[f])
      })
      if (doubled) return { ok: true, value: l.sr }
    }
    // the owner's note on a task is the owner's write (J3, K4)
    const owned = writer === 'owner' && agentActor === null && this.isTaskChild(l)
    const held: { undo: (() => void) | null } = { undo: null }
    const reopened: { changed: Array<[string, unknown, unknown]>; dest: string | null } = { changed: [], dest: null }
    const r = this.writeFile(
      l,
      (raw) => {
        const target = this.childIn(raw, l)
        if (!target) return 'the child is no longer in the file'
        // the reopen, judged on the file normalized as the reader reads it now
        // (the note itself never holds anything: judged before it is in)
        let verdict: { dest: string; clearWait: boolean } | null = null
        if (reopen) {
          const read = readRecordValue(l.manifest, l.sr.kind, structuredClone(raw), l.sr.record.id)
          const cur = read.ok ? normChild(read.record, l) : null
          verdict = read.ok && cur ? this.reopenVerdict(reopen, cur, this.siblingsIn(read.record, l)) : null
          if (verdict) {
            reopened.dest = verdict.dest
            if (verdict.clearWait && reopen.waitField && reopen.waitField in target) {
              reopened.changed.push([reopen.waitField, cur![reopen.waitField], undefined])
              delete target[reopen.waitField]
            }
            reopened.changed.push([reopen.sf, cur!.state ?? cur![reopen.sf], verdict.dest])
            target[reopen.sf] = verdict.dest
          }
        }
        // a child's collection: the items the reader sees under it (its
        // loose fields lifted from the child itself, when its sub-kind lifts any)
        const lifted = l.child ? collectionItems(sub.child.spec, coll, target, target) : null
        const list = l.child ? (lifted && lifted.ok ? lifted.items : null) : this.rawCollection(l.manifest, l.sr, raw, coll, sub.child)
        if (!list) return `${coll} in the file is not a list the kernel can append to`
        target[coll] = [...list, item]
        this.stampOwner(l.info, raw, now)
        if (owned) this.ownWriteIn(id, key, target, held)
        return null
      },
      opts.version ?? null,
    )
    if (!r.ok) {
      held.undo?.()
      return r
    }
    const said = Object.values(item).find((v) => isStr(v) && v !== now && v !== writer)
    // the event IS the child's provenance (task-mode/owner-notes.ts): it
    // carries the child's exact `at` — the event's own moment is that same
    // instant — and the digest of its declared fields in full, so ONE event
    // vouches for exactly ONE child, word for word (the line's text is clipped)
    const stamped = atField ? new Date(now) : new Date()
    this.o.events.append(
      {
        silo: id,
        key,
        verb: 'append-item',
        by: writer,
        text: `added to ${coll}${isStr(said) ? `: ${said.length > 120 ? `${said.slice(0, 117)}…` : said}` : ''}`,
        detail: { coll, digest: childDigest(item, Object.keys(fields)), ...(atField ? { at: now } : {}) },
      },
      stamped,
    )
    // the reopen it carried, in the words of its parts (set-field per field)
    for (const [f, before, after] of reopened.changed)
      this.o.events.append({
        silo: id,
        key,
        verb: 'set-field',
        by: writer,
        text: `set-field ${f}: ${valueWords(before)} → ${valueWords(after)} (the owner's note reopened it)`,
      })
    return reopened.dest !== null ? { ok: true, value: { ...r.value, reopened: reopened.dest } } : r
  }

  // Does the owner's note on this
  // task's notes reopen it? ONE rule, in the write of the note, for every
  // door (the task page, the record page, any other): the semantics of
  // roles.task. The static half — the owner writes (no agent actor) into the
  // task's notes (noteOf), the note is not «Dropped: …» (a note that CLOSES
  // never comes through here: taskGesture writes it), the manifest lets the
  // owner set the state (C13b) and `inPlay` was given (without it nobody is
  // in play: no reopen). null: it never reopens.
  private noteReopenOf(
    l: Located,
    coll: string,
    writer: string,
    actor: string | null,
    text: unknown,
  ): { sf: string; ownerField: string; waitField: string | null; checkField: string | null; depsField: string } | null {
    if (writer !== 'owner' || actor !== null || !this.isTaskChild(l) || !this.o.inPlay) return null
    const info = l.child!.info
    const role = info.dict.task!
    const note = this.noteOf(l.manifest, info)
    if (!note || note.coll !== coll) return null
    if (isStr(text) && text.trimStart().startsWith('Dropped:')) return null
    const sf = this.stateFieldOf(info)
    if (!sf) return null
    const setAction = this.actionsOf(l.manifest, 'set-field').find((x) => (isStr(x.subKind) ? x.subKind : x.kind) === info.name)
    const spec = setAction && isObj(setAction.fields) && isObj(setAction.fields[sf]) ? (setAction.fields[sf] as Json) : null
    if (!spec || spec.writableBy !== 'owner') return null
    return { sf, ownerField: role.owner, waitField: role.waitingOn ?? null, checkField: role.nextCheckAt ?? null, depsField: role.dependsOn }
  }

  // The dynamic half, on a task as the reader reads it: its owner an agent
  // IN PLAY (bound or told — never a person's, an archived agent's or
  // nobody's: J7), and the task closed — or blocked with nothing holding it
  // but Silos' own `unstick` wait (task-flow.ts blockedHolds). Where it goes
  // is reopen's destination computed WITHOUT Silos' wait, which the same
  // write takes out (J1): blocked while something still holds it, else
  // pending. null: it stays as it is.
  private reopenVerdict(
    r: { sf: string; ownerField: string; waitField: string | null; checkField: string | null; depsField: string },
    cur: Json,
    siblings: Json[],
  ): { dest: string; clearWait: boolean } | null {
    const owner = isStr(cur[r.ownerField]) ? (cur[r.ownerField] as string).trim() : ''
    if (owner === '' || !this.o.inPlay || !this.o.inPlay(owner)) return null
    const state = isStr(cur.state) ? cur.state : isStr(cur[r.sf]) ? (cur[r.sf] as string) : ''
    const closed = state === 'done' || state === 'cancelled'
    if (!closed && state !== 'blocked') return null
    const w = r.waitField ? cur[r.waitField] : undefined
    const wait = isObj(w) && isStr(w.owner) && w.owner.trim() !== '' ? { owner: w.owner.trim(), action: isStr(w.action) ? w.action.trim() : '' } : null
    const silos = wait !== null && isSilosWait(wait)
    const check = r.checkField && isStr(cur[r.checkField]) && cur[r.checkField] !== '' ? (cur[r.checkField] as string) : null
    const holds = blockedHolds({
      deps: Array.isArray(cur[r.depsField]) ? (cur[r.depsField] as unknown[]).filter(isStr) : [],
      stateOf: (d) => {
        const x = siblings.find((y) => y.id === d)
        return x && isStr(x.state) ? x.state : undefined
      },
      wait: silos ? null : wait,
      nextCheckAt: check,
      now: (this.o.now ?? (() => new Date()))().getTime(),
    })
    if (!closed && holds.length > 0) return null
    return { dest: holds.length > 0 ? 'blocked' : 'pending', clearWait: silos }
  }

  // the siblings of a located child in a read record (its plan's tasks)
  private siblingsIn(record: Json, l: Pick<Located, 'child'>): Json[] {
    const list = l.child ? record[l.child.coll] : undefined
    return Array.isArray(list) ? list.filter(isObj) : []
  }

  // Silos' OWN write on one child as the FILE holds it (the plans
  // stamper's cancel, revert, field clean-up and mirror re-stamp): `mutate` gets the child's raw object (null when the child is
  // no longer in the file) and the list it lives in, and returns
  // `{ write: false }` (nothing to change — nothing written), an error, or
  // `{ write: true }` after editing in place (or pushing the child back into
  // `list` — a removed task restored). Re-read + merge + atomic replace like
  // every write; the result must still read with the manifest. Signed by
  // `by` in the silo's events.
  silosWriteChild(
    id: string,
    key: string,
    mutate: (child: Json | null, list: unknown[]) => { write: boolean } | string,
    opts: { by: string; text: string },
  ): ActionResult<SiloRecord | null> {
    const l = this.locate(id, key)
    if ('ok' in l) return l
    if (!l.child || l.via) return fail(400, 'only a direct child is written here')
    const coll = l.child.coll
    const childId = l.child.id
    let wrote = false
    const r = this.writeFile(
      l,
      (raw) => {
        if (!Array.isArray(raw[coll])) raw[coll] = []
        const list = raw[coll] as unknown[]
        const child = list.filter(isObj).find((x) => x.id === childId) ?? null
        const out = mutate(child, list)
        if (typeof out === 'string') return out
        wrote = out.write
        return out.write ? null : 'unchanged'
      },
      null,
    )
    if (!r.ok) return r.reason === 'unchanged' ? { ok: true, value: null } : r
    if (wrote) this.o.events.append({ silo: id, key, verb: 'silos-write', by: opts.by, text: opts.text })
    return r
  }

  // link-and-set: ONE write that appends an identity child (a task's
  // conversations[] gets a session id) AND sets fields of the same child (its
  // status) — the claim: two conversations claiming
  // at once can't both read «nobody» and both write, and a link never lands
  // without its status (nor the reverse). Judged by the silo's `claim` verb
  // when it declares one on the child's kind with this `link` (plans 0.5.1,
  // R4): the fields and values come from its `set` (the field/value given
  // are not read), writableBy is not consulted, and it is allowed for the
  // owner (`owner` ∈ by, no agent actor) or for the task's own agent
  // (`task-owner` ∈ by and actor.agentId = the record's roles.task.owner).
  // Without the verb, today's rule: each half by its own verb (set-field's
  // writableBy, append-item's `by` and identity shape). A thread its
  // releases[] let go comes back current in the same write (revive — decided
  // HERE, never by the route). Written through writeFile — re-read + merge +
  // atomic replace, CAS when given. Nothing to change writes nothing.
  linkAndSet(
    id: string,
    key: string,
    coll: string,
    idValue: string,
    field: string,
    value: unknown,
    opts: { version?: string | null; by?: string; actor?: ActionActor } = {},
  ): ActionResult<SiloRecord & { linked: boolean; set: boolean; revived: boolean }> {
    const l = this.locate(id, key)
    if ('ok' in l) return l
    if (!l.child || l.via) return fail(400, "link-and-set acts on a record's child (a task)")
    const child = l.child
    const cur = normChild(l.sr.record, l)
    if (!cur) return fail(404, `no record ${key} in ${id}`)
    if (this.isSync(l.manifest, l.sr.source)) return fail(400, 'over a sync source a child is never written')
    const claim = this.actionsOf(l.manifest, 'claim').find((x) => x.subKind === child.info.name && x.link === coll) ?? null
    let sets: Array<[string, unknown]>
    if (claim) {
      const why = this.judgeTaskVerb(claim, child.info, cur, opts.actor, 'claim')
      if (why) return fail(403, why)
      sets = Object.entries(isObj(claim.set) ? claim.set : {})
      // the verb's `keep`: states its `set` never overrides while the task
      // really still waits — a claim on a blocked task whose wait is open
      // links the conversation and leaves it blocked (plans 0.5.3); one
      // whose dependencies are all done is claimed like any other
      const sf = this.stateFieldOf(child.info)
      if (sf && this.claimKeepOf(claim, l, cur)) sets = sets.filter(([f]) => f !== sf)
    } else {
      const setAction = this.actionsOf(l.manifest, 'set-field').find((x) => (isStr(x.subKind) ? x.subKind : x.kind) === child.info.name)
      const spec = setAction && isObj(setAction.fields) && isObj(setAction.fields[field]) ? (setAction.fields[field] as Json) : null
      if (!spec || spec.writableBy !== 'owner') return fail(403, `${field} is not a field the owner may set on ${child.info.name}`)
      sets = [[field, value]]
    }
    const sub = [...kindsOf(l.manifest).values()].find((k) => k.parent?.name === child.info.name && k.coll === coll) ?? null
    if (!sub) return fail(403, `${child.info.name} has no ${coll}`)
    if (!claim) {
      const app = this.subAction(l.manifest, child.info, 'append-item', coll)
      if (!app) return fail(403, `${child.info.name} declares no append-item for ${coll}`)
      const by = app.action.by
      if (!(Array.isArray(by) ? by.includes('owner') : by === 'owner')) return fail(403, `the owner may not append to ${coll}`)
    }
    const idField = identityFieldOf(sub)
    if (!idField) return fail(400, `${coll} is not a list of ids`)
    const v = idValue.trim()
    if (v === '') return fail(400, `${idField} is required`)
    // a closed task (a terminal state) is never reopened by a link — the claim
    // route's rule, here where every link-and-set writes; judged on the
    // reading AND on the file as written (a close between read and write)
    const stateField = this.stateFieldOf(child.info)
    const terminals = terminalsOf(child.info)
    const closedWhy = (st: unknown): string | null => (isStr(st) && terminals.has(st) ? `${key} is ${st} — more work on it is a new task (or reopen it)` : null)
    const closedNow = closedWhy(stateField && isStr(cur[stateField]) ? cur[stateField] : cur.state)
    if (closedNow) return fail(409, closedNow)
    const have = Array.isArray(cur[coll]) ? (cur[coll] as unknown[]) : []
    const linked = !have.some((c) => c === v || (isObj(c) && (c.id === v || c[idField] === v)))
    const changed = sets.filter(([f, val]) => cur[f] !== val)
    const set = changed.length > 0
    const revive = this.reviveOf(l, child.info, coll)
    const reviveNeeded = revive !== null && this.releasedNow(revive.raw, revive.releases, v)
    if (!linked && !set && !reviveNeeded) return { ok: true, value: { ...l.sr, linked: false, set: false, revived: false } }
    const who = opts.by ?? 'owner'
    let revived = false
    // the owner's link (no agent actor) is the owner's write (K4)
    const owned = !opts.actor?.agentId && !!child.info.dict.task
    const held: { undo: (() => void) | null } = { undo: null }
    const r = this.writeFile(
      l,
      (raw) => {
        const target = this.childIn(raw, l)
        if (!target) return 'the child is no longer in the file'
        const closed = stateField ? closedWhy(target[stateField]) : null
        if (closed) return closed
        const err = appendIdentityIn(target, coll, v, idField, sub)
        if (err) return err
        for (const [f, val] of sets) target[f] = val
        if (revive) {
          const rv = this.reviveIn(target, revive.releases, v, who)
          if (typeof rv === 'string') return rv
          revived = rv
        }
        if (owned) this.ownWriteIn(id, key, target, held)
        return null
      },
      opts.version ?? null,
    )
    if (!r.ok) {
      held.undo?.()
      return r
    }
    // the record's story says each half in its own verb's words, as before
    if (linked) this.o.events.append({ silo: id, key, verb: 'append-item', by: who, text: `added to ${coll}: ${v}` })
    for (const [f, val] of changed)
      this.o.events.append({ silo: id, key, verb: 'set-field', by: who, text: `set-field ${f}: ${valueWords(cur[f])} → ${valueWords(val)}` })
    if (revived) this.o.events.append({ silo: id, key, verb: 'release', by: who, text: `${v} is current again on it` })
    return { ok: true, value: { ...r.value, linked, set, revived } }
  }

  // Is a claim/release verb allowed for this actor on this task? null = yes,
  // else the reason. `owner` ∈ by: the owner (no agent actor); `task-owner` ∈
  // by: the agent roles.task.owner names in THIS record.
  private judgeTaskVerb(action: Json, info: KindInfo, rec: Json, actor: ActionActor | undefined, verb: 'claim' | 'release'): string | null {
    const by = Array.isArray(action.by) ? action.by.filter(isStr) : []
    const agent = actor?.agentId ?? null
    if (agent === null) return by.includes('owner') ? null : `the owner may not ${verb} a ${info.name}`
    const ownerField = info.dict.task?.owner
    const owner = ownerField && isStr(rec[ownerField]) ? (rec[ownerField] as string).trim() : ''
    if (by.includes('task-owner') && owner !== '' && owner === agent) return null
    return `${agent} may not ${verb} this ${info.name.split('/').pop()} — it is ${owner || 'nobody'}'s`
  }

  // The revive of R13: on a task sub-kind declaring roles.task.releases, a
  // write to its conversations collection — the raw task as last read and the
  // releases collection's name; null when it does not apply.
  private reviveOf(l: Located, parent: KindInfo, coll: string): { raw: Json | null; releases: string } | null {
    const role = releaseRoleOf(parent)
    if (!role || role.conversations !== coll || !l.child) return null
    return { raw: isObj(l.sr.raw) ? this.childIn(l.sr.raw, l) : null, releases: role.releases }
  }

  private threadOf(session: string): string {
    return this.o.threadKey ? this.o.threadKey(session) : session
  }

  // the last releases[] entry on `session`'s thread, by position — null: none
  private lastMarkOf(list: unknown, session: string): Json | null {
    if (!Array.isArray(list)) return null
    const tk = this.threadOf(session)
    let last: Json | null = null
    for (const e of list) if (isObj(e) && isStr(e.session) && e.session !== '' && typeof e.released === 'boolean' && this.threadOf(e.session) === tk) last = e
    return last
  }

  // is `session`'s thread released in this raw task right now?
  private releasedNow(rawTask: Json | null, releases: string, session: string): boolean {
    return rawTask !== null && this.lastMarkOf(rawTask[releases], session)?.released === true
  }

  // inside the mutator: append {session, released: false} when the last mark
  // of its thread is a release. true = revived; a string = it can't be.
  private reviveIn(target: Json, releases: string, session: string, by: string): boolean | string {
    const list = target[releases]
    if (list === undefined || list === null) return false
    if (!Array.isArray(list)) return `${releases} in the file is not a list — nothing was written`
    if (this.lastMarkOf(list, session)?.released !== true) return false
    target[releases] = [...list, { session, released: false, at: (this.o.now ?? (() => new Date()))().toISOString(), by }]
    return true
  }

  // release (plans 0.5.1, R13): ONE mark on a task's releases[] — `released:
  // true` lets a conversation's thread go (history: no tip, holder or live),
  // `false` brings it back. Judged by the silo's `release` verb (owner, or
  // the task's own agent when `task-owner` ∈ by); its `link` names the
  // collection. Idempotent ONLY against the last mark of its thread
  // (o.threadKey): the same `released` there writes nothing. Never the
  // two-minute dedupe of appendItem; never a rewrite of an earlier mark.
  //
  // dispose (plans 0.5.2): with the verb's `dispose` and a
  // release (released: true), the SAME write sets dispose.field to `state`
  // (one of dispose.allowed — else 400) or to dispose.default — ONLY when the
  // task is in dispose.from as written AND the thread let go was the LAST
  // current one. Another current thread, another state, a mark already there
  // (written: false): the state is not touched and the answer says `kept`.
  //
  // the wait: the OWNER's release that
  // leaves the task `blocked` (no agent actor — the route lets only the
  // owner send one) writes `wait` in the SAME write, over any wait the task
  // had; without one, the default `{owner: 'owner', action: 'unblock it'}`
  // only when nothing else would hold it (blockedHolds) and no wait was
  // there — never a second brake. A release that does not leave it blocked
  // writes no wait (the answer has none).
  appendRelease(
    id: string,
    key: string,
    session: string,
    released: boolean,
    opts: { by?: string; actor?: ActionActor; state?: string | null; wait?: ReleaseWait | null } = {},
  ): ActionResult<SiloRecord & ReleaseAnswer> {
    const l = this.locate(id, key)
    if ('ok' in l) return l
    if (!l.child || l.via) return fail(400, "a release acts on a record's child (a task)")
    const child = l.child
    const cur = normChild(l.sr.record, l)
    if (!cur) return fail(404, `no record ${key} in ${id}`)
    if (this.isSync(l.manifest, l.sr.source)) return fail(400, 'over a sync source a child is never written')
    const action = this.actionsOf(l.manifest, 'release').find((x) => x.subKind === child.info.name) ?? null
    const name = isObj(l.manifest.metadata) && isStr(l.manifest.metadata.name) ? l.manifest.metadata.name : id
    if (!action || !isStr(action.link)) return fail(501, `this ${name} has no release — update it`)
    const why = this.judgeTaskVerb(action, child.info, cur, opts.actor, 'release')
    if (why) return fail(403, why)
    const coll = action.link
    const v = session.trim()
    if (v === '') return fail(400, 'session is required')
    const d = released ? this.disposeOf(action, child.info) : null
    const asked = isStr(opts.state) && opts.state.trim() !== '' ? opts.state.trim() : null
    if (d && asked !== null && !d.allowed.includes(asked)) return fail(400, `state must be one of ${d.allowed.join(', ')} — omit it to leave it ${d.default}`)
    const stateField = this.stateFieldOf(child.info)
    const stateOf = (t: Json | null): string => (t && stateField && isStr(t[stateField]) ? (t[stateField] as string) : String(cur.state ?? ''))
    const who = opts.by ?? 'owner'
    const rawTask = isObj(l.sr.raw) ? this.childIn(l.sr.raw, l) : null
    const same = (prev: Json | null): boolean => (prev === null ? !released : prev.released === released)
    // never marked: the thread is current — a «not released» mark says nothing
    if (same(rawTask ? this.lastMarkOf(rawTask[coll], v) : null)) {
      const st = stateOf(rawTask)
      return { ok: true, value: { ...l.sr, written: false, state: st, ...(released ? { kept: st, already: 'released' as const } : {}) } }
    }
    const conv = this.conversationsOf(l.manifest, child.info)
    // what the mutator decided (an object: a callback's writes are not narrowed)
    const out: { disposed: string | null; after: string | null; reviewer: Json | null; wait: Json | null; waitBefore: unknown } = {
      disposed: null,
      after: null,
      reviewer: null,
      wait: null,
      waitBefore: undefined,
    }
    const role = child.info.dict.task
    const REVIEWER_FIRST = 'name who reviews first: write waitingOn {owner, action, asked}'
    // the owner's release (no agent actor) is the owner's write (K4)
    const owned = !opts.actor?.agentId && !!role
    const held: { undo: (() => void) | null } = { undo: null }
    const r = this.writeFile(
      l,
      (raw) => {
        const target = this.childIn(raw, l)
        if (!target) return 'the child is no longer in the file'
        const list = target[coll]
        if (list !== undefined && list !== null && !Array.isArray(list)) return `${coll} in the file is not a list — nothing was written`
        target[coll] = [...(Array.isArray(list) ? list : []), { session: v, released, at: (this.o.now ?? (() => new Date()))().toISOString(), by: who }]
        // the disposition, judged on the file AS WRITTEN: in `from`, and no
        // thread left current once this mark is in
        if (d && target[d.field] === d.from && (!conv || this.currentIds(this.listedIn(target, conv), target[coll]).length === 0)) {
          out.disposed = asked ?? d.default
          // an AGENT's task left in review names
          // who reviews it (task-flow.ts reviewerNamed — the rule own() reads):
          // the agent's bearer without one is refused here, so no mark lands;
          // the owner leaving it in review is its reviewer — the wait rides
          // this same write
          const ownerOf = role && isStr(target[role.owner]) ? (target[role.owner] as string).trim() : ''
          if (out.disposed === 'in_review' && role?.waitingOn && ownerOf !== '' && this.o.isAgent(ownerOf) && !reviewerNamed(ownerOf, target[role.waitingOn])) {
            if (opts.actor?.agentId) return REVIEWER_FIRST
            out.reviewer = { owner: 'owner', action: 'review it' }
            target[role.waitingOn] = out.reviewer
          }
          target[d.field] = out.disposed
          // the owner leaving it blocked names on whom — the same write
          if (out.disposed === 'blocked' && owned && role?.waitingOn) {
            const had = target[role.waitingOn]
            const hasWait = isObj(had) && isStr(had.owner) && had.owner.trim() !== ''
            let w: Json | null = null
            if (opts.wait) w = { owner: opts.wait.owner, action: opts.wait.action, ...(opts.wait.asked ? { asked: opts.wait.asked } : {}) }
            else if (!hasWait) {
              const siblings = Array.isArray(raw[child.coll]) ? (raw[child.coll] as unknown[]).filter(isObj) : []
              const holds = blockedHolds({
                deps: Array.isArray(target[role.dependsOn]) ? (target[role.dependsOn] as unknown[]).filter(isStr) : [],
                stateOf: (dep) => {
                  const x = siblings.find((y) => y.id === dep)
                  return x && stateField && isStr(x[stateField]) ? (x[stateField] as string) : undefined
                },
                wait: null,
                nextCheckAt: role.nextCheckAt && isStr(target[role.nextCheckAt]) ? (target[role.nextCheckAt] as string) : null,
                now: (this.o.now ?? (() => new Date()))().getTime(),
              })
              if (holds.length === 0) w = { owner: 'owner', action: 'unblock it' }
            }
            if (w) {
              out.waitBefore = had
              out.wait = w
              target[role.waitingOn] = w
            }
          }
        }
        out.after = stateOf(target)
        if (owned) this.ownWriteIn(id, key, target, held)
        return null
      },
      null,
    )
    if (!r.ok) {
      held.undo?.()
      return r
    }
    this.o.events.append({
      silo: id,
      key,
      verb: 'release',
      by: who,
      text: released ? `released ${v} — it is history on this task` : `${v} is current again on it`,
    })
    const disposed = out.disposed
    if (out.reviewer && role?.waitingOn)
      this.o.events.append({
        silo: id,
        key,
        verb: 'set-field',
        by: who,
        text: `set-field ${role.waitingOn}: ${valueWords(cur[role.waitingOn])} → ${valueWords(out.reviewer)} (released in review)`,
      })
    if (out.wait && role?.waitingOn)
      this.o.events.append({
        silo: id,
        key,
        verb: 'set-field',
        by: who,
        text: `set-field ${role.waitingOn}: ${valueWords(out.waitBefore)} → ${valueWords(out.wait)} (released blocked)`,
      })
    if (d && disposed !== null)
      this.o.events.append({ silo: id, key, verb: 'set-field', by: who, text: `set-field ${d.field}: ${d.from} → ${disposed} (released)` })
    const st = out.after ?? stateOf(null)
    return {
      ok: true,
      value: {
        ...r.value,
        written: true,
        state: st,
        ...(disposed !== null ? { disposed } : released ? { kept: st } : {}),
        ...(out.wait ? { wait: out.wait } : {}),
      },
    }
  }

  // ── the owner's gestures on ONE task ──
  //
  // taskGesture: ONE verb of the owner over ONE task = ONE write. The file is
  // read NOW (writeFile: re-read + merge + atomic replace), normalized by the
  // reader inside the mutator (F9), and there the verb's CONDITION is judged
  // — the task's, never the file's sha (C13c): another task of the same plan
  // written meanwhile refuses nothing. A condition that fails on a task the
  // verb would leave as it is answers `already: true` and writes nothing (F3);
  // any other failure is a 409 in the verb's words with the task as it is
  // now (`detail.task`). The condition carries what the owner SAW (F4):
  // `asked` (answer, approve: the question painted, '' when the wait had
  // none) and `state` (done, drop: the state painted) — absent, not judged
  // (the server's own callers: respond's gate, a Vault save).
  //
  // Each verb is admitted only when the manifest lets the owner every write
  // it is made of (C13b): set-field writableBy for the fields it PUTS, the
  // notes' append-item for its note; the fields it CLEARS (waitingOn,
  // nextCheckAt) are cleared when the role declares them (F9). Its note is
  // the owner's (by: owner — always; the route lets only the owner in) and
  // never goes through append-item's two-minute dedupe. The events are the
  // ones its parts would leave: the note's append-item first (its exact `at`
  // and digest: owner-notes.ts provenance) — with `closes: true` for a verb
  // that CLOSES (approve, drop: that note neither reopens nor wakes, C14a/F8)
  // — then one set-field per field changed, its «before» read in the mutator.
  //
  // Only a sub-kind that declares roles.task (F1): another kind's rows keep
  // their generic set-field/append (web/src/lib/task-drop.ts).
  taskGesture(id: string, key: string, verb: TaskVerb, args: TaskGestureArgs = {}): ActionResult<SiloRecord & TaskGestureAnswer> {
    if (!TASK_VERBS.includes(verb)) return fail(400, `no verb ${JSON.stringify(verb)} — one of ${TASK_VERBS.join(', ')}`)
    const l = this.locate(id, key)
    if ('ok' in l) return l
    if (!l.child || l.via) return fail(400, `${key} is not a task — the owner's gestures act on a task`)
    const child = l.child
    const role = child.info.dict.task
    if (!role) return fail(400, `${child.info.name} is no task (it declares no roles.task) — its row keeps its own verbs`)
    if (this.isSync(l.manifest, l.sr.source)) return fail(400, 'over a sync source a child is never written')
    const sf = this.stateFieldOf(child.info)
    if (!sf) return fail(400, `${child.info.name} declares no state field`)
    const states = new Set((Array.isArray(child.info.spec.states) ? child.info.spec.states : []).filter(isObj).map((x) => String(x.value)))
    for (const s of ['pending', 'blocked', 'in_review', 'done', 'cancelled'])
      if (!states.has(s)) return fail(400, `${child.info.name} has no ${s} state — the task role reads the standard states`)
    // what the verb PUTS, by the manifest's set-field (C13b)
    const setAction = this.actionsOf(l.manifest, 'set-field').find((x) => (isStr(x.subKind) ? x.subKind : x.kind) === child.info.name)
    const writable = (f: string): boolean =>
      !!setAction && isObj(setAction.fields) && isObj(setAction.fields[f]) && (setAction.fields[f] as Json).writableBy === 'owner'
    // (J9, K2) `hand` puts the owner field too — the ONE exemption from
    // writableBy, and only for `owner`: it is no verb of the manifest and
    // set-field never writes `owner` (the record page's editor would be a
    // second way to give, without any of hand's rules); its state, its note
    // and its releases are admitted like every verb's
    const puts: Record<TaskVerb, string[]> = {
      answer: [sf],
      done: [sf],
      drop: [sf],
      approve: [sf],
      reopen: [sf],
      park: role.nextCheckAt ? [role.nextCheckAt] : [],
      resume: [sf],
      'remove-dependency': [role.dependsOn, sf],
      hand: [sf],
    }
    if (verb === 'park' && !role.nextCheckAt) return fail(400, `${child.info.name} declares no next check — nothing to park it with`)
    const denied = puts[verb].find((f) => !writable(f))
    if (denied) return fail(403, `the owner may not ${verb} a ${child.info.name} here — ${denied} is not a field the owner may set`)
    const note = this.noteOf(l.manifest, child.info)
    const needsNote = verb === 'answer' || verb === 'drop' || verb === 'approve' || verb === 'park' || verb === 'hand'
    if (needsNote && !note) return fail(403, `${child.info.name} declares no notes the owner may append — ${verb} writes one`)
    // hand's arguments: whom to, what the page painted, what the route judged
    const to = isStr(args.to) ? args.to.trim() : ''
    const conv = verb === 'hand' ? this.conversationsOf(l.manifest, child.info) : null
    const relRole = verb === 'hand' ? releaseRoleOf(child.info) : null
    if (verb === 'hand') {
      if (to === '') return fail(400, 'send {to} — whom it goes to')
      if (!isStr(args.owner)) return fail(400, "send {owner} — the owner you saw ('' for nobody)")
      if (!isStr(args.state) || args.state.trim() === '') return fail(400, 'send {state} — the state you saw')
      if (isStr(args.text) ? args.text.trim() === '' : true) return fail(400, 'hand writes its note — send {text}')
      if (!conv || !relRole) return fail(400, `${child.info.name} lists no conversations it can release — nothing to hand over`)
    }
    const keep = new Set(Array.isArray(args.keep) ? args.keep.filter(isStr) : [])
    const judged = new Set(Array.isArray(args.judged) ? args.judged.filter(isStr) : [])
    // the arguments, judged before anything is read
    const text = isStr(args.text) ? args.text.trim() : ''
    if (verb === 'answer' && text === '') return fail(400, 'an empty answer says nothing — send {text}')
    const now = (this.o.now ?? (() => new Date()))()
    let until: string | null = null
    if (verb === 'park') {
      const ms = isStr(args.until) ? Date.parse(args.until) : NaN
      if (Number.isNaN(ms)) return fail(400, 'send {until} — the moment it comes back, as an ISO date-time')
      if (ms <= now.getTime()) return fail(400, `${args.until} is past — park it until a moment still ahead`)
      until = new Date(ms).toISOString()
    }
    const dep = isStr(args.dep) ? args.dep.trim() : ''
    if (verb === 'remove-dependency' && dep === '') return fail(400, 'send {dep} — the id of the dependency to remove')
    const noteText =
      verb === 'answer'
        ? text
        : verb === 'approve'
          ? text !== ''
            ? text
            : 'Approved.'
          : verb === 'drop'
            ? `Dropped: ${text !== '' ? text : 'by the owner'}`
            : verb === 'park'
              ? `Parked until ${isStr(args.day) && args.day.trim() !== '' ? args.day.trim() : until!.slice(0, 10)}.`
              : verb === 'hand'
                ? text
                : ''
    const noteItem = note ? this.noteItem(note.sub, noteText, now.toISOString()) : null
    if (noteItem && typeof noteItem === 'string' && noteText !== '') return fail(400, noteItem)
    const closes = verb === 'approve' || verb === 'drop'
    const words = (s: string): string => (s === 'cancelled' ? 'dropped' : s.replace('_', ' '))
    const ownerField = role.owner
    const waitField = role.waitingOn ?? null
    const checkField = role.nextCheckAt ?? null
    // what the mutator decided (an object: a callback's writes are not narrowed)
    const out: {
      already: boolean
      refused: string | null
      task: Json | null
      before: Json | null
      beforeRec: Json | null
      changed: Array<[string, unknown, unknown]>
      noted: Json | null
      holds: string[]
      released: string[]
    } = { already: false, refused: null, task: null, before: null, beforeRec: null, changed: [], noted: null, holds: [], released: [] }
    const UNCHANGED = '\u0000unchanged'
    // every gesture is the owner's write (J3)
    const held: { undo: (() => void) | null } = { undo: null }
    const r = this.writeFile(
      l,
      (raw) => {
        const target = this.childIn(raw, l)
        if (!target) return 'the child is no longer in the file'
        // the file normalized as the reader reads it (F9): the condition, the
        // dependencies' states and every «before» come from here
        const read = readRecordValue(l.manifest, l.sr.kind, structuredClone(raw), l.sr.record.id)
        if (!read.ok) return `the plan no longer reads: ${read.reason}`
        const cur = normChild(read.record, l)
        if (!cur) return `${child.coll}/${child.id} does not read in the file now`
        out.task = cur
        out.before = cur
        out.beforeRec = read.record
        const siblings = Array.isArray(read.record[child.coll]) ? (read.record[child.coll] as unknown[]).filter(isObj) : []
        const stateOf = (d: string): string | undefined => {
          const x = siblings.find((y) => y.id === d)
          return x && isStr(x.state) ? x.state : undefined
        }
        const state = isStr(cur.state) ? cur.state : isStr(cur[sf]) ? (cur[sf] as string) : ''
        const closed = state === 'done' || state === 'cancelled'
        const o = isStr(cur[ownerField]) ? (cur[ownerField] as string).trim() : ''
        const w = waitField ? cur[waitField] : undefined
        const wait =
          isObj(w) && isStr(w.owner) && w.owner.trim() !== ''
            ? { owner: w.owner.trim(), action: isStr(w.action) ? w.action.trim() : '', asked: isStr(w.asked) ? w.asked.trim() : '' }
            : null
        const check = checkField && isStr(cur[checkField]) && cur[checkField] !== '' ? (cur[checkField] as string) : null
        const deps = Array.isArray(cur[role.dependsOn]) ? (cur[role.dependsOn] as unknown[]).filter(isStr) : []
        // the condition (C13c), then `already` (F3) when it fails
        const refuse = (why: string, already: boolean): string => {
          if (already) {
            out.already = true
            return UNCHANGED
          }
          out.refused = why
          return why
        }
        const askedNow = (): string | null =>
          args.asked === undefined || args.asked === null ? null : wait && wait.asked !== args.asked.trim() ? 'it asks something else now' : null
        const paintedState = (): string | null =>
          isStr(args.state) && args.state !== '' && args.state !== state ? `it changed — it is ${words(state)} now` : null
        if (verb === 'answer') {
          if (closed) return refuse(`it is ${words(state)} already`, false)
          if (!wait) return refuse('it no longer waits on you', false)
          if (isSilosWait(wait)) return refuse("it waits on Silos' own nudge — a note answers that", false)
          const a = askedNow()
          if (a) return refuse(a, false)
        } else if (verb === 'approve') {
          if (state !== 'in_review') return refuse(state === 'done' ? 'it is done already' : `it changed — it is ${words(state)} now`, state === 'done')
          if (o === '' || !this.o.isAgent(o)) return refuse(`approve is for an agent's review — this one is ${o || 'nobody'}'s`, false)
          if (!wait || wait.owner !== 'owner') return refuse('it no longer waits on you', false)
          const a = askedNow()
          if (a) return refuse(a, false)
        } else if (verb === 'done') {
          if (closed) return refuse(state === 'done' ? 'it is done already' : 'it is dropped — reopen it first', state === 'done')
          const p = paintedState()
          if (p) return refuse(p, false)
        } else if (verb === 'drop') {
          if (closed) return refuse(state === 'cancelled' ? 'it is dropped already' : 'it is done already', state === 'cancelled')
          const p = paintedState()
          if (p) return refuse(p, false)
        } else if (verb === 'reopen') {
          if (!closed) return refuse(`it is ${words(state)} — open already`, true)
        } else if (verb === 'park') {
          if (closed) return refuse(`it is ${words(state)} already`, false)
        } else if (verb === 'resume') {
          if (check === null) return refuse('it has no next check', true)
        } else if (verb === 'remove-dependency') {
          if (!deps.includes(dep)) return refuse(`it does not depend on ${dep}`, true)
        } else if (verb === 'hand') {
          // (J10.14) it is `to`'s already: nothing to write
          if (o === to) return refuse(`it is ${to === 'owner' ? 'yours' : `${to}'s`} already`, true)
          if (closed) return refuse(`it is ${words(state)} — reopen it first`, false)
          const ownerWords = (x: string): string => (x === '' ? "nobody's" : x === 'owner' ? 'yours' : `${x}'s`)
          if (args.owner!.trim() !== o) return refuse(`it changed — it is ${ownerWords(o)} now`, false)
          const p = paintedState()
          if (p) return refuse(p, false)
          // (K6) a CURRENT conversation the route did not judge: it changed
          const current = this.currentIds(this.listedIn(target, conv!), target[relRole!.releases])
          if (current.some((x) => !judged.has(x))) return refuse('it changed — a conversation joined it since you looked', false)
        }
        // the write — on the raw task, as the file holds it
        const set = (f: string, v: unknown): void => {
          const before = cur[f]
          if (v === undefined) {
            if (!(f in target)) return
            delete target[f]
          } else target[f] = v
          out.changed.push([f, before, v])
        }
        const clear = (f: string | null): void => {
          if (f && f in target) set(f, undefined)
        }
        if (needsNote && note && noteItem && typeof noteItem !== 'string' && (verb !== 'park' || o === '' || !this.o.isAgent(o))) {
          const lifted = collectionItems(note.sub.spec, note.coll, target, target)
          if (!lifted.ok) return `${note.coll} in the file is not a list the kernel can append to`
          target[note.coll] = [...lifted.items, noteItem]
          out.noted = noteItem
        }
        // what still holds it once this verb is done (task-flow.ts blockedHolds)
        const holdsAfter = (o2: { deps?: string[]; wait?: boolean; check?: boolean }): string[] =>
          blockedHolds({
            deps: o2.deps ?? deps,
            stateOf,
            wait: o2.wait === false || !wait ? null : { owner: wait.owner, action: wait.action },
            nextCheckAt: o2.check === false ? null : check,
            now: now.getTime(),
          })
        if (verb === 'answer') {
          clear(waitField)
          out.holds = holdsAfter({ wait: false })
          if (state === 'in_review') set(sf, 'pending')
          else if (state === 'blocked' && out.holds.length === 0) set(sf, 'pending')
        } else if (verb === 'approve') {
          // a closing verb clears what only an open task carries, as done does
          set(sf, 'done')
          clear(waitField)
          clear(checkField)
        } else if (verb === 'done') {
          set(sf, 'done')
          clear(waitField)
          clear(checkField)
        } else if (verb === 'drop') {
          set(sf, 'cancelled')
          clear(waitField)
          clear(checkField)
        } else if (verb === 'reopen') {
          out.holds = holdsAfter({})
          set(sf, out.holds.length > 0 ? 'blocked' : 'pending')
        } else if (verb === 'park') {
          set(checkField!, until)
        } else if (verb === 'resume') {
          clear(checkField)
          out.holds = holdsAfter({ check: false })
          if (state === 'blocked' && out.holds.length === 0) set(sf, 'pending')
        } else if (verb === 'remove-dependency') {
          const left = deps.filter((x) => x !== dep)
          set(role.dependsOn, left)
          out.holds = holdsAfter({ deps: left })
          if (state === 'blocked' && out.holds.length === 0) set(sf, 'pending')
        } else if (verb === 'hand') {
          // (D16d + J4, J6, K3) ONE write: the owner; the current conversations
          // that are not `to`'s let go (a release mark each); Silos' own wait
          // and any wait naming `to` out — every other wait stays, with its
          // B2 fact; the next check stays; the state where it really is
          set(ownerField, to)
          const marks = target[relRole!.releases]
          if (marks !== undefined && marks !== null && !Array.isArray(marks)) return `${relRole!.releases} in the file is not a list — nothing was written`
          const current = this.currentIds(this.listedIn(target, conv!), marks)
          const stays = current.filter((x) => keep.has(x))
          out.released = current.filter((x) => !keep.has(x))
          if (out.released.length > 0) {
            const iso = now.toISOString()
            target[relRole!.releases] = [
              ...(Array.isArray(marks) ? marks : []),
              ...out.released.map((x) => ({ session: x, released: true, at: iso, by: 'owner' })),
            ]
          }
          const waitGoes = wait !== null && (isSilosWait(wait) || wait.owner === to)
          if (waitGoes) clear(waitField)
          out.holds = holdsAfter(waitGoes ? { wait: false } : {})
          if (state === 'in_progress' && stays.length === 0) set(sf, 'pending')
          else if (state === 'in_review' && (waitGoes || !wait)) set(sf, 'pending')
          else if (state === 'blocked' && out.holds.length === 0) set(sf, 'pending')
        }
        this.stampOwner(l.info, raw, now.toISOString())
        this.ownWriteIn(id, key, target, held)
        return null
      },
      null,
    )
    if (!r.ok) {
      held.undo?.()
      if (r.reason === UNCHANGED) {
        const fresh = this.recordOf(l)
        return fresh ? { ok: true, value: { ...fresh, already: true, holds: [] } } : fail(500, 'the record could not be read back')
      }
      return out.refused !== null ? fail(409, out.refused, { task: out.task }) : r
    }
    // the events its parts would leave: the note first, then each field
    if (out.noted && note) {
      const at = isStr(out.noted[note.atField ?? '']) ? (out.noted[note.atField!] as string) : null
      const said = noteText.length > 120 ? `${noteText.slice(0, 117)}…` : noteText
      this.o.events.append(
        {
          silo: id,
          key,
          verb: 'append-item',
          by: 'owner',
          text: `added to ${note.coll}: ${said}`,
          detail: { coll: note.coll, digest: childDigest(out.noted, note.fields), ...(at ? { at } : {}), ...(closes ? { closes: true } : {}) },
        },
        at ? new Date(at) : new Date(),
      )
    }
    for (const s2 of out.released)
      this.o.events.append({ silo: id, key, verb: 'release', by: 'owner', text: `released ${s2} — it is history on this task (handed over)` })
    for (const [f, before, after] of out.changed)
      this.o.events.append({ silo: id, key, verb: 'set-field', by: 'owner', text: `set-field ${f}: ${valueWords(before)} → ${valueWords(after)}` })
    const ready = out.beforeRec ? nowReadyOf(child, out.beforeRec, r.value.record, recordKey(l.sr)) : null
    return {
      ok: true,
      value: { ...r.value, already: false, holds: out.holds, ...(ready ? { nowReady: ready } : {}), ...(verb === 'hand' ? { released: out.released } : {}) },
    }
  }

  // Is this task key one a rotation retired (moved to plans/closed/<month>)?
  // What the owner's reopen says instead of «no such task» (F10).
  rotatedOut(id: string, key: string): boolean {
    const a = this.active(id)
    if ('ok' in a) return false
    for (const r of this.o.kernel.reading(id)?.records ?? []) {
      const k = recordKey(r)
      if (!key.startsWith(`${k}/`)) continue
      const [coll, childId, ...rest] = key.slice(k.length + 1).split('/')
      if (!coll || !childId || rest.length > 0) continue
      if (this.retiredOf(a.manifest, r.kind, coll, r.record).has(childId)) return true
    }
    return false
  }

  // the record as the kernel reads it now (after a refresh)
  private recordOf(l: Located): SiloRecord | null {
    this.o.kernel.refresh(l.entry.id)
    return (this.o.kernel.reading(l.entry.id)?.records ?? []).find((x) => recordKey(x) === recordKey(l.sr)) ?? null
  }

  // a task's notes: the appendOnly sub-kind the owner may append to whose
  // only words are a `text` (plans: notes) — its collection, its `at` field
  // and the fields its digest covers
  private noteOf(manifest: Json, task: KindInfo): { coll: string; sub: KindInfo; atField: string | null; fields: string[] } | null {
    for (const sub of kindsOf(manifest).values()) {
      if (sub.parent?.name !== task.name || identityFieldOf(sub)) continue
      const fields = isObj(sub.spec.fields) ? sub.spec.fields : {}
      if (!('text' in fields)) continue
      const action = this.actionsOf(manifest, 'append-item').find((x) => x.subKind === sub.name)
      const by = action?.by
      if (!action || !(Array.isArray(by) ? by.includes('owner') : by === 'owner')) continue
      const env = isObj(sub.spec.envelope) ? sub.spec.envelope : {}
      if (!sub.coll) continue
      return { coll: sub.coll, sub, atField: isObj(env.at) && isStr(env.at.field) ? env.at.field : null, fields: Object.keys(fields) }
    }
    return null
  }

  // the owner's note as a child of its sub-kind (append-item's own shape:
  // its declared text judged by the reader's rule, `at` now, `by` owner) —
  // or why it can't be
  private noteItem(sub: KindInfo, text: string, now: string): Json | string {
    const fields = isObj(sub.spec.fields) ? sub.spec.fields : {}
    const f = isObj(fields.text) ? fields.text : {}
    if (typeof f.max === 'number' && text.length > f.max) return `text must be 1–${f.max} characters`
    const bad = fieldValueProblem('text', f, text)
    if (bad) return bad
    const env = isObj(sub.spec.envelope) ? sub.spec.envelope : {}
    const item: Json = { text }
    if (isObj(env.at) && isStr(env.at.field)) item[env.at.field] = now
    const ub = isObj(env.updatedBy) && isStr(env.updatedBy.field) ? env.updatedBy : null
    if (ub && (!Array.isArray(ub.values) || ub.values.includes('owner'))) item[ub.field as string] = 'owner'
    return item
  }

  // a release verb's dispose, read whole — null when it declares none (or a
  // shape the validator would refuse)
  private disposeOf(action: Json, info: KindInfo): { field: string; from: string; default: string; allowed: string[] } | null {
    const d = action.dispose
    if (!isObj(d) || !isStr(d.field) || !isStr(d.from) || !isStr(d.default) || !Array.isArray(d.allowed)) return null
    if (d.field !== this.stateFieldOf(info)) return null
    return { field: d.field, from: d.from, default: d.default, allowed: d.allowed.filter(isStr) }
  }

  // What a claim's `keep` keeps on this child, or null: its state is one the
  // verb keeps AND — when its kind declares the task role — something still
  // holds it (task-flow.ts blockedHolds, the one rule the owner's answer and
  // task mode's reopen read too): a wait naming someone, a dependency not
  // done (a missing one included), a next check still ahead. `waits` says on
  // what, in the file's words.
  private claimKeepOf(claim: Json, l: Located, cur: Json): { state: string; waits: string[] } | null {
    if (!l.child) return null
    const info = l.child.info
    const sf = this.stateFieldOf(info)
    const state = sf && isStr(cur[sf]) ? (cur[sf] as string) : null
    if (state === null || !Array.isArray(claim.keep) || !claim.keep.includes(state)) return null
    const role = info.dict.task
    if (!role) return { state, waits: [] }
    const w = role.waitingOn ? cur[role.waitingOn] : undefined
    const parent = l.via ? normChild(l.sr.record, { child: l.via }) : l.sr.record
    const siblings = parent && Array.isArray(parent[l.child.coll]) ? (parent[l.child.coll] as unknown[]).filter(isObj) : []
    const check = role.nextCheckAt ? cur[role.nextCheckAt] : undefined
    const waits = blockedHolds({
      deps: Array.isArray(cur[role.dependsOn]) ? (cur[role.dependsOn] as unknown[]).filter(isStr) : [],
      stateOf: (d) => {
        const dep = siblings.find((x) => x.id === d)
        return dep && sf && isStr(dep[sf]) ? (dep[sf] as string) : undefined
      },
      wait: isObj(w) && isStr(w.owner) ? { owner: w.owner, action: isStr(w.action) ? w.action : '' } : null,
      nextCheckAt: isStr(check) ? check : null,
      now: (this.o.now ?? (() => new Date()))().getTime(),
    })
    return waits.length > 0 ? { state, waits } : null
  }

  // the claim's `keep` on the task `key` names (claimKeepOf): what the claim
  // route says and does when the conversation is not linked (one rule)
  claimKept(id: string, key: string): { state: string; waits: string[] } | null {
    const l = this.locate(id, key)
    if ('ok' in l || !l.child) return null
    const cur = normChild(l.sr.record, l)
    const claim = cur ? (this.actionsOf(l.manifest, 'claim').find((x) => x.subKind === l.child!.info.name) ?? null) : null
    return claim && cur ? this.claimKeepOf(claim, l, cur) : null
  }

  private stateFieldOf(info: KindInfo): string | null {
    const env = isObj(info.spec.envelope) ? info.spec.envelope : {}
    return isObj(env.state) && isStr(env.state.field) ? env.state.field : null
  }

  // the conversations sub-kind of a task kind (roles.task.conversations) and
  // its id field — what a disposition counts current threads over
  private conversationsOf(manifest: Json, info: KindInfo): { coll: string; sub: KindInfo; idField: string } | null {
    const role = releaseRoleOf(info)
    if (!role) return null
    const sub = [...kindsOf(manifest).values()].find((k) => k.parent?.name === info.name && k.coll === role.conversations)
    const idField = sub ? identityFieldOf(sub) : null
    return sub && idField ? { coll: role.conversations, sub, idField } : null
  }

  // the conversation ids a raw task lists, as the reader reads them
  private listedIn(target: Json, c: { coll: string; sub: KindInfo; idField: string }): string[] {
    const lifted = collectionItems(c.sub.spec, c.coll, target, target)
    return lifted.ok ? lifted.items.map((x) => (isObj(x) ? x[c.idField] : x)).filter((x): x is string => isStr(x) && x !== '') : []
  }

  // the listed ids still current under these marks (o.currentOf — the house's
  // one rule — else the same rule over threadKey)
  private currentIds(listed: string[], releases: unknown): string[] {
    if (this.o.currentOf) return this.o.currentOf(listed, releases)
    return listed.filter((x) => this.lastMarkOf(releases, x)?.released !== true)
  }

  // The ensure-record action that rotates `coll` of `kind`, if one does.
  private rotationOf(manifest: Json, kind: string, coll: string): Json | null {
    for (const a of this.actionsOf(manifest, 'ensure-record')) {
      if (a.kind === kind && isObj(a.rotate) && a.rotate.children === coll) return a.rotate
    }
    return null
  }

  // the ids a standing record's rotation retired from `coll` — never reused
  private retiredOf(manifest: Json, kind: string, coll: string, record: Json): Set<string> {
    const rot = this.rotationOf(manifest, kind, coll)
    const list = rot && isStr(rot.retired) ? record[rot.retired] : undefined
    return new Set(Array.isArray(list) ? list.filter(isStr) : [])
  }

  // ensure-record: ONE reserved record (the action's `id`) of a top kind, in
  // a project folder the source reads (plans 0.5.0: «a task never needs a
  // plan» — New task in a project with no plans appends into its standing
  // list). Missing → born from the manifest's `seed`, written EXCLUSIVE (an
  // agent that created it a moment before keeps its file). Present → never
  // rewritten, only rotated when the action declares `rotate` and the month
  // changed since its stamp. The answer is the record as read after.
  ensureRecord(id: string, location: string, recordId: string): ActionResult<{ key: string; created: boolean; rotated: string[]; record: SiloRecord }> {
    const a = this.active(id)
    if ('ok' in a) return a
    const action = this.actionsOf(a.manifest, 'ensure-record').find((x) => x.id === recordId)
    if (!action) return fail(403, `${id} declares no ensure-record for ${recordId}`)
    const by = action.by
    if (!(Array.isArray(by) ? by.includes('owner') : by === 'owner')) return fail(403, `the owner may not ensure ${recordId}`)
    const info = isStr(action.kind) ? kindsOf(a.manifest).get(action.kind) : undefined
    if (!info || info.parent || !isObj(action.seed)) return fail(400, `${id}'s ensure-record names no top kind with a seed`)
    const sources = (Array.isArray((a.manifest.spec as Json).sources) ? ((a.manifest.spec as Json).sources as unknown[]) : []).filter(isObj)
    const src = sources.find((x) => x.root === 'project' && x.parser === 'json')
    if (!src || !isStr(src.glob)) return fail(400, `${id} has no JSON source in the project folders to make ${recordId} in`)
    const segs = src.glob.split('/').filter((x) => x !== '' && x !== '.')
    const filePat = segs.pop()!
    if (segs.some((x) => /[*?]/.test(x)) || filePat.split('*').length !== 2 || filePat.includes('?'))
      return fail(400, `the glob ${src.glob} does not name one file per record — the kernel can't place one`)
    if (!location.startsWith('folder:')) return fail(400, 'ensure a record in a project folder (folder:<path>)')
    const folder = location.slice('folder:'.length)
    if (!this.o.locations) return fail(501, 'this server does not know its project folders')
    if (!this.o.locations.projects().includes(folder)) return fail(404, `${folder} is not a project Silos reads`)
    const name = filePat.replace('*', recordId)
    const where = `${segs.join('/')}/${name}`
    const key = `${location}/${recordId}`
    let created = false
    if (!this.o.kernel.reading(id)?.records.some((r) => recordKey(r) === key)) {
      const seed = JSON.parse(JSON.stringify(action.seed)) as Json
      const rot = isObj(action.rotate) ? action.rotate : null
      if (rot && isStr(rot.stamp)) seed[rot.stamp] = this.month(0)
      const check = readRecordValue(a.manifest, info.name, seed, recordId)
      if (!check.ok) return fail(500, `the seed of ${recordId} does not read: ${check.reason}`)
      if (!existsSync(folder)) return fail(404, `${folder} is not there`)
      try {
        const dir = containedDir(folder, segs, { create: true })
        if (dir === null) return fail(409, `${segs.join('/')} could not be made in ${folder}`)
        // a file already there (an agent's, one the last reading missed) IS
        // the record — never replaced; exclusive makes the birth atomic
        if (readContained(dir, name, { maxBytes: RECORD_MAX_BYTES }) === null) {
          writeContained(dir, name, JSON.stringify(seed, null, 2) + '\n', { mode: 0o600, exclusive: true })
          created = true
        }
      } catch (err) {
        if (!(err instanceof AlreadyExistsError)) {
          if (err instanceof ContainmentError) return fail(409, err.message)
          throw err
        }
      }
      this.o.kernel.refresh(id)
      if (created) this.o.events.append({ silo: id, key, verb: 'ensure-record', by: 'owner', text: `made ${where}` })
    }
    const l = this.locate(id, key)
    if ('ok' in l) return fail(409, `${where} is in ${folder} but does not read as a ${info.name} — fix the file (the reading says why)`)
    const rotated = isObj(action.rotate) ? this.rotate(l, action.rotate) : { ok: true as const, value: [] as string[] }
    if (!rotated.ok) return rotated
    const after = (this.o.kernel.reading(id)?.records ?? []).find((x) => recordKey(x) === key)
    return after ? { ok: true, value: { key, created, rotated: rotated.value, record: after } } : fail(500, 'the record could not be read back')
  }

  // The daily sweep's rotation (plans 0.5.2, E7 «When», m7): every
  // ensure-record of this silo that declares `rotate`, over the reserved
  // record in ONE project folder — only a record that already EXISTS (the
  // sweep never makes one: a project without its list keeps having none).
  // The same rotation New task's ensure-record runs: monthly by the stamp,
  // and `retired` rebuilt from the archives whatever the stamp says.
  rotateExisting(id: string, folder: string): ActionResult<Array<{ key: string; rotated: string[] }>> {
    const a = this.active(id)
    if ('ok' in a) return a
    if (this.o.locations && !this.o.locations.projects().includes(folder)) return fail(404, `${folder} is not a project Silos reads`)
    const out: Array<{ key: string; rotated: string[] }> = []
    for (const action of this.actionsOf(a.manifest, 'ensure-record')) {
      if (!isObj(action.rotate) || !isStr(action.id)) continue
      const key = `folder:${folder}/${action.id}`
      if (!this.o.kernel.reading(id)?.records.some((r) => recordKey(r) === key)) continue
      const l = this.locate(id, key)
      if ('ok' in l) continue
      const r = this.rotate(l, action.rotate)
      if (!r.ok) return r
      out.push({ key, rotated: r.value })
    }
    return { ok: true, value: out }
  }

  // The kernel's daily sweep (wired to its tick): rotateExisting over every
  // active silo's project folders, AT MOST once per silo, folder and UTC day.
  // A failure is said in the record's events by the next try — never thrown.
  private swept = new Map<string, string>()
  rotateSweep(): Array<{ silo: string; folder: string; key: string; rotated: string[] }> {
    const out: Array<{ silo: string; folder: string; key: string; rotated: string[] }> = []
    if (!this.o.locations || !this.o.registry.list) return out
    const day = (this.o.now ?? (() => new Date()))().toISOString().slice(0, 10)
    for (const e of this.o.registry.list()) {
      if (e.status.state !== 'active' || !e.manifest) continue
      if (!this.actionsOf(e.manifest, 'ensure-record').some((x) => isObj(x.rotate))) continue
      for (const folder of this.o.locations.projects()) {
        const mark = `${e.id}\0${folder}`
        if (this.swept.get(mark) === day) continue
        this.swept.set(mark, day) // set first: a write's refresh never re-enters
        try {
          const r = this.rotateExisting(e.id, folder)
          if (r.ok) for (const x of r.value) out.push({ silo: e.id, folder, ...x })
          else console.warn(`silos: the daily rotation of ${e.id} in ${folder} waits — ${r.reason}`)
        } catch (err) {
          console.warn(`silos: the daily rotation of ${e.id} in ${folder} failed —`, err instanceof Error ? err.message : err)
        }
      }
    }
    return out
  }

  // 'YYYY-MM' of this month (0) or the one before (-1), UTC
  private month(offset: 0 | -1): string {
    const d = (this.o.now ?? (() => new Date()))()
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + offset, 1)).toISOString().slice(0, 7)
  }

  // The archives a rotation wrote (or joined) beside a standing record: every
  // file of into's folder whose name is into's with some month — their path,
  // and the ids of `coll` each holds. Bounded; an unreadable one is skipped
  // here (the rotation that writes into it refuses on its own).
  private archivesOf(folder: string, into: string, coll: string, idField: string): Array<{ name: string; ids: string[] }> {
    const path = into.split('/')
    const file = path.pop()!
    const [pre, post] = file.split('{{month}}') as [string, string]
    const esc = (x: string): string => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const re = new RegExp(`^${esc(pre)}\\d{4}-\\d{2}${esc(post ?? '')}$`)
    let dir: string | null
    try {
      dir = containedDir(folder, path, { create: false })
    } catch {
      return []
    }
    if (dir === null) return []
    let names: string[]
    try {
      names = readdirSync(dir)
        .filter((n) => re.test(n))
        .sort()
        .slice(0, 500)
    } catch {
      return []
    }
    const out: Array<{ name: string; ids: string[] }> = []
    for (const name of names) {
      try {
        const r = readContained(dir, name, { maxBytes: RECORD_MAX_BYTES })
        if (!r) continue
        const v = JSON.parse(r.data.toString('utf8')) as unknown
        if (!isObj(v) || !Array.isArray(v[coll])) continue
        out.push({
          name,
          ids: (v[coll] as unknown[])
            .filter(isObj)
            .map((c) => c[idField])
            .filter((x): x is string => isStr(x) && x !== ''),
        })
      } catch {
        /* skipped */
      }
    }
    return out
  }

  // The monthly rotation of a standing record (its stamp an earlier month,
  // or none): the children `when` names — minus any a staying child still
  // names through `keepReferencedBy` (a done blocker an open task depends
  // on, a parent that still groups) — are written to `into` with {{month}}
  // = the month just closed (a union by id over an archive already there;
  // never replaced — save that a child leaving AGAIN replaces its archived
  // copy: the live one wins), THEN leave the record, their ids appended to
  // `retired` and the stamp set to this month. A crash between the two
  // writes leaves a visible duplicate, never a loss (move-item's rule).
  //
  // plans 0.5.2 (E7): `when` reads since(…) from the journal (kernel.sinceFor
  // — the reading's own objects) and, with `undated: "old"`, a since with no
  // recorded transition counts as old; `monthStart` is this month in UTC.
  // `retired` never shrinks: whatever the stamp says, it is rebuilt as its
  // own ids ∪ the ids every archive holds (an agent's stale read→write that
  // dropped it is mended here).
  private rotate(l: Located, rot: Json): ActionResult<string[]> {
    const coll = isStr(rot.children) ? rot.children : ''
    const stamp = isStr(rot.stamp) ? rot.stamp : ''
    const retiredField = isStr(rot.retired) ? rot.retired : ''
    const into = isStr(rot.into) ? rot.into : ''
    const now = this.month(0)
    if (!coll || !stamp || !retiredField || !into.includes('{{month}}')) return fail(500, 'the rotation is not declared whole')
    const child = [...kindsOf(l.manifest).values()].find((k) => k.parent?.name === l.info.name && k.coll === coll)
    const when = isStr(rot.when) ? parseExpr(rot.when, 'predicate') : null
    if (!child || !when || !when.ok) return fail(500, "the rotation's children or when does not read")
    const env = isObj(child.spec.envelope) ? child.spec.envelope : {}
    const idField = isObj(env.id) && isStr(env.id.field) ? env.id.field : 'id'
    const folder = l.sr.location.startsWith('folder:') ? l.sr.location.slice('folder:'.length) : null
    const archived = folder ? this.archivesOf(folder, into, coll, idField).flatMap((x) => x.ids) : []
    const hadRetired = Array.isArray(l.sr.record[retiredField]) ? (l.sr.record[retiredField] as unknown[]).filter(isStr) : []
    const missing = [...new Set(archived)].filter((x) => !hadRetired.includes(x))
    const was = l.sr.record[stamp]
    const due = !(isStr(was) && was >= now)
    if (!due && missing.length === 0) return { ok: true, value: [] }
    const kids = (Array.isArray(l.sr.record[coll]) ? (l.sr.record[coll] as unknown[]) : []).filter(isObj)
    const refs = (Array.isArray(rot.keepReferencedBy) ? rot.keepReferencedBy : []).filter(isStr)
    const named = (k: Json): string[] => refs.flatMap((f) => (Array.isArray(k[f]) ? (k[f] as unknown[]).filter(isStr) : isStr(k[f]) ? [k[f] as string] : []))
    const nowMs = (this.o.now ?? (() => new Date()))().getTime()
    const since = this.o.kernel.sinceFor?.(l.entry.id)
    const undatedOld = rot.undated === 'old'
    const leaving = due
      ? new Set(
          kids
            .filter((k) =>
              testExpr(when.ast, k, {
                now: nowMs,
                dict: child.dict,
                parent: l.sr.record,
                siblings: kids,
                ...(since ? { since } : {}),
                ...(undatedOld ? { sinceUndatedIsOld: true } : {}),
              }),
            )
            .map((k) => String(k.id)),
        )
      : new Set<string>()
    // a child that stays keeps every child it names — to a fixpoint (a kept
    // done parent keeps its own parent)
    for (let changed = true; changed;) {
      changed = false
      for (const k of kids) {
        if (leaving.has(String(k.id))) continue
        for (const n of named(k)) if (leaving.delete(n)) changed = true
      }
    }
    const closed = this.month(-1)
    const archPath = into.replace(/\{\{month\}\}/g, closed)
    if (leaving.size > 0) {
      if (folder === null) return fail(400, 'only a record in a project folder rotates')
      const cur = this.readCurrent(l, null)
      if (!cur.ok) return cur
      const list = Array.isArray(cur.value.raw[coll]) ? (cur.value.raw[coll] as unknown[]) : []
      const moving = list.filter((c) => isObj(c) && leaving.has(String(c[idField]))) as Json[]
      // the archive: inside the location, never a name the source reads
      const path = archPath.split('/')
      const archName = path.pop()!
      const srcGlob = this.sourceOf(l.manifest, l.sr.source)?.glob
      const globSegs = isStr(srcGlob) ? srcGlob.split('/').filter((x) => x !== '' && x !== '.') : []
      const globFile = globSegs.pop() ?? ''
      if (path.join('/') === globSegs.join('/') && segmentRe(globFile).test(archName))
        return fail(500, 'the rotation would archive into a name the source reads as a live record')
      try {
        const dir = containedDir(folder, path, { create: true })
        if (dir === null) return fail(409, `${path.join('/')} could not be made in ${folder}`)
        const prior = readContained(dir, archName, { maxBytes: RECORD_MAX_BYTES })
        let arch: Json
        if (prior) {
          let v: unknown
          try {
            v = JSON.parse(prior.data.toString('utf8'))
          } catch {
            return fail(409, `${archPath} is not valid JSON — the rotation waits (nothing moved)`)
          }
          if (!isObj(v)) return fail(409, `${archPath} holds no record — the rotation waits (nothing moved)`)
          const have = Array.isArray(v[coll]) ? (v[coll] as unknown[]) : []
          // the live one wins: a child leaving again replaces its archived copy
          const byId = new Map(moving.map((c) => [String(c[idField]), c]))
          const kept = have.map((c) => (isObj(c) && byId.has(String(c[idField])) ? byId.get(String(c[idField]))! : c))
          const ids = new Set(have.filter(isObj).map((c) => String(c[idField])))
          arch = { ...v, [coll]: [...kept, ...moving.filter((c) => !ids.has(String(c[idField])))] }
        } else {
          // «<project> — closed <YYYY-MM>» (E7): the location's folder name
          const title = basename(folder) || (isStr(cur.value.raw.title) && cur.value.raw.title !== '' ? cur.value.raw.title : String(l.sr.record.id))
          arch = { title: `${title} — closed ${closed}`, rotatedFrom: String(l.sr.record.id), [coll]: moving }
        }
        writeContained(dir, archName, JSON.stringify(arch, null, 2) + '\n', { mode: 0o600 })
      } catch (err) {
        if (err instanceof ContainmentError) return fail(409, err.message)
        throw err
      }
    }
    const w = this.writeFile(
      l,
      (raw) => {
        if (leaving.size > 0) {
          const list = Array.isArray(raw[coll]) ? (raw[coll] as unknown[]) : []
          raw[coll] = list.filter((c) => !(isObj(c) && leaving.has(String(c[idField]))))
        }
        const had = Array.isArray(raw[retiredField]) ? (raw[retiredField] as unknown[]).filter(isStr) : []
        const add = [...leaving, ...missing].filter((x, i, all) => !had.includes(x) && all.indexOf(x) === i)
        if (add.length > 0) raw[retiredField] = [...had, ...add]
        if (due) raw[stamp] = now
        return null
      },
      null,
    )
    if (!w.ok) return w
    const noun = child.name.split('/').pop()!
    if (leaving.size > 0)
      this.o.events.append({
        silo: l.entry.id,
        key: recordKey(l.sr),
        verb: 'ensure-record',
        by: 'owner',
        text: `rotated ${leaving.size} finished ${leaving.size === 1 ? noun : `${noun}s`} to ${archPath}`,
      })
    if (missing.length > 0)
      this.o.events.append({
        silo: l.entry.id,
        key: recordKey(l.sr),
        verb: 'ensure-record',
        by: 'owner',
        text: `retired ${missing.length} ${missing.length === 1 ? 'id' : 'ids'} again from the archives (${missing.join(', ')}) — they are never reused`,
      })
    return { ok: true, value: [...leaving] }
  }

  // move-item: a child to a sibling record (same kind, same location) — the
  // verb's FIXED semantics (catalogs.md): the destination is written BEFORE
  // the source (a crash leaves a visible duplicate, never a loss), a retry is
  // idempotent (a destination already holding the child is not given a
  // second copy), and each parent's computed at is re-derived (rederiveAt).
  // The moved child is the one the source file holds NOW (re-read at move
  // time, as support-store's moveThread did — the agent may have written a
  // newer version of the thread since the last reading); `version` is the
  // CAS of the source the owner saw, `toVersion` of the destination: stale →
  // 409, nothing written.
  moveItem(
    id: string,
    childKey: string,
    toKey: string,
    opts: { version?: string | null; toVersion?: string | null } = {},
  ): ActionResult<{ from: SiloRecord; to: SiloRecord }> {
    const l = this.locate(id, childKey)
    if ('ok' in l) return l
    if (!l.child) return fail(400, 'move a child (<record key>/<collection>/<id>), not a record')
    if (l.via) return fail(400, "only a record's own children move between records")
    const child = l.child
    const sub = this.subAction(l.manifest, l.info, 'move-item', child.coll)
    if (!sub || sub.action.betweenParents !== true) return fail(403, `${l.info.name} declares no move-item for ${child.coll}`)
    if (toKey === recordKey(l.sr)) return fail(400, 'that is the record it is already in')
    const to = this.locate(id, toKey)
    if ('ok' in to) return to
    if (to.child || to.sr.kind !== l.sr.kind || to.sr.location !== l.sr.location)
      return fail(400, 'a child moves only to a sibling record — same kind, same place')
    const env = isObj(child.info.spec.envelope) ? child.info.spec.envelope : {}
    const idField = isObj(env.id) && isStr(env.id.field) ? env.id.field : 'id'
    // a child the page never showed does not exist; one it showed is moved as
    // both files hold it NOW — never as the cached reading had it
    if (!(Array.isArray(l.sr.record[child.coll]) && (l.sr.record[child.coll] as Json[]).some((c) => c.id === child.id)))
      return fail(404, `${child.coll}/${child.id} is not in ${recordKey(l.sr)}`)
    const src = this.readCurrent(l, opts.version ?? null)
    if (!src.ok) return src
    const dst = this.readCurrent(to, opts.toVersion ?? null)
    if (!dst.ok) return dst
    const fromList = this.rawCollection(l.manifest, l.sr, src.value.raw, child.coll, child.info)
    if (!fromList) return fail(409, `${child.coll} in ${recordKey(l.sr)} is not a list the kernel can write`)
    const current = fromList.find((c) => isObj(c) && c[idField] === child.id)
    if (!isObj(current)) return fail(409, `${child.coll}/${child.id} is no longer in ${recordKey(l.sr)} — read it again`)
    const moving: Json = { ...current }
    const now = new Date().toISOString()
    const rederive = (sr: SiloRecord, raw: Json): void => {
      const d = rederiveAt(l.manifest, sr.kind, raw, String(sr.record.id))
      if (d) raw[d.field] = d.value
    }
    const wroteTo = this.writeFile(
      to,
      (raw) => {
        const list = this.rawCollection(l.manifest, to.sr, raw, child.coll, child.info)
        if (!list) return `${child.coll} in ${toKey} is not a list the kernel can write`
        // a retry finds it there already: the current version replaces it, never a second copy
        const at = list.findIndex((c) => isObj(c) && c[idField] === child.id)
        raw[child.coll] = at < 0 ? [...list, moving] : list.map((c, i) => (i === at ? moving : c))
        this.stampOwner(to.info, raw, now)
        rederive(to.sr, raw)
        return null
      },
      dst.value.version,
    )
    if (!wroteTo.ok) return wroteTo
    const wroteFrom = this.writeFile(
      { ...l, child: null },
      (raw) => {
        const list = this.rawCollection(l.manifest, l.sr, raw, child.coll, child.info) ?? []
        // a lifted child leaves as an explicit (shorter) list — explicit wins over loose fields
        raw[child.coll] = list.filter((c) => !(isObj(c) && c[idField] === child.id))
        this.stampOwner(l.info, raw, now)
        rederive(l.sr, raw)
        return null
      },
      src.value.version,
    )
    if (!wroteFrom.ok) return wroteFrom
    const word = (sr: SiloRecord): string => (isStr(sr.record.identity) && sr.record.identity !== '' ? sr.record.identity : String(sr.record.id))
    this.o.events.append({ silo: id, key: recordKey(l.sr), verb: 'move-item', by: 'owner', text: `moved ${child.coll}/${child.id} to ${word(to.sr)}` })
    this.o.events.append({ silo: id, key: toKey, verb: 'move-item', by: 'owner', text: `received ${child.coll}/${child.id} from ${word(l.sr)}` })
    return { ok: true, value: { from: wroteFrom.value, to: wroteTo.value } }
  }

  // A record file's bytes, read through safe-file.ts (sixth review round):
  // its place re-verified (an agent location roots at the agent's own dir),
  // the name never a link, never a second name (hard link) of a file
  // elsewhere, never swapped mid-read. Writes go back to the same place.
  private recordBytes(l: Located): ActionResult<{ bytes: Buffer; place: { dir: string; name: string } }> {
    try {
      const place = recordPlace(l.sr.file, l.sr.rel, l.sr.location)
      const r = place === null ? null : readContained(place.dir, place.name, { maxBytes: RECORD_MAX_BYTES })
      if (place === null || r === null) return fail(409, "the record's file is gone")
      return { ok: true, value: { bytes: r.data, place } }
    } catch (err) {
      if (err instanceof ContainmentError) return fail(409, `the record is not a regular file Silos reads: ${err.message}`)
      return fail(409, "the record's file can't be read")
    }
  }

  // A record's file as it is now: its value and its CAS version (sha256 of
  // the bytes). `version` given and stale → 409, the fresh one in detail.
  private readCurrent(l: Located, version: string | null): ActionResult<{ raw: Json; version: string }> {
    const cur = this.recordBytes(l)
    if (!cur.ok) return cur
    const bytes = cur.value.bytes
    const v = sha(bytes)
    if (version !== null && v !== version) return fail(409, 'the record changed since you read it — read it again', { version: v })
    try {
      const raw = JSON.parse(bytes.toString('utf8')) as unknown
      return isObj(raw) ? { ok: true, value: { raw, version: v } } : fail(409, 'the file no longer holds a record')
    } catch {
      return fail(409, 'the file no longer holds valid JSON')
    }
  }

  // Re-read + merge + atomic replace with CAS: `version` (the sha256 the
  // owner saw) must still be the file's — else 409 and nothing is written;
  // the merged value must still read with the manifest.
  private writeFile(l: Located, mutate: (raw: Json) => string | null, version: string | null): ActionResult<SiloRecord> {
    const src = this.sourceOf(l.manifest, l.sr.source)
    if (src?.parser !== 'json') return fail(400, 'only JSON records are written in v0')
    const cur = this.recordBytes(l)
    if (!cur.ok) return cur
    const { bytes, place } = cur.value
    if (version !== null && sha(bytes) !== version) return fail(409, 'the record changed since you read it — read it again', { version: sha(bytes) })
    let raw: Json
    try {
      const v = JSON.parse(bytes.toString('utf8')) as unknown
      if (!isObj(v)) return fail(409, 'the file no longer holds a record')
      raw = v
    } catch {
      return fail(409, 'the file no longer holds valid JSON')
    }
    const err = mutate(raw)
    if (err) return fail(409, err)
    const check = readRecordValue(l.manifest, l.sr.kind, raw, l.sr.record.id)
    if (!check.ok) return fail(400, check.reason)
    if (l.child && !normChild(check.record, l)) return fail(400, `${l.child.coll}/${l.child.id} would no longer read: ${check.remarks.join('; ')}`)
    // the file must not have moved while we merged
    const again = this.recordBytes(l)
    if (!again.ok) return again
    if (sha(again.value.bytes) !== sha(bytes)) return fail(409, 'the record changed while it was being written — read it again')
    try {
      writeContained(place.dir, place.name, JSON.stringify(raw, null, 2) + '\n', { mode: 0o600 })
    } catch (err) {
      if (err instanceof ContainmentError) return fail(409, err.message)
      throw err
    }
    this.o.kernel.refresh(l.entry.id)
    const after = (this.o.kernel.reading(l.entry.id)?.records ?? []).find((x) => recordKey(x) === recordKey(l.sr))
    return after ? { ok: true, value: after } : fail(500, 'the record could not be read back')
  }

  // kernel-verb: the declared verb `name` over the record `key` of a kernel
  // source — the silo must declare it on the record's kind, the kernel kind
  // must admit it, its `when` must hold over the record as last read; then
  // the kernel's own impl does the work (and re-checks its guard on live
  // data). Owner-only: the route lets no agent through (an agent acts from
  // its own shell). The answer, said, goes to the record's story.
  async kernelVerb(
    id: string,
    key: string,
    name: string,
    impls: Readonly<Record<string, KernelVerbImpl>>,
    opts: { by?: string } = {},
  ): Promise<ActionResult<KernelVerbAnswer>> {
    const l = this.locate(id, key)
    if ('ok' in l) return l
    if (l.child) return fail(400, 'a kernel-verb acts on a record, never on a child of one')
    const verb = kernelVerb(name)
    if (!verb) return fail(404, `this kernel knows no kernel-verb ${JSON.stringify(name)}`)
    const decl = this.actionsOf(l.manifest, 'kernel-verb').find((a) => a.name === name && a.kind === l.info.name)
    if (!decl) return fail(403, `${id} declares no kernel-verb ${name} on ${l.info.name}`)
    const src = this.sourceOf(l.manifest, l.sr.source)
    const kk = src && src.root === 'kernel' ? kernelKind(String(src.kind)) : null
    if (!kk || !(kk.verbs ?? []).includes(name))
      return fail(403, `${name} does not act on ${l.info.name} — its kernel kind admits ${(kk?.verbs ?? []).join(', ') || 'no kernel-verb'}`)
    if (isStr(decl.when)) {
      const w = parseExpr(decl.when, 'predicate')
      if (w.ok && !testExpr(w.ast, l.sr.record, { now: (this.o.now?.() ?? new Date()).getTime(), dict: l.info.dict })) {
        return fail(409, `${String(l.sr.record.identity ?? key)}: ${verb.says.toLowerCase()} is not offered on it now (${decl.when})`)
      }
    }
    const impl = impls[name]
    if (!impl) return fail(503, `this Silos can't ${verb.says.toLowerCase()} here — the kernel has no ${name} on this machine`)
    const by = opts.by ?? 'owner'
    const r = await impl(String(l.sr.record.id), by)
    if (r.ok) this.noteKernelVerb(id, String(l.sr.record.id), name, by, r.value.says, key)
    try {
      this.o.kernel.refresh(id)
    } catch {
      /* read at the kernel's next pass */
    }
    return r.ok ? { ok: true, value: { ...r.value, name, key } } : r
  }

  // The event of a kernel-verb the kernel ran — also when another gesture
  // ran the same engine call (deleting a conversation with «also stop»)
  noteKernelVerb(id: string, recordId: string, name: string, by: string, says: string, key = `${PLATFORM_LOCATION}/${recordId}`): void {
    this.o.events.append({ silo: id, key, verb: 'kernel-verb', by, text: `${name}: ${says}`, detail: { name } })
  }

  ack(id: string, key: string): ActionResult<null> {
    const l = this.locate(id, key)
    if ('ok' in l) return l
    const rec = l.child ? (normChild(l.sr.record, l) ?? {}) : l.sr.record
    this.o.acks.ack(id, key, rec.state, rec.at)
    this.o.events.append({ silo: id, key, verb: 'ack', by: 'owner', text: 'seen' })
    return { ok: true, value: null }
  }

  // The agents bound to a silo's producer role — fixed by the owner at
  // approval (operator.json), or by the disk for a builtin. Only an explicit
  // binding names an agent: a role is a word of the manifest, never an agent
  // id — a silo never bound has no producer yet.
  producersOf(id: string): string[] {
    const bound = this.o.producersOf?.(id) ?? []
    const inPlay = this.o.inPlay
    return inPlay ? bound.filter((a) => inPlay(a)) : bound
  }

  // The producer of ONE record (surfaces.ts recordProducer — the board's
  // rule): the agent that wrote it while bound and in play, else the first —
  // of the record's location either way (R3).
  private producerOfRecord(id: string, anchors: { agent?: unknown }, location: string): string | undefined {
    const inPlay = this.o.inPlay
    const of = this.o.ofLocation
    return recordProducer(
      this.o.producersOf?.(id) ?? [],
      anchors,
      (a) => (inPlay ? inPlay(a) : true),
      (a) => !of || of(a, location),
    )
  }

  // A producer: one of the bound agents; with the role `any-agent` and no
  // agent bound, any agent (the skill named in `via` is its mechanism).
  private isProducer(id: string, manifest: Json, agentId: string): boolean {
    if (this.o.inPlay && !this.o.inPlay(agentId)) return false
    const p = isObj((manifest.spec as Json).producer) ? ((manifest.spec as Json).producer as Json) : {}
    const bound = this.o.producersOf?.(id)
    if (bound && bound.length > 0) return bound.includes(agentId)
    return p.role === 'any-agent'
  }

  messageAgent(id: string, key: string, template: number): ActionResult<{ messageIds: string[]; to: string[]; text: string }> {
    const l = this.locate(id, key)
    if ('ok' in l) return l
    if (!this.o.messages) return fail(501, 'messages are not available on this server')
    const action = this.actionsOf(l.manifest, 'message-agent').find((x) => x.kind === undefined || x.kind === l.info.name)
    const templates = action && Array.isArray(action.templates) ? (action.templates as unknown[]).filter(isStr) : []
    const tpl = templates[template]
    if (tpl === undefined)
      return fail(
        400,
        templates.length === 0 ? `${id} declares no message templates for ${l.info.name}` : `template ${template} does not exist (0–${templates.length - 1})`,
      )
    // the record's own producer; a record no bound agent wrote is every producer's
    const all = this.producersOf(id)
    const writer = l.sr.anchors.agent
    const to = typeof writer === 'string' && all.includes(writer) ? [writer] : all
    if (to.length === 0) {
      const bound = this.o.producersOf?.(id) ?? []
      return fail(
        409,
        bound.length > 0
          ? `the producer role of ${id} is bound to ${bound.join(', ')}, archived — no agent in play to message`
          : `the producer role of ${id} is not bound to an agent yet`,
      )
    }
    const messages = this.o.messages
    const ctx: Json = { ...l.sr.record }
    for (const [k, v] of Object.entries(ctx)) if (isMoney(v)) ctx[k] = formatMoney(v) // money reads as money
    const body = renderTemplate(tpl, ctx).text
    const name = l.entry.status.manifest.name ?? id
    const text = `${body}\n\n— composed from the record ${String(l.sr.record.identity || l.sr.record.id)} (${key}) via the silo ${name}`
    const ids: string[] = []
    for (const agent of to) {
      try {
        ids.push(messages.send({ from: 'owner', to: agent, text }).id)
      } catch (err) {
        const why = err instanceof Error ? err.message : String(err)
        if (ids.length > 0)
          this.o.events.append({
            silo: id,
            key,
            verb: 'message-agent',
            by: 'owner',
            text: `message to ${to.slice(0, ids.length).join(', ')}: ${body}`,
            detail: { messageIds: ids },
          })
        return fail(409, `${ids.length > 0 ? `sent to ${to.slice(0, ids.length).join(', ')}, but ` : ''}couldn't reach ${agent}: ${why}`)
      }
    }
    this.o.events.append({ silo: id, key, verb: 'message-agent', by: 'owner', text: `message to ${to.join(', ')}: ${body}`, detail: { messageIds: ids } })
    return { ok: true, value: { messageIds: ids, to, text } }
  }

  // make-task (what «Wake the producer now» became: no message wakes
  // anyone): the record's message, filled from a declared
  // template, becomes a TASK of the producer X in X's project list
  // (plans/tasks.plan.json, ensured — «a task never needs a plan»): its
  // title the filled line, its first note the whole text with the record's
  // ref. The gesture that follows (assign when X is On its own, «and open»
  // when Only when told) is the route's and the page's — the owner's, R1.
  // `prepare`: the route's birth stamp of an owner's task (initiative
  // prepareTask) — the values to write, or its refusal.
  makeTask(
    id: string,
    key: string,
    template: number,
    d: {
      folderOf: (agentId: string) => string | null
      prepare?: (
        taskKey: string,
        values: Record<string, unknown>,
      ) => { ok: true; values: unknown; undo: () => void } | { ok: false; code: number; error: string }
    },
  ): ActionResult<{ to: string; taskKey: string; ref: string; title: string }> {
    const l = this.locate(id, key)
    if ('ok' in l) return l
    const action = this.actionsOf(l.manifest, 'message-agent').find((x) => x.kind === undefined || x.kind === l.info.name)
    const templates = action && Array.isArray(action.templates) ? (action.templates as unknown[]).filter(isStr) : []
    const tpl = templates[template]
    if (tpl === undefined)
      return fail(
        400,
        templates.length === 0 ? `${id} declares no message templates for ${l.info.name}` : `template ${template} does not exist (0–${templates.length - 1})`,
      )
    // the record's producer — its writer, else the first in play (a task has ONE owner)
    const to = this.producerOfRecord(id, l.sr.anchors, l.sr.location)
    if (to === undefined) {
      const bound = this.o.producersOf?.(id) ?? []
      const inPlay = this.o.inPlay
      const live = bound.filter((a) => (inPlay ? inPlay(a) : true))
      return fail(
        409,
        live.length > 0
          ? `the producer role of ${id} is bound to ${live.join(', ')}, none of whom works where this record lives — bind a producer of its project`
          : bound.length > 0
            ? `the producer role of ${id} is bound to ${bound.join(', ')}, archived — no agent in play to give it to`
            : `the producer role of ${id} is not bound to an agent yet`,
      )
    }
    const folder = d.folderOf(to)
    if (!folder) return fail(409, `${to} has no folder — a task lives in its owner's project`)
    const ctx: Json = { ...l.sr.record }
    for (const [k, v] of Object.entries(ctx)) if (isMoney(v)) ctx[k] = formatMoney(v)
    const body = renderTemplate(tpl, ctx).text
    const name = l.entry.status.manifest.name ?? id
    const ref = `${String(l.sr.record.identity || l.sr.record.id)} (${key}) in the silo ${name}`
    const list = this.ensureRecord(PLANS_SILO_ID, `folder:${folder}`, STANDING_TASKS)
    if (!list.ok) return list
    const title = body.replace(/\s+/g, ' ').trim().slice(0, 300) || `${name}: ${String(l.sr.record.identity || l.sr.record.id)}`
    // creating is ONE write: the task born with its
    // note (newTask) — never a task, then a note that wakes it as fresh news
    const made = this.newTask(PLANS_SILO_ID, list.value.key, {
      title,
      owner: to,
      details: `${body}\n\n— from the record ${ref}`,
      ...(d.prepare ? { prepare: d.prepare } : {}),
    })
    if (!made.ok) return made
    const taskKey = made.value.key
    this.o.events.append({ silo: id, key, verb: 'make-task', by: 'owner', text: `a task for ${to}: ${title}`, detail: { task: taskKey } })
    return { ok: true, value: { to, taskKey, ref, title } }
  }

  // ── new: a task in ONE write ──
  //
  // The owner's new task in a plan record `planKey` (its project's list made
  // first by the route — ensure, the only step outside this write): its id
  // is assigned HERE, from the file as it is now, RAW — every id a task of
  // the file holds, readable or not (a task the reader cannot build still
  // owns its id — A1.8), and the ids its rotation retired: never reused.
  // Then, inside the same mutator, `prepare` (initiative prepareTask: the
  // birth stamp registered before the file write) with that key — its
  // refusal writes nothing and registers nothing —; the task with its
  // details as its FIRST note (the owner's, born with it: a baseline, never a
  // fresh note that wakes) and, with `session`, that conversation listed and
  // the task in progress (what the owner's link does). The events are its
  // parts': the task's append-item, the conversation's, the note's (its
  // exact `at` and digest — the owner-notes provenance, on the task's key);
  // no set-field of a birth. The shape is the stamper's (ownWrite).
  newTask(
    id: string,
    planKey: string,
    d: {
      title: string
      owner: string
      details?: string | null
      session?: string | null
      prepare?: (
        taskKey: string,
        values: Record<string, unknown>,
      ) => { ok: true; values: unknown; undo: () => void } | { ok: false; code: number; error: string }
    },
  ): ActionResult<{ key: string; id: string; record: SiloRecord }> {
    const l = this.locate(id, planKey)
    if ('ok' in l) return l
    if (l.child) return fail(400, `${planKey} is a task, not a plan — a new task lives in a plan`)
    if (this.isSync(l.manifest, l.sr.source)) return fail(400, 'over a sync source a child is never written')
    const kinds = kindsOf(l.manifest)
    const taskInfo = [...kinds.values()].find((k) => k.parent?.name === l.info.name && !!k.dict.task) ?? null
    if (!taskInfo || !taskInfo.coll) return fail(400, `${l.info.name} holds no tasks (no sub-kind declares roles.task)`)
    const coll = taskInfo.coll
    const app = this.subAction(l.manifest, l.info, 'append-item', coll)
    const by = app?.action.by
    if (!app || !(Array.isArray(by) ? by.includes('owner') : by === 'owner')) return fail(403, `the owner may not append to ${coll}`)
    const title = d.title.trim()
    if (title === '') return fail(400, 'title is required — what needs doing')
    const env = isObj(taskInfo.spec.envelope) ? taskInfo.spec.envelope : {}
    const idField = isObj(env.id) && isStr(env.id.field) ? env.id.field : 'id'
    const sf = this.stateFieldOf(taskInfo)
    const states = (Array.isArray(taskInfo.spec.states) ? taskInfo.spec.states : []).filter(isObj).map((x) => String(x.value))
    const session = isStr(d.session) && d.session.trim() !== '' ? d.session.trim() : null
    if (session && sf && !states.includes('in_progress')) return fail(400, `${taskInfo.name} has no in_progress state — a conversation can't be working it`)
    const note = isStr(d.details) && d.details.trim() !== '' ? this.noteOf(l.manifest, taskInfo) : null
    const details = isStr(d.details) ? d.details.trim() : ''
    if (details !== '' && !note) return fail(403, `${taskInfo.name} declares no notes the owner may append — its details have nowhere to land`)
    const conv = session ? this.conversationsOf(l.manifest, taskInfo) : null
    if (session && !conv) return fail(400, `${taskInfo.name} lists no conversations`)
    const fields = isObj(taskInfo.spec.fields) ? taskInfo.spec.fields : {}
    const now = (this.o.now ?? (() => new Date()))().toISOString()
    const rot = this.rotationOf(l.manifest, l.info.name, coll)
    const out: { key: string; id: string; item: Json | null; noted: Json | null; refusal: { code: number; error: string } | null; undo: (() => void) | null } =
      { key: '', id: '', item: null, noted: null, refusal: null, undo: null }
    const held: { undo: (() => void) | null } = { undo: null }
    const REFUSED = '\u0000refused'
    const r = this.writeFile(
      l,
      (raw) => {
        // the id, from the RAW file: every id a task holds, read or not, and the retired ones
        const list = Array.isArray(raw[coll]) ? (raw[coll] as unknown[]) : raw[coll] === undefined || raw[coll] === null ? [] : null
        if (list === null) return `${coll} in the file is not a list the kernel can append to`
        const ids = new Set<string>()
        for (const x of list) if (isObj(x) && isStr(x[idField])) ids.add(x[idField] as string)
        const retired = rot && isStr(rot.retired) ? raw[rot.retired] : undefined
        for (const x of Array.isArray(retired) ? retired : []) if (isStr(x)) ids.add(x)
        let n = 1
        for (const x of ids) {
          const m = /^t(\d+)$/.exec(x)
          if (m) n = Math.max(n, Number(m[1]) + 1)
        }
        while (ids.has(`t${n}`)) n++
        out.id = `t${n}`
        out.key = `${planKey}/${coll}/${out.id}`
        // the birth stamp, with THAT key — refused: nothing written, nothing registered
        let values: unknown = { [idField]: out.id, title, owner: d.owner }
        if (d.prepare) {
          const p = d.prepare(out.key, values as Record<string, unknown>)
          if (!p.ok) {
            out.refusal = { code: p.code, error: p.error }
            return REFUSED
          }
          values = p.values
          out.undo = p.undo
        }
        const v = isObj(values) ? values : {}
        const item: Json = {}
        for (const [name, f] of Object.entries(fields)) {
          let x = v[name]
          if (isStr(x)) x = x.trim()
          if (x === undefined || x === null || x === '') continue
          if (isObj(f) && typeof f.max === 'number' && isStr(x) && x.length > f.max) return `${name} must be 1–${f.max} characters`
          const bad = fieldValueProblem(name, isObj(f) ? f : {}, x)
          if (bad) return bad
          item[name] = x
        }
        item[idField] = out.id
        if (sf) item[sf] = session ? 'in_progress' : (states[0] ?? 'pending')
        const ub = isObj(env.updatedBy) && isStr(env.updatedBy.field) ? env.updatedBy : null
        if (ub && (!Array.isArray(ub.values) || ub.values.includes('owner'))) item[ub.field as string] = 'owner'
        if (note) {
          const n2 = this.noteItem(note.sub, details, now)
          if (typeof n2 === 'string') return n2
          item[note.coll] = [n2]
          out.noted = n2
        }
        if (conv && session) item[conv.coll] = [session]
        raw[coll] = [...list, item]
        this.stampOwner(l.info, raw, now)
        // it must read as a task — a child the reader drops is a task lost
        const check = readRecordValue(l.manifest, l.sr.kind, structuredClone(raw), l.sr.record.id)
        if (!check.ok || !normChild(check.record, { child: { coll, id: out.id, info: taskInfo } }))
          return `the new task would not read: ${check.ok ? check.remarks.join('; ') : check.reason}`
        out.item = item
        this.ownWriteIn(id, out.key, item, held)
        return null
      },
      null,
    )
    if (!r.ok) {
      held.undo?.()
      out.undo?.()
      return r.reason === REFUSED && out.refusal ? fail(out.refusal.code, out.refusal.error) : r
    }
    // its parts' events, in order: the task, the conversation, the note
    this.o.events.append({
      silo: id,
      key: planKey,
      verb: 'append-item',
      by: 'owner',
      text: `added to ${coll}: ${title.length > 120 ? `${title.slice(0, 117)}…` : title}`,
    })
    if (conv && session) this.o.events.append({ silo: id, key: out.key, verb: 'append-item', by: 'owner', text: `added to ${conv.coll}: ${session}` })
    if (out.noted && note) {
      const at = note.atField && isStr(out.noted[note.atField]) ? (out.noted[note.atField] as string) : null
      const said = details.length > 120 ? `${details.slice(0, 117)}…` : details
      this.o.events.append(
        {
          silo: id,
          key: out.key,
          verb: 'append-item',
          by: 'owner',
          text: `added to ${note.coll}: ${said}`,
          detail: { coll: note.coll, digest: childDigest(out.noted, note.fields), ...(at ? { at } : {}) },
        },
        at ? new Date(at) : new Date(),
      )
    }
    return { ok: true, value: { key: out.key, id: out.id, record: r.value } }
  }

  resolveConflict(id: string, key: string, field: string, choice: 'keep-mine' | 'take-source'): ActionResult<SiloRecord> {
    const a = this.active(id)
    if ('ok' in a) return a
    const r = this.o.kernel.resolveConflict(id, key, field, choice)
    if (!r.ok) return fail(404, r.reason)
    this.o.events.append({
      silo: id,
      key,
      verb: 'conflict-resolved',
      by: 'owner',
      text: choice === 'keep-mine' ? `kept your ${field} over the sync` : `took the sync's ${field}`,
    })
    return { ok: true, value: r.record }
  }

  events(id: string, key?: string): SiloEvent[] {
    return this.o.events.list(id, key)
  }

  proposals(id: string): SiloProposal[] {
    return this.o.proposals.list(id)
  }

  proposal(pid: string): SiloProposal | null {
    return this.o.proposals.get(pid)
  }

  // ── the producer's side (bearer routes) ──

  // agent-record-write: the producer writes one record in ITS agent state.
  agentWrite(
    id: string,
    agentId: string,
    recordId: string,
    value: unknown,
    opts: { version?: string | null } = {},
  ): ActionResult<{ file: string; key: string; record: SiloRecord['record'] }> {
    const a = this.active(id)
    if ('ok' in a) return a
    if (!this.isProducer(id, a.manifest, agentId)) return fail(403, `${agentId} is not a producer of ${id}`)
    const kinds = kindsOf(a.manifest)
    const top = [...kinds.values()].find((k) => !k.parent)!
    if (!this.actionsOf(a.manifest, 'agent-record-write').some((x) => x.kind === top.name))
      return fail(403, `${id} declares no agent-record-write for ${top.name}`)
    const src = (Array.isArray((a.manifest.spec as Json).sources) ? ((a.manifest.spec as Json).sources as unknown[]) : [])
      .filter(isObj)
      .find((s) => s.root === 'agent-state')
    if (!src || !isStr(src.glob) || src.parser !== 'json') return fail(400, `${id} has no JSON source in an agent's state to write into`)
    const segs = src.glob.split('/').filter((x) => x !== '' && x !== '.')
    const filePat = segs.pop()!
    if (segs.some((x) => /[*?]/.test(x)) || filePat.split('*').length !== 2 || filePat.includes('?'))
      return fail(400, `the glob ${src.glob} does not name one file per record — the kernel can't place a write`)
    const env = isObj(top.spec.envelope) && isObj(top.spec.envelope.id) ? top.spec.envelope.id : {}
    let charset: RegExp
    try {
      charset = new RegExp(isStr(env.charset) ? env.charset : '^[A-Za-z0-9][A-Za-z0-9_-]*$')
    } catch {
      return fail(400, "the manifest's record id charset is not a valid pattern")
    }
    if (!charset.test(recordId) || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(recordId)) return fail(400, `${JSON.stringify(recordId)} is not a valid record id`)
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(agentId)) return fail(400, 'invalid agent id')
    const file = join(this.o.agentStateBase, agentId, ...segs, filePat.replace('*', recordId))
    if (!isObj(value)) return fail(400, 'the record must be a JSON object')
    let next: Json = value
    // read and write only through safe-file.ts: the REAL directory under the
    // agent's own state, every component checked (contained-dir.ts), the
    // record a regular single-link file never opened through a link
    // (sixth review round: a hard link merged another file into the record)
    let dirNow: string | null
    try {
      dirNow = agentDir(this.o.agentStateBase, agentId, segs, { create: false })
    } catch (err) {
      if (err instanceof ContainmentError) return fail(409, err.message)
      throw err
    }
    if (dirNow !== null) {
      let cur: ReturnType<typeof readContained>
      try {
        cur = readContained(dirNow, basename(file), { maxBytes: RECORD_MAX_BYTES })
      } catch (err) {
        if (err instanceof ContainmentError) return fail(409, `the record is not a regular file Silos reads: ${err.message}`)
        return fail(409, "the record's file can't be read")
      }
      if (cur !== null) {
        const bytes = cur.data
        if (opts.version != null && sha(bytes) !== opts.version)
          return fail(409, 'the record changed since you read it — read it again', { version: sha(bytes) })
        try {
          const v = JSON.parse(bytes.toString('utf8')) as unknown
          if (isObj(v)) next = mergeAppendOnly(top, v, value)
        } catch {
          /* an unreadable file is replaced whole */
        }
      }
    }
    const check = readRecordValue(a.manifest, top.name, next, recordId)
    if (!check.ok) return fail(422, check.reason)
    try {
      const dir = agentDir(this.o.agentStateBase, agentId, segs, { create: true, mode: 0o700 })!
      writeContained(dir, basename(file), JSON.stringify(next, null, 2) + '\n', { mode: 0o600 })
    } catch (err) {
      if (err instanceof ContainmentError) return fail(409, err.message)
      throw err
    }
    // one coalesced re-read for a burst of writes (a first sync), not one per record
    if (this.o.kernel.refreshSoon) this.o.kernel.refreshSoon(id)
    else this.o.kernel.refresh(id)
    const key = `agent:${agentId}/${recordId}`
    this.o.events.append({ silo: id, key, verb: 'agent-record-write', by: agentId, text: `${agentId} wrote ${recordId}` })
    return { ok: true, value: { file, key, record: check.record } }
  }

  // The merged view for the producer — only the records its location lets it
  // read on disk (its own agent state; a project folder of its territories).
  // The installed manifest's sync contract travels with it (the producer
  // normalizes by the stateMap the owner approved).
  agentSync(id: string): { service: unknown; stateMap: unknown; version: string | null } | null {
    const e = this.o.registry.get(id)
    const p = e?.manifest && isObj((e.manifest.spec as Json).producer) ? ((e.manifest.spec as Json).producer as Json) : null
    return p && isObj(p.sync) ? { service: p.sync.service ?? null, stateMap: p.sync.stateMap ?? null, version: e!.status.manifest.version } : null
  }

  agentMerged(id: string, agentId: string): ActionResult<Array<{ key: string; id: string; raw: Json; overlay: unknown }>> {
    const a = this.active(id)
    if ('ok' in a) return a
    if (!this.isProducer(id, a.manifest, agentId)) return fail(403, `${agentId} is not a producer of ${id}`)
    this.o.kernel.flush?.(id) // the latest, writes included
    return {
      ok: true,
      value: this.o.kernel
        .mergedView(id)
        .filter((m) => this.o.agentMayReadLocation(agentId, m.location))
        .map((m) => ({ key: m.key, id: String(m.record.id), raw: m.raw, overlay: m.overlay })),
    }
  }

  // The producer proposes an owner field change; the owner decides.
  propose(id: string, agentId: string, key: string, field: string, value: unknown, note: string | null): ActionResult<SiloProposal> {
    // judged on the key alone, before the lookup (silos/bearer-scope.ts): a
    // proposal carries the record's standing value, so another agent's
    // record is never located for this bearer — the same words either way
    const outside = this.outsideBearer(id, agentId, key)
    if (outside) return outside
    const l = this.locate(id, key)
    if ('ok' in l) return l
    if (!this.isProducer(id, l.manifest, agentId)) return fail(403, `${agentId} is not a producer of ${id}`)
    if (!this.isSync(l.manifest, l.sr.source) || l.child)
      return fail(400, 'proposals are for owner fields over a sync source — on its own records the producer writes directly')
    const action = this.actionsOf(l.manifest, 'set-field').find((x) => x.kind === l.info.name)
    const writable = Array.isArray(l.info.spec.ownerWritable) ? l.info.spec.ownerWritable : []
    if (!action || !isObj(action.fields) || !isObj(action.fields[field]) || !writable.includes(field))
      return fail(403, `${field} is not an owner field of ${l.info.name}`)
    const standing = Object.fromEntries(Object.entries(l.sr.overlay ?? {}).map(([f, x]) => [f, x.value]))
    const raw = isObj(l.sr.raw) ? l.sr.raw : {}
    const check = readRecordValue(l.manifest, l.sr.kind, { ...raw, ...standing, [field]: value }, l.sr.record.id)
    if (!check.ok) return fail(400, check.reason)
    const from = field in standing ? standing[field] : raw[field]
    const p = this.o.proposals.create({
      silo: id,
      key,
      verb: 'set-field',
      field,
      from,
      to: value,
      by: agentId,
      note: note && note.trim() !== '' ? note.slice(0, 500) : null,
    })
    this.o.events.append({ silo: id, key, verb: 'proposal', by: agentId, text: proposalLine(p), detail: { proposal: p.id } })
    return { ok: true, value: p }
  }

  decide(proposalId: string, choice: 'approve' | 'reject', reason: string | null): ActionResult<SiloProposal> {
    const p = this.o.proposals.get(proposalId)
    if (!p) return fail(404, 'no such proposal')
    if (p.status !== 'pending') return fail(409, `the proposal is already ${p.status}`)
    const now = new Date().toISOString()
    if (choice === 'reject') {
      const done: SiloProposal = { ...p, status: 'rejected', decidedAt: now, ...(reason && reason.trim() !== '' ? { reason: reason.slice(0, 500) } : {}) }
      this.o.proposals.save(done)
      this.o.events.append({
        silo: p.silo,
        key: p.key,
        verb: 'proposal-rejected',
        by: 'owner',
        text: `${proposalLine(p)} · rejected by owner${done.reason ? `: ${done.reason}` : ''}`,
        detail: { proposal: p.id },
      })
      return { ok: true, value: done }
    }
    const r = this.setField(p.silo, p.key, p.field, p.to, { by: 'owner', quiet: true })
    if (!r.ok) {
      const failed: SiloProposal = { ...p, status: 'failed', decidedAt: now, reason: r.reason }
      this.o.proposals.save(failed)
      this.o.events.append({
        silo: p.silo,
        key: p.key,
        verb: 'proposal-approved',
        by: 'owner',
        text: `${proposalLine(p)} · approved by owner — but it could not run: ${r.reason}`,
        detail: { proposal: p.id },
      })
      return fail(r.code, r.reason, failed)
    }
    const done: SiloProposal = { ...p, status: 'approved', decidedAt: now }
    this.o.proposals.save(done)
    this.o.events.append({
      silo: p.silo,
      key: p.key,
      verb: 'proposal-approved',
      by: 'owner',
      text: `${proposalLine(p)} · approved by owner`,
      detail: { proposal: p.id },
    })
    return { ok: true, value: done }
  }

  // Pending proposals as Needs-you rows (surfaces.ts takes them in).
  proposalsNeedsYou(id: string): SiloNeedsYou[] {
    const entry = this.o.registry.get(id)
    if (!entry || entry.status.state !== 'active') return []
    const records = this.o.kernel.reading(id)?.records ?? []
    return this.o.proposals
      .list(id)
      .filter((p) => p.status === 'pending')
      .map((p) => {
        const r = records.find((x) => recordKey(x) === p.key)
        const identity = r && isStr(r.record.identity) && r.record.identity !== '' ? r.record.identity : p.key.split('/').pop()!
        return {
          kind: 'silo' as const,
          reason: 'proposal' as const,
          silo: id,
          siloName: entry.status.manifest.name ?? id,
          key: p.key,
          recordKind: r?.kind ?? '',
          urgency: 'due' as const,
          text: `${identity} — ${proposalLine(p)}`,
          at: p.at,
          agentId: p.by,
          file: r?.file ?? null,
          proposal: { id: p.id, by: p.by, verb: p.verb, field: p.field, from: p.from, to: p.to },
        }
      })
  }
}

// «set-field state: open → paid · proposed by finance»
export function proposalLine(p: Pick<SiloProposal, 'verb' | 'field' | 'from' | 'to' | 'by'>): string {
  return `${p.verb} ${p.field}: ${valueWords(p.from)} → ${valueWords(p.to)} · proposed by ${p.by}`
}

// A producer's write over an existing record: appendOnly sub-kinds keep what
// the file already holds — the union by the keys writeMerge names, ordered by
// its sort key (support's «union(at,by,text) ordered by at» — the manifest's own words).
// a silo whose producer role is any agent (plans: team-plan in every agent)
function anyAgentProduces(manifest: Json): boolean {
  const spec = isObj(manifest.spec) ? manifest.spec : {}
  return isObj(spec.producer) && spec.producer.role === 'any-agent'
}

export function mergeAppendOnly(top: KindInfo, current: Json, next: Json): Json {
  const out: Json = { ...next }
  const subs = isObj(top.spec.subKinds) ? top.spec.subKinds : {}
  for (const [name, sub] of Object.entries(subs)) {
    if (!isObj(sub) || sub.appendOnly !== true) continue
    const coll = (isStr(sub.path) ? sub.path : name).replace(/\[\]$/, '')
    const wm = isStr(sub.writeMerge) ? sub.writeMerge : ''
    const keys =
      /union\(([^)]*)\)/
        .exec(wm)?.[1]
        ?.split(',')
        .map((k) => k.trim())
        .filter(Boolean) ?? null
    const sortBy = /(?:ordered by|sorted by)\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(wm)?.[1] ?? null
    const a = Array.isArray(current[coll]) ? (current[coll] as unknown[]) : []
    const b = Array.isArray(next[coll]) ? (next[coll] as unknown[]) : []
    const keyOf = (x: unknown): string => (isObj(x) && keys ? JSON.stringify(keys.map((k) => x[k] ?? null)) : JSON.stringify(x))
    const seen = new Set<string>()
    const merged: unknown[] = []
    for (const x of [...a, ...b]) {
      const k = keyOf(x)
      if (seen.has(k)) continue
      seen.add(k)
      merged.push(x)
    }
    if (sortBy) merged.sort((x, y) => String(isObj(x) ? (x[sortBy] ?? '') : '').localeCompare(String(isObj(y) ? (y[sortBy] ?? '') : '')))
    out[coll] = merged
  }
  return out
}
