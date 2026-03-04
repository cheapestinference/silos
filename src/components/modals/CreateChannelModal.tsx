import { useState } from 'react';
import { X, Hash, Loader2, Check, AlertCircle } from 'lucide-react';
import { useDashboardStore } from '../../store/dashboard-store';
import { cn } from '../../lib/utils';
import useTranslation from '../../i18n';
import type { AgentSummary } from '../../types/openclaw';

interface CreateChannelModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: (sessionKey: string, members: string[]) => void;
}

export function CreateChannelModal({ isOpen, onClose, onSuccess }: CreateChannelModalProps) {
  const { t } = useTranslation();
  const [channelName, setChannelName] = useState('');
  const [selectedAgents, setSelectedAgents] = useState<Set<string>>(new Set());
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { agents } = useDashboardStore();
  const agentList = agents?.agents || [];

  // Generate channel key from name
  const generateChannelKey = (name: string): string => {
    const slug = name
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .replace(/-+/g, '-');

    return `channel-${slug}-${Date.now().toString(36)}`;
  };

  const toggleAgent = (agentId: string) => {
    const newSelected = new Set(selectedAgents);
    if (newSelected.has(agentId)) {
      newSelected.delete(agentId);
    } else {
      newSelected.add(agentId);
    }
    setSelectedAgents(newSelected);
  };

  const handleCreate = async () => {
    if (!channelName.trim()) {
      setError(t('modals.createChannel.nameRequired'));
      return;
    }

    if (selectedAgents.size === 0) {
      setError(t('modals.createChannel.selectAtLeastOne'));
      return;
    }

    setCreating(true);
    setError(null);

    try {
      const sessionKey = generateChannelKey(channelName);
      const members = Array.from(selectedAgents);

      // Pass sessionKey and members to parent
      onSuccess(sessionKey, members);
      handleClose();
    } catch (err) {
      console.error('Failed to create channel:', err);
      setError(err instanceof Error ? err.message : 'Failed to create channel');
      setCreating(false);
    }
  };

  const handleClose = () => {
    if (!creating) {
      setChannelName('');
      setSelectedAgents(new Set());
      setError(null);
      onClose();
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={handleClose}
      />

      {/* Modal */}
      <div className="relative w-full max-w-lg mx-4 bg-card border border rounded-xl shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="px-6 py-4 border-b border bg-card flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-gradient-to-br from-blue-500/20 to-indigo-500/20 border border-blue-500/30 rounded-lg">
              <Hash className="w-4 h-4 text-blue-400" />
            </div>
            <div>
              <h2 className="text-sm font-bold text-foreground uppercase tracking-wider" style={{ fontFamily: 'IBM Plex Mono, monospace' }}>
                {t('modals.createChannel.title')}
              </h2>
              <p className="text-xs text-muted-foreground font-mono">{t('modals.createChannel.subtitle')}</p>
            </div>
          </div>
          <button
            onClick={handleClose}
            disabled={creating}
            className="p-1.5 rounded-lg hover:bg-muted text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Form */}
        <div className="p-6 space-y-5">
          {/* Channel Name */}
          <div>
            <label className="block text-xs font-bold text-foreground mb-2 uppercase tracking-wide" style={{ fontFamily: 'IBM Plex Mono, monospace' }}>
              {t('modals.createChannel.channelName')} <span className="text-red-400">*</span>
            </label>
            <div className="relative">
              <Hash className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <input
                type="text"
                value={channelName}
                onChange={(e) => setChannelName(e.target.value)}
                placeholder="general"
                className="w-full pl-10 pr-3 py-2 bg-background border border rounded-lg text-sm text-foreground font-mono placeholder:text-muted-foreground focus:outline-none focus:border-blue-500/50 focus:ring-2 focus:ring-blue-500/20 transition-all"
                disabled={creating}
                autoFocus
              />
            </div>
          </div>

          {/* Agent Selection */}
          <div>
            <label className="block text-xs font-bold text-foreground mb-2 uppercase tracking-wide" style={{ fontFamily: 'IBM Plex Mono, monospace' }}>
              {t('modals.createChannel.selectAgents')} <span className="text-red-400">*</span>
            </label>
            <div className="space-y-2 max-h-64 overflow-y-auto custom-scrollbar bg-background border border rounded-lg p-3">
              {agentList.length === 0 ? (
                <div className="text-center py-8 text-muted-foreground text-xs">
                  {t('modals.createChannel.noAgentsAvailable')}
                </div>
              ) : (
                agentList.map((agent: AgentSummary) => {
                  const isSelected = selectedAgents.has(agent.id);
                  return (
                    <button
                      key={agent.id}
                      onClick={() => toggleAgent(agent.id)}
                      disabled={creating}
                      className={cn(
                        "w-full flex items-center gap-3 px-3 py-2 rounded-lg transition-all",
                        isSelected
                          ? "bg-blue-500/20 border border-blue-500/30"
                          : "bg-muted border border-transparent hover:bg-muted hover:border"
                      )}
                    >
                      {/* Checkbox */}
                      <div className={cn(
                        "w-5 h-5 rounded border-2 flex items-center justify-center transition-all flex-shrink-0",
                        isSelected
                          ? "bg-blue-500 border-blue-500"
                          : "border"
                      )}>
                        {isSelected && <Check className="w-3.5 h-3.5 text-white" />}
                      </div>

                      {/* Agent Info */}
                      <div className="flex items-center gap-2 flex-1 min-w-0">
                        <div className="w-6 h-6 rounded bg-purple-500/20 border border-purple-500/30 flex items-center justify-center text-xs">
                          {agent.identity?.emoji || '🤖'}
                        </div>
                        <span className="text-sm text-foreground font-medium truncate">
                          {agent.identity?.name || agent.name || agent.id}
                        </span>
                      </div>
                    </button>
                  );
                })
              )}
            </div>
            {selectedAgents.size > 0 && (
              <p className="mt-2 text-xs text-blue-400 font-mono">
                {t('modals.createChannel.agentsSelected', { count: String(selectedAgents.size) })}
              </p>
            )}
          </div>

          {/* Error Message */}
          {error && (
            <div className="p-3 bg-red-500/10 border border-red-500/30 rounded-lg flex items-start gap-2">
              <AlertCircle className="w-4 h-4 text-red-400 mt-0.5 shrink-0" />
              <p className="text-xs text-red-400 font-mono">{error}</p>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border bg-card flex items-center justify-end gap-3">
          <button
            onClick={handleClose}
            disabled={creating}
            className="px-4 py-2 text-xs font-bold text-foreground hover:text-foreground uppercase tracking-wider transition-colors disabled:opacity-50"
            style={{ fontFamily: 'IBM Plex Mono, monospace' }}
          >
            {t('common.cancel')}
          </button>
          <button
            onClick={handleCreate}
            disabled={creating || !channelName.trim() || selectedAgents.size === 0}
            className="px-4 py-2 bg-gradient-to-r from-blue-500 to-indigo-500 hover:from-blue-400 hover:to-indigo-400 text-zinc-950 text-xs font-bold uppercase tracking-wider rounded-lg transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
            style={{ fontFamily: 'IBM Plex Mono, monospace' }}
          >
            {creating ? (
              <>
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                {t('modals.createChannel.creating')}
              </>
            ) : (
              <>
                <Hash className="w-3.5 h-3.5" />
                {t('modals.createChannel.createButton')}
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
