// src/lib/content-blocks.ts
//
// Pure transforms between raw gateway message content and canonical
// `ContentBlock[]`. Stateless. Safe on `unknown` — no throws.
//
// Supports BOTH OpenClaw's native block types (`toolCall`, `toolResult`) and
// the Anthropic-style aliases (`tool_use`, `tool_result`), because the
// gateway's `/api/agent.history` serves both depending on the run's provider.

import type { AssistantPhase, ContentBlock, ImageSource } from '../types/openclaw';

/**
 * Convert a raw gateway message's `content` (string OR array of blocks) into
 * a normalized `ContentBlock[]`. Returns `[]` for unusable input.
 *
 * Normalization rules:
 *   - string content → `[{type:'text', text: content}]`
 *   - array content → one ContentBlock per recognizable entry; unknown
 *     entries are silently dropped.
 *   - `toolCall` / `tool_use`           → `{type:'tool_call', ...}`
 *   - `toolResult` / `tool_result`      → `{type:'tool_result', ...}`
 *   - `thinking`                        → `{type:'thinking', ...}`
 *   - `text` / `output_text` / `input_text` → `{type:'text', ...}` preserving phase
 *   - `image` (inline base64 OR url)    → `{type:'image', source:...}`
 */
export function normalizeContentToBlocks(raw: unknown): ContentBlock[] {
  if (raw == null) return [];
  if (typeof raw === 'string') {
    return raw.length > 0 ? [{ type: 'text', text: raw }] : [];
  }
  if (!Array.isArray(raw)) return [];

  const out: ContentBlock[] = [];
  for (const item of raw) {
    if (item == null) continue;
    if (typeof item === 'string') {
      if (item.length > 0) out.push({ type: 'text', text: item });
      continue;
    }
    if (typeof item !== 'object') continue;
    const block = item as Record<string, unknown>;
    const t = typeof block.type === 'string' ? block.type : '';

    if (t === 'text' || t === 'output_text' || t === 'input_text') {
      const text = typeof block.text === 'string' ? block.text : '';
      if (text.length === 0) continue;
      const phase = resolvePhaseFromBlock(block);
      out.push(phase ? { type: 'text', text, phase } : { type: 'text', text });
      continue;
    }

    if (t === 'thinking') {
      const thinking = typeof block.thinking === 'string' ? block.thinking : '';
      if (thinking.length === 0) continue;
      const phase = resolvePhaseFromBlock(block);
      out.push(phase ? { type: 'thinking', thinking, phase } : { type: 'thinking', thinking });
      continue;
    }

    if (t === 'tool_use' || t === 'toolCall') {
      const name = typeof block.name === 'string' ? block.name : '';
      if (!name) continue;
      const args = (block.input ?? block.arguments) as unknown;
      const toolCallId =
        typeof block.id === 'string'
          ? block.id
          : typeof block.tool_call_id === 'string'
            ? block.tool_call_id
            : undefined;
      out.push(
        toolCallId
          ? { type: 'tool_call', name, args, toolCallId }
          : { type: 'tool_call', name, args },
      );
      continue;
    }

    if (t === 'tool_result' || t === 'toolResult') {
      const text = extractToolResultText(block);
      const toolCallId =
        typeof block.tool_call_id === 'string'
          ? block.tool_call_id
          : typeof block.toolCallId === 'string'
            ? block.toolCallId
            : undefined;
      const isError = block.isError === true || block.is_error === true;
      out.push({
        type: 'tool_result',
        text,
        ...(toolCallId ? { toolCallId } : {}),
        ...(isError ? { isError } : {}),
      });
      continue;
    }

    if (t === 'image') {
      const source = resolveImageSource(block);
      if (source) out.push({ type: 'image', source });
      continue;
    }
    if (t === 'image_url') {
      const imageUrl = block.image_url as Record<string, unknown> | undefined;
      const url = typeof imageUrl?.url === 'string' ? imageUrl.url : undefined;
      if (url) out.push({ type: 'image', source: { type: 'url', url } });
      continue;
    }
  }
  return out;
}

/**
 * Extract the plain-text view from a content-blocks array. When `phase` is
 * provided, text blocks whose `phase` doesn't match are skipped; unphased
 * blocks stay (matches our Phase 1 behavior and the control-UI precedent).
 */
export function extractTextFromBlocks(
  blocks: ContentBlock[],
  phase?: AssistantPhase,
): string {
  const parts: string[] = [];
  for (const b of blocks) {
    if (b.type !== 'text') continue;
    if (phase && b.phase && b.phase !== phase) continue;
    parts.push(b.text);
  }
  return parts.join('\n');
}

/**
 * Extract concatenated thinking from a content-blocks array. Multiple
 * thinking blocks are joined with a blank line.
 */
export function extractThinkingFromBlocks(blocks: ContentBlock[]): string {
  const parts: string[] = [];
  for (const b of blocks) {
    if (b.type !== 'thinking') continue;
    const trimmed = b.thinking.trim();
    if (trimmed) parts.push(trimmed);
  }
  return parts.join('\n\n');
}

/**
 * Extract tool cards (calls + their results, paired by toolCallId when
 * possible) from a content-blocks array.
 */
export interface ToolCardView {
  name: string;
  args?: unknown;
  toolCallId?: string;
  resultText?: string;
  isError?: boolean;
}
export function extractToolCardsFromBlocks(blocks: ContentBlock[]): ToolCardView[] {
  const calls: ToolCardView[] = [];
  const results = new Map<string, { text: string; isError?: boolean }>();
  for (const b of blocks) {
    if (b.type === 'tool_call') {
      calls.push({
        name: b.name,
        args: b.args,
        toolCallId: b.toolCallId,
      });
    } else if (b.type === 'tool_result' && b.toolCallId) {
      results.set(b.toolCallId, { text: b.text, isError: b.isError });
    }
  }
  return calls.map((c) => {
    const r = c.toolCallId ? results.get(c.toolCallId) : undefined;
    return r ? { ...c, resultText: r.text, isError: r.isError } : c;
  });
}

/**
 * Extract all image blocks' sources (usable for `<img src>`).
 * Base64 sources are converted to data URLs; URL sources returned as-is.
 */
export function extractImagesFromBlocks(blocks: ContentBlock[]): string[] {
  const urls: string[] = [];
  for (const b of blocks) {
    if (b.type !== 'image') continue;
    if (b.source.type === 'url') {
      urls.push(b.source.url);
    } else {
      const data = b.source.data;
      const mediaType = b.source.mediaType || 'image/png';
      urls.push(data.startsWith('data:') ? data : `data:${mediaType};base64,${data}`);
    }
  }
  return urls;
}

// --- internals ---

function resolvePhaseFromBlock(block: Record<string, unknown>): AssistantPhase | undefined {
  const sig = block.textSignature;
  if (typeof sig !== 'string') return undefined;
  try {
    const parsed = JSON.parse(sig);
    if (parsed && typeof parsed === 'object') {
      const p = (parsed as { phase?: unknown }).phase;
      if (p === 'commentary' || p === 'final_answer') return p;
    }
  } catch { /* ignore */ }
  return undefined;
}

function extractToolResultText(block: Record<string, unknown>): string {
  const content = block.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const c of content) {
      if (!c || typeof c !== 'object') continue;
      const txt = (c as { text?: unknown }).text;
      if (typeof txt === 'string') parts.push(txt);
    }
    if (parts.length > 0) return parts.join('\n');
  }
  if (typeof block.text === 'string') return block.text;
  return '';
}

function resolveImageSource(block: Record<string, unknown>): ImageSource | null {
  const source = block.source as Record<string, unknown> | undefined;
  if (source && typeof source === 'object') {
    if (source.type === 'base64' && typeof source.data === 'string') {
      return {
        type: 'base64',
        mediaType: typeof source.media_type === 'string' ? source.media_type : 'image/png',
        data: source.data,
      };
    }
    if (source.type === 'url' && typeof source.url === 'string') {
      return { type: 'url', url: source.url };
    }
  }
  if (typeof block.url === 'string') return { type: 'url', url: block.url };
  return null;
}
