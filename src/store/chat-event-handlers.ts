/**
 * Chat event handlers — extracted from dashboard-store.ts handleEvent.
 *
 * Each handler receives a store accessor (get/set) and the event payload.
 * This separation keeps each concern (display, streaming, task tracking) isolated
 * while maintaining the same store mutation semantics.
 */

import type { ChatMessage, Task } from '../types/openclaw';
import { generateId } from '../lib/utils';
import { isSilentReply } from '../lib/reasoning-tags';

function describeBrowserAction(input: Record<string, unknown>): string {
  const action = (input?.action as string) || (input?.command as string) || 'working';
  const url = input?.url as string;
  const ref = input?.ref;
  const text = input?.text as string;

  if (action === 'navigate' && url) return `navigating to ${url}...`;
  if (action === 'click' && ref) return `clicking element ${ref}...`;
  if (action === 'type' && ref) return `typing in element ${ref}...`;
  if (action === 'snapshot') return 'reading page...';
  if (action === 'screenshot') return 'taking screenshot...';
  if (action === 'evaluate') return 'running script...';
  if (text) return `${action}: "${text.slice(0, 40)}"...`;
  return `${action}...`;
}

/** Minimal store accessor to avoid importing the full DashboardStore type */
export interface StoreAccessor {
  get: () => any;
  set: (updater: any) => void;
}

// ============================================================================
// AGENT DISPLAY EVENTS — tools, browser actions, errors
// ============================================================================

export function handleAgentDisplayEvent(
  { get, set }: StoreAccessor,
  payload: any,
  currentEffectiveKey: string | null,
) {
  const eventSessionKey = payload?.sessionKey;

  // Check if this event belongs to our currently selected session
  const isSubagentEvent = eventSessionKey?.includes(':subagent:') || eventSessionKey?.includes('-subagent-');
  const isFromSameAgent = (() => {
    if (!eventSessionKey || !currentEffectiveKey) return false;
    const eventAgentMatch = eventSessionKey.match(/^agent:([^:]+)/);
    const currentAgentMatch = currentEffectiveKey.match(/^agent:([^:]+)/);
    return eventAgentMatch && currentAgentMatch && eventAgentMatch[1] === currentAgentMatch[1];
  })();

  if (eventSessionKey && eventSessionKey !== currentEffectiveKey) {
    // Track unread for other sessions when message completes
    if (payload?.stream === 'lifecycle' &&
      (payload?.data?.phase === 'complete' || payload?.data?.phase === 'done' || payload?.data?.phase === 'end')) {
      get().incrementUnread(eventSessionKey);
    }
    if (!isSubagentEvent || !isFromSameAgent) {
      return false; // Signal: event was filtered out, don't fall through to task tracking
    }
    // Subagent from same agent: skip display, fall through to task tracking
    return true;
  }

  const isCurrentSessionEvent = eventSessionKey === currentEffectiveKey || !eventSessionKey;
  const shouldShowInChat = isCurrentSessionEvent;

  // ── TOOL EVENTS ──
  if (shouldShowInChat && payload?.stream === 'tool') {
    const toolName = payload?.data?.name || payload?.data?.toolName;
    const phase = payload?.data?.phase;

    // Browser tool detection
    if (toolName && (toolName === 'browser' || (toolName as string).startsWith('browser'))) {
      if (phase === 'call' || phase === 'input' || phase === 'start') {
        const toolInput = payload?.data?.input || payload?.data?.args || {};
        const description = describeBrowserAction(toolInput as Record<string, unknown>);
        set({ browserAgentAction: description });
        if (!get().browserPanelOpen) {
          set({ browserPanelOpen: true });
        }
      } else if (phase === 'result') {
        set({ browserAgentAction: null });
      }
    }

    // Tool call start
    if ((phase === 'call' || phase === 'input' || phase === 'start') && toolName) {
      const sk = get().selectedSessionKey;
      const rid = payload?.runId;
      if (sk && rid) {
        const newRunHadTools = new Map(get().runHadTools);
        newRunHadTools.set(sk, true);
        set({ runHadTools: newRunHadTools });
      }

      set((state: any) => {
        const toolCallId = payload?.data?.toolCallId as string | undefined;
        const toolCallMessage: ChatMessage = {
          id: generateId(),
          role: 'tool',
          content: '',
          timestamp: Date.now(),
          toolName: toolName,
          toolCallId,
          toolCall: payload?.data?.input || payload?.data?.args,
          runId: payload?.runId,
          status: 'sending',
        };
        return {
          chatMessages: [...state.chatMessages, toolCallMessage],
          streamingContent: '',
          streamingRunId: null,
        };
      });
    }

    // Tool results
    if (phase === 'result' && toolName) {
      const toolResult = payload?.data?.result;
      const toolArgs = payload?.data?.args || payload?.data?.input;
      const toolCallId = payload?.data?.toolCallId as string | undefined;

      set((state: any) => {
        // Match by toolCallId first (stable ID from gateway, same as OpenClaw UI)
        let pendingToolIdx = toolCallId
          ? state.chatMessages.findIndex(
              (m: ChatMessage) => m.role === 'tool' && m.toolCallId === toolCallId && m.status === 'sending'
            )
          : -1;
        // Fallback: runId+toolName, then earliest pending by name
        if (pendingToolIdx === -1) {
          pendingToolIdx = state.chatMessages.findIndex(
            (m: ChatMessage) => m.role === 'tool' && m.toolName === toolName && m.status === 'sending' && m.runId === payload?.runId
          );
        }
        if (pendingToolIdx === -1) {
          pendingToolIdx = state.chatMessages.findIndex(
            (m: ChatMessage) => m.role === 'tool' && m.toolName === toolName && m.status === 'sending'
          );
        }

        if (pendingToolIdx !== -1) {
          const messages = [...state.chatMessages];
          messages[pendingToolIdx] = {
            ...messages[pendingToolIdx],
            content: toolResult ? (typeof toolResult === 'string' ? toolResult : JSON.stringify(toolResult, null, 2)) : '',
            result: toolResult,
            toolCall: messages[pendingToolIdx].toolCall || toolArgs,
            status: 'delivered',
          };
          return { chatMessages: messages };
        } else {
          const toolMessage: ChatMessage = {
            id: generateId(),
            role: 'tool',
            content: toolResult ? (typeof toolResult === 'string' ? toolResult : JSON.stringify(toolResult, null, 2)) : '',
            timestamp: Date.now(),
            toolName: toolName,
            toolCall: toolArgs,
            result: toolResult,
            runId: payload?.runId,
          };
          return { chatMessages: [...state.chatMessages, toolMessage] };
        }
      });
    }
  }

  // ── AGENT ERROR ──
  if (shouldShowInChat && payload?.stream === 'lifecycle' && (payload?.data?.phase === 'error' || (payload?.data?.phase === 'end' && payload?.data?.isError))) {
    set((state: any) => {
      const runId = payload?.runId || (state.selectedSessionKey ? state.activeRunId.get(state.selectedSessionKey) : undefined);
      const errorDetail = payload?.data?.error || payload?.data?.message || '';

      const isRateLimit = errorDetail.includes('429') || /rate limit/i.test(errorDetail);
      if (isRateLimit) {
        const limitType = /budget/i.test(errorDetail) ? 'BUDGET'
          : /requests?\s*per\s*minute|rpm/i.test(errorDetail) ? 'RPM'
            : /tokens?\s*per\s*minute|tpm/i.test(errorDetail) ? 'TPM'
              : 'UNKNOWN';
        const resetMatch = errorDetail.match(/resets?\s*(?:at|in)[:\s]*(.+?)(?:\s*UTC)?\s*$/i);
        console.log(`[RateLimit] Type: ${limitType} | Reset: ${resetMatch?.[1] || 'unknown'} | Detail: ${errorDetail}`);
        set({ rateLimitedUntil: Date.now() + 30000 });

        const recentRateLimit = state.chatMessages.find(
          (m: ChatMessage) => m.role === 'system' && m.content?.startsWith('__provider_error__') &&
            (m.content.includes('429') || /rate limit/i.test(m.content)) &&
            (Date.now() - m.timestamp) < 60000
        );
        if (recentRateLimit) {
          const newActiveRunId = new Map(state.activeRunId);
          if (state.selectedSessionKey) {
            newActiveRunId.delete(state.selectedSessionKey);
          }
          return {
            streamingContent: '',
            streamingRunId: null,
            streamingComplete: false,
            activeRunId: newActiveRunId,
          };
        }
      }

      const errorMessage: ChatMessage = {
        id: generateId(),
        role: 'system',
        content: `__provider_error__${errorDetail}`,
        timestamp: Date.now(),
        runId: runId,
      };

      const newActiveRunId = new Map(state.activeRunId);
      const newChatSending = new Map(state.chatSending);
      if (state.selectedSessionKey) {
        newActiveRunId.delete(state.selectedSessionKey);
        newChatSending.delete(state.selectedSessionKey);
      }

      return {
        chatMessages: [...state.chatMessages, errorMessage],
        activeRunId: newActiveRunId,
        chatSending: newChatSending,
        streamingContent: '',
        streamingRunId: null,
        streamingComplete: false,
      };
    });

    const sk = get().selectedSessionKey;
    if (sk) setTimeout(() => get()._dispatchNextQueued(sk), 0);
  }

  // ── LIFECYCLE COMPLETE (task tracking only) ──
  if (payload?.stream === 'lifecycle' && (payload?.data?.phase === 'complete' || payload?.data?.phase === 'done' || (payload?.data?.phase === 'end' && !payload?.data?.isError))) {
    const runId = payload?.runId;
    if (runId) {
      set((state: any) => ({
        tasks: state.tasks.map((t: Task) =>
          t.runId === runId ? { ...t, status: 'succeeded' as const, completedAt: Date.now() } : t
        ),
      }));
    }
  }

  return true; // Signal: event was processed, fall through to task tracking
}

// ============================================================================
// CHAT EVENTS — streaming, completion, abort, error
// ============================================================================

export function handleChatEvent(
  { get, set }: StoreAccessor,
  payload: any,
  currentEffectiveKey: string | null,
) {
  const eventSessionKey = payload?.sessionKey;

  if (eventSessionKey && eventSessionKey !== currentEffectiveKey) {
    return;
  }

  // ── STREAMING TEXT ──
  if (payload?.state === 'delta' && payload?.message?.content) {
    const chatDeltaText = Array.isArray(payload.message.content)
      ? payload.message.content.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('')
      : typeof payload.message.content === 'string' ? payload.message.content : null;

    if (chatDeltaText && !isSilentReply(chatDeltaText)) {
      const selKey = get().selectedSessionKey;
      const runId = payload?.runId || (selKey ? get().activeRunId.get(selKey) : undefined);

      const currentRunId = get().streamingRunId;
      if (runId && currentRunId && runId !== currentRunId) {
        // Different run — skip
      } else {
        const isFirstDelta = !get().streamingContent;
        const updates: any = { streamingContent: chatDeltaText };

        if (isFirstDelta && runId) {
          updates.streamingRunId = runId;
          const newActiveRunId = new Map(get().activeRunId);
          if (selKey) {
            newActiveRunId.set(selKey, runId);
          }
          updates.activeRunId = newActiveRunId;
          updates.chatMessages = get().chatMessages.map((m: ChatMessage) =>
            m.role === 'user' && m.status === 'sending'
              ? { ...m, status: 'delivered' as const, runId }
              : m
          );
        }

        set(updates);
      }
    }
  }

  // ── ABORTED ──
  if (payload?.state === 'aborted') {
    const targetKey = eventSessionKey || get().selectedSessionKey;

    set((state: any) => {
      const runId = payload?.runId || (targetKey ? state.activeRunId.get(targetKey) : undefined);
      const newActiveRunId = new Map(state.activeRunId);
      if (targetKey) {
        newActiveRunId.delete(targetKey);
      }

      const partialContent = state.streamingContent?.trim();
      let messages = state.chatMessages;
      if (partialContent && !isSilentReply(partialContent)) {
        const alreadySaved = messages.some((m: ChatMessage) => m.role === 'assistant' && m.runId === runId && m.content === partialContent);
        if (!alreadySaved) {
          messages = [...messages, {
            id: generateId(),
            role: 'assistant' as const,
            content: partialContent,
            timestamp: Date.now(),
            runId,
          }];
        }
      }

      const newChatSending = new Map(state.chatSending);
      if (targetKey) {
        newChatSending.delete(targetKey);
      }

      return {
        chatMessages: messages,
        activeRunId: newActiveRunId,
        chatSending: newChatSending,
        streamingContent: '',
        streamingRunId: null,
        streamingComplete: false,
      };
    });

    if (targetKey) {
      setTimeout(() => get()._dispatchNextQueued(targetKey), 0);
    }
  }

  // ── CHAT ERROR ──
  if (payload?.state === 'error') {
    const targetKey = eventSessionKey || get().selectedSessionKey;
    set((state: any) => {
      const newActiveRunId = new Map(state.activeRunId);
      const newChatSending = new Map(state.chatSending);
      if (targetKey) {
        newActiveRunId.delete(targetKey);
        newChatSending.delete(targetKey);
      }
      return {
        activeRunId: newActiveRunId,
        chatSending: newChatSending,
        streamingContent: '',
        streamingRunId: null,
        streamingComplete: false,
        error: targetKey === state.selectedSessionKey ? (payload?.errorMessage || 'Chat error') : state.error,
      };
    });
    if (targetKey) {
      setTimeout(() => get()._dispatchNextQueued(targetKey), 0);
    }
  }

  // ── COMPLETION ──
  if (payload?.status === 'ok' || payload?.status === 'done' || payload?.state === 'final' || payload?.state === 'done') {
    const sessionKey = get().selectedSessionKey;

    // Cross-run guard
    const currentActiveRunId = sessionKey ? get().activeRunId.get(sessionKey) : undefined;
    const eventRunId = payload?.runId;
    if (eventRunId && currentActiveRunId && eventRunId !== currentActiveRunId) {
      const crossRunContent = (() => {
        const msg = payload?.message;
        if (!msg?.content) return null;
        if (typeof msg.content === 'string') return msg.content;
        if (Array.isArray(msg.content)) {
          return msg.content.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('') || null;
        }
        return null;
      })();
      if (crossRunContent && crossRunContent.trim() && !isSilentReply(crossRunContent)) {
        set((state: any) => ({
          chatMessages: [...state.chatMessages, {
            id: generateId(),
            role: 'assistant' as const,
            content: crossRunContent,
            timestamp: Date.now(),
            runId: eventRunId,
          }],
        }));
      }
      return;
    }

    // Extract final content
    const finalPayloadContent = (() => {
      const msg = payload?.message;
      if (!msg?.content) return null;
      if (typeof msg.content === 'string') return msg.content;
      if (Array.isArray(msg.content)) {
        const text = msg.content
          .filter((c: any) => c.type === 'text')
          .map((c: any) => c.text)
          .join('');
        return text || null;
      }
      return null;
    })();

    set((state: any) => {
      const runId = payload?.runId || (state.selectedSessionKey ? state.activeRunId.get(state.selectedSessionKey) : undefined);

      const newActiveRunId = new Map(state.activeRunId);
      const newChatSending = new Map(state.chatSending);
      if (state.selectedSessionKey) {
        newActiveRunId.delete(state.selectedSessionKey);
        newChatSending.delete(state.selectedSessionKey);
      }

      const finalContent = finalPayloadContent || state.streamingContent;

      if (!finalContent || !finalContent.trim() || isSilentReply(finalContent)) {
        return {
          activeRunId: newActiveRunId,
          chatSending: newChatSending,
          streamingContent: '',
          streamingRunId: null,
          streamingComplete: false,
        };
      }

      // Dedup: consolidate assistant messages with same runId
      if (runId && state.chatMessages.some((m: ChatMessage) => m.runId === runId && m.role === 'assistant')) {
        let updatedLast = false;
        const consolidated: ChatMessage[] = [];
        for (let j = state.chatMessages.length - 1; j >= 0; j--) {
          const m = state.chatMessages[j];
          if (m.runId === runId && m.role === 'assistant') {
            if (!updatedLast) {
              consolidated.unshift({ ...m, content: finalContent });
              updatedLast = true;
            }
          } else {
            consolidated.unshift(m);
          }
        }
        return {
          chatMessages: consolidated,
          activeRunId: newActiveRunId,
          chatSending: newChatSending,
          streamingContent: '',
          streamingComplete: true,
          streamingRunId: null,
        };
      }

      // Guard against duplicate completion events
      const lastAssistant = [...state.chatMessages].reverse().find((m: ChatMessage) => m.role === 'assistant');
      if (lastAssistant && lastAssistant.content === finalContent && (!runId || lastAssistant.runId === runId)) {
        return {
          activeRunId: newActiveRunId,
          chatSending: newChatSending,
          streamingContent: '',
          streamingComplete: true,
          streamingRunId: null,
        };
      }

      if (finalPayloadContent && state.streamingContent && finalPayloadContent !== state.streamingContent) {
        console.log(`[chat:final] Content mismatch — payload: ${finalPayloadContent.length} chars, streaming: ${state.streamingContent.length} chars`);
      }

      const assistantMessage: ChatMessage = {
        id: generateId(),
        role: 'assistant',
        content: finalContent,
        timestamp: Date.now(),
        runId,
      };

      const updatedMessages = state.chatMessages.map((m: ChatMessage) => {
        if (m.role === 'user' && m.status === 'sending') {
          return { ...m, status: 'delivered' as const, runId: runId || m.runId };
        }
        return m;
      });

      const firstQueuedIdx = updatedMessages.findIndex((m: ChatMessage) => m.role === 'user' && m.status === 'queued');
      const orderedMessages = firstQueuedIdx >= 0
        ? [...updatedMessages.slice(0, firstQueuedIdx), assistantMessage, ...updatedMessages.slice(firstQueuedIdx)]
        : [...updatedMessages, assistantMessage];

      return {
        chatMessages: orderedMessages,
        streamingContent: '',
        streamingComplete: true,
        streamingRunId: null,
        activeRunId: newActiveRunId,
        chatSending: newChatSending,
      };
    });

    setTimeout(() => set({ streamingComplete: false }), 200);

    if (sessionKey) {
      setTimeout(() => get()._dispatchNextQueued(sessionKey), 0);
    }

    // Reload history after tool-using runs
    const hadTools = get().runHadTools.get(sessionKey || '');
    if (hadTools && sessionKey) {
      const newRunHadTools = new Map(get().runHadTools);
      newRunHadTools.delete(sessionKey);
      set({ runHadTools: newRunHadTools });
      setTimeout(() => {
        if (get().selectedSessionKey === sessionKey) {
          get().loadChatHistory(sessionKey);
        }
      }, 300);
    }

    setTimeout(() => get().loadSessions(), 1000);
  }
}

// ============================================================================
// TASK TRACKING — subagent and background process tracking
// ============================================================================

export function handleTaskTracking(
  { get, set }: StoreAccessor,
  payload: any,
  selectedSessionKey: string | null,
) {
  const runId = payload?.runId;
  const stream = payload?.stream;
  const phase = payload?.data?.phase;
  const toolResult = payload?.data?.result;
  const taskSessionKey = payload?.sessionKey || selectedSessionKey || 'unknown';

  const isSubAgent = taskSessionKey.includes(':subagent:') || taskSessionKey.includes('-subagent-');

  const resultStr = typeof toolResult === 'string' ? toolResult : JSON.stringify(toolResult || '');
  const isBackgroundProcess =
    resultStr.includes('still running') ||
    resultStr.includes('Command still running') ||
    resultStr.includes('background') ||
    resultStr.includes('pid ');

  const isLifecycleStart = stream === 'lifecycle' && phase === 'start';
  const isLifecycleEnd = stream === 'lifecycle' && (phase === 'end' || phase === 'error');
  const isToolStart = stream === 'tool' && (phase === 'start' || phase === 'call' || phase === 'input');
  const isToolEnd = stream === 'tool' && phase === 'result';
  const toolName = payload?.data?.name || payload?.data?.toolName || payload?.toolName;

  if (!runId) return;

  const { tasks } = get();
  const existingTask = tasks.find((t: Task) => t.runId === runId);

  let agentId: string | null = null;
  if (taskSessionKey.startsWith('agent:')) {
    const parts = taskSessionKey.split(':');
    if (parts.length >= 2) {
      agentId = parts[1];
    }
  }

  // CREATE TASK
  if (!existingTask && ((isLifecycleStart && isSubAgent) || isBackgroundProcess)) {
    const newTask: Task = {
      id: generateId(),
      runId: runId,
      sessionKey: taskSessionKey,
      agentId: agentId || undefined,
      status: 'running',
      startedAt: Date.now(),
    };
    set((state: any) => ({ tasks: [...state.tasks, newTask] }));
  }

  // Track spawn parent
  if (isToolStart && toolName) {
    const isSpawnTool = toolName.toLowerCase().includes('spawn') ||
      toolName.toLowerCase().includes('task') ||
      toolName === 'sessions_spawn';
    if (isSpawnTool && selectedSessionKey) {
      set({ pendingSpawnParent: selectedSessionKey });
    }
  }

  // Track subagent parent
  if (isSubAgent) {
    const { subagentParents, pendingSpawnParent, sessions } = get();
    if (!subagentParents.has(taskSessionKey)) {
      let parentKey: string | null = null;

      if (pendingSpawnParent && pendingSpawnParent !== taskSessionKey) {
        parentKey = pendingSpawnParent;
      } else if (selectedSessionKey && selectedSessionKey !== taskSessionKey) {
        parentKey = selectedSessionKey;
      }

      if (parentKey && sessions?.sessions) {
        const extractAgentId = (key: string): string | null => {
          const agentMatch = key.match(/^agent:([^:]+)/);
          if (agentMatch) return agentMatch[1];
          const webchatMatch = key.match(/^webchat:g-agent-([^-]+)/);
          if (webchatMatch) return webchatMatch[1];
          const dmMatch = key.match(/^dm-(.+)$/);
          if (dmMatch) return dmMatch[1];
          return null;
        };

        const exactMatch = sessions.sessions.some((s: any) => s.key === parentKey);
        if (!exactMatch) {
          const parentAgentId = extractAgentId(parentKey);
          const parentParts = parentKey.split(':');
          const parentSuffix = parentParts.length >= 3 ? parentParts.slice(2).join(':') : null;

          const matchedSession = sessions.sessions.find((s: any) => {
            if (s.key.includes(':subagent:') || s.key.includes('-subagent-')) return false;
            const sessionAgentId = extractAgentId(s.key);
            if (sessionAgentId !== parentAgentId) return false;
            if (parentSuffix) {
              if (s.key.endsWith(`:${parentSuffix}`)) return true;
              if (s.key.endsWith(`-${parentSuffix}`)) return true;
              if (s.label === parentSuffix || s.displayName === parentSuffix) return true;
            }
            return false;
          });

          if (matchedSession) {
            parentKey = matchedSession.key;
          }
        }
      }

      if (parentKey) {
        set((state: any) => {
          const newParents = new Map(state.subagentParents);
          newParents.set(taskSessionKey, parentKey!);
          return { subagentParents: newParents, pendingSpawnParent: null };
        });
        setTimeout(() => get().loadSessions(), 500);
      }
    }
  }

  // COMPLETE TASK
  if (existingTask && (isLifecycleEnd || (isToolEnd && existingTask))) {
    const isError = phase === 'error' || payload?.data?.isError;
    set((state: any) => ({
      tasks: state.tasks.map((t: Task) =>
        t.runId === runId
          ? {
            ...t,
            status: isError ? 'failed' : 'succeeded',
            completedAt: Date.now(),
            error: isError ? (payload?.data?.error || 'Error') : undefined,
          }
          : t
      ),
    }));
  }
}
