# Chat Phase 4 — Pinned + Deleted + Search + Export + Toasts

**Goal:** Conversation polish. User can pin/unpin/soft-delete messages, search in-chat (Ctrl/Cmd+F), export to markdown, and see compaction/fallback toasts when the gateway retries.

**Out of scope:** server-side storage of pinned/deleted (Phase 5+).

## File manifest

**Create:**
- `src/store/slices/pinned-slice.ts` — `Map<sessionKey, Map<messageId, PinnedEntry>>`, LS-backed, actions `togglePinned(sessionKey, messageId, note?)`, `isPinned(sessionKey, messageId)`, `listPinned(sessionKey)`.
- `src/store/slices/deleted-slice.ts` — `Map<sessionKey, Set<messageId>>`, LS-backed, actions `toggleDeleted`, `isDeleted`.
- `src/components/chat/PinnedHeader.tsx` — collapsible header bar with pinned count + preview of first 2.
- `src/components/chat/MessageActions.tsx` — small floating action bar (pin / delete / copy / export-single), shown on hover over a message bubble. Uses a portal-free absolute overlay.
- `src/components/chat/SearchBar.tsx` — Ctrl/Cmd+F overlay with input, next/prev, match count.
- `src/components/chat/ChatToasts.tsx` — stacked toasts for `compactionStatus` / `fallbackStatus`.
- `src/lib/chat-export.ts` — `exportChatToMarkdown(messages, sessionKey): string`.
- `src/lib/search-match.ts` — case-insensitive substring match + simple highlighting.

**Modify:**
- `src/types/openclaw.ts` — add `PinnedEntry { messageId, pinnedAt, note? }`, extend `TelemetrySlice` fields (compactionStatus, fallbackStatus — partial types).
- `src/store/store-types.ts` — add new slice members.
- `src/store/dashboard-store.ts` — register slices.
- `src/store/slices/ui-slice.ts` — add `chatSearchOpen`, `chatSearchQuery`, `chatShowDeleted` flags.
- `src/store/chat-event-handlers.ts` — populate compactionStatus / fallbackStatus from gateway events (best-effort; may be no-op until gateway emits them).
- `src/components/chat/MessageBubble.tsx` — mount `MessageActions` overlay on hover for non-inter-session messages.
- `src/components/views/ChatView.tsx` — mount `PinnedHeader`, `SearchBar`, `ChatToasts`, hide deleted messages from `filteredMessages`, Ctrl/Cmd+F keybind.

## Architectural decisions

**D1 — LS keys:** `silos:pinned:<sessionKey>` stores JSON `{messageId: {pinnedAt, note}}`. `silos:deleted:<sessionKey>` stores JSON `string[]` of messageIds. Matches Phase 1 history LS pattern.

**D2 — Soft delete:** hidden from the main list but NOT wiped from the store. `show deleted` toggle surfaces them with a dimmed style + Restore action. Never delete server-side.

**D3 — Pinned note:** optional `note?: string` on `PinnedEntry` — this beats control-UI (which only has a pin flag). Entered via simple inline prompt when pinning from MessageActions.

**D4 — Search:** case-insensitive substring match on the rendered text view (`message.content` for now; extend to contentBlocks in Phase 5). Next/prev navigates through matches, scrolls matched message into view, briefly highlights with a yellow ring.

**D5 — Export:** produces markdown with per-message sections. Role as header, timestamp in subheader, content verbatim. Skips deleted messages. Copy-to-clipboard + download-as-`.md` file.

**D6 — Toasts:** stack in the bottom-right. Compaction = yellow spinner toast ("Compacting session..."). Fallback = blue toast with per-attempt model name ("Trying fallback: gpt-4o-mini"). Auto-dismiss after 4s unless `phase === 'retrying'` (sticky until status changes).

**D7 — MessageActions overlay:** absolute positioned at top-right of message bubble, opacity-0 → opacity-100 on group-hover. Small icon buttons: `Pin` / `Trash2` / `Copy` / `Download`. All aria-labeled.

**D8 — LS cleanup:** when `deleteSession` runs in session-slice, also purge `silos:pinned:<key>` + `silos:deleted:<key>` (extend the Phase 1 LS cleanup we already added).

## Build verification pattern

Every task:
```bash
npm run build 2>&1 | grep -E "error TS" | grep -v -E "DreamsPanel|HeartbeatPanel|IdentityPanel" | head
npm run test:run
```
Both empty / green.

---

## Task list (6 tasks)

### Task 1 — Pinned + Deleted slices + LS cleanup
**Files:** pinned-slice.ts, deleted-slice.ts, types/openclaw.ts (PinnedEntry), store-types.ts, dashboard-store.ts, session-slice.ts (extend deleteSession LS cleanup).

### Task 2 — PinnedHeader + MessageActions + MessageBubble wiring
**Files:** PinnedHeader.tsx, MessageActions.tsx, MessageBubble.tsx (mount hover overlay on non-inter-session path).

### Task 3 — Deleted filter + show/hide toggle
**Files:** ui-slice.ts (add `chatShowDeleted`), ChatView.tsx (filter out isDeleted messages from filteredMessages, show/hide toggle button in header).

### Task 4 — In-chat search (SearchBar + keybind + highlight)
**Files:** search-match.ts (helper), SearchBar.tsx, ui-slice.ts (chatSearchOpen, chatSearchQuery), ChatView.tsx (Ctrl/Cmd+F keybind, mount SearchBar, apply match filter).

### Task 5 — Export to markdown
**Files:** chat-export.ts, ExportDialog.tsx (or inline popover), ChatView.tsx (header button).

### Task 6 — Toasts + compaction/fallback telemetry + version bump 2.26.0
**Files:** ChatToasts.tsx, types/openclaw.ts (CompactionStatus, FallbackStatus), telemetry-slice.ts (add status fields), chat-event-handlers.ts (populate when gateway emits), ChatView.tsx (mount), package.json bump, push.
