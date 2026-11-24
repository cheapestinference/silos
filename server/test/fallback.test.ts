import { describe, it, expect, vi, afterEach } from 'vitest'
import { classifyChainEntry, pickFallback, FallbackTracker, looksLikeRateLimit } from '../src/fallback.js'
import type { ResolvedProvider } from '../src/providers-store.js'

afterEach(() => vi.restoreAllMocks())

const PROVIDERS: Record<string, ResolvedProvider> = {
  default: { id: 'default', kind: 'claude-account', label: 'Claude (this machine)', configDir: null },
  'account:alt': { id: 'account:alt', kind: 'claude-account', label: 'Claude · alt', configDir: '/tmp/alt' },
  ci: { id: 'ci', kind: 'anthropic-compatible', label: 'cheapestinference', baseUrl: 'https://api.cheapestinference.com/anthropic', apiKey: 'sk-a-12345678' },
  byok: { id: 'byok', kind: 'anthropic-compatible', label: 'byok', baseUrl: 'https://b.test', apiKey: 'sk-b-12345678' },
}
const resolve = (id: string): ResolvedProvider | null => PROVIDERS[id] ?? null

describe('pickFallback — walking the chain', () => {
  it('picks the first usable key-based provider in order', () => {
    expect(pickFallback(['ci', 'byok'], resolve, 'default')?.id).toBe('ci')
    expect(pickFallback(['byok', 'ci'], resolve, 'default')?.id).toBe('byok')
  })

  it('skips the provider that just got limited, broken ids, and empty chains', () => {
    expect(pickFallback(['ci'], resolve, 'ci')).toBeNull()
    expect(pickFallback(['deleted', 'ci'], resolve, 'default')?.id).toBe('ci')
    expect(pickFallback([], resolve, 'default')).toBeNull()
    expect(pickFallback(undefined, resolve, 'default')).toBeNull()
  })

  it("a Claude account in the chain IS a candidate (transcripts are shared via the account dir's projects/ link)", () => {
    const warnings: string[] = []
    expect(pickFallback(['account:alt', 'ci'], resolve, 'default', (m) => warnings.push(m))?.id).toBe('account:alt')
    expect(warnings).toEqual([])
    // and the machine account is a candidate for an agent whose primary is another account
    expect(pickFallback(['default'], resolve, 'account:alt')?.id).toBe('default')
  })
})

// Per-entry classification extracted from pickFallback — this is what the
// Map consumes to draw EXACTLY the edges the runtime would consider.
describe('classifyChainEntry — one chain entry, the runtime semantics', () => {
  it('usable / unknown — a Claude account is as usable as a key', () => {
    expect(classifyChainEntry('ci', resolve)).toEqual({ status: 'usable', provider: PROVIDERS.ci })
    expect(classifyChainEntry('deleted', resolve)).toEqual({ status: 'unknown' })
    expect(classifyChainEntry('account:alt', resolve)).toEqual({ status: 'usable', provider: PROVIDERS['account:alt'] })
    expect(classifyChainEntry('default', resolve)).toEqual({ status: 'usable', provider: PROVIDERS.default })
  })
})

describe('FallbackTracker — turn boundary and falling back to the primary', () => {
  it('note sets the state with until=resetsAt and effective returns it until then', () => {
    const t = new FallbackTracker()
    const state = t.note('finance', ['ci'], resolve, 'default', '2026-08-20T15:00:00.000Z')
    // `from` names the provider that hit the limit: a conversation pinned
    // to ANOTHER account is not diverted by this fallback.
    expect(state).toEqual({ providerId: 'ci', from: 'default', until: '2026-08-20T15:00:00.000Z' })
    expect(t.effective('finance', new Date('2026-08-20T14:00:00.000Z'))).toEqual(state)
  })

  it('past resetsAt, effective clears and returns null — new turns go back to the primary', () => {
    const t = new FallbackTracker()
    t.note('finance', ['ci'], resolve, 'default', '2026-08-20T15:00:00.000Z')
    expect(t.effective('finance', new Date('2026-08-20T15:00:00.000Z'))).toBeNull()
    expect(t.effective('finance', new Date('2026-08-20T14:00:00.000Z'))).toBeNull() // already cleared, doesn't "revive"
  })

  it('if the limited one IS the active fallback, it clears without chaining another jump (no loops)', () => {
    const t = new FallbackTracker()
    t.note('finance', ['ci', 'byok'], resolve, 'default', '2026-08-20T15:00:00.000Z')
    const second = t.note('finance', ['ci', 'byok'], resolve, 'ci', '2026-08-20T16:00:00.000Z')
    expect(second).toBeNull()
    expect(t.effective('finance', new Date('2026-08-20T14:00:00.000Z'))).toBeNull()
  })

  it('with no usable candidate there is no state (a chain with only the limited one, or broken ids)', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const t = new FallbackTracker()
    expect(t.note('finance', ['default', 'deleted'], resolve, 'default', '2026-08-20T15:00:00.000Z')).toBeNull()
    expect(t.effective('finance', new Date('2026-08-20T14:00:00.000Z'))).toBeNull()
  })

  it('state is per agent', () => {
    const t = new FallbackTracker()
    t.note('finance', ['ci'], resolve, 'default', '2026-08-20T15:00:00.000Z')
    expect(t.effective('other', new Date('2026-08-20T14:00:00.000Z'))).toBeNull()
  })
})

// Every wording a limit has really arrived with (runs.jsonl, SDK, proxies)
// — and the errors that must NOT be read as one (they'd retry forever).
describe('looksLikeRateLimit — every known wording', () => {
  it.each([
    "Claude Code returned an error result: You've reached your Fable limit. Switch to another model, or manage usage credits at claude.ai/settings/usage?from=cc_cli_limit_message, to continue.",
    "Claude Code returned an error result: You've reached your Fable 5 limit. Switch to another model, or manage usage credits at claude.ai/settings/usage, to continue.",
    "You've reached your Opus limit",
    "Claude Code returned an error result: You've hit your session limit · resets 5:50am (Europe/Berlin)",
    "You've hit your limit · resets 11pm",
    'Claude AI usage limit reached|1787410592',
    '5-hour limit reached ∙ resets 3pm',
    'Opus weekly limit reached',
    '429: rate limit exceeded, resets at 5pm',
    '429: rate limit reached for this pool',
    'API Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"Number of request tokens has exceeded your per-minute rate limit"}}',
    'Rate Limited',
  ])('limit: %s', (text) => {
    expect(looksLikeRateLimit(text)).toBe(true)
  })

  it.each([
    'spawn claude ENOENT',
    'API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"messages: text content blocks must be non-empty"}}',
    'API Error: 529 Overloaded',
    'Invalid API key · Please run /login',
    'error_during_execution',
    "You've reached the end of the conversation", // "reached your … limit" needs both words
  ])('not a limit: %s', (text) => {
    expect(looksLikeRateLimit(text)).toBe(false)
  })
})
