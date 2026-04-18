# Chat Phase 3 — Image Attachments Plan

> REQUIRED SUB-SKILL: superpowers:subagent-driven-development.

**Goal:** End-to-end image attachments. User can drag-drop, paste, or pick an image; sees a thumbnail; on send, image flows to the gateway as a canonical `{type:'image', source:{type:'base64', ...}}` content block alongside the text.

**Architecture:** Additive. New `attachmentsSlice` (draft state), new `AttachmentInput` + `AttachmentPreview` components, extend `gateway-client.sendChat` to accept attachments and serialize them into the content-blocks payload the gateway already accepts.

**Parent design:** `docs/superpowers/specs/2026-04-18-chat-control-ui-parity-design.md`.

**Out of scope:** non-image attachments (PDFs, video, audio). Only `image/*`.

---

## File Manifest

**Create:**
- `src/store/slices/attachments-slice.ts`
- `src/components/chat/AttachmentInput.tsx`
- `src/components/chat/AttachmentPreview.tsx`

**Modify:**
- `src/types/openclaw.ts` — add `ChatAttachment`.
- `src/store/store-types.ts` — add 5 slice members.
- `src/store/dashboard-store.ts` — register slice.
- `src/lib/gateway-client.ts` — extend `sendChat` to accept attachments.
- `src/store/slices/chat-slice.ts` — extend `sendMessage` + the queue path.
- `src/components/views/ChatView.tsx` — mount components + wire onSend.

## Architectural decisions

**D1 — Image-only.** `accept="image/*"` on the input, MIME check on paste/drop. Reject others silently.

**D2 — 5 MB max per image.** Reject larger; show inline error near preview.

**D3 — Base64 data-URLs only.** No server-side upload endpoint. Gateway accepts inline base64 in `{type:'image', source:{type:'base64', mediaType, data}}`.

**D4 — Per-session draft.** `Map<sessionKey, ChatAttachment[]>` — switching sessions doesn't leak attachments.

**D5 — Clear on send.** After successful `sendChat`, remove session's draft. Keep on error (user can retry).

**D6 — Message payload transformation lives in `gateway-client`.** If caller passes `attachments`, sendChat sends `message` as a content-blocks array: `[{type:'text', text: message}, ...images]`. Otherwise, keeps today's `message: string` behavior.

## Key types

Add to `src/types/openclaw.ts`:
```ts
export interface ChatAttachment {
  id: string;
  dataUrl: string;      // Full base64 data URL, ready for <img src>.
  mimeType: string;     // 'image/*'.
  name?: string;        // Original filename (from file picker / drop).
  size?: number;        // Bytes.
}
```

## Build verification pattern

Every task ends with:
```bash
npm run build 2>&1 | grep -E "error TS" | grep -v -E "DreamsPanel|HeartbeatPanel|IdentityPanel" | head
npm run test:run
```
Both empty / green.

---

## Task 1: `ChatAttachment` type + `attachmentsSlice`

**Files:**
- Modify: `src/types/openclaw.ts` (add `ChatAttachment`).
- Create: `src/store/slices/attachments-slice.ts`.
- Modify: `src/store/store-types.ts` (add 5 members).
- Modify: `src/store/dashboard-store.ts` (register slice).

### Steps

1. Add `ChatAttachment` interface to `openclaw.ts` near the other chat types (anywhere below `ChatMessage`).

2. Create `src/store/slices/attachments-slice.ts`:

   ```ts
   // src/store/slices/attachments-slice.ts
   //
   // Per-session draft attachments. Images only. Cleared on successful send.
   // Max 5 MB per file; enforced when adding.

   import type { ChatAttachment } from '../../types/openclaw';
   import type { StoreSet, StoreGet } from '../store-types';

   export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
   const SUPPORTED_MIME = /^image\//;

   function randomId() {
     return `att-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
   }

   export function isSupportedAttachmentMime(mime: string): boolean {
     return SUPPORTED_MIME.test(mime);
   }

   export async function fileToAttachment(file: File): Promise<ChatAttachment | { error: string }> {
     if (!isSupportedAttachmentMime(file.type)) {
       return { error: 'Only image files are supported.' };
     }
     if (file.size > MAX_ATTACHMENT_BYTES) {
       return { error: `File too large (max ${Math.round(MAX_ATTACHMENT_BYTES / 1024 / 1024)} MB).` };
     }
     const dataUrl = await new Promise<string>((resolve, reject) => {
       const reader = new FileReader();
       reader.onload = () => resolve(String(reader.result ?? ''));
       reader.onerror = () => reject(new Error('Failed to read file.'));
       reader.readAsDataURL(file);
     });
     return {
       id: randomId(),
       dataUrl,
       mimeType: file.type,
       name: file.name,
       size: file.size,
     };
   }

   export interface AttachmentsSlice {
     draftAttachments: Map<string, ChatAttachment[]>;
     addDraftAttachment: (sessionKey: string, att: ChatAttachment) => void;
     removeDraftAttachment: (sessionKey: string, id: string) => void;
     clearDraftAttachments: (sessionKey: string) => void;
   }

   export function createAttachmentsSlice(set: StoreSet, get: StoreGet): AttachmentsSlice {
     return {
       draftAttachments: new Map<string, ChatAttachment[]>(),

       addDraftAttachment: (sessionKey, att) => {
         const next = new Map(get().draftAttachments);
         const cur = next.get(sessionKey) ?? [];
         next.set(sessionKey, [...cur, att]);
         set({ draftAttachments: next });
       },

       removeDraftAttachment: (sessionKey, id) => {
         const next = new Map(get().draftAttachments);
         const cur = next.get(sessionKey);
         if (!cur) return;
         const filtered = cur.filter((a) => a.id !== id);
         if (filtered.length === 0) {
           next.delete(sessionKey);
         } else {
           next.set(sessionKey, filtered);
         }
         set({ draftAttachments: next });
       },

       clearDraftAttachments: (sessionKey) => {
         if (!get().draftAttachments.has(sessionKey)) return;
         const next = new Map(get().draftAttachments);
         next.delete(sessionKey);
         set({ draftAttachments: next });
       },
     };
   }
   ```

3. Extend `DashboardStore` in `store-types.ts` with the 5 slice members (4 methods + the `draftAttachments` map). Place next to other chat state.

4. Register in `dashboard-store.ts` — import `createAttachmentsSlice` and spread alongside other slices.

5. Build + test:
   ```bash
   npm run build 2>&1 | grep -E "error TS" | grep -v -E "DreamsPanel|HeartbeatPanel|IdentityPanel" | head
   npm run test:run
   ```

6. Commit:
   ```bash
   git add src/types/openclaw.ts src/store/slices/attachments-slice.ts src/store/store-types.ts src/store/dashboard-store.ts
   git commit -m "feat(chat): ChatAttachment type + per-session attachments-slice"
   ```

---

## Task 2: `AttachmentPreview` component

**Files:**
- Create: `src/components/chat/AttachmentPreview.tsx`.

### Steps

1. Create the file:

   ```tsx
   // src/components/chat/AttachmentPreview.tsx
   import { X } from 'lucide-react';
   import { cn } from '../../lib/utils';
   import type { ChatAttachment } from '../../types/openclaw';

   interface AttachmentPreviewProps {
     attachments: ChatAttachment[];
     onRemove: (id: string) => void;
     className?: string;
   }

   export function AttachmentPreview({ attachments, onRemove, className }: AttachmentPreviewProps) {
     if (attachments.length === 0) return null;
     return (
       <div className={cn('flex flex-wrap gap-2 px-3 py-2 border-b border-border/50', className)}>
         {attachments.map((att) => (
           <div key={att.id} className="relative group">
             <img
               src={att.dataUrl}
               alt={att.name || 'attachment'}
               className="h-16 w-16 object-cover rounded-md border border-border/40"
             />
             <button
               type="button"
               onClick={() => onRemove(att.id)}
               className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-background border border-border shadow-sm flex items-center justify-center opacity-80 hover:opacity-100 hover:bg-red-500/10 hover:border-red-500/50 transition"
               aria-label={`Remove ${att.name || 'attachment'}`}
             >
               <X className="w-3 h-3" />
             </button>
             {att.size ? (
               <span className="absolute bottom-0.5 right-0.5 text-[9px] px-1 rounded bg-background/80 text-muted-foreground">
                 {(att.size / 1024).toFixed(0)} KB
               </span>
             ) : null}
           </div>
         ))}
       </div>
     );
   }
   ```

2. Build + commit:
   ```bash
   npm run build 2>&1 | grep -E "error TS" | grep -v -E "DreamsPanel|HeartbeatPanel|IdentityPanel" | head
   git add src/components/chat/AttachmentPreview.tsx
   git commit -m "feat(chat): AttachmentPreview thumbnail strip with remove button"
   ```

---

## Task 3: `AttachmentInput` component

**Files:**
- Create: `src/components/chat/AttachmentInput.tsx`.

### Steps

1. Create the file:

   ```tsx
   // src/components/chat/AttachmentInput.tsx
   import { useRef, useState, type ClipboardEvent, type DragEvent } from 'react';
   import { Paperclip } from 'lucide-react';
   import { cn } from '../../lib/utils';
   import { fileToAttachment, isSupportedAttachmentMime } from '../../store/slices/attachments-slice';
   import type { ChatAttachment } from '../../types/openclaw';

   interface AttachmentInputProps {
     onAdd: (att: ChatAttachment) => void;
     onError?: (err: string) => void;
     disabled?: boolean;
     /** Wraps its children in a drop-target; paste also listened on children container. */
     children?: React.ReactNode;
   }

   /**
    * Provides three entry points for adding image attachments:
    *   - File picker (button click opens hidden <input type="file">).
    *   - Drag-drop onto the children container.
    *   - Paste inside the children container (e.g. textarea).
    *
    * The component renders the paperclip button at the top-left of its children
    * wrapper and delegates drop/paste event handling to the wrapper.
    */
   export function AttachmentInput({ onAdd, onError, disabled, children }: AttachmentInputProps) {
     const inputRef = useRef<HTMLInputElement>(null);
     const [dragActive, setDragActive] = useState(false);

     const ingestFile = async (file: File) => {
       const res = await fileToAttachment(file);
       if ('error' in res) {
         onError?.(res.error);
         return;
       }
       onAdd(res);
     };

     const onFiles = async (files: FileList | null) => {
       if (!files) return;
       for (const f of Array.from(files)) {
         if (isSupportedAttachmentMime(f.type)) {
           await ingestFile(f);
         }
       }
     };

     const onDrop = (e: DragEvent) => {
       e.preventDefault();
       setDragActive(false);
       onFiles(e.dataTransfer?.files ?? null);
     };

     const onPaste = (e: ClipboardEvent) => {
       const items = e.clipboardData?.items;
       if (!items) return;
       for (const item of Array.from(items)) {
         if (item.kind === 'file' && isSupportedAttachmentMime(item.type)) {
           const file = item.getAsFile();
           if (file) {
             e.preventDefault();
             ingestFile(file);
           }
         }
       }
     };

     return (
       <div
         className={cn('relative', dragActive && 'ring-2 ring-primary/50 ring-offset-2 rounded-md')}
         onDragEnter={(e) => { e.preventDefault(); setDragActive(true); }}
         onDragOver={(e) => e.preventDefault()}
         onDragLeave={() => setDragActive(false)}
         onDrop={onDrop}
         onPaste={onPaste}
       >
         {children}
         <input
           ref={inputRef}
           type="file"
           accept="image/*"
           multiple
           hidden
           onChange={(e) => {
             onFiles(e.target.files);
             e.target.value = '';
           }}
           disabled={disabled}
         />
         <button
           type="button"
           onClick={() => inputRef.current?.click()}
           disabled={disabled}
           className="absolute left-2 top-2 text-muted-foreground hover:text-foreground transition p-1 disabled:opacity-50"
           aria-label="Attach image"
           title="Attach image"
         >
           <Paperclip className="w-4 h-4" />
         </button>
       </div>
     );
   }
   ```

2. Build + commit:
   ```bash
   npm run build 2>&1 | grep -E "error TS" | grep -v -E "DreamsPanel|HeartbeatPanel|IdentityPanel" | head
   git add src/components/chat/AttachmentInput.tsx
   git commit -m "feat(chat): AttachmentInput with file picker + drag-drop + paste"
   ```

---

## Task 4: Extend `gateway-client.sendChat` to accept attachments

**Files:**
- Modify: `src/lib/gateway-client.ts`.

### Steps

1. Find the current signature:
   ```ts
   async sendChat(sessionKey: string, message: string, opts?: { thinking?: string; idempotencyKey?: string }) { ... }
   ```

2. Extend `opts` to include `attachments?: ChatAttachment[]`. When present, build a content-blocks message:

   ```ts
   import type { ChatAttachment } from '../types/openclaw';
   // ... (existing imports; add ChatAttachment to the type-only import block if not already there)

   async sendChat(
     sessionKey: string,
     message: string,
     opts?: { thinking?: string; idempotencyKey?: string; attachments?: ChatAttachment[] },
   ) {
     const attachments = opts?.attachments ?? [];
     const payload: {
       sessionKey: string;
       message: string | Array<unknown>;
       idempotencyKey: string;
       thinking?: string;
     } = {
       sessionKey,
       message,
       idempotencyKey: opts?.idempotencyKey || `${Date.now()}-${Math.random().toString(36).slice(2)}`,
       thinking: opts?.thinking,
     };
     if (attachments.length > 0) {
       const blocks: unknown[] = [];
       const trimmed = message.trim();
       if (trimmed.length > 0) blocks.push({ type: 'text', text: message });
       for (const att of attachments) {
         // Strip the data URL prefix to get raw base64.
         const rawBase64 = att.dataUrl.replace(/^data:[^;]+;base64,/, '');
         blocks.push({
           type: 'image',
           source: { type: 'base64', media_type: att.mimeType, data: rawBase64 },
         });
       }
       payload.message = blocks;
     }
     return this.request<import('../types/openclaw').ChatSendResult>('chat.send', payload);
   }
   ```

   Gateway accepts both `message: string` and `message: Array<block>` — verified in `openclaw/src/gateway/server-methods/chat.ts` sanitize path.

3. Build + commit:
   ```bash
   npm run build 2>&1 | grep -E "error TS" | grep -v -E "DreamsPanel|HeartbeatPanel|IdentityPanel" | head
   git add src/lib/gateway-client.ts
   git commit -m "feat(chat): gateway-client.sendChat accepts image attachments"
   ```

---

## Task 5: `sendMessage` accepts attachments + clears draft

**Files:**
- Modify: `src/store/slices/chat-slice.ts`.

### Steps

1. Change `sendMessage` signature from `(message: string)` to `(message: string, attachments?: ChatAttachment[])`.

2. In the no-queue branch (`!isAlreadySending`):
   - Pass `attachments` to `client.sendChat(effectiveSessionKey, message, { idempotencyKey: messageId, attachments })`.
   - On success: call `get().clearDraftAttachments(selectedSessionKey)`.
   - On error: keep the draft (user can retry).

3. In the queue branch (`isAlreadySending`): keep current behavior (text-only). We don't support queueing-with-attachments in Phase 3 — attachments can't be sent later reliably from just a text id+text shape without expanding the queue type. Leave a `// TODO` comment noting this limitation.

4. Update `store-types.ts` to change the `sendMessage` signature.

5. Build + test:
   ```bash
   npm run build 2>&1 | grep -E "error TS" | grep -v -E "DreamsPanel|HeartbeatPanel|IdentityPanel" | head
   npm run test:run
   ```

6. Commit:
   ```bash
   git add src/store/slices/chat-slice.ts src/store/store-types.ts
   git commit -m "feat(chat): sendMessage accepts attachments, clears draft on success"
   ```

---

## Task 6: Wire `AttachmentInput` + `AttachmentPreview` into `ChatView`

**Files:**
- Modify: `src/components/views/ChatView.tsx`.

### Steps

1. Import the new components and the attachments-slice methods.

2. Locate the input area (form with textarea around line 511+).

3. Wrap the textarea with `<AttachmentInput>`. Render `<AttachmentPreview>` above it. Wire:
   - `onAdd`: `addDraftAttachment(effectiveKey, att)`.
   - `onError`: temporary inline toast OR a simple state error near preview (keep simple — use existing error store maybe).
   - Preview list reads from `draftAttachments.get(effectiveKey) ?? []`.
   - Remove button: `removeDraftAttachment(effectiveKey, id)`.

4. Update `handleSend` to pass attachments: `sendMessage(text, draftAttachments.get(effectiveKey))`.

5. Build + dev check:
   ```bash
   npm run build 2>&1 | grep -E "error TS" | grep -v -E "DreamsPanel|HeartbeatPanel|IdentityPanel" | head
   curl -sS -o /dev/null -w "HTTP %{http_code}\n" http://127.0.0.1:3001/ || true
   ```

6. Commit:
   ```bash
   git add src/components/views/ChatView.tsx
   git commit -m "feat(chat): wire AttachmentInput + AttachmentPreview into input area"
   ```

---

## Task 7: Version bump + manual QA

**Files:**
- Modify: `package.json`.

### Steps

1. Bump minor:
   ```bash
   npm version minor --no-git-tag-version  # 2.24.x → 2.25.0
   ```

2. Full build + test:
   ```bash
   npm run build 2>&1 | grep -E "error TS" | grep -v -E "DreamsPanel|HeartbeatPanel|IdentityPanel" | head
   npm run test:run
   ```

3. Commit + push:
   ```bash
   git add package.json package-lock.json
   git commit -m "chore: bump version to 2.25.0 (chat phase 3)"
   git push origin main
   ```

4. Manual QA checklist (user performs):
   - [ ] Paperclip button opens image picker; picked image appears as thumbnail above textarea.
   - [ ] Paste an image (Cmd+V from a screenshot) → thumbnail appears.
   - [ ] Drag-drop an image file onto the input → thumbnail appears.
   - [ ] Non-image files are silently rejected or show an error.
   - [ ] `> 5 MB` file is rejected.
   - [ ] Remove button (X) on thumbnail removes it from the draft.
   - [ ] Send message with 1-N images: preview clears, message appears in chat with images rendered via `MessageContent`.
   - [ ] No regressions: text-only messages still send fine; streaming still works; grouping still works.

---

## Rollback

Every task is a single-file or small-dir commit. Revert any by SHA. No data migrations; attachments live only in transient session state.
