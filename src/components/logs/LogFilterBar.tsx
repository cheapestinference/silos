import { Search, Filter } from 'lucide-react';
import type { LogLevel } from '../../types/logs';

const levels: { key: LogLevel; label: string; color: string }[] = [
  { key: 'error', label: 'Error', color: 'bg-red-500' },
  { key: 'warn',  label: 'Warn',  color: 'bg-amber-500' },
  { key: 'info',  label: 'Info',  color: 'bg-cyan-500' },
  { key: 'debug', label: 'Debug', color: 'bg-muted-foreground' },
  { key: 'trace', label: 'Trace', color: 'bg-muted-foreground/60' },
];

interface LogFilterBarProps {
  activeLevels: LogLevel[];
  onToggleLevel: (level: LogLevel) => void;
  searchText: string;
  onSearchChange: (text: string) => void;
}

export function LogFilterBar({ activeLevels, onToggleLevel, searchText, onSearchChange }: LogFilterBarProps) {
  return (
    <div className="flex items-center gap-3 px-4 py-2 border-b border-border/50">
      <div className="flex items-center gap-1">
        <Filter className="w-3.5 h-3.5 text-muted-foreground mr-1" />
        {levels.map(l => {
          const active = activeLevels.includes(l.key);
          return (
            <button
              key={l.key}
              onClick={() => onToggleLevel(l.key)}
              className={`px-2 py-0.5 rounded text-[10px] font-semibold transition-all ${
                active
                  ? `${l.color} text-white`
                  : 'bg-muted text-muted-foreground hover:text-foreground/70'
              }`}
            >
              {l.label}
            </button>
          );
        })}
      </div>

      <div className="flex-1 relative max-w-xs ml-auto">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
        <input
          type="text"
          value={searchText}
          onChange={e => onSearchChange(e.target.value)}
          placeholder="Filter logs..."
          className="w-full pl-8 pr-3 py-1 bg-muted/50 border border-border rounded-md text-xs text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:border-ring"
        />
      </div>
    </div>
  );
}
