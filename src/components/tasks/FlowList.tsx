import { useState } from 'react';
import { Layers, List } from 'lucide-react';
import type { TaskFlow, TaskRun } from '../../types/tasks';
import { FlowCard } from './FlowCard';

interface FlowListProps {
  flows: TaskFlow[];
  tasks: TaskRun[];
  selectedFlowId: string | null;
  onSelectFlow: (flowId: string | null) => void;
  showStandalone: boolean;
  onToggleStandalone: () => void;
}

type FilterKey = 'all' | 'active' | 'completed' | 'failed';

const filters: { key: FilterKey; label: string }[] = [
  { key: 'all',       label: 'All' },
  { key: 'active',    label: 'Active' },
  { key: 'completed', label: 'Done' },
  { key: 'failed',    label: 'Failed' },
];

function filterFlows(flows: TaskFlow[], filter: FilterKey): TaskFlow[] {
  switch (filter) {
    case 'active':    return flows.filter(f => ['queued', 'running', 'waiting', 'blocked'].includes(f.status));
    case 'completed': return flows.filter(f => f.status === 'succeeded');
    case 'failed':    return flows.filter(f => ['failed', 'cancelled', 'lost'].includes(f.status));
    default:          return flows;
  }
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

export function FlowList({ flows, tasks, selectedFlowId, onSelectFlow, showStandalone, onToggleStandalone }: FlowListProps) {
  const [filter, setFilter] = useState<FilterKey>('all');
  const filtered = filterFlows(flows, filter);
  const standaloneCount = tasks.filter(t => !t.parentFlowId).length;

  return (
    <div className="flex flex-col h-full">
      {/* Filter chips */}
      <div className="flex gap-1 px-3 py-2 border-b border-border overflow-x-auto">
        {filters.map(f => (
          <button
            key={f.key}
            onClick={() => setFilter(f.key)}
            className={`px-2.5 py-1 rounded-full text-[10px] font-medium transition-colors whitespace-nowrap ${
              filter === f.key
                ? 'bg-primary text-primary-foreground'
                : 'bg-muted text-muted-foreground hover:text-foreground'
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      {/* Flow cards */}
      <div className="flex-1 overflow-y-auto p-3 space-y-2">
        {filtered.length === 0 && (
          <div className="py-8 text-center">
            <Layers className="w-5 h-5 text-muted-foreground/40 mx-auto mb-2" />
            <p className="text-xs text-muted-foreground">No flows</p>
          </div>
        )}

        {filtered.map(flow => (
          <FlowCard
            key={flow.flowId}
            flow={flow}
            selected={selectedFlowId === flow.flowId}
            taskCounts={computeTaskCounts(flow.flowId, tasks)}
            onClick={() => onSelectFlow(selectedFlowId === flow.flowId ? null : flow.flowId)}
          />
        ))}

        {/* Separator + Standalone tasks */}
        {standaloneCount > 0 && (
          <>
            <div className="border-t border-border my-2" />
            <button
              onClick={onToggleStandalone}
              className={`w-full text-left p-3 rounded-lg border transition-colors ${
                showStandalone
                  ? 'border-primary bg-primary/5'
                  : 'border-border bg-card hover:bg-muted/40'
              }`}
            >
              <div className="flex items-center gap-2">
                <List className="w-3.5 h-3.5 text-muted-foreground" />
                <span className="text-xs font-medium text-foreground">Standalone Tasks</span>
                <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground tabular-nums ml-auto">
                  {standaloneCount}
                </span>
              </div>
            </button>
          </>
        )}
      </div>
    </div>
  );
}
