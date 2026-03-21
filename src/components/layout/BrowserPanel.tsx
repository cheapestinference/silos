import { useState, useEffect, useRef } from 'react';
import { Monitor, X, RefreshCw, ExternalLink, PanelRightClose } from 'lucide-react';
import { cn } from '../../lib/utils';
import { buildNoVncUrl } from '../../lib/browser-utils';
import { useDashboardStore } from '../../store/dashboard-store';


interface BrowserPanelProps {
  /** When true, renders without outer chrome (border, min-width) for embedding in a tab container */
  embedded?: boolean;
}

export function BrowserPanel({ embedded }: BrowserPanelProps = {}) {
  const {
    browserPanelOpen,
    browserDetached,
    setBrowserPanelOpen,
    setBrowserDetached,
    token,
  } = useDashboardStore();

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [connected, setConnected] = useState(false);
  const iframeRef = useRef<HTMLIFrameElement>(null);

  const url = buildNoVncUrl(token, { password: 'abc123', resize: true });

  const maximized = useRef(false);

  useEffect(() => {
    if (browserPanelOpen) {
      setLoading(true);
      setError(false);
      // Maximize Chromium window via CDP (one-shot, idempotent)
      if (!maximized.current) {
        maximized.current = true;
        fetch('/api/browser/maximize', { method: 'POST', headers: { Authorization: `Bearer ${token}` } }).catch(() => {});
      }
    }
  }, [browserPanelOpen, token]);

  // Hide when not open or when detached (overlay/popout renders elsewhere)
  if (!browserPanelOpen || browserDetached !== 'none') return null;

  const handleRefresh = () => {
    setLoading(true);
    setError(false);
    if (iframeRef.current) iframeRef.current.src = url;
  };

  const handlePopout = () => {
    window.open(url, '_blank', 'width=1024,height=768');
    setBrowserDetached('popout');
  };

  const handleDetachOverlay = () => {
    setBrowserDetached('overlay');
  };

  return (
    <div className={cn(
      "flex flex-col bg-background h-full",
      !embedded && "border-l border-border min-w-[320px]"
    )}>
      {/* Header — compact toolbar with connection status */}
      <div className="flex items-center justify-between px-2 py-1 border-b border-border/50 bg-card/50 flex-shrink-0">
        <div className="flex items-center gap-1.5">
          <div className={cn("w-1.5 h-1.5 rounded-full", connected ? "bg-green-500" : "bg-red-500")} />
          {loading && (
            <div className="w-3 h-3 border-2 border-purple-500 border-t-transparent rounded-full animate-spin" />
          )}
        </div>
        <div className="flex items-center gap-0.5">
          <button onClick={handleRefresh} className="w-5 h-5 rounded flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted transition-colors" title="Refresh">
            <RefreshCw className="w-3 h-3" />
          </button>
          <button onClick={handleDetachOverlay} className="w-5 h-5 rounded flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted transition-colors" title="Detach to overlay">
            <PanelRightClose className="w-3 h-3" />
          </button>
          <button onClick={handlePopout} className="w-5 h-5 rounded flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted transition-colors" title="Pop out to window">
            <ExternalLink className="w-3 h-3" />
          </button>
          {!embedded && (
            <button onClick={() => setBrowserPanelOpen(false)} className="w-5 h-5 rounded flex items-center justify-center text-muted-foreground hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-500/10 transition-colors" title="Close">
              <X className="w-3 h-3" />
            </button>
          )}
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 relative bg-black min-h-0">
        {error ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-muted-foreground">
            <Monitor className="w-8 h-8 opacity-40" />
            <p className="text-sm">Browser not available</p>
            <button onClick={handleRefresh} className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-muted hover:bg-accent transition-colors">
              <RefreshCw className="w-3 h-3" /> Retry
            </button>
          </div>
        ) : (
          <iframe
            ref={iframeRef}
            src={url}
            className="w-full h-full border-0"
            onLoad={() => { setLoading(false); setConnected(true); }}
            onError={() => { setLoading(false); setError(true); setConnected(false); }}
            allow="clipboard-read; clipboard-write"
          />
        )}
      </div>

    </div>
  );
}
