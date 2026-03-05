import { useState } from 'react';
import { ChevronRight, ChevronDown } from 'lucide-react';
import { formatNumber, formatTimestamp } from '../../lib/utils';
import type { GatewaySessionRow } from '../../types/openclaw';

interface SessionIntelligenceHeaderProps {
  session: GatewaySessionRow | undefined;
  defaultExpanded?: boolean;
}

export function SessionIntelligenceHeader({
  session,
  defaultExpanded = false
}: SessionIntelligenceHeaderProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);

  if (!session) return null;

  // Parse display name from session key
  const displayName = session.displayName || session.label || session.key;
  const totalTokens = session.totalTokens || 0;

  return (
    <div className="bg-card border-b border-border/50">
      {/* Trigger (always visible) */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full px-6 py-3 flex items-center justify-between hover:bg-muted/30 transition-colors group"
      >
        <div className="flex items-center gap-3">
          {expanded ? (
            <ChevronDown className="w-4 h-4 text-muted-foreground transition-transform" />
          ) : (
            <ChevronRight className="w-4 h-4 text-muted-foreground transition-transform" />
          )}
          <span className="text-sm font-bold text-foreground/80 uppercase tracking-wide">
            Session Intelligence
          </span>
          <span className="text-xs text-muted-foreground">
            {displayName}
          </span>
          {session.kind && (
            <span className="text-[10px] px-2 py-0.5 rounded-full bg-muted text-muted-foreground uppercase tracking-wide font-semibold border border-border">
              {session.kind}
            </span>
          )}
          {session.surface && (
            <span className="text-[10px] px-2 py-0.5 rounded-full bg-indigo-500/10 text-indigo-600 dark:text-indigo-400 uppercase tracking-wide font-semibold border border-indigo-500/20">
              {session.surface}
            </span>
          )}
        </div>

        <div className="flex items-center gap-4">
          <span className="text-xs text-muted-foreground font-mono">
            {formatNumber(totalTokens)} tokens
          </span>
        </div>
      </button>

      {/* Expandable Content */}
      {expanded && (
        <div className="px-6 py-4 bg-muted/10 border-t border-border/30 animate-in slide-in-from-top-2 duration-200">
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
            {/* Model & Provider */}
            {session.model && (
              <div className="flex items-center gap-2">
                <span className="text-muted-foreground">🤖</span>
                <span className="font-medium text-foreground/90">{session.model}</span>
                {session.modelProvider && (
                  <span className="text-muted-foreground">({session.modelProvider})</span>
                )}
              </div>
            )}

            {/* Token Breakdown */}
            <div className="flex items-center gap-4 text-xs">
              {session.contextTokens !== undefined && (
                <div className="flex items-center gap-1.5">
                  <span className="text-muted-foreground">Context:</span>
                  <span className="font-mono font-semibold text-muted-foreground">{formatNumber(session.contextTokens)}</span>
                </div>
              )}
              {session.inputTokens !== undefined && (
                <div className="flex items-center gap-1.5">
                  <span className="text-muted-foreground">Input:</span>
                  <span className="font-mono font-semibold text-cyan-600 dark:text-cyan-400">{formatNumber(session.inputTokens)}↓</span>
                </div>
              )}
              {session.outputTokens !== undefined && (
                <div className="flex items-center gap-1.5">
                  <span className="text-muted-foreground">Output:</span>
                  <span className="font-mono font-semibold text-purple-600 dark:text-purple-400">{formatNumber(session.outputTokens)}↑</span>
                </div>
              )}
              {session.totalTokens !== undefined && (
                <div className="flex items-center gap-1.5">
                  <span className="text-muted-foreground">Total:</span>
                  <span className="font-mono font-semibold text-indigo-600 dark:text-indigo-400">{formatNumber(session.totalTokens)}</span>
                </div>
              )}
            </div>

            {/* Settings */}
            {session.thinkingLevel && session.thinkingLevel !== 'normal' && (
              <div className="flex items-center gap-1.5 text-xs">
                <span className="text-muted-foreground">🎚️ Thinking:</span>
                <span className="text-foreground/80">{session.thinkingLevel}</span>
              </div>
            )}

            {/* Updated timestamp */}
            {session.updatedAt && (
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground ml-auto">
                Updated {formatTimestamp(session.updatedAt)}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
