import { useState, useEffect, useMemo } from 'react';
import { X, Loader2, AlertCircle, Search, ChevronDown, Plus, SlidersHorizontal, Check, ChevronUp } from 'lucide-react';

const PRESETS = [
  { key: 'basica', label: 'Básica', model: import.meta.env.VITE_PRESET_BASICA || 'Qwen/Qwen3.5-35B-A3B' },
  { key: 'alta', label: 'Alta', model: import.meta.env.VITE_PRESET_ALTA || 'Qwen/Qwen3.5-122B-A10B' },
  { key: 'excelente', label: 'Excelente', model: import.meta.env.VITE_PRESET_EXCELENTE || 'moonshotai/Kimi-K2.5' },
];
import { getGatewayClient } from '../../lib/gateway-client';
import { useDashboardStore } from '../../store/dashboard-store';
import { getAgentTemplates, TEMPLATE_FILES } from '../../lib/agent-templates';
import useTranslation from '../../i18n';
import type { ConfigSnapshot, ModelCatalogEntry } from '../../types/openclaw';

interface CreateAgentModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
}

export function CreateAgentModal({ isOpen, onClose, onSuccess }: CreateAgentModalProps) {
  const { t, locale } = useTranslation();
  const { models, loadModels, availableModels, loadAvailableModels, gatewayConfig, writeWorkspaceFile } = useDashboardStore();

  const generateDefaultName = () => {
    const adjectives = ['Smart', 'Quick', 'Wise', 'Clever', 'Swift', 'Bright', 'Sharp'];
    const nouns = ['Assistant', 'Helper', 'Agent', 'Companion', 'Aide'];
    const adj = adjectives[Math.floor(Math.random() * adjectives.length)];
    const noun = nouns[Math.floor(Math.random() * nouns.length)];
    return `${adj} ${noun}`;
  };

  const [agentName, setAgentName] = useState(generateDefaultName());
  const [model, setModel] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [modelSearch, setModelSearch] = useState('');
  const [modelDropdownOpen, setModelDropdownOpen] = useState(false);
  const [selectorMode, setSelectorMode] = useState<'simple' | 'advanced'>('simple');

  // Get configured provider IDs from gateway config
  const configuredProviders = useMemo(() => {
    const config = gatewayConfig?.config as Record<string, unknown> | undefined;
    const modelsConfig = config?.models as { providers?: Record<string, unknown> } | undefined;
    return modelsConfig?.providers ? new Set(Object.keys(modelsConfig.providers)) : new Set<string>();
  }, [gatewayConfig]);

  // Use availableModels (fetched from each provider's API) with fallback to gateway catalog
  const modelsByProvider = useMemo(() => {
    if (availableModels && Object.keys(availableModels).length > 0) {
      const result: Record<string, ModelCatalogEntry[]> = {};
      for (const [provider, providerModels] of Object.entries(availableModels)) {
        if (configuredProviders.size > 0 && !configuredProviders.has(provider)) continue;
        result[provider] = providerModels
          .filter((m: any) => !m.type || m.type === 'chat')
          .map((m: any) => ({
            id: m.id,
            name: m.name || m.id,
            provider,
            contextWindow: m.contextWindow,
          }));
      }
      return result;
    }
    return (models?.models || []).reduce((acc, m) => {
      const provider = m.provider || 'default';
      if (configuredProviders.size > 0 && !configuredProviders.has(provider)) return acc;
      if (!acc[provider]) acc[provider] = [];
      acc[provider].push(m);
      return acc;
    }, {} as Record<string, ModelCatalogEntry[]>);
  }, [models, availableModels, configuredProviders]);

  const providerNames = useMemo(() => Object.keys(modelsByProvider).sort(), [modelsByProvider]);

  const selectedProvider = model.includes('/') ? model.split('/')[0] : (providerNames[0] || '');

  const filteredModels = useMemo(() => {
    const providerModels = modelsByProvider[selectedProvider] || [];
    if (!modelSearch.trim()) return providerModels;
    const q = modelSearch.toLowerCase();
    return providerModels.filter(m =>
      m.id.toLowerCase().includes(q) || (m.name && m.name.toLowerCase().includes(q))
    );
  }, [modelsByProvider, selectedProvider, modelSearch]);

  const selectedModelName = useMemo(() => {
    if (!model) return '';
    const modelId = model.includes('/') ? model.split('/').slice(1).join('/') : model;
    const providerModels = modelsByProvider[selectedProvider] || [];
    const found = providerModels.find(m => m.id === modelId);
    return found?.name || found?.id || modelId;
  }, [model, selectedProvider, modelsByProvider]);

  const generateAgentId = (name: string): string => {
    const transliterated = name
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/ñ/gi, 'n')
      .replace(/ß/g, 'ss');
    return transliterated
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .replace(/-+/g, '-');
  };

  const agentId = generateAgentId(agentName);

  useEffect(() => {
    if (isOpen) {
      if (!models) loadModels();
      if (!availableModels) loadAvailableModels();

      const getDefaultModel = async () => {
        try {
          const client = getGatewayClient();
          if (!client) return;
          const configSnapshot: ConfigSnapshot = await client.getConfig();
          const config = configSnapshot.config;
          const agentsConfig = config.agents as { defaults?: { model?: string | { primary?: string } } };
          const defaultModel = agentsConfig?.defaults?.model;
          if (typeof defaultModel === 'string' && defaultModel) {
            setModel(defaultModel);
          } else if (typeof defaultModel === 'object' && defaultModel?.primary) {
            setModel(defaultModel.primary);
          }
        } catch (err) {
          console.error('Failed to fetch default model:', err);
        }
      };

      getDefaultModel();
      setAgentName(generateDefaultName());
      setModelSearch('');
      setModelDropdownOpen(false);
    }
  }, [isOpen, models, loadModels]);

  const handleSelectModel = (providerId: string, modelId: string) => {
    setModel(`${providerId}/${modelId}`);
    setModelDropdownOpen(false);
    setModelSearch('');
  };

  const handleCreate = async () => {
    if (!agentName.trim()) {
      setError(t('modals.createAgent.nameRequired'));
      return;
    }

    const baseId = generateAgentId(agentName);
    if (!baseId) {
      setError(t('modals.createAgent.invalidName'));
      return;
    }

    setCreating(true);
    setError(null);

    try {
      const client = getGatewayClient();
      if (!client) throw new Error('Not connected to gateway');

      const result = await client.createAgent({
        name: agentName.trim(),
        workspace: agentId,
      });

      if (!result.ok) throw new Error('Failed to create agent');

      const finalAgentId = result.agentId;

      // agents.create ignores the model param; set it via agents.update now that the
      // agent exists in agents.list (no restart — agents.* config changes are hot-reloaded)
      if (model.trim()) {
        try {
          await client.updateAgent(finalAgentId, { model: model.trim() });
        } catch {
          // non-fatal: agent will use gateway default model
        }
      }

      setCreating(false);
      setError(null);

      const writeTemplates = async () => {
        const templates = getAgentTemplates(locale);
        await Promise.all(
          TEMPLATE_FILES.map(file => {
            const content = templates[file];
            if (content) return writeWorkspaceFile(finalAgentId, file, content);
            return Promise.resolve(true);
          })
        );
      };
      writeTemplates().catch(() => { /* non-fatal */ }).finally(() => {
        onSuccess();
        setError(null);
        onClose();
      });
    } catch (err) {
      console.error('Failed to create agent:', err);
      setError(err instanceof Error ? err.message : 'Failed to create agent');
    } finally {
      setCreating(false);
    }
  };

  const handleClose = () => {
    if (!creating) {
      setError(null);
      onClose();
    }
  };

  if (!isOpen) return null;

  const totalModels = Object.values(modelsByProvider).reduce((sum, arr) => sum + arr.length, 0);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/40 backdrop-blur-[2px]" onClick={handleClose} />

      <div className="relative w-full max-w-md bg-card border border-border rounded-2xl shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-200 flex flex-col max-h-[85vh]">
        {/* Header */}
        <div className="px-5 py-4 border-b border-border flex items-center justify-between shrink-0">
          <h2 className="text-base font-semibold text-foreground">{t('modals.createAgent.title')}</h2>
          <button
            onClick={handleClose}
            disabled={creating}
            className="p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors disabled:opacity-50"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body — scrollable so model list is never clipped */}
        <div className="px-5 py-4 space-y-4 flex-1 overflow-y-auto">
          {/* Agent Name */}
          <div>
            <label className="block text-sm font-medium text-foreground mb-1.5">
              {t('modals.createAgent.agentName')}
            </label>
            <input
              type="text"
              value={agentName}
              onChange={(e) => setAgentName(e.target.value)}
              placeholder={t('modals.createAgent.placeholder')}
              className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent transition-shadow"
              disabled={creating}
              autoFocus
            />
            {agentId && (
              <p className="mt-1 text-[11px] text-muted-foreground font-mono">
                ID: {agentId}
              </p>
            )}
          </div>

          {/* Model Selection */}
          <div>
            <label className="block text-sm font-medium text-foreground mb-2">
              {t('modals.createAgent.model')}
            </label>

            {/* Presets */}
            <div className="flex flex-col gap-0.5 mb-1">
              {PRESETS.map((preset, i) => {
                const fullId = `${providerNames[0] || 'silos'}/${preset.model}`;
                const isSelected = model === fullId;
                const dots = i + 1;
                return (
                  <button
                    key={preset.key}
                    type="button"
                    disabled={creating}
                    onClick={() => handleSelectModel(providerNames[0] || 'silos', preset.model)}
                    className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-left transition-colors group ${
                      isSelected
                        ? 'bg-primary/10 text-primary'
                        : 'hover:bg-muted/60 text-foreground'
                    }`}
                  >
                    <div className="flex gap-0.5 shrink-0">
                      {Array.from({ length: 3 }).map((_, j) => (
                        <div key={j} className={`w-1.5 h-1.5 rounded-full transition-colors ${
                          j < dots
                            ? isSelected ? 'bg-primary' : 'bg-primary/50 group-hover:bg-primary/70'
                            : 'bg-muted-foreground/20'
                        }`} />
                      ))}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className={`text-sm font-medium ${isSelected ? 'text-primary' : ''}`}>{preset.label}</div>
                      <div className="text-[10px] text-muted-foreground/50 truncate font-mono">{preset.model.split('/').pop()}</div>
                    </div>
                    {isSelected && <Check className="w-3.5 h-3.5 text-primary shrink-0" />}
                  </button>
                );
              })}
            </div>

            {/* Ver todos toggle */}
            <button
              type="button"
              disabled={creating}
              onClick={() => { setSelectorMode(selectorMode === 'advanced' ? 'simple' : 'advanced'); setModelSearch(''); loadAvailableModels(); }}
              className="flex items-center gap-1.5 px-3 py-2 text-[11px] text-muted-foreground hover:text-foreground transition-colors w-full"
            >
              {selectorMode === 'advanced' ? <ChevronUp className="w-3 h-3" /> : <SlidersHorizontal className="w-3 h-3" />}
              {selectorMode === 'advanced' ? 'Ocultar lista' : 'Ver todos los modelos'}
            </button>

            {/* Advanced list */}
            {selectorMode === 'advanced' && (
              <div className="border border-border rounded-lg overflow-hidden">
                <div className="flex items-center gap-2 px-3 py-2 border-b border-border bg-muted/20">
                  <Search className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                  <input
                    type="text"
                    value={modelSearch}
                    onChange={(e) => setModelSearch(e.target.value)}
                    placeholder="Buscar modelo..."
                    className="flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground/40"
                    autoFocus
                  />
                  {modelSearch && (
                    <button type="button" onClick={() => setModelSearch('')} className="text-muted-foreground hover:text-foreground">
                      <X className="w-3 h-3" />
                    </button>
                  )}
                </div>
                <div className="max-h-44 overflow-y-auto p-1 custom-scrollbar">
                  {filteredModels.length > 0 ? (
                    filteredModels.map((m) => {
                      const fullId = `${selectedProvider}/${m.id}`;
                      const isSelected = model === fullId;
                      return (
                        <button
                          key={m.id}
                          type="button"
                          disabled={creating}
                          onClick={() => handleSelectModel(selectedProvider, m.id)}
                          className={`w-full flex items-center justify-between px-3 py-2 rounded-lg text-left text-xs transition-colors ${
                            isSelected ? 'bg-primary/10 text-primary font-medium' : 'text-foreground/80 hover:bg-muted/80'
                          }`}
                        >
                          <span className="truncate font-mono">{m.name || m.id}</span>
                          <div className="flex items-center gap-2 shrink-0">
                            {m.contextWindow ? (
                              <span className="text-[10px] text-muted-foreground/50 font-mono">{Math.round(m.contextWindow / 1000)}k</span>
                            ) : null}
                            {isSelected && <Check className="w-3.5 h-3.5 text-primary" />}
                          </div>
                        </button>
                      );
                    })
                  ) : (
                    <div className="px-3 py-4 text-center text-xs text-muted-foreground">
                      {!availableModels ? <Loader2 className="w-3.5 h-3.5 animate-spin mx-auto" /> : t('modals.createAgent.noModelsFound')}
                    </div>
                  )}
                </div>
              </div>
            )}

            {model && !PRESETS.some(p => model.endsWith(p.model)) && (
              <p className="mt-1 text-[11px] text-muted-foreground font-mono truncate">{model}</p>
            )}
          </div>

          {/* Status messages */}
          {error && (
            <div className="p-3 bg-destructive/10 border border-destructive/20 rounded-lg flex items-start gap-2.5">
              <AlertCircle className="w-4 h-4 text-destructive mt-0.5 shrink-0" />
              <p className="text-xs text-destructive">{error}</p>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-border bg-muted/20 flex items-center justify-end gap-2 shrink-0">
          <button
            onClick={handleClose}
            disabled={creating}
            className="px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50 rounded-md"
          >
            {t('common.cancel')}
          </button>
          <button
            onClick={handleCreate}
            disabled={creating || !agentName.trim() || !model}
            className="px-4 py-1.5 bg-foreground text-background text-sm font-medium rounded-lg hover:bg-foreground/90 transition-colors disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1.5"
          >
            {creating ? (
              <>
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                {t('modals.createAgent.creating')}
              </>
            ) : (
              <>
                <Plus className="w-3.5 h-3.5" />
                {t('modals.createAgent.createButton')}
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
