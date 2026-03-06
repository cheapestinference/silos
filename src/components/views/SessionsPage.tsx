import { useState, useRef, useEffect, useMemo } from 'react';
import useTranslation from '../../i18n';
import {
  MessageSquare,
  Search,
  Trash2,
  Send,
  Square,
  MoreVertical,
  Bot,
  User as UserIcon,
  Wrench,
  Loader2,
  Globe,
  Users as UsersIcon,
  AlertCircle,
  GitBranch,
  ChevronRight,
  ChevronDown,
} from 'lucide-react';
import { Header } from '../layout/Header';
import { Card, CardContent, CardHeader, CardTitle } from '../ui/card';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Badge } from '../ui/badge';
import { ScrollArea } from '../ui/scroll-area';
import { useDashboardStore } from '../../store/dashboard-store';
import { cn, formatTimestamp, getSessionDisplayName, formatNumber } from '../../lib/utils';
import type { GatewaySessionRow, ChatMessage } from '../../types/openclaw';

// Helper to detect if a session key is a subagent
// Handles: agent:X:subagent:Y and webchat:g-agent-X-subagent-Y
function isSubagentSession(key: string): boolean {
  return key.includes(':subagent:') || key.includes('-subagent-');
}

// Helper to get agent ID from a session key
// Handles multiple formats:
// - agent:{agentId}:... -> agentId
// - webchat:g-agent-{agentId}-... -> agentId
// - dm-{agentId} -> agentId
function getAgentIdFromKey(key: string): string | null {
  // Format: agent:{agentId}:...
  const agentMatch = key.match(/^agent:([^:]+)/);
  if (agentMatch) return agentMatch[1];

  // Format: webchat:g-agent-{agentId}...
  const webchatMatch = key.match(/^webchat:g-agent-([^-]+)/);
  if (webchatMatch) return webchatMatch[1];

  // Format: dm-{agentId}
  const dmMatch = key.match(/^dm-(.+)$/);
  if (dmMatch) return dmMatch[1];

  return null;
}

// Helper to get parent session key from a subagent session
// Format: agent:{agentId}:subagent:{uuid} -> agent:{agentId}:dm-operator
function getParentSessionKey(subagentKey: string): string | null {
  const agentId = getAgentIdFromKey(subagentKey);
  if (!agentId) return null;
  return `agent:${agentId}:dm-operator`;
}

// Group sessions hierarchically
interface SessionGroup {
  session: GatewaySessionRow;
  children: GatewaySessionRow[];
}

function groupSessionsHierarchically(
  sessions: GatewaySessionRow[],
  subagentParents: Map<string, string>
): SessionGroup[] {
  const groups: SessionGroup[] = [];

  // Separate subagents from regular sessions
  const subagents: GatewaySessionRow[] = [];
  const regularSessions: GatewaySessionRow[] = [];

  for (const session of sessions) {
    if (isSubagentSession(session.key)) {
      subagents.push(session);
    } else {
      regularSessions.push(session);
    }
  }

  // Build children map using multiple sources (in priority order):
  // 1. Local subagentParents map (most reliable, tracked at spawn time)
  // 2. spawnedBy field from gateway
  // 3. Fallback: first session for same agent
  const childrenMap = new Map<string, GatewaySessionRow[]>();
  const orphanedSubagents: GatewaySessionRow[] = [];

  for (const subagent of subagents) {
    let parentKey: string | null = null;
    let source = 'none';

    // 1. Check local tracking map (most reliable)
    if (subagentParents.has(subagent.key)) {
      parentKey = subagentParents.get(subagent.key)!;
      source = 'local-map';
    }
    // 2. Check spawnedBy field from gateway
    else if (subagent.spawnedBy) {
      parentKey = subagent.spawnedBy;
      source = 'spawnedBy';
    }
    // 3. Fallback: find first session for same agent
    else {
      const subagentAgentId = getAgentIdFromKey(subagent.key);
      if (subagentAgentId) {
        const firstSession = regularSessions.find(s =>
          getAgentIdFromKey(s.key) === subagentAgentId
        );
        if (firstSession) {
          parentKey = firstSession.key;
          source = 'fallback-first';
        }
      }
    }

    // Verify parent exists in our session list
    let parentExists = parentKey && regularSessions.some(s => s.key === parentKey);
    let matchedParentKey = parentKey;

    // If exact match fails, try fuzzy matching
    if (parentKey && !parentExists) {
      // Extract the bucket/suffix part (e.g., "fer" from "agent:smart-agent:fer")
      const parentParts = parentKey.split(':');
      const parentAgentId = parentParts.length >= 2 ? parentParts[1] : null;
      const parentSuffix = parentParts.length >= 3 ? parentParts.slice(2).join(':') : null;

      // Try to find a session that matches by agent ID and suffix
      const fuzzyMatch = regularSessions.find(s => {
        // Check if it's the same agent
        const sessionAgentId = getAgentIdFromKey(s.key);
        if (sessionAgentId !== parentAgentId) return false;

        // Check if the suffix matches (e.g., "fer" matches "webchat:g-agent-smart-agent-fer")
        if (parentSuffix) {
          // Direct suffix match
          if (s.key.endsWith(`:${parentSuffix}`)) return true;
          if (s.key.endsWith(`-${parentSuffix}`)) return true;
          // Check if the label or displayName matches
          if (s.label === parentSuffix || s.displayName === parentSuffix) return true;
        }

        return false;
      });

      if (fuzzyMatch) {
        matchedParentKey = fuzzyMatch.key;
        parentExists = true;
      }
    }

    if (matchedParentKey && parentExists) {
      if (!childrenMap.has(matchedParentKey)) {
        childrenMap.set(matchedParentKey, []);
      }
      childrenMap.get(matchedParentKey)!.push(subagent);
    } else {
      orphanedSubagents.push(subagent);
    }
  }

  // Create groups for regular sessions with their children
  for (const session of regularSessions) {
    const children = childrenMap.get(session.key) || [];
    // Sort children by updatedAt desc
    children.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));

    groups.push({
      session,
      children,
    });
  }

  // Add orphaned subagents as top-level entries
  for (const subagent of orphanedSubagents) {
    groups.push({
      session: subagent,
      children: [],
    });
  }

  return groups;
}

// Session List Item
function SessionItem({
  session,
  isSelected,
  onSelect,
  onDelete,
  isSubagent = false,
  hasChildren = false,
  isExpanded = false,
  onToggleExpand,
}: {
  session: GatewaySessionRow;
  isSelected: boolean;
  onSelect: () => void;
  onDelete: () => void;
  isSubagent?: boolean;
  hasChildren?: boolean;
  isExpanded?: boolean;
  onToggleExpand?: () => void;
}) {
  const [showMenu, setShowMenu] = useState(false);
  const { t } = useTranslation();

  const kindIcons = {
    direct: UserIcon,
    group: UsersIcon,
    global: Globe,
    unknown: AlertCircle,
  };

  // For subagent sessions, use Bot icon
  const isSubagentKey = isSubagentSession(session.key);
  const KindIcon = isSubagentKey ? Bot : (kindIcons[session.kind] || AlertCircle);

  // Extract short subagent ID for display
  const getSubagentDisplayName = () => {
    if (!isSubagentKey) return getSessionDisplayName(session);
    const match = session.key.match(/:subagent:([^:]+)/);
    const shortId = match ? match[1].slice(0, 8) : session.key;
    return session.displayName || session.derivedTitle || t('sessions.subagentLabel', { id: shortId });
  };

  return (
    <div
      className={cn(
        'group relative flex items-center gap-2 p-3 rounded-lg cursor-pointer transition-all',
        isSelected
          ? 'bg-primary/10 border-l-2 border-primary'
          : 'hover:bg-muted/50',
        isSubagent && 'ml-6 border-l border-dashed border-cyan-500/30'
      )}
      onClick={onSelect}
    >
      {/* Expand/Collapse button for parent sessions with children */}
      {hasChildren && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onToggleExpand?.();
          }}
          className="shrink-0 p-0.5 rounded hover:bg-muted/50 text-muted-foreground"
        >
          {isExpanded ? (
            <ChevronDown className="h-4 w-4" />
          ) : (
            <ChevronRight className="h-4 w-4" />
          )}
        </button>
      )}

      {/* Subagent branch indicator */}
      {isSubagent && (
        <div className="shrink-0 text-cyan-500/60">
          <GitBranch className="h-3.5 w-3.5" />
        </div>
      )}

      <div className={cn(
        'rounded-full flex items-center justify-center shrink-0',
        isSubagentKey ? 'h-8 w-8 bg-cyan-500/10 text-cyan-500' :
        session.kind === 'direct' ? 'h-10 w-10 bg-blue-500/10 text-blue-500' :
        session.kind === 'group' ? 'h-10 w-10 bg-purple-500/10 text-purple-500' :
        session.kind === 'global' ? 'h-10 w-10 bg-green-500/10 text-green-500' :
        'h-10 w-10 bg-muted text-muted-foreground'
      )}>
        <KindIcon className={isSubagentKey ? "h-4 w-4" : "h-5 w-5"} />
      </div>

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <p className={cn(
            "font-medium truncate",
            isSubagentKey ? "text-xs text-cyan-200" : "text-sm"
          )}>
            {getSubagentDisplayName()}
          </p>
          {session.abortedLastRun && (
            <span className="h-2 w-2 rounded-full bg-red-500" />
          )}
          {isSubagentKey && (
            <Badge variant="outline" className="text-[9px] px-1.5 py-0 bg-cyan-500/10 border-cyan-500/30 text-cyan-600 dark:text-cyan-400">
              {t('sessions.subagent')}
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span>{session.surface || (isSubagentKey ? t('sessions.agent') : t('sessions.direct'))}</span>
          {session.model && (
            <>
              <span>•</span>
              <span>{session.model}</span>
            </>
          )}
        </div>
      </div>

      <div className="flex items-center gap-2">
        <span className="text-xs text-muted-foreground">
          {formatTimestamp(session.updatedAt)}
        </span>
        <div className="relative">
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 opacity-0 group-hover:opacity-100"
            onClick={(e) => {
              e.stopPropagation();
              setShowMenu(!showMenu);
            }}
          >
            <MoreVertical className="h-4 w-4" />
          </Button>
          {showMenu && (
            <>
              <div
                className="fixed inset-0 z-10"
                onClick={() => setShowMenu(false)}
              />
              <div className="absolute right-0 top-full mt-1 z-20 bg-popover border rounded-md shadow-lg py-1 min-w-[120px]">
                <button
                  className="w-full px-3 py-2 text-sm text-left hover:bg-muted flex items-center gap-2 text-destructive"
                  onClick={(e) => {
                    e.stopPropagation();
                    onDelete();
                    setShowMenu(false);
                  }}
                >
                  <Trash2 className="h-4 w-4" />
                  {t('common.delete')}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// Chat Message Component
function ChatMessageItem({ message }: { message: ChatMessage }) {
  const { t } = useTranslation();
  const isUser = message.role === 'user';
  const isTool = message.role === 'tool';

  if (isTool) {
    return (
      <div className="flex items-start gap-3 my-3 animate-message-in">
        <div className="h-8 w-8 rounded-lg bg-orange-500/10 flex items-center justify-center shrink-0">
          <Wrench className="h-4 w-4 text-orange-500" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-sm font-medium text-orange-500">{message.toolName}</span>
            <span className="text-xs text-muted-foreground">{t('sessions.toolCall')}</span>
          </div>
          {message.content && (
            <pre className="text-xs bg-muted p-3 rounded-lg overflow-x-auto max-h-40 overflow-y-auto">
              {message.content.length > 500
                ? message.content.substring(0, 500) + '...'
                : message.content}
            </pre>
          )}
        </div>
      </div>
    );
  }

  return (
    <div
      className={cn(
        'flex gap-3 my-4 animate-message-in',
        isUser && 'flex-row-reverse'
      )}
    >
      <div
        className={cn(
          'h-8 w-8 rounded-full flex items-center justify-center shrink-0',
          isUser ? 'bg-primary text-primary-foreground' : 'bg-secondary'
        )}
      >
        {isUser ? (
          <UserIcon className="h-4 w-4" />
        ) : (
          <Bot className="h-4 w-4" />
        )}
      </div>
      <div
        className={cn(
          'flex-1 min-w-0 max-w-[80%]',
          isUser && 'flex flex-col items-end'
        )}
      >
        <div
          className={cn(
            'rounded-2xl px-4 py-2.5',
            isUser
              ? 'bg-primary text-primary-foreground rounded-tr-none'
              : 'bg-muted rounded-tl-none'
          )}
        >
          <p className="text-sm whitespace-pre-wrap break-words">{message.content}</p>
        </div>
        <span className="text-[10px] text-muted-foreground mt-1 px-2">
          {new Date(message.timestamp).toLocaleTimeString()}
        </span>
      </div>
    </div>
  );
}

// Chat Panel
function ChatPanel({ sessionKey }: { sessionKey: string }) {
  const {
    chatMessages,
    chatLoading,
    chatSending: chatSendingMap,
    streamingContent,
    sendMessage,
    abortChat,
    loadChatHistory,
  } = useDashboardStore();

  const { t } = useTranslation();
  const [inputValue, setInputValue] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Get per-session sending state
  const chatSending = chatSendingMap.get(sessionKey) || false;

  useEffect(() => {
    loadChatHistory(sessionKey);
  }, [sessionKey, loadChatHistory]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chatMessages, streamingContent]);

  const handleSend = () => {
    if (!inputValue.trim() || chatSending) return;
    sendMessage(inputValue.trim());
    setInputValue('');
    inputRef.current?.focus();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="flex flex-col h-full">
      {/* Messages */}
      <ScrollArea className="flex-1 p-4">
        {chatLoading ? (
          <div className="flex items-center justify-center h-32">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : chatMessages.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-32 text-muted-foreground">
            <MessageSquare className="h-8 w-8 mb-2 opacity-50" />
            <p>{t('sessions.noMessages')}</p>
            <p className="text-sm">{t('sessions.startConversation')}</p>
          </div>
        ) : (
          <>
            {chatMessages.map((msg) => (
              <ChatMessageItem key={msg.id} message={msg} />
            ))}
            {streamingContent && (
              <div className="flex gap-3 my-4 animate-message-in">
                <div className="h-8 w-8 rounded-full bg-secondary flex items-center justify-center shrink-0">
                  <Bot className="h-4 w-4" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="rounded-2xl rounded-tl-none bg-muted px-4 py-2.5">
                    <p className="text-sm whitespace-pre-wrap">{streamingContent}</p>
                    <span className="inline-block w-2 h-4 bg-foreground/50 animate-pulse ml-0.5" />
                  </div>
                </div>
              </div>
            )}
          </>
        )}
        <div ref={messagesEndRef} />
      </ScrollArea>

      {/* Input */}
      <div className="border-t p-4">
        <div className="flex items-center gap-2">
          <Input
            ref={inputRef}
            placeholder={t('sessions.typeMessage')}
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={chatSending}
            className="flex-1"
          />
          {chatSending ? (
            <Button
              variant="destructive"
              size="icon"
              onClick={() => abortChat()}
            >
              <Square className="h-4 w-4" />
            </Button>
          ) : (
            <Button
              size="icon"
              onClick={handleSend}
              disabled={!inputValue.trim()}
            >
              <Send className="h-4 w-4" />
            </Button>
          )}
        </div>
        {chatSending && (
          <div className="flex items-center gap-2 mt-2 text-sm text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" />
            <span>{t('sessions.agentThinking')}</span>
          </div>
        )}
      </div>
    </div>
  );
}

export function SessionsPage() {
  const {
    sessions,
    sessionsLoading,
    selectedSessionKey,
    selectSession,
    deleteSession,
    subagentParents,
  } = useDashboardStore();

  const { t } = useTranslation();
  const [searchQuery, setSearchQuery] = useState('');
  const [filterKind, setFilterKind] = useState<string | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);
  const [expandedSessions, setExpandedSessions] = useState<Set<string>>(new Set());

  const filteredSessions = (sessions?.sessions || []).filter((session) => {
    const matchesSearch =
      !searchQuery ||
      getSessionDisplayName(session).toLowerCase().includes(searchQuery.toLowerCase()) ||
      session.key.toLowerCase().includes(searchQuery.toLowerCase());

    const matchesFilter = !filterKind || session.kind === filterKind;

    return matchesSearch && matchesFilter;
  });

  // Group sessions hierarchically
  const sessionGroups = useMemo(() => {
    return groupSessionsHierarchically(filteredSessions, subagentParents);
  }, [filteredSessions, subagentParents]);

  const toggleExpand = (key: string) => {
    setExpandedSessions(prev => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

  // Auto-expand sessions with children when a child is selected or when new subagents are tracked
  useEffect(() => {
    // If a subagent is selected, expand its parent
    if (selectedSessionKey && isSubagentSession(selectedSessionKey)) {
      // Try to find the parent from our tracking map first
      const trackedParent = subagentParents.get(selectedSessionKey);
      if (trackedParent && !expandedSessions.has(trackedParent)) {
        setExpandedSessions(prev => new Set(prev).add(trackedParent));
        return;
      }
      // Fallback to the legacy method
      const parentKey = getParentSessionKey(selectedSessionKey);
      if (parentKey && !expandedSessions.has(parentKey)) {
        setExpandedSessions(prev => new Set(prev).add(parentKey));
      }
    }
  }, [selectedSessionKey, subagentParents]);

  // Auto-expand parents when new subagents are added to the tracking map
  useEffect(() => {
    if (subagentParents.size === 0) return;

    // Get all unique parent keys
    const parentKeys = new Set(subagentParents.values());

    // Expand any parents that aren't already expanded
    setExpandedSessions(prev => {
      let hasChanges = false;
      const next = new Set(prev);
      parentKeys.forEach(parentKey => {
        if (!next.has(parentKey)) {
          next.add(parentKey);
          hasChanges = true;
        }
      });
      return hasChanges ? next : prev;
    });
  }, [subagentParents]);

  const selectedSession = filteredSessions.find((s) => s.key === selectedSessionKey);

  const handleDelete = async (key: string) => {
    await deleteSession(key);
    setDeleteConfirm(null);
  };

  return (
    <div className="min-h-screen">
      <Header
        title={t('sessions.title')}
        description={t('sessions.totalSessions', { count: String(sessions?.count || 0) })}
      />

      <div className="flex h-[calc(100vh-64px)]">
        {/* Sessions List */}
        <div className="w-96 border-r flex flex-col">
          {/* Search and Filters */}
          <div className="p-4 border-b space-y-3">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder={t('sessions.searchSessions')}
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-10"
              />
            </div>
            <div className="flex gap-2">
              {(['direct', 'group', 'global'] as const).map((kind) => (
                <Button
                  key={kind}
                  variant={filterKind === kind ? 'default' : 'outline'}
                  size="sm"
                  onClick={() => setFilterKind(filterKind === kind ? null : kind)}
                >
                  {t(`sessions.${kind}`)}
                </Button>
              ))}
            </div>
          </div>

          {/* Sessions List */}
          <ScrollArea className="flex-1">
            <div className="p-2">
              {sessionsLoading ? (
                <div className="space-y-2 p-2">
                  {[1, 2, 3, 4, 5].map((i) => (
                    <div key={i} className="h-16 rounded-lg bg-muted animate-pulse" />
                  ))}
                </div>
              ) : filteredSessions.length === 0 ? (
                <div className="text-center py-8 text-muted-foreground">
                  <MessageSquare className="h-8 w-8 mx-auto mb-2 opacity-50" />
                  <p>{searchQuery || filterKind ? t('sessions.noSessionsFound') : t('sessions.noSessionsYet')}</p>
                </div>
              ) : (
                sessionGroups.map((group) => (
                  <div key={group.session.key}>
                    <SessionItem
                      session={group.session}
                      isSelected={group.session.key === selectedSessionKey}
                      onSelect={() => selectSession(group.session.key)}
                      onDelete={() => setDeleteConfirm(group.session.key)}
                      hasChildren={group.children.length > 0}
                      isExpanded={expandedSessions.has(group.session.key)}
                      onToggleExpand={() => toggleExpand(group.session.key)}
                    />
                    {/* Render child subagent sessions when expanded */}
                    {group.children.length > 0 && expandedSessions.has(group.session.key) && (
                      <div className="relative">
                        {group.children.map((child) => (
                          <SessionItem
                            key={child.key}
                            session={child}
                            isSelected={child.key === selectedSessionKey}
                            onSelect={() => selectSession(child.key)}
                            onDelete={() => setDeleteConfirm(child.key)}
                            isSubagent
                          />
                        ))}
                      </div>
                    )}
                  </div>
                ))
              )}
            </div>
          </ScrollArea>
        </div>

        {/* Chat Area */}
        <div className="flex-1 flex flex-col">
          {selectedSession ? (
            <>
              {/* Session Header */}
              <div className="flex items-center justify-between px-6 py-4 border-b">
                <div className="flex items-center gap-3">
                  {isSubagentSession(selectedSession.key) ? (
                    <div className="h-10 w-10 rounded-full flex items-center justify-center bg-cyan-500/10 text-cyan-500">
                      <Bot className="h-5 w-5" />
                    </div>
                  ) : (
                    <div className={cn(
                      'h-10 w-10 rounded-full flex items-center justify-center',
                      selectedSession.kind === 'direct' ? 'bg-blue-500/10 text-blue-500' :
                      selectedSession.kind === 'group' ? 'bg-purple-500/10 text-purple-500' :
                      'bg-green-500/10 text-green-500'
                    )}>
                      {selectedSession.kind === 'direct' && <UserIcon className="h-5 w-5" />}
                      {selectedSession.kind === 'group' && <UsersIcon className="h-5 w-5" />}
                      {selectedSession.kind === 'global' && <Globe className="h-5 w-5" />}
                    </div>
                  )}
                  <div>
                    <h2 className="font-semibold">
                      {isSubagentSession(selectedSession.key)
                        ? (selectedSession.displayName || selectedSession.derivedTitle || t('sessions.subagentLabel', { id: selectedSession.key.match(/:subagent:([^:]+)/)?.[1]?.slice(0, 8) || '' }))
                        : getSessionDisplayName(selectedSession)
                      }
                    </h2>
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                      {isSubagentSession(selectedSession.key) ? (
                        <Badge variant="outline" className="text-xs bg-cyan-500/10 border-cyan-500/30 text-cyan-600 dark:text-cyan-400">
                          {t('sessions.subagent')}
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="text-xs">{selectedSession.kind}</Badge>
                      )}
                      {selectedSession.surface && <span>{selectedSession.surface}</span>}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {selectedSession.totalTokens && (
                    <Badge variant="secondary">
                      {formatNumber(selectedSession.totalTokens)} tokens
                    </Badge>
                  )}
                  <Button
                    variant="ghost"
                    size="icon"
                    className="text-destructive hover:text-destructive"
                    onClick={() => setDeleteConfirm(selectedSession.key)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </div>

              {/* Chat */}
              <div className="flex-1 min-h-0">
                <ChatPanel sessionKey={selectedSession.key} />
              </div>
            </>
          ) : (
            <div className="flex-1 flex items-center justify-center">
              <div className="text-center">
                <MessageSquare className="h-16 w-16 mx-auto mb-4 text-muted-foreground opacity-30" />
                <h3 className="text-lg font-medium">{t('sessions.selectSession')}</h3>
                <p className="text-muted-foreground mt-1">
                  {t('sessions.selectSessionDesc')}
                </p>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Delete Confirmation Modal */}
      {deleteConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-background/80 backdrop-blur-sm" onClick={() => setDeleteConfirm(null)} />
          <Card className="relative z-10 w-full max-w-md mx-4">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-destructive">
                <Trash2 className="h-5 w-5" />
                {t('sessions.deleteSession')}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <p className="text-muted-foreground">
                {t('sessions.deleteConfirmFull')}
              </p>
              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={() => setDeleteConfirm(null)}>
                  {t('common.cancel')}
                </Button>
                <Button variant="destructive" onClick={() => handleDelete(deleteConfirm)}>
                  {t('common.delete')}
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
