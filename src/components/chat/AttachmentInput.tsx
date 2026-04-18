// src/components/chat/AttachmentInput.tsx
import { useRef, useState, type ClipboardEvent, type DragEvent } from 'react';
import { Paperclip } from 'lucide-react';
import { cn } from '../../lib/utils';
import { fileToAttachment, isSupportedAttachmentMime } from '../../store/slices/attachments-slice';
import type { ChatAttachment } from '../../types/openclaw';

interface AttachmentInputProps {
  onAdd: (att: ChatAttachment) => void;
  onError?: (err: string) => void;
  disabled?: boolean;
  /** Wraps its children in a drop-target; paste also listened on children container. */
  children?: React.ReactNode;
}

/**
 * Provides three entry points for adding image attachments:
 *   - File picker (button click opens hidden <input type="file">).
 *   - Drag-drop onto the children container.
 *   - Paste inside the children container (e.g. textarea).
 *
 * The component renders the paperclip button at the top-left of its children
 * wrapper and delegates drop/paste event handling to the wrapper.
 */
export function AttachmentInput({ onAdd, onError, disabled, children }: AttachmentInputProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragActive, setDragActive] = useState(false);

  const ingestFile = async (file: File) => {
    const res = await fileToAttachment(file);
    if ('error' in res) {
      onError?.(res.error);
      return;
    }
    onAdd(res);
  };

  const onFiles = async (files: FileList | null) => {
    if (!files) return;
    for (const f of Array.from(files)) {
      if (isSupportedAttachmentMime(f.type)) {
        await ingestFile(f);
      }
    }
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragActive(false);
    onFiles(e.dataTransfer?.files ?? null);
  };

  const onPaste = (e: ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of Array.from(items)) {
      if (item.kind === 'file' && isSupportedAttachmentMime(item.type)) {
        const file = item.getAsFile();
        if (file) {
          e.preventDefault();
          ingestFile(file);
        }
      }
    }
  };

  return (
    <div
      className={cn('relative', dragActive && 'ring-2 ring-primary/50 ring-offset-2 rounded-md')}
      onDragEnter={(e) => { e.preventDefault(); setDragActive(true); }}
      onDragOver={(e) => e.preventDefault()}
      onDragLeave={() => setDragActive(false)}
      onDrop={onDrop}
      onPaste={onPaste}
    >
      {children}
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        multiple
        hidden
        onChange={(e) => {
          onFiles(e.target.files);
          e.target.value = '';
        }}
        disabled={disabled}
      />
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        disabled={disabled}
        className="absolute left-2 top-2 text-muted-foreground hover:text-foreground transition p-1 disabled:opacity-50"
        aria-label="Attach image"
        title="Attach image"
      >
        <Paperclip className="w-4 h-4" />
      </button>
    </div>
  );
}
