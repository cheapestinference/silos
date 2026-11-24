// model-catalog.ts — HONEST catalog of models for the cabin selectors
// (cockpit.ts). Rule: the UI never lists a model the system can't verify
// exists — the source is the SDK's `Query.supportedModels()` (sdk.d.ts:2490),
// never a hardcoded list.
//
// Empirically verified against SDK 0.3.233:
// - `supportedModels()` = `(await this.initialization).models` (sdk.mjs): it's
//   the response to the CLI's `initialize` control request — there is NO LLM
//   turn, NO quota consumed. Real cost: one CLI spawn (~0.8-1.2s measured).
// - With `prompt` as an AsyncIterable that never emits messages + an abort
//   after reading the catalog, the process dies cleanly without ever
//   calling a model.
// - `persistSession: false` (sdk.d.ts:1612) prevents ANY JSONL from being
//   left under ~/.claude/projects (verified: zero new files after the probe).
//
// Refresh policy (the spawn is cheap but not free, and tsx watch restarts
// the process on every save): on startup it ONLY refreshes if there's no
// persisted catalog yet; after that, refresh is manual via POST
// /api/models/refresh. The file (~/.silos/model-catalog.json) is a
// regenerable CACHE — a corrupt JSON is treated as empty with no .corrupt
// backup (unlike conversation-prefs.json, there's no owner data to lose
// here: it's re-fetched from the SDK with a refresh).
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { HarnessId } from './harnesses/contract.js'
import { fallbackHarness, registeredHarnesses } from './harnesses/registry.js'

// Minimal mirror of the SDK's ModelInfo (sdk.d.ts:1226) — only the fields
// the cabin uses. `resolvedModel` matters for the honest echo: the stream's
// init echoes the canonical id ('claude-sonnet-5') even when an alias was
// requested ('sonnet'); without this map the warning chip would give false
// positives.
export interface ModelInfo {
  value: string
  resolvedModel?: string
  displayName: string
  description?: string
  supportsEffort?: boolean
  supportedEffortLevels?: ('low' | 'medium' | 'high' | 'xhigh' | 'max')[]
  supportsAdaptiveThinking?: boolean
  supportsFastMode?: boolean
}

export interface CatalogView {
  models: ModelInfo[]
  fetchedAt: string | null
}

// Injectable: tests and the E2E harness NEVER touch the real SDK.
export type FetchModels = () => Promise<ModelInfo[]>

function isValidModel(v: unknown): v is ModelInfo {
  if (typeof v !== 'object' || v === null) return false
  const o = v as Record<string, unknown>
  return typeof o.value === 'string' && o.value !== '' && typeof o.displayName === 'string'
}

// One harness's list: its own cache file, its own source, the same rules
// (coalesced refresh, a failure never overwrites what was there).
class HarnessList {
  models: ModelInfo[] = []
  fetchedAt: string | null = null
  private refreshing: Promise<CatalogView> | null = null

  constructor(
    private file: string,
    readonly label: string,
    private fetchModels: FetchModels | undefined,
    private now: () => Date,
  ) {}

  get hasSource(): boolean {
    return this.fetchModels !== undefined
  }

  load(): void {
    try {
      if (!existsSync(this.file)) return
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<{ fetchedAt: string; models: unknown[] }>
      const list = Array.isArray(raw.models) ? raw.models.filter(isValidModel) : []
      this.models = list
      this.fetchedAt = typeof raw.fetchedAt === 'string' && list.length > 0 ? raw.fetchedAt : null
    } catch {
      // corrupt cache → empty, no backup (regenerable with a refresh — see header)
      this.models = []
      this.fetchedAt = null
    }
  }

  view(): CatalogView {
    return { models: [...this.models], fetchedAt: this.fetchedAt }
  }

  refresh(): Promise<CatalogView> {
    if (this.refreshing) return this.refreshing
    this.refreshing = this.doRefresh().finally(() => {
      this.refreshing = null
    })
    return this.refreshing
  }

  private async doRefresh(): Promise<CatalogView> {
    if (!this.fetchModels) throw new Error(`model catalog has no ${this.label} source configured`)
    const fetched = await this.fetchModels()
    const list = Array.isArray(fetched) ? fetched.filter(isValidModel) : []
    if (list.length === 0) throw new Error(`${this.label} did not return any models`)
    this.models = list
    this.fetchedAt = this.now().toISOString()
    this.save()
    return this.view()
  }

  private save(): void {
    mkdirSync(dirname(this.file), { recursive: true })
    const tmp = this.file + '.tmp'
    writeFileSync(tmp, JSON.stringify({ fetchedAt: this.fetchedAt, models: this.models }, null, 2) + '\n')
    renameSync(tmp, this.file)
  }
}

export class ModelCatalog {
  // One list per registered harness that declares `models` (its cache file
  // under dataDir and its source's name), in registration order — Claude
  // Code: the SDK's list (model-catalog.json, the long-standing file);
  // OpenCode: `opencode models` (cache/models-opencode.json).
  // Built on first use, never at construction: the registry may be read only
  // inside functions (it is filled when harnesses/index.ts is evaluated).
  private built: Map<HarnessId, HarnessList> | null = null
  private sources: Partial<Record<HarnessId, FetchModels>> | FetchModels | undefined

  // A bare function = the fallback harness's source (the long-standing call form).
  constructor(
    private dataDir: string,
    sources?: FetchModels | Partial<Record<HarnessId, FetchModels>>,
    private now: () => Date = () => new Date(),
  ) {
    this.sources = sources
  }

  private lists(): Map<HarnessId, HarnessList> {
    if (this.built) return this.built
    const fallback = fallbackHarness().id
    const src = this.sources
    const sourceOf = (id: HarnessId): FetchModels | undefined => (typeof src === 'function' ? (id === fallback ? src : undefined) : src?.[id])
    const built = new Map<HarnessId, HarnessList>()
    for (const h of registeredHarnesses()) {
      if (!h.models) continue
      built.set(h.id, new HarnessList(join(this.dataDir, h.models.file), h.models.label, sourceOf(h.id), this.now))
    }
    this.built = built
    return built
  }

  load(): void {
    for (const l of this.lists().values()) l.load()
  }

  /** The fallback harness's catalogue (the cockpit's long-standing view). */
  view(): CatalogView {
    return this.viewFor(fallbackHarness().id)
  }

  /** A harness without `models` → honestly empty. */
  viewFor(harness: HarnessId): CatalogView {
    return this.lists().get(harness)?.view() ?? { models: [], fetchedAt: null }
  }

  // Catalog entry covering a model — by exact value, by resolvedModel (a
  // canonical id matches its alias row), or, with model undefined, the
  // CLI's 'default' row. Honest null if the catalog doesn't know it
  // (custom model / empty catalog) — the caller must NOT invent validation
  // in that case. Same criterion as modelInfo in web/lib/cockpit.
  infoOf(model: string | undefined): ModelInfo | null {
    const models = this.lists().get(fallbackHarness().id)?.models ?? []
    if (model === undefined) return models.find((m) => m.value === 'default') ?? null
    return models.find((m) => m.value === model) ?? models.find((m) => m.resolvedModel === model) ?? null
  }

  // Real refresh against the harness's source — coalesced: two concurrent
  // requests share the same spawn (never two CLIs at once for this). A
  // failure NEVER overwrites the catalog that was already there (a stale
  // catalog beats no catalog) — the error bubbles up to the caller (the
  // route translates it to a 502).
  async refresh(harness: HarnessId = fallbackHarness().id): Promise<CatalogView> {
    const list = this.lists().get(harness)
    if (!list) throw new Error(`model catalog: harness ${harness} declares no models`)
    return list.refresh()
  }

  // On startup: refreshes ONLY if nothing is persisted yet — with tsx watch
  // the process restarts on every save, and a CLI spawn per restart would
  // be noise; manual refresh exists for when the owner wants a fresh
  // snapshot. Best effort: a failure only logs a warning, never blocks startup.
  // Every harness with a source, each on its own (in registration order) —
  // one failing never keeps another out.
  async maybeRefreshOnBoot(): Promise<void> {
    await Promise.all(
      [...this.lists().values()].map(async (l) => {
        if (l.models.length > 0 || !l.hasSource) return
        try {
          await l.refresh()
          console.log(`model catalog: ${l.models.length} models from ${l.label}`)
        } catch (err) {
          console.warn(`model catalog: could not fetch from ${l.label} —`, err instanceof Error ? err.message : err)
        }
      }),
    )
  }
}

/** Only the models of the providers an agent can reach: a
 *  `provider/model` value is kept when its provider id is in `reach`. */
export function filterByProviders(view: CatalogView, reach: ReadonlySet<string>): CatalogView {
  return { ...view, models: view.models.filter((m) => reach.has(m.value.split('/')[0] ?? '')) }
}
