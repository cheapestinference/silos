// fallback.ts — Providers v1, SIMPLE FALLBACK: an ordered per-agent chain
// (primary → fallback), switching ONLY at a TURN BOUNDARY — the turn that
// hit the rate limit finishes as usual (waiting_reset in the resident, an
// error in an interactive chat); it's the NEXT turn that goes out through
// the fallback provider.
//
// Case (a) — fallback to a key-based provider (cheapestinference/BYOK): same
// CLAUDE_CONFIG_DIR, transcripts don't move — the next turn simply uses the
// fallback's env (resume included). Fully supported in v1.
//
// Case (b) — fallback to a Claude account: also used at runtime.
// pickFallback() takes a claude-account entry like any other — every account
// dir links its projects/ to the machine's (harnesses/claude-code/accounts.ts
// SHARED_DIRS), so the index sees what a fallback account writes. The agent
// Settings picker still offers only key-based providers; an account reaches
// the chain through the API.
import type { ResolvedProvider } from './providers-store.js'

// Moved here from resident.ts (same behavior, resident re-imports it) —
// ChatService also needs it: anthropic-compatible proxies normally do NOT
// emit rate_limit_event, their 429 arrives as error text, and it has to be
// recognized in order to BURN the fallback.
//
// One predicate, every wording a limit has arrived with (it also feeds the
// resident's keep-alive/auto-resume and the titler's cooldown):
//   "429: rate limit exceeded" · "Claude AI usage limit reached|…"
//   "You've hit your session limit · resets 5:50am (Europe/Berlin)"
//   "You've reached your Fable limit. Switch to another model…" (and
//   "your Fable 5 limit", "your Opus limit", any model/plan name)
//   "5-hour limit reached" · "weekly limit reached" · "… resets at 5pm"
const RATE_LIMIT_PATTERNS: RegExp[] = [
  /\brate[ _-]?limit/i,
  /\busage limit\b/i,
  /\bsession limit\b/i,
  /\bresets at\b/i,
  /\b(?:reached|hit) your [\w .-]{0,40}?\blimit\b/i,
  /\b(?:weekly|daily|monthly|\d+[- ]hour) limit\b/i,
]

export function looksLikeRateLimit(text: string): boolean {
  return RATE_LIMIT_PATTERNS.some((re) => re.test(text))
}

export interface FallbackState {
  providerId: string
  // the provider that hit the limit. A turn whose primary is a DIFFERENT
  // provider (a conversation pinned to another account) is not diverted.
  from: string
  until: string // ISO — the primary's resetsAt; past that instant it goes back to the primary
}

// Classification of ONE chain entry, extracted from pickFallback so any
// other surface (the settings Map) judges entries with EXACTLY the same
// semantics as the runtime — a single implementation, zero
// reimplementations that could drift.
//  - 'unknown': broken id (provider deleted, typo) — the runtime SKIPS it.
//  - 'usable': a real fallback candidate — a key-based provider or a Claude
//    account alike (case (b) of the header is closed: every account dir
//    links its projects/ to the machine's, so the index sees what a
//    fallback account writes — see harnesses/claude-code/accounts.ts SHARED_DIRS).
export type ChainEntry = { status: 'usable'; provider: ResolvedProvider } | { status: 'unknown' }

export function classifyChainEntry(id: string, resolve: (id: string) => ResolvedProvider | null): ChainEntry {
  const p = resolve(id)
  if (!p) return { status: 'unknown' }
  return { status: 'usable', provider: p }
}

// Walks the chain in order and picks the first USABLE provider: it exists
// and it isn't the one that just hit the limit. Returns null if there's no
// candidate. `warn` is kept for callers that log skipped entries.
export function pickFallback(
  chain: string[] | undefined,
  resolve: (id: string) => ResolvedProvider | null,
  limitedProviderId: string,
  warn?: (msg: string) => void,
): ResolvedProvider | null {
  for (const id of chain ?? []) {
    if (id === limitedProviderId) continue
    const entry = classifyChainEntry(id, resolve)
    if (entry.status === 'unknown') {
      warn?.(`fallback: skipping unknown provider '${id}' from the chain`)
      continue // broken id in the chain — tolerated on read, keep walking
    }
    return entry.provider
  }
  return null
}

// In-memory state per agent: which fallback provider is active and until
// when. NOT persisted on purpose — after a restart, the next rate limit
// re-establishes it on its own (same criterion as the resident's
// pendingSeen: it only needs to survive while the process is alive).
export class FallbackTracker {
  private states = new Map<string, FallbackState>()
  private warned = new Set<string>()

  // Called when a 'rejected' rate limit with resetsAt is seen on an agent's
  // turn. If the limited one WAS already the active fallback, it's cleared
  // (the chain has nothing more to give — the next turn falls back to the
  // primary and will wait for the reset as usual; no loops).
  note(
    agentId: string,
    chain: string[] | undefined,
    resolve: (id: string) => ResolvedProvider | null,
    limitedProviderId: string,
    resetsAt: string,
  ): FallbackState | null {
    const current = this.states.get(agentId)
    if (current && current.providerId === limitedProviderId) {
      this.states.delete(agentId)
      return null
    }
    const picked = pickFallback(chain, resolve, limitedProviderId, (msg) => {
      const key = `${agentId}:${msg}`
      if (this.warned.has(key)) return
      this.warned.add(key)
      console.warn(msg)
    })
    if (!picked) return null
    const state: FallbackState = { providerId: picked.id, from: limitedProviderId, until: resetsAt }
    this.states.set(agentId, state)
    return state
  }

  // The agent's current state — clears itself (and returns null) once the
  // primary's resetsAt has passed: new turns go back to the primary.
  effective(agentId: string, now: Date): FallbackState | null {
    const s = this.states.get(agentId)
    if (!s) return null
    if (Date.parse(s.until) <= now.getTime()) {
      this.states.delete(agentId)
      return null
    }
    return s
  }

  clear(agentId: string): void {
    this.states.delete(agentId)
  }
}
