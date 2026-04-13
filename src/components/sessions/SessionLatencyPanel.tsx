import { useMemo } from 'react';
import { Activity, Zap, Timer, CheckCircle2, XCircle, Ban, Trash2 } from 'lucide-react';
import { useDashboardStore } from '../../store/dashboard-store';
import { formatDistanceToNow } from 'date-fns';
import type { LatencyEntry } from '../../types/openclaw';
import { cn } from '../../lib/utils';

const EMPTY_ENTRIES: LatencyEntry[] = [];

function fmtMs(ms: number | undefined): string {
  if (ms === undefined || ms === null) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(ms < 10000 ? 2 : 1)}s`;
}

function percentile(arr: number[], p: number): number | undefined {
  if (arr.length === 0) return undefined;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

function StatCell({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="flex flex-col gap-0.5 px-3 py-2 rounded-md bg-muted/40 border border-border/40">
      <span className="text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</span>
      <span className="text-sm font-mono font-semibold text-foreground tabular-nums">{value}</span>
      {hint && <span className="text-[9px] text-muted-foreground/60">{hint}</span>}
    </div>
  );
}

function OutcomeIcon({ outcome }: { outcome: LatencyEntry['outcome'] }) {
  if (outcome === 'ok')      return <CheckCircle2 className="w-3 h-3 text-log-info" />;
  if (outcome === 'error')   return <XCircle       className="w-3 h-3 text-log-error" />;
  return                            <Ban           className="w-3 h-3 text-muted-foreground" />;
}

function EntryRow({ entry }: { entry: LatencyEntry }) {
  const when = formatDistanceToNow(entry.completedAt, { addSuffix: true });

  return (
    <div className="flex items-center gap-3 px-3 py-2 border-b border-border/50 last:border-b-0 hover:bg-muted/30 transition-colors">
      <OutcomeIcon outcome={entry.outcome} />
      <div className="flex items-center gap-1 w-16 shrink-0">
        <Timer className="w-3 h-3 text-muted-foreground/60" />
        <span className="text-xs font-mono font-semibold text-foreground tabular-nums">{fmtMs(entry.latencyMs)}</span>
      </div>
      <div className="flex items-center gap-1 w-20 shrink-0" title="Time to first byte">
        <Zap className="w-3 h-3 text-log-warn" />
        <span className="text-[11px] font-mono text-muted-foreground tabular-nums">
          {entry.ttfbMs !== undefined ? fmtMs(entry.ttfbMs) : '—'}
        </span>
      </div>
      <div className="flex items-center gap-1 w-20 shrink-0" title="Estimated tokens per second (chars/4)">
        <Activity className="w-3 h-3 text-log-info" />
        <span className="text-[11px] font-mono text-muted-foreground tabular-nums">
          {entry.tokensPerSecond ? `${entry.tokensPerSecond} tok/s` : '—'}
        </span>
      </div>
      <span className="flex-1 min-w-0 text-[10px] font-mono text-muted-foreground/60 truncate">
        {entry.runId}
      </span>
      <span className="text-[10px] text-muted-foreground/50 shrink-0">{when}</span>
    </div>
  );
}

export function SessionLatencyPanel({ sessionKey }: { sessionKey: string }) {
  const entries = useDashboardStore(s => s.latencyEntries.get(sessionKey) ?? EMPTY_ENTRIES);
  const clearSessionLatency = useDashboardStore(s => s.clearSessionLatency);

  const stats = useMemo(() => {
    const okEntries = entries.filter(e => e.outcome === 'ok');
    const latencies = okEntries.map(e => e.latencyMs);
    const ttfbs = okEntries.map(e => e.ttfbMs).filter((x): x is number => typeof x === 'number');
    const tokRates = okEntries.map(e => e.tokensPerSecond).filter((x): x is number => typeof x === 'number');

    const avg = (xs: number[]) => xs.length === 0 ? undefined : xs.reduce((a, b) => a + b, 0) / xs.length;

    return {
      count: entries.length,
      okCount: okEntries.length,
      errorCount: entries.filter(e => e.outcome === 'error').length,
      abortedCount: entries.filter(e => e.outcome === 'aborted').length,
      avgLatency: avg(latencies),
      p50: percentile(latencies, 50),
      p95: percentile(latencies, 95),
      avgTtfb: avg(ttfbs),
      medianTokRate: percentile(tokRates, 50),
    };
  }, [entries]);

  if (entries.length === 0) {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-3 px-6 text-center">
        <div className="w-12 h-12 rounded-full bg-muted/60 flex items-center justify-center">
          <Activity className="w-5 h-5 text-muted-foreground/60" />
        </div>
        <div>
          <p className="text-sm font-medium text-foreground">No latency data yet</p>
          <p className="text-xs text-muted-foreground mt-0.5">
            Send a message — TTFB, total latency, and estimated tok/s will be tracked here.
          </p>
        </div>
      </div>
    );
  }

  const sorted = [...entries].sort((a, b) => b.completedAt - a.completedAt);

  return (
    <div className="h-full flex flex-col">
      <div className="px-3 py-2 border-b border-border/60 shrink-0">
        <div className="flex items-center gap-2 mb-2">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            {stats.count} runs
          </span>
          {stats.okCount > 0 && (
            <span className="text-[10px] font-mono text-log-info">{stats.okCount} ok</span>
          )}
          {stats.errorCount > 0 && (
            <span className="text-[10px] font-mono text-log-error">{stats.errorCount} err</span>
          )}
          {stats.abortedCount > 0 && (
            <span className="text-[10px] font-mono text-muted-foreground">{stats.abortedCount} aborted</span>
          )}
          <button
            type="button"
            onClick={() => clearSessionLatency(sessionKey)}
            className="ml-auto p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
            title="Clear latency history"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <StatCell label="Avg total" value={fmtMs(stats.avgLatency)} />
          <StatCell label="P95 total" value={fmtMs(stats.p95)} hint={`p50: ${fmtMs(stats.p50)}`} />
          <StatCell label="Avg TTFB" value={fmtMs(stats.avgTtfb)} />
          <StatCell
            label="Median tok/s"
            value={stats.medianTokRate ? `${stats.medianTokRate}` : '—'}
            hint="estimated"
          />
        </div>
      </div>
      <div className={cn("flex-1 overflow-y-auto")}>
        {sorted.map(entry => <EntryRow key={entry.id} entry={entry} />)}
      </div>
    </div>
  );
}
