import { useState } from 'react';
import { ChevronDown, Check, Copy } from 'lucide-react';
import { cn } from '../../lib/utils';
import { getStructuredMessageMeta } from './chat-utils';

interface CompactSystemMessageProps {
  content: string;
}

export function CompactSystemMessage({ content }: CompactSystemMessageProps) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);

  const contentStr = typeof content === 'string' ? content : JSON.stringify(content, null, 2);

  const meta = getStructuredMessageMeta(contentStr);
  if (!meta) return null;

  const handleCopy = async () => {
    await navigator.clipboard.writeText(contentStr);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  let formattedContent = contentStr;
  try {
    const parsed = JSON.parse(contentStr);
    formattedContent = JSON.stringify(parsed, null, 2);
  } catch {
    // Keep original if parsing fails
  }

  return (
    <div className="max-w-md">
      <div className={cn(
        "rounded-lg overflow-hidden transition-all duration-200",
        "border bg-card backdrop-blur-sm",
        meta.type === 'cron' ? "border-amber-500/20" :
        meta.type === 'event' ? "border-blue-500/20" : "border"
      )}>
        {/* Compact Header */}
        <button
          onClick={() => setExpanded(!expanded)}
          className={cn(
            "w-full flex items-center justify-between px-3 py-2 transition-colors",
            meta.type === 'cron' ? "bg-amber-500/5 hover:bg-amber-500/10" :
            meta.type === 'event' ? "bg-blue-500/5 hover:bg-blue-500/10" :
            "hover:bg-muted/40"
          )}
        >
          <div className="flex items-center gap-2">
            <div className={cn(
              "w-6 h-6 rounded flex items-center justify-center",
              meta.type === 'cron' ? "bg-amber-500/10 text-amber-500" :
              meta.type === 'event' ? "bg-blue-500/10 text-blue-500" :
              "bg-muted text-muted-foreground"
            )}>
              {meta.icon}
            </div>
            <div className="flex flex-col items-start">
              <span className={cn(
                "text-[10px] font-semibold uppercase tracking-wider",
                meta.type === 'cron' ? "text-amber-500" :
                meta.type === 'event' ? "text-blue-500" :
                "text-muted-foreground"
              )}>
                {meta.type}
              </span>
              <span className="text-xs text-foreground font-medium truncate max-w-[200px]">
                {meta.title}
              </span>
            </div>
          </div>
          <ChevronDown className={cn(
            "w-3.5 h-3.5 text-muted-foreground transition-transform",
            expanded && "rotate-180"
          )} />
        </button>

        {/* Expandable Content */}
        {expanded && (
          <div className="border-t">
            <div className="relative">
              <pre className="p-3 overflow-x-auto text-[11px] leading-relaxed max-h-64 overflow-y-auto custom-scrollbar">
                <code className="text-foreground/80 font-mono">{formattedContent}</code>
              </pre>
              <button
                onClick={(e) => { e.stopPropagation(); handleCopy(); }}
                className={cn(
                  "absolute top-2 right-2 p-1.5 rounded text-xs transition-all",
                  copied
                    ? "bg-green-500/20 text-green-600 dark:text-green-400"
                    : "bg-muted text-muted-foreground hover:text-foreground"
                )}
              >
                {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
