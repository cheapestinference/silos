import { MessageAvatar } from './MessageAvatar';
import { MessageBubble } from './MessageBubble';
import type { AgentSummary, ChatMessage } from '../../types/openclaw';
import { formatTimestamp } from '../../lib/utils';

export const MAX_GROUP_GAP_MS = 5 * 60 * 1000;

interface MessageGroupProps {
  messages: ChatMessage[];
  agents: AgentSummary[];
  sessionKey?: string;
}

function extractAgentFromKey(key: string | undefined): string | null {
  if (!key) return null;
  if (key.startsWith('agent:')) {
    const parts = key.split(':');
    if (parts.length >= 2) {
      return parts[1];
    }
  }
  return null;
}

export function MessageGroup({ messages, agents, sessionKey }: MessageGroupProps) {
  if (messages.length === 0) return null;
  const first = messages[0];
  const last = messages[messages.length - 1];
  const isUser = first.role === 'user';
  const isSubagentSession = sessionKey?.includes(':subagent:') || false;
  const sessionAgentId = extractAgentFromKey(sessionKey);

  return (
    <div className="flex flex-col gap-1 mb-4">
      <div className={`flex items-end gap-2 ${isUser ? 'flex-row-reverse' : ''}`}>
        <MessageAvatar
          isUser={isUser}
          agentId={sessionAgentId || undefined}
          agents={agents}
          showAvatar={true}
          isAgentSender={isSubagentSession && isUser}
        />
        <div className="flex-1 min-w-0 flex flex-col gap-1 items-stretch">
          {messages.map((m) => (
            <MessageBubble
              key={m.id}
              message={m}
              showAvatar={false}
              agents={agents}
              sessionKey={sessionKey}
            />
          ))}
          <div className={`text-[10px] text-muted-foreground ${isUser ? 'text-right' : 'text-left'} pt-0.5`}>
            {formatTimestamp(last.timestamp)}
          </div>
        </div>
      </div>
    </div>
  );
}

export function groupMessages(messages: ChatMessage[]): ChatMessage[][] {
  const groups: ChatMessage[][] = [];
  let current: ChatMessage[] = [];
  for (const m of messages) {
    if (m.meta?.kind === 'inter_session') {
      if (current.length > 0) {
        groups.push(current);
        current = [];
      }
      groups.push([m]);
      continue;
    }
    if (current.length === 0) {
      current.push(m);
      continue;
    }
    const prev = current[current.length - 1];
    const sameRole = prev.role === m.role;
    const withinGap = Math.abs((m.timestamp || 0) - (prev.timestamp || 0)) <= MAX_GROUP_GAP_MS;
    if (sameRole && withinGap) {
      current.push(m);
    } else {
      groups.push(current);
      current = [m];
    }
  }
  if (current.length > 0) groups.push(current);
  return groups;
}
