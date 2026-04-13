import { useState } from 'react';
import { AlertTriangle, AlertCircle, Wrench, Gauge, Wifi, Ban, ChevronDown, ChevronRight, Trash2 } from 'lucide-react';
import { useDashboardStore } from '../../store/dashboard-store';
import { formatDistanceToNow } from 'date-fns';
import type { SessionError, SessionErrorKind } from '../../types/openclaw';
import { cn } from '../../lib/utils';

const EMPTY_ERRORS: SessionError[] = [];

const KIND_META: Record<SessionErrorKind, { label: string; icon: React.ComponentType<{ className?: string }>; tone: string }> = {
  provider:   { label: 'Provider',   icon: AlertCircle,    tone: 'text-log-error bg-log-error/10 border-log-error/20' },
  rate_limit: { label: 'Rate Limit', icon: Gauge,          tone: 'text-log-warn bg-log-warn/15 border-log-warn/25' },
  tool:       { label: 'Tool',       icon: Wrench,         tone: 'text-log-warn bg-log-warn/10 border-log-warn/20' },
  chat:       { label: 'Chat',       icon: AlertTriangle,  tone: 'text-log-error bg-log-error/10 border-log-error/20' },
  network:    { label: 'Network',    icon: Wifi,           tone: 'text-log-error bg-log-error/10 border-log-error/20' },
  aborted:    { label: 'Aborted',    icon: Ban,            tone: 'text-muted-foreground bg-muted border-border' },
  unknown:    { label: 'Unknown',    icon: AlertCircle,    tone: 'text-muted-foreground bg-muted border-border' },
};

function ErrorRow({ err }: { err: SessionError }) {
  const [open, setOpen] = useState(false);
  const meta = KIND_META[err.kind] || KIND_META.unknown;
  const Icon = meta.icon;
  const when = formatDistanceToNow(err.timestamp, { addSuffix: true });

  const hasRaw = err.raw !== undefined && err.raw !== null;

  return (
    <div className="border-b border-border/50 last:border-b-0">
      <button
        type="button"
        onClick={() => hasRaw && setOpen(o => !o)}
        className={cn(
          "w-full flex items-start gap-2 px-3 py-2 text-left transition-colors",
          hasRaw ? "hover:bg-muted/40 cursor-pointer" : "cursor-default"
        )}
      >
        {hasRaw ? (
          open ? <ChevronDown className="w-3 h-3 mt-1 shrink-0 text-muted-foreground" />
               : <ChevronRight className="w-3 h-3 mt-1 shrink-0 text-muted-foreground" />
        ) : (
          <span className="w-3 h-3 mt-1 shrink-0" />
        )}
        <Icon className={cn("w-3.5 h-3.5 mt-0.5 shrink-0", meta.tone.split(' ')[0])} />
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-2 flex-wrap">
            <span className={cn("px-1.5 py-0.5 rounded text-[9px] font-bold uppercase tracking-wider border", meta.tone)}>
              {meta.label}
            </span>
            <span className="text-[10px] font-mono text-muted-foreground/70 truncate">{err.source}</span>
            {err.toolName && (
              <span className="text-[10px] font-mono text-log-subsystem">{err.toolName}</span>
            )}
            <span className="text-[10px] text-muted-foreground/50 ml-auto shrink-0">{when}</span>
          </div>
          <p className="text-xs text-foreground/85 mt-0.5 break-words leading-snug">
            {err.message || '—'}
          </p>
        </div>
      </button>
      {open && hasRaw && (
        <pre className="px-3 pb-3 pt-0 text-[10px] font-mono text-muted-foreground/80 whitespace-pre-wrap break-words bg-muted/20 border-l-2 border-border/40 ml-5">
          {(() => {
            try {
              return typeof err.raw === 'string' ? err.raw : JSON.stringify(err.raw, null, 2);
            } catch {
              return String(err.raw);
            }
          })()}
        </pre>
      )}
    </div>
  );
}

export function SessionErrorsPanel({ sessionKey }: { sessionKey: string }) {
  const errors = useDashboardStore(s => s.sessionErrors.get(sessionKey) ?? EMPTY_ERRORS);
  const clearSessionErrors = useDashboardStore(s => s.clearSessionErrors);

  if (errors.length === 0) {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-3 px-6 text-center">
        <div className="w-12 h-12 rounded-full bg-muted/60 flex items-center justify-center">
          <AlertCircle className="w-5 h-5 text-muted-foreground/60" />
        </div>
        <div>
          <p className="text-sm font-medium text-foreground">No errors captured</p>
          <p className="text-xs text-muted-foreground mt-0.5">
            Tool failures, rate limits, and provider errors will appear here.
          </p>
        </div>
      </div>
    );
  }

  const sorted = [...errors].sort((a, b) => b.timestamp - a.timestamp);
  const byKind = errors.reduce<Record<string, number>>((acc, e) => {
    acc[e.kind] = (acc[e.kind] || 0) + 1;
    return acc;
  }, {});

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border/60 shrink-0">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          {errors.length} total
        </span>
        <div className="flex items-center gap-1 flex-wrap">
          {Object.entries(byKind).map(([kind, count]) => {
            const meta = KIND_META[kind as SessionErrorKind] || KIND_META.unknown;
            return (
              <span
                key={kind}
                className={cn("px-1.5 py-0.5 rounded text-[9px] font-semibold uppercase tracking-wider border", meta.tone)}
              >
                {meta.label} {count}
              </span>
            );
          })}
        </div>
        <button
          type="button"
          onClick={() => clearSessionErrors(sessionKey)}
          className="ml-auto p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
          title="Clear errors"
        >
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      </div>
      <div className="flex-1 overflow-y-auto">
        {sorted.map(err => <ErrorRow key={err.id} err={err} />)}
      </div>
    </div>
  );
}
