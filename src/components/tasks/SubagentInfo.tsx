import { Bot, CornerDownRight, Wrench, Ban, Trash2 } from 'lucide-react';
import type { TaskRun } from '../../types/tasks';
import { taskCancelLookup } from '../../types/tasks';
import { getGatewayClient } from '../../lib/gateway-client';
import { cancelTaskWithFeedback } from '../../lib/tasks-api';
import { ConfirmButton } from './ConfirmButton';

interface SubagentInfoProps {
  task: TaskRun;
  onNavigateToSession?: (sessionKey: string) => void;
  onClose?: () => void;
}

function extractParentSessionKey(task: TaskRun): string | undefined {
  // ownerKey for subagent runs is the parent session key (e.g. "agent:alice:hi")
  if (task.ownerKey && task.ownerKey.startsWith('agent:') && !task.ownerKey.includes(':subagent:')) {
    return task.ownerKey;
  }
  return undefined;
}

export function SubagentInfo({ task, onNavigateToSession, onClose }: SubagentInfoProps) {
  const parent = extractParentSessionKey(task);
  const child = task.childSessionKey;
  const isRunning = task.status === 'running';

  return (
    <div className="px-5 py-3 mx-5 mt-2 bg-indigo-500/5 border border-indigo-500/20 rounded-lg">
      <div className="flex items-center gap-2 mb-3">
        <Bot className="w-4 h-4 text-indigo-600 dark:text-indigo-400" />
        <div>
          <p className="text-sm font-semibold text-foreground">{task.label || 'Subagent Run'}</p>
          <p className="text-[11px] text-muted-foreground">Spawned by another agent</p>
        </div>
      </div>

      <div className="space-y-2 text-xs">
        {task.agentId && (
          <div className="flex items-center gap-2">
            <Bot className="w-3 h-3 text-muted-foreground" />
            <span className="text-[10px] text-muted-foreground uppercase tracking-wide w-16">Agent</span>
            <span className="font-mono text-foreground">{task.agentId}</span>
          </div>
        )}
        {parent && (
          <div className="flex items-center gap-2">
            <CornerDownRight className="w-3 h-3 text-muted-foreground rotate-180" />
            <span className="text-[10px] text-muted-foreground uppercase tracking-wide w-16">Parent</span>
            <button
              className="font-mono text-foreground hover:text-primary underline decoration-dotted truncate"
              onClick={() => onNavigateToSession?.(parent)}
              disabled={!onNavigateToSession}
            >
              {parent}
            </button>
          </div>
        )}
        {child && (
          <div className="flex items-center gap-2">
            <CornerDownRight className="w-3 h-3 text-muted-foreground" />
            <span className="text-[10px] text-muted-foreground uppercase tracking-wide w-16">Child</span>
            <button
              className="font-mono text-foreground hover:text-primary underline decoration-dotted truncate"
              onClick={() => onNavigateToSession?.(child)}
              disabled={!onNavigateToSession}
            >
              {child}
            </button>
          </div>
        )}
        {task.label && (
          <div className="flex items-center gap-2">
            <Wrench className="w-3 h-3 text-muted-foreground" />
            <span className="text-[10px] text-muted-foreground uppercase tracking-wide w-16">Tool</span>
            <span className="font-mono text-foreground">{task.label}</span>
          </div>
        )}
      </div>

      <div className="mt-3 pt-3 border-t border-indigo-500/10 flex flex-wrap items-center gap-2">
        {isRunning && (
          <ConfirmButton
            variant="warn"
            icon={<Ban className="w-3 h-3" />}
            confirmLabel="Click to abort"
            onConfirm={() => cancelTaskWithFeedback(taskCancelLookup(task), task.childSessionKey, task.runId)}
          >
            Abort run
          </ConfirmButton>
        )}
        {child && (
          <ConfirmButton
            variant="danger"
            icon={<Trash2 className="w-3 h-3" />}
            confirmLabel="Click to confirm"
            onConfirm={async () => {
              const client = getGatewayClient();
              if (!client) return;
              await client.deleteSession(child);
              onClose?.();
            }}
          >
            Delete session
          </ConfirmButton>
        )}
      </div>
    </div>
  );
}
