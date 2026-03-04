import { useState } from 'react';
import { Shield, AlertCircle } from 'lucide-react';
import { useAuth } from '../../hooks/useAuth';
import useTranslation from '../../i18n';

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
    <div className="min-h-screen flex items-center justify-center relative overflow-hidden bg-[#050508]">
      {/* Background */}
      <div className="absolute top-1/4 left-1/4 w-96 h-96 bg-indigo-600/20 blur-[120px] rounded-full animate-pulse-soft" />
      <div className="absolute bottom-1/4 right-1/4 w-[500px] h-[500px] bg-purple-600/10 blur-[150px] rounded-full" />

      <div className="w-full max-w-lg px-6 z-10">
        {/* Logo */}
        <div className="text-center mb-12">
          <div className="inline-flex relative">
            <div className="mx-auto flex h-24 w-24 items-center justify-center rounded-[2rem] bg-gradient-to-tr from-indigo-600 to-purple-600 border border-white/20 shadow-2xl">
              <Shield className="h-12 w-12 text-white" />
            </div>
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
            <div className="flex items-center gap-3 rounded-2xl bg-red-500/10 border border-red-500/20 p-4 text-sm text-red-400 mb-6">
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
                className="w-full rounded-2xl bg-white/10 border border-white/10 text-white placeholder-white/30 px-4 py-3 text-sm focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
              />
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={t('login.passwordPlaceholder')}
                required
                autoComplete="current-password"
                minLength={6}
                className="w-full rounded-2xl bg-white/10 border border-white/10 text-white placeholder-white/30 px-4 py-3 text-sm focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
              />
              <button
                type="submit"
                disabled={signingIn || loading}
                className="w-full rounded-2xl bg-indigo-600 hover:bg-indigo-500 text-white font-bold text-base py-4 transition-all hover:scale-[1.02] active:scale-[0.98] disabled:opacity-50"
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

          <div className="relative my-4">
            <div className="absolute inset-0 flex items-center">
              <div className="w-full border-t border-white/10" />
            </div>
            <div className="relative flex justify-center text-xs uppercase">
              <span className="bg-transparent px-2 text-white/20">{t('login.orContinueWith')}</span>
            </div>
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

        <p className="mt-6 text-center text-[10px] font-bold uppercase tracking-[0.3em] text-white/15">
          {t('login.ownerOnly')}
        </p>
      </div>
    </div>
  );
}
