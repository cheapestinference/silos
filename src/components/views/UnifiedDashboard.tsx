import { useEffect, useState, useRef } from 'react';
import { useDashboardStore } from '../../store/dashboard-store';
import {
  CheckCircle2,
  AlertCircle,
  ExternalLink,
  BookOpen,
  RefreshCw,
  Loader2,
  XCircle,
  Wifi,
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { Button } from '../ui/button';

// ─── OpenClaw Lobster Logo ───────────────────────────────────────────────────
function OpenClawLogo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 120 120" fill="none" xmlns="http://www.w3.org/2000/svg" className={className}>
      <defs>
        <linearGradient id="oc-dash" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#ff4d4d" />
          <stop offset="100%" stopColor="#991b1b" />
        </linearGradient>
      </defs>
      <path d="M60 10 C30 10 15 35 15 55 C15 75 30 95 45 100 L45 110 L55 110 L55 100 C55 100 60 102 65 100 L65 110 L75 110 L75 100 C90 95 105 75 105 55 C105 35 90 10 60 10Z" fill="url(#oc-dash)" />
      <path d="M20 45 C5 40 0 50 5 60 C10 70 20 65 25 55 C28 48 25 45 20 45Z" fill="url(#oc-dash)" />
      <path d="M100 45 C115 40 120 50 115 60 C110 70 100 65 95 55 C92 48 95 45 100 45Z" fill="url(#oc-dash)" />
      <path d="M45 15 Q35 5 30 8" stroke="#ff4d4d" strokeWidth="3" strokeLinecap="round" />
      <path d="M75 15 Q85 5 90 8" stroke="#ff4d4d" strokeWidth="3" strokeLinecap="round" />
      <circle cx="45" cy="35" r="6" fill="#050810" />
      <circle cx="75" cy="35" r="6" fill="#050810" />
      <circle cx="46" cy="34" r="2.5" fill="#00e5cc" />
      <circle cx="76" cy="34" r="2.5" fill="#00e5cc" />
    </svg>
  );
}

// ─── WhatsApp Icon ────────────────────────────────────────────────────────────
function WhatsAppIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="#25D366" xmlns="http://www.w3.org/2000/svg" className={className}>
      <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z" />
    </svg>
  );
}

export function UnifiedDashboard() {
  const {
    connected,
    loadAll,
    gatewayConfig,
    channels,
    gatewayUrl,
    loadChannels,
    channelsLoading,
    client,
    patchGatewayConfig,
  } = useDashboardStore();
  const navigate = useNavigate();
  const [dataLoaded, setDataLoaded] = useState(false);
  const redirected = useRef(false);

  // WhatsApp data (derived early so useEffect can reference waConnected)
  const waAccounts = channels?.channelAccounts?.['whatsapp'] || [];
  const waConnected = waAccounts.some(a => a.connected);
  const waRunning = waAccounts.some(a => a.running);
  const waError = waAccounts.find(a => a.lastError);
  const waConfigured = waAccounts.length > 0;

  // WhatsApp QR flow state
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [qrMessage, setQrMessage] = useState<string | null>(null);
  const [qrError, setQrError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [waitingForScan, setWaitingForScan] = useState(false);

  useEffect(() => {
    if (connected) {
      loadAll().then(() => setDataLoaded(true));
    }
  }, [connected, loadAll]);

  // Onboarding redirect: guide users to configure providers first
  useEffect(() => {
    if (!dataLoaded || redirected.current) return;
    const config = gatewayConfig?.config as Record<string, unknown> | undefined;
    const modelsConfig = config?.models as { providers?: Record<string, unknown> } | undefined;
    const hasProviders = modelsConfig?.providers && Object.keys(modelsConfig.providers).length > 0;
    if (!hasProviders) {
      redirected.current = true;
      navigate('/settings/models', { replace: true });
    }
  }, [dataLoaded, gatewayConfig, navigate]);

  // Clear QR when WhatsApp connects
  useEffect(() => {
    if (waConnected) {
      setQrDataUrl(null);
      setQrMessage(null);
      setQrError(null);
      setWaitingForScan(false);
      setConnecting(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [waConnected]);

  const handleWaConnect = async () => {
    if (!client) return;
    setConnecting(true);
    setQrDataUrl(null);
    setQrMessage(null);
    setQrError(null);

    try {
      const waitForGateway = async () => {
        for (let i = 0; i < 20; i++) {
          if (client.connected) return true;
          await new Promise(r => setTimeout(r, 500));
        }
        return client.connected;
      };

      const attemptLogin = async () => {
        if (!client.connected) {
          setQrMessage('Esperando gateway...');
          if (!await waitForGateway()) throw new Error('Gateway no disponible');
        }
        setQrMessage(null);
        return await client.webLoginStart(undefined, true);
      };

      let result: { qrDataUrl?: string; message: string };
      try {
        result = await attemptLogin();
      } catch (firstErr) {
        const msg = String(firstErr instanceof Error ? firstErr.message : firstErr);
        if (msg.includes('not connected') || msg.includes('unavailable') || msg.includes('1012')) {
          setQrMessage('Reconectando gateway...');
          await new Promise(r => setTimeout(r, 2000));
          if (!await waitForGateway()) throw new Error('Gateway no reconectó');
          result = await attemptLogin();
        } else {
          throw firstErr;
        }
      }

      if (result.qrDataUrl) {
        setQrDataUrl(result.qrDataUrl);
        setConnecting(false);
        setWaitingForScan(true);

        let paired = false;
        let hadError = false;
        for (let attempt = 0; attempt < 3 && !paired && !hadError; attempt++) {
          try {
            const waitResult = await client.webLoginWait();
            if (waitResult.connected) {
              paired = true;
              setQrDataUrl(null);
              await loadChannels();
            } else if (waitResult.message?.includes('515')) {
              paired = true;
              setQrDataUrl(null);
              setQrMessage('Emparejado. Reiniciando gateway...');
              await patchGatewayConfig({ channels: { whatsapp: {} } }).catch(() => {});
              await new Promise(r => setTimeout(r, 3000));
              for (let poll = 0; poll < 15; poll++) {
                await new Promise(r => setTimeout(r, 2000));
                if (!client.connected) continue;
                try {
                  await loadChannels();
                  const fresh = useDashboardStore.getState().channels;
                  if (fresh?.channelAccounts?.['whatsapp']?.some(a => a.connected)) break;
                } catch { /* gateway restarting */ }
              }
              setQrMessage(null);
            } else {
              setQrMessage('Actualizando QR...');
              try {
                const refresh = await client.webLoginStart(undefined, true);
                if (refresh.qrDataUrl) { setQrDataUrl(refresh.qrDataUrl); setQrMessage(null); }
                else { await loadChannels(); paired = true; }
              } catch { hadError = true; }
            }
          } catch (waitErr) {
            const msg = String(waitErr instanceof Error ? waitErr.message : waitErr);
            setQrDataUrl(null);
            if (msg.includes('515')) {
              paired = true;
              setQrMessage('Emparejado. Reiniciando gateway...');
              await patchGatewayConfig({ channels: { whatsapp: {} } }).catch(() => {});
              await new Promise(r => setTimeout(r, 3000));
              for (let poll = 0; poll < 15; poll++) {
                await new Promise(r => setTimeout(r, 2000));
                if (!client.connected) continue;
                try {
                  await loadChannels();
                  const fresh = useDashboardStore.getState().channels;
                  if (fresh?.channelAccounts?.['whatsapp']?.some(a => a.connected)) break;
                } catch { /* gateway restarting */ }
              }
              setQrMessage(null);
            } else {
              setQrError('Error de conexión. Intenta de nuevo.');
              hadError = true;
            }
          }
        }

        if (!paired && !hadError) {
          setQrError('QR expirado. Intenta de nuevo.');
          setQrDataUrl(null);
        }
        setWaitingForScan(false);
      } else {
        setConnecting(false);
        await loadChannels();
        const fresh = useDashboardStore.getState().channels;
        if (!fresh?.channelAccounts?.['whatsapp']?.some(a => a.connected)) {
          setQrError('No se pudo generar el QR. Intenta de nuevo.');
        }
      }
    } catch (err) {
      const msg = String(err instanceof Error ? err.message : err);
      setQrError(msg.includes('515') ? 'Conflicto de sesión. Intenta de nuevo.' : `Error: ${msg}`);
      setConnecting(false);
    }
  };

  // Derive OpenClaw UI URL from gatewayUrl
  const openClawUiUrl = gatewayUrl ? `${gatewayUrl}/openclaw` : null;

  const waStatus: 'connected' | 'running' | 'error' | 'not-configured' =
    waConnected ? 'connected' :
    waRunning ? 'running' :
    waError ? 'error' :
    'not-configured';

  const waStatusConfig = {
    connected: { icon: CheckCircle2, color: 'text-green-500', bg: 'bg-green-500/10', label: 'Conectado' },
    running: { icon: Loader2, color: 'text-blue-500', bg: 'bg-blue-500/10', label: 'Conectando...' },
    error: { icon: XCircle, color: 'text-red-500', bg: 'bg-red-500/10', label: 'No conectado' },
    'not-configured': { icon: AlertCircle, color: 'text-muted-foreground', bg: 'bg-muted/50', label: 'No conectado' },
  };

  const WaStatus = waStatusConfig[waStatus];
  const WaIcon = WaStatus.icon;

  return (
    <div className="flex flex-col h-full bg-background overflow-y-auto">
      {/* Header */}
      <div className="px-6 py-5 border-b bg-card shadow-sm">
        <h1 className="text-xl font-semibold tracking-tight">Panel principal</h1>
        <p className="text-sm text-muted-foreground mt-0.5">Gestiona tu agente IA</p>
      </div>

      <div className="p-6 max-w-3xl space-y-8">

        {/* ── WhatsApp ─────────────────────────────────────────────────────── */}
        <section>
          <div className="flex items-center gap-2 mb-3">
            <WhatsAppIcon className="w-5 h-5" />
            <h2 className="text-base font-semibold">WhatsApp</h2>
          </div>

          <div className="rounded-xl border bg-card p-5 space-y-4">
            {/* Status */}
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className={`w-10 h-10 rounded-lg flex items-center justify-center ${WaStatus.bg}`}>
                  <WaIcon className={`w-5 h-5 ${WaStatus.color} ${waStatus === 'running' ? 'animate-spin' : ''}`} />
                </div>
                <div>
                  <p className={`text-sm font-semibold ${WaStatus.color}`}>{WaStatus.label}</p>
                </div>
              </div>
              <Button variant="outline" size="sm" onClick={() => loadChannels()} disabled={channelsLoading}>
                <RefreshCw className={`w-3.5 h-3.5 mr-1.5 ${channelsLoading ? 'animate-spin' : ''}`} />
                Actualizar
              </Button>
            </div>

            {/* Accounts list */}
            {waAccounts.length > 0 && (
              <div className="space-y-2">
                {waAccounts.filter(acc => (acc.name || acc.accountId) !== 'default').map(acc => (
                  <div key={acc.accountId} className="flex items-center justify-between px-3 py-2 rounded-lg bg-muted/50 text-sm">
                    <div className="flex items-center gap-2">
                      <span className={`w-2 h-2 rounded-full ${acc.connected ? 'bg-green-500' : acc.running ? 'bg-blue-500 animate-pulse' : 'bg-muted-foreground'}`} />
                      <span className="font-medium">{acc.name || acc.accountId}</span>
                    </div>
                    {!acc.connected && !acc.running && <span className="text-xs text-muted-foreground">No conectado</span>}
                  </div>
                ))}
              </div>
            )}


            {/* QR flow */}
            {qrMessage && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="w-4 h-4 animate-spin" />
                {qrMessage}
              </div>
            )}
            {qrError && (
              <p className="text-sm text-red-500">{qrError}</p>
            )}
            {qrDataUrl && (
              <div className="flex flex-col items-center gap-2 py-2">
                <img src={qrDataUrl} alt="WhatsApp QR" className="w-48 h-48 rounded-lg border" />
                <p className="text-xs text-muted-foreground">Escanea con WhatsApp → Dispositivos vinculados</p>
              </div>
            )}

            {/* Connect button (only when not connected) */}
            {!waConnected && (
              <Button
                className="w-full bg-[#25D366] hover:bg-[#1fb356] text-white"
                disabled={connecting || waitingForScan}
                onClick={handleWaConnect}
              >
                {connecting ? (
                  <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Conectando...</>
                ) : waitingForScan ? (
                  <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Esperando escaneo...</>
                ) : (
                  <><Wifi className="w-4 h-4 mr-2" /> Conectar WhatsApp</>
                )}
              </Button>
            )}
          </div>
        </section>

        {/* ── OpenClaw ─────────────────────────────────────────────────────── */}
        <section>
          <div className="flex items-center gap-3 mb-3">
            <OpenClawLogo className="w-7 h-7" />
            <h2 className="text-base font-semibold">OpenClaw</h2>
          </div>

          <div className="rounded-xl border bg-card p-5">
            <p className="text-sm text-muted-foreground mb-5">
              Accede al panel completo de OpenClaw para gestionar agentes, canales, modelos y toda la configuración avanzada.
            </p>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {/* Big button: OpenClaw UI */}
              <button
                disabled={!openClawUiUrl}
                onClick={() => openClawUiUrl && window.open(openClawUiUrl, '_blank')}
                className="group flex flex-col items-center justify-center gap-3 p-6 rounded-xl border-2 border-red-200 dark:border-red-900/40 bg-red-50 dark:bg-red-950/20 hover:border-red-400 hover:bg-red-100 dark:hover:bg-red-950/40 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <OpenClawLogo className="w-12 h-12 group-hover:scale-110 transition-transform" />
                <div className="text-center">
                  <p className="font-semibold text-sm text-gray-900 dark:text-gray-100">Abrir OpenClaw UI</p>
                  <p className="text-xs text-muted-foreground mt-0.5">Panel completo del agente</p>
                </div>
                <ExternalLink className="w-4 h-4 text-red-400" />
              </button>

              {/* Big button: OpenClaw Docs */}
              <button
                onClick={() => window.open('https://openclaw.ai/docs', '_blank')}
                className="group flex flex-col items-center justify-center gap-3 p-6 rounded-xl border-2 border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900/20 hover:border-gray-400 hover:bg-gray-100 dark:hover:bg-gray-900/40 transition-all"
              >
                <div className="w-12 h-12 rounded-full bg-gray-200 dark:bg-gray-800 flex items-center justify-center group-hover:scale-110 transition-transform">
                  <BookOpen className="w-6 h-6 text-gray-600 dark:text-gray-300" />
                </div>
                <div className="text-center">
                  <p className="font-semibold text-sm text-gray-900 dark:text-gray-100">Documentación</p>
                  <p className="text-xs text-muted-foreground mt-0.5">Guías y referencia de API</p>
                </div>
                <ExternalLink className="w-4 h-4 text-gray-400" />
              </button>
            </div>
          </div>
        </section>

      </div>
    </div>
  );
}
