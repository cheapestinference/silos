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
  /** Parsed JSON payload (the "0" field content or full object) for detail view */
  payload?: unknown;
}

export const logLevelConfig: Record<LogLevel, { label: string; color: string; bg: string }> = {
  error: { label: 'ERROR', color: 'text-log-error',             bg: 'bg-log-error/10' },
  warn:  { label: 'WARN',  color: 'text-log-warn',              bg: 'bg-log-warn/10' },
  info:  { label: 'INFO',  color: 'text-log-info',              bg: 'bg-log-info/10' },
  debug: { label: 'DEBUG', color: 'text-muted-foreground',      bg: 'bg-muted' },
  trace: { label: 'TRACE', color: 'text-muted-foreground/60',   bg: 'bg-muted/60' },
};

export function parseLogLine(raw: string): ParsedLogLine {
  try {
    const obj = JSON.parse(raw);

    // OpenClaw log format: { "0": "<json-or-text>", "_meta": { logLevelName, name, date, ... }, "time": "..." }
    if (obj._meta) {
      const meta = obj._meta;
      let message = '';
      let payload: unknown = undefined;

      // The "0" field contains the actual log content (often stringified JSON)
      const content = obj['0'] ?? obj['1'] ?? obj.msg ?? obj.message ?? '';
      if (typeof content === 'string') {
        try {
          payload = JSON.parse(content);
          // Extract a short summary from the parsed payload
          if (payload && typeof payload === 'object') {
            const p = payload as Record<string, unknown>;
            message = p.msg as string || p.message as string || p.event as string || p.status as string || summarizePayload(p);
          } else {
            message = content.slice(0, 200);
          }
        } catch {
          message = content.slice(0, 200);
          payload = content;
        }
      } else {
        message = JSON.stringify(content).slice(0, 200);
        payload = content;
      }

      return {
        timestamp: obj.time || meta.date || '',
        level: normalizeLevel(meta.logLevelName || 'info'),
        subsystem: meta.name || '',
        message,
        raw,
        payload,
      };
    }

    // Generic JSON log format
    return {
      timestamp: obj.time || obj.timestamp || obj.ts || '',
      level: normalizeLevel(obj.level || obj.lvl || 'info'),
      subsystem: obj.subsystem || obj.component || obj.name || '',
      message: obj.msg || obj.message || raw.slice(0, 200),
      raw,
      payload: obj,
    };
  } catch {
    const levelMatch = raw.match(/\b(ERROR|WARN|INFO|DEBUG|TRACE)\b/i);
    return {
      timestamp: '',
      level: levelMatch ? normalizeLevel(levelMatch[1]) : 'info',
      subsystem: '',
      message: raw.slice(0, 200),
      raw,
    };
  }
}

function summarizePayload(obj: Record<string, unknown>): string {
  // Try common field patterns for a readable summary
  for (const key of ['goal', 'label', 'flowId', 'taskId', 'event', 'action', 'method', 'url', 'error']) {
    if (typeof obj[key] === 'string') return `${key}: ${(obj[key] as string).slice(0, 120)}`;
  }
  // Fallback: show top-level keys
  const keys = Object.keys(obj).filter(k => k !== '_meta');
  return keys.length <= 5 ? keys.join(', ') : `${keys.slice(0, 4).join(', ')} +${keys.length - 4}`;
}

function normalizeLevel(level: string): LogLevel {
  const l = level.toLowerCase();
  if (l === 'error' || l === 'err') return 'error';
  if (l === 'warn' || l === 'warning') return 'warn';
  if (l === 'debug' || l === 'dbg') return 'debug';
  if (l === 'trace') return 'trace';
  return 'info';
}
