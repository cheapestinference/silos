import { cn } from '../../lib/utils';

/** Small inline spinner for buttons and status indicators */
export function Spinner({ className = 'border-primary/40' }: { className?: string }) {
  return (
    <div className={cn('w-3 h-3 border-2 border-t-transparent rounded-full animate-spin', className)} />
  );
}

/** Uppercase label used across all settings sections */
export function SectionLabel({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <label className={cn('text-xs font-bold text-muted-foreground uppercase tracking-wider block', className)}>
      {children}
    </label>
  );
}

/** Red error banner */
export function ErrorBanner({ children }: { children: React.ReactNode }) {
  return (
    <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-xs text-red-600 dark:text-red-400">
      {children}
    </div>
  );
}

/** Green success banner */
export function SuccessBanner({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={cn('p-3 rounded-lg bg-emerald-500/10 border border-emerald-500/20', className)}>
      {children}
    </div>
  );
}
