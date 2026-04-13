import { useState } from 'react';
import { Copy, Check } from 'lucide-react';

interface CopyButtonProps {
  value: string;
  className?: string;
  title?: string;
}

/**
 * Inline copy-to-clipboard button. Shows a brief check icon + "Copied" tooltip
 * for ~1.5s after a successful copy. Falls back to an error state if the
 * clipboard API rejects (e.g. non-secure context).
 */
export function CopyButton({ value, className, title }: CopyButtonProps) {
  const [state, setState] = useState<'idle' | 'ok' | 'err'>('idle');

  const handleClick = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(value);
      setState('ok');
    } catch {
      setState('err');
    }
    setTimeout(() => setState('idle'), 1500);
  };

  return (
    <button
      type="button"
      onClick={handleClick}
      title={state === 'ok' ? 'Copied' : state === 'err' ? 'Copy failed' : (title ?? 'Copy')}
      className={`inline-flex items-center gap-0.5 p-0.5 rounded hover:bg-muted transition-colors ${className ?? ''}`}
    >
      {state === 'ok'
        ? <Check className="w-3 h-3 text-emerald-500" />
        : <Copy className={`w-3 h-3 ${state === 'err' ? 'text-red-500' : 'text-muted-foreground'}`} />
      }
    </button>
  );
}
