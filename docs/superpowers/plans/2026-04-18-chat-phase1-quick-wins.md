# Chat Phase 1 — Quick Wins Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land four low-risk, high-UX-payoff improvements from OpenClaw control-UI into Silos chat: persisted last-active session, up/down input history, assistant-phase filtering, and WeakMap-cached text extraction.

**Architecture:** Additive. New slice + hook + two pure-function libs. Three existing files touched minimally (`session-slice.ts` no change — only `dashboard-store.ts` partialize config; `chat-slice.ts` one call site; `ChatView.tsx` textarea `onKeyDown` wiring).

**Tech Stack:** TypeScript, React 19, Zustand 5, Vite, Tailwind. No new deps.

**Parent design:** `docs/superpowers/specs/2026-04-18-chat-control-ui-parity-design.md`.

---

## Preconditions

- Branch: clean working tree on `main`, or dedicated branch `chat-phase1-quick-wins`.
- Silos dev server not required during implementation; required for manual QA at the end.
- TypeScript strict mode on (already).

## File Manifest

**Create:**
- `src/lib/message-extract.ts`
- `src/lib/phase-filter.ts`
- `src/store/slices/input-history-slice.ts`
- `src/hooks/useInputHistory.ts`

**Modify:**
- `src/types/openclaw.ts` — export `AssistantPhase` type used in Phase 1 (ahead of Phase 2).
- `src/store/store-types.ts` — add `InputHistorySlice` to `DashboardStore` composite type.
- `src/store/dashboard-store.ts` — register `createInputHistorySlice`, extend `partialize` with `selectedSessionKey` + `inputHistory` serialized form.
- `src/store/slices/chat-slice.ts:37-150` — in `loadChatHistory`, use `extractAssistantTextForPhase` when the message has `content` as an array with textSignatures.
- `src/store/slices/session-slice.ts` — on `selectSession(key)` with `key === null` during rehydrate, don't clobber selection before history loads.
- `src/components/views/ChatView.tsx` — wire `useInputHistory` into textarea `onKeyDown` and `onSend` flow.

---

## Task 1: Create `message-extract.ts` with WeakMap-cached text extraction

**Files:**
- Create: `src/lib/message-extract.ts`

**Rationale:** Control-UI's `extractTextCached` uses a WeakMap keyed by message reference. Silos re-extracts per render. Port it. Pure function, no dependencies — lives in `src/lib/`.

- [ ] **Step 1: Create the file with the full implementation**

```ts
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
 *   - array content with { type: 'text', text, textSignature? } blocks → joined with '\n'
 * If `phase` is specified, only text blocks whose textSignature resolves to
 * the requested phase are kept. If no signatures are present, all text is returned.
 *
 * Results are memoized per (message, phase) tuple, WeakMap-keyed on the message.
 * Assumes the message reference is immutable once observed; mutating a cached
 * message's `content` after first call returns a stale result.
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
 * Assumes the message reference is immutable once observed.
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
    if (type !== 'text') continue;
    const text = (block as { text?: unknown }).text;
    if (typeof text !== 'string') continue;

    if (phase) {
      const blockPhase = resolvePhase(block);
      // Unphased blocks are kept for backwards compat; only filter phased mismatches.
      if (blockPhase && blockPhase !== phase) continue;
    }
    parts.push(text);
  }
  return parts.join('\n');
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
  if (typeof sig !== 'string') return undefined;
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
```

- [ ] **Step 2: Verify the file compiles**

Run: `npx tsc --noEmit src/lib/message-extract.ts`
Expected: no output (success). If error about missing `AssistantPhase`, proceed to Task 2 first and come back.

Actually the import will fail until Task 2 creates `AssistantPhase`. Skip verification here; it's covered at end of Task 2.

- [ ] **Step 3: Commit**

```bash
git add src/lib/message-extract.ts
git commit -m "feat(chat): add WeakMap-cached text/thinking extractors"
```

---

## Task 2: Add `AssistantPhase` type and create `phase-filter.ts`

**Files:**
- Modify: `src/types/openclaw.ts` (append type export near existing chat types)
- Create: `src/lib/phase-filter.ts`

- [ ] **Step 1: Add `AssistantPhase` to types**

Open `src/types/openclaw.ts` and locate the `MessageStatus` declaration (near line 287-302 region with `ChatMessage`). Append after `MessageStatus`:

```ts
export type AssistantPhase = 'commentary' | 'final_answer';
```

- [ ] **Step 2: Create `phase-filter.ts`**

```ts
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
```

- [ ] **Step 3: Verify compilation**

Run: `npm run build`
Expected: TypeScript compiles with no errors. Vite build completes.

If `src/lib/message-extract.ts` is referenced elsewhere, ensure no circular imports. It isn't yet.

- [ ] **Step 4: Commit**

```bash
git add src/types/openclaw.ts src/lib/phase-filter.ts
git commit -m "feat(chat): add AssistantPhase type and phase filter"
```

---

## Task 3: Apply phase filtering in `loadChatHistory`

**Files:**
- Modify: `src/store/slices/chat-slice.ts:52-80` (the history-normalization block)

**Rationale:** Today, assistant messages with `content` as an array are flattened by joining all text blocks. Control-UI's recent commit `a4f16f572c` prefers `final_answer` blocks. We do the same.

- [ ] **Step 1: Read the current block**

Run: `sed -n '50,90p' src/store/slices/chat-slice.ts`

You should see the branch that handles `Array.isArray(m.content)` for assistant messages.

- [ ] **Step 2: Import the phase filter**

At the top of `src/store/slices/chat-slice.ts`, add next to the existing imports:

```ts
import { extractAssistantTextForPhase } from '../../lib/phase-filter';
```

- [ ] **Step 3: Replace lines 58-81 with phase-aware extraction**

Current code (lines 58-81):

```ts
          } else if (Array.isArray(m.content)) {
            const textParts = m.content
              .filter((item: any) => !item || typeof item === 'string' || item?.type === 'text')
              .map((item: any) => (typeof item === 'string' ? item : item?.text ?? null))
              .filter(Boolean);
            textContent = textParts.join('\n') || '';

            for (const item of m.content) {
              if (item?.type === 'tool_use' && item.name) {
                extractedToolUseMessages.push({
                  id: item.id || `tool-${m.id || i}-${item.name}`,
                  role: 'tool',
                  content: '',
                  timestamp: m.timestamp || Date.now(),
                  toolName: item.name,
                  toolCall: item.input,
                  runId: m.runId,
                  status: 'delivered',
                });
              }
            }
          } else {
            textContent = '';
          }
```

Replace with:

```ts
          } else if (Array.isArray(m.content)) {
            if (m.role === 'assistant') {
              textContent = extractAssistantTextForPhase(m, 'final_answer');
            } else {
              const textParts = m.content
                .filter((item: any) => !item || typeof item === 'string' || item?.type === 'text')
                .map((item: any) => (typeof item === 'string' ? item : item?.text ?? null))
                .filter(Boolean);
              textContent = textParts.join('\n') || '';
            }

            for (const item of m.content) {
              if (item?.type === 'tool_use' && item.name) {
                extractedToolUseMessages.push({
                  id: item.id || `tool-${m.id || i}-${item.name}`,
                  role: 'tool',
                  content: '',
                  timestamp: m.timestamp || Date.now(),
                  toolName: item.name,
                  toolCall: item.input,
                  runId: m.runId,
                  status: 'delivered',
                });
              }
            }
          } else {
            textContent = '';
          }
```

The tool_use extraction loop stays unchanged and runs for every array-content message regardless of role — only the textContent assignment branches on role.

- [ ] **Step 4: Verify build**

Run: `npm run build`
Expected: clean build.

- [ ] **Step 5: Manual verification (write it down now for Task 9 QA)**

Acceptance: open a chat with at least one assistant message, reload, confirm no commentary-phase text is shown. If gateway never emits phase signatures for your setup, text is unchanged — this is expected behavior (fallback preserves legacy rendering).

- [ ] **Step 6: Commit**

```bash
git add src/store/slices/chat-slice.ts
git commit -m "feat(chat): prefer final_answer phase on assistant history load"
```

---

## Task 4: Create `input-history-slice.ts`

**Files:**
- Create: `src/store/slices/input-history-slice.ts`

**Rationale:** Per-session up/down history, 50 items max. LS-backed by `silos:history:<sessionKey>`. Slice exposes pushEntry, prev, next, resetCursor, setDraft.

- [ ] **Step 1: Create the slice**

```ts
// src/store/slices/input-history-slice.ts
//
// Per-session input history (up to MAX_ENTRIES per session).
// Backed by localStorage key `silos:history:<sessionKey>`.
// Cursor navigation: prev() walks back, next() walks forward,
// resetCursor() lands on the live draft.

import type { StoreSet, StoreGet } from '../store-types';

const MAX_ENTRIES = 50;
const LS_PREFIX = 'silos:history:';

function lsKey(sessionKey: string): string {
  return `${LS_PREFIX}${sessionKey}`;
}

function loadEntries(sessionKey: string): string[] {
  try {
    const raw = localStorage.getItem(lsKey(sessionKey));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.every(e => typeof e === 'string')) {
      return parsed.slice(-MAX_ENTRIES);
    }
  } catch { /* corrupt — wipe */ }
  return [];
}

function saveEntries(sessionKey: string, entries: string[]): void {
  try {
    localStorage.setItem(lsKey(sessionKey), JSON.stringify(entries.slice(-MAX_ENTRIES)));
  } catch { /* LS full — drop silently */ }
}

export interface InputHistorySlice {
  _inputHistoryDrafts: Map<string, string>;       // sessionKey → live draft when navigating
  _inputHistoryCursors: Map<string, number>;      // sessionKey → cursor (-1 = live, 0..n-1 = history index from newest)

  pushHistoryEntry: (sessionKey: string, text: string) => void;
  historyPrev: (sessionKey: string, liveDraft: string) => string | null;
  historyNext: (sessionKey: string) => string | null;
  historyResetCursor: (sessionKey: string) => void;
}

export function createInputHistorySlice(set: StoreSet, get: StoreGet): InputHistorySlice {
  return {
    _inputHistoryDrafts: new Map<string, string>(),
    _inputHistoryCursors: new Map<string, number>(),

    pushHistoryEntry: (sessionKey, text) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      const current = loadEntries(sessionKey);
      // Dedup consecutive.
      if (current[current.length - 1] === trimmed) {
        // Still reset cursor/draft so next ↑ starts fresh.
        get().historyResetCursor(sessionKey);
        return;
      }
      const next = [...current, trimmed].slice(-MAX_ENTRIES);
      saveEntries(sessionKey, next);
      get().historyResetCursor(sessionKey);
    },

    historyPrev: (sessionKey, liveDraft) => {
      const entries = loadEntries(sessionKey);
      if (entries.length === 0) return null;

      const cursors = new Map(get()._inputHistoryCursors);
      const drafts = new Map(get()._inputHistoryDrafts);
      let cursor = cursors.get(sessionKey) ?? -1;

      if (cursor === -1) {
        // Save live draft before navigating away.
        drafts.set(sessionKey, liveDraft);
      }
      // Newest = entries[entries.length - 1]; cursor 0 → newest, 1 → second-newest, …
      cursor = Math.min(cursor + 1, entries.length - 1);
      cursors.set(sessionKey, cursor);
      set({ _inputHistoryCursors: cursors, _inputHistoryDrafts: drafts });
      return entries[entries.length - 1 - cursor];
    },

    historyNext: (sessionKey) => {
      const entries = loadEntries(sessionKey);
      const cursors = new Map(get()._inputHistoryCursors);
      const drafts = new Map(get()._inputHistoryDrafts);
      let cursor = cursors.get(sessionKey) ?? -1;

      if (cursor <= 0) {
        // Return to live draft.
        const draft = drafts.get(sessionKey) ?? '';
        cursors.set(sessionKey, -1);
        drafts.delete(sessionKey);
        set({ _inputHistoryCursors: cursors, _inputHistoryDrafts: drafts });
        return draft;
      }
      cursor -= 1;
      cursors.set(sessionKey, cursor);
      set({ _inputHistoryCursors: cursors });
      return entries[entries.length - 1 - cursor];
    },

    historyResetCursor: (sessionKey) => {
      const cursors = new Map(get()._inputHistoryCursors);
      const drafts = new Map(get()._inputHistoryDrafts);
      if (!cursors.has(sessionKey) && !drafts.has(sessionKey)) return;
      cursors.delete(sessionKey);
      drafts.delete(sessionKey);
      set({ _inputHistoryCursors: cursors, _inputHistoryDrafts: drafts });
    },
  };
}
```

- [ ] **Step 2: Extend `store-types.ts`**

Open `src/store/store-types.ts`. Add import and type intersection:

```ts
import type { InputHistorySlice } from './slices/input-history-slice';

// Existing DashboardStore type intersection — append `& InputHistorySlice`:
export type DashboardStore = ConnectionSlice
  & DataLoadersSlice
  & SessionSlice
  & ChatSlice
  & CronSlice
  & TaskSlice
  & FilesSlice
  & UiSlice
  & EventSlice
  & TelemetrySlice
  & InputHistorySlice;
```

(If `store-types.ts` uses a different composition pattern, adapt: just add the slice to the existing union/intersection.)

- [ ] **Step 3: Register slice in `dashboard-store.ts`**

Open `src/store/dashboard-store.ts`. After the existing slice imports:

```ts
import { createInputHistorySlice } from './slices/input-history-slice';
```

Inside the `create()` call, append to the spread list:

```ts
...createInputHistorySlice(set, get),
```

- [ ] **Step 4: Build**

Run: `npm run build`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add src/store/slices/input-history-slice.ts src/store/store-types.ts src/store/dashboard-store.ts
git commit -m "feat(chat): per-session input history slice with LS persistence"
```

---

## Task 5: Create `useInputHistory` hook

**Files:**
- Create: `src/hooks/useInputHistory.ts`

**Rationale:** Textarea needs a small behavior package: intercept ↑/↓ only when cursor is at start/end respectively and text is empty or we're already navigating. Expose `onKeyDown` + `onBeforeSend` + `onChange` hooks.

- [ ] **Step 1: Create the hook**

```ts
// src/hooks/useInputHistory.ts
//
// Wire per-session input history into a textarea.
// Conventions:
//   - ↑ navigates to previous entry when the cursor is at position 0.
//   - ↓ navigates to the next (more recent) entry or returns to live draft.
//   - Any edit (onChange) while in history mode stays in history mode until Enter/Esc.
//   - onBeforeSend() snapshots the text into history.
//   - Escape resets to live draft.

import { useCallback, useRef } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useDashboardStore } from '../store/dashboard-store';

export function useInputHistory(
  sessionKey: string | null,
  getDraft: () => string,
  setDraft: (text: string) => void
) {
  const inHistoryRef = useRef(false);

  const historyPrev = useDashboardStore(s => s.historyPrev);
  const historyNext = useDashboardStore(s => s.historyNext);
  const historyResetCursor = useDashboardStore(s => s.historyResetCursor);
  const pushHistoryEntry = useDashboardStore(s => s.pushHistoryEntry);

  const onKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
      if (!sessionKey) return;
      const ta = event.currentTarget;

      if (event.key === 'ArrowUp') {
        if (!inHistoryRef.current) {
          // Only trigger if cursor is at the very start and no selection.
          if (ta.selectionStart !== 0 || ta.selectionEnd !== 0) return;
        }
        event.preventDefault();
        const text = historyPrev(sessionKey, getDraft());
        if (text !== null) {
          inHistoryRef.current = true;
          setDraft(text);
          // Cursor at end after restore.
          requestAnimationFrame(() => {
            ta.selectionStart = ta.selectionEnd = text.length;
          });
        }
        return;
      }

      if (event.key === 'ArrowDown') {
        if (!inHistoryRef.current) return; // only intercept in history mode
        event.preventDefault();
        const text = historyNext(sessionKey);
        if (text !== null) {
          setDraft(text);
          requestAnimationFrame(() => {
            ta.selectionStart = ta.selectionEnd = text.length;
          });
          if (text === '' || text === getDraft()) {
            inHistoryRef.current = false;
          }
        }
        return;
      }

      if (event.key === 'Escape' && inHistoryRef.current) {
        event.preventDefault();
        historyResetCursor(sessionKey);
        inHistoryRef.current = false;
      }
    },
    [sessionKey, getDraft, setDraft, historyPrev, historyNext, historyResetCursor]
  );

  const onBeforeSend = useCallback(
    (text: string) => {
      if (!sessionKey) return;
      pushHistoryEntry(sessionKey, text);
      inHistoryRef.current = false;
    },
    [sessionKey, pushHistoryEntry]
  );

  return { onKeyDown, onBeforeSend };
}
```

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src/hooks/useInputHistory.ts
git commit -m "feat(chat): useInputHistory hook for up/down navigation"
```

---

## Task 6: Wire `useInputHistory` into `ChatView` textarea

**Files:**
- Modify: `src/components/views/ChatView.tsx` — textarea section (~lines 498-625) and `handleSend` (~lines 370-386)

- [ ] **Step 1: Locate the textarea and handleSend**

Run: `grep -n "textarea\|handleSend\|inputRef" src/components/views/ChatView.tsx | head -30`

Identify:
- The draft state (likely `const [input, setInput] = useState('')`).
- The textarea element with `ref={inputRef}`.
- The `handleSend` function that calls `sendMessage(input)`.

- [ ] **Step 2: Import the hook**

Near the top of `ChatView.tsx`, add:

```ts
import { useInputHistory } from '../../hooks/useInputHistory';
```

- [ ] **Step 3: Instantiate the hook**

Inside the `ChatView` function, after `selectedSessionKey` / `effectiveKey` is resolved and after the `input` state is declared:

```ts
const { onKeyDown: onHistoryKeyDown, onBeforeSend: onHistoryBeforeSend } =
  useInputHistory(
    effectiveKey ?? null,
    () => input,
    (text) => setInput(text)
  );
```

(Use `effectiveKey` — the resolved session key Silos uses — not the raw prop.)

- [ ] **Step 4: Compose `onKeyDown` on the textarea**

Find the textarea's `onKeyDown`. It almost certainly looks like:

```tsx
onKeyDown={(e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    handleSend();
  }
}}
```

Wrap so that history intercepts first; Enter-to-send remains:

```tsx
onKeyDown={(e) => {
  onHistoryKeyDown(e);
  if (e.defaultPrevented) return;
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    handleSend();
  }
}}
```

- [ ] **Step 5: Push history on send**

In `handleSend`, before clearing the input:

```ts
const handleSend = () => {
  const text = input.trim();
  if (!text) return;
  // Stop-command shortcut interception stays as-is.
  if (/* existing stop detection */) { abortChat(...); setInput(''); return; }

  onHistoryBeforeSend(text);   // NEW
  sendMessage(text);
  setInput('');
};
```

Place the `onHistoryBeforeSend(text)` after the stop-command guard but before `sendMessage`. It's idempotent per session and cheap.

- [ ] **Step 6: Build and manually test**

```bash
npm run build
npm run dev
```

Open the dashboard in a browser. In a chat:
- Send a message "one".
- Send a message "two".
- Move cursor to the start of the empty textarea, press ↑ → shows "two".
- Press ↑ again → "one".
- Press ↓ → "two".
- Press ↓ → "" (live draft).
- Press Esc while navigating → returns to live draft.

- [ ] **Step 7: Commit**

```bash
git add src/components/views/ChatView.tsx
git commit -m "feat(chat): wire input history up/down arrows into textarea"
```

---

## Task 7: Persist `selectedSessionKey` on reload

**Files:**
- Modify: `src/store/dashboard-store.ts` (partialize + onRehydrate)
- Modify: `src/store/slices/session-slice.ts` (guard so history reloads after rehydrate)

- [ ] **Step 1: Extend `partialize`**

In `src/store/dashboard-store.ts`, current partialize:

```ts
partialize: (state) => ({
  gatewayUrl: state.gatewayUrl,
  token: state.token,
  darkMode: state.darkMode,
  theme: state.theme,
}),
```

Change to:

```ts
partialize: (state) => ({
  gatewayUrl: state.gatewayUrl,
  token: state.token,
  darkMode: state.darkMode,
  theme: state.theme,
  selectedSessionKey: state.selectedSessionKey,
}),
```

- [ ] **Step 2: Re-load history after rehydrate**

Extend `onRehydrateStorage`:

```ts
onRehydrateStorage: () => (rehydratedState) => {
  useDashboardStore.setState({ _hydrated: true });
  const key = rehydratedState?.selectedSessionKey;
  if (key) {
    // Re-select triggers loadChatHistory; wait until client is connected.
    // selectSession already no-ops if key matches current, which it won't post-rehydrate.
    // We trigger after a microtask to let the connection slice init.
    queueMicrotask(() => {
      const store = useDashboardStore.getState();
      if (store.client) {
        store.loadChatHistory(key);
      } else {
        // If client not yet ready, leave selectedSessionKey as-is — the connection
        // slice's hello/open handler will see it and trigger load.
      }
    });
  }
},
```

(If connection slice already watches for `selectedSessionKey` and loads on connect, this is redundant — audit by reading `connection-slice.ts`. If it doesn't, the hook above works as a bridge.)

- [ ] **Step 3: Audit `connection-slice.ts`**

Run: `grep -n "loadChatHistory\|selectedSessionKey" src/store/slices/connection-slice.ts`

If already auto-loads on connect when `selectedSessionKey` is set: remove the microtask hook in Step 2 — just keep the partialize change. The slice will handle it.

If it doesn't: keep the microtask hook as-is.

- [ ] **Step 4: Guard `selectSession(null)` on first render**

Scan `ChatView.tsx` for any `selectSession(null)` or `selectSession(undefined)` calls on mount/unmount. If found, guard so they don't clobber a rehydrated value. Typical pattern to watch for:

```tsx
useEffect(() => {
  return () => selectSession(null);
}, []);
```

If present and correct (only on unmount, not on mount), leave it.

- [ ] **Step 5: Build and manually test**

```bash
npm run build
npm run dev
```

Open dashboard, select a session, refresh page. Session should remain selected and history should reload.

- [ ] **Step 6: Commit**

```bash
git add src/store/dashboard-store.ts src/store/slices/session-slice.ts
git commit -m "feat(session): persist selectedSessionKey across reloads"
```

---

## Task 8: Version bump and full build

**Files:**
- Modify: `package.json` (patch bump: 2.23.0 → 2.23.1)

- [ ] **Step 1: Bump version**

```bash
npm version patch --no-git-tag-version
```

- [ ] **Step 2: Full clean build**

```bash
npm run build
```

Expected: no errors, no warnings that weren't there before.

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: bump version to 2.23.1"
```

---

## Task 9: Manual QA checklist

Run `npm run dev` and verify each acceptance bullet:

- [ ] Persisted session: refresh the browser → previously selected session still selected, history reloads automatically.
- [ ] Input history: ↑ from empty/start-of-line cycles through last-sent messages for the current session only; ↓ returns toward live draft; Esc cancels history mode.
- [ ] Dedup: sending the same text twice in a row does not duplicate the history entry.
- [ ] LS hygiene: open DevTools → Application → LocalStorage → confirm keys `silos:history:<sessionKey>` exist and cap at 50 entries.
- [ ] Phase filter: if an assistant message has commentary + final_answer signatures in gateway, only final_answer is shown. (Legacy messages without signatures render unchanged.)
- [ ] No regressions:
  - [ ] Sending a message still works.
  - [ ] Streaming deltas still render.
  - [ ] Queue badge (ActivityBar) still appears when sending rapid messages.
  - [ ] Rate-limit error still shows `__provider_error__…` with 30 s lockout.
  - [ ] Context utilization bar still renders with token data.
  - [ ] HeartbeatPanel/IdentityPanel/DreamsPanel still mount from agent panel trigger.
  - [ ] Pipeline/Tools/Errors/Latency tabs still work.

---

## Rollback

If any task breaks the chat, `git revert <commit-sha>` the offending commit. All tasks are independent except:
- Task 3 depends on Tasks 1–2 (needs `extractAssistantTextForPhase`).
- Task 5 depends on Task 4 (hook uses slice).
- Task 6 depends on Task 5 (textarea uses hook).
- Task 7 is independent.

No data migrations; no external effects. Revert is safe.

## Next phase

On completion, write `docs/superpowers/plans/2026-04-18-chat-phase2-content-blocks.md` per the parent spec's Phase 2 section. Phase 2 is the foundational refactor — canonical content blocks + message grouping + tool cards. Plan it from current-state verification, not from assumptions written today.
