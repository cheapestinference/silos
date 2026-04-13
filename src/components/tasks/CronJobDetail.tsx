import { useEffect, useState } from 'react';
import {
  CalendarClock, Clock, Send, Zap, ExternalLink, Play, Pause, Trash2, PlayCircle, ChevronRight, RotateCcw, Pencil,
} from 'lucide-react';
import { useDashboardStore } from '../../store/dashboard-store';
import { getGatewayClient } from '../../lib/gateway-client';
import { humanizeSchedule } from '../../lib/cron-humanize';
import type { CronJob, CronRunLogEntry, CronPayload } from '../../types/openclaw';
import { ConfirmButton } from './ConfirmButton';
import { CopyButton } from './CopyButton';
import { CronJobForm } from '../cron/CronJobForm';
import { useNow } from '../../hooks/useNow';

interface CronJobDetailProps {
  jobId: string;
  onClose?: () => void;
}

function formatRelativeNow(ms: number | undefined, now: number): string {
  if (!ms) return '—';
  const diff = ms - now;
  const abs = Math.abs(diff);
  const sec = Math.floor(abs / 1000);
  const min = Math.floor(sec / 60);
  const hr = Math.floor(min / 60);
  const day = Math.floor(hr / 24);
  const mag = sec < 60 ? `${sec}s` : min < 60 ? `${min}m` : hr < 24 ? `${hr}h` : `${day}d`;
  return diff > 0 ? `in ${mag}` : `${mag} ago`;
}

function payloadSummary(p: CronPayload): string {
  if (p.kind === 'systemEvent') return p.text;
  if (p.kind === 'agentTurn') return p.message;
  return JSON.stringify(p);
}

export function CronJobDetail({ jobId, onClose }: CronJobDetailProps) {
  const { cronJobs, toggleCronJob, deleteCronJob, runCronJob, updateCronJob } = useDashboardStore();
  const job: CronJob | undefined = cronJobs.find((j) => j.id === jobId);
  const [runs, setRuns] = useState<CronRunLogEntry[] | null>(null);
  const [runsLoading, setRunsLoading] = useState(false);
  const [editMode, setEditMode] = useState(false);
  const [saving, setSaving] = useState(false);
  const now = useNow(1000);

  useEffect(() => {
    if (!job) return;
    const client = getGatewayClient();
    if (!client) return;
    setRunsLoading(true);
    client.getCronRuns(job.id, { limit: 15 })
      .then((r) => setRuns(r.runs ?? []))
      .catch(() => setRuns([]))
      .finally(() => setRunsLoading(false));
  }, [job?.id]);

  if (!job) {
    return (
      <div className="px-5 py-6 text-center">
        <CalendarClock className="w-6 h-6 text-muted-foreground/40 mx-auto mb-2" />
        <p className="text-sm text-foreground">Cron job not found</p>
        <p className="text-xs text-muted-foreground mt-1">
          It may have been deleted. jobId: <span className="font-mono">{jobId}</span>
        </p>
      </div>
    );
  }

  if (editMode) {
    return (
      <div className="px-1 py-2">
        <CronJobForm
          job={job}
          agentId={job.agentId}
          saving={saving}
          onCancel={() => setEditMode(false)}
          onSave={async (patch) => {
            setSaving(true);
            try {
              await updateCronJob(job.id, patch);
              setEditMode(false);
            } finally {
              setSaving(false);
            }
          }}
        />
      </div>
    );
  }

  const editLink = job.agentId
    ? `/agents/${encodeURIComponent(job.agentId)}/scheduled`
    : '/cron';
  const editLinkLabel = job.agentId ? `Open in ${job.agentId}'s scheduled` : 'Open in Cron page';

  return (
    <div>
      {/* Header */}
      <div className="px-5 pt-4 pb-2 flex items-start justify-between gap-3">
        <div className="flex items-start gap-2 min-w-0">
          <CalendarClock className="w-4 h-4 text-cyan-600 dark:text-cyan-400 mt-0.5 shrink-0" />
          <div className="min-w-0">
            <p className="text-sm font-semibold text-foreground truncate">{job.name}</p>
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
        >
          {job.enabled ? <Play className="w-3 h-3" /> : <Pause className="w-3 h-3" />}
          {job.enabled ? 'Enabled' : 'Paused'}
        </button>
      </div>

      {/* Grid of facts */}
      <div className="px-5 py-3 grid grid-cols-2 gap-3 text-xs border-t border-border">
        <div>
          <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Schedule</p>
          <p className="text-foreground mt-0.5 flex items-center gap-1">
            <Clock className="w-3 h-3 text-muted-foreground" />
            {humanizeSchedule(job.schedule)}
          </p>
        </div>
        <div>
          <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Session target</p>
          <p className="text-foreground mt-0.5">{job.sessionTarget}</p>
        </div>
        <div>
          <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Next run</p>
          <p className="text-foreground mt-0.5 tabular-nums">{formatRelativeNow(job.state?.nextRunAtMs, now)}</p>
        </div>
        <div>
          <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Last run</p>
          <p className="text-foreground mt-0.5">
            {formatRelativeNow(job.state?.lastRunAtMs, now)}
            {job.state?.lastStatus && (
              <span className={`ml-1 text-[10px] ${
                job.state.lastStatus === 'ok'    ? 'text-emerald-500' :
                job.state.lastStatus === 'error' ? 'text-red-500' : 'text-muted-foreground'
              }`}>
                ({job.state.lastStatus})
              </span>
            )}
          </p>
        </div>
        {job.agentId && (
          <div className="col-span-2">
            <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Agent</p>
            <p className="text-foreground mt-0.5 font-mono">{job.agentId}</p>
          </div>
        )}
      </div>

      {/* Payload */}
      <div className="px-5 py-3 border-t border-border">
        <p className="text-[10px] text-muted-foreground uppercase tracking-wide mb-1 flex items-center gap-1">
          <Send className="w-3 h-3" /> Payload ({job.payload.kind})
        </p>
        <p className="text-xs text-foreground font-mono bg-muted/40 rounded p-2 max-h-32 overflow-y-auto whitespace-pre-wrap break-words">
          {payloadSummary(job.payload)}
        </p>
      </div>

      {job.state?.lastError && (
        <div className="mx-5 mb-2 p-2 bg-red-500/10 border border-red-500/20 rounded">
          <p className="text-[10px] text-red-500 uppercase tracking-wide mb-0.5 flex items-center gap-1">
            <Zap className="w-3 h-3" /> Last error
          </p>
          <p className="text-xs text-red-400 font-mono break-words">{job.state.lastError}</p>
        </div>
      )}

      {/* Recent runs */}
      <div className="border-t border-border">
        <p className="px-5 py-2 text-[10px] text-muted-foreground uppercase tracking-wide">
          Recent runs {runs != null ? `(${runs.length})` : ''}
        </p>
        {runsLoading && (
          <p className="px-5 py-2 text-xs text-muted-foreground">Loading…</p>
        )}
        {runs != null && runs.length === 0 && !runsLoading && (
          <p className="px-5 py-2 text-xs text-muted-foreground">No runs yet.</p>
        )}
        {runs != null && runs.length > 0 && (
          <div className="px-3 pb-3 space-y-1">
            {runs.slice(0, 15).map((r, i) => (
              <div
                key={`${r.ts}-${i}`}
                className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-muted/40 transition-colors"
              >
                <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                  r.status === 'ok'      ? 'bg-emerald-500' :
                  r.status === 'error'   ? 'bg-red-500' :
                  r.status === 'skipped' ? 'bg-amber-500' : 'bg-gray-400'
                }`} />
                <span className="text-[10px] text-muted-foreground tabular-nums w-36 shrink-0">
                  {new Date(r.ts).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' })}
                </span>
                <span className="text-[10px] text-foreground truncate flex-1">
                  {r.summary || r.error || r.status}
                </span>
                {r.durationMs != null && (
                  <span className="text-[10px] text-muted-foreground tabular-nums">
                    {Math.round(r.durationMs / 100) / 10}s
                  </span>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Actions footer */}
      <div className="px-5 py-3 border-t border-border flex flex-wrap items-center gap-2">
        {job.state?.lastStatus === 'error' ? (
          <ConfirmButton
            variant="warn"
            icon={<RotateCcw className="w-3 h-3" />}
            confirmLabel="Click to retry"
            onConfirm={async () => {
              await runCronJob(job.id);
              return { ok: true, message: 'Triggered' };
            }}
          >
            Retry
          </ConfirmButton>
        ) : (
          <ConfirmButton
            variant="neutral"
            icon={<PlayCircle className="w-3 h-3" />}
            confirmLabel="Click to run"
            onConfirm={async () => {
              await runCronJob(job.id);
              return { ok: true, message: 'Triggered' };
            }}
          >
            Run now
          </ConfirmButton>
        )}
        <button
          onClick={() => setEditMode(true)}
          className="inline-flex items-center gap-1 px-2 py-1 rounded text-[11px] font-medium bg-blue-500/10 text-blue-600 dark:text-blue-400 hover:bg-blue-500/20 border border-blue-500/20 transition-colors"
          title="Edit job"
          type="button"
        >
          <Pencil className="w-3 h-3" /> Edit
        </button>
        <ConfirmButton
          variant="danger"
          icon={<Trash2 className="w-3 h-3" />}
          confirmLabel="Click to delete"
          onConfirm={async () => {
            await deleteCronJob(job.id);
            onClose?.();
            return { ok: true, message: 'Deleted' };
          }}
        >
          Delete job
        </ConfirmButton>
        <a
          href={editLink}
          className="ml-auto inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors"
        >
          <ExternalLink className="w-3 h-3" /> {editLinkLabel} <ChevronRight className="w-3 h-3" />
        </a>
      </div>
      <p className="px-5 pb-3 text-[10px] text-muted-foreground font-mono opacity-60 inline-flex items-center gap-1">
        id: {job.id}
        <CopyButton value={job.id} title="Copy job id" />
      </p>
    </div>
  );
}
