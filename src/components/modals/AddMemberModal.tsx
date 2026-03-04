import { useState } from 'react';
import { X, UserPlus, Loader2, Check, AlertCircle } from 'lucide-react';
import { useDashboardStore } from '../../store/dashboard-store';
import { cn } from '../../lib/utils';
import useTranslation from '../../i18n';
import type { AgentSummary } from '../../types/openclaw';

interface AddMemberModalProps {
  isOpen: boolean;
  sessionKey: string;
  currentMembers: string[];
  onClose: () => void;
  onSuccess: () => void;
}

export function AddMemberModal({ isOpen, sessionKey, currentMembers, onClose, onSuccess }: AddMemberModalProps) {
  const { t } = useTranslation();
  const [selectedAgents, setSelectedAgents] = useState<Set<string>>(new Set());
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { agents, patchSession } = useDashboardStore();
  const agentList = agents?.agents || [];

  // Filter out agents that are already members
  const availableAgents = agentList.filter((agent: AgentSummary) =>
    !currentMembers.includes(agent.id)
  );

  const toggleAgent = (agentId: string) => {
    const newSelected = new Set(selectedAgents);
    if (newSelected.has(agentId)) {
      newSelected.delete(agentId);
    } else {
      newSelected.add(agentId);
    }
    setSelectedAgents(newSelected);
  };

  const handleAdd = async () => {
    if (selectedAgents.size === 0) {
      setError(t('modals.addMember.selectAtLeastOne'));
      return;
    }

    setAdding(true);
    setError(null);

    try {
      const newMembers = [...currentMembers, ...Array.from(selectedAgents)];
      await patchSession(sessionKey, { members: newMembers });

      onSuccess();
      handleClose();
    } catch (err) {
      console.error('Failed to add members:', err);
      setError(err instanceof Error ? err.message : t('modals.addMember.failedToAdd'));
      setAdding(false);
    }
  };

  const handleClose = () => {
    if (!adding) {
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
      <div className="relative w-full max-w-md mx-4 bg-card border border rounded-xl shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="px-6 py-4 border-b border bg-card flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-gradient-to-br from-green-500/20 to-emerald-500/20 border border-green-500/30 rounded-lg">
              <UserPlus className="w-4 h-4 text-green-400" />
            </div>
            <div>
              <h2 className="text-sm font-bold text-foreground uppercase tracking-wider" style={{ fontFamily: 'IBM Plex Mono, monospace' }}>
                {t('modals.addMember.title')}
              </h2>
              <p className="text-xs text-muted-foreground font-mono">{t('modals.addMember.subtitle')}</p>
            </div>
          </div>
          <button
            onClick={handleClose}
            disabled={adding}
            className="p-1.5 rounded-lg hover:bg-muted text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Form */}
        <div className="p-6 space-y-4">
          {/* Agent Selection */}
          <div>
            <label className="block text-xs font-bold text-foreground mb-2 uppercase tracking-wide" style={{ fontFamily: 'IBM Plex Mono, monospace' }}>
              {t('modals.addMember.availableAgents')}
            </label>
            <div className="space-y-2 max-h-80 overflow-y-auto custom-scrollbar bg-background border border rounded-lg p-3">
              {availableAgents.length === 0 ? (
                <div className="text-center py-8 text-muted-foreground text-xs">
                  {t('modals.addMember.allAlreadyMembers')}
                </div>
              ) : (
                availableAgents.map((agent: AgentSummary) => {
                  const isSelected = selectedAgents.has(agent.id);
                  return (
                    <button
                      key={agent.id}
                      onClick={() => toggleAgent(agent.id)}
                      disabled={adding}
                      className={cn(
                        "w-full flex items-center gap-3 px-3 py-2 rounded-lg transition-all",
                        isSelected
                          ? "bg-green-500/20 border border-green-500/30"
                          : "bg-muted border border-transparent hover:bg-muted hover:border"
                      )}
                    >
                      {/* Checkbox */}
                      <div className={cn(
                        "w-5 h-5 rounded border-2 flex items-center justify-center transition-all flex-shrink-0",
                        isSelected
                          ? "bg-green-500 border-green-500"
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
              <p className="mt-2 text-xs text-green-400 font-mono">
                {t('modals.addMember.agentsSelected', { count: String(selectedAgents.size) })}
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
            disabled={adding}
            className="px-4 py-2 text-xs font-bold text-foreground hover:text-foreground uppercase tracking-wider transition-colors disabled:opacity-50"
            style={{ fontFamily: 'IBM Plex Mono, monospace' }}
          >
            {t('common.cancel')}
          </button>
          <button
            onClick={handleAdd}
            disabled={adding || selectedAgents.size === 0}
            className="px-4 py-2 bg-gradient-to-r from-green-500 to-emerald-500 hover:from-green-400 hover:to-emerald-400 text-zinc-950 text-xs font-bold uppercase tracking-wider rounded-lg transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
            style={{ fontFamily: 'IBM Plex Mono, monospace' }}
          >
            {adding ? (
              <>
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                {t('modals.addMember.adding')}
              </>
            ) : (
              <>
                <UserPlus className="w-3.5 h-3.5" />
                {t('modals.addMember.addButton')}
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
