import { useState, useEffect, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useDashboardStore } from '../../store/dashboard-store';
import {
  Activity,
  MessageSquare,
  Zap,
  CheckCircle2,
  AlertTriangle,
  Database,
  XCircle,
  Wrench,
  Sparkles,
  BookOpen,
  FolderOpen,
} from 'lucide-react';
import { CronStatsWidget } from '../cron';
import { TaskDetailModal } from './TaskDetailModal';
import useTranslation from '../../i18n';
import type { Task } from '../../types/openclaw';

const TOOL_GROUPS = [
  'group:fs', 'group:runtime', 'group:web', 'group:ui',
  'group:sessions', 'group:memory', 'group:automation', 'group:messaging', 'group:nodes',
];

const BUILTIN_SKILL_GROUPS = [
  'group:fs', 'group:runtime', 'group:web', 'group:ui',
  'group:sessions', 'group:memory', 'group:automation', 'lobster', 'group:messaging',
];

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function formatDuration(startedAt: number, completedAt?: number) {
  const end = completedAt || Date.now();
  const seconds = Math.floor((end - startedAt) / 1000);
  const minutes = Math.floor(seconds / 60);
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}

function TaskCard({ task, onClick }: { task: Task; onClick: () => void }) {
  const isRunning = task.status === 'running';
  const isFailed = task.status === 'failed' || task.status === 'cancelled';
  const tokens = (task.inputTokens || 0) + (task.outputTokens || 0);

  return (
    <button
      onClick={onClick}
      className={`w-full text-left p-2.5 rounded-lg border transition-colors cursor-pointer ${
        isRunning
          ? 'border-blue-500/20 bg-blue-500/5 hover:bg-blue-500/10'
          : isFailed
            ? 'border-red-500/15 bg-red-500/5 hover:bg-red-500/8'
            : 'border-border hover:bg-muted/40'
      }`}
    >
      <p className="text-[11px] font-medium text-foreground truncate">{task.runId || task.id}</p>
      <div className="flex items-center gap-2 mt-1">
        {task.startedAt && (
          <span className="text-[10px] text-muted-foreground tabular-nums">
            {formatDuration(task.startedAt, task.completedAt)}
          </span>
        )}
        {tokens > 0 && (
          <span className="text-[10px] text-muted-foreground tabular-nums">
            {formatTokens(tokens)} tok
          </span>
        )}
        {isRunning && <span className="w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse ml-auto" />}
      </div>
      {isFailed && task.error && (
        <p className="text-[10px] text-red-500/80 truncate mt-1">{task.error}</p>
      )}
    </button>
  );
}

export function OverviewPanel() {
  const { id: agentId } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { t } = useTranslation();
  const {
    addSessionOptimistic, sessions: allSessions, tasks: allTasks, cronJobs: allCronJobs,
    gatewayConfig, selectedAgentConfig, workspaceFiles, listWorkspaceFiles, token,
  } = useDashboardStore();
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);
  const [installedSkillsCount, setInstalledSkillsCount] = useState(0);

  // Load workspace files and installed skills count
  useEffect(() => {
    if (agentId) {
      listWorkspaceFiles(agentId);
      // Fetch installed skills count
      const headers: Record<string, string> = {};
      if (token) headers['Authorization'] = `Bearer ${token}`;
      fetch('/api/skills/list', { headers })
        .then(r => r.ok ? r.json() : null)
        .then(data => { if (data?.skills) setInstalledSkillsCount(data.skills.length); })
        .catch(() => {});
    }
  }, [agentId, listWorkspaceFiles, token]);

  // Derive tool/skill counts from gateway config
  const { enabledToolGroups, enabledBuiltinSkills } = useMemo(() => {
    const config = gatewayConfig?.config as Record<string, unknown> | undefined;
    const globalTools = (config?.tools || {}) as Record<string, unknown>;
    const globalDeny = (globalTools.deny || []) as string[];
    const globalAlsoAllow = (globalTools.alsoAllow || []) as string[];
    const agentsCfg = config?.agents as { list?: Array<Record<string, unknown>> } | undefined;
    const agentEntry = agentsCfg?.list?.find((a: Record<string, unknown>) => a.id === agentId);
    const agentTools = (agentEntry?.tools || null) as Record<string, unknown> | null;
    const effectiveDeny = agentTools ? (agentTools.deny || []) as string[] : globalDeny;
    const effectiveAlsoAllow = agentTools ? (agentTools.alsoAllow || []) as string[] : globalAlsoAllow;

    const enabledTools = TOOL_GROUPS.filter(g => !effectiveDeny.includes(g)).length;
    const enabledSkills = BUILTIN_SKILL_GROUPS.filter(g => {
      if (g === 'lobster') return effectiveAlsoAllow.includes('lobster');
      return !effectiveDeny.includes(g);
    }).length;

    return { enabledToolGroups: enabledTools, enabledBuiltinSkills: enabledSkills };
  }, [gatewayConfig, agentId]);

  const knowledgeCount = selectedAgentConfig?.knowledgeFiles?.length || 0;
  const workspaceSize = useMemo(() => {
    const totalBytes = workspaceFiles.reduce((acc, f) => acc + (f.size || 0), 0);
    if (totalBytes >= 1_000_000) return `${(totalBytes / 1_000_000).toFixed(1)} MB`;
    if (totalBytes >= 1_000) return `${(totalBytes / 1_000).toFixed(1)} KB`;
    return `${totalBytes} B`;
  }, [workspaceFiles]);

  if (!agentId) return null;

  const sessions = allSessions?.sessions.filter(s => s.key.includes(agentId)) || [];
  const tasks = allTasks.filter(t => t.agentId === agentId || t.sessionKey?.startsWith(`agent:${agentId}:`));
  const cronJobs = allCronJobs.filter(j => j.agentId === agentId);
  const completedTasks = tasks.filter(t => t.status === 'succeeded').length;
  const failedTasks = tasks.filter(t => t.status === 'failed').length;
  const onViewScheduled = () => navigate(`/agents/${agentId}/scheduled`);

  const runningList = tasks.filter(t => t.status === 'running');
  const completedList = tasks.filter(t => t.status === 'succeeded');
  const errorList = tasks.filter(t => t.status === 'failed');
  const abortedList = tasks.filter(t => t.status === 'cancelled');

  const totalTokens = sessions.reduce((acc, s) => acc + (s.totalTokens || 0), 0);
  const avgTokensPerSession = sessions.length > 0 ? Math.round(totalTokens / sessions.length) : 0;
  const successRate = tasks.length > 0 ? Math.round((completedTasks / tasks.length) * 100) : 100;

  const columns = [
    {
      key: 'running',
      label: t('agentDetail.running'),
      icon: <Zap className="w-3 h-3" />,
      color: 'text-blue-600 dark:text-blue-400',
      count: runningList.length,
      tasks: runningList,
    },
    {
      key: 'completed',
      label: t('agentDetail.completed'),
      icon: <CheckCircle2 className="w-3 h-3" />,
      color: 'text-emerald-600 dark:text-emerald-400',
      count: completedList.length,
      tasks: completedList,
    },
    {
      key: 'error',
      label: 'Error',
      icon: <AlertTriangle className="w-3 h-3" />,
      color: 'text-red-500',
      count: errorList.length,
      tasks: errorList,
    },
    {
      key: 'aborted',
      label: 'Aborted',
      icon: <XCircle className="w-3 h-3" />,
      color: 'text-amber-600 dark:text-amber-400',
      count: abortedList.length,
      tasks: abortedList,
    },
  ];

  // Only show columns that have tasks, but always show running + completed
  const visibleColumns = columns.filter(c => c.key === 'running' || c.key === 'completed' || c.count > 0);

  return (
    <div className="h-full flex animate-in fade-in duration-300">
      {/* Left: Stats & Actions */}
      <div className="w-[320px] overflow-y-auto p-5 space-y-4 border-r border-border shrink-0">
        {/* Quick Stats */}
        <div className="grid grid-cols-2 gap-2">
          <div className="rounded-xl bg-card border border-border p-3">
            <div className="w-7 h-7 rounded-lg bg-muted dark:bg-muted text-primary flex items-center justify-center mb-2">
              <MessageSquare className="w-3.5 h-3.5" />
            </div>
            <p className="text-xl font-bold text-foreground tabular-nums">{sessions.length}</p>
            <p className="text-[10px] text-muted-foreground">{t('agentDetail.sessions')}</p>
          </div>

          <div className="rounded-xl bg-card border border-border p-3">
            <div className="w-7 h-7 rounded-lg bg-muted dark:bg-muted text-amber-600 dark:text-amber-400 flex items-center justify-center mb-2">
              <Database className="w-3.5 h-3.5" />
            </div>
            <p className="text-xl font-bold text-foreground tabular-nums">{formatTokens(totalTokens)}</p>
            <p className="text-[10px] text-muted-foreground">{t('agentDetail.totalTokens')}</p>
          </div>

          <div className="rounded-xl bg-card border border-border p-3">
            <div className="w-7 h-7 rounded-lg bg-muted dark:bg-muted text-cyan-600 dark:text-cyan-400 flex items-center justify-center mb-2">
              <Activity className="w-3.5 h-3.5" />
            </div>
            <p className="text-xl font-bold text-foreground tabular-nums">{tasks.length}</p>
            <p className="text-[10px] text-muted-foreground">
              {t('agentDetail.totalTasks')} · {completedTasks} {t('agentDetail.done').toLowerCase()}
            </p>
          </div>

          <div className="rounded-xl bg-card border border-border p-3">
            <div className="w-7 h-7 rounded-lg bg-muted dark:bg-muted text-emerald-600 dark:text-emerald-400 flex items-center justify-center mb-2">
              <CheckCircle2 className="w-3.5 h-3.5" />
            </div>
            <p className="text-xl font-bold text-foreground tabular-nums">{successRate}%</p>
            <p className="text-[10px] text-muted-foreground">{t('agentDetail.successRate')}</p>
          </div>
        </div>

        {/* Agent Resources */}
        <div className="grid grid-cols-4 gap-2">
          <div className="rounded-lg bg-card border border-border p-2.5 text-center">
            <Wrench className="w-3.5 h-3.5 text-muted-foreground mx-auto mb-1" />
            <p className="text-sm font-bold text-foreground tabular-nums">{enabledToolGroups}</p>
            <p className="text-[10px] text-muted-foreground">Tools</p>
          </div>
          <div className="rounded-lg bg-card border border-border p-2.5 text-center">
            <Sparkles className="w-3.5 h-3.5 text-muted-foreground mx-auto mb-1" />
            <p className="text-sm font-bold text-foreground tabular-nums">{enabledBuiltinSkills + installedSkillsCount}</p>
            <p className="text-[10px] text-muted-foreground">Skills</p>
          </div>
          <div className="rounded-lg bg-card border border-border p-2.5 text-center">
            <BookOpen className="w-3.5 h-3.5 text-muted-foreground mx-auto mb-1" />
            <p className="text-sm font-bold text-foreground tabular-nums">{knowledgeCount}</p>
            <p className="text-[10px] text-muted-foreground">Knowledge</p>
          </div>
          <div className="rounded-lg bg-card border border-border p-2.5 text-center">
            <FolderOpen className="w-3.5 h-3.5 text-muted-foreground mx-auto mb-1" />
            <p className="text-sm font-bold text-foreground tabular-nums">{workspaceFiles.length}</p>
            <p className="text-[10px] text-muted-foreground">{workspaceSize}</p>
          </div>
        </div>

        {/* New Chat Button */}
        <button
          onClick={() => {
            const label = 'chat';
            const sessionKey = `agent:${agentId}:${label}-${Date.now()}`;
            addSessionOptimistic(sessionKey, label);
            navigate(`/session/${sessionKey}`);
          }}
          className="w-full px-4 py-3 bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-medium rounded-xl transition-colors flex items-center justify-center gap-2"
        >
          <MessageSquare className="w-4 h-4" />
          {t('agentDetail.startChatting')}
        </button>

        {/* Scheduled Jobs Widget */}
        {cronJobs.length > 0 && (
          <CronStatsWidget jobs={cronJobs} onViewAll={onViewScheduled} />
        )}

        {/* Token & Task Details */}
        <div className="rounded-xl border border-border bg-card p-4 space-y-3">
          <div className="flex justify-between items-center">
            <span className="text-xs text-muted-foreground">{t('agentDetail.totalTokens')}</span>
            <span className="text-xs font-medium text-foreground tabular-nums">{totalTokens.toLocaleString()}</span>
          </div>
          <div className="flex justify-between items-center">
            <span className="text-xs text-muted-foreground">{t('agentDetail.avgPerSession')}</span>
            <span className="text-xs font-medium text-foreground tabular-nums">{avgTokensPerSession.toLocaleString()}</span>
          </div>
          {tasks.length > 0 && (
            <>
              <div className="border-t border-border pt-3 flex justify-between items-center">
                <span className="text-xs text-muted-foreground">{t('agentDetail.failed')}</span>
                <span className={`text-xs font-medium tabular-nums ${failedTasks > 0 ? 'text-red-500' : 'text-foreground'}`}>{failedTasks}</span>
              </div>
              {tasks.length > 1 && (
                <div className="h-1.5 bg-muted rounded-full overflow-hidden flex">
                  <div className="h-full bg-emerald-500 rounded-full" style={{ width: `${successRate}%` }} />
                  {failedTasks > 0 && <div className="h-full bg-red-400" style={{ width: `${100 - successRate}%` }} />}
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {/* Right: Task Pipeline — Column Layout */}
      <div className="flex-1 flex flex-col overflow-hidden">
        <div className="px-4 py-3 border-b border-border flex items-center gap-2">
          <Zap className="w-4 h-4 text-muted-foreground" />
          <h3 className="text-sm font-semibold text-foreground">{t('agentDetail.taskPipeline')}</h3>
          <span className="text-xs text-muted-foreground ml-1">{tasks.length}</span>
        </div>

        {tasks.length === 0 ? (
          <div className="flex-1 flex flex-col items-center justify-center text-center p-6">
            <div className="w-10 h-10 rounded-xl bg-muted flex items-center justify-center mb-3">
              <Zap className="w-5 h-5 text-muted-foreground/40" />
            </div>
            <p className="text-sm text-muted-foreground">{t('agentDetail.noTasks')}</p>
            <p className="text-xs text-muted-foreground/60 mt-1">{t('agentDetail.tasksEmptyDescription')}</p>
          </div>
        ) : (
          <div className="flex-1 flex overflow-x-auto overflow-y-hidden">
            {visibleColumns.map((col) => (
              <div key={col.key} className="flex-1 flex flex-col border-r border-border last:border-r-0 overflow-hidden min-w-[140px]">
                {/* Column header */}
                <div className="px-3 py-2 border-b border-border bg-muted/20 flex items-center gap-1.5 shrink-0 whitespace-nowrap">
                  <span className={col.color}>{col.icon}</span>
                  <span className={`text-[11px] font-medium ${col.color} truncate`}>{col.label}</span>
                  <span className="text-[10px] text-muted-foreground ml-auto tabular-nums shrink-0">{col.count}</span>
                </div>
                {/* Column body */}
                <div className="flex-1 overflow-y-auto p-2 space-y-1.5">
                  {col.tasks.length > 0 ? (
                    col.tasks.map((task) => (
                      <TaskCard key={task.id} task={task} onClick={() => setSelectedTask(task)} />
                    ))
                  ) : (
                    <div className="flex items-center justify-center py-8">
                      <span className="text-[10px] text-muted-foreground/40">—</span>
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Task Detail Modal */}
      {selectedTask && (
        <TaskDetailModal task={selectedTask} onClose={() => setSelectedTask(null)} />
      )}
    </div>
  );
}
