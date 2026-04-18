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
