import { useState, useRef, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { Monitor, X, RefreshCw, ExternalLink, PanelRightOpen, GripHorizontal } from 'lucide-react';
import { buildNoVncUrl } from '../../lib/browser-utils';
import { useDashboardStore } from '../../store/dashboard-store';
import { AgentStatusBar } from './AgentStatusBar';

export function FloatingBrowserPanel() {
  const {
    browserPanelOpen,
    browserDetached,
    setBrowserDetached,
    setBrowserPanelOpen,
    token,
  } = useDashboardStore();

  const [pos, setPos] = useState({ x: 100, y: 60 });
  const [size, setSize] = useState({ w: Math.min(800, window.innerWidth * 0.6), h: Math.min(600, window.innerHeight * 0.7) });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const dragging = useRef(false);
  const dragOffset = useRef({ x: 0, y: 0 });
  const resizing = useRef(false);
  const resizeStart = useRef({ x: 0, y: 0, w: 0, h: 0 });

  const url = buildNoVncUrl(token, { password: 'abc123', resize: true });

  const onDragStart = useCallback((e: React.MouseEvent) => {
    dragging.current = true;
    dragOffset.current = { x: e.clientX - pos.x, y: e.clientY - pos.y };
    document.body.style.userSelect = 'none';
  }, [pos]);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (dragging.current) {
        setPos({ x: e.clientX - dragOffset.current.x, y: e.clientY - dragOffset.current.y });
      }
      if (resizing.current) {
        setSize({
          w: Math.max(400, resizeStart.current.w + (e.clientX - resizeStart.current.x)),
          h: Math.max(300, resizeStart.current.h + (e.clientY - resizeStart.current.y)),
        });
      }
    };
    const onUp = () => {
      dragging.current = false;
      resizing.current = false;
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, []);

  if (!browserPanelOpen || browserDetached !== 'overlay') return null;

  const handleReattach = () => setBrowserDetached('none');

  const handlePopout = () => {
    window.open(url, '_blank', 'width=1024,height=768');
    setBrowserDetached('popout');
  };

  const handleRefresh = () => {
    setLoading(true);
    setError(false);
    if (iframeRef.current) iframeRef.current.src = url;
  };

  return createPortal(
    <div
      className="fixed z-50 flex flex-col rounded-lg border border-border bg-background shadow-2xl overflow-hidden"
      style={{ left: pos.x, top: pos.y, width: size.w, height: size.h }}
    >
      {/* Draggable header */}
      <div
        onMouseDown={onDragStart}
        className="flex items-center justify-between px-3 py-2 border-b border-border bg-card/80 cursor-grab active:cursor-grabbing flex-shrink-0"
      >
        <div className="flex items-center gap-2">
          <GripHorizontal className="w-3 h-3 text-muted-foreground" />
          <span className="text-xs font-semibold text-foreground">Remote Browser</span>
          {loading && (
            <div className="w-3 h-3 border-2 border-purple-500 border-t-transparent rounded-full animate-spin" />
          )}
        </div>
        <div className="flex items-center gap-1">
          <button onClick={handleRefresh} className="w-6 h-6 rounded flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted transition-colors" title="Refresh">
            <RefreshCw className="w-3 h-3" />
          </button>
          <button onClick={handleReattach} className="w-6 h-6 rounded flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted transition-colors" title="Re-attach to split">
            <PanelRightOpen className="w-3 h-3" />
          </button>
          <button onClick={handlePopout} className="w-6 h-6 rounded flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted transition-colors" title="Pop out">
            <ExternalLink className="w-3 h-3" />
          </button>
          <button onClick={() => setBrowserPanelOpen(false)} className="w-6 h-6 rounded flex items-center justify-center text-muted-foreground hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-500/10 transition-colors" title="Close">
            <X className="w-3 h-3" />
          </button>
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
            onLoad={() => setLoading(false)}
            onError={() => { setLoading(false); setError(true); }}
            allow="clipboard-read; clipboard-write"
          />
        )}
      </div>

      <AgentStatusBar />

      {/* Resize handle (bottom-right corner) */}
      <div
        onMouseDown={(e) => {
          e.preventDefault();
          resizing.current = true;
          resizeStart.current = { x: e.clientX, y: e.clientY, w: size.w, h: size.h };
          document.body.style.cursor = 'nwse-resize';
          document.body.style.userSelect = 'none';
        }}
        className="absolute bottom-0 right-0 w-4 h-4 cursor-nwse-resize"
      />
    </div>,
    document.body
  );
}
