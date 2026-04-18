// src/lib/phase-filter.ts
//
// Extract text from a gateway assistant message, preferring the given phase.
// Mirrors control-UI's extractAssistantTextForPhase with legacy-safe fallback:
// messages without phase signatures are treated as "all phases allowed".

import type { AssistantPhase } from '../types/openclaw';
import { extractTextCached } from './message-extract';

/**
 * Return the visible assistant text for a given phase.
 * Preference order:
 *   1. Text whose signature resolves to the requested phase.
 *   2. If nothing matches and the message has any unphased text, return that.
 *   3. Empty string.
 *
 * Typical use: loadChatHistory passes phase='final_answer' to hide commentary.
 */
export function extractAssistantTextForPhase(
  message: unknown,
  phase: AssistantPhase
): string {
  const phased = extractTextCached(message, phase);
  if (phased.trim().length > 0) return phased;
  // Fallback: messages without signatures — return everything.
  const all = extractTextCached(message);
  return all;
}
