import { useState, useEffect, useRef } from 'react';
import { Monitor, X, Maximize2, Minimize2, RefreshCw, ExternalLink } from 'lucide-react';
import { cn } from '../../lib/utils';
import { useDashboardStore } from '../../store/dashboard-store';

interface BrowserPanelProps {
  open: boolean;
  onClose: () => void;
}

function buildNoVncUrl(opts: { password?: string; resize?: boolean } = {}) {
  // In dev, noVNC is on port 6080 directly; in prod, through /browser/ on same origin
  const isDev = window.location.port === '3001' || window.location.port === '3002';
  const baseUrl = isDev
    ? `http://${window.location.hostname}:6080`
    : `${window.location.origin}/browser`;

  const params = new URLSearchParams();
  params.set('autoconnect', 'true');
  params.set('resize', opts.resize ? 'remote' : 'scale');
  if (opts.password) params.set('password', opts.password);

  // In production, pass gateway token for auth
  if (!isDev) {
    const token = useDashboardStore.getState().token;
    if (token) {
      params.set('token', token);
      // Tell noVNC to use the proxied WebSocket path with token
      params.set('path', `browser/websockify?token=${token}`);
    }
  }

  return `${baseUrl}/browser.html?${params.toString()}`;
}

export function BrowserPanel({ open, onClose }: BrowserPanelProps) {
  const [expanded, setExpanded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [vncPassword] = useState('abc123'); // TODO: read from config

  useEffect(() => {
    if (open) {
      setLoading(true);
      setError(false);
    }
  }, [open]);

  if (!open) return null;

  const url = buildNoVncUrl({ password: vncPassword, resize: true });

  return (
    <div
      className={cn(
        "flex flex-col border-l border-border bg-background transition-all duration-300 ease-in-out",
        expanded ? "w-[70vw]" : "w-[480px]"
      )}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-border bg-card/50">
        <div className="flex items-center gap-2">
          <Monitor className="w-4 h-4 text-muted-foreground" />
          <span className="text-xs font-semibold text-foreground">Remote Browser</span>
          {loading && (
            <div className="w-3 h-3 border-2 border-purple-500 border-t-transparent rounded-full animate-spin" />
          )}
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => {
              setLoading(true);
              setError(false);
              if (iframeRef.current) {
                iframeRef.current.src = url;
              }
            }}
            className="w-6 h-6 rounded flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
            title="Reconnect"
          >
            <RefreshCw className="w-3 h-3" />
          </button>
          <button
            onClick={() => window.open(url, '_blank')}
            className="w-6 h-6 rounded flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
            title="Open in new tab"
          >
            <ExternalLink className="w-3 h-3" />
          </button>
          <button
            onClick={() => setExpanded(!expanded)}
            className="w-6 h-6 rounded flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
            title={expanded ? 'Collapse' : 'Expand'}
          >
            {expanded ? <Minimize2 className="w-3 h-3" /> : <Maximize2 className="w-3 h-3" />}
          </button>
          <button
            onClick={onClose}
            className="w-6 h-6 rounded flex items-center justify-center text-muted-foreground hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-500/10 transition-colors"
            title="Close"
          >
            <X className="w-3 h-3" />
          </button>
        </div>
      </div>

      {/* Browser iframe */}
      <div className="flex-1 relative bg-black">
        {error ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-muted-foreground">
            <Monitor className="w-8 h-8 opacity-40" />
            <p className="text-sm">Browser not available</p>
            <button
              onClick={() => {
                setError(false);
                setLoading(true);
                if (iframeRef.current) iframeRef.current.src = url;
              }}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-muted hover:bg-accent transition-colors"
            >
              <RefreshCw className="w-3 h-3" /> Retry
            </button>
          </div>
        ) : (
          <iframe
            ref={iframeRef}
            src={url}
            className="w-full h-full border-0"
            onLoad={() => setLoading(false)}
            onError={() => { setLoading(false); setError(true); }}
            allow="clipboard-read; clipboard-write"
          />
        )}
      </div>
    </div>
  );
}
