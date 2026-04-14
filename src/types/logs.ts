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

      // OpenClaw's tslog passes the tag object (e.g. `{subsystem: 'agent/embedded'}`)
      // serialized as "0" and the actual message text as "1". If "0" is ONLY a
      // tag-shaped object (subsystem/module/name and nothing else), skip it so we
      // don't render "subsystem" as the message. Prefer "1" for the real content.
      const isTagOnlyObject = (s: string): boolean => {
        try {
          const p = JSON.parse(s);
          if (!p || typeof p !== 'object' || Array.isArray(p)) return false;
          const tagKeys = new Set(['subsystem', 'module', 'name', 'component', 'scope']);
          const keys = Object.keys(p);
          return keys.length > 0 && keys.every((k) => tagKeys.has(k));
        } catch {
          return false;
        }
      };

      const zero = obj['0'];
      const one = obj['1'];
      const preferOne = typeof zero === 'string' && isTagOnlyObject(zero);
      const content = (preferOne ? one : zero) ?? one ?? zero ?? obj.msg ?? obj.message ?? '';

      // Extract subsystem from the tag object if present (overrides meta.name which
      // may contain the serialized tag string itself).
      if (preferOne && typeof zero === 'string') {
        try {
          const tag = JSON.parse(zero) as Record<string, unknown>;
          const tagValue = (tag.subsystem ?? tag.module ?? tag.name ?? tag.component ?? tag.scope);
          if (typeof tagValue === 'string') {
            meta.name = tagValue;
          }
        } catch { /* ignore */ }
      }
      if (typeof content === 'string' && content.length > 0) {
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
      } else if (content && typeof content === 'object') {
        message = JSON.stringify(content).slice(0, 200);
        payload = content;
      } else {
        // No primary content field — fall back to summarizing the whole object
        // excluding meta/time/internal fields, so warn-only entries still show something
        // instead of rendering an empty row.
        const rest = { ...obj };
        delete rest._meta;
        delete rest.time;
        delete rest['0'];
        delete rest['1'];
        delete rest.msg;
        delete rest.message;
        const keys = Object.keys(rest);
        if (keys.length > 0) {
          message = summarizePayload(rest);
          payload = rest;
        } else {
          // Truly empty entry — surface subsystem + level as the message so users
          // aren't staring at a blank row.
          message = `[${meta.logLevelName || 'log'}] ${meta.name || 'unknown'}`;
          payload = obj;
        }
      }

      // meta.name sometimes arrives as a serialized tag JSON string — unwrap it
      let subsystem = meta.name || '';
      if (typeof subsystem === 'string' && subsystem.startsWith('{') && subsystem.endsWith('}')) {
        try {
          const parsed = JSON.parse(subsystem);
          const tagValue = parsed?.subsystem ?? parsed?.module ?? parsed?.name ?? parsed?.component;
          if (typeof tagValue === 'string') subsystem = tagValue;
        } catch { /* ignore */ }
      }

      return {
        timestamp: obj.time || meta.date || '',
        level: normalizeLevel(meta.logLevelName || 'info'),
        subsystem,
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
