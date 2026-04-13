import { useState } from 'react';
import { Loader2, CheckCircle2, XCircle } from 'lucide-react';

export type ConfirmResult =
  | { ok: true;  message?: string }
  | { ok: false; message: string };

interface ConfirmButtonProps {
  children: React.ReactNode;
  confirmLabel: string;
  /**
   * Invoked after the second click. Return a {ok, message} to show inline
   * feedback; returning void is treated as `{ok: true}`. Throws are caught
   * and surfaced as `{ok: false, message: err.message}`.
   */
  onConfirm: () => Promise<ConfirmResult | void> | ConfirmResult | void;
  variant?: 'danger' | 'warn' | 'neutral';
  icon?: React.ReactNode;
  className?: string;
  disabled?: boolean;
}

/**
 * Destructive-action button with inline two-step confirmation and result feedback.
 * First click enters "armed" state showing `confirmLabel` and tinted styling.
 * Second click invokes `onConfirm`; a spinner shows while the promise resolves.
 * The result message (success or error) is shown next to the button for 4s.
 */
export function ConfirmButton({
  children,
  confirmLabel,
  onConfirm,
  variant = 'danger',
  icon,
  className,
  disabled,
}: ConfirmButtonProps) {
  const [armed, setArmed] = useState(false);
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<ConfirmResult | null>(null);

  const variantClasses = {
    danger: armed
      ? 'bg-red-500 text-white hover:bg-red-600'
      : 'bg-red-500/10 text-red-600 dark:text-red-400 hover:bg-red-500/20 border border-red-500/20',
    warn: armed
      ? 'bg-amber-500 text-white hover:bg-amber-600'
      : 'bg-amber-500/10 text-amber-600 dark:text-amber-400 hover:bg-amber-500/20 border border-amber-500/20',
    neutral: armed
      ? 'bg-foreground text-background'
      : 'bg-muted text-foreground hover:bg-muted/80 border border-border',
  }[variant];

  const handleClick = async () => {
    if (disabled || pending) return;
    if (!armed) {
      setArmed(true);
      setResult(null);
      setTimeout(() => setArmed(false), 3000);
      return;
    }
    setArmed(false);
    setPending(true);
    let outcome: ConfirmResult;
    try {
      const ret = await onConfirm();
      outcome = ret && typeof ret === 'object' && 'ok' in ret ? ret : { ok: true };
    } catch (err) {
      outcome = { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
    setResult(outcome);
    setPending(false);
    setTimeout(() => setResult(null), 4000);
  };

  return (
    <span className="inline-flex items-center gap-1.5">
      <button
        onClick={handleClick}
        disabled={disabled || pending}
        className={`inline-flex items-center gap-1 px-2 py-1 rounded text-[11px] font-medium transition-colors ${variantClasses} ${
          disabled || pending ? 'opacity-50 cursor-not-allowed' : ''
        } ${className || ''}`}
      >
        {pending ? <Loader2 className="w-3 h-3 animate-spin" /> : icon}
        <span>{armed ? confirmLabel : children}</span>
      </button>
      {result && (
        <span
          className={`inline-flex items-center gap-1 text-[10px] ${
            result.ok ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'
          }`}
          title={result.message || ''}
        >
          {result.ok ? <CheckCircle2 className="w-3 h-3" /> : <XCircle className="w-3 h-3" />}
          <span className="max-w-[180px] truncate">
            {result.message || (result.ok ? 'Done' : 'Error')}
          </span>
        </span>
      )}
    </span>
  );
}
