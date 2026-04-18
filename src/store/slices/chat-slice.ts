import type { ChatMessage, InterSessionEventMeta } from '../../types/openclaw';
import { generateId } from '../../lib/utils';
import { isSilentReply, stripReasoningTags } from '../../lib/reasoning-tags';
import { resolveSessionKey, stripInboundMeta, parseInternalEventSummary } from '../store-utils';
import type { StoreSet, StoreGet } from '../store-types';
import { extractAssistantTextForPhase } from '../../lib/phase-filter';
import { closeOutInterSessionTasks } from '../chat-event-handlers';

/**
 * Extract raw text from a gateway message content (string or content-blocks
 * array). Used to feed parseInternalEventSummary, which wants the original
 * text including the <<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>> delimiters.
 */
function rawTextOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (block && typeof block === 'object') {
        const t = (block as { type?: unknown }).type;
        const text = (block as { text?: unknown }).text;
        if ((t === 'text' || t === 'output_text' || t === 'input_text') && typeof text === 'string') {
          parts.push(text);
        }
      } else if (typeof block === 'string') {
        parts.push(block);
      }
    }
    return parts.join('\n');
  }
  return '';
}

/**
 * Detect a gateway user message whose `provenance.kind === 'inter_session'`
 * (e.g. subagent announce). Returns a structured meta blob if so, else null.
 */
function buildInterSessionMeta(raw: unknown): InterSessionEventMeta | null {
  if (!raw || typeof raw !== 'object') return null;
  const m = raw as { role?: unknown; provenance?: unknown; content?: unknown };
  if (m.role !== 'user') return null;
  const prov = m.provenance;
  if (!prov || typeof prov !== 'object') return null;
  const p = prov as Record<string, unknown>;
  if (p.kind !== 'inter_session') return null;

  const summary = parseInternalEventSummary(rawTextOf(m.content));
  return {
    kind: 'inter_session',
    sourceTool: typeof p.sourceTool === 'string' ? p.sourceTool : summary?.announceType,
    sourceSessionKey:
      typeof p.sourceSessionKey === 'string' ? p.sourceSessionKey : summary?.sourceSessionKey,
    sourceChannel: typeof p.sourceChannel === 'string' ? p.sourceChannel : undefined,
    task: summary?.task,
    status: summary?.status,
    result: summary?.result,
    announceType: summary?.announceType,
    replyInstruction: summary?.replyInstruction,
  };
}

let _chatHistoryGen = 0;

export function createChatSlice(set: StoreSet, get: StoreGet) {
  return {
    // --- Initial state ---
    chatMessages: [] as ChatMessage[],
    chatLoading: false,
    chatSending: new Map<string, boolean>(),
    activeRunId: new Map<string, string>(),
    runHadTools: new Map<string, boolean>(),
    messageQueue: new Map<string, Array<{ id: string; text: string }>>(),
    streamingContent: '',
    streamingRunId: null as string | null,
    streamingComplete: false,
    subagentParents: new Map<string, string>(),
    pendingSpawnParent: null as string | null,
    sessionCumulativeTokens: (() => {
      try {
        const raw = localStorage.getItem('silos:cumTokens');
        if (raw) {
          const entries = JSON.parse(raw) as [string, { total: number; lastInput: number; lastOutput: number }][];
          return new Map(entries);
        }
      } catch { /* ignore corrupt data */ }
      return new Map<string, { total: number; lastInput: number; lastOutput: number }>();
    })(),
    rateLimitedUntil: 0,

    // --- Actions ---

    loadChatHistory: async (key: string) => {
      const { client } = get();
      if (!client) return;

      const gen = ++_chatHistoryGen;
      set({ chatLoading: true, error: null });

      const effectiveKey = resolveSessionKey(key);

      client.patchSession(effectiveKey, { verboseLevel: 'full' }).catch(() => {});

      try {
        const result = await client.getChatHistory(effectiveKey, { limit: 200 });

        const extractedToolUseMessages: ChatMessage[] = [];
        const messages: ChatMessage[] = (result.messages || []).map((m: any, i: number) => {
          const interMeta = buildInterSessionMeta(m);
          let textContent: string;
          if (m.role === 'user') {
            // inter-session injections carry the scaffolding in the text — we render them
            // from `meta` instead; collapse textContent to a short summary fallback.
            if (interMeta) {
              textContent = interMeta.task
                ? `Subagent: ${interMeta.task}`
                : 'Inter-session event';
            } else {
              textContent = stripInboundMeta(m.content);
            }
          } else if (typeof m.content === 'string') {
            textContent = m.content;
          } else if (Array.isArray(m.content)) {
            if (m.role === 'assistant') {
              textContent = stripReasoningTags(extractAssistantTextForPhase(m, 'final_answer'));
            } else {
              const textParts = m.content
                .filter((item: any) => !item || typeof item === 'string' || item?.type === 'text')
                .map((item: any) => (typeof item === 'string' ? item : item?.text ?? null))
                .filter(Boolean);
              textContent = textParts.join('\n') || '';
            }

            for (const item of m.content) {
              const isToolUse = item?.type === 'tool_use' || item?.type === 'toolCall';
              if (isToolUse && item.name) {
                extractedToolUseMessages.push({
                  id: item.id || `tool-${m.id || i}-${item.name}`,
                  role: 'tool',
                  content: '',
                  timestamp: m.timestamp || Date.now(),
                  toolName: item.name,
                  toolCall: item.input ?? item.arguments,
                  runId: m.runId,
                  status: 'delivered',
                });
              }
            }
          } else {
            textContent = '';
          }

          return {
            id: m.id || `msg-${i}`,
            role: m.role || 'user',
            content: textContent,
            timestamp: m.timestamp || Date.now(),
            toolName: m.toolName,
            toolCall: m.toolCall,
            result: m.result,
            runId: m.runId,
            ...(interMeta ? { meta: interMeta } : {}),
          };
        }).filter((m) => {
          if (m.role === 'toolResult') return false;
          // Keep inter-session events even when textContent is a short label.
          if (m.role === 'user' && !m.meta && (!m.content || !m.content.trim())) return false;
          if (m.role === 'assistant' && isSilentReply(m.content)) return false;
          // Drop assistant turns whose only content was tool calls (promoted to separate tool msgs).
          if (m.role === 'assistant' && !m.content?.trim() && !m.toolName && !m.toolCall) return false;
          return true;
        });

        if (get().selectedSessionKey !== key || gen !== _chatHistoryGen) return;

        const existingToolMessages = get().chatMessages.filter(
          m => m.role === 'tool' || m.toolName || m.toolCall || m.result
        );
        const existingToolKeys = new Set(
          existingToolMessages
            .filter(m => m.toolName && m.runId)
            .map(m => `${m.toolName}:${m.runId}`)
        );
        const uniqueExtracted = extractedToolUseMessages.filter(
          m => !m.runId || !m.toolName || !existingToolKeys.has(`${m.toolName}:${m.runId}`)
        );

        const allToolMessages = [...existingToolMessages, ...uniqueExtracted];
        let merged = messages;
        if (allToolMessages.length > 0) {
          merged = [...messages, ...allToolMessages].sort(
            (a, b) => (a.timestamp || 0) - (b.timestamp || 0)
          );
        }

        const queued = get().chatMessages.filter(m => m.status === 'queued');
        const orphanedQueue = get().messageQueue.get(key);
        if (orphanedQueue && orphanedQueue.length > 0) {
          const existingIds = new Set(queued.map(m => m.id));
          for (const q of orphanedQueue) {
            if (!existingIds.has(q.id)) {
              queued.push({
                id: q.id,
                role: 'user' as const,
                content: q.text,
                timestamp: Date.now(),
                status: 'queued' as const,
              });
            }
          }
        }
        set({ chatMessages: queued.length > 0 ? [...merged, ...queued] : merged, chatLoading: false });
        if (queued.length > 0 && !get().activeRunId.get(key)) {
          setTimeout(() => get()._dispatchNextQueued(key), 100);
        }

        // Close out any in-memory tasks whose child session just announced
        // completion. The announce is the canonical "subagent finished"
        // signal; using it here catches orphans left by stillborn spawns
        // whose lifecycle:end never matched.
        {
          const storeLike = {
            getState: () => ({ tasks: get().tasks }),
            setState: (partial: { tasks: ChatMessage[] }) => set(partial as unknown as Parameters<typeof set>[0]),
          };
          for (const m of merged) {
            if (m.meta?.kind === 'inter_session' && m.meta.sourceSessionKey) {
              closeOutInterSessionTasks(storeLike, m.meta.sourceSessionKey, m.meta.status);
            }
          }
        }
      } catch (error) {
        if (get().selectedSessionKey !== key || gen !== _chatHistoryGen) return;
        if (key.startsWith('dm-')) {
          set({ chatMessages: [], chatLoading: false });
          return;
        }
        set({ chatLoading: false, error: String(error) });
      }
    },

    sendMessage: async (message: string) => {
      const { client, selectedSessionKey, chatSending, activeRunId } = get();
      if (!client || !selectedSessionKey) return;

      // Gate on activeRunId (real in-flight run), not chatSending alone.
      // chatSending can get stuck=true after aborted/errored runs that didn't
      // clean up; activeRunId is tied to real delta/final lifecycle events.
      const hasActiveRun = activeRunId.has(selectedSessionKey);
      const isAlreadySending = hasActiveRun;

      // Self-heal: if chatSending was stuck but no real run is active, clear it
      // so the UI spinner/stop button don't lie.
      if (!hasActiveRun && chatSending.get(selectedSessionKey) === true) {
        const healed = new Map(chatSending);
        healed.delete(selectedSessionKey);
        set({ chatSending: healed });
      }

      const messageId = generateId();
      const userMessage: ChatMessage = {
        id: messageId,
        role: 'user',
        content: message,
        timestamp: Date.now(),
        status: isAlreadySending ? 'queued' : 'sending',
      };

      if (isAlreadySending) {
        const newQueue = new Map(get().messageQueue);
        const sessionQueue = [...(newQueue.get(selectedSessionKey) || []), { id: messageId, text: message }];
        newQueue.set(selectedSessionKey, sessionQueue);
        set({
          chatMessages: [...get().chatMessages, userMessage],
          messageQueue: newQueue,
        });
        return;
      }

      const newChatSending = new Map(chatSending);
      newChatSending.set(selectedSessionKey, true);

      set({
        chatMessages: [...get().chatMessages, userMessage],
        chatSending: newChatSending,
        streamingContent: '',
        streamingRunId: null,
        streamingComplete: false,
      });

      const effectiveSessionKey = resolveSessionKey(selectedSessionKey);

      try {
        const result = await client.sendChat(effectiveSessionKey, message, {
          idempotencyKey: messageId,
        });

        set({
          chatMessages: get().chatMessages.map(m =>
            m.id === messageId ? { ...m, runId: result.runId } : m
          ),
        });

        const newActiveRunId = new Map(get().activeRunId);
        newActiveRunId.set(selectedSessionKey, result.runId);
        set({ activeRunId: newActiveRunId });

        get().markRunStart(result.runId, selectedSessionKey);
        get().loadSessions();
      } catch (error) {
        const newChatSending2 = new Map(get().chatSending);
        newChatSending2.delete(selectedSessionKey);
        set({
          chatMessages: get().chatMessages.map(m =>
            m.id === messageId ? { ...m, status: 'error' as const } : m
          ),
          chatSending: newChatSending2,
          error: String(error),
        });
        get().pushSessionError(selectedSessionKey, {
          kind: 'network',
          source: 'chat.send',
          message: String(error),
          raw: error,
        });
      }
    },

    abortChat: async () => {
      const { client, activeRunId, selectedSessionKey, tasks, lastKnownRunId } = get();
      if (!client || !selectedSessionKey) return;

      // Prefer the currently tracked runId; fall back to the last runId we saw
      // activity on (in case compaction retry transparently swapped runs).
      const runId = activeRunId.get(selectedSessionKey)
        || lastKnownRunId.get(selectedSessionKey);
      const effectiveSessionKey = resolveSessionKey(selectedSessionKey);

      // Helper: clear run state (was duplicated in try/catch)
      const clearRunState = () => {
        const newActiveRunId = new Map(get().activeRunId);
        newActiveRunId.delete(selectedSessionKey);
        const newChatSending = new Map(get().chatSending);
        newChatSending.delete(selectedSessionKey);
        const newRunHadTools = new Map(get().runHadTools);
        newRunHadTools.delete(selectedSessionKey);

        const partialContent = get().streamingContent;
        if (partialContent && partialContent.trim()) {
          set((state) => ({
            chatMessages: [...state.chatMessages, {
              id: generateId(),
              role: 'assistant' as const,
              content: partialContent,
              timestamp: Date.now(),
              runId,
            }],
          }));
        }

        set({
          activeRunId: newActiveRunId,
          chatSending: newChatSending,
          runHadTools: newRunHadTools,
          streamingContent: '',
          streamingRunId: null,
          streamingComplete: false,
        });

        setTimeout(() => get()._dispatchNextQueued(selectedSessionKey), 100);
      };

      try {
        await client.abortChat(effectiveSessionKey, runId || undefined);
        // Also update the task status to aborted
        set({
          tasks: tasks.map((t) =>
            (runId && t.runId === runId) ? { ...t, status: 'cancelled' as any, completedAt: Date.now() } : t
          ),
        });
        clearRunState();
      } catch (error) {
        console.error('[Abort] Failed:', error);
        clearRunState();
      }
    },

    _dispatchNextQueued: async (sessionKey: string) => {
      const { client, messageQueue } = get();
      if (!client) return;

      const queue = messageQueue.get(sessionKey);
      if (!queue || queue.length === 0) {
        const newChatSending = new Map(get().chatSending);
        const newActiveRunId = new Map(get().activeRunId);
        newChatSending.delete(sessionKey);
        newActiveRunId.delete(sessionKey);
        set({ chatSending: newChatSending, activeRunId: newActiveRunId });
        return;
      }

      const next = queue[0];
      const newQueue = new Map(messageQueue);
      newQueue.set(sessionKey, queue.slice(1));

      const newChatSending = new Map(get().chatSending);
      newChatSending.set(sessionKey, true);
      set({
        messageQueue: newQueue,
        chatMessages: get().chatMessages.map(m =>
          m.id === next.id ? { ...m, status: 'sending' as const } : m
        ),
        chatSending: newChatSending,
        streamingContent: '',
        streamingRunId: null,
        streamingComplete: false,
      });

      const effectiveSessionKey = resolveSessionKey(sessionKey);

      try {
        const result = await client.sendChat(effectiveSessionKey, next.text, {
          idempotencyKey: next.id,
        });
        set({
          chatMessages: get().chatMessages.map(m =>
            m.id === next.id ? { ...m, runId: result.runId } : m
          ),
        });
        const newActiveRunId = new Map(get().activeRunId);
        newActiveRunId.set(sessionKey, result.runId);
        set({ activeRunId: newActiveRunId });
        get().markRunStart(result.runId, sessionKey);
      } catch (error) {
        set({
          chatMessages: get().chatMessages.map(m =>
            m.id === next.id ? { ...m, status: 'error' as const } : m
          ),
        });
        get().pushSessionError(sessionKey, {
          kind: 'network',
          source: 'chat.send (queued)',
          message: String(error),
          raw: error,
        });
        setTimeout(() => get()._dispatchNextQueued(sessionKey), 0);
      }
    },

    clearQueue: () => {
      const { selectedSessionKey } = get();
      const newQueue = new Map(get().messageQueue);
      if (selectedSessionKey) newQueue.delete(selectedSessionKey);
      set((state) => ({
        chatMessages: state.chatMessages.map(m =>
          m.role === 'user' && m.status === 'queued'
            ? { ...m, status: 'error' as const }
            : m
        ),
        messageQueue: newQueue,
      }));
    },

    removeLastQueued: () => {
      const { selectedSessionKey } = get();
      if (!selectedSessionKey) return;

      set((state) => {
        const messages = [...state.chatMessages];
        let lastIdx = -1;
        for (let i = messages.length - 1; i >= 0; i--) {
          if (messages[i].role === 'user' && messages[i].status === 'queued') {
            lastIdx = i;
            break;
          }
        }
        if (lastIdx === -1) return state;

        const removedId = messages[lastIdx].id;
        messages.splice(lastIdx, 1);

        const newQueue = new Map(state.messageQueue);
        const sessionQueue = newQueue.get(selectedSessionKey);
        if (sessionQueue) {
          const filtered = sessionQueue.filter(m => m.id !== removedId);
          if (filtered.length > 0) {
            newQueue.set(selectedSessionKey, filtered);
          } else {
            newQueue.delete(selectedSessionKey);
          }
        }

        return { chatMessages: messages, messageQueue: newQueue };
      });
    },
  };
}
