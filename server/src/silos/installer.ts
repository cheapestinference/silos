// silos/installer.ts — install, approve, uninstall (Silo Standard «Install,
// approve, update, uninstall»; step 1 Task 11). The server half of the approval
// dialog: what it shows comes from here, what the owner decides lands here.
//
//   submit      a manifest (or an agent's draft) is VALIDATED and, when it
//               validates, kept as a pending SUBMISSION —
//               <dataDir>/silos/submissions/<id>.json — never in the registry.
//               Every submission lands pending, the owner's too: activation
//               is a separate gesture, never implicit. An invalid one creates
//               nothing and answers the validator's errors.
//   consequences  everything the dialog shows, DERIVED: the exact paths it
//               will read, the slots with their preview sentences (real
//               records when there are any, examples when not — said), the
//               requirements per bound producer, wants, and on an update the
//               diff with every LOOSENING on its own line; the author's prose
//               apart, as a quote, never as authority.
//   approve     materializes the manifest in registry/<id>/silo.json,
//               records the decision, the producer binding (one or several
//               agents) and the slots switched off in operator.json, reserves
//               the id, and — opt-in — creates the sync automation.
//   reject      the submission moves aside with the owner's reason, said.
//   uninstall   non-destructive: the manifest moves to silos/uninstalled/,
//               the silo stops showing anywhere and its sync automation
//               pauses — records, overlay and journal stay where they are.
//               Files still growing afterwards become a Home term.
//   resubmit    the owner's door back (Settings › Silos): the
//               newest manifest kept at an uninstall — or the manifest a
//               registry-pending silo already holds — goes through submit()
//               like any other, so every check applies identically; the
//               dialog does the rest.
//
//   installBuiltins  at boot: every silo that comes WITH Silos (native.ts,
//               served 'builtin') and that the owner never decided on is
//               installed by the platform — validated like any manifest, born
//               active without the dialog, provenance 'builtin', and said as
//               an event («Silos installed Support 0.1.0 — comes with
//               Silos»). An id the owner uninstalled (or turned off) is left
//               as it is, at every boot — except a copy installed through the
//               door while that dimension still ran natively (Plans):
//               its uninstall was no decision about the built-in.
//
// A dimension Silos still serves NATIVELY (native.ts) never enters through
// this door: submit, resubmit and approve refuse its id in plain words.
//
// Reinstalling an approved id: the owner may, always (approval is the owner's
// gesture). A bearer may submit for an installed or once-approved id only if
// it is one of that silo's bound producers.
//
// Every submit, approval, rejection, update, uninstall and operator switch is
// an event in silos/events.jsonl.
import { randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteJson } from '../json-store.js'
import { SILOS_AUTHOR } from '../system-author.js'
import { MANIFEST_MAX_BYTES, SLOTS, type SiloEntry, type SiloRegistry } from './registry.js'
import type { OperatorSilo, SiloOperatorStore } from './operator.js'
import type { SiloKernel } from './kernel.js'
import type { SiloEvents } from './actions.js'
import { lookChange, readDraftAs, validateSilo, type Preview, type ValidationResult, type ValidatorContext } from './validator.js'
import { SiloReader } from './reader.js'
import { locationsFor, scanSource, type SiloLocations, type SourceSpec } from './files-source.js'
import { deriveConvention, type SourceConvention } from './manifest.js'
import type { SiloGrowthTerm, SiloNeedsYou } from './surfaces.js'
import type { Automation } from '../automations-types.js'
import { KEEP_ALIVE_DEFAULT } from '../automations-types.js'
import { bindsThroughKernel, producerBrief } from './producer-brief.js'
import type { VaultCredential } from '../vault-store.js'
import { kernelKind, kernelVerb, type KernelKindSources } from './kernel-kinds.js'
import { KERNEL_PRODUCER } from './validator.js'
import { HOUSE_DIMENSIONS, NATIVE_ERA_IDS, type BuiltinManifest, type Dimensions } from './native.js'
import { shippedLineup, type Lineup } from './catalog.js'
import { bearerLocations } from './bearer-scope.js'
import { resolveTheme } from './theme-rule.js'

type Json = Record<string, unknown>
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)
const isStr = (v: unknown): v is string => typeof v === 'string'

export interface Submission {
  id: string
  manifest: Json
  submittedBy: string // 'owner' or the submitting agent
  at: string
  source: 'body' | 'draft'
  draftPath?: string
  // who the owner's submission proposes to produce it (a role pack's install:
  // the agent it just made) — the dialog's default binding, never a bind
  producers?: string[]
}

export interface Answer {
  code: number
  body: unknown
}

// What Settings › Silos lists for a silo the owner uninstalled (GET /api/silos
// `uninstalled`): what stayed on disk, whether its producers kept writing, and
// whether a manifest was kept to reinstall from.
export interface UninstalledSilo {
  id: string
  name: string
  uninstalledAt: string | null
  producers: string[] // the agents bound at approval that still exist
  kept: { files: number; records: number | null; conventions: string[]; overlayAndJournal: string[] }
  grown: number // files written since the uninstall (the Home growth term)
  manifest: { version: string | null; keptAt: string } | null // the newest kept manifest; null = none kept
  automation: SiloAutomationState | null
  submission: PendingSubmission | null // a reinstall already waiting for the owner
  // the words that refuse a reinstall: the id is a dimension Silos still
  // serves natively (native.ts) — the page offers no Reinstall… then
  native: string | null
  provenance: 'builtin' | null // it came with Silos
}
export interface SiloAutomationState {
  id: string
  name: string
  paused: boolean
}
export interface PendingSubmission {
  at: string
  submittedBy: string
  version: string | null
}

export interface InstallerOptions {
  root: string // <dataDir>/silos
  // may agent `reader` see agent `id` named (project-scope.ts mayName)? A
  // submitter is told the ids of a silo's producers and of a pending
  // submitter only when it may; otherwise «another agent». Absent: always
  mayName?: (reader: string, id: string) => boolean
  registry: SiloRegistry
  operator: SiloOperatorStore
  kernel: Pick<SiloKernel, 'refresh' | 'reading'>
  events: SiloEvents
  locations: SiloLocations // every location (the owner's view)
  agentStateBase: string
  isAgent: (v: string) => boolean
  // an agent in play (listed, not archived): only these are proposed or
  // accepted as a silo's producers — an archived agent works no rows
  inPlay?: (v: string) => boolean
  hasBearer: (agentId: string) => boolean // every agent in play holds a token; an archived one none
  territoriesOf: (agentId: string) => string[]
  automations?: {
    create(a: Automation): Automation
    get(id: string): Automation | null
    update(id: string, patch: Partial<Omit<Automation, 'id'>>): Automation
  }
  messages?: { send(m: { from: string; to: string; text: string }): { id: string } }
  // the Vault entry NAMES an agent can count on (never values), delivered or
  // signed — the sync prompt says how to use each (VaultStore.credentialsFor)
  credentialNames?: (agentId: string) => VaultCredential[]
  schemaPath?: string
  now?: () => number
  // the kernel kinds a kernel source presents (kernel-kinds.ts) — read only
  // for the OWNER's dry-run: platform data is the owner's
  kernelKinds?: KernelKindSources
  // the dimensions that come with Silos (native.ts) — tests pass a fixture
  dimensions?: Dimensions
}

// what one boot did with one builtin silo (installBuiltins)
export interface BuiltinOutcome {
  id: string
  outcome: 'installed' | 'updated' | 'kept' | 'failed' | 'native-off' | 'adopted'
  says: string
}

const SILO_ID = /^[a-z0-9][a-z0-9-]*$/

// cadence → a cron the resident schedules, and the words for it
export function cronForCadence(cadence: string): { cron: string; says: string } | null {
  const m = /^(\d+)(m|h|d)$/.exec(cadence)
  if (!m) return null
  const n = Number(m[1])
  if (n <= 0) return null
  if (m[2] === 'm') return n < 60 && 60 % n === 0 ? { cron: `*/${n} * * * *`, says: `every ${n} minutes` } : null
  if (m[2] === 'h') {
    if (n === 24) return { cron: '0 0 * * *', says: 'every 24h, at 00:00 server time' }
    return n < 24 && 24 % n === 0 ? { cron: `0 */${n} * * *`, says: `every ${n}h, on the hour` } : null
  }
  return n === 1 ? { cron: '0 0 * * *', says: 'every day, at 00:00 server time' } : { cron: `0 0 */${n} * *`, says: `every ${n} days, at 00:00 server time` }
}

const KEPT_AT = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/

export class SiloInstaller {
  // files under each uninstalled silo's conventions: all of them and those
  // written since the uninstall (growth + Settings › Silos; cached a minute)
  private scanCache: { at: number; byId: Map<string, { files: number; grown: number }> } | null = null

  constructor(private o: InstallerOptions) {}

  // an agent id as `reader` may hear it: itself or one it may see named, else «another agent»
  private named(reader: string, id: string): string {
    return reader === 'owner' || this.o.mayName === undefined || this.o.mayName(reader, id) ? id : 'another agent'
  }

  private now(): number {
    return this.o.now?.() ?? Date.now()
  }
  private inPlay(a: string): boolean {
    return (this.o.inPlay ?? this.o.isAgent)(a)
  }
  private get dims(): Dimensions {
    return this.o.dimensions ?? HOUSE_DIMENSIONS
  }
  // the table this installer serves (the catalog asks the same one)
  get dimensions(): Dimensions {
    return this.dims
  }

  // the plain words that keep a natively served dimension out of the door
  // (null = not native) — the routes and the web read the same answer
  nativeRefusal(id: string): string | null {
    return this.dims.nativeRefusal(id)
  }

  // how a silo came: 'builtin' (with Silos) or null (through the door)
  provenanceOf(id: string): 'builtin' | null {
    return this.o.operator.get(id)?.provenance === 'builtin' ? 'builtin' : null
  }

  // where each id stands in what Silos ships (catalog.ts shippedLineup) and,
  // for a recommended one, what uninstalling it gives up (native.ts `loses`)
  lineup(): (id: string) => { lineup: Lineup | null; loses: string | null } {
    const of = shippedLineup({ dimensions: this.dims })
    return (id) => ({ lineup: of(id), loses: this.dims.loses(id) })
  }

  private get subsDir(): string {
    return join(this.o.root, 'submissions')
  }

  // ── submissions ──

  getSubmission(id: string): Submission | null {
    if (!SILO_ID.test(id)) return null
    try {
      return JSON.parse(readFileSync(join(this.subsDir, `${id}.json`), 'utf8')) as Submission
    } catch {
      return null
    }
  }

  submissions(): Array<Omit<Submission, 'manifest'> & { name: string | null; version: string | null; update: boolean }> {
    if (!existsSync(this.subsDir)) return []
    return readdirSync(this.subsDir)
      .filter((n) => n.endsWith('.json'))
      .flatMap((n) => {
        const s = this.getSubmission(n.slice(0, -5))
        if (!s) return []
        const meta = isObj(s.manifest.metadata) ? s.manifest.metadata : {}
        const { manifest: _m, ...rest } = s
        return [
          {
            ...rest,
            name: isStr(meta.name) ? meta.name : null,
            version: isStr(meta.version) ? meta.version : null,
            update: this.o.registry.get(s.id) !== null,
          },
        ]
      })
      .sort((a, b) => b.at.localeCompare(a.at))
  }

  // The registry entry a submission would UPDATE: one the owner decided on.
  // A manifest that sits in the registry `pending` (placed by hand, never
  // approved) is not installed — approving its submission is an install, not
  // «an update 0.1.0 → 0.1.0». An `error` entry stays an update:
  // it may be an approved silo whose manifest broke.
  private installed(id: string): SiloEntry | null {
    const e = this.o.registry.get(id)
    return e && e.status.state !== 'pending' ? e : null
  }

  // install / update / reinstall — what approving this submission would be
  private submissionKind(id: string): 'install' | 'update' | 'reinstall' {
    return this.installed(id) ? 'update' : this.o.registry.reservedIds().approved.includes(id) ? 'reinstall' : 'install'
  }

  // the submission of this id waiting for the owner, in one line
  pendingOf(id: string): PendingSubmission | null {
    const s = this.getSubmission(id)
    if (!s) return null
    const meta = isObj(s.manifest.metadata) ? s.manifest.metadata : {}
    return { at: s.at, submittedBy: s.submittedBy, version: isStr(meta.version) ? meta.version : null }
  }

  // the sync automation created at approval, if it still exists
  automationOf(id: string): SiloAutomationState | null {
    const aid = this.o.operator.get(id)?.automationId
    const a = aid ? (this.o.automations?.get(aid) ?? null) : null
    return a ? { id: a.id, name: a.name, paused: a.paused === true } : null
  }

  // Every pending submission as a Needs you row (surfaces.ts `submissions`):
  // the owner's approval is the only door a silo has, so the row exists
  // whether or not any silo is active. Urgency `due` — the standard does not
  // name one (the same reading as a proposal's).
  needsYou(): SiloNeedsYou[] {
    return this.submissions().map((s) => {
      const kind = this.submissionKind(s.id)
      const from = this.installed(s.id)?.status.manifest.version ?? null
      const who = s.submittedBy === 'owner' ? 'you' : s.submittedBy
      const text =
        kind === 'update'
          ? `an update ${from ?? '?'} → ${s.version ?? '?'} waits for your approval — submitted by ${who}`
          : `${s.version ?? 'a version'} waits for your approval to ${kind} — submitted by ${who}`
      return {
        kind: 'silo',
        reason: 'submission',
        silo: s.id,
        siloName: s.name ?? s.id,
        key: 'submission',
        recordKind: 'silo',
        urgency: 'due',
        text,
        at: s.at,
        file: null,
        ...(s.submittedBy !== 'owner' && this.o.isAgent(s.submittedBy) ? { agentId: s.submittedBy } : {}),
        submission: { kind, from, to: s.version, submittedBy: s.submittedBy, source: s.source },
      }
    })
  }

  // the locations a submitter reads on disk: the owner every one; an agent
  // its own state and the project folders inside its territories
  private locationsOf(by: string): SiloLocations {
    return bearerLocations(this.o.locations, by, this.o.territoriesOf)
  }

  private validate(raw: unknown, by: string): ValidationResult {
    const ctx: ValidatorContext = {
      registry: this.o.registry,
      reader: new SiloReader(this.locationsOf(by), by === 'owner' ? this.o.kernelKinds : undefined),
      isAgent: this.o.isAgent,
      now: this.now(),
      reinstall: true, // the reserved-id rule is applied before (submit) — see the header
      dimensions: this.dims, // a native id is the validator's to refuse (one rule for every door)
      ...(this.o.schemaPath ? { schemaPath: this.o.schemaPath } : {}),
    }
    return validateSilo(raw, ctx)
  }

  // `from`: where an owner's resubmission came from — said in its event;
  // `producers`: the owner's proposed binding, kept on the submission
  submit(body: unknown, by: string, opts: { from?: string; producers?: readonly string[] } = {}): Answer {
    let raw: unknown
    let source: Submission['source'] = 'body'
    let draftPath: string | undefined
    if (isObj(body) && body.manifest !== undefined) raw = body.manifest
    else if (isObj(body) && isObj(body.draft)) {
      const d = readDraftAs(this.o.agentStateBase, body.draft, by, 'submit')
      if ('error' in d) return { code: d.code, body: { error: d.error } }
      raw = d.value
      source = 'draft'
      draftPath = d.path
    } else return { code: 400, body: { error: 'send {"manifest": …} or {"draft": {"id": …, "agent"?: …}}' } }

    const id = isObj(raw) && isObj(raw.metadata) && isStr(raw.metadata.id) ? raw.metadata.id : null
    if (id !== null && by !== 'owner') {
      const held = this.o.registry.get(id) !== null || this.o.operator.get(id) !== null || this.o.registry.reservedIds().approved.includes(id)
      const bound = this.o.operator.producersOf(id) ?? []
      if (held && !bound.includes(by)) {
        // the rule stands (an agent never submits over a held id),
        // but the words tell the truth for each case — a registry-pending id
        // was never approved, so «was approved before» would be false.
        const neverApproved = this.o.registry.get(id)?.status.state === 'pending' && this.o.operator.get(id) === null
        return {
          code: 403,
          body: {
            error: neverApproved
              ? `${id} already sits pending in the registry — only the owner submits it for approval (Settings › Silos)`
              : `${id} belongs to a silo that is installed or was approved before — only its bound producers${bound.length ? ` (${bound.map((p) => this.named(by, p)).join(', ')})` : ''} may submit an update`,
          },
        }
      }
      const pending = this.getSubmission(id)
      if (pending && pending.submittedBy !== by && pending.submittedBy !== 'owner')
        return { code: 409, body: { error: `a submission of ${id} by ${this.named(by, pending.submittedBy)} is already pending` } }
    }
    const result = this.validate(raw, by)
    // a dimension Silos still serves natively: the same dimension twice is
    // the bug this refuses (native.ts) — whoever submits, owner included;
    // the validator says it (check 2), the door answers it as a conflict
    if (result.native !== undefined) return { code: 409, body: { error: result.native, native: true } }
    if (!result.ok || id === null) return { code: 422, body: result }
    const replaced = this.getSubmission(id) !== null
    const proposed = by === 'owner' ? [...new Set(opts.producers ?? [])] : []
    const sub: Submission = {
      id,
      manifest: raw as Json,
      submittedBy: by,
      at: new Date(this.now()).toISOString(),
      source,
      ...(draftPath ? { draftPath } : {}),
      ...(proposed.length ? { producers: proposed } : {}),
    }
    mkdirSync(this.subsDir, { recursive: true, mode: 0o700 })
    atomicWriteJson(join(this.subsDir, `${id}.json`), sub, { mode: 0o600 })
    this.o.events.append({
      silo: id,
      verb: replaced ? 'resubmitted' : 'submitted',
      by,
      text: `${by === 'owner' ? 'you' : by} submitted ${String((raw as Json & { metadata: Json }).metadata.name)} ${String((raw as Json & { metadata: Json }).metadata.version)}${source === 'draft' ? ' from a draft' : opts.from ? ` from ${opts.from}` : ''} — waiting for the owner`,
    })
    // Home's Needs you lists it now: the refresh's listener compares the
    // board's fingerprint and tells the web (a `silos` event), so the row
    // never waits for the 20 s poll
    this.o.kernel.refresh(id)
    return { code: 201, body: { submission: { id, submittedBy: by, at: sub.at, source, state: 'pending' }, validation: result } }
  }

  // ── consequences: everything the dialog shows ──

  private proposedProducers(manifest: Json, id: string): string[] {
    const p = isObj((manifest.spec as Json).producer) ? ((manifest.spec as Json).producer as Json) : {}
    if (p.role === KERNEL_PRODUCER) return [] // the kernel writes kernel data — no agent to bind
    if (!isStr(p.role)) return [] // an edge-only silo: the owner writes its relations, nobody produces
    const bound = this.o.operator.producersOf(id)?.filter((a) => this.inPlay(a))
    if (bound && bound.length > 0) return bound
    const sub = this.getSubmission(id)
    const named = sub?.producers?.filter((a) => this.o.isAgent(a) && this.inPlay(a))
    if (named && named.length > 0) return named
    // an agent's own submission: the author proposes itself — what it asked
    // for, said as the dialog's default; the owner binds (never from the role)
    if (sub && sub.submittedBy !== 'owner' && this.o.isAgent(sub.submittedBy) && this.inPlay(sub.submittedBy)) return [sub.submittedBy]
    return [] // a role is a word of the manifest, never an agent id: the owner binds it
  }

  private requirements(manifest: Json, producers: string[]): Array<{ what: string; agentId: string | null; met: boolean | null }> {
    const spec = manifest.spec as Json
    const producer = isObj(spec.producer) ? spec.producer : {}
    const kinds = isObj(spec.kinds) ? Object.values(spec.kinds).filter(isObj) : []
    const writable = kinds.some((k) => Array.isArray(k.ownerWritable) && k.ownerWritable.length > 0)
    if (!isObj(producer.sync) || !writable) return []
    if (producers.length === 0)
      return [{ what: `requires the token of the agent bound to ${String(producer.role)} — no agent bound yet`, agentId: null, met: false }]
    return producers.map((a) => {
      const on = this.o.hasBearer(a)
      return { what: `requires ${a}'s token${on ? '' : ` — ${a} is archived, so it holds none`}`, agentId: a, met: on }
    })
  }

  private proposedAutomation(manifest: Json, producers: string[]): Json | null {
    const spec = manifest.spec as Json
    const producer = isObj(spec.producer) ? spec.producer : {}
    if (!isObj(producer.sync)) return null
    const src = (Array.isArray(spec.sources) ? spec.sources : [])
      .filter(isObj)
      .find((s) => isObj(s.expects) && s.expects.producer === 'sync' && isStr(s.expects.cadence))
    if (!src) return null
    const cadence = String((src.expects as Json).cadence)
    const c = cronForCadence(cadence)
    const meta = manifest.metadata as Json
    return {
      agentId: producers[0] ?? null,
      name: `${String(meta.name)} — ${String(producer.sync.service)} sync`,
      cadence,
      cron: c?.cron ?? null,
      says: c?.says ?? `the cadence ${cadence} has no cron form — set the schedule by hand`,
      prompt: syncPrompt(manifest, producers[0] ?? '$SILOS_AGENT_ID', producers[0] ? (this.o.credentialNames?.(producers[0]) ?? []) : []),
    }
  }

  // the ids in a list that are not agents (the routes answer 400 for them)
  notAgents(ids: readonly string[]): string[] {
    return ids.filter((a) => !this.o.isAgent(a))
  }

  // `producers`: the binding the owner is weighing in the dialog — the
  // requirements and the proposed automation are derived for THAT list (the
  // dialog derives nothing itself); absent = Silos' own proposal.
  consequences(id: string, opts: { producers?: readonly string[] } = {}): Json | null {
    const sub = this.getSubmission(id)
    if (!sub) return null
    const m = sub.manifest
    const spec = isObj(m.spec) ? m.spec : {}
    const meta = isObj(m.metadata) ? m.metadata : {}
    const producer = isObj(spec.producer) ? spec.producer : {}
    // the full dry-run runs as the owner, the one who decides (conformance §10)
    const validation = this.validate(m, 'owner')
    const installed = this.installed(id)
    const proposed = this.proposedProducers(m, id)
    const producers = opts.producers ? [...new Set(opts.producers)] : proposed
    const reads = (Array.isArray(spec.sources) ? spec.sources : []).filter(isObj).map((s) => {
      const conv = deriveConvention(s)
      // a kernel source reads no files: there are no paths to list, so the
      // dialog says what kernel data it reads, in the catalog's own words,
      // and how many records Silos holds of it right now
      if (s.root === 'kernel') {
        const kk = kernelKind(String(s.kind))
        const held = this.o.kernelKinds?.(String(s.kind))?.records(this.now()).length ?? 0
        return {
          source: String(s.id),
          root: 'kernel',
          glob: '',
          parser: '',
          kind: String(s.kind),
          convention: 'error' in conv ? null : conv.convention,
          says: kk ? kk.reads : `kernel data this Silos does not publish (${String(s.kind)})`,
          records: held,
          locations: [],
        }
      }
      const prefix = 'error' in conv ? '' : conv.convention.slice(conv.convention.indexOf(':') + 1)
      const scan = scanSource(s as unknown as SourceSpec, this.o.locations)
      const byLoc = new Map<string, number>()
      for (const f of scan.files) byLoc.set(f.location.key, (byLoc.get(f.location.key) ?? 0) + 1)
      return {
        source: String(s.id),
        root: String(s.root),
        glob: String(s.glob),
        parser: String(s.parser),
        convention: 'error' in conv ? null : conv.convention,
        locations: locationsFor(s.root === 'project' ? 'project' : 'agent-state', this.o.locations).map((l) => {
          const path = join(l.dir, ...prefix.split('/'))
          return { location: l.key, path, exists: existsSync(path), files: byLoc.get(l.key) ?? 0 }
        }),
        ...(scan.truncated ? { truncated: scan.truncated } : {}),
      }
    })
    // each slot says whether approving starts it off (defaultSlotsOff) — the
    // dialog sends exactly that list, so what it shows is what lands
    const startsOff = this.defaultSlotsOff(id)
    const slots = slotsSay(m, validation.preview).map((s) => ({ ...s, off: startsOff.includes(s.slot) }))
    const reserved = this.o.registry.reservedIds().approved.includes(id)
    return {
      id,
      submittedBy: sub.submittedBy,
      at: sub.at,
      source: sub.source,
      ...(sub.draftPath ? { draftPath: sub.draftPath } : {}),
      kind: installed ? 'update' : reserved ? 'reinstall' : 'install',
      name: isStr(meta.name) ? meta.name : null, // the silo's name, for the dialog's title (also quoted in authorSays)
      version: { from: installed?.status.manifest.version ?? null, to: isStr(meta.version) ? meta.version : null },
      // the author's prose — shown as a quote, never as authority
      authorSays: {
        name: meta.name ?? null,
        description: meta.description ?? null,
        summary: isObj(producer.instructions) ? (producer.instructions.summary ?? null) : null,
        protocol: isObj(producer.instructions) && Array.isArray(producer.instructions.protocol) ? producer.instructions.protocol : [],
        sync: isObj(producer.sync)
          ? { service: producer.sync.service ?? null, contract: producer.sync.contract ?? [], stateMap: producer.sync.stateMap ?? null }
          : null,
      },
      // what Silos derives — the dialog's authority
      derived: {
        producerRole: producer.role ?? null,
        // 'protocol': the kernel keeps its records about the agents bound
        // here (Task mode) — binding hands them instructions, not records
        bindsTo: bindsThroughKernel(m) ? 'protocol' : null,
        proposedProducers: proposed,
        forProducers: producers, // what requirements and proposedAutomation were derived for
        reads,
        slots,
        preview: validation.preview,
        requirements: this.requirements(m, producers),
        wants: validation.wants,
        notes: validation.notes,
        errors: validation.errors,
        // an update keeps the owner's on/off (updateKeepsOff): a silo turned
        // off stays off, and the dialog says so before the approval
        update: installed
          ? {
              from: installed.status.manifest.version,
              lines: validation.update?.lines ?? [],
              loosening: loosening(installed.manifest ?? {}, m, installed.status.conventions, validation.conventions),
              off: this.o.operator.get(id)?.decision === 'disabled',
              ...(this.o.operator.get(id)?.decision === 'disabled' ? { says: 'stays off — turn it on from its page' } : {}),
            }
          : null,
        proposedAutomation: this.proposedAutomation(m, producers),
        // the look it brings (spec.theme): its name, its colours as the
        // kernel resolved them (accent-soft derived), and what approving
        // does — it becomes a choice, nothing changes on screen
        look: lookOf(m, installed?.manifest ?? null),
      },
    }
  }

  // The slots an approval switches off when the request names none — what
  // the dialog shows as «starts off» (consequences) and what approve applies:
  //   update                 the owner's switches as they are (an update
  //                          never turns a slot back on behind their back)
  //   a builtin's (re)install its declared born-off slots (native.ts) —
  //                          support's pulse stays off on a reinstall
  //   anything else          none
  defaultSlotsOff(id: string): string[] {
    const prev = this.o.operator.get(id)
    if (this.installed(id) && prev) return [...prev.slotsOff]
    if (this.dims.isBuiltin(id) || prev?.provenance === 'builtin') {
      const b = this.dims.builtins().find((x) => x.id === id)
      return b && !('error' in b) ? [...(b.slotsOff ?? [])] : []
    }
    return []
  }

  // ── decisions ──

  approve(id: string, body: unknown): Answer {
    const sub = this.getSubmission(id)
    if (!sub) return { code: 404, body: { error: `no pending submission of ${id}` } }
    // a submission of a native dimension made before the guard existed: it
    // can be rejected, never approved
    const native = this.nativeRefusal(id)
    if (native !== null) return { code: 409, body: { error: native, native: true } }
    const b = isObj(body) ? body : {}
    const m = sub.manifest
    const spec = m.spec as Json
    const role = isObj(spec.producer) ? String((spec.producer as Json).role) : ''
    let producers: string[]
    if (b.producers !== undefined) {
      if (!Array.isArray(b.producers) || !b.producers.every(isStr)) return { code: 400, body: { error: 'producers must be a list of agent ids' } }
      const unknown = (b.producers as string[]).filter((a) => !this.o.isAgent(a))
      if (unknown.length > 0) return { code: 400, body: { error: `not agents: ${unknown.join(', ')}` } }
      const out = (b.producers as string[]).filter((a) => !this.inPlay(a))
      if (out.length > 0) return { code: 400, body: { error: `archived — an archived agent works no rows: ${out.join(', ')}` } }
      producers = [...new Set(b.producers as string[])]
    } else producers = this.proposedProducers(m, id)
    if (role === KERNEL_PRODUCER && producers.length > 0)
      return { code: 400, body: { error: 'the kernel writes the records of a kernel source — there is no producer to bind' } }
    if (role === '' && producers.length > 0)
      return { code: 400, body: { error: 'this silo has no producer role — the owner writes its relations, there is nobody to bind' } }
    // a protocol silo (Task mode) may start with nobody in it: binding is the
    // owner's later choice, on its page — zero bound = zero behaviour change
    if (producers.length === 0 && role !== '' && role !== 'any-agent' && role !== KERNEL_PRODUCER && !bindsThroughKernel(m))
      return { code: 400, body: { error: `bind the producer role ${role} to at least one agent` } }
    // no slotsOff in the request = the honest default (defaultSlotsOff): an
    // update keeps the owner's switches, a builtin starts from its declared
    // born-off slots — an approval never turns a slot back on by omission
    if (b.slotsOff !== undefined && (!Array.isArray(b.slotsOff) || !b.slotsOff.every(isStr)))
      return { code: 400, body: { error: `slotsOff must list slots (${SLOTS.join(', ')})` } }
    const slotsOff = b.slotsOff !== undefined ? [...new Set(b.slotsOff as string[])] : this.defaultSlotsOff(id)
    const badSlot = slotsOff.find((s) => !(SLOTS as readonly string[]).includes(s))
    if (badSlot) return { code: 400, body: { error: `${badSlot} is not a slot (${SLOTS.join(', ')})` } }
    const validation = this.validate(m, 'owner')
    if (!validation.ok) return { code: 409, body: { error: 'the submission no longer validates', validation } }
    const unmet = this.requirements(m, producers).filter((r) => r.met === false)
    if (unmet.length > 0) return { code: 409, body: { error: unmet.map((r) => r.what).join('; '), requirements: unmet } }

    const before = this.installed(id)
    const prev = this.o.operator.get(id)
    const kind = before ? 'updated' : prev?.decision === 'uninstalled' || this.o.registry.reservedIds().approved.includes(id) ? 'reinstalled' : 'installed'
    const now = new Date(this.now()).toISOString()
    const dir = join(this.o.registry.registryDir, id)
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    atomicWriteJson(join(dir, 'silo.json'), m, { mode: 0o600 })
    this.o.operator.set(id, {
      // an update keeps the owner's on/off — the same rule as the boot path
      // (updateBuiltin): approving a new version of a silo the owner turned
      // off never turns it back on; the dialog said «stays off»
      decision: kind === 'updated' && prev?.decision === 'disabled' ? 'disabled' : 'approved',
      producers,
      slotsOff,
      conventions: validation.conventions,
      name: String((m.metadata as Json).name),
      decidedAt: now,
      installedAt: prev?.installedAt && kind !== 'reinstalled' ? prev.installedAt : now,
      ...(prev?.automationId ? { automationId: prev.automationId } : {}),
      // an update keeps the owner's per-entry audience vetoes
      ...(kind === 'updated' && prev?.audienceOff ? { audienceOff: prev.audienceOff } : {}),
      // a silo that came with Silos still did after the owner's reinstall
      ...(prev?.provenance === 'builtin' ? { provenance: 'builtin' as const } : {}),
    })
    this.o.registry.loadOne(id)

    // the sync automation — opt-in
    let automation: Automation | null = null
    const proposed = this.proposedAutomation(m, producers)
    if (b.automation && proposed && this.o.automations) {
      const cron = isObj(b.automation) && isStr(b.automation.cron) ? b.automation.cron : isStr(proposed.cron) ? proposed.cron : null
      const agentId = isStr(proposed.agentId) ? proposed.agentId : null
      if (cron && agentId) {
        const existing = prev?.automationId ? this.o.automations.get(prev.automationId) : null
        automation = existing
          ? this.o.automations.update(existing.id, {
              agentId,
              prompt: String(proposed.prompt),
              trigger: { kind: 'cron', expr: cron },
              paused: false,
              autoPaused: undefined,
              nextRunAt: undefined,
            })
          : this.o.automations.create({
              id: randomUUID(),
              name: String(proposed.name),
              agentId,
              prompt: String(proposed.prompt),
              trigger: { kind: 'cron', expr: cron },
              thread: { mode: 'new' },
              approval: false,
              keepAlive: KEEP_ALIVE_DEFAULT,
              paused: false,
              createdAt: now,
            })
        this.o.operator.patch(id, { automationId: automation.id })
      }
    }

    this.discardSubmission(id)
    this.o.kernel.refresh(id)
    const version = String((m.metadata as Json).version)
    const granted = this.o.registry.get(id)?.status.slots.granted ?? []
    const text = `${kind} ${String((m.metadata as Json).name)} ${kind === 'updated' ? `${before?.status.manifest.version ?? '?'} → ${version}` : version} · producers: ${producers.join(', ') || 'any agent'} · slots: ${granted.join(', ') || 'none'}${automation ? ` · sync automation ${automation.name}` : ''}${kind === 'updated' && prev?.decision === 'disabled' ? ' · stays off' : ''}`
    this.o.events.append({ silo: id, verb: kind, by: 'owner', text })
    // a courtesy note to the submitter — it never fails the owner's decision
    if (sub.submittedBy !== 'owner') {
      try {
        this.o.messages?.send({ from: 'owner', to: sub.submittedBy, text: `Your silo ${String((m.metadata as Json).name)} ${version} was approved (${kind}).` })
      } catch {
        /* its inbox can't take it; the decision stands */
      }
    }
    return { code: 200, body: { silo: this.o.registry.describe().find((d) => d.id === id) ?? null, kind, automation } }
  }

  private discardSubmission(id: string, rejected?: { reason: string | null }): void {
    const file = join(this.subsDir, `${id}.json`)
    if (!existsSync(file)) return
    if (rejected) {
      const dir = join(this.subsDir, 'rejected')
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      renameSync(file, join(dir, `${id}-${new Date(this.now()).toISOString().replace(/[:.]/g, '-')}.json`))
    } else {
      const dir = join(this.subsDir, 'approved')
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      renameSync(file, join(dir, `${id}-${new Date(this.now()).toISOString().replace(/[:.]/g, '-')}.json`))
    }
  }

  reject(id: string, reason: string | null): Answer {
    const sub = this.getSubmission(id)
    if (!sub) return { code: 404, body: { error: `no pending submission of ${id}` } }
    const words = reason && reason.trim() !== '' ? reason.trim().slice(0, 500) : null
    this.discardSubmission(id, { reason: words })
    const name = isObj(sub.manifest.metadata) ? String(sub.manifest.metadata.name) : id
    this.o.events.append({ silo: id, verb: 'rejected', by: 'owner', text: `rejected ${name}${words ? `: ${words}` : ''}` })
    this.o.kernel.refresh(id) // its Needs you row leaves Home at once (see submit)
    // a courtesy note to the submitter — it never fails the owner's decision
    if (sub.submittedBy !== 'owner') {
      try {
        this.o.messages?.send({ from: 'owner', to: sub.submittedBy, text: `Your silo ${name} was not approved${words ? `: ${words}` : '.'}` })
      } catch {
        /* its inbox can't take it; the decision stands */
      }
    }
    return { code: 200, body: { rejected: id, reason: words } }
  }

  uninstall(id: string): Answer {
    const entry = this.o.registry.get(id)
    if (!entry) return { code: 404, body: { error: `${id} is not installed` } }
    const now = new Date(this.now()).toISOString()
    const dir = join(this.o.root, 'uninstalled')
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const manifestFile = join(this.o.registry.registryDir, id, 'silo.json')
    if (existsSync(manifestFile)) renameSync(manifestFile, join(dir, `${id}-${now.replace(/[:.]/g, '-')}.json`))
    const prev = this.o.operator.get(id)
    const records = this.o.kernel.reading(id)?.records.length ?? entry.status.records.parsed
    const producers = (prev?.producers ?? []).filter((a) => this.o.isAgent(a))
    this.o.operator.set(id, {
      ...(prev ?? { producers: [], slotsOff: [], decidedAt: now }),
      decision: 'uninstalled',
      uninstalledAt: now,
      decidedAt: now,
      conventions: entry.status.conventions,
      name: entry.status.manifest.name ?? id,
      keptRecords: records, // the parsed count at the moment of uninstall — Settings can say «records», not just «files»
    })
    let automation: { id: string; paused: true } | null = null
    if (prev?.automationId && this.o.automations?.get(prev.automationId)) {
      this.o.automations.update(prev.automationId, { paused: true, autoPaused: true })
      automation = { id: prev.automationId, paused: true }
    }
    this.o.registry.loadOne(id)
    this.o.kernel.refresh(id)
    this.scanCache = null
    this.o.events.append({
      silo: id,
      verb: 'uninstalled',
      by: 'owner',
      text: `uninstalled ${entry.status.manifest.name ?? id} — its ${records} records, the owner's overlay and the journal stay${producers.length ? ` · still producing: ${producers.join(', ')}` : ''}`,
    })
    return {
      code: 200,
      body: {
        uninstalled: id,
        kept: {
          records,
          conventions: entry.status.conventions.map((c) => c.convention),
          overlayAndJournal: entry.status.conventions.map((c) => join(this.o.registry.conventionsDir, c.dir)),
        },
        // the agents bound as producers that still exist — they may keep writing
        producers,
        automation,
      },
    }
  }

  // The operator's switches after approval: slots off one by one, the silo
  // off/on, the producer binding.
  operatorPatch(id: string, body: unknown): Answer {
    const cur = this.o.operator.get(id)
    if (!cur || cur.decision === 'uninstalled') return { code: 404, body: { error: `${id} is not installed` } }
    const b = isObj(body) ? body : {}
    const patch: Parameters<SiloOperatorStore['patch']>[1] = {}
    const said: string[] = []
    if (b.slotsOff !== undefined) {
      if (!Array.isArray(b.slotsOff) || !b.slotsOff.every((s) => isStr(s) && (SLOTS as readonly string[]).includes(s)))
        return { code: 400, body: { error: `slotsOff must list slots (${SLOTS.join(', ')})` } }
      patch.slotsOff = [...new Set(b.slotsOff as string[])]
      said.push(`slots off: ${patch.slotsOff.join(', ') || 'none'}`)
    }
    if (b.disabled !== undefined) {
      if (typeof b.disabled !== 'boolean') return { code: 400, body: { error: 'disabled must be true or false' } }
      // a dimension Silos serves natively is never turned on as a silo
      const native = b.disabled ? null : this.nativeRefusal(id)
      if (native !== null) return { code: 409, body: { error: native, native: true } }
      patch.decision = b.disabled ? 'disabled' : 'approved'
      said.push(b.disabled ? 'turned off' : 'turned on')
    }
    if (b.producers !== undefined) {
      if (!Array.isArray(b.producers) || !b.producers.every((a) => isStr(a) && this.o.isAgent(a)))
        return { code: 400, body: { error: 'producers must be agent ids' } }
      const out = (b.producers as string[]).filter((a) => !this.inPlay(a))
      if (out.length > 0) return { code: 400, body: { error: `archived — an archived agent works no rows: ${out.join(', ')}` } }
      patch.producers = [...new Set(b.producers as string[])]
      said.push(`producers: ${patch.producers.join(', ') || 'none'}`)
    }
    if (b.audienceOff !== undefined) {
      // the per-entry veto on a granted `audience: producer-agent` — the rows
      // of a vetoed entry come back to the owner's inbox (surfaces.ts)
      if (!Array.isArray(b.audienceOff) || !b.audienceOff.every((n) => typeof n === 'number' && Number.isInteger(n) && n >= 0))
        return { code: 400, body: { error: 'audienceOff must list needs-you entry indexes' } }
      patch.audienceOff = [...new Set(b.audienceOff as number[])]
      said.push(`audience back to you on entries: ${patch.audienceOff.join(', ') || 'none'}`)
    }
    if (said.length === 0) return { code: 400, body: { error: 'send slotsOff, disabled, producers or audienceOff' } }
    this.o.operator.patch(id, { ...patch, decidedAt: new Date(this.now()).toISOString() })
    this.o.registry.loadOne(id)
    this.o.kernel.refresh(id)
    this.o.events.append({ silo: id, verb: 'operator', by: 'owner', text: said.join(' · ') })
    return { code: 200, body: { operator: this.o.operator.get(id), silo: this.o.registry.describe().find((d) => d.id === id) ?? null } }
  }

  // The operator's uninstalled silos the registry does not hold again.
  private uninstalledEntries(): Array<{ id: string } & OperatorSilo> {
    return this.o.operator.list().filter((s) => s.decision === 'uninstalled' && !this.o.registry.get(s.id))
  }

  private scanUninstalled(): Map<string, { files: number; grown: number }> {
    const now = this.now()
    if (this.scanCache && now - this.scanCache.at < 60_000) return this.scanCache.byId
    const byId = new Map<string, { files: number; grown: number }>()
    for (const s of this.uninstalledEntries()) {
      if (!s.conventions) continue
      const since = s.uninstalledAt ? Date.parse(s.uninstalledAt) : Number.POSITIVE_INFINITY
      let files = 0
      let grown = 0
      for (const c of s.conventions) {
        if (c.root === 'kernel') continue // kernel data: no files to count or to grow
        for (const f of scanSource({ id: c.source, root: c.root as SourceSpec['root'], glob: c.glob, parser: 'json' }, this.o.locations).files) {
          files++
          if (f.mtimeMs > since) grown++
        }
      }
      byId.set(s.id, { files, grown })
    }
    this.scanCache = { at: now, byId }
    return byId
  }

  // An uninstalled silo whose files keep being written: a Home term (cached a minute).
  growth(): SiloGrowthTerm[] {
    const scan = this.scanUninstalled()
    const terms: SiloGrowthTerm[] = []
    for (const s of this.uninstalledEntries()) {
      const n = scan.get(s.id)?.grown ?? 0
      if (n > 0 && s.uninstalledAt) {
        const name = s.name ?? s.id
        terms.push({
          silo: s.id,
          siloName: name,
          records: n,
          since: s.uninstalledAt,
          term: `${n} record${n === 1 ? '' : 's'} written to ${name}'s files since it was uninstalled — no silo shows them`,
        })
      }
    }
    return terms
  }

  // The newest manifest an uninstall kept for this id
  // (silos/uninstalled/<id>-<ts>.json) — a regular file, small, whose own id
  // is this one. Older copies are history; null = none kept.
  keptManifest(id: string): { manifest: Json; keptAt: string } | null {
    if (!SILO_ID.test(id)) return null
    const dir = join(this.o.root, 'uninstalled')
    let names: string[] = []
    try {
      names = readdirSync(dir)
    } catch {
      return null
    }
    const prefix = `${id}-`
    const stamped = names
      .flatMap((n) => {
        if (!n.startsWith(prefix) || !n.endsWith('.json')) return []
        const m = KEPT_AT.exec(n.slice(prefix.length, -5))
        return m ? [{ n, keptAt: `${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z` }] : []
      })
      .sort((a, b) => b.keptAt.localeCompare(a.keptAt))
    for (const { n, keptAt } of stamped) {
      try {
        const st = lstatSync(join(dir, n))
        if (!st.isFile() || st.size > MANIFEST_MAX_BYTES) continue
        const raw = JSON.parse(readFileSync(join(dir, n), 'utf8')) as unknown
        if (isObj(raw) && isObj(raw.metadata) && raw.metadata.id === id) return { manifest: raw, keptAt }
      } catch {
        /* unreadable: the next older copy */
      }
    }
    return null
  }

  // Settings › Silos: every silo the owner uninstalled, newest first.
  uninstalled(): UninstalledSilo[] {
    const scan = this.scanUninstalled()
    return this.uninstalledEntries()
      .map((s) => {
        const kept = this.keptManifest(s.id)
        const convs = s.conventions ?? []
        const meta = kept && isObj(kept.manifest.metadata) ? kept.manifest.metadata : {}
        return {
          id: s.id,
          name: s.name ?? s.id,
          uninstalledAt: s.uninstalledAt ?? null,
          producers: s.producers.filter((a) => this.o.isAgent(a)),
          kept: {
            files: scan.get(s.id)?.files ?? 0,
            records: typeof s.keptRecords === 'number' ? s.keptRecords : null,
            conventions: convs.map((c) => c.convention),
            overlayAndJournal: convs.map((c) => join(this.o.registry.conventionsDir, c.dir)),
          },
          grown: scan.get(s.id)?.grown ?? 0,
          manifest: kept ? { version: isStr(meta.version) ? meta.version : null, keptAt: kept.keptAt } : null,
          automation: this.automationOf(s.id),
          submission: this.pendingOf(s.id),
          native: this.nativeRefusal(s.id),
          provenance: s.provenance === 'builtin' ? ('builtin' as const) : null,
        }
      })
      .sort((a, b) => (b.uninstalledAt ?? '').localeCompare(a.uninstalledAt ?? ''))
  }

  // The owner's door back (Settings › Silos): submit what Silos already holds
  // for this id — never a new manifest — through submit(), so validation, the
  // reserved-id rule and the event are exactly a submission's. One submission
  // per id: a pending one is answered (409, with it), never stacked.
  resubmit(id: string): Answer {
    if (!SILO_ID.test(id)) return { code: 404, body: { error: `no silo ${id}` } }
    const native = this.nativeRefusal(id)
    if (native !== null) return { code: 409, body: { error: native, native: true } }
    const pending = this.getSubmission(id)
    if (pending)
      return {
        code: 409,
        body: {
          error: `a submission of ${id} already waits for your approval`,
          submission: { id, submittedBy: pending.submittedBy, at: pending.at, source: pending.source, state: 'pending' },
        },
      }
    const entry = this.o.registry.get(id)
    if (entry) {
      if (entry.status.state !== 'pending') return { code: 409, body: { error: `${id} is ${entry.status.state} — there is nothing to submit` } }
      let raw: unknown
      try {
        raw = JSON.parse(readFileSync(join(this.o.registry.registryDir, id, 'silo.json'), 'utf8'))
      } catch (err) {
        return { code: 409, body: { error: `the manifest of ${id} in the registry could not be read: ${err instanceof Error ? err.message : String(err)}` } }
      }
      return this.submit({ manifest: raw }, 'owner', { from: 'the manifest in the registry' })
    }
    if (this.o.operator.get(id)?.decision !== 'uninstalled')
      return { code: 404, body: { error: `no silo ${id} — nothing installed, uninstalled or waiting in the registry` } }
    const kept = this.keptManifest(id)
    if (!kept) return { code: 404, body: { error: `${id} was uninstalled but no manifest of it was kept — its author submits it again` } }
    return this.submit({ manifest: kept.manifest }, 'owner', { from: `the manifest kept when it was uninstalled (${kept.keptAt})` })
  }

  // ── the silos that come with Silos ──

  // Who writes a builtin's records: the agents whose state ALREADY holds
  // files of its agent-state sources (support: whoever keeps support/cases).
  // A builtin has no dialog where the owner binds a role, so the disk binds
  // it — never the role read as an agent id (a role is a word of the
  // manifest); Settings › Silos › the silo's page lets the owner change it after.
  private builtinProducers(manifest: Json): string[] {
    const spec = isObj(manifest.spec) ? manifest.spec : {}
    const p = isObj(spec.producer) ? spec.producer : {}
    if (p.role === KERNEL_PRODUCER || p.role === 'any-agent') return []
    const out = new Set<string>()
    for (const s of (Array.isArray(spec.sources) ? spec.sources : []).filter(isObj)) {
      if (s.root !== 'agent-state') continue
      for (const f of scanSource(s as unknown as SourceSpec, this.o.locations).files) {
        if (f.location.agentId && this.inPlay(f.location.agentId)) out.add(f.location.agentId)
      }
    }
    return [...out].sort()
  }

  // At boot (index.ts): install every builtin the owner never decided on.
  // An operator entry of any kind — approved (already installed), disabled,
  // uninstalled — is the owner's word and stays: an uninstalled builtin is
  // never brought back by a boot; its door back is Reinstall…. A manifest
  // that does not validate installs nothing and says why, as an event.
  //
  // An installed builtin (approved or turned off — never an uninstalled one)
  // whose SHIPPED manifest is newer than the one it runs is updated through
  // the same steps as an approved update — validated, the manifest replaced,
  // conventions re-derived, said as an event with every loosening — keeping
  // every decision the owner made (on/off, producers, slots off, audience
  // vetoes). Never a downgrade: an older or equal shipped version is left.
  //
  // First of all, the native guard over what is ALREADY registered: an id
  // approved before the guard existed (a native dimension installed from
  // Available before the guard) is turned off (guardNatives).
  installBuiltins(): BuiltinOutcome[] {
    const out: BuiltinOutcome[] = this.guardNatives()
    for (const b of this.dims.builtins()) {
      let prev = this.o.operator.get(b.id)
      // a copy installed through the door while the dimension still ran
      // NATIVELY (never provenance builtin), then uninstalled or turned off —
      // Plans, the cure for counting the owner's tasks twice — is no
      // decision about the built-in: the flip installs it (said so). An
      // uninstall of the BUILTIN itself keeps provenance and is respected.
      // Only the dimensions that ever ran natively (native.ts NATIVE_ERA_IDS):
      // any other id was a silo all along, and its uninstall is the owner's word.
      const nativeEra =
        prev !== null && NATIVE_ERA_IDS.has(b.id) && prev.provenance !== 'builtin' && (prev.decision === 'uninstalled' || prev.decision === 'disabled')
      // ADOPTION (Task mode): an id that now comes with Silos,
      // installed through the door before (provenance null), at a version no
      // newer than the shipped one, becomes the builtin with every choice
      // kept — producers, slots off, audience vetoes, automation, and its
      // decision (approved is updated in the same pass; disabled stays off;
      // uninstalled stays out forever, its door back the normal Reinstall…).
      // A registered version NEWER than the shipped one is a fork: never adopted.
      if (prev && !nativeEra && prev.provenance !== 'builtin' && !('error' in b)) {
        const adopted = this.adoptBuiltin(b, prev)
        if (adopted) {
          out.push(adopted)
          prev = this.o.operator.get(b.id)
        }
      }
      if (prev && !nativeEra) {
        const update = prev.decision !== 'uninstalled' && prev.provenance === 'builtin' && !('error' in b) ? this.updateBuiltin(b) : null
        out.push(
          update ?? {
            id: b.id,
            outcome: 'kept',
            says: prev.decision === 'uninstalled' ? `${b.name} was uninstalled by the owner — left out` : `${b.name} is ${prev.decision} — left as it is`,
          },
        )
        continue
      }
      if ('error' in b) {
        this.builtinFailed(b.id, `missing:${b.error}`, `Silos could not install ${b.name}: ${b.error}`)
        out.push({ id: b.id, outcome: 'failed', says: b.error })
        continue
      }
      const m = b.manifest
      const meta = m.metadata as Json
      const validation = this.validate(m, 'owner')
      if (!validation.ok) {
        const why = validation.errors
          .slice(0, 3)
          .map((e) => `${e.where}: ${e.message}`)
          .join('; ')
        this.builtinFailed(b.id, String(meta.version), `Silos could not install ${b.name} ${String(meta.version)} — its manifest does not validate: ${why}`)
        out.push({ id: b.id, outcome: 'failed', says: why })
        continue
      }
      const producers = this.builtinProducers(m)
      const now = new Date(this.now()).toISOString()
      const dir = join(this.o.registry.registryDir, b.id)
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      atomicWriteJson(join(dir, 'silo.json'), m, { mode: 0o600 })
      this.o.operator.set(b.id, {
        decision: 'approved',
        provenance: 'builtin',
        producers,
        slotsOff: [...(b.slotsOff ?? [])],
        conventions: validation.conventions,
        name: String(meta.name),
        decidedAt: now,
        installedAt: now,
      })
      this.o.registry.loadOne(b.id)
      this.o.kernel.refresh(b.id)
      const granted = this.o.registry.get(b.id)?.status.slots.granted ?? []
      const off = this.o.registry.get(b.id)?.status.slots.off ?? []
      const says = `Silos installed ${String(meta.name)} ${String(meta.version)} — comes with Silos · producers: ${producers.join(', ') || 'none bound yet'} · slots: ${granted.join(', ') || 'none'}${off.length > 0 ? ` · off: ${off.join(', ')}` : ''}${nativeEra ? ` · the copy ${prev!.decision === 'uninstalled' ? 'uninstalled' : 'turned off'} on ${prev!.decidedAt.slice(0, 10)}, while ${String(meta.name)} ran natively, was not a choice against it` : ''}`
      this.o.events.append({ silo: b.id, verb: 'installed', by: SILOS_AUTHOR, text: says })
      out.push({ id: b.id, outcome: 'installed', says })
    }
    return out
  }

  // The adoption above (installBuiltins): provenance becomes 'builtin' and
  // nothing else of the owner's entry changes; said once, as an event. null =
  // not adopted (a fork: the version it runs, or the one kept at its
  // uninstall, is newer than the shipped one; or the manifest it runs names
  // another id).
  private adoptBuiltin(b: BuiltinManifest, prev: OperatorSilo): BuiltinOutcome | null {
    const meta = b.manifest.metadata as Json
    const shipped = isStr(meta.version) ? meta.version : null
    const running = this.o.registry.get(b.id)?.manifest ?? (prev.decision === 'uninstalled' ? (this.keptManifest(b.id)?.manifest ?? null) : null)
    const rmeta = running && isObj(running.metadata) ? running.metadata : null
    if (rmeta && rmeta.id !== b.id) return null
    const registered = rmeta && isStr(rmeta.version) ? rmeta.version : null
    if (registered !== null && shipped !== null) {
      const cmp = compareVersions(registered, shipped)
      if (cmp === null || cmp > 0) return null
    }
    this.o.operator.patch(b.id, { provenance: 'builtin' })
    const says = `${b.name} now comes with Silos — your choices kept (${prev.decision === 'approved' ? 'on' : prev.decision === 'disabled' ? 'off' : 'uninstalled'} · producers: ${prev.producers.join(', ') || 'none bound yet'})`
    this.o.events.append({ silo: b.id, verb: 'adopted', by: SILOS_AUTHOR, text: says })
    return { id: b.id, outcome: 'adopted', says }
  }

  // A shipped builtin that cannot be installed or updated is said ONCE per
  // (silo, shipped version) — the server restarts often (tsx), and the same
  // broken manifest re-journaled at every boot buried the journal. A newer
  // shipped version that still fails is a new fact and is said again.
  // `shipped` is the version, or `missing:<why>` when there is no manifest.
  private builtinFailed(silo: string, shipped: string, text: string): void {
    const said = this.o.events.list(silo).some((e) => e.verb === 'builtin-failed' && e.detail?.shipped === shipped)
    if (!said) this.o.events.append({ silo, verb: 'builtin-failed', by: SILOS_AUTHOR, text, detail: { shipped } })
  }

  // The shipped manifest of an installed builtin, when newer: applied (see
  // installBuiltins). null = nothing to do (same or older version, or the
  // registry no longer holds its manifest — the owner's hands, left alone).
  private updateBuiltin(b: BuiltinManifest): BuiltinOutcome | null {
    const entry = this.o.registry.get(b.id)
    const prev = this.o.operator.get(b.id)
    if (!entry || !prev) return null
    const m = b.manifest
    const meta = m.metadata as Json
    const from = entry.status.manifest.version
    const to = isStr(meta.version) ? meta.version : null
    const cmp = from !== null && to !== null ? compareVersions(to, from) : null
    if (cmp === null || cmp <= 0) return null
    const validation = this.validate(m, 'owner')
    if (!validation.ok) {
      const why = validation.errors
        .slice(0, 3)
        .map((e) => `${e.where}: ${e.message}`)
        .join('; ')
      this.builtinFailed(
        b.id,
        String(to),
        `Silos could not update ${b.name} ${from} → ${to} — the shipped manifest does not validate: ${why}; ${from} keeps running`,
      )
      return { id: b.id, outcome: 'failed', says: why }
    }
    const loose = loosening(entry.manifest ?? {}, m, entry.status.conventions, validation.conventions)
    const dir = join(this.o.registry.registryDir, b.id)
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    atomicWriteJson(join(dir, 'silo.json'), m, { mode: 0o600 })
    // only what the manifest decides changes; every owner decision stays
    this.o.operator.patch(b.id, { conventions: validation.conventions, name: String(meta.name) })
    this.o.registry.loadOne(b.id)
    this.o.kernel.refresh(b.id)
    const says = `Silos updated ${String(meta.name)} ${from} → ${to} — comes with Silos · your choices kept (${prev.decision === 'disabled' ? 'off' : 'on'} · producers: ${prev.producers.join(', ') || 'none bound yet'} · slots off: ${prev.slotsOff.join(', ') || 'none'})${loose.length > 0 ? ` · loosens: ${loose.join('; ')}` : ''}`
    this.o.events.append({ silo: b.id, verb: 'updated', by: SILOS_AUTHOR, text: says })
    return { id: b.id, outcome: 'updated', says }
  }

  // A registered silo whose id Silos still serves natively (native.ts) is
  // never active: one approved before the guard existed is turned off, with
  // the native words, as a visible event — its manifest, records, journal and
  // operator entry all stay (nothing is deleted; the next boot finds it off
  // and says nothing again). The registry keeps a native id inactive on its
  // own as well (registry.ts nativeRefusal), whatever operator.json says.
  guardNatives(): BuiltinOutcome[] {
    const out: BuiltinOutcome[] = []
    for (const s of this.o.operator.list()) {
      if (s.decision !== 'approved') continue
      const words = this.nativeRefusal(s.id)
      if (words === null) continue
      this.o.operator.patch(s.id, { decision: 'disabled', decidedAt: new Date(this.now()).toISOString() })
      this.o.registry.loadOne(s.id)
      this.o.kernel.refresh(s.id)
      const says = `Silos turned off the silo ${s.name ?? s.id}: ${words} — its manifest, records and journal stay`
      this.o.events.append({ silo: s.id, verb: 'native-off', by: SILOS_AUTHOR, text: says })
      out.push({ id: s.id, outcome: 'native-off', says })
    }
    return out
  }
}

// a.b.c versions compared by number (a pre-release suffix after `-` sorts
// before the release); null when either is not of that shape — no update
// is ever guessed from a version Silos can't order
export function compareVersions(a: string, b: string): number | null {
  const parse = (v: string): { nums: number[]; pre: string | null } | null => {
    const m = /^v?(\d+(?:\.\d+)*)(?:-([0-9A-Za-z.-]+))?$/.exec(v.trim())
    return m ? { nums: m[1]!.split('.').map(Number), pre: m[2] ?? null } : null
  }
  const x = parse(a)
  const y = parse(b)
  if (!x || !y) return null
  for (let i = 0; i < Math.max(x.nums.length, y.nums.length); i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0)
    if (d !== 0) return Math.sign(d)
  }
  if (x.pre === y.pre) return 0
  if (x.pre === null) return 1
  if (y.pre === null) return -1
  return x.pre < y.pre ? -1 : 1
}

// The slots a manifest asks for, each with the line the install dialog says
// for it — the pulse and needs-you rows from the validator's preview, the
// rest from the manifest. Shared with silo-check (check.ts), so an author
// reads the very words the owner will.
export function slotsSay(manifest: Json, preview: Preview | null): Array<{ slot: string; says: string | null }> {
  const spec = isObj(manifest.spec) ? manifest.spec : {}
  const surfaces = isObj(spec.surfaces) ? spec.surfaces : {}
  return SLOTS.filter((s) => surfaces[s] !== undefined).map((slot) => {
    const v = surfaces[slot]
    const says =
      slot === 'pulse'
        ? (preview?.pulse ?? null)
        : slot === 'needs-you'
          ? (preview?.needsYou ?? []).map((n) => `${n.urgency}: ${n.row ?? `${n.sample} (no record matches right now)`}`).join(' | ')
          : slot === 'rail' && isObj(v)
            ? `an entry «${String(v.label)}» in the rail`
            : slot === 'agent-section' && isObj(v)
              ? `a section in the producer's page, under ${String(v.house)}`
              : slot === 'project-machinery' && isObj(v)
                ? `a row «${String(v.label)}» in the project's machinery`
                : slot === 'lens' && isObj(v)
                  ? `a lens on ${String(v.over)}${isStr(v.label) ? ` («${v.label}»)` : ''} grouping by ${isObj(v.groupBy) ? `${String(v.groupBy.relation)} (${String(v.groupBy.by)})` : '?'} — a chip you can turn off; what blocks, what escalated and what is yours stay unfolded above the groups`
                  : null
    return { slot, says }
  })
}

// The sync automation's prompt: the producer brief the bound agent already
// carries (silos/producer-brief.ts — the manifest's instructions, contract and
// stateMap, the kernel's routes, the credentials it gets from the Vault by
// NAME) under one line that says to run it now — composed, never invented.
export function syncPrompt(manifest: Json, agentId = '$SILOS_AGENT_ID', credentialNames: readonly VaultCredential[] = []): string {
  const meta = manifest.metadata as Json
  const spec = manifest.spec as Json
  const producer = isObj(spec.producer) ? spec.producer : {}
  const sync = isObj(producer.sync) ? producer.sync : {}
  return [
    `Run the ${String(sync.service ?? '')} sync of the silo ${String(meta.name)} (${String(meta.id)}) now.`,
    '',
    producerBrief(manifest, agentId, credentialNames),
    '',
    "When done, say in one line how many records you wrote, how many were unchanged, and which were rejected with the kernel's reason.",
  ].join('\n')
}

// The look a submission brings, for the dialog — null when it brings none
// (and had none). On an update `change` is the validator's own line.
export function lookOf(next: Json, prev: Json | null): Json | null {
  const raw = isObj(next.spec) && isObj((next.spec as Json).theme) ? (next.spec as Json).theme : null
  const t = raw ? resolveTheme(raw) : null
  const change = prev ? lookChange(prev, next) : null
  if (!t) return change ? { name: null, light: null, dark: null, says: change, change } : null
  return {
    name: t.name,
    light: t.light,
    dark: t.dark,
    says: `brings a look, ${t.name} — approving offers it in Settings › Appearance beside the built-in looks; nothing changes on screen until someone chooses it, in their own browser`,
    change,
  }
}

// What an update LOOSENS — each its own line in the dialog.
export function loosening(prev: Json, next: Json, prevConvs: readonly SourceConvention[], nextConvs: readonly SourceConvention[]): string[] {
  const out: string[] = []
  const before = new Set(prevConvs.map((c) => c.convention))
  for (const c of nextConvs) if (!before.has(c.convention)) out.push(`reads files it did not read before: ${c.convention}`)
  const role = (m: Json): unknown => (isObj(m.spec) && isObj((m.spec as Json).producer) ? ((m.spec as Json).producer as Json).role : undefined)
  if (role(prev) !== role(next)) out.push(`the producer role changes from ${String(role(prev))} to ${String(role(next))}`)
  const acts = (m: Json): Json[] => (isObj(m.spec) && Array.isArray((m.spec as Json).actions) ? ((m.spec as Json).actions as unknown[]).filter(isObj) : [])
  // a kernel-verb is said by its name: each one is its own grant
  const sig = (a: Json): string => `${String(a.verb)}${a.verb === 'kernel-verb' ? ` ${String(a.name ?? '')}` : ''}:${String(a.subKind ?? a.kind ?? '')}`
  const prevActs = new Map(acts(prev).map((a) => [sig(a), a]))
  // who may do a verb (the class rule, R4): compared on EVERY verb — a `by`
  // that gains someone is a loosening, said by name
  const byOf = (a: Json): string[] => (Array.isArray(a.by) ? a.by.filter(isStr) : isStr(a.by) ? [a.by] : [])
  for (const a of acts(next)) {
    const p = prevActs.get(sig(a))
    if (!p) {
      const kv = a.verb === 'kernel-verb' && isStr(a.name) ? kernelVerb(a.name) : null
      if (kv) {
        out.push(`a new kernel-verb: ${String(a.name)} — lets Silos ${kv.grants} (the owner's gesture alone)`)
        continue
      }
      const by = byOf(a)
      out.push(
        `a new action: ${String(a.verb)}${a.kind || a.subKind ? ` on ${String(a.subKind ?? a.kind)}` : ''}${by.length > 0 ? ` (by ${by.join(', ')})` : ''}`,
      )
      continue
    }
    const pf = new Set(Object.keys(isObj(p.fields) ? p.fields : {}))
    for (const f of Object.keys(isObj(a.fields) ? a.fields : {})) if (!pf.has(f)) out.push(`${String(a.verb)} may now write ${f}`)
    const pb = new Set(byOf(p))
    for (const x of byOf(a)) if (!pb.has(x)) out.push(`${String(a.verb)} may now be done by ${x}`)
  }
  const ow = (m: Json): Set<string> =>
    new Set(
      Object.values(isObj(m.spec) && isObj((m.spec as Json).kinds) ? ((m.spec as Json).kinds as Json) : {})
        .filter(isObj)
        .flatMap((k) => (Array.isArray(k.ownerWritable) ? k.ownerWritable.filter(isStr) : [])),
    )
  const prevOw = ow(prev)
  for (const f of ow(next)) if (!prevOw.has(f)) out.push(`the owner may now hold ${f} over the sync`)
  const slots = (m: Json): string[] => Object.keys(isObj(m.spec) && isObj((m.spec as Json).surfaces) ? ((m.spec as Json).surfaces as Json) : {})
  const prevSlots = new Set(slots(prev))
  for (const s of slots(next)) if (!prevSlots.has(s)) out.push(`asks for a new slot: ${s}`)
  return out
}
