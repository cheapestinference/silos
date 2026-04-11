import { useState } from 'react';
import { cn } from '../../lib/utils';
import { ChevronRight, ChevronDown, GitBranch } from 'lucide-react';
import { SessionItem } from './SessionItem';
import type { ParsedSession } from '../../lib/session-utils';
import type { GatewaySessionRow } from '../../types/openclaw';

export interface SubagentGroupProps {
  sessions: { session: GatewaySessionRow; parsed: ParsedSession }[];
  isSessionActive: (key: string) => boolean;
  onNavigate: (key: string) => void;
  onRename: (key: string, label: string) => void;
  onDelete: (key: string) => void;
  unreadCounts: Map<string, number>;
}

export function SubagentGroup({
  sessions,
  isSessionActive,
  onNavigate,
  onRename,
  onDelete,
  unreadCounts,
}: SubagentGroupProps) {
  const hasActive = sessions.some(s => isSessionActive(s.session.key));
  const [isOpen, setIsOpen] = useState(hasActive);

  return (
    <div className="mt-0.5">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className={cn(
          'w-full flex items-center gap-1.5 px-1 py-0.5 rounded text-[11px] transition-colors',
          hasActive ? 'text-cyan-500' : 'text-muted-foreground hover:text-foreground',
        )}
      >
        {isOpen
          ? <ChevronDown className="w-3 h-3 shrink-0" />
          : <ChevronRight className="w-3 h-3 shrink-0" />
        }
        <GitBranch className="w-3 h-3 text-cyan-500 shrink-0" />
        <span className="flex-1 text-left">Subagents</span>
        <span className="text-[10px] px-1.5 rounded-full bg-sidebar-hover text-muted-foreground tabular-nums">
          {sessions.length}
        </span>
      </button>
      {isOpen && (
        <div className="ml-3 mt-0.5 space-y-0.5 border-l border-cyan-500/20 pl-2">
          {sessions.map(({ session, parsed }) => (
            <SessionItem
              key={session.key}
              sessionKey={session.key}
              sessionType={parsed.sessionType}
              label={session.label}
              displayName={session.displayName}
              defaultLabel={parsed.displayLabel}
              active={isSessionActive(session.key)}
              onClick={() => onNavigate(session.key)}
              onRename={(newLabel) => onRename(session.key, newLabel)}
              onDelete={() => onDelete(session.key)}
              isSubagent
              isCompleted={session.abortedLastRun === false && !session.systemSent}
              unreadCount={unreadCounts.get(session.key) || 0}
            />
          ))}
        </div>
      )}
    </div>
  );
}
