import type React from 'react';
import { cn } from '../../lib/utils';

// Stat Card Component
export interface StatCardProps {
  icon: React.ReactNode;
  value: number;
  label: string;
  color: 'cyan' | 'violet' | 'emerald';
  pulse?: boolean;
}

export function StatCard({ icon, value, label, color, pulse }: StatCardProps) {
  const colorClasses = {
    cyan: {
      bg: 'bg-cyan-500/10',
      border: 'border-cyan-500/20',
      icon: 'text-cyan-600 dark:text-cyan-400',
      value: 'text-cyan-700 dark:text-cyan-300',
    },
    violet: {
      bg: 'bg-primary/10',
      border: 'border-primary/20',
      icon: 'text-primary',
      value: 'text-primary',
    },
    emerald: {
      bg: 'bg-emerald-500/10',
      border: 'border-emerald-500/20',
      icon: 'text-emerald-600 dark:text-emerald-400',
      value: 'text-emerald-700 dark:text-emerald-300',
    },
  };

  const styles = colorClasses[color];

  return (
    <div className={cn(
      "flex items-center gap-2.5 px-3 py-2 rounded-xl border",
      styles.bg,
      styles.border
    )}>
      <span className={cn("relative", styles.icon)}>
        {icon}
        {pulse && value > 0 && (
          <span className={cn("absolute -top-0.5 -right-0.5 w-1.5 h-1.5 rounded-full", styles.icon.replace('text-', 'bg-'), "animate-ping")} />
        )}
      </span>
      <div className="flex flex-col">
        <span className={cn("text-sm font-bold tabular-nums leading-none", styles.value)}>
          {value}
        </span>
        <span className="text-[10px] text-muted-foreground uppercase tracking-wider">{label}</span>
      </div>
    </div>
  );
}

// Tab Button Component
export interface TabButtonProps {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  badge?: number;
}

export function TabButton({ active, onClick, icon, label, badge }: TabButtonProps) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-semibold transition-all duration-200 relative",
        active
          ? "bg-gradient-to-r from-primary/20 to-accent/20 text-primary shadow-lg shadow-elevation-1"
          : "text-muted-foreground hover:text-foreground hover:bg-muted"
      )}
      style={{ fontFamily: 'Inter, system-ui, sans-serif' }}
    >
      {icon}
      <span>{label}</span>
      {badge !== undefined && badge > 0 && (
        <span className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-cyan-500 text-[10px] font-bold text-white flex items-center justify-center animate-pulse">
          {badge}
        </span>
      )}
    </button>
  );
}

// Config Card Component
export interface ConfigCardProps {
  title: string;
  icon: React.ReactNode;
  color: 'cyan' | 'violet' | 'amber' | 'emerald';
  children: React.ReactNode;
}

export function ConfigCard({ title, icon, color, children }: ConfigCardProps) {
  const colorClasses = {
    cyan: { icon: 'text-cyan-600 dark:text-cyan-400' },
    violet: { icon: 'text-primary' },
    amber: { icon: 'text-amber-600 dark:text-amber-400' },
    emerald: { icon: 'text-emerald-600 dark:text-emerald-400' },
  };

  const styles = colorClasses[color];

  return (
    <div className="rounded-2xl border border-border bg-card p-4">
      <div className="flex items-center gap-2 mb-3">
        <span className={styles.icon}>{icon}</span>
        <h4 className="text-xs font-bold text-foreground uppercase tracking-wider">{title}</h4>
      </div>
      <div className="space-y-1">
        {children}
      </div>
    </div>
  );
}

// Config Row Component
export interface ConfigRowProps {
  label: string;
  value: string;
  mono?: boolean;
  small?: boolean;
}

export function ConfigRow({ label, value, mono, small }: ConfigRowProps) {
  return (
    <div className="flex items-center justify-between text-xs py-1.5 border-b border-border/40 last:border-0">
      <span className="text-muted-foreground font-medium">{label}</span>
      <span className={cn(
        "text-foreground truncate max-w-[60%] text-right",
        mono && "font-mono",
        small && "text-[10px]"
      )} title={value}>
        {value}
      </span>
    </div>
  );
}
