// silos/manifest.ts — reading a silo.json against the Silo Standard v0
// (docs/standard/silo.schema.json, draft 2020-12, validated with ajv).
//
// The schema is closed (additionalProperties: false everywhere) but the
// standard splits unknown fields in two classes (silo-standard-v0.md
// «Versioning», conformance.md §1):
//   ADDITIVE    — unknown ⇒ load what is understood, the field goes to `wants`
//   RESTRICTIVE — unknown ⇒ the silo is REJECTED with a reason (must-understand)
// Every spec field of v0 is additive and the restrictive class is EMPTY in v0
// (its first planned member is `sensitive`, annex) — the rule already holds:
// RESTRICTIVE_FIELDS is the list a kernel consults, empty today.
//
// The CONVENTION of each source is DERIVED from its canonical root — the root
// class plus the glob's static directory prefix — never read from a manifest
// field (a manifest can't declare which data it owns; where its records live
// says it).
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Ajv2020, type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js'
import { confineGlob } from './files-source.js'
import { KERNEL_KINDS, KERNEL_KINDS_VERSION, kernelKind } from './kernel-kinds.js'

// An unknown kernel kind is an ERROR, not a want: the rule of additive fields
// speaks of FIELDS, and a value of a catalog this kernel does not publish
// leaves the silo nothing to read (the same reading as an unknown
// archetype value).
export function kernelKindMissing(source: string, kind: string): string {
  return `source ${source}: this Silos publishes no kernel kind ${JSON.stringify(kind)} (${KERNEL_KINDS_VERSION}: ${Object.keys(KERNEL_KINDS).join(', ')})`
}

// The signed standard's schema, read from the repo (docs/standard/). The
// Docker image ships docs/standard/ too (Dockerfile copies it; .dockerignore
// re-includes only that subfolder) so container deploys validate the same way.
export const DEFAULT_SCHEMA_PATH = join(import.meta.dirname, '..', '..', '..', 'docs', 'standard', 'silo.schema.json')

// Unknown fields this kernel must understand to approve a silo. Matched by
// the field's name. Empty in v0 by the standard (catalogs.md «Schema
// field classes»): a v0.x field lands here when the standard publishes it as
// restrictive and this kernel does not implement it yet.
export const RESTRICTIVE_FIELDS: readonly string[] = []

export interface SourceConvention {
  source: string // the source's id
  root: string // agent-state | project
  glob: string
  convention: string // `<root>:<static prefix>` — e.g. agent-state:silos/invoices
  dir: string // the folder name under ~/.silos/silos/conventions/
}

export type ManifestReading =
  | { ok: true; manifest: Record<string, unknown>; wants: string[]; conventions: SourceConvention[] }
  | { ok: false; reason: string; wants: string[]; restrictive: string[] }

const cache = new Map<string, ValidateFunction | Error>()

function validatorFor(schemaPath: string): ValidateFunction | Error {
  const hit = cache.get(schemaPath)
  if (hit) return hit
  let v: ValidateFunction | Error
  try {
    const schema = JSON.parse(readFileSync(schemaPath, 'utf8')) as object
    v = new Ajv2020({ allErrors: true, verbose: true, strict: false }).compile(schema)
  } catch (err) {
    v = new Error(`the Silo Standard schema could not be read (${schemaPath}): ${err instanceof Error ? err.message : String(err)}`)
  }
  cache.set(schemaPath, v)
  return v
}

// 'spec.sources[0].root' from '/spec/sources/0/root'
function where(instancePath: string, extra?: string): string {
  const segs = instancePath
    .split('/')
    .slice(1)
    .map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'))
  if (extra !== undefined) segs.push(extra)
  let out = ''
  for (const s of segs) out += /^\d+$/.test(s) ? `[${s}]` : out === '' ? s : `.${s}`
  return out
}

const show = (v: unknown): string => JSON.stringify(v)

function explain(e: ErrorObject): string {
  const at = where(e.instancePath) || 'the manifest'
  const p = e.params as Record<string, unknown>
  switch (e.keyword) {
    case 'required':
      return `${at} is missing ${String(p.missingProperty)}`
    // a name a closed map does not take (propertyNames: a theme's tokens)
    case 'enum':
      if (typeof e.propertyName === 'string')
        return `${at} has ${show(e.propertyName)}, which is not one of ${(p.allowedValues as unknown[]).map(String).join(', ')}`
      return `${at} must be one of ${(p.allowedValues as unknown[]).map(String).join(', ')} (found ${show(e.data)})`
    case 'const':
      return `${at} must be ${show(p.allowedValue)} (found ${show(e.data)})`
    case 'type':
      return `${at} must be ${String(p.type)} (found ${Array.isArray(e.data) ? 'a list' : e.data === null ? 'null' : typeof e.data})`
    case 'pattern':
      return `${at} ${show(e.data)} does not have the expected form ${String(p.pattern)}`
    case 'minItems':
      return `${at} needs at least ${String(p.limit)} item${p.limit === 1 ? '' : 's'}`
    case 'maxItems':
      return `${at} takes at most ${String(p.limit)} items`
    case 'minProperties':
      return `${at} needs at least ${String(p.limit)} entr${p.limit === 1 ? 'y' : 'ies'}`
    case 'minLength':
      return `${at} cannot be empty`
    case 'dependentRequired':
      return `${at} has ${String(p.property)} but is missing ${String(p.missingProperty)} — a silo that reads records declares its producer, sources and kinds together`
    case 'minimum':
      return `${at} must be at least ${String(p.limit)}`
    case 'oneOf':
      return `${at} must match exactly one of its allowed shapes${p.passingSchemas ? ' (it matches several)' : ''}`
    case 'anyOf':
      return `${at} does not match any of its allowed shapes`
    case 'propertyNames':
      return `${at} has a name that does not have the expected form`
    default:
      return `${at} ${e.message ?? 'is not valid'}`
  }
}

// The schema errors as plain sentences: the noise of a failed anyOf/oneOf's
// branches folds into the one line that names the shape.
function explainAll(errors: readonly ErrorObject[]): Array<{ where: string; message: string }> {
  const shapes = errors.filter((e) => e.keyword === 'anyOf' || e.keyword === 'oneOf').map((e) => e.instancePath)
  // an if/then's own line («must match "then" schema») says nothing the
  // branch's errors don't say better
  // a propertyNames line says less than the name-level error under it
  const named = new Set(errors.filter((e) => e.keyword !== 'propertyNames' && typeof e.propertyName === 'string').map((e) => e.instancePath))
  const kept = errors
    .filter((e) => e.keyword !== 'if' && !(e.keyword === 'propertyNames' && named.has(e.instancePath)))
    .filter((e) => e.keyword === 'anyOf' || e.keyword === 'oneOf' || !shapes.some((s) => e.instancePath === s || e.instancePath.startsWith(s + '/')))
  const seen = new Set<string>()
  const out: Array<{ where: string; message: string }> = []
  // fields a branch forbids (`"glob": false` on a kernel source) fold into
  // ONE line per object: «spec.sources[0] carries glob, parser — …»
  const forbidden = new Map<string, string[]>()
  for (const e of kept) {
    if (e.keyword !== 'false schema') continue
    const parent = e.instancePath.slice(0, e.instancePath.lastIndexOf('/'))
    forbidden.set(parent, [...(forbidden.get(parent) ?? []), e.instancePath.slice(e.instancePath.lastIndexOf('/') + 1)])
  }
  for (const [parent, names] of forbidden) {
    const at = where(parent) || 'the manifest'
    const message = names.includes('kind')
      ? `${at} carries kind, which only a kernel source names (a files source reads globs)`
      : `${at} carries ${names.join(', ')}, which a kernel source does not take — it reads no files`
    out.push({ where: at, message })
    seen.add(message)
  }
  for (const e of kept) {
    if (e.keyword === 'false schema') continue
    const message = explain(e)
    if (seen.has(message)) continue
    seen.add(message)
    out.push({ where: where(e.instancePath) || 'the manifest', message })
  }
  return out
}

function removeAt(obj: unknown, instancePath: string, prop: string): void {
  let cur: unknown = obj
  for (const s of instancePath.split('/').slice(1)) {
    if (typeof cur !== 'object' || cur === null) return
    cur = (cur as Record<string, unknown>)[s.replace(/~1/g, '/').replace(/~0/g, '~')]
  }
  if (typeof cur === 'object' && cur !== null) delete (cur as Record<string, unknown>)[prop]
}

// The convention of a source: its root class + the glob's static directory
// prefix (the segments before the first wildcard, minus the file pattern).
// A glob that escapes its root or names no directory of its own derives none.
export function deriveConvention(source: { id?: unknown; root?: unknown; glob?: unknown; kind?: unknown }): SourceConvention | { error: string } {
  const id = typeof source.id === 'string' ? source.id : '?'
  const root = String(source.root)
  // a kernel source reads no files: its convention is the kernel kind it
  // presents — `kernel:<kind>`, a namespace no files source can derive (their
  // roots are agent-state and project), so the journal of kernel data never
  // collides with anyone's files and needs no reserved-name list
  if (root === 'kernel') {
    const kind = typeof source.kind === 'string' ? source.kind : ''
    if (!/^[a-z][a-z0-9_-]*$/.test(kind)) return { error: `source ${id}: a kernel source names the kernel kind it presents` }
    const convention = `kernel:${kind}`
    return { source: id, root, glob: '', convention, dir: encodeURIComponent(convention) }
  }
  const glob = typeof source.glob === 'string' ? source.glob : ''
  if (glob === '') return { error: `source ${id} has no glob` }
  if (glob.startsWith('/') || glob.includes('\\') || /^[A-Za-z]:/.test(glob))
    return { error: `source ${id}: the glob ${show(glob)} must be relative to its ${root} root` }
  const segs = glob.split('/').filter((s) => s !== '' && s !== '.')
  if (segs.includes('..')) return { error: `source ${id}: the glob ${show(glob)} climbs out of its ${root} root with ".."` }
  const prefix: string[] = []
  for (const s of segs.slice(0, -1)) {
    if (/[*?[\]{}!]/.test(s)) break
    prefix.push(s)
  }
  if (prefix.length === 0)
    return { error: `source ${id}: the glob ${show(glob)} names no folder of its own under ${root} — a source's records live in a named folder` }
  const convention = `${root}:${prefix.join('/')}`
  return { source: id, root, glob, convention, dir: encodeURIComponent(convention) }
}

export interface ReadOptions {
  schemaPath?: string
  restrictive?: readonly string[] // tests inject members; production = RESTRICTIVE_FIELDS
}

// Validate a parsed silo.json: schema (with the additive/restrictive split),
// then the derived conventions. Never throws.
// Conformance check 1 on its own: the schema, with the additive/restrictive
// split. `errors` are plain sentences, each starting with its position.
export interface SchemaReading {
  manifest: Record<string, unknown> | null // what was understood (wants stripped); null when not an object
  wants: string[]
  restrictive: string[]
  errors: Array<{ where: string; message: string }>
  fatal: string | null // the schema itself can't be read, or the input isn't an object
}

export function schemaCheck(raw: unknown, opts: ReadOptions = {}): SchemaReading {
  const validate = validatorFor(opts.schemaPath ?? DEFAULT_SCHEMA_PATH)
  if (validate instanceof Error) return { manifest: null, wants: [], restrictive: [], errors: [], fatal: validate.message }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
    return { manifest: null, wants: [], restrictive: [], errors: [], fatal: 'silo.json must hold a JSON object' }
  const restrictiveNames = new Set(opts.restrictive ?? RESTRICTIVE_FIELDS)
  const clone = structuredClone(raw) as Record<string, unknown>
  const wants: string[] = []
  const restrictive: string[] = []
  let valid = validate(clone)
  // Strip the unknown fields one round at a time (a stripped field can hide
  // another error under it) until only real errors — or none — are left.
  for (let round = 0; !valid && round < 32; round++) {
    const unknown = (validate.errors ?? []).filter((e) => e.keyword === 'additionalProperties')
    if (unknown.length === 0) break
    for (const e of unknown) {
      const prop = String((e.params as { additionalProperty: string }).additionalProperty)
      const path = where(e.instancePath, prop)
      if (restrictiveNames.has(prop)) {
        if (!restrictive.includes(path)) restrictive.push(path)
      } else if (!wants.includes(path)) wants.push(path)
      removeAt(clone, e.instancePath, prop)
    }
    valid = validate(clone)
  }
  const errors = valid ? [] : explainAll(validate.errors ?? [])
  return { manifest: clone, wants, restrictive, errors, fatal: null }
}

export function restrictiveReason(restrictive: readonly string[]): string {
  return `this silo needs ${restrictive.join(', ')}, which this Silos does not understand and must not ignore — it can't be approved until Silos is updated`
}

export function readManifest(raw: unknown, opts: ReadOptions = {}): ManifestReading {
  const sc = schemaCheck(raw, opts)
  if (sc.fatal !== null) return { ok: false, reason: sc.fatal, wants: [], restrictive: [] }
  const { wants, restrictive } = sc
  if (restrictive.length > 0) return { ok: false, reason: restrictiveReason(restrictive), wants, restrictive }
  if (sc.errors.length > 0) {
    const lines = sc.errors.map((e) => e.message)
    return {
      ok: false,
      reason: `the manifest does not follow the Silo Standard: ${lines.slice(0, 5).join('; ')}${lines.length > 5 ? ` (and ${lines.length - 5} more)` : ''}`,
      wants,
      restrictive,
    }
  }
  const clone = sc.manifest!
  // an edge-only silo (spec.relations, step 4) has no sources: nothing to read
  const sources = ((clone.spec as Record<string, unknown>).sources as Array<Record<string, unknown>> | undefined) ?? []
  const conventions: SourceConvention[] = []
  for (const s of sources) {
    const c = deriveConvention(s)
    if ('error' in c) return { ok: false, reason: c.error, wants, restrictive }
    if (c.root === 'kernel') {
      if (!kernelKind(String(s.kind))) return { ok: false, reason: kernelKindMissing(c.source, String(s.kind)), wants, restrictive }
      conventions.push(c)
      continue
    }
    const confined = confineGlob({ id: c.source, root: c.root, glob: c.glob })
    if (confined !== null) return { ok: false, reason: confined, wants, restrictive }
    conventions.push(c)
  }
  return { ok: true, manifest: clone, wants, conventions }
}

// The ids of the STANDING records of a kind (R1): those an `ensure-record`
// action of the manifest reserves for it — plans: `tasks`, the project's
// list. Neutral code reads this, never a name.
export function standingIdsOf(manifest: Record<string, unknown>, kind: string): Set<string> {
  const spec = typeof manifest.spec === 'object' && manifest.spec !== null ? (manifest.spec as Record<string, unknown>) : {}
  const actions = Array.isArray(spec.actions) ? spec.actions : []
  const out = new Set<string>()
  for (const a of actions) {
    if (typeof a !== 'object' || a === null) continue
    const x = a as Record<string, unknown>
    if (x.verb === 'ensure-record' && x.kind === kind && typeof x.id === 'string' && x.id !== '') out.add(x.id)
  }
  return out
}

export function hashText(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16)
}
