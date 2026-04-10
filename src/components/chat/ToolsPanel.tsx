import { useMemo } from 'react';
import { Wrench } from 'lucide-react';
import { useTranslation } from '../../i18n';
import type { ChatMessage } from '../../types/openclaw';
import { extractMessageText } from './chat-utils';
import { ToolCallExpander } from './ToolCallExpander';

interface ToolsPanelProps {
  messages: ChatMessage[];
}

export function ToolsPanel({ messages }: ToolsPanelProps) {
  const { t } = useTranslation();

  const reversed = useMemo(() => {
    const toolMessages = messages.filter(
      m => m.role === 'tool' || m.toolName || m.toolCall || m.result
    );
    return toolMessages.reverse();
  }, [messages]);

  if (reversed.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-center px-6 py-12">
        <div className="w-12 h-12 rounded-xl bg-muted dark:bg-muted border border-border flex items-center justify-center mb-4">
          <Wrench className="w-6 h-6 text-cyan-500/50" />
        </div>
        <p className="text-sm font-medium text-muted-foreground mb-1">{t('chat.noToolActivity')}</p>
        <p className="text-xs text-muted-foreground/60">{t('chat.toolCallsAppear')}</p>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto custom-scrollbar p-3 space-y-2">
      {reversed.map((msg) => (
        <ToolCallExpander
          key={msg.id}
          toolName={msg.toolName}
          toolCall={msg.toolCall}
          result={msg.result}
          content={extractMessageText(msg) || msg.content}
        />
      ))}
    </div>
  );
}
