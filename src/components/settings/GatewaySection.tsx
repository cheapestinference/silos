import { useState } from 'react';
import { Wifi, WifiOff, Save, RefreshCw } from 'lucide-react';
import { useDashboardStore } from '../../store/dashboard-store';
import { cn } from '../../lib/utils';
import useTranslation from '../../i18n';

export function GatewaySection() {
  const { t } = useTranslation();
  const { gatewayUrl, token, connected, connecting, setGatewayUrl, setToken, connect, disconnect } = useDashboardStore();
  const [localUrl, setLocalUrl] = useState(gatewayUrl);
  const [localToken, setLocalToken] = useState(token || '');
  const [showToken, setShowToken] = useState(false);

  const hasChanges = localUrl !== gatewayUrl || localToken !== (token || '');

  const handleSave = () => {
    setGatewayUrl(localUrl);
    setToken(localToken || null);
  };

  const handleReconnect = () => {
    handleSave();
    if (connected) disconnect();
    setTimeout(() => connect(), 100);
  };

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">{t('settings.gatewayConfig.configure')}</p>

      {/* Connection Status */}
      <div className={cn(
        "flex items-center justify-between p-4 rounded-xl border",
        connected ? "bg-emerald-500/5 border-emerald-500/20" : connecting ? "bg-amber-500/5 border-amber-500/20" : "bg-card border"
      )}>
        <div className="flex items-center gap-3">
          {connected ? <Wifi className="w-5 h-5 text-emerald-600 dark:text-emerald-400" /> : connecting ? <Wifi className="w-5 h-5 text-amber-600 dark:text-amber-400 animate-pulse" /> : <WifiOff className="w-5 h-5 text-muted-foreground" />}
          <div>
            <p className={cn("font-semibold", connected ? "text-emerald-700 dark:text-emerald-300" : connecting ? "text-amber-600 dark:text-amber-300" : "text-muted-foreground")}>
              {connected ? t('settings.connection.connected') : connecting ? t('common.loading') : t('settings.connection.disconnected')}
            </p>
            <p className="text-xs text-muted-foreground">{connected ? `wss://${window.location.hostname}/openclaw` : t('settings.connection.disconnected')}</p>
          </div>
        </div>
        <button
          onClick={connected ? disconnect : connect}
          disabled={connecting}
          className={cn(
            "px-4 py-2 text-sm font-semibold rounded-xl",
            connected ? "bg-red-500/20 text-red-700 dark:text-red-300 border border-red-500/20" : "bg-blue-500/20 text-blue-600 dark:text-blue-300 border border-blue-500/20"
          )}
        >
          {connected ? t('settings.connection.disconnect') : connecting ? t('common.loading') : t('settings.connection.reconnect')}
        </button>
      </div>

      {/* URL & Token */}
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="text-xs font-bold text-muted-foreground uppercase tracking-wider mb-2 block">{t('settings.gatewayConfig.gatewayUrl')}</label>
          <input
            type="url"
            placeholder="ws://localhost:18789"
            value={localUrl}
            onChange={(e) => setLocalUrl(e.target.value)}
            className="w-full px-3 py-2 rounded-lg bg-card border text-foreground text-sm focus:outline-none focus:border-blue-500/40"
          />
        </div>
        <div>
          <label className="text-xs font-bold text-muted-foreground uppercase tracking-wider mb-2 block">{t('settings.gatewayConfig.authToken')}</label>
          <div className="relative">
            <input
              type={showToken ? 'text' : 'password'}
              placeholder={t('settings.gatewayConfig.optional')}
              value={localToken}
              onChange={(e) => setLocalToken(e.target.value)}
              className="w-full px-3 py-2 rounded-lg bg-card border text-foreground text-sm focus:outline-none focus:border-blue-500/40 pr-12"
            />
            <button onClick={() => setShowToken(!showToken)} className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">
              {showToken ? t('connect.hide') : t('connect.show')}
            </button>
          </div>
        </div>
      </div>

      <div className="flex items-center gap-3">
        <button onClick={handleSave} disabled={!hasChanges} className={cn("flex items-center gap-2 px-4 py-2 text-sm font-semibold rounded-lg", hasChanges ? "bg-blue-500/20 text-blue-600 dark:text-blue-300" : "bg-muted text-muted-foreground")}>
          <Save className="w-4 h-4" /> {t('common.save')}
        </button>
        <button onClick={handleReconnect} className="flex items-center gap-2 px-4 py-2 text-sm font-semibold rounded-lg bg-muted text-muted-foreground hover:bg-muted">
          <RefreshCw className="w-4 h-4" /> {t('settings.connection.reconnect')}
        </button>
      </div>
    </div>
  );
}
