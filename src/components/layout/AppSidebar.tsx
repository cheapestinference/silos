import { useState, useEffect, useRef } from 'react';
import { useDashboardStore } from '../../store/dashboard-store';
import { useAuth } from '../../hooks/useAuth';
import { useTranslation } from '../../i18n';
import type { Locale } from '../../i18n';
import { cn } from '../../lib/utils';
import {
  Home,
  Settings,
  Bot,
  ListTodo,
  Moon,
  Sun,
  LogOut,
  Globe,
  Hash,
  Plus,
  BotMessageSquare,
  MessageCircle,
  Smartphone,
  Trash2,
  Check,
  X,
  Pencil,
  ExternalLink,
} from 'lucide-react';
import { useNavigate, useLocation } from 'react-router-dom';
import { Tooltip, TooltipTrigger, TooltipContent } from '../ui/tooltip';
import { CreateAgentModal } from '../modals/CreateAgentModal';
import { CreateChannelModal } from '../modals/CreateChannelModal';
import { UsageBar } from './UsageBar';

// Parse session key to extract agent ID and session type
interface ParsedSession {
  agentId: string | null;
  sessionType: 'main' | 'subagent' | 'cron' | 'webchat' | 'whatsapp' | 'slack' | 'telegram' | 'discord' | 'unknown';
  parentSessionKey?: string;
  subagentId?: string;
  cronJobId?: string;
  displayLabel: string;
}

function parseSessionKey(sessionKey: string, agents?: { id: string }[]): ParsedSession {
  // Format: agent:{agentId}:main
  const agentMainMatch = sessionKey.match(/^agent:([^:]+):main$/);
  if (agentMainMatch) {
    return {
      agentId: agentMainMatch[1],
      sessionType: 'main',
      displayLabel: 'main'
    };
  }

  // Format: agent:{agentId}:subagent:{uuid}
  const agentSubagentMatch = sessionKey.match(/^agent:([^:]+):subagent:([^:]+)$/);
  if (agentSubagentMatch) {
    return {
      agentId: agentSubagentMatch[1],
      sessionType: 'subagent',
      subagentId: agentSubagentMatch[2],
      displayLabel: `subagent-${agentSubagentMatch[2].slice(0, 8)}`
    };
  }

  // Format: agent:{agentId}:cron:{jobId} - sessions created by cron jobs
  const agentCronMatch = sessionKey.match(/^agent:([^:]+):cron:([^:]+)$/);
  if (agentCronMatch) {
    return {
      agentId: agentCronMatch[1],
      sessionType: 'cron',
      cronJobId: agentCronMatch[2],
      displayLabel: `cron-${agentCronMatch[2].slice(0, 8)}`
    };
  }

  // Format: webchat:g-agent-{agentId} or webchat:g-agent-{agentId}-subagent-{uuid}
  const webchatMatch = sessionKey.match(/^webchat:g-agent-([^-]+(?:-[^-]+)*?)(?:-subagent-(.+))?$/);
  if (webchatMatch) {
    const potentialAgentId = webchatMatch[1];
    const subagentUuid = webchatMatch[2];

    // Try to find matching agent
    let matchedAgentId = potentialAgentId;
    if (agents) {
      const agent = agents.find(a => potentialAgentId.startsWith(a.id) || a.id.startsWith(potentialAgentId));
      if (agent) matchedAgentId = agent.id;
    }

    if (subagentUuid) {
      return {
        agentId: matchedAgentId,
        sessionType: 'subagent',
        subagentId: subagentUuid,
        displayLabel: `subagent-${subagentUuid.slice(0, 8)}`
      };
    }
    return {
      agentId: matchedAgentId,
      sessionType: 'webchat',
      displayLabel: 'webchat'
    };
  }

  // Format: whatsapp:{phoneOrGroup}:{agentId}
  const whatsappMatch = sessionKey.match(/^whatsapp:([^:]+):([^:]+)$/);
  if (whatsappMatch) {
    return {
      agentId: whatsappMatch[2],
      sessionType: 'whatsapp',
      displayLabel: `whatsapp:${whatsappMatch[1].slice(-4)}`
    };
  }

  // Format: slack:{workspace}:{channel}:{agentId}
  const slackMatch = sessionKey.match(/^slack:([^:]+):([^:]+):([^:]+)$/);
  if (slackMatch) {
    return {
      agentId: slackMatch[3],
      sessionType: 'slack',
      displayLabel: `slack:${slackMatch[2]}`
    };
  }

  // Format: telegram:{chatId}:{agentId}
  const telegramMatch = sessionKey.match(/^telegram:([^:]+):([^:]+)$/);
  if (telegramMatch) {
    return {
      agentId: telegramMatch[2],
      sessionType: 'telegram',
      displayLabel: `telegram:${telegramMatch[1].slice(-4)}`
    };
  }

  // Format: discord:{guildId}:{channelId}:{agentId}
  const discordMatch = sessionKey.match(/^discord:([^:]+):([^:]+):([^:]+)$/);
  if (discordMatch) {
    return {
      agentId: discordMatch[3],
      sessionType: 'discord',
      displayLabel: `discord:${discordMatch[2].slice(-4)}`
    };
  }

  // DM format: dm-{agentId}
  const dmMatch = sessionKey.match(/^dm-(.+)$/);
  if (dmMatch) {
    return {
      agentId: dmMatch[1],
      sessionType: 'main',
      displayLabel: 'main'
    };
  }

  // Unknown format - try to extract agent ID from any part
  if (agents) {
    for (const agent of agents) {
      if (sessionKey.includes(agent.id)) {
        return {
          agentId: agent.id,
          sessionType: 'unknown',
          displayLabel: sessionKey.split(':').pop() || sessionKey
        };
      }
    }
  }

  return {
    agentId: null,
    sessionType: 'unknown',
    displayLabel: sessionKey
  };
}

// Generate consistent color for agent based on ID
function getAgentColor(agentId: string): string {
  const colors = [
    'bg-blue-500',
    'bg-purple-500',
    'bg-pink-500',
    'bg-rose-500',
    'bg-orange-500',
    'bg-amber-500',
    'bg-lime-500',
    'bg-emerald-500',
    'bg-teal-500',
    'bg-cyan-500',
    'bg-indigo-500',
    'bg-violet-500',
  ];

  // Simple hash function to get consistent color for same ID
  let hash = 0;
  for (let i = 0; i < agentId.length; i++) {
    hash = agentId.charCodeAt(i) + ((hash << 5) - hash);
  }
  return colors[Math.abs(hash) % colors.length];
}

export function AppSidebar() {
  const {
    agents,
    sessions,
    setDarkMode,
    darkMode,
    connected,
    tasks,
    disconnect,
    selectedSessionKey,
    loadAgents,
    loadSessions,
    patchSession,
    deleteSession,
    addSessionOptimistic,
    unreadCounts,
    gatewayUrl,
    token,
  } = useDashboardStore();
  const { signOut } = useAuth();
  const { t, locale, setLocale, locales: availableLocales } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();

  const [createAgentModalOpen, setCreateAgentModalOpen] = useState(false);
  const [createChannelModalOpen, setCreateChannelModalOpen] = useState(false);
  const [langMenuOpen, setLangMenuOpen] = useState(false);
  const langMenuRef = useRef<HTMLDivElement>(null);

  // Load agents and sessions when sidebar mounts
  useEffect(() => {
    if (connected) {
      loadAgents();
      loadSessions();
    }
  }, [connected, loadAgents, loadSessions]);

  const agentList = agents?.agents || [];
  const sessionList = sessions?.sessions || [];
  const runningTasksCount = tasks.filter(t => t.status === 'running').length;

  // Track which agent is creating a new session
  const [creatingSessionForAgent, setCreatingSessionForAgent] = useState<string | null>(null);
  const [newSessionName, setNewSessionName] = useState('');

  // Parse all sessions and group by agent
  const sessionsByAgent = new Map<string, { session: typeof sessionList[0]; parsed: ParsedSession }[]>();
  const orphanedSessions: { session: typeof sessionList[0]; parsed: ParsedSession }[] = [];

  sessionList.forEach(session => {
    const parsed = parseSessionKey(session.key, agentList);
    if (parsed.agentId && agentList.some(a => a.id === parsed.agentId)) {
      const existing = sessionsByAgent.get(parsed.agentId) || [];
      existing.push({ session, parsed });
      sessionsByAgent.set(parsed.agentId, existing);
    } else {
      orphanedSessions.push({ session, parsed });
    }
  });

  // Handle session rename
  const handleRenameSession = async (sessionKey: string, newLabel: string) => {
    try {
      await patchSession(sessionKey, { label: newLabel });
      loadSessions();
    } catch (err) {
      console.error('Failed to rename session:', err);
    }
  };

  // Handle session delete
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

  // Handle create new session
  const handleCreateSession = (agentId: string) => {
    if (!newSessionName.trim()) return;
    const label = newSessionName.trim();
    const sessionKey = `agent:${agentId}:${label.toLowerCase().replace(/\s+/g, '-')}`;

    // Add session optimistically to sidebar
    addSessionOptimistic(sessionKey, label);

    navigate(`/session/${sessionKey}`);
    setCreatingSessionForAgent(null);
    setNewSessionName('');
  };

  const isActive = (path: string) => location.pathname === path;
  const isSessionActive = (key: string) => selectedSessionKey === key || location.pathname === `/session/${key}`;

  const handleCreateAgentSuccess = () => {
    // Reload agents list after creation
    loadAgents();
  };

  // Close language menu on click outside
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (langMenuRef.current && !langMenuRef.current.contains(e.target as Node)) {
        setLangMenuOpen(false);
      }
    }
    if (langMenuOpen) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [langMenuOpen]);


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
          // Save members to session metadata
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
        <NavItem
          icon={Home}
          label={t('nav.home')}
          active={isActive('/')}
          onClick={() => navigate('/')}
        />
        <NavItem
          icon={ListTodo}
          label={t('nav.tasks')}
          active={isActive('/tasks')}
          onClick={() => navigate('/tasks')}
          badge={runningTasksCount > 0 ? runningTasksCount : undefined}
        />
        {/* Removed Agents nav item - now accessed via sidebar list */}
      </div>

      {/* Scrollable Sessions Area */}
      <div className="flex-1 overflow-y-auto">
        {/* Agents Section with nested sessions */}
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

              // Separate main sessions from subagent and cron sessions
              const mainSessions = agentSessions.filter(s =>
                s.parsed.sessionType !== 'subagent' && s.parsed.sessionType !== 'cron'
              );
              const subagentSessions = agentSessions.filter(s => s.parsed.sessionType === 'subagent');
              const cronSessions = agentSessions.filter(s => s.parsed.sessionType === 'cron');

              const sessionLimitReached = agentSessions.length >= 100;

              return (
                <div key={agent.id} className="mb-1">
                  {/* Agent header */}
                  <AgentItem
                    agentId={agent.id}
                    name={agent.identity?.name || agent.name || agent.id}
                    emoji={agent.identity?.emoji}
                    onClick={() => navigate(`/agents/${agent.id}`)}
                    onCreateSession={() => setCreatingSessionForAgent(agent.id)}
                    sessionLimitReached={sessionLimitReached}
                  />

                  {/* Sessions always visible */}
                  <div className="ml-4 mt-0.5 space-y-0.5 border-l border-sidebar-border/50 pl-2">
                    {/* Subagent sessions (top, same level as regular sessions) */}
                    {subagentSessions.map(({ session, parsed }) => (
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
                        isSubagent
                        isCompleted={session.abortedLastRun === false && !session.systemSent}
                        unreadCount={unreadCounts.get(session.key) || 0}
                      />
                    ))}

                    {/* Main/channel sessions */}
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

                    {/* Cron job sessions (more indented, like subagents) */}
                    {cronSessions.length > 0 && (
                      <div className="ml-2 mt-0.5 space-y-0.5 border-l border-cyan-500/30 pl-2">
                        {cronSessions.map(({ session, parsed }) => (
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
                            isCron
                            unreadCount={unreadCounts.get(session.key) || 0}
                          />
                        ))}
                      </div>
                    )}

                    {/* Create new session input */}
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
                          className="flex-1 text-sm px-2.5 py-1.5 bg-sidebar-hover border border-primary/50 rounded-lg focus:outline-none focus:ring-1 focus:ring-primary text-sidebar-fg"
                          autoFocus
                        />
                        <button
                          onClick={() => handleCreateSession(agent.id)}
                          className="p-1.5 text-green-500 hover:bg-green-500/10 rounded-lg"
                        >
                          <Check className="w-4 h-4" />
                        </button>
                        <button
                          onClick={() => {
                            setCreatingSessionForAgent(null);
                            setNewSessionName('');
                          }}
                          className="p-1.5 text-red-500 hover:bg-red-500/10 rounded-lg"
                        >
                          <X className="w-4 h-4" />
                        </button>
                      </div>
                    )}

                    {/* Empty state */}
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

        {/* Orphaned Sessions (sessions without matching agents) */}
        {orphanedSessions.length > 0 && (
          <div className="py-2 border-t border-sidebar-border">
            <div className="w-full px-3 py-1 flex items-center gap-1.5 text-xs font-semibold text-muted-foreground uppercase tracking-wide">
              <Hash className="w-3 h-3" />
              <span className="flex-1">Other Sessions</span>
            </div>
            <div className="mt-0.5 space-y-0.5 px-2">
              {orphanedSessions.map(({ session, parsed }) => (
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
            </div>
          </div>
        )}
      </div>

      {/* Usage Bar */}
      <UsageBar />

      {/* Footer Actions */}
      <div className="px-2 py-2 flex items-center gap-1 border-t border-sidebar-border">
        {/* Language Selector */}
        <div className="relative" ref={langMenuRef}>
          <Tooltip>
            <TooltipTrigger>
              <button
                onClick={() => setLangMenuOpen(!langMenuOpen)}
                className="w-7 h-7 rounded flex items-center justify-center text-sidebar-fg/60 hover:text-sidebar-fg hover:bg-sidebar-hover transition-colors"
              >
                <Globe className="w-3.5 h-3.5" />
              </button>
            </TooltipTrigger>
            {!langMenuOpen && (
              <TooltipContent side="right">
                <span className="text-xs">{availableLocales[locale].label}</span>
              </TooltipContent>
            )}
          </Tooltip>
          {langMenuOpen && (
            <div className="absolute bottom-full left-0 mb-1 py-1 min-w-[140px] bg-popover border border-border rounded-md shadow-lg z-50">
              {(Object.keys(availableLocales) as Locale[]).map((loc) => (
                <button
                  key={loc}
                  onClick={() => { setLocale(loc); setLangMenuOpen(false); }}
                  className={cn(
                    "w-full px-3 py-1.5 text-xs text-left flex items-center gap-2 hover:bg-accent transition-colors",
                    locale === loc && "bg-accent font-medium"
                  )}
                >
                  <span>{availableLocales[loc].flag}</span>
                  <span>{availableLocales[loc].label}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Theme Toggle */}
        <Tooltip>
          <TooltipTrigger>
            <button
              onClick={() => setDarkMode(!darkMode)}
              className="w-7 h-7 rounded flex items-center justify-center text-sidebar-fg/60 hover:text-sidebar-fg hover:bg-sidebar-hover transition-colors"
            >
              {darkMode ? <Sun className="w-3.5 h-3.5" /> : <Moon className="w-3.5 h-3.5" />}
            </button>
          </TooltipTrigger>
          <TooltipContent side="right">
            <span className="text-xs">{darkMode ? t('settings.appearance.lightMode') : t('settings.appearance.darkMode')}</span>
          </TooltipContent>
        </Tooltip>

        {/* Settings */}
        <Tooltip>
          <TooltipTrigger>
            <button
              onClick={() => navigate('/settings')}
              className={cn(
                "w-7 h-7 rounded flex items-center justify-center transition-colors",
                isActive('/settings')
                  ? "bg-primary text-white"
                  : "text-sidebar-fg/60 hover:text-sidebar-fg hover:bg-sidebar-hover"
              )}
            >
              <Settings className="w-3.5 h-3.5" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="right">
            <span className="text-xs">{t('nav.settings')}</span>
          </TooltipContent>
        </Tooltip>


        {/* OpenClaw Control UI */}
        {connected && (
          <Tooltip>
            <TooltipTrigger>
              <button
                onClick={() => {
                  const isLocal = gatewayUrl.includes('localhost') || gatewayUrl.includes('127.0.0.1');
                  const isHttps = window.location.protocol === 'https:';
                  const suffix = token ? `#token=${encodeURIComponent(token)}` : '';
                  if (isLocal && isHttps) {
                    window.open(`${window.location.origin}/openclaw/${suffix}`, '_blank');
                  } else {
                    let httpUrl = gatewayUrl.replace(/^wss?:\/\//, 'http://');
                    if (!httpUrl.startsWith('http')) httpUrl = `http://${httpUrl}`;
                    window.open(`${httpUrl}/openclaw/${suffix}`, '_blank');
                  }
                }}
                className="w-7 h-7 rounded flex items-center justify-center text-sidebar-fg/60 hover:text-sidebar-fg hover:bg-sidebar-hover transition-colors"
              >
                <ExternalLink className="w-3.5 h-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="right">
              <span className="text-xs">OpenClaw UI</span>
            </TooltipContent>
          </Tooltip>
        )}

        {/* Disconnect */}
        {connected && (
          <Tooltip>
            <TooltipTrigger>
              <button
                onClick={() => { disconnect(); signOut(); }}
                className="w-7 h-7 rounded flex items-center justify-center text-sidebar-fg/60 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-500/10 transition-colors"
              >
                <LogOut className="w-3.5 h-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="right">
              <span className="text-xs">{t('settings.connection.disconnect')}</span>
            </TooltipContent>
          </Tooltip>
        )}

        {/* Connection Indicator */}
        <div className="ml-auto">
          <div
            className={cn(
              "w-1.5 h-1.5 rounded-full",
              connected ? "bg-green-500" : "bg-gray-400"
            )}
          />
        </div>
      </div>
    </aside>
    </>
  );
}

interface NavItemProps {
  icon: React.ElementType;
  label: string;
  active?: boolean;
  onClick: () => void;
  badge?: number;
}

function NavItem({ icon: Icon, label, active, onClick, badge }: NavItemProps) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "w-full px-2 py-1 rounded flex items-center gap-2 transition-colors text-xs",
        active
          ? "bg-primary/15 text-primary font-semibold relative before:absolute before:left-0 before:top-1/2 before:-translate-y-1/2 before:w-[3px] before:h-4 before:rounded-full before:bg-primary"
          : "text-sidebar-fg/80 hover:text-sidebar-fg hover:bg-sidebar-hover"
      )}
    >
      <Icon className="w-3.5 h-3.5 shrink-0" />
      <span className="flex-1 text-left truncate">{label}</span>
      {badge !== undefined && badge > 0 && (
        <span className="min-w-[16px] h-4 px-1 bg-red-500 text-white text-[9px] font-semibold rounded-full flex items-center justify-center">
          {badge > 9 ? '9+' : badge}
        </span>
      )}
    </button>
  );
}

interface AgentItemProps {
  agentId: string;
  name: string;
  emoji?: string;
  onClick: () => void;
  onCreateSession: () => void;
  sessionLimitReached?: boolean;
}

function AgentItem({ agentId, name, emoji, onClick, onCreateSession, sessionLimitReached }: AgentItemProps) {
  const { t } = useTranslation();
  const agentColor = getAgentColor(agentId);

  return (
    <div className="flex items-center gap-0.5 group">
      {/* Agent button */}
      <button
        onClick={onClick}
        className={cn(
          "flex-1 px-2 py-1 rounded flex items-center gap-2 transition-colors",
          "text-sidebar-fg hover:bg-sidebar-hover"
        )}
      >
        <div className={cn(
          "w-5 h-5 rounded flex items-center justify-center shrink-0",
          agentColor,
          "text-white"
        )}>
          {emoji ? (
            <span className="text-xs">{emoji}</span>
          ) : (
            <BotMessageSquare className="w-3 h-3" />
          )}
        </div>
        <span className="flex-1 text-xs text-left truncate font-semibold">{name}</span>
        <div className="w-1.5 h-1.5 rounded-full shrink-0 bg-green-500" />
      </button>

      {/* Create session button */}
      {sessionLimitReached ? (
        <span
          className="p-1.5 opacity-0 group-hover:opacity-100 text-muted-foreground/50 cursor-not-allowed"
          title={t('sidebar.sessionLimitReached')}
        >
          <Plus className="w-4 h-4" />
        </span>
      ) : (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onCreateSession();
          }}
          className="p-1.5 opacity-0 group-hover:opacity-100 hover:bg-sidebar-hover rounded-lg transition-all text-muted-foreground hover:text-foreground"
          title={t('sidebar.createSession')}
        >
          <Plus className="w-4 h-4" />
        </button>
      )}
    </div>
  );
}

interface SessionItemProps {
  sessionKey: string;
  sessionType: string;
  label?: string;
  displayName?: string;
  defaultLabel: string;
  active?: boolean;
  onClick: () => void;
  onRename: (newLabel: string) => void;
  onDelete: () => void;
  isSubagent?: boolean;
  isCron?: boolean;
  isCompleted?: boolean;
  unreadCount?: number;
}

function SessionItem({
  sessionType,
  label,
  displayName,
  defaultLabel,
  active,
  onClick,
  onRename,
  onDelete,
  isSubagent,
  isCron,
  isCompleted,
  unreadCount = 0,
}: SessionItemProps) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  // Translate known session type labels
  const translatedDefault = sessionType === 'main' ? t('sidebar.sessionTypes.main')
    : sessionType === 'webchat' ? t('sidebar.sessionTypes.webchat')
    : defaultLabel;

  // Display name priority: label > displayName > translated defaultLabel
  const displayedName = label || displayName || translatedDefault;

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  const handleStartEdit = (e: React.MouseEvent) => {
    e.stopPropagation();
    setEditValue(displayedName);
    setEditing(true);
  };

  const handleSave = () => {
    if (editValue.trim() && editValue !== displayedName) {
      onRename(editValue.trim());
    }
    setEditing(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleSave();
    } else if (e.key === 'Escape') {
      setEditing(false);
    }
  };

  // Get appropriate icon based on session type
  const getIcon = () => {
    if (isSubagent) {
      // Robot emoji for subagents
      return null;
    }
    if (isCron) {
      // Clock icon for cron sessions
      return null; // We'll use emoji instead
    }
    switch (sessionType) {
      case 'main':
      case 'webchat':
        return MessageCircle;
      case 'whatsapp':
      case 'telegram':
        return Smartphone;
      case 'slack':
      case 'discord':
        return Hash;
      case 'cron':
        return null; // Use emoji
      default:
        return Hash;
    }
  };

  const Icon = getIcon();

  if (editing) {
    return (
      <div className="flex items-center gap-1.5 px-2 py-1">
        <input
          ref={inputRef}
          type="text"
          value={editValue}
          onChange={(e) => setEditValue(e.target.value)}
          onBlur={handleSave}
          onKeyDown={handleKeyDown}
          className="flex-1 text-sm px-2 py-1 bg-sidebar-hover border border-primary/50 rounded focus:outline-none focus:ring-1 focus:ring-primary text-sidebar-fg min-w-0"
        />
        <button
          onClick={handleSave}
          className="p-1 text-green-500 hover:bg-green-500/10 rounded"
        >
          <Check className="w-3.5 h-3.5" />
        </button>
        <button
          onClick={() => setEditing(false)}
          className="p-1 text-red-500 hover:bg-red-500/10 rounded"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
    );
  }

  return (
    <div className="group flex items-center gap-0.5">
      <button
        onClick={onClick}
        className={cn(
          "flex-1 px-2 py-0.5 rounded flex items-center gap-1.5 transition-colors min-w-0",
          active
            ? "bg-primary/10 text-primary font-medium"
            : "text-sidebar-fg/80 hover:text-sidebar-fg hover:bg-sidebar-hover",
        )}
      >
        {isSubagent ? (
          <span className="shrink-0 text-[11px]">🤖</span>
        ) : isCron ? (
          <span className="shrink-0 text-[11px]">⏰</span>
        ) : Icon ? (
          <Icon className="shrink-0 opacity-60 w-3.5 h-3.5" />
        ) : null}
        <span className="flex-1 text-left truncate text-xs">{displayedName}</span>
        {unreadCount > 0 && !active && (
          <span className="shrink-0 min-w-[18px] h-[18px] px-1 flex items-center justify-center text-[10px] font-bold rounded-full bg-blue-500 text-white">
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        )}
        {isSubagent && isCompleted && (
          <Check className="w-3.5 h-3.5 text-green-500 shrink-0" />
        )}
      </button>

      {/* Action buttons (visible on hover) */}
      <div className="flex items-center opacity-0 group-hover:opacity-100 transition-opacity">
        <button
          onClick={handleStartEdit}
          className="p-1 hover:bg-sidebar-hover rounded text-muted-foreground hover:text-foreground"
          title="Rename"
        >
          <Pencil className="w-3.5 h-3.5" />
        </button>
        <button
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          className="p-1 hover:bg-red-500/10 rounded text-muted-foreground hover:text-red-500"
          title="Delete"
        >
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
}

