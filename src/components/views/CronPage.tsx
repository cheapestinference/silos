import { useState } from 'react';
import {
  Clock,
  Play,
  Pause,
  Trash2,
  MoreVertical,
  CheckCircle,
  XCircle,
  AlertTriangle,
  CalendarClock,
  Timer,
  Repeat,
  Calendar,
  ChevronDown,
  ChevronUp,
  Zap,
} from 'lucide-react';
import { Header } from '../layout/Header';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '../ui/card';
import { Button } from '../ui/button';
import { Badge } from '../ui/badge';
import { useDashboardStore } from '../../store/dashboard-store';
import { cn, formatTimestamp, formatDuration } from '../../lib/utils';
import type { CronJob, CronSchedule } from '../../types/openclaw';

function getScheduleIcon(schedule: CronSchedule) {
  switch (schedule.kind) {
    case 'at':
      return Calendar;
    case 'every':
      return Repeat;
    case 'cron':
      return CalendarClock;
    default:
      return Clock;
  }
}

function getScheduleDescription(schedule: CronSchedule): string {
  switch (schedule.kind) {
    case 'at':
      return `One-time at ${new Date(schedule.atMs).toLocaleString()}`;
    case 'every':
      return `Every ${formatDuration(schedule.everyMs)}`;
    case 'cron':
      return `Cron: ${schedule.expr}${schedule.tz ? ` (${schedule.tz})` : ''}`;
    default:
      return 'Unknown schedule';
  }
}


function CronJobCard({
  job,
  onToggle,
  onRun,
  onDelete,
}: {
  job: CronJob;
  onToggle: () => void;
  onRun: () => void;
  onDelete: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [showMenu, setShowMenu] = useState(false);

  const ScheduleIcon = getScheduleIcon(job.schedule);
  const isRunning = !!job.state?.runningAtMs;

  const statusColor = job.state?.lastStatus === 'ok'
    ? 'text-green-500'
    : job.state?.lastStatus === 'error'
    ? 'text-red-500'
    : job.state?.lastStatus === 'skipped'
    ? 'text-yellow-500'
    : 'text-muted-foreground';

  const StatusIcon = job.state?.lastStatus === 'ok'
    ? CheckCircle
    : job.state?.lastStatus === 'error'
    ? XCircle
    : job.state?.lastStatus === 'skipped'
    ? AlertTriangle
    : Clock;

  return (
    <Card className={cn(
      'transition-all',
      !job.enabled && 'opacity-60',
      isRunning && 'border-blue-500/50'
    )}>
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between">
          <div className="flex items-start gap-3">
            <div className={cn(
              'p-2 rounded-lg',
              job.enabled ? 'bg-primary/10' : 'bg-muted'
            )}>
              <ScheduleIcon className={cn(
                'h-5 w-5',
                job.enabled ? 'text-primary' : 'text-muted-foreground'
              )} />
            </div>
            <div>
              <CardTitle className="text-base flex items-center gap-2">
                {job.name}
                {isRunning && (
                  <Badge variant="default" className="bg-blue-500 animate-pulse">
                    Running
                  </Badge>
                )}
              </CardTitle>
              <CardDescription className="mt-1">
                {getScheduleDescription(job.schedule)}
              </CardDescription>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="icon"
              onClick={onToggle}
              className={cn(
                'h-8 w-8',
                job.enabled ? 'text-green-500' : 'text-muted-foreground'
              )}
            >
              {job.enabled ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
            </Button>

            <div className="relative">
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8"
                onClick={() => setShowMenu(!showMenu)}
              >
                <MoreVertical className="h-4 w-4" />
              </Button>
              {showMenu && (
                <>
                  <div
                    className="fixed inset-0 z-10"
                    onClick={() => setShowMenu(false)}
                  />
                  <div className="absolute right-0 top-full mt-1 z-20 bg-popover border rounded-md shadow-lg py-1 min-w-[140px]">
                    <button
                      className="w-full px-3 py-2 text-sm text-left hover:bg-muted flex items-center gap-2"
                      onClick={() => {
                        onRun();
                        setShowMenu(false);
                      }}
                    >
                      <Play className="h-4 w-4" />
                      Run Now
                    </button>
                    <button
                      className="w-full px-3 py-2 text-sm text-left hover:bg-muted flex items-center gap-2 text-destructive"
                      onClick={() => {
                        onDelete();
                        setShowMenu(false);
                      }}
                    >
                      <Trash2 className="h-4 w-4" />
                      Delete
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      </CardHeader>

      <CardContent className="pt-0">
        {/* Status Row */}
        <div className="flex flex-wrap items-center gap-4 text-sm">
          {job.state?.lastRunAtMs && (
            <div className="flex items-center gap-1.5">
              <StatusIcon className={cn('h-4 w-4', statusColor)} />
              <span className="text-muted-foreground">Last run:</span>
              <span>{formatTimestamp(job.state.lastRunAtMs)}</span>
            </div>
          )}

          {job.state?.nextRunAtMs && job.enabled && (
            <div className="flex items-center gap-1.5">
              <Timer className="h-4 w-4 text-muted-foreground" />
              <span className="text-muted-foreground">Next:</span>
              <span>{formatTimestamp(job.state.nextRunAtMs)}</span>
            </div>
          )}

          {job.state?.lastDurationMs && (
            <div className="flex items-center gap-1.5">
              <Zap className="h-4 w-4 text-muted-foreground" />
              <span>{formatDuration(job.state.lastDurationMs)}</span>
            </div>
          )}
        </div>

        {/* Expand/Collapse Button */}
        <Button
          variant="ghost"
          size="sm"
          className="mt-3 h-7 text-xs"
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? (
            <>
              <ChevronUp className="h-3 w-3 mr-1" />
              Less
            </>
          ) : (
            <>
              <ChevronDown className="h-3 w-3 mr-1" />
              More
            </>
          )}
        </Button>

        {/* Expanded Details */}
        {expanded && (
          <div className="mt-4 space-y-4 pt-4 border-t">
            {/* Description */}
            {job.description && (
              <div>
                <p className="text-xs text-muted-foreground font-medium mb-1">Description</p>
                <p className="text-sm">{job.description}</p>
              </div>
            )}

            {/* Payload */}
            <div>
              <p className="text-xs text-muted-foreground font-medium mb-1">Payload</p>
              <div className="bg-muted p-3 rounded-lg">
                <p className="text-sm font-mono">
                  {job.payload.kind === 'systemEvent' ? (
                    <>
                      <Badge variant="secondary" className="mb-2">System Event</Badge>
                      <br />
                      {job.payload.text}
                    </>
                  ) : (
                    <>
                      <Badge variant="secondary" className="mb-2">Agent Turn</Badge>
                      <br />
                      {job.payload.message}
                    </>
                  )}
                </p>
              </div>
            </div>

            {/* Configuration */}
            <div className="grid grid-cols-2 gap-4">
              <div>
                <p className="text-xs text-muted-foreground font-medium mb-1">Session Target</p>
                <Badge variant="outline">{job.sessionTarget}</Badge>
              </div>
              <div>
                <p className="text-xs text-muted-foreground font-medium mb-1">Wake Mode</p>
                <Badge variant="outline">{job.wakeMode}</Badge>
              </div>
            </div>

            {/* Error */}
            {job.state?.lastError && (
              <div className="bg-red-500/10 p-3 rounded-lg">
                <p className="text-xs text-red-500 font-medium mb-1">Last Error</p>
                <p className="text-sm text-red-500">{job.state.lastError}</p>
              </div>
            )}

            {/* Metadata */}
            <div className="text-xs text-muted-foreground">
              <p>Created: {new Date(job.createdAtMs).toLocaleString()}</p>
              <p>Updated: {new Date(job.updatedAtMs).toLocaleString()}</p>
              <p>ID: {job.id}</p>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function CronPage() {
  const {
    cronJobs,
    cronStatus,
    cronLoading,
    toggleCronJob,
    runCronJob,
    deleteCronJob,
  } = useDashboardStore();

  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);
  const [filter, setFilter] = useState<'all' | 'enabled' | 'disabled'>('all');

  const filteredJobs = cronJobs.filter((job) => {
    if (filter === 'enabled') return job.enabled;
    if (filter === 'disabled') return !job.enabled;
    return true;
  });

  const enabledCount = cronJobs.filter((j) => j.enabled).length;
  const runningCount = cronJobs.filter((j) => j.state?.runningAtMs).length;

  const handleDelete = async (id: string) => {
    await deleteCronJob(id);
    setDeleteConfirm(null);
  };

  return (
    <div className="min-h-screen">
      <Header
        title="Cron Jobs"
        description={`${cronJobs.length} jobs configured`}
        actions={
          <div className="flex items-center gap-2">
            {runningCount > 0 && (
              <Badge variant="default" className="bg-blue-500 animate-pulse">
                <Play className="h-3 w-3 mr-1" />
                {runningCount} running
              </Badge>
            )}
            <Badge variant={cronStatus?.enabled ? 'success' : 'secondary'}>
              {cronStatus?.enabled ? 'Scheduler Active' : 'Scheduler Paused'}
            </Badge>
          </div>
        }
      />

      <div className="p-6">
        {/* Stats */}
        <div className="grid gap-4 md:grid-cols-4 mb-6">
          <Card>
            <CardContent className="pt-6">
              <div className="text-2xl font-bold">{cronJobs.length}</div>
              <p className="text-xs text-muted-foreground">Total Jobs</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-6">
              <div className="text-2xl font-bold text-green-500">{enabledCount}</div>
              <p className="text-xs text-muted-foreground">Active</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-6">
              <div className="text-2xl font-bold text-muted-foreground">
                {cronJobs.length - enabledCount}
              </div>
              <p className="text-xs text-muted-foreground">Paused</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-6">
              <div className="text-2xl font-bold">
                {cronStatus?.nextWakeAtMs
                  ? formatTimestamp(cronStatus.nextWakeAtMs)
                  : 'N/A'}
              </div>
              <p className="text-xs text-muted-foreground">Next Wake</p>
            </CardContent>
          </Card>
        </div>

        {/* Filters */}
        <div className="flex items-center gap-2 mb-6">
          <span className="text-sm text-muted-foreground">Filter:</span>
          {(['all', 'enabled', 'disabled'] as const).map((f) => (
            <Button
              key={f}
              variant={filter === f ? 'default' : 'outline'}
              size="sm"
              onClick={() => setFilter(f)}
            >
              {f.charAt(0).toUpperCase() + f.slice(1)}
              {f === 'all' && ` (${cronJobs.length})`}
              {f === 'enabled' && ` (${enabledCount})`}
              {f === 'disabled' && ` (${cronJobs.length - enabledCount})`}
            </Button>
          ))}
        </div>

        {/* Jobs List */}
        {cronLoading ? (
          <div className="space-y-4">
            {[1, 2, 3].map((i) => (
              <Card key={i}>
                <CardContent className="py-6">
                  <div className="h-20 bg-muted animate-pulse rounded" />
                </CardContent>
              </Card>
            ))}
          </div>
        ) : filteredJobs.length === 0 ? (
          <Card className="py-16">
            <div className="text-center">
              <Clock className="h-16 w-16 mx-auto mb-4 text-muted-foreground opacity-30" />
              <h3 className="text-lg font-medium">No Cron Jobs</h3>
              <p className="text-muted-foreground mt-1">
                {filter !== 'all'
                  ? `No ${filter} jobs found`
                  : 'Configure cron jobs to automate agent tasks'}
              </p>
            </div>
          </Card>
        ) : (
          <div className="space-y-4">
            {filteredJobs.map((job) => (
              <CronJobCard
                key={job.id}
                job={job}
                onToggle={() => toggleCronJob(job.id, !job.enabled)}
                onRun={() => runCronJob(job.id)}
                onDelete={() => setDeleteConfirm(job.id)}
              />
            ))}
          </div>
        )}
      </div>

      {/* Delete Confirmation Modal */}
      {deleteConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div
            className="absolute inset-0 bg-background/80 backdrop-blur-sm"
            onClick={() => setDeleteConfirm(null)}
          />
          <Card className="relative z-10 w-full max-w-md mx-4">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-destructive">
                <Trash2 className="h-5 w-5" />
                Delete Cron Job
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <p className="text-muted-foreground">
                Are you sure you want to delete this cron job? This action cannot be undone.
              </p>
              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={() => setDeleteConfirm(null)}>
                  Cancel
                </Button>
                <Button
                  variant="destructive"
                  onClick={() => handleDelete(deleteConfirm)}
                >
                  Delete
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
