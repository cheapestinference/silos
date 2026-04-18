// src/lib/message-extract.ts
//
// Pure text/thinking extraction from canonical gateway messages,
// cached by message reference via WeakMap. Safe to call on every render.

import type { AssistantPhase } from '../types/openclaw';

type TextCacheEntry = { phase: AssistantPhase | 'all'; text: string };
const textCache = new WeakMap<object, TextCacheEntry[]>();
const thinkingCache = new WeakMap<object, string>();

/**
 * Return the plain-text content of a canonical gateway message.
 * Accepts:
 *   - string content → returned as-is
 *   - array content with { type: 'text', text, textSignature? } blocks → joined
 * If `phase` is specified, only text blocks whose textSignature resolves to
 * the requested phase are kept. If no signatures are present, all text is returned.
 *
 * Results are memoized per (message, phase) tuple, WeakMap-keyed on the message.
 */
export function extractTextCached(
  message: unknown,
  phase?: AssistantPhase
): string {
  if (!message || typeof message !== 'object') return '';
  const key = message as object;
  const wanted = phase ?? 'all';

  const existing = textCache.get(key);
  if (existing) {
    const hit = existing.find(e => e.phase === wanted);
    if (hit) return hit.text;
  }

  const text = computeText(message, phase);
  const next = existing ? [...existing, { phase: wanted, text }] : [{ phase: wanted, text }];
  textCache.set(key, next);
  return text;
}

/**
 * Return the `thinking` text from a canonical gateway message, if any.
 * Accepts `{ type: 'thinking', thinking }` blocks in array content; falls back
 * to legacy `<think>...</think>` in a string content.
 */
export function extractThinkingCached(message: unknown): string {
  if (!message || typeof message !== 'object') return '';
  const key = message as object;
  const cached = thinkingCache.get(key);
  if (cached !== undefined) return cached;

  const text = computeThinking(message);
  thinkingCache.set(key, text);
  return text;
}

// --- internals ---

function computeText(message: unknown, phase?: AssistantPhase): string {
  const content = (message as { content?: unknown }).content;
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) return '';

  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const type = (block as { type?: unknown }).type;
    if (type !== 'text' && type !== 'output_text' && type !== 'input_text') continue;
    const text = (block as { text?: unknown }).text;
    if (typeof text !== 'string') continue;

    if (phase) {
      const blockPhase = resolvePhase(block);
      // Unphased blocks are kept for backwards compat; only filter phased mismatches.
      if (blockPhase && blockPhase !== phase) continue;
    }
    parts.push(text);
  }
  return parts.join('');
}

function computeThinking(message: unknown): string {
  const content = (message as { content?: unknown }).content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      const type = (block as { type?: unknown }).type;
      if (type === 'thinking') {
        const thinking = (block as { thinking?: unknown }).thinking;
        if (typeof thinking === 'string') parts.push(thinking);
      }
    }
    return parts.join('\n');
  }
  if (typeof content === 'string') {
    // Legacy <think>...</think> fallback.
    const match = content.match(/<think>([\s\S]*?)<\/think>/);
    return match ? match[1].trim() : '';
  }
  return '';
}

function resolvePhase(block: unknown): AssistantPhase | undefined {
  if (!block || typeof block !== 'object') return undefined;
  const sig = (block as { textSignature?: unknown }).textSignature;
  if (typeof sig !== 'string') {
    const phase = (block as { phase?: unknown }).phase;
    return phase === 'commentary' || phase === 'final_answer' ? phase : undefined;
  }
  try {
    const parsed = JSON.parse(sig);
    if (parsed && typeof parsed === 'object') {
      const p = (parsed as { phase?: unknown }).phase;
      if (p === 'commentary' || p === 'final_answer') return p;
    }
  } catch {
    /* invalid JSON — ignore */
  }
  return undefined;
}
