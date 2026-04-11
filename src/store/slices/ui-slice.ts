import type { StoreSet, StoreGet } from '../store-types';

export function createUiSlice(set: StoreSet, _get: StoreGet) {
  return {
    unreadCounts: new Map<string, number>(),
    browserPanelOpen: false,
    browserDetached: 'none' as 'none' | 'overlay' | 'popout',
    browserAgentAction: null as string | null,

    markSessionRead: (sessionKey: string) => {
      set((state) => {
        const newCounts = new Map(state.unreadCounts);
        newCounts.delete(sessionKey);
        return { unreadCounts: newCounts };
      });
    },

    incrementUnread: (sessionKey: string) => {
      set((state) => {
        const newCounts = new Map(state.unreadCounts);
        const current = newCounts.get(sessionKey) || 0;
        newCounts.set(sessionKey, current + 1);
        return { unreadCounts: newCounts };
      });
    },

    clearAllUnread: () => {
      set({ unreadCounts: new Map() });
    },

    setBrowserPanelOpen: (open: boolean) => set({
      browserPanelOpen: open,
      ...(open === false ? { browserDetached: 'none' as const } : {}),
    }),
    setBrowserDetached: (mode: 'none' | 'overlay' | 'popout') => set({ browserDetached: mode }),
    setBrowserAgentAction: (action: string | null) => set({ browserAgentAction: action }),
  };
}
