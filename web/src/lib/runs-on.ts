// runs-on.ts — what an agent ACTUALLY runs on, in words a person recognizes
// ("default model · default provider" says nothing). Model:
// the one observed in the open conversation first (the transcript's own
// `model`), then the agent's setting, then the catalog's default — always
// resolved through the catalog to a display name. Provider: the account or
// proxy the agent's provider id resolves to ('' / 'default'
// = the machine's own Claude login), the active fallback named as such.
import type { AgentView, HarnessId, ModelInfo, ProviderView } from './types'
import { providerModelId } from './providers'
import { descriptorOf } from './harnesses'

const DEFAULT_IDS = new Set(['', 'default'])

// "claude-opus-5[1m]" → "Opus 5 · 1M" when the catalog has no name for it.
export function prettyModelId(id: string): string {
  const ctx = /\[(\d+)m\]$/i.exec(id)
  const base = id.replace(/\[\d+m\]$/i, '').replace(/^claude-/, '')
  const words = base
    .split('-')
    .filter(Boolean)
    .map((w) => (/^\d/.test(w) ? w : w[0]!.toUpperCase() + w.slice(1)))
  // consecutive version parts read as one number: sonnet-4-5 → "Sonnet 4.5"
  const name = words.reduce((acc, w, i) => (i > 0 && /^\d/.test(w) && /^\d/.test(words[i - 1]!) ? `${acc}.${w}` : acc ? `${acc} ${w}` : w), '')
  return ctx ? `${name} · ${ctx[1]}M` : name
}

export function modelLabel(catalog: readonly ModelInfo[], id: string | null | undefined): string {
  const wanted = id && id !== 'default' ? id : 'default'
  const entry = catalog.find((m) => m.value === wanted) ?? catalog.find((m) => m.resolvedModel === wanted)
  if (entry && entry.value !== 'default') return entry.displayName
  // the default entry's own name ("Default (recommended)") says nothing —
  // name what it resolves to: a sibling entry with the same resolved id,
  // else the id itself, prettified.
  const resolved = entry?.resolvedModel ?? (wanted === 'default' ? null : wanted)
  if (!resolved) return 'default model'
  const sibling = catalog.find((m) => m.value !== 'default' && m.resolvedModel === resolved)
  return sibling?.displayName ?? prettyModelId(resolved)
}

// '' / 'default' both mean the machine's own Claude login.
export function canonicalProviderId(id: string | null | undefined): string {
  return DEFAULT_IDS.has(id ?? '') ? 'default' : (id as string)
}

// One voice for every provider wherever it is named (the runs-on line, the
// account chip's menu): an account reads as its plan and who it belongs to
// — the owner must always see WHOSE subscription a conversation spends —
// a key as its label, an unknown id as itself (honest, never dressed up).
export function providerLabel(providers: readonly ProviderView[], id: string | null | undefined): string {
  const wantedId = canonicalProviderId(id)
  const p = providers.find((x) => x.id === wantedId)
  if (!p) return wantedId === 'default' ? 'Claude subscription' : wantedId
  if (p.kind === 'claude-account') {
    // by EMAIL (Claude's own answer): two accounts of one person carry the
    // same claude.ai display name («sam» twice)
    const who = p.account.email ?? (p.id === 'default' ? null : p.account.name)
    const plan = p.account.plan ? `Claude ${p.account.plan}` : 'Claude subscription'
    return who ? `${plan} · ${who}` : plan
  }
  return p.label
}

// The chip's short form: who the account belongs to (or 'this machine'),
// a key's label. The full plan · who form stays for the runs-on line.
export function providerShortLabel(providers: readonly ProviderView[], id: string | null | undefined): string {
  const wantedId = canonicalProviderId(id)
  const p = providers.find((x) => x.id === wantedId)
  if (!p) return wantedId === 'default' ? 'this machine' : wantedId
  // the email's local part (unique where the display name is not)
  if (p.kind === 'claude-account') return emailLocal(p.account.email) ?? (p.id === 'default' ? 'this machine' : p.account.name)
  return providerBrand(p)
}

// A key's row is named "<brand> · <the models it reaches>" (server
// gatewayAutoLabel) — the full name belongs to Settings; where the model is
// already written next to it (runs-on line, chips) the brand alone is the
// provider's name. A name the operator typed is kept whole.
export function emailLocal(email: string | null | undefined): string | null {
  if (!email) return null
  const at = email.indexOf('@')
  return at > 0 ? email.slice(0, at) : email
}

export function providerBrand(p: ProviderView): string {
  if (p.kind !== 'anthropic-compatible') return p.label
  const cut = p.label.indexOf(' · ')
  return cut > 0 ? p.label.slice(0, cut) : p.label
}

// What a conversation runs on: its own pin (the `provider` pref) first,
// the agent's provider otherwise. The agent's active fallback is named
// only when it diverts THIS conversation — its primary is the provider
// that hit the limit (the server applies exactly that rule, chat-service
// providerForTurn); a conversation pinned elsewhere keeps its account.
export function providerRunsOn(providers: readonly ProviderView[], agent: Pick<AgentView, 'provider' | 'onFallback'>, pinned?: string | null): string {
  const primary = canonicalProviderId(pinned ?? agent.provider)
  const fb = agent.onFallback
  if (fb && canonicalProviderId(fb.from) === primary) return `${brandOf(providers, fb.providerId)} (fallback)`
  return brandOf(providers, primary)
}

// the provider's name beside a model: an account by its person, a key by its brand
function brandOf(providers: readonly ProviderView[], id: string): string {
  const p = providers.find((x) => x.id === id)
  return p && p.kind === 'anthropic-compatible' ? providerBrand(p) : providerLabel(providers, id)
}

export function runsOnLine(input: {
  agent: AgentView
  providers: readonly ProviderView[]
  catalog: readonly ModelInfo[]
  observedModel?: string | null
  pinnedProvider?: string | null
  // the conversation's own model pin (falls back to the agent's)
  pinnedModel?: string | null
  // provider-model engines (OpenCode): the provider/model the last prompt asked for (the TUI's pick)
  requestedModel?: string | null
  harness?: HarnessId
}): string {
  // model ids written `provider/model`, read raw, with a console-requested model (OpenCode)
  if (descriptorOf(input.harness).ui.models === 'provider-model') {
    // What the console will run NEXT is the truth: the TUI restores agent and
    // model from the session's last prompt (1.19.4 source, prompt/index.tsx),
    // so on a live session the pin cannot land by itself — the line says the
    // console's model first and names a pin that differs ("pinned: glm-5.3",
    // the owner picks it in the console's model picker; the pin follower then
    // records it). Without a prompt yet, the pin (enforced at launch), then
    // the last answer's model, then the agent's default under the provider's id.
    const provider = input.pinnedProvider ?? input.agent.provider
    const pinned = input.pinnedModel ? providerModelId(input.providers, provider, input.pinnedModel) : null
    const requested = input.requestedModel ?? null
    const line = providerModelRunsOn(
      requested ?? pinned ?? input.observedModel ?? providerModelId(input.providers, provider, input.agent.model),
      input.providers,
    )
    if (requested !== null && pinned !== null && requested !== pinned) return `${line} · pinned: ${bareModel(pinned)}`
    return line
  }
  // the conversation's pin first on Claude too: the observed model
  // is the LAST ANSWER's and lags a switch — a pick read back as the old
  // model on refresh looked like it had not stuck
  return `${modelLabel(input.catalog, input.pinnedModel ?? input.observedModel ?? input.agent.model)} · ${providerRunsOn(input.providers, input.agent, input.pinnedProvider)}`
}

// A 'provider-model' engine (OpenCode) reports its model as
// `providerID/modelID` and pays through its own providers — the Claude catalog and Claude accounts say nothing about
// it. The line prints what the harness observed, as written: the model id
// (its own capitalization IS the name, "MiniMax-M2.7") · the provider id.
// A Silos gateway (`silos-<id>/<model>`) prints the bare model — the
// gateway's own name for it — followed by the gateway's brand.
/** `silos-ci/mimo-v2.6-flash` → `mimo-v2.6-flash`; `zai/glm-5.1` → `glm-5.1`; a bare id as is. */
export function bareModel(id: string): string {
  const slash = id.indexOf('/')
  return slash > 0 ? id.slice(slash + 1) : id
}

function providerModelRunsOn(observed: string | null | undefined, providers: readonly ProviderView[]): string {
  if (!observed) return 'model not reported yet'
  const slash = observed.indexOf('/')
  if (slash <= 0) return observed
  const prefix = observed.slice(0, slash)
  if (prefix.startsWith('silos-')) {
    // a Silos gateway: the model as the gateway names it, then the gateway's
    // brand — never the raw `silos-<uuid>/` id OpenCode reports
    const gw = providers.find((p) => p.id === prefix.slice('silos-'.length))
    return gw ? `${observed.slice(slash + 1)} · ${providerBrand(gw)}` : observed.slice(slash + 1)
  }
  return `${observed.slice(slash + 1)} · ${prefix}`
}

// `silos-<id>` is how OpenCode names a Silos key internally — an engine
// detail, never a word for the owner. Any text an engine wrote (an error
// band, a refusal reason) gets each such token replaced by the key's brand;
// an id Silos no longer knows becomes "a removed key".
const SILOS_PROVIDER_TOKEN = /\bsilos-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/gi
export function humanizeProviderIds(text: string, providers: readonly ProviderView[]): string {
  return text.replace(SILOS_PROVIDER_TOKEN, (_m, id: string) => {
    const p = providers.find((x) => x.id.toLowerCase() === id.toLowerCase())
    return p ? providerBrand(p) : 'a removed key'
  })
}

// What an automation's runs run on, in the voice above: "Haiku 4.5",
// "Haiku 4.5 · kai", "this machine" — null when it runs on its agent's
// default. One label for the list, the page and the editor.
export function automationRunsOnLabel(
  runsOn: { provider?: string; model?: string } | undefined,
  providers: readonly ProviderView[],
  catalog: readonly ModelInfo[],
): string | null {
  if (!runsOn || (!runsOn.provider && !runsOn.model)) return null
  const model = runsOn.model ? (runsOn.model.includes('/') ? bareModel(runsOn.model) : modelLabel(catalog, runsOn.model)) : null
  const account = runsOn.provider ? providerShortLabel(providers, runsOn.provider) : null
  return [model, account].filter(Boolean).join(' · ')
}
