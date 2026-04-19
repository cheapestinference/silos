// src/lib/message-normalizer.ts
//
// Message-level normalization. Applies `stripInboundMeta` to user messages,
// converts raw content into canonical ContentBlock[], derives a legacy
// `content: string` for renderers that haven't migrated yet, and extracts
// metadata (senderLabel, phase, id).

import type { AssistantPhase, ChatMessage, ContentBlock } from '../types/openclaw';
import { stripInboundMeta } from '../store/store-utils';
import { normalizeContentToBlocks, extractTextFromBlocks } from './content-blocks';

export interface NormalizedRawMessage {
  id?: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  contentBlocks: ContentBlock[];
  timestamp: number;
  senderLabel?: string | null;
  phase?: AssistantPhase;
}

/**
 * Normalize a raw gateway message (from `chat.history` or `agent.history`)
 * into the shape the Silos store expects. Does NOT decide whether the
 * message should be kept — filtering (e.g. toolResult dropping, silent
 * reply suppression) stays in `loadChatHistory`.
 */
export function normalizeMessage(raw: unknown): NormalizedRawMessage | null {
  if (!raw || typeof raw !== 'object') return null;
  const m = raw as Record<string, unknown>;
  const role = typeof m.role === 'string' ? (m.role as NormalizedRawMessage['role']) : 'user';
  const timestamp = typeof m.timestamp === 'number' ? m.timestamp : Date.now();
  const id = typeof m.id === 'string' ? m.id : undefined;

  let blocks = normalizeContentToBlocks(m.content);

  // User messages: apply stripInboundMeta to every text block (matches
  // canonical `stripInboundMetadata(stripEnvelope(text))` behaviour from
  // control-UI's message-normalizer).
  if (role === 'user') {
    blocks = blocks.map((b) => {
      if (b.type === 'text') {
        const stripped = stripInboundMeta(b.text);
        return { ...b, text: stripped };
      }
      return b;
    }).filter((b) => {
      // Drop emptied text blocks.
      return !(b.type === 'text' && (!b.text || !b.text.trim()));
    });
  }

  const senderLabelRaw = m.senderLabel;
  const senderLabel =
    typeof senderLabelRaw === 'string' && senderLabelRaw.trim().length > 0
      ? senderLabelRaw.trim()
      : null;

  // Derive message-level phase if all text blocks agree.
  const phase = derivePhase(blocks);

  // Legacy string view: prefer final_answer for assistant history; keep
  // everything for user/system/tool roles.
  const legacyContent =
    role === 'assistant'
      ? preferFinalAnswerText(blocks)
      : extractTextFromBlocks(blocks);

  return {
    id,
    role,
    content: legacyContent,
    contentBlocks: blocks,
    timestamp,
    senderLabel,
    phase,
  };
}

/**
 * Given a block set, return the phase if EVERY phased text block agrees.
 * Unphased blocks are ignored for the vote. Returns undefined when mixed
 * or absent.
 */
function derivePhase(blocks: ContentBlock[]): AssistantPhase | undefined {
  let seen: AssistantPhase | undefined;
  for (const b of blocks) {
    if (b.type !== 'text' || !b.phase) continue;
    if (seen && seen !== b.phase) return undefined;
    seen = b.phase;
  }
  return seen;
}

/**
 * Prefer text from `final_answer` blocks; fall back to all text if no
 * final_answer blocks exist. Same contract as Phase 1's
 * `extractAssistantTextForPhase`.
 */
function preferFinalAnswerText(blocks: ContentBlock[]): string {
  const finalOnly = extractTextFromBlocks(blocks, 'final_answer');
  if (finalOnly.trim().length > 0) return finalOnly;
  return extractTextFromBlocks(blocks);
}

/**
 * Result of a `tool_result` block or message, keyed by its matching `toolCallId`.
 * Built from a scan across all raw history messages before tool_call extraction —
 * see `buildToolResultMap`.
 */
export interface ToolResultLookup {
  text: string;
  isError?: boolean;
}

/**
 * Scan raw history messages for tool_result data, indexed by `toolCallId`.
 * Gateways use two shapes, both of which we must catch:
 *
 *   1. Separate top-level messages with `role: 'toolResult'` (OpenAI-style,
 *      OpenClaw's native shape). `toolCallId` sits on the message itself,
 *      and `content` is a blocks array with the result text.
 *
 *   2. Content blocks with `type: 'tool_result'` (Anthropic-style, or
 *      canonical ContentBlock form) living inside the NEXT user message.
 *      `toolCallId` sits on the block.
 *
 * The map is passed to `extractToolMessagesFromBlocks` (to populate `result`
 * on extracted tool messages rendered in the Tools panel) and to
 * `injectToolResultBlocks` (to add synthetic tool_result blocks next to each
 * tool_call block in the assistant's contentBlocks, so inline `MessageContent`
 * renders the card in its completed state instead of forever-running).
 */
export function buildToolResultMap(rawMessages: unknown[]): Map<string, ToolResultLookup> {
  const out = new Map<string, ToolResultLookup>();
  for (const raw of rawMessages) {
    if (!raw || typeof raw !== 'object') continue;
    const m = raw as Record<string, unknown>;

    // Shape (1): role === 'toolResult' at the message level.
    if (m.role === 'toolResult' && typeof m.toolCallId === 'string') {
      const text = extractTextFromRawContent(m.content);
      out.set(m.toolCallId, { text, isError: !!m.isError });
      continue;
    }

    // Shape (2): tool_result blocks inside this message's content array.
    if (Array.isArray(m.content)) {
      for (const b of m.content) {
        if (!b || typeof b !== 'object') continue;
        const block = b as Record<string, unknown>;
        const t = block.type;
        if (t !== 'tool_result' && t !== 'toolResult') continue;
        const id =
          typeof block.toolCallId === 'string'
            ? block.toolCallId
            : typeof block.tool_use_id === 'string'
              ? block.tool_use_id
              : typeof block.tool_call_id === 'string'
                ? block.tool_call_id
                : undefined;
        if (!id) continue;
        const text = extractTextFromRawContent(block.content ?? block.text);
        out.set(id, { text, isError: !!block.isError });
      }
    }
  }
  return out;
}

/**
 * Flatten a raw content (string | block array) to a plain string for the
 * purposes of tool_result text. Accepts both `{type:'text', text:...}` blocks
 * and bare strings; stringifies anything else for visibility.
 */
function extractTextFromRawContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) {
    return content == null ? '' : JSON.stringify(content);
  }
  const parts: string[] = [];
  for (const b of content) {
    if (typeof b === 'string') { parts.push(b); continue; }
    if (!b || typeof b !== 'object') continue;
    const obj = b as Record<string, unknown>;
    const t = obj.type;
    if ((t === 'text' || t === 'output_text' || t === 'input_text') && typeof obj.text === 'string') {
      parts.push(obj.text);
    } else if (typeof obj.text === 'string') {
      parts.push(obj.text);
    } else {
      parts.push(JSON.stringify(obj));
    }
  }
  return parts.join('\n');
}

/**
 * Insert a synthetic `tool_result` block immediately after each `tool_call`
 * block whose toolCallId has a matching entry in `resultByCallId`. Returns
 * a new blocks array — the original is not mutated.
 *
 * This lets `extractToolCardsFromBlocks` (and therefore `MessageContent`) see
 * the tool_call paired with its result even when the gateway persists the
 * result in a separate top-level `role: 'toolResult'` message.
 */
export function injectToolResultBlocks(
  blocks: ContentBlock[],
  resultByCallId: Map<string, ToolResultLookup>,
): ContentBlock[] {
  if (resultByCallId.size === 0) return blocks;
  const out: ContentBlock[] = [];
  for (const b of blocks) {
    out.push(b);
    if (b.type === 'tool_call' && b.toolCallId) {
      const r = resultByCallId.get(b.toolCallId);
      if (r) {
        out.push({
          type: 'tool_result',
          text: r.text,
          toolCallId: b.toolCallId,
          ...(r.isError ? { isError: true } : {}),
        });
      }
    }
  }
  return out;
}

/**
 * Promote any in-message tool_call blocks into the tool-message shape that
 * Silos keeps as siblings in `chatMessages`. Returns the list of derived
 * ChatMessage rows (one per tool_call), plus the parent message id for
 * linkage. Used by loadChatHistory to keep the current tool-panel behavior
 * while also surfacing tool cards inline via MessageContent.
 *
 * Pairs each tool_call with its matching tool_result (via `resultByCallId`).
 * When no result exists (e.g. the run aborted mid-tool and the gateway only
 * persisted the call), mark the tool message with a visible abort notice —
 * otherwise `ToolCallExpander` would render it as "running" forever.
 */
export function extractToolMessagesFromBlocks(
  parentId: string | undefined,
  index: number,
  timestamp: number,
  runId: string | undefined,
  blocks: ContentBlock[],
  resultByCallId?: Map<string, ToolResultLookup>,
): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const b of blocks) {
    if (b.type !== 'tool_call') continue;
    if (!b.name) continue;
    const paired = b.toolCallId ? resultByCallId?.get(b.toolCallId) : undefined;
    const orphan = !paired;
    out.push({
      id: b.toolCallId || `tool-${parentId || index}-${b.name}`,
      role: 'tool',
      content: orphan ? '(tool call aborted — no result persisted)' : paired.text,
      timestamp,
      toolName: b.name,
      toolCallId: b.toolCallId,
      toolCall: b.args,
      ...(paired ? { result: paired.text } : {}),
      runId,
      status: 'delivered',
    });
  }
  return out;
}
