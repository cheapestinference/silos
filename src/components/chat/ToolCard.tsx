// src/components/chat/ToolCard.tsx
import { memo, useState } from 'react';
import { ChevronDown, Check, Copy, AlertTriangle, Play, Wrench } from 'lucide-react';
import { cn } from '../../lib/utils';
import type { ToolCardView } from '../../lib/content-blocks';

const TOOL_INLINE_THRESHOLD = 120;

interface ToolCardProps {
  card: ToolCardView;
  onExpand?: (card: ToolCardView) => void;
}

export const ToolCard = memo(function ToolCard({ card, onExpand }: ToolCardProps) {
  const [copied, setCopied] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const hasResult = typeof card.resultText === 'string' && card.resultText.length > 0;
  const preview = (card.resultText || '').slice(0, 200);
  const isShort = (card.resultText || '').length <= TOOL_INLINE_THRESHOLD;
  const state: 'running' | 'success' | 'error' = !hasResult ? 'running' : card.isError ? 'error' : 'success';

  const toneBorder =
    state === 'running' ? 'border-amber-500/30'
    : state === 'error' ? 'border-red-500/30'
    : 'border-emerald-500/25';

  const toneHeader =
    state === 'running' ? 'bg-amber-500/5'
    : state === 'error' ? 'bg-red-500/5'
    : 'bg-emerald-500/5';

  const toneIconBg =
    state === 'running' ? 'bg-amber-500/10 text-amber-600 dark:text-amber-400'
    : state === 'error' ? 'bg-red-500/10 text-red-600 dark:text-red-400'
    : 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400';

  const Icon = state === 'error' ? AlertTriangle : state === 'running' ? Play : Wrench;

  const copy = async () => {
    await navigator.clipboard.writeText(card.resultText || JSON.stringify(card.args ?? {}, null, 2));
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className={cn('rounded-lg border bg-card/40 overflow-hidden', toneBorder)}>
      <div className={cn('flex items-center gap-2 px-3 py-2', toneHeader)}>
        <div className={cn('w-6 h-6 rounded flex items-center justify-center shrink-0', toneIconBg)}>
          <Icon className="w-3.5 h-3.5" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-xs font-medium text-foreground truncate">{card.name}</div>
          {!hasResult && <div className="text-[10px] text-muted-foreground">running…</div>}
        </div>
        {hasResult && !isShort && onExpand && (
          <button
            type="button"
            onClick={() => onExpand(card)}
            className="text-[10px] text-muted-foreground hover:text-foreground"
            aria-label="Open in sidebar"
          >
            Open
          </button>
        )}
        {hasResult && (
          <button
            type="button"
            onClick={() => setExpanded(e => !e)}
            className="text-muted-foreground hover:text-foreground"
            aria-label={expanded ? 'Collapse' : 'Expand'}
            aria-expanded={expanded}
          >
            <ChevronDown className={cn('w-4 h-4 transition-transform', expanded && 'rotate-180')} />
          </button>
        )}
      </div>
      {hasResult && expanded && (
        <div className="border-t border-border/40 px-3 py-2 bg-background/30">
          <div className="flex items-center justify-between mb-1">
            <span className="text-[10px] uppercase tracking-wide text-muted-foreground">Output</span>
            <button
              type="button"
              onClick={copy}
              className="text-[10px] text-muted-foreground hover:text-foreground flex items-center gap-1"
              aria-label="Copy output"
            >
              {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
          <pre className="whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-foreground/90 max-h-60 overflow-auto">
            {isShort ? card.resultText : preview + (card.resultText!.length > 200 ? '\n…' : '')}
          </pre>
        </div>
      )}
    </div>
  );
});
