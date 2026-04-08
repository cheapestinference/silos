import { useState, useEffect } from 'react';
import { Hash, Zap, Clock, MessageSquare, AlertTriangle, Wrench, Loader2, ChevronDown, ChevronUp, User, Bot, Play, Layers } from 'lucide-react';
import { getGatewayClient } from '../../lib/gateway-client';
import useTranslation from '../../i18n';
import type { TaskRun } from '../../types/tasks';
import { taskRunStatusConfig, inferRuntime } from '../../types/tasks';
import type { ChatMessage } from '../../types/openclaw';

interface TaskRunDetailProps {
  task: TaskRun;
  onNavigateToFlow?: (flowId: string) => void;
  onNavigateToSession?: (sessionKey: string) => void;
}

function formatDurationLong(startMs: number, endMs?: number) {
  const ms = (endMs || Date.now()) - startMs;
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  if (hours > 0) return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}

function formatTimestamp(ts: number) {
  return new Date(ts).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'medium' });
}

function InfoRow({ icon, label, value, mono, error, onClick }: {
  icon: React.ReactNode; label: string; value: React.ReactNode;
  mono?: boolean; error?: boolean; onClick?: () => void;
}) {
  return (
    <div className="flex items-start gap-3 py-2.5 border-b border-border last:border-0">
      <span className="text-muted-foreground mt-0.5 shrink-0">{icon}</span>
      <div className="flex-1 min-w-0">
        <p className="text-[11px] text-muted-foreground mb-0.5">{label}</p>
        <p
          className={`text-sm ${mono ? 'font-mono' : ''} ${error ? 'text-red-500' : 'text-foreground'} ${onClick ? 'cursor-pointer hover:text-primary underline decoration-dotted' : ''} break-all`}
          onClick={onClick}
        >
          {value}
        </p>
      </div>
    </div>
  );
}

const roleConfig: Record<string, { icon: React.ReactNode; label: string; bg: string; text: string }> = {
  user:      { icon: <User className="w-3 h-3" />,   label: 'User',      bg: 'bg-muted', text: 'text-blue-600 dark:text-blue-400' },
  assistant: { icon: <Bot className="w-3 h-3" />,    label: 'Assistant', bg: 'bg-muted', text: 'text-primary' },
  system:    { icon: <Zap className="w-3 h-3" />,    label: 'System',    bg: 'bg-muted', text: 'text-amber-600 dark:text-amber-400' },
  tool:      { icon: <Wrench className="w-3 h-3" />, label: 'Tool',      bg: 'bg-muted', text: 'text-cyan-600 dark:text-cyan-400' },
};

export function TaskRunDetail({ task, onNavigateToFlow, onNavigateToSession }: TaskRunDetailProps) {
  const { t } = useTranslation();
  const status = taskRunStatusConfig[task.status] || taskRunStatusConfig.queued;

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [messagesError, setMessagesError] = useState<string | null>(null);
  const [showMessages, setShowMessages] = useState(false);

  const sessionKey = task.childSessionKey || '';

  useEffect(() => {
    if (!showMessages || messages.length > 0 || !sessionKey) return;

    const load = async () => {
      setMessagesLoading(true);
      setMessagesError(null);
      try {
        const client = getGatewayClient();
        if (!client) throw new Error('Not connected');
        const result = await client.getChatHistory(sessionKey, { limit: 500 });
        const allMessages = (result.messages || []) as ChatMessage[];

        let runMessages = task.runId
          ? allMessages.filter((m: ChatMessage) => m.runId === task.runId)
          : [];

        if (runMessages.length === 0 && task.startedAt) {
          const startMs = task.startedAt;
          const endMs = task.endedAt || Date.now();
          const margin = 5000;
          runMessages = allMessages.filter((m: ChatMessage) =>
            m.timestamp >= startMs - margin && m.timestamp <= endMs + margin
          );
        }

        if (runMessages.length === 0) runMessages = allMessages;

        setMessages(runMessages);
      } catch (err) {
        setMessagesError(err instanceof Error ? err.message : 'Failed to load messages');
      } finally {
        setMessagesLoading(false);
      }
    };
    load();
  }, [showMessages, sessionKey, task.runId, task.startedAt, task.endedAt, messages.length]);

  return (
    <div>
      {/* Status badge */}
      <div className="px-5 pt-4 pb-2">
        <span className={`inline-flex px-2.5 py-1 rounded-md text-xs font-semibold ${status.color} ${status.bg}`}>
          {status.label}
        </span>
        {task.label && <p className="text-sm font-medium text-foreground mt-2">{task.label}</p>}
      </div>

      {/* Metadata */}
      <div className="px-5">
        <InfoRow icon={<Hash className="w-3.5 h-3.5" />} label="Task ID" value={task.taskId} mono />
        {task.runId && <InfoRow icon={<Zap className="w-3.5 h-3.5" />} label="Run ID" value={task.runId} mono />}
        <InfoRow icon={<Play className="w-3.5 h-3.5" />} label="Runtime" value={inferRuntime(task)} />
        {task.agentId && <InfoRow icon={<Bot className="w-3.5 h-3.5" />} label="Agent" value={task.agentId} mono />}
        {sessionKey && (
          <InfoRow
            icon={<MessageSquare className="w-3.5 h-3.5" />}
            label="Session"
            value={sessionKey}
            mono
            onClick={onNavigateToSession ? () => onNavigateToSession(sessionKey) : undefined}
          />
        )}
        {task.parentFlowId && (
          <InfoRow
            icon={<Layers className="w-3.5 h-3.5" />}
            label="Flow"
            value={task.parentFlowId}
            mono
            onClick={onNavigateToFlow ? () => onNavigateToFlow(task.parentFlowId!) : undefined}
          />
        )}

        {task.createdAt && (
          <InfoRow
            icon={<Clock className="w-3.5 h-3.5" />}
            label="Created"
            value={
              <div>
                <span>{formatTimestamp(task.createdAt)}</span>
                {task.endedAt && (
                  <span className="text-muted-foreground text-xs ml-2">
                    ({formatDurationLong(task.startedAt || task.createdAt, task.endedAt)})
                  </span>
                )}
                {!task.endedAt && task.status === 'running' && task.startedAt && (
                  <span className="text-blue-500 text-xs ml-2">
                    ({formatDurationLong(task.startedAt)}...)
                  </span>
                )}
              </div>
            }
          />
        )}
      </div>

      {/* Progress */}
      {task.progressSummary && task.status === 'running' && (
        <div className="px-5 py-3 mx-5 mt-2 bg-blue-500/10 border border-blue-500/20 rounded-lg">
          <p className="text-xs font-medium text-blue-600 dark:text-blue-400 mb-1">Progress</p>
          <p className="text-sm text-foreground">{task.progressSummary}</p>
        </div>
      )}

      {/* Terminal Summary */}
      {task.terminalSummary && task.status !== 'running' && (
        <div className="px-5 py-3 mx-5 mt-2 bg-muted/60 border border-border rounded-lg">
          <p className="text-xs font-medium text-muted-foreground mb-1">Summary</p>
          <p className="text-sm text-foreground">{task.terminalSummary}</p>
        </div>
      )}

      {/* Error */}
      {task.error && (
        <div className="px-5 py-3 mx-5 mt-2 bg-red-500/10 border border-red-500/20 rounded-lg">
          <div className="flex items-center gap-1.5 mb-1">
            <AlertTriangle className="w-3.5 h-3.5 text-red-500" />
            <p className="text-xs font-medium text-red-500">Error</p>
          </div>
          <pre className="text-sm text-red-400 whitespace-pre-wrap break-words font-mono max-h-40 overflow-y-auto">{task.error}</pre>
        </div>
      )}

      {/* Conversation */}
      {sessionKey && (
        <div className="border-t border-border mt-4">
          <button
            onClick={() => setShowMessages(!showMessages)}
            className="w-full px-5 py-3 flex items-center justify-between hover:bg-muted/40 transition-colors"
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
                <p className="text-xs text-muted-foreground text-center py-4">No messages found</p>
              )}
              {messages.length > 0 && (
                <div className="space-y-2 max-h-96 overflow-y-auto">
                  {messages.map((msg, i) => {
                    const role = roleConfig[msg.role] || roleConfig.system;
                    const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content, null, 2);
                    return (
                      <div key={msg.id || i} className="rounded-lg border border-border overflow-hidden">
                        <div className={`px-3 py-1.5 flex items-center gap-2 ${role.bg}`}>
                          <span className={role.text}>{role.icon}</span>
                          <span className={`text-[11px] font-medium ${role.text}`}>{role.label}</span>
                          {msg.toolName && <span className="text-[10px] text-muted-foreground font-mono">({msg.toolName})</span>}
                          <span className="text-[10px] text-muted-foreground ml-auto tabular-nums">
                            {new Date(msg.timestamp).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                          </span>
                        </div>
                        <div className="px-3 py-2">
                          <pre className="text-xs text-foreground whitespace-pre-wrap break-words font-mono leading-relaxed max-h-32 overflow-y-auto">
                            {content.slice(0, 500)}{content.length > 500 ? '...' : ''}
                          </pre>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
