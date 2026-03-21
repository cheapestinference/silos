import { useEffect, useRef } from 'react';
import { Outlet, Navigate } from 'react-router-dom';
import { Loader2, WifiOff, RefreshCw } from 'lucide-react';
import { AppSidebar } from './components/layout/AppSidebar';
import { CommandPalette } from './components/layout/CommandPalette';
import { BrowserPanel } from './components/layout/BrowserPanel';
import { FloatingBrowserPanel } from './components/layout/FloatingBrowserPanel';
import { DragHandle } from './components/layout/DragHandle';
import { ToastProvider, useToast } from './components/ui/toast';
import { useDashboardStore } from './store/dashboard-store';
import useTranslation from './i18n';

function ReconnectToast() {
  const { connected } = useDashboardStore();
  const { addToast } = useToast();
  const { t } = useTranslation();
  const wasConnectedRef = useRef(false);
  const initialRef = useRef(true);

  useEffect(() => {
    if (connected) {
      if (!initialRef.current && wasConnectedRef.current === false) {
        // Was disconnected, now reconnected (not initial load)
        addToast({ title: t('mainShell.reconnected'), variant: 'success', duration: 3000 });
      }
      wasConnectedRef.current = true;
      initialRef.current = false;
    } else {
      if (wasConnectedRef.current) {
        // Was connected, now disconnected
        wasConnectedRef.current = false;
      }
    }
  }, [connected, addToast]);

  return null;
}

function ConnectionOverlay() {
  const { connected, connecting, reconnectAttempt, connect } = useDashboardStore();
  const { t } = useTranslation();

  if (connected) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="flex flex-col items-center gap-3 rounded-xl border border-border bg-card/95 px-8 py-6 shadow-2xl">
        {connecting ? (
          <>
            <Loader2 className="h-8 w-8 animate-spin text-blue-600 dark:text-blue-400" />
            <p className="text-sm font-medium text-foreground">
              {reconnectAttempt > 0
                ? t('mainShell.reconnecting', { count: reconnectAttempt })
                : t('mainShell.connecting')}
            </p>
            <p className="text-xs text-muted-foreground">{t('mainShell.sessionResume')}</p>
          </>
        ) : (
          <>
            <WifiOff className="h-8 w-8 text-muted-foreground" />
            <p className="text-sm font-medium text-foreground">{t('mainShell.connectionLost')}</p>
            <button
              onClick={() => connect()}
              className="mt-1 flex items-center gap-2 rounded-lg border border-border bg-muted px-4 py-2 text-sm text-foreground transition-colors hover:bg-muted"
            >
              <RefreshCw className="h-4 w-4" />
              {t('mainShell.reconnect')}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

export function MainShell() {
  const { connected, token, browserPanelOpen, browserDetached, browserSplitRatio, setBrowserSplitRatio } = useDashboardStore();
  const splitRef = useRef<HTMLDivElement>(null);

  // No token at all → redirect to login
  if (!token) {
    return <Navigate to="/connect" replace />;
  }

  const showSplit = browserPanelOpen && browserDetached === 'none';

  return (
    <ToastProvider>
      <div className="flex h-screen w-full bg-background text-foreground overflow-hidden">
        <AppSidebar />
        <div ref={splitRef} className="flex-1 flex min-w-0">
          <main
            className="flex flex-col min-w-0 transition-all duration-200"
            style={{ flex: showSplit ? `0 0 ${browserSplitRatio * 100}%` : '1 1 100%' }}
          >
            <Outlet />
          </main>
          {showSplit && (
            <>
              <DragHandle
                containerRef={splitRef}
                onResize={setBrowserSplitRatio}
              />
              <div style={{ flex: `0 0 ${(1 - browserSplitRatio) * 100}%` }} className="min-w-[320px]">
                <BrowserPanel />
              </div>
            </>
          )}
        </div>
        <FloatingBrowserPanel />
        <CommandPalette />
      </div>
      {/* Overlay when disconnected but have token (reconnecting) */}
      {!connected && <ConnectionOverlay />}
      <ReconnectToast />
    </ToastProvider>
  );
}
