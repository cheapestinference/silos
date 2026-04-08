import { useState, useEffect, useCallback, useMemo } from 'react';
import { RefreshCw, Loader2, Inbox, Search } from 'lucide-react';
import { fetchTasks, fetchFlows } from '../../lib/tasks-api';
import type { TaskRun, TaskFlow } from '../../types/tasks';
import { FlowList } from '../tasks/FlowList';
import { TaskKanban } from '../tasks/TaskKanban';
import { DetailDrawer } from '../tasks/DetailDrawer';
import { TaskRunDetail } from '../tasks/TaskRunDetail';
import { TaskFlowDetail } from '../tasks/TaskFlowDetail';
import { useNavigate } from 'react-router-dom';
import { useAutoRefresh } from '../../hooks/useAutoRefresh';

type DrawerContent =
  | { type: 'task'; task: TaskRun }
  | { type: 'flow'; flowId: string }
  | null;

export function TasksFlowsPage() {
  const navigate = useNavigate();
  const [tasks, setTasks] = useState<TaskRun[]>([]);
  const [flows, setFlows] = useState<TaskFlow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');

  const [selectedFlowId, setSelectedFlowId] = useState<string | null>(null);
  const [showStandalone, setShowStandalone] = useState(false);
  const [drawer, setDrawer] = useState<DrawerContent>(null);

  const loadData = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    setError(null);
    try {
      const [tasksData, flowsData] = await Promise.all([fetchTasks(), fetchFlows()]);
      setTasks(tasksData);
      setFlows(flowsData);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  const hasActiveTasks = useMemo(
    () => tasks.some(t => t.status === 'running' || t.status === 'queued'),
    [tasks]
  );
  useAutoRefresh(() => loadData(true), 5000, hasActiveTasks);

  const filteredTasks = useMemo(() => {
    let result = selectedFlowId
      ? tasks.filter(t => t.parentFlowId === selectedFlowId)
      : showStandalone
        ? tasks.filter(t => !t.parentFlowId)
        : tasks;

    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      result = result.filter(t =>
        (t.label || '').toLowerCase().includes(q) ||
        t.taskId.toLowerCase().includes(q) ||
        (t.agentId || '').toLowerCase().includes(q) ||
        t.runtime.toLowerCase().includes(q)
      );
    }

    return result;
  }, [tasks, selectedFlowId, showStandalone, searchQuery]);

  const handleSelectFlow = (flowId: string | null) => {
    setSelectedFlowId(flowId);
    setShowStandalone(false);
  };

  const handleToggleStandalone = () => {
    setShowStandalone(!showStandalone);
    setSelectedFlowId(null);
  };

  const handleTaskClick = (task: TaskRun) => {
    setDrawer({ type: 'task', task });
  };

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-6 py-4 border-b border-border shrink-0">
        <div className="flex items-center gap-3">
          <h1 className="text-lg font-semibold text-foreground">Tasks & Flows</h1>
          {hasActiveTasks && (
            <span className="flex items-center gap-1.5 text-[10px] text-blue-500">
              <span className="relative flex h-1.5 w-1.5">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75" />
                <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-blue-500" />
              </span>
              Auto-refreshing
            </span>
          )}
        </div>

        <div className="flex items-center gap-2">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
            <input
              type="text"
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              placeholder="Search tasks..."
              className="pl-8 pr-3 py-1.5 w-48 bg-muted/50 border border-border rounded-lg text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-primary/50 transition-colors"
            />
          </div>

          <button
            onClick={() => loadData()}
            disabled={loading}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-muted transition-colors disabled:opacity-50"
          >
            {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
            Refresh
          </button>
        </div>
      </div>

      {error && (
        <div className="mx-6 mt-4 p-3 bg-red-500/10 border border-red-500/20 rounded-lg text-xs text-red-500">
          {error}
        </div>
      )}

      <div className="flex-1 flex overflow-hidden">
        <div className="w-72 border-r border-border shrink-0 overflow-hidden flex flex-col">
          <FlowList
            flows={flows}
            tasks={tasks}
            selectedFlowId={selectedFlowId}
            onSelectFlow={handleSelectFlow}
            showStandalone={showStandalone}
            onToggleStandalone={handleToggleStandalone}
          />
        </div>

        <div className="flex-1 p-4 overflow-hidden flex flex-col">
          {loading && tasks.length === 0 ? (
            <div className="flex-1 flex items-center justify-center">
              <Loader2 className="w-5 h-5 text-muted-foreground animate-spin" />
            </div>
          ) : filteredTasks.length === 0 ? (
            <div className="flex-1 flex flex-col items-center justify-center">
              <Inbox className="w-8 h-8 text-muted-foreground/30 mb-2" />
              <p className="text-sm text-muted-foreground">
                {searchQuery ? 'No matching tasks' : selectedFlowId ? 'No tasks in this flow' : 'No tasks yet'}
              </p>
              <p className="text-xs text-muted-foreground/60 mt-1">
                {searchQuery ? 'Try a different search term' : 'Tasks appear here when agents run background work'}
              </p>
            </div>
          ) : (
            <TaskKanban tasks={filteredTasks} onTaskClick={handleTaskClick} />
          )}
        </div>
      </div>

      <DetailDrawer
        open={drawer !== null}
        onClose={() => setDrawer(null)}
        title={drawer?.type === 'task' ? 'Task Run' : drawer?.type === 'flow' ? 'Task Flow' : ''}
        subtitle={drawer?.type === 'task' ? drawer.task.label || drawer.task.taskId : drawer?.type === 'flow' ? drawer.flowId : undefined}
      >
        {drawer?.type === 'task' && (
          <TaskRunDetail
            task={drawer.task}
            onNavigateToFlow={(flowId) => {
              setDrawer(null);
              setSelectedFlowId(flowId);
            }}
            onNavigateToSession={(key) => navigate(`/session/${encodeURIComponent(key)}`)}
          />
        )}
        {drawer?.type === 'flow' && (
          <TaskFlowDetail
            flowId={drawer.flowId}
            onSelectTask={(task) => setDrawer({ type: 'task', task })}
          />
        )}
      </DetailDrawer>
    </div>
  );
}
