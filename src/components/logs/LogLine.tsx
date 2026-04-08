import { logLevelConfig } from '../../types/logs';
import type { ParsedLogLine } from '../../types/logs';

interface LogLineProps {
  line: ParsedLogLine;
  showTimestamp: boolean;
}

export function LogLine({ line, showTimestamp }: LogLineProps) {
  const level = logLevelConfig[line.level] || logLevelConfig.info;

  const ts = line.timestamp
    ? new Date(line.timestamp).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3 })
    : '';

  return (
    <div className="flex items-start gap-2 px-3 py-0.5 hover:bg-white/[0.02] font-mono text-[11px] leading-relaxed group">
      {showTimestamp && ts && (
        <span className="text-gray-600 shrink-0 select-none tabular-nums w-24">{ts}</span>
      )}
      <span className={`${level.color} shrink-0 w-12 text-right font-semibold select-none`}>
        {level.label}
      </span>
      {line.subsystem && (
        <span className="text-violet-400/70 shrink-0 max-w-28 truncate select-none">[{line.subsystem}]</span>
      )}
      <span className="text-gray-300 break-all flex-1 whitespace-pre-wrap">{line.message}</span>
    </div>
  );
}
