import { Clock, X } from 'lucide-react';
import { useTranslation } from '../../i18n';

export function ActivityBar({ queuedCount, onRemoveLast }: {
  queuedCount: number;
  onRemoveLast: () => void;
}) {
  const { t } = useTranslation();

  return (
    <div className="flex items-center justify-between px-4 py-1.5 bg-amber-500/5 border border-amber-500/20 rounded-lg mx-4 mb-2 animate-in fade-in slide-in-from-bottom-2 duration-200">
      <div className="flex items-center gap-2 text-amber-600 dark:text-amber-400">
        <Clock className="w-3.5 h-3.5" />
        <span className="text-xs font-medium">
          {queuedCount} {queuedCount === 1 ? 'message' : 'messages'} {t('chat.messagesQueued')}
        </span>
      </div>
      <button
        onClick={onRemoveLast}
        className="flex items-center gap-1 text-xs font-medium px-2.5 py-1 rounded-md transition-all bg-rose-500/10 text-rose-600 dark:text-rose-400 hover:bg-rose-500/20"
      >
        <X className="w-3 h-3" />
        {t('chat.removeQueued')}
      </button>
    </div>
  );
}
