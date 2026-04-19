import { useEffect, useMemo, useState } from 'react';
import { BarChart3, ArrowUpDown, Loader2 } from 'lucide-react';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';
import { useDashboardStore } from '../../store/dashboard-store';
import { cn, formatNumber } from '../../lib/utils';
import type { SessionsUsageEntry } from '../../types/openclaw';

type RangeDays = 7 | 30 | 90;
type SortKey = 'tokens' | 'cost' | 'updatedAt';

function formatBytes(n: number): string {
  return formatNumber(n);
}

function formatCost(n: number | undefined | null): string {
  if (!n || !Number.isFinite(n)) return '—';
  if (n < 0.01) return `$${n.toFixed(4)}`;
  if (n < 1) return `$${n.toFixed(3)}`;
  return `$${n.toFixed(2)}`;
}

function formatRelativeTime(ts: number): string {
  const diff = Date.now() - ts;
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

function totalsFromSession(entry: SessionsUsageEntry): { tokens: number; cost: number } {
  let tokens = 0;
  let cost = 0;
  for (const day of entry.usage.dailyBreakdown ?? []) {
    tokens += day.tokens || 0;
    cost += day.cost || 0;
  }
  return { tokens, cost };
}

export function UsageView() {
  const loadUsageCost = useDashboardStore(s => s.loadUsageCost);
  const loadSessionsUsage = useDashboardStore(s => s.loadSessionsUsage);
  const usageCostSummary = useDashboardStore(s => s.usageCostSummary);
  const usageCostLoading = useDashboardStore(s => s.usageCostLoading);
  const sessionsUsage = useDashboardStore(s => s.sessionsUsage);
  const sessionsUsageLoading = useDashboardStore(s => s.sessionsUsageLoading);

  const [days, setDays] = useState<RangeDays>(30);
  const [sortKey, setSortKey] = useState<SortKey>('tokens');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');

  useEffect(() => {
    loadUsageCost({ days, force: true });
    loadSessionsUsage({ days, force: true });
  }, [days, loadUsageCost, loadSessionsUsage]);

  const chartData = useMemo(() => {
    const daily = usageCostSummary?.daily ?? [];
    return daily.map(d => ({
      date: d.date.slice(5),                   // MM-DD
      tokens: d.totalTokens ?? 0,
      cost: d.totalCost ?? 0,
    }));
  }, [usageCostSummary]);

  const sortedSessions = useMemo(() => {
    const list = sessionsUsage?.sessions ?? [];
    const withTotals = list.map((s) => ({ s, ...totalsFromSession(s) }));
    withTotals.sort((a, b) => {
      let av = 0, bv = 0;
      if (sortKey === 'tokens') { av = a.tokens; bv = b.tokens; }
      else if (sortKey === 'cost') { av = a.cost; bv = b.cost; }
      else { av = a.s.updatedAt; bv = b.s.updatedAt; }
      return sortDir === 'desc' ? bv - av : av - bv;
    });
    return withTotals;
  }, [sessionsUsage, sortKey, sortDir]);

  const onHeaderSort = (key: SortKey) => {
    if (key === sortKey) {
      setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    } else {
      setSortKey(key);
      setSortDir('desc');
    }
  };

  const totals = usageCostSummary?.totals;

  return (
    <div className="flex flex-col h-full bg-background overflow-hidden">
      {/* Header */}
      <div className="px-6 py-4 border-b flex items-center gap-3">
        <div className="w-9 h-9 rounded-lg bg-card border flex items-center justify-center shrink-0">
          <BarChart3 className="w-5 h-5 text-cyan-600 dark:text-cyan-400" />
        </div>
        <div className="flex-1 min-w-0">
          <h1 className="text-sm font-semibold text-foreground">Usage</h1>
          <p className="text-[11px] text-muted-foreground">
            Tokens + cost across sessions, last {days} days
          </p>
        </div>
        <div className="flex items-center gap-1 border rounded-md bg-card overflow-hidden text-[11px]">
          {([7, 30, 90] as const).map(d => (
            <button
              key={d}
              type="button"
              onClick={() => setDays(d)}
              className={cn(
                'px-3 py-1.5 transition-colors',
                days === d
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:text-foreground hover:bg-muted',
              )}
              aria-pressed={days === d}
            >
              {d}d
            </button>
          ))}
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto p-6 space-y-6">
        {/* Totals strip */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <KpiCard label="Total tokens" value={formatBytes(totals?.totalTokens ?? 0)} loading={usageCostLoading} />
          <KpiCard label="Total cost" value={formatCost(totals?.totalCost)} loading={usageCostLoading} />
          <KpiCard label="Sessions" value={String(sessionsUsage?.sessions?.length ?? 0)} loading={sessionsUsageLoading} />
          <KpiCard
            label="Missing cost entries"
            value={formatBytes(totals?.missingCostEntries ?? 0)}
            tone={(totals?.missingCostEntries ?? 0) > 0 ? 'warn' : undefined}
            loading={usageCostLoading}
          />
        </div>

        {/* Daily chart */}
        <section className="rounded-lg border bg-card">
          <div className="px-4 py-2 border-b flex items-center justify-between">
            <h2 className="text-xs font-semibold text-foreground">Daily tokens</h2>
            {usageCostLoading && <Loader2 className="w-3 h-3 animate-spin text-muted-foreground" />}
          </div>
          <div className="h-48 p-3">
            {chartData.length === 0 ? (
              <div className="h-full flex items-center justify-center text-xs text-muted-foreground">
                {usageCostLoading ? 'Loading…' : 'No usage in range.'}
              </div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={chartData}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="currentColor" strokeOpacity={0.08} />
                  <XAxis dataKey="date" tick={{ fontSize: 10 }} tickLine={false} axisLine={false} />
                  <YAxis tick={{ fontSize: 10 }} tickLine={false} axisLine={false} width={40} />
                  <Tooltip
                    cursor={{ fill: 'rgba(8, 145, 178, 0.08)' }}
                    contentStyle={{ fontSize: 11, borderRadius: 6 }}
                    formatter={(value) => formatBytes(Number(value))}
                  />
                  <Bar dataKey="tokens" fill="rgb(8, 145, 178)" radius={[3, 3, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>
        </section>

        {/* Sessions table */}
        <section className="rounded-lg border bg-card">
          <div className="px-4 py-2 border-b flex items-center justify-between">
            <h2 className="text-xs font-semibold text-foreground">Sessions</h2>
            {sessionsUsageLoading && <Loader2 className="w-3 h-3 animate-spin text-muted-foreground" />}
          </div>
          {sortedSessions.length === 0 ? (
            <div className="p-6 text-center text-xs text-muted-foreground">
              {sessionsUsageLoading ? 'Loading…' : 'No sessions in range.'}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b bg-background/40 text-muted-foreground">
                    <th className="px-3 py-2 text-left font-medium">Session</th>
                    <th className="px-3 py-2 text-left font-medium">Agent</th>
                    <th className="px-3 py-2 text-left font-medium">Model</th>
                    <SortHeader label="Tokens" active={sortKey === 'tokens'} dir={sortDir} onClick={() => onHeaderSort('tokens')} className="text-right" />
                    <SortHeader label="Cost" active={sortKey === 'cost'} dir={sortDir} onClick={() => onHeaderSort('cost')} className="text-right" />
                    <SortHeader label="Updated" active={sortKey === 'updatedAt'} dir={sortDir} onClick={() => onHeaderSort('updatedAt')} className="text-right" />
                  </tr>
                </thead>
                <tbody>
                  {sortedSessions.map(({ s, tokens, cost }) => (
                    <tr
                      key={s.key}
                      className="border-b last:border-b-0 hover:bg-muted/40 transition-colors"
                    >
                      <td className="px-3 py-2 font-mono text-[11px] truncate max-w-[20rem]" title={s.key}>{s.key}</td>
                      <td className="px-3 py-2">{s.agentId || <span className="text-muted-foreground">—</span>}</td>
                      <td className="px-3 py-2 font-mono text-[10px]">{s.model || <span className="text-muted-foreground">—</span>}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{formatBytes(tokens)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{formatCost(cost)}</td>
                      <td className="px-3 py-2 text-right text-muted-foreground tabular-nums">{formatRelativeTime(s.updatedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function KpiCard({
  label, value, loading, tone,
}: {
  label: string;
  value: string;
  loading?: boolean;
  tone?: 'warn';
}) {
  return (
    <div
      className={cn(
        'rounded-lg border bg-card px-4 py-3',
        tone === 'warn' && 'border-amber-500/30',
      )}
    >
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground flex items-center gap-1">
        {label}
        {loading && <Loader2 className="w-3 h-3 animate-spin" />}
      </div>
      <div
        className={cn(
          'text-lg font-semibold tabular-nums mt-1',
          tone === 'warn' ? 'text-amber-600 dark:text-amber-400' : 'text-foreground',
        )}
      >
        {value}
      </div>
    </div>
  );
}

function SortHeader({
  label, active, dir, onClick, className,
}: {
  label: string;
  active: boolean;
  dir: 'asc' | 'desc';
  onClick: () => void;
  className?: string;
}) {
  return (
    <th className={cn('px-3 py-2 font-medium', className)}>
      <button
        type="button"
        onClick={onClick}
        className={cn(
          'inline-flex items-center gap-1 transition-colors',
          active ? 'text-foreground' : 'text-muted-foreground hover:text-foreground',
        )}
      >
        {label}
        <ArrowUpDown className={cn('w-3 h-3', active && (dir === 'desc' ? 'text-foreground' : 'text-foreground rotate-180'))} />
      </button>
    </th>
  );
}
