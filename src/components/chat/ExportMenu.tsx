import { useEffect, useRef, useState } from 'react';
import { Download, Copy, Check, FileText } from 'lucide-react';
import { cn } from '../../lib/utils';

interface ExportMenuProps {
  onCopy: () => Promise<void> | void;
  onDownload: () => void;
  disabled?: boolean;
}

export function ExportMenu({ onCopy, onDownload, disabled }: ExportMenuProps) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const handleCopy = async () => {
    await onCopy();
    setCopied(true);
    setTimeout(() => { setCopied(false); setOpen(false); }, 900);
  };

  const handleDownload = () => {
    onDownload();
    setOpen(false);
  };

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={disabled}
        className={cn(
          'p-1 rounded text-[10px] text-muted-foreground hover:text-foreground hover:bg-muted transition flex items-center gap-1',
          disabled && 'opacity-50 cursor-not-allowed',
        )}
        aria-label="Export chat"
        aria-expanded={open}
        title="Export chat"
      >
        <Download className="w-3.5 h-3.5" />
        <span>Export</span>
      </button>
      {open && (
        <div
          className="absolute right-0 top-full mt-1 z-20 min-w-[10rem] rounded-md border bg-background shadow-lg py-1"
          role="menu"
        >
          <button
            type="button"
            onClick={handleCopy}
            className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-muted text-left"
            role="menuitem"
          >
            {copied ? <Check className="w-3.5 h-3.5 text-emerald-500" /> : <Copy className="w-3.5 h-3.5 text-muted-foreground" />}
            {copied ? 'Copied!' : 'Copy as markdown'}
          </button>
          <button
            type="button"
            onClick={handleDownload}
            className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-muted text-left"
            role="menuitem"
          >
            <FileText className="w-3.5 h-3.5 text-muted-foreground" />
            Download .md
          </button>
        </div>
      )}
    </div>
  );
}
