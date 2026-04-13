import { useState, useMemo } from 'react';
import { CalendarClock, Clock, CheckCircle2, XCircle, Pause, Play, ExternalLink } from 'lucide-react';
import type { CronJob } from '../../types/openclaw';
import type { TaskRun } from '../../types/tasks';
import { humanizeSchedule } from '../../lib/cron-humanize';
import { useNow } from '../../hooks/useNow';

interface CronListProps {
  jobs: CronJob[];
  tasks: TaskRun[];
  selectedCronId: string | null;
  onSelectCron: (id: string | null) => void;
  onInspectCron?: (id: string) => void;
}

type FilterKey = 'all' | 'enabled' | 'disabled';

const filters: { key: FilterKey; label: string }[] = [
  { key: 'all',      label: 'All' },
  { key: 'enabled',  label: 'Enabled' },
  { key: 'disabled', label: 'Paused' },
];

function filterJobs(jobs: CronJob[], filter: FilterKey): CronJob[] {
  switch (filter) {
    case 'enabled':  return jobs.filter(j => j.enabled);
    case 'disabled': return jobs.filter(j => !j.enabled);
    default:         return jobs;
  }
}

function timeAgoNow(ms: number | undefined, now: number): string {
  if (!ms) return '';
  const diff = now - ms;
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24)  return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

function timeUntilNow(ms: number | undefined, now: number): string {
  if (!ms) return '';
  const diff = ms - now;
  if (diff <= 0) return 'due now';
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return `in ${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `in ${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24)  return `in ${hr}h`;
  return `in ${Math.floor(hr / 24)}d`;
}

function countRuns(jobId: string, tasks: TaskRun[]) {
  const runs = tasks.filter(t => t.runtime === 'cron' && t.sourceId === jobId);
  return {
    total:     runs.length,
    succeeded: runs.filter(t => t.status === 'succeeded').length,
    running:   runs.filter(t => t.status === 'running').length,
    failed:    runs.filter(t => t.status === 'failed').length,
  };
}

export function CronList({ jobs, tasks, selectedCronId, onSelectCron, onInspectCron }: CronListProps) {
  const [filter, setFilter] = useState<FilterKey>('all');
  const filtered = useMemo(() => filterJobs(jobs, filter), [jobs, filter]);
  const now = useNow(1000);

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

      {/* Cron cards */}
      <div className="flex-1 overflow-y-auto p-3 space-y-2">
        {filtered.length === 0 && (
          <div className="py-8 text-center">
            <CalendarClock className="w-5 h-5 text-muted-foreground/40 mx-auto mb-2" />
            <p className="text-xs text-muted-foreground">
              {filter === 'all' ? 'No cron jobs' : `No ${filter} jobs`}
            </p>
          </div>
        )}

        {filtered.map(job => {
          const selected = selectedCronId === job.id;
          const counts = countRuns(job.id, tasks);
          const lastStatus = job.state?.lastStatus;

          return (
            <div
              key={job.id}
              role="button"
              tabIndex={0}
              onClick={() => onSelectCron(selected ? null : job.id)}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onSelectCron(selected ? null : job.id); }}
              className={`relative w-full text-left p-3 rounded-lg border transition-colors cursor-pointer ${
                selected
                  ? 'border-cyan-500/50 bg-cyan-500/5'
                  : 'border-border bg-card hover:bg-muted/40'
              }`}
            >
              <div className="flex items-start gap-2 mb-1">
                <CalendarClock
                  className={`w-3.5 h-3.5 mt-0.5 shrink-0 ${
                    job.enabled ? 'text-cyan-600 dark:text-cyan-400' : 'text-muted-foreground'
                  }`}
                />
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-semibold text-foreground truncate">{job.name}</p>
                  <p className="text-[10px] text-muted-foreground flex items-center gap-1 truncate">
                    <Clock className="w-2.5 h-2.5 shrink-0" />
                    {humanizeSchedule(job.schedule)}
                  </p>
                </div>
                {job.enabled ? (
                  <Play className="w-3 h-3 text-emerald-500 shrink-0" />
                ) : (
                  <Pause className="w-3 h-3 text-muted-foreground shrink-0" />
                )}
              </div>

              {onInspectCron && (
                <button
                  onClick={(e) => { e.stopPropagation(); onInspectCron(job.id); }}
                  className="absolute top-2.5 right-9 inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium bg-muted text-muted-foreground hover:bg-cyan-500/10 hover:text-cyan-600 dark:hover:text-cyan-400 border border-border hover:border-cyan-500/30 transition-colors"
                  title="Open details"
                  type="button"
                >
                  Details <ExternalLink className="w-2.5 h-2.5" />
                </button>
              )}

              <div className="flex items-center gap-2 mt-2 text-[10px]">
                {counts.total > 0 ? (
                  <>
                    {counts.running > 0 && (
                      <span className="flex items-center gap-0.5 text-blue-500">
                        <span className="relative flex h-1.5 w-1.5">
                          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75" />
                          <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-blue-500" />
                        </span>
                        {counts.running}
                      </span>
                    )}
                    {counts.succeeded > 0 && (
                      <span className="flex items-center gap-0.5 text-emerald-600 dark:text-emerald-400">
                        <CheckCircle2 className="w-2.5 h-2.5" /> {counts.succeeded}
                      </span>
                    )}
                    {counts.failed > 0 && (
                      <span className="flex items-center gap-0.5 text-red-500">
                        <XCircle className="w-2.5 h-2.5" /> {counts.failed}
                      </span>
                    )}
                    <span className="ml-auto text-muted-foreground tabular-nums">
                      {counts.total} {counts.total === 1 ? 'run' : 'runs'}
                    </span>
                  </>
                ) : (
                  <span className="text-muted-foreground">no runs yet</span>
                )}
              </div>

              {(job.state?.lastRunAtMs || job.state?.nextRunAtMs) && (
                <p className="mt-1 text-[10px] text-muted-foreground tabular-nums space-x-2">
                  {job.state.lastRunAtMs && (
                    <span>
                      last {timeAgoNow(job.state.lastRunAtMs, now)}
                      {lastStatus && (
                        <span className={`ml-1 ${
                          lastStatus === 'ok'    ? 'text-emerald-500' :
                          lastStatus === 'error' ? 'text-red-500' : ''
                        }`}>
                          ({lastStatus})
                        </span>
                      )}
                    </span>
                  )}
                  {job.enabled && job.state.nextRunAtMs && (
                    <span>· next {timeUntilNow(job.state.nextRunAtMs, now)}</span>
                  )}
                </p>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
