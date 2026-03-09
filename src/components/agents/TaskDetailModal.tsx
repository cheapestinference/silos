import { useState, useEffect } from 'react';
import { X, Zap, Clock, Hash, MessageSquare, ArrowDownLeft, ArrowUpRight, AlertTriangle, Wrench, Loader2, ChevronDown, ChevronUp, User, Bot } from 'lucide-react';
import { getGatewayClient } from '../../lib/gateway-client';
import useTranslation from '../../i18n';
import type { Task, ChatMessage } from '../../types/openclaw';

interface TaskDetailModalProps {
  task: Task;
  onClose: () => void;
}

function formatDurationLong(startedAt: number, completedAt?: number) {
  const end = completedAt || Date.now();
  const ms = end - startedAt;
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  if (hours > 0) return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}

function formatTimestamp(ts: number) {
  return new Date(ts).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'medium',
  });
}

const statusConfig: Record<string, { label: string; color: string; bg: string }> = {
  running: { label: 'Running', color: 'text-blue-600 dark:text-blue-400', bg: 'bg-blue-500/15' },
  completed: { label: 'Completed', color: 'text-emerald-600 dark:text-emerald-400', bg: 'bg-emerald-500/15' },
  error: { label: 'Error', color: 'text-red-600 dark:text-red-400', bg: 'bg-red-500/15' },
  aborted: { label: 'Aborted', color: 'text-amber-600 dark:text-amber-400', bg: 'bg-amber-500/15' },
  pending: { label: 'Pending', color: 'text-muted-foreground', bg: 'bg-muted' },
};

function InfoRow({ icon, label, value, mono, error }: { icon: React.ReactNode; label: string; value: React.ReactNode; mono?: boolean; error?: boolean }) {
  return (
    <div className="flex items-start gap-3 py-2.5 border-b border-border last:border-0">
      <span className="text-muted-foreground mt-0.5 shrink-0">{icon}</span>
      <div className="flex-1 min-w-0">
        <p className="text-[11px] text-muted-foreground mb-0.5">{label}</p>
        <p className={`text-sm ${mono ? 'font-mono' : ''} ${error ? 'text-red-500' : 'text-foreground'} break-all`}>{value}</p>
      </div>
    </div>
  );
}

const roleConfig: Record<string, { icon: React.ReactNode; label: string; bg: string; text: string }> = {
  user: { icon: <User className="w-3 h-3" />, label: 'User', bg: 'bg-blue-500/10', text: 'text-blue-600 dark:text-blue-400' },
  assistant: { icon: <Bot className="w-3 h-3" />, label: 'Assistant', bg: 'bg-violet-500/10', text: 'text-violet-600 dark:text-violet-400' },
  system: { icon: <Zap className="w-3 h-3" />, label: 'System', bg: 'bg-amber-500/10', text: 'text-amber-600 dark:text-amber-400' },
  tool: { icon: <Wrench className="w-3 h-3" />, label: 'Tool', bg: 'bg-cyan-500/10', text: 'text-cyan-600 dark:text-cyan-400' },
};

export function TaskDetailModal({ task, onClose }: TaskDetailModalProps) {
  const { t } = useTranslation();
  const status = statusConfig[task.status] || statusConfig.pending;
  const totalTokens = (task.inputTokens || 0) + (task.outputTokens || 0);

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [messagesError, setMessagesError] = useState<string | null>(null);
  const [showMessages, setShowMessages] = useState(false);

  // Load messages for this run
  useEffect(() => {
    if (!showMessages || messages.length > 0) return;
    const load = async () => {
      setMessagesLoading(true);
      setMessagesError(null);
      try {
        const client = getGatewayClient();
        if (!client) throw new Error('Not connected');
        const result = await client.getChatHistory(task.sessionKey, { limit: 500 });
        const allMessages = result.messages || [];

        // Try matching by runId first
        let runMessages = allMessages.filter((m: ChatMessage) => m.runId === task.runId);

        // If this is a tool sub-task (id contains -tool-), also match tool messages
        // by toolName within the parent run
        if (task.toolName && runMessages.length === 0) {
          // The parent runId is the task's runId — find all messages from that run
          runMessages = allMessages.filter((m: ChatMessage) =>
            m.runId === task.runId ||
            (m.toolName === task.toolName && m.role === 'tool')
          );
        }

        // If still nothing, try a broader match — all messages near the task's time window
        if (runMessages.length === 0 && task.startedAt) {
          const startMs = task.startedAt;
          const endMs = task.completedAt || Date.now();
          const margin = 5000; // 5s margin
          runMessages = allMessages.filter((m: ChatMessage) =>
            m.timestamp >= startMs - margin && m.timestamp <= endMs + margin
          );
        }

        setMessages(runMessages);
      } catch (err) {
        setMessagesError(err instanceof Error ? err.message : 'Failed to load messages');
      } finally {
        setMessagesLoading(false);
      }
    };
    load();
  }, [showMessages, task.sessionKey, task.runId, task.toolName, task.startedAt, task.completedAt, messages.length]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-[2px]" onClick={onClose} />

      <div className="relative w-full max-w-lg bg-card border border-border rounded-2xl shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-200 flex flex-col max-h-[85vh]">
        {/* Header */}
        <div className="px-5 py-4 border-b border-border flex items-center justify-between shrink-0">
          <div className="flex items-center gap-3 min-w-0">
            <div className={`px-2 py-1 rounded-md text-[11px] font-semibold ${status.color} ${status.bg}`}>
              {status.label}
            </div>
            <p className="text-sm font-semibold text-foreground truncate">{task.runId || task.id}</p>
          </div>
          <button onClick={onClose} className="p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors shrink-0">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto">
          <div className="px-5 py-2">
            <InfoRow icon={<Hash className="w-3.5 h-3.5" />} label="Task ID" value={task.id} mono />
            <InfoRow icon={<Zap className="w-3.5 h-3.5" />} label="Run ID" value={task.runId} mono />
            <InfoRow icon={<MessageSquare className="w-3.5 h-3.5" />} label="Session" value={task.sessionKey} mono />

            {task.agentId && (
              <InfoRow icon={<Zap className="w-3.5 h-3.5" />} label="Agent" value={task.agentId} mono />
            )}

            {task.toolName && (
              <InfoRow icon={<Wrench className="w-3.5 h-3.5" />} label="Tool" value={task.toolName} mono />
            )}

            <InfoRow
              icon={<Clock className="w-3.5 h-3.5" />}
              label={t('agentDetail.startedAt') || 'Started'}
              value={
                <div>
                  <span>{formatTimestamp(task.startedAt)}</span>
                  {task.completedAt && (
                    <span className="text-muted-foreground text-xs ml-2">
                      ({formatDurationLong(task.startedAt, task.completedAt)})
                    </span>
                  )}
                  {!task.completedAt && task.status === 'running' && (
                    <span className="text-blue-500 text-xs ml-2">
                      ({formatDurationLong(task.startedAt)}...)
                    </span>
                  )}
                </div>
              }
            />

            {task.completedAt && (
              <InfoRow
                icon={<Clock className="w-3.5 h-3.5" />}
                label={t('agentDetail.completedAt') || 'Completed'}
                value={formatTimestamp(task.completedAt)}
              />
            )}

            {/* Tokens */}
            {totalTokens > 0 && (
              <div className="flex items-start gap-3 py-2.5 border-b border-border">
                <span className="text-muted-foreground mt-0.5 shrink-0"><Zap className="w-3.5 h-3.5" /></span>
                <div className="flex-1">
                  <p className="text-[11px] text-muted-foreground mb-1">Tokens</p>
                  <div className="flex gap-4">
                    <div className="flex items-center gap-1.5">
                      <ArrowDownLeft className="w-3 h-3 text-blue-500" />
                      <span className="text-sm tabular-nums text-foreground">{(task.inputTokens || 0).toLocaleString()}</span>
                      <span className="text-[10px] text-muted-foreground">in</span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <ArrowUpRight className="w-3 h-3 text-violet-500" />
                      <span className="text-sm tabular-nums text-foreground">{(task.outputTokens || 0).toLocaleString()}</span>
                      <span className="text-[10px] text-muted-foreground">out</span>
                    </div>
                    <div className="ml-auto text-sm font-medium tabular-nums text-foreground">
                      {totalTokens.toLocaleString()} total
                    </div>
                  </div>
                </div>
              </div>
            )}

            {task.toolCalls != null && (
              <InfoRow icon={<Wrench className="w-3.5 h-3.5" />} label="Tool Calls" value={task.toolCalls.toString()} />
            )}

            {task.error && (
              <InfoRow icon={<AlertTriangle className="w-3.5 h-3.5 text-red-500" />} label="Error" value={task.error} error />
            )}
          </div>

          {/* Messages Section */}
          <div className="border-t border-border">
            <button
              onClick={() => setShowMessages(!showMessages)}
              className="w-full px-5 py-3 flex items-center justify-between hover:bg-muted/50 transition-colors"
            >
              <div className="flex items-center gap-2">
                <MessageSquare className="w-3.5 h-3.5 text-muted-foreground" />
                <span className="text-sm font-medium text-foreground">
                  {t('agentDetail.conversation') || 'Conversation'}
                </span>
                {messages.length > 0 && (
                  <span className="text-[10px] text-muted-foreground tabular-nums">{messages.length} msgs</span>
                )}
              </div>
              {showMessages ? <ChevronUp className="w-4 h-4 text-muted-foreground" /> : <ChevronDown className="w-4 h-4 text-muted-foreground" />}
            </button>

            {showMessages && (
              <div className="px-4 pb-4">
                {messagesLoading && (
                  <div className="flex items-center justify-center py-6 gap-2">
                    <Loader2 className="w-4 h-4 text-muted-foreground animate-spin" />
                    <span className="text-xs text-muted-foreground">Loading messages...</span>
                  </div>
                )}

                {messagesError && (
                  <div className="p-3 bg-red-500/10 border border-red-500/20 rounded-lg text-xs text-red-500">
                    {messagesError}
                  </div>
                )}

                {!messagesLoading && !messagesError && messages.length === 0 && (
                  <p className="text-xs text-muted-foreground text-center py-4">
                    {t('agentDetail.noMessages') || 'No messages found for this run'}
                  </p>
                )}

                {messages.length > 0 && (
                  <div className="space-y-2">
                    {messages.map((msg, i) => {
                      const role = roleConfig[msg.role] || roleConfig.system;
                      const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content, null, 2);
                      const isLong = content.length > 300;

                      // For tool messages, extract input/output
                      const toolInput = msg.toolCall
                        ? (typeof msg.toolCall === 'string' ? msg.toolCall : JSON.stringify(msg.toolCall, null, 2))
                        : null;
                      const toolOutput = msg.result
                        ? (typeof msg.result === 'string' ? msg.result : JSON.stringify(msg.result, null, 2))
                        : null;

                      return (
                        <MessageBubble
                          key={msg.id || i}
                          role={role}
                          content={content}
                          isLong={isLong}
                          toolName={msg.toolName}
                          timestamp={msg.timestamp}
                          toolInput={toolInput}
                          toolOutput={toolOutput}
                        />
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-border bg-muted/30 flex justify-end shrink-0">
          <button onClick={onClose} className="px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors rounded-md">
            {t('common.close') || 'Close'}
          </button>
        </div>
      </div>
    </div>
  );
}

function CollapsibleBlock({ label, content, color }: { label: string; content: string; color: string }) {
  const [expanded, setExpanded] = useState(content.length <= 300);
  return (
    <div className="mt-1.5">
      <p className={`text-[10px] font-semibold ${color} uppercase tracking-wider mb-1`}>{label}</p>
      <pre className={`text-[11px] text-foreground whitespace-pre-wrap break-words font-mono leading-relaxed bg-muted/50 rounded p-2 ${!expanded ? 'max-h-20 overflow-hidden' : ''}`}>
        {content}
      </pre>
      {content.length > 300 && (
        <button
          onClick={() => setExpanded(!expanded)}
          className="text-[10px] text-muted-foreground hover:text-foreground mt-1 flex items-center gap-1"
        >
          {expanded ? <><ChevronUp className="w-3 h-3" /> Show less</> : <><ChevronDown className="w-3 h-3" /> Show all ({content.length} chars)</>}
        </button>
      )}
    </div>
  );
}

function MessageBubble({ role, content, isLong, toolName, timestamp, toolInput, toolOutput }: {
  role: { icon: React.ReactNode; label: string; bg: string; text: string };
  content: string;
  isLong: boolean;
  toolName?: string;
  timestamp: number;
  toolInput?: string | null;
  toolOutput?: string | null;
}) {
  const [expanded, setExpanded] = useState(!isLong);
  const hasToolData = toolInput || toolOutput;

  return (
    <div className="rounded-lg border border-border overflow-hidden">
      {/* Message header */}
      <div className={`px-3 py-1.5 flex items-center gap-2 ${role.bg}`}>
        <span className={role.text}>{role.icon}</span>
        <span className={`text-[11px] font-medium ${role.text}`}>{role.label}</span>
        {toolName && <span className="text-[10px] text-muted-foreground font-mono">({toolName})</span>}
        <span className="text-[10px] text-muted-foreground ml-auto tabular-nums">
          {new Date(timestamp).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
        </span>
      </div>
      {/* Message body */}
      <div className="px-3 py-2">
        {/* Tool input/output blocks */}
        {hasToolData ? (
          <div className="space-y-1">
            {toolInput && <CollapsibleBlock label="Input" content={toolInput} color="text-blue-500" />}
            {toolOutput && <CollapsibleBlock label="Output" content={toolOutput} color="text-emerald-500" />}
            {content && content.trim() && !toolOutput && (
              <CollapsibleBlock label="Result" content={content} color="text-violet-500" />
            )}
          </div>
        ) : (
          <>
            <pre className={`text-xs text-foreground whitespace-pre-wrap break-words font-mono leading-relaxed ${!expanded ? 'max-h-20 overflow-hidden' : ''}`}>
              {content}
            </pre>
            {isLong && (
              <button
                onClick={() => setExpanded(!expanded)}
                className="text-[10px] text-muted-foreground hover:text-foreground mt-1 flex items-center gap-1"
              >
                {expanded ? <><ChevronUp className="w-3 h-3" /> Show less</> : <><ChevronDown className="w-3 h-3" /> Show all ({content.length} chars)</>}
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
