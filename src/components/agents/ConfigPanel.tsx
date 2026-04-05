import { useState, useEffect } from 'react';
import {
  AlertTriangle,
  Bot,
  Brain,
  Check,
  Copy,
  Database,
  ExternalLink,
  RefreshCw,
  Save,
  Settings,
  Terminal,
  Trash2,
  Users,
} from 'lucide-react';
import { cn } from '../../lib/utils';
import useTranslation from '../../i18n';
import { useDashboardStore } from '../../store/dashboard-store';
import { getGatewayClient } from '../../lib/gateway-client';
import { SettingsTab } from './SettingsTab';
import { ConfigCard, ConfigRow } from './shared';
import type { AgentSettings } from '../../types/openclaw';

import { useParams, useNavigate } from 'react-router-dom';

export function ConfigPanel() {
  const { id: agentId } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { t } = useTranslation();
  const { agents, selectedAgentConfig, loadAgentConfig, saveAgentConfig, gatewayConfig, deleteAgent, resetAgent } = useDashboardStore();

  useEffect(() => {
    if (agentId) loadAgentConfig(agentId);
  }, [agentId, loadAgentConfig]);

  if (!agentId) return null;

  const agent = agents?.agents.find(a => a.id === agentId);
  const config = selectedAgentConfig;
  const onNavigateToMemory = () => navigate(`/agents/${agentId}/brain`);
  if (!agent) return null;
  const settings = config?.settings || {};

  // Extract models from gateway config:
  // - Global default: agents.defaults.model.primary
  // - Per-agent override: agents.list[].model (string or { primary })
  const agentsSection = (gatewayConfig?.config as Record<string, unknown>)?.agents as
    { defaults?: { model?: { primary?: string } }; list?: Array<{ id: string; model?: string | { primary?: string } }> } | undefined;
  const gatewayDefaultModel = agentsSection?.defaults?.model?.primary || '';
  const agentEntry = agentsSection?.list?.find(a => a.id === agent.id);
  const agentModelOverride = agentEntry?.model
    ? (typeof agentEntry.model === 'string' ? agentEntry.model : agentEntry.model.primary || '')
    : '';
  // Effective model: per-agent override > global default
  const activeModel = agentModelOverride || gatewayDefaultModel;

  // Initialize local settings with the active model
  const effectiveSettings = {
    ...settings,
    model: settings.model || activeModel,
  };
  const [localSettings, setLocalSettings] = useState<AgentSettings>(effectiveSettings);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [settingsSaved, setSettingsSaved] = useState(false);
  const [settingsError, setSettingsError] = useState<string | null>(null);

  // Sync local settings when config or gateway config changes
  useEffect(() => {
    const model = config?.settings?.model || agentModelOverride || gatewayDefaultModel;
    setLocalSettings({
      ...(config?.settings || {}),
      model,
    });
  }, [config?.settings, agentModelOverride, gatewayDefaultModel]);

  const handleSaveSettings = async () => {
    setSettingsSaving(true);
    setSettingsError(null);
    try {
      // Model changes
      if (localSettings.model && localSettings.model !== activeModel) {
        const client = getGatewayClient();
        if (!client) {
          setSettingsError('Not connected to gateway');
          setSettingsSaving(false);
          return;
        }
        if (agentEntry) {
          // Agent has an explicit entry in agents.list — use agents.update (no restart)
          await client.updateAgent(agent.id, { model: localSettings.model });
        } else {
          // Agent not in agents.list (e.g. the default "main" agent) — add it via
          // agents.create first (no restart), then set model via agents.update
          await client.createAgent({ name: agent.id, workspace: agent.id });
          await client.updateAgent(agent.id, { model: localSettings.model });
        }
      }
      // Save other settings (temperature, maxTokens, etc.) via agents.update
      const { model: _model, ...otherSettings } = localSettings;
      if (Object.keys(otherSettings).length > 0) {
        await saveAgentConfig(agent.id, { settings: otherSettings });
      }
      setSettingsSaved(true);
      setTimeout(() => setSettingsSaved(false), 2000);
    } catch (err) {
      console.error('Failed to save settings:', err);
      setSettingsError(String(err));
    } finally {
      setSettingsSaving(false);
    }
  };

  // Agent-to-Agent state
  const [a2aEnabled, setA2aEnabled] = useState(settings.agentToAgent?.enabled || false);
  const [a2aAllowedAgents, setA2aAllowedAgents] = useState<string>(
    (settings.agentToAgent?.allowedAgents || []).join(', ')
  );

  const [copiedPrompt, setCopiedPrompt] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // Get list of other agents for reference
  const otherAgents = agents?.agents.filter(a => a.id !== agent.id) || [];
  const isMainAgent = agentId === 'main';

  const handleDeleteAgent = async () => {
    setDeleting(true);
    try {
      if (isMainAgent) {
        await resetAgent(agentId);
      } else {
        await deleteAgent(agentId);
      }
      setShowDeleteConfirm(false);
      if (!isMainAgent) navigate('/');
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="h-full overflow-y-auto p-6 animate-in fade-in duration-300">
      <div className="max-w-4xl mx-auto space-y-6">
        {/* Header */}
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-muted border border-border flex items-center justify-center">
            <Settings className="w-5 h-5 text-foreground/60" />
          </div>
          <div>
            <h3 className="text-sm font-bold text-foreground" style={{ fontFamily: 'Inter, system-ui, sans-serif' }}>
              {t('agentDetail.agentConfiguration')}
            </h3>
            <p className="text-xs text-muted-foreground">{t('agentDetail.configDescription')}</p>
          </div>
        </div>

        {/* Model & Generation Settings */}
        <div className="rounded-2xl border border-border bg-card overflow-hidden">
          <div className="p-5">
            <SettingsTab settings={localSettings} onChange={setLocalSettings} />
          </div>
          <div className="px-5 pb-4 pt-2 border-t border-border flex items-center gap-3">
            <button
              onClick={handleSaveSettings}
              disabled={settingsSaving}
              className="px-4 py-2 bg-primary hover:bg-primary/90 disabled:opacity-50 rounded-lg text-sm font-medium text-primary-foreground transition-colors flex items-center gap-2"
            >
              {settingsSaving ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
              {settingsSaving ? t('agentDetail.saving') : t('agentDetail.saveSettings')}
            </button>
            {settingsSaved && (
              <span className="text-xs text-emerald-600 dark:text-emerald-400 flex items-center gap-1">
                <Check className="w-3.5 h-3.5" /> {t('agentDetail.settingsSaved')}
              </span>
            )}
            {settingsError && (
              <span className="text-xs text-red-600 dark:text-red-400">{settingsError}</span>
            )}
          </div>
        </div>

        {/* Config Sections Grid */}
        <div className="grid grid-cols-2 gap-4">
          {/* Identity */}
          <ConfigCard
            title={t('agentDetail.agentIdentity')}
            icon={<Bot className="w-4 h-4" />}
            color="violet"
          >
            <ConfigRow label={t('agentDetail.id')} value={agent.id} mono />
            <ConfigRow label={t('agentDetail.name')} value={agent.identity?.name || agent.name || t('agentDetail.notSet')} />
            <ConfigRow label={t('agentDetail.emoji')} value={agent.identity?.emoji || '🤖'} />
          </ConfigCard>

          {/* Paths */}
          <ConfigCard
            title={t('agentDetail.filePaths')}
            icon={<Database className="w-4 h-4" />}
            color="amber"
          >
            <ConfigRow label={t('agentDetail.workspacePath')} value={`~/.openclaw/workspace/${agent.id}`} mono small />
            <ConfigRow label={t('agentDetail.stateDir')} value="~/.openclaw/state" mono small />
            <ConfigRow label={t('agentDetail.memoryDb')} value={`~/.openclaw/state/memory/${agent.id}.sqlite`} mono small />
            <ConfigRow label={t('agentDetail.skillsPath')} value="~/.openclaw/skills" mono small />
          </ConfigCard>
        </div>

        {/* Agent-to-Agent Communication Section (hidden) */}
        <div className="hidden bg-gradient-to-br from-blue-500/10 to-primary/5 rounded-2xl border border-blue-500/20 overflow-hidden">
          <div className="px-5 py-4 border-b border-blue-500/20 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-xl bg-blue-500/20 flex items-center justify-center">
                <Users className="w-4.5 h-4.5 text-blue-500 dark:text-blue-400" />
              </div>
              <div>
                <h4 className="text-sm font-bold text-foreground">{t('agentDetail.a2aCommunication')}</h4>
                <p className="text-[11px] text-muted-foreground">{t('agentDetail.a2aDescription')}</p>
              </div>
            </div>
            <label className="relative inline-flex items-center cursor-pointer">
              <input
                type="checkbox"
                checked={a2aEnabled}
                onChange={(e) => setA2aEnabled(e.target.checked)}
                className="sr-only peer"
              />
              <div className="w-11 h-6 bg-muted-foreground peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-blue-500"></div>
            </label>
          </div>

          <div className="p-5 space-y-4">
            {/* Allowed Agents */}
            <div>
              <label className="block text-xs font-semibold text-foreground/80 mb-2">
                {t('agentDetail.allowedAgents')}
                <span className="ml-2 text-muted-foreground font-normal">
                  {t('agentDetail.agentsSeparatorHint')}
                </span>
              </label>
              <input
                type="text"
                value={a2aAllowedAgents}
                onChange={(e) => setA2aAllowedAgents(e.target.value)}
                placeholder={otherAgents.length > 0 ? otherAgents.map(a => a.id).join(', ') : 'agent2, agent3, *'}
                className="w-full px-3 py-2 bg-muted border border-border rounded-lg text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-blue-500/40 focus:ring-1 focus:ring-blue-500/20 font-mono"
              />
              {otherAgents.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  <span className="text-[10px] text-muted-foreground mr-1">{t('agentDetail.available')}</span>
                  {otherAgents.map(a => (
                    <button
                      key={a.id}
                      onClick={() => {
                        const current = a2aAllowedAgents.split(',').map(s => s.trim()).filter(s => s);
                        if (!current.includes(a.id)) {
                          setA2aAllowedAgents([...current, a.id].join(', '));
                        }
                      }}
                      className="px-2 py-0.5 text-[10px] bg-muted hover:bg-muted border border-border rounded-md text-muted-foreground hover:text-foreground transition-colors font-mono"
                    >
                      {a.identity?.emoji || '🤖'} {a.id}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* How to Configure */}
            <div className="space-y-4">
              <div>
                <p className="text-xs font-semibold text-foreground/80 mb-3">
                  {t('agentDetail.delegationRulesTitle')}
                </p>
                <p className="text-[11px] text-muted-foreground mb-4">
                  {t('agentDetail.delegationRulesExplanation')}
                </p>
              </div>

              {/* Option 1: Memory Tab */}
              <div className="bg-emerald-500/10 border border-emerald-500/20 rounded-xl p-4">
                <div className="flex items-start gap-3">
                  <div className="w-8 h-8 rounded-lg bg-emerald-500/20 flex items-center justify-center shrink-0">
                    <span className="text-emerald-600 dark:text-emerald-400 font-bold text-sm">1</span>
                  </div>
                  <div className="flex-1">
                    <p className="text-xs font-semibold text-emerald-700 dark:text-emerald-300 mb-1">{t('agentDetail.editAgentsDirectly')}</p>
                    <p className="text-[11px] text-muted-foreground mb-3">
                      Go to the <span className="text-foreground">Memory</span> tab and edit <span className="text-foreground font-mono">AGENTS.md</span> to add your delegation rules.
                    </p>
                    <button
                      onClick={onNavigateToMemory}
                      className="flex items-center gap-2 px-3 py-1.5 text-xs font-medium bg-emerald-500/20 hover:bg-emerald-500/20 text-emerald-700 dark:text-emerald-300 border border-emerald-500/20 rounded-lg transition-all"
                    >
                      <Brain className="w-3.5 h-3.5" />
                      {t('agentDetail.goToMemoryTab')}
                    </button>
                  </div>
                </div>
              </div>

              {/* Option 2: Ask the agent */}
              <div className="bg-blue-500/10 border border-blue-500/20 rounded-xl p-4">
                <div className="flex items-start gap-3">
                  <div className="w-8 h-8 rounded-lg bg-blue-500/20 flex items-center justify-center shrink-0">
                    <span className="text-blue-500 dark:text-blue-400 font-bold text-sm">2</span>
                  </div>
                  <div className="flex-1">
                    <p className="text-xs font-semibold text-blue-600 dark:text-blue-300 mb-1">{t('agentDetail.askAgentToUpdate')}</p>
                    <p className="text-[11px] text-muted-foreground mb-3">
                      {t('agentDetail.copyMessageHint')}
                    </p>
                    <div className="bg-muted rounded-lg p-3 mb-3">
                      <pre className="text-[10px] font-mono text-muted-foreground whitespace-pre-wrap leading-relaxed">
{`Please add the following section to your AGENTS.md file:

## Agent Delegation

You can delegate tasks to other agents:
- sessions_send({ agentId: "...", message: "..." }) - Send to agent
- sessions_spawn({ task: "...", label: "..." }) - Background subagent

Rules:
${a2aAllowedAgents ? `- Allowed agents: ${a2aAllowedAgents}` : '- [Add your rules here]'}
- [Add specific delegation criteria]`}
                      </pre>
                    </div>
                    <button
                      onClick={() => {
                        const message = `Please add the following section to your AGENTS.md file:

## Agent Delegation

You can delegate tasks to other agents:
- sessions_send({ agentId: "...", message: "..." }) - Send to agent
- sessions_spawn({ task: "...", label: "..." }) - Background subagent

Rules:
${a2aAllowedAgents ? `- Allowed agents: ${a2aAllowedAgents}` : '- [Add your rules here]'}
- [Add specific delegation criteria]`;
                        navigator.clipboard.writeText(message);
                        setCopiedPrompt(true);
                        setTimeout(() => setCopiedPrompt(false), 2000);
                      }}
                      className={cn(
                        "flex items-center gap-2 px-3 py-1.5 text-xs font-medium border rounded-lg transition-all",
                        copiedPrompt
                          ? "bg-emerald-500/20 text-emerald-700 dark:text-emerald-300 border-emerald-500/20"
                          : "bg-blue-500/20 hover:bg-blue-500/20 text-blue-600 dark:text-blue-300 border-blue-500/20"
                      )}
                    >
                      {copiedPrompt ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                      {copiedPrompt ? t('agentDetail.copied') : t('agentDetail.copyMessage')}
                    </button>
                  </div>
                </div>
              </div>

              {/* Available tools reference */}
              <div className="bg-muted/40 rounded-xl p-4 border border-border">
                <p className="text-xs font-semibold text-foreground/80 mb-3">{t('agentDetail.availableToolsReference')}</p>
                <div className="space-y-2 text-[11px] font-mono text-muted-foreground">
                  <div className="bg-muted rounded-lg p-2">
                    <span className="text-blue-500 dark:text-blue-400">sessions_send</span>({'{'} agentId, message {'}'}) <span className="text-muted-foreground">// Send to another agent</span>
                  </div>
                  <div className="bg-muted rounded-lg p-2">
                    <span className="text-primary">sessions_spawn</span>({'{'} task, label {'}'}) <span className="text-muted-foreground">// Spawn background subagent</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>


        {/* Raw JSON Preview (hidden) */}
        <div className="hidden bg-muted/40 border border-border rounded-2xl overflow-hidden">
          <div className="px-4 py-3 border-b border-border flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Terminal className="w-4 h-4 text-muted-foreground" />
              <h4 className="text-xs font-bold text-muted-foreground uppercase tracking-wider">{t('agentDetail.rawConfiguration')}</h4>
            </div>
            <button className="text-[10px] text-muted-foreground hover:text-foreground transition-colors flex items-center gap-1">
              <ExternalLink className="w-3 h-3" />
              {t('agentDetail.export')}
            </button>
          </div>
          <div className="p-4 max-h-64 overflow-y-auto">
            <pre className="text-[10px] font-mono text-muted-foreground leading-relaxed" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
              {JSON.stringify(agent, null, 2)}
            </pre>
          </div>
        </div>

        {/* Danger Zone */}
        <div className="rounded-2xl border border-red-500/20 bg-red-500/5 overflow-hidden">
          <div className="px-5 py-4 border-b border-red-500/20">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-xl bg-red-500/15 flex items-center justify-center">
                <AlertTriangle className="w-4.5 h-4.5 text-red-500 dark:text-red-400" />
              </div>
              <div>
                <h4 className="text-sm font-bold text-red-700 dark:text-red-300" style={{ fontFamily: 'Inter, system-ui, sans-serif' }}>
                  {isMainAgent ? t('agentDetail.resetAgent') : t('agentDetail.deleteAgent')}
                </h4>
                <p className="text-[11px] text-red-600/70 dark:text-red-400/70">
                  {isMainAgent ? t('agentDetail.resetDetails') : t('agentDetail.deleteDetails')}
                </p>
              </div>
            </div>
          </div>
          <div className="px-5 py-4">
            <button
              onClick={() => setShowDeleteConfirm(true)}
              className="flex items-center gap-2 px-4 py-2 text-sm font-semibold rounded-lg bg-red-500/15 text-red-700 dark:text-red-300 border border-red-500/20 hover:bg-red-500/20 hover:border-red-500/50 transition-all"
            >
              <Trash2 className="w-4 h-4" />
              {isMainAgent ? t('agentDetail.resetAgent') : t('agentDetail.deleteAgent')}
            </button>
          </div>
        </div>
      </div>

      {/* Delete/Reset Confirmation Modal */}
      {showDeleteConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm animate-in fade-in duration-200">
          <div className="bg-card border border-border rounded-2xl shadow-2xl w-full max-w-md mx-4 animate-in zoom-in-95 duration-200">
            <div className="p-6">
              <div className="flex items-center gap-3 mb-4">
                <div className="w-12 h-12 rounded-xl bg-red-500/15 flex items-center justify-center">
                  <AlertTriangle className="w-6 h-6 text-red-500" />
                </div>
                <div>
                  <h3 className="text-lg font-bold text-foreground">
                    {isMainAgent ? t('agentDetail.resetAgent') : t('agentDetail.deleteAgent')}
                  </h3>
                  <p className="text-xs text-muted-foreground">{t('agentDetail.deleteWarning')}</p>
                </div>
              </div>
              <div className="bg-muted/40 rounded-xl p-4 mb-6">
                <p className="text-sm text-foreground mb-2">
                  {t('agentDetail.confirmDelete')} <span className="font-bold">{agent.identity?.name || agent.name || agent.id}</span>?
                </p>
                <p className="text-xs text-muted-foreground">
                  {isMainAgent ? t('agentDetail.resetDetails') : t('agentDetail.deleteDetails')}
                </p>
              </div>
              <div className="flex items-center gap-3 justify-end">
                <button
                  onClick={() => setShowDeleteConfirm(false)}
                  className="px-4 py-2 text-sm font-medium text-muted-foreground hover:text-foreground bg-muted hover:bg-muted border border-border rounded-lg transition-all"
                >
                  {t('common.cancel')}
                </button>
                <button
                  onClick={handleDeleteAgent}
                  disabled={deleting}
                  className="px-4 py-2 text-sm font-bold text-white bg-red-500 hover:bg-red-600 disabled:opacity-50 rounded-lg transition-all flex items-center gap-2"
                >
                  {deleting ? (
                    <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <Trash2 className="w-3.5 h-3.5" />
                  )}
                  {isMainAgent ? t('agentDetail.resetAgent') : t('agentDetail.deleteAgent')}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
