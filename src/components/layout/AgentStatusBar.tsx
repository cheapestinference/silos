import { Pause, Play } from 'lucide-react';
import { cn } from '../../lib/utils';
import { useDashboardStore } from '../../store/dashboard-store';

export function AgentStatusBar() {
  const {
    browserAgentAction,
    browserAgentPaused,
    setBrowserAgentPaused,
  } = useDashboardStore();

  if (!browserAgentAction && !browserAgentPaused) return null;

  const handlePauseResume = () => {
    const { sendBrowserInterrupt } = useDashboardStore.getState();
    if (browserAgentPaused) {
      setBrowserAgentPaused(false);
      sendBrowserInterrupt('resume');
    } else {
      setBrowserAgentPaused(true);
      sendBrowserInterrupt('pause');
    }
  };

  return (
    <div
      className={cn(
        "flex items-center gap-2 px-3 py-2 border-t border-border text-xs transition-colors",
        browserAgentPaused
          ? "bg-amber-500/10 border-amber-500/30"
          : "bg-card/50"
      )}
    >
      <div
        className={cn(
          "w-2 h-2 rounded-full flex-shrink-0",
          browserAgentPaused
            ? "bg-amber-500"
            : "bg-green-500 animate-pulse"
        )}
      />

      <span className={cn(
        "flex-1 truncate",
        browserAgentPaused ? "text-amber-400" : "text-muted-foreground"
      )}>
        {browserAgentPaused
          ? "Paused \u2014 you have control"
          : browserAgentAction || "Working..."}
      </span>

      <button
        onClick={handlePauseResume}
        className={cn(
          "flex items-center gap-1 px-2 py-1 rounded text-xs font-semibold transition-colors flex-shrink-0",
          browserAgentPaused
            ? "bg-green-600 hover:bg-green-500 text-white"
            : "bg-red-600 hover:bg-red-500 text-white"
        )}
      >
        {browserAgentPaused ? (
          <><Play className="w-3 h-3" /> RESUME</>
        ) : (
          <><Pause className="w-3 h-3" /> PAUSE</>
        )}
      </button>
    </div>
  );
}
