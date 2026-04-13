import { CalendarClock, Clock, Send, Zap, ExternalLink, Play, Pause, Trash2, Ban } from 'lucide-react';
import { useDashboardStore } from '../../store/dashboard-store';
import type { TaskRun } from '../../types/tasks';
import { extractCronJobId, taskCancelLookup } from '../../types/tasks';
import type { CronJob, CronPayload } from '../../types/openclaw';
import { cancelTaskWithFeedback } from '../../lib/tasks-api';
import { humanizeSchedule } from '../../lib/cron-humanize';
import { ConfirmButton } from './ConfirmButton';

function formatRelative(ms?: number): string {
  if (!ms) return '—';
  const diff = ms - Date.now();
  const abs = Math.abs(diff);
  const s = Math.floor(abs / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  let magnitude: string;
  if (s < 60) magnitude = `${s}s`;
  else if (m < 60) magnitude = `${m}m`;
  else if (h < 24) magnitude = `${h}h`;
  else magnitude = `${d}d`;
  return diff > 0 ? `in ${magnitude}` : `${magnitude} ago`;
}

function payloadSummary(p: CronPayload): string {
  if (p.kind === 'systemEvent') return p.text;
  if (p.kind === 'agentTurn') return p.message;
  return JSON.stringify(p);
}

interface CronInfoProps {
  task: TaskRun;
  onClose?: () => void;
}

export function CronInfo({ task, onClose }: CronInfoProps) {
  const jobId = task.sourceId || extractCronJobId(task);
  const { cronJobs, toggleCronJob, deleteCronJob } = useDashboardStore();
  const job: CronJob | undefined = jobId ? cronJobs.find((j) => j.id === jobId) : undefined;
  const isRunning = task.status === 'running';

  if (!job) {
    return (
      <div className="px-5 py-3 mx-5 mt-2 bg-amber-500/10 border border-amber-500/20 rounded-lg">
        <div className="flex items-center gap-2 mb-1">
          <CalendarClock className="w-4 h-4 text-amber-600 dark:text-amber-400" />
          <p className="text-sm font-medium text-amber-700 dark:text-amber-300">Scheduled Task</p>
        </div>
        <p className="text-xs text-muted-foreground">
          Cron job metadata unavailable{jobId ? ` (jobId: ${jobId})` : ''}. Job may have been removed.
        </p>
      </div>
    );
  }

  return (
    <div className="px-5 py-3 mx-5 mt-2 bg-cyan-500/5 border border-cyan-500/20 rounded-lg">
      <div className="flex items-start justify-between gap-3 mb-3">
        <div className="flex items-center gap-2">
          <CalendarClock className="w-4 h-4 text-cyan-600 dark:text-cyan-400" />
          <div>
            <p className="text-sm font-semibold text-foreground">{job.name}</p>
            <p className="text-[11px] text-muted-foreground">Cron Job</p>
          </div>
        </div>
        <button
          onClick={() => toggleCronJob(job.id, !job.enabled)}
          className={`flex items-center gap-1 px-2 py-1 rounded text-[11px] font-medium transition-colors ${
            job.enabled
              ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 hover:bg-emerald-500/20'
              : 'bg-muted text-muted-foreground hover:bg-muted/80'
          }`}
          title={job.enabled ? 'Click to disable' : 'Click to enable'}
        >
          {job.enabled ? <Play className="w-3 h-3" /> : <Pause className="w-3 h-3" />}
          {job.enabled ? 'Enabled' : 'Disabled'}
        </button>
      </div>

      <div className="grid grid-cols-2 gap-2 text-xs">
        <div>
          <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Schedule</p>
          <p className="text-foreground mt-0.5 flex items-center gap-1">
            <Clock className="w-3 h-3 text-muted-foreground" />
            {humanizeSchedule(job.schedule)}
          </p>
        </div>
        <div>
          <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Session Target</p>
          <p className="text-foreground mt-0.5">{job.sessionTarget}</p>
        </div>
        <div>
          <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Next Run</p>
          <p className="text-foreground mt-0.5">{formatRelative(job.state?.nextRunAtMs)}</p>
        </div>
        <div>
          <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Last Run</p>
          <p className="text-foreground mt-0.5">
            {formatRelative(job.state?.lastRunAtMs)}
            {job.state?.lastStatus && (
              <span className={`ml-1 text-[10px] ${
                job.state.lastStatus === 'ok' ? 'text-emerald-500' :
                job.state.lastStatus === 'error' ? 'text-red-500' : 'text-muted-foreground'
              }`}>({job.state.lastStatus})</span>
            )}
          </p>
        </div>
      </div>

      <div className="mt-3 pt-3 border-t border-cyan-500/10">
        <p className="text-[10px] text-muted-foreground uppercase tracking-wide mb-1 flex items-center gap-1">
          <Send className="w-3 h-3" /> Payload ({job.payload.kind})
        </p>
        <p className="text-xs text-foreground font-mono bg-background/40 rounded p-2 max-h-24 overflow-y-auto whitespace-pre-wrap break-words">
          {payloadSummary(job.payload)}
        </p>
      </div>

      {job.state?.lastError && (
        <div className="mt-2 p-2 bg-red-500/10 border border-red-500/20 rounded">
          <p className="text-[10px] text-red-500 uppercase tracking-wide mb-0.5 flex items-center gap-1">
            <Zap className="w-3 h-3" /> Last Error
          </p>
          <p className="text-xs text-red-400 font-mono break-words">{job.state.lastError}</p>
        </div>
      )}

      <div className="mt-3 pt-3 border-t border-cyan-500/10 flex flex-wrap items-center gap-2">
        {isRunning && (
          <ConfirmButton
            variant="warn"
            icon={<Ban className="w-3 h-3" />}
            confirmLabel="Click to abort"
            onConfirm={() => cancelTaskWithFeedback(taskCancelLookup(task), task.childSessionKey, task.runId)}
          >
            Abort run
          </ConfirmButton>
        )}
        <ConfirmButton
          variant="danger"
          icon={<Trash2 className="w-3 h-3" />}
          confirmLabel="Click to confirm"
          onConfirm={async () => {
            await deleteCronJob(job.id);
            onClose?.();
          }}
        >
          Delete job
        </ConfirmButton>
        <a
          href="/cron"
          className="ml-auto inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors"
        >
          <ExternalLink className="w-3 h-3" /> Manage
        </a>
      </div>
      <p className="mt-1 text-[10px] text-muted-foreground font-mono opacity-60">id: {job.id}</p>
    </div>
  );
}
