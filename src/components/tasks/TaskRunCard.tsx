import { Clock, Loader2, CheckCircle, XCircle, Ban, Skull, Timer, Bot, Terminal, CalendarClock, Plug } from 'lucide-react';
import type { TaskRun } from '../../types/tasks';
import { taskRunStatusConfig } from '../../types/tasks';

interface TaskRunCardProps {
  task: TaskRun;
  compact?: boolean;
  onClick: () => void;
}

function StatusIcon({ status }: { status: TaskRun['status'] }) {
  const cls = "w-3.5 h-3.5";
  switch (status) {
    case 'queued':    return <Clock className={`${cls} text-gray-400`} />;
    case 'running':   return <Loader2 className={`${cls} text-blue-500 animate-spin`} />;
    case 'succeeded': return <CheckCircle className={`${cls} text-emerald-500`} />;
    case 'failed':    return <XCircle className={`${cls} text-red-500`} />;
    case 'timed_out': return <Timer className={`${cls} text-orange-500`} />;
    case 'cancelled': return <Ban className={`${cls} text-gray-500`} />;
    case 'lost':      return <Skull className={`${cls} text-gray-600`} />;
    default:          return <Clock className={`${cls} text-gray-400`} />;
  }
}

const runtimeIcons: Record<string, React.ElementType> = {
  subagent: Bot,
  cron: CalendarClock,
  cli: Terminal,
  acp: Plug,
};

function formatDuration(startMs?: number, endMs?: number) {
  if (!startMs) return '';
  const ms = (endMs || Date.now()) - startMs;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function timeAgo(ts: number) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function TaskRunCard({ task, compact, onClick }: TaskRunCardProps) {
  const status = taskRunStatusConfig[task.status];
  const RuntimeIcon = runtimeIcons[task.runtime] || Terminal;
  const isActive = task.status === 'running';

  return (
    <button
      onClick={onClick}
      className={`w-full text-left p-3 rounded-lg border transition-all ${
        isActive
          ? 'border-blue-500/30 bg-blue-500/5 hover:bg-blue-500/10 shadow-sm shadow-blue-500/10'
          : 'border-border bg-card hover:bg-muted/40'
      }`}
    >
      <div className="flex items-center gap-2">
        {isActive && (
          <span className="relative flex h-2 w-2 shrink-0">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75" />
            <span className="relative inline-flex rounded-full h-2 w-2 bg-blue-500" />
          </span>
        )}
        {!isActive && <StatusIcon status={task.status} />}
        <span className="text-xs font-medium text-foreground truncate flex-1">
          {task.label || task.taskId.slice(0, 12)}
        </span>
        <RuntimeIcon className="w-3 h-3 text-muted-foreground shrink-0" />
      </div>

      {!compact && (
        <>
          {task.agentId && (
            <p className="text-[10px] text-muted-foreground mt-1 truncate">{task.agentId}</p>
          )}

          {task.progressSummary && isActive && (
            <p className="text-[10px] text-blue-400 mt-1.5 truncate leading-tight">{task.progressSummary}</p>
          )}

          {task.terminalSummary && !isActive && (
            <p className="text-[10px] text-muted-foreground mt-1.5 truncate leading-tight">{task.terminalSummary}</p>
          )}

          <div className="flex items-center gap-2 mt-2 text-[10px] text-muted-foreground">
            {task.startedAt && (
              <span className="tabular-nums">{formatDuration(task.startedAt, task.endedAt)}</span>
            )}
            <span className="ml-auto tabular-nums">{timeAgo(task.createdAt)}</span>
          </div>
        </>
      )}
    </button>
  );
}
