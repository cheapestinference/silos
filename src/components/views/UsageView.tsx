import { useEffect } from 'react';
import { BarChart3 } from 'lucide-react';
import { useDashboardStore } from '../../store/dashboard-store';

/**
 * Phase 5 — Usage view. Skeleton in Task 3; overview chart + sessions
 * table added in Task 4; per-session time-series panel in Task 5.
 */
export function UsageView() {
  const loadUsageCost = useDashboardStore(s => s.loadUsageCost);
  const loadSessionsUsage = useDashboardStore(s => s.loadSessionsUsage);

  useEffect(() => {
    loadUsageCost({ days: 30 });
    loadSessionsUsage({ days: 30 });
  }, [loadUsageCost, loadSessionsUsage]);

  return (
    <div className="flex flex-col h-full bg-background overflow-hidden">
      <div className="px-6 py-4 border-b flex items-center gap-3">
        <div className="w-9 h-9 rounded-lg bg-card border flex items-center justify-center">
          <BarChart3 className="w-5 h-5 text-cyan-600 dark:text-cyan-400" />
        </div>
        <div>
          <h1 className="text-sm font-semibold text-foreground">Usage</h1>
          <p className="text-[11px] text-muted-foreground">
            Tokens + cost across sessions, last 30 days
          </p>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-6 text-sm text-muted-foreground">
        Loading…
      </div>
    </div>
  );
}
