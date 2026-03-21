import {
  Radio,
  CheckCircle,
  XCircle,
  AlertTriangle,
  RefreshCw,
  Loader2,
} from 'lucide-react';
import { Header } from '../layout/Header';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '../ui/card';
import { Button } from '../ui/button';
import { Badge } from '../ui/badge';
import { useDashboardStore } from '../../store/dashboard-store';
import { cn, formatTimestamp } from '../../lib/utils';
import useTranslation from '../../i18n';

const channelIcons: Record<string, string> = {
  whatsapp: '📱',
  telegram: '✈️',
  discord: '🎮',
  slack: '💼',
  signal: '🔒',
  imessage: '💬',
  msteams: '👥',
  matrix: '🔗',
  nostr: '⚡',
  googlechat: '📧',
  line: '🟢',
  voice: '🎤',
};

function ChannelCard({
  channelId,
  label,
  accounts,
}: {
  channelId: string;
  label: string;
  accounts: Array<{
    accountId: string;
    name?: string | null;
    enabled?: boolean | null;
    configured?: boolean | null;
    connected?: boolean | null;
    running?: boolean | null;
    lastError?: string | null;
    lastConnectedAt?: number | null;
  }>;
}) {
  const { t } = useTranslation();
  const hasAccounts = accounts.length > 0;
  const connectedAccounts = accounts.filter((a) => a.connected);
  const runningAccounts = accounts.filter((a) => a.running);
  const hasErrors = accounts.some((a) => a.lastError);

  const overallStatus =
    connectedAccounts.length > 0
      ? 'connected'
      : runningAccounts.length > 0
      ? 'running'
      : hasErrors
      ? 'error'
      : hasAccounts
      ? 'configured'
      : 'not-configured';

  const statusColors = {
    connected: 'text-green-500 bg-green-500/10',
    running: 'text-blue-500 bg-blue-500/10',
    error: 'text-red-500 bg-red-500/10',
    configured: 'text-yellow-500 bg-yellow-500/10',
    'not-configured': 'text-muted-foreground bg-muted',
  };

  const StatusIcon =
    overallStatus === 'connected'
      ? CheckCircle
      : overallStatus === 'error'
      ? XCircle
      : overallStatus === 'running'
      ? Loader2
      : AlertTriangle;

  return (
    <Card className="hover:shadow-md transition-shadow">
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-3">
            <div className="text-3xl">{channelIcons[channelId] || '📡'}</div>
            <div>
              <CardTitle className="text-lg">{label}</CardTitle>
              <CardDescription className="capitalize">{channelId}</CardDescription>
            </div>
          </div>
          <Badge className={statusColors[overallStatus]}>
            <StatusIcon
              className={cn(
                'h-3 w-3 mr-1',
                overallStatus === 'running' && 'animate-spin'
              )}
            />
            {overallStatus === 'connected'
              ? t('channelsPage.statusConnected')
              : overallStatus === 'running'
              ? t('channelsPage.statusRunning')
              : overallStatus === 'error'
              ? t('channelsPage.statusError')
              : overallStatus === 'configured'
              ? t('channelsPage.statusConfigured')
              : t('channelsPage.statusNotConfigured')}
          </Badge>
        </div>
      </CardHeader>

      <CardContent>
        {!hasAccounts ? (
          <p className="text-sm text-muted-foreground">
            {t('channelsPage.noAccountsConfigured')}
          </p>
        ) : (
          <div className="space-y-3">
            {accounts.map((account) => (
              <div
                key={account.accountId}
                className="flex items-center justify-between p-3 rounded-lg bg-muted/40"
              >
                <div className="flex items-center gap-3">
                  <div
                    className={cn(
                      'h-2 w-2 rounded-full',
                      account.connected
                        ? 'bg-green-500'
                        : account.running
                        ? 'bg-blue-500 animate-pulse'
                        : account.lastError
                        ? 'bg-red-500'
                        : 'bg-muted-foreground'
                    )}
                  />
                  <div>
                    <p className="text-sm font-medium">
                      {account.name || account.accountId}
                    </p>
                    {account.lastConnectedAt && (
                      <p className="text-xs text-muted-foreground">
                        {t('channelsPage.lastConnected')} {formatTimestamp(account.lastConnectedAt)}
                      </p>
                    )}
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  {account.lastError && (
                    <Badge variant="destructive" className="text-xs">
                      {t('channelsPage.statusError')}
                    </Badge>
                  )}
                  {account.enabled === false && (
                    <Badge variant="secondary" className="text-xs">
                      {t('channelsPage.disabled')}
                    </Badge>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}

        {hasErrors && (
          <div className="mt-3 p-3 bg-red-500/10 rounded-lg">
            <p className="text-xs text-red-500 font-medium mb-1">{t('channelsPage.latestError')}</p>
            <p className="text-sm text-red-500">
              {accounts.find((a) => a.lastError)?.lastError}
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function ChannelsPage() {
  const { t } = useTranslation();
  const { channels, channelsLoading, loadChannels } = useDashboardStore();

  const channelList = channels?.channelOrder || [];
  const channelLabels = channels?.channelLabels || {};
  const channelAccounts = channels?.channelAccounts || {};

  const totalChannels = channelList.length;
  const connectedChannels = Object.values(channelAccounts)
    .flat()
    .filter((a) => a.connected).length;
  const totalAccounts = Object.values(channelAccounts).flat().length;

  return (
    <div className="min-h-screen">
      <Header
        title={t('nav.channels')}
        description={t('channelsPage.description')}
        actions={
          <Button variant="outline" size="sm" onClick={() => loadChannels()}>
            <RefreshCw className={cn('h-4 w-4 mr-2', channelsLoading && 'animate-spin')} />
            {t('channelsPage.refresh')}
          </Button>
        }
      />

      <div className="p-6">
        {/* Stats */}
        <div className="grid gap-4 md:grid-cols-3 mb-6">
          <Card>
            <CardContent className="pt-6">
              <div className="text-2xl font-bold">{totalChannels}</div>
              <p className="text-xs text-muted-foreground">{t('channelsPage.availableChannels')}</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-6">
              <div className="text-2xl font-bold">{totalAccounts}</div>
              <p className="text-xs text-muted-foreground">{t('channelsPage.configuredAccounts')}</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-6">
              <div className="text-2xl font-bold text-green-500">{connectedChannels}</div>
              <p className="text-xs text-muted-foreground">{t('channelsPage.connected')}</p>
            </CardContent>
          </Card>
        </div>

        {/* Channels Grid */}
        {channelsLoading ? (
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {[1, 2, 3, 4, 5, 6].map((i) => (
              <Card key={i}>
                <CardContent className="py-6">
                  <div className="h-32 bg-muted animate-pulse rounded" />
                </CardContent>
              </Card>
            ))}
          </div>
        ) : channelList.length === 0 ? (
          <Card className="py-16">
            <div className="text-center">
              <Radio className="h-16 w-16 mx-auto mb-4 text-muted-foreground opacity-30" />
              <h3 className="text-lg font-medium">{t('channelsPage.noChannels')}</h3>
              <p className="text-muted-foreground mt-1">
                {t('channelsPage.noChannelsDescription')}
              </p>
            </div>
          </Card>
        ) : (
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {channelList.map((channelId) => (
              <ChannelCard
                key={channelId}
                channelId={channelId}
                label={channelLabels[channelId] || channelId}
                accounts={channelAccounts[channelId] || []}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
