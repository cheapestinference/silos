import type { Task, TaskStatus } from '../../types/openclaw';
import type { TaskRun } from '../../types/tasks';
import { generateId } from '../../lib/utils';
import { fetchTasks } from '../../lib/tasks-api';
import type { StoreSet, StoreGet } from '../store-types';

/**
 * Extract a normalized agent id from a session key. Handles the common
 * `agent:<id>:...`, `webchat:g-agent-<id>-...` and `dm-<id>` forms.
 */
function extractAgentIdFromKey(key: string | undefined): string | null {
  if (!key) return null;
  const agentMatch = key.match(/^agent:([^:]+)/);
  if (agentMatch) return agentMatch[1];
  const webchatMatch = key.match(/^webchat:g-agent-([^-]+)/);
  if (webchatMatch) return webchatMatch[1];
  const dmMatch = key.match(/^dm-(.+)$/);
  if (dmMatch) return dmMatch[1];
  return null;
}

/** Map a registry TaskRun to Silos's in-memory Task shape. */
function taskRunToTask(run: TaskRun): Task {
  const sessionKey = run.childSessionKey || run.ownerKey;
  return {
    id: run.taskId,
    runId: run.runId || run.taskId,
    sessionKey,
    ownerKey: run.ownerKey,
    agentId: run.agentId || extractAgentIdFromKey(sessionKey) || undefined,
    status: run.status,
    startedAt: run.startedAt ?? run.createdAt,
    completedAt: run.endedAt,
    error: run.error,
    toolName: run.label,
  };
}

/** Does an in-memory task likely correspond to a registry run? */
function matchesRegistryRun(local: Task, run: TaskRun): boolean {
  if (run.runId && local.runId === run.runId) return true;
  if (run.taskId && local.id === run.taskId) return true;
  if (run.childSessionKey && local.sessionKey === run.childSessionKey) return true;
  return false;
}

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

    /**
     * Reconcile in-memory tasks for a given session against the OpenClaw task
     * registry (authoritative source of truth, served via `/api/tasks` by the
     * Express + sidecar combo).
     *
     * For every in-memory task whose agentId matches the session's agent:
     *   - If a registry run matches (by runId / taskId / childSessionKey):
     *     adopt the registry status + taskId + timestamps. Clears provisional.
     *   - If no registry match and the task is provisional (past TTL): drop it.
     *   - Otherwise leave it alone (real run without registry row yet — rare,
     *     but possible for cli/cron races).
     *
     * Additionally: registry rows with no in-memory counterpart are added
     * so the kanban surfaces every task the backend knows about for this
     * session.
     */
    reconcileSessionTasks: async (sessionKey: string) => {
      const sessionAgentId = extractAgentIdFromKey(sessionKey);
      if (!sessionAgentId) return;

      let registry: TaskRun[];
      try {
        registry = await fetchTasks();
      } catch (error) {
        console.warn('[TaskReconcile] failed to fetch registry:', error);
        return;
      }

      // Strict filter: only tasks that directly belong to THIS session.
      //   - ownerKey === sessionKey   → spawned from this session (subagents)
      //   - childSessionKey === sessionKey → delivered to this session (cron)
      // NOT by agent id alone — that over-matches across the agent's whole
      // history (all sessions of bright-helper, not just this one).
      const relevant = registry.filter((run) => {
        return run.ownerKey === sessionKey || run.childSessionKey === sessionKey;
      });

      const { tasks } = get();
      const now = Date.now();
      const registryByKey = new Map<string, TaskRun>();
      for (const run of relevant) {
        if (run.runId) registryByKey.set(`runId:${run.runId}`, run);
        registryByKey.set(`taskId:${run.taskId}`, run);
        if (run.childSessionKey) registryByKey.set(`child:${run.childSessionKey}`, run);
      }

      const matchedRegistryIds = new Set<string>();
      const nextTasks: Task[] = [];
      for (const local of tasks) {
        // Only reconcile tasks that belong to this agent; leave others alone.
        const localAgent = local.agentId || extractAgentIdFromKey(local.sessionKey);
        if (localAgent !== sessionAgentId) {
          nextTasks.push(local);
          continue;
        }

        const run = relevant.find((r) => matchesRegistryRun(local, r));
        if (run) {
          matchedRegistryIds.add(run.taskId);
          nextTasks.push({
            ...local,
            id: run.taskId,
            runId: local.runId || run.runId || run.taskId,
            sessionKey: run.childSessionKey || local.sessionKey,
            ownerKey: run.ownerKey,
            status: run.status,
            startedAt: run.startedAt ?? local.startedAt,
            completedAt: run.endedAt ?? local.completedAt,
            error: run.error ?? local.error,
            toolName: run.label ?? local.toolName,
            provisional: false,
            provisionalUntil: undefined,
          });
          continue;
        }

        // No registry match.
        if (local.provisional && typeof local.provisionalUntil === 'number' && local.provisionalUntil < now) {
          // Expired provisional with no registry backing — drop as orphan.
          continue;
        }
        nextTasks.push(local);
      }

      // Registry rows with no matching in-memory task → add.
      for (const run of relevant) {
        if (matchedRegistryIds.has(run.taskId)) continue;
        nextTasks.push(taskRunToTask(run));
      }

      set({ tasks: nextTasks });
    },

    /**
     * Drop in-memory provisional tasks whose TTL has passed without any
     * confirmation. Safe to call on a short interval.
     */
    reapProvisionalTasks: () => {
      const now = Date.now();
      const { tasks } = get();
      const next = tasks.filter((t) => {
        if (!t.provisional) return true;
        if (typeof t.provisionalUntil !== 'number') return true;
        return t.provisionalUntil >= now;
      });
      if (next.length !== tasks.length) {
        set({ tasks: next });
      }
    },
  };
}
