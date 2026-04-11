import { createGatewayClient } from '../../lib/gateway-client';
import { applyTheme } from '../../lib/themes';
import type { StoreSet, StoreGet } from '../store-types';

export function createConnectionSlice(set: StoreSet, get: StoreGet) {
  return {
    _hydrated: false,
    connected: false,
    connecting: false,
    initialLoading: false,
    error: null as string | null,
    reconnectAttempt: 0,
    gatewayUrl: 'http://127.0.0.1:18789',
    token: null as string | null,
    darkMode: false,
    theme: 'default',
    client: null as any,

    setGatewayUrl: (url: string) => set({ gatewayUrl: url }),
    setToken: (token: string | null) => set({ token }),
    setDarkMode: (dark: boolean) => {
      set({ darkMode: dark });
      if (dark) {
        document.documentElement.classList.add('dark');
      } else {
        document.documentElement.classList.remove('dark');
      }
      applyTheme(get().theme, dark);
    },
    setTheme: (themeId: string) => {
      set({ theme: themeId });
      applyTheme(themeId, get().darkMode);
    },

    connect: () => {
      let { gatewayUrl, token, handleEvent, handleHello } = get();

      const isDev = import.meta.env.DEV;
      const isLocalGateway = gatewayUrl.includes('localhost:18789') || gatewayUrl.includes('127.0.0.1:18789');

      if (isDev && isLocalGateway) {
        const wsProto = window.location.protocol === 'https:' ? 'wss' : 'ws';
        gatewayUrl = `${wsProto}://${window.location.host}/gateway`;
      } else if (window.location.protocol === 'https:' && isLocalGateway) {
        gatewayUrl = `wss://${window.location.host}/gateway`;
      } else if (gatewayUrl.startsWith('http://') || gatewayUrl.startsWith('https://')) {
        gatewayUrl = gatewayUrl.replace(/^https?:\/\//, 'ws://');
        gatewayUrl = gatewayUrl.replace('localhost', '127.0.0.1');
      }

      set({ connecting: true, error: null });

      const client = createGatewayClient({
        url: gatewayUrl,
        token: token ?? undefined,
        onHello: (hello) => {
          set({ connected: true, connecting: false, reconnectAttempt: 0 });
          handleHello(hello);
        },
        onEvent: (event) => {
          handleEvent(event);
        },
        onGap: ({ expected, received }: { expected: number; received: number }) => {
          console.warn(`[gateway] Event gap: expected seq ${expected}, got ${received}`);
          const sk = get().selectedSessionKey;
          if (sk) {
            get().loadChatHistory(sk);
          }
        },
        onClose: ({ code, reason }) => {
          if (code === 1008 && reason?.includes('token mismatch')) {
            const { client } = get();
            client?.stop();
            set({
              connected: false, connecting: false, token: null, client: null,
              agents: null, sessions: null, tasks: [], cronJobs: [], cronStatus: null,
              channels: null, models: null, availableModels: null, gatewayConfig: null,
              error: 'Session expired. Please sign in again.',
            });
            return;
          }
          if (code === 1012) {
            set({ connected: false, connecting: true, error: null });
            return;
          }
          if (code !== 1000) {
            set({ connected: false, connecting: true, initialLoading: false, error: `Connection closed: ${reason || code}` });
          } else {
            set({ connected: false, connecting: false, initialLoading: false });
          }
        },
        onError: (error) => {
          set({ error: error.message });
        },
        onReconnecting: (attempt) => {
          set({ connecting: true, reconnectAttempt: attempt });
        },
      });

      client.start();
      set({ client });
    },

    autoConnect: () => {
      const { connected, connecting, connect } = get();
      if (!connected && !connecting) {
        connect();
      }
    },

    disconnect: () => {
      const { client } = get();
      client?.stop();
      set({
        client: null,
        connected: false,
        connecting: false,
        initialLoading: false,
        error: null,
        token: null,
      });
    },
  };
}
