// providers-store.ts — Providers v1: persistence for key-based inference
// providers (~/.silos/providers.json, chmod 0600 — holds API keys) with the
// same discipline as automations-store.ts: atomic tmp+rename write, a
// .corrupt backup on malformed JSON, IMMUTABLE merge in update().
//
// Two provider kinds:
//  - 'claude-account': a Claude account (a `claude` login) identified by
//    its CLAUDE_CONFIG_DIR. NOT persisted here — it's DERIVED from disk:
//    'default' is the machine's login (~/.claude, configDir null) and each
//    directory under ~/.silos/claude-accounts/<name>/ is an extra account
//    (id 'account:<name>'). This way there are no two sources of truth to
//    reconcile: the directory IS the account (see harnesses/claude-code/accounts.ts).
//  - 'anthropic-compatible': base_url + api_key (covers cheapestinference
//    AND any custom BYOK).
//  - 'harness-provider' (agents of the engine named by `harness`, one whose
//    provider kinds include it — today OpenCode): a key for a provider the
//    engine already catalogues (OpenCode: providerId = its models.dev id,
//    minimax-coding-plan, zai…) — the engine knows the baseURL and models,
//    Silos holds the key and its launch injects it per process (OpenCode:
//    harnesses/opencode/launch.ts providerInjection).
//  - 'harness-native' (same): no key — a passthrough to the operator's own
//    login in that engine for that providerId (OpenCode: auth.json, never
//    read or written by Silos).
// The last three are what providers.json persists.
//
// SECURITY: API keys are NEVER logged and NEVER leave whole through the
// API — every GET/POST/PATCH response goes through maskProvider() (sk-…last4).
import { existsSync, readFileSync, readdirSync, chmodSync } from 'node:fs'
import { atomicWriteJson, backupCorruptJson } from './json-store.js'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { ACCOUNT_NAME_RE } from './harnesses/claude-code/accounts.js'
import { engineProviderLabel, harnessById, ownsProviders, providerOwners, quotedIds } from './harnesses/registry.js'
import type { HarnessId } from './harnesses/contract.js'

export const DEFAULT_PROVIDER_ID = 'default'
/** "Copy config" never carries a key: this stands in for it. */
export const EXPORT_KEY_PLACEHOLDER = '<paste your key>'
export const ACCOUNT_PROVIDER_PREFIX = 'account:'
// '' reads as the default provider too (an unset selector).
const DEFAULT_ALIASES = new Set([DEFAULT_PROVIDER_ID, ''])

export type StoredProviderKind = 'anthropic-compatible' | 'harness-provider' | 'harness-native'
/** The harness a harness-* provider belongs to: a registered harness whose
 *  provider kinds include the provider's kind (registry ownsProviders). */
export type ProviderHarness = HarnessId
// an engine provider id (OpenCode: its models.dev id): lowercase slug — it
// becomes a config key and a `provider/model` prefix, so nothing else is
// allowed in it
export const PROVIDER_ID_RE = /^[a-z0-9][a-z0-9-]*$/

interface StoredBase {
  id: string
  label: string
  createdAt: string
}
export type StoredProvider =
  // models: the ids the key reaches at this gateway (POST /api/providers/:id/models
  // asked `<root>/v1/models`); absent = never asked. The model picker lists
  // them for both engines; a baseUrl change drops them with the key.
  // modelLimits: what the listing published per model (context/output
  // tokens; OpenCode's provider config declares them); modelsAt: when the
  // list was last read (gateway-models.ts refreshes it; the UI says so).
  | (StoredBase & {
      kind: 'anthropic-compatible'
      baseUrl: string
      apiKey: string
      models?: string[]
      modelLimits?: Record<string, { context?: number; output?: number }>
      modelsAt?: string
    })
  | (StoredBase & { kind: 'harness-provider'; harness: ProviderHarness; providerId: string; apiKey: string })
  | (StoredBase & { kind: 'harness-native'; harness: ProviderHarness; providerId: string })

export interface ProviderInput {
  kind?: StoredProviderKind
  label: string
  baseUrl?: string
  apiKey?: string
  harness?: string
  providerId?: string
  models?: string[]
  modelLimits?: Record<string, { context?: number; output?: number }>
  modelsAt?: string
}
export type ProviderPatch = Partial<{
  label: string
  baseUrl: string
  apiKey: string
  providerId: string
  models: string[]
  modelLimits: Record<string, { context?: number; output?: number }>
  modelsAt: string
}>

// What ChatService/env.ts consume: the identity already resolved to "what
// env to inject". configDir null = the machine's default account
// (CLAUDE_CONFIG_DIR untouched — byte-identical to the long-standing behavior).
export type ResolvedProvider =
  | { id: string; kind: 'claude-account'; label: string; configDir: string | null }
  | {
      id: string
      kind: 'anthropic-compatible'
      label: string
      baseUrl: string
      apiKey: string
      models?: string[]
      modelLimits?: Record<string, { context?: number; output?: number }>
      modelsAt?: string
    }
  | { id: string; kind: 'harness-provider'; label: string; harness: ProviderHarness; providerId: string; apiKey: string }
  | { id: string; kind: 'harness-native'; label: string; harness: ProviderHarness; providerId: string }

/** Whether a provider PRICES its turns: an API key —
 *  real money, what the agent's spend cap brakes. A Claude account (the
 *  machine's login included) and an engine's own login are a plan without a
 *  price per turn: the $ cap cannot bite there, the plan's limit is the
 *  brake. No provider at all (no store) is the machine's own login. The ONE
 *  classification — the brake (own-turns.ts), the accept sheet's words
 *  (proposals-view.ts) and the agent's spend line read it. */
export function providerPrices(p: Pick<ResolvedProvider, 'kind'> | null | undefined): boolean {
  return p != null && (p.kind === 'anthropic-compatible' || p.kind === 'harness-provider')
}

// sk-abc…1234 — enough for the owner to recognize THEIR key without exposing it.
// Threshold <=12: for short keys, the last 4 chars would be a substantial
// fraction of the secret.
export function maskKey(key: string): string {
  if (key.length <= 12) return '…'
  const prefix = key.startsWith('sk-') ? 'sk-' : ''
  return `${prefix}…${key.slice(-4)}`
}

// apiKey '' = invalidated key (baseUrl changed without re-pasting the key,
// see update()) — exposed as '' so the UI can distinguish "no key" from a
// masked key.
export function maskProvider(p: StoredProvider): StoredProvider {
  if (p.kind === 'harness-native') return { ...p }
  return { ...p, apiKey: p.apiKey === '' ? '' : maskKey(p.apiKey) }
}

function isValidStoredShape(v: unknown): v is StoredProvider {
  if (typeof v !== 'object' || v === null) return false
  const o = v as Record<string, unknown>
  if (!(typeof o.id === 'string' && o.id !== '' && typeof o.label === 'string' && typeof o.createdAt === 'string')) return false
  // apiKey '' is a LEGAL state — an invalidated key awaiting re-paste
  // (see update()); the entry is not discarded for it.
  switch (o.kind) {
    case 'anthropic-compatible':
      return typeof o.baseUrl === 'string' && o.baseUrl !== '' && typeof o.apiKey === 'string' && isModelsList(o.models)
    case 'harness-provider':
      return (
        ownsProviders(o.harness, o.kind) &&
        typeof o.providerId === 'string' &&
        PROVIDER_ID_RE.test(o.providerId) &&
        typeof o.apiKey === 'string' &&
        o.baseUrl === undefined
      )
    case 'harness-native':
      return (
        ownsProviders(o.harness, o.kind) &&
        typeof o.providerId === 'string' &&
        PROVIDER_ID_RE.test(o.providerId) &&
        o.apiKey === undefined &&
        o.baseUrl === undefined
      )
    default:
      return false
  }
}

const isModelsList = (v: unknown): boolean => v === undefined || (Array.isArray(v) && v.every((m) => typeof m === 'string'))

// OpenCode substitutes `{env:…}`/`{file:…}` over the WHOLE config text, and
// a provider's label and baseUrl land in that text (launch.ts
// providerInjection) — a `{` in either is refused when it is written, not
// discovered at launch (launch.ts keeps its own guard as belt and braces).
export function assertNoBraceField(field: 'label' | 'baseUrl', v: string): void {
  if (v.includes('{')) throw new Error(`${field} must not contain '{'`)
}

// harness: the engine the provider is for (engineProviderLabel names every
// engine that owns harness-* providers when it is not one of them)
function checkProviderId(v: unknown, harness?: unknown): string {
  if (typeof v !== 'string' || !PROVIDER_ID_RE.test(v))
    throw new Error(`providerId required: a lowercase ${engineProviderLabel(harness)} provider id (a-z, 0-9, -)`)
  return v
}

// One shape per kind — every field the kind does not carry is refused, so
// a key can never sit on a passthrough nor a baseUrl on a catalogue entry.
function buildStored(input: ProviderInput, id: string, createdAt: string, opts: { allowEmptyKey?: boolean } = {}): StoredProvider {
  const kind = input.kind ?? 'anthropic-compatible'
  assertNoBraceField('label', input.label)
  if (typeof input.baseUrl === 'string') assertNoBraceField('baseUrl', input.baseUrl)
  const base = { id, label: input.label, createdAt }
  if (kind === 'anthropic-compatible') {
    if (input.providerId !== undefined || input.harness !== undefined) throw new Error(`providerId/harness are only for ${engineProviderLabel()} providers`)
    if (typeof input.baseUrl !== 'string' || input.baseUrl === '') throw new Error('baseUrl required')
    if (typeof input.apiKey !== 'string') throw new Error('apiKey required')
    if (!isModelsList(input.models)) throw new Error('models must be an array of model ids')
    return {
      ...base,
      kind,
      baseUrl: input.baseUrl,
      apiKey: input.apiKey,
      ...(input.models !== undefined ? { models: input.models } : {}),
      ...(input.modelLimits !== undefined ? { modelLimits: input.modelLimits } : {}),
      ...(input.modelsAt !== undefined ? { modelsAt: input.modelsAt } : {}),
    }
  }
  if (kind !== 'harness-provider' && kind !== 'harness-native') throw new Error(`invalid kind: ${String(kind)}`)
  const engine = engineProviderLabel(input.harness)
  if (input.models !== undefined || input.modelLimits !== undefined || input.modelsAt !== undefined)
    throw new Error(`models are only for anthropic-compatible providers — ${engine} lists its own`)
  if (input.baseUrl !== undefined) throw new Error(`baseUrl is only for anthropic-compatible providers — ${engine} knows its providers' endpoints`)
  const harness = input.harness
  if (!ownsProviders(harness, kind)) throw new Error(`harness required: ${quotedIds(providerOwners(kind))}`)
  const providerId = checkProviderId(input.providerId, harness)
  if (kind === 'harness-native') {
    if (input.apiKey !== undefined) throw new Error(`apiKey not allowed: a harness-native provider uses ${harnessById(harness).label}'s own login`)
    return { ...base, kind, harness, providerId }
  }
  if (typeof input.apiKey !== 'string' || (input.apiKey === '' && !opts.allowEmptyKey)) throw new Error('apiKey required')
  return { ...base, kind, harness, providerId, apiKey: input.apiKey }
}

interface Shape {
  providers: StoredProvider[]
}

export class ProvidersStore {
  private providers: StoredProvider[] = []
  private file: string
  private accountsDir: string
  // warn only once per (agentId, providerId) unknown pair — a broken id in
  // agents.json must not flood the log on every turn.
  private warned = new Set<string>()

  constructor(dataDir: string) {
    this.file = join(dataDir, 'providers.json')
    this.accountsDir = join(dataDir, 'claude-accounts')
  }

  load(): void {
    if (!existsSync(this.file)) return
    const text = readFileSync(this.file, 'utf8')
    let raw: Shape
    try {
      raw = JSON.parse(text) as Shape
    } catch {
      // corrupt JSON: back up BEFORE starting fresh — same criterion as
      // automations-store: the next write would overwrite the original.
      backupCorruptJson(this.file, text, 'providers-store', { mode: 0o600 })
      this.providers = []
      return
    }
    const list = Array.isArray(raw.providers) ? raw.providers : []
    const good: StoredProvider[] = []
    let discarded = 0
    for (const entry of list) {
      if (isValidStoredShape(entry)) {
        good.push(entry)
      } else {
        const id = typeof (entry as { id?: unknown })?.id === 'string' ? (entry as { id: string }).id : '?'
        // id only — never the entry's contents (it could carry the key)
        console.warn(`providers-store: entry discarded for invalid shape in providers.json (id=${id})`)
        discarded += 1
      }
    }
    // Discarding an entry also triggers the .corrupt backup — without it,
    // the next save() (create/update/delete of ANOTHER provider) would
    // rewrite the file without the broken entry, and its API key
    // (unrecoverable from the product: every surface masks it) would be
    // lost forever to a hand-edit typo. Same criterion as malformed JSON;
    // never overwrites an existing backup.
    if (discarded > 0) backupCorruptJson(this.file, text, 'providers-store', { mode: 0o600 })
    this.providers = good
    // the file could have been created by hand with lax permissions — reassert 0600.
    try {
      chmodSync(this.file, 0o600)
    } catch {
      /* best effort */
    }
  }

  // ---- CRUD over persisted data (every kind but claude-account) ----------

  list(): StoredProvider[] {
    return this.providers.map((p) => ({ ...p }))
  }

  listMasked(): StoredProvider[] {
    return this.providers.map(maskProvider)
  }

  get(id: string): StoredProvider | null {
    const p = this.providers.find((x) => x.id === id)
    return p ? { ...p } : null
  }

  create(input: ProviderInput): StoredProvider {
    const p = buildStored(input, randomUUID(), new Date().toISOString())
    // The same key pasted again for the same endpoint IS the same provider:
    // "Connect" is idempotent, never a second row (pasting one pool
    // key three times once gave three rows). The existing row keeps its
    // id (pins point at it), label and models.
    const twin = this.providers.find(
      (x) => x.kind === 'anthropic-compatible' && p.kind === 'anthropic-compatible' && x.baseUrl === p.baseUrl && x.apiKey !== '' && x.apiKey === p.apiKey,
    )
    if (twin) return { ...twin }
    this.providers.push(p)
    this.save()
    return { ...p }
  }

  // IMMUTABLE merge (same criterion as automations-store): the object
  // already living in the array is never mutated — a new one is built and
  // swapped in.
  update(id: string, patch: ProviderPatch): StoredProvider {
    const idx = this.providers.findIndex((p) => p.id === id)
    if (idx === -1) throw new Error('provider not found')
    const current = this.providers[idx] as StoredProvider
    const fields: ProviderInput = { ...current, ...patch }
    // Changing where a key goes without re-pasting it INVALIDATES it ('' =
    // pending re-paste): baseUrl for anthropic-compatible, providerId for a
    // harness-provider. This closes the two-step exfiltration bypass (PATCH
    // baseUrl to a collector + verify would send the stored key as a Bearer
    // to the new destination) — the key only ever travels to the endpoint
    // it was pasted for. The widget's UI already re-pastes on endpoint change.
    const keyMoves =
      (current.kind === 'anthropic-compatible' && patch.baseUrl !== undefined && patch.baseUrl !== current.baseUrl) ||
      (current.kind === 'harness-provider' && patch.providerId !== undefined && patch.providerId !== current.providerId)
    if (keyMoves && patch.apiKey === undefined) fields.apiKey = ''
    // the list was learned from the OLD endpoint with that key — it goes with it
    if (keyMoves && patch.models === undefined) {
      delete fields.models
      delete fields.modelLimits
      delete fields.modelsAt
    }
    const merged = buildStored(fields, current.id, current.createdAt, { allowEmptyKey: true })
    this.providers[idx] = merged
    this.save()
    return { ...merged }
  }

  delete(id: string): void {
    const before = this.providers.length
    this.providers = this.providers.filter((p) => p.id !== id)
    if (this.providers.length === before) throw new Error('provider not found')
    this.save()
  }

  private save(): void {
    // mode 0600 on creation; chmod reasserts it on a file that pre-existed with laxer perms.
    atomicWriteJson(this.file, { providers: this.providers }, { mode: 0o600 })
    try {
      chmodSync(this.file, 0o600)
    } catch {
      /* best effort */
    }
  }

  // ---- resolution (default + derived accounts + persisted) ---------------

  private accountNames(): string[] {
    try {
      return readdirSync(this.accountsDir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .sort()
    } catch {
      return [] // no accounts directory yet — default only
    }
  }

  // Valid ids for agent.provider / agent.fallback — used by the agent
  // routes to validate on write.
  knownIds(): string[] {
    return [DEFAULT_PROVIDER_ID, ...this.accountNames().map((n) => `${ACCOUNT_PROVIDER_PREFIX}${n}`), ...this.providers.map((p) => p.id)]
  }

  resolve(id: string | undefined): ResolvedProvider | null {
    if (id === undefined || DEFAULT_ALIASES.has(id)) {
      return { id: DEFAULT_PROVIDER_ID, kind: 'claude-account', label: 'Claude (this machine)', configDir: null }
    }
    if (id.startsWith(ACCOUNT_PROVIDER_PREFIX)) {
      const name = id.slice(ACCOUNT_PROVIDER_PREFIX.length)
      // Validate the name BEFORE the join — an 'account:../../other/dir'
      // hand-planted in agents.json would resolve an arbitrary directory
      // and inject it as CLAUDE_CONFIG_DIR. Same rule as AccountsService
      // (ACCOUNT_NAME_RE).
      if (!ACCOUNT_NAME_RE.test(name)) return null
      const dir = join(this.accountsDir, name)
      if (!existsSync(dir)) return null
      return { id, kind: 'claude-account', label: `Claude · ${name}`, configDir: dir }
    }
    const p = this.providers.find((x) => x.id === id)
    if (!p) return null
    const { createdAt: _createdAt, ...resolved } = p
    return resolved
  }

  // Tolerant on READ (per spec): an unknown provider in agents.json
  // (deleted after being assigned, a hand-edit typo) falls back to the
  // default with ONE log warning — never breaks the owner's turn.
  resolveForAgent(agentId: string, providerId: string | undefined): ResolvedProvider {
    const r = this.resolve(providerId)
    if (r) return r
    const key = `${agentId}:${providerId}`
    if (!this.warned.has(key)) {
      this.warned.add(key)
      console.warn(`providers-store: agent ${agentId} points to unknown provider '${providerId}' — using the default`)
    }
    return this.resolve(undefined) as ResolvedProvider
  }
}
