import { Plug, Bot, Ban, Trash2 } from 'lucide-react';
import type { TaskRun } from '../../types/tasks';
import { taskCancelLookup } from '../../types/tasks';
import { getGatewayClient } from '../../lib/gateway-client';
import { cancelTaskWithFeedback } from '../../lib/tasks-api';
import { ConfirmButton } from './ConfirmButton';

const HARNESS_KEYWORDS = ['codex', 'claudecode', 'claude-code', 'gemini', 'cursor', 'aider'];

function detectHarness(task: TaskRun): string | undefined {
  const haystack = `${task.agentId || ''} ${task.childSessionKey || ''} ${task.label || ''}`.toLowerCase();
  return HARNESS_KEYWORDS.find((k) => haystack.includes(k));
}

interface AcpInfoProps {
  task: TaskRun;
  onNavigateToSession?: (sessionKey: string) => void;
  onClose?: () => void;
}

export function AcpInfo({ task, onNavigateToSession, onClose }: AcpInfoProps) {
  const harness = detectHarness(task);
  const thread = task.childSessionKey;
  const isRunning = task.status === 'running';

  return (
    <div className="px-5 py-3 mx-5 mt-2 bg-purple-500/5 border border-purple-500/20 rounded-lg">
      <div className="flex items-center gap-2 mb-3">
        <Plug className="w-4 h-4 text-purple-600 dark:text-purple-400" />
        <div>
          <p className="text-sm font-semibold text-foreground">ACP Harness</p>
          <p className="text-[11px] text-muted-foreground">Agent Control Protocol — external runner</p>
        </div>
      </div>

      <div className="space-y-2 text-xs">
        {harness && (
          <div className="flex items-center gap-2">
            <span className="text-[10px] text-muted-foreground uppercase tracking-wide w-16">Harness</span>
            <span className="inline-flex px-1.5 py-0.5 rounded bg-purple-500/10 text-purple-700 dark:text-purple-300 font-medium">
              {harness}
            </span>
          </div>
        )}
        {task.agentId && (
          <div className="flex items-center gap-2">
            <Bot className="w-3 h-3 text-muted-foreground" />
            <span className="text-[10px] text-muted-foreground uppercase tracking-wide w-16">Agent</span>
            <span className="font-mono text-foreground">{task.agentId}</span>
          </div>
        )}
        {thread && (
          <div className="flex items-center gap-2">
            <span className="text-[10px] text-muted-foreground uppercase tracking-wide w-16">Thread</span>
            <button
              className="font-mono text-foreground hover:text-primary underline decoration-dotted truncate"
              onClick={() => onNavigateToSession?.(thread)}
              disabled={!onNavigateToSession}
            >
              {thread}
            </button>
          </div>
        )}
      </div>

      <div className="mt-3 pt-3 border-t border-purple-500/10 flex flex-wrap items-center gap-2">
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
        {thread && (
          <ConfirmButton
            variant="danger"
            icon={<Trash2 className="w-3 h-3" />}
            confirmLabel="Click to confirm"
            onConfirm={async () => {
              const client = getGatewayClient();
              if (!client) return;
              await client.deleteSession(thread);
              onClose?.();
            }}
          >
            Delete thread
          </ConfirmButton>
        )}
      </div>
    </div>
  );
}
