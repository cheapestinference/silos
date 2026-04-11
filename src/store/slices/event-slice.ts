import {
  handleAgentDisplayEvent as _handleAgentDisplayEvent,
  handleChatEvent as _handleChatEvent,
  handleTaskTracking as _handleTaskTracking,
} from '../chat-event-handlers';
import { resolveSessionKey } from '../store-utils';
import type { EventFrame, HelloOk } from '../../types/openclaw';
import type { StoreSet, StoreGet } from '../store-types';

export function createEventSlice(set: StoreSet, get: StoreGet) {
  return {
    handleEvent: (event: EventFrame) => {
      const { selectedSessionKey } = get();
      const storeAccessor = { get, set };

      const currentEffectiveKey = selectedSessionKey
        ? resolveSessionKey(selectedSessionKey)
        : null;

      if (event.event === 'agent') {
        const payload = event.payload as any;
        const shouldTrack = _handleAgentDisplayEvent(storeAccessor, payload, currentEffectiveKey);
        if (shouldTrack) {
          _handleTaskTracking(storeAccessor, payload, selectedSessionKey);
        }
      }

      if (event.event === 'chat') {
        const payload = event.payload as any;
        _handleChatEvent(storeAccessor, payload, currentEffectiveKey);
      }

      if (event.event === 'system-presence') {
        const payload = event.payload as any;
        if (payload?.entries) {
          set({ presence: payload.entries });
        }
      }
    },

    handleHello: (_hello: HelloOk) => {
      const isFirstLoad = !get().agents && !get().sessions;
      set({
        chatSending: new Map(),
        activeRunId: new Map(),
        runHadTools: new Map(),
        streamingContent: '',
        streamingRunId: null,
        streamingComplete: false,
        initialLoading: isFirstLoad,
      });

      const retryLoadIfEmpty = (attemptsLeft: number) => {
        if (attemptsLeft <= 0 || !get().connected) return;
        setTimeout(() => {
          if (!get().connected) return;
          get().loadAll().then(() => {
            const { models, gatewayConfig } = get();
            const hasModels = models?.models && models.models.length > 0;
            const cfg = gatewayConfig?.config as Record<string, unknown> | undefined;
            const providers = (cfg?.models as Record<string, unknown>)?.providers as Record<string, unknown> | undefined;
            const hasProviders = providers && Object.keys(providers).length > 0;
            if (!hasModels || !hasProviders) {
              retryLoadIfEmpty(attemptsLeft - 1);
            }
          }).catch(() => {});
        }, 5000);
      };

      get().loadAll().then(() => {
        set({ initialLoading: false });
        const sk = get().selectedSessionKey;
        if (sk) {
          get().loadChatHistory(sk);
        }
        const { agents, models, gatewayConfig } = get();
        const hasAgents = agents?.agents && agents.agents.length > 0;
        const hasModels = models?.models && models.models.length > 0;
        const cfg = gatewayConfig?.config as Record<string, unknown> | undefined;
        const providers = (cfg?.models as Record<string, unknown>)?.providers as Record<string, unknown> | undefined;
        const hasProviders = providers && Object.keys(providers).length > 0;
        if (!hasAgents || !hasModels || !hasProviders) {
          retryLoadIfEmpty(12);
        }
      }).catch(() => {
        set({ initialLoading: false });
      });
    },
  };
}
