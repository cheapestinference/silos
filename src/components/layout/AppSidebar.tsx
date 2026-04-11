import { useState, useEffect } from 'react';
import { useDashboardStore } from '../../store/dashboard-store';
import { useTranslation } from '../../i18n';
import {
  Home,
  Settings,
  Bot,
  ListTodo,
  Plus,
  Check,
  X,
  ScrollText,
} from 'lucide-react';
import { useNavigate, useLocation } from 'react-router-dom';
import { CreateAgentModal } from '../modals/CreateAgentModal';
import { CreateChannelModal } from '../modals/CreateChannelModal';
import { UsageBar } from './UsageBar';
import { parseSessionKey, isSystemSession } from '../../lib/session-utils';
import type { ParsedSession } from '../../lib/session-utils';
import { NavItem } from '../sidebar/NavItem';
import { AgentItem } from '../sidebar/AgentItem';
import { SessionItem } from '../sidebar/SessionItem';
import { SubagentGroup } from '../sidebar/SubagentGroup';
import { ProfileMenu } from '../sidebar/ProfileMenu';

export function AppSidebar() {
  const {
    agents,
    sessions,
    connected,
    tasks,
    selectedSessionKey,
    loadAgents,
    loadSessions,
    loadGatewayConfig,
    patchSession,
    deleteSession,
    addSessionOptimistic,
    unreadCounts,
  } = useDashboardStore();
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();

  const [createAgentModalOpen, setCreateAgentModalOpen] = useState(false);
  const [createChannelModalOpen, setCreateChannelModalOpen] = useState(false);

  useEffect(() => {
    if (connected) {
      loadAgents();
      loadSessions();
    }
  }, [connected, loadAgents, loadSessions]);

  const agentList = agents?.agents || [];
  const sessionList = sessions?.sessions || [];
  const runningTasksCount = tasks.filter(t => t.status === 'running').length;

  const [creatingSessionForAgent, setCreatingSessionForAgent] = useState<string | null>(null);
  const [newSessionName, setNewSessionName] = useState('');

  // Parse all sessions and group by agent (excluding system sessions)
  const sessionsByAgent = new Map<string, { session: typeof sessionList[0]; parsed: ParsedSession }[]>();

  sessionList.forEach(session => {
    if (isSystemSession(session.key)) return;
    const parsed = parseSessionKey(session.key, agentList);
    if (parsed.agentId && agentList.some(a => a.id === parsed.agentId)) {
      const existing = sessionsByAgent.get(parsed.agentId) || [];
      existing.push({ session, parsed });
      sessionsByAgent.set(parsed.agentId, existing);
    }
  });

  const handleRenameSession = async (sessionKey: string, newLabel: string) => {
    try {
      await patchSession(sessionKey, { label: newLabel });
      loadSessions();
    } catch (err) {
      console.error('Failed to rename session:', err);
    }
  };

  const handleDeleteSession = async (sessionKey: string) => {
    if (confirm('Are you sure you want to delete this session?')) {
      try {
        await deleteSession(sessionKey);
        loadSessions();
      } catch (err) {
        console.error('Failed to delete session:', err);
      }
    }
  };

  const handleCreateSession = (agentId: string) => {
    if (!newSessionName.trim()) return;
    const label = newSessionName.trim();
    const sessionKey = `agent:${agentId}:${label.toLowerCase().replace(/\s+/g, '-')}`;
    addSessionOptimistic(sessionKey, label);
    navigate(`/session/${sessionKey}`);
    setCreatingSessionForAgent(null);
    setNewSessionName('');
  };

  const isActive = (path: string) => location.pathname === path;
  const isSessionActive = (key: string) => selectedSessionKey === key || location.pathname === `/session/${key}`;

  const handleCreateAgentSuccess = () => {
    loadAgents();
    loadGatewayConfig();
  };

  return (
    <>
      <CreateAgentModal
        isOpen={createAgentModalOpen}
        onClose={() => setCreateAgentModalOpen(false)}
        onSuccess={handleCreateAgentSuccess}
      />
      <CreateChannelModal
        isOpen={createChannelModalOpen}
        onClose={() => setCreateChannelModalOpen(false)}
        onSuccess={async (sessionKey, members) => {
          try {
            await patchSession(sessionKey, {
              displayName: sessionKey.split('-').slice(1, -1).join('-'),
              members: members
            });
          } catch (err) {
            console.error('Failed to save channel members:', err);
          }
          navigate(`/session/${sessionKey}`);
          setCreateChannelModalOpen(false);
        }}
      />
      <aside className="w-56 flex flex-col h-screen bg-sidebar-bg border-r border-sidebar-border shadow-elevation-1">
      {/* Logo & Brand */}
      <div className="h-11 flex items-center px-3 border-b border-sidebar-border">
        <button
          onClick={() => navigate('/')}
          className="flex items-center gap-2 hover:opacity-80 transition-opacity"
        >
          <div className="w-6 h-6 rounded-xl bg-gradient-to-br from-orange-500 to-orange-600 flex items-center justify-center text-white font-bold text-xs shadow-sm">
            S
          </div>
          <span className="text-sm font-semibold text-foreground">Silos</span>
        </button>
      </div>

      {/* Main Navigation */}
      <div className="px-2 py-2 border-b border-sidebar-border space-y-0.5">
        <NavItem icon={Home} label={t('nav.home')} active={isActive('/')} onClick={() => navigate('/')} />
        <NavItem icon={ListTodo} label={t('nav.tasks')} active={isActive('/tasks')} onClick={() => navigate('/tasks')} badge={runningTasksCount > 0 ? runningTasksCount : undefined} />
        <NavItem icon={ScrollText} label="Logs" active={isActive('/logs')} onClick={() => navigate('/logs')} />
        <NavItem icon={Settings} label={t('nav.settings')} active={location.pathname.startsWith('/settings')} onClick={() => navigate('/settings')} />
      </div>

      {/* Scrollable Sessions Area */}
      <div className="flex-1 overflow-y-auto">
        <div className="py-2">
          <div className="w-full px-3 py-1 flex items-center gap-1.5 text-xs font-semibold text-foreground uppercase tracking-wide">
            <Bot className="w-3 h-3" />
            <span className="flex-1">Agents</span>
            <button
              onClick={() => setCreateAgentModalOpen(true)}
              className="p-0.5 hover:bg-sidebar-hover rounded transition-colors text-muted-foreground hover:text-foreground"
              title="Create Agent"
            >
              <Plus className="w-3 h-3" />
            </button>
          </div>
          <div className="mt-0.5 space-y-1 px-2">
            {agentList.map(agent => {
              const agentSessions = sessionsByAgent.get(agent.id) || [];
              const mainSessions = agentSessions.filter(s =>
                s.parsed.sessionType !== 'subagent' && s.parsed.sessionType !== 'cron'
              );
              const subagentSessions = agentSessions.filter(s => s.parsed.sessionType === 'subagent');
              const sessionLimitReached = agentSessions.length >= 100;

              return (
                <div key={agent.id} className="mb-1">
                  <AgentItem
                    agentId={agent.id}
                    name={agent.identity?.name || agent.name || agent.id}
                    emoji={agent.identity?.emoji}
                    onClick={() => navigate(`/agents/${agent.id}`)}
                    onCreateSession={() => setCreatingSessionForAgent(agent.id)}
                    sessionLimitReached={sessionLimitReached}
                  />

                  <div className="ml-4 mt-0.5 space-y-0.5 border-l border-sidebar-border/50 pl-2">
                    {mainSessions.map(({ session, parsed }) => (
                      <SessionItem
                        key={session.key}
                        sessionKey={session.key}
                        sessionType={parsed.sessionType}
                        label={session.label}
                        displayName={session.displayName}
                        defaultLabel={parsed.displayLabel}
                        active={isSessionActive(session.key)}
                        onClick={() => navigate(`/session/${session.key}`)}
                        onRename={(newLabel) => handleRenameSession(session.key, newLabel)}
                        onDelete={() => handleDeleteSession(session.key)}
                        unreadCount={unreadCounts.get(session.key) || 0}
                      />
                    ))}

                    {subagentSessions.length > 0 && (
                      <SubagentGroup
                        sessions={subagentSessions}
                        isSessionActive={isSessionActive}
                        onNavigate={(key) => navigate(`/session/${key}`)}
                        onRename={handleRenameSession}
                        onDelete={handleDeleteSession}
                        unreadCounts={unreadCounts}
                      />
                    )}

                    {creatingSessionForAgent === agent.id && (
                      <div className="flex items-center gap-2 px-2 py-1.5">
                        <input
                          type="text"
                          value={newSessionName}
                          onChange={(e) => setNewSessionName(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') handleCreateSession(agent.id);
                            if (e.key === 'Escape') {
                              setCreatingSessionForAgent(null);
                              setNewSessionName('');
                            }
                          }}
                          placeholder="session-name"
                          className="flex-1 text-sm px-2.5 py-1.5 bg-sidebar-hover border border-primary/40 rounded-lg focus:outline-none focus:ring-1 focus:ring-primary text-sidebar-fg"
                          autoFocus
                        />
                        <button onClick={() => handleCreateSession(agent.id)} className="p-1.5 text-green-500 hover:bg-green-500/10 rounded-lg">
                          <Check className="w-4 h-4" />
                        </button>
                        <button onClick={() => { setCreatingSessionForAgent(null); setNewSessionName(''); }} className="p-1.5 text-red-500 hover:bg-red-500/10 rounded-lg">
                          <X className="w-4 h-4" />
                        </button>
                      </div>
                    )}

                    {agentSessions.length === 0 && creatingSessionForAgent !== agent.id && (
                      <div className="px-3 py-2 text-xs text-muted-foreground italic">
                        No sessions
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
            {agentList.length === 0 && (
              <div className="px-3 py-4 text-sm text-muted-foreground text-center">
                No agents available
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Usage Bar */}
      <UsageBar />

      {/* Footer */}
      <div className="px-2 py-2 border-t border-sidebar-border">
        <ProfileMenu />
      </div>
    </aside>
    </>
  );
}
