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

export function createInputHistorySlice(set: StoreSet, get: StoreGet) {
  return {
    _inputHistoryDrafts: new Map<string, string>(),
    _inputHistoryCursors: new Map<string, number>(),

    pushHistoryEntry: (sessionKey: string, text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      const current = loadEntries(sessionKey);
      if (current[current.length - 1] === trimmed) {
        get().historyResetCursor(sessionKey);
        return;
      }
      const next = [...current, trimmed].slice(-MAX_ENTRIES);
      saveEntries(sessionKey, next);
      get().historyResetCursor(sessionKey);
    },

    historyPrev: (sessionKey: string, liveDraft: string): string | null => {
      const entries = loadEntries(sessionKey);
      if (entries.length === 0) return null;

      const cursors = new Map(get()._inputHistoryCursors);
      const drafts = new Map(get()._inputHistoryDrafts);
      let cursor = cursors.get(sessionKey) ?? -1;

      if (cursor === -1) {
        drafts.set(sessionKey, liveDraft);
      }
      cursor = Math.min(cursor + 1, entries.length - 1);
      cursors.set(sessionKey, cursor);
      set({ _inputHistoryCursors: cursors, _inputHistoryDrafts: drafts });
      return entries[entries.length - 1 - cursor];
    },

    historyNext: (sessionKey: string): string => {
      const entries = loadEntries(sessionKey);
      const cursors = new Map(get()._inputHistoryCursors);
      const drafts = new Map(get()._inputHistoryDrafts);
      let cursor = cursors.get(sessionKey) ?? -1;

      if (cursor <= 0) {
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

    historyResetCursor: (sessionKey: string) => {
      const cursors = new Map(get()._inputHistoryCursors);
      const drafts = new Map(get()._inputHistoryDrafts);
      if (!cursors.has(sessionKey) && !drafts.has(sessionKey)) return;
      cursors.delete(sessionKey);
      drafts.delete(sessionKey);
      set({ _inputHistoryCursors: cursors, _inputHistoryDrafts: drafts });
    },
  };
}
