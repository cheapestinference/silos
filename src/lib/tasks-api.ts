import type { TaskRun, TaskFlow, TaskFlowDetail } from '../types/tasks';
import { useDashboardStore } from '../store/dashboard-store';

const API_BASE = '/api';

async function fetchJson<T>(url: string): Promise<T> {
  // Read token at call time (not closure time) to get rehydrated value
  const token = useDashboardStore.getState().token;
  if (!token) throw new Error('Not authenticated');
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
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
