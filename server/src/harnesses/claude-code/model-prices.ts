// API list prices per MTok, used to compute a conversation's notional cost
// from each assistant record's real message.usage (the Claude Code Silos
// runs writes no cumulative cost-state during live sessions — the raw
// per-message usage is the one source). Every row was
// validated against the CLI's OWN historical cost-state records in
// ~/.claude/projects: opus-5-5, sonnet-5, haiku-4-5 and opus-5[1m]
// reproduce the CLI's figure to the exact cent; fable-5 matches once 1h
// cache writes are priced at 2× input. The USD is notional (API list
// prices) regardless of how the account actually pays — labeling is the
// client's job.
//
// Rows added without a CLI cost-state to check against (fable-5-2, the
// mythos ids, sonnet-5-5's cache read) are copied from Anthropic's published
// pricing table (platform.claude.com/docs/en/about-claude/pricing):
// every one of the five figures stated there, never derived.
//
// Cache writes bill by TTL: 1.25× input for 5-minute entries, 2× for
// 1-hour. usage.cache_creation carries the split; without it the total is
// priced at 5m — the lower bound, never an inflated guess.

interface ModelPrice {
  input: number
  output: number
  cacheRead: number
  cacheWrite5m: number
  cacheWrite1h: number
  // Some models bill a second rate card when the PROMPT (input + cache
  // reads + cache writes) exceeds `over` tokens; the whole request is then
  // priced at `card`.
  longPrompt?: { over: number; card: Omit<ModelPrice, 'longPrompt'> }
}

const PRICES: Record<string, ModelPrice> = {
  'claude-fable-5': { input: 10, output: 50, cacheRead: 1.0, cacheWrite5m: 12.5, cacheWrite1h: 20 },
  'claude-fable-5-1': { input: 10, output: 50, cacheRead: 0.25, cacheWrite5m: 12.5, cacheWrite1h: 20 },
  'claude-fable-5-2': { input: 8, output: 40, cacheRead: 0.2, cacheWrite5m: 10, cacheWrite1h: 16 },
  // Mythos = the same model as its Fable, same published rates
  'claude-mythos-5': { input: 10, output: 50, cacheRead: 1.0, cacheWrite5m: 12.5, cacheWrite1h: 20 },
  'claude-mythos-5-1': { input: 10, output: 50, cacheRead: 0.25, cacheWrite5m: 12.5, cacheWrite1h: 20 },
  'claude-mythos-5-2': { input: 8, output: 40, cacheRead: 0.2, cacheWrite5m: 10, cacheWrite1h: 16 },
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, cacheWrite5m: 5, cacheWrite1h: 8 },
  'claude-opus-5': { input: 5, output: 25, cacheRead: 0.5, cacheWrite5m: 6.25, cacheWrite1h: 10 },
  'claude-opus-4-8': { input: 5, output: 25, cacheRead: 0.5, cacheWrite5m: 6.25, cacheWrite1h: 10 },
  'claude-opus-4-7': { input: 5, output: 25, cacheRead: 0.5, cacheWrite5m: 6.25, cacheWrite1h: 10 },
  'claude-opus-4-6': { input: 5, output: 25, cacheRead: 0.5, cacheWrite5m: 6.25, cacheWrite1h: 10 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.1, cacheWrite5m: 2.5, cacheWrite1h: 4 },
  'claude-sonnet-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite5m: 2.5, cacheWrite1h: 4 },
  'claude-sonnet-4-6': { input: 3, output: 15, cacheRead: 0.3, cacheWrite5m: 3.75, cacheWrite1h: 6 },
  // haiku-5-5 has two rate cards split at a 100K-token prompt («100K or
  // fewer» = base): 0.1/0.5 below, 0.5/2.5 above, cache at the usual
  // multiples of input (0.1× read, 1.25× 5m, 2× 1h).
  'claude-haiku-5-5': {
    input: 0.1,
    output: 0.5,
    cacheRead: 0.01,
    cacheWrite5m: 0.125,
    cacheWrite1h: 0.2,
    longPrompt: { over: 100_000, card: { input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite5m: 0.625, cacheWrite1h: 1.0 } },
  },
  'claude-haiku-4-5': { input: 1, output: 5, cacheRead: 0.1, cacheWrite5m: 1.25, cacheWrite1h: 2 },
}

// "claude-haiku-4-5-20251001" → "claude-haiku-4-5"; "claude-opus-5[1m]"
// (the CLI's long-context alias) → "claude-opus-5". Corpus cross-check:
// [1m] usage was billed at the base model's prices.
function canonicalModel(model: string): string {
  return model.replace(/\[1m\]$/, '').replace(/-\d{8}$/, '')
}

export interface UsageTokens {
  input: number
  output: number
  cacheRead: number
  cacheWrite5m: number
  cacheWrite1h: number
}

/** The models of `models` with no price row, each once, in order — what a
 *  cost that could not be priced names (never «unpriced»: which model). */
export function modelsWithoutPrice(models: Iterable<string>): string[] {
  const out: string[] = []
  for (const m of models) if (!PRICES[canonicalModel(m)] && !out.includes(m)) out.push(m)
  return out
}

// USD for one message's usage, or null when the model has no price row
// (the caller flags it as unpriced rather than inventing a number).
export function priceUsage(model: string, u: UsageTokens): number | null {
  const row = PRICES[canonicalModel(model)]
  if (!row) return null
  const promptTokens = u.input + u.cacheRead + u.cacheWrite5m + u.cacheWrite1h
  const p = row.longPrompt && promptTokens > row.longPrompt.over ? row.longPrompt.card : row
  return (u.input * p.input + u.output * p.output + u.cacheRead * p.cacheRead + u.cacheWrite5m * p.cacheWrite5m + u.cacheWrite1h * p.cacheWrite1h) / 1_000_000
}
