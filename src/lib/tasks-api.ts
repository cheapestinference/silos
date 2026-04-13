import type { TaskRun, TaskFlow, TaskFlowDetail } from '../types/tasks';
import { useDashboardStore } from '../store/dashboard-store';
import { getGatewayClient } from './gateway-client';

const API_BASE = '/api';

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const token = useDashboardStore.getState().token;
  const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
  const res = await fetch(url, { ...init, headers: { ...headers, ...(init?.headers || {}) } });
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json();
}

export async function fetchTasks(filters?: { status?: string; runtime?: string }): Promise<TaskRun[]> {
  const params = new URLSearchParams();
  if (filters?.status) params.set('status', filters.status);
  if (filters?.runtime) params.set('runtime', filters.runtime);
  const qs = params.toString();
  const data = await fetchJson<{ tasks: TaskRun[] }>(`${API_BASE}/tasks${qs ? `?${qs}` : ''}`);
  return data.tasks || [];
}

export async function fetchTask(lookup: string): Promise<TaskRun | null> {
  try {
    const data = await fetchJson<{ task: TaskRun }>(`${API_BASE}/tasks/${encodeURIComponent(lookup)}`);
    return data.task || null;
  } catch {
    return null;
  }
}

export async function fetchFlows(): Promise<TaskFlow[]> {
  const data = await fetchJson<{ flows: TaskFlow[] }>(`${API_BASE}/flows`);
  return data.flows || [];
}

export async function fetchFlowDetail(lookup: string): Promise<TaskFlowDetail | null> {
  try {
    const data = await fetchJson<TaskFlowDetail>(`${API_BASE}/flows/${encodeURIComponent(lookup)}`);
    return data || null;
  } catch {
    return null;
  }
}

export interface CancelTaskResult {
  lookup?: string;
  ok?: boolean;
  found?: boolean;
  cancelled?: boolean;
  alreadyDone?: boolean;
  message?: string;
  reason?: string;
  [key: string]: unknown;
}

export async function cancelTask(lookup: string): Promise<CancelTaskResult> {
  return fetchJson<CancelTaskResult>(`${API_BASE}/tasks/${encodeURIComponent(lookup)}/cancel`, {
    method: 'POST',
  });
}

export async function cancelFlow(lookup: string): Promise<CancelTaskResult> {
  return fetchJson<CancelTaskResult>(`${API_BASE}/flows/${encodeURIComponent(lookup)}/cancel`, {
    method: 'POST',
  });
}

export async function cancelFlowWithFeedback(
  lookup: string,
): Promise<{ ok: boolean; message: string }> {
  try {
    const r = await cancelFlow(lookup);
    if (r.cancelled) return { ok: true, message: 'Cancelled' };
    if (r.alreadyDone) return { ok: false, message: 'Already finished' };
    if (r.found === false) return { ok: false, message: 'Flow not found' };
    const reason = r.message || r.reason || 'Cancel failed';
    return { ok: false, message: reason.split('\n')[0].slice(0, 120) };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Best-effort cancel with broad coverage.
 *
 * OpenClaw tracks running work in two places:
 *   1. `chatAbortControllers` (in-memory on the gateway) — chat turns, subagent
 *      runs currently executing. Cancelled via WS `chat.abort(sessionKey, runId)`.
 *   2. Task registry (sqlite on disk) — cron runs, CLI tasks, spawned subagents
 *      with durable records. Cancelled via CLI `tasks cancel <lookup>` through
 *      the tasks sidecar.
 *
 * A given UI task may be in either (or both). We try chat.abort first because
 * (a) it's instant and in-process, (b) it catches the common case of an active
 * LLM turn, and (c) the registry fallback is harmless if the first one worked.
 *
 * Returns `{ok, message}` with a user-friendly summary. Never throws.
 */
export async function cancelTaskWithFeedback(
  lookup: string,
  sessionKey?: string,
  runId?: string,
): Promise<{ ok: boolean; message: string }> {
  // 1) Try chat.abort if we have a live session+runId. Succeeds for any chat
  //    turn currently executing (including subagent turns).
  if (sessionKey && runId) {
    try {
      const client = getGatewayClient();
      if (client) {
        const r = (await client.abortChat(sessionKey, runId)) as {
          ok?: boolean; aborted?: boolean;
        };
        if (r?.aborted === true) return { ok: true, message: 'Aborted' };
      }
    } catch {
      // Fall through to sidecar.
    }
  }

  // 2) Fallback: registry cancel via the tasks sidecar (cron / cli / registered
  //    subagents).
  try {
    const r = await cancelTask(lookup);
    if (r.cancelled) return { ok: true, message: 'Cancelled' };
    if (r.alreadyDone) return { ok: false, message: 'Already finished' };
    if (r.found === false) {
      return {
        ok: false,
        message: 'Not trackable — try Delete session',
      };
    }
    const reason = r.message || r.reason || 'Cancel failed';
    return { ok: false, message: reason.split('\n')[0].slice(0, 120) };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}
