import { Clock, Play, Pause, Timer } from 'lucide-react';
import { cn, formatTimestamp } from '../../lib/utils';
import type { CronJob } from '../../types/openclaw';

interface CronStatsWidgetProps {
  jobs: CronJob[];
  onViewAll?: () => void;
  className?: string;
}

export function CronStatsWidget({ jobs, onViewAll, className }: CronStatsWidgetProps) {
  const totalJobs = jobs.length;
  const activeJobs = jobs.filter((j) => j.enabled).length;
  const pausedJobs = totalJobs - activeJobs;

  // Find the next scheduled run
  const nextRun = jobs
    .filter((j) => j.enabled && j.state?.nextRunAtMs)
    .map((j) => j.state!.nextRunAtMs!)
    .sort((a, b) => a - b)[0];

  // Find if any are currently running
  const runningCount = jobs.filter((j) => j.state?.runningAtMs).length;

  if (totalJobs === 0) {
    return null;
  }

  return (
    <button
      onClick={onViewAll}
      className={cn(
        'w-full text-left p-4 rounded-xl border border-zinc-800/40 bg-zinc-900/30 hover:bg-zinc-800/30 hover:border-zinc-700/50 transition-all group',
        className
      )}
    >
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Clock className="w-4 h-4 text-cyan-400" />
          <h4 className="text-sm font-semibold text-zinc-100">Scheduled Jobs</h4>
        </div>
        {onViewAll && (
          <span className="text-xs text-zinc-500 group-hover:text-zinc-400 transition-colors">
            View All &rarr;
          </span>
        )}
      </div>

      <div className="flex items-center gap-4">
        {/* Total */}
        <div className="flex items-center gap-1.5">
          <span className="text-lg font-bold text-zinc-200">{totalJobs}</span>
          <span className="text-xs text-zinc-500">jobs</span>
        </div>

        <span className="w-px h-4 bg-zinc-700" />

        {/* Active */}
        <div className="flex items-center gap-1.5">
          <Play className="w-3 h-3 text-emerald-400" />
          <span className="text-sm font-medium text-emerald-400">{activeJobs}</span>
          <span className="text-xs text-zinc-500">active</span>
        </div>

        {/* Paused */}
        {pausedJobs > 0 && (
          <>
            <span className="w-px h-4 bg-zinc-700" />
            <div className="flex items-center gap-1.5">
              <Pause className="w-3 h-3 text-zinc-500" />
              <span className="text-sm font-medium text-zinc-500">{pausedJobs}</span>
              <span className="text-xs text-zinc-600">paused</span>
            </div>
          </>
        )}

        {/* Running indicator */}
        {runningCount > 0 && (
          <>
            <span className="w-px h-4 bg-zinc-700" />
            <div className="flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-blue-500 animate-pulse" />
              <span className="text-sm font-medium text-blue-400">{runningCount}</span>
              <span className="text-xs text-zinc-500">running</span>
            </div>
          </>
        )}
      </div>

      {/* Next Run */}
      {nextRun && (
        <div className="mt-3 pt-3 border-t border-zinc-800/40 flex items-center gap-1.5">
          <Timer className="w-3 h-3 text-zinc-500" />
          <span className="text-xs text-zinc-500">Next:</span>
          <span className="text-xs text-zinc-400">{formatTimestamp(nextRun)}</span>
        </div>
      )}
    </button>
  );
}
