import { useState, useMemo, useRef, useEffect } from 'react';
import { Sliders, HelpCircle, Cpu, Thermometer, Hash, Info, Search, ChevronDown, Check } from 'lucide-react';
import { Input } from '../ui/input';
import { useTranslation } from '../../i18n';
import { Tooltip, TooltipTrigger, TooltipContent } from '../ui/tooltip';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '../ui/select';
import type { AgentSettings, ModelProviderConfig } from '../../types/openclaw';
import { useDashboardStore } from '../../store/dashboard-store';

interface SettingsTabProps {
  settings: AgentSettings;
  onChange: (settings: AgentSettings) => void;
}

export function SettingsTab({ settings, onChange }: SettingsTabProps) {
  const { t } = useTranslation();
  const { gatewayConfig, availableModels } = useDashboardStore();

  // Extract gateway default model
  const defaultGatewayModel = useMemo(() => {
    const agentsSection = (gatewayConfig?.config as Record<string, unknown>)?.agents as
      { defaults?: { model?: { primary?: string } } } | undefined;
    return agentsSection?.defaults?.model?.primary || '';
  }, [gatewayConfig]);

  const providers = useMemo(() => {
    const configModels = (gatewayConfig?.config as Record<string, unknown>)?.models as { providers?: Record<string, ModelProviderConfig> } | undefined;
    return configModels?.providers ?? {};
  }, [gatewayConfig]);

  const providerNames = useMemo(() => Object.keys(providers), [providers]);

  // Parse provider/model from settings.model (format: "provider/modelId" or just "modelId")
  const parsedModel = useMemo(() => {
    const m = settings.model || '';
    const slashIdx = m.indexOf('/');
    if (slashIdx > 0) {
      return { provider: m.substring(0, slashIdx), modelId: m.substring(slashIdx + 1) };
    }
    return { provider: '', modelId: m };
  }, [settings.model]);

  // Check if parameter values are at their defaults
  const isDefaultTemp = (settings.temperature ?? 0.7) === 0.7;
  const isDefaultMaxTokens = (settings.maxTokens ?? 4096) === 4096;

  // Derive selected provider from current model
  const detectedProvider = useMemo(() => {
    if (!settings.model) return providerNames[0] ?? '';
    // First check if the model string has an explicit provider prefix
    if (parsedModel.provider && providers[parsedModel.provider]) {
      return parsedModel.provider;
    }
    // Fallback: search all providers for a matching model ID
    for (const [name, provider] of Object.entries(providers)) {
      if (provider.models?.some((m) => m.id === parsedModel.modelId)) {
        return name;
      }
    }
    // Also check availableModels (dynamically fetched)
    if (availableModels) {
      for (const [name] of Object.entries(availableModels)) {
        if (availableModels[name]?.some((m) => m.id === parsedModel.modelId)) {
          return name;
        }
      }
    }
    return providerNames[0] ?? '';
  }, [settings.model, parsedModel, providers, providerNames, availableModels]);

  const [selectedProvider, setSelectedProvider] = useState(detectedProvider);

  // Keep selectedProvider in sync if detectedProvider changes (e.g. config reload)
  if (detectedProvider && selectedProvider !== detectedProvider && settings.model) {
    // Only sync if the current model actually belongs to a provider
    const currentProviderHasModel =
      providers[selectedProvider]?.models?.some((m) => m.id === parsedModel.modelId) ||
      availableModels?.[selectedProvider]?.some((m) => m.id === parsedModel.modelId);
    if (!currentProviderHasModel) {
      setSelectedProvider(detectedProvider);
    }
  }

  const currentModels = useMemo(() => {
    // Prefer dynamically fetched models from the provider's /v1/models endpoint
    if (availableModels?.[selectedProvider]?.length) {
      return availableModels[selectedProvider];
    }
    // Fallback to models defined in the OpenClaw config
    return providers[selectedProvider]?.models ?? [];
  }, [providers, selectedProvider, availableModels]);

  const updateSetting = <K extends keyof AgentSettings>(key: K, value: AgentSettings[K]) => {
    onChange({ ...settings, [key]: value });
  };

  // Save model as "provider/modelId" format
  const setModel = (provider: string, modelId: string) => {
    updateSetting('model', `${provider}/${modelId}`);
  };

  const handleProviderChange = (provider: string) => {
    setSelectedProvider(provider);
    const models = providers[provider]?.models ?? [];
    if (models.length > 0) {
      setModel(provider, models[0].id);
    }
  };

  const hasProviders = providerNames.length > 0;

  // Searchable model dropdown state
  const [modelSearchOpen, setModelSearchOpen] = useState(false);
  const [modelSearch, setModelSearch] = useState('');
  const modelDropdownRef = useRef<HTMLDivElement>(null);
  const modelSearchInputRef = useRef<HTMLInputElement>(null);

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
    return found ? (found.name || found.id) : parsedModel.modelId || t('agentDetail.selectModel');
  }, [currentModels, parsedModel.modelId]);

  const DefaultBadge = () => (
    <span className="px-1.5 py-0.5 text-[10px] font-medium bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20 rounded">
      {t('agentDetail.gatewayDefault')}
    </span>
  );

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-2">
        <Sliders className="w-5 h-5 text-amber-600 dark:text-amber-400" />
        <h3 className="text-lg font-semibold">{t('agents.config.modelSettings')}</h3>
      </div>

      {/* Active Model Display */}
      <div className="flex items-center gap-3 px-4 py-3 rounded-xl bg-muted border border-border">
        <Cpu className="w-5 h-5 text-primary shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="text-[11px] text-muted-foreground mb-0.5">{t('agentDetail.activeModel')}</div>
          <div className="text-sm font-mono text-foreground truncate">
            {settings.model || defaultGatewayModel || t('agentDetail.notConfigured')}
          </div>
        </div>
        {settings.model && settings.model !== defaultGatewayModel ? (
          <span className="px-1.5 py-0.5 text-[10px] font-medium bg-primary/15 text-primary border border-primary/20 rounded shrink-0">
            {t('agentDetail.agentOverride')}
          </span>
        ) : settings.model || defaultGatewayModel ? (
          <span className="px-1.5 py-0.5 text-[10px] font-medium bg-muted text-muted-foreground border border-border rounded shrink-0">
            {t('agentDetail.globalDefault')}
          </span>
        ) : null}
      </div>

      {/* Provider & Model Selection */}
      {hasProviders ? (
        <div className="grid grid-cols-2 gap-3">
          {/* Provider Selector */}
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <Cpu className="w-4 h-4 text-muted-foreground" />
              <label className="text-sm font-medium">{t('agentDetail.provider')}</label>
            </div>
            <Select
              value={selectedProvider}
              onValueChange={handleProviderChange}
            >
              <SelectTrigger>
                <SelectValue placeholder={t('agentDetail.selectProvider')} />
              </SelectTrigger>
              <SelectContent>
                {providerNames.map((name) => (
                  <SelectItem key={name} value={name}>
                    <div className="flex items-center gap-2">
                      <span>{name}</span>
                      <span className="text-xs text-muted-foreground">
                        ({providers[name].models?.length ?? 0})
                      </span>
                    </div>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Model Selector with Search */}
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <Cpu className="w-4 h-4 text-muted-foreground" />
              <label className="text-sm font-medium">{t('agents.config.model')}</label>
              <span className="text-xs text-muted-foreground">({currentModels.length})</span>
            </div>
            <div className="relative" ref={modelDropdownRef}>
              <button
                type="button"
                onClick={() => { setModelSearchOpen(!modelSearchOpen); setModelSearch(''); }}
                className="flex h-10 w-full items-center justify-between rounded-md border border-border bg-muted px-3 py-2 text-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
              >
                <span className="truncate">{selectedModelName}</span>
                <ChevronDown className="h-4 w-4 opacity-50 shrink-0" />
              </button>
              {modelSearchOpen && (
                <div className="absolute z-50 mt-1 w-full rounded-md border border-border bg-card shadow-lg">
                  <div className="flex items-center border-b border-border px-3">
                    <Search className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                    <input
                      ref={modelSearchInputRef}
                      type="text"
                      value={modelSearch}
                      onChange={(e) => setModelSearch(e.target.value)}
                      placeholder={t('agentDetail.searchModels')}
                      className="flex-1 bg-transparent px-2 py-2 text-sm text-foreground placeholder:text-muted-foreground/40 outline-none"
                    />
                    {modelSearch && (
                      <span className="text-xs text-muted-foreground">{filteredModels.length}</span>
                    )}
                  </div>
                  <div className="max-h-60 overflow-y-auto p-1">
                    {filteredModels.length === 0 ? (
                      <div className="px-3 py-4 text-center text-xs text-muted-foreground">{t('agentDetail.noModelsFound')}</div>
                    ) : (
                      filteredModels.map((model) => (
                        <button
                          key={model.id}
                          type="button"
                          onClick={() => {
                            setModel(selectedProvider, model.id);
                            setModelSearchOpen(false);
                            setModelSearch('');
                          }}
                          className={`flex w-full items-center gap-2 rounded px-3 py-2 text-sm transition-colors hover:bg-muted ${
                            parsedModel.modelId === model.id ? 'bg-muted text-foreground' : 'text-foreground/80'
                          }`}
                        >
                          <span className="w-3.5 shrink-0">{parsedModel.modelId === model.id && <Check className="h-3.5 w-3.5 text-primary" />}</span>
                          <span>{model.name || model.id}</span>
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
        <div className="rounded-lg bg-muted border border-border p-4">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Info className="w-4 h-4" />
            <span>{t('agentDetail.noProviders')}</span>
          </div>
        </div>
      )}

      {/* Generation Parameters */}
      <div className="grid grid-cols-2 gap-5">
        {/* Temperature Slider */}
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Thermometer className="w-4 h-4 text-muted-foreground" />
              <label className="text-sm font-medium">{t('agents.config.temperature')}</label>
              <Tooltip>
                <TooltipTrigger>
                  <HelpCircle className="w-3.5 h-3.5 text-muted-foreground cursor-help" />
                </TooltipTrigger>
                <TooltipContent side="right" className="max-w-xs">
                  {t('agents.config.temperatureDesc')}
                </TooltipContent>
              </Tooltip>
              {isDefaultTemp && <DefaultBadge />}
            </div>
            <span className="text-sm font-mono text-primary">
              {(settings.temperature ?? 0.7).toFixed(2)}
            </span>
          </div>
          <input
            type="range"
            min="0"
            max="2"
            step="0.1"
            value={settings.temperature ?? 0.7}
            onChange={(e) => updateSetting('temperature', parseFloat(e.target.value))}
            className="w-full h-2 bg-muted rounded-lg appearance-none cursor-pointer accent-primary"
          />
          <div className="flex justify-between text-xs text-muted-foreground">
            <span>Precise (0)</span>
            <span>Balanced (1)</span>
            <span>Creative (2)</span>
          </div>
        </div>

        {/* Max Tokens */}
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <Hash className="w-4 h-4 text-muted-foreground" />
            <label className="text-sm font-medium">{t('agents.config.maxTokens')}</label>
            <Tooltip>
              <TooltipTrigger>
                <HelpCircle className="w-3.5 h-3.5 text-muted-foreground cursor-help" />
              </TooltipTrigger>
              <TooltipContent side="right" className="max-w-xs">
                {t('agents.config.maxTokensDesc')}
              </TooltipContent>
            </Tooltip>
            {isDefaultMaxTokens && <DefaultBadge />}
          </div>
          <Input
            type="number"
            min="1"
            max="128000"
            value={settings.maxTokens ?? 4096}
            onChange={(e) => updateSetting('maxTokens', parseInt(e.target.value) || 4096)}
            className="font-mono"
          />
          <p className="text-xs text-muted-foreground">
            Recommended: 4096 for most use cases
          </p>
        </div>
      </div>
    </div>
  );
}
