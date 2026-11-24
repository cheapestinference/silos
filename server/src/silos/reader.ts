// silos/reader.ts — the declarative reader of a `files` source (Silo
// Standard v0 «The record envelope»). A manifest says where
// the records live and how their fields map; this turns every matched file
// into a NORMALIZED record — the envelope names resolved (id, identity,
// state, at, updatedBy, anchors) next to the kind's fields, children under
// their collection name, computed fields derived AT READ (never written) — or
// into an explanation that names the field that fails, in plain words (the
// explainCase pattern of support-store.ts, generalized). An unreadable record
// never disappears: it is listed with its reason.
//
// Tolerances are declarative, not heroic: field aliases, conditioned aliases
// (`accept: single-email-string`), `fallback` chains, `empty` values, and
// `lift` — a loose field or a string raised to a minimal child with what the
// file says (empty, never invented). Unknown fields are preserved.
//
// The reader only READS. Sub-kinds' writeMerge is carried for the writer
// (Task 10); nothing here writes a record.
import { ContainmentError, readContained } from '../safe-file.js'
import { parse as parseYaml } from 'yaml'
import { dictionaryForKind, evaluate, isMoney, type EvalEnv, type FieldDict } from './expressions.js'
import type { OverlayField } from './overlay.js'
import {
  confineGlob,
  conventionFolders,
  recordPlace,
  RECORD_MAX_BYTES,
  scanSource,
  segmentRe,
  stemOf,
  type Location,
  type MatchedFile,
  type SiloLocations,
  type SourceSpec,
} from './files-source.js'
import { kernelFeeds, kernelKind, type KernelKindSources } from './kernel-kinds.js'

// The location key of every record a kernel source holds: platform data
// — no agent, no folder. Record keys read
// `platform/<id>`, the journal's and the acks' unit like any other.
export const PLATFORM_LOCATION = 'platform'

type Json = Record<string, unknown>
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)
const isStr = (v: unknown): v is string => typeof v === 'string'
const blank = (v: unknown): boolean => v === undefined || v === null || v === ''
const show = (v: unknown): string => JSON.stringify(v ?? null)
// ONE address, nothing around it — the same rule as support-store's EMAIL
const EMAIL = /^[^\s@()<>,;:"]+@[^\s@()<>,;:"]+\.[^\s@()<>,;:"]+$/
const DEFAULT_ID_CHARSET = '^[A-Za-z0-9][A-Za-z0-9_-]*$'

// ── output ──────────────────────────────────────────────────────────────────

// task: the plans record key of the task a kernel record hangs from
export interface Anchors {
  agent?: string
  folder?: string
  task?: string
}

// A normalized record: what evaluate() reads and what every surface paints.
export type NormalizedRecord = Json & { id: string; identity: string }

export interface SiloRecord {
  silo: string
  kind: string // unqualified kind name ('invoice'); qualified = `${silo}/${kind}`
  source: string
  file: string // absolute path
  rel: string // relative to its location
  location: string // Location.key
  anchors: Anchors
  mtimeMs: number
  raw: unknown // the file's parsed value — what an overlay merges over
  record: NormalizedRecord
  // what is said about a record that still reads: a computed field that
  // ignores its homonym on disk, a child that could not be read…
  remarks: string[]
  // collections where at least one child could not be read: what they hold
  // is not the whole list (the journal never reads a skipped child as removed)
  partial: string[]
  // the owner's overlay standing over this record (sync sources): per field,
  // the owner's value, the sealed base, and a conflict when the source moved
  overlay?: Record<string, OverlayField>
}

export interface UnreadableRecord {
  silo: string
  kind: string | null
  source: string
  file: string
  rel: string
  location: string
  id: string | null // the id the file name gives, when it gives one
  reason: string // the field that fails, in plain words
}

export interface SiloReading {
  records: SiloRecord[]
  unreadable: UnreadableRecord[]
  lastWrite: string | null // newest mtime among the matched files (freshness)
  // per source: its own newest file write and newest record `at` (freshness
  // speaks per source: «no new … since <newestAt> · … last wrote <lastWrite>»)
  sources: Record<string, { lastWrite: string | null; newestAt: string | null }>
  truncated: string[] // caps that stopped a walk, said
  problems: string[] // manifest-level reasons nothing could be read
}

export interface ReadEnv {
  now?: number
  isAgent?: (value: string) => boolean // `is human` / actor resolution
}

// ── templates ───────────────────────────────────────────────────────────────

const PLACEHOLDER = /\{\{\s*([^}]*?)\s*\}\}/g
const FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/

function valueText(v: unknown): string {
  if (isStr(v)) return v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  if (isMoney(v)) return `${v.amount} ${v.currency}`
  return ''
}

function lookup(ctx: Json, path: string): unknown {
  let cur: unknown = ctx
  for (const seg of path.split('.')) {
    if (!isObj(cur)) return undefined
    cur = cur[seg]
  }
  return cur
}

// `{{a}}` and `{{a || b}}` (first non-blank). In a string lift, a placeholder
// that is not a field name stands for the lifted string itself (the
// reference manifests write `{{the string}}`).
export function renderTemplate(tpl: string, ctx: Json, liftedString?: string): { text: string; blanks: number } {
  let blanks = 0
  const text = tpl.replace(PLACEHOLDER, (_m, expr: string) => {
    for (const alt of expr.split('||').map((s) => s.trim())) {
      if (!FIELD_NAME.test(alt)) {
        if (liftedString !== undefined) return liftedString
        continue
      }
      const t = valueText(lookup(ctx, alt))
      if (t !== '') return t
    }
    blanks++
    return ''
  })
  return { text, blanks }
}

function identityOf(spec: Json | undefined, ctx: Json): string {
  const tpl = isStr(spec?.template) ? spec.template : ''
  const first = renderTemplate(tpl, ctx)
  if (first.blanks === 0 || !isStr(spec?.empty)) return first.text.trim()
  const alt = renderTemplate(spec.empty, ctx)
  // the fallback only if it says more than the template did
  return (alt.blanks < first.blanks || first.text.trim() === '' ? alt.text : first.text).trim()
}

// ── field resolution ────────────────────────────────────────────────────────

type Kinded = { kind: 'value'; v: unknown } | { kind: 'error'; reason: string }

function typeName(v: unknown): string {
  return Array.isArray(v) ? 'n array' : v === null ? ' null' : isObj(v) ? 'n object' : ` ${typeof v}`
}

function checkType(name: string, spec: Json, v: unknown, mayBeEmpty: boolean): string | null {
  const type = isStr(spec.type) ? spec.type : 'string'
  switch (type) {
    case 'string':
    case 'email':
    case 'url':
    case 'path':
    case 'attachment':
    case 'actor':
      if (!isStr(v)) return `${name} must be text (found a${typeName(v)})`
      if (type === 'email' && !EMAIL.test(v.trim())) return `${name} ${show(v)} is not a single email address`
      if (typeof spec.max === 'number' && v.length > spec.max) return `${name} is longer than ${spec.max} characters`
      if (Array.isArray(spec.oneOf) && !spec.oneOf.includes(v)) return `${name} ${show(v)} is not one of ${spec.oneOf.join('/')}`
      return null
    case 'timestamp':
      if (!isStr(v)) return `${name} must be a date (found a${typeName(v)})`
      if (v === '' && mayBeEmpty) return null
      if (Number.isNaN(Date.parse(v))) return `${name} ${show(v)} is not a date`
      return null
    case 'money':
      return isMoney(v) ? null : `${name} must be money as {amount, currency} (found ${isStr(v) ? show(v) : `a${typeName(v)}`})`
    case 'boolean':
      return typeof v === 'boolean' ? null : `${name} must be true or false (found ${show(v)})`
    case 'number':
      return typeof v === 'number' && Number.isFinite(v) ? null : `${name} must be a number (found ${isStr(v) ? show(v) : `a${typeName(v)}`})`
    case 'object':
      return isObj(v) ? null : `${name} must be an object (found ${isStr(v) ? show(v) : `a${typeName(v)}`})`
    default:
      if (type.startsWith('refs(')) return Array.isArray(v) && v.every(isStr) ? null : `${name} must be a list of ids`
      return null
  }
}

// One declared field: the value, through aliases → fallback → empty, or the
// reason it can't be read. `resolved` holds the fields already resolved (a
// fallback names one of them).
function resolveField(name: string, spec: Json, raw: Json, resolved: Json): Kinded | null {
  let v = raw[name]
  const aliasNames: string[] = []
  let refusedAlias: { field: string; value: unknown } | null = null
  if (blank(v) && Array.isArray(spec.aliases)) {
    for (const a of spec.aliases) {
      if (isStr(a)) {
        aliasNames.push(a)
        if (!blank(raw[a])) {
          v = raw[a]
          break
        }
      } else if (isObj(a) && isStr(a.field)) {
        const av = raw[a.field]
        if (av === undefined) continue
        if (a.accept === 'single-email-string' && isStr(av) && EMAIL.test(av.trim())) {
          v = av
          break
        }
        refusedAlias = { field: a.field, value: av }
      }
    }
  }
  if (blank(v) && Array.isArray(spec.fallback)) {
    for (const f of spec.fallback)
      if (isStr(f) && !blank(resolved[f] ?? raw[f])) {
        v = resolved[f] ?? raw[f]
        break
      }
  }
  if (blank(v) && spec.empty !== undefined) v = spec.empty
  const type = isStr(spec.type) ? spec.type : 'string'
  // an empty email, or an empty date, is no value at all
  const missing = v === undefined || v === null || (v === '' && (type === 'email' || type === 'timestamp'))
  if (missing) {
    if (spec.required !== true) return null
    if (refusedAlias) {
      // «customerEmail» found as `customer` → «the customer's email»: a
      // field named after its alias says whose it is (support's own words)
      const alias = refusedAlias.field
      const rest = name.startsWith(alias) && name.length > alias.length ? name.slice(alias.length) : null
      const whose = rest ? `${alias}'s ${rest[0]!.toLowerCase()}${rest.slice(1)}` : name
      const what = isStr(refusedAlias.value) ? 'which is not a single email address' : `a${typeName(refusedAlias.value)} — which of its fields is the ${whose}?`
      return { kind: 'error', reason: `missing ${name} (found \`${refusedAlias.field}\`, ${what})` }
    }
    return { kind: 'error', reason: `missing ${name}${aliasNames.length > 0 ? ` (or ${aliasNames.join(', ')})` : ''}` }
  }
  const bad = checkType(name, spec, v, false)
  if (bad) return { kind: 'error', reason: bad }
  if (spec.normalize === 'trim-lowercase' && isStr(v)) v = v.trim().toLowerCase()
  return { kind: 'value', v }
}

// ── one record of a kind (or sub-kind) ──────────────────────────────────────

interface KindCtx {
  name: string // 'case', 'plan/task'
  spec: Json
  dict: FieldDict
  parent?: Json // the normalized parent (sub-kinds)
}

type Built = { ok: true; record: NormalizedRecord; remarks: string[]; partial: string[] } | { ok: false; reason: string }

const ENVELOPE_NAMES = new Set(['id', 'identity', 'state', 'at', 'updatedBy'])

// `fileId`: the id the file name gives (kinds read from a file); `index`:
// the position in the parent's list (sub-kinds without an id of their own).
function build(ctx: KindCtx, raw: unknown, fileId: string | null, index: number | null, env: ReadEnv): Built {
  if (!isObj(raw)) return { ok: false, reason: fileId !== null ? 'not a JSON object' : 'is not an object' }
  const spec = ctx.spec
  const envl = isObj(spec.envelope) ? spec.envelope : {}
  const remarks: string[] = []
  const partial: string[] = []

  // id
  const idSpec = isObj(envl.id) ? envl.id : {}
  let id: string
  if (fileId !== null && idSpec.from === 'filename') {
    let charset: RegExp
    try {
      charset = new RegExp(isStr(idSpec.charset) ? idSpec.charset : DEFAULT_ID_CHARSET)
    } catch {
      return { ok: false, reason: `the manifest's record id charset ${show(idSpec.charset)} is not a valid pattern` }
    }
    if (!charset.test(fileId)) return { ok: false, reason: `the file name gives the id ${show(fileId)}, which is not a valid record id` }
    const names = Array.isArray(idSpec.mustMatchField) ? idSpec.mustMatchField.filter(isStr) : []
    if (names.length > 0) {
      const key = names.find((k) => raw[k] !== undefined)
      if (key === undefined) return { ok: false, reason: `missing ${names[0]} (the file name says ${show(fileId)})` }
      if (raw[key] !== fileId)
        return { ok: false, reason: `${key === names[0] ? key : `${names[0]} (as \`${key}\`)`} ${show(raw[key])} does not match the file name ${show(fileId)}` }
    }
    id = fileId
  } else if (isStr(idSpec.field)) {
    const v = raw[idSpec.field]
    if (!isStr(v) || v === '') return { ok: false, reason: `missing ${idSpec.field}` }
    id = v
  } else {
    id = fileId ?? String(index ?? 0)
  }

  // declared fields, in the order the manifest lists them
  const fields = isObj(spec.fields) ? spec.fields : {}
  const resolved: Json = {}
  for (const [name, fspec] of Object.entries(fields)) {
    const r = resolveField(name, isObj(fspec) ? fspec : {}, raw, resolved)
    if (r === null) continue
    if (r.kind === 'error') return { ok: false, reason: r.reason }
    resolved[name] = r.v
  }

  // state
  const states = Array.isArray(spec.states) ? spec.states.filter(isObj) : []
  const stateValues = states.map((s) => s.value).filter(isStr)
  const stSpec = isObj(envl.state) ? envl.state : null
  let state: string | undefined
  if (stSpec && isStr(stSpec.field)) {
    const v = raw[stSpec.field]
    if (!isStr(v) || !stateValues.includes(v)) return { ok: false, reason: `${stSpec.field} ${show(v)} is not one of ${stateValues.join('/')}` }
    state = v
  }

  // at — the written field, its fallbacks, or the parent's
  const atSpec = isObj(envl.at) ? envl.at : null
  let at: string | null = null
  if (atSpec) {
    const candidates = [atSpec.field, ...(Array.isArray(atSpec.fallback) ? atSpec.fallback : [])].filter(isStr)
    for (const f of candidates) {
      const v = resolved[f] ?? raw[f]
      if (isStr(v) && v !== '') {
        at = v
        break
      }
    }
    if (at === null && atSpec.inherit === 'parent.at') at = isStr(ctx.parent?.at) ? ctx.parent.at : null
    if (at === null) {
      const v = isStr(atSpec.field) ? raw[atSpec.field] : undefined
      if (v === '' && atSpec.mayBeEmpty === true) at = ''
      else if (v !== undefined && v !== null && !isStr(v)) return { ok: false, reason: `${atSpec.field as string} must be a date (found a${typeName(v)})` }
      else if (atSpec.inherit === undefined && atSpec.mayBeEmpty !== true && candidates.length > 0) {
        return { ok: false, reason: `missing ${candidates[0]}${candidates.length > 1 ? ` (or ${candidates.slice(1).join(', ')})` : ''}` }
      }
    }
    if (at !== null && at !== '' && Number.isNaN(Date.parse(at)))
      return { ok: false, reason: `${isStr(atSpec.field) ? atSpec.field : 'at'} ${show(at)} is not a date` }
  } else if (ctx.parent) {
    at = isStr(ctx.parent.at) ? ctx.parent.at : null
  }

  // updatedBy — never invented: the field, else the declared fallback, else null
  const ubSpec = isObj(envl.updatedBy) ? envl.updatedBy : null
  let updatedBy: string | null = null
  if (ubSpec && ubSpec.absent !== 'unknown' && isStr(ubSpec.field)) {
    const v = raw[ubSpec.field]
    const values = Array.isArray(ubSpec.values) ? ubSpec.values.filter(isStr) : null
    const ok = isStr(v) && v !== '' && (values === null || values.includes(v))
    if (ok) updatedBy = v
    else if (isStr(ubSpec.fallback)) updatedBy = ubSpec.fallback
    else if (!blank(v)) return { ok: false, reason: `${ubSpec.field} ${show(v)} is not one of ${values?.join('/') ?? 'the declared values'}` }
  }

  // unknown fields preserved; known ones as resolved; envelope names win
  const record: Json = { ...raw, ...resolved }
  for (const f of Object.keys(fields)) if (!(f in resolved)) delete record[f]
  record.id = id
  if (state !== undefined) record.state = state
  record.at = at
  record.updatedBy = updatedBy

  // sub-kinds (children), then identity, then computed fields
  const subs = isObj(spec.subKinds) ? spec.subKinds : {}
  for (const [subName, subSpec] of Object.entries(subs)) {
    if (!isObj(subSpec)) continue
    const coll = (isStr(subSpec.path) ? subSpec.path : subName).replace(/\[\]$/, '')
    const childDict = ctx.dict.collections[coll]
    if (!childDict) continue
    const kids = buildChildren({ name: `${ctx.name}/${subName}`, spec: subSpec, dict: childDict, parent: record }, coll, raw, record, env)
    if (!kids.ok) return { ok: false, reason: kids.reason }
    record[coll] = kids.children
    remarks.push(...kids.skipped, ...kids.carried)
    if (kids.skipped.length > 0) partial.push(coll)
  }
  record.identity = identityOf(isObj(envl.identity) ? envl.identity : undefined, record)

  const computedNotes = applyComputed(ctx, record, raw, env, undefined, partial)
  remarks.push(...computedNotes.notes)
  if (computedNotes.error) return { ok: false, reason: computedNotes.error }

  // the state label: its plain word, or a labelOverride's
  if (isStr(record.state)) {
    const st = states.find((s) => s.value === record.state)
    let label: unknown = st?.label
    for (const o of ctx.dict.labelOverrides) {
      if (o.ast && evaluate(o.ast, record, evalEnv(ctx, record, env, undefined, partial)) === true) {
        label = { one: o.label, many: o.label, override: true }
        break
      }
    }
    record.stateLabel = label ?? null
  }
  return { ok: true, record: record as NormalizedRecord, remarks, partial }
}

function evalEnv(ctx: KindCtx, record: Json, env: ReadEnv, siblings?: Json[], partial?: readonly string[]): EvalEnv {
  return {
    ...(partial && partial.length > 0 ? { partial: new Set(partial) } : {}),
    now: env.now ?? Date.now(),
    dict: ctx.dict,
    ...(ctx.parent ? { parent: ctx.parent } : {}),
    ...(siblings ? { siblings } : {}),
    ...(env.isAgent ? { isAgent: env.isAgent } : {}),
  }
}

// Computed fields of the record (kind level: after its children exist). A
// value written in the file under a computed name is ignored, and said.
// Sub-kinds' computed fields run in buildChildren, where siblings are known.
function applyComputed(
  ctx: KindCtx,
  record: Json,
  raw: Json,
  env: ReadEnv,
  siblings?: Json[],
  partial?: readonly string[],
): { notes: string[]; error?: string } {
  const notes: string[] = []
  const authoritativeAt = authoritativeAtField(ctx.spec)
  for (const [name, c] of Object.entries(ctx.dict.computed)) {
    if (!c.ast) continue
    // the at field written authoritative: the file's value stands at read
    // (expressions.md «except with at.written: authoritative»); the formula is
    // what move-item re-derives into it (rederiveAt)
    if (name === authoritativeAt) continue
    const v = evaluate(c.ast, record, evalEnv(ctx, record, env, siblings, partial))
    if (name === 'state' && c.context === 'state') {
      const values = (Array.isArray(ctx.spec.states) ? ctx.spec.states : []).filter(isObj).map((s) => s.value)
      if (!isStr(v) || !values.includes(v)) return { notes, error: `the computed state gave ${show(v)}, which is not one of ${values.join('/')}` }
      if (raw.state !== undefined && raw.state !== v) notes.push(`state is computed — the value written in the file (${show(raw.state)}) is ignored`)
      record.state = v
      continue
    }
    if (raw[name] !== undefined && !ENVELOPE_NAMES.has(name)) notes.push(`${name} is computed — the value written in the file is ignored`)
    record[name] = v
  }
  return { notes }
}

// The at field a kind writes authoritative AND declares a formula for: the
// file's value stands at read; the kernel re-derives it when a gesture moves
// the children it aggregates (catalogs.md move-item: «the parent's computed fields
// are recalculated» — what support-store's moveThread did with latestActivity).
function authoritativeAtField(spec: Json): string | null {
  const env = isObj(spec.envelope) ? spec.envelope : {}
  const at = isObj(env.at) ? env.at : {}
  const computed = isObj(spec.computed) ? spec.computed : {}
  return at.written === 'authoritative' && isStr(at.field) && isStr(computed[at.field]) ? at.field : null
}

// That formula over a raw value (the file as it will be written): the field
// and its new value, or null when the kind declares none or it gives nothing.
export function rederiveAt(manifest: Json, kind: string, raw: Json, fileId: string | null, env: ReadEnv = {}): { field: string; value: string } | null {
  const spec = isObj(manifest.spec) && isObj(manifest.spec.kinds) && isObj(manifest.spec.kinds[kind]) ? (manifest.spec.kinds[kind] as Json) : null
  if (!spec) return null
  const field = authoritativeAtField(spec)
  if (!field) return null
  const dict = dictFor(manifest, kind, spec)
  const c = dict.computed[field]
  if (!c?.ast) return null
  const b = build({ name: kind, spec, dict }, raw, fileId, null, env)
  if (!b.ok) return null
  const v = evaluate(c.ast, b.record, { now: env.now ?? Date.now(), dict, ...(b.partial.length > 0 ? { partial: new Set(b.partial) } : {}) })
  return isStr(v) && v !== '' ? { field, value: v } : null
}

// The items of a sub-kind's collection as the reader sees them, BEFORE each
// is built: the explicit list (a string item lifted when the sub-kind
// declares `lift`, kept as it is when not), a whole-list string lifted, or —
// with no list at all — one item lifted from the parent's loose fields when
// the sub-kind's own id resolves from them. Shared with the kernel's writes
// (actions.ts), so a gesture writes exactly the children the page showed —
// a loose `threadId` is a thread on both sides of a move.
//
// A STRING (an item of an explicit list, or the whole list) is lifted only
// when the lift USES the string — a placeholder that is not a field name
// (support's notes: «{{the string}}»). A lift that only reads the parent's
// loose fields (support's threads: `{{threadId || thread_id}}`) is about the
// loose field, never about a string item: lifting one turned
// "loose-string-item" into {threadId:"",…} and a move wrote that back, the
// text gone. Such an item is kept as it is — the reader names it in the
// parent's remarks and every write puts it back untouched.
function liftUsesString(synth: Json): boolean {
  return Object.values(synth).some(
    (tpl) => isStr(tpl) && [...tpl.matchAll(PLACEHOLDER)].some((m) => m[1]!.split('||').some((alt) => !FIELD_NAME.test(alt.trim()))),
  )
}
export function collectionItems(
  subSpec: Json,
  coll: string,
  raw: Json,
  parentRecord: Json,
): { ok: true; items: unknown[]; lifted: boolean } | { ok: false; reason: string } {
  const lift = isObj(subSpec.lift) ? subSpec.lift : null
  const synth = lift && isObj(lift.synthesize) ? lift.synthesize : null
  const stringSynth = synth && liftUsesString(synth) ? synth : null
  const fromString = (s: string): Json | null => {
    if (!stringSynth || s.trim() === '') return null
    const o: Json = {}
    for (const [k, tpl] of Object.entries(stringSynth)) if (isStr(tpl)) o[k] = renderTemplate(tpl, parentRecord, s).text
    return o
  }
  const value = raw[coll]
  if (Array.isArray(value)) {
    return {
      ok: true,
      lifted: stringSynth !== null && value.some(isStr),
      items: value.flatMap((v) => (isStr(v) ? (stringSynth ? [fromString(v)].filter((x) => x !== null) : [v]) : [v])),
    }
  }
  if (isStr(value)) {
    if (!synth) return { ok: false, reason: `${coll} is not an array` }
    // a lift that doesn't use the string: the string is an item kept as it is
    if (!stringSynth) return { ok: true, lifted: false, items: [value] }
    const one = fromString(value)
    return { ok: true, lifted: true, items: one ? [one] : [] }
  }
  if (value !== undefined && value !== null) return { ok: false, reason: `${coll} is not an array` }
  const idField = isObj(subSpec.envelope) && isObj(subSpec.envelope.id) && isStr(subSpec.envelope.id.field) ? subSpec.envelope.id.field : null
  if (synth && idField && isStr(synth[idField])) {
    const ctxRec: Json = { ...raw, ...parentRecord }
    const idText = renderTemplate(synth[idField] as string, ctxRec).text
    if (idText !== '') {
      const o: Json = {}
      for (const [k, tpl] of Object.entries(synth)) {
        if (!isStr(tpl)) continue
        const t = renderTemplate(tpl, ctxRec).text
        // empty, never invented — an optional field the file never gave stays absent
        const fspec = isObj(subSpec.fields) && isObj(subSpec.fields[k]) ? (subSpec.fields[k] as Json) : null
        if (t === '' && fspec?.optional === true) continue
        o[k] = t
      }
      return { ok: true, lifted: true, items: [o] }
    }
  }
  // a sub-kind with no id of its own (a task's notes) lifts one item from
  // the parent's loose field when a field its lift names holds a value — a
  // lift whose templates name no field
  // that is there lifts nothing (support's notes: only a string is lifted)
  if (synth && !idField) {
    const ctxRec: Json = { ...raw, ...parentRecord }
    if (Object.values(synth).some((tpl) => isStr(tpl) && namesAFieldThatHolds(tpl, ctxRec))) {
      const o: Json = {}
      for (const [k, tpl] of Object.entries(synth)) if (isStr(tpl)) o[k] = renderTemplate(tpl, ctxRec).text
      return { ok: true, lifted: true, items: [o] }
    }
  }
  return { ok: true, lifted: false, items: [] }
}

function namesAFieldThatHolds(tpl: string, ctx: Json): boolean {
  return [...tpl.matchAll(PLACEHOLDER)].some((m) =>
    m[1]!
      .split('||')
      .map((x) => x.trim())
      .some((alt) => FIELD_NAME.test(alt) && valueText(lookup(ctx, alt)) !== ''),
  )
}

// A value the owner is about to write into a declared field, judged by the
// reader's own rule (type, oneOf, max) — the same words a file that held it
// would get. null = it reads.
export function fieldValueProblem(name: string, spec: Json, v: unknown): string | null {
  return checkType(name, spec, v, false)
}

// `carried`: what a child's own build said about ITS children (a task's note
// that could not be read — depth 2), named with the child so the record's
// remarks say it; it does not make this collection partial (the child reads)
type ChildrenBuilt = { ok: true; children: Json[]; skipped: string[]; carried: string[] } | { ok: false; reason: string }

// A collection: the explicit list wins; a string (the whole list, or an item)
// is lifted when the sub-kind declares `lift`; an absent list is lifted from
// the parent's loose fields when the sub-kind's own id resolves from them.
function buildChildren(ctx: KindCtx, coll: string, raw: Json, parentRecord: Json, env: ReadEnv): ChildrenBuilt {
  const lifted = collectionItems(ctx.spec, coll, raw, parentRecord)
  if (!lifted.ok) return lifted
  const items = lifted.items
  // A child that can't be read never takes its parent down and never
  // vanishes in silence: it stays out of the collection and the parent's
  // remarks name it with its field.
  const children: Json[] = []
  const rawOf: Json[] = []
  const partialOf: string[][] = []
  const skipped: string[] = []
  const carried: string[] = []
  for (const [i, item] of items.entries()) {
    const b = build(ctx, item, null, i, env)
    if (!b.ok) {
      skipped.push(`${coll}[${i}] is not read: ${b.reason}`)
      continue
    }
    children.push(b.record)
    rawOf.push(isObj(item) ? item : {})
    partialOf.push(b.partial)
    // a grandchild that could not be read (depth 2) is said on the record
    for (const r of b.remarks) if (/^[A-Za-z_][A-Za-z0-9_]*\[\d+\] /.test(r)) carried.push(`${coll}[${i}] (${String(b.record.id)}): ${r}`)
  }
  // the children's computed fields see their siblings (refs), their parent
  // and which of their own collections are not whole
  for (const [i, child] of children.entries()) {
    const r = applyComputed(ctx, child, rawOf[i]!, env, children, partialOf[i])
    if (r.error) skipped.push(`${coll}[${i}] ${r.error}`)
  }
  return { ok: true, children, skipped, carried }
}

// ── parsers ─────────────────────────────────────────────────────────────────

export function parseFile(text: string, parser: 'json' | 'md-frontmatter'): { value: unknown } | { error: string } {
  if (parser === 'json') {
    try {
      return { value: JSON.parse(text) }
    } catch (err) {
      return { error: `not valid JSON: ${err instanceof Error ? err.message : String(err)}` }
    }
  }
  // md-frontmatter: a leading --- block of YAML; the rest is `body`
  const m = /^﻿?---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text)
  if (!m) return { error: 'no frontmatter — the file must start with a --- block' }
  try {
    const fm = parseYaml(m[1]!, { schema: 'core', maxAliasCount: 0 }) as unknown
    if (fm !== null && !isObj(fm)) return { error: 'the frontmatter is not a set of key: value fields' }
    return { value: { ...(fm ?? {}), body: m[2] } }
  } catch (err) {
    return { error: `the frontmatter is not valid YAML: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}` }
  }
}

// ── the silo ────────────────────────────────────────────────────────────────

// The dictionaries a kind's evaluation needs (computed fields and
// labelOverrides parsed once), cached per manifest object — a re-loaded
// manifest is a new object.
function kindDict(name: string, spec: Json): FieldDict {
  return dictionaryForKind(name, spec).dict
}

const dictCache = new WeakMap<object, Map<string, FieldDict>>()
function dictFor(manifest: Json, kind: string, spec: Json): FieldDict {
  let m = dictCache.get(manifest)
  if (!m) {
    m = new Map()
    dictCache.set(manifest, m)
  }
  let d = m.get(kind)
  if (!d) {
    d = kindDict(kind, spec)
    m.set(kind, d)
  }
  return d
}

// One record of a kind from an already-parsed value — the reader's unit, also
// what the validator (Task 7) runs over `examples`.
export function readRecordValue(manifest: Json, kind: string, value: unknown, fileId: string | null, env: ReadEnv = {}): Built {
  const spec = isObj(manifest.spec) && isObj(manifest.spec.kinds) && isObj(manifest.spec.kinds[kind]) ? (manifest.spec.kinds[kind] as Json) : null
  if (!spec) return { ok: false, reason: `the manifest has no kind ${show(kind)}` }
  return build({ name: kind, spec, dict: dictFor(manifest, kind, spec) }, value, fileId, null, env)
}

// The id an example stands for: its own id field, else `_file` minus the
// file pattern (plans' examples carry `_file`).
export function exampleFileId(manifest: Json, kind: string, example: unknown): string | null {
  if (!isObj(example)) return null
  const spec = (manifest.spec as Json).kinds as Json
  const idSpec = isObj(spec[kind]) && isObj((spec[kind] as Json).envelope) ? ((spec[kind] as Json).envelope as Json).id : null
  if (!isObj(idSpec) || idSpec.from !== 'filename') return null
  if (isStr(example._file)) {
    const src = ((manifest.spec as Json).sources as Json[])[0]
    const pat = isStr(src?.glob) ? src.glob.split('/').pop()! : '*'
    const re = new RegExp(
      '^' +
        pat
          .replace(/[.+^${}()|\\]/g, '\\$&')
          .replace(/\*/g, '(.*)')
          .replace(/\?/g, '.') +
        '$',
    )
    const m = re.exec(example._file)
    return m?.[1] ?? example._file.replace(/\.[^.]*$/, '')
  }
  const names = Array.isArray(idSpec.mustMatchField) ? idSpec.mustMatchField.filter(isStr) : ['id']
  for (const n of names) if (isStr(example[n])) return example[n] as string
  return null
}

// Which kind a source feeds. The schema does not link them; with one kind
// every source feeds it — with several, nothing says, and nothing is read.
function kindOfSources(manifest: Json): string | { problem: string } {
  const kinds = Object.keys(((manifest.spec as Json).kinds as Json) ?? {})
  if (kinds.length === 1) return kinds[0]!
  return { problem: `this silo declares ${kinds.length} kinds and nothing says which source feeds which — v0 reads silos with one kind per manifest` }
}

interface CachedParse {
  mtimeMs: number
  size: number
  parsed: { value: unknown } | { error: string }
}

// Reads every silo source; raw parses are cached by (file, mtime, size) —
// the "index invalidated by mtime" — while normalization and computed fields
// run on every read (they depend on the clock).
export class SiloReader {
  private cache = new Map<string, CachedParse>()

  // `kernel`: the kernel kinds this reader may present (kernel-kinds.ts) —
  // absent for a reader built for an agent's bearer (platform data is the
  // owner's: a bearer's dry-run speaks from the examples)
  constructor(
    private locations: SiloLocations,
    private kernel?: KernelKindSources,
  ) {}

  // where a convention's files live, per location (files-source.ts
  // conventionFolders) — what the kernel's file watch covers
  foldersOf(source: { root: string; glob: string }): string[] {
    return conventionFolders(source, this.locations)
  }

  read(siloId: string, manifest: Json, env: ReadEnv = {}): SiloReading {
    const out: SiloReading = { records: [], unreadable: [], lastWrite: null, sources: {}, truncated: [], problems: [] }
    const spec = isObj(manifest.spec) ? manifest.spec : {}
    // an edge-only silo (spec.relations) reads no records: nothing to say
    if (!Array.isArray(spec.sources) || spec.sources.length === 0) return out
    // kernel sources: each feeds the kind kernelFeeds pairs it with (one
    // source → the one kind; several → the kind named like its kernel kind)
    if ((spec.sources as unknown[]).every((s) => isObj(s) && s.root === 'kernel')) {
      const feeds = kernelFeeds(manifest)
      if (!(feeds instanceof Map)) {
        out.problems.push(feeds.problem)
        return out
      }
      for (const s of (spec.sources as unknown[]).filter(isObj)) this.readKernel(siloId, manifest, feeds.get(String(s.id))!, s, env, out)
      return out
    }
    const kindOrProblem = kindOfSources(manifest)
    if (typeof kindOrProblem !== 'string') {
      out.problems.push(kindOrProblem.problem)
      return out
    }
    const kind = kindOrProblem
    const kinds = spec.kinds as Json
    const anchorHubs = new Set(((((kinds[kind] as Json).envelope as Json).anchors as Json[]) ?? []).map((a) => a.hub))
    let newest = 0
    const seen = new Set<string>()
    for (const s of (Array.isArray(spec.sources) ? spec.sources : []).filter(isObj)) {
      if (s.root === 'kernel') {
        out.problems.push('a kernel source stands alone — kernel data and files never feed the same kind')
        continue
      }
      const source = s as unknown as SourceSpec
      // the registry already refuses such a manifest; the reader never trusts that
      const confined = confineGlob(source)
      if (confined !== null) {
        out.problems.push(confined)
        continue
      }
      let srcNewest = 0
      let srcNewestAt: string | null = null
      const scan = scanSource(source, this.locations)
      if (scan.truncated) out.truncated.push(scan.truncated)
      for (const u of scan.unreadable) {
        out.unreadable.push({ silo: siloId, kind, source: source.id, file: u.path, rel: u.rel, location: u.location.key, id: u.stem ?? null, reason: u.reason })
      }
      for (const f of scan.files) {
        seen.add(f.path)
        if (f.mtimeMs > newest) newest = f.mtimeMs
        if (f.mtimeMs > srcNewest) srcNewest = f.mtimeMs
        const parsed = this.parse(f, source.parser)
        const fail = (reason: string): void => {
          out.unreadable.push({ silo: siloId, kind, source: source.id, file: f.path, rel: f.rel, location: f.location.key, id: f.stem, reason })
        }
        if ('error' in parsed) {
          fail(parsed.error)
          continue
        }
        const b = readRecordValue(manifest, kind, parsed.value, f.stem, env)
        if (!b.ok) {
          fail(b.reason)
          continue
        }
        out.records.push({
          silo: siloId,
          kind,
          source: source.id,
          file: f.path,
          rel: f.rel,
          location: f.location.key,
          anchors: anchorsOf(f.location, anchorHubs),
          mtimeMs: f.mtimeMs,
          raw: parsed.value,
          record: b.record,
          remarks: b.remarks,
          partial: b.partial,
        })
        const at = b.record.at
        if (isStr(at) && at !== '' && !Number.isNaN(Date.parse(at)) && (srcNewestAt === null || Date.parse(at) > Date.parse(srcNewestAt))) srcNewestAt = at
      }
      out.sources[source.id] = { lastWrite: srcNewest > 0 ? new Date(srcNewest).toISOString() : null, newestAt: srcNewestAt }
    }
    for (const k of this.cache.keys()) if (!seen.has(k)) this.cache.delete(k)
    if (newest > 0 && (out.lastWrite === null || newest > Date.parse(out.lastWrite))) out.lastWrite = new Date(newest).toISOString()
    return out
  }

  // A kernel source: the records the kernel holds of the named kind, read
  // through the SAME envelope mapping as a file's (readRecordValue) — a
  // kernel record that does not read is listed with its reason like any
  // file. No file, no glob: `file` is '' and `rel` names the kernel kind.
  private readKernel(siloId: string, manifest: Json, kind: string, s: Json, env: ReadEnv, out: SiloReading): void {
    const sourceId = String(s.id)
    const kk = String(s.kind)
    if (!kernelKind(kk)) {
      out.problems.push(`source ${sourceId}: this Silos publishes no kernel kind ${JSON.stringify(kk)}`)
      return
    }
    const src = this.kernel?.(kk) ?? null
    if (!src) {
      out.sources[sourceId] = { lastWrite: null, newestAt: null }
      return
    }
    const now = env.now ?? Date.now()
    const kindSpec = isObj(manifest.spec) && isObj((manifest.spec as Json).kinds) ? ((manifest.spec as Json).kinds as Json)[kind] : null
    const hubs =
      isObj(kindSpec) && isObj(kindSpec.envelope) && Array.isArray(kindSpec.envelope.anchors) ? (kindSpec.envelope.anchors as unknown[]).filter(isObj) : []
    const kkParent = kernelKind(kk)!.parent
    const parent = kkParent && hubs.some((a) => a.hub === kkParent.hub && a.from === 'parent') ? kkParent : null
    let newestAt: string | null = null
    for (const r of src.records(now)) {
      const rel = `kernel:${kk}/${r.id}`
      const b = readRecordValue(manifest, kind, r.value, null, env)
      if (!b.ok) {
        out.unreadable.push({ silo: siloId, kind, source: sourceId, file: '', rel, location: PLATFORM_LOCATION, id: r.id, reason: b.reason })
        continue
      }
      // a parent anchor: the task the kernel resolved (the catalog names its field)
      const parentKey = parent && isStr(r.value[parent.field]) && r.value[parent.field] !== '' ? (r.value[parent.field] as string) : null
      out.records.push({
        silo: siloId,
        kind,
        source: sourceId,
        file: '',
        rel,
        location: PLATFORM_LOCATION,
        anchors: parentKey ? { task: parentKey } : {},
        mtimeMs: r.writtenAt,
        raw: r.value,
        record: b.record,
        remarks: b.remarks,
        partial: b.partial,
      })
      const at = b.record.at
      if (isStr(at) && at !== '' && !Number.isNaN(Date.parse(at)) && (newestAt === null || Date.parse(at) > Date.parse(newestAt))) newestAt = at
    }
    const lw = src.lastWrite()
    out.sources[sourceId] = { lastWrite: lw !== null ? new Date(lw).toISOString() : null, newestAt }
    if (lw !== null && (out.lastWrite === null || lw > Date.parse(out.lastWrite))) out.lastWrite = new Date(lw).toISOString()
  }

  private parse(f: MatchedFile, parser: SourceSpec['parser']): { value: unknown } | { error: string } {
    const hit = this.cache.get(f.path)
    if (hit && hit.mtimeMs === f.mtimeMs && hit.size === f.size) return hit.parsed
    let parsed: { value: unknown } | { error: string }
    // through safe-file.ts: the place re-verified (the scan's check is not
    // trusted at the read), no link at the name opened, a hard link (a
    // second name for a file elsewhere) refused, a swap mid-read refused
    try {
      const place = recordPlace(f.path, f.rel, f.location.key)
      const r = place === null ? null : readContained(place.dir, place.name, { maxBytes: RECORD_MAX_BYTES })
      parsed = r === null ? { error: 'could not be read: the file is gone' } : parseFile(r.data.toString('utf8'), parser)
    } catch (err) {
      parsed = { error: err instanceof ContainmentError ? err.message : `could not be read: ${err instanceof Error ? err.message : String(err)}` }
    }
    this.cache.set(f.path, { mtimeMs: f.mtimeMs, size: f.size, parsed })
    return parsed
  }
}

// The location key of a record read OUTSIDE every location the silo reads:
// a file the owner opened by its path — a plan an
// agent authored in a folder no agent lives in, a plan under plans/closed/.
// It is said («outside Silos' projects»), never written, never journaled.
export const OUTSIDE_LOCATION = 'outside'

// One file read by its absolute path, through the silo's own reading rules —
// when its NAME matches a files source's file pattern (`*.plan.json`); the
// read goes through safe-file.ts like any record's (no link at the name, the
// size cap). null when no source's pattern names it or no such file exists; an unreadable file says
// why. The caller decides who may ask (the record route: the owner only).
export function readOutside(siloId: string, manifest: Json, file: string, env: ReadEnv = {}): SiloRecord | { unreadable: string } | null {
  const slash = file.lastIndexOf('/')
  if (slash <= 0 || !file.startsWith('/')) return null
  const dir = file.slice(0, slash)
  const name = file.slice(slash + 1)
  const spec = isObj(manifest.spec) ? manifest.spec : {}
  const kind = kindOfSources(manifest)
  if (typeof kind !== 'string') return null
  const source = (Array.isArray(spec.sources) ? spec.sources : [])
    .filter(isObj)
    .find((s) => s.type !== 'kernel' && s.root !== 'kernel' && isStr(s.glob) && segmentRe(s.glob.split('/').pop()!).test(name))
  if (!source) return null
  const pattern = String(source.glob).split('/').pop()!
  let parsed: { value: unknown } | { error: string }
  let mtimeMs = 0
  try {
    const r = readContained(dir, name, { maxBytes: RECORD_MAX_BYTES })
    if (r === null) return null // no such file: nothing to say
    mtimeMs = r.stat.mtimeMs
    parsed = parseFile(r.data.toString('utf8'), source.parser === 'md-frontmatter' ? 'md-frontmatter' : 'json')
  } catch (err) {
    return { unreadable: err instanceof ContainmentError ? err.message : `could not be read: ${err instanceof Error ? err.message : String(err)}` }
  }
  if ('error' in parsed) return { unreadable: parsed.error }
  const b = readRecordValue(manifest, kind, parsed.value, stemOf(pattern, name), env)
  if (!b.ok) return { unreadable: b.reason }
  return {
    silo: siloId,
    kind,
    source: String(source.id),
    file,
    rel: name,
    location: OUTSIDE_LOCATION,
    anchors: {},
    mtimeMs,
    raw: parsed.value,
    record: b.record,
    remarks: b.remarks,
    partial: b.partial,
  }
}

// Anchors come from the location, never from configuration: an agent-state
// record anchors to its agent, a project record to its folder (a kind in
// agent-state cannot anchor to a folder — the validator refuses it).
function anchorsOf(loc: Location, hubs: Set<unknown>): Anchors {
  const a: Anchors = {}
  if (hubs.has('agent') && loc.agentId) a.agent = loc.agentId
  if (hubs.has('folder') && loc.folder) a.folder = loc.folder
  return a
}
