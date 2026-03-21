import { useState, useMemo } from 'react';
import { NavLink, useNavigate, useLocation } from 'react-router-dom';
import {
  LayoutDashboard,
  Bot,
  MessageSquare,
  Clock,
  Kanban,
  Settings,
  LogOut,
  Moon,
  Sun,
  Wifi,
  WifiOff,
  ChevronRight,
  ChevronDown,
  Smartphone,
  Hash,
  GitBranch,
  FileText,
  Send,
  Users,
  Globe,
} from 'lucide-react';
import { cn } from '../../lib/utils';
import { useDashboardStore } from '../../store/dashboard-store';
import { useAuth } from '../../hooks/useAuth';
import useTranslation from '../../i18n';
import { Button } from '../ui/button';
import { Badge } from '../ui/badge';
import { ScrollArea } from '../ui/scroll-area';
import type { AgentSummary, GatewaySessionRow } from '../../types/openclaw';

// Parse session key to extract type and display info
// Handles multiple formats:
// - agent:{agentId}:main
// - agent:{agentId}:subagent:{uuid}
// - webchat:g-agent-{agentId}-subagent-{uuid}
// - {channel}:{agentId}:{bucket}
function parseSessionKey(key: string, agents?: AgentSummary[]): {
  type: 'main' | 'dm' | 'whatsapp' | 'telegram' | 'slack' | 'discord' | 'subagent' | 'webchat' | 'group' | 'unknown';
  agentId: string | null;
  displayName: string;
  icon: typeof MessageSquare;
  parentSessionKey?: string;
} {
  // Subagent patterns - check first as they're specific
  // Format: webchat:g-agent-{agentId}-subagent-{uuid} or agent:{agentId}:subagent:{uuid}
  if (key.includes('-subagent-') || key.includes(':subagent:')) {
    let agentId: string | null = null;
    let subagentId = 'unknown';

    // Try webchat format: webchat:g-agent-{agentId}-subagent-{uuid}
    const webchatMatch = key.match(/webchat:g-agent-([^-]+(?:-[^-]+)*)-subagent-([a-f0-9-]+)/i);
    if (webchatMatch) {
      agentId = webchatMatch[1];
      subagentId = webchatMatch[2].slice(0, 8);
    } else {
      // Try standard format: agent:{agentId}:subagent:{uuid}
      const stdMatch = key.match(/agent:([^:]+):subagent:([^:]+)/);
      if (stdMatch) {
        agentId = stdMatch[1];
        subagentId = stdMatch[2].slice(0, 8);
      }
    }

    return {
      type: 'subagent',
      agentId,
      displayName: `Subagent ${subagentId}`,
      icon: GitBranch,
    };
  }

  // WhatsApp group: agent:{agentId}:whatsapp:group:{groupId}
  if (key.includes(':whatsapp:group:')) {
    const match = key.match(/agent:([^:]+):whatsapp:group:(.+)/);
    return {
      type: 'whatsapp',
      agentId: match?.[1] || null,
      displayName: match?.[2] || 'WhatsApp Group',
      icon: Smartphone,
    };
  }

  // WhatsApp DM: agent:{agentId}:whatsapp:dm:{peerId}
  if (key.includes(':whatsapp:')) {
    const match = key.match(/agent:([^:]+):whatsapp:(?:dm:)?(.+)/);
    return {
      type: 'whatsapp',
      agentId: match?.[1] || null,
      displayName: match?.[2] || 'WhatsApp',
      icon: Smartphone,
    };
  }

  // Telegram: agent:{agentId}:telegram:...
  if (key.includes(':telegram:')) {
    const match = key.match(/agent:([^:]+):telegram:(.+)/);
    return {
      type: 'telegram',
      agentId: match?.[1] || null,
      displayName: match?.[2] || 'Telegram',
      icon: Send,
    };
  }

  // Slack: agent:{agentId}:slack:channel:{channelId}
  if (key.includes(':slack:')) {
    const match = key.match(/agent:([^:]+):slack:(?:channel:)?(.+)/);
    return {
      type: 'slack',
      agentId: match?.[1] || null,
      displayName: `#${match?.[2] || 'slack'}`,
      icon: Hash,
    };
  }

  // Discord: agent:{agentId}:discord:...
  if (key.includes(':discord:')) {
    const match = key.match(/agent:([^:]+):discord:(.+)/);
    return {
      type: 'discord',
      agentId: match?.[1] || null,
      displayName: match?.[2] || 'Discord',
      icon: Users,
    };
  }

  // Main session: agent:{agentId}:main
  if (key.match(/^agent:[^:]+:main$/)) {
    const match = key.match(/^agent:([^:]+):main$/);
    return {
      type: 'main',
      agentId: match?.[1] || null,
      displayName: 'main',
      icon: MessageSquare,
    };
  }

  // DM session: agent:{agentId}:dm:{peerId} or agent:{agentId}:dm-operator
  if (key.includes(':dm')) {
    const match = key.match(/^agent:([^:]+):dm[-:]?(.+)?/);
    return {
      type: 'dm',
      agentId: match?.[1] || null,
      displayName: match?.[2] || 'Direct Message',
      icon: MessageSquare,
    };
  }

  // Global session
  if (key === 'global') {
    return {
      type: 'main',
      agentId: null,
      displayName: 'Global',
      icon: Globe,
    };
  }

  // Webchat format: webchat:g-agent-{agentId}
  if (key.startsWith('webchat:')) {
    // Try to extract agent ID from webchat:g-agent-{agentId}
    const match = key.match(/webchat:g-agent-([^-]+(?:-[^-]+)*?)(?:-|$)/);
    if (match) {
      // Try to find a matching agent by checking if the agentId matches any known agent
      const extractedId = match[1];
      // Look for matching agent
      const matchingAgent = agents?.find(a =>
        extractedId === a.id ||
        extractedId.includes(a.id) ||
        a.id.includes(extractedId)
      );

      return {
        type: 'webchat',
        agentId: matchingAgent?.id || extractedId,
        displayName: 'webchat',
        icon: MessageSquare,
      };
    }
    return {
      type: 'webchat',
      agentId: null,
      displayName: key.replace('webchat:', ''),
      icon: MessageSquare,
    };
  }

  // Generic agent session: agent:{agentId}:{bucket}
  const agentMatch = key.match(/^agent:([^:]+):?(.+)?/);
  if (agentMatch) {
    return {
      type: 'unknown',
      agentId: agentMatch[1],
      displayName: agentMatch[2] || 'Session',
      icon: FileText,
    };
  }

  // Try to find agent by checking if key contains agent ID
  if (agents) {
    for (const agent of agents) {
      if (key.includes(agent.id)) {
        return {
          type: 'unknown',
          agentId: agent.id,
          displayName: key,
          icon: FileText,
        };
      }
    }
  }

  // Unknown format
  return {
    type: 'unknown',
    agentId: null,
    displayName: key,
    icon: FileText,
  };
}

// Get sessions for a specific agent
function getAgentSessions(sessions: GatewaySessionRow[], agentId: string, agents?: AgentSummary[]): GatewaySessionRow[] {
  return sessions.filter((s) => {
    const parsed = parseSessionKey(s.key, agents);
    return parsed.agentId === agentId && parsed.type !== 'subagent';
  });
}

// Get subagents for a specific agent (or session)
function getSubagents(sessions: GatewaySessionRow[], agentId: string, agents?: AgentSummary[]): GatewaySessionRow[] {
  return sessions.filter((s) => {
    const parsed = parseSessionKey(s.key, agents);
    return parsed.type === 'subagent' && parsed.agentId === agentId;
  });
}

// Get sessions that don't match any agent (orphaned)
function getOrphanedSessions(sessions: GatewaySessionRow[], agents: AgentSummary[]): GatewaySessionRow[] {
  const agentIds = new Set(agents.map(a => a.id));
  return sessions.filter((s) => {
    const parsed = parseSessionKey(s.key, agents);
    return !parsed.agentId || !agentIds.has(parsed.agentId);
  });
}

// Session item component
function SessionItem({
  session,
  isSelected,
  onSelect,
  indent = 0,
}: {
  session: GatewaySessionRow;
  isSelected: boolean;
  onSelect: () => void;
  indent?: number;
}) {
  const parsed = parseSessionKey(session.key);
  const Icon = parsed.icon;
  const displayName = session.displayName || session.derivedTitle || session.label || parsed.displayName;

  return (
    <button
      onClick={onSelect}
      className={cn(
        'w-full flex items-center gap-2 px-2 py-1 rounded-md text-xs transition-colors text-left',
        isSelected
          ? 'bg-primary/10 text-primary'
          : 'text-muted-foreground hover:bg-muted hover:text-foreground',
        indent > 0 && 'ml-4'
      )}
      style={{ paddingLeft: `${8 + indent * 12}px` }}
    >
      <Icon className={cn(
        'h-3.5 w-3.5 shrink-0',
        parsed.type === 'subagent' && 'text-cyan-500',
        parsed.type === 'whatsapp' && 'text-green-500',
        parsed.type === 'telegram' && 'text-blue-500',
        parsed.type === 'slack' && 'text-primary',
        parsed.type === 'discord' && 'text-primary',
      )} />
      <span className="truncate flex-1">{displayName}</span>
      {parsed.type === 'subagent' && (
        <Badge variant="outline" className="text-[10px] px-1 py-0 bg-muted dark:bg-muted border-border text-cyan-600 dark:text-cyan-400">
          sub
        </Badge>
      )}
    </button>
  );
}

// Agent section with expandable sessions
function AgentSection({
  agent,
  isDefault,
  sessions,
  allAgents,
  selectedSessionKey,
  onSelectSession,
  onSelectAgent,
}: {
  agent: AgentSummary;
  isDefault: boolean;
  sessions: GatewaySessionRow[];
  allAgents: AgentSummary[];
  selectedSessionKey: string | null;
  onSelectSession: (key: string) => void;
  onSelectAgent: (id: string) => void;
}) {
  const [isExpanded, setIsExpanded] = useState(true);
  const location = useLocation();

  const agentSessions = getAgentSessions(sessions, agent.id, allAgents);
  const subagents = getSubagents(sessions, agent.id, allAgents);
  const allSessions = [...agentSessions, ...subagents];

  const displayName = agent.identity?.name || agent.name || agent.id;
  const emoji = agent.identity?.emoji;

  const isAgentSelected = location.pathname.startsWith(`/agents/${agent.id}`);
  const hasSelectedSession = allSessions.some(s => s.key === selectedSessionKey);

  return (
    <div className="space-y-0.5">
      {/* Agent Header */}
      <div
        className={cn(
          'flex items-center gap-2 px-2 py-1.5 rounded-lg cursor-pointer transition-colors',
          (isAgentSelected || hasSelectedSession)
            ? 'bg-primary/5'
            : 'hover:bg-muted'
        )}
      >
        <button
          onClick={() => setIsExpanded(!isExpanded)}
          className="p-0.5 hover:bg-muted rounded"
        >
          {isExpanded ? (
            <ChevronDown className="h-4 w-4 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-4 w-4 text-muted-foreground" />
          )}
        </button>

        <button
          onClick={() => onSelectAgent(agent.id)}
          className="flex items-center gap-2 flex-1 min-w-0"
        >
          <div className="h-6 w-6 rounded-full bg-primary/10 flex items-center justify-center text-xs shrink-0">
            {emoji || <Bot className="h-4 w-4 text-primary" />}
          </div>
          <span className={cn(
            'font-medium truncate text-xs',
            isAgentSelected && 'text-primary'
          )}>
            {displayName}
          </span>
          {isDefault && (
            <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
              default
            </Badge>
          )}
        </button>

        <span className="text-xs text-muted-foreground">
          {allSessions.length}
        </span>
      </div>

      {/* Sessions */}
      {isExpanded && (
        <div className="space-y-0.5 pl-2">
          {allSessions.length === 0 ? (
            <p className="text-xs text-muted-foreground px-4 py-2">No sessions</p>
          ) : (
            <>
              {/* Regular sessions */}
              {agentSessions.map((session) => (
                <SessionItem
                  key={session.key}
                  session={session}
                  isSelected={session.key === selectedSessionKey}
                  onSelect={() => onSelectSession(session.key)}
                  indent={1}
                />
              ))}

              {/* Subagents */}
              {subagents.length > 0 && (
                <>
                  {subagents.map((session) => (
                    <SessionItem
                      key={session.key}
                      session={session}
                      isSelected={session.key === selectedSessionKey}
                      onSelect={() => onSelectSession(session.key)}
                      indent={2}
                    />
                  ))}
                </>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

// Static nav items (non-agent pages)
const staticNavItems = [
  { to: '/', icon: LayoutDashboard, label: 'Dashboard' },
  { to: '/tasks', icon: Kanban, label: 'Tasks' },
  { to: '/cron', icon: Clock, label: 'Cron Jobs' },
  { to: '/settings', icon: Settings, label: 'Settings' },
];

export function Sidebar() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { signOut } = useAuth();
  const {
    connected,
    connecting,
    darkMode,
    setDarkMode,
    disconnect,
    reconnectAttempt,
    agents,
    sessions,
    selectSession,
    selectedSessionKey,
  } = useDashboardStore();

  const handleSelectSession = (key: string) => {
    selectSession(key);
    navigate(`/session/${encodeURIComponent(key)}`);
  };

  const handleSelectAgent = (id: string) => {
    navigate(`/agents/${id}`);
  };

  // Sort agents: default first, then alphabetically
  const sortedAgents = useMemo(() => {
    if (!agents?.agents) return [];
    return [...agents.agents].sort((a, b) => {
      if (a.id === agents.defaultId) return -1;
      if (b.id === agents.defaultId) return 1;
      const nameA = a.identity?.name || a.name || a.id;
      const nameB = b.identity?.name || b.name || b.id;
      return nameA.localeCompare(nameB);
    });
  }, [agents]);

  return (
    <aside className="fixed left-0 top-0 z-40 h-screen w-64 border-r bg-card flex flex-col">
      {/* Logo */}
      <div className="flex h-14 items-center border-b px-4 shrink-0">
        <div className="flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-primary to-accent text-white font-bold text-sm">
            S
          </div>
          <div>
            <h1 className="text-base font-bold leading-none">Silos</h1>
            <p className="text-[10px] text-muted-foreground">Dashboard</p>
          </div>
        </div>
      </div>

      {/* Connection Status */}
      <div className="border-b px-3 py-2 shrink-0">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            {connected ? (
              <Wifi className="h-3.5 w-3.5 text-green-500" />
            ) : connecting ? (
              <Wifi className="h-3.5 w-3.5 text-yellow-500 animate-pulse" />
            ) : (
              <WifiOff className="h-3.5 w-3.5 text-red-500" />
            )}
            <span className="text-xs">
              {connected ? 'Connected' : connecting ? `Reconnecting${reconnectAttempt > 0 ? ` (${reconnectAttempt})` : ''}...` : 'Disconnected'}
            </span>
          </div>
          {connected && (
            <Badge variant="success" className="text-[10px] px-1.5 py-0">
              Live
            </Badge>
          )}
        </div>
      </div>

      {/* Main Navigation */}
      <nav className="px-2 py-2 space-y-0.5 shrink-0">
        {staticNavItems.slice(0, 1).map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            className={({ isActive }) =>
              cn(
                'flex items-center gap-2 rounded-md px-2 py-1.5 text-xs font-medium transition-colors',
                isActive
                  ? 'bg-primary/10 text-primary'
                  : 'text-muted-foreground hover:bg-muted hover:text-foreground'
              )
            }
          >
            <item.icon className="h-4 w-4" />
            {item.label}
          </NavLink>
        ))}
      </nav>

      {/* Agents Section */}
      <div className="flex-1 flex flex-col min-h-0">
        <div className="px-3 py-2 flex items-center justify-between shrink-0">
          <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
            {t('nav.agents')}
          </span>
          <span className="text-xs text-muted-foreground">
            {sortedAgents.length}
          </span>
        </div>

        <ScrollArea className="flex-1 px-2">
          <div className="space-y-1 pb-4">
            {sortedAgents.map((agent) => (
              <AgentSection
                key={agent.id}
                agent={agent}
                isDefault={agent.id === agents?.defaultId}
                sessions={sessions?.sessions || []}
                allAgents={sortedAgents}
                selectedSessionKey={selectedSessionKey}
                onSelectSession={handleSelectSession}
                onSelectAgent={handleSelectAgent}
              />
            ))}

            {/* Orphaned sessions that don't match any agent */}
            {(() => {
              const orphaned = getOrphanedSessions(sessions?.sessions || [], sortedAgents);
              if (orphaned.length === 0) return null;
              return (
                <div className="mt-4 pt-4 border-t border-border/40">
                  <div className="px-2 py-1 mb-2">
                    <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
                      Other Sessions
                    </span>
                  </div>
                  {orphaned.map((session) => (
                    <SessionItem
                      key={session.key}
                      session={session}
                      isSelected={session.key === selectedSessionKey}
                      onSelect={() => handleSelectSession(session.key)}
                    />
                  ))}
                </div>
              );
            })()}

            {sortedAgents.length === 0 && (
              <div className="text-center py-8">
                <Bot className="h-8 w-8 mx-auto mb-2 text-muted-foreground opacity-30" />
                <p className="text-xs text-muted-foreground">No agents</p>
              </div>
            )}
          </div>
        </ScrollArea>
      </div>

      {/* Bottom Navigation */}
      <div className="border-t px-2 py-2 space-y-0.5 shrink-0">
        {staticNavItems.slice(1).map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            className={({ isActive }) =>
              cn(
                'flex items-center gap-2 rounded-md px-2 py-1.5 text-xs font-medium transition-colors',
                isActive
                  ? 'bg-primary/10 text-primary'
                  : 'text-muted-foreground hover:bg-muted hover:text-foreground'
              )
            }
          >
            <item.icon className="h-4 w-4" />
            {item.label}
          </NavLink>
        ))}
      </div>

      {/* Footer */}
      <div className="border-t p-2 space-y-1 shrink-0">
        <Button
          variant="ghost"
          size="sm"
          className="w-full justify-start h-8 text-xs"
          onClick={() => setDarkMode(!darkMode)}
        >
          {darkMode ? (
            <>
              <Sun className="mr-2 h-3.5 w-3.5" />
              Light Mode
            </>
          ) : (
            <>
              <Moon className="mr-2 h-3.5 w-3.5" />
              Dark Mode
            </>
          )}
        </Button>

        {connected && (
          <Button
            variant="ghost"
            size="sm"
            className="w-full justify-start h-8 text-xs text-destructive hover:text-destructive"
            onClick={() => { disconnect(); signOut(); }}
          >
            <LogOut className="mr-2 h-3.5 w-3.5" />
            Disconnect
          </Button>
        )}
      </div>
    </aside>
  );
}
