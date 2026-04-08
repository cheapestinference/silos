export interface LogTailResult {
  file: string;
  cursor: number;
  size: number;
  lines: string[];
  truncated?: boolean;
  reset?: boolean;
}

export type LogLevel = 'error' | 'warn' | 'info' | 'debug' | 'trace';

export interface ParsedLogLine {
  timestamp: string;
  level: LogLevel;
  subsystem: string;
  message: string;
  raw: string;
}

export const logLevelConfig: Record<LogLevel, { label: string; color: string; bg: string }> = {
  error: { label: 'ERROR', color: 'text-red-400',    bg: 'bg-red-500/10' },
  warn:  { label: 'WARN',  color: 'text-amber-400',  bg: 'bg-amber-500/10' },
  info:  { label: 'INFO',  color: 'text-cyan-400',   bg: 'bg-cyan-500/10' },
  debug: { label: 'DEBUG', color: 'text-gray-500',   bg: 'bg-gray-500/10' },
  trace: { label: 'TRACE', color: 'text-gray-600',   bg: 'bg-gray-600/10' },
};

export function parseLogLine(raw: string): ParsedLogLine {
  try {
    const obj = JSON.parse(raw);
    return {
      timestamp: obj.time || obj.timestamp || obj.ts || '',
      level: normalizeLevel(obj.level || obj.lvl || 'info'),
      subsystem: obj.subsystem || obj.component || obj.name || '',
      message: obj.msg || obj.message || raw,
      raw,
    };
  } catch {
    const levelMatch = raw.match(/\b(ERROR|WARN|INFO|DEBUG|TRACE)\b/i);
    return {
      timestamp: '',
      level: levelMatch ? normalizeLevel(levelMatch[1]) : 'info',
      subsystem: '',
      message: raw,
      raw,
    };
  }
}

function normalizeLevel(level: string): LogLevel {
  const l = level.toLowerCase();
  if (l === 'error' || l === 'err') return 'error';
  if (l === 'warn' || l === 'warning') return 'warn';
  if (l === 'debug' || l === 'dbg') return 'debug';
  if (l === 'trace') return 'trace';
  return 'info';
}
