import { useEffect, useState } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { useDashboardStore } from './store/dashboard-store';
import { useAuth } from './hooks/useAuth';
import { LoginPage } from './components/views/LoginPage';
import { auth, sendEmailVerification } from './lib/firebase';
import { ConnectPage } from './components/views/ConnectPage';
import { MainShell } from './MainShell';
import { AgentDetailView } from './components/agents/AgentDetailView';
import { SessionDetailView } from './components/views/SessionDetailView';
import { TasksPage } from './components/views/TasksPage';
import { SettingsPage } from './components/views/SettingsPage';
import { UnifiedDashboard } from './components/views/UnifiedDashboard';
import { CronPage } from './components/views/CronPage';

function PageTracker() {
  const location = useLocation();
  useEffect(() => {
    if (typeof window.gtag === 'function') {
      window.gtag('event', 'page_view', {
        page_path: location.pathname,
        page_location: window.location.href,
      });
    }
  }, [location.pathname]);
  return null;
}

function App() {
  const { connected, token, autoConnect, setToken, setGatewayUrl, disconnect } = useDashboardStore();
  const { user, loading: authLoading, getIdToken, signOut } = useAuth();
  const [verifying, setVerifying] = useState(false);
  const [authError, setAuthError] = useState('');
  const [emailNotVerified, setEmailNotVerified] = useState(false);
  const [verificationSent, setVerificationSent] = useState(false);

  // After Firebase auth, verify ownership and get gateway token
  // Always verify on load to get a fresh token (handles VPS resets with new GATEWAY_TOKEN)
  useEffect(() => {
    if (authLoading || !user) return;

    let cancelled = false;

    const verifyOwner = async () => {
      setVerifying(true);
      setAuthError('');
      try {
        const idToken = await getIdToken();
        const res = await fetch('/api/verify-owner', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ idToken }),
        });

        if (cancelled) return;

        if (res.ok) {
          const data = await res.json();
          if (data.authorized && data.gatewayToken) {
            // If token changed (e.g. VPS reset), disconnect existing client so autoConnect
            // creates a new one with the fresh token instead of staying stuck in reconnect loop
            if (data.gatewayToken !== token) {
              disconnect();
            }
            setToken(data.gatewayToken);
            if (data.gatewayUrl) {
              setGatewayUrl(data.gatewayUrl);
            }
          } else {
            setAuthError('Access denied. You are not the owner of this instance.');
            await signOut();
          }
        } else if (res.status === 403) {
          const errData = await res.json().catch(() => ({}));
          if (errData.reason === 'EMAIL_NOT_VERIFIED') {
            setEmailNotVerified(true);
            // Don't sign out — keep user authenticated so we can resend verification
          } else {
            setAuthError('Access denied. Only the instance owner can access this dashboard.');
            await signOut();
          }
        } else {
          setAuthError('Failed to verify access. Please try again.');
          await signOut();
        }
      } catch {
        if (!cancelled) {
          setAuthError('Connection error. Please try again.');
        }
      } finally {
        if (!cancelled) setVerifying(false);
      }
    };

    verifyOwner();
    return () => { cancelled = true; };
  }, [user, authLoading, token, getIdToken, setToken, setGatewayUrl, signOut]);

  // Auto-connect when we have a gateway token
  useEffect(() => {
    if (token) {
      autoConnect();
    }
  }, [autoConnect, token]);

  // Show loading while Firebase auth is initializing
  if (authLoading || verifying) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#050508]">
        <div className="flex flex-col items-center gap-4">
          <div className="w-10 h-10 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin" />
          <p className="text-white/40 text-sm">
            {verifying ? 'Verifying access...' : 'Loading...'}
          </p>
        </div>
      </div>
    );
  }

  // Email not verified — show a dedicated screen (user is still signed in)
  if (emailNotVerified && user) {
    const handleSendVerification = async () => {
      if (!auth?.currentUser) return;
      try {
        await sendEmailVerification(auth.currentUser);
        setVerificationSent(true);
      } catch { /* ignore */ }
    };

    const handleRetry = () => {
      setEmailNotVerified(false);
      setVerificationSent(false);
    };

    return (
      <div className="min-h-screen flex items-center justify-center bg-[#050508]">
        <div className="w-full max-w-md px-6">
          <div className="bg-white/5 border border-white/10 backdrop-blur-xl rounded-3xl p-8 shadow-2xl text-center">
            <div className="w-16 h-16 bg-amber-500/20 rounded-full flex items-center justify-center mx-auto mb-4">
              <svg className="w-8 h-8 text-amber-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
              </svg>
            </div>
            <h2 className="text-xl font-bold text-white mb-2">Verify your email</h2>
            <p className="text-white/50 text-sm mb-1">A verification email needs to be sent to:</p>
            <p className="text-white font-medium mb-6">{user.email}</p>

            {verificationSent ? (
              <div className="bg-green-500/10 border border-green-500/20 rounded-2xl p-4 mb-4">
                <p className="text-green-400 text-sm">Verification email sent! Check your inbox, then click below.</p>
              </div>
            ) : null}

            <div className="space-y-3">
              {!verificationSent && (
                <button
                  onClick={handleSendVerification}
                  className="w-full rounded-2xl bg-indigo-600 hover:bg-indigo-500 text-white font-bold py-3 transition-all hover:scale-[1.02]"
                >
                  Send verification email
                </button>
              )}
              <button
                onClick={handleRetry}
                className="w-full rounded-2xl bg-white/10 hover:bg-white/20 text-white font-medium py-3 transition-all"
              >
                I've verified — try again
              </button>
              <button
                onClick={async () => { await signOut(); setEmailNotVerified(false); }}
                className="w-full text-white/30 hover:text-white/60 text-sm py-2 transition-colors"
              >
                Sign out
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Not authenticated or auth error -> show login
  if (!user || authError) {
    return (
      <LoginPage
        error={authError}
        onRetry={authError ? () => setAuthError('') : undefined}
      />
    );
  }

  // Authenticated but no token yet (shouldn't happen normally, but handle it)
  if (!token) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#050508]">
        <div className="flex flex-col items-center gap-4">
          <div className="w-10 h-10 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin" />
          <p className="text-white/40 text-sm">Connecting...</p>
        </div>
      </div>
    );
  }

  return (
    <BrowserRouter>
      <PageTracker />
      <Routes>
        <Route path="/connect" element={connected && token ? <Navigate to="/" replace /> : <ConnectPage />} />

        {/* Protected Area */}
        <Route element={<MainShell />}>
            <Route path="/" element={<UnifiedDashboard />} />
            <Route path="/session/:key" element={<SessionDetailView />} />
            <Route path="/agents/:id" element={<AgentDetailView />} />
            <Route path="/tasks" element={<TasksPage />} />
            <Route path="/cron" element={<CronPage />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="/settings/:tab" element={<SettingsPage />} />
        </Route>

        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}

export default App;
