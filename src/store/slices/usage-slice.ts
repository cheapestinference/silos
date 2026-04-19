import type {
  UsageCostSummary,
  SessionsUsageResult,
  SessionUsageTimeseries,
} from '../../types/openclaw';
import type { StoreSet, StoreGet } from '../store-types';

// Phase 5 — usage data loaders. Payloads are cached in-memory with a short
// TTL so navigating between tabs doesn't refetch every time. Dates are
// ISO YYYY-MM-DD strings per gateway schema.

const CACHE_TTL_MS = 30_000;

function isoDateNDaysAgo(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

function isoDateToday(): string {
  return new Date().toISOString().slice(0, 10);
}

export interface UsageSlice {
  usageCostSummary: UsageCostSummary | null;
  usageCostLoading: boolean;
  usageCostUpdatedAt: number;
  sessionsUsage: SessionsUsageResult | null;
  sessionsUsageLoading: boolean;
  sessionsUsageUpdatedAt: number;
  sessionUsageTimeseries: Map<string, SessionUsageTimeseries>;
  sessionUsageTimeseriesLoading: Map<string, boolean>;

  loadUsageCost: (opts?: { days?: number; force?: boolean }) => Promise<void>;
  loadSessionsUsage: (opts?: { days?: number; limit?: number; force?: boolean }) => Promise<void>;
  loadSessionUsageTimeseries: (key: string, opts?: { force?: boolean }) => Promise<void>;
}

export function createUsageSlice(set: StoreSet, get: StoreGet): UsageSlice {
  return {
    usageCostSummary: null,
    usageCostLoading: false,
    usageCostUpdatedAt: 0,
    sessionsUsage: null,
    sessionsUsageLoading: false,
    sessionsUsageUpdatedAt: 0,
    sessionUsageTimeseries: new Map<string, SessionUsageTimeseries>(),
    sessionUsageTimeseriesLoading: new Map<string, boolean>(),

    loadUsageCost: async (opts) => {
      const { client, usageCostLoading, usageCostUpdatedAt } = get();
      if (!client) return;
      const force = opts?.force === true;
      if (!force && usageCostLoading) return;
      if (!force && Date.now() - usageCostUpdatedAt < CACHE_TTL_MS) return;

      set({ usageCostLoading: true });
      try {
        const days = opts?.days ?? 30;
        const result = await client.getUsageCost({ days });
        set({
          usageCostSummary: result,
          usageCostLoading: false,
          usageCostUpdatedAt: Date.now(),
        });
      } catch (error) {
        console.warn('[UsageCost] failed:', error);
        set({ usageCostLoading: false });
      }
    },

    loadSessionsUsage: async (opts) => {
      const { client, sessionsUsageLoading, sessionsUsageUpdatedAt } = get();
      if (!client) return;
      const force = opts?.force === true;
      if (!force && sessionsUsageLoading) return;
      if (!force && Date.now() - sessionsUsageUpdatedAt < CACHE_TTL_MS) return;

      set({ sessionsUsageLoading: true });
      try {
        const days = opts?.days ?? 30;
        const limit = opts?.limit ?? 100;
        const result = await client.getSessionsUsage({
          startDate: isoDateNDaysAgo(days),
          endDate: isoDateToday(),
          limit,
        });
        set({
          sessionsUsage: result,
          sessionsUsageLoading: false,
          sessionsUsageUpdatedAt: Date.now(),
        });
      } catch (error) {
        console.warn('[SessionsUsage] failed:', error);
        set({ sessionsUsageLoading: false });
      }
    },

    loadSessionUsageTimeseries: async (key, opts) => {
      const { client, sessionUsageTimeseriesLoading, sessionUsageTimeseries } = get();
      if (!client || !key) return;
      const force = opts?.force === true;
      if (!force && sessionUsageTimeseriesLoading.get(key) === true) return;
      if (!force && sessionUsageTimeseries.has(key)) return;

      const nextLoading = new Map(sessionUsageTimeseriesLoading);
      nextLoading.set(key, true);
      set({ sessionUsageTimeseriesLoading: nextLoading });
      try {
        const result = await client.getSessionUsageTimeseries(key);
        const nextMap = new Map(get().sessionUsageTimeseries);
        nextMap.set(key, result);
        const cleared = new Map(get().sessionUsageTimeseriesLoading);
        cleared.delete(key);
        set({
          sessionUsageTimeseries: nextMap,
          sessionUsageTimeseriesLoading: cleared,
        });
      } catch (error) {
        console.warn('[SessionUsageTimeseries] failed:', error);
        const cleared = new Map(get().sessionUsageTimeseriesLoading);
        cleared.delete(key);
        set({ sessionUsageTimeseriesLoading: cleared });
      }
    },
  };
}
