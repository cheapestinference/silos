import { useEffect } from 'react';
import { useParams, useNavigate, useLocation, Outlet } from 'react-router-dom';
import { useDashboardStore } from '../../store/dashboard-store';
import {
  ArrowLeft,
  Bot,
  Brain,
  Wrench,
  Settings,
  Activity,
  MessageSquare,
  Cpu,
  Gauge,
  Sparkles,
  BookOpen,
  CalendarClock,
  FolderOpen,
} from 'lucide-react';
import useTranslation from '../../i18n';
import { StatCard, TabButton } from './shared';

export function AgentDetailView() {
  const { t } = useTranslation();
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const {
    agents,
    sessions,
    tasks,
    loadAgents,
    loadSessions,
    connected,
    loadAgentConfig,
    cronJobs,
    gatewayConfig,
  } = useDashboardStore();

  useEffect(() => {
    if (connected) {
      loadAgents();
      loadSessions();
      if (id) loadAgentConfig(id);
    }
  }, [connected, loadAgents, loadSessions, loadAgentConfig, id]);

  if (!id) {
    navigate('/');
    return null;
  }

  const agent = agents?.agents.find(a => a.id === id);
  const agentSessions = sessions?.sessions.filter(s => s.key.includes(id)) || [];
  const agentTasks = tasks.filter(t => {
    return t.agentId === id || t.sessionKey?.startsWith(`agent:${id}:`);
  });
  const runningTasks = agentTasks.filter(t => t.status === 'running').length;
  const completedTasks = agentTasks.filter(t => t.status === 'completed').length;
  const agentCronJobs = cronJobs.filter(j => j.agentId === id);

  if (!agent) {
    return (
      <div className="h-full flex items-center justify-center bg-background">
        <div className="text-center animate-in fade-in zoom-in duration-300">
          <div className="w-20 h-20 rounded-2xl bg-gradient-to-br from-primary/10 to-accent/10 border border-primary/20 flex items-center justify-center mx-auto mb-4">
            <Bot className="w-10 h-10 text-primary/40" />
          </div>
          <p className="text-sm text-muted-foreground mb-1">{t('agentDetail.agentNotFound')}</p>
          <p className="text-xs text-muted-foreground">{t('agentDetail.agentNotFoundDescription')}</p>
        </div>
      </div>
    );
  }

  const agentName = agent.identity?.name || agent.name || agent.id;
  const agentEmoji = agent.identity?.emoji;
  const agentsCfg = (gatewayConfig?.config as Record<string, unknown>)?.agents as
    { defaults?: { model?: { primary?: string } }; list?: Array<{ id: string; model?: string | { primary?: string } }> } | undefined;
  const headerAgentEntry = agentsCfg?.list?.find(a => a.id === id);
  const headerAgentOverride = headerAgentEntry?.model
    ? (typeof headerAgentEntry.model === 'string' ? headerAgentEntry.model : headerAgentEntry.model.primary || '')
    : '';
  const model = headerAgentOverride || agentsCfg?.defaults?.model?.primary || 'Not configured';
  const isOnline = true;

  // Determine active tab from URL path
  const pathSuffix = location.pathname.replace(`/agents/${id}`, '').replace(/^\//, '');
  const activeTab = pathSuffix || 'overview';

  const navigateTab = (tab: string) => {
    navigate(tab === 'overview' ? `/agents/${id}` : `/agents/${id}/${tab}`);
  };


  return (
    <div className="h-full flex flex-col bg-background overflow-hidden">
      {/* Header */}
      <header className="shrink-0 border-b border-border bg-gradient-to-b from-muted/60 to-transparent">
        <div className="h-[1px] bg-gradient-to-r from-transparent via-primary/20 to-transparent" />
        <div className="px-6 py-4">
          <div className="flex items-center gap-4 mb-4">
            <button
              onClick={() => navigate('/')}
              className="p-2 rounded-xl bg-muted border border-border hover:border-border hover:bg-muted transition-all text-muted-foreground hover:text-foreground group"
            >
              <ArrowLeft className="w-4 h-4 group-hover:-translate-x-0.5 transition-transform" />
            </button>

            <div className="flex-1">
              <div className="flex items-center gap-4">
                <div className="relative">
                  <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-primary/20 via-primary/15 to-accent/20 border border-primary/20 flex items-center justify-center shadow-lg shadow-elevation-1">
                    {agentEmoji ? (
                      <span className="text-2xl">{agentEmoji}</span>
                    ) : (
                      <Bot className="w-7 h-7 text-primary" />
                    )}
                  </div>
                  {isOnline && (
                    <div className="absolute -bottom-0.5 -right-0.5 w-4 h-4 bg-emerald-400 rounded-full border-2 border-background flex items-center justify-center">
                      <span className="w-2 h-2 bg-emerald-400 rounded-full animate-ping absolute" />
                    </div>
                  )}
                </div>
                <div>
                  <h1 className="text-xl font-bold text-foreground mb-0.5" style={{ fontFamily: 'Inter, system-ui, sans-serif' }}>
                    {agentName}
                  </h1>
                  <div className="flex items-center gap-3">
                    <span className="flex items-center gap-1.5 text-xs text-muted-foreground font-mono">
                      <Cpu className="w-3 h-3" />
                      {model}
                    </span>
                    <span className="w-1 h-1 rounded-full bg-muted-foreground" />
                    <span className="text-xs text-muted-foreground font-mono">{id}</span>
                  </div>
                </div>
              </div>
            </div>

            <div className="flex items-center gap-3">
              <StatCard icon={<Activity className="w-3.5 h-3.5" />} value={runningTasks} label={t('agentDetail.active')} color="cyan" pulse={runningTasks > 0} />
              <StatCard icon={<MessageSquare className="w-3.5 h-3.5" />} value={agentSessions.length} label={t('agentDetail.sessions')} color="violet" />
              <StatCard icon={<Sparkles className="w-3.5 h-3.5" />} value={completedTasks} label={t('agentDetail.done')} color="emerald" />
            </div>
          </div>

          {/* Tab Navigation */}
          <div className="flex items-center gap-1 p-1 bg-muted rounded-xl border border-border w-fit">
            <TabButton active={activeTab === 'overview'} onClick={() => navigateTab('overview')} icon={<Gauge className="w-3.5 h-3.5" />} label={t('agentDetail.overview')} />
            <TabButton active={activeTab === 'brain'} onClick={() => navigateTab('brain')} icon={<Brain className="w-3.5 h-3.5" />} label={t('agentDetail.memory')} />
            <TabButton active={activeTab === 'workspace'} onClick={() => navigateTab('workspace')} icon={<FolderOpen className="w-3.5 h-3.5" />} label={t('agentDetail.workspace')} />
            <TabButton active={activeTab === 'tools'} onClick={() => navigateTab('tools')} icon={<Wrench className="w-3.5 h-3.5" />} label={t('agentDetail.tools')} />
            <TabButton active={activeTab === 'skills'} onClick={() => navigateTab('skills')} icon={<Sparkles className="w-3.5 h-3.5" />} label={t('agentDetail.skills')} />
            <TabButton active={activeTab === 'knowledge'} onClick={() => navigateTab('knowledge')} icon={<BookOpen className="w-3.5 h-3.5" />} label={t('agentDetail.knowledgeTab')} />
            <TabButton active={activeTab === 'scheduled'} onClick={() => navigateTab('scheduled')} icon={<CalendarClock className="w-3.5 h-3.5" />} label={t('agentDetail.automation')} badge={agentCronJobs.length > 0 ? agentCronJobs.length : undefined} />
            <TabButton active={activeTab === 'config'} onClick={() => navigateTab('config')} icon={<Settings className="w-3.5 h-3.5" />} label={t('agentDetail.config')} />
          </div>
        </div>
      </header>

      {/* Content Area — rendered by nested routes via <Outlet> */}
      <div className="flex-1 overflow-hidden">
        <Outlet />
      </div>

    </div>
  );
}
