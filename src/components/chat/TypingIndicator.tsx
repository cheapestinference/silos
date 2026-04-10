import * as React from 'react';
import { Zap } from 'lucide-react';
import { cn } from '../../lib/utils';
import { useTranslation } from '../../i18n';
import { extractMessageText, renderMarkdown } from './chat-utils';

/** Memoized streaming content renderer */
export const StreamingMarkdown = React.memo(function StreamingMarkdown({ text }: { text: string }) {
  return (
    <div className="streaming-cursor text-sm leading-relaxed break-words overflow-hidden" style={{ contain: 'content' }}>
      {renderMarkdown(text, 'preserve')}
    </div>
  );
});

export function TypingIndicator({ streamingContent, isComplete }: { streamingContent?: string; isComplete?: boolean }) {
  const { t } = useTranslation();

  const text = streamingContent
    ? (typeof streamingContent === 'string' ? streamingContent : extractMessageText(streamingContent) || '')
    : '';

  return (
    <div className={cn(
      "flex gap-4 animate-in fade-in slide-in-from-bottom-3 duration-500",
      isComplete && "transition-opacity duration-150 opacity-0"
    )}>
      {/* Avatar */}
      <div className="relative w-9 h-9 flex-shrink-0">
        <div className="w-9 h-9 rounded-lg bg-gradient-to-br from-primary to-accent flex items-center justify-center shadow-elevation-1">
          <Zap className={cn("w-4 h-4 text-white", !isComplete && "animate-pulse")} />
        </div>
      </div>

      <div className={cn("flex flex-col max-w-[70%] min-w-0", text && "w-full")}>
        <div className="flex items-center gap-2 mb-1.5 px-1">
          <span className="font-semibold text-xs text-primary tracking-wide flex items-center gap-1.5">
            {!isComplete && (
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary/60 opacity-75" />
                <span className="relative inline-flex rounded-full h-2 w-2 bg-primary" />
              </span>
            )}
            {t('chat.processing')}
          </span>
        </div>

        <div className={cn(
          "relative px-5 py-4 rounded-2xl rounded-bl-md overflow-hidden",
          "bg-card",
          "border border-primary/20",
          "shadow-sm",
          "transition-all duration-150 ease-out"
        )}>
          <div className="absolute inset-0 rounded-2xl rounded-bl-md bg-gradient-to-r from-primary/5 via-accent/5 to-primary/5 animate-gradient-x" />

          <div className="relative text-foreground min-h-[1.5rem]">
            {text ? (
              <StreamingMarkdown text={text} />
            ) : (
              <div className="flex items-center gap-2 py-1">
                <div className="flex items-center gap-1">
                  {[0, 1, 2, 3, 4].map((i) => (
                    <span
                      key={i}
                      className="w-1 bg-primary/60 rounded-full animate-wave"
                      style={{
                        height: '12px',
                        animationDelay: `${i * 100}ms`,
                      }}
                    />
                  ))}
                </div>
                <span className="text-xs text-muted-foreground ml-2">{t('chat.thinkingDeeply')}</span>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
