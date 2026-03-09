import { useEffect, useState } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { useDashboardStore } from './store/dashboard-store';
import { useAuth } from './hooks/useAuth';
import { LoginPage } from './components/views/LoginPage';
import { auth, sendEmailVerification } from './lib/firebase';
import { ConnectPage } from './components/views/ConnectPage';
import { MainShell } from './MainShell';
import { AgentDetailView } from './components/agents/AgentDetailView';
import { OverviewPanel } from './components/agents/OverviewPanel';
import { BrainPanel } from './components/agents/BrainPanel';
import { WorkspacePanel } from './components/agents/WorkspacePanel';
import { AgentToolsPanel } from './components/agents/AgentToolsPanel';
import { SkillsPanel } from './components/agents/SkillsPanel';
import { KnowledgeBrowser } from './components/agents/KnowledgeBrowser';
import { ScheduledPanel } from './components/agents/ScheduledPanel';
import { ConfigPanel } from './components/agents/ConfigPanel';
import { SessionDetailView } from './components/views/SessionDetailView';
import { TasksPage } from './components/views/TasksPage';
import { SettingsPage } from './components/views/SettingsPage';
import { UnifiedDashboard } from './components/views/UnifiedDashboard';
import { CronPage } from './components/views/CronPage';
import useTranslation from './i18n';

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
  const { t } = useTranslation();
  const [verifying, setVerifying] = useState(false);
  const [authError, setAuthError] = useState('');
  const [emailNotVerified, setEmailNotVerified] = useState(false);
  const [verificationSent, setVerificationSent] = useState(false);

  // After Firebase auth, verify ownership and get gateway token
  // Always verify on load to get a fresh token (handles VPS resets with new GATEWAY_TOKEN)
  useEffect(() => {
    if (authLoading || !user) return;

    // For email/password sign-ins, enforce email verification before proceeding
    // Google sign-in users are already verified by nature of the OAuth flow
    const providerIds = user.providerData?.map(p => p.providerId) || [];
    const isGoogleOnly = providerIds.length > 0 && providerIds.every(p => p === 'google.com');
    if (!user.emailVerified && !isGoogleOnly) {
      setEmailNotVerified(true);
      setVerifying(false);
      return;
    }

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

  // Email not verified — auto-send verification email
  useEffect(() => {
    if (emailNotVerified && user && !verificationSent && auth?.currentUser && !user.emailVerified) {
      sendEmailVerification(auth.currentUser)
        .then(() => setVerificationSent(true))
        .catch(() => {});
    }
  }, [emailNotVerified, user, verificationSent]);

  // Auto-poll email verification status every 5s
  useEffect(() => {
    if (!emailNotVerified || !user || !auth?.currentUser) return;
    const interval = setInterval(async () => {
      try {
        await auth!.currentUser!.reload();
        if (auth!.currentUser!.emailVerified) {
          await auth!.currentUser!.getIdToken(true);
          setEmailNotVerified(false);
          setVerificationSent(false);
        }
      } catch { /* ignore */ }
    }, 5000);
    return () => clearInterval(interval);
  }, [emailNotVerified, user]);

  // Show loading while Firebase auth is initializing
  if (authLoading || verifying) {
    return (
      <div key="auth-loading" className="min-h-screen flex items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-4">
          <div className="w-10 h-10 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin" />
          <p className="text-muted-foreground text-sm">
            {verifying ? t('app.verifyingAccess') : t('app.loading')}
          </p>
        </div>
      </div>
    );
  }

  if (emailNotVerified && user) {
    const handleResend = async () => {
      if (!auth?.currentUser) return;
      try {
        await sendEmailVerification(auth.currentUser);
        setVerificationSent(true);
      } catch { /* ignore */ }
    };

    return (
      <div key="email-verify" className="dark min-h-screen flex items-center justify-center" style={{ background: 'hsl(222, 47%, 11%)' }}>
        <div className="w-full max-w-md px-6">
          <div className="bg-white/5 border border-white/10 backdrop-blur-xl rounded-3xl p-8 shadow-2xl text-center">
            <div className="w-16 h-16 bg-amber-500/20 rounded-full flex items-center justify-center mx-auto mb-4">
              <svg className="w-8 h-8 text-amber-600 dark:text-amber-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
              </svg>
            </div>
            <h2 className="text-xl font-bold text-white mb-2">{t('app.verifyEmail')}</h2>
            <p className="text-white/50 text-sm mb-1">{t('app.verificationNeeded')}</p>
            <p className="text-white font-medium mb-4">{user.email}</p>

            <div className="flex items-center justify-center gap-2 mb-6">
              <div className="w-4 h-4 border-2 border-indigo-400 border-t-transparent rounded-full animate-spin" />
              <p className="text-white/40 text-sm">{t('app.waitingVerification')}</p>
            </div>

            {verificationSent && (
              <div className="bg-green-500/10 border border-green-500/20 rounded-2xl p-3 mb-4">
                <p className="text-green-600 dark:text-green-400 text-sm">{t('app.emailSent')}</p>
              </div>
            )}

            <div className="space-y-2">
              <button
                onClick={handleResend}
                className="text-white/30 hover:text-white/60 text-sm transition-colors"
              >
                {t('app.resendEmail')}
              </button>
              <span className="text-white/10 mx-2">·</span>
              <button
                onClick={async () => { await signOut(); setEmailNotVerified(false); }}
                className="text-white/30 hover:text-white/60 text-sm transition-colors"
              >
                {t('app.signOut')}
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
      <div key="connecting" className="min-h-screen flex items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-4">
          <div className="w-10 h-10 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin" />
          <p className="text-muted-foreground text-sm">{t('app.connecting')}</p>
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
            <Route path="/agents/:id" element={<AgentDetailView />}>
              <Route index element={<OverviewPanel />} />
              <Route path="brain" element={<BrainPanel />} />
              <Route path="workspace" element={<WorkspacePanel />} />
              <Route path="tools" element={<AgentToolsPanel />} />
              <Route path="skills" element={<SkillsPanel />} />
              <Route path="knowledge" element={<KnowledgeBrowser />} />
              <Route path="scheduled" element={<ScheduledPanel />} />
              <Route path="config" element={<ConfigPanel />} />
            </Route>
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
