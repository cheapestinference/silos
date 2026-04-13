import { useState, useEffect, useCallback } from 'react';
import { useDashboardStore } from '../../store/dashboard-store';
import { cn } from '../../lib/utils';
import { useTranslation } from '../../i18n';
import { Sparkles, History } from 'lucide-react';
import type { Task } from '../../types/openclaw';
import type { TaskRun, TaskRunStatus, TaskRuntime } from '../../types/tasks';
import { inferRuntime } from '../../types/tasks';
import { TaskKanban } from '../tasks/TaskKanban';
import { DetailDrawer } from '../tasks/DetailDrawer';
import { TaskRunDetail } from '../tasks/TaskRunDetail';

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

function taskToTaskRun(task: Task): TaskRun {
  const base: TaskRun = {
    taskId: task.id,
    runtime: 'subagent' as TaskRuntime,
    sourceId: '',
    ownerKey: '',
    childSessionKey: task.sessionKey,
    agentId: task.agentId,
    runId: task.runId,
    label: task.toolName || undefined,
    status: task.status as TaskRunStatus,
    createdAt: task.startedAt,
    startedAt: task.startedAt,
    endedAt: task.completedAt,
    error: task.error,
  };
  return { ...base, runtime: inferRuntime(base) };
}

export function SessionTasksKanban({ sessionKey }: SessionTasksKanbanProps) {
  const { t } = useTranslation();
  const { tasks, loadTaskHistory, taskHistoryLoading, selectSession } = useDashboardStore();
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

  // Fetch history from API and cache results
  const handleLoadHistory = useCallback(async () => {
    await loadTaskHistory();
    // After loading, the store's tasks are updated — the useEffect above will persist to localStorage
  }, [loadTaskHistory]);

  const runningTasks = sessionTasks.filter(t => t.status === 'running');
  const totalTasks = sessionTasks.length;

  return (
    <div className="h-full flex flex-col bg-background overflow-hidden">
      {/* Header */}
      <div className="relative px-4 py-2.5 border-b flex items-center justify-between shrink-0">
        <div className="flex items-center gap-2.5">
          <div className="relative">
            <div className="w-7 h-7 rounded-lg bg-muted dark:bg-muted border border-border flex items-center justify-center">
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
            <p className="text-[10px] text-muted-foreground tabular-nums">
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

      {/* Kanban */}
      <div className="flex-1 overflow-hidden p-2">
        <TaskKanban
          tasks={sessionTasks.map(taskToTaskRun)}
          compact
          vertical
          onTaskClick={(taskRun) => {
            const original = sessionTasks.find(t => t.id === taskRun.taskId);
            if (original) setSelectedTask(original);
          }}
        />
      </div>

      <DetailDrawer
        open={selectedTask !== null}
        onClose={() => setSelectedTask(null)}
        title="Task Run"
        subtitle={selectedTask?.toolName || selectedTask?.runId?.slice(0, 12)}
      >
        {selectedTask && (
          <TaskRunDetail
            task={taskToTaskRun(selectedTask)}
            onNavigateToSession={(key) => {
              setSelectedTask(null);
              selectSession(key);
            }}
            onClose={() => setSelectedTask(null)}
          />
        )}
      </DetailDrawer>
    </div>
  );
}
