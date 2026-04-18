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
