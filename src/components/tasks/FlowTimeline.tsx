import type { TaskRun } from '../../types/tasks';
import { taskRunStatusConfig } from '../../types/tasks';

interface FlowTimelineProps {
  tasks: TaskRun[];
}

const statusColors: Record<string, string> = {
  queued: 'bg-gray-400',
  running: 'bg-blue-500',
  succeeded: 'bg-emerald-500',
  failed: 'bg-red-500',
  timed_out: 'bg-orange-500',
  cancelled: 'bg-gray-500',
  lost: 'bg-gray-600',
};

export function FlowTimeline({ tasks }: FlowTimelineProps) {
  if (tasks.length === 0) return null;

  const now = Date.now();
  const allStarts = tasks.map(t => t.startedAt || t.createdAt).filter(Boolean);
  const allEnds = tasks.map(t => t.endedAt || (t.status === 'running' ? now : t.startedAt || t.createdAt)).filter(Boolean);
  const minTime = Math.min(...allStarts);
  const maxTime = Math.max(...allEnds, now);
  const range = maxTime - minTime || 1;

  return (
    <div className="py-3">
      <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-3 px-5">
        Timeline
      </p>
      <div className="space-y-1.5 px-5">
        {tasks.map(task => {
          const start = task.startedAt || task.createdAt;
          const end = task.endedAt || (task.status === 'running' ? now : start);
          const left = ((start - minTime) / range) * 100;
          const width = Math.max(((end - start) / range) * 100, 1.5);
          const color = statusColors[task.status] || 'bg-gray-500';
          const status = taskRunStatusConfig[task.status];

          return (
            <div key={task.taskId} className="flex items-center gap-2 group">
              <span className="text-[10px] text-muted-foreground truncate w-24 shrink-0 text-right font-mono" title={task.label || task.taskId}>
                {task.label || task.taskId.slice(0, 10)}
              </span>

              <div className="flex-1 h-5 relative bg-muted/30 rounded-sm overflow-hidden">
                <div
                  className={`absolute top-0.5 bottom-0.5 rounded-sm ${color} ${
                    task.status === 'running' ? 'animate-pulse' : ''
                  } transition-all`}
                  style={{ left: `${left}%`, width: `${width}%` }}
                  title={`${status?.label || task.status} — ${task.label || task.taskId}`}
                />
              </div>
            </div>
          );
        })}
      </div>

      <div className="flex justify-between px-5 mt-1 ml-28">
        <span className="text-[9px] text-muted-foreground/60 tabular-nums">
          {new Date(minTime).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
        </span>
        <span className="text-[9px] text-muted-foreground/60 tabular-nums">
          {new Date(maxTime).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
        </span>
      </div>
    </div>
  );
}
