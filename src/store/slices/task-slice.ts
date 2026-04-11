import type { Task, TaskStatus } from '../../types/openclaw';
import { generateId } from '../../lib/utils';
import type { StoreSet, StoreGet } from '../store-types';

export function createTaskSlice(set: StoreSet, get: StoreGet) {
  return {
    tasks: [] as Task[],
    taskHistoryLoading: false,

    updateTaskStatus: (id: string, status: TaskStatus) => {
      const { tasks } = get();
      set({
        tasks: tasks.map((task) =>
          task.id === id
            ? { ...task, status, completedAt: status === 'succeeded' ? Date.now() : undefined }
            : task
        ),
      });
    },

    abortTask: async (runId: string) => {
      const { client, tasks } = get();
      if (!client) return;
      try {
        await client.abortChat(runId);
        set({
          tasks: tasks.map((task) =>
            task.runId === runId ? { ...task, status: 'cancelled' as TaskStatus } : task
          ),
        });
      } catch (error) {
        set({ error: String(error) });
      }
    },

    loadTaskHistory: async () => {
      const { client, tasks } = get();
      if (!client) return;
      set({ taskHistoryLoading: true });
      try {
        const result = await client.listSessions({
          limit: 100,
          includeLastMessage: true,
          includeDerivedTitles: true,
        });
        if (!result?.sessions) {
          set({ taskHistoryLoading: false });
          return;
        }
        const subagentSessions = result.sessions.filter(
          (s) => s.key?.includes(':subagent:') || s.key?.includes('-subagent-')
        );
        const historyTasks: Task[] = subagentSessions.map((session) => {
          let agentId: string | undefined;
          if (session.key?.startsWith('agent:')) {
            const parts = session.key.split(':');
            if (parts.length >= 2) {
              agentId = parts[1];
            }
          }
          let status: TaskStatus = 'succeeded';
          if (session.abortedLastRun) {
            status = 'cancelled';
          }
          return {
            id: session.sessionId || session.key || generateId(),
            runId: session.sessionId || session.key || '',
            sessionKey: session.key || '',
            agentId,
            status,
            startedAt: session.updatedAt || Date.now(),
            completedAt: session.updatedAt || Date.now(),
            inputTokens: session.inputTokens,
            outputTokens: session.outputTokens,
          };
        });
        const existingKeys = new Set(tasks.map((t) => t.sessionKey));
        const newTasks = historyTasks.filter((t) => !existingKeys.has(t.sessionKey));
        set({
          tasks: [...tasks, ...newTasks],
          taskHistoryLoading: false,
        });
      } catch (error) {
        console.error('[TaskHistory] Error loading:', error);
        set({ taskHistoryLoading: false, error: String(error) });
      }
    },
  };
}
