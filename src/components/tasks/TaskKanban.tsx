import type { TaskRun } from '../../types/tasks';
import { TaskRunCard } from './TaskRunCard';

interface TaskKanbanProps {
  tasks: TaskRun[];
  compact?: boolean;
  onTaskClick: (task: TaskRun) => void;
}

type ColumnDef = {
  key: string;
  label: string;
  headerColor: string;
  statuses: TaskRun['status'][];
};

const columns: ColumnDef[] = [
  { key: 'queued',  label: 'Queued',            headerColor: 'text-gray-500',    statuses: ['queued'] },
  { key: 'running', label: 'Running',           headerColor: 'text-blue-500',    statuses: ['running'] },
  { key: 'waiting', label: 'Waiting / Blocked', headerColor: 'text-amber-500',   statuses: [] },
  { key: 'done',    label: 'Done',              headerColor: 'text-emerald-500', statuses: ['succeeded', 'failed', 'timed_out', 'cancelled', 'lost'] },
];

export function TaskKanban({ tasks, compact, onTaskClick }: TaskKanbanProps) {
  const grouped = columns.map(col => ({
    ...col,
    tasks: tasks.filter(t => col.statuses.includes(t.status)),
  }));

  const hasAnyTasks = tasks.length > 0;

  return (
    <div className="flex gap-3 h-full overflow-x-auto">
      {grouped.map(col => (
        <div key={col.key} className="flex-1 min-w-[180px] flex flex-col">
          {/* Column header */}
          <div className="flex items-center gap-2 px-2 py-2">
            <span className={`text-xs font-semibold ${col.headerColor}`}>{col.label}</span>
            {col.tasks.length > 0 && (
              <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground tabular-nums">
                {col.tasks.length}
              </span>
            )}
          </div>

          {/* Cards */}
          <div className="flex-1 overflow-y-auto space-y-2 px-1">
            {col.tasks.map(task => (
              <TaskRunCard
                key={task.taskId}
                task={task}
                compact={compact}
                onClick={() => onTaskClick(task)}
              />
            ))}
            {col.tasks.length === 0 && hasAnyTasks && (
              <div className="py-8 text-center">
                <p className="text-[10px] text-muted-foreground/50">—</p>
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
