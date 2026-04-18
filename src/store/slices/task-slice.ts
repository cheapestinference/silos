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

      // 1-to-1 matching. Iterate registry runs and claim AT MOST one
      // not-yet-claimed local task per run. This prevents the prior bug
      // where N cron tasks all share childSessionKey === sessionKey and
      // the first-match-wins `find()` assigned the same registry taskId
      // to every local cron, producing duplicates.
      const usedLocalIdx = new Set<number>();
      const matchedRegistryIds = new Set<string>();
      const nextTasks: Task[] = [];

      // Pass 1: every relevant registry run becomes a task in the output,
      // merging in one local match if we can find one.
      for (const run of relevant) {
        let localIdx = -1;
        for (let i = 0; i < tasks.length; i++) {
          if (usedLocalIdx.has(i)) continue;
          const local = tasks[i];
          const localAgent = local.agentId || extractAgentIdFromKey(local.sessionKey);
          if (localAgent !== sessionAgentId) continue;
          if (matchesRegistryRun(local, run)) {
            localIdx = i;
            break;
          }
        }
        const local = localIdx !== -1 ? tasks[localIdx] : undefined;
        if (localIdx !== -1) usedLocalIdx.add(localIdx);
        matchedRegistryIds.add(run.taskId);
        const sessionKeyOut = run.childSessionKey || local?.sessionKey || run.ownerKey;
        nextTasks.push({
          ...(local || {}),
          id: run.taskId,
          runId: local?.runId || run.runId || run.taskId,
          sessionKey: sessionKeyOut,
          ownerKey: run.ownerKey,
          agentId:
            local?.agentId ||
            run.agentId ||
            extractAgentIdFromKey(sessionKeyOut) ||
            undefined,
          status: run.status,
          startedAt: run.startedAt ?? local?.startedAt ?? run.createdAt,
          completedAt: run.endedAt ?? local?.completedAt,
          error: run.error ?? local?.error,
          toolName: run.label ?? local?.toolName,
          provisional: false,
          provisionalUntil: undefined,
        });
      }

      // Pass 2: locals we didn't claim in pass 1.
      //   - Tasks for a different agent → keep untouched (not our concern).
      //   - Semantic duplicates of an already-claimed registry run → drop.
      //     Happens when >1 local shares a sessionKey that matches a registry
      //     run (e.g. multiple client cron tasks with childSessionKey === S;
      //     pass 1 claims one per run, pass 2 drops the rest).
      //   - Same-agent provisionals past TTL without registry backing → drop.
      //   - Everything else same-agent → keep (may be a freshly-spawned run
      //     that the registry hasn't surfaced yet; next reconcile catches it).
      for (let i = 0; i < tasks.length; i++) {
        if (usedLocalIdx.has(i)) continue;
        const local = tasks[i];
        const localAgent = local.agentId || extractAgentIdFromKey(local.sessionKey);
        if (localAgent !== sessionAgentId) {
          nextTasks.push(local);
          continue;
        }
        if (relevant.some((r) => matchesRegistryRun(local, r))) {
          // A registry run represents this task; pass 1 already emitted it.
          continue;
        }
        if (
          local.provisional &&
          typeof local.provisionalUntil === 'number' &&
          local.provisionalUntil < now
        ) {
          continue;
        }
        nextTasks.push(local);
      }

      // Finally, dedupe by id as a belt-and-braces measure.
      const byId = new Map<string, Task>();
      for (const t of nextTasks) {
        byId.set(t.id, t);
      }
      set({ tasks: Array.from(byId.values()) });

      // Matched-registry accounting retained for future metrics/logging.
      void matchedRegistryIds;
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
