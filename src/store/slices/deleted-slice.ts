// src/store/slices/deleted-slice.ts
//
// Per-session soft-deleted messageIds. LS-backed at silos:deleted:<sessionKey>.
// Schema on disk: string[] (array of messageIds).

import type { StoreSet, StoreGet } from '../store-types';

const LS_PREFIX = 'silos:deleted:';

function lsKey(sessionKey: string): string {
  return `${LS_PREFIX}${sessionKey}`;
}

function loadForSession(sessionKey: string): Set<string> {
  try {
    const raw = localStorage.getItem(lsKey(sessionKey));
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((v): v is string => typeof v === 'string'));
  } catch {
    return new Set();
  }
}

function saveForSession(sessionKey: string, ids: Set<string>): void {
  try {
    if (ids.size === 0) {
      localStorage.removeItem(lsKey(sessionKey));
    } else {
      localStorage.setItem(lsKey(sessionKey), JSON.stringify([...ids]));
    }
  } catch { /* quota — silent */ }
}

export interface DeletedSlice {
  deletedBySession: Map<string, Set<string>>;
  toggleDeleted: (sessionKey: string, messageId: string) => void;
  isDeleted: (sessionKey: string, messageId: string) => boolean;
  listDeleted: (sessionKey: string) => string[];
  clearDeletedForSession: (sessionKey: string) => void;
}

export function createDeletedSlice(set: StoreSet, get: StoreGet): DeletedSlice {
  return {
    deletedBySession: new Map<string, Set<string>>(),

    toggleDeleted: (sessionKey, messageId) => {
      const next = new Map(get().deletedBySession);
      let ids = next.get(sessionKey);
      if (!ids) ids = loadForSession(sessionKey);
      const nextIds = new Set(ids);
      if (nextIds.has(messageId)) nextIds.delete(messageId);
      else nextIds.add(messageId);
      next.set(sessionKey, nextIds);
      saveForSession(sessionKey, nextIds);
      set({ deletedBySession: next });
    },

    isDeleted: (sessionKey, messageId) => {
      const mem = get().deletedBySession.get(sessionKey);
      if (mem) return mem.has(messageId);
      return loadForSession(sessionKey).has(messageId);
    },

    listDeleted: (sessionKey) => {
      const mem = get().deletedBySession.get(sessionKey);
      const ids = mem ?? loadForSession(sessionKey);
      return [...ids];
    },

    clearDeletedForSession: (sessionKey) => {
      const next = new Map(get().deletedBySession);
      next.delete(sessionKey);
      try { localStorage.removeItem(lsKey(sessionKey)); } catch { /* ignore */ }
      set({ deletedBySession: next });
    },
  };
}
