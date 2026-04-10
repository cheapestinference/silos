import { useState, useEffect } from 'react';
import {
  Plus,
  MessageSquare,
  Power,
  Trash2,
  Edit3,
  Copy,
  Check,
} from 'lucide-react';
import { useDashboardStore } from '../../store/dashboard-store';
import { cn } from '../../lib/utils';
import useTranslation, { t as tStatic } from '../../i18n';
import type { ChannelsStatusSnapshot } from '../../types/openclaw';
import { formatDistanceToNow } from 'date-fns';

// Channels that support QR code pairing
const QR_CHANNELS = new Set(['whatsapp']);

interface ChannelRowProps {
  channelId: string;
  channels: ChannelsStatusSnapshot | null;
  channelIcons: Record<string, string>;
  onRemove: (channelId: string) => void;
  rawConfig?: Record<string, unknown>;
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
                setQrError(tStatic('settings.connectionError'));
                hadError = true;
              }
            }
          }

          if (!paired && !hadError) {
            setQrError(tStatic('settings.qrExpired'));
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
    <div className="rounded-xl border bg-card overflow-hidden shadow-elevation-1">
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
              editing ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/20"
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
        <div className="border-t p-4 space-y-3">
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
                          ? "bg-primary/20 text-primary border-primary/40"
                          : "bg-muted text-muted-foreground border hover:border-foreground/20"
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
                  className="w-full px-3 py-2 rounded-lg bg-muted border text-foreground text-sm font-mono focus:outline-none focus:border-ring"
                />
              )}

              {field.type === 'phone-list' && (
                <div className="space-y-2">
                  <div className="flex flex-wrap gap-1.5">
                    {((editConfig[field.key] as string[]) || []).map((phone, i) => (
                      <span key={i} className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-primary/15 text-primary text-xs font-mono">
                        {phone}
                        <button
                          onClick={() => {
                            const list = [...((editConfig[field.key] as string[]) || [])];
                            list.splice(i, 1);
                            setEditConfig({ ...editConfig, [field.key]: list });
                          }}
                          className="ml-0.5 text-primary hover:text-red-600 dark:text-red-400"
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
                      className="flex-1 px-3 py-1.5 rounded-lg bg-muted border text-foreground text-sm font-mono focus:outline-none focus:border-ring"
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
                    editConfig[field.key] ? "bg-primary/40" : "bg-muted"
                  )}
                >
                  <span className={cn(
                    "absolute top-0.5 w-4 h-4 rounded-full transition-all",
                    editConfig[field.key] ? "right-0.5 bg-primary" : "left-0.5 bg-muted-foreground"
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
                !editSaving ? "bg-primary/20 text-primary hover:bg-primary/40" : "bg-muted text-muted-foreground cursor-not-allowed"
              )}
            >
              {editSaving && <div className="w-3 h-3 border-2 border-primary/40 border-t-transparent rounded-full animate-spin" />}
              {editSaving ? 'Saving...' : 'Save'}
            </button>
          </div>
        </div>
      )}

      {/* QR Code Panel */}
      {(qrDataUrl || qrMessage || qrError) && (
        <div className="border-t p-4">
          {qrDataUrl && (
            <div className="flex flex-col items-center gap-3">
              <p className="text-xs text-muted-foreground text-center">
                Open WhatsApp on your phone → Settings → Linked Devices → Link a Device
              </p>
              <div className="bg-white p-3 rounded-xl">
                <img src={qrDataUrl} alt="WhatsApp QR Code" className="w-48 h-48" />
              </div>
              {waitingForScan && (
                <div className="flex items-center gap-2 text-xs text-primary">
                  <div className="w-3 h-3 border-2 border-primary border-t-transparent rounded-full animate-spin" />
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
                className="text-xs text-primary hover:text-primary/80 font-semibold"
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

export function ChannelsSection() {
  const { t } = useTranslation();
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
      <p className="text-sm text-muted-foreground">{t('settings.channelsConfig.configure')}</p>

      {/* Default Agent */}
      <div>
        <label className="text-xs font-bold text-muted-foreground uppercase tracking-wider mb-2 block">{t('settings.channelsConfig.defaultAgent')}</label>
        <select
          value={defaultAgentId}
          onChange={(e) => setDefaultAgentId(e.target.value)}
          className="w-full px-3 py-2 rounded-lg bg-card border text-foreground text-sm focus:outline-none focus:border-ring"
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
          <label className="text-xs font-bold text-muted-foreground uppercase tracking-wider">{t('settings.channelsConfig.connectedChannels')}</label>
          <button
            onClick={() => { setShowAddChannel(!showAddChannel); setSelectedChannelType(null); setChannelConfig({}); setSaveChannelError(null); }}
            className={cn(
              "flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg transition-colors",
              showAddChannel
                ? "bg-muted text-foreground"
                : "bg-primary/20 text-primary border border-primary/20 hover:bg-primary/20"
            )}
          >
            <Plus className="w-3.5 h-3.5" /> {showAddChannel ? 'Cancel' : 'Add'}
          </button>
        </div>

        {/* Add Channel Form */}
        {showAddChannel && (
          <div className="p-4 rounded-xl bg-card border border-primary/20 space-y-4 mb-4">
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
                      ? "bg-primary/20 text-primary border-primary/40"
                      : "bg-muted text-muted-foreground border hover:border-foreground/20"
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
                                ? "bg-primary/20 text-primary border-primary/40"
                                : "bg-muted text-muted-foreground border hover:border-foreground/20"
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
                        className="w-full px-3 py-2 rounded-lg bg-muted border text-foreground text-sm font-mono focus:outline-none focus:border-ring"
                      />
                    )}

                    {field.type === 'phone-list' && (
                      <div className="space-y-2">
                        {/* Existing numbers */}
                        <div className="flex flex-wrap gap-1.5">
                          {((channelConfig[field.key] as string[]) || []).map((phone, i) => (
                            <span key={i} className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-primary/15 text-primary text-xs font-mono">
                              {phone}
                              <button
                                onClick={() => {
                                  const list = [...((channelConfig[field.key] as string[]) || [])];
                                  list.splice(i, 1);
                                  setChannelConfig({ ...channelConfig, [field.key]: list });
                                }}
                                className="ml-0.5 text-primary hover:text-red-600 dark:text-red-400"
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
                            className="flex-1 px-3 py-1.5 rounded-lg bg-muted border text-foreground text-sm font-mono focus:outline-none focus:border-ring"
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
                          channelConfig[field.key] ? "bg-primary/40" : "bg-muted"
                        )}
                      >
                        <span className={cn(
                          "absolute top-0.5 w-4 h-4 rounded-full transition-all",
                          channelConfig[field.key] ? "right-0.5 bg-primary" : "left-0.5 bg-muted-foreground"
                        )} />
                      </button>
                    )}
                  </div>
                ))}

                {saveChannelError && (
                  <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-xs text-red-600 dark:text-red-400">
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
                            ? "bg-primary/20 text-primary hover:bg-primary/40"
                            : "bg-muted text-muted-foreground cursor-not-allowed"
                        )}
                      >
                        {savingChannel && <div className="w-3 h-3 border-2 border-primary/40 border-t-transparent rounded-full animate-spin" />}
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
          <div className="p-8 text-center rounded-xl bg-card border border-dashed">
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
