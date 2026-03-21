import { useDashboardStore } from '../../store/dashboard-store';
import { cn, formatTimestamp } from '../../lib/utils';
import { MessageSquare, Calendar, ChevronRight, Hash } from 'lucide-react';

export function SessionSelector() {
  const { sessions, selectedSessionKey, selectSession } = useDashboardStore();
  const sessionList = sessions?.sessions || [];

  return (
    <div className="flex flex-col h-full glass-panel overflow-hidden">
      <div className="p-6 border-b border-white/10">
        <h2 className="text-xl font-bold ai-gradient-text">Recent Sessions</h2>
        <p className="text-xs text-white/40 mt-1 uppercase tracking-widest font-semibold">Select an active context</p>
      </div>
      
      <div className="flex-1 overflow-y-auto p-4 space-y-3 custom-scrollbar">
        {sessionList.map((session) => (
          <button
            key={session.key}
            onClick={() => selectSession(session.key)}
            className={cn(
              "w-full text-left p-4 rounded-xl transition-all duration-300 group relative overflow-hidden",
              selectedSessionKey === session.key 
                ? "bg-white/10 border-l-2 border-primary ai-glow"
                : "hover:bg-white/5 border border-transparent hover:border-white/10"
            )}
          >
            <div className="flex items-start gap-4">
              <div className={cn(
                "p-2 rounded-lg transition-colors",
                selectedSessionKey === session.key ? "bg-primary/20 text-primary" : "bg-white/5 text-white/40 group-hover:text-primary/60"
              )}>
                <MessageSquare className="w-5 h-5" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between mb-1">
                  <h4 className={cn(
                    "text-sm font-bold truncate",
                    selectedSessionKey === session.key ? "text-white" : "text-white/70 group-hover:text-white"
                  )}>
                    {session.displayName || session.label || `Session ${session.key.slice(0, 8)}`}
                  </h4>
                  <ChevronRight className={cn(
                    "w-4 h-4 transition-transform",
                    selectedSessionKey === session.key ? "opacity-100 translate-x-0" : "opacity-0 -translate-x-2 group-hover:opacity-100 group-hover:translate-x-0"
                  )} />
                </div>
                <div className="flex items-center gap-3">
                  <span className="flex items-center gap-1 text-[10px] text-white/40 overflow-hidden truncate">
                    <Hash className="w-3 h-3" />
                    {session.surface || "Direct"}
                  </span>
                  <span className="flex items-center gap-1 text-[10px] text-white/40">
                    <Calendar className="w-3 h-3" />
                    {formatTimestamp(session.updatedAt)}
                  </span>
                </div>
              </div>
            </div>
            {selectedSessionKey === session.key && (
              <div className="absolute inset-0 bg-gradient-to-r from-primary/5 to-transparent pointer-events-none" />
            )}
          </button>
        ))}
      </div>
    </div>
  );
}
