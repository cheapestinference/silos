import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { applyTheme } from '../lib/themes';
import type { DashboardStore } from './store-types';

// --- Slices ---
import { createConnectionSlice } from './slices/connection-slice';
import { createDataLoadersSlice } from './slices/data-loaders-slice';
import { createSessionSlice } from './slices/session-slice';
import { createChatSlice } from './slices/chat-slice';
import { createCronSlice } from './slices/cron-slice';
import { createTaskSlice } from './slices/task-slice';
import { createFilesSlice } from './slices/files-slice';
import { createUiSlice } from './slices/ui-slice';
import { createEventSlice } from './slices/event-slice';
import { createTelemetrySlice } from './slices/telemetry-slice';
import { createInputHistorySlice } from './slices/input-history-slice';
import { createAttachmentsSlice } from './slices/attachments-slice';
import { createPinnedSlice } from './slices/pinned-slice';
import { createDeletedSlice } from './slices/deleted-slice';
import { createUsageSlice } from './slices/usage-slice';

// Re-export the store interface for consumers that import it
export type { DashboardStore } from './store-types';

// --- Streaming: simple replace model (mirrors OpenClaw Control UI) ---
// Each chat:state='delta' carries the full accumulated text → direct replace into state.
// No intermediate buffer, no RAF batching — React already batches setState calls.

export const useDashboardStore = create<DashboardStore>()(
  persist(
    (set, get) => ({
      ...createConnectionSlice(set, get),
      ...createDataLoadersSlice(set, get),
      ...createSessionSlice(set, get),
      ...createChatSlice(set, get),
      ...createCronSlice(set, get),
      ...createTaskSlice(set, get),
      ...createFilesSlice(set, get),
      ...createUiSlice(set, get),
      ...createEventSlice(set, get),
      ...createTelemetrySlice(set, get),
      ...createInputHistorySlice(set, get),
      ...createAttachmentsSlice(set, get),
      ...createPinnedSlice(set, get),
      ...createDeletedSlice(set, get),
      ...createUsageSlice(set, get),
    }),
    {
      name: 'silos-dashboard',
      partialize: (state) => ({
        gatewayUrl: state.gatewayUrl,
        token: state.token,
        darkMode: state.darkMode,
        theme: state.theme,
        selectedSessionKey: state.selectedSessionKey,
      }),
      onRehydrateStorage: () => () => {
        useDashboardStore.setState({ _hydrated: true });
      },
    }
  )
);

// Initialize dark mode and theme on load
if (typeof window !== 'undefined') {
  const stored = localStorage.getItem('silos-dashboard');
  let isDark = false;
  let themeId = 'default';
  if (stored) {
    try {
      const { state } = JSON.parse(stored);
      isDark = state?.darkMode === true;
      themeId = state?.theme || 'default';
    } catch {
      isDark = false;
    }
  }
  if (isDark) {
    document.documentElement.classList.add('dark');
  }
  if (themeId !== 'default') {
    applyTheme(themeId, isDark);
  }
}
