import { X, Copy, Check } from 'lucide-react';
import { useState } from 'react';
import { logLevelConfig } from '../../types/logs';
import type { ParsedLogLine } from '../../types/logs';

interface LogDetailPanelProps {
  line: ParsedLogLine;
  onClose: () => void;
}

function JsonTree({ data, depth = 0 }: { data: unknown; depth?: number }) {
  if (data === null || data === undefined) {
    return <span className="text-muted-foreground">null</span>;
  }

  if (typeof data === 'string') {
    if (data.length > 120) {
      return <span className="text-amber-400 whitespace-pre-wrap break-words">&quot;{data}&quot;</span>;
    }
    return <span className="text-amber-400">&quot;{data}&quot;</span>;
  }

  if (typeof data === 'number') {
    return <span className="text-emerald-400">{data}</span>;
  }

  if (typeof data === 'boolean') {
    return <span className="text-violet-400">{String(data)}</span>;
  }

  if (Array.isArray(data)) {
    if (data.length === 0) return <span className="text-muted-foreground">[]</span>;
    return (
      <div>
        <span className="text-muted-foreground">[</span>
        <div className="ml-4 border-l border-border pl-2">
          {data.map((item, i) => (
            <div key={i} className="py-0.5">
              <JsonTree data={item} depth={depth + 1} />
              {i < data.length - 1 && <span className="text-muted-foreground/50">,</span>}
            </div>
          ))}
        </div>
        <span className="text-muted-foreground">]</span>
      </div>
    );
  }

  if (typeof data === 'object') {
    const entries = Object.entries(data as Record<string, unknown>);
    if (entries.length === 0) return <span className="text-muted-foreground">{'{}'}</span>;
    return (
      <div>
        <span className="text-muted-foreground">{'{'}</span>
        <div className="ml-4 border-l border-border pl-2">
          {entries.map(([key, val], i) => (
            <div key={key} className="py-0.5">
              <span className="text-cyan-500">&quot;{key}&quot;</span>
              <span className="text-muted-foreground">: </span>
              <JsonTree data={val} depth={depth + 1} />
              {i < entries.length - 1 && <span className="text-muted-foreground/50">,</span>}
            </div>
          ))}
        </div>
        <span className="text-muted-foreground">{'}'}</span>
      </div>
    );
  }

  return <span className="text-foreground/60">{String(data)}</span>;
}

export function LogDetailPanel({ line, onClose }: LogDetailPanelProps) {
  const [copied, setCopied] = useState(false);
  const level = logLevelConfig[line.level] || logLevelConfig.info;

  const handleCopy = () => {
    const text = line.payload
      ? JSON.stringify(line.payload, null, 2)
      : line.raw;
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const ts = line.timestamp
    ? new Date(line.timestamp).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'medium' })
    : '';

  return (
    <div className="w-[420px] shrink-0 border-l border-border flex flex-col bg-card">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${level.color} ${level.bg}`}>
            {level.label}
          </span>
          {line.subsystem && (
            <span className="text-xs text-violet-400/70 font-mono truncate">{line.subsystem}</span>
          )}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <button
            onClick={handleCopy}
            className="p-1.5 rounded text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
            title="Copy JSON"
          >
            {copied ? <Check className="w-3.5 h-3.5 text-green-400" /> : <Copy className="w-3.5 h-3.5" />}
          </button>
          <button
            onClick={onClose}
            className="p-1.5 rounded text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Timestamp */}
      {ts && (
        <div className="px-4 py-2 border-b border-border/50">
          <span className="text-[10px] text-muted-foreground/60">Time: </span>
          <span className="text-[10px] text-foreground/70 font-mono tabular-nums">{ts}</span>
        </div>
      )}

      {/* Message summary */}
      {line.message && (
        <div className="px-4 py-2.5 border-b border-border/50">
          <p className="text-[10px] text-muted-foreground/60 mb-1">Message</p>
          <p className="text-xs text-foreground/80 whitespace-pre-wrap break-words leading-relaxed">{line.message}</p>
        </div>
      )}

      {/* JSON tree */}
      <div className="flex-1 overflow-y-auto px-4 py-3">
        <p className="text-[10px] text-muted-foreground/60 mb-2">Payload</p>
        <div className="font-mono text-[11px] leading-relaxed">
          {line.payload ? (
            <JsonTree data={line.payload} />
          ) : (
            <pre className="text-foreground/60 whitespace-pre-wrap break-words">{line.raw}</pre>
          )}
        </div>
      </div>
    </div>
  );
}
