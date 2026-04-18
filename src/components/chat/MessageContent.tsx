// src/components/chat/MessageContent.tsx
import { Fragment } from 'react';
import { cn } from '../../lib/utils';
import type { ContentBlock, AssistantPhase } from '../../types/openclaw';
import { renderMarkdown } from './chat-utils';
import { ThinkingBlock } from './ThinkingBlock';
import { ToolCard } from './ToolCard';
import { extractToolCardsFromBlocks } from '../../lib/content-blocks';

interface MessageContentProps {
  blocks: ContentBlock[];
  /** If set, skip text blocks of other phases (keeps unphased). */
  phase?: AssistantPhase;
  /** Expand handler for large tool outputs. */
  onExpandTool?: (card: ReturnType<typeof extractToolCardsFromBlocks>[number]) => void;
  className?: string;
}

export function MessageContent({ blocks, phase, onExpandTool, className }: MessageContentProps) {
  const toolCards = extractToolCardsFromBlocks(blocks);
  // We render cards in-order, interleaved with text/thinking/images.
  // To keep a stable layout, iterate blocks and dispatch per type.
  // tool_result blocks are absorbed into the matching tool_call card and
  // therefore skipped when we see them standalone (unless orphan).
  const resultIdsConsumed = new Set(
    toolCards.map(c => c.toolCallId).filter((id): id is string => typeof id === 'string'),
  );

  return (
    <div className={cn('space-y-2', className)}>
      {blocks.map((b, i) => {
        if (b.type === 'text') {
          if (phase && b.phase && b.phase !== phase) return null;
          return <Fragment key={i}>{renderMarkdown(b.text)}</Fragment>;
        }
        if (b.type === 'thinking') {
          if (phase && b.phase && b.phase !== phase) return null;
          return <ThinkingBlock key={i} thinking={b.thinking} />;
        }
        if (b.type === 'tool_call') {
          const card = toolCards.find(c => c.toolCallId === b.toolCallId) || {
            name: b.name,
            args: b.args,
            toolCallId: b.toolCallId,
          };
          return <ToolCard key={i} card={card} onExpand={onExpandTool} />;
        }
        if (b.type === 'tool_result') {
          // Absorbed by matching tool_call already; render orphan only.
          if (b.toolCallId && resultIdsConsumed.has(b.toolCallId)) return null;
          return (
            <ToolCard
              key={i}
              card={{
                name: 'tool result',
                resultText: b.text,
                isError: b.isError,
                toolCallId: b.toolCallId,
              }}
              onExpand={onExpandTool}
            />
          );
        }
        if (b.type === 'image') {
          const url =
            b.source.type === 'url'
              ? b.source.url
              : b.source.data.startsWith('data:')
                ? b.source.data
                : `data:${b.source.mediaType || 'image/png'};base64,${b.source.data}`;
          return (
            <img
              key={i}
              src={url}
              alt="attachment"
              className="max-w-full max-h-80 rounded-md border border-border/40"
              loading="lazy"
            />
          );
        }
        return null;
      })}
    </div>
  );
}
