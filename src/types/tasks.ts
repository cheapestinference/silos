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
  // cron runs have a distinctive runId prefix (e.g. "cron:<jobId>:<ts>"), even when
  // their childSessionKey is null (sessionTarget: "main" writes to shared session).
  if (task.runId?.startsWith('cron:')) return 'cron';
  const key = task.childSessionKey || '';
  if (key.startsWith('acp:') || task.runtime === 'acp') return 'acp';
  if (key.includes(':subagent:')) return 'subagent';
  if (key.includes(':cron:')) return 'cron';
  return task.runtime;
}

/**
 * For cron tasks, extract the jobId from the runId.
 * runId format: "cron:<jobId>:<tsMs>" where jobId is a plain UUID (no inner colons).
 */
export function extractCronJobId(task: TaskRun): string | undefined {
  if (!task.runId?.startsWith('cron:')) return undefined;
  const parts = task.runId.split(':');
  return parts.length >= 3 ? parts[1] : undefined;
}

/**
 * Resolve the best identifier to send to `openclaw tasks cancel <lookup>`.
 *
 * The `taskId` we hold in the store is often a client-generated UUID from
 * `handleTaskTracking` and does NOT exist in the openclaw task registry.
 * The CLI accepts task id, run id, or session key — runId is the most
 * reliable because it's emitted verbatim by the gateway lifecycle events.
 */
export function taskCancelLookup(task: TaskRun): string {
  return task.runId || task.childSessionKey || task.taskId;
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
