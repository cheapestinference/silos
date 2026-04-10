import { useState, useEffect } from 'react';
import {
  Plus,
  Zap,
  Edit3,
  Trash2,
  Check,
  Cpu,
  Eye,
  EyeOff,
  ChevronRight,
  ChevronDown,
} from 'lucide-react';
import { useDashboardStore } from '../../store/dashboard-store';
import { cn } from '../../lib/utils';
import useTranslation, { t as tStatic } from '../../i18n';

type ModelDef = { id: string; name: string; contextWindow: number; reasoning?: boolean };

export function ModelsSection() {
  const { t } = useTranslation();
  const { gatewayConfig, gatewayConfigLoading, loadGatewayConfig, addModelProvider, deleteModelProvider, token: gatewayToken, models: dynamicModels, availableModels } = useDashboardStore();
  const [expandedProvider, setExpandedProvider] = useState<string | null>(null);
  const [showApiKey, setShowApiKey] = useState<Record<string, boolean>>({});
  const [showAddProvider, setShowAddProvider] = useState(false);
  const [newProvider, setNewProvider] = useState<{ id: string; baseUrl: string; apiKey: string; api: string; models?: ModelDef[] }>({ id: '', baseUrl: '', apiKey: '', api: 'openai-completions' });
  const [savingProvider, setSavingProvider] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; models?: ModelDef[]; error?: string } | null>(null);
  const [deletingProvider, setDeletingProvider] = useState<string | null>(null);
  const [editingProvider, setEditingProvider] = useState<string | null>(null);
  const [editProvider, setEditProvider] = useState<{ baseUrl: string; apiKey: string; api: string; models?: ModelDef[] }>({ baseUrl: '', apiKey: '', api: '' });
  const [editSaving, setEditSaving] = useState(false);
  const [editTesting, setEditTesting] = useState(false);
  const [editTestResult, setEditTestResult] = useState<{ ok: boolean; models?: ModelDef[]; error?: string } | null>(null);

  // Get providers from the config
  const configProviders = (gatewayConfig?.config as Record<string, unknown>)?.models as { providers?: Record<string, unknown> } | undefined;
  const providers = configProviders?.providers ?? {};

  // Check which providers have auth profiles (subscription-based auth, no apiKey needed)
  const authProfiles = (gatewayConfig?.config as Record<string, unknown>)?.auth as { profiles?: Record<string, { provider?: string; mode?: string }> } | undefined;
  const providersWithAuthProfile = new Set<string>();
  if (authProfiles?.profiles) {
    for (const profile of Object.values(authProfiles.profiles)) {
      if (profile.provider) providersWithAuthProfile.add(profile.provider.toLowerCase());
    }
  }

  // Silos subscription provider
  const defaultProvider = {
    id: 'silos',
    name: tStatic('settings.providers.subscription'),
    isDefault: true,
    description: tStatic('settings.providers.subscriptionDesc'),
  };

  // Resolve context window — prefer provider API data, then gateway catalog, then config.
  // Filters out 200000 (OpenClaw's hardcoded fallback when model doesn't report one).
  const resolveContextWindow = (providerId: string, modelId: string, fallback?: number): number => {
    const providerCtx = availableModels?.[providerId]?.find(m => m.id === modelId)?.contextWindow;
    const catalogCtx = dynamicModels?.models?.find(
      m => m.id === modelId && m.provider?.toLowerCase() === providerId.toLowerCase()
    )?.contextWindow;
    const raw = providerCtx || catalogCtx || fallback || 0;
    return raw === 200000 ? 0 : raw;
  };

  const providerPresets: Record<string, { baseUrl: string; api: string }> = {
    anthropic: { baseUrl: 'https://api.anthropic.com/v1', api: 'anthropic-messages' },
    openai: { baseUrl: 'https://api.openai.com/v1', api: 'openai-completions' },
    google: { baseUrl: 'https://generativelanguage.googleapis.com/v1beta', api: 'google-generative-ai' },
    groq: { baseUrl: 'https://api.groq.com/openai/v1', api: 'openai-completions' },
    together: { baseUrl: 'https://api.together.xyz/v1', api: 'openai-completions' },
    deepseek: { baseUrl: 'https://api.deepseek.com/v1', api: 'openai-completions' },
    ollama: { baseUrl: 'http://localhost:11434/v1', api: 'openai-completions' },
  };

  const getProviderIcon = (id: string, size: 'sm' | 'md' = 'md'): string | React.ReactElement => {
    const lower = id.toLowerCase();
    const cls = size === 'sm' ? 'w-4 h-4' : 'w-7 h-7';
    const icons: Record<string, { src: string; alt: string }> = {
      silos: { src: '/icons/silos.svg', alt: 'Silos' },
      anthropic: { src: '/icons/claude.svg', alt: 'Claude' },
      claude: { src: '/icons/claude.svg', alt: 'Claude' },
      openai: { src: '/icons/openai.svg', alt: 'OpenAI' },
      gpt: { src: '/icons/openai.svg', alt: 'OpenAI' },
      google: { src: '/icons/google.svg', alt: 'Google' },
      gemini: { src: '/icons/google.svg', alt: 'Google' },
      bedrock: { src: '/icons/aws.svg', alt: 'AWS' },
      aws: { src: '/icons/aws.svg', alt: 'AWS' },
      together: { src: '/icons/together.svg', alt: 'Together' },
      groq: { src: '/icons/groq.svg', alt: 'Groq' },
      ollama: { src: '/icons/ollama.svg', alt: 'Ollama' },
      deepseek: { src: '/icons/deepseek.svg', alt: 'DeepSeek' },
    };
    for (const [key, icon] of Object.entries(icons)) {
      if (lower.includes(key)) return <img src={icon.src} alt={icon.alt} className={cn(cls, 'inline-block flex-shrink-0')} />;
    }
    return <img src="/icons/provider-generic.svg" alt="Provider" className={cn(cls, 'inline-block flex-shrink-0 opacity-60')} />;
  };

  const testConnection = async () => {
    if (!newProvider.baseUrl) return;
    setTesting(true);
    setTestResult(null);

    try {
      const isAnthropic = newProvider.api === 'anthropic-messages';
      const targetHeaders: Record<string, string> = {};

      if (newProvider.apiKey) {
        if (isAnthropic) {
          targetHeaders['x-api-key'] = newProvider.apiKey;
          targetHeaders['anthropic-version'] = '2023-06-01';
        } else {
          targetHeaders['Authorization'] = `Bearer ${newProvider.apiKey}`;
        }
      }

      const targetUrl = `${newProvider.baseUrl.replace(/\/+$/, '')}/models`;

      // Use our backend proxy to avoid CORS
      const proxyHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
      if (gatewayToken) proxyHeaders['Authorization'] = `Bearer ${gatewayToken}`;
      const response = await fetch('/api/proxy-test', {
        method: 'POST',
        headers: proxyHeaders,
        body: JSON.stringify({ url: targetUrl, headers: targetHeaders }),
      });

      const result = await response.json();

      if (result.error) {
        throw new Error(result.error);
      }

      if (!result.ok) {
        throw new Error(`HTTP ${result.status}: ${(result.body || result.statusText || '').slice(0, 200)}`);
      }

      const data = JSON.parse(result.body);

      // Parse models from response (OpenAI format: { data: [...] })
      const rawModels: Array<{ id: string; created?: number; context_window?: number; context_length?: number; max_model_len?: number }> =
        Array.isArray(data?.data) ? data.data :
        Array.isArray(data) ? data : [];

      const fetchedModels: ModelDef[] = rawModels.map(m => ({
        id: m.id,
        name: m.id,
        contextWindow: m.context_window || m.context_length || m.max_model_len || 0,
        reasoning: /^o[0-9]|reason|think/i.test(m.id),
      }));

      // Auto-apply fetched models
      if (fetchedModels.length > 0) {
        setNewProvider(prev => ({ ...prev, models: fetchedModels }));
      }
      setTestResult({ ok: true, models: fetchedModels });
    } catch (err: unknown) {
      const msg = String(err instanceof Error ? err.message : err);
      setTestResult({ ok: false, error: msg });
    } finally {
      setTesting(false);
    }
  };

  // Check if silos is already in providers from backend
  const hasSilosFromBackend = 'silos' in providers;

  useEffect(() => {
    loadGatewayConfig();
  }, [loadGatewayConfig]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">{t('settings.providers.configure')}</p>
        <div className="flex items-center gap-2">
          <button
            onClick={() => { setShowAddProvider(!showAddProvider); }}
            className={cn(
              "flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg transition-colors",
              showAddProvider
                ? "bg-muted text-foreground"
                : "bg-primary/20 text-primary border border-primary/20 hover:bg-primary/20"
            )}
          >
            <Plus className="w-3.5 h-3.5" /> {t('settings.providers.addProvider')}
          </button>
        </div>
      </div>

      {/* Add Provider Form */}
      {showAddProvider && (
        <div className="p-4 rounded-xl bg-card border border-primary/20 space-y-4">
          <h3 className="text-sm font-semibold text-foreground">{t('settings.providers.addNewProvider')}</h3>
          <div className="flex flex-wrap gap-2">
            {Object.keys(providerPresets).map((preset) => (
              <button
                key={preset}
                onClick={() => {
                  setNewProvider({
                    ...newProvider,
                    id: preset,
                    baseUrl: providerPresets[preset].baseUrl,
                    api: providerPresets[preset].api,
                    models: undefined,
                  });
                  setTestResult(null);
                }}
                className={cn(
                  "px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors",
                  newProvider.id === preset
                    ? "bg-primary/20 text-primary border-primary/40"
                    : "bg-muted text-muted-foreground border hover:border-foreground/20"
                )}
              >
                {getProviderIcon(preset, 'sm')} {preset}
              </button>
            ))}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <input
              type="text"
              autoComplete="off"
              placeholder={t('settings.providers.providerId')}
              value={newProvider.id}
              onChange={(e) => setNewProvider({ ...newProvider, id: e.target.value })}
              className="px-3 py-2 rounded-lg bg-muted border text-foreground text-sm focus:outline-none focus:border-ring"
            />
            <input
              type="text"
              autoComplete="off"
              placeholder={t('settings.providers.baseUrl')}
              value={newProvider.baseUrl}
              onChange={(e) => { setNewProvider({ ...newProvider, baseUrl: e.target.value }); setTestResult(null); }}
              className="px-3 py-2 rounded-lg bg-muted border text-foreground text-sm font-mono focus:outline-none focus:border-ring"
            />
          </div>
          <input
            type="password"
            autoComplete="new-password"
            placeholder={t('settings.providers.apiKey')}
            value={newProvider.apiKey}
            onChange={(e) => { setNewProvider({ ...newProvider, apiKey: e.target.value }); setTestResult(null); }}
            className="w-full px-3 py-2 rounded-lg bg-muted border text-foreground text-sm font-mono focus:outline-none focus:border-ring"
          />
          {/* Test Connection */}
          <div className="flex items-center gap-2">
            <button
              disabled={!newProvider.baseUrl || testing}
              onClick={testConnection}
              className={cn(
                "flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg transition-colors",
                newProvider.baseUrl && !testing
                  ? "bg-primary/20 text-primary border border-primary/20 hover:bg-primary/20"
                  : "bg-muted text-muted-foreground cursor-not-allowed"
              )}
            >
              {testing ? (
                <><div className="w-3 h-3 border-2 border-primary/40 border-t-transparent rounded-full animate-spin" /> {t('settings.providers.testing')}</>
              ) : (
                <><Zap className="w-3.5 h-3.5" /> {t('settings.providers.testConnection')}</>
              )}
            </button>
            {testResult && !testResult.ok && (
              <span className="text-xs text-red-600 dark:text-red-400">{testResult.error}</span>
            )}
          </div>

          {/* Test Result - Fetched Models */}
          {testResult?.ok && (
            <div className="p-3 rounded-lg bg-emerald-500/10 border border-emerald-500/20 space-y-2">
              <div className="flex items-center gap-2">
                <Check className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
                <span className="text-xs font-semibold text-emerald-700 dark:text-emerald-300">
                  Connection OK — {testResult.models?.length || 0} models found
                </span>
              </div>
              {testResult.models && testResult.models.length > 0 && (
                <div className="max-h-32 overflow-y-auto space-y-0.5">
                  {testResult.models.map(m => (
                    <div key={m.id} className="text-[11px] font-mono text-muted-foreground px-2 py-0.5 rounded bg-muted">
                      {m.id}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {saveError && (
            <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-xs text-red-600 dark:text-red-400">
              {saveError}
            </div>
          )}
          <div className="flex justify-end gap-2">
            <button
              onClick={() => {
                setShowAddProvider(false);
                setNewProvider({ id: '', baseUrl: '', apiKey: '', api: 'openai-completions', models: undefined });
                setSaveError(null);
                setTestResult(null);
              }}
              className="px-3 py-1.5 text-xs font-semibold rounded-lg bg-muted text-muted-foreground hover:bg-muted"
            >
              {t('common.cancel')}
            </button>
            <button
              disabled={!newProvider.id || !newProvider.baseUrl || savingProvider || !testResult?.ok}
              onClick={async () => {
                setSavingProvider(true);
                setSaveError(null);
                setSaveSuccess(false);
                try {
                  const success = await addModelProvider(newProvider.id, {
                    baseUrl: newProvider.baseUrl,
                    apiKey: newProvider.apiKey || undefined,
                    api: newProvider.api,
                    models: newProvider.models,
                  });
                  if (success) {
                    setSaveSuccess(true);
                    setShowAddProvider(false);
                    setNewProvider({ id: '', baseUrl: '', apiKey: '', api: 'openai-completions', models: undefined });
                    // Clear success message after 5 seconds
                    setTimeout(() => setSaveSuccess(false), 5000);
                  } else {
                    setSaveError(t('settings.providers.addFailed'));
                  }
                } catch (err) {
                  setSaveError(String(err));
                } finally {
                  setSavingProvider(false);
                }
              }}
              className={cn(
                "px-3 py-1.5 text-xs font-semibold rounded-lg flex items-center gap-1.5",
                newProvider.id && newProvider.baseUrl && !savingProvider && testResult?.ok
                  ? "bg-primary/20 text-primary hover:bg-primary/40"
                  : "bg-muted text-muted-foreground cursor-not-allowed"
              )}
            >
              {savingProvider && <div className="w-3 h-3 border-2 border-primary/40 border-t-transparent rounded-full animate-spin" />}
              {savingProvider ? t('settings.providers.saving') : t('settings.providers.addProvider')}
            </button>
          </div>
        </div>
      )}

      {/* Success Message */}
      {saveSuccess && (
        <div className="p-3 rounded-xl bg-emerald-500/10 border border-emerald-500/20 flex items-center gap-3">
          <Check className="w-5 h-5 text-emerald-600 dark:text-emerald-400" />
          <div>
            <p className="text-sm font-medium text-emerald-700 dark:text-emerald-300">Provider added successfully!</p>
            <p className="text-xs text-muted-foreground">{t('settings.providers.gatewayRestart')}</p>
          </div>
        </div>
      )}

      {/* Providers List */}
      {gatewayConfigLoading ? (
        <div className="p-8 text-center rounded-xl bg-card border">
          <div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin mx-auto mb-3" />
          <p className="text-sm text-muted-foreground">Loading providers...</p>
        </div>
      ) : (
        <div className="space-y-2">
          {/* Silos Subscription Provider - Always shown first, collapsed by default */}
          {!hasSilosFromBackend && (() => {
            const silosModels = dynamicModels?.models?.filter(m => m.provider === 'silos') ?? [];
            const silosExpanded = expandedProvider === '__silos_default__';
            return (
              <div className="rounded-xl border border-primary/20 overflow-hidden bg-gradient-to-r from-primary/5 to-primary/3">
                <button
                  onClick={() => setExpandedProvider(silosExpanded ? null : '__silos_default__')}
                  className="w-full flex items-center gap-3 p-4 hover:bg-muted/40 transition-colors"
                >
                  <span className="flex items-center justify-center w-8 h-8">{getProviderIcon('silos')}</span>
                  <div className="text-left">
                    <h3 className="font-semibold text-foreground">{defaultProvider.name}</h3>
                    <p className="text-xs text-muted-foreground">{defaultProvider.description}</p>
                  </div>
                  <div className="ml-auto flex items-center gap-2">
                    {silosModels.length > 0 && (
                      <span className="px-2 py-0.5 text-xs font-medium rounded bg-primary/20 text-primary">
                        {silosModels.length} model{silosModels.length !== 1 ? 's' : ''}
                      </span>
                    )}
                    <span className="px-2 py-0.5 text-xs font-medium rounded bg-emerald-500/20 text-emerald-600 dark:text-emerald-400">Active</span>
                    <ChevronDown className={`w-4 h-4 text-muted-foreground transition-transform ${silosExpanded ? 'rotate-180' : ''}`} />
                  </div>
                </button>
                {silosExpanded && silosModels.length > 0 && (
                  <div className="border-t border-primary/20 px-4 py-3">
                    <div className="space-y-1 max-h-64 overflow-y-auto">
                      {silosModels.map((model) => (
                        <div key={model.id} className="flex items-center justify-between py-1.5 px-2 rounded-lg hover:bg-muted/40">
                          <div className="flex items-center gap-2">
                            <Cpu className="w-3.5 h-3.5 text-primary" />
                            <span className="text-sm text-foreground">{model.name || model.id}</span>
                          </div>
                          <div className="flex items-center gap-2">
                            {(() => { const ctx = resolveContextWindow('silos', model.id, model.contextWindow); return ctx ? <span className="text-[10px] text-muted-foreground">{Math.round(ctx / 1000)}k ctx</span> : null; })()}
                            <code className="text-[10px] text-muted-foreground font-mono">{model.id}</code>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            );
          })()}

          {/* Backend Providers from Config */}
          {Object.keys(providers).length > 0 ? (
            Object.entries(providers).map(([providerId, providerData]) => {
              const provider = providerData as { baseUrl?: string; apiKey?: string; api?: string; models?: Array<{ id: string; name?: string; contextWindow?: number; reasoning?: boolean; input?: string[] }> };
              const isExpanded = expandedProvider === providerId;
              const modelCount = availableModels?.[providerId]?.length || provider.models?.length || 0;
              const isSilos = providerId.toLowerCase() === 'silos';

              // Silos from backend: show subscription card with collapsible model list
              if (isSilos) {
                const fetchedModels = availableModels?.['silos'] ?? [];
                const dynamicSilosModels = dynamicModels?.models?.filter(m => m.provider === 'silos') ?? [];
                const staticModels = provider.models?.map(m => ({ id: m.id, name: m.name || m.id, contextWindow: m.contextWindow })) ?? [];
                const silosModels = fetchedModels.length > 0 ? fetchedModels : dynamicSilosModels.length > 0 ? dynamicSilosModels : staticModels;
                const silosExpanded = expandedProvider === 'silos';
                return (
                  <div key={providerId} className="rounded-xl border border-primary/20 overflow-hidden bg-gradient-to-r from-primary/5 to-primary/3">
                    <button
                      onClick={() => setExpandedProvider(silosExpanded ? null : 'silos')}
                      className="w-full flex items-center gap-3 p-4 hover:bg-muted/40 transition-colors"
                    >
                      <span className="flex items-center justify-center w-8 h-8">{getProviderIcon('silos')}</span>
                      <div className="text-left">
                        <h3 className="font-semibold text-foreground">Silos Subscription</h3>
                        <p className="text-xs text-muted-foreground">Included with your Silos plan</p>
                      </div>
                      <div className="ml-auto flex items-center gap-2">
                        <span className="px-2 py-0.5 text-xs font-medium rounded bg-primary/20 text-primary">
                          {silosModels.length} model{silosModels.length !== 1 ? 's' : ''}
                        </span>
                        <span className="px-2 py-0.5 text-xs font-medium rounded bg-emerald-500/20 text-emerald-600 dark:text-emerald-400">Active</span>
                        <ChevronDown className={`w-4 h-4 text-muted-foreground transition-transform ${silosExpanded ? 'rotate-180' : ''}`} />
                      </div>
                    </button>
                    {silosExpanded && silosModels.length > 0 && (
                      <div className="border-t border-primary/20 px-4 py-3">
                        <div className="space-y-1 max-h-64 overflow-y-auto">
                          {silosModels.map((model) => (
                            <div key={model.id} className="flex items-center justify-between py-1.5 px-2 rounded-lg hover:bg-muted/40">
                              <div className="flex items-center gap-2">
                                <Cpu className="w-3.5 h-3.5 text-primary" />
                                <span className="text-sm text-foreground">{model.name || model.id}</span>
                              </div>
                              <div className="flex items-center gap-2">
                                {model.contextWindow && (
                                  <span className="text-[10px] text-muted-foreground">{Math.round(model.contextWindow / 1000)}k ctx</span>
                                )}
                                <code className="text-[10px] text-muted-foreground font-mono">{model.id}</code>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                );
              }

              return (
                <div key={providerId} className="rounded-xl border overflow-hidden bg-card">
                  <button
                    onClick={() => setExpandedProvider(isExpanded ? null : providerId)}
                    className="w-full flex items-center justify-between p-4 hover:bg-muted transition-colors"
                  >
                    <div className="flex items-center gap-3">
                      <span className="flex items-center justify-center w-8 h-8">{getProviderIcon(providerId)}</span>
                      <div className="text-left">
                        <h3 className="font-semibold text-foreground">{providersWithAuthProfile.has(providerId.toLowerCase()) && providerId.toLowerCase() === 'anthropic' ? 'Claude Subscription' : providerId}</h3>
                        <p className="text-xs text-muted-foreground">{provider.baseUrl || 'Default'}</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="px-2 py-0.5 text-xs font-medium rounded bg-primary/20 text-primary">
                        {modelCount} model{modelCount !== 1 ? 's' : ''}
                      </span>
                      <span className={cn(
                        "px-2 py-0.5 text-xs font-medium rounded",
                        (provider.apiKey || providersWithAuthProfile.has(providerId.toLowerCase()))
                          ? "bg-emerald-500/20 text-emerald-600 dark:text-emerald-400"
                          : "bg-amber-500/20 text-amber-600 dark:text-amber-400"
                      )}>
                        {provider.apiKey ? 'Configured' : providersWithAuthProfile.has(providerId.toLowerCase()) ? 'Subscription' : 'No Key'}
                      </span>
                      <ChevronRight className={cn("w-4 h-4 text-muted-foreground transition-transform", isExpanded && "rotate-90")} />
                    </div>
                  </button>

                  {isExpanded && (
                    <div className="border-t p-4 space-y-4">
                      {editingProvider === providerId ? (
                        /* Edit Mode */
                        <>
                          {/* API Type */}
                          <div>
                            <label className="text-xs font-bold text-muted-foreground uppercase tracking-wider mb-1.5 block">API Type</label>
                            <div className="flex flex-wrap gap-2">
                              {[
                                { value: 'openai-completions', label: 'OpenAI Compatible' },
                                { value: 'anthropic-messages', label: 'Anthropic' },
                                { value: 'google-generative-ai', label: 'Google' },
                              ].map((opt) => (
                                <button
                                  key={opt.value}
                                  onClick={() => { setEditProvider({ ...editProvider, api: opt.value }); setEditTestResult(null); }}
                                  className={cn(
                                    "px-3 py-1.5 text-xs rounded-lg border transition-colors",
                                    editProvider.api === opt.value
                                      ? "bg-primary/20 text-primary border-primary/40"
                                      : "bg-muted text-muted-foreground border hover:border-foreground/20"
                                  )}
                                >
                                  {opt.label}
                                </button>
                              ))}
                            </div>
                          </div>
                          <div className="grid grid-cols-2 gap-3">
                            <div>
                              <label className="text-xs font-bold text-muted-foreground uppercase tracking-wider mb-1 block">Base URL</label>
                              <input
                                type="text"
                                autoComplete="off"
                                placeholder={t('settings.providers.baseUrl')}
                                value={editProvider.baseUrl}
                                onChange={(e) => { setEditProvider({ ...editProvider, baseUrl: e.target.value }); setEditTestResult(null); }}
                                className="w-full px-3 py-2 rounded-lg bg-muted border text-foreground text-sm font-mono focus:outline-none focus:border-ring"
                              />
                            </div>
                            <div>
                              <label className="text-xs font-bold text-muted-foreground uppercase tracking-wider mb-1 block">API Key</label>
                              <input
                                type="password"
                                autoComplete="new-password"
                                placeholder={t('settings.providers.apiKey')}
                                value={editProvider.apiKey}
                                onChange={(e) => { setEditProvider({ ...editProvider, apiKey: e.target.value }); setEditTestResult(null); }}
                                className="w-full px-3 py-2 rounded-lg bg-muted border text-foreground text-sm font-mono focus:outline-none focus:border-ring"
                              />
                            </div>
                          </div>
                          {/* Test Connection */}
                          <div className="flex items-center gap-2">
                            <button
                              disabled={!editProvider.baseUrl || editTesting}
                              onClick={async () => {
                                setEditTesting(true);
                                setEditTestResult(null);
                                try {
                                  const isAnthropic = editProvider.api === 'anthropic-messages';
                                  const targetHeaders: Record<string, string> = {};
                                  if (editProvider.apiKey) {
                                    if (isAnthropic) {
                                      targetHeaders['x-api-key'] = editProvider.apiKey;
                                      targetHeaders['anthropic-version'] = '2023-06-01';
                                    } else {
                                      targetHeaders['Authorization'] = `Bearer ${editProvider.apiKey}`;
                                    }
                                  }
                                  const targetUrl = `${editProvider.baseUrl.replace(/\/+$/, '')}/models`;
                                  const editProxyHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
                                  if (gatewayToken) editProxyHeaders['Authorization'] = `Bearer ${gatewayToken}`;
                                  const response = await fetch('/api/proxy-test', {
                                    method: 'POST',
                                    headers: editProxyHeaders,
                                    body: JSON.stringify({ url: targetUrl, headers: targetHeaders }),
                                  });
                                  const result = await response.json();
                                  if (result.error) throw new Error(result.error);
                                  if (!result.ok) throw new Error(`HTTP ${result.status}: ${(result.body || '').slice(0, 200)}`);
                                  const data = JSON.parse(result.body);
                                  const rawModels: Array<{ id: string; context_window?: number; context_length?: number; max_model_len?: number }> =
                                    Array.isArray(data?.data) ? data.data : Array.isArray(data) ? data : [];
                                  const fetchedModels: ModelDef[] = rawModels.map(m => ({
                                    id: m.id, name: m.id,
                                    contextWindow: m.context_window || m.context_length || m.max_model_len || 0,
                                    reasoning: /^o[0-9]|reason|think/i.test(m.id),
                                  }));
                                  if (fetchedModels.length > 0) {
                                    setEditProvider(prev => ({ ...prev, models: fetchedModels }));
                                  }
                                  setEditTestResult({ ok: true, models: fetchedModels });
                                } catch (err: unknown) {
                                  setEditTestResult({ ok: false, error: String(err instanceof Error ? err.message : err) });
                                } finally {
                                  setEditTesting(false);
                                }
                              }}
                              className={cn(
                                "flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg transition-colors",
                                editProvider.baseUrl && !editTesting
                                  ? "bg-primary/20 text-primary border border-primary/20 hover:bg-primary/20"
                                  : "bg-muted text-muted-foreground cursor-not-allowed"
                              )}
                            >
                              {editTesting ? (
                                <><div className="w-3 h-3 border-2 border-primary/40 border-t-transparent rounded-full animate-spin" /> Testing...</>
                              ) : (
                                <><Zap className="w-3.5 h-3.5" /> Test Connection</>
                              )}
                            </button>
                            {editTestResult && !editTestResult.ok && (
                              <span className="text-xs text-red-600 dark:text-red-400">{editTestResult.error}</span>
                            )}
                            {editTestResult?.ok && (
                              <span className="text-xs text-emerald-600 dark:text-emerald-400 flex items-center gap-1">
                                <Check className="w-3 h-3" /> {editTestResult.models?.length || 0} models found
                              </span>
                            )}
                          </div>
                          {/* Models preview */}
                          {editTestResult?.ok && editTestResult.models && editTestResult.models.length > 0 && (
                            <div>
                              <label className="text-xs font-bold text-muted-foreground uppercase tracking-wider mb-1 block">Models ({editTestResult.models.length})</label>
                              <div className="max-h-32 overflow-y-auto space-y-0.5">
                                {editTestResult.models.map(m => (
                                  <div key={m.id} className="text-[11px] font-mono text-muted-foreground px-2 py-0.5 rounded bg-muted">
                                    {m.id}
                                  </div>
                                ))}
                              </div>
                            </div>
                          )}
                          <div className="flex justify-end gap-2">
                            <button
                              onClick={() => { setEditingProvider(null); setEditTestResult(null); }}
                              className="px-3 py-1.5 text-xs font-semibold rounded-lg bg-muted text-muted-foreground hover:bg-muted"
                            >
                              Cancel
                            </button>
                            <button
                              disabled={editSaving || !editTestResult?.ok}
                              onClick={async () => {
                                setEditSaving(true);
                                const success = await addModelProvider(providerId, {
                                  baseUrl: editProvider.baseUrl,
                                  apiKey: editProvider.apiKey || undefined,
                                  api: editProvider.api,
                                  models: editProvider.models,
                                });
                                setEditSaving(false);
                                if (success) { setEditingProvider(null); setEditTestResult(null); }
                              }}
                              className={cn(
                                "px-3 py-1.5 text-xs font-semibold rounded-lg flex items-center gap-1.5",
                                !editSaving && editTestResult?.ok
                                  ? "bg-primary/20 text-primary hover:bg-primary/40"
                                  : "bg-muted text-muted-foreground cursor-not-allowed"
                              )}
                            >
                              {editSaving && <div className="w-3 h-3 border-2 border-primary/40 border-t-transparent rounded-full animate-spin" />}
                              {editSaving ? 'Saving...' : 'Save'}
                            </button>
                          </div>
                        </>
                      ) : (
                        /* View Mode */
                        <>
                          <div className="grid grid-cols-2 gap-4">
                            <div>
                              <label className="text-xs font-bold text-muted-foreground uppercase tracking-wider mb-1 block">Base URL</label>
                              <code className="text-xs text-muted-foreground font-mono">{provider.baseUrl}</code>
                            </div>
                            <div>
                              <label className="text-xs font-bold text-muted-foreground uppercase tracking-wider mb-1 block">API Key</label>
                              <div className="flex items-center gap-2">
                                <code className="text-xs text-muted-foreground font-mono">
                                  {showApiKey[providerId] ? provider.apiKey : (provider.apiKey ? '••••••••' : providersWithAuthProfile.has(providerId.toLowerCase()) ? 'Via subscription token' : '(not set)')}
                                </code>
                                {provider.apiKey && (
                                  <button onClick={() => setShowApiKey(prev => ({ ...prev, [providerId]: !prev[providerId] }))}>
                                    {showApiKey[providerId] ? <EyeOff className="w-3 h-3 text-muted-foreground" /> : <Eye className="w-3 h-3 text-muted-foreground" />}
                                  </button>
                                )}
                              </div>
                            </div>
                          </div>

                          {(() => {
                            const displayModels = availableModels?.[providerId]?.length
                              ? availableModels[providerId]
                              : provider.models ?? [];
                            return displayModels.length > 0 ? (
                            <div>
                              <label className="text-xs font-bold text-muted-foreground uppercase tracking-wider mb-2 block">Models ({displayModels.length})</label>
                              <div className="grid gap-1 max-h-60 overflow-y-auto">
                                {displayModels.map((model) => (
                                  <div key={model.id} className="flex items-center justify-between px-3 py-2 rounded-lg bg-muted">
                                    <div className="flex items-center gap-2">
                                      <span className="text-sm text-foreground">{model.name || model.id}</span>
                                    </div>
                                    <span className="text-xs text-muted-foreground">{(() => { const ctx = resolveContextWindow(providerId, model.id, model.contextWindow); return ctx ? `${Math.round(ctx / 1000)}K` : ''; })()}</span>
                                  </div>
                                ))}
                              </div>
                            </div>
                            ) : null;
                          })()}

                          {/* Edit / Delete actions */}
                          <div className="flex items-center justify-end gap-2 pt-3 border-t">
                            <button
                              onClick={() => {
                                setEditingProvider(providerId);
                                setEditTestResult(null);
                                setEditProvider({
                                  baseUrl: provider.baseUrl || '',
                                  apiKey: provider.apiKey || '',
                                  api: provider.api || 'openai-completions',
                                  models: provider.models?.map(m => ({
                                    id: m.id,
                                    name: m.name || m.id,
                                    contextWindow: m.contextWindow || 0,
                                    reasoning: m.reasoning,
                                  })),
                                });
                              }}
                              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg bg-muted text-foreground hover:bg-accent transition-colors"
                            >
                              <Edit3 className="w-3 h-3" /> Edit
                            </button>
                            <button
                              disabled={deletingProvider === providerId}
                              onClick={async () => {
                                if (!confirm(`Delete provider "${providerId}"? The gateway will restart.`)) return;
                                setDeletingProvider(providerId);
                                await deleteModelProvider(providerId);
                                setDeletingProvider(null);
                                setExpandedProvider(null);
                              }}
                              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg text-red-600 dark:text-red-400 hover:bg-red-500/10 transition-colors"
                            >
                              {deletingProvider === providerId ? (
                                <><div className="w-3 h-3 border-2 border-red-400 border-t-transparent rounded-full animate-spin" /> Deleting...</>
                              ) : (
                                <><Trash2 className="w-3 h-3" /> Delete</>
                              )}
                            </button>
                          </div>
                        </>
                      )}
                    </div>
                  )}
                </div>
              );
            })
          ) : !hasSilosFromBackend ? null : (
            <div className="p-6 text-center rounded-xl bg-card border border-dashed">
              <p className="text-sm text-muted-foreground">No additional providers configured</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
