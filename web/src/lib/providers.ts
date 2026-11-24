// providers.ts — Providers v1: helpers shared between the per-agent
// provider selector (AgentPage > Settings), the conversation/badge "on
// fallback" indicator, and the Board.
import type { AgentView, HarnessId, ProviderView, SessionDetail } from './types'
import { resumeLabel } from './rate-limits'
import { descriptorOf } from './harnesses'

export interface ProviderOption {
  value: string // '' = default
  label: string
  kind: ProviderView['kind']
  // a key provider whose key was cleared (its endpoint/providerId changed
  // without a re-paste): shown, never usable until the key is pasted again
  needsKey: boolean
}

// an engine-owned provider kind: it carries the `harness` it was made for
function isEngineProvider(p: ProviderView): p is Extract<ProviderView, { kind: 'harness-provider' | 'harness-native' }> {
  return p.kind === 'harness-provider' || p.kind === 'harness-native'
}

// The providers a harness can run (the server's cross-harness rule,
// providers-validate.ts providerHarnessError): the kinds its descriptor
// lists, an engine-owned provider only on the engine it was made for, and
// the default — "no provider chosen" — always (harness-neutral). Claude
// Code never takes an OpenCode provider; OpenCode never takes a Claude
// account; an engine this web does not know takes only the default.
export function providersForHarness(providers: ProviderView[], harness: HarnessId | undefined): ProviderView[] {
  const d = descriptorOf(harness)
  return providers.filter((p) => p.id === 'default' || (d.providerKinds.includes(p.kind) && (!isEngineProvider(p) || p.harness === d.id)))
}

// apiKey '' = the server invalidated it (providers-store.ts update()).
export function providerNeedsKey(p: ProviderView): boolean {
  return (p.kind === 'anthropic-compatible' || p.kind === 'harness-provider') && p.apiKey === ''
}

// the selector's options: Default · every Claude account · every key-based
// provider — narrowed to the agent's harness. The default is represented as
// '' in the form (see AgentFormState).
export function providerOptions(providers: ProviderView[], harness?: HarnessId): ProviderOption[] {
  return providersForHarness(providers, harness).map((p) => ({
    value: p.id === 'default' ? '' : p.id,
    label: p.label,
    kind: p.kind,
    needsKey: providerNeedsKey(p),
  }))
}

export function providerLabel(providers: ProviderView[], id: string): string {
  return providers.find((p) => p.id === id)?.label ?? id
}

// cheapestinference: the partner's anthropic-compatible proxy. An EXACT
// baseUrl ('cheapestinference.com.evil.io' must not pass).
export const CHEAPESTINFERENCE_BASE_URL = 'https://api.cheapestinference.com/anthropic'
// where a subscriber copies their keys (the dashboard's /keys page)
export const CHEAPESTINFERENCE_KEYS_URL = 'https://cheapestinference.com/pools'

export function isCheapestProvider(p: ProviderView): boolean {
  return p.kind === 'anthropic-compatible' && p.baseUrl === CHEAPESTINFERENCE_BASE_URL
}

// is the agent already running on cheapestinference? — its active provider
// (or its current fallback) resolves to the cheapest proxy. Used to NOT
// show the nudge to someone who already bought it (an honest limit
// banner). With no provider set, the agent runs on the default
// (Anthropic) -> not-cheapest.
export function agentOnCheapest(agent: Pick<AgentView, 'provider' | 'onFallback'> | null | undefined, providers: ProviderView[]): boolean {
  if (!agent) return false
  const resolves = (id: string | undefined): boolean => {
    if (!id || id === 'default') return false
    const p = providers.find((x) => x.id === id)
    return p !== undefined && isCheapestProvider(p)
  }
  return resolves(agent.provider) || resolves(agent.onFallback?.providerId)
}

// "on fallback · resumes HH:MM" — null if the agent is running on its primary.
// if the primary's reset is weekly (>24h), resumeLabel adds the day +
// "weekly" — a bare "resumes 14:05" would be misleading for days.
export function fallbackBadge(agent: Pick<AgentView, 'onFallback'> | null | undefined): string | null {
  const fb = agent?.onFallback
  if (!fb) return null
  const label = resumeLabel(fb.until)
  return label === null ? 'on fallback' : `on fallback · ${label}`
}

// ---- `provider/model` ids, for an engine whose descriptor says
// ui.models 'provider-model' (today OpenCode; the mirror of server
// harnesses/opencode/launch.ts providerLaunch) — an agent/conversation
// stores the BARE model id; the launch puts it under the provider's id, and
// a Silos gateway runs as its own `silos-<id>` provider. A third
// 'provider-model' engine is read with this same naming (docs/harnesses.md,
// known limits). ------------------------------------------------------------

const isDefaultId = (id: string | null | undefined): boolean => id === undefined || id === null || id === '' || id === 'default'

/** An Anthropic-compatible gateway on a 'provider-model' engine runs as its own `silos-<id>`
 *  provider: its models are whatever the gateway names them, so the picker
 *  takes a typed id. null for every other provider. */
export function gatewayProviderAlias(providers: readonly ProviderView[], providerId: string | null | undefined): string | null {
  if (isDefaultId(providerId)) return null
  const p = providers.find((x) => x.id === providerId)
  return p?.kind === 'anthropic-compatible' ? `silos-${p.id}` : null
}

/** The `provider/model` id a 'provider-model' launch names for a stored model. */
export function providerModelId(providers: readonly ProviderView[], providerId: string | null | undefined, model: string | null | undefined): string | null {
  if (!model) return null
  const p = isDefaultId(providerId) ? undefined : providers.find((x) => x.id === providerId)
  const prefix = p?.kind === 'anthropic-compatible' ? `silos-${p.id}` : p?.kind === 'harness-provider' || p?.kind === 'harness-native' ? p.providerId : null
  if (prefix === null) return model
  return model.startsWith(`${prefix}/`) ? model : `${prefix}/${model}`
}

/** A typed gateway model id, stored bare (a pasted `silos-<id>/` is dropped). */
export function bareGatewayModel(gateway: string, typed: string): string {
  const t = typed.trim()
  return t.startsWith(`${gateway}/`) ? t.slice(gateway.length + 1) : t
}

// ---- a gateway's own models + "why can't this conversation run" ------------

/** The model ids an Anthropic-compatible provider's key reaches (learned by
 *  POST /api/providers/:id/models), for EITHER engine — a Claude agent on a
 *  gateway runs the gateway's models, not the Claude catalog. null = the
 *  provider is not a gateway, or its list is unknown (the picker then takes
 *  a typed id). */
export function gatewayModels(providers: readonly ProviderView[], providerId: string | null | undefined): string[] | null {
  if (isDefaultId(providerId)) return null
  const p = providers.find((x) => x.id === providerId)
  if (p?.kind !== 'anthropic-compatible' || !p.models || p.models.length === 0) return null
  return p.models
}

/** `https://api.cheapestinference.com/anthropic` → `api.cheapestinference.com`
 *  (`www.` dropped); an unparsable string comes back as typed. */
export function gatewayHost(baseUrl: string): string {
  try {
    return new URL(baseUrl).host.replace(/^www\./, '')
  } catch {
    return baseUrl
  }
}

/** The name a pasted key's row gets without asking: the host, then what the
 *  key reaches ("api.cheapestinference.com · kimi-k3, qwen3.8-max"; more
 *  than three models fold as "+N"). A known partner reads by its name. */
export function gatewayAutoLabel(baseUrl: string, models: readonly string[]): string {
  const host = baseUrl === CHEAPESTINFERENCE_BASE_URL ? 'cheapestinference' : gatewayHost(baseUrl)
  if (models.length === 0) return host
  const shown = models.slice(0, 3).join(', ')
  return `${host} · ${shown}${models.length > 3 ? ` +${models.length - 3}` : ''}`
}

export const CANNOT_RUN_CAP = 160

/** Why this conversation cannot run right now, in the provider's own words —
 *  or null when nothing says it can't. Two honest sources, nothing inferred:
 *  the provider it is pinned to has no key (cleared server-side), or the
 *  LAST turn is the engine's own refusal band (a synthetic assistant turn
 *  that closed the turn: "zai: Insufficient balance… (429)"). An older
 *  refusal with a real turn after it is history, not a state. */
export function cannotRun(
  detail: Pick<SessionDetail, 'turns'> | null | undefined,
  providers: readonly ProviderView[],
  effectiveProviderId: string | null | undefined,
  // the model the conversation would run (its pin, else the agent's): a key
  // that no longer lists it is the third honest source
  effectiveModel?: string | null,
): string | null {
  if (!isDefaultId(effectiveProviderId)) {
    const p = providers.find((x) => x.id === effectiveProviderId)
    if (p && providerNeedsKey(p)) return `${p.label}: key needed`
    if (p?.kind === 'anthropic-compatible' && effectiveModel && p.models && p.models.length > 0 && !p.models.includes(effectiveModel)) {
      return `${p.label} no longer lists ${effectiveModel}`
    }
  }
  const last = detail?.turns.at(-1)
  if (last && last.role === 'assistant' && last.synthetic && last.turnEnded && last.text.trim() !== '') {
    const line = last.text.trim().split('\n')[0] ?? ''
    return line.length > CANNOT_RUN_CAP ? `${line.slice(0, CANNOT_RUN_CAP - 1)}…` : line
  }
  return null
}
