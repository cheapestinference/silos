import React, { useState } from 'react';
import { Wifi, Lock, Server, AlertCircle, Shield } from 'lucide-react';
import { useDashboardStore } from '../../store/dashboard-store';

export function ConnectPage() {
  const { gatewayUrl, token, setGatewayUrl, setToken, connect, connecting, error } = useDashboardStore();
  const [showToken, setShowToken] = useState(false);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    connect();
  };

  return (
    <div className="min-h-screen flex items-center justify-center relative overflow-hidden bg-[#050508]">
      {/* Animated Background Elements */}
      <div className="absolute top-1/4 left-1/4 w-96 h-96 bg-indigo-600/20 blur-[120px] rounded-full animate-pulse-soft" />
      <div className="absolute bottom-1/4 right-1/4 w-[500px] h-[500px] bg-purple-600/10 blur-[150px] rounded-full animate-float" />
      
      <div className="w-full max-w-lg px-6 z-10">
        {/* Logo Section */}
        <div className="text-center mb-12 animate-message-in">
          <div className="inline-flex relative">
            <div className="mx-auto flex h-24 w-24 items-center justify-center rounded-[2rem] bg-gradient-to-tr from-indigo-600 to-purple-600 border border-white/20 shadow-2xl ai-glow">
              <Shield className="h-12 w-12 text-white" />
            </div>
            <div className="absolute -top-2 -right-2 w-8 h-8 rounded-full bg-green-500 border-4 border-[#050508] animate-pulse" />
          </div>
          <h1 className="mt-8 text-5xl font-extrabold tracking-tighter ai-gradient-text">
            OPENCLAW <span className="text-white opacity-90">OS</span>
          </h1>
          <p className="mt-4 text-white/40 text-lg font-medium tracking-tight max-w-sm mx-auto">
            Authorized access required. Connect to terminal gateway to begin neural orchestration.
          </p>
        </div>

        {/* Connection Form */}
        <div className="glass-panel p-8 rounded-[2.5rem] animate-message-in shadow-2xl border-white/10">
          <form onSubmit={handleSubmit} className="space-y-8">
            <div className="space-y-3">
              <label className="text-xs font-bold uppercase tracking-[0.2em] text-white/50 flex items-center gap-3 px-1">
                <Server className="h-4 w-4 text-indigo-400" />
                Gateway Interface
              </label>
              <div className="relative group">
                <input
                  type="url"
                  placeholder="http://127.0.0.1:18789"
                  className="w-full bg-white/5 border border-white/10 rounded-2xl px-6 py-4 text-white focus:outline-none focus:ring-2 focus:ring-indigo-500/40 transition-all placeholder:text-white/20"
                  value={gatewayUrl}
                  onChange={(e) => setGatewayUrl(e.target.value)}
                  required
                />
              </div>
            </div>

            <div className="space-y-3">
              <label className="text-xs font-bold uppercase tracking-[0.2em] text-white/50 flex items-center gap-3 px-1">
                <Lock className="h-4 w-4 text-purple-400" />
                Security Token
              </label>
              <div className="relative group">
                <input
                  type={showToken ? 'text' : 'password'}
                  placeholder="Leave empty if not required"
                  className="w-full bg-white/5 border border-white/10 rounded-2xl px-6 py-4 text-white focus:outline-none focus:ring-2 focus:ring-purple-500/40 transition-all placeholder:text-white/20"
                  value={token || ''}
                  onChange={(e) => setToken(e.target.value || null)}
                />
                <button
                  type="button"
                  className="absolute right-6 top-1/2 -translate-y-1/2 text-[10px] font-bold uppercase tracking-widest text-white/30 hover:text-white transition-colors"
                  onClick={() => setShowToken(!showToken)}
                >
                  {showToken ? 'Hide' : 'Show'}
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
                    Bypassing Security...
                  </>
                ) : (
                  <>
                    <Wifi className="h-5 w-5" />
                    Establish Connection
                  </>
                )}
              </div>
              <div className="absolute inset-0 bg-gradient-to-r from-indigo-500 via-purple-500 to-pink-500 opacity-0 group-hover:opacity-10 transition-opacity" />
            </button>
          </form>
        </div>

        {/* Footer Info */}
        <p className="mt-8 text-center text-[10px] font-bold uppercase tracking-[0.3em] text-white/20">
          Neural-Link Protocol v4.2.0 • Encryption Enabled
        </p>
      </div>
    </div>
  );
}
