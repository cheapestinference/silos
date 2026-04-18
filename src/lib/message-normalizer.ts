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
 * Promote any in-message tool_call blocks into the tool-message shape that
 * Silos keeps as siblings in `chatMessages`. Returns the list of derived
 * ChatMessage rows (one per tool_call), plus the parent message id for
 * linkage. Used by loadChatHistory to keep the current tool-panel behavior
 * while also surfacing tool cards inline via MessageContent.
 */
export function extractToolMessagesFromBlocks(
  parentId: string | undefined,
  index: number,
  timestamp: number,
  runId: string | undefined,
  blocks: ContentBlock[],
): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const b of blocks) {
    if (b.type !== 'tool_call') continue;
    if (!b.name) continue;
    out.push({
      id: b.toolCallId || `tool-${parentId || index}-${b.name}`,
      role: 'tool',
      content: '',
      timestamp,
      toolName: b.name,
      toolCallId: b.toolCallId,
      toolCall: b.args,
      runId,
      status: 'delivered',
    });
  }
  return out;
}
