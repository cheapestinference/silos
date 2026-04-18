import * as React from 'react';
import { Clock, AlertTriangle, Loader2 } from 'lucide-react';
import { formatTimestamp, cn } from '../../lib/utils';
import { Tooltip, TooltipTrigger, TooltipContent } from '../ui/tooltip';
import { useTranslation } from '../../i18n';
import type { ChatMessage, AgentSummary } from '../../types/openclaw';
import { extractMessageText, isStructuredMessage, renderMarkdown } from './chat-utils';
import { CompactSystemMessage } from './CompactSystemMessage';
import { ToolCallExpander } from './ToolCallExpander';
import { MessageAvatar } from './MessageAvatar';
import { InterSessionEventCard } from './InterSessionEventCard';
import { MessageContent } from './MessageContent';
import { MessageActions } from './MessageActions';
import { useDashboardStore } from '../../store/dashboard-store';

interface MessageBubbleProps {
  message: ChatMessage;
  showAvatar: boolean;
  agents: AgentSummary[];
  sessionKey?: string;
}

export const MessageBubble = React.memo(function MessageBubble({ message, showAvatar, agents, sessionKey }: MessageBubbleProps) {
  const { t } = useTranslation();

  // Inter-session events (subagent announces etc.) render as a dedicated event
  // card, centered, without avatar/user-bubble chrome.
  if (message.meta?.kind === 'inter_session') {
    return (
      <div className="flex justify-center w-full my-1">
        <InterSessionEventCard meta={message.meta} timestamp={message.timestamp} />
      </div>
    );
  }

  // NEW: canonical content blocks (Phase 2)
  if (message.contentBlocks && message.contentBlocks.length > 0) {
    const isUserMsg = message.role === 'user';
    const key = sessionKey ?? '';
    // Don't subscribe to entire map; read once on render — Zustand re-renders on any mutation.
    const isPinned = useDashboardStore(s => key ? s.isPinned(key, message.id) : false);
    const isDeletedMsg = useDashboardStore(s => key ? s.isDeleted(key, message.id) : false);
    const togglePinned = useDashboardStore(s => s.togglePinned);
    const toggleDeleted = useDashboardStore(s => s.toggleDeleted);

    const copyText = async () => {
      const text = message.content || '';
      try { await navigator.clipboard.writeText(text); } catch { /* ignore */ }
    };

    const actions = key ? (
      <MessageActions
        isPinned={isPinned}
        isDeleted={isDeletedMsg}
        onTogglePin={(note) => togglePinned(key, message.id, note)}
        onToggleDelete={() => toggleDeleted(key, message.id)}
        onCopy={copyText}
      />
    ) : null;

    if (isUserMsg) {
      return (
        <div className="flex justify-end w-full">
          <div className="group relative max-w-2xl rounded-2xl px-4 py-2 bg-zinc-200 dark:bg-zinc-700 text-foreground">
            <MessageContent blocks={message.contentBlocks} />
            {actions}
          </div>
        </div>
      );
    }
    // Assistant / tool / system: left-aligned bubble with subtler tone so user
    // and assistant are visually paired without the assistant dominating.
    return (
      <div className="flex justify-start w-full">
        <div className="group relative max-w-2xl rounded-2xl px-4 py-2 bg-card border border-border/50 text-foreground">
          <MessageContent blocks={message.contentBlocks} phase="final_answer" />
          {actions}
        </div>
      </div>
    );
  }

  const isUser = message.role === 'user';
  const isSystem = message.role === 'system';
  const isTool = message.role === 'tool' || message.toolName || message.toolCall || message.result;

  const isSubagentSession = sessionKey?.includes(':subagent:') || false;

  const extractAgentFromKey = (key: string | undefined): string | null => {
    if (!key) return null;
    if (key.startsWith('agent:')) {
      const parts = key.split(':');
      if (parts.length >= 2) {
        return parts[1];
      }
    }
    return null;
  };

  const sessionAgentId = extractAgentFromKey(sessionKey);

  const getAgentName = () => {
    if (isUser) {
      if (isSubagentSession) {
        if (sessionAgentId) {
          const agent = agents.find(a => a.id === sessionAgentId);
          if (agent?.name || agent?.identity?.name) {
            return agent.name || agent.identity?.name || sessionAgentId;
          }
          return sessionAgentId;
        }
        return `Agent`;
      }
      return t('chat.operator');
    }
    if (isSystem) return t('chat.system');
    if (isSubagentSession) {
      return 'Subagent';
    }
    if (sessionAgentId) {
      const agent = agents.find(a => a.id === sessionAgentId);
      if (agent?.name || agent?.identity?.name) {
        return agent.name || agent.identity?.name || sessionAgentId;
      }
      return sessionAgentId;
    }
    return 'Silos AI';
  };

  const fullTimestamp = message.timestamp
    ? new Date(message.timestamp).toLocaleString()
    : '';

  const extractedText = extractMessageText(message);
  const isStructured = !isUser && !isTool && extractedText && isStructuredMessage(extractedText);

  const trimmedText = extractedText?.trim();
  const hasValidContent = trimmedText && trimmedText.length > 0 && trimmedText !== '[object Object]';

  const isProviderError = isSystem && message.content?.startsWith('__provider_error__');
  const providerErrorDetail = isProviderError ? (message.content?.slice('__provider_error__'.length) ?? '') : '';
  const isRateLimitError = isProviderError && (providerErrorDetail.includes('429') || /rate limit/i.test(providerErrorDetail));

  const rateLimitResetTime = (() => {
    if (!isRateLimitError) return null;
    const match = providerErrorDetail.match(/Limit resets at:\s*(.+?)(?:\s*UTC)?\s*$/i);
    if (!match) return null;
    try {
      const d = new Date(match[1].trim() + ' UTC');
      if (isNaN(d.getTime())) return null;
      return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    } catch { return null; }
  })();

  if (!isTool && !hasValidContent && !isProviderError) {
    return null;
  }

  if (isTool && !message.toolName && !message.content && !message.result) {
    return null;
  }

  // Provider error cards
  if (isProviderError) {
    if (isRateLimitError) {
      return (
        <div className="flex gap-4 animate-in fade-in slide-in-from-bottom-2 duration-300 px-2">
          <div className="w-full max-w-2xl mx-auto">
            <div className="rounded-xl border border-amber-500/20 bg-amber-500/5 backdrop-blur-sm p-4 space-y-2">
              <div className="flex items-center gap-2 text-amber-600 dark:text-amber-400">
                <Clock className="w-5 h-5 flex-shrink-0" />
                <span className="font-semibold text-sm">{t('chat.rateLimitError')}</span>
              </div>
              <p className="text-xs text-amber-600/80 dark:text-amber-300/80 leading-relaxed pl-7">
                {rateLimitResetTime
                  ? t('chat.rateLimitResetsAt', { time: rateLimitResetTime })
                  : t('chat.rateLimitHint')}
              </p>
            </div>
          </div>
        </div>
      );
    }
    return (
      <div className="flex gap-4 animate-in fade-in slide-in-from-bottom-2 duration-300 px-2">
        <div className="w-full max-w-2xl mx-auto">
          <div className="rounded-xl border border-rose-500/30 bg-rose-500/5 backdrop-blur-sm p-4 space-y-2">
            <div className="flex items-center gap-2 text-rose-600 dark:text-rose-400">
              <AlertTriangle className="w-5 h-5 flex-shrink-0" />
              <span className="font-semibold text-sm">{t('chat.providerError')}</span>
            </div>
            <p className="text-xs text-rose-600/80 dark:text-rose-300/80 leading-relaxed pl-7">
              {t('chat.providerErrorHint')}
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={cn(
      "flex gap-4 group animate-in fade-in slide-in-from-bottom-2 duration-300 min-w-0",
      isUser && "flex-row-reverse zoom-in-95"
    )}>
      {showAvatar ? (
        <MessageAvatar
          isUser={isUser}
          agentId={sessionAgentId || undefined}
          agents={agents}
          showAvatar={showAvatar}
          isAgentSender={isSubagentSession && isUser}
        />
      ) : (
        <div className="w-11 flex-shrink-0" />
      )}

      <div className={cn("flex flex-col max-w-[70%] min-w-0", isUser ? "items-end" : "w-full")}>
        {showAvatar && (
          <div className={cn("flex items-center gap-2 mb-1.5 px-1", isUser && "flex-row-reverse")}>
            <span className={cn(
              "font-semibold text-xs tracking-wide",
              isUser && !isSubagentSession ? "text-zinc-700 dark:text-zinc-400" :
              isUser && isSubagentSession ? "text-cyan-600 dark:text-cyan-400" : "text-primary"
            )}>
              {getAgentName()}
            </span>
            <span className="text-muted-foreground/40">&bull;</span>
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="text-[10px] text-muted-foreground cursor-help hover:text-foreground transition-colors">
                  {formatTimestamp(message.timestamp)}
                </span>
              </TooltipTrigger>
              <TooltipContent side={isUser ? "left" : "right"}>
                {fullTimestamp}
              </TooltipContent>
            </Tooltip>
          </div>
        )}

        <div className="text-sm min-w-0 w-full">
          {isTool ? (
            <ToolCallExpander
              toolName={message.toolName}
              toolCall={message.toolCall}
              result={message.result}
              content={extractedText || message.content}
            />
          ) : isStructured ? (
            <CompactSystemMessage content={extractedText || ''} />
          ) : (() => {
            if (!extractedText || !extractedText.trim() || extractedText === '[object Object]') {
              return null;
            }

            const isSending = message.status === 'sending';
            const hasError = message.status === 'error';

            return (
              <div className="flex flex-col gap-1">
                <div className={cn(
                  "relative px-4 py-3.5 rounded-2xl leading-relaxed transition-all duration-200 overflow-hidden",
                  isUser && !isSubagentSession
                    ? [
                        "bg-gradient-to-br from-zinc-700 to-zinc-800 dark:from-zinc-600 dark:to-zinc-700",
                        "text-white rounded-br-md",
                        "shadow-elevation-1",
                        "hover:shadow-elevation-2 hover:translate-y-[-1px]",
                        hasError && "!from-rose-500 !to-rose-600 shadow-rose-500/15"
                      ]
                    : isUser && isSubagentSession
                    ? [
                        "bg-gradient-to-br from-cyan-600 via-cyan-600 to-cyan-700",
                        "text-white rounded-br-md",
                        "shadow-xl shadow-cyan-500/15",
                        "hover:shadow-cyan-500/20 hover:translate-y-[-1px]"
                      ]
                    : [
                        "bg-card",
                        "border",
                        "text-foreground rounded-bl-md",
                        "shadow-elevation-1",
                        "hover:translate-y-[-1px]"
                      ]
                )}>
                  {!isUser && (
                    <div className="absolute inset-0 rounded-2xl rounded-bl-md bg-gradient-to-br from-white/[0.02] to-transparent pointer-events-none" />
                  )}
                  <div className="relative min-w-0 w-full">
                    {renderMarkdown(extractedText)}
                  </div>
                </div>

                {isUser && (isSending || hasError) && (
                  <div className={cn(
                    "flex items-center justify-end gap-1.5 px-2 text-[10px] font-medium",
                    isSending && "text-muted-foreground",
                    hasError && "text-rose-600 dark:text-rose-400"
                  )}>
                    {isSending && (
                      <>
                        <Loader2 className="w-3 h-3 animate-spin" />
                        <span>Processing...</span>
                      </>
                    )}
                    {hasError && (
                      <>
                        <AlertTriangle className="w-3 h-3" />
                        <span>Failed to send</span>
                      </>
                    )}
                  </div>
                )}
              </div>
            );
          })()}
        </div>
      </div>
    </div>
  );
});
