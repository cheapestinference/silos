import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useDashboardStore } from '../../store/dashboard-store';
import { cn } from '../../lib/utils';
import {
  ArrowLeft,
  Bot,
  Brain,
  Wrench,
  Settings,
  Activity,
  MessageSquare,
  FileText,
  Plus,
  Trash2,
  Edit3,
  Save,
  X as XIcon,
  BookOpen,
  Cpu,
  Database,
  Gauge,
  RefreshCw,
  ExternalLink,
  Sparkles,
  Terminal,
  Zap,
  CheckCircle2,
  Clock,
  AlertTriangle,
  Download,
  Users,
  Copy,
  Check,
  CalendarClock,
  FolderOpen,
  Package,
} from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { CronJobList, CronJobForm, CronStatsWidget } from '../cron';
import { SettingsTab } from './SettingsTab';
import { WorkspacePanel } from './WorkspacePanel';
import { KnowledgeBrowser } from './KnowledgeBrowser';
import useTranslation from '../../i18n';
import type { AgentSummary, CronJob } from '../../types/openclaw';

export function AgentDetailView() {
  const { t } = useTranslation();
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const {
    agents,
    sessions,
    tasks,
    loadAgents,
    loadSessions,
    connected,
    selectedAgentConfig,
    loadAgentConfig,
    cronJobs,
    toggleCronJob,
    runCronJob,
    deleteCronJob,
    addCronJob,
    updateCronJob,
    deleteAgent,
    resetAgent,
    gatewayConfig,
  } = useDashboardStore();
  const [activeTab, setActiveTab] = useState<'overview' | 'memory' | 'workspace' | 'tools' | 'skills' | 'knowledge' | 'scheduled' | 'config'>('overview');
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    if (connected) {
      loadAgents();
      loadSessions();
      if (id) {
        loadAgentConfig(id);
      }
    }
  }, [connected, loadAgents, loadSessions, loadAgentConfig, id]);

  if (!id) {
    navigate('/agents');
    return null;
  }

  const agent = agents?.agents.find(a => a.id === id);
  const agentSessions = sessions?.sessions.filter(s => s.key.includes(id)) || [];

  // Filter tasks that belong to this agent - includes tasks where:
  // 1. agentId matches directly
  // 2. sessionKey starts with agent:{id}: (catches subagent tasks)
  const agentTasks = tasks.filter(t => {
    const matchesAgentId = t.agentId === id;
    const matchesSessionKey = t.sessionKey?.startsWith(`agent:${id}:`);
    return matchesAgentId || matchesSessionKey;
  });

  const runningTasks = agentTasks.filter(t => t.status === 'running').length;
  const completedTasks = agentTasks.filter(t => t.status === 'completed').length;

  // Filter cron jobs that belong to this agent
  const agentCronJobs = cronJobs.filter(j => j.agentId === id);

  if (!agent) {
    return (
      <div className="h-full flex items-center justify-center bg-background">
        <div className="text-center animate-in fade-in zoom-in duration-300">
          <div className="w-20 h-20 rounded-2xl bg-gradient-to-br from-violet-500/10 to-purple-600/10 border border-violet-500/20 flex items-center justify-center mx-auto mb-4">
            <Bot className="w-10 h-10 text-violet-600 dark:text-violet-400/50" />
          </div>
          <p className="text-sm text-muted-foreground mb-1">{t('agentDetail.agentNotFound')}</p>
          <p className="text-xs text-muted-foreground">{t('agentDetail.agentNotFoundDescription')}</p>
        </div>
      </div>
    );
  }

  const agentName = agent.identity?.name || agent.name || agent.id;
  const agentEmoji = agent.identity?.emoji;
  // Resolve active model: per-agent override > global default
  const agentsCfg = (gatewayConfig?.config as Record<string, unknown>)?.agents as
    { defaults?: { model?: { primary?: string } }; list?: Array<{ id: string; model?: string | { primary?: string } }> } | undefined;
  const headerAgentEntry = agentsCfg?.list?.find(a => a.id === id);
  const headerAgentOverride = headerAgentEntry?.model
    ? (typeof headerAgentEntry.model === 'string' ? headerAgentEntry.model : headerAgentEntry.model.primary || '')
    : '';
  const model = headerAgentOverride || agentsCfg?.defaults?.model?.primary || 'Not configured';
  const isOnline = true;

  const isMainAgent = id === 'main';

  const handleDeleteAgent = async () => {
    setDeleting(true);
    if (isMainAgent) {
      const success = await resetAgent(id);
      setDeleting(false);
      if (success) {
        setShowDeleteConfirm(false);
      }
    } else {
      const success = await deleteAgent(id);
      setDeleting(false);
      if (success) {
        setShowDeleteConfirm(false);
        navigate('/agents');
      }
    }
  };

  return (
    <div className="h-full flex flex-col bg-background overflow-hidden">
      {/* Premium Header */}
      <header className="shrink-0 border-b border-border bg-gradient-to-b from-muted/60 to-transparent">
        {/* Top accent line */}
        <div className="h-[1px] bg-gradient-to-r from-transparent via-violet-500/30 to-transparent" />

        <div className="px-6 py-4">
          <div className="flex items-center gap-4 mb-4">
            {/* Back Button */}
            <button
              onClick={() => navigate('/agents')}
              className="p-2 rounded-xl bg-muted border border-border hover:border-border hover:bg-muted transition-all text-muted-foreground hover:text-foreground group"
            >
              <ArrowLeft className="w-4 h-4 group-hover:-translate-x-0.5 transition-transform" />
            </button>

            {/* Agent Identity */}
            <div className="flex-1">
              <div className="flex items-center gap-4">
                <div className="relative">
                  <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-violet-500/20 via-purple-500/20 to-fuchsia-500/20 border border-violet-500/30 flex items-center justify-center shadow-lg shadow-violet-500/10">
                    {agentEmoji ? (
                      <span className="text-2xl">{agentEmoji}</span>
                    ) : (
                      <Bot className="w-7 h-7 text-violet-600 dark:text-violet-400" />
                    )}
                  </div>
                  {isOnline && (
                    <div className="absolute -bottom-0.5 -right-0.5 w-4 h-4 bg-emerald-400 rounded-full border-2 border-background flex items-center justify-center">
                      <span className="w-2 h-2 bg-emerald-400 rounded-full animate-ping absolute" />
                    </div>
                  )}
                </div>
                <div>
                  <h1 className="text-xl font-bold text-foreground mb-0.5" style={{ fontFamily: 'Inter, system-ui, sans-serif' }}>
                    {agentName}
                  </h1>
                  <div className="flex items-center gap-3">
                    <span className="flex items-center gap-1.5 text-xs text-muted-foreground font-mono">
                      <Cpu className="w-3 h-3" />
                      {model}
                    </span>
                    <span className="w-1 h-1 rounded-full bg-muted-foreground" />
                    <span className="text-xs text-muted-foreground font-mono">{id}</span>
                  </div>
                </div>
              </div>
            </div>

            {/* Live Stats & Actions */}
            <div className="flex items-center gap-3">
              <StatCard
                icon={<Activity className="w-3.5 h-3.5" />}
                value={runningTasks}
                label={t('agentDetail.active')}
                color="cyan"
                pulse={runningTasks > 0}
              />
              <StatCard
                icon={<MessageSquare className="w-3.5 h-3.5" />}
                value={agentSessions.length}
                label={t('agentDetail.sessions')}
                color="violet"
              />
              <StatCard
                icon={<Sparkles className="w-3.5 h-3.5" />}
                value={completedTasks}
                label={t('agentDetail.done')}
                color="emerald"
              />
              <div className="w-px h-8 bg-muted mx-1" />
              <button
                onClick={() => setShowDeleteConfirm(true)}
                className={cn(
                  "p-2.5 rounded-xl bg-muted border border-border transition-all group",
                  isMainAgent
                    ? "hover:border-amber-500/30 hover:bg-amber-500/10 text-muted-foreground hover:text-amber-600 dark:text-amber-400"
                    : "hover:border-red-500/30 hover:bg-red-500/10 text-muted-foreground hover:text-red-600 dark:text-red-400"
                )}
                title={isMainAgent ? t('agentDetail.resetAgent') : t('agentDetail.deleteAgent')}
              >
                {isMainAgent ? <RefreshCw className="w-4 h-4" /> : <Trash2 className="w-4 h-4" />}
              </button>
            </div>
          </div>

          {/* Tab Navigation - Modern pills */}
          <div className="flex items-center gap-1 p-1 bg-muted rounded-xl border border-border w-fit">
            <TabButton
              active={activeTab === 'overview'}
              onClick={() => setActiveTab('overview')}
              icon={<Gauge className="w-3.5 h-3.5" />}
              label={t('agentDetail.overview')}
            />
            <TabButton
              active={activeTab === 'memory'}
              onClick={() => setActiveTab('memory')}
              icon={<Brain className="w-3.5 h-3.5" />}
              label={t('agentDetail.memory')}
            />
            <TabButton
              active={activeTab === 'workspace'}
              onClick={() => setActiveTab('workspace')}
              icon={<FolderOpen className="w-3.5 h-3.5" />}
              label={t('agentDetail.workspace')}
            />
            <TabButton
              active={activeTab === 'tools'}
              onClick={() => setActiveTab('tools')}
              icon={<Wrench className="w-3.5 h-3.5" />}
              label={t('agentDetail.tools')}
            />
            <TabButton
              active={activeTab === 'skills'}
              onClick={() => setActiveTab('skills')}
              icon={<Sparkles className="w-3.5 h-3.5" />}
              label={t('agentDetail.skills')}
            />
            <TabButton
              active={activeTab === 'knowledge'}
              onClick={() => setActiveTab('knowledge')}
              icon={<BookOpen className="w-3.5 h-3.5" />}
              label={t('agentDetail.knowledgeTab')}
            />
            <TabButton
              active={activeTab === 'scheduled'}
              onClick={() => setActiveTab('scheduled')}
              icon={<CalendarClock className="w-3.5 h-3.5" />}
              label={t('agentDetail.automation')}
              badge={agentCronJobs.length > 0 ? agentCronJobs.length : undefined}
            />
            <TabButton
              active={activeTab === 'config'}
              onClick={() => setActiveTab('config')}
              icon={<Settings className="w-3.5 h-3.5" />}
              label={t('agentDetail.config')}
            />
          </div>
        </div>
      </header>

      {/* Content Area */}
      <div className="flex-1 overflow-hidden">
        {activeTab === 'overview' && (
          <OverviewPanel
            agentId={id}
            agent={agent}
            tasks={agentTasks}
            sessions={agentSessions}
            runningTasks={runningTasks}
            completedTasks={completedTasks}
            cronJobs={agentCronJobs}
            onViewScheduled={() => setActiveTab('scheduled')}
          />
        )}
        {activeTab === 'memory' && (
          <MemoryPanel agentId={id} />
        )}
        {activeTab === 'workspace' && (
          <WorkspacePanel agentId={id} />
        )}
        {activeTab === 'tools' && (
          <AgentToolsPanel agentId={id} />
        )}
        {activeTab === 'skills' && (
          <SkillsPanel agent={agent} />
        )}
        {activeTab === 'knowledge' && (
          <KnowledgeBrowser agentId={id} />
        )}
        {activeTab === 'scheduled' && (
          <ScheduledPanel
            agentId={id}
            cronJobs={agentCronJobs}
            onToggle={toggleCronJob}
            onRun={runCronJob}
            onDelete={deleteCronJob}
            onAdd={addCronJob}
            onUpdate={updateCronJob}
          />
        )}
        {activeTab === 'config' && (
          <ConfigPanel agent={agent} config={selectedAgentConfig} onNavigateToMemory={() => setActiveTab('memory')} />
        )}
      </div>

      {/* Delete/Reset Confirmation Modal */}
      {showDeleteConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div
            className="absolute inset-0 bg-black/60 backdrop-blur-sm"
            onClick={() => !deleting && setShowDeleteConfirm(false)}
          />
          <div className="relative w-full max-w-md mx-4 bg-gradient-to-br from-card via-card to-muted border border-border rounded-xl shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-200">
            {/* Header */}
            <div className="px-6 py-4 border-b border-border bg-muted">
              <div className="flex items-center gap-3">
                <div className={cn(
                  "p-2 border rounded-lg",
                  isMainAgent
                    ? "bg-gradient-to-br from-amber-500/20 to-yellow-500/20 border-amber-500/30"
                    : "bg-gradient-to-br from-red-500/20 to-orange-500/20 border-red-500/30"
                )}>
                  {isMainAgent
                    ? <RefreshCw className="w-4 h-4 text-amber-600 dark:text-amber-400" />
                    : <Trash2 className="w-4 h-4 text-red-600 dark:text-red-400" />
                  }
                </div>
                <div>
                  <h2 className="text-sm font-bold text-foreground uppercase tracking-wider" style={{ fontFamily: 'IBM Plex Mono, monospace' }}>
                    {isMainAgent ? t('agentDetail.resetAgent') : t('agentDetail.deleteAgent')}
                  </h2>
                  <p className="text-xs text-muted-foreground font-mono">
                    {isMainAgent ? t('agentDetail.resetDescription') : t('agentDetail.deleteWarning')}
                  </p>
                </div>
              </div>
            </div>

            {/* Content */}
            <div className="px-6 py-5 space-y-4">
              <p className="text-sm text-foreground/80">
                {isMainAgent ? (
                  <>{t('agentDetail.confirmReset')} <span className="font-semibold text-foreground">{agentName}</span>?</>
                ) : (
                  <>{t('agentDetail.confirmDelete')} <span className="font-semibold text-foreground">{agentName}</span>?</>
                )}
              </p>
              <div className={cn(
                "p-3 border rounded-lg",
                isMainAgent ? "bg-amber-500/10 border-amber-500/20" : "bg-red-500/10 border-red-500/20"
              )}>
                <p className={cn("text-xs font-mono", isMainAgent ? "text-amber-600 dark:text-amber-400" : "text-red-600 dark:text-red-400")}>
                  {isMainAgent
                    ? t('agentDetail.resetDetails')
                    : t('agentDetail.deleteDetails')
                  }
                </p>
              </div>
            </div>

            {/* Footer */}
            <div className="px-6 py-4 border-t border-border bg-muted flex items-center justify-end gap-3">
              <button
                onClick={() => setShowDeleteConfirm(false)}
                disabled={deleting}
                className="px-4 py-2 text-xs font-bold text-foreground/80 hover:text-foreground uppercase tracking-wider transition-colors disabled:opacity-50"
                style={{ fontFamily: 'IBM Plex Mono, monospace' }}
              >
                {t('common.cancel')}
              </button>
              <button
                onClick={handleDeleteAgent}
                disabled={deleting}
                className={cn(
                  "px-4 py-2 text-white text-xs font-bold uppercase tracking-wider rounded-lg transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2",
                  isMainAgent
                    ? "bg-gradient-to-r from-amber-500 to-yellow-500 hover:from-amber-400 hover:to-yellow-400"
                    : "bg-gradient-to-r from-red-500 to-orange-500 hover:from-red-400 hover:to-orange-400"
                )}
                style={{ fontFamily: 'IBM Plex Mono, monospace' }}
              >
                {deleting ? (
                  <>
                    <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                    {isMainAgent ? t('agentDetail.resetting') : t('agentDetail.deleting')}
                  </>
                ) : (
                  <>
                    {isMainAgent ? <RefreshCw className="w-3.5 h-3.5" /> : <Trash2 className="w-3.5 h-3.5" />}
                    {isMainAgent ? t('agentDetail.resetAgent') : t('agentDetail.deleteAgent')}
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// Stat Card Component
interface StatCardProps {
  icon: React.ReactNode;
  value: number;
  label: string;
  color: 'cyan' | 'violet' | 'emerald';
  pulse?: boolean;
}

function StatCard({ icon, value, label, color, pulse }: StatCardProps) {
  const colorClasses = {
    cyan: {
      bg: 'bg-cyan-500/10',
      border: 'border-cyan-500/20',
      icon: 'text-cyan-600 dark:text-cyan-400',
      value: 'text-cyan-700 dark:text-cyan-300',
    },
    violet: {
      bg: 'bg-violet-500/10',
      border: 'border-violet-500/20',
      icon: 'text-violet-600 dark:text-violet-400',
      value: 'text-violet-700 dark:text-violet-300',
    },
    emerald: {
      bg: 'bg-emerald-500/10',
      border: 'border-emerald-500/20',
      icon: 'text-emerald-600 dark:text-emerald-400',
      value: 'text-emerald-700 dark:text-emerald-300',
    },
  };

  const styles = colorClasses[color];

  return (
    <div className={cn(
      "flex items-center gap-2.5 px-3 py-2 rounded-xl border",
      styles.bg,
      styles.border
    )}>
      <span className={cn("relative", styles.icon)}>
        {icon}
        {pulse && value > 0 && (
          <span className={cn("absolute -top-0.5 -right-0.5 w-1.5 h-1.5 rounded-full", styles.icon.replace('text-', 'bg-'), "animate-ping")} />
        )}
      </span>
      <div className="flex flex-col">
        <span className={cn("text-sm font-bold tabular-nums leading-none", styles.value)}>
          {value}
        </span>
        <span className="text-[9px] text-muted-foreground uppercase tracking-wider">{label}</span>
      </div>
    </div>
  );
}

// Tab Button Component
interface TabButtonProps {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  badge?: number;
}

function TabButton({ active, onClick, icon, label, badge }: TabButtonProps) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-semibold transition-all duration-200 relative",
        active
          ? "bg-gradient-to-r from-violet-500/20 to-purple-500/20 text-violet-700 dark:text-violet-300 shadow-lg shadow-violet-500/5"
          : "text-muted-foreground hover:text-foreground hover:bg-muted"
      )}
      style={{ fontFamily: 'Inter, system-ui, sans-serif' }}
    >
      {icon}
      <span>{label}</span>
      {badge !== undefined && badge > 0 && (
        <span className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-cyan-500 text-[9px] font-bold text-white flex items-center justify-center animate-pulse">
          {badge}
        </span>
      )}
    </button>
  );
}

// Overview Panel Component - Dashboard with stats and task pipeline
interface OverviewPanelProps {
  agentId: string;
  agent: AgentSummary;
  tasks: import('../../types/openclaw').Task[];
  sessions: Array<{ key: string; label?: string; displayName?: string; updatedAt?: number | null; totalTokens?: number }>;
  runningTasks: number;
  completedTasks: number;
  cronJobs: CronJob[];
  onViewScheduled: () => void;
}

function OverviewPanel({ agentId, tasks, sessions, runningTasks, completedTasks, cronJobs, onViewScheduled }: OverviewPanelProps) {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const { selectSession, addSessionOptimistic } = useDashboardStore();

  // Group tasks by status
  const runningTasksList = tasks.filter(t => t.status === 'running');
  const completedTasksList = tasks.filter(t => t.status === 'completed').slice(0, 10);
  const failedTasksList = tasks.filter(t => t.status === 'error' || t.status === 'aborted').slice(0, 5);

  // Calculate stats
  const totalTokens = sessions.reduce((acc, s) => acc + (s.totalTokens || 0), 0);
  const avgTokensPerSession = sessions.length > 0 ? Math.round(totalTokens / sessions.length) : 0;
  const successRate = tasks.length > 0
    ? Math.round((completedTasks / tasks.length) * 100)
    : 100;

  const formatDuration = (startedAt: number, completedAt?: number) => {
    const end = completedAt || Date.now();
    const durationMs = end - startedAt;
    const seconds = Math.floor(durationMs / 1000);
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    if (minutes > 0) return `${minutes}m ${remainingSeconds}s`;
    return `${seconds}s`;
  };

  const handleSessionClick = (sessionKey: string) => {
    selectSession(sessionKey);
    navigate(`/session/${encodeURIComponent(sessionKey)}`);
  };

  return (
    <div className="h-full flex animate-in fade-in duration-300">
      {/* Left: Dashboard (1/3) */}
      <div className="w-[380px] overflow-y-auto p-6 space-y-6 border-r border-border">
        {/* Quick Stats Grid */}
        <div className="grid grid-cols-2 gap-3">
          <div className="p-4 rounded-xl bg-gradient-to-br from-cyan-500/10 to-cyan-600/5 border border-cyan-500/20">
            <div className="flex items-center gap-3 mb-2">
              <div className="w-10 h-10 rounded-lg bg-cyan-500/20 flex items-center justify-center">
                <Zap className="w-5 h-5 text-cyan-600 dark:text-cyan-400" />
              </div>
              <div>
                <p className="text-2xl font-bold text-cyan-700 dark:text-cyan-300">{runningTasks}</p>
                <p className="text-[10px] text-muted-foreground uppercase tracking-wider">{t('agentDetail.activeTasks')}</p>
              </div>
            </div>
          </div>

          <div className="p-4 rounded-xl bg-gradient-to-br from-emerald-500/10 to-emerald-600/5 border border-emerald-500/20">
            <div className="flex items-center gap-3 mb-2">
              <div className="w-10 h-10 rounded-lg bg-emerald-500/20 flex items-center justify-center">
                <CheckCircle2 className="w-5 h-5 text-emerald-600 dark:text-emerald-400" />
              </div>
              <div>
                <p className="text-2xl font-bold text-emerald-700 dark:text-emerald-300">{completedTasks}</p>
                <p className="text-[10px] text-muted-foreground uppercase tracking-wider">{t('agentDetail.completed')}</p>
              </div>
            </div>
          </div>

          <div className="p-4 rounded-xl bg-gradient-to-br from-violet-500/10 to-violet-600/5 border border-violet-500/20">
            <div className="flex items-center gap-3 mb-2">
              <div className="w-10 h-10 rounded-lg bg-violet-500/20 flex items-center justify-center">
                <MessageSquare className="w-5 h-5 text-violet-600 dark:text-violet-400" />
              </div>
              <div>
                <p className="text-2xl font-bold text-violet-700 dark:text-violet-300">{sessions.length}</p>
                <p className="text-[10px] text-muted-foreground uppercase tracking-wider">{t('agentDetail.sessions')}</p>
              </div>
            </div>
          </div>

          <div className="p-4 rounded-xl bg-gradient-to-br from-amber-500/10 to-amber-600/5 border border-amber-500/20">
            <div className="flex items-center gap-3 mb-2">
              <div className="w-10 h-10 rounded-lg bg-amber-500/20 flex items-center justify-center">
                <Gauge className="w-5 h-5 text-amber-600 dark:text-amber-400" />
              </div>
              <div>
                <p className="text-2xl font-bold text-amber-600 dark:text-amber-300">{successRate}%</p>
                <p className="text-[10px] text-muted-foreground uppercase tracking-wider">{t('agentDetail.successRate')}</p>
              </div>
            </div>
          </div>
        </div>

        {/* Sessions Section */}
        <div className="rounded-xl border border-border bg-muted/50 overflow-hidden">
          <div className="px-4 py-3 border-b border-border flex items-center justify-between">
            <div className="flex items-center gap-2">
              <MessageSquare className="w-4 h-4 text-violet-600 dark:text-violet-400" />
              <h3 className="text-sm font-semibold text-foreground">{t('agentDetail.recentSessions')}</h3>
            </div>
            <span className="text-xs text-muted-foreground">{sessions.length} total</span>
          </div>
          <div className="divide-y divide-border">
            {sessions.length === 0 ? (
              <div className="p-8 text-center">
                <MessageSquare className="w-8 h-8 text-muted-foreground mx-auto mb-2" />
                <p className="text-sm text-muted-foreground">{t('agentDetail.noSessions')}</p>
                <p className="text-xs text-muted-foreground mb-4">{t('agentDetail.sessionsEmptyDescription')}</p>
                <button
                  onClick={() => {
                    const label = 'chat';
                    const sessionKey = `agent:${agentId}:${label}-${Date.now()}`;
                    addSessionOptimistic(sessionKey, label);
                    navigate(`/session/${sessionKey}`);
                  }}
                  className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-medium rounded-lg transition-colors inline-flex items-center gap-2"
                >
                  <MessageSquare className="w-4 h-4" />
                  {t('agentDetail.startChatting')}
                </button>
              </div>
            ) : (
              sessions.slice(0, 5).map((session) => {
                const sessionName = session.displayName || session.label || session.key.split(':').pop() || session.key;
                return (
                  <button
                    key={session.key}
                    onClick={() => handleSessionClick(session.key)}
                    className="w-full px-4 py-3 flex items-center gap-3 hover:bg-muted transition-colors text-left"
                  >
                    <div className="w-8 h-8 rounded-lg bg-violet-500/10 border border-violet-500/20 flex items-center justify-center">
                      <MessageSquare className="w-4 h-4 text-violet-600 dark:text-violet-400" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-foreground truncate">{sessionName}</p>
                      <p className="text-[10px] text-muted-foreground">
                        {session.updatedAt ? formatDistanceToNow(session.updatedAt, { addSuffix: true }) : 'Just now'}
                        {session.totalTokens ? ` • ${session.totalTokens.toLocaleString()} tokens` : ''}
                      </p>
                    </div>
                    <ExternalLink className="w-3.5 h-3.5 text-muted-foreground" />
                  </button>
                );
              })
            )}
          </div>
        </div>

        {/* Scheduled Jobs Widget */}
        {cronJobs.length > 0 && (
          <CronStatsWidget
            jobs={cronJobs}
            onViewAll={onViewScheduled}
          />
        )}

        {/* Usage Stats */}
        <div className="space-y-4">
          <div className="rounded-xl border border-border bg-muted/50 p-4">
            <div className="flex items-center gap-2 mb-4">
              <Database className="w-4 h-4 text-blue-500 dark:text-blue-400" />
              <h3 className="text-sm font-semibold text-foreground">{t('agentDetail.tokenUsage')}</h3>
            </div>
            <div className="space-y-3">
              <div className="flex justify-between items-center">
                <span className="text-xs text-muted-foreground">{t('agentDetail.totalTokens')}</span>
                <span className="text-sm font-mono text-foreground">{totalTokens.toLocaleString()}</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-xs text-muted-foreground">{t('agentDetail.avgPerSession')}</span>
                <span className="text-sm font-mono text-foreground">{avgTokensPerSession.toLocaleString()}</span>
              </div>
              <div className="h-2 bg-card rounded-full overflow-hidden">
                <div
                  className="h-full bg-gradient-to-r from-blue-500 to-cyan-500 rounded-full"
                  style={{ width: `${Math.min(100, (totalTokens / 100000) * 100)}%` }}
                />
              </div>
            </div>
          </div>

          <div className="rounded-xl border border-border bg-muted/50 p-4">
            <div className="flex items-center gap-2 mb-4">
              <Activity className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
              <h3 className="text-sm font-semibold text-foreground">{t('agentDetail.taskPerformance')}</h3>
            </div>
            <div className="space-y-3">
              <div className="flex justify-between items-center">
                <span className="text-xs text-muted-foreground">{t('agentDetail.totalTasks')}</span>
                <span className="text-sm font-mono text-foreground">{tasks.length}</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-xs text-muted-foreground">{t('agentDetail.failed')}</span>
                <span className="text-sm font-mono text-red-600 dark:text-red-400">{failedTasksList.length}</span>
              </div>
              <div className="h-2 bg-card rounded-full overflow-hidden flex">
                <div
                  className="h-full bg-emerald-500"
                  style={{ width: `${successRate}%` }}
                />
                <div
                  className="h-full bg-red-500"
                  style={{ width: `${100 - successRate}%` }}
                />
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Right: Task Pipeline (2/3) */}
      <div className="flex-1 bg-muted/50 flex flex-col">
        <div className="px-4 py-3 border-b border-border">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Zap className="w-4 h-4 text-cyan-600 dark:text-cyan-400" />
              <h3 className="text-sm font-semibold text-foreground">{t('agentDetail.taskPipeline')}</h3>
            </div>
            {runningTasks > 0 && (
              <span className="px-2 py-0.5 rounded-full bg-cyan-500/20 text-cyan-600 dark:text-cyan-400 text-[10px] font-bold animate-pulse">
                {t('agentDetail.activeCount', { count: runningTasks })}
              </span>
            )}
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-3 space-y-3">
          {/* Running Tasks */}
          {runningTasksList.length > 0 && (
            <div className="space-y-2">
              <p className="text-[10px] font-semibold text-cyan-600 dark:text-cyan-400 uppercase tracking-wider px-1">{t('agentDetail.running')}</p>
              {runningTasksList.map((task) => (
                <div
                  key={task.id}
                  className="p-3 rounded-lg bg-cyan-500/10 border border-cyan-500/20 animate-pulse"
                >
                  <div className="flex items-start gap-2">
                    <div className="w-6 h-6 rounded bg-cyan-500/20 flex items-center justify-center shrink-0 mt-0.5">
                      <Zap className="w-3.5 h-3.5 text-cyan-600 dark:text-cyan-400" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-medium text-foreground truncate">
                        {task.runId || task.id}
                      </p>
                      <p className="text-[10px] text-muted-foreground mt-0.5">
                        {task.startedAt && formatDuration(task.startedAt)}
                      </p>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Completed Tasks */}
          {completedTasksList.length > 0 && (
            <div className="space-y-2">
              <p className="text-[10px] font-semibold text-emerald-600 dark:text-emerald-400 uppercase tracking-wider px-1">{t('agentDetail.completed')}</p>
              {completedTasksList.map((task) => (
                <div
                  key={task.id}
                  className="p-3 rounded-lg bg-muted border border-border hover:border-border transition-colors"
                >
                  <div className="flex items-start gap-2">
                    <div className="w-6 h-6 rounded bg-emerald-500/10 flex items-center justify-center shrink-0 mt-0.5">
                      <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-medium text-foreground/80 truncate">
                        {task.runId || task.id}
                      </p>
                      <p className="text-[10px] text-muted-foreground mt-0.5">
                        {task.startedAt && task.completedAt && formatDuration(task.startedAt, task.completedAt)}
                      </p>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Failed Tasks */}
          {failedTasksList.length > 0 && (
            <div className="space-y-2">
              <p className="text-[10px] font-semibold text-red-600 dark:text-red-400 uppercase tracking-wider px-1">{t('agentDetail.failed')}</p>
              {failedTasksList.map((task) => (
                <div
                  key={task.id}
                  className="p-3 rounded-lg bg-red-500/5 border border-red-500/20"
                >
                  <div className="flex items-start gap-2">
                    <div className="w-6 h-6 rounded bg-red-500/10 flex items-center justify-center shrink-0 mt-0.5">
                      <AlertTriangle className="w-3.5 h-3.5 text-red-600 dark:text-red-400" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-medium text-foreground/80 truncate">
                        {task.runId || task.id}
                      </p>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Empty State */}
          {tasks.length === 0 && (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <div className="w-12 h-12 rounded-xl bg-muted flex items-center justify-center mb-3">
                <Zap className="w-6 h-6 text-muted-foreground" />
              </div>
              <p className="text-sm text-muted-foreground">{t('agentDetail.noTasks')}</p>
              <p className="text-xs text-muted-foreground mt-1">{t('agentDetail.tasksEmptyDescription')}</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// Memory Panel Component - Shows agent workspace files organized by category
interface MemoryPanelProps {
  agentId: string;
}

// File categories based on OpenClaw workspace structure
const FILE_CATEGORIES = [
  {
    id: 'identity',
    labelKey: 'agentDetail.identity' as const,
    icon: Sparkles,
    color: 'violet',
    descriptionKey: 'agentDetail.identityDescription' as const,
    files: [
      { name: 'IDENTITY.md', descriptionKey: 'agentDetail.identityFileDescription' as const },
      { name: 'SOUL.md', descriptionKey: 'agentDetail.soulFileDescription' as const },
      { name: 'USER.md', descriptionKey: 'agentDetail.userFileDescription' as const },
    ],
  },
  {
    id: 'memory',
    labelKey: 'agentDetail.memory' as const,
    icon: Brain,
    color: 'emerald',
    descriptionKey: 'agentDetail.memoryDescription' as const,
    files: [
      { name: 'MEMORY.md', descriptionKey: 'agentDetail.memoryFileDescription' as const },
    ],
  },
  {
    id: 'tools',
    labelKey: 'agentDetail.tools' as const,
    icon: Wrench,
    color: 'amber',
    descriptionKey: 'agentDetail.toolsDescription' as const,
    files: [
      { name: 'TOOLS.md', descriptionKey: 'agentDetail.toolsFileDescription' as const },
    ],
  },
];

function MemoryPanel({ agentId }: MemoryPanelProps) {
  const { t } = useTranslation();
  const { memoryFiles, memoryContent, memoryLoading, listMemoryFiles, readMemoryFile, writeMemoryFile } = useDashboardStore();
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [expandedCategories, setExpandedCategories] = useState<string[]>([]);
  const [editedContent, setEditedContent] = useState('');
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [hasChanges, setHasChanges] = useState(false);
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSavedContentRef = useRef<string>('');

  // Get file info from categories
  const getFileInfo = (fileName: string) => {
    for (const category of FILE_CATEGORIES) {
      const file = category.files.find(f => f.name.toLowerCase() === fileName.toLowerCase());
      if (file) {
        return { ...file, category };
      }
    }
    return null;
  };

  // Check if file exists in memoryFiles
  const fileExists = (fileName: string) => {
    return memoryFiles.some(f => {
      const name = f.path.split('/').pop()?.toLowerCase();
      return name === fileName.toLowerCase();
    });
  };

  // Get file path from memoryFiles
  const getFilePath = (fileName: string) => {
    const file = memoryFiles.find(f => {
      const name = f.path.split('/').pop()?.toLowerCase();
      return name === fileName.toLowerCase();
    });
    return file?.path || fileName;
  };

  // Auto-save function
  const doSave = useCallback(async (content: string) => {
    if (!selectedFile || content === lastSavedContentRef.current) return;

    setSaveStatus('saving');
    try {
      const success = await writeMemoryFile(agentId, selectedFile, content);
      if (success) {
        lastSavedContentRef.current = content;
        setSaveStatus('saved');
        setHasChanges(false);
        setTimeout(() => setSaveStatus('idle'), 2000);
        // Refresh file list to update any new files
        listMemoryFiles(agentId);
      } else {
        setSaveStatus('error');
      }
    } catch (error) {
      console.error('[MemoryPanel] Save error:', error);
      setSaveStatus('error');
    }
  }, [agentId, selectedFile, writeMemoryFile, listMemoryFiles]);

  // Load memory files when component mounts or agentId changes
  useEffect(() => {
    if (agentId) {
      listMemoryFiles(agentId);
    }
  }, [agentId, listMemoryFiles]);

  // Load content when a file is selected
  useEffect(() => {
    if (selectedFile && agentId) {
      readMemoryFile(agentId, selectedFile);
    }
  }, [selectedFile, agentId, readMemoryFile]);

  // Update edited content when memoryContent loads (new file selected)
  useEffect(() => {
    if (selectedFile) {
      setEditedContent(memoryContent);
      lastSavedContentRef.current = memoryContent;
      setHasChanges(false);
      setSaveStatus('idle');
    }
  }, [memoryContent, selectedFile]);

  // Cleanup timeout on unmount
  useEffect(() => {
    return () => {
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
      }
    };
  }, []);

  const handleSelectFile = async (filePath: string) => {
    // Save current file before switching if there are changes
    if (hasChanges && selectedFile) {
      await doSave(editedContent);
    }
    setSelectedFile(filePath);
  };

  const handleCreateFile = async (fileName: string) => {
    // Create file with default template
    const fileInfo = getFileInfo(fileName);
    const defaultContent = `# ${fileName}\n\n${fileInfo?.descriptionKey ? t(fileInfo.descriptionKey) : 'Add your content here...'}\n`;

    setSaveStatus('saving');
    try {
      const success = await writeMemoryFile(agentId, fileName, defaultContent);
      if (success) {
        await listMemoryFiles(agentId);
        setSelectedFile(fileName);
        setSaveStatus('saved');
        setTimeout(() => setSaveStatus('idle'), 2000);
      } else {
        setSaveStatus('error');
      }
    } catch (error) {
      console.error('[MemoryPanel] Create file error:', error);
      setSaveStatus('error');
    }
  };

  const handleContentChange = (newContent: string) => {
    setEditedContent(newContent);
    setHasChanges(newContent !== lastSavedContentRef.current);

    // Clear existing timeout
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
    }

    // Set new timeout for auto-save (1 second debounce)
    saveTimeoutRef.current = setTimeout(() => {
      doSave(newContent);
    }, 1000);
  };

  const toggleCategory = (categoryId: string) => {
    setExpandedCategories(prev =>
      prev.includes(categoryId)
        ? prev.filter(id => id !== categoryId)
        : [...prev, categoryId]
    );
  };

  const selectedFileInfo = selectedFile ? getFileInfo(selectedFile.split('/').pop() || selectedFile) : null;
  const selectedFileCategoryDesc = selectedFileInfo?.category?.descriptionKey;
  const selectedFileDescription = selectedFileInfo?.descriptionKey ?? selectedFileCategoryDesc ?? ('agentDetail.workspaceFile' as const);

  return (
    <div className="h-full flex animate-in fade-in duration-300">
      {/* Files Sidebar - Organized by Category */}
      <div className="w-80 border-r border-border bg-muted/50 flex flex-col">
        <div className="p-4 border-b border-border">
          <div className="flex items-center justify-between mb-1">
            <div className="flex items-center gap-2">
              <Brain className="w-4 h-4 text-violet-600 dark:text-violet-400" />
              <h3 className="text-xs font-bold text-foreground uppercase tracking-wider">
                {t('agentDetail.memory')}
              </h3>
            </div>
            <button
              onClick={() => listMemoryFiles(agentId)}
              className="p-1 hover:bg-muted rounded transition-colors"
              title={t('agentDetail.refresh')}
            >
              <RefreshCw className={cn("w-3.5 h-3.5 text-muted-foreground", memoryLoading && "animate-spin")} />
            </button>
          </div>
          <p className="text-[10px] text-muted-foreground">{t('agentDetail.memoryDescription')}</p>
        </div>

        <div className="flex-1 overflow-y-auto p-2 space-y-2">
          {memoryLoading && memoryFiles.length === 0 ? (
            <div className="flex items-center justify-center py-8">
              <RefreshCw className="w-5 h-5 text-muted-foreground animate-spin" />
            </div>
          ) : (
            FILE_CATEGORIES.map((category) => {
              const CategoryIcon = category.icon;
              const isExpanded = expandedCategories.includes(category.id);

              return (
                <div key={category.id} className="space-y-1">
                  {/* Category Header */}
                  <button
                    onClick={() => toggleCategory(category.id)}
                    className={cn(
                      "w-full flex items-center gap-2 px-3 py-2 rounded-lg transition-all",
                      "hover:bg-muted text-left"
                    )}
                  >
                    <CategoryIcon className={cn("w-4 h-4", `text-${category.color}-400`)} />
                    <span className="text-xs font-semibold text-foreground/80 flex-1">
                      {t(category.labelKey)}
                    </span>
                    <span className={cn(
                      "text-[10px] text-muted-foreground transition-transform",
                      isExpanded ? "rotate-90" : ""
                    )}>
                      ▶
                    </span>
                  </button>

                  {/* Category Files */}
                  {isExpanded && (
                    <div className="ml-2 space-y-1 animate-in slide-in-from-top-1 duration-150">
                      {category.files.map((file) => {
                        const exists = fileExists(file.name);
                        const filePath = getFilePath(file.name);
                        const isSelected = selectedFile === filePath || selectedFile === file.name;

                        return (
                          <button
                            key={file.name}
                            onClick={() => exists ? handleSelectFile(filePath) : handleCreateFile(file.name)}
                            className={cn(
                              "w-full text-left px-3 py-2.5 rounded-lg transition-all duration-200 group",
                              isSelected
                                ? `bg-${category.color}-500/20 border border-${category.color}-500/30`
                                : "hover:bg-muted border border-transparent hover:border-border"
                            )}
                          >
                            <div className="flex items-center gap-2">
                              <FileText className={cn(
                                "w-3.5 h-3.5",
                                isSelected ? `text-${category.color}-400` : exists ? "text-muted-foreground" : "text-muted-foreground"
                              )} />
                              <span className={cn(
                                "text-xs font-medium",
                                isSelected ? "text-foreground" : exists ? "text-foreground/80" : "text-muted-foreground"
                              )}>
                                {file.name}
                              </span>
                              {exists ? (
                                <span className="ml-auto w-1.5 h-1.5 rounded-full bg-emerald-400" />
                              ) : (
                                <Plus className="ml-auto w-3 h-3 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
                              )}
                            </div>
                            <p className={cn(
                              "text-[10px] mt-0.5 pl-5",
                              isSelected ? "text-muted-foreground" : "text-muted-foreground"
                            )}>
                              {t(file.descriptionKey)}
                            </p>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })
          )}

        </div>

        {/* Info */}
        <div className="p-3 border-t border-border">
          <p className="text-[10px] text-muted-foreground leading-relaxed">
            {t('agentDetail.fileEditingHint')}
          </p>
        </div>
      </div>

      {/* Content Area */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {selectedFile ? (
          <>
            {/* Header */}
            <div className="px-6 py-4 border-b border-border flex items-center justify-between shrink-0">
              <div className="flex items-center gap-3">
                <div className={cn(
                  "w-10 h-10 rounded-xl border flex items-center justify-center",
                  selectedFileInfo?.category
                    ? `bg-${selectedFileInfo.category.color}-500/10 border-${selectedFileInfo.category.color}-500/20`
                    : "bg-muted border-border"
                )}>
                  {selectedFileInfo?.category ? (
                    <selectedFileInfo.category.icon className={cn("w-5 h-5", `text-${selectedFileInfo.category.color}-400`)} />
                  ) : (
                    <FileText className="w-5 h-5 text-muted-foreground" />
                  )}
                </div>
                <div>
                  <h3 className="text-sm font-semibold text-foreground">
                    {selectedFile.split('/').pop() || selectedFile}
                  </h3>
                  <p className="text-[10px] text-muted-foreground">
                    {t(selectedFileDescription)}
                  </p>
                </div>
              </div>
              {/* Save status indicator */}
              <div className="flex items-center gap-2">
                {saveStatus === 'saving' && (
                  <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-muted">
                    <RefreshCw className="w-3.5 h-3.5 text-muted-foreground animate-spin" />
                    <span className="text-xs text-muted-foreground">{t('agentDetail.saving')}</span>
                  </div>
                )}
                {saveStatus === 'saved' && (
                  <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-500/10 border border-emerald-500/20">
                    <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" />
                    <span className="text-xs text-emerald-600 dark:text-emerald-400">{t('agentDetail.saved')}</span>
                  </div>
                )}
                {saveStatus === 'error' && (
                  <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-red-500/10 border border-red-500/20">
                    <AlertTriangle className="w-3.5 h-3.5 text-red-600 dark:text-red-400" />
                    <span className="text-xs text-red-600 dark:text-red-400">{t('common.error')}</span>
                  </div>
                )}
                {saveStatus === 'idle' && hasChanges && (
                  <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-amber-500/10 border border-amber-500/20">
                    <Edit3 className="w-3.5 h-3.5 text-amber-600 dark:text-amber-400" />
                    <span className="text-xs text-amber-600 dark:text-amber-400">{t('agentDetail.editing')}</span>
                  </div>
                )}
              </div>
            </div>

            {/* Content - Always editable textarea */}
            <div className="flex-1 overflow-hidden p-6">
              {memoryLoading ? (
                <div className="flex items-center justify-center h-full">
                  <RefreshCw className="w-6 h-6 text-muted-foreground animate-spin" />
                </div>
              ) : (
                <textarea
                  value={editedContent}
                  onChange={(e) => handleContentChange(e.target.value)}
                  className="w-full h-full p-4 bg-muted border border-border rounded-xl text-sm text-foreground font-mono focus:outline-none focus:border-violet-500/50 focus:ring-1 focus:ring-violet-500/20 resize-none transition-all"
                  placeholder={t('agentDetail.fileContentPlaceholder')}
                  spellCheck={false}
                />
              )}
            </div>
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center">
            <div className="text-center max-w-sm">
              <Database className="w-12 h-12 text-muted-foreground/30 mx-auto mb-3" />
              <p className="text-sm text-muted-foreground mb-2">{t('agentDetail.selectFileToEdit')}</p>
              <p className="text-xs text-muted-foreground">
                {t('agentDetail.workspaceExplanation')}
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// Skills Panel Component - Unified view of built-in + ClawHub skills
interface SkillsPanelProps {
  agent: AgentSummary;
}

// Built-in OpenClaw skills catalog — toolGroup maps to tools.deny entries
const BUILTIN_SKILLS = [
  { id: 'read', name: 'File Read', category: 'Core', description: 'Read file contents from the filesystem', icon: '📄', toolGroup: 'group:fs' },
  { id: 'write', name: 'File Write', category: 'Core', description: 'Write and create files', icon: '✏️', toolGroup: 'group:fs' },
  { id: 'edit', name: 'File Edit', category: 'Core', description: 'Edit files with structured patches', icon: '🔧', toolGroup: 'group:fs' },
  { id: 'exec', name: 'Shell', category: 'Core', description: 'Execute shell commands', icon: '⚡', toolGroup: 'group:runtime' },
  { id: 'process', name: 'Processes', category: 'Core', description: 'Manage background shell sessions', icon: '📟', toolGroup: 'group:runtime' },
  { id: 'sessions_spawn', name: 'Spawn Agent', category: 'Core', description: 'Launch sub-agents for parallel tasks', icon: '🤖', toolGroup: 'group:sessions' },
  { id: 'memory', name: 'Memory', category: 'Core', description: 'Persistent memory across sessions', icon: '🧠', toolGroup: 'group:memory' },
  { id: 'web_search', name: 'Web Search', category: 'Web', description: 'Search the web (requires API key)', icon: '🔍', toolGroup: 'group:web' },
  { id: 'web_fetch', name: 'Web Fetch', category: 'Web', description: 'Fetch and read web page contents', icon: '🌐', toolGroup: 'group:web' },
  { id: 'browser', name: 'Browser', category: 'Web', description: 'Control a headless browser', icon: '🖥️', toolGroup: 'group:ui' },
  { id: 'cron', name: 'Cron Jobs', category: 'Automation', description: 'Schedule recurring tasks', icon: '⏰', toolGroup: 'group:automation' },
  { id: 'lobster', name: 'Workflows', category: 'Automation', description: 'Deterministic pipelines with approvals', icon: '🦞', toolGroup: 'lobster' },
  { id: 'whatsapp', name: 'WhatsApp', category: 'Communication', description: 'Send and receive WhatsApp messages', icon: '💬', toolGroup: 'group:messaging' },
  { id: 'telegram', name: 'Telegram', category: 'Communication', description: 'Telegram bot integration', icon: '📨', toolGroup: 'group:messaging' },
  { id: 'discord', name: 'Discord', category: 'Communication', description: 'Discord bot integration', icon: '🎮', toolGroup: 'group:messaging' },
  { id: 'slack', name: 'Slack', category: 'Communication', description: 'Slack workspace integration', icon: '💼', toolGroup: 'group:messaging' },
  { id: 'email', name: 'Email', category: 'Communication', description: 'Read and send emails', icon: '📧', toolGroup: 'group:messaging' },
  { id: 'nodes', name: 'Devices', category: 'Nodes', description: 'Connected companion devices', icon: '📱', toolGroup: 'group:nodes' },
  { id: 'image', name: 'Image Analysis', category: 'Media', description: 'Analyze images with AI vision', icon: '🖼️', toolGroup: 'group:web' },
  { id: 'tts', name: 'Text-to-Speech', category: 'Media', description: 'Convert text to spoken audio', icon: '🎤', toolGroup: 'group:web' },
];

const BUILTIN_CATEGORIES = ['Core', 'Web', 'Automation', 'Communication', 'Nodes', 'Media'];

// ─── Per-Agent Tools Panel ──────────────────────────────────────────────

const AGENT_TOOL_GROUPS = [
  { id: 'group:fs', nameKey: 'settings.toolsConfig.groups.files', icon: '📁', descKey: 'settings.toolsConfig.groups.filesDesc' },
  { id: 'group:runtime', nameKey: 'settings.toolsConfig.groups.shell', icon: '💻', descKey: 'settings.toolsConfig.groups.shellDesc' },
  { id: 'group:web', nameKey: 'settings.toolsConfig.groups.web', icon: '🌐', descKey: 'settings.toolsConfig.groups.webDesc' },
  { id: 'group:ui', nameKey: 'settings.toolsConfig.groups.browser', icon: '🖥️', descKey: 'settings.toolsConfig.groups.browserDesc' },
  { id: 'group:sessions', nameKey: 'settings.toolsConfig.groups.sessions', icon: '🔗', descKey: 'settings.toolsConfig.groups.sessionsDesc' },
  { id: 'group:memory', nameKey: 'settings.toolsConfig.groups.memory', icon: '🧠', descKey: 'settings.toolsConfig.groups.memoryDesc' },
  { id: 'group:automation', nameKey: 'settings.toolsConfig.groups.automation', icon: '⏰', descKey: 'settings.toolsConfig.groups.automationDesc' },
  { id: 'group:messaging', nameKey: 'settings.toolsConfig.groups.messaging', icon: '💬', descKey: 'settings.toolsConfig.groups.messagingDesc' },
  { id: 'group:nodes', nameKey: 'settings.toolsConfig.groups.devices', icon: '📱', descKey: 'settings.toolsConfig.groups.devicesDesc' },
];

function AgentToolsPanel({ agentId }: { agentId: string }) {
  const { t } = useTranslation();
  const { gatewayConfig, patchGatewayConfig } = useDashboardStore();
  const [saving, setSaving] = useState(false);

  const config = gatewayConfig?.config as Record<string, unknown> | undefined;

  // Global tools config
  const globalTools = (config?.tools || {}) as Record<string, unknown>;
  const globalDeny = (globalTools.deny || []) as string[];
  const globalAlsoAllow = (globalTools.alsoAllow || []) as string[];

  // Per-agent config: agents.list[].tools
  const agentsCfg = config?.agents as { list?: Array<Record<string, unknown>> } | undefined;
  const agentEntry = agentsCfg?.list?.find((a: Record<string, unknown>) => a.id === agentId);
  const agentTools = (agentEntry?.tools || null) as Record<string, unknown> | null;
  const agentDeny = agentTools ? (agentTools.deny || []) as string[] : null;
  const agentAlsoAllow = agentTools ? (agentTools.alsoAllow || []) as string[] : null;

  // Effective values: agent override if set, otherwise global
  const effectiveDeny = agentDeny ?? globalDeny;
  const effectiveAlsoAllow = agentAlsoAllow ?? globalAlsoAllow;

  const isGroupEnabled = (groupId: string) => !effectiveDeny.includes(groupId);
  const lobsterEnabled = effectiveAlsoAllow.includes('lobster');

  const patchAgentTools = async (toolsPatch: Record<string, unknown>) => {
    setSaving(true);
    // If agent has no overrides yet, initialize from global before applying change
    const currentAgentTools = agentTools || { deny: [...globalDeny], alsoAllow: [...globalAlsoAllow] };
    const newTools = { ...currentAgentTools, ...toolsPatch };

    const currentList = (agentsCfg?.list || []) as Array<Record<string, unknown>>;
    const exists = currentList.some(a => a.id === agentId);
    const updatedList = exists
      ? currentList.map(a => a.id === agentId ? { ...a, tools: newTools } : a)
      : [...currentList, { id: agentId, tools: newTools }];
    await patchGatewayConfig({ agents: { ...config?.agents as object, list: updatedList } });
    setSaving(false);
  };

  const toggleGroup = (groupId: string) => {
    const deny = agentDeny ?? [...globalDeny];
    const newDeny = isGroupEnabled(groupId) ? [...deny, groupId] : deny.filter(d => d !== groupId);
    patchAgentTools({ deny: newDeny });
  };

  const toggleLobster = () => {
    const allow = agentAlsoAllow ?? [...globalAlsoAllow];
    const newAllow = lobsterEnabled ? allow.filter(a => a !== 'lobster') : [...allow, 'lobster'];
    patchAgentTools({ alsoAllow: newAllow });
  };

  return (
    <div className="h-full overflow-y-auto p-6 animate-in fade-in duration-300">
      <div className="max-w-4xl mx-auto space-y-4">
        <div className="flex items-center justify-between">
          <p className="text-sm text-muted-foreground">{t('agentDetail.toolsDescription')}</p>
          {saving && <RefreshCw className="w-4 h-4 text-muted-foreground animate-spin" />}
        </div>

        <div className="space-y-2">
          {AGENT_TOOL_GROUPS.map((group) => {
            const enabled = isGroupEnabled(group.id);
            return (
              <div key={group.id} className="flex items-center justify-between p-4 rounded-xl bg-card border">
                <div className="flex items-center gap-3">
                  <span className="text-xl">{group.icon}</span>
                  <div>
                    <h3 className="font-semibold text-foreground">{t(group.nameKey as any)}</h3>
                    <p className="text-xs text-muted-foreground">{t(group.descKey as any)}</p>
                  </div>
                </div>
                <button onClick={() => toggleGroup(group.id)} className={cn("w-12 h-6 rounded-full transition-colors relative cursor-pointer", enabled ? "bg-emerald-500/30" : "bg-muted")}>
                  <span className={cn("absolute top-1 w-4 h-4 rounded-full transition-all", enabled ? "right-1 bg-emerald-400" : "left-1 bg-muted-foreground")} />
                </button>
              </div>
            );
          })}

          {/* Lobster */}
          <div className="flex items-center justify-between p-4 rounded-xl bg-card border">
            <div className="flex items-center gap-3">
              <span className="text-xl">🦞</span>
              <div>
                <h3 className="font-semibold text-foreground">{t('settings.toolsConfig.lobsterName')}</h3>
                <p className="text-xs text-muted-foreground">{t('settings.toolsConfig.lobsterDesc')}</p>
              </div>
            </div>
            <button onClick={toggleLobster} className={cn("w-12 h-6 rounded-full transition-colors relative cursor-pointer", lobsterEnabled ? "bg-emerald-500/30" : "bg-muted")}>
              <span className={cn("absolute top-1 w-4 h-4 rounded-full transition-all", lobsterEnabled ? "right-1 bg-emerald-400" : "left-1 bg-muted-foreground")} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ClawHub marketplace types
interface ClawHubSearchResult {
  score: number;
  slug: string;
  displayName: string;
  summary: string;
  version: string | null;
  updatedAt: number;
}

interface ClawHubSkillDetail {
  skill: {
    slug: string;
    displayName: string;
    summary: string;
    stats: { comments: number; downloads: number; installsAllTime: number; installsCurrent: number; stars: number; versions: number };
    createdAt: number;
    updatedAt: number;
  };
  latestVersion: { version: string; createdAt: number; changelog: string };
  owner: { handle: string; displayName: string; image: string };
}

function SkillsPanel({ agent }: SkillsPanelProps) {
  const { t } = useTranslation();
  const { token, gatewayConfig, patchGatewayConfig } = useDashboardStore();
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<ClawHubSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [installed, setInstalled] = useState<Array<{ slug: string; name: string; description: string; installedAt: number }>>([]);
  const [loadingInstalled, setLoadingInstalled] = useState(true);
  const [installing, setInstalling] = useState<string | null>(null);
  const [uninstalling, setUninstalling] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ClawHubSkillDetail | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [categoryFilter, setCategoryFilter] = useState<string | null>(null);
  const [togglingSkill, setTogglingSkill] = useState(false);
  const searchTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const authHeaders = useMemo(() => {
    const h: Record<string, string> = {};
    if (token) h['Authorization'] = `Bearer ${token}`;
    return h;
  }, [token]);

  // ─── Per-agent tool deny/alsoAllow (same logic as AgentToolsPanel) ────
  const config = gatewayConfig?.config as Record<string, unknown> | undefined;
  const globalTools = (config?.tools || {}) as Record<string, unknown>;
  const globalDeny = (globalTools.deny || []) as string[];
  const globalAlsoAllow = (globalTools.alsoAllow || []) as string[];
  const agentsCfg = config?.agents as { list?: Array<Record<string, unknown>> } | undefined;
  const agentEntry = agentsCfg?.list?.find((a: Record<string, unknown>) => a.id === agent.id);
  const agentTools = (agentEntry?.tools || null) as Record<string, unknown> | null;
  const agentDeny = agentTools ? (agentTools.deny || []) as string[] : null;
  const agentAlsoAllow = agentTools ? (agentTools.alsoAllow || []) as string[] : null;
  const effectiveDeny = agentDeny ?? globalDeny;
  const effectiveAlsoAllow = agentAlsoAllow ?? globalAlsoAllow;

  const isSkillEnabled = (skill: typeof BUILTIN_SKILLS[0]) => {
    if (skill.toolGroup === 'lobster') return effectiveAlsoAllow.includes('lobster');
    return !effectiveDeny.includes(skill.toolGroup);
  };

  const toggleSkill = async (skill: typeof BUILTIN_SKILLS[0]) => {
    setTogglingSkill(true);
    const currentAgentTools = agentTools || { deny: [...globalDeny], alsoAllow: [...globalAlsoAllow] };

    if (skill.toolGroup === 'lobster') {
      const allow = (currentAgentTools.alsoAllow || []) as string[];
      const newAllow = effectiveAlsoAllow.includes('lobster')
        ? allow.filter((a: string) => a !== 'lobster')
        : [...allow, 'lobster'];
      await patchAgentToolsConfig({ ...currentAgentTools, alsoAllow: newAllow });
    } else {
      const deny = (currentAgentTools.deny || []) as string[];
      const enabled = !effectiveDeny.includes(skill.toolGroup);
      const newDeny = enabled ? [...deny, skill.toolGroup] : deny.filter((d: string) => d !== skill.toolGroup);
      // Deduplicate
      await patchAgentToolsConfig({ ...currentAgentTools, deny: [...new Set(newDeny)] });
    }
    setTogglingSkill(false);
  };

  const patchAgentToolsConfig = async (newTools: Record<string, unknown>) => {
    const currentList = (agentsCfg?.list || []) as Array<Record<string, unknown>>;
    const exists = currentList.some(a => a.id === agent.id);
    const updatedList = exists
      ? currentList.map(a => a.id === agent.id ? { ...a, tools: newTools } : a)
      : [...currentList, { id: agent.id, tools: newTools }];
    await patchGatewayConfig({ agents: { ...config?.agents as object, list: updatedList } });
  };

  const loadInstalled = useCallback(async () => {
    try {
      const res = await fetch('/api/skills/list', { headers: authHeaders });
      if (res.ok) {
        const data = await res.json();
        setInstalled(data.skills || []);
      }
    } catch { /* ignore */ }
    setLoadingInstalled(false);
  }, [authHeaders]);

  useEffect(() => { loadInstalled(); }, [loadInstalled]);

  // Load ClawHub detail for installed skills
  useEffect(() => {
    if (!selectedId || selectedId.startsWith('builtin:')) { setDetail(null); return; }
    let cancelled = false;
    setLoadingDetail(true);
    fetch(`/api/clawhub/skill?slug=${encodeURIComponent(selectedId)}`, { headers: authHeaders })
      .then(r => r.ok ? r.json() : null)
      .then(data => { if (!cancelled) setDetail(data); })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoadingDetail(false); });
    return () => { cancelled = true; };
  }, [selectedId, authHeaders]);

  const handleSearch = (query: string) => {
    setSearchQuery(query);
    setCategoryFilter(null);
    setSelectedId(null);
    if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current);
    if (!query.trim()) { setSearchResults([]); return; }
    searchTimeoutRef.current = setTimeout(async () => {
      setSearching(true);
      try {
        const res = await fetch(`/api/clawhub/search?q=${encodeURIComponent(query)}&limit=20`, { headers: authHeaders });
        if (res.ok) {
          const data = await res.json();
          setSearchResults(data.results || (Array.isArray(data) ? data : []));
        }
      } catch { /* ignore */ }
      setSearching(false);
    }, 400);
  };

  const handleInstall = async (slug: string) => {
    setInstalling(slug);
    try {
      await fetch('/api/clawhub/install', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders },
        body: JSON.stringify({ slug }),
      });
    } catch { /* ignore */ }
    await loadInstalled();
    setInstalling(null);
  };

  const handleUninstall = async (slug: string) => {
    setUninstalling(slug);
    try {
      await fetch(`/api/skills/${encodeURIComponent(slug)}`, { method: 'DELETE', headers: authHeaders });
    } catch { /* ignore */ }
    await loadInstalled();
    setUninstalling(null);
  };

  const installedSlugs = new Set(installed.map(s => s.slug));

  // Filter built-in by category
  const filteredBuiltin = categoryFilter
    ? BUILTIN_SKILLS.filter(s => s.category === categoryFilter)
    : BUILTIN_SKILLS;

  // Selected built-in skill
  const selectedBuiltin = selectedId?.startsWith('builtin:')
    ? BUILTIN_SKILLS.find(s => s.id === selectedId.replace('builtin:', ''))
    : null;

  // Selected installed skill
  const selectedInstalled = selectedId && !selectedId.startsWith('builtin:')
    ? installed.find(s => s.slug === selectedId)
    : null;

  return (
    <div className="h-full flex animate-in fade-in duration-300">
      {/* Left: Skills list */}
      <div className="flex-1 flex flex-col border-r border-border overflow-hidden">
        <div className="p-4 border-b border-border space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Sparkles className="w-4 h-4 text-violet-600 dark:text-violet-400" />
              <h3 className="text-xs font-bold text-foreground uppercase tracking-wider">{t('agentDetail.skillsTitle')}</h3>
            </div>
            <span className="text-[10px] px-2 py-1 rounded-full bg-violet-500/10 border border-violet-500/20 text-violet-600 dark:text-violet-300 font-semibold">
              {BUILTIN_SKILLS.length} {t('agentDetail.skillsBuiltinCount')} · {installed.length} {t('agentDetail.skillsAddedCount')}
            </span>
          </div>
          <div className="relative">
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => handleSearch(e.target.value)}
              placeholder={t('agentDetail.skillsSearchPlaceholder')}
              className={cn("w-full px-3 py-2 pl-9 text-sm bg-background border border-border rounded-lg text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-violet-500/50", searchQuery && "pr-9")}
            />
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground">🔍</span>
            {searching && <RefreshCw className="absolute right-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground animate-spin" />}
            {searchQuery && !searching && (
              <button
                onClick={() => handleSearch('')}
                className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded-md hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
              >
                <XIcon className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
          {/* Category filter + back button when searching */}
          <div className="flex flex-wrap gap-1.5">
            {searchQuery ? (
              <>
                <button
                  onClick={() => handleSearch('')}
                  className="px-2 py-1 text-[10px] font-medium rounded-lg border transition-colors bg-violet-500/15 text-violet-700 dark:text-violet-300 border-violet-500/30"
                >
                  {t('agentDetail.skillsBackToInstalled')}
                </button>
                {['agent', 'automation', 'email', 'git', 'calendar', 'deploy'].map(q => (
                  <button
                    key={q}
                    onClick={() => handleSearch(q)}
                    className={cn(
                      "px-2 py-1 text-[10px] font-medium rounded-lg border transition-colors",
                      searchQuery === q ? "bg-teal-500/15 text-teal-700 dark:text-teal-300 border-teal-500/30" : "bg-muted text-muted-foreground border-transparent hover:border-border hover:text-foreground"
                    )}
                  >
                    {q}
                  </button>
                ))}
              </>
            ) : (
              <>
                <button
                  onClick={() => setCategoryFilter(null)}
                  className={cn(
                    "px-2 py-1 text-[10px] font-medium rounded-lg border transition-colors",
                    !categoryFilter ? "bg-violet-500/15 text-violet-700 dark:text-violet-300 border-violet-500/30" : "bg-muted text-muted-foreground border-transparent hover:border-border hover:text-foreground"
                  )}
                >
                  All
                </button>
                {BUILTIN_CATEGORIES.map(cat => (
                  <button
                    key={cat}
                    onClick={() => setCategoryFilter(categoryFilter === cat ? null : cat)}
                    className={cn(
                      "px-2 py-1 text-[10px] font-medium rounded-lg border transition-colors",
                      categoryFilter === cat ? "bg-violet-500/15 text-violet-700 dark:text-violet-300 border-violet-500/30" : "bg-muted text-muted-foreground border-transparent hover:border-border hover:text-foreground"
                    )}
                  >
                    {cat}
                  </button>
                ))}
              </>
            )}
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-3 space-y-1.5">
          {/* Default view: built-in + installed */}
          {!searchQuery && (
            <>
              {/* Built-in skills */}
              {filteredBuiltin.map(skill => {
                const enabled = isSkillEnabled(skill);
                return (
                  <button
                    key={skill.id}
                    onClick={() => setSelectedId(`builtin:${skill.id}`)}
                    className={cn(
                      "w-full p-2.5 rounded-lg border transition-all text-left",
                      selectedId === `builtin:${skill.id}`
                        ? "bg-violet-500/10 border-violet-500/30"
                        : "bg-card border-border hover:border-violet-500/20",
                      !enabled && "opacity-50"
                    )}
                  >
                    <div className="flex items-center gap-2.5">
                      <span className={cn("text-base shrink-0", !enabled && "grayscale")}>{skill.icon}</span>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className={cn("text-xs font-semibold truncate", enabled ? "text-foreground" : "text-muted-foreground line-through")}>{skill.name}</span>
                          <span className="text-[9px] px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-600 dark:text-blue-400 border border-blue-500/20 shrink-0">{t('agentDetail.skillsBuiltinTag')}</span>
                          {!enabled && <span className="text-[9px] px-1.5 py-0.5 rounded bg-red-500/10 text-red-600 dark:text-red-400 border border-red-500/20 shrink-0">{t('agentDetail.skillsDisabledTag')}</span>}
                        </div>
                        <span className="text-[10px] text-muted-foreground truncate block">{skill.description}</span>
                      </div>
                    </div>
                  </button>
                );
              })}

              {/* Installed ClawHub skills */}
              {!categoryFilter && installed.length > 0 && (
                <>
                  <div className="pt-3 pb-1 px-1">
                    <span className="text-[9px] font-bold text-muted-foreground uppercase tracking-wider">{t('agentDetail.skillsClawHubInstalled')}</span>
                  </div>
                  {installed.map(skill => (
                    <button
                      key={skill.slug}
                      onClick={() => setSelectedId(skill.slug)}
                      className={cn(
                        "w-full p-2.5 rounded-lg border transition-all text-left",
                        selectedId === skill.slug
                          ? "bg-violet-500/10 border-violet-500/30"
                          : "bg-card border-border hover:border-violet-500/20"
                      )}
                    >
                      <div className="flex items-center gap-2.5">
                        <Package className="w-4 h-4 text-teal-500 shrink-0" />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="text-xs font-semibold text-foreground truncate">{skill.name}</span>
                            <span className="text-[9px] px-1.5 py-0.5 rounded bg-teal-500/10 text-teal-600 dark:text-teal-400 border border-teal-500/20 shrink-0">{t('agentDetail.skillsClawHubTag')}</span>
                          </div>
                          <span className="text-[10px] text-muted-foreground truncate block">{skill.description || skill.slug}</span>
                        </div>
                      </div>
                    </button>
                  ))}
                </>
              )}

              {loadingInstalled && (
                <div className="flex items-center gap-2 text-xs text-muted-foreground p-3 justify-center">
                  <RefreshCw className="w-3.5 h-3.5 animate-spin" /> {t('agentDetail.skillsLoadingInstalled')}
                </div>
              )}
            </>
          )}

          {/* Search results */}
          {searchQuery && searchResults.length > 0 && searchResults.map(result => {
            const isInstalled = installedSlugs.has(result.slug);
            return (
              <button
                key={result.slug}
                onClick={() => setSelectedId(result.slug)}
                className={cn(
                  "w-full p-2.5 rounded-lg border transition-all text-left",
                  selectedId === result.slug
                    ? "bg-violet-500/10 border-violet-500/30"
                    : "bg-card border-border hover:border-violet-500/20"
                )}
              >
                <div className="flex items-center gap-2.5">
                  <Package className="w-4 h-4 text-muted-foreground shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-semibold text-foreground truncate">{result.displayName || result.slug}</span>
                      {isInstalled && (
                        <span className="text-[9px] px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20 shrink-0">{t('agentDetail.skillsInstalledTag')}</span>
                      )}
                    </div>
                    <span className="text-[10px] text-muted-foreground truncate block">{result.summary}</span>
                  </div>
                </div>
              </button>
            );
          })}

          {searchQuery && !searching && searchResults.length === 0 && (
            <div className="text-center py-8">
              <p className="text-sm text-muted-foreground">{t('agentDetail.skillsNoResults')} &ldquo;{searchQuery}&rdquo;</p>
            </div>
          )}
        </div>
      </div>

      {/* Right: Detail panel */}
      <div className="w-96 flex flex-col overflow-hidden bg-card">
        {selectedBuiltin ? (
          /* Built-in skill detail with enable/disable toggle */
          <div className="p-5">
            <div className="flex items-start justify-between mb-4">
              <div className="flex items-center gap-3">
                <span className="text-3xl">{selectedBuiltin.icon}</span>
                <div>
                  <h3 className="text-base font-bold text-foreground">{selectedBuiltin.name}</h3>
                  <div className="flex items-center gap-2 mt-0.5">
                    <span className="text-[9px] px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-600 dark:text-blue-400 border border-blue-500/20">{t('agentDetail.skillsBuiltinTag')}</span>
                    <span className="text-[9px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground border border-border">{selectedBuiltin.category}</span>
                  </div>
                </div>
              </div>
              <button onClick={() => setSelectedId(null)} className="p-1.5 hover:bg-muted rounded-lg transition-colors text-muted-foreground hover:text-foreground">
                <XIcon className="w-4 h-4" />
              </button>
            </div>
            <p className="text-sm text-muted-foreground mb-4">{selectedBuiltin.description}</p>

            {/* Enable/Disable toggle for this agent */}
            <div className="flex items-center justify-between p-4 rounded-xl bg-card border mb-4">
              <div>
                <p className="text-sm font-semibold text-foreground">
                  {isSkillEnabled(selectedBuiltin) ? t('agentDetail.skillsEnabledForAgent') : t('agentDetail.skillsDisabledForAgent')}
                </p>
                <p className="text-[10px] text-muted-foreground mt-0.5">
                  {t('agentDetail.skillsControls')} <span className="font-mono text-[9px] bg-muted px-1 py-0.5 rounded">{selectedBuiltin.toolGroup}</span>
                  {BUILTIN_SKILLS.filter(s => s.toolGroup === selectedBuiltin.toolGroup).length > 1 && (
                    <> — {t('agentDetail.skillsAlsoAffects')} {BUILTIN_SKILLS.filter(s => s.toolGroup === selectedBuiltin.toolGroup && s.id !== selectedBuiltin.id).map(s => s.name).join(', ')}</>
                  )}
                </p>
              </div>
              <button
                onClick={() => toggleSkill(selectedBuiltin)}
                disabled={togglingSkill}
                className={cn(
                  "w-12 h-6 rounded-full transition-colors relative cursor-pointer shrink-0",
                  isSkillEnabled(selectedBuiltin) ? "bg-emerald-500/30" : "bg-muted"
                )}
              >
                <span className={cn(
                  "absolute top-1 w-4 h-4 rounded-full transition-all",
                  isSkillEnabled(selectedBuiltin) ? "right-1 bg-emerald-400" : "left-1 bg-muted-foreground"
                )} />
              </button>
            </div>

            <div className="p-3 bg-blue-500/5 border border-blue-500/20 rounded-xl">
              <p className="text-[11px] text-blue-700 dark:text-blue-300">
                <CheckCircle2 className="w-4 h-4 inline mr-1.5" />
                {t('agentDetail.skillsBuiltinInfo')}
              </p>
            </div>
          </div>
        ) : selectedId ? (
          loadingDetail ? (
            <div className="flex-1 flex items-center justify-center">
              <RefreshCw className="w-5 h-5 text-muted-foreground animate-spin" />
            </div>
          ) : detail ? (
            <>
              <div className="p-5 border-b border-border">
                <div className="flex items-start justify-between mb-3">
                  <div className="flex items-center gap-3">
                    {detail.owner?.image && <img src={detail.owner.image} alt="" className="w-8 h-8 rounded-full" />}
                    <div>
                      <h3 className="text-base font-bold text-foreground">{detail.skill.displayName}</h3>
                      <span className="text-[10px] text-muted-foreground">
                        {detail.owner && <>by <span className="font-medium text-foreground">{detail.owner.displayName || detail.owner.handle}</span> · </>}
                        {detail.latestVersion && <>v{detail.latestVersion.version}</>}
                      </span>
                    </div>
                  </div>
                  <button onClick={() => setSelectedId(null)} className="p-1.5 hover:bg-muted rounded-lg transition-colors text-muted-foreground hover:text-foreground">
                    <XIcon className="w-4 h-4" />
                  </button>
                </div>

                <p className="text-sm text-muted-foreground mb-4">{detail.skill.summary}</p>

                <div className="grid grid-cols-3 gap-2 mb-4">
                  <div className="text-center p-2 bg-background rounded-lg border border-border">
                    <div className="text-sm font-bold text-foreground">{(detail.skill.stats?.downloads || 0).toLocaleString()}</div>
                    <div className="text-[9px] text-muted-foreground">Downloads</div>
                  </div>
                  <div className="text-center p-2 bg-background rounded-lg border border-border">
                    <div className="text-sm font-bold text-foreground">{detail.skill.stats?.stars || 0}</div>
                    <div className="text-[9px] text-muted-foreground">Stars</div>
                  </div>
                  <div className="text-center p-2 bg-background rounded-lg border border-border">
                    <div className="text-sm font-bold text-foreground">{new Date(detail.skill.updatedAt).toLocaleDateString()}</div>
                    <div className="text-[9px] text-muted-foreground">Updated</div>
                  </div>
                </div>

                <div className="p-3 bg-amber-500/10 border border-amber-500/30 rounded-xl mb-4">
                  <div className="flex items-start gap-2">
                    <AlertTriangle className="w-4 h-4 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
                    <div>
                      <p className="text-[11px] font-semibold text-amber-700 dark:text-amber-300 mb-1">{t('agentDetail.skillsReviewBefore')}</p>
                      <a href={`https://clawhub.ai/${detail.skill.slug}`} target="_blank" rel="noopener noreferrer"
                        className="inline-flex items-center gap-1.5 text-[10px] font-semibold text-amber-700 dark:text-amber-300 hover:underline">
                        <ExternalLink className="w-3 h-3" /> {t('agentDetail.skillsViewSecurity')}
                      </a>
                    </div>
                  </div>
                </div>

                {installedSlugs.has(selectedId) ? (
                  <button onClick={() => handleUninstall(selectedId)} disabled={uninstalling === selectedId}
                    className="w-full py-2.5 px-4 rounded-xl font-semibold text-sm transition-all flex items-center justify-center gap-2 bg-red-500/10 text-red-600 dark:text-red-400 border border-red-500/20 hover:bg-red-500/20">
                    {uninstalling === selectedId ? <><RefreshCw className="w-4 h-4 animate-spin" /><span>{t('agentDetail.skillsUninstalling')}</span></> : <><Trash2 className="w-4 h-4" /><span>{t('agentDetail.skillsUninstall')}</span></>}
                  </button>
                ) : (
                  <button onClick={() => handleInstall(selectedId)} disabled={installing === selectedId}
                    className="w-full py-2.5 px-4 rounded-xl font-semibold text-sm transition-all flex items-center justify-center gap-2 bg-teal-600 text-white hover:bg-teal-700 disabled:opacity-50">
                    {installing === selectedId ? <><RefreshCw className="w-4 h-4 animate-spin" /><span>{t('agentDetail.skillsInstalling')}</span></> : <><Download className="w-4 h-4" /><span>{t('agentDetail.skillsInstall')}</span></>}
                  </button>
                )}
              </div>
              {detail.latestVersion?.changelog && (
                <div className="flex-1 overflow-y-auto p-5">
                  <h4 className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider mb-2">Changelog</h4>
                  <pre className="text-[10px] text-muted-foreground font-mono whitespace-pre-wrap bg-background border border-border p-3 rounded-lg">{detail.latestVersion.changelog}</pre>
                </div>
              )}
            </>
          ) : selectedInstalled ? (
            <div className="p-5">
              <div className="flex items-start justify-between mb-3">
                <div className="flex items-center gap-3">
                  <Package className="w-8 h-8 text-teal-500" />
                  <div>
                    <h3 className="text-base font-bold text-foreground">{selectedInstalled.name}</h3>
                    <span className="text-[9px] px-1.5 py-0.5 rounded bg-teal-500/10 text-teal-600 dark:text-teal-400 border border-teal-500/20">{t('agentDetail.skillsClawHubTag')}</span>
                  </div>
                </div>
                <button onClick={() => setSelectedId(null)} className="p-1.5 hover:bg-muted rounded-lg transition-colors text-muted-foreground hover:text-foreground">
                  <XIcon className="w-4 h-4" />
                </button>
              </div>
              <p className="text-sm text-muted-foreground mb-4">{selectedInstalled.description || ''}</p>
              <a href={`https://clawhub.ai/${selectedInstalled.slug}`} target="_blank" rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 text-xs text-teal-600 dark:text-teal-400 hover:underline mb-4">
                <ExternalLink className="w-3 h-3" /> {t('agentDetail.skillsViewOnClawHub')}
              </a>
              <button onClick={() => handleUninstall(selectedInstalled.slug)} disabled={uninstalling === selectedInstalled.slug}
                className="w-full py-2.5 px-4 rounded-xl font-semibold text-sm transition-all flex items-center justify-center gap-2 bg-red-500/10 text-red-600 dark:text-red-400 border border-red-500/20 hover:bg-red-500/20">
                {uninstalling === selectedInstalled.slug ? <><RefreshCw className="w-4 h-4 animate-spin" /><span>{t('agentDetail.skillsUninstalling')}</span></> : <><Trash2 className="w-4 h-4" /><span>{t('agentDetail.skillsUninstall')}</span></>}
              </button>
            </div>
          ) : (
            <div className="flex-1 flex items-center justify-center p-5">
              <div className="text-center">
                <p className="text-sm text-muted-foreground">{t('agentDetail.skillsCouldNotLoad')}</p>
              </div>
            </div>
          )
        ) : (
          <div className="flex-1 flex items-center justify-center p-5">
            <div className="text-center">
              <Sparkles className="w-10 h-10 text-muted-foreground/20 mx-auto mb-3" />
              <p className="text-sm text-muted-foreground">{t('agentDetail.skillsSelectToView')}</p>
              <p className="text-xs text-muted-foreground mt-1">{t('agentDetail.skillsSearchHint')}</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// Config Panel Component
interface ConfigPanelProps {
  agent: AgentSummary;
  config: any;
  onNavigateToMemory: () => void;
}

function ConfigPanel({ agent, config, onNavigateToMemory }: ConfigPanelProps) {
  const { t } = useTranslation();
  const settings = config?.settings || {};
  const { agents, saveAgentConfig, patchGatewayConfig, gatewayConfig } = useDashboardStore();

  // Extract models from gateway config:
  // - Global default: agents.defaults.model.primary
  // - Per-agent override: agents.list[].model (string or { primary })
  const agentsSection = (gatewayConfig?.config as Record<string, unknown>)?.agents as
    { defaults?: { model?: { primary?: string } }; list?: Array<{ id: string; model?: string | { primary?: string } }> } | undefined;
  const gatewayDefaultModel = agentsSection?.defaults?.model?.primary || '';
  const agentEntry = agentsSection?.list?.find(a => a.id === agent.id);
  const agentModelOverride = agentEntry?.model
    ? (typeof agentEntry.model === 'string' ? agentEntry.model : agentEntry.model.primary || '')
    : '';
  // Effective model: per-agent override > global default
  const activeModel = agentModelOverride || gatewayDefaultModel;

  // Initialize local settings with the active model
  const effectiveSettings = {
    ...settings,
    model: settings.model || activeModel,
  };
  const [localSettings, setLocalSettings] = useState(effectiveSettings);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [settingsSaved, setSettingsSaved] = useState(false);
  const [settingsError, setSettingsError] = useState<string | null>(null);

  // Sync local settings when config or gateway config changes
  useEffect(() => {
    const model = config?.settings?.model || agentModelOverride || gatewayDefaultModel;
    setLocalSettings({
      ...(config?.settings || {}),
      model,
    });
  }, [config?.settings, agentModelOverride, gatewayDefaultModel]);

  const handleSaveSettings = async () => {
    setSettingsSaving(true);
    setSettingsError(null);
    try {
      // Model changes: write per-agent override in agents.list via config.patch
      if (localSettings.model && localSettings.model !== activeModel) {
        // Build the updated agents.list with this agent's model override
        const currentList: Array<Record<string, unknown>> = (agentsSection?.list || []).map(a => ({ ...a }));
        const existingIdx = currentList.findIndex(a => a.id === agent.id);

        if (existingIdx >= 0) {
          // Update existing entry
          currentList[existingIdx] = { ...currentList[existingIdx], model: localSettings.model };
        } else {
          // Add new entry for this agent with just the model override
          currentList.push({ id: agent.id, model: localSettings.model });
        }

        const success = await patchGatewayConfig({
          agents: { list: currentList },
        });
        if (!success) {
          setSettingsError('Failed to update agent model');
          setSettingsSaving(false);
          return;
        }
      }
      // Save other settings (temperature, maxTokens, etc.) via agents.update
      const { model: _model, ...otherSettings } = localSettings;
      if (Object.keys(otherSettings).length > 0) {
        await saveAgentConfig(agent.id, { settings: otherSettings });
      }
      setSettingsSaved(true);
      setTimeout(() => setSettingsSaved(false), 2000);
    } catch (err) {
      console.error('Failed to save settings:', err);
      setSettingsError(String(err));
    } finally {
      setSettingsSaving(false);
    }
  };

  // Agent-to-Agent state
  const [a2aEnabled, setA2aEnabled] = useState(settings.agentToAgent?.enabled || false);
  const [a2aAllowedAgents, setA2aAllowedAgents] = useState<string>(
    (settings.agentToAgent?.allowedAgents || []).join(', ')
  );

  const [copiedPrompt, setCopiedPrompt] = useState(false);

  // Get list of other agents for reference
  const otherAgents = agents?.agents.filter(a => a.id !== agent.id) || [];

  return (
    <div className="h-full overflow-y-auto p-6 animate-in fade-in duration-300">
      <div className="max-w-4xl mx-auto space-y-6">
        {/* Header */}
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-muted border border-border flex items-center justify-center">
            <Settings className="w-5 h-5 text-foreground/60" />
          </div>
          <div>
            <h3 className="text-sm font-bold text-foreground" style={{ fontFamily: 'Inter, system-ui, sans-serif' }}>
              {t('agentDetail.agentConfiguration')}
            </h3>
            <p className="text-xs text-muted-foreground">{t('agentDetail.configDescription')}</p>
          </div>
        </div>

        {/* Model & Generation Settings */}
        <div className="rounded-2xl border border-border bg-card overflow-hidden">
          <div className="p-5">
            <SettingsTab settings={localSettings} onChange={setLocalSettings} />
          </div>
          <div className="px-5 pb-4 pt-2 border-t border-border flex items-center gap-3">
            <button
              onClick={handleSaveSettings}
              disabled={settingsSaving}
              className="px-4 py-2 bg-primary hover:bg-primary/90 disabled:opacity-50 rounded-lg text-sm font-medium text-primary-foreground transition-colors flex items-center gap-2"
            >
              {settingsSaving ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
              {settingsSaving ? t('agentDetail.saving') : t('agentDetail.saveSettings')}
            </button>
            {settingsSaved && (
              <span className="text-xs text-emerald-600 dark:text-emerald-400 flex items-center gap-1">
                <Check className="w-3.5 h-3.5" /> {t('agentDetail.settingsSaved')}
              </span>
            )}
            {settingsError && (
              <span className="text-xs text-red-600 dark:text-red-400">{settingsError}</span>
            )}
          </div>
        </div>

        {/* Config Sections Grid */}
        <div className="grid grid-cols-2 gap-4">
          {/* Identity */}
          <ConfigCard
            title={t('agentDetail.agentIdentity')}
            icon={<Bot className="w-4 h-4" />}
            color="violet"
          >
            <ConfigRow label={t('agentDetail.id')} value={agent.id} mono />
            <ConfigRow label={t('agentDetail.name')} value={agent.identity?.name || agent.name || t('agentDetail.notSet')} />
            <ConfigRow label={t('agentDetail.emoji')} value={agent.identity?.emoji || '🤖'} />
          </ConfigCard>

          {/* Paths */}
          <ConfigCard
            title={t('agentDetail.filePaths')}
            icon={<Database className="w-4 h-4" />}
            color="amber"
          >
            <ConfigRow label={t('agentDetail.workspacePath')} value={`~/.openclaw/workspace/${agent.id}`} mono small />
            <ConfigRow label={t('agentDetail.stateDir')} value="~/.openclaw/state" mono small />
            <ConfigRow label={t('agentDetail.memoryDb')} value={`~/.openclaw/state/memory/${agent.id}.sqlite`} mono small />
            <ConfigRow label={t('agentDetail.skillsPath')} value="~/.openclaw/skills" mono small />
          </ConfigCard>
        </div>

        {/* Agent-to-Agent Communication Section (hidden) */}
        <div className="hidden bg-gradient-to-br from-blue-500/10 to-indigo-500/5 rounded-2xl border border-blue-500/20 overflow-hidden">
          <div className="px-5 py-4 border-b border-blue-500/20 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-xl bg-blue-500/20 flex items-center justify-center">
                <Users className="w-4.5 h-4.5 text-blue-500 dark:text-blue-400" />
              </div>
              <div>
                <h4 className="text-sm font-bold text-foreground">{t('agentDetail.a2aCommunication')}</h4>
                <p className="text-[11px] text-muted-foreground">{t('agentDetail.a2aDescription')}</p>
              </div>
            </div>
            <label className="relative inline-flex items-center cursor-pointer">
              <input
                type="checkbox"
                checked={a2aEnabled}
                onChange={(e) => setA2aEnabled(e.target.checked)}
                className="sr-only peer"
              />
              <div className="w-11 h-6 bg-muted-foreground peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-blue-500"></div>
            </label>
          </div>

          <div className="p-5 space-y-4">
            {/* Allowed Agents */}
            <div>
              <label className="block text-xs font-semibold text-foreground/80 mb-2">
                {t('agentDetail.allowedAgents')}
                <span className="ml-2 text-muted-foreground font-normal">
                  {t('agentDetail.agentsSeparatorHint')}
                </span>
              </label>
              <input
                type="text"
                value={a2aAllowedAgents}
                onChange={(e) => setA2aAllowedAgents(e.target.value)}
                placeholder={otherAgents.length > 0 ? otherAgents.map(a => a.id).join(', ') : 'agent2, agent3, *'}
                className="w-full px-3 py-2 bg-muted border border-border rounded-lg text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-blue-500/50 focus:ring-1 focus:ring-blue-500/20 font-mono"
              />
              {otherAgents.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  <span className="text-[10px] text-muted-foreground mr-1">{t('agentDetail.available')}</span>
                  {otherAgents.map(a => (
                    <button
                      key={a.id}
                      onClick={() => {
                        const current = a2aAllowedAgents.split(',').map(s => s.trim()).filter(s => s);
                        if (!current.includes(a.id)) {
                          setA2aAllowedAgents([...current, a.id].join(', '));
                        }
                      }}
                      className="px-2 py-0.5 text-[10px] bg-muted hover:bg-muted border border-border rounded-md text-muted-foreground hover:text-foreground transition-colors font-mono"
                    >
                      {a.identity?.emoji || '🤖'} {a.id}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* How to Configure */}
            <div className="space-y-4">
              <div>
                <p className="text-xs font-semibold text-foreground/80 mb-3">
                  {t('agentDetail.delegationRulesTitle')}
                </p>
                <p className="text-[11px] text-muted-foreground mb-4">
                  {t('agentDetail.delegationRulesExplanation')}
                </p>
              </div>

              {/* Option 1: Memory Tab */}
              <div className="bg-emerald-500/10 border border-emerald-500/20 rounded-xl p-4">
                <div className="flex items-start gap-3">
                  <div className="w-8 h-8 rounded-lg bg-emerald-500/20 flex items-center justify-center shrink-0">
                    <span className="text-emerald-600 dark:text-emerald-400 font-bold text-sm">1</span>
                  </div>
                  <div className="flex-1">
                    <p className="text-xs font-semibold text-emerald-700 dark:text-emerald-300 mb-1">{t('agentDetail.editAgentsDirectly')}</p>
                    <p className="text-[11px] text-muted-foreground mb-3">
                      Go to the <span className="text-foreground">Memory</span> tab and edit <span className="text-foreground font-mono">AGENTS.md</span> to add your delegation rules.
                    </p>
                    <button
                      onClick={onNavigateToMemory}
                      className="flex items-center gap-2 px-3 py-1.5 text-xs font-medium bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-700 dark:text-emerald-300 border border-emerald-500/30 rounded-lg transition-all"
                    >
                      <Brain className="w-3.5 h-3.5" />
                      {t('agentDetail.goToMemoryTab')}
                    </button>
                  </div>
                </div>
              </div>

              {/* Option 2: Ask the agent */}
              <div className="bg-blue-500/10 border border-blue-500/20 rounded-xl p-4">
                <div className="flex items-start gap-3">
                  <div className="w-8 h-8 rounded-lg bg-blue-500/20 flex items-center justify-center shrink-0">
                    <span className="text-blue-500 dark:text-blue-400 font-bold text-sm">2</span>
                  </div>
                  <div className="flex-1">
                    <p className="text-xs font-semibold text-blue-600 dark:text-blue-300 mb-1">{t('agentDetail.askAgentToUpdate')}</p>
                    <p className="text-[11px] text-muted-foreground mb-3">
                      {t('agentDetail.copyMessageHint')}
                    </p>
                    <div className="bg-muted rounded-lg p-3 mb-3">
                      <pre className="text-[10px] font-mono text-muted-foreground whitespace-pre-wrap leading-relaxed">
{`Please add the following section to your AGENTS.md file:

## Agent Delegation

You can delegate tasks to other agents:
- sessions_send({ agentId: "...", message: "..." }) - Send to agent
- sessions_spawn({ task: "...", label: "..." }) - Background subagent

Rules:
${a2aAllowedAgents ? `- Allowed agents: ${a2aAllowedAgents}` : '- [Add your rules here]'}
- [Add specific delegation criteria]`}
                      </pre>
                    </div>
                    <button
                      onClick={() => {
                        const message = `Please add the following section to your AGENTS.md file:

## Agent Delegation

You can delegate tasks to other agents:
- sessions_send({ agentId: "...", message: "..." }) - Send to agent
- sessions_spawn({ task: "...", label: "..." }) - Background subagent

Rules:
${a2aAllowedAgents ? `- Allowed agents: ${a2aAllowedAgents}` : '- [Add your rules here]'}
- [Add specific delegation criteria]`;
                        navigator.clipboard.writeText(message);
                        setCopiedPrompt(true);
                        setTimeout(() => setCopiedPrompt(false), 2000);
                      }}
                      className={cn(
                        "flex items-center gap-2 px-3 py-1.5 text-xs font-medium border rounded-lg transition-all",
                        copiedPrompt
                          ? "bg-emerald-500/20 text-emerald-700 dark:text-emerald-300 border-emerald-500/30"
                          : "bg-blue-500/20 hover:bg-blue-500/30 text-blue-600 dark:text-blue-300 border-blue-500/30"
                      )}
                    >
                      {copiedPrompt ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                      {copiedPrompt ? t('agentDetail.copied') : t('agentDetail.copyMessage')}
                    </button>
                  </div>
                </div>
              </div>

              {/* Available tools reference */}
              <div className="bg-muted/50 rounded-xl p-4 border border-border">
                <p className="text-xs font-semibold text-foreground/80 mb-3">{t('agentDetail.availableToolsReference')}</p>
                <div className="space-y-2 text-[11px] font-mono text-muted-foreground">
                  <div className="bg-muted rounded-lg p-2">
                    <span className="text-blue-500 dark:text-blue-400">sessions_send</span>({'{'} agentId, message {'}'}) <span className="text-muted-foreground">// Send to another agent</span>
                  </div>
                  <div className="bg-muted rounded-lg p-2">
                    <span className="text-purple-600 dark:text-purple-400">sessions_spawn</span>({'{'} task, label {'}'}) <span className="text-muted-foreground">// Spawn background subagent</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>


        {/* Raw JSON Preview (hidden) */}
        <div className="hidden bg-muted/50 border border-border rounded-2xl overflow-hidden">
          <div className="px-4 py-3 border-b border-border flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Terminal className="w-4 h-4 text-muted-foreground" />
              <h4 className="text-xs font-bold text-muted-foreground uppercase tracking-wider">{t('agentDetail.rawConfiguration')}</h4>
            </div>
            <button className="text-[10px] text-muted-foreground hover:text-foreground transition-colors flex items-center gap-1">
              <ExternalLink className="w-3 h-3" />
              {t('agentDetail.export')}
            </button>
          </div>
          <div className="p-4 max-h-64 overflow-y-auto">
            <pre className="text-[10px] font-mono text-muted-foreground leading-relaxed" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
              {JSON.stringify(agent, null, 2)}
            </pre>
          </div>
        </div>
      </div>
    </div>
  );
}

// Config Card Component
interface ConfigCardProps {
  title: string;
  icon: React.ReactNode;
  color: 'cyan' | 'violet' | 'amber' | 'emerald';
  children: React.ReactNode;
}

function ConfigCard({ title, icon, color, children }: ConfigCardProps) {
  const colorClasses = {
    cyan: { icon: 'text-cyan-600 dark:text-cyan-400' },
    violet: { icon: 'text-violet-600 dark:text-violet-400' },
    amber: { icon: 'text-amber-600 dark:text-amber-400' },
    emerald: { icon: 'text-emerald-600 dark:text-emerald-400' },
  };

  const styles = colorClasses[color];

  return (
    <div className="rounded-2xl border border-border bg-card p-4">
      <div className="flex items-center gap-2 mb-3">
        <span className={styles.icon}>{icon}</span>
        <h4 className="text-xs font-bold text-foreground uppercase tracking-wider">{title}</h4>
      </div>
      <div className="space-y-1">
        {children}
      </div>
    </div>
  );
}

// Config Row Component
interface ConfigRowProps {
  label: string;
  value: string;
  mono?: boolean;
  small?: boolean;
}

function ConfigRow({ label, value, mono, small }: ConfigRowProps) {
  return (
    <div className="flex items-center justify-between text-xs py-1.5 border-b border-border/50 last:border-0">
      <span className="text-muted-foreground font-medium">{label}</span>
      <span className={cn(
        "text-foreground truncate max-w-[60%] text-right",
        mono && "font-mono",
        small && "text-[10px]"
      )} title={value}>
        {value}
      </span>
    </div>
  );
}

// Scheduled Panel Component - Cron jobs for this agent
interface ScheduledPanelProps {
  agentId: string;
  cronJobs: CronJob[];
  onToggle: (id: string, enabled: boolean) => Promise<void>;
  onRun: (id: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onAdd: (job: Omit<CronJob, 'id' | 'createdAtMs' | 'updatedAtMs' | 'state'>) => Promise<string | null>;
  onUpdate: (id: string, updates: Partial<CronJob>) => Promise<boolean>;
}

function ScheduledPanel({
  agentId,
  cronJobs,
  onToggle,
  onRun,
  onDelete,
  onAdd,
  onUpdate,
}: ScheduledPanelProps) {
  const { t } = useTranslation();
  const { readMemoryFile, writeMemoryFile, memoryContent, memoryLoading } = useDashboardStore();
  const [showForm, setShowForm] = useState(false);
  const [editingJob, setEditingJob] = useState<CronJob | null>(null);
  const [formSaving, setFormSaving] = useState(false);
  const [heartbeatContent, setHeartbeatContent] = useState('');
  const [heartbeatExpanded, setHeartbeatExpanded] = useState(false);
  const [heartbeatSaveStatus, setHeartbeatSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const heartbeatTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const heartbeatLastSavedRef = useRef('');

  // Load HEARTBEAT.md on mount
  useEffect(() => {
    if (agentId) readMemoryFile(agentId, 'HEARTBEAT.md');
  }, [agentId, readMemoryFile]);

  // Sync loaded content
  useEffect(() => {
    if (!heartbeatExpanded) return; // Only sync when first opened
    setHeartbeatContent(memoryContent);
    heartbeatLastSavedRef.current = memoryContent;
  }, [memoryContent, heartbeatExpanded]);

  const handleHeartbeatOpen = () => {
    if (!heartbeatExpanded) {
      readMemoryFile(agentId, 'HEARTBEAT.md');
    }
    setHeartbeatExpanded(!heartbeatExpanded);
  };

  const handleHeartbeatChange = (value: string) => {
    setHeartbeatContent(value);
    if (heartbeatTimeoutRef.current) clearTimeout(heartbeatTimeoutRef.current);
    heartbeatTimeoutRef.current = setTimeout(async () => {
      if (value === heartbeatLastSavedRef.current) return;
      setHeartbeatSaveStatus('saving');
      const ok = await writeMemoryFile(agentId, 'HEARTBEAT.md', value);
      if (ok) {
        heartbeatLastSavedRef.current = value;
        setHeartbeatSaveStatus('saved');
        setTimeout(() => setHeartbeatSaveStatus('idle'), 2000);
      } else {
        setHeartbeatSaveStatus('error');
      }
    }, 1000);
  };

  const handleFormSave = async (jobData: Omit<CronJob, 'id' | 'createdAtMs' | 'updatedAtMs' | 'state'>) => {
    setFormSaving(true);
    try {
      // Ensure agentId is set
      const jobWithAgent = { ...jobData, agentId };

      if (editingJob) {
        await onUpdate(editingJob.id, jobWithAgent);
      } else {
        await onAdd(jobWithAgent);
      }
      setShowForm(false);
      setEditingJob(null);
    } finally {
      setFormSaving(false);
    }
  };

  const handleEdit = (job: CronJob) => {
    setEditingJob(job);
    setShowForm(true);
  };

  const enabledCount = cronJobs.filter(j => j.enabled).length;

  return (
    <div className="h-full overflow-y-auto p-6 animate-in fade-in duration-300">
      <div className="max-w-4xl mx-auto space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-cyan-500/20 to-blue-500/20 border border-cyan-500/30 flex items-center justify-center">
              <CalendarClock className="w-5 h-5 text-cyan-600 dark:text-cyan-400" />
            </div>
            <div>
              <h3 className="text-sm font-bold text-foreground" style={{ fontFamily: 'Inter, system-ui, sans-serif' }}>
                {t('agentDetail.scheduledTasks')}
              </h3>
              <p className="text-xs text-muted-foreground">
                {cronJobs.length} {cronJobs.length !== 1 ? t('agentDetail.jobsPlural') : t('agentDetail.jobSingular')} • {t('agentDetail.activeCount', { count: enabledCount })}
              </p>
            </div>
          </div>
          <button
            onClick={() => {
              setEditingJob(null);
              setShowForm(true);
            }}
            className="flex items-center gap-2 px-4 py-2 text-xs font-semibold rounded-xl bg-gradient-to-r from-cyan-500/20 to-blue-500/20 text-cyan-700 dark:text-cyan-300 border border-cyan-500/30 hover:from-cyan-500/30 hover:to-blue-500/30 transition-all"
          >
            <Plus className="w-3.5 h-3.5" />
            {t('agentDetail.newTask')}
          </button>
        </div>

        {/* HEARTBEAT.md Editor */}
        <div className="rounded-xl border border-border overflow-hidden">
          <button
            onClick={handleHeartbeatOpen}
            className="w-full flex items-center gap-3 px-4 py-3 bg-muted/50 hover:bg-muted transition-colors text-left"
          >
            <Clock className="w-4 h-4 text-cyan-600 dark:text-cyan-400" />
            <div className="flex-1">
              <span className="text-xs font-semibold text-foreground">HEARTBEAT.md</span>
              <p className="text-[10px] text-muted-foreground">{t('agentDetail.heartbeatFileDescription')}</p>
            </div>
            {heartbeatSaveStatus === 'saving' && <RefreshCw className="w-3.5 h-3.5 text-muted-foreground animate-spin" />}
            {heartbeatSaveStatus === 'saved' && <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" />}
            {heartbeatSaveStatus === 'error' && <AlertTriangle className="w-3.5 h-3.5 text-red-500" />}
            <span className={cn("text-[10px] text-muted-foreground transition-transform", heartbeatExpanded ? "rotate-90" : "")}>▶</span>
          </button>
          {heartbeatExpanded && (
            <div className="p-4 border-t border-border animate-in slide-in-from-top-1 duration-150">
              {memoryLoading ? (
                <div className="flex items-center justify-center py-6">
                  <RefreshCw className="w-5 h-5 text-muted-foreground animate-spin" />
                </div>
              ) : (
                <textarea
                  value={heartbeatContent}
                  onChange={(e) => handleHeartbeatChange(e.target.value)}
                  className="w-full h-48 p-3 bg-muted border border-border rounded-lg text-sm text-foreground font-mono focus:outline-none focus:border-cyan-500/50 focus:ring-1 focus:ring-cyan-500/20 resize-y transition-all"
                  placeholder={t('agentDetail.fileContentPlaceholder')}
                  spellCheck={false}
                />
              )}
            </div>
          )}
        </div>

        {/* Cron Jobs List */}
        <CronJobList
          jobs={cronJobs}
          onToggle={(id, enabled) => onToggle(id, enabled)}
          onRun={onRun}
          onEdit={handleEdit}
          onDelete={onDelete}
          showAgentInfo={false}
          emptyMessage={t('agentDetail.noScheduledTasks')}
        />

        {/* Form Modal */}
        {showForm && (
          <CronJobForm
            job={editingJob || undefined}
            agentId={agentId}
            onSave={handleFormSave}
            onCancel={() => {
              setShowForm(false);
              setEditingJob(null);
            }}
            saving={formSaving}
          />
        )}
      </div>
    </div>
  );
}

