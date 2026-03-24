import { useState } from 'react';
import { AlertCircle } from 'lucide-react';
import { useAuth } from '../../hooks/useAuth';
import useTranslation from '../../i18n';

// ─── Logo options (swap to test) ───────────────────────────────────────────────

// Option 1: Three silos/cylinders with pulse dot
function SilosLogo1({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg" className={className}>
      <rect x="8" y="28" width="14" height="28" rx="4" fill="white" opacity="0.5" />
      <rect x="25" y="16" width="14" height="40" rx="4" fill="white" opacity="0.75" />
      <rect x="42" y="22" width="14" height="34" rx="4" fill="white" opacity="0.5" />
      <ellipse cx="15" cy="28" rx="7" ry="3" fill="white" opacity="0.7" />
      <ellipse cx="32" cy="16" rx="7" ry="3" fill="white" />
      <ellipse cx="49" cy="22" rx="7" ry="3" fill="white" opacity="0.7" />
      <circle cx="53" cy="12" r="4" fill="#34d399" />
    </svg>
  );
}

// Option 2: Dashboard grid — 4 tiles, one highlighted
function SilosLogo2({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg" className={className}>
      <rect x="8" y="8" width="22" height="22" rx="5" fill="white" />
      <rect x="34" y="8" width="22" height="12" rx="4" fill="white" opacity="0.4" />
      <rect x="34" y="24" width="22" height="6" rx="3" fill="white" opacity="0.4" />
      <rect x="8" y="34" width="22" height="8" rx="4" fill="white" opacity="0.4" />
      <rect x="8" y="46" width="22" height="10" rx="4" fill="white" opacity="0.4" />
      <rect x="34" y="34" width="22" height="22" rx="5" fill="white" opacity="0.6" />
      <circle cx="45" cy="45" r="5" fill="white" opacity="0.3" />
      <path d="M43 45L45 47L48 43" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// Option 3: S integrated into a rounded container/silo shape
function SilosLogo3({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg" className={className}>
      {/* Silo container outline */}
      <path d="M16 18C16 12 22 8 32 8C42 8 48 12 48 18V50C48 54 42 58 32 58C22 58 16 54 16 50V18Z" stroke="white" strokeWidth="2.5" opacity="0.35" />
      {/* S path inside */}
      <path d="M38 24C38 24 36.5 21 32 21C27 21 24 23.5 24 26.5C24 29.5 27 31 32 32.5C37 34 40 35.5 40 38.5C40 41.5 37 44 32 44C27 44 25.5 41 25.5 41" stroke="white" strokeWidth="4" strokeLinecap="round" />
      {/* Connector dots */}
      <circle cx="32" cy="12" r="2" fill="white" opacity="0.5" />
      <circle cx="32" cy="53" r="2" fill="white" opacity="0.5" />
    </svg>
  );
}

// ← Change this to test: SilosLogo1, SilosLogo2, SilosLogo3
const SilosLogo = SilosLogo1;

interface LoginPageProps {
  error?: string;
  onRetry?: () => void;
}

export function LoginPage({ error: externalError, onRetry }: LoginPageProps) {
  const { t } = useTranslation();
  const { signIn, signInWithGoogle, loading } = useAuth();
  const [signingIn, setSigningIn] = useState(false);
  const [error, setError] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  const displayError = externalError || error;

  const handleEmailSignIn = async (e: React.FormEvent) => {
    e.preventDefault();
    setSigningIn(true);
    setError('');
    try {
      await signIn(email, password);
    } catch (err) {
      const message = err instanceof Error ? err.message : t('login.signInFailed');
      if (message.includes('auth/invalid-credential') || message.includes('auth/wrong-password')) {
        setError(t('login.errors.invalidCredential'));
      } else if (message.includes('auth/too-many-requests')) {
        setError(t('login.errors.tooManyRequests'));
      } else {
        setError(message);
      }
      setSigningIn(false);
    }
  };

  const handleGoogleSignIn = async () => {
    setSigningIn(true);
    setError('');
    try {
      await signInWithGoogle();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('login.signInFailed'));
      setSigningIn(false);
    }
  };

  return (
    <div className="dark min-h-screen flex items-center justify-center relative overflow-hidden" style={{ background: 'hsl(222, 47%, 11%)' }}>
      {/* Background */}
      <div className="absolute top-1/4 left-1/4 w-96 h-96 bg-[hsl(var(--glow)_/_0.2)] blur-[120px] rounded-full animate-pulse-soft" />
      <div className="absolute bottom-1/4 right-1/4 w-[500px] h-[500px] bg-[hsl(var(--accent-secondary)_/_0.1)] blur-[150px] rounded-full" />

      <div className="w-full max-w-lg px-6 z-10">
        {/* Logo */}
        <div className="text-center mb-12">
          <div className="inline-flex relative">
            <svg viewBox="0 0 80 80" fill="none" xmlns="http://www.w3.org/2000/svg" className="h-20 w-20">
              <rect x="0" y="0" width="80" height="80" rx="22" fill="url(#silos-grad)" />
              <path d="M51 28C51 28 48 23 40 23C31 23 27 27.5 27 32C27 36.5 31 38.5 40 40.5C49 42.5 53 44.5 53 49C53 53.5 49 58 40 58C31 58 28 53 28 53" stroke="white" strokeWidth="6" strokeLinecap="round" />
              <defs>
                <linearGradient id="silos-grad" x1="0" y1="0" x2="80" y2="80">
                  <stop stopColor="hsl(var(--primary))" />
                  <stop offset="1" stopColor="hsl(var(--accent-secondary))" />
                </linearGradient>
              </defs>
            </svg>
          </div>
          <h1 className="mt-8 text-4xl font-extrabold tracking-tighter text-white">
            {t('login.title')} <span className="text-white/60">{t('login.titleSuffix')}</span>
          </h1>
          <p className="mt-3 text-white/40 text-sm">
            {window.location.hostname}
          </p>
        </div>

        {/* Login Card */}
        <div className="bg-white/5 border border-white/10 backdrop-blur-xl rounded-3xl p-8 shadow-2xl">
          <p className="text-center text-white/60 text-sm mb-6">
            {t('login.description')}
          </p>

          {displayError && (
            <div className="flex items-center gap-3 rounded-2xl bg-red-500/10 border border-red-500/20 p-4 text-sm text-red-600 dark:text-red-400 mb-6">
              <AlertCircle className="h-5 w-5 shrink-0" />
              <span className="font-medium">{displayError}</span>
            </div>
          )}

          {/* Email/password form */}
          {!externalError && (
            <form onSubmit={handleEmailSignIn} className="space-y-4 mb-6">
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder={t('login.emailPlaceholder')}
                required
                autoComplete="email"
                className="w-full rounded-2xl bg-white/10 border border-white/10 text-white placeholder-white/20 px-4 py-3 text-sm focus:outline-none focus:border-ring focus:ring-1 focus:ring-ring"
              />
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={t('login.passwordPlaceholder')}
                required
                autoComplete="current-password"
                minLength={6}
                className="w-full rounded-2xl bg-white/10 border border-white/10 text-white placeholder-white/20 px-4 py-3 text-sm focus:outline-none focus:border-ring focus:ring-1 focus:ring-ring"
              />
              <button
                type="submit"
                disabled={signingIn || loading}
                className="w-full rounded-2xl bg-primary hover:bg-primary/90 text-white font-bold text-base py-4 transition-all hover:scale-[1.02] active:scale-[0.98] disabled:opacity-50"
              >
                {signingIn ? (
                  <span className="flex items-center justify-center gap-2">
                    <div className="w-4 h-4 border-2 border-white/40 border-t-white rounded-full animate-spin" />
                    {t('login.signingIn')}
                  </span>
                ) : t('login.signIn')}
              </button>
            </form>
          )}

          <div className="flex items-center gap-3 my-4">
            <div className="flex-1 border-t border-white/10" />
            <span className="text-xs uppercase text-white/20">{t('login.orContinueWith')}</span>
            <div className="flex-1 border-t border-white/10" />
          </div>

          <button
            onClick={externalError && onRetry ? onRetry : handleGoogleSignIn}
            disabled={signingIn || loading}
            className="w-full group relative overflow-hidden rounded-2xl bg-white text-black font-bold text-base py-4 transition-all hover:scale-[1.02] active:scale-[0.98] disabled:opacity-50"
          >
            <div className="relative z-10 flex items-center justify-center gap-3">
              {signingIn || loading ? (
                <>
                  <div className="w-5 h-5 border-2 border-gray-400 border-t-transparent rounded-full animate-spin" />
                  {t('login.signingIn')}
                </>
              ) : externalError && onRetry ? (
                t('login.tryAgain')
              ) : (
                <>
                  <svg className="w-5 h-5" viewBox="0 0 24 24">
                    <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 01-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4" />
                    <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853" />
                    <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05" />
                    <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335" />
                  </svg>
                  {t('login.signInGoogle')}
                </>
              )}
            </div>
          </button>
        </div>

        {/* Footer spacer */}
        <div className="mt-6" />
      </div>
    </div>
  );
}
