import * as React from 'react';
import { MessageSquare, Settings, MoreVertical, Zap } from 'lucide-react';
import { cn } from '../../lib/utils';
import { useTranslation } from '../../i18n';
import { Button } from '../ui/button';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from '../ui/dropdown-menu';
import type { AgentSummary } from '../../types/openclaw';

interface AgentCardProps {
  agent: AgentSummary;
  sessionCount?: number;
  isOnline?: boolean;
  onChat: () => void;
  onConfigure: () => void;
  onViewDetails?: () => void;
}

export function AgentCard({
  agent,
  sessionCount = 0,
  isOnline = true,
  onChat,
  onConfigure,
  onViewDetails,
}: AgentCardProps) {
  const { t } = useTranslation();
  const displayName = agent.identity?.name || agent.name || agent.id;
  const emoji = agent.identity?.emoji;
  // Generate gradient colors based on theme or agent id
  const gradientClass = React.useMemo(() => {
    const gradients = [
      'from-indigo-500 to-purple-600',
      'from-blue-500 to-cyan-500',
      'from-emerald-500 to-teal-500',
      'from-orange-500 to-red-500',
      'from-pink-500 to-rose-500',
      'from-violet-500 to-purple-500',
    ];
    const hash = agent.id.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
    return gradients[hash % gradients.length];
  }, [agent.id]);

  return (
    <div className="group relative bg-card border border-border rounded-xl p-5 hover:border-indigo-500/50 hover:shadow-lg hover:shadow-indigo-500/5 transition-all duration-300">
      {/* Header */}
      <div className="flex items-start justify-between mb-4">
        {/* Avatar */}
        <div className="relative">
          <div className={cn(
            'w-14 h-14 rounded-xl flex items-center justify-center text-2xl font-bold text-white shadow-lg',
            `bg-gradient-to-br ${gradientClass}`
          )}>
            {emoji || displayName.charAt(0).toUpperCase()}
          </div>
          {/* Status indicator */}
          <div className={cn(
            'absolute -bottom-1 -right-1 w-4 h-4 rounded-full border-2 border-card',
            isOnline ? 'bg-green-500' : 'bg-muted-foreground'
          )} />
        </div>

        {/* Actions Dropdown */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="opacity-0 group-hover:opacity-100 transition-opacity"
            >
              <MoreVertical className="w-4 h-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={onChat}>
              <MessageSquare className="w-4 h-4 mr-2" />
              {t('agents.chat')}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={onConfigure}>
              <Settings className="w-4 h-4 mr-2" />
              {t('agents.configure')}
            </DropdownMenuItem>
            {onViewDetails && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={onViewDetails}>
                  <Zap className="w-4 h-4 mr-2" />
                  {t('agents.viewDetails')}
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* Info */}
      <div className="mb-4">
        <h3 className="text-lg font-semibold text-foreground truncate">{displayName}</h3>
        <p className="text-sm text-muted-foreground truncate">{agent.id}</p>
      </div>

      {/* Stats */}
      <div className="flex items-center gap-4 text-sm text-muted-foreground mb-4">
        <div className="flex items-center gap-1.5">
          <div className={cn(
            'w-2 h-2 rounded-full',
            isOnline ? 'bg-green-500' : 'bg-muted-foreground'
          )} />
          <span>{isOnline ? t('agents.online') : t('agents.offline')}</span>
        </div>
        <div className="flex items-center gap-1.5">
          <MessageSquare className="w-3.5 h-3.5" />
          <span>{sessionCount} {t('agents.sessions')}</span>
        </div>
      </div>

      {/* Actions */}
      <div className="flex gap-2">
        <Button
          onClick={onChat}
          className="flex-1 bg-indigo-600 hover:bg-indigo-700 text-white"
        >
          <MessageSquare className="w-4 h-4 mr-2" />
          {t('agents.chat')}
        </Button>
        <Button
          variant="outline"
          onClick={onConfigure}
          className="px-3"
        >
          <Settings className="w-4 h-4" />
        </Button>
      </div>
    </div>
  );
}
