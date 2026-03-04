import * as React from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Search,
  Home,
  Bot,
  ListTodo,
  Settings,
  MessageSquare,
  ArrowRight,
  Command,
} from 'lucide-react';
import { cn } from '../../lib/utils';
import { useDashboardStore } from '../../store/dashboard-store';
import { useTranslation } from '../../i18n';

interface CommandItem {
  id: string;
  type: 'page' | 'agent' | 'session' | 'action';
  icon: React.ElementType;
  title: string;
  subtitle?: string;
  shortcut?: string;
  action: () => void;
}

export function CommandPalette() {
  const [open, setOpen] = React.useState(false);
  const [search, setSearch] = React.useState('');
  const [selectedIndex, setSelectedIndex] = React.useState(0);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const navigate = useNavigate();
  const { t } = useTranslation();
  const { agents, sessions, selectSession } = useDashboardStore();

  // Build command items
  const items = React.useMemo(() => {
    const commands: CommandItem[] = [];

    // Pages
    commands.push(
      {
        id: 'home',
        type: 'page',
        icon: Home,
        title: t('nav.home'),
        subtitle: t('dashboard.overview'),
        shortcut: 'G H',
        action: () => navigate('/'),
      },
      {
        id: 'tasks',
        type: 'page',
        icon: ListTodo,
        title: t('nav.tasks'),
        subtitle: t('tasks.subtitle'),
        shortcut: 'G T',
        action: () => navigate('/tasks'),
      },
      {
        id: 'settings',
        type: 'page',
        icon: Settings,
        title: t('nav.settings'),
        subtitle: t('settings.subtitle'),
        shortcut: 'G S',
        action: () => navigate('/settings'),
      }
    );

    // Agents
    const agentList = agents?.agents || [];
    agentList.forEach(agent => {
      commands.push({
        id: `agent-${agent.id}`,
        type: 'agent',
        icon: Bot,
        title: agent.identity?.name || agent.name || agent.id,
        subtitle: `${t('chat.title')} • ${agent.id}`,
        action: () => navigate(`/agents/${agent.id}`),
      });
    });

    // Sessions
    const sessionList = sessions?.sessions || [];
    sessionList.slice(0, 10).forEach(session => {
      commands.push({
        id: `session-${session.key}`,
        type: 'session',
        icon: MessageSquare,
        title: session.displayName || session.label || session.key,
        subtitle: session.surface || session.kind,
        action: () => {
          selectSession(session.key);
          navigate(`/session/${session.key}`);
        },
      });
    });

    return commands;
  }, [agents, sessions, navigate, selectSession, t]);

  // Filter items based on search
  const filteredItems = React.useMemo(() => {
    if (!search.trim()) return items;

    const query = search.toLowerCase();
    return items.filter(item =>
      item.title.toLowerCase().includes(query) ||
      item.subtitle?.toLowerCase().includes(query)
    );
  }, [items, search]);

  // Group items by type
  const groupedItems = React.useMemo(() => {
    const groups: { type: string; label: string; items: CommandItem[] }[] = [];

    const pages = filteredItems.filter(i => i.type === 'page');
    const agentItems = filteredItems.filter(i => i.type === 'agent');
    const sessionItems = filteredItems.filter(i => i.type === 'session');

    if (pages.length > 0) {
      groups.push({ type: 'page', label: 'Pages', items: pages });
    }
    if (agentItems.length > 0) {
      groups.push({ type: 'agent', label: t('nav.agents'), items: agentItems });
    }
    if (sessionItems.length > 0) {
      groups.push({ type: 'session', label: t('nav.sessions'), items: sessionItems });
    }

    return groups;
  }, [filteredItems, t]);

  // Flatten for keyboard navigation
  const flatItems = groupedItems.flatMap(g => g.items);

  // Handle keyboard shortcuts
  React.useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Open with Cmd+K or Ctrl+K
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setOpen(prev => !prev);
        return;
      }

      // Close with Escape
      if (e.key === 'Escape' && open) {
        e.preventDefault();
        setOpen(false);
        return;
      }

      if (!open) return;

      // Navigate with arrow keys
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIndex(prev => Math.min(prev + 1, flatItems.length - 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIndex(prev => Math.max(prev - 1, 0));
      } else if (e.key === 'Enter' && flatItems[selectedIndex]) {
        e.preventDefault();
        flatItems[selectedIndex].action();
        setOpen(false);
        setSearch('');
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [open, flatItems, selectedIndex]);

  // Reset selection when search changes
  React.useEffect(() => {
    setSelectedIndex(0);
  }, [search]);

  // Focus input when opening
  React.useEffect(() => {
    if (open) {
      inputRef.current?.focus();
    }
  }, [open]);

  if (!open) return null;

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm animate-fade-in"
        onClick={() => setOpen(false)}
      />

      {/* Palette */}
      <div className="fixed inset-0 z-50 flex items-start justify-center pt-[15vh]">
        <div
          className="w-full max-w-xl bg-zinc-900 rounded-xl border border-zinc-800 shadow-2xl overflow-hidden animate-zoom-in"
          onClick={e => e.stopPropagation()}
        >
          {/* Search Input */}
          <div className="flex items-center gap-3 px-4 border-b border-zinc-800">
            <Search className="w-5 h-5 text-zinc-500" />
            <input
              ref={inputRef}
              type="text"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder={t('common.search')}
              className="flex-1 h-14 bg-transparent text-zinc-100 placeholder:text-zinc-500 outline-none text-base"
            />
            <kbd className="hidden sm:flex items-center gap-1 px-2 py-1 rounded bg-zinc-800 text-zinc-400 text-xs font-mono">
              <Command className="w-3 h-3" />K
            </kbd>
          </div>

          {/* Results */}
          <div className="max-h-[400px] overflow-y-auto p-2">
            {groupedItems.length === 0 ? (
              <div className="py-12 text-center text-zinc-500">
                {t('common.noResults')}
              </div>
            ) : (
              groupedItems.map((group, groupIndex) => (
                <div key={group.type} className={groupIndex > 0 ? 'mt-4' : ''}>
                  <div className="px-2 py-1 text-xs font-medium text-zinc-500 uppercase tracking-wider">
                    {group.label}
                  </div>
                  {group.items.map(item => {
                    const itemIndex = flatItems.indexOf(item);
                    const isSelected = itemIndex === selectedIndex;
                    const Icon = item.icon;

                    return (
                      <button
                        key={item.id}
                        onClick={() => {
                          item.action();
                          setOpen(false);
                          setSearch('');
                        }}
                        onMouseEnter={() => setSelectedIndex(itemIndex)}
                        className={cn(
                          'w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-left transition-colors',
                          isSelected
                            ? 'bg-indigo-500/20 text-zinc-100'
                            : 'text-zinc-300 hover:bg-zinc-800'
                        )}
                      >
                        <div className={cn(
                          'w-8 h-8 rounded-lg flex items-center justify-center',
                          item.type === 'page' && 'bg-zinc-800',
                          item.type === 'agent' && 'bg-purple-500/20 text-purple-400',
                          item.type === 'session' && 'bg-blue-500/20 text-blue-500 dark:text-blue-400'
                        )}>
                          <Icon className="w-4 h-4" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="font-medium truncate">{item.title}</div>
                          {item.subtitle && (
                            <div className="text-xs text-zinc-500 truncate">{item.subtitle}</div>
                          )}
                        </div>
                        {item.shortcut && (
                          <div className="hidden sm:flex items-center gap-1">
                            {item.shortcut.split(' ').map((key, i) => (
                              <kbd key={i} className="px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-400 text-xs font-mono">
                                {key}
                              </kbd>
                            ))}
                          </div>
                        )}
                        {isSelected && (
                          <ArrowRight className="w-4 h-4 text-indigo-400" />
                        )}
                      </button>
                    );
                  })}
                </div>
              ))
            )}
          </div>

          {/* Footer */}
          <div className="flex items-center justify-between px-4 py-2 border-t border-zinc-800 text-xs text-zinc-500">
            <div className="flex items-center gap-4">
              <span className="flex items-center gap-1">
                <kbd className="px-1 py-0.5 rounded bg-zinc-800 text-zinc-400 font-mono">↑↓</kbd>
                navigate
              </span>
              <span className="flex items-center gap-1">
                <kbd className="px-1 py-0.5 rounded bg-zinc-800 text-zinc-400 font-mono">↵</kbd>
                select
              </span>
              <span className="flex items-center gap-1">
                <kbd className="px-1 py-0.5 rounded bg-zinc-800 text-zinc-400 font-mono">esc</kbd>
                close
              </span>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
