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
  const { gatewayConfig } = useDashboardStore();

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
    return providerNames[0] ?? '';
  }, [settings.model, parsedModel, providers, providerNames]);

  const [selectedProvider, setSelectedProvider] = useState(detectedProvider);

  // Keep selectedProvider in sync if detectedProvider changes (e.g. config reload)
  if (detectedProvider && selectedProvider !== detectedProvider && settings.model) {
    // Only sync if the current model actually belongs to a provider
    const currentProviderHasModel = providers[selectedProvider]?.models?.some((m) => m.id === parsedModel.modelId);
    if (!currentProviderHasModel) {
      setSelectedProvider(detectedProvider);
    }
  }

  const currentModels = useMemo(() => {
    return providers[selectedProvider]?.models ?? [];
  }, [providers, selectedProvider]);

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
    return found ? (found.name || found.id) : parsedModel.modelId || 'Select model';
  }, [currentModels, parsedModel.modelId]);

  const DefaultBadge = () => (
    <span className="px-1.5 py-0.5 text-[10px] font-medium bg-emerald-500/15 text-emerald-400 border border-emerald-500/20 rounded">
      Gateway Default
    </span>
  );

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-2">
        <Sliders className="w-5 h-5 text-amber-400" />
        <h3 className="text-lg font-semibold">{t('agents.config.modelSettings')}</h3>
      </div>

      {/* Active Model Display */}
      <div className="flex items-center gap-3 px-4 py-3 rounded-xl bg-zinc-900/60 border border-zinc-800/50">
        <Cpu className="w-5 h-5 text-indigo-400 shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="text-[11px] text-zinc-500 mb-0.5">Active Model</div>
          <div className="text-sm font-mono text-zinc-200 truncate">
            {settings.model || defaultGatewayModel || 'Not configured'}
          </div>
        </div>
        {settings.model && settings.model !== defaultGatewayModel ? (
          <span className="px-1.5 py-0.5 text-[10px] font-medium bg-indigo-500/15 text-indigo-400 border border-indigo-500/20 rounded shrink-0">
            Agent Override
          </span>
        ) : settings.model || defaultGatewayModel ? (
          <span className="px-1.5 py-0.5 text-[10px] font-medium bg-zinc-500/15 text-zinc-400 border border-zinc-500/20 rounded shrink-0">
            Global Default
          </span>
        ) : null}
      </div>

      {/* Provider & Model Selection */}
      {hasProviders ? (
        <div className="grid grid-cols-2 gap-3">
          {/* Provider Selector */}
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <Cpu className="w-4 h-4 text-zinc-400" />
              <label className="text-sm font-medium">Provider</label>
            </div>
            <Select
              value={selectedProvider}
              onValueChange={handleProviderChange}
            >
              <SelectTrigger>
                <SelectValue placeholder="Select provider" />
              </SelectTrigger>
              <SelectContent>
                {providerNames.map((name) => (
                  <SelectItem key={name} value={name}>
                    <div className="flex items-center gap-2">
                      <span>{name}</span>
                      <span className="text-xs text-zinc-500">
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
              <Cpu className="w-4 h-4 text-zinc-400" />
              <label className="text-sm font-medium">{t('agents.config.model')}</label>
              <span className="text-xs text-zinc-500">({currentModels.length})</span>
            </div>
            <div className="relative" ref={modelDropdownRef}>
              <button
                type="button"
                onClick={() => { setModelSearchOpen(!modelSearchOpen); setModelSearch(''); }}
                className="flex h-10 w-full items-center justify-between rounded-md border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
              >
                <span className="truncate">{selectedModelName}</span>
                <ChevronDown className="h-4 w-4 opacity-50 shrink-0" />
              </button>
              {modelSearchOpen && (
                <div className="absolute z-50 mt-1 w-full rounded-md border border-zinc-800 bg-zinc-950 shadow-lg">
                  <div className="flex items-center border-b border-zinc-800 px-3">
                    <Search className="h-3.5 w-3.5 text-zinc-500 shrink-0" />
                    <input
                      ref={modelSearchInputRef}
                      type="text"
                      value={modelSearch}
                      onChange={(e) => setModelSearch(e.target.value)}
                      placeholder="Search models..."
                      className="flex-1 bg-transparent px-2 py-2 text-sm text-zinc-200 placeholder-zinc-500 outline-none"
                    />
                    {modelSearch && (
                      <span className="text-xs text-zinc-500">{filteredModels.length}</span>
                    )}
                  </div>
                  <div className="max-h-60 overflow-y-auto p-1">
                    {filteredModels.length === 0 ? (
                      <div className="px-3 py-4 text-center text-xs text-zinc-500">No models found</div>
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
                          className={`flex w-full items-center gap-2 rounded px-3 py-2 text-sm transition-colors hover:bg-zinc-800 ${
                            parsedModel.modelId === model.id ? 'bg-zinc-800/60 text-zinc-100' : 'text-zinc-300'
                          }`}
                        >
                          <span className="w-3.5 shrink-0">{parsedModel.modelId === model.id && <Check className="h-3.5 w-3.5 text-indigo-400" />}</span>
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
        <div className="rounded-lg bg-zinc-800/50 border border-zinc-700 p-4">
          <div className="flex items-center gap-2 text-sm text-zinc-400">
            <Info className="w-4 h-4" />
            <span>No model providers configured. Add providers in Settings.</span>
          </div>
        </div>
      )}

      {/* Generation Parameters */}
      <div className="grid grid-cols-2 gap-5">
        {/* Temperature Slider */}
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Thermometer className="w-4 h-4 text-zinc-400" />
              <label className="text-sm font-medium">{t('agents.config.temperature')}</label>
              <Tooltip>
                <TooltipTrigger>
                  <HelpCircle className="w-3.5 h-3.5 text-zinc-500 cursor-help" />
                </TooltipTrigger>
                <TooltipContent side="right" className="max-w-xs">
                  {t('agents.config.temperatureDesc')}
                </TooltipContent>
              </Tooltip>
              {isDefaultTemp && <DefaultBadge />}
            </div>
            <span className="text-sm font-mono text-indigo-400">
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
            className="w-full h-2 bg-zinc-800 rounded-lg appearance-none cursor-pointer accent-indigo-500"
          />
          <div className="flex justify-between text-xs text-zinc-500">
            <span>Precise (0)</span>
            <span>Balanced (1)</span>
            <span>Creative (2)</span>
          </div>
        </div>

        {/* Max Tokens */}
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <Hash className="w-4 h-4 text-zinc-400" />
            <label className="text-sm font-medium">{t('agents.config.maxTokens')}</label>
            <Tooltip>
              <TooltipTrigger>
                <HelpCircle className="w-3.5 h-3.5 text-zinc-500 cursor-help" />
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
          <p className="text-xs text-zinc-500">
            Recommended: 4096 for most use cases
          </p>
        </div>
      </div>
    </div>
  );
}
