// src/components/chat/AttachmentPreview.tsx
import { X } from 'lucide-react';
import { cn } from '../../lib/utils';
import type { ChatAttachment } from '../../types/openclaw';

interface AttachmentPreviewProps {
  attachments: ChatAttachment[];
  onRemove: (id: string) => void;
  className?: string;
}

export function AttachmentPreview({ attachments, onRemove, className }: AttachmentPreviewProps) {
  if (attachments.length === 0) return null;
  return (
    <div className={cn('flex flex-wrap gap-2 px-3 py-2 border-b border-border/50', className)}>
      {attachments.map((att) => (
        <div key={att.id} className="relative group">
          <img
            src={att.dataUrl}
            alt={att.name || 'attachment'}
            className="h-16 w-16 object-cover rounded-md border border-border/40"
          />
          <button
            type="button"
            onClick={() => onRemove(att.id)}
            className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-background border border-border shadow-sm flex items-center justify-center opacity-80 hover:opacity-100 hover:bg-red-500/10 hover:border-red-500/50 transition"
            aria-label={`Remove ${att.name || 'attachment'}`}
          >
            <X className="w-3 h-3" />
          </button>
          {att.size ? (
            <span className="absolute bottom-0.5 right-0.5 text-[9px] px-1 rounded bg-background/80 text-muted-foreground">
              {(att.size / 1024).toFixed(0)} KB
            </span>
          ) : null}
        </div>
      ))}
    </div>
  );
}
