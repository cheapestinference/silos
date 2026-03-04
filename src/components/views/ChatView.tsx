import * as React from 'react';
import { useRef, useEffect, useState, useCallback } from 'react';
import { useDashboardStore } from '../../store/dashboard-store';
import { useTranslation } from '../../i18n';
import {
  Clock,
  Zap,
  Bot,
  Send,
  ChevronDown,
  ChevronUp,
  Copy,
  Check,
  Sparkles,
  User,
  Paperclip,
  Terminal,
  Code2,
  Layers,
  Cpu,
  Bell,
  Calendar,
  X,
  AlertTriangle,
  Loader2,
  Kanban,
  Wrench,
} from 'lucide-react';
import { formatTimestamp, cn, truncateText } from '../../lib/utils';
import { Button } from '../ui/button';
import { Tooltip, TooltipTrigger, TooltipContent } from '../ui/tooltip';
import type { ChatMessage, AgentSummary } from '../../types/openclaw';
import { SessionTasksKanban } from '../sessions/SessionTasksKanban';
// WorkspaceExplorer removed for now
// AddMemberModal removed for now

// ============== Message Text Extraction ==============

/**
 * Extract text content from various message formats.
 * Handles: string content, array of content items, and text property fallback.
 */
function extractMessageText(message: unknown): string | null {
  if (!message || typeof message !== 'object') return null;
  const m = message as Record<string, unknown>;

  // Handle string content
  if (typeof m.content === 'string') {
    return m.content;
  }

  // Handle array of content items (OpenAI format, etc.)
  if (Array.isArray(m.content)) {
    const parts = m.content
      .map((item: unknown) => {
        if (!item) return null;

        // If item is a string, return it
        if (typeof item === 'string') return item;

        // If item is an object with type and text
        if (typeof item === 'object') {
          const i = item as Record<string, unknown>;
          if (i.type === 'text' && typeof i.text === 'string') {
            return i.text;
          }
          // Try to stringify if it's a non-text object
          if (i.text && typeof i.text === 'string') {
            return i.text;
          }
        }
        return null;
      })
      .filter((v): v is string => v !== null);

    if (parts.length > 0) {
      return parts.join('\n');
    }
  }

  // Handle text property fallback
  if (typeof m.text === 'string') {
    return m.text;
  }

  // Last resort: try to stringify content if it exists
  if (m.content) {
    try {
      return String(m.content);
    } catch {
      return null;
    }
  }

  return null;
}

// ============== Message Markdown Renderer ==============

function renderMarkdown(text: string | undefined | null): React.ReactNode {
  if (!text) return null;

  // Ensure text is a string
  if (typeof text !== 'string') {
    try {
      text = String(text);
    } catch {
      return null;
    }
  }

  const textStr = text;

  // Split by code blocks first
  const codeBlockRegex = /```(\w+)?\n([\s\S]*?)```/g;
  const parts: React.ReactNode[] = [];
  let lastIndex = 0;
  let match;
  let key = 0;

  while ((match = codeBlockRegex.exec(textStr)) !== null) {
    // Add text before code block
    if (match.index > lastIndex) {
      parts.push(
        <span key={key++}>
          {renderInlineMarkdown(textStr.slice(lastIndex, match.index))}
        </span>
      );
    }

    // Add code block
    const language = match[1] || 'text';
    const code = match[2];
    parts.push(
      <CodeBlock key={key++} language={language} code={code} />
    );

    lastIndex = match.index + match[0].length;
  }

  // Add remaining text
  if (lastIndex < textStr.length) {
    parts.push(
      <span key={key++}>
        {renderInlineMarkdown(textStr.slice(lastIndex))}
      </span>
    );
  }

  return parts.length > 0 ? parts : renderInlineMarkdown(textStr);
}

function renderInlineMarkdown(text: string | undefined | null): React.ReactNode {
  // Ensure text is a string (defensive against type mismatches)
  const textStr = String(text || '');

  // Handle inline code, bold, italic, and links
  const parts: React.ReactNode[] = [];
  let remaining = textStr;
  let key = 0;

  while (remaining.length > 0) {
    // Inline code
    const inlineCodeMatch = remaining.match(/^`([^`]+)`/);
    if (inlineCodeMatch) {
      parts.push(
        <code key={key++} className="px-1.5 py-0.5 rounded bg-muted text-indigo-500 dark:text-indigo-400 text-xs font-mono">
          {inlineCodeMatch[1]}
        </code>
      );
      remaining = remaining.slice(inlineCodeMatch[0].length);
      continue;
    }

    // Bold
    const boldMatch = remaining.match(/^\*\*([^*]+)\*\*/);
    if (boldMatch) {
      parts.push(<strong key={key++} className="font-semibold">{boldMatch[1]}</strong>);
      remaining = remaining.slice(boldMatch[0].length);
      continue;
    }

    // Italic
    const italicMatch = remaining.match(/^\*([^*]+)\*/);
    if (italicMatch) {
      parts.push(<em key={key++}>{italicMatch[1]}</em>);
      remaining = remaining.slice(italicMatch[0].length);
      continue;
    }

    // Link
    const linkMatch = remaining.match(/^\[([^\]]+)\]\(([^)]+)\)/);
    if (linkMatch) {
      parts.push(
        <a
          key={key++}
          href={linkMatch[2]}
          target="_blank"
          rel="noopener noreferrer"
          className="text-indigo-400 hover:text-indigo-300 underline underline-offset-2"
        >
          {linkMatch[1]}
        </a>
      );
      remaining = remaining.slice(linkMatch[0].length);
      continue;
    }

    // Regular character
    parts.push(remaining[0]);
    remaining = remaining.slice(1);
  }

  return parts;
}

// ============== Code Block Component (Premium) ==============

function CodeBlock({ language, code }: { language: string; code: string }) {
  const [copied, setCopied] = useState(false);
  const { t } = useTranslation();

  const handleCopy = async () => {
    await navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  // Get language icon and color
  const getLangStyle = (lang: string) => {
    const styles: Record<string, { color: string; icon: React.ReactNode }> = {
      typescript: { color: 'text-blue-400', icon: <Code2 className="w-3.5 h-3.5" /> },
      javascript: { color: 'text-yellow-400', icon: <Code2 className="w-3.5 h-3.5" /> },
      python: { color: 'text-green-400', icon: <Code2 className="w-3.5 h-3.5" /> },
      bash: { color: 'text-emerald-400', icon: <Terminal className="w-3.5 h-3.5" /> },
      shell: { color: 'text-emerald-400', icon: <Terminal className="w-3.5 h-3.5" /> },
      json: { color: 'text-orange-400', icon: <Layers className="w-3.5 h-3.5" /> },
    };
    return styles[lang.toLowerCase()] || { color: 'text-zinc-400', icon: <Code2 className="w-3.5 h-3.5" /> };
  };

  const langStyle = getLangStyle(language);

  return (
    <div className="my-3 rounded-xl overflow-hidden border bg-card shadow-sm group">
      {/* Premium Header */}
      <div className="flex items-center justify-between px-4 py-2.5 border-b bg-muted/60 backdrop-blur-sm">
        <div className="flex items-center gap-2">
          {/* macOS-style window buttons */}
          <div className="flex items-center gap-1.5 mr-3">
            <div className="w-2.5 h-2.5 rounded-full bg-red-500/80 group-hover:bg-red-500 transition-colors" />
            <div className="w-2.5 h-2.5 rounded-full bg-yellow-500/80 group-hover:bg-yellow-500 transition-colors" />
            <div className="w-2.5 h-2.5 rounded-full bg-green-500/80 group-hover:bg-green-500 transition-colors" />
          </div>
          <span className={cn("flex items-center gap-1.5 text-xs font-medium", langStyle.color)}>
            {langStyle.icon}
            {language}
          </span>
        </div>
        <button
          onClick={handleCopy}
          className={cn(
            "flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium transition-all",
            copied
              ? "bg-green-500/20 text-green-400"
              : "text-muted-foreground hover:text-foreground hover:bg-muted"
          )}
        >
          {copied ? (
            <>
              <Check className="w-3.5 h-3.5" />
              <span>{t('chat.copied')}</span>
            </>
          ) : (
            <>
              <Copy className="w-3.5 h-3.5" />
              <span>{t('chat.copyCode')}</span>
            </>
          )}
        </button>
      </div>

      {/* Code Content with line numbers */}
      <div className="relative">
        <pre className="p-4 overflow-x-auto text-[13px] leading-relaxed">
          <code className="text-foreground/90 font-mono">{code}</code>
        </pre>
        <div className="absolute bottom-0 left-0 right-0 h-6 bg-gradient-to-t from-card to-transparent pointer-events-none opacity-0 group-hover:opacity-100 transition-opacity" />
      </div>
    </div>
  );
}

// ============== System Message Detection ==============

/**
 * Detect if a message is a system/structured message (JSON, cron, etc.)
 */
function isStructuredMessage(content: string): boolean {
  if (!content || typeof content !== 'string') return false;
  const trimmed = content.trim();

  // Check if it's JSON
  if ((trimmed.startsWith('{') && trimmed.endsWith('}')) ||
      (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
    try {
      JSON.parse(trimmed);
      return true;
    } catch {
      return false;
    }
  }

  return false;
}

/**
 * Extract metadata from structured message
 */
function getStructuredMessageMeta(content: string): { type: string; icon: React.ReactNode; title: string } | null {
  try {
    const parsed = JSON.parse(content);

    // Cron job
    if (parsed.schedule || parsed.cronExpression || parsed.wakeMode) {
      return {
        type: 'cron',
        icon: <Calendar className="w-3.5 h-3.5" />,
        title: parsed.name || 'Scheduled Task'
      };
    }

    // System event
    if (parsed.payload?.kind === 'systemEvent') {
      return {
        type: 'event',
        icon: <Bell className="w-3.5 h-3.5" />,
        title: 'System Event'
      };
    }

    // Generic JSON
    return {
      type: 'json',
      icon: <Layers className="w-3.5 h-3.5" />,
      title: 'Data Object'
    };
  } catch {
    return null;
  }
}

// ============== Compact System Message ==============

interface CompactSystemMessageProps {
  content: string;
}

function CompactSystemMessage({ content }: CompactSystemMessageProps) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);

  // Ensure content is a string
  const contentStr = typeof content === 'string' ? content : JSON.stringify(content, null, 2);

  const meta = getStructuredMessageMeta(contentStr);
  if (!meta) return null;

  const handleCopy = async () => {
    await navigator.clipboard.writeText(contentStr);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  // Parse and format JSON nicely
  let formattedContent = contentStr;
  try {
    const parsed = JSON.parse(contentStr);
    formattedContent = JSON.stringify(parsed, null, 2);
  } catch {
    // Keep original if parsing fails
  }

  return (
    <div className="max-w-md">
      <div className={cn(
        "rounded-lg overflow-hidden transition-all duration-200",
        "border bg-card backdrop-blur-sm",
        meta.type === 'cron' ? "border-amber-500/20" :
        meta.type === 'event' ? "border-blue-500/20" : "border"
      )}>
        {/* Compact Header */}
        <button
          onClick={() => setExpanded(!expanded)}
          className={cn(
            "w-full flex items-center justify-between px-3 py-2 transition-colors",
            meta.type === 'cron' ? "bg-amber-500/5 hover:bg-amber-500/10" :
            meta.type === 'event' ? "bg-blue-500/5 hover:bg-blue-500/10" :
            "hover:bg-muted/50"
          )}
        >
          <div className="flex items-center gap-2">
            <div className={cn(
              "w-6 h-6 rounded flex items-center justify-center",
              meta.type === 'cron' ? "bg-amber-500/10 text-amber-500" :
              meta.type === 'event' ? "bg-blue-500/10 text-blue-500" :
              "bg-muted text-muted-foreground"
            )}>
              {meta.icon}
            </div>
            <div className="flex flex-col items-start">
              <span className={cn(
                "text-[10px] font-semibold uppercase tracking-wider",
                meta.type === 'cron' ? "text-amber-500" :
                meta.type === 'event' ? "text-blue-500" :
                "text-muted-foreground"
              )}>
                {meta.type}
              </span>
              <span className="text-xs text-foreground font-medium truncate max-w-[200px]">
                {meta.title}
              </span>
            </div>
          </div>
          <ChevronDown className={cn(
            "w-3.5 h-3.5 text-muted-foreground transition-transform",
            expanded && "rotate-180"
          )} />
        </button>

        {/* Expandable Content */}
        {expanded && (
          <div className="border-t">
            <div className="relative">
              <pre className="p-3 overflow-x-auto text-[11px] leading-relaxed max-h-64 overflow-y-auto custom-scrollbar">
                <code className="text-foreground/80 font-mono">{formattedContent}</code>
              </pre>
              <button
                onClick={(e) => { e.stopPropagation(); handleCopy(); }}
                className={cn(
                  "absolute top-2 right-2 p-1.5 rounded text-xs transition-all",
                  copied
                    ? "bg-green-500/20 text-green-400"
                    : "bg-muted text-muted-foreground hover:text-foreground"
                )}
              >
                {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ============== Tool Call Expander (Premium) ==============

interface ToolCallExpanderProps {
  toolName?: string;
  toolCall?: unknown;
  result?: unknown;
  content?: string;
}

function ToolCallExpander({ toolName, toolCall, result, content }: ToolCallExpanderProps) {
  const [expanded, setExpanded] = useState(false);
  const { t } = useTranslation();

  // Ensure content is always a string
  let displayContent: string;
  if (content) {
    if (typeof content === 'string') {
      displayContent = content;
    } else {
      // If content is an object or array, stringify it
      try {
        displayContent = JSON.stringify(content, null, 2);
      } catch {
        displayContent = String(content);
      }
    }
  } else if (result) {
    displayContent = JSON.stringify(result, null, 2);
  } else {
    displayContent = JSON.stringify(toolCall, null, 2);
  }

  const truncatedContent = truncateText(displayContent, 200);
  const needsExpansion = displayContent.length > 200;

  // Get tool icon based on name
  const getToolIcon = (name?: string) => {
    if (!name) return <Cpu className="w-4 h-4" />;
    const lower = name.toLowerCase();
    if (lower.includes('code') || lower.includes('write')) return <Code2 className="w-4 h-4" />;
    if (lower.includes('terminal') || lower.includes('bash')) return <Terminal className="w-4 h-4" />;
    return <Cpu className="w-4 h-4" />;
  };

  return (
    <div className={cn(
      "rounded-xl overflow-hidden transition-all duration-300",
      "border border-cyan-500/20 bg-card",
      "shadow-sm",
      expanded && "ring-1 ring-cyan-500/20"
    )}>
      {/* Header */}
      <div
        className={cn(
          "flex items-center justify-between px-4 py-3",
          "bg-cyan-500/5",
          "border-b border-cyan-500/10",
          needsExpansion && "cursor-pointer hover:bg-cyan-500/10 transition-all"
        )}
        onClick={() => needsExpansion && setExpanded(!expanded)}
      >
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-cyan-500/10 flex items-center justify-center text-cyan-500 dark:text-cyan-400 border border-cyan-500/20">
            {getToolIcon(toolName)}
          </div>
          <div>
            <span className="font-semibold text-xs text-cyan-600 dark:text-cyan-300 uppercase tracking-wider">
              {t('chat.toolOutput')}
            </span>
            <p className="text-sm font-mono text-foreground">{toolName || 'unknown'}</p>
          </div>
        </div>
        {needsExpansion && (
          <button className={cn(
            "p-2 rounded-lg transition-all",
            "text-cyan-500 dark:text-cyan-400 hover:bg-cyan-500/10"
          )}>
            {expanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
          </button>
        )}
      </div>

      {/* Content */}
      <div className={cn(
        "overflow-hidden transition-all duration-300",
        expanded ? "max-h-96" : needsExpansion ? "max-h-24" : "max-h-96"
      )}>
        <div className="p-4 text-xs font-mono text-foreground/80 overflow-x-auto overflow-y-auto custom-scrollbar whitespace-pre-wrap">
          {expanded || !needsExpansion ? displayContent : truncatedContent}
        </div>
      </div>

      {/* Footer - expand button */}
      {needsExpansion && !expanded && (
        <button
          onClick={() => setExpanded(true)}
          className={cn(
            "w-full py-2.5 text-xs font-medium text-center transition-all",
            "text-cyan-500 dark:text-cyan-400 hover:text-cyan-600 dark:hover:text-cyan-300",
            "border-t border-cyan-500/10 hover:border-cyan-500/20 hover:bg-cyan-500/5",
            "flex items-center justify-center gap-1.5"
          )}
        >
          {t('chat.showMore')}
          <ChevronDown className="w-3.5 h-3.5" />
        </button>
      )}
    </div>
  );
}

// ============== Tools Panel (Right Panel) ==============

interface ToolsPanelProps {
  messages: ChatMessage[];
}

function ToolsPanel({ messages }: ToolsPanelProps) {
  const scrollRef = useRef<HTMLDivElement>(null);

  const toolMessages = messages.filter(
    m => m.role === 'tool' || m.toolName || m.toolCall || m.result
  );

  // Auto-scroll to bottom when new tool messages arrive
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [toolMessages.length]);

  if (toolMessages.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-center px-6 py-12">
        <div className="w-12 h-12 rounded-xl bg-cyan-500/10 border border-cyan-500/20 flex items-center justify-center mb-4">
          <Wrench className="w-6 h-6 text-cyan-500/50" />
        </div>
        <p className="text-sm font-medium text-muted-foreground mb-1">No tool activity yet</p>
        <p className="text-xs text-muted-foreground/60">Tool calls will appear here when the agent uses tools</p>
      </div>
    );
  }

  return (
    <div ref={scrollRef} className="h-full overflow-y-auto custom-scrollbar p-3 space-y-2">
      {toolMessages.map((msg) => (
        <ToolCallExpander
          key={msg.id}
          toolName={msg.toolName}
          toolCall={msg.toolCall}
          result={msg.result}
          content={extractMessageText(msg) || msg.content}
        />
      ))}
    </div>
  );
}

// ============== Message Avatar (Premium) ==============

interface MessageAvatarProps {
  isUser: boolean;
  agentId?: string;
  agents: AgentSummary[];
  showAvatar: boolean;
  isStreaming?: boolean;
  isAgentSender?: boolean; // True when user role message was actually sent by an agent (in subagent sessions)
}

function MessageAvatar({ isUser, agentId, agents, showAvatar, isStreaming, isAgentSender }: MessageAvatarProps) {
  if (!showAvatar) {
    return null;
  }

  // Show user avatar only for actual human users, not agent-to-agent messages
  if (isUser && !isAgentSender) {
    return (
      <div className="relative group w-11 h-11 flex-shrink-0">
        {/* Outer glow ring */}
        <div className="absolute -inset-[1px] rounded-xl bg-gradient-to-br from-indigo-400 to-indigo-600 opacity-30 blur-[2px] group-hover:opacity-50 transition-opacity" />
        <div className="relative w-11 h-11 rounded-xl bg-gradient-to-br from-indigo-500 to-indigo-600 flex items-center justify-center text-white shadow-xl shadow-indigo-500/25 transition-all group-hover:scale-105 group-hover:shadow-indigo-500/40">
          <User className="w-5 h-5" />
        </div>
      </div>
    );
  }

  // Agent-to-agent sender (user role but from an agent)
  if (isUser && isAgentSender) {
    return (
      <div className="relative group w-11 h-11 flex-shrink-0">
        {/* Outer glow ring - cyan for agent sender */}
        <div className="absolute -inset-[1px] rounded-xl bg-gradient-to-br from-cyan-400 to-teal-600 opacity-30 blur-[2px] group-hover:opacity-50 transition-opacity" />
        <div className="relative w-11 h-11 rounded-xl bg-gradient-to-br from-cyan-500 to-teal-600 flex items-center justify-center text-white shadow-xl shadow-cyan-500/25 transition-all group-hover:scale-105 group-hover:shadow-cyan-500/40">
          <Bot className="w-5 h-5" />
        </div>
      </div>
    );
  }

  // Find agent for this message
  const agent = agentId ? agents.find(a => a.id === agentId) : null;
  const emoji = agent?.identity?.emoji;

  return (
    <div className="relative group w-11 h-11 flex-shrink-0">
      {/* Animated outer ring for AI */}
      <div className={cn(
        "absolute -inset-[1px] rounded-xl bg-gradient-to-br from-purple-400 via-violet-500 to-fuchsia-500 opacity-30 blur-[2px] transition-opacity",
        isStreaming ? "animate-pulse opacity-50" : "group-hover:opacity-50"
      )} />
      {/* Inner rotating gradient (subtle) */}
      {isStreaming && (
        <div className="absolute -inset-[2px] rounded-xl bg-gradient-conic from-purple-500 via-violet-500 to-purple-500 opacity-20 animate-spin-slow" />
      )}
      <div className="relative w-11 h-11 rounded-xl bg-gradient-to-br from-purple-500 via-violet-500 to-fuchsia-600 flex items-center justify-center text-white shadow-xl shadow-purple-500/25 transition-all group-hover:scale-105 group-hover:shadow-purple-500/40">
        {emoji ? (
          <span className="text-xl">{emoji}</span>
        ) : (
          <Bot className="w-5 h-5" />
        )}
      </div>
    </div>
  );
}

// ============== Message Bubble (Premium) ==============

interface MessageBubbleProps {
  message: ChatMessage;
  showAvatar: boolean;
  agents: AgentSummary[];
  sessionKey?: string;
}

const MessageBubble = React.memo(function MessageBubble({ message, showAvatar, agents, sessionKey }: MessageBubbleProps) {
  const { t } = useTranslation();
  const isUser = message.role === 'user';
  const isSystem = message.role === 'system';
  const isTool = message.role === 'tool' || message.toolName || message.toolCall || message.result;

  // Detect if this is a subagent session and extract parent agent info
  const isSubagentSession = sessionKey?.includes(':subagent:') || false;

  // Extract agent ID from sessionKey patterns:
  // - "agent:{agentId}:subagent:{uuid}" -> parent is whoever spawned this
  // - "agent:{agentId}:dm-operator" -> direct message with agent
  const extractAgentFromKey = (key: string | undefined): string | null => {
    if (!key) return null;
    if (key.startsWith('agent:')) {
      const parts = key.split(':');
      if (parts.length >= 2) {
        return parts[1]; // The agent ID
      }
    }
    return null;
  };

  const sessionAgentId = extractAgentFromKey(sessionKey);

  // Get agent name for display
  const getAgentName = () => {
    if (isUser) {
      // If this is a subagent session, the "user" messages were sent by another agent
      if (isSubagentSession) {
        // In subagent sessions, messages marked as "user" come from the parent agent/session
        return `🤖 Agent`;
      }
      return t('chat.operator');
    }
    if (isSystem) return t('chat.system');
    // For assistant messages, show the agent name if available
    if (sessionAgentId) {
      const agent = agents.find(a => a.id === sessionAgentId);
      if (agent?.name || agent?.identity?.name) {
        return agent.name || agent.identity?.name || sessionAgentId;
      }
      return sessionAgentId;
    }
    return 'Silos AI';
  };

  // Format timestamp for tooltip
  const fullTimestamp = message.timestamp
    ? new Date(message.timestamp).toLocaleString()
    : '';

  // Check if this is a structured message
  const extractedText = extractMessageText(message);
  const isStructured = !isUser && !isTool && extractedText && isStructuredMessage(extractedText);

  // Don't render empty messages (including whitespace-only) or [object Object]
  const trimmedText = extractedText?.trim();
  const hasValidContent = trimmedText && trimmedText.length > 0 && trimmedText !== '[object Object]';

  // Check for provider error messages
  const isProviderError = isSystem && message.content?.startsWith('__provider_error__');
  const providerErrorDetail = isProviderError ? (message.content?.slice('__provider_error__'.length) ?? '') : '';
  const isRateLimitError = isProviderError && (providerErrorDetail.includes('429') || /rate limit/i.test(providerErrorDetail));

  // Extract "Limit resets at: YYYY-MM-DD HH:MM:SS UTC" from the error detail
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
    console.log('[ChatView] Skipping empty message:', { role: message.role, content: message.content, extractedText });
    return null;
  }

  // Extra check: if it's a tool-like message but without actual tool content to show, skip it
  if (isTool && !message.toolName && !message.content && !message.result) {
    console.log('[ChatView] Skipping empty tool message:', { role: message.role, toolName: message.toolName });
    return null;
  }

  // Render provider error as a special card
  if (isProviderError) {
    if (isRateLimitError) {
      return (
        <div className="flex gap-4 animate-in fade-in slide-in-from-bottom-2 duration-300 px-2">
          <div className="w-full max-w-2xl mx-auto">
            <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 backdrop-blur-sm p-4 space-y-2">
              <div className="flex items-center gap-2 text-amber-400">
                <Clock className="w-5 h-5 flex-shrink-0" />
                <span className="font-semibold text-sm">{t('chat.rateLimitError')}</span>
              </div>
              <p className="text-xs text-amber-300/80 leading-relaxed pl-7">
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
            <div className="flex items-center gap-2 text-rose-400">
              <AlertTriangle className="w-5 h-5 flex-shrink-0" />
              <span className="font-semibold text-sm">{t('chat.providerError')}</span>
            </div>
            <p className="text-xs text-rose-300/80 leading-relaxed pl-7">
              {t('chat.providerErrorHint')}
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={cn(
      "flex gap-4 group animate-in fade-in slide-in-from-bottom-2 duration-300",
      isUser && "flex-row-reverse"
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

      <div className={cn("flex flex-col max-w-[70%]", isUser ? "items-end" : "items-start")}>
        {showAvatar && (
          <div className={cn("flex items-center gap-2 mb-1.5 px-1", isUser && "flex-row-reverse")}>
            <span className={cn(
              "font-semibold text-xs tracking-wide",
              isUser && !isSubagentSession ? "text-indigo-400" :
              isUser && isSubagentSession ? "text-cyan-400" : "text-purple-400"
            )}>
              {getAgentName()}
            </span>
            <span className="text-muted-foreground/40">•</span>
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

        <div className="text-sm">
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
            // Final safety check: don't render empty or [object Object]
            if (!extractedText || !extractedText.trim() || extractedText === '[object Object]') {
              return null;
            }

            const isQueued = message.status === 'queued';
            const isSending = message.status === 'sending';
            const hasError = message.status === 'error';

            return (
              <div className="flex flex-col gap-1">
                <div className={cn(
                  "relative px-4 py-3.5 rounded-2xl leading-relaxed whitespace-pre-wrap transition-all duration-200",
                  isUser && !isSubagentSession
                    ? [
                        // Human user messages - indigo
                        "bg-gradient-to-br from-indigo-500 via-indigo-500 to-indigo-600",
                        "text-white rounded-br-md",
                        "shadow-xl shadow-indigo-500/15",
                        "hover:shadow-indigo-500/25 hover:translate-y-[-1px]",
                        // Queued state - reduced opacity
                        isQueued && "opacity-70",
                        // Error state
                        hasError && "from-rose-500 via-rose-500 to-rose-600 shadow-rose-500/15"
                      ]
                    : isUser && isSubagentSession
                    ? [
                        // Agent-to-agent messages (user role but from agent) - cyan/teal
                        "bg-gradient-to-br from-cyan-600 via-teal-600 to-teal-700",
                        "text-white rounded-br-md",
                        "shadow-xl shadow-cyan-500/15",
                        "hover:shadow-cyan-500/25 hover:translate-y-[-1px]"
                      ]
                    : [
                        // Assistant messages
                        "bg-card",
                        "border",
                        "text-foreground rounded-bl-md",
                        "shadow-sm",
                        "hover:translate-y-[-1px]"
                      ]
                )}>
                  {/* Subtle inner highlight for AI messages */}
                  {!isUser && (
                    <div className="absolute inset-0 rounded-2xl rounded-bl-md bg-gradient-to-br from-white/[0.02] to-transparent pointer-events-none" />
                  )}
                  <div className="relative">
                    {renderMarkdown(extractedText)}
                  </div>
                </div>

                {/* Status indicator for queued/sending messages */}
                {isUser && (isQueued || isSending || hasError) && (
                  <div className={cn(
                    "flex items-center justify-end gap-1.5 px-2 text-[10px] font-medium",
                    isQueued && "text-amber-400",
                    isSending && "text-indigo-400",
                    hasError && "text-rose-400"
                  )}>
                    {isQueued && (
                      <>
                        <Clock className="w-3 h-3" />
                        <span>Queued</span>
                      </>
                    )}
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

// ============== Typing Indicator (Premium) ==============

function TypingIndicator({ streamingContent }: { streamingContent?: string }) {
  const { t } = useTranslation();

  return (
    <div className="flex gap-4 animate-in fade-in slide-in-from-bottom-3 duration-500">
      {/* Animated Avatar */}
      <div className="relative w-11 h-11 flex-shrink-0">
        {/* Pulsing outer rings */}
        <div className="absolute -inset-2 rounded-xl bg-gradient-to-br from-purple-500 to-fuchsia-500 opacity-10 animate-ping" />
        <div className="absolute -inset-[2px] rounded-xl bg-gradient-to-br from-purple-500 via-violet-500 to-fuchsia-500 opacity-30 blur-[2px] animate-pulse" />
        <div className="relative w-11 h-11 rounded-xl flex-shrink-0 bg-gradient-to-br from-purple-500 via-violet-500 to-fuchsia-600 flex items-center justify-center shadow-xl shadow-purple-500/30">
          <Zap className="w-5 h-5 text-white animate-pulse" />
        </div>
      </div>

      <div className="flex flex-col max-w-[70%] min-w-0">
        <div className="flex items-center gap-2 mb-1.5 px-1">
          <span className="font-semibold text-xs text-purple-500 dark:text-purple-400 tracking-wide flex items-center gap-1.5">
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-purple-400 opacity-75" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-purple-500" />
            </span>
            {t('chat.processing')}
          </span>
        </div>

        <div className={cn(
          "relative px-5 py-4 rounded-2xl rounded-bl-md overflow-hidden",
          "bg-card",
          "border border-purple-500/20",
          "shadow-sm",
          "transition-all duration-150 ease-out"
        )}>
          <div className="absolute inset-0 rounded-2xl rounded-bl-md bg-gradient-to-r from-purple-500/5 via-fuchsia-500/5 to-purple-500/5 animate-gradient-x" />

          <div className="relative text-foreground min-h-[1.5rem]">
            {streamingContent ? (() => {
              const text = typeof streamingContent === 'string' ? streamingContent : extractMessageText(streamingContent) || '';
              return (
                <div className="inline-flex items-start gap-1">
                  <span className="text-sm leading-relaxed break-words whitespace-pre-wrap">{renderMarkdown(text)}</span>
                  <span className="w-0.5 h-5 bg-gradient-to-t from-purple-400 to-fuchsia-400 animate-pulse rounded-full flex-shrink-0 mt-0.5" />
                </div>
              );
            })() : (
              <div className="flex items-center gap-2 py-1">
                {/* Premium wave animation */}
                <div className="flex items-center gap-1">
                  {[0, 1, 2, 3, 4].map((i) => (
                    <span
                      key={i}
                      className="w-1 bg-gradient-to-t from-purple-400 to-fuchsia-400 rounded-full animate-wave"
                      style={{
                        height: '12px',
                        animationDelay: `${i * 100}ms`,
                      }}
                    />
                  ))}
                </div>
                <span className="text-xs text-muted-foreground ml-2">{t('chat.thinkingDeeply')}</span>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ============== Main ChatView Component (Premium) ==============

export function ChatView({ sessionKey }: { sessionKey: string }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const { t } = useTranslation();

  const {
    chatMessages,
    sendMessage,
    chatLoading,
    chatSending: chatSendingMap,
    streamingContent,
    selectSession,
    agents,
    loadAgents,
    loadSessions,
    connected,
  } = useDashboardStore();

  const [inputFocused, setInputFocused] = useState(false);
  const [rightPanelTab, setRightPanelTab] = useState<'tools' | 'tasks'>('tools');

  // Translate sessionKey to effective key for backend matching
  const effectiveKey = sessionKey.startsWith('dm-')
    ? `agent:${sessionKey.replace(/^dm-/, '')}:dm-operator`
    : sessionKey;

  // Get per-session sending state
  const chatSending = chatSendingMap.get(sessionKey) || false;

  // Count queued messages
  const queuedCount = chatMessages.filter(m => m.role === 'user' && m.status === 'queued').length;
  const sendingCount = chatMessages.filter(m => m.role === 'user' && m.status === 'sending').length;

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
  }, [sessionKey, selectSession]);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [chatMessages, streamingContent, chatSending]);

  // Auto-resize textarea
  const handleInputChange = useCallback(() => {
    if (inputRef.current) {
      inputRef.current.style.height = 'auto';
      inputRef.current.style.height = Math.min(inputRef.current.scrollHeight, 150) + 'px';
    }
  }, []);

  const handleSend = (e: React.FormEvent) => {
    e.preventDefault();
    if (inputRef.current?.value.trim()) {
      sendMessage(inputRef.current.value);
      inputRef.current.value = '';
      inputRef.current.style.height = 'auto';
    }
  };

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
        <div className="flex-1 flex flex-col min-w-0 relative border-r">
          {/* Messages Area */}
        <div ref={scrollRef} className="flex-1 overflow-y-auto p-6 space-y-6 custom-scrollbar">
          {/* Premium Empty State */}
          {chatMessages.length === 0 && !chatLoading && (
            <div className="flex flex-col items-center justify-center h-full text-center py-16">
              {/* Animated icon container */}
              <div className="relative mb-8">
                <div className="absolute inset-0 bg-gradient-to-br from-indigo-500/20 to-purple-500/20 rounded-3xl blur-2xl animate-pulse" />
                <div className="relative w-28 h-28 rounded-3xl bg-card border flex items-center justify-center shadow-sm">
                  <Sparkles className="w-14 h-14 text-indigo-400/70 animate-float" />
                </div>
              </div>

              <h3 className="text-2xl font-bold text-foreground mb-3">{t('chat.sessionInitialized')}</h3>
              <p className="text-sm text-muted-foreground max-w-md mb-8 leading-relaxed">
                {t('chat.sessionInitializedDesc')}
              </p>

              {/* Quick start suggestions */}
              <div className="flex flex-wrap justify-center gap-2 max-w-lg">
                {['What can you help me with?', 'Tell me about your capabilities', 'Help me get started'].map((suggestion, i) => (
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
                    <Sparkles className="w-3.5 h-3.5 text-indigo-400" />
                    {suggestion}
                  </button>
                ))}
              </div>
            </div>
          )}

          {chatMessages.filter(msg => !(msg.role === 'tool' || msg.toolName || msg.toolCall || msg.result)).map((msg, i, filteredMsgs) => {
            const showAvatar = i === 0 ||
              filteredMsgs[i-1].role !== msg.role ||
              Boolean(filteredMsgs[i-1].timestamp && msg.timestamp - filteredMsgs[i-1].timestamp > 60000);

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
            <TypingIndicator streamingContent={streamingContent} />
          )}

          <div className="h-4" />
        </div>

        {/* Premium Input Area */}
        <div className="relative p-4 bg-gradient-to-t from-background via-background to-transparent">
          {/* Gradient fade above input */}
          <div className="absolute top-0 left-0 right-0 h-8 bg-gradient-to-t from-background to-transparent -translate-y-full pointer-events-none" />

          <div className={cn(
            "relative rounded-2xl transition-all duration-300",
            "bg-card",
            "border shadow-sm",
            inputFocused
              ? "border-indigo-500/40 shadow-indigo-500/10 ring-2 ring-indigo-500/10"
              : ""
          )}>
            {/* Inner highlight */}
            <div className="absolute inset-0 rounded-2xl bg-gradient-to-br from-white/[0.02] to-transparent pointer-events-none" />

            <form onSubmit={handleSend} className="relative flex flex-col">
              <textarea
                ref={inputRef}
                className="w-full bg-transparent px-5 py-4 focus:outline-none text-sm placeholder:text-muted-foreground/50 font-medium resize-none min-h-[56px] max-h-[150px]"
                placeholder={chatSending ? 'Agent is processing...' : t('chat.placeholder')}
                disabled={false}
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
                  {/* Status indicator */}
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <span className="relative flex h-2 w-2">
                      {connected && (
                        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" />
                      )}
                      <span className={cn(
                        "relative inline-flex rounded-full h-2 w-2",
                        connected ? "bg-green-500" : "bg-muted-foreground"
                      )} />
                    </span>
                    <span className="font-medium">
                      {connected ? t('chat.systemReady') : 'Disconnected'}
                    </span>
                  </div>

                  {/* Queue indicator */}
                  {(queuedCount > 0 || (chatSending && sendingCount > 0)) && (
                    <div className="flex items-center gap-2 px-2.5 py-1 rounded-lg bg-amber-500/10 border border-amber-500/20">
                      <div className="flex items-center gap-1.5 text-amber-400">
                        {sendingCount > 0 && (
                          <Loader2 className="w-3 h-3 animate-spin" />
                        )}
                        {queuedCount > 0 && (
                          <Clock className="w-3 h-3" />
                        )}
                        <span className="text-[10px] font-bold">
                          {sendingCount > 0 && `Processing${queuedCount > 0 ? ' • ' : ''}`}
                          {queuedCount > 0 && `${queuedCount} queued`}
                        </span>
                      </div>
                    </div>
                  )}

                  {/* Tool buttons */}
                  <div className="flex items-center gap-1 pl-2 border-l">
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          type="button"
                          className="p-2 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted transition-all"
                        >
                          <Paperclip className="w-4 h-4" />
                        </button>
                      </TooltipTrigger>
                      <TooltipContent>Attach file</TooltipContent>
                    </Tooltip>
                  </div>
                </div>

                {/* Send button (always available) + Abort button when processing */}
                <div className="flex items-center gap-2">
                  {chatSending && (
                    <Button
                      type="button"
                      onClick={() => {
                        const { abortChat } = useDashboardStore.getState();
                        abortChat();
                      }}
                      size="sm"
                      variant="ghost"
                      className="gap-1.5 px-3 text-red-400 hover:text-red-300 hover:bg-red-500/10"
                    >
                      <X className="w-3.5 h-3.5" />
                      Stop
                    </Button>
                  )}
                  <Button
                    type="submit"
                    disabled={false}
                    size="sm"
                    className={cn(
                      "gap-2 px-4 transition-all duration-200",
                      "bg-gradient-to-r from-indigo-600 to-indigo-500 hover:from-indigo-500 hover:to-indigo-400",
                      "shadow-lg shadow-indigo-500/25 hover:shadow-indigo-500/40",
                      "border border-indigo-400/20"
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
            Press <kbd className="px-1.5 py-0.5 rounded bg-muted border font-mono text-[9px]">Enter</kbd> to send, <kbd className="px-1.5 py-0.5 rounded bg-muted border font-mono text-[9px]">Shift+Enter</kbd> for new line
          </p>
        </div>
        </div>
        {/* End Chat Column */}

        {/* RIGHT: Tasks/Workspace Column */}
        <div className="w-96 flex flex-col">
          {/* Tab Switcher */}
          <div className="flex border-b border-border/50 shrink-0">
            <button
              onClick={() => setRightPanelTab('tools')}
              className={cn(
                'flex-1 flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-medium transition-colors',
                rightPanelTab === 'tools'
                  ? 'text-cyan-600 dark:text-cyan-400 border-b-2 border-cyan-500 dark:border-cyan-400'
                  : 'text-muted-foreground hover:text-foreground'
              )}
            >
              <Wrench className="h-3.5 w-3.5" />
              Tools
            </button>
            <button
              onClick={() => setRightPanelTab('tasks')}
              className={cn(
                'flex-1 flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-medium transition-colors',
                rightPanelTab === 'tasks'
                  ? 'text-primary border-b-2 border-primary'
                  : 'text-muted-foreground hover:text-foreground'
              )}
            >
              <Kanban className="h-3.5 w-3.5" />
              Tasks
            </button>
          </div>
          {/* Tab Content */}
          <div className="flex-1 min-h-0">
            {rightPanelTab === 'tools' ? (
              <ToolsPanel messages={chatMessages} />
            ) : (
              <SessionTasksKanban sessionKey={effectiveKey} />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
