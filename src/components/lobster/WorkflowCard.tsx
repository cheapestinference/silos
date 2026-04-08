import { Terminal, ShieldCheck, Brain, Layers, Bot } from 'lucide-react';
import type { LobsterFileEntry } from '../../types/lobster';

interface WorkflowCardProps {
  workflow: LobsterFileEntry;
  onClick: () => void;
}

export function WorkflowCard({ workflow, onClick }: WorkflowCardProps) {
  return (
    <button
      onClick={onClick}
      className="w-full text-left p-4 rounded-xl border border-border bg-card hover:bg-muted/30 hover:border-primary/30 transition-all group"
    >
      <div className="flex items-start gap-3">
        <div className="p-2 rounded-lg bg-gradient-to-br from-orange-500/20 to-amber-500/20 border border-orange-500/20 group-hover:from-orange-500/30 group-hover:to-amber-500/30 transition-all">
          <Layers className="w-5 h-5 text-orange-400" />
        </div>
        <div className="flex-1 min-w-0">
          <h3 className="text-sm font-semibold text-foreground truncate">{workflow.name}</h3>
          <p className="text-[10px] text-muted-foreground font-mono mt-0.5">{workflow.filename}</p>
        </div>
      </div>

      <div className="flex items-center gap-3 mt-3">
        <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
          <Terminal className="w-3 h-3" />
          <span>{workflow.stepCount} steps</span>
        </div>
        {workflow.hasApproval && (
          <div className="flex items-center gap-1 text-[10px] text-amber-500">
            <ShieldCheck className="w-3 h-3" />
            <span>Approval</span>
          </div>
        )}
        {workflow.hasLlmTask && (
          <div className="flex items-center gap-1 text-[10px] text-violet-500">
            <Brain className="w-3 h-3" />
            <span>LLM</span>
          </div>
        )}
      </div>

      <div className="flex items-center gap-1.5 mt-3 text-[10px] text-muted-foreground">
        <Bot className="w-3 h-3" />
        <span className="font-mono">{workflow.agentId}</span>
      </div>
    </button>
  );
}
