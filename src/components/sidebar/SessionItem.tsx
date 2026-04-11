import { useState, useRef, useEffect } from 'react';
import { cn } from '../../lib/utils';
import { useTranslation } from '../../i18n';
import {
  MessageCircle,
  Smartphone,
  Hash,
  ScrollText,
  GitBranch,
  Trash2,
  Pencil,
  Check,
  X,
} from 'lucide-react';

export interface SessionItemProps {
  sessionKey: string;
  sessionType: string;
  label?: string;
  displayName?: string;
  defaultLabel: string;
  active?: boolean;
  onClick: () => void;
  onRename: (newLabel: string) => void;
  onDelete: () => void;
  isSubagent?: boolean;
  isCron?: boolean;
  isCompleted?: boolean;
  unreadCount?: number;
}

export function SessionItem({
  sessionType,
  label,
  displayName,
  defaultLabel,
  active,
  onClick,
  onRename,
  onDelete,
  isSubagent,
  isCron,
  isCompleted,
  unreadCount = 0,
}: SessionItemProps) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  // Translate known session type labels
  const translatedDefault = sessionType === 'main' ? t('sidebar.sessionTypes.main')
    : sessionType === 'webchat' ? t('sidebar.sessionTypes.webchat')
    : defaultLabel;

  // Display name priority: label > displayName > translated defaultLabel
  const displayedName = label || displayName || translatedDefault;

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  const handleStartEdit = (e: React.MouseEvent) => {
    e.stopPropagation();
    setEditValue(displayedName);
    setEditing(true);
  };

  const handleSave = () => {
    if (editValue.trim() && editValue !== displayedName) {
      onRename(editValue.trim());
    }
    setEditing(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleSave();
    } else if (e.key === 'Escape') {
      setEditing(false);
    }
  };

  // Get appropriate icon based on session type
  const getIcon = (): React.ElementType | null => {
    if (isSubagent) return GitBranch;
    if (isCron) return ScrollText;
    switch (sessionType) {
      case 'main':
      case 'webchat':
        return MessageCircle;
      case 'whatsapp':
      case 'telegram':
        return Smartphone;
      case 'slack':
      case 'discord':
        return Hash;
      case 'cron':
        return ScrollText;
      default:
        return Hash;
    }
  };

  const Icon = getIcon();

  if (editing) {
    return (
      <div className="flex items-center gap-1.5 px-2 py-1">
        <input
          ref={inputRef}
          type="text"
          value={editValue}
          onChange={(e) => setEditValue(e.target.value)}
          onBlur={handleSave}
          onKeyDown={handleKeyDown}
          className="flex-1 text-sm px-2 py-1 bg-sidebar-hover border border-primary/40 rounded focus:outline-none focus:ring-1 focus:ring-primary text-sidebar-fg min-w-0"
        />
        <button
          onClick={handleSave}
          className="p-1 text-green-500 hover:bg-green-500/10 rounded"
        >
          <Check className="w-3.5 h-3.5" />
        </button>
        <button
          onClick={() => setEditing(false)}
          className="p-1 text-red-500 hover:bg-red-500/10 rounded"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
    );
  }

  return (
    <div className="group flex items-center gap-0.5">
      <button
        onClick={onClick}
        className={cn(
          "flex-1 px-2 py-0.5 rounded flex items-center gap-1.5 transition-colors min-w-0",
          active
            ? "bg-primary/10 text-primary font-medium"
            : "text-sidebar-fg/80 hover:text-sidebar-fg hover:bg-sidebar-hover",
        )}
      >
        {Icon && (
          <Icon className={cn(
            "shrink-0 w-3.5 h-3.5",
            isSubagent ? "text-cyan-500 opacity-80" : isCron ? "text-amber-500 opacity-80" : "opacity-60"
          )} />
        )}
        <span className="flex-1 text-left truncate text-xs">{displayedName}</span>
        {unreadCount > 0 && !active && (
          <span className="shrink-0 min-w-[18px] h-[18px] px-1 flex items-center justify-center text-[10px] font-bold rounded-full bg-blue-500 text-white">
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        )}
        {isSubagent && isCompleted && (
          <Check className="w-3.5 h-3.5 text-green-500 shrink-0" />
        )}
      </button>

      {/* Action buttons (visible on hover) */}
      <div className="flex items-center opacity-0 group-hover:opacity-100 transition-opacity">
        <button
          onClick={handleStartEdit}
          className="p-1 hover:bg-sidebar-hover rounded text-muted-foreground hover:text-foreground"
          title="Rename"
        >
          <Pencil className="w-3.5 h-3.5" />
        </button>
        <button
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          className="p-1 hover:bg-red-500/10 rounded text-muted-foreground hover:text-red-500"
          title="Delete"
        >
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
}
