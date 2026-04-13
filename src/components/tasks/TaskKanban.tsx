import { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import type { TaskRun } from '../../types/tasks';
import { TaskRunCard } from './TaskRunCard';

interface TaskKanbanProps {
  tasks: TaskRun[];
  compact?: boolean;
  vertical?: boolean;
  onTaskClick: (task: TaskRun) => void;
}

type ColumnDef = {
  key: string;
  label: string;
  headerColor: string;
  dotColor: string;
  statuses: TaskRun['status'][];
  defaultOpen?: boolean;
};

const columns: ColumnDef[] = [
  { key: 'queued',  label: 'Queued',            headerColor: 'text-gray-500',    dotColor: 'bg-gray-400',    statuses: ['queued'] },
  { key: 'running', label: 'Running',           headerColor: 'text-blue-500',    dotColor: 'bg-blue-500',    statuses: ['running'], defaultOpen: true },
  { key: 'waiting', label: 'Waiting / Blocked', headerColor: 'text-amber-500',   dotColor: 'bg-amber-500',   statuses: [] },
  { key: 'done',    label: 'Done',              headerColor: 'text-emerald-500', dotColor: 'bg-emerald-500', statuses: ['succeeded', 'failed', 'timed_out', 'cancelled', 'lost'] },
];

// ── Vertical accordion layout (session sidebar) ──────────────

function VerticalKanban({ tasks, compact, onTaskClick }: Omit<TaskKanbanProps, 'vertical'>) {
  const grouped = columns.map(col => ({
    ...col,
    tasks: tasks.filter(t => col.statuses.includes(t.status)),
  }));

  // Only one row expanded at a time (accordion). Null = all collapsed.
  // Persisted in localStorage so the choice survives navigation.
  const STORAGE_KEY = 'kanban-expanded-section';
  const [expanded, setExpanded] = useState<string | null>(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      // Accept only a valid column key string; reject legacy record-shaped data
      if (columns.some(c => c.key === raw)) return raw;
      return null;
    } catch { return null; }
  });

  const isOpen = (key: string): boolean => expanded === key;

  const toggle = (key: string) => {
    setExpanded(prev => {
      const next = prev === key ? null : key;
      try {
        if (next) localStorage.setItem(STORAGE_KEY, next);
        else localStorage.removeItem(STORAGE_KEY);
      } catch { /* quota — ignore */ }
      return next;
    });
  };

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {grouped.map(col => {
        const hasTasks = col.tasks.length > 0;
        const open = isOpen(col.key);

        return (
          <div
            key={col.key}
            className="flex flex-col min-h-0"
            style={{
              flex: open && hasTasks ? '1 1 0%' : '0 0 auto',
            }}
          >
            {/* Section header — always visible */}
            <button
              onClick={() => toggle(col.key)}
              className="flex items-center gap-1.5 px-2 py-1.5 shrink-0 hover:bg-muted/40 transition-colors rounded-md mx-1"
            >
              {open
                ? <ChevronDown className={`w-3 h-3 ${col.headerColor}`} />
                : <ChevronRight className={`w-3 h-3 ${col.headerColor}`} />
              }
              <span className={`w-1.5 h-1.5 rounded-full ${col.dotColor}`} />
              <span className={`text-[10px] font-semibold uppercase tracking-wider ${col.headerColor}`}>
                {col.label}
              </span>
              <span className={`text-[10px] px-1.5 py-0.5 rounded-full tabular-nums ml-auto ${
                hasTasks
                  ? 'bg-muted text-muted-foreground'
                  : 'text-muted-foreground/40'
              }`}>
                {col.tasks.length}
              </span>
            </button>

            {/* Cards */}
            {open && hasTasks && (
              <div className="flex-1 min-h-0 overflow-y-auto space-y-1 px-1 pb-1">
                {col.tasks.map(task => (
                  <TaskRunCard
                    key={task.taskId}
                    task={task}
                    compact={compact}
                    onClick={() => onTaskClick(task)}
                  />
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── Horizontal columns layout (/tasks page) ──────────────

function HorizontalKanban({ tasks, compact, onTaskClick }: Omit<TaskKanbanProps, 'vertical'>) {
  const grouped = columns.map(col => ({
    ...col,
    tasks: tasks.filter(t => col.statuses.includes(t.status)),
  }));

  return (
    <div className="grid h-full gap-3 overflow-x-auto" style={{
      gridTemplateColumns: `repeat(${columns.length}, 1fr)`,
    }}>
      {grouped.map(col => (
        <div key={col.key} className="flex flex-col min-w-0 overflow-hidden">
          {/* Scrollable area; header is sticky inside so it stays visible while scrolling cards */}
          <div className="flex-1 overflow-y-auto px-1">
            <div className="sticky top-0 z-10 bg-background flex items-center gap-1.5 px-1 h-8 border-b border-border/60">
              <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${col.dotColor}`} />
              <span className={`text-[10px] font-semibold uppercase tracking-wider ${col.headerColor} truncate`}>
                {col.label}
              </span>
              <span className={`text-[10px] min-w-[20px] text-center px-1.5 py-0.5 rounded-full tabular-nums shrink-0 ${
                col.tasks.length > 0
                  ? 'bg-muted text-muted-foreground'
                  : 'text-muted-foreground/30'
              }`}>
                {col.tasks.length}
              </span>
            </div>
            <div className="space-y-1.5 pt-1.5">
              {col.tasks.map(task => (
                <TaskRunCard
                  key={task.taskId}
                  task={task}
                  compact={compact}
                  onClick={() => onTaskClick(task)}
                />
              ))}
              {col.tasks.length === 0 && (
                <div className="py-8 text-center">
                  <span className="text-[9px] text-muted-foreground/30">—</span>
                </div>
              )}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Main export ──────────────

export function TaskKanban({ vertical, ...props }: TaskKanbanProps) {
  return vertical
    ? <VerticalKanban {...props} />
    : <HorizontalKanban {...props} />;
}
