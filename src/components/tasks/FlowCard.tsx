import { Pause, Lock, ExternalLink } from 'lucide-react';
import type { TaskFlow } from '../../types/tasks';
import { taskFlowStatusConfig } from '../../types/tasks';

interface FlowCardProps {
  flow: TaskFlow;
  selected: boolean;
  taskCounts?: { total: number; succeeded: number; running: number; failed: number; queued: number; other: number };
  onClick: () => void;
  onInspect?: () => void;
}

function MiniProgressBar({ counts }: { counts: FlowCardProps['taskCounts'] }) {
  if (!counts || counts.total === 0) return null;
  const segments = [
    { count: counts.succeeded, color: 'bg-emerald-500' },
    { count: counts.running,   color: 'bg-blue-500' },
    { count: counts.queued,    color: 'bg-gray-400' },
    { count: counts.failed,    color: 'bg-red-500' },
    { count: counts.other,     color: 'bg-orange-400' },
  ].filter(s => s.count > 0);

  return (
    <div className="flex h-1.5 rounded-full overflow-hidden bg-muted mt-2">
      {segments.map((seg, i) => (
        <div key={i} className={seg.color} style={{ width: `${(seg.count / counts.total) * 100}%` }} />
      ))}
    </div>
  );
}

function timeAgo(ts: number) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function FlowCard({ flow, selected, taskCounts, onClick, onInspect }: FlowCardProps) {
  const status = taskFlowStatusConfig[flow.status] || taskFlowStatusConfig.queued;
  const isWaiting = flow.status === 'waiting' || flow.status === 'blocked';

  return (
    <div
      onClick={onClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onClick(); }}
      className={`relative w-full text-left p-3 rounded-lg border transition-colors cursor-pointer ${
        selected
          ? 'border-primary bg-primary/5'
          : 'border-border bg-card hover:bg-muted/40'
      }`}
    >
      <div className="flex items-center gap-2">
        <span className={`w-2 h-2 rounded-full shrink-0 ${status.bg.replace('/15', '')}`} />
        <span className="text-xs font-medium text-foreground truncate flex-1">
          {flow.goal || flow.flowId.slice(0, 16)}
        </span>
        {onInspect && (
          <button
            onClick={(e) => { e.stopPropagation(); onInspect(); }}
            className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium bg-muted text-muted-foreground hover:bg-primary/10 hover:text-primary border border-border hover:border-primary/30 transition-colors shrink-0"
            title="Open details"
            type="button"
          >
            Details <ExternalLink className="w-2.5 h-2.5" />
          </button>
        )}
      </div>

      {flow.currentStep && (
        <p className="text-[10px] text-muted-foreground mt-1 truncate ml-4">{flow.currentStep}</p>
      )}

      {isWaiting && flow.blockedSummary && (
        <div className="flex items-center gap-1 mt-1.5 ml-4">
          {flow.status === 'blocked' ? <Lock className="w-3 h-3 text-amber-500" /> : <Pause className="w-3 h-3 text-amber-500" />}
          <span className="text-[10px] text-amber-600 dark:text-amber-400 truncate">{flow.blockedSummary}</span>
        </div>
      )}

      <MiniProgressBar counts={taskCounts} />

      <p className="text-[10px] text-muted-foreground mt-1.5 ml-4">
        {timeAgo(flow.updatedAt || flow.createdAt)}
      </p>
    </div>
  );
}
