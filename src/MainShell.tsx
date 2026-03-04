import { useEffect, useRef } from 'react';
import { Outlet, Navigate } from 'react-router-dom';
import { Loader2, WifiOff, RefreshCw } from 'lucide-react';
import { AppSidebar } from './components/layout/AppSidebar';
import { CommandPalette } from './components/layout/CommandPalette';
import { ToastProvider, useToast } from './components/ui/toast';
import { useDashboardStore } from './store/dashboard-store';

function ReconnectToast() {
  const { connected } = useDashboardStore();
  const { addToast } = useToast();
  const wasConnectedRef = useRef(false);
  const initialRef = useRef(true);

  useEffect(() => {
    if (connected) {
      if (!initialRef.current && wasConnectedRef.current === false) {
        // Was disconnected, now reconnected (not initial load)
        addToast({ title: 'Reconnected', variant: 'success', duration: 3000 });
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

  if (connected) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="flex flex-col items-center gap-3 rounded-xl border border-zinc-700/50 bg-zinc-900/95 px-8 py-6 shadow-2xl">
        {connecting ? (
          <>
            <Loader2 className="h-8 w-8 animate-spin text-blue-400" />
            <p className="text-sm font-medium text-zinc-200">
              {reconnectAttempt > 0
                ? `Reconnecting... (attempt ${reconnectAttempt})`
                : 'Connecting...'}
            </p>
            <p className="text-xs text-zinc-500">Your session will resume automatically</p>
          </>
        ) : (
          <>
            <WifiOff className="h-8 w-8 text-zinc-400" />
            <p className="text-sm font-medium text-zinc-200">Connection lost</p>
            <button
              onClick={() => connect()}
              className="mt-1 flex items-center gap-2 rounded-lg border border-zinc-600 bg-zinc-800 px-4 py-2 text-sm text-zinc-200 transition-colors hover:bg-zinc-700"
            >
              <RefreshCw className="h-4 w-4" />
              Reconnect
            </button>
          </>
        )}
      </div>
    </div>
  );
}

export function MainShell() {
  const { connected, token } = useDashboardStore();

  // No token at all → redirect to login
  if (!token) {
    return <Navigate to="/connect" replace />;
  }

  return (
    <ToastProvider>
      <div className="flex h-screen w-full bg-background text-foreground overflow-hidden">
        <AppSidebar />
        <main className="flex-1 flex flex-col min-w-0">
          <Outlet />
        </main>
        <CommandPalette />
      </div>
      {/* Overlay when disconnected but have token (reconnecting) */}
      {!connected && <ConnectionOverlay />}
      <ReconnectToast />
    </ToastProvider>
  );
}
