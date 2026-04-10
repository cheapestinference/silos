// Mirrors OpenClaw's src/shared/text/reasoning-tags.ts logic.
// Strips <think>, <thinking>, <thought>, <antthinking> blocks from assistant messages.
// mode "strict"   — used for completed messages: orphaned close tags are stripped too.
// mode "preserve" — used while streaming: if a block is still open, keep text after it
//                   so the in-progress response stays visible.
//
// Also handles orphaned closing fragments like "/think>" (without "<") that arrive
// when an upstream layer partially strips the opening tag but leaves the closer.

const REASONING_QUICK_RE = /<\s*\/?\s*(?:think(?:ing)?|thought|antthinking)\b/i;
const REASONING_TAG_RE = /<\s*(\/?)\s*(?:think(?:ing)?|thought|antthinking)\b[^<>]*>/gi;

// Catches orphaned fragments where the '<' was consumed upstream:
//   /think>   /thinking>   /thought>   /antthinking>
// Only at start-of-string or after newline to avoid false positives in prose.
const ORPHAN_CLOSE_RE = /(?:^|\n)\s*\/(?:think(?:ing)?|thought|antthinking)\s*>[ \t]*/gi;

export function stripReasoningTags(text: string, mode: 'strict' | 'preserve' = 'strict'): string {
  if (!text) return text;

  // Phase 1: strip orphaned closing fragments (no '<')
  let cleaned = text;
  if (ORPHAN_CLOSE_RE.test(cleaned)) {
    ORPHAN_CLOSE_RE.lastIndex = 0;
    cleaned = cleaned.replace(ORPHAN_CLOSE_RE, '\n');
  }

  // Phase 2: strip proper XML-style tags
  if (!REASONING_QUICK_RE.test(cleaned)) return cleaned.trimStart();

  REASONING_TAG_RE.lastIndex = 0;
  let result = '';
  let lastIndex = 0;
  let inThinking = false;

  for (const match of cleaned.matchAll(REASONING_TAG_RE)) {
    const idx = match.index ?? 0;
    const isClose = match[1] === '/';

    if (!inThinking) {
      result += cleaned.slice(lastIndex, idx); // keep text before the tag
      if (!isClose) inThinking = true;         // opening tag: enter thinking block
      // closing tag with no open: just skip the tag (orphan strip)
    } else if (isClose) {
      inThinking = false;                      // closing tag: exit thinking block (discard content)
    }
    lastIndex = idx + match[0].length;
  }

  // Append remaining text: always if not in a block, or in preserve mode (streaming)
  if (!inThinking || mode === 'preserve') {
    result += cleaned.slice(lastIndex);
  }

  return result.trimStart();
}

// --- NO_REPLY filtering: defense-in-depth against gateway control tokens ---
// Agents return "NO_REPLY" during memory compaction and other internal operations.
// The gateway strips it server-side, but streaming deltas arrive before normalization.
const _SILENT_REPLY_RE = /^\s*NO_REPLY\s*$/;
export function isSilentReply(text: string | null | undefined): boolean {
  return typeof text === 'string' && _SILENT_REPLY_RE.test(text);
}
