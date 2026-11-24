// silos/catalog.ts — the silos this Silos DISTRIBUTES: the standard's
// reference manifests (docs/standard/reference/*.silo.json, shipped in the
// Docker image). Two tiers, one folder: the RECOMMENDED ones (native.ts
// `builtin` rows: Plans, Task mode, System) are installed at boot; every
// other file is OPTIONAL (Support, Hierarchy, Executions, Heather) —
// Settings › Silos lists it under «Optional» and installing one is the SAME
// gesture as any submission — the catalog is only a transport into
// installer.submit(manifest, 'owner'): validation, the consequences dialog
// and the approval click stay the only door.
//
// Available = a reference manifest whose id this Silos holds NOWHERE: not in
// the registry (installed or pending), no submission waiting, no operator
// decision (an uninstalled silo lives in its own group with Reinstall…), and
// not a kernel word. One id, one home.
//
// Nor a dimension Silos still serves NATIVELY (silos/native.ts): its
// reference manifest validates, but installing it would show the same
// dimension twice — the native code and the silo (Plans).
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { HOUSE_DIMENSIONS, REFERENCE_DIR, type Dimensions } from './native.js'

export { REFERENCE_DIR }

export interface AvailableSilo {
  id: string
  name: string | null
  description: string | null
  version: string | null
  // spec.producer.role: who keeps it filled — null or 'kernel' needs no
  // agent (the first run offers only those)
  producerRole: string | null
}

export interface CatalogDeps {
  dir?: string // tests point at a fixture dir
  // every id this Silos already holds somewhere (registry, submissions,
  // operator decisions, kernel + approved reservations) — the caller knows
  heldIds: () => Set<string>
  // the dimensions table (native ids are never offered) — tests pass a fixture
  dimensions?: Pick<Dimensions, 'nativeRefusal'> & Partial<Pick<Dimensions, 'isBuiltin'>>
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null)

// one reference file, read tolerantly: a file that is not a manifest with an
// id is not an offer (the reference suite proves the shipped four read; a
// broken one is a repo bug its tests catch, never a crash here)
function readOffer(dir: string, file: string): AvailableSilo | null {
  try {
    const raw = JSON.parse(readFileSync(join(dir, file), 'utf8')) as unknown
    if (!isObj(raw) || !isObj(raw.metadata)) return null
    const id = str(raw.metadata.id)
    if (id === null) return null
    const producer = isObj(raw.spec) && isObj(raw.spec.producer) ? raw.spec.producer : null
    return {
      id,
      name: str(raw.metadata.name),
      description: str(raw.metadata.description),
      version: str(raw.metadata.version),
      producerRole: producer ? str(producer.role) : null,
    }
  } catch {
    return null
  }
}

export function availableSilos(deps: CatalogDeps): AvailableSilo[] {
  const dir = deps.dir ?? REFERENCE_DIR
  if (!existsSync(dir)) return []
  let files: string[]
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.silo.json'))
  } catch {
    return []
  }
  const held = deps.heldIds()
  const dims = deps.dimensions ?? HOUSE_DIMENSIONS
  const out: AvailableSilo[] = []
  const seen = new Set<string>()
  for (const f of files.sort()) {
    const offer = readOffer(dir, f)
    // a builtin comes with Silos: the boot installs it, and after an uninstall
    // its door back is Reinstall… — never «Available»
    if (!offer || held.has(offer.id) || seen.has(offer.id) || dims.nativeRefusal(offer.id) !== null || dims.isBuiltin?.(offer.id) === true) continue
    seen.add(offer.id)
    out.push(offer)
  }
  return out
}

// Where an id stands in what Silos ships: recommended (a builtin row),
// optional (any other reference manifest), or null — a silo of the owner's
// own (submitted, pasted, drafted by an agent). Settings › Silos groups by it.
export type Lineup = 'recommended' | 'optional'
export function shippedLineup(deps: Pick<CatalogDeps, 'dir' | 'dimensions'> = {}): (id: string) => Lineup | null {
  const dir = deps.dir ?? REFERENCE_DIR
  const dims = deps.dimensions ?? HOUSE_DIMENSIONS
  const shipped = new Set<string>()
  try {
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.silo.json'))) {
      const offer = readOffer(dir, f)
      if (offer) shipped.add(offer.id)
    }
  } catch {
    /* no reference dir: nothing ships optional */
  }
  return (id) => (dims.isBuiltin?.(id) === true ? 'recommended' : shipped.has(id) && dims.nativeRefusal(id) === null ? 'optional' : null)
}

// The manifest of one available silo, for the submit gesture — only ids the
// listing offers (held ids answer null so the route 404s honestly).
export function availableManifest(deps: CatalogDeps, id: string): Record<string, unknown> | null {
  if (!availableSilos(deps).some((a) => a.id === id)) return null
  const dir = deps.dir ?? REFERENCE_DIR
  for (const f of readdirSync(dir)
    .filter((x) => x.endsWith('.silo.json'))
    .sort()) {
    try {
      const raw = JSON.parse(readFileSync(join(dir, f), 'utf8')) as unknown
      if (isObj(raw) && isObj(raw.metadata) && raw.metadata.id === id) return raw
    } catch {
      /* readOffer already skipped it */
    }
  }
  return null
}
