import {
  Users,
  MessageSquare,
  Clock,
  Activity,
  TrendingUp,
  Radio,
  CheckCircle,
  XCircle,
  AlertCircle,
} from 'lucide-react';
import { Header } from '../layout/Header';
import { Card, CardContent, CardHeader, CardTitle } from '../ui/card';
import { Badge } from '../ui/badge';
import { useDashboardStore } from '../../store/dashboard-store';
import { cn, formatTimestamp } from '../../lib/utils';
import useTranslation from '../../i18n';

function StatCard({
  title,
  value,
  description,
  icon: Icon,
  trend,
  className,
}: {
  title: string;
  value: string | number;
  description?: string;
  icon: React.ElementType;
  trend?: { value: number; label: string };
  className?: string;
}) {
  return (
    <Card className={cn('relative overflow-hidden', className)}>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">{title}</CardTitle>
        <Icon className="h-4 w-4 text-muted-foreground" />
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-bold">{value}</div>
        {description && (
          <p className="text-xs text-muted-foreground mt-1">{description}</p>
        )}
        {trend && (
          <div className="flex items-center gap-1 mt-2">
            <TrendingUp className={cn('h-3 w-3', trend.value >= 0 ? 'text-green-500' : 'text-red-500')} />
            <span className={cn('text-xs', trend.value >= 0 ? 'text-green-500' : 'text-red-500')}>
              {trend.value >= 0 ? '+' : ''}{trend.value}%
            </span>
            <span className="text-xs text-muted-foreground">{trend.label}</span>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function RecentSessionsList() {
  const { t } = useTranslation();
  const { sessions } = useDashboardStore();
  const recentSessions = sessions?.sessions.slice(0, 5) || [];

  if (recentSessions.length === 0) {
    return (
      <div className="text-center py-8 text-muted-foreground">
        <MessageSquare className="h-8 w-8 mx-auto mb-2 opacity-50" />
        <p>{t('dashboard.noSessionsYet')}</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {recentSessions.map((session) => (
        <div
          key={session.key}
          className="flex items-center justify-between p-3 rounded-lg bg-muted/40 hover:bg-muted transition-colors"
        >
          <div className="flex items-center gap-3">
            <div className={cn(
              'h-2 w-2 rounded-full',
              session.abortedLastRun ? 'bg-red-500' : 'bg-green-500'
            )} />
            <div>
              <p className="text-sm font-medium">{session.displayName || session.label || session.key}</p>
              <p className="text-xs text-muted-foreground">{session.surface || t('dashboard.direct')}</p>
            </div>
          </div>
          <div className="text-right">
            <Badge variant={session.kind === 'direct' ? 'default' : 'secondary'}>
              {session.kind}
            </Badge>
            <p className="text-xs text-muted-foreground mt-1">
              {formatTimestamp(session.updatedAt)}
            </p>
          </div>
        </div>
      ))}
    </div>
  );
}

function CronJobsList() {
  const { t } = useTranslation();
  const { cronJobs } = useDashboardStore();
  const activeJobs = cronJobs.filter((j) => j.enabled).slice(0, 5);

  if (activeJobs.length === 0) {
    return (
      <div className="text-center py-8 text-muted-foreground">
        <Clock className="h-8 w-8 mx-auto mb-2 opacity-50" />
        <p>{t('dashboard.noActiveCronJobs')}</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {activeJobs.map((job) => (
        <div
          key={job.id}
          className="flex items-center justify-between p-3 rounded-lg bg-muted/40 hover:bg-muted transition-colors"
        >
          <div className="flex items-center gap-3">
            {job.state?.lastStatus === 'ok' ? (
              <CheckCircle className="h-4 w-4 text-green-500" />
            ) : job.state?.lastStatus === 'error' ? (
              <XCircle className="h-4 w-4 text-red-500" />
            ) : (
              <AlertCircle className="h-4 w-4 text-yellow-500" />
            )}
            <div>
              <p className="text-sm font-medium">{job.name}</p>
              <p className="text-xs text-muted-foreground">
                {job.schedule.kind === 'cron' && job.schedule.expr}
                {job.schedule.kind === 'every' && t('dashboard.everyXm', { count: String(Math.round(job.schedule.everyMs / 60000)) })}
                {job.schedule.kind === 'at' && t('dashboard.atTime', { time: new Date(job.schedule.atMs).toLocaleTimeString() })}
              </p>
            </div>
          </div>
          <div className="text-right text-xs text-muted-foreground">
            {job.state?.nextRunAtMs ? (
              <span>{t('dashboard.nextRun', { time: formatTimestamp(job.state.nextRunAtMs) })}</span>
            ) : (
              <span>{t('dashboard.noSchedule')}</span>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

function TasksOverview() {
  const { t } = useTranslation();
  const { tasks } = useDashboardStore();

  const pending = tasks.filter((task) => task.status === 'pending').length;
  const running = tasks.filter((task) => task.status === 'running').length;
  const completed = tasks.filter((task) => task.status === 'completed').length;
  const failed = tasks.filter((task) => task.status === 'error' || task.status === 'aborted').length;

  return (
    <div className="grid grid-cols-4 gap-4">
      <div className="text-center p-4 rounded-lg bg-muted/40">
        <div className="text-2xl font-bold text-yellow-500">{pending}</div>
        <div className="text-xs text-muted-foreground">{t('dashboard.pending')}</div>
      </div>
      <div className="text-center p-4 rounded-lg bg-muted/40">
        <div className="text-2xl font-bold text-blue-500">{running}</div>
        <div className="text-xs text-muted-foreground">{t('dashboard.running')}</div>
      </div>
      <div className="text-center p-4 rounded-lg bg-muted/40">
        <div className="text-2xl font-bold text-green-500">{completed}</div>
        <div className="text-xs text-muted-foreground">{t('dashboard.completed')}</div>
      </div>
      <div className="text-center p-4 rounded-lg bg-muted/40">
        <div className="text-2xl font-bold text-red-500">{failed}</div>
        <div className="text-xs text-muted-foreground">{t('dashboard.failed')}</div>
      </div>
    </div>
  );
}

export function DashboardPage() {
  const { t } = useTranslation();
  const { agents, sessions, cronJobs, channels } = useDashboardStore();

  const activeAgents = agents?.agents.length || 0;
  const activeSessions = sessions?.sessions.filter((s) => s.updatedAt && Date.now() - s.updatedAt < 86400000).length || 0;
  const totalSessions = sessions?.count || 0;
  const activeCronJobs = cronJobs.filter((j) => j.enabled).length;

  const channelCount = channels?.channelOrder.length || 0;
  const connectedChannels = channels
    ? Object.values(channels.channelAccounts).flat().filter((a) => a.connected).length
    : 0;

  return (
    <div className="min-h-screen">
      <Header
        title={t('dashboard.title')}
        description={t('dashboard.description')}
      />

      <div className="p-6 space-y-6">
        {/* Stats Grid */}
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          <StatCard
            title={t('dashboard.activeAgents')}
            value={activeAgents}
            description={t('dashboard.aiAgentsConfigured')}
            icon={Users}
          />
          <StatCard
            title={t('dashboard.sessionsLabel')}
            value={`${activeSessions} / ${totalSessions}`}
            description={t('dashboard.activeIn24h')}
            icon={MessageSquare}
          />
          <StatCard
            title={t('dashboard.cronJobs')}
            value={`${activeCronJobs} ${t('dashboard.active')}`}
            description={t('dashboard.totalConfigured', { count: String(cronJobs.length) })}
            icon={Clock}
          />
          <StatCard
            title={t('dashboard.channels')}
            value={`${connectedChannels} / ${channelCount}`}
            description={t('dashboard.connectedChannels')}
            icon={Radio}
          />
        </div>

        {/* Tasks Overview */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Activity className="h-5 w-5" />
              {t('dashboard.tasksOverview')}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <TasksOverview />
          </CardContent>
        </Card>

        {/* Two Column Grid */}
        <div className="grid gap-6 lg:grid-cols-2">
          {/* Recent Sessions */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <MessageSquare className="h-5 w-5" />
                {t('dashboard.recentSessions')}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <RecentSessionsList />
            </CardContent>
          </Card>

          {/* Active Cron Jobs */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Clock className="h-5 w-5" />
                {t('dashboard.activeCronJobs')}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <CronJobsList />
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
