// src/store/slices/pinned-slice.ts
//
// Per-session pinned messages, LS-backed at silos:pinned:<sessionKey>.
// Schema on disk: Record<messageId, { pinnedAt: number; note?: string }>.

import type { PinnedEntry } from '../../types/openclaw';
import type { StoreSet, StoreGet } from '../store-types';

const LS_PREFIX = 'silos:pinned:';

function lsKey(sessionKey: string): string {
  return `${LS_PREFIX}${sessionKey}`;
}

function loadForSession(sessionKey: string): Map<string, PinnedEntry> {
  try {
    const raw = localStorage.getItem(lsKey(sessionKey));
    if (!raw) return new Map();
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return new Map();
    const out = new Map<string, PinnedEntry>();
    for (const [id, value] of Object.entries(parsed)) {
      if (!value || typeof value !== 'object') continue;
      const v = value as Record<string, unknown>;
      if (typeof v.pinnedAt !== 'number') continue;
      out.set(id, {
        messageId: id,
        pinnedAt: v.pinnedAt,
        ...(typeof v.note === 'string' ? { note: v.note } : {}),
      });
    }
    return out;
  } catch {
    return new Map();
  }
}

function saveForSession(sessionKey: string, entries: Map<string, PinnedEntry>): void {
  try {
    const obj: Record<string, { pinnedAt: number; note?: string }> = {};
    for (const [id, e] of entries) {
      obj[id] = e.note !== undefined
        ? { pinnedAt: e.pinnedAt, note: e.note }
        : { pinnedAt: e.pinnedAt };
    }
    if (Object.keys(obj).length === 0) {
      localStorage.removeItem(lsKey(sessionKey));
    } else {
      localStorage.setItem(lsKey(sessionKey), JSON.stringify(obj));
    }
  } catch { /* quota — silent */ }
}

export interface PinnedSlice {
  pinnedBySession: Map<string, Map<string, PinnedEntry>>;
  togglePinned: (sessionKey: string, messageId: string, note?: string) => void;
  setPinnedNote: (sessionKey: string, messageId: string, note: string | undefined) => void;
  isPinned: (sessionKey: string, messageId: string) => boolean;
  listPinned: (sessionKey: string) => PinnedEntry[];
  clearPinnedForSession: (sessionKey: string) => void;
}

export function createPinnedSlice(set: StoreSet, get: StoreGet): PinnedSlice {
  return {
    pinnedBySession: new Map<string, Map<string, PinnedEntry>>(),

    togglePinned: (sessionKey, messageId, note) => {
      const next = new Map(get().pinnedBySession);
      let entries = next.get(sessionKey);
      if (!entries) {
        entries = loadForSession(sessionKey);
      }
      const nextEntries = new Map(entries);
      if (nextEntries.has(messageId)) {
        nextEntries.delete(messageId);
      } else {
        const entry: PinnedEntry = { messageId, pinnedAt: Date.now() };
        if (note !== undefined) entry.note = note;
        nextEntries.set(messageId, entry);
      }
      next.set(sessionKey, nextEntries);
      saveForSession(sessionKey, nextEntries);
      set({ pinnedBySession: next });
    },

    setPinnedNote: (sessionKey, messageId, note) => {
      const next = new Map(get().pinnedBySession);
      let entries = next.get(sessionKey);
      if (!entries) entries = loadForSession(sessionKey);
      const current = entries.get(messageId);
      if (!current) return;
      const nextEntries = new Map(entries);
      const entry: PinnedEntry = { messageId, pinnedAt: current.pinnedAt };
      if (note !== undefined && note.trim().length > 0) entry.note = note;
      nextEntries.set(messageId, entry);
      next.set(sessionKey, nextEntries);
      saveForSession(sessionKey, nextEntries);
      set({ pinnedBySession: next });
    },

    isPinned: (sessionKey, messageId) => {
      const mem = get().pinnedBySession.get(sessionKey);
      if (mem) return mem.has(messageId);
      return loadForSession(sessionKey).has(messageId);
    },

    listPinned: (sessionKey) => {
      const mem = get().pinnedBySession.get(sessionKey);
      const entries = mem ?? loadForSession(sessionKey);
      return [...entries.values()].sort((a, b) => a.pinnedAt - b.pinnedAt);
    },

    clearPinnedForSession: (sessionKey) => {
      const next = new Map(get().pinnedBySession);
      next.delete(sessionKey);
      try { localStorage.removeItem(lsKey(sessionKey)); } catch { /* ignore */ }
      set({ pinnedBySession: next });
    },
  };
}
