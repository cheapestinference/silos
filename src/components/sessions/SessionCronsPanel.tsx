import { useState, useEffect } from 'react';
import {
  CalendarClock,
  ChevronDown,
  ChevronRight,
  CheckCircle2,
  XCircle,
  SkipForward,
  Loader2,
  Power,
} from 'lucide-react';
import { useDashboardStore } from '../../store/dashboard-store';
import { formatDistanceToNow } from 'date-fns';
import { cn } from '../../lib/utils';
import { DetailDrawer } from '../tasks/DetailDrawer';
import { TaskRunDetail } from '../tasks/TaskRunDetail';
import type { CronJob, CronRunLogEntry } from '../../types/openclaw';
import type { TaskRun, TaskRunStatus } from '../../types/tasks';

function extractAgentId(sessionKey: string): string | null {
  if (sessionKey.startsWith('agent:')) {
    const parts = sessionKey.split(':');
    if (parts.length >= 2) return parts[1];
  }
  const dmMatch = sessionKey.match(/^dm-(.+)$/);
  if (dmMatch) return dmMatch[1];
  return null;
}

function cronRunToTaskRun(entry: CronRunLogEntry, job: CronJob, sessionKey: string): TaskRun {
  const status: TaskRunStatus =
    entry.status === 'ok' ? 'succeeded'
    : entry.status === 'error' ? 'failed'
    : 'cancelled';

  // For sessionTarget === 'isolated' the run lives in a dedicated child key
  // (typically `agent:<id>:cron:<jobId>:<ts>`); we don't receive it from
  // getCronRuns yet. Passing the parent sessionKey means TaskRunDetail will
  // load messages from the parent session and filter by runId. If the runId
  // filter returns nothing, it falls back to the whole session which is
  // noisy but safe. TODO: add childSessionKey to CronRunLogEntry.
  const childSessionKey = job.sessionTarget === 'isolated'
    ? `${sessionKey.replace(/:[^:]+$/, '')}:cron:${entry.jobId}:${entry.ts}`
    : sessionKey;

  return {
    taskId: `cron:${entry.jobId}:${entry.ts}`,
    runId: `cron:${entry.jobId}:${entry.ts}`,
    runtime: 'cron',
    sourceId: job.id,
    ownerKey: sessionKey,
    childSessionKey,
    agentId: job.agentId,
    label: job.name,
    status,
    createdAt: entry.ts,
    startedAt: entry.ts,
    endedAt: entry.durationMs ? entry.ts + entry.durationMs : undefined,
    error: entry.error,
    terminalSummary: entry.summary,
  };
}

function formatScheduleBrief(schedule: CronJob['schedule']): string {
  if (schedule.kind === 'cron') return schedule.expr;
  if (schedule.kind === 'every') {
    const min = Math.round(schedule.everyMs / 60000);
    if (min < 60) return `every ${min}m`;
    const hr = Math.round(min / 60);
    if (hr < 24) return `every ${hr}h`;
    return `every ${Math.round(hr / 24)}d`;
  }
  if (schedule.kind === 'at') {
    return `at ${new Date(schedule.atMs).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' })}`;
  }
  return '—';
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return `${m}m ${s}s`;
}

function CronRunRow({
  run,
  job,
  sessionKey,
  onClick,
}: {
  run: CronRunLogEntry;
  job: CronJob;
  sessionKey: string;
  onClick: (task: TaskRun) => void;
}) {
  const StatusIcon =
    run.status === 'ok' ? CheckCircle2
    : run.status === 'error' ? XCircle
    : SkipForward;
  const statusColor =
    run.status === 'ok' ? 'text-log-info'
    : run.status === 'error' ? 'text-log-error'
    : 'text-muted-foreground';

  return (
    <button
      type="button"
      onClick={() => onClick(cronRunToTaskRun(run, job, sessionKey))}
      className="w-full flex items-start gap-3 px-4 py-2 text-left hover:bg-muted/40 transition-colors border-b border-border/40 last:border-b-0"
    >
      <StatusIcon className={cn("w-3.5 h-3.5 shrink-0 mt-0.5", statusColor)} />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs font-mono text-foreground tabular-nums">
            {new Date(run.ts).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' })}
          </span>
          {run.durationMs !== undefined && (
            <span className="text-[10px] font-mono text-muted-foreground tabular-nums">
              {formatMs(run.durationMs)}
            </span>
          )}
          <span className="text-[10px] text-muted-foreground/60 ml-auto shrink-0">
            {formatDistanceToNow(run.ts, { addSuffix: true })}
          </span>
        </div>
        {run.summary && (
          <p className="text-[11px] text-muted-foreground mt-0.5 truncate">{run.summary}</p>
        )}
        {run.error && (
          <p className="text-[11px] text-log-error mt-0.5 truncate font-mono">{run.error}</p>
        )}
      </div>
    </button>
  );
}

function CronJobCardInline({
  job,
  sessionKey,
  onRunClick,
  onToggle,
}: {
  job: CronJob;
  sessionKey: string;
  onRunClick: (task: TaskRun) => void;
  onToggle: (id: string, enabled: boolean) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [runs, setRuns] = useState<CronRunLogEntry[] | null>(null);
  const [loading, setLoading] = useState(false);
  const getCronRuns = useDashboardStore(s => s.getCronRuns);

  const handleExpand = async () => {
    const next = !expanded;
    setExpanded(next);
    if (next && runs === null) {
      setLoading(true);
      try {
        const result = await getCronRuns(job.id);
        setRuns(result);
      } finally {
        setLoading(false);
      }
    }
  };

  const lastStatus = job.state?.lastStatus;
  const lastStatusColor =
    lastStatus === 'ok' ? 'text-log-info'
    : lastStatus === 'error' ? 'text-log-error'
    : lastStatus === 'skipped' ? 'text-muted-foreground'
    : 'text-muted-foreground/40';

  return (
    <div className="border border-border/60 rounded-lg overflow-hidden bg-card">
      <div
        role="button"
        tabIndex={0}
        onClick={handleExpand}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleExpand(); } }}
        className="w-full px-3 py-2.5 flex items-center gap-2 hover:bg-muted/40 transition-colors text-left cursor-pointer"
      >
        {expanded
          ? <ChevronDown className="w-3 h-3 shrink-0 text-muted-foreground" />
          : <ChevronRight className="w-3 h-3 shrink-0 text-muted-foreground" />
        }
        <span className={cn(
          "w-1.5 h-1.5 rounded-full shrink-0",
          job.enabled ? "bg-log-info" : "bg-muted-foreground/40"
        )} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs font-medium text-foreground truncate">{job.name}</span>
            {lastStatus && (
              <span className={cn("text-[10px] font-mono uppercase tracking-wider", lastStatusColor)}>
                {lastStatus}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2 mt-0.5 text-[10px] text-muted-foreground">
            <span className="font-mono">{formatScheduleBrief(job.schedule)}</span>
            {job.state?.nextRunAtMs && (
              <span>· next {formatDistanceToNow(job.state.nextRunAtMs, { addSuffix: true })}</span>
            )}
          </div>
        </div>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onToggle(job.id, !job.enabled);
          }}
          className={cn(
            "p-1.5 rounded-md transition-colors shrink-0",
            job.enabled
              ? "text-log-info hover:bg-log-info/10"
              : "text-muted-foreground hover:text-foreground hover:bg-muted"
          )}
          title={job.enabled ? 'Disable' : 'Enable'}
        >
          <Power className="w-3.5 h-3.5" />
        </button>
      </div>

      {expanded && (
        <div className="border-t border-border/40 bg-muted/10">
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-4">
              <Loader2 className="w-3.5 h-3.5 animate-spin text-muted-foreground" />
              <span className="text-xs text-muted-foreground">Loading runs…</span>
            </div>
          ) : runs === null || runs.length === 0 ? (
            <div className="py-6 text-center">
              <span className="text-xs text-muted-foreground">No runs recorded yet</span>
            </div>
          ) : (
            runs.map(run => (
              <CronRunRow
                key={`${run.jobId}-${run.ts}`}
                run={run}
                job={job}
                sessionKey={sessionKey}
                onClick={onRunClick}
              />
            ))
          )}
        </div>
      )}
    </div>
  );
}

export function SessionCronsPanel({ sessionKey }: { sessionKey: string }) {
  const cronJobs = useDashboardStore(s => s.cronJobs);
  const loadCronJobs = useDashboardStore(s => s.loadCronJobs);
  const toggleCronJob = useDashboardStore(s => s.toggleCronJob);
  const selectSession = useDashboardStore(s => s.selectSession);
  const [selectedTask, setSelectedTask] = useState<TaskRun | null>(null);

  const agentId = extractAgentId(sessionKey);

  useEffect(() => {
    if (cronJobs.length === 0) {
      loadCronJobs();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const agentCrons = cronJobs.filter(job => !!agentId && job.agentId === agentId);

  if (!agentId) {
    return (
      <div className="h-full flex items-center justify-center">
        <p className="text-xs text-muted-foreground">No agent context for cron jobs.</p>
      </div>
    );
  }

  if (agentCrons.length === 0) {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-3 px-6 text-center">
        <div className="w-12 h-12 rounded-full bg-muted/60 flex items-center justify-center">
          <CalendarClock className="w-5 h-5 text-muted-foreground/60" />
        </div>
        <div>
          <p className="text-sm font-medium text-foreground">No scheduled tasks</p>
          <p className="text-xs text-muted-foreground mt-0.5">
            Create crons from the agent detail view; they'll appear here with their run history.
          </p>
        </div>
      </div>
    );
  }

  const enabled = agentCrons.filter(c => c.enabled).length;

  return (
    <div className="h-full flex flex-col">
      <div className="px-3 py-2 border-b border-border/60 shrink-0 flex items-center gap-2">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          {agentCrons.length} cron{agentCrons.length === 1 ? '' : 's'}
        </span>
        <span className="text-[10px] text-muted-foreground">
          {enabled} enabled · {agentCrons.length - enabled} disabled
        </span>
      </div>
      <div className="flex-1 overflow-y-auto p-2 space-y-2">
        {agentCrons.map(job => (
          <CronJobCardInline
            key={job.id}
            job={job}
            sessionKey={sessionKey}
            onRunClick={setSelectedTask}
            onToggle={toggleCronJob}
          />
        ))}
      </div>

      <DetailDrawer
        open={selectedTask !== null}
        onClose={() => setSelectedTask(null)}
        title="Cron Run"
        subtitle={selectedTask?.label || selectedTask?.runId}
      >
        {selectedTask && (
          <TaskRunDetail
            task={selectedTask}
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
