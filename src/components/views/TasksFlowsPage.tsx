import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { RefreshCw, Loader2, Inbox, Search, Layers, CalendarClock, Terminal, User, Activity, Clock, ExternalLink } from 'lucide-react';
import { fetchTasks, fetchFlows } from '../../lib/tasks-api';
import type { TaskRun, TaskFlow } from '../../types/tasks';
import { FlowList } from '../tasks/FlowList';
import { CronList } from '../tasks/CronList';
import { TaskKanban } from '../tasks/TaskKanban';
import { DetailDrawer } from '../tasks/DetailDrawer';
import { TaskRunDetail } from '../tasks/TaskRunDetail';
import { TaskFlowDetail } from '../tasks/TaskFlowDetail';
import { CronJobDetail } from '../tasks/CronJobDetail';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useDashboardStore } from '../../store/dashboard-store';
import { useAutoRefresh } from '../../hooks/useAutoRefresh';

type DrawerContent =
  | { type: 'task'; task: TaskRun }
  | { type: 'flow'; flowId: string }
  | { type: 'cron'; jobId: string }
  | null;

type TypeFilter = 'flow' | 'standalone' | 'cron';
type StatusFilter = 'all' | 'active' | 'succeeded' | 'failed';
type SinceFilter = 'all' | '1h' | '24h' | '7d';

const typeFilterConfig: Record<TypeFilter, { label: string; icon: React.ElementType }> = {
  flow:       { label: 'Flow tasks',  icon: Layers },
  standalone: { label: 'Standalone',  icon: Terminal },
  cron:       { label: 'Crons',       icon: CalendarClock },
};

const statusFilterOptions: { value: StatusFilter; label: string }[] = [
  { value: 'all',       label: 'All statuses' },
  { value: 'active',    label: 'Active' },
  { value: 'succeeded', label: 'Succeeded' },
  { value: 'failed',    label: 'Failed / stopped' },
];

const sinceFilterOptions: { value: SinceFilter; label: string; ms: number }[] = [
  { value: 'all', label: 'All time',  ms: 0 },
  { value: '1h',  label: 'Last hour', ms: 60 * 60 * 1000 },
  { value: '24h', label: 'Last 24h',  ms: 24 * 60 * 60 * 1000 },
  { value: '7d',  label: 'Last 7d',   ms: 7 * 24 * 60 * 60 * 1000 },
];

function matchesStatusFilter(task: TaskRun, sf: StatusFilter): boolean {
  if (sf === 'all') return true;
  if (sf === 'active')    return ['queued', 'running', 'waiting', 'blocked'].includes(task.status as string);
  if (sf === 'succeeded') return task.status === 'succeeded';
  if (sf === 'failed')    return ['failed', 'timed_out', 'cancelled', 'lost'].includes(task.status);
  return true;
}

function matchesSinceFilter(task: TaskRun, sf: SinceFilter): boolean {
  if (sf === 'all') return true;
  const sinceMs = sinceFilterOptions.find(o => o.value === sf)?.ms ?? 0;
  if (!sinceMs) return true;
  const ts = task.startedAt ?? task.createdAt ?? 0;
  return ts >= Date.now() - sinceMs;
}

export function TasksFlowsPage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [tasks, setTasks] = useState<TaskRun[]>([]);
  const [flows, setFlows] = useState<TaskFlow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // URL-backed state: read initial values from search params, persist on change.
  const [searchQuery, setSearchQuery] = useState<string>(searchParams.get('q') ?? '');
  const [selectedFlowId, setSelectedFlowId] = useState<string | null>(searchParams.get('flow'));
  const [selectedCronId, setSelectedCronId] = useState<string | null>(searchParams.get('cron'));
  const [drawer, setDrawer] = useState<DrawerContent>(null);
  const [typeFilter, setTypeFilter] = useState<TypeFilter>(() => {
    const urlType = searchParams.get('type') as TypeFilter | null;
    if (urlType && (urlType === 'flow' || urlType === 'standalone' || urlType === 'cron')) {
      return urlType;
    }
    return 'flow';
  });
  const [agentFilter, setAgentFilter] = useState<string>(searchParams.get('agent') ?? 'all');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>(
    (searchParams.get('status') as StatusFilter) || 'all',
  );
  const [sinceFilter, setSinceFilter] = useState<SinceFilter>(
    (searchParams.get('since') as SinceFilter) || 'all',
  );

  const searchInputRef = useRef<HTMLInputElement | null>(null);

  // Sync active filter state → URL (debounced in effect for search).
  useEffect(() => {
    const next: Record<string, string> = {};
    if (typeFilter !== 'flow')  next.type = typeFilter;
    if (agentFilter !== 'all')  next.agent = agentFilter;
    if (statusFilter !== 'all') next.status = statusFilter;
    if (sinceFilter !== 'all')  next.since = sinceFilter;
    if (selectedFlowId)         next.flow = selectedFlowId;
    if (selectedCronId)         next.cron = selectedCronId;
    if (searchQuery.trim())     next.q = searchQuery.trim();
    setSearchParams(next, { replace: true });
  }, [typeFilter, agentFilter, statusFilter, sinceFilter, selectedFlowId, selectedCronId, searchQuery, setSearchParams]);

  const loadData = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    setError(null);
    try {
      const [tasksData, flowsData] = await Promise.all([fetchTasks(), fetchFlows()]);
      setTasks(tasksData);
      setFlows(flowsData);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, []);

  // Load when token is available (zustand persist rehydrates it from localStorage)
  const token = useDashboardStore(s => s.token);
  const cronJobs = useDashboardStore(s => s.cronJobs);
  useEffect(() => { if (token) loadData(); }, [loadData, token]);

  const hasActiveTasks = useMemo(
    () => tasks.some(t => t.status === 'running' || t.status === 'queued'),
    [tasks]
  );
  useAutoRefresh(() => loadData(true), 5000, hasActiveTasks);

  // Keyboard shortcuts: "/" focus search, Esc closes drawer, 1-4 switch type, r refresh.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const inField = !!target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || (target as HTMLElement).isContentEditable);

      if (e.key === 'Escape' && drawer) {
        setDrawer(null);
        return;
      }
      if (inField) return;

      if (e.key === '/') {
        e.preventDefault();
        searchInputRef.current?.focus();
        return;
      }
      if (e.key === 'r' && !e.metaKey && !e.ctrlKey) {
        loadData();
        return;
      }
      const pillKeys: TypeFilter[] = ['flow', 'standalone', 'cron'];
      const idx = ['1', '2', '3'].indexOf(e.key);
      if (idx >= 0) {
        setTypeFilter(pillKeys[idx]);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [drawer, loadData]);

  // Available agents derived from tasks + cronJobs (stable, sorted).
  const agentOptions = useMemo(() => {
    const ids = new Set<string>();
    for (const t of tasks) if (t.agentId) ids.add(t.agentId);
    for (const j of cronJobs) if (j.agentId) ids.add(j.agentId);
    return [...ids].sort((a, b) => a.localeCompare(b));
  }, [tasks, cronJobs]);

  // Apply the agent filter first so that type counts reflect the chosen agent.
  const agentScopedTasks = useMemo(
    () => (agentFilter === 'all' ? tasks : tasks.filter(t => t.agentId === agentFilter)),
    [tasks, agentFilter],
  );
  const agentScopedCronJobs = useMemo(
    () => (agentFilter === 'all' ? cronJobs : cronJobs.filter(j => j.agentId === agentFilter)),
    [cronJobs, agentFilter],
  );

  const typeCounts = useMemo(() => ({
    flow: agentScopedTasks.filter(t => t.parentFlowId != null).length,
    standalone: agentScopedTasks.filter(t => t.parentFlowId == null && t.runtime !== 'cron').length,
    cron: agentScopedTasks.filter(t => t.runtime === 'cron').length,
  }), [agentScopedTasks]);

  const filteredTasks = useMemo(() => {
    const base = agentScopedTasks;
    let result: TaskRun[];
    switch (typeFilter) {
      case 'cron':
        result = selectedCronId
          ? base.filter(t => t.runtime === 'cron' && t.sourceId === selectedCronId)
          : base.filter(t => t.runtime === 'cron');
        break;
      case 'standalone':
        result = base.filter(t => t.parentFlowId == null && t.runtime !== 'cron');
        break;
      case 'flow':
      default:
        result = selectedFlowId
          ? base.filter(t => t.parentFlowId === selectedFlowId)
          : base.filter(t => t.parentFlowId != null);
        break;
    }

    // Status + time-range filters apply across all type pills.
    result = result.filter(t => matchesStatusFilter(t, statusFilter) && matchesSinceFilter(t, sinceFilter));

    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      result = result.filter(t =>
        (t.label || '').toLowerCase().includes(q) ||
        t.taskId.toLowerCase().includes(q) ||
        (t.agentId || '').toLowerCase().includes(q) ||
        t.runtime.toLowerCase().includes(q)
      );
    }

    return result;
  }, [agentScopedTasks, typeFilter, selectedFlowId, selectedCronId, searchQuery, statusFilter, sinceFilter]);

  const handleSelectFlow = (flowId: string | null) => {
    setSelectedFlowId(flowId);
  };

  const handleTypeFilter = (nextFilter: TypeFilter) => {
    setTypeFilter(nextFilter);
    // Reset intra-view selection that only makes sense for the previous filter
    if (nextFilter !== 'flow') setSelectedFlowId(null);
    if (nextFilter !== 'cron') setSelectedCronId(null);
  };

  const showFlowList = typeFilter === 'flow';
  const showCronList = typeFilter === 'cron';

  const handleTaskClick = (task: TaskRun) => {
    setDrawer({ type: 'task', task });
  };

  return (
    <div className="flex flex-col h-full">
      {/* Title row — minimal, Refresh only. Filters moved below for visibility. */}
      <div className="flex items-center justify-between px-6 py-3 border-b border-border shrink-0">
        <div className="flex items-center gap-3">
          <h1 className="text-base font-semibold text-foreground">Tasks &amp; Flows</h1>
          {hasActiveTasks && (
            <span className="flex items-center gap-1.5 text-[10px] text-blue-500">
              <span className="relative flex h-1.5 w-1.5">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75" />
                <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-blue-500" />
              </span>
              Auto-refreshing
            </span>
          )}
        </div>
        <button
          onClick={() => loadData()}
          disabled={loading}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-muted transition-colors disabled:opacity-50"
        >
          {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
          Refresh
        </button>
      </div>

      {/* Filter bar — always visible, dedicated row. */}
      <div className="flex flex-wrap items-center gap-2 px-6 py-2.5 border-b border-border shrink-0 bg-muted/20">
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
          <input
            ref={searchInputRef}
            type="text"
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            placeholder="Search tasks…  (press /)"
            className="pl-8 pr-3 py-1.5 w-56 bg-background border border-border rounded-lg text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-primary/50 transition-colors"
          />
        </div>

        <div className="relative">
          <User className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-muted-foreground pointer-events-none" />
          <select
            value={agentFilter}
            onChange={(e) => {
              setAgentFilter(e.target.value);
              setSelectedFlowId(null);
              setSelectedCronId(null);
            }}
            className="appearance-none pl-7 pr-6 py-1.5 bg-background border border-border rounded-lg text-xs text-foreground focus:outline-none focus:border-primary/50 transition-colors"
            title="Filter by agent"
          >
            <option value="all">All agents</option>
            {agentOptions.map((id) => (
              <option key={id} value={id}>{id}</option>
            ))}
          </select>
        </div>

        <div className="relative">
          <Activity className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-muted-foreground pointer-events-none" />
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
            className="appearance-none pl-7 pr-6 py-1.5 bg-background border border-border rounded-lg text-xs text-foreground focus:outline-none focus:border-primary/50 transition-colors"
            title="Filter by status"
          >
            {statusFilterOptions.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </div>

        <div className="relative">
          <Clock className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-muted-foreground pointer-events-none" />
          <select
            value={sinceFilter}
            onChange={(e) => setSinceFilter(e.target.value as SinceFilter)}
            className="appearance-none pl-7 pr-6 py-1.5 bg-background border border-border rounded-lg text-xs text-foreground focus:outline-none focus:border-primary/50 transition-colors"
            title="Filter by time range"
          >
            {sinceFilterOptions.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </div>

        {(agentFilter !== 'all' || statusFilter !== 'all' || sinceFilter !== 'all' || searchQuery) && (
          <button
            onClick={() => {
              setAgentFilter('all');
              setStatusFilter('all');
              setSinceFilter('all');
              setSearchQuery('');
            }}
            className="ml-auto text-[11px] text-muted-foreground hover:text-foreground underline decoration-dotted"
          >
            Clear filters
          </button>
        )}
      </div>

      {/* Type filter pill row */}
      <div className="flex items-center gap-1.5 px-6 py-2 border-b border-border shrink-0 overflow-x-auto">
        {(Object.keys(typeFilterConfig) as TypeFilter[]).map((key) => {
          const cfg = typeFilterConfig[key];
          const Icon = cfg.icon;
          const active = typeFilter === key;
          return (
            <button
              key={key}
              onClick={() => handleTypeFilter(key)}
              className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium transition-colors whitespace-nowrap ${
                active
                  ? 'bg-foreground text-background'
                  : 'bg-muted/40 text-muted-foreground hover:bg-muted hover:text-foreground border border-border'
              }`}
            >
              <Icon className="w-3 h-3" />
              <span>{cfg.label}</span>
              <span className={`tabular-nums text-[10px] ${active ? 'opacity-70' : 'opacity-60'}`}>
                {typeCounts[key]}
              </span>
            </button>
          );
        })}
      </div>

      {error && (
        <div className="mx-6 mt-4 p-3 bg-red-500/10 border border-red-500/20 rounded-lg text-xs text-red-500">
          {error}
        </div>
      )}

      <div className="flex-1 flex overflow-hidden">
        {showFlowList && (
          <div className="w-72 border-r border-border shrink-0 overflow-hidden flex flex-col">
            <FlowList
              flows={flows}
              tasks={agentScopedTasks}
              selectedFlowId={selectedFlowId}
              onSelectFlow={handleSelectFlow}
              onInspectFlow={(flowId) => setDrawer({ type: 'flow', flowId })}
            />
          </div>
        )}
        {showCronList && (
          <div className="w-72 border-r border-border shrink-0 overflow-hidden flex flex-col">
            <CronList
              jobs={agentScopedCronJobs}
              tasks={agentScopedTasks}
              selectedCronId={selectedCronId}
              onSelectCron={setSelectedCronId}
              onInspectCron={(jobId) => setDrawer({ type: 'cron', jobId })}
            />
          </div>
        )}

        <div className="flex-1 p-4 overflow-hidden flex flex-col">
          {loading && tasks.length === 0 ? (
            <div className="flex-1 flex items-center justify-center">
              <Loader2 className="w-5 h-5 text-muted-foreground animate-spin" />
            </div>
          ) : filteredTasks.length === 0 ? (
            <div className="flex-1 flex flex-col items-center justify-center">
              <Inbox className="w-8 h-8 text-muted-foreground/30 mb-2" />
              {(() => {
                if (searchQuery) return (
                  <>
                    <p className="text-sm text-muted-foreground">No matching tasks</p>
                    <p className="text-xs text-muted-foreground/60 mt-1">Try a different search term or clear filters</p>
                  </>
                );
                if (statusFilter !== 'all' || sinceFilter !== 'all') return (
                  <>
                    <p className="text-sm text-muted-foreground">No tasks match these filters</p>
                    <button
                      onClick={() => { setStatusFilter('all'); setSinceFilter('all'); }}
                      className="text-xs text-muted-foreground/80 mt-1 underline decoration-dotted hover:text-foreground"
                    >
                      Clear status + time range
                    </button>
                  </>
                );
                if (typeFilter === 'cron' && selectedCronId) return (
                  <>
                    <p className="text-sm text-muted-foreground">No runs yet for this cron job</p>
                    <p className="text-xs text-muted-foreground/60 mt-1">They&apos;ll appear here after the next scheduled trigger</p>
                  </>
                );
                if (typeFilter === 'cron') return (
                  <>
                    <p className="text-sm text-muted-foreground">No cron runs</p>
                    <a href="/cron" className="text-xs text-muted-foreground/80 mt-1 inline-flex items-center gap-1 hover:text-foreground">
                      <ExternalLink className="w-3 h-3" /> Create a cron job
                    </a>
                  </>
                );
                if (typeFilter === 'standalone') return (
                  <>
                    <p className="text-sm text-muted-foreground">No standalone tasks</p>
                    <p className="text-xs text-muted-foreground/60 mt-1">All tracked runs belong to a flow or cron</p>
                  </>
                );
                if (typeFilter === 'flow' && selectedFlowId) return (
                  <>
                    <p className="text-sm text-muted-foreground">No tasks in this flow</p>
                  </>
                );
                if (typeFilter === 'flow') return (
                  <>
                    <p className="text-sm text-muted-foreground">No flow-backed tasks</p>
                    <p className="text-xs text-muted-foreground/60 mt-1">Flows appear when agents use TaskFlow APIs</p>
                  </>
                );
                return (
                  <>
                    <p className="text-sm text-muted-foreground">No tasks yet</p>
                    <p className="text-xs text-muted-foreground/60 mt-1">Tasks appear here when agents run background work</p>
                  </>
                );
              })()}
            </div>
          ) : (
            <TaskKanban tasks={filteredTasks} onTaskClick={handleTaskClick} />
          )}
        </div>
      </div>

      <DetailDrawer
        open={drawer !== null}
        onClose={() => setDrawer(null)}
        title={
          drawer?.type === 'task' ? 'Task Run' :
          drawer?.type === 'flow' ? 'Task Flow' :
          drawer?.type === 'cron' ? 'Cron Job' : ''
        }
        subtitle={
          drawer?.type === 'task' ? (drawer.task.label || drawer.task.taskId) :
          drawer?.type === 'flow' ? drawer.flowId :
          drawer?.type === 'cron' ? (cronJobs.find(j => j.id === drawer.jobId)?.name || drawer.jobId) :
          undefined
        }
      >
        {drawer?.type === 'task' && (
          <TaskRunDetail
            task={drawer.task}
            onNavigateToFlow={(flowId) => {
              setDrawer(null);
              setSelectedFlowId(flowId);
            }}
            onNavigateToSession={(key) => navigate(`/session/${encodeURIComponent(key)}`)}
            onClose={() => setDrawer(null)}
          />
        )}
        {drawer?.type === 'flow' && (
          <TaskFlowDetail
            flowId={drawer.flowId}
            onSelectTask={(task) => setDrawer({ type: 'task', task })}
            onClose={() => setDrawer(null)}
          />
        )}
        {drawer?.type === 'cron' && (
          <CronJobDetail
            jobId={drawer.jobId}
            onClose={() => setDrawer(null)}
          />
        )}
      </DetailDrawer>
    </div>
  );
}
