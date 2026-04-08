import type { LobsterFileEntry, LobsterWorkflow, LobsterStep } from '../types/lobster';
import { inferStepType } from '../types/lobster';
import { useDashboardStore } from '../store/dashboard-store';

const API_BASE = '/api';

function getAuthHeaders(): Record<string, string> {
  const token = useDashboardStore.getState().token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: getAuthHeaders() });
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json();
}

export async function fetchLobsterFiles(): Promise<LobsterFileEntry[]> {
  const data = await fetchJson<{ files: LobsterFileEntry[] }>(`${API_BASE}/lobster/files`);
  return data.files || [];
}

export async function fetchLobsterWorkflow(agentId: string, filename: string): Promise<LobsterWorkflow | null> {
  try {
    const data = await fetchJson<{
      agentId: string; filename: string; name: string;
      args?: Record<string, { default?: string; description?: string }>;
      steps: Array<{ id: string; command: string; stdin?: string; condition?: string; approval?: string; env?: Record<string, string> }>;
      raw: string;
    }>(`${API_BASE}/lobster/files/${encodeURIComponent(agentId)}/${encodeURIComponent(filename)}`);

    const steps: LobsterStep[] = data.steps.map(s => ({
      ...s,
      type: inferStepType(s.command, s.approval),
    }));

    return { ...data, steps };
  } catch {
    return null;
  }
}
