import type { StoreSet, StoreGet } from '../store-types';

export function createSessionSlice(set: StoreSet, get: StoreGet) {
  return {
    selectedSessionKey: null as string | null,
    selectedAgentId: null as string | null,

    selectSession: (key: string | null) => {
      const { selectedSessionKey, markSessionRead } = get();
      if (key === selectedSessionKey) {
        return;
      }
      const newChatSending = new Map(get().chatSending);
      const newActiveRunId = new Map(get().activeRunId);
      if (selectedSessionKey) {
        newChatSending.delete(selectedSessionKey);
        newActiveRunId.delete(selectedSessionKey);
      }
      set({
        selectedSessionKey: key,
        chatMessages: [],
        chatSending: newChatSending,
        activeRunId: newActiveRunId,
        streamingContent: '',
        streamingRunId: null,
        streamingComplete: false,
      });
      if (key) {
        get().loadChatHistory(key);
        markSessionRead(key);
      }
    },

    deleteSession: async (key: string) => {
      const { client, sessions } = get();
      if (!client) return;
      try {
        await client.deleteSession(key);
        try {
          localStorage.removeItem(`silos:history:${key}`);
        } catch { /* LS errors — ignore */ }
        if (sessions) {
          set({
            sessions: {
              ...sessions,
              sessions: sessions.sessions.filter((s) => s.key !== key),
              count: sessions.count - 1,
            },
          });
        }
        if (get().selectedSessionKey === key) {
          set({ selectedSessionKey: null, chatMessages: [] });
        }
      } catch (error) {
        set({ error: String(error) });
      }
    },

    patchSession: async (key: string, updates: Record<string, unknown>) => {
      const { client } = get();
      if (!client) return;
      try {
        await client.patchSession(key, updates);
      } catch (error) {
        set({ error: String(error) });
      }
    },

    addSessionOptimistic: (key: string, label?: string) => {
      const { sessions } = get();
      if (sessions?.sessions.some(s => s.key === key)) {
        return;
      }
      const newSession = {
        key,
        kind: 'direct' as const,
        label: label || key.split(':').pop() || key,
        updatedAt: Date.now(),
      };
      if (sessions) {
        set({
          sessions: {
            ...sessions,
            sessions: [newSession, ...sessions.sessions],
            count: sessions.count + 1,
          },
        });
      } else {
        set({
          sessions: {
            ts: Date.now(),
            path: '',
            count: 1,
            defaults: { model: null, contextTokens: null },
            sessions: [newSession],
          },
        });
      }
    },
  };
}
