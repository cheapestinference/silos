import { Layers } from 'lucide-react';
import type { TaskFlow, TaskRun } from '../../types/tasks';
import { FlowCard } from './FlowCard';

interface FlowListProps {
  flows: TaskFlow[];
  tasks: TaskRun[];
  selectedFlowId: string | null;
  onSelectFlow: (flowId: string | null) => void;
  /** Opens the flow detail drawer (i icon on each card). */
  onInspectFlow?: (flowId: string) => void;
}

function computeTaskCounts(flowId: string, tasks: TaskRun[]) {
  const flowTasks = tasks.filter(t => t.parentFlowId === flowId);
  return {
    total: flowTasks.length,
    succeeded: flowTasks.filter(t => t.status === 'succeeded').length,
    running: flowTasks.filter(t => t.status === 'running').length,
    failed: flowTasks.filter(t => t.status === 'failed').length,
    queued: flowTasks.filter(t => t.status === 'queued').length,
    other: flowTasks.filter(t => ['timed_out', 'cancelled', 'lost'].includes(t.status)).length,
  };
}

export function FlowList({ flows, tasks, selectedFlowId, onSelectFlow, onInspectFlow }: FlowListProps) {
  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 overflow-y-auto p-3 space-y-2">
        {flows.length === 0 && (
          <div className="py-8 text-center">
            <Layers className="w-5 h-5 text-muted-foreground/40 mx-auto mb-2" />
            <p className="text-xs text-muted-foreground">No flows</p>
          </div>
        )}
        {flows.map(flow => (
          <FlowCard
            key={flow.flowId}
            flow={flow}
            selected={selectedFlowId === flow.flowId}
            taskCounts={computeTaskCounts(flow.flowId, tasks)}
            onClick={() => onSelectFlow(selectedFlowId === flow.flowId ? null : flow.flowId)}
            onInspect={onInspectFlow ? () => onInspectFlow(flow.flowId) : undefined}
          />
        ))}
      </div>
    </div>
  );
}
