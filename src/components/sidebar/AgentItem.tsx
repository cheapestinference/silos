import { cn } from '../../lib/utils';
import { useTranslation } from '../../i18n';
import { Plus, BotMessageSquare } from 'lucide-react';
import { getAgentColor } from '../../lib/session-utils';

export interface AgentItemProps {
  agentId: string;
  name: string;
  emoji?: string;
  onClick: () => void;
  onCreateSession: () => void;
  sessionLimitReached?: boolean;
}

export function AgentItem({ agentId, name, emoji, onClick, onCreateSession, sessionLimitReached }: AgentItemProps) {
  const { t } = useTranslation();
  const agentColor = getAgentColor(agentId);

  return (
    <div className="flex items-center gap-0.5 group">
      {/* Agent button */}
      <button
        onClick={onClick}
        className={cn(
          "flex-1 px-2 py-1 rounded flex items-center gap-2 transition-colors",
          "text-sidebar-fg hover:bg-sidebar-hover"
        )}
      >
        <div className={cn(
          "w-5 h-5 rounded flex items-center justify-center shrink-0",
          agentColor,
          "text-white"
        )}>
          {emoji ? (
            <span className="text-xs">{emoji}</span>
          ) : (
            <BotMessageSquare className="w-3 h-3" />
          )}
        </div>
        <span className="flex-1 text-xs text-left truncate font-semibold">{name}</span>
        <div className="w-1.5 h-1.5 rounded-full shrink-0 bg-green-500" />
      </button>

      {/* Create session button */}
      {sessionLimitReached ? (
        <span
          className="p-1.5 opacity-0 group-hover:opacity-100 text-muted-foreground/40 cursor-not-allowed"
          title={t('sidebar.sessionLimitReached')}
        >
          <Plus className="w-4 h-4" />
        </span>
      ) : (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onCreateSession();
          }}
          className="p-1.5 opacity-0 group-hover:opacity-100 hover:bg-sidebar-hover rounded-lg transition-all text-muted-foreground hover:text-foreground"
          title={t('sidebar.createSession')}
        >
          <Plus className="w-4 h-4" />
        </button>
      )}
    </div>
  );
}
