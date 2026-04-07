import { Clock, Loader2, CheckCircle, XCircle, Ban, Skull, Timer } from 'lucide-react';
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

function formatDuration(startMs?: number, endMs?: number) {
  if (!startMs) return '';
  const ms = (endMs || Date.now()) - startMs;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export function TaskRunCard({ task, compact, onClick }: TaskRunCardProps) {
  const status = taskRunStatusConfig[task.status];

  return (
    <button
      onClick={onClick}
      className="w-full text-left p-3 rounded-lg border border-border bg-card hover:bg-muted/40 transition-colors"
    >
      <div className="flex items-center gap-2">
        <StatusIcon status={task.status} />
        <span className="text-xs font-medium text-foreground truncate flex-1">
          {task.label || task.taskId.slice(0, 12)}
        </span>
        {task.runtime !== 'subagent' && (
          <span className="text-[9px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground font-mono">{task.runtime}</span>
        )}
      </div>

      {!compact && (
        <>
          {task.agentId && (
            <p className="text-[10px] text-muted-foreground mt-1 truncate">{task.agentId}</p>
          )}

          {task.progressSummary && task.status === 'running' && (
            <p className="text-[10px] text-blue-500 mt-1 truncate">{task.progressSummary}</p>
          )}

          {task.terminalSummary && task.status !== 'running' && (
            <p className="text-[10px] text-muted-foreground mt-1 truncate">{task.terminalSummary}</p>
          )}

          <div className="flex items-center gap-2 mt-1.5 text-[10px] text-muted-foreground">
            {task.startedAt && (
              <span>{formatDuration(task.startedAt, task.endedAt)}</span>
            )}
          </div>
        </>
      )}
    </button>
  );
}
