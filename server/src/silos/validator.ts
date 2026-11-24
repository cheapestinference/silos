// silos/validator.ts — the validator of a silo manifest (Silo Standard v0,
// docs/standard/conformance.md «The validator»; step 1 Task 7). The twelve
// checks IN THEIR ORDER, every error in plain words with its position, plus
// the text preview — the exact sentences Silos will say (the pulse phrase, the
// needs-you row, the list row) composed from real records when the owner
// validates and they exist, else from the manifest's examples.
//
// Used by POST /api/silos/validate (owner-only) and, from Task 11, by every
// submission. A DRAFT is a manifest the author iterates on in its own agent
// state before submitting — canonical path:
//
//   <dataDir>/agent-state/<agent>/silo-drafts/<id>.json
//
// deliberately OUTSIDE silos/ (where records live), so a draft is never read
// as records of anything.
import { agentDir, ContainmentError, readContained } from '../safe-file.js'
import { join } from 'node:path'
import { checkExpression, dictionaryForKind, namesReferenced, parse, validateDictionary, type ExprContext } from './expressions.js'
import { schemaCheck, deriveConvention, kernelKindMissing, restrictiveReason, type ReadOptions, type SourceConvention } from './manifest.js'
import { kernelFeeds, kernelKind, kernelKindFor, kernelVerb, KERNEL_VERBS, type KernelKind } from './kernel-kinds.js'
import { confineGlob } from './files-source.js'
import { exampleFileId, readRecordValue, type SiloReader } from './reader.js'
import { pluralOf } from './freshness.js'
import {
  cell,
  childColumn,
  holds,
  kindsOf,
  needsYouKind,
  pulseTerm,
  recordsOfKind,
  sayRow,
  terminalsOf,
  type KindInfo,
  type KindRecord,
  type Voice,
} from './voice.js'
import { KERNEL_RESERVED_IDS, type SiloRegistry } from './registry.js'
import { identityFieldOf } from './actions.js'
import { HOUSE_DIMENSIONS, type Dimensions } from './native.js'
import { resolveTheme, sayRatio, themeFailures } from './theme-rule.js'

type Json = Record<string, unknown>
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)
const isStr = (v: unknown): v is string => typeof v === 'string'

export interface ValidationIssue {
  check: number
  where: string
  message: string
}

export interface Preview {
  from: 'records' | 'examples'
  basis: string // «from 924 records on disk» / «from the 2 examples — no records on disk yet»
  pulse: string | null
  // audience rides so the dialog can SAY the routing before the operator
  // grants it by approving («these rows go to the Finance's queue, not yours»)
  needsYou: Array<{ urgency: string; matches: number; row: string | null; sample: string | null; audience?: 'producer-agent' }>
  list: string | null
}

export interface ValidationResult {
  ok: boolean
  id: string | null
  errors: ValidationIssue[]
  notes: string[] // said, not failing: coexistence, the update diff, the norm no check can prove
  wants: string[]
  conventions: SourceConvention[]
  requirements: Array<{ what: string; met: boolean | null }> // met null = could not be checked here
  update: { from: string | null; lines: string[] } | null
  preview: Preview | null
  // the id is a dimension Silos serves natively or the engine owns
  // (native.ts): the words every door refuses it with — submit answers 409
  native?: string
}

export interface ValidatorContext extends ReadOptions {
  registry?: Pick<SiloRegistry, 'get' | 'list' | 'reservedIds'>
  reader?: SiloReader // the owner's dry-run over real disk
  isAgent?: (value: string) => boolean
  now?: number
  // reinstalling an id approved before is legal for the owner (and for its
  // bound producers) — the installer decides and says so here
  reinstall?: boolean
  // the dimensions that come with Silos (native.ts); absent = the house's
  dimensions?: Pick<Dimensions, 'nativeRefusal'>
}

export const CATALOG_VERBS = ['set-field', 'append-item', 'move-item', 'ensure-record', 'agent-record-write', 'ack', 'open', 'message-agent']
// What a silo over kernel data may do in v0: look, say seen, and declare the
// kernel-verbs its kind admits (the kind's catalog entry names which —
// kernel-kinds.ts KERNEL_VERBS, an enumerated closed catalog). The kernel's
// data is never written by a silo's verb: a kernel-verb is the KERNEL's own
// mutation, declared and visible as such.
export const KERNEL_SOURCE_VERBS = ['ack', 'open', 'kernel-verb']
// a needs-you entry names its actions by verb alone — a kernel-verb needs its
// name, so it is declared in spec.actions only
const KERNEL_NEEDS_YOU_VERBS = ['ack', 'open']
// The producer role of a kernel source: the kernel itself — no agent to bind,
// no instructions to inject, no sync.
export const KERNEL_PRODUCER = 'kernel'
// the hubs a relation may join (v1: agent → agent — the only endpoint any
// planned edge-only silo asks for)
export const RELATION_HUBS: readonly string[] = ['agent']
const FIELD_PLACEHOLDER = /\{\{\s*([^}]*?)\s*\}\}/g
const NAME = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/

// ── the validator ───────────────────────────────────────────────────────────

export function validateSilo(raw: unknown, ctx: ValidatorContext = {}): ValidationResult {
  const res: ValidationResult = { ok: false, id: null, errors: [], notes: [], wants: [], conventions: [], requirements: [], update: null, preview: null }
  const err = (check: number, where: string, message: string): void => {
    res.errors.push({ check, where, message })
  }
  // the id a door refuses whatever the manifest says (native.ts) — read
  // from the raw value, so it is said even over a manifest the schema
  // refuses; ONE rule for validate, submit and silo-check
  const rawId = isObj(raw) && isObj(raw.metadata) && isStr(raw.metadata.id) ? raw.metadata.id : null
  const native = rawId !== null ? (ctx.dimensions ?? HOUSE_DIMENSIONS).nativeRefusal(rawId) : null
  const sayNative = (): void => {
    if (native !== null) {
      res.native = native
      err(2, 'metadata.id', native)
    }
  }

  // 1 — schema (additive unknown ⇒ wants; restrictive unknown ⇒ rejected)
  const sc = schemaCheck(raw, ctx)
  if (sc.fatal !== null) {
    err(1, 'the manifest', sc.fatal)
    sayNative()
    return res
  }
  res.wants = sc.wants
  if (sc.restrictive.length > 0) err(1, sc.restrictive[0]!, restrictiveReason(sc.restrictive))
  for (const e of sc.errors) err(1, e.where, e.message)
  if (res.errors.length > 0) {
    sayNative()
    return res
  } // the rest reads a structure the schema did not vouch for
  const m = sc.manifest!
  const spec = m.spec as Json
  const meta = m.metadata as Json
  const id = String(meta.id)
  res.id = id
  const now = ctx.now ?? Date.now()
  const kinds = kindsOf(m)

  // 2 — ids and charsets
  sayNative()
  const installed = ctx.registry?.get(id) ?? null
  const reserved = ctx.registry?.reservedIds() ?? { kernel: KERNEL_RESERVED_IDS, approved: [] }
  if (reserved.kernel.includes(id) || KERNEL_RESERVED_IDS.includes(id)) err(2, 'metadata.id', `${id} is a word the kernel keeps for itself — pick another id`)
  else if (!installed && reserved.approved.includes(id) && ctx.reinstall !== true)
    err(2, 'metadata.id', `${id} belonged to a silo the owner approved before; approved ids stay reserved after an uninstall`)
  const badCharset = new Set<string>()
  for (const [k, info] of kinds) {
    const cs = isObj(info.spec.envelope) && isObj(info.spec.envelope.id) ? info.spec.envelope.id.charset : undefined
    if (isStr(cs)) {
      try {
        new RegExp(cs)
      } catch {
        err(2, `spec.kinds.${k}.envelope.id.charset`, `the record id charset ${JSON.stringify(cs)} is not a valid pattern`)
        badCharset.add(k)
      }
    }
  }

  // 3 — confinement of sources; a kernel source names a kind this kernel
  // publishes, stands alone, and its producer is the kernel
  // an edge-only silo (spec.relations, step 4) reads no sources
  const sources = Array.isArray(spec.sources) ? (spec.sources as Json[]) : []
  const kernelSources = sources.filter((s) => s.root === 'kernel')
  for (const [i, s] of sources.entries()) {
    if (s.root === 'kernel') {
      if (!kernelKind(String(s.kind))) err(3, `spec.sources[${i}].kind`, kernelKindMissing(String(s.id), String(s.kind)))
      continue
    }
    const c = confineGlob({ id: String(s.id), root: String(s.root), glob: String(s.glob) })
    if (c !== null) err(3, `spec.sources[${i}].glob`, c)
  }
  const producerSpec = isObj(spec.producer) ? spec.producer : {}
  if (kernelSources.length > 0) {
    if (kernelSources.length !== sources.length) err(3, 'spec.sources', 'a kernel source stands alone — kernel data and files never feed the same kind')
    // several kernel sources (System 0.3.0): each feeds the kind named
    // like the kernel kind it presents (kernel-kinds.ts kernelFeeds)
    if (kernelSources.length > 1) {
      const feeds = kernelFeeds(m)
      if (!(feeds instanceof Map)) err(3, 'spec.sources', feeds.problem)
      if (kernelSources.some((s) => kernelKind(String(s.kind))?.binds === 'producers'))
        err(3, 'spec.sources', 'a kernel kind written about bound agents stands alone in its silo — its producer role is theirs')
    }
    // a kernel kind that the kernel writes ABOUT bound agents (binds:
    // 'producers', task-wake) names an agent role and may instruct it — the
    // protocol those agents follow; no sync either way
    const binds = kernelSources.length === 1 && kernelKind(String(kernelSources[0]!.kind))?.binds === 'producers'
    if (binds) {
      if (producerSpec.role === KERNEL_PRODUCER || producerSpec.role === 'any-agent')
        err(
          3,
          'spec.producer.role',
          `the kernel writes ${String(kernelSources[0]!.kind)} about the agents the owner binds — name the role they are bound to (not ${JSON.stringify(producerSpec.role)})`,
        )
      if (producerSpec.sync !== undefined) err(3, 'spec.producer', 'a kernel source has no sync — the kernel produces its records')
    } else {
      if (producerSpec.role !== KERNEL_PRODUCER)
        err(
          3,
          'spec.producer.role',
          `the records of a kernel source are written by the kernel — its producer role is ${KERNEL_PRODUCER} (found ${JSON.stringify(producerSpec.role)})`,
        )
      if (producerSpec.instructions !== undefined || producerSpec.sync !== undefined)
        err(3, 'spec.producer', 'a kernel source has no agent to instruct and no sync — the kernel produces its records')
    }
  } else if (producerSpec.role === KERNEL_PRODUCER) {
    err(3, 'spec.producer.role', `${KERNEL_PRODUCER} is the producer of kernel sources only — files are written by agents`)
  }

  // 4 — conventions (derived, one per source); a source must feed a kind
  for (const [i, s] of sources.entries()) {
    const c = deriveConvention(s)
    if ('error' in c) {
      if (!res.errors.some((e) => e.where === `spec.sources[${i}].glob`)) err(4, `spec.sources[${i}].glob`, c.error)
      continue
    }
    res.conventions.push(c)
    for (const other of ctx.registry?.list() ?? []) {
      if (other.id === id || other.status.state !== 'active') continue
      if (other.status.conventions.some((oc) => oc.convention === c.convention)) {
        res.notes.push(
          `reads the same files as ${other.id} (${c.convention}) — installing offers to take over its slots and instructions, reversibly, or to stay a separate view`,
        )
      }
    }
  }
  const topKinds = [...kinds.values()].filter((k) => !k.parent)
  if (topKinds.length > 1 && !(kernelSources.length > 1 && kernelSources.length === sources.length))
    err(4, 'spec.sources', `this silo declares ${topKinds.length} kinds and nothing says which source feeds which — v0 reads silos with one kind per manifest`)

  // 5 — the full envelope per kind; anchors the location can hold; voice
  const roots = new Set(sources.map((s) => String(s.root)))
  for (const [k, info] of kinds) {
    const where = kindWhere(k)
    const env = isObj(info.spec.envelope) ? info.spec.envelope : {}
    if (!info.parent) {
      const at = isObj(env.at) ? env.at : {}
      if (!isStr(at.field) && at.inherit === undefined)
        err(5, `${where}.envelope.at`, 'at maps no field — name the field that dates the record (or inherit it from the parent)')
      for (const [j, a] of (Array.isArray(env.anchors) ? env.anchors : []).entries()) {
        if (!isObj(a)) continue
        const hub = String(a.hub)
        // a parent anchor: the record hangs from a task
        // the KERNEL resolved — only over a kernel kind the catalog declares
        // with that parent (execution), never from a file's location
        if (a.from === 'parent' || hub === 'task') {
          const kk = kernelKindFor(m, k)
          if (a.from !== 'parent' || hub !== 'task')
            err(
              5,
              `${where}.envelope.anchors[${j}]`,
              hub === 'task'
                ? 'a record hangs from a task only as its parent (from: parent) — a location holds no task'
                : `only a task is a parent hub — ${hub} comes from the location`,
            )
          else if (!kk?.parent || kk.parent.hub !== hub)
            err(
              5,
              `${where}.envelope.anchors[${j}]`,
              `a record hangs from a task only when the kernel resolves it — ${kernelSources.length > 0 ? `the kernel kind ${String((kernelSources.length === 1 ? kernelSources[0] : kernelSources.find((s) => String(s.kind) === k))?.kind ?? k)} has no task parent` : 'files name no parent the kernel resolves'}`,
            )
          continue
        }
        const ok =
          (hub === 'agent' && roots.has('agent-state') && roots.size === 1) ||
          (hub === 'folder' && roots.has('project') && roots.size === 1) ||
          (hub === 'platform' && roots.has('kernel') && roots.size === 1)
        if (!ok)
          err(
            5,
            `${where}.envelope.anchors[${j}]`,
            hub === 'conversation'
              ? "a record anchors to a conversation only through a declared field or the owner's gesture — never from its location"
              : hub === 'platform'
                ? 'only kernel data anchors to the platform — records in files belong to an agent or a folder'
                : `a kind read from ${[...roots].join(' and ')} cannot anchor to ${hub === 'agent' ? 'an agent' : 'a folder'} from its location`,
          )
      }
    }
    // a kind presenting kernel data matches the published kernel kind
    if (!info.parent && kernelSources.length > 0) {
      const src = kernelSources.length === 1 ? kernelSources[0]! : kernelSources.find((s) => String(s.kind) === k)
      const kk = src ? kernelKind(String(src.kind)) : null
      if (kk && src) for (const issue of kernelKindIssues(info, kk, String(src.kind))) err(5, `${where}${issue.at}`, issue.message)
    }
    const states = Array.isArray(info.spec.states) ? info.spec.states.filter(isObj) : []
    for (const [j, st] of states.entries()) {
      const l = isObj(st.label) ? st.label : {}
      if (!isStr(l.one) || l.one === '' || !isStr(l.many) || l.many === '')
        err(5, `${where}.states[${j}].label`, `state ${JSON.stringify(st.value)} needs its plain words for one and many`)
    }
    if (states.length > 0 && !states.some((st) => st.terminal === true)) err(5, `${where}.states`, 'at least one state must be terminal (what counts as done)')
    if (info.parent && states.length > 0 && !isObj(env.state)) err(5, `${where}.envelope.state`, 'states are declared but the envelope maps no state field')
    // the identity speaks only of what the kind declares
    const idTpl = isObj(env.identity) ? env.identity : {}
    for (const key of ['template', 'empty'] as const) {
      const tpl = idTpl[key]
      if (!isStr(tpl)) continue
      for (const name of placeholderNames(tpl)) {
        // said, not failing: unknown fields are preserved, so the file's own
        // value is read — the reference plans manifest does exactly this
        if (!(name.split('.')[0]! in info.dict.fields))
          res.notes.push(`${where}.envelope.identity.${key} names ${name}, which ${k} does not declare — it is read as the file writes it`)
      }
    }
  }

  // sub-kinds nest two levels at most (a record's children and theirs): a
  // third is refused — nothing would read it
  for (const [k, info] of kinds) {
    if (k.split('/').length !== 3) continue
    for (const sub of Object.keys(isObj(info.spec.subKinds) ? info.spec.subKinds : {})) {
      err(
        5,
        `${kindWhere(k)}.subKinds.${sub}`,
        `${k}/${sub} would be a third level — sub-kinds nest two levels at most (a record's children and theirs: a plan's tasks and each task's notes)`,
      )
    }
  }

  // 6 — expressions: parse, reference only declared fields; and the views,
  // pulse and actions name what exists
  const exprAt = (where: string, src: unknown, kindName: string | null, context: ExprContext): void => {
    if (!isStr(src)) return
    const info = kindName ? kinds.get(kindName) : undefined
    if (!info) return
    for (const i of checkExpression(src, info.dict, context)) err(6, where, `${i.message} (column ${i.column})`)
  }
  // a field's presentation: a unit is said after a NUMBER only
  for (const [k, info] of kinds) {
    for (const [f, fs] of Object.entries(isObj(info.spec.fields) ? info.spec.fields : {})) {
      if (isObj(fs) && fs.unit !== undefined && fs.type !== 'number')
        err(
          6,
          `${info.parent ? `spec.kinds.${k.split('/')[0]} (${k})` : `spec.kinds.${k}`}.fields.${f}.unit`,
          `${f} is a ${isStr(fs.type) ? fs.type : 'string'} — only a number field is said with a unit`,
        )
    }
  }
  for (const [k, info] of kinds) {
    if (info.parent) continue
    for (const i of dictionaryForKind(k, info.spec).issues) err(6, dictWhere(i.where), `${i.message} (column ${i.column})`)
    for (const i of validateDictionary(info.dict)) err(6, dictWhere(i.where), `${i.message} (column ${i.column})`)
  }
  const views = Array.isArray(spec.views) ? spec.views.filter(isObj) : []
  // relations (step 4, edge-only silos): unique names, endpoints the kernel
  // keeps, and a tree or a lens only over an acyclic agent → agent relation
  const relations = Array.isArray(spec.relations) ? spec.relations.filter(isObj) : []
  const relationNamed = new Map<string, Json>()
  for (const [i, r] of relations.entries()) {
    const name = String(r.name)
    if (relationNamed.has(name)) err(6, `spec.relations[${i}].name`, `${name} is declared twice — one relation, one name`)
    else relationNamed.set(name, r)
    for (const end of ['from', 'to'] as const) {
      if (!RELATION_HUBS.includes(String(r[end])))
        err(6, `spec.relations[${i}].${end}`, `${String(r[end])} is not a hub this Silos keeps relations between (${RELATION_HUBS.join(', ')})`)
    }
  }
  const drawable = (where: string, name: unknown, what: string): void => {
    const r = isStr(name) ? relationNamed.get(name) : undefined
    if (!r) {
      err(
        6,
        where,
        `${String(name)} is not a relation of this silo${relationNamed.size > 0 ? ` (${[...relationNamed.keys()].join(', ')})` : ' — it declares none'}`,
      )
      return
    }
    if (r.acyclic !== true)
      err(6, where, `${what} needs an acyclic relation — ${String(name)} does not declare acyclic: true, so a loop could leave it without roots`)
    if (r.from !== r.to) err(6, where, `${what} draws a relation between the same hub — ${String(name)} goes from ${String(r.from)} to ${String(r.to)}`)
  }
  for (const [i, v] of views.entries()) {
    // a view's name on its silo's page, when the silo has several to choose
    // between (System: Processes · Worktrees) — a word or two
    if (v.label !== undefined && (!isStr(v.label) || v.label.trim() === '' || v.label.length > VIEW_LABEL_MAX || /[\r\n]/.test(v.label)))
      err(6, `spec.views[${i}].label`, `a view's label is its name on the silo's page, one line of at most ${VIEW_LABEL_MAX} characters`)
    if (v.archetype === 'tree') {
      drawable(`spec.views[${i}].relation`, v.relation, 'a tree')
      continue
    }
    const info = kinds.get(String(v.kind))
    if (!info) {
      err(6, `spec.views[${i}].kind`, `${String(v.kind)} is not a kind of this silo (${[...kinds.keys()].join(', ')})`)
      continue
    }
    if (isObj(v.fold)) {
      exprAt(`spec.views[${i}].fold.when`, v.fold.when, info.name, 'predicate')
      // what the folded records are, in a few words — the page's fold line
      // says it beside their count («55 ended or another user's · Show»)
      const l = v.fold.label
      if (l !== undefined && (!isStr(l) || l.trim() === '' || l.length > FOLD_LABEL_MAX || /[\r\n]/.test(l)))
        err(
          6,
          `spec.views[${i}].fold.label`,
          `a fold's label is a few words on one line (at most ${FOLD_LABEL_MAX} characters) saying what the folded records are`,
        )
    }
    if (isObj(v.first)) {
      if (v.archetype !== 'list') err(6, `spec.views[${i}].first`, 'first orders a list — a board is ordered by its columns')
      else exprAt(`spec.views[${i}].first.when`, v.first.when, info.name, 'predicate')
    }
    if (isStr(v.groupBy)) {
      const g = v.groupBy
      if (v.archetype === 'board') {
        if (g !== 'state') err(6, `spec.views[${i}].groupBy`, `a board groups by state — its columns are the kind's states, not ${g}`)
      } else if (v.archetype === 'list') {
        const t = info.dict.fields[g.split('.')[0]!]?.type
        if (g === 'identity' || g === 'at' || !columnKnown(g, info, 'facets'))
          err(6, `spec.views[${i}].groupBy`, `${g} is not something ${info.name} records can be grouped by — a field of it, agent, folder, project or state`)
        else if (t === 'timestamp' || t === 'object' || t === 'children' || (t === 'money' && !g.includes('.')))
          err(6, `spec.views[${i}].groupBy`, `${g} is a ${t} — every record would sit alone in its group; group by a field records share`)
      }
    }
    for (const list of ['columns', 'facets'] as const) {
      for (const [j, c] of (Array.isArray(v[list]) ? (v[list] as unknown[]) : []).entries()) {
        if (!isStr(c)) continue
        if (!columnKnown(c, info, list)) err(6, `spec.views[${i}].${list}[${j}]`, `${c} is not a field of ${info.name}`)
      }
    }
  }
  const surfaces = isObj(spec.surfaces) ? spec.surfaces : {}
  if (isObj(surfaces.lens)) {
    const g = isObj(surfaces.lens.groupBy) ? surfaces.lens.groupBy : {}
    drawable('spec.surfaces.lens.groupBy.relation', g.relation, 'a lens by subtree')
    const r = isStr(g.relation) ? relationNamed.get(g.relation) : undefined
    if (r && r.from !== 'agent')
      err(6, 'spec.surfaces.lens.groupBy.relation', `a lens over tasks groups them by their owner — ${String(g.relation)} must go from agent to agent`)
  }
  const rail = isObj(surfaces.rail) ? surfaces.rail : null
  if (rail && !views.some((v) => v.id === rail.view)) err(6, 'spec.surfaces.rail.view', `${String(rail.view)} is not one of this silo's views`)
  if (isObj(surfaces.pulse)) {
    const p = surfaces.pulse
    const info = kinds.get(String(p.kind))
    if (!info) err(6, 'spec.surfaces.pulse.kind', `${String(p.kind)} is not a kind of this silo`)
    else {
      if (p.aggregate === 'sum') {
        if (!isStr(p.field)) err(6, 'spec.surfaces.pulse.field', 'sum needs the money field it adds up')
        else if (info.dict.fields[p.field]?.type !== 'money') err(6, 'spec.surfaces.pulse.field', `${p.field} is not a money field of ${info.name}`)
      }
      exprAt('spec.surfaces.pulse.when', p.when, info.name, 'predicate')
    }
  }
  const nyKind = needsYouKind(m)
  const needsYou = Array.isArray(surfaces['needs-you']) ? surfaces['needs-you'].filter(isObj) : []
  if (needsYou.length > 0 && !nyKind)
    err(6, 'spec.surfaces.needs-you', 'needs-you entries name no kind and this silo has several — declare the pulse kind, or one kind per silo')
  for (const [i, n] of needsYou.entries()) {
    exprAt(`spec.surfaces.needs-you[${i}].when`, n.when, nyKind, 'predicate')
    exprAt(`spec.surfaces.needs-you[${i}].clears`, n.clears, nyKind, 'predicate')
    if (isObj(n.fold)) exprAt(`spec.surfaces.needs-you[${i}].fold.when`, n.fold.when, nyKind, 'predicate')
    for (const [j, a] of (Array.isArray(n.actions) ? (n.actions as unknown[]) : []).entries()) {
      if (!isStr(a) || !CATALOG_VERBS.includes(a))
        err(6, `spec.surfaces.needs-you[${i}].actions[${j}]`, `${String(a)} is not an action of the catalog (${CATALOG_VERBS.join(', ')})`)
      else if (kernelSources.length > 0 && !KERNEL_NEEDS_YOU_VERBS.includes(a)) err(6, `spec.surfaces.needs-you[${i}].actions[${j}]`, kernelVerbRefusal(a))
    }
  }
  const actions = Array.isArray(spec.actions) ? spec.actions.filter(isObj) : []
  if (kernelSources.length > 0) {
    for (const [i, a] of actions.entries())
      if (!KERNEL_SOURCE_VERBS.includes(String(a.verb))) err(6, `spec.actions[${i}].verb`, kernelVerbRefusal(String(a.verb)))
  }
  // kernel-verb: a name of the closed catalog, admitted by the kernel kind
  // the silo presents, over that kind; its `when` (optional) narrows when the
  // page offers it — the kernel's own guard is checked at the gesture anyway
  for (const [i, a] of actions.entries()) {
    if (a.verb !== 'kernel-verb') continue
    const where = `spec.actions[${i}]`
    if (kernelSources.length === 0) {
      err(6, `${where}.verb`, 'kernel-verb acts on kernel data only — this silo reads files, and its own verbs write them')
      continue
    }
    // the kernel kind that presents the verb's kind (several sources: the one named like it)
    const kk = String((kernelSources.length > 1 ? kernelSources.find((s) => String(s.kind) === a.kind) : undefined)?.kind ?? kernelSources[0]!.kind)
    const admits = kernelKind(kk)?.verbs ?? []
    if (!isStr(a.name) || a.name === '') {
      err(
        6,
        `${where}.name`,
        `a kernel-verb names the kernel's verb it declares (${admits.length > 0 ? `${kk} admits ${admits.join(', ')}` : `${kk} admits none`})`,
      )
      continue
    }
    if (!kernelVerb(a.name)) {
      err(6, `${where}.name`, `this kernel knows no kernel-verb ${JSON.stringify(a.name)} — the catalog is closed (${Object.keys(KERNEL_VERBS).join(', ')})`)
      continue
    }
    if (!admits.includes(a.name)) {
      err(
        6,
        `${where}.name`,
        `${a.name} does not act on the kernel kind ${kk} — ${admits.length > 0 ? `it admits ${admits.join(', ')}` : 'it admits no kernel-verb: open and ack only'}`,
      )
      continue
    }
    if (!isStr(a.kind)) {
      err(6, `${where}.kind`, `a kernel-verb names the kind it acts on — the kind that presents ${kk}`)
      continue
    }
    exprAt(`${where}.when`, a.when, a.kind, 'predicate')
  }
  for (const [i, a] of actions.entries()) {
    const target = isStr(a.subKind) ? a.subKind : isStr(a.kind) ? a.kind : null
    if (target === null) continue
    const info = kinds.get(target)
    if (!info) {
      err(6, `spec.actions[${i}]`, `${target} is not a kind of this silo`)
      continue
    }
    for (const f of Object.keys(isObj(a.fields) ? a.fields : {})) {
      if (!(f in info.dict.fields)) err(6, `spec.actions[${i}].fields.${f}`, `${f} is not a field of ${info.name}`)
    }
    for (const [j, t] of (Array.isArray(a.templates) ? (a.templates as unknown[]) : []).entries()) {
      if (!isStr(t)) continue
      for (const name of placeholderNames(t))
        if (!(name.split('.')[0]! in info.dict.fields))
          res.notes.push(`spec.actions[${i}].templates[${j}] names ${name}, which ${info.name} does not declare — it is read as the file writes it`)
    }
    // ensure-record (plans 0.5.0): ONE reserved record of a top kind, born
    // from its seed; its rotation names a child collection, a predicate over
    // those children and a destination that is never read as a live record
    if (a.verb === 'ensure-record') {
      if (info.parent) err(6, `spec.actions[${i}].kind`, 'ensure-record makes a record — name a top kind, not a sub-kind')
      if (!isStr(a.id) || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(a.id))
        err(6, `spec.actions[${i}].id`, 'ensure-record needs the reserved record id it ensures (letters, digits, - and _)')
      if (!isObj(a.seed)) err(6, `spec.actions[${i}].seed`, 'ensure-record needs the seed the record is born with')
      // read only over a kind the earlier checks found sound (a broken
      // charset is said once, at its own check)
      else if (!res.errors.some((e) => e.check < 6)) {
        const b = readRecordValue(m, info.name, a.seed, isStr(a.id) ? a.id : 'seed')
        if (!b.ok) err(6, `spec.actions[${i}].seed`, `the seed does not read as a ${info.name}: ${b.reason}`)
      }
      const rot = a.rotate
      if (rot !== undefined) {
        if (!isObj(rot)) err(6, `spec.actions[${i}].rotate`, 'rotate is an object')
        else {
          const coll = isStr(rot.children) ? rot.children : ''
          if (!(coll in info.dict.collections)) err(6, `spec.actions[${i}].rotate.children`, `${coll || '(nothing)'} is not a child collection of ${info.name}`)
          else
            exprAt(`spec.actions[${i}].rotate.when`, rot.when, [...kinds.values()].find((k) => k.parent === info && k.coll === coll)?.name ?? null, 'predicate')
          if (rot.every !== 'month') err(6, `spec.actions[${i}].rotate.every`, 'v0 rotates every month')
          // plans 0.5.2: inside THIS when, a since(…) with no transition counts as old
          if (rot.undated !== undefined && rot.undated !== 'old')
            err(6, `spec.actions[${i}].rotate.undated`, 'undated says how a since(…) with no recorded transition counts inside the rotation — only "old"')
          if (!isStr(rot.stamp) || !isStr(rot.retired))
            err(
              6,
              `spec.actions[${i}].rotate`,
              'rotate names its stamp field (the month it last rotated) and its retired field (the ids that left — never reused)',
            )
          const into = isStr(rot.into) ? rot.into : ''
          const segs = into.split('/')
          if (!into.includes('{{month}}') || into.startsWith('/') || segs.some((x) => x === '' || x === '.' || x === '..') || segs.length < 2)
            err(6, `spec.actions[${i}].rotate.into`, 'rotate.into is a relative file path with {{month}} in it, inside a folder of its own')
        }
      }
    }
    // claim / release (plans 0.5.1, R4): the task verbs — their own check,
    // not CATALOG_VERBS (that list governs Needs you's buttons). `link` names
    // a collection of the subKind (claim: an identity one, the conversations;
    // release: the roles.task.releases one); `set` only fields with declared
    // states; `by` ⊂ {owner, task-owner}; task-owner needs roles.task.owner.
    if (a.verb === 'claim' || a.verb === 'release') {
      const verb = a.verb
      const where = `spec.actions[${i}]`
      if (!isStr(a.subKind)) err(6, `${where}.subKind`, `${verb} acts on a task — name its subKind`)
      const coll = isStr(a.link) ? a.link : ''
      const linked = [...kinds.values()].find((k) => k.parent === info && k.coll === coll)
      if (!linked)
        err(
          6,
          `${where}.link`,
          `${coll || '(nothing)'} is not a collection of ${info.name}${Object.keys(info.dict.collections).length > 0 ? ` (${Object.keys(info.dict.collections).join(', ')})` : ''}`,
        )
      else if (verb === 'claim' && identityFieldOf(linked) === null)
        err(6, `${where}.link`, `claim links an id — ${coll} is not a list of ids (an identity collection whose only field is its id)`)
      else if (verb === 'release' && info.dict.task?.releases !== coll)
        err(
          6,
          `${where}.link`,
          `release marks the collection roles.task.releases names — ${info.dict.task?.releases ? `that is ${info.dict.task.releases}, not ${coll}` : `${info.name} declares no roles.task.releases`}`,
        )
      if (a.set !== undefined) {
        if (verb === 'release') err(6, `${where}.set`, 'release never sets a field — it only adds a mark; the state a release leaves is its `dispose`')
        else if (isObj(a.set)) {
          const env = isObj(info.spec.envelope) ? info.spec.envelope : {}
          const stField = isObj(env.state) && isStr(env.state.field) ? env.state.field : null
          const states = (Array.isArray(info.spec.states) ? info.spec.states : []).filter(isObj).map((x) => String(x.value))
          for (const [f, val] of Object.entries(a.set)) {
            if (f !== stField || states.length === 0)
              err(6, `${where}.set.${f}`, `claim sets only a field with declared states${stField ? ` (${stField})` : ''} — ${f} is not one`)
            else if (!states.includes(String(val))) err(6, `${where}.set.${f}`, `${String(val)} is not a state of ${info.name} (${states.join(', ')})`)
          }
        }
      }
      // dispose (plans 0.5.2): the state a release leaves —
      // `field` the subKind's state field, from/default/allowed its states
      if (a.dispose !== undefined) {
        const d = a.dispose
        const env = isObj(info.spec.envelope) ? info.spec.envelope : {}
        const stField = isObj(env.state) && isStr(env.state.field) ? env.state.field : null
        const states = (Array.isArray(info.spec.states) ? info.spec.states : []).filter(isObj).map((x) => String(x.value))
        if (verb !== 'release') err(6, `${where}.dispose`, 'dispose belongs to release — claim says its state in `set`')
        else if (!isObj(d)) err(6, `${where}.dispose`, 'dispose is an object {field, from, default, allowed}')
        else if (!isStr(d.field) || d.field !== stField || states.length === 0)
          err(
            6,
            `${where}.dispose.field`,
            `dispose acts on a field with declared states${stField ? ` (${stField})` : ''} — ${isStr(d.field) ? d.field : '(nothing)'} is not one`,
          )
        else {
          for (const k of ['from', 'default'] as const)
            if (!isStr(d[k]) || !states.includes(d[k] as string))
              err(6, `${where}.dispose.${k}`, `${isStr(d[k]) ? (d[k] as string) : '(nothing)'} is not a state of ${info.name} (${states.join(', ')})`)
          const allowed = Array.isArray(d.allowed) ? d.allowed : null
          if (!allowed || allowed.length === 0) err(6, `${where}.dispose.allowed`, 'dispose.allowed lists the states a release may leave')
          else {
            const bad = allowed.filter((x) => !isStr(x) || !states.includes(x))
            if (bad.length > 0)
              err(
                6,
                `${where}.dispose.allowed`,
                `${bad.map(String).join(', ')} ${bad.length === 1 ? 'is not a state' : 'are not states'} of ${info.name} (${states.join(', ')})`,
              )
            if (isStr(d.default) && !allowed.includes(d.default))
              err(6, `${where}.dispose.default`, `the default (${d.default}) must be one of allowed (${allowed.map(String).join(', ')})`)
          }
        }
      }
      const by = Array.isArray(a.by) ? a.by : [a.by]
      const badBy = by.filter((b) => b !== 'owner' && b !== 'task-owner')
      if (badBy.length > 0 || by.length === 0)
        err(6, `${where}.by`, `${verb} is done by owner or task-owner only (found ${badBy.map(String).join(', ') || 'nobody'})`)
      if (by.includes('task-owner') && !info.dict.task?.owner) err(6, `${where}.by`, `task-owner needs roles.task.owner on ${info.name} — whose task it is`)
    } else if (Array.isArray(a.by) && a.by.includes('task-owner')) {
      err(6, `spec.actions[${i}].by`, `task-owner does only claim and release — not ${String(a.verb)}`)
    }
  }

  // 7 — needs-you: a condition that can be dispatched; blocking needs the owner to be able to
  // clear it; audience producer-agent needs the PRODUCER to be able to (its
  // agent-record-write, or the sync — the sync IS its write channel) and is
  // never blocking (what blocks is the owner's by definition).
  if (nyKind) {
    const info = kinds.get(nyKind)
    if (info) {
      const ownerWritable = ownerWritableNames(info, actions)
      const producerWrites = actions.some((a) => a.verb === 'agent-record-write' && (a.kind === nyKind || a.kind === info.parent?.name))
      const producerSyncs = isObj(spec.producer) && isObj((spec.producer as Json).sync)
      // over kernel data the kernel writes every field: its engine clears the
      // item (a window resets) — nobody's gesture is needed, and none exists
      const kernelWrites = kernelSources.length > 0
      for (const [i, n] of needsYou.entries()) {
        // (a value outside the enum never reaches here — check 1's schema stops it)
        if (n.audience === 'producer-agent') {
          if (n.urgency === 'blocking')
            err(7, `spec.surfaces.needs-you[${i}].audience`, 'a blocking entry cannot be routed to the producer — what blocks is the owner’s by definition')
          if (!producerWrites && !producerSyncs)
            err(
              7,
              `spec.surfaces.needs-you[${i}].audience`,
              'audience producer-agent needs the producer to be able to clear it — declare agent-record-write on this kind, or a sync (the sync is its write channel)',
            )
        }
        const r = isStr(n.clears) ? parse(n.clears, 'predicate') : null
        if (!r || !r.ok) continue
        const names = namesReferenced(r.ast).filter((x) => x in info.dict.fields) // literals (state values) are not fields
        const byOwner = names.some((x) => ownerWritable.has(x))
        if (n.urgency === 'blocking' && !byOwner)
          err(
            7,
            `spec.surfaces.needs-you[${i}].clears`,
            `a blocking item must clear by something the owner can do — ${n.clears} reads ${names.join(', ') || 'nothing'}, none of which a set-field action lets the owner write`,
          )
        // the sync counts here too: it writes the producer's records, so a
        // `clears` on fields only the sync fills is the producer's to clear
        else if (!byOwner && !producerWrites && !producerSyncs && !kernelWrites)
          err(
            7,
            `spec.surfaces.needs-you[${i}].clears`,
            `nobody can clear this item: ${n.clears} reads ${names.join(', ') || 'nothing'}, which neither the owner (set-field) nor the producer (agent-record-write or a sync) writes`,
          )
      }
    }
  }

  // 8 — sync + ownerWritable ⇒ the producer reads the merged view with its
  // bearer. A role is a word of the manifest, never an agent id: WHO holds
  // that bearer is the binding the owner makes at approval, so here the
  // requirement is said and left unchecked (null) — the approval dialog
  // checks it against the agents bound (installer requirements).
  const producer = isObj(spec.producer) ? spec.producer : {}
  const ownerWritableAny = [...kinds.values()].some((k) => Array.isArray(k.spec.ownerWritable) && k.spec.ownerWritable.length > 0)
  if (isObj(producer.sync) && ownerWritableAny) {
    res.requirements.push({
      what: `requires the token of the agent bound to ${String(producer.role)} — the sync reads the owner's changes through the API before writing`,
      met: null,
    })
  }

  // 9 — examples: every one reads with this very manifest; on an update, the
  // previous version's examples still read
  for (const [k, info] of kinds) {
    if (info.parent || badCharset.has(k)) continue // check 2 already said why nothing reads
    for (const [i, ex] of (Array.isArray(info.spec.examples) ? info.spec.examples : []).entries()) {
      const b = readRecordValue(m, k, ex, exampleFileId(m, k, ex), { now, ...(ctx.isAgent ? { isAgent: ctx.isAgent } : {}) })
      if (!b.ok) err(9, `spec.kinds.${k}.examples[${i}]`, `this example does not read: ${b.reason}`)
    }
  }
  if (installed?.manifest) {
    const prev = installed.manifest
    const prevVersion = isObj(prev.metadata) && isStr(prev.metadata.version) ? prev.metadata.version : null
    res.update = { from: prevVersion, lines: [] }
    const prevKinds = isObj(prev.spec) && isObj(prev.spec.kinds) ? prev.spec.kinds : {}
    for (const [k, pspec] of Object.entries(prevKinds)) {
      if (!isObj(pspec)) continue
      if (!kinds.has(k)) {
        err(9, `spec.kinds`, `the kind ${k} of version ${prevVersion ?? '?'} is gone — records on disk would stop being read`)
        continue
      }
      for (const [i, ex] of (Array.isArray(pspec.examples) ? pspec.examples : []).entries()) {
        const b = readRecordValue(m, k, ex, exampleFileId(prev, k, ex), { now })
        if (!b.ok)
          err(
            9,
            `spec.kinds.${k}.examples`,
            `example ${i + 1} of version ${prevVersion ?? '?'} no longer reads: ${b.reason} — keep it reading or declare an alias`,
          )
      }
    }
    const prevConvs = installed.status.conventions.map((c) => c.convention)
    for (const c of res.conventions) if (!prevConvs.includes(c.convention)) res.update.lines.push(`reads more than before: ${c.convention}`)
    if (ctx.reader && res.errors.length === 0) {
      const before = ctx.reader.read(id, prev, { now })
      const after = ctx.reader.read(id, m, { now })
      const ok = new Set(after.records.map((r) => `${r.location}/${r.record.id}`))
      const lost = before.records.filter((r) => !ok.has(`${r.location}/${r.record.id}`)).length
      res.update.lines.push(
        lost === 0 ? 'every record on disk still reads' : `${lost} record${lost === 1 ? '' : 's'} on disk stop${lost === 1 ? 's' : ''} parsing`,
      )
    }
    const look = lookChange(prev, m)
    if (look) res.update.lines.push(look)
    res.notes.push(...res.update.lines)
  }

  // 12 — a theme's contrast (theme-rule.ts, the one source of the rule): each
  // pair of the rule, in light and in dark, at its minimum or above
  if (isObj(spec.theme)) {
    const t = resolveTheme(spec.theme)
    if (!t) err(12, 'spec.theme', 'the theme does not read — every token of the vocabulary as #rrggbb, for light and for dark')
    else
      for (const f of themeFailures(t))
        err(12, `spec.theme.${f.mode}`, `in ${f.mode}, ${f.fg} on ${f.bg} measures ${sayRatio(f.ratio)} — the rule asks at least ${f.min}:1`)
  }

  // 10 — dry-run and the text preview
  if (res.errors.length === 0) res.preview = previewOf(m, kinds, ctx, now)

  // 11 — the norm no check can prove, said all the same
  // (a silo with no kinds — edge-only, a look only — has no examples to say it of)
  if (kinds.size > 0) res.notes.push("examples must be synthetic — never a real person's data (no check can prove it; the standard requires it)")

  res.ok = res.errors.length === 0
  return res
}

// What an update does to the look a silo brings, in one line (null = no
// theme before or after, or the same one) — the dialog says it beside the
// other update lines.
export function lookChange(prev: Json, next: Json): string | null {
  const themeOf = (m: Json): Json | null => (isObj(m.spec) && isObj((m.spec as Json).theme) ? ((m.spec as Json).theme as Json) : null)
  const a = themeOf(prev)
  const b = themeOf(next)
  if (!a && !b) return null
  if (!a) return `brings a new look: ${String(b!.name)} — offered in Settings › Appearance, nobody's colours change`
  if (!b) return `no longer brings its look ${String(a.name)} — a browser using it goes back to the default`
  const ra = resolveTheme(a)
  const rb = resolveTheme(b)
  if (JSON.stringify(ra) === JSON.stringify(rb)) return null
  const renamed = String(a.name) !== String(b.name)
  const recoloured = JSON.stringify(ra?.light) !== JSON.stringify(rb?.light) || JSON.stringify(ra?.dark) !== JSON.stringify(rb?.dark)
  if (renamed && !recoloured) return `its look ${String(a.name)} is now called ${String(b.name)}`
  return `its look ${renamed ? `${String(a.name)} becomes ${String(b.name)} and ` : `${String(b.name)} `}changes its colours — a browser using it takes the new ones`
}

function kernelVerbRefusal(verb: string): string {
  return `${verb} does not act on kernel data — a silo over a kernel source may only open, ack and declare the kernel-verbs its kind admits (the kernel's own mutations)`
}

// The manifest's kind against the published kernel kind: the same states
// (the kernel writes them — a missing one would leave records unreadable),
// the same terminals, fields the catalog has with the catalog's type, the
// envelope on the catalog's fields, and roles on catalog timestamps.
function kernelKindIssues(info: KindInfo, kk: KernelKind, name: string): Array<{ at: string; message: string }> {
  const out: Array<{ at: string; message: string }> = []
  const spec = info.spec
  const env = isObj(spec.envelope) ? spec.envelope : {}
  const declared = (Array.isArray(spec.states) ? spec.states : []).filter(isObj)
  const values = declared.map((s) => String(s.value))
  const want = kk.states.map((s) => s.value)
  const missing = want.filter((v) => !values.includes(v))
  const extra = values.filter((v) => !want.includes(v))
  if (missing.length > 0 || extra.length > 0)
    out.push({
      at: '.states',
      message: `the kernel kind ${name} has the states ${want.join(', ')} — the manifest ${missing.length > 0 ? `misses ${missing.join(', ')}` : ''}${missing.length > 0 && extra.length > 0 ? ' and ' : ''}${extra.length > 0 ? `adds ${extra.join(', ')}` : ''}`,
    })
  for (const st of kk.states) {
    const mine = declared.find((s) => s.value === st.value)
    if (mine && (mine.terminal === true) !== st.terminal)
      out.push({ at: '.states', message: `${st.value} is ${st.terminal ? '' : 'not '}terminal in the kernel kind ${name}` })
  }
  for (const [f, fs] of Object.entries(isObj(spec.fields) ? spec.fields : {})) {
    const k = kk.fields[f]
    const t = isObj(fs) && isStr(fs.type) ? fs.type : 'string'
    if (!k) out.push({ at: `.fields.${f}`, message: `${f} is not a field of the kernel kind ${name} (${Object.keys(kk.fields).join(', ')})` })
    else if (k.type !== t) out.push({ at: `.fields.${f}`, message: `${f} is a ${k.type} in the kernel kind ${name}, not a ${t}` })
  }
  const field = (x: unknown): string | null => (isObj(x) && isStr(x.field) ? x.field : null)
  if (isObj(env.id) && env.id.from === 'filename')
    out.push({ at: '.envelope.id', message: "a kernel record has no file to take its id from — its id is the kernel's" })
  if (field(env.id) !== null && field(env.id) !== kk.envelope.id)
    out.push({ at: '.envelope.id', message: `the kernel kind ${name} keeps its id in ${kk.envelope.id}` })
  if (field(env.state) !== kk.envelope.state) out.push({ at: '.envelope.state', message: `the kernel kind ${name} keeps its state in ${kk.envelope.state}` })
  const at = field(env.at)
  if (at === null || (at !== kk.envelope.at && kk.fields[at]?.type !== 'timestamp'))
    out.push({ at: '.envelope.at', message: `at must name a timestamp of the kernel kind ${name} (${kk.envelope.at} is when it began)` })
  const ub = isObj(env.updatedBy) ? env.updatedBy : null
  if (ub && ub.absent !== 'unknown' && field(ub) !== kk.envelope.updatedBy)
    out.push({ at: '.envelope.updatedBy', message: `the kernel kind ${name} keeps updatedBy in ${kk.envelope.updatedBy}` })
  const due = isObj(spec.roles) && isObj(spec.roles.due) && isStr(spec.roles.due.field) ? spec.roles.due.field : null
  if (due !== null && kk.fields[due]?.type !== 'timestamp') out.push({ at: '.roles.due', message: `${due} is not a timestamp of the kernel kind ${name}` })
  return out
}

// 'plan/task computed.ready' → 'spec.kinds.plan.subKinds.task.computed.ready'
function dictWhere(where: string): string {
  const sp = where.indexOf(' ')
  const kind = sp < 0 ? where : where.slice(0, sp)
  const rest = sp < 0 ? '' : `.${where.slice(sp + 1)}`
  return `${kindWhere(kind)}${rest}`
}

// 'plan/task/note' → 'spec.kinds.plan.subKinds.task.subKinds.note'
function kindWhere(kind: string): string {
  const [k, ...subs] = kind.split('/')
  return `spec.kinds.${k}${subs.map((x) => `.subKinds.${x}`).join('')}`
}

function placeholderNames(tpl: string): string[] {
  const out: string[] = []
  for (const m of tpl.matchAll(FIELD_PLACEHOLDER)) {
    for (const alt of m[1]!.split('||').map((s) => s.trim())) if (NAME.test(alt)) out.push(alt)
  }
  return out
}

function columnKnown(c: string, info: KindInfo, list: 'columns' | 'facets'): boolean {
  if (c === 'agent' || c === 'folder' || c === 'identity' || c === 'state' || c === 'at') return true
  // count(<children>) / last(<children>): a column over a sub-kind
  const child = childColumn(c)
  if (child) return list === 'columns' && child.coll in info.dict.collections
  // project: the anchored agent's folder, a facet only — it exists
  // only where the kind anchors to an agent
  // — or where the kind itself declares a `project` field (a kernel kind's
  // main checkout: worktree)
  if (c === 'project') {
    const env = isObj(info.spec.envelope) ? info.spec.envelope : {}
    if (info.dict.fields.project?.type === 'string') return true
    return list === 'facets' && (Array.isArray(env.anchors) ? env.anchors : []).some((a) => isObj(a) && a.hub === 'agent')
  }
  const [head, part] = c.split('.')
  const f = info.dict.fields[head!]
  if (!f) return false
  return part === undefined || (f.type === 'money' && (part === 'amount' || part === 'currency'))
}

// Names the owner can write in a kind: set-field fields (and `state` when its
// mapped field is one of them).
function ownerWritableNames(info: KindInfo, actions: Json[]): Set<string> {
  const out = new Set<string>()
  for (const a of actions) {
    if (a.verb !== 'set-field') continue
    if ((isStr(a.subKind) ? a.subKind : a.kind) !== info.name) continue
    for (const f of Object.keys(isObj(a.fields) ? a.fields : {})) out.add(f)
  }
  const env = isObj(info.spec.envelope) ? info.spec.envelope : {}
  const stField = isObj(env.state) && isStr(env.state.field) ? env.state.field : null
  if (stField && out.has(stField)) out.add('state')
  return out
}

// the zero pulse, said in the preview: «0 cases», «nothing outstanding»
function zeroPulse(m: Json): string {
  const p = ((m.spec as Json).surfaces as Json).pulse as Json
  const label = isObj(p.label) ? p.label : {}
  if (p.aggregate === 'sum') {
    const w = isStr(label.term) ? label.term : isStr(label.many) ? label.many : ''
    return `nothing${w ? ` ${w}` : ''}`
  }
  const noun = String(p.kind).split('/').pop()!
  return `0 ${isStr(label.many) ? label.many : pluralOf(noun)}`
}

function previewOf(m: Json, kinds: Map<string, KindInfo>, ctx: ValidatorContext, now: number): Preview {
  const id = String((m.metadata as Json).id)
  const topOrNone = [...kinds.values()].find((k) => !k.parent)
  // an edge-only silo has no records to preview: its relations are drawn
  // by the owner after the approval
  if (!topOrNone) {
    const edges = Array.isArray((m.spec as Json).relations) && ((m.spec as Json).relations as unknown[]).length > 0
    return {
      from: 'examples',
      basis: edges
        ? 'an edge-only silo — no records; the owner draws its relations after the approval'
        : 'a look only — no records; approving makes it a choice in Settings › Appearance',
      pulse: null,
      needsYou: [],
      list: null,
    }
  }
  const top = topOrNone
  let base: KindRecord[] = []
  let from: Preview['from'] = 'examples'
  let basis = ''
  const kernelData = (Array.isArray((m.spec as Json).sources) ? ((m.spec as Json).sources as Json[]) : []).some((s) => s.root === 'kernel')
  if (ctx.reader) {
    const r = ctx.reader.read(id, m, { now, ...(ctx.isAgent ? { isAgent: ctx.isAgent } : {}) })
    if (r.records.length > 0) {
      base = r.records.map((x) => ({ rec: x.record, anchors: x.anchors as Json, key: `${x.location}/${x.record.id}`, file: x.file || null }))
      from = 'records'
      basis = `from ${r.records.length} record${r.records.length === 1 ? '' : 's'} ${kernelData ? 'Silos holds' : 'on disk'}${r.unreadable.length > 0 ? ` (${r.unreadable.length} more can't be read)` : ''}`
    }
  }
  if (from === 'examples') {
    const exs = Array.isArray(top.spec.examples) ? top.spec.examples : []
    for (const ex of exs) {
      const b = readRecordValue(m, top.name, ex, exampleFileId(m, top.name, ex), { now, ...(ctx.isAgent ? { isAgent: ctx.isAgent } : {}) })
      if (b.ok) base.push({ rec: b.record, anchors: {}, key: `example/${b.record.id}`, file: null })
    }
    basis = `from the ${base.length} example${base.length === 1 ? '' : 's'} — ${kernelData ? 'Silos holds none yet' : 'no records on disk yet'}`
  }
  const v: Voice = { now, ...(ctx.isAgent ? { isAgent: ctx.isAgent } : {}) }
  const spec = m.spec as Json
  const surfaces = isObj(spec.surfaces) ? spec.surfaces : {}
  const pt = pulseTerm(m, kinds, base, v)
  // the preview says the term even at zero — the author needs to see its words
  const pulse = pt === null ? null : pt !== '' ? pt : zeroPulse(m)

  // needs-you rows: what the inbox shows for each entry
  const nyKind = needsYouKind(m)
  const needsYou: Preview['needsYou'] = []
  if (nyKind && kinds.has(nyKind)) {
    const info = kinds.get(nyKind)!
    const term = terminalsOf(info)
    const all = recordsOfKind(kinds, base, nyKind)
    for (const n of (Array.isArray(surfaces['needs-you']) ? surfaces['needs-you'] : []).filter(isObj)) {
      const matches = all.filter((x) => !term.has(String(x.rec.state)) && holds(n.when, info, x, v))
      needsYou.push({
        urgency: String(n.urgency),
        matches: matches.length,
        row: matches[0] ? sayRow(info, matches[0], v) : null,
        sample: matches[0] ? null : all[0] ? sayRow(info, all[0], v) : null,
        ...(n.audience === 'producer-agent' && n.urgency !== 'blocking' ? { audience: 'producer-agent' as const } : {}),
      })
    }
  }

  // the list row: the first list view's columns
  let list: string | null = null
  const lv = (Array.isArray(spec.views) ? spec.views : []).filter(isObj).find((v) => v.archetype === 'list')
  if (lv) {
    const info = kinds.get(String(lv.kind))
    const first = info ? recordsOfKind(kinds, base, info.name)[0] : undefined
    if (info && first) {
      const cols = Array.isArray(lv.columns) && lv.columns.length > 0 ? (lv.columns as unknown[]).filter(isStr) : ['identity', 'state', 'at']
      list = cols.map((c) => cell(c, first.rec, info, first.anchors)).join(' · ')
    }
  }
  return { from, basis, pulse, needsYou, list }
}

// ── drafts ──────────────────────────────────────────────────────────────────

// a list view's `fold.label`: a few words, one line
export const FOLD_LABEL_MAX = 60
export const VIEW_LABEL_MAX = 40
export const DRAFT_MAX_BYTES = 256 * 1024
const SAFE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/

export function draftPath(agentStateBase: string, agentId: string, id: string): string | null {
  if (!SAFE.test(agentId) || !/^[a-z0-9][a-z0-9-]*$/.test(id)) return null
  return join(agentStateBase, agentId, 'silo-drafts', `${id}.json`)
}

// A draft manifest from the author's agent state: a regular file, small,
// parsed — or the reason it can't be. Read through safe-file.ts (sixth
// review round): silo-drafts/ is the author's OWN real dir (never a link into
// another agent's state or Silos' data), the draft a regular single-link file
// opened without following a link. The reasons never echo the file — no
// parse snippet, no key — and a refused folder answers the same for every
// name, so nothing outside the author's own drafts can be probed.
export function readDraft(agentStateBase: string, agentId: string, id: string): { path: string; value: unknown } | { error: string } {
  const path = draftPath(agentStateBase, agentId, id)
  if (path === null) return { error: 'the draft is named by an agent id and a silo id (lowercase letters, digits and -)' }
  let dir: string | null
  try {
    dir = agentDir(agentStateBase, agentId, ['silo-drafts'], { create: false })
  } catch {
    return { error: "the draft doesn't read: silo-drafts/ must be a real folder in the author's own state, not a link" }
  }
  let r: ReturnType<typeof readContained>
  try {
    r = dir === null ? null : readContained(dir, `${id}.json`, { maxBytes: DRAFT_MAX_BYTES })
  } catch (e) {
    if (e instanceof ContainmentError && /larger than/.test(e.message)) return { error: `the draft is larger than ${DRAFT_MAX_BYTES / 1024} KB` }
    return { error: "the draft doesn't read: it must be a regular file with one name in the author's own silo-drafts/ (not a link)" }
  }
  if (r === null) return { error: `no draft at ${path}` }
  try {
    return { path, value: JSON.parse(r.data.toString('utf8')) }
  } catch {
    return { error: 'the draft is not valid JSON' }
  }
}

// The draft a body names, read on whose authority: the owner reads any
// agent's draft; an agent bearer only its own — `agent` absent means itself,
// another agent named is refused with the same words whether that draft
// exists or not (validate and submit share it: one rule, one source).
export function readDraftAs(
  agentStateBase: string,
  draft: Json,
  by: string,
  verb: 'validate' | 'submit',
): { path: string; value: unknown } | { code: number; error: string } {
  if (by !== 'owner' && draft.agent !== undefined && draft.agent !== by) return { code: 403, error: `${by} may only ${verb} its own drafts` }
  const agent = by === 'owner' ? String(draft.agent ?? '') : by
  const d = readDraft(agentStateBase, agent, String(draft.id ?? ''))
  return 'error' in d ? { code: d.error.startsWith('no draft') ? 404 : 400, error: d.error } : d
}

// ── POST /api/silos/validate ────────────────────────────────────────────────

// `by`: whose credential asks — 'owner' or the agent its bearer names
export interface ValidateRoute {
  (body: unknown, by?: string): { code: number; body: unknown }
}

// Body: { manifest } (validate what is sent) or { draft: { agent?, id } } (a
// draft at its canonical path). Open to agent bearers (agent-authz.ts); what
// it reads is bounded by the asker (silos/bearer-scope.ts): an agent's draft
// only, and a dry-run over `readerFor(agent)` — its own state and the
// project folders of its territories — never `reader`, the owner's view of
// every location. Without readerFor an agent's preview reads no records:
// the examples speak.
export function createSiloValidate(ctx: ValidatorContext & { agentStateBase: string; readerFor?: (agentId: string) => SiloReader }): ValidateRoute {
  return (body, by = 'owner') => {
    const { agentStateBase, readerFor, reader, ...rest } = ctx
    const r = by === 'owner' ? reader : readerFor?.(by)
    const opts: ValidatorContext = { ...rest, ...(r ? { reader: r } : {}), now: Date.now() }
    if (isObj(body) && body.manifest !== undefined) return { code: 200, body: validateSilo(body.manifest, opts) }
    if (isObj(body) && isObj(body.draft)) {
      const d = readDraftAs(agentStateBase, body.draft, by, 'validate')
      if ('error' in d) return { code: d.code, body: { error: d.error } }
      return { code: 200, body: { ...validateSilo(d.value, opts), state: 'draft', draft: d.path } }
    }
    return { code: 400, body: { error: 'send {"manifest": …} or {"draft": {"id": …, "agent"?: …}}' } }
  }
}
