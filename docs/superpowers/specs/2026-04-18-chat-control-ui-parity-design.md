# Chat Control-UI Parity — Design Spec

> Master design doc for porting missing features from OpenClaw control-UI into Silos chat, while preserving Silos' operational strengths and raising UX to "perfect" bar.

## Overview

Silos' chat view is functional but thin compared to OpenClaw's control-UI. The control-UI has canonical content blocks, Slack-style message grouping, attachments, pinned/deleted messages, search, export, usage tab, compaction/fallback toasts, and an `extractTextCached` WeakMap caching layer. This spec defines how to absorb those features into Silos while keeping Silos' exclusive wins (HeartbeatPanel/IdentityPanel/DreamsPanel, Pipeline kanban, Errors/Latency telemetry, LaTeX unicode, JsonTree, FSM docs, context bar inline, cumulative tokens persisted).

**Explicitly out of scope** (per user directive):
- Slash commands — already/will be exposed as UI buttons with better UX.
- Speech (STT/TTS) — not wanted.
- Audio (`<audio>` rendering) — not needed.

## Goals

1. Match control-UI conversational polish: canonical content blocks, message grouping, tool cards, thinking, attachments (images only), pinned/deleted/search/export, usage tab, toasts.
2. Exceed control-UI where Silos can: keep all existing operational panels, add light virtualization for long chats, smoother state transitions, better tool diff rendering.
3. Zero regressions: existing chat flows keep working; new code is additive; backwards-compat for `ChatMessage.content: string` until all renderers migrate.

## Scope Check

Per superpowers:writing-plans scope rules, this spec spans multiple subsystems. It is **the umbrella design**; each phase ships as an independent plan that produces working, testable software on its own.

**Phase order** (each is a separate plan document):
1. `2026-04-18-chat-phase1-quick-wins.md` — `lastActiveSessionKey` persist, input history ↑↓, phase filtering, `extractTextCached` utility.
2. `2026-04-18-chat-phase2-content-blocks.md` — canonical content blocks, message grouping, tool cards (inline + sidebar), thinking blocks, vitest bootstrap.
3. `2026-04-18-chat-phase3-attachments.md` — image attachments end-to-end (draft → send → render).
4. `2026-04-18-chat-phase4-pinned-search-export-toasts.md` — pinned/deleted messages, in-chat search, export markdown, compaction/fallback toasts.
5. `2026-04-18-chat-phase5-usage-tab.md` — `/usage` route with sessions table, daily aggregates chart, time-series.

## Architecture Principles

**P1 — Additive, not destructive.** New features live in new slices/files/components; existing code modified minimally.

**P2 — Follow existing patterns.** One Zustand slice per feature domain (matches commit `79df0d7` decomposition). Stateless parsers in `src/lib/`. Components in `src/components/chat/`.

**P3 — Type-driven.** Define canonical types before touching UI. Port control-UI's `NormalizedMessage` and `ContentBlock` shapes into `src/types/openclaw.ts`.

**P4 — Backwards compatible through migration.** Keep `ChatMessage.content: string` populated until all renderers migrate to `contentBlocks`. Gradual cutover per phase.

**P5 — Preserve Silos wins.** Do not touch: HeartbeatPanel, IdentityPanel, DreamsPanel, Pipeline kanban, Cron panel, Browser panel, Workspace panel, Errors/Latency, LaTeX unicode, JsonTree auto-unwrap, `__provider_error__` rate-limit detection, FSM doc, context bar, cumulative tokens localStorage.

**P6 — UX first-class.** Every new component ships with: aria-labels, reduced-motion respect, keyboard navigation, sensible focus management, dark/light parity.

**P7 — No invented ceremony.** No fake rollback plans, no speculative abstractions. If a feature doesn't need a flag, don't add one. Deletion cleanups happen when migrations finish, not before.

## Type Model Changes

### New canonical types

Add to `src/types/openclaw.ts`:

```ts
export type AssistantPhase = 'commentary' | 'final_answer';

export type ContentBlock =
  | { type: 'text'; text: string; phase?: AssistantPhase }
  | { type: 'tool_call'; name: string; args?: unknown; toolCallId?: string }
  | { type: 'tool_result'; text: string; toolCallId?: string; isError?: boolean }
  | { type: 'thinking'; thinking: string; phase?: AssistantPhase }
  | { type: 'image'; source: ImageSource };

export type ImageSource =
  | { type: 'base64'; mediaType: string; data: string }
  | { type: 'url'; url: string };

export interface ChatAttachment {
  id: string;
  dataUrl: string;      // base64 data URL
  mimeType: string;     // image/* only
  name?: string;        // original filename
  size?: number;        // bytes
}

export interface ChatQueueItem {
  id: string;
  text: string;
  createdAt: number;
  attachments?: ChatAttachment[];
  pendingRunId?: string;
}

export interface PinnedEntry {
  messageId: string;
  pinnedAt: number;
  note?: string;        // Silos-only: user note on why pinned (beats control-UI)
}

export interface CompactionStatus {
  phase: 'active' | 'retrying';
  attemptIndex?: number;
}

export interface FallbackStatus {
  attempts: Array<{ model: string; reason?: string; ts: number }>;
  summaries: string[];
}
```

### Extended ChatMessage

```ts
export interface ChatMessage {
  // --- existing ---
  id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;                   // legacy, kept during migration
  timestamp: number;
  toolName?: string;
  toolCallId?: string;
  toolCall?: unknown;
  result?: unknown;
  runId?: string;
  stream?: string;
  status?: MessageStatus;

  // --- new (Phase 2) ---
  contentBlocks?: ContentBlock[];    // canonical, if present renderers prefer this
  phase?: AssistantPhase;            // assistant message phase
  senderLabel?: string | null;       // multi-party support (e.g., channel messages)
}
```

**Migration rule:** `contentBlocks` is optional. If present, new renderers use it; otherwise fall back to `content` string. `loadChatHistory` populates both during Phase 2.

### Queue shape migration

```ts
// Before
messageQueue: Map<string, Array<{ id: string; text: string }>>

// After (Phase 3, when attachments land — schema change is free before)
messageQueue: Map<string, ChatQueueItem[]>
```

Backwards compatible — new fields (`createdAt`, `attachments`, `pendingRunId`) are optional. Existing queue dispatch code reads `.id` and `.text` only; unchanged.

## File Map

### New files (by phase)

**Phase 1**
- `src/lib/message-extract.ts` — `extractTextCached`, `extractThinkingCached` with WeakMap.
- `src/lib/phase-filter.ts` — `extractAssistantTextForPhase`, legacy-signature-aware.
- `src/store/slices/input-history-slice.ts` — per-session up/down history (50 msgs max).
- `src/hooks/useInputHistory.ts` — textarea integration with ↑↓ keys and draft save.

**Phase 2**
- `src/lib/content-blocks.ts` — pure parsers: raw gateway message → `ContentBlock[]`, `extractTextFromBlocks`, `extractToolCards`, `extractImages`, `extractThinking`.
- `src/lib/message-normalizer.ts` — port control-UI's `normalizeMessage` (role detection, senderLabel, stripInboundMetadata integration).
- `src/components/chat/MessageContent.tsx` — renders `ContentBlock[]`; delegates to `ToolCard`, `ThinkingBlock`, markdown, images.
- `src/components/chat/MessageGroup.tsx` — Slack-style grouping (avatar + sender + messages + footer). Collapses consecutive same-role messages.
- `src/components/chat/ToolCard.tsx` — tool call/result card. Inline if output ≤ `TOOL_INLINE_THRESHOLD` (120 chars); otherwise collapsed with expand-to-sidebar action.
- `src/components/chat/ToolCardSidebar.tsx` — sidebar panel (right split) showing expanded tool card with copy/diff controls.
- `src/components/chat/ThinkingBlock.tsx` — collapsible thinking with subtle styling; respects `showReasoning` toggle.
- `src/components/chat/Divider.tsx` — date/session dividers in the message stream.
- `src/components/chat/ReadingIndicator.tsx` — three-dot indicator when stream is active but no text yet.
- `src/components/chat/VirtualMessageList.tsx` — lightweight virtualization wrapper (IntersectionObserver-based, no dep needed) for histories > 500 messages.

**Phase 3**
- `src/store/slices/attachments-slice.ts` — draft attachments (list + add + remove + clear).
- `src/components/chat/AttachmentInput.tsx` — drag-drop + file picker (image/* only); paste handling too.
- `src/components/chat/AttachmentPreview.tsx` — thumbnail strip with remove button.

**Phase 4**
- `src/lib/pinned-store.ts` — LS-backed per-session pinned map.
- `src/lib/deleted-store.ts` — LS-backed per-session deleted set.
- `src/lib/search-match.ts` — case-insensitive substring + fuzzy scoring.
- `src/lib/chat-export.ts` — ChatMessage[] → markdown string.
- `src/store/slices/pinned-slice.ts` — reactive wrapper over pinned-store.
- `src/store/slices/deleted-slice.ts` — reactive wrapper over deleted-store.
- `src/components/chat/PinnedHeader.tsx` — collapsible pinned summary bar.
- `src/components/chat/SearchBar.tsx` — inline search with match count + next/prev.
- `src/components/chat/ExportDialog.tsx` — export-to-markdown modal.
- `src/components/chat/ChatToasts.tsx` — toast stack for compaction/fallback.

**Phase 5**
- `src/lib/usage-api.ts` — gateway calls for session/daily/time-series usage.
- `src/store/slices/usage-slice.ts`.
- `src/components/views/UsageView.tsx` — page component.
- `src/components/usage/SessionUsageTable.tsx`.
- `src/components/usage/DailyChart.tsx` — recharts bar/line chart (recharts already a dep).
- `src/components/usage/TimeSeriesChart.tsx`.

### Modified files

**Phase 1**
- `src/store/slices/session-slice.ts` — no code change; partialize config change below.
- `src/store/dashboard-store.ts` — add `selectedSessionKey` to `partialize`; add rehydrate hook to re-load history.
- `src/store/slices/chat-slice.ts` — `loadChatHistory` uses `extractAssistantTextForPhase` for assistant messages.
- `src/components/views/ChatView.tsx` — wire `useInputHistory` into textarea's `onKeyDown`.

**Phase 2** (big refactor)
- `src/types/openclaw.ts` — add `ContentBlock`, `AssistantPhase`, `ChatAttachment`, `ChatQueueItem`, extend `ChatMessage`.
- `src/store/slices/chat-slice.ts` — `loadChatHistory` populates both `content` and `contentBlocks`; extracts phases.
- `src/store/chat-event-handlers.ts` — delta path supports `append` semantics for `contentBlocks[].text` updates.
- `src/components/chat/MessageBubble.tsx` — if `message.contentBlocks` present, delegate to `<MessageContent>`; else keep current renderers.
- `src/components/views/ChatView.tsx` — swap flat `filteredMessages.map` for `<MessageGroup>` iteration; add right-column `ToolCardSidebar` mount point.
- Deprecate (but keep) `src/components/chat/ToolCallExpander.tsx` — used as inline fallback until history renderers fully migrate.
- Add dev deps: `vitest`, `@testing-library/react`, `@testing-library/jest-dom`, `@testing-library/user-event`, `jsdom`. Add `vitest.config.ts` + `test` script.

**Phase 3**
- `src/lib/gateway-client.ts` — `sendChat` payload accepts `contentBlocks` array; keeps string overload for backwards compat.
- `src/store/slices/chat-slice.ts` — `sendMessage` signature: `(text: string, attachments?: ChatAttachment[])`.
- `src/components/views/ChatView.tsx` — mount `AttachmentInput` + `AttachmentPreview` in input area; wire paste and drag-drop.

**Phase 4**
- `src/store/slices/telemetry-slice.ts` — add `compactionStatus`, `fallbackStatus` fields.
- `src/store/chat-event-handlers.ts` — listen for `compaction` / `fallback` events if the gateway emits them; else set heuristically from existing signals (activity stale > 15s + no run completion).
- `src/components/views/ChatView.tsx` — mount `PinnedHeader`, `SearchBar`, `ChatToasts`; add "Export" to header menu.

**Phase 5**
- `src/App.tsx` (or router setup) — add `/usage` route.
- Navigation sidebar — add "Usage" link.

## State Architecture

### Existing slices (keep, extend only where noted)
- `connectionSlice` — no change.
- `dataLoadersSlice` — Phase 5: add `loadUsage`, `loadDailyUsage`, `loadSessionTimeSeries`.
- `sessionSlice` — no code change in Phase 1; `selectedSessionKey` persist via `partialize`.
- `chatSlice` — Phase 1: phase filtering. Phase 2: populate `contentBlocks`. Phase 3: `sendMessage` with attachments. Queue map shape migration.
- `cronSlice`, `taskSlice`, `filesSlice`, `uiSlice`, `eventSlice` — untouched.
- `telemetrySlice` — Phase 4: `compactionStatus`, `fallbackStatus`.

### New slices

| Slice | Phase | Scope |
|---|---|---|
| `inputHistorySlice` | 1 | `Map<sessionKey, string[]>` + navigation cursor, 50 msgs per session. |
| `attachmentsSlice` | 3 | `Map<sessionKey, ChatAttachment[]>` draft; add/remove/clear. |
| `pinnedSlice` | 4 | Reactive `Map<sessionKey, Map<messageId, PinnedEntry>>` backed by LS. |
| `deletedSlice` | 4 | Reactive `Map<sessionKey, Set<messageId>>` backed by LS. |
| `usageSlice` | 5 | Sessions table + daily aggregates + time-series. |

Total after all phases: **15 slices** (from 11).

### LocalStorage key convention

Existing:
- `silos-dashboard` — main persisted store (zustand persist)
- `silos:cumTokens` — cumulative tokens map
- `silos-chat-panel-width`, `silos-chat-tools-split`, `silos-chat-bottom-tab` — UI split prefs

New:
- `silos:history:<sessionKey>` — input history per session
- `silos:pinned:<sessionKey>` — pinned entries per session
- `silos:deleted:<sessionKey>` — deleted message IDs per session

All new keys use `silos:<feature>:<sessionKey>` pattern. Cleanup on `deleteSession`.

## Component Architecture

### Preserved components (no change)
`ActivityBar`, `AgentStatusDot`, `ChatView` (structure kept, internals changed), `CodeBlock`, `CompactSystemMessage`, `MessageAvatar`, `ToolsPanel`, `TypingIndicator`, and all agent panels (`HeartbeatPanel`, `IdentityPanel`, `DreamsPanel`).

### Rewritten (Phase 2)
- `MessageBubble.tsx` — becomes a thin switch: `if (message.contentBlocks) <MessageContent blocks={...} /> else <LegacyBubble />`.

### New (Phase 2+)
- `MessageGroup` → composes `MessageAvatar` + header (sender/timestamp) + multiple `MessageBubble` + footer.
- `MessageContent` → iterates `contentBlocks` and dispatches: text → markdown, tool_call/tool_result → `ToolCard`, thinking → `ThinkingBlock`, image → `<img>`.
- `ToolCard` → replaces `ToolCallExpander` over time. Inline if text ≤ 120 chars, else collapsed preview + "expand in sidebar" action.
- `ToolCardSidebar` → right-column panel showing full tool input/output with Copy, Diff (against previous call of same tool), and JsonTree views.
- `ThinkingBlock` → collapsible, subtle left border, italic muted text.
- `Divider`, `ReadingIndicator` → stream primitives.
- `VirtualMessageList` → IntersectionObserver-based; mounts only visible + buffer messages when list > 500.
- `AttachmentInput`, `AttachmentPreview` — Phase 3.
- `PinnedHeader`, `SearchBar`, `ExportDialog`, `ChatToasts` — Phase 4.
- `UsageView` + usage charts — Phase 5.

## Data Flow Changes

### Inbound (read path)

**Phase 1:** `loadChatHistory` runs `extractAssistantTextForPhase(message, 'final_answer')` when filling assistant `content`. Avoids showing commentary text that the gateway considers internal.

**Phase 2:** `loadChatHistory` additionally populates `contentBlocks` by calling `normalizeMessage` → `ContentBlock[]`. Delta handling in `chat-event-handlers.ts` still uses `streamingContent: string` for the typing indicator (unchanged), but on final, the stored message gets its `contentBlocks` populated from the final gateway payload.

Deltas remain **replace semantics** for the typing indicator (matches current behavior, already documented in `dashboard-store.ts:21-23`). Content blocks are only materialized on `final`.

### Outbound (send path)

**Phase 3:** `sendMessage(text, attachments?)` builds a content-block payload if attachments present:
```ts
contentBlocks = [
  { type: 'text', text },
  ...attachments.map(a => ({
    type: 'image',
    source: { type: 'base64', mediaType: a.mimeType, data: a.dataUrl }
  }))
]
client.sendChat(sessionKey, message /* or blocks */, { idempotencyKey, attachments })
```
The gateway client (`src/lib/gateway-client.ts`) is extended to accept `attachments` parameter that it serializes into the `chat.send` RPC params.

### UI render path

**Phase 2:** `ChatView` groups consecutive same-role messages into `MessageGroup` before render. Within a group, each message renders via `<MessageContent blocks={msg.contentBlocks} />`.

```
filteredMessages
  → groupByRoleAndTimeGap (MAX_GROUP_GAP_MS = 5 * 60 * 1000)
  → groups.map(<MessageGroup>)
    → group.messages.map(<MessageContent>)
      → blocks.map(switch on type)
```

## UX polish standards

These are non-negotiable for every new component:

1. **aria-labels** on all interactive elements (buttons, expandable regions, dialogs).
2. **Reduced motion** — `@media (prefers-reduced-motion: reduce)` disables transforms/fades. Use existing Tailwind `motion-safe:` utilities.
3. **Keyboard navigation** — Tab order sensible. Escape closes sidebars and dialogs. Arrow keys navigate search matches and history.
4. **Focus management** — Modal dialogs trap focus; on close, return to trigger. Textarea re-focus after send.
5. **Dark/light parity** — Every color token has a `dark:` variant. Use existing `zinc-*` + `emerald-*`/`amber-*`/`red-*` scale; no new colors.
6. **Empty states** — "No pinned messages", "No matches found", "No usage data yet" — helpful, not blank.
7. **Loading states** — Skeletons or dim-and-spin; never a blank screen > 100 ms.
8. **Error states** — Inline, recoverable, with retry where applicable. Reuse `SessionErrorsPanel` pattern.
9. **Smooth transitions** — `duration-200` + `ease-out` for toggles; no jumps between streaming → final.
10. **Touch targets** — min 36×36 px on clickable elements.

## Cross-phase contracts

Each phase promises these to subsequent phases. Breaking a promise = planning failure.

**From Phase 1:**
- `extractTextCached(message, phase?)` stable signature (message, optional phase string).
- `useInputHistory(sessionKey)` returns `{ onKeyDown, setDraft, clear }`.

**From Phase 2:**
- `ChatMessage.contentBlocks` present on ALL messages returned by `loadChatHistory`.
- `MessageContent`, `ToolCard`, `ThinkingBlock` public props stable.
- Messages without `contentBlocks` still render correctly via legacy path.
- `vitest` test runner installed; `npm test` runs all tests.

**From Phase 3:**
- `sendMessage(text, attachments?)` signature. Legacy `sendMessage(text)` keeps working.
- `ChatQueueItem` shape with optional `attachments` in the map.

**From Phase 4:**
- `pinnedSlice.isPinned(sessionKey, messageId) → boolean` and `togglePinned(sessionKey, messageId, note?)`.
- `deletedSlice.isDeleted`, `toggleDeleted`.
- Search query state lives in `uiSlice.chatSearchQuery`.
- Compaction/fallback toasts auto-dismiss after 4 s unless `phase === 'retrying'` (persistent until change).

**From Phase 5:**
- `/usage` route mounted.
- Navigation sidebar entry "Usage".
- `usageSlice.loadUsage()` idempotent, caches 30 s.

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| Phase 2 refactor breaks the current chat | Keep legacy `content` string and `MessageBubble` legacy branch. Migrate renderers one by one. |
| `contentBlocks` not populated for old persisted messages | Chat history always reloads from gateway on session select; persistence of `chatMessages` not enabled. Rehydrate clears messages. |
| Large histories (>1000 messages) slow | Phase 2 adds `VirtualMessageList`. Threshold 500. |
| LS quota for pinned/deleted/history | Per-session keys with aggressive pruning: history 50/session, pinned unbounded but max 200/session enforced, deleted unbounded but message IDs are short. |
| New deps bloat | Only `vitest`+testing-library in Phase 2. No chart lib needed (recharts is already present). |
| Tool stream throttle (control-UI has 80 ms) | Silos doesn't throttle today and it works. Skip until proven needed — don't over-engineer. |
| User confuses pinned with bookmarks | Name it "Pinned" consistently; icon: `Pin` from lucide. Add a tooltip "Pin for quick reference — your notes only". |

## Testing strategy

Silos currently has no test framework. Phase 2 introduces vitest (justified: content-block parsing is pure logic with many edge cases).

**Test organization:**
- Co-locate: `src/lib/foo.ts` → `src/lib/foo.test.ts`.
- Component tests (when added): `src/components/chat/Foo.test.tsx`.
- Setup: `vitest.config.ts` with `jsdom` environment for component tests.
- Fixtures: `src/test-fixtures/chat/` for sample gateway messages, borrowed from control-UI's browser tests as a reference.

**Coverage priorities** (what actually deserves tests):
1. Pure parsers: `content-blocks.ts`, `message-normalizer.ts`, `phase-filter.ts`, `search-match.ts`, `chat-export.ts`. High-value, low-cost.
2. Slice logic: `inputHistorySlice` navigation, `pinnedSlice`/`deletedSlice` LS persistence.
3. Complex components: `MessageContent` block dispatch, `ToolCard` inline-vs-sidebar decision, `VirtualMessageList` scroll math.

**Skipped on purpose:**
- Trivial components (`Divider`, `ReadingIndicator`).
- Styling.
- Integration tests (no browser-driver infra; manual QA per UX polish standards).

## Preserved Silos advantages (do not touch in any phase)

1. HeartbeatPanel, IdentityPanel, DreamsPanel — integrated side panels.
2. Pipeline kanban, Cron panel, Browser panel, Workspace panel — right column tabs.
3. Errors/Latency telemetry — bottom tabs.
4. LaTeX → Unicode mapping (`replaceInlineLatex`).
5. JsonTree auto-unwrap (commit `c02cc3b`).
6. `__provider_error__` rate-limit detection + 30 s lockout.
7. FSM doc (`docs/chat-state-machine.md`).
8. Context utilization bar inline in input.
9. Cumulative tokens persisted to `silos:cumTokens`.
10. `stripInboundMeta` canonical parser (commit `3164291`).
11. `isRecentlyActive` 15 s fallback (retire only when gateway emits compactionStatus).

## Beyond parity — where Silos can beat control-UI

- **PinnedEntry.note** — Silos pinned entries carry a user note ("why I pinned this"). Control-UI only has a flag.
- **ToolCard diff view** — when the same tool is called twice, show diff of args/result. Control-UI only shows raw.
- **VirtualMessageList** — lightweight visibility-based; control-UI has none.
- **JsonTree** for tool_result JSON — already shipping; fuse with `ToolCard` in Phase 2 so JSON responses auto-render as an expandable tree.
- **Context bar + cumulative tokens** — stays; control-UI doesn't have this inline.
- **Agent side panels** — Heartbeat/Identity/Dreams integrated; control-UI puts these in separate tabs.
- **Pipeline kanban alongside chat** — stays.
- **LaTeX inline** — stays.

## Execution order

1. Phase 1 — quick wins (low risk, unblocks muscle memory wins).
2. Phase 2 — canonical content blocks + message grouping + tool cards (big refactor, foundational for all downstream).
3. Phase 3 — attachments (depends on content blocks).
4. Phase 4 — pinned/search/export/toasts (depends on content blocks for search indexing).
5. Phase 5 — usage tab (independent of chat refactor; can run parallel to 4 if desired).

Each phase ends with:
- All tests green (Phase 2+).
- `npm run build` clean (strict tsc + Vite).
- Manual QA against the phase's acceptance checklist.
- Version bump + commit.

## Out of scope

- Slash commands — handled as buttons elsewhere.
- Speech / STT / TTS — not wanted.
- Audio block rendering — not wanted.
- Session-level cache LRU (`chat/session-cache.ts` in control-UI) — Silos' session selection already clears `chatMessages`; an LRU would add complexity without clear user benefit. Re-evaluate after Phase 5 if perceived-slowness of session switches becomes a complaint.
- Tool stream throttle (80 ms) — current replace-semantics works. Revisit only if rendering stutters with dense tool streams.
- Backwards compatibility for >1 release of transitional code — remove legacy `content` + legacy `MessageBubble` branch at Phase 2 end. Current user is sole user; no ecosystem to preserve.

## Acceptance per phase

**Phase 1 done when:**
- Reloading the dashboard restores the last active session.
- ↑/↓ in the chat textarea navigates the last 50 sent messages for that session.
- Assistant messages with phase `commentary` are filtered on history load.
- `extractTextCached(message)` returns same reference on repeated calls.
- `npm run build` passes.

**Phase 2 done when:**
- Every message has `contentBlocks` populated on history load.
- Messages display as Slack-style groups with shared avatar/timestamp.
- Tool calls render as inline cards (if small) or collapsed + sidebar (if large).
- Thinking blocks render collapsed with toggle.
- Virtual list activates above 500 messages.
- Vitest installed; `npm test` passes.
- `npm run build` passes.

**Phase 3 done when:**
- User can drag/drop or paste image into input; shows thumbnail.
- User can remove before sending.
- Sent message appears with image in the chat.
- Gateway receives `content: [{type:'text'}, {type:'image',...}]` payload.

**Phase 4 done when:**
- User can pin any message; pinned header shows count + preview.
- User can soft-delete a message; hidden from main view; visible in "show deleted" toggle.
- Ctrl/Cmd+F opens search bar; matches highlighted; next/prev navigates.
- Export button produces a markdown file with the visible (non-deleted) messages.
- Compaction/fallback toast appears during retries and dismisses on resume.

**Phase 5 done when:**
- `/usage` route renders.
- Table shows sessions sorted by total tokens.
- Daily aggregates chart covers last 30 days.
- Time-series chart shows cumulative and per-turn tokens for the selected session.
- All loading/error/empty states present.

---

*Plan documents for each phase in `docs/superpowers/plans/` implement these specs. Phase 1 plan is the first; others written at start of each phase with current-state verification.*
