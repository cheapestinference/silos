// thinking-verbs.ts — Claude Code-style verbs for the "thinking" state: a
// different gerund per turn, stable WITHIN the turn (a hash of the turnId,
// not random per render — the text must not dance while it's thinking).
// Informative phases are left alone: "Writing…" and "Running <tool>…" say
// something real.
//
// The turn's receipt: once it finishes, the turn's verb switches to PAST
// TENSE ("✻ Brewed for 1m 26s") — PAST_VERBS maps each gerund in the pool
// to its past form. An explicit map (no automatic -ed suffix): English has
// irregulars (Weaving→Wove, Thinking→Thought) and the receipt is visible
// text, it can't come out as "Thinked".
export const THINKING_VERBS = [
  'Thinking',
  'Pondering',
  'Mulling',
  'Musing',
  'Brewing',
  'Simmering',
  'Percolating',
  'Marinating',
  'Puzzling',
  'Noodling',
  'Scheming',
  'Weaving',
  'Untangling',
  'Distilling',
  'Connecting',
  'Sketching',
  'Composing',
  'Tinkering',
  'Polishing',
  'Conjuring',
] as const

export const PAST_VERBS: Record<(typeof THINKING_VERBS)[number], string> = {
  Thinking: 'Thought',
  Pondering: 'Pondered',
  Mulling: 'Mulled',
  Musing: 'Mused',
  Brewing: 'Brewed',
  Simmering: 'Simmered',
  Percolating: 'Percolated',
  Marinating: 'Marinated',
  Puzzling: 'Puzzled',
  Noodling: 'Noodled',
  Scheming: 'Schemed',
  Weaving: 'Wove',
  Untangling: 'Untangled',
  Distilling: 'Distilled',
  Connecting: 'Connected',
  Sketching: 'Sketched',
  Composing: 'Composed',
  Tinkering: 'Tinkered',
  Polishing: 'Polished',
  Conjuring: 'Conjured',
}

export function verbForTurn(turnId: string): (typeof THINKING_VERBS)[number] {
  let h = 0
  for (let i = 0; i < turnId.length; i++) h = (h * 31 + turnId.charCodeAt(i)) >>> 0
  return THINKING_VERBS[h % THINKING_VERBS.length] ?? THINKING_VERBS[0]
}

// the receipt's verb: the same hash as the live one (same turnId → same
// verb), only the tense changes — "Brewing…" during, "Brewed for 12s" after.
export function pastVerbForTurn(turnId: string): string {
  return PAST_VERBS[verbForTurn(turnId)]
}
