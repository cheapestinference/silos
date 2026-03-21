import { Clock, Play, Pause, Timer } from 'lucide-react';
import { cn, formatTimestamp } from '../../lib/utils';
import { useTranslation } from '../../i18n';
import type { CronJob } from '../../types/openclaw';

interface CronStatsWidgetProps {
  jobs: CronJob[];
  onViewAll?: () => void;
  className?: string;
}

export function CronStatsWidget({ jobs, onViewAll, className }: CronStatsWidgetProps) {
  const { t } = useTranslation();
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
        'w-full text-left p-4 rounded-xl border border-border bg-card/20 hover:bg-muted/20 hover:border-border transition-all group',
        className
      )}
    >
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Clock className="w-4 h-4 text-cyan-600 dark:text-cyan-400" />
          <h4 className="text-sm font-semibold text-foreground">{t('cron.scheduledJobs')}</h4>
        </div>
        {onViewAll && (
          <span className="text-xs text-muted-foreground group-hover:text-foreground transition-colors">
            {t('cron.viewAll')} &rarr;
          </span>
        )}
      </div>

      <div className="flex items-center gap-4">
        {/* Total */}
        <div className="flex items-center gap-1.5">
          <span className="text-lg font-bold text-foreground">{totalJobs}</span>
          <span className="text-xs text-muted-foreground">{t('cron.jobs')}</span>
        </div>

        <span className="w-px h-4 bg-border" />

        {/* Active */}
        <div className="flex items-center gap-1.5">
          <Play className="w-3 h-3 text-emerald-600 dark:text-emerald-400" />
          <span className="text-sm font-medium text-emerald-600 dark:text-emerald-400">{activeJobs}</span>
          <span className="text-xs text-muted-foreground">{t('cron.active')}</span>
        </div>

        {/* Paused */}
        {pausedJobs > 0 && (
          <>
            <span className="w-px h-4 bg-border" />
            <div className="flex items-center gap-1.5">
              <Pause className="w-3 h-3 text-muted-foreground" />
              <span className="text-sm font-medium text-muted-foreground">{pausedJobs}</span>
              <span className="text-xs text-muted-foreground">{t('cron.paused')}</span>
            </div>
          </>
        )}

        {/* Running indicator */}
        {runningCount > 0 && (
          <>
            <span className="w-px h-4 bg-border" />
            <div className="flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-blue-500 animate-pulse" />
              <span className="text-sm font-medium text-blue-500 dark:text-blue-400">{runningCount}</span>
              <span className="text-xs text-muted-foreground">{t('cron.running')}</span>
            </div>
          </>
        )}
      </div>

      {/* Next Run */}
      {nextRun && (
        <div className="mt-3 pt-3 border-t border-border flex items-center gap-1.5">
          <Timer className="w-3 h-3 text-muted-foreground" />
          <span className="text-xs text-muted-foreground">{t('cron.next')}</span>
          <span className="text-xs text-muted-foreground">{formatTimestamp(nextRun)}</span>
        </div>
      )}
    </button>
  );
}
