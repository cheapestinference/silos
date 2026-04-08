import { Settings2 } from 'lucide-react';
import type { LobsterStep } from '../../types/lobster';
import { StepNode } from './StepNode';

interface PipelineVisualizerProps {
  steps: LobsterStep[];
  args?: Record<string, { default?: string; description?: string }>;
}

export function PipelineVisualizer({ steps, args }: PipelineVisualizerProps) {
  return (
    <div className="p-6">
      {args && Object.keys(args).length > 0 && (
        <div className="mb-6 p-3 bg-gray-800/40 border border-gray-700/50 rounded-lg">
          <div className="flex items-center gap-2 mb-2">
            <Settings2 className="w-3.5 h-3.5 text-gray-500" />
            <span className="text-xs font-semibold text-gray-400">Arguments</span>
          </div>
          <div className="space-y-1">
            {Object.entries(args).map(([key, val]) => (
              <div key={key} className="flex items-center gap-2 text-[11px]">
                <span className="text-cyan-400 font-mono">{key}</span>
                {val.default && (
                  <span className="text-gray-600">= <span className="text-gray-500">{val.default}</span></span>
                )}
                {val.description && (
                  <span className="text-gray-600 ml-1">— {val.description}</span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="flex flex-col items-center space-y-0">
        {steps.map((step, i) => (
          <StepNode key={step.id} step={step} index={i} isLast={i === steps.length - 1} />
        ))}
      </div>

      {steps.length === 0 && (
        <p className="text-center text-gray-600 text-sm py-8">No steps defined</p>
      )}
    </div>
  );
}
