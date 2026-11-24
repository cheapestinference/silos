// silos/voice.ts — how a silo's records are SAID: the kinds of a manifest
// with their dictionaries, and the exact words of a row, a cell, a money
// amount. One voice for the validator's preview (Task 7), the needs-you rows
// and pulse (Task 9) and the records routes (Task 8 paints them) — what the
// preview promises is what Home says.
import { dictionaryForKind, evaluate, isMoney, parse, sum, type EvalEnv, type Expr, type FieldDict } from './expressions.js'
import { formatMoment, pluralOf } from './freshness.js'
import { taskFlow, type TaskEnv, type TaskFlow } from './task-flow.js'

type Json = Record<string, unknown>
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)
const isStr = (v: unknown): v is string => typeof v === 'string'

// ── kinds and their dictionaries ────────────────────────────────────────────

export interface KindInfo {
  name: string
  spec: Json
  dict: FieldDict
  parent?: KindInfo
  coll?: string
}

export function kindsOf(manifest: Json): Map<string, KindInfo> {
  const out = new Map<string, KindInfo>()
  const kinds = isObj(manifest.spec) && isObj(manifest.spec.kinds) ? manifest.spec.kinds : {}
  // a kind's sub-kinds, and theirs (depth ≤ 2: the dictionary stops there)
  const addSubs = (info: KindInfo, spec: Json): void => {
    for (const [s, sub] of Object.entries(isObj(spec.subKinds) ? spec.subKinds : {})) {
      if (!isObj(sub)) continue
      const coll = (isStr(sub.path) ? sub.path : s).replace(/\[\]$/, '')
      const child = info.dict.collections[coll]
      if (!child) continue
      const ci: KindInfo = { name: `${info.name}/${s}`, spec: sub, dict: child, parent: info, coll }
      out.set(ci.name, ci)
      addSubs(ci, sub)
    }
  }
  for (const [k, spec] of Object.entries(kinds)) {
    if (!isObj(spec)) continue
    const { dict } = dictionaryForKind(k, spec)
    const info: KindInfo = { name: k, spec, dict }
    out.set(k, info)
    addSubs(info, spec)
  }
  return out
}

// The kind a needs-you entry is about: the schema gives it none —
// the pulse's kind, else the silo's only kind.
export function needsYouKind(manifest: Json): string | null {
  const spec = manifest.spec as Json
  const surfaces = isObj(spec.surfaces) ? spec.surfaces : {}
  if (isObj(surfaces.pulse) && isStr(surfaces.pulse.kind)) return surfaces.pulse.kind
  const kinds = isObj(spec.kinds) ? Object.keys(spec.kinds) : []
  return kinds.length === 1 ? kinds[0]! : null
}

// ── formatting the preview ──────────────────────────────────────────────────

// one formatter per currency, built once (a per-call NumberFormat is the
// costly part of saying an amount); a currency Intl refuses is remembered too
const moneyFormats = new Map<string, Intl.NumberFormat | null>()
export function formatMoney(m: { amount: number; currency: string }): string {
  let f = moneyFormats.get(m.currency)
  if (f === undefined) {
    try {
      f = new Intl.NumberFormat('en-US', { style: 'currency', currency: m.currency })
    } catch {
      f = null
    }
    if (moneyFormats.size < 256) moneyFormats.set(m.currency, f) // the file's words are bounded here, never the memory
  }
  return f ? f.format(m.amount) : `${m.amount} ${m.currency}`
}

export function labelOne(rec: Json): string {
  const l = rec.stateLabel
  return isObj(l) && isStr(l.one) ? l.one : isStr(rec.state) ? rec.state : ''
}

// A column over a sub-kind's children (catalog extension): `count(threads)` — how many; `last(notes)` — the last
// one's identity, said with who wrote it when its envelope maps updatedBy
// («owner: refund approved»). null = not such a column.
export const CHILD_COLUMN = /^(count|last)\(([A-Za-z_][A-Za-z0-9_]*)\)$/
export function childColumn(name: string): { agg: 'count' | 'last'; coll: string } | null {
  const m = CHILD_COLUMN.exec(name)
  return m ? { agg: m[1] as 'count' | 'last', coll: m[2]! } : null
}

// A field's declared presentation (fieldSpec `label` / `unit`): the
// words a column header and the record page say it by, and the unit its
// number is said with. `at` is said by the field the envelope maps it to.
function fieldSpecOf(info: KindInfo, name: string): Json | null {
  const fields = isObj(info.spec.fields) ? info.spec.fields : {}
  const env = isObj(info.spec.envelope) ? info.spec.envelope : {}
  const real = name === 'at' && isObj(env.at) && isStr(env.at.field) ? env.at.field : name
  return isObj(fields[real]) ? (fields[real] as Json) : null
}
export function labelOfField(info: KindInfo, name: string): string | null {
  const s = fieldSpecOf(info, name)
  return s && isStr(s.label) && s.label.trim() !== '' ? s.label : null
}
export function unitOf(info: KindInfo, name: string): string | null {
  const s = fieldSpecOf(info, name)
  return s && s.type === 'number' && isStr(s.unit) && s.unit !== '' ? s.unit : null
}

export function cell(name: string, rec: Json, info: KindInfo, anchors: Json): string {
  if (name === 'identity') return isStr(rec.identity) && rec.identity !== '' ? rec.identity : '—'
  if (name === 'state') return labelOne(rec) || '—'
  // a kernel record carries its agent as a field, not a location (task-wake,
  // execution): the anchor first, then the kind's own field of that name
  if (name === 'agent' || name === 'folder')
    return isStr(anchors[name]) ? (anchors[name] as string) : isStr(rec[name]) && rec[name] !== '' ? (rec[name] as string) : '—'
  const child = childColumn(name)
  if (child) {
    const kids = (Array.isArray(rec[child.coll]) ? (rec[child.coll] as unknown[]) : []).filter(isObj)
    if (child.agg === 'count') return String(kids.length)
    const last = kids.at(-1)
    if (!last) return '—'
    const text = isStr(last.identity) && last.identity !== '' ? last.identity : String(last.id ?? '')
    return isStr(last.updatedBy) && last.updatedBy !== '' ? `${last.updatedBy}: ${text}` : text || '—'
  }
  const v = name.split('.').reduce<unknown>((cur, seg) => (isObj(cur) ? cur[seg] : undefined), rec)
  if (v === undefined || v === null || v === '') return '—'
  if (isMoney(v)) return formatMoney(v)
  // a number field that declares its unit says it (catalogs.md, «Field
  // types»: `unit`) — «41.5 %», «1,240 MB»; without one, as it is
  const unit = unitOf(info, name)
  if (typeof v === 'number' && Number.isFinite(v) && unit !== null) return `${v.toLocaleString('en-US', { maximumFractionDigits: 1 })} ${unit}`
  const type = info.dict.fields[name]?.type
  if ((type === 'timestamp' || name === 'at') && isStr(v)) return formatMoment(v)
  return isStr(v) || typeof v === 'number' || typeof v === 'boolean' ? String(v) : '—'
}

// «2 tasks of Writer and 1 of Finance» — what finishing a task hands out, grouped
// per agent in the plan's order (the native plan row's words: nine
// merge gates sat invisible among thirty identical rows until each said it)
export function unblocksWords(unblocks: ReadonlyArray<{ owner: string }>, nameOf: (id: string) => string = (id) => id): string {
  const counts = new Map<string, number>()
  for (const u of unblocks) counts.set(u.owner, (counts.get(u.owner) ?? 0) + 1)
  const parts = [...counts].map(([owner, n], i) => (i === 0 ? `${n} task${n === 1 ? '' : 's'} of ${nameOf(owner)}` : `${n} of ${nameOf(owner)}`))
  return parts.length <= 1 ? parts.join('') : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`
}

// «F2026-0401 · Acme SL — outstanding · due Nov 1»; the due role's `word`
// (step 2) says a future that is not a deadline: «… · resets Nov 1, 05:00 UTC»;
// a task that gates an agent's work says what it hands out («… · unblocks 1
// task of Writer»), and one with a declared
// waitingOn says who it waits on, in the file's words («… · waits on you:
// Decide (A) resume or (B) park») — `flow` carries the kernel's task flow
// when the caller has it (a bare `gate` says «an agent waits on it»).
//
// People (with `isAgent` to tell them): «you» is only `owner`.
// A task a person other than the owner holds is said as theirs («Sam's OK to
// publish — pending · unblocks 1 task of Writer»). An AGENT's task stopped on a
// person leads with the question when the wait writes `asked` («Finance asks:
// publish today? — Publish the post»; «Writer asks Sam: …» toward another
// person), and with who waits on whom toward another person without it
// («Writer waits on Sam: send the glossary — Translate»).
export function rowOf(
  rec: Json,
  info: KindInfo,
  flow?: { gate?: boolean; unblocks?: ReadonlyArray<{ owner: string }>; waitsOn?: { owner: string; action: string; asked?: string } | null },
  nameOf?: (id: string) => string,
  isAgent?: (v: string) => boolean,
): string {
  const role = isObj(info.spec.roles) && isObj(info.spec.roles.due) ? info.spec.roles.due : null
  const due = role && isStr(role.field) ? rec[role.field] : undefined
  const word = role && isStr(role.word) && role.word !== '' ? role.word : 'due'
  const name = nameOf ?? ((id: string) => id)
  const person = (id: string): string => (id === 'owner' ? 'you' : name(id))
  const gate =
    flow?.unblocks && flow.unblocks.length > 0 ? ` · unblocks ${unblocksWords(flow.unblocks, nameOf)}` : flow?.gate === true ? ' · an agent waits on it' : ''
  const dueTail = isStr(due) && due !== '' ? ` · ${word} ${formatMoment(due)}` : ''
  const identity = isStr(rec.identity) && rec.identity !== '' ? rec.identity : '—'
  const ownerField = info.dict.task?.owner
  const holder = ownerField && isStr(rec[ownerField]) ? (rec[ownerField] as string).trim() : ''
  const w = flow?.waitsOn
  const asked = w && isStr(w.asked) && w.asked.trim() !== '' ? w.asked.trim() : null
  if (w && isAgent && holder !== '' && isAgent(holder) && !isAgent(w.owner) && (asked !== null || w.owner !== 'owner')) {
    const lead =
      asked !== null
        ? `${name(holder)} asks${w.owner === 'owner' ? '' : ` ${name(w.owner)}`}: ${asked}`
        : `${name(holder)} waits on ${name(w.owner)}${w.action !== '' ? `: ${w.action}` : ''}`
    return `${lead} — ${identity}${gate}${dueTail}`
  }
  const theirs = isAgent && holder !== '' && holder !== 'owner' && !isAgent(holder) ? `${name(holder)}'s ` : ''
  const waits = w ? ` · waits on ${person(w.owner)}${asked !== null ? `: ${asked}` : w.action !== '' ? `: ${w.action}` : ''}` : ''
  return `${theirs}${identity} — ${labelOne(rec)}${waits}${gate}${dueTail}`
}

// ── records of a kind, predicates over them, the pulse term ─────────────────

// One record as the surfaces see it: a sub-kind's records carry their parent
// and siblings (predicates read parent.<…> and refs), and every record its key.
export interface KindRecord {
  rec: Json
  anchors: Json
  key: string
  // the silo location the record was read from (`folder:<f>`, `agent:<id>`,
  // …) — a sub-kind's is its parent's. A task's flow judges its owner
  // against it (task-flow.ts owner-outside-project)
  location?: string
  file: string | null
  parent?: Json
  parentKey?: string // the parent record's key (a sub-kind's)
  siblings?: Json[]
  source?: string // the source the top-level record was read from (its journal's convention)
  // the top-level kind the record was read as (a silo may hold several: the
  // System silo's processes and worktrees) — absent: the silo's one kind
  kind?: string
  // a sub-kind's record: the ids of the siblings
  // its parent's FILE holds that the reader could not build — a dependency
  // on one is guarded by A1.8's row, never blocker-missing (task-flow.ts)
  unreadableSiblings?: string[]
  // a top-level record: those ids, per collection — what recordsOfKind
  // hands its children as unreadableSiblings (baseRecordOf builds it)
  unreadableChildren?: Record<string, string[]>
}

// A reading's record as the voice's base (top-level) record — the ONE
// builder (every site that reads a silo's records as KindRecords): its
// children the reader could not build are named by collection, from its
// remarks «<coll>[i] is not read: …» and the file's raw entry's `id`.
const NOT_READ = /^([A-Za-z_][A-Za-z0-9_]*)\[(\d+)\] is not read: /
export function baseRecordOf(
  r: { record: Json; anchors: unknown; location: string; file: string; source?: string; kind?: string | null; remarks?: readonly string[]; raw?: unknown },
  o: { source?: boolean } = {},
): KindRecord {
  const out: KindRecord = {
    rec: r.record,
    anchors: r.anchors as Json,
    key: `${r.location}/${String(r.record.id)}`,
    location: r.location,
    file: r.file || null,
    ...(o.source && r.source !== undefined ? { source: r.source } : {}),
    ...(typeof r.kind === 'string' && r.kind !== '' ? { kind: r.kind } : {}),
  }
  const raw = isObj(r.raw) ? r.raw : {}
  const by: Record<string, string[]> = {}
  for (const m of r.remarks ?? []) {
    const hit = NOT_READ.exec(m)
    if (!hit) continue
    const list = Array.isArray(raw[hit[1]!]) ? (raw[hit[1]!] as unknown[]) : []
    const item = list[Number(hit[2])]
    if (isObj(item) && isStr(item.id) && item.id !== '') (by[hit[1]!] ??= []).push(item.id)
  }
  if (Object.keys(by).length > 0) out.unreadableChildren = by
  return out
}

// The records of `kindName` from the top-level ones: a sub-kind's live in
// their parents' collections, keyed `<parent key>/<collection>/<id>` — a
// task's note `<plan key>/tasks/<task>/notes/<index>` (depth ≤ 2).
export function recordsOfKind(kinds: Map<string, KindInfo>, base: readonly KindRecord[], kindName: string): KindRecord[] {
  const info = kinds.get(kindName)
  if (!info) return []
  // a silo with several top-level kinds: each kind's records are its own
  // (System's Processes and Worktrees once listed each other's rows)
  if (!info.parent) return base.filter((b) => b.kind === undefined || b.kind === info.name)
  return recordsOfKind(kinds, base, info.parent.name).flatMap((b) => {
    const kids = (Array.isArray(b.rec[info.coll!]) ? b.rec[info.coll!] : []) as Json[]
    const unread = b.unreadableChildren?.[info.coll!]
    return kids.filter(isObj).map((k) => ({
      rec: k,
      anchors: b.anchors,
      key: `${b.key}/${info.coll}/${String(k.id)}`,
      ...(b.location !== undefined ? { location: b.location } : {}),
      file: b.file,
      parent: b.rec,
      parentKey: b.key,
      siblings: kids,
      ...(b.source !== undefined ? { source: b.source } : {}),
      ...(unread ? { unreadableSiblings: unread } : {}),
    }))
  })
}

// `taskEnv`: the live facts a task's flow reads at request time (G4) —
// isLive(session) and wakes(agent); absent, nothing is live, nobody wakes.
// `nameOf`: an agent's name as the house says it (a row names who waits)
export interface Voice {
  now: number
  isAgent?: (v: string) => boolean
  since?: EvalEnv['since']
  taskEnv?: TaskEnv
  nameOf?: (id: string) => string
}

export function envFor(info: KindInfo, p: KindRecord, v: Voice): EvalEnv {
  return {
    now: v.now,
    dict: info.dict,
    ...(p.parent ? { parent: p.parent } : {}),
    ...(p.siblings ? { siblings: p.siblings } : {}),
    ...(v.isAgent ? { isAgent: v.isAgent } : {}),
    ...(v.since ? { since: v.since } : {}),
    ...(v.taskEnv ? { taskEnv: v.taskEnv } : {}),
    // the record's key: `idle` as a predicate sees the
    // wakes queued for THIS task exactly as flowOf does
    key: p.key,
    ...(p.location !== undefined ? { location: p.location } : {}),
    ...(p.unreadableSiblings ? { unreadableSiblings: p.unreadableSiblings } : {}),
  }
}

export function terminalsOf(info: KindInfo): Set<string> {
  return new Set(
    (Array.isArray(info.spec.states) ? info.spec.states : [])
      .filter(isObj)
      .filter((s) => s.terminal === true)
      .map((s) => String(s.value)),
  )
}

const parsed = new Map<string, Expr | null>()
function predicate(src: string): Expr | null {
  if (!parsed.has(src)) {
    const r = parse(src, 'predicate')
    parsed.set(src, r.ok ? r.ast : null)
  }
  return parsed.get(src)!
}

// A predicate over one record; an absent predicate holds, one that does not
// parse never does (the validator refuses it before it gets here).
export function holds(src: unknown, info: KindInfo, p: KindRecord, v: Voice): boolean {
  if (!isStr(src)) return true
  const ast = predicate(src)
  return ast !== null && evaluate(ast, p.rec, envFor(info, p, v)) === true
}

// The kernel's task flow of one record (task-flow.ts), when its kind declares
// roles.task — null otherwise. Read with the record's siblings and the
// request's live facts, never cached.
export function flowOf(info: KindInfo, p: KindRecord, v: Voice): TaskFlow | null {
  if (!info.dict.task) return null
  return taskFlow(p.rec, p.siblings ?? [], info.dict, {
    now: v.now,
    key: p.key,
    ...(p.location !== undefined ? { location: p.location } : {}),
    ...(v.isAgent ? { isAgent: v.isAgent } : {}),
    ...(v.taskEnv ? { taskEnv: v.taskEnv } : {}),
    ...(p.unreadableSiblings ? { unreadableSiblings: p.unreadableSiblings } : {}),
  })
}

// What Task mode carries of a task's flow (task-mode/engine.ts taskSnapshots):
// its stall (cause, the first stuck task down its chain and — A2.5 — its
// seat; null when it is not stalled), and idle, waitsStart and live, so
// the engine's readers (assign, the heartbeat's facts) READ the kernel's
// words instead of deriving them again; `asked` (B2): Silos carries its wait
// on an agent (an ask linked and in reach — flow.asked).
export interface TaskFlowFacts {
  cause: string | null
  by: string | null
  at: string | null
  idle: boolean
  waitsStart: boolean
  live: boolean
  asked: boolean
}

// Every record of a kind that declares roles.task, with its flow facts,
// keyed by the record key — at the time of the voice; never written.
export function taskFlowRecords(manifest: Json, base: readonly KindRecord[], v: Voice): Map<string, TaskFlowFacts> {
  const out = new Map<string, TaskFlowFacts>()
  const kinds = kindsOf(manifest)
  for (const info of kinds.values()) {
    if (!info.dict.task) continue
    for (const r of recordsOfKind(kinds, base, info.name)) {
      const f = flowOf(info, r, v)
      if (!f) continue
      const st = f.stalled && f.stalledCause !== null
      out.set(r.key, {
        cause: st ? f.stalledCause : null,
        by: st ? f.stalledBy : null,
        at: st ? f.stalledAt : null,
        idle: f.idle,
        waitsStart: f.waitsStart,
        live: f.live,
        asked: f.asked !== null,
      })
    }
  }
  return out
}

// The row of one record as Home says it: rowOf, plus what the task flow's
// gate hands out when the kind declares roles.task — ONE place, so the
// validator's preview, the needs-you rows and the list say the same words
export function sayRow(info: KindInfo, p: KindRecord, v: Voice): string {
  const f = flowOf(info, p, v)
  return rowOf(p.rec, info, f ? { gate: f.gate, unblocks: f.unblocks, waitsOn: f.waitsOn } : undefined, v.nameOf, v.isAgent)
}

// The pulse term of a silo, over its LIVE records and the whole set:
// «€12,400 outstanding» (one term per currency, never mixed), «3 cases».
// null when the silo asks for no pulse; '' when there is nothing to say
// (a count of zero, a sum over nothing) — Home leaves empty parts out.
export function pulseTerm(manifest: Json, kinds: Map<string, KindInfo>, base: readonly KindRecord[], v: Voice): string | null {
  const spec = isObj(manifest.spec) ? manifest.spec : {}
  const surfaces = isObj(spec.surfaces) ? spec.surfaces : {}
  if (!isObj(surfaces.pulse)) return null
  const p = surfaces.pulse
  const info = kinds.get(String(p.kind))
  if (!info) return null
  const term = terminalsOf(info)
  const live = recordsOfKind(kinds, base, info.name).filter((x) => !term.has(String(x.rec.state)) && holds(p.when, info, x, v))
  const label = isObj(p.label) ? p.label : {}
  if (p.aggregate === 'sum' && isStr(p.field)) {
    const { totals } = sum(
      live.map((x) => x.rec),
      p.field,
    )
    const word = isStr(label.term) ? label.term : isStr(label.many) ? label.many : ''
    return totals.map((t) => `${formatMoney(t)}${word ? ` ${word}` : ''}`).join(' · ')
  }
  const n = live.length
  if (n === 0) return ''
  const noun = info.name.split('/').pop()!
  const word = n === 1 ? (isStr(label.one) ? label.one : noun) : isStr(label.many) ? label.many : pluralOf(noun)
  return `${n} ${word}`
}
