import { useEffect, useRef, useCallback } from 'react';

/**
 * Visibility-aware polling hook. Calls `callback` every `intervalMs`
 * only when the document is visible AND `enabled` is true.
 * Pauses when tab is hidden, resumes on focus.
 */
export function useAutoRefresh(
  callback: () => void | Promise<void>,
  intervalMs: number,
  enabled: boolean,
) {
  const callbackRef = useRef(callback);
  callbackRef.current = callback;

  const tick = useCallback(() => {
    if (document.visibilityState === 'visible') {
      callbackRef.current();
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;

    const id = setInterval(tick, intervalMs);

    const onVisChange = () => {
      if (document.visibilityState === 'visible') {
        callbackRef.current();
      }
    };
    document.addEventListener('visibilitychange', onVisChange);

    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVisChange);
    };
  }, [tick, intervalMs, enabled]);
}
