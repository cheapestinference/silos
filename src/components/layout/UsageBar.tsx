import { useState, useEffect } from 'react';
import { useDashboardStore } from '../../store/dashboard-store';
import { Zap } from 'lucide-react';

interface UsageData {
  budget: { spent: number; limit: number | null; duration: string; resets_at: string };
  plan: { slug: string | null; status: string; expires_at: string };
  credits: { balance: number };
}

function formatTimeLeft(resetsAt: string): string {
  const ms = new Date(resetsAt).getTime() - Date.now();
  if (ms <= 0) return '0m';
  const hours = Math.floor(ms / 3600000);
  const mins = Math.floor((ms % 3600000) / 60000);
  if (hours >= 24) return `${Math.ceil(hours / 24)}d`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

export function UsageBar() {
  const connected = useDashboardStore(s => s.connected);
  const token = useDashboardStore(s => s.token);
  const [usage, setUsage] = useState<UsageData | null>(null);

  useEffect(() => {
    if (!connected || !token) return;
    let cancelled = false;

    const fetchUsage = async () => {
      try {
        const res = await fetch('/api/usage', {
          headers: { 'Authorization': `Bearer ${token}` },
        });
        if (!res.ok) return;
        const json = await res.json();
        const data = json?.data || json;
        if (!cancelled && data?.budget) setUsage(data);
      } catch { /* ignore */ }
    };

    fetchUsage();
    const interval = setInterval(fetchUsage, 5 * 60 * 1000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [connected]);

  if (!usage || !usage.budget?.limit) return null;

  const { spent, limit, resets_at, duration } = usage.budget;
  const pct = Math.min((spent / limit) * 100, 100);

  const timeLeft = resets_at ? formatTimeLeft(resets_at) : null;
  const barColor = pct > 90 ? 'bg-red-500' : pct > 70 ? 'bg-amber-500' : 'bg-orange-500';
  const planLabel = usage.plan?.slug
    ? usage.plan.slug.charAt(0).toUpperCase() + usage.plan.slug.slice(1)
    : 'Plan';

  return (
    <div className="px-3 py-2 border-t border-sidebar-border">
      <div className="flex items-center gap-1.5 mb-1.5">
        <Zap className="w-3 h-3 text-orange-500" />
        <span className="text-[10px] font-semibold text-sidebar-fg/70 uppercase tracking-wide">
          {planLabel}
        </span>
        <span className="ml-auto text-[10px] text-muted-foreground">
          {timeLeft && <>⏱ {timeLeft}</>}
          {!timeLeft && duration}
        </span>
      </div>
      <div className="h-1.5 bg-sidebar-hover rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-500 ${barColor}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <div className="flex justify-between mt-1">
        <span className="text-[10px] text-muted-foreground">
          ${spent.toFixed(2)} / ${limit.toFixed(2)}
        </span>
        <span className="text-[10px] text-muted-foreground">
          {Math.round(pct)}%
        </span>
      </div>
    </div>
  );
}
