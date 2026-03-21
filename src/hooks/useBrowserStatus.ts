import { useState, useEffect } from 'react';

interface BrowserStatus {
  active: boolean;
  password?: string;
  since?: string;
}

export function useBrowserStatus(token: string | null, enabled: boolean): BrowserStatus {
  const [status, setStatus] = useState<BrowserStatus>({ active: false });

  useEffect(() => {
    if (!enabled || !token) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const res = await fetch('/api/browser/status', {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!cancelled && res.ok) setStatus(await res.json());
      } catch { /* ignore */ }
    };
    poll();
    const id = setInterval(poll, 5000);
    return () => { cancelled = true; clearInterval(id); };
  }, [token, enabled]);

  return status;
}
