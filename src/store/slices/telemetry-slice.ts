import { generateId } from '../../lib/utils';
import type {
  SessionError,
  LatencyEntry,
  LatencyOutcome,
} from '../../types/openclaw';
import type { StoreSet, StoreGet } from '../store-types';

const MAX_ERRORS_PER_SESSION = 200;
const MAX_LATENCY_PER_SESSION = 200;

interface RunTiming {
  sessionKey: string;
  startedAt: number;
  firstDeltaAt?: number;
  outputChars: number;
  model?: string;
}

export interface TelemetrySlice {
  sessionErrors: Map<string, SessionError[]>;
  latencyEntries: Map<string, LatencyEntry[]>;
  runTimings: Map<string, RunTiming>;
  errorTabBadges: Map<string, number>;
  toolCallCounts: Map<string, number>;

  pushSessionError: (
    sessionKey: string,
    partial: Omit<SessionError, 'id' | 'sessionKey' | 'timestamp'>,
  ) => void;
  clearErrorBadge: (sessionKey: string) => void;
  clearSessionErrors: (sessionKey: string) => void;
  clearSessionLatency: (sessionKey: string) => void;
  incrementToolCallCount: (sessionKey: string) => void;

  markRunStart: (runId: string, sessionKey: string, model?: string) => void;
  markRunFirstDelta: (runId: string) => void;
  accumulateRunChars: (runId: string, chars: number) => void;
  finalizeRunLatency: (
    runId: string,
    outcome: LatencyOutcome,
    model?: string,
  ) => void;
  discardRunTiming: (runId: string) => void;
}

export function createTelemetrySlice(set: StoreSet, get: StoreGet): TelemetrySlice {
  return {
    sessionErrors: new Map<string, SessionError[]>(),
    latencyEntries: new Map<string, LatencyEntry[]>(),
    runTimings: new Map<string, RunTiming>(),
    errorTabBadges: new Map<string, number>(),
    toolCallCounts: new Map<string, number>(),

    pushSessionError: (sessionKey, partial) => {
      set((state) => {
        const existing = state.sessionErrors.get(sessionKey) || [];
        const entry: SessionError = {
          id: generateId(),
          sessionKey,
          timestamp: Date.now(),
          ...partial,
        };
        const updated = [...existing, entry];
        if (updated.length > MAX_ERRORS_PER_SESSION) {
          updated.splice(0, updated.length - MAX_ERRORS_PER_SESSION);
        }
        const newMap = new Map(state.sessionErrors);
        newMap.set(sessionKey, updated);

        const newBadges = new Map(state.errorTabBadges);
        newBadges.set(sessionKey, (newBadges.get(sessionKey) || 0) + 1);

        return { sessionErrors: newMap, errorTabBadges: newBadges };
      });
    },

    clearErrorBadge: (sessionKey) => {
      set((state) => {
        if (!state.errorTabBadges.has(sessionKey)) return state;
        const newBadges = new Map(state.errorTabBadges);
        newBadges.delete(sessionKey);
        return { errorTabBadges: newBadges };
      });
    },

    clearSessionErrors: (sessionKey) => {
      set((state) => {
        const newMap = new Map(state.sessionErrors);
        newMap.delete(sessionKey);
        const newBadges = new Map(state.errorTabBadges);
        newBadges.delete(sessionKey);
        return { sessionErrors: newMap, errorTabBadges: newBadges };
      });
    },

    clearSessionLatency: (sessionKey) => {
      set((state) => {
        const newMap = new Map(state.latencyEntries);
        newMap.delete(sessionKey);
        return { latencyEntries: newMap };
      });
    },

    incrementToolCallCount: (sessionKey) => {
      if (!sessionKey) return;
      set((state) => {
        const newMap = new Map(state.toolCallCounts);
        newMap.set(sessionKey, (newMap.get(sessionKey) || 0) + 1);
        return { toolCallCounts: newMap };
      });
    },

    markRunStart: (runId, sessionKey, model) => {
      if (!runId || !sessionKey) return;
      set((state) => {
        if (state.runTimings.has(runId)) return state;
        const newTimings = new Map(state.runTimings);
        newTimings.set(runId, {
          sessionKey,
          startedAt: Date.now(),
          outputChars: 0,
          model,
        });
        return { runTimings: newTimings };
      });
    },

    markRunFirstDelta: (runId) => {
      if (!runId) return;
      set((state) => {
        const entry = state.runTimings.get(runId);
        if (!entry || entry.firstDeltaAt) return state;
        const newTimings = new Map(state.runTimings);
        newTimings.set(runId, { ...entry, firstDeltaAt: Date.now() });
        return { runTimings: newTimings };
      });
    },

    accumulateRunChars: (runId, chars) => {
      if (!runId || chars <= 0) return;
      set((state) => {
        const entry = state.runTimings.get(runId);
        if (!entry) return state;
        const newTimings = new Map(state.runTimings);
        // Streaming deltas carry the FULL accumulated text, not an incremental chunk
        // (see chat-event-handlers.ts: streamingContent = chatDeltaText). Use max to
        // be safe if a smaller delta somehow arrives after a larger one.
        newTimings.set(runId, {
          ...entry,
          outputChars: Math.max(entry.outputChars, chars),
        });
        return { runTimings: newTimings };
      });
    },

    finalizeRunLatency: (runId, outcome, model) => {
      if (!runId) return;
      const entry = get().runTimings.get(runId);
      if (!entry) return;

      const completedAt = Date.now();
      const latencyMs = completedAt - entry.startedAt;
      const ttfbMs = entry.firstDeltaAt
        ? entry.firstDeltaAt - entry.startedAt
        : undefined;
      const outputChars = entry.outputChars || 0;
      const outputTokens = outputChars > 0 ? Math.round(outputChars / 4) : undefined;
      const genMs = entry.firstDeltaAt ? completedAt - entry.firstDeltaAt : latencyMs;
      const tokensPerSecond =
        outputTokens && genMs > 0
          ? Math.round((outputTokens / genMs) * 1000)
          : undefined;

      const latencyEntry: LatencyEntry = {
        id: generateId(),
        sessionKey: entry.sessionKey,
        runId,
        startedAt: entry.startedAt,
        completedAt,
        latencyMs,
        ttfbMs,
        outputChars: outputChars || undefined,
        outputTokens,
        tokensPerSecond,
        outcome,
        model: model || entry.model,
      };

      set((state) => {
        const existing = state.latencyEntries.get(entry.sessionKey) || [];
        const updated = [...existing, latencyEntry];
        if (updated.length > MAX_LATENCY_PER_SESSION) {
          updated.splice(0, updated.length - MAX_LATENCY_PER_SESSION);
        }
        const newMap = new Map(state.latencyEntries);
        newMap.set(entry.sessionKey, updated);

        const newTimings = new Map(state.runTimings);
        newTimings.delete(runId);

        return { latencyEntries: newMap, runTimings: newTimings };
      });
    },

    discardRunTiming: (runId) => {
      if (!runId) return;
      set((state) => {
        if (!state.runTimings.has(runId)) return state;
        const newTimings = new Map(state.runTimings);
        newTimings.delete(runId);
        return { runTimings: newTimings };
      });
    },
  };
}
