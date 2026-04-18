import { useState } from 'react';
import { ChevronDown, Check, Copy, Link2 } from 'lucide-react';
import { cn } from '../../lib/utils';
import type { InterSessionEventMeta } from '../../types/openclaw';

interface InterSessionEventCardProps {
  meta: InterSessionEventMeta;
  timestamp?: number;
}

function shortSessionKey(key: string | undefined): string | null {
  if (!key) return null;
  const parts = key.split(':');
  // agent:bright-helper:subagent:<uuid> → show last two segments compactly
  if (parts.length >= 2) {
    const tail = parts[parts.length - 1];
    const short = tail.length > 12 ? `${tail.slice(0, 8)}…` : tail;
    return `${parts[parts.length - 2]}:${short}`;
  }
  return key.length > 24 ? `${key.slice(0, 20)}…` : key;
}

function statusTone(status: string | undefined): 'success' | 'error' | 'warn' | 'neutral' {
  if (!status) return 'neutral';
  const s = status.toLowerCase();
  if (/(success|ok|done|completed|finished)/.test(s)) return 'success';
  if (/(fail|error|denied|aborted)/.test(s)) return 'error';
  if (/(warn|retry|pending|running)/.test(s)) return 'warn';
  return 'neutral';
}

export function InterSessionEventCard({ meta, timestamp }: InterSessionEventCardProps) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);

  const title = meta.task || meta.announceType || 'Inter-session event';
  const source = shortSessionKey(meta.sourceSessionKey) || meta.sourceTool || 'subagent';
  const tone = statusTone(meta.status);

  const bodyText =
    (meta.result && meta.result.trim()) ||
    (meta.replyInstruction && meta.replyInstruction.trim()) ||
    '';

  const timeLabel = timestamp
    ? new Date(timestamp).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    : null;

  const handleCopy = async () => {
    await navigator.clipboard.writeText(bodyText || title);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const toneBorder =
    tone === 'success' ? 'border-emerald-500/25' :
    tone === 'error' ? 'border-red-500/25' :
    tone === 'warn' ? 'border-amber-500/25' :
    'border-indigo-500/20';

  const toneBg =
    tone === 'success' ? 'bg-emerald-500/5 hover:bg-emerald-500/10' :
    tone === 'error' ? 'bg-red-500/5 hover:bg-red-500/10' :
    tone === 'warn' ? 'bg-amber-500/5 hover:bg-amber-500/10' :
    'bg-indigo-500/5 hover:bg-indigo-500/10';

  const toneIcon =
    tone === 'success' ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400' :
    tone === 'error' ? 'bg-red-500/10 text-red-600 dark:text-red-400' :
    tone === 'warn' ? 'bg-amber-500/10 text-amber-600 dark:text-amber-400' :
    'bg-indigo-500/10 text-indigo-600 dark:text-indigo-400';

  return (
    <div className="max-w-2xl w-full">
      <div className={cn('rounded-lg overflow-hidden transition-colors border bg-card/40 backdrop-blur-sm', toneBorder)}>
        <button
          type="button"
          onClick={() => setExpanded(e => !e)}
          className={cn('w-full flex items-center justify-between px-3 py-2 transition-colors', toneBg)}
          aria-expanded={expanded}
          aria-label={expanded ? 'Collapse subagent event' : 'Expand subagent event'}
        >
          <div className="flex items-center gap-2 min-w-0">
            <div className={cn('w-6 h-6 rounded flex items-center justify-center shrink-0', toneIcon)}>
              <Link2 className="w-3.5 h-3.5" />
            </div>
            <div className="flex flex-col items-start min-w-0">
              <span className="text-xs font-medium text-foreground truncate max-w-[40ch]">{title}</span>
              <span className="text-[10px] text-muted-foreground truncate max-w-[40ch]">
                {source}
                {meta.status ? <span className="ml-1 opacity-80">· {meta.status}</span> : null}
                {timeLabel ? <span className="ml-1 opacity-60">· {timeLabel}</span> : null}
              </span>
            </div>
          </div>
          <ChevronDown
            className={cn('w-4 h-4 text-muted-foreground transition-transform shrink-0', expanded && 'rotate-180')}
          />
        </button>

        {expanded && (
          <div className="border-t border-border/40 px-3 py-2 bg-background/30 text-xs text-foreground space-y-2">
            {meta.result ? (
              <div>
                <div className="flex items-center justify-between mb-1">
                  <span className="text-[10px] uppercase tracking-wide text-muted-foreground">Result</span>
                  <button
                    type="button"
                    onClick={handleCopy}
                    className="text-[10px] text-muted-foreground hover:text-foreground flex items-center gap-1"
                    aria-label="Copy result"
                  >
                    {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
                    {copied ? 'Copied' : 'Copy'}
                  </button>
                </div>
                <pre className="whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-foreground/90 max-h-64 overflow-auto">
                  {meta.result}
                </pre>
              </div>
            ) : null}

            {meta.replyInstruction ? (
              <details>
                <summary className="text-[10px] uppercase tracking-wide text-muted-foreground cursor-pointer hover:text-foreground">
                  Action / reply instruction
                </summary>
                <pre className="mt-1 whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-foreground/80 max-h-40 overflow-auto">
                  {meta.replyInstruction}
                </pre>
              </details>
            ) : null}

            {(meta.sourceSessionKey || meta.announceType) ? (
              <div className="flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-muted-foreground pt-1 border-t border-border/30">
                {meta.sourceSessionKey ? (
                  <span><span className="opacity-60">session:</span> {meta.sourceSessionKey}</span>
                ) : null}
                {meta.announceType ? (
                  <span><span className="opacity-60">type:</span> {meta.announceType}</span>
                ) : null}
                {meta.sourceChannel ? (
                  <span><span className="opacity-60">channel:</span> {meta.sourceChannel}</span>
                ) : null}
              </div>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}
