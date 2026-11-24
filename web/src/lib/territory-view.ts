// territory-view.ts — the pure reading behind Settings › Territory: per
// agent, what each of the fence's three surfaces holds
// right now. Files from /api/territory, secrets from the masked /api/vault
// list (the same per-agent view as the agent's Secrets tab: vault-view.ts),
// network from /api/territory/egress. No fetching here.
import { effectiveVaultFor } from './vault-view'
import type { AgentEgress, EgressRejection, VaultEntry } from './types'

/** Does `host` fall under an allowlist `pattern`? A mirror of the proxy's
 *  own rule (server egress-proxy.ts hostMatches): exact; `*.d` = any
 *  subdomain of d at any depth (never d itself); `*-s` = a first label that
 *  ends with `-` + the rest of s. */
export function hostMatches(host: string, pattern: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, '')
  const p = pattern.toLowerCase()
  if (p.startsWith('*.')) {
    const suffix = p.slice(1)
    return h.length > suffix.length && h.endsWith(suffix)
  }
  if (p.startsWith('*-')) {
    const suffix = p.slice(1)
    if (h.length <= suffix.length || !h.endsWith(suffix)) return false
    return !h.slice(0, h.length - suffix.length).includes('.')
  }
  return h === p
}

/** The host a signed entry calls (its binding's baseUrl), or null. */
export function signedHostOf(entry: VaultEntry): string | null {
  if (!entry.binding) return null
  try {
    return new URL(entry.binding.baseUrl).hostname.toLowerCase()
  } catch {
    return null
  }
}

/** A surface's state at rest: held, partly held, open, or nothing to hold. */
export type Hold = 'held' | 'partial' | 'open' | 'none'

export interface SecretsReading {
  /** the secrets that reach it, signed (never in its hands) */
  signed: { name: string; host: string | null }[]
  /** …and delivered (in its environment) */
  delivered: string[]
  hold: Hold
}

/** The secrets that reach an agent — public entries (plain configuration,
 *  not secrets) left out — split by how they reach it. */
export function secretsOf(entries: VaultEntry[], agentId: string, folder: string | null): SecretsReading {
  const reach = effectiveVaultFor(entries, agentId, folder).filter((v) => v.entry.public !== true)
  const signed = reach.filter((v) => v.entry.binding).map((v) => ({ name: v.name, host: signedHostOf(v.entry) }))
  const delivered = reach.filter((v) => !v.entry.binding).map((v) => v.name)
  const hold: Hold = reach.length === 0 ? 'none' : delivered.length === 0 ? 'held' : signed.length === 0 ? 'open' : 'partial'
  return { signed, delivered, hold }
}

/** The signed services an agent on `allowlist` works with WITHOUT being able
 *  to call them — the call leaves the server. Hosts its allowlist (or
 *  its engine's pinned list) also covers are not that: it could call those. */
export function servedNotCallable(secrets: SecretsReading, egress: AgentEgress | undefined): { name: string; host: string }[] {
  if (!egress || egress.mode !== 'allowlist') return []
  const allowed = [...egress.hosts, ...(egress.engine?.hosts ?? []).filter((h) => !h.optional).map((h) => h.host)]
  return secrets.signed.flatMap((s) => (s.host !== null && !allowed.some((p) => hostMatches(s.host!, p)) ? [{ name: s.name, host: s.host }] : []))
}

/** Refusals in the last day, per agent — the roster's one problem word. */
export function refusedToday(rows: EgressRejection[], now: number = Date.now()): Map<string, number> {
  const out = new Map<string, number>()
  for (const r of rows) {
    const t = Date.parse(r.at)
    if (Number.isFinite(t) && now - t < 24 * 3600_000) out.set(r.agentId, (out.get(r.agentId) ?? 0) + 1)
  }
  return out
}
