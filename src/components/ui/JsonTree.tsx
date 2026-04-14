import { useState } from 'react';
import { ChevronDown, ChevronRight, Copy, Check } from 'lucide-react';
import { cn } from '../../lib/utils';

interface JsonTreeProps {
  data: unknown;
  depth?: number;
  /** Auto-unwrap strings that are themselves valid JSON (e.g. stringified errors). */
  unwrapJsonStrings?: boolean;
  /** Initial collapse state: 'expand-all' | 'collapse-arrays' | number (depth to expand). */
  defaultCollapseDepth?: number;
  /** Optional copy button shown next to the root. */
  rootCopy?: boolean;
}

/**
 * Recursively walk `data` and replace any string that is itself valid JSON
 * with the parsed value. Useful for producing a clean copy payload without
 * escape-sequence noise.
 */
function normalizeForCopy(data: unknown): unknown {
  if (data === null || data === undefined) return data;
  if (typeof data === 'string') {
    const parsed = maybeParseJsonString(data);
    return parsed !== null ? normalizeForCopy(parsed) : data;
  }
  if (Array.isArray(data)) return data.map(normalizeForCopy);
  if (typeof data === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
      out[k] = normalizeForCopy(v);
    }
    return out;
  }
  return data;
}

function maybeParseJsonString(s: string): unknown | null {
  const trimmed = s.trim();
  if (trimmed.length < 2) return null;
  const first = trimmed[0];
  const last = trimmed[trimmed.length - 1];
  if (!((first === '{' && last === '}') || (first === '[' && last === ']'))) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function JsonNode({
  data,
  depth,
  unwrapJsonStrings,
  defaultCollapseDepth,
}: {
  data: unknown;
  depth: number;
  unwrapJsonStrings: boolean;
  defaultCollapseDepth: number;
}) {
  const [open, setOpen] = useState<boolean>(depth < defaultCollapseDepth);

  if (data === null) return <span className="text-muted-foreground">null</span>;
  if (data === undefined) return <span className="text-muted-foreground">undefined</span>;

  if (typeof data === 'string') {
    if (unwrapJsonStrings) {
      const parsed = maybeParseJsonString(data);
      if (parsed !== null && typeof parsed === 'object') {
        // Render the embedded JSON inline with a subtle hint
        return (
          <span>
            <span className="text-muted-foreground/60 text-[9px] mr-1" title="Auto-unwrapped JSON string">json⇣</span>
            <JsonNode
              data={parsed}
              depth={depth}
              unwrapJsonStrings={unwrapJsonStrings}
              defaultCollapseDepth={defaultCollapseDepth}
            />
          </span>
        );
      }
    }
    // Long strings get collapsed into a preview + expand toggle
    if (data.length > 200) {
      return (
        <span>
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); setOpen(!open); }}
            className="inline-flex items-center gap-0.5 text-muted-foreground/70 hover:text-foreground transition-colors align-baseline"
          >
            {open
              ? <ChevronDown className="w-2.5 h-2.5 inline" />
              : <ChevronRight className="w-2.5 h-2.5 inline" />}
            <span className="text-[9px]">{open ? 'less' : `${data.length} chars`}</span>
          </button>{' '}
          <span className="text-syntax-string whitespace-pre-wrap break-words">
            &quot;{open ? data : data.slice(0, 120) + '…'}&quot;
          </span>
        </span>
      );
    }
    return <span className="text-syntax-string whitespace-pre-wrap break-words">&quot;{data}&quot;</span>;
  }

  if (typeof data === 'number') return <span className="text-syntax-number">{data}</span>;
  if (typeof data === 'boolean') return <span className="text-syntax-boolean">{String(data)}</span>;

  if (Array.isArray(data)) {
    if (data.length === 0) return <span className="text-muted-foreground">[]</span>;
    return (
      <span>
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); setOpen(!open); }}
          className="inline-flex items-center text-muted-foreground/70 hover:text-foreground transition-colors align-baseline"
        >
          {open
            ? <ChevronDown className="w-2.5 h-2.5 inline" />
            : <ChevronRight className="w-2.5 h-2.5 inline" />}
          <span className="text-muted-foreground">[</span>
          {!open && <span className="text-[9px] text-muted-foreground/60 ml-0.5">{data.length} items</span>}
        </button>
        {open && (
          <div className="ml-4 border-l border-border/40 pl-2">
            {data.map((item, i) => (
              <div key={i} className="py-0.5">
                <JsonNode
                  data={item}
                  depth={depth + 1}
                  unwrapJsonStrings={unwrapJsonStrings}
                  defaultCollapseDepth={defaultCollapseDepth}
                />
                {i < data.length - 1 && <span className="text-muted-foreground/50">,</span>}
              </div>
            ))}
          </div>
        )}
        {open && <span className="text-muted-foreground">]</span>}
        {!open && <span className="text-muted-foreground">]</span>}
      </span>
    );
  }

  if (typeof data === 'object') {
    const entries = Object.entries(data as Record<string, unknown>);
    if (entries.length === 0) return <span className="text-muted-foreground">{'{}'}</span>;
    return (
      <span>
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); setOpen(!open); }}
          className="inline-flex items-center text-muted-foreground/70 hover:text-foreground transition-colors align-baseline"
        >
          {open
            ? <ChevronDown className="w-2.5 h-2.5 inline" />
            : <ChevronRight className="w-2.5 h-2.5 inline" />}
          <span className="text-muted-foreground">{'{'}</span>
          {!open && <span className="text-[9px] text-muted-foreground/60 ml-0.5">{entries.length} {entries.length === 1 ? 'field' : 'fields'}</span>}
        </button>
        {open && (
          <div className="ml-4 border-l border-border/40 pl-2">
            {entries.map(([key, val], i) => (
              <div key={key} className="py-0.5">
                <span className="text-syntax-key">&quot;{key}&quot;</span>
                <span className="text-muted-foreground">: </span>
                <JsonNode
                  data={val}
                  depth={depth + 1}
                  unwrapJsonStrings={unwrapJsonStrings}
                  defaultCollapseDepth={defaultCollapseDepth}
                />
                {i < entries.length - 1 && <span className="text-muted-foreground/50">,</span>}
              </div>
            ))}
          </div>
        )}
        <span className="text-muted-foreground">{'}'}</span>
      </span>
    );
  }

  return <span className="text-foreground/60">{String(data)}</span>;
}

export function JsonTree({
  data,
  depth = 0,
  unwrapJsonStrings = false,
  defaultCollapseDepth = 2,
  rootCopy = false,
}: JsonTreeProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      // When unwrap is on, also pre-unwrap nested JSON strings in the copied text
      // so users get the flattened form they see on screen, not the escaped wire one.
      const toSerialize = unwrapJsonStrings ? normalizeForCopy(data) : data;
      const text = typeof toSerialize === 'string' ? toSerialize : JSON.stringify(toSerialize, null, 2);
      navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* ignore */ }
  };

  return (
    <div className="font-mono text-[11px] leading-relaxed">
      {rootCopy && (
        <div className="flex justify-end mb-1">
          <button
            type="button"
            onClick={handleCopy}
            className={cn(
              "flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] transition-colors",
              copied
                ? "text-log-info"
                : "text-muted-foreground/70 hover:text-foreground hover:bg-muted"
            )}
            title="Copy JSON"
          >
            {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
            <span>{copied ? 'copied' : 'copy'}</span>
          </button>
        </div>
      )}
      <JsonNode
        data={data}
        depth={depth}
        unwrapJsonStrings={unwrapJsonStrings}
        defaultCollapseDepth={defaultCollapseDepth}
      />
    </div>
  );
}
