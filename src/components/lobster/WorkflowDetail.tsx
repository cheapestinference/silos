import { ArrowLeft, Play, Terminal, ShieldCheck, Brain, Settings2 } from 'lucide-react';
import type { LobsterWorkflow } from '../../types/lobster';
import { PipelineVisualizer } from './PipelineVisualizer';
import { YamlViewer } from './YamlViewer';
import { useNavigate } from 'react-router-dom';

interface WorkflowDetailProps {
  workflow: LobsterWorkflow;
  onBack: () => void;
}

export function WorkflowDetail({ workflow, onBack }: WorkflowDetailProps) {
  const navigate = useNavigate();

  const handleRun = () => {
    const sessionKey = `agent:${workflow.agentId}:main`;
    navigate(`/session/${sessionKey}?prompt=${encodeURIComponent(`Run the lobster workflow: ${workflow.name}`)}`);
  };

  const approvalCount = workflow.steps.filter(s => s.type === 'approve').length;
  const llmCount = workflow.steps.filter(s => s.type === 'llm-task').length;
  const execCount = workflow.steps.filter(s => s.type === 'exec').length;

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-3 px-6 py-4 border-b border-border shrink-0">
        <button
          onClick={onBack}
          className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
        >
          <ArrowLeft className="w-4 h-4" />
        </button>

        <div className="flex-1 min-w-0">
          <h2 className="text-sm font-semibold text-foreground truncate">{workflow.name}</h2>
          <p className="text-[10px] text-muted-foreground font-mono">{workflow.agentId}/{workflow.filename}</p>
        </div>

        <div className="flex items-center gap-2 text-[10px]">
          <span className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-500">
            <Terminal className="w-3 h-3" />{execCount}
          </span>
          {approvalCount > 0 && (
            <span className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-500">
              <ShieldCheck className="w-3 h-3" />{approvalCount}
            </span>
          )}
          {llmCount > 0 && (
            <span className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-violet-500/10 text-violet-500">
              <Brain className="w-3 h-3" />{llmCount}
            </span>
          )}
        </div>

        <button
          onClick={handleRun}
          className="flex items-center gap-1.5 px-3 py-1.5 bg-primary text-primary-foreground rounded-lg text-xs font-medium hover:bg-primary/90 transition-colors"
        >
          <Play className="w-3.5 h-3.5" />
          Run
        </button>
      </div>

      {workflow.args && Object.keys(workflow.args).length > 0 && (
        <div className="flex items-center gap-2 px-6 py-2 border-b border-border bg-muted/20">
          <Settings2 className="w-3 h-3 text-muted-foreground" />
          <span className="text-[10px] text-muted-foreground">
            Args: {Object.keys(workflow.args).map(k => (
              <span key={k} className="font-mono text-cyan-500 ml-1">{k}</span>
            ))}
          </span>
        </div>
      )}

      <div className="flex-1 flex overflow-hidden">
        <div className="flex-1 overflow-y-auto border-r border-border">
          <PipelineVisualizer steps={workflow.steps} args={workflow.args} />
        </div>

        <div className="w-[40%] shrink-0">
          <YamlViewer content={workflow.raw} />
        </div>
      </div>
    </div>
  );
}
