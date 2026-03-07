import { useDashboardStore } from '../../store/dashboard-store';
import { useTranslation } from '../../i18n';
import { cn } from '../../lib/utils';
import {
  CheckCircle2,
  XCircle,
  Loader2,
  Clock,
  Cpu,
  Zap,
  AlertTriangle,
  Ban,
  History,
} from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { es, enUS } from 'date-fns/locale';

export function SessionTasksPanel() {
  const { tasks, selectedSessionKey, abortTask, loadTaskHistory, taskHistoryLoading } = useDashboardStore();
  const { t, locale } = useTranslation();

  // Filter tasks for current session
  const sessionTasks = selectedSessionKey
    ? tasks.filter(task => task.sessionKey === selectedSessionKey)
    : [];

  const runningTasks = sessionTasks.filter(t => t.status === 'running');
  const completedTasks = sessionTasks.filter(t => t.status === 'completed');
  const failedTasks = sessionTasks.filter(t => t.status === 'error' || t.status === 'aborted');

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'running':
        return <Loader2 className="w-3 h-3 animate-spin text-blue-500" />;
      case 'completed':
        return <CheckCircle2 className="w-3 h-3 text-green-500" />;
      case 'error':
        return <XCircle className="w-3 h-3 text-red-500" />;
      case 'aborted':
        return <Ban className="w-3 h-3 text-orange-500" />;
      default:
        return <Clock className="w-3 h-3 text-gray-400" />;
    }
  };

  const handleAbort = async (runId: string) => {
    try {
      await abortTask(runId);
    } catch (err) {
      console.error('Failed to abort task:', err);
    }
  };

  if (!selectedSessionKey) {
    return (
      <aside className="w-64 border-l bg-card flex items-center justify-center">
        <div className="text-center px-4">
          <Cpu className="w-8 h-8 text-muted-foreground mx-auto mb-2 opacity-30" />
          <p className="text-xs text-muted-foreground">
            {t('sessions.selectSession')}
          </p>
        </div>
      </aside>
    );
  }

  return (
    <aside className="w-64 border-l bg-card flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="px-3 py-2.5 border-b bg-muted/30">
        <div className="flex items-center gap-2">
          <Zap className="w-3.5 h-3.5 text-muted-foreground" />
          <h3 className="text-xs font-semibold text-foreground/90">
            {t('tasks.pipeline')}
          </h3>
          <div className="ml-auto flex items-center gap-1.5">
            <button
              onClick={() => loadTaskHistory()}
              disabled={taskHistoryLoading}
              className="p-1 rounded hover:bg-muted/50 transition-colors disabled:opacity-50"
              title="Load history"
            >
              <History className={cn("w-3 h-3 text-muted-foreground", taskHistoryLoading && "animate-spin")} />
            </button>
            <span className="text-[10px] font-medium text-muted-foreground tabular-nums">
              {sessionTasks.length}
            </span>
          </div>
        </div>
      </div>

      {/* Stats */}
      {sessionTasks.length > 0 && (
        <div className="px-3 py-2 border-b grid grid-cols-3 gap-1.5">
          <div className="text-center">
            <div className="text-sm font-semibold text-blue-600 dark:text-blue-400 tabular-nums">
              {runningTasks.length}
            </div>
            <div className="text-[9px] text-muted-foreground uppercase tracking-wide">
              {t('tasks.status.running')}
            </div>
          </div>
          <div className="text-center">
            <div className="text-sm font-semibold text-green-600 dark:text-green-400 tabular-nums">
              {completedTasks.length}
            </div>
            <div className="text-[9px] text-muted-foreground uppercase tracking-wide">
              {t('agentDetail.done')}
            </div>
          </div>
          <div className="text-center">
            <div className="text-sm font-semibold text-red-600 dark:text-red-400 tabular-nums">
              {failedTasks.length}
            </div>
            <div className="text-[9px] text-muted-foreground uppercase tracking-wide">
              {t('agentDetail.failed')}
            </div>
          </div>
        </div>
      )}

      {/* Task List */}
      <div className="flex-1 overflow-y-auto">
        {sessionTasks.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full px-4 text-center">
            <Clock className="w-6 h-6 text-muted-foreground/40 mb-2" />
            <p className="text-xs text-muted-foreground">
              {t('tasks.noTasks')}
            </p>
          </div>
        ) : (
          <div className="divide-y">
            {sessionTasks.map(task => (
              <div
                key={task.id}
                className={cn(
                  "px-3 py-2 hover:bg-muted/30 transition-colors",
                  task.status === 'running' && "bg-blue-50/50 dark:bg-blue-950/20"
                )}
              >
                {/* Task Header */}
                <div className="flex items-start gap-2 mb-1">
                  <div className="mt-0.5 shrink-0">
                    {getStatusIcon(task.status)}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className="text-xs font-medium mono text-foreground/80 truncate">
                        {task.runId.slice(0, 8)}
                      </span>
                      {task.status === 'running' && (
                        <button
                          onClick={() => handleAbort(task.runId)}
                          className="ml-auto text-[9px] px-1.5 py-0.5 rounded bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400 hover:bg-red-200 dark:hover:bg-red-900/50 transition-colors"
                        >
                          {t('chat.abort')}
                        </button>
                      )}
                    </div>
                    {task.agentId && (
                      <div className="text-[10px] text-muted-foreground truncate">
                        {task.agentId}
                      </div>
                    )}
                  </div>
                </div>

                {/* Task Metadata */}
                <div className="ml-5 space-y-0.5">
                  {/* Timing */}
                  <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
                    <Clock className="w-2.5 h-2.5" />
                    <span>
                      {formatDistanceToNow(task.startedAt, {
                        addSuffix: true,
                        locale: locale === 'es' ? es : enUS,
                      })}
                    </span>
                    {task.completedAt && (
                      <span className="ml-1 tabular-nums">
                        ({Math.round((task.completedAt - task.startedAt) / 1000)}s)
                      </span>
                    )}
                  </div>

                  {/* Tool Calls */}
                  {task.toolCalls !== undefined && task.toolCalls > 0 && (
                    <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
                      <Cpu className="w-2.5 h-2.5" />
                      <span>{task.toolCalls} {t('sessions.toolCall').toLowerCase()}s</span>
                    </div>
                  )}

                  {/* Tokens */}
                  {(task.inputTokens || task.outputTokens) && (
                    <div className="flex items-center gap-1 text-[10px] text-muted-foreground tabular-nums">
                      <Zap className="w-2.5 h-2.5" />
                      <span>
                        {task.inputTokens || 0}↓ {task.outputTokens || 0}↑
                      </span>
                    </div>
                  )}

                  {/* Error */}
                  {task.error && (
                    <div className="flex items-start gap-1 text-[10px] text-red-600 dark:text-red-400 mt-1">
                      <AlertTriangle className="w-2.5 h-2.5 mt-0.5 shrink-0" />
                      <span className="line-clamp-2">{task.error}</span>
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </aside>
  );
}
