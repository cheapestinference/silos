// silos/native.ts — the dimensions that come WITH Silos. ONE table, and
// each row says how this Silos serves that dimension today:
//
//   native   written in Silos' own code (none left: support,
//            plans and executions all moved to silos).
//            Its manifest may already exist on paper (docs/standard/
//            reference/) and validate, but it must NEVER enter through the
//            door: an installed silo next to the native code is the same
//            dimension counted twice (once Plans installed from Available
//            → Home said «18 tasks on you» from the silo on top of the 22
//            native plan rows). So while a row is native the catalog never
//            offers it, a submission or a resubmission of its id is refused
//            in plain words, and an approval of one submitted before this
//            guard existed is refused too.
//   builtin  a RECOMMENDED silo — its manifest ships with Silos and the
//            platform installs it AT BOOT: born active without the approval
//            dialog, journaled as a visible event («Silos installed Plans
//            0.8.1 — comes with Silos»), provenance `builtin` in
//            operator.json (the author is Silos itself; the records'
//            producer stays an agent). Removable: `loses` is what the
//            uninstall confirmation says the owner gives up, and an owner's
//            uninstall is respected forever — the next boot never brings it
//            back; the door back is the normal one (Settings › Silos ›
//            Reinstall…, or the quiet door where its feature would be).
//
// Every other manifest in docs/standard/reference/ is OPTIONAL: offered by
// the catalog (catalog.ts), installed only by the owner's click.
//
//   engine   configuration the ENGINE consumes, not records an agent
//            produces: memories, skills and MCPs. Their truth is
//            the engine's own files (Claude Code is sacred: .claude/skills,
//            settings, native memory; OpenCode's permission.skill), read and
//            toggled through the harness contract — the floor no manifest declares, like
//            accounts and providers. They never become silos, and the door
//            refuses their ids like a native one's, in their own words.
//
// Moving a dimension from `native` to `builtin` is ONE edit of `served`
// below, made only once the silo shows what the native code showed, and in
// the same commit that deletes the native code. What stays of plans in code
// is the FLOOR no manifest can declare (plans-floor.ts: the wake trigger,
// the mission's progress — both reading the silo).
//
// A builtin's manifest IS its reference manifest (docs/standard/reference/
// <file>): every built-in publishes its manifest as a
// reference manifest, so the shipped file and the published proof are one
// file — a second copy under another folder would be two truths that drift.
import { existsSync, lstatSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { MANIFEST_MAX_BYTES } from './registry.js'

// the repo's reference dir — resolved like DEFAULT_SCHEMA_PATH (manifest.ts):
// three levels up from server/src|dist/silos, /app/docs/standard in the image.
// Defined here (catalog.ts re-exports it) so the two modules never import in a cycle.
export const REFERENCE_DIR = join(import.meta.dirname, '..', '..', '..', 'docs', 'standard', 'reference')

export type Served = 'native' | 'builtin' | 'engine'

export interface Dimension {
  id: string // the silo id its manifest has (or will have)
  name: string // the dimension in the house's words
  served: Served
  manifest?: string // the reference manifest's file name, when one exists
  // slots a builtin is born with OFF (operator slotsOff) — the owner decides,
  // turned on later by the operator like any slot; never a manifest edit
  slotsOff?: readonly string[]
  // a recommended silo: what the owner gives up by uninstalling it, in one
  // plain sentence — the uninstall confirmation and the first run say it
  loses?: string
}

// The house table. Plans, Task mode and System are the RECOMMENDED silos;
// Support and Executions, built in once, are optional now (the catalog
// offers them; an install that already holds them keeps them).
export const DIMENSIONS: readonly Dimension[] = [
  // born with its pulse OFF (phase-1 plan G10: Home's pulse does not
  // gain «19 tasks on you» — Needs you and Yours to do already say them)
  {
    id: 'plans',
    name: 'Plans',
    served: 'builtin',
    manifest: 'plans.silo.json',
    slotsOff: ['pulse'],
    loses: 'Tasks go away: the Tasks page, task pages and the tasks in Needs you — and your agents can no longer take, hand over or ask on a task.',
  },
  // part of the engine, never silos
  { id: 'memories', name: 'Memories', served: 'engine' },
  { id: 'skills', name: 'Skills', served: 'engine' },
  { id: 'mcps', name: 'MCPs', served: 'engine' },
  // Task mode comes with Silos — an install made through the door before is
  // ADOPTED with every choice kept (installer.ts installBuiltins), never
  // re-installed over the owner's word
  {
    id: 'task-mode',
    name: 'Task mode',
    served: 'builtin',
    manifest: 'task-mode.silo.json',
    loses: 'Agents set to work on their own stop waking on their tasks — they move only when you speak to them.',
  },
  // the processes conversations left on this machine (kernel kinds
  // `process` and `worktree`) — born with its pulse OFF: Home's sentence
  // does not gain «3 processes left running» until the owner turns it on
  {
    id: 'system',
    name: 'System',
    served: 'builtin',
    manifest: 'system.silo.json',
    slotsOff: ['pulse'],
    loses: 'System loses its Processes and Worktrees lists, with Stop and Remove — what your conversations leave running is no longer shown.',
  },
]

// The dimensions that ran NATIVELY before becoming builtin — the only ids
// whose copy uninstalled or turned off through the door in that era is no
// decision about the built-in (installer.ts nativeEra). Fixed: a builtin
// that never ran natively (Task mode) was a silo all along, and the owner's
// uninstall of it is the owner's word.
export const NATIVE_ERA_IDS: ReadonlySet<string> = new Set(['plans'])

export interface BuiltinManifest {
  id: string
  name: string
  manifest: Record<string, unknown>
  slotsOff?: readonly string[]
}

// What the kernel asks of the table — injectable, so tests build the
// mechanism over a fixture and nothing real becomes builtin.
export interface Dimensions {
  // the plain words that refuse a native id at the door; null = not native
  nativeRefusal(id: string): string | null
  // the builtin ids, each with its manifest read from disk (or why not)
  builtins(): Array<BuiltinManifest | { id: string; name: string; error: string }>
  isBuiltin(id: string): boolean
  // a recommended silo's one sentence of what uninstalling it gives up; null otherwise
  loses(id: string): string | null
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

export function nativeWords(name: string): string {
  return `${name} comes with Silos — it already runs natively; it becomes a silo when Silos migrates it`
}

export function engineWords(name: string): string {
  return `${name} is part of the engine — Silos reads it from the engine's own files; it never becomes a silo`
}

// one manifest file, read like the registry reads one: a regular file,
// small, JSON, whose own id is the row's
function readBuiltin(dir: string, d: Dimension): BuiltinManifest | { id: string; name: string; error: string } {
  if (!d.manifest) return { id: d.id, name: d.name, error: `${d.name} is marked builtin but names no manifest` }
  const file = join(dir, d.manifest)
  try {
    if (!existsSync(file)) return { id: d.id, name: d.name, error: `its manifest ${d.manifest} is not in this Silos` }
    const st = lstatSync(file)
    if (!st.isFile()) return { id: d.id, name: d.name, error: `its manifest ${d.manifest} is not a regular file` }
    if (st.size > MANIFEST_MAX_BYTES) return { id: d.id, name: d.name, error: `its manifest ${d.manifest} is larger than ${MANIFEST_MAX_BYTES / 1024} KB` }
    const raw = JSON.parse(readFileSync(file, 'utf8')) as unknown
    if (!isObj(raw) || !isObj(raw.metadata) || raw.metadata.id !== d.id)
      return { id: d.id, name: d.name, error: `its manifest ${d.manifest} does not say id ${JSON.stringify(d.id)}` }
    return { id: d.id, name: d.name, manifest: raw, ...(d.slotsOff && d.slotsOff.length > 0 ? { slotsOff: d.slotsOff } : {}) }
  } catch (err) {
    return { id: d.id, name: d.name, error: `its manifest ${d.manifest} could not be read: ${err instanceof Error ? err.message : String(err)}` }
  }
}

export function dimensions(table: readonly Dimension[] = DIMENSIONS, dir: string = REFERENCE_DIR): Dimensions {
  const byId = new Map(table.map((d) => [d.id, d]))
  return {
    nativeRefusal: (id) => {
      const d = byId.get(id)
      if (!d) return null
      return d.served === 'native' ? nativeWords(d.name) : d.served === 'engine' ? engineWords(d.name) : null
    },
    builtins: () => table.filter((d) => d.served === 'builtin').map((d) => readBuiltin(dir, d)),
    isBuiltin: (id) => byId.get(id)?.served === 'builtin',
    loses: (id) => {
      const d = byId.get(id)
      return d?.served === 'builtin' ? (d.loses ?? null) : null
    },
  }
}

// the house's answer, built once
export const HOUSE_DIMENSIONS: Dimensions = dimensions()
