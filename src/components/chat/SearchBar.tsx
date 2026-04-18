import { useEffect, useRef } from 'react';
import { X, ChevronUp, ChevronDown, Search } from 'lucide-react';
import { cn } from '../../lib/utils';

interface SearchBarProps {
  query: string;
  onQueryChange: (q: string) => void;
  matchCount: number;
  currentIdx: number;           // 1-based; 0 when no matches
  onPrev: () => void;
  onNext: () => void;
  onClose: () => void;
}

export function SearchBar({
  query, onQueryChange, matchCount, currentIdx, onPrev, onNext, onClose,
}: SearchBarProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  return (
    <div className="sticky top-0 z-10 mx-4 mt-2 rounded-lg border bg-background/95 backdrop-blur-sm shadow-sm">
      <div className="flex items-center gap-2 px-3 py-2">
        <Search className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              if (e.shiftKey) onPrev(); else onNext();
            } else if (e.key === 'Escape') {
              e.preventDefault();
              onClose();
            }
          }}
          placeholder="Search in chat…"
          className="flex-1 bg-transparent outline-none text-xs placeholder:text-muted-foreground/60"
          aria-label="Search in chat"
        />
        <span className="text-[10px] text-muted-foreground tabular-nums shrink-0 min-w-[3.5rem] text-right">
          {matchCount > 0 ? `${currentIdx} of ${matchCount}` : query ? 'no matches' : ''}
        </span>
        <button
          type="button"
          onClick={onPrev}
          disabled={matchCount === 0}
          className={cn('p-1 rounded hover:bg-muted disabled:opacity-30', 'text-muted-foreground')}
          aria-label="Previous match"
          title="Previous (Shift+Enter)"
        >
          <ChevronUp className="w-3.5 h-3.5" />
        </button>
        <button
          type="button"
          onClick={onNext}
          disabled={matchCount === 0}
          className={cn('p-1 rounded hover:bg-muted disabled:opacity-30', 'text-muted-foreground')}
          aria-label="Next match"
          title="Next (Enter)"
        >
          <ChevronDown className="w-3.5 h-3.5" />
        </button>
        <button
          type="button"
          onClick={onClose}
          className="p-1 rounded hover:bg-muted text-muted-foreground"
          aria-label="Close search"
          title="Close (Esc)"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
}
