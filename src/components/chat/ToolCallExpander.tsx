import { useState } from 'react';
import { ChevronDown, ChevronUp, Check, Copy, Code2, Terminal, Cpu } from 'lucide-react';
import { cn } from '../../lib/utils';
import { truncateForRender } from './chat-utils';

export interface ToolCallExpanderProps {
  toolName?: string;
  toolCall?: unknown;
  result?: unknown;
  content?: string;
}

export function ToolCallExpander({ toolName, toolCall, result, content }: ToolCallExpanderProps) {
  const [expanded, setExpanded] = useState(false);
  const [inputExpanded, setInputExpanded] = useState(false);
  const [outputExpanded, setOutputExpanded] = useState(false);
  const [copiedField, setCopiedField] = useState<'input' | 'output' | null>(null);

  const inputStr = toolCall
    ? truncateForRender(typeof toolCall === 'string' ? toolCall : JSON.stringify(toolCall, null, 2))
    : null;

  let outputStr: string | null = null;
  if (content && typeof content === 'string' && content.trim()) {
    outputStr = truncateForRender(content);
  } else if (result) {
    outputStr = truncateForRender(typeof result === 'string' ? result : JSON.stringify(result, null, 2));
  }

  const hasOutput = !!outputStr;
  const isRunning = !hasOutput;

  const getToolIcon = (name?: string) => {
    if (!name) return <Cpu className="w-3 h-3" />;
    const lower = name.toLowerCase();
    if (lower.includes('code') || lower.includes('write')) return <Code2 className="w-3 h-3" />;
    if (lower.includes('terminal') || lower.includes('bash') || lower.includes('exec')) return <Terminal className="w-3 h-3" />;
    return <Cpu className="w-3 h-3" />;
  };

  const handleCopy = (text: string, field: 'input' | 'output') => {
    navigator.clipboard.writeText(text);
    setCopiedField(field);
    setTimeout(() => setCopiedField(null), 1500);
  };

  const handleHeaderClick = () => {
    const next = !expanded;
    setExpanded(next);
    if (next) {
      setInputExpanded(true);
      setOutputExpanded(true);
    } else {
      setInputExpanded(false);
      setOutputExpanded(false);
    }
  };

  const handleSectionClick = (field: 'input' | 'output', text: string) => {
    const isFieldExpanded = field === 'input' ? inputExpanded : outputExpanded;
    if (expanded && isFieldExpanded) {
      handleCopy(text, field);
      return;
    }
    if (field === 'input') setInputExpanded(!inputExpanded);
    else setOutputExpanded(!outputExpanded);
  };

  const isInputOpen = expanded || inputExpanded;
  const isOutputOpen = expanded || outputExpanded;

  const colors = isRunning
    ? { border: 'border-amber-300', bg: 'bg-amber-200 dark:bg-amber-500/20', hover: 'hover:bg-amber-300 dark:hover:bg-amber-500/30', icon: 'bg-amber-500/20 text-amber-700 dark:text-amber-400', ring: 'ring-amber-400/40', chevron: 'text-amber-700 dark:text-amber-400 hover:bg-amber-300 dark:hover:bg-amber-500/30' }
    : { border: 'border-zinc-300 dark:border-zinc-600', bg: 'bg-zinc-800 dark:bg-zinc-700', hover: 'hover:bg-zinc-700 dark:hover:bg-zinc-600', icon: 'bg-zinc-600 text-emerald-400', ring: 'ring-zinc-400', chevron: 'text-zinc-300 hover:bg-zinc-700 dark:hover:bg-zinc-600' };

  return (
    <div className={cn(
      "rounded-lg overflow-hidden transition-all duration-200",
      "border bg-card",
      colors.border,
      expanded && `ring-1 ${colors.ring}`
    )}>
      {/* Header */}
      <div
        className={cn(
          "flex items-center justify-between px-2.5 py-1.5",
          colors.bg,
          "cursor-pointer transition-all",
          colors.hover
        )}
        onClick={handleHeaderClick}
      >
        <div className="flex items-center gap-2 min-w-0">
          <div className={cn("w-5 h-5 rounded flex items-center justify-center shrink-0", colors.icon)}>
            {getToolIcon(toolName)}
          </div>
          <p className={cn("text-[11px] font-semibold font-mono truncate", isRunning ? "text-foreground" : "text-white")}>{toolName || 'unknown'}</p>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {isRunning && (
            <div className="w-2.5 h-2.5 border-[1.5px] border-amber-400 border-t-transparent rounded-full animate-spin" />
          )}
          {hasOutput && (
            <span className={cn("text-[10px] font-semibold px-1 py-px rounded", isRunning ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400" : "bg-emerald-500/20 text-emerald-400")}>ok</span>
          )}
          <button className={cn("p-0.5 rounded", colors.chevron)}>
            {expanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
          </button>
        </div>
      </div>

      {/* Input */}
      {inputStr && (
        <div
          className={cn(
            "px-2.5 py-1.5 border-t border-cyan-500/10 bg-cyan-500/[0.02] cursor-pointer transition-colors",
            isInputOpen && expanded ? "hover:bg-cyan-500/[0.06]" : "hover:bg-cyan-500/[0.04]"
          )}
          onClick={() => handleSectionClick('input', inputStr)}
        >
          <div className="flex items-center justify-between mb-0.5">
            <span className="text-[10px] font-semibold text-cyan-600 dark:text-cyan-400 uppercase tracking-wider">Input</span>
            {copiedField === 'input' && (
              <span className="text-[10px] text-emerald-500 flex items-center gap-0.5"><Check className="w-2.5 h-2.5" /> Copied</span>
            )}
            {expanded && isInputOpen && copiedField !== 'input' && (
              <Copy className="w-2.5 h-2.5 text-muted-foreground/40" />
            )}
          </div>
          <pre className={cn(
            "text-[10px] leading-tight font-mono text-muted-foreground whitespace-pre-wrap break-all",
            !isInputOpen && "line-clamp-2"
          )}>{inputStr}</pre>
        </div>
      )}

      {/* Output */}
      {hasOutput && (
        <div
          className={cn(
            "border-t border-cyan-500/10 cursor-pointer transition-colors",
            isOutputOpen && expanded ? "hover:bg-emerald-500/[0.04]" : "hover:bg-emerald-500/[0.02]"
          )}
          onClick={() => handleSectionClick('output', outputStr!)}
        >
          <div className="px-2.5 py-1 bg-emerald-500/5 flex items-center justify-between">
            <span className="text-[10px] font-semibold text-emerald-600 dark:text-emerald-400 uppercase tracking-wider">Output</span>
            {copiedField === 'output' && (
              <span className="text-[10px] text-emerald-500 flex items-center gap-0.5"><Check className="w-2.5 h-2.5" /> Copied</span>
            )}
            {expanded && isOutputOpen && copiedField !== 'output' && (
              <Copy className="w-2.5 h-2.5 text-muted-foreground/40" />
            )}
          </div>
          <div className={cn(
            "px-2.5 py-1.5 text-[10px] leading-tight font-mono text-foreground/80 whitespace-pre-wrap break-all",
            isOutputOpen ? "overflow-y-auto custom-scrollbar max-h-48" : "line-clamp-2"
          )}>
            {outputStr}
          </div>
        </div>
      )}
    </div>
  );
}
