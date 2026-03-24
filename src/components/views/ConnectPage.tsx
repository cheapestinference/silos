import React, { useState } from 'react';
import { Wifi, Lock, Server, AlertCircle } from 'lucide-react';
import { useDashboardStore } from '../../store/dashboard-store';
import useTranslation from '../../i18n';

export function ConnectPage() {
  const { gatewayUrl, token, setGatewayUrl, setToken, connect, connecting, error } = useDashboardStore();
  const [showToken, setShowToken] = useState(false);
  const { t } = useTranslation();

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    connect();
  };

  return (
    <div className="dark min-h-screen flex items-center justify-center relative overflow-hidden bg-background">
      {/* Animated Background Elements */}
      <div className="absolute top-1/4 left-1/4 w-96 h-96 bg-[hsl(var(--glow)_/_0.2)] blur-[120px] rounded-full animate-pulse-soft" />
      <div className="absolute bottom-1/4 right-1/4 w-[500px] h-[500px] bg-[hsl(var(--accent-secondary)_/_0.1)] blur-[150px] rounded-full animate-float" />
      
      <div className="w-full max-w-lg px-6 z-10">
        {/* Logo Section */}
        <div className="text-center mb-12 animate-message-in">
          <div className="inline-flex relative">
            <div className="mx-auto flex h-24 w-24 items-center justify-center rounded-[2rem] bg-gradient-to-tr from-primary to-[hsl(var(--accent-secondary))] border border-white/20 shadow-2xl ai-glow">
              <svg viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg" className="h-12 w-12">
                <path d="M40 19C40 19 38 16 32 16C25 16 21 20 21 24.5C21 29 25 30.5 32 32C39 33.5 43 35 43 39.5C43 44 39 48 32 48C25 48 23 45 23 45" stroke="white" strokeWidth="6" strokeLinecap="round" />
              </svg>
            </div>
            <div className="absolute -top-2 -right-2 w-8 h-8 rounded-full bg-green-500 border-4 border-background animate-pulse" />
          </div>
          <h1 className="mt-8 text-5xl font-extrabold tracking-tighter ai-gradient-text">
            {t('connect.appName')} <span className="text-white opacity-90">{t('connect.appSuffix')}</span>
          </h1>
          <p className="mt-4 text-white/40 text-lg font-medium tracking-tight max-w-sm mx-auto">
            {t('connect.tagline')}
          </p>
        </div>

        {/* Connection Form */}
        <div className="glass-panel p-8 rounded-[2.5rem] animate-message-in shadow-2xl border-white/10">
          <form onSubmit={handleSubmit} className="space-y-8">
            <div className="space-y-3">
              <label className="text-xs font-bold uppercase tracking-[0.2em] text-white/50 flex items-center gap-3 px-1">
                <Server className="h-4 w-4 text-primary" />
                {t('connect.gatewayInterface')}
              </label>
              <div className="relative group">
                <input
                  type="url"
                  placeholder="http://107.0.0.1:18789"
                  className="w-full bg-white/5 border border-white/10 rounded-2xl px-6 py-4 text-white focus:outline-none focus:ring-2 focus:ring-ring transition-all placeholder:text-white/20"
                  value={gatewayUrl}
                  onChange={(e) => setGatewayUrl(e.target.value)}
                  required
                />
              </div>
            </div>

            <div className="space-y-3">
              <label className="text-xs font-bold uppercase tracking-[0.2em] text-white/50 flex items-center gap-3 px-1">
                <Lock className="h-4 w-4 text-primary" />
                {t('connect.securityToken')}
              </label>
              <div className="relative group">
                <input
                  type={showToken ? 'text' : 'password'}
                  placeholder={t('connect.tokenPlaceholder')}
                  className="w-full bg-white/5 border border-white/10 rounded-2xl px-6 py-4 text-white focus:outline-none focus:ring-2 focus:ring-ring transition-all placeholder:text-white/20"
                  value={token || ''}
                  onChange={(e) => setToken(e.target.value || null)}
                />
                <button
                  type="button"
                  className="absolute right-6 top-1/2 -translate-y-1/2 text-[10px] font-bold uppercase tracking-widest text-white/30 hover:text-white transition-colors"
                  onClick={() => setShowToken(!showToken)}
                >
                  {showToken ? t('connect.hide') : t('connect.show')}
                </button>
              </div>
            </div>

            {error && (
              <div className="flex items-center gap-4 rounded-2xl bg-red-500/10 border border-red-500/20 p-4 text-sm text-red-600 dark:text-red-400 animate-message-in">
                <AlertCircle className="h-5 w-5 shrink-0" />
                <span className="font-medium">{error}</span>
              </div>
            )}

            <button 
              type="submit" 
              className="w-full group relative overflow-hidden rounded-2xl bg-white text-black font-bold text-lg py-4 transition-all hover:scale-[1.02] active:scale-[0.98] disabled:opacity-50" 
              disabled={connecting}
            >
              <div className="relative z-10 flex items-center justify-center gap-3">
                {connecting ? (
                  <>
                    <Wifi className="h-5 w-5 animate-pulse" />
                    {t('connect.connecting')}
                  </>
                ) : (
                  <>
                    <Wifi className="h-5 w-5" />
                    {t('connect.establishConnection')}
                  </>
                )}
              </div>
              <div className="absolute inset-0 bg-gradient-to-r from-primary via-[hsl(var(--accent-secondary))] to-pink-500 opacity-0 group-hover:opacity-10 transition-opacity" />
            </button>
          </form>
        </div>

        {/* Footer Info */}
        <p className="mt-8 text-center text-[10px] font-bold uppercase tracking-[0.3em] text-white/20">
          {t('connect.footer')}
        </p>
      </div>
    </div>
  );
}
