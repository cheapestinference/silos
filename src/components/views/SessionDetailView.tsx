import { useEffect, useState, useRef, useMemo, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useDashboardStore } from '../../store/dashboard-store';
import { cn, formatNumber } from '../../lib/utils';
import useTranslation from '../../i18n';
import {
  ArrowLeft,
  Bot,
  Activity,
  MessageSquare,
  Cpu,
  Sparkles,
  Hash,
  Clock,
  ChevronDown,
  Check,
  Loader2,
  Search,
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

interface StatCardProps {
  icon: React.ReactNode;
  value: number | string;
  label: string;
  color: 'cyan' | 'violet' | 'emerald' | 'amber';
  pulse?: boolean;
}

function StatCard({ icon, value, label, color, pulse }: StatCardProps) {
  const colorClasses = {
    cyan: 'text-cyan-600 dark:text-cyan-400 bg-cyan-500/10 border-cyan-500/25 dark:border-cyan-500/20',
    violet: 'text-violet-600 dark:text-violet-400 bg-violet-500/10 border-violet-500/25 dark:border-violet-500/20',
    emerald: 'text-emerald-600 dark:text-emerald-400 bg-emerald-500/10 border-emerald-500/25 dark:border-emerald-500/20',
    amber: 'text-amber-600 dark:text-amber-400 bg-amber-500/10 border-amber-500/25 dark:border-amber-500/20',
  };

  return (
    <div className={cn(
      "flex items-center gap-2 px-3 py-2 rounded-xl border",
      colorClasses[color]
    )}>
      <div className="relative">
        {icon}
        {pulse && (
          <span className="absolute -top-0.5 -right-0.5 w-2 h-2 bg-cyan-400 rounded-full animate-ping" />
        )}
      </div>
      <div className="text-right">
        <div className="text-sm font-bold">{value}</div>
        <div className="text-[10px] opacity-60 uppercase tracking-wide">{label}</div>
      </div>
    </div>
  );
}

export function SessionDetailView() {
  const { t } = useTranslation();
  const { key: sessionKey } = useParams<{ key: string }>();
  const navigate = useNavigate();
  const {
    agents,
    sessions,
    tasks,
    loadAgents,
    loadSessions,
    connected,
    loadAgentConfig,
    gatewayConfig,
    sessionCumulativeTokens,
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

  // Get tasks for this session
  const sessionTasks = tasks.filter(t => t.sessionKey === sessionKey);
  const runningTasks = sessionTasks.filter(t => t.status === 'running').length;
  const completedTasks = sessionTasks.filter(t => t.status === 'completed').length;

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
  const providerModels = useMemo(() => {
    if (!currentProvider || !availableModels) return [];
    const all = availableModels[currentProvider] || [];
    if (!modelSearch.trim()) return all;
    const q = modelSearch.toLowerCase();
    return all.filter(m => m.id.toLowerCase().includes(q) || (m.name && m.name.toLowerCase().includes(q)));
  }, [currentProvider, availableModels, modelSearch]);

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

  const { patchGatewayConfig, loadGatewayConfig } = useDashboardStore();

  const handleModelChange = useCallback(async (newModelId: string) => {
    if (!currentProvider || !agentId) return;
    const fullModel = `${currentProvider}/${newModelId}`;
    setOptimisticModel(fullModel);
    setModelDropdownOpen(false);
    try {
      const currentList: Array<Record<string, unknown>> = (agentsCfg?.list || []).map(a => ({ ...a }));
      const existingIdx = currentList.findIndex(a => a.id === agentId);

      if (existingIdx >= 0) {
        currentList[existingIdx] = { ...currentList[existingIdx], model: fullModel };
      } else {
        currentList.push({ id: agentId, model: fullModel });
      }

      const success = await patchGatewayConfig({ agents: { list: currentList } });
      if (success) {
        loadGatewayConfig();
        loadSessions();
      } else {
        setOptimisticModel(null); // revert on failure
      }
    } catch (err) {
      console.error('Failed to change model:', err);
      setOptimisticModel(null); // revert on error
    }
  }, [currentProvider, agentId, agentsCfg, patchGatewayConfig, loadGatewayConfig, loadSessions]);

  // Format last activity
  const lastActivity = session?.updatedAt
    ? formatDistanceToNow(session.updatedAt, { addSuffix: true })
    : null;

  return (
    <div className="h-full flex flex-col bg-background overflow-hidden">
      {/* Header */}
      <header className="shrink-0 border-b bg-card">
        <div className="h-[1px] bg-gradient-to-r from-transparent via-violet-500/30 to-transparent" />

        <div className="px-6 py-4">
          <div className="flex items-center gap-4">
            {/* Back Button */}
            <button
              onClick={() => navigate(-1)}
              className="p-2 rounded-xl border bg-muted hover:bg-muted/80 transition-all text-muted-foreground hover:text-foreground group"
            >
              <ArrowLeft className="w-4 h-4 group-hover:-translate-x-0.5 transition-transform" />
            </button>

            {/* Session & Agent Identity */}
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-4">
                {/* Agent Avatar */}
                <div className="relative shrink-0">
                  <div className="w-14 h-14 rounded-2xl bg-violet-500/10 border border-violet-500/20 flex items-center justify-center">
                    {agentEmoji ? (
                      <span className="text-2xl">{agentEmoji}</span>
                    ) : (
                      <Bot className="w-7 h-7 text-violet-500 dark:text-violet-400" />
                    )}
                  </div>
                  {isOnline && (
                    <div className="absolute -bottom-0.5 -right-0.5 w-4 h-4 bg-emerald-400 rounded-full border-2 border-card flex items-center justify-center">
                      <span className="w-2 h-2 bg-emerald-400 rounded-full animate-ping absolute" />
                    </div>
                  )}
                </div>

                {/* Names & Info */}
                <div className="min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <Hash className="w-5 h-5 text-violet-500 dark:text-violet-400 shrink-0" />
                    <h1 className="text-xl font-bold text-foreground truncate">
                      {sessionName}
                    </h1>
                  </div>
                  <div className="flex items-center gap-3 flex-wrap">
                    <span
                      className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground cursor-pointer transition-colors"
                      onClick={() => agentId && navigate(`/agents/${agentId}`)}
                    >
                      {agentEmoji ? (
                        <span className="text-xs">{agentEmoji}</span>
                      ) : (
                        <Bot className="w-3.5 h-3.5" />
                      )}
                      <span className="font-medium">{agentName}</span>
                    </span>
                    <span className="w-1 h-1 rounded-full bg-border" />
                    <div className="relative" ref={modelDropdownRef}>
                      <button
                        type="button"
                        onClick={() => {
                          if (!availableModels) loadAvailableModels();
                          setModelDropdownOpen(!modelDropdownOpen);
                          setModelSearch('');
                        }}
                        className="flex items-center gap-1.5 text-xs text-muted-foreground font-mono hover:text-foreground transition-colors cursor-pointer"
                      >
                        <Cpu className="w-3 h-3" />
                        <span>{model.includes('/') ? model.split('/').slice(1).join('/') : model}</span>
                        <ChevronDown className={cn("w-3 h-3 transition-transform", modelDropdownOpen && "rotate-180")} />
                      </button>

                      {modelDropdownOpen && (
                        <div className="absolute top-full left-0 mt-2 w-72 rounded-lg border bg-popover shadow-xl z-50 overflow-hidden">
                          {/* Search input */}
                          <div className="flex items-center gap-2 px-3 py-2 border-b">
                            <Search className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                            <input
                              ref={modelSearchRef}
                              type="text"
                              value={modelSearch}
                              onChange={(e) => setModelSearch(e.target.value)}
                              placeholder={t('common.search')}
                              className="flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground/50"
                              autoFocus
                            />
                          </div>
                          {/* Model list */}
                          <div className="max-h-56 overflow-y-auto py-1 custom-scrollbar">
                            {providerModels.length === 0 ? (
                              <div className="px-3 py-2 text-xs text-muted-foreground flex items-center gap-2">
                                {!availableModels ? (
                                  <><Loader2 className="w-3 h-3 animate-spin" />{t('common.loading')}</>
                                ) : (
                                  t('common.noResults')
                                )}
                              </div>
                            ) : (
                              providerModels.map(m => {
                                const modelId = model.includes('/') ? model.split('/').slice(1).join('/') : model;
                                const isActive = m.id === modelId;
                                return (
                                  <button
                                    key={m.id}
                                    type="button"
                                    onClick={() => !isActive && handleModelChange(m.id)}
                                    className={cn(
                                      "w-full text-left px-3 py-1.5 text-xs font-mono transition-colors flex items-center justify-between gap-2",
                                      isActive
                                        ? "bg-indigo-500/10 text-indigo-600 dark:text-indigo-400"
                                        : "text-foreground/80 hover:bg-muted"
                                    )}
                                  >
                                    <span className="truncate">{m.name || m.id}</span>
                                    {isActive && <Check className="w-3 h-3 shrink-0" />}
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
                        <span className="w-1 h-1 rounded-full bg-border" />
                        <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                          <Clock className="w-3 h-3" />
                          {lastActivity}
                        </span>
                      </>
                    )}
                  </div>
                </div>
              </div>
            </div>

            {/* Live Stats */}
            <div className="flex items-center gap-3 shrink-0">
              <StatCard
                icon={<Activity className="w-3.5 h-3.5" />}
                value={runningTasks}
                label={t('sessionDetail.active')}
                color="cyan"
                pulse={runningTasks > 0}
              />
              <StatCard
                icon={<MessageSquare className="w-3.5 h-3.5" />}
                value={formatNumber(sessionCumulativeTokens.get(sessionKey!)?.total || (session?.inputTokens || 0) + (session?.outputTokens || 0))}
                label={t('sessionDetail.totalSession')}
                color="violet"
              />
              <StatCard
                icon={<Sparkles className="w-3.5 h-3.5" />}
                value={completedTasks}
                label={t('sessionDetail.done')}
                color="emerald"
              />
            </div>
          </div>
        </div>
      </header>

      {/* Chat Content */}
      <div className="flex-1 overflow-hidden">
        <ChatView sessionKey={sessionKey} />
      </div>
    </div>
  );
}
