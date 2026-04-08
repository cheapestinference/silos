import { Terminal, ShieldCheck, Brain, Plug, ArrowDown, Diamond } from 'lucide-react';
import type { LobsterStep } from '../../types/lobster';

interface StepNodeProps {
  step: LobsterStep;
  index: number;
  isLast: boolean;
}

const typeConfig = {
  exec:       { icon: Terminal,     color: 'border-emerald-500/40 bg-emerald-500/5', accent: 'text-emerald-400', label: 'exec' },
  approve:    { icon: ShieldCheck,  color: 'border-amber-500/40 bg-amber-500/5',    accent: 'text-amber-400',   label: 'approval' },
  'llm-task': { icon: Brain,        color: 'border-violet-500/40 bg-violet-500/5',  accent: 'text-violet-400',  label: 'llm-task' },
  invoke:     { icon: Plug,         color: 'border-blue-500/40 bg-blue-500/5',      accent: 'text-blue-400',    label: 'invoke' },
  unknown:    { icon: Terminal,     color: 'border-gray-500/40 bg-gray-500/5',      accent: 'text-gray-400',    label: 'step' },
};

export function StepNode({ step, index, isLast }: StepNodeProps) {
  const config = typeConfig[step.type] || typeConfig.unknown;
  const Icon = config.icon;

  return (
    <div className="flex flex-col items-center">
      {step.condition && (
        <div className="flex items-center gap-2 mb-2 px-3 py-1 bg-amber-500/10 border border-amber-500/20 rounded-md">
          <Diamond className="w-3 h-3 text-amber-400" />
          <span className="text-[10px] text-amber-400 font-mono">{step.condition}</span>
        </div>
      )}

      {step.stdin && (
        <div className="mb-1">
          <span className="text-[9px] text-gray-500 font-mono bg-gray-800/60 px-2 py-0.5 rounded">
            stdin: {step.stdin}
          </span>
        </div>
      )}

      <div className={`w-full max-w-sm border rounded-lg p-3 transition-all hover:shadow-md hover:shadow-black/20 ${config.color}`}>
        <div className="flex items-center gap-2.5">
          <div className={`p-1.5 rounded-md bg-black/20 ${config.accent}`}>
            <Icon className="w-4 h-4" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-[10px] text-gray-500 font-mono">#{index + 1}</span>
              <span className={`text-xs font-semibold ${config.accent}`}>{step.id}</span>
              <span className="text-[9px] px-1.5 py-0.5 rounded bg-black/20 text-gray-500 font-mono">{config.label}</span>
            </div>
            <p className="text-[11px] text-gray-400 font-mono mt-1 truncate" title={step.command}>
              {step.command}
            </p>
          </div>
        </div>

        {step.approval && (
          <div className="mt-2 flex items-center gap-1.5 text-amber-400">
            <ShieldCheck className="w-3 h-3" />
            <span className="text-[10px] font-medium">Approval {step.approval}</span>
          </div>
        )}
      </div>

      {!isLast && (
        <div className="flex flex-col items-center py-1.5 text-gray-700">
          <div className="w-px h-3 bg-gray-700" />
          <ArrowDown className="w-3 h-3" />
        </div>
      )}
    </div>
  );
}
