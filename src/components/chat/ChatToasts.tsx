import { useEffect, useMemo, useState } from 'react';
import { Loader2, Zap, X } from 'lucide-react';
import { cn } from '../../lib/utils';
import type { CompactionStatus, FallbackStatus } from '../../types/openclaw';

interface ChatToastsProps {
  compaction?: CompactionStatus | null;
  fallback?: FallbackStatus | null;
}

interface Toast {
  id: string;
  kind: 'compaction' | 'fallback';
  title: string;
  detail?: string;
  tone: 'amber' | 'blue';
  sticky: boolean;
}

/**
 * Stacked bottom-right toasts for transient chat-run status (compaction +
 * fallback). Compaction is amber with a spinner; fallback is blue with the
 * model name. Auto-dismiss non-sticky toasts after 4s. Sticky toasts persist
 * until the underlying status changes (e.g. compaction exits `retrying`, or
 * the run completes and the store clears the map).
 */
export function ChatToasts({ compaction, fallback }: ChatToastsProps) {
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());

  // Compute toasts from props. Memoize so the dismiss effect below doesn't
  // re-run on every render (which would trip the timer and never fire).
  const toasts: Toast[] = useMemo(() => {
    const out: Toast[] = [];
    if (compaction) {
      out.push({
        id: `comp-${compaction.phase}-${compaction.attemptIndex ?? ''}`,
        kind: 'compaction',
        title: compaction.phase === 'retrying' ? 'Compaction retrying' : 'Compacting session…',
        detail: compaction.attemptIndex !== undefined ? `Attempt ${compaction.attemptIndex}` : undefined,
        tone: 'amber',
        sticky: compaction.phase === 'retrying',
      });
    }
    if (fallback && fallback.attempts.length > 0) {
      const last = fallback.attempts[fallback.attempts.length - 1];
      out.push({
        id: `fb-${last.model}-${last.ts}`,
        kind: 'fallback',
        title: `Falling back: ${last.model}`,
        detail: last.reason,
        tone: 'blue',
        sticky: true,
      });
    }
    return out;
  }, [compaction, fallback]);

  // Auto-dismiss non-sticky toasts after 4s. Scheduled once per toast id —
  // the memoized `toasts` array means re-renders with unchanged status won't
  // clear the existing timer and re-enqueue it.
  useEffect(() => {
    const timers: ReturnType<typeof setTimeout>[] = [];
    for (const t of toasts) {
      if (t.sticky) continue;
      if (dismissed.has(t.id)) continue;
      const timer = setTimeout(() => {
        setDismissed((prev) => {
          const next = new Set(prev);
          next.add(t.id);
          return next;
        });
      }, 4000);
      timers.push(timer);
    }
    return () => { for (const t of timers) clearTimeout(t); };
  }, [toasts, dismissed]);

  const visible = toasts.filter((t) => !dismissed.has(t.id));
  if (visible.length === 0) return null;

  return (
    <div className="fixed bottom-4 right-4 z-40 flex flex-col gap-2 pointer-events-none">
      {visible.map((t) => {
        const toneBorder = t.tone === 'amber' ? 'border-amber-500/30' : 'border-blue-500/30';
        const toneBg = t.tone === 'amber' ? 'bg-amber-500/10' : 'bg-blue-500/10';
        const toneText = t.tone === 'amber'
          ? 'text-amber-700 dark:text-amber-300'
          : 'text-blue-700 dark:text-blue-300';
        return (
          <div
            key={t.id}
            className={cn(
              'pointer-events-auto min-w-[14rem] max-w-sm rounded-lg border shadow-sm backdrop-blur-sm',
              toneBorder,
              toneBg,
              'px-3 py-2 flex items-center gap-2',
            )}
            role="status"
            aria-live="polite"
          >
            {t.kind === 'compaction' ? (
              <Loader2 className={cn('w-4 h-4 animate-spin shrink-0', toneText)} />
            ) : (
              <Zap className={cn('w-4 h-4 shrink-0', toneText)} />
            )}
            <div className="flex-1 min-w-0">
              <div className={cn('text-xs font-medium', toneText)}>{t.title}</div>
              {t.detail ? (
                <div className="text-[10px] text-muted-foreground truncate">{t.detail}</div>
              ) : null}
            </div>
            <button
              type="button"
              onClick={() => setDismissed((prev) => {
                const next = new Set(prev);
                next.add(t.id);
                return next;
              })}
              className="text-muted-foreground hover:text-foreground shrink-0"
              aria-label="Dismiss"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
