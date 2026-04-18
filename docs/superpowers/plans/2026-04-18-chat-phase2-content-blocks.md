# Chat Phase 2 — Canonical Content Blocks + Grouping + Tool Cards Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the foundational refactor from the master design — Silos chat ingests and renders canonical OpenClaw content blocks (`text`, `tool_call`, `tool_result`, `thinking`, `image`) instead of the current flattened `content: string`. Add Slack-style message grouping, tool cards (inline vs sidebar), thinking blocks, reading indicator, and IntersectionObserver-based virtualization. Bootstrap vitest so parser correctness can be tested.

**Architecture:** Additive and backwards-compatible. `ChatMessage.contentBlocks?: ContentBlock[]` is optional; legacy `content: string` keeps being populated during the whole phase. A new `<MessageContent>` renders from blocks when present; `<MessageBubble>` short-circuits to `<MessageContent>` if `contentBlocks` is present, else falls back to today's legacy render path. Grouping and sidebar are new, additive components.

**Tech Stack:** TypeScript, React 19, Zustand 5, Vite, Tailwind, plus new dev deps vitest + @testing-library/react + @testing-library/user-event + @testing-library/jest-dom + jsdom.

**Parent design:** `docs/superpowers/specs/2026-04-18-chat-control-ui-parity-design.md`.

---

## Preconditions

- Branch: `main`. User runs push-to-main without PRs; no branch ceremony.
- Phase 1 work is merged and live (`e0178e7` or later).
- `npm run build` is clean for chat code (68 pre-existing errors in `DreamsPanel/HeartbeatPanel/IdentityPanel` remain out of scope).
- Dev server running (Vite + gateway + sidecar + express) for manual QA between tasks.

## File Manifest

**Create (12 files):**
- `vitest.config.ts` — test runner config.
- `src/test-setup.ts` — `@testing-library/jest-dom` extensions.
- `src/lib/content-blocks.ts` — pure parsers: normalize raw gateway content → `ContentBlock[]`, extract text/thinking/tools/images from blocks.
- `src/lib/content-blocks.test.ts`.
- `src/lib/message-normalizer.ts` — port of control-UI's `normalizeMessage` → `{role, contentBlocks, senderLabel, phase?, ...}`.
- `src/lib/message-normalizer.test.ts`.
- `src/components/chat/MessageContent.tsx` — iterates `ContentBlock[]` and dispatches per block type.
- `src/components/chat/MessageGroup.tsx` — consecutive-same-role grouping wrapper (avatar + sender + footer shared).
- `src/components/chat/ToolCard.tsx` — tool_call + tool_result render, inline (<120 chars) or collapsed-with-expand.
- `src/components/chat/ToolCardSidebar.tsx` — right-column sidebar that shows an expanded tool card with copy/JsonTree.
- `src/components/chat/ThinkingBlock.tsx` — collapsible italic reasoning block.
- `src/components/chat/ReadingIndicator.tsx` — three-dot indicator while streaming (extracted from current TypingIndicator.tsx).
- `src/components/chat/VirtualMessageList.tsx` — IntersectionObserver-based virtualization wrapper.

**Modify (6 files):**
- `package.json` — add dev deps + `test` scripts.
- `src/types/openclaw.ts` — add `ContentBlock`, `ImageSource` union types; extend `ChatMessage` with `contentBlocks?`, `phase?`, `senderLabel?`.
- `src/store/slices/chat-slice.ts` — populate `contentBlocks` in `loadChatHistory`. Legacy `content` still filled.
- `src/store/chat-event-handlers.ts` — on streaming `final` events, populate the finalized message's `contentBlocks`. Streaming deltas still use the simple `streamingContent: string` model.
- `src/components/chat/MessageBubble.tsx` — delegate to `<MessageContent>` when `contentBlocks` present; keep legacy branch as fallback.
- `src/components/views/ChatView.tsx` — group messages into `<MessageGroup>` before render; mount `<ToolCardSidebar>` state + slot; wrap message list in `<VirtualMessageList>`.

**Deprecate (1 file, kept for fallback):**
- `src/components/chat/ToolCallExpander.tsx` — add `@deprecated` JSDoc. Still used by the legacy render branch of MessageBubble.

## Key Types (Phase 2 additions to `src/types/openclaw.ts`)

```ts
export type ContentBlock =
  | { type: 'text'; text: string; phase?: AssistantPhase }
  | { type: 'tool_call'; name: string; args?: unknown; toolCallId?: string }
  | { type: 'tool_result'; text: string; toolCallId?: string; isError?: boolean }
  | { type: 'thinking'; thinking: string; phase?: AssistantPhase }
  | { type: 'image'; source: ImageSource };

export type ImageSource =
  | { type: 'base64'; mediaType: string; data: string }
  | { type: 'url'; url: string };
```

Extend `ChatMessage`:
```ts
contentBlocks?: ContentBlock[];
phase?: AssistantPhase;
senderLabel?: string | null;
```

## Architectural decisions

**D1 — `contentBlocks` is optional.** Migration can ship one renderer at a time. Legacy `content` string stays populated until end of phase; we can drop it in Phase 2.5 if we want.

**D2 — `ChatMessage.meta?.kind === 'inter_session'` stays above contentBlocks.** `<MessageBubble>`'s inter-session short-circuit (Phase 1) runs first; content blocks only dispatch for "regular" messages.

**D3 — Streaming deltas keep `streamingContent: string`.** Only the FINAL event populates `contentBlocks`. Reason: delta events are plain text deltas, not content-block deltas; converting them mid-stream adds complexity without user-visible benefit.

**D4 — Tool cards collapse threshold: `TOOL_INLINE_THRESHOLD = 120` chars.** Matches control-UI's `tool-cards.ts:TOOL_INLINE_THRESHOLD`.

**D5 — Grouping time gap: `MAX_GROUP_GAP_MS = 5 * 60 * 1000`.** Same-role consecutive messages within 5 min get visually merged. Matches common chat UX.

**D6 — Virtualization threshold: `VIRTUALIZE_THRESHOLD = 500`.** Below that, render all messages. Above, use IntersectionObserver to only paint visible ± buffer rows.

**D7 — Tool card sidebar uses right column.** Mount point sits alongside existing `ToolsPanel`/`SessionErrorsPanel`/`SessionLatencyPanel` bottom tabs. New fourth tab "Inspect" or a floating panel — TBD per Task 12 UX review.

**D8 — Tests live beside source** (`foo.test.ts` alongside `foo.ts`). Only pure logic gets unit tests; component tests skipped (no jsdom/user-event setup beyond parsers for now).

**D9 — No breaking changes to `loadChatHistory` signature** or the gateway client. Purely additive output shape.

**D10 — Keep `stripReasoningTags` in the legacy text path.** Thinking blocks in `contentBlocks` are already canonical — no need to strip `<think>` from block text.

## Build verification pattern

Every task ends with:
```bash
npm run build 2>&1 | grep -E "error TS" | grep -v -E "DreamsPanel|HeartbeatPanel|IdentityPanel" | head
```
Output must be empty.

From Task 1 onward, also:
```bash
npm test -- --run
```
Must be green.

---

## Task 1: Bootstrap vitest + testing-library

**Files:**
- Modify: `package.json`
- Create: `vitest.config.ts`
- Create: `src/test-setup.ts`

**Rationale:** Every downstream task that writes parsers wants unit tests. Get the runner in first. Uses `jsdom` so later component tests (Phase 4+) can reuse the same setup.

- [ ] **Step 1: Install dev deps**

```bash
cd /home/ubuntu/silos && npm install -D vitest@^3 @vitest/ui@^3 @testing-library/react@^16 @testing-library/user-event@^14 @testing-library/jest-dom@^6 jsdom@^25
```

Wait for completion. Confirm `package.json` has these in `devDependencies`.

- [ ] **Step 2: Create `vitest.config.ts`**

```ts
/// <reference types="vitest" />
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test-setup.ts'],
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    exclude: ['node_modules', 'dist'],
  },
});
```

- [ ] **Step 3: Create `src/test-setup.ts`**

```ts
import '@testing-library/jest-dom/vitest';
```

- [ ] **Step 4: Add scripts to `package.json`**

Find the `"scripts"` block and add:
```json
"test": "vitest",
"test:run": "vitest run",
"test:ui": "vitest --ui"
```

- [ ] **Step 5: Add trivial smoke test at `src/lib/_vitest.test.ts`**

```ts
import { describe, it, expect } from 'vitest';

describe('vitest bootstrap', () => {
  it('runs', () => {
    expect(1 + 1).toBe(2);
  });
});
```

- [ ] **Step 6: Run the suite**

```bash
npm run test:run
```

Expected: 1 passed.

- [ ] **Step 7: Clean tsc + vite build**

```bash
npm run build 2>&1 | grep -E "error TS" | grep -v -E "DreamsPanel|HeartbeatPanel|IdentityPanel" | head
```

Expected: empty.

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json vitest.config.ts src/test-setup.ts src/lib/_vitest.test.ts
git commit -m "chore(test): bootstrap vitest + testing-library with jsdom env"
```

---

## Task 2: Add `ContentBlock` types + extend `ChatMessage`

**Files:**
- Modify: `src/types/openclaw.ts`

- [ ] **Step 1: Add the new types after the existing `AssistantPhase` declaration**

Locate line `export type AssistantPhase = 'commentary' | 'final_answer';` and append right after:

```ts
/**
 * Image source for an `image` content block. Matches OpenClaw's canonical
 * shape (content-UI uses the same union), accepting either an inline
 * base64-encoded payload or a remote URL.
 */
export type ImageSource =
  | { type: 'base64'; mediaType: string; data: string }
  | { type: 'url'; url: string };

/**
 * Canonical message content block. Mirrors OpenClaw's content-items model
 * (`src/gateway/open-responses.schema.ts` + `src/shared/chat-message-content.ts`)
 * without the OpenAI Responses-API aliases, which Silos's gateway never emits.
 * Assistant thinking + phase-signatured text remain separate blocks — they do
 * NOT collapse into `text`.
 */
export type ContentBlock =
  | { type: 'text'; text: string; phase?: AssistantPhase }
  | { type: 'tool_call'; name: string; args?: unknown; toolCallId?: string }
  | { type: 'tool_result'; text: string; toolCallId?: string; isError?: boolean }
  | { type: 'thinking'; thinking: string; phase?: AssistantPhase }
  | { type: 'image'; source: ImageSource };
```

- [ ] **Step 2: Extend `ChatMessage`**

Locate the existing `ChatMessage` interface and add three optional fields after `meta`:

```ts
  /** Canonical content blocks (Phase 2+). When present, renderers prefer
   *  this over the legacy `content: string`. */
  contentBlocks?: ContentBlock[];
  /** Assistant phase at the message level (when uniform across blocks). */
  phase?: AssistantPhase;
  /** Optional sender label for multi-party channel messages. */
  senderLabel?: string | null;
```

- [ ] **Step 3: Build**

```bash
npm run build 2>&1 | grep -E "error TS" | grep -v -E "DreamsPanel|HeartbeatPanel|IdentityPanel" | head
```

Expected: empty.

- [ ] **Step 4: Commit**

```bash
git add src/types/openclaw.ts
git commit -m "feat(types): ContentBlock + ImageSource unions, extend ChatMessage"
```

---

## Task 3: Pure parsers `src/lib/content-blocks.ts` + tests

**Files:**
- Create: `src/lib/content-blocks.ts`
- Create: `src/lib/content-blocks.test.ts`

**Rationale:** Stateless parsers that transform raw gateway content (`string | unknown[]`) into `ContentBlock[]`, and extract derived views (text, thinking, tool cards, images). These are the foundation every renderer builds on. Ship with tests so edge cases (empty, mixed, legacy `toolCall` vs `tool_use`, `textSignature` phase resolution) are locked down.

- [ ] **Step 1: Create `src/lib/content-blocks.ts` with the full implementation**

```ts
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
```

- [ ] **Step 2: Create `src/lib/content-blocks.test.ts` with comprehensive cases**

```ts
import { describe, it, expect } from 'vitest';
import {
  normalizeContentToBlocks,
  extractTextFromBlocks,
  extractThinkingFromBlocks,
  extractToolCardsFromBlocks,
  extractImagesFromBlocks,
} from './content-blocks';

describe('normalizeContentToBlocks', () => {
  it('returns [] for null/undefined', () => {
    expect(normalizeContentToBlocks(null)).toEqual([]);
    expect(normalizeContentToBlocks(undefined)).toEqual([]);
  });
  it('returns [] for empty string', () => {
    expect(normalizeContentToBlocks('')).toEqual([]);
  });
  it('wraps a plain string as a single text block', () => {
    expect(normalizeContentToBlocks('hi')).toEqual([{ type: 'text', text: 'hi' }]);
  });
  it('passes through text blocks', () => {
    const raw = [{ type: 'text', text: 'hello' }];
    expect(normalizeContentToBlocks(raw)).toEqual([{ type: 'text', text: 'hello' }]);
  });
  it('skips empty text blocks', () => {
    const raw = [{ type: 'text', text: '' }, { type: 'text', text: 'x' }];
    expect(normalizeContentToBlocks(raw)).toEqual([{ type: 'text', text: 'x' }]);
  });
  it('converts OpenClaw toolCall blocks into canonical tool_call', () => {
    const raw = [
      { type: 'toolCall', name: 'cron', arguments: { action: 'add' }, id: 'c1' },
    ];
    expect(normalizeContentToBlocks(raw)).toEqual([
      { type: 'tool_call', name: 'cron', args: { action: 'add' }, toolCallId: 'c1' },
    ]);
  });
  it('converts Anthropic tool_use blocks into canonical tool_call', () => {
    const raw = [
      { type: 'tool_use', name: 'shell', input: { cmd: 'ls' }, id: 't1' },
    ];
    expect(normalizeContentToBlocks(raw)).toEqual([
      { type: 'tool_call', name: 'shell', args: { cmd: 'ls' }, toolCallId: 't1' },
    ]);
  });
  it('preserves tool_result text from nested content', () => {
    const raw = [
      {
        type: 'toolResult',
        toolCallId: 'c1',
        content: [{ type: 'text', text: 'done' }],
      },
    ];
    expect(normalizeContentToBlocks(raw)).toEqual([
      { type: 'tool_result', text: 'done', toolCallId: 'c1' },
    ]);
  });
  it('extracts thinking blocks verbatim', () => {
    const raw = [{ type: 'thinking', thinking: 'considering...' }];
    expect(normalizeContentToBlocks(raw)).toEqual([
      { type: 'thinking', thinking: 'considering...' },
    ]);
  });
  it('resolves phase from textSignature JSON', () => {
    const raw = [
      {
        type: 'text',
        text: 'final',
        textSignature: JSON.stringify({ v: 1, phase: 'final_answer' }),
      },
    ];
    expect(normalizeContentToBlocks(raw)).toEqual([
      { type: 'text', text: 'final', phase: 'final_answer' },
    ]);
  });
  it('ignores invalid textSignature JSON silently', () => {
    const raw = [{ type: 'text', text: 'x', textSignature: 'not json' }];
    expect(normalizeContentToBlocks(raw)).toEqual([{ type: 'text', text: 'x' }]);
  });
  it('converts base64 image blocks to canonical ImageSource', () => {
    const raw = [
      {
        type: 'image',
        source: { type: 'base64', media_type: 'image/jpeg', data: 'AAA' },
      },
    ];
    expect(normalizeContentToBlocks(raw)).toEqual([
      { type: 'image', source: { type: 'base64', mediaType: 'image/jpeg', data: 'AAA' } },
    ]);
  });
  it('converts OpenAI image_url blocks', () => {
    const raw = [{ type: 'image_url', image_url: { url: 'https://x.png' } }];
    expect(normalizeContentToBlocks(raw)).toEqual([
      { type: 'image', source: { type: 'url', url: 'https://x.png' } },
    ]);
  });
  it('silently drops unknown block types', () => {
    const raw = [{ type: 'unknown' }, { type: 'text', text: 'keep' }];
    expect(normalizeContentToBlocks(raw)).toEqual([{ type: 'text', text: 'keep' }]);
  });
});

describe('extractTextFromBlocks', () => {
  it('joins text blocks with newlines', () => {
    expect(
      extractTextFromBlocks([
        { type: 'text', text: 'a' },
        { type: 'text', text: 'b' },
      ]),
    ).toBe('a\nb');
  });
  it('skips non-text blocks', () => {
    expect(
      extractTextFromBlocks([
        { type: 'text', text: 'a' },
        { type: 'thinking', thinking: 't' },
        { type: 'text', text: 'b' },
      ]),
    ).toBe('a\nb');
  });
  it('filters by phase but keeps unphased blocks', () => {
    const blocks = [
      { type: 'text', text: 'x', phase: 'commentary' as const },
      { type: 'text', text: 'y' } as const,
      { type: 'text', text: 'z', phase: 'final_answer' as const },
    ];
    expect(extractTextFromBlocks(blocks, 'final_answer')).toBe('y\nz');
  });
});

describe('extractThinkingFromBlocks', () => {
  it('joins multiple thinking blocks with blank line', () => {
    expect(
      extractThinkingFromBlocks([
        { type: 'thinking', thinking: 'A' },
        { type: 'text', text: 'mid' },
        { type: 'thinking', thinking: 'B' },
      ]),
    ).toBe('A\n\nB');
  });
  it('returns empty string when no thinking blocks', () => {
    expect(
      extractThinkingFromBlocks([{ type: 'text', text: 'x' }]),
    ).toBe('');
  });
});

describe('extractToolCardsFromBlocks', () => {
  it('pairs tool_call with tool_result by toolCallId', () => {
    const cards = extractToolCardsFromBlocks([
      { type: 'tool_call', name: 'cron', args: { a: 1 }, toolCallId: 'c1' },
      { type: 'tool_result', text: 'ok', toolCallId: 'c1' },
    ]);
    expect(cards).toEqual([
      { name: 'cron', args: { a: 1 }, toolCallId: 'c1', resultText: 'ok' },
    ]);
  });
  it('leaves orphan calls without result', () => {
    const cards = extractToolCardsFromBlocks([
      { type: 'tool_call', name: 'shell', toolCallId: 'c1' },
    ]);
    expect(cards).toEqual([{ name: 'shell', toolCallId: 'c1' }]);
  });
  it('propagates isError', () => {
    const cards = extractToolCardsFromBlocks([
      { type: 'tool_call', name: 'x', toolCallId: 'c1' },
      { type: 'tool_result', text: 'boom', toolCallId: 'c1', isError: true },
    ]);
    expect(cards).toEqual([
      { name: 'x', toolCallId: 'c1', resultText: 'boom', isError: true },
    ]);
  });
});

describe('extractImagesFromBlocks', () => {
  it('returns URL source as-is', () => {
    expect(
      extractImagesFromBlocks([
        { type: 'image', source: { type: 'url', url: 'https://x.png' } },
      ]),
    ).toEqual(['https://x.png']);
  });
  it('wraps raw base64 into a data URL', () => {
    expect(
      extractImagesFromBlocks([
        { type: 'image', source: { type: 'base64', mediaType: 'image/png', data: 'AAA' } },
      ]),
    ).toEqual(['data:image/png;base64,AAA']);
  });
  it('keeps pre-formed data URLs untouched', () => {
    expect(
      extractImagesFromBlocks([
        { type: 'image', source: { type: 'base64', mediaType: 'image/png', data: 'data:image/png;base64,AAA' } },
      ]),
    ).toEqual(['data:image/png;base64,AAA']);
  });
});
```

- [ ] **Step 3: Run tests**

```bash
npm run test:run -- src/lib/content-blocks.test.ts
```

Expected: all pass (30+ assertions).

- [ ] **Step 4: Build**

```bash
npm run build 2>&1 | grep -E "error TS" | grep -v -E "DreamsPanel|HeartbeatPanel|IdentityPanel" | head
```

Expected: empty.

- [ ] **Step 5: Commit**

```bash
git add src/lib/content-blocks.ts src/lib/content-blocks.test.ts
git commit -m "feat(chat): content-blocks parsers (normalize + extract text/thinking/tools/images)"
```

---

## Task 4: `message-normalizer.ts` — message-level parser

**Files:**
- Create: `src/lib/message-normalizer.ts`
- Create: `src/lib/message-normalizer.test.ts`

**Rationale:** Port control-UI's `normalizeMessage` pattern — given a raw gateway message, return `{role, contentBlocks, content, senderLabel, phase?, timestamp, id?}` with user messages stripped of inbound metadata and inter-session routing already handled.

- [ ] **Step 1: Create `src/lib/message-normalizer.ts`**

```ts
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
```

- [ ] **Step 2: Create `src/lib/message-normalizer.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { normalizeMessage, extractToolMessagesFromBlocks } from './message-normalizer';

describe('normalizeMessage', () => {
  it('returns null for non-objects', () => {
    expect(normalizeMessage(null)).toBeNull();
    expect(normalizeMessage('nope')).toBeNull();
  });
  it('strips inbound metadata from user text', () => {
    const raw = {
      role: 'user',
      timestamp: 1_000,
      content: [
        {
          type: 'text',
          text:
            'Sender (untrusted metadata):\n```json\n{"x":1}\n```\n\n[Wed 2026-03-11 23:51 PDT] hola',
        },
      ],
    };
    const out = normalizeMessage(raw);
    expect(out?.role).toBe('user');
    expect(out?.content).toBe('hola');
    expect(out?.contentBlocks).toHaveLength(1);
    expect(out?.contentBlocks[0]).toEqual({ type: 'text', text: 'hola' });
  });
  it('preserves assistant array content and prefers final_answer', () => {
    const raw = {
      role: 'assistant',
      timestamp: 2_000,
      content: [
        {
          type: 'text',
          text: 'commentary text',
          textSignature: JSON.stringify({ phase: 'commentary' }),
        },
        {
          type: 'text',
          text: 'final answer',
          textSignature: JSON.stringify({ phase: 'final_answer' }),
        },
      ],
    };
    const out = normalizeMessage(raw);
    expect(out?.content).toBe('final answer');
    expect(out?.contentBlocks).toHaveLength(2);
  });
  it('derives a uniform phase when present', () => {
    const raw = {
      role: 'assistant',
      timestamp: 0,
      content: [
        { type: 'text', text: 'a', textSignature: JSON.stringify({ phase: 'final_answer' }) },
        { type: 'text', text: 'b', textSignature: JSON.stringify({ phase: 'final_answer' }) },
      ],
    };
    expect(normalizeMessage(raw)?.phase).toBe('final_answer');
  });
  it('returns undefined phase when mixed', () => {
    const raw = {
      role: 'assistant',
      timestamp: 0,
      content: [
        { type: 'text', text: 'a', textSignature: JSON.stringify({ phase: 'commentary' }) },
        { type: 'text', text: 'b', textSignature: JSON.stringify({ phase: 'final_answer' }) },
      ],
    };
    expect(normalizeMessage(raw)?.phase).toBeUndefined();
  });
  it('extracts senderLabel when present', () => {
    const raw = { role: 'user', timestamp: 0, content: 'hi', senderLabel: 'Bot' };
    expect(normalizeMessage(raw)?.senderLabel).toBe('Bot');
  });
  it('normalizes senderLabel=null when empty', () => {
    const raw = { role: 'user', timestamp: 0, content: 'hi', senderLabel: '   ' };
    expect(normalizeMessage(raw)?.senderLabel).toBeNull();
  });
});

describe('extractToolMessagesFromBlocks', () => {
  it('produces one tool ChatMessage per tool_call block', () => {
    const tools = extractToolMessagesFromBlocks('msg1', 0, 1_000, 'run1', [
      { type: 'tool_call', name: 'cron', args: { a: 1 }, toolCallId: 'c1' },
      { type: 'text', text: 'ignored' },
      { type: 'tool_call', name: 'shell', toolCallId: 'c2' },
    ]);
    expect(tools).toHaveLength(2);
    expect(tools[0]).toMatchObject({ toolName: 'cron', toolCall: { a: 1 }, runId: 'run1' });
    expect(tools[1]).toMatchObject({ toolName: 'shell' });
  });
});
```

- [ ] **Step 3: Run tests + build**

```bash
npm run test:run -- src/lib/message-normalizer.test.ts
npm run build 2>&1 | grep -E "error TS" | grep -v -E "DreamsPanel|HeartbeatPanel|IdentityPanel" | head
```

Expected: all tests pass, build empty.

- [ ] **Step 4: Commit**

```bash
git add src/lib/message-normalizer.ts src/lib/message-normalizer.test.ts
git commit -m "feat(chat): message-normalizer — ContentBlock[] + legacy string + metadata"
```

---

## Task 5: Populate `contentBlocks` in `loadChatHistory`

**Files:**
- Modify: `src/store/slices/chat-slice.ts`

**Rationale:** Today's `loadChatHistory` builds a `ChatMessage` with `content: string` only. Extend so `contentBlocks`, `phase`, `senderLabel` are populated too — renderers that migrate in later tasks can use them; the string is kept for backwards compat.

- [ ] **Step 1: Import the new parser**

Add near the other store imports at the top of `chat-slice.ts`:

```ts
import { normalizeMessage, extractToolMessagesFromBlocks } from '../../lib/message-normalizer';
```

- [ ] **Step 2: Replace the per-message map with a normalizer-based version**

Locate the current block around lines 52-107 that maps `result.messages` through role/content branching. Replace with (keep the surrounding `try { ... }` intact):

```ts
        const extractedToolUseMessages: ChatMessage[] = [];
        const messages: ChatMessage[] = (result.messages || []).map((rawMsg: unknown, i: number) => {
          const interMeta = buildInterSessionMeta(rawMsg);
          const normalized = normalizeMessage(rawMsg);

          if (!normalized) {
            return {
              id: (rawMsg as { id?: string })?.id || `msg-${i}`,
              role: 'user' as const,
              content: '',
              timestamp: Date.now(),
            };
          }

          // Extract tool_call blocks into separate tool ChatMessages so the
          // Tools panel + ToolCard renderer stay in sync with legacy behavior.
          extractedToolUseMessages.push(
            ...extractToolMessagesFromBlocks(
              normalized.id,
              i,
              normalized.timestamp,
              (rawMsg as { runId?: string })?.runId,
              normalized.contentBlocks,
            ),
          );

          // Inter-session events render as event cards — collapse content to
          // a one-line label so the legacy text path doesn't show scaffolding.
          const legacyContent = interMeta
            ? (interMeta.task ? `Subagent: ${interMeta.task}` : 'Inter-session event')
            : normalized.role === 'assistant'
              ? stripReasoningTags(normalized.content)
              : normalized.content;

          const base: ChatMessage = {
            id: normalized.id || `msg-${i}`,
            role: normalized.role,
            content: legacyContent,
            timestamp: normalized.timestamp,
            contentBlocks: normalized.contentBlocks,
            senderLabel: normalized.senderLabel,
            ...(normalized.phase ? { phase: normalized.phase } : {}),
            toolName: (rawMsg as { toolName?: string })?.toolName,
            toolCall: (rawMsg as { toolCall?: unknown })?.toolCall,
            result: (rawMsg as { result?: unknown })?.result,
            runId: (rawMsg as { runId?: string })?.runId,
            ...(interMeta ? { meta: interMeta } : {}),
          };
          return base;
        }).filter((m) => {
          if (m.role === 'toolResult' as unknown as typeof m.role) return false;
          if (m.role === 'user' && !m.meta && (!m.content || !m.content.trim())) return false;
          if (m.role === 'assistant' && isSilentReply(m.content)) return false;
          if (m.role === 'assistant' && !m.content?.trim() && !m.toolName && !m.toolCall) return false;
          return true;
        });
```

This replaces both the role-branching text extraction AND the per-message tool_use extraction with the new parser.

- [ ] **Step 3: Remove now-unused imports**

Delete these imports from `chat-slice.ts` if nothing else references them:
- `extractAssistantTextForPhase` (replaced by normalizer's `preferFinalAnswerText`)
- `stripInboundMeta` (now called inside normalizer)

Keep `stripReasoningTags` — still used for legacy `content` string on assistant messages (just in case blocks are absent).

- [ ] **Step 4: Run tests + build**

```bash
npm run test:run
npm run build 2>&1 | grep -E "error TS" | grep -v -E "DreamsPanel|HeartbeatPanel|IdentityPanel" | head
```

Expected: all green, build empty.

- [ ] **Step 5: Manual QA**

1. `npm run dev` (already running).
2. Reload the dashboard in the browser, pick a session with messages.
3. Open DevTools console, run:
   ```js
   const s = useDashboardStore.getState();
   s.chatMessages.slice(0, 3).forEach(m => console.log(m.role, 'blocks:', m.contentBlocks?.length, 'phase:', m.phase));
   ```
   (If `useDashboardStore` isn't exposed on window, temporarily add `;(window as any).__store = useDashboardStore` in `dashboard-store.ts` and remove at phase end — track as Task 12.)
4. Every message should show `blocks: N` with N ≥ 1.

- [ ] **Step 6: Commit**

```bash
git add src/store/slices/chat-slice.ts
git commit -m "feat(chat): populate contentBlocks on every history-loaded message"
```

---

## Task 6: `ThinkingBlock` component

**Files:**
- Create: `src/components/chat/ThinkingBlock.tsx`

**Rationale:** Dedicated collapsible render for reasoning text. Subtle styling (italic muted) so it doesn't dominate the bubble.

- [ ] **Step 1: Create the component**

```tsx
// src/components/chat/ThinkingBlock.tsx
import { useState } from 'react';
import { ChevronRight, Brain } from 'lucide-react';
import { cn } from '../../lib/utils';

interface ThinkingBlockProps {
  thinking: string;
  /** When true, render expanded by default. */
  defaultExpanded?: boolean;
}

export function ThinkingBlock({ thinking, defaultExpanded = false }: ThinkingBlockProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const trimmed = thinking.trim();
  if (!trimmed) return null;

  return (
    <div className="my-2 border-l-2 border-indigo-500/30 pl-3 text-xs">
      <button
        type="button"
        onClick={() => setExpanded(e => !e)}
        className={cn(
          'flex items-center gap-1.5 text-[10px] uppercase tracking-wide',
          'text-muted-foreground hover:text-foreground transition-colors',
        )}
        aria-expanded={expanded}
        aria-label={expanded ? 'Collapse reasoning' : 'Expand reasoning'}
      >
        <Brain className="w-3 h-3" />
        <span>Reasoning</span>
        <ChevronRight className={cn('w-3 h-3 transition-transform', expanded && 'rotate-90')} />
      </button>
      {expanded && (
        <div className="mt-1.5 italic text-muted-foreground whitespace-pre-wrap break-words leading-relaxed">
          {trimmed}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Build**

```bash
npm run build 2>&1 | grep -E "error TS" | grep -v -E "DreamsPanel|HeartbeatPanel|IdentityPanel" | head
```

Expected: empty.

- [ ] **Step 3: Commit**

```bash
git add src/components/chat/ThinkingBlock.tsx
git commit -m "feat(chat): ThinkingBlock component with collapsible reasoning"
```

---

## Task 7: `ToolCard` component

**Files:**
- Create: `src/components/chat/ToolCard.tsx`

**Rationale:** Unified tool call/result render. Inline for short outputs (≤ 120 chars); otherwise collapsed preview with "Expand in sidebar" action. Color tone: running (amber), success (emerald), error (red).

- [ ] **Step 1: Create the component**

```tsx
// src/components/chat/ToolCard.tsx
import { useState } from 'react';
import { ChevronDown, Check, Copy, AlertTriangle, Play, Wrench } from 'lucide-react';
import { cn } from '../../lib/utils';
import type { ToolCardView } from '../../lib/content-blocks';

const TOOL_INLINE_THRESHOLD = 120;

interface ToolCardProps {
  card: ToolCardView;
  onExpand?: (card: ToolCardView) => void;
}

export function ToolCard({ card, onExpand }: ToolCardProps) {
  const [copied, setCopied] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const hasResult = typeof card.resultText === 'string' && card.resultText.length > 0;
  const preview = (card.resultText || '').slice(0, 200);
  const isShort = (card.resultText || '').length <= TOOL_INLINE_THRESHOLD;
  const state: 'running' | 'success' | 'error' = !hasResult ? 'running' : card.isError ? 'error' : 'success';

  const toneBorder =
    state === 'running' ? 'border-amber-500/30'
    : state === 'error' ? 'border-red-500/30'
    : 'border-emerald-500/25';

  const toneHeader =
    state === 'running' ? 'bg-amber-500/5'
    : state === 'error' ? 'bg-red-500/5'
    : 'bg-emerald-500/5';

  const toneIconBg =
    state === 'running' ? 'bg-amber-500/10 text-amber-600 dark:text-amber-400'
    : state === 'error' ? 'bg-red-500/10 text-red-600 dark:text-red-400'
    : 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400';

  const Icon = state === 'error' ? AlertTriangle : state === 'running' ? Play : Wrench;

  const copy = async () => {
    await navigator.clipboard.writeText(card.resultText || JSON.stringify(card.args ?? {}, null, 2));
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className={cn('rounded-lg border bg-card/40 overflow-hidden', toneBorder)}>
      <div className={cn('flex items-center gap-2 px-3 py-2', toneHeader)}>
        <div className={cn('w-6 h-6 rounded flex items-center justify-center shrink-0', toneIconBg)}>
          <Icon className="w-3.5 h-3.5" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-xs font-medium text-foreground truncate">{card.name}</div>
          {!hasResult && <div className="text-[10px] text-muted-foreground">running…</div>}
        </div>
        {hasResult && !isShort && onExpand && (
          <button
            type="button"
            onClick={() => onExpand(card)}
            className="text-[10px] text-muted-foreground hover:text-foreground"
            aria-label="Open in sidebar"
          >
            Open
          </button>
        )}
        {hasResult && (
          <button
            type="button"
            onClick={() => setExpanded(e => !e)}
            className="text-muted-foreground hover:text-foreground"
            aria-label={expanded ? 'Collapse' : 'Expand'}
            aria-expanded={expanded}
          >
            <ChevronDown className={cn('w-4 h-4 transition-transform', expanded && 'rotate-180')} />
          </button>
        )}
      </div>
      {hasResult && expanded && (
        <div className="border-t border-border/40 px-3 py-2 bg-background/30">
          <div className="flex items-center justify-between mb-1">
            <span className="text-[10px] uppercase tracking-wide text-muted-foreground">Output</span>
            <button
              type="button"
              onClick={copy}
              className="text-[10px] text-muted-foreground hover:text-foreground flex items-center gap-1"
              aria-label="Copy output"
            >
              {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
          <pre className="whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-foreground/90 max-h-60 overflow-auto">
            {isShort ? card.resultText : preview + (card.resultText!.length > 200 ? '\n…' : '')}
          </pre>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Build + commit**

```bash
npm run build 2>&1 | grep -E "error TS" | grep -v -E "DreamsPanel|HeartbeatPanel|IdentityPanel" | head
```

Expected: empty.

```bash
git add src/components/chat/ToolCard.tsx
git commit -m "feat(chat): ToolCard component with inline vs open-in-sidebar decision"
```

---

## Task 8: `MessageContent` renderer

**Files:**
- Create: `src/components/chat/MessageContent.tsx`

**Rationale:** Dispatches a ContentBlock[] into React elements. Text → markdown. Thinking → ThinkingBlock. Tool calls → ToolCard. Images → `<img>`.

- [ ] **Step 1: Create the component**

```tsx
// src/components/chat/MessageContent.tsx
import { Fragment } from 'react';
import { cn } from '../../lib/utils';
import type { ContentBlock, AssistantPhase } from '../../types/openclaw';
import { renderMarkdown } from './chat-utils';
import { ThinkingBlock } from './ThinkingBlock';
import { ToolCard } from './ToolCard';
import { extractToolCardsFromBlocks } from '../../lib/content-blocks';

interface MessageContentProps {
  blocks: ContentBlock[];
  /** If set, skip text blocks of other phases (keeps unphased). */
  phase?: AssistantPhase;
  /** Expand handler for large tool outputs. */
  onExpandTool?: (card: ReturnType<typeof extractToolCardsFromBlocks>[number]) => void;
  className?: string;
}

export function MessageContent({ blocks, phase, onExpandTool, className }: MessageContentProps) {
  const toolCards = extractToolCardsFromBlocks(blocks);
  // We render cards in-order, interleaved with text/thinking/images.
  // To keep a stable layout, iterate blocks and dispatch per type.
  // tool_result blocks are absorbed into the matching tool_call card and
  // therefore skipped when we see them standalone (unless orphan).
  const resultIdsConsumed = new Set(
    toolCards.map(c => c.toolCallId).filter((id): id is string => typeof id === 'string'),
  );

  return (
    <div className={cn('space-y-2', className)}>
      {blocks.map((b, i) => {
        if (b.type === 'text') {
          if (phase && b.phase && b.phase !== phase) return null;
          return <Fragment key={i}>{renderMarkdown(b.text)}</Fragment>;
        }
        if (b.type === 'thinking') {
          if (phase && b.phase && b.phase !== phase) return null;
          return <ThinkingBlock key={i} thinking={b.thinking} />;
        }
        if (b.type === 'tool_call') {
          const card = toolCards.find(c => c.toolCallId === b.toolCallId) || {
            name: b.name,
            args: b.args,
            toolCallId: b.toolCallId,
          };
          return <ToolCard key={i} card={card} onExpand={onExpandTool} />;
        }
        if (b.type === 'tool_result') {
          // Absorbed by matching tool_call already; render orphan only.
          if (b.toolCallId && resultIdsConsumed.has(b.toolCallId)) return null;
          return (
            <ToolCard
              key={i}
              card={{
                name: 'tool result',
                resultText: b.text,
                isError: b.isError,
                toolCallId: b.toolCallId,
              }}
              onExpand={onExpandTool}
            />
          );
        }
        if (b.type === 'image') {
          const url =
            b.source.type === 'url'
              ? b.source.url
              : b.source.data.startsWith('data:')
                ? b.source.data
                : `data:${b.source.mediaType || 'image/png'};base64,${b.source.data}`;
          return (
            <img
              key={i}
              src={url}
              alt="attachment"
              className="max-w-full max-h-80 rounded-md border border-border/40"
              loading="lazy"
            />
          );
        }
        return null;
      })}
    </div>
  );
}
```

- [ ] **Step 2: Build + commit**

```bash
npm run build 2>&1 | grep -E "error TS" | grep -v -E "DreamsPanel|HeartbeatPanel|IdentityPanel" | head
```

Expected: empty.

```bash
git add src/components/chat/MessageContent.tsx
git commit -m "feat(chat): MessageContent dispatcher for canonical content blocks"
```

---

## Task 9: Wire `MessageBubble` to delegate to `MessageContent`

**Files:**
- Modify: `src/components/chat/MessageBubble.tsx`

**Rationale:** Backwards-compatible switch — if `message.contentBlocks` present, render via `<MessageContent>`. Else keep the legacy renderers (unchanged). Inter-session short-circuit from Phase 1 still runs first.

- [ ] **Step 1: Add the delegation branch**

Open `src/components/chat/MessageBubble.tsx`. Import `MessageContent`:

```ts
import { MessageContent } from './MessageContent';
```

Locate the existing inter-session short-circuit and add a new branch AFTER it but BEFORE the legacy `isUser` / `isSystem` / `isTool` branching. Structurally:

```tsx
// Inter-session (Phase 1)
if (message.meta?.kind === 'inter_session') { ... }

// NEW: canonical content blocks (Phase 2)
if (message.contentBlocks && message.contentBlocks.length > 0) {
  const isUser = message.role === 'user';
  // Re-use the existing user-bubble styling for user messages; for assistant,
  // render blocks directly without outer chrome (keeps the visual quieter).
  if (isUser) {
    return (
      <div className="flex justify-end w-full">
        <div className="max-w-2xl rounded-2xl px-4 py-2 bg-zinc-100 dark:bg-zinc-800 text-foreground">
          <MessageContent blocks={message.contentBlocks} />
        </div>
      </div>
    );
  }
  return (
    <div className="w-full">
      <MessageContent blocks={message.contentBlocks} phase="final_answer" />
    </div>
  );
}

// Legacy fallback (unchanged)
const isUser = message.role === 'user';
...
```

Keep the existing legacy path unchanged below.

- [ ] **Step 2: Build**

```bash
npm run build 2>&1 | grep -E "error TS" | grep -v -E "DreamsPanel|HeartbeatPanel|IdentityPanel" | head
```

Expected: empty.

- [ ] **Step 3: Manual QA**

Reload dashboard, open a session. Messages should now render via MessageContent (tool cards inline, thinking expandable). Compare against before — visual parity with extra polish.

If anything looks off, fall back: temporarily comment out the new branch and confirm legacy still works.

- [ ] **Step 4: Commit**

```bash
git add src/components/chat/MessageBubble.tsx
git commit -m "feat(chat): MessageBubble delegates to MessageContent when contentBlocks present"
```

---

## Task 10: `MessageGroup` — Slack-style grouping

**Files:**
- Create: `src/components/chat/MessageGroup.tsx`

**Rationale:** Consecutive same-role messages within 5 min share a single avatar + sender label + footer. Cleaner timeline.

- [ ] **Step 1: Create the component**

```tsx
// src/components/chat/MessageGroup.tsx
import { MessageAvatar } from './MessageAvatar';
import { MessageBubble } from './MessageBubble';
import type { AgentSummary, ChatMessage } from '../../types/openclaw';
import { formatTimestamp } from '../../lib/utils';

export const MAX_GROUP_GAP_MS = 5 * 60 * 1000;

interface MessageGroupProps {
  messages: ChatMessage[];
  agents: AgentSummary[];
  sessionKey?: string;
}

export function MessageGroup({ messages, agents, sessionKey }: MessageGroupProps) {
  if (messages.length === 0) return null;
  const first = messages[0];
  const last = messages[messages.length - 1];
  const isUser = first.role === 'user';

  return (
    <div className="flex flex-col gap-1 mb-4">
      <div className={`flex items-end gap-2 ${isUser ? 'flex-row-reverse' : ''}`}>
        <MessageAvatar role={first.role} agents={agents} sessionKey={sessionKey} />
        <div className="flex-1 min-w-0 flex flex-col gap-1 items-stretch">
          {messages.map((m, idx) => (
            <MessageBubble
              key={m.id}
              message={m}
              showAvatar={false}
              agents={agents}
              sessionKey={sessionKey}
            />
          ))}
          <div className={`text-[10px] text-muted-foreground ${isUser ? 'text-right' : 'text-left'} pt-0.5`}>
            {formatTimestamp(last.timestamp)}
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Partition a flat ChatMessage[] into consecutive groups by role + time gap.
 * Inter-session event messages break the group (each renders standalone).
 */
export function groupMessages(messages: ChatMessage[]): ChatMessage[][] {
  const groups: ChatMessage[][] = [];
  let current: ChatMessage[] = [];
  for (const m of messages) {
    if (m.meta?.kind === 'inter_session') {
      if (current.length > 0) { groups.push(current); current = []; }
      groups.push([m]);
      continue;
    }
    if (current.length === 0) { current.push(m); continue; }
    const prev = current[current.length - 1];
    const sameRole = prev.role === m.role;
    const withinGap = Math.abs((m.timestamp || 0) - (prev.timestamp || 0)) <= MAX_GROUP_GAP_MS;
    if (sameRole && withinGap) {
      current.push(m);
    } else {
      groups.push(current);
      current = [m];
    }
  }
  if (current.length > 0) groups.push(current);
  return groups;
}
```

- [ ] **Step 2: Build + commit**

```bash
npm run build 2>&1 | grep -E "error TS" | grep -v -E "DreamsPanel|HeartbeatPanel|IdentityPanel" | head
```

Expected: empty.

```bash
git add src/components/chat/MessageGroup.tsx
git commit -m "feat(chat): MessageGroup + groupMessages() for Slack-style consecutive merging"
```

---

## Task 11: Wire `ChatView` to use `<MessageGroup>`

**Files:**
- Modify: `src/components/views/ChatView.tsx`

- [ ] **Step 1: Import + use**

Add import:
```ts
import { MessageGroup, groupMessages } from '../chat/MessageGroup';
```

Locate the existing `{filteredMessages.map((msg, i, arr) => { ... })}` block (~line 461). Replace with:

```tsx
{groupMessages(filteredMessages).map((group, gIdx) => (
  <MessageGroup
    key={group[0].id + ':' + gIdx}
    messages={group}
    agents={agentList}
    sessionKey={effectiveKey}
  />
))}
```

- [ ] **Step 2: Build + manual QA**

```bash
npm run build 2>&1 | grep -E "error TS" | grep -v -E "DreamsPanel|HeartbeatPanel|IdentityPanel" | head
```

Expected: empty.

Reload browser. Consecutive same-role messages should now share an avatar + bottom timestamp; inter-session event cards remain standalone; tool results rendered via MessageContent.

- [ ] **Step 3: Commit**

```bash
git add src/components/views/ChatView.tsx
git commit -m "feat(chat): render chat timeline via MessageGroup (Slack-style grouping)"
```

---

## Task 12: `VirtualMessageList` — IntersectionObserver virtualization

**Files:**
- Create: `src/components/chat/VirtualMessageList.tsx`
- Modify: `src/components/views/ChatView.tsx`

**Rationale:** When a session has hundreds+ of messages, mounting all at once is wasteful. Render all below a threshold (500); above, only mount visible + buffer.

- [ ] **Step 1: Create the component**

```tsx
// src/components/chat/VirtualMessageList.tsx
import { useEffect, useRef, useState, type ReactElement } from 'react';

const VIRTUALIZE_THRESHOLD = 500;
const BUFFER = 30;

interface VirtualMessageListProps {
  children: ReactElement[];
}

export function VirtualMessageList({ children }: VirtualMessageListProps) {
  if (children.length < VIRTUALIZE_THRESHOLD) {
    return <>{children}</>;
  }
  return <VirtualList items={children} />;
}

function VirtualList({ items }: { items: ReactElement[] }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<(HTMLDivElement | null)[]>([]);
  const [visible, setVisible] = useState<Set<number>>(() => {
    // Initially mount the last N items (visible viewport ~ bottom).
    const start = Math.max(0, items.length - BUFFER * 2);
    return new Set(Array.from({ length: items.length - start }, (_, i) => start + i));
  });

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        setVisible((prev) => {
          const next = new Set(prev);
          for (const entry of entries) {
            const idx = Number((entry.target as HTMLElement).dataset.idx);
            if (Number.isFinite(idx)) {
              if (entry.isIntersecting) {
                for (let j = Math.max(0, idx - BUFFER); j <= Math.min(items.length - 1, idx + BUFFER); j++) {
                  next.add(j);
                }
              }
            }
          }
          return next;
        });
      },
      { root: null, rootMargin: '200px' },
    );
    for (const el of itemRefs.current) {
      if (el) observer.observe(el);
    }
    return () => observer.disconnect();
  }, [items.length]);

  return (
    <div ref={containerRef}>
      {items.map((item, i) => (
        <div
          key={i}
          ref={(el) => { itemRefs.current[i] = el; }}
          data-idx={i}
          style={{ minHeight: visible.has(i) ? undefined : 40 }}
        >
          {visible.has(i) ? item : null}
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 2: Wrap the message list in ChatView**

Change:
```tsx
{groupMessages(filteredMessages).map(...)}
```

To:
```tsx
<VirtualMessageList>
  {groupMessages(filteredMessages).map((group, gIdx) => (
    <MessageGroup key={group[0].id + ':' + gIdx} messages={group} agents={agentList} sessionKey={effectiveKey} />
  ))}
</VirtualMessageList>
```

Add import in ChatView:
```ts
import { VirtualMessageList } from '../chat/VirtualMessageList';
```

- [ ] **Step 3: Build + commit**

```bash
npm run build 2>&1 | grep -E "error TS" | grep -v -E "DreamsPanel|HeartbeatPanel|IdentityPanel" | head
```

Expected: empty.

```bash
git add src/components/chat/VirtualMessageList.tsx src/components/views/ChatView.tsx
git commit -m "feat(chat): IntersectionObserver virtualization above 500 messages"
```

---

## Task 13: Version bump + manual QA checklist

**Files:**
- Modify: `package.json` (patch → minor: 2.23.1 → 2.24.0)

- [ ] **Step 1: Bump**

```bash
npm version minor --no-git-tag-version
```

- [ ] **Step 2: Full build**

```bash
npm run build 2>&1 | grep -E "error TS" | grep -v -E "DreamsPanel|HeartbeatPanel|IdentityPanel" | head
npm run test:run
```

Both should be empty/green.

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: bump version to 2.24.0 (chat phase 2)"
```

- [ ] **Step 4: Manual QA**

- [ ] Reload dashboard, open a session with ~20+ messages.
- [ ] Messages render in Slack-style groups (same-role consecutive = one avatar + shared timestamp).
- [ ] Tool calls render as `<ToolCard>` (inline if short, expandable chevron).
- [ ] Thinking blocks render as collapsible "Reasoning" with Brain icon.
- [ ] Inter-session events still render as centered event cards (Phase 1 unchanged).
- [ ] Sending a new message still works end-to-end (streaming indicator, final assembly).
- [ ] History reload still works (reload browser → chat repopulates).
- [ ] Tools panel (right column bottom tab) still lists tool messages.
- [ ] ChatView scroll behavior unchanged (auto-scroll, sticky-on-tail).
- [ ] No regressions in Pipeline kanban / Errors / Latency / Crons tabs.
- [ ] Phase 1 features still live: ↑/↓ history, persisted session, phase filter.

---

## Rollback

If any task breaks chat, `git revert <sha>` the commit. Since every task is a single file or a tightly scoped diff, reverts are safe.

Biggest risk: Task 5 (`loadChatHistory` replacement). If it ships broken, revert it and the downstream renderer tasks keep working from the legacy `content: string` path. No data migrations; no external dependencies.

## Next phase

Phase 3 — image attachments (drag-drop, paste, render `<img>`) — builds on this phase's `ContentBlock { type:'image' }` support already wired into `MessageContent`. Much smaller than Phase 2.

Plan authored at head of branch state after commit `e0178e7`.
