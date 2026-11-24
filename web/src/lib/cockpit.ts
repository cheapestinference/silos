// cockpit.ts — pure logic for the cockpit's selectors (model · effort ·
// permission mode · fast mode). Mirrors the server's cascade
// (server/src/cockpit.ts) so the chip ALWAYS shows the effective truth
// of what would go out if sent right now (proof-of-life applied to
// configuration): agent default → conversation override → turn
// override (one-shot).
import type { ConvPrefs, EffortLevel, CockpitPermissionMode, ModelInfo } from './types'

export interface CockpitEffective {
  model?: string
  effort?: EffortLevel
  permissionMode: CockpitPermissionMode
  fastMode: boolean
  provider?: string
  outputStyle?: string
}

// Same order and same field-by-field semantics as resolveCascade on the
// server. `agentProvider` is the provider's agent level (agent.provider;
// '' is the default's alias and reads as undefined here).
export function resolveEffective(
  agentModel: string | undefined,
  conv: ConvPrefs,
  turn: ConvPrefs,
  agentProvider?: string,
  agentOutputStyle?: string,
): CockpitEffective {
  const model = turn.model ?? conv.model ?? agentModel
  const effort = turn.effort ?? conv.effort
  const provider = turn.provider ?? conv.provider ?? (agentProvider ? agentProvider : undefined)
  const outputStyle = turn.outputStyle ?? conv.outputStyle ?? (agentOutputStyle ? agentOutputStyle : undefined)
  return {
    ...(outputStyle !== undefined ? { outputStyle } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(effort !== undefined ? { effort } : {}),
    ...(provider !== undefined ? { provider } : {}),
    permissionMode: turn.permissionMode ?? conv.permissionMode ?? 'bypassPermissions',
    fastMode: turn.fastMode ?? conv.fastMode ?? false,
  }
}

// Which cascade level a field's effective value comes from — the chip uses
// this to mark the one-shot ("next turn") and for the menu's state.
export type FieldOrigin = 'turn' | 'conversation' | 'agent'
export function fieldOrigin(field: keyof ConvPrefs, conv: ConvPrefs, turn: ConvPrefs): FieldOrigin {
  if (turn[field] !== undefined) return 'turn'
  if (conv[field] !== undefined) return 'conversation'
  return 'agent'
}

// The catalog entry that covers a model: by exact value, by resolvedModel
// (requesting 'claude-sonnet-5' matches the 'sonnet' alias row), or — with
// model undefined — the CLI's 'default' row if the catalog carries one.
// An honest null if the catalog doesn't know it (custom model / empty catalog).
export function modelInfo(catalog: ModelInfo[], model: string | undefined): ModelInfo | null {
  if (model === undefined) return catalog.find((m) => m.value === 'default') ?? null
  return catalog.find((m) => m.value === model) ?? catalog.find((m) => m.resolvedModel === model) ?? null
}

// The model chip's label: the catalog's displayName if it knows it, the
// raw id if not (honest — we don't dress it up), 'Default' if nobody opines.
export function modelName(catalog: ModelInfo[], model: string | undefined): string {
  const info = modelInfo(catalog, model)
  if (info) return info.displayName
  return model ?? 'Default'
}

// An honest echo: what was REQUESTED on send vs. what the SDK's init says
// actually started. A requested alias ('sonnet') that init echoes back as
// its canonical id ('claude-sonnet-5') is NOT a mismatch — the catalog
// carries that map (resolvedModel). With a requested model of undefined
// (the CLI's default) nothing is claimed, so it's never a mismatch.
// Context-suffixed ids ('[1m]') are compared without it: init echoes the
// bare id.
export interface RequestedEcho {
  model?: string
  permissionMode: string
}
export interface ReceivedEcho {
  model?: string
  permissionMode?: string
}

function withoutSuffix(id: string): string {
  return id.replace(/\[1m\]$/, '')
}

function sameModel(requested: string, received: string, catalog: ModelInfo[]): boolean {
  if (withoutSuffix(requested) === withoutSuffix(received)) return true
  const info = catalog.find((m) => m.value === requested)
  return info?.resolvedModel !== undefined && withoutSuffix(info.resolvedModel) === withoutSuffix(received)
}

export function mismatchedEchoes(requested: RequestedEcho, received: ReceivedEcho, catalog: ModelInfo[]): string[] {
  const out: string[] = []
  if (requested.model !== undefined && received.model !== undefined && !sameModel(requested.model, received.model, catalog)) {
    out.push(`ran as ${received.model}`)
  }
  if (received.permissionMode !== undefined && received.permissionMode !== requested.permissionMode) {
    out.push(`ran in ${permissionLabel(received.permissionMode)}`)
  }
  return out
}

// The cockpit's voice (mono, lowercase — the same as the affordances row).
export function permissionLabel(mode: string): string {
  switch (mode) {
    case 'bypassPermissions':
      return 'bypass'
    case 'plan':
      return 'plan mode'
    case 'acceptEdits':
      return 'accept edits'
    default:
      return mode
  }
}

// An honest fallback for when the SDK's catalog doesn't exist yet (empty):
// the only thing the system can VERIFY exists is the models already seen
// in use — agents' defaults and the open session's model. Nothing else.
export function seenModels(agentModels: Array<string | undefined>, sessionModel: string | undefined | null): string[] {
  const out = new Set<string>()
  for (const m of agentModels) if (m) out.add(m)
  if (sessionModel) out.add(sessionModel)
  return [...out]
}

// Merges a prefs patch (null = remove the field) — the same criterion as
// ConversationPrefsStore.patch on the server, for local optimistic state.
export type PrefsPatch = { [K in keyof ConvPrefs]?: ConvPrefs[K] | null }
export function applyPatch(base: ConvPrefs, patch: PrefsPatch): ConvPrefs {
  const out: Record<string, unknown> = { ...base }
  for (const [field, value] of Object.entries(patch)) {
    if (value === null) delete out[field]
    else if (value !== undefined) out[field] = value
  }
  return out as ConvPrefs
}
