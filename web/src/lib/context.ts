// context.ts — the context-% gauge (v1.1).
// windowFor exists so the table can grow with per-model exceptions (e.g. a
// future "[1m]" extended-context suffix) without touching the call sites —
// in v1.1 it's flat: every model falls back to the 200k default.
const DEFAULT_WINDOW = 200_000

// a real session carried 449k of context against a supposed 200k window.
// Table by model family — the Claude 5 models (fable/opus/sonnet 5) have
// 1M; the "[1m]" extended-context suffix does too. Anything that doesn't
// match falls back to the 200k default.
export function windowFor(model?: string): number {
  if (!model) return DEFAULT_WINDOW
  const m = model.toLowerCase()
  if (m.includes('[1m]') || m.includes('-1m')) return 1_000_000
  if (/claude-(fable|opus|sonnet)-5/.test(m)) return 1_000_000
  return DEFAULT_WINDOW
}

// rounded, clamped to [0,100] — defensive against tokens exceeding the
// window (late compaction) or, in theory, negative values.
export function contextPct(tokens: number, model?: string): number {
  const window = windowFor(model)
  const pct = Math.round((tokens / window) * 100)
  return Math.min(100, Math.max(0, pct))
}

// semantic color for the % (not the accent color — terracotta is reserved
// for send/live pulses/skill chips, see the visual-language notes): amber
// from 80%, red from 95%. Shades that hold up in both light and dark (dark
// mode is already resolved via the .dark class on <html>, see main.tsx).
export function contextColorClass(pct: number): string {
  if (pct >= 95) return 'text-red-600 dark:text-red-400'
  if (pct >= 80) return 'text-amber-600 dark:text-amber-400'
  return ''
}

// The window a conversation's «% context» is measured against — null when
// it is not known: an engine that reports no context-window size (its
// descriptor's ui.contextPercent false — OpenCode) or no model observed yet
// (the 200k default is the gauge's fallback, not a fact about this one).
export function knownWindow(model: string | undefined | null, engineReportsWindow: boolean): number | null {
  if (!engineReportsWindow || !model) return null
  return windowFor(model)
}

// A conversation that outgrew its work: its context is at or past
// half of its model's window. Unknown window or size → false (no mark).
export function pastHalfWindow(tokens: number | undefined | null, window: number | null): boolean {
  if (window === null || window <= 0 || typeof tokens !== 'number' || !Number.isFinite(tokens)) return false
  return tokens >= window / 2
}

// What a relaunch costs, said before it is confirmed: restarting a
// console and changing what a started conversation runs on (account, model,
// output style) make the engine read the whole conversation again. ONE
// sentence for both places; unknown size → null (no vague warning).
export function rereadSentence(tokens: number | undefined | null): string | null {
  if (typeof tokens !== 'number' || !Number.isFinite(tokens) || tokens <= 0) return null
  return `The next message re-reads the whole conversation, about ${Math.round(tokens).toLocaleString('en-US')} tokens.`
}
