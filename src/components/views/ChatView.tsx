import * as React from 'react';
import { useRef, useEffect, useState, useCallback, useMemo } from 'react';
import { useDashboardStore } from '../../store/dashboard-store';
import { useTranslation } from '../../i18n';
import {
  ArrowLeft,
  Send,
  ChevronDown,
  Sparkles,
  X,
  Zap,
  Info,
  Monitor,
  FolderOpen,
  Wrench,
} from 'lucide-react';
import { formatNumber, cn } from '../../lib/utils';
import { resolveSessionKey } from '../../lib/session-utils';
import { Button } from '../ui/button';
import { Tooltip, TooltipTrigger, TooltipContent } from '../ui/tooltip';
import { SessionTasksKanban } from '../sessions/SessionTasksKanban';
import { BrowserPanel } from '../layout/BrowserPanel';
import { WorkspacePanel } from '../agents/WorkspacePanel';
import { BrainPanel } from '../agents/BrainPanel';
import { AgentToolsPanel } from '../agents/AgentToolsPanel';
import { SkillsPanel } from '../agents/SkillsPanel';

// Chat components — extracted from this file for maintainability
import {
  MessageBubble,
  TypingIndicator,
  ActivityBar,
  AgentStatusDot,
  ToolsPanel,
  CodeBlock,
  setCodeBlockComponent,
} from '../chat';

// Register CodeBlock with the markdown renderer (avoids circular dependency)
setCodeBlockComponent(CodeBlock);

// ============== Main ChatView Component ==============

export function ChatView({ sessionKey, agentPanel, onCloseAgentPanel }: { sessionKey: string; agentPanel?: string | null; onCloseAgentPanel?: () => void }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const scrollSentinelRef = useRef<HTMLDivElement>(null);
  const scrollRafRef = useRef<number | null>(null);
  const scrollRetryRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const userScrolledUp = useRef(false);
  const [showScrollButton, setShowScrollButton] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const { t } = useTranslation();

  const {
    chatMessages,
    sendMessage,
    chatLoading,
    chatSending: chatSendingMap,
    activeRunId: activeRunIdMap,
    streamingContent,
    streamingComplete,
    selectSession,
    agents,
    sessions,
    loadAgents,
    loadSessions,
    connected,
    browserPanelOpen,
    browserDetached,
    browserAgentAction,
    setBrowserPanelOpen,
    sessionCumulativeTokens,
    availableModels,
    rateLimitedUntil,
  } = useDashboardStore();

  const [inputFocused, setInputFocused] = useState(false);

  // Right panel: top section tabs
  const [activeTopTab, setActiveTopTab] = useState<string>('tasks');

  // Vertical split between top tabs and bottom Tools (percentage for top section)
  const [toolsSplit, setToolsSplit] = useState(() => {
    const saved = localStorage.getItem('silos-chat-tools-split');
    return saved ? Math.max(15, Math.min(85, Number(saved))) : 50;
  });
  const isSplitDragging = useRef(false);
  const toolsSplitRef = useRef(toolsSplit);
  toolsSplitRef.current = toolsSplit;

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (!isSplitDragging.current || !splitContainerRef.current) return;
      e.preventDefault();
      const rect = splitContainerRef.current.getBoundingClientRect();
      const pct = ((e.clientY - rect.top) / rect.height) * 100;
      setToolsSplit(Math.max(15, Math.min(85, pct)));
    };
    const onMouseUp = () => {
      if (!isSplitDragging.current) return;
      isSplitDragging.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      localStorage.setItem('silos-chat-tools-split', String(toolsSplitRef.current));
    };
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
  }, []);

  // Auto-switch to browser tab when agent starts using browser
  useEffect(() => {
    if (browserPanelOpen && browserDetached === 'none') {
      setActiveTopTab('browser');
    }
  }, [browserPanelOpen, browserDetached]);

  // Auto-resize panel when agent panel opens
  useEffect(() => {
    if (agentPanel && panelWidth < widePanelWidth) {
      setPanelWidth(widePanelWidth);
    }
  }, [agentPanel]); // eslint-disable-line react-hooks/exhaustive-deps

  // Resizable right panel (width)
  const defaultPanelWidth = 384;
  const widePanelWidth = 525;
  const [panelWidth, setPanelWidth] = useState(() => {
    const saved = localStorage.getItem('silos-chat-panel-width');
    return saved ? Math.max(260, Math.min(900, Number(saved))) : defaultPanelWidth;
  });
  const isDragging = useRef(false);
  const dragStartX = useRef(0);

  const splitContainerRef = useRef<HTMLDivElement>(null);
  const dragStartWidth = useRef(0);
  const panelWidthRef = useRef(panelWidth);
  panelWidthRef.current = panelWidth;

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (!isDragging.current) return;
      e.preventDefault();
      const delta = dragStartX.current - e.clientX;
      const newWidth = Math.max(260, Math.min(900, dragStartWidth.current + delta));
      setPanelWidth(newWidth);
    };
    const onMouseUp = () => {
      if (!isDragging.current) return;
      isDragging.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      localStorage.setItem('silos-chat-panel-width', String(panelWidthRef.current));
    };
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
  }, []);


  const effectiveKey = resolveSessionKey(sessionKey);

  // Extract agentId from sessionKey for workspace panel
  const chatAgentId = useMemo(() => {
    const m = sessionKey.match(/^(?:agent:|dm-)([^:]+)/);
    return m ? m[1] : null;
  }, [sessionKey]);

  // Find current session for token counts
  const currentSession = sessions?.sessions?.find(s => s.key === effectiveKey || s.key === sessionKey);

  // Get per-session sending state
  const chatSending = chatSendingMap.get(sessionKey) || false;
  const hasActiveRun = !!activeRunIdMap.get(sessionKey);

  // Agent working state (for status dot)
  const tasks = useDashboardStore((s) => s.tasks);
  const isAgentWorking = chatSending || hasActiveRun || tasks.some(
    t => t.status === 'running' && t.sessionKey === effectiveKey
  );

  // Rate limit from store (survives unmount/remount)
  const isRateLimited = Date.now() < rateLimitedUntil;

  // Memoize filtered messages
  const filteredMessages = useMemo(
    () => {
      const msgs = chatMessages.filter(msg =>
        !(msg.role === 'tool' || msg.toolName || msg.toolCall || msg.result) &&
        msg.status !== 'queued'
      );
      const seenUserContent = new Map<string, { timestamp: number; status?: string }>();
      return msgs.filter((msg, i) => {
        if (msg.role === 'user' && msg.content) {
          const prev = seenUserContent.get(msg.content);
          if (prev !== undefined && Math.abs((msg.timestamp || 0) - prev.timestamp) < 5_000) {
            const isOptimistic = msg.status === 'sending' || msg.status === 'delivered'
              || prev.status === 'sending' || prev.status === 'delivered';
            if (isOptimistic) return false;
          }
          seenUserContent.set(msg.content, { timestamp: msg.timestamp || 0, status: msg.status });
          return true;
        }
        if (i === 0 || msg.role !== msgs[i - 1].role || msg.content !== msgs[i - 1].content) return true;
        return msg.runId !== msgs[i - 1].runId;
      });
    },
    [chatMessages]
  );

  // Count queued messages
  const queuedCount = chatMessages.filter(m => m.role === 'user' && m.status === 'queued').length;

  const agentList = agents?.agents || [];

  // Load data when component mounts or connection changes
  useEffect(() => {
    if (connected) {
      loadAgents();
      loadSessions();
    }
  }, [connected, loadAgents, loadSessions]);

  useEffect(() => {
    selectSession(sessionKey);
    userScrolledUp.current = false;
    setShowScrollButton(false);
  }, [sessionKey, selectSession]);

  // Retry chat history load when connection becomes available (handles page refresh)
  useEffect(() => {
    if (connected && chatMessages.length === 0 && !chatLoading) {
      useDashboardStore.getState().loadChatHistory(sessionKey);
    }
  }, [connected, sessionKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // Detect when user scrolls up manually — pause auto-scroll so they can read
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 450;
      userScrolledUp.current = !atBottom;
      setShowScrollButton(!atBottom);
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

  // Auto-scroll — smooth during streaming, instant for new messages; respects user scroll position
  useEffect(() => {
    if (userScrolledUp.current) return;

    if (scrollRafRef.current !== null) {
      cancelAnimationFrame(scrollRafRef.current);
    }
    if (scrollRetryRef.current !== null) {
      clearTimeout(scrollRetryRef.current);
      scrollRetryRef.current = null;
    }

    scrollRafRef.current = requestAnimationFrame(() => {
      scrollRafRef.current = null;
      const el = scrollRef.current;
      if (!el) return;

      const prefersReduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
      const behavior = streamingContent && !prefersReduced ? 'smooth' : 'instant';

      el.scrollTo({ top: el.scrollHeight, behavior });

      scrollRetryRef.current = setTimeout(() => {
        scrollRetryRef.current = null;
        if (!userScrolledUp.current && scrollRef.current) {
          scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
        }
      }, 120);
    });
  }, [chatMessages, streamingContent, chatSending]);

  // Reset scroll lock when user sends a new message
  useEffect(() => {
    if (chatSending) {
      userScrolledUp.current = false;
      setShowScrollButton(false);
    }
  }, [chatSending]);

  // Cleanup RAF + scroll retry on unmount
  useEffect(() => {
    return () => {
      if (scrollRafRef.current !== null) cancelAnimationFrame(scrollRafRef.current);
      if (scrollRetryRef.current !== null) clearTimeout(scrollRetryRef.current);
    };
  }, []);

  // Auto-resize textarea
  const handleInputChange = useCallback(() => {
    if (inputRef.current) {
      inputRef.current.style.height = 'auto';
      inputRef.current.style.height = Math.min(inputRef.current.scrollHeight, 150) + 'px';
    }
  }, []);

  const STOP_COMMANDS = new Set(['stop', '/stop', 'abort', '/abort', 'esc', '/esc']);

  const handleSend = (e: React.FormEvent) => {
    e.preventDefault();
    if (isRateLimited) return;
    const text = inputRef.current?.value.trim();
    if (!text) return;

    if (STOP_COMMANDS.has(text.toLowerCase()) && isAgentWorking) {
      inputRef.current!.value = '';
      inputRef.current!.style.height = 'auto';
      useDashboardStore.getState().abortChat();
      return;
    }

    sendMessage(text);
    inputRef.current!.value = '';
    inputRef.current!.style.height = 'auto';
  };

  const scrollToBottom = useCallback(() => {
    userScrolledUp.current = false;
    setShowScrollButton(false);
    if (scrollRef.current) {
      scrollRef.current.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
    }
  }, []);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend(e);
    }
  };

  return (
    <div className="flex flex-col h-full bg-background overflow-hidden">
      {/* Main Content: Two Columns (Chat + Tasks) */}
      <div className="flex flex-1 min-h-0">
        {/* LEFT: Chat Column */}
        <div className="flex-1 flex flex-col min-w-0 min-h-0 overflow-hidden relative">
          {/* Messages Area */}
        <div ref={scrollRef} className="flex-1 overflow-y-auto overflow-x-hidden p-6 space-y-6 custom-scrollbar">
          {/* Empty State */}
          {chatMessages.length === 0 && !chatLoading && (
            <div className="flex flex-col items-center justify-center h-full text-center py-16">
              <div className="relative mb-8">
                <div className="absolute inset-0 bg-gradient-to-br from-primary/20 to-accent/20 rounded-3xl blur-2xl animate-pulse" />
                <div className="relative w-28 h-28 rounded-3xl bg-card border flex items-center justify-center shadow-sm">
                  <Sparkles className="w-14 h-14 text-primary animate-float" />
                </div>
              </div>

              <h3 className="text-2xl font-bold text-foreground mb-3">{t('chat.sessionInitialized')}</h3>
              <p className="text-sm text-muted-foreground max-w-md mb-8 leading-relaxed">
                {t('chat.sessionInitializedDesc')}
              </p>

              <div className="flex flex-wrap justify-center gap-2 max-w-lg">
                {[t('chat.suggestion1'), t('chat.suggestion2'), t('chat.suggestion3')].map((suggestion, i) => (
                  <button
                    key={i}
                    onClick={() => {
                      if (inputRef.current) {
                        inputRef.current.value = suggestion;
                        inputRef.current.focus();
                      }
                    }}
                    className="px-4 py-2 rounded-full bg-muted border text-sm text-foreground/80 hover:bg-muted/80 hover:text-foreground transition-all duration-200 flex items-center gap-2"
                  >
                    <Sparkles className="w-3.5 h-3.5 text-primary" />
                    {suggestion}
                  </button>
                ))}
              </div>
            </div>
          )}

          {filteredMessages.map((msg, i, arr) => {
            if (streamingContent && streamingComplete && msg.role === 'assistant' && i === arr.length - 1) {
              return null;
            }
            const showAvatar = i === 0 ||
              arr[i-1].role !== msg.role ||
              Boolean(arr[i-1].timestamp && msg.timestamp - arr[i-1].timestamp > 60000);

            return (
              <MessageBubble
                key={msg.id}
                message={msg}
                showAvatar={showAvatar}
                agents={agentList}
                sessionKey={effectiveKey}
              />
            );
          })}

          {/* Streaming / Typing Indicator */}
          {(streamingContent || chatSending) && (
            <TypingIndicator streamingContent={streamingContent} isComplete={streamingComplete} />
          )}

          <div ref={scrollSentinelRef} className="h-4" />

          {/* Scroll-to-bottom button */}
          {showScrollButton && (
            <div className="sticky bottom-3 z-10 flex justify-center pointer-events-none -mt-12">
              <button
                onClick={scrollToBottom}
                className="pointer-events-auto flex items-center gap-2 px-4 py-2 rounded-full bg-foreground/80 hover:bg-foreground/90 text-background text-xs font-medium shadow-elevation-2 transition-all duration-200 animate-in fade-in slide-in-from-bottom-2"
              >
                <ChevronDown className="w-3.5 h-3.5" />
                {t('chat.newMessages') || 'New messages'}
              </button>
            </div>
          )}
        </div>

        {/* Activity Bar — queued messages */}
        {queuedCount > 0 && (
          <ActivityBar
            queuedCount={queuedCount}
            onRemoveLast={() => {
              const { removeLastQueued } = useDashboardStore.getState();
              removeLastQueued();
            }}
          />
        )}

        {/* Input Area */}
        <div className="relative p-4 bg-gradient-to-t from-background via-background to-transparent">
          <div className="absolute top-0 left-0 right-0 h-8 bg-gradient-to-t from-background to-transparent -translate-y-full pointer-events-none" />

          <div className={cn(
            "relative rounded-2xl transition-all duration-300",
            "bg-card",
            "border shadow-sm",
            inputFocused
              ? "border-foreground/20 shadow-foreground/5 ring-2 ring-foreground/10"
              : ""
          )}>
            <div className="absolute inset-0 rounded-2xl bg-gradient-to-br from-white/[0.02] to-transparent pointer-events-none" />

            <form onSubmit={handleSend} className="relative flex flex-col">
              <textarea
                ref={inputRef}
                className="w-full bg-transparent px-5 py-4 focus:outline-none text-sm placeholder:text-muted-foreground/40 font-medium resize-none min-h-[56px] max-h-[150px]"
                placeholder={isRateLimited ? t('chat.rateLimitWait') : chatSending ? 'Agent is processing...' : t('chat.placeholder')}
                disabled={isRateLimited}
                onKeyDown={handleKeyDown}
                onFocus={() => setInputFocused(true)}
                onBlur={() => setInputFocused(false)}
                onChange={handleInputChange}
                rows={1}
                autoFocus
              />

              <div className="flex items-center justify-between px-4 pb-3">
                {/* Left side - status and tools */}
                <div className="flex items-center gap-3">
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <AgentStatusDot isWorking={connected && isAgentWorking} />
                    <span className="font-medium">
                      {!connected ? 'Disconnected' : isAgentWorking ? 'Working...' : t('chat.systemReady')}
                    </span>
                  </div>

                  {/* Context utilization */}
                  {currentSession?.totalTokens !== undefined && currentSession.totalTokens > 0 && (() => {
                    const used = currentSession.totalTokens!;
                    const provider = currentSession.modelProvider;
                    const max = (provider && currentSession.model && availableModels?.[provider]
                      ?.find(m => m.id === currentSession.model)?.contextWindow) || null;
                    const pct = max ? Math.min((used / max) * 100, 100) : null;
                    const barColor = pct === null ? ''
                      : pct < 50 ? 'bg-emerald-500/70'
                      : pct < 80 ? 'bg-amber-500/70'
                      : 'bg-red-500/80';
                    return (
                      <div className="flex items-center gap-2 pl-2 border-l">
                        <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground font-mono">
                          <span>{formatNumber(used)}{max ? ` / ${formatNumber(max)}` : ''}</span>
                        </div>
                        {pct !== null && (
                          <div className="w-12 h-1 rounded-full bg-muted/60 overflow-hidden" title={`${pct.toFixed(0)}% ${t('chat.context').toLowerCase()}`}>
                            <div
                              className={`h-full rounded-full transition-all duration-500 ${barColor}`}
                              style={{ width: `${pct}%` }}
                            />
                          </div>
                        )}
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Info className="w-3 h-3 text-muted-foreground/40 hover:text-muted-foreground cursor-help transition-colors" />
                          </TooltipTrigger>
                          <TooltipContent side="right" className="w-56 text-xs leading-relaxed">
                            {t('chat.contextInfo')}
                          </TooltipContent>
                        </Tooltip>
                      </div>
                    );
                  })()}

                  {/* Session cumulative tokens */}
                  {(() => {
                    const cumulative = sessionCumulativeTokens.get(effectiveKey);
                    const total = cumulative?.total || (currentSession?.inputTokens || 0) + (currentSession?.outputTokens || 0);
                    if (!total) return null;
                    return (
                      <div className="flex items-center gap-1.5 pl-2 border-l text-[10px] text-muted-foreground font-mono">
                        <Zap className="w-2.5 h-2.5" />
                        <span>{formatNumber(total)} total</span>
                      </div>
                    );
                  })()}

                </div>

                {/* Send button + Abort button */}
                <div className="flex items-center gap-2">
                  {(chatSending || hasActiveRun || isAgentWorking) && (
                    <Button
                      type="button"
                      onClick={() => {
                        const { abortChat } = useDashboardStore.getState();
                        abortChat();
                      }}
                      size="sm"
                      variant="ghost"
                      className="gap-1.5 px-3 text-red-600 dark:text-red-400 hover:text-red-600 dark:hover:text-red-300 hover:bg-red-500/10"
                    >
                      <X className="w-3.5 h-3.5" />
                      Stop
                    </Button>
                  )}
                  <Button
                    type="submit"
                    disabled={isRateLimited}
                    size="sm"
                    className={cn(
                      "gap-2 px-4 transition-all duration-200",
                      "bg-foreground/90 hover:bg-foreground text-background",
                      "shadow-elevation-1 hover:shadow-elevation-2",
                    )}
                  >
                    {t('chat.send')}
                    <Send className="w-3.5 h-3.5" />
                  </Button>
                </div>
              </div>
            </form>
          </div>

          {/* Keyboard hint */}
          <p className="text-[10px] text-muted-foreground text-center mt-2">
            <kbd className="px-1.5 py-0.5 rounded bg-muted border font-mono text-[10px]">Enter</kbd> {t('chat.keyHintSend')} <kbd className="px-1.5 py-0.5 rounded bg-muted border font-mono text-[10px]">Shift+Enter</kbd> {t('chat.keyHintNewLine')}
          </p>
        </div>
        </div>
        {/* End Chat Column */}

        {/* Resize Handle */}
        <div
          className="w-1 shrink-0 cursor-col-resize group relative hover:bg-primary/20 active:bg-primary/20 transition-colors"
          onMouseDown={(e) => {
            e.preventDefault();
            isDragging.current = true;
            dragStartX.current = e.clientX;
            dragStartWidth.current = panelWidth;
            document.body.style.cursor = 'col-resize';
            document.body.style.userSelect = 'none';
          }}
        >
          <div className="absolute inset-y-0 -left-1 -right-1" />
          <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-0.5 h-8 rounded-full bg-border group-hover:bg-primary/40 transition-colors" />
        </div>

        {/* RIGHT: Top tabs (Pipeline / Browser) + Bottom Tools */}
        <div ref={splitContainerRef} className="flex flex-col shrink-0" style={{ width: panelWidth }}>
          {/* Top section */}
          <div className="flex flex-col min-h-0 overflow-hidden" style={{ height: `${toolsSplit}%` }}>
            {agentPanel && chatAgentId ? (
              <>
                <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border shrink-0">
                  <button
                    onClick={() => onCloseAgentPanel?.()}
                    className="p-1 rounded-md text-primary hover:text-primary/80 hover:bg-primary/10 transition-colors"
                  >
                    <ArrowLeft className="w-3.5 h-3.5" />
                  </button>
                  <span className="text-[10px] font-semibold uppercase tracking-wider text-foreground">
                    {agentPanel === 'brain' ? 'Brain' : agentPanel === 'tools' ? 'Tools' : 'Skills'}
                  </span>
                </div>
                <div className="flex-1 min-h-0 overflow-hidden">
                  {agentPanel === 'brain' && <BrainPanel agentId={chatAgentId} />}
                  {agentPanel === 'tools' && <AgentToolsPanel agentId={chatAgentId} />}
                  {agentPanel === 'skills' && <SkillsPanel agentId={chatAgentId} />}
                </div>
              </>
            ) : (
              <>
                <div className="flex border-b border-border shrink-0">
                  {([
                    { id: 'tasks' as const, icon: Sparkles, label: 'Pipeline', color: 'text-amber-500' },
                    { id: 'browser' as const, icon: Monitor, label: 'Browser', color: 'text-primary' },
                    { id: 'workspace' as const, icon: FolderOpen, label: 'Workspace', color: 'text-emerald-500' },
                  ]).map(tab => (
                    <button
                      key={tab.id}
                      onClick={() => {
                        setActiveTopTab(tab.id);
                        if (tab.id === 'browser' && !browserPanelOpen) setBrowserPanelOpen(true);
                        if (panelWidth < widePanelWidth) setPanelWidth(widePanelWidth);
                      }}
                      className={cn(
                        "flex items-center gap-1.5 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider transition-colors relative",
                        activeTopTab === tab.id
                          ? "text-foreground"
                          : "text-muted-foreground hover:text-foreground/70"
                      )}
                    >
                      <tab.icon className={cn("h-3 w-3", activeTopTab === tab.id ? tab.color : "")} />
                      {tab.label}
                      {tab.id === 'browser' && browserAgentAction && (
                        <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />
                      )}
                      {activeTopTab === tab.id && (
                        <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-primary" />
                      )}
                    </button>
                  ))}
                </div>
                <div className="flex-1 min-h-0 overflow-hidden">
                  {activeTopTab === 'tasks' && (
                    <SessionTasksKanban sessionKey={effectiveKey} />
                  )}
                  {activeTopTab === 'browser' && (
                    <BrowserPanel embedded />
                  )}
                  {activeTopTab === 'workspace' && chatAgentId && (
                    <WorkspacePanel agentId={chatAgentId} />
                  )}
                </div>
              </>
            )}
          </div>

          {/* Horizontal resize handle */}
          <div
            className="h-1 shrink-0 cursor-row-resize group relative hover:bg-primary/20 active:bg-primary/20 transition-colors border-y border-border/20"
            onMouseDown={(e) => {
              e.preventDefault();
              isSplitDragging.current = true;
              document.body.style.cursor = 'row-resize';
              document.body.style.userSelect = 'none';
            }}
          >
            <div className="absolute inset-x-0 -top-1 -bottom-1" />
            <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 h-0.5 w-8 rounded-full bg-border group-hover:bg-primary/40 transition-colors" />
          </div>

          {/* Bottom: Tools (always visible) */}
          <div className="flex-1 min-h-0 overflow-hidden">
            <div className="flex items-center gap-1.5 px-3 py-1.5 border-b border-border/40 shrink-0">
              <Wrench className="h-3 w-3 text-cyan-500" />
              <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">Tools</span>
            </div>
            <div className="h-[calc(100%-28px)]">
              <ToolsPanel messages={chatMessages} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
