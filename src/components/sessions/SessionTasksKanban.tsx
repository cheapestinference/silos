import { useDashboardStore } from '../../store/dashboard-store';
import { cn } from '../../lib/utils';
import {
  CheckCircle2,
  Clock,
  Zap,
  Play,
  AlertTriangle,
  X,
  Bot,
  Terminal,
  ArrowRight,
  Sparkles,
  History,
} from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { useNavigate } from 'react-router-dom';
import type { Task } from '../../types/openclaw';

interface SessionTasksKanbanProps {
  sessionKey: string;
}

export function SessionTasksKanban({ sessionKey }: SessionTasksKanbanProps) {
  const { tasks, abortTask, loadTaskHistory, taskHistoryLoading } = useDashboardStore();
  const navigate = useNavigate();

  // Extract agent ID from sessionKey to match tasks by agent, not exact key
  // Session keys: "agent:main:dm-operator", subagent tasks: "agent:main:subagent:uuid"
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

  // Filter tasks for this agent (not exact sessionKey - subagent tasks have different keys)
  const sessionTasks = tasks.filter(task => {
    // Exact match
    if (task.sessionKey === sessionKey) return true;
    // Agent ID match (catches subagent tasks)
    if (sessionAgentId && task.agentId === sessionAgentId) return true;
    // Also match by extracting from task sessionKey
    if (sessionAgentId) {
      const taskAgentId = extractAgentId(task.sessionKey);
      if (taskAgentId === sessionAgentId) return true;
    }
    return false;
  });

  // Group by status
  const runningTasks = sessionTasks.filter(t => t.status === 'running');
  const completedTasks = sessionTasks.filter(t => t.status === 'completed');
  const failedTasks = sessionTasks.filter(t => t.status === 'error' || t.status === 'aborted');

  const handleAbort = async (runId: string) => {
    try {
      await abortTask(runId);
    } catch (err) {
      console.error('Failed to abort task:', err);
    }
  };

  const formatDuration = (startedAt: number, completedAt?: number) => {
    const end = completedAt || Date.now();
    const durationMs = end - startedAt;
    const seconds = Math.floor(durationMs / 1000);
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;

    if (minutes > 0) {
      return `${minutes}m ${remainingSeconds}s`;
    }
    return `${seconds}s`;
  };

  const totalTasks = sessionTasks.length;

  return (
    <div className="h-full flex flex-col bg-background overflow-hidden">
      {/* Header */}
      <div className="relative px-5 py-3 border-b flex items-center justify-between shrink-0">
        <div className="absolute top-0 left-0 right-0 h-[1px] bg-gradient-to-r from-transparent via-cyan-500/40 to-transparent" />

        <div className="flex items-center gap-3">
          <div className="relative">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-cyan-500/20 to-blue-600/20 border border-cyan-500/20 flex items-center justify-center">
              <Sparkles className="w-4 h-4 text-cyan-400" />
            </div>
            {runningTasks.length > 0 && (
              <span className="absolute -top-1 -right-1 w-3 h-3 bg-cyan-400 rounded-full animate-pulse" />
            )}
          </div>
          <div>
            <h3 className="text-[11px] font-bold text-foreground uppercase tracking-[0.2em]" style={{ fontFamily: 'JetBrains Mono, IBM Plex Mono, monospace' }}>
              Task Pipeline
            </h3>
            <p className="text-[9px] text-muted-foreground font-mono">
              {totalTasks} task{totalTasks !== 1 ? 's' : ''} tracked
            </p>
          </div>
        </div>

        {/* History button */}
        <button
          onClick={() => loadTaskHistory()}
          disabled={taskHistoryLoading}
          className={cn(
            "px-2.5 py-1.5 rounded-md text-[10px] font-mono uppercase tracking-wider",
            "bg-muted border text-muted-foreground",
            "hover:bg-muted/80 hover:text-foreground transition-colors",
            "disabled:opacity-50 disabled:cursor-not-allowed",
            "flex items-center gap-1.5"
          )}
          title="Load task history from gateway"
        >
          <History className={cn("w-3 h-3", taskHistoryLoading && "animate-spin")} />
          History
        </button>
      </div>

      {/* Horizontal Kanban Grid */}
      <div className="flex-1 overflow-hidden p-3">
        <div className="h-full grid grid-cols-3 gap-3">
          {/* Active Column */}
          <KanbanColumn
            title="Active"
            subtitle="In progress"
            icon={<Play className="w-3.5 h-3.5" />}
            count={runningTasks.length}
            color="cyan"
            tasks={runningTasks}
            formatDuration={formatDuration}
            onAbort={handleAbort}
            onNavigate={(sk) => navigate(`/session/${sk}`)}
            emptyIcon={<Terminal className="w-8 h-8" />}
            emptyMessage="No active tasks"
          />

          {/* Completed Column */}
          <KanbanColumn
            title="Completed"
            subtitle="Successfully finished"
            icon={<CheckCircle2 className="w-3.5 h-3.5" />}
            count={completedTasks.length}
            color="emerald"
            tasks={completedTasks}
            formatDuration={formatDuration}
            onNavigate={(sk) => navigate(`/session/${sk}`)}
            emptyIcon={<CheckCircle2 className="w-8 h-8" />}
            emptyMessage="No completed tasks"
          />

          {/* Failed Column */}
          <KanbanColumn
            title="Failed"
            subtitle="Errors & aborted"
            icon={<AlertTriangle className="w-3.5 h-3.5" />}
            count={failedTasks.length}
            color="rose"
            tasks={failedTasks}
            formatDuration={formatDuration}
            onAbort={handleAbort}
            onNavigate={(sk) => navigate(`/session/${sk}`)}
            emptyIcon={<AlertTriangle className="w-8 h-8" />}
            emptyMessage="No failures"
          />
        </div>
      </div>
    </div>
  );
}

// Kanban Column Component
interface KanbanColumnProps {
  title: string;
  subtitle: string;
  icon: React.ReactNode;
  count: number;
  color: 'cyan' | 'emerald' | 'rose';
  tasks: Task[];
  formatDuration: (startedAt: number, completedAt?: number) => string;
  onAbort?: (runId: string) => void;
  onNavigate?: (sessionKey: string) => void;
  emptyIcon: React.ReactNode;
  emptyMessage: string;
}

function KanbanColumn({
  title,
  subtitle,
  icon,
  count,
  color,
  tasks,
  formatDuration,
  onAbort,
  onNavigate,
  emptyIcon,
  emptyMessage
}: KanbanColumnProps) {
  const colorStyles = {
    cyan: {
      headerBg: 'bg-gradient-to-r from-cyan-500/5 to-transparent',
      headerBorder: 'border-cyan-500/20',
      title: 'text-cyan-600 dark:text-cyan-400',
      badge: 'bg-cyan-500/10 text-cyan-700 dark:text-cyan-300 border-cyan-500/30',
      columnBg: 'bg-muted/40',
      accentLine: 'bg-gradient-to-b from-cyan-400 to-cyan-600',
      emptyColor: 'text-cyan-500/30',
    },
    emerald: {
      headerBg: 'bg-gradient-to-r from-emerald-500/5 to-transparent',
      headerBorder: 'border-emerald-500/20',
      title: 'text-emerald-600 dark:text-emerald-400',
      badge: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border-emerald-500/30',
      columnBg: 'bg-muted/40',
      accentLine: 'bg-gradient-to-b from-emerald-400 to-emerald-600',
      emptyColor: 'text-emerald-500/30',
    },
    rose: {
      headerBg: 'bg-gradient-to-r from-rose-500/5 to-transparent',
      headerBorder: 'border-rose-500/20',
      title: 'text-rose-600 dark:text-rose-400',
      badge: 'bg-rose-500/10 text-rose-700 dark:text-rose-300 border-rose-500/30',
      columnBg: 'bg-muted/40',
      accentLine: 'bg-gradient-to-b from-rose-400 to-rose-600',
      emptyColor: 'text-rose-500/30',
    },
  };

  const styles = colorStyles[color];

  return (
    <div className={cn(
      "flex flex-col rounded-xl border overflow-hidden",
      styles.columnBg
    )}>
      {/* Column Header */}
      <div className={cn(
        "relative px-4 py-3 border-b shrink-0",
        styles.headerBg,
        styles.headerBorder
      )}>
        {/* Accent line */}
        <div className={cn("absolute left-0 top-2 bottom-2 w-0.5 rounded-full", styles.accentLine)} />

        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 pl-2">
            <span className={cn("opacity-80", styles.title)}>{icon}</span>
            <div>
              <h4 className={cn(
                "text-[10px] font-bold uppercase tracking-wider",
                styles.title
              )} style={{ fontFamily: 'JetBrains Mono, IBM Plex Mono, monospace' }}>
                {title}
              </h4>
              <p className="text-[8px] text-muted-foreground font-mono">{subtitle}</p>
            </div>
          </div>
          <span className={cn(
            "text-[10px] px-2 py-0.5 rounded-md border font-bold tabular-nums",
            styles.badge
          )}>
            {count}
          </span>
        </div>
      </div>

      {/* Tasks - Scrollable */}
      <div className="flex-1 overflow-y-auto p-2 space-y-2 custom-scrollbar">
        {tasks.length === 0 ? (
          <div className="h-full min-h-[120px] flex flex-col items-center justify-center">
            <span className={cn("mb-2 opacity-30", styles.emptyColor)}>
              {emptyIcon}
            </span>
            <p className="text-[10px] text-muted-foreground font-mono">{emptyMessage}</p>
          </div>
        ) : (
          tasks.map(task => (
            <TaskCard
              key={task.id}
              task={task}
              color={color}
              formatDuration={formatDuration}
              onAbort={onAbort}
              onNavigate={onNavigate}
            />
          ))
        )}
      </div>
    </div>
  );
}

// Task Card Component
interface TaskCardProps {
  task: Task;
  color: 'cyan' | 'emerald' | 'rose';
  formatDuration: (startedAt: number, completedAt?: number) => string;
  onAbort?: (runId: string) => void;
  onNavigate?: (sessionKey: string) => void;
}

function TaskCard({ task, color, formatDuration, onAbort, onNavigate }: TaskCardProps) {
  const duration = formatDuration(task.startedAt, task.completedAt);
  const isAgentSpawn = task.agentId && !task.toolCalls && !task.toolName;
  const isToolTask = !!task.toolName;

  // Get badge style based on task type
  const getBadgeStyle = () => {
    if (isAgentSpawn) return 'bg-violet-500/20 text-violet-400 border-violet-500/30';
    if (isToolTask) return 'bg-amber-500/20 text-amber-400 border-amber-500/30';
    return 'bg-blue-500/20 text-blue-400 border-blue-500/30';
  };

  // Get task type label
  const getTaskTypeLabel = () => {
    if (isAgentSpawn) return 'Agent';
    if (isToolTask) return task.toolName;
    return 'Process';
  };

  const cardColors = {
    cyan: {
      border: 'border-l-cyan-400 hover:border-cyan-500/40',
      badge: getBadgeStyle(),
      progress: 'from-cyan-400 via-blue-500 to-cyan-400',
    },
    emerald: {
      border: 'border-l-emerald-400 hover:border-emerald-500/40',
      badge: getBadgeStyle(),
      progress: 'from-emerald-400 to-emerald-600',
    },
    rose: {
      border: 'border-l-rose-400 hover:border-rose-500/40',
      badge: getBadgeStyle(),
      progress: 'from-rose-400 to-rose-600',
    },
  };

  const styles = cardColors[color];

  return (
    <div
      onClick={() => onNavigate?.(task.sessionKey)}
      className={cn(
        "group relative p-3 rounded-lg bg-card border border-l-2 transition-all duration-200",
        "hover:bg-muted/50 hover:shadow-sm",
        onNavigate && "cursor-pointer",
        styles.border
      )}
    >
      {/* Header Row */}
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          {/* Type Badge */}
          <span className={cn(
            "text-[8px] px-1.5 py-0.5 rounded border font-bold uppercase tracking-wider max-w-[100px] truncate",
            styles.badge
          )} title={getTaskTypeLabel()}>
            {getTaskTypeLabel()}
          </span>
          {/* Run ID */}
          <span className="text-[9px] font-mono text-muted-foreground tracking-tight">
            #{task.runId.slice(0, 6)}
          </span>
        </div>

        {/* Abort Button */}
        {task.status === 'running' && onAbort && (
          <button
            onClick={(e) => { e.stopPropagation(); onAbort(task.runId); }}
            className="opacity-0 group-hover:opacity-100 transition-all p-1 rounded-md hover:bg-rose-500/20 text-muted-foreground hover:text-rose-500"
            title="Abort task"
          >
            <X className="w-3 h-3" />
          </button>
        )}
      </div>

      {/* Executor Info */}
      {task.agentId && (
        <div className="flex items-center gap-2 mb-2.5">
          <div className="w-5 h-5 rounded-md bg-gradient-to-br from-violet-500/30 to-purple-600/30 border border-violet-500/30 flex items-center justify-center">
            <Bot className="w-3 h-3 text-violet-400" />
          </div>
          <span className="text-[10px] text-foreground font-medium truncate flex-1">
            {task.agentId}
          </span>
        </div>
      )}

      {/* Metrics Row */}
      <div className="flex items-center gap-3 text-[9px] text-muted-foreground">
        {/* Duration */}
        <div className="flex items-center gap-1">
          <Clock className="w-2.5 h-2.5" />
          <span className="font-mono tabular-nums">{duration}</span>
        </div>

        {/* Tokens */}
        {(task.inputTokens || task.outputTokens) && (
          <div className="flex items-center gap-1">
            <Zap className="w-2.5 h-2.5" />
            <span className="font-mono tabular-nums">
              {task.inputTokens || 0}↓ {task.outputTokens || 0}↑
            </span>
          </div>
        )}

        {/* Tool Calls */}
        {task.toolCalls !== undefined && task.toolCalls > 0 && (
          <div className="flex items-center gap-1">
            <Terminal className="w-2.5 h-2.5" />
            <span className="font-mono tabular-nums">{task.toolCalls}</span>
          </div>
        )}
      </div>

      {/* Running Progress Animation */}
      {task.status === 'running' && (
        <div className="mt-2.5 pt-2 border-t">
          <div className="h-0.5 bg-muted rounded-full overflow-hidden">
            <div
              className={cn(
                "h-full rounded-full bg-gradient-to-r animate-shimmer",
                styles.progress
              )}
              style={{
                backgroundSize: '200% 100%',
                animation: 'shimmer 2s linear infinite'
              }}
            />
          </div>
        </div>
      )}

      {/* Completed Timestamp */}
      {task.status === 'completed' && task.completedAt && (
        <div className="mt-2 pt-2 border-t flex items-center gap-1.5">
          <ArrowRight className="w-2.5 h-2.5 text-emerald-500/60" />
          <p className="text-[9px] text-emerald-400/60 font-mono">
            {formatDistanceToNow(task.completedAt, { addSuffix: true })}
          </p>
        </div>
      )}

      {/* Error Message */}
      {task.error && (
        <div className="mt-2 pt-2 border-t">
          <p className="text-[9px] text-rose-500/80 truncate font-mono" title={task.error}>
            {task.error}
          </p>
        </div>
      )}
    </div>
  );
}
