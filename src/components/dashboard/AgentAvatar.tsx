import { cn } from '../../lib/utils';
import { User, Activity, Zap } from 'lucide-react';

interface AgentAvatarProps {
  id: string;
  name: string;
  isBusy: boolean;
  activeTask?: string;
  imageUrl?: string;
  className?: string;
}

export function AgentAvatar({ name, isBusy, activeTask, imageUrl, className }: AgentAvatarProps) {
  return (
    <div className={cn("relative group", className)}>
      <div className={cn(
        "relative rounded-2xl overflow-hidden glass-card p-4 transition-all duration-500",
        isBusy ? "ai-glow-blue scale-[1.02] border-blue-500/50" : "hover:scale-[1.01]"
      )}>
        <div className="flex flex-col items-center gap-4">
          <div className="relative w-32 h-32 rounded-xl overflow-hidden bg-white/5 border border-white/10">
            {imageUrl ? (
              <img src={imageUrl} alt={name} className="w-full h-full object-cover" />
            ) : (
              <div className="w-full h-full flex items-center justify-center bg-gradient-to-br from-indigo-500/20 to-purple-500/20">
                <User className="w-12 h-12 text-white/40" />
              </div>
            )}
            {isBusy && (
              <div className="absolute inset-0 bg-blue-500/20 animate-pulse-soft flex items-center justify-center">
                <Zap className="w-8 h-8 text-blue-500 dark:text-blue-400 drop-shadow-[0_0_8px_rgba(37,99,235,0.8)]" />
              </div>
            )}
          </div>
          
          <div className="text-center">
            <h3 className="text-lg font-bold ai-gradient-text tracking-tight">{name}</h3>
            <div className="flex items-center gap-2 mt-1 justify-center">
              <span className={cn(
                "w-2 h-2 rounded-full",
                isBusy ? "bg-blue-500 ai-glow-blue animate-pulse" : "bg-green-500"
              )} />
              <span className="text-xs font-medium uppercase tracking-widest text-white/60">
                {isBusy ? "Working..." : "Idle"}
              </span>
            </div>
          </div>

          {isBusy && activeTask && (
            <div className="w-full mt-2 p-3 rounded-lg bg-white/5 border border-white/5 animate-message-in">
              <div className="flex items-center gap-2 mb-1">
                <Activity className="w-3 h-3 text-blue-500 dark:text-blue-400" />
                <span className="text-[10px] font-bold uppercase text-blue-500 dark:text-blue-400 tracking-tighter">Current Task</span>
              </div>
              <p className="text-xs text-white/80 line-clamp-2 leading-relaxed">
                {activeTask}
              </p>
            </div>
          )}
        </div>
      </div>
      
      {/* Background Glow */}
      <div className={cn(
        "absolute -inset-4 rounded-[2rem] -z-10 opacity-0 transition-opacity duration-700 blur-2xl pointer-events-none",
        isBusy ? "bg-blue-500/10 opacity-100" : "group-hover:bg-purple-500/5 group-hover:opacity-100"
      )} />
    </div>
  );
}
