import { useState } from 'react';
import { AlertTriangle, AlertCircle, Wrench, Gauge, Wifi, Ban, ChevronDown, ChevronRight, Trash2 } from 'lucide-react';
import { useDashboardStore } from '../../store/dashboard-store';
import { formatDistanceToNow } from 'date-fns';
import type { SessionError, SessionErrorKind } from '../../types/openclaw';
import { cn } from '../../lib/utils';
import { JsonTree } from '../ui/JsonTree';

const EMPTY_ERRORS: SessionError[] = [];

/**
 * Extract the human-readable error text from a nested tool error payload, stripping
 * the boilerplate "SECURITY NOTICE" + "EXTERNAL_UNTRUSTED_CONTENT" framing that the
 * agent sandbox wraps around web fetch responses.
 */
function extractConciseError(raw: unknown, fallback: string): string {
  if (!raw || typeof raw !== 'object') return fallback;
  const r = raw as Record<string, unknown>;
  // Prefer details.error (a string) when present
  const detailsErr = (r.details as Record<string, unknown> | undefined)?.error;
  const candidate = typeof detailsErr === 'string' ? detailsErr : fallback;
  return stripSecurityNotice(candidate);
}

/**
 * OpenClaw tool errors come wrapped as `{content: [{type:'text', text:'<json-string>'}], details: {...}}`.
 * `content` is the LLM-facing wire format (escaped JSON string); `details` is the same
 * data already parsed. Return a cleaner object that prefers `details` when available,
 * falling back to the full raw payload otherwise.
 */
function simplifyToolResult(raw: unknown): { primary: unknown; hasWire: boolean } {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const r = raw as Record<string, unknown>;
    if (r.details && typeof r.details === 'object' && Array.isArray(r.content)) {
      return { primary: r.details, hasWire: true };
    }
  }
  return { primary: raw, hasWire: false };
}

function stripSecurityNotice(s: string): string {
  if (!s) return s;
  // Cut anywhere before the EXTERNAL_UNTRUSTED_CONTENT block starts
  const startIdx = s.indexOf('<<<EXTERNAL_UNTRUSTED_CONTENT');
  const head = startIdx === -1 ? s : s.slice(0, startIdx);
  // Remove the SECURITY NOTICE preamble if it leads
  const cleaned = head
    .replace(/SECURITY NOTICE:[\s\S]*?(?=\n\n|$)/i, '')
    .replace(/^[\s\n]+/, '')
    .trim();
  return cleaned || s.slice(0, 300);
}

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
          <p className="text-xs text-foreground/85 mt-0.5 break-words leading-snug line-clamp-3">
            {extractConciseError(err.raw, err.message || '—')}
          </p>
        </div>
      </button>
      {open && hasRaw && <ExpandedRaw raw={err.raw} />}
    </div>
  );
}

function ExpandedRaw({ raw }: { raw: unknown }) {
  const [showWire, setShowWire] = useState(false);
  const { primary, hasWire } = simplifyToolResult(raw);
  return (
    <div className="px-3 pb-3 pt-1 ml-5 bg-muted/20 border-l-2 border-border/40">
      {hasWire && (
        <div className="flex items-center gap-2 mb-2 text-[10px]">
          <span className={cn("font-semibold", showWire ? "text-muted-foreground/60" : "text-log-info")}>
            {showWire ? 'Raw wire format (escaped)' : 'Parsed details'}
          </span>
          <button
            type="button"
            onClick={() => setShowWire(v => !v)}
            className="px-1.5 py-0.5 rounded text-[10px] text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
          >
            {showWire ? 'show parsed' : 'show raw wire'}
          </button>
        </div>
      )}
      <JsonTree
        data={showWire ? raw : primary}
        unwrapJsonStrings
        defaultCollapseDepth={2}
        rootCopy
      />
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
