// provider-models.ts — what a pasted key can reach. An Anthropic-compatible
// gateway (cheapestinference, any BYOK proxy) is reached at `<base>/v1/messages`;
// the SAME deployment almost always serves the OpenAI-style listing at
// `<root>/v1/models` with the same key, and that list is the one honest
// source of "which model ids does this key run": a pool's models, a proxy's
// catalogue. Silos asks it once (POST /api/providers/:id/models) and stores
// the ids on the provider, so the model picker lists them for both engines
// instead of offering a typed id — nothing is invented, nothing is hardcoded.
//
// The root is the baseUrl minus its Anthropic-passthrough segment
// (`…/anthropic` → `…`): cheapestinference serves `/anthropic/v1/messages`
// and `/v1/models`; a proxy mounted at the origin serves both under `/v1`.
// Pure functions — the route owns the fetch.

export const MODELS_CAP = 200
const ID_MAX = 100

/** `https://api.x.com/anthropic` → `https://api.x.com/v1/models`;
 *  `https://proxy.x.com` → `https://proxy.x.com/v1/models`;
 *  `https://proxy.x.com/v1` → `https://proxy.x.com/v1/models`. */
export function modelsUrlFor(baseUrl: string): string {
  let root = baseUrl.replace(/\/+$/, '')
  root = root.replace(/\/anthropic$/i, '')
  root = root.replace(/\/v1$/i, '')
  return `${root}/v1/models`
}

/** The ids of an OpenAI-style listing (`{ data: [{ id }] }`), or a bare
 *  array of ids / `{ models: [...] }` for proxies that answer that way.
 *  Deduped, order kept, capped; never throws — a shape we don't understand
 *  is an empty list. */
export function parseModelsList(body: unknown): string[] {
  const rows: unknown[] = Array.isArray(body)
    ? body
    : typeof body === 'object' && body !== null && Array.isArray((body as { data?: unknown }).data)
      ? (body as { data: unknown[] }).data
      : typeof body === 'object' && body !== null && Array.isArray((body as { models?: unknown }).models)
        ? (body as { models: unknown[] }).models
        : []
  const out: string[] = []
  const seen = new Set<string>()
  for (const row of rows) {
    const id = typeof row === 'string' ? row : typeof row === 'object' && row !== null ? (row as { id?: unknown }).id : undefined
    if (typeof id !== 'string') continue
    const clean = id.trim()
    if (clean === '' || clean.length > ID_MAX || clean.includes('{') || seen.has(clean)) continue
    seen.add(clean)
    out.push(clean)
    if (out.length >= MODELS_CAP) break
  }
  return out
}

/** The stored list, validated on write (PATCH `models`): strings, trimmed,
 *  no braces (they land in OpenCode config text), deduped, capped. */
export function checkModels(v: unknown): string[] {
  if (!Array.isArray(v)) throw new Error('models must be an array of model ids')
  if (!v.every((m) => typeof m === 'string')) throw new Error('models must be an array of model ids')
  const list = parseModelsList(v)
  if (list.length !== new Set(v.map((m: string) => m.trim())).size) {
    // something was dropped: an empty id, a brace, an oversize id
    for (const m of v as string[]) {
      const t = m.trim()
      if (t === '') throw new Error('models must not contain an empty id')
      if (t.includes('{')) throw new Error("a model id must not contain '{'")
      if (t.length > ID_MAX) throw new Error(`a model id must be at most ${ID_MAX} characters`)
    }
  }
  return list
}

// ---- naming a key's row ----------------------------------------------------
// Mirrors web/src/lib/providers.ts gatewayHost/gatewayAutoLabel (the UI shows
// the same name it would have computed); the server is the one that writes it.
export const CHEAPESTINFERENCE_BASE_URL = 'https://api.cheapestinference.com/anthropic'

export function gatewayHost(baseUrl: string): string {
  try {
    return new URL(baseUrl).host.replace(/^www\./, '')
  } catch {
    return baseUrl
  }
}

/** "cheapestinference · kimi-k3, qwen3.8-max" (the partner by name, any other
 *  gateway by host; more than three models fold as "+N"). */
export function gatewayAutoLabel(baseUrl: string, models: readonly string[]): string {
  const host = baseUrl === CHEAPESTINFERENCE_BASE_URL ? 'cheapestinference' : gatewayHost(baseUrl)
  if (models.length === 0) return host
  const shown = models.slice(0, 3).join(', ')
  return `${host} · ${shown}${models.length > 3 ? ` +${models.length - 3}` : ''}`
}

/** A label nobody chose: the bare partner name or the bare host — the one a
 *  paste gives a row before its models are known. A label the operator typed
 *  ("my proxy") is never overwritten. */
export function isBareGatewayLabel(label: string, baseUrl: string): boolean {
  const l = label.trim().toLowerCase()
  return l === 'cheapestinference' || l === gatewayHost(baseUrl).toLowerCase() || l === ''
}

// ---- the listing as live data ------------------------------------------------
// A gateway's models are DATA, never a fixed list in Silos: the ids and the
// limits it publishes, re-read at connect, at verify, at boot and on a timer
// (gateway-models.ts), so a pool that gains or loses a model changes what
// every screen offers — and a pinned model the key no longer runs is caught
// (gatewayModelFor; web cannotRun).

export interface GatewayModelLimit {
  context?: number
  output?: number
}
export type GatewayModelLimits = Record<string, GatewayModelLimit>
export interface GatewayListing {
  ids: string[]
  limits: GatewayModelLimits
}

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : undefined)

/** ids + the limits the listing publishes, read from the conventions in the
 *  wild: `context_length` (OpenRouter, cheapestinference), `max_context_length`,
 *  `context_window`; output from `max_output_tokens`, `max_completion_tokens`
 *  or `top_provider.max_completion_tokens`. Unknown = absent, never invented. */
export function parseModelsListing(body: unknown): GatewayListing {
  const rows: unknown[] = Array.isArray(body)
    ? body
    : typeof body === 'object' && body !== null && Array.isArray((body as { data?: unknown }).data)
      ? (body as { data: unknown[] }).data
      : typeof body === 'object' && body !== null && Array.isArray((body as { models?: unknown }).models)
        ? (body as { models: unknown[] }).models
        : []
  const ids = parseModelsList(rows)
  const limits: GatewayModelLimits = {}
  for (const row of rows) {
    if (typeof row !== 'object' || row === null) continue
    const r = row as Record<string, unknown>
    const id = typeof r.id === 'string' ? r.id.trim() : ''
    if (!ids.includes(id)) continue
    const top = typeof r.top_provider === 'object' && r.top_provider !== null ? (r.top_provider as Record<string, unknown>) : {}
    const context = num(r.context_length) ?? num(r.max_context_length) ?? num(r.context_window) ?? num(r.max_input_tokens)
    const output = num(r.max_output_tokens) ?? num(r.max_completion_tokens) ?? num(top.max_completion_tokens)
    if (context !== undefined || output !== undefined)
      limits[id] = { ...(context !== undefined ? { context } : {}), ...(output !== undefined ? { output } : {}) }
  }
  return { ids, limits }
}

/** PATCH `modelLimits`: an object of id → {context?, output?} (positive integers). */
export function checkModelLimits(v: unknown): GatewayModelLimits {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error('modelLimits must be an object of model id → { context, output }')
  const out: GatewayModelLimits = {}
  for (const [id, lim] of Object.entries(v as Record<string, unknown>)) {
    if (id.trim() === '' || id.includes('{')) throw new Error('modelLimits has an invalid model id')
    if (typeof lim !== 'object' || lim === null) throw new Error(`modelLimits.${id} must be { context, output }`)
    const l = lim as Record<string, unknown>
    const context = num(l.context)
    const output = num(l.output)
    if (l.context !== undefined && context === undefined) throw new Error(`modelLimits.${id}.context must be a positive integer`)
    if (l.output !== undefined && output === undefined) throw new Error(`modelLimits.${id}.output must be a positive integer`)
    out[id.trim()] = { ...(context !== undefined ? { context } : {}), ...(output !== undefined ? { output } : {}) }
  }
  return out
}

/** The model a gateway run uses: the pinned one when the key lists it (or
 *  when nothing is known about the key), else the key's FIRST model — a
 *  pin to a model the pool dropped must not fail every run; the UI says so
 *  separately (web cannotRun). null = no model at all (no pin, no list). */
export function gatewayModelFor(models: readonly string[] | undefined, pinned: string | null | undefined): string | null {
  const pin = pinned && pinned !== '' ? pinned : null
  if (!models || models.length === 0) return pin
  if (pin !== null && models.includes(pin)) return pin
  return models[0] ?? pin
}

/** GET `<root>/v1/models` with the key; null when the gateway lists nothing
 *  we understand (a 404, a non-JSON body, an empty list, a network error).
 *  Shared by verify, connect and the refresher — one reading of a listing. */
export async function fetchGatewayModels(fetchFn: typeof fetch, baseUrl: string, apiKey: string): Promise<GatewayListing | null> {
  try {
    const res = await fetchFn(modelsUrlFor(baseUrl), {
      headers: { accept: 'application/json', authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) return null
    const listing = parseModelsListing(await res.json().catch(() => null))
    return listing.ids.length > 0 ? listing : null
  } catch {
    return null
  }
}
