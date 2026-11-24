// harnesses/registry.ts — the harness registry, a LEAF: it imports nothing at
// runtime (types only), so every neutral module and every adapter can read it
// without a cycle. It is filled when harnesses/index.ts is evaluated (the
// registration list: server/src/index.ts in production, test/setup-harnesses.ts
// for every server test). Read it only inside functions, never in a top-level
// const. Every lookup throws on an empty registry — a silent default would hide
// a missing import.

import type { Agent } from '../types.js'
import type { FenceOverlay } from '../territory.js'
import type { Harness, HarnessId, ProviderKind } from './contract.js'
import type { PermissionConfig } from './fence-rules.js'

/** Live view by id, kept for existing callers. */
export const harnesses: Record<HarnessId, Harness> = {}
const order: Harness[] = []
// bumped on every register/unregister: a caller that derives a view of the
// registry (ChatService's engine order) keeps it while this stays the same
let generation = 0

/** Moves whenever the registry changes — derived views memoize against it. */
export function registryGeneration(): number {
  return generation
}

const EMPTY = 'no harness registered — import harnesses/index.js first'

function all(): readonly Harness[] {
  if (order.length === 0) throw new Error(EMPTY)
  return order
}

/** Adds a harness. Throws on a duplicate id, a second fallback, a
 *  non-fallback without ownsId, or a non-fallback declaring deletion 'trash'
 *  (the trash route moves files under the fallback's own root — SessionStore,
 *  holder scan, lineage — so only the fallback can honour it). Returns its
 *  unregister (tests). */
export function registerHarness(h: Harness): () => void {
  if (Object.hasOwn(harnesses, h.id)) throw new Error(`harness already registered: ${h.id}`)
  if (h.fallback) {
    const other = order.find((x) => x.fallback)
    if (other) throw new Error(`a second fallback harness: ${h.id} (already ${other.id})`)
  } else if (typeof h.ownsId !== 'function') {
    throw new Error(`harness ${h.id} is not the fallback and declares no ownsId`)
  } else if (h.traits?.deletion === 'trash') {
    throw new Error(`harness ${h.id} declares deletion 'trash', which only the fallback harness supports — use 'hide'`)
  }
  // the cap and the lister travel together: a cap with no list would offer
  // an empty picker, a list with no cap would never be shown
  if ((h.caps?.outputStyles === true) !== (typeof h.outputStyles === 'function')) {
    throw new Error(`harness ${h.id}: caps.outputStyles and outputStyles() must be declared together`)
  }
  harnesses[h.id] = h
  order.push(h)
  generation++
  return () => {
    if (harnesses[h.id] !== h) return
    delete harnesses[h.id]
    const i = order.indexOf(h)
    if (i >= 0) order.splice(i, 1)
    generation++
  }
}

/** Every registered harness, in registration order. */
export function registeredHarnesses(): readonly Harness[] {
  return [...all()]
}

export function findHarness(id: unknown): Harness | undefined {
  all()
  return typeof id === 'string' && Object.hasOwn(harnesses, id) ? harnesses[id] : undefined
}

export function harnessById(id: HarnessId): Harness {
  const h = findHarness(id)
  if (!h) throw new Error(`unknown harness: ${String(id)}`)
  return h
}

/** The harness that owns every id no other claims (Claude Code). */
export function fallbackHarness(): Harness {
  const h = all().find((x) => x.fallback)
  if (!h) throw new Error('no fallback harness registered')
  return h
}

export function isHarnessId(v: unknown): v is HarnessId {
  return findHarness(v) !== undefined
}

/** The harness an agent runs on: absent/'' → the fallback (every agent
 *  predating the field); an unknown value throws — never a silent default. */
export function harnessOf(agent: Pick<Agent, 'framework'>): HarnessId {
  const fw: unknown = agent.framework
  if (fw === undefined || fw === '') return fallbackHarness().id
  if (isHarnessId(fw)) return fw
  throw new Error(`unknown harness: ${String(fw)}`)
}

/** A bare session id's harness: the first non-fallback harness whose ownsId
 *  claims it, else the fallback. */
export function harnessForId(id: string): HarnessId {
  for (const h of all()) if (!h.fallback && h.ownsId?.(id)) return h.id
  return fallbackHarness().id
}

export function harnessIds(): HarnessId[] {
  return all().map((h) => h.id)
}

/** The project's listing convention wherever engines are tried or offered in
 *  turn: non-fallback engines first (in registration order), the fallback
 *  last — ChatService.cancel asks the other engines before Claude Code, and
 *  the export route lists its targets the same way. */
export function nonFallbackFirst(list: readonly Harness[]): Harness[] {
  return [...list.filter((h) => !h.fallback), ...list.filter((h) => h.fallback)]
}

/** The reverse: the fallback first, then the others in registration order —
 *  the order ChatService.isInflight/isSessionActive have always asked in
 *  (Claude Code first), while cancel asks non-fallback first. */
export function fallbackFirst(list: readonly Harness[]): Harness[] {
  return [...list.filter((h) => h.fallback), ...list.filter((h) => !h.fallback)]
}

/** The harnesses that can run a provider kind (HarnessProviderRules.kinds). */
export function providerOwners(kind: ProviderKind): HarnessId[] {
  return all()
    .filter((h) => h.providers.kinds.includes(kind))
    .map((h) => h.id)
}

/** Who an engine-owned (harness-*) provider belongs to, in words: the
 *  harness's label when it runs harness-* providers, else the label of every
 *  engine that does ("OpenCode" today; "OpenCode or Fake" with a third).
 *  Neutral provider messages say it instead of an engine's name. */
export function engineProviderLabel(harness?: unknown): string {
  const h = findHarness(harness)
  if (h && (h.providers.kinds.includes('harness-provider') || h.providers.kinds.includes('harness-native'))) return h.label
  const labels = all()
    .filter((x) => x.providers.kinds.includes('harness-provider') || x.providers.kinds.includes('harness-native'))
    .map((x) => x.label)
  if (labels.length === 0) return 'engine'
  return labels.length === 1 ? labels[0]! : `${labels.slice(0, -1).join(', ')} or ${labels[labels.length - 1]}`
}

/** "a" or "an" before a label ("an OpenCode provider", "a Fake provider"). */
export function articleFor(label: string): 'a' | 'an' {
  return /^[aeiou]/i.test(label) ? 'an' : 'a'
}

/** A registered harness whose kinds include the kind: who a harness-*
 *  provider may belong to. */
export function ownsProviders(harness: unknown, kind: ProviderKind): harness is HarnessId {
  const h = findHarness(harness)
  return h !== undefined && h.providers.kinds.includes(kind)
}

/** "'a' or 'b'"; "'a', 'b' or 'c'". */
export function quotedIds(ids: readonly string[]): string {
  const q = ids.map((id) => `'${id}'`)
  if (q.length <= 1) return q.join('')
  return `${q.slice(0, -1).join(', ')} or ${q[q.length - 1]}`
}

/** A fence as the permission object its harness actually enforces
 *  (Harness.fencePermission: OpenCode → what the launch writes into its
 *  config; Claude Code → its own deny rules grouped by tool kind). */
export function fencePermissionFor(h: HarnessId, fence: FenceOverlay, opts: { worktree: string; home: string }): PermissionConfig {
  return harnessById(h).fencePermission(fence, opts)
}

/** The tool kinds a computed fence permission object really denies, in the
 *  words Settings › Territory shows ("read · edit"): a kind is listed only
 *  when at least one of its entries is a deny — `bash` only if a bash rule
 *  was emitted. */
export function fenceSummary(permission: PermissionConfig): string[] {
  const denies = (v: PermissionConfig[string]): boolean => v === 'deny' || (typeof v === 'object' && v !== null && Object.values(v).includes('deny'))
  return (['read', 'edit', 'bash'] as const).filter((k) => denies(permission[k]))
}
