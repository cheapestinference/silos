import { Terminal, Ban } from 'lucide-react';
import type { TaskRun } from '../../types/tasks';
import { inferRuntime, taskCancelLookup } from '../../types/tasks';
import { cancelTaskWithFeedback } from '../../lib/tasks-api';
import { ConfirmButton } from './ConfirmButton';

interface GenericTaskInfoProps {
  task: TaskRun;
  onClose?: () => void;
}

export function GenericTaskInfo({ task, onClose: _onClose }: GenericTaskInfoProps) {
  const runtime = inferRuntime(task);
  const isRunning = task.status === 'running';
  return (
    <div className="px-5 py-3 mx-5 mt-2 bg-muted/40 border border-border rounded-lg">
      <div className="flex items-center gap-2">
        <Terminal className="w-4 h-4 text-muted-foreground" />
        <div>
          <p className="text-sm font-semibold text-foreground">
            {task.label || 'Task'}
          </p>
          <p className="text-[11px] text-muted-foreground">Runtime: {runtime}</p>
        </div>
      </div>
      {isRunning && (
        <div className="mt-3 pt-3 border-t border-border">
          <ConfirmButton
            variant="warn"
            icon={<Ban className="w-3 h-3" />}
            confirmLabel="Click to abort"
            onConfirm={() => cancelTaskWithFeedback(taskCancelLookup(task), task.childSessionKey, task.runId)}
          >
            Abort run
          </ConfirmButton>
        </div>
      )}
    </div>
  );
}
