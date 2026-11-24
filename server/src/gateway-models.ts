// gateway-models.ts — a gateway's models are live data (when the
// gateway changes its models, everything follows). Every key-based
// provider's listing is re-read from the gateway itself: at boot (the
// process may have slept through a change) and on a timer, besides the
// reads connect and verify do. What a refresh writes on the row:
//   · models + modelLimits + modelsAt — what the key reaches NOW and when
//     Silos read it; the model picker, the OpenCode provider config
//     (limits included) and the Claude default model all follow;
//   · the label, when it is still the one Silos gave it (the bare partner /
//     host name, or the auto name of the PREVIOUS list) — a name the
//     operator typed is never touched.
// A gateway that does not answer leaves the row as it was: a stale list
// beats no list, and the next tick tries again. Coalesced (one refresh at a
// time), never throws, logs one line per change.
import type { ProvidersStore, StoredProvider } from './providers-store.js'
import { fetchGatewayModels, gatewayAutoLabel, isBareGatewayLabel } from './provider-models.js'

export const GATEWAY_REFRESH_MS = 6 * 60 * 60 * 1000
export const GATEWAY_BOOT_DELAY_MS = 15_000

export interface GatewayModelsDeps {
  providers: ProvidersStore
  fetch?: typeof fetch
  log?: (line: string) => void
  now?: () => Date
}

export interface RefreshOutcome {
  id: string
  label: string
  changed: boolean
  models: string[] | null
}

type KeyProvider = Extract<StoredProvider, { kind: 'anthropic-compatible' }>

export class GatewayModelsRefresher {
  private running: Promise<RefreshOutcome[]> | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private bootTimer: ReturnType<typeof setTimeout> | null = null
  constructor(private readonly deps: GatewayModelsDeps) {}

  /** boot read after a short delay (let the server come up first), then every GATEWAY_REFRESH_MS */
  start(): void {
    if (this.timer) return
    this.bootTimer = setTimeout(() => {
      void this.refreshAll()
    }, GATEWAY_BOOT_DELAY_MS)
    this.bootTimer.unref?.()
    this.timer = setInterval(() => {
      void this.refreshAll()
    }, GATEWAY_REFRESH_MS)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.bootTimer) clearTimeout(this.bootTimer)
    if (this.timer) clearInterval(this.timer)
    this.bootTimer = null
    this.timer = null
  }

  /** every key-based provider with a key; coalesced */
  refreshAll(): Promise<RefreshOutcome[]> {
    if (this.running) return this.running
    this.running = this.doRefreshAll().finally(() => {
      this.running = null
    })
    return this.running
  }

  private async doRefreshAll(): Promise<RefreshOutcome[]> {
    const out: RefreshOutcome[] = []
    for (const p of this.deps.providers.list()) {
      if (p.kind !== 'anthropic-compatible' || p.apiKey === '') continue
      out.push(await this.refreshOne(p))
    }
    return out
  }

  async refreshOne(p: KeyProvider): Promise<RefreshOutcome> {
    const listing = await fetchGatewayModels(this.deps.fetch ?? fetch, p.baseUrl, p.apiKey)
    if (listing === null) return { id: p.id, label: p.label, changed: false, models: null }
    const before = p.models ?? []
    const sameIds = before.length === listing.ids.length && before.every((m, i) => m === listing.ids[i])
    const sameLimits = JSON.stringify(p.modelLimits ?? {}) === JSON.stringify(listing.limits)
    // the row's name follows the list only while it is Silos's own name
    const silosNamed = isBareGatewayLabel(p.label, p.baseUrl) || p.label === gatewayAutoLabel(p.baseUrl, before)
    const label = silosNamed ? gatewayAutoLabel(p.baseUrl, listing.ids) : p.label
    const modelsAt = (this.deps.now ?? (() => new Date()))().toISOString()
    this.deps.providers.update(p.id, { models: listing.ids, modelLimits: listing.limits, modelsAt, ...(label !== p.label ? { label } : {}) })
    const changed = !sameIds || !sameLimits || label !== p.label
    if (changed)
      this.deps.log?.(
        `gateway-models: ${label} now lists ${listing.ids.join(', ')}${sameIds ? ' (limits changed)' : ` (was ${before.join(', ') || 'nothing'})`}`,
      )
    return { id: p.id, label, changed, models: listing.ids }
  }
}
