// useModelOptions — THE model filter for an agent's harness, shared by the
// agent form (AgentModal, SettingsTab) and the composer's model chip
// (CockpitChips): one filter, every call site.
//   · Claude Code: the long-standing list the caller passes (AgentModal
//     MODELS) — untouched.
//   · OpenCode: the models `opencode models` lists (server cache, GET
//     /api/models?harness=opencode), narrowed to what the chosen provider
//     can reach — a Claude model never shows on an OpenCode agent.
//   · A gateway (Anthropic-compatible provider) whose models Silos learned
//     (provider.models, POST /api/providers/:id/models): that list, on
//     either engine — a Claude agent on cheapestinference runs the pool's
//     models, not the Claude catalog.
//   · OpenCode on a gateway with no known list: no list (its models are
//     the gateway's own names, run as `silos-<id>/<model>`) — `gateway` is
//     set and the caller offers a typed model id instead.
// The current value always stays selectable (a custom id typed elsewhere,
// a model the catalogue no longer lists).
import { useEffect, useState } from 'react'
import { api } from '../lib/api'
import { gatewayModels, gatewayProviderAlias } from '../lib/providers'
import { useHarness } from '../lib/harnesses'
import type { HarnessId, ModelInfo, ProviderView } from '../lib/types'

export interface ModelOption {
  value: string
  label: string
}
export interface ModelPick {
  options: ModelOption[]
  // OpenCode's catalogue for the provider (empty for Claude Code)
  models: ModelInfo[]
  // 'silos-<id>' when the provider is an Anthropic-compatible gateway on OpenCode
  gateway: string | null
  // the values the provider itself lists — WITHOUT the current value appended
  // for selectability (callers deciding whether the current model is the
  // provider's read this, not `options`)
  listed: string[]
}

export const GATEWAY_MODEL_PLACEHOLDER = 'model id as your gateway names it, e.g. claude-sonnet-4-5'

export function useModelOptions(
  harness: HarnessId | undefined,
  provider: string | undefined,
  current: string,
  claudeModels: ModelOption[],
  // null = still loading: no catalogue asked until the provider's kind is known
  providers: readonly ProviderView[] | null = [],
): ModelPick {
  const d = useHarness(harness)
  // a per-provider catalogue of `provider/model` ids, shown raw (OpenCode);
  // 'catalog' = the caller's list (Claude Code); 'none' = no list, typed id only
  const byProvider = d.ui.models === 'provider-model'
  const engineId = d.id
  const gateway = byProvider ? gatewayProviderAlias(providers ?? [], provider) : null
  const known = providers !== null
  const [models, setModels] = useState<ModelInfo[]>([])

  useEffect(() => {
    if (!known) return
    if (!byProvider || gateway !== null) {
      setModels((prev) => (prev.length === 0 ? prev : []))
      return
    }
    let cancelled = false
    // Promise.resolve: the test automock returns undefined
    Promise.resolve(api.models(engineId, { provider: provider === undefined || provider === '' ? 'default' : provider }))
      .then((v) => {
        if (!cancelled) setModels(v?.models ?? [])
      })
      .catch(() => {
        if (!cancelled) setModels([])
      })
    return () => {
      cancelled = true
    }
  }, [byProvider, engineId, gateway, provider, known])

  // a gateway whose models are known lists THEM, on either engine — never a
  // "Default" row: with a gateway pinned, no model would send OpenCode to its
  // own default provider's model, a silent swap of accounts (launch.ts)
  const gwModels = gatewayModels(providers ?? [], provider)
  const list =
    gwModels !== null
      ? gwModels.map((m) => ({ value: m, label: m }))
      : // a gateway with no known list has NO default row either: "OpenCode's
        // own" would mean no model, i.e. OpenCode's own default provider
        gateway !== null
        ? []
        : byProvider
          ? [...(d.ui.ownLogin ? [{ value: '', label: `Default — ${d.label}’s own` }] : []), ...models.map((m) => ({ value: m.value, label: m.value }))]
          : d.ui.models === 'catalog'
            ? claudeModels
            : []
  const options = current !== '' && !list.some((o) => o.value === current) ? [...list, { value: current, label: current }] : list
  return { options, models: byProvider ? models : [], gateway, listed: list.map((o) => o.value) }
}
