import { User, Bot } from 'lucide-react';
import type { AgentSummary } from '../../types/openclaw';

interface MessageAvatarProps {
  isUser: boolean;
  agentId?: string;
  agents: AgentSummary[];
  showAvatar: boolean;
  isAgentSender?: boolean;
}

export function MessageAvatar({ isUser, agentId, agents, showAvatar, isAgentSender }: MessageAvatarProps) {
  if (!showAvatar) {
    return null;
  }

  if (isUser && !isAgentSender) {
    return (
      <div className="relative group w-9 h-9 flex-shrink-0">
        <div className="relative w-9 h-9 rounded-lg bg-gradient-to-br from-zinc-500 to-zinc-600 dark:from-zinc-500 dark:to-zinc-600 flex items-center justify-center text-white shadow-elevation-1 transition-all group-hover:scale-105 group-hover:shadow-elevation-2">
          <User className="w-4 h-4" />
        </div>
      </div>
    );
  }

  if (isUser && isAgentSender) {
    return (
      <div className="relative group w-9 h-9 flex-shrink-0">
        <div className="relative w-9 h-9 rounded-lg bg-gradient-to-br from-cyan-500 to-cyan-600 flex items-center justify-center text-white shadow-elevation-1 transition-all group-hover:scale-105 group-hover:shadow-elevation-2">
          <Bot className="w-4 h-4" />
        </div>
      </div>
    );
  }

  const agent = agentId ? agents.find(a => a.id === agentId) : null;
  const emoji = agent?.identity?.emoji;

  return (
    <div className="relative group w-9 h-9 flex-shrink-0">
      <div className="relative w-9 h-9 rounded-lg bg-gradient-to-br from-primary to-accent flex items-center justify-center text-white shadow-elevation-1 transition-all group-hover:scale-105 group-hover:shadow-elevation-2">
        {emoji ? (
          <span className="text-lg">{emoji}</span>
        ) : (
          <Bot className="w-4 h-4" />
        )}
      </div>
    </div>
  );
}
