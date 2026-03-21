import * as React from 'react';
import { cn } from '../../lib/utils';

export interface TextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  autoResize?: boolean;
}

const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, autoResize = false, onChange, ...props }, ref) => {
    const internalRef = React.useRef<HTMLTextAreaElement>(null);
    const textareaRef = (ref as React.RefObject<HTMLTextAreaElement>) || internalRef;

    const adjustHeight = React.useCallback(() => {
      const textarea = textareaRef.current;
      if (textarea && autoResize) {
        textarea.style.height = 'auto';
        textarea.style.height = `${textarea.scrollHeight}px`;
      }
    }, [autoResize, textareaRef]);

    React.useEffect(() => {
      adjustHeight();
    }, [adjustHeight, props.value]);

    const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      onChange?.(e);
      if (autoResize) {
        adjustHeight();
      }
    };

    return (
      <textarea
        className={cn(
          'flex min-h-[80px] w-full rounded-lg border border-border bg-muted px-3 py-2',
          'text-sm text-foreground placeholder:text-muted-foreground',
          'ring-offset-background transition-colors shadow-elevation-0',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:border-ring',
          'disabled:cursor-not-allowed disabled:opacity-50',
          'resize-none',
          autoResize && 'overflow-hidden',
          className
        )}
        ref={textareaRef}
        onChange={handleChange}
        {...props}
      />
    );
  }
);
Textarea.displayName = 'Textarea';

export { Textarea };
