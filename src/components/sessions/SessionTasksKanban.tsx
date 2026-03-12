import { useState, useEffect, useCallback } from 'react';
import { useDashboardStore } from '../../store/dashboard-store';
import { cn } from '../../lib/utils';
import { useTranslation } from '../../i18n';
import {
  CheckCircle2,
  Clock,
  Zap,
  Play,
  X,
  Terminal,
  Sparkles,
  History,
  Wrench,
  ExternalLink,
} from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { TaskDetailModal } from '../agents/TaskDetailModal';
import type { Task } from '../../types/openclaw';

interface SessionTasksKanbanProps {
  sessionKey: string;
}

const TASK_CACHE_PREFIX = 'kanban-tasks:';

function getCachedTasks(sessionKey: string): Task[] {
  try {
    const raw = localStorage.getItem(TASK_CACHE_PREFIX + sessionKey);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

function setCachedTasks(sessionKey: string, tasks: Task[]) {
  try {
    localStorage.setItem(TASK_CACHE_PREFIX + sessionKey, JSON.stringify(tasks));
  } catch { /* quota exceeded — ignore */ }
}

export function SessionTasksKanban({ sessionKey }: SessionTasksKanbanProps) {
  const { t } = useTranslation();
  const { tasks, abortTask, loadTaskHistory, taskHistoryLoading, selectSession } = useDashboardStore();
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);

  // Extract agent ID from sessionKey to match tasks by agent, not exact key
  const extractAgentId = (key: string): string | null => {
    if (key.startsWith('agent:')) {
      const parts = key.split(':');
      if (parts.length >= 2) return parts[1];
    }
    const dmMatch = key.match(/^dm-(.+)$/);
    if (dmMatch) return dmMatch[1];
    return null;
  };

  const sessionAgentId = extractAgentId(sessionKey);

  // On mount: restore cached tasks into store
  useEffect(() => {
    const cached = getCachedTasks(sessionKey);
    if (cached.length === 0) return;
    const { tasks: currentTasks } = useDashboardStore.getState();
    const existingIds = new Set(currentTasks.map(t => t.id));
    const newTasks = cached.filter(t => !existingIds.has(t.id));
    if (newTasks.length > 0) {
      useDashboardStore.setState({ tasks: [...currentTasks, ...newTasks] });
    }
  }, [sessionKey]);

  const sessionTasks = tasks.filter(task => {
    if (task.sessionKey === sessionKey) return true;
    if (sessionAgentId && task.agentId === sessionAgentId) return true;
    if (sessionAgentId) {
      const taskAgentId = extractAgentId(task.sessionKey);
      if (taskAgentId === sessionAgentId) return true;
    }
    return false;
  });

  // Persist session tasks to localStorage whenever they change
  useEffect(() => {
    if (sessionTasks.length > 0) {
      setCachedTasks(sessionKey, sessionTasks);
    }
  }, [sessionKey, sessionTasks.length]);

  const runningTasks = sessionTasks.filter(t => t.status === 'running');
  const completedTasks = sessionTasks.filter(t =>
    t.status === 'completed' || t.status === 'error' || t.status === 'aborted'
  );

  // Navigate to sub-agent session when task card has a different sessionKey
  const handleNavigateToSession = (task: Task) => {
    if (task.sessionKey && task.sessionKey !== sessionKey) {
      selectSession(task.sessionKey);
    }
  };

  // Fetch history from API and cache results
  const handleLoadHistory = useCallback(async () => {
    await loadTaskHistory();
    // After loading, the store's tasks are updated — the useEffect above will persist to localStorage
  }, [loadTaskHistory]);

  const handleAbort = async (runId: string) => {
    try {
      await abortTask(runId);
    } catch (err) {
      console.error('Failed to abort task:', err);
    }
  };

  const formatDuration = (startedAt: number, completedAt?: number) => {
    const end = completedAt || Date.now();
    const seconds = Math.floor((end - startedAt) / 1000);
    const minutes = Math.floor(seconds / 60);
    if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
    return `${seconds}s`;
  };

  const totalTasks = sessionTasks.length;

  return (
    <div className="h-full flex flex-col bg-background overflow-hidden">
      {/* Header */}
      <div className="relative px-4 py-2.5 border-b flex items-center justify-between shrink-0">
        <div className="flex items-center gap-2.5">
          <div className="relative">
            <div className="w-7 h-7 rounded-lg bg-cyan-500/10 border border-cyan-500/20 flex items-center justify-center">
              <Sparkles className="w-3.5 h-3.5 text-cyan-600 dark:text-cyan-400" />
            </div>
            {runningTasks.length > 0 && (
              <span className="absolute -top-0.5 -right-0.5 w-2 h-2 bg-cyan-400 rounded-full animate-pulse" />
            )}
          </div>
          <div>
            <h3 className="text-[11px] font-semibold text-foreground">
              {t('tasks.pipeline')}
            </h3>
            <p className="text-[9px] text-muted-foreground tabular-nums">
              {totalTasks} {totalTasks === 1 ? 'task' : 'tasks'}
            </p>
          </div>
        </div>

        <button
          onClick={handleLoadHistory}
          disabled={taskHistoryLoading}
          className={cn(
            "p-1.5 rounded-md text-muted-foreground",
            "hover:bg-muted hover:text-foreground transition-colors",
            "disabled:opacity-50 disabled:cursor-not-allowed"
          )}
          title="Load task history"
        >
          <History className={cn("w-3.5 h-3.5", taskHistoryLoading && "animate-spin")} />
        </button>
      </div>

      {/* Columns */}
      <div className="flex-1 overflow-hidden p-2">
        <div className="h-full grid grid-cols-2 gap-2">
          <TaskColumn
            label={t('tasks.active')}
            icon={<Play className="w-3 h-3" />}
            count={runningTasks.length}
            color="cyan"
            tasks={runningTasks}
            formatDuration={formatDuration}
            onAbort={handleAbort}
            onSelect={setSelectedTask}
            onNavigate={handleNavigateToSession}
            parentSessionKey={sessionKey}
          />
          <TaskColumn
            label={t('tasks.completed')}
            icon={<CheckCircle2 className="w-3 h-3" />}
            count={completedTasks.length}
            color="emerald"
            tasks={completedTasks}
            formatDuration={formatDuration}
            onSelect={setSelectedTask}
            onNavigate={handleNavigateToSession}
            parentSessionKey={sessionKey}
          />
        </div>
      </div>

      {selectedTask && (
        <TaskDetailModal task={selectedTask} onClose={() => setSelectedTask(null)} />
      )}
    </div>
  );
}

// ── Column ──────────────────────────────────────────────

interface TaskColumnProps {
  label: string;
  icon: React.ReactNode;
  count: number;
  color: 'amber' | 'cyan' | 'emerald' | 'rose';
  tasks: Task[];
  formatDuration: (s: number, e?: number) => string;
  onAbort?: (runId: string) => void;
  onSelect: (task: Task) => void;
  onNavigate?: (task: Task) => void;
  parentSessionKey: string;
}

const colStyles = {
  amber:   { text: 'text-amber-600 dark:text-amber-400',   badge: 'bg-amber-500/10 text-amber-700 dark:text-amber-300 border-amber-500/30', accent: 'bg-amber-500',   border: 'border-l-amber-400',   progress: '' },
  cyan:    { text: 'text-cyan-600 dark:text-cyan-400',    badge: 'bg-cyan-500/10 text-cyan-700 dark:text-cyan-300 border-cyan-500/30', accent: 'bg-cyan-500',    border: 'border-l-cyan-400',    progress: 'from-cyan-400 via-blue-500 to-cyan-400' },
  emerald: { text: 'text-emerald-600 dark:text-emerald-400', badge: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border-emerald-500/30', accent: 'bg-emerald-500', border: 'border-l-emerald-400', progress: '' },
  rose:    { text: 'text-rose-600 dark:text-rose-400',    badge: 'bg-rose-500/10 text-rose-700 dark:text-rose-300 border-rose-500/30', accent: 'bg-rose-500',    border: 'border-l-rose-400',    progress: '' },
};

function TaskColumn({ label, icon, count, color, tasks, formatDuration, onAbort, onSelect, onNavigate, parentSessionKey }: TaskColumnProps) {
  const s = colStyles[color];

  return (
    <div className="flex flex-col rounded-lg border border-border overflow-hidden bg-muted/30">
      {/* Column header */}
      <div className="px-2.5 py-1.5 border-b border-border flex items-center gap-1.5 shrink-0 whitespace-nowrap bg-muted/40">
        <span className={cn("shrink-0", s.text)}>{icon}</span>
        <span className={cn("text-[10px] font-semibold truncate", s.text)}>{label}</span>
        <span className={cn("text-[10px] px-1.5 py-0.5 rounded border font-bold tabular-nums shrink-0 ml-auto", s.badge)}>
          {count}
        </span>
      </div>

      {/* Tasks list */}
      <div className="flex-1 overflow-y-auto p-1.5 space-y-1 custom-scrollbar">
        {tasks.length === 0 ? (
          <div className="flex items-center justify-center py-6">
            <span className="text-[10px] text-muted-foreground/40">—</span>
          </div>
        ) : (
          tasks.map(task => (
            <MiniTaskCard
              key={task.id}
              task={task}
              color={color}
              formatDuration={formatDuration}
              onAbort={onAbort}
              onSelect={onSelect}
              onNavigate={onNavigate}
              isSubAgent={!!task.sessionKey && task.sessionKey !== parentSessionKey}
            />
          ))
        )}
      </div>
    </div>
  );
}

// ── Card ──────────────────────────────────────────────

interface MiniTaskCardProps {
  task: Task;
  color: 'amber' | 'cyan' | 'emerald' | 'rose';
  formatDuration: (s: number, e?: number) => string;
  onAbort?: (runId: string) => void;
  onSelect: (task: Task) => void;
  onNavigate?: (task: Task) => void;
  isSubAgent: boolean;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function MiniTaskCard({ task, color, formatDuration, onAbort, onSelect, onNavigate, isSubAgent }: MiniTaskCardProps) {
  const s = colStyles[color];
  const duration = formatDuration(task.startedAt, task.completedAt);
  const isToolTask = !!task.toolName;
  const tokens = (task.inputTokens || 0) + (task.outputTokens || 0);

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onSelect(task)}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(task); } }}
      className={cn(
        "group w-full text-left p-2 rounded-md bg-card border border-l-2 transition-all duration-150 cursor-pointer",
        "hover:bg-muted/60 hover:shadow-sm",
        s.border
      )}
    >
      {/* Top: label + runId */}
      <div className="flex items-center gap-1.5 mb-1">
        {isToolTask ? (
          <Wrench className={cn("w-2.5 h-2.5 shrink-0", s.text)} />
        ) : (
          <Zap className={cn("w-2.5 h-2.5 shrink-0", s.text)} />
        )}
        <span className="text-[10px] font-medium text-foreground truncate">
          {task.toolName || task.runId?.slice(0, 12) || task.id.slice(0, 12)}
        </span>
        {task.status === 'running' && onAbort && (
          <button
            onClick={(e) => { e.stopPropagation(); onAbort(task.runId); }}
            className="opacity-0 group-hover:opacity-100 ml-auto p-0.5 rounded hover:bg-rose-500/20 text-muted-foreground hover:text-rose-500 transition-all shrink-0"
            title="Abort"
          >
            <X className="w-2.5 h-2.5" />
          </button>
        )}
        {task.status === 'error' && (
          <span className="ml-auto text-[8px] font-semibold px-1 py-px rounded bg-rose-500/10 text-rose-500 shrink-0">error</span>
        )}
        {task.status === 'aborted' && (
          <span className="ml-auto text-[8px] font-semibold px-1 py-px rounded bg-muted text-muted-foreground shrink-0">aborted</span>
        )}
      </div>

      {/* Bottom: metrics */}
      <div className="flex items-center gap-2 text-[9px] text-muted-foreground">
        <span className="flex items-center gap-0.5 tabular-nums">
          <Clock className="w-2 h-2" />
          {duration}
        </span>
        {tokens > 0 && (
          <span className="tabular-nums">{formatTokens(tokens)}</span>
        )}
        {task.toolCalls != null && task.toolCalls > 0 && (
          <span className="flex items-center gap-0.5 tabular-nums">
            <Terminal className="w-2 h-2" />
            {task.toolCalls}
          </span>
        )}
        {task.status === 'completed' && task.completedAt && (
          <span className="ml-auto text-[8px]">
            {formatDistanceToNow(task.completedAt, { addSuffix: true })}
          </span>
        )}
      </div>

      {/* Running indicator */}
      {task.status === 'running' && (
        <div className="mt-1.5 h-0.5 bg-muted rounded-full overflow-hidden">
          <div
            className={cn("h-full rounded-full bg-gradient-to-r", s.progress)}
            style={{ backgroundSize: '200% 100%', animation: 'shimmer 2s linear infinite' }}
          />
        </div>
      )}

      {/* Error preview */}
      {task.error && (
        <p className="text-[8px] text-rose-500/70 truncate mt-1" title={task.error}>
          {task.error}
        </p>
      )}

      {/* Sub-agent session link */}
      {isSubAgent && onNavigate && (
        <button
          onClick={(e) => { e.stopPropagation(); onNavigate(task); }}
          className="mt-1.5 flex items-center gap-1 text-[8px] text-cyan-600 dark:text-cyan-400 hover:text-cyan-500 transition-colors"
          title="Open sub-agent session"
        >
          <ExternalLink className="w-2 h-2" />
          <span>sub-agent session</span>
        </button>
      )}
    </div>
  );
}
