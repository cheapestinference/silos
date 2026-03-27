import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { ChevronRight, ChevronDown, Check, Cpu } from 'lucide-react';
import { formatNumber, formatTimestamp, cn } from '../../lib/utils';
import { useTranslation } from '../../i18n';
import { useDashboardStore } from '../../store/dashboard-store';
import type { GatewaySessionRow } from '../../types/openclaw';

interface SessionIntelligenceHeaderProps {
  session: GatewaySessionRow | undefined;
  sessionKey: string;
  defaultExpanded?: boolean;
}

export function SessionIntelligenceHeader({
  session,
  sessionKey,
  defaultExpanded = false
}: SessionIntelligenceHeaderProps) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [modelOpen, setModelOpen] = useState(false);
  const [selectorProvider, setSelectorProvider] = useState('');
  const modelRef = useRef<HTMLDivElement>(null);

  const {
    models: dynamicModels,
    gatewayConfig,
    patchSession,
  } = useDashboardStore();

  if (!session) return null;

  const displayName = session.displayName || session.label || session.key;
  const totalTokens = session.totalTokens || 0;
  const currentModel = session.model || '';
  const currentProvider = session.modelProvider || '';

  // Build provider -> models map
  const providers = useMemo(() => {
    const map = new Map<string, string[]>();
    if (dynamicModels?.models) {
      for (const m of dynamicModels.models) {
        if (m.provider && m.id) {
          const list = map.get(m.provider) || [];
          if (!list.includes(m.id)) {
            list.push(m.id);
            map.set(m.provider, list);
          }
        }
      }
    }
    if (map.size === 0) {
      const cfg = gatewayConfig?.config as Record<string, unknown> | undefined;
      const cfgModels = cfg?.models as { providers?: Record<string, any> } | undefined;
      for (const [pId, pData] of Object.entries(cfgModels?.providers || {})) {
        const models = pData?.models?.map((m: any) => m.id || m) || [];
        if (models.length) map.set(pId, models);
      }
    }
    return map;
  }, [gatewayConfig, dynamicModels]);

  const activeProvider = selectorProvider || currentProvider || (providers.keys().next().value ?? '');
  const providerModels = providers.get(activeProvider) || [];

  // Close on outside click
  useEffect(() => {
    if (!modelOpen) return;
    const handler = (e: MouseEvent) => {
      if (modelRef.current && !modelRef.current.contains(e.target as Node)) {
        setModelOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [modelOpen]);

  const handleModelChange = useCallback((provider: string, modelId: string) => {
    if (!sessionKey) return;
    patchSession(sessionKey, { model: modelId, modelProvider: provider });
    setModelOpen(false);
    setSelectorProvider('');
  }, [sessionKey, patchSession]);

  const shortName = (id: string) => {
    const parts = id.split('/');
    return parts[parts.length - 1];
  };

  return (
    <div className="bg-card border-b border-border/40">
      {/* Trigger (always visible) */}
      <div className="w-full px-6 py-3 flex items-center justify-between">
        <button
          onClick={() => setExpanded(!expanded)}
          className="flex items-center gap-3 hover:bg-muted/20 transition-colors rounded-lg px-2 py-1 -ml-2"
        >
          {expanded ? (
            <ChevronDown className="w-4 h-4 text-muted-foreground" />
          ) : (
            <ChevronRight className="w-4 h-4 text-muted-foreground" />
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
            <span className="text-[10px] px-2 py-0.5 rounded-full bg-muted dark:bg-muted text-primary uppercase tracking-wide font-semibold border border-border">
              {session.surface}
            </span>
          )}
        </button>

        <div className="flex items-center gap-4">
          {/* Model selector pill */}
          <div className="relative" ref={modelRef}>
            <button
              onClick={() => setModelOpen(!modelOpen)}
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors font-medium border border-transparent hover:border-border"
            >
              <Cpu className="w-3.5 h-3.5" />
              <span className="max-w-[200px] truncate">{shortName(currentModel) || 'Select model'}</span>
              {currentProvider && <span className="text-[10px] text-muted-foreground/60">({currentProvider})</span>}
              <ChevronDown className={cn("w-3 h-3 transition-transform", modelOpen && "rotate-180")} />
            </button>

            {modelOpen && (
              <div className="absolute top-full right-0 mt-1 w-80 max-h-[400px] rounded-xl border bg-popover shadow-xl z-50 overflow-hidden flex flex-col">
                {/* Provider tabs */}
                <div className="flex gap-1 p-2 border-b overflow-x-auto flex-shrink-0">
                  {Array.from(providers.keys()).map(pId => (
                    <button
                      key={pId}
                      onClick={() => setSelectorProvider(pId)}
                      className={cn(
                        "px-2.5 py-1 rounded-md text-[11px] font-medium whitespace-nowrap transition-colors",
                        activeProvider === pId
                          ? "bg-primary text-primary-foreground"
                          : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                      )}
                    >
                      {pId}
                    </button>
                  ))}
                </div>

                {/* Model list */}
                <div className="overflow-y-auto flex-1 p-1">
                  {providerModels.length === 0 ? (
                    <div className="px-3 py-4 text-xs text-muted-foreground text-center">No models available</div>
                  ) : providerModels.map(mId => {
                    const isActive = currentModel === mId && currentProvider === activeProvider;
                    return (
                      <button
                        key={mId}
                        onClick={() => handleModelChange(activeProvider, mId)}
                        className={cn(
                          "w-full flex items-center gap-2 px-3 py-2 rounded-lg text-left text-xs transition-colors",
                          isActive
                            ? "bg-primary/10 text-primary font-medium"
                            : "text-foreground hover:bg-muted/60"
                        )}
                      >
                        <span className="truncate flex-1">{shortName(mId)}</span>
                        <span className="text-[10px] text-muted-foreground/50 flex-shrink-0">{mId.includes('/') ? mId.split('/')[0] : ''}</span>
                        {isActive && <Check className="w-3.5 h-3.5 text-primary flex-shrink-0" />}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>

          {totalTokens > 0 && (
            <span className="text-xs text-muted-foreground font-mono">
              {formatNumber(totalTokens)}{session.contextTokens ? ` / ${formatNumber(session.contextTokens)}` : ''} ctx
            </span>
          )}
        </div>
      </div>

      {/* Expandable Content */}
      {expanded && (
        <div className="px-6 py-4 bg-muted/10 border-t border-border/20 animate-in slide-in-from-top-2 duration-200">
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
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
