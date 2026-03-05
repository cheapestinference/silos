import { useState, useEffect } from 'react';
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
  Edit3,
  Bot,
  History,
  Loader2,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '../ui/card';
import { Button } from '../ui/button';
import { Badge } from '../ui/badge';
import { cn, formatTimestamp, formatDuration } from '../../lib/utils';
import type { CronJob, CronSchedule, CronRunLogEntry } from '../../types/openclaw';

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

interface CronJobCardProps {
  job: CronJob;
  onToggle: () => void;
  onRun: () => void;
  onEdit?: () => void;
  onDelete: () => void;
  onLoadRuns?: (jobId: string) => Promise<CronRunLogEntry[]>;
  compact?: boolean;
  showAgentInfo?: boolean;
  agentName?: string;
}

export function CronJobCard({
  job,
  onToggle,
  onRun,
  onEdit,
  onDelete,
  onLoadRuns,
  compact = false,
  showAgentInfo = false,
  agentName,
}: CronJobCardProps) {
  const [expanded, setExpanded] = useState(false);
  const [showMenu, setShowMenu] = useState(false);
  const [runs, setRuns] = useState<CronRunLogEntry[]>([]);
  const [runsLoading, setRunsLoading] = useState(false);
  const [runsLoaded, setRunsLoaded] = useState(false);

  // Load runs when expanded
  useEffect(() => {
    if (expanded && !runsLoaded && onLoadRuns) {
      setRunsLoading(true);
      onLoadRuns(job.id)
        .then((loadedRuns) => {
          setRuns(loadedRuns);
          setRunsLoaded(true);
        })
        .catch((err) => {
          console.error('[CronJobCard] Failed to load runs:', err);
        })
        .finally(() => {
          setRunsLoading(false);
        });
    }
  }, [expanded, runsLoaded, onLoadRuns, job.id]);

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

  if (compact) {
    return (
      <div
        className={cn(
          'p-3 rounded-lg border transition-all',
          !job.enabled && 'opacity-60',
          isRunning ? 'border-blue-500/50 bg-blue-500/5' : 'border-border bg-card/30'
        )}
      >
        <div className="flex items-center gap-3">
          <div className={cn(
            'p-1.5 rounded-lg',
            job.enabled ? 'bg-primary/10' : 'bg-muted'
          )}>
            <ScheduleIcon className={cn(
              'h-4 w-4',
              job.enabled ? 'text-primary' : 'text-muted-foreground'
            )} />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-foreground truncate">{job.name}</p>
            <p className="text-xs text-muted-foreground">{getScheduleDescription(job.schedule)}</p>
          </div>
          {isRunning && (
            <Badge variant="default" className="bg-blue-500 animate-pulse text-[10px]">
              Running
            </Badge>
          )}
          <Button
            variant="ghost"
            size="icon"
            onClick={() => {
              console.log('[CronJobCard] Toggle clicked, job:', job.id, 'current enabled:', job.enabled);
              onToggle();
            }}
            className={cn(
              'h-7 w-7',
              job.enabled ? 'text-green-500' : 'text-muted-foreground'
            )}
          >
            {job.enabled ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
          </Button>
        </div>
      </div>
    );
  }

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
              {showAgentInfo && job.agentId && (
                <div className="flex items-center gap-1.5 mt-1">
                  <Bot className="h-3 w-3 text-violet-400" />
                  <span className="text-xs text-violet-400">{agentName || job.agentId}</span>
                </div>
              )}
            </div>
          </div>

          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="icon"
              onClick={() => {
                console.log('[CronJobCard] Toggle clicked (full), job:', job.id, 'current enabled:', job.enabled);
                onToggle();
              }}
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
                    {onEdit && (
                      <button
                        className="w-full px-3 py-2 text-sm text-left hover:bg-muted flex items-center gap-2"
                        onClick={() => {
                          onEdit();
                          setShowMenu(false);
                        }}
                      >
                        <Edit3 className="h-4 w-4" />
                        Edit
                      </button>
                    )}
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
                <div className="text-sm font-mono">
                  {job.payload.kind === 'systemEvent' ? (
                    <>
                      <Badge variant="secondary" className="mb-2">System Event</Badge>
                      <div className="mt-1">{job.payload.text}</div>
                    </>
                  ) : (
                    <>
                      <Badge variant="secondary" className="mb-2">Agent Turn</Badge>
                      <div className="mt-1">{job.payload.message}</div>
                    </>
                  )}
                </div>
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

            {/* Recent Executions - only show if there are runs */}
            {onLoadRuns && runs.length > 0 && (
              <div>
                <div className="flex items-center gap-2 mb-2">
                  <History className="h-4 w-4 text-muted-foreground" />
                  <p className="text-xs text-muted-foreground font-medium">Recent Executions</p>
                </div>
                <div className="space-y-1.5">
                  {runs.slice(0, 5).map((run, idx) => (
                    <div
                      key={`${run.ts}-${idx}`}
                      className="flex items-center justify-between text-xs py-1 px-2 rounded bg-muted/30"
                    >
                      <div className="flex items-center gap-2">
                        {run.status === 'ok' && <CheckCircle className="h-3 w-3 text-green-500" />}
                        {run.status === 'error' && <XCircle className="h-3 w-3 text-red-500" />}
                        {run.status === 'skipped' && <AlertTriangle className="h-3 w-3 text-yellow-500" />}
                        <span className="text-muted-foreground">
                          {new Date(run.ts).toLocaleString()}
                        </span>
                        {run.summary && (
                          <span className="text-muted-foreground truncate max-w-[150px]">· {run.summary}</span>
                        )}
                      </div>
                      {run.error && (
                        <span className="text-red-600 dark:text-red-400 truncate max-w-[100px]">{run.error}</span>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
            {/* Loading indicator for runs */}
            {onLoadRuns && runsLoading && (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Loader2 className="h-3 w-3 animate-spin" />
                <span>Loading history...</span>
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
