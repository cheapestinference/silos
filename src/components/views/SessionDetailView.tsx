import { useEffect, useState, useRef, useMemo, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useDashboardStore } from '../../store/dashboard-store';
import { getGatewayClient } from '../../lib/gateway-client';
import { cn } from '../../lib/utils';
import useTranslation from '../../i18n';
import {
  Bot,
  Cpu,
  Clock,
  ChevronDown,
  Check,
  Loader2,
  Search,
  X,
  Brain,
  Wrench,
  Sparkles,
  Settings,
} from 'lucide-react';
import { ChatView } from './ChatView';
import { formatDistanceToNow } from 'date-fns';

// Extract agent ID from session key
function extractAgentIdFromSessionKey(sessionKey: string): string | null {
  // Format: agent:{agentId}:{bucket}
  const agentMatch = sessionKey.match(/^agent:([^:]+):/);
  if (agentMatch) return agentMatch[1];

  // Format: webchat:g-agent-{agentId}...
  const webchatMatch = sessionKey.match(/^webchat:g-agent-([^-]+)/);
  if (webchatMatch) return webchatMatch[1];

  // Format: dm-{agentId}
  const dmMatch = sessionKey.match(/^dm-(.+)$/);
  if (dmMatch) return dmMatch[1];

  return null;
}

// Extract session display name from key
function getSessionDisplayName(sessionKey: string, session?: { displayName?: string; label?: string } | null): string {
  if (session?.displayName) return session.displayName;
  if (session?.label) return session.label;

  const parts = sessionKey.split(':');
  if (parts.length >= 3 && parts[0] === 'agent') {
    return parts.slice(2).join(':');
  }

  if (sessionKey.startsWith('webchat:')) {
    if (sessionKey.includes('-subagent-')) {
      const subagentPart = sessionKey.split('-subagent-')[1];
      return `subagent-${subagentPart?.slice(0, 8) || ''}`;
    }
    return 'webchat';
  }

  if (sessionKey.startsWith('dm-')) {
    return 'main';
  }

  return parts[parts.length - 1] || sessionKey;
}


export function SessionDetailView() {
  const { t } = useTranslation();
  const { key: sessionKey } = useParams<{ key: string }>();
  const navigate = useNavigate();
  const {
    agents,
    sessions,
    loadAgents,
    loadSessions,
    connected,
    loadAgentConfig,
    gatewayConfig,
    availableModels,
    loadAvailableModels,
  } = useDashboardStore();

  const agentId = sessionKey ? extractAgentIdFromSessionKey(sessionKey) : null;

  useEffect(() => {
    if (connected) {
      loadAgents();
      loadSessions();
      if (agentId) {
        loadAgentConfig(agentId);
      }
    }
  }, [connected, loadAgents, loadSessions, loadAgentConfig, agentId]);

  if (!sessionKey) {
    navigate('/');
    return null;
  }

  const agent = agentId ? agents?.agents.find(a => a.id === agentId) : null;
  const session = sessions?.sessions.find(s => s.key === sessionKey);
  const sessionName = getSessionDisplayName(sessionKey, session);

  const agentName = agent?.identity?.name || agent?.name || agent?.id || 'Unknown Agent';
  const agentEmoji = agent?.identity?.emoji;
  // Resolve active model: per-agent override > global default; session.model is what was used in this session
  const agentsCfg = (gatewayConfig?.config as Record<string, unknown>)?.agents as
    { defaults?: { model?: { primary?: string } }; list?: Array<{ id: string; model?: string | { primary?: string } }> } | undefined;
  const sessionAgentEntry = agentId ? agentsCfg?.list?.find(a => a.id === agentId) : null;
  const sessionAgentOverride = sessionAgentEntry?.model
    ? (typeof sessionAgentEntry.model === 'string' ? sessionAgentEntry.model : sessionAgentEntry.model.primary || '')
    : '';
  const resolvedModel = session?.model || sessionAgentOverride || agentsCfg?.defaults?.model?.primary || t('sessionDetail.notConfigured');
  const isOnline = true;

  // Model dropdown
  const [modelDropdownOpen, setModelDropdownOpen] = useState(false);
  const [agentTab, setAgentTab] = useState<string | null>(null);
  const [modelSearch, setModelSearch] = useState('');
  const [optimisticModel, setOptimisticModel] = useState<string | null>(null);

  // Clear optimistic override once real config catches up
  useEffect(() => {
    if (optimisticModel && resolvedModel === optimisticModel) {
      setOptimisticModel(null);
    }
  }, [resolvedModel, optimisticModel]);

  const model = optimisticModel || resolvedModel;
  const modelDropdownRef = useRef<HTMLDivElement>(null);
  const modelSearchRef = useRef<HTMLInputElement>(null);

  const currentProvider = session?.modelProvider;
  const [selectedProvider, setSelectedProvider] = useState('');

  // All available providers with their models
  const allProviders = useMemo(() => {
    const map = new Map<string, Array<{ id: string; name: string; contextWindow?: number }>>();
    if (availableModels) {
      for (const [pId, models] of Object.entries(availableModels)) {
        if (models.length) map.set(pId, models);
      }
    }
    return map;
  }, [availableModels]);

  const activeProvider = selectedProvider || currentProvider || (allProviders.keys().next().value ?? '');
  const providerModels = useMemo(() => {
    const all = allProviders.get(activeProvider) || [];
    if (!modelSearch.trim()) return all;
    const q = modelSearch.toLowerCase();
    return all.filter(m => m.id.toLowerCase().includes(q) || (m.name && m.name.toLowerCase().includes(q)));
  }, [activeProvider, allProviders, modelSearch]);

  // Close on outside click
  useEffect(() => {
    if (!modelDropdownOpen) return;
    const handleClick = (e: MouseEvent) => {
      if (modelDropdownRef.current && !modelDropdownRef.current.contains(e.target as Node)) {
        setModelDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [modelDropdownOpen]);

  const { loadGatewayConfig } = useDashboardStore();

  const handleModelChange = useCallback(async (newModelId: string, provider?: string) => {
    const effectiveProvider = provider || activeProvider;
    if (!effectiveProvider || !agentId) return;
    const fullModel = `${effectiveProvider}/${newModelId}`;
    setOptimisticModel(fullModel);
    setModelDropdownOpen(false);
    setSelectedProvider('');
    try {
      const client = getGatewayClient();
      if (!client) throw new Error('Not connected');
      try {
        await client.updateAgent(agentId, { model: fullModel });
      } catch (updateErr) {
        if (!String(updateErr).includes('not found')) throw updateErr;
        // Agent not yet in config list (old VPS without pre-created main) — create it first
        await client.createAgent({ name: agentId, workspace: agentId });
        await client.updateAgent(agentId, { model: fullModel });
      }
      loadGatewayConfig();
      loadSessions();
    } catch (err) {
      console.error('Failed to change model:', err);
      setOptimisticModel(null);
    }
  }, [activeProvider, agentId, loadGatewayConfig, loadSessions]);

  // Format last activity
  const lastActivity = session?.updatedAt
    ? formatDistanceToNow(session.updatedAt, { addSuffix: true })
    : null;

  return (
    <div className="h-full flex flex-col bg-background overflow-hidden">
      {/* Header */}
      <header className="shrink-0 border-b bg-card">
        <div className="h-[1px] bg-gradient-to-r from-transparent via-primary/20 to-transparent" />

        <div className="px-6 py-4">
          <div className="flex items-center gap-4">
            {/* Avatar — same style as agent detail */}
            <div className="relative shrink-0">
              <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-primary/20 via-primary/15 to-accent/20 border border-primary/20 flex items-center justify-center shadow-lg shadow-elevation-1">
                {agentEmoji ? (
                  <span className="text-2xl">{agentEmoji}</span>
                ) : (
                  <Bot className="w-7 h-7 text-primary" />
                )}
              </div>
              {isOnline && (
                <div className="absolute -bottom-0.5 -right-0.5 w-4 h-4 bg-emerald-400 rounded-full border-2 border-card flex items-center justify-center">
                  <span className="w-2 h-2 bg-emerald-400 rounded-full animate-ping absolute" />
                </div>
              )}
            </div>

            {/* Name + meta */}
            <div className="min-w-0 flex-1">
              <h1 className="text-xl font-bold text-foreground truncate mb-1" style={{ fontFamily: 'Inter, system-ui, sans-serif' }}>
                #{sessionName}
              </h1>
              <div className="flex items-center gap-2.5 flex-wrap">
                <span
                  className="group/agent flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground cursor-pointer transition-colors"
                  onClick={() => agentId && navigate(`/agents/${agentId}`)}
                >
                  {agentEmoji ? <span className="text-[10px]">{agentEmoji}</span> : <Bot className="w-3 h-3" />}
                  <span className="font-medium">{agentName}</span>
                </span>
                <span className="w-1 h-1 rounded-full bg-muted-foreground/30" />
                <div className="relative" ref={modelDropdownRef}>
                  <button
                    type="button"
                    onClick={() => {
                      if (!availableModels) loadAvailableModels();
                      setModelDropdownOpen(!modelDropdownOpen);
                      setModelSearch('');
                      setSelectedProvider('');
                    }}
                    className={cn(
                      "flex items-center gap-1.5 text-xs font-mono transition-all cursor-pointer",
                      modelDropdownOpen
                        ? "text-primary"
                        : "text-muted-foreground hover:text-foreground"
                    )}
                  >
                    <Cpu className="w-3 h-3" />
                    <span>{model.includes('/') ? model.split('/').slice(1).join('/') : model}</span>
                    <ChevronDown className={cn("w-3 h-3 transition-transform", modelDropdownOpen && "rotate-180")} />
                  </button>

                      {modelDropdownOpen && (
                        <div className="absolute top-full left-0 mt-2 w-80 rounded-xl border bg-popover/95 backdrop-blur-sm shadow-2xl z-50 overflow-hidden flex flex-col">
                          {/* Provider tabs */}
                          {allProviders.size > 1 && (
                            <div className="flex gap-1.5 px-3 py-2.5 border-b bg-muted/30">
                              {Array.from(allProviders.keys()).map(pId => {
                                const count = allProviders.get(pId)?.length || 0;
                                return (
                                  <button
                                    key={pId}
                                    type="button"
                                    onClick={() => { setSelectedProvider(pId); setModelSearch(''); }}
                                    className={cn(
                                      "flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-medium transition-all",
                                      activeProvider === pId
                                        ? "bg-muted text-foreground border border-border"
                                        : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                                    )}
                                  >
                                    {pId}
                                    <span className="text-[9px] px-1.5 py-0.5 rounded-full font-mono bg-muted/60 text-muted-foreground">{count}</span>
                                  </button>
                                );
                              })}
                            </div>
                          )}
                          {/* Search input */}
                          <div className="flex items-center gap-2 px-3 py-2.5 border-b">
                            <Search className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                            <input
                              ref={modelSearchRef}
                              type="text"
                              value={modelSearch}
                              onChange={(e) => setModelSearch(e.target.value)}
                              placeholder={`Search ${activeProvider} models...`}
                              className="flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground/40"
                              autoFocus
                            />
                            {modelSearch && (
                              <button type="button" onClick={() => setModelSearch('')} className="text-muted-foreground hover:text-foreground">
                                <X className="w-3 h-3" />
                              </button>
                            )}
                          </div>
                          {/* Model list */}
                          <div className="max-h-64 overflow-y-auto p-1.5 custom-scrollbar">
                            {providerModels.length === 0 ? (
                              <div className="px-3 py-4 text-xs text-muted-foreground flex items-center justify-center gap-2">
                                {!availableModels ? (
                                  <><Loader2 className="w-3.5 h-3.5 animate-spin" />{t('common.loading')}</>
                                ) : (
                                  t('common.noResults')
                                )}
                              </div>
                            ) : (
                              providerModels.map(m => {
                                const modelId = model.includes('/') ? model.split('/').slice(1).join('/') : model;
                                const isActive = m.id === modelId && activeProvider === currentProvider;
                                return (
                                  <button
                                    key={m.id}
                                    type="button"
                                    onClick={() => handleModelChange(m.id, activeProvider)}
                                    className={cn(
                                      "w-full flex items-center gap-2 px-3 py-2 rounded-lg text-left text-xs transition-colors",
                                      isActive
                                        ? "bg-primary/10 text-primary font-medium"
                                        : "text-foreground/80 hover:bg-muted/80"
                                    )}
                                  >
                                    <Cpu className={cn("w-3 h-3 flex-shrink-0", isActive ? "text-primary" : "text-muted-foreground/40")} />
                                    <span className="truncate flex-1 font-mono">{m.name || m.id}</span>
                                    {m.contextWindow ? (
                                      <span className="text-[10px] text-muted-foreground/50 flex-shrink-0 font-mono">{Math.round(m.contextWindow / 1000)}k</span>
                                    ) : null}
                                    {isActive && <Check className="w-3.5 h-3.5 text-primary flex-shrink-0" />}
                                  </button>
                                );
                              })
                            )}
                          </div>
                        </div>
                      )}
                </div>
                {lastActivity && (
                  <>
                    <span className="w-1 h-1 rounded-full bg-muted-foreground/30" />
                    <span className="flex items-center gap-1 text-xs text-muted-foreground">
                      <Clock className="w-3 h-3" />
                      {lastActivity}
                    </span>
                  </>
                )}
                {agentId && (
                  <>
                    <span className="w-px h-3.5 bg-border mx-0.5" />
                    {([
                      { id: 'brain', icon: Brain, label: t('agentDetail.memory') },
                      { id: 'tools', icon: Wrench, label: t('agentDetail.tools') },
                      { id: 'skills', icon: Sparkles, label: t('agentDetail.skills') },
                    ] as const).map(item => (
                      <button
                        key={item.id}
                        onClick={() => setAgentTab(agentTab === item.id ? null : item.id)}
                        className={cn(
                          "flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium transition-all",
                          agentTab === item.id
                            ? "bg-primary/10 text-primary"
                            : "text-muted-foreground hover:text-foreground hover:bg-muted"
                        )}
                      >
                        <item.icon className="w-3 h-3" />
                        {item.label}
                      </button>
                    ))}
                    <span className="w-px h-3.5 bg-border mx-1" />
                    <span
                      onClick={() => navigate(`/agents/${agentId}`)}
                      className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-primary cursor-pointer transition-colors underline-offset-2 hover:underline"
                    >
                      <Settings className="w-3.5 h-3.5" />
                      Agent Settings ↗
                    </span>
                  </>
                )}
              </div>
            </div>

          </div>
        </div>
      </header>

      {/* Content: Chat or Agent Tab */}
      <div className="flex-1 overflow-hidden">
        <ChatView sessionKey={sessionKey} agentPanel={agentTab} onCloseAgentPanel={() => setAgentTab(null)} />
      </div>
    </div>
  );
}
