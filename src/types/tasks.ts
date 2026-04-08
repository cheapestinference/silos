// OpenClaw v2026.4.5 Task and Flow types

export type TaskRunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'timed_out' | 'cancelled' | 'lost';
export type TaskRuntime = 'subagent' | 'acp' | 'cli' | 'cron';

export interface TaskRun {
  taskId: string;
  runtime: TaskRuntime;
  sourceId: string;
  ownerKey: string;
  childSessionKey?: string;
  parentFlowId?: string;
  parentTaskId?: string;
  agentId?: string;
  runId?: string;
  label?: string;
  status: TaskRunStatus;
  deliveryStatus?: string;
  notifyPolicy?: string;
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
  lastEventAt?: number;
  error?: string;
  progressSummary?: string;
  terminalSummary?: string;
  terminalOutcome?: string;
}

export type TaskFlowStatus = 'queued' | 'running' | 'waiting' | 'blocked' | 'succeeded' | 'failed' | 'cancelled' | 'lost';
export type TaskFlowSyncMode = 'task_mirrored' | 'managed';

export interface TaskFlow {
  flowId: string;
  syncMode: TaskFlowSyncMode;
  ownerKey: string;
  status: TaskFlowStatus;
  goal?: string;
  currentStep?: string;
  blockedSummary?: string;
  stateJson?: string;
  waitJson?: string;
  createdAt: number;
  updatedAt?: number;
  endedAt?: number;
}

export interface TaskFlowDetail extends TaskFlow {
  tasks: TaskRun[];
  taskSummary: {
    total: number;
    queued: number;
    running: number;
    succeeded: number;
    failed: number;
    other: number;
  };
}

/**
 * Infer the real runtime from childSessionKey, since the CLI always reports "cli".
 * The session key structure encodes the actual runtime type.
 */
export function inferRuntime(task: TaskRun): TaskRuntime {
  const key = task.childSessionKey || '';
  if (key.includes(':subagent:')) return 'subagent';
  if (key.includes(':cron:')) return 'cron';
  if (key.startsWith('acp:') || task.runtime === 'acp') return 'acp';
  return task.runtime;
}

// Status display config shared across components
export const taskRunStatusConfig: Record<TaskRunStatus, { label: string; color: string; bg: string; icon: string }> = {
  queued:    { label: 'Queued',    color: 'text-gray-500',                          bg: 'bg-gray-500/15',    icon: 'clock' },
  running:   { label: 'Running',   color: 'text-blue-600 dark:text-blue-400',       bg: 'bg-blue-500/15',    icon: 'spinner' },
  succeeded: { label: 'Succeeded', color: 'text-emerald-600 dark:text-emerald-400', bg: 'bg-emerald-500/15', icon: 'check-circle' },
  failed:    { label: 'Failed',    color: 'text-red-600 dark:text-red-400',         bg: 'bg-red-500/15',     icon: 'x-circle' },
  timed_out: { label: 'Timed Out', color: 'text-orange-600 dark:text-orange-400',   bg: 'bg-orange-500/15',  icon: 'clock-alert' },
  cancelled: { label: 'Cancelled', color: 'text-gray-500',                          bg: 'bg-gray-500/15',    icon: 'ban' },
  lost:      { label: 'Lost',      color: 'text-gray-600 dark:text-gray-400',       bg: 'bg-gray-600/15',    icon: 'skull' },
};

export const taskFlowStatusConfig: Record<TaskFlowStatus, { label: string; color: string; bg: string }> = {
  queued:    { label: 'Queued',    color: 'text-gray-500',                          bg: 'bg-gray-500/15' },
  running:   { label: 'Running',   color: 'text-blue-600 dark:text-blue-400',       bg: 'bg-blue-500/15' },
  waiting:   { label: 'Waiting',   color: 'text-amber-600 dark:text-amber-400',     bg: 'bg-amber-500/15' },
  blocked:   { label: 'Blocked',   color: 'text-amber-700 dark:text-amber-300',     bg: 'bg-amber-600/15' },
  succeeded: { label: 'Succeeded', color: 'text-emerald-600 dark:text-emerald-400', bg: 'bg-emerald-500/15' },
  failed:    { label: 'Failed',    color: 'text-red-600 dark:text-red-400',         bg: 'bg-red-500/15' },
  cancelled: { label: 'Cancelled', color: 'text-gray-500',                          bg: 'bg-gray-500/15' },
  lost:      { label: 'Lost',      color: 'text-gray-600 dark:text-gray-400',       bg: 'bg-gray-600/15' },
};
