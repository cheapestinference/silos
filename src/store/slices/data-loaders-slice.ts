import type { StoreSet, StoreGet } from '../store-types';

export function createDataLoadersSlice(set: StoreSet, get: StoreGet) {
  return {
    agents: null,
    sessions: null,
    models: null,
    availableModels: null,
    gatewayConfig: null,
    channels: null,
    presence: [] as any[],
    agentsLoading: false,
    sessionsLoading: false,
    cronLoading: false,
    channelsLoading: false,
    modelsLoading: false,
    availableModelsLoading: false,
    gatewayConfigLoading: false,

    loadAgents: async () => {
      const { client } = get();
      if (!client) return;
      set({ agentsLoading: true });
      try {
        const agents = await client.listAgents();
        const current = get().agents;
        if (agents.agents.length === 0 && current?.agents && current.agents.length > 0) {
          set({ agentsLoading: false });
          return;
        }
        set({ agents, agentsLoading: false });
      } catch (error) {
        set({ agentsLoading: false, error: String(error) });
      }
    },

    loadSessions: async () => {
      const { client, sessions: currentSessions } = get();
      if (!client) return;
      set({ sessionsLoading: true });
      try {
        const loadedSessions = await client.listSessions({ limit: 100, includeGlobal: true, includeDerivedTitles: true });
        const localSessionMap = new Map(
          currentSessions?.sessions.map(s => [s.key, s]) || []
        );
        const mergedBackendSessions = loadedSessions.sessions.map(backendSession => {
          const localSession = localSessionMap.get(backendSession.key);
          if (localSession) {
            return {
              ...backendSession,
              label: backendSession.label || localSession.label,
              displayName: backendSession.displayName || localSession.displayName,
            };
          }
          return backendSession;
        });
        const loadedKeys = new Set(loadedSessions.sessions.map(s => s.key));
        const optimisticSessions = currentSessions?.sessions.filter(
          s => !loadedKeys.has(s.key)
        ) || [];
        const mergedSessions = {
          ...loadedSessions,
          sessions: [...mergedBackendSessions, ...optimisticSessions],
          count: loadedSessions.count + optimisticSessions.length,
        };
        const cumTokens = new Map(get().sessionCumulativeTokens);
        for (const s of mergedBackendSessions) {
          const input = s.inputTokens || 0;
          const output = s.outputTokens || 0;
          const runTotal = input + output;
          const prev = cumTokens.get(s.key);
          if (!prev) {
            cumTokens.set(s.key, { total: runTotal, lastInput: input, lastOutput: output });
          } else if (input !== prev.lastInput || output !== prev.lastOutput) {
            cumTokens.set(s.key, { total: prev.total + runTotal, lastInput: input, lastOutput: output });
          }
        }
        try { localStorage.setItem('silos:cumTokens', JSON.stringify([...cumTokens])); } catch { /* quota */ }
        set({ sessions: mergedSessions, sessionsLoading: false, sessionCumulativeTokens: cumTokens });
      } catch (error) {
        set({ sessionsLoading: false, error: String(error) });
      }
    },

    loadCronJobs: async () => {
      const { client } = get();
      if (!client) return;
      set({ cronLoading: true });
      try {
        const [jobsResult, status] = await Promise.all([
          client.listCronJobs(),
          client.getCronStatus(),
        ]);
        set({ cronJobs: jobsResult.jobs || [], cronStatus: status, cronLoading: false });
      } catch (error) {
        console.error('[loadCronJobs] Error:', error);
        set({ cronLoading: false, error: String(error) });
      }
    },

    loadChannels: async () => {
      const { client } = get();
      if (!client) return;
      set({ channelsLoading: true });
      try {
        const channels = await client.getChannelsStatus();
        set({ channels, channelsLoading: false });
      } catch (error) {
        set({ channelsLoading: false, error: String(error) });
      }
    },

    loadModels: async () => {
      const { client } = get();
      if (!client) return;
      set({ modelsLoading: true });
      try {
        const models = await client.listModels();
        set({ models, modelsLoading: false });
      } catch (error) {
        set({ modelsLoading: false, error: String(error) });
      }
    },

    loadAvailableModels: async () => {
      const { token } = get();
      set({ availableModelsLoading: true });
      try {
        const headers: Record<string, string> = {};
        if (token) headers['Authorization'] = `Bearer ${token}`;
        const res = await fetch('/api/provider-models', { headers });
        if (res.ok) {
          const data = await res.json();
          set({ availableModels: data, availableModelsLoading: false });
        } else {
          set({ availableModelsLoading: false });
        }
      } catch {
        set({ availableModelsLoading: false });
      }
    },

    loadGatewayConfig: async () => {
      const { client } = get();
      if (!client) return;
      set({ gatewayConfigLoading: true });
      try {
        const gatewayConfig = await client.getConfig();
        set({ gatewayConfig, gatewayConfigLoading: false });
      } catch (error) {
        set({ gatewayConfigLoading: false, error: String(error) });
      }
    },

    patchGatewayConfig: async (patch: Record<string, unknown>) => {
      const { client, loadGatewayConfig } = get();
      if (!client) return false;
      try {
        const currentConfig = await client.getConfig();
        if (!currentConfig.valid) {
          set({ error: 'Invalid config state' });
          return false;
        }
        const result = await client.patchConfig(currentConfig.hash, patch);
        if (result.ok) {
          loadGatewayConfig().catch(() => { });
          return true;
        } else {
          set({ error: 'Failed to patch config' });
          return false;
        }
      } catch (error) {
        set({ error: String(error) });
        return false;
      }
    },

    addModelProvider: async (providerId: string, config: { baseUrl: string; apiKey?: string; api?: string; models?: Array<{ id: string; name: string; contextWindow: number; reasoning?: boolean }> }) => {
      const { client, loadGatewayConfig } = get();
      if (!client) return false;
      try {
        const currentConfig = await client.getConfig();
        if (!currentConfig.valid) {
          set({ error: 'Invalid config state' });
          return false;
        }
        const modelsConfig = (config.models || []).map(m => ({
          id: m.id,
          name: m.name,
          reasoning: m.reasoning ?? false,
          input: ['text'] as ('text' | 'image')[],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: m.contextWindow || undefined,
          maxTokens: m.contextWindow ? Math.min(m.contextWindow, 16384) : 16384,
          compat: { supportsUsageInStreaming: true },
        }));
        const patch = {
          models: {
            providers: {
              [providerId]: {
                baseUrl: config.baseUrl,
                ...(config.apiKey && { apiKey: config.apiKey }),
                ...(config.api && { api: config.api }),
                models: modelsConfig,
              },
            },
          },
        };
        const result = await client.patchConfig(currentConfig.hash, patch);
        if (result.ok) {
          loadGatewayConfig().catch(() => { });
          return true;
        } else {
          set({ error: 'Failed to save provider config' });
          return false;
        }
      } catch (error) {
        set({ error: String(error) });
        return false;
      }
    },

    deleteModelProvider: async (providerId: string) => {
      const { client, loadGatewayConfig } = get();
      if (!client) return false;
      try {
        const currentConfig = await client.getConfig();
        if (!currentConfig.valid) {
          set({ error: 'Invalid config state' });
          return false;
        }
        const config = currentConfig.config as Record<string, unknown>;
        const modelsSection = config.models as { providers?: Record<string, unknown> } | undefined;
        const currentProviders = modelsSection?.providers || {};
        if (!(providerId in currentProviders)) {
          set({ error: 'Provider not found in config' });
          return false;
        }
        const patch = {
          models: {
            providers: {
              [providerId]: null,
            },
          },
        };
        const result = await client.patchConfig(currentConfig.hash, patch);
        if (result.ok) {
          loadGatewayConfig().catch(() => { });
          return true;
        } else {
          set({ error: 'Failed to delete provider' });
          return false;
        }
      } catch (error) {
        set({ error: String(error) });
        return false;
      }
    },

    loadAll: async () => {
      const { loadAgents, loadSessions, loadCronJobs, loadChannels, loadModels, loadAvailableModels, loadGatewayConfig } = get();
      await Promise.all([loadAgents(), loadSessions(), loadCronJobs(), loadChannels(), loadModels(), loadGatewayConfig(), loadAvailableModels()]);
    },

    deleteAgent: async (agentId: string) => {
      const { client, loadAgents } = get();
      if (!client) return false;
      try {
        const result = await client.request<{ ok: boolean }>('agents.delete', { agentId });
        if (result.ok) {
          setTimeout(() => loadAgents(), 5000);
          return true;
        }
        set({ error: 'Failed to delete agent' });
        return false;
      } catch (error) {
        set({ error: String(error) });
        return false;
      }
    },

    resetAgent: async (agentId: string) => {
      const { client } = get();
      if (!client) return false;
      try {
        const sessionKey = `agent:${agentId}:main`;
        const result = await client.request<{ ok: boolean }>('sessions.reset', { key: sessionKey });
        return result.ok ?? false;
      } catch (error) {
        set({ error: String(error) });
        return false;
      }
    },
  };
}
