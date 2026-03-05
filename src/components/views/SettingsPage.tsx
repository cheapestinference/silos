import { useState, useEffect, useMemo, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  Server,
  Moon,
  Sun,
  Wifi,
  WifiOff,
  Save,
  RefreshCw,
  Info,
  Globe,
  Users as _Users,
  MessageSquare,
  Plus,
  Radio as _Radio,
  Zap,
  Edit3,
  Power,
  Trash2,
  Copy,
  Check,
  Cpu,
  Eye,
  EyeOff,
  Bot,
  Wrench,
  Settings2,
  ChevronRight,
  ChevronDown,
  Search,
} from 'lucide-react';
import { Header } from '../layout/Header';
import { useDashboardStore } from '../../store/dashboard-store';
import { cn } from '../../lib/utils';
import useTranslation, { t as tStatic } from '../../i18n';
import type { Locale, TranslationKey } from '../../i18n';
import type { ChannelsStatusSnapshot } from '../../types/openclaw';
import { formatDistanceToNow } from 'date-fns';

// Settings sections configuration
type SettingsSection = 'models' | 'channels' | 'agents' | 'tools' | 'gateway' | 'appearance';

const settingsSections: Array<{
  id: SettingsSection;
  labelKey: TranslationKey;
  icon: React.ReactNode;
  descriptionKey: TranslationKey;
}> = [
  { id: 'models', labelKey: 'settings.providers.title', icon: <Cpu className="w-4 h-4" />, descriptionKey: 'settings.providers.description' },
  { id: 'channels', labelKey: 'settings.channelsConfig.title', icon: <Globe className="w-4 h-4" />, descriptionKey: 'settings.channelsConfig.description' },
  { id: 'agents', labelKey: 'settings.agentsConfig.title', icon: <Bot className="w-4 h-4" />, descriptionKey: 'settings.agentsConfig.description' },
  { id: 'tools', labelKey: 'settings.toolsConfig.title', icon: <Wrench className="w-4 h-4" />, descriptionKey: 'settings.toolsConfig.description' },
  { id: 'gateway', labelKey: 'settings.gatewayConfig.title', icon: <Server className="w-4 h-4" />, descriptionKey: 'settings.gatewayConfig.description' },
  { id: 'appearance', labelKey: 'settings.appearanceConfig.title', icon: <Settings2 className="w-4 h-4" />, descriptionKey: 'settings.appearanceConfig.description' },
];

// Channel Row Component
interface ChannelRowProps {
  channelId: string;
  channels: ChannelsStatusSnapshot | null;
  channelIcons: Record<string, string>;
  onRemove: (channelId: string) => void;
  rawConfig?: Record<string, unknown>;
}

// Channels that support QR code pairing
const QR_CHANNELS = new Set(['whatsapp']);

function ChannelRow({ channelId, channels, channelIcons, onRemove, rawConfig }: ChannelRowProps) {
  const { client, patchGatewayConfig, loadChannels } = useDashboardStore();
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [qrMessage, setQrMessage] = useState<string | null>(null);
  const [qrError, setQrError] = useState<string | null>(null);
  const [waitingForScan, setWaitingForScan] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editConfig, setEditConfig] = useState<Record<string, unknown>>({});
  const [editSaving, setEditSaving] = useState(false);
  const [editPhoneInput, setEditPhoneInput] = useState('');

  const label = channels?.channelLabels?.[channelId] || channelId;
  const accounts = channels?.channelAccounts?.[channelId] || [];
  const connectedAccounts = accounts.filter(a => a.connected);
  const isConnected = connectedAccounts.length > 0;
  const icon = channelIcons[channelId.toLowerCase()] || '🔗';
  const supportsQr = QR_CHANNELS.has(channelId.toLowerCase());

  // Clear QR messages when connection state changes
  useEffect(() => {
    if (isConnected) {
      setQrDataUrl(null);
      setQrMessage(null);
      setQrError(null);
    }
  }, [isConnected]);

  const lastActivity = accounts.reduce((latest, acc) => {
    const times = [acc.lastInboundAt, acc.lastOutboundAt, acc.lastConnectedAt].filter(Boolean) as number[];
    const maxTime = times.length > 0 ? Math.max(...times) : 0;
    return maxTime > latest ? maxTime : latest;
  }, 0);

  const handleDisconnect = async () => {
    if (!client) return;
    setActionLoading('disconnect');
    try {
      await client.logoutChannel(channelId);
      await loadChannels();
    } catch (err) {
      console.error('Logout failed:', err);
    } finally {
      setActionLoading(null);
    }
  };

  const handleConnect = async () => {
    if (!client) return;

    if (supportsQr) {
      setActionLoading('connect');
      setQrDataUrl(null);
      setQrMessage(null);
      setQrError(null);

      try {
        // Helper: wait for gateway to be connected
        const waitForGateway = async () => {
          for (let i = 0; i < 20; i++) {
            if (client.connected) return true;
            await new Promise(r => setTimeout(r, 500));
          }
          return client.connected;
        };

        // Helper: attempt the login flow (may need retry after gateway restart)
        const attemptLogin = async (): Promise<{ qrDataUrl?: string; message: string }> => {
          if (!client.connected) {
            setQrMessage('Waiting for gateway...');
            if (!await waitForGateway()) throw new Error('Gateway unavailable');
          }
          // Only clear stale session if channel is NOT connected (avoid destroying working sessions)
          if (!isConnected) {
            setQrMessage('Clearing stale session...');
            await client.logoutChannel(channelId).catch(() => {});
          }
          setQrMessage(null);
          return await client.webLoginStart(undefined, true);
        };

        // Try login, auto-retry once if gateway disconnects mid-flight
        let result: { qrDataUrl?: string; message: string };
        try {
          result = await attemptLogin();
        } catch (firstErr) {
          const msg = String(firstErr instanceof Error ? firstErr.message : firstErr);
          if (msg.includes('not connected') || msg.includes('unavailable') || msg.includes('1012')) {
            setQrMessage('Gateway restarting, retrying...');
            await new Promise(r => setTimeout(r, 2000));
            if (!await waitForGateway()) throw new Error('Gateway did not reconnect');
            result = await attemptLogin();
          } else {
            throw firstErr;
          }
        }

        if (result.qrDataUrl) {
          setQrDataUrl(result.qrDataUrl);
          setActionLoading(null);
          setWaitingForScan(true);

          // QR scan loop: auto-refresh QR up to 3 times if it expires
          let paired = false;
          let hadError = false;
          for (let qrAttempt = 0; qrAttempt < 3 && !paired && !hadError; qrAttempt++) {
            try {
              const waitResult = await client.webLoginWait();
              if (waitResult.connected) {
                paired = true;
                setQrDataUrl(null);
                await loadChannels();
              } else if (waitResult.message?.includes('515')) {
                // 515 = paired successfully but stream needs restart to start the channel
                paired = true;
                setQrDataUrl(null);
                setQrMessage('Paired! Restarting gateway...');
                // Trigger gateway restart so it picks up saved creds and auto-starts WhatsApp
                await patchGatewayConfig({ channels: { [channelId]: {} } }).catch(() => {});
                // Wait for gateway to restart, reconnect, and WhatsApp to come online
                await new Promise(r => setTimeout(r, 3000));
                for (let poll = 0; poll < 15; poll++) {
                  await new Promise(r => setTimeout(r, 2000));
                  if (!client.connected) continue; // gateway still restarting
                  try {
                    await loadChannels();
                    const fresh = useDashboardStore.getState().channels;
                    const accs = fresh?.channelAccounts?.[channelId] || [];
                    if (accs.some(a => a.connected)) break;
                  } catch { /* gateway not ready yet */ }
                }
                setQrMessage(null);
              } else {
                // QR expired without scanning — request a fresh one
                setQrMessage('Refreshing QR...');
                try {
                  const refresh = await client.webLoginStart(undefined, true);
                  if (refresh.qrDataUrl) {
                    setQrDataUrl(refresh.qrDataUrl);
                    setQrMessage(null);
                  } else {
                    await loadChannels();
                    paired = true;
                  }
                } catch {
                  hadError = true;
                }
              }
            } catch (waitErr) {
              const msg = String(waitErr instanceof Error ? waitErr.message : waitErr);
              setQrDataUrl(null);
              if (msg.includes('515')) {
                // 515 thrown as error = paired but stream needs gateway restart
                paired = true;
                setQrDataUrl(null);
                setQrMessage('Paired! Restarting gateway...');
                await patchGatewayConfig({ channels: { [channelId]: {} } }).catch(() => {});
                await new Promise(r => setTimeout(r, 3000));
                for (let poll = 0; poll < 15; poll++) {
                  await new Promise(r => setTimeout(r, 2000));
                  if (!client.connected) continue;
                  try {
                    await loadChannels();
                    const fresh = useDashboardStore.getState().channels;
                    const accs = fresh?.channelAccounts?.[channelId] || [];
                    if (accs.some(a => a.connected)) break;
                  } catch { /* gateway not ready yet */ }
                }
                setQrMessage(null);
              } else {
                setQrError(t('settings.connectionError'));
                hadError = true;
              }
            }
          }

          if (!paired && !hadError) {
            setQrError(t('settings.qrExpired'));
            setQrDataUrl(null);
          }
          setWaitingForScan(false);
        } else {
          // No QR returned — check if already connected, otherwise error
          setActionLoading(null);
          await loadChannels();
          // Re-check status after loading
          const freshChannels = useDashboardStore.getState().channels;
          const accounts = freshChannels?.channelAccounts?.[channelId] || [];
          const nowConnected = accounts.some(a => a.connected);
          if (!nowConnected) {
            setQrError('Could not generate QR code. Try disconnecting first, then reconnect.');
          }
        }
      } catch (err) {
        const errMsg = String(err instanceof Error ? err.message : err);
        console.warn('WhatsApp login error:', errMsg);
        setQrError(errMsg.includes('515')
          ? 'Session conflict. Click Connect to try again.'
          : `Connection failed: ${errMsg}`);
        setActionLoading(null);
      }
    } else {
      // Non-QR channels: restart gateway to reconnect
      setActionLoading('connect');
      try {
        await patchGatewayConfig({ channels: { [channelId]: {} } });
      } catch (err) {
        console.error('Connect failed:', err);
      } finally {
        setActionLoading(null);
      }
    }
  };

  const handleRemove = async () => {
    if (!confirm(`Remove channel "${label}"? This will delete its configuration.`)) return;
    setActionLoading('remove');
    try {
      await patchGatewayConfig({ channels: { [channelId]: null } });
      onRemove(channelId);
    } catch (err) {
      console.error('Remove failed:', err);
    } finally {
      setActionLoading(null);
    }
  };

  return (
    <div className="rounded-xl border border bg-card overflow-hidden">
      <div className="flex items-center justify-between p-3">
        <div className="flex items-center gap-3">
          <span className="text-xl">{icon}</span>
          <div>
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium text-foreground">{label}</span>
              <div className={cn(
                "flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-semibold",
                isConnected ? "bg-emerald-500/20 text-emerald-600 dark:text-emerald-400" : "bg-muted text-muted-foreground"
              )}>
                <span className={cn("w-1.5 h-1.5 rounded-full", isConnected ? "bg-emerald-400" : "bg-muted-foreground")} />
                {isConnected ? 'Online' : 'Offline'}
              </div>
            </div>
            <div className="flex items-center gap-2 mt-0.5">
              <code className="text-[10px] font-mono text-muted-foreground">{channelId}</code>
              <button
                onClick={() => { navigator.clipboard.writeText(channelId); setCopied(true); setTimeout(() => setCopied(false), 2000); }}
                className="p-0.5 hover:bg-muted rounded"
              >
                {copied ? <Check className="w-2.5 h-2.5 text-emerald-600 dark:text-emerald-400" /> : <Copy className="w-2.5 h-2.5 text-muted-foreground" />}
              </button>
              {lastActivity > 0 && (
                <span className="text-[10px] text-muted-foreground">{formatDistanceToNow(lastActivity, { addSuffix: true })}</span>
              )}
              {accounts.length > 0 && (
                <span className="text-[10px] text-muted-foreground">{connectedAccounts.length}/{accounts.length} accounts</span>
              )}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {isConnected ? (
            <button
              disabled={actionLoading !== null}
              onClick={handleDisconnect}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg text-amber-600 dark:text-amber-400 hover:bg-amber-500/10 border border-amber-500/20"
            >
              {actionLoading === 'disconnect' ? (
                <><div className="w-3 h-3 border-2 border-amber-400 border-t-transparent rounded-full animate-spin" /> Disconnecting...</>
              ) : (
                <><Power className="w-3.5 h-3.5" /> Disconnect</>
              )}
            </button>
          ) : (
            <button
              disabled={actionLoading !== null || waitingForScan}
              onClick={handleConnect}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg text-emerald-600 dark:text-emerald-400 hover:bg-emerald-500/10 border border-emerald-500/20"
            >
              {actionLoading === 'connect' ? (
                <><div className="w-3 h-3 border-2 border-emerald-400 border-t-transparent rounded-full animate-spin" /> Connecting...</>
              ) : (
                <><Power className="w-3.5 h-3.5" /> Connect</>
              )}
            </button>
          )}
          <button
            onClick={() => {
              if (editing) {
                setEditing(false);
              } else {
                setEditConfig(rawConfig ? { ...rawConfig } : {});
                setEditPhoneInput('');
                setEditing(true);
              }
            }}
            className={cn(
              "flex items-center gap-1.5 px-2 py-1.5 text-xs font-semibold rounded-lg",
              editing ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/30"
            )}
          >
            <Edit3 className="w-3.5 h-3.5" />
          </button>
          <button
            disabled={actionLoading !== null}
            onClick={handleRemove}
            className="flex items-center gap-1.5 px-2 py-1.5 text-xs font-semibold rounded-lg text-red-600 dark:text-red-400 hover:bg-red-500/10"
          >
            {actionLoading === 'remove' ? (
              <div className="w-3 h-3 border-2 border-red-400 border-t-transparent rounded-full animate-spin" />
            ) : (
              <Trash2 className="w-3.5 h-3.5" />
            )}
          </button>
        </div>
      </div>

      {/* Edit Panel */}
      {editing && channelPresets[channelId.toLowerCase()] && (
        <div className="border-t border p-4 space-y-3">
          {channelPresets[channelId.toLowerCase()].fields.map((field) => (
            <div key={field.key}>
              <label className="text-xs font-bold text-muted-foreground uppercase tracking-wider mb-1 block">
                {field.label}
              </label>
              {field.description && (
                <p className="text-[10px] text-muted-foreground mb-1">{field.description}</p>
              )}

              {field.type === 'select' && (
                <div className="flex flex-wrap gap-2">
                  {field.options?.map((opt) => (
                    <button
                      key={opt.value}
                      onClick={() => {
                        const updated = { ...editConfig, [field.key]: opt.value };
                        if (field.key === 'dmPolicy' && opt.value === 'open') {
                          updated.allowFrom = ['*'];
                        }
                        setEditConfig(updated);
                      }}
                      className={cn(
                        "px-3 py-1.5 text-xs rounded-lg border transition-colors",
                        editConfig[field.key] === opt.value
                          ? "bg-teal-500/20 text-teal-600 dark:text-teal-300 border-teal-500/40"
                          : "bg-muted text-muted-foreground border hover:border"
                      )}
                    >
                      <span className="font-medium">{opt.label}</span>
                      {opt.description && <span className="text-muted-foreground ml-1">— {opt.description}</span>}
                    </button>
                  ))}
                </div>
              )}

              {field.type === 'text' && (
                <input
                  type={field.key.toLowerCase().includes('token') || field.key.toLowerCase().includes('key') ? 'password' : 'text'}
                  placeholder={field.placeholder}
                  value={(editConfig[field.key] as string) || ''}
                  onChange={(e) => setEditConfig({ ...editConfig, [field.key]: e.target.value })}
                  className="w-full px-3 py-2 rounded-lg bg-muted border border text-foreground text-sm font-mono focus:outline-none focus:border-teal-500/50"
                />
              )}

              {field.type === 'phone-list' && (
                <div className="space-y-2">
                  <div className="flex flex-wrap gap-1.5">
                    {((editConfig[field.key] as string[]) || []).map((phone, i) => (
                      <span key={i} className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-teal-500/15 text-teal-600 dark:text-teal-300 text-xs font-mono">
                        {phone}
                        <button
                          onClick={() => {
                            const list = [...((editConfig[field.key] as string[]) || [])];
                            list.splice(i, 1);
                            setEditConfig({ ...editConfig, [field.key]: list });
                          }}
                          className="ml-0.5 text-teal-600 dark:text-teal-500 hover:text-red-600 dark:text-red-400"
                        >×</button>
                      </span>
                    ))}
                  </div>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      placeholder={field.placeholder}
                      value={editPhoneInput}
                      onChange={(e) => setEditPhoneInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && editPhoneInput.trim()) {
                          const list = [...((editConfig[field.key] as string[]) || []), editPhoneInput.trim()];
                          setEditConfig({ ...editConfig, [field.key]: list });
                          setEditPhoneInput('');
                        }
                      }}
                      className="flex-1 px-3 py-1.5 rounded-lg bg-muted border border text-foreground text-sm font-mono focus:outline-none focus:border-teal-500/50"
                    />
                    <button
                      onClick={() => {
                        if (editPhoneInput.trim()) {
                          const list = [...((editConfig[field.key] as string[]) || []), editPhoneInput.trim()];
                          setEditConfig({ ...editConfig, [field.key]: list });
                          setEditPhoneInput('');
                        }
                      }}
                      className="px-3 py-1.5 text-xs font-semibold rounded-lg bg-muted text-muted-foreground hover:bg-muted"
                    >
                      Add
                    </button>
                  </div>
                </div>
              )}

              {field.type === 'toggle' && (
                <button
                  onClick={() => setEditConfig({ ...editConfig, [field.key]: !editConfig[field.key] })}
                  className={cn(
                    "w-10 h-5 rounded-full transition-colors relative",
                    editConfig[field.key] ? "bg-teal-500/40" : "bg-muted"
                  )}
                >
                  <span className={cn(
                    "absolute top-0.5 w-4 h-4 rounded-full transition-all",
                    editConfig[field.key] ? "right-0.5 bg-teal-400" : "left-0.5 bg-muted-foreground"
                  )} />
                </button>
              )}
            </div>
          ))}

          <div className="flex justify-end gap-2 pt-2">
            <button
              onClick={() => setEditing(false)}
              className="px-3 py-1.5 text-xs font-semibold rounded-lg bg-muted text-muted-foreground hover:bg-muted"
            >
              Cancel
            </button>
            <button
              disabled={editSaving}
              onClick={async () => {
                setEditSaving(true);
                try {
                  const cleanConfig: Record<string, unknown> = {};
                  for (const [k, v] of Object.entries(editConfig)) {
                    if (v === '' || v === undefined || v === null) continue;
                    if (Array.isArray(v) && v.length === 0) continue;
                    cleanConfig[k] = v;
                  }
                  // Force WhatsApp defaults on edit too
                  if (channelId.toLowerCase() === 'whatsapp') {
                    cleanConfig.dmPolicy = 'allowlist';
                    cleanConfig.groupPolicy = 'allowlist';
                    cleanConfig.selfChatMode = true;
                    cleanConfig.sendReadReceipts = true;
                  }
                  await patchGatewayConfig({ channels: { [channelId]: cleanConfig } });
                  setEditing(false);
                } catch (err) {
                  console.error('Save channel config failed:', err);
                } finally {
                  setEditSaving(false);
                }
              }}
              className={cn(
                "px-3 py-1.5 text-xs font-semibold rounded-lg flex items-center gap-1.5",
                !editSaving ? "bg-teal-500/30 text-teal-600 dark:text-teal-300 hover:bg-teal-500/40" : "bg-muted text-muted-foreground cursor-not-allowed"
              )}
            >
              {editSaving && <div className="w-3 h-3 border-2 border-teal-300 border-t-transparent rounded-full animate-spin" />}
              {editSaving ? 'Saving...' : 'Save'}
            </button>
          </div>
        </div>
      )}

      {/* QR Code Panel */}
      {(qrDataUrl || qrMessage || qrError) && (
        <div className="border-t border p-4">
          {qrDataUrl && (
            <div className="flex flex-col items-center gap-3">
              <p className="text-xs text-muted-foreground text-center">
                Open WhatsApp on your phone → Settings → Linked Devices → Link a Device
              </p>
              <div className="bg-white p-3 rounded-xl">
                <img src={qrDataUrl} alt="WhatsApp QR Code" className="w-48 h-48" />
              </div>
              {waitingForScan && (
                <div className="flex items-center gap-2 text-xs text-teal-600 dark:text-teal-400">
                  <div className="w-3 h-3 border-2 border-teal-400 border-t-transparent rounded-full animate-spin" />
                  Waiting for scan...
                </div>
              )}
              <button
                onClick={() => { setQrDataUrl(null); setQrMessage(null); setQrError(null); }}
                className="text-xs text-muted-foreground hover:text-foreground"
              >
                Cancel
              </button>
            </div>
          )}
          {!qrDataUrl && qrMessage && !qrError && (
            <div className="flex items-center gap-2 text-xs text-emerald-600 dark:text-emerald-400">
              <Check className="w-4 h-4" /> {qrMessage}
            </div>
          )}
          {qrError && (
            <div className="flex items-center justify-between">
              <span className="text-xs text-red-600 dark:text-red-400">{qrError}</span>
              <button
                onClick={() => { setQrError(null); handleConnect(); }}
                className="text-xs text-teal-600 dark:text-teal-400 hover:text-teal-600 dark:text-teal-300 font-semibold"
              >
                Try Again
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ==================== SECTION COMPONENTS ====================

function ModelsSection() {
  const { t } = useTranslation();
  const { gatewayConfig, gatewayConfigLoading, loadGatewayConfig, addModelProvider, deleteModelProvider, token: gatewayToken, models: dynamicModels, availableModels } = useDashboardStore();
  const [expandedProvider, setExpandedProvider] = useState<string | null>(null);
  const [showApiKey, setShowApiKey] = useState<Record<string, boolean>>({});
  const [showAddProvider, setShowAddProvider] = useState(false);
  const [newProvider, setNewProvider] = useState<{ id: string; baseUrl: string; apiKey: string; api: string; models?: ModelDef[] }>({ id: '', baseUrl: '', apiKey: '', api: 'openai-completions' });
  const [savingProvider, setSavingProvider] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; models?: ModelDef[]; error?: string } | null>(null);
  const [deletingProvider, setDeletingProvider] = useState<string | null>(null);
  const [editingProvider, setEditingProvider] = useState<string | null>(null);
  const [editProvider, setEditProvider] = useState<{ baseUrl: string; apiKey: string; api: string; models?: ModelDef[] }>({ baseUrl: '', apiKey: '', api: '' });
  const [editSaving, setEditSaving] = useState(false);
  const [editTesting, setEditTesting] = useState(false);
  const [editTestResult, setEditTestResult] = useState<{ ok: boolean; models?: ModelDef[]; error?: string } | null>(null);

  // Get providers from the config
  const configProviders = (gatewayConfig?.config as Record<string, unknown>)?.models as { providers?: Record<string, unknown> } | undefined;
  const providers = configProviders?.providers ?? {};

  // Silos subscription provider
  const defaultProvider = {
    id: 'silos',
    name: tStatic('settings.providers.subscription'),
    isDefault: true,
    description: tStatic('settings.providers.subscriptionDesc'),
  };

  type ModelDef = { id: string; name: string; contextWindow: number; reasoning?: boolean };
  const providerPresets: Record<string, { baseUrl: string; api: string }> = {
    anthropic: { baseUrl: 'https://api.anthropic.com/v1', api: 'anthropic-messages' },
    openai: { baseUrl: 'https://api.openai.com/v1', api: 'openai-completions' },
    google: { baseUrl: 'https://generativelanguage.googleapis.com/v1beta', api: 'google-generative-ai' },
    groq: { baseUrl: 'https://api.groq.com/openai/v1', api: 'openai-completions' },
    together: { baseUrl: 'https://api.together.xyz/v1', api: 'openai-completions' },
    deepseek: { baseUrl: 'https://api.deepseek.com/v1', api: 'openai-completions' },
    ollama: { baseUrl: 'http://localhost:11434/v1', api: 'openai-completions' },
  };

  const getProviderIcon = (id: string) => {
    const lower = id.toLowerCase();
    if (lower.includes('silos')) return '🔮';
    if (lower.includes('anthropic') || lower.includes('claude')) return '🟣';
    if (lower.includes('openai') || lower.includes('gpt')) return '🟢';
    if (lower.includes('google') || lower.includes('gemini')) return '🔵';
    if (lower.includes('bedrock') || lower.includes('aws')) return '🟠';
    if (lower.includes('together')) return '🟡';
    if (lower.includes('groq')) return '⚡';
    if (lower.includes('ollama')) return '🦙';
    if (lower.includes('deepseek')) return '🔷';
    return '🤖';
  };

  const testConnection = async () => {
    if (!newProvider.baseUrl) return;
    setTesting(true);
    setTestResult(null);

    try {
      const isAnthropic = newProvider.api === 'anthropic-messages';
      const targetHeaders: Record<string, string> = {};

      if (newProvider.apiKey) {
        if (isAnthropic) {
          targetHeaders['x-api-key'] = newProvider.apiKey;
          targetHeaders['anthropic-version'] = '2023-06-01';
        } else {
          targetHeaders['Authorization'] = `Bearer ${newProvider.apiKey}`;
        }
      }

      const targetUrl = `${newProvider.baseUrl.replace(/\/+$/, '')}/models`;

      // Use our backend proxy to avoid CORS
      const proxyHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
      if (gatewayToken) proxyHeaders['Authorization'] = `Bearer ${gatewayToken}`;
      const response = await fetch('/api/proxy-test', {
        method: 'POST',
        headers: proxyHeaders,
        body: JSON.stringify({ url: targetUrl, headers: targetHeaders }),
      });

      const result = await response.json();

      if (result.error) {
        throw new Error(result.error);
      }

      if (!result.ok) {
        throw new Error(`HTTP ${result.status}: ${(result.body || result.statusText || '').slice(0, 200)}`);
      }

      const data = JSON.parse(result.body);

      // Parse models from response (OpenAI format: { data: [...] })
      const rawModels: Array<{ id: string; created?: number; context_window?: number }> =
        Array.isArray(data?.data) ? data.data :
        Array.isArray(data) ? data : [];

      const fetchedModels: ModelDef[] = rawModels.map(m => ({
        id: m.id,
        name: m.id,
        contextWindow: m.context_window || 128000,
        reasoning: /^o[0-9]|reason|think/i.test(m.id),
      }));

      // Auto-apply fetched models
      if (fetchedModels.length > 0) {
        setNewProvider(prev => ({ ...prev, models: fetchedModels }));
      }
      setTestResult({ ok: true, models: fetchedModels });
    } catch (err: unknown) {
      const msg = String(err instanceof Error ? err.message : err);
      setTestResult({ ok: false, error: msg });
    } finally {
      setTesting(false);
    }
  };

  // Check if silos is already in providers from backend
  const hasSilosFromBackend = 'silos' in providers;

  useEffect(() => {
    loadGatewayConfig();
  }, [loadGatewayConfig]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">{t('settings.providers.configure')}</p>
        <button
          onClick={() => setShowAddProvider(!showAddProvider)}
          className={cn(
            "flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg transition-colors",
            showAddProvider
              ? "bg-muted text-foreground"
              : "bg-purple-500/20 text-purple-600 dark:text-purple-300 border border-purple-500/30 hover:bg-purple-500/30"
          )}
        >
          <Plus className="w-3.5 h-3.5" /> {t('settings.providers.addProvider')}
        </button>
      </div>

      {/* Add Provider Form */}
      {showAddProvider && (
        <div className="p-4 rounded-xl bg-card border border-purple-500/30 space-y-4">
          <h3 className="text-sm font-semibold text-foreground">{t('settings.providers.addNewProvider')}</h3>
          <div className="flex flex-wrap gap-2">
            {Object.keys(providerPresets).map((preset) => (
              <button
                key={preset}
                onClick={() => {
                  setNewProvider({
                    ...newProvider,
                    id: preset,
                    baseUrl: providerPresets[preset].baseUrl,
                    api: providerPresets[preset].api,
                    models: undefined,
                  });
                  setTestResult(null);
                }}
                className={cn(
                  "px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors",
                  newProvider.id === preset
                    ? "bg-purple-500/30 text-purple-600 dark:text-purple-300 border-purple-500/50"
                    : "bg-muted text-muted-foreground border hover:border"
                )}
              >
                {getProviderIcon(preset)} {preset}
              </button>
            ))}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <input
              type="text"
              autoComplete="off"
              placeholder={t('settings.providers.providerId')}
              value={newProvider.id}
              onChange={(e) => setNewProvider({ ...newProvider, id: e.target.value })}
              className="px-3 py-2 rounded-lg bg-muted border border text-foreground text-sm focus:outline-none focus:border-purple-500/50"
            />
            <input
              type="text"
              autoComplete="off"
              placeholder={t('settings.providers.baseUrl')}
              value={newProvider.baseUrl}
              onChange={(e) => { setNewProvider({ ...newProvider, baseUrl: e.target.value }); setTestResult(null); }}
              className="px-3 py-2 rounded-lg bg-muted border border text-foreground text-sm font-mono focus:outline-none focus:border-purple-500/50"
            />
          </div>
          <input
            type="password"
            autoComplete="new-password"
            placeholder={t('settings.providers.apiKey')}
            value={newProvider.apiKey}
            onChange={(e) => { setNewProvider({ ...newProvider, apiKey: e.target.value }); setTestResult(null); }}
            className="w-full px-3 py-2 rounded-lg bg-muted border border text-foreground text-sm font-mono focus:outline-none focus:border-purple-500/50"
          />
          {/* Test Connection */}
          <div className="flex items-center gap-2">
            <button
              disabled={!newProvider.baseUrl || testing}
              onClick={testConnection}
              className={cn(
                "flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg transition-colors",
                newProvider.baseUrl && !testing
                  ? "bg-teal-500/20 text-teal-600 dark:text-teal-300 border border-teal-500/30 hover:bg-teal-500/30"
                  : "bg-muted text-muted-foreground cursor-not-allowed"
              )}
            >
              {testing ? (
                <><div className="w-3 h-3 border-2 border-teal-300 border-t-transparent rounded-full animate-spin" /> {t('settings.providers.testing')}</>
              ) : (
                <><Zap className="w-3.5 h-3.5" /> {t('settings.providers.testConnection')}</>
              )}
            </button>
            {testResult && !testResult.ok && (
              <span className="text-xs text-red-600 dark:text-red-400">{testResult.error}</span>
            )}
          </div>

          {/* Test Result - Fetched Models */}
          {testResult?.ok && (
            <div className="p-3 rounded-lg bg-emerald-500/10 border border-emerald-500/30 space-y-2">
              <div className="flex items-center gap-2">
                <Check className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
                <span className="text-xs font-semibold text-emerald-700 dark:text-emerald-300">
                  Connection OK — {testResult.models?.length || 0} models found
                </span>
              </div>
              {testResult.models && testResult.models.length > 0 && (
                <div className="max-h-32 overflow-y-auto space-y-0.5">
                  {testResult.models.map(m => (
                    <div key={m.id} className="text-[11px] font-mono text-muted-foreground px-2 py-0.5 rounded bg-muted">
                      {m.id}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {saveError && (
            <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/30 text-xs text-red-600 dark:text-red-400">
              {saveError}
            </div>
          )}
          <div className="flex justify-end gap-2">
            <button
              onClick={() => {
                setShowAddProvider(false);
                setNewProvider({ id: '', baseUrl: '', apiKey: '', api: 'openai-completions', models: undefined });
                setSaveError(null);
                setTestResult(null);
              }}
              className="px-3 py-1.5 text-xs font-semibold rounded-lg bg-muted text-muted-foreground hover:bg-muted"
            >
              {t('common.cancel')}
            </button>
            <button
              disabled={!newProvider.id || !newProvider.baseUrl || savingProvider || !testResult?.ok}
              onClick={async () => {
                setSavingProvider(true);
                setSaveError(null);
                setSaveSuccess(false);
                try {
                  const success = await addModelProvider(newProvider.id, {
                    baseUrl: newProvider.baseUrl,
                    apiKey: newProvider.apiKey || undefined,
                    api: newProvider.api,
                    models: newProvider.models,
                  });
                  if (success) {
                    setSaveSuccess(true);
                    setShowAddProvider(false);
                    setNewProvider({ id: '', baseUrl: '', apiKey: '', api: 'openai-completions', models: undefined });
                    // Clear success message after 5 seconds
                    setTimeout(() => setSaveSuccess(false), 5000);
                  } else {
                    setSaveError(t('settings.providers.addFailed'));
                  }
                } catch (err) {
                  setSaveError(String(err));
                } finally {
                  setSavingProvider(false);
                }
              }}
              className={cn(
                "px-3 py-1.5 text-xs font-semibold rounded-lg flex items-center gap-1.5",
                newProvider.id && newProvider.baseUrl && !savingProvider && testResult?.ok
                  ? "bg-purple-500/30 text-purple-600 dark:text-purple-300 hover:bg-purple-500/40"
                  : "bg-muted text-muted-foreground cursor-not-allowed"
              )}
            >
              {savingProvider && <div className="w-3 h-3 border-2 border-purple-300 border-t-transparent rounded-full animate-spin" />}
              {savingProvider ? t('settings.providers.saving') : t('settings.providers.addProvider')}
            </button>
          </div>
        </div>
      )}

      {/* Success Message */}
      {saveSuccess && (
        <div className="p-3 rounded-xl bg-emerald-500/10 border border-emerald-500/30 flex items-center gap-3">
          <Check className="w-5 h-5 text-emerald-600 dark:text-emerald-400" />
          <div>
            <p className="text-sm font-medium text-emerald-700 dark:text-emerald-300">Provider added successfully!</p>
            <p className="text-xs text-muted-foreground">{t('settings.providers.gatewayRestart')}</p>
          </div>
        </div>
      )}

      {/* Providers List */}
      {gatewayConfigLoading ? (
        <div className="p-8 text-center rounded-xl bg-card border border">
          <div className="w-6 h-6 border-2 border-purple-500 border-t-transparent rounded-full animate-spin mx-auto mb-3" />
          <p className="text-sm text-muted-foreground">Loading providers...</p>
        </div>
      ) : (
        <div className="space-y-2">
          {/* Silos Subscription Provider - Always shown first, collapsed by default */}
          {!hasSilosFromBackend && (() => {
            const silosModels = dynamicModels?.models?.filter(m => m.provider === 'silos') ?? [];
            const silosExpanded = expandedProvider === '__silos_default__';
            return (
              <div className="rounded-xl border border-purple-500/30 overflow-hidden bg-gradient-to-r from-purple-500/5 to-pink-500/5">
                <button
                  onClick={() => setExpandedProvider(silosExpanded ? null : '__silos_default__')}
                  className="w-full flex items-center gap-3 p-4 hover:bg-muted/50 transition-colors"
                >
                  <span className="text-2xl">{getProviderIcon('silos')}</span>
                  <div className="text-left">
                    <h3 className="font-semibold text-foreground">{defaultProvider.name}</h3>
                    <p className="text-xs text-muted-foreground">{defaultProvider.description}</p>
                  </div>
                  <div className="ml-auto flex items-center gap-2">
                    {silosModels.length > 0 && (
                      <span className="px-2 py-0.5 text-xs font-medium rounded bg-purple-500/20 text-purple-600 dark:text-purple-300">
                        {silosModels.length} model{silosModels.length !== 1 ? 's' : ''}
                      </span>
                    )}
                    <span className="px-2 py-0.5 text-xs font-medium rounded bg-emerald-500/20 text-emerald-600 dark:text-emerald-400">Active</span>
                    <ChevronDown className={`w-4 h-4 text-muted-foreground transition-transform ${silosExpanded ? 'rotate-180' : ''}`} />
                  </div>
                </button>
                {silosExpanded && silosModels.length > 0 && (
                  <div className="border-t border-purple-500/20 px-4 py-3">
                    <div className="space-y-1 max-h-64 overflow-y-auto">
                      {silosModels.map((model) => (
                        <div key={model.id} className="flex items-center justify-between py-1.5 px-2 rounded-lg hover:bg-muted/50">
                          <div className="flex items-center gap-2">
                            <Cpu className="w-3.5 h-3.5 text-purple-600 dark:text-purple-400" />
                            <span className="text-sm text-foreground">{model.name || model.id}</span>
                          </div>
                          <div className="flex items-center gap-2">
                            {model.contextWindow && (
                              <span className="text-[10px] text-muted-foreground">{Math.round(model.contextWindow / 1000)}k ctx</span>
                            )}
                            <code className="text-[10px] text-muted-foreground font-mono">{model.id}</code>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            );
          })()}

          {/* Backend Providers from Config */}
          {Object.keys(providers).length > 0 ? (
            Object.entries(providers).map(([providerId, providerData]) => {
              const provider = providerData as { baseUrl?: string; apiKey?: string; api?: string; models?: Array<{ id: string; name?: string; contextWindow?: number; reasoning?: boolean; input?: string[] }> };
              const isExpanded = expandedProvider === providerId;
              const modelCount = availableModels?.[providerId]?.length || provider.models?.length || 0;
              const isSilos = providerId.toLowerCase() === 'silos';

              // Silos from backend: show subscription card with collapsible model list
              if (isSilos) {
                const fetchedModels = availableModels?.['silos'] ?? [];
                const dynamicSilosModels = dynamicModels?.models?.filter(m => m.provider === 'silos') ?? [];
                const staticModels = provider.models?.map(m => ({ id: m.id, name: m.name || m.id, contextWindow: m.contextWindow })) ?? [];
                const silosModels = fetchedModels.length > 0 ? fetchedModels : dynamicSilosModels.length > 0 ? dynamicSilosModels : staticModels;
                const silosExpanded = expandedProvider === 'silos';
                return (
                  <div key={providerId} className="rounded-xl border border-purple-500/30 overflow-hidden bg-gradient-to-r from-purple-500/5 to-pink-500/5">
                    <button
                      onClick={() => setExpandedProvider(silosExpanded ? null : 'silos')}
                      className="w-full flex items-center gap-3 p-4 hover:bg-muted/50 transition-colors"
                    >
                      <span className="text-2xl">{getProviderIcon('silos')}</span>
                      <div className="text-left">
                        <h3 className="font-semibold text-foreground">Silos Subscription</h3>
                        <p className="text-xs text-muted-foreground">Included with your Silos plan</p>
                      </div>
                      <div className="ml-auto flex items-center gap-2">
                        <span className="px-2 py-0.5 text-xs font-medium rounded bg-purple-500/20 text-purple-600 dark:text-purple-300">
                          {silosModels.length} model{silosModels.length !== 1 ? 's' : ''}
                        </span>
                        <span className="px-2 py-0.5 text-xs font-medium rounded bg-emerald-500/20 text-emerald-600 dark:text-emerald-400">Active</span>
                        <ChevronDown className={`w-4 h-4 text-muted-foreground transition-transform ${silosExpanded ? 'rotate-180' : ''}`} />
                      </div>
                    </button>
                    {silosExpanded && silosModels.length > 0 && (
                      <div className="border-t border-purple-500/20 px-4 py-3">
                        <div className="space-y-1 max-h-64 overflow-y-auto">
                          {silosModels.map((model) => (
                            <div key={model.id} className="flex items-center justify-between py-1.5 px-2 rounded-lg hover:bg-muted/50">
                              <div className="flex items-center gap-2">
                                <Cpu className="w-3.5 h-3.5 text-purple-600 dark:text-purple-400" />
                                <span className="text-sm text-foreground">{model.name || model.id}</span>
                              </div>
                              <div className="flex items-center gap-2">
                                {model.contextWindow && (
                                  <span className="text-[10px] text-muted-foreground">{Math.round(model.contextWindow / 1000)}k ctx</span>
                                )}
                                <code className="text-[10px] text-muted-foreground font-mono">{model.id}</code>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                );
              }

              return (
                <div key={providerId} className="rounded-xl border overflow-hidden border bg-card">
                  <button
                    onClick={() => setExpandedProvider(isExpanded ? null : providerId)}
                    className="w-full flex items-center justify-between p-4 hover:bg-muted transition-colors"
                  >
                    <div className="flex items-center gap-3">
                      <span className="text-2xl">{getProviderIcon(providerId)}</span>
                      <div className="text-left">
                        <h3 className="font-semibold text-foreground">{providerId}</h3>
                        <p className="text-xs text-muted-foreground">{provider.baseUrl || 'Default'}</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="px-2 py-0.5 text-xs font-medium rounded bg-purple-500/20 text-purple-600 dark:text-purple-300">
                        {modelCount} model{modelCount !== 1 ? 's' : ''}
                      </span>
                      <span className={cn(
                        "px-2 py-0.5 text-xs font-medium rounded",
                        provider.apiKey ? "bg-emerald-500/20 text-emerald-600 dark:text-emerald-400" : "bg-amber-500/20 text-amber-600 dark:text-amber-400"
                      )}>
                        {provider.apiKey ? 'Configured' : 'No Key'}
                      </span>
                      <ChevronRight className={cn("w-4 h-4 text-muted-foreground transition-transform", isExpanded && "rotate-90")} />
                    </div>
                  </button>

                  {isExpanded && (
                    <div className="border-t border p-4 space-y-4">
                      {editingProvider === providerId ? (
                        /* Edit Mode */
                        <>
                          {/* API Type */}
                          <div>
                            <label className="text-xs font-bold text-muted-foreground uppercase tracking-wider mb-1.5 block">API Type</label>
                            <div className="flex flex-wrap gap-2">
                              {[
                                { value: 'openai-completions', label: 'OpenAI Compatible' },
                                { value: 'anthropic-messages', label: 'Anthropic' },
                                { value: 'google-generative-ai', label: 'Google' },
                              ].map((opt) => (
                                <button
                                  key={opt.value}
                                  onClick={() => { setEditProvider({ ...editProvider, api: opt.value }); setEditTestResult(null); }}
                                  className={cn(
                                    "px-3 py-1.5 text-xs rounded-lg border transition-colors",
                                    editProvider.api === opt.value
                                      ? "bg-purple-500/20 text-purple-600 dark:text-purple-300 border-purple-500/40"
                                      : "bg-muted text-muted-foreground border hover:border"
                                  )}
                                >
                                  {opt.label}
                                </button>
                              ))}
                            </div>
                          </div>
                          <div className="grid grid-cols-2 gap-3">
                            <div>
                              <label className="text-xs font-bold text-muted-foreground uppercase tracking-wider mb-1 block">Base URL</label>
                              <input
                                type="text"
                                autoComplete="off"
                                placeholder={t('settings.providers.baseUrl')}
                                value={editProvider.baseUrl}
                                onChange={(e) => { setEditProvider({ ...editProvider, baseUrl: e.target.value }); setEditTestResult(null); }}
                                className="w-full px-3 py-2 rounded-lg bg-muted border border text-foreground text-sm font-mono focus:outline-none focus:border-purple-500/50"
                              />
                            </div>
                            <div>
                              <label className="text-xs font-bold text-muted-foreground uppercase tracking-wider mb-1 block">API Key</label>
                              <input
                                type="password"
                                autoComplete="new-password"
                                placeholder={t('settings.providers.apiKey')}
                                value={editProvider.apiKey}
                                onChange={(e) => { setEditProvider({ ...editProvider, apiKey: e.target.value }); setEditTestResult(null); }}
                                className="w-full px-3 py-2 rounded-lg bg-muted border border text-foreground text-sm font-mono focus:outline-none focus:border-purple-500/50"
                              />
                            </div>
                          </div>
                          {/* Test Connection */}
                          <div className="flex items-center gap-2">
                            <button
                              disabled={!editProvider.baseUrl || editTesting}
                              onClick={async () => {
                                setEditTesting(true);
                                setEditTestResult(null);
                                try {
                                  const isAnthropic = editProvider.api === 'anthropic-messages';
                                  const targetHeaders: Record<string, string> = {};
                                  if (editProvider.apiKey) {
                                    if (isAnthropic) {
                                      targetHeaders['x-api-key'] = editProvider.apiKey;
                                      targetHeaders['anthropic-version'] = '2023-06-01';
                                    } else {
                                      targetHeaders['Authorization'] = `Bearer ${editProvider.apiKey}`;
                                    }
                                  }
                                  const targetUrl = `${editProvider.baseUrl.replace(/\/+$/, '')}/models`;
                                  const editProxyHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
                                  if (gatewayToken) editProxyHeaders['Authorization'] = `Bearer ${gatewayToken}`;
                                  const response = await fetch('/api/proxy-test', {
                                    method: 'POST',
                                    headers: editProxyHeaders,
                                    body: JSON.stringify({ url: targetUrl, headers: targetHeaders }),
                                  });
                                  const result = await response.json();
                                  if (result.error) throw new Error(result.error);
                                  if (!result.ok) throw new Error(`HTTP ${result.status}: ${(result.body || '').slice(0, 200)}`);
                                  const data = JSON.parse(result.body);
                                  const rawModels: Array<{ id: string; context_window?: number }> =
                                    Array.isArray(data?.data) ? data.data : Array.isArray(data) ? data : [];
                                  const fetchedModels: ModelDef[] = rawModels.map(m => ({
                                    id: m.id, name: m.id,
                                    contextWindow: m.context_window || 128000,
                                    reasoning: /^o[0-9]|reason|think/i.test(m.id),
                                  }));
                                  if (fetchedModels.length > 0) {
                                    setEditProvider(prev => ({ ...prev, models: fetchedModels }));
                                  }
                                  setEditTestResult({ ok: true, models: fetchedModels });
                                } catch (err: unknown) {
                                  setEditTestResult({ ok: false, error: String(err instanceof Error ? err.message : err) });
                                } finally {
                                  setEditTesting(false);
                                }
                              }}
                              className={cn(
                                "flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg transition-colors",
                                editProvider.baseUrl && !editTesting
                                  ? "bg-teal-500/20 text-teal-600 dark:text-teal-300 border border-teal-500/30 hover:bg-teal-500/30"
                                  : "bg-muted text-muted-foreground cursor-not-allowed"
                              )}
                            >
                              {editTesting ? (
                                <><div className="w-3 h-3 border-2 border-teal-300 border-t-transparent rounded-full animate-spin" /> Testing...</>
                              ) : (
                                <><Zap className="w-3.5 h-3.5" /> Test Connection</>
                              )}
                            </button>
                            {editTestResult && !editTestResult.ok && (
                              <span className="text-xs text-red-600 dark:text-red-400">{editTestResult.error}</span>
                            )}
                            {editTestResult?.ok && (
                              <span className="text-xs text-emerald-600 dark:text-emerald-400 flex items-center gap-1">
                                <Check className="w-3 h-3" /> {editTestResult.models?.length || 0} models found
                              </span>
                            )}
                          </div>
                          {/* Models preview */}
                          {editTestResult?.ok && editTestResult.models && editTestResult.models.length > 0 && (
                            <div>
                              <label className="text-xs font-bold text-muted-foreground uppercase tracking-wider mb-1 block">Models ({editTestResult.models.length})</label>
                              <div className="max-h-32 overflow-y-auto space-y-0.5">
                                {editTestResult.models.map(m => (
                                  <div key={m.id} className="text-[11px] font-mono text-muted-foreground px-2 py-0.5 rounded bg-muted">
                                    {m.id}
                                  </div>
                                ))}
                              </div>
                            </div>
                          )}
                          <div className="flex justify-end gap-2">
                            <button
                              onClick={() => { setEditingProvider(null); setEditTestResult(null); }}
                              className="px-3 py-1.5 text-xs font-semibold rounded-lg bg-muted text-muted-foreground hover:bg-muted"
                            >
                              Cancel
                            </button>
                            <button
                              disabled={editSaving || !editTestResult?.ok}
                              onClick={async () => {
                                setEditSaving(true);
                                const success = await addModelProvider(providerId, {
                                  baseUrl: editProvider.baseUrl,
                                  apiKey: editProvider.apiKey || undefined,
                                  api: editProvider.api,
                                  models: editProvider.models,
                                });
                                setEditSaving(false);
                                if (success) { setEditingProvider(null); setEditTestResult(null); }
                              }}
                              className={cn(
                                "px-3 py-1.5 text-xs font-semibold rounded-lg flex items-center gap-1.5",
                                !editSaving && editTestResult?.ok
                                  ? "bg-purple-500/30 text-purple-600 dark:text-purple-300 hover:bg-purple-500/40"
                                  : "bg-muted text-muted-foreground cursor-not-allowed"
                              )}
                            >
                              {editSaving && <div className="w-3 h-3 border-2 border-purple-300 border-t-transparent rounded-full animate-spin" />}
                              {editSaving ? 'Saving...' : 'Save'}
                            </button>
                          </div>
                        </>
                      ) : (
                        /* View Mode */
                        <>
                          <div className="grid grid-cols-2 gap-4">
                            <div>
                              <label className="text-xs font-bold text-muted-foreground uppercase tracking-wider mb-1 block">Base URL</label>
                              <code className="text-xs text-muted-foreground font-mono">{provider.baseUrl}</code>
                            </div>
                            <div>
                              <label className="text-xs font-bold text-muted-foreground uppercase tracking-wider mb-1 block">API Key</label>
                              <div className="flex items-center gap-2">
                                <code className="text-xs text-muted-foreground font-mono">
                                  {showApiKey[providerId] ? provider.apiKey : (provider.apiKey ? '••••••••' : '(not set)')}
                                </code>
                                {provider.apiKey && (
                                  <button onClick={() => setShowApiKey(prev => ({ ...prev, [providerId]: !prev[providerId] }))}>
                                    {showApiKey[providerId] ? <EyeOff className="w-3 h-3 text-muted-foreground" /> : <Eye className="w-3 h-3 text-muted-foreground" />}
                                  </button>
                                )}
                              </div>
                            </div>
                          </div>

                          {(() => {
                            const displayModels = availableModels?.[providerId]?.length
                              ? availableModels[providerId]
                              : provider.models ?? [];
                            return displayModels.length > 0 ? (
                            <div>
                              <label className="text-xs font-bold text-muted-foreground uppercase tracking-wider mb-2 block">Models ({displayModels.length})</label>
                              <div className="grid gap-1 max-h-60 overflow-y-auto">
                                {displayModels.map((model) => (
                                  <div key={model.id} className="flex items-center justify-between px-3 py-2 rounded-lg bg-muted">
                                    <div className="flex items-center gap-2">
                                      <span className="text-sm text-foreground">{model.name || model.id}</span>
                                    </div>
                                    <span className="text-xs text-muted-foreground">{model.contextWindow ? `${Math.round(model.contextWindow / 1000)}K` : ''}</span>
                                  </div>
                                ))}
                              </div>
                            </div>
                            ) : null;
                          })()}

                          {/* Edit / Delete actions */}
                          <div className="flex items-center gap-2 pt-2 border-t border">
                            <button
                              onClick={() => {
                                setEditingProvider(providerId);
                                setEditTestResult(null);
                                setEditProvider({
                                  baseUrl: provider.baseUrl || '',
                                  apiKey: provider.apiKey || '',
                                  api: provider.api || 'openai-completions',
                                  models: provider.models?.map(m => ({
                                    id: m.id,
                                    name: m.name || m.id,
                                    contextWindow: m.contextWindow || 128000,
                                    reasoning: m.reasoning,
                                  })),
                                });
                              }}
                              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg bg-muted text-foreground hover:bg-muted"
                            >
                              <Edit3 className="w-3 h-3" /> Edit
                            </button>
                            <button
                              disabled={deletingProvider === providerId}
                              onClick={async () => {
                                if (!confirm(`Delete provider "${providerId}"? The gateway will restart.`)) return;
                                setDeletingProvider(providerId);
                                await deleteModelProvider(providerId);
                                setDeletingProvider(null);
                                setExpandedProvider(null);
                              }}
                              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg text-red-600 dark:text-red-400 hover:bg-red-500/10"
                            >
                              {deletingProvider === providerId ? (
                                <><div className="w-3 h-3 border-2 border-red-400 border-t-transparent rounded-full animate-spin" /> Deleting...</>
                              ) : (
                                <><Trash2 className="w-3 h-3" /> Delete</>
                              )}
                            </button>
                          </div>
                        </>
                      )}
                    </div>
                  )}
                </div>
              );
            })
          ) : !hasSilosFromBackend ? null : (
            <div className="p-6 text-center rounded-xl bg-card border border border-dashed">
              <p className="text-sm text-muted-foreground">No additional providers configured</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

type ChannelPreset = {
  label: string;
  icon: string;
  fields: Array<{
    key: string;
    label: string;
    type: 'select' | 'text' | 'phone-list' | 'toggle';
    options?: Array<{ value: string; label: string; description?: string }>;
    defaultValue?: unknown;
    placeholder?: string;
    description?: string;
  }>;
};

const channelPresets: Record<string, ChannelPreset> = {
  whatsapp: {
    label: 'WhatsApp',
    icon: '📱',
    fields: [
      { key: 'allowFrom', label: 'Allowed Numbers', type: 'phone-list', placeholder: '+34612345678', description: 'E.164 format phone numbers' },
    ],
  },
  telegram: {
    label: 'Telegram',
    icon: '✈️',
    fields: [
      { key: 'botToken', label: 'Bot Token', type: 'text', placeholder: '123456:ABC-DEF...', description: 'From @BotFather' },
      {
        key: 'dmPolicy', label: 'DM Policy', type: 'select', defaultValue: 'open',
        options: [
          { value: 'open', label: 'Open', description: 'Anyone can message' },
          { value: 'allowlist', label: 'Allowlist', description: 'Only approved users' },
          { value: 'disabled', label: 'Disabled', description: 'Ignore DMs' },
        ],
      },
    ],
  },
  discord: {
    label: 'Discord',
    icon: '🎮',
    fields: [
      { key: 'botToken', label: 'Bot Token', type: 'text', placeholder: 'Bot token from Discord Developer Portal' },
      { key: 'applicationId', label: 'Application ID', type: 'text', placeholder: 'Application ID' },
    ],
  },
  slack: {
    label: 'Slack',
    icon: '💼',
    fields: [
      { key: 'botToken', label: 'Bot Token', type: 'text', placeholder: 'xoxb-...' },
      { key: 'appToken', label: 'App Token', type: 'text', placeholder: 'xapp-...' },
    ],
  },
};

function ChannelsSection() {
  const { channels, loadChannels, agents, patchGatewayConfig, gatewayConfig } = useDashboardStore();
  const rawChannelsConfig = (gatewayConfig?.config as Record<string, unknown>)?.channels as Record<string, Record<string, unknown>> | undefined;
  const [_sessionScope, setSessionScope] = useState<'per-sender' | 'global'>('per-sender');
  const [defaultAgentId, setDefaultAgentId] = useState<string>('');
  const [showAddChannel, setShowAddChannel] = useState(false);
  const [selectedChannelType, setSelectedChannelType] = useState<string | null>(null);
  const [channelConfig, setChannelConfig] = useState<Record<string, unknown>>({});
  const [savingChannel, setSavingChannel] = useState(false);
  const [saveChannelError, setSaveChannelError] = useState<string | null>(null);
  const [phoneInput, setPhoneInput] = useState('');

  const channelIcons: Record<string, string> = {
    whatsapp: '📱', telegram: '✈️', discord: '🎮', slack: '💼',
    matrix: '🔷', email: '📧', sms: '💬', web: '🌐',
  };

  useEffect(() => {
    loadChannels();
  }, [loadChannels]);

  useEffect(() => {
    if (agents) {
      setSessionScope(agents.scope || 'per-sender');
      setDefaultAgentId(agents.defaultId || '');
    }
  }, [agents]);

  // Only show channels that are actually configured (exist in gateway config)
  const allChannelNames = channels?.channelOrder || [];
  const configuredChannelIds = new Set(
    rawChannelsConfig
      ? Object.keys(rawChannelsConfig).filter(k => k !== 'defaults' && typeof rawChannelsConfig[k] === 'object' && rawChannelsConfig[k] !== null)
      : []
  );
  const channelNames = allChannelNames.filter(id => configuredChannelIds.has(id));

  return (
    <div className="space-y-6">
      <p className="text-sm text-muted-foreground">Configure messaging channels and session routing</p>

      {/* Default Agent */}
      <div>
        <label className="text-xs font-bold text-muted-foreground uppercase tracking-wider mb-2 block">Default Agent</label>
        <select
          value={defaultAgentId}
          onChange={(e) => setDefaultAgentId(e.target.value)}
          className="w-full px-3 py-2 rounded-lg bg-card border border text-foreground text-sm focus:outline-none focus:border-teal-500/50"
        >
          {agents?.agents.map(agent => (
            <option key={agent.id} value={agent.id}>
              {agent.identity?.emoji || '🤖'} {agent.identity?.name || agent.id}
            </option>
          ))}
        </select>
      </div>

      {/* Channels List */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <label className="text-xs font-bold text-muted-foreground uppercase tracking-wider">Connected Channels</label>
          <button
            onClick={() => { setShowAddChannel(!showAddChannel); setSelectedChannelType(null); setChannelConfig({}); setSaveChannelError(null); }}
            className={cn(
              "flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg transition-colors",
              showAddChannel
                ? "bg-muted text-foreground"
                : "bg-teal-500/20 text-teal-600 dark:text-teal-300 border border-teal-500/30 hover:bg-teal-500/30"
            )}
          >
            <Plus className="w-3.5 h-3.5" /> {showAddChannel ? 'Cancel' : 'Add'}
          </button>
        </div>

        {/* Add Channel Form */}
        {showAddChannel && (
          <div className="p-4 rounded-xl bg-card border border-teal-500/30 space-y-4 mb-4">
            <h3 className="text-sm font-semibold text-foreground">Add Channel</h3>

            {/* Channel Type Selection */}
            <div className="flex flex-wrap gap-2">
              {Object.entries(channelPresets).map(([type, preset]) => (
                <button
                  key={type}
                  onClick={() => {
                    setSelectedChannelType(type);
                    // Set defaults from preset fields
                    const defaults: Record<string, unknown> = {};
                    preset.fields.forEach(f => {
                      if (f.defaultValue !== undefined) defaults[f.key] = f.defaultValue;
                    });
                    setChannelConfig(defaults);
                    setPhoneInput('');
                    setSaveChannelError(null);
                  }}
                  className={cn(
                    "px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors",
                    selectedChannelType === type
                      ? "bg-teal-500/30 text-teal-600 dark:text-teal-300 border-teal-500/50"
                      : "bg-muted text-muted-foreground border hover:border"
                  )}
                >
                  {preset.icon} {preset.label}
                </button>
              ))}
            </div>

            {/* Channel Config Fields */}
            {selectedChannelType && channelPresets[selectedChannelType] && (
              <div className="space-y-3">
                {channelPresets[selectedChannelType].fields.map((field) => (
                  <div key={field.key}>
                    <label className="text-xs font-bold text-muted-foreground uppercase tracking-wider mb-1 block">
                      {field.label}
                    </label>
                    {field.description && (
                      <p className="text-[10px] text-muted-foreground mb-1">{field.description}</p>
                    )}

                    {field.type === 'select' && (
                      <div className="flex flex-wrap gap-2">
                        {field.options?.map((opt) => (
                          <button
                            key={opt.value}
                            onClick={() => {
                              const updated = { ...channelConfig, [field.key]: opt.value };
                              // If dmPolicy is 'open', auto-set allowFrom to ['*']
                              if (field.key === 'dmPolicy' && opt.value === 'open') {
                                updated.allowFrom = ['*'];
                              }
                              setChannelConfig(updated);
                            }}
                            className={cn(
                              "px-3 py-1.5 text-xs rounded-lg border transition-colors",
                              channelConfig[field.key] === opt.value
                                ? "bg-teal-500/20 text-teal-600 dark:text-teal-300 border-teal-500/40"
                                : "bg-muted text-muted-foreground border hover:border"
                            )}
                          >
                            <span className="font-medium">{opt.label}</span>
                            {opt.description && <span className="text-muted-foreground ml-1">— {opt.description}</span>}
                          </button>
                        ))}
                      </div>
                    )}

                    {field.type === 'text' && (
                      <input
                        type={field.key.toLowerCase().includes('token') || field.key.toLowerCase().includes('key') ? 'password' : 'text'}
                        placeholder={field.placeholder}
                        value={(channelConfig[field.key] as string) || ''}
                        onChange={(e) => setChannelConfig({ ...channelConfig, [field.key]: e.target.value })}
                        className="w-full px-3 py-2 rounded-lg bg-muted border border text-foreground text-sm font-mono focus:outline-none focus:border-teal-500/50"
                      />
                    )}

                    {field.type === 'phone-list' && (
                      <div className="space-y-2">
                        {/* Existing numbers */}
                        <div className="flex flex-wrap gap-1.5">
                          {((channelConfig[field.key] as string[]) || []).map((phone, i) => (
                            <span key={i} className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-teal-500/15 text-teal-600 dark:text-teal-300 text-xs font-mono">
                              {phone}
                              <button
                                onClick={() => {
                                  const list = [...((channelConfig[field.key] as string[]) || [])];
                                  list.splice(i, 1);
                                  setChannelConfig({ ...channelConfig, [field.key]: list });
                                }}
                                className="ml-0.5 text-teal-600 dark:text-teal-500 hover:text-red-600 dark:text-red-400"
                              >×</button>
                            </span>
                          ))}
                        </div>
                        {/* Add number input */}
                        <div className="flex gap-2">
                          <input
                            type="text"
                            placeholder={field.placeholder}
                            value={phoneInput}
                            onChange={(e) => setPhoneInput(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter' && phoneInput.trim()) {
                                const list = [...((channelConfig[field.key] as string[]) || []), phoneInput.trim()];
                                setChannelConfig({ ...channelConfig, [field.key]: list });
                                setPhoneInput('');
                              }
                            }}
                            className="flex-1 px-3 py-1.5 rounded-lg bg-muted border border text-foreground text-sm font-mono focus:outline-none focus:border-teal-500/50"
                          />
                          <button
                            onClick={() => {
                              if (phoneInput.trim()) {
                                const list = [...((channelConfig[field.key] as string[]) || []), phoneInput.trim()];
                                setChannelConfig({ ...channelConfig, [field.key]: list });
                                setPhoneInput('');
                              }
                            }}
                            className="px-3 py-1.5 text-xs font-semibold rounded-lg bg-muted text-muted-foreground hover:bg-muted"
                          >
                            Add
                          </button>
                        </div>
                      </div>
                    )}

                    {field.type === 'toggle' && (
                      <button
                        onClick={() => setChannelConfig({ ...channelConfig, [field.key]: !channelConfig[field.key] })}
                        className={cn(
                          "w-10 h-5 rounded-full transition-colors relative",
                          channelConfig[field.key] ? "bg-teal-500/40" : "bg-muted"
                        )}
                      >
                        <span className={cn(
                          "absolute top-0.5 w-4 h-4 rounded-full transition-all",
                          channelConfig[field.key] ? "right-0.5 bg-teal-400" : "left-0.5 bg-muted-foreground"
                        )} />
                      </button>
                    )}
                  </div>
                ))}

                {saveChannelError && (
                  <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/30 text-xs text-red-600 dark:text-red-400">
                    {saveChannelError}
                  </div>
                )}

                {/* Save / Cancel */}
                <div className="flex justify-end gap-2 pt-2">
                  <button
                    onClick={() => { setShowAddChannel(false); setSelectedChannelType(null); setChannelConfig({}); }}
                    className="px-3 py-1.5 text-xs font-semibold rounded-lg bg-muted text-muted-foreground hover:bg-muted"
                  >
                    Cancel
                  </button>
                  {(() => {
                    // WhatsApp requires at least one phone number before adding
                    const needsAllowFrom = selectedChannelType === 'whatsapp' && (!Array.isArray(channelConfig.allowFrom) || (channelConfig.allowFrom as string[]).length === 0);
                    const isDisabled = savingChannel || needsAllowFrom;
                    return (
                      <button
                        disabled={isDisabled}
                        onClick={async () => {
                          setSavingChannel(true);
                          setSaveChannelError(null);
                          try {
                            // Build clean config (remove empty/default values)
                            const cleanConfig: Record<string, unknown> = {};
                            for (const [k, v] of Object.entries(channelConfig)) {
                              if (v === '' || v === undefined || v === null) continue;
                              if (Array.isArray(v) && v.length === 0) continue;
                              cleanConfig[k] = v;
                            }

                            // Force WhatsApp defaults
                            if (selectedChannelType === 'whatsapp') {
                              cleanConfig.dmPolicy = 'allowlist';
                              cleanConfig.groupPolicy = 'allowlist';
                              cleanConfig.selfChatMode = true;
                              cleanConfig.sendReadReceipts = true;
                            }

                            const patch = {
                              channels: {
                                [selectedChannelType!]: cleanConfig,
                              },
                            };

                            const success = await patchGatewayConfig(patch);
                            if (success) {
                              setShowAddChannel(false);
                              setSelectedChannelType(null);
                              setChannelConfig({});
                            } else {
                              setSaveChannelError('Failed to add channel. Check gateway logs.');
                            }
                          } catch (err) {
                            setSaveChannelError(String(err));
                          } finally {
                            setSavingChannel(false);
                          }
                        }}
                        className={cn(
                          "px-3 py-1.5 text-xs font-semibold rounded-lg flex items-center gap-1.5",
                          !isDisabled
                            ? "bg-teal-500/30 text-teal-600 dark:text-teal-300 hover:bg-teal-500/40"
                            : "bg-muted text-muted-foreground cursor-not-allowed"
                        )}
                      >
                        {savingChannel && <div className="w-3 h-3 border-2 border-teal-300 border-t-transparent rounded-full animate-spin" />}
                        {savingChannel ? 'Adding...' : needsAllowFrom ? 'Add a phone number first' : `Add ${channelPresets[selectedChannelType]?.label || 'Channel'}`}
                      </button>
                    );
                  })()}
                </div>
              </div>
            )}
          </div>
        )}

        {channelNames.length === 0 && !showAddChannel ? (
          <div className="p-8 text-center rounded-xl bg-card border border border-dashed">
            <MessageSquare className="w-10 h-10 text-muted-foreground mx-auto mb-3" />
            <p className="text-sm text-muted-foreground">No channels configured</p>
          </div>
        ) : (
          <div className="space-y-2">
            {channelNames.map((channelId) => (
              <ChannelRow key={channelId} channelId={channelId} channels={channels} channelIcons={channelIcons} onRemove={() => loadChannels()} rawConfig={rawChannelsConfig?.[channelId]} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function AgentsSection() {
  const { gatewayConfig, patchGatewayConfig, loadGatewayConfig } = useDashboardStore();
  const [saving, setSaving] = useState(false);
  const [modelSearchOpen, setModelSearchOpen] = useState(false);
  const [modelSearch, setModelSearch] = useState('');
  const modelDropdownRef = useRef<HTMLDivElement>(null);
  const modelSearchInputRef = useRef<HTMLInputElement>(null);

  const config = gatewayConfig?.config as Record<string, unknown> | undefined;
  const agentsConfig = config?.agents as { defaults?: { model?: { primary?: string } } } | undefined;
  const currentModel = agentsConfig?.defaults?.model?.primary || '';

  // Get providers from config
  const configModels = config?.models as { providers?: Record<string, { baseUrl?: string; apiKey?: string; api?: string; models?: Array<{ id: string; name?: string; contextWindow?: number; reasoning?: boolean }> }> } | undefined;
  const providers = configModels?.providers ?? {};
  const providerNames = Object.keys(providers);

  // Parse current model's provider
  const parsedModel = useMemo(() => {
    const slashIdx = currentModel.indexOf('/');
    if (slashIdx > 0) {
      return { provider: currentModel.substring(0, slashIdx), modelId: currentModel.substring(slashIdx + 1) };
    }
    return { provider: providerNames[0] ?? '', modelId: currentModel };
  }, [currentModel, providerNames]);

  const [selectedProvider, setSelectedProvider] = useState(parsedModel.provider || providerNames[0] || '');

  // Sync provider if config changes
  useEffect(() => {
    if (parsedModel.provider && parsedModel.provider !== selectedProvider) {
      setSelectedProvider(parsedModel.provider);
    }
  }, [parsedModel.provider]);

  const currentModels = providers[selectedProvider]?.models ?? [];

  const filteredModels = useMemo(() => {
    if (!modelSearch) return currentModels;
    const q = modelSearch.toLowerCase();
    return currentModels.filter((m) =>
      (m.name || m.id).toLowerCase().includes(q) || m.id.toLowerCase().includes(q)
    );
  }, [currentModels, modelSearch]);

  // Close dropdown on click outside
  useEffect(() => {
    if (!modelSearchOpen) return;
    const handler = (e: MouseEvent) => {
      if (modelDropdownRef.current && !modelDropdownRef.current.contains(e.target as Node)) {
        setModelSearchOpen(false);
        setModelSearch('');
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [modelSearchOpen]);

  // Focus search input when dropdown opens
  useEffect(() => {
    if (modelSearchOpen) {
      modelSearchInputRef.current?.focus();
    }
  }, [modelSearchOpen]);

  const selectedModelName = useMemo(() => {
    const found = currentModels.find((m) => m.id === parsedModel.modelId);
    return found ? (found.name || found.id) : parsedModel.modelId || 'Select model';
  }, [currentModels, parsedModel.modelId]);

  const handleModelChange = async (provider: string, modelId: string) => {
    setSaving(true);
    const ok = await patchGatewayConfig({
      agents: {
        defaults: {
          model: {
            primary: `${provider}/${modelId}`,
          },
        },
      },
    });
    if (ok) {
      // Gateway restarts after config change - wait for reconnection then reload
      const waitForReconnect = () => new Promise<void>((resolve) => {
        let attempts = 0;
        const check = () => {
          attempts++;
          const { connected } = useDashboardStore.getState();
          if (connected || attempts > 10) {
            resolve();
          } else {
            setTimeout(check, 500);
          }
        };
        setTimeout(check, 1500);
      });
      await waitForReconnect();
      await loadGatewayConfig();
    }
    setSaving(false);
  };

  const handleProviderChange = (provider: string) => {
    setSelectedProvider(provider);
    // Auto-select first model of new provider
    const models = providers[provider]?.models ?? [];
    if (models.length > 0) {
      handleModelChange(provider, models[0].id);
    }
  };

  return (
    <div className="space-y-6">
      <p className="text-sm text-muted-foreground">Default settings applied to all new agents</p>

      {/* Default Model */}
      <div className="rounded-xl border border bg-card p-5 space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="font-semibold text-foreground">Default Model</h3>
            <p className="text-xs text-muted-foreground mt-0.5">Primary model used by new agents</p>
          </div>
          {saving && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <div className="w-3 h-3 border-2 border-teal-400 border-t-transparent rounded-full animate-spin" />
              Saving...
            </div>
          )}
        </div>

        {providerNames.length > 0 ? (
          <div className="grid grid-cols-2 gap-3">
            {/* Provider Selector - only show if more than one */}
            {providerNames.length > 1 ? (
              <div className="space-y-2">
                <label className="text-xs font-bold text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
                  <Cpu className="w-3.5 h-3.5" /> Provider
                </label>
                <select
                  value={selectedProvider}
                  onChange={(e) => handleProviderChange(e.target.value)}
                  className="flex h-10 w-full rounded-md border border bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-teal-500/40"
                >
                  {providerNames.map((name) => (
                    <option key={name} value={name}>
                      {name} ({providers[name].models?.length ?? 0})
                    </option>
                  ))}
                </select>
              </div>
            ) : (
              <div className="space-y-2">
                <label className="text-xs font-bold text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
                  <Cpu className="w-3.5 h-3.5" /> Provider
                </label>
                <div className="flex h-10 items-center rounded-md border border bg-background px-3 text-sm text-foreground">
                  {providerNames[0]}
                </div>
              </div>
            )}

            {/* Model Selector with Search */}
            <div className="space-y-2">
              <label className="text-xs font-bold text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
                <Cpu className="w-3.5 h-3.5" /> Model
                <span className="text-muted-foreground normal-case font-normal">({currentModels.length})</span>
              </label>
              <div className="relative" ref={modelDropdownRef}>
                <button
                  type="button"
                  onClick={() => { setModelSearchOpen(!modelSearchOpen); setModelSearch(''); }}
                  className="flex h-10 w-full items-center justify-between rounded-md border border bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-teal-500/40"
                >
                  <span className="truncate">{selectedModelName}</span>
                  <ChevronRight className={cn("h-4 w-4 text-muted-foreground transition-transform", modelSearchOpen && "rotate-90")} />
                </button>
                {modelSearchOpen && (
                  <div className="absolute z-50 mt-1 w-full rounded-md border border bg-background shadow-lg">
                    <div className="flex items-center border-b border px-3">
                      <Search className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                      <input
                        ref={modelSearchInputRef}
                        type="text"
                        value={modelSearch}
                        onChange={(e) => setModelSearch(e.target.value)}
                        placeholder={t('settings.agentsConfig.searchModels')}
                        className="flex-1 bg-transparent px-2 py-2 text-sm text-foreground placeholder:text-muted-foreground outline-none"
                      />
                      {modelSearch && (
                        <span className="text-xs text-muted-foreground">{filteredModels.length}</span>
                      )}
                    </div>
                    <div className="max-h-60 overflow-y-auto p-1">
                      {filteredModels.length === 0 ? (
                        <div className="px-3 py-4 text-center text-xs text-muted-foreground">No models found</div>
                      ) : (
                        filteredModels.map((model) => (
                          <button
                            key={model.id}
                            type="button"
                            onClick={() => {
                              handleModelChange(selectedProvider, model.id);
                              setModelSearchOpen(false);
                              setModelSearch('');
                            }}
                            className={cn(
                              "flex w-full items-center gap-2 rounded px-3 py-2 text-sm transition-colors hover:bg-muted",
                              parsedModel.modelId === model.id ? "bg-muted text-foreground" : "text-foreground"
                            )}
                          >
                            <span className="w-3.5 shrink-0">
                              {parsedModel.modelId === model.id && <Check className="h-3.5 w-3.5 text-teal-600 dark:text-teal-400" />}
                            </span>
                            <span className="truncate">{model.name || model.id}</span>
                            {model.contextWindow && (
                              <span className="ml-auto text-[10px] text-muted-foreground shrink-0">{Math.round(model.contextWindow / 1000)}k</span>
                            )}
                          </button>
                        ))
                      )}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        ) : (
          <div className="p-4 text-center rounded-lg bg-muted/50 border border border-dashed">
            <p className="text-xs text-muted-foreground">No providers configured. Add a provider in Model Providers first.</p>
          </div>
        )}

        {currentModel && (
          <div className="flex items-center gap-2 pt-3 border-t border">
            <span className="text-xs text-muted-foreground">Current default:</span>
            <code className="text-xs text-teal-600 dark:text-teal-400 font-mono bg-muted px-2 py-0.5 rounded">{currentModel}</code>
          </div>
        )}
      </div>
    </div>
  );
}

function ToolsSection() {
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">Configure available tools and permissions</p>

      <div className="space-y-3">
        {[
          { id: 'bash', name: 'Bash Commands', icon: '💻', enabled: true, description: 'Execute shell commands' },
          { id: 'web', name: 'Web Browsing', icon: '🌐', enabled: true, description: 'Browse and fetch web content' },
          { id: 'files', name: 'File Operations', icon: '📁', enabled: true, description: 'Read and write files' },
          { id: 'agent-to-agent', name: 'Agent Communication', icon: '🔗', enabled: false, description: 'Send messages between agents' },
          { id: 'spawn', name: 'Spawn Subagents', icon: '🚀', enabled: true, description: 'Create task-specific subagents' },
        ].map((tool) => (
          <div key={tool.id} className="flex items-center justify-between p-4 rounded-xl bg-card border border">
            <div className="flex items-center gap-3">
              <span className="text-xl">{tool.icon}</span>
              <div>
                <h3 className="font-semibold text-foreground">{tool.name}</h3>
                <p className="text-xs text-muted-foreground">{tool.description}</p>
              </div>
            </div>
            <button className={cn(
              "w-12 h-6 rounded-full transition-colors relative",
              tool.enabled ? "bg-emerald-500/30" : "bg-muted"
            )}>
              <span className={cn(
                "absolute top-1 w-4 h-4 rounded-full transition-all",
                tool.enabled ? "right-1 bg-emerald-400" : "left-1 bg-muted-foreground"
              )} />
            </button>
          </div>
        ))}
      </div>

      <div className="p-4 rounded-xl bg-muted/40 border border">
        <p className="text-xs text-muted-foreground">
          <Info className="w-4 h-4 inline mr-1" />
          Tool permissions are configured in ~/.openclaw/config.yaml under the <code className="text-muted-foreground">tools</code> section.
        </p>
      </div>
    </div>
  );
}

function GatewaySection() {
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
            <p className="text-xs text-muted-foreground">{connected ? gatewayUrl : t('settings.connection.disconnected')}</p>
          </div>
        </div>
        <button
          onClick={connected ? disconnect : connect}
          disabled={connecting}
          className={cn(
            "px-4 py-2 text-sm font-semibold rounded-xl",
            connected ? "bg-red-500/20 text-red-700 dark:text-red-300 border border-red-500/30" : "bg-blue-500/20 text-blue-600 dark:text-blue-300 border border-blue-500/30"
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
            className="w-full px-3 py-2 rounded-lg bg-card border border text-foreground text-sm focus:outline-none focus:border-blue-500/50"
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
              className="w-full px-3 py-2 rounded-lg bg-card border border text-foreground text-sm focus:outline-none focus:border-blue-500/50 pr-12"
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

function AppearanceSection() {
  const { darkMode, setDarkMode } = useDashboardStore();
  const { t, locale, setLocale, locales: availableLocales } = useTranslation();
  const [silosVersion, setSilosVersion] = useState<string | null>(null);
  const [openclawVersion, setOpenclawVersion] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/config')
      .then(r => r.json())
      .then(data => {
        if (data.version) setSilosVersion(data.version);
        if (data.openclawVersion) setOpenclawVersion(data.openclawVersion);
      })
      .catch(() => {});
  }, []);

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">{t('settings.subtitle')}</p>

      <div className="flex items-center justify-between p-4 rounded-xl bg-card border border">
        <div>
          <p className="font-semibold text-foreground">{t('settings.appearance.theme')}</p>
          <p className="text-xs text-muted-foreground">{t('settings.appearanceConfig.themeDesc')}</p>
        </div>
        <div className="flex items-center gap-1 p-1 rounded-lg bg-muted">
          <button
            onClick={() => setDarkMode(false)}
            className={cn("flex items-center gap-2 px-3 py-1.5 text-sm rounded-md", !darkMode ? "bg-amber-500/20 text-amber-600 dark:text-amber-300" : "text-muted-foreground")}
          >
            <Sun className="w-4 h-4" /> {t('settings.appearance.lightMode')}
          </button>
          <button
            onClick={() => setDarkMode(true)}
            className={cn("flex items-center gap-2 px-3 py-1.5 text-sm rounded-md", darkMode ? "bg-violet-500/20 text-violet-600 dark:text-violet-300" : "text-muted-foreground")}
          >
            <Moon className="w-4 h-4" /> {t('settings.appearance.darkMode')}
          </button>
        </div>
      </div>

      {/* Language */}
      <div className="flex items-center justify-between p-4 rounded-xl bg-card border border">
        <div>
          <p className="font-semibold text-foreground">{t('settings.appearance.language')}</p>
          <p className="text-xs text-muted-foreground">{t('settings.appearance.languageDesc')}</p>
        </div>
        <div className="flex items-center gap-1 p-1 rounded-lg bg-muted">
          {(Object.keys(availableLocales) as Locale[]).map((loc) => (
            <button
              key={loc}
              onClick={() => setLocale(loc)}
              className={cn(
                "flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-md transition-colors",
                locale === loc ? "bg-violet-500/20 text-violet-600 dark:text-violet-300" : "text-muted-foreground hover:text-foreground"
              )}
            >
              <span>{availableLocales[loc].flag}</span>
              <span className="hidden sm:inline">{availableLocales[loc].label}</span>
            </button>
          ))}
        </div>
      </div>

      {/* About */}
      <div className="p-4 rounded-xl bg-card border border space-y-3">
        <div className="flex items-center gap-3">
          <Zap className="w-6 h-6 text-violet-600 dark:text-violet-400" />
          <p className="font-semibold text-foreground">{t('settings.aboutConfig.silosDashboard')}</p>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div className="flex items-center justify-between px-3 py-2 rounded-lg bg-muted/50">
            <span className="text-xs text-muted-foreground">{t('settings.aboutConfig.dashboardVersion')}</span>
            <span className="text-xs font-mono text-violet-600 dark:text-violet-400">{silosVersion ? `v${silosVersion}` : '—'}</span>
          </div>
          <div className="flex items-center justify-between px-3 py-2 rounded-lg bg-muted/50">
            <span className="text-xs text-muted-foreground">{t('settings.aboutConfig.openclawVersion')}</span>
            <span className="text-xs font-mono text-violet-600 dark:text-violet-400">{openclawVersion ? `v${openclawVersion}` : '—'}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

// ==================== MAIN SETTINGS PAGE ====================

export function SettingsPage() {
  const { t } = useTranslation();
  const { tab } = useParams<{ tab?: string }>();
  const navigate = useNavigate();
  const valid: SettingsSection[] = ['models', 'channels', 'agents', 'tools', 'gateway', 'appearance'];
  const activeSection = valid.includes(tab as SettingsSection) ? (tab as SettingsSection) : 'models';

  const setActiveSection = (section: SettingsSection) => {
    navigate(`/settings/${section}`, { replace: true });
  };

  const renderSection = () => {
    switch (activeSection) {
      case 'models': return <ModelsSection />;
      case 'channels': return <ChannelsSection />;
      case 'agents': return <AgentsSection />;
      case 'tools': return <ToolsSection />;
      case 'gateway': return <GatewaySection />;
      case 'appearance': return <AppearanceSection />;
    }
  };

  const currentSection = settingsSections.find(s => s.id === activeSection);

  return (
    <div className="h-screen flex flex-col bg-background">
      <Header title={t('settings.title')} description={t('settings.subtitle')} />

      <div className="flex flex-1 min-h-0">
        {/* Sidebar */}
        <div className="w-64 border-r border p-4 overflow-y-auto">
          <nav className="space-y-1">
            {settingsSections.map((section) => (
              <button
                key={section.id}
                onClick={() => setActiveSection(section.id)}
                className={cn(
                  "w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-left transition-colors",
                  activeSection === section.id
                    ? "bg-muted text-foreground"
                    : "text-muted-foreground hover:bg-muted hover:text-foreground"
                )}
              >
                <span className={activeSection === section.id ? "text-teal-600 dark:text-teal-400" : ""}>{section.icon}</span>
                <div>
                  <p className="text-sm font-medium">{t(section.labelKey)}</p>
                  <p className="text-xs text-muted-foreground">{t(section.descriptionKey)}</p>
                </div>
              </button>
            ))}
          </nav>
        </div>

        {/* Content */}
        <div className="flex-1 p-6 max-w-4xl overflow-y-auto">
          <div className="flex items-center gap-3 mb-6">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-teal-500/20 to-cyan-500/20 border border-teal-500/30 flex items-center justify-center text-teal-600 dark:text-teal-400">
              {currentSection?.icon}
            </div>
            <div>
              <h2 className="text-lg font-bold text-foreground">{currentSection ? t(currentSection.labelKey) : ''}</h2>
              <p className="text-sm text-muted-foreground">{currentSection ? t(currentSection.descriptionKey) : ''}</p>
            </div>
          </div>

          {renderSection()}
        </div>
      </div>
    </div>
  );
}
