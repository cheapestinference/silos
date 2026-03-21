import { useState } from 'react';
import { ChevronRight, ChevronDown } from 'lucide-react';
import { formatNumber, formatTimestamp } from '../../lib/utils';
import { useTranslation } from '../../i18n';
import type { GatewaySessionRow } from '../../types/openclaw';

interface SessionIntelligenceHeaderProps {
  session: GatewaySessionRow | undefined;
  defaultExpanded?: boolean;
}

export function SessionIntelligenceHeader({
  session,
  defaultExpanded = false
}: SessionIntelligenceHeaderProps) {
  const { t } = useTranslation();
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
            {t('chat.sessionIntelligence')}
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
            <span className="text-[10px] px-2 py-0.5 rounded-full bg-primary/10 text-primary uppercase tracking-wide font-semibold border border-primary/20">
              {session.surface}
            </span>
          )}
        </div>

        <div className="flex items-center gap-4">
          {totalTokens > 0 && (
            <span className="text-xs text-muted-foreground font-mono">
              {formatNumber(totalTokens)}{session.contextTokens ? ` / ${formatNumber(session.contextTokens)}` : ''} ctx
            </span>
          )}
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

            {/* Token Info */}
            <div className="flex items-center gap-4 text-xs">
              {session.totalTokens !== undefined && session.totalTokens > 0 && (
                <div className="flex items-center gap-1.5">
                  <span className="text-muted-foreground">{t('chat.context')}:</span>
                  <span className="font-mono font-semibold text-primary">
                    {formatNumber(session.totalTokens)}
                    {session.contextTokens ? ` / ${formatNumber(session.contextTokens)}` : ''}
                  </span>
                </div>
              )}
              {(session.inputTokens || session.outputTokens) && (
                <div className="flex items-center gap-1.5">
                  <span className="text-muted-foreground">{t('chat.total')}:</span>
                  <span className="font-mono font-semibold text-muted-foreground">
                    {formatNumber((session.inputTokens || 0) + (session.outputTokens || 0))}
                  </span>
                </div>
              )}
            </div>

            {/* Settings */}
            {session.thinkingLevel && session.thinkingLevel !== 'normal' && (
              <div className="flex items-center gap-1.5 text-xs">
                <span className="text-muted-foreground">🎚️ {t('chat.thinking')}:</span>
                <span className="text-foreground/80">{session.thinkingLevel}</span>
              </div>
            )}

            {/* Updated timestamp */}
            {session.updatedAt && (
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground ml-auto">
                {t('common.updated')} {formatTimestamp(session.updatedAt)}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
