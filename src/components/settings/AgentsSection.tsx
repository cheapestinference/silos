import { useState, useEffect, useMemo, useRef } from 'react';
import { Cpu, ChevronRight, Search, Check } from 'lucide-react';
import { useDashboardStore } from '../../store/dashboard-store';
import { cn } from '../../lib/utils';
import useTranslation from '../../i18n';

export function AgentsSection() {
  const { t } = useTranslation();
  const { gatewayConfig, patchGatewayConfig, loadGatewayConfig, availableModels } = useDashboardStore();
  const [saving, setSaving] = useState(false);
  const [modelSearchOpen, setModelSearchOpen] = useState(false);
  const [modelSearch, setModelSearch] = useState('');
  const modelDropdownRef = useRef<HTMLDivElement>(null);
  const modelSearchInputRef = useRef<HTMLInputElement>(null);

  const config = gatewayConfig?.config as Record<string, unknown> | undefined;
  const agentsConfig = config?.agents as { defaults?: { model?: { primary?: string } } } | undefined;
  const currentModel = agentsConfig?.defaults?.model?.primary || '';

  // Get providers from config
  const configModels = config?.models as { providers?: Record<string, { baseUrl?: string; apiKey?: string; api?: string; models?: Array<{ id: string; name?: string; contextWindow?: number; reasoning?: boolean }> }> } | undefined;
  const providers = configModels?.providers ?? {};
  const providerNames = Object.keys(providers);

  // Parse current model's provider
  const parsedModel = useMemo(() => {
    const slashIdx = currentModel.indexOf('/');
    if (slashIdx > 0) {
      return { provider: currentModel.substring(0, slashIdx), modelId: currentModel.substring(slashIdx + 1) };
    }
    return { provider: providerNames[0] ?? '', modelId: currentModel };
  }, [currentModel, providerNames]);

  const [selectedProvider, setSelectedProvider] = useState(parsedModel.provider || providerNames[0] || '');

  // Sync provider if config changes
  useEffect(() => {
    if (parsedModel.provider && parsedModel.provider !== selectedProvider) {
      setSelectedProvider(parsedModel.provider);
    }
  }, [parsedModel.provider]);

  const currentModels = useMemo(() => {
    // Prefer dynamically fetched models from the provider's /v1/models endpoint
    if (availableModels?.[selectedProvider]?.length) {
      return availableModels[selectedProvider];
    }
    return providers[selectedProvider]?.models ?? [];
  }, [providers, selectedProvider, availableModels]);

  const filteredModels = useMemo(() => {
    if (!modelSearch) return currentModels;
    const q = modelSearch.toLowerCase();
    return currentModels.filter((m) =>
      (m.name || m.id).toLowerCase().includes(q) || m.id.toLowerCase().includes(q)
    );
  }, [currentModels, modelSearch]);

  // Close dropdown on click outside
  useEffect(() => {
    if (!modelSearchOpen) return;
    const handler = (e: MouseEvent) => {
      if (modelDropdownRef.current && !modelDropdownRef.current.contains(e.target as Node)) {
        setModelSearchOpen(false);
        setModelSearch('');
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [modelSearchOpen]);

  // Focus search input when dropdown opens
  useEffect(() => {
    if (modelSearchOpen) {
      modelSearchInputRef.current?.focus();
    }
  }, [modelSearchOpen]);

  const selectedModelName = useMemo(() => {
    const found = currentModels.find((m) => m.id === parsedModel.modelId);
    return found ? (found.name || found.id) : parsedModel.modelId || 'Select model';
  }, [currentModels, parsedModel.modelId]);

  const handleModelChange = async (provider: string, modelId: string) => {
    setSaving(true);
    const ok = await patchGatewayConfig({
      agents: {
        defaults: {
          model: {
            primary: `${provider}/${modelId}`,
          },
        },
      },
    });
    if (ok) {
      // Gateway restarts after config change - wait for reconnection then reload
      const waitForReconnect = () => new Promise<void>((resolve) => {
        let attempts = 0;
        const check = () => {
          attempts++;
          const { connected } = useDashboardStore.getState();
          if (connected || attempts > 10) {
            resolve();
          } else {
            setTimeout(check, 500);
          }
        };
        setTimeout(check, 1500);
      });
      await waitForReconnect();
      await loadGatewayConfig();
    }
    setSaving(false);
  };

  const handleProviderChange = (provider: string) => {
    setSelectedProvider(provider);
    // Auto-select first model of new provider
    const models = providers[provider]?.models ?? [];
    if (models.length > 0) {
      handleModelChange(provider, models[0].id);
    }
  };

  return (
    <div className="space-y-6">
      <p className="text-sm text-muted-foreground">{t('settings.agentsConfig.defaultSettings')}</p>

      {/* Default Model */}
      <div className="rounded-xl border bg-card p-5 space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="font-semibold text-foreground">{t('settings.agentsConfig.defaultModel')}</h3>
            <p className="text-xs text-muted-foreground mt-0.5">{t('settings.agentsConfig.defaultModelDesc')}</p>
          </div>
          {saving && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <div className="w-3 h-3 border-2 border-primary border-t-transparent rounded-full animate-spin" />
              Saving...
            </div>
          )}
        </div>

        {providerNames.length > 0 ? (
          <div className="grid grid-cols-2 gap-3">
            {/* Provider Selector - only show if more than one */}
            {providerNames.length > 1 ? (
              <div className="space-y-2">
                <label className="text-xs font-bold text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
                  <Cpu className="w-3.5 h-3.5" /> {t('agentDetail.provider')}
                </label>
                <select
                  value={selectedProvider}
                  onChange={(e) => handleProviderChange(e.target.value)}
                  className="flex h-10 w-full rounded-md border bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                >
                  {providerNames.map((name) => (
                    <option key={name} value={name}>
                      {name} ({providers[name].models?.length ?? 0})
                    </option>
                  ))}
                </select>
              </div>
            ) : (
              <div className="space-y-2">
                <label className="text-xs font-bold text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
                  <Cpu className="w-3.5 h-3.5" /> {t('agentDetail.provider')}
                </label>
                <div className="flex h-10 items-center rounded-md border bg-background px-3 text-sm text-foreground">
                  {providerNames[0]}
                </div>
              </div>
            )}

            {/* Model Selector with Search */}
            <div className="space-y-2">
              <label className="text-xs font-bold text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
                <Cpu className="w-3.5 h-3.5" /> {t('agents.config.model')}
                <span className="text-muted-foreground normal-case font-normal">({currentModels.length})</span>
              </label>
              <div className="relative" ref={modelDropdownRef}>
                <button
                  type="button"
                  onClick={() => { setModelSearchOpen(!modelSearchOpen); setModelSearch(''); }}
                  className="flex h-10 w-full items-center justify-between rounded-md border bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                >
                  <span className="truncate">{selectedModelName}</span>
                  <ChevronRight className={cn("h-4 w-4 text-muted-foreground transition-transform", modelSearchOpen && "rotate-90")} />
                </button>
                {modelSearchOpen && (
                  <div className="absolute z-50 mt-1 w-full rounded-md border bg-background shadow-lg">
                    <div className="flex items-center border-b px-3">
                      <Search className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                      <input
                        ref={modelSearchInputRef}
                        type="text"
                        value={modelSearch}
                        onChange={(e) => setModelSearch(e.target.value)}
                        placeholder={t('settings.agentsConfig.searchModels')}
                        className="flex-1 bg-transparent px-2 py-2 text-sm text-foreground placeholder:text-muted-foreground outline-none"
                      />
                      {modelSearch && (
                        <span className="text-xs text-muted-foreground">{filteredModels.length}</span>
                      )}
                    </div>
                    <div className="max-h-60 overflow-y-auto p-1">
                      {filteredModels.length === 0 ? (
                        <div className="px-3 py-4 text-center text-xs text-muted-foreground">{t('settings.agentsConfig.noModelsFound')}</div>
                      ) : (
                        filteredModels.map((model) => (
                          <button
                            key={model.id}
                            type="button"
                            onClick={() => {
                              handleModelChange(selectedProvider, model.id);
                              setModelSearchOpen(false);
                              setModelSearch('');
                            }}
                            className={cn(
                              "flex w-full items-center gap-2 rounded px-3 py-2 text-sm transition-colors hover:bg-muted",
                              parsedModel.modelId === model.id ? "bg-muted text-foreground" : "text-foreground"
                            )}
                          >
                            <span className="w-3.5 shrink-0">
                              {parsedModel.modelId === model.id && <Check className="h-3.5 w-3.5 text-primary" />}
                            </span>
                            <span className="truncate">{model.name || model.id}</span>
                            {model.contextWindow ? <span className="ml-auto text-[10px] text-muted-foreground shrink-0">{Math.round(model.contextWindow / 1000)}k</span> : null}
                          </button>
                        ))
                      )}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        ) : (
          <div className="p-4 text-center rounded-lg bg-muted/40 border border-dashed">
            <p className="text-xs text-muted-foreground">{t('settings.agentsConfig.noProviders')}</p>
          </div>
        )}

        {currentModel && (
          <div className="flex items-center gap-2 mt-3">
            <span className="text-xs text-muted-foreground">{t('settings.agentsConfig.currentDefault')}</span>
            <code className="text-xs text-primary font-mono bg-muted px-2 py-0.5 rounded">{currentModel}</code>
          </div>
        )}
      </div>
    </div>
  );
}
