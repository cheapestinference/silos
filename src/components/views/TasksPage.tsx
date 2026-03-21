import * as React from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ListTodo,
  Clock,
  Play,
  CheckCircle,
  XCircle,
  AlertTriangle,
  Square,
  MoreVertical,
  Timer,
  Zap,
  MessageSquare,
  Bot,
  Trash2,
  Search,
  Filter,
  ArrowUpDown,
  RefreshCw,
  History,
  CalendarClock,
  Plus,
} from 'lucide-react';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Card, CardContent } from '../ui/card';
import { useDashboardStore } from '../../store/dashboard-store';
import { useTranslation } from '../../i18n';
import { cn, formatDuration, truncateText, formatTimestamp } from '../../lib/utils';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from '../ui/dropdown-menu';
import { CronJobList, CronJobForm } from '../cron';
import type { Task, TaskStatus, CronJob } from '../../types/openclaw';

type FilterOption = 'all' | 'running' | 'completed' | 'failed';
type SortOption = 'date' | 'duration' | 'agent';

type KanbanColumn = {
  id: string;
  titleKey: string;
  statuses: TaskStatus[];
  icon: React.ElementType;
  color: string;
  bgColor: string;
  borderColor: string;
};

const columns: KanbanColumn[] = [
  {
    id: 'todo',
    titleKey: 'tasks.columns.todo',
    statuses: ['pending'],
    icon: Clock,
    color: 'text-amber-500',
    bgColor: 'bg-amber-500/10',
    borderColor: 'border-amber-500/20',
  },
  {
    id: 'in-progress',
    titleKey: 'tasks.columns.inProgress',
    statuses: ['running'],
    icon: Play,
    color: 'text-blue-500',
    bgColor: 'bg-blue-500/10',
    borderColor: 'border-blue-500/20',
  },
  {
    id: 'done',
    titleKey: 'tasks.columns.done',
    statuses: ['completed', 'error', 'aborted'],
    icon: CheckCircle,
    color: 'text-emerald-500',
    bgColor: 'bg-emerald-500/10',
    borderColor: 'border-emerald-500/20',
  },
];

function TaskCard({
  task,
  onAbort,
  onDelete,
  onNavigate,
}: {
  task: Task;
  onAbort: () => void;
  onDelete: () => void;
  onNavigate: () => void;
}) {
  const { t } = useTranslation();
  const isRunning = task.status === 'running';
  const isError = task.status === 'error';
  const isCompleted = task.status === 'completed';
  const duration = task.completedAt
    ? task.completedAt - task.startedAt
    : Date.now() - task.startedAt;

  const statusConfig: Record<TaskStatus, { bg: string; text: string; icon: React.ElementType }> = {
    pending: { bg: 'bg-amber-500/10', text: 'text-amber-500', icon: Clock },
    running: { bg: 'bg-blue-500/10', text: 'text-blue-500', icon: Play },
    completed: { bg: 'bg-emerald-500/10', text: 'text-emerald-500', icon: CheckCircle },
    error: { bg: 'bg-red-500/10', text: 'text-red-500', icon: XCircle },
    aborted: { bg: 'bg-orange-500/10', text: 'text-orange-500', icon: AlertTriangle },
  };

  const config = statusConfig[task.status];
  const StatusIcon = config.icon;

  return (
    <div
      onClick={onNavigate}
      className={cn(
        'group relative bg-card rounded-xl border shadow-sm hover:shadow-md transition-all overflow-hidden cursor-pointer',
        isRunning && 'border-blue-500/40 ring-1 ring-blue-500/20',
        isError && 'border-red-500/20',
        isCompleted && 'border-emerald-500/20'
      )}
    >
      {/* Running indicator */}
      {isRunning && (
        <div className="absolute top-0 left-0 right-0 h-0.5 bg-blue-500/20 overflow-hidden">
          <div className="h-full bg-blue-500 animate-shimmer w-1/2" style={{
            animation: 'shimmer 1.5s infinite linear',
            background: 'linear-gradient(90deg, transparent, rgba(59, 130, 246, 0.8), transparent)',
          }} />
        </div>
      )}

      <div className="p-4">
        {/* Header */}
        <div className="flex items-start justify-between mb-3">
          <div className={cn('inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium', config.bg, config.text)}>
            <StatusIcon className="w-3 h-3" />
            {t(`tasks.status.${task.status}` as any)}
          </div>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button onClick={(e) => e.stopPropagation()} className="h-7 w-7 flex items-center justify-center rounded-lg hover:bg-muted opacity-0 group-hover:opacity-100 transition-opacity">
                <MoreVertical className="w-4 h-4 text-muted-foreground" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {isRunning && (
                <DropdownMenuItem onClick={onAbort} className="text-amber-500">
                  <Square className="w-4 h-4 mr-2" />
                  {t('tasks.stop')}
                </DropdownMenuItem>
              )}
              <DropdownMenuItem onClick={onDelete} className="text-red-500">
                <Trash2 className="w-4 h-4 mr-2" />
                {t('common.delete')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        {/* Content */}
        <div className="space-y-2.5">
          {/* Agent */}
          <div className="flex items-center gap-2">
            <div className="w-6 h-6 rounded-lg bg-primary/10 flex items-center justify-center">
              <Bot className="w-3.5 h-3.5 text-primary" />
            </div>
            <span className="text-sm font-medium truncate flex-1">
              {task.agentId || 'Default Agent'}
            </span>
          </div>

          {/* Session */}
          <div className="flex items-center gap-2 text-muted-foreground">
            <MessageSquare className="w-4 h-4 flex-shrink-0" />
            <span className="text-xs truncate">
              {truncateText(task.sessionKey, 28)}
            </span>
          </div>

          {/* Duration */}
          <div className="flex items-center gap-2 text-muted-foreground">
            <Timer className="w-4 h-4 flex-shrink-0" />
            <span className={cn('text-xs', isRunning && 'text-blue-600 dark:text-blue-400')}>
              {formatDuration(duration)}
              {isRunning && <span className="animate-pulse ml-0.5">...</span>}
            </span>
          </div>

          {/* Error message */}
          {isError && task.error && (
            <div className="mt-2 p-2.5 bg-red-500/10 rounded-lg border border-red-500/20">
              <p className="text-xs text-red-600 dark:text-red-400 line-clamp-2">{task.error}</p>
            </div>
          )}

          {/* Tokens */}
          {(task.inputTokens || task.outputTokens) && (
            <div className="flex items-center gap-2 pt-2 border-t border-border">
              <Zap className="w-3.5 h-3.5 text-primary" />
              <span className="text-xs text-muted-foreground">
                <span className="text-primary">{(task.inputTokens || 0).toLocaleString()}</span> in
                {' / '}
                <span className="text-emerald-600 dark:text-emerald-400">{(task.outputTokens || 0).toLocaleString()}</span> out
              </span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function KanbanColumnComponent({
  column,
  tasks,
  onAbortTask,
  onDeleteTask,
  onNavigateTask,
}: {
  column: KanbanColumn;
  tasks: Task[];
  onAbortTask: (runId: string) => void;
  onDeleteTask: (id: string) => void;
  onNavigateTask: (sessionKey: string) => void;
}) {
  const { t } = useTranslation();
  const Icon = column.icon;

  return (
    <div className="flex flex-col h-full min-w-[320px] flex-1 max-w-[400px]">
      {/* Column Header */}
      <div className={cn(
        'flex items-center justify-between mb-4 p-3 rounded-xl border',
        column.bgColor,
        column.borderColor
      )}>
        <div className="flex items-center gap-2">
          <Icon className={cn('w-5 h-5', column.color)} />
          <h3 className="font-semibold">{t(column.titleKey as any)}</h3>
        </div>
        <Badge variant="secondary" className="bg-background/40">
          {tasks.length}
        </Badge>
      </div>

      {/* Column Content */}
      <div className="flex-1 overflow-y-auto pr-1 custom-scrollbar">
        <div className="space-y-3 pb-4">
          {tasks.length === 0 ? (
            <div className={cn(
              'p-8 text-center border-2 border-dashed rounded-xl',
              column.borderColor
            )}>
              <Icon className={cn('w-8 h-8 mx-auto mb-2 opacity-30', column.color)} />
              <p className="text-sm text-muted-foreground">{t('tasks.noTasks')}</p>
            </div>
          ) : (
            tasks.map((task) => (
              <TaskCard
                key={task.id}
                task={task}
                onAbort={() => onAbortTask(task.runId)}
                onDelete={() => onDeleteTask(task.id)}
                onNavigate={() => onNavigateTask(task.sessionKey)}
              />
            ))
          )}
        </div>
      </div>
    </div>
  );
}

type TabType = 'tasks' | 'periodic';

export function TasksPage() {
  const navigate = useNavigate();
  const {
    tasks,
    abortTask,
    loadTaskHistory,
    taskHistoryLoading,
    cronJobs,
    cronStatus,
    cronLoading,
    toggleCronJob,
    runCronJob,
    deleteCronJob,
    addCronJob,
    updateCronJob,
    getCronRuns,
    agents,
    loadCronJobs,
  } = useDashboardStore();

  // Load cron jobs on mount
  React.useEffect(() => {
    loadCronJobs();
  }, [loadCronJobs]);
  const { t } = useTranslation();

  const [activeTab, setActiveTab] = React.useState<TabType>('tasks');
  const [search, setSearch] = React.useState('');
  const [filter, setFilter] = React.useState<FilterOption>('all');
  const [sort, setSort] = React.useState<SortOption>('date');

  // Cron Job Form state
  const [showCronForm, setShowCronForm] = React.useState(false);
  const [editingCronJob, setEditingCronJob] = React.useState<CronJob | null>(null);
  const [cronFormSaving, setCronFormSaving] = React.useState(false);

  // Delete confirmation state
  const [deleteTaskConfirm, setDeleteTaskConfirm] = React.useState<string | null>(null);

  const handleDeleteTask = (taskId: string) => {
    setDeleteTaskConfirm(taskId);
  };

  const confirmDeleteTask = () => {
    if (deleteTaskConfirm) {
      useDashboardStore.setState((state) => ({
        tasks: state.tasks.filter((t) => t.id !== deleteTaskConfirm),
      }));
      setDeleteTaskConfirm(null);
    }
  };

  // Filter and sort tasks
  const filteredTasks = React.useMemo(() => {
    let result = [...tasks];

    // Apply search
    if (search.trim()) {
      const query = search.toLowerCase();
      result = result.filter(task =>
        task.agentId?.toLowerCase().includes(query) ||
        task.sessionKey.toLowerCase().includes(query)
      );
    }

    // Apply filter
    switch (filter) {
      case 'running':
        result = result.filter(t => t.status === 'running');
        break;
      case 'completed':
        result = result.filter(t => t.status === 'completed');
        break;
      case 'failed':
        result = result.filter(t => t.status === 'error' || t.status === 'aborted');
        break;
    }

    // Apply sort
    switch (sort) {
      case 'duration':
        result.sort((a, b) => {
          const durationA = (a.completedAt || Date.now()) - a.startedAt;
          const durationB = (b.completedAt || Date.now()) - b.startedAt;
          return durationB - durationA;
        });
        break;
      case 'agent':
        result.sort((a, b) => (a.agentId || '').localeCompare(b.agentId || ''));
        break;
      default:
        result.sort((a, b) => b.startedAt - a.startedAt);
    }

    return result;
  }, [tasks, search, filter, sort]);

  const getTasksForColumn = (column: KanbanColumn) => {
    return filteredTasks.filter((task) => column.statuses.includes(task.status));
  };

  // Cron jobs stats
  const enabledCronJobs = cronJobs.filter((j) => j.enabled).length;
  const runningCronJobs = cronJobs.filter((j) => j.state?.runningAtMs).length;
  const nextCronRun = cronJobs
    .filter((j) => j.enabled && j.state?.nextRunAtMs)
    .map((j) => j.state!.nextRunAtMs!)
    .sort((a, b) => a - b)[0];

  // Get agent name helper
  const getAgentName = (agentId: string) => {
    const agent = agents?.agents.find((a) => a.id === agentId);
    return agent?.identity?.name || agent?.name || agentId;
  };

  // Handle cron form save
  const handleCronFormSave = async (jobData: Omit<CronJob, 'id' | 'createdAtMs' | 'updatedAtMs' | 'state'>) => {
    setCronFormSaving(true);
    try {
      if (editingCronJob) {
        await updateCronJob(editingCronJob.id, jobData);
      } else {
        await addCronJob(jobData);
      }
      setShowCronForm(false);
      setEditingCronJob(null);
    } finally {
      setCronFormSaving(false);
    }
  };

  // Handle cron edit
  const handleCronEdit = (job: CronJob) => {
    setEditingCronJob(job);
    setShowCronForm(true);
  };

  return (
    <div className="flex flex-col h-full bg-background">
      {/* Compact Header */}
      <header className="flex-shrink-0 px-6 py-3 border-b border-border">
        <div className="flex items-center justify-between">
          {/* Left: Title + Tabs */}
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2">
              <ListTodo className="w-5 h-5 text-primary" />
              <h1 className="text-lg font-semibold">{t('tasks.title')}</h1>
            </div>

            {/* Tabs */}
            <div className="flex items-center gap-1 p-1 bg-muted/40 rounded-lg">
              <button
                onClick={() => setActiveTab('tasks')}
                className={cn(
                  'flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium transition-colors',
                  activeTab === 'tasks'
                    ? 'bg-background text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground'
                )}
              >
                <ListTodo className="w-3.5 h-3.5" />
                {t('tasks.tasksTab')}
              </button>
              <button
                onClick={() => setActiveTab('periodic')}
                className={cn(
                  'flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium transition-colors',
                  activeTab === 'periodic'
                    ? 'bg-background text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground'
                )}
              >
                <CalendarClock className="w-3.5 h-3.5" />
                {t('tasks.periodicTasks')}
                {cronJobs.length > 0 && (
                  <Badge variant="secondary" className="ml-1 text-[10px] px-1.5">
                    {cronJobs.length}
                  </Badge>
                )}
              </button>
            </div>

            {/* Search - only for tasks tab */}
            {activeTab === 'tasks' && (
              <div className="relative w-48">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
                <Input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder={t('common.search')}
                  className="pl-8 h-8 text-sm"
                />
              </div>
            )}
          </div>

          {/* Right: Actions */}
          <div className="flex items-center gap-2">
            {activeTab === 'tasks' ? (
              <>
                {/* Filter */}
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="sm" className="h-8 gap-1.5 text-muted-foreground hover:text-foreground">
                      <Filter className="w-3.5 h-3.5" />
                      {filter !== 'all' && <span className="text-xs">{t(`tasks.filters.${filter}` as any)}</span>}
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onClick={() => setFilter('all')}>
                      {t('tasks.filters.all')}
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => setFilter('running')}>
                      {t('tasks.filters.running')}
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => setFilter('completed')}>
                      {t('tasks.filters.completed')}
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => setFilter('failed')}>
                      {t('tasks.filters.failed')}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>

                {/* Sort */}
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="sm" className="h-8 gap-1.5 text-muted-foreground hover:text-foreground">
                      <ArrowUpDown className="w-3.5 h-3.5" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onClick={() => setSort('date')}>
                      {t('tasks.sortOptions.date')}
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => setSort('duration')}>
                      {t('tasks.sortOptions.duration')}
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => setSort('agent')}>
                      {t('tasks.sortOptions.agent')}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>

                {/* Divider */}
                <div className="w-px h-5 bg-border" />

                {/* Load History - Primary action */}
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8 gap-1.5"
                  onClick={() => loadTaskHistory()}
                  disabled={taskHistoryLoading}
                >
                  <History className={cn("w-3.5 h-3.5", taskHistoryLoading && "animate-spin")} />
                  {taskHistoryLoading ? t('common.loading') : t('tasks.loadHistory')}
                </Button>
              </>
            ) : (
              <>
                {/* Running count for periodic tasks */}
                {runningCronJobs > 0 && (
                  <Badge variant="default" className="bg-blue-500 animate-pulse">
                    <Play className="h-3 w-3 mr-1" />
                    {runningCronJobs} {t('tasks.running')}
                  </Badge>
                )}

                {/* Scheduler status */}
                <Badge variant={cronStatus?.enabled ? 'default' : 'secondary'} className={cronStatus?.enabled ? 'bg-emerald-500' : ''}>
                  {cronStatus?.enabled ? t('tasks.schedulerActive') : t('tasks.schedulerPaused')}
                </Badge>

                {/* Divider */}
                <div className="w-px h-5 bg-border" />

                {/* Create button */}
                <Button
                  size="sm"
                  className="h-8 gap-1.5"
                  onClick={() => {
                    setEditingCronJob(null);
                    setShowCronForm(true);
                  }}
                >
                  <Plus className="w-3.5 h-3.5" />
                  {t('tasks.createTask')}
                </Button>
              </>
            )}
          </div>
        </div>
      </header>

      {/* Content Area */}
      <div className="flex-1 p-6 overflow-x-auto">
        {activeTab === 'tasks' ? (
          /* Kanban Board */
          filteredTasks.length === 0 && tasks.length === 0 ? (
            <div className="h-full flex items-center justify-center">
              <div className="text-center">
                <div className="w-20 h-20 rounded-2xl bg-primary/10 flex items-center justify-center mx-auto mb-4">
                  <ListTodo className="w-10 h-10 text-primary" />
                </div>
                <h3 className="text-lg font-semibold mb-1">{t('tasks.noTasks')}</h3>
                <p className="text-muted-foreground max-w-md">
                  {t('tasks.tasksAppearHint')}
                </p>
              </div>
            </div>
          ) : filteredTasks.length === 0 ? (
            <div className="h-full flex items-center justify-center">
              <div className="text-center">
                <Search className="w-12 h-12 mx-auto mb-4 text-muted-foreground opacity-30" />
                <h3 className="text-lg font-semibold mb-1">{t('common.noResults')}</h3>
                <p className="text-muted-foreground">
                  {t('tasks.adjustFilters')}
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  className="mt-4"
                  onClick={() => { setSearch(''); setFilter('all'); }}
                >
                  <RefreshCw className="w-4 h-4 mr-2" />
                  {t('tasks.clearFilters')}
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex gap-6 h-full">
              {columns.map((column) => (
                <KanbanColumnComponent
                  key={column.id}
                  column={column}
                  tasks={getTasksForColumn(column)}
                  onAbortTask={abortTask}
                  onDeleteTask={handleDeleteTask}
                  onNavigateTask={(sk) => navigate(`/session/${sk}`)}
                />
              ))}
            </div>
          )
        ) : (
          /* Periodic Tasks Tab */
          <div className="max-w-5xl mx-auto">
            {/* Stats Grid */}
            <div className="grid gap-4 md:grid-cols-4 mb-6">
              <Card>
                <CardContent className="pt-6">
                  <div className="text-2xl font-bold">{cronJobs.length}</div>
                  <p className="text-xs text-muted-foreground">{t('tasks.totalJobs')}</p>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="pt-6">
                  <div className="text-2xl font-bold text-green-500">{enabledCronJobs}</div>
                  <p className="text-xs text-muted-foreground">{t('cron.active')}</p>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="pt-6">
                  <div className="text-2xl font-bold text-muted-foreground">
                    {cronJobs.length - enabledCronJobs}
                  </div>
                  <p className="text-xs text-muted-foreground">{t('cron.paused')}</p>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="pt-6">
                  <div className="text-2xl font-bold">
                    {nextCronRun ? formatTimestamp(nextCronRun) : 'N/A'}
                  </div>
                  <p className="text-xs text-muted-foreground">{t('tasks.nextRun')}</p>
                </CardContent>
              </Card>
            </div>

            {/* Cron Jobs List */}
            <CronJobList
              jobs={cronJobs}
              onToggle={(id, enabled) => toggleCronJob(id, enabled)}
              onRun={runCronJob}
              onEdit={handleCronEdit}
              onDelete={deleteCronJob}
              onLoadRuns={getCronRuns}
              showAgentInfo={true}
              getAgentName={getAgentName}
              loading={cronLoading}
              emptyMessage={t('tasks.configurePeriodicTasks')}
            />
          </div>
        )}
      </div>

      {/* Cron Job Form Modal */}
      {showCronForm && (
        <CronJobForm
          job={editingCronJob || undefined}
          onSave={handleCronFormSave}
          onCancel={() => {
            setShowCronForm(false);
            setEditingCronJob(null);
          }}
          saving={cronFormSaving}
        />
      )}

      {/* Task Delete Confirmation Modal */}
      {deleteTaskConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div
            className="absolute inset-0 bg-background/80 backdrop-blur-sm"
            onClick={() => setDeleteTaskConfirm(null)}
          />
          <Card className="relative z-10 w-full max-w-md mx-4">
            <CardContent className="pt-6 space-y-4">
              <div className="flex items-center gap-2 text-destructive">
                <Trash2 className="h-5 w-5" />
                <h3 className="font-semibold">{t('tasks.deleteTask')}</h3>
              </div>
              <p className="text-muted-foreground">
                {t('tasks.deleteTaskConfirm')}
              </p>
              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={() => setDeleteTaskConfirm(null)}>
                  {t('common.cancel')}
                </Button>
                <Button variant="destructive" onClick={confirmDeleteTask}>
                  {t('common.delete')}
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
