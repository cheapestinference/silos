import { useState } from 'react';
import { Pin, ChevronDown, X } from 'lucide-react';
import { cn } from '../../lib/utils';
import type { ChatMessage, PinnedEntry } from '../../types/openclaw';

interface PinnedHeaderProps {
  sessionKey: string;
  messages: ChatMessage[];
  pinned: PinnedEntry[];
  onUnpin: (messageId: string) => void;
  onJumpTo?: (messageId: string) => void;
}

export function PinnedHeader({ messages, pinned, onUnpin, onJumpTo }: PinnedHeaderProps) {
  const [expanded, setExpanded] = useState(false);
  if (pinned.length === 0) return null;

  const byId = new Map<string, ChatMessage>();
  for (const m of messages) byId.set(m.id, m);

  const renderPreview = (entry: PinnedEntry): string => {
    const msg = byId.get(entry.messageId);
    if (!msg) return '(message not loaded)';
    const body = msg.content?.trim() || '(no text)';
    return body.length > 120 ? `${body.slice(0, 117)}…` : body;
  };

  const first = pinned[0];
  const firstPreview = renderPreview(first);

  return (
    <div className="mx-4 mt-2 mb-3 rounded-lg border border-amber-500/30 bg-amber-500/5 text-xs">
      <button
        type="button"
        onClick={() => setExpanded(e => !e)}
        className="w-full flex items-center gap-2 px-3 py-2 hover:bg-amber-500/10 transition rounded-lg"
        aria-expanded={expanded}
      >
        <Pin className="w-3.5 h-3.5 text-amber-600 dark:text-amber-400 shrink-0" />
        <span className="font-medium text-amber-700 dark:text-amber-300 shrink-0">
          {pinned.length} pinned
        </span>
        {!expanded && (
          <span className="text-muted-foreground truncate min-w-0 flex-1 text-left">
            {firstPreview}
            {first.note ? <span className="italic ml-2 opacity-70">— {first.note}</span> : null}
          </span>
        )}
        <ChevronDown className={cn('w-3.5 h-3.5 text-muted-foreground shrink-0 transition-transform', expanded && 'rotate-180')} />
      </button>
      {expanded && (
        <ul className="border-t border-amber-500/20 divide-y divide-amber-500/10">
          {pinned.map((entry) => (
            <li key={entry.messageId} className="flex items-start gap-2 px-3 py-2">
              <button
                type="button"
                onClick={() => onJumpTo?.(entry.messageId)}
                className="flex-1 min-w-0 text-left hover:text-foreground transition"
                title="Jump to message"
              >
                <div className="truncate text-foreground">{renderPreview(entry)}</div>
                {entry.note ? (
                  <div className="italic text-[10px] text-muted-foreground mt-0.5 truncate">
                    — {entry.note}
                  </div>
                ) : null}
              </button>
              <button
                type="button"
                onClick={() => onUnpin(entry.messageId)}
                className="shrink-0 p-1 rounded hover:bg-red-500/10 hover:text-red-500 text-muted-foreground transition"
                aria-label="Unpin"
                title="Unpin"
              >
                <X className="w-3 h-3" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
