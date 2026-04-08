import { useState, useEffect } from 'react';
import { Layers, Clock, ChevronRight, Loader2, AlertTriangle } from 'lucide-react';
import { fetchFlowDetail } from '../../lib/tasks-api';
import type { TaskFlowDetail as TaskFlowDetailType, TaskRun } from '../../types/tasks';
import { taskFlowStatusConfig, taskRunStatusConfig } from '../../types/tasks';
import { FlowTimeline } from './FlowTimeline';

interface TaskFlowDetailProps {
  flowId: string;
  onSelectTask: (task: TaskRun) => void;
}

function ProgressBar({ summary }: { summary: TaskFlowDetailType['taskSummary'] }) {
  if (summary.total === 0) return null;
  const segments = [
    { count: summary.succeeded, color: 'bg-emerald-500' },
    { count: summary.running,   color: 'bg-blue-500' },
    { count: summary.queued,    color: 'bg-gray-400' },
    { count: summary.failed,    color: 'bg-red-500' },
    { count: summary.other,     color: 'bg-orange-400' },
  ].filter(s => s.count > 0);

  return (
    <div className="flex h-2 rounded-full overflow-hidden bg-muted">
      {segments.map((seg, i) => (
        <div key={i} className={`${seg.color} transition-all`} style={{ width: `${(seg.count / summary.total) * 100}%` }} />
      ))}
    </div>
  );
}

export function TaskFlowDetail({ flowId, onSelectTask }: TaskFlowDetailProps) {
  const [flow, setFlow] = useState<TaskFlowDetailType | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    fetchFlowDetail(flowId)
      .then(data => setFlow(data))
      .catch(err => setError(err.message))
      .finally(() => setLoading(false));
  }, [flowId]);

  if (loading) return (
    <div className="flex items-center justify-center py-12 gap-2">
      <Loader2 className="w-4 h-4 text-muted-foreground animate-spin" />
      <span className="text-xs text-muted-foreground">Loading flow...</span>
    </div>
  );

  if (error || !flow) return (
    <div className="p-5">
      <div className="p-3 bg-red-500/10 border border-red-500/20 rounded-lg text-xs text-red-500">
        {error || 'Flow not found'}
      </div>
    </div>
  );

  const status = taskFlowStatusConfig[flow.status] || taskFlowStatusConfig.queued;

  return (
    <div>
      {/* Status & Goal */}
      <div className="px-5 pt-4 pb-2">
        <span className={`inline-flex px-2.5 py-1 rounded-md text-xs font-semibold ${status.color} ${status.bg}`}>
          {status.label}
        </span>
        {flow.goal && <p className="text-sm font-medium text-foreground mt-2">{flow.goal}</p>}
        {flow.currentStep && <p className="text-xs text-muted-foreground mt-1">{flow.currentStep}</p>}
      </div>

      {/* Progress */}
      {flow.taskSummary && (
        <div className="px-5 py-3">
          <ProgressBar summary={flow.taskSummary} />
          <div className="flex gap-3 mt-2 text-[10px] text-muted-foreground">
            <span>{flow.taskSummary.succeeded} succeeded</span>
            <span>{flow.taskSummary.running} running</span>
            <span>{flow.taskSummary.failed} failed</span>
            <span>{flow.taskSummary.total} total</span>
          </div>
        </div>
      )}

      {/* Timeline waterfall */}
      {flow.tasks && flow.tasks.length > 0 && (
        <div className="border-t border-border">
          <FlowTimeline tasks={flow.tasks} />
        </div>
      )}

      {/* Blocked info */}
      {flow.blockedSummary && (flow.status === 'waiting' || flow.status === 'blocked') && (
        <div className="px-5 py-3 mx-5 bg-amber-500/10 border border-amber-500/20 rounded-lg">
          <div className="flex items-center gap-1.5 mb-1">
            <AlertTriangle className="w-3.5 h-3.5 text-amber-500" />
            <p className="text-xs font-medium text-amber-600 dark:text-amber-400">
              {flow.status === 'blocked' ? 'Blocked' : 'Waiting'}
            </p>
          </div>
          <p className="text-sm text-foreground">{flow.blockedSummary}</p>
        </div>
      )}

      {/* Metadata */}
      <div className="px-5 py-2 border-t border-border mt-2">
        <div className="flex items-start gap-3 py-2 text-xs">
          <Layers className="w-3.5 h-3.5 text-muted-foreground mt-0.5" />
          <div>
            <p className="text-[11px] text-muted-foreground">Flow ID</p>
            <p className="font-mono text-foreground">{flow.flowId}</p>
          </div>
        </div>
        <div className="flex items-start gap-3 py-2 text-xs">
          <Clock className="w-3.5 h-3.5 text-muted-foreground mt-0.5" />
          <div>
            <p className="text-[11px] text-muted-foreground">Created</p>
            <p className="text-foreground">{new Date(flow.createdAt).toLocaleString()}</p>
          </div>
        </div>
      </div>

      {/* Child Tasks */}
      <div className="border-t border-border">
        <p className="px-5 py-2 text-xs font-medium text-muted-foreground uppercase tracking-wider">
          Tasks ({flow.tasks?.length || 0})
        </p>
        <div className="px-3 pb-4 space-y-1">
          {(flow.tasks || []).map(task => {
            const ts = taskRunStatusConfig[task.status] || taskRunStatusConfig.queued;
            return (
              <button
                key={task.taskId}
                onClick={() => onSelectTask(task)}
                className="w-full flex items-center gap-2 px-3 py-2 rounded-lg hover:bg-muted/60 transition-colors text-left"
              >
                <span className={`w-2 h-2 rounded-full shrink-0 ${ts.bg.replace('/15', '')}`} />
                <span className="text-xs text-foreground truncate flex-1">{task.label || task.taskId}</span>
                <span className={`text-[10px] ${ts.color}`}>{ts.label}</span>
                <ChevronRight className="w-3 h-3 text-muted-foreground" />
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
