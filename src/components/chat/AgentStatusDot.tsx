import { cn } from '../../lib/utils';

export function AgentStatusDot({ isWorking }: { isWorking: boolean }) {
  return (
    <span className="relative flex h-2 w-2">
      {isWorking && (
        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary/60 opacity-75" />
      )}
      <span className={cn(
        "relative inline-flex rounded-full h-2 w-2 transition-colors duration-300",
        isWorking ? "bg-primary" : "bg-emerald-500"
      )} />
    </span>
  );
}
