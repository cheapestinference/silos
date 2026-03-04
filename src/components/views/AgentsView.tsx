import * as React from 'react';
import { useDashboardStore } from '../../store/dashboard-store';
import { useTranslation } from '../../i18n';
import { Bot, Plus, Search, Grid, List } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { AgentCard, AgentConfigEditor } from '../agents';
import { Skeleton } from '../ui/skeleton';
import { cn } from '../../lib/utils';
import type { AgentSummary } from '../../types/openclaw';

export function AgentsView() {
  const { agents, sessions, agentsLoading, loadAgents, loadSessions, connected } = useDashboardStore();
  const { t } = useTranslation();
  const navigate = useNavigate();

  const [search, setSearch] = React.useState('');
  const [viewMode, setViewMode] = React.useState<'grid' | 'list'>('grid');
  const [configAgent, setConfigAgent] = React.useState<AgentSummary | null>(null);

  const agentList = agents?.agents || [];
  const sessionList = sessions?.sessions || [];

  // Filter agents based on search
  const filteredAgents = React.useMemo(() => {
    if (!search.trim()) return agentList;
    const query = search.toLowerCase();
    return agentList.filter(agent =>
      (agent.identity?.name || agent.name || agent.id).toLowerCase().includes(query) ||
      agent.id.toLowerCase().includes(query)
    );
  }, [agentList, search]);

  // Count sessions per agent
  const sessionCounts = React.useMemo(() => {
    const counts: Record<string, number> = {};
    sessionList.forEach(session => {
      // Extract agent ID from session key patterns
      const match = session.key.match(/agent:([^:]+):/);
      if (match) {
        counts[match[1]] = (counts[match[1]] || 0) + 1;
      }
    });
    return counts;
  }, [sessionList]);

  const handleChat = (agentId: string) => {
    navigate(`/agents/${agentId}`);
  };

  const handleConfigure = (agent: AgentSummary) => {
    setConfigAgent(agent);
  };

  // Load agents and sessions when component mounts
  React.useEffect(() => {
    if (connected) {
      loadAgents();
      loadSessions();
    }
  }, [connected, loadAgents, loadSessions]);

  return (
    <div className="flex flex-col h-full bg-background">
      {/* Compact Header */}
      <header className="px-5 py-3 border-b border-border bg-card shadow-sm flex items-center justify-between flex-shrink-0">
        <div>
          <h1 className="text-base font-semibold flex items-center gap-2">
            <Bot className="w-4 h-4 text-primary" />
            {t('agents.title')}
          </h1>
          <p className="text-xs text-muted-foreground">{t('agents.subtitle')}</p>
        </div>
        <Button size="sm" className="gap-1.5 h-7 text-xs bg-primary hover:bg-primary/90">
          <Plus className="w-3 h-3" />
          {t('agents.newAgent')}
        </Button>
      </header>

      {/* Compact Toolbar */}
      <div className="px-5 py-2.5 border-b border-border flex items-center gap-3">
        {/* Search */}
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('common.search')}
            className="pl-10"
          />
        </div>

        {/* View Mode Toggle */}
        <div className="flex items-center gap-1 bg-muted rounded-lg p-1">
          <button
            onClick={() => setViewMode('grid')}
            className={cn(
              'p-2 rounded-md transition-colors',
              viewMode === 'grid'
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground'
            )}
          >
            <Grid className="w-4 h-4" />
          </button>
          <button
            onClick={() => setViewMode('list')}
            className={cn(
              'p-2 rounded-md transition-colors',
              viewMode === 'list'
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground'
            )}
          >
            <List className="w-4 h-4" />
          </button>
        </div>

        {/* Agent count */}
        <span className="text-sm text-muted-foreground">
          {filteredAgents.length} {t('nav.agents').toLowerCase()}
        </span>
      </div>

      {/* Content */}
      <div className="flex-1 p-6 overflow-y-auto">
        {agentsLoading ? (
          // Loading state
          <div className={cn(
            'grid gap-4',
            viewMode === 'grid'
              ? 'grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4'
              : 'grid-cols-1'
          )}>
            {[...Array(6)].map((_, i) => (
              <div key={i} className="border border-border rounded-xl p-5 space-y-4">
                <div className="flex items-start gap-3">
                  <Skeleton className="w-14 h-14 rounded-xl" />
                  <div className="space-y-2 flex-1">
                    <Skeleton className="h-5 w-32" />
                    <Skeleton className="h-4 w-24" />
                  </div>
                </div>
                <div className="flex gap-2">
                  <Skeleton className="h-10 flex-1" />
                  <Skeleton className="h-10 w-10" />
                </div>
              </div>
            ))}
          </div>
        ) : filteredAgents.length === 0 ? (
          // Empty state
          <div className="flex flex-col items-center justify-center h-full text-center">
            <div className="w-20 h-20 rounded-2xl bg-indigo-500/10 flex items-center justify-center mb-4">
              <Bot className="w-10 h-10 text-indigo-500" />
            </div>
            <h3 className="text-lg font-semibold mb-1">{t('agents.noAgents')}</h3>
            <p className="text-sm text-muted-foreground max-w-sm mb-6">
              {search
                ? t('common.noResults')
                : 'Connect your first AI agent to start managing conversations and tasks.'
              }
            </p>
            {!search && (
              <Button className="gap-2 bg-indigo-600 hover:bg-indigo-700">
                <Plus className="w-4 h-4" />
                {t('agents.newAgent')}
              </Button>
            )}
          </div>
        ) : (
          // Agent grid/list
          <div className={cn(
            'grid gap-4',
            viewMode === 'grid'
              ? 'grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4'
              : 'grid-cols-1 max-w-2xl'
          )}>
            {filteredAgents.map(agent => (
              <AgentCard
                key={agent.id}
                agent={agent}
                sessionCount={sessionCounts[agent.id] || 0}
                isOnline={true}
                onChat={() => handleChat(agent.id)}
                onConfigure={() => handleConfigure(agent)}
              />
            ))}
          </div>
        )}
      </div>

      {/* Config Editor Modal */}
      <AgentConfigEditor
        agent={configAgent}
        open={!!configAgent}
        onOpenChange={(open) => !open && setConfigAgent(null)}
      />
    </div>
  );
}
