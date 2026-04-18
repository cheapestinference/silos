import { useState } from 'react';
import { Pin, PinOff, Trash2, Copy, Check, RotateCcw } from 'lucide-react';
import { cn } from '../../lib/utils';

interface MessageActionsProps {
  isPinned: boolean;
  isDeleted: boolean;
  onTogglePin: (note?: string) => void;
  onToggleDelete: () => void;
  onCopy: () => Promise<void> | void;
  className?: string;
}

/**
 * Floating action overlay for a message bubble. Rendered as an absolute-
 * positioned sibling inside the bubble wrapper; parent uses `group` so
 * this responds to bubble-hover via `group-hover:opacity-100`.
 */
export function MessageActions({
  isPinned, isDeleted, onTogglePin, onToggleDelete, onCopy, className,
}: MessageActionsProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    await onCopy();
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };

  const handlePin = () => {
    if (isPinned) {
      onTogglePin();
      return;
    }
    // Prompt for an optional note on first pin. Empty → no note.
    const note = window.prompt('Note (optional):', '')?.trim() || undefined;
    onTogglePin(note);
  };

  return (
    <div
      className={cn(
        'absolute top-1.5 right-1.5 flex items-center gap-1',
        'opacity-0 group-hover:opacity-100 focus-within:opacity-100',
        'transition-opacity duration-150',
        'bg-background/90 backdrop-blur-sm border border-border/50 rounded-md px-1 py-0.5 shadow-sm',
        className,
      )}
      role="toolbar"
      aria-label="Message actions"
    >
      <button
        type="button"
        onClick={handlePin}
        className={cn(
          'p-1 rounded hover:bg-muted transition',
          isPinned ? 'text-amber-500' : 'text-muted-foreground hover:text-foreground',
        )}
        aria-label={isPinned ? 'Unpin message' : 'Pin message'}
        title={isPinned ? 'Unpin' : 'Pin'}
      >
        {isPinned ? <PinOff className="w-3.5 h-3.5" /> : <Pin className="w-3.5 h-3.5" />}
      </button>

      <button
        type="button"
        onClick={onToggleDelete}
        className={cn(
          'p-1 rounded hover:bg-muted transition',
          isDeleted ? 'text-emerald-500' : 'text-muted-foreground hover:text-red-500',
        )}
        aria-label={isDeleted ? 'Restore message' : 'Delete message'}
        title={isDeleted ? 'Restore' : 'Delete'}
      >
        {isDeleted ? <RotateCcw className="w-3.5 h-3.5" /> : <Trash2 className="w-3.5 h-3.5" />}
      </button>

      <button
        type="button"
        onClick={handleCopy}
        className="p-1 rounded hover:bg-muted transition text-muted-foreground hover:text-foreground"
        aria-label="Copy message"
        title="Copy"
      >
        {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
      </button>
    </div>
  );
}
