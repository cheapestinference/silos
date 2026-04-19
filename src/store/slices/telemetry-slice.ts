import { generateId } from '../../lib/utils';
import type {
  SessionError,
  LatencyEntry,
  LatencyOutcome,
  CompactionStatus,
  FallbackStatus,
} from '../../types/openclaw';
import type { StoreSet, StoreGet } from '../store-types';

const MAX_ERRORS_PER_SESSION = 200;
const MAX_LATENCY_PER_SESSION = 200;
/**
 * Gaps between assistant text deltas longer than this are counted as
 * non-streaming time (tool execution, model wait). Batched-delta providers
 * like MiniMax emit updates every 2s even during steady generation, so we
 * need a threshold that doesn't punish them for normal behavior.
 */
const STREAMING_GAP_THRESHOLD_MS = 3_000;
/** Runs that never produce a finalize event (WS drop mid-stream, gateway crash)
 *  would leak into runTimings forever. Prune anything older than this on every
 *  markRunStart — 10min is well above any legitimate agent run. */
const RUN_TIMING_MAX_AGE_MS = 10 * 60 * 1000;
const LATENCY_LS_PREFIX = 'silos:latency:';
const LATENCY_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function latencyLsKey(sessionKey: string): string {
  return `${LATENCY_LS_PREFIX}${sessionKey}`;
}

function loadLatencyForSession(sessionKey: string): LatencyEntry[] {
  try {
    const raw = localStorage.getItem(latencyLsKey(sessionKey));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const cutoff = Date.now() - LATENCY_MAX_AGE_MS;
    return parsed.filter(
      (e): e is LatencyEntry =>
        e && typeof e === 'object' && typeof e.id === 'string' && typeof e.completedAt === 'number' && e.completedAt >= cutoff,
    );
  } catch {
    return [];
  }
}

function saveLatencyForSession(sessionKey: string, entries: LatencyEntry[]): void {
  try {
    if (entries.length === 0) {
      localStorage.removeItem(latencyLsKey(sessionKey));
    } else {
      localStorage.setItem(latencyLsKey(sessionKey), JSON.stringify(entries));
    }
  } catch { /* quota — silent */ }
}

interface RunTiming {
  sessionKey: string;
  startedAt: number;
  firstDeltaAt?: number;
  lastDeltaAt?: number;
  outputChars: number;
  toolCallCount: number;
  seenToolCallIds: Set<string>;
  /** Tool call ids whose result event we've already processed — prevents
   *  duplicate 'result' phases (progress updates, provider retries) from
   *  decrementing toolActiveCount more than once per invocation. */
  seenToolResultIds: Set<string>;
  toolTimeMs: number;
  /** How many tool calls are currently in flight. Gaps in the delta stream are
   *  only attributed to toolTimeMs while this > 0 — arbitrary streaming stalls
   *  would otherwise get miscounted as tool time. */
  toolActiveCount: number;
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
  /** Per-session compaction status — populated while the gateway is compacting
   *  a run, cleared on final/complete. */
  compactionStatus: Map<string, CompactionStatus>;
  /** Per-session fallback-model status — records which models the gateway is
   *  falling back to during a run. Cleared on final/complete. */
  fallbackStatus: Map<string, FallbackStatus>;

  pushSessionError: (
    sessionKey: string,
    partial: Omit<SessionError, 'id' | 'sessionKey' | 'timestamp'>,
  ) => void;
  clearErrorBadge: (sessionKey: string) => void;
  clearSessionErrors: (sessionKey: string) => void;
  clearSessionLatency: (sessionKey: string) => void;
  /** Hydrate latency history for a session from localStorage into the store. */
  hydrateLatencyForSession: (sessionKey: string) => void;
  incrementToolCallCount: (sessionKey: string) => void;
  /** Mark that we observed agent activity — keeps the "working" signal alive. */
  recordAgentActivity: (sessionKey: string, runId?: string) => void;

  markRunStart: (runId: string, sessionKey: string, model?: string) => void;
  markRunFirstDelta: (runId: string) => void;
  accumulateRunChars: (runId: string, chars: number) => void;
  /** Record each assistant text delta for gap/tool-time tracking. */
  recordRunDelta: (runId: string) => void;
  /** Batched delta observer — updates runTimings + lastAgentActivity + lastKnownRunId
   *  in a single store mutation (4 separate set() calls otherwise fire per delta,
   *  each re-rendering the whole subscribed component tree under streaming load). */
  recordDelta: (runId: string | undefined, sessionKey: string | undefined, chars: number) => void;
  /** Record a tool call dispatched within a run (deduped by toolCallId). */
  recordRunToolCall: (runId: string, toolCallId?: string) => void;
  /** Mark a tool result received (decrements the active-tool counter, deduped by toolCallId). */
  recordRunToolResult: (runId: string, toolCallId?: string) => void;
  finalizeRunLatency: (
    runId: string,
    outcome: LatencyOutcome,
    model?: string,
    fallbackSessionKey?: string,
  ) => void;

  setCompactionStatus: (sessionKey: string, status: CompactionStatus | null) => void;
  setFallbackStatus: (sessionKey: string, status: FallbackStatus | null) => void;
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
    compactionStatus: new Map<string, CompactionStatus>(),
    fallbackStatus: new Map<string, FallbackStatus>(),

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
      try { localStorage.removeItem(latencyLsKey(sessionKey)); } catch { /* ignore */ }
      set((state) => {
        const newMap = new Map(state.latencyEntries);
        newMap.delete(sessionKey);
        return { latencyEntries: newMap };
      });
    },

    hydrateLatencyForSession: (sessionKey) => {
      if (!sessionKey) return;
      // Don't overwrite in-memory entries — they're fresher.
      if (get().latencyEntries.has(sessionKey)) return;
      const loaded = loadLatencyForSession(sessionKey);
      if (loaded.length === 0) return;
      set((state) => {
        const newMap = new Map(state.latencyEntries);
        newMap.set(sessionKey, loaded);
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
        const now = Date.now();
        const newTimings = new Map(state.runTimings);
        // Sweep orphaned timings left behind by abnormal terminations.
        for (const [rid, t] of newTimings) {
          if (now - t.startedAt > RUN_TIMING_MAX_AGE_MS) newTimings.delete(rid);
        }
        newTimings.set(runId, {
          sessionKey,
          startedAt: now,
          outputChars: 0,
          toolCallCount: 0,
          seenToolCallIds: new Set(),
          seenToolResultIds: new Set(),
          toolTimeMs: 0,
          toolActiveCount: 0,
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
        if (entry.lastDeltaAt !== undefined && entry.toolActiveCount > 0) {
          const gap = now - entry.lastDeltaAt;
          // Only attribute gaps to tool time when a tool is actually in flight.
          // A long pause with no active tool is a model stall or connectivity
          // hiccup, not work — counting it as tool time would under-report raw
          // tok/s AND over-report effective tok/s.
          if (gap > STREAMING_GAP_THRESHOLD_MS) {
            toolTimeMs += gap;
          }
        }
        const newTimings = new Map(state.runTimings);
        newTimings.set(runId, { ...entry, lastDeltaAt: now, toolTimeMs });
        return { runTimings: newTimings };
      });
    },

    recordDelta: (runId, sessionKey, chars) => {
      // Fast path: nothing to record.
      if (!runId && !sessionKey) return;
      set((state) => {
        const now = Date.now();
        const patch: Partial<typeof state> = {};

        if (runId) {
          const entry = state.runTimings.get(runId);
          if (entry) {
            let toolTimeMs = entry.toolTimeMs;
            if (entry.lastDeltaAt !== undefined && entry.toolActiveCount > 0) {
              const gap = now - entry.lastDeltaAt;
              if (gap > STREAMING_GAP_THRESHOLD_MS) toolTimeMs += gap;
            }
            const newTimings = new Map(state.runTimings);
            newTimings.set(runId, {
              ...entry,
              outputChars: Math.max(entry.outputChars, chars),
              lastDeltaAt: now,
              toolTimeMs,
            });
            patch.runTimings = newTimings;
          }
        }

        if (sessionKey) {
          const newActivity = new Map(state.lastAgentActivity);
          newActivity.set(sessionKey, now);
          patch.lastAgentActivity = newActivity;
          if (runId) {
            const newKnown = new Map(state.lastKnownRunId);
            newKnown.set(sessionKey, runId);
            patch.lastKnownRunId = newKnown;
          }
        }

        return patch as any;
      });
    },

    recordRunToolCall: (runId, toolCallId) => {
      if (!runId) return;
      // Without a stable toolCallId we can't dedupe across phase events
      // (call/input/start all fire for one invocation on some providers) — prefer
      // undercount to double-count. All major providers (Anthropic, OpenAI) emit
      // an id, so this only drops unknown/malformed payloads.
      if (!toolCallId) return;
      set((state) => {
        const entry = state.runTimings.get(runId);
        if (!entry) return state;
        if (entry.seenToolCallIds.has(toolCallId)) return state;
        const newSeen = new Set(entry.seenToolCallIds);
        newSeen.add(toolCallId);
        const newTimings = new Map(state.runTimings);
        newTimings.set(runId, {
          ...entry,
          toolCallCount: entry.toolCallCount + 1,
          seenToolCallIds: newSeen,
          toolActiveCount: entry.toolActiveCount + 1,
        });
        return { runTimings: newTimings };
      });
    },

    recordRunToolResult: (runId, toolCallId) => {
      if (!runId) return;
      // Without a stable toolCallId we can't dedupe — symmetric to recordRunToolCall,
      // which also skips when id is missing. Prefer under-decrement over over-decrement:
      // a stuck active counter is less harmful (over-attributes gap time) than a
      // prematurely-zeroed one (stops gap attribution while tools are still running).
      if (!toolCallId) return;
      set((state) => {
        const entry = state.runTimings.get(runId);
        if (!entry) return state;
        if (entry.seenToolResultIds.has(toolCallId)) return state;
        if (entry.toolActiveCount <= 0) return state;
        const newSeen = new Set(entry.seenToolResultIds);
        newSeen.add(toolCallId);
        const newTimings = new Map(state.runTimings);
        newTimings.set(runId, {
          ...entry,
          toolActiveCount: entry.toolActiveCount - 1,
          seenToolResultIds: newSeen,
        });
        return { runTimings: newTimings };
      });
    },

    finalizeRunLatency: (runId, outcome, model, fallbackSessionKey) => {
      if (!runId) return;
      const completedAt = Date.now();
      const existing = get().runTimings.get(runId);
      // Fallback path: no markRunStart was seen for this runId (race on reconnect,
      // event replayed from history, provider emitted final without start). Rather
      // than dropping the entry silently, emit a minimal record using the caller's
      // sessionKey so the run still counts toward totals/outcomes.
      const entry: RunTiming = existing ?? {
        sessionKey: fallbackSessionKey ?? '',
        startedAt: completedAt,
        outputChars: 0,
        toolCallCount: 0,
        seenToolCallIds: new Set<string>(),
        seenToolResultIds: new Set<string>(),
        toolTimeMs: 0,
        toolActiveCount: 0,
      };
      if (!existing && !fallbackSessionKey) {
        console.warn(`[telemetry] finalizeRunLatency: no timing for ${runId} and no fallbackSessionKey — skipping`);
        return;
      }
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

      // Active streaming time = total generation window minus non-streaming gaps.
      // When tool time dominates (>= 90% of genMs) our gap estimate is unreliable
      // and dividing by a tiny residual produces absurd rates — skip it.
      const activeGenMs = genMs - entry.toolTimeMs;
      const effectiveTokensPerSecond =
        outputTokens && activeGenMs >= Math.max(100, genMs * 0.1)
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
        // Merge with LS on first finalize for this session — in-memory map starts
        // empty on reload, so without this we'd overwrite the persisted history.
        const existing = state.latencyEntries.get(entry.sessionKey)
          ?? loadLatencyForSession(entry.sessionKey);
        const updated = [...existing, latencyEntry];
        if (updated.length > MAX_LATENCY_PER_SESSION) {
          updated.splice(0, updated.length - MAX_LATENCY_PER_SESSION);
        }
        saveLatencyForSession(entry.sessionKey, updated);
        const newMap = new Map(state.latencyEntries);
        newMap.set(entry.sessionKey, updated);

        const newTimings = new Map(state.runTimings);
        newTimings.delete(runId);

        return { latencyEntries: newMap, runTimings: newTimings };
      });
    },

    setCompactionStatus: (sessionKey, status) => {
      if (!sessionKey) return;
      set((state) => {
        const next = new Map(state.compactionStatus);
        if (!status) {
          if (!next.has(sessionKey)) return state;
          next.delete(sessionKey);
        } else {
          next.set(sessionKey, status);
        }
        return { compactionStatus: next };
      });
    },

    setFallbackStatus: (sessionKey, status) => {
      if (!sessionKey) return;
      set((state) => {
        const next = new Map(state.fallbackStatus);
        if (!status) {
          if (!next.has(sessionKey)) return state;
          next.delete(sessionKey);
        } else {
          next.set(sessionKey, status);
        }
        return { fallbackStatus: next };
      });
    },
  };
}
