import { useState, useEffect, useMemo } from 'react';
import { X, Loader2, Zap, AlertCircle, Search, ChevronDown } from 'lucide-react';
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
  const { models, loadModels, gatewayConfig, writeWorkspaceFile } = useDashboardStore();

  const generateDefaultName = () => {
    const adjectives = ['Smart', 'Quick', 'Wise', 'Clever', 'Swift', 'Bright', 'Sharp'];
    const nouns = ['Assistant', 'Helper', 'Agent', 'Companion', 'Aide'];
    const adj = adjectives[Math.floor(Math.random() * adjectives.length)];
    const noun = nouns[Math.floor(Math.random() * nouns.length)];
    return `${adj} ${noun}`;
  };

  const [agentName, setAgentName] = useState(generateDefaultName());
  const [model, setModel] = useState(''); // provider/modelId format
  const [creating, setCreating] = useState(false);
  const [waitingReconnect, setWaitingReconnect] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [modelSearch, setModelSearch] = useState('');
  const [modelDropdownOpen, setModelDropdownOpen] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);

  // Get configured provider IDs from gateway config
  const configuredProviders = useMemo(() => {
    const config = gatewayConfig?.config as Record<string, unknown> | undefined;
    const modelsConfig = config?.models as { providers?: Record<string, unknown> } | undefined;
    return modelsConfig?.providers ? new Set(Object.keys(modelsConfig.providers)) : new Set<string>();
  }, [gatewayConfig]);

  // Filter models to only configured providers, grouped by provider
  const modelsByProvider = useMemo(() => {
    return (models?.models || []).reduce((acc, m) => {
      const provider = m.provider || 'default';
      if (configuredProviders.size > 0 && !configuredProviders.has(provider)) return acc;
      if (!acc[provider]) acc[provider] = [];
      acc[provider].push(m);
      return acc;
    }, {} as Record<string, ModelCatalogEntry[]>);
  }, [models, configuredProviders]);

  const providerNames = useMemo(() => Object.keys(modelsByProvider).sort(), [modelsByProvider]);

  // Selected provider derived from model string
  const selectedProvider = model.includes('/') ? model.split('/')[0] : (providerNames[0] || '');

  // Filtered models for the selected provider
  const filteredModels = useMemo(() => {
    const providerModels = modelsByProvider[selectedProvider] || [];
    if (!modelSearch.trim()) return providerModels;
    const q = modelSearch.toLowerCase();
    return providerModels.filter(m =>
      m.id.toLowerCase().includes(q) || (m.name && m.name.toLowerCase().includes(q))
    );
  }, [modelsByProvider, selectedProvider, modelSearch]);

  // Display name for selected model
  const selectedModelName = useMemo(() => {
    if (!model) return '';
    const modelId = model.includes('/') ? model.split('/').slice(1).join('/') : model;
    const providerModels = modelsByProvider[selectedProvider] || [];
    const found = providerModels.find(m => m.id === modelId);
    return found?.name || found?.id || modelId;
  }, [model, selectedProvider, modelsByProvider]);

  const generateAgentId = (name: string): string => {
    return name
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .replace(/-+/g, '-');
  };

  const agentId = generateAgentId(agentName);

  // Load models and set default on mount
  useEffect(() => {
    if (isOpen) {
      if (!models) {
        loadModels();
      }

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
      if (!client) {
        throw new Error('Not connected to gateway');
      }

      const configSnapshot: ConfigSnapshot = await client.getConfig();
      if (!configSnapshot.exists || !configSnapshot.valid) {
        throw new Error('Config file not found or invalid');
      }

      const currentConfig = configSnapshot.config;
      const agentsList = (currentConfig.agents as { list?: unknown[] })?.list || [];

      let finalAgentId = baseId;
      let counter = 2;

      const existingIds = new Set(
        agentsList.map((a: unknown) => {
          const agent = a as { id?: string };
          return agent?.id;
        }).filter(Boolean)
      );

      while (existingIds.has(finalAgentId)) {
        finalAgentId = `${baseId}-${counter}`;
        counter++;
      }

      const newAgent: Record<string, unknown> = {
        id: finalAgentId,
        name: agentName.trim(),
      };

      if (model.trim()) {
        newAgent.model = model.trim();
      }

      const patch = {
        agents: {
          list: [...agentsList, newAgent],
        },
      };

      await client.patchConfig(configSnapshot.hash, patch);

      setCreating(false);
      setWaitingReconnect(true);
      setError(null);

      // After gateway restart, write localized templates then notify success
      setTimeout(async () => {
        try {
          const templates = getAgentTemplates(locale);
          await Promise.all(
            TEMPLATE_FILES.map(file => {
              const content = templates[file];
              if (content) return writeWorkspaceFile(finalAgentId, file, content);
              return Promise.resolve(false);
            })
          );
        } catch (e) {
          console.warn('[CreateAgent] Failed to write localized templates:', e);
        }
        onSuccess();
        setWaitingReconnect(false);
        handleClose();
      }, 6000);
    } catch (err) {
      console.error('Failed to create agent:', err);
      setError(err instanceof Error ? err.message : 'Failed to create agent');
    } finally {
      setCreating(false);
    }
  };

  const handleClose = () => {
    if (!creating && !waitingReconnect) {
      setError(null);
      onClose();
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={handleClose}
      />

      <div className="relative w-full max-w-lg mx-4 bg-card border border rounded-xl shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="px-6 py-4 border-b border bg-muted/40 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-gradient-to-br from-cyan-500/20 to-blue-500/20 border border-cyan-500/30 rounded-lg">
              <Zap className="w-4 h-4 text-cyan-600 dark:text-cyan-400" />
            </div>
            <div>
              <h2 className="text-sm font-bold text-foreground uppercase tracking-wider" style={{ fontFamily: 'IBM Plex Mono, monospace' }}>
                {t('modals.createAgent.title')}
              </h2>
              <p className="text-xs text-muted-foreground font-mono">{t('modals.createAgent.subtitle')}</p>
            </div>
          </div>
          <button
            onClick={handleClose}
            disabled={creating || waitingReconnect}
            className="p-1.5 rounded-lg hover:bg-muted text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Form */}
        <div className="p-6 space-y-5">
          {/* Agent Name */}
          <div>
            <label className="block text-xs font-bold text-foreground mb-2 uppercase tracking-wide" style={{ fontFamily: 'IBM Plex Mono, monospace' }}>
              {t('modals.createAgent.agentName')} <span className="text-red-600 dark:text-red-400">*</span>
            </label>
            <input
              type="text"
              value={agentName}
              onChange={(e) => setAgentName(e.target.value)}
              placeholder={t('modals.createAgent.placeholder')}
              className="w-full px-3 py-2 bg-background border border rounded-lg text-sm text-foreground font-mono placeholder:text-muted-foreground focus:outline-none focus:border-cyan-500/50 focus:ring-2 focus:ring-cyan-500/20 transition-all"
              disabled={creating}
              autoFocus
            />
            {agentId && (
              <p className="mt-1.5 text-xs text-cyan-600 dark:text-cyan-400/60 font-mono">
                ID: {agentId}
              </p>
            )}
          </div>

          {/* Advanced options toggle */}
          <button
            onClick={() => setShowAdvanced(!showAdvanced)}
            className="flex items-center gap-2 text-xs text-muted-foreground hover:text-foreground transition-colors"
            type="button"
          >
            <ChevronDown className={`w-3.5 h-3.5 transition-transform ${showAdvanced ? 'rotate-180' : ''}`} />
            <span className="font-mono">{t('modals.createAgent.advancedOptions')}</span>
            {model && !showAdvanced && (
              <span className="text-muted-foreground font-mono">({selectedModelName})</span>
            )}
          </button>

          {showAdvanced && (
            <div className="space-y-4 pl-2 border-l-2 border">
              {/* Provider selector */}
              {providerNames.length > 1 && (
                <div>
                  <label className="block text-xs font-bold text-foreground mb-2 uppercase tracking-wide" style={{ fontFamily: 'IBM Plex Mono, monospace' }}>
                    {t('modals.createAgent.provider')}
                  </label>
                  <div className="flex gap-2">
                    {providerNames.map(p => (
                      <button
                        key={p}
                        onClick={() => {
                          const firstModel = modelsByProvider[p]?.[0];
                          if (firstModel) setModel(`${p}/${firstModel.id}`);
                        }}
                        className={`px-3 py-1.5 text-xs font-mono rounded-lg border transition-colors ${
                          selectedProvider === p
                            ? 'bg-cyan-500/20 border-cyan-500/50 text-cyan-300'
                            : 'bg-card border text-muted-foreground hover:border hover:text-foreground'
                        }`}
                        disabled={creating}
                      >
                        {p.charAt(0).toUpperCase() + p.slice(1)}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Model selector with search */}
              <div>
                <label className="block text-xs font-bold text-foreground mb-2 uppercase tracking-wide" style={{ fontFamily: 'IBM Plex Mono, monospace' }}>
                  {t('modals.createAgent.model')}
                </label>
                <div className="relative">
                  <button
                    onClick={() => setModelDropdownOpen(!modelDropdownOpen)}
                    className="w-full flex items-center justify-between px-3 py-2 bg-background border border rounded-lg text-sm text-foreground font-mono hover:border focus:outline-none focus:border-cyan-500/50 focus:ring-2 focus:ring-cyan-500/20 transition-all"
                    disabled={creating}
                    type="button"
                  >
                    <span className={model ? 'text-foreground' : 'text-muted-foreground'}>
                      {model ? selectedModelName : t('modals.createAgent.selectModel')}
                    </span>
                    <ChevronDown className={`w-4 h-4 text-muted-foreground transition-transform ${modelDropdownOpen ? 'rotate-180' : ''}`} />
                  </button>

                  {modelDropdownOpen && (
                    <div className="absolute z-10 mt-1 w-full bg-card border border rounded-lg shadow-xl overflow-hidden">
                      <div className="p-2 border-b border">
                        <div className="relative">
                          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
                          <input
                            type="text"
                            value={modelSearch}
                            onChange={(e) => setModelSearch(e.target.value)}
                            placeholder={t('modals.createAgent.searchModels')}
                            className="w-full pl-8 pr-3 py-1.5 bg-background border border rounded text-xs text-foreground font-mono placeholder:text-muted-foreground focus:outline-none focus:border-cyan-500/40"
                            autoFocus
                          />
                        </div>
                      </div>
                      <div className="max-h-48 overflow-y-auto">
                        {filteredModels.length > 0 ? (
                          filteredModels.map((m) => {
                            const fullId = `${selectedProvider}/${m.id}`;
                            const isSelected = model === fullId;
                            return (
                              <button
                                key={m.id}
                                onClick={() => handleSelectModel(selectedProvider, m.id)}
                                className={`w-full flex items-center justify-between px-3 py-2 text-left text-xs font-mono transition-colors ${
                                  isSelected
                                    ? 'bg-cyan-500/15 text-cyan-300'
                                    : 'text-foreground hover:bg-muted'
                                }`}
                              >
                                <span className="truncate">{m.name || m.id}</span>
                                {m.contextWindow && (
                                  <span className="text-[10px] text-muted-foreground ml-2 shrink-0">{Math.round(m.contextWindow / 1000)}k</span>
                                )}
                              </button>
                            );
                          })
                        ) : (
                          <div className="px-3 py-4 text-center text-xs text-muted-foreground font-mono">
                            {t('modals.createAgent.noModelsFound')}
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
                {model && (
                  <p className="mt-1.5 text-xs text-muted-foreground font-mono">{model}</p>
                )}
              </div>
            </div>
          )}

          {/* Waiting for reconnect message */}
          {waitingReconnect && (
            <div className="p-3 bg-cyan-500/10 border border-cyan-500/30 rounded-lg flex items-start gap-2">
              <Loader2 className="w-4 h-4 text-cyan-600 dark:text-cyan-400 mt-0.5 shrink-0 animate-spin" />
              <div>
                <p className="text-xs text-cyan-600 dark:text-cyan-400 font-mono font-bold">{t('modals.createAgent.success')}</p>
                <p className="text-xs text-cyan-600 dark:text-cyan-400/70 font-mono mt-1">{t('modals.createAgent.waitingRestart')}</p>
              </div>
            </div>
          )}

          {/* Error Message */}
          {error && !waitingReconnect && (
            <div className="p-3 bg-red-500/10 border border-red-500/30 rounded-lg flex items-start gap-2">
              <AlertCircle className="w-4 h-4 text-red-600 dark:text-red-400 mt-0.5 shrink-0" />
              <p className="text-xs text-red-600 dark:text-red-400 font-mono">{error}</p>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border bg-muted/40 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-1.5 h-1.5 rounded-full bg-yellow-500 animate-pulse" />
            <p className="text-xs text-muted-foreground font-mono">{t('modals.createAgent.gatewayRestart')}</p>
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={handleClose}
              disabled={creating || waitingReconnect}
              className="px-4 py-2 text-xs font-bold text-foreground hover:text-foreground uppercase tracking-wider transition-colors disabled:opacity-50"
              style={{ fontFamily: 'IBM Plex Mono, monospace' }}
            >
              {t('common.cancel')}
            </button>
            <button
              onClick={handleCreate}
              disabled={creating || waitingReconnect || !agentName.trim() || !model}
              className="px-4 py-2 bg-gradient-to-r from-cyan-500 to-blue-500 hover:from-cyan-400 hover:to-blue-400 text-zinc-950 text-xs font-bold uppercase tracking-wider rounded-lg transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
              style={{ fontFamily: 'IBM Plex Mono, monospace' }}
            >
              {creating ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  {t('modals.createAgent.creating')}
                </>
              ) : waitingReconnect ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  {t('modals.createAgent.restarting')}
                </>
              ) : (
                t('modals.createAgent.createButton')
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
