// providers-validate.ts — Providers v1: strict validation for POST/PATCH
// /api/providers and for the provider/fallback fields on agent routes —
// errors are plain English strings (server.ts forwards them as 400 as-is,
// same pattern as automations-validate.ts).
import {
  DEFAULT_PROVIDER_ID,
  PROVIDER_ID_RE,
  assertNoBraceField,
  type ProviderInput,
  type ProviderPatch,
  type ProvidersStore,
  type ResolvedProvider,
} from './providers-store.js'
import type { HarnessId } from './harnesses/contract.js'
import { engineProviderLabel, fallbackHarness, harnessById, ownsProviders, providerOwners, quotedIds } from './harnesses/registry.js'
import { checkModelLimits, checkModels } from './provider-models.js'

function obj(v: unknown, msg: string): Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error(msg)
  return v as Record<string, unknown>
}

function checkBaseUrl(v: unknown): string {
  if (typeof v !== 'string' || v.trim() === '') throw new Error('baseUrl required')
  const url = v.trim().replace(/\/+$/, '') // no trailing slash — /v1/messages gets concatenated
  if (!/^https?:\/\//.test(url)) throw new Error('baseUrl must be http(s)')
  assertNoBraceField('baseUrl', url)
  return url
}

function checkApiKey(v: unknown): string {
  if (typeof v !== 'string' || v.trim() === '') throw new Error('apiKey required')
  // defense against echoing back a MASKED key (sk-…1234) that the UI might
  // return as-is on a PATCH — persisting it would destroy the real key.
  if (v.includes('…')) throw new Error('masked apiKey — paste the full key')
  return v.trim()
}

function checkLabel(v: unknown): string {
  if (typeof v !== 'string' || v.trim() === '') throw new Error('label required')
  const label = v.trim()
  assertNoBraceField('label', label)
  return label
}

// harness: the engine the provider is for, when known (engineProviderLabel
// names every engine that owns harness-* providers otherwise)
function checkProviderId(v: unknown, harness?: unknown): string {
  if (typeof v !== 'string' || !PROVIDER_ID_RE.test(v.trim()))
    throw new Error(`providerId required: a lowercase ${engineProviderLabel(harness)} provider id (a-z, 0-9, -)`)
  return v.trim()
}

// The body's shape and hygiene (trim, masked-key echo); the per-kind field
// rules are the store's (ProvidersStore.create), one place for both callers.
export function validateProviderCreate(body: unknown): ProviderInput {
  const o = obj(body, 'invalid body')
  const label = checkLabel(o.label)
  const kind = o.kind ?? 'anthropic-compatible'
  if (kind === 'anthropic-compatible') {
    if (o.providerId !== undefined || o.harness !== undefined) throw new Error(`providerId/harness are only for ${engineProviderLabel()} providers`)
    return {
      kind,
      label,
      baseUrl: checkBaseUrl(o.baseUrl),
      apiKey: checkApiKey(o.apiKey),
      ...(o.models !== undefined ? { models: checkModels(o.models) } : {}),
    }
  }
  if (kind === 'harness-provider' || kind === 'harness-native') {
    const engine = engineProviderLabel(o.harness)
    if (o.baseUrl !== undefined) throw new Error(`baseUrl is only for anthropic-compatible providers — ${engine} knows its providers' endpoints`)
    if (o.models !== undefined) throw new Error(`models are only for anthropic-compatible providers — ${engine} lists its own`)
    const harness = o.harness
    if (!ownsProviders(harness, kind)) throw new Error(`harness required: ${quotedIds(providerOwners(kind))}`)
    const providerId = checkProviderId(o.providerId, harness)
    if (kind === 'harness-native') {
      if (o.apiKey !== undefined) throw new Error(`apiKey not allowed: a harness-native provider uses ${harnessById(harness).label}'s own login`)
      return { kind, label, harness, providerId }
    }
    return { kind, label, harness, providerId, apiKey: checkApiKey(o.apiKey) }
  }
  // Claude accounts aren't created via this route: they're derived from
  // disk (POST /api/accounts creates the directory; the selector only sees them).
  throw new Error("invalid kind — 'anthropic-compatible', 'harness-provider' or 'harness-native'")
}

export function validateProviderPatch(body: unknown): ProviderPatch {
  const o = obj(body, 'invalid body')
  const patch: ProviderPatch = {}
  if (o.label !== undefined) patch.label = checkLabel(o.label)
  if (o.baseUrl !== undefined) patch.baseUrl = checkBaseUrl(o.baseUrl)
  if (o.apiKey !== undefined) patch.apiKey = checkApiKey(o.apiKey)
  if (o.providerId !== undefined) patch.providerId = checkProviderId(o.providerId)
  if (o.models !== undefined) patch.models = checkModels(o.models)
  if (o.modelLimits !== undefined) patch.modelLimits = checkModelLimits(o.modelLimits)
  if (Object.keys(patch).length === 0) throw new Error('nothing to update')
  return patch
}

// THE cross-harness rule — one validator for every place a provider id is
// written (agent provider + fallback, a conversation's pin, a turn's
// override, a console's pick), so the cockpit cascade can never hand a
// harness a provider it cannot run: a Claude account never runs on OpenCode
// (Anthropic restricts subscription OAuth to Claude Code), and an OpenCode
// provider never reaches a Claude process. The default ('default' and its
// aliases) is harness-neutral: it is "no provider chosen" — every agent is
// born with it (agent-registry DEFAULT_PROVIDER), and on OpenCode it means
// the operator's own OpenCode defaults (nothing injected).
export function providerHarnessError(p: ResolvedProvider, harness: HarnessId): string | null {
  if (p.id === DEFAULT_PROVIDER_ID) return null
  const h = harnessById(harness)
  if (p.kind === 'harness-provider' || p.kind === 'harness-native')
    return p.harness === harness && h.providers.kinds.includes(p.kind) ? null : `this provider is for ${harnessById(p.harness).label} agents`
  if (!h.providers.kinds.includes(p.kind))
    return p.kind === 'claude-account' ? `a Claude account cannot run on ${h.label}` : `this provider cannot run on ${h.label}`
  return null
}

// A provider id about to be written for a harness: it must exist NOW and
// suit the harness. Returns the error message (400) or null.
export function providerIdError(id: string, harness: HarnessId, providers: Pick<ProvidersStore, 'resolve'>): string | null {
  const p = providers.resolve(id)
  if (!p) return `unknown provider: ${id}`
  return providerHarnessError(p, harness)
}

// provider/fallback fields on an agent (POST/PATCH /api/agents): the ids
// written must exist TODAY — tolerating ids that later stop existing is
// handled at read time (resolveForAgent), not at write time. The
// cross-harness rule applies to the EFFECTIVE values (the body's, else the
// agent's current ones — a legacy agent stamped with a harness keeps its
// provider) whenever they resolve.
export function validateAgentProviderFields(
  body: unknown,
  providers: ProvidersStore,
  harness: HarnessId = fallbackHarness().id,
  existing?: { provider?: string; fallback?: string[] },
): void {
  if (typeof body !== 'object' || body === null) return
  const o = body as Record<string, unknown>
  const known = new Set(providers.knownIds())
  if (o.provider !== undefined) {
    if (typeof o.provider !== 'string') throw new Error('provider must be a provider id')
    if (!known.has(o.provider)) throw new Error(`unknown provider: ${o.provider}`)
  }
  if (o.fallback !== undefined) {
    if (!Array.isArray(o.fallback) || !o.fallback.every((s) => typeof s === 'string')) {
      throw new Error('fallback must be an array of provider ids')
    }
    for (const id of o.fallback) {
      if (!known.has(id)) throw new Error(`fallback contains an unknown provider: ${id}`)
    }
  }
  const provider = (o.provider as string | undefined) ?? existing?.provider
  const fallback = (o.fallback as string[] | undefined) ?? existing?.fallback ?? []
  for (const id of [...(provider !== undefined ? [provider] : []), ...fallback]) {
    const p = providers.resolve(id)
    const err = p ? providerHarnessError(p, harness) : null
    if (err) throw new Error(err)
  }
}

// An engine's login import (its ui.loginImport.import route; OpenCode's is
// POST /api/providers/import-opencode) — which of the engine's logins to copy
// into a new harness-provider, and the label to give it (the key itself is
// read by the engine's route from its own store, never sent by the browser).
export function validateLoginImport(body: unknown, harness: HarnessId): { providerId: string; label: string } {
  const o = obj(body, 'invalid body')
  return { providerId: checkProviderId(o.providerId, harness), label: checkLabel(o.label) }
}
