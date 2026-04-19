// src/components/chat/ThinkingBlock.tsx
import { memo, useState } from 'react';
import { ChevronRight, Brain } from 'lucide-react';
import { cn } from '../../lib/utils';

interface ThinkingBlockProps {
  thinking: string;
  /** When true, render expanded by default. */
  defaultExpanded?: boolean;
}

export const ThinkingBlock = memo(function ThinkingBlock({ thinking, defaultExpanded = false }: ThinkingBlockProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const trimmed = thinking.trim();
  if (!trimmed) return null;

  return (
    <div className="my-2 border-l-2 border-indigo-500/30 pl-3 text-xs">
      <button
        type="button"
        onClick={() => setExpanded(e => !e)}
        className={cn(
          'flex items-center gap-1.5 text-[10px] uppercase tracking-wide',
          'text-muted-foreground hover:text-foreground transition-colors',
        )}
        aria-expanded={expanded}
        aria-label={expanded ? 'Collapse reasoning' : 'Expand reasoning'}
      >
        <Brain className="w-3 h-3" />
        <span>Reasoning</span>
        <ChevronRight className={cn('w-3 h-3 transition-transform', expanded && 'rotate-90')} />
      </button>
      {expanded && (
        <div className="mt-1.5 italic text-muted-foreground whitespace-pre-wrap break-words leading-relaxed">
          {trimmed}
        </div>
      )}
    </div>
  );
});
