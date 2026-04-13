import { useEffect, useState } from 'react';

/**
 * Re-renders the component every `intervalMs`. Useful for "live" displays like
 * relative time ("3s ago", "in 2m") that need to update without prop changes.
 *
 * Returns the current timestamp in milliseconds. Callers typically ignore the
 * return value and just use it as a re-render trigger.
 */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}
