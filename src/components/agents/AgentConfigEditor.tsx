import * as React from 'react';
import { Sparkles, Brain, FileText, Sliders, Loader2, Check } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '../ui/dialog';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '../ui/tabs';
import { Button } from '../ui/button';
import { Skeleton } from '../ui/skeleton';
import { useTranslation } from '../../i18n';
import { useDashboardStore } from '../../store/dashboard-store';
import { PersonaTab } from './PersonaTab';
import { MemoryTab } from './MemoryTab';
import { KnowledgeTab } from './KnowledgeTab';
import { SettingsTab } from './SettingsTab';
import type { AgentSummary, AgentConfiguration, KnowledgeFile } from '../../types/openclaw';

interface AgentConfigEditorProps {
  agent: AgentSummary | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function AgentConfigEditor({ agent, open, onOpenChange }: AgentConfigEditorProps) {
  const { t } = useTranslation();
  const {
    selectedAgentConfig,
    configLoading,
    configSaving,
    loadAgentConfig,
    saveAgentConfig,
    clearAgentConfig,
    uploadKnowledgeFile,
    deleteKnowledgeFile,
    updateKnowledgeFile,
  } = useDashboardStore();

  const [localConfig, setLocalConfig] = React.useState<AgentConfiguration | null>(null);
  const [hasChanges, setHasChanges] = React.useState(false);
  const [activeTab, setActiveTab] = React.useState('persona');
  const [saveSuccess, setSaveSuccess] = React.useState(false);

  // Load config when opening
  React.useEffect(() => {
    if (open && agent) {
      loadAgentConfig(agent.id);
    }
  }, [open, agent, loadAgentConfig]);

  // Sync local state with store
  React.useEffect(() => {
    if (selectedAgentConfig) {
      setLocalConfig(selectedAgentConfig);
      setHasChanges(false);
    }
  }, [selectedAgentConfig]);

  // Cleanup on close
  React.useEffect(() => {
    if (!open) {
      clearAgentConfig();
      setLocalConfig(null);
      setHasChanges(false);
      setActiveTab('persona');
      setSaveSuccess(false);
    }
  }, [open, clearAgentConfig]);

  const handleSave = async () => {
    if (!agent || !localConfig) return;

    const success = await saveAgentConfig(agent.id, {
      systemPrompt: localConfig.systemPrompt,
      contextMemory: localConfig.contextMemory,
      settings: localConfig.settings,
    });

    if (success) {
      setSaveSuccess(true);
      setHasChanges(false);
      setTimeout(() => setSaveSuccess(false), 2000);
    }
  };

  const updateLocalConfig = (updates: Partial<AgentConfiguration>) => {
    if (!localConfig) return;
    setLocalConfig({ ...localConfig, ...updates });
    setHasChanges(true);
  };

  const handleKnowledgeAdd = async (file: Omit<KnowledgeFile, 'id' | 'createdAt'>) => {
    if (!agent) return null;
    return uploadKnowledgeFile(agent.id, file);
  };

  const handleKnowledgeUpdate = async (fileId: string, updates: Partial<KnowledgeFile>) => {
    if (!agent) return false;
    return updateKnowledgeFile(agent.id, fileId, updates);
  };

  const handleKnowledgeDelete = async (fileId: string) => {
    if (!agent) return false;
    return deleteKnowledgeFile(agent.id, fileId);
  };

  if (!agent) return null;

  const displayName = agent.identity?.name || agent.name || agent.id;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center text-white font-bold">
              {agent.identity?.emoji || displayName.charAt(0).toUpperCase()}
            </div>
            <div>
              <span>{t('agents.config.title')}: {displayName}</span>
              <p className="text-sm font-normal text-zinc-400 mt-0.5">{agent.id}</p>
            </div>
          </DialogTitle>
        </DialogHeader>

        {configLoading ? (
          <div className="flex-1 p-6 space-y-4">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-[200px] w-full" />
            <Skeleton className="h-20 w-full" />
          </div>
        ) : localConfig ? (
          <div className="flex-1 overflow-hidden flex flex-col">
            <Tabs value={activeTab} onValueChange={setActiveTab} className="flex-1 flex flex-col">
              <TabsList className="mx-6 mt-2 mb-4">
                <TabsTrigger value="persona" className="gap-2">
                  <Sparkles className="w-4 h-4" />
                  {t('agents.config.persona')}
                </TabsTrigger>
                <TabsTrigger value="memory" className="gap-2">
                  <Brain className="w-4 h-4" />
                  {t('agents.config.memory')}
                </TabsTrigger>
                <TabsTrigger value="knowledge" className="gap-2">
                  <FileText className="w-4 h-4" />
                  {t('agents.config.knowledge')}
                </TabsTrigger>
                <TabsTrigger value="settings" className="gap-2">
                  <Sliders className="w-4 h-4" />
                  {t('agents.config.settings')}
                </TabsTrigger>
              </TabsList>

              <div className="flex-1 overflow-y-auto px-6">
                <TabsContent value="persona" className="mt-0">
                  <PersonaTab
                    value={localConfig.systemPrompt}
                    onChange={(value) => updateLocalConfig({ systemPrompt: value })}
                  />
                </TabsContent>

                <TabsContent value="memory" className="mt-0">
                  <MemoryTab
                    agentId={agent.id}
                    value={localConfig.contextMemory}
                    onChange={(value) => updateLocalConfig({ contextMemory: value })}
                    lastUpdated={localConfig.updatedAt}
                  />
                </TabsContent>

                <TabsContent value="knowledge" className="mt-0">
                  <KnowledgeTab
                    files={localConfig.knowledgeFiles}
                    onAdd={handleKnowledgeAdd}
                    onUpdate={handleKnowledgeUpdate}
                    onDelete={handleKnowledgeDelete}
                  />
                </TabsContent>

                <TabsContent value="settings" className="mt-0">
                  <SettingsTab
                    settings={localConfig.settings}
                    onChange={(settings) => updateLocalConfig({ settings })}
                  />
                </TabsContent>
              </div>
            </Tabs>
          </div>
        ) : (
          <div className="flex-1 flex items-center justify-center text-zinc-500">
            Failed to load configuration
          </div>
        )}

        <DialogFooter className="border-t border-zinc-800 pt-4 px-6">
          <div className="flex items-center justify-between w-full">
            <div className="text-sm text-zinc-500">
              {hasChanges && !saveSuccess && (
                <span className="text-amber-400">Unsaved changes</span>
              )}
              {saveSuccess && (
                <span className="text-green-400 flex items-center gap-1">
                  <Check className="w-4 h-4" />
                  {t('agents.config.saved')}
                </span>
              )}
            </div>
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                {t('common.cancel')}
              </Button>
              <Button
                onClick={handleSave}
                disabled={!hasChanges || configSaving}
                className="bg-indigo-600 hover:bg-indigo-700 min-w-[120px]"
              >
                {configSaving ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    {t('agents.config.saving')}
                  </>
                ) : (
                  t('agents.config.saveChanges')
                )}
              </Button>
            </div>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
