import * as React from 'react';
import { useRef, useEffect, useState, useCallback, useMemo } from 'react';
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

  Terminal,
  Code2,
  Layers,
  Cpu,
  Bell,
  Calendar,
  X,
  AlertTriangle,
  Loader2,
  Wrench,
  Info,
} from 'lucide-react';
import { formatTimestamp, cn, formatNumber } from '../../lib/utils';
import { Button } from '../ui/button';
import { Tooltip, TooltipTrigger, TooltipContent } from '../ui/tooltip';
import type { ChatMessage, AgentSummary } from '../../types/openclaw';
import { SessionTasksKanban } from '../sessions/SessionTasksKanban';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
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

  // Last resort: try to JSON-stringify content if it exists (avoid [object Object])
  if (m.content) {
    try {
      return typeof m.content === 'object' ? JSON.stringify(m.content, null, 2) : String(m.content);
    } catch {
      return null;
    }
  }

  return null;
}

// ============== Message Markdown Renderer ==============

// Markdown component renderers for react-markdown
const markdownComponents: Record<string, React.ComponentType<any>> = {
  code({ className, children }: any) {
    const match = /language-(\w+)/.exec(className || '');
    const text = String(children).replace(/\n$/, '');
    if (match || text.includes('\n')) {
      return <CodeBlock language={match?.[1] || 'text'} code={text} />;
    }
    return (
      <code className="px-1.5 py-0.5 rounded bg-muted text-indigo-500 dark:text-indigo-400 text-xs font-mono">
        {children}
      </code>
    );
  },
  pre({ children }: any) { return <>{children}</>; },
  h1: ({ children }: any) => <h3 className="text-base font-bold mt-4 mb-2">{children}</h3>,
  h2: ({ children }: any) => <h4 className="text-sm font-bold mt-3 mb-1.5">{children}</h4>,
  h3: ({ children }: any) => <h5 className="text-sm font-semibold mt-2 mb-1">{children}</h5>,
  p: ({ children }: any) => <p className="mb-2 last:mb-0">{children}</p>,
  ul: ({ children }: any) => <ul className="list-disc pl-5 mb-2 space-y-0.5">{children}</ul>,
  ol: ({ children }: any) => <ol className="list-decimal pl-5 mb-2 space-y-0.5">{children}</ol>,
  li: ({ children }: any) => <li className="text-sm">{children}</li>,
  table: ({ children }: any) => (
    <div className="overflow-x-auto my-2 rounded-lg border">
      <table className="min-w-full text-xs">{children}</table>
    </div>
  ),
  thead: ({ children }: any) => <thead className="bg-muted/50 border-b">{children}</thead>,
  th: ({ children }: any) => <th className="px-3 py-1.5 text-left font-semibold text-muted-foreground">{children}</th>,
  td: ({ children }: any) => <td className="px-3 py-1.5 border-t border-border/50">{children}</td>,
  a: ({ href, children }: any) => (
    <a href={href} target="_blank" rel="noopener noreferrer"
      className="text-indigo-600 dark:text-indigo-400 hover:text-indigo-300 underline underline-offset-2">
      {children}
    </a>
  ),
  blockquote: ({ children }: any) => (
    <blockquote className="border-l-2 border-indigo-500/30 pl-3 my-2 text-muted-foreground italic">{children}</blockquote>
  ),
  hr: () => <hr className="my-3 border-border/50" />,
};

function renderMarkdown(text: string | undefined | null): React.ReactNode {
  if (!text) return null;
  const textStr = (typeof text === 'string' ? text : String(text)).trimStart();
  if (!textStr) return null;
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
      {textStr}
    </ReactMarkdown>
  );
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
      typescript: { color: 'text-blue-500 dark:text-blue-400', icon: <Code2 className="w-3.5 h-3.5" /> },
      javascript: { color: 'text-yellow-600 dark:text-yellow-400', icon: <Code2 className="w-3.5 h-3.5" /> },
      python: { color: 'text-green-600 dark:text-green-400', icon: <Code2 className="w-3.5 h-3.5" /> },
      bash: { color: 'text-emerald-600 dark:text-emerald-400', icon: <Terminal className="w-3.5 h-3.5" /> },
      shell: { color: 'text-emerald-600 dark:text-emerald-400', icon: <Terminal className="w-3.5 h-3.5" /> },
      json: { color: 'text-orange-600 dark:text-orange-400', icon: <Layers className="w-3.5 h-3.5" /> },
    };
    return styles[lang.toLowerCase()] || { color: 'text-muted-foreground', icon: <Code2 className="w-3.5 h-3.5" /> };
  };

  const langStyle = getLangStyle(language);

  return (
    <div className="my-3 rounded-xl overflow-hidden border bg-card shadow-sm group max-w-full">
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
              ? "bg-green-500/20 text-green-600 dark:text-green-400"
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
          <code className="text-foreground/90 font-mono whitespace-pre">{code}</code>
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
                    ? "bg-green-500/20 text-green-600 dark:text-green-400"
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
  const [inputExpanded, setInputExpanded] = useState(false);
  const [outputExpanded, setOutputExpanded] = useState(false);
  const [copiedField, setCopiedField] = useState<'input' | 'output' | null>(null);

  // Format input (tool call args)
  const inputStr = toolCall
    ? (typeof toolCall === 'string' ? toolCall : JSON.stringify(toolCall, null, 2))
    : null;

  // Format output (tool result)
  let outputStr: string | null = null;
  if (content && typeof content === 'string' && content.trim()) {
    outputStr = content;
  } else if (result) {
    outputStr = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
  }

  const hasOutput = !!outputStr;
  const isRunning = !hasOutput;

  const getToolIcon = (name?: string) => {
    if (!name) return <Cpu className="w-3 h-3" />;
    const lower = name.toLowerCase();
    if (lower.includes('code') || lower.includes('write')) return <Code2 className="w-3 h-3" />;
    if (lower.includes('terminal') || lower.includes('bash') || lower.includes('exec')) return <Terminal className="w-3 h-3" />;
    return <Cpu className="w-3 h-3" />;
  };

  const handleCopy = (text: string, field: 'input' | 'output') => {
    navigator.clipboard.writeText(text);
    setCopiedField(field);
    setTimeout(() => setCopiedField(null), 1500);
  };

  const handleHeaderClick = () => {
    const next = !expanded;
    setExpanded(next);
    if (next) {
      setInputExpanded(true);
      setOutputExpanded(true);
    } else {
      setInputExpanded(false);
      setOutputExpanded(false);
    }
  };

  const handleSectionClick = (field: 'input' | 'output', text: string) => {
    const isFieldExpanded = field === 'input' ? inputExpanded : outputExpanded;
    // If fully expanded → copy to clipboard
    if (expanded && isFieldExpanded) {
      handleCopy(text, field);
      return;
    }
    // Otherwise toggle that section
    if (field === 'input') setInputExpanded(!inputExpanded);
    else setOutputExpanded(!outputExpanded);
  };

  // Whether a section is visually open (either its own toggle or global expand)
  const isInputOpen = expanded || inputExpanded;
  const isOutputOpen = expanded || outputExpanded;

  // Color scheme: amber while running, cyan when done
  const colors = isRunning
    ? { border: 'border-amber-500/30', bg: 'bg-amber-500/5', hover: 'hover:bg-amber-500/10', icon: 'bg-amber-500/10 text-amber-500 dark:text-amber-400', ring: 'ring-amber-500/20', chevron: 'text-amber-500 dark:text-amber-400 hover:bg-amber-500/10' }
    : { border: 'border-cyan-500/20', bg: 'bg-cyan-500/5', hover: 'hover:bg-cyan-500/10', icon: 'bg-cyan-500/10 text-cyan-500 dark:text-cyan-400', ring: 'ring-cyan-500/20', chevron: 'text-cyan-500 dark:text-cyan-400 hover:bg-cyan-500/10' };

  return (
    <div className={cn(
      "rounded-lg overflow-hidden transition-all duration-200",
      "border bg-card",
      colors.border,
      expanded && `ring-1 ${colors.ring}`
    )}>
      {/* Header — click to expand/collapse all */}
      <div
        className={cn(
          "flex items-center justify-between px-2.5 py-1.5",
          colors.bg,
          "cursor-pointer transition-all",
          colors.hover
        )}
        onClick={handleHeaderClick}
      >
        <div className="flex items-center gap-2 min-w-0">
          <div className={cn("w-5 h-5 rounded flex items-center justify-center shrink-0", colors.icon)}>
            {getToolIcon(toolName)}
          </div>
          <p className="text-[11px] font-semibold font-mono text-foreground truncate">{toolName || 'unknown'}</p>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {isRunning && (
            <div className="w-2.5 h-2.5 border-[1.5px] border-amber-400 border-t-transparent rounded-full animate-spin" />
          )}
          {hasOutput && (
            <span className="text-[9px] font-semibold px-1 py-px rounded bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">ok</span>
          )}
          <button className={cn("p-0.5 rounded", colors.chevron)}>
            {expanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
          </button>
        </div>
      </div>

      {/* Input — click to expand section or copy when fully open */}
      {inputStr && (
        <div
          className={cn(
            "px-2.5 py-1.5 border-t border-cyan-500/10 bg-cyan-500/[0.02] cursor-pointer transition-colors",
            isInputOpen && expanded ? "hover:bg-cyan-500/[0.06]" : "hover:bg-cyan-500/[0.04]"
          )}
          onClick={() => handleSectionClick('input', inputStr)}
        >
          <div className="flex items-center justify-between mb-0.5">
            <span className="text-[9px] font-semibold text-cyan-600 dark:text-cyan-400 uppercase tracking-wider">Input</span>
            {copiedField === 'input' && (
              <span className="text-[9px] text-emerald-500 flex items-center gap-0.5"><Check className="w-2.5 h-2.5" /> Copied</span>
            )}
            {expanded && isInputOpen && copiedField !== 'input' && (
              <Copy className="w-2.5 h-2.5 text-muted-foreground/40" />
            )}
          </div>
          <pre className={cn(
            "text-[10px] leading-tight font-mono text-muted-foreground whitespace-pre-wrap break-all",
            !isInputOpen && "line-clamp-2"
          )}>{inputStr}</pre>
        </div>
      )}

      {/* Output — click to expand section or copy when fully open */}
      {hasOutput && (
        <div
          className={cn(
            "border-t border-cyan-500/10 cursor-pointer transition-colors",
            isOutputOpen && expanded ? "hover:bg-emerald-500/[0.04]" : "hover:bg-emerald-500/[0.02]"
          )}
          onClick={() => handleSectionClick('output', outputStr!)}
        >
          <div className="px-2.5 py-1 bg-emerald-500/5 flex items-center justify-between">
            <span className="text-[9px] font-semibold text-emerald-600 dark:text-emerald-400 uppercase tracking-wider">Output</span>
            {copiedField === 'output' && (
              <span className="text-[9px] text-emerald-500 flex items-center gap-0.5"><Check className="w-2.5 h-2.5" /> Copied</span>
            )}
            {expanded && isOutputOpen && copiedField !== 'output' && (
              <Copy className="w-2.5 h-2.5 text-muted-foreground/40" />
            )}
          </div>
          <div className={cn(
            "px-2.5 py-1.5 text-[10px] leading-tight font-mono text-foreground/80 whitespace-pre-wrap break-all",
            isOutputOpen ? "overflow-y-auto custom-scrollbar max-h-48" : "line-clamp-2"
          )}>
            {outputStr}
          </div>
        </div>
      )}
    </div>
  );
}

// ============== Tools Panel (Right Panel) ==============

interface ToolsPanelProps {
  messages: ChatMessage[];
}

function ToolsPanel({ messages }: ToolsPanelProps) {
  const { t } = useTranslation();

  const toolMessages = messages.filter(
    m => m.role === 'tool' || m.toolName || m.toolCall || m.result
  );

  // Reverse: most recent first
  const reversed = useMemo(() => [...toolMessages].reverse(), [toolMessages]);

  if (toolMessages.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-center px-6 py-12">
        <div className="w-12 h-12 rounded-xl bg-cyan-500/10 border border-cyan-500/20 flex items-center justify-center mb-4">
          <Wrench className="w-6 h-6 text-cyan-500/50" />
        </div>
        <p className="text-sm font-medium text-muted-foreground mb-1">{t('chat.noToolActivity')}</p>
        <p className="text-xs text-muted-foreground/60">{t('chat.toolCallsAppear')}</p>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto custom-scrollbar p-3 space-y-2">
      {reversed.map((msg) => (
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
    return null;
  }

  // Extra check: if it's a tool-like message but without actual tool content to show, skip it
  if (isTool && !message.toolName && !message.content && !message.result) {
    return null;
  }

  // Render provider error as a special card
  if (isProviderError) {
    if (isRateLimitError) {
      return (
        <div className="flex gap-4 animate-in fade-in slide-in-from-bottom-2 duration-300 px-2">
          <div className="w-full max-w-2xl mx-auto">
            <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 backdrop-blur-sm p-4 space-y-2">
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
      "flex gap-4 group animate-in fade-in slide-in-from-bottom-2 duration-300 min-w-0",
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

      <div className={cn("flex flex-col max-w-[70%] min-w-0", isUser ? "items-end" : "w-full")}>
        {showAvatar && (
          <div className={cn("flex items-center gap-2 mb-1.5 px-1", isUser && "flex-row-reverse")}>
            <span className={cn(
              "font-semibold text-xs tracking-wide",
              isUser && !isSubagentSession ? "text-indigo-600 dark:text-indigo-400" :
              isUser && isSubagentSession ? "text-cyan-600 dark:text-cyan-400" : "text-purple-600 dark:text-purple-400"
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
            // Final safety check: don't render empty or [object Object]
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
                        // Human user messages - indigo
                        "bg-gradient-to-br from-indigo-500 via-indigo-500 to-indigo-600",
                        "text-white rounded-br-md",
                        "shadow-xl shadow-indigo-500/15",
                        "hover:shadow-indigo-500/25 hover:translate-y-[-1px]",
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
                  <div className="relative min-w-0 w-full">
                    {renderMarkdown(extractedText)}
                  </div>
                </div>

                {/* Status indicator for sending messages */}
                {isUser && (isSending || hasError) && (
                  <div className={cn(
                    "flex items-center justify-end gap-1.5 px-2 text-[10px] font-medium",
                    isSending && "text-indigo-600 dark:text-indigo-400",
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

// ============== Typing Indicator (Premium) ==============

/** Memoized streaming content renderer — avoids re-parsing markdown when text hasn't changed */
const StreamingMarkdown = React.memo(function StreamingMarkdown({ text }: { text: string }) {
  return (
    <div className="streaming-cursor text-sm leading-relaxed break-words overflow-hidden" style={{ contain: 'content' }}>
      {renderMarkdown(text)}
    </div>
  );
});

function TypingIndicator({ streamingContent, isComplete }: { streamingContent?: string; isComplete?: boolean }) {
  const { t } = useTranslation();

  const text = streamingContent
    ? (typeof streamingContent === 'string' ? streamingContent : extractMessageText(streamingContent) || '')
    : '';

  return (
    <div className={cn(
      "flex gap-4 animate-in fade-in slide-in-from-bottom-3 duration-500",
      isComplete && "transition-opacity duration-150 opacity-0"
    )}>
      {/* Animated Avatar */}
      <div className="relative w-11 h-11 flex-shrink-0">
        {/* Pulsing outer rings */}
        {!isComplete && <div className="absolute -inset-2 rounded-xl bg-gradient-to-br from-purple-500 to-fuchsia-500 opacity-10 animate-ping" />}
        {!isComplete && <div className="absolute -inset-[2px] rounded-xl bg-gradient-to-br from-purple-500 via-violet-500 to-fuchsia-500 opacity-30 blur-[2px] animate-pulse" />}
        <div className="relative w-11 h-11 rounded-xl flex-shrink-0 bg-gradient-to-br from-purple-500 via-violet-500 to-fuchsia-600 flex items-center justify-center shadow-xl shadow-purple-500/30">
          <Zap className="w-5 h-5 text-white animate-pulse" />
        </div>
      </div>

      <div className={cn("flex flex-col max-w-[70%] min-w-0", text && "w-full")}>
        <div className="flex items-center gap-2 mb-1.5 px-1">
          <span className="font-semibold text-xs text-purple-500 dark:text-purple-400 tracking-wide flex items-center gap-1.5">
            {!isComplete && (
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-purple-400 opacity-75" />
                <span className="relative inline-flex rounded-full h-2 w-2 bg-purple-500" />
              </span>
            )}
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
            {text ? (
              <StreamingMarkdown text={text} />
            ) : (
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

// ============== Activity Bar (Queued Messages) ==============

function ActivityBar({ queuedCount, onRemoveLast }: {
  queuedCount: number;
  onRemoveLast: () => void;
}) {
  const { t } = useTranslation();

  return (
    <div className="flex items-center justify-between px-4 py-1.5 bg-amber-500/5 border border-amber-500/20 rounded-lg mx-4 mb-2 animate-in fade-in slide-in-from-bottom-2 duration-200">
      <div className="flex items-center gap-2 text-amber-600 dark:text-amber-400">
        <Clock className="w-3.5 h-3.5" />
        <span className="text-xs font-medium">
          {queuedCount} {queuedCount === 1 ? 'message' : 'messages'} {t('chat.messagesQueued')}
        </span>
      </div>
      <button
        onClick={onRemoveLast}
        className="flex items-center gap-1 text-xs font-medium px-2.5 py-1 rounded-md transition-all bg-rose-500/10 text-rose-600 dark:text-rose-400 hover:bg-rose-500/20"
      >
        <X className="w-3 h-3" />
        {t('chat.removeQueued')}
      </button>
    </div>
  );
}

// ============== Agent Status Dot ==============

function AgentStatusDot({ isWorking }: { isWorking: boolean }) {
  return (
    <span className="relative flex h-2 w-2">
      {isWorking && (
        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-indigo-400 opacity-75" />
      )}
      <span className={cn(
        "relative inline-flex rounded-full h-2 w-2 transition-colors duration-300",
        isWorking ? "bg-indigo-500" : "bg-emerald-500"
      )} />
    </span>
  );
}

// ============== Main ChatView Component (Premium) ==============

export function ChatView({ sessionKey }: { sessionKey: string }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const scrollSentinelRef = useRef<HTMLDivElement>(null);
  const scrollRafRef = useRef<number | null>(null);
  const userScrolledUp = useRef(false);
  const [showScrollButton, setShowScrollButton] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const { t } = useTranslation();

  const {
    chatMessages,
    sendMessage,
    chatLoading,
    chatSending: chatSendingMap,
    streamingContent,
    streamingComplete,
    streamingRunId,
    selectSession,
    agents,
    sessions,
    loadAgents,
    loadSessions,
    connected,
  } = useDashboardStore();

  const [inputFocused, setInputFocused] = useState(false);

  // Resizable right panel (width)
  const [panelWidth, setPanelWidth] = useState(() => {
    const saved = localStorage.getItem('silos-chat-panel-width');
    return saved ? Math.max(260, Math.min(800, Number(saved))) : 384;
  });
  const isDragging = useRef(false);
  const dragStartX = useRef(0);

  // Resizable split between Tools and Tasks (percentage of panel height for tools)
  const [toolsSplit, setToolsSplit] = useState(() => {
    const saved = localStorage.getItem('silos-chat-tools-split');
    return saved ? Math.max(15, Math.min(85, Number(saved))) : 50;
  });
  const isSplitDragging = useRef(false);
  const splitContainerRef = useRef<HTMLDivElement>(null);
  const dragStartWidth = useRef(0);

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (!isDragging.current) return;
      e.preventDefault();
      const delta = dragStartX.current - e.clientX;
      const newWidth = Math.max(260, Math.min(800, dragStartWidth.current + delta));
      setPanelWidth(newWidth);
    };
    const onMouseUp = () => {
      if (!isDragging.current) return;
      isDragging.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      localStorage.setItem('silos-chat-panel-width', String(panelWidth));
    };
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
  }, [panelWidth]);

  // Vertical split drag handlers
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
      localStorage.setItem('silos-chat-tools-split', String(toolsSplit));
    };
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
  }, [toolsSplit]);

  // Translate sessionKey to effective key for backend matching
  const effectiveKey = sessionKey.startsWith('dm-')
    ? `agent:${sessionKey.replace(/^dm-/, '')}:dm-operator`
    : sessionKey;

  // Find current session for token counts
  const currentSession = sessions?.sessions?.find(s => s.key === effectiveKey || s.key === sessionKey);

  // Get per-session sending state
  const chatSending = chatSendingMap.get(sessionKey) || false;

  // Agent working state (for status dot)
  const tasks = useDashboardStore((s) => s.tasks);
  const isAgentWorking = chatSending || tasks.some(
    t => t.status === 'running' && t.sessionKey === effectiveKey
  );

  // Memoize filtered messages — only recalculate when chatMessages changes, not on streaming updates
  const filteredMessages = useMemo(
    () => {
      const msgs = chatMessages.filter(msg =>
        !(msg.role === 'tool' || msg.toolName || msg.toolCall || msg.result) &&
        msg.status !== 'queued'
      );
      // Collapse consecutive same-role same-content duplicates (gateway may persist them)
      return msgs.filter((msg, i) =>
        i === 0 || msg.role !== msgs[i - 1].role || msg.content !== msgs[i - 1].content
      );
    },
    [chatMessages]
  );

  // Count queued messages
  const queuedCount = chatMessages.filter(m => m.role === 'user' && m.status === 'queued').length;

  // Check if rate limited (recent rate limit error in last 30s)
  const [rateLimitedUntil, setRateLimitedUntil] = useState<number>(0);
  const isRateLimited = Date.now() < rateLimitedUntil;

  useEffect(() => {
    const lastRateLimit = [...chatMessages].reverse().find(
      m => m.role === 'system' && m.content?.startsWith('__provider_error__') &&
           (m.content.includes('429') || /rate limit/i.test(m.content))
    );
    if (lastRateLimit && (Date.now() - lastRateLimit.timestamp) < 30000) {
      setRateLimitedUntil(lastRateLimit.timestamp + 30000);
    }
  }, [chatMessages]);

  // Clear rate limit state after cooldown
  useEffect(() => {
    if (!isRateLimited) return;
    const remaining = rateLimitedUntil - Date.now();
    if (remaining <= 0) return;
    const timer = setTimeout(() => setRateLimitedUntil(0), remaining);
    return () => clearTimeout(timer);
  }, [rateLimitedUntil, isRateLimited]);

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
      // Consider "at bottom" if within 80px of the end
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
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

    scrollRafRef.current = requestAnimationFrame(() => {
      scrollRafRef.current = null;
      if (scrollRef.current) {
        scrollRef.current.scrollTo({
          top: scrollRef.current.scrollHeight,
          behavior: streamingContent ? 'smooth' : 'instant',
        });
      }
    });
  }, [chatMessages, streamingContent, chatSending]);

  // Reset scroll lock when user sends a new message
  useEffect(() => {
    if (chatSending) {
      userScrolledUp.current = false;
      setShowScrollButton(false);
    }
  }, [chatSending]);

  // Cleanup RAF on unmount
  useEffect(() => {
    return () => {
      if (scrollRafRef.current !== null) cancelAnimationFrame(scrollRafRef.current);
    };
  }, []);

  // Auto-resize textarea
  const handleInputChange = useCallback(() => {
    if (inputRef.current) {
      inputRef.current.style.height = 'auto';
      inputRef.current.style.height = Math.min(inputRef.current.scrollHeight, 150) + 'px';
    }
  }, []);

  const handleSend = (e: React.FormEvent) => {
    e.preventDefault();
    if (isRateLimited) return;
    if (inputRef.current?.value.trim()) {
      sendMessage(inputRef.current.value);
      inputRef.current.value = '';
      inputRef.current.style.height = 'auto';
    }
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
          {/* Premium Empty State */}
          {chatMessages.length === 0 && !chatLoading && (
            <div className="flex flex-col items-center justify-center h-full text-center py-16">
              {/* Animated icon container */}
              <div className="relative mb-8">
                <div className="absolute inset-0 bg-gradient-to-br from-indigo-500/20 to-purple-500/20 rounded-3xl blur-2xl animate-pulse" />
                <div className="relative w-28 h-28 rounded-3xl bg-card border flex items-center justify-center shadow-sm">
                  <Sparkles className="w-14 h-14 text-indigo-600 dark:text-indigo-400/70 animate-float" />
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
                    <Sparkles className="w-3.5 h-3.5 text-indigo-600 dark:text-indigo-400" />
                    {suggestion}
                  </button>
                ))}
              </div>
            </div>
          )}

          {filteredMessages.map((msg, i, arr) => {
            // Hide assistant messages whose content is already visible in the TypingIndicator:
            // 1. During streaming→message transition (fade-out): last assistant msg is duplicate
            // 2. During post-tool streaming: tool handler saved a partial assistant msg for the
            //    active run, but TypingIndicator now shows the full accumulated text (replace semantics)
            if (streamingContent && msg.role === 'assistant') {
              if (streamingComplete && i === arr.length - 1) return null;
              if (!streamingComplete && streamingRunId && msg.runId === streamingRunId) return null;
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

          {/* Scroll-to-bottom button — sticky inside scroll container */}
          {showScrollButton && (
            <div className="sticky bottom-3 z-10 flex justify-center pointer-events-none -mt-12">
              <button
                onClick={scrollToBottom}
                className="pointer-events-auto flex items-center gap-2 px-4 py-2 rounded-full bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-medium shadow-lg shadow-indigo-500/25 transition-all duration-200 animate-in fade-in slide-in-from-bottom-2"
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
                  {/* Status indicator */}
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <AgentStatusDot isWorking={connected && isAgentWorking} />
                    <span className="font-medium">
                      {!connected ? 'Disconnected' : isAgentWorking ? 'Working...' : t('chat.systemReady')}
                    </span>
                  </div>

                  {/* Context utilization */}
                  {currentSession?.totalTokens !== undefined && currentSession.totalTokens > 0 && (() => {
                    const used = currentSession.totalTokens!;
                    const max = currentSession.contextTokens || sessions?.defaults?.contextTokens;
                    const pct = max ? Math.min((used / max) * 100, 100) : null;
                    const barColor = pct === null ? 'bg-muted-foreground/40'
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
                            <Info className="w-3 h-3 text-muted-foreground/50 hover:text-muted-foreground cursor-help transition-colors" />
                          </TooltipTrigger>
                          <TooltipContent side="right" className="w-56 text-xs leading-relaxed">
                            {t('chat.contextInfo')}
                          </TooltipContent>
                        </Tooltip>
                      </div>
                    );
                  })()}

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
            <kbd className="px-1.5 py-0.5 rounded bg-muted border font-mono text-[9px]">Enter</kbd> {t('chat.keyHintSend')} <kbd className="px-1.5 py-0.5 rounded bg-muted border font-mono text-[9px]">Shift+Enter</kbd> {t('chat.keyHintNewLine')}
          </p>
        </div>
        </div>
        {/* End Chat Column */}

        {/* Resize Handle */}
        <div
          className="w-1 shrink-0 cursor-col-resize group relative hover:bg-primary/20 active:bg-primary/30 transition-colors"
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
          <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-0.5 h-8 rounded-full bg-border group-hover:bg-primary/50 transition-colors" />
        </div>

        {/* RIGHT: Tasks + Tools Column */}
        <div ref={splitContainerRef} className="flex flex-col shrink-0" style={{ width: panelWidth }}>
          {/* Tasks section */}
          <div className="flex flex-col min-h-0 overflow-hidden" style={{ height: `${toolsSplit}%` }}>
            <SessionTasksKanban sessionKey={effectiveKey} />
          </div>

          {/* Horizontal resize handle */}
          <div
            className="h-1 shrink-0 cursor-row-resize group relative hover:bg-primary/20 active:bg-primary/30 transition-colors border-y border-border/30"
            onMouseDown={(e) => {
              e.preventDefault();
              isSplitDragging.current = true;
              document.body.style.cursor = 'row-resize';
              document.body.style.userSelect = 'none';
            }}
          >
            <div className="absolute inset-x-0 -top-1 -bottom-1" />
            <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 h-0.5 w-8 rounded-full bg-border group-hover:bg-primary/50 transition-colors" />
          </div>

          {/* Tools section */}
          <div className="flex-1 min-h-0 overflow-hidden">
            <div className="flex items-center gap-1.5 px-3 py-1.5 border-b border-border/50 shrink-0">
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
