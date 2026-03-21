import { useState } from 'react';
import {
  Users,
  Bot,
  Search,
  MoreVertical,
  MessageSquare,
  Globe,
  User,
} from 'lucide-react';
import { Header } from '../layout/Header';
import { Card, CardContent, CardHeader, CardTitle } from '../ui/card';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Badge } from '../ui/badge';
import { Avatar } from '../ui/avatar';
import { ScrollArea } from '../ui/scroll-area';
import { useDashboardStore } from '../../store/dashboard-store';
import { cn, getAgentDisplayName } from '../../lib/utils';
import useTranslation from '../../i18n';
import type { AgentSummary } from '../../types/openclaw';

function AgentCard({
  agent,
  isDefault,
  isSelected,
  onSelect,
}: {
  agent: AgentSummary;
  isDefault: boolean;
  isSelected: boolean;
  onSelect: () => void;
}) {
  const { t } = useTranslation();
  const displayName = getAgentDisplayName(agent);
  const emoji = agent.identity?.emoji;
  const avatar = agent.identity?.avatarUrl || agent.identity?.avatar;

  return (
    <div
      className={cn(
        'group relative p-4 rounded-xl border-2 cursor-pointer transition-all duration-200',
        isSelected
          ? 'border-primary bg-primary/5'
          : 'border-transparent bg-card hover:border-muted hover:shadow-md'
      )}
      onClick={onSelect}
    >
      <div className="flex items-start gap-4">
        <div className="relative">
          {avatar ? (
            <Avatar src={avatar} alt={displayName} size="lg" />
          ) : (
            <div className="h-12 w-12 rounded-full bg-primary/10 flex items-center justify-center text-2xl">
              {emoji || <Bot className="h-6 w-6 text-primary" />}
            </div>
          )}
          {isDefault && (
            <div className="absolute -bottom-1 -right-1 h-5 w-5 rounded-full bg-primary flex items-center justify-center">
              <span className="text-[10px] text-primary-foreground font-bold">D</span>
            </div>
          )}
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="font-semibold truncate">{displayName}</h3>
            {isDefault && (
              <Badge variant="default" className="text-[10px]">{t('agents.default')}</Badge>
            )}
          </div>
          <p className="text-sm text-muted-foreground truncate">{t('agents.agentId')}: {agent.id}</p>
          {agent.identity?.theme && (
            <Badge variant="secondary" className="mt-2 text-xs">
              {agent.identity.theme}
            </Badge>
          )}
        </div>

        <Button variant="ghost" size="icon" className="opacity-0 group-hover:opacity-100">
          <MoreVertical className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}

function AgentDetails({ agent }: { agent: AgentSummary }) {
  const { t } = useTranslation();
  const { sessions } = useDashboardStore();
  const displayName = getAgentDisplayName(agent);
  const emoji = agent.identity?.emoji;
  const avatar = agent.identity?.avatarUrl || agent.identity?.avatar;

  // Find sessions associated with this agent
  const agentSessions = sessions?.sessions.filter(
    (s) => s.key.includes(agent.id) || s.sessionId?.includes(agent.id)
  ) || [];

  return (
    <div className="space-y-6">
      {/* Agent Header */}
      <div className="flex items-start gap-4 p-6 bg-gradient-to-br from-primary/10 to-transparent rounded-xl">
        {avatar ? (
          <Avatar src={avatar} alt={displayName} className="h-20 w-20" />
        ) : (
          <div className="h-20 w-20 rounded-full bg-primary/20 flex items-center justify-center text-4xl">
            {emoji || <Bot className="h-10 w-10 text-primary" />}
          </div>
        )}
        <div className="flex-1">
          <h2 className="text-2xl font-bold">{displayName}</h2>
          <p className="text-muted-foreground">{t('agents.agentId')}: {agent.id}</p>
          {agent.identity?.theme && (
            <Badge variant="secondary" className="mt-2">
              {t('agents.theme')}: {agent.identity.theme}
            </Badge>
          )}
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-4">
        <Card>
          <CardContent className="pt-6">
            <div className="text-2xl font-bold">{agentSessions.length}</div>
            <p className="text-xs text-muted-foreground">{t('agents.totalSessions')}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="text-2xl font-bold">
              {agentSessions.filter((s) => s.kind === 'direct').length}
            </div>
            <p className="text-xs text-muted-foreground">{t('agents.directChats')}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="text-2xl font-bold">
              {agentSessions.filter((s) => s.kind === 'group').length}
            </div>
            <p className="text-xs text-muted-foreground">{t('agents.groupChats')}</p>
          </CardContent>
        </Card>
      </div>

      {/* Identity Details */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">{t('agents.identity')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <p className="text-sm text-muted-foreground">{t('agents.name')}</p>
              <p className="font-medium">{agent.identity?.name || agent.name || t('agents.notSet')}</p>
            </div>
            <div>
              <p className="text-sm text-muted-foreground">{t('agents.emoji')}</p>
              <p className="font-medium text-2xl">{agent.identity?.emoji || '-'}</p>
            </div>
            <div>
              <p className="text-sm text-muted-foreground">{t('agents.theme')}</p>
              <p className="font-medium">{agent.identity?.theme || t('agents.default')}</p>
            </div>
            <div>
              <p className="text-sm text-muted-foreground">{t('agents.avatar')}</p>
              <p className="font-medium truncate">{agent.identity?.avatar || t('agents.notSet')}</p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Recent Sessions */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg flex items-center gap-2">
            <MessageSquare className="h-4 w-4" />
            {t('agents.recentSessions')}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {agentSessions.length === 0 ? (
            <p className="text-center text-muted-foreground py-4">{t('agents.noSessionsFound')}</p>
          ) : (
            <div className="space-y-2">
              {agentSessions.slice(0, 5).map((session) => (
                <div
                  key={session.key}
                  className="flex items-center justify-between p-3 rounded-lg bg-muted/40"
                >
                  <div>
                    <p className="font-medium text-sm">
                      {session.displayName || session.label || session.key}
                    </p>
                    <p className="text-xs text-muted-foreground">{session.surface || t('sessions.direct')}</p>
                  </div>
                  <Badge variant={session.kind === 'direct' ? 'default' : 'secondary'}>
                    {session.kind}
                  </Badge>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

export function AgentsPage() {
  const { t } = useTranslation();
  const { agents, agentsLoading } = useDashboardStore();
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');

  const filteredAgents = agents?.agents.filter((agent) => {
    const name = getAgentDisplayName(agent).toLowerCase();
    const id = agent.id.toLowerCase();
    const query = searchQuery.toLowerCase();
    return name.includes(query) || id.includes(query);
  }) || [];

  const selectedAgent = filteredAgents.find((a) => a.id === selectedAgentId);

  return (
    <div className="min-h-screen">
      <Header
        title={t('agents.title')}
        description={t('agents.agentsConfigured', { count: String(agents?.agents.length || 0) })}
        actions={
          <div className="flex items-center gap-2">
            <Badge variant={agents?.scope === 'global' ? 'default' : 'secondary'}>
              {agents?.scope === 'global' ? (
                <><Globe className="h-3 w-3 mr-1" /> {t('agents.scopeGlobal')}</>
              ) : (
                <><User className="h-3 w-3 mr-1" /> {t('agents.scopePerSender')}</>
              )}
            </Badge>
          </div>
        }
      />

      <div className="p-6">
        <div className="flex gap-6">
          {/* Agents List */}
          <div className="w-96 shrink-0">
            <Card className="sticky top-24">
              <CardHeader className="pb-4">
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                  <Input
                    placeholder={t('agents.searchAgents')}
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="pl-10"
                  />
                </div>
              </CardHeader>
              <CardContent className="p-0">
                <ScrollArea className="h-[calc(100vh-280px)]">
                  <div className="p-4 space-y-2">
                    {agentsLoading ? (
                      <div className="space-y-2">
                        {[1, 2, 3].map((i) => (
                          <div key={i} className="h-24 rounded-xl bg-muted animate-pulse" />
                        ))}
                      </div>
                    ) : filteredAgents.length === 0 ? (
                      <div className="text-center py-8">
                        <Users className="h-8 w-8 mx-auto mb-2 text-muted-foreground opacity-50" />
                        <p className="text-muted-foreground">
                          {searchQuery ? t('agents.noAgentsFound') : t('agents.noAgentsConfigured')}
                        </p>
                      </div>
                    ) : (
                      filteredAgents.map((agent) => (
                        <AgentCard
                          key={agent.id}
                          agent={agent}
                          isDefault={agent.id === agents?.defaultId}
                          isSelected={agent.id === selectedAgentId}
                          onSelect={() => setSelectedAgentId(agent.id)}
                        />
                      ))
                    )}
                  </div>
                </ScrollArea>
              </CardContent>
            </Card>
          </div>

          {/* Agent Details */}
          <div className="flex-1 min-w-0">
            {selectedAgent ? (
              <AgentDetails agent={selectedAgent} />
            ) : (
              <Card className="h-[calc(100vh-200px)] flex items-center justify-center">
                <div className="text-center">
                  <Bot className="h-16 w-16 mx-auto mb-4 text-muted-foreground opacity-30" />
                  <h3 className="text-lg font-medium">{t('agents.selectAgent')}</h3>
                  <p className="text-muted-foreground mt-1">
                    {t('agents.selectAgentDesc')}
                  </p>
                </div>
              </Card>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
