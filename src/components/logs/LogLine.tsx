import { Braces } from 'lucide-react';
import { logLevelConfig } from '../../types/logs';
import type { ParsedLogLine } from '../../types/logs';

interface LogLineProps {
  line: ParsedLogLine;
  showTimestamp: boolean;
  selected?: boolean;
  onClick?: () => void;
}

export function LogLine({ line, showTimestamp, selected, onClick }: LogLineProps) {
  const level = logLevelConfig[line.level] || logLevelConfig.info;

  const ts = line.timestamp
    ? new Date(line.timestamp).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3 })
    : '';

  return (
    <div
      onClick={onClick}
      className={`flex items-start gap-2 px-3 py-0.5 font-mono text-[11px] leading-relaxed cursor-pointer transition-colors ${
        selected ? 'bg-cyan-500/10 border-l-2 border-cyan-500' : 'hover:bg-accent/30'
      }`}
    >
      {showTimestamp && ts && (
        <span className="text-muted-foreground/50 shrink-0 select-none tabular-nums w-24">{ts}</span>
      )}
      <span className={`${level.color} shrink-0 w-12 text-right font-semibold select-none`}>
        {level.label}
      </span>
      {line.subsystem && (
        <span className="text-violet-400/70 shrink-0 max-w-28 truncate select-none">[{line.subsystem}]</span>
      )}
      <span className="text-foreground/80 flex-1 truncate">{line.message}</span>
      {!!line.payload && (
        <Braces className="w-3 h-3 text-muted-foreground/40 shrink-0 mt-0.5" />
      )}
    </div>
  );
}
