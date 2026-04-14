import { generateId } from '../../lib/utils';
import type {
  SessionError,
  LatencyEntry,
  LatencyOutcome,
} from '../../types/openclaw';
import type { StoreSet, StoreGet } from '../store-types';

const MAX_ERRORS_PER_SESSION = 200;
const MAX_LATENCY_PER_SESSION = 200;
/**
 * Gaps between assistant text deltas longer than this are counted as
 * non-streaming time (tool execution, model wait). 1s is a pragmatic
 * threshold — real streaming typically delivers tokens at 10-100 Hz.
 */
const STREAMING_GAP_THRESHOLD_MS = 1_000;

interface RunTiming {
  sessionKey: string;
  startedAt: number;
  firstDeltaAt?: number;
  lastDeltaAt?: number;
  outputChars: number;
  toolCallCount: number;
  seenToolCallIds: Set<string>;
  toolTimeMs: number;
  model?: string;
}

export interface TelemetrySlice {
  sessionErrors: Map<string, SessionError[]>;
  latencyEntries: Map<string, LatencyEntry[]>;
  runTimings: Map<string, RunTiming>;
  errorTabBadges: Map<string, number>;
  toolCallCounts: Map<string, number>;
  /** Timestamp of last observed agent activity (tool event / delta) per session.
   *  Used to detect "agent is working" even when OpenClaw has momentarily cleared
   *  the run ID (e.g. during compaction retry after a context overflow). */
  lastAgentActivity: Map<string, number>;
  /** Last runId we saw activity on, for abort fallback when activeRunId is empty. */
  lastKnownRunId: Map<string, string>;

  pushSessionError: (
    sessionKey: string,
    partial: Omit<SessionError, 'id' | 'sessionKey' | 'timestamp'>,
  ) => void;
  clearErrorBadge: (sessionKey: string) => void;
  clearSessionErrors: (sessionKey: string) => void;
  clearSessionLatency: (sessionKey: string) => void;
  incrementToolCallCount: (sessionKey: string) => void;
  /** Mark that we observed agent activity — keeps the "working" signal alive. */
  recordAgentActivity: (sessionKey: string, runId?: string) => void;

  markRunStart: (runId: string, sessionKey: string, model?: string) => void;
  markRunFirstDelta: (runId: string) => void;
  accumulateRunChars: (runId: string, chars: number) => void;
  /** Record each assistant text delta for gap/tool-time tracking. */
  recordRunDelta: (runId: string) => void;
  /** Record a tool call dispatched within a run (deduped by toolCallId). */
  recordRunToolCall: (runId: string, toolCallId?: string) => void;
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
    lastAgentActivity: new Map<string, number>(),
    lastKnownRunId: new Map<string, string>(),

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

    recordAgentActivity: (sessionKey, runId) => {
      if (!sessionKey) return;
      set((state) => {
        const newActivity = new Map(state.lastAgentActivity);
        newActivity.set(sessionKey, Date.now());
        const patch: any = { lastAgentActivity: newActivity };
        if (runId) {
          const newRun = new Map(state.lastKnownRunId);
          newRun.set(sessionKey, runId);
          patch.lastKnownRunId = newRun;
        }
        return patch;
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
          toolCallCount: 0,
          seenToolCallIds: new Set(),
          toolTimeMs: 0,
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

    recordRunDelta: (runId) => {
      if (!runId) return;
      set((state) => {
        const entry = state.runTimings.get(runId);
        if (!entry) return state;
        const now = Date.now();
        let toolTimeMs = entry.toolTimeMs;
        if (entry.lastDeltaAt !== undefined) {
          const gap = now - entry.lastDeltaAt;
          // Gaps > threshold are almost always tool execution or model stalls;
          // they shouldn't count toward the "streaming rate" denominator.
          if (gap > STREAMING_GAP_THRESHOLD_MS) {
            toolTimeMs += gap;
          }
        }
        const newTimings = new Map(state.runTimings);
        newTimings.set(runId, { ...entry, lastDeltaAt: now, toolTimeMs });
        return { runTimings: newTimings };
      });
    },

    recordRunToolCall: (runId, toolCallId) => {
      if (!runId) return;
      set((state) => {
        const entry = state.runTimings.get(runId);
        if (!entry) return state;
        // Dedupe by toolCallId when available (gateways may emit call/input/start
        // phases for a single invocation). Without an id, count every event.
        if (toolCallId) {
          if (entry.seenToolCallIds.has(toolCallId)) return state;
          const newSeen = new Set(entry.seenToolCallIds);
          newSeen.add(toolCallId);
          const newTimings = new Map(state.runTimings);
          newTimings.set(runId, {
            ...entry,
            toolCallCount: entry.toolCallCount + 1,
            seenToolCallIds: newSeen,
          });
          return { runTimings: newTimings };
        }
        const newTimings = new Map(state.runTimings);
        newTimings.set(runId, { ...entry, toolCallCount: entry.toolCallCount + 1 });
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

      // Active streaming time = total generation window minus non-streaming gaps
      // (tool execution, model stalls). Floor at 1ms to avoid divide-by-zero.
      const activeGenMs = Math.max(1, genMs - entry.toolTimeMs);
      const effectiveTokensPerSecond =
        outputTokens && activeGenMs > 0
          ? Math.round((outputTokens / activeGenMs) * 1000)
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
        effectiveTokensPerSecond,
        toolCallCount: entry.toolCallCount || undefined,
        toolTimeMs: entry.toolTimeMs > 0 ? entry.toolTimeMs : undefined,
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
